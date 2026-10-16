/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

/**
 * Historical workspace renames in rhdh-plugin-export-overlays.
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
 * Historical package renames in rhdh-plugins and community ecosystems.
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
