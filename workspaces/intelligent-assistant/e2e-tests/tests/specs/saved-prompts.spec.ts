import { test } from "@red-hat-developer-hub/e2e-test-utils/test";
import type { BrowserContext, Page } from "@playwright/test";
import { LoginHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { SavedPromptsPage } from "../support/saved-prompts-page";
import { ensureLightspeedDeployment } from "../support/test-helper";

const PROMPT_CONTENT = "Walk me through a safe deployment.";

test.describe("Intelligent Assistant saved prompts smoke", () => {
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

  test.afterAll(async () => {
    await context?.close();
  });

  test("creates, applies, and deletes a saved prompt", async () => {
    await savedPrompts.openChatShell();
    await savedPrompts.openSavedPromptsSettingsTab();
    await savedPrompts.createSavedPrompt(promptName, PROMPT_CONTENT);
    await savedPrompts.expectSavedPromptVisibleInSettings(promptName);

    await savedPrompts.applySavedPromptFromKebab(promptName, "settings");
    await savedPrompts.expectMessageInputValue(PROMPT_CONTENT);

    await savedPrompts.openSavedPromptsSettingsTab();
    await savedPrompts.deleteSavedPromptFromKebab(promptName, "settings");
    await savedPrompts.expectSavedPromptHiddenInSettings(promptName);
    await savedPrompts.closeSettingsPanel();
  });
});
