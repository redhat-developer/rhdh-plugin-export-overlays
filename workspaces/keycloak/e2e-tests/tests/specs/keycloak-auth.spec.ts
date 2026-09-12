import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import type { RHDHDeployment } from "@red-hat-developer-hub/e2e-test-utils/rhdh";
import type {
  LoginHelper,
  UIhelper,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { CatalogApiHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import type { Page, BrowserContext } from "@playwright/test";
import {
  KeycloakHelper,
  type KeycloakUserConfig,
} from "@red-hat-developer-hub/e2e-test-utils/keycloak";
import fs from "node:fs";
import yaml from "js-yaml";
import {
  KEYCLOAK_AUTH_CONFIG_DIR,
  KEYCLOAK_AUTH_USERS,
  KEYCLOAK_DEFAULT_GROUPS,
  KEYCLOAK_INGESTION_INVALID,
  KEYCLOAK_REFRESH_COOKIE,
  NO_USER_FOUND_IN_CATALOG_ERROR_MESSAGE,
} from "../support/constants/keycloak-auth";
import {
  catalogEntityExists,
  checkGroupDisplayNamesInCatalog,
  checkGroupHasMembers,
  checkUserDisplayNamesInCatalog,
} from "../support/helpers/keycloak-catalog-ingestion";
import { CatalogUsersPO } from "../support/page-objects/catalog-users-obj";
import { requireEnv } from "@red-hat-developer-hub/e2e-test-utils/utils";

/**
 * Keycloak OIDC auth via community auth-backend-module-keycloak-provider.
 * Resolvers: https://github.com/backstage/community-plugins/blob/main/workspaces/keycloak/plugins/auth-backend-module-keycloak/src/resolvers.ts
 *
 * Frontend: NFS (app-next) + app-auth / app-integrations (rhdh-plugins#3183).
 */
test.describe("Keycloak auth provider", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(600_000);

  let rhdhDeployment: RHDHDeployment;
  let keycloakHelper: KeycloakHelper;
  let keycloakRealm: string;
  let baseUrl: string;

  async function clearSession(context: BrowserContext) {
    await context.clearCookies();
  }

  async function expectProfile(
    page: Page,
    uiHelper: UIhelper,
    displayName: string,
  ) {
    await page.goto("/settings");
    await uiHelper.waitForLoad();
    await expect(
      page.getByRole("heading", { name: displayName, exact: true }),
    ).toBeVisible();
  }

  function setByPath(
    config: Record<string, unknown>,
    dotPath: string,
    value: unknown,
  ) {
    const parts = dotPath.split(".").filter(Boolean);
    let current: Record<string, unknown> = config;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      const next = current[part];
      if (
        next === undefined ||
        typeof next !== "object" ||
        next === null ||
        Array.isArray(next)
      ) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]!] = value;
  }

  async function applyPatchedAppConfig(patches: Array<[string, unknown]>) {
    const appConfig = yaml.load(
      fs.readFileSync(
        `${KEYCLOAK_AUTH_CONFIG_DIR}/app-config-rhdh.yaml`,
        "utf8",
      ),
    ) as Record<string, unknown>;

    for (const [dotPath, value] of patches) {
      setByPath(appConfig, dotPath, value);
    }

    const namespace = rhdhDeployment.deploymentConfig.namespace;
    await rhdhDeployment.k8sClient.applyConfigMapFromObject(
      "app-config-rhdh",
      appConfig,
      namespace,
    );
    await rhdhDeployment.scaleDownAndRestart();
    await rhdhDeployment.waitUntilReady();
  }

  test.beforeAll(async ({ rhdh }: { rhdh: RHDHDeployment }) => {
    test.info().annotations.push({
      type: "component",
      description: "authentication",
    });

    requireEnv(
      "KEYCLOAK_BASE_URL",
      "KEYCLOAK_CLIENT_ID",
      "KEYCLOAK_CLIENT_SECRET",
      "KEYCLOAK_REALM",
      "KEYCLOAK_LOGIN_REALM",
      "VAULT_GITHUB_OAUTH_OVERLAYS_APP_ID",
      "VAULT_GITHUB_OAUTH_OVERLAYS_APP_SECRET",
    );

    process.env.AUTH_KEYCLOAK_BASE_URL = process.env.KEYCLOAK_BASE_URL;
    process.env.AUTH_KEYCLOAK_CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID;
    process.env.AUTH_KEYCLOAK_CLIENT_SECRET =
      process.env.KEYCLOAK_CLIENT_SECRET;
    process.env.AUTH_KEYCLOAK_REALM = process.env.KEYCLOAK_REALM;

    rhdhDeployment = rhdh;
    await rhdh.configure({
      auth: "guest",
      useNewFrontendSystem: true,
      appConfig: `${KEYCLOAK_AUTH_CONFIG_DIR}/app-config-rhdh.yaml`,
      dynamicPlugins: `${KEYCLOAK_AUTH_CONFIG_DIR}/dynamic-plugins.yaml`,
      secrets: `${KEYCLOAK_AUTH_CONFIG_DIR}/rhdh-secrets.yaml`,
      valueFile: `${KEYCLOAK_AUTH_CONFIG_DIR}/value-file.yaml`,
    });
    await rhdh.deploy();
    baseUrl = rhdh.rhdhUrl;

    keycloakRealm = process.env.KEYCLOAK_REALM!;
    keycloakHelper = new KeycloakHelper();
    await keycloakHelper.connect({
      baseUrl: process.env.KEYCLOAK_BASE_URL!,
      realm: keycloakRealm,
      clientId: process.env.KEYCLOAK_CLIENT_ID!,
      clientSecret: process.env.KEYCLOAK_CLIENT_SECRET!,
    });

    await test.runOnce(
      `keycloak-auth-seed-${rhdh.deploymentConfig.namespace}`,
      async () => {
        const keycloakAdmin = new KeycloakHelper();
        await keycloakAdmin.connect({
          baseUrl: process.env.KEYCLOAK_BASE_URL!,
          username: "admin",
          password: "admin123",
        });

        const mismatch = KEYCLOAK_AUTH_USERS.mismatch;
        await keycloakAdmin.createUser(keycloakRealm, {
          username: mismatch.username,
          email: mismatch.email,
          firstName: mismatch.firstName,
          lastName: mismatch.lastName,
          enabled: true,
          emailVerified: true,
          password: mismatch.password,
        });

        const { user, group } = KEYCLOAK_INGESTION_INVALID;
        await keycloakAdmin.createUser(keycloakRealm, {
          username: user.username,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          enabled: true,
          emailVerified: true,
          password: user.password,
        });
        await keycloakAdmin.createGroup(keycloakRealm, { name: group.name });
      },
    );
  });

  test.afterAll(async () => {
    await CatalogApiHelper.dispose();
  });

  test("Login with preferredUsernameMatchingUserEntityName", async ({
    page,
    uiHelper,
    loginHelper,
  }: {
    page: Page;
    uiHelper: UIhelper;
    loginHelper: LoginHelper;
  }) => {
    const { username, password, displayName } = KEYCLOAK_AUTH_USERS.test1;
    await loginHelper.loginAsKeycloakUser(username, password);
    await expectProfile(page, uiHelper, displayName);
    await page.goto("/settings");
    await uiHelper.waitForLoad();
    await loginHelper.signOut();
  });

  test("Guest provider is not offered in production", async ({
    page,
    uiHelper,
    context,
  }: {
    page: Page;
    uiHelper: UIhelper;
    context: BrowserContext;
  }) => {
    await clearSession(context);
    await page.goto("/");
    await uiHelper.waitForLoad(120_000);
    await expect(
      page.getByRole("button", { name: /enter.*guest|sign in as guest/i }),
    ).toHaveCount(0);
  });

  test("Ingestion: Keycloak users appear in catalog", async ({
    page,
    uiHelper,
    context,
    loginHelper,
  }: {
    page: Page;
    uiHelper: UIhelper;
    context: BrowserContext;
    loginHelper: LoginHelper;
  }) => {
    await clearSession(context);
    const { username, password } = KEYCLOAK_AUTH_USERS.test1;
    await loginHelper.loginAsKeycloakUser(username, password);

    await CatalogUsersPO.visitBaseURL(page);
    await uiHelper.waitForLoad();

    const keycloakUsers = await keycloakHelper.getUsers(keycloakRealm);
    expect(keycloakUsers.length).toBeGreaterThan(0);

    const backStageUsersLocator = CatalogUsersPO.getListOfUsers(page);
    await backStageUsersLocator.first().waitFor({ state: "visible" });
    const backStageUsersCount = await backStageUsersLocator.count();
    expect(backStageUsersCount).toBeGreaterThan(0);

    for (let i = 0; i < backStageUsersCount; i++) {
      const href = await backStageUsersLocator.nth(i).getAttribute("href");
      const entityName = href?.split("/").filter(Boolean).pop();
      const userFound = keycloakUsers.find(
        (user: KeycloakUserConfig) => user.username === entityName,
      );
      expect(userFound).toBeTruthy();
    }
    await page.goto("/settings");
    await uiHelper.waitForLoad();
    await loginHelper.signOut();
  });

  test("Ingestion of users and groups: verify entities and relationships", async () => {
    test.setTimeout(300_000);

    await expect
      .poll(
        () =>
          checkUserDisplayNamesInCatalog(baseUrl, [
            KEYCLOAK_AUTH_USERS.test1.displayName,
            KEYCLOAK_AUTH_USERS.test2.displayName,
          ]),
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);

    await expect
      .poll(
        () =>
          checkGroupDisplayNamesInCatalog(baseUrl, [
            ...KEYCLOAK_DEFAULT_GROUPS,
          ]),
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);

    await expect
      .poll(
        () =>
          checkGroupHasMembers(baseUrl, "developers", [
            KEYCLOAK_AUTH_USERS.test1.username,
            KEYCLOAK_AUTH_USERS.test2.username,
          ]),
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);
  });

  test("Ingestion with invalid characters: sanitize user and group name transformers", async () => {
    test.setTimeout(300_000);

    const { user, group } = KEYCLOAK_INGESTION_INVALID;

    await expect
      .poll(() => checkUserDisplayNamesInCatalog(baseUrl, [user.displayName]), {
        timeout: 120_000,
        intervals: [3_000],
      })
      .toBe(true);

    await expect
      .poll(() => checkGroupDisplayNamesInCatalog(baseUrl, [group.name]), {
        timeout: 120_000,
        intervals: [3_000],
      })
      .toBe(true);

    await expect
      .poll(
        () => catalogEntityExists(baseUrl, "user", user.catalogEntityName),
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);

    await expect
      .poll(
        () => catalogEntityExists(baseUrl, "group", group.catalogEntityName),
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);
  });

  test("Login with oidcSubClaimMatchingKeycloakUserId", async ({
    page,
    uiHelper,
    context,
    loginHelper,
  }: {
    page: Page;
    uiHelper: UIhelper;
    context: BrowserContext;
    loginHelper: LoginHelper;
  }) => {
    await applyPatchedAppConfig([
      [
        "auth.providers.keycloak.production.signIn.resolvers",
        [{ resolver: "oidcSubClaimMatchingKeycloakUserId" }],
      ],
    ]);

    await clearSession(context);
    const { username, password, displayName } = KEYCLOAK_AUTH_USERS.test1;
    await loginHelper.loginAsKeycloakUser(username, password);
    await expectProfile(page, uiHelper, displayName);
    await page.goto("/settings");
    await uiHelper.waitForLoad();
    await loginHelper.signOut();
  });

  test("Login with emailMatchingUserEntityProfileEmail", async ({
    page,
    uiHelper,
    context,
    loginHelper,
  }: {
    page: Page;
    uiHelper: UIhelper;
    context: BrowserContext;
    loginHelper: LoginHelper;
  }) => {
    await applyPatchedAppConfig([
      [
        "auth.providers.keycloak.production.signIn.resolvers",
        [{ resolver: "emailMatchingUserEntityProfileEmail" }],
      ],
    ]);

    await clearSession(context);
    const { username, password, displayName } = KEYCLOAK_AUTH_USERS.test1;
    await loginHelper.loginAsKeycloakUser(username, password);
    await expectProfile(page, uiHelper, displayName);
    await page.goto("/settings");
    await uiHelper.waitForLoad();
    await loginHelper.signOut();
  });

  test("Login with emailLocalPartMatchingUserEntityName", async ({
    page,
    uiHelper,
    context,
    loginHelper,
  }: {
    page: Page;
    uiHelper: UIhelper;
    context: BrowserContext;
    loginHelper: LoginHelper;
  }) => {
    await applyPatchedAppConfig([
      [
        "auth.providers.keycloak.production.signIn.resolvers",
        [{ resolver: "emailLocalPartMatchingUserEntityName" }],
      ],
    ]);

    await clearSession(context);
    const { username, password, displayName } = KEYCLOAK_AUTH_USERS.test1;
    await loginHelper.loginAsKeycloakUser(username, password);
    await expectProfile(page, uiHelper, displayName);
    await page.goto("/settings");
    await uiHelper.waitForLoad();
    await loginHelper.signOut();

    await clearSession(context);
    const mismatch = KEYCLOAK_AUTH_USERS.mismatch;
    // loginAsKeycloakUser() waits for nav — use logintoKeycloak when sign-in must fail.
    await page.goto("/");
    await uiHelper.waitForLoad(240_000);
    const popupPromise = page.waitForEvent("popup");
    await uiHelper.clickButton("Sign In");
    const popup = await popupPromise;
    await loginHelper.logintoKeycloak(
      popup,
      mismatch.username,
      mismatch.password,
    );
    await expect(
      page.getByRole("alertdialog").or(page.getByRole("alert")),
    ).toContainText(NO_USER_FOUND_IN_CATALOG_ERROR_MESSAGE, {
      timeout: 30_000,
    });
  });

  test("Login with emailLocalPartMatchingUserEntityName + dangerouslyAllowSignInWithoutUserInCatalog", async ({
    page,
    uiHelper,
    context,
    loginHelper,
  }: {
    page: Page;
    uiHelper: UIhelper;
    context: BrowserContext;
    loginHelper: LoginHelper;
  }) => {
    await applyPatchedAppConfig([
      [
        "auth.providers.keycloak.production.signIn.resolvers",
        [
          {
            resolver: "emailLocalPartMatchingUserEntityName",
            dangerouslyAllowSignInWithoutUserInCatalog: true,
          },
        ],
      ],
    ]);

    await clearSession(context);
    const { username, password, displayName } = KEYCLOAK_AUTH_USERS.test1;
    await loginHelper.loginAsKeycloakUser(username, password);
    await expectProfile(page, uiHelper, displayName);
    await page.goto("/settings");
    await uiHelper.waitForLoad();
    await loginHelper.signOut();

    await clearSession(context);
    const mismatch = KEYCLOAK_AUTH_USERS.mismatch;
    await loginHelper.loginAsKeycloakUser(mismatch.username, mismatch.password);
    // Fallback entity ref uses email local-part ("nomatch"), not Keycloak display name.
    await page.goto("/settings");
    await uiHelper.waitForLoad();
    await expect(page.getByText(/nomatch/i).first()).toBeVisible();
    await loginHelper.signOut();
  });

  test("Set sessionDuration and confirm auth cookie duration", async ({
    page,
    uiHelper,
    context,
    loginHelper,
  }: {
    page: Page;
    uiHelper: UIhelper;
    context: BrowserContext;
    loginHelper: LoginHelper;
  }) => {
    await applyPatchedAppConfig([
      ["auth.providers.keycloak.production.sessionDuration", "3days"],
    ]);

    await clearSession(context);
    const { username, password, displayName } = KEYCLOAK_AUTH_USERS.test1;
    await loginHelper.loginAsKeycloakUser(username, password);
    await page.reload();

    const cookies = await context.cookies();
    const authCookie = cookies.find((c) => c.name === KEYCLOAK_REFRESH_COOKIE);
    expect(authCookie).toBeDefined();

    const threeDays = 3 * 24 * 60 * 60 * 1000;
    const tolerance = 3 * 60 * 1000;
    const actualDuration = authCookie!.expires * 1000 - Date.now();
    expect(actualDuration).toBeGreaterThan(threeDays - tolerance);
    expect(actualDuration).toBeLessThan(threeDays + tolerance);

    await expectProfile(page, uiHelper, displayName);
    await page.goto("/settings");
    await uiHelper.waitForLoad();
    await loginHelper.signOut();
  });

  // Secondary GitHub auth via backstage-plugin-auth-backend-module-github-provider (app-config-rhdh.yaml).
  test("Login with Keycloak primary and GitHub as secondary", async ({
    page,
    uiHelper,
    context,
    loginHelper,
  }: {
    page: Page;
    uiHelper: UIhelper;
    context: BrowserContext;
    loginHelper: LoginHelper;
  }) => {
    requireEnv("VAULT_GH_USER_ID", "VAULT_GH_USER_PASS", "VAULT_GH_2FA_SECRET");

    try {
      await clearSession(context);
      const { username, password, displayName } = KEYCLOAK_AUTH_USERS.test1;

      await loginHelper.loginAsKeycloakUser(username, password);
      await expectProfile(page, uiHelper, displayName);

      const ghLogin = await loginHelper.githubLoginFromSettingsPage(
        process.env.VAULT_GH_USER_ID!,
        process.env.VAULT_GH_USER_PASS!,
        process.env.VAULT_GH_2FA_SECRET!,
      );
      expect(ghLogin).toBe("Login successful");
      await page.getByTitle("Sign out from GitHub").click();

      await expectProfile(page, uiHelper, displayName);
      await page.goto("/settings");
      await uiHelper.waitForLoad();
      await loginHelper.signOut();
    } finally {
      await clearSession(context);
    }
  });
});
