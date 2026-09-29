import assert from "node:assert/strict";
import { test } from "node:test";
import { describeFetchError } from "../tests/support/utils/fetch-error-description.ts";

test("describes the first nested error in an AggregateError cause", () => {
  const error = new TypeError("fetch failed", {
    cause: new AggregateError([
      Object.assign(new Error("connect ECONNREFUSED ::1:65535"), {
        code: "ECONNREFUSED",
      }),
    ]),
  });

  assert.equal(
    describeFetchError(error),
    "fetch failed (connect ECONNREFUSED ::1:65535)",
  );
});

test("describes a non-aggregate cause message", () => {
  const error = new TypeError("fetch failed", {
    cause: new Error("self-signed certificate"),
  });

  assert.equal(
    describeFetchError(error),
    "fetch failed (self-signed certificate)",
  );
});
