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
 *
 * These lists mostly matter for multi-plugin / whole-workspace runs (they don't fire
 * for a single scaffolder-module run). Kept in TS — rather than package.json — to stay
 * type-checked and in sync with the RHDH source they're ported from.
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

// Config every run starts from. These are core Backstage keys rather than any one
// plugin's: a plugin that reads them (e.g. mta, to build its own URLs) fails startup
// validation with no plugin-specific key to attach a dummy to.
const baseConfig: JsonObject = {
  app: { baseUrl: "http://localhost:3000" },
  backend: { baseUrl: "http://localhost:7007" },
};

// Dummy values only — plugins never connect to anything; this satisfies config
// validation at startup so the backend can boot.
const configOverrides: Record<string, JsonObject> = {
  "backstage-community-plugin-jenkins-backend": {
    jenkins: {
      baseUrl: "http://localhost:8080",
      username: "test",
      apiKey: "test",
    },
  },
  "backstage-community-plugin-quay-backend": {
    quay: { uiUrl: "https://quay.io", apiUrl: "https://quay.io/api/v1" },
  },
  "immobiliarelabs-backstage-plugin-gitlab-backend": {
    integrations: { gitlab: [{ host: "gitlab.com", token: "test" }] },
  },
  // The three below came out of the first full community sweep (RHIDP-13510). Each
  // failed startup config validation and nothing else, so a dummy recovers the boot
  // signal at no cost — the outcome plugin-sweep-excludes.txt tells you to prefer over
  // an exclusion. Shapes are copied from each workspace's own metadata
  // appConfigExamples so they stay valid against the plugin's config schema.
  "backstage-community-plugin-kiali-backend": {
    kiali: {
      providers: [
        {
          name: "kiali",
          url: "https://localhost:20001",
          skipTLSVerify: true,
          serviceAccountToken: "test",
          sessionTime: 60,
        },
      ],
    },
  },
  "backstage-community-plugin-lighthouse-backend": {
    lighthouse: { baseUrl: "http://localhost:3003" },
  },
  "backstage-community-backstage-plugin-mta-backend": {
    mta: {
      url: "http://localhost:8080",
      providerAuth: { realm: "test", clientID: "test", secret: "test" },
    },
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

// `extra` is a caller-supplied app-config layer (e.g. a workspace's
// smoke-tests/app-config.test.yaml) merged last. Scalars in it override the built-in
// dummies; ARRAYS concatenate (see deepMerge), so a workspace supplying
// `integrations.gitlab` appends to the dummy rather than replacing it.
export function buildMergedConfig(
  plugins: LoadedPlugin[],
  extra?: JsonObject,
): JsonObject {
  const merged: Record<string, unknown> = structuredClone(
    baseConfig as Record<string, unknown>,
  );
  for (const { plugin } of plugins) {
    const overrides = configOverrides[plugin.dirName];
    // Clone: deepMerge assigns source values by reference when the target key is
    // absent, so merging the override directly made `merged.integrations` BE the
    // constant's object — and the caller's app-config layer below then wrote into
    // configOverrides itself, leaking one call's config into the next.
    if (overrides) deepMerge(merged, structuredClone(overrides));
  }
  if (extra)
    deepMerge(merged, structuredClone(extra) as Record<string, unknown>);
  return merged as JsonObject;
}
