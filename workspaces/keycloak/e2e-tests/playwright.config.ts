import { defineConfig } from "@red-hat-developer-hub/e2e-test-utils/playwright-config";

// Catalog + auth suites need in-cluster Keycloak (globalSetup sets KEYCLOAK_*).
// Clear any inherited SKIP from guest-auth runs / shell / .env.
delete process.env.SKIP_KEYCLOAK_DEPLOYMENT;

/**
 * Keycloak catalog integration e2e test configuration.
 *
 * Projects:
 * - keycloak-app-next — namespace ends with -app-next, so e2e-test-utils merges
 *   NFS (app-next) secrets and default app-auth / app-integrations automatically.
 * - keycloak-auth-app-next — community keycloak auth resolver tests (serial; mutates config)
 * - keycloak-auth-ldap-app-next — LDAP federation + ldapUuidMatchingAnnotation (parallel)
 */
export default defineConfig({
  projects: [
    {
      name: "keycloak-app-next",
      testMatch: "**/catalog-users.spec.ts",
    },
    {
      name: "keycloak-auth-app-next",
      testMatch: "**/keycloak-auth.spec.ts",
    },
    {
      name: "keycloak-auth-ldap-app-next",
      testMatch: "**/keycloak-auth-ldap.spec.ts",
    },
  ],
});
