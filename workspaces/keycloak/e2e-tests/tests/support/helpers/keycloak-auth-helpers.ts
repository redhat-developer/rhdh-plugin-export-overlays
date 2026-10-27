import type { Page } from "@playwright/test";
import type {
  LoginHelper,
  UIhelper,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";

/**
 * Navigate to the Settings page via the user-profile dropdown.
 *
 * The NFS sidebar does not contain a Settings link; Settings is only
 * reachable through the profile dropdown in the top-right header.
 * Using {@link Page.goto | page.goto("/settings")} would drop the
 * authenticated OIDC session (see #4034), so this SPA-friendly
 * navigation is required in tests that need to stay logged in.
 *
 * Precedent: `workspaces/global-header/e2e-tests/tests/specs/default-global-header.spec.ts`
 */
export async function navigateToSettings(
  page: Page,
  uiHelper: UIhelper,
): Promise<void> {
  await uiHelper.openProfileDropdown();
  await page.getByRole("menuitem", { name: "Settings" }).click();
}

/**
 * Guard wrapper around {@link LoginHelper.signOut} for expired Keycloak
 * sessions.  When the session refresh returns HTTP 401, the user lands on
 * the login page where the user-settings-menu button is absent, causing a
 * 10 s timeout in `signOut()`.  This helper checks button visibility first
 * and skips sign-out when the session has already expired.
 */
export async function safeSignOut(
  page: Page,
  loginHelper: LoginHelper,
): Promise<void> {
  if (
    await page.locator('button[data-testid="user-settings-menu"]').isVisible()
  ) {
    await loginHelper.signOut();
  }
}
