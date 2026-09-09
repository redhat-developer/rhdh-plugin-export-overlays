/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import type { JsonObject } from "@backstage/types";

/**
 * Narrows a parsed-YAML value to a plain mapping.
 *
 * One guard rather than one per module: metadata.ts and schema.ts inspect the
 * same `appConfigExamples[].content` values, so two copies would be free to
 * drift apart while still being applied to identical input.
 */
export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a property the type system does not know an error carries.
 *
 * Node and its libraries hang useful detail off Error instances — `code` on
 * filesystem errors, `stderr` on exec failures, `messages` on config-loader's
 * validation errors — none of which is on the `Error` type. Narrowing that away
 * needs an assertion somewhere; keeping it here means one place to get right
 * rather than one per call site.
 */
export function errorProperty(error: unknown, key: string): unknown {
  if (typeof error !== "object" || error === null || !(key in error)) {
    return undefined;
  }
  return (error as Record<string, unknown>)[key];
}

/**
 * Codepoint order, matching Python's `sorted()`.
 *
 * Deliberately not `localeCompare`, whatever a linter suggests: it is
 * locale-dependent and case-insensitive in several locales, so it would reorder
 * the report and break the byte-identical parity with the script this replaced.
 * Shared so the report order and the patch application order cannot drift.
 */
export function byCodepoint(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}
