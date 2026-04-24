import { test } from "@red-hat-developer-hub/e2e-test-utils/test";

test.describe("GitHub Integration Org", () => {
  test.beforeAll(async ({ rhdh }) => {
    await rhdh.configure({
      auth: "guest",
      appConfig: "tests/config/github-org-discovery/app-config-rhdh.yaml",
      secrets: "tests/config/github-org-discovery/rhdh-secrets.yaml",
      dynamicPlugins: "tests/config/github-org-discovery/dynamic-plugins.yaml",
    });
    await rhdh.deploy();
    // Wait 1 minute for github provider to refresh entities before running tests
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  });

  test.beforeEach(async ({ loginHelper }, testInfo) => {
    if (testInfo.retry > 0) {
      // Progressively increase timeout for retries.
      test.setTimeout(testInfo.timeout + testInfo.timeout * 0.25);
    }

    await loginHelper.loginAsGuest();
  });

  // eslint-disable-next-line playwright/expect-expect
  test("Verify that fetching the groups of the first org works", async ({
    uiHelper,
  }) => {
    await uiHelper.openSidebar("Catalog");
    await uiHelper.selectMuiBox("Kind", "Group");

    await uiHelper.searchInputPlaceholder("maintainers");
    await uiHelper.verifyRowsInTable(["maintainers"]);

    await uiHelper.searchInputPlaceholder("r");
    await uiHelper.verifyRowsInTable(["rhdh-qes"]);
  });

  // eslint-disable-next-line playwright/expect-expect
  test("Verify that fetching the groups of the second org works", async ({
    uiHelper,
  }) => {
    await uiHelper.openSidebar("Catalog");
    await uiHelper.selectMuiBox("Kind", "Group");

    await uiHelper.searchInputPlaceholder("c");
    await uiHelper.verifyRowsInTable(["catalog-group"]);

    await uiHelper.searchInputPlaceholder("j");
    await uiHelper.verifyRowsInTable(["janus-test"]);
  });

  // eslint-disable-next-line playwright/expect-expect
  test("Verify that fetching the users of the orgs works", async ({
    uiHelper,
  }) => {
    await uiHelper.openSidebar("Catalog");
    await uiHelper.selectMuiBox("Kind", "User");

    await uiHelper.searchInputPlaceholder("r");
    await uiHelper.verifyRowsInTable(["rhdh-qe"]);
  });
});
