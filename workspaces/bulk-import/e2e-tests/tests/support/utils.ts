import {
  LoginHelper,
  UIhelper,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { expect, Page } from "@red-hat-developer-hub/e2e-test-utils/test";

/** RHDH + Bulk import setup using e2e-test-utils login. */
export async function prepareBulkImportPage(
  page: Page,
  loginHelper: LoginHelper,
  uiHelper: UIhelper,
): Promise<void> {
  await loginHelper.loginAsGithubUser();
  await uiHelper.openSidebar("Bulk import");
  await dismissBulkImportLoginDialogIfPresent(page, loginHelper);
  await uiHelper.verifyHeading("Bulk import");
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
  const loginDialog = page.getByRole("dialog", { name: "Login Required" });

  const appeared = await loginDialog
    .waitFor({ state: "visible", timeout: 8_000 })
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

const GITLAB_LOGIN_REJECTED_EMPTY_STATE = "Log in to view projects";

/**
 * Select GitLab; the Login Required dialog often opens before the radio stays
 * checked in the a11y tree. Reject login first, then assert provider state.
 */
export async function selectGitLabAndRejectLogin(page: Page): Promise<void> {
  const gitlabRadio = page.getByRole("radio", { name: "GitLab" });
  await expect(gitlabRadio).toBeVisible({ timeout: 10_000 });
  await gitlabRadio.check();
  await rejectBulkImportGitLabLoginAndExpectEmptyState(page);
  await expect(gitlabRadio).toBeChecked({ timeout: 10_000 });
}

/** GitLab provider switch — reject Login Required and assert the empty state (rhdh-plugins#3102). */
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
