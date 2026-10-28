/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

import { describe, expect, it } from "vite-plus/test";
import { parsePublishedImages, publishedRef } from "./published-images.ts";

const OWN = "ghcr.io/redhat-developer/rhdh-plugin-export-overlays";
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

  it("keeps a bare ! so the ref-form check still rejects it", () => {
    expect(publishedRef(`oci://${THEME}:bs_1.54.9__1.5.0!`, published)).toBe(
      `oci://${THEME}:pr_4593__1.5.0!`,
    );
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
