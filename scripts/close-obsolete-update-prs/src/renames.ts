/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

/**
 * MAINTENANCE NOTE:
 * Whenever an existing workspace directory in workspaces/ is renamed or merged
 * (e.g. marketplace -> extensions), add an entry to WORKSPACE_RENAMES below.
 * This ensures that lingering automated update PRs opened against the legacy
 * workspace directory name are mapped to the new workspace and accurately evaluated.
 *
 * Historical workspace renames in rhdh-plugin-export-overlays:
 * Maps legacy workspace directory name -> current workspace directory name.
 */
export const WORKSPACE_RENAMES: Readonly<Record<string, string>> = {
  marketplace: "extensions",
  "redhat-resource-optimization": "cost-management",
  "redhat-argocd": "argocd",
  "aws-ecs": "backstage-plugins-for-aws",
  "aws-codebuild": "backstage-plugins-for-aws",
  "github-actions": "github",
  "github-issues": "github",
  "github-pull-requests-board": "github",
};

/**
 * MAINTENANCE NOTE:
 * Whenever an exported package is renamed upstream in rhdh-plugins or community
 * repositories (e.g. dynamic-home-page -> homepage), add an entry to PACKAGE_RENAMES.
 * This allows the detector to match PRs proposing the legacy package name against
 * newer releases of the renamed package.
 *
 * Historical package renames in rhdh-plugins and community ecosystems:
 * Maps legacy package name -> current package name.
 */
export const PACKAGE_RENAMES: Readonly<Record<string, string>> = {
  "@red-hat-developer-hub/backstage-plugin-dynamic-home-page":
    "@red-hat-developer-hub/backstage-plugin-homepage",
  "@red-hat-developer-hub/backstage-plugin-boost":
    "@red-hat-developer-hub/backstage-plugin-ai-catalog",
  "@red-hat-developer-hub/backstage-plugin-scaffolder-backend-module-x2a":
    "@red-hat-developer-hub/backstage-plugin-x2a-scaffolder-module",
};

/**
 * Resolves the canonical workspace name on the target branch.
 */
export function resolveCurrentWorkspaceName(workspaceName: string): string {
  return WORKSPACE_RENAMES[workspaceName] ?? workspaceName;
}

/**
 * Resolves the canonical package name.
 */
export function resolveCurrentPackageName(packageName: string): string {
  return PACKAGE_RENAMES[packageName] ?? packageName;
}
