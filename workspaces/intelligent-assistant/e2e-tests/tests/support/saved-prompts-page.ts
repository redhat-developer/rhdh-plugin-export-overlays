import { expect, type Locator, type Page } from "@playwright/test";
import { expectChatInputValue } from "./conversation-helper";
import {
  closeChatHistoryDrawer,
  openChatHistoryDrawer,
} from "./lightspeed-page";
import { openLightspeed } from "./test-helper";

/**
 * Saved prompts sidebar + settings flows against a live RHDH deployment.
 * Ported from rhdh-plugins SavedPromptsPage (without route mocks / i18n bags).
 */
export class SavedPromptsPage {
  constructor(private readonly page: Page) {}

  chatbotRegion(): Locator {
    return this.page.getByLabel("Chatbot", { exact: true });
  }

  savedPromptsHistoryDrawer(): Locator {
    return this.chatbotRegion()
      .getByRole("dialog")
      .filter({
        has: this.page.getByRole("button", { name: "Close drawer panel" }),
      });
  }

  savedPromptsMenu(): Locator {
    return this.savedPromptsHistoryDrawer().getByRole("menu", {
      name: /Saved prompts/,
    });
  }

  savedPromptSidebarItem(promptName: string): Locator {
    return this.savedPromptsMenu().getByRole("menuitem", {
      name: promptName,
      exact: true,
    });
  }

  savedPromptKebabToggle(
    promptName: string,
    variant: "sidebar" | "settings",
  ): Locator {
    const label = `Actions for ${promptName}`;
    if (variant === "sidebar") {
      return this.savedPromptsMenu().getByRole("menuitem", { name: label });
    }
    return this.chatbotRegion().getByRole("button", { name: label });
  }

  kebabActionMenuItem(action: "apply" | "send" | "delete"): Locator {
    const names = {
      apply: "Apply in input box",
      send: "Send directly",
      delete: "Delete",
    } as const;
    return this.page.getByRole("menuitem", {
      name: names[action],
      exact: true,
    });
  }

  deleteSavedPromptDialog(promptName: string): Locator {
    return this.page.getByRole("dialog", {
      name: `Delete '${promptName}'?`,
    });
  }

  newPromptButton(): Locator {
    return this.page.getByRole("button", { name: "+ New prompt" });
  }

  titleField(): Locator {
    return this.page.getByPlaceholder("Prompt title");
  }

  contentField(): Locator {
    return this.page.getByPlaceholder("Prompt content");
  }

  saveFormButton(): Locator {
    return this.chatbotRegion().getByRole("button", {
      name: "Save",
      exact: true,
    });
  }

  async openChatShell(): Promise<void> {
    await openLightspeed(this.page);
  }

  async openSavedPromptsHistoryDrawer(): Promise<void> {
    await openChatHistoryDrawer(this.page);
    await expect(this.savedPromptsHistoryDrawer()).toBeVisible({
      timeout: 15_000,
    });
  }

  async closeSavedPromptsHistoryDrawer(): Promise<void> {
    await closeChatHistoryDrawer(this.page);
    await expect(this.savedPromptsHistoryDrawer()).toBeHidden({
      timeout: 15_000,
    });
  }

  async expectSavedPromptsSidebarLoaded(promptName: string): Promise<void> {
    await expect(this.savedPromptSidebarItem(promptName)).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      this.savedPromptsMenu().getByRole("menuitem", {
        name: "No saved prompts yet",
      }),
    ).toBeHidden();
  }

  openSavedPromptsSettingsGearButton(): Locator {
    return this.chatbotRegion().getByRole("button", {
      name: "Open saved prompts settings",
      exact: true,
    });
  }

  async openSavedPromptsSettingsFromSidebarGear(): Promise<void> {
    await this.openSavedPromptsHistoryDrawer();
    await this.savedPromptsHistoryDrawer()
      .getByRole("button", {
        name: /Saved prompts.*Open saved prompts settings/,
      })
      .hover();
    await expect(this.openSavedPromptsSettingsGearButton()).toBeVisible();
    await this.openSavedPromptsSettingsGearButton().click();
  }

  async expectSavedPromptsSettingsPanelVisible(): Promise<void> {
    await expect(
      this.chatbotRegion().getByRole("heading", {
        name: "Settings",
        exact: true,
        level: 2,
      }),
    ).toBeVisible();
    await expect(this.newPromptButton()).toBeVisible();
  }

  async applySavedPromptFromSidebar(promptName: string): Promise<void> {
    await this.expectSavedPromptsSidebarLoaded(promptName);
    await this.savedPromptSidebarItem(promptName).click();
  }

  async openSavedPromptKebabMenu(
    promptName: string,
    variant: "sidebar" | "settings",
  ): Promise<void> {
    await this.savedPromptKebabToggle(promptName, variant).click();
  }

  async selectKebabAction(action: "apply" | "send" | "delete"): Promise<void> {
    await this.kebabActionMenuItem(action).click();
  }

  async closeSettingsPanel(): Promise<void> {
    await this.page.getByRole("button", { name: "Close MCP settings" }).click();
  }

  async applySavedPromptFromKebab(
    promptName: string,
    variant: "sidebar" | "settings",
  ): Promise<void> {
    await this.openSavedPromptKebabMenu(promptName, variant);
    await this.selectKebabAction("apply");
    if (variant === "settings") {
      await this.closeSettingsPanel();
    }
  }

  async deleteSavedPromptFromKebab(
    promptName: string,
    variant: "sidebar" | "settings",
  ): Promise<void> {
    await this.openSavedPromptKebabMenu(promptName, variant);
    await this.selectKebabAction("delete");
    await this.deleteSavedPromptDialog(promptName)
      .getByRole("button", { name: "Delete", exact: true })
      .click();
  }

  async expectMessageInputValue(value: string): Promise<void> {
    await expectChatInputValue(this.page, value);
  }

  async openSavedPromptsSettingsTab(): Promise<void> {
    await this.page
      .locator(".pf-chatbot__header")
      .getByRole("button", { name: "Options" })
      .click();
    await this.page
      .getByRole("menuitem", { name: "MCP and Prompt Settings" })
      .click();
    await this.page
      .getByRole("button", { name: "Saved prompts", exact: true })
      .click();
    await expect(this.newPromptButton()).toBeVisible();
  }

  async createSavedPrompt(name: string, content: string): Promise<void> {
    await this.newPromptButton().click();
    await this.titleField().fill(name);
    await this.contentField().fill(content);
    await this.saveFormButton().click();
  }

  async expectSavedPromptVisibleInSettings(name: string): Promise<void> {
    await expect(this.savedPromptCardInSettings(name)).toBeVisible({
      timeout: 15_000,
    });
  }

  async expectSavedPromptHiddenInSettings(name: string): Promise<void> {
    await expect(this.savedPromptCardInSettings(name)).toBeHidden({
      timeout: 15_000,
    });
  }

  private savedPromptCardInSettings(name: string): Locator {
    return this.chatbotRegion()
      .getByTestId("saved-prompts-list")
      .getByText(name, { exact: true });
  }
}
