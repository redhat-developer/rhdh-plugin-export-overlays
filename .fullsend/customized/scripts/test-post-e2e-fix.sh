#!/usr/bin/env bash
# Dry test suite for post-e2e-fix.sh (multi-workspace version).
#
# Tests the post-script logic without making real API calls by mocking
# gh, curl, and git operations where needed.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_UNDER_TEST="${SCRIPT_DIR}/post-e2e-fix.sh"

PASS=0
FAIL=0
ERRORS=""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

run_test() {
  local name="$1"
  local expect_rc="${2:-0}"
  local expect_pattern="${3:-}"
  local expect_absent="${4:-}"

  local rc=0
  local output
  output="$(bash "${SCRIPT_UNDER_TEST}" 2>&1)" || rc=$?

  local pass=true

  if [[ "${rc}" -ne "${expect_rc}" ]]; then
    pass=false
    ERRORS+="  ${name}: expected rc=${expect_rc}, got rc=${rc}\n"
  fi

  if [[ -n "${expect_pattern}" ]] && ! echo "${output}" | grep -qiE "${expect_pattern}"; then
    pass=false
    ERRORS+="  ${name}: expected pattern '${expect_pattern}' not found\n"
    ERRORS+="    output: $(echo "${output}" | tail -3)\n"
  fi

  if [[ -n "${expect_absent}" ]] && echo "${output}" | grep -qiE "${expect_absent}"; then
    pass=false
    ERRORS+="  ${name}: unexpected pattern '${expect_absent}' found\n"
  fi

  if $pass; then
    echo -e "  ${GREEN}✓${NC} ${name}"
    ((PASS++))
  else
    echo -e "  ${RED}✗${NC} ${name}"
    ((FAIL++))
  fi
}

# Run test with custom env overrides (takes env assignments before other args)
run_test_custom() {
  local name="$1"
  local env_overrides="$2"
  local expect_rc="${3:-0}"
  local expect_pattern="${4:-}"
  local expect_absent="${5:-}"

  local rc=0
  local output
  output="$(eval "${env_overrides} bash '${SCRIPT_UNDER_TEST}' 2>&1")" || rc=$?

  local pass=true

  if [[ "${rc}" -ne "${expect_rc}" ]]; then
    pass=false
    ERRORS+="  ${name}: expected rc=${expect_rc}, got rc=${rc}\n"
  fi

  if [[ -n "${expect_pattern}" ]] && ! echo "${output}" | grep -qiE "${expect_pattern}"; then
    pass=false
    ERRORS+="  ${name}: expected pattern '${expect_pattern}' not found\n"
    ERRORS+="    output: $(echo "${output}" | tail -3)\n"
  fi

  if [[ -n "${expect_absent}" ]] && echo "${output}" | grep -qiE "${expect_absent}"; then
    pass=false
    ERRORS+="  ${name}: unexpected pattern '${expect_absent}' found\n"
  fi

  if $pass; then
    echo -e "  ${GREEN}✓${NC} ${name}"
    ((PASS++))
  else
    echo -e "  ${RED}✗${NC} ${name}"
    ((FAIL++))
  fi
}

setup_workdir() {
  WORKDIR="$(mktemp -d)"
  cd "${WORKDIR}"
  export GH_TOKEN="test-token-12345"
  export REPO_FULL_NAME="redhat-developer/rhdh-plugin-export-overlays"
  export TARGET_BRANCH="main"
  export JIRA_URL="https://issues.redhat.com"
}

write_result() {
  local json="$1"
  local iteration="${2:-1}"
  mkdir -p "iteration-${iteration}/output"
  echo "${json}" > "iteration-${iteration}/output/agent-result.json"
}

# Create a git repo with branches for push/PR tests
setup_repo() {
  git init -q .
  git checkout -b main
  echo "initial" > README.md
  git add README.md
  git commit -q -m "initial"
  git remote add origin "https://github.com/test/repo.git"
}

# Create a fix branch with a commit
create_fix_branch() {
  local branch="$1"
  local file="${2:-testfile.ts}"
  local content="${3:-fix content}"

  git checkout -q main
  git checkout -q -b "${branch}"
  mkdir -p "$(dirname "${file}")"
  echo "${content}" > "${file}"
  git add "${file}"
  git commit -q -m "fix(e2e): test fix

Root cause: test
Fixes: #ISSUE_PLACEHOLDER"
}

# Mock gh to avoid real API calls
mock_gh() {
  local behavior="${1:-success}"
  mkdir -p "${PWD}/mock-bin"

  case "${behavior}" in
    success)
      cat > "${PWD}/mock-bin/gh" << 'MOCKEOF'
#!/usr/bin/env bash
case "$1" in
  issue)
    case "$2" in
      create)
        echo "https://github.com/test/repo/issues/42"
        ;;
      comment|edit)
        echo "comment added"
        ;;
    esac
    ;;
  pr)
    case "$2" in
      list)
        echo ""  # no existing PR
        ;;
      create)
        echo "https://github.com/test/repo/pull/99"
        ;;
    esac
    ;;
esac
MOCKEOF
      ;;
    pr_exists)
      cat > "${PWD}/mock-bin/gh" << 'MOCKEOF'
#!/usr/bin/env bash
case "$1" in
  issue)
    case "$2" in
      create) echo "https://github.com/test/repo/issues/42" ;;
      comment|edit) echo "ok" ;;
    esac
    ;;
  pr)
    case "$2" in
      list) echo '{"number":55,"url":"https://github.com/test/repo/pull/55"}' ;;
      create) echo "https://github.com/test/repo/pull/99" ;;
    esac
    ;;
esac
MOCKEOF
      ;;
    issue_403)
      cat > "${PWD}/mock-bin/gh" << 'MOCKEOF'
#!/usr/bin/env bash
case "$1" in
  issue)
    echo "HTTP 403" >&2
    exit 1
    ;;
  pr)
    case "$2" in
      list) echo "" ;;
      create) echo "https://github.com/test/repo/pull/99" ;;
    esac
    ;;
esac
MOCKEOF
      ;;
  esac

  chmod +x "${PWD}/mock-bin/gh"
  export PATH="${PWD}/mock-bin:${PATH}"
}

# Mock git push to avoid real pushes
mock_git_push() {
  REAL_GIT="$(command -v git)"
  mkdir -p "${PWD}/mock-bin"
  cat > "${PWD}/mock-bin/git" << MOCKEOF
#!/usr/bin/env bash
case "\$1" in
  push)
    echo "mock: pushed \${*}"
    exit 0
    ;;
  remote)
    if [[ "\${2:-}" == "set-url" ]]; then
      exit 0
    fi
    "${REAL_GIT}" "\$@"
    ;;
  *)
    "${REAL_GIT}" "\$@"
    ;;
esac
MOCKEOF
  chmod +x "${PWD}/mock-bin/git"
  export PATH="${PWD}/mock-bin:${PATH}"
}

ORIG_PATH="${PATH}"

cleanup() {
  cd /tmp
  export PATH="${ORIG_PATH}"
  unset JIRA_TOKEN 2>/dev/null || true
}

# ===========================================================================
# A. Validation Tests
# ===========================================================================
echo -e "\n${YELLOW}A. Validation${NC}"

# A1: No result file
setup_workdir
run_test "A1: No agent-result.json → warning + exit 0" 0 "No agent-result.json"
cleanup; rm -rf "${WORKDIR}"

# A2: Invalid JSON
setup_workdir
write_result "not json at all"
run_test "A2: Invalid JSON → error + exit 1" 1 "not valid JSON"
cleanup; rm -rf "${WORKDIR}"

# A3: Empty workspaces array
setup_workdir
write_result '{"workspaces": []}'
run_test "A3: Empty workspaces array → error" 1 "no workspaces"
cleanup; rm -rf "${WORKDIR}"

# A4: Missing required field (workspace name)
setup_workdir
write_result '{
  "workspaces": [{
    "tests": [{"name": "t", "error": "e"}],
    "root_cause": "x",
    "fix_category": "infra_flake",
    "action_taken": "logged",
    "attempt": 1,
    "next_step": "wait",
    "branch": null
  }]
}'
run_test "A4: Missing workspace name → error" 1 "missing workspace name"
cleanup; rm -rf "${WORKDIR}"

# A5: Missing required field (root_cause)
setup_workdir
write_result '{
  "workspaces": [{
    "workspace": "argocd",
    "tests": [{"name": "t", "error": "e"}],
    "fix_category": "infra_flake",
    "action_taken": "logged",
    "attempt": 1,
    "next_step": "wait",
    "branch": null
  }]
}'
run_test "A5: Missing root_cause → error" 1 "missing required field: root_cause"
cleanup; rm -rf "${WORKDIR}"

# A6: Invalid fix_category
setup_workdir
write_result '{
  "workspaces": [{
    "workspace": "argocd",
    "tests": [{"name": "t", "error": "e"}],
    "root_cause": "x",
    "fix_category": "invalid_category",
    "action_taken": "logged",
    "attempt": 1,
    "next_step": "wait",
    "branch": null
  }]
}'
run_test "A6: Invalid fix_category → error" 1 "invalid fix_category"
cleanup; rm -rf "${WORKDIR}"

# A7: Invalid action_taken
setup_workdir
write_result '{
  "workspaces": [{
    "workspace": "argocd",
    "tests": [{"name": "t", "error": "e"}],
    "root_cause": "x",
    "fix_category": "infra_flake",
    "action_taken": "invalid_action",
    "attempt": 1,
    "next_step": "wait",
    "branch": null
  }]
}'
run_test "A7: Invalid action_taken → error" 1 "invalid action_taken"
cleanup; rm -rf "${WORKDIR}"

# A8: Invalid issue.action
setup_workdir
write_result '{
  "workspaces": [{
    "workspace": "argocd",
    "tests": [{"name": "t", "error": "e"}],
    "root_cause": "x",
    "fix_category": "test_fix",
    "action_taken": "fix_implemented",
    "attempt": 1,
    "next_step": "merge",
    "branch": null,
    "issue": {"action": "bad_action"}
  }]
}'
run_test "A8: Invalid issue.action → error" 1 "invalid issue.action"
cleanup; rm -rf "${WORKDIR}"

# A9: issue.action=create missing title
setup_workdir
write_result '{
  "workspaces": [{
    "workspace": "argocd",
    "tests": [{"name": "t", "error": "e"}],
    "root_cause": "x",
    "fix_category": "test_fix",
    "action_taken": "fix_implemented",
    "attempt": 1,
    "next_step": "merge",
    "branch": null,
    "issue": {"action": "create", "body": "body but no title"}
  }]
}'
run_test "A9: issue create missing title → error" 1 "missing issue.title"
cleanup; rm -rf "${WORKDIR}"

# A10: issue.action=comment missing number
setup_workdir
write_result '{
  "workspaces": [{
    "workspace": "argocd",
    "tests": [{"name": "t", "error": "e"}],
    "root_cause": "x",
    "fix_category": "test_fix",
    "action_taken": "commented_on_existing",
    "attempt": 2,
    "next_step": "merge",
    "branch": null,
    "issue": {"action": "comment", "body": "still failing"}
  }]
}'
run_test "A10: issue comment missing number → error" 1 "missing issue.number"
cleanup; rm -rf "${WORKDIR}"

# A11: JIRA directive missing required field
setup_workdir
write_result '{
  "workspaces": [{
    "workspace": "argocd",
    "tests": [{"name": "t", "error": "e"}],
    "root_cause": "x",
    "fix_category": "product_bug",
    "action_taken": "test_skipped",
    "attempt": 1,
    "next_step": "track",
    "branch": "fix/e2e-argocd-skip",
    "jira": {"project": "RHDHBUGS", "type": "Bug", "summary": "test"}
  }]
}'
run_test "A11: JIRA missing description → error" 1 "missing jira.description"
cleanup; rm -rf "${WORKDIR}"

# A12: Valid multi-workspace passes validation
setup_workdir
setup_repo
mock_gh success
mock_git_push
write_result '{
  "workspaces": [
    {
      "workspace": "argocd",
      "tests": [{"name": "Test 1", "error": "Error 1"}],
      "root_cause": "Route timeout",
      "fix_category": "infra_flake",
      "action_taken": "logged",
      "attempt": 1,
      "next_step": "Monitor",
      "branch": null,
      "issue": {"action": "skip"}
    },
    {
      "workspace": "orchestrator",
      "tests": [{"name": "Test 2", "error": "Error 2"}],
      "root_cause": "Login broken",
      "fix_category": "test_fix",
      "action_taken": "fix_implemented",
      "attempt": 1,
      "next_step": "Merge",
      "branch": null,
      "issue": {"action": "skip"}
    }
  ]
}'
run_test "A12: Valid multi-workspace → passes validation" 0 "Validation passed for all 2"
cleanup; rm -rf "${WORKDIR}"

# ===========================================================================
# B. Issue Directive Tests
# ===========================================================================
echo -e "\n${YELLOW}B. Issue Directives${NC}"

# B1: Issue create
setup_workdir
setup_repo
mock_gh success
mock_git_push
write_result '{
  "workspaces": [{
    "workspace": "argocd",
    "tests": [{"name": "Test 1", "error": "Error 1"}],
    "root_cause": "Route timeout",
    "fix_category": "test_fix",
    "action_taken": "fix_implemented",
    "attempt": 1,
    "next_step": "Merge PR",
    "branch": null,
    "issue": {
      "action": "create",
      "title": "[fullsend] E2E: argocd",
      "labels": ["e2e-failure"],
      "body": "Test body"
    }
  }]
}'
run_test "B1: Issue create → creates issue #42" 0 "Created issue #42"
cleanup; rm -rf "${WORKDIR}"

# B2: Issue comment with add_labels
setup_workdir
setup_repo
mock_gh success
mock_git_push
write_result '{
  "workspaces": [{
    "workspace": "argocd",
    "tests": [{"name": "Test 1", "error": "Error 1"}],
    "root_cause": "Still failing",
    "fix_category": "test_fix",
    "action_taken": "commented_on_existing",
    "attempt": 2,
    "next_step": "Merge existing PR",
    "branch": null,
    "issue": {
      "action": "comment",
      "number": 100,
      "body": "Still failing",
      "add_labels": ["attempt:2"]
    }
  }]
}'
run_test "B2: Issue comment → comments on #100" 0 "Commenting on issue #100"
cleanup; rm -rf "${WORKDIR}"

# B3: Issue skip
setup_workdir
setup_repo
mock_gh success
mock_git_push
write_result '{
  "workspaces": [{
    "workspace": "argocd",
    "tests": [{"name": "Test 1", "error": "Error 1"}],
    "root_cause": "Network flake",
    "fix_category": "infra_flake",
    "action_taken": "logged",
    "attempt": 1,
    "next_step": "Monitor",
    "branch": null,
    "issue": {"action": "skip"}
  }]
}'
run_test "B3: Issue skip → no issue action" 0 "No issue directive"
cleanup; rm -rf "${WORKDIR}"

# B4: Issue create fails with 403 → warning, continues
setup_workdir
setup_repo
mock_gh issue_403
mock_git_push
write_result '{
  "workspaces": [{
    "workspace": "argocd",
    "tests": [{"name": "Test 1", "error": "Error 1"}],
    "root_cause": "Test fix needed",
    "fix_category": "test_fix",
    "action_taken": "fix_implemented",
    "attempt": 1,
    "next_step": "Merge",
    "branch": null,
    "issue": {
      "action": "create",
      "title": "[fullsend] E2E: argocd",
      "body": "Test body"
    }
  }]
}'
run_test "B4: Issue create 403 → warning, continues" 0 "Insufficient permissions"
cleanup; rm -rf "${WORKDIR}"

# ===========================================================================
# C. Branch / Push / PR Tests
# ===========================================================================
echo -e "\n${YELLOW}C. Branch / Push / PR${NC}"

# C1: Branch is null → skips push entirely
setup_workdir
setup_repo
mock_gh success
mock_git_push
write_result '{
  "workspaces": [{
    "workspace": "argocd",
    "tests": [{"name": "Test 1", "error": "Error 1"}],
    "root_cause": "Infra flake",
    "fix_category": "infra_flake",
    "action_taken": "logged",
    "attempt": 1,
    "next_step": "Monitor",
    "branch": null,
    "issue": {"action": "skip"}
  }]
}'
run_test "C1: Branch null → no push" 0 "Post-e2e-fix complete" "Pushing branch"
cleanup; rm -rf "${WORKDIR}"

# C2: Branch exists → push and create PR
setup_workdir
setup_repo
create_fix_branch "fix/e2e-argocd-route-wait" "workspaces/argocd/e2e-tests/test.ts" "fixed"
mock_gh success
mock_git_push
write_result '{
  "workspaces": [{
    "workspace": "argocd",
    "tests": [{"name": "Test 1", "error": "Error 1"}],
    "root_cause": "Route timeout",
    "fix_category": "test_fix",
    "action_taken": "fix_implemented",
    "attempt": 1,
    "next_step": "Merge PR",
    "branch": "fix/e2e-argocd-route-wait",
    "issue": {
      "action": "create",
      "title": "[fullsend] E2E: argocd",
      "body": "Test body"
    }
  }]
}'
run_test "C2: Branch exists → push + create PR" 0 "PR created"
cleanup; rm -rf "${WORKDIR}"

# C3: Branch not found → warning
setup_workdir
setup_repo
mock_gh success
mock_git_push
write_result '{
  "workspaces": [{
    "workspace": "argocd",
    "tests": [{"name": "Test 1", "error": "Error 1"}],
    "root_cause": "Route timeout",
    "fix_category": "test_fix",
    "action_taken": "fix_implemented",
    "attempt": 1,
    "next_step": "Merge PR",
    "branch": "fix/e2e-nonexistent-branch",
    "issue": {"action": "skip"}
  }]
}'
run_test "C3: Branch not found → warning" 0 "Branch fix/e2e-nonexistent-branch not found"
cleanup; rm -rf "${WORKDIR}"

# C4: Existing PR → updates, doesn't create new
setup_workdir
setup_repo
create_fix_branch "fix/e2e-argocd-route-wait" "workspaces/argocd/test.ts" "fixed"
mock_gh pr_exists
mock_git_push
write_result '{
  "workspaces": [{
    "workspace": "argocd",
    "tests": [{"name": "Test 1", "error": "Error 1"}],
    "root_cause": "Route timeout",
    "fix_category": "test_fix",
    "action_taken": "fix_implemented",
    "attempt": 2,
    "next_step": "Merge PR",
    "branch": "fix/e2e-argocd-route-wait",
    "issue": {"action": "skip"}
  }]
}'
run_test "C4: Existing PR → updates, no new PR" 0 "already exists.*branch updated"
cleanup; rm -rf "${WORKDIR}"

# ===========================================================================
# D. Backfill Tests
# ===========================================================================
echo -e "\n${YELLOW}D. Placeholder Backfill${NC}"

# D1: ISSUE_PLACEHOLDER backfill in files
setup_workdir
setup_repo
git checkout -q -b "fix/e2e-argocd-test"
mkdir -p workspaces/argocd/e2e-tests/tests/specs
cat > workspaces/argocd/e2e-tests/tests/specs/argocd.spec.ts << 'EOF'
// Fixes: #ISSUE_PLACEHOLDER
test("something", () => {});
EOF
git add workspaces/argocd/e2e-tests/tests/specs/argocd.spec.ts
git commit -q -m "fix(e2e): argocd test

Fixes: #ISSUE_PLACEHOLDER"
mock_gh success
mock_git_push
write_result '{
  "workspaces": [{
    "workspace": "argocd",
    "tests": [{"name": "Test 1", "error": "Error 1"}],
    "root_cause": "Route timeout",
    "fix_category": "test_fix",
    "action_taken": "fix_implemented",
    "attempt": 1,
    "next_step": "Merge",
    "branch": "fix/e2e-argocd-test",
    "issue": {
      "action": "create",
      "title": "[fullsend] E2E: argocd",
      "body": "Test body"
    }
  }]
}'
run_test "D1: ISSUE_PLACEHOLDER backfill" 0 "Backfilling issue #42"

# Verify the file was actually updated
if grep -q '#42' workspaces/argocd/e2e-tests/tests/specs/argocd.spec.ts 2>/dev/null; then
  echo -e "  ${GREEN}✓${NC} D1b: File contains #42 after backfill"
  ((PASS++))
else
  echo -e "  ${RED}✗${NC} D1b: File should contain #42 after backfill"
  ((FAIL++))
fi
cleanup; rm -rf "${WORKDIR}"

# D2: JIRA-PENDING backfill
setup_workdir
setup_repo
git checkout -q -b "fix/e2e-techdocs-skip"
mkdir -p workspaces/techdocs/e2e-tests/tests/specs
cat > workspaces/techdocs/e2e-tests/tests/specs/techdocs.spec.ts << 'EOF'
test.skip(isNightlyMode, "Plugin not loaded (JIRA-PENDING)");
EOF
git add workspaces/techdocs/e2e-tests/tests/specs/techdocs.spec.ts
git commit -q -m "test(e2e): skip techdocs nightly

JIRA: JIRA-PENDING"

# Mock JIRA creation — curl mock must use absolute path to avoid recursion
REAL_CURL="$(command -v curl)"
mkdir -p "${PWD}/mock-bin"
cat > "${PWD}/mock-bin/curl" << MOCKEOF
#!/usr/bin/env bash
if echo "\$@" | grep -q "rest/api/2/issue"; then
  echo '{"key":"RHDHBUGS-999"}'
else
  "${REAL_CURL}" "\$@"
fi
MOCKEOF
chmod +x "${PWD}/mock-bin/curl"

mock_gh success
mock_git_push
export JIRA_TOKEN="test-jira-token"
write_result '{
  "workspaces": [{
    "workspace": "techdocs",
    "tests": [{"name": "Verify docs", "error": "Plugin not loaded"}],
    "root_cause": "Plugin OCI missing",
    "fix_category": "product_bug",
    "action_taken": "test_skipped",
    "attempt": 1,
    "next_step": "Track JIRA",
    "branch": "fix/e2e-techdocs-skip",
    "issue": {
      "action": "create",
      "title": "[fullsend] E2E: techdocs",
      "body": "Test body"
    },
    "jira": {
      "project": "RHDHBUGS",
      "type": "Bug",
      "summary": "E2E techdocs plugin missing",
      "description": "Details",
      "backfill_file": "workspaces/techdocs/e2e-tests/tests/specs/techdocs.spec.ts"
    }
  }]
}'
run_test "D2: JIRA-PENDING backfill" 0 "Backfilling JIRA key RHDHBUGS-999"

if grep -q 'RHDHBUGS-999' workspaces/techdocs/e2e-tests/tests/specs/techdocs.spec.ts 2>/dev/null; then
  echo -e "  ${GREEN}✓${NC} D2b: File contains RHDHBUGS-999 after backfill"
  ((PASS++))
else
  echo -e "  ${RED}✗${NC} D2b: File should contain RHDHBUGS-999 after backfill"
  ((FAIL++))
fi
unset JIRA_TOKEN
cleanup; rm -rf "${WORKDIR}"

# ===========================================================================
# E. JIRA Tests
# ===========================================================================
echo -e "\n${YELLOW}E. JIRA Directives${NC}"

# E1: JIRA directive without JIRA_TOKEN → warning
setup_workdir
setup_repo
mock_gh success
mock_git_push
unset JIRA_TOKEN 2>/dev/null || true
write_result '{
  "workspaces": [{
    "workspace": "techdocs",
    "tests": [{"name": "Test", "error": "Err"}],
    "root_cause": "Plugin bug",
    "fix_category": "product_bug",
    "action_taken": "test_skipped",
    "attempt": 1,
    "next_step": "Track",
    "branch": null,
    "issue": {"action": "skip"},
    "jira": {
      "project": "RHDHBUGS",
      "type": "Bug",
      "summary": "Test",
      "description": "Desc",
      "backfill_file": "test.ts"
    }
  }]
}'
run_test "E1: JIRA without token → warning" 0 "JIRA_TOKEN not set"
cleanup; rm -rf "${WORKDIR}"

# ===========================================================================
# F. Multi-Workspace Integration
# ===========================================================================
echo -e "\n${YELLOW}F. Multi-Workspace Integration${NC}"

# F1: Full multi-workspace — mixed actions
setup_workdir
setup_repo
create_fix_branch "fix/e2e-argocd-route-wait" "workspaces/argocd/test.ts" "fixed argocd"
git checkout -q main
create_fix_branch "fix/e2e-techdocs-skip" "workspaces/techdocs/test.ts" "skip techdocs"
mock_gh success
mock_git_push
write_result '{
  "workspaces": [
    {
      "workspace": "argocd",
      "tests": [{"name": "Verify card", "error": "Route not found"}],
      "root_cause": "Route timeout",
      "fix_category": "test_fix",
      "action_taken": "fix_implemented",
      "attempt": 1,
      "next_step": "Merge PR",
      "branch": "fix/e2e-argocd-route-wait",
      "issue": {
        "action": "create",
        "title": "[fullsend] E2E: argocd",
        "body": "Test body"
      }
    },
    {
      "workspace": "orchestrator",
      "tests": [
        {"name": "Grant admin role", "error": "Timeout"},
        {"name": "Verify RBAC", "error": "Cascaded"}
      ],
      "root_cause": "Keycloak timeout",
      "fix_category": "infra_flake",
      "action_taken": "logged",
      "attempt": 1,
      "next_step": "Monitor",
      "branch": null,
      "issue": {"action": "skip"}
    },
    {
      "workspace": "techdocs",
      "tests": [{"name": "Verify docs", "error": "Plugin missing"}],
      "root_cause": "OCI image missing",
      "fix_category": "product_bug",
      "action_taken": "test_skipped",
      "attempt": 1,
      "next_step": "Track JIRA",
      "branch": "fix/e2e-techdocs-skip",
      "issue": {
        "action": "create",
        "title": "[fullsend] E2E: techdocs",
        "body": "Test body"
      }
    }
  ]
}'
run_test "F1: Multi-workspace mixed → processes all 3" 0 "Workspaces processed: 3"
cleanup; rm -rf "${WORKDIR}"

# F2: All infra_flake → no pushes at all
setup_workdir
setup_repo
mock_gh success
mock_git_push
write_result '{
  "workspaces": [
    {
      "workspace": "argocd",
      "tests": [{"name": "T1", "error": "E1"}],
      "root_cause": "Cluster down",
      "fix_category": "infra_flake",
      "action_taken": "logged",
      "attempt": 1,
      "next_step": "Wait",
      "branch": null,
      "issue": {"action": "skip"}
    },
    {
      "workspace": "orchestrator",
      "tests": [{"name": "T2", "error": "E2"}],
      "root_cause": "Cluster down",
      "fix_category": "infra_flake",
      "action_taken": "logged",
      "attempt": 1,
      "next_step": "Wait",
      "branch": null,
      "issue": {"action": "skip"}
    }
  ]
}'
run_test "F2: All infra_flake → no pushes" 0 "Post-e2e-fix complete" "Pushing branch"
cleanup; rm -rf "${WORKDIR}"

# F3: Verify summary shows per-workspace details
setup_workdir
setup_repo
mock_gh success
mock_git_push
write_result '{
  "workspaces": [
    {
      "workspace": "argocd",
      "tests": [{"name": "T1", "error": "E1"}, {"name": "T2", "error": "E2"}],
      "root_cause": "Config missing",
      "fix_category": "test_fix",
      "action_taken": "issue_tracked",
      "attempt": 1,
      "next_step": "Fix config",
      "branch": null,
      "issue": {"action": "skip"}
    },
    {
      "workspace": "lightspeed",
      "tests": [{"name": "T3", "error": "E3"}],
      "root_cause": "Vault expired",
      "fix_category": "environment",
      "action_taken": "issue_tracked",
      "attempt": 1,
      "next_step": "Renew secret",
      "branch": null,
      "issue": {"action": "skip"}
    }
  ]
}'

# Capture output and verify summary format
OUTPUT="$(bash "${SCRIPT_UNDER_TEST}" 2>&1)" && RC=0 || RC=$?
PASS_THIS=true

if ! echo "${OUTPUT}" | grep -q '\[argocd\]'; then
  PASS_THIS=false
  ERRORS+="  F3: Summary missing [argocd]\n"
fi
if ! echo "${OUTPUT}" | grep -q '\[lightspeed\]'; then
  PASS_THIS=false
  ERRORS+="  F3: Summary missing [lightspeed]\n"
fi
if ! echo "${OUTPUT}" | grep -q 'Tests:.*2'; then
  PASS_THIS=false
  ERRORS+="  F3: Summary should show Tests: 2 for argocd\n"
fi
if ! echo "${OUTPUT}" | grep -q 'Branch:.*none'; then
  PASS_THIS=false
  ERRORS+="  F3: Summary should show (none) for branch\n"
fi

if $PASS_THIS; then
  echo -e "  ${GREEN}✓${NC} F3: Summary shows per-workspace details"
  ((PASS++))
else
  echo -e "  ${RED}✗${NC} F3: Summary format incorrect"
  ((FAIL++))
fi
cleanup; rm -rf "${WORKDIR}"

# ===========================================================================
# G. GHA Sanitization
# ===========================================================================
echo -e "\n${YELLOW}G. GHA Sanitization${NC}"

# G1: Malicious fix_category with :: injection
setup_workdir
write_result '{
  "workspaces": [{
    "workspace": "argocd",
    "tests": [{"name": "t", "error": "e"}],
    "root_cause": "x",
    "fix_category": "::set-output name=evil::pwned",
    "action_taken": "logged",
    "attempt": 1,
    "next_step": "wait",
    "branch": null
  }]
}'
OUTPUT="$(bash "${SCRIPT_UNDER_TEST}" 2>&1)" || true
if echo "${OUTPUT}" | grep -q '::set-output'; then
  echo -e "  ${RED}✗${NC} G1: GHA directive injection not sanitized"
  ((FAIL++))
else
  echo -e "  ${GREEN}✓${NC} G1: GHA directive injection sanitized"
  ((PASS++))
fi
cleanup; rm -rf "${WORKDIR}"

# G2: GH_TOKEN not set → error
WORKDIR="$(mktemp -d)"
cd "${WORKDIR}"
unset GH_TOKEN 2>/dev/null || true
export REPO_FULL_NAME="test/repo"
mkdir -p iteration-1/output
echo '{}' > iteration-1/output/agent-result.json
RC=0
bash "${SCRIPT_UNDER_TEST}" 2>&1 || RC=$?
if [[ "${RC}" -ne 0 ]]; then
  echo -e "  ${GREEN}✓${NC} G2: Missing GH_TOKEN → exits with error"
  ((PASS++))
else
  echo -e "  ${RED}✗${NC} G2: Missing GH_TOKEN should fail"
  ((FAIL++))
fi
cleanup; rm -rf "${WORKDIR}"

# ===========================================================================
# H. Edge Cases
# ===========================================================================
echo -e "\n${YELLOW}H. Edge Cases${NC}"

# H1: Single workspace with no issue and no jira (minimal valid)
setup_workdir
setup_repo
mock_gh success
mock_git_push
write_result '{
  "workspaces": [{
    "workspace": "backstage",
    "tests": [{"name": "Test", "error": "Err"}],
    "root_cause": "Network flake",
    "fix_category": "infra_flake",
    "action_taken": "logged",
    "attempt": 1,
    "next_step": "Monitor",
    "branch": null
  }]
}'
run_test "H1: Minimal valid (no issue, no jira) → succeeds" 0 "Post-e2e-fix complete"
cleanup; rm -rf "${WORKDIR}"

# H2: Iteration 2 result takes precedence over iteration 1
setup_workdir
setup_repo
mock_gh success
mock_git_push
write_result '{
  "workspaces": [{
    "workspace": "old",
    "tests": [{"name": "T", "error": "E"}],
    "root_cause": "Old result",
    "fix_category": "infra_flake",
    "action_taken": "logged",
    "attempt": 1,
    "next_step": "Wait",
    "branch": null
  }]
}' 1
write_result '{
  "workspaces": [{
    "workspace": "new",
    "tests": [{"name": "T", "error": "E"}],
    "root_cause": "New result",
    "fix_category": "infra_flake",
    "action_taken": "logged",
    "attempt": 1,
    "next_step": "Wait",
    "branch": null
  }]
}' 2
run_test "H2: Iteration 2 result used over iteration 1" 0 "\\[new\\]"
cleanup; rm -rf "${WORKDIR}"

# H3: Multiple workspaces with branches — each gets its own PR
setup_workdir
setup_repo
create_fix_branch "fix/e2e-argocd-test" "workspaces/argocd/test.ts" "fix argocd"
git checkout -q main
create_fix_branch "fix/e2e-backstage-test" "workspaces/backstage/test.ts" "fix backstage"
mock_gh success
mock_git_push
write_result '{
  "workspaces": [
    {
      "workspace": "argocd",
      "tests": [{"name": "T1", "error": "E1"}],
      "root_cause": "Fix A",
      "fix_category": "test_fix",
      "action_taken": "fix_implemented",
      "attempt": 1,
      "next_step": "Merge",
      "branch": "fix/e2e-argocd-test",
      "issue": {"action": "create", "title": "Issue A", "body": "Body A"}
    },
    {
      "workspace": "backstage",
      "tests": [{"name": "T2", "error": "E2"}],
      "root_cause": "Fix B",
      "fix_category": "test_fix",
      "action_taken": "fix_implemented",
      "attempt": 1,
      "next_step": "Merge",
      "branch": "fix/e2e-backstage-test",
      "issue": {"action": "create", "title": "Issue B", "body": "Body B"}
    }
  ]
}'

OUTPUT="$(bash "${SCRIPT_UNDER_TEST}" 2>&1)" || true
PR_COUNT="$(echo "${OUTPUT}" | grep -c "PR created" || true)"
if [[ "${PR_COUNT}" -eq 2 ]]; then
  echo -e "  ${GREEN}✓${NC} H3: Two branches → two PRs created"
  ((PASS++))
else
  echo -e "  ${RED}✗${NC} H3: Expected 2 PRs, got ${PR_COUNT}"
  ((FAIL++))
  ERRORS+="  H3: Expected 2 PRs, got ${PR_COUNT}\n"
fi
cleanup; rm -rf "${WORKDIR}"

# ===========================================================================
# Summary
# ===========================================================================
echo ""
echo "==========================================="
echo -e "  ${GREEN}Passed: ${PASS}${NC}  ${RED}Failed: ${FAIL}${NC}"
echo "==========================================="

if [[ -n "${ERRORS}" ]]; then
  echo -e "\nFailure details:"
  echo -e "${ERRORS}"
fi

exit "${FAIL}"
