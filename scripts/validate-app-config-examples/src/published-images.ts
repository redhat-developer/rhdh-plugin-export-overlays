/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

// Maps metadata refs onto the images a PR's `/publish` pushed (`pr_<n>__*`
// tags), so the plugin-path layer can check a PR before its `bs_*` tags exist.

import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import {
  pluginSelector,
  refFormProblem,
  registryRefFromOciRef,
} from "../../../smoke-tests-native/src/plugin-path.ts";
import { isOwnImage } from "./plugin-path.ts";

/** Published images keyed by repository name, the last path segment. */
export type PublishedImages = ReadonlyMap<string, string>;

/**
 * Reads the `published-exports` list a `/publish` run uploads: one
 * `registry/path/name:tag` per line.
 */
export function parsePublishedImages(text: string): PublishedImages {
  const images = new Map<string, string>();
  for (const line of text.split("\n").map((entry) => entry.trim())) {
    if (line === "") {
      continue;
    }
    // Older exports append `!<package id>`, which is not part of the image.
    const image = line.split("!")[0] ?? "";
    const name = taggedRepositoryName(image);
    if (name === undefined) {
      throw new Error(`published image is not registry/path/name:tag: ${line}`);
    }
    const previous = images.get(name);
    if (previous !== undefined && previous !== image) {
      throw new Error(`two published images are named ${name}: ${previous}, ${image}`);
    }
    images.set(name, image);
  }
  return images;
}

/**
 * Reads the list from `file`, which must resolve (symlinks followed) under one
 * of `roots`: the flag names a file the run wrote, not any file on the host.
 */
export function readPublishedImages(
  file: string,
  roots: readonly string[] = [process.cwd(), tmpdir()],
): PublishedImages | { error: string } {
  // Each root as given and resolved: on macOS the temp dir is a symlink.
  const bases = [...new Set(roots.flatMap((root) => [resolve(root), realpathSync(root)]))];
  const error = { error: `--published-images must be a file under ${roots.join(" or ")}: ${file}` };
  // The path is checked before any filesystem call, then again with symlinks
  // followed, so a link inside a root cannot point out of it.
  const candidate = resolve(file);
  if (!bases.some((base) => candidate.startsWith(`${base}${sep}`))) {
    return error;
  }
  const real = realpathSync(candidate);
  for (const base of bases) {
    if (real.startsWith(`${base}${sep}`)) {
      return parsePublishedImages(readFileSync(real, "utf8"));
    }
  }
  return error;
}

/**
 * The ref to check in place of `ref`: the published image of the same name,
 * keeping the `!plugin-path` selector. Undefined for a ref to another
 * registry, one this run did not publish, or a malformed one: retargeting
 * would hide its form problem behind a well-formed pr_* ref.
 */
export function publishedRef(ref: string, published: PublishedImages): string | undefined {
  if (!isOwnImage(ref) || refFormProblem(ref) !== undefined) {
    return undefined;
  }
  const image = published.get(repositoryName(registryRefFromOciRef(ref)));
  if (image === undefined) {
    return undefined;
  }
  const selector = pluginSelector(ref);
  return selector === undefined ? `oci://${image}` : `oci://${image}!${selector}`;
}

/** The last path segment of `registry/path/name[:tag][@digest]`. */
function repositoryName(image: string): string {
  const name = image.split("@")[0] ?? "";
  const lastSegment = name.slice(name.lastIndexOf("/") + 1);
  const colon = lastSegment.indexOf(":");
  return colon === -1 ? lastSegment : lastSegment.slice(0, colon);
}

/** repositoryName for a `registry/path/name:tag`, or undefined for any other form. */
function taggedRepositoryName(image: string): string | undefined {
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  if (/[\s@]/.test(image) || slash <= 0 || colon <= slash + 1 || colon === image.length - 1) {
    return undefined;
  }
  return image.slice(slash + 1, colon);
}
