import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import type { RHDHDeployment } from "@red-hat-developer-hub/e2e-test-utils/rhdh";
import { CatalogApiHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { KeycloakHelper } from "@red-hat-developer-hub/e2e-test-utils/keycloak";
import {
  DEFAULT_OPENLDAP_PASSWORD,
  OpenLDAPHelper,
} from "@red-hat-developer-hub/e2e-test-utils/openldap";
import { requireEnv } from "@red-hat-developer-hub/e2e-test-utils/utils";

import {
  checkGroupDisplayNamesInCatalog,
  checkUserDisplayNamesInCatalog,
  groupHasRelation,
} from "../../support/api/catalog-query-helpers.js";

const LDAP_CONFIG_DIR = "tests/config/ldap";
/** Static token from tests/config/ldap/value-file.yaml */
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
          checkUserDisplayNamesInCatalog(baseUrl, CATALOG_TOKEN, [
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
          checkGroupDisplayNamesInCatalog(baseUrl, CATALOG_TOKEN, [
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
      .poll(
        async () => {
          const members = await CatalogApiHelper.getGroupMembers(
            baseUrl,
            CATALOG_TOKEN,
            "Admins",
          );
          return members.includes("rhdh-admin");
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
            "All_Users",
          );
          return members.includes("user1") && members.includes("user2");
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
            "testsubgroup",
            "childOf",
            "testgroup",
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
            "testsubsubgroup",
            "childOf",
            "testsubgroup",
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
            "testgroup",
            "parentOf",
            "testsubgroup",
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
            "testsubgroup",
            "parentOf",
            "testsubsubgroup",
          ),
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBe(true);
  });
});
