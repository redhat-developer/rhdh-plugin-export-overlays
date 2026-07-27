import { expect, type Locator, type Page } from "@playwright/test";

export async function assertChatDialogInitialState(page: Page): Promise<void> {
  await expect(page.getByLabel("Chatbot", { exact: true })).toContainText(
    "Developer Lightspeed",
  );

  const chatHistoryMenu = page.getByRole("button", {
    name: "Chat history menu",
  });
  const closeDrawerButton = page.getByRole("button", {
    name: "Close drawer panel",
  });

  if (await chatHistoryMenu.isVisible().catch(() => false)) {
    await expect(chatHistoryMenu).toBeVisible();
  } else {
    await expect(closeDrawerButton).toBeVisible();
  }

  await assertDrawerState(page, "open");

  await expect(page.locator(".pf-v6-c-drawer__panel-main"))
    .toMatchAriaSnapshot(`
      - heading "Pinned chats"
      - menu:
        - menuitem "No pinned chats"
      - heading "Chats"
      - menu:
        - menuitem "No recent chats"
      `);
}

export async function closeChatDrawer(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Close drawer panel" }).click();
}

export async function openChatDrawer(page: Page): Promise<void> {
  const chatHistoryMenu = page.getByRole("button", {
    name: "Chat history menu",
  });
  const expandHistory = page.getByRole("button", {
    name: "Expand chat history",
  });

  if (await chatHistoryMenu.isVisible().catch(() => false)) {
    await chatHistoryMenu.click();
  } else {
    await expect(expandHistory).toBeVisible({ timeout: 5_000 });
    await expandHistory.click();
  }

  await expect(
    page.getByRole("button", { name: "Close drawer panel" }),
  ).toBeVisible({ timeout: 5_000 });
}

export async function assertDrawerState(
  page: Page,
  state: "open" | "closed",
): Promise<void> {
  const expectations = {
    open: (locator: Locator) => expect(locator).toBeVisible(),
    closed: (locator: Locator) => expect(locator).toBeHidden(),
  };

  for (const locator of [
    page.getByRole("button", { name: "Close drawer panel" }),
    page.getByRole("textbox", { name: "Search" }),
    page.locator(".pf-v6-c-drawer__splitter"),
  ]) {
    await expectations[state](locator);
  }
}
