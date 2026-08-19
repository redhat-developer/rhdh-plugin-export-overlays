/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

// These lock in the verdicts and wording inherited from the Python script this
// module replaces. A change here means the CI gate's behaviour changed, so it
// should be deliberate rather than incidental.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  examplesWithContent,
  evaluateDocument,
  isEmptyContent,
  isMetadataPath,
  packageCoordinates,
} from "./metadata.js";

const PACKAGE_HEAD =
  "apiVersion: extensions.backstage.io/v1alpha1\nkind: Package\n";

describe("isEmptyContent", () => {
  it("treats absent, blank and empty containers as empty", () => {
    for (const value of [null, undefined, {}, [], "", "   ", "\n"]) {
      assert.equal(
        isEmptyContent(value),
        true,
        `expected ${JSON.stringify(value)} to be empty`,
      );
    }
  });

  it("treats populated values as non-empty", () => {
    for (const value of [{ a: 1 }, [1], "x", 0, false]) {
      assert.equal(
        isEmptyContent(value),
        false,
        `expected ${JSON.stringify(value)} to be non-empty`,
      );
    }
  });
});

describe("evaluateDocument", () => {
  it("passes a Package with non-empty first example content", () => {
    const result = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  appConfigExamples:\n    - title: Default\n      content:\n        app:\n          x: 1\n`,
    );
    assert.equal(result.status, "PASS");
    assert.equal(result.detail, "has non-empty first example content");
  });

  it("passes an explicit opt-out", () => {
    const result = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  appConfigNotRequired: true\n  appConfigExamples: []\n`,
    );
    assert.equal(result.status, "PASS");
    assert.equal(result.detail, "opt-out (appConfigNotRequired)");
  });

  it("fails an empty example list without the opt-out", () => {
    const result = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  appConfigExamples: []\n`,
    );
    assert.equal(result.status, "FAIL");
    assert.equal(
      result.detail,
      "empty appConfigExamples without spec.appConfigNotRequired: true",
    );
  });

  it("fails a missing appConfigExamples the same way as an empty one", () => {
    const result = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  packageName: "@scope/thing"\n`,
    );
    assert.equal(result.status, "FAIL");
    assert.equal(
      result.detail,
      "empty appConfigExamples without spec.appConfigNotRequired: true",
    );
  });

  it("fails an empty mapping as content — {} is not a real example", () => {
    const result = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  appConfigExamples:\n    - title: Default\n      content: {}\n`,
    );
    assert.equal(result.status, "FAIL");
    assert.equal(result.detail, "appConfigExamples[0].content is empty or {}");
  });

  it("fails when appConfigExamples is not a list", () => {
    const result = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  appConfigExamples: nope\n`,
    );
    assert.equal(result.status, "FAIL");
    assert.equal(result.detail, "appConfigExamples must be a list");
  });

  it("fails when the first example is not a mapping", () => {
    const result = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  appConfigExamples:\n    - just-a-string\n`,
    );
    assert.equal(result.status, "FAIL");
    assert.equal(result.detail, "appConfigExamples[0] must be a mapping");
  });

  it("fails a missing spec", () => {
    const result = evaluateDocument(PACKAGE_HEAD);
    assert.equal(result.status, "FAIL");
    assert.equal(result.detail, "missing or invalid spec");
  });

  it("fails a spec that is not a mapping", () => {
    const result = evaluateDocument(`${PACKAGE_HEAD}spec: nope\n`);
    assert.equal(result.status, "FAIL");
    assert.equal(result.detail, "missing or invalid spec");
  });

  it("skips documents that are not Packages", () => {
    const result = evaluateDocument("kind: Plugin\nspec: {}\n");
    assert.equal(result.status, "SKIP");
    assert.equal(result.detail, "kind is not Package");
  });

  it("fails a document whose root is a sequence", () => {
    const result = evaluateDocument("- a\n- b\n");
    assert.equal(result.status, "FAIL");
    assert.equal(result.detail, "YAML error: root must be a mapping");
  });

  it("fails an empty document, which parses to null rather than a mapping", () => {
    const result = evaluateDocument("");
    assert.equal(result.status, "FAIL");
    assert.equal(result.detail, "YAML error: root must be a mapping");
  });

  it("fails unparseable YAML rather than throwing", () => {
    const result = evaluateDocument("key: [unclosed\n");
    assert.equal(result.status, "FAIL");
    assert.match(result.detail, /^YAML error:/);
  });
});

describe("isMetadataPath", () => {
  it("accepts metadata YAML and rejects everything else", () => {
    assert.equal(isMetadataPath("workspaces/acr/metadata/thing.yaml"), true);
    assert.equal(isMetadataPath("workspaces/acr/metadata/thing.yml"), false);
    assert.equal(isMetadataPath("workspaces/acr/other/thing.yaml"), false);
    assert.equal(isMetadataPath("scripts/thing.yaml"), false);
    assert.equal(isMetadataPath("workspaces/acr/metadata"), false);
  });
});

describe("packageCoordinates", () => {
  it("returns name and version when both are present", () => {
    const { doc } = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  packageName: "@scope/thing"\n  version: "1.2.3"\n  appConfigNotRequired: true\n  appConfigExamples: []\n`,
    );
    assert.deepEqual(packageCoordinates(doc), {
      name: "@scope/thing",
      version: "1.2.3",
    });
  });

  it("returns nothing when either half is missing — a floating version is worse than no check", () => {
    const { doc } = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  packageName: "@scope/thing"\n  appConfigNotRequired: true\n  appConfigExamples: []\n`,
    );
    assert.equal(packageCoordinates(doc), undefined);
    assert.equal(packageCoordinates(undefined), undefined);
  });
});

describe("examplesWithContent", () => {
  it("returns every example with content, titled or indexed", () => {
    const { doc } = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  appConfigExamples:\n    - title: First\n      content:\n        a: 1\n    - content:\n        b: 2\n`,
    );
    const examples = examplesWithContent(doc);
    assert.equal(examples.length, 2);
    assert.equal(examples[0].title, "First");
    assert.equal(examples[1].title, "appConfigExamples[1]");
  });

  it("drops examples with no usable content", () => {
    const { doc } = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  appConfigExamples:\n    - title: Real\n      content:\n        a: 1\n    - title: Empty\n      content: {}\n`,
    );
    assert.deepEqual(
      examplesWithContent(doc).map((example) => example.title),
      ["Real"],
    );
  });
});

describe("packageCoordinates edge cases", () => {
  it("rejects an empty packageName", () => {
    const { doc } = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  packageName: ""\n  version: "1.0.0"\n  appConfigNotRequired: true\n  appConfigExamples: []\n`,
    );
    assert.equal(packageCoordinates(doc), undefined);
  });

  it('rejects a version YAML parsed as a number — a "1.0" bump would silently exempt the plugin', () => {
    const { doc } = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  packageName: "@scope/thing"\n  version: 1.0\n  appConfigNotRequired: true\n  appConfigExamples: []\n`,
    );
    assert.equal(packageCoordinates(doc), undefined);
  });
});

describe("examplesWithContent edge cases", () => {
  it("labels an untitled example by its position in the source list, not after filtering", () => {
    const { doc } = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  appConfigExamples:\n    - title: Empty\n      content: {}\n    - content:\n        b: 2\n`,
    );
    assert.deepEqual(examplesWithContent(doc), [
      { title: "appConfigExamples[1]", content: { b: 2 } },
    ]);
  });

  it("falls back to the index label for a blank title", () => {
    const { doc } = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  appConfigExamples:\n    - title: ""\n      content:\n        a: 1\n`,
    );
    assert.equal(examplesWithContent(doc)[0].title, "appConfigExamples[0]");
  });

  it("drops entries that are not mappings", () => {
    const { doc } = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  appConfigExamples:\n    - just-a-string\n    - content:\n        a: 1\n`,
    );
    assert.deepEqual(
      examplesWithContent(doc).map((e) => e.title),
      ["appConfigExamples[1]"],
    );
  });

  it("returns nothing for documents it cannot read", () => {
    assert.deepEqual(examplesWithContent(undefined), []);
    const { doc } = evaluateDocument(`${PACKAGE_HEAD}spec: nope\n`);
    assert.deepEqual(examplesWithContent(doc), []);
  });
});
