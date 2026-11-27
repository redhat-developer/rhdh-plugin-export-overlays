import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";

test.describe("Header mount points", () => {
  test.skip(
    !!process.env.E2E_NIGHTLY_MODE,
    "RHDH 1.10 CI image lacks python: install-dynamic-plugins.sh exits 127 (RHDHBUGS-4136, redhat-developer/rhdh#5899). Remove once a fixed 1.10 CI chart is published.",
  );
  test.beforeAll(async ({ rhdh }) => {
    await rhdh.configure({
      auth: "keycloak",
      disableWrappers: ["red-hat-developer-hub-backstage-plugin-global-header"],
    });
    await rhdh.deploy();
  });

  test.beforeEach(async ({ loginHelper, page, baseURL }) => {
    if (!baseURL) {
      throw new Error("Playwright baseURL is not set");
    }
    await expect(async () => {
      await page.goto(baseURL);
      await expect(
        page.getByRole("button", { name: "Sign In", exact: true }),
      ).toBeVisible({ timeout: 15_000 });
    }).toPass({ timeout: 120_000 });

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
