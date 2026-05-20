import { LoginHelper, UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { expect, Page } from "@red-hat-developer-hub/e2e-test-utils/test";

/** Bulk Import "Login Required" — only await reauth when Log in opens a popup (utils listener has no timeout). */
async function dismissBulkImportLoginDialogIfPresent(
  page: Page,
  loginHelper: LoginHelper,
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

/**
 * GitHub RHDH session (when needed) + navigate to Bulk import and clear SCM login dialog.
 */
export async function prepareBulkImportPage(
  page: Page,
  loginHelper: LoginHelper,
  uiHelper: UIhelper,
): Promise<void> {
  await page.goto("/");

  if (
    await page
      .getByRole("button", { name: "Sign In" })
      .isVisible({ timeout: 15_000 })
      .catch(() => false)
  ) {
    await loginHelper.loginAsGithubUser();
  }

  await uiHelper.openSidebar("Bulk import");

  const bulkImportReady = page.getByText("Source control tool", {
    exact: true,
  });
  await expect(bulkImportReady).toBeVisible({ timeout: 20_000 });
  await dismissBulkImportLoginDialogIfPresent(page, loginHelper);
  await expect(
    page.getByRole("dialog", { name: "Login Required" }),
  ).toBeHidden({ timeout: 5_000 });
  await expect(bulkImportReady).toBeVisible();
  await uiHelper.verifyHeading("Bulk import");
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
