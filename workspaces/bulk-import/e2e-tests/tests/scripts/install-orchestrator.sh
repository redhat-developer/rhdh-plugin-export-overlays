#!/bin/bash
#
# Standalone script to install the orchestrator (Serverless Logic / SonataFlow)
# on OpenShift.
#
# Usage: ./install-orchestrator.sh [namespace]
# Default namespace: orchestrator
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export NAME_SPACE="${1:-${NAME_SPACE:-orchestrator}}"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
if [[ -t 1 ]] && [[ "${TERM:-}" != "dumb" ]]; then
  : "${LOG_NO_COLOR:=false}"
else
  : "${LOG_NO_COLOR:=true}"
fi
: "${LOG_LEVEL:=INFO}"

log::timestamp() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
log::level_value() {
  local level; level="$(echo "$1" | tr '[:lower:]' '[:upper:]')"
  case "${level}" in DEBUG) echo 0 ;; INFO) echo 1 ;; WARN|WARNING) echo 2 ;; ERROR|ERR) echo 3 ;; *) echo 1 ;; esac
}
log::should_log() {
  local requested_level config_level
  requested_level="$(echo "$1" | tr '[:lower:]' '[:upper:]')"
  config_level="$(echo "${LOG_LEVEL}" | tr '[:lower:]' '[:upper:]')"
  [[ "$(log::level_value "${requested_level}")" -ge "$(log::level_value "${config_level}")" ]]
}
log::reset_code() { [[ "${LOG_NO_COLOR}" == "true" ]] && printf '' || printf '\033[0m'; }
log::color_for_level() {
  [[ "${LOG_NO_COLOR}" == "true" ]] && { printf ''; return 0; }
  local level; level="$(echo "$1" | tr '[:lower:]' '[:upper:]')"
  case "${level}" in
    DEBUG) printf '\033[36m' ;; INFO) printf '\033[34m' ;; WARN|WARNING) printf '\033[33m' ;;
    ERROR|ERR) printf '\033[31m' ;; SUCCESS) printf '\033[32m' ;; SECTION) printf '\033[35m\033[1m' ;;
    *) printf '\033[37m' ;;
  esac
}
log::icon_for_level() {
  local level; level="$(echo "$1" | tr '[:lower:]' '[:upper:]')"
  case "${level}" in DEBUG) printf '🐞' ;; INFO) printf 'ℹ' ;; WARN|WARNING) printf '⚠' ;; ERROR|ERR) printf '❌' ;; SUCCESS) printf '✓' ;; *) printf '-' ;; esac
}
log::emit_line() {
  local level="$1" icon="$2" line="$3" color reset timestamp
  log::should_log "${level}" || return 0
  timestamp="$(log::timestamp)"
  color="$(log::color_for_level "${level}")"
  reset="$(log::reset_code)"
  printf '%s[%s] %s %s%s\n' "${color}" "${timestamp}" "${icon}" "${line}" "${reset}" >&2
}
log::emit() {
  local level="$1"; shift
  local icon message; icon="$(log::icon_for_level "${level}")"; message="${*:-}"
  [[ -z "${message}" ]] && return 0
  while IFS= read -r line; do log::emit_line "${level}" "${icon}" "${line}"; done <<< "${message}"
}
log::debug() { log::emit "DEBUG" "$@"; }
log::info() { log::emit "INFO" "$@"; }
log::warn() { log::emit "WARN" "$@"; }
log::error() { log::emit "ERROR" "$@"; }
log::success() { log::emit "SUCCESS" "$@"; }

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
# Escape double quotes for yq string values (yq v4 mikefarah)
escape_yq() { printf '%s' "$1" | sed 's/"/\\"/g'; }

# ---------------------------------------------------------------------------
# Operator subscription and status
# ---------------------------------------------------------------------------
install_subscription() {
  local name=$1 namespace=$2 channel=$3 package=$4 source_name=$5 source_namespace=$6
  oc apply -f - << EOD
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: $name
  namespace: $namespace
spec:
  channel: $channel
  installPlanApproval: Automatic
  name: $package
  source: $source_name
  sourceNamespace: $source_namespace
EOD
}

check_operator_status() {
  local timeout=${1:-300} namespace=$2 operator_name=$3 expected_status=${4:-Succeeded}
  log::info "Checking operator '${operator_name}' in '${namespace}' (timeout ${timeout}s, expected: ${expected_status})"
  timeout "${timeout}" bash -c "
    while true; do
      CURRENT_PHASE=\$(oc get csv -n '${namespace}' -o jsonpath='{.items[?(@.spec.displayName==\"${operator_name}\")].status.phase}')
      echo \"[check_operator_status] Phase: \${CURRENT_PHASE}\" >&2
      [[ \"\${CURRENT_PHASE}\" == \"${expected_status}\" ]] && echo \"[check_operator_status] Operator reached ${expected_status}\" >&2 && break
      sleep 10
    done
  " || { log::error "Operator did not reach ${expected_status} in time."; return 1; }
}

install_serverless_logic_ocp_operator() {
  install_subscription logic-operator-rhel8 openshift-operators alpha logic-operator-rhel8 redhat-operators openshift-marketplace
}
waitfor_serverless_logic_ocp_operator() {
  check_operator_status 500 openshift-operators "OpenShift Serverless Logic Operator (Alpha)" Succeeded
}

install_serverless_ocp_operator() {
  install_subscription serverless-operator openshift-operators stable serverless-operator redhat-operators openshift-marketplace
}
waitfor_serverless_ocp_operator() {
  check_operator_status 300 openshift-operators "Red Hat OpenShift Serverless" Succeeded
}

# ---------------------------------------------------------------------------
# Namespace
# ---------------------------------------------------------------------------
force_delete_namespace() {
  local project=$1 timeout_seconds=${2:-120} elapsed=0 sleep_interval=2
  log::warn "Force deleting namespace ${project}"
  oc get namespace "$project" -o json | jq '.spec = {"finalizers":[]}' | oc replace --raw "/api/v1/namespaces/$project/finalize" -f -
  while oc get namespace "$project" &>/dev/null; do
    [[ $elapsed -ge $timeout_seconds ]] && { log::warn "Timeout deleting ${project}"; return 1; }
    sleep $sleep_interval
    elapsed=$((elapsed + sleep_interval))
  done
  log::success "Namespace '${project}' deleted."
}

delete_namespace() {
  local project=$1
  if oc get namespace "$project" &>/dev/null; then
    log::warn "Deleting namespace ${project}..."
    oc delete namespace "$project" --grace-period=0 --force || true
    if oc get namespace "$project" -o jsonpath='{.status.phase}' 2>/dev/null | grep -q Terminating; then
      force_delete_namespace "$project"
    fi
  fi
}

configure_namespace() {
  local project=$1
  log::warn "Recreating namespace: $project"
  delete_namespace "$project"
  oc create namespace "${project}" || { log::error "Failed to create namespace ${project}"; exit 1; }
  oc config set-context --current --namespace="${project}" || { log::error "Failed to set context"; exit 1; }
  log::info "Namespace ${project} is ready."
}

# ---------------------------------------------------------------------------
# Deployment wait
# ---------------------------------------------------------------------------
wait_for_deployment() {
  local namespace=$1 resource_name=$2 timeout_minutes=${3:-5} check_interval=${4:-10}
  [[ -z "$namespace" || -z "$resource_name" ]] && { log::error "wait_for_deployment: namespace and resource_name required"; return 1; }
  local max_attempts=$((timeout_minutes * 60 / check_interval))
  log::info "Waiting for '$resource_name' in '$namespace' (timeout ${timeout_minutes}m)..."
  for ((i = 1; i <= max_attempts; i++)); do
    local pod_name
    pod_name=$(oc get pods -n "$namespace" 2>/dev/null | grep "$resource_name" | awk '{print $1}' | head -n 1)
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
# PostgreSQL (simple deployment for orchestrator)
# ---------------------------------------------------------------------------
create_simple_postgres_deployment() {
  local namespace=$1 postgres_name="backstage-psql"
  if oc get deployment "$postgres_name" -n "$namespace" &>/dev/null; then
    log::info "PostgreSQL '$postgres_name' already exists"
    return 0
  fi
  log::info "Creating PostgreSQL '$postgres_name' in '$namespace'"
  oc create secret generic "${postgres_name}-secret" -n "$namespace" \
    --from-literal=POSTGRESQL_USER=postgres \
    --from-literal=POSTGRESQL_PASSWORD=postgres \
    --from-literal=POSTGRESQL_DATABASE=postgres \
    --from-literal=POSTGRES_USER=postgres \
    --from-literal=POSTGRES_PASSWORD=postgres \
    --from-literal=POSTGRES_DB=postgres \
    --dry-run=client -o yaml | oc apply -f - -n "$namespace" || true

  oc apply -f - -n "$namespace" << EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${postgres_name}-pvc
  namespace: ${namespace}
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 1Gi } }
EOF

  oc apply -f - -n "$namespace" << EOF
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
          valueFrom: { secretKeyRef: { name: ${postgres_name}-secret, key: POSTGRESQL_USER } }
        - name: POSTGRESQL_PASSWORD
          valueFrom: { secretKeyRef: { name: ${postgres_name}-secret, key: POSTGRESQL_PASSWORD } }
        - name: POSTGRESQL_DATABASE
          valueFrom: { secretKeyRef: { name: ${postgres_name}-secret, key: POSTGRESQL_DATABASE } }
        ports: [ { containerPort: 5432, name: postgres } ]
        volumeMounts: [ { name: postgres-data, mountPath: /var/lib/pgsql/data } ]
        livenessProbe:
          exec: { command: [ /usr/libexec/check-container, --live ] }
          initialDelaySeconds: 120
          periodSeconds: 10
        readinessProbe:
          exec: { command: [ /usr/libexec/check-container ] }
          initialDelaySeconds: 5
          periodSeconds: 10
      volumes: [ { name: postgres-data, persistentVolumeClaim: { claimName: ${postgres_name}-pvc } } ]
EOF

  oc apply -f - -n "$namespace" << EOF
apiVersion: v1
kind: Service
metadata:
  name: ${postgres_name}
  namespace: ${namespace}
spec:
  selector: { app: ${postgres_name} }
  ports: [ { name: postgres, port: 5432, targetPort: 5432 } ]
  type: ClusterIP
EOF

  log::info "Waiting for PostgreSQL StatefulSet..."
  oc wait statefulset "$postgres_name" -n "$namespace" --for=jsonpath='{.status.readyReplicas}'=1 --timeout=300s || true
  sleep 5
  oc exec -n "$namespace" statefulset/"$postgres_name" -- psql -U postgres -c "CREATE DATABASE backstage_plugin_orchestrator;" 2>/dev/null || log::warn "Orchestrator DB may already exist"
  log::success "PostgreSQL deployment created."
}

# ---------------------------------------------------------------------------
# SonataFlow platform
# ---------------------------------------------------------------------------
create_sonataflow_platform() {
  local namespace=$1 postgres_secret_name=$2 postgres_service_name=$3
  if ! oc get crd sonataflowplatforms.sonataflow.org &>/dev/null && ! oc get crd sonataflowplatform.sonataflow.org &>/dev/null; then
    log::error "SonataFlowPlatform CRD not found. Install Serverless Logic Operator first."
    return 1
  fi
  if oc get sonataflowplatform sonataflow-platform -n "$namespace" &>/dev/null || oc get sfp sonataflow-platform -n "$namespace" &>/dev/null; then
    log::info "SonataFlowPlatform already exists"
    return 0
  fi
  log::info "Creating SonataFlowPlatform in '$namespace'"
  oc apply -f - -n "$namespace" << EOF
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
          secretRef: { name: ${postgres_secret_name}, userKey: POSTGRES_USER, passwordKey: POSTGRES_PASSWORD }
          serviceRef: { name: ${postgres_service_name}, namespace: ${namespace}, port: 5432, databaseName: backstage_plugin_orchestrator }
    jobService:
      persistence:
        postgresql:
          secretRef: { name: ${postgres_secret_name}, userKey: POSTGRES_USER, passwordKey: POSTGRES_PASSWORD }
          serviceRef: { name: ${postgres_service_name}, namespace: ${namespace}, port: 5432, databaseName: backstage_plugin_orchestrator }
EOF
  local attempt=0 max_attempts=60
  while [ $attempt -lt $max_attempts ]; do
    if oc get deployment sonataflow-platform-data-index-service -n "$namespace" &>/dev/null && \
       oc get deployment sonataflow-platform-jobs-service -n "$namespace" &>/dev/null; then
      log::success "SonataFlowPlatform services created"
      wait_for_deployment "$namespace" sonataflow-platform-data-index-service 20 || true
      wait_for_deployment "$namespace" sonataflow-platform-jobs-service 20 || true
      log::success "SonataFlowPlatform ready."
      return 0
    fi
    attempt=$((attempt + 1))
    [ $((attempt % 10)) -eq 0 ] && log::info "Waiting for SonataFlowPlatform... ($attempt/$max_attempts)"
    sleep 5
  done
  log::warn "SonataFlowPlatform services did not appear in time."
}

# ---------------------------------------------------------------------------
# Orchestrator connection info
# ---------------------------------------------------------------------------
print_orchestrator_connection_info() {
  local namespace=$1
  local data_index_service="sonataflow-platform-data-index-service"
  local service_url="http://${data_index_service}.${namespace}.svc.cluster.local"
  log::info "=========================================="
  log::info "Orchestrator Plugin Connection Information"
  log::info "=========================================="
  log::info "Namespace: ${namespace}"
  log::info "Internal URL for Orchestrator Backend Plugin: ${service_url}"
  log::info "dynamic-plugins.yaml: pluginConfig.orchestrator.dataIndexService.url: ${service_url}"
  if oc get svc "${data_index_service}" -n "${namespace}" &>/dev/null; then
    local port; port=$(oc get svc "${data_index_service}" -n "${namespace}" -o jsonpath='{.spec.ports[0].port}' 2>/dev/null || echo "8080")
    log::info "Service: ${data_index_service}, port: ${port}"
  else
    log::warn "Service '${data_index_service}' not found yet."
  fi
  log::info "=========================================="
}

# ---------------------------------------------------------------------------
# Wait for SonataFlow CRDs
# ---------------------------------------------------------------------------
wait_for_sonataflow_crds() {
  log::info "Waiting for SonataFlow CRDs..."
  local attempt=0 max_attempts=60
  while [ $attempt -lt $max_attempts ]; do
    if oc get crd sonataflows.sonataflow.org &>/dev/null; then
      log::success "SonataFlow CRD is available."
      return 0
    fi
    attempt=$((attempt + 1))
    [ $((attempt % 6)) -eq 0 ] && log::info "Waiting for sonataflows.sonataflow.org... ($attempt/$max_attempts)"
    sleep 5
  done
  log::error "Timed out waiting for SonataFlow CRD."
  return 1
}

# ---------------------------------------------------------------------------
# Deploy orchestrator workflows (operator path: git clone + helm greeting)
# Uses local yaml/ if present, otherwise clones repo.
# ---------------------------------------------------------------------------
deploy_orchestrator_workflows_operator() {
  local namespace=$1
  local WORKFLOW_REPO="https://github.com/AndrienkoAleksandr/serverless-workflows.git"
  local WORKFLOW_DIR="/tmp/serverless-workflows"
  local LOCAL_MANIFESTS="${SCRIPT_DIR}/yaml"

  # PostgreSQL
  if ! oc get statefulset backstage-psql -n "$namespace" &>/dev/null && ! oc get deployment backstage-psql -n "$namespace" &>/dev/null; then
    log::info "Creating simple PostgreSQL deployment..."
    create_simple_postgres_deployment "$namespace"
  else
    log::info "PostgreSQL found, waiting for ready..."
    if oc get statefulset backstage-psql -n "$namespace" &>/dev/null; then
      oc wait statefulset backstage-psql -n "$namespace" --for=jsonpath='{.status.readyReplicas}'=1 --timeout=300s || true
    else
      wait_for_deployment "$namespace" backstage-psql 15 || true
    fi
  fi

  local pqsl_secret_name pqsl_svc_name pqsl_user_key pqsl_password_key sonataflow_db
  pqsl_secret_name=$(oc get secrets -n "$namespace" -o name 2>/dev/null | grep "backstage-psql" | grep "secret" | head -1 | sed 's|secret\/||')
  pqsl_svc_name=$(oc get svc -n "$namespace" -o name 2>/dev/null | grep "backstage-psql" | grep -v secret | head -1 | sed 's|service\/||')
  pqsl_secret_name="${pqsl_secret_name:-backstage-psql-secret}"
  pqsl_svc_name="${pqsl_svc_name:-backstage-psql}"
  pqsl_user_key="POSTGRES_USER"
  pqsl_password_key="POSTGRES_PASSWORD"
  sonataflow_db="backstage_plugin_orchestrator"
  log::info "PostgreSQL secret: $pqsl_secret_name, service: $pqsl_svc_name"

  if ! oc get sonataflowplatform sonataflow-platform -n "$namespace" &>/dev/null && ! oc get sfp sonataflow-platform -n "$namespace" &>/dev/null; then
    create_sonataflow_platform "$namespace" "$pqsl_secret_name" "$pqsl_svc_name"
  else
    log::info "SonataFlowPlatform already exists"
    wait_for_deployment "$namespace" sonataflow-platform-data-index-service 20 || true
    wait_for_deployment "$namespace" sonataflow-platform-jobs-service 20 || true
  fi

  if ! oc get crd sonataflows.sonataflow.org &>/dev/null; then
    log::error "SonataFlow CRD not found."
    return 1
  fi

  # Wait for 2 SonataFlow resources
  timeout 30s bash -c "
    until [[ \$(oc get sf -n $namespace --no-headers 2>/dev/null | wc -l) -ge 2 ]]; do
      echo \"Waiting for sf resources... \$(oc get sf -n $namespace --no-headers 2>/dev/null | wc -l)\"
      sleep 5
    done
  " || true


  # Prefer local yaml/ if it exists and has content
  if [[ -d "${LOCAL_MANIFESTS}" ]] && [[ -n "$(ls -A "${LOCAL_MANIFESTS}" 2>/dev/null)" ]]; then
    log::info "Using local workflow manifests from ${LOCAL_MANIFESTS}"
    # Apply all YAMLs in yaml/ with correct namespace
    for f in "${LOCAL_MANIFESTS}"/*.yaml "${LOCAL_MANIFESTS}"/*.yml; do
      [[ -e "$f" ]] && oc apply -f "$f" -n "$namespace" && log::info "Applied $(basename "$f")"
    done
  else
    log::info "Cloning workflow repo..."
    rm -rf "${WORKFLOW_DIR}"
    git clone --single-branch --branch bulk-import-workflow-sample  "${WORKFLOW_REPO}" "${WORKFLOW_DIR}"
    local WORKFLOW_MANIFESTS="${WORKFLOW_DIR}/workflows/experimentals/bulk-import-git-repos/manifests"
    if [[ -d "${WORKFLOW_MANIFESTS}" ]]; then
      log::info "Applying workflow manifests from repo..."

      snToDbPatch="${WORKFLOW_MANIFESTS}/04-sonataflow_universal-pr.yaml"
      yq eval -i '.spec.persistence.postgresql.secretRef.name = "'"$(escape_yq "$pqsl_secret_name")"'"' "$snToDbPatch"
      yq eval -i '.spec.persistence.postgresql.secretRef.userKey = "'"$(escape_yq "$pqsl_user_key")"'"' "$snToDbPatch"
      yq eval -i '.spec.persistence.postgresql.secretRef.passwordKey = "'"$(escape_yq "$pqsl_password_key")"'"' "$snToDbPatch"
      yq eval -i '.spec.persistence.postgresql.serviceRef.name = "'"$(escape_yq "$pqsl_svc_name")"'"' "$snToDbPatch"
      yq eval -i '.spec.persistence.postgresql.serviceRef.namespace = "'"$(escape_yq "$namespace")"'"' "$snToDbPatch"
      yq eval -i '.spec.persistence.postgresql.serviceRef.databaseName = "'"$(escape_yq "$sonataflow_db")"'"' "$snToDbPatch"

      oc apply -f "${WORKFLOW_MANIFESTS}" -n "$namespace"
    else
      log::warn "Manifests path not found in repo: ${WORKFLOW_MANIFESTS}"
    fi
  fi

  wait_for_deployment "$namespace" universal-pr 5 || true
  log::info "Orchestrator workflows deployment done."
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  log::info "Starting orchestrator deployment for namespace: ${NAME_SPACE}"

  if ! oc whoami &>/dev/null && ! kubectl cluster-info &>/dev/null; then
    log::error "Not logged into OpenShift/Kubernetes cluster"
    return 1
  fi

  log::info "Checking Serverless operators..."
  if ! oc get subscription serverless-operator -n openshift-operators &>/dev/null; then
    log::info "Installing OpenShift Serverless Operator..."
    install_serverless_ocp_operator
  else
    log::info "OpenShift Serverless Operator already installed"
  fi

  if ! oc get subscription logic-operator-rhel8 -n openshift-operators &>/dev/null; then
    log::info "Installing OpenShift Serverless Logic Operator..."
    install_serverless_logic_ocp_operator
  else
    log::info "OpenShift Serverless Logic Operator already installed"
  fi

  log::info "Waiting for operators to be ready..."
  waitfor_serverless_ocp_operator
  waitfor_serverless_logic_ocp_operator
  wait_for_sonataflow_crds

  configure_namespace "${NAME_SPACE}"
  log::info "Deploying orchestrator workflows..."
  deploy_orchestrator_workflows_operator "${NAME_SPACE}"
  print_orchestrator_connection_info "${NAME_SPACE}"

  log::success "Orchestrator deployment completed successfully!"
}

main "$@"
