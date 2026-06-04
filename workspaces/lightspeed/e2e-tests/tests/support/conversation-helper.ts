import { expect, type Page } from "@playwright/test";
import { selectChatModel } from "./lightspeed-page";

export const CHAT_PROMPT_PLACEHOLDER = "Enter a prompt for Lightspeed";
const BOT_RESPONSE_TIMEOUT_MS = 180_000;

export async function sendMessage(
  message: string,
  page: Page,
  waitForResponse = true,
): Promise<void> {
  const input = page.getByRole("textbox", { name: CHAT_PROMPT_PLACEHOLDER });
  await input.fill(message);
  await page.getByRole("button", { name: "Send" }).click();
  if (waitForResponse) {
    await waitForChatMessageLoadingHidden(page);
    const sidePanel = page.locator(".pf-v6-c-drawer__panel-main");
    await expect(sidePanel).toBeVisible();
    await expect(
      sidePanel.getByRole("button", { name: "New Chat" }),
    ).toBeEnabled({ timeout: 60_000 });
  }
}

export async function waitForChatMessageLoadingHidden(
  page: Page,
  timeout = BOT_RESPONSE_TIMEOUT_MS,
): Promise<void> {
  await page
    .locator(".pf-chatbot__message-loading")
    .waitFor({ state: "hidden", timeout });
}

export function chatStopButton(page: Page) {
  return page.getByRole("button", { name: "Stop" });
}

export async function expectChatStopButtonVisible(
  page: Page,
  timeout = 15_000,
): Promise<void> {
  await expect(chatStopButton(page)).toBeVisible({ timeout });
}

export async function expectChatInputValue(
  page: Page,
  value: string,
): Promise<void> {
  await expect(
    page.getByRole("textbox", { name: CHAT_PROMPT_PLACEHOLDER }),
  ).toHaveValue(value);
}

export async function startNewChat(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New Chat" }).click();
  await expect(
    page.getByRole("textbox", { name: CHAT_PROMPT_PLACEHOLDER }),
  ).toBeVisible();
}

/** Starts a blank chat and ensures the default GPT model is selected. */
export async function startNewChatWithModel(
  page: Page,
  modelName?: string,
): Promise<void> {
  await startNewChat(page);
  await selectChatModel(page, modelName);
}

/** Starts a fresh chat with model selected, then sends a message. */
export async function sendMessageInNewChat(
  page: Page,
  message: string,
  waitForResponse = true,
  modelName?: string,
): Promise<void> {
  await startNewChatWithModel(page, modelName);
  await sendMessage(message, page, waitForResponse);
}

export async function verifyFeedbackButtons(page: Page): Promise<void> {
  const responseActions = page.locator(".pf-chatbot__response-actions");
  await expect(responseActions).toBeVisible();
  for (const name of ["Good response", "Bad response", "Copy", "Listen"]) {
    await expect(responseActions.getByRole("button", { name })).toBeVisible();
  }
}

export async function submitFeedback(
  page: Page,
  ratingButtonName: "Good response" | "Bad response",
): Promise<void> {
  await page.getByRole("button", { name: ratingButtonName }).click();

  const feedbackCard = page.getByLabel("Why did you choose this rating?");
  await expect(feedbackCard).toBeVisible();

  const quickFeedbackLabels = feedbackCard.locator("li");
  expect(await quickFeedbackLabels.count()).toEqual(3);
  await quickFeedbackLabels.first().click();

  await feedbackCard.getByRole("button", { name: "Submit" }).click();

  const feedbackConfirmationPanel = page.getByLabel("Feedback submitted");
  await expect(feedbackConfirmationPanel).toBeVisible();
  await expect(feedbackConfirmationPanel).toContainText(
    "We've received your response. Thank you for sharing your feedback!",
  );
  await feedbackConfirmationPanel.waitFor({ state: "hidden" });
}

export function lastBotMessage(page: Page) {
  return page.locator(".pf-chatbot__message--bot").last();
}

/** Response body only — excludes model name, timestamp, and action buttons. */
export function lastBotResponseBody(page: Page) {
  return lastBotMessage(page).locator(".pf-chatbot__message-response");
}

export async function getLastBotResponseText(page: Page): Promise<string> {
  const body = lastBotResponseBody(page);
  await expect(body).toBeVisible();
  const text = (await body.innerText()).trim();
  expect(text.length).toBeGreaterThan(0);
  return text;
}

/**
 * Asserts Copy puts the visible bot reply on the clipboard (content is non-deterministic).
 */
export async function assertLastBotResponseCopiedToClipboard(
  page: Page,
): Promise<void> {
  const responseText = await getLastBotResponseText(page);
  const copyButton = lastBotMessage(page)
    .locator(".pf-chatbot__response-actions")
    .getByRole("button", { name: "Copy" });

  await copyButton.click();

  const clipboardText = (
    await page.evaluate(() => navigator.clipboard.readText())
  ).trim();
  expect(clipboardText.length).toBeGreaterThan(0);

  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const normalizedClipboard = normalize(clipboardText);
  const normalizedResponse = normalize(responseText);

  expect(
    normalizedClipboard === normalizedResponse ||
      normalizedClipboard.includes(normalizedResponse) ||
      normalizedResponse.includes(normalizedClipboard),
  ).toBeTruthy();
}

export async function verifySidePanelConversation(page: Page): Promise<void> {
  const sidePanel = page.locator(".pf-v6-c-drawer__panel-main");
  await expect(sidePanel).toBeVisible();
  await expect(sidePanel.getByRole("button", { name: "New Chat" })).toBeEnabled(
    { timeout: 60_000 },
  );
  await expect(
    sidePanel.locator("li.pf-chatbot__menu-item--active"),
  ).toBeVisible();
}
