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
