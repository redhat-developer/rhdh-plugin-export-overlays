import { test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { $, WorkspacePaths } from "@red-hat-developer-hub/e2e-test-utils/utils";
import { TektonSupportHelper } from "../support/tekton-support-helper";

test.describe("Test Tekton plugin", () => {
  test.beforeAll(async ({ rhdh }) => {
    await rhdh.configure({
      auth: "keycloak",
    });
    const namespace = rhdh.deploymentConfig.namespace;
    // operator-install.sh: Tekton/Pipelines operator + waits, then namespace Active wait, pipeline-tests + RBAC (see operator::grant_default_service_account_cluster_reader_and_tekton).
    const operatorInstallPath = WorkspacePaths.resolve(
      "tests/config/operator-install.sh",
    );
    await $`bash ${operatorInstallPath} ${namespace}`;
    await rhdh.deploy();
  });

  test.beforeEach(async ({ loginHelper }) => {
    await loginHelper.loginAsKeycloakUser();
  });

  test("Check Pipeline Run", async ({ page, uiHelper }) => {
    const tekton = new TektonSupportHelper(page);
    await tekton.goToBackstageJanusProjectCITab();
    await tekton.ensurePipelineRunsTableIsNotEmpty();
    await uiHelper.verifyHeading("Pipeline Runs");
    await uiHelper.verifyTableHeadingAndRows(
      tekton.getAllGridColumnsTextForPipelineRunsTable(),
    );
  });

  test("Check search functionality", async ({ page }) => {
    const tekton = new TektonSupportHelper(page);
    await tekton.goToBackstageJanusProjectCITab();
    await tekton.search("hello-world");
    await tekton.ensurePipelineRunsTableIsNotEmpty();
  });

  test("Check if modal is opened after click on the pipeline stage", async ({
    page,
  }) => {
    const tekton = new TektonSupportHelper(page);
    await tekton.goToBackstageJanusProjectCITab();
    await tekton.clickOnExpandRowFromPipelineRunsTable();
    await tekton.openModalEchoHelloWorld();
    await tekton.verifyModalOpened();
    await tekton.checkPipelineStages(["echo-hello-world", "echo-bye"]);
  });
});
