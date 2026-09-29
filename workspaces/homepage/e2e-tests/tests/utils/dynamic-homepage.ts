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

/** Add-widget dialog labels on the NFS (Backstage app) home page. */
export const AVAILABLE_WIDGETS = [
  "Red Hat Developer Hub - Onboarding",
  "Red Hat Developer Hub - Software Catalog",
  "Recently Visited",
  "Top Visited",
] as const;

/** Map stable test labels to NFS AddWidgetDialog button names. */
const WIDGET_DIALOG_LABELS = new Map<string, string>([
  ["Onboarding Section", "Red Hat Developer Hub - Onboarding"],
  ["Entity Section", "Red Hat Developer Hub - Software Catalog"],
  ["Entity section", "Red Hat Developer Hub - Software Catalog"],
  ["Recently Visited", "Recently Visited"],
  ["Top Visited", "Top Visited"],
]);

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

/**
 * Keycloak login that tolerates slow NFS cold loads.
 *
 * Stock LoginHelper.loginAsKeycloakUser uses waitForLoad (progressbar state:hidden
 * resolves immediately if the bar is not mounted yet) then clickButton("Sign In")
 * under actionTimeout=10s. On the NFS app shell the Sign In card often appears only
 * after ~30–60s of remote plugin loading, so login races and looks like a blank page.
 */
export async function loginAsKeycloakUser(
  page: Page,
  username = "test1",
  password = "test1@123",
): Promise<void> {
  const helper = new LoginHelper(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Sign In", exact: true }).waitFor({
    state: "visible",
    timeout: 240_000,
  });
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  const popup = await popupPromise;
  await helper.logintoKeycloak(popup, username, password);
  await page
    .locator("nav a")
    .first()
    .waitFor({ state: "visible", timeout: 60_000 });
}

export async function setupKeycloakGroups(): Promise<void> {
  const baseUrl = process.env.KEYCLOAK_BASE_URL;
  if (!baseUrl) {
    throw new Error(
      "KEYCLOAK_BASE_URL is not set. Global setup should deploy Keycloak and set it; " +
        "do not set SKIP_KEYCLOAK_DEPLOYMENT=true for homepage tests.",
    );
  }

  // Local Keycloak from e2e-test-utils uses admin/admin123. Vault secrets are for CI.
  const username =
    process.env.VAULT_KEYCLOAK_ADMIN_USERNAME ||
    process.env.KEYCLOAK_ADMIN_USERNAME ||
    "admin";
  const password =
    process.env.VAULT_KEYCLOAK_ADMIN_PASSWORD ||
    process.env.KEYCLOAK_ADMIN_PASSWORD ||
    "admin123";

  const keycloak = new KeycloakHelper();
  await keycloak.connect({
    baseUrl,
    username,
    password,
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

  /** Widget labels shown in the Add widget dialog. */
  get availableWidgets(): readonly string[] {
    return AVAILABLE_WIDGETS;
  }

  private widgetDialogLabel(widgetType: string): string {
    return WIDGET_DIALOG_LABELS.get(widgetType) ?? widgetType;
  }

  /**
   * Clears the CustomHomepageGrid storage bucket used by the home plugin.
   * Layout is stored under storageApi bucket `home.customHomepage` (often
   * localStorage). Clear between distinct users so shared browser storage
   * cannot leak layouts when user-settings isolation is unavailable.
   */
  async clearHomeLayoutStorage(): Promise<void> {
    await this.page.evaluate(() => {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (
          key &&
          (key.includes("home.customHomepage") ||
            key.includes("customHomepage") ||
            /[/:]home$/.test(key))
        ) {
          keysToRemove.push(key);
        }
      }
      for (const key of keysToRemove) {
        localStorage.removeItem(key);
      }
    });
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
    options?: { clearHomeStorage?: boolean },
  ): Promise<void> {
    await this.signOut();
    await this.page.context().clearCookies();
    if (options?.clearHomeStorage) {
      await this.clearHomeLayoutStorage();
    }
    await loginAsKeycloakUser(this.page, username, password);
  }

  async reloginAsNonGroupUser(): Promise<void> {
    await this.signOut();
    await this.page.context().clearCookies();
    // Guest/non-group user must not inherit the previous user's layout from
    // shared browser storage when switching accounts in the same context.
    await this.clearHomeLayoutStorage();
    await loginAsKeycloakUser(
      this.page,
      HOMEPAGE_TEST3.username,
      HOMEPAGE_TEST3.password,
    );
  }

  private readonly editButton = () =>
    this.page.getByRole("button", { name: "Edit", exact: true });
  private readonly saveButton = () =>
    this.page.getByRole("button", { name: "Save", exact: true });
  private readonly cancelButton = () =>
    this.page.getByRole("button", { name: "Cancel", exact: true });
  private readonly clearAllButton = () =>
    this.page.getByRole("button", { name: "Clear all" });
  private readonly restoreDefaultsButton = () =>
    this.page.getByText("Restore defaults");
  private readonly addWidgetButton = () =>
    this.page.getByRole("button", { name: "Add widget" });
  private readonly deleteButtons = () =>
    this.page.getByRole("button", { name: "Delete widget" });
  private readonly greetingText = () =>
    this.page.getByText(/Good (morning|afternoon|evening)/);

  async verifyHomePageLoaded(options?: {
    requireWidgets?: boolean;
  }): Promise<void> {
    await this.ui.verifyHeading("Welcome back");
    const requireWidgets = options?.requireWidgets ?? true;
    if (requireWidgets) {
      await expect(
        this.page.locator('[class*="react-grid-item"]').first(),
      ).toBeVisible({ timeout: 15_000 });
    }
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
    await this.addWidget("Recently Visited");
    await this.addWidget("Top Visited");
    await this.exitEditMode();
  }

  async enterEditMode(): Promise<void> {
    await this.ui.clickButton("Edit");
    // NFS edit mode shows both Cancel and Save; .or() + toBeVisible() hits strict mode
    // when both match — wait for either via .first().
    await this.saveButton()
      .or(this.cancelButton())
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
  }

  async exitEditMode(): Promise<void> {
    await this.dismissAddWidgetDialog();

    // NFS only surfaces Save after a layout dimension change; add/remove alone leaves
    // Save hidden and Cancel reverts to the last persisted layout.
    if (!(await this.saveButton().isVisible())) {
      await this.nudgeLayoutToEnableSave();
    }

    if (await this.saveButton().isVisible()) {
      await this.saveButton().click();
    } else if (await this.cancelButton().isVisible()) {
      await this.cancelButton().click();
    }
    await expect(this.editButton()).toBeVisible({ timeout: 10_000 });
  }

  private async dismissAddWidgetDialog(): Promise<void> {
    const dialog = this.page.getByRole("dialog");
    if (await dialog.isVisible()) {
      await this.page.keyboard.press("Escape");
      await expect(dialog).toBeHidden({ timeout: 5_000 });
    }
  }

  /** Small resize so NFS edit toolbar exposes Save after widget add/remove. */
  private async nudgeLayoutToEnableSave(): Promise<void> {
    const gridItem = this.editableGridItem();
    if ((await gridItem.count()) === 0) {
      return;
    }
    const handle = gridItem
      .locator(".react-resizable-handle-se, .react-resizable-handle")
      .last();
    if (!(await handle.isVisible())) {
      return;
    }
    await this.dragResizeHandle(handle, { widthDelta: 0, heightDelta: 40 });
    await this.saveButton().waitFor({ state: "visible", timeout: 10_000 });
  }

  /** Grid item that contains a real widget (not an empty placeholder row). */
  private editableGridItem(): Locator {
    return this.page
      .locator('[class*="react-grid-item"]')
      .filter({ has: this.deleteButtons() })
      .last();
  }

  /**
   * Resizes one card via the SE resize handle (while still in edit mode, before Save).
   * Call after `enterEditMode` and adding a widget.
   */
  async resizeFirstCard(): Promise<void> {
    const gridItem = this.editableGridItem();
    await expect(gridItem).toBeVisible({ timeout: 10_000 });

    const handle = gridItem
      .locator(".react-resizable-handle-se, .react-resizable-handle")
      .last();
    await expect(handle).toBeVisible();

    const initialBox = await gridItem.boundingBox();
    expect(initialBox).not.toBeNull();

    await this.dragResizeHandle(handle);

    // Measure the grid item — NFS widgets are full width so only height changes.
    await expect
      .poll(async () => {
        const box = await gridItem.boundingBox();
        if (!box || !initialBox) {
          return false;
        }
        return (
          Math.abs(box.height - initialBox.height) > 5 ||
          Math.abs(box.width - initialBox.width) > 5
        );
      })
      .toBe(true);
  }

  private async dragResizeHandle(
    handle: Locator,
    deltas?: { widthDelta?: number; heightDelta?: number },
  ): Promise<void> {
    await handle.scrollIntoViewIfNeeded();
    const box = await handle.boundingBox();
    expect(box).not.toBeNull();
    const startX = box!.x + box!.width / 2;
    const startY = box!.y + box!.height / 2;
    // NFS widgets default to full grid width — drag vertically to resize height.
    const widthDelta = deltas?.widthDelta ?? 0;
    const heightDelta = deltas?.heightDelta ?? 220;
    await this.page.mouse.move(startX, startY);
    await this.page.mouse.down();
    await this.page.mouse.move(startX + widthDelta, startY + heightDelta, {
      steps: 24,
    });
    await this.page.mouse.up();
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

  /** Clear all only when the grid has cards (NFS home may start empty). */
  async clearAllCardsIfPresent(): Promise<void> {
    if (await this.clearAllButton().isVisible()) {
      await this.clearAllCardsWithButton();
      await this.verifyCardsDeleted();
    }
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
    const label = this.widgetDialogLabel(widgetType);
    const gridItems = this.page.locator('[class*="react-grid-item"]');
    const countBefore = await gridItems.count();

    await this.ui.clickButton("Add widget");
    const widgetOption = this.page.getByRole("button", { name: label });
    await widgetOption.waitFor({ state: "visible", timeout: 30_000 });
    await widgetOption.click();

    await expect(gridItems).toHaveCount(countBefore + 1, { timeout: 30_000 });
    await expect(gridItems.last()).toBeVisible({ timeout: 30_000 });
    await this.dismissAddWidgetDialog();
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
    for (const widget of this.availableWidgets) {
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
