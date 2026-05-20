import { promises as fs } from "fs";
import os from "os";
import path from "path";
import {
  GitHubWebSession,
  OAuthApplicationNotFoundError,
} from "./github-web-session";

export type ProvisionedGitHubOAuthApp = {
  name: string;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  /** Numeric id from github.com/settings/applications/{id} — used for deletion. */
  settingsAppId: string;
};

const provisionedByNamespace = new Map<string, ProvisionedGitHubOAuthApp>();

function oauthPersistPath(namespace: string): string {
  return path.join(os.tmpdir(), `rhdh-bulk-import-oauth-${namespace}.json`);
}

async function persistProvisionedApp(
  namespace: string,
  app: ProvisionedGitHubOAuthApp,
): Promise<void> {
  await fs.writeFile(oauthPersistPath(namespace), JSON.stringify(app), "utf8");
}

async function loadPersistedApp(
  namespace: string,
): Promise<ProvisionedGitHubOAuthApp | null> {
  try {
    const raw = await fs.readFile(oauthPersistPath(namespace), "utf8");
    return JSON.parse(raw) as ProvisionedGitHubOAuthApp;
  } catch {
    return null;
  }
}

async function clearPersistedApp(namespace: string): Promise<void> {
  await fs.unlink(oauthPersistPath(namespace)).catch(() => {});
}

/** Same URL shape as @red-hat-developer-hub/e2e-test-utils RHDHDeployment._buildBaseUrl. */
export function buildRhdhBaseUrl(namespace: string): string {
  const routerBase = process.env.K8S_CLUSTER_ROUTER_BASE;
  if (!routerBase) {
    throw new Error(
      "[bulk-import e2e] K8S_CLUSTER_ROUTER_BASE is required to build the RHDH OAuth callback URL.",
    );
  }
  return `https://redhat-developer-hub-${namespace}.${routerBase}`;
}

export function rhdhGitHubOAuthCallbackUrl(namespace: string): string {
  return `${buildRhdhBaseUrl(namespace)}/api/auth/github/handler/frame`;
}

export function assertOAuthCredentialsPresent(): void {
  const clientId = process.env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error(
      "[bulk-import e2e] GitHub OAuth client credentials are missing in process.env. " +
        "ensureGitHubOAuthAppForRhdh() must run before rhdh.deploy() so rhdh-secrets.yaml envsubst can populate the cluster Secret.",
    );
  }
}

function applyOAuthCredentialsToProcessEnv(
  app: ProvisionedGitHubOAuthApp,
): void {
  process.env.GITHUB_OAUTH_APP_ID = app.clientId;
  process.env.GITHUB_OAUTH_APP_SECRET = app.clientSecret;
  process.env.GITHUB_APP_CLIENT_ID = app.clientId;
  process.env.GITHUB_APP_CLIENT_SECRET = app.clientSecret;
  // eslint-disable-next-line no-console
  console.log(
    `[bulk-import e2e] RHDH will use OAuth client_id=${app.clientId} (callback ${app.callbackUrl})`,
  );
}

/**
 * GitHub has no public REST API to register user OAuth apps. We use an authenticated
 * browser flow via {@link GitHubWebSession}.
 */
async function createGitHubOAuthAppViaApi(
  name: string,
  homepageUrl: string,
  callbackUrl: string,
): Promise<ProvisionedGitHubOAuthApp> {
  const session = new GitHubWebSession();
  const { settingsAppId, clientId, clientSecret } =
    await session.createOAuthApplicationViaPlaywright({
      name,
      homepageUrl,
      callbackUrl,
    });

  // eslint-disable-next-line no-console
  console.log(
    `[bulk-import e2e] Created GitHub OAuth app "${name}" client_id=${clientId} callback=${callbackUrl}`,
  );

  return {
    name,
    clientId,
    clientSecret,
    callbackUrl,
    settingsAppId,
  };
}

async function deleteGitHubOAuthAppViaApi(
  app: ProvisionedGitHubOAuthApp,
): Promise<void> {
  const session = new GitHubWebSession();
  await session.deleteOAuthApplication(app.settingsAppId, {
    appName: app.name,
    clientId: app.clientId,
  });

  // eslint-disable-next-line no-console
  console.log(
    `[bulk-import e2e] Deleted GitHub OAuth app "${app.name}" (${app.clientId})`,
  );
}

/**
 * Creates a GitHub OAuth App scoped to this RHDH namespace (unique callback URL) and
 * exports credentials into process.env for rhdh-secrets envsubst before deploy.
 */
export async function ensureGitHubOAuthAppForRhdh(
  namespace: string,
): Promise<ProvisionedGitHubOAuthApp> {
  const inMemory = provisionedByNamespace.get(namespace);
  if (inMemory) {
    applyOAuthCredentialsToProcessEnv(inMemory);
    assertOAuthCredentialsPresent();
    return inMemory;
  }

  const persisted = await loadPersistedApp(namespace);
  if (persisted) {
    const expectedCallback = rhdhGitHubOAuthCallbackUrl(namespace);
    if (persisted.callbackUrl !== expectedCallback) {
      // eslint-disable-next-line no-console
      console.warn(
        `[bulk-import e2e] Stale OAuth metadata for ${namespace} ` +
          `(callback ${persisted.callbackUrl} != ${expectedCallback}) — provisioning a new app.`,
      );
      await clearPersistedApp(namespace);
    } else {
      provisionedByNamespace.set(namespace, persisted);
      applyOAuthCredentialsToProcessEnv(persisted);
      assertOAuthCredentialsPresent();
      // eslint-disable-next-line no-console
      console.log(
        `[bulk-import e2e] Reusing provisioned OAuth app ${persisted.clientId} for ${namespace}`,
      );
      return persisted;
    }
  }

  const callbackUrl = rhdhGitHubOAuthCallbackUrl(namespace);
  const homepageUrl = buildRhdhBaseUrl(namespace);
  const name = `rhdh-bulk-import-e2e-${namespace}-${Date.now()}`;

  const app = await createGitHubOAuthAppViaApi(name, homepageUrl, callbackUrl);
  provisionedByNamespace.set(namespace, app);
  await persistProvisionedApp(namespace, app);
  applyOAuthCredentialsToProcessEnv(app);
  assertOAuthCredentialsPresent();
  return app;
}

/** Deletes the OAuth app created for this namespace (no-op if none). */
export async function teardownGitHubOAuthAppForRhdh(
  namespace: string,
): Promise<void> {
  let app = provisionedByNamespace.get(namespace) ?? null;
  if (!app) {
    app = await loadPersistedApp(namespace);
    if (app) {
      // eslint-disable-next-line no-console
      console.log(
        `[bulk-import e2e] Loaded OAuth app metadata from ${oauthPersistPath(namespace)} for teardown.`,
      );
    }
  }

  if (!app) {
    // eslint-disable-next-line no-console
    console.warn(
      `[bulk-import e2e] No OAuth app metadata for namespace "${namespace}" — skip delete.`,
    );
    return;
  }

  try {
    await deleteGitHubOAuthAppViaApi(app);
    await clearPersistedApp(namespace);
  } catch (error) {
    if (error instanceof OAuthApplicationNotFoundError) {
      // eslint-disable-next-line no-console
      console.warn(
        `[bulk-import e2e] OAuth app "${app.name}" (${app.clientId}) already removed — clearing persisted metadata.`,
      );
      await clearPersistedApp(namespace);
      return;
    }
    throw error;
  } finally {
    provisionedByNamespace.delete(namespace);
  }
}
