/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverPlugins } from "./loader";
import { describeInstallShortfall } from "./harness-logic";
import { tempDir } from "./test-support";

type Installed = { name: string; role?: string; packageJson?: string };

/**
 * Lay out an install root the way the CLI does: one directory per plugin, each with a
 * package.json whose `backstage.role` classifies it. A ref whose package never landed
 * simply has no directory here.
 */
function installRoot(packages: Installed[]): string {
  const root = tempDir(join(tmpdir(), "install-root-"));
  for (const pkg of packages) {
    const dir = join(root, pkg.name.replace(/[@/]/g, "-"));
    mkdirSync(dir, { recursive: true });
    if (pkg.packageJson === undefined) {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: pkg.name,
          version: "1.0.0",
          ...(pkg.role ? { backstage: { role: pkg.role } } : {}),
        }),
      );
    } else if (pkg.packageJson !== "") {
      writeFileSync(join(dir, "package.json"), pkg.packageJson);
    }
  }
  return root;
}

/** What native-smoke composes: discovered count against the declared ref count. */
function shortfallFor(root: string, declaredRefs: number): string | null {
  const manifest = discoverPlugins(root);
  return describeInstallShortfall(
    manifest.backend.length + manifest.frontend.length,
    declaredRefs,
    // Catalog-index mode as production configures it (native-smoke.ts): one image can
    // carry several plugins, so only a shortfall is a fault.
    { subject: "catalog index", allowExtra: true },
  );
}

test("a package that never landed leaves the install short, naming both counts", () => {
  // Two of three declared refs landed — the shape RHDHBUGS-3745 found in the field,
  // where a published dynamicArtifact pointed at a tag that was never built.
  const root = installRoot([
    { name: "@scope/plugin-a", role: "backend-plugin" },
    { name: "@scope/plugin-b", role: "frontend-plugin" },
  ]);
  const manifest = discoverPlugins(root);
  assert.deepEqual(
    manifest.backend.map((p) => p.name),
    ["@scope/plugin-a"],
  );
  assert.deepEqual(
    manifest.frontend.map((p) => p.name),
    ["@scope/plugin-b"],
  );

  const shortfall = shortfallFor(root, 3);
  assert.notEqual(
    shortfall,
    null,
    "a package that never landed must fail the run, not pass quietly",
  );
  assert.match(shortfall ?? "", /installed 2 plugin\(s\)/);
  assert.match(shortfall ?? "", /declared 3 oci:\/\/ ref\(s\)/);
  assert.match(
    shortfall ?? "",
    /part of the catalog index was never validated/,
  );
});

test("an install root that produced no plugins is reported off the layer itself", () => {
  const root = installRoot([]);
  assert.match(
    describeInstallShortfall(
      (() => {
        const m = discoverPlugins(root);
        return m.backend.length + m.frontend.length;
      })(),
      undefined,
    ) ?? "",
    /nothing validated: the install produced no plugins at all/,
  );
});

test("a directory without a backstage role does not close the gap left by a missing package", () => {
  // Counting it would hide the shortfall by making the totals agree for the wrong reason.
  const root = installRoot([
    { name: "@scope/plugin-a", role: "backend-plugin" },
    { name: "@scope/not-a-plugin" },
  ]);
  assert.equal(discoverPlugins(root).backend.length, 1);
  assert.notEqual(shortfallFor(root, 2), null);
});

test("a package.json that cannot be parsed does not count as an installed plugin", () => {
  // The artifact extracted, but what it laid out is not readable. Counting it would
  // report a broken package as a working one.
  const root = installRoot([
    { name: "@scope/plugin-a", role: "backend-plugin" },
    { name: "@scope/plugin-b", packageJson: "{ not json" },
  ]);
  assert.equal(discoverPlugins(root).backend.length, 1);
  assert.notEqual(shortfallFor(root, 2), null);
});

test("a directory with no package.json at all does not count as an installed plugin", () => {
  const root = installRoot([
    { name: "@scope/plugin-a", role: "backend-plugin" },
    { name: "@scope/plugin-b", packageJson: "" },
  ]);
  assert.equal(discoverPlugins(root).backend.length, 1);
  assert.notEqual(shortfallFor(root, 2), null);
});
