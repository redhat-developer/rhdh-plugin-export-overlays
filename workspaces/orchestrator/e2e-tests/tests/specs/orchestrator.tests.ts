import { execFileSync } from "node:child_process";
import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import { AuthApiHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { OrchestratorPage } from "@red-hat-developer-hub/e2e-test-utils/pages";
import {
  ensureBaselineRole,
  deploySonataflow,
  cleanupGreetingComponentEntity,
  runOc,
  clickCreateAndWaitForScaffolderTerminalState,
} from "./test-helpers.js";

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

function isDataIndexHealthy(ns: string): boolean {
  try {
    const health = runOc(
      [
        "exec",
        "-n",
        ns,
        "deploy/sonataflow-platform-data-index-service",
        "--",
        "curl",
        "-s",
        "--max-time",
        "5",
        "http://localhost:8080/q/health/ready",
      ],
      15_000,
    );
    const parsed = JSON.parse(health);
    return parsed.status === "UP";
  } catch {
    return false;
  }
}

async function recoverDataIndex(ns: string): Promise<boolean> {
  try {
    runOc(
      [
        "rollout",
        "restart",
        "deploy/sonataflow-platform-data-index-service",
        "-n",
        ns,
      ],
      15_000,
    );
    runOc(
      [
        "rollout",
        "status",
        "deploy/sonataflow-platform-data-index-service",
        "-n",
        ns,
        "--timeout=120s",
      ],
      130_000,
    );
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      if (isDataIndexHealthy(ns)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

let dataIndexRecoveryFailed = false;

async function ensureDataIndexOrSkip(
  ns: string,
  test: { skip: (condition: boolean, reason: string) => void },
): Promise<void> {
  if (dataIndexRecoveryFailed) {
    test.skip(true, "Data-index recovery already failed earlier — skipping");
    return;
  }
  if (isDataIndexHealthy(ns)) return;
  const recovered = await recoverDataIndex(ns);
  if (!recovered) {
    dataIndexRecoveryFailed = true;
  }
  test.skip(
    !recovered,
    "Data-index is unhealthy and could not be recovered — skipping workflow execution test",
  );
}

test.describe("Orchestrator", () => {
  test.beforeAll(async ({ rhdh, browser }, testInfo) => {
    test.setTimeout(20 * 60 * 1000);
    await test.runOnce("orchestrator-setup", async () => {
      const project = rhdh.deploymentConfig.namespace;
      // eslint-disable-next-line no-console -- version/PID logged once for CI diagnostics
      console.log(
        `[orchestrator-setup]   Node.js ${process.version}, PID ${process.pid}`,
      );
      await rhdh.configure({ auth: "keycloak" });
      await deploySonataflow(project);
      process.env.SONATAFLOW_DATA_INDEX_URL =
        "http://sonataflow-platform-data-index-service";
      await rhdh.deploy({ timeout: null });
    });
    await ensureBaselineRole(browser, testInfo);
    testInfo.annotations.push({
      type: "component",
      description: "orchestrator",
    });
  });

  test.describe("Greeting workflow", () => {
    let orchestrator: OrchestratorPage;

    test.beforeEach(async ({ page, loginHelper }, testInfo) => {
      orchestrator = new OrchestratorPage(page);
      await loginHelper.loginAsKeycloakUser();
      await ensureDataIndexOrSkip(testInfo.project.name, test);
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Greeting workflow execution and workflow tab validation", async ({
      uiHelper,
      page: _page,
    }) => {
      test.setTimeout(150_000);
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectGreetingWorkflowItem();
      await orchestrator.runGreetingWorkflow();
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.validateGreetingWorkflow();
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Greeting workflow run details validation", async ({
      uiHelper,
      page: _page,
    }) => {
      test.setTimeout(150_000);
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectGreetingWorkflowItem();
      await orchestrator.runGreetingWorkflow();
      await orchestrator.reRunGreetingWorkflow();
      await orchestrator.validateWorkflowRunsDetails();
    });
  });

  test.describe("Failswitch workflow", () => {
    let orchestrator: OrchestratorPage;

    test.beforeEach(async ({ page, loginHelper }, testInfo) => {
      orchestrator = new OrchestratorPage(page);
      await loginHelper.loginAsKeycloakUser();
      await ensureDataIndexOrSkip(testInfo.project.name, test);
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Failswitch workflow execution and workflow tab validation", async ({
      uiHelper,
      page: _page,
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

    // eslint-disable-next-line playwright/expect-expect
    test("Abort workflow", async ({ uiHelper, page: _page }) => {
      test.setTimeout(180_000);
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectFailSwitchWorkflowItem();
      await orchestrator.runFailSwitchWorkflow("Wait");
      await orchestrator.abortWorkflow();
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Running status validations", async ({ uiHelper, page: _page }) => {
      test.setTimeout(180_000);
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectFailSwitchWorkflowItem();
      await orchestrator.runFailSwitchWorkflow("Wait");
      await orchestrator.validateWorkflowStatusDetails("Running");
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Failed status validations", async ({ uiHelper, page: _page }) => {
      test.setTimeout(180_000);
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectFailSwitchWorkflowItem();
      await orchestrator.runFailSwitchWorkflow("KO");
      await orchestrator.validateWorkflowStatusDetails("Failed");
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Completed status validations", async ({ uiHelper, page: _page }) => {
      test.setTimeout(180_000);
      await uiHelper.openSidebar("Orchestrator");
      await orchestrator.selectFailSwitchWorkflowItem();
      await orchestrator.runFailSwitchWorkflow("OK");
      await orchestrator.validateWorkflowStatusDetails("Completed");
    });

    // eslint-disable-next-line playwright/expect-expect
    test("Rerunning from failure point using failswitch workflow", async ({
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
        console.error(`[rerun-failure] Test failed: ${e}`);
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

      await expect(
        page.getByRole("heading", { name: /suggested next workflow/i }),
      ).toBeVisible();
      const greetingLink = page.getByRole("link", { name: /greeting/i });
      await expect(greetingLink).toBeVisible();
      await greetingLink.click();

      await expect(
        page.getByRole("dialog", { name: /greeting workflow/i }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /run workflow/i }),
      ).toBeVisible();
      await page.getByRole("button", { name: /run workflow/i }).click();

      await expect(
        page.getByRole("heading", { name: "Greeting workflow" }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Next" })).toBeVisible();
    });
  });

  test.describe("Token propagation workflow API", () => {
    // eslint-disable-next-line playwright/no-skipped-test
    test.skip("Token propagation workflow executes successfully via API", async ({
      page,
      loginHelper,
    }) => {
      // 5 minutes for workflow execution + polling
      test.setTimeout(5 * 60 * 1000);

      await loginHelper.loginAsKeycloakUser();

      const backstageToken = await new AuthApiHelper(page).getToken();

      const kcBaseUrl = decodeEnvVar("KEYCLOAK_AUTH_BASE_URL");
      const kcRealm = decodeEnvVar("KEYCLOAK_AUTH_REALM");
      const kcClientId = decodeEnvVar("KEYCLOAK_AUTH_CLIENTID");
      const kcClientSecret = decodeEnvVar("KEYCLOAK_AUTH_CLIENT_SECRET");

      const username = process.env.GH_USER_ID;
      const password = process.env.GH_USER_PASS;
      // eslint-disable-next-line playwright/no-conditional-in-test
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
      // eslint-disable-next-line playwright/no-conditional-in-test
      if (!tokenResponse.ok()) {
        console.error(
          `Keycloak token request failed: ${tokenResponse.status()} ${await tokenResponse.text()}`,
        );
      }
      expect(tokenResponse.ok()).toBeTruthy();
      const tokenBody = await tokenResponse.json();
      const oidcToken = tokenBody.access_token;
      expect(oidcToken).toBeTruthy();

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
      // eslint-disable-next-line playwright/no-conditional-in-test
      if (!executeResponse.ok()) {
        console.error(
          `Workflow execution failed: ${executeResponse.status()} ${await executeResponse.text()}`,
        );
      }
      expect(executeResponse.ok()).toBeTruthy();
      const { id: instanceId } = await executeResponse.json();
      expect(instanceId).toBeTruthy();

      const maxPolls = 30;
      const pollInterval = 5000;
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

        // eslint-disable-next-line playwright/no-conditional-in-test
        if (finalState === "COMPLETED") {
          break;
        }

        // eslint-disable-next-line playwright/no-conditional-in-test
        if (finalState === "ERROR") {
          console.error(
            "Workflow failed with ERROR state:",
            JSON.stringify(statusBody),
          );
          break;
        }

        // eslint-disable-next-line playwright/no-wait-for-timeout
        await page.waitForTimeout(pollInterval);
      }

      expect(finalState).toBe("COMPLETED");

      expect(statusBody.workflowdata.result.completedWith).toBe("success");
      expect(statusBody.workflowdata.result.message).toContain(
        "Token propagated",
      );

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
        // eslint-disable-next-line playwright/no-conditional-in-test
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

      // eslint-disable-next-line playwright/no-conditional-in-test
      if (process.env.IS_OPENSHIFT !== "true") {
        return;
      }

      const serviceUrl = statusBody.serviceUrl || "";
      const nsMatch = /token-propagation\.([^:/]+)/.exec(serviceUrl);
      const namespace = nsMatch?.[1] || process.env.NAME_SPACE || "";

      // eslint-disable-next-line playwright/no-conditional-in-test
      if (!namespace) {
        return;
      }

      // Validate namespace conforms to Kubernetes DNS-1123 label format
      // to prevent command injection via shell metacharacters
      // eslint-disable-next-line playwright/no-conditional-in-test
      if (!/^[a-z0-9-]+$/.test(namespace)) {
        throw new Error(
          `Invalid namespace format: "${namespace}". Must contain only lowercase alphanumeric characters and hyphens.`,
        );
      }

      const sampleServerLogs = runOc(
        ["logs", "-l", "app=sample-server", "-n", namespace, "--tail=200"],
        30_000,
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
    });
  });

  test.describe("Workflow all runs", () => {
    let orchestrator: OrchestratorPage;

    test.beforeEach(async ({ page, loginHelper }) => {
      orchestrator = new OrchestratorPage(page);
      await loginHelper.loginAsKeycloakUser();
    });

    // eslint-disable-next-line playwright/expect-expect
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
   * Templates used (from testetson22/greeting_54mjks on GitHub):
   * - greeting.yaml: name=greeting, title="Greeting workflow" - NO orchestrator.io/workflows annotation
   * - greeting_w_component.yaml: name=greetingComponent, title="Greeting Test Picker" - HAS annotation
   *
   * These are scaffolder templates that use the orchestrator:workflow:run action
   * to trigger the "greeting" SonataFlow workflow deployed by CI.
   */
  test.describe("Entity-Workflow Integration", () => {
    let orchestrator: OrchestratorPage;

    test.beforeEach(async ({ page, loginHelper }, testInfo) => {
      orchestrator = new OrchestratorPage(page);
      await loginHelper.loginAsKeycloakUser();
      await ensureDataIndexOrSkip(testInfo.project.name, test);
    });

    test.afterAll(async () => {
      await cleanupGreetingComponentEntity();
    });

    test("RHIDP-11833: Select existing entity via EntityPicker for workflow run", async ({
      page,
      uiHelper,
    }) => {
      await uiHelper.clickLink({ ariaLabel: "Self-service" });
      await uiHelper.verifyHeading("Self-service");

      await page.waitForLoadState("domcontentloaded");

      await uiHelper.clickBtnInCard("Greeting Test Picker", "Choose");

      await page.waitForURL(/\/create\/templates\//, { timeout: 30000 });
      await page.waitForLoadState("domcontentloaded");
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

      const workflowsTab = page.getByRole("tab", { name: "Workflows" });
      const tabCount = await workflowsTab.count();

      // eslint-disable-next-line playwright/no-conditional-in-test
      if (tabCount > 0) {
        // Tab exists but should not list greeting (no annotation)
        await workflowsTab.click();
        await page.waitForLoadState("domcontentloaded");
        const greetingWorkflow = page.getByText("Greeting workflow");
        // eslint-disable-next-line playwright/no-conditional-expect
        await expect(greetingWorkflow).toHaveCount(0);
      }
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

      const entityName = "greetingComponent";
      const breadcrumb = page.getByRole("navigation", {
        name: /breadcrumb/i,
      });
      const breadcrumbCount = await breadcrumb.count();
      // eslint-disable-next-line playwright/no-conditional-in-test
      if (breadcrumbCount > 0 && entityName) {
        const entityBreadcrumb = breadcrumb.getByText(entityName);
        const entityBreadcrumbCount = await entityBreadcrumb.count();
        // eslint-disable-next-line playwright/no-conditional-in-test
        if (entityBreadcrumbCount > 0) {
          await entityBreadcrumb.click();
          await page.waitForLoadState("load");

          // eslint-disable-next-line playwright/no-conditional-expect
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

      await page.waitForURL(/\/create\/templates\//, { timeout: 30000 });
      await page.waitForLoadState("domcontentloaded");
      await uiHelper.verifyHeading(/Greeting Test Picker/i, 30000);

      const nameField = page.getByLabel("Name");
      await expect(nameField).toBeVisible({ timeout: 10000 });
      const uniqueName = `test-entity-${Date.now()}`;
      await nameField.fill(uniqueName);

      const languageField = page.getByLabel("Language");
      // eslint-disable-next-line playwright/no-conditional-in-test
      if (await languageField.isVisible({ timeout: 5000 })) {
        await languageField.click();
        await page.getByRole("option", { name: "English" }).click();
      }

      const reviewButton = page.getByRole("button", { name: /Review/i });
      await expect(reviewButton).toBeVisible({ timeout: 10000 });
      await reviewButton.click();
      await page.waitForLoadState("domcontentloaded");

      await clickCreateAndWaitForScaffolderTerminalState(page);

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

      await orchestrator.verifyWorkflowsTabVisible();

      await orchestrator.clickWorkflowsTab();

      const workflowsContent = page.locator("main").filter({
        has: page.getByText("Greeting workflow"),
      });
      await expect(workflowsContent).toBeVisible();
    });
  });
});

function getHttpbinValue(ns: string): string | undefined {
  try {
    const result = execFileSync(
      "oc",
      [
        "-n",
        ns,
        "get",
        "sonataflow",
        "failswitch",
        "-o",
        `jsonpath={.spec.podTemplate.container.env[?(@.name=='HTTPBIN')].value}`,
      ],
      { encoding: "utf-8", timeout: 30_000 },
    );
    const value = result.trim() || undefined;
    return value;
  } catch {
    return undefined;
  }
}

async function patchHttpbin(ns: string, value: string): Promise<void> {
  let existing: Array<{ name: string; value: string }> = [];
  try {
    const raw = execFileSync(
      "oc",
      [
        "-n",
        ns,
        "get",
        "sonataflow",
        "failswitch",
        "-o",
        "jsonpath={.spec.podTemplate.container.env}",
      ],
      { encoding: "utf-8", timeout: 30_000 },
    ).trim();
    if (raw && raw !== "null" && raw !== "") {
      existing = JSON.parse(raw);
    }
  } catch {
    // ignore
  }
  const idx = existing.findIndex((e: { name: string }) => e.name === "HTTPBIN");
  if (idx >= 0) existing[idx] = { name: "HTTPBIN", value };
  else existing.push({ name: "HTTPBIN", value });
  const patch = JSON.stringify({
    spec: { podTemplate: { container: { env: existing } } },
  });
  execFileSync(
    "oc",
    [
      "-n",
      ns,
      "patch",
      "sonataflow",
      "failswitch",
      "--type",
      "merge",
      "-p",
      patch,
    ],
    { encoding: "utf-8", timeout: 30_000 },
  );
}

async function restartAndWait(ns: string): Promise<void> {
  execFileSync(
    "oc",
    ["-n", ns, "rollout", "restart", "deployment", "failswitch"],
    { encoding: "utf-8", timeout: 30_000 },
  );

  execFileSync(
    "oc",
    [
      "-n",
      ns,
      "rollout",
      "status",
      "deployment",
      "failswitch",
      "--timeout=60s",
    ],
    { encoding: "utf-8", timeout: 90_000 },
  );
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
