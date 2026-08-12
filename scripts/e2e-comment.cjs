//
// Read a workspace and its coverage-artifact URL out of the e2e bot's PR
// comment.
//
// Split out of .github/workflows/publish-coverage-upstream.yaml for the same
// reason upstream-paths.cjs was split out of remap-coverage.cjs: logic embedded
// in a workflow can only be exercised by running the workflow, and this is
// logic that fails quietly. A comment shape that drifts, or a pattern that
// matches one character too loosely, does not crash — it publishes the wrong
// run's coverage, or silently publishes nothing.
//
// Depends only on node builtins, and never writes to the console: callers
// decide how to report a refusal.
//
// See scripts/tests/test_e2e_comment.py.

// The account Prow posts e2e results as. Pinning the author is what makes the
// body trustworthy enough to parse a URL out of — any account able to comment
// on a PR could otherwise aim a publish at a listing of their choosing. The
// check itself belongs to the caller, which has the comment metadata; the name
// lives here so there is one definition of it.
const E2E_BOT_LOGIN = "rhdh-test-bot";

// "### ✅ Passed E2E Tests - `<workspace>`", and it must be the comment's FIRST
// line. Failed runs say "Failed" and are left out, which is the only thing
// keeping a red run from publishing: a failed run still produces coverage
// JSONs, and they measure the tests that died rather than the plugin.
//
// Anchored rather than searched because the header and the link below are
// matched independently. Unanchored, a body whose first section is a FAILED run
// and which quotes a passing header further down took the workspace from the
// quoted section and the URL from the failed run — publishing a red run's
// artifacts under another workspace's name, with every guard here reporting
// success.
const HEADER = /^[^\n]*Passed E2E Tests\s*-\s*`([^`]+)`/;

// Any result header, passing or failing. More than one means the comment
// carries more than one run, and this parser has no way to tell which link
// belongs to which — so it refuses instead of pairing them by position. One
// comment per result is the shape the bot posts today; this is what notices if
// that ever changes.
const ANY_HEADER = /(?:Passed|Failed) E2E Tests\s*-\s*`/g;

// The host is spelled out in full and the URL is anchored inside the markdown
// link's parentheses. An unanchored `[a-z0-9.-]+` after `gcsweb-ci.apps.` would
// also match an attacker-controlled domain, and a URL sitting in prose is not
// the artifact link.
const BUILD_LOG =
  /\(https:\/\/gcsweb-ci\.apps\.ci\.l2s4\.p1\.openshiftapps\.com\/gcs\/[^)\s]+\/build-log\.txt\)/;

// The workspace name is interpolated into a filesystem path and passed as a
// script argument downstream, so it is constrained here rather than trusted
// from the comment body.
//
// This is the STRICTEST of the shapes that used to exist for one rule, not the
// most convenient. Consolidating on the loosest would have widened what the
// callers accept, which is the wrong direction for the only guard standing
// between a comment body and a path. upload-coverage-upstream.sh now enforces
// the same shape rather than a looser one, because it is a documented entry
// point in its own right. The longest real workspace name is 36 characters and
// none ends in a hyphen.
const WORKSPACE = /^[a-z0-9][a-z0-9-]{0,49}$/;

// A trailing hyphen passes the pattern above and is still not a name anything
// here should act on.
const isWorkspaceName = (name) => WORKSPACE.test(name) && !name.endsWith("-");

// More than one result header in one body. Asked in both directions — a comment
// that reports a pass and a comment that reports a failure — because pairing a
// header with a link from a different section is the failure the anchoring
// exists to prevent, and one copy of that rule is enough.
const carriesMoreThanOneResult = (body) => (body.match(ANY_HEADER) ?? []).length > 1;

// Returns `{ workspace, coverageUrl, reason }`. On success `reason` is null; on
// a refusal both other fields are null and `reason` says which, because they
// call for different actions:
//
//   not-a-pass    ordinary — the comment is a failure report or unrelated.
//   multi-section the comment carries more than one run's result, so the header
//                 and the link cannot be paired safely.
//   bad-workspace the bot named something that cannot be a directory.
//   no-build-log  the comment passed but carried no artifact link, which means
//                 the bot's format drifted and this parser needs updating.
//
// A fourth field, `rejected`, carries the name a `bad-workspace` refusal turned
// down, and is null otherwise. Kept separate from `workspace` on purpose: a
// caller may want it in a log so the refusal can be traced back to a comment,
// and must not be able to reach for it as though it had passed the guard.
function parsePassedE2eComment(body) {
  const miss = (reason, rejected = null) => ({
    workspace: null,
    coverageUrl: null,
    reason,
    rejected,
  });
  // Not merely defensive: `exec` COERCES its argument, so a non-string whose
  // string form happens to parse would otherwise be accepted as a comment.
  // `undefined` is refused either way — it stringifies to something that misses
  // the header — so that case proves nothing about this line.
  if (typeof body !== "string") return miss("not-a-pass");

  // Checked before anything is extracted: neither the header nor the link may
  // be trusted until the body is known to hold exactly one result.
  if (carriesMoreThanOneResult(body)) return miss("multi-section");

  const header = HEADER.exec(body);
  if (!header) return miss("not-a-pass");

  const workspace = header[1];
  if (!isWorkspaceName(workspace)) return miss("bad-workspace", workspace);

  const link = BUILD_LOG.exec(body);
  if (!link) return miss("no-build-log");

  // Strip the parens the pattern anchored on, then swap the log file for the
  // coverage listing that sits beside it in the same artifacts directory.
  const buildLog = link[0].slice(1, -1);
  return {
    workspace,
    coverageUrl: buildLog.replace(
      /build-log\.txt$/,
      "artifacts/e2e-test-results/coverage/",
    ),
    reason: null,
    rejected: null,
  };
}

// Same shape as HEADER, for the failing side. Anchored and charset-guarded for
// the same reasons; a name this rejects cannot retract anything, which is the
// safe direction.
const FAILED_HEADER = /^[^\n]*Failed E2E Tests\s*-\s*`([^`]+)`/;

// The workspace a FAILING comment reports on, or null.
//
// Needed because a passing comment is not evidence on its own — it is evidence
// only if nothing later contradicts it. e2e here is on-demand rather than
// per-push, so a PR can carry a green comment from an early commit and a red
// one from a re-run, and publishing the green one would put a failed run's
// predecessor on a shared upstream project as the plugin's record.
function failedWorkspaceOf(body) {
  if (typeof body !== "string") return null;
  if (carriesMoreThanOneResult(body)) return null;
  const header = FAILED_HEADER.exec(body);
  if (!header || !isWorkspaceName(header[1])) return null;
  return header[1];
}

// The coverage listing a publish may be pointed at. Derived URLs satisfy this
// by construction — it is the build-log link with its tail swapped — so its
// real job is the dispatch path, where an operator types the URL and nothing
// else would check the host.
const COVERAGE_LISTING =
  /^https:\/\/gcsweb-ci\.apps\.ci\.l2s4\.p1\.openshiftapps\.com\/gcs\/[^\s]+\/artifacts\/e2e-test-results\/coverage\/$/;

const isCoverageListingUrl = (url) =>
  typeof url === "string" && COVERAGE_LISTING.test(url);

module.exports = {
  E2E_BOT_LOGIN,
  isCoverageListingUrl,
  isWorkspaceName,
  parsePassedE2eComment,
  failedWorkspaceOf,
};
