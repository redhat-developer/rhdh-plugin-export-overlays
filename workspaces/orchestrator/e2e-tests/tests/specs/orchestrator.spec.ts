import { execSync } from "child_process";
import { test, expect } from "rhdh-e2e-test-utils/test";
import { AuthApiHelper } from "rhdh-e2e-test-utils/helpers";
import { OrchestratorPage } from "rhdh-e2e-test-utils/pages";
import { $ } from "rhdh-e2e-test-utils/utils";
import { ensureBaselineRole } from "./rbac-baseline.js";
import { deploySonataflow } from "./deploy-sonataflow.js";

interface WorkflowNode {
  name: string;
  errorMessage: string | null;
  exit: string | null;
}

interface WorkflowInstance {
  state: string;
  workflowdata: {
    result: {
      completedWith: string;
      message: string;
    };
  };
  nodes: WorkflowNode[];
  serviceUrl?: string;
}

function decodeEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is not set`);
  }
  return Buffer.from(value, "base64").toString();
}

test.describe("Orchestrator", () => {
  test.beforeAll(async ({ rhdh, browser }, testInfo) => {
    test.setTimeout(20 * 60 * 1000);
    await test.runOnce("orchestrator-setup", async () => {
      const project = rhdh.deploymentConfig.namespace;
      await rhdh.configure({ auth: "keycloak" });
      await deploySonataflow(project);
      process.env.SONATAFLOW_DATA_INDEX_URL =
        "http://sonataflow-platform-data-index-service";
      // #region agent log
      const headSha = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
      let repoRef: string;
      try {
        execSync("git rev-parse HEAD^2", { encoding: "utf-8" });
        repoRef = execSync("git rev-parse HEAD^1", { encoding: "utf-8" }).trim();
        console.log(`[orchestrator-setup] HEAD is a merge commit. HEAD=${headSha}, HEAD^1 (PR tip)=${repoRef}`);
      } catch {
        repoRef = headSha;
        console.log(`[orchestrator-setup] HEAD is not a merge commit. Using HEAD=${repoRef}`);
      }
      // #endregion
      process.env.CATALOG_TEMPLATES_BASE_URL = `https://raw.githubusercontent.com/redhat-developer/rhdh-plugin-export-overlays/${repoRef}/workspaces/orchestrator/e2e-tests/tests/config/catalog-templates`;
      // #region agent log
      console.log(`[orchestrator-setup] CATALOG_TEMPLATES_BASE_URL=${process.env.CATALOG_TEMPLATES_BASE_URL}`);
      console.log(`[orchestrator-setup] SONATAFLOW_DATA_INDEX_URL=${process.env.SONATAFLOW_DATA_INDEX_URL}`);
      // #endregion
      await rhdh.deploy({ timeout: null });
      // #region agent log
      const ns = rhdh.deploymentConfig.namespace;
      console.log("[orchestrator-setup] RHDH deployed. Post-deploy workflow diagnostics:");
      try {
        const wfPods = execSync(`oc get pods -n ${ns} --no-headers`, { encoding: "utf-8" }).trim();
        console.log(`[orchestrator-setup] All pods in ${ns}:\n${wfPods}`);
      } catch (e) { console.log(`[orchestrator-setup] pod list error: ${e}`); }
      for (const wf of ["greeting", "failswitch"]) {
        try {
          const logs = execSync(`oc logs -n ${ns} -l sonataflow.org/workflow-app=${wf} --tail=30`, { encoding: "utf-8" }).trim();
          console.log(`[orchestrator-setup] ${wf} last 30 log lines:\n${logs}`);
        } catch (e) { console.log(`[orchestrator-setup] ${wf} logs error: ${e}`); }
      }
      try {
        const templateUrl = `${process.env.CATALOG_TEMPLATES_BASE_URL}/greeting.yaml`;
        const curlResult = execSync(`curl -sS -o /dev/null -w "%{http_code}" "${templateUrl}"`, { encoding: "utf-8", timeout: 15_000 }).trim();
        console.log(`[orchestrator-setup] Template URL accessibility check: ${templateUrl} -> HTTP ${curlResult}`);
      } catch (e) { console.log(`[orchestrator-setup] Template URL check error: ${e}`); }

      // Check K8s services for workflows
      try {
        const svcs = execSync(`oc get svc -n ${ns} --no-headers`, { encoding: "utf-8" }).trim();
        console.log(`[orchestrator-setup] All services in ${ns}:\n${svcs}`);
      } catch (e) { console.log(`[orchestrator-setup] svc list error: ${e}`); }

      // Query data-index GraphQL via the greeting pod (which has curl) through K8s service
      try {
        const gqlQuery = '{"query":"{ ProcessDefinitions { id, version, name, serviceUrl } }"}';
        const diResult = execSync(
          `oc exec -n ${ns} deploy/greeting -- curl -s -X POST http://sonataflow-platform-data-index-service/graphql -H 'Content-Type: application/json' -d '${gqlQuery}'`,
          { encoding: "utf-8", timeout: 30_000 },
        ).trim();
        console.log(`[orchestrator-setup] Data-index ProcessDefinitions:\n${diResult}`);
      } catch (e) { console.log(`[orchestrator-setup] Data-index query error: ${e}`); }

      // Also try querying data-index on port 8080 (container port) directly
      try {
        const gqlQuery = '{"query":"{ ProcessDefinitions { id, version, name, serviceUrl } }"}';
        const diResult = execSync(
          `oc exec -n ${ns} deploy/sonataflow-platform-data-index-service -- curl -s -X POST http://localhost:8080/graphql -H 'Content-Type: application/json' -d '${gqlQuery}'`,
          { encoding: "utf-8", timeout: 30_000 },
        ).trim();
        console.log(`[orchestrator-setup] Data-index ProcessDefinitions (localhost:8080):\n${diResult}`);
      } catch (e) { console.log(`[orchestrator-setup] Data-index query (8080) error: ${e}`); }

      // Curl greeting runtime directly to verify it responds
      try {
        const greetResult = execSync(
          `oc exec -n ${ns} deploy/greeting -- curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/q/health/ready`,
          { encoding: "utf-8", timeout: 15_000 },
        ).trim();
        console.log(`[orchestrator-setup] Greeting runtime health: HTTP ${greetResult}`);
      } catch (e) { console.log(`[orchestrator-setup] Greeting health check error: ${e}`); }

      // Check RHDH backend logs using deployment name (avoids matching postgresql pod)
      try {
        const rhdhLogs = execSync(
          `oc logs -n ${ns} deploy/redhat-developer-hub --tail=200`,
          { encoding: "utf-8", timeout: 30_000 },
        ).trim();
        const relevantLines = rhdhLogs.split("\n").filter(
          (l: string) => /orchestrator|data-index|catalog.*error|catalog.*warn|template.*error|failed to read|error.*url|CATALOG_TEMPLATES/i.test(l),
        );
        console.log(`[orchestrator-setup] RHDH relevant logs (${relevantLines.length} lines):\n${relevantLines.join("\n")}`);
        if (relevantLines.length === 0) {
          const last30 = rhdhLogs.split("\n").slice(-30);
          console.log(`[orchestrator-setup] RHDH last 30 log lines:\n${last30.join("\n")}`);
        }
      } catch (e) { console.log(`[orchestrator-setup] RHDH logs error: ${e}`); }

      // Check SonataFlow CR status.address and KOGITO_SERVICE_URL env var
      for (const wf of ["greeting", "failswitch"]) {
        try {
          const addr = execSync(`oc get sonataflow ${wf} -n ${ns} -o jsonpath='{.status.address}'`, { encoding: "utf-8" }).trim();
          console.log(`[orchestrator-setup] ${wf} status.address: ${addr}`);
        } catch (e) { console.log(`[orchestrator-setup] ${wf} address error: ${e}`); }
        try {
          const conds = execSync(`oc get sonataflow ${wf} -n ${ns} -o jsonpath='{.status.conditions}'`, { encoding: "utf-8" }).trim();
          console.log(`[orchestrator-setup] ${wf} status.conditions: ${conds}`);
        } catch (e) { console.log(`[orchestrator-setup] ${wf} conditions error: ${e}`); }
        try {
          const envVars = execSync(
            `oc get deploy ${wf} -n ${ns} -o jsonpath='{range .spec.template.spec.containers[0].env[*]}{.name}={.value}{"\\n"}{end}'`,
            { encoding: "utf-8", timeout: 10_000 },
          ).trim();
          const kogitoVars = envVars.split("\n").filter((l: string) => /KOGITO|SERVICE_URL|DATA_INDEX/i.test(l));
          console.log(`[orchestrator-setup] ${wf} KOGITO env vars:\n${kogitoVars.join("\n")}`);
        } catch (e) { console.log(`[orchestrator-setup] ${wf} env vars error: ${e}`); }
      }

      // Check RHDH pod env var for data-index URL
      try {
        const diUrlInPod = execSync(
          `oc exec -n ${ns} deploy/redhat-developer-hub -- env | grep -i 'SONATAFLOW\\|DATA_INDEX\\|CATALOG_TEMPLATES'`,
          { encoding: "utf-8", timeout: 15_000 },
        ).trim();
        console.log(`[orchestrator-setup] RHDH pod env vars:\n${diUrlInPod}`);
      } catch (e) { console.log(`[orchestrator-setup] RHDH pod env error: ${e}`); }

      // Test RHDH orchestrator API from inside the cluster (bypasses auth)
      const rhdhUrl = rhdh.rhdhUrl;
      console.log(`[orchestrator-setup] RHDH URL: ${rhdhUrl}`);
      try {
        const apiResult = execSync(
          `oc exec -n ${ns} deploy/greeting -- curl -s -o /dev/null -w "%{http_code}" http://redhat-developer-hub:7007/api/orchestrator/v2/workflows`,
          { encoding: "utf-8", timeout: 15_000 },
        ).trim();
        console.log(`[orchestrator-setup] RHDH orchestrator API (internal): HTTP ${apiResult}`);
      } catch (e) { console.log(`[orchestrator-setup] RHDH API internal check error: ${e}`); }

      // Get actual workflow list from RHDH internal API
      try {
        const apiBody = execSync(
          `oc exec -n ${ns} deploy/greeting -- curl -s http://redhat-developer-hub:7007/api/orchestrator/v2/workflows`,
          { encoding: "utf-8", timeout: 15_000 },
        ).trim();
        console.log(`[orchestrator-setup] RHDH orchestrator workflows (internal, first 3000 chars):\n${apiBody.substring(0, 3000)}`);
      } catch (e) { console.log(`[orchestrator-setup] RHDH workflows internal error: ${e}`); }
      // #endregion
    });
    await ensureBaselineRole(browser, testInfo);
    testInfo.annotations.push({
      type: "component",
      description: "orchestrator",
    });
  });

  test.describe("Greeting workflow", () => {
    let orchestrator: OrchestratorPage;

    test.beforeEach(async ({ page, loginHelper }) => {
      orchestrator = new OrchestratorPage(page);
      await loginHelper.loginAsKeycloakUser();
    });

    test("Greeting workflow execution and workflow tab validation", async ({
      uiHelper,
    }) => {
      test.setTimeout(660_000);
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectGreetingWorkflowItem();
      await orchestrator.runGreetingWorkflow();
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.validateGreetingWorkflow();
    });

    test("Greeting workflow run details validation", async ({ uiHelper }) => {
      test.setTimeout(660_000);
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectGreetingWorkflowItem();
      await orchestrator.runGreetingWorkflow();
      await orchestrator.reRunGreetingWorkflow();
      await orchestrator.validateWorkflowRunsDetails();
    });
  });

  test.describe("Failswitch workflow", () => {
    let orchestrator: OrchestratorPage;

    test.beforeEach(async ({ page, loginHelper }) => {
      orchestrator = new OrchestratorPage(page);
      await loginHelper.loginAsKeycloakUser();
    });

    test("Failswitch workflow execution and workflow tab validation", async ({
      uiHelper,
    }) => {
      test.setTimeout(180_000);
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectFailSwitchWorkflowItem();
      await orchestrator.runFailSwitchWorkflow("OK");
      await orchestrator.validateCurrentWorkflowStatus("Completed");
      await orchestrator.reRunFailSwitchWorkflow("Wait");
      await orchestrator.abortWorkflow();
      await orchestrator.reRunFailSwitchWorkflow("KO");
      await orchestrator.validateCurrentWorkflowStatus("Failed");
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectFailSwitchWorkflowItem();
      await orchestrator.runFailSwitchWorkflow("Wait");
      await orchestrator.validateCurrentWorkflowStatus("Running");
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.validateWorkflowAllRuns();
      await orchestrator.validateWorkflowAllRunsStatusIcons();
    });

    test("Test abort workflow", async ({ uiHelper }) => {
      test.setTimeout(180_000);
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectFailSwitchWorkflowItem();
      await orchestrator.runFailSwitchWorkflow("Wait");
      await orchestrator.abortWorkflow();
    });

    test("Test Running status validations", async ({ uiHelper }) => {
      test.setTimeout(180_000);
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectFailSwitchWorkflowItem();
      await orchestrator.runFailSwitchWorkflow("Wait");
      await orchestrator.validateWorkflowStatusDetails("Running");
    });

    test("Test Failed status validations", async ({ uiHelper }) => {
      test.setTimeout(180_000);
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectFailSwitchWorkflowItem();
      await orchestrator.runFailSwitchWorkflow("KO");
      await orchestrator.validateWorkflowStatusDetails("Failed");
    });

    test("Test Completed status validations", async ({ uiHelper }) => {
      test.setTimeout(180_000);
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectFailSwitchWorkflowItem();
      await orchestrator.runFailSwitchWorkflow("OK");
      await orchestrator.validateWorkflowStatusDetails("Completed");
    });

    test("Test rerunning from failure point using failswitch workflow", async ({
      uiHelper,
    }, testInfo) => {
      // 4 minutes: pod restarts + 60s sleep + failure/recovery time
      test.setTimeout(240000);
      const ns = testInfo.project.name;

      test.skip(!ns, "NAME_SPACE not set");

      const originalHttpbin = "https://httpbin.org/";
      try {
        await patchHttpbin(ns!, "https://foobar.org/");
        await restartAndWait(ns!);

        await uiHelper.openSidebar("Orchestrator");
        await orchestrator.selectFailSwitchWorkflowItem();
        await orchestrator.runFailSwitchWorkflow("Wait");
        await orchestrator.validateCurrentWorkflowStatus("Failed");

        await patchHttpbin(ns!, originalHttpbin);
        await restartAndWait(ns!);

        await orchestrator.reRunOnFailure("From failure point");
        await orchestrator.validateCurrentWorkflowStatus("Completed");
      } catch (e) {
        testInfo.annotations.push({
          type: "test-error",
          description: String(e),
        });
        throw e;
      } finally {
        try {
          await cleanupAfterTest(ns!, originalHttpbin);
        } catch (cleanupErr) {
          testInfo.annotations.push({
            type: "cleanup-error",
            description: String(cleanupErr),
          });
        }
      }
    });

    test("Failswitch links to another workflow and link works", async ({
      page,
      uiHelper,
    }) => {
      test.setTimeout(180_000);
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectFailSwitchWorkflowItem();
      await orchestrator.runFailSwitchWorkflow("OK");

      // Verify suggested next workflow section and navigate via the greeting link
      await expect(
        page.getByRole("heading", { name: /suggested next workflow/i }),
      ).toBeVisible();
      const greetingLink = page.getByRole("link", { name: /greeting/i });
      await expect(greetingLink).toBeVisible();
      await greetingLink.click();

      // Popup should appear for Greeting workflow
      await expect(
        page.getByRole("dialog", { name: /greeting workflow/i }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /run workflow/i }),
      ).toBeVisible();
      await page.getByRole("button", { name: /run workflow/i }).click();

      // Verify Greeting workflow execute view shows correct header and "Next" button
      await expect(
        page.getByRole("heading", { name: "Greeting workflow" }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Next" })).toBeVisible();
    });
  });

  test.describe("Token propagation workflow API", () => {
    test.skip("Token propagation workflow executes successfully via API", async ({
      page,
      loginHelper,
    }) => {
      // 5 minutes for workflow execution + polling
      test.setTimeout(5 * 60 * 1000);

      await loginHelper.loginAsKeycloakUser();

      const backstageToken = await new AuthApiHelper(page).getToken();

      // Get Keycloak OIDC access token via password grant
      const kcBaseUrl = decodeEnvVar("KEYCLOAK_AUTH_BASE_URL");
      const kcRealm = decodeEnvVar("KEYCLOAK_AUTH_REALM");
      const kcClientId = decodeEnvVar("KEYCLOAK_AUTH_CLIENTID");
      const kcClientSecret = decodeEnvVar("KEYCLOAK_AUTH_CLIENT_SECRET");

      const username = process.env.GH_USER_ID;
      const password = process.env.GH_USER_PASS;
      if (!username || !password) {
        throw new Error("GH_USER_ID and GH_USER_PASS must be set");
      }

      const tokenUrl = `${kcBaseUrl}/auth/realms/${kcRealm}/protocol/openid-connect/token`;

      const tokenResponse = await page.request.post(tokenUrl, {
        form: {
          /* eslint-disable @typescript-eslint/naming-convention */
          grant_type: "password",
          client_id: kcClientId,
          client_secret: kcClientSecret,
          /* eslint-enable @typescript-eslint/naming-convention */
          username,
          password,
          scope: "openid",
        },
      });
      if (!tokenResponse.ok()) {
        console.error(
          `Keycloak token request failed: ${tokenResponse.status()} ${await tokenResponse.text()}`,
        );
      }
      expect(tokenResponse.ok()).toBeTruthy();
      const tokenBody = await tokenResponse.json();
      const oidcToken = tokenBody.access_token;
      expect(oidcToken).toBeTruthy();

      // Execute token-propagation workflow via API
      const executeResponse = await page.request.post(
        `/api/orchestrator/v2/workflows/token-propagation/execute`,
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${backstageToken}`,
          },
          data: {
            inputData: {},
            authTokens: [
              { provider: "OAuth2", token: oidcToken },
              {
                provider: "SimpleBearerToken",
                token: "test-simple-bearer-token-value",
              },
            ],
          },
        },
      );
      if (!executeResponse.ok()) {
        console.error(
          `Workflow execution failed: ${executeResponse.status()} ${await executeResponse.text()}`,
        );
      }
      expect(executeResponse.ok()).toBeTruthy();
      const { id: instanceId } = await executeResponse.json();
      expect(instanceId).toBeTruthy();
      console.log(`Workflow instance started: ${instanceId}`);

      // Poll for workflow completion (up to 150 seconds)
      const maxPolls = 30;
      const pollInterval = 5000; // 5 seconds
      let finalState = "";
      let statusBody: WorkflowInstance = {} as WorkflowInstance;

      for (let poll = 1; poll <= maxPolls; poll++) {
        const statusResponse = await page.request.get(
          `/api/orchestrator/v2/workflows/instances/${instanceId}`,
          {
            headers: {
              Authorization: `Bearer ${backstageToken}`,
            },
          },
        );
        expect(statusResponse.ok()).toBeTruthy();
        statusBody = await statusResponse.json();
        finalState = statusBody.state;

        if (finalState === "COMPLETED") {
          console.log(`Workflow completed successfully after ${poll} polls`);
          break;
        }

        if (finalState === "ERROR") {
          console.error(
            "Workflow failed with ERROR state:",
            JSON.stringify(statusBody),
          );
          break;
        }

        console.log(
          `Workflow status: ${finalState} (poll ${poll}/${maxPolls})`,
        );
        await page.waitForTimeout(pollInterval);
      }

      expect(finalState).toBe("COMPLETED");

      // Verify workflow output data
      expect(statusBody.workflowdata.result.completedWith).toBe("success");
      expect(statusBody.workflowdata.result.message).toContain(
        "Token propagated",
      );

      // Verify all 3 token path nodes + extractUser completed without error
      const nodes = statusBody.nodes;
      const expectedNodes = [
        "getWithBearerTokenSecurityScheme",
        "getWithOtherBearerTokenSecurityScheme",
        "getWithSimpleBearerTokenSecurityScheme",
        "extractUser",
      ];
      for (const nodeName of expectedNodes) {
        const node = nodes.find((n: WorkflowNode) => n.name === nodeName);
        expect(node, `Node '${nodeName}' should exist`).toBeDefined();
        if (!node) continue;
        expect(
          node.errorMessage,
          `Node '${nodeName}' should have no error`,
        ).toBeNull();
        expect(
          node.exit,
          `Node '${nodeName}' should have completed`,
        ).not.toBeNull();
      }

      // Verify sample-server pod logs for token propagation evidence
      if (process.env.IS_OPENSHIFT !== "true") {
        console.log(
          "Skipping sample-server log verification: not running on OpenShift",
        );
        return;
      }

      const serviceUrl = statusBody.serviceUrl || "";
      const nsMatch = /token-propagation\.([^:/]+)/.exec(serviceUrl);
      const namespace = nsMatch?.[1] || process.env.NAME_SPACE || "";

      if (!namespace) {
        console.log(
          "Skipping sample-server log verification: namespace not found",
        );
        return;
      }

      // Validate namespace conforms to Kubernetes DNS-1123 label format
      // to prevent command injection via shell metacharacters
      if (!/^[a-z0-9-]+$/.test(namespace)) {
        throw new Error(
          `Invalid namespace format: "${namespace}". Must contain only lowercase alphanumeric characters and hyphens.`,
        );
      }

      const sampleServerLogs = execSync(
        `oc logs -l app=sample-server -n ${namespace} --tail=200`,
        { encoding: "utf-8", timeout: 30000 },
      );

      expect(
        sampleServerLogs,
        "Sample-server should log /first endpoint request",
      ).toContain("Headers for first");
      expect(
        sampleServerLogs,
        "Sample-server should log /other endpoint request",
      ).toContain("Headers for other");
      expect(
        sampleServerLogs,
        "Sample-server should log /simple endpoint request",
      ).toContain("Headers for simple");

      console.log("Sample-server log verification passed for all 3 endpoints");
    });
  });

  test.describe("Workflow all runs", () => {
    let orchestrator: OrchestratorPage;

    test.beforeEach(async ({ page, loginHelper }) => {
      orchestrator = new OrchestratorPage(page);
      await loginHelper.loginAsKeycloakUser();
    });

    test("Workflow All Runs Validation", async ({ uiHelper }) => {
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.validateWorkflowAllRuns();
    });
  });

  /**
   * Entity-Workflow Integration Tests
   *
   * Test Cases: RHIDP-11833 through RHIDP-11838
   *
   * These tests verify the integration between RHDH catalog entities and
   * Orchestrator workflows, including:
   * - EntityPicker-based entity association
   * - orchestrator.io/workflows annotation behavior
   * - Workflows tab visibility on entity pages
   * - Catalog <-> Workflows breadcrumb navigation
   * - Template execution -> workflow run linkage
   *
   * Templates used (from catalog locations in app-config-rhdh.yaml):
   * - greeting.yaml: name=greeting, title="Greeting workflow" - NO orchestrator.io/workflows annotation
   * - greeting_w_component.yaml: name=greetingComponent, title="Greeting Test Picker" - HAS annotation
   * - yamlgreet.yaml: name=greet, title="Greeting" - HAS annotation
   *
   * These are scaffolder templates that use the orchestrator:workflow:run action
   * to trigger the "greeting" SonataFlow workflow deployed by CI.
   */
  test.describe("Entity-Workflow Integration", () => {
    let orchestrator: OrchestratorPage;

    test.beforeEach(async ({ page, loginHelper }) => {
      orchestrator = new OrchestratorPage(page);
      await loginHelper.loginAsKeycloakUser();
    });

    test("RHIDP-11833: Select existing entity via EntityPicker for workflow run", async ({
      page,
      uiHelper,
    }) => {
      await uiHelper.clickLink({ ariaLabel: "Self-service" });
      await uiHelper.verifyHeading("Self-service");

      await page.waitForLoadState("domcontentloaded");

      await uiHelper.clickBtnInCard("Greeting Test Picker", "Choose");

      await uiHelper.verifyHeading(/Greeting Test Picker/i, 30000);

      const languageField = page.getByLabel("Language");
      await expect(languageField).toBeVisible({ timeout: 15000 });
      await languageField.click();
      await page.getByRole("option", { name: "English" }).click();

      const nameField = page.getByLabel("Name");
      await expect(nameField).toBeVisible({ timeout: 10000 });
      const uniqueName = `test-entity-${Date.now()}`;
      await nameField.fill(uniqueName);

      const reviewButton = page.getByRole("button", { name: /Review/i });
      await expect(reviewButton).toBeVisible({ timeout: 10000 });
      await reviewButton.click();
      await page.waitForLoadState("domcontentloaded");

      const createButton = page.getByRole("button", { name: /Create/i });
      await expect(createButton).toBeVisible({ timeout: 10000 });
      await createButton.click();

      // Wait for completion - any of these indicates the template task finished
      const viewInCatalog = page.getByRole("link", {
        name: "View in catalog",
      });
      const openWorkflowRun = page.getByRole("link", {
        name: "Open workflow run",
      });
      const startOver = page.getByRole("button", { name: "Start Over" });

      await expect(viewInCatalog.or(openWorkflowRun).or(startOver)).toBeVisible(
        {
          timeout: 120000,
        },
      );
    });

    test("RHIDP-11834: Template WITH orchestrator.io/workflows annotation", async ({
      page,
      uiHelper,
    }) => {
      await uiHelper.openSidebar("Catalog");
      await uiHelper.verifyHeading("My Org Catalog");
      await uiHelper.selectMuiBox("Kind", "Template");

      // "Greeting Test Picker" (greeting_w_component.yaml) HAS the
      // orchestrator.io/workflows annotation: '["greeting"]'
      const templateLink = page.getByRole("link", {
        name: /Greeting Test Picker/i,
      });

      await expect(templateLink).toBeVisible({ timeout: 30000 });
      await templateLink.click();

      await page.waitForLoadState("domcontentloaded");

      // Workflows tab should be visible because of the annotation
      await orchestrator.clickWorkflowsTab();

      await orchestrator.verifyWorkflowInEntityTab("Greeting workflow");
    });

    test("RHIDP-11835: Template WITHOUT orchestrator.io/workflows annotation (negative)", async ({
      page,
      uiHelper,
    }) => {
      await uiHelper.openSidebar("Catalog");
      await uiHelper.verifyHeading("My Org Catalog");
      await uiHelper.selectMuiBox("Kind", "Template");

      // "Greeting workflow" (greeting.yaml) does NOT have the
      // orchestrator.io/workflows annotation
      const templateLink = page.getByRole("link", {
        name: /Greeting workflow/i,
      });

      await expect(templateLink).toBeVisible({ timeout: 30000 });
      await templateLink.click();

      await page.waitForLoadState("domcontentloaded");

      // Workflows tab should not exist without the annotation
      await expect(page.getByRole("tab", { name: "Workflows" })).toHaveCount(0);
    });

    test("RHIDP-11836: Catalog <-> Workflows breadcrumb navigation", async ({
      page,
      uiHelper,
    }) => {
      await uiHelper.openSidebar("Catalog");
      await uiHelper.verifyHeading("My Org Catalog");
      await uiHelper.selectMuiBox("Kind", "Template");

      const templateLink = page.getByRole("link", {
        name: /Greeting Test Picker/i,
      });

      await expect(templateLink).toBeVisible({ timeout: 30000 });
      await templateLink.click();

      await page.waitForLoadState("domcontentloaded");

      await orchestrator.clickWorkflowsTab();

      const workflowLink = page.getByRole("link", {
        name: "Greeting workflow",
      });
      await expect(workflowLink).toBeVisible({ timeout: 10000 });
      await workflowLink.click();

      await expect(
        page.getByRole("heading", { name: "Greeting workflow" }),
      ).toBeVisible();

      // Verify breadcrumb navigation works - look for breadcrumb with entity name
      const entityName = "greetingComponent";
      const breadcrumb = page.getByRole("navigation", {
        name: /breadcrumb/i,
      });
      if ((await breadcrumb.count()) > 0 && entityName) {
        const entityBreadcrumb = breadcrumb.getByText(entityName);
        if ((await entityBreadcrumb.count()) > 0) {
          await entityBreadcrumb.click();
          await page.waitForLoadState("load");

          await expect(
            page.getByRole("heading", { name: /Greeting Test Picker/i }),
          ).toBeVisible();
        }
      }
    });

    test("RHIDP-11837: Template run produces visible workflow runs", async ({
      page,
      uiHelper,
    }) => {
      await uiHelper.clickLink({ ariaLabel: "Self-service" });
      await uiHelper.verifyHeading("Self-service");

      await page.waitForLoadState("domcontentloaded");
      await uiHelper.clickBtnInCard("Greeting Test Picker", "Choose");

      await uiHelper.verifyHeading(/Greeting Test Picker/i, 30000);

      const nameField = page.getByLabel("Name");
      await expect(nameField).toBeVisible({ timeout: 10000 });
      const uniqueName = `test-entity-${Date.now()}`;
      await nameField.fill(uniqueName);

      const languageField = page.getByLabel("Language");
      if (await languageField.isVisible({ timeout: 5000 })) {
        await languageField.click();
        await page.getByRole("option", { name: "English" }).click();
      }

      const reviewButton = page.getByRole("button", { name: /Review/i });
      await expect(reviewButton).toBeVisible({ timeout: 10000 });
      await reviewButton.click();
      await page.waitForLoadState("domcontentloaded");

      const createButton = page.getByRole("button", { name: /Create/i });
      await expect(createButton).toBeVisible({ timeout: 10000 });
      await createButton.click();

      // Accept success or 409 Conflict (entity already registered from a prior run)
      const completed = page.getByText(/Completed|succeeded|finished/i);
      const conflictError = page.getByText(/409 Conflict/i);
      const startOver = page.getByRole("button", { name: "Start Over" });

      await expect(completed.or(conflictError).or(startOver)).toBeVisible({
        timeout: 120000,
      });

      await uiHelper.openSidebar("Orchestrator");
      await expect(
        page.getByRole("heading", { name: "Workflows" }),
      ).toBeVisible();

      const greetingWorkflow = page.getByRole("link", {
        name: /Greeting workflow/i,
      });
      await expect(greetingWorkflow).toBeVisible({ timeout: 30000 });
    });

    test("RHIDP-11838: Dynamic plugin config enables Workflows tab", async ({
      page,
      uiHelper,
    }) => {
      await uiHelper.openSidebar("Catalog");
      await uiHelper.verifyHeading("My Org Catalog");
      await uiHelper.selectMuiBox("Kind", "Template");

      const templateLink = page.getByRole("link", {
        name: /Greeting Test Picker/i,
      });

      await expect(templateLink).toBeVisible({ timeout: 30000 });
      await templateLink.click();

      await page.waitForLoadState("domcontentloaded");

      // Workflows tab is enabled by the dynamic plugin configuration
      await orchestrator.verifyWorkflowsTabVisible();

      await orchestrator.clickWorkflowsTab();

      // The OrchestratorCatalogTab card should render workflow info from the annotation
      const workflowsContent = page.locator("main").filter({
        has: page.getByText("Greeting workflow"),
      });
      await expect(workflowsContent).toBeVisible();
    });
  });
});

function getHttpbinValue(ns: string): string | undefined {
  try {
    const result = execSync(
      `oc -n ${ns} get sonataflow failswitch -o jsonpath='{.spec.podTemplate.container.env[?(@.name=="HTTPBIN")].value}'`,
      { encoding: "utf-8", timeout: 30_000 },
    );
    return result.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function patchHttpbin(ns: string, value: string): Promise<void> {
  const patch = `{"spec":{"podTemplate":{"container":{"env":[{"name":"HTTPBIN","value":"${value}"}]}}}}`;
  console.log("patching HTTPBIN in sonataflow resource to", value);
  await $`oc -n ${ns} patch sonataflow failswitch --type merge -p ${patch}`;
}

async function restartAndWait(ns: string): Promise<void> {
  console.log("restarting deployment failswitch");
  await $`oc -n ${ns} rollout restart deployment failswitch`;

  console.log("waiting for rollout to complete");
  await $`oc -n ${ns} rollout status deployment failswitch --timeout=60s`;
}

async function cleanupAfterTest(
  ns: string,
  originalHttpbin: string,
): Promise<void> {
  const currentHttpbin = getHttpbinValue(ns);
  if (currentHttpbin !== originalHttpbin) {
    await patchHttpbin(ns, originalHttpbin);
    await restartAndWait(ns);
  }
}
