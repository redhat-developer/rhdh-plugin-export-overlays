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
import { parse, stringify } from "yaml";
import type { ExclusionRecord } from "./exclusions";
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
      plugins: refs.map((pkg) => ({ package: pkg, disabled: false })),
    }),
  );
  return path;
}
