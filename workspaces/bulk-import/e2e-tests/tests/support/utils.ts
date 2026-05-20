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
  await loginHelper.checkAndClickOnGHloginPopup();
  await uiHelper.verifyHeading("Bulk import");
}

const GITLAB_LOGIN_REJECTED_EMPTY_STATE = "Log in to view projects";

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
