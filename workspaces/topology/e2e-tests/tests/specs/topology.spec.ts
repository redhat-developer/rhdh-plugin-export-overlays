import { test, expect, Page } from "@red-hat-developer-hub/e2e-test-utils/test";
import { $ } from "@red-hat-developer-hub/e2e-test-utils/utils";
import path from "path";
import { Topology } from "./topology";
import { UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";

const setupScript = path.join(
  import.meta.dirname,
  "deploy-topology-resources.sh",
);
const rbacConfigmapPath = path.resolve(
  process.cwd(),
  "tests/config/rbac-configmap.yaml",
);

const $pipe = $({ stdio: ["pipe", "pipe", "pipe"] });
let topology: Topology;

const deployResources = (project: string) => $`bash ${setupScript} ${project}`;

async function navigateToTopology(uiHelper: UIhelper) {
  await uiHelper.openCatalogSidebar("Component");
  await uiHelper.searchInputPlaceholder("backstage-janus");
  await uiHelper.clickLink("backstage-janus");
  await uiHelper.clickTab("Topology");
}

async function getResourceType(page: Page): Promise<"ingress" | "route"> {
  await page.waitForLoadState();
  const hasIngresses = await page.getByText("Ingresses").isVisible();
  return hasIngresses ? "ingress" : "route";
}

test.describe("Test Topology plugin", () => {
  test.beforeAll(async ({ rhdh }) => {
    const project = rhdh.deploymentConfig.namespace;

    await rhdh.configure({ auth: "keycloak" });

    await $`oc apply -f ${rbacConfigmapPath} -n ${project}`;
    await deployResources(project);

    process.env.K8S_CLUSTER_URL = (
      await $pipe`oc whoami --show-server`
    ).stdout.trim();
    process.env.K8S_CLUSTER_TOKEN = (
      await $pipe`oc create token default -n ${project}`
    ).stdout.trim();

    await rhdh.deploy();
  });

  test("Verify Topology tab is visible on a component with kubernetes annotations", async ({
    page,
    loginHelper,
    uiHelper,
  }, testInfo) => {
    test.setTimeout(150000 + testInfo.retry * 30000);
    await loginHelper.loginAsKeycloakUser("test1", "test1@123");
    topology = new Topology(page);
    await navigateToTopology(uiHelper);
    await uiHelper.verifyHeading("backstage-janus");
    await uiHelper.clickButton("Hide");
    await page.getByRole("button", { name: "Fit to Screen" }).click();
    await expect(async () => {
      await page
        .getByTestId(/(status-error|status-ok)/)
        .first()
        .click();
      await uiHelper.verifyText(
        /Pipeline (Succeeded|Failed|Cancelled|Running)/,
      );
      await uiHelper.verifyText(/\d{1,5} (Succeeded|Failed|Cancelled|Running)/);
    }).toPass({ intervals: [2_000, 5_000], timeout: 30_000 });
    await topology.verifyDeployment("topology-test");
    await uiHelper.verifyButtonURL("Open URL", "topology-test-route");
    await uiHelper.clickTab("Details");
    await uiHelper.verifyText("Status");
    await uiHelper.verifyText("Active");
    await uiHelper.clickTab("Resources");
    await uiHelper.verifyHeading("Pods");
    await uiHelper.verifyHeading("Services");

    // Determine resource type and run appropriate test
    const resourceType = await getResourceType(page);

    // eslint-disable-next-line playwright/no-conditional-in-test
    if (resourceType === "ingress") {
      await testIngressResources(page, uiHelper);
    } else {
      await testRouteResources(page, uiHelper);
    }

    await uiHelper.verifyText("Location:");
    await expect(page.getByTitle("Deployment")).toBeVisible();
    await uiHelper.verifyText("S");
    // Verify the topology visualization is rendered
    await expect(page.getByTitle("Deployment")).toBeVisible();
    await uiHelper.clickTab("Details");
    await page.getByLabel("Pod").hover();
    await page.getByText("Display options").click();
    await page.getByLabel("Pod count").click();
    await uiHelper.verifyText("1");
    await uiHelper.verifyText("Pod");

    await topology.hoverOnPodStatusIndicator();
    await uiHelper.verifyTextInTooltip("Running");
    await uiHelper.verifyText("1Running");

    await uiHelper.verifyButtonURL(
      "Edit source code",
      "https://github.com/janus-idp/backstage-showcase",
    );
    await uiHelper.clickTab("Resources");
    await uiHelper.verifyText("P");
    await expect(page.getByTestId("pod-list")).toBeVisible();
    await expect(page.getByTestId("status-running")).toBeVisible();
    await uiHelper.verifyText("Running");
    await uiHelper.verifyHeading("PipelineRuns");
    await uiHelper.verifyText("PL");
    await uiHelper.verifyText("PLR");
    await uiHelper.verifyText(/(Succeeded|Failed|Cancelled|Running)/);
  });

  test.describe("Test Topology Plugin with RBAC", () => {
    test("Verify guest user cannot see Topology pods", async ({
      loginHelper,
      page,
      uiHelper,
    }) => {
      const topo = new Topology(page);

      await loginHelper.loginAsGuest();
      await navigateToTopology(uiHelper);
      await topo.verifyMissingTopologyPermission();
    });

    test("Verify limited user can see Topology but cannot view pod logs", async ({
      loginHelper,
      page,
      uiHelper,
    }) => {
      const topo = new Topology(page);

      await loginHelper.loginAsKeycloakUser("test2", "test2@123");
      await navigateToTopology(uiHelper);

      await topo.verifyDeployment("topology-test");
      await topo.verifyPodLogs(false);
    });

    test("Verify admin user can see Topology pods and view pod logs", async ({
      loginHelper,
      page,
      uiHelper,
    }) => {
      const topo = new Topology(page);

      await loginHelper.loginAsKeycloakUser("test1", "test1@123");
      await navigateToTopology(uiHelper);

      await topo.verifyDeployment("topology-test");
      await topo.verifyPodLogs(true);
    });
  });
});

// Helper functions for resource-specific testing
async function testIngressResources(page: Page, uiHelper: UIhelper) {
  await uiHelper.verifyHeading("Ingresses");
  await uiHelper.verifyText("I");
  await expect(
    page
      .getByTestId("ingress-list")
      .getByRole("link", { name: "topology-test-route" })
      .first(),
  ).toBeVisible();
  // Verify code block is visible (pre element containing configuration)
  await expect(
    page.getByText(/apiVersion:|kind:|metadata:/).first(),
  ).toBeVisible();
}

async function testRouteResources(page: Page, uiHelper: UIhelper) {
  await uiHelper.verifyHeading("Routes");
  await uiHelper.verifyText("RT");
  await expect(
    page.getByRole("link", { name: "topology-test-route" }).first(),
  ).toBeVisible();
}
