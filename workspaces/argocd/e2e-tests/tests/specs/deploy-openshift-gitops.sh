#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GITOPS_NAMESPACE="openshift-gitops"
OPERATOR_NAMESPACE="openshift-operators"
APP_NAMESPACE="$1"

wait_for() {
  local description=$1
  local check_cmd=$2
  local timeout=${3:-300}
  local interval=${4:-10}
  local elapsed=0

  echo "=== Waiting for ${description} ==="
  while ! eval "${check_cmd}" > /dev/null 2>&1; do
    if [[ "${elapsed}" -ge "${timeout}" ]]; then
      echo "ERROR: Timed out waiting for ${description} (${timeout}s)"
      return 1
    fi
    sleep "${interval}"
    elapsed=$((elapsed + interval))
  done
  echo "${description} — ready."
}

install_gitops_operator() {
  echo "=== Installing Red Hat OpenShift GitOps Operator ==="

  if oc get csv -n "${OPERATOR_NAMESPACE}" 2>/dev/null | grep -q "Red Hat OpenShift GitOps"; then
    echo "OpenShift GitOps operator is already installed."
  else
    echo "Applying GitOps operator subscription..."
    oc apply -f "${SCRIPT_DIR}/resources/gitops-subscription.yaml" || {
      echo "ERROR: Failed to apply GitOps subscription"
      return 1
    }

    wait_for "GitOps operator CSV" \
      "oc get csv -n ${OPERATOR_NAMESPACE} 2>/dev/null | grep 'Red Hat OpenShift GitOps' | grep -q Succeeded" \
      300 10

    wait_for "CRD argocds.argoproj.io" \
      "oc get crd argocds.argoproj.io" 300 10

    wait_for "CRD applications.argoproj.io" \
      "oc get crd applications.argoproj.io" 300 10
  fi

  wait_for "ArgoCD server deployment" \
    "[[ \$(oc get deployment openshift-gitops-server -n ${GITOPS_NAMESPACE} -o jsonpath='{.status.availableReplicas}' 2>/dev/null) == \$(oc get deployment openshift-gitops-server -n ${GITOPS_NAMESPACE} -o jsonpath='{.spec.replicas}' 2>/dev/null) ]]" \
    300 10
}

configure_rbac() {
  echo "=== Configuring RBAC ==="

  echo "Granting ArgoCD controller cluster-admin..."
  oc adm policy add-cluster-role-to-user cluster-admin \
    "system:serviceaccount:${GITOPS_NAMESPACE}:openshift-gitops-argocd-application-controller" 2>/dev/null || true

  echo "Applying ClusterRole for RHDH..."
  oc apply -f "${SCRIPT_DIR}/resources/cluster-role.yaml"

  oc create clusterrolebinding rhdh-rollouts-reader \
    --clusterrole=rhdh-rollouts-reader \
    --group=system:serviceaccounts:"${APP_NAMESPACE}" \
    2>/dev/null || true

  oc create clusterrolebinding argo-rollouts-binding \
    --clusterrole=rhdh-rollouts-reader \
    --serviceaccount="${APP_NAMESPACE}:argo-rollouts" \
    2>/dev/null || true

  echo "RBAC configured."
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

  if [[ -z "${ARGOCD_TOKEN}" ]]; then
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

  if oc get application.argoproj.io test-argocd-app -n "${GITOPS_NAMESPACE}" > /dev/null 2>&1; then
    echo "Test application already exists. Deleting and re-creating..."
    oc delete application.argoproj.io test-argocd-app -n "${GITOPS_NAMESPACE}" --wait=true
  fi

  sed "s/\${APP_NAMESPACE}/${APP_NAMESPACE}/g" "${SCRIPT_DIR}/resources/test-argocd-application.yaml" | oc apply -n "${GITOPS_NAMESPACE}" -f - || {
    echo "ERROR: Failed to create test ArgoCD application"
    return 1
  }

  echo "Waiting for application to sync..."
  local timeout=300
  local interval=10
  local elapsed=0
  while true; do
    local sync_status health_status
    sync_status=$(oc get application.argoproj.io test-argocd-app -n "${GITOPS_NAMESPACE}" -o jsonpath='{.status.sync.status}' 2>/dev/null || echo "Unknown")
    health_status=$(oc get application.argoproj.io test-argocd-app -n "${GITOPS_NAMESPACE}" -o jsonpath='{.status.health.status}' 2>/dev/null || echo "Unknown")
    echo "  Sync: ${sync_status}, Health: ${health_status}"

    if [[ "${sync_status}" = "Synced" ]]; then
      if [[ "${health_status}" = "Healthy" ]]; then
        echo "Test application is synced and healthy."
      else
        echo "Test application is synced (Health: ${health_status}). Proceeding."
      fi
      break
    fi

    if [[ "${elapsed}" -ge "${timeout}" ]]; then
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

  echo "Configuring operator to allow RolloutManager in ${APP_NAMESPACE}..."
  local patch_output
  patch_output=$(oc patch subscription openshift-gitops-operator -n "${OPERATOR_NAMESPACE}" \
    --type=merge \
    -p "{\"spec\":{\"config\":{\"env\":[{\"name\":\"CLUSTER_SCOPED_ARGO_ROLLOUTS_NAMESPACES\",\"value\":\"${APP_NAMESPACE}\"}]}}}" 2>&1) || {
    echo "WARNING: Failed to patch subscription for rollout namespaces"
  }
  echo "${patch_output}"

  if [[ "${patch_output}" != *"(no change)"* ]]; then
    echo "Subscription changed — waiting for operator to pick up..."
    sleep 30
  fi

  oc delete rolloutmanager argo-rollout -n "${APP_NAMESPACE}" 2>/dev/null || true

  oc apply -f "${SCRIPT_DIR}/resources/rollout-manager.yaml" -n "${APP_NAMESPACE}" || {
    echo "ERROR: Failed to create RolloutManager"
    return 1
  }

  wait_for "RolloutManager" \
    "[[ \$(oc get rolloutmanager argo-rollout -n ${APP_NAMESPACE} -o jsonpath='{.status.phase}' 2>/dev/null) == 'Available' ]]" \
    180 10
}

trigger_rollout_update() {
  echo "=== Triggering rollout update to generate AnalysisRuns ==="

  echo "Cleaning up existing AnalysisRuns..."
  oc delete analysisruns --all -n "${APP_NAMESPACE}" 2>/dev/null || true

  echo "Disabling selfHeal on ArgoCD Application..."
  oc patch application.argoproj.io test-argocd-app -n "${GITOPS_NAMESPACE}" \
    --type=merge -p '{"spec":{"syncPolicy":{"automated":{"selfHeal":false}}}}' || {
    echo "WARNING: Failed to disable selfHeal"
    return 1
  }

  local ts
  ts=$(date +%s)

  echo "Patching canary rollout to trigger new revision (ts=${ts})..."
  oc patch rollout canary-rollout-analysis -n "${APP_NAMESPACE}" \
    --type=merge -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"rollout-trigger\":\"${ts}\"}},\"spec\":{\"containers\":[{\"name\":\"rollouts-demo\",\"image\":\"argoproj/rollouts-demo:green\"}]}}}}" || {
    echo "WARNING: Failed to patch canary rollout"
    return 1
  }

  echo "Patching bluegreen rollout to trigger new revision (ts=${ts})..."
  oc patch rollout rollout-bluegreen -n "${APP_NAMESPACE}" \
    --type=merge -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"rollout-trigger\":\"${ts}\"}},\"spec\":{\"containers\":[{\"name\":\"rollouts-demo\",\"image\":\"argoproj/rollouts-demo:green\"}]}}}}" || {
    echo "WARNING: Failed to patch bluegreen rollout"
    return 1
  }

  local interval=10

  echo "Waiting for AnalysisRuns to be created (expecting one per rollout)..."
  local timeout=180
  local elapsed=0
  while true; do
    local ar_count canary_step
    ar_count=$(oc get analysisruns -n "${APP_NAMESPACE}" --no-headers 2>/dev/null | wc -l | tr -d ' ')
    canary_step=$(oc get rollout canary-rollout-analysis -n "${APP_NAMESPACE}" \
      -o jsonpath='{.status.currentStepIndex}' 2>/dev/null || echo "0")
    echo "  AnalysisRuns found: ${ar_count}, Canary step: ${canary_step}/4"

    if [[ "${ar_count}" -ge 2 ]]; then
      echo "AnalysisRuns detected for both rollouts."
      break
    fi

    if [[ "${ar_count}" -ge 1 ]] && [[ "${canary_step}" -ge 4 ]]; then
      echo "Canary rollout already completed (re-run). Proceeding with ${ar_count} AnalysisRun(s)."
      break
    fi

    if [[ "${elapsed}" -ge "${timeout}" ]]; then
      echo "WARNING: Timed out waiting for AnalysisRuns (${timeout}s). Found: ${ar_count}"
      break
    fi

    sleep "${interval}"
    elapsed=$((elapsed + interval))
  done

  echo "Waiting for AnalysisRuns to complete..."
  local ar_timeout=180
  local ar_elapsed=0
  while true; do
    local running_count
    running_count=$(oc get analysisruns -n "${APP_NAMESPACE}" \
      --no-headers 2>/dev/null | { grep -c "Running" || true; })
    echo "  AnalysisRuns still running: ${running_count}"

    if [[ "${running_count}" -eq 0 ]]; then
      echo "All AnalysisRuns have completed."
      break
    fi

    if [[ "${ar_elapsed}" -ge "${ar_timeout}" ]]; then
      echo "WARNING: Some AnalysisRuns still running after ${ar_timeout}s."
      break
    fi

    sleep "${interval}"
    ar_elapsed=$((ar_elapsed + interval))
  done

  echo "Re-enabling selfHeal on ArgoCD Application..."
  oc patch application.argoproj.io test-argocd-app -n "${GITOPS_NAMESPACE}" \
    --type=merge -p '{"spec":{"syncPolicy":{"automated":{"selfHeal":true}}}}' || true

  echo "AnalysisRun status:"
  oc get analysisruns -n "${APP_NAMESPACE}" 2>/dev/null || true
}

main() {
  echo "========================================="
  echo "  OpenShift GitOps Setup for ArgoCD E2E"
  echo "========================================="
  echo "ArgoCD server namespace: ${GITOPS_NAMESPACE}"
  echo "App resources namespace: ${APP_NAMESPACE}"

  install_gitops_operator
  configure_rbac
  get_argocd_credentials
  create_test_application
  create_rollout_manager
  trigger_rollout_update

  local final_sync final_health
  final_sync=$(oc get application.argoproj.io test-argocd-app -n "${GITOPS_NAMESPACE}" -o jsonpath='{.status.sync.status}' 2>/dev/null || echo "Unknown")
  final_health=$(oc get application.argoproj.io test-argocd-app -n "${GITOPS_NAMESPACE}" -o jsonpath='{.status.health.status}' 2>/dev/null || echo "Unknown")

  echo ""
  echo "========================================="
  echo "  Setup Complete"
  echo "========================================="
  echo "ArgoCD App — Sync: ${final_sync}, Health: ${final_health}"
  echo "Resource health breakdown:"
  oc get application.argoproj.io test-argocd-app -n "${GITOPS_NAMESPACE}" \
    -o jsonpath='{range .status.resources[*]}  {.kind}: {.health.status}{"\n"}{end}' 2>/dev/null || true
  echo "ARGOCD_INSTANCE1_URL=${ARGOCD_INSTANCE1_URL}"
  echo "ARGOCD_USERNAME=${ARGOCD_USERNAME}"
  echo "ARGOCD_AUTH_TOKEN is set: $([[ -n "${ARGOCD_AUTH_TOKEN:-}" ]] && echo 'yes' || echo 'no')"
}

main "$@"
