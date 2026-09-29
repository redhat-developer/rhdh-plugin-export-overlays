/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { compareStrings, errorMessage } from "./util";

test("errorMessage unwraps an Error and stringifies anything else", () => {
  // String(new Error("x")) is "Error: x" — the prefix would leak into every
  // operator-facing message the CLIs print.
  assert.equal(errorMessage(new Error("cfg invalid")), "cfg invalid");
  assert.equal(errorMessage(new TypeError("bad")), "bad");
  assert.equal(errorMessage("plain string"), "plain string");
  assert.equal(errorMessage(undefined), "undefined");
  assert.equal(errorMessage({ code: "ENOENT" }), "[object Object]");
});

test("compareStrings orders by code unit, not by locale", () => {
  // localeCompare would put "alpha" before "Alpha"; code-unit ordering is what makes
  // the plan identical on every runner.
  assert.deepEqual(["zebra", "Alpha", "alpha", "3scale"].sort(compareStrings), [
    "3scale",
    "Alpha",
    "alpha",
    "zebra",
  ]);
  assert.equal(compareStrings("a", "a"), 0);
});
