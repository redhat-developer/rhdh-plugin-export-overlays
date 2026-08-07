/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * Workspace mode: resolve a workspace's published plugins from its
 * `workspaces/<name>/metadata/*.yaml` Package entities (`spec.dynamicArtifact`)
 * and generate the dynamic-plugins.yaml the install CLI consumes.
 *
 * Only `oci://` artifacts are included — some workspaces (e.g.
 * scaffolder-backend-module-kubernetes) declare a local `./dynamic-plugins/dist/…`
 * path instead, meaning the plugin ships inside the RHDH image and has no OCI
 * artifact to pull; those are skipped with a warning.
 *
 * Two optional filters narrow the set (used by the support-level sweep, see
 * src/support.ts): `support` keeps only packages at a given `spec.support` level,
 * and `installExcluded` drops packages a tracked exclusion bars from installing.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { ExclusionRecord } from "./exclusions";
import { compareStrings } from "./util";

type PackageMetadata = {
  metadata?: { name?: unknown };
  spec?: {
    packageName?: unknown;
    dynamicArtifact?: unknown;
    support?: unknown;
    backstage?: { role?: unknown };
  };
};

/** One `kind: Package` entity, flattened to the fields the harness reasons about. */
export type PackageEntry = {
  workspace: string;
  /** Metadata file name, e.g. `backstage-community-plugin-quay.yaml`. */
  file: string;
  /** npm package name from `spec.packageName` — the identifier exclusions match. */
  packageName: string;
  /** `spec.support`: community | generally-available | tech-preview | dev-preview. */
  support: string;
  /** `spec.backstage.role`: frontend-plugin, backend-plugin-module, … */
  role: string;
  /** `spec.dynamicArtifact` — an `oci://` ref, or a local `./dynamic-plugins/…` path. */
  artifact: string;
};

export type WorkspaceRefs = {
  /** oci:// refs to install and validate. */
  refs: string[];
  /** metadata files skipped because their artifact is not an oci:// ref. */
  skipped: string[];
  /** packages dropped by a tracked install-scope exclusion. */
  excluded: ExclusionRecord[];
  /** packages dropped because they sit at a different support level. */
  outOfScope: number;
};

export type CollectRefsOptions = {
  /** Keep only packages whose `spec.support` equals this. Unset keeps all of them. */
  support?: string;
  /** Returns a record when the package is barred from installing, undefined otherwise. */
  installExcluded?: (packageName: string) => ExclusionRecord | undefined;
};

/**
 * The workspace name comes from the CLI / workflow dispatch and is joined into
 * filesystem paths — only accept plain directory names (no separators, and not the
 * dot-only names `.`/`..` that would walk out of workspaces/).
 */
export function isValidWorkspaceName(name: string): boolean {
  return /^(?!\.+$)[A-Za-z0-9._-]+$/.test(name);
}

/** The first argument that is actually a string, or undefined. */
function firstString(...values: unknown[]): string | undefined {
  return values.find((v): v is string => typeof v === "string");
}

/** Read and flatten every `kind: Package` entity under `workspaces/<name>/metadata/`. */
export function readWorkspacePackages(
  repoRoot: string,
  workspace: string,
  // Seam: readdir order is filesystem-dependent (sorted on APFS, hash order on ext4),
  // so a fixture built on disk cannot prove the sort below happens.
  listFiles: (dir: string) => string[] = readdirSync,
): PackageEntry[] {
  // Callers validate too; kept as defense-in-depth since this function is exported.
  if (!isValidWorkspaceName(workspace)) {
    throw new Error(`invalid workspace name: '${workspace}'`);
  }
  const metadataDir = join(repoRoot, "workspaces", workspace, "metadata");
  if (!existsSync(metadataDir)) {
    throw new Error(
      `workspace metadata not found: ${metadataDir} — expected workspaces/${workspace}/metadata/*.yaml`,
    );
  }

  const files = listFiles(metadataDir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    // readdir order is filesystem-dependent; sort so every consumer (ref lists,
    // shard plans, reports) is byte-identical run to run and runner to runner.
    // compareStrings, not the default comparator, for the reason given in src/util.ts.
    .sort(compareStrings);

  return files.map((file) => {
    // Metadata files are repo-controlled; a malformed one deliberately throws and
    // fails the run (unlike discoverPlugins' warn-and-continue for extracted
    // package.json files) — a broken metadata file in a bump PR should fail loud.
    const doc = parse(
      readFileSync(join(metadataDir, file), "utf8"),
    ) as PackageMetadata | null;
    const spec = doc?.spec;
    const artifact = spec?.dynamicArtifact;
    return {
      workspace,
      file,
      // Fall back to the entity name, then the file name, so an exclusion pattern
      // always has something real to match. Both fallbacks are type-checked: metadata
      // is `unknown`, and String()-ing an object would yield the literal
      // "[object Object]" — a name that matches nothing and reads as nonsense.
      packageName: firstString(spec?.packageName, doc?.metadata?.name) ?? file,
      support: typeof spec?.support === "string" ? spec.support : "",
      role:
        typeof spec?.backstage?.role === "string" ? spec.backstage.role : "",
      artifact: typeof artifact === "string" ? artifact : "",
    };
  });
}

/** Collect the oci:// dynamicArtifact refs of every in-scope Package in the workspace. */
export function collectWorkspaceRefs(
  repoRoot: string,
  workspace: string,
  options: CollectRefsOptions = {},
): WorkspaceRefs {
  const packages = readWorkspacePackages(repoRoot, workspace);

  const refs: string[] = [];
  const skipped: string[] = [];
  const excluded: ExclusionRecord[] = [];
  let outOfScope = 0;

  for (const pkg of packages) {
    if (options.support && pkg.support !== options.support) {
      outOfScope += 1;
      continue;
    }
    const exclusion = options.installExcluded?.(pkg.packageName);
    if (exclusion) {
      excluded.push(exclusion);
      console.warn(
        `⚠ ${workspace}/${pkg.file}: '${pkg.packageName}' excluded from install ` +
          `by ${exclusion.patternSource} (${exclusion.ticket})`,
      );
      continue;
    }
    if (pkg.artifact.startsWith("oci://")) {
      refs.push(pkg.artifact);
    } else {
      skipped.push(pkg.file);
      console.warn(
        `⚠ ${workspace}/${pkg.file}: dynamicArtifact is not an oci:// ref ` +
          `(${pkg.artifact || "missing"}) — skipped`,
      );
    }
  }

  if (refs.length === 0) {
    throw new Error(
      emptyRefsMessage(workspace, packages.length, {
        skipped,
        excluded,
        outOfScope,
      }),
    );
  }
  return { refs, skipped, excluded, outOfScope };
}

/**
 * Say WHICH filter emptied the set. "No oci refs" and "the support filter matched
 * nothing" have completely different fixes, and a single generic message sends the
 * reader looking in the wrong place.
 */
function emptyRefsMessage(
  workspace: string,
  metadataCount: number,
  result: Pick<WorkspaceRefs, "skipped" | "excluded" | "outOfScope">,
): string {
  const filters = [
    result.outOfScope
      ? `${result.outOfScope} at another support level`
      : undefined,
    result.excluded.length ? `${result.excluded.length} excluded` : undefined,
  ].filter(Boolean);
  return (
    `workspace '${workspace}' has no oci:// dynamicArtifact refs ` +
    `(${metadataCount} metadata file(s), ${result.skipped.length} skipped` +
    (filters.length ? `, ${filters.join(", ")}` : "") +
    `) — nothing to validate`
  );
}

/**
 * Locate the workspace's Docker-smoke test config files, if any — the same
 * `smoke-tests/app-config.test.yaml` and `smoke-tests/test.env` the Docker smoke
 * mounts into the container (run-workspace-smoke-tests.yaml).
 */
export function discoverSmokeTestConfig(
  repoRoot: string,
  workspace: string,
): { appConfig?: string; testEnv?: string } {
  const dir = join(repoRoot, "workspaces", workspace, "smoke-tests");
  const appConfig = join(dir, "app-config.test.yaml");
  const testEnv = join(dir, "test.env");
  return {
    appConfig: existsSync(appConfig) ? appConfig : undefined,
    testEnv: existsSync(testEnv) ? testEnv : undefined,
  };
}

/** Write the generated dynamic-plugins.yaml and return its path. */
export async function writeDynamicPluginsConfig(
  refs: string[],
  destDir: string,
): Promise<string> {
  const path = join(destDir, "dynamic-plugins.workspace.yaml");
  await writeFile(
    path,
    stringify({ plugins: refs.map((pkg) => ({ package: pkg })) }),
  );
  return path;
}
