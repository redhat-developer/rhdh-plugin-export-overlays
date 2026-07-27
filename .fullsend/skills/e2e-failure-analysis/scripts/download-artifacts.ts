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
  const container = "redhat-developer-rhdh-plugin-export-overlays-ocp-helm";
  const artifactsDir = path.join(cacheDir, container, "artifacts");

  await fs.rm(cacheDir, { recursive: true, force: true });

  const gcsSrc = `${info.gcs}/artifacts/${info.subdir}/${container}`;

  process.stderr.write("Listing objects...\n");
  const allItems = await gcsList(gcsSrc + "/");
  const keep = allItems.filter((i) => INCLUDE_RE.test(i.name) || !EXCLUDE_RE.test(i.name));
  const totalMb = keep.reduce((s, i) => s + parseInt(i.size || "0", 10), 0) / 1024 / 1024;
  process.stderr.write(`Downloading ${keep.length}/${allItems.length} files (${totalMb.toFixed(1)} MB)...\n`);

  const prefixLen = gcsSrc.length + 1;
  const failed = await runPool(keep, (item) => downloadFile(item, prefixLen, cacheDir + "/" + container));

  process.stderr.write(`Done: ${keep.length - failed}/${keep.length} files.\n`);
  await decompressGzipped(cacheDir);

  if (!(await fs.stat(artifactsDir).catch(() => null))) {
    process.stderr.write(`ERROR: Artifacts dir not found: ${artifactsDir}\n`);
    process.exit(1);
  }

  process.stderr.write("Download complete.\n");
  process.stdout.write(artifactsDir + "\n");
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err}\n`);
  process.exit(1);
});
