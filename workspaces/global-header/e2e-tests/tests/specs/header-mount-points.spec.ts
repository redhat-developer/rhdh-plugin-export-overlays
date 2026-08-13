import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { WorkspacePaths } from "@red-hat-developer-hub/e2e-test-utils/utils";

test.describe("Header mount points", () => {
  test.beforeAll(async ({ rhdh }) => {
    const isAppNext = test.info().project.name.endsWith("-app-next");
    test.skip(
      isAppNext,
      "test plugin uses npm wrapper packaging which is incompatible with NFS module federation",
    );
    const isNightlyMode =
      process.env.E2E_NIGHTLY_MODE === "true" ||
      process.env.E2E_NIGHTLY_MODE === "1" ||
      (process.env.JOB_NAME?.includes("periodic-") ?? false);

    await rhdh.configure({
      auth: "keycloak",
      ...(isNightlyMode
        ? {}
        : {
            disablePlugins: [
              "red-hat-developer-hub-backstage-plugin-global-header",
            ],
          }),
      dynamicPlugins: WorkspacePaths.resolve(
        isAppNext
          ? "tests/config/dynamic-plugins-nfs.yaml"
          : "tests/config/dynamic-plugins.yaml",
      ),
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
