import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import type { RHDHDeployment } from "@red-hat-developer-hub/e2e-test-utils/rhdh";
import type {
  LoginHelper,
  UIhelper,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";
import type { Page, BrowserContext } from "@playwright/test";
import { KeycloakHelper } from "@red-hat-developer-hub/e2e-test-utils/keycloak";
import {
  OpenLDAPHelper,
  DEFAULT_OPENLDAP_PASSWORD,
} from "@red-hat-developer-hub/e2e-test-utils/openldap";
import { KEYCLOAK_AUTH_CONFIG_DIR } from "../support/constants/keycloak-auth";
import { requireEnv } from "@red-hat-developer-hub/e2e-test-utils/utils";

/**
 * LDAP auth via ldapUuidMatchingAnnotation — isolated project for parallel runs.
 */
test.describe("Keycloak LDAP auth provider", () => {
  test.setTimeout(600_000);

  let openldap: OpenLDAPHelper;

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

  test.beforeAll(async ({ rhdh }: { rhdh: RHDHDeployment }) => {
    test.info().annotations.push({
      type: "component",
      description: "authentication",
    });

    requireEnv("KEYCLOAK_BASE_URL", "KEYCLOAK_REALM");

    openldap = new OpenLDAPHelper();
    const namespace = rhdh.deploymentConfig.namespace;

    await test.runOnce(`keycloak-auth-ldap-openldap-${namespace}`, async () => {
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

    await rhdh.configure({
      auth: "guest",
      useNewFrontendSystem: true,
      appConfig: `${KEYCLOAK_AUTH_CONFIG_DIR}/app-config-rhdh-ldap.yaml`,
      dynamicPlugins: `${KEYCLOAK_AUTH_CONFIG_DIR}/dynamic-plugins-ldap.yaml`,
      secrets: `${KEYCLOAK_AUTH_CONFIG_DIR}/rhdh-secrets.yaml`,
      valueFile: `${KEYCLOAK_AUTH_CONFIG_DIR}/value-file.yaml`,
    });
    await rhdh.deploy();
  });

  test("Login with ldapUuidMatchingAnnotation", async ({
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
    await expect(async () => {
      await loginHelper.loginAsKeycloakUser("user1", DEFAULT_OPENLDAP_PASSWORD);
    }).toPass({ timeout: 120_000, intervals: [10_000] });

    await expectProfile(page, uiHelper, "User 1 One");
    await page.goto("/settings");
    await uiHelper.waitForLoad();
    await loginHelper.signOut();
  });
});
