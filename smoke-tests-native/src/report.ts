/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * The `results.json` contract. Extracted from native-smoke.ts so the sweep and the
 * aggregator read the harness's output through the same types rather than
 * re-describing it.
 */

import type { ExclusionRecord } from "./exclusions";
import type { FrontendSystem, PluginError } from "./loader";

/**
 * Bump when the results.json shape changes — downstream tooling (the sweep
 * aggregator, and the parity runs comparing native vs Docker verdicts) parses this
 * file.
 *
 * 2: added `exclusions` and the support/exclusion fields on `workspace`; additive
 *    only, so a v1 consumer still reads a v2 report correctly.
 */
export const REPORT_SCHEMA_VERSION = 2;

export type Status =
  "pass" | "fail-load" | "fail-start" | "fail-bundle" | "error";

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
  /** `fail` when any workspace did not pass. */
  status: "pass" | "fail";
};
