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

    for (const [key, count] of Object.entries(fileCov.s)) {
      existing.s[key] = (existing.s[key] || 0) + count;
    }

    for (const [key, count] of Object.entries(fileCov.f)) {
      existing.f[key] = (existing.f[key] || 0) + count;
    }

    for (const [key, counts] of Object.entries(fileCov.b)) {
      if (existing.b[key]) {
        existing.b[key] = existing.b[key].map(
          (v: number, i: number) => v + (counts[i] || 0),
        );
      } else {
        existing.b[key] = counts;
      }
    }
  }

  return target;
}
