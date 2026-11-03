/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

// The CLI's reporting and exit-code policy. `report` takes writers rather than
// touching process.stdout so these can assert on the exact output CI shows.

import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { byCodepoint } from "./json.ts";
import { PluginPathChecker, type FetchManifest } from "./plugin-path.ts";
import { parsePublishedImages } from "./published-images.ts";
import {
  checkPluginPaths,
  exitCodeFor,
  main,
  pluginPathJobFor,
  printReport,
  recordPluginPathOutcome,
  countPublishedMatches,
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

const missingEverywhere: FetchManifest = async () => ({
  kind: "missing",
  reason: "manifest unknown",
});

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

  it("fails a malformed own ref even when its tag is unpublished", async () => {
    // A bare trailing "!": the install CLI rejects it.
    const jobs = [job("oci://ghcr.io/redhat-developer/rhdh-plugin-export-overlays/a:bs_1__1!")];
    const tally = await checkPluginPaths(jobs, new PluginPathChecker(missingEverywhere), true);
    expect(tally).toEqual({ checked: 1, mismatched: 1, unpublished: 0, unavailable: 0 });
    expect(jobs[0]?.row.status).toBe("FAIL");
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

  it("notes unpublished own tags with --allow-unpublished, and fails external ones", async () => {
    const io = capture();
    const code = await main(
      ["--check-plugin-paths", "--allow-unpublished"],
      io.write,
      io.writeError,
      new PluginPathChecker(missingEverywhere),
    );
    // Own ghcr tags are noted; the external cost-management bundle still fails.
    expect(io.stdout).toMatch(/not published yet: [1-9]/);
    expect(io.stdout).toMatch(/dynamicArtifact names an image that cannot be pulled/);
    expect(code).toBe(1);
  });

  it("reads no manifest without --check-plugin-paths", async () => {
    let calls = 0;
    const fetch: FetchManifest = async () => {
      calls += 1;
      return { kind: "unavailable", reason: "offline" };
    };
    const io = capture();
    await main([], io.write, io.writeError, new PluginPathChecker(fetch));
    expect(calls).toBe(0);
    expect(io.stdout.includes("Plugin paths")).toBeFalsy();
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

function publishedFile(lines: string[]): string {
  const file = join(mkdtempSync(join(tmpdir(), "published-images-")), "published-exports.txt");
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

/** A registry where every image declares `paths`, recording what was read. */
function registryDeclaring(...paths: string[]) {
  const images: string[] = [];
  const annotation = Buffer.from(JSON.stringify(paths.map((p) => ({ [p]: {} })))).toString(
    "base64",
  );
  const fetch: FetchManifest = async (image) => {
    images.push(image);
    return {
      kind: "ok",
      manifest: JSON.stringify({ annotations: { "io.backstage.dynamic-packages": annotation } }),
    };
  };
  return { fetch, images };
}

function packageDoc(ref: string) {
  return { kind: "Package", spec: { dynamicArtifact: ref } };
}

describe("checking against a PR's published images", () => {
  const OWN = "ghcr.io/redhat-developer/rhdh-plugin-export-overlays";
  // adoption-insights: three own refs, none with a selector.
  const NAMES = [
    "red-hat-developer-hub-backstage-plugin-adoption-insights-backend",
    "red-hat-developer-hub-backstage-plugin-adoption-insights",
    "red-hat-developer-hub-backstage-plugin-analytics-module-adoption-insights",
  ];

  it("reads only the published images of the workspace's own refs", async () => {
    const file = publishedFile(NAMES.map((name) => `${OWN}/${name}:pr_9__1.0.5`));
    const { fetch, images } = registryDeclaring("only-plugin");
    const io = capture();
    const code = await main(
      [
        "--workspace",
        "workspaces/adoption-insights",
        "--check-plugin-paths",
        "--published-images",
        file,
      ],
      io.write,
      io.writeError,
      new PluginPathChecker(fetch),
    );
    expect(images.toSorted()).toEqual(NAMES.map((name) => `${OWN}/${name}:pr_9__1.0.5`).toSorted());
    expect(io.stdout).toMatch(/own refs checked against them: 3 of 3/);
    expect(code).toBe(0);
  });

  it("fails a published image that would leave a selector-less ref ambiguous, naming the PR image", async () => {
    const file = publishedFile(NAMES.map((name) => `${OWN}/${name}:pr_9__1.0.5`));
    const { fetch } = registryDeclaring("a", "b");
    const io = capture();
    const code = await main(
      ["--workspace", "adoption-insights", "--check-plugin-paths", "--published-images", file],
      io.write,
      io.writeError,
      new PluginPathChecker(fetch),
    );
    expect(code).toBe(1);
    expect(io.stdout).toMatch(/plugin path: oci:\/\/\S+:pr_9__1\.0\.5 2 plugins in the image/);
  });

  it("fails a listed image the registry does not have, even with --allow-unpublished", async () => {
    // The run just pushed it: a missing pr_* tag is a broken list, not a pending merge.
    const file = publishedFile(NAMES.map((name) => `${OWN}/${name}:pr_9__1.0.5`));
    const io = capture();
    const code = await main(
      [
        "--workspace",
        "adoption-insights",
        "--check-plugin-paths",
        "--allow-unpublished",
        "--published-images",
        file,
      ],
      io.write,
      io.writeError,
      new PluginPathChecker(missingEverywhere),
    );
    expect(code).toBe(1);
    expect(io.stdout).toMatch(/not published yet: 0/);
    expect(io.stdout).toMatch(/plugin path: oci:\/\/\S+:pr_9__1\.0\.5: /);
  });

  it("exits 2 when own refs exist and the list matches none of them", async () => {
    const file = publishedFile([`${OWN}/unrelated:pr_9__1.0.0`]);
    const io = capture();
    const code = await main(
      [
        "--workspace",
        "adoption-insights",
        "--check-plugin-paths",
        "--allow-unpublished",
        "--published-images",
        file,
      ],
      io.write,
      io.writeError,
      new PluginPathChecker(missingEverywhere),
    );
    expect(code).toBe(2);
    expect(io.stderr).toMatch(/no ref matches a listed image/);
  });

  it.each([
    ["outside the working and temp directories", () => "/etc/hosts"],
    [
      "a temp-dir symlink to a file outside them",
      () => {
        const link = join(mkdtempSync(join(tmpdir(), "published-images-")), "link.txt");
        symlinkSync("/etc/hosts", link);
        return link;
      },
    ],
  ])("refuses a --published-images file %s", async (_label, path) => {
    const io = capture();
    const code = await main(
      ["--workspace", "adoption-insights", "--check-plugin-paths", "--published-images", path()],
      io.write,
      io.writeError,
      new PluginPathChecker(missingEverywhere),
    );
    expect(code).toBe(2);
    expect(io.stderr).toMatch(/--published-images must be a file under/);
  });

  it("exits 0 when the workspace has no own refs to match", async () => {
    // cost-management points only at an external bundle.
    const file = publishedFile([`${OWN}/unrelated:pr_9__1.0.0`]);
    const { fetch } = registryDeclaring(
      "red-hat-developer-hub-plugin-cost-management",
      "red-hat-developer-hub-plugin-cost-management-backend",
    );
    const io = capture();
    const code = await main(
      ["--workspace", "cost-management", "--check-plugin-paths", "--published-images", file],
      io.write,
      io.writeError,
      new PluginPathChecker(fetch),
    );
    expect(io.stdout).toMatch(/own refs checked against them: 0 of 0/);
    expect(code).toBe(0);
  });

  it("validates only the named workspace", async () => {
    const io = capture();
    await main(["--workspace", "adoption-insights"], io.write, io.writeError);
    const files = io.stdout.match(/workspaces\/\S+\.yaml/g) ?? [];
    expect(files.length).toBe(3);
    expect(files.every((path) => path.startsWith("workspaces/adoption-insights/metadata/"))).toBe(
      true,
    );
  });

  it("exits 0 with an explanation for a workspace without metadata", async () => {
    const io = capture();
    expect(await main(["--workspace", "no-such-workspace"], io.write, io.writeError)).toBe(0);
    expect(io.stdout).toMatch(/nothing to validate/);
  });

  it.each([
    [["--workspace", "a", "--since", "HEAD"], /cannot be combined/],
    [["--workspace", "*"], /needs a workspace name/],
    [["--workspace", "../a"], /needs a workspace name/],
    [["--workspace", ".."], /needs a workspace name/],
    [["--published-images", "x.txt"], /needs --check-plugin-paths/],
  ])("rejects %j", async (argv, message) => {
    const io = capture();
    expect(await main(argv, io.write, io.writeError)).toBe(2);
    expect(io.stderr).toMatch(message);
  });

  it("retargets a row's job only when its ref is published", () => {
    const published = parsePublishedImages(`${OWN}/a:pr_1__2.0.0`);
    expect(
      pluginPathJobFor(passing, packageDoc(`oci://${OWN}/a:bs_1__2.0.0!a`), published),
    ).toEqual([{ row: passing, ref: `oci://${OWN}/a:pr_1__2.0.0!a`, retargeted: true }]);
    expect(pluginPathJobFor(passing, packageDoc(`oci://${OWN}/b:bs_1__2.0.0`), published)).toEqual([
      { row: passing, ref: `oci://${OWN}/b:bs_1__2.0.0` },
    ]);
  });

  it("fails a malformed own ref on its form, not as an unmatched published image", async () => {
    const published = parsePublishedImages(`${OWN}/a:pr_1__2.0.0`);
    const row: Row = { ...passing, notes: [] };
    // No tag: retargeted, it would read as a well-formed pr_* ref.
    const jobs = pluginPathJobFor(row, packageDoc(`oci://${OWN}/a!a`), published);
    const tally = await checkPluginPaths(jobs, new PluginPathChecker(missingEverywhere), true);
    expect(tally).toEqual({ checked: 1, mismatched: 1, unpublished: 0, unavailable: 0 });
    expect(row.status).toBe("FAIL");
    expect(countPublishedMatches(jobs)).toEqual({ matched: 0, own: 0 });
  });

  it("counts a retargeted job as own even though its registry is a fork's", () => {
    expect(
      countPublishedMatches([
        { ...job("oci://ghcr.io/someone/r/a:pr_1__1"), retargeted: true },
        job(`oci://${OWN}/b:bs_1__1`),
        job("oci://quay.io/x/c:1"),
      ]),
    ).toEqual({ matched: 1, own: 2 });
  });

  it("prints the match count beneath the plugin-path tally", () => {
    const io = capture();
    printReport(
      [passing],
      NO_SCHEMAS,
      {
        checked: false,
        pluginPaths: { checked: 1, mismatched: 0, unpublished: 1, unavailable: 0 },
        published: { matched: 1, own: 2 },
      },
      io.write,
      io.writeError,
    );
    expect(io.stdout).toMatch(
      /Plugin paths — .*\nPublished images — own refs checked against them: 1 of 2\n/,
    );
  });
});
