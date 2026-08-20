/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/** Helpers shared by the harness, the sweep driver and the aggregator. */

/**
 * Ascending comparison by code unit, NOT `localeCompare`.
 *
 * Locale-sensitive collation orders differently across environments, and this
 * comparator backs an ordering the sweep treats as a correctness property: coverage
 * is counted by comparing workspace and package lists, and `comm`/`join` miscount
 * unsorted input without reporting an error (see the note in src/support.ts). One
 * definition, so the two CLIs cannot drift apart on it.
 */
export function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Message of a thrown value, whatever it turned out to be. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
