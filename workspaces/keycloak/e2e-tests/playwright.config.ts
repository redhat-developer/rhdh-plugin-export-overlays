import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

// Catalog + auth suites need in-cluster Keycloak (globalSetup sets KEYCLOAK_*).
// Clear any inherited SKIP from guest-auth runs / shell / .env.
delete process.env.SKIP_KEYCLOAK_DEPLOYMENT;

/**
 * Keycloak catalog integration E2E test configuration using the current RHDH frontend.
 *
 * Projects:
 * - keycloak - catalog integration tests
 * - keycloak-auth — community keycloak auth resolver tests
 * - keycloak-auth-ldap — LDAP federation + ldapUuidMatchingAnnotation
 */
export default defineConfig({
  projects: [
    {
      name: "keycloak",
      testMatch: "**/catalog-users.spec.ts",
    },
    {
      name: "keycloak-auth",
      testMatch: "**/keycloak-auth.spec.ts",
    },
    {
      name: "keycloak-auth-ldap",
      testMatch: "**/keycloak-auth-ldap.spec.ts",
    },
  ],
});
