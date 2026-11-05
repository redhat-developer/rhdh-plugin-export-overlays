import { describe, expect, it } from "vite-plus/test";
import { parseReference } from "./distribution-reference.ts";

describe("parseReference", () => {
  it("parses a tagged reference with multi-segment path", () => {
    expect(
      parseReference("quay.io/rhdh/red-hat-developer-hub-backstage-plugin-catalog:1.11--1.5.4"),
    ).toEqual({
      path: "rhdh/red-hat-developer-hub-backstage-plugin-catalog",
      tag: "1.11--1.5.4",
    });
  });

  it("parses digest-only reference", () => {
    expect(
      parseReference(
        `quay.io/rhdh/plugin@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
      ),
    ).toEqual({
      path: "rhdh/plugin",
      tag: undefined,
    });
  });

  it("parses tag and digest together", () => {
    expect(
      parseReference(
        `ghcr.io/org/repo/plugin-techdocs:3.1.0-beta@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`,
      ),
    ).toEqual({
      path: "org/repo/plugin-techdocs",
      tag: "3.1.0-beta",
    });
  });

  it("allows tag characters including dots and hyphens", () => {
    expect(parseReference("quay.io/rhdh/pkg:2.0.0-rc.1")).toEqual({
      path: "rhdh/pkg",
      tag: "2.0.0-rc.1",
    });
  });

  it("rejects empty string", () => {
    expect(() => parseReference("")).toThrow("Invalid image reference");
  });

  it("rejects bare image name without registry host", () => {
    expect(() => parseReference("my-plugin:latest")).toThrow("Invalid image reference");
  });

  it("parses image names with valid repository separators", () => {
    expect(parseReference("ghcr.io/acme/acme-plugin.foo:1.0")).toEqual({
      path: "acme/acme-plugin.foo",
      tag: "1.0",
    });
    expect(parseReference("ghcr.io/acme/plugin_backend__api--v2:1.0")).toEqual({
      path: "acme/plugin_backend__api--v2",
      tag: "1.0",
    });
  });

  it("accepts registries with a port", () => {
    expect(parseReference("localhost:5000/my/image:tag")).toEqual({
      path: "my/image",
      tag: "tag",
    });
  });

  it("rejects wrong digest algorithm", () => {
    expect(() =>
      parseReference(
        "quay.io/rhdh/pkg@sha512:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    ).toThrow("Invalid image reference");
  });

  it("rejects digest with wrong length", () => {
    expect(() => parseReference("quay.io/rhdh/pkg@sha256:abc")).toThrow("Invalid image reference");
  });

  it("rejects invalid registry reference from plugin_builds fixtures", () => {
    expect(() => parseReference("not-a-valid-ref!!!")).toThrow("Invalid image reference");
  });
});
