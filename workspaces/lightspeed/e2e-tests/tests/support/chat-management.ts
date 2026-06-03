import { expect, type Locator, type Page } from "@playwright/test";

function historyDrawer(page: Page): Locator {
  return page.locator(".pf-v6-c-drawer__panel-main");
}

function drawerListItems(page: Page): Locator {
  return historyDrawer(page).locator("li");
}

export function pinnedChatItems(page: Page): Locator {
  return drawerListItems(page);
}

export function recentChatItems(page: Page): Locator {
  return drawerListItems(page);
}

async function openChatOptionsOnItem(chatItem: Locator): Promise<void> {
  await chatItem.locator("div").getByLabel("Options").click();
}

/** Opens the ⋮ menu on the active conversation in the history drawer. */
export async function openActiveChatContextMenu(page: Page): Promise<void> {
  await openChatOptionsOnItem(
    historyDrawer(page).locator("li.pf-chatbot__menu-item--active"),
  );
}

export async function openChatContextMenuByName(page: Page, chatName: string) {
  await openChatOptionsOnItem(
    historyDrawer(page)
      .locator("li.pf-chatbot__menu-item")
      .filter({ hasText: chatName }),
  );
}

export async function openPinnedChatContextMenuByName(
  page: Page,
  chatName: string,
) {
  await openChatOptionsOnItem(
    pinnedChatItems(page).filter({ hasText: chatName }),
  );
}

export async function verifyChatContextMenuOptions(page: Page) {
  await expect(page.locator("body")).toMatchAriaSnapshot(`
    - menuitem "Rename"
    - menuitem "Pin"
    - menuitem "Delete"
    `);
}

export async function selectRenameAction(page: Page) {
  await page.getByRole("menuitem", { name: "Rename" }).click();
}

export async function verifyRenameChatForm(page: Page) {
  await expect(page.locator("#rename-modal")).toContainText("Rename chat?");
  await expect(page.getByRole("textbox", { name: "Chat name" })).toBeVisible();
  await expect(page.getByLabel("Rename chat?")).toMatchAriaSnapshot(`
    - button "Rename" [disabled]
    - button "Cancel"
    `);
}

export async function submitChatRename(page: Page, newName: string) {
  await page.getByRole("textbox", { name: "Chat name" }).fill(newName);
  await page.getByRole("button", { name: "Rename" }).click();
}

export async function verifyChatRenamed(page: Page, chatName: string) {
  await expect(
    recentChatItems(page).filter({ hasText: chatName }),
  ).toBeVisible();
}

export async function verifyEmptyPinnedChatsMessage(page: Page) {
  await expect(
    page.getByRole("menuitem", { name: "No pinned chats" }),
  ).toBeVisible();
}

export async function verifyPinnedChatsNotEmpty(page: Page) {
  await expect(
    page.getByRole("menuitem", { name: "No pinned chats" }),
  ).not.toBeVisible();
}

export async function selectPinAction(page: Page) {
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
}

export async function selectUnpinAction(page: Page) {
  await page
    .getByRole("menuitem", {
      name: "Unpin",
      exact: true,
    })
    .click();
}

export async function verifyChatPinned(page: Page, chatName: string) {
  await expect(
    pinnedChatItems(page).filter({ hasText: chatName }),
  ).toBeVisible();
}

export async function verifyPinActionAvailable(page: Page) {
  await expect(
    page.getByRole("menuitem", { name: "Pin", exact: true }),
  ).toBeVisible();
}

export async function verifyUnpinActionAvailable(page: Page) {
  await expect(
    page.getByRole("menuitem", {
      name: "Unpin",
      exact: true,
    }),
  ).toBeVisible();
}

export async function selectDeleteAction(page: Page) {
  await page.getByRole("menuitem", { name: "Delete" }).click();
}

export async function verifyDeleteConfirmation(page: Page) {
  await expect(page.locator("#delete-modal")).toContainText("Delete chat?");
  await expect(page.locator("#delete-modal-body-confirmation")).toContainText(
    "You'll no longer see this chat here",
  );
}

export async function cancelChatDeletion(page: Page) {
  await page.getByRole("button", { name: "Cancel" }).click();
}

export async function confirmChatDeletion(page: Page) {
  await page
    .getByLabel("Delete chat?")
    .getByRole("button", { name: "Delete" })
    .click();
}

export async function verifyChatDeleted(page: Page, chatName: string) {
  await expect(
    historyDrawer(page)
      .locator("li.pf-chatbot__menu-item")
      .filter({ hasText: chatName }),
  ).toBeHidden();
}

export async function openChatbotSettings(page: Page) {
  await page.getByRole("button", { name: "Chatbot options" }).click();
}

export async function verifyChatbotSettingsVisible(page: Page) {
  await expect(
    page.getByRole("button", { name: "Chatbot options" }),
  ).toBeVisible();
}

export async function verifyPinnedSectionVisible(page: Page) {
  await expect(
    page.getByRole("heading", { name: "Pinned chats" }),
  ).toBeVisible();
}

export async function verifyPinnedSectionHidden(page: Page) {
  await expect(
    page.getByRole("heading", { name: "Pinned chats" }),
  ).toBeHidden();
}

export async function verifyDisablePinnedChatsOption(page: Page) {
  await expect(page.getByLabel("Chatbot", { exact: true }))
    .toMatchAriaSnapshot(`
    - menu:
      - menuitem "Disable pinned chats Pinned chats are currently enabled"
    `);
}

export async function verifyEnablePinnedChatsOption(page: Page) {
  await expect(page.getByLabel("Chatbot", { exact: true }))
    .toMatchAriaSnapshot(`
    - menu:
      - menuitem "Enable pinned chats Pinned chats are currently disabled"
    `);
}

export async function selectDisablePinnedChats(page: Page) {
  await page.getByRole("menuitem", { name: "Disable pinned chats" }).click();
}

export async function selectEnablePinnedChats(page: Page) {
  await page.getByRole("menuitem", { name: "Enable pinned chats" }).click();
}

export async function searchChats(page: Page, searchQuery: string) {
  await page.getByRole("textbox", { name: "Search" }).fill(searchQuery);
}

export async function verifyEmptySearchResults(page: Page) {
  await expect(page.locator(".pf-v6-c-drawer__panel-main"))
    .toMatchAriaSnapshot(`
    - heading "Pinned chats"
    - menu:
      - menuitem "No pinned chats"
    - heading "Chats"
    - menu:
      - menuitem "No result matches the search"
    `);
}

export type SortOption =
  | "newest"
  | "oldest"
  | "alphabeticalAsc"
  | "alphabeticalDesc";

const SORT_LABELS: Record<SortOption, string> = {
  newest: "Date (newest first)",
  oldest: "Date (oldest first)",
  alphabeticalAsc: "Name (A-Z)",
  alphabeticalDesc: "Name (Z-A)",
};

export async function openSortDropdown(page: Page) {
  await page.getByRole("button", { name: "Sort conversations" }).click();
}

export async function verifySortDropdownOptions(page: Page) {
  await expect(page.locator("#sort-select")).toMatchAriaSnapshot(`
    - listbox:
      - option "Date (newest first)"
      - option "Date (oldest first)"
      - option "Name (A-Z)"
      - option "Name (Z-A)"
    `);
}

export async function selectSortOption(page: Page, sortOption: SortOption) {
  await page.getByRole("option", { name: SORT_LABELS[sortOption] }).click();
}

export async function verifySortDropdownVisible(page: Page) {
  await expect(
    page.getByRole("button", { name: "Sort conversations" }),
  ).toBeVisible();
}

export async function closeSortDropdown(page: Page) {
  await page.keyboard.press("Escape");
}

export async function getConversationNames(page: Page): Promise<string[]> {
  const names: string[] = [];
  for (const item of await recentChatItems(page).all()) {
    const text = await item.textContent();
    if (text) {
      const normalized = text.replace(/\s+/g, " ").trim();
      if (
        normalized.length > 0 &&
        normalized !== "No pinned chats" &&
        normalized !== "No result matches the search"
      ) {
        names.push(normalized);
      }
    }
  }
  return names;
}

export async function verifyConversationsSortedAlphabetically(
  page: Page,
  order: "asc" | "desc" = "asc",
) {
  await expect
    .poll(
      async () => {
        const conversationNames = await getConversationNames(page);
        for (let i = 1; i < conversationNames.length; i += 1) {
          const cmp = conversationNames[i - 1].localeCompare(
            conversationNames[i],
            undefined,
            { sensitivity: "base" },
          );
          if ((order === "asc" && cmp > 0) || (order === "desc" && cmp < 0)) {
            return false;
          }
        }
        return true;
      },
      {
        timeout: 15_000,
      },
    )
    .toBe(true);
}
