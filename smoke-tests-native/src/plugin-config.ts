/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * Known failures + startup config overrides (ported from RHDH PR #4967:
 * e2e-tests/playwright/utils/plugin-config.ts). Some backend plugins/modules
 * validate config at boot, so startTestBackend needs a root config with (dummy)
 * values for them; others can't load in a test env and are skipped.
 */

import type { JsonObject } from "@backstage/types";
import type { LoadedPlugin } from "./loader";

// Plugins that cannot load in the test environment, skipped before loading.
export const KNOWN_FAILURES = new Set<string>([
  "pagerduty-backstage-plugin-backend",
  "roadiehq-backstage-plugin-argo-cd-backend",
  "red-hat-developer-hub-backstage-plugin-orchestrator-backend",
  "red-hat-developer-hub-backstage-plugin-orchestrator-backend-module-loki",
  "red-hat-developer-hub-backstage-plugin-scaffolder-backend-module-orchestrator",
]);

// Dummy values only — plugins never connect to anything; this satisfies config
// validation at startup so the backend can boot.
const configOverrides: Record<string, JsonObject> = {
  "backstage-community-plugin-jenkins-backend": {
    jenkins: { baseUrl: "http://localhost:8080", username: "test", apiKey: "test" },
  },
  "backstage-community-plugin-quay-backend": {
    quay: { uiUrl: "https://quay.io", apiUrl: "https://quay.io/api/v1" },
  },
  "immobiliarelabs-backstage-plugin-gitlab-backend": {
    integrations: { gitlab: [{ host: "gitlab.com", token: "test" }] },
  },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Deep-merge so two plugins contributing to the same top-level section (e.g. both adding
// to `integrations`) don't clobber each other: objects merge recursively, arrays concat.
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      deepMerge(current, value);
    } else if (Array.isArray(current) && Array.isArray(value)) {
      target[key] = [...current, ...value];
    } else {
      target[key] = value;
    }
  }
  return target;
}

export function buildMergedConfig(plugins: LoadedPlugin[]): JsonObject {
  const merged: Record<string, unknown> = {};
  for (const { plugin } of plugins) {
    const overrides = configOverrides[plugin.dirName];
    if (overrides) deepMerge(merged, overrides);
  }
  return merged as JsonObject;
}
