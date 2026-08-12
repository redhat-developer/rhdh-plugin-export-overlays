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

// "### ✅ Passed E2E Tests - `<workspace>`". Failed runs say "Failed" and are
// left out by this pattern, which is the only thing keeping a red run from
// publishing: a failed run still produces coverage JSONs, and they measure the
// tests that died rather than the plugin.
const HEADER = /Passed E2E Tests\s*-\s*`([^`]+)`/;

// The host is spelled out in full and the URL is anchored inside the markdown
// link's parentheses. An unanchored `[a-z0-9.-]+` after `gcsweb-ci.apps.` would
// also match an attacker-controlled domain, and a URL sitting in prose is not
// the artifact link.
const BUILD_LOG =
  /\(https:\/\/gcsweb-ci\.apps\.ci\.l2s4\.p1\.openshiftapps\.com\/gcs\/[^)\s]+\/build-log\.txt\)/;

// The workspace name is interpolated into a filesystem path downstream, so it
// is constrained here rather than trusted from the comment body.
const WORKSPACE = /^[a-z0-9][a-z0-9._-]*$/;

// Returns `{ workspace, coverageUrl, reason }`. On success `reason` is null; on
// a refusal both other fields are null and `reason` says which, because the
// three call for different actions:
//
//   not-a-pass    ordinary — the comment is a failure report or unrelated.
//   bad-workspace the bot named something that cannot be a directory.
//   no-build-log  the comment passed but carried no artifact link, which means
//                 the bot's format drifted and this parser needs updating.
function parsePassedE2eComment(body) {
  const miss = (reason) => ({ workspace: null, coverageUrl: null, reason });
  if (typeof body !== "string") return miss("not-a-pass");

  const header = HEADER.exec(body);
  if (!header) return miss("not-a-pass");

  const workspace = header[1];
  if (!WORKSPACE.test(workspace)) return miss("bad-workspace");

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
  };
}

module.exports = { E2E_BOT_LOGIN, parsePassedE2eComment };
