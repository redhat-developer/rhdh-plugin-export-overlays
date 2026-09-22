import { Page, expect } from "@playwright/test";
import { UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";

export class ThemeVerifier {
  constructor(
    readonly page: Page,
    readonly uiHelper: UIhelper,
  ) {}

  async setTheme(theme: string) {
    await this.goToSettingsPage();
    await this.uiHelper.clickBtnByTitleIfNotPressed(`Select ${theme}`);
    const themeButton = this.page.getByRole("button", {
      name: theme,
      exact: true,
    });
    await this.goToSettingsPage();

    await expect(themeButton).toHaveAttribute("aria-pressed", "true");
  }

  async verifyAppBarColor(expectedColor: string) {
    const globalHeader = this.page.locator("nav#global-header").first();
    await expect(globalHeader).toBeVisible();
    await expect(globalHeader).toHaveCSS(
      "background-color",
      this.toRgb(expectedColor),
    );
  }

  async verifyPrimaryColors(colorPrimary: string) {
    const expectedRgbColor = this.toRgb(colorPrimary);
    await this.checkCssColor(
      this.page,
      ".MuiTypography-colorPrimary",
      expectedRgbColor,
    );
    await this.checkCssColor(
      this.page,
      ".MuiSwitch-colorPrimary",
      expectedRgbColor,
    );
    await this.page.goto("/catalog");
    await this.page.waitForLoadState("domcontentloaded");
    await this.checkCssColor(
      this.page,
      ".MuiButton-textPrimary",
      expectedRgbColor,
    );
  }

  private async goToSettingsPage() {
    await expect(this.page.getByRole("navigation").first()).toBeVisible();
    await this.uiHelper.openProfileDropdown();
    await this.page.getByRole("menuitem", { name: "Settings" }).click();
  }

  private async checkCssColor(
    page: Page,
    selector: string,
    expectedColor: string,
  ) {
    const elements = page.locator(selector);
    const count = await elements.count();

    for (let i = 0; i < count; i++) {
      const color = await elements
        .nth(i)
        .evaluate((el) => window.getComputedStyle(el).color);
      expect(color).toBe(expectedColor);
    }
  }

  private toRgb(color: string): string {
    if (color.startsWith("rgb")) {
      return color;
    }

    const bigint = parseInt(color.slice(1), 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return `rgb(${r}, ${g}, ${b})`;
  }
}
