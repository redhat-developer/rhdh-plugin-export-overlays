/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { parsePublishedImages, publishedRef, readPublishedImages } from "./published-images.ts";
import { OWN, scratchDir as scratch } from "./test-support.ts";

const THEME = `${OWN}/red-hat-developer-hub-backstage-plugin-theme`;

describe("parsePublishedImages", () => {
  it("keys each image by its repository name, skipping blank lines", () => {
    const images = parsePublishedImages(
      `\n  ${THEME}:pr_4593__1.5.0  \n\n${OWN}/b:pr_4593__0.6.0\n`,
    );
    expect([...images]).toEqual([
      ["red-hat-developer-hub-backstage-plugin-theme", `${THEME}:pr_4593__1.5.0`],
      ["b", `${OWN}/b:pr_4593__0.6.0`],
    ]);
  });

  it("drops the legacy !<package id> suffix", () => {
    const images = parsePublishedImages(`${OWN}/a:pr_1__1.0.0!backstage-plugin-a`);
    expect(images.get("a")).toBe(`${OWN}/a:pr_1__1.0.0`);
  });

  it.each([
    ["no tag", `${OWN}/a`],
    ["an empty tag", `${OWN}/a:`],
    ["a digest", `${OWN}/a@sha256:abc`],
    ["no registry path", "a:pr_1__1.0.0"],
    ["a tag with no name", `${OWN}/:pr_1__1.0.0`],
  ])("rejects a line with %s", (_label, line) => {
    expect(() => parsePublishedImages(line)).toThrow(/is not registry\/path\/name:tag/);
  });

  it("rejects two different images with one name, which would make the mapping a guess", () => {
    expect(() => parsePublishedImages(`${OWN}/a:pr_1__1.0.0\nquay.io/x/a:pr_1__1.0.0`)).toThrow(
      /two published images are named a/,
    );
  });

  it("accepts the same image listed twice", () => {
    expect(parsePublishedImages(`${OWN}/a:pr_1__1\n${OWN}/a:pr_1__1`).size).toBe(1);
  });
});

describe("publishedRef", () => {
  const published = parsePublishedImages(`${THEME}:pr_4593__1.5.0`);

  it("swaps the tag for the published one and keeps the plugin path", () => {
    expect(publishedRef(`oci://${THEME}:bs_1.54.9__1.5.0!theme`, published)).toBe(
      `oci://${THEME}:pr_4593__1.5.0!theme`,
    );
  });

  it("adds no selector to a ref that has none", () => {
    expect(publishedRef(`oci://${THEME}:bs_1.54.9__1.5.0`, published)).toBe(
      `oci://${THEME}:pr_4593__1.5.0`,
    );
  });

  it.each([
    ["no tag", `oci://${THEME}!theme`],
    ["an empty tag", `oci://${THEME}:!theme`],
    ["a bare !", `oci://${THEME}:bs_1.54.9__1.5.0!`],
  ])("leaves a ref with %s alone, so its form problem is still reported", (_label, ref) => {
    expect(publishedRef(ref, published)).toBeUndefined();
  });

  it("maps a ref pinned by digest by its name", () => {
    expect(publishedRef(`oci://${THEME}@sha256:abc!theme`, published)).toBe(
      `oci://${THEME}:pr_4593__1.5.0!theme`,
    );
  });

  it("follows the image to another namespace, as a fork's /publish pushes it", () => {
    const fork = parsePublishedImages(
      "ghcr.io/someone/rhdh-plugin-export-overlays/red-hat-developer-hub-backstage-plugin-theme:pr_7__1.5.0",
    );
    expect(publishedRef(`oci://${THEME}:bs_1.54.9__1.5.0!theme`, fork)).toBe(
      "oci://ghcr.io/someone/rhdh-plugin-export-overlays/red-hat-developer-hub-backstage-plugin-theme:pr_7__1.5.0!theme",
    );
  });

  it("leaves a ref to another registry alone, even when the name matches", () => {
    expect(
      publishedRef(
        "oci://quay.io/rhdh/red-hat-developer-hub-backstage-plugin-theme:1.5.0!theme",
        published,
      ),
    ).toBeUndefined();
  });

  it("leaves an own ref alone when no image of its name was published", () => {
    expect(publishedRef(`oci://${OWN}/other:bs_1.54.9__1.0.0!other`, published)).toBeUndefined();
  });

  it("does not match on a name prefix", () => {
    expect(publishedRef(`oci://${THEME}-extra:bs_1__1!x`, published)).toBeUndefined();
  });
});

describe("readPublishedImages", () => {
  it("reads a list under a root, even when another root does not exist", () => {
    const root = scratch();
    const file = join(root, "published-exports.txt");
    writeFileSync(file, `${OWN}/a:pr_1__1.0.0\n`);
    const images = readPublishedImages(file, [join(root, "absent"), root]);
    expect(images).toEqual(new Map([["a", `${OWN}/a:pr_1__1.0.0`]]));
  });

  it("reads a list under the working directory by default", () => {
    const file = join(scratch(process.cwd()), "published-exports.txt");
    writeFileSync(file, `${OWN}/a:pr_1__1.0.0\n`);
    expect(readPublishedImages(relative(process.cwd(), file))).toEqual(
      new Map([["a", `${OWN}/a:pr_1__1.0.0`]]),
    );
  });

  it("refuses a path outside the roots before touching the filesystem", () => {
    // Not "cannot be read": the path is refused before realpath runs.
    expect(readPublishedImages("/nonexistent-dir/published-exports.txt", [scratch()])).toEqual({
      error: expect.stringMatching(/must be a file under/),
    });
  });

  it("refuses a sibling directory that shares the root's name as a prefix", () => {
    const dir = scratch();
    mkdirSync(join(dir, "a"));
    mkdirSync(join(dir, "ab"));
    const file = join(dir, "ab", "published-exports.txt");
    writeFileSync(file, `${OWN}/a:pr_1__1.0.0\n`);
    expect(readPublishedImages(file, [join(dir, "a")])).toEqual({
      error: expect.stringMatching(/must be a file under/),
    });
  });

  it("returns an error for a directory instead of throwing", () => {
    const root = scratch();
    const dir = join(root, "published-exports.txt");
    mkdirSync(dir);
    expect(readPublishedImages(dir, [root])).toEqual({
      error: expect.stringMatching(/--published-images cannot be read: .*\(EISDIR\)/),
    });
  });

  it.each([
    ["a malformed line", `${OWN}/a\n`, /is not registry\/path\/name:tag/],
    ["two images with one name", `${OWN}/a:pr_1__1\nquay.io/x/a:pr_1__1\n`, /two published/],
  ])("returns an error for %s instead of throwing", (_label, text, reason) => {
    const root = scratch();
    const file = join(root, "published-exports.txt");
    writeFileSync(file, text);
    const result = readPublishedImages(file, [root]);
    expect(result).toEqual({ error: expect.stringMatching(/is not a list of images/) });
    expect(result).toEqual({ error: expect.stringMatching(reason) });
  });
});
