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
