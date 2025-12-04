#!/bin/bash
set -e

deploy_test_backstage_customization_provider() {
  local project=$1
  echo "Deploying test-backstage-customization-provider in namespace ${project}"

  # Check if the buildconfig already exists
  if ! oc get buildconfig test-backstage-customization-provider -n "${project}" > /dev/null 2>&1; then
    echo "Creating new app for test-backstage-customization-provider"
    oc new-app -S openshift/nodejs:18-minimal-ubi8
    oc new-app https://github.com/janus-qe/test-backstage-customization-provider --image-stream="openshift/nodejs:18-ubi8" --namespace="${project}"
  else
    echo "BuildConfig for test-backstage-customization-provider already exists in ${project}. Skipping new-app creation."
  fi

  echo "Exposing service for test-backstage-customization-provider"
  oc expose svc/test-backstage-customization-provider --namespace="${project}" 2>&1 || echo "Route already exists, continuing..."
}


deploy_test_backstage_customization_provider "$1"

