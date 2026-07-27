/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAppConfig, loadEnvFile } from "./test-config";

const dir = mkdtempSync(join(tmpdir(), "test-config-"));

function file(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

test("loadEnvFile applies KEY=VALUE lines, strips quotes, skips comments", () => {
  const path = file(
    "basic.env",
    '# comment\nTC_FOO=bar\nTC_QUOTED="q v"\n\nTC_SINGLE=\'s v\'\n',
  );
  const applied = loadEnvFile(path);
  assert.deepEqual(applied.sort(), ["TC_FOO", "TC_QUOTED", "TC_SINGLE"]);
  assert.equal(process.env.TC_FOO, "bar");
  assert.equal(process.env.TC_QUOTED, "q v");
  assert.equal(process.env.TC_SINGLE, "s v");
});

test("loadEnvFile never overrides pre-set env (CI secrets win)", () => {
  process.env.TC_PRESET = "from-ci";
  const path = file("preset.env", "TC_PRESET=from-file\n");
  assert.deepEqual(loadEnvFile(path), []);
  assert.equal(process.env.TC_PRESET, "from-ci");
});

test("loadEnvFile ignores malformed lines without applying them", () => {
  const path = file("broken.env", "BROKEN_LINE\n=novalue\nTC_OK=1\n");
  assert.deepEqual(loadEnvFile(path), ["TC_OK"]);
});

test("loadAppConfig substitutes ${VAR} and ${VAR:-default}", () => {
  process.env.TC_SET = "value";
  const path = file(
    "subst.yaml",
    'a: "x ${TC_SET}"\nb: ${TC_UNSET_1:-fallback}\n',
  );
  const cfg = loadAppConfig(path) as { a: string; b: string };
  assert.equal(cfg.a, "x value");
  assert.equal(cfg.b, "fallback");
});

test("loadAppConfig: $$ escapes to a literal ${...}", () => {
  const path = file("escape.yaml", 'a: "$${TC_SET}"\n');
  assert.equal((loadAppConfig(path) as { a: string }).a, "${TC_SET}");
});

test("loadAppConfig drops keys and array items referencing unset vars with no default", () => {
  const path = file(
    "drop.yaml",
    "kept: ok\ndropped: ${TC_UNSET_2}\nlist:\n  - ok\n  - ${TC_UNSET_2}\n",
  );
  const cfg = loadAppConfig(path) as { kept: string; list: string[] };
  assert.equal(cfg.kept, "ok");
  assert.equal("dropped" in cfg, false);
  assert.deepEqual(cfg.list, ["ok"]);
});

test("loadAppConfig returns {} for an empty file and rejects non-mappings", () => {
  assert.deepEqual(loadAppConfig(file("empty.yaml", "")), {});
  assert.throws(
    () => loadAppConfig(file("list.yaml", "- a\n- b\n")),
    TypeError,
  );
});
