import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import type { RHDHDeployment } from "@red-hat-developer-hub/e2e-test-utils/rhdh";
import { CatalogApiHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { KeycloakHelper } from "@red-hat-developer-hub/e2e-test-utils/keycloak";
import {
  DEFAULT_OPENLDAP_PASSWORD,
  OpenLDAPHelper,
} from "@red-hat-developer-hub/e2e-test-utils/openldap";
import { requireEnv } from "@red-hat-developer-hub/e2e-test-utils/utils";
import { request } from "@playwright/test";

const LDAP_CONFIG_DIR = "tests/config/ldap";
const CATALOG_TOKEN = "ldap-auth-e2e-token";

test.describe.configure({ mode: "serial" });

test.describe("LDAP auth provider", { tag: "@auth-tests" }, () => {
  let openldap: OpenLDAPHelper;
  let baseUrl: string;

  test.beforeAll(async ({ rhdh }: { rhdh: RHDHDeployment }) => {
    test.setTimeout(600_000);

    test.info().annotations.push({
      type: "component",
      description: "authentication",
    });

    requireEnv("KEYCLOAK_BASE_URL", "KEYCLOAK_REALM");

    openldap = new OpenLDAPHelper();
    const namespace = rhdh.deploymentConfig.namespace;

    await test.runOnce(`ldap-auth-openldap-${namespace}`, async () => {
      await openldap.deploy(namespace);
      openldap.exportEnv();

      const keycloakAdmin = new KeycloakHelper();
      await keycloakAdmin.connect({
        baseUrl: process.env.KEYCLOAK_BASE_URL!,
        username: "admin",
        password: "admin123",
      });
      await keycloakAdmin.configureLdapRealm({
        realm: "rhdh-ldap",
        ldap: {
          connectionUrl: openldap.getServiceUrl(),
          bindDn: openldap.getBindConfig().bindDn,
          bindCredential: openldap.getBindConfig().bindSecret,
          usersDn: openldap.getBindConfig().usersDn,
        },
      });
    });

    openldap.deploymentConfig.namespace = namespace;
    openldap.exportEnv();

    process.env.AUTH_KEYCLOAK_BASE_URL = process.env.KEYCLOAK_BASE_URL;
    process.env.AUTH_KEYCLOAK_CLIENT_ID = "rhdh-ldap-client";
    process.env.AUTH_KEYCLOAK_CLIENT_SECRET = "rhdh-ldap-client-secret";
    process.env.AUTH_KEYCLOAK_REALM = "rhdh-ldap";

    await test.runOnce(`ldap-auth-rhdh-config-${namespace}`, async () => {
      await rhdh.configure({
        auth: "guest",
        useNewFrontendSystem: true,
        appConfig: `${LDAP_CONFIG_DIR}/app-config-rhdh.yaml`,
        dynamicPlugins: `${LDAP_CONFIG_DIR}/dynamic-plugins.yaml`,
        secrets: `${LDAP_CONFIG_DIR}/rhdh-secrets.yaml`,
        valueFile: `${LDAP_CONFIG_DIR}/value-file.yaml`,
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

  test("Login with ldapUuidMatchingAnnotation resolver", async ({
    loginHelper,
    page,
    uiHelper,
  }) => {
    await expect(async () => {
      await loginHelper.loginAsKeycloakUser("user1", DEFAULT_OPENLDAP_PASSWORD);
    }).toPass({ timeout: 120_000, intervals: [10_000] });

    await page.goto("/settings");
    await uiHelper.waitForLoad();
    await uiHelper.verifyHeading("User 1");
    await loginHelper.signOut();
  });

  test("Ingestion of LDAP users and groups: verify entities and relationships", async () => {
    test.setTimeout(300_000);

    await expect
      .poll(
        () =>
          checkUserDisplayNamesInCatalog(baseUrl, [
            "User 1",
            "User 2",
            "User 3",
            "RHDH Admin",
          ]),
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);

    await expect
      .poll(
        () =>
          checkGroupDisplayNamesInCatalog(baseUrl, [
            "Admins",
            "All_Users",
            "testGroup",
            "testSubGroup",
            "testSubSubGroup",
            "SubAdmins",
          ]),
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);

    await expect
      .poll(() => checkUserIsInGroup(baseUrl, "rhdh-admin", "Admins"), {
        timeout: 120_000,
        intervals: [3_000],
      })
      .toBe(true);
    await expect
      .poll(() => checkUserIsInGroup(baseUrl, "user1", "All_Users"), {
        timeout: 120_000,
        intervals: [3_000],
      })
      .toBe(true);
    await expect
      .poll(() => checkUserIsInGroup(baseUrl, "user2", "All_Users"), {
        timeout: 120_000,
        intervals: [3_000],
      })
      .toBe(true);

    await expect
      .poll(
        () => checkGroupIsChildOfGroup(baseUrl, "testsubgroup", "testgroup"),
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          checkGroupIsChildOfGroup(baseUrl, "testsubsubgroup", "testsubgroup"),
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);
    await expect
      .poll(
        () => checkGroupIsParentOfGroup(baseUrl, "testgroup", "testsubgroup"),
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          checkGroupIsParentOfGroup(baseUrl, "testsubgroup", "testsubsubgroup"),
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);
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

async function checkUserIsInGroup(
  baseUrl: string,
  userName: string,
  groupName: string,
): Promise<boolean> {
  const members = await CatalogApiHelper.getGroupMembers(
    baseUrl,
    CATALOG_TOKEN,
    groupName,
  );
  return members.includes(userName);
}

async function checkGroupIsChildOfGroup(
  baseUrl: string,
  childName: string,
  parentName: string,
): Promise<boolean> {
  return groupHasRelation(baseUrl, childName, "childOf", parentName);
}

async function checkGroupIsParentOfGroup(
  baseUrl: string,
  parentName: string,
  childName: string,
): Promise<boolean> {
  return groupHasRelation(baseUrl, parentName, "parentOf", childName);
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
