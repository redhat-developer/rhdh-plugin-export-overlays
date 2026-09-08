#!/usr/bin/env node
import * as fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const BUCKET = "test-platform-results";
const API_URL = `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o`;
const DL_URL = `https://storage.googleapis.com/${BUCKET}`;
const MAX_CONCURRENCY = 8;

const EXCLUDE_RE = /\.webm$|\/playwright-report\/data\/|\/playwright-report\/trace\//;
const INCLUDE_RE = /\/e2e-test-results\/.*\/trace\.zip$/;

interface GCSItem {
  name: string;
  size?: string;
}

interface ParsedURL {
  type: string;
  pr?: string;
  job_id: string;
  subdir: string;
  gcs: string;
}

function parseUrl(url: string): ParsedURL | null {
  const p = new URL(url.replace(/\/$/, "")).pathname
    .replace(/^\/view\/gs\//, "")
    .replace(/^\/gcs\//, "");
  const parts = p.split("/");

  if (parts.includes("pr-logs")) {
    const i = parts.indexOf("pull") + 1;
    const [pr, job, jid] = [parts[i + 1], parts[i + 2], parts[i + 3]];
    const sub = job.includes("-main-") ? job.split("-main-").pop()! : "e2e-ocp-helm";
    return {
      type: "pr", pr, job_id: jid, subdir: sub,
      gcs: `pr-logs/pull/redhat-developer_rhdh-plugin-export-overlays/${pr}/${job}/${jid}`,
    };
  }

  if (parts.includes("logs")) {
    const i = parts.indexOf("logs");
    const [job, jid] = [parts[i + 1], parts[i + 2]];
    const sub = job.includes("-main-") ? job.split("-main-").pop()! : "e2e-ocp-helm-nightly";
    return {
      type: "nightly", job_id: jid, subdir: sub,
      gcs: `logs/${job}/${jid}`,
    };
  }

  return null;
}

async function gcsList(prefix: string): Promise<GCSItem[]> {
  const items: GCSItem[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ prefix, maxResults: "1000" });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(`${API_URL}?${params}`);
    if (!res.ok) throw new Error(`GCS list failed: ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (data.items) items.push(...data.items);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return items;
}

// Single delimited listing → the immediate child "dirs" (prefixes) and files (items).
async function gcsChildren(prefix: string): Promise<{ prefixes: string[]; items: GCSItem[] }> {
  const params = new URLSearchParams({ prefix, delimiter: "/", maxResults: "1000" });
  const res = await fetch(`${API_URL}?${params}`);
  if (!res.ok) throw new Error(`GCS list failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return { prefixes: data.prefixes ?? [], items: data.items ?? [] };
}

// The step-container dir under artifacts/<subdir>/ isn't fixed — it differs for operator
// vs helm installs and renamed CI steps — so probe for the child that actually holds the
// Playwright report instead of hardcoding the name.
async function resolveContainer(baseGcs: string, subdir: string): Promise<string | null> {
  const { prefixes } = await gcsChildren(`${baseGcs}/artifacts/${subdir}/`);
  for (const p of prefixes) {
    const probe = await gcsChildren(`${p}artifacts/playwright-report/`);
    if (probe.items.length || probe.prefixes.length) return p.replace(/\/$/, "").split("/").pop()!;
  }
  return null;
}

async function downloadFile(item: GCSItem, prefixLen: number, dest: string): Promise<void> {
  const local = path.join(dest, item.name.slice(prefixLen));
  await fs.mkdir(path.dirname(local), { recursive: true });
  const res = await fetch(`${DL_URL}/${encodeURIComponent(item.name).replace(/%2F/g, "/")}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(local));
}

async function runPool(items: GCSItem[], fn: (item: GCSItem) => Promise<void>): Promise<number> {
  let failed = 0;
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < items.length) {
      const item = items[idx++];
      try {
        await fn(item);
      } catch (e) {
        failed++;
        process.stderr.write(`  FAILED: ${item.name.split("/").pop()}: ${e}\n`);
      }
    }
  }

  await Promise.all(Array.from({ length: MAX_CONCURRENCY }, worker));
  return failed;
}

async function decompressGzipped(dir: string): Promise<void> {
  const skipExts = new Set([".zip", ".gz", ".png", ".webm"]);
  const gzipMagic = Buffer.from([0x1f, 0x8b]);

  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
  await Promise.all(
    entries
      .filter((e) => e.isFile() && !skipExts.has(path.extname(e.name)))
      .map(async (e) => {
        const full = path.join(e.parentPath || e.path, e.name);
        const fd = await fs.open(full, "r");
        const header = Buffer.alloc(2);
        const { bytesRead } = await fd.read(header, 0, 2, 0);
        await fd.close();
        if (bytesRead < 2 || !header.subarray(0, 2).equals(gzipMagic)) return;
        const decompressed = gunzipSync(await fs.readFile(full));
        await fs.writeFile(full, decompressed);
      }),
  );
}

async function main(): Promise<void> {
  if (process.argv.length < 3) {
    process.stderr.write("Usage: node download-artifacts.ts <PROW_URL>\n");
    process.exit(1);
  }

  const info = parseUrl(process.argv[2]);
  if (!info) {
    process.stderr.write(`ERROR: Could not parse URL: ${process.argv[2]}\n`);
    process.exit(1);
  }

  const base = path.join("node_modules", ".cache", "e2e-artifacts");
  const cacheDir = path.join(base, info.pr || "nightly", info.job_id);
  const marker = path.join(cacheDir, ".download-complete");
  // The marker records the resolved container dir name, so a cache hit can rebuild the
  // artifacts path without a network round-trip. Empty/absent → treat as a cache miss.
  const readMarker = () => fs.readFile(marker, "utf8").then((s) => s.trim() || null).catch(() => null);

  // Cache hit — artifacts for a build ID are immutable, so a completed download is reusable.
  const cachedContainer = await readMarker();
  if (cachedContainer) {
    process.stderr.write("Cache hit — artifacts already downloaded.\n");
    process.stdout.write(path.join(cacheDir, cachedContainer, "artifacts") + "\n");
    return;
  }

  // Resolve the step-container dir from the build's own layout (helm vs operator, renamed
  // steps) rather than assuming a fixed name.
  const container = await resolveContainer(info.gcs, info.subdir);
  if (!container) {
    process.stderr.write(
      `ERROR: No test-artifacts container found under\n` +
        `  ${DL_URL}/${info.gcs}/artifacts/${info.subdir}/\n` +
        `  The CI step name may have changed, or this build has no artifacts.\n`,
    );
    process.exit(1);
  }
  const artifactsDir = path.join(cacheDir, container, "artifacts");

  // Download into a private staging dir, then publish it with a single atomic rename.
  // Concurrent runs for the same build each stage their own copy; the first to finish
  // publishes it and the rest reuse it — so a reader never sees a half-written cache dir,
  // and no run clears files another is reading.
  const stageDir = `${cacheDir}.tmp.${process.pid}`;
  const stagedArtifacts = path.join(stageDir, container, "artifacts");
  await fs.rm(stageDir, { recursive: true, force: true });

  const gcsSrc = `${info.gcs}/artifacts/${info.subdir}/${container}`;

  process.stderr.write("Listing objects...\n");
  const allItems = await gcsList(gcsSrc + "/");
  const keep = allItems.filter((i) => INCLUDE_RE.test(i.name) || !EXCLUDE_RE.test(i.name));
  const totalMb = keep.reduce((s, i) => s + parseInt(i.size || "0", 10), 0) / 1024 / 1024;
  process.stderr.write(`Downloading ${keep.length}/${allItems.length} files (${totalMb.toFixed(1)} MB)...\n`);

  const prefixLen = gcsSrc.length + 1;
  const failed = await runPool(keep, (item) => downloadFile(item, prefixLen, path.join(stageDir, container)));

  process.stderr.write(`Done: ${keep.length - failed}/${keep.length} files.\n`);
  await decompressGzipped(stageDir);

  if (!(await fs.stat(stagedArtifacts).catch(() => null))) {
    process.stderr.write(`ERROR: Artifacts dir not found: ${stagedArtifacts}\n`);
    process.exit(1);
  }

  // A partial download must not enter the shared cache — use it for this run only.
  if (failed > 0) {
    process.stderr.write(`WARNING: ${failed} file(s) failed — not caching this download.\n`);
    process.stdout.write(stagedArtifacts + "\n");
    return;
  }

  await fs.writeFile(path.join(stageDir, ".download-complete"), container + "\n");

  // Publish atomically. rename throws ENOTEMPTY/EEXIST when cacheDir already exists.
  try {
    await fs.rename(stageDir, cacheDir);
  } catch (e: any) {
    if (e.code !== "ENOTEMPTY" && e.code !== "EEXIST") {
      await fs.rm(stageDir, { recursive: true, force: true });
      throw e;
    }
    if (await readMarker()) {
      // A concurrent run already published a complete copy — reuse it, drop ours.
      await fs.rm(stageDir, { recursive: true, force: true });
    } else {
      // cacheDir exists but has no valid marker → stale leftover from an interrupted or
      // older run (current code only creates cacheDir via this rename, marker included).
      // Replace it with our complete copy; tolerate another run publishing in the gap.
      await fs.rm(cacheDir, { recursive: true, force: true });
      await fs.rename(stageDir, cacheDir).catch(async (e2: any) => {
        await fs.rm(stageDir, { recursive: true, force: true });
        if (e2.code !== "ENOTEMPTY" && e2.code !== "EEXIST") throw e2;
      });
    }
  }

  process.stderr.write("Download complete.\n");
  process.stdout.write(artifactsDir + "\n");
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err}\n`);
  process.exit(1);
});
