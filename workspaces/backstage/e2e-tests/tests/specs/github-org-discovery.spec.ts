import { test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { type UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";

test.describe("GitHub Integration Org", () => {
  const verifyAppearanceInCatalog = async (
    uiHelper: UIhelper,
    kind: "Group" | "User",
    checks: Array<{ search: string; expectedRows: string[] }>,
  ) => {
    await uiHelper.openSidebar("Catalog");
    await uiHelper.selectMuiBox("Kind", kind);

    for (const check of checks) {
      await uiHelper.searchInputPlaceholder(check.search);
      await uiHelper.verifyRowsInTable(check.expectedRows);
    }
  };

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
    await verifyAppearanceInCatalog(uiHelper, "Group", [
      { search: "maintainers", expectedRows: ["maintainers"] },
      { search: "r", expectedRows: ["rhdh-qes"] },
    ]);
  });

  // eslint-disable-next-line playwright/expect-expect
  test("Verify that fetching the groups of the second org works", async ({
    uiHelper,
  }) => {
    await verifyAppearanceInCatalog(uiHelper, "Group", [
      { search: "c", expectedRows: ["catalog-group"] },
      { search: "j", expectedRows: ["janus-test"] },
    ]);
  });

  // eslint-disable-next-line playwright/expect-expect
  test("Verify that fetching the users of the orgs works", async ({
    uiHelper,
  }) => {
    await verifyAppearanceInCatalog(uiHelper, "User", [
      { search: "r", expectedRows: ["rhdh-qe"] },
    ]);
  });
});
