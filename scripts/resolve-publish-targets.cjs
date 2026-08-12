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
    return [
      {
        workspace: inputs.workspace ?? "",
        coverageUrl: inputs["coverage-url"] ?? "",
      },
    ];
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
    const comments = await github.paginate(github.rest.issues.listComments, {
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: pr.number,
      per_page: 100,
    });

    for (const comment of comments) {
      // The author pin is what makes the body trustworthy enough to parse a URL
      // out of; without it any account able to comment could choose which
      // artifacts get published under a Red Hat flag.
      if (comment.user?.login !== E2E_BOT_LOGIN) continue;

      // Comments arrive oldest-first, so a failure retracts any pass this
      // workspace had earlier on the same PR. Without this an on-demand re-run
      // going red would still publish the previous green run's numbers, which
      // is a wrong report rather than a missing one — and it lands on a project
      // upload-coverage-upstream.sh's own header calls a one-way door.
      const failed = failedWorkspaceOf(comment.body ?? "");
      if (failed) {
        if (targets.delete(failed)) {
          core.warning(
            `PR #${pr.number}: ${failed} passed earlier and failed later — ` +
              "not publishing the superseded run.",
          );
        }
        continue;
      }

      const { workspace, coverageUrl, reason } = parsePassedE2eComment(
        comment.body ?? "",
      );
      if (reason !== null) {
        if (REPORTABLE.has(reason)) {
          core.warning(
            `PR #${pr.number}: a passing e2e comment could not be read (${reason}) — ` +
              "skipping (the bot's comment format may have drifted).",
          );
        }
        continue;
      }
      targets.set(workspace, { workspace, coverageUrl });
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
