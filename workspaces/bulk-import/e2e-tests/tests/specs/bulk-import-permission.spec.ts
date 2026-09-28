import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import { signInAsGuestForPermissionTest } from "../../support/utils/auth";
import { setupBulkImportRhdh } from "../../support/utils/deploy";

// Deployed with guest auth (development environment) in its own project/namespace,
// separate from the GitHub-auth deployment in bulk-import.spec.ts. RHDH only renders
// the guest "Enter" tile on the sign-in page under a development-environment/guest
// deployment, not under the production-environment GitHub deployment the other
// bulk-import tests share (rhdh-plugin-export-overlays guest-tile investigation).
test.describe("Bulk Import permission", () => {
  test.beforeAll(async ({ rhdh }) => {
    await test.runOnce(
      `bulk-import-permission-setup-${rhdh.deploymentConfig.namespace}`,
      async () => {
        await setupBulkImportRhdh(rhdh, {
          auth: "guest",
          appConfig: "tests/config/app-config-rhdh-permission.yaml",
          dynamicPlugins: "tests/config/dynamic-plugins-with-permission.yaml",
          valueFile: "tests/config/values.yaml",
        });
      },
    );
  });

  test.beforeEach(async ({ page, loginHelper }) => {
    await signInAsGuestForPermissionTest(page, loginHelper);
  });

  test("Bulk Import - Verify users without permission cannot access", async ({
    page,
    uiHelper,
  }) => {
    // Guests are denied access: either the legacy in-app "Permission required"
    // message, or a 404 when the route is not registered for unauthorized users.
    const permissionRequired = page.getByText("Permission required", {
      exact: true,
    });
    const notFound = page.getByText("ERROR 404: PAGE NOT FOUND");
    await expect(permissionRequired.or(notFound)).toBeVisible({
      timeout: 15_000,
    });
    expect(await uiHelper.isBtnVisible("Import")).toBeFalsy();
  });
});
