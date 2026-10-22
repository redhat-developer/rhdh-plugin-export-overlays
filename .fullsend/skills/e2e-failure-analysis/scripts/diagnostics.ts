#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";

interface Spec {
  title: string;
  tests?: Test[];
}

interface Test {
  projectName?: string;
  results?: TestResult[];
}

interface TestResult {
  status: string;
  error?: { message?: string };
  stdout?: Array<{ text?: string }>;
}

interface Suite {
  specs?: Spec[];
  suites?: Suite[];
}

interface ResultsJSON {
  stats?: {
    expected?: number;
    unexpected?: number;
    skipped?: number;
    flaky?: number;
  };
  suites?: Suite[];
}

function walkSuites(suite: Suite, specs: Spec[] = []): Spec[] {
  for (const spec of suite.specs || []) {
    specs.push(spec);
  }
  for (const child of suite.suites || []) {
    walkSuites(child, specs);
  }
  return specs;
}

const WARNING_PATTERNS = new RegExp(
  "YAML file.*does not exist|" +
  "error|Error|ERROR|" +
  "WARN|warn|Warning|" +
  "does not exist|not found|" +
  "missing|Missing|" +
  "failed|Failed|FAILED|" +
  "CrashLoopBackOff|ImagePullBackOff|" +
  "secret.*not|Secret.*not",
  "i",
);
const NOISE = /node_modules|trace_id|Download|Extracting|integrity checksum/;

function main(): void {
  if (process.argv.length < 3) {
    process.stderr.write(`Usage: ${process.argv[1]} <ARTIFACTS_DIR> [--project <name>]\n`);
    process.exit(1);
  }

  const artifacts = process.argv[2];
  let projectFilter: string | null = null;
  const projIdx = process.argv.indexOf("--project");
  if (projIdx !== -1 && projIdx + 1 < process.argv.length) {
    projectFilter = process.argv[projIdx + 1].toLowerCase();
  }

  const resultsFile = path.join(artifacts, "playwright-report", "results.json");
  if (!fs.existsSync(resultsFile)) {
    process.stderr.write(`ERROR: ${resultsFile} not found\n`);
    process.exit(1);
  }

  const r: ResultsJSON = JSON.parse(fs.readFileSync(resultsFile, "utf-8"));
  const stats = r.stats || {};
  const allSpecs: Spec[] = [];
  for (const s of r.suites || []) {
    walkSuites(s, allSpecs);
  }

  // Section 1: Test Results
  console.log("=".repeat(70));
  console.log("TEST RESULTS");
  console.log("=".repeat(70));
  console.log(
    `Passed: ${stats.expected || 0}  ` +
    `Failed: ${stats.unexpected || 0}  ` +
    `Skipped: ${stats.skipped || 0}  ` +
    `Flaky: ${stats.flaky || 0}`,
  );
  console.log();

  const failedProjects = new Set<string>();
  for (const spec of allSpecs) {
    for (const test of spec.tests || []) {
      const proj = test.projectName || "?";
      if (projectFilter && !proj.toLowerCase().includes(projectFilter)) {
        continue;
      }
      for (const result of test.results || []) {
        const status = result.status;
        if (status !== "passed" && status !== "skipped") {
          failedProjects.add(proj);
          const err = result.error?.message || "no error";
          console.log(`FAILED [${proj}] ${spec.title}`);
          console.log(`  ${err.slice(0, 400)}`);
          console.log();
        } else if (projectFilter) {
          console.log(`${status.toUpperCase()} [${proj}] ${spec.title}`);
        }
      }
    }
  }

  // Section 2: Diagnostics per failed project
  for (const proj of [...failedProjects].sort()) {
    console.log("=".repeat(70));
    console.log(`DIAGNOSTICS FOR PROJECT: ${proj}`);
    console.log("=".repeat(70));
    for (const spec of allSpecs) {
      for (const test of spec.tests || []) {
        if (test.projectName !== proj) continue;
        for (const result of test.results || []) {
          const stdout = (result.stdout || []).map((s) => s.text || "").join("");
          if (!stdout) continue;

          const title = spec.title.slice(0, 50);

          // Config tables
          const tableRe =
            /(┌─[^\n]*(?:Config|Plugins|Deployment|Value|Backstage)[^\n]*\n)(.*?)(└─+)/gs;
          let match;
          while ((match = tableRe.exec(stdout)) !== null) {
            const header = match[1].trim();
            const body = match[2];
            if (body.length < 5000) {
              console.log(`--- ${header} [${title}] ---`);
              console.log(body.trimEnd());
              console.log();
            }
          }

          // Warnings and errors
          const warnings: string[] = [];
          for (const line of stdout.split("\n")) {
            if (WARNING_PATTERNS.test(line) && !NOISE.test(line)) {
              warnings.push(line.trimEnd());
            }
          }
          if (warnings.length > 0) {
            console.log(`--- Warnings/Errors [${title}] ---`);
            for (const w of warnings.slice(-40)) {
              console.log(w);
            }
            console.log();
          }
        }
      }
    }
  }
}

main();
