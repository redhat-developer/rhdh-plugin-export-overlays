import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import type { RHDHDeployment } from "@red-hat-developer-hub/e2e-test-utils/rhdh";
import { $, requireEnv } from "@red-hat-developer-hub/e2e-test-utils/utils";
import { request } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { load as loadYaml } from "js-yaml";

import { CatalogApiHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { MSClient } from "../../support/api/msgraph-helper.js";
import {
  MICROSOFT_TEST_USERS,
  NO_USER_FOUND_IN_CATALOG_ERROR_MESSAGE,
} from "../../support/constants/microsoft.js";

/** Static token from tests/config/microsoft/value-file.yaml */
const CATALOG_TOKEN = "microsoft-e2e-token";
const APP_CONFIG_PATH = "tests/config/microsoft/app-config-rhdh.yaml";
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

function getMicrosoftResolvers(config: AppConfig): unknown {
  const auth = config.auth as
    | {
        providers?: {
          microsoft?: {
            production?: { signIn?: { resolvers?: unknown } };
          };
        };
      }
    | undefined;
  return auth?.providers?.microsoft?.production?.signIn?.resolvers;
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
 * Mid-suite app-config update (e.g. switching Microsoft sign-in resolvers).
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

test.describe(
  "Microsoft auth and MS Graph ingestion",
  { tag: "@auth-tests" },
  () => {
    let rhdhDeployment: RHDHDeployment;
    let baseUrl: string;
    let redirectUrl: string;
    let graphClient: MSClient;

    test.beforeAll(async ({ rhdh }) => {
      test.setTimeout(600_000);

      requireEnv("VAULT_DEFAULT_USER_PASSWORD_2");
      requireEnv("VAULT_AUTH_PROVIDERS_AZURE_CLIENT_ID");
      requireEnv("VAULT_AUTH_PROVIDERS_AZURE_CLIENT_SECRET");
      requireEnv("VAULT_AUTH_PROVIDERS_AZURE_TENANT_ID");

      rhdhDeployment = rhdh;

      graphClient = new MSClient(
        process.env.VAULT_AUTH_PROVIDERS_AZURE_CLIENT_ID!,
        process.env.VAULT_AUTH_PROVIDERS_AZURE_CLIENT_SECRET!,
        process.env.VAULT_AUTH_PROVIDERS_AZURE_TENANT_ID!,
      );

      await test.runOnce("microsoft-auth-setup", async () => {
        await rhdh.configure({
          auth: "guest",
          appConfig: APP_CONFIG_PATH,
          secrets: "tests/config/microsoft/rhdh-secrets.yaml",
          dynamicPlugins: "tests/config/microsoft/dynamic-plugins.yaml",
          valueFile: "tests/config/microsoft/value-file.yaml",
          disablePlugins: [HOMEPAGE_WRAPPER_DIST_NAME],
        });
      });

      redirectUrl = `${rhdh.rhdhUrl}/api/auth/microsoft/handler/frame`;
      await graphClient.addAppRedirectUrlsAsync([redirectUrl]);
      await rhdh.deploy();

      baseUrl = rhdh.rhdhUrl;
    });

    test.beforeEach(async ({ page }) => {
      await page.context().clearCookies();
    });

    test.afterAll(async () => {
      if (redirectUrl) {
        try {
          await graphClient.removeAppRedirectUrlsAsync([redirectUrl]);
        } catch (error) {
          console.error(
            "[TEST] Failed to cleanup Microsoft Azure App Registration:",
            error,
          );
        }
      }
      await CatalogApiHelper.dispose();
    });

    async function setMicrosoftResolver(
      resolver: string,
      dangerouslyAllowSignInWithoutUserInCatalog = false,
    ): Promise<void> {
      const config = loadAppConfigFromFile();
      const desiredResolvers = [
        { resolver, dangerouslyAllowSignInWithoutUserInCatalog },
      ];
      setNestedProperty(
        config,
        "auth.providers.microsoft.production.signIn.resolvers",
        desiredResolvers,
      );

      const liveConfig = await readLiveAppConfig(rhdhDeployment);
      if (
        liveConfig &&
        JSON.stringify(getMicrosoftResolvers(liveConfig)) ===
          JSON.stringify(desiredResolvers)
      ) {
        return;
      }

      await applyAppConfigAndRestart(rhdhDeployment, config);
    }

    test("Ingestion of Microsoft users and groups", async () => {
      test.setTimeout(300_000);

      await expect
        .poll(
          () =>
            checkUserDisplayNamesInCatalog(baseUrl, [
              "TEST Admin",
              "TEST Atena",
              "TEST Elio",
              "TEST Tyke",
              "TEST Zeus",
            ]),
          { timeout: 120_000, intervals: [3_000] },
        )
        .toBe(true);

      await expect
        .poll(
          () =>
            checkGroupDisplayNamesInCatalog(baseUrl, [
              "TEST_admins",
              "TEST_goddesses",
              "TEST_gods",
              "TEST_all",
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
              "TEST_admins",
            );
            return (
              members.includes("admin_rhdhtesting.onmicrosoft.com") &&
              members.includes("zeus_rhdhtesting.onmicrosoft.com")
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
              CATALOG_TOKEN,
              "TEST_goddesses",
            );
            return (
              members.includes("atena_rhdhtesting.onmicrosoft.com") &&
              members.includes("tiche_rhdhtesting.onmicrosoft.com")
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
              CATALOG_TOKEN,
              "TEST_gods",
            );
            return (
              members.includes("elio_rhdhtesting.onmicrosoft.com") &&
              members.includes("zeus_rhdhtesting.onmicrosoft.com")
            );
          },
          { timeout: 120_000, intervals: [3_000] },
        )
        .toBe(true);

      await expect
        .poll(
          () => groupHasRelation(baseUrl, "test_gods", "childOf", "test_all"),
          { timeout: 120_000, intervals: [3_000] },
        )
        .toBe(true);
      await expect
        .poll(
          () =>
            groupHasRelation(baseUrl, "test_goddesses", "childOf", "test_all"),
          { timeout: 120_000, intervals: [3_000] },
        )
        .toBe(true);
      await expect
        .poll(
          () => groupHasRelation(baseUrl, "test_all", "parentOf", "test_gods"),
          { timeout: 120_000, intervals: [3_000] },
        )
        .toBe(true);
      await expect
        .poll(
          () =>
            groupHasRelation(baseUrl, "test_all", "parentOf", "test_goddesses"),
          { timeout: 120_000, intervals: [3_000] },
        )
        .toBe(true);
    });

    // Upstream microsoft auth provider: omitting signIn.resolvers disables
    // identity resolution (no implicit default). Always set a resolver explicitly.
    test("Login with Microsoft userIdMatchingUserEntityAnnotation resolver", async ({
      loginHelper,
      uiHelper,
      page,
    }) => {
      test.setTimeout(600_000);

      await setMicrosoftResolver("userIdMatchingUserEntityAnnotation", false);

      const login = await loginHelper.microsoftAzureLogin(
        MICROSOFT_TEST_USERS.zeus,
        process.env.VAULT_DEFAULT_USER_PASSWORD_2!,
      );
      expect(login).toBe("Login successful");

      await page.goto("/settings");
      await uiHelper.verifyHeading("TEST Zeus");
      await loginHelper.signOut();
    });

    test("Login with Microsoft emailMatchingUserEntityAnnotation resolver", async ({
      loginHelper,
      uiHelper,
      page,
    }) => {
      test.setTimeout(600_000);

      await setMicrosoftResolver("emailMatchingUserEntityAnnotation", false);

      const login = await loginHelper.microsoftAzureLogin(
        MICROSOFT_TEST_USERS.zeus,
        process.env.VAULT_DEFAULT_USER_PASSWORD_2!,
      );
      expect(login).toBe("Login successful");

      await page.goto("/settings");
      await uiHelper.verifyHeading("TEST Zeus");
      await loginHelper.signOut();
      await page.context().clearCookies();

      // Atena has no email annotation — expect catalog resolution failure.
      const login2 = await loginHelper.microsoftAzureLogin(
        MICROSOFT_TEST_USERS.atena,
        process.env.VAULT_DEFAULT_USER_PASSWORD_2!,
      );
      expect(login2).toBe("Login successful");
      await uiHelper.verifyAlertErrorMessage(
        NO_USER_FOUND_IN_CATALOG_ERROR_MESSAGE,
      );
    });

    test("Login with Microsoft emailMatchingUserEntityProfileEmail resolver", async ({
      loginHelper,
      uiHelper,
      page,
    }) => {
      test.setTimeout(600_000);

      await setMicrosoftResolver("emailMatchingUserEntityProfileEmail", false);

      const login = await loginHelper.microsoftAzureLogin(
        MICROSOFT_TEST_USERS.zeus,
        process.env.VAULT_DEFAULT_USER_PASSWORD_2!,
      );
      expect(login).toBe("Login successful");

      await page.goto("/settings");
      await uiHelper.verifyHeading("TEST Zeus");
      await loginHelper.signOut();
    });

    // Entity name is "zeus_rhdhtesting.onmicrosoft.com"; email local-part does not match.
    test.fixme("Login with Microsoft emailLocalPartMatchingUserEntityName resolver", async ({
      loginHelper,
      uiHelper,
      page,
    }) => {
      test.setTimeout(600_000);

      await setMicrosoftResolver("emailLocalPartMatchingUserEntityName", false);

      const login = await loginHelper.microsoftAzureLogin(
        MICROSOFT_TEST_USERS.zeus,
        process.env.VAULT_DEFAULT_USER_PASSWORD_2!,
      );
      expect(login).toBe("Login successful");

      await page.goto("/settings");
      await uiHelper.verifyHeading("TEST Zeus");
      await loginHelper.signOut();
      await page.context().clearCookies();

      const login2 = await loginHelper.microsoftAzureLogin(
        MICROSOFT_TEST_USERS.tyke,
        process.env.VAULT_DEFAULT_USER_PASSWORD_2!,
      );
      expect(login2).toBe("Login successful");
      await uiHelper.verifyAlertErrorMessage(
        NO_USER_FOUND_IN_CATALOG_ERROR_MESSAGE,
      );
    });

    test("Confirm Microsoft sessionDuration via auth cookie", async ({
      loginHelper,
      uiHelper,
      page,
    }) => {
      test.setTimeout(600_000);

      // sessionDuration: 3days is set in app-config (and retained across resolver updates).
      await setMicrosoftResolver("userIdMatchingUserEntityAnnotation", false);

      const login = await loginHelper.microsoftAzureLogin(
        MICROSOFT_TEST_USERS.zeus,
        process.env.VAULT_DEFAULT_USER_PASSWORD_2!,
      );
      expect(login).toBe("Login successful");

      await page.reload();

      const cookies = await page.context().cookies();
      const authCookie = cookies.find(
        (cookie) => cookie.name === "microsoft-refresh-token",
      );
      expect(authCookie).toBeDefined();

      const threeDays = 3 * 24 * 60 * 60 * 1000;
      const tolerance = 3 * 60 * 1000;
      const actualDuration = authCookie!.expires * 1000 - Date.now();

      expect(actualDuration).toBeGreaterThan(threeDays - tolerance);
      expect(actualDuration).toBeLessThan(threeDays + tolerance);

      await page.goto("/settings");
      await uiHelper.verifyHeading("TEST Zeus");
      await loginHelper.signOut();
    });
  },
);

async function catalogQuery(
  baseUrl: string,
  filter: string,
): Promise<unknown[]> {
  const context = await request.newContext({ ignoreHTTPSErrors: true });
  try {
    const url = `${baseUrl}/api/catalog/entities/by-query?orderField=metadata.name%2Casc&filter=${encodeURIComponent(filter)}`;
    const response = await context.get(url, {
      headers: { Authorization: `Bearer ${CATALOG_TOKEN}` },
    });
    if (!response.ok()) {
      return [];
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
    CATALOG_TOKEN,
    groupName,
  );
  const names =
    entity.relations
      ?.filter((r: { type: string }) => r.type === relationType)
      .map((r: { targetRef: string }) => r.targetRef.split("/")[1]) ?? [];
  return names.includes(relatedName);
}
