/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * The nightly sweep picks its support tier from which cron fired, so the cron list in
 * community-plugin-sweep.yaml and SUPPORT_LEVELS here are one contract spread across two
 * files — and the mapping that joins them is written out twice inside the workflow,
 * because the `env` context is not in scope for `concurrency`.
 *
 * Nothing in GitHub Actions checks any of that. Delete a cron and its tier is silently
 * never swept again; edit one and SUPPORT quietly falls back to community; let the two
 * copies of the mapping drift and a manual sweep can run alongside the scheduled one for
 * the same tier. All three fail as a job that looks healthy, which is the failure mode
 * this whole sweep exists to remove. So assert the contract here instead.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { SUPPORT_LEVELS } from "./support";

const WORKFLOW = ".github/workflows/community-plugin-sweep.yaml";

/** Walk up from the working directory until the workflow turns up. */
function workflowPath(): string {
  let dir = process.cwd();
  for (let hops = 0; hops < 5; hops++) {
    const candidate = join(dir, WORKFLOW);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not find ${WORKFLOW} above ${process.cwd()}`);
}

type Workflow = {
  on: { schedule?: { cron: string }[] };
  env: { SUPPORT: string };
  concurrency: { group: string };
};

function workflow(): Workflow {
  return parse(readFileSync(workflowPath(), "utf8")) as Workflow;
}

/**
 * Pull the cron -> tier pairs out of a GitHub Actions expression built as a chain of
 * `(github.event.schedule == '<cron>' && '<tier>')` clauses.
 */
function mappingIn(expression: string): Map<string, string> {
  const clause = /github\.event\.schedule\s*==\s*'([^']+)'\s*&&\s*'([a-z-]+)'/g;
  const pairs = new Map<string, string>();
  for (const [, cron, tier] of expression.matchAll(clause)) {
    assert.equal(
      pairs.has(cron),
      false,
      `cron '${cron}' is mapped twice in the same expression`,
    );
    pairs.set(cron, tier);
  }
  return pairs;
}

test("every support level has exactly one nightly cron", () => {
  const mapped = [...mappingIn(workflow().env.SUPPORT).values()].sort();
  assert.deepEqual(
    mapped,
    [...SUPPORT_LEVELS].sort(),
    "SUPPORT in community-plugin-sweep.yaml must map one cron to each support level — " +
      "a level with no cron is never swept, and nothing else would report that",
  );
});

test("every scheduled cron is mapped to a tier", () => {
  const wf = workflow();
  const scheduled = (wf.on.schedule ?? []).map((entry) => entry.cron).sort();
  const mapped = [...mappingIn(wf.env.SUPPORT).keys()].sort();
  assert.deepEqual(
    scheduled,
    mapped,
    "an unmapped cron falls through to the community default, so it would sweep the " +
      "wrong tier rather than fail",
  );
});

test("concurrency reuses the same cron mapping as SUPPORT", () => {
  const wf = workflow();
  assert.deepEqual(
    [...mappingIn(wf.concurrency.group).entries()].sort(),
    [...mappingIn(wf.env.SUPPORT).entries()].sort(),
    "the two copies have drifted: a manual sweep could then run concurrently with the " +
      "scheduled sweep of the same tier",
  );
});
