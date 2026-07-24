# Install Red Hat OpenShift Pipelines operator if not present
set -e

wait_for_tekton_crds() {
  local timeout_sec=${1:-180} interval_sec=${2:-5}
  local cli="oc"
  command -v oc &>/dev/null || cli="kubectl"
  local -a crds=( "pipelines.tekton.dev" "pipelineruns.tekton.dev" )
  local deadline=$(( SECONDS + timeout_sec ))
  while (( SECONDS < deadline )); do
    local ok=1
    for crd in "${crds[@]}"; do
      if ! "${cli}" get crd "${crd}" &>/dev/null; then
        ok=0
        break
      fi
    done
    if (( ok )); then
      echo "Tekton CRDs are ready."
      return 0
    fi
    echo "Waiting for Tekton CRDs (${crds[*]})..."
    sleep "${interval_sec}"
  done
  echo "Timeout waiting for Tekton CRDs. Ensure OpenShift Pipelines operator is installed." >&2
  return 1
}

wait_for_tekton_pipelines_webhook() {
  local -a namespaces=( "openshift-pipelines" "tekton-pipelines" )
  local selector="app=tekton-pipelines-webhook"
  local timeout="120s"
  local target_ns=""

  echo "[CI] Waiting for tekton-pipelines-webhook to be Ready..."

  # Find which namespace has the webhook pods
  for ns in "${namespaces[@]}"; do
    if oc get pods -n "${ns}" -l "${selector}" --no-headers 2>/dev/null | grep -q .; then
      target_ns="${ns}"
      echo "[CI] Found webhook pods in ${ns}"
      break
    fi
  done

  if [[ -z "${target_ns}" ]]; then
    echo "[CI] WARN: No webhook pods found in any namespace; continuing (endpoints may still work)"
    return 0
  fi

  # Attempt to wait for the Ready condition
  if ! oc wait --for=condition=Ready pod -l "${selector}" -n "${target_ns}" --timeout="${timeout}"; then
    echo "[CI] ERROR: Webhook failed to become ready within ${timeout}"
    echo "[CI] --- Pod Status ---"
    oc get pods -n "${target_ns}" -l "${selector}" || true
    echo "[CI] --- Pod Diagnosis (oc describe) ---"
    oc describe pod -l "${selector}" -n "${target_ns}" || true
    return 1
  fi

  echo "[CI] Webhook is Ready in ${target_ns}!"
  return 0
}

# Function to verify endpoints exist in either namespace
check_webhook_endpoints() {
  local -a namespaces=( "openshift-pipelines" "tekton-pipelines" )
  local svc="tekton-pipelines-webhook"
  local endpoints

  echo "[CI] Checking endpoints for ${svc}..."

  for ns in "${namespaces[@]}"; do
    if ! oc get namespace "${ns}" &>/dev/null; then
      continue
    fi
    endpoints=$(oc get endpoints "${svc}" -n "${ns}" --no-headers 2>/dev/null | awk '{print $2}')
    if [[ -n "${endpoints}" && "${endpoints}" != "<none>" ]]; then
      echo "[CI] Endpoints found in ${ns}: ${endpoints}"
      return 0
    fi
  done

  echo "[CI] ERROR: No endpoints available for ${svc} in any namespace"
  return 1
}

# Wait for conversion webhook service so Pipeline/PipelineRun creation does not fail
wait_for_tekton_webhook() {
  local timeout_sec=${1:-120} interval_sec=${2:-5}
  local -a namespaces=( "openshift-pipelines" "tekton-pipelines" )
  local deadline=$(( SECONDS + timeout_sec ))
  while (( SECONDS < deadline )); do
    for namespace in "${namespaces[@]}"; do
      if oc get service tekton-pipelines-webhook -n "${namespace}" &>/dev/null &&
         oc get endpoints tekton-pipelines-webhook -n "${namespace}" &>/dev/null; then
        echo "Tekton webhook service is ready (${namespace})."
        return 0
      fi
    done
    echo "Waiting for Tekton webhook service..."
    sleep "${interval_sec}"
  done
  echo "Timeout waiting for Tekton webhook service. Ensure Pipelines operator is installed." >&2
  echo "Diagnostics (what exists):" >&2
  for namespace in "${namespaces[@]}"; do
    if oc get namespace "${namespace}" &>/dev/null; then
      echo "  Namespace ${namespace} exists. Services:" >&2
      oc get svc -n "${namespace}" 2>&1 | sed 's/^/    /' >&2
      echo "  Endpoints:" >&2
      oc get endpoints -n "${namespace}" 2>&1 | sed 's/^/    /' >&2
    else
      echo "  Namespace ${namespace} does not exist." >&2
    fi
  done
  return 1
}

checkPipelineOperatorStatus() {
  local retries=${1:-10}
  local -a namespaces=( "openshift-operators" "tekton-pipelines" )
  local -a labels=( "openshift-pipelines-operator" "tekton-pipelines-webhook" )
  local idx=0
  while [[ "${retries}" -gt 0 ]]; do
    while [[ "${idx}" -lt "${#namespaces[@]}" ]]; do
      if oc wait --for=condition=ready pod -l app="${labels[$idx]}" -n "${namespaces[$idx]}" --timeout=300s 2>/dev/null &&
         oc wait --for=condition=Available deployment/${labels[$idx]} -n "${namespaces[$idx]}" --timeout=300s 2>/dev/null; then
        echo "Success: Pod and deployment are ready (${namespaces[$idx]})"
        return 0
      fi
      idx=$(( idx + 1 ))
    done
    echo "Retrying... (${retries} left)"
    retries=$(( retries - 1 ))
    sleep 5
    idx=0
  done
  echo "Failed to install Pipelines Operator - Pod timeout"
  return 1
}

operator::install_pipelines() {
  local OPERATOR_NAMESPACE="openshift-operators"
  local display_name="Red Hat OpenShift Pipelines"
  local manifest
  manifest="$(dirname "${BASH_SOURCE[0]}")/pipeline-operator.yaml"

  if oc get csv -n "${OPERATOR_NAMESPACE}" 2>/dev/null | grep -q "${display_name}"; then
    echo "Red Hat OpenShift Pipelines operator is already installed."
    checkPipelineOperatorStatus
    return $?
  fi

  # Check if subscription already exists (handles parallel workers)
  if oc get subscription openshift-pipelines-operator -n "${OPERATOR_NAMESPACE}" &>/dev/null; then
    echo "OpenShift Pipelines subscription already exists; waiting for operator."
    checkPipelineOperatorStatus
    return $?
  fi

  echo "Red Hat OpenShift Pipelines operator is not installed. Installing..."
  if ! oc apply -f "${manifest}" -n "${OPERATOR_NAMESPACE}"; then
    # Parallel Playwright projects race on the same subscription - handle AlreadyExists
    if oc get subscription openshift-pipelines-operator -n "${OPERATOR_NAMESPACE}" &>/dev/null; then
      echo "OpenShift Pipelines subscription was created by another worker; continuing."
    else
      return 1
    fi
  fi
  checkPipelineOperatorStatus
  return $?
}

# Install Tekton Pipelines (alternative to OpenShift Pipelines for Kubernetes)
operator::install_tekton() {
  local display_name="tekton-pipelines-webhook"

  if oc get pods -n "tekton-pipelines" 2>/dev/null | grep -q "${display_name}"; then
    echo "Tekton Pipelines are already installed."
    checkPipelineOperatorStatus
    return $?
  fi

  echo "Tekton Pipelines is not installed. Installing..."
  kubectl apply -f https://storage.googleapis.com/tekton-releases/pipeline/latest/release.yaml || return 1
  kubectl get crd pipelineruns.tekton.dev -o jsonpath='{.spec.conversion.webhook.clientConfig.service}'
  checkPipelineOperatorStatus
  return $?
}

# Wait for Active namespace, apply pipeline CRs, grant cluster-reader + rhdh-tekton-plugin to default SA.
# ClusterRoleBinding names must differ: two bindings cannot share the same metadata.name.
operator::grant_default_service_account_cluster_reader_and_tekton() {
  local namespace=$1
  local config_dir
  local phase
  local i

  if [[ -z "${namespace}" ]]; then
    echo "operator::grant_default_service_account_cluster_reader_and_tekton: namespace argument required" >&2
    return 1
  fi

  config_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

  for i in $(seq 1 90); do
    phase=$(oc get namespace "${namespace}" -o jsonpath='{.status.phase}' 2>/dev/null || true)
    [[ "${phase}" == "Active" ]] && break
    if [[ "${phase}" == "Terminating" ]]; then
      echo "Namespace ${namespace} terminating, waiting for delete..."
      oc wait --for=delete "namespace/${namespace}" --timeout=60s 2>/dev/null || true
    fi
    echo "Waiting for namespace ${namespace} (phase=${phase:-unknown})..."
    sleep 2
  done
  oc wait --for=jsonpath='{.status.phase}=Active' "namespace/${namespace}" --timeout=30s

  oc apply -f "${config_dir}/pipeline-tests.yaml" -n "${namespace}"

  oc adm policy add-cluster-role-to-user cluster-reader -z default -n "${namespace}" 2>/dev/null \
    || oc create clusterrolebinding "rhdh-${namespace}-cluster-reader-default" \
      --clusterrole=cluster-reader --serviceaccount="${namespace}:default" 2>/dev/null \
    || true
  oc apply -f "${config_dir}/cluster-role.yaml"
  oc create clusterrolebinding "rhdh-${namespace}-tekton-plugin-default" \
    --clusterrole=rhdh-tekton-plugin --serviceaccount="${namespace}:default" 2>/dev/null || true
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  if ! operator::install_pipelines; then
    # Only try upstream Tekton if OpenShift Pipelines subscription doesn't exist
    if ! oc get subscription openshift-pipelines-operator -n openshift-operators &>/dev/null; then
      operator::install_tekton
    else
      echo "OpenShift Pipelines subscription exists; skipping upstream Tekton install."
      checkPipelineOperatorStatus || true
    fi
  fi
  wait_for_tekton_crds 180 6
  wait_for_tekton_webhook 120 5
  wait_for_tekton_pipelines_webhook
  check_webhook_endpoints
  operator::grant_default_service_account_cluster_reader_and_tekton "${1}"
fi
