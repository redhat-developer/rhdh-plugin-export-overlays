import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import type { BrowserContext, Page } from "@playwright/test";
import { LoginHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { openChatbotSettings } from "../support/chat-management";
import {
  expectConversationArea,
  expectRhdhContentVisible,
  openChatbot,
  selectDisplayMode,
} from "../support/lightspeed-page";
import {
  disableScreenContextViaKebab,
  enableScreenContextViaKebab,
  expectScreenContextChipHidden,
  expectScreenContextPausedVisible,
  expectScreenContextRecordingVisible,
  expectScreenContextUnavailableVisible,
  pauseScreenContextChip,
  resumeScreenContextChip,
  selectEnableScreenContext,
  verifyEnableScreenContextOption,
} from "../support/screen-context";
import {
  ensureLightspeedDeployment,
  gotoCatalogAuthenticated,
} from "../support/test-helper";

/**
 * Basic screen-context checks ported from
 * rhdh-plugins/.../lightspeed.screen-context.test.ts (live cluster, no mocks).
 */
test.describe("Intelligent assistant screen context", () => {
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

  test.beforeEach(async () => {
    await gotoCatalogAuthenticated(page);
    await expectRhdhContentVisible(page);
    const chatbot = page.getByLabel("Chatbot", { exact: true });
    if (!(await chatbot.isVisible())) {
      await openChatbot(page);
    }
    await expect(chatbot).toBeVisible({ timeout: 30_000 });
  });

  test.afterAll(async () => {
    await context?.close();
  });

  // Assertions live in screen-context helpers.
  /* eslint-disable playwright/expect-expect */
  test("kebab Enable shows recording chip; Disable hides it", async () => {
    await expectScreenContextChipHidden(page);

    await openChatbotSettings(page);
    await verifyEnableScreenContextOption(page);
    await selectEnableScreenContext(page);
    await expectScreenContextRecordingVisible(page);

    await disableScreenContextViaKebab(page);
    await expectScreenContextChipHidden(page);
  });

  test("chip pause/resume toggles Context: paused label", async () => {
    await enableScreenContextViaKebab(page);
    await pauseScreenContextChip(page);
    await expectScreenContextPausedVisible(page);

    await resumeScreenContextChip(page);
    await expectScreenContextRecordingVisible(page);

    await disableScreenContextViaKebab(page);
  });

  test("fullscreen shows Context: unavailable", async () => {
    await enableScreenContextViaKebab(page);
    await selectDisplayMode(page, "Fullscreen");
    await expectConversationArea(page, "Fullscreen");

    await openChatbotSettings(page);
    await verifyEnableScreenContextOption(page);
    await selectEnableScreenContext(page);
    await expectScreenContextUnavailableVisible(page);
  });
  /* eslint-enable playwright/expect-expect */
});
