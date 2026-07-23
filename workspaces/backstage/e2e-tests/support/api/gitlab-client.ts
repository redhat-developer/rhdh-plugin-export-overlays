import type { APIResponse } from "@playwright/test";

import type { GitLabProject } from "./gitlab-api-helper.js";

/**
 * Narrow HTTP adapter used by scaffolder assertion helpers.
 * Bound from {@link GitLabApiHelper.init} so this module never imports the helper
 * implementation at runtime (avoids a circular dependency with gitlab-scaffolder-api).
 */
export type GitLabClient = {
  request: (
    method: string,
    endpoint: string,
    body?: string | object,
  ) => Promise<APIResponse>;
  parseJson: <T>(response: APIResponse) => Promise<T>;
  assertJsonArray: <T>(value: unknown) => T[];
  getGroupProjects: (
    groupId: number,
    prefix?: string,
  ) => Promise<GitLabProject[]>;
};

let boundClient: GitLabClient | undefined;

export function bindGitLabClient(client: GitLabClient): void {
  boundClient = client;
}

function requireClient(): GitLabClient {
  if (!boundClient) {
    throw new Error(
      "GitLab client is not bound; call GitLabApiHelper.init() first",
    );
  }
  return boundClient;
}

export const gitlabClient: GitLabClient = {
  request: (method, endpoint, body) =>
    requireClient().request(method, endpoint, body),
  parseJson: <T>(response: APIResponse) =>
    requireClient().parseJson<T>(response),
  assertJsonArray: <T>(value: unknown) =>
    requireClient().assertJsonArray<T>(value),
  getGroupProjects: (groupId, prefix) =>
    requireClient().getGroupProjects(groupId, prefix),
};
