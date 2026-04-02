/* eslint-disable @typescript-eslint/naming-convention */
import { APIRequestContext, APIResponse, request } from "@playwright/test";
import * as crypto from "node:crypto";

type CatalogAction = "added" | "modified" | "removed";
type TeamAction = "created" | "deleted";
type MembershipAction = "added" | "removed";

interface GitHubUser {
  login: string;
  id: number;
  node_id: string;
  avatar_url: string;
  gravatar_id: string;
  url: string;
  html_url: string;
  followers_url: string;
  following_url: string;
  gists_url: string;
  starred_url: string;
  subscriptions_url: string;
  organizations_url: string;
  repos_url: string;
  events_url: string;
  received_events_url: string;
  type: string;
  user_view_type: string;
  site_admin: boolean;
}

interface Commit {
  id: string;
  tree_id: string;
  distinct: boolean;
  message: string;
  timestamp: string;
  url: string;
  author: {
    name: string;
    email: string;
    date: string;
    username: string;
  };
  committer: {
    name: string;
    email: string;
    date: string;
    username: string;
  };
  added: string[];
  removed: string[];
  modified: string[];
}

interface Repository {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  private: boolean;
  owner: {
    name: string;
    login: string;
    id: number;
    node_id: string;
    avatar_url: string;
    type: string;
  };
  html_url: string;
  description: string;
  url: string;
  default_branch: string;
  topics: string[];
  archived: boolean;
  fork: boolean;
  visibility: string;
}

interface PushPayload {
  ref: string;
  before: string;
  after: string;
  repository: Repository;
  pusher: { name: string; email: string };
  organization: {
    login: string;
    id: number;
    node_id: string;
    url: string;
    avatar_url: string;
  };
  sender: { login: string; id: number; type: string };
  created: boolean;
  deleted: boolean;
  forced: boolean;
  base_ref: string | null;
  compare: string;
  commits: Commit[];
  head_commit: Commit;
}

interface Team {
  name: string;
  id: number;
  node_id: string;
  slug: string;
  description: string;
  privacy: string;
  notification_setting: string;
  url: string;
  html_url: string;
  members_url: string;
  repositories_url: string;
  type: string;
  organization_id: number;
  permission: string;
  parent: null;
}

interface TeamPayload {
  action: TeamAction;
  team: Team;
  organization: {
    login: string;
    id: number;
    node_id: string;
    url: string;
    repos_url: string;
    events_url: string;
    hooks_url: string;
    issues_url: string;
    members_url: string;
    public_members_url: string;
    avatar_url: string;
    description: string | null;
  };
  sender: {
    login: string;
    id: number;
    node_id: string;
    avatar_url: string;
    gravatar_id: string;
    url: string;
    html_url: string;
    type: string;
    user_view_type: string;
    site_admin: boolean;
  };
}

interface MembershipPayload {
  action: MembershipAction;
  scope: "team";
  member: GitHubUser;
  sender: TeamPayload["sender"];
  team: Team;
  organization: TeamPayload["organization"];
}

export class GitHubEventsHelper {
  private readonly eventsUrl: string;
  private readonly webhookSecret: string;
  private myContext!: APIRequestContext;

  private constructor(rhdhBaseUrl: string, webhookSecret: string) {
    this.eventsUrl = `${rhdhBaseUrl}/api/events/http/github`;
    this.webhookSecret = webhookSecret;
  }

  public static async build(
    rhdhBaseUrl: string,
    webhookSecret: string,
  ): Promise<GitHubEventsHelper> {
    const instance = new GitHubEventsHelper(rhdhBaseUrl, webhookSecret);
    instance.myContext = await request.newContext({
      ignoreHTTPSErrors: true,
    });
    return instance;
  }

  public async sendWebhookEvent<
    T extends PushPayload | TeamPayload | MembershipPayload,
  >(eventType: string, payload: T): Promise<APIResponse> {
    const payloadString = JSON.stringify(payload);
    const signature = this.calculateSignature(payloadString);

    return await this.myContext.post(this.eventsUrl, {
      data: payloadString,
      headers: {
        Accept: "*/*",
        "Content-Type": "application/json",
        "User-Agent": "GitHub-Hookshot/test",
        "X-GitHub-Delivery": crypto.randomUUID(),
        "X-GitHub-Event": eventType,
        "X-Hub-Signature-256": signature,
      },
    });
  }

  private calculateSignature(payload: string): string {
    const hmac = crypto.createHmac("sha256", this.webhookSecret);
    hmac.update(payload);
    return `sha256=${hmac.digest("hex")}`;
  }

  public async sendPushEvent(
    repo: string,
    catalogAction: "added" | "modified" | "removed" = "modified",
  ): Promise<APIResponse> {
    const payload = this.createPushPayload(repo, catalogAction);
    return await this.sendWebhookEvent("push", payload);
  }

  public async sendTeamEvent(
    action: "created" | "deleted",
    teamName: string,
    orgName: string,
  ): Promise<APIResponse> {
    const payload = this.createTeamPayload(action, teamName, orgName);
    return await this.sendWebhookEvent("team", payload);
  }

  public async sendMembershipEvent(
    action: "added" | "removed",
    username: string,
    teamName: string,
    orgName: string,
  ): Promise<APIResponse> {
    const payload = this.createMembershipPayload(
      action,
      username,
      teamName,
      orgName,
    );
    return await this.sendWebhookEvent("membership", payload);
  }

  private createCommit(
    repo: string,
    message: string,
    commitFiles: { added: string[]; removed: string[]; modified: string[] },
  ): Commit {
    return {
      id: crypto.randomUUID().substring(0, 40).replaceAll("-", "0"),
      tree_id: crypto.randomUUID().substring(0, 40).replaceAll("-", "0"),
      distinct: true,
      message,
      timestamp: new Date().toISOString(),
      url: `https://github.com/${repo}/commit/${crypto.randomUUID().substring(0, 40).replaceAll("-", "0")}`,
      author: {
        name: "Test User",
        email: "test@example.com",
        date: new Date().toISOString(),
        username: "test-user",
      },
      committer: {
        name: "GitHub",
        email: "noreply@github.com",
        date: new Date().toISOString(),
        username: "web-flow",
      },
      added: commitFiles.added,
      removed: commitFiles.removed,
      modified: commitFiles.modified,
    };
  }

  private createOrganization(
    orgName: string,
    orgId: number,
  ): TeamPayload["organization"] {
    return {
      login: orgName,
      id: orgId,
      node_id: "O_" + crypto.randomUUID().substring(0, 20),
      url: `https://api.github.com/orgs/${orgName}`,
      repos_url: `https://api.github.com/orgs/${orgName}/repos`,
      events_url: `https://api.github.com/orgs/${orgName}/events`,
      hooks_url: `https://api.github.com/orgs/${orgName}/hooks`,
      issues_url: `https://api.github.com/orgs/${orgName}/issues`,
      members_url: `https://api.github.com/orgs/${orgName}/members{/member}`,
      public_members_url: `https://api.github.com/orgs/${orgName}/public_members{/member}`,
      avatar_url: `https://avatars.githubusercontent.com/u/${orgId}?v=4`,
      description: null,
    };
  }

  private createTeam(
    teamName: string,
    teamId: number,
    orgId: number,
    orgName: string,
  ): Team {
    const slug = teamName.toLowerCase().replaceAll(/\s+/g, "-");
    return {
      name: teamName,
      id: teamId,
      node_id: "T_" + crypto.randomUUID().substring(0, 20),
      slug: slug,
      description: "",
      privacy: "closed",
      notification_setting: "notifications_enabled",
      url: `https://api.github.com/organizations/${orgId}/team/${teamId}`,
      html_url: `https://github.com/orgs/${orgName}/teams/${slug}`,
      members_url: `https://api.github.com/organizations/${orgId}/team/${teamId}/members{/member}`,
      repositories_url: `https://api.github.com/organizations/${orgId}/team/${teamId}/repos`,
      type: "organization",
      organization_id: orgId,
      permission: "pull",
      parent: null,
    };
  }

  private createPushPayload(
    repo: string,
    catalogAction: CatalogAction = "modified",
  ): PushPayload {
    const [owner, repoName] = repo.split("/");

    const catalogFile = "catalog-info.yaml";
    const commitFiles = {
      added: catalogAction === "added" ? [catalogFile] : [],
      removed: catalogAction === "removed" ? [catalogFile] : [],
      modified: catalogAction === "modified" ? [catalogFile] : [],
    };

    const commitMessages = {
      added: "Add catalog-info.yaml",
      modified: "Update catalog-info.yaml",
      removed: "Remove catalog-info.yaml",
    };

    const commit = this.createCommit(
      repo,
      commitMessages[catalogAction],
      commitFiles,
    );

    return {
      ref: "refs/heads/main",
      before: "0000000000000000000000000000000000000000",
      after: crypto.randomUUID().substring(0, 40).replaceAll("-", "0"),
      repository: {
        id: crypto.randomInt(1000000),
        node_id: "R_" + crypto.randomUUID().substring(0, 20),
        name: repoName,
        full_name: repo,
        private: false,
        owner: {
          name: owner,
          login: owner,
          id: crypto.randomInt(100000),
          node_id: "U_" + crypto.randomUUID().substring(0, 20),
          avatar_url: `https://avatars.githubusercontent.com/u/${crypto.randomInt(100000)}`,
          type: "Organization",
        },
        html_url: `https://github.com/${repo}`,
        description: `Test repository ${repoName}`,
        url: `https://api.github.com/repos/${repo}`,
        default_branch: "main",
        topics: [],
        archived: false,
        fork: false,
        visibility: "public",
      },
      pusher: {
        name: "test-user",
        email: "test@example.com",
      },
      organization: {
        login: owner,
        id: crypto.randomInt(100000),
        node_id: "O_" + crypto.randomUUID().substring(0, 20),
        url: `https://api.github.com/orgs/${owner}`,
        avatar_url: `https://avatars.githubusercontent.com/u/${crypto.randomInt(100000)}`,
      },
      sender: {
        login: "test-user",
        id: crypto.randomInt(100000),
        type: "User",
      },
      created: catalogAction === "added",
      deleted: catalogAction === "removed",
      forced: false,
      base_ref: null,
      compare: `https://github.com/${repo}/commit/${crypto.randomUUID().substring(0, 12).replaceAll("-", "0")}`,
      commits: [commit],
      head_commit: commit,
    };
  }

  private createTeamPayload(
    action: TeamAction,
    teamName: string,
    orgName: string,
  ): TeamPayload {
    const orgId = crypto.randomInt(1000000);
    const teamId = crypto.randomInt(100000000);
    return {
      action,
      team: this.createTeam(teamName, teamId, orgId, orgName),
      organization: this.createOrganization(orgName, orgId),
      sender: {
        login: "test-user",
        id: crypto.randomInt(100000),
        node_id: "U_" + crypto.randomUUID().substring(0, 20),
        avatar_url: `https://avatars.githubusercontent.com/u/${crypto.randomInt(100000)}?v=4`,
        gravatar_id: "",
        url: `https://api.github.com/users/test-user`,
        html_url: `https://github.com/test-user`,
        type: "User",
        user_view_type: "public",
        site_admin: false,
      },
    };
  }

  private createMembershipPayload(
    action: MembershipAction,
    username: string,
    teamName: string,
    orgName: string,
  ): MembershipPayload {
    const orgId = crypto.randomInt(1000000);
    const teamId = crypto.randomInt(100000000);
    const userId = crypto.randomInt(1000000);
    return {
      action,
      scope: "team",
      member: {
        login: username,
        id: userId,
        node_id: "U_" + crypto.randomUUID().substring(0, 20),
        avatar_url: `https://avatars.githubusercontent.com/u/${userId}?v=4`,
        gravatar_id: "",
        url: `https://api.github.com/users/${username}`,
        html_url: `https://github.com/${username}`,
        followers_url: `https://api.github.com/users/${username}/followers`,
        following_url: `https://api.github.com/users/${username}/following{/other_user}`,
        gists_url: `https://api.github.com/users/${username}/gists{/gist_id}`,
        starred_url: `https://api.github.com/users/${username}/starred{/owner}{/repo}`,
        subscriptions_url: `https://api.github.com/users/${username}/subscriptions`,
        organizations_url: `https://api.github.com/users/${username}/orgs`,
        repos_url: `https://api.github.com/users/${username}/repos`,
        events_url: `https://api.github.com/users/${username}/events{/privacy}`,
        received_events_url: `https://api.github.com/users/${username}/received_events`,
        type: "User",
        user_view_type: "public",
        site_admin: false,
      },
      sender: {
        login: "test-admin",
        id: crypto.randomInt(100000),
        node_id: "U_" + crypto.randomUUID().substring(0, 20),
        avatar_url: `https://avatars.githubusercontent.com/u/${crypto.randomInt(100000)}?v=4`,
        gravatar_id: "",
        url: `https://api.github.com/users/test-admin`,
        html_url: `https://github.com/test-admin`,
        type: "User",
        user_view_type: "public",
        site_admin: false,
      },
      team: this.createTeam(teamName, teamId, orgId, orgName),
      organization: this.createOrganization(orgName, orgId),
    };
  }
}
