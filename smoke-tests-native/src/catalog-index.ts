/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * Catalog-index mode: validate every package a generated catalog index declares.
 *
 * The input is the `dynamic-plugins.default.yaml` that `scripts/update-index.sh` writes
 * (Step 3), so the check runs against the index as it is about to be published rather
 * than against an index image that already exists. That is the whole reason this lives
 * upstream: RHDH's cluster-free plugin sanity check (RHIDP-13508) has to
 * `skopeo copy` the published `plugin-catalog-index` image and walk its layers just to
 * recover this one file — here it is already on disk, and the failure lands before the
 * image is built instead of a day after.
 *
 * Two things about the index shape drive this module:
 *
 * 1. **Most packages ship `enabled: false`.** That is a product default — which plugins
 *    RHDH turns on out of the box — and says nothing about whether the artifact works.
 *    Feeding the file to the install CLI as-is would therefore validate almost nothing,
 *    which is why RHDH's populate-catalog-index.sh generates an enable-everything
 *    config instead of `includes:`-ing the index's own list. This does the same, from
 *    the same reasoning.
 *
 * 2. **`pluginConfig` blocks are dropped.** They carry `${SEGMENT_WRITE_KEY}`-style
 *    placeholders for env vars that exist in a deployed RHDH and nowhere here, and a
 *    plugin that validates config at boot would fail on the substituted-empty value.
 *    The harness supplies its own dummy root config (`plugin-config.ts`) plus the
 *    optional `--app-config` layer, which is the same layering RHDH uses when it
 *    passes `app-config.plugin-sanity.yaml` last so it wins over generated defaults.
 *
 * Exclusions are matched against the OCI IMAGE NAME (`backstage-community-plugin-quay`),
 * because that is the only identifier a catalog index carries — it has no npm names.
 * `exclusions.ts` normalizes an npm package name to the same form, so one pattern is
 * valid at `install` scope (resolved here, from the index) and at `boot` scope
 * (resolved from the installed package.json).
 */

import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { ExclusionRecord } from "./exclusions";
import { compareStrings } from "./util";

const OCI_PREFIX = "oci://";
const IN_IMAGE_PREFIX = "./dynamic-plugins/dist/";

/** What the index declares, split into what this harness can and cannot validate. */
export type CatalogIndexRefs = {
  /** oci:// refs to install and validate. */
  refs: string[];
  /** `./dynamic-plugins/dist/…` packages — bundled in the RHDH image, nothing to pull. */
  inImage: string[];
  /** Packages dropped by a tracked install-scope exclusion. */
  excluded: ExclusionRecord[];
  /** Total `plugins[]` entries, so a shrinking ref list is visible against the whole. */
  declared: number;
  /** How many the index ships enabled — recorded for provenance, not used to filter. */
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
 * The `!plugin-path` selector some refs carry picks a plugin *inside* the image and
 * says nothing about which image is pulled, so it is stripped: otherwise the same
 * image referenced with and without a selector would look like two different packages
 * and an exclusion pattern would match only one of them.
 */
export function imageNameFromRef(ref: string): string | undefined {
  if (!ref.startsWith(OCI_PREFIX)) return undefined;
  const body = ref.slice(OCI_PREFIX.length).split("!")[0];
  // Taking the last `/` segment is what makes a registry with a port work
  // (`localhost:5000/foo/plugin-a`), and it is also what would let a ref naming no
  // image at all — `oci://plugin-a`, `oci://localhost:5000` — pass with the HOST read
  // as the image name. Require a separator so those are rejected as malformed, which
  // is what the sibling validator (scripts/validateCatalogIndex.py) does too.
  if (!body.includes("/")) return undefined;
  const lastSegment = body.split("/").pop();
  if (!lastSegment) return undefined;
  // Strip the digest first: a ref can carry `:tag@sha256:…`, and splitting on ":"
  // first would leave the digest glued to the name.
  const withoutDigest = lastSegment.split("@")[0];
  const name = withoutDigest.split(":")[0];
  return name || undefined;
}

/** Read the `plugins[]` entries of a catalog index's dynamic-plugins.default.yaml. */
function readIndexEntries(path: string): IndexEntry[] {
  // Repo-generated input: a malformed file deliberately throws rather than yielding an
  // empty list, which would report a clean pass over a file nothing could read.
  const doc = parse(readFileSync(path, "utf8")) as
    { plugins?: unknown } | null | undefined;
  // `typeof [] === "object"`, so an array has to be rejected explicitly — otherwise a
  // top-level list falls through to the "no 'plugins' list" branch and the message
  // sends the reader looking for a key in a file that has no keys at all.
  if (
    doc === null ||
    doc === undefined ||
    typeof doc !== "object" ||
    Array.isArray(doc)
  ) {
    throw new Error(`${path}: expected a mapping at the top level`);
  }
  const plugins = doc.plugins;
  if (!Array.isArray(plugins)) {
    throw new Error(`${path}: no 'plugins' list`);
  }
  return plugins.map((entry, position) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${path}: plugins[${position}] is not a mapping`);
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
 * ones that ship inside the RHDH image.
 *
 * Throws when nothing is left to install, saying WHICH filter emptied the set — "the
 * index only declares in-image packages" and "every package is excluded" have entirely
 * different fixes, and one generic message sends the reader to the wrong file.
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

    // Dedup BEFORE the exclusion check. An index legitimately lists the same ref twice
    // (a package and a wrapper entry pointing at it); installing it twice is wasted
    // pulls, not a defect — reporting the duplicate is the static validator's job. And
    // a second sighting of the same ref is not a second exclusion EVENT: counting it as
    // one put a duplicate ExclusionRecord in results.json and printed the warning twice.
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
    `(${declared} entr(ies)` +
    (filters.length ? `, ${filters.join(", ")}` : "") +
    `) — nothing to validate`
  );
}

/**
 * Write the enable-everything dynamic-plugins.yaml the install CLI consumes.
 *
 * No `includes:` of the index's own file: that would re-import the very
 * `enabled: false` defaults this mode exists to override, and the CLI resolves
 * `includes` relative to its own working directory (a temp dir here), so the path
 * would not resolve anyway.
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
