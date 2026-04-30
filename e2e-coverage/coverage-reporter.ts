/**
 * Playwright custom reporter that merges Istanbul coverage files
 * and converts to lcov format for Codecov upload.
 *
 * Usage in playwright.config.ts:
 *   reporter: [['list'], ['../e2e-coverage/coverage-reporter.ts']],
 *
 * Requires: E2E_COLLECT_COVERAGE=1
 */

import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import * as fs from "fs";
import * as path from "path";

const COVERAGE_DIR = path.resolve(
  process.cwd(),
  process.env.COVERAGE_OUTPUT_DIR || "coverage/istanbul",
);
const COLLECT_COVERAGE = process.env.E2E_COLLECT_COVERAGE === "1";

interface CoverageData {
  [filePath: string]: {
    path: string;
    statementMap: Record<string, { start: { line: number; column: number }; end: { line: number; column: number } }>;
    fnMap: Record<string, { name: string; decl: { start: { line: number; column: number }; end: { line: number; column: number } }; loc: { start: { line: number; column: number }; end: { line: number; column: number } } }>;
    branchMap: Record<string, { loc: { start: { line: number; column: number }; end: { line: number; column: number } }; type: string; locations: Array<{ start: { line: number; column: number }; end: { line: number; column: number } }> }>;
    s: Record<string, number>;
    f: Record<string, number>;
    b: Record<string, number[]>;
  };
}

function mergeCoverage(
  target: CoverageData,
  source: CoverageData,
): CoverageData {
  for (const [filePath, fileCov] of Object.entries(source)) {
    if (!target[filePath]) {
      target[filePath] = fileCov;
      continue;
    }

    const existing = target[filePath];

    for (const [key, count] of Object.entries(fileCov.s)) {
      existing.s[key] = (existing.s[key] || 0) + count;
    }

    for (const [key, count] of Object.entries(fileCov.f)) {
      existing.f[key] = (existing.f[key] || 0) + count;
    }

    for (const [key, counts] of Object.entries(fileCov.b)) {
      if (!existing.b[key]) {
        existing.b[key] = counts;
      } else {
        existing.b[key] = existing.b[key].map(
          (v: number, i: number) => v + (counts[i] || 0),
        );
      }
    }
  }

  return target;
}

/**
 * Convert Istanbul coverage JSON to lcov format.
 * This is a standalone implementation to avoid requiring istanbul-reports
 * as a dependency (keeping the overlay repo lightweight).
 */
function coverageToLcov(coverage: CoverageData): string {
  const lines: string[] = [];

  for (const [filePath, fileCov] of Object.entries(coverage)) {
    lines.push("TN:");
    lines.push(`SF:${fileCov.path || filePath}`);

    for (const [, fnData] of Object.entries(fileCov.fnMap)) {
      lines.push(
        `FN:${fnData.decl.start.line},${fnData.name || "(anonymous)"}`,
      );
    }

    for (const [key, fnData] of Object.entries(fileCov.fnMap)) {
      lines.push(
        `FNDA:${fileCov.f[key] || 0},${fnData.name || "(anonymous)"}`,
      );
    }

    lines.push(`FNF:${Object.keys(fileCov.fnMap).length}`);
    lines.push(
      `FNH:${Object.values(fileCov.f).filter((v) => v > 0).length}`,
    );

    const lineCounts: Record<number, number> = {};
    for (const [key, stmtData] of Object.entries(fileCov.statementMap)) {
      const line = stmtData.start.line;
      const count = fileCov.s[key] || 0;
      lineCounts[line] = (lineCounts[line] || 0) + count;
    }

    for (const [line, count] of Object.entries(lineCounts)) {
      lines.push(`DA:${line},${count}`);
    }

    const totalLines = Object.keys(lineCounts).length;
    const hitLines = Object.values(lineCounts).filter((v) => v > 0).length;
    lines.push(`LF:${totalLines}`);
    lines.push(`LH:${hitLines}`);

    let branchIdx = 0;
    for (const [key, branchData] of Object.entries(fileCov.branchMap)) {
      const counts = fileCov.b[key] || [];
      for (let i = 0; i < counts.length; i++) {
        lines.push(
          `BRDA:${branchData.loc.start.line},${branchIdx},${i},${counts[i]}`,
        );
      }
      branchIdx++;
    }

    const totalBranches = Object.values(fileCov.b).reduce(
      (sum, counts) => sum + counts.length,
      0,
    );
    const hitBranches = Object.values(fileCov.b).reduce(
      (sum, counts) => sum + counts.filter((v) => v > 0).length,
      0,
    );
    lines.push(`BRF:${totalBranches}`);
    lines.push(`BRH:${hitBranches}`);

    lines.push("end_of_record");
  }

  return lines.join("\n");
}

class CoverageReporter implements Reporter {
  onBegin(_config: FullConfig, _suite: Suite) {
    if (COLLECT_COVERAGE) {
      console.log("\n[coverage-reporter] Coverage collection enabled");
      fs.mkdirSync(COVERAGE_DIR, { recursive: true });
    }
  }

  onTestEnd(_test: TestCase, _result: TestResult) {}

  onEnd(_result: FullResult) {
    if (!COLLECT_COVERAGE) return;

    if (!fs.existsSync(COVERAGE_DIR)) {
      console.log("[coverage-reporter] No coverage directory found");
      return;
    }

    const files = fs
      .readdirSync(COVERAGE_DIR)
      .filter((f) => f.endsWith(".json") && f !== "coverage-final.json");

    if (files.length === 0) {
      console.log("[coverage-reporter] No coverage files found");
      return;
    }

    let merged: CoverageData = {};
    for (const file of files) {
      const data = JSON.parse(
        fs.readFileSync(path.join(COVERAGE_DIR, file), "utf-8"),
      ) as CoverageData;
      merged = mergeCoverage(merged, data);
    }

    const finalFile = path.join(COVERAGE_DIR, "coverage-final.json");
    fs.writeFileSync(finalFile, JSON.stringify(merged, null, 2));

    const lcov = coverageToLcov(merged);
    const lcovFile = path.join(COVERAGE_DIR, "lcov.info");
    fs.writeFileSync(lcovFile, lcov);

    const fileCount = Object.keys(merged).length;
    const totalStatements = Object.values(merged).reduce(
      (sum, f) => sum + Object.keys(f.s).length,
      0,
    );
    const hitStatements = Object.values(merged).reduce(
      (sum, f) => sum + Object.values(f.s).filter((v) => v > 0).length,
      0,
    );
    const pct =
      totalStatements > 0
        ? ((hitStatements / totalStatements) * 100).toFixed(1)
        : "0.0";

    console.log("\n=== E2E Coverage Summary ===");
    console.log(`  Files:      ${fileCount}`);
    console.log(`  Statements: ${hitStatements}/${totalStatements} (${pct}%)`);
    console.log(`  Istanbul:   ${finalFile}`);
    console.log(`  LCOV:       ${lcovFile}`);
    console.log("============================\n");
  }
}

export default CoverageReporter;
