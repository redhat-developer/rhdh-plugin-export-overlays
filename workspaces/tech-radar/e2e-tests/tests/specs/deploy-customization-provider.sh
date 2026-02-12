#!/bin/bash
set -e

deploy_test_backstage_customization_provider() {
  local project=$1
  echo "Deploying test-backstage-customization-provider in namespace ${project}"

  # Check if the buildconfig already exists
  if ! oc get buildconfig test-backstage-customization-provider -n "${project}" > /dev/null 2>&1; then
    # Get latest nodejs UBI9 tag from cluster, fallback to 18-ubi8
    local nodejs_tag
    nodejs_tag=$(oc get imagestream nodejs -n openshift -o jsonpath='{.spec.tags[*].name}' 2> /dev/null \
      | tr ' ' '\n' | grep -E '^[0-9]+-ubi9$' | sort -t'-' -k1 -n | tail -1)
    nodejs_tag="${nodejs_tag:-18-ubi8}"
    echo "Creating new app for test-backstage-customization-provider using nodejs:${nodejs_tag}"
    oc new-app "openshift/nodejs:${nodejs_tag}~https://github.com/janus-qe/test-backstage-customization-provider" --namespace="${project}"
  else
    echo "BuildConfig for test-backstage-customization-provider already exists in ${project}. Skipping new-app creation."
  fi

  echo "Exposing service for test-backstage-customization-provider"
  oc expose svc/test-backstage-customization-provider --namespace="${project}" 2>&1 || echo "Route already exists, continuing..."
}


deploy_test_backstage_customization_provider "$1"

