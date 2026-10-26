/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  pluginPathProblem,
  probeCandidates,
  type ProbeResult,
} from "./catalog-index";
import { isRecord, lastErrorLine } from "./util";

// A manifest fetch is one small request; a registry that has not answered in this long
// is not going to, and the retry in partitionResolvable covers a slow moment. Kept short
// because it multiplies: 2 candidates x 3 attempts per ref during an outage, and the
// job's 60-minute limit cancels the run rather than failing it.
const PROBE_TIMEOUT_MS = 30_000;
const execFileAsync = promisify(execFile);

// Ask the registry for a ref's manifest and run the plugin-path check on it — the two
// things the install CLI does first, and aborts on, for every package. `--raw` fetches
// only the manifest, so ~100 of these cost seconds. Found on PATH exactly as the
// install CLI finds it; there is no bundled copy to point at. Each candidate is tried
// in turn, the way the CLI falls back from the productized registry to quay.
export async function probeRegistry(ref: string): Promise<ProbeResult> {
  const candidates = probeCandidates(ref);
  const errors: string[] = [];
  for (const image of candidates) {
    try {
      const { stdout: manifest } = await execFileAsync(
        "skopeo",
        ["inspect", "--raw", `docker://${image}`],
        { timeout: PROBE_TIMEOUT_MS },
      );
      const problem = pluginPathProblem(ref, manifest);
      return problem
        ? { ok: false, error: problem, retry: false }
        : { ok: true };
    } catch (err) {
      // Name each image only when there were two, and keep both reasons: the primary
      // registry's answer matters as much as the fallback's. With one, the ref already
      // says which image it was.
      const error = probeErrorLine(err);
      errors.push(candidates.length > 1 ? `${image}: ${error}` : error);
    }
  }
  return { ok: false, error: errors.join("; ") };
}

// One skopeo failure as one line of the report entry.
function probeErrorLine(err: unknown): string {
  if (!isRecord(err)) return lastErrorLine(err);
  // No skopeo at all says nothing about any ref. Recorded per ref it would read as
  // every package in the index being broken, so it fails the run as what it is.
  if (err.code === "ENOENT") {
    throw new Error(
      "skopeo not found on PATH: probing catalog index refs needs it, as the install CLI does",
      { cause: err },
    );
  }
  // A kill leaves stderr empty and a message that only echoes the command line.
  if (err.killed) return `no answer within ${PROBE_TIMEOUT_MS / 1000}s`;
  return lastErrorLine(err);
}
