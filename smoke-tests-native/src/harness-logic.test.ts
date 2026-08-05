/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  computeStatus,
  describeInstallShortfall,
  partitionBootable,
} from "./harness-logic";
import type { PluginEntry, PluginError } from "./loader";

function entry(name: string, dirName = name): PluginEntry {
  return {
    name,
    version: "1",
    dirName,
    path: `/p/${dirName}`,
    role: "backend",
  };
}
const anError: PluginError = { plugin: entry("@s/p"), error: "boom" };

test("computeStatus reports the most specific failure and passes only on a clean run", () => {
  assert.equal(computeStatus([], true, 3, []), "pass");
  assert.equal(computeStatus([anError], true, 3, []), "fail-load");
  // A load error outranks everything: the rest failed because of it.
  assert.equal(computeStatus([anError], false, 3, [anError]), "fail-load");
  assert.equal(computeStatus([], false, 3, []), "fail-start");
  assert.equal(computeStatus([], false, 3, [anError]), "fail-start");
  assert.equal(computeStatus([], true, 0, [anError]), "fail-bundle");
});

test("a frontend-only workspace passes even though no backend started", () => {
  // startBackend short-circuits to {ok:true, skipped:true} when nothing loaded, so
  // startOk=false with loadedCount=0 is not reachable as a real boot failure.
  assert.equal(computeStatus([], false, 0, []), "pass");
});

test("describeInstallShortfall compares what installed against what was declared", () => {
  assert.equal(describeInstallShortfall(3, 3), null);
  assert.match(describeInstallShortfall(2, 3) ?? "", /installed 2 plugin\(s\)/);
  assert.match(describeInstallShortfall(2, 3) ?? "", /declared 3/);
  assert.match(
    describeInstallShortfall(2, 3) ?? "",
    /part of the workspace was never validated/,
  );
  // More than declared is just as wrong as fewer — it means something unexpected
  // landed in the install root.
  assert.notEqual(describeInstallShortfall(4, 3), null);
});

test("describeInstallShortfall has nothing to compare in single-ref mode", () => {
  // --dynamic-plugins file mode knows no ref count; only "nothing at all" is a fault.
  assert.equal(describeInstallShortfall(3, undefined), null);
  assert.match(
    describeInstallShortfall(0, undefined) ?? "",
    /produced no plugins at all/,
  );
});

test("partitionBootable keeps the skipped and bootable lists complementary", () => {
  const entries = [entry("@s/a"), entry("@s/b"), entry("@s/c")];
  const { skipped, excluded, bootable } = partitionBootable(
    entries,
    (name) => (name === "@s/a" ? { ticket: "RHIDP-1" } : undefined),
    (dirName) => dirName === "@s/b",
  );
  assert.deepEqual(
    bootable.map((e) => e.name),
    ["@s/c"],
  );
  assert.deepEqual(skipped, ["@s/a", "@s/b"]);
  assert.deepEqual(excluded, [{ ticket: "RHIDP-1" }]);
  assert.equal(skipped.length + bootable.length, entries.length);
});
