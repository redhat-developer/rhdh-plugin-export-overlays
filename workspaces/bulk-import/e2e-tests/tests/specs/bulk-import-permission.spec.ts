import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import { signInAsGuestForPermissionTest } from "../../support/utils/auth";
import { setupBulkImportRhdh } from "../../support/utils/deploy";

// Deployed with guest auth (development environment) in its own project/namespace,
// separate from the GitHub-auth deployment in bulk-import.spec.ts. RHDH only renders
// the guest "Enter" tile on the sign-in page under a development-environment/guest
// deployment, not under the production-environment GitHub deployment the other
// bulk-import tests share (rhdh-plugin-export-overlays guest-tile investigation).
test.describe("Bulk Import - Ensure users without bulk import permissions cannot access the bulk import plugin", () => {
  test.beforeAll(async ({ rhdh }) => {
    await test.runOnce(
      `bulk-import-permission-setup-${rhdh.deploymentConfig.namespace}`,
      async () => {
        await setupBulkImportRhdh(rhdh, {
          auth: "guest",
          appConfig: "tests/config/app-config-rhdh.yaml",
          dynamicPlugins: "tests/config/dynamic-plugins.yaml",
          valueFile: "tests/config/values.yaml",
        });
      },
    );
  });

  test.beforeEach(async ({ loginHelper, uiHelper }) => {
    await signInAsGuestForPermissionTest(loginHelper, uiHelper);
  });

  test("Bulk Import - Verify users without permission cannot access", async ({
    uiHelper,
  }) => {
    await uiHelper.verifyText("Permission required");
    expect(await uiHelper.isBtnVisible("Import")).toBeFalsy();
  });
});
