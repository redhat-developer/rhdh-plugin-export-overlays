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
  isInstallableOciRef,
  pluginSelector,
  registryRefFromOciRef,
} from "../../../smoke-tests-native/src/plugin-path.ts";
import { errorMessage } from "../../../smoke-tests-native/src/util.ts";
import { errorProperty } from "./json.ts";
import { isWellFormedOwnRef } from "./plugin-path.ts";

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
    if (!isTaggedImage(image)) {
      throw new Error(`published image is not registry/path/name:tag: ${line}`);
    }
    const name = repositoryName(image);
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
  const bases = [...new Set(roots.flatMap((root) => [resolve(root), ...realpathOf(root)]))];
  const outsideRoots = {
    error: `--published-images must be a file under ${roots.join(" or ")}: ${file}`,
  };
  // The path is checked before any filesystem call, then again with symlinks
  // followed, so a link inside a root cannot point out of it.
  const candidate = resolve(file);
  if (!bases.some((base) => candidate.startsWith(`${base}${sep}`))) {
    return outsideRoots;
  }
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch (cause) {
    return unreadable(file, cause);
  }
  for (const base of bases) {
    if (real.startsWith(`${base}${sep}`)) {
      let text: string;
      try {
        text = readFileSync(real, "utf8");
      } catch (cause) {
        return unreadable(file, cause);
      }
      try {
        return parsePublishedImages(text);
      } catch (cause) {
        return {
          error: `--published-images is not a list of images: ${file} (${reasonOf(cause)})`,
        };
      }
    }
  }
  return outsideRoots;
}

/** The error for a file that cannot be resolved or read. */
function unreadable(file: string, cause: unknown): { error: string } {
  return { error: `--published-images cannot be read: ${file} (${reasonOf(cause)})` };
}

/** The root with symlinks followed, or nothing when it cannot be resolved. */
function realpathOf(root: string): string[] {
  try {
    return [realpathSync(root)];
  } catch {
    return [];
  }
}

/** A filesystem error's code, or the error's message. */
function reasonOf(cause: unknown): string {
  const code = errorProperty(cause, "code");
  if (typeof code === "string") {
    return code;
  }
  return errorMessage(cause);
}

/**
 * The ref to check in place of `ref`: the published image of the same name,
 * keeping the `!plugin-path` selector. Undefined for a ref to another
 * registry, one this run did not publish, or a malformed one: retargeting
 * would hide its form problem behind a well-formed pr_* ref.
 */
export function publishedRef(ref: string, published: PublishedImages): string | undefined {
  if (!isWellFormedOwnRef(ref)) {
    return undefined;
  }
  const image = published.get(repositoryName(registryRefFromOciRef(ref)));
  if (image === undefined) {
    return undefined;
  }
  const selector = pluginSelector(ref);
  return selector === undefined ? `oci://${image}` : `oci://${image}!${selector}`;
}

/** The repository name: the last path segment, without tag or digest. */
function repositoryName(image: string): string {
  const name = image.split("@")[0] ?? "";
  const lastSegment = name.slice(name.lastIndexOf("/") + 1);
  const colon = lastSegment.indexOf(":");
  return colon === -1 ? lastSegment : lastSegment.slice(0, colon);
}

/** Whether `image` is `registry/path/name:tag`, by the install CLI's grammar, without a digest. */
function isTaggedImage(image: string): boolean {
  return !image.includes("@") && isInstallableOciRef(`oci://${image}`);
}
