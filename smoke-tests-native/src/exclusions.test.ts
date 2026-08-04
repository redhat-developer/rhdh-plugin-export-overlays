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

// src/ → smoke-tests-native/
const HARNESS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXCLUDES_FILE = join(HARNESS_ROOT, "plugin-sweep-excludes.txt");

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
    parsed.map((e) => [e.scope, e.source, e.ticket]),
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

test("matchExclusion sees through the dynamic export's -dynamic suffix", () => {
  // metadata says `@scope/plugin-a`; the installed package.json says
  // `@scope/plugin-a-dynamic`. One anchored pattern has to match at both scopes.
  const parsed = parseExclusions(
    "# TODO(RHIDP-1): r\nboot ^@scope/plugin-a$\n",
    "test",
  );
  assert.equal(
    matchExclusion(parsed, "boot", "@scope/plugin-a")?.ticket,
    "RHIDP-1",
  );
  assert.equal(
    matchExclusion(parsed, "boot", "@scope/plugin-a-dynamic")?.ticket,
    "RHIDP-1",
  );
  // A pattern written with the suffix still matches the suffixed name.
  const suffixed = parseExclusions(
    "# TODO(RHIDP-1): r\nboot ^@scope/plugin-b-dynamic$\n",
    "test",
  );
  assert.equal(
    matchExclusion(suffixed, "boot", "@scope/plugin-b-dynamic")?.ticket,
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
    pattern: "^@scope/plugin-a$",
  });
  assert.equal(excluded("@scope/plugin-z"), undefined);
});

test("the committed exclusions file parses and every entry has a ticket", () => {
  // Guards the file itself: a hand-edited entry without a ticket, or with a typo in
  // the scope, fails here rather than at 03:00 in the scheduled sweep.
  const parsed = loadExclusions(EXCLUDES_FILE);
  assert.ok(parsed.length > 0, "expected at least one tracked exclusion");
  for (const exclusion of parsed) {
    assert.match(exclusion.ticket, /^[A-Z][A-Z0-9]+-\d+$/);
  }
});
