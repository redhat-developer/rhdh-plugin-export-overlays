import { UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { expect, Page } from "@red-hat-developer-hub/e2e-test-utils/test";
import { RepositoryParameters } from "../test-data/template-repository-data";

/**
 * Click Choose on a Create-page template card.
 * Prefer this over uiHelper.clickBtnInCard — that helper scrolls first and can
 * hit a detached node when NFS re-renders the card list.
 */
export async function chooseScaffolderTemplate(
  page: Page,
  templateText: string,
): Promise<void> {
  const chooseButton = page
    .locator('[class*="MuiCard-root"]')
    .filter({ hasText: templateText })
    .getByRole("button", { name: /Choose/i })
    .first();
  await expect(chooseButton).toBeVisible({ timeout: 30_000 });
  await chooseButton.click();
}

/** Fills the scaffolder "Repository Details" step with the given repository parameters. */
export async function fillFormFields(
  uiHelper: UIhelper,
  repoParams: RepositoryParameters,
): Promise<void> {
  await uiHelper.fillTextInputByLabel(
    "Repository URL (Backstage format)",
    repoParams.repoUrl,
  );
  await uiHelper.fillTextInputByLabel(
    "Owner of the Repository",
    repoParams.organization,
  );
  await uiHelper.fillTextInputByLabel(
    "Name of the repository",
    repoParams.name,
  );
  await uiHelper.fillTextInputByLabel(
    "The branch to add the catalog entity to",
    repoParams.branchName,
  );
  await uiHelper.fillTextInputByLabel(
    "The branch to target the PR/MR to",
    repoParams.targetBranchName,
  );
  await uiHelper.fillTextInputByLabel(
    "Git provider host",
    repoParams.gitProviderHost,
  );
}
