import type { Page } from "@playwright/test";
import type { LoginHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";

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
