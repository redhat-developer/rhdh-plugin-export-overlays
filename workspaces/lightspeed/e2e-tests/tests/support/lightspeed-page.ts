import { expect, type Page } from "@playwright/test";

export type DisplayMode = "Overlay" | "Dock to window" | "Fullscreen";

/** Default OpenAI model for conversation e2e tests (matches app-config queryDefaults). */
export const DEFAULT_CHAT_MODEL = "gpt-5.1";

export function chatModelSelector(page: Page) {
  return page.getByRole("button", { name: "Chatbot selector" });
}

/** Opens the model dropdown and selects a model; no-op if already selected. */
export async function selectChatModel(
  page: Page,
  modelName: string = DEFAULT_CHAT_MODEL,
): Promise<void> {
  const dropdown = chatModelSelector(page);
  await expect(dropdown).toBeVisible({ timeout: 60_000 });

  if ((await dropdown.textContent())?.includes(modelName)) {
    return;
  }

  const menuitem = page.getByRole("menuitem", {
    name: modelName,
    exact: true,
  });
  if (!(await menuitem.isVisible())) {
    await dropdown.click();
  }
  await menuitem.click();
  await expect(dropdown).toContainText(modelName);
}

export async function openChatbot(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open Lightspeed" }).click();
}

export async function selectDisplayMode(
  page: Page,
  mode: DisplayMode,
): Promise<void> {
  await page.getByRole("button", { name: "Chatbot options" }).click();
  await page.getByRole("menuitem", { name: mode }).click();
}

export async function openChatHistoryDrawer(page: Page): Promise<void> {
  const chatHistoryMenu = page.getByRole("button", {
    name: "Chat history menu",
  });
  const expandHistory = page.getByRole("button", {
    name: "Expand chat history",
  });

  if (await chatHistoryMenu.isVisible()) {
    await chatHistoryMenu.click();
  } else if (await expandHistory.isVisible()) {
    await expandHistory.click();
  }
}

export async function closeChatHistoryDrawer(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Close drawer panel" }).click();
}

export async function expectRhdhContentVisible(
  page: Page,
  visible = true,
): Promise<void> {
  // Fresh deployments can briefly show only a global progress bar before shell content.
  const initialLoading = page.getByRole("progressbar").first();
  await initialLoading
    .waitFor({ state: "hidden", timeout: 30_000 })
    .catch(() => {
      /* no-op */
    });

  const shell = page
    .getByText(/welcome back!/i)
    .or(page.getByText("My Org Catalog"))
    .or(page.getByRole("heading", { name: /All components/i }))
    .or(page.getByRole("button", { name: "Open Lightspeed" }));

  if (visible) {
    await expect(shell.first()).toBeVisible({ timeout: 30_000 });
  } else {
    await expect(shell.first()).toBeHidden({ timeout: 30_000 });
  }
}

/** Opens Lightspeed chatbot in fullscreen from the RHDH shell (avoids /lightspeed route). */
export async function openChatbotFullscreen(page: Page): Promise<void> {
  await expectRhdhContentVisible(page);
  await openChatbot(page);
  await selectDisplayMode(page, "Fullscreen");
}

/** Opens fullscreen chatbot from the RHDH shell and selects the default model. */
export async function openChatbotFullscreenWithModel(
  page: Page,
  modelName: string = DEFAULT_CHAT_MODEL,
): Promise<void> {
  await openChatbotFullscreen(page);
  await selectChatModel(page, modelName);
}

export async function expectChatbotControlsVisible(page: Page): Promise<void> {
  await expect(page.locator(".pf-chatbot__header")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Chatbot options" }),
  ).toBeVisible();
}

export async function verifyDisplayModeMenuOptions(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Chatbot options" }).click();
  const settingsMenu = page
    .getByRole("menu")
    .filter({
      has: page.getByRole("menuitem", { name: "Display mode" }),
    })
    .first();

  await expect(settingsMenu).toBeVisible();
  await expect(
    settingsMenu.getByRole("menuitem", { name: "Display mode" }),
  ).toBeDisabled();

  for (const name of ["Overlay", "Dock to window", "Fullscreen"]) {
    await expect(settingsMenu.getByRole("menuitem", { name })).toBeVisible();
  }

  for (const name of [
    "Disable pinned chats Pinned chats are currently enabled",
    "MCP settings",
  ]) {
    await expect(page.getByRole("menuitem", { name })).toBeVisible();
  }
}

export async function expectChatInputAreaVisible(page: Page): Promise<void> {
  await expect(
    page.getByRole("textbox", { name: "Enter a prompt for Lightspeed" }),
  ).toBeVisible();
}

export async function expectEmptyChatHistory(page: Page): Promise<void> {
  for (const { name, exact } of [
    { name: "Pinned chats" },
    { name: "Chats", exact: true },
  ]) {
    await expect(
      page.getByRole("heading", exact ? { name, exact: true } : { name }),
    ).toBeVisible();
  }

  for (const name of ["No pinned chats", "No recent chats"]) {
    await expect(page.getByRole("menuitem", { name })).toBeVisible();
  }
}

export async function expectConversationArea(
  page: Page,
  mode: DisplayMode,
): Promise<void> {
  const messageLog = page.getByLabel("Scrollable message log");
  const greetingName = process.env.RHDH_DISPLAY_NAME ?? "Test User1";

  await expect(
    messageLog.getByRole("heading", { name: /Info alert: Important/i }),
  ).toBeVisible();
  await expect(messageLog.getByText(/AI technology/)).toBeVisible();
  await expect(messageLog.getByRole("heading", { level: 1 })).toContainText(
    `Hello, ${greetingName}`,
  );
  await expect(messageLog.getByRole("heading", { level: 1 })).toContainText(
    "How can I help you today?",
  );

  // Real RHDH renders named sample prompts — not the empty `- button` / `- text: ''`
  // placeholders used in the plugin repo's mocked dev-mode aria snapshots.
  const promptButtons = messageLog.getByRole("button");
  const promptCount = await promptButtons.count();
  expect(promptCount).toBeGreaterThanOrEqual(1);

  if (mode === "Dock to window") {
    expect(promptCount).toBeGreaterThanOrEqual(2);
  } else if (mode === "Fullscreen") {
    expect(promptCount).toBeGreaterThanOrEqual(3);
  }
}
