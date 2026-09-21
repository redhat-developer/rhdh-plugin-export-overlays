import { randomBytes } from "node:crypto";

import { APIRequestContext, APIResponse, request } from "@playwright/test";

import { bindGitLabClient } from "./gitlab-client.js";

/* eslint-disable @typescript-eslint/naming-convention --
   GitLab REST request bodies, query params, and headers follow API names (snake_case, PRIVATE-TOKEN). */

/** Group fields consumed from GitLab REST (`/groups/*`) in these tests */
export interface GitLabGroup {
  id: number;
  name: string;
  full_path: string;
  visibility: string;
  created_at: string;
}

/** Project fields consumed from GitLab REST (`/projects/*`) in these tests */
export interface GitLabProject {
  id: number;
  name: string;
  created_at: string;
  visibility?: string;
  full_path?: string;
  path_with_namespace?: string;
  path?: string;
  namespace?: {
    full_path?: string;
  };
}

interface GitLabEntityWithId {
  id: number;
}

/**
 * GitLab API helper for E2E tests
 *
 * Requires a GitLab token with admin privileges to:
 * - Manage groups, projects, and files (regular API operations)
 * - Create/delete system hooks (requires admin role)
 * - Manage users (requires admin role)
 *
 * @see https://docs.gitlab.com/api/
 */
export class GitLabApiHelper {
  private static baseUrl: string;
  private static token: string;
  private static context: APIRequestContext | undefined;

  /**
   * Initialize the GitLab API helper with connection details
   * The token should have admin privileges for system hook management
   */
  static init(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, ""); // Remove trailing slash
    this.token = token;
    bindGitLabClient({
      request: (method, endpoint, body) =>
        GitLabApiHelper.safeGitLabRequest(method, endpoint, body),
      parseJson: <T>(response: APIResponse) =>
        GitLabApiHelper.parseJson<T>(response),
      assertJsonArray: <T>(value: unknown) =>
        GitLabApiHelper.assertJsonArray<T>(value),
      getGroupProjects: (groupId, prefix) =>
        GitLabApiHelper.getGroupProjects(groupId, prefix),
    });
  }

  private static async getContext(): Promise<APIRequestContext> {
    if (!this.context) {
      this.context = await request.newContext({
        ignoreHTTPSErrors: true,
      });
    }
    return this.context;
  }

  static async dispose(): Promise<void> {
    if (this.context) {
      await this.context.dispose();
      this.context = undefined;
    }
  }

  /**
   * Make a safe GitLab API request
   */
  private static async safeGitLabRequest(
    method: string,
    endpoint: string,
    body?: string | object,
  ): Promise<APIResponse> {
    const context = await this.getContext();

    if (!this.token) {
      throw new Error("GitLab token not provided");
    }

    const authToken = this.token;

    const url = `${this.baseUrl}/api/v4${endpoint}`;

    let requestBody: string | undefined;
    if (body === undefined) {
      requestBody = undefined;
    } else if (typeof body === "object") {
      requestBody = JSON.stringify(body);
    } else {
      requestBody = body;
    }

    const headers: Record<string, string> = {
      "PRIVATE-TOKEN": authToken,
    };
    const methodLc = method.toLowerCase();
    if (methodLc !== "delete" || requestBody !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    let response: APIResponse;

    switch (methodLc) {
      case "get":
        response = await context.get(url, { headers });
        break;
      case "post":
        response = await context.post(url, { headers, data: requestBody });
        break;
      case "put":
        response = await context.put(url, { headers, data: requestBody });
        break;
      case "delete":
        response =
          requestBody === undefined
            ? await context.delete(url, { headers })
            : await context.delete(url, { headers, data: requestBody });
        break;
      default:
        throw new Error(`Unsupported HTTP method: ${method}`);
    }

    if (!response.ok()) {
      const responseText = await response.text();
      throw new Error(
        `GitLab API request failed: ${method} ${url} - ${response.status()} ${response.statusText()}\nResponse: ${responseText}`,
      );
    }

    return response;
  }

  private static async parseJson<T>(response: APIResponse): Promise<T> {
    return (await response.json()) as T;
  }

  private static assertJsonArray<T>(value: unknown): T[] {
    if (!Array.isArray(value)) {
      throw new TypeError("GitLab API returned a non-array JSON payload");
    }
    return value as T[];
  }

  /**
   * Create a new project in a group
   */
  static async createProject(
    groupId: number,
    projectName: string,
  ): Promise<number> {
    // Get parent group to inherit compatible visibility
    const groupResponse = await this.safeGitLabRequest(
      "GET",
      `/groups/${groupId}`,
    );
    const group = await this.parseJson<GitLabGroup>(groupResponse);

    // Use same visibility as group or 'private' (most restrictive and always allowed)
    const visibility = group.visibility === "public" ? "internal" : "private";

    console.log(
      `Creating project "${projectName}" with visibility: ${visibility} (group: ${group.visibility})`,
    );

    const response = await this.safeGitLabRequest("POST", "/projects", {
      name: projectName,
      namespace_id: groupId,
      visibility: visibility,
      initialize_with_readme: true,
    });

    const project = await this.parseJson<GitLabEntityWithId>(response);
    return project.id;
  }

  /**
   * Path GitLab compares to {@code permanently_remove}'s {@code full_path} query param
   * (must match Ruby {@code Project#full_path}); see GitLab {@code Projects API}.
   */
  private static resolveProjectPermanentDeleteFullPath(
    project: GitLabProject,
  ): string {
    const topFull = project.full_path;
    if (typeof topFull === "string" && topFull.length > 0) {
      return topFull;
    }
    const pathWithNs = project.path_with_namespace;
    if (typeof pathWithNs === "string" && pathWithNs.length > 0) {
      return pathWithNs;
    }
    const ns = project.namespace;
    const projectPath = project.path;
    if (
      ns &&
      typeof ns.full_path === "string" &&
      typeof projectPath === "string"
    ) {
      return `${ns.full_path}/${projectPath}`;
    }
    throw new Error(
      "Unable to resolve GitLab full_path for permanent project deletion",
    );
  }

  /**
   * Delete a project with optional permanent removal
   */
  static async deleteProject(
    projectId: number,
    permanentlyRemove = false,
  ): Promise<void> {
    try {
      if (permanentlyRemove) {
        const projectPayload = await this.getProject(projectId);
        console.log(
          `Permanently deleting project ${projectId} (${this.resolveProjectPermanentDeleteFullPath(projectPayload)})`,
        );

        // Step 1: Mark project for deletion (soft delete)
        try {
          await this.safeGitLabRequest("DELETE", `/projects/${projectId}`);
          console.log(`Project ${projectId} marked for deletion`);

          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes("already been marked for deletion")
          ) {
            console.log(`Project ${projectId} already marked for deletion`);
          } else {
            throw error;
          }
        }

        // Re-fetch: pending-delete payloads are authoritative for paths on some releases
        let permanentPath =
          this.resolveProjectPermanentDeleteFullPath(projectPayload);
        try {
          const pending = await this.getProject(projectId);
          permanentPath = this.resolveProjectPermanentDeleteFullPath(pending);
        } catch {
          /* use path from original GET */
        }

        const queryParams = new URLSearchParams({
          permanently_remove: "true",
          full_path: permanentPath,
        });
        await this.safeGitLabRequest(
          "DELETE",
          `/projects/${projectId}?${queryParams}`,
        );
        console.log(`Project ${projectId} permanently removed`);
      } else {
        // Regular soft deletion
        await this.safeGitLabRequest("DELETE", `/projects/${projectId}`);
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("404") ||
          error.message.includes("already been marked for deletion") ||
          error.message.includes("Project must be marked for deletion first"))
      ) {
        console.log(
          `Project ${projectId} already deleted, doesn't exist, or marked for deletion`,
        );
        return;
      }
      throw error;
    }
  }

  /**
   * Create a file in a project
   */
  static async createFile(
    projectId: number,
    filePath: string,
    content: string,
    commitMessage: string,
    branch = "main",
  ): Promise<void> {
    await this.safeGitLabRequest(
      "POST",
      `/projects/${projectId}/repository/files/${encodeURIComponent(filePath)}`,
      {
        branch,
        content,
        commit_message: commitMessage,
      },
    );
  }

  /**
   * Update a file in a project
   */
  static async updateFile(
    projectId: number,
    filePath: string,
    content: string,
    commitMessage: string,
    branch = "main",
  ): Promise<void> {
    await this.safeGitLabRequest(
      "PUT",
      `/projects/${projectId}/repository/files/${encodeURIComponent(filePath)}`,
      {
        branch,
        content,
        commit_message: commitMessage,
      },
    );
  }

  /**
   * Delete a file from a project
   */
  static async deleteFile(
    projectId: number,
    filePath: string,
    commitMessage: string,
    branch = "main",
  ): Promise<void> {
    try {
      // GitLab DELETE API requires branch and commit_message as query parameters
      const queryParams = new URLSearchParams({
        branch,
        commit_message: commitMessage,
      });
      await this.safeGitLabRequest(
        "DELETE",
        `/projects/${projectId}/repository/files/${encodeURIComponent(filePath)}?${queryParams}`,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("404")) {
        console.log(`File ${filePath} already deleted or doesn't exist`);
        return;
      }
      throw error;
    }
  }

  /**
   * Create a new group (subgroup)
   */
  static async createGroup(
    parentGroupId: number,
    groupName: string,
  ): Promise<number> {
    // Get parent group to inherit compatible visibility
    const parentResponse = await this.safeGitLabRequest(
      "GET",
      `/groups/${parentGroupId}`,
    );
    const parentGroup = await this.parseJson<GitLabGroup>(parentResponse);

    // Use same visibility as parent or 'private' (most restrictive and always allowed)
    const visibility =
      parentGroup.visibility === "public" ? "internal" : "private";

    console.log(
      `Creating group "${groupName}" with visibility: ${visibility} (parent: ${parentGroup.visibility})`,
    );

    const response = await this.safeGitLabRequest("POST", "/groups", {
      name: groupName,
      path: groupName.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
      parent_id: parentGroupId,
      visibility: visibility,
    });

    const group = await this.parseJson<GitLabEntityWithId>(response);
    return group.id;
  }

  /** Full path GitLab expects for {@code permanently_remove} — must match Ruby {@code Group#full_path}. */
  private static resolveGroupPermanentDeleteFullPath(
    group: GitLabGroup,
  ): string {
    const fp = group.full_path;
    if (typeof fp === "string" && fp.trim().length > 0) {
      return fp.trim();
    }
    throw new Error(
      "Unable to resolve GitLab full_path for permanent subgroup deletion",
    );
  }

  private static isDeleteGroupIgnorableError(error: unknown): boolean {
    return (
      error instanceof Error &&
      (error.message.includes("404") ||
        error.message.includes("already been marked for deletion") ||
        error.message.includes("Group must be marked for deletion first"))
    );
  }

  private static async scheduleGroupForDeletion(
    groupId: number,
  ): Promise<void> {
    try {
      await this.safeGitLabRequest("DELETE", `/groups/${groupId}`);
      console.log(`Group ${groupId} marked for deletion`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("already been marked for deletion")
      ) {
        console.log(`Group ${groupId} already marked for deletion`);
        return;
      }
      throw error;
    }
  }

  /**
   * full_path AFTER scheduling differs on some releases — official API shows JSON body:
   * @see https://docs.gitlab.com/api/groups/#delete-a-group-permanently
   */
  private static async getGroupFullPathForPermanentDelete(
    groupId: number,
  ): Promise<string> {
    try {
      const refreshed = await this.safeGitLabRequest(
        "GET",
        `/groups/${groupId}`,
      );
      const groupPayload = await this.parseJson<GitLabGroup>(refreshed);
      const permanentPath =
        this.resolveGroupPermanentDeleteFullPath(groupPayload);
      console.log(
        `Permanent group delete uses post-schedule full_path="${permanentPath}"`,
      );
      return permanentPath;
    } catch (e) {
      const hint = e instanceof Error ? e.message : JSON.stringify(String(e));
      throw new Error(
        `Could not GET group ${groupId} after scheduling deletion (${hint}); refusing blind permanent_delete`,
        { cause: e },
      );
    }
  }

  /**
   * Delete a group with optional permanent removal
   */
  static async deleteGroup(
    groupId: number,
    permanentlyRemove = false,
  ): Promise<void> {
    try {
      if (permanentlyRemove) {
        console.log(`Permanently deleting group ${groupId}`);
        await this.scheduleGroupForDeletion(groupId);
        const permanentPath =
          await this.getGroupFullPathForPermanentDelete(groupId);
        await this.safeGitLabRequest("DELETE", `/groups/${groupId}`, {
          permanently_remove: true,
          full_path: permanentPath,
        });
        console.log(`Group ${groupId} permanently removed`);
      } else {
        await this.safeGitLabRequest("DELETE", `/groups/${groupId}`);
      }
    } catch (error) {
      if (this.isDeleteGroupIgnorableError(error)) {
        console.log(
          `Group ${groupId} already deleted, doesn't exist, or marked for deletion`,
        );
        return;
      }
      throw error;
    }
  }

  /**
   * Create a project webhook
   */
  static async createProjectWebhook(
    projectId: number,
    url: string,
    secret: string | undefined,
  ): Promise<number> {
    if (secret === undefined) {
      throw new TypeError("GitLab webhook secret is required");
    }
    const response = await this.safeGitLabRequest(
      "POST",
      `/projects/${projectId}/hooks`,
      {
        url,
        token: secret,
        push_events: true,
        tag_push_events: true,
        merge_requests_events: true,
        issues_events: true,
        note_events: true,
        job_events: true,
        pipeline_events: true,
        wiki_page_events: true,
        deployment_events: true,
        releases_events: true,
        enable_ssl_verification: false, // For test environments
      },
    );

    const webhook = await this.parseJson<GitLabEntityWithId>(response);
    return webhook.id;
  }

  /**
   * Delete a project webhook
   */
  static async deleteProjectWebhook(
    projectId: number,
    webhookId: number,
  ): Promise<void> {
    try {
      await this.safeGitLabRequest(
        "DELETE",
        `/projects/${projectId}/hooks/${webhookId}`,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("404")) {
        console.log(
          `Project webhook ${webhookId} already deleted or doesn't exist`,
        );
        return;
      }
      throw error;
    }
  }

  /**
   * Create a system hook (requires admin privileges)
   */
  static async createSystemHook(
    url: string,
    secret: string | undefined,
  ): Promise<number> {
    if (secret === undefined) {
      throw new TypeError("GitLab webhook secret is required");
    }
    const response = await this.safeGitLabRequest("POST", "/hooks", {
      url,
      token: secret,
      push_events: true,
      tag_push_events: true,
      merge_requests_events: true,
      repository_update_events: true,
      enable_ssl_verification: false, // For test environments
    });

    const hook = await this.parseJson<GitLabEntityWithId>(response);
    return hook.id;
  }

  /**
   * Delete a system hook (requires admin privileges)
   */
  static async deleteSystemHook(hookId: number): Promise<void> {
    try {
      await this.safeGitLabRequest("DELETE", `/hooks/${hookId}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("404")) {
        console.log(`System hook ${hookId} already deleted or doesn't exist`);
        return;
      }
      throw error;
    }
  }

  /** Initial password for API-created users; not returned and not used by these tests (admin token + Keycloak). */
  private static newEphemeralGitLabUserPassword(): string {
    return randomBytes(24).toString("base64");
  }

  /**
   * Create a user (requires admin privileges)
   */
  static async createUser(
    name: string,
    username: string,
    email: string,
  ): Promise<number> {
    const response = await this.safeGitLabRequest("POST", "/users", {
      name,
      username,
      email,
      password: this.newEphemeralGitLabUserPassword(),
      skip_confirmation: true,
    });

    const user = await this.parseJson<GitLabEntityWithId>(response);
    return user.id;
  }

  /**
   * Delete a user with optional hard delete (requires admin privileges)
   */
  static async deleteUser(userId: number, hardDelete = false): Promise<void> {
    try {
      if (hardDelete) {
        console.log(`Hard deleting user ${userId}`);

        // Step 1: Mark user for deletion (soft delete)
        try {
          await this.safeGitLabRequest("DELETE", `/users/${userId}`);
          console.log(`User ${userId} marked for deletion`);

          // Brief wait to ensure the user is marked for deletion
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes("already been marked for deletion")
          ) {
            console.log(`User ${userId} already marked for deletion`);
          } else if (
            error instanceof Error &&
            error.message.includes("User must be marked for deletion first")
          ) {
            // User might already be marked, proceed to hard delete
            console.log(
              `User ${userId} already marked for deletion, proceeding to hard delete`,
            );
          } else {
            throw error;
          }
        }

        // Step 2: Hard delete the marked user
        const queryParams = new URLSearchParams({
          hard_delete: "true",
        });
        await this.safeGitLabRequest(
          "DELETE",
          `/users/${userId}?${queryParams}`,
        );
        console.log(`User ${userId} hard deleted`);
      } else {
        // Regular soft deletion
        await this.safeGitLabRequest("DELETE", `/users/${userId}`);
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("404") ||
          error.message.includes("already been marked for deletion") ||
          error.message.includes("User must be marked for deletion first"))
      ) {
        console.log(
          `User ${userId} already deleted, doesn't exist, or marked for deletion`,
        );
        return;
      }
      throw error;
    }
  }

  /**
   * Add a user to a group
   */
  static async addUserToGroup(
    groupId: number,
    userId: number,
    accessLevel = 30,
  ): Promise<void> {
    await this.safeGitLabRequest("POST", `/groups/${groupId}/members`, {
      user_id: userId,
      access_level: accessLevel, // 30 = Developer, 40 = Maintainer, 50 = Owner
    });
  }

  /**
   * Remove a user from a group
   */
  static async removeUserFromGroup(
    groupId: number,
    userId: number,
  ): Promise<void> {
    try {
      await this.safeGitLabRequest(
        "DELETE",
        `/groups/${groupId}/members/${userId}`,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("404")) {
        console.log(
          `User ${userId} not found in group ${groupId} or already removed`,
        );
        return;
      }
      throw error;
    }
  }

  /**
   * Get group by path
   */
  static async getGroupByPath(
    groupPath: string | undefined,
  ): Promise<GitLabGroup> {
    if (!groupPath) {
      throw new TypeError("groupPath is required");
    }
    const response = await this.safeGitLabRequest(
      "GET",
      `/groups/${encodeURIComponent(groupPath)}`,
    );
    return this.parseJson<GitLabGroup>(response);
  }

  /**
   * List projects in a group (with pagination)
   */
  static async getGroupProjects(
    groupId: number,
    prefix?: string,
  ): Promise<GitLabProject[]> {
    let page = 1;
    const perPage = 100;
    const allProjects: GitLabProject[] = [];

    while (true) {
      const response = await this.safeGitLabRequest(
        "GET",
        `/groups/${groupId}/projects?page=${page}&per_page=${perPage}&include_subgroups=true`,
      );
      const projects = this.assertJsonArray<GitLabProject>(
        await response.json(),
      );

      if (projects.length === 0) {
        break;
      }

      if (prefix) {
        allProjects.push(...projects.filter((p) => p.name.startsWith(prefix)));
      } else {
        allProjects.push(...projects);
      }

      if (projects.length < perPage) {
        break;
      }

      page++;
    }

    return allProjects;
  }

  /**
   * List subgroups in a group (with pagination)
   */
  static async getSubgroups(
    groupId: number,
    prefix?: string,
  ): Promise<GitLabGroup[]> {
    let page = 1;
    const perPage = 100;
    const allGroups: GitLabGroup[] = [];

    while (true) {
      const response = await this.safeGitLabRequest(
        "GET",
        `/groups/${groupId}/subgroups?page=${page}&per_page=${perPage}`,
      );
      const groups = this.assertJsonArray<GitLabGroup>(await response.json());

      if (groups.length === 0) {
        break;
      }

      if (prefix) {
        allGroups.push(...groups.filter((g) => g.name.startsWith(prefix)));
      } else {
        allGroups.push(...groups);
      }

      if (groups.length < perPage) {
        break;
      }

      page++;
    }

    return allGroups;
  }

  /**
   * Clean up stale test resources (projects and groups with a specific prefix older than maxAgeHours)
   */
  static async cleanupStaleResources(
    parentGroupId: number,
    prefix: string,
    maxAgeHours: number,
  ): Promise<void> {
    const cutoffDate = new Date();
    cutoffDate.setHours(cutoffDate.getHours() - maxAgeHours);

    console.log(
      `Cleaning up resources with prefix "${prefix}" older than ${cutoffDate.toISOString()}`,
    );

    // Clean up projects with permanent removal to avoid "pending deletion" state
    const projects = await this.getGroupProjects(parentGroupId, prefix);
    for (const project of projects) {
      const createdAt = new Date(project.created_at);
      if (createdAt < cutoffDate) {
        console.log(
          `Permanently deleting stale project: ${project.name} (created ${createdAt.toISOString()})`,
        );
        await this.deleteProject(project.id, true);
      }
    }

    // Clean up subgroups with permanent removal to avoid "pending deletion" state
    const subgroups = await this.getSubgroups(parentGroupId, prefix);
    for (const group of subgroups) {
      const createdAt = new Date(group.created_at);
      if (createdAt < cutoffDate) {
        console.log(
          `Permanently deleting stale group: ${group.name} (created ${createdAt.toISOString()})`,
        );
        await this.deleteGroup(group.id, true);
      }
    }
  }

  /**
   * Generate a unique test prefix for GitLab resource names (not for secrets).
   */
  static generateTestPrefix(): string {
    const timestamp = Date.now().toString(36);
    const random = randomBytes(4).toString("hex");
    return `e2e-${timestamp}-${random}`;
  }

  /**
   * Get project details
   */
  static async getProject(projectId: number): Promise<GitLabProject> {
    const response = await this.safeGitLabRequest(
      "GET",
      `/projects/${projectId}`,
    );
    return this.parseJson<GitLabProject>(response);
  }
}
