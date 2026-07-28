/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import type { JsonObject } from '@backstage/types';

/**
 * Narrows a parsed-YAML value to a plain mapping.
 *
 * One guard rather than one per module: metadata.ts and schema.ts inspect the
 * same `appConfigExamples[].content` values, so two copies would be free to
 * drift apart while still being applied to identical input.
 */
export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
