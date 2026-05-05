import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { requireEnv } from "@red-hat-developer-hub/e2e-test-utils/utils";

test.describe("gitlab discovery UI tests", () => {
  test.beforeAll(async ({ rhdh }) => {
    requireEnv("VAULT_GITLAB_TOKEN_DECODED");

    await rhdh.configure({
      auth: "guest",
      appConfig: "tests/config/gitlab-discovery/app-config-rhdh.yaml",
      secrets: "tests/config/gitlab-discovery/rhdh-secrets.yaml",
      dynamicPlugins: "tests/config/gitlab-discovery/dynamic-plugins.yaml",
    });

    await rhdh.deploy();
  });

  test.beforeEach(async ({ loginHelper, uiHelper }) => {
    await loginHelper.loginAsGuest();
    await uiHelper.openSidebar("Catalog");
  });

  test("GitLab integration for discovering catalog entities from GitLab", async ({
    page,
    uiHelper,
  }) => {
    await uiHelper.dismissQuickstartIfVisible();

    await page
      .getByRole("textbox", { name: "Search" })
      .waitFor({ state: "visible" });
    await uiHelper.searchInputPlaceholder("scaffoldedForm");
    await uiHelper.verifyTextVisible("scaffoldedForm-test", true, 10_000);
    await uiHelper.clickLink("scaffoldedForm-test");
    await uiHelper.verifyHeading("scaffoldedForm-test");
    await uiHelper.verifyText("My Description");
    await uiHelper.verifyText("experimental");
    await uiHelper.verifyText("website");
    await expect(page.getByRole("link", { name: "View Source" })).toBeVisible();
  });
});
