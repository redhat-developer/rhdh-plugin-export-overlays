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
  isWorkspaceName,
  parsePassedE2eComment,
  failedWorkspaceOf,
} = require("./e2e-comment.cjs");

// Refusals worth telling someone about. `not-a-pass` is deliberately absent:
// most of the bot's comments on a PR are failures or reruns, so warning on
// those would bury the two that mean the comment's format has drifted.
const REPORTABLE = new Set(["bad-workspace", "no-build-log", "multi-section"]);

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
    return [{ workspace, coverageUrl: inputs["coverage-url"] ?? "" }];
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
    let understood = 0;
    // Which workspaces THIS pr contributed, so a retraction cannot reach past
    // its own PR.
    const fromThisPr = new Set();

    for (const comment of comments) {
      // The author pin is what makes the body trustworthy enough to parse a URL
      // out of; without it any account able to comment could choose which
      // artifacts get published under a Red Hat flag.
      if (comment.user?.login !== E2E_BOT_LOGIN) continue;
      fromBot += 1;

      // Comments arrive oldest-first, so a failure retracts any pass this
      // workspace had earlier on the same PR. Without this an on-demand re-run
      // going red would still publish the previous green run's numbers, which
      // is a wrong report rather than a missing one — and it lands on a project
      // upload-coverage-upstream.sh's own header calls a one-way door.
      // A refusal means something different on each side. On the passing side
      // it means "do not publish", which is safe. On the failing side it means
      // "do not retract" — so a failure report this cannot read leaves an
      // earlier pass standing and publishes a run that is known to be red.
      // Nothing can be retracted without knowing which workspace, so the only
      // honest response is to say so.
      const body = comment.body ?? "";
      const failed = failedWorkspaceOf(body);
      if (!failed && /Failed E2E Tests/.test(body)) {
        understood += 1;
        core.warning(
          `PR #${pr.number}: a FAILING e2e comment could not be read, so it ` +
            "cannot retract anything — check whether a red run is about to be " +
            "published as green.",
        );
        continue;
      }
      if (failed) {
        understood += 1;
        // Scoped to the PR that reported it. `targets` spans every merged PR
        // this commit is associated with, so deleting globally would let one
        // PR's red run retract a different PR's green one — a workspace that
        // passed on its own PR silently not publishing because an unrelated
        // one failed.
        if (fromThisPr.has(failed) && targets.delete(failed)) {
          fromThisPr.delete(failed);
          core.warning(
            `PR #${pr.number}: ${failed} passed earlier and failed later — ` +
              "not publishing the superseded run.",
          );
        }
        continue;
      }

      const { workspace, coverageUrl, reason, rejected } =
        parsePassedE2eComment(body);
      if (reason !== null) {
        if (REPORTABLE.has(reason)) {
          understood += 1;
          // The offending name is included, as refresh-coverage-snapshot.yaml
          // does: "a comment was rejected" without saying which sends whoever
          // reads it back to the PR to guess.
          const named = rejected ? ` naming '${rejected}'` : "";
          core.warning(
            `PR #${pr.number}: a passing e2e comment${named} could not be read (${reason}) — ` +
              "skipping (the bot's comment format may have drifted).",
          );
        }
        continue;
      }
      understood += 1;

      const ranAt = Date.parse(comment.created_at ?? "");
      if (headCommittedAt && ranAt && ranAt < headCommittedAt) {
        core.warning(
          `PR #${pr.number}: the passing ${workspace} run predates the commit ` +
            "that merged, so it measured a different tree — not publishing it. " +
            "Re-run e2e on the final commit to publish this workspace.",
        );
        continue;
      }

      targets.set(workspace, { workspace, coverageUrl });
      fromThisPr.add(workspace);
    }

    if (fromBot > 0 && understood === 0) {
      core.warning(
        `PR #${pr.number}: ${fromBot} comment(s) from ${E2E_BOT_LOGIN}, none of them ` +
          "recognisable as an e2e result — the comment format has probably changed, " +
          "and until scripts/e2e-comment.cjs is updated nothing will publish.",
      );
    }
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
