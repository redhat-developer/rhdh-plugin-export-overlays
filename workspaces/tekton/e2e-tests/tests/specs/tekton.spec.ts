import { test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { $ } from "@red-hat-developer-hub/e2e-test-utils/utils";
import { CatalogPage } from "@red-hat-developer-hub/e2e-test-utils/pages";
import * as path from "node:path";
import { TektonHelper } from "../support/tekton-helper";

const operatorInstallPath = path.resolve(
  process.cwd(),
  "tests/config/operator-install.sh",
);

const pipelineTestsPath = path.resolve(
  process.cwd(),
  "tests/config/pipeline-tests.yaml",
);

test.describe("Test Tekton plugin", () => {
  test.beforeAll(async ({ rhdh }) => {
    await $`bash ${operatorInstallPath}`;
    await rhdh.configure({
      auth: "keycloak",
      appConfig: "tests/config/app-config-rhdh.yaml",
      secrets: "tests/config/rhdh-secrets.yaml",
      dynamicPlugins: "tests/config/dynamic-plugins.yaml",
      valueFile: "tests/config/value_file.yaml",
    });
    const namespace = rhdh.deploymentConfig.namespace;
    await $`oc apply -f ${pipelineTestsPath} -n ${namespace}`;
    await rhdh.deploy();
  });

  test.beforeEach(async ({ loginHelper }) => {
    await loginHelper.loginAsKeycloakUser();
  });

  test("Check Pipeline Run", async ({ page, uiHelper }) => {
    const catalog = new CatalogPage(page);
    const tekton = new TektonHelper(page);
    await catalog.goToBackstageJanusProjectCITab();
    await tekton.ensurePipelineRunsTableIsNotEmpty();
    await uiHelper.verifyHeading("Pipeline Runs");
    await uiHelper.verifyTableHeadingAndRows(
      tekton.getAllGridColumnsTextForPipelineRunsTable(),
    );
  });

  test("Check search functionality", async ({ page }) => {
    const catalog = new CatalogPage(page);
    const tekton = new TektonHelper(page);
    await catalog.goToBackstageJanusProjectCITab();
    await tekton.search("hello-world");
    await tekton.ensurePipelineRunsTableIsNotEmpty();
  });

  test("Check if modal is opened after click on the pipeline stage", async ({
    page,
  }) => {
    const catalog = new CatalogPage(page);
    const tekton = new TektonHelper(page);
    await catalog.goToBackstageJanusProjectCITab();
    await tekton.clickOnExpandRowFromPipelineRunsTable();
    await tekton.openModalEchoHelloWorld();
    await tekton.isModalOpened();
    await tekton.checkPipelineStages(["echo-hello-world", "echo-bye"]);
  });
});
