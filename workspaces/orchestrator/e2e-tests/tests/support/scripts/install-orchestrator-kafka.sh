#!/usr/bin/env bash
#
# Install a small Streams for Apache Kafka cluster for orchestrator Run as Event e2e.
# Prints the bootstrap server on stdout (e.g. my-cluster-kafka-bootstrap:9092).
# Logs go to stderr.
#
# Environment:
#   KAFKA_NAMESPACE           Target namespace (default: current oc project, else orchestrator)
#   KAFKA_CLUSTER_NAME        Kafka CR name (default: my-cluster)
#   KAFKA_WAIT_TIMEOUT        Kafka Ready wait seconds (default: 600)
#   KAFKA_OPERATOR_WAIT_TIMEOUT  Subscription/CSV wait seconds (default: 900)
#   KAFKA_SUBSCRIPTION_NAME   Subscription name (default: amq-streams)
#   KAFKA_CHANNEL             OLM channel (default: stable)
#   KAFKA_PACKAGE             Package name (default: amq-streams)
#   KAFKA_CATALOG_SOURCE      CatalogSource (default: redhat-operators)
#
set -euo pipefail

KAFKA_NS="${KAFKA_NAMESPACE:-$(oc project -q 2>/dev/null || echo orchestrator)}"
CLUSTER_NAME="${KAFKA_CLUSTER_NAME:-my-cluster}"
WAIT_TIMEOUT="${KAFKA_WAIT_TIMEOUT:-600}"
OPERATOR_WAIT_TIMEOUT="${KAFKA_OPERATOR_WAIT_TIMEOUT:-900}"
SUB_NAME="${KAFKA_SUBSCRIPTION_NAME:-amq-streams}"
CHANNEL="${KAFKA_CHANNEL:-stable}"
PACKAGE="${KAFKA_PACKAGE:-amq-streams}"
CATALOG_SOURCE="${KAFKA_CATALOG_SOURCE:-redhat-operators}"
BOOTSTRAP="${CLUSTER_NAME}-kafka-bootstrap:9092"

log() {
  echo "[install-orchestrator-kafka] $*" >&2
}

kafka_ready() {
  local phase
  phase="$(oc get kafka "${CLUSTER_NAME}" -n "${KAFKA_NS}" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
  [[ "${phase}" == "True" ]]
}

ensure_operator_group() {
  if oc get operatorgroup -n "${KAFKA_NS}" --no-headers 2>/dev/null | grep -q .; then
    log "OperatorGroup already present in ${KAFKA_NS}"
    return 0
  fi
  log "Creating OperatorGroup in ${KAFKA_NS}"
  oc apply -f - <<EOF
apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: streams-kafka
  namespace: ${KAFKA_NS}
spec:
  targetNamespaces:
    - ${KAFKA_NS}
EOF
}

# Prefer the OLM Subscription GVR. Unqualified "subscription" can resolve to
# messaging.knative.dev when Knative Eventing is installed (orchestrator-infra).
OLM_SUB="subscription.operators.coreos.com"

operator_csv_succeeded() {
  oc get csv -n "${KAFKA_NS}" -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\n"}{end}' 2>/dev/null \
    | grep -Eiq 'amqstreams|amq-streams' \
    && oc get csv -n "${KAFKA_NS}" -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\n"}{end}' 2>/dev/null \
      | awk -F'\t' 'tolower($1) ~ /amqstreams|amq-streams/ && $2 == "Succeeded" { found = 1; exit } END { exit !found }'
}

operator_deploy_ready() {
  oc get deploy -n "${KAFKA_NS}" -o name 2>/dev/null | grep -qi 'amq-streams-cluster-operator' \
    && oc get deploy -n "${KAFKA_NS}" -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.readyReplicas}{"\n"}{end}' 2>/dev/null \
      | awk -F'\t' 'tolower($1) ~ /amq-streams-cluster-operator/ && ($2+0) >= 1 { found = 1; exit } END { exit !found }'
}

ensure_subscription() {
  if oc get "${OLM_SUB}" "${SUB_NAME}" -n "${KAFKA_NS}" &>/dev/null; then
    log "OLM Subscription ${SUB_NAME} already exists"
  elif oc get csv -A --no-headers 2>/dev/null | grep -qi 'amqstreams\|amq-streams'; then
    log "AMQ Streams / Kafka operator CSV already installed; ensuring local Subscription still"
    # Still create a namespaced Subscription when missing — cluster CSV copies
    # (e.g. from a previous install) do not guarantee a running operator here.
    if ! oc get "${OLM_SUB}" "${SUB_NAME}" -n "${KAFKA_NS}" &>/dev/null; then
      log "Creating OLM Subscription ${SUB_NAME} in ${KAFKA_NS}"
      oc apply -f - <<EOF
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: ${SUB_NAME}
  namespace: ${KAFKA_NS}
spec:
  channel: ${CHANNEL}
  name: ${PACKAGE}
  source: ${CATALOG_SOURCE}
  sourceNamespace: openshift-marketplace
  installPlanApproval: Automatic
EOF
    fi
  else
    log "Creating OLM Subscription ${SUB_NAME} in ${KAFKA_NS}"
    oc apply -f - <<EOF
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: ${SUB_NAME}
  namespace: ${KAFKA_NS}
spec:
  channel: ${CHANNEL}
  name: ${PACKAGE}
  source: ${CATALOG_SOURCE}
  sourceNamespace: openshift-marketplace
  installPlanApproval: Automatic
EOF
  fi

  # CRDs may linger from a previous install while the operator pod is gone.
  # Wait for CSV Succeeded + cluster-operator Deployment Ready.
  local elapsed=0 interval=15
  while [[ "${elapsed}" -lt "${OPERATOR_WAIT_TIMEOUT}" ]]; do
    if operator_csv_succeeded && operator_deploy_ready; then
      log "AMQ Streams operator CSV Succeeded and Deployment Ready"
      return 0
    fi
    if oc get crd kafkas.kafka.strimzi.io &>/dev/null; then
      log "Waiting for AMQ Streams operator (CRDs present; CSV/deploy not Ready yet)"
    else
      log "Waiting for Kafka CRDs / AMQ Streams operator"
    fi
    sleep "${interval}"
    elapsed=$((elapsed + interval))
  done
  log "Timed out waiting for AMQ Streams operator (${OPERATOR_WAIT_TIMEOUT}s)"
  oc get "${OLM_SUB}",csv,deploy -n "${KAFKA_NS}" >&2 || true
  return 1
}

apply_kafka_cluster() {
  if kafka_ready; then
    log "Kafka/${CLUSTER_NAME} already Ready in ${KAFKA_NS}"
    return 0
  fi

  log "Applying Kafka/${CLUSTER_NAME} with 1 broker + 1 controller (RF=1)"
  oc apply -n "${KAFKA_NS}" -f - <<EOF
apiVersion: kafka.strimzi.io/v1beta2
kind: Kafka
metadata:
  name: ${CLUSTER_NAME}
  annotations:
    strimzi.io/node-pools: enabled
    strimzi.io/kraft: enabled
spec:
  kafka:
    version: "4.1.0"
    metadataVersion: "4.1"
    config:
      offsets.topic.replication.factor: 1
      transaction.state.log.replication.factor: 1
      transaction.state.log.min.isr: 1
      default.replication.factor: 1
      min.insync.replicas: 1
    listeners:
      - name: plain
        port: 9092
        type: internal
        tls: false
      - name: tls
        port: 9093
        type: internal
        tls: true
  entityOperator:
    topicOperator: {}
    userOperator: {}
---
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaNodePool
metadata:
  name: broker
  labels:
    strimzi.io/cluster: ${CLUSTER_NAME}
spec:
  replicas: 1
  roles:
    - broker
  storage:
    type: jbod
    volumes:
      - id: 0
        type: ephemeral
---
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaNodePool
metadata:
  name: controller
  labels:
    strimzi.io/cluster: ${CLUSTER_NAME}
spec:
  replicas: 1
  roles:
    - controller
  storage:
    type: jbod
    volumes:
      - id: 0
        type: ephemeral
        kraftMetadata: shared
EOF
}

wait_kafka_ready() {
  log "Waiting for Kafka/${CLUSTER_NAME} Ready (timeout ${WAIT_TIMEOUT}s)"
  if oc wait -n "${KAFKA_NS}" "kafka/${CLUSTER_NAME}" --for=condition=Ready --timeout="${WAIT_TIMEOUT}s"; then
    return 0
  fi
  # Some operator versions expose Ready differently; fall back to status poll.
  local elapsed=0 interval=15
  while [[ "${elapsed}" -lt "${WAIT_TIMEOUT}" ]]; do
    if kafka_ready; then
      return 0
    fi
    sleep "${interval}"
    elapsed=$((elapsed + interval))
  done
  log "Timed out waiting for Kafka Ready"
  oc get kafka,kafkanodepool,pods -n "${KAFKA_NS}" -l "strimzi.io/cluster=${CLUSTER_NAME}" >&2 || true
  return 1
}

main() {
  log "Namespace: ${KAFKA_NS}"
  oc get ns "${KAFKA_NS}" &>/dev/null || oc create ns "${KAFKA_NS}"

  if kafka_ready; then
    log "Kafka already Ready; bootstrap=${BOOTSTRAP}"
    echo "${BOOTSTRAP}"
    return 0
  fi

  ensure_operator_group
  ensure_subscription
  apply_kafka_cluster
  wait_kafka_ready
  log "Kafka Ready; bootstrap=${BOOTSTRAP}"
  echo "${BOOTSTRAP}"
}

main "$@"
