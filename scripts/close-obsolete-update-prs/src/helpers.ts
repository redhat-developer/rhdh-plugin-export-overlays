/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

/**
 * Narrows a parsed JSON or YAML value to a plain mapping object (non-null, non-array).
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Safely reads a property from an error or unknown object without unsafe type casting.
 * Node and third-party libraries attach extra properties (such as 'status' or 'code')
 * to Error instances that are not declared on the base Error interface.
 */
export function errorProperty(error: unknown, key: string): unknown {
  if (typeof error !== "object" || error === null || !(key in error)) {
    return undefined;
  }
  return Reflect.get(error, key);
}

export function trimTrailingSlashes(url: string): string {
  let result = url;
  while (result.endsWith("/")) {
    result = result.slice(0, -1);
  }
  return result;
}

/**
 * Sanitizes input strings before logging to prevent log injection (CWE-117 / S5145)
 * and GitHub Actions workflow command injection.
 * Replaces newlines, carriage returns, and percent-encoded newlines with a safe space,
 * and neutralizes GHA '::' command tokens.
 */
export function sanitizeLog(text: string | number | undefined | null): string {
  if (text === null || text === undefined) {
    return "";
  }
  return String(text)
    .replace(/[\r\n]/g, " ")
    .replace(/%(?:0a|0d|0A|0D)/g, " ")
    .replaceAll("::", ": :")
    .trim();
}

export function sanitizeNumber(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    return 0;
  }
  return Math.trunc(n);
}
