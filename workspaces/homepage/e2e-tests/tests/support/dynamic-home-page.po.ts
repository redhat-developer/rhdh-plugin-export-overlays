import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";
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

  private editButton = () => this.page.getByText("Edit");
  private saveButton = () => this.page.getByText("Save", { exact: true });
  private clearAllButton = () => this.page.getByText("Clear all");
  private restoreDefaultsButton = () => this.page.getByText("Restore defaults");
  private addWidgetButton = () =>
    this.page.getByRole("button", { name: "Add widget" });
  private resizeHandles = () => this.page.locator(".react-resizable-handle");
  private deleteButtons = () =>
    this.page.locator('[class*="MuiGrid-root"][class*="overlayGridItem"]');
  private greetingText = () =>
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

  async resizeAllCards(): Promise<void> {
    const allHandles = this.resizeHandles();
    const handleCount = await allHandles.count();
    expect(handleCount).toBeGreaterThan(0);

    const initialDimensions = await this.getPanelDimensions(
      allHandles,
      handleCount,
    );
    await this.performResizeOnAllPanels(allHandles, handleCount);
    await this.verifyPanelsResized(allHandles, handleCount, initialDimensions);
  }

  private async getPanelDimensions(
    allHandles: Locator,
    handleCount: number,
  ): Promise<Array<{ width: number; height: number }>> {
    const initialDimensions: Array<{ width: number; height: number }> = [];
    for (let i = 0; i < handleCount; i++) {
      const panel = allHandles.nth(i).locator("..").locator("..");
      const box = await panel.boundingBox();
      expect(box).not.toBeNull();
      initialDimensions.push({ width: box!.width, height: box!.height });
    }
    return initialDimensions;
  }

  private async performResizeOnAllPanels(
    allHandles: Locator,
    handleCount: number,
  ): Promise<void> {
    for (let i = 0; i < handleCount; i++) {
      const handle = allHandles.nth(i);
      const handleEl = await handle.elementHandle();
      expect(handleEl).not.toBeNull();
      await this.page.evaluate(
        (handleElement: HTMLElement | SVGElement | null) => {
          if (!handleElement) {
            throw new Error("no handle element");
          }
          const win = handleElement.ownerDocument.defaultView;
          if (!win) {
            throw new Error("no window");
          }
          const rect = handleElement.getBoundingClientRect();
          const startX = rect.left + rect.width / 2;
          const startY = rect.top + rect.height / 2;
          const endX = startX + 300;
          const endY = startY + 300;

          const mouseDown = new win.MouseEvent("mousedown", {
            clientX: startX,
            clientY: startY,
            bubbles: true,
          });
          handleElement.dispatchEvent(mouseDown);

          win.setTimeout(() => {
            const mouseMove = new win.MouseEvent("mousemove", {
              clientX: endX,
              clientY: endY,
              bubbles: true,
            });
            handleElement.dispatchEvent(mouseMove);

            win.setTimeout(() => {
              const mouseUp = new win.MouseEvent("mouseup", {
                clientX: endX,
                clientY: endY,
                bubbles: true,
              });
              handleElement.dispatchEvent(mouseUp);
            }, 200);
          }, 200);
        },
        handleEl,
      );

      // eslint-disable-next-line playwright/no-wait-for-timeout -- upstream timing for resize
      await this.page.waitForTimeout(500);
    }
  }

  private async verifyPanelsResized(
    allHandles: Locator,
    handleCount: number,
    initialDimensions: Array<{ width: number; height: number }>,
  ): Promise<void> {
    for (let i = 0; i < handleCount; i++) {
      const panel = allHandles.nth(i).locator("..").locator("..");
      const finalBox = await panel.boundingBox();
      expect(finalBox).not.toBeNull();

      const widthChanged = finalBox!.width !== initialDimensions[i].width;
      const heightChanged = finalBox!.height !== initialDimensions[i].height;
      expect(widthChanged || heightChanged).toBe(true);
    }
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
