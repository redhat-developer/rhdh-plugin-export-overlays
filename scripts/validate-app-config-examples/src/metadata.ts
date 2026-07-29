/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

// Structural checks on Package metadata. This is a behaviour-preserving port of
// scripts/validate-app-config-examples.py (RHIDP-12590) — the verdicts and
// messages here are deliberately identical to that script's, so the CI gate
// behaves exactly as it did before. The semantic layer in schema.ts is layered
// on top of these verdicts rather than replacing them.

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { errorProperty, isPlainObject } from "./json.js";

export type Status = "PASS" | "FAIL" | "SKIP";

export type StructuralResult = {
  status: Status;
  detail: string;
  /** Parsed document, present only for a mapping root. */
  doc?: Record<string, unknown>;
};

/**
 * Mirrors the Python `_is_empty_content`: null/undefined, an empty mapping, an
 * empty sequence, and a blank string all count as "no content". An empty
 * mapping (`{}`) is deliberately a failure rather than a pass — see RHIDP-12590.
 */
export function isEmptyContent(content: unknown): boolean {
  if (content === null || content === undefined) {
    return true;
  }
  if (Array.isArray(content)) {
    return content.length === 0;
  }
  if (isPlainObject(content)) {
    return Object.keys(content).length === 0;
  }
  if (typeof content === "string") {
    return content.trim() === "";
  }
  return false;
}

/** Evaluates one metadata document. Pure — takes text, so it is easy to test. */
export function evaluateDocument(text: string): StructuralResult {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (error) {
    // Parse errors carry a multi-line caret frame; the table has one line per
    // file, so keep the headline only.
    const headline = String(error).split("\n")[0].trim();
    return { status: "FAIL", detail: `YAML error: ${headline}` };
  }

  if (!isPlainObject(doc)) {
    return { status: "FAIL", detail: "YAML error: root must be a mapping" };
  }

  if (doc.kind !== "Package") {
    return { status: "SKIP", detail: "kind is not Package", doc };
  }

  const spec = doc.spec;
  if (!isPlainObject(spec)) {
    return { status: "FAIL", detail: "missing or invalid spec", doc };
  }

  const notRequired = spec.appConfigNotRequired === true;
  const examples = spec.appConfigExamples ?? [];

  if (!Array.isArray(examples)) {
    return { status: "FAIL", detail: "appConfigExamples must be a list", doc };
  }

  if (examples.length === 0) {
    return notRequired
      ? { status: "PASS", detail: "opt-out (appConfigNotRequired)", doc }
      : {
          status: "FAIL",
          detail:
            "empty appConfigExamples without spec.appConfigNotRequired: true",
          doc,
        };
  }

  const first = examples[0];
  if (!isPlainObject(first)) {
    return {
      status: "FAIL",
      detail: "appConfigExamples[0] must be a mapping",
      doc,
    };
  }

  if (isEmptyContent(first.content)) {
    return {
      status: "FAIL",
      detail: "appConfigExamples[0].content is empty or {}",
      doc,
    };
  }

  return { status: "PASS", detail: "has non-empty first example content", doc };
}

export async function evaluateFile(path: string): Promise<StructuralResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    // A path in the diff that is not on disk is skipped, not failed — the
    // Python original guarded this with `p.is_file()`. It happens when running
    // --since locally over a range that deleted a file without committing.
    if (errorProperty(error, "code") === "ENOENT") {
      return { status: "SKIP", detail: "file not present in the working tree" };
    }
    return { status: "FAIL", detail: `YAML error: ${error}` };
  }
  return evaluateDocument(text);
}

/** True for paths shaped like `workspaces/<ws>/metadata/<name>.yaml`. */
export function isMetadataPath(path: string): boolean {
  const parts = path.split("/");
  return (
    parts.length >= 4 &&
    parts[0] === "workspaces" &&
    parts[2] === "metadata" &&
    path.endsWith(".yaml")
  );
}

/**
 * The npm coordinates a Package metadata document points at, when it has them.
 * Both halves are required: the name alone leaves the version floating, and
 * validating against a different version than the one shipped is worse than
 * not validating at all.
 */
export function packageCoordinates(
  doc: Record<string, unknown> | undefined,
): { name: string; version: string } | undefined {
  if (!doc || !isPlainObject(doc.spec)) {
    return undefined;
  }
  const { packageName, version } = doc.spec;
  if (typeof packageName !== "string" || typeof version !== "string") {
    return undefined;
  }
  if (packageName === "" || version === "") {
    return undefined;
  }
  return { name: packageName, version };
}

/**
 * Every `appConfigExamples[]` entry that carries content worth validating.
 *
 * The filtering is load-bearing, hence the name: callers rely on empty entries
 * being gone before they try to validate anything.
 */
export function examplesWithContent(
  doc: Record<string, unknown> | undefined,
): { title: string; content: unknown }[] {
  if (!doc || !isPlainObject(doc.spec)) {
    return [];
  }
  const examples = doc.spec.appConfigExamples;
  if (!Array.isArray(examples)) {
    return [];
  }
  // flatMap rather than filter-then-map so `index` stays the position in the
  // source list: the label points a maintainer at an entry to go and edit, so
  // it has to survive earlier entries being dropped.
  return examples.flatMap((example, index) => {
    if (!isPlainObject(example) || isEmptyContent(example.content)) {
      return [];
    }
    const title =
      typeof example.title === "string" && example.title !== ""
        ? example.title
        : `appConfigExamples[${index}]`;
    return [{ title, content: example.content }];
  });
}
