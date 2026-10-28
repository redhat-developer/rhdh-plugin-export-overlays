/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

// The CLI's reporting and exit-code policy. `report` takes writers rather than
// touching process.stdout so these can assert on the exact output CI shows.

import { describe, expect, it } from "vite-plus/test";
import { byCodepoint } from "./json.ts";
import { PluginPathChecker, type FetchManifest } from "./plugin-path.ts";
import {
  checkPluginPaths,
  exitCodeFor,
  main,
  printReport,
  recordPluginPathOutcome,
  type PluginPathTally,
  type Row,
  type SchemaTally,
} from "./validate.ts";

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
    expect(exitCodeFor([passing])).toBe(0);
  });

  it("is 1 when any row failed", () => {
    expect(exitCodeFor([passing, { ...passing, status: "FAIL" }])).toBe(1);
  });

  it("ignores a mismatch tally — only a failed row sets the code", () => {
    // The workflow_dispatch sweep runs --warn-only precisely so the pre-existing
    // backlog reports without wedging the run. Mismatches must not reach here.
    expect(exitCodeFor([passing])).toBe(0);
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
    expect(io.stderr).toMatch(/Validation failed/);
  });

  it("stays quiet on stderr when everything passed", () => {
    const io = capture();
    printReport([passing], NO_SCHEMAS, { checked: false }, io.write, io.writeError);
    expect(io.stderr).toBe("");
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
    expect(io.stdout.includes("# has non-empty first example content")).toBeFalsy();
    expect(io.stdout).toMatch(/FAIL\s+b\.yaml\s+# why/);
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
    expect(io.stdout).toMatch(/\n\s{4,}- schema unavailable: HTTP 404\n/);
  });

  it("omits the schema line entirely when schemas were not checked", () => {
    const io = capture();
    printReport([passing], NO_SCHEMAS, { checked: false }, io.write, io.writeError);
    expect(io.stdout.includes("Schemas —")).toBeFalsy();
  });

  it("warns loudly when a schema run validated nothing", () => {
    // Without this a proxy outage or an all-unavailable catalogue reports
    // "PASS: 1  FAIL: 0" and reads as a green gate, having checked nothing.
    const io = capture();
    const tally: SchemaTally = { ...NO_SCHEMAS, noSchema: 1, unavailable: 5 };
    printReport([passing], tally, { checked: true }, io.write, io.writeError);
    expect(io.stdout).toMatch(/no example was checked against a schema/);
  });

  it("does not warn when at least one example was validated", () => {
    const io = capture();
    const tally: SchemaTally = { ...NO_SCHEMAS, validated: 1 };
    printReport([passing], tally, { checked: true }, io.write, io.writeError);
    expect(io.stdout.includes("no example was checked")).toBeFalsy();
  });

  it("prints a header even with no rows at all", () => {
    const io = capture();
    printReport([], NO_SCHEMAS, { checked: false }, io.write, io.writeError);
    expect(io.stdout).toMatch(/^STATUS {2}FILE\n/);
    expect(io.stdout).toMatch(/Total: 0 {2}PASS: 0 {2}FAIL: 0/);
  });
});

describe("main argument handling", () => {
  it("prints usage and exits 0 for --help", async () => {
    const io = capture();
    expect(await main(["--help"], io.write, io.writeError)).toBe(0);
    expect(io.stdout).toMatch(/Usage: validate-app-config-examples/);
  });

  it("rejects an empty --since instead of silently scanning the whole tree", async () => {
    // A blank value is falsy, so this would otherwise fall through to a
    // full-tree run — with --check-schemas, that is 178 package downloads.
    const io = capture();
    expect(await main(["--since", ""], io.write, io.writeError)).toBe(2);
    expect(io.stderr).toMatch(/--since needs a commit-ish/);
  });

  it("exits 0 with an explanation when the range touches no metadata", async () => {
    const io = capture();
    expect(await main(["--since", "HEAD"], io.write, io.writeError)).toBe(0);
    expect(io.stdout).toMatch(/nothing to validate/);
  });
});

describe("undeclared-key reporting", () => {
  const TALLY = { withOwnedSubtree: 0, withFindings: 0 };

  it("omits the undeclared line entirely when the layer did not run", () => {
    const io = capture();
    printReport([passing], NO_SCHEMAS, { checked: true }, io.write, io.writeError);
    expect(io.stdout.includes("Undeclared keys")).toBeFalsy();
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
    expect(io.stdout).toMatch(/Undeclared keys — plugin-owned subtrees: 32 {2}with findings: 7/);
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
    expect(io.stdout).toMatch(/no undeclared key could have been found/);
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
    expect(io.stdout.includes("reported, never failed")).toBeFalsy();
    expect(io.stdout.includes("could have been found")).toBeFalsy();
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
    expect(io.stdout).toMatch(/reported, never failed/);
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
    expect(exitCodeFor([withFindings])).toBe(0);
  });
});

describe("byCodepoint", () => {
  it("orders uppercase before lowercase, as Python's sorted() does", () => {
    // The property localeCompare would break: several locales sort
    // case-insensitively, which would reorder the report and break the
    // byte-identical parity with the script this replaced.
    expect(["b", "A", "a", "B"].toSorted(byCodepoint)).toEqual(["A", "B", "a", "b"]);
  });

  it("is 0 for equal strings, so sorts stay stable", () => {
    expect(byCodepoint("x", "x")).toBe(0);
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
    expect(exitCodeFor([row])).toBe(0);
    expect(exitCodeFor([{ ...row, status: "FAIL" }])).toBe(1);
  });
});

const emptyTally = (): PluginPathTally => ({
  checked: 0,
  mismatched: 0,
  unpublished: 0,
  unavailable: 0,
});
const job = (ref: string) => ({ row: { ...passing, notes: [] }, ref });

describe("plugin-path outcomes", () => {
  const OWN_REF = "oci://ghcr.io/redhat-developer/rhdh-plugin-export-overlays/a:bs_1__1!a";
  const EXTERNAL_REF = "oci://quay.io/org/dynamic-plugins:2.4.2";

  it("fails the row on a mismatch and names the ref", () => {
    const { row, ref } = job(OWN_REF);
    const tally = emptyTally();
    recordPluginPathOutcome(
      { row, ref },
      { kind: "mismatch", problem: "selects !a, but the image declares b" },
      false,
      tally,
    );
    expect(row.status).toBe("FAIL");
    expect(row.notes).toEqual([`plugin path: ${OWN_REF} selects !a, but the image declares b`]);
    expect(tally).toMatchObject({ checked: 1, mismatched: 1 });
  });

  it("notes an unpublished own tag when allowed, without failing", () => {
    const { row, ref } = job(OWN_REF);
    const tally = emptyTally();
    recordPluginPathOutcome(
      { row, ref },
      { kind: "missing", reason: "manifest unknown" },
      true,
      tally,
    );
    expect(row.status).toBe("PASS");
    expect(row.notes[0]).toMatch(/not published yet/);
    expect(tally).toMatchObject({ checked: 0, unpublished: 1 });
  });

  it("fails an unpublished own tag when not allowed", () => {
    const { row, ref } = job(OWN_REF);
    recordPluginPathOutcome(
      { row, ref },
      { kind: "missing", reason: "manifest unknown" },
      false,
      emptyTally(),
    );
    expect(row.status).toBe("FAIL");
  });

  it("fails a missing external image even when unpublished tags are allowed", () => {
    const { row, ref } = job(EXTERNAL_REF);
    recordPluginPathOutcome(
      { row, ref },
      { kind: "missing", reason: "unauthorized" },
      true,
      emptyTally(),
    );
    expect(row.status).toBe("FAIL");
  });

  it("fails rather than passes a ref the registry never answered for", () => {
    const { row, ref } = job(EXTERNAL_REF);
    const tally = emptyTally();
    recordPluginPathOutcome({ row, ref }, { kind: "unavailable", reason: "timeout" }, true, tally);
    expect(row.status).toBe("FAIL");
    expect(row.detail).toMatch(/registry unreachable/);
    expect(tally.unavailable).toBe(1);
  });

  it("keeps the detail of an earlier failure", () => {
    const row: Row = { ...passing, status: "FAIL", detail: "structural", notes: [] };
    recordPluginPathOutcome(
      { row, ref: OWN_REF },
      { kind: "mismatch", problem: "x" },
      false,
      emptyTally(),
    );
    expect(row.detail).toBe("structural");
  });

  it("checks every job and tallies the outcomes", async () => {
    const annotation = Buffer.from(JSON.stringify([{ a: {} }, { b: {} }])).toString("base64");
    const fetch: FetchManifest = async () => ({
      kind: "ok",
      manifest: JSON.stringify({ annotations: { "io.backstage.dynamic-packages": annotation } }),
    });
    const jobs = [job(`${EXTERNAL_REF}!a`), job(EXTERNAL_REF), job(`${EXTERNAL_REF}!c`)];
    const tally = await checkPluginPaths(jobs, new PluginPathChecker(fetch), false);
    expect(tally).toEqual({ checked: 3, mismatched: 2, unpublished: 0, unavailable: 0 });
    expect(jobs.map((j) => j.row.status)).toEqual(["PASS", "FAIL", "FAIL"]);
  });

  it("checks the dynamicArtifact of every metadata file with --check-plugin-paths", async () => {
    const images: string[] = [];
    const fetch: FetchManifest = async (image) => {
      images.push(image);
      return { kind: "unavailable", reason: "offline" };
    };
    const io = capture();
    const code = await main(
      ["--check-plugin-paths"],
      io.write,
      io.writeError,
      new PluginPathChecker(fetch, { attempts: 1 }),
    );
    // Offline must fail the run, never pass it unchecked.
    expect(code).toBe(1);
    expect(images.length).toBeGreaterThan(0);
    expect(io.stdout).toMatch(/registry unreachable, plugin path not checked/);
  });

  it("prints the plugin-path tally when the layer ran", () => {
    const io = capture();
    printReport(
      [passing],
      NO_SCHEMAS,
      {
        checked: false,
        pluginPaths: { checked: 0, mismatched: 0, unpublished: 2, unavailable: 0 },
      },
      io.write,
      io.writeError,
    );
    expect(io.stdout).toMatch(/Plugin paths — checked: 0 {2}mismatched: 0 {2}not published yet: 2/);
    expect(io.stdout).toMatch(/no dynamicArtifact was checked/);
  });
});
