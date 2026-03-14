# Install Red Hat OpenShift Pipelines operator if not present

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
  local namespace="openshift-pipelines"
  local selector="app=tekton-pipelines-webhook"
  local timeout="300s"

  echo "[CI] Waiting for tekton-pipelines-webhook to be Ready..."

  # Attempt to wait for the Ready condition
  if ! oc wait --for=condition=Ready pod -l "$selector" -n "$namespace" --timeout="$timeout"; then
    echo "[CI] ERROR: Webhook failed to become ready within $timeout"
    
    echo "[CI] --- Pod Status ---"
    oc get pods -n "$namespace" -l "$selector"
    
    echo "[CI] --- Pod Diagnosis (oc describe) ---"
    oc describe pod -l "$selector" -n "$namespace"
    
    return 1
  fi

  echo "[CI] Webhook is Ready!"
  return 0
}

# Function to verify endpoints exist
check_webhook_endpoints() {
  local namespace="openshift-pipelines"
  local svc="tekton-pipelines-webhook"

  echo "[CI] Checking endpoints for $svc..."
  
  local endpoints=$(oc get endpoints "$svc" -n "$namespace" --no-headers | awk '{print $2}')

  if [[ -z "$endpoints" || "$endpoints" == "<none>" ]]; then
    echo "[CI] ERROR: No endpoints available for $svc"
    return 1
  fi

  echo "[CI] Endpoints found: $endpoints"
  return 0
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
  while [ "${retries}" -gt 0 ]; do
    while [ "${idx}" -lt "${#namespaces[@]}" ]; do
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
  exit 1
}

operator::install_pipelines() {
  local OPERATOR_NAMESPACE="openshift-operators"
  local display_name="Red Hat OpenShift Pipelines"

  if oc get csv -n "${OPERATOR_NAMESPACE}" 2>/dev/null | grep -q "${display_name}"; then
    echo "Red Hat OpenShift Pipelines operator is already installed."
    checkPipelineOperatorStatus
    return $?
  fi

  echo "Red Hat OpenShift Pipelines operator is not installed. Installing..."
  oc apply -f "$(dirname "${BASH_SOURCE[0]}")/pipeline-operator.yaml" -n "${OPERATOR_NAMESPACE}" || return 1
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

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  operator::install_pipelines || operator::install_tekton || exit 1
  wait_for_tekton_crds 180 6 || exit 1
  wait_for_tekton_webhook 120 5 || exit 1
  wait_for_tekton_pipelines_webhook || exit 1
  check_webhook_endpoints || exit 1
fi
