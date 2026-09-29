import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { requireEnv } from "@red-hat-developer-hub/e2e-test-utils/utils";
import { CatalogApiHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";

import {
  checkGroupDisplayNamesInCatalog,
  checkUserDisplayNamesInCatalog,
  groupHasRelation,
} from "../../support/api/catalog-query-helpers.js";
import { GitLabOAuthHelper } from "../../support/api/gitlab-oauth-helper.js";
import {
  GITLAB_AUTH_CATALOG_TOKEN,
  GITLAB_INGESTED_GROUPS,
  GITLAB_INGESTED_USERS,
  GITLAB_LOGIN_USER,
} from "../../support/constants/gitlab-auth.js";
import { gitlabLogin } from "../../support/gitlab/gitlab-login.js";

const APP_CONFIG_PATH = "tests/config/gitlab-auth/app-config-rhdh.yaml";
const HOMEPAGE_WRAPPER_DIST_NAME =
  "red-hat-developer-hub-backstage-plugin-homepage";

test.describe.configure({ mode: "serial" });

test.describe("GitLab auth and org ingestion", { tag: "@auth-tests" }, () => {
  let baseUrl: string;
  let oauthHelper: GitLabOAuthHelper;
  let oauthAppId: number | null = null;

  test.beforeAll(async ({ rhdh }) => {
    test.setTimeout(600_000);

    requireEnv(
      "VAULT_AUTH_PROVIDERS_GITLAB_HOST",
      "VAULT_AUTH_PROVIDERS_GITLAB_TOKEN",
      "VAULT_AUTH_PROVIDERS_GITLAB_PARENT_ORG",
      "VAULT_DEFAULT_USER_PASSWORD",
    );

    const host = process.env.VAULT_AUTH_PROVIDERS_GITLAB_HOST!;
    const token = process.env.VAULT_AUTH_PROVIDERS_GITLAB_TOKEN!;

    oauthHelper = new GitLabOAuthHelper(host, token);

    await test.runOnce(
      `gitlab-auth-setup-${rhdh.deploymentConfig.namespace}`,
      async () => {
        await rhdh.configure({
          auth: "guest",
          appConfig: APP_CONFIG_PATH,
          secrets: "tests/config/gitlab-auth/rhdh-secrets.yaml",
          dynamicPlugins: "tests/config/gitlab-auth/dynamic-plugins.yaml",
          valueFile: "tests/config/gitlab-auth/value-file.yaml",
          disablePlugins: [HOMEPAGE_WRAPPER_DIST_NAME],
        });
      },
    );

    if (oauthAppId !== null) {
      await oauthHelper.deleteOAuthApplication(oauthAppId);
      oauthAppId = null;
    }

    const callbackUrl = `${rhdh.rhdhUrl}/api/auth/gitlab/handler/frame`;
    const oauthApp = await oauthHelper.createOAuthApplication(
      `rhdh-overlays-gitlab-auth-${Date.now()}`,
      callbackUrl,
    );
    oauthAppId = oauthApp.id;

    // Injected into rhdh-secrets via envsubst at deploy time
    process.env.AUTH_PROVIDERS_GITLAB_CLIENT_ID = oauthApp.applicationId;
    process.env.AUTH_PROVIDERS_GITLAB_CLIENT_SECRET = oauthApp.secret;

    await rhdh.deploy();

    baseUrl = rhdh.rhdhUrl;
  });

  test.beforeEach(async ({ page }) => {
    await page.context().clearCookies();
  });

  test.afterAll(async () => {
    if (oauthAppId !== null) {
      try {
        await oauthHelper.deleteOAuthApplication(oauthAppId);
      } catch (error) {
        console.error(
          "[TEST] Failed to delete GitLab OAuth application:",
          error,
        );
      }
    }

    await oauthHelper.dispose();
    await CatalogApiHelper.dispose();
  });

  test("Ingestion of GitLab users and groups", async () => {
    test.setTimeout(300_000);

    await expect
      .poll(
        () =>
          checkUserDisplayNamesInCatalog(baseUrl, GITLAB_AUTH_CATALOG_TOKEN, [
            ...GITLAB_INGESTED_USERS,
          ]),
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);

    await expect
      .poll(
        () =>
          checkGroupDisplayNamesInCatalog(baseUrl, GITLAB_AUTH_CATALOG_TOKEN, [
            ...GITLAB_INGESTED_GROUPS,
          ]),
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);

    await expect
      .poll(
        async () => {
          const members = await CatalogApiHelper.getGroupMembers(
            baseUrl,
            GITLAB_AUTH_CATALOG_TOKEN,
            "all",
          );
          return (
            members.includes("user1") &&
            members.includes("user2") &&
            members.includes("user3") &&
            members.includes("root")
          );
        },
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);

    await expect
      .poll(
        async () => {
          const members = await CatalogApiHelper.getGroupMembers(
            baseUrl,
            GITLAB_AUTH_CATALOG_TOKEN,
            "group1",
          );
          return members.includes("root");
        },
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);

    await expect
      .poll(
        async () => {
          const members = await CatalogApiHelper.getGroupMembers(
            baseUrl,
            GITLAB_AUTH_CATALOG_TOKEN,
            "group1-nested",
          );
          return (
            members.includes("user1") &&
            members.includes("user2") &&
            members.includes("root")
          );
        },
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);

    await expect
      .poll(
        async () => {
          const members = await CatalogApiHelper.getGroupMembers(
            baseUrl,
            GITLAB_AUTH_CATALOG_TOKEN,
            "group1-nested-nested_2",
          );
          return members.includes("user3") && members.includes("root");
        },
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);

    await expect
      .poll(
        () =>
          groupHasRelation(
            baseUrl,
            GITLAB_AUTH_CATALOG_TOKEN,
            "group1",
            "childOf",
            "my-org",
          ),
        {
          timeout: 120_000,
          intervals: [3_000],
        },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          groupHasRelation(
            baseUrl,
            GITLAB_AUTH_CATALOG_TOKEN,
            "my-org",
            "parentOf",
            "group1",
          ),
        {
          timeout: 120_000,
          intervals: [3_000],
        },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          groupHasRelation(
            baseUrl,
            GITLAB_AUTH_CATALOG_TOKEN,
            "all",
            "childOf",
            "my-org",
          ),
        {
          timeout: 120_000,
          intervals: [3_000],
        },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          groupHasRelation(
            baseUrl,
            GITLAB_AUTH_CATALOG_TOKEN,
            "my-org",
            "parentOf",
            "all",
          ),
        {
          timeout: 120_000,
          intervals: [3_000],
        },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          groupHasRelation(
            baseUrl,
            GITLAB_AUTH_CATALOG_TOKEN,
            "group1-nested",
            "childOf",
            "group1",
          ),
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          groupHasRelation(
            baseUrl,
            GITLAB_AUTH_CATALOG_TOKEN,
            "group1",
            "parentOf",
            "group1-nested",
          ),
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          groupHasRelation(
            baseUrl,
            GITLAB_AUTH_CATALOG_TOKEN,
            "group1-nested-nested_2",
            "childOf",
            "group1-nested",
          ),
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          groupHasRelation(
            baseUrl,
            GITLAB_AUTH_CATALOG_TOKEN,
            "group1-nested",
            "parentOf",
            "group1-nested-nested_2",
          ),
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);
  });

  test("Login with GitLab userIdMatchingUserEntityAnnotation resolver", async ({
    loginHelper,
    uiHelper,
    page,
  }) => {
    test.setTimeout(600_000);

    const login = await gitlabLogin(
      page,
      uiHelper,
      GITLAB_LOGIN_USER,
      process.env.VAULT_DEFAULT_USER_PASSWORD!,
    );
    expect(["Login successful", "Already logged in"]).toContain(login);

    await page.goto("/settings");
    await uiHelper.verifyHeading(GITLAB_LOGIN_USER);
    await loginHelper.signOut();
  });
});
