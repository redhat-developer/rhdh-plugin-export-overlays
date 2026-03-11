#!/bin/bash
set -e

install_openshift_pipelines() {
  local script_dir=$1

  echo "Checking if OpenShift Pipelines operator is installed..."
  if oc get crd pipelines.tekton.dev &>/dev/null; then
    echo "OpenShift Pipelines operator is already installed"
    return 0
  fi

  echo "Installing Red Hat OpenShift Pipelines operator..."
  oc apply -f "${script_dir}/openshift-pipelines-subscription.yaml"

  echo "Waiting for OpenShift Pipelines CRDs to become available..."
  local timeout=300
  local elapsed=0
  while ! oc get crd pipelines.tekton.dev &>/dev/null; do
    if [ "$elapsed" -ge "$timeout" ]; then
      echo "ERROR: Timed out waiting for OpenShift Pipelines CRDs after ${timeout}s"
      return 1
    fi
    sleep 10
    elapsed=$((elapsed + 10))
    echo "  Still waiting for Tekton CRDs... (${elapsed}s)"
  done
  echo "OpenShift Pipelines operator installed successfully"
}

deploy_topology_resources() {
  local project=$1
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

  echo "Granting read access to default service account in namespace ${project}"
  oc adm policy add-cluster-role-to-user cluster-reader -z default -n "${project}" 2>/dev/null || \
    oc create clusterrolebinding "topology-test-${project}-reader" \
      --clusterrole=cluster-reader \
      --serviceaccount="${project}:default" 2>/dev/null || true

  echo "Granting Tekton read access to default service account"
  oc apply -f "${script_dir}/tekton-reader-clusterrole.yaml"
  oc create clusterrolebinding "topology-test-${project}-tekton-reader" \
    --clusterrole=topology-test-tekton-reader \
    --serviceaccount="${project}:default" 2>/dev/null || true

  echo "Deploying topology test resources in namespace ${project}"
  oc apply -f "${script_dir}/resources.yaml" -n "${project}"

  echo "Deploying Tekton resources"
  oc apply -f "${script_dir}/tekton-resources.yaml" -n "${project}"

  echo "Waiting for topology-test deployment to be ready"
  oc rollout status deployment/topology-test -n "${project}" --timeout=120s
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install_openshift_pipelines "${SCRIPT_DIR}"
deploy_topology_resources "$1"
