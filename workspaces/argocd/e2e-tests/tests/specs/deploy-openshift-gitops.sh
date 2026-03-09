#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GITOPS_NAMESPACE="openshift-gitops"
OPERATOR_NAMESPACE="openshift-operators"

wait_for_crd() {
  local crd_name=$1
  local timeout=${2:-300}
  local interval=${3:-10}
  local elapsed=0

  echo "Waiting for CRD ${crd_name} to be registered..."
  while ! oc get crd "${crd_name}" > /dev/null 2>&1; do
    if [ "${elapsed}" -ge "${timeout}" ]; then
      echo "ERROR: Timed out waiting for CRD ${crd_name}"
      return 1
    fi
    sleep "${interval}"
    elapsed=$((elapsed + interval))
  done
  echo "CRD ${crd_name} is registered."
}

wait_for_deployment() {
  local namespace=$1
  local name=$2
  local timeout=${3:-300}
  local interval=${4:-10}
  local elapsed=0

  echo "Waiting for deployment ${name} in ${namespace}..."
  while ! oc get deployment "${name}" -n "${namespace}" > /dev/null 2>&1 || \
        [ "$(oc get deployment "${name}" -n "${namespace}" -o jsonpath='{.status.availableReplicas}' 2>/dev/null)" != "$(oc get deployment "${name}" -n "${namespace}" -o jsonpath='{.spec.replicas}' 2>/dev/null)" ]; do
    if [ "${elapsed}" -ge "${timeout}" ]; then
      echo "ERROR: Timed out waiting for deployment ${name} in ${namespace}"
      return 1
    fi
    sleep "${interval}"
    elapsed=$((elapsed + interval))
  done
  echo "Deployment ${name} in ${namespace} is ready."
}

install_gitops_operator() {
  echo "=== Installing Red Hat OpenShift GitOps Operator ==="

  if oc get csv -n "${OPERATOR_NAMESPACE}" 2>/dev/null | grep -q "Red Hat OpenShift GitOps"; then
    echo "OpenShift GitOps operator is already installed."
    return 0
  fi

  echo "Applying GitOps operator subscription..."
  oc apply -f "${SCRIPT_DIR}/resources/gitops-subscription.yaml" || {
    echo "ERROR: Failed to apply GitOps subscription"
    return 1
  }

  echo "Waiting for operator CSV to succeed..."
  local timeout=300
  local interval=10
  local elapsed=0
  while ! oc get csv -n "${OPERATOR_NAMESPACE}" 2>/dev/null | grep "Red Hat OpenShift GitOps" | grep -q "Succeeded"; do
    if [ "${elapsed}" -ge "${timeout}" ]; then
      echo "ERROR: Timed out waiting for GitOps operator CSV"
      return 1
    fi
    sleep "${interval}"
    elapsed=$((elapsed + interval))
  done
  echo "GitOps operator CSV succeeded."

  wait_for_crd "argocds.argoproj.io" 300 10
  wait_for_crd "applications.argoproj.io" 300 10
}

wait_for_argocd_server() {
  echo "=== Waiting for ArgoCD server ==="
  wait_for_deployment "${GITOPS_NAMESPACE}" "openshift-gitops-server" 300 10
}

grant_argocd_rbac() {
  echo "=== Granting ArgoCD controller cluster-admin ==="
  oc adm policy add-cluster-role-to-user cluster-admin \
    "system:serviceaccount:${GITOPS_NAMESPACE}:openshift-gitops-argocd-application-controller" 2>/dev/null || true
}

grant_backstage_rbac() {
  echo "=== Granting RHDH service account rollout read access ==="

  oc apply -f "${SCRIPT_DIR}/resources/cluster-role.yaml"

  oc create clusterrolebinding rhdh-rollouts-reader \
    --clusterrole=rhdh-rollouts-reader \
    --group=system:serviceaccounts:argocd \
    2>/dev/null || true

  oc create clusterrolebinding argo-rollouts-binding \
    --clusterrole=rhdh-rollouts-reader \
    --serviceaccount="${GITOPS_NAMESPACE}:argo-rollouts" \
    2>/dev/null || true

  echo "Backstage RBAC for rollouts configured."
}

get_argocd_credentials() {
  echo "=== Retrieving ArgoCD credentials ==="

  ARGOCD_URL="https://$(oc get route openshift-gitops-server -n "${GITOPS_NAMESPACE}" -o jsonpath='{.spec.host}')"
  echo "ArgoCD URL: ${ARGOCD_URL}"

  ARGOCD_PASSWORD=$(oc get secret openshift-gitops-cluster -n "${GITOPS_NAMESPACE}" -o jsonpath='{.data.admin\.password}' | base64 -d)
  echo "ArgoCD admin password retrieved."

  echo "Generating ArgoCD auth token..."
  local session_response
  session_response=$(curl -sk "${ARGOCD_URL}/api/v1/session" \
    -d "{\"username\":\"admin\",\"password\":\"${ARGOCD_PASSWORD}\"}" 2>&1) || true
  ARGOCD_TOKEN=$(echo "${session_response}" | grep -o '"token":"[^"]*"' | cut -d'"' -f4 || true)

  if [ -z "${ARGOCD_TOKEN}" ]; then
    echo "WARNING: Could not generate ArgoCD token. Tests may use password auth instead."
  else
    echo "ArgoCD auth token generated."
  fi

  export ARGOCD_INSTANCE1_URL="${ARGOCD_URL}"
  export ARGOCD_USERNAME="admin"
  export ARGOCD_PASSWORD
  export ARGOCD_AUTH_TOKEN="${ARGOCD_TOKEN:-}"
}

create_test_application() {
  echo "=== Creating test ArgoCD Application ==="

  if oc get application test-argocd-app -n "${GITOPS_NAMESPACE}" > /dev/null 2>&1; then
    echo "Test application already exists. Deleting and re-creating..."
    oc delete application test-argocd-app -n "${GITOPS_NAMESPACE}" --wait=true
  fi

  oc apply -f "${SCRIPT_DIR}/resources/test-argocd-application.yaml" || {
    echo "ERROR: Failed to create test ArgoCD application"
    return 1
  }

  echo "Waiting for application to sync..."
  local timeout=120
  local interval=10
  local elapsed=0
  while true; do
    local sync_status
    sync_status=$(oc get application test-argocd-app -n "${GITOPS_NAMESPACE}" -o jsonpath='{.status.sync.status}' 2>/dev/null || echo "Unknown")
    local health_status
    health_status=$(oc get application test-argocd-app -n "${GITOPS_NAMESPACE}" -o jsonpath='{.status.health.status}' 2>/dev/null || echo "Unknown")
    echo "  Sync: ${sync_status}, Health: ${health_status}"

    if [ "${sync_status}" = "Synced" ] && [ "${health_status}" = "Healthy" ]; then
      echo "Test application is synced and healthy."
      break
    fi

    if [ "${elapsed}" -ge "${timeout}" ]; then
      echo "WARNING: Test application did not reach Synced/Healthy within ${timeout}s."
      echo "  Current status — Sync: ${sync_status}, Health: ${health_status}"
      break
    fi

    sleep "${interval}"
    elapsed=$((elapsed + interval))
  done
}

create_rollout_manager() {
  echo "=== Creating RolloutManager CR ==="

  oc apply -f "${SCRIPT_DIR}/resources/rollout-manager.yaml" -n "${GITOPS_NAMESPACE}" || {
    echo "ERROR: Failed to create RolloutManager"
    return 1
  }

  echo "Waiting for RolloutManager to become available..."
  local timeout=120
  local interval=10
  local elapsed=0
  while true; do
    local phase
    phase=$(oc get rolloutmanager argo-rollout -n "${GITOPS_NAMESPACE}" -o jsonpath='{.status.phase}' 2>/dev/null || echo "Unknown")
    echo "  Phase: ${phase}"

    if [ "${phase}" = "Available" ]; then
      echo "RolloutManager is available."
      break
    fi

    if [ "${elapsed}" -ge "${timeout}" ]; then
      echo "WARNING: RolloutManager did not reach Available within ${timeout}s."
      break
    fi

    sleep "${interval}"
    elapsed=$((elapsed + interval))
  done
}

main() {
  echo "========================================="
  echo "  OpenShift GitOps Setup for ArgoCD E2E"
  echo "========================================="

  install_gitops_operator
  wait_for_argocd_server
  grant_argocd_rbac
  grant_backstage_rbac
  get_argocd_credentials
  create_test_application
  create_rollout_manager

  echo ""
  echo "========================================="
  echo "  Setup Complete"
  echo "========================================="
  echo "ARGOCD_INSTANCE1_URL=${ARGOCD_INSTANCE1_URL}"
  echo "ARGOCD_USERNAME=${ARGOCD_USERNAME}"
  echo "ARGOCD_AUTH_TOKEN is set: $([ -n "${ARGOCD_AUTH_TOKEN:-}" ] && echo 'yes' || echo 'no')"
}

main "$@"
