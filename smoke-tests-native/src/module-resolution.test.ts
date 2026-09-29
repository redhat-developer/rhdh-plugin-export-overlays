/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { dynamicPackageJsonPath } from "./module-resolution";

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
