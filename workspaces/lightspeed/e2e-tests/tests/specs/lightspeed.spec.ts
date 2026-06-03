import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import type { BrowserContext, Page } from "@playwright/test";
import { LoginHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import path from "path";
import {
  cancelChatDeletion,
  closeSortDropdown,
  confirmChatDeletion,
  openChatbotSettings,
  openActiveChatContextMenu,
  openChatContextMenuByName,
  openPinnedChatContextMenuByName,
  openSortDropdown,
  searchChats,
  selectDeleteAction,
  selectDisablePinnedChats,
  selectEnablePinnedChats,
  selectPinAction,
  selectRenameAction,
  selectSortOption,
  selectUnpinAction,
  submitChatRename,
  verifyChatContextMenuOptions,
  verifyChatDeleted,
  verifyChatPinned,
  verifyChatRenamed,
  verifyChatbotSettingsVisible,
  verifyConversationsSortedAlphabetically,
  verifyDeleteConfirmation,
  verifyDisablePinnedChatsOption,
  verifyEmptyPinnedChatsMessage,
  verifyEmptySearchResults,
  verifyEnablePinnedChatsOption,
  verifyPinActionAvailable,
  verifyPinnedChatsNotEmpty,
  verifyPinnedSectionHidden,
  verifyPinnedSectionVisible,
  verifyRenameChatForm,
  verifySortDropdownOptions,
  verifySortDropdownVisible,
  verifyUnpinActionAvailable,
} from "../support/chat-management";
import {
  assertLastBotResponseCopiedToClipboard,
  chatStopButton,
  expectChatInputValue,
  expectChatStopButtonVisible,
  getLastBotResponseText,
  lastBotMessage,
  sendMessage,
  sendMessageInNewChat,
  startNewChatWithModel,
  submitFeedback,
  verifyFeedbackButtons,
  verifySidePanelConversation,
  waitForChatMessageLoadingHidden,
} from "../support/conversation-helper";
import {
  closeChatHistoryDrawer,
  chatModelSelector,
  expectChatbotControlsVisible,
  expectChatInputAreaVisible,
  expectConversationArea,
  expectEmptyChatHistory,
  expectRhdhShellVisible,
  openChatbot,
  openChatbotFullscreenWithModel,
  openChatHistoryDrawer,
  selectChatModel,
  selectDisplayMode,
  verifyDisplayModeMenuOptions,
} from "../support/lightspeed-page";
import {
  assertChatDialogInitialState,
  assertDrawerState,
  closeChatDrawer,
  openChatDrawer,
} from "../support/sidebar";
import {
  assertVisibilityState,
  uploadAndAssertDuplicate,
  uploadFiles,
  validateFailedUpload,
} from "../support/file-upload";
import {
  ensureLightspeedDeployment,
  openLightspeed,
} from "../support/test-helper";

const fixturesDir = path.join(import.meta.dirname, "../fixtures/uploads");
const e2eRoot = path.join(import.meta.dirname, "../..");

const DEFAULT_BOT_QUERY =
  "Reply with exactly one short sentence confirming you received this message.";

test.describe("Lightspeed UI", () => {
  test.describe.configure({ mode: "serial", timeout: 5 * 60 * 1000 });

  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser, rhdh }) => {
    test.setTimeout(10 * 60 * 1000);
    await ensureLightspeedDeployment(rhdh);

    context = await browser.newContext({
      baseURL: process.env.RHDH_BASE_URL,
      permissions: ["clipboard-read", "clipboard-write"],
    });
    page = await context.newPage();
    await new LoginHelper(page).loginAsKeycloakUser();
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test.describe("Chatbot display modes", () => {
    test.beforeEach(async () => {
      await page.goto("/");
    });

    test("overlay mode keeps RHDH visible with chat controls", async () => {
      await expectRhdhShellVisible(page);
      await openChatbot(page);
      await selectDisplayMode(page, "Overlay");

      await expectConversationArea(page, "Overlay");
      await expectChatInputAreaVisible(page);
      await expectRhdhShellVisible(page);
      await expectChatbotControlsVisible(page);

      await openChatHistoryDrawer(page);
      await expectEmptyChatHistory(page);
      await closeChatHistoryDrawer(page);
      await verifyDisplayModeMenuOptions(page);
    });

    test("dock to window mode keeps RHDH visible", async () => {
      await openChatbot(page);
      await selectDisplayMode(page, "Dock to window");

      await expectConversationArea(page, "Dock to window");
      await expectRhdhShellVisible(page);
      await expectChatInputAreaVisible(page);
      await expectChatbotControlsVisible(page);

      await openChatHistoryDrawer(page);
      await expectEmptyChatHistory(page);
      await closeChatHistoryDrawer(page);
    });

    test("fullscreen mode hides RHDH shell", async () => {
      await openChatbot(page);
      await selectDisplayMode(page, "Fullscreen");

      await expectConversationArea(page, "Fullscreen");
      await expectEmptyChatHistory(page);
      await expectRhdhShellVisible(page, false);
    });
  });

  test.describe("Lightspeed page", () => {
    test.beforeEach(async () => {
      await openLightspeed(page);
    });

    test("page is available", async () => {
      await expect(page).toHaveURL(/\/lightspeed/);
      await expect(
        page.getByRole("heading", { name: "Developer Lightspeed" }),
      ).toBeVisible();
      await expect(page.getByText("How can I help you today?")).toBeVisible();
    });

    test("disclaimer is visible", async () => {
      await expect(page.getByLabel("Scrollable message log"))
        .toMatchAriaSnapshot(`
      - 'heading "Info alert: Important" [level=4]'
      - text: This feature uses AI technology. Do not include any personal information or any other sensitive information in your input. Interactions may be used to improve Red Hat's products or services.
      `);
    });

    test("model selector shows available models", async () => {
      const dropdown = chatModelSelector(page);
      await expect(dropdown).toBeVisible({ timeout: 60_000 });
      await expect(dropdown).not.toBeEmpty();

      await dropdown.click();
      await expect(page.locator("body")).toMatchAriaSnapshot(`
        - menu:
          - menuitem "gpt-4.1-mini"
          - menuitem "gpt-4.1-nano"
          - menuitem "gpt-4o-mini"
          - menuitem "gpt-5.1"
          - menuitem "redhataillama-31-8b-instruct"
        `);
      await selectChatModel(page, "gpt-4o-mini");
    });

    test("sidebar opens, closes, and reopens", async () => {
      await test.step("initial sidebar state", async () => {
        await assertChatDialogInitialState(page);
      });

      await test.step("close sidebar", async () => {
        await closeChatDrawer(page);
        await assertDrawerState(page, "closed");
      });

      await test.step("reopen sidebar", async () => {
        await openChatDrawer(page);
        await assertDrawerState(page, "open");
      });
    });

    test("default prompts are visible", async () => {
      const userName = process.env.RHDH_DISPLAY_NAME ?? "Test User1";
      await expect(page.getByLabel("Scrollable message log"))
        .toMatchAriaSnapshot(`
      - region "Scrollable message log":
        - 'heading "Info alert: Important" [level=4]'
        - text: This feature uses AI technology. Do not include any personal information or any other sensitive information in your input. Interactions may be used to improve Red Hat's products or services.
        - heading "Hello, ${userName} How can I help you today?" [level=1]
        - button /.+/
        - text: /.+/
        - button /.+/
        - text: /.+/
        - button /.+/
        - text: /.+/
    `);

      const promptTitles = page.locator(
        "motion.pf-v6-c-card__title-text, div.pf-v6-c-card__title-text",
      );
      const nonEmptyTitles = (await promptTitles.allTextContents()).filter(
        (text) => text.trim().length > 0,
      );
      expect(nonEmptyTitles.length).toBeGreaterThanOrEqual(1);
    });

    test("file attachment accepts supported json and rejects duplicate upload", async () => {
      const filePath = path.join(e2eRoot, "package.json");
      await uploadFiles(page, [filePath]);
      await uploadAndAssertDuplicate(page, filePath, "package.json");
    });

    test("file attachment rejects unsupported file types", async () => {
      const filePath = path.join(e2eRoot, "eslint.config.js");
      await uploadFiles(page, [filePath]);
      await validateFailedUpload(page);
      await expect(
        page.locator("span", { hasText: "eslint" }).first(),
      ).toBeHidden();
    });

    test("file attachment rejects multiple files in one upload", async () => {
      await uploadFiles(page, [
        path.join(fixturesDir, "upload1.json"),
        path.join(fixturesDir, "upload2.json"),
      ]);

      const heading = page.getByRole("heading", {
        name: "Danger alert: File upload failed",
      });
      const text = page.getByText("Uploaded more than one file.");
      const closeBtn = page.getByRole("button", {
        name: "Close Danger alert:",
      });

      await assertVisibilityState("visible", heading, text, closeBtn);
      await closeBtn.evaluate((el: HTMLElement) => el.click());
      await assertVisibilityState("hidden", heading, text, closeBtn);
    });
  });

  test.describe("Conversation", () => {
    /** Alpha chat from "filter and switch conversations" — reused by Chat management. */
    let managementChatName: string;

    test("bot response, feedback submission, and copy to clipboard", async () => {
      await selectChatModel(page);
      await sendMessage(DEFAULT_BOT_QUERY, page);

      const userMessage = page.locator(".pf-chatbot__message--user").last();

      await expect(userMessage).toBeVisible();
      await expect(userMessage).toContainText(DEFAULT_BOT_QUERY);
      await expect(lastBotMessage(page)).toBeVisible();
      await getLastBotResponseText(page);

      await verifyFeedbackButtons(page);
      await submitFeedback(page, "Good response");
      await submitFeedback(page, "Bad response");

      await assertLastBotResponseCopiedToClipboard(page);
    });

    test("conversation is created and shown in side panel", async () => {
      await sendMessageInNewChat(page, "E2E sidebar conversation check");
      await verifySidePanelConversation(page);
    });

    test("scroll controls in conversation", async () => {
      const scrollPrompt =
        "Write a long numbered list of at least 20 Kubernetes deployment best practices. Use one line per item.";
      await sendMessageInNewChat(page, scrollPrompt);

      const jumpTopButton = page.getByRole("button", {
        name: "Back to top",
      });
      const jumpBottomButton = page.getByRole("button", {
        name: "Back to bottom",
      });

      await expect(jumpTopButton).toBeVisible({ timeout: 30_000 });
      await jumpTopButton.click();
      await expect(
        page
          .locator(".pf-chatbot__message--user")
          .filter({ hasText: scrollPrompt }),
      ).toBeVisible();

      await expect(jumpBottomButton).toBeVisible();
      await jumpBottomButton.click();

      const responseMessage = page
        .locator("div.pf-chatbot__message-response")
        .last();
      await expect(responseMessage).not.toBeEmpty();
    });

    test("filter and switch conversations", async () => {
      const runId = Date.now();
      const firstPrompt = `E2E_ALPHA_${runId}`;
      const secondPrompt = `E2E_BETA_${runId}`;
      const firstChatName = `E2E Alpha Chat ${runId}`;
      const secondChatName = `E2E Beta Chat ${runId}`;

      await startNewChatWithModel(page);
      await sendMessage(firstPrompt, page);
      await openActiveChatContextMenu(page);
      await selectRenameAction(page);
      await verifyRenameChatForm(page);
      await submitChatRename(page, firstChatName);
      await verifyChatRenamed(page, firstChatName);

      await startNewChatWithModel(page);
      await sendMessage(secondPrompt, page);
      await openActiveChatContextMenu(page);
      await selectRenameAction(page);
      await verifyRenameChatForm(page);
      await submitChatRename(page, secondChatName);
      await verifyChatRenamed(page, secondChatName);

      const sidePanel = page.locator(".pf-v6-c-drawer__panel-main");
      const chats = sidePanel.locator("li.pf-chatbot__menu-item");
      const searchBox = sidePanel.getByRole("textbox", { name: "Search" });
      const alphaChat = chats.filter({ hasText: firstChatName }).first();
      const betaChat = chats.filter({ hasText: secondChatName }).first();

      await expect(betaChat).toBeVisible({ timeout: 30_000 });
      await expect(alphaChat).toBeVisible();

      await searchBox.fill(secondChatName);
      await expect(betaChat).toBeVisible();
      await betaChat.click();

      await expect(
        page.locator(".pf-chatbot__message--user").last(),
      ).toContainText(secondPrompt);

      await searchBox.fill("");
      await alphaChat.click();
      await expect(
        page.locator(".pf-chatbot__message--user").last(),
      ).toContainText(firstPrompt);

      managementChatName = firstChatName;
    });

    test("stop ends in-progress reply and restores the prompt in the input", async () => {
      const stopFlowPrompt =
        "Write an extremely long and detailed essay about OpenShift architecture with at least 50 paragraphs.";

      await sendMessageInNewChat(page, stopFlowPrompt, false);
      await expectChatStopButtonVisible(page);
      await chatStopButton(page).click();
      await expectChatInputValue(page, stopFlowPrompt);
      await waitForChatMessageLoadingHidden(page, 15_000);
    });

    // eslint-disable-next-line playwright/max-nested-describe -- shared page session under Conversation
    test.describe("Chat management", () => {
      const testChatName = "Test Rename";

      test("chat menu options and rename conversation", async () => {
        await openChatContextMenuByName(page, managementChatName);
        await verifyChatContextMenuOptions(page);
        await selectRenameAction(page);
        await verifyRenameChatForm(page);
        await submitChatRename(page, testChatName);
        await verifyChatRenamed(page, testChatName);
      });

      test("pin chat and its actions with persistence", async () => {
        await openChatContextMenuByName(page, testChatName);
        await verifyPinActionAvailable(page);
        await selectPinAction(page);
        await verifyChatPinned(page, testChatName);
        await verifyPinnedChatsNotEmpty(page);

        await page.goto("/catalog");
        // eslint-disable-next-line playwright/no-networkidle
        await page.waitForLoadState("networkidle");
        await openChatbotFullscreenWithModel(page);
        await verifyChatPinned(page, testChatName);
        await verifyPinnedChatsNotEmpty(page);
      });

      test("unpin chat action removes chat from pinned section", async () => {
        await openPinnedChatContextMenuByName(page, testChatName);
        await verifyUnpinActionAvailable(page);
        await selectUnpinAction(page);
        await expect(
          page.getByRole("menu").filter({ hasText: "No pinned chats" }),
        ).toBeVisible();
        await verifyChatRenamed(page, testChatName);
      });

      test("delete chat and its actions", async () => {
        await verifyChatRenamed(page, testChatName);
        await openChatContextMenuByName(page, testChatName);
        await selectDeleteAction(page);
        await verifyDeleteConfirmation(page);
        await cancelChatDeletion(page);
        await verifyChatRenamed(page, testChatName);

        await openChatContextMenuByName(page, testChatName);
        await selectDeleteAction(page);
        await confirmChatDeletion(page);
        await verifyChatDeleted(page, testChatName);
      });

      test("disable pinned chats section via settings", async () => {
        await verifyPinnedSectionVisible(page);
        await verifyEmptyPinnedChatsMessage(page);
        await verifyChatbotSettingsVisible(page);
        await openChatbotSettings(page);
        await verifyDisablePinnedChatsOption(page);
        await selectDisablePinnedChats(page);
        await verifyPinnedSectionHidden(page);
        await verifyPinnedChatsNotEmpty(page);
      });

      test("enable pinned chats section via settings", async () => {
        await verifyPinnedSectionHidden(page);
        await verifyPinnedChatsNotEmpty(page);
        await openChatbotSettings(page);
        await verifyEnablePinnedChatsOption(page);
        await selectEnablePinnedChats(page);
        await verifyPinnedSectionVisible(page);
        await verifyEmptyPinnedChatsMessage(page);
      });

      test("search works as expected", async () => {
        await searchChats(page, "dummy search");
        await verifyEmptySearchResults(page);
      });

      test("sort dropdown is available", async () => {
        await page.getByRole("textbox", { name: "Search" }).fill("");
        await verifySortDropdownVisible(page);
        await openSortDropdown(page);
        await verifySortDropdownOptions(page);
        await closeSortDropdown(page);
      });

      test("conversations are sorted correctly and persist", async () => {
        const chats = page
          .locator(".pf-v6-c-drawer__panel-main")
          .locator("li.pf-chatbot__menu-item");

        if ((await chats.count()) < 4) {
          await sendMessageInNewChat(page, "E2E sort conversation zebra");
          await sendMessageInNewChat(page, "E2E sort conversation alpha");
        }

        await openSortDropdown(page);
        await selectSortOption(page, "alphabeticalAsc");
        await verifyConversationsSortedAlphabetically(page, "asc");

        await openSortDropdown(page);
        await selectSortOption(page, "alphabeticalDesc");
        await verifyConversationsSortedAlphabetically(page, "desc");

        await page.goto("/catalog");
        // eslint-disable-next-line playwright/no-networkidle
        await page.waitForLoadState("networkidle");
        await openChatbotFullscreenWithModel(page);
        // eslint-disable-next-line playwright/no-wait-for-timeout
        await page.waitForTimeout(2000);
        await verifyConversationsSortedAlphabetically(page, "desc");
      });
    });
  });
});
