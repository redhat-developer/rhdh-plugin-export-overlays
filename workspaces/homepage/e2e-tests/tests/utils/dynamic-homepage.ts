import {
  expect,
  type Locator,
  type Page,
} from "@red-hat-developer-hub/e2e-test-utils/test";
import type { UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";

const EXPECTED_CARD_TEXTS = [
  "Good (morning|afternoon|evening)",
  "Explore Your Software Catalog",
  "Recently Visited",
  "Top Visited",
] as const;

/**
 * Flows ported from rhdh e2e-tests/playwright/support/pages/home-page-customization.ts
 * (same locators/behavior, uses overlay UIhelper).
 */
export class DynamicHomePagePo {
  constructor(
    private readonly page: Page,
    private readonly ui: UIhelper,
  ) {}

  private readonly editButton = () => this.page.getByText("Edit");
  private readonly saveButton = () =>
    this.page.getByText("Save", {
      exact: true,
    });
  private readonly clearAllButton = () => this.page.getByText("Clear all");
  private readonly restoreDefaultsButton = () =>
    this.page.getByText("Restore defaults");
  private readonly addWidgetButton = () =>
    this.page.getByRole("button", { name: "Add widget" });
  private readonly resizeHandles = () =>
    this.page.locator(".react-resizable-handle");
  private readonly deleteButtons = () =>
    this.page.getByRole("button", { name: "Delete widget" });
  private readonly greetingText = () =>
    this.page.getByText(/Good (morning|afternoon|evening)/);

  async verifyHomePageLoaded(): Promise<void> {
    await this.ui.verifyHeading("Welcome back");
    await expect(this.greetingText()).toBeVisible();
  }

  async verifyAllCardsDisplayed(): Promise<void> {
    for (const card of EXPECTED_CARD_TEXTS) {
      if (card.startsWith("Good")) {
        await expect(this.greetingText()).toBeVisible();
      } else {
        await this.ui.verifyText(card);
      }
    }
  }

  async verifyEditButtonVisible(): Promise<void> {
    await this.ui.verifyText("Edit");
  }

  /**
   * Adds the default home cards through Add widget (dialog labels must match the UI).
   * Used when tests need a full grid without relying on restore-defaults (skipped / broken).
   */
  async seedHomePageWidgets(): Promise<void> {
    await this.addWidget("Entity Section");
    await this.enterEditMode();
    await this.addWidget("Onboarding Section");
    await this.addWidget("Recently visited");
    await this.addWidget("Top visited");
    await this.addWidget("Random joke");
    await this.exitEditMode();
  }

  async enterEditMode(): Promise<void> {
    await this.ui.clickButton("Edit");
    await expect(this.saveButton()).toBeVisible();
  }

  async exitEditMode(): Promise<void> {
    await this.ui.clickButton("Save");
    await expect(this.editButton()).toBeVisible();
  }

  /**
   * Resizes one card via the first visible resize handle (while still in edit
   * mode, before Save). Call after `enterEditMode` and adding a widget.
   */
  async resizeFirstCard(): Promise<void> {
    const handle = this.resizeHandles().first();
    await expect(handle).toBeVisible();
    const panel = this.resizablePanelForHandle(handle);
    const initialBox = await panel.boundingBox();
    expect(initialBox).not.toBeNull();

    await this.dragResizeHandle(handle);

    const finalBox = await panel.boundingBox();
    expect(finalBox).not.toBeNull();
    const widthChanged = finalBox!.width !== initialBox!.width;
    const heightChanged = finalBox!.height !== initialBox!.height;
    expect(widthChanged || heightChanged).toBe(true);
  }

  /** Nearest `react-resizable` root for a handle (`.react-resizable-handle`). */
  private resizablePanelForHandle(handle: Locator): Locator {
    return handle.locator(
      'xpath=ancestor::*[contains(@class,"react-resizable")][1]',
    );
  }

  private async dragResizeHandle(handle: Locator): Promise<void> {
    await handle.scrollIntoViewIfNeeded();
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    const startX = box!.x + box!.width / 2;
    const startY = box!.y + box!.height / 2;
    const delta = 160;
    await this.page.mouse.move(startX, startY);
    await this.page.mouse.down();
    await this.page.mouse.move(startX + delta, startY + delta, { steps: 12 });
    await this.page.mouse.up();
    // eslint-disable-next-line playwright/no-wait-for-timeout -- layout after resize
    await this.page.waitForTimeout(600);
  }

  async deleteAllCards(): Promise<void> {
    for (let n = 0; n < 50; n++) {
      const currentButtons = this.deleteButtons();
      const currentCount = await currentButtons.count();
      if (currentCount === 0) {
        break;
      }
      await currentButtons.first().click();
      // eslint-disable-next-line playwright/no-wait-for-timeout -- upstream timing between deletes
      await this.page.waitForTimeout(1000);
    }
  }

  async clearAllCardsWithButton(): Promise<void> {
    await this.ui.clickButton("Clear all");
  }

  async verifyCardsDeleted(): Promise<void> {
    await expect(this.clearAllButton()).toBeHidden();
    await expect(this.saveButton()).toBeHidden();
    await expect(this.restoreDefaultsButton()).toBeVisible();
    await expect(this.addWidgetButton()).toBeVisible();

    for (const card of EXPECTED_CARD_TEXTS) {
      if (card.startsWith("Good")) {
        await expect(this.greetingText()).toBeHidden();
      } else {
        await expect(this.page.getByText(card)).toBeHidden();
      }
    }
  }

  async restoreDefaultCards(): Promise<void> {
    await this.ui.clickButton("Restore defaults");
    // eslint-disable-next-line playwright/no-wait-for-timeout -- upstream wait for layout
    await this.page.waitForTimeout(2000);
  }

  async verifyCardsRestored(): Promise<void> {
    await this.verifyAllCardsDisplayed();
    await expect(this.editButton()).toBeVisible();
  }

  async addWidget(widgetType: string): Promise<void> {
    await this.ui.clickButton("Add widget");
    // eslint-disable-next-line playwright/no-wait-for-timeout -- dialog open
    await this.page.waitForTimeout(1000);
    await this.page.getByRole("button", { name: widgetType }).click();
    // eslint-disable-next-line playwright/no-wait-for-timeout -- widget mount
    await this.page.waitForTimeout(1000);
  }
}
