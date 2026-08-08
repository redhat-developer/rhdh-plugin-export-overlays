import { UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { RepositoryParameters } from "../test-data/template-repository-data";

export async function fillFormFields(
  uiHelper: UIhelper,
  repoParams: RepositoryParameters,
) {
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
