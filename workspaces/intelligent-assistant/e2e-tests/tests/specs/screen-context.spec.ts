import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import type { BrowserContext, Page } from "@playwright/test";
import { LoginHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import {
  expectRhdhContentVisible,
  openChatbot,
  selectDisplayMode,
} from "../support/lightspeed-page";
import {
  disableScreenContextViaKebab,
  expectScreenContextChipHidden,
  expectScreenContextRecordingVisible,
  openChatbotSettings,
  selectEnableScreenContext,
  verifyEnableScreenContextOption,
} from "../support/screen-context";
import {
  ensureLightspeedDeployment,
  gotoCatalogAuthenticated,
} from "../support/test-helper";

test.describe("Intelligent Assistant screen context smoke", () => {
  test.describe.configure({ mode: "serial", timeout: 5 * 60 * 1000 });

  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser, rhdh }) => {
    test.setTimeout(10 * 60 * 1000);
    await ensureLightspeedDeployment(rhdh);

    context = await browser.newContext({
      baseURL: process.env.RHDH_BASE_URL,
    });
    page = await context.newPage();
    await new LoginHelper(page).loginAsKeycloakUser();

    const hideButton = page.getByRole("button", { name: "Hide" });
    if (await hideButton.isVisible()) {
      await hideButton.click();
    }
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("enabling screen context shows the recording chip", async () => {
    await gotoCatalogAuthenticated(page);
    await expectRhdhContentVisible(page);
    await openChatbot(page);
    await selectDisplayMode(page, "Overlay");
    await expect(page.getByLabel("Chatbot", { exact: true })).toBeVisible({
      timeout: 30_000,
    });

    await expectScreenContextChipHidden(page);
    await openChatbotSettings(page);
    await verifyEnableScreenContextOption(page);
    await selectEnableScreenContext(page);
    await expectScreenContextRecordingVisible(page);

    await disableScreenContextViaKebab(page);
    await expectScreenContextChipHidden(page);
  });
});
