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
    const logo = page.getByTestId("home-logo").filter({ visible: true });
    await expect(logo).toHaveCount(1);
    await expect(logo).toHaveAttribute("src", /^data:image\/svg\+xml/);
    const lightSrc = await logo.evaluate((el) => (el as HTMLImageElement).src);

    await themeVerifier.setTheme("Dark");
    await expect(logo).toHaveAttribute("src", /^data:image\/svg\+xml/);
    await expect(logo).not.toHaveAttribute("src", lightSrc);
  });

  //<img width="170" alt="Home logo" data-testid="home-logo" src="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22160pt%22%20height%3D%2280pt%22%20viewBox%3D%220%200%20160%2080%22%3E%3Cg%20fill%3D%22%23000%22%20style%3D%22text-align%3Astart%3Btext-align-last%3Aauto%22%20letter-spacing%3D%220%22%3E%3Ctext%20font-family%3D%22Red%20Hat%20Display%22%20font-size%3D%2240%22%20font-weight%3D%22700%22%20transform%3D%22translate(-.177%2054.263)%22%20word-spacing%3D%22…/> aka getByRole('link', { name: 'Home' }).first()

  test("Verify logo link", async ({ page }) => {
    const logo = page.getByTestId("home-logo").last();
    const link = page
      .getByTestId("sidebar-root")
      .getByRole("link")
      .filter({ has: logo, visible: true });
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
