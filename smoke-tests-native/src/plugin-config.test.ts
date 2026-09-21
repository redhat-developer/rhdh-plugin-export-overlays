/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { JsonObject } from "@backstage/types";
import type { LoadedPlugin } from "./loader";
import { buildMergedConfig } from "./plugin-config";

function loaded(dirName: string): LoadedPlugin {
  return {
    plugin: {
      name: dirName,
      version: "1",
      dirName,
      path: "/p",
      role: "backend",
    },
    feature: {} as LoadedPlugin["feature"],
  };
}

test("buildMergedConfig always supplies the core keys plugins read", () => {
  const merged = buildMergedConfig([]);
  assert.deepEqual(merged.app, { baseUrl: "http://localhost:3000" });
  assert.deepEqual(merged.backend, { baseUrl: "http://localhost:7007" });
});

test("buildMergedConfig merges the dummies of every loaded plugin", () => {
  const merged = buildMergedConfig([
    loaded("backstage-community-plugin-quay-backend"),
    loaded("backstage-community-plugin-jenkins-backend"),
  ]);
  assert.ok(merged.quay, "quay dummy missing");
  assert.ok(merged.jenkins, "jenkins dummy missing");
});

test("the caller's app-config layer wins over the built-in dummies", () => {
  // Same precedence the Docker smoke gives its extra --config mount. If this inverted,
  // every workspace's smoke-tests/app-config.test.yaml would be silently overridden and
  // the resulting boot failures would point at the plugin.
  const merged = buildMergedConfig(
    [loaded("backstage-community-plugin-lighthouse-backend")],
    { lighthouse: { baseUrl: "http://override:9999" } },
  );
  assert.equal(
    (merged.lighthouse as JsonObject).baseUrl,
    "http://override:9999",
  );
});

test("buildMergedConfig does not leak one call's config into the next", () => {
  // deepMerge assigns source values by reference when the target key is absent, so
  // merging an override directly made the result BE the module constant — and the
  // caller's layer then wrote into it, poisoning every later call in the process.
  const plugins = [loaded("immobiliarelabs-backstage-plugin-gitlab-backend")];
  buildMergedConfig(plugins, {
    integrations: { gitlab: [{ host: "github.com", token: "LEAKED" }] },
  });
  const second = buildMergedConfig(plugins);
  assert.deepEqual(second.integrations, {
    gitlab: [{ host: "gitlab.com", token: "test" }],
  });
});

test("buildMergedConfig does not mutate the caller's extra layer either", () => {
  const extra: JsonObject = { integrations: { gitlab: [{ host: "a.com" }] } };
  buildMergedConfig(
    [loaded("immobiliarelabs-backstage-plugin-gitlab-backend")],
    extra,
  );
  assert.deepEqual(extra, { integrations: { gitlab: [{ host: "a.com" }] } });
});

test("two plugins contributing to one section concatenate rather than clobber", () => {
  const merged = buildMergedConfig(
    [loaded("immobiliarelabs-backstage-plugin-gitlab-backend")],
    { integrations: { gitlab: [{ host: "extra.com", token: "t" }] } },
  );
  assert.deepEqual((merged.integrations as JsonObject).gitlab, [
    { host: "gitlab.com", token: "test" },
    { host: "extra.com", token: "t" },
  ]);
});
