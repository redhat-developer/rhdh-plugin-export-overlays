import {
  LoginHelper,
  UIhelper,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { expect, Page } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  BULK_IMPORT_HEADING,
  LOGIN_REQUIRED_DIALOG_NAME,
  LOGIN_REQUIRED_LOG_IN_BUTTON,
} from "../constants/bulk-import-selectors";

/** GitHub sign-in + Bulk import navigation for plugin tests. */
export async function signInForBulkImportTests(
  page: Page,
  loginHelper: LoginHelper,
  uiHelper: UIhelper,
): Promise<void> {
  await loginHelper.loginAsGithubUser();
  await uiHelper.openSidebar(BULK_IMPORT_HEADING);
  await dismissBulkImportLoginDialogIfPresent(page, loginHelper);
  await uiHelper.verifyHeading(BULK_IMPORT_HEADING);
}

export async function signInAsGuestForPermissionTest(
  loginHelper: LoginHelper,
  uiHelper: UIhelper,
): Promise<void> {
  await loginHelper.loginAsGuest();
  await uiHelper.openSidebar(BULK_IMPORT_HEADING);
}

type GithubLoginHelper = {
  checkAndReauthorizeGithubApp: () => Promise<void>;
};

/**
 * Bulk Import shows "Login Required" after the page content paints. Wait for the
 * dialog (do not use a one-shot isVisible right after the page marker).
 */
export async function dismissBulkImportLoginDialogIfPresent(
  page: Page,
  loginHelper: GithubLoginHelper,
): Promise<void> {
  const loginDialog = page.getByRole("dialog", {
    name: LOGIN_REQUIRED_DIALOG_NAME,
  });

  const appeared = await loginDialog
    .waitFor({ state: "visible", timeout: 8_000 })
    .then(() => true)
    .catch(() => false);

  if (!appeared) {
    return;
  }

  const logInButton = loginDialog.getByRole("button", {
    name: LOGIN_REQUIRED_LOG_IN_BUTTON,
  });
  await expect(logInButton).toBeVisible({ timeout: 10_000 });

  const reauthorize = loginHelper.checkAndReauthorizeGithubApp();
  const popup = await Promise.all([
    page.waitForEvent("popup", { timeout: 15_000 }),
    logInButton.click(),
  ])
    .then(([p]) => p)
    .catch(() => null);
  if (popup) {
    await reauthorize;
  }
  await expect(loginDialog).toBeHidden({ timeout: 60_000 });
}
