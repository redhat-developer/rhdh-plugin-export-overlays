#!/usr/bin/env bash
#
# Discover or install OpenShift cluster logging (Loki) for orchestrator-backend-module-loki.
# Object storage uses in-cluster MinIO (S3-compatible). Prints the Loki base URL on stdout.
#
# Discovery (when logging-loki route already exists):
#   https://$LOKI_HOST/api/logs/v1/application/
#
# Manifests: tests/support/manifests/loki/ (applied via envsubst + oc apply — idempotent).
#
# Environment:
#   LOKI_NAMESPACE              (default: openshift-logging)
#   LOKI_ROUTE_NAME             (default: logging-loki)
#   LOKI_API_PATH               (default: /api/logs/v1/application/)
#   LOKI_WAIT_TIMEOUT           Route / LokiStack wait (default: 1200)
#   LOKI_OPERATOR_WAIT_TIMEOUT  Operator CSV wait (default: 1800)
#   LOKI_SIZE                   LokiStack size (default: 1x.demo — lightest; use 1x.extra-small+ for prod-like)
#   LOKI_STORAGE_CLASS          Block storage class (default: cluster default SC)
#   LOKI_MINIO_NAME             MinIO service name (default: minio)
#   LOKI_MINIO_BUCKET           Bucket for Loki (default: logging-loki)
#   LOKI_MINIO_REGION           Placeholder region for Loki secret (default: us-east-1)
#   LOKI_MINIO_ACCESS_KEY       MinIO access key (default: e2e-loki-minio)
#   LOKI_MINIO_SECRET_KEY       MinIO secret key (default: e2e-loki-minio-secret)
#   LOKI_MINIO_STORAGE_SIZE     MinIO PVC size (default: 10Gi)
#   LOKI_MINIO_IMAGE            MinIO server image
#   LOKI_MINIO_MC_IMAGE         MinIO client image for bucket bootstrap
#   LOKI_MINIO_USE_PVC          Use PVC for MinIO data (default: false = emptyDir, ROSA-friendly)
#   LOKI_MINIO_ROLLOUT_TIMEOUT  MinIO deployment wait (default: 600)
#   LOKI_DISCOVER_ONLY          If true/1, skip install and fail when route is missing
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFESTS_DIR="${SCRIPT_DIR}/../manifests/loki"
LOKI_STORAGE_CLASS="${LOKI_STORAGE_CLASS:-${VAULT_LOKI_STORAGE_CLASS:-}}"

LOKI_NS="${LOKI_NAMESPACE:-openshift-logging}"
LOKI_ROUTE="${LOKI_ROUTE_NAME:-logging-loki}"
LOKI_API_PATH="${LOKI_API_PATH:-/api/logs/v1/application/}"
WAIT_TIMEOUT="${LOKI_WAIT_TIMEOUT:-1200}"
OPERATOR_WAIT_TIMEOUT="${LOKI_OPERATOR_WAIT_TIMEOUT:-1800}"
LOKI_SIZE="${LOKI_SIZE:-1x.demo}"
LOKI_SECRET_NAME="${LOKI_SECRET_NAME:-logging-loki-s3}"
LOKI_OPERATORS_NS="${LOKI_OPERATORS_NS:-openshift-operators-redhat}"

MINIO_NAME="${LOKI_MINIO_NAME:-minio}"
MINIO_BUCKET="${LOKI_MINIO_BUCKET:-logging-loki}"
MINIO_REGION="${LOKI_MINIO_REGION:-us-east-1}"
MINIO_ACCESS_KEY="${LOKI_MINIO_ACCESS_KEY:-e2e-loki-minio}"
MINIO_SECRET_KEY="${LOKI_MINIO_SECRET_KEY:-e2e-loki-minio-secret}"
MINIO_STORAGE_SIZE="${LOKI_MINIO_STORAGE_SIZE:-10Gi}"
MINIO_IMAGE="${LOKI_MINIO_IMAGE:-quay.io/minio/minio:RELEASE.2024-11-07T00-52-20Z}"
MINIO_MC_IMAGE="${LOKI_MINIO_MC_IMAGE:-quay.io/minio/mc:RELEASE.2024-11-21T17-21-54Z}"
MINIO_ROLLOUT_TIMEOUT="${LOKI_MINIO_ROLLOUT_TIMEOUT:-600}"
# emptyDir avoids PVC + SCC uid range issues on ROSA restricted-v2
MINIO_USE_PVC="${LOKI_MINIO_USE_PVC:-false}"
MINIO_ENDPOINT="http://${MINIO_NAME}.${LOKI_NS}.svc:9000"

# envsubst only substitutes exported variables — export all manifest placeholders.
export LOKI_NS LOKI_OPERATORS_NS LOKI_SIZE LOKI_SECRET_NAME \
  MINIO_NAME MINIO_BUCKET MINIO_REGION MINIO_ACCESS_KEY MINIO_SECRET_KEY \
  MINIO_STORAGE_SIZE MINIO_IMAGE MINIO_MC_IMAGE MINIO_ENDPOINT

log() {
  echo "[install-orchestrator-loki] $*" >&2
}

# Only these placeholders are expanded — leaves shell vars like $MINIO_ROOT_USER intact.
LOKI_MANIFEST_ENVS='$LOKI_NS $LOKI_OPERATORS_NS $LOKI_SIZE $LOKI_SECRET_NAME $LOKI_STORAGE_CLASS $LOKI_EFFECTIVE_DATE $LOKI_GATEWAY_CA_CONFIGMAP $MINIO_NAME $MINIO_BUCKET $MINIO_REGION $MINIO_ACCESS_KEY $MINIO_SECRET_KEY $MINIO_ENDPOINT $MINIO_IMAGE $MINIO_MC_IMAGE $MINIO_STORAGE_SIZE $SUBSCRIPTION_PACKAGE $SUBSCRIPTION_NAMESPACE $OPERATOR_CHANNEL'

apply_loki_manifest() {
  local template="$1"
  envsubst "${LOKI_MANIFEST_ENVS}" < "${MANIFESTS_DIR}/${template}" | oc apply -f -
}

loki_url_from_route() {
  local host
  host="$(oc get route "${LOKI_ROUTE}" -n "${LOKI_NS}" -o jsonpath='{.spec.host}' 2>/dev/null || true)"
  [[ -n "${host}" ]] || return 1
  echo "https://${host}${LOKI_API_PATH}"
}

print_loki_url() {
  local url="$1"
  log "Loki base URL: ${url}"
  echo "${url}"
}

wait_for_loki_route() {
  local url
  log "Waiting for route ${LOKI_ROUTE} in ${LOKI_NS} (timeout ${WAIT_TIMEOUT}s)..."
  oc wait route/"${LOKI_ROUTE}" -n "${LOKI_NS}" \
    --for=jsonpath='{.spec.host}' \
    --timeout="${WAIT_TIMEOUT}s" || return 1
  url="$(loki_url_from_route)" || return 1
  print_loki_url "${url}"
}

wait_for_operator_csv() {
  local namespace="$1"
  local package_name="$2"
  local display_name="$3"
  local timeout_secs="$4"
  local csv_label="operators.coreos.com/${package_name}.${namespace}"
  local rc=0

  log "Waiting for operator CSV '${display_name}' (${package_name}) in ${namespace} (timeout ${timeout_secs}s)..."

  if oc get subscription "${package_name}" -n "${namespace}" \
    -o jsonpath='{.status.conditions[?(@.type=="ResolutionFailed")].status}' 2>/dev/null \
    | grep -q True; then
    log "ERROR: Subscription ${package_name} ResolutionFailed — check operator channel"
    oc describe subscription "${package_name}" -n "${namespace}" 2>/dev/null | tail -30 >&2 || true
    return 1
  fi

  timeout "${timeout_secs}" sh -euc "
    oc wait --for=create csv -l '${csv_label}' -n '${namespace}' --timeout=24h
    oc wait csv -l '${csv_label}' -n '${namespace}' \
      --for=jsonpath='{.status.phase}'=Succeeded --timeout=24h
  " || rc=$?
  if [[ "${rc}" -eq 0 ]]; then
    return 0
  fi
  if [[ "${rc}" -eq 124 ]]; then
    log "ERROR: Timed out after ${timeout_secs}s waiting for operator ${package_name} in ${namespace}"
  else
    log "ERROR: Operator ${package_name} did not reach Succeeded in ${namespace} (exit ${rc})"
  fi
  log "Subscription / InstallPlan:"
  oc get subscription,installplan -n "${namespace}" 2>/dev/null >&2 || true
  log "ClusterServiceVersions:"
  oc get csv -n "${namespace}" 2>/dev/null >&2 || true
  oc describe subscription "${package_name}" -n "${namespace}" 2>/dev/null | tail -30 >&2 || true
  return 1
}

get_default_storage_class() {
  local sc
  sc="$(oc get storageclass -o json 2>/dev/null \
    | jq -r '[.items[] | select(.metadata.annotations["storageclass.kubernetes.io/is-default-class"] == "true") | .metadata.name][0] // empty')"
  if [[ -z "${sc}" ]]; then
    sc="$(oc get storageclass -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  fi
  [[ -n "${sc}" ]] || return 1
  echo "${sc}"
}

packagemanifest_redhat_json() {
  local package="$1"
  oc get packagemanifest -n openshift-marketplace -o json 2>/dev/null \
    | jq -c --arg pkg "${package}" --arg src "redhat-operators" '
        [.items[]
          | select(.metadata.name == $pkg)
          | select(
              .status.catalogSource == $src
              or ((.metadata.labels.catalog // "") == "redhat-operators")
            )
        ][0] // empty'
}

resolve_logging_stack_channel() {
  local channel pm

  if [[ -n "${LOKI_OPERATOR_CHANNEL:-}" ]]; then
    log "Using LOKI_OPERATOR_CHANNEL=${LOKI_OPERATOR_CHANNEL}"
    echo "${LOKI_OPERATOR_CHANNEL}"
    return 0
  fi
  if [[ -n "${LOGGING_OPERATOR_CHANNEL:-}" ]]; then
    log "Using LOGGING_OPERATOR_CHANNEL=${LOGGING_OPERATOR_CHANNEL}"
    echo "${LOGGING_OPERATOR_CHANNEL}"
    return 0
  fi

  pm="$(packagemanifest_redhat_json "cluster-logging")"
  channel="$(echo "${pm}" | jq -r '.status.defaultChannel // empty')"
  if [[ -z "${channel}" || "${channel}" == "stable" ]]; then
    pm="$(packagemanifest_redhat_json "loki-operator")"
    channel="$(echo "${pm}" | jq -r '.status.defaultChannel // empty')"
  fi
  if [[ -z "${channel}" || "${channel}" == "stable" ]]; then
    pm="$(packagemanifest_redhat_json "loki-operator")"
    channel="$(echo "${pm}" | jq -r '
      [.status.channels[].name | select(test("^stable-[0-9]"))] | sort | last // empty')"
  fi

  if [[ -z "${channel}" ]]; then
    log "ERROR: Could not resolve logging operator channel from redhat-operators catalog"
    oc get packagemanifest loki-operator cluster-logging -n openshift-marketplace \
      -o custom-columns=NAME:.metadata.name,CATALOG:.status.catalogSource,DEFAULT:.status.defaultChannel \
      2>/dev/null >&2 || true
    return 1
  fi
  if [[ "${channel}" == "stable" ]]; then
    log "ERROR: Channel 'stable' is not available for OpenShift Logging 6.x on this cluster."
    log "Set LOKI_OPERATOR_CHANNEL (e.g. stable-6.5). Available channels:"
    echo "${pm}" | jq -r '.status.channels[].name' >&2 || true
    return 1
  fi

  log "Resolved logging stack operator channel: ${channel}"
  echo "${channel}"
}

subscription_has_resolution_failure() {
  local namespace="$1"
  local package="$2"
  oc get subscription "${package}" -n "${namespace}" \
    -o jsonpath='{.status.conditions[?(@.type=="ResolutionFailed")].status}' 2>/dev/null \
    | grep -q "True"
}

ensure_operator_subscription() {
  local namespace="$1"
  local package="$2"
  local channel="$3"
  local current=""

  export SUBSCRIPTION_NAMESPACE="${namespace}"
  export SUBSCRIPTION_PACKAGE="${package}"
  export OPERATOR_CHANNEL="${channel}"

  if oc get subscription "${package}" -n "${namespace}" &>/dev/null; then
    current="$(oc get subscription "${package}" -n "${namespace}" -o jsonpath='{.spec.channel}')"
    if [[ "${current}" == "${channel}" ]] \
      && ! subscription_has_resolution_failure "${namespace}" "${package}"; then
      log "Subscription ${package} already present (channel=${channel})"
      return 0
    fi
    log "Replacing subscription ${package} (was channel=${current}, ResolutionFailed=$(subscription_has_resolution_failure "${namespace}" "${package}" && echo yes || echo no))"
    oc delete subscription "${package}" -n "${namespace}" --ignore-not-found --wait=true
    sleep 3
  fi

  log "Subscribing to ${package} (channel=${channel}, namespace=${namespace})..."
  apply_loki_manifest "operator-subscription.yaml"
}

install_loki_operator() {
  local channel="$1"
  log "Applying global OperatorGroup in ${LOKI_OPERATORS_NS}..."
  apply_loki_manifest "operators-namespace.yaml"
  apply_loki_manifest "global-operatorgroup.yaml"
  ensure_operator_subscription "${LOKI_OPERATORS_NS}" "loki-operator" "${channel}"
  wait_for_operator_csv \
    "${LOKI_OPERATORS_NS}" \
    "loki-operator" \
    "Loki Operator" \
    "${OPERATOR_WAIT_TIMEOUT}"
}

install_cluster_logging_operator() {
  local channel="$1"
  log "Applying logging namespace and OperatorGroup in ${LOKI_NS}..."
  apply_loki_manifest "logging-namespace.yaml"
  apply_loki_manifest "cluster-logging-operatorgroup.yaml"
  ensure_operator_subscription "${LOKI_NS}" "cluster-logging" "${channel}"
  wait_for_operator_csv \
    "${LOKI_NS}" \
    "cluster-logging" \
    "Red Hat OpenShift Logging" \
    "${OPERATOR_WAIT_TIMEOUT}"
}

install_minio() {
  local storage_class

  if [[ "${MINIO_USE_PVC}" == "true" ]]; then
    storage_class="${LOKI_STORAGE_CLASS:-$(get_default_storage_class)}"
    [[ -n "${storage_class}" ]] || {
      log "ERROR: Could not determine storageClassName for MinIO PVC"
      return 1
    }
    export LOKI_STORAGE_CLASS="${storage_class}"
    log "Ensuring in-cluster MinIO (${MINIO_NAME}) with PVC (${MINIO_STORAGE_SIZE}, ${storage_class})..."
    apply_loki_manifest "minio-credentials-secret.yaml"
    apply_loki_manifest "minio-pvc.yaml"
    apply_loki_manifest "minio-service.yaml"
    apply_loki_manifest "minio-deployment-pvc.yaml"
  else
    oc delete pvc "${MINIO_NAME}-data" -n "${LOKI_NS}" --ignore-not-found --wait=false
    log "Ensuring in-cluster MinIO (${MINIO_NAME}) with emptyDir (ROSA-compatible)..."
    apply_loki_manifest "minio-credentials-secret.yaml"
    apply_loki_manifest "minio-service.yaml"
    apply_loki_manifest "minio-deployment-emptydir.yaml"
  fi

  log "Waiting for MinIO deployment (timeout ${MINIO_ROLLOUT_TIMEOUT}s)..."
  if ! oc rollout status "deployment/${MINIO_NAME}" -n "${LOKI_NS}" --timeout="${MINIO_ROLLOUT_TIMEOUT}s"; then
    log "ERROR: MinIO rollout failed"
    if [[ "${MINIO_USE_PVC}" == "true" ]]; then
      log "Hint: on ROSA, PVC + restricted-v2 often blocks MinIO — try LOKI_MINIO_USE_PVC=false (emptyDir)"
    fi
    oc describe deployment,rs,pod -n "${LOKI_NS}" -l "app=${MINIO_NAME}" >&2 || true
    oc get events -n "${LOKI_NS}" --field-selector "involvedObject.name=${MINIO_NAME}" 2>/dev/null | tail -15 >&2 || true
    return 1
  fi

  ensure_minio_bucket
}

ensure_minio_bucket() {
  oc delete job "${MINIO_NAME}-create-bucket" -n "${LOKI_NS}" --ignore-not-found
  apply_loki_manifest "minio-create-bucket-job.yaml"

  log "Waiting for MinIO bucket job..."
  if ! timeout 180 oc wait "job/${MINIO_NAME}-create-bucket" -n "${LOKI_NS}" \
    --for=condition=complete --timeout=180s; then
    log "ERROR: MinIO bucket job did not complete"
    oc describe job "${MINIO_NAME}-create-bucket" -n "${LOKI_NS}" >&2 || true
    oc logs -n "${LOKI_NS}" -l "job-name=${MINIO_NAME}-create-bucket" --all-containers >&2 || true
    return 1
  fi
  log "MinIO ready at ${MINIO_ENDPOINT}, bucket=${MINIO_BUCKET}"
}

apply_loki_object_storage_secret() {
  log "Applying Loki object storage secret ${LOKI_SECRET_NAME} (MinIO endpoint=${MINIO_ENDPOINT})..."
  apply_loki_manifest "loki-object-storage-secret.yaml"
}

lokistack_ready() {
  [[ "$(oc get lokistack logging-loki -n "${LOKI_NS}" \
    -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)" \
    == "True" ]]
}

diagnose_lokistack_scheduling() {
  local sample pending_reason
  sample="$(oc get pods -n "${LOKI_NS}" -l app.kubernetes.io/name=lokistack \
    --field-selector=status.phase=Pending -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  [[ -n "${sample}" ]] || return 0

  pending_reason="$(oc describe pod "${sample}" -n "${LOKI_NS}" 2>/dev/null \
    | awk '/Events:/,0' | grep -E 'Insufficient|FailedScheduling' | tail -1 || true)"
  log "WARNING: Loki pods Pending (example: ${sample})"
  [[ -n "${pending_reason}" ]] && log "  ${pending_reason}"
  if [[ "${LOKI_SIZE}" != "1x.demo" ]]; then
    log "Hint: small ROSA clusters often need LOKI_SIZE=1x.demo (default for e2e)"
  else
    log "Hint: free cluster CPU/memory or scale the cluster before re-running e2e"
  fi
}

ensure_lokistack() {
  local storage_class current
  storage_class="${LOKI_STORAGE_CLASS:-$(get_default_storage_class)}"
  [[ -n "${storage_class}" ]] || {
    log "ERROR: Could not determine a storageClassName for LokiStack"
    return 1
  }
  export LOKI_STORAGE_CLASS="${storage_class}"
  export LOKI_EFFECTIVE_DATE="$(date -u +%Y-%m-%d)"

  if oc get lokistack logging-loki -n "${LOKI_NS}" &>/dev/null; then
    current="$(oc get lokistack logging-loki -n "${LOKI_NS}" -o jsonpath='{.spec.size}')"
    if [[ "${current}" != "${LOKI_SIZE}" ]]; then
      if lokistack_ready; then
        log "LokiStack logging-loki Ready at size=${current}; LOKI_SIZE=${LOKI_SIZE} ignored"
      else
        log "LokiStack size=${current} not Ready; patching to ${LOKI_SIZE}..."
        if [[ "${LOKI_SIZE}" == "1x.demo" ]]; then
          oc patch lokistack logging-loki -n "${LOKI_NS}" --type=merge \
            -p "{\"spec\":{\"size\":\"${LOKI_SIZE}\",\"replicationFactor\":1}}" || return 1
        else
          oc patch lokistack logging-loki -n "${LOKI_NS}" --type=merge \
            -p "{\"spec\":{\"size\":\"${LOKI_SIZE}\"}}" || return 1
        fi
      fi
      return 0
    fi
    log "LokiStack logging-loki exists (size=${current})"
    return 0
  fi

  log "Creating LokiStack logging-loki (size=${LOKI_SIZE}, storageClass=${storage_class})..."
  if [[ "${LOKI_SIZE}" == "1x.demo" ]]; then
    apply_loki_manifest "lokistack-demo.yaml"
  else
    apply_loki_manifest "lokistack.yaml"
  fi
}

ensure_collector_service_account() {
  local sa="collector"
  local sa_ref="system:serviceaccount:${LOKI_NS}:${sa}"

  apply_loki_manifest "collector-serviceaccount.yaml"

  for role in \
    collect-application-logs \
    collect-infrastructure-logs \
    logging-collector-logs-writer; do
    if ! oc get clusterrolebinding "${role}" -o jsonpath='{.subjects[?(@.kind=="ServiceAccount")].name}' 2>/dev/null \
      | grep -q "${sa}"; then
      log "Granting ${role} to ${sa_ref}..."
      oc adm policy add-cluster-role-to-user "${role}" "${sa_ref}" || true
    fi
  done
}

loki_gateway_ca_configmap() {
  if oc get configmap logging-loki-gateway-ca-bundle -n "${LOKI_NS}" &>/dev/null; then
    echo "logging-loki-gateway-ca-bundle"
  else
    echo "openshift-service-ca.crt"
  fi
}

wait_for_cluster_log_forwarder_ready() {
  local clf="collector"

  if ! oc get crd clusterlogforwarders.observability.openshift.io &>/dev/null; then
    return 0
  fi
  if ! oc get clusterlogforwarder "${clf}" -n "${LOKI_NS}" &>/dev/null; then
    return 0
  fi

  log "Waiting for ClusterLogForwarder ${clf} to become Ready (timeout ${WAIT_TIMEOUT}s)..."
  if oc wait clusterlogforwarder/"${clf}" -n "${LOKI_NS}" \
    --for=condition=Ready --timeout="${WAIT_TIMEOUT}s"; then
    log "ClusterLogForwarder ${clf} is Ready"
    return 0
  fi

  log "WARNING: ClusterLogForwarder ${clf} Ready condition not reached"
  oc get clusterlogforwarder "${clf}" -n "${LOKI_NS}" -o yaml >&2 || true
  return 0
}

apply_cluster_log_forwarder() {
  if ! oc get crd clusterlogforwarders.observability.openshift.io &>/dev/null; then
    log "ClusterLogForwarder CRD not installed; skipping collector (Loki query API still available)"
    return 0
  fi

  ensure_collector_service_account

  export LOKI_GATEWAY_CA_CONFIGMAP="$(loki_gateway_ca_configmap)"
  log "Applying ClusterLogForwarder collector (Logging 6.x API, tls.ca=${LOKI_GATEWAY_CA_CONFIGMAP})..."
  apply_loki_manifest "cluster-log-forwarder.yaml"
}

wait_for_lokistack_ready() {
  if ! oc get lokistack logging-loki -n "${LOKI_NS}" &>/dev/null; then
    return 0
  fi
  log "Waiting for LokiStack logging-loki to become Ready (timeout ${WAIT_TIMEOUT}s)..."
  if oc wait lokistack/logging-loki -n "${LOKI_NS}" \
    --for=condition=Ready --timeout="${WAIT_TIMEOUT}s"; then
    log "LokiStack logging-loki is Ready"
    return 0
  fi
  diagnose_lokistack_scheduling
  log "WARNING: LokiStack Ready condition not reached; continuing to wait for route"
  oc get lokistack logging-loki -n "${LOKI_NS}" -o yaml >&2 || true
  return 0
}

install_openshift_logging() {
  local channel

  channel="$(resolve_logging_stack_channel)" || return 1

  log "Installing OpenShift Logging (Loki) with in-cluster MinIO..."
  install_loki_operator "${channel}"
  install_cluster_logging_operator "${channel}"
  install_minio
  apply_loki_object_storage_secret
  ensure_lokistack
  wait_for_lokistack_ready
  apply_cluster_log_forwarder
}

loki_stack_installed() {
  oc get lokistack logging-loki -n "${LOKI_NS}" &>/dev/null
}

loki_is_healthy() {
  if loki_stack_installed; then
    lokistack_ready
    return $?
  fi
  return 0
}

recover_lokistack() {
  log "Recovering unhealthy LokiStack in ${LOKI_NS} (target size=${LOKI_SIZE})..."
  apply_loki_object_storage_secret
  ensure_lokistack
  wait_for_lokistack_ready
  apply_cluster_log_forwarder
}

ensure_log_collection() {
  apply_cluster_log_forwarder
  wait_for_cluster_log_forwarder_ready
}

main() {
  local url

  if url="$(loki_url_from_route)" && loki_is_healthy; then
    ensure_log_collection
    print_loki_url "${url}"
    return 0
  fi

  if [[ "${LOKI_DISCOVER_ONLY:-}" =~ ^(1|true|yes)$ ]]; then
    if url="$(loki_url_from_route)"; then
      log "ERROR: Route ${LOKI_ROUTE} exists but LokiStack is not Ready"
    else
      log "ERROR: Route ${LOKI_ROUTE} not found in ${LOKI_NS} (LOKI_DISCOVER_ONLY set)"
    fi
    return 1
  fi

  if url="$(loki_url_from_route)" && loki_stack_installed; then
    log "Route ${LOKI_ROUTE} exists but Loki is not healthy; recovering..."
    recover_lokistack
    ensure_log_collection
    wait_for_loki_route || return 1
    return 0
  fi

  install_openshift_logging
  ensure_log_collection
  wait_for_loki_route
}

main "$@"
