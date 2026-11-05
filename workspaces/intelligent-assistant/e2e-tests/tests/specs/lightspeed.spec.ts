import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import type { BrowserContext, Page } from "@playwright/test";
import { LoginHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import {
  getLastBotResponseText,
  lastBotMessage,
  sendMessage,
} from "../support/conversation-helper";
import {
  chatModelSelector,
  expectChatbotControlsVisible,
  expectChatInputAreaVisible,
  expectConversationArea,
  expectRhdhContentVisible,
  openChatbot,
  selectChatModel,
  selectDisplayMode,
} from "../support/lightspeed-page";
import {
  ensureLightspeedDeployment,
  gotoCatalogAuthenticated,
  openLightspeed,
} from "../support/test-helper";

const DEFAULT_BOT_QUERY =
  "Reply with exactly one short sentence confirming you received this message.";

async function selectAvailableChatModel(page: Page): Promise<void> {
  const openAiItems = page.getByRole("menuitem", { name: /^gpt-/i });
  const llamaItems = page.getByRole("menuitem", {
    name: /llama[-_ ]?31[-_ ]?8b/i,
  });
  const hasOpenAiModels = (await openAiItems.count()) > 0;
  const hasLlamaModel = (await llamaItems.count()) > 0;

  expect(hasOpenAiModels || hasLlamaModel).toBeTruthy();

  const preferredOpenAi = page.getByRole("menuitem", {
    name: "gpt-4o-mini",
  });
  if (await preferredOpenAi.count()) {
    await selectChatModel(page, "gpt-4o-mini");
  } else if (hasOpenAiModels) {
    await openAiItems.first().click();
  } else {
    await llamaItems.first().click();
  }
}

test.describe("Intelligent Assistant smoke", () => {
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

  test("chatbot opens over the catalog", async () => {
    await gotoCatalogAuthenticated(page);
    await expectRhdhContentVisible(page);
    await openChatbot(page);
    await selectDisplayMode(page, "Overlay");

    await expectConversationArea(page, "Overlay");
    await expectChatInputAreaVisible(page);
    await expectRhdhContentVisible(page);
    await expectChatbotControlsVisible(page);
  });

  test("a prompt returns a bot response", async () => {
    await openLightspeed(page);
    await expect(page).toHaveURL(/\/intelligent-assistant/);
    await expect(
      page.getByRole("heading", {
        name: "Developer Hub Intelligent Assistant",
      }),
    ).toBeVisible();
    await expect(page.getByText("How can I help you today?")).toBeVisible();

    const dropdown = chatModelSelector(page);
    await expect(dropdown).toBeVisible({ timeout: 60_000 });
    await expect(dropdown).not.toBeEmpty();
    await dropdown.click();
    await selectAvailableChatModel(page);

    await sendMessage(DEFAULT_BOT_QUERY, page);

    const userMessage = page.locator(".pf-chatbot__message--user").last();
    await expect(userMessage).toBeVisible();
    await expect(userMessage).toContainText(DEFAULT_BOT_QUERY);
    await expect(lastBotMessage(page)).toBeVisible();
    await getLastBotResponseText(page);
  });
});
