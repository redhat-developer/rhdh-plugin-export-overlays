/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  excluderFor,
  loadExclusions,
  matchExclusion,
  parseExclusions,
} from "./exclusions";
import { collectPackages } from "./support";

// src/ → smoke-tests-native/
const HARNESS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXCLUDES_FILE = join(HARNESS_ROOT, "plugin-sweep-excludes.txt");
const REPO_ROOT = dirname(HARNESS_ROOT);

test("parseExclusions reads scope, pattern and the block's ticket", () => {
  const parsed = parseExclusions(
    [
      "# header comment, no ticket, no patterns",
      "",
      "# TODO(RHIDP-16017): catalog core does not boot standalone.",
      "boot ^@scope/plugin-a$",
      "boot ^@scope/plugin-b$",
      "",
      "# TODO(RHDHBUGS-1234): not published anywhere public.",
      "install ^@scope/plugin-c$",
    ].join("\n"),
    "test",
  );
  assert.deepEqual(
    parsed.map((e) => [e.scope, e.patternSource, e.ticket]),
    [
      ["boot", "^@scope/plugin-a$", "RHIDP-16017"],
      ["boot", "^@scope/plugin-b$", "RHIDP-16017"],
      ["install", "^@scope/plugin-c$", "RHDHBUGS-1234"],
    ],
  );
});

test("parseExclusions rejects a pattern with no ticket", () => {
  assert.throws(
    () => parseExclusions("boot ^@scope/plugin-a$\n", "test"),
    /no tracking ticket/,
  );
});

test("parseExclusions does not let a pattern inherit a ticket across a blank line", () => {
  // The blank line ends the block: plugin-b is a different entry and needs its own
  // ticket, otherwise exclusions accumulate under a ticket that never covered them.
  assert.throws(
    () =>
      parseExclusions(
        [
          "# TODO(RHIDP-16017): reason.",
          "boot ^@scope/plugin-a$",
          "",
          "boot ^@scope/plugin-b$",
        ].join("\n"),
        "test",
      ),
    /test:4: .* no tracking ticket/,
  );
});

test("parseExclusions rejects malformed entries", () => {
  assert.throws(
    () => parseExclusions("# TODO(RHIDP-1): r\nbanish ^a$\n", "test"),
    /unknown scope 'banish'/,
  );
  assert.throws(
    () => parseExclusions("# TODO(RHIDP-1): r\nboot ^a$ ^b$\n", "test"),
    /expected '<scope> <regex>'/,
  );
  assert.throws(
    () =>
      parseExclusions("# TODO(RHIDP-1): r\nboot ^@scope/(unclosed$\n", "test"),
    /invalid regex/,
  );
  assert.throws(
    () => parseExclusions("# TODO(RHIDP-1): r\nboot\n", "test"),
    /expected '<scope> <regex>'/,
  );
});

test("matchExclusion only matches within its own scope", () => {
  const parsed = parseExclusions(
    "# TODO(RHIDP-1): r\nboot ^@scope/plugin-a$\n",
    "test",
  );
  assert.equal(
    matchExclusion(parsed, "boot", "@scope/plugin-a")?.ticket,
    "RHIDP-1",
  );
  assert.equal(matchExclusion(parsed, "install", "@scope/plugin-a"), undefined);
  assert.equal(
    matchExclusion(parsed, "boot", "@scope/plugin-a-extra"),
    undefined,
  );
});

test("matchExclusion sees through the -dynamic suffix in both directions", () => {
  // metadata says `@scope/plugin-a`; the installed package.json says
  // `@scope/plugin-a-dynamic`. One anchored pattern must select the same package at
  // install scope (metadata name) and boot scope (installed name), whichever form the
  // author wrote it in — otherwise the two scopes silently cover different sets.
  const base = parseExclusions(
    "# TODO(RHIDP-1): r\nboot ^@scope/plugin-a$\n",
    "test",
  );
  assert.equal(
    matchExclusion(base, "boot", "@scope/plugin-a")?.ticket,
    "RHIDP-1",
  );
  assert.equal(
    matchExclusion(base, "boot", "@scope/plugin-a-dynamic")?.ticket,
    "RHIDP-1",
  );

  const suffixed = parseExclusions(
    "# TODO(RHIDP-1): r\nboot ^@scope/plugin-b-dynamic$\n",
    "test",
  );
  assert.equal(
    matchExclusion(suffixed, "boot", "@scope/plugin-b-dynamic")?.ticket,
    "RHIDP-1",
  );
  assert.equal(
    matchExclusion(suffixed, "boot", "@scope/plugin-b")?.ticket,
    "RHIDP-1",
  );
});

test("a malformed TODO marker is ignored, not inherited and not fatal", () => {
  // This parses in the plan job before anything is pulled, so throwing meant a typo in
  // a comment took down the whole scheduled sweep. Clearing the ticket instead makes
  // the pattern below fail with the far clearer "no tracking ticket" error.
  for (const bad of ["# TODO(X-1): too short", "# TODO(RHIDP16018): no dash"]) {
    assert.throws(
      () =>
        parseExclusions(
          [
            "# TODO(RHIDP-1): first",
            "boot ^@scope/a$",
            bad,
            "boot ^@scope/b$",
          ].join("\n"),
          "test",
        ),
      /no tracking ticket/,
      `'${bad}' must not let the pattern below inherit the previous ticket`,
    );
  }
  // With no pattern under it, a malformed marker is harmless documentation.
  assert.deepEqual(
    parseExclusions(
      ["# TODO(TICKET): describes the format", ""].join("\n"),
      "test",
    ),
    [],
  );
});

test("one exclusion can cite more than one blocking ticket", () => {
  const parsed = parseExclusions(
    "# TODO(RHIDP-1, RHDHBUGS-2): blocked by both.\nboot ^@scope/a$\n",
    "test",
  );
  assert.deepEqual(
    parsed.map((e) => e.ticket),
    ["RHIDP-1, RHDHBUGS-2"],
  );
});

test("a plain comment between the ticket and its patterns keeps the ticket", () => {
  const parsed = parseExclusions(
    ["# TODO(RHIDP-1): why", "# more prose, no ticket", "boot ^@scope/a$"].join(
      "\n",
    ),
    "test",
  );
  assert.deepEqual(
    parsed.map((e) => e.ticket),
    ["RHIDP-1"],
  );
});

test("matchExclusion returns the first matching pattern when several apply", () => {
  const parsed = parseExclusions(
    [
      "# TODO(RHIDP-1): broad",
      "boot ^@scope/",
      "",
      "# TODO(RHIDP-2): narrow",
      "boot ^@scope/plugin-a$",
    ].join("\n"),
    "test",
  );
  // The ticket that lands in the report is the first match, not the most specific.
  assert.equal(
    matchExclusion(parsed, "boot", "@scope/plugin-a")?.ticket,
    "RHIDP-1",
  );
});

test("excluderFor returns a record carrying the ticket", () => {
  const excluded = excluderFor(
    parseExclusions("# TODO(RHIDP-1): r\ninstall ^@scope/plugin-a$\n", "test"),
    "install",
  );
  assert.deepEqual(excluded("@scope/plugin-a"), {
    packageName: "@scope/plugin-a",
    scope: "install",
    ticket: "RHIDP-1",
    patternSource: "^@scope/plugin-a$",
  });
  assert.equal(excluded("@scope/plugin-z"), undefined);
});

test("every committed exclusion still matches a package in the repo", () => {
  // Guards the file itself: a malformed entry fails in loadExclusions rather than at
  // 03:00 in the scheduled sweep. Asserting the ticket format here would only re-assert
  // the regex that produced it, so check the entries against reality instead — an
  // exclusion that matches nothing is invisible debt whose ticket can be closed.
  const parsed = loadExclusions(EXCLUDES_FILE);
  assert.ok(parsed.length > 0, "expected at least one tracked exclusion");
  const names = collectPackages(REPO_ROOT).map((p) => p.packageName);
  // Route through matchExclusion, not the raw pattern: candidateNames also matches the
  // -dynamic form, so testing patterns directly would report a valid exclusion written
  // in that form as stale debt.
  const stale = parsed
    .filter((e) => !names.some((n) => matchExclusion([e], e.scope, n)))
    .map((e) => `${e.patternSource} (${e.ticket}, line ${e.line})`);
  assert.deepEqual(stale, [], "exclusions matching no package in the repo");
});
