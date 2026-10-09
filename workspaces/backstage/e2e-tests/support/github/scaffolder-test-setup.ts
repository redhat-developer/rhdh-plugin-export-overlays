import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { requireEnv } from "@red-hat-developer-hub/e2e-test-utils/utils";
import { DeploymentOptions } from "@red-hat-developer-hub/e2e-test-utils/rhdh";

import { GitHubScaffolderApi } from "../api/github-scaffolder-api.js";

export const GITHUB_SCAFFOLDER_TEST_ORG = "janus-qe";

const GITHUB_SCAFFOLDER_RHDH_CONFIG: DeploymentOptions = {
  auth: "guest" as const,
  appConfig: "tests/config/github-scaffolder/app-config-rhdh.yaml",
  secrets: "tests/config/github-scaffolder/rhdh-secrets.yaml",
  dynamicPlugins: "tests/config/github-scaffolder/dynamic-plugins.yaml",
};

/** Worker fixture shape used by GitHub scaffolder E2E suite */
export type GitHubScaffolderRhdhWorker = {
  configure: (options: typeof GITHUB_SCAFFOLDER_RHDH_CONFIG) => Promise<void>;
  deploy: () => Promise<void>;
};

export interface GitHubScaffolderSharedState {
  testPrefix: string;
  repoName: string;
  repoFullName: string;
  repoUrl: string;
  publishCompleted: boolean;
}

/**
 * Verifies that the GitHub token env var is set and that the test org template
 * repository is accessible before RHDH deploy.
 */
export async function bootstrapGitHubScaffolderPreflight(): Promise<void> {
  requireEnv("VAULT_GH_RHDH_QE_USER_TOKEN");
  // APIHelper.githubRequest (e2e-test-utils) always reads VAULT_GITHUB_USER_TOKEN.
  process.env.VAULT_GITHUB_USER_TOKEN = process.env.VAULT_GH_RHDH_QE_USER_TOKEN;
  const testRepo = await GitHubScaffolderApi.getRepository(
    GITHUB_SCAFFOLDER_TEST_ORG,
    "overlay-scaffolder-backend-module-github-test",
  );
  console.log(
    `GitHub scaffolder preflight: authenticated, template repo accessible (${testRepo.full_name})`,
  );
}

export function isGitHubScaffolderCleanupEnabled(): boolean {
  const { GITHUB_SCAFFOLDER_CLEANUP: cleanup, CI } = process.env;
  return cleanup !== "false" && (cleanup === "true" || CI === "true");
}

export function buildGitHubScaffolderNames(testPrefix: string): {
  repoName: string;
  repoFullName: string;
  repoUrl: string;
} {
  const repoName = `${testPrefix}-app`;
  const repoFullName = `${GITHUB_SCAFFOLDER_TEST_ORG}/${repoName}`;
  const repoUrl = `github.com?repo=${repoName}&owner=${GITHUB_SCAFFOLDER_TEST_ORG}`;

  return { repoName, repoFullName, repoUrl };
}

function getScaffolderStateFilePath(playwrightProjectName: string): string {
  const safeName = playwrightProjectName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(os.tmpdir(), `backstage-github-scaffolder-${safeName}.json`);
}

export function readGitHubScaffolderSharedState(
  playwrightProjectName: string,
): GitHubScaffolderSharedState | undefined {
  const stateFile = getScaffolderStateFilePath(playwrightProjectName);
  if (!fs.existsSync(stateFile)) {
    return undefined;
  }

  const raw = fs.readFileSync(stateFile, "utf8");
  return JSON.parse(raw) as GitHubScaffolderSharedState;
}

export function writeGitHubScaffolderSharedState(
  playwrightProjectName: string,
  state: GitHubScaffolderSharedState,
): void {
  const stateFile = getScaffolderStateFilePath(playwrightProjectName);
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
}

export function initOrRestoreGitHubScaffolderSharedState(
  playwrightProjectName: string,
): GitHubScaffolderSharedState {
  const existing = readGitHubScaffolderSharedState(playwrightProjectName);
  if (existing) {
    return existing;
  }

  return {
    testPrefix: "",
    repoName: "",
    repoFullName: "",
    repoUrl: "",
    publishCompleted: false,
  };
}

export function requireGitHubScaffolderSharedState(
  playwrightProjectName: string,
): GitHubScaffolderSharedState {
  const state = readGitHubScaffolderSharedState(playwrightProjectName);
  if (!state?.publishCompleted || !state.repoName) {
    throw new Error(
      "GitHub scaffolder shared state is missing or publish test did not complete",
    );
  }
  return state;
}

export function deleteGitHubScaffolderSharedState(
  playwrightProjectName: string,
): void {
  const stateFile = getScaffolderStateFilePath(playwrightProjectName);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

export async function deployGitHubScaffolderHub(
  rhdh: GitHubScaffolderRhdhWorker,
): Promise<void> {
  await rhdh.configure(GITHUB_SCAFFOLDER_RHDH_CONFIG);
  await rhdh.deploy();
}
