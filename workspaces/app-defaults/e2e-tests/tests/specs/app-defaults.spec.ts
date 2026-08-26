import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";

test.describe("app-defaults plugins (app-next + OIDC + GitHub integration)", () => {
  test.beforeAll(async ({ rhdh }) => {
    await rhdh.configure({ auth: "keycloak" });
    await rhdh.deploy();
  });

  test.beforeEach(async ({ loginHelper }) => {
    await loginHelper.loginAsKeycloakUser();
  });

  test("loads Catalog after OIDC login", async ({ uiHelper }) => {
    await uiHelper.dismissQuickstartIfVisible();
    await uiHelper.openSidebar("Catalog");
    await uiHelper.verifyHeading(/catalog/i);
  });

  test("catalog API responds for authenticated session", async ({ page }) => {
    // Assert on the Catalog SPA's own GET to /api/catalog/* (same cookies/identity as the UI).
    // Ad-hoc fetch()/page.request often 401 here: backend identity middleware matches app-issued requests.
    const catalogApiOk = page.waitForResponse(
      (response) => {
        if (response.request().method() !== "GET") return false;
        if (!response.url().includes("/api/catalog/")) return false;
        const status = response.status();
        return status >= 200 && status < 400;
      },
      { timeout: 60_000 },
    );
    await page.goto("/catalog");
    const response = await catalogApiOk;
    expect(response.ok()).toBeTruthy();
  });

  /**
   * After OIDC app login, connect a GitHub session for SCM (session auth API):
   * Settings → Authentication Providers → GitHub row → **Sign in** → **Login Required** dialog → **Log in** → GitHub OAuth popup.
   */
  test("GitHub session sign-in from Authentication Providers", async ({
    page,
    uiHelper,
  }) => {
    await uiHelper.dismissQuickstartIfVisible();
    await page.goto("/settings/auth-providers");
    const authProvidersTab = page.getByRole("tab", {
      name: /authentication providers/i,
    });
    await expect(authProvidersTab).toBeVisible();
    await expect(authProvidersTab).toHaveAttribute("aria-selected", "true");

    // Row inner text includes title + description (not only "GitHub"), so /^GitHub$/ matches nothing.
    const githubRow = page
      .getByRole("listitem")
      .filter({ hasText: /\bGitHub\b/ })
      .first();
    const signInButton = githubRow.getByRole("button", {
      name: /^sign in$/i,
    });
    await expect(signInButton).toBeVisible();

    await signInButton.click();

    const loginRequiredDialog = page.getByRole("dialog", {
      name: /login required/i,
    });
    await expect(loginRequiredDialog).toBeVisible();

    const dialogLogInButton = loginRequiredDialog.getByRole("button", {
      name: /^log in$/i,
    });
    await expect(dialogLogInButton).toBeVisible();

    const [popup] = await Promise.all([
      page.waitForEvent("popup", { timeout: 60_000 }),
      dialogLogInButton.click(),
    ]);
    await expect(popup).toHaveURL(/github\.com/, { timeout: 60_000 });
    await popup.close();
  });
});
