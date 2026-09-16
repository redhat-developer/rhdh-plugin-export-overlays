/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { after, test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverPlugins } from "./loader";
import { describeInstallShortfall } from "./harness-logic";

const TEMP_DIRS: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(prefix);
  TEMP_DIRS.push(dir);
  return dir;
}
after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

/**
 * Lay out an install root the way the CLI does: one directory per plugin, each with a
 * package.json whose `backstage.role` classifies it. `packages` is what actually landed;
 * a ref whose package is missing from the layer simply has no directory here.
 */
function installRoot(packages: { name: string; role: string }[]): string {
  const root = tempDir(join(tmpdir(), "install-root-"));
  for (const pkg of packages) {
    const dir = join(root, pkg.name.replace(/[@/]/g, "-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: pkg.name,
        version: "1.0.0",
        backstage: { role: pkg.role },
      }),
    );
  }
  return root;
}

test("a declared package missing from the layer is reported, naming both counts", () => {
  // Two of the three declared refs landed. This is the shape RHDHBUGS-3745 found in the
  // field: a published dynamicArtifact pointing at a tag that was never built, so the
  // pull silently produces nothing and the install is short by one package.
  const root = installRoot([
    { name: "@scope/plugin-a", role: "backend-plugin" },
    { name: "@scope/plugin-b", role: "frontend-plugin" },
  ]);
  const manifest = discoverPlugins(root);
  const discovered = manifest.backend.length + manifest.frontend.length;
  assert.equal(discovered, 2);

  const shortfall = describeInstallShortfall(discovered, 3, {
    subject: "catalog index",
  });
  assert.notEqual(
    shortfall,
    null,
    "a missing package must fail the run, not pass quietly",
  );
  assert.match(shortfall ?? "", /installed 2 plugin\(s\)/);
  assert.match(shortfall ?? "", /declared 3 oci:\/\/ ref\(s\)/);
  assert.match(
    shortfall ?? "",
    /part of the catalog index was never validated/,
  );
});

test("an install that produced nothing at all says so, rather than reporting a count", () => {
  // The whole-artifact case: nothing extracted, so there is no package to name. Without
  // a declared count to compare against there is still a finding to make.
  const root = installRoot([]);
  const manifest = discoverPlugins(root);
  assert.equal(manifest.backend.length + manifest.frontend.length, 0);

  assert.match(
    describeInstallShortfall(0, undefined) ?? "",
    /nothing validated: the install produced no plugins at all/,
  );
});

test("a directory without a backstage role is not counted as an installed plugin", () => {
  // A layer can carry directories the CLI did not lay out as plugins. Counting them
  // would hide a shortfall by making the totals agree for the wrong reason.
  const root = installRoot([
    { name: "@scope/plugin-a", role: "backend-plugin" },
  ]);
  const stray = join(root, "not-a-plugin");
  mkdirSync(stray, { recursive: true });
  writeFileSync(
    join(stray, "package.json"),
    JSON.stringify({ name: "@scope/not-a-plugin", version: "1.0.0" }),
  );

  const manifest = discoverPlugins(root);
  assert.equal(manifest.backend.length + manifest.frontend.length, 1);
  assert.notEqual(describeInstallShortfall(1, 2), null);
});
