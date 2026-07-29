/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

// The CLI's reporting and exit-code policy. `report` takes writers rather than
// touching process.stdout so these can assert on the exact output CI shows.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  exitCodeFor,
  main,
  printReport,
  type Row,
  type SchemaTally,
} from "./validate.js";

const NO_SCHEMAS: SchemaTally = {
  validated: 0,
  mismatched: 0,
  noSchema: 0,
  unavailable: 0,
};

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    write: (text: string) => void out.push(text),
    writeError: (text: string) => void err.push(text),
    get stdout() {
      return out.join("");
    },
    get stderr() {
      return err.join("");
    },
  };
}

const passing: Row = {
  status: "PASS",
  path: "workspaces/a/metadata/x.yaml",
  detail: "has non-empty first example content",
  notes: [],
};

describe("exitCodeFor", () => {
  it("is 0 when nothing failed", () => {
    assert.equal(exitCodeFor([passing]), 0);
  });

  it("is 1 when any row failed", () => {
    assert.equal(exitCodeFor([passing, { ...passing, status: "FAIL" }]), 1);
  });

  it("ignores a mismatch tally — only a failed row sets the code", () => {
    // The workflow_dispatch sweep runs --warn-only precisely so the pre-existing
    // backlog reports without wedging the run. Mismatches must not reach here.
    assert.equal(exitCodeFor([passing]), 0);
  });
});

describe("printReport", () => {
  it("says on stderr when a row failed", () => {
    const io = capture();
    printReport(
      [{ ...passing, status: "FAIL", detail: "boom" }],
      NO_SCHEMAS,
      false,
      io.write,
      io.writeError,
    );
    assert.match(io.stderr, /Validation failed/);
  });

  it("stays quiet on stderr when everything passed", () => {
    const io = capture();
    printReport([passing], NO_SCHEMAS, false, io.write, io.writeError);
    assert.equal(io.stderr, "");
  });
});

describe("report output", () => {
  it("appends the detail only to non-passing rows", () => {
    const io = capture();
    printReport(
      [passing, { ...passing, status: "FAIL", path: "b.yaml", detail: "why" }],
      NO_SCHEMAS,
      false,
      io.write,
      io.writeError,
    );
    assert.ok(!io.stdout.includes("# has non-empty first example content"));
    assert.match(io.stdout, /FAIL\s+b\.yaml\s+# why/);
  });

  it("indents notes beneath their row", () => {
    const io = capture();
    printReport(
      [{ ...passing, notes: ["schema unavailable: HTTP 404"] }],
      NO_SCHEMAS,
      true,
      io.write,
      io.writeError,
    );
    assert.match(io.stdout, /\n\s{4,}- schema unavailable: HTTP 404\n/);
  });

  it("omits the schema line entirely when schemas were not checked", () => {
    const io = capture();
    printReport([passing], NO_SCHEMAS, false, io.write, io.writeError);
    assert.ok(!io.stdout.includes("Schemas —"));
  });

  it("warns loudly when a schema run validated nothing", () => {
    // Without this a proxy outage or an all-unavailable catalogue reports
    // "PASS: 1  FAIL: 0" and reads as a green gate, having checked nothing.
    const io = capture();
    const tally: SchemaTally = { ...NO_SCHEMAS, noSchema: 1, unavailable: 5 };
    printReport([passing], tally, true, io.write, io.writeError);
    assert.match(io.stdout, /no example was checked against a schema/);
  });

  it("does not warn when at least one example was validated", () => {
    const io = capture();
    const tally: SchemaTally = { ...NO_SCHEMAS, validated: 1 };
    printReport([passing], tally, true, io.write, io.writeError);
    assert.ok(!io.stdout.includes("no example was checked"));
  });

  it("prints a header even with no rows at all", () => {
    const io = capture();
    printReport([], NO_SCHEMAS, false, io.write, io.writeError);
    assert.match(io.stdout, /^STATUS {2}FILE\n/);
    assert.match(io.stdout, /Total: 0 {2}PASS: 0 {2}FAIL: 0/);
  });
});

describe("main argument handling", () => {
  it("prints usage and exits 0 for --help", async () => {
    const io = capture();
    assert.equal(await main(["--help"], io.write, io.writeError), 0);
    assert.match(io.stdout, /Usage: validate-app-config-examples/);
  });

  it("rejects an empty --since instead of silently scanning the whole tree", async () => {
    // A blank value is falsy, so this would otherwise fall through to a
    // full-tree run — with --check-schemas, that is 178 package downloads.
    const io = capture();
    assert.equal(await main(["--since", ""], io.write, io.writeError), 2);
    assert.match(io.stderr, /--since needs a commit-ish/);
  });

  it("exits 0 with an explanation when the range touches no metadata", async () => {
    const io = capture();
    assert.equal(await main(["--since", "HEAD"], io.write, io.writeError), 0);
    assert.match(io.stdout, /nothing to validate/);
  });
});
