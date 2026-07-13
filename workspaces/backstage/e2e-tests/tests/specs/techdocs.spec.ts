import { expect, Page, test } from "@red-hat-developer-hub/e2e-test-utils/test";

/** Chart dist wrapper names (see ../metadata `spec.dynamicArtifact` basenames). */
const TECHDOCS_WRAPPER_DIST_NAMES: string[] = [
  "backstage-plugin-techdocs",
  "backstage-plugin-techdocs-backend-dynamic",
  "backstage-plugin-techdocs-module-addons-contrib",
];

const REPORT_ISSUE_POLL_TIMEOUT_MS = 30_000;
const REPORT_ISSUE_POLL_INTERVAL_MS = 1_000;

/**
 * Select text inside the TechDocs shadow root so the ReportIssue addon can
 * react. Returns false when the docs content is not ready yet.
 */
async function docsTextHighlight(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const host = document.querySelector(
      '[data-testid="techdocs-native-shadowroot"]',
    );
    const paragraph = host?.shadowRoot?.querySelector("article p");
    const element = paragraph?.firstChild;
    if (!paragraph || !element?.textContent || element.textContent.length < 5) {
      return false;
    }

    // Keep selection rect away from top=0; ReportIssue treats that as invalid.
    paragraph.scrollIntoView({ block: "center", inline: "nearest" });

    const end = Math.min(20, element.textContent.length);
    const range = document.createRange();
    const selection = globalThis.getSelection();
    range.setStart(element, 0);
    range.setEnd(element, end);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    return Boolean(selection?.toString());
  });
}

async function verifyReportIssueAddon(page: Page) {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const host = document.querySelector(
            '[data-testid="techdocs-native-shadowroot"]',
          );
          const text =
            host?.shadowRoot?.querySelector("article p")?.textContent ?? "";
          return text.length >= 5;
        }),
      {
        message: "TechDocs shadow article paragraph should be ready",
        timeout: REPORT_ISSUE_POLL_TIMEOUT_MS,
        intervals: [500],
      },
    )
    .toBe(true);

  await expect
    .poll(
      async () => {
        await docsTextHighlight(page);
        return page.getByText("Open new Github issue").isVisible();
      },
      {
        message: "ReportIssue link should appear after text selection",
        timeout: REPORT_ISSUE_POLL_TIMEOUT_MS,
        intervals: [REPORT_ISSUE_POLL_INTERVAL_MS],
      },
    )
    .toBe(true);
}

test.describe("TechDocs", () => {
  test.beforeAll(async ({ rhdh }) => {
    // Allow time for deployment + browser setup
    test.setTimeout(10 * 60 * 1000);

    await rhdh.configure({
      auth: "guest",
      appConfig: "tests/config/techdocs/app-config-rhdh.yaml",
      dynamicPlugins: "tests/config/techdocs/dynamic-plugins.yaml",
      secrets: "tests/config/techdocs/rhdh-secrets.yaml",
      disableWrappers: TECHDOCS_WRAPPER_DIST_NAMES,
    });

    await rhdh.deploy();
  });

  test.beforeEach(async ({ loginHelper }, testInfo) => {
    if (testInfo.retry > 0) {
      // Progressively increase timeout for retries.
      test.setTimeout(testInfo.timeout + testInfo.timeout * 0.25);
    }

    await loginHelper.loginAsGuest();
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
    await uiHelper.waitForTitle("Getting Started running RHDH", 1);
    await verifyReportIssueAddon(page);
    await expect(page.getByText("Open new Github issue")).toBeVisible();
  });

  test("Verify that TechDocs entity tab page for ReportIssue addon works", async ({
    page,
    uiHelper,
  }) => {
    await uiHelper.openSidebar("Catalog");
    await uiHelper.selectMuiBox("Kind", "Component");
    await uiHelper.clickLink("Red Hat Developer Hub");
    await uiHelper.clickTab("Docs");
    await uiHelper.waitForTitle("Getting Started running RHDH", 1);
    await verifyReportIssueAddon(page);
    await expect(page.getByText("Open new Github issue")).toBeVisible();
  });
});
