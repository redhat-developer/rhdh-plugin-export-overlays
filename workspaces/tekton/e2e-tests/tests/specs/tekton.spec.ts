import { test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { $, WorkspacePaths } from "@red-hat-developer-hub/e2e-test-utils/utils";
import { TektonSupportHelper } from "../support/tekton-support-helper";

test.describe("Test Tekton plugin", () => {
  test.beforeAll(async ({ rhdh }) => {
    // Community plugin publishes to ghcr.io; nightly mode resolves {{inherit}} to RHEC by default.
    // Remove when this community package is no longer in default.packages.yaml in the rhdh repo.
    const ghcrRegistry = "ghcr.io/redhat-developer/rhdh-plugin-export-overlays";
    process.env.NIGHTLY_DPDY_OCI_REGISTRY_MAP = JSON.stringify({
      [ghcrRegistry]: ["@backstage-community/plugin-tekton"],
    });
    const project = rhdh.deploymentConfig.namespace;
    const isNightlyMode =
      process.env.E2E_NIGHTLY_MODE === "true" ||
      process.env.E2E_NIGHTLY_MODE === "1" ||
      (process.env.JOB_NAME?.includes("periodic-") ?? false);
    test.skip(
      project === "tekton-app-next" && isNightlyMode,
      "tekton-app-next not ready for nightly",
    );
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
    test.setTimeout(180_000);
    await loginHelper.loginAsKeycloakUser();
  });

  test("Check Pipeline Run", async ({ page, uiHelper }, testInfo) => {
    const tekton = new TektonSupportHelper(page);
    await tekton.goToBackstageJanusProjectCITab(testInfo);
    await tekton.ensurePipelineRunsTableIsNotEmpty();
    await uiHelper.verifyHeading("Pipeline Runs");
    await uiHelper.verifyTableHeadingAndRows(
      tekton.getAllGridColumnsTextForPipelineRunsTable(),
    );
  });

  test("Check search functionality", async ({ page }, testInfo) => {
    const tekton = new TektonSupportHelper(page);
    await tekton.goToBackstageJanusProjectCITab(testInfo);
    await tekton.search("hello-world");
    await tekton.ensurePipelineRunsTableIsNotEmpty();
  });

  test("Check if modal is opened after click on the pipeline stage", async ({
    page,
  }, testInfo) => {
    const tekton = new TektonSupportHelper(page);
    await tekton.goToBackstageJanusProjectCITab(testInfo);
    await tekton.clickOnExpandRowFromPipelineRunsTable(
      "hello-world-pipeline-run",
    );
    await tekton.openModalEchoHelloWorld();
    await tekton.verifyModalOpened();
    await tekton.checkPipelineStages(["echo-hello-world", "echo-bye"]);
  });
});
