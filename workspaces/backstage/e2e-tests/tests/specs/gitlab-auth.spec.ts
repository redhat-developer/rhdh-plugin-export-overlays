import {
  expect,
  test,
  request,
} from "@red-hat-developer-hub/e2e-test-utils/test";
import { requireEnv } from "@red-hat-developer-hub/e2e-test-utils/utils";
import { CatalogApiHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";

import { GitLabOAuthHelper } from "../../support/api/gitlab-oauth-helper.js";
import {
  GITLAB_AUTH_CATALOG_TOKEN,
  GITLAB_INGESTED_GROUPS,
  GITLAB_INGESTED_USERS,
  GITLAB_LOGIN_USER,
} from "../../support/constants/gitlab-auth.js";
import { gitlabLogin } from "../../support/gitlab/gitlab-login.js";

const APP_CONFIG_PATH = "tests/config/gitlab-auth/app-config-rhdh.yaml";

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

    await rhdh.configure({
      auth: "guest",
      appConfig: APP_CONFIG_PATH,
      secrets: "tests/config/gitlab-auth/rhdh-secrets.yaml",
      dynamicPlugins: "tests/config/gitlab-auth/dynamic-plugins.yaml",
      valueFile: "tests/config/gitlab-auth/value-file.yaml",
    });

    baseUrl = rhdh.rhdhUrl;
    const callbackUrl = `${baseUrl}/api/auth/gitlab/handler/frame`;
    const oauthApp = await oauthHelper.createOAuthApplication(
      `rhdh-overlays-gitlab-auth-${Date.now()}`,
      callbackUrl,
    );
    oauthAppId = oauthApp.id;

    // Injected into rhdh-secrets via envsubst at deploy time
    process.env.AUTH_PROVIDERS_GITLAB_CLIENT_ID = oauthApp.applicationId;
    process.env.AUTH_PROVIDERS_GITLAB_CLIENT_SECRET = oauthApp.secret;

    await rhdh.deploy();
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
    await CatalogApiHelper.dispose();
  });

  // Core static gitlab auth defaults to usernameMatchingUserEntityName
  // (authProvidersModule). Dynamic provider requires that resolver explicitly.
  test("Login with GitLab usernameMatchingUserEntityName resolver", async ({
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
    expect(login).toBe("Login successful");

    await page.goto("/settings");
    await uiHelper.verifyHeading(GITLAB_LOGIN_USER);
    await loginHelper.signOut();
  });

  test("Ingestion of GitLab users and groups", async () => {
    test.setTimeout(300_000);

    await expect
      .poll(
        () =>
          checkUserDisplayNamesInCatalog(baseUrl, [...GITLAB_INGESTED_USERS]),
        { timeout: 120_000 },
      )
      .toBe(true);

    expect(
      await checkGroupDisplayNamesInCatalog(baseUrl, [
        ...GITLAB_INGESTED_GROUPS,
      ]),
    ).toBe(true);

    expect(
      await CatalogApiHelper.getGroupMembers(
        baseUrl,
        GITLAB_AUTH_CATALOG_TOKEN,
        "all",
      ),
    ).toEqual(expect.arrayContaining(["user1", "user2", "user3", "root"]));
    expect(
      await CatalogApiHelper.getGroupMembers(
        baseUrl,
        GITLAB_AUTH_CATALOG_TOKEN,
        "group1",
      ),
    ).toEqual(expect.arrayContaining(["root"]));
    expect(
      await CatalogApiHelper.getGroupMembers(
        baseUrl,
        GITLAB_AUTH_CATALOG_TOKEN,
        "group1-nested",
      ),
    ).toEqual(expect.arrayContaining(["user1", "user2", "root"]));
    expect(
      await CatalogApiHelper.getGroupMembers(
        baseUrl,
        GITLAB_AUTH_CATALOG_TOKEN,
        "group1-nested-nested_2",
      ),
    ).toEqual(expect.arrayContaining(["user3", "root"]));

    expect(await groupHasRelation(baseUrl, "group1", "childOf", "my-org")).toBe(
      true,
    );
    expect(
      await groupHasRelation(baseUrl, "my-org", "parentOf", "group1"),
    ).toBe(true);
    expect(await groupHasRelation(baseUrl, "all", "childOf", "my-org")).toBe(
      true,
    );
    expect(await groupHasRelation(baseUrl, "my-org", "parentOf", "all")).toBe(
      true,
    );
    expect(
      await groupHasRelation(baseUrl, "group1-nested", "childOf", "group1"),
    ).toBe(true);
    expect(
      await groupHasRelation(baseUrl, "group1", "parentOf", "group1-nested"),
    ).toBe(true);
    expect(
      await groupHasRelation(
        baseUrl,
        "group1-nested-nested_2",
        "childOf",
        "group1-nested",
      ),
    ).toBe(true);
    expect(
      await groupHasRelation(
        baseUrl,
        "group1-nested",
        "parentOf",
        "group1-nested-nested_2",
      ),
    ).toBe(true);
  });
});

async function catalogQuery(
  baseUrl: string,
  filter: string,
): Promise<unknown[]> {
  const context = await request.newContext({ ignoreHTTPSErrors: true });
  try {
    const url = `${baseUrl}/api/catalog/entities/by-query?orderField=metadata.name%2Casc&filter=${encodeURIComponent(filter)}`;
    const response = await context.get(url, {
      headers: { Authorization: `Bearer ${GITLAB_AUTH_CATALOG_TOKEN}` },
    });
    if (!response.ok()) {
      throw new Error(
        `Catalog query failed (${filter}): ${response.status()} ${response.statusText()}`,
      );
    }
    const body = (await response.json()) as { items?: unknown[] };
    return body.items ?? [];
  } finally {
    await context.dispose();
  }
}

function profileDisplayName(entity: unknown): string | undefined {
  if (typeof entity !== "object" || entity === null) {
    return undefined;
  }
  const spec = (entity as { spec?: { profile?: { displayName?: unknown } } })
    .spec;
  const name = spec?.profile?.displayName;
  return typeof name === "string" ? name : undefined;
}

async function checkUserDisplayNamesInCatalog(
  baseUrl: string,
  displayNames: string[],
): Promise<boolean> {
  const users = await catalogQuery(baseUrl, "kind=user");
  const found = users
    .map(profileDisplayName)
    .filter((name): name is string => typeof name === "string");
  return displayNames.every((name) => found.includes(name));
}

async function checkGroupDisplayNamesInCatalog(
  baseUrl: string,
  displayNames: string[],
): Promise<boolean> {
  const groups = await catalogQuery(baseUrl, "kind=group");
  const found = groups
    .map(profileDisplayName)
    .filter((name): name is string => typeof name === "string");
  return displayNames.every((name) => found.includes(name));
}

async function groupHasRelation(
  baseUrl: string,
  groupName: string,
  relationType: string,
  relatedName: string,
): Promise<boolean> {
  const entity = await CatalogApiHelper.getGroupEntity(
    baseUrl,
    GITLAB_AUTH_CATALOG_TOKEN,
    groupName,
  );
  const names =
    entity.relations
      ?.filter((r: { type: string }) => r.type === relationType)
      .map((r: { targetRef: string }) => r.targetRef.split("/")[1]) ?? [];
  return names.includes(relatedName);
}
