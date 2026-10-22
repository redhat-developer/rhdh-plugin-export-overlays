//
// Decide which workspaces a run of publish-coverage-upstream.yaml should
// publish, and where each one's coverage artifacts live.
//
// Split out of that workflow for the reason its sibling e2e-comment.cjs was:
// logic living inside a `github-script` block can only be exercised by running
// the workflow. That is not a theoretical cost here — the first version of this
// step read the dispatch inputs with `core.getInput`, which returns the STEP's
// own inputs, so every manual publish ran with empty arguments. Nothing caught
// it but a human reading the diff.
//
// Takes the `github`, `context` and `core` that actions/github-script injects,
// so a test can hand it stubs. Everything else it needs comes from
// e2e-comment.cjs, which owns the comment's shape.
//
// See scripts/tests/test_resolve_publish_targets.py.

const {
  E2E_BOT_LOGIN,
  isCoverageListingUrl,
  isWorkspaceName,
  parsePassedE2eComment,
  failedWorkspaceOf,
} = require("./e2e-comment.cjs");

// Refusals worth telling someone about. `not-a-pass` is deliberately absent:
// most of the bot's comments on a PR are failures or reruns, so warning on
// those would bury the two that mean the comment's format has drifted.
const REPORTABLE = new Set(["bad-workspace", "no-build-log", "multi-section"]);

// A failure report that announces itself the way the bot does — on the comment's
// FIRST line — however malformed the rest of it is. Only used to tell "not an
// e2e result" from "an e2e result this cannot read", which is the difference
// between ignoring a comment and warning about one.
//
// Anchored for the same reason the passing header is, and the asymmetry was a
// real false negative: as a bare phrase it also matched a PASSING comment that
// merely mentioned a failed run in prose, which then refused to publish a run
// that had parsed perfectly one line above.
const FAILED_HEADLINE = /^[^\n]*Failed E2E Tests/;

// What one comment means, decided without side effects so the loop below reads
// as a list of outcomes rather than a nest of guards. Every kind here is a
// distinct thing that can happen to a run, and they are deliberately not
// collapsed: "the bot said nothing useful" and "the bot said this failed and I
// could not read which workspace" call for opposite responses.
//
//   not-bot             ignore it entirely; the author pin is the trust anchor.
//   retract             a failure for a workspace this PR reported passing.
//   unreadable-failure  a failure report that names nothing retractable.
//   refused             a passing comment the parser would not read.
//   stale               a pass that predates the commit being merged.
//   target              publishable.
function classifyComment(comment, headCommittedAt) {
  if (comment.user?.login !== E2E_BOT_LOGIN) return { kind: "not-bot" };

  const body = comment.body ?? "";
  const failed = failedWorkspaceOf(body);
  if (failed) return { kind: "retract", workspace: failed };
  // A refusal means the opposite thing on each side. On the passing side it
  // means "do not publish", which is safe. On the failing side it means "do not
  // retract" — so a failure report this cannot read leaves an earlier pass
  // standing and publishes a run that is known to be red.
  if (FAILED_HEADLINE.test(body)) return { kind: "unreadable-failure" };

  const { workspace, coverageUrl, reason, rejected } = parsePassedE2eComment(body);
  if (reason !== null) return { kind: "refused", reason, rejected };

  // A passing comment older than the merged commit reports a run against a tree
  // that is not the one being merged, and upload-coverage-upstream.sh reads
  // `repo-ref` from the MERGED tree — so publishing it would put per-line hit
  // counts on source lines that build never executed, on a flag whose
  // default-branch copy cannot be taken back.
  const ranAt = Date.parse(comment.created_at ?? "");
  if (headCommittedAt && ranAt && ranAt < headCommittedAt) {
    return { kind: "stale", workspace };
  }
  return { kind: "target", workspace, coverageUrl };
}

// Everything one merged PR contributes. Lifted out of resolvePublishTargets so
// neither function has to be read with two loops and six outcomes in the head
// at once; the orchestration up there is now "which PRs, then log what came
// back".
async function collectPullRequestTargets({ github, context, core, pr, targets }) {

    // When the merged code was last touched. A passing comment older than this
    // reports a run against a tree that is not the one being merged, and
    // upload-coverage-upstream.sh reads `repo-ref` from the MERGED tree — so
    // publishing it would put per-line hit counts on source lines that build
    // never executed, on a flag whose default-branch copy cannot be taken back.
    //
    // e2e here is on-demand rather than per-push, so this is an ordinary
    // sequence: green run, another commit, merge with no re-run.
    let headCommittedAt = null;
    try {
      const { data: head } = await github.rest.repos.getCommit({
        owner: context.repo.owner,
        repo: context.repo.repo,
        ref: pr.head.sha,
      });
      headCommittedAt = Date.parse(
        head.commit?.committer?.date ?? head.commit?.author?.date ?? "",
      );
    } catch {
      // Not fatal, and not silent: without the timestamp the staleness check
      // cannot run, and skipping every workspace would be a worse answer than
      // publishing with the check announced as unavailable.
      core.warning(
        `PR #${pr.number}: could not read its head commit, so a stale e2e run ` +
          "cannot be told from a current one for this PR.",
      );
    }

    const comments = await github.paginate(github.rest.issues.listComments, {
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: pr.number,
      per_page: 100,
    });

    // The drift alarm. If the bot's header wording ever changes, every comment
    // falls through as `not-a-pass`, no target resolves, and the run stays
    // green — this workflow would simply stop publishing and go on reporting
    // success forever. Counting what the bot said against what was understood
    // is what turns that into a signal.
    let fromBot = 0;
    // Split on purpose. Counting failures as "understood" made the alarm below
    // unable to see the drift it exists for: if the bot reworded only the
    // PASSING header, every failure comment still parsed, the count stayed
    // non-zero, and publishing would have stopped forever in silence.
    //
    // `unrecognised` is a comment that matched nothing at all — neither side.
    // `passingRecognised` covers every passing-side outcome, including the ones
    // that end in a refusal or a staleness skip, because those still prove the
    // parser can read the shape.
    let unrecognised = 0;
    let passingRecognised = 0;
    // Which workspaces THIS pr contributed, so a retraction cannot reach past
    // its own PR.
    const fromThisPr = new Set();

    for (const comment of comments) {
      const found = classifyComment(comment, headCommittedAt);
      if (found.kind === "not-bot") continue;
      fromBot += 1;
      if (found.kind === "refused" && !REPORTABLE.has(found.reason)) {
        unrecognised += 1;
      } else if (found.kind !== "retract" && found.kind !== "unreadable-failure") {
        passingRecognised += 1;
      }

      if (found.kind === "retract") {
        // Scoped to the PR that reported it. `targets` spans every merged PR
        // this commit is associated with, so deleting globally would let one
        // PR's red run retract a different PR's green one.
        if (fromThisPr.has(found.workspace) && targets.delete(found.workspace)) {
          fromThisPr.delete(found.workspace);
          core.warning(
            `PR #${pr.number}: ${found.workspace} passed earlier and failed later — ` +
              "not publishing the superseded run.",
          );
        }
      } else if (found.kind === "unreadable-failure") {
        core.warning(
          `PR #${pr.number}: a FAILING e2e comment could not be read, so it ` +
            "cannot retract anything — check whether a red run is about to be " +
            "published as green.",
        );
      } else if (found.kind === "refused") {
        if (REPORTABLE.has(found.reason)) {
          const named = found.rejected ? ` naming '${found.rejected}'` : "";
          core.warning(
            `PR #${pr.number}: a passing e2e comment${named} could not be read ` +
              `(${found.reason}) — skipping (the bot's comment format may have drifted).`,
          );
        }
      } else if (found.kind === "stale") {
        core.warning(
          `PR #${pr.number}: the passing ${found.workspace} run predates the ` +
            "commit that merged, so it measured a different tree — not " +
            "publishing it. Re-run e2e on the final commit to publish this workspace.",
        );
      } else {
        targets.set(found.workspace, {
          workspace: found.workspace,
          coverageUrl: found.coverageUrl,
        });
        fromThisPr.add(found.workspace);
      }
    }

    // A PR whose e2e simply failed is not drift: its comments parse, they just
    // report red. Drift is a comment that matches NOTHING while no passing
    // result was recognised either.
    if (unrecognised > 0 && passingRecognised === 0) {
      core.warning(
        `PR #${pr.number}: ${unrecognised} of ${fromBot} comment(s) from ` +
          `${E2E_BOT_LOGIN} matched no e2e result and no passing run was read — ` +
          "the comment format has probably changed, and until " +
          "scripts/e2e-comment.cjs is updated nothing will publish.",
      );
    }
}

// Returns an array of `{ workspace, coverageUrl }`, possibly empty. Empty is an
// ordinary outcome — a merge whose PR never ran e2e, or ran it and failed — so
// the caller reports it rather than failing.
async function resolvePublishTargets({ github, context, core }) {
  if (context.eventName === "workflow_dispatch") {
    // From the event payload, NOT core.getInput: that reads this STEP's inputs,
    // and github-script declares only `script` and its own options.
    const inputs = context.payload.inputs ?? {};
    const workspace = inputs.workspace ?? "";
    // Held to the same shape a comment-derived name is. Dispatching needs write
    // access, so this is not the main defence — but the name reaches a
    // `::group::` line before the script that validates it ever runs, and a
    // guard that applies to one caller and not the other is not a guard.
    if (!isWorkspaceName(workspace)) {
      throw new Error(`'${workspace}' is not a usable workspace name.`);
    }
    // Held to the host the push path pins by construction. A dispatcher needs
    // write access, so this is not the main defence — but the two paths feeding
    // one uploader should not disagree about what a coverage URL is, and the
    // typed-in one is the only one nothing else checks.
    const coverageUrl = inputs["coverage-url"] ?? "";
    if (!isCoverageListingUrl(coverageUrl)) {
      throw new Error(
        `'${coverageUrl}' is not a gcsweb e2e coverage listing URL.`,
      );
    }
    return [{ workspace, coverageUrl }];
  }

  const { data: prs } =
    await github.rest.repos.listPullRequestsAssociatedWithCommit({
      owner: context.repo.owner,
      repo: context.repo.repo,
      commit_sha: context.sha,
    });

  // Only merged: a PR that merely contains this commit has not had its coverage
  // accepted into main, and an open PR's numbers describe code that may never
  // land.
  const merged = prs.filter((pr) => pr.merged_at);
  if (merged.length === 0) {
    core.info("No merged PR is associated with this commit — nothing to publish.");
    return [];
  }

  // Keyed by workspace so the LAST passing comment wins. One e2e invocation
  // posts one comment per RHDH version in the matrix, and they measure the same
  // PR-built image, so any of them carries the same coverage; taking the last
  // is a deterministic choice rather than a meaningful one.
  const targets = new Map();
  for (const pr of merged) {
    await collectPullRequestTargets({ github, context, core, pr, targets });
  }

  const resolved = [...targets.values()];
  core.info(
    resolved.length
      ? `Publishing: ${resolved.map((t) => t.workspace).join(", ")}`
      : "No passing e2e run found on the merged PR(s) — nothing to publish.",
  );
  return resolved;
}

module.exports = { resolvePublishTargets };
