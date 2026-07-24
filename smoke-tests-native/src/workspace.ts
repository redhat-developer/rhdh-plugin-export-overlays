/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * Workspace mode: resolve ALL of a workspace's published plugins from its
 * `workspaces/<name>/metadata/*.yaml` Package entities (`spec.dynamicArtifact`)
 * and generate the dynamic-plugins.yaml the install CLI consumes.
 *
 * Only `oci://` artifacts are included — some workspaces (e.g.
 * scaffolder-backend-module-kubernetes) declare a local `./dynamic-plugins/dist/…`
 * path instead, meaning the plugin ships inside the RHDH image and has no OCI
 * artifact to pull; those are skipped with a warning.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";

type PackageMetadata = {
  spec?: { dynamicArtifact?: unknown };
};

export type WorkspaceRefs = {
  /** oci:// refs to install and validate. */
  refs: string[];
  /** metadata files skipped because their artifact is not an oci:// ref. */
  skipped: string[];
};

/**
 * The workspace name comes from the CLI / workflow dispatch and is joined into
 * filesystem paths — only accept plain directory names (no separators, and not the
 * dot-only names `.`/`..` that would walk out of workspaces/).
 */
export function isValidWorkspaceName(name: string): boolean {
  return /^(?!\.+$)[A-Za-z0-9._-]+$/.test(name);
}

/** Collect the oci:// dynamicArtifact refs of every Package in the workspace. */
export function collectWorkspaceRefs(
  repoRoot: string,
  workspace: string,
): WorkspaceRefs {
  // parseCliInputs already rejects invalid names; kept as defense-in-depth since
  // this function is exported.
  if (!isValidWorkspaceName(workspace)) {
    throw new Error(`invalid workspace name: '${workspace}'`);
  }
  const metadataDir = join(repoRoot, "workspaces", workspace, "metadata");
  if (!existsSync(metadataDir)) {
    throw new Error(
      `workspace metadata not found: ${metadataDir} — expected workspaces/${workspace}/metadata/*.yaml`,
    );
  }

  const refs: string[] = [];
  const skipped: string[] = [];
  const files = readdirSync(metadataDir).filter(
    (f) => f.endsWith(".yaml") || f.endsWith(".yml"),
  );
  for (const file of files) {
    // Metadata files are repo-controlled; a malformed one deliberately throws and
    // fails the run (unlike discoverPlugins' warn-and-continue for extracted
    // package.json files) — a broken metadata file in a bump PR should fail loud.
    const doc = parse(
      readFileSync(join(metadataDir, file), "utf8"),
    ) as PackageMetadata | null;
    const artifact = doc?.spec?.dynamicArtifact;
    if (typeof artifact === "string" && artifact.startsWith("oci://")) {
      refs.push(artifact);
    } else {
      skipped.push(file);
      console.warn(
        `⚠ ${workspace}/${file}: dynamicArtifact is not an oci:// ref ` +
          `(${typeof artifact === "string" ? artifact : "missing"}) — skipped`,
      );
    }
  }

  if (refs.length === 0) {
    throw new Error(
      `workspace '${workspace}' has no oci:// dynamicArtifact refs ` +
        `(${files.length} metadata file(s), ${skipped.length} skipped) — nothing to validate`,
    );
  }
  return { refs, skipped };
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
  await writeFile(path, stringify({ plugins: refs.map((pkg) => ({ package: pkg })) }));
  return path;
}
