import { gitlabClient } from "./gitlab-client.js";
import type { GitLabProject } from "./gitlab-api-helper.js";

/* eslint-disable @typescript-eslint/naming-convention --
   GitLab REST request bodies, query params, and headers follow API names (snake_case, PRIVATE-TOKEN). */

/** Issue fields consumed from GitLab REST (`/projects/:id/issues`) in these tests */
export interface GitLabIssue {
  id: number;
  iid: number;
  title: string;
  web_url?: string;
}

/** Merge request fields consumed from GitLab REST in these tests */
export interface GitLabMergeRequest {
  id: number;
  iid: number;
  title: string;
  source_branch: string;
  web_url?: string;
}

/** Current user fields from GitLab REST (`GET /user`) */
export interface GitLabCurrentUser {
  id: number;
  username: string;
  name: string;
  state: string;
}

/** Project CI/CD variable from GitLab REST */
export interface GitLabProjectVariable {
  key: string;
  value: string;
  variable_type: string;
}

/** Repository file metadata from GitLab REST */
export interface GitLabRepositoryFile {
  file_name: string;
  file_path: string;
  ref: string;
}

/** Scaffolder assertion helpers — read/poll GitLab state for template action tests */
export class GitLabScaffolderApi {
  /**
   * Find a project by path under a parent group (includes subgroups).
   */
  static async findProjectInGroup(
    groupId: number,
    projectName: string,
  ): Promise<GitLabProject | undefined> {
    const projects = await gitlabClient.getGroupProjects(groupId, projectName);
    return projects.find((project) => project.name === projectName);
  }

  /**
   * List issues for a project, optionally filtered by title.
   */
  static async listProjectIssues(
    projectId: number,
    title?: string,
  ): Promise<GitLabIssue[]> {
    const query = title ? `?search=${encodeURIComponent(title)}` : "";
    const response = await gitlabClient.request(
      "GET",
      `/projects/${projectId}/issues${query}`,
    );
    return gitlabClient.assertJsonArray<GitLabIssue>(await response.json());
  }

  /**
   * List merge requests for a project, optionally filtered by source branch.
   */
  static async listMergeRequests(
    projectId: number,
    sourceBranch?: string,
  ): Promise<GitLabMergeRequest[]> {
    const params = new URLSearchParams({ state: "opened" });
    if (sourceBranch) {
      params.set("source_branch", sourceBranch);
    }
    const response = await gitlabClient.request(
      "GET",
      `/projects/${projectId}/merge_requests?${params}`,
    );
    return gitlabClient.assertJsonArray<GitLabMergeRequest>(
      await response.json(),
    );
  }

  /** Returns the authenticated GitLab user for the configured token. */
  static async getCurrentUser(): Promise<GitLabCurrentUser> {
    const response = await gitlabClient.request("GET", "/user");
    return gitlabClient.parseJson<GitLabCurrentUser>(response);
  }

  /** Fetches a single project CI/CD variable by key. */
  static async getProjectVariable(
    projectId: number,
    key: string,
  ): Promise<GitLabProjectVariable | undefined> {
    try {
      const response = await gitlabClient.request(
        "GET",
        `/projects/${projectId}/variables/${encodeURIComponent(key)}`,
      );
      return gitlabClient.parseJson<GitLabProjectVariable>(response);
    } catch (error) {
      if (error instanceof Error && error.message.includes("404")) {
        return undefined;
      }
      throw error;
    }
  }

  /** Returns repository file metadata when the path exists on the given ref. */
  static async getRepositoryFile(
    projectId: number,
    filePath: string,
    ref = "main",
  ): Promise<GitLabRepositoryFile | undefined> {
    try {
      const response = await gitlabClient.request(
        "GET",
        `/projects/${projectId}/repository/files/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(ref)}`,
      );
      return gitlabClient.parseJson<GitLabRepositoryFile>(response);
    } catch (error) {
      if (error instanceof Error && error.message.includes("404")) {
        return undefined;
      }
      throw error;
    }
  }
}
