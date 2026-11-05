/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { compareStrings, errorMessage, lastErrorLine } from "./util";

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

test("lastErrorLine keeps the error a CLI printed last", () => {
  // skopeo logs context first and its verdict last; the report entry is one line.
  const failed = Object.assign(new Error("Command failed: skopeo inspect"), {
    stderr:
      'time="..." level=debug msg="retrying"\nError: reading manifest x: manifest unknown\n',
  });
  assert.equal(
    lastErrorLine(failed),
    "Error: reading manifest x: manifest unknown",
  );
  // No stderr (a timeout kill, a spawn error): the message is all there is.
  assert.equal(
    lastErrorLine(
      Object.assign(new Error("spawn skopeo EACCES"), { stderr: "" }),
    ),
    "spawn skopeo EACCES",
  );
  assert.equal(lastErrorLine("plain"), "plain");
});
