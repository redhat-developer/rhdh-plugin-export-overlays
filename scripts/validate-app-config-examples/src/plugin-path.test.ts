/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

// The registry is mocked: each test hands the checker a fetch that answers
// from a table, so no test touches the network or needs skopeo.

import { describe, expect, it } from "vite-plus/test";
import {
  PluginPathChecker,
  classifySkopeoError,
  fetchWithRetry,
  isOwnImage,
  mapWithConcurrency,
  type FetchManifest,
  type ManifestResult,
} from "./plugin-path.ts";

const OWN = "ghcr.io/redhat-developer/rhdh-plugin-export-overlays";
const NO_DELAY = { retryDelayMs: 0 };

/** A manifest whose annotation declares `paths`, as `plugin package` writes it. */
function manifest(...paths: string[]): ManifestResult {
  const entries = paths.map((path) => ({ [path]: {} }));
  return {
    kind: "ok",
    manifest: JSON.stringify({
      annotations: {
        "io.backstage.dynamic-packages": Buffer.from(JSON.stringify(entries)).toString("base64"),
      },
    }),
  };
}

/** A fetch answering from `table` (one answer per call, last one repeated). */
function fakeRegistry(table: Record<string, ManifestResult[]>) {
  const calls: string[] = [];
  const fetch: FetchManifest = async (image) => {
    calls.push(image);
    const answers = table[image] ?? [{ kind: "missing", reason: "manifest unknown" }];
    const seen = calls.filter((call) => call === image).length;
    return answers[Math.min(seen, answers.length) - 1] ?? answers[0]!;
  };
  return { fetch, calls };
}

describe("PluginPathChecker", () => {
  it("reports a selector the image does not declare (azure)", async () => {
    const image = `${OWN}/azure:bs_1.54.9__0.2.25`;
    const { fetch } = fakeRegistry({ [image]: [manifest("azure")] });
    await expect(
      new PluginPathChecker(fetch, NO_DELAY).check(`oci://${image}!azure-dynamic`),
    ).resolves.toEqual({
      kind: "mismatch",
      problem: "selects !azure-dynamic, but the image declares azure",
    });
  });

  it("accepts a selector the image declares", async () => {
    const image = `${OWN}/x2a-dcr:bs_1.54.9__1.0.0`;
    const { fetch } = fakeRegistry({ [image]: [manifest("x2a-dcr")] });
    await expect(
      new PluginPathChecker(fetch, NO_DELAY).check(`oci://${image}!x2a-dcr`),
    ).resolves.toEqual({ kind: "ok" });
  });

  it("reports a ref with no selector to a multi-plugin image (cost-management)", async () => {
    const image = "quay.io/org/dynamic-plugins:2.4.2";
    const { fetch } = fakeRegistry({ [image]: [manifest("frontend", "backend")] });
    const outcome = await new PluginPathChecker(fetch, NO_DELAY).check(`oci://${image}`);
    expect(outcome.kind).toBe("mismatch");
  });

  it("fetches an image once for every ref that names it", async () => {
    const image = "quay.io/org/dynamic-plugins:2.4.2";
    const { fetch, calls } = fakeRegistry({ [image]: [manifest("frontend", "backend")] });
    const checker = new PluginPathChecker(fetch, NO_DELAY);
    await checker.check(`oci://${image}!frontend`);
    await checker.check(`oci://${image}!backend`);
    expect(calls).toEqual([image]);
  });

  it("follows the installer's fallback from the productized registry to quay", async () => {
    const { fetch, calls } = fakeRegistry({ "quay.io/rhdh/a:1": [manifest("a")] });
    await expect(
      new PluginPathChecker(fetch, NO_DELAY).check("oci://registry.access.redhat.com/rhdh/a:1!a"),
    ).resolves.toEqual({ kind: "ok" });
    expect(calls).toEqual(["registry.access.redhat.com/rhdh/a:1", "quay.io/rhdh/a:1"]);
  });

  it("calls a ref unavailable when one candidate did not answer", async () => {
    const { fetch } = fakeRegistry({
      "registry.access.redhat.com/rhdh/a:1": [{ kind: "unavailable", reason: "timeout" }],
    });
    const outcome = await new PluginPathChecker(fetch, NO_DELAY).check(
      "oci://registry.access.redhat.com/rhdh/a:1!a",
    );
    expect(outcome.kind).toBe("unavailable");
  });

  it("rejects a malformed ref before asking the registry", async () => {
    // A registry answering missing would otherwise turn an own ref into "not published yet".
    const { fetch, calls } = fakeRegistry({});
    await expect(
      new PluginPathChecker(fetch, NO_DELAY).check(`oci://${OWN}/a:bs_1.54.9__1.0.0!`),
    ).resolves.toEqual({
      kind: "mismatch",
      problem: expect.stringMatching(/not a ref the install CLI accepts/),
    });
    expect(calls).toEqual([]);
  });

  it("stops fetching once the run's budget is spent, and calls the rest unavailable", async () => {
    const { fetch, calls } = fakeRegistry({});
    const outcome = await new PluginPathChecker(fetch, { ...NO_DELAY, budgetMs: 0 }).check(
      `oci://${OWN}/a:1!a`,
    );
    expect(outcome).toEqual({
      kind: "unavailable",
      reason: "not tried: the run's 0s budget ran out",
    });
    expect(calls).toEqual([]);
  });

  it("calls a ref missing when no candidate has the image", async () => {
    const { fetch } = fakeRegistry({});
    const outcome = await new PluginPathChecker(fetch, NO_DELAY).check(`oci://${OWN}/a:1!a`);
    expect(outcome).toEqual({ kind: "missing", reason: "manifest unknown" });
  });
});

describe("fetchWithRetry", () => {
  it("retries an unavailable registry until it answers", async () => {
    const { fetch, calls } = fakeRegistry({
      img: [{ kind: "unavailable", reason: "502" }, manifest("a")],
    });
    await expect(fetchWithRetry(fetch, "img", NO_DELAY)).resolves.toEqual(manifest("a"));
    expect(calls).toHaveLength(2);
  });

  it("gives up after the last attempt", async () => {
    const { fetch, calls } = fakeRegistry({ img: [{ kind: "unavailable", reason: "502" }] });
    const result = await fetchWithRetry(fetch, "img", { attempts: 3, retryDelayMs: 0 });
    expect(result.kind).toBe("unavailable");
    expect(calls).toHaveLength(3);
  });

  it("starts no retry once the deadline has passed", async () => {
    const { fetch, calls } = fakeRegistry({ img: [{ kind: "unavailable", reason: "502" }] });
    const result = await fetchWithRetry(fetch, "img", { ...NO_DELAY, deadline: 0 });
    expect(result.kind).toBe("unavailable");
    expect(calls).toHaveLength(1);
  });

  it("does not retry an image the registry says is missing", async () => {
    const { fetch, calls } = fakeRegistry({});
    await fetchWithRetry(fetch, "img", NO_DELAY);
    expect(calls).toHaveLength(1);
  });
});

const failed = (stderr: string) => Object.assign(new Error("exit 1"), { stderr });

describe("classifySkopeoError", () => {
  it("reads a registry's 'no such image' answers as missing", () => {
    for (const stderr of [
      'level=fatal msg="reading manifest x in ghcr.io/o/a: manifest unknown"',
      'level=fatal msg="Requesting bearer token: received unexpected HTTP status: 403 Forbidden"',
      'level=fatal msg="reading manifest 1 in quay.io/o/nope: unauthorized: access ..."',
    ]) {
      expect(classifySkopeoError(failed(stderr)).kind, stderr).toBe("missing");
    }
  });

  it("reads anything else as unavailable, so it is retried", () => {
    const result = classifySkopeoError(failed("pinging container registry: connection reset"));
    expect(result).toEqual({
      kind: "unavailable",
      reason: "pinging container registry: connection reset",
    });
  });

  it("reads a killed run as unavailable", () => {
    expect(classifySkopeoError(Object.assign(new Error("x"), { killed: true }))).toEqual({
      kind: "unavailable",
      reason: "no answer within 30s",
    });
  });

  it("throws when skopeo is not installed", () => {
    expect(() => classifySkopeoError(Object.assign(new Error("x"), { code: "ENOENT" }))).toThrow(
      /skopeo not found/,
    );
  });
});

describe("isOwnImage", () => {
  it("is true only for this repository's ghcr images", () => {
    expect(isOwnImage(`oci://${OWN}/a:bs_1__1!a`)).toBe(true);
    expect(isOwnImage("oci://quay.io/org/dynamic-plugins:2.4.2")).toBe(false);
  });
});

describe("mapWithConcurrency", () => {
  it("keeps input order and never runs more tasks than the limit", async () => {
    let running = 0;
    let peak = 0;
    const results = await mapWithConcurrency([30, 10, 20, 0], 2, async (ms) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, ms));
      running -= 1;
      return ms * 2;
    });
    expect(results).toEqual([60, 20, 40, 0]);
    expect(peak).toBe(2);
  });
});
