/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * Optional test-config inputs, mirroring what the Docker smoke supplies to the RHDH
 * container (run-workspace-smoke-tests.yaml): a `test.env` env file (`docker run
 * --env-file`) and an `app-config.test.yaml` extra config layer (`--config` mount).
 * Workspaces keep these under `workspaces/<name>/smoke-tests/`.
 */

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { JsonObject } from "@backstage/types";

/**
 * Load KEY=VALUE pairs from an env file into process.env. Pre-set variables win, so
 * real secrets provided by the environment/CI take precedence over the committed
 * test placeholders. Returns the names of the variables actually applied.
 */
export function loadEnvFile(path: string): string[] {
  const applied: string[] = [];
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

// ${VAR} / ${VAR:-default} — the substitution the Backstage config loader would
// perform when the Docker smoke mounts app-config.test.yaml into the container.
// mockServices.rootConfig takes literal data, so it must happen here instead.
function substituteEnv(value: string): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, name: string, fallback?: string) => process.env[name] ?? fallback ?? "",
  );
}

function substituteDeep(node: unknown): unknown {
  if (typeof node === "string") return substituteEnv(node);
  if (Array.isArray(node)) return node.map(substituteDeep);
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [key, substituteDeep(value)]),
    );
  }
  return node;
}

/** Parse an app-config YAML layer, applying ${VAR}/${VAR:-default} substitution. */
export function loadAppConfig(path: string): JsonObject {
  const doc: unknown = parse(readFileSync(path, "utf8"));
  if (doc === null || doc === undefined) return {};
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`app-config must be a YAML mapping: ${path}`);
  }
  return substituteDeep(doc) as JsonObject;
}
