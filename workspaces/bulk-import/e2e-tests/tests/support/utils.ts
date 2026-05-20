import { LoginHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { expect, Page } from "@red-hat-developer-hub/e2e-test-utils/test";

export async function ensureGithubUserSession(
  page: Page,
  loginHelper: LoginHelper,
): Promise<void> {
  await page.goto("/");
  const appReady = await page
    .locator("nav a")
    .first()
    .isVisible({ timeout: 15_000 })
    .catch(() => false);
  if (appReady) {
    return; // cookies/session already valid for this page
  }
  await loginHelper.loginAsGithubUser();
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
  waitForDialogMs = 8_000,
): Promise<void> {
  const loginDialog = page.getByRole("dialog", { name: "Login Required" });

  const appeared = await loginDialog
    .waitFor({ state: "visible", timeout: waitForDialogMs })
    .then(() => true)
    .catch(() => false);

  if (!appeared) {
    return;
  }

  const logInButton = loginDialog.getByRole("button", { name: "Log in" });
  await expect(logInButton).toBeVisible({ timeout: 10_000 });

  const authorize = loginHelper.checkAndReauthorizeGithubApp();
  await logInButton.click();
  await authorize;

  await expect(loginDialog).toBeHidden({ timeout: 60_000 });
}

const GITLAB_LOGIN_REJECTED_EMPTY_STATE = "Log in to view projects";

/**
 * GitLab scope change opens Login Required; reject on that dialog (no Log in /
 * provider popup) and assert the sign-in empty state (rhdh-plugins#3102).
 */
export async function rejectBulkImportGitLabLoginAndExpectEmptyState(
  page: Page,
  waitForDialogMs = 8_000,
): Promise<void> {
  const loginDialog = page.getByRole("dialog", { name: "Login Required" });

  const appeared = await loginDialog
    .waitFor({ state: "visible", timeout: waitForDialogMs })
    .then(() => true)
    .catch(() => false);

  if (appeared) {
    const rejectButton = loginDialog.getByRole("button", {
      name: "Reject All",
    });
    await expect(rejectButton).toBeVisible({ timeout: 10_000 });
    await rejectButton.click();
    await expect(loginDialog).toBeHidden({ timeout: 60_000 });
  }

  const emptyState = page.getByTestId("no-repositories-found");
  await expect(emptyState).toBeVisible({ timeout: 30_000 });
  await expect(emptyState).toContainText(GITLAB_LOGIN_REJECTED_EMPTY_STATE);
}
