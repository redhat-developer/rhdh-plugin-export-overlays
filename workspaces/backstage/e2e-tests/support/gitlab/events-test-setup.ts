import { requireEnv } from "@red-hat-developer-hub/e2e-test-utils/utils";

import { bootstrapSelfHostedGitLabApiClient } from "./common-test-setup.js";
import { DeploymentOptions } from "@red-hat-developer-hub/e2e-test-utils/rhdh";

export const GITLAB_EVENTS_CATALOG_TOKEN = "test-token";

const GITLAB_EVENTS_RHDH_CONFIG: DeploymentOptions = {
  auth: "keycloak" as const,
  appConfig: "tests/config/gitlab-events/app-config-rhdh.yaml",
  secrets: "tests/config/gitlab-events/rhdh-secrets.yaml",
  dynamicPlugins: "tests/config/gitlab-events/dynamic-plugins.yaml",
};

/** Worker fixture shape used by GitLab events E2E suites */
export type GitLabEventsRhdhWorker = {
  configure: (options: typeof GITLAB_EVENTS_RHDH_CONFIG) => Promise<void>;
  deploy: () => Promise<void>;
  rhdhUrl: string;
};

/**
 * Validates secret/GitLab env, initializes the GitLab API helper, and returns a
 * unique resource prefix for this run. The events suites also need the
 * webhook secret on top of the shared self-hosted connection.
 */
export function bootstrapGitLabEventsApiClient(): string {
  requireEnv("VAULT_GITLAB_WEBHOOK_SECRET");
  return bootstrapSelfHostedGitLabApiClient();
}

export async function deployGitLabEventsHub(
  rhdh: GitLabEventsRhdhWorker,
): Promise<{ rhdhUrl: string; catalogToken: string }> {
  await rhdh.configure(GITLAB_EVENTS_RHDH_CONFIG);
  await rhdh.deploy();
  return { rhdhUrl: rhdh.rhdhUrl, catalogToken: GITLAB_EVENTS_CATALOG_TOKEN };
}
