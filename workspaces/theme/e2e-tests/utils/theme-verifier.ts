import { Page, expect } from "@playwright/test";
import { UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";

export class ThemeVerifier {
  constructor(
    readonly page: Page,
    readonly uiHelper: UIhelper,
  ) {}

  async setTheme(
    theme: "Light" | "Dark" | "RHDH Plugins QE Light" | "RHDH Plugins QE Dark",
  ) {
    await this.goToSettingsPage();
    await this.uiHelper.clickBtnByTitleIfNotPressed(`Select ${theme}`);
    const themeButton = this.page.getByRole("button", {
      name: theme,
      exact: true,
    });
    await this.goToSettingsPage();

    await expect(themeButton).toHaveAttribute("aria-pressed", "true");
  }

  async verifyHeaderGradient(expectedGradient: string) {
    const header = this.page.locator("main header").first();
    await expect(header).toBeVisible();
    await expect(header).toHaveCSS("background-image", expectedGradient);
  }

  async verifyBorderLeftColor(expectedColor: string) {
    await this.uiHelper.openSidebar("Home");
    const homeLinkLocator = this.page.locator("a").filter({ hasText: "Home" });
    await expect(homeLinkLocator).toHaveCSS(
      "border-left",
      `3px solid ${expectedColor}`,
    );
  }

  async verifyPrimaryColors(colorPrimary: string) {
    await this.checkCssColor(
      this.page,
      ".MuiTypography-colorPrimary",
      colorPrimary,
    );
    await this.checkCssColor(
      this.page,
      ".MuiSwitch-colorPrimary",
      colorPrimary,
    );
    await this.uiHelper.openSidebar("Catalog");
    await this.checkCssColor(this.page, ".MuiButton-textPrimary", colorPrimary);
  }

  private async goToSettingsPage() {
    await expect(this.page.locator("nav[id='global-header']")).toBeVisible();
    await this.uiHelper.openProfileDropdown();
    await this.uiHelper.clickLink("Settings");
  }

  private async checkCssColor(
    page: Page,
    selector: string,
    expectedColor: string,
  ) {
    const elements = page.locator(selector);
    const count = await elements.count();
    const expectedRgbColor = this.toRgb(expectedColor);

    for (let i = 0; i < count; i++) {
      const color = await elements
        .nth(i)
        .evaluate((el) => window.getComputedStyle(el).color);
      expect(color).toBe(expectedRgbColor);
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
