#!/bin/bash

export NAME_SPACE="${1:-${NAME_SPACE:-orchestrator}}"

escape_yq() {
  local input="$1"
  printf '%s' "$input" | sed 's/"/\\"/g'
  return 0
}

wait_for_deployment() {
  local namespace=$1 resource_name=$2 timeout_minutes=${3:-5} check_interval=${4:-10}
  [[ -z "$namespace" || -z "$resource_name" ]] && { echo "wait_for_deployment: namespace and resource_name required"; return 1; }
  local max_attempts=$((timeout_minutes * 60 / check_interval))
  echo "Waiting for '$resource_name' in '$namespace' (timeout ${timeout_minutes}m)..."
  for ((i = 1; i <= max_attempts; i++)); do
    local pod_name
    pod_name=$(oc get pods -n "$namespace" 2>/dev/null | grep "$resource_name" | awk '{print $1}' | head -n 1)
    if [[ -n "$pod_name" ]]; then
      local is_ready
      is_ready=$(oc get pod "$pod_name" -n "$namespace" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)
      if [[ "$is_ready" == "True" ]] && oc get pod "$pod_name" -n "$namespace" 2>/dev/null | grep -q Running; then
        echo "Pod '$pod_name' is ready"
        return 0
      fi
    fi
    sleep "$check_interval"
  done
  echo "Timeout waiting for $resource_name"
  return 1
}

deploy_workflows() {
  local namespace=$1

  local psql_secret_name psql_svc_name psql_user_key psql_password_key sonataflow_db
  psql_secret_name=$(oc get secrets -n "$namespace" -o name 2>/dev/null | grep "backstage-psql" | grep "secret" | head -1 | sed 's|secret\/||')
  psql_svc_name='backstage-psql'
  psql_user_key="POSTGRES_USER"
  psql_password_key="POSTGRES_PASSWORD"
  sonataflow_db="backstage_plugin_orchestrator"

  local workflow_repo="https://github.com/AndrienkoAleksandr/serverless-workflows.git"
  local workflow_dir="/tmp/serverless-workflows"
  local local_manifests="${SCRIPT_DIR}/yaml"

  # Prefer local yaml/ if it exists and has content
  if [[ -d "${local_manifests}" ]] && [[ -n "$(ls -A "${local_manifests}" 2>/dev/null)" ]]; then
    echo "Using local workflow manifests from ${local_manifests}"
    # Apply all YAMLs in yaml/ with correct namespace
    for f in "${local_manifests}"/*.yaml "${local_manifests}"/*.yml; do
      [[ -e "$f" ]] && oc apply -f "$f" -n "$namespace" && echo "Applied $(basename "$f")"
    done
  else
    echo "Cloning workflow repo..."
    rm -rf "${workflow_dir}"
    git clone --single-branch --branch bulk-import-workflow-sample  "${workflow_repo}" "${workflow_dir}"
    local workflow_manifests="${workflow_dir}/workflows/bulk-import-git-repos/manifests"
    if [[ -d "${workflow_manifests}" ]]; then
      echo "Applying workflow manifests from repo..."

      snToDbPatch="${workflow_manifests}/05-sonataflow_universal-pr.yaml"
      yq eval -i '.spec.persistence.postgresql.secretRef.name = "'"$(escape_yq "$psql_secret_name")"'"' "$snToDbPatch"
      yq eval -i '.spec.persistence.postgresql.secretRef.userKey = "'"$(escape_yq "$psql_user_key")"'"' "$snToDbPatch"
      yq eval -i '.spec.persistence.postgresql.secretRef.passwordKey = "'"$(escape_yq "$psql_password_key")"'"' "$snToDbPatch"
      yq eval -i '.spec.persistence.postgresql.serviceRef.name = "'"$(escape_yq "$psql_svc_name")"'"' "$snToDbPatch"
      yq eval -i '.spec.persistence.postgresql.serviceRef.namespace = "'"$(escape_yq "$namespace")"'"' "$snToDbPatch"
      yq eval -i '.spec.persistence.postgresql.serviceRef.databaseName = "'"$(escape_yq "$sonataflow_db")"'"' "$snToDbPatch"

      oc apply -f "${workflow_manifests}" -n "$namespace"
    else
      echo "Manifests path not found in repo: ${workflow_manifests}"
    fi
  fi

  echo "Waiting for SonataFlow resources..."
  timeout 30s bash -c "
    until [[ \$(oc get sf -n $namespace --no-headers 2>/dev/null | wc -l) -ge 1 ]]; do
      echo \"Waiting for sf resources... \$(oc get sf -n $namespace --no-headers 2>/dev/null | wc -l)\"
      sleep 5
    done
  "

  wait_for_deployment "$namespace" universal-pr 5 || true
  echo "Orchestrator workflows deployment done."
}

deploy_workflows ${NAME_SPACE}
