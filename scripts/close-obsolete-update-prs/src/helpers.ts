/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
 * Sanitizes input strings before logging to prevent log injection (CWE-117 / S5145).
 * Replaces newlines, carriage returns, and control characters with a safe space.
 */
export function sanitizeLog(text: string | number | undefined | null): string {
  if (text === null || text === undefined) {
    return "";
  }
  return String(text)
    .replace(/[\r\n]/g, " ")
    .trim();
}

export function sanitizeNumber(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    return 0;
  }
  return Math.trunc(n);
}
