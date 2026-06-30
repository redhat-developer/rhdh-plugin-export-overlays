import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { requireEnv } from "@red-hat-developer-hub/e2e-test-utils/utils";

import { GitLabApiHelper } from "./api/gitlab-api-helper.js";

export const GITLAB_EVENTS_CATALOG_TOKEN = "test-token";
export const GITLAB_SCAFFOLDER_PARENT_GROUP = "rhdh-qe-test";

const GITLAB_EVENTS_RHDH_CONFIG = {
  auth: "keycloak" as const,
  appConfig: "tests/config/gitlab-events/app-config-rhdh.yaml",
  secrets: "tests/config/gitlab-events/rhdh-secrets.yaml",
  dynamicPlugins: "tests/config/gitlab-events/dynamic-plugins.yaml",
  valueFile: "tests/config/gitlab-events/value-file.yaml",
};

const GITLAB_SCAFFOLDER_RHDH_CONFIG = {
  auth: "guest" as const,
  appConfig: "tests/config/gitlab-scaffolder/app-config-rhdh.yaml",
  secrets: "tests/config/gitlab-scaffolder/rhdh-secrets.yaml",
  dynamicPlugins: "tests/config/gitlab-scaffolder/dynamic-plugins.yaml",
};

/** Worker fixture shape used by GitLab events E2E suites */
export type GitLabEventsRhdhWorker = {
  configure: (options: typeof GITLAB_EVENTS_RHDH_CONFIG) => Promise<void>;
  deploy: () => Promise<void>;
  rhdhUrl: string;
};

/** Worker fixture shape used by GitLab scaffolder E2E suite */
export type GitLabScaffolderRhdhWorker = {
  configure: (options: typeof GITLAB_SCAFFOLDER_RHDH_CONFIG) => Promise<void>;
  deploy: () => Promise<void>;
};

export interface GitLabScaffolderSharedState {
  testPrefix: string;
  subgroupId: number;
  subgroupPath: string;
  projectId: number;
  projectName: string;
  repoUrl: string;
  publishCompleted: boolean;
}

export function requireGitLabEventsVaultEnv(): void {
  requireEnv("VAULT_EVENTS_GITLAB_TOKEN");
  requireEnv("VAULT_EVENTS_GITLAB_HOST");
  requireEnv("VAULT_EVENTS_GITLAB_PARENT_ORG");
  requireEnv("VAULT_GITLAB_WEBHOOK_SECRET");
}

export function requireGitLabDiscoveryVaultEnv(): void {
  requireEnv("VAULT_GITLAB_TOKEN_DECODED");
}

/**
 * Validates vault/GitLab env, initializes {@link GitLabApiHelper}, and returns a
 * unique resource prefix for this run.
 */
export function bootstrapGitLabEventsApiClient(): string {
  requireGitLabEventsVaultEnv();
  const host = process.env.VAULT_EVENTS_GITLAB_HOST;
  const token = process.env.VAULT_EVENTS_GITLAB_TOKEN;
  if (typeof host !== "string" || host.length === 0) {
    throw new TypeError("VAULT_EVENTS_GITLAB_HOST must be set");
  }
  if (typeof token !== "string" || token.length === 0) {
    throw new TypeError("VAULT_EVENTS_GITLAB_TOKEN must be set");
  }
  GitLabApiHelper.init(`https://${host}`, token);
  return GitLabApiHelper.generateTestPrefix();
}

/**
 * Initializes {@link GitLabApiHelper} with gitlab.com credentials used by
 * gitlab-discovery and gitlab-scaffolder suites.
 */
export function bootstrapGitLabDiscoveryApiClient(): string {
  requireGitLabDiscoveryVaultEnv();
  GitLabApiHelper.init(
    "https://gitlab.com",
    process.env.VAULT_GITLAB_TOKEN_DECODED!,
  );
  return GitLabApiHelper.generateTestPrefix();
}

export function isGitLabScaffolderCleanupEnabled(): boolean {
  const { GITLAB_SCAFFOLDER_CLEANUP: cleanup, CI } = process.env;
  return cleanup !== "false" && (cleanup === "true" || CI === "true");
}

/**
 * Validates vault/GitLab env, initializes {@link GitLabApiHelper}, and verifies
 * the token can access the scaffolder parent group before RHDH deploy.
 */
export async function bootstrapGitLabScaffolderPreflight(): Promise<void> {
  bootstrapGitLabDiscoveryApiClient();
  const currentUser = await GitLabApiHelper.getCurrentUser();
  console.log(
    `GitLab scaffolder preflight: authenticated as ${currentUser.username} (id=${currentUser.id})`,
  );
  const parentGroup = await GitLabApiHelper.getGroupByPath(
    GITLAB_SCAFFOLDER_PARENT_GROUP,
  );
  console.log(
    `GitLab scaffolder preflight: parent group "${parentGroup.full_path}" accessible (id=${parentGroup.id})`,
  );
}

export function buildGitLabScaffolderNames(testPrefix: string): {
  subgroupSlug: string;
  subgroupPath: string;
  projectName: string;
  repoUrl: string;
} {
  const subgroupSlug = `${testPrefix}-subgroup`;
  const subgroupPath = `${GITLAB_SCAFFOLDER_PARENT_GROUP}/${subgroupSlug}`;
  const projectName = `${testPrefix}-app`;
  const repoUrl = `gitlab.com?repo=${projectName}&owner=${encodeURIComponent(subgroupPath)}`;

  return { subgroupSlug, subgroupPath, projectName, repoUrl };
}

function getScaffolderStateFilePath(playwrightProjectName: string): string {
  const safeName = playwrightProjectName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(os.tmpdir(), `backstage-gitlab-scaffolder-${safeName}.json`);
}

export function readGitLabScaffolderSharedState(
  playwrightProjectName: string,
): GitLabScaffolderSharedState | undefined {
  const stateFile = getScaffolderStateFilePath(playwrightProjectName);
  if (!fs.existsSync(stateFile)) {
    return undefined;
  }

  const raw = fs.readFileSync(stateFile, "utf8");
  return JSON.parse(raw) as GitLabScaffolderSharedState;
}

export function writeGitLabScaffolderSharedState(
  playwrightProjectName: string,
  state: GitLabScaffolderSharedState,
): void {
  const stateFile = getScaffolderStateFilePath(playwrightProjectName);
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
}

export function initOrRestoreGitLabScaffolderSharedState(
  playwrightProjectName: string,
): GitLabScaffolderSharedState {
  const existing = readGitLabScaffolderSharedState(playwrightProjectName);
  if (existing) {
    return existing;
  }

  return {
    testPrefix: "",
    subgroupId: 0,
    subgroupPath: "",
    projectId: 0,
    projectName: "",
    repoUrl: "",
    publishCompleted: false,
  };
}

export function requireGitLabScaffolderSharedState(
  playwrightProjectName: string,
): GitLabScaffolderSharedState {
  const state = readGitLabScaffolderSharedState(playwrightProjectName);
  if (!state?.publishCompleted || !state.projectId) {
    throw new Error(
      "GitLab scaffolder shared state is missing or publish test did not complete",
    );
  }
  return state;
}

export function deleteGitLabScaffolderSharedState(
  playwrightProjectName: string,
): void {
  const stateFile = getScaffolderStateFilePath(playwrightProjectName);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

export async function deployGitLabEventsHub(
  rhdh: GitLabEventsRhdhWorker,
): Promise<{ rhdhUrl: string; catalogToken: string }> {
  await rhdh.configure(GITLAB_EVENTS_RHDH_CONFIG);
  await rhdh.deploy();
  return { rhdhUrl: rhdh.rhdhUrl, catalogToken: GITLAB_EVENTS_CATALOG_TOKEN };
}

export async function deployGitLabScaffolderHub(
  rhdh: GitLabScaffolderRhdhWorker,
): Promise<void> {
  await rhdh.configure(GITLAB_SCAFFOLDER_RHDH_CONFIG);
  await rhdh.deploy();
}

export async function prepareGitLabParentGroup(
  parentGroupPath: string | undefined,
): Promise<{
  parentGroupId: number;
  parentGroupPath: string;
}> {
  const parentGroup = await GitLabApiHelper.getGroupByPath(parentGroupPath);
  await GitLabApiHelper.cleanupStaleResources(parentGroup.id, "e2e-", 1);
  return {
    parentGroupId: parentGroup.id,
    parentGroupPath: parentGroup.full_path,
  };
}

export async function prepareGitLabEventsParentGroup(): Promise<{
  parentGroupId: number;
  parentGroupPath: string;
}> {
  return prepareGitLabParentGroup(process.env.VAULT_EVENTS_GITLAB_PARENT_ORG);
}

export async function runGitLabCleanupSafely(
  cleanup: () => Promise<void>,
): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    console.warn(
      `Cleanup error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** @deprecated Use {@link runGitLabCleanupSafely} */
export const runGitLabEventsCleanupSafely = runGitLabCleanupSafely;
