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

/**
 * Narrow an unknown to a plain object.
 *
 * `Array.isArray` is not redundant with the typeof: `typeof [] === "object"`, so without
 * it a list narrows to a record and `Object.keys` on it yields "0", "1", … — indices
 * read as field names. Every caller here parses JSON or YAML that no schema validates at
 * rest, which is why the array case is reachable rather than theoretical.
 *
 * Here rather than beside any one caller, for the reason `compareStrings` is: the same
 * three-clause predicate had been written out independently in several modules, and one
 * of them forgetting a clause is a bug that reads as working code.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Message of a thrown value, whatever it turned out to be. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
