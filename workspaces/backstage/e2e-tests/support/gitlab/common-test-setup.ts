import { requireEnv } from "@red-hat-developer-hub/e2e-test-utils/utils";

import { GitLabApiHelper } from "../api/gitlab-api-helper.js";

type SelfHostedGitLabEnv = {
  host: string;
  token: string;
  parentGroupPath: string;
};

function readRequiredEnv(name: string): string {
  requireEnv(name);
  return process.env[name] ?? "";
}

/**
 * Connection to the self-hosted GitLab instance shared by every GitLab suite
 * except gitlab-auth. The VAULT_ prefix is retained for compatibility with
 * existing CI secret exports.
 */
export function requireSelfHostedGitLabEnv(): SelfHostedGitLabEnv {
  return {
    host: readRequiredEnv("VAULT_EVENTS_GITLAB_HOST"),
    token: readRequiredEnv("VAULT_EVENTS_GITLAB_TOKEN"),
    parentGroupPath: readRequiredEnv("VAULT_EVENTS_GITLAB_PARENT_ORG"),
  };
}

/**
 * Initializes {@link GitLabApiHelper} against the self-hosted instance and
 * returns a unique resource prefix for this run.
 */
export function bootstrapSelfHostedGitLabApiClient(): string {
  const { host, token } = requireSelfHostedGitLabEnv();
  GitLabApiHelper.init(`https://${host}`, token);
  return GitLabApiHelper.generateTestPrefix();
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
