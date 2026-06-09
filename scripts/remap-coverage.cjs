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
//   `webpack://<remote>/...` paths to repo-relative ones (e.g. `src/foo.tsx`),
//   drops node_modules and bundler runtime, and writes lcov for Codecov.
//
// Usage:
//   node scripts/remap-coverage.cjs <nyc-output-json> [report-dir]
//
// Requires istanbul-lib-coverage, istanbul-lib-source-maps, istanbul-lib-report,
// istanbul-reports to be resolvable (installed by report-coverage.sh).

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

// Turn a remapped source identifier into a clean repo-relative path, or null if
// it is not real plugin source (node_modules, webpack/MF runtime, synthetic).
function normalizeSourcePath(file) {
  if (/node_modules/.test(file)) return null;

  // Strip everything up to and including the `webpack:/<remote>/` scheme that
  // istanbul prepends, leaving e.g. `src/foo.tsx` or `tech-radar-common/src/x.ts`.
  const stripped = file.replace(/^.*?webpack:\/+[^/]+\//, "");
  if (stripped === file) return null; // no source-map origin → not real source

  // Drop webpack/module-federation runtime modules and anything that is not a
  // source file (synthetic entries like `==void 0`, css, etc.).
  if (/^(webpack|module_federation)\//.test(stripped)) return null;
  if (!/\.[cm]?[jt]sx?$/.test(stripped)) return null;

  // `../tech-radar-common/src/x.ts` → `tech-radar-common/src/x.ts`
  return stripped.replace(/^(\.\.\/)+/, "");
}

(async () => {
  const raw = JSON.parse(fs.readFileSync(inputJson, "utf8"));
  const store = libSourceMaps.createSourceMapStore();
  const transformed = await store.transformCoverage(
    libCoverage.createCoverageMap(raw),
  );
  const remappedCoverage = transformed.map || transformed;

  // Re-key onto normalized source paths. addFileCoverage merges by location, so
  // the same source covered by both the MF and Scalprum builds combines safely.
  const normalized = libCoverage.createCoverageMap({});
  for (const file of remappedCoverage.files()) {
    const path = normalizeSourcePath(file);
    if (!path) continue;
    const data = structuredClone(remappedCoverage.fileCoverageFor(file).data);
    data.path = path;
    normalized.addFileCoverage(data);
  }

  // Fail loudly (and let report-coverage.sh skip the upload) rather than write an
  // empty lcov: zero source files means the source maps or path normalization
  // broke, and silently uploading nothing is the failure mode this whole pipeline
  // exists to avoid.
  if (normalized.files().length === 0) {
    console.error(
      "[remap] no source files after remap — coverage is empty. " +
        "Check that the bundles were instrumented with --source-map.",
    );
    process.exit(1);
  }

  fs.mkdirSync(reportDir, { recursive: true });
  const context = libReport.createContext({
    dir: reportDir,
    coverageMap: normalized,
  });
  reports.create("lcovonly").execute(context);
  reports.create("text-summary").execute(context);

  const summary = libCoverage.createCoverageSummary();
  normalized.files().forEach((f) =>
    summary.merge(normalized.fileCoverageFor(f).toSummary()),
  );
  const lines = summary.data.lines;
  console.log(
    `[remap] ${normalized.files().length} source file(s), lines ${lines.covered}/${lines.total} (${lines.pct}%)`,
  );
})().catch((err) => {
  console.error("[remap] failed:", err?.stack ? err.stack : err);
  process.exit(1);
});
