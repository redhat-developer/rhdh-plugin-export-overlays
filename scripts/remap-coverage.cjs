//
// Remap browser E2E coverage from instrumented plugin BUNDLES back to the
// original plugin SOURCE, then emit lcov + a text summary.
//
// Why this exists:
//   scripts/instrument-plugin.sh instruments the already-built plugin bundles
//   (`dist/` and `dist-scalprum/`) with nyc, so the coverage collected in the
//   browser is keyed by bundle paths that only existed in the publish job's temp
//   dir (e.g. `/tmp/tmp.XXXX/orig-dist/static/foo.chunk.js`). `nyc report` cannot
//   resolve those paths on the test runner and reports 0/0.
//
//   nyc instruments with `--source-map`, so every coverage entry carries an
//   embedded `inputSourceMap` (with `sourcesContent`). This script applies those
//   maps to remap coverage onto the original source files, normalizes the
//   `webpack://<remote>/...` paths, drops node_modules and bundler runtime, and
//   writes lcov for Codecov.
//
//   Each plugin's coverage is CONCATENATED onto a single committed anchor file
//   (`workspaces/<ws>/coverage-anchors/<remote>`, created once by
//   generate-coverage-anchors.sh): Codecov only keeps report entries whose
//   paths exist in this repo's git tree at the uploaded commit, and the
//   plugins' real sources live in the upstream repo. It validates the path's
//   existence but not its content or length, so per-source-file line ranges
//   are shifted onto consecutive ranges of the anchor — the aggregated
//   percentage is preserved exactly (sum of hits / sum of lines) without
//   mirroring (and continually re-syncing) the upstream source tree here. The
//   per-source-file breakdown is printed below so it still lands in CI logs.
//   The webpack remote is the plugin's scalprum name, which also names the
//   anchor; keying by remote prevents same-named sources from different
//   plugins in one workspace (e.g. two `src/index.ts`) from being merged into
//   one bogus entry.
//
//   The owning workspace of each remote is DISCOVERED from the committed
//   anchors themselves (`workspaces/*/coverage-anchors/<remote>`), so a single
//   run covering several workspaces (the nightly) needs no external mapping.
//   Besides the combined report in <report-dir>, a per-workspace
//   `<report-dir>/<workspace>/lcov.info` is written for each workspace that
//   contributed coverage — refresh-coverage-snapshot.sh keeps each as a
//   committed `coverage-snapshots/<workspace>.lcov`, which the seed later
//   uploads under its own `e2e-<workspace>` Codecov flag.
//
// Usage:
//   node scripts/remap-coverage.cjs <nyc-output-json> [report-dir]
//
// Requires istanbul-lib-coverage, istanbul-lib-source-maps, istanbul-lib-report,
// istanbul-reports to be resolvable (installed by remap-lcov.sh).

const fs = require("node:fs");
const libCoverage = require("istanbul-lib-coverage");
const libSourceMaps = require("istanbul-lib-source-maps");
const libReport = require("istanbul-lib-report");
const reports = require("istanbul-reports");

const inputJson = process.argv[2];
const reportDir = process.argv[3] || "coverage";

if (!inputJson) {
  console.error("Usage: remap-coverage.cjs <nyc-output-json> [report-dir]");
  process.exit(1);
}

// Split a remapped source identifier into its webpack remote (the plugin's
// scalprum name) and a clean source-relative path, or null if it is not real
// plugin source (node_modules, webpack/MF runtime, synthetic).
function parseSourcePath(file) {
  if (/node_modules/.test(file)) return null;

  // Split the `webpack:/<remote>/<path>` scheme that istanbul prepends.
  const match = file.match(/webpack:\/+([^/]+)\/(.*)$/);
  if (!match) return null; // no source-map origin → not real source
  const [, remote, rawPath] = match;

  // Drop webpack/module-federation runtime modules and anything that is not a
  // source file (synthetic entries like `==void 0`, css, etc.).
  if (/^(webpack|module_federation)\//.test(rawPath)) return null;
  if (!/\.[cm]?[jt]sx?$/.test(rawPath)) return null;

  // `./src/foo.tsx` → `src/foo.tsx`; `../tech-radar-common/src/x.ts` →
  // `tech-radar-common/src/x.ts`
  return { remote, path: rawPath.replace(/^(\.\.?\/)+/, "") };
}

// Highest line number referenced by a FileCoverage — the size of the window
// this file occupies on the anchor.
function maxLine(data) {
  let max = 0;
  const see = (loc) => {
    if (loc?.start?.line > max) max = loc.start.line;
    if (loc?.end?.line > max) max = loc.end.line;
  };
  Object.values(data.statementMap).forEach(see);
  Object.values(data.fnMap).forEach((fn) => {
    see(fn.decl);
    see(fn.loc);
  });
  Object.values(data.branchMap).forEach((br) => {
    see(br.loc);
    br.locations.forEach(see);
  });
  return max;
}

// Append `data`'s statements/functions/branches to the anchor FileCoverage,
// shifting all line numbers by `offset` and re-keying with a unique prefix so
// entries from different source files never collide.
function appendShifted(anchor, data, offset, prefix) {
  const shiftLoc = (loc) =>
    loc && {
      start: { line: (loc.start?.line || 0) + offset, column: loc.start?.column ?? 0 },
      end: { line: (loc.end?.line || 0) + offset, column: loc.end?.column ?? 0 },
    };
  for (const [k, loc] of Object.entries(data.statementMap)) {
    anchor.statementMap[`${prefix}_${k}`] = shiftLoc(loc);
    anchor.s[`${prefix}_${k}`] = data.s[k];
  }
  for (const [k, fn] of Object.entries(data.fnMap)) {
    anchor.fnMap[`${prefix}_${k}`] = {
      ...fn,
      decl: shiftLoc(fn.decl),
      loc: shiftLoc(fn.loc),
      line: (fn.line || fn.decl?.start?.line || 0) + offset,
    };
    anchor.f[`${prefix}_${k}`] = data.f[k];
  }
  for (const [k, br] of Object.entries(data.branchMap)) {
    anchor.branchMap[`${prefix}_${k}`] = {
      ...br,
      loc: shiftLoc(br.loc),
      locations: br.locations.map(shiftLoc),
      line: (br.line || br.loc?.start?.line || 0) + offset,
    };
    // Copy the hit-count array — sharing the reference with the source map
    // would let a future mutation skew both sides silently.
    anchor.b[`${prefix}_${k}`] = [...data.b[k]];
  }
}

// Deterministic, locale-independent string ordering.
function byName(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

// Group remapped coverage by webpack remote, re-keyed onto clean source paths.
// addFileCoverage merges by location, so the same source covered by both the
// MF and Scalprum builds combines safely.
function groupByRemote(remappedCoverage) {
  const byRemote = new Map();
  for (const file of remappedCoverage.files()) {
    const parsed = parseSourcePath(file);
    if (!parsed) continue;
    if (!byRemote.has(parsed.remote)) {
      byRemote.set(parsed.remote, libCoverage.createCoverageMap({}));
    }
    const data = structuredClone(remappedCoverage.fileCoverageFor(file).data);
    data.path = parsed.path;
    byRemote.get(parsed.remote).addFileCoverage(data);
  }
  return byRemote;
}

// Find which workspace owns a remote by locating its committed anchor file.
// The anchor's location IS the remote->workspace mapping: each workspace
// commits one anchor per deployed plugin, named by scalprum name.
function findAnchorWorkspace(remote) {
  const owners = fs
    .readdirSync("workspaces", { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((ws) => fs.existsSync(`workspaces/${ws}/coverage-anchors/${remote}`))
    .sort(byName);
  if (owners.length > 1) {
    // Two workspaces deploying the same plugin — the coverage can't tell which
    // deployment it came from. Attribute deterministically and say so.
    console.warn(
      `[remap] remote '${remote}' has anchors in multiple workspaces ` +
        `(${owners.join(", ")}) — attributing to '${owners[0]}'`,
    );
  }
  return owners[0] || null;
}

// Concatenate one remote's per-file coverage onto its anchor FileCoverage,
// shifting line ranges so files occupy consecutive windows.
function buildAnchor(map, remote, anchorPath) {
  const anchor = {
    path: anchorPath,
    statementMap: {},
    fnMap: {},
    branchMap: {},
    s: {},
    f: {},
    b: {},
  };
  let offset = 0;
  console.log(`[remap] ${remote}:`);
  for (const [i, file] of [...map.files()].sort(byName).entries()) {
    const data = map.fileCoverageFor(file).data;
    appendShifted(anchor, data, offset, `f${i}`);
    offset += maxLine(data) + 1;
    // The anchor hides per-file detail from Codecov — keep it in CI logs.
    const s = map.fileCoverageFor(file).toSummary().data.lines;
    console.log(`[remap]   ${file}: ${s.covered}/${s.total} lines (${s.pct}%)`);
  }
  return anchor;
}

// One report entry per remote, on its committed anchor file, grouped by the
// owning workspace. Remotes with no committed anchor anywhere are dropped and
// reported: Codecov would silently discard them anyway, and a non-empty list
// means a newly deployed plugin needs generate-coverage-anchors.sh re-run.
function buildWorkspaceMaps(byRemote) {
  const byWorkspace = new Map();
  const missing = [];
  const sorted = [...byRemote.entries()].sort((a, b) => byName(a[0], b[0]));
  for (const [remote, map] of sorted) {
    const ws = findAnchorWorkspace(remote);
    if (!ws) {
      missing.push(remote);
      continue;
    }
    if (!byWorkspace.has(ws)) {
      byWorkspace.set(ws, libCoverage.createCoverageMap({}));
    }
    const anchorPath = `workspaces/${ws}/coverage-anchors/${remote}`;
    byWorkspace.get(ws).addFileCoverage(buildAnchor(map, remote, anchorPath));
  }
  return { byWorkspace, missing };
}

function writeReport(dir, coverageMap, formats) {
  fs.mkdirSync(dir, { recursive: true });
  const context = libReport.createContext({ dir, coverageMap });
  formats.forEach((format) => reports.create(format).execute(context));
}

function linesSummary(coverageMap) {
  const summary = libCoverage.createCoverageSummary();
  coverageMap
    .files()
    .forEach((f) => summary.merge(coverageMap.fileCoverageFor(f).toSummary()));
  return summary.data.lines;
}

(async () => {
  const raw = JSON.parse(fs.readFileSync(inputJson, "utf8"));
  const store = libSourceMaps.createSourceMapStore();
  const transformed = await store.transformCoverage(
    libCoverage.createCoverageMap(raw),
  );
  const byRemote = groupByRemote(transformed.map || transformed);
  const { byWorkspace, missing } = buildWorkspaceMaps(byRemote);

  if (missing.length > 0) {
    console.warn(
      `[remap] ${missing.length} plugin(s) have no committed anchor file in ` +
        "any workspace and were dropped — run " +
        "./scripts/generate-coverage-anchors.sh <workspace> for the owning " +
        "workspace and commit the result:",
    );
    missing.forEach((r) => console.warn(`[remap]   missing anchor for: ${r}`));
  }

  // Fail loudly (refresh-coverage-snapshot.sh treats this as "nothing to
  // snapshot") rather than write an empty lcov: zero source files means the
  // source maps, path normalization or anchor discovery broke, and silently
  // snapshotting nothing is the failure mode this whole pipeline exists to avoid.
  if (byWorkspace.size === 0) {
    console.error(
      "[remap] no source files after remap — coverage is empty. " +
        "Check that the bundles were instrumented with --source-map, and " +
        "that the workspaces' coverage-anchors files are committed (see " +
        "warnings above).",
    );
    process.exit(1);
  }

  // Combined report (all workspaces) for humans + per-workspace lcov that
  // refresh-coverage-snapshot.sh commits and the seed uploads per flag.
  const combined = libCoverage.createCoverageMap({});
  for (const [ws, map] of byWorkspace) {
    writeReport(`${reportDir}/${ws}`, map, ["lcovonly"]);
    map.files().forEach((f) =>
      combined.addFileCoverage(map.fileCoverageFor(f)),
    );
    const lines = linesSummary(map);
    console.log(
      `[remap] workspace ${ws}: ${map.files().length} plugin(s), lines ` +
        `${lines.covered}/${lines.total} (${lines.pct}%) -> ${reportDir}/${ws}/lcov.info`,
    );
  }
  writeReport(reportDir, combined, ["lcovonly", "text-summary"]);

  const lines = linesSummary(combined);
  console.log(
    `[remap] total: ${byWorkspace.size} workspace(s), lines ${lines.covered}/${lines.total} (${lines.pct}%)`,
  );
})().catch((err) => {
  console.error("[remap] failed:", err?.stack ? err.stack : err);
  process.exit(1);
});
