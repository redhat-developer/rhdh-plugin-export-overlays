import { test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { $ } from "@red-hat-developer-hub/e2e-test-utils/utils";
import * as path from "node:path";
import { TektonSupportHelper } from "../support/tekton-support-helper";

const operatorInstallPath = path.resolve(
  process.cwd(),
  "tests/config/operator-install.sh",
);

const pipelineTestsPath = path.resolve(
  process.cwd(),
  "tests/config/pipeline-tests.yaml",
);

const clusterRolePath = path.resolve(
  process.cwd(),
  "tests/config/cluster-role.yaml",
);

async function grantDefaultServiceAccountClusterReaderAndTekton(
  project: string,
) {
  await $`bash -c 'oc adm policy add-cluster-role-to-user cluster-reader -z default -n "$1" 2>/dev/null || oc create clusterrolebinding "rhdh-$1-tekton-plugin-default" --clusterrole=cluster-reader --serviceaccount="$1:default" 2>/dev/null || true' _ ${project}`;
  await $`oc apply -f ${clusterRolePath}`;
  await $`oc create clusterrolebinding rhdh-${project}-tekton-plugin-default --clusterrole=rhdh-tekton-plugin --serviceaccount=${project}:default || true`;
}

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
    // Wait for namespace to be Active before applying Tekton resources (CI may delete it during operator install, leaving it Terminating).
    await $`for i in $(seq 1 90); do phase=$(oc get namespace ${namespace} -o jsonpath='{.status.phase}' 2>/dev/null || true); [ "$phase" = "Active" ] && break; if [ "$phase" = "Terminating" ]; then echo "Namespace ${namespace} terminating, waiting for delete..."; oc wait --for=delete namespace/${namespace} --timeout=60s 2>/dev/null || true; fi; echo "Waiting for namespace ${namespace} (phase=$phase)..."; sleep 2; done`;
    await $`oc wait --for=jsonpath='{.status.phase}=Active' namespace/${namespace} --timeout=30s`;
    await $`oc apply -f ${pipelineTestsPath} -n ${namespace}`;
    await grantDefaultServiceAccountClusterReaderAndTekton(namespace);
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
    await tekton.isModalOpened();
    await tekton.checkPipelineStages(["echo-hello-world", "echo-bye"]);
  });
});
