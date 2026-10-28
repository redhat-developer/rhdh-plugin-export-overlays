/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

// Plugin-path layer (RHIDP-17312): the installer extracts each OCI ref into the
// directory its `!plugin-path` names, so a selector the image does not declare
// installs nothing and still exits 0. Reads each image's manifest from its
// registry, the way the installer does, and applies the rule shared with the
// native smoke harness.

import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import {
  probeCandidates,
  refFormProblem,
  registryRefFromOciRef,
  selectedPluginPathProblem,
} from "../../../smoke-tests-native/src/plugin-path.ts";
import { errorProperty } from "./json.ts";

/** One manifest fetch. `missing` is an answer; `unavailable` may change on retry. */
export type ManifestResult =
  | { kind: "ok"; manifest: string }
  | { kind: "missing"; reason: string }
  | { kind: "unavailable"; reason: string };

export type FetchManifest = (image: string) => Promise<ManifestResult>;

export type PluginPathOutcome =
  | { kind: "ok" }
  | { kind: "mismatch"; problem: string }
  | { kind: "missing"; reason: string }
  | { kind: "unavailable"; reason: string };

export type RetryOptions = {
  /** Fetches per image before it counts as unavailable. */
  attempts?: number;
  /** Base backoff between fetches of one image, doubled per attempt. */
  retryDelayMs?: number;
  /** Epoch ms after which no retry starts. */
  deadline?: number;
};

export type CheckerOptions = RetryOptions & {
  /** Time for the whole run from its first fetch; later fetches are not started. */
  budgetMs?: number;
};

// Keeps a hanging registry inside the job's timeout, so the tally still prints.
const RUN_BUDGET_MS = 10 * 60_000;

/** Images this repository publishes, under a tag that exists only after merge. */
const OWN_IMAGES = "ghcr.io/redhat-developer/rhdh-plugin-export-overlays/";

export function isOwnImage(ref: string): boolean {
  return registryRefFromOciRef(ref).startsWith(OWN_IMAGES);
}

// Registry answers that a retry cannot change. Anonymous pulls of a repository
// that does not exist get 403 from ghcr and "unauthorized" from quay, and the
// installer pulls anonymously too.
const MISSING_RE =
  /manifest unknown|name unknown|not found|unauthorized|denied|403 Forbidden|invalid reference format/i;

const SKOPEO_TIMEOUT_MS = 30_000;
const execFileAsync = promisify(execFile);

/** Reads a manifest with `skopeo inspect --raw`, as the installer does. */
export const skopeoFetch: FetchManifest = async (image) => {
  try {
    const { stdout } = await execFileAsync("skopeo", ["inspect", "--raw", `docker://${image}`], {
      timeout: SKOPEO_TIMEOUT_MS,
    });
    return { kind: "ok", manifest: stdout };
  } catch (error) {
    return classifySkopeoError(error);
  }
};

/** What a failed skopeo run means for the image it was asked about. */
export function classifySkopeoError(error: unknown): ManifestResult {
  // No skopeo says nothing about any image; recorded per ref it would read
  // as every artifact being broken.
  if (errorProperty(error, "code") === "ENOENT") {
    throw new Error("skopeo not found on PATH: the plugin-path check needs it", {
      cause: error,
    });
  }
  if (errorProperty(error, "killed") === true) {
    return { kind: "unavailable", reason: `no answer within ${SKOPEO_TIMEOUT_MS / 1000}s` };
  }
  const reason = lastLine(errorProperty(error, "stderr")) ?? String(error);
  return MISSING_RE.test(reason) ? { kind: "missing", reason } : { kind: "unavailable", reason };
}

function lastLine(text: unknown): string | undefined {
  if (typeof text !== "string") {
    return undefined;
  }
  return text.trim().split("\n").at(-1)?.trim() || undefined;
}

/** Fetches one image, retrying only what a retry can change. */
export async function fetchWithRetry(
  fetch: FetchManifest,
  image: string,
  { attempts = 3, retryDelayMs = 2000, deadline = Infinity }: RetryOptions = {},
  attempt = 1,
): Promise<ManifestResult> {
  const result = await fetch(image);
  if (result.kind !== "unavailable" || attempt >= attempts || Date.now() >= deadline) {
    return result;
  }
  await sleep(retryDelayMs * 2 ** (attempt - 1));
  return fetchWithRetry(fetch, image, { attempts, retryDelayMs, deadline }, attempt + 1);
}

/**
 * Checks metadata refs against their images. Memoised per image: one bundle
 * can back several metadata files.
 */
export class PluginPathChecker {
  readonly #fetch: FetchManifest;
  readonly #options: RetryOptions;
  readonly #budgetMs: number;
  readonly #manifests = new Map<string, Promise<ManifestResult>>();
  #deadline: number | undefined;

  constructor(
    fetch: FetchManifest = skopeoFetch,
    { budgetMs = RUN_BUDGET_MS, ...options }: CheckerOptions = {},
  ) {
    this.#fetch = fetch;
    this.#options = options;
    this.#budgetMs = budgetMs;
  }

  async check(ref: string): Promise<PluginPathOutcome> {
    // Before any fetch: an unpublished tag must not hide a malformed ref.
    const formProblem = refFormProblem(ref);
    if (formProblem) {
      return { kind: "mismatch", problem: formProblem };
    }
    const reasons: string[] = [];
    let unavailable = false;
    // The installer falls back from the productized registry to quay.
    const candidates = probeCandidates(ref);
    for (const image of candidates) {
      const result = await this.#manifest(image);
      if (result.kind === "ok") {
        const problem = selectedPluginPathProblem(ref, result.manifest);
        return problem ? { kind: "mismatch", problem } : { kind: "ok" };
      }
      unavailable ||= result.kind === "unavailable";
      reasons.push(candidates.length > 1 ? `${image}: ${result.reason}` : result.reason);
    }
    // Unavailable wins: a missing fallback says nothing when the primary
    // registry did not answer.
    return { kind: unavailable ? "unavailable" : "missing", reason: reasons.join("; ") };
  }

  #manifest(image: string): Promise<ManifestResult> {
    let pending = this.#manifests.get(image);
    if (!pending) {
      // The clock starts at the first fetch, not when the checker is built.
      const deadline = (this.#deadline ??= Date.now() + this.#budgetMs);
      pending =
        Date.now() >= deadline
          ? Promise.resolve({
              kind: "unavailable",
              reason: `not tried: the run's ${this.#budgetMs / 1000}s budget ran out`,
            })
          : fetchWithRetry(this.#fetch, image, { ...this.#options, deadline });
      this.#manifests.set(image, pending);
    }
    return pending;
  }
}

/** Runs `task` over `items`, at most `limit` at a time, keeping input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  // One iterator shared by every worker: each takes the next item when free.
  const queue = items.entries();
  const worker = async (): Promise<void> => {
    const next = queue.next();
    if (next.done) {
      return;
    }
    const [index, item] = next.value;
    results[index] = await task(item);
    return worker();
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}
