import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { requireEnv } from "@red-hat-developer-hub/e2e-test-utils/utils";

import { GitLabApiHelper } from "../api/gitlab-api-helper.js";
import { GitLabScaffolderApi } from "../api/gitlab-scaffolder-api.js";

export const GITLAB_SCAFFOLDER_PARENT_GROUP = "rhdh-qe-test";

const GITLAB_SCAFFOLDER_RHDH_CONFIG = {
  auth: "guest" as const,
  appConfig: "tests/config/gitlab-scaffolder/app-config-rhdh.yaml",
  secrets: "tests/config/gitlab-scaffolder/rhdh-secrets.yaml",
  dynamicPlugins: "tests/config/gitlab-scaffolder/dynamic-plugins.yaml",
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

export function requireGitLabDiscoveryVaultEnv(): void {
  requireEnv("VAULT_GITLAB_TOKEN_DECODED");
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
  const currentUser = await GitLabScaffolderApi.getCurrentUser();
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

export async function deployGitLabScaffolderHub(
  rhdh: GitLabScaffolderRhdhWorker,
): Promise<void> {
  await rhdh.configure(GITLAB_SCAFFOLDER_RHDH_CONFIG);
  await rhdh.deploy();
}
