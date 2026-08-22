#!/usr/bin/env node
// Find the most recent nightly run in which a given failed test PASSED, within a
// look-back window, and report the surrounding facts: the run-history trail, the
// last-pass build (date + artifact link), the deployment fingerprint diff (RHDH image
// and catalog-index, green vs red), and the branch commits between the two runs.
//
// This is an INFORMATION tool, not a classifier. It does not decide flake vs regression
// vs product bug — the same signal (e.g. identical bits that passed then failed) is
// consistent with several causes. It surfaces the evidence; the analyst classifies.
//
// Reads each build's Playwright results.json (structured status), not log glyphs.
//
// Usage:
//   node --experimental-strip-types last-pass.ts <PROW_OR_GCSWEB_URL> <query...> [--days N]
//
//   <query...>  substrings identifying the test; ALL must appear in
//               "<projectName> <specFile> <specTitle>". Typically the project name
//               plus a slice of the title, e.g.
//                 "rbac-default-permissions" "User should got default permissions"
//   --days N    look-back window (default 7), anchored on the current run's date.

const BUCKET = "test-platform-results";
const GCS = `https://storage.googleapis.com/${BUCKET}`;
const PROW_VIEW = "https://prow.ci.openshift.org/view/gs";

// The CI step's container dir (e.g. "…-ocp-helm") is resolved from the current build's
// artifact layout — not hardcoded — so operator installs and renamed steps still work.
let CONTAINER = "";

type Status = "pass" | "fail" | "flaky" | "skipped" | "absent" | "nolog";
const MAP: Record<string, Status> = { expected: "pass", unexpected: "fail", flaky: "flaky", skipped: "skipped" };

function parseUrl(url: string) {
  const parts = new URL(url.replace(/\/$/, "")).pathname
    .replace(/^\/view\/gs\//, "").replace(/^\/gcs\//, "").split("/");
  const i = parts.indexOf("logs");
  if (i < 0) return null; // only periodic/nightly jobs carry history
  const job = parts[i + 1];
  // Branch and step name are both derived from the job name — no hardcoded values.
  // Job shape: <prefix>-<branch>-<step>, e.g. ...-overlays-release-1.10-e2e-ocp-helm-nightly
  // or ...-overlays-main-e2e-ocp-helm-nightly. branch ∈ {main, release-x.y};
  // subdir (the artifacts step dir) is whatever follows the branch segment.
  const branch = job.match(/-(release-\d+\.\d+)-/)?.[1] ?? "main";
  const subdir = job.split(`-${branch}-`).pop()!;
  return { job, jobId: parts[i + 2], subdir, branch };
}

async function getJson(url: string): Promise<any | null> {
  const res = await fetch(url);
  return res.ok ? res.json() : null;
}

// GCS JSON list API — pass params, get back { prefixes, items, nextPageToken }.
const listObjects = (params: Record<string, string>) =>
  getJson(`https://storage.googleapis.com/storage/v1/b/${BUCKET}/o?${new URLSearchParams(params)}`);

// Leaf name of a GCS prefix, e.g. "logs/job/123/" -> "123".
const leaf = (prefix: string) => prefix.replace(/\/$/, "").split("/").pop()!;

// Under artifacts/<subdir>/ sit one or more step dirs (the test container + gather steps).
// Pick the one that actually holds the Playwright report, so the container name is discovered
// rather than hardcoded — resolved once from the current build and reused for the whole run.
async function resolveContainer(job: string, subdir: string, id: string): Promise<string | null> {
  const listing = await listObjects({ prefix: `logs/${job}/${id}/artifacts/${subdir}/`, delimiter: "/" });
  for (const p of listing?.prefixes ?? []) {
    const probe = await listObjects({ prefix: `${p}artifacts/playwright-report/`, delimiter: "/", maxResults: "1" });
    if (probe?.items?.length || probe?.prefixes?.length) return leaf(p);
  }
  return null;
}

async function listBuilds(job: string): Promise<string[]> {
  const ids: string[] = [];
  let token: string | undefined;
  do {
    const params: Record<string, string> = { prefix: `logs/${job}/`, delimiter: "/", maxResults: "1000" };
    if (token) params.pageToken = token;
    const data = await listObjects(params);
    for (const p of data?.prefixes ?? []) ids.push(leaf(p));
    token = data?.nextPageToken;
  } while (token);
  return ids.filter((b) => /^\d+$/.test(b)).sort((a, b) => (BigInt(a) < BigInt(b) ? 1 : -1));
}

async function startedMs(job: string, id: string): Promise<number | null> {
  const j = await getJson(`${GCS}/logs/${job}/${id}/started.json`);
  return typeof j?.timestamp === "number" ? j.timestamp * 1000 : null;
}

function* walk(suite: any): Generator<{ project: string; hay: string; status: string }> {
  for (const sp of suite.specs ?? [])
    for (const t of sp.tests ?? [])
      yield { project: t.projectName ?? "", hay: `${t.projectName ?? ""} ${sp.file ?? ""} ${sp.title ?? ""}`, status: t.status };
  for (const s of suite.suites ?? []) yield* walk(s);
}

async function testStatus(job: string, subdir: string, id: string, query: string[]): Promise<Status> {
  const url = `${GCS}/logs/${job}/${id}/artifacts/${subdir}/${CONTAINER}/artifacts/playwright-report/results.json`;
  const data = await getJson(url);
  if (!data) return "nolog";
  const matches = [...walk({ suites: data.suites ?? [] })].filter((t) => query.every((q) => t.hay.includes(q)));
  if (!matches.length) return "absent";
  if (matches.some((m) => MAP[m.status] === "fail")) return "fail";
  if (matches.some((m) => MAP[m.status] === "flaky")) return "flaky";
  if (matches.some((m) => MAP[m.status] === "pass")) return "pass";
  return "skipped";
}

async function getText(url: string): Promise<string | null> {
  const res = await fetch(url);
  return res.ok ? res.text() : null;
}

// backstage-backend container image from a `kubectl get deployments -o wide` dump: the
// CONTAINERS and IMAGES columns are comma-separated in the same order → align by index.
function backendImage(deployments: string): string | null {
  for (const line of deployments.split("\n")) {
    const tokens = line.split(/\s+/);
    const names = tokens.find((t) => t.includes("backstage-backend"))?.split(",") ?? [];
    const imgs = tokens.find((t) => /@sha256:/.test(t))?.split(",") ?? [];
    const i = names.indexOf("backstage-backend");
    if (i >= 0 && imgs[i]) return imgs[i];
  }
  return null;
}

type Fp = { image: string | null; catalogIndex: string | null };

// Deployment fingerprint = the "shipped bits" of a build: the RHDH backend image and the
// plugin-catalog-index image. Same across every project in a run, so the first project that
// yields each value wins.
async function fingerprint(job: string, subdir: string, id: string): Promise<Fp> {
  const root = `logs/${job}/${id}/artifacts/${subdir}/${CONTAINER}/artifacts/e2e-test-results/logs`;
  const listing = await listObjects({ prefix: `${root}/`, delimiter: "/" });
  const projects = (listing?.prefixes ?? []).map(leaf);
  let image: string | null = null;
  let catalogIndex: string | null = null;
  for (const proj of projects) {
    if (!image) image = backendImage((await getText(`${GCS}/${root}/${proj}/deployments.txt`)) ?? "");
    if (!catalogIndex)
      catalogIndex = (await getText(`${GCS}/${root}/${proj}/describe-pods.txt`))?.match(/CATALOG_INDEX_IMAGE:\s*(\S+)/)?.[1] ?? null;
    if (image && catalogIndex) break;
  }
  return { image, catalogIndex };
}

const fmtFp = (title: string, fp: Fp) =>
  `${title}:\n  backend image: ${fp.image ?? "?"}\n  catalog index: ${fp.catalogIndex ?? "?"}\n\n`;

// Diff the current (red) build's shipped bits against the last-pass (green) build's.
function diffFp(red: Fp, green: Fp, greenId: string): string {
  if (!green.image && !green.catalogIndex)
    return `Deployment: artifacts unavailable for last-pass build ${greenId} — cannot diff shipped bits.\n\n`;
  const row = (label: string, r: string | null, g: string | null) =>
    r === g
      ? `  ${label}: UNCHANGED (${r ?? "?"})\n`
      : `  ${label}: CHANGED\n    green: ${g ?? "?"}\n    red:   ${r ?? "?"}\n`;
  const changed = red.image !== green.image || red.catalogIndex !== green.catalogIndex;
  return (
    `Deployment diff — last-pass build ${greenId} (green) vs current (red):\n` +
    row("backend image", red.image, green.image) +
    row("catalog index", red.catalogIndex, green.catalogIndex) +
    `  Shipped bits ${changed ? "DIFFER" : "are IDENTICAL"} between green and red.\n\n`
  );
}

const fmt = (ms: number | null) => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z" : "?");
const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : "<date>");

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const di = argv.indexOf("--days");
  const daysArg = di >= 0 ? argv[di + 1] : undefined;
  const days = di >= 0 ? Number(daysArg) : 7;
  if (di >= 0) argv.splice(di, 2);
  const [url, ...query] = argv;

  if (!url || !query.length) {
    process.stderr.write('Usage: last-pass.ts <PROW_URL> <query...> [--days N]\n  e.g. <url> "rbac-default-permissions" "User should got default permissions"\n');
    process.exit(1);
  }
  if (!Number.isFinite(days) || days <= 0) {
    process.stderr.write(`ERROR: --days needs a positive number (got ${JSON.stringify(daysArg)})\n`);
    process.exit(1);
  }
  const ref = parseUrl(url);
  if (!ref) {
    process.stderr.write(`ERROR: Not a periodic/nightly (logs/) URL — history unavailable: ${url}\n`);
    process.exit(1);
  }

  process.stderr.write(`Job:    ${ref.job}\nBranch: ${ref.branch}\nQuery:  ${query.map((q) => `"${q}"`).join(" ")}\n\n`);

  // Discover the artifacts container from the current build before reading any per-build data.
  const resolved = await resolveContainer(ref.job, ref.subdir, ref.jobId);
  if (!resolved) {
    process.stderr.write(
      `ERROR: No test-artifacts container found under\n` +
        `  ${GCS}/logs/${ref.job}/${ref.jobId}/artifacts/${ref.subdir}/\n` +
        `  The CI step name may have changed, or this build has no artifacts. Open the URL above to check.\n`,
    );
    process.exit(1);
  }
  CONTAINER = resolved;

  const currentMs = await startedMs(ref.job, ref.jobId);
  const cutoff = (currentMs ?? Date.now()) - days * 86_400_000;

  const trail: { id: string; ms: number | null; status: Status }[] = [];
  let lastPass: { id: string; ms: number | null } | null = null;

  for (const id of await listBuilds(ref.job)) {
    if (BigInt(id) > BigInt(ref.jobId)) continue; // ignore runs newer than the one under analysis
    const ms = id === ref.jobId ? currentMs : await startedMs(ref.job, id); // reuse already-fetched current build ts
    if (ms !== null && ms < cutoff && id !== ref.jobId) break; // outside window
    const status = await testStatus(ref.job, ref.subdir, id, query);
    trail.push({ id, ms, status });
    if ((status === "pass" || status === "flaky") && id !== ref.jobId) { // green (incl. flaky-passed)
      lastPass = { id, ms };
      break;
    }
  }

  const LABEL: Record<Status, string> = { pass: "PASS  ", fail: "FAIL  ", flaky: "FLAKY ", skipped: "skip  ", absent: "absent", nolog: "no-log" };
  process.stdout.write("Run history (newest first, within window):\n");
  for (const r of trail) process.stdout.write(`  ${LABEL[r.status]}  ${fmt(r.ms)}  ${r.id}${r.id === ref.jobId ? "  <-- current" : ""}\n`);
  process.stdout.write("\n");

  const curFp = await fingerprint(ref.job, ref.subdir, ref.jobId);

  if (!lastPass) {
    process.stdout.write(fmtFp(`Deployment (current build ${ref.jobId})`, curFp));
    process.stdout.write(`RESULT: No PASS or FLAKY build found for this test in the last ${days} days.\n  To dig further: widen with --days 14, or find when the test was added: git log -S '<test title>' upstream/${ref.branch} -- <spec-file>\n`);
    return;
  }

  const gap = currentMs && lastPass.ms ? ` (~${Math.round((currentMs - lastPass.ms) / 3_600_000)}h before the failing run)` : "";
  process.stdout.write(`RESULT: Last passed in build ${lastPass.id} on ${fmt(lastPass.ms)}${gap}\n  Artifacts (prow): ${PROW_VIEW}/${BUCKET}/logs/${ref.job}/${lastPass.id}\n\n`);
  process.stdout.write(diffFp(curFp, await fingerprint(ref.job, ref.subdir, lastPass.id), lastPass.id));
  process.stdout.write(
    `Commits on '${ref.branch}' between the two runs:\n` +
      `  git fetch upstream ${ref.branch}\n` +
      `  git log --oneline --since="${iso(lastPass.ms)}" --until="${iso(currentMs)}" upstream/${ref.branch}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err}\n`);
  process.exit(1);
});
