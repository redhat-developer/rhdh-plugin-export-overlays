#!/usr/bin/env bash
#
# Deploy the SonataFlow platform and orchestrator workflows for E2E tests.
# Called from test.beforeAll after rhdh.configure() creates the namespace.
#
# Usage: deploy-sonataflow.sh <namespace>
#

set -e

NAMESPACE="${1:?Usage: $0 <namespace>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

WORKFLOW_REPO="https://github.com/rhdhorchestrator/serverless-workflows.git"
WORKFLOW_DIR="/tmp/serverless-workflows-$$"

LOWER_CASE_CLASS='[:lower:]'
UPPER_CASE_CLASS='[:upper:]'

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
if [[ -t 1 ]] && [[ "${TERM:-}" != "dumb" ]]; then
  : "${LOG_NO_COLOR:=false}"
else
  : "${LOG_NO_COLOR:=true}"
fi
: "${LOG_LEVEL:=INFO}"

log::timestamp() {
  echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
}
log::level_value() {
  local level
  level="$(echo "$1" | tr "$LOWER_CASE_CLASS" "$UPPER_CASE_CLASS")"
  case "${level}" in DEBUG) echo 0 ;; INFO) echo 1 ;; WARN|WARNING) echo 2 ;; ERROR|ERR) echo 3 ;; *) echo 1 ;; esac
}
log::should_log() {
  local requested config
  requested="$(echo "$1" | tr "$LOWER_CASE_CLASS" "$UPPER_CASE_CLASS")"
  config="$(echo "${LOG_LEVEL}" | tr "$LOWER_CASE_CLASS" "$UPPER_CASE_CLASS")"
  [[ "$(log::level_value "${requested}")" -ge "$(log::level_value "${config}")" ]]
}
log::reset_code() {
  [[ "${LOG_NO_COLOR}" == "true" ]] && printf '' || printf '\033[0m'
}
log::color_for_level() {
  [[ "${LOG_NO_COLOR}" == "true" ]] && { printf ''; return 0; }
  local level
  level="$(echo "$1" | tr "$LOWER_CASE_CLASS" "$UPPER_CASE_CLASS")"
  case "${level}" in
    DEBUG) printf '\033[36m' ;; INFO) printf '\033[34m' ;; WARN|WARNING) printf '\033[33m' ;;
    ERROR|ERR) printf '\033[31m' ;; SUCCESS) printf '\033[32m' ;; *) printf '\033[37m' ;;
  esac
}
log::icon_for_level() {
  local level
  level="$(echo "$1" | tr "$LOWER_CASE_CLASS" "$UPPER_CASE_CLASS")"
  case "${level}" in DEBUG) printf '🐞' ;; INFO) printf 'ℹ' ;; WARN|WARNING) printf '⚠' ;; ERROR|ERR) printf '❌' ;; SUCCESS) printf '✓' ;; *) printf '-' ;; esac
}
log::emit() {
  local level="$1"; shift
  log::should_log "${level}" || return 0
  local icon color reset timestamp
  icon="$(log::icon_for_level "${level}")"
  color="$(log::color_for_level "${level}")"
  reset="$(log::reset_code)"
  timestamp="$(log::timestamp)"
  local message="${*:-}"
  [[ -z "${message}" ]] && return 0
  while IFS= read -r line; do
    printf '%s[%s] %s %s%s\n' "${color}" "${timestamp}" "${icon}" "${line}" "${reset}" >&2
  done <<< "${message}"
}
log::info()    { log::emit "INFO" "$@"; }
log::warn()    { log::emit "WARN" "$@"; }
log::error()   { log::emit "ERROR" "$@"; }
log::success() { log::emit "SUCCESS" "$@"; }

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------
cleanup() {
  rm -rf "${WORKFLOW_DIR}"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Operator installation via orchestrator-infra Helm chart
# ---------------------------------------------------------------------------
install_operators_via_helm() {
  local namespace=$1
  local chart_version="${ORCHESTRATOR_INFRA_CHART_VERSION:-}"

  if [[ -z "$chart_version" ]]; then
    log::info "Resolving latest orchestrator-infra chart version from quay.io..."
    chart_version=$(curl -s "https://quay.io/api/v1/repository/rhdh/orchestrator-infra-chart/tag/?onlyActiveTags=true&limit=100" \
      | jq -r '.tags[].name' | sort -V | tail -n 1)
    if [[ -z "$chart_version" || "$chart_version" == "null" ]]; then
      log::error "Could not resolve orchestrator-infra chart version"
      return 1
    fi
  fi

  log::info "Installing orchestrator-infra chart (version: ${chart_version})..."

  local helm_args=(
    --version "$chart_version"
    --namespace "$namespace"
    --wait --timeout=10m
    --set serverlessLogicOperator.subscription.spec.installPlanApproval=Automatic
    --set serverlessOperator.subscription.spec.installPlanApproval=Automatic
  )

  if [[ -n "${OSL_CATALOG_SOURCE:-}" ]]; then
    log::info "Using custom CatalogSource: ${OSL_CATALOG_SOURCE}"
    helm_args+=(
      --set "serverlessLogicOperator.subscription.spec.source=${OSL_CATALOG_SOURCE}"
      --set "serverlessOperator.subscription.spec.source=${OSL_CATALOG_SOURCE}"
    )
  fi

  if [[ -n "${OSL_LOGIC_CHANNEL:-}" ]]; then
    helm_args+=(--set "serverlessLogicOperator.subscription.spec.channel=${OSL_LOGIC_CHANNEL}")
  fi
  if [[ -n "${OSL_LOGIC_PACKAGE:-}" ]]; then
    helm_args+=(--set "serverlessLogicOperator.subscription.spec.name=${OSL_LOGIC_PACKAGE}")
  fi
  if [[ -n "${OSL_LOGIC_CSV:-}" ]]; then
    helm_args+=(--set "serverlessLogicOperator.subscription.spec.startingCSV=${OSL_LOGIC_CSV}")
  fi

  oc create namespace "$namespace" 2>/dev/null || true

  helm upgrade --install orchestrator-infra \
    oci://quay.io/rhdh/orchestrator-infra-chart "${helm_args[@]}"

  log::success "Orchestrator infrastructure chart installed."
}

wait_for_sonataflow_crds() {
  log::info "Waiting for SonataFlow CRDs..."
  local attempt=0 max_attempts=60
  while [[ $attempt -lt $max_attempts ]]; do
    if oc get crd sonataflows.sonataflow.org &>/dev/null; then
      log::success "SonataFlow CRDs are available."
      return 0
    fi
    attempt=$((attempt + 1))
    [[ $((attempt % 6)) -eq 0 ]] && log::info "Waiting for sonataflows.sonataflow.org... ($attempt/$max_attempts)"
    sleep 5
  done
  log::error "Timed out waiting for SonataFlow CRDs."
  return 1
}

# ---------------------------------------------------------------------------
# Deployment wait (pod-level ready check)
# ---------------------------------------------------------------------------
wait_for_deployment() {
  local namespace=$1 resource_name=$2 timeout_minutes=${3:-5} check_interval=${4:-10}
  [[ -z "$namespace" || -z "$resource_name" ]] && { log::error "wait_for_deployment: namespace and resource_name required"; return 1; }
  local max_attempts=$((timeout_minutes * 60 / check_interval))
  log::info "Waiting for '$resource_name' in '$namespace' (timeout ${timeout_minutes}m)..."
  for ((i = 1; i <= max_attempts; i++)); do
    local pod_name
    pod_name=$(oc get pods -n "$namespace" 2>/dev/null | grep "$resource_name" | grep -v "\-build" | awk '{print $1}' | head -n 1)
    if [[ -n "$pod_name" ]]; then
      local is_ready
      is_ready=$(oc get pod "$pod_name" -n "$namespace" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)
      if [[ "$is_ready" == "True" ]] && oc get pod "$pod_name" -n "$namespace" 2>/dev/null | grep -q Running; then
        log::success "Pod '$pod_name' is ready"
        return 0
      fi
    fi
    sleep "$check_interval"
  done
  log::error "Timeout waiting for $resource_name"
  return 1
}

# ---------------------------------------------------------------------------
# SonataFlow workflow wait (checks CR conditions + build progress)
# ---------------------------------------------------------------------------
wait_for_workflow() {
  local namespace=$1 workflow_name=$2 timeout_minutes=${3:-15}
  local check_interval=15
  local max_attempts=$((timeout_minutes * 60 / check_interval))
  local config_error_seen=false

  log::info "Waiting for workflow '$workflow_name' (timeout ${timeout_minutes}m)..."

  for ((i = 1; i <= max_attempts; i++)); do
    local running
    running=$(oc get sonataflow "$workflow_name" -n "$namespace" \
      -o jsonpath='{.status.conditions[?(@.type=="Running")].status}' 2>/dev/null)

    if [[ "$running" == "True" ]]; then
      log::success "Workflow '$workflow_name' is running"
      return 0
    fi

    local pod_status
    pod_status=$(oc get pods -n "$namespace" --no-headers 2>/dev/null \
      | grep "$workflow_name" | grep -v "\-build" | head -n 1 || true)

    if [[ -n "$pod_status" ]] && [[ "$config_error_seen" == "false" ]]; then
      if echo "$pod_status" | grep -qE "CreateContainerConfigError|InvalidImageName|ErrImagePull|ImagePullBackOff"; then
        config_error_seen=true
        local pod_name
        pod_name=$(echo "$pod_status" | awk '{print $1}')
        log::error "Pod '$pod_name' has a config/image error:"
        log::info "  $pod_status"
        log::info "Pod events:"
        oc get events -n "$namespace" --field-selector "involvedObject.name=${pod_name}" \
          --sort-by='.lastTimestamp' 2>/dev/null | tail -10 >&2 || true
        log::info "Container status:"
        oc get pod "$pod_name" -n "$namespace" \
          -o jsonpath='{range .status.containerStatuses[*]}  {.name}: {.state}{"\n"}{end}' 2>/dev/null >&2 || true
      fi
    fi

    if [[ $((i % 4)) -eq 0 ]]; then
      local sf_line
      sf_line=$(oc get sonataflow "$workflow_name" -n "$namespace" --no-headers 2>/dev/null)
      log::info "  sonataflow/$workflow_name: $sf_line"
      [[ -n "$pod_status" ]] && log::info "  pods: $pod_status"
    fi

    sleep "$check_interval"
  done

  log::error "Timeout waiting for workflow '$workflow_name'"
  log::info "Diagnostic dump:"
  oc get sonataflow "$workflow_name" -n "$namespace" -o jsonpath='{.status}' 2>/dev/null | jq . 2>/dev/null >&2 || true
  oc get pods -n "$namespace" --no-headers 2>/dev/null | grep "$workflow_name" >&2 || true
  return 1
}

# ---------------------------------------------------------------------------
# PostgreSQL
# ---------------------------------------------------------------------------
create_simple_postgres_deployment() {
  local namespace=$1 postgres_name="sonataflow-psql-postgresql"
  if oc get statefulset "$postgres_name" -n "$namespace" &>/dev/null; then
    log::info "PostgreSQL '$postgres_name' already exists"
    return 0
  fi
  log::info "Creating PostgreSQL '$postgres_name' in '$namespace'"

  oc create secret generic "${postgres_name}" -n "$namespace" \
    --from-literal=POSTGRESQL_USER=postgres \
    --from-literal=POSTGRESQL_PASSWORD=postgres \
    --from-literal=POSTGRESQL_DATABASE=postgres \
    --from-literal=POSTGRES_USER=postgres \
    --from-literal=POSTGRES_PASSWORD=postgres \
    --from-literal=POSTGRES_DB=postgres \
    --from-literal=username=postgres \
    --from-literal=password=postgres \
    --from-literal=postgres-username=postgres \
    --from-literal=postgres-password=postgres \
    --dry-run=client -o yaml | oc apply -f - -n "$namespace" || true

  oc apply -f - -n "$namespace" <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${postgres_name}-pvc
  namespace: ${namespace}
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 1Gi } }
EOF

  oc apply -f - -n "$namespace" <<EOF
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ${postgres_name}
  namespace: ${namespace}
spec:
  serviceName: ${postgres_name}
  replicas: 1
  selector: { matchLabels: { app: ${postgres_name} } }
  template:
    metadata: { labels: { app: ${postgres_name} } }
    spec:
      containers:
      - name: postgres
        image: registry.redhat.io/rhel9/postgresql-15:latest
        env:
        - name: POSTGRESQL_USER
          valueFrom: { secretKeyRef: { name: ${postgres_name}, key: POSTGRESQL_USER } }
        - name: POSTGRESQL_PASSWORD
          valueFrom: { secretKeyRef: { name: ${postgres_name}, key: POSTGRESQL_PASSWORD } }
        - name: POSTGRESQL_DATABASE
          valueFrom: { secretKeyRef: { name: ${postgres_name}, key: POSTGRESQL_DATABASE } }
        ports: [{ containerPort: 5432, name: postgres }]
        volumeMounts: [{ name: postgres-data, mountPath: /var/lib/pgsql/data }]
        livenessProbe:
          exec: { command: [/usr/libexec/check-container, --live] }
          initialDelaySeconds: 120
          periodSeconds: 10
        readinessProbe:
          exec: { command: [/usr/libexec/check-container] }
          initialDelaySeconds: 5
          periodSeconds: 10
      volumes: [{ name: postgres-data, persistentVolumeClaim: { claimName: ${postgres_name}-pvc } }]
EOF

  oc apply -f - -n "$namespace" <<EOF
apiVersion: v1
kind: Service
metadata:
  name: ${postgres_name}
  namespace: ${namespace}
spec:
  selector: { app: ${postgres_name} }
  ports: [{ name: postgres, port: 5432, targetPort: 5432 }]
  type: ClusterIP
EOF

  log::info "Waiting for PostgreSQL pod to be ready..."
  oc wait pod -l "app=${postgres_name}" -n "$namespace" \
    --for=condition=Ready --timeout=300s \
    || { log::error "PostgreSQL pod did not become ready"; return 1; }

  log::info "Creating orchestrator database..."
  oc exec -n "$namespace" "statefulset/${postgres_name}" -- \
    psql -U postgres -c "CREATE DATABASE sonataflow;" 2>/dev/null \
    || log::warn "sonataflow DB may already exist"
  log::success "PostgreSQL deployment created."
}

# ---------------------------------------------------------------------------
# SonataFlow platform
# ---------------------------------------------------------------------------
create_sonataflow_platform() {
  local namespace=$1 postgres_secret_name=$2 postgres_service_name=$3

  if oc get sonataflowplatform sonataflow-platform -n "$namespace" &>/dev/null \
     || oc get sfp sonataflow-platform -n "$namespace" &>/dev/null; then
    log::info "SonataFlowPlatform already exists"
    return 0
  fi

  log::info "Creating SonataFlowPlatform in '$namespace'"
  oc apply -f - -n "$namespace" <<EOF
apiVersion: sonataflow.org/v1alpha08
kind: SonataFlowPlatform
metadata:
  name: sonataflow-platform
  namespace: ${namespace}
spec:
  services:
    dataIndex:
      persistence:
        postgresql:
          secretRef: { name: ${postgres_secret_name}, userKey: username, passwordKey: password }
          serviceRef: { name: ${postgres_service_name}, namespace: ${namespace}, port: 5432, databaseName: sonataflow }
    jobService:
      persistence:
        postgresql:
          secretRef: { name: ${postgres_secret_name}, userKey: username, passwordKey: password }
          serviceRef: { name: ${postgres_service_name}, namespace: ${namespace}, port: 5432, databaseName: sonataflow }
EOF

  local attempt=0 max_attempts=60
  while [[ $attempt -lt $max_attempts ]]; do
    if oc get deployment sonataflow-platform-data-index-service -n "$namespace" &>/dev/null \
       && oc get deployment sonataflow-platform-jobs-service -n "$namespace" &>/dev/null; then
      log::success "SonataFlowPlatform services created"
      wait_for_deployment "$namespace" sonataflow-platform-data-index-service 20 || true
      wait_for_deployment "$namespace" sonataflow-platform-jobs-service 20 || true
      log::success "SonataFlowPlatform ready."
      return 0
    fi
    attempt=$((attempt + 1))
    [[ $((attempt % 10)) -eq 0 ]] && log::info "Waiting for SonataFlowPlatform... ($attempt/$max_attempts)"
    sleep 5
  done
  log::warn "SonataFlowPlatform services did not appear in time."
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
log::info "Starting SonataFlow deployment for namespace: ${NAMESPACE}"

if ! oc whoami &>/dev/null && ! kubectl cluster-info &>/dev/null; then
  log::error "Not logged into OpenShift/Kubernetes cluster"
  exit 1
fi

# -- Step 1: Ensure Serverless operators are installed --
if oc get crd sonataflows.sonataflow.org &>/dev/null \
   && oc get crd sonataflowplatforms.sonataflow.org &>/dev/null; then
  log::info "SonataFlow CRDs already present, skipping operator installation"
else
  install_operators_via_helm "${NAMESPACE}"
  wait_for_sonataflow_crds
fi

# -- Step 2: Deploy PostgreSQL --
POSTGRES_NAME="sonataflow-psql-postgresql"
POSTGRES_SECRET="${POSTGRES_NAME}"
POSTGRES_SERVICE="${POSTGRES_NAME}"

if ! oc get statefulset "${POSTGRES_NAME}" -n "${NAMESPACE}" &>/dev/null; then
  create_simple_postgres_deployment "${NAMESPACE}"
else
  log::info "PostgreSQL already exists, waiting for ready..."
  oc wait pod -l "app=${POSTGRES_NAME}" -n "${NAMESPACE}" \
    --for=condition=Ready --timeout=300s || true
fi

# -- Step 3: Create SonataFlowPlatform with persistence --
create_sonataflow_platform "${NAMESPACE}" "${POSTGRES_SECRET}" "${POSTGRES_SERVICE}"

# -- Step 4: Clone and apply workflow manifests --
log::info "Cloning serverless-workflows repository..."
git clone --depth=1 "${WORKFLOW_REPO}" "${WORKFLOW_DIR}"

GREETING_MANIFESTS="${WORKFLOW_DIR}/workflows/greeting/manifests/"
FAILSWITCH_MANIFESTS="${WORKFLOW_DIR}/workflows/fail-switch/src/main/resources/manifests/"

log::info "Applying greeting workflow manifests..."
oc apply -n "${NAMESPACE}" -f "${GREETING_MANIFESTS}"

log::info "Applying failswitch workflow manifests..."
oc apply -n "${NAMESPACE}" -f "${FAILSWITCH_MANIFESTS}"

# -- Step 5: Wait for SonataFlow workflow resources --
log::info "Waiting for SonataFlow workflow resources..."
timeout 60s bash -c "
  until [[ \$(oc get sonataflow -n ${NAMESPACE} --no-headers 2>/dev/null | wc -l) -ge 2 ]]; do
    echo 'Waiting for greeting and failswitch SonataFlow resources...'
    sleep 5
  done
" || log::warn "Timeout waiting for SonataFlow resources, continuing..."

# -- Step 6: Wait for workflows to be running --
log::info "Waiting for workflows to reach Running state..."
wait_for_workflow "${NAMESPACE}" greeting 15 || true
wait_for_workflow "${NAMESPACE}" failswitch 15 || true

log::success "SonataFlow platform setup complete in namespace ${NAMESPACE}"
