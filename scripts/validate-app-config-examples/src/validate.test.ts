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
import { byCodepoint } from "./json.js";
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
      { checked: false },
      io.write,
      io.writeError,
    );
    assert.match(io.stderr, /Validation failed/);
  });

  it("stays quiet on stderr when everything passed", () => {
    const io = capture();
    printReport(
      [passing],
      NO_SCHEMAS,
      { checked: false },
      io.write,
      io.writeError,
    );
    assert.equal(io.stderr, "");
  });
});

describe("report output", () => {
  it("appends the detail only to non-passing rows", () => {
    const io = capture();
    printReport(
      [passing, { ...passing, status: "FAIL", path: "b.yaml", detail: "why" }],
      NO_SCHEMAS,
      { checked: false },
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
      { checked: true },
      io.write,
      io.writeError,
    );
    assert.match(io.stdout, /\n\s{4,}- schema unavailable: HTTP 404\n/);
  });

  it("omits the schema line entirely when schemas were not checked", () => {
    const io = capture();
    printReport(
      [passing],
      NO_SCHEMAS,
      { checked: false },
      io.write,
      io.writeError,
    );
    assert.ok(!io.stdout.includes("Schemas —"));
  });

  it("warns loudly when a schema run validated nothing", () => {
    // Without this a proxy outage or an all-unavailable catalogue reports
    // "PASS: 1  FAIL: 0" and reads as a green gate, having checked nothing.
    const io = capture();
    const tally: SchemaTally = { ...NO_SCHEMAS, noSchema: 1, unavailable: 5 };
    printReport([passing], tally, { checked: true }, io.write, io.writeError);
    assert.match(io.stdout, /no example was checked against a schema/);
  });

  it("does not warn when at least one example was validated", () => {
    const io = capture();
    const tally: SchemaTally = { ...NO_SCHEMAS, validated: 1 };
    printReport([passing], tally, { checked: true }, io.write, io.writeError);
    assert.ok(!io.stdout.includes("no example was checked"));
  });

  it("prints a header even with no rows at all", () => {
    const io = capture();
    printReport([], NO_SCHEMAS, { checked: false }, io.write, io.writeError);
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

describe("undeclared-key reporting", () => {
  const TALLY = { withOwnedSubtree: 0, withFindings: 0 };

  it("omits the undeclared line entirely when the layer did not run", () => {
    const io = capture();
    printReport(
      [passing],
      NO_SCHEMAS,
      { checked: true },
      io.write,
      io.writeError,
    );
    assert.ok(!io.stdout.includes("Undeclared keys"));
  });

  it("prints the tally when the layer ran", () => {
    const io = capture();
    printReport(
      [passing],
      NO_SCHEMAS,
      { checked: true, undeclared: { withOwnedSubtree: 32, withFindings: 7 } },
      io.write,
      io.writeError,
    );
    assert.match(
      io.stdout,
      /Undeclared keys — plugin-owned subtrees: 32 {2}with findings: 7/,
    );
  });

  it("says so when no example had a subtree its plugin owns", () => {
    // Same reasoning as the "no example was checked against a schema" warning:
    // 0 findings out of 0 inspected reads as a clean bill of health otherwise.
    const io = capture();
    printReport(
      [passing],
      NO_SCHEMAS,
      { checked: true, undeclared: TALLY },
      io.write,
      io.writeError,
    );
    assert.match(io.stdout, /no undeclared key could have been found/);
  });

  it("stays quiet about advisories when there is nothing to advise on", () => {
    const io = capture();
    printReport(
      [passing],
      NO_SCHEMAS,
      { checked: true, undeclared: { withOwnedSubtree: 5, withFindings: 0 } },
      io.write,
      io.writeError,
    );
    assert.ok(!io.stdout.includes("reported, never failed"));
    assert.ok(!io.stdout.includes("could have been found"));
  });

  it("explains that findings are advisory once there are any", () => {
    const io = capture();
    printReport(
      [passing],
      NO_SCHEMAS,
      { checked: true, undeclared: { withOwnedSubtree: 5, withFindings: 2 } },
      io.write,
      io.writeError,
    );
    assert.match(io.stdout, /reported, never failed/);
  });

  it("never sets a failing exit code, however many findings a row carries", () => {
    // The layer is advisory by construction: findings land in row notes, and
    // exitCodeFor reads status. A row loaded with findings must still exit 0.
    const withFindings: Row = {
      ...passing,
      notes: [
        'undeclared key in "Default configuration": Config must NOT have additional properties { additionalProperty=tpyo } at /acme',
        'undeclared key in "Default configuration": Config must NOT have additional properties { additionalProperty=oops } at /acme',
      ],
    };
    assert.equal(exitCodeFor([withFindings]), 0);
  });
});

describe("byCodepoint", () => {
  it("orders uppercase before lowercase, as Python's sorted() does", () => {
    // The property localeCompare would break: several locales sort
    // case-insensitively, which would reorder the report and break the
    // byte-identical parity with the script this replaced.
    assert.deepEqual(["b", "A", "a", "B"].sort(byCodepoint), [
      "A",
      "B",
      "a",
      "b",
    ]);
  });

  it("is 0 for equal strings, so sorts stay stable", () => {
    assert.equal(byCodepoint("x", "x"), 0);
  });
});

describe("a workspace patch that stops applying", () => {
  it("fails the row, because every other unavailable reason stays PASS", async () => {
    // Verified against the real sweep: 26 packages report unavailable and the
    // run still exits 0. A broken patch would join them invisibly, which is
    // exactly the drift the weekly sweep exists to catch.
    const row: Row = {
      status: "PASS",
      path: "workspaces/x/metadata/y.yaml",
      detail: "has non-empty first example content",
      notes: ["schema unavailable: workspace patch 1-x.patch does not apply"],
    };
    assert.equal(exitCodeFor([row]), 0);
    assert.equal(exitCodeFor([{ ...row, status: "FAIL" }]), 1);
  });
});
