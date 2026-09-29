/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * Catalog-index mode: validate every package a generated catalog index declares.
 *
 * Reads the `dynamic-plugins.default.yaml` that `update-index.sh` writes, so the check
 * runs before the index image is built — RHDH's equivalent (RHIDP-13508) has to
 * skopeo-copy the published image and walk its layers to recover the same file.
 *
 * Two deliberate departures from the file as written:
 *
 * 1. The index's `enabled:` flags are ignored. Most packages ship disabled as an RHDH
 *    product default, which says nothing about whether the artifact works, so honouring
 *    them would validate almost nothing. Same reasoning as RHDH's
 *    populate-catalog-index.sh.
 * 2. `pluginConfig` blocks are dropped — they hold `${ENV_VAR}` placeholders that exist
 *    in a deployed RHDH and nowhere here. The harness supplies its own dummy config.
 *
 * Exclusions match the OCI IMAGE NAME, the only identifier an index carries;
 * `exclusions.ts` normalizes npm names to the same form so one pattern holds at both
 * install and boot scope.
 */

import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { parse, stringify } from "yaml";
import type { ExclusionRecord } from "./exclusions";
import type { UnresolvedRef } from "./report";
import { compareStrings } from "./util";

const OCI_PREFIX = "oci://";
const IN_IMAGE_PREFIX = "./dynamic-plugins/dist/";
/** A well-formed content digest, matching DIGEST_RE in validateCatalogIndex.py. */
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** What the index declares, split into what this harness can and cannot validate. */
export type CatalogIndexRefs = {
  refs: string[];
  /** `./dynamic-plugins/dist/…` packages — bundled in the RHDH image, nothing to pull. */
  inImage: string[];
  excluded: ExclusionRecord[];
  /** Total `plugins[]` entries, so a shrinking ref list is visible against the whole. */
  declared: number;
  /** Provenance only — NOT used to filter; see the note above about `enabled:`. */
  enabledInIndex: number;
};

export type CatalogIndexOptions = {
  /** Returns a record when the package is barred from installing, undefined otherwise. */
  installExcluded?: (imageName: string) => ExclusionRecord | undefined;
};

type IndexEntry = {
  package?: unknown;
  enabled?: unknown;
  disabled?: unknown;
};

/**
 * The image name an `oci://` ref names, or undefined when the ref is not one.
 *
 * The `!plugin-path` selector is stripped: it picks a plugin inside the image, so
 * keeping it would make one image read as two packages to an exclusion pattern.
 */
export function imageNameFromRef(ref: string): string | undefined {
  if (!ref.startsWith(OCI_PREFIX)) return undefined;
  const body = ref.slice(OCI_PREFIX.length).split("!")[0];
  // The last `/` segment is what makes a registry with a port work — and what would
  // let `oci://plugin-a` pass with the host as the image name. Require a separator.
  if (!body.includes("/")) return undefined;
  const lastSegment = body.slice(body.lastIndexOf("/") + 1);
  // Strip the digest before the tag: a ref can carry `:tag@sha256:…`, and splitting on
  // ":" first would leave the digest glued to the name.
  const [name, digest] = lastSegment.split("@");
  // A malformed digest is rejected rather than ignored, so this agrees with
  // parse_oci_ref in scripts/validateCatalogIndex.py: the validator reports a truncated
  // digest as `ref-form`, and a ref it refuses must not be one this installs.
  if (digest !== undefined && !DIGEST_RE.test(digest)) return undefined;
  return name.split(":")[0] || undefined;
}

/**
 * Read the `plugins[]` entries. A malformed file throws rather than yielding an empty
 * list, which would report a clean pass over a file nothing could read.
 */
function readIndexEntries(path: string): IndexEntry[] {
  const doc = parse(readFileSync(path, "utf8")) as
    { plugins?: unknown } | null | undefined;
  // `typeof [] === "object"`, so an array has to be rejected explicitly — otherwise a
  // top-level list falls through to the "no 'plugins' list" branch and the message
  // sends the reader looking for a key in a file that has no keys at all.
  // `null` and arrays both report "object", so both have to be named.
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new TypeError(`${path}: expected a mapping at the top level`);
  }
  const plugins = doc.plugins;
  if (!Array.isArray(plugins)) {
    throw new TypeError(`${path}: no 'plugins' list`);
  }
  return plugins.map((entry, position) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TypeError(`${path}: plugins[${position}] is not a mapping`);
    }
    return entry as IndexEntry;
  });
}

/** True when the index ships this entry enabled (`enabled:` or the CLI's `disabled:`). */
function isEnabled(entry: IndexEntry): boolean {
  if (typeof entry.enabled === "boolean") return entry.enabled;
  if (typeof entry.disabled === "boolean") return !entry.disabled;
  return false;
}

/**
 * Collect the oci:// refs a catalog index declares, dropping excluded packages and the
 * ones bundled in the RHDH image. Throws when nothing is left, naming which filter
 * emptied the set — those have different fixes.
 */
export function readCatalogIndexRefs(
  path: string,
  options: CatalogIndexOptions = {},
): CatalogIndexRefs {
  if (!existsSync(path)) {
    throw new Error(`catalog index file not found: ${path}`);
  }
  const entries = readIndexEntries(path);

  const refs: string[] = [];
  const inImage: string[] = [];
  const excluded: ExclusionRecord[] = [];
  const seen = new Set<string>();
  let enabledInIndex = 0;

  for (const [position, entry] of entries.entries()) {
    const pkg = entry.package;
    if (typeof pkg !== "string" || pkg === "") {
      throw new Error(
        `${path}: plugins[${position}] has no string 'package' key`,
      );
    }
    if (isEnabled(entry)) enabledInIndex += 1;

    if (pkg.startsWith(IN_IMAGE_PREFIX)) {
      inImage.push(pkg);
      continue;
    }

    const image = imageNameFromRef(pkg);
    if (!image) {
      throw new Error(
        `${path}: plugins[${position}]: '${pkg}' is neither an ${OCI_PREFIX} ref ` +
          `nor a ${IN_IMAGE_PREFIX} path`,
      );
    }

    // Dedup BEFORE the exclusion check: a second sighting of the same ref is not a
    // second exclusion event. Reporting the duplicate itself is the validator's job.
    if (seen.has(pkg)) continue;
    seen.add(pkg);

    const exclusion = options.installExcluded?.(image);
    if (exclusion) {
      excluded.push(exclusion);
      console.warn(
        `⚠ '${image}' excluded from install by ${exclusion.patternSource} ` +
          `(${exclusion.ticket})`,
      );
      continue;
    }

    refs.push(pkg);
  }

  if (refs.length === 0) {
    throw new Error(emptyRefsMessage(path, entries.length, inImage, excluded));
  }
  // Sorted so a run is byte-identical whatever order the index happens to list
  // packages in — the same reason workspace.ts sorts its metadata files.
  refs.sort(compareStrings);
  return {
    refs,
    inImage,
    excluded,
    declared: entries.length,
    enabledInIndex,
  };
}

function emptyRefsMessage(
  path: string,
  declared: number,
  inImage: string[],
  excluded: ExclusionRecord[],
): string {
  const filters = [
    inImage.length ? `${inImage.length} bundled in the RHDH image` : undefined,
    excluded.length ? `${excluded.length} excluded` : undefined,
  ].filter(Boolean);
  return (
    `${path} declares no installable oci:// packages ` +
    `(${declared} entries` +
    (filters.length ? `, ${filters.join(", ")}` : "") +
    `) — nothing to validate`
  );
}

/**
 * Write the enable-everything dynamic-plugins.yaml the install CLI consumes. No
 * `includes:` — it would re-import the `enabled: false` defaults this mode overrides,
 * and the CLI resolves that path against its own cwd (a temp dir) anyway.
 */
export async function writeCatalogIndexConfig(
  refs: string[],
  destDir: string,
): Promise<string> {
  const path = join(destDir, "dynamic-plugins.catalog-index.yaml");
  await writeFile(
    path,
    stringify({
      plugins: refs.map((pkg) => ({ package: pkg, enabled: true })),
    }),
  );
  return path;
}

/**
 * Whether the install CLI could take a ref; `error` says why not. `retry` false marks
 * an answer that will not change on a second ask — a manifest that was served and is
 * wrong.
 */
export type ProbeResult =
  { ok: true } | { ok: false; error: string; retry?: boolean };

export type ResolvableRefs = {
  resolvable: string[];
  unresolved: UnresolvedRef[];
};

export type PartitionOptions = {
  /** Probes per ref before it is recorded as unresolved. */
  attempts?: number;
  /** Base backoff between probes of one ref, doubled per attempt. */
  retryDelayMs?: number;
  /** Refs probed at once — ~100 of them otherwise take minutes one by one. */
  concurrency?: number;
};

/**
 * The `registry/repo[:tag][@digest]` a ref names, as skopeo takes it after
 * `docker://`. The `!plugin-path` selector is dropped: it picks a plugin inside the
 * image and is not part of the image reference.
 */
export function registryRefFromOciRef(ref: string): string {
  if (!ref.startsWith(OCI_PREFIX)) {
    throw new Error(`not an ${OCI_PREFIX} ref: ${ref}`);
  }
  return ref.slice(OCI_PREFIX.length).split("!")[0];
}

const DYNAMIC_PACKAGES_ANNOTATION = "io.backstage.dynamic-packages";

/**
 * Why the install CLI would refuse this manifest, or undefined when it would not.
 *
 * Mirrors the CLI's plugin-path auto-detection (`getPluginPaths` / `ociPluginKey` in
 * cli-module-install-dynamic-plugins): a ref with no `!plugin-path` selector needs the
 * `io.backstage.dynamic-packages` annotation to name exactly one plugin, and anything
 * else is an InstallException that aborts the whole install. The `next` index shipped
 * a scorecard module whose annotation was the empty string — the image exists, and
 * nothing can be installed from it.
 */
export function pluginPathProblem(
  ref: string,
  manifestJson: string,
): string | undefined {
  if (ref.includes("!")) return undefined;
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestJson);
  } catch (err) {
    return `manifest is not JSON: ${err instanceof Error ? err.message : String(err)}`;
  }
  const annotation = (
    manifest as { annotations?: Record<string, unknown> } | null
  )?.annotations?.[DYNAMIC_PACKAGES_ANNOTATION];
  if (typeof annotation !== "string" || annotation === "") {
    return `no plugins declared: the '${DYNAMIC_PACKAGES_ANNOTATION}' annotation is missing or empty`;
  }
  let entries: unknown;
  try {
    entries = JSON.parse(Buffer.from(annotation, "base64").toString("utf8"));
  } catch {
    return `the '${DYNAMIC_PACKAGES_ANNOTATION}' annotation is not base64-encoded JSON`;
  }
  const paths = Array.isArray(entries)
    ? entries.flatMap((entry: unknown) =>
        entry && typeof entry === "object" ? Object.keys(entry) : [],
      )
    : [];
  if (paths.length === 0) {
    return `no plugins declared: the '${DYNAMIC_PACKAGES_ANNOTATION}' annotation lists none`;
  }
  if (paths.length > 1) {
    return `${paths.length} plugins in the image and no '!plugin-path' selector to pick one`;
  }
  return undefined;
}

/**
 * Split refs into the ones the install CLI can take and the ones it cannot.
 *
 * Why this exists: the install CLI treats the whole config as one unit, so a single
 * ref naming an image that was never published aborts the install, and the run
 * reports 0/0 with every other package unvalidated. The `next` index carried such a
 * ref — a tag-only fallback to an unpublished `2.1.0--` build — for weeks, and each
 * one fixed only uncovered the next. Probing first turns "nothing was checked" into
 * "this one package is missing, and everything else was checked".
 *
 * A probe failing for any reason, after retries, counts as unresolved: a transient
 * registry error would have aborted the install just the same, and dropping one
 * package costs far less than losing the whole run. Order is preserved.
 */
export async function partitionResolvable(
  refs: string[],
  probe: (ref: string) => Promise<ProbeResult>,
  options: PartitionOptions = {},
): Promise<ResolvableRefs> {
  const attempts = options.attempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 2000;
  const concurrency = Math.max(1, options.concurrency ?? 8);

  const probeWithRetry = async (ref: string): Promise<ProbeResult> => {
    let result: ProbeResult = { ok: false, error: "not probed" };
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      result = await probe(ref);
      if (result.ok || result.retry === false) return result;
      if (attempt < attempts) {
        await setTimeout(retryDelayMs * 2 ** (attempt - 1));
      }
    }
    return result;
  };

  const results: ProbeResult[] = new Array(refs.length);
  let next = 0;
  const worker = async () => {
    while (next < refs.length) {
      const index = next;
      next += 1;
      results[index] = await probeWithRetry(refs[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, refs.length) }, worker),
  );

  const resolvable: string[] = [];
  const unresolved: UnresolvedRef[] = [];
  for (const [index, ref] of refs.entries()) {
    const result = results[index];
    if (result.ok) resolvable.push(ref);
    else unresolved.push({ ref, error: result.error });
  }
  return { resolvable, unresolved };
}
