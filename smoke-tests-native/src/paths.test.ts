/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { after, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { requireContained, resolveContained } from "./paths";

// Every mkdtempSync here would otherwise leak: the suite left 26 directories in
// $TMPDIR per run, unbounded on a developer machine and on any long-lived runner.
const TEMP_DIRS: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(prefix);
  TEMP_DIRS.push(dir);
  return dir;
}
after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

const root = tempDir(join(tmpdir(), "paths-test-"));

test("resolveContained accepts paths inside the root", () => {
  assert.equal(resolveContained("a.json", root), join(root, "a.json"));
  assert.equal(
    resolveContained("nested/a.json", root),
    join(root, "nested/a.json"),
  );
  // The root itself is in bounds — --in defaults to a directory, not a file.
  assert.equal(resolveContained(".", root), resolve(root));
  assert.equal(resolveContained(root, root), resolve(root));
});

test("resolveContained rejects paths that escape the root", () => {
  assert.equal(resolveContained("../outside.json", root), null);
  assert.equal(resolveContained("/etc/passwd", root), null);
  assert.equal(resolveContained("nested/../../outside.json", root), null);
});

test("resolveContained judges where a path lands, not how it is written", () => {
  // Escaping and coming back is fine: resolve() collapses it before the check.
  assert.equal(
    resolveContained("nested/../a.json", root),
    join(root, "a.json"),
  );
  // A sibling directory sharing the root's name prefix must NOT pass — this is the
  // bug a bare startsWith(root) check has, which is why the separator matters.
  assert.equal(resolveContained(`${root}-sibling/a.json`, root), null);
});

test("resolveContained is lexical, so a symlink out of the root still passes", () => {
  // Known and accepted: containment uses resolve(), not realpathSync(). Pinned so the
  // limitation is a decision on record rather than a surprise — the CLIs only ever
  // resolve paths the caller typed, inside a checkout they control.
  symlinkSync(tmpdir(), join(root, "escape"));
  assert.notEqual(resolveContained("escape/x.json", root), null);
});

test("requireContained throws a flag-labelled usage error", () => {
  assert.equal(requireContained("--out", "a.json", root), join(root, "a.json"));
  assert.throws(
    () => requireContained("--out", "../a.json", root),
    /--out must resolve inside the working directory: \.\.\/a\.json/,
  );
});
