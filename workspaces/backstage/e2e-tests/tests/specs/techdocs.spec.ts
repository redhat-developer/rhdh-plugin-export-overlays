import { expect, Page, test } from "@red-hat-developer-hub/e2e-test-utils/test";

async function docsTextHighlight(page: Page) {
  await page.evaluate(() => {
    const host = document.querySelector(
      '[data-testid="techdocs-native-shadowroot"]',
    );
    const element = host?.shadowRoot?.querySelector("article p")?.firstChild;
    if (!element) return;
    const range = document.createRange();
    const selection = globalThis.getSelection();
    range.setStart(element, 0);
    range.setEnd(element, 20);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

test.describe("TechDocs", () => {
  test.beforeAll(async ({ rhdh }) => {
    // Allow time for deployment + 1 min provider refresh delay + browser setup
    test.setTimeout(10 * 60 * 1000);

    await rhdh.configure({
      auth: "keycloak",
      appConfig: "tests/config/techdocs/app-config-rhdh.yaml",
      dynamicPlugins: "tests/config/techdocs/dynamic-plugins.yaml",
    });

    await rhdh.deploy();
  });

  test.beforeEach(async ({ loginHelper }) => {
    await loginHelper.loginAsKeycloakUser();
  });

  test("Verify that TechDocs is visible in sidebar", async ({ uiHelper }) => {
    await uiHelper.openSidebar("Docs");
  });

  test("Verify that TechDocs Docs page for Red Hat Developer Hub works", async ({
    page,
    uiHelper,
  }) => {
    await uiHelper.openSidebar("Docs");
    await page.getByRole("link", { name: "Red Hat Developer Hub" }).click();
    await uiHelper.waitForTitle("Getting Started running RHDH", 1);
  });

  test("Verify that TechDocs entity tab page for Red Hat Developer Hub works", async ({
    uiHelper,
  }) => {
    await uiHelper.openSidebar("Catalog");
    await uiHelper.selectMuiBox("Kind", "Component");
    await uiHelper.clickLink("Red Hat Developer Hub");
    await uiHelper.clickTab("Docs");
    await uiHelper.waitForTitle("Getting Started running RHDH", 1);
  });

  test("Verify that TechDocs Docs page for ReportIssue addon works", async ({
    page,
    uiHelper,
  }) => {
    await uiHelper.openSidebar("Docs");
    await page.getByRole("link", { name: "Red Hat Developer Hub" }).click();
    await page.waitForSelector("article a");
    await docsTextHighlight(page);
    const link = await page.waitForSelector("text=Open new Github issue");
    expect(await link?.isVisible()).toBeTruthy();
  });

  test("Verify that TechDocs entity tab page for ReportIssue addon works", async ({
    page,
    uiHelper,
  }) => {
    await uiHelper.openSidebar("Catalog");
    await uiHelper.selectMuiBox("Kind", "Component");
    await uiHelper.clickLink("Red Hat Developer Hub");
    await uiHelper.clickTab("Docs");
    await page.waitForSelector("article a");
    await docsTextHighlight(page);
    const link = await page.waitForSelector("text=Open new Github issue");
    expect(await link?.isVisible()).toBeTruthy();
  });
});
