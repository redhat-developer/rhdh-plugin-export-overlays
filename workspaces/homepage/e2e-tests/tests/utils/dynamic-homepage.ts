import {
  expect,
  type Locator,
  type Page,
} from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  LoginHelper,
  type UIhelper,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { KeycloakHelper } from "@red-hat-developer-hub/e2e-test-utils/keycloak";

const EXPECTED_CARD_TEXTS = [
  "Good (morning|afternoon|evening)",
  "Explore Your Software Catalog",
  "Recently Visited",
  "Top Visited",
] as const;

/** All widgets available in the "Add widget" dialog. */
export const AVAILABLE_WIDGETS = [
  "Onboarding Section",
  "Entity Section",
  "Recently visited",
  "Top visited",
] as const;

const COMMON = ["Explore Your Software Catalog"];
const ADMIN_ONLY = ["Explore Templates", "Quick Access"];
const DEVELOPER_ONLY = ["Recently Visited", "Top Visited"];

/** Expected default widgets per persona based on if.groups config. */
export const DEFAULT_WIDGETS = {
  admin: [...COMMON, ...ADMIN_ONLY, ...DEVELOPER_ONLY],
  developer: [...COMMON, ...DEVELOPER_ONLY],
  guest: [...COMMON],
  adminOnly: ADMIN_ONLY,
  developerOnly: DEVELOPER_ONLY,
};

export const HOMEPAGE_ADMIN = {
  username: "homepage-admin",
  password: "homepage-admin@123", // gitleaks:allow
};

const HOMEPAGE_TEST3 = {
  username: "test3",
  password: "test3@123", // gitleaks:allow
};

export async function setupKeycloakGroups(): Promise<void> {
  const keycloak = new KeycloakHelper();
  await keycloak.connect({
    baseUrl: process.env.KEYCLOAK_BASE_URL!,
    username: process.env.VAULT_KEYCLOAK_ADMIN_USERNAME!,
    password: process.env.VAULT_KEYCLOAK_ADMIN_PASSWORD!,
  });

  await keycloak.deleteUser("rhdh", HOMEPAGE_ADMIN.username).catch(() => {});
  await keycloak.createUser("rhdh", {
    username: HOMEPAGE_ADMIN.username,
    password: HOMEPAGE_ADMIN.password,
    firstName: "Homepage",
    lastName: "Admin",
    email: "homepage-admin@rhdh.test",
    groups: ["admins", "developers"],
  });

  await keycloak.deleteUser("rhdh", HOMEPAGE_TEST3.username).catch(() => {});
  await keycloak.createUser("rhdh", {
    username: HOMEPAGE_TEST3.username,
    password: HOMEPAGE_TEST3.password,
    firstName: "Test",
    lastName: "User3",
    email: "test3@rhdh.test",
    groups: ["viewers"],
  });
}

/**
 * Flows ported from rhdh e2e-tests/playwright/support/pages/home-page-customization.ts
 * (same locators/behavior, uses overlay UIhelper).
 */
export class DynamicHomePagePo {
  private baseURL = "";

  constructor(
    private readonly page: Page,
    private readonly ui: UIhelper,
  ) {}

  setBaseURL(url: string): void {
    this.baseURL = url;
  }

  private async signOut(): Promise<void> {
    await this.page.goto(`${this.baseURL}/settings`);
    await this.page.getByTestId("user-settings-menu").click();
    await this.page.getByTestId("sign-out").locator("div").click();
    // eslint-disable-next-line playwright/no-wait-for-timeout -- wait for sign-out redirect
    await this.page.waitForTimeout(2000);
  }

  async reloginAsKeycloakUser(
    username = "test1",
    password = "test1@123",
  ): Promise<void> {
    await this.signOut();
    await this.page.context().clearCookies();
    await this.page.goto(this.baseURL);
    await new LoginHelper(this.page).loginAsKeycloakUser(username, password);
  }

  async reloginAsNonGroupUser(): Promise<void> {
    await this.signOut();
    await this.page.context().clearCookies();
    await this.page.goto(this.baseURL);
    await new LoginHelper(this.page).loginAsKeycloakUser(
      HOMEPAGE_TEST3.username,
      HOMEPAGE_TEST3.password,
    );
  }

  private readonly editButton = () => this.page.getByText("Edit");
  private readonly saveButton = () =>
    this.page.getByText("Save", {
      exact: true,
    });
  private readonly clearAllButton = () =>
    this.page.getByRole("button", { name: "Clear all" });
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
    await expect(
      this.page.locator('[class*="react-grid-item"]').first(),
    ).toBeVisible({ timeout: 15_000 });
    await this.dismissQuickstart();
  }

  private async dismissQuickstart(): Promise<void> {
    const hideBtn = this.page.getByRole("button", { name: "Hide" });
    if (await hideBtn.isVisible()) {
      await hideBtn.click();
    }
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
    await this.enterEditMode();
    await this.deleteAllCards();
    await this.addWidget("Entity Section");
    await this.addWidget("Onboarding Section");
    await this.addWidget("Recently visited");
    await this.addWidget("Top visited");
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
    await this.page.waitForTimeout(500);
  }

  async deleteAllCards(): Promise<void> {
    await this.dismissQuickstart();
    for (let n = 0; n < 50; n++) {
      if ((await this.deleteButtons().count()) === 0) {
        break;
      }
      await this.deleteButtons().last().click();
      // eslint-disable-next-line playwright/no-wait-for-timeout -- wait for DOM to stabilize after card removal
      await this.page.waitForTimeout(2000);
    }
  }

  async clearAllCardsWithButton(): Promise<void> {
    await expect(this.clearAllButton()).toBeVisible({ timeout: 5_000 });
    // eslint-disable-next-line playwright/no-wait-for-timeout -- wait for edit mode to stabilize
    await this.page.waitForTimeout(500);
    await this.clearAllButton().click();
  }

  async verifyCardsDeleted(): Promise<void> {
    const gridItems = this.page.locator('[class*="react-grid-item"]');
    await expect(gridItems).toHaveCount(0, { timeout: 10_000 });
    await expect(this.restoreDefaultsButton()).toBeVisible();
    await expect(this.addWidgetButton()).toBeVisible();
  }

  async restoreDefaultCards(): Promise<void> {
    await this.ui.clickButton("Restore defaults");
    // eslint-disable-next-line playwright/no-wait-for-timeout -- upstream wait for layout
    await this.page.waitForTimeout(2000);
  }

  async resetToDefaults(): Promise<void> {
    await this.dismissQuickstart();
    await this.enterEditMode();
    await this.clearAllCardsWithButton();
    await expect(this.restoreDefaultsButton()).toBeVisible({ timeout: 5_000 });
    await this.restoreDefaultCards();
    await this.exitEditMode();
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

  /** Returns count of visible widget cards on the homepage grid. */
  async getVisibleCardCount(): Promise<number> {
    // eslint-disable-next-line playwright/no-wait-for-timeout -- wait for layout to stabilize
    await this.page.waitForTimeout(500);
    return this.page.locator('[class*="react-grid-item"]').count();
  }

  /** Verifies that exactly the given widget titles are visible on the homepage. */
  async verifySpecificCardsDisplayed(cardTexts: string[]): Promise<void> {
    for (const text of cardTexts) {
      await expect(
        this.page.getByText(text, { exact: true }).first(),
      ).toBeVisible({ timeout: 10_000 });
    }
  }

  /** Verifies a specific card text is NOT visible on the homepage. */
  async verifyCardNotDisplayed(cardText: string): Promise<void> {
    await expect(this.page.getByText(cardText, { exact: true })).toBeHidden();
  }

  /** Verifies the "Add widget" dialog lists all expected widget options. */
  async verifyAllWidgetsAvailableInDialog(): Promise<void> {
    await this.ui.clickButton("Add widget");
    // eslint-disable-next-line playwright/no-wait-for-timeout -- dialog open
    await this.page.waitForTimeout(1000);
    for (const widget of AVAILABLE_WIDGETS) {
      await expect(
        this.page.getByRole("button", { name: widget }),
      ).toBeVisible();
    }
    await this.page.keyboard.press("Escape");
  }

  /** Verifies default widgets from server config are displayed on first load. */
  async verifyDefaultWidgetsFromConfig(
    expectedTitles: string[] = [],
  ): Promise<void> {
    for (const title of expectedTitles) {
      await expect(
        this.page.getByText(title, { exact: true }).first(),
      ).toBeVisible({ timeout: 15_000 });
    }
  }
}
