import { requireEnv } from "@red-hat-developer-hub/e2e-test-utils/utils";

import { GitLabApiHelper } from "../api/gitlab-api-helper.js";
import { prepareGitLabParentGroup } from "./common-test-setup.js";

export const GITLAB_EVENTS_CATALOG_TOKEN = "test-token";

const GITLAB_EVENTS_RHDH_CONFIG = {
  auth: "keycloak" as const,
  appConfig: "tests/config/gitlab-events/app-config-rhdh.yaml",
  secrets: "tests/config/gitlab-events/rhdh-secrets.yaml",
  dynamicPlugins: "tests/config/gitlab-events/dynamic-plugins.yaml",
  valueFile: "tests/config/gitlab-events/value-file.yaml",
};

/** Worker fixture shape used by GitLab events E2E suites */
export type GitLabEventsRhdhWorker = {
  configure: (options: typeof GITLAB_EVENTS_RHDH_CONFIG) => Promise<void>;
  deploy: () => Promise<void>;
  rhdhUrl: string;
};

export function requireGitLabEventsVaultEnv(): void {
  requireEnv("VAULT_EVENTS_GITLAB_TOKEN");
  requireEnv("VAULT_EVENTS_GITLAB_HOST");
  requireEnv("VAULT_EVENTS_GITLAB_PARENT_ORG");
  requireEnv("VAULT_GITLAB_WEBHOOK_SECRET");
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

export async function deployGitLabEventsHub(
  rhdh: GitLabEventsRhdhWorker,
): Promise<{ rhdhUrl: string; catalogToken: string }> {
  await rhdh.configure(GITLAB_EVENTS_RHDH_CONFIG);
  await rhdh.deploy();
  return { rhdhUrl: rhdh.rhdhUrl, catalogToken: GITLAB_EVENTS_CATALOG_TOKEN };
}

export async function prepareGitLabEventsParentGroup(): Promise<{
  parentGroupId: number;
  parentGroupPath: string;
}> {
  return prepareGitLabParentGroup(process.env.VAULT_EVENTS_GITLAB_PARENT_ORG);
}
