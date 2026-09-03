# Shared curated-check filter for ci-diagnose.
#
# Selects the entries from a PR's `statusCheckRollup` (as returned by
# `gh pr view --json statusCheckRollup`) that belong to the curated,
# diagnosable check set — everything else (SonarCloud, fullsend dispatch/*,
# etc.) is ignored.
#
# This file is the SINGLE SOURCE OF TRUTH for that membership test. It is
# loaded with `jq -f` by both:
#   - .fullsend/rhdh/agents/ci-diagnose.md (Phase 1)
#   - .github/workflows/ci-diagnose-agent.yaml (red-set / dedup computation)
#
# Both consumers must derive the same sorted set of red check names from the
# same rollup, or the bootstrap workflow and the agent's state marker will
# disagree about when to (re-)fire (see the dedup contract in both files).
# Edit the check names/types here ONLY — do not fork this predicate.
def is_curated_red:
  ((.__typename == "StatusContext") and (.context | startswith("ci/prow/")) and (.state | IN("FAILURE", "ERROR")))
  or ((.__typename == "StatusContext") and (.context | IN("publish", "smoketest")) and (.state | IN("FAILURE", "ERROR")))
  or ((.__typename == "CheckRun") and (.name | IN("E2E Code Quality", "appConfigExamples coverage", "Python unit tests", "smoke")) and (.conclusion | IN("FAILURE", "TIMED_OUT", "ACTION_REQUIRED")));

.statusCheckRollup | map(select(is_curated_red))
