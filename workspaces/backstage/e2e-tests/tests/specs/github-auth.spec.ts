import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import type { RHDHDeployment } from "@red-hat-developer-hub/e2e-test-utils/rhdh";
import { $, requireEnv } from "@red-hat-developer-hub/e2e-test-utils/utils";
import type { Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { load as loadYaml } from "js-yaml";

import { CatalogApiHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import {
  checkGroupDisplayNamesInCatalog,
  checkUserDisplayNamesInCatalog,
  groupHasRelation,
  userHasAnnotation,
} from "../../support/api/catalog-query-helpers.js";
import {
  GITHUB_AUTH_CATALOG_TOKEN,
  GITHUB_CUSTOM_ANNOTATION,
  GITHUB_INGESTED_GROUPS,
  GITHUB_INGESTED_USERS,
  GITHUB_LOGIN_USERS,
  NO_USER_FOUND_IN_CATALOG_ERROR_MESSAGE,
} from "../../support/constants/github-auth.js";

/** Static token from tests/config/github-auth/value-file.yaml */
const CATALOG_TOKEN = GITHUB_AUTH_CATALOG_TOKEN;
const APP_CONFIG_PATH = "tests/config/github-auth/app-config-rhdh.yaml";
const HOMEPAGE_WRAPPER_DIST_NAME =
  "red-hat-developer-hub-backstage-plugin-homepage";

type AppConfig = Record<string, unknown>;

function setNestedProperty(
  obj: Record<string, unknown>,
  propertyPath: string,
  value: unknown,
): void {
  const parts = propertyPath.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = current[key];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

function loadAppConfigFromFile(): AppConfig {
  const raw = fs.readFileSync(path.resolve(APP_CONFIG_PATH), "utf8");
  const parsed: unknown = loadYaml(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${APP_CONFIG_PATH} did not parse as a YAML object`);
  }
  return parsed as AppConfig;
}

function getGithubResolvers(config: AppConfig): unknown {
  const auth = config.auth as
    | {
        providers?: {
          github?: {
            production?: { signIn?: { resolvers?: unknown } };
          };
        };
      }
    | undefined;
  return auth?.providers?.github?.production?.signIn?.resolvers;
}

async function readLiveAppConfig(
  rhdh: RHDHDeployment,
): Promise<AppConfig | undefined> {
  const ns = rhdh.deploymentConfig.namespace;
  const result = await $({
    stdio: ["pipe", "pipe", "pipe"],
  })`oc get configmap app-config-rhdh -n ${ns} -o json`;
  const data = (JSON.parse(result.stdout) as { data?: Record<string, string> })
    .data;
  const yamlText =
    data?.["app-config-rhdh.yaml"] ??
    data?.["app-config.yaml"] ??
    Object.values(data ?? {})[0];
  if (!yamlText) {
    return undefined;
  }
  const parsed: unknown = loadYaml(yamlText);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as AppConfig;
}

/**
 * Mid-suite app-config update (e.g. switching GitHub sign-in resolvers).
 * Uses scaleDownAndRestart, rollout status, then waitUntilReady — same restart
 * path as Helm deploy() upgrades.
 *
 * @see https://redhat-developer.github.io/rhdh-e2e-test-utils/api/deployment/rhdh-deployment.html#scaledownandrestart
 */
async function applyAppConfigAndRestart(
  rhdh: RHDHDeployment,
  appConfig: AppConfig,
): Promise<void> {
  const ns = rhdh.deploymentConfig.namespace;
  await rhdh.k8sClient.applyConfigMapFromObject(
    "app-config-rhdh",
    appConfig,
    ns,
  );
  await rhdh.scaleDownAndRestart();
  // waitUntilReady() is true while the old pod still serves; gate on rollout completion.
  await $`oc rollout status deployment/redhat-developer-hub -n ${ns} --timeout=300s`;
  await rhdh.waitUntilReady();
}

test.describe.configure({ mode: "serial" });

test.describe("GitHub auth and org ingestion", { tag: "@auth-tests" }, () => {
  let rhdhDeployment: RHDHDeployment;
  let baseUrl: string;

  test.beforeAll(async ({ rhdh }) => {
    test.setTimeout(600_000);

    test.info().annotations.push({
      type: "component",
      description: "authentication",
    });

    requireEnv(
      "VAULT_AUTH_PROVIDERS_GH_ORG_NAME",
      "VAULT_AUTH_PROVIDERS_GH_ORG_CLIENT_ID",
      "VAULT_AUTH_PROVIDERS_GH_ORG_CLIENT_SECRET",
      "VAULT_AUTH_PROVIDERS_GH_ORG_APP_ID",
      "VAULT_AUTH_PROVIDERS_GH_ORG1_PRIVATE_KEY",
      "VAULT_AUTH_PROVIDERS_GH_ORG_WEBHOOK_SECRET",
      "VAULT_AUTH_PROVIDERS_GH_USER_PASSWORD",
      "VAULT_AUTH_PROVIDERS_GH_USER_2FA",
      "VAULT_AUTH_PROVIDERS_GH_ADMIN_2FA",
    );

    rhdhDeployment = rhdh;
    const namespace = rhdh.deploymentConfig.namespace;

    await test.runOnce(`github-auth-setup-${namespace}`, async () => {
      await rhdh.configure({
        auth: "guest",
        appConfig: APP_CONFIG_PATH,
        secrets: "tests/config/github-auth/rhdh-secrets.yaml",
        dynamicPlugins: "tests/config/github-auth/dynamic-plugins.yaml",
        valueFile: "tests/config/github-auth/value-file.yaml",
        disablePlugins: [HOMEPAGE_WRAPPER_DIST_NAME],
      });
    });

    await rhdh.deploy();
    baseUrl = rhdh.rhdhUrl;
  });

  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
  });

  test.afterAll(async () => {
    await CatalogApiHelper.dispose();
  });

  async function setGithubResolver(
    resolver: string,
    dangerouslyAllowSignInWithoutUserInCatalog = false,
  ): Promise<void> {
    const config = loadAppConfigFromFile();
    const desiredResolvers = [
      { resolver, dangerouslyAllowSignInWithoutUserInCatalog },
    ];
    setNestedProperty(
      config,
      "auth.providers.github.production.signIn.resolvers",
      desiredResolvers,
    );
    // Drop disableIdentityResolution when restoring normal sign-in.
    const githubProduction = (
      config.auth as {
        providers?: { github?: { production?: Record<string, unknown> } };
      }
    )?.providers?.github?.production;
    if (githubProduction) {
      delete githubProduction.disableIdentityResolution;
    }

    const liveConfig = await readLiveAppConfig(rhdhDeployment);
    if (
      liveConfig &&
      JSON.stringify(getGithubResolvers(liveConfig)) ===
        JSON.stringify(desiredResolvers) &&
      !(
        liveConfig.auth as {
          providers?: {
            github?: { production?: { disableIdentityResolution?: unknown } };
          };
        }
      )?.providers?.github?.production?.disableIdentityResolution
    ) {
      return;
    }

    await applyAppConfigAndRestart(rhdhDeployment, config);
  }

  async function setDisableIdentityResolution(): Promise<void> {
    const config = loadAppConfigFromFile();
    setNestedProperty(
      config,
      "auth.providers.github.production.disableIdentityResolution",
      "true",
    );
    await applyAppConfigAndRestart(rhdhDeployment, config);
  }

  /**
   * Sign-in page discovery configs (RHDHPLAN-935 / rhdh-plugins#4716).
   * Starts from the checked-in github-auth app-config, then adjusts signInPage
   * and which keys appear under auth.providers.
   */
  async function applySignInDiscoveryConfig(options: {
    /** Omit to keep file value; `null` deletes signInPage (auto-discovery). */
    signInPage?: string | string[] | null;
    /** Which auth.providers keys to keep. */
    providers: "github-only" | "github-and-guest" | "empty";
  }): Promise<void> {
    const config = loadAppConfigFromFile();
    const auth = config.auth as {
      environment?: string;
      providers?: Record<string, unknown>;
    };

    if (options.signInPage === null) {
      delete config.signInPage;
    } else if (options.signInPage !== undefined) {
      config.signInPage = options.signInPage;
    }

    const fileProviders = (auth.providers ?? {}) as Record<string, unknown>;
    if (options.providers === "empty") {
      auth.providers = {};
    } else if (options.providers === "github-only") {
      auth.providers = { github: fileProviders.github };
    } else {
      auth.providers = {
        guest: fileProviders.guest,
        github: fileProviders.github,
      };
    }
    config.auth = auth;

    await applyAppConfigAndRestart(rhdhDeployment, config);
  }

  async function openSignInPage(page: Page): Promise<void> {
    await page.context().clearCookies();
    await page.goto("/");
  }

  const guestSignInButton = (page: Page) =>
    page.getByRole("button", { name: /^Enter$/ });

  const githubSignInMessage = (page: Page) =>
    page.locator('p:has-text("Sign in using GitHub")');

  test("Ingestion of GitHub users and groups", async () => {
    test.setTimeout(300_000);

    await expect
      .poll(
        () =>
          checkUserDisplayNamesInCatalog(baseUrl, CATALOG_TOKEN, [
            ...GITHUB_INGESTED_USERS,
          ]),
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);

    await expect
      .poll(
        () =>
          checkGroupDisplayNamesInCatalog(baseUrl, CATALOG_TOKEN, [
            ...GITHUB_INGESTED_GROUPS,
          ]),
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);

    await expect
      .poll(
        async () => {
          const members = await CatalogApiHelper.getGroupMembers(
            baseUrl,
            CATALOG_TOKEN,
            "test_admins",
          );
          return members.includes(GITHUB_LOGIN_USERS.admin);
        },
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);

    await expect
      .poll(
        async () => {
          const members = await CatalogApiHelper.getGroupMembers(
            baseUrl,
            CATALOG_TOKEN,
            "test_users",
          );
          return members.includes(GITHUB_LOGIN_USERS.user);
        },
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);

    await expect
      .poll(
        () =>
          groupHasRelation(
            baseUrl,
            CATALOG_TOKEN,
            "test_users",
            "childOf",
            "test_all",
          ),
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          groupHasRelation(
            baseUrl,
            CATALOG_TOKEN,
            "test_admins",
            "childOf",
            "test_all",
          ),
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);

    await expect
      .poll(
        () =>
          userHasAnnotation(
            baseUrl,
            CATALOG_TOKEN,
            GITHUB_LOGIN_USERS.admin,
            GITHUB_CUSTOM_ANNOTATION,
            GITHUB_LOGIN_USERS.admin,
          ),
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          userHasAnnotation(
            baseUrl,
            CATALOG_TOKEN,
            GITHUB_LOGIN_USERS.user,
            GITHUB_CUSTOM_ANNOTATION,
            GITHUB_LOGIN_USERS.user,
          ),
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);
  });

  test("Login with GitHub default resolver", async ({
    loginHelper,
    uiHelper,
    page,
  }) => {
    test.setTimeout(600_000);

    await setGithubResolver("userIdMatchingUserEntityAnnotation", false);

    const login = await loginHelper.githubLogin(
      GITHUB_LOGIN_USERS.admin,
      process.env.VAULT_AUTH_PROVIDERS_GH_USER_PASSWORD!,
      process.env.VAULT_AUTH_PROVIDERS_GH_ADMIN_2FA!,
    );
    expect(login).toBe("Login successful");

    await page.goto("/settings");
    await uiHelper.verifyHeading("RHDH QE Admin");
    await loginHelper.signOut();
  });

  test("Login with GitHub usernameMatchingUserEntityName resolver", async ({
    loginHelper,
    uiHelper,
    page,
  }) => {
    test.setTimeout(600_000);

    await setGithubResolver("usernameMatchingUserEntityName", false);

    const login = await loginHelper.githubLogin(
      GITHUB_LOGIN_USERS.admin,
      process.env.VAULT_AUTH_PROVIDERS_GH_USER_PASSWORD!,
      process.env.VAULT_AUTH_PROVIDERS_GH_ADMIN_2FA!,
    );
    expect(login).toBe("Login successful");

    await page.goto("/settings");
    await uiHelper.verifyHeading("RHDH QE Admin");
    await loginHelper.signOut();
  });

  test("Login with GitHub emailMatchingUserEntityProfileEmail resolver", async ({
    loginHelper,
    uiHelper,
  }) => {
    test.setTimeout(600_000);

    await setGithubResolver("emailMatchingUserEntityProfileEmail", false);

    const login = await loginHelper.githubLogin(
      GITHUB_LOGIN_USERS.user,
      process.env.VAULT_AUTH_PROVIDERS_GH_USER_PASSWORD!,
      process.env.VAULT_AUTH_PROVIDERS_GH_USER_2FA!,
    );
    expect(login).toBe("Login successful");

    await uiHelper.verifyAlertErrorMessage(
      NO_USER_FOUND_IN_CATALOG_ERROR_MESSAGE,
    );
  });

  test("Login with GitHub emailLocalPartMatchingUserEntityName resolver", async ({
    loginHelper,
    uiHelper,
  }) => {
    test.setTimeout(600_000);

    await setGithubResolver("emailLocalPartMatchingUserEntityName", false);

    const login = await loginHelper.githubLogin(
      GITHUB_LOGIN_USERS.user,
      process.env.VAULT_AUTH_PROVIDERS_GH_USER_PASSWORD!,
      process.env.VAULT_AUTH_PROVIDERS_GH_USER_2FA!,
    );
    expect(login).toBe("Login successful");

    await uiHelper.verifyAlertErrorMessage(
      NO_USER_FOUND_IN_CATALOG_ERROR_MESSAGE,
    );
  });

  test("Confirm GitHub sessionDuration via auth cookie", async ({
    loginHelper,
    uiHelper,
    page,
  }) => {
    test.setTimeout(600_000);

    // sessionDuration: 3days is set in app-config (retained across resolver updates).
    await setGithubResolver("userIdMatchingUserEntityAnnotation", false);

    const login = await loginHelper.githubLogin(
      GITHUB_LOGIN_USERS.admin,
      process.env.VAULT_AUTH_PROVIDERS_GH_USER_PASSWORD!,
      process.env.VAULT_AUTH_PROVIDERS_GH_ADMIN_2FA!,
    );
    expect(login).toBe("Login successful");

    await page.reload();

    const cookies = await page.context().cookies();
    const authCookie = cookies.find(
      (cookie) => cookie.name === "github-refresh-token",
    );
    expect(authCookie).toBeDefined();

    const threeDays = 3 * 24 * 60 * 60 * 1000;
    const tolerance = 3 * 60 * 1000;
    const actualDuration = authCookie!.expires * 1000 - Date.now();

    expect(actualDuration).toBeGreaterThan(threeDays - tolerance);
    expect(actualDuration).toBeLessThan(threeDays + tolerance);

    await page.goto("/settings");
    await uiHelper.verifyHeading("RHDH QE Admin");
    await loginHelper.signOut();
  });

  test("Login with GitHub disableIdentityResolution should fail", async ({
    loginHelper,
    uiHelper,
  }) => {
    test.setTimeout(600_000);

    await setDisableIdentityResolution();

    const login = await loginHelper.githubLogin(
      GITHUB_LOGIN_USERS.user,
      process.env.VAULT_AUTH_PROVIDERS_GH_USER_PASSWORD!,
      process.env.VAULT_AUTH_PROVIDERS_GH_USER_2FA!,
    );
    expect(login).toBe("Login successful");

    await uiHelper.verifyAlertErrorMessage(
      /Login failed; caused by Error: The GitHub provider is not configured to support sign-in/u,
    );
  });

  /**
   * Sign-in page: automatic discovery from auth.providers (RHDHPLAN-935).
   * Requires app-auth >= 1.2.0 (no DEFAULT_PROVIDER GitHub fallback; ErrorPanel
   * when no providers resolve — rhdh-plugins#4716).
   */
  test.describe("Sign-in page discovery from auth.providers", () => {
    test("discovers GitHub from auth.providers when signInPage is unset", async ({
      page,
      uiHelper,
    }) => {
      test.setTimeout(600_000);

      await applySignInDiscoveryConfig({
        signInPage: null,
        providers: "github-only",
      });

      await openSignInPage(page);
      await uiHelper.waitForLoad(120_000);

      await expect(githubSignInMessage(page)).toBeVisible();
      await expect(guestSignInButton(page)).toHaveCount(0);
      await expect(
        page.getByText("No authentication providers are configured"),
      ).toHaveCount(0);
    });

    test("shows ErrorPanel when no auth.providers are configured", async ({
      page,
      uiHelper,
    }) => {
      test.setTimeout(600_000);

      await applySignInDiscoveryConfig({
        signInPage: null,
        providers: "empty",
      });

      await openSignInPage(page);
      await uiHelper.waitForLoad(120_000);

      await expect(page.getByText("Sign-in is not available")).toBeVisible();
      await expect(
        page.getByText("No authentication providers are configured"),
      ).toBeVisible();
      await expect(githubSignInMessage(page)).toHaveCount(0);
      await expect(guestSignInButton(page)).toHaveCount(0);
    });

    test("offers every auth.providers key when signInPage is unset", async ({
      page,
      uiHelper,
    }) => {
      test.setTimeout(600_000);

      await applySignInDiscoveryConfig({
        signInPage: null,
        providers: "github-and-guest",
      });

      await openSignInPage(page);
      await uiHelper.waitForLoad(120_000);

      await expect(githubSignInMessage(page)).toBeVisible();
      await expect(guestSignInButton(page)).toBeVisible();
    });

    test("signInPage pins login providers and hides secondary auth.providers", async ({
      page,
      uiHelper,
    }) => {
      test.setTimeout(600_000);

      // guest remains under auth.providers (auxiliary); signInPage pins GitHub only.
      await applySignInDiscoveryConfig({
        signInPage: "github",
        providers: "github-and-guest",
      });

      await openSignInPage(page);
      await uiHelper.waitForLoad(120_000);

      await expect(githubSignInMessage(page)).toBeVisible();
      await expect(guestSignInButton(page)).toHaveCount(0);
    });
  });
});
