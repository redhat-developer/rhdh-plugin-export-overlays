#!/usr/bin/env bash
#
# Discover or install OpenShift cluster logging (Loki) for orchestrator-backend-module-loki.
# Object storage uses in-cluster MinIO (S3-compatible). Prints the Loki base URL on stdout.
#
# Discovery (when logging-loki route already exists):
#   https://$LOKI_HOST/api/logs/v1/application/
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
#   LOKI_MINIO_MC_IMAGE            MinIO client image for bucket bootstrap
#   LOKI_MINIO_USE_PVC            Use PVC for MinIO data (default: false = emptyDir, ROSA-friendly)
#   LOKI_MINIO_ROLLOUT_TIMEOUT    MinIO deployment wait (default: 600)
#   LOKI_DISCOVER_ONLY          If true/1, skip install and fail when route is missing
#
set -euo pipefail

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

log() {
  echo "[install-orchestrator-loki] $*" >&2
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
  local elapsed=0 interval=15 url
  while [[ "${elapsed}" -lt "${WAIT_TIMEOUT}" ]]; do
    if url="$(loki_url_from_route)"; then
      print_loki_url "${url}"
      return 0
    fi
    sleep "${interval}"
    elapsed=$((elapsed + interval))
    log "Waiting for route ${LOKI_ROUTE} in ${LOKI_NS} (${elapsed}s/${WAIT_TIMEOUT}s)..."
  done
  return 1
}

wait_for_operator_csv() {
  local namespace="$1"
  local package_name="$2"
  local display_name="$3"
  local timeout="$4"
  log "Waiting for operator CSV '${display_name}' (${package_name}) in ${namespace} (timeout ${timeout}s)..."
  timeout "${timeout}" bash <<EOF || {
    ns='${namespace}'
    pkg='${package_name}'
    display='${display_name}'
    elapsed=0
    while true; do
      row=\$(oc get csv -n "\${ns}" -o json 2>/dev/null \\
        | jq -r --arg pkg "\${pkg}" --arg display "\${display}" '
            [.items[]
              | select(
                  (.metadata.name | startswith(\$pkg))
                  or (.spec.displayName == \$display)
                )
              | {name: .metadata.name, phase: (.status.phase // "unknown")}
            ][0] // empty')
      if [[ -n "\${row}" ]]; then
        phase=\$(echo "\${row}" | jq -r '.phase')
        name=\$(echo "\${row}" | jq -r '.name')
        echo "[wait_for_operator_csv] \${name}: \${phase} (\${elapsed}s)" >&2
        [[ "\${phase}" == "Succeeded" ]] && break
      else
        if oc get subscription "\${pkg}" -n "\${ns}" -o jsonpath='{.status.conditions[?(@.type=="ResolutionFailed")].status}' 2>/dev/null | grep -q True; then
          echo "[wait_for_operator_csv] Subscription ResolutionFailed — check operator channel" >&2
          oc describe subscription "\${pkg}" -n "\${ns}" 2>/dev/null | tail -20 >&2 || true
          exit 1
        fi
        echo "[wait_for_operator_csv] CSV not created yet (\${elapsed}s)" >&2
        oc get subscription,installplan -n "\${ns}" 2>/dev/null | head -10 >&2 || true
      fi
      sleep 15
      elapsed=\$((elapsed + 15))
    done
EOF
    log "ERROR: Operator ${package_name} did not reach Succeeded in ${namespace}"
    log "Subscription / InstallPlan:"
    oc get subscription,installplan -n "${namespace}" 2>/dev/null >&2 || true
    log "ClusterServiceVersions:"
    oc get csv -n "${namespace}" 2>/dev/null >&2 || true
    oc describe subscription "${package_name}" -n "${namespace}" 2>/dev/null | tail -30 >&2 || true
    return 1
  }
}

ensure_global_operator_group() {
  if oc get operatorgroup -n "${LOKI_OPERATORS_NS}" -o name 2>/dev/null | grep -q .; then
    log "OperatorGroup already present in ${LOKI_OPERATORS_NS}"
    return 0
  fi
  log "Creating global OperatorGroup in ${LOKI_OPERATORS_NS} (required for OLM CSV install)..."
  oc apply -f - <<EOF
apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: global-operators
  namespace: ${LOKI_OPERATORS_NS}
spec:
  upgradeStrategy: Default
EOF
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
  oc apply -f - <<EOF
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: ${package}
  namespace: ${namespace}
spec:
  channel: ${channel}
  installPlanApproval: Automatic
  name: ${package}
  source: redhat-operators
  sourceNamespace: openshift-marketplace
EOF
}

ensure_loki_operators_namespace() {
  if oc get namespace "${LOKI_OPERATORS_NS}" &>/dev/null; then
    return 0
  fi
  log "Creating namespace ${LOKI_OPERATORS_NS}..."
  oc apply -f - <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: ${LOKI_OPERATORS_NS}
  annotations:
    openshift.io/node-selector: ""
  labels:
    openshift.io/cluster-monitoring: "true"
EOF
}

ensure_logging_namespace() {
  if oc get namespace "${LOKI_NS}" &>/dev/null; then
    return 0
  fi
  log "Creating namespace ${LOKI_NS}..."
  oc apply -f - <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: ${LOKI_NS}
  annotations:
    openshift.io/node-selector: ""
  labels:
    openshift.io/cluster-logging: "true"
    openshift.io/cluster-monitoring: "true"
EOF
}

install_loki_operator() {
  local channel="$1"
  ensure_global_operator_group
  ensure_operator_subscription "${LOKI_OPERATORS_NS}" "loki-operator" "${channel}"
  wait_for_operator_csv \
    "${LOKI_OPERATORS_NS}" \
    "loki-operator" \
    "Loki Operator" \
    "${OPERATOR_WAIT_TIMEOUT}"
}

install_cluster_logging_operator() {
  local channel="$1"
  ensure_logging_namespace

  if ! oc get operatorgroup cluster-logging -n "${LOKI_NS}" &>/dev/null; then
    log "Creating OperatorGroup cluster-logging in ${LOKI_NS}..."
    oc apply -f - <<EOF
apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: cluster-logging
  namespace: ${LOKI_NS}
spec:
  targetNamespaces:
    - ${LOKI_NS}
EOF
  fi

  ensure_operator_subscription "${LOKI_NS}" "cluster-logging" "${channel}"
  wait_for_operator_csv \
    "${LOKI_NS}" \
    "cluster-logging" \
    "Red Hat OpenShift Logging" \
    "${OPERATOR_WAIT_TIMEOUT}"
}

install_minio() {
  local storage_class volume_block minio_data_volume

  if oc get deployment "${MINIO_NAME}" -n "${LOKI_NS}" &>/dev/null \
    && oc rollout status "deployment/${MINIO_NAME}" -n "${LOKI_NS}" --timeout=30s &>/dev/null; then
    log "MinIO deployment already ready in ${LOKI_NS}"
    ensure_minio_bucket
    return 0
  fi

  # Replace a failed deployment (e.g. old runAsUser:1000 spec blocked by restricted-v2 SCC)
  if oc get deployment "${MINIO_NAME}" -n "${LOKI_NS}" &>/dev/null; then
    log "Replacing existing MinIO deployment in ${LOKI_NS}..."
    oc delete deployment "${MINIO_NAME}" -n "${LOKI_NS}" --wait=true
  fi

  if [[ "${MINIO_USE_PVC}" == "true" ]]; then
    storage_class="${LOKI_STORAGE_CLASS:-$(get_default_storage_class)}"
    [[ -n "${storage_class}" ]] || {
      log "ERROR: Could not determine storageClassName for MinIO PVC"
      return 1
    }
    volume_block="
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: ${MINIO_NAME}-data
  namespace: ${LOKI_NS}
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: ${MINIO_STORAGE_SIZE}
  storageClassName: ${storage_class}"
    minio_data_volume="
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: ${MINIO_NAME}-data"
    log "Ensuring in-cluster MinIO (${MINIO_NAME}) with PVC (${MINIO_STORAGE_SIZE}, ${storage_class})..."
  else
    oc delete pvc "${MINIO_NAME}-data" -n "${LOKI_NS}" --ignore-not-found --wait=false
    volume_block=""
    minio_data_volume="
      volumes:
        - name: data
          emptyDir: {}"
    log "Ensuring in-cluster MinIO (${MINIO_NAME}) with emptyDir (ROSA-compatible)..."
  fi

  oc apply -f - <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: ${MINIO_NAME}-credentials
  namespace: ${LOKI_NS}
type: Opaque
stringData:
  rootUser: ${MINIO_ACCESS_KEY}
  rootPassword: ${MINIO_SECRET_KEY}
EOF

  if [[ -n "${volume_block}" ]]; then
    oc apply -f - <<<"${volume_block#---
}"
  fi

  oc apply -f - <<EOF
apiVersion: v1
kind: Service
metadata:
  name: ${MINIO_NAME}
  namespace: ${LOKI_NS}
  labels:
    app: ${MINIO_NAME}
spec:
  ports:
    - name: api
      port: 9000
      targetPort: 9000
  selector:
    app: ${MINIO_NAME}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${MINIO_NAME}
  namespace: ${LOKI_NS}
  labels:
    app: ${MINIO_NAME}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ${MINIO_NAME}
  strategy:
    type: Recreate
  template:
    metadata:
      labels:
        app: ${MINIO_NAME}
    spec:
      containers:
        - name: minio
          image: ${MINIO_IMAGE}
          args:
            - server
            - /data
            - --console-address
            - ":9090"
          env:
            - name: MINIO_ROOT_USER
              valueFrom:
                secretKeyRef:
                  name: ${MINIO_NAME}-credentials
                  key: rootUser
            - name: MINIO_ROOT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: ${MINIO_NAME}-credentials
                  key: rootPassword
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
            runAsNonRoot: true
          ports:
            - containerPort: 9000
              name: api
            - containerPort: 9090
              name: console
          readinessProbe:
            httpGet:
              path: /minio/health/ready
              port: 9000
            initialDelaySeconds: 5
            periodSeconds: 10
          volumeMounts:
            - name: data
              mountPath: /data
${minio_data_volume}
EOF

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
  oc apply -f - <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: ${MINIO_NAME}-create-bucket
  namespace: ${LOKI_NS}
spec:
  backoffLimit: 6
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: mc
          image: ${MINIO_MC_IMAGE}
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
            runAsNonRoot: true
          env:
            - name: MC_CONFIG_DIR
              value: /tmp/.mc
            - name: MINIO_ROOT_USER
              valueFrom:
                secretKeyRef:
                  name: ${MINIO_NAME}-credentials
                  key: rootUser
            - name: MINIO_ROOT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: ${MINIO_NAME}-credentials
                  key: rootPassword
          command:
            - /bin/sh
            - -ec
            - |
              mc alias set local ${MINIO_ENDPOINT} "\${MINIO_ROOT_USER}" "\${MINIO_ROOT_PASSWORD}"
              mc mb --ignore-existing "local/${MINIO_BUCKET}"
              mc ls local
EOF

  log "Waiting for MinIO bucket job..."
  timeout 180 oc wait "job/${MINIO_NAME}-create-bucket" -n "${LOKI_NS}" \
    --for=condition=complete --timeout=180s
  log "MinIO ready at ${MINIO_ENDPOINT}, bucket=${MINIO_BUCKET}"
}

create_loki_object_storage_secret() {
  if oc get secret "${LOKI_SECRET_NAME}" -n "${LOKI_NS}" &>/dev/null; then
    log "Secret ${LOKI_SECRET_NAME} already exists in ${LOKI_NS}"
    return 0
  fi

  log "Creating Loki object storage secret ${LOKI_SECRET_NAME} (MinIO endpoint=${MINIO_ENDPOINT})..."
  oc create secret generic "${LOKI_SECRET_NAME}" -n "${LOKI_NS}" \
    --from-literal=bucketnames="${MINIO_BUCKET}" \
    --from-literal=endpoint="${MINIO_ENDPOINT}" \
    --from-literal=access_key_id="${MINIO_ACCESS_KEY}" \
    --from-literal=access_key_secret="${MINIO_SECRET_KEY}" \
    --from-literal=region="${MINIO_REGION}" \
    --from-literal=forcepathstyle="true"
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
  local storage_class effective_date current replication_block=""
  storage_class="${LOKI_STORAGE_CLASS:-$(get_default_storage_class)}"
  [[ -n "${storage_class}" ]] || {
    log "ERROR: Could not determine a storageClassName for LokiStack"
    return 1
  }
  effective_date="$(date -u +%Y-%m-%d)"

  if [[ "${LOKI_SIZE}" == "1x.demo" ]]; then
    replication_block="
  replicationFactor: 1"
  fi

  if oc get lokistack logging-loki -n "${LOKI_NS}" &>/dev/null; then
    current="$(oc get lokistack logging-loki -n "${LOKI_NS}" -o jsonpath='{.spec.size}')"
    if lokistack_ready; then
      if [[ "${current}" != "${LOKI_SIZE}" ]]; then
        log "LokiStack logging-loki Ready at size=${current}; LOKI_SIZE=${LOKI_SIZE} ignored"
      else
        log "LokiStack logging-loki already Ready (size=${current})"
      fi
      return 0
    fi
    if [[ "${current}" != "${LOKI_SIZE}" ]]; then
      log "LokiStack size=${current} not Ready; patching to ${LOKI_SIZE}..."
      if [[ "${LOKI_SIZE}" == "1x.demo" ]]; then
        oc patch lokistack logging-loki -n "${LOKI_NS}" --type=merge \
          -p "{\"spec\":{\"size\":\"${LOKI_SIZE}\",\"replicationFactor\":1}}" || return 1
      else
        oc patch lokistack logging-loki -n "${LOKI_NS}" --type=merge \
          -p "{\"spec\":{\"size\":\"${LOKI_SIZE}\"}}" || return 1
      fi
      return 0
    fi
    log "LokiStack logging-loki exists (size=${current}), waiting for Ready..."
    return 0
  fi

  log "Creating LokiStack logging-loki (size=${LOKI_SIZE}, storageClass=${storage_class})..."
  oc apply -f - <<EOF
apiVersion: loki.grafana.com/v1
kind: LokiStack
metadata:
  name: logging-loki
  namespace: ${LOKI_NS}
spec:
  size: ${LOKI_SIZE}${replication_block}
  storage:
    schemas:
      - version: v13
        effectiveDate: "${effective_date}"
    secret:
      name: ${LOKI_SECRET_NAME}
      type: s3
  storageClassName: ${storage_class}
  tenants:
    mode: openshift-logging
EOF
}

ensure_collector_service_account() {
  local sa="collector"
  local sa_ref="system:serviceaccount:${LOKI_NS}:${sa}"

  if ! oc get sa "${sa}" -n "${LOKI_NS}" &>/dev/null; then
    log "Creating collector ServiceAccount in ${LOKI_NS}..."
    oc create sa "${sa}" -n "${LOKI_NS}"
  fi

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
  local elapsed=0 interval=15 clf="collector"

  if ! oc get crd clusterlogforwarders.observability.openshift.io &>/dev/null; then
    return 0
  fi
  if ! oc get clusterlogforwarder "${clf}" -n "${LOKI_NS}" &>/dev/null; then
    return 0
  fi

  log "Waiting for ClusterLogForwarder ${clf} to become Ready (timeout ${WAIT_TIMEOUT}s)..."
  while [[ "${elapsed}" -lt "${WAIT_TIMEOUT}" ]]; do
    if [[ "$(oc get clusterlogforwarder "${clf}" -n "${LOKI_NS}" \
      -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)" == "True" ]]; then
      log "ClusterLogForwarder ${clf} is Ready"
      return 0
    fi
    sleep "${interval}"
    elapsed=$((elapsed + interval))
    log "ClusterLogForwarder not Ready yet (${elapsed}s/${WAIT_TIMEOUT}s)..."
  done

  log "WARNING: ClusterLogForwarder ${clf} Ready condition not reached"
  oc get clusterlogforwarder "${clf}" -n "${LOKI_NS}" -o yaml >&2 || true
  return 0
}

ensure_log_collection() {
  apply_cluster_log_forwarder
  wait_for_cluster_log_forwarder_ready
}

apply_cluster_log_forwarder() {
  if ! oc get crd clusterlogforwarders.observability.openshift.io &>/dev/null; then
    log "ClusterLogForwarder CRD not installed; skipping collector (Loki query API still available)"
    return 0
  fi

  ensure_collector_service_account

  if oc get clusterlogforwarder collector -n "${LOKI_NS}" &>/dev/null; then
    log "ClusterLogForwarder collector already exists"
    return 0
  fi

  local ca_cm
  ca_cm="$(loki_gateway_ca_configmap)"

  log "Creating ClusterLogForwarder collector (Logging 6.x API, tls.ca=${ca_cm})..."
  oc apply -f - <<EOF
apiVersion: observability.openshift.io/v1
kind: ClusterLogForwarder
metadata:
  name: collector
  namespace: ${LOKI_NS}
spec:
  serviceAccount:
    name: collector
  outputs:
    - name: default-lokistack
      type: lokiStack
      lokiStack:
        authentication:
          token:
            from: serviceAccount
        target:
          name: logging-loki
          namespace: ${LOKI_NS}
      tls:
        ca:
          key: service-ca.crt
          configMapName: ${ca_cm}
  pipelines:
    - name: default-logstore
      inputRefs:
        - application
        - infrastructure
      outputRefs:
        - default-lokistack
EOF
}

wait_for_lokistack_ready() {
  local elapsed=0 interval=30
  if ! oc get lokistack logging-loki -n "${LOKI_NS}" &>/dev/null; then
    return 0
  fi
  log "Waiting for LokiStack logging-loki to become Ready (timeout ${WAIT_TIMEOUT}s)..."
  while [[ "${elapsed}" -lt "${WAIT_TIMEOUT}" ]]; do
    if lokistack_ready; then
      log "LokiStack logging-loki is Ready"
      return 0
    fi
    if (( elapsed > 0 && elapsed % 120 == 0 )); then
      diagnose_lokistack_scheduling
      oc get pods -n "${LOKI_NS}" -l app.kubernetes.io/name=lokistack 2>/dev/null >&2 || true
    fi
    sleep "${interval}"
    elapsed=$((elapsed + interval))
    log "LokiStack not Ready yet (${elapsed}s/${WAIT_TIMEOUT}s)..."
  done
  diagnose_lokistack_scheduling
  log "WARNING: LokiStack Ready condition not reached; continuing to wait for route"
  oc get lokistack logging-loki -n "${LOKI_NS}" -o yaml >&2 || true
  return 0
}

install_openshift_logging() {
  local channel

  channel="$(resolve_logging_stack_channel)" || return 1

  log "Installing OpenShift Logging (Loki) with in-cluster MinIO..."
  ensure_loki_operators_namespace
  install_loki_operator "${channel}"
  install_cluster_logging_operator "${channel}"
  install_minio
  create_loki_object_storage_secret
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
  create_loki_object_storage_secret
  ensure_lokistack
  wait_for_lokistack_ready
  apply_cluster_log_forwarder
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
