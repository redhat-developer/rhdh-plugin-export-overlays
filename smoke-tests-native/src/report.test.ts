/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  isReport,
  isSweepSummary,
  REPORT_SCHEMA_VERSION,
  SWEEP_SCHEMA_VERSION,
} from "./report";

function validReport(): Record<string, unknown> {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    cliVersion: "0.3.0",
    backend: { total: 1, loaded: 1, skipped: [], errors: [] },
    backendStart: { ok: true },
    frontend: { total: 0, valid: 0, errors: [], bundles: [] },
    exclusions: [],
    status: "pass",
  };
}

function validSummary(): Record<string, unknown> {
  return {
    schemaVersion: SWEEP_SCHEMA_VERSION,
    support: "community",
    shard: { index: 0, total: 1 },
    workspaces: [],
    status: "pass",
  };
}

test("isReport accepts a report at the current schema version", () => {
  assert.equal(isReport(validReport()), true);
});

test("isReport rejects another schema version", () => {
  // The whole point of the version field: a v1 report reaching a v2 consumer would
  // otherwise be read as valid and its missing fields counted as zeros.
  assert.equal(
    isReport({ ...validReport(), schemaVersion: REPORT_SCHEMA_VERSION - 1 }),
    false,
  );
});

test("isReport rejects non-reports", () => {
  assert.equal(isReport(null), false);
  assert.equal(isReport("a string"), false);
  assert.equal(isReport([validReport()]), false);
  const missingBackend = validReport();
  delete missingBackend.backend;
  assert.equal(isReport(missingBackend), false);
});

for (const key of ["backend", "frontend", "backendStart"] as const) {
  test(`isReport rejects a report whose ${key} is not an object`, () => {
    // isRecord rejects arrays as well as primitives; both reach the aggregator as
    // NaN totals or a crash if they slip through.
    assert.equal(isReport({ ...validReport(), [key]: [] }), false);
    assert.equal(isReport({ ...validReport(), [key]: undefined }), false);
    assert.equal(isReport({ ...validReport(), [key]: "x" }), false);
  });
}

test("isReport rejects a non-string status", () => {
  assert.equal(isReport({ ...validReport(), status: 0 }), false);
});

test("isSweepSummary accepts a summary at the current schema version", () => {
  assert.equal(isSweepSummary(validSummary()), true);
});

test("isSweepSummary rejects another schema version or a broken shard", () => {
  assert.equal(
    isSweepSummary({
      ...validSummary(),
      schemaVersion: SWEEP_SCHEMA_VERSION + 1,
    }),
    false,
  );
  // shard.index drives the --expect-shards completeness check, so a summary without
  // a usable index must not count towards it.
  assert.equal(isSweepSummary({ ...validSummary(), shard: {} }), false);
  assert.equal(isSweepSummary({ ...validSummary(), workspaces: {} }), false);
});
