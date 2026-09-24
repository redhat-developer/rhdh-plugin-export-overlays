/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

// These lock in the verdicts and wording inherited from the Python script this
// module replaces. A change here means the CI gate's behaviour changed, so it
// should be deliberate rather than incidental.

import { describe, expect, it } from "vite-plus/test";
import {
  examplesWithContent,
  evaluateDocument,
  isEmptyContent,
  isMetadataPath,
  packageCoordinates,
} from "./metadata.ts";

const PACKAGE_HEAD = "apiVersion: extensions.backstage.io/v1alpha1\nkind: Package\n";

describe("isEmptyContent", () => {
  it("treats absent, blank and empty containers as empty", () => {
    for (const value of [null, undefined, {}, [], "", "   ", "\n"]) {
      expect(isEmptyContent(value), `expected ${JSON.stringify(value)} to be empty`).toBe(true);
    }
  });

  it("treats populated values as non-empty", () => {
    for (const value of [{ a: 1 }, [1], "x", 0, false]) {
      expect(isEmptyContent(value), `expected ${JSON.stringify(value)} to be non-empty`).toBe(
        false,
      );
    }
  });
});

describe("evaluateDocument", () => {
  it("passes a Package with non-empty first example content", () => {
    const result = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  appConfigExamples:\n    - title: Default\n      content:\n        app:\n          x: 1\n`,
    );
    expect(result.status).toBe("PASS");
    expect(result.detail).toBe("has non-empty first example content");
  });

  it("passes an explicit opt-out", () => {
    const result = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  appConfigNotRequired: true\n  appConfigExamples: []\n`,
    );
    expect(result.status).toBe("PASS");
    expect(result.detail).toBe("opt-out (appConfigNotRequired)");
  });

  it("fails an empty example list without the opt-out", () => {
    const result = evaluateDocument(`${PACKAGE_HEAD}spec:\n  appConfigExamples: []\n`);
    expect(result.status).toBe("FAIL");
    expect(result.detail).toBe("empty appConfigExamples without spec.appConfigNotRequired: true");
  });

  it("fails a missing appConfigExamples the same way as an empty one", () => {
    const result = evaluateDocument(`${PACKAGE_HEAD}spec:\n  packageName: "@scope/thing"\n`);
    expect(result.status).toBe("FAIL");
    expect(result.detail).toBe("empty appConfigExamples without spec.appConfigNotRequired: true");
  });

  it("fails an empty mapping as content — {} is not a real example", () => {
    const result = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  appConfigExamples:\n    - title: Default\n      content: {}\n`,
    );
    expect(result.status).toBe("FAIL");
    expect(result.detail).toBe("appConfigExamples[0].content is empty or {}");
  });

  it("fails when appConfigExamples is not a list", () => {
    const result = evaluateDocument(`${PACKAGE_HEAD}spec:\n  appConfigExamples: nope\n`);
    expect(result.status).toBe("FAIL");
    expect(result.detail).toBe("appConfigExamples must be a list");
  });

  it("fails when the first example is not a mapping", () => {
    const result = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  appConfigExamples:\n    - just-a-string\n`,
    );
    expect(result.status).toBe("FAIL");
    expect(result.detail).toBe("appConfigExamples[0] must be a mapping");
  });

  it("fails a missing spec", () => {
    const result = evaluateDocument(PACKAGE_HEAD);
    expect(result.status).toBe("FAIL");
    expect(result.detail).toBe("missing or invalid spec");
  });

  it("fails a spec that is not a mapping", () => {
    const result = evaluateDocument(`${PACKAGE_HEAD}spec: nope\n`);
    expect(result.status).toBe("FAIL");
    expect(result.detail).toBe("missing or invalid spec");
  });

  it("skips documents that are not Packages", () => {
    const result = evaluateDocument("kind: Plugin\nspec: {}\n");
    expect(result.status).toBe("SKIP");
    expect(result.detail).toBe("kind is not Package");
  });

  it("fails a document whose root is a sequence", () => {
    const result = evaluateDocument("- a\n- b\n");
    expect(result.status).toBe("FAIL");
    expect(result.detail).toBe("YAML error: root must be a mapping");
  });

  it("fails an empty document, which parses to null rather than a mapping", () => {
    const result = evaluateDocument("");
    expect(result.status).toBe("FAIL");
    expect(result.detail).toBe("YAML error: root must be a mapping");
  });

  it("fails unparseable YAML rather than throwing", () => {
    const result = evaluateDocument("key: [unclosed\n");
    expect(result.status).toBe("FAIL");
    expect(result.detail).toMatch(/^YAML error:/);
  });
});

describe("isMetadataPath", () => {
  it("accepts metadata YAML and rejects everything else", () => {
    expect(isMetadataPath("workspaces/acr/metadata/thing.yaml")).toBe(true);
    expect(isMetadataPath("workspaces/acr/metadata/thing.yml")).toBe(false);
    expect(isMetadataPath("workspaces/acr/other/thing.yaml")).toBe(false);
    expect(isMetadataPath("scripts/thing.yaml")).toBe(false);
    expect(isMetadataPath("workspaces/acr/metadata")).toBe(false);
  });
});

describe("packageCoordinates", () => {
  it("returns name and version when both are present", () => {
    const { doc } = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  packageName: "@scope/thing"\n  version: "1.2.3"\n  appConfigNotRequired: true\n  appConfigExamples: []\n`,
    );
    expect(packageCoordinates(doc)).toEqual({
      name: "@scope/thing",
      version: "1.2.3",
    });
  });

  it("returns nothing when either half is missing — a floating version is worse than no check", () => {
    const { doc } = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  packageName: "@scope/thing"\n  appConfigNotRequired: true\n  appConfigExamples: []\n`,
    );
    expect(packageCoordinates(doc)).toBe(undefined);
    expect(packageCoordinates(undefined)).toBe(undefined);
  });
});

describe("examplesWithContent", () => {
  it("returns every example with content, titled or indexed", () => {
    const { doc } = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  appConfigExamples:\n    - title: First\n      content:\n        a: 1\n    - content:\n        b: 2\n`,
    );
    const examples = examplesWithContent(doc);
    expect(examples.length).toBe(2);
    expect(examples[0].title).toBe("First");
    expect(examples[1].title).toBe("appConfigExamples[1]");
  });

  it("drops examples with no usable content", () => {
    const { doc } = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  appConfigExamples:\n    - title: Real\n      content:\n        a: 1\n    - title: Empty\n      content: {}\n`,
    );
    expect(examplesWithContent(doc).map((example) => example.title)).toEqual(["Real"]);
  });
});

describe("packageCoordinates edge cases", () => {
  it("rejects an empty packageName", () => {
    const { doc } = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  packageName: ""\n  version: "1.0.0"\n  appConfigNotRequired: true\n  appConfigExamples: []\n`,
    );
    expect(packageCoordinates(doc)).toBe(undefined);
  });

  it('rejects a version YAML parsed as a number — a "1.0" bump would silently exempt the plugin', () => {
    const { doc } = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  packageName: "@scope/thing"\n  version: 1.0\n  appConfigNotRequired: true\n  appConfigExamples: []\n`,
    );
    expect(packageCoordinates(doc)).toBe(undefined);
  });
});

describe("examplesWithContent edge cases", () => {
  it("labels an untitled example by its position in the source list, not after filtering", () => {
    const { doc } = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  appConfigExamples:\n    - title: Empty\n      content: {}\n    - content:\n        b: 2\n`,
    );
    expect(examplesWithContent(doc)).toEqual([
      { title: "appConfigExamples[1]", content: { b: 2 } },
    ]);
  });

  it("falls back to the index label for a blank title", () => {
    const { doc } = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  appConfigExamples:\n    - title: ""\n      content:\n        a: 1\n`,
    );
    expect(examplesWithContent(doc)[0].title).toBe("appConfigExamples[0]");
  });

  it("drops entries that are not mappings", () => {
    const { doc } = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  appConfigExamples:\n    - just-a-string\n    - content:\n        a: 1\n`,
    );
    expect(examplesWithContent(doc).map((e) => e.title)).toEqual(["appConfigExamples[1]"]);
  });

  it("returns nothing for documents it cannot read", () => {
    expect(examplesWithContent(undefined)).toEqual([]);
    const { doc } = evaluateDocument(`${PACKAGE_HEAD}spec: nope\n`);
    expect(examplesWithContent(doc)).toEqual([]);
  });
});
