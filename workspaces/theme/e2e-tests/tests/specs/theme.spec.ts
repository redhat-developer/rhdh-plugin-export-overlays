import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { ThemeConstants } from "../../utils/theme-constants";
import { ThemeVerifier } from "../../utils/theme-verifier";
import { CUSTOM_FAVICON, CUSTOM_SIDEBAR_LOGO } from "../../utils/custom-theme";

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
    await uiHelper.verifyHeading("Welcome back!");
    await uiHelper.waitForLoad();
    await uiHelper.dismissQuickstartIfVisible();
  });

  test("Verify theme colors are applied", async () => {
    const themes = ThemeConstants.getThemes();

    for (const theme of themes) {
      await themeVerifier.setTheme(theme.name);
      await themeVerifier.verifyHeaderGradient(
        `none, linear-gradient(90deg, ${theme.headerColor1}, ${theme.headerColor2})`,
      );
      await themeVerifier.verifyBorderLeftColor(theme.navigationIndicatorColor);
      await themeVerifier.verifyPrimaryColors(theme.primaryColor);
    }
  });

  test("Verify that the RHDH favicon can be customized", async ({ page }) => {
    await expect(page.locator("#dynamic-favicon")).toHaveAttribute(
      "href",
      CUSTOM_FAVICON.light,
    );
  });

  test("Verify that RHDH CompanyLogo can be customized", async ({ page }) => {
    await themeVerifier.setTheme("Light");

    await expect(page.getByTestId("home-logo")).toHaveAttribute(
      "src",
      CUSTOM_SIDEBAR_LOGO.light,
    );

    await themeVerifier.setTheme("Dark");
    await expect(page.getByTestId("home-logo")).toHaveAttribute(
      "src",
      CUSTOM_SIDEBAR_LOGO.dark,
    );
  });

  test("Verify logo link", async ({ page }) => {
    await expect(
      page.getByTestId("global-header-company-logo").locator("a"),
    ).toHaveAttribute("href", "/");
    await page.getByTestId("global-header-company-logo").click();
    await expect(page).toHaveURL("/");
  });

  test("Verify that title for Backstage can be customized", async ({
    page,
  }) => {
    await expect(page).toHaveTitle(/Red Hat Developer Hub/);
  });
});
