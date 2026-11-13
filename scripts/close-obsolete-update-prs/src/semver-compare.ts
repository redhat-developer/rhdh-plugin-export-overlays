/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import semver from "semver";

const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

/**
 * Checks whether a ref string is a valid semver version or version tag (e.g. '1.54.9' or 'v1.54.9').
 * Explicitly rejects commit SHAs (7 to 40 hex characters) to avoid false coercion.
 */
export function isSemverTag(ref: string): boolean {
  const trimmed = ref.trim();
  if (COMMIT_SHA_PATTERN.test(trimmed)) {
    return false;
  }
  const stripped = trimmed.startsWith("v") || trimmed.startsWith("V") ? trimmed.slice(1) : trimmed;
  return semver.valid(stripped) !== null || semver.clean(stripped, { loose: true }) !== null;
}

/**
 * Normalizes a version string for semver parsing.
 * Handles leading 'v' (e.g. 'v1.54.9') or loose version strings.
 */
export function cleanVersion(rawVersion: string): string | null {
  const trimmed = rawVersion.trim();
  const cleaned = semver.clean(trimmed, { loose: true });
  if (cleaned) {
    return cleaned;
  }
  const coerced = semver.coerce(trimmed, { loose: true });
  return coerced ? coerced.version : null;
}

/**
 * Compares two versions using semantic versioning.
 * Returns:
 *   1 if v1 > v2
 *  -1 if v1 < v2
 *   0 if v1 == v2
 * Falls back to string localeCompare if both cannot be parsed by semver.
 */
export function compareVersions(v1: string, v2: string): number {
  const c1 = cleanVersion(v1);
  const c2 = cleanVersion(v2);

  if (c1 && c2) {
    return semver.compare(c1, c2);
  }
  if (c1 && !c2) {
    return 1;
  }
  if (!c1 && c2) {
    return -1;
  }
  return v1.localeCompare(v2);
}

/**
 * Checks whether candidateVersion is strictly newer than baseVersion.
 */
export function isNewerVersion(candidateVersion: string, baseVersion: string): boolean {
  return compareVersions(candidateVersion, baseVersion) > 0;
}

/**
 * Checks whether two versions are equivalent under semver.
 */
export function isEqualVersion(v1: string, v2: string): boolean {
  return compareVersions(v1, v2) === 0;
}
