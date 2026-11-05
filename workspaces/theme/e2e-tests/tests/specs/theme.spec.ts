import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { ThemeConstants } from "../../utils/theme-constants";
import { ThemeVerifier } from "../../utils/theme-verifier";

test.describe("Theme Plugin tests", () => {
  test.beforeAll(async ({ rhdh }) => {
    await rhdh.configure({
      auth: "guest",
    });
    await rhdh.deploy();
  });

  let themeVerifier: ThemeVerifier;

  test.beforeEach(async ({ loginHelper, page, uiHelper }) => {
    themeVerifier = new ThemeVerifier(page, uiHelper);
    await loginHelper.loginAsGuest();
    await uiHelper.waitForLoad();
  });

  test("Verify theme colors are applied", async () => {
    const themes = ThemeConstants.getThemes();

    for (const theme of themes) {
      await themeVerifier.setTheme(theme.name);
      if (theme.appBarBackgroundColor) {
        await themeVerifier.verifyAppBarColor(theme.appBarBackgroundColor);
      }
      await themeVerifier.verifyPrimaryColors(theme.primaryColor);
    }
  });

  test("Verify that RHDH serves a favicon", async ({ page }) => {
    const favicon = page.locator('link[rel="icon"][type="image/svg+xml"]');
    await expect(favicon).toHaveAttribute("href", /favicon\.svg/);
  });

  test("Verify that RHDH CompanyLogo is theme-aware", async ({ page }) => {
    await themeVerifier.setTheme("Light");
    const logo = page.getByTestId("global-header-company-logo").first();
    await expect(logo).toHaveCount(1);
    const logoText = logo.locator("svg g").first();
    await expect(logoText).toHaveAttribute("fill", "black");

    await themeVerifier.setTheme("Dark");
    // await expect(logoText).toHaveAttribute("fill", "white");
    // TODO: Fix logo text fill color for dark theme
  });

  test("Verify logo link", async ({ page }) => {
    const logo = page.getByTestId("global-header-company-logo");
    const link = logo.getByRole("link", { name: "Home" });
    await expect(link).toHaveAttribute("href", "/");
    await logo.click();
    await expect(page).toHaveURL("/");
  });

  test("Verify that title for Backstage can be customized", async ({
    page,
  }) => {
    await expect(page).toHaveTitle(/Red Hat Developer Hub/);
  });
});
