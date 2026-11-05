import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import type { BrowserContext, Page } from "@playwright/test";
import { LoginHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { SavedPromptsPage } from "../support/saved-prompts-page";
import { ensureLightspeedDeployment } from "../support/test-helper";

const PROMPT_CONTENT = "Walk me through a safe deployment.";

/**
 * Basic saved-prompts checks ported from
 * rhdh-plugins/.../lightspeed.saved-prompts.test.ts (live LCORE API, no mocks).
 */
test.describe("Intelligent assistant saved prompts", () => {
  test.describe.configure({ mode: "serial", timeout: 5 * 60 * 1000 });

  let context: BrowserContext;
  let page: Page;
  let savedPrompts: SavedPromptsPage;
  let promptName: string;

  test.beforeAll(async ({ browser, rhdh }) => {
    test.setTimeout(10 * 60 * 1000);
    await ensureLightspeedDeployment(rhdh);

    context = await browser.newContext({
      baseURL: process.env.RHDH_BASE_URL,
    });
    page = await context.newPage();
    await new LoginHelper(page).loginAsKeycloakUser();
    savedPrompts = new SavedPromptsPage(page);
    promptName = `E2E Deploy checklist ${Date.now()}`;
  });

  test.beforeEach(async () => {
    await savedPrompts.openChatShell();
  });

  test.afterAll(async () => {
    await context?.close();
  });

  // Assertions live in SavedPromptsPage helpers.
  /* eslint-disable playwright/expect-expect */
  test("creates a saved prompt from the settings panel", async () => {
    await savedPrompts.openSavedPromptsSettingsTab();
    await savedPrompts.createSavedPrompt(promptName, PROMPT_CONTENT);
    await savedPrompts.expectSavedPromptVisibleInSettings(promptName);
    await savedPrompts.closeSettingsPanel();
  });

  test("shows saved prompts in the chat history sidebar", async () => {
    await savedPrompts.openSavedPromptsHistoryDrawer();
    await savedPrompts.expectSavedPromptsSidebarLoaded(promptName);
  });

  test("applies a saved prompt to the message input from the sidebar", async () => {
    await savedPrompts.openSavedPromptsHistoryDrawer();
    await savedPrompts.applySavedPromptFromSidebar(promptName);
    await savedPrompts.closeSavedPromptsHistoryDrawer();
    await savedPrompts.expectMessageInputValue(PROMPT_CONTENT);
  });

  test("opens saved prompts settings from the sidebar gear control", async () => {
    await savedPrompts.openSavedPromptsSettingsFromSidebarGear();
    await savedPrompts.expectSavedPromptsSettingsPanelVisible();
    await savedPrompts.closeSettingsPanel();
  });

  test("applies a saved prompt via the settings kebab menu", async () => {
    await savedPrompts.openSavedPromptsSettingsTab();
    await savedPrompts.applySavedPromptFromKebab(promptName, "settings");
    await savedPrompts.expectMessageInputValue(PROMPT_CONTENT);
  });

  test("deletes a saved prompt from the settings kebab menu", async () => {
    await savedPrompts.openSavedPromptsSettingsTab();
    await savedPrompts.deleteSavedPromptFromKebab(promptName, "settings");
    await savedPrompts.expectSavedPromptHiddenInSettings(promptName);
    await savedPrompts.closeSettingsPanel();
    await savedPrompts.openSavedPromptsHistoryDrawer();
    await expect(savedPrompts.savedPromptSidebarItem(promptName)).toBeHidden({
      timeout: 15_000,
    });
  });
  /* eslint-enable playwright/expect-expect */
});
