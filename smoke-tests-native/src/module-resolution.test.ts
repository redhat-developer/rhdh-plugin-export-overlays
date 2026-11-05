/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import Module from "node:module";
import {
  dynamicPackageJsonPath,
  patchDynamicPackageJsonResolution,
} from "./module-resolution";

const API = "/h/node_modules/@backstage/backend-plugin-api/dist";
const plugins = [
  { name: "@x/plugin-foo-backend-dynamic", path: "/root/x-plugin-foo-backend" },
  { name: "@x/plugin-bar-backend", path: "/root/x-plugin-bar-backend" },
];

test("resolvePackagePath's request maps to the -dynamic plugin, as in RHDH", () => {
  // The failure it fixes: adoption-insights, bulk-import, notifications… loaded in RHDH
  // and failed here with "Cannot find module '<pkg>/package.json'".
  assert.equal(
    dynamicPackageJsonPath("@x/plugin-foo-backend/package.json", API, plugins),
    join("/root/x-plugin-foo-backend", "package.json"),
  );
  assert.equal(
    dynamicPackageJsonPath("@x/plugin-bar-backend/package.json", API, plugins),
    join("/root/x-plugin-bar-backend", "package.json"),
  );
});

test("only requests from backend-plugin-api are redirected", () => {
  // Anything else failing to resolve is a real missing dependency.
  assert.equal(
    dynamicPackageJsonPath(
      "@x/plugin-foo-backend/package.json",
      "/root/x-plugin-foo-backend/dist",
      plugins,
    ),
    undefined,
  );
  assert.equal(
    dynamicPackageJsonPath(
      "@x/plugin-foo-backend/package.json",
      undefined,
      plugins,
    ),
    undefined,
  );
});

test("non-package.json requests and unknown packages are left alone", () => {
  assert.equal(
    dynamicPackageJsonPath("@x/plugin-foo-backend", API, plugins),
    undefined,
  );
  assert.equal(
    dynamicPackageJsonPath("@x/plugin-nope/package.json", API, plugins),
    undefined,
  );
});

type ResolveFilename = (request: string, parent: object) => string;
// Read at call time: the patch replaces the property, so a saved reference is the original.
const nodeModule = Module as unknown as { _resolveFilename: ResolveFilename };

test("the patch redirects only what Node itself cannot resolve", () => {
  const original = nodeModule._resolveFilename;
  const unpatch = patchDynamicPackageJsonResolution(plugins);
  try {
    assert.notEqual(nodeModule._resolveFilename, original);
    const fromApi = { path: API, paths: [] as string[] };
    assert.equal(
      nodeModule._resolveFilename(
        "@x/plugin-foo-backend/package.json",
        fromApi,
      ),
      join("/root/x-plugin-foo-backend", "package.json"),
    );
    // Resolvable normally: Node's answer, untouched.
    assert.equal(
      nodeModule._resolveFilename("node:path", fromApi),
      original.call(Module, "node:path", fromApi),
    );
    // Not from backend-plugin-api: Node's own error comes back.
    assert.throws(
      () =>
        nodeModule._resolveFilename("@x/plugin-foo-backend/package.json", {
          path: "/elsewhere",
          paths: [],
        }),
      { code: "MODULE_NOT_FOUND" },
    );
  } finally {
    unpatch();
  }
  assert.equal(nodeModule._resolveFilename, original);
});
