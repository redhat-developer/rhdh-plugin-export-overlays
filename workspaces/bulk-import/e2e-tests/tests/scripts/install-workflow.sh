#!/bin/bash
#
# Legacy shell deploy for universal-pr. Prefer tests/utils/workflow-deployment-helpers.ts
# (deployBulkImportOrchestratorWorkflow) used from bulk-import-orchestrator.spec.ts.
#
# Deploy the bulk-import universal-pr SonataFlow workflow into the orchestrator namespace.
# Intended to run after installOrchestrator() from @red-hat-developer-hub/e2e-test-utils.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

export NAME_SPACE="${1:-${NAME_SPACE:-orchestrator}}"

readonly WORKFLOW_NAME="universal-pr"
readonly WORKFLOW_REPO="https://github.com/AndrienkoAleksandr/serverless-workflows.git"
readonly WORKFLOW_REPO_BRANCH="bulk-import-workflow-sample"
readonly WORKFLOW_MANIFESTS_REL="workflows/bulk-import-git-repos/manifests"

readonly E2E_WORKFLOW_PG_SECRET="backstage-psql-secret"
readonly UPSTREAM_WORKFLOW_PG_SECRET="sonataflow-psql-postgresql"
readonly PSQL_SVC_NAME="backstage-psql"
readonly PSQL_USER_KEY="POSTGRES_USER"
readonly PSQL_PASSWORD_KEY="POSTGRES_PASSWORD"
readonly SONATAFLOW_DB="backstage_plugin_orchestrator"
readonly SONATAFLOW_DB_SCHEMA="bulk-import-git-repos"
readonly PSQL_PORT="5432"

readonly DATA_INDEX_DEPLOY="sonataflow-platform-data-index-service"
readonly JOBS_SERVICE_DEPLOY="sonataflow-platform-jobs-service"

log() {
  echo "[install-workflow] $*"
}

die() {
  log "ERROR: $*"
  exit 1
}

escape_yq() {
  local input="$1"
  printf '%s' "$input" | sed 's/"/\\"/g'
}

run_oc() {
  oc "$@"
}

resolve_postgres_secret_name() {
  local namespace=$1
  if run_oc get secret "${E2E_WORKFLOW_PG_SECRET}" -n "${namespace}" &>/dev/null; then
    printf '%s' "${E2E_WORKFLOW_PG_SECRET}"
    return 0
  fi
  local discovered
  discovered="$(
    run_oc get secrets -n "${namespace}" -o name 2>/dev/null \
      | grep "backstage-psql" \
      | grep "secret" \
      | head -1 \
      | sed 's|secret/||'
  )"
  if [[ -n "${discovered}" ]]; then
    log "Using discovered Postgres secret: ${discovered}"
    printf '%s' "${discovered}"
    return 0
  fi
  die "No Postgres secret found in namespace '${namespace}' (expected ${E2E_WORKFLOW_PG_SECRET})"
}

patch_workflow_postgres() {
  local namespace=$1 workflow=$2
  local patch
  patch="$(cat <<EOF
{
  "spec": {
    "persistence": {
      "postgresql": {
        "secretRef": {
          "name": "${E2E_WORKFLOW_PG_SECRET}",
          "userKey": "${PSQL_USER_KEY}",
          "passwordKey": "${PSQL_PASSWORD_KEY}"
        },
        "serviceRef": {
          "name": "${PSQL_SVC_NAME}",
          "namespace": "${namespace}",
          "port": ${PSQL_PORT},
          "databaseName": "${SONATAFLOW_DB}",
          "databaseSchema": "${SONATAFLOW_DB_SCHEMA}"
        }
      }
    }
  }
}
EOF
)"
  run_oc patch sonataflow "${workflow}" -n "${namespace}" --type merge -p "${patch}" \
    >/dev/null
}

sonataflow_cr_uses_e2e_postgres() {
  local namespace=$1 workflow=$2
  local secret_name
  secret_name="$(
    run_oc get sonataflow "${workflow}" -n "${namespace}" \
      -o jsonpath='{.spec.persistence.postgresql.secretRef.name}' 2>/dev/null || true
  )"
  [[ "${secret_name}" == "${E2E_WORKFLOW_PG_SECRET}" ]]
}

deployment_references_upstream_pg_secret() {
  local namespace=$1 workflow=$2
  local template_json
  if ! run_oc get deployment "${workflow}" -n "${namespace}" &>/dev/null; then
    return 1
  fi
  template_json="$(
    run_oc get deployment "${workflow}" -n "${namespace}" -o jsonpath='{.spec.template}' 2>/dev/null
  )"
  [[ "${template_json}" == *"${UPSTREAM_WORKFLOW_PG_SECRET}"* ]]
}

wait_for_workflow_postgres_aligned() {
  local namespace=$1 workflow=$2 timeout_seconds=${3:-120}
  local deadline=$((SECONDS + timeout_seconds))
  local attempt=0

  log "Waiting for ${workflow} Postgres wiring (timeout ${timeout_seconds}s)..."
  while ((SECONDS < deadline)); do
    attempt=$((attempt + 1))
    if sonataflow_cr_uses_e2e_postgres "${namespace}" "${workflow}" \
      && ! deployment_references_upstream_pg_secret "${namespace}" "${workflow}"; then
      log "${workflow} Postgres alignment OK (attempt ${attempt})"
      return 0
    fi
    patch_workflow_postgres "${namespace}" "${workflow}" || true
    sleep 2
  done
  die "${workflow} Postgres not aligned on ${E2E_WORKFLOW_PG_SECRET} within ${timeout_seconds}s"
}

wait_for_sonataflow_cr() {
  local namespace=$1 workflow=$2 timeout_seconds=${3:-120}
  local deadline=$((SECONDS + timeout_seconds))

  log "Waiting for SonataFlow CR '${workflow}' in ${namespace}..."
  while ((SECONDS < deadline)); do
    if run_oc get sonataflow "${workflow}" -n "${namespace}" &>/dev/null; then
      log "SonataFlow CR '${workflow}' exists"
      return 0
    fi
    sleep 5
  done
  die "Timed out waiting for SonataFlow CR '${workflow}'"
}

wait_for_deployment_rollout() {
  local namespace=$1 deployment=$2 timeout_seconds=${3:-600}
  log "Waiting for deployment/${deployment} rollout in ${namespace} (timeout ${timeout_seconds}s)..."
  run_oc rollout status "deployment/${deployment}" -n "${namespace}" \
    --timeout="${timeout_seconds}s"
}

wait_for_pod_matching() {
  local namespace=$1 name_pattern=$2 timeout_seconds=${3:-300}
  local deadline=$((SECONDS + timeout_seconds))

  log "Waiting for Running pod matching '${name_pattern}' in ${namespace}..."
  while ((SECONDS < deadline)); do
    local pod_name ready
    pod_name="$(
      run_oc get pods -n "${namespace}" --no-headers 2>/dev/null \
        | grep "${name_pattern}" \
        | awk '{print $1}' \
        | head -n 1
    )"
    if [[ -n "${pod_name}" ]]; then
      ready="$(
        run_oc get pod "${pod_name}" -n "${namespace}" \
          -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null
      )"
      if [[ "${ready}" == "True" ]] \
        && run_oc get pod "${pod_name}" -n "${namespace}" --no-headers 2>/dev/null \
          | grep -q Running; then
        log "Pod '${pod_name}' is ready"
        return 0
      fi
    fi
    sleep 10
  done
  die "Timed out waiting for pod matching '${name_pattern}'"
}

is_data_index_healthy() {
  local namespace=$1
  local health
  if ! health="$(
    run_oc exec -n "${namespace}" "deploy/${DATA_INDEX_DEPLOY}" -- \
      curl -sf --max-time 5 "http://localhost:8080/q/health/ready" 2>/dev/null
  )"; then
    return 1
  fi
  [[ "${health}" == *'"status":"UP"'* ]] || [[ "${health}" == *'"status": "UP"'* ]]
}

wait_for_data_index_healthy() {
  local namespace=$1 timeout_seconds=${2:-180}
  local deadline=$((SECONDS + timeout_seconds))

  log "Waiting for data-index health in ${namespace}..."
  while ((SECONDS < deadline)); do
    if is_data_index_healthy "${namespace}"; then
      log "Data-index is healthy"
      return 0
    fi
    sleep 5
  done
  die "Data-index not healthy within ${timeout_seconds}s"
}

harden_sonataflow_platform() {
  local namespace=$1
  if ! run_oc get sonataflowplatform sonataflow-platform -n "${namespace}" &>/dev/null; then
    log "SonataFlowPlatform not found; skipping platform hardening"
    return 0
  fi

  local sfp_patch
  sfp_patch="$(cat <<'EOF'
{
  "spec": {
    "services": {
      "dataIndex": {
        "podTemplate": {
          "container": {
            "resources": {
              "requests": { "memory": "64Mi", "cpu": "250m" },
              "limits": { "memory": "1Gi", "cpu": "500m" }
            },
            "livenessProbe": {
              "failureThreshold": 200,
              "httpGet": {
                "path": "/q/health/live",
                "port": 8080,
                "scheme": "HTTP"
              },
              "periodSeconds": 10,
              "timeoutSeconds": 10
            },
            "readinessProbe": {
              "failureThreshold": 200,
              "httpGet": {
                "path": "/q/health/ready",
                "port": 8080,
                "scheme": "HTTP"
              },
              "periodSeconds": 10,
              "timeoutSeconds": 10
            }
          }
        }
      },
      "jobService": {
        "podTemplate": {
          "container": {
            "resources": {
              "requests": { "memory": "64Mi", "cpu": "250m" },
              "limits": { "memory": "1Gi", "cpu": "500m" }
            }
          }
        }
      }
    }
  }
}
EOF
)"

  log "Hardening SonataFlowPlatform (non-fatal if patch fails)..."
  if run_oc patch sonataflowplatform sonataflow-platform -n "${namespace}" \
    --type merge -p "${sfp_patch}" 2>/dev/null; then
    if run_oc get deployment "${DATA_INDEX_DEPLOY}" -n "${namespace}" &>/dev/null; then
      run_oc rollout status "deployment/${DATA_INDEX_DEPLOY}" -n "${namespace}" \
        --timeout=300s || log "WARNING: data-index rollout status timed out"
    fi
    if run_oc get deployment "${JOBS_SERVICE_DEPLOY}" -n "${namespace}" &>/dev/null; then
      run_oc rollout status "deployment/${JOBS_SERVICE_DEPLOY}" -n "${namespace}" \
        --timeout=300s || log "WARNING: jobs-service rollout status timed out"
    fi
  else
    log "WARNING: SonataFlowPlatform patch failed (continuing)"
  fi
}

wait_for_workflow_in_data_index() {
  local namespace=$1 workflow=$2 timeout_seconds=${3:-180}
  local deadline=$((SECONDS + timeout_seconds))
  local graphql_query='{"query":"{ ProcessDefinitions { id } }"}'

  log "Waiting for '${workflow}' to appear in data-index ProcessDefinitions..."
  while ((SECONDS < deadline)); do
    local response
    if response="$(
      run_oc exec -n "${namespace}" "deploy/${DATA_INDEX_DEPLOY}" -- \
        curl -sf --max-time 10 -X POST \
        -H "Content-Type: application/json" \
        -d "${graphql_query}" \
        "http://localhost:8080/graphql" 2>/dev/null
    )" && [[ "${response}" == *"\"${workflow}\""* || "${response}" == *"\"id\":\"${workflow}\""* ]]; then
      log "Data-index lists ProcessDefinition '${workflow}'"
      return 0
    fi
    sleep 5
  done

  log "WARNING: '${workflow}' not confirmed in data-index GraphQL within ${timeout_seconds}s"
  log "Continuing — deployment is ready; data-index indexing can lag"
  return 0
}

apply_workflow_manifests() {
  local namespace=$1 psql_secret_name=$2
  local workflow_dir="/tmp/serverless-workflows-bulk-import-$$"
  local local_manifests="${SCRIPT_DIR}/yaml"
  local workflow_manifests=""

  if [[ -d "${local_manifests}" ]] && [[ -n "$(ls -A "${local_manifests}" 2>/dev/null)" ]]; then
    log "Using local workflow manifests from ${local_manifests}"
    workflow_manifests="${local_manifests}"
    for f in "${local_manifests}"/*.yaml "${local_manifests}"/*.yml; do
      [[ -e "${f}" ]] || continue
      run_oc apply -f "${f}" -n "${namespace}"
      log "Applied $(basename "${f}")"
    done
  else
    log "Cloning ${WORKFLOW_REPO} (branch ${WORKFLOW_REPO_BRANCH})..."
    rm -rf "${workflow_dir}"
    git clone --single-branch --branch "${WORKFLOW_REPO_BRANCH}" \
      "${WORKFLOW_REPO}" "${workflow_dir}"
    workflow_manifests="${workflow_dir}/${WORKFLOW_MANIFESTS_REL}"
    if [[ ! -d "${workflow_manifests}" ]]; then
      die "Manifests path not found: ${workflow_manifests}"
    fi

    local sonataflow_manifest="${workflow_manifests}/05-sonataflow_${WORKFLOW_NAME}.yaml"
    if [[ ! -f "${sonataflow_manifest}" ]]; then
      die "SonataFlow manifest not found: ${sonataflow_manifest}"
    fi

    yq eval -i \
      ".spec.persistence.postgresql.secretRef.name = \"$(escape_yq "${psql_secret_name}")\"" \
      "${sonataflow_manifest}"
    yq eval -i \
      ".spec.persistence.postgresql.secretRef.userKey = \"$(escape_yq "${PSQL_USER_KEY}")\"" \
      "${sonataflow_manifest}"
    yq eval -i \
      ".spec.persistence.postgresql.secretRef.passwordKey = \"$(escape_yq "${PSQL_PASSWORD_KEY}")\"" \
      "${sonataflow_manifest}"
    yq eval -i \
      ".spec.persistence.postgresql.serviceRef.name = \"$(escape_yq "${PSQL_SVC_NAME}")\"" \
      "${sonataflow_manifest}"
    yq eval -i \
      ".spec.persistence.postgresql.serviceRef.namespace = \"$(escape_yq "${namespace}")\"" \
      "${sonataflow_manifest}"
    yq eval -i \
      ".spec.persistence.postgresql.serviceRef.databaseName = \"$(escape_yq "${SONATAFLOW_DB}")\"" \
      "${sonataflow_manifest}"
    yq eval -i \
      ".spec.persistence.postgresql.serviceRef.port = ${PSQL_PORT}" \
      "${sonataflow_manifest}"
    yq eval -i \
      ".spec.persistence.postgresql.serviceRef.databaseSchema = \"$(escape_yq "${SONATAFLOW_DB_SCHEMA}")\"" \
      "${sonataflow_manifest}"

    log "Applying workflow manifests from ${workflow_manifests}..."
    run_oc apply -f "${workflow_manifests}" -n "${namespace}"
    rm -rf "${workflow_dir}"
  fi
}

deploy_workflows() {
  local namespace=$1
  local psql_secret_name

  log "Deploying ${WORKFLOW_NAME} workflow to namespace '${namespace}'"

  if ! run_oc get namespace "${namespace}" &>/dev/null; then
    die "Namespace '${namespace}' does not exist (run installOrchestrator first)"
  fi

  psql_secret_name="$(resolve_postgres_secret_name "${namespace}")"
  log "Postgres secret: ${psql_secret_name}"

  if ! run_oc get svc "${PSQL_SVC_NAME}" -n "${namespace}" &>/dev/null; then
    die "Postgres service '${PSQL_SVC_NAME}' not found in ${namespace}"
  fi

  harden_sonataflow_platform "${namespace}"

  if run_oc get deployment "${DATA_INDEX_DEPLOY}" -n "${namespace}" &>/dev/null; then
    wait_for_data_index_healthy "${namespace}" 120 || \
      log "WARNING: data-index not healthy before workflow apply (will retry after deploy)"
  fi

  apply_workflow_manifests "${namespace}" "${psql_secret_name}"

  wait_for_sonataflow_cr "${namespace}" "${WORKFLOW_NAME}" 120

  patch_workflow_postgres "${namespace}" "${WORKFLOW_NAME}"
  wait_for_workflow_postgres_aligned "${namespace}" "${WORKFLOW_NAME}" 120

  if run_oc get deployment "${WORKFLOW_NAME}" -n "${namespace}" &>/dev/null; then
    run_oc rollout restart "deployment/${WORKFLOW_NAME}" -n "${namespace}"
    sleep 2
    wait_for_deployment_rollout "${namespace}" "${WORKFLOW_NAME}" 600
  else
    wait_for_pod_matching "${namespace}" "${WORKFLOW_NAME}" 600
  fi

  if run_oc get deployment "${DATA_INDEX_DEPLOY}" -n "${namespace}" &>/dev/null; then
    wait_for_data_index_healthy "${namespace}" 180
    wait_for_workflow_in_data_index "${namespace}" "${WORKFLOW_NAME}" 180
  fi

  log "Orchestrator workflow '${WORKFLOW_NAME}' deployment finished successfully"
}

deploy_workflows "${NAME_SPACE}"
