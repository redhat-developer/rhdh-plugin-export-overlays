/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * The JSON contracts these tools exchange: the harness's `results.json` and the
 * sweep's per-shard summary. Extracted from native-smoke.ts so the sweep and the
 * aggregator read them through the same types rather than re-describing them, and so
 * the runtime guards that check a file's `schemaVersion` live beside the shape.
 */

import type { ExclusionRecord } from "./exclusions";
import type { FrontendSystem, MfRemoteInfo, PluginError } from "./loader";

/**
 * Bump when the results.json shape changes.
 *
 * isReport/isSweepSummary below require an EXACT match, so every bump is breaking for
 * every consumer even when the shape only grew — update them in the same change. The
 * full consumer list, so the next bump starts from a checklist rather than a guess:
 *
 * - `sweep.ts`, via isReport, on each per-workspace results file.
 * - `aggregate.ts` via isSweepSummary, and `aggregate-report.ts` which reads
 *   `report.frontend.bundles[]`.
 *
 * That is the whole list. `native-smoke.yaml` and `community-plugin-sweep.yaml` move these
 * files around as artifacts but never parse `schemaVersion`, and the sweep's
 * download-artifact has no `run-id`, so a shard artifact is never read across runs — an
 * older schema cannot reach a newer aggregator. Everything else in the repo called
 * `results.json` is Playwright's report, which is unrelated.
 *
 * 2: added `exclusions` and the support/exclusion fields on `workspace`.
 * 3: added `installShortfall` and the `fail-install` status.
 * 4: added `mf` on each frontend bundle (module-federation remote shape).
 * 5: added `mf.nfsFeaturesError`, so a failure to read backstage.features is not
 *    recorded as the artifact declaring none.
 */
export const REPORT_SCHEMA_VERSION = 5;

export type Status =
  | "pass"
  | "fail-load"
  | "fail-start"
  | "fail-bundle"
  /** The install produced fewer plugins than the workspace declared. */
  | "fail-install"
  | "error";

export type BackendStartResult = {
  ok: boolean;
  skipped?: boolean;
  error?: string;
};

/**
 * Which frontend system(s) each bundle ships — the signal for tracking migration to
 * the new frontend system across the catalog.
 */
export type FrontendBundleInfo = {
  name: string;
  version: string;
  systems: FrontendSystem[];
  /**
   * The module-federation remote as the backend's remotes router sees it. Null when
   * the bundle ships no mf-manifest.json. `mf.nfsFeaturesExposed` being empty while
   * `mf.servable` is true is the NFS migration gap — a served remote the new frontend
   * system will not mount anything from.
   */
  mf: MfRemoteInfo | null;
};

/**
 * Workspace-mode provenance: which metadata files were skipped (non-oci artifacts)
 * and how the support filter narrowed the set, so a "pass" can't silently hide that
 * part of the workspace was never validated.
 */
export type WorkspaceInfo = {
  name: string;
  refCount: number;
  skippedMetadata: string[];
  /** The `--support` filter applied, when one was. */
  support?: string;
  /** Packages the filter left out — not a failure, but not validated either. */
  outOfScope?: number;
};

export type Report = {
  schemaVersion: number;
  cliVersion: string;
  workspace?: WorkspaceInfo;
  backend: {
    total: number;
    loaded: number;
    /** Install directory names not loaded into the backend (see `exclusions`). */
    skipped: string[];
    errors: PluginError[];
  };
  backendStart: BackendStartResult;
  frontend: {
    total: number;
    valid: number;
    errors: PluginError[];
    bundles: FrontendBundleInfo[];
  };
  /** Tracked exclusions that fired this run, each with its ticket. */
  exclusions: ExclusionRecord[];
  /** Set when the install laid out fewer plugins than the workspace declared. */
  installShortfall?: string;
  status: Status;
};

/** Bump when the sweep summary shape changes — the aggregator parses these. */
export const SWEEP_SCHEMA_VERSION = 1;

export type SweepWorkspaceResult = {
  workspace: string;
  /** Package count the resolver selected for this workspace at the sweep's support level. */
  packageCount: number;
  /**
   * `skipped` means every in-scope package is barred by an install-scope exclusion,
   * so the harness was never invoked — distinct from a run that failed. Anything else
   * is the harness's own `status`.
   */
  status: Status | "skipped";
  exitCode: number;
  durationMs: number;
  report: Report | null;
  exclusions: ExclusionRecord[];
};

export type SweepSummary = {
  schemaVersion: number;
  support: string;
  shard: { index: number; total: number };
  workspaces: SweepWorkspaceResult[];
  /**
   * `fail` when any workspace did not pass — and also when the shard ran no
   * workspaces at all, which means the plan and the run disagreed.
   */
  status: "pass" | "fail";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrow a parsed report, checking the schema version it declares.
 *
 * These files cross a process boundary (the harness writes, the sweep reads) and a
 * job boundary (a shard writes, the aggregator reads), so asserting the type would
 * let a stale, foreign or older-schema file through as if it were valid — and the
 * consumer would then read `undefined` counts and report them as zeros. The version
 * field exists to be checked; this is what checks it.
 */
export function isReport(value: unknown): value is Report {
  return (
    isRecord(value) &&
    value.schemaVersion === REPORT_SCHEMA_VERSION &&
    isRecord(value.backend) &&
    isRecord(value.frontend) &&
    isRecord(value.backendStart) &&
    typeof value.status === "string"
  );
}

export function isSweepSummary(value: unknown): value is SweepSummary {
  return (
    isRecord(value) &&
    value.schemaVersion === SWEEP_SCHEMA_VERSION &&
    typeof value.support === "string" &&
    isRecord(value.shard) &&
    typeof value.shard.index === "number" &&
    Array.isArray(value.workspaces)
  );
}
