import * as path from "node:path";

export const COVERAGE_DIR = path.resolve(
  process.cwd(),
  process.env.COVERAGE_OUTPUT_DIR || "coverage/istanbul",
);
export const COLLECT_COVERAGE = process.env.E2E_COLLECT_COVERAGE === "1";

export interface SourceLocation {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

export interface FileCoverage {
  path: string;
  statementMap: Record<string, SourceLocation>;
  fnMap: Record<string, { name: string; decl: SourceLocation; loc: SourceLocation }>;
  branchMap: Record<string, { loc: SourceLocation; type: string; locations: SourceLocation[] }>;
  s: Record<string, number>;
  f: Record<string, number>;
  b: Record<string, number[]>;
}

export interface CoverageData {
  [filePath: string]: FileCoverage;
}

function addCounts(
  target: Record<string, number>,
  source: Record<string, number>,
) {
  for (const [key, count] of Object.entries(source)) {
    target[key] = (target[key] || 0) + count;
  }
}

export function mergeCoverage(
  target: CoverageData,
  source: CoverageData,
): CoverageData {
  for (const [filePath, fileCov] of Object.entries(source)) {
    if (!target[filePath]) {
      target[filePath] = fileCov;
      continue;
    }

    const existing = target[filePath];
    addCounts(existing.s, fileCov.s);
    addCounts(existing.f, fileCov.f);

    for (const [key, counts] of Object.entries(fileCov.b)) {
      existing.b[key] =
        existing.b[key]?.map((v: number, i: number) => v + (counts[i] ?? 0)) ??
        counts;
    }
  }

  return target;
}
