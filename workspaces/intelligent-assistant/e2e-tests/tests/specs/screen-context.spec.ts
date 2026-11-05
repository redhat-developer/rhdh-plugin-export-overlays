import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import type { BrowserContext, Page } from "@playwright/test";
import { LoginHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { openChatbotSettings } from "../support/chat-management";
import {
  expectRhdhContentVisible,
  openChatbot,
  selectDisplayMode,
  type DisplayMode,
} from "../support/lightspeed-page";
import {
  disableScreenContextViaKebab,
  enableScreenContextViaKebab,
  expectScreenContextChipHidden,
  expectScreenContextPausedVisible,
  expectScreenContextRecordingVisible,
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
 * Screen context is only offered in overlay and dock-to-window.
 * Ported from rhdh-plugins lightspeed.screen-context.test.ts without the
 * fullscreen case (live cluster, no mocks).
 */
const SCREEN_CONTEXT_MODES = [
  "Overlay",
  "Dock to window",
] as const satisfies readonly DisplayMode[];

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

  test.afterAll(async () => {
    await context?.close();
  });

  for (const mode of SCREEN_CONTEXT_MODES) {
    test.describe(mode, () => {
      test.beforeEach(async () => {
        await gotoCatalogAuthenticated(page);
        await expectRhdhContentVisible(page);
        await openChatbot(page);
        await selectDisplayMode(page, mode);
        await expect(page.getByLabel("Chatbot", { exact: true })).toBeVisible({
          timeout: 30_000,
        });
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
      /* eslint-enable playwright/expect-expect */
    });
  }
});
