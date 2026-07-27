import { expect, Page } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  GITLAB_LOGIN_REJECTED_EMPTY_STATE,
  GITLAB_PROVIDER_LABEL,
  LOGIN_REQUIRED_DIALOG_NAME,
  LOGIN_REQUIRED_REJECT_ALL_BUTTON,
  NO_REPOSITORIES_FOUND_TEST_ID,
} from "../constants/bulk-import-selectors";

/**
 * Select GitLab; the Login Required dialog often opens before the radio stays
 * checked in the a11y tree. Reject login first, then assert provider state.
 */
export async function selectGitLabAndRejectLogin(page: Page): Promise<void> {
  const gitlabRadio = page.getByRole("radio", { name: GITLAB_PROVIDER_LABEL });
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
  const loginDialog = page.getByRole("dialog", {
    name: LOGIN_REQUIRED_DIALOG_NAME,
  });

  const appeared = await loginDialog
    .waitFor({ state: "visible", timeout: waitForDialogMs })
    .then(() => true)
    .catch(() => false);

  if (appeared) {
    const rejectButton = loginDialog.getByRole("button", {
      name: LOGIN_REQUIRED_REJECT_ALL_BUTTON,
    });
    await expect(rejectButton).toBeVisible({ timeout: 10_000 });
    await rejectButton.click();
    await expect(loginDialog).toBeHidden({ timeout: 60_000 });
  }

  const emptyState = page.getByTestId(NO_REPOSITORIES_FOUND_TEST_ID);
  await expect(emptyState).toBeVisible({ timeout: 30_000 });
  await expect(emptyState).toContainText(GITLAB_LOGIN_REJECTED_EMPTY_STATE);
}
