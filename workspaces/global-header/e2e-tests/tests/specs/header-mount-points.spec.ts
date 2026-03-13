import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";

test.describe("Header mount points", () => {
  test.beforeAll(async ({ rhdh }) => {
    await rhdh.configure({ auth: "keycloak" });
    await rhdh.deploy();
  });

  test.beforeEach(async ({ loginHelper, page }) => {
    await loginHelper.loginAsKeycloakUser();
    await expect(page.locator("nav[id='global-header']")).toBeVisible();
  });

  test("Verify that additional logo component in global header is visible", async ({
    page,
    uiHelper,
  }) => {
    const header = page.locator("nav[id='global-header']");
    await expect(header).toBeVisible();
    await uiHelper.verifyLink({ label: "test-logo" });
    // Config mounts CompanyLogo (link to Home); assert it is visible (no test-logo plugin in this setup)
    // await expect(
    //   header.getByRole("link", { name: "Home" }).first(),
    // ).toBeVisible();
  });

  test("Verify that additional header button component from a custom header plugin in global header is visible", async ({
    page,
  }) => {
    const header = page.locator("nav[id='global-header']");
    await expect(header).toBeVisible();
    await expect(
      header.locator("button", { hasText: "Test Button" }),
    ).toHaveCount(1);
  });

  test("Verify that additional header from a custom header plugin besides the default one is visible", async ({
    page,
  }) => {
    const header = page.locator("header", {
      hasText: "This is a test header!",
    });
    await expect(header).toBeVisible();
  });
});
