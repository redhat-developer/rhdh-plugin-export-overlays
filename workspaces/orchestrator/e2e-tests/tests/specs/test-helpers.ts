import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  test,
  expect,
  Browser,
  TestInfo,
  Page,
} from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  setupBrowser,
  LoginHelper,
  UIhelper,
  AuthApiHelper,
  APIHelper,
  RbacApiHelper,
  Policy,
  Response,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { installOrchestrator } from "@red-hat-developer-hub/e2e-test-utils/orchestrator";
import { $ } from "@red-hat-developer-hub/e2e-test-utils/utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PRIMARY_USER = `user:default/${process.env.PRIMARY_TEST_USER || "test1"}`;
export const SECONDARY_USER = `user:default/${process.env.SECONDARY_TEST_USER || "test2"}`;

export const BASELINE_ROLE_NAME = "role:default/orchestrator-baseline";

const GREETING_COMPONENT_LOCATION =
  "https://github.com/testetson22/greeting_54mjks/blob/main/templates/greeting/skeleton/catalog-info.yaml";

const WORKFLOW_REPO =
  "https://github.com/rhdhorchestrator/serverless-workflows.git";
const WORKFLOW_REPO_REF =
  process.env.SERVERLESS_WORKFLOWS_REF ||
  "daeeee8dec16beab6d96a81774ef500081a2c2b0";

const MANIFEST_DIRS = [
  "workflows/greeting/manifests",
  "workflows/fail-switch/src/main/resources/manifests",
];

const WORKFLOWS = ["greeting", "failswitch"];

// ---------------------------------------------------------------------------
// RBAC helpers
// ---------------------------------------------------------------------------

export type PolicySpec = {
  permission: string;
  policy: string;
  effect: string;
};

export function globalWorkflowPolicies(
  readEffect: "allow" | "deny",
  useEffect: "allow" | "deny",
): PolicySpec[] {
  return [
    {
      permission: "orchestrator.workflow",
      policy: "read",
      effect: readEffect,
    },
    {
      permission: "orchestrator.workflow.use",
      policy: "update",
      effect: useEffect,
    },
  ];
}

export function greetingWorkflowPolicies(
  readEffect: "allow" | "deny",
  useEffect: "allow" | "deny",
): PolicySpec[] {
  return [
    {
      permission: "orchestrator.workflow.greeting",
      policy: "read",
      effect: readEffect,
    },
    {
      permission: "orchestrator.workflow.use.greeting",
      policy: "update",
      effect: useEffect,
    },
  ];
}

export function roleApiName(roleName: string): string {
  return roleName.replace("role:", "").replace("default/", "");
}

export function buildPolicies(roleName: string, specs: PolicySpec[]) {
  return specs.map((spec) => ({ entityReference: roleName, ...spec }));
}

export async function createRoleWithPolicies(
  apiToken: string,
  roleName: string,
  memberReferences: string[],
  policySpecs: PolicySpec[],
): Promise<void> {
  const rbacApi = await RbacApiHelper.build(apiToken);
  const rolePostResponse = await rbacApi.createRoles({
    memberReferences,
    name: roleName,
  });
  const policyPostResponse = await rbacApi.createPolicies(
    buildPolicies(roleName, policySpecs),
  );
  expect(rolePostResponse.ok()).toBeTruthy();
  expect(policyPostResponse.ok()).toBeTruthy();
}

export async function verifyRoleWithPolicies(
  apiToken: string,
  roleName: string,
  expectedMembers: string[],
  expectedPolicies: PolicySpec[],
): Promise<void> {
  const rbacApi = await RbacApiHelper.build(apiToken);

  const rolesResponse = await rbacApi.getRoles();
  expect(rolesResponse.ok()).toBeTruthy();

  const roles = await rolesResponse.json();
  const workflowRole = roles.find(
    (role: { name: string; memberReferences: string[] }) =>
      role.name === roleName,
  );
  expect(workflowRole).toBeDefined();
  for (const member of expectedMembers) {
    expect(workflowRole?.memberReferences).toContain(member);
  }

  const policiesResponse = await rbacApi.getPoliciesByRole(
    roleApiName(roleName),
  );
  expect(policiesResponse.ok()).toBeTruthy();

  const policies = await policiesResponse.json();
  expect(policies).toHaveLength(expectedPolicies.length);

  for (const expectedPolicy of expectedPolicies) {
    const actualPolicy = policies.find(
      (policy: { permission: string; policy: string; effect: string }) =>
        policy.permission === expectedPolicy.permission &&
        policy.policy === expectedPolicy.policy,
    );
    expect(actualPolicy).toBeDefined();
    expect(actualPolicy.effect).toBe(expectedPolicy.effect);
  }
}

const BASELINE_POLICIES = buildPolicies(BASELINE_ROLE_NAME, [
  { permission: "orchestrator.workflow", policy: "read", effect: "allow" },
  {
    permission: "orchestrator.workflow.use",
    policy: "update",
    effect: "allow",
  },
  { permission: "catalog-entity", policy: "read", effect: "allow" },
  { permission: "catalog.entity.create", policy: "create", effect: "allow" },
  { permission: "catalog.location.read", policy: "read", effect: "allow" },
  { permission: "catalog.location.create", policy: "create", effect: "allow" },
  {
    permission: "scaffolder.action.execute",
    policy: "use",
    effect: "allow",
  },
  { permission: "scaffolder.task.create", policy: "create", effect: "allow" },
  { permission: "scaffolder.task.read", policy: "read", effect: "allow" },
  {
    permission: "scaffolder.template.parameter.read",
    policy: "read",
    effect: "allow",
  },
  {
    permission: "scaffolder.template.step.read",
    policy: "read",
    effect: "allow",
  },
]);

async function withTempPage(
  browser: Browser,
  fn: (page: Awaited<ReturnType<typeof browser.newPage>>) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext({
    baseURL: process.env.RHDH_BASE_URL,
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  try {
    await fn(page);
  } finally {
    await context.close();
  }
}

export async function setupAuthenticatedPage(
  browser: Browser,
  testInfo: TestInfo,
): Promise<{
  page: Page;
  uiHelper: UIhelper;
  loginHelper: LoginHelper;
  apiToken: string;
}> {
  const { page } = await setupBrowser(browser, testInfo);
  const uiHelper = new UIhelper(page);
  const loginHelper = new LoginHelper(page);
  await loginHelper.loginAsKeycloakUser();
  const apiToken = await new AuthApiHelper(page).getToken();
  return { page, uiHelper, loginHelper, apiToken };
}

export async function launchGreetingTemplateFromSelfService(
  page: Page,
  uiHelper: UIhelper,
): Promise<void> {
  await uiHelper.clickLink({ ariaLabel: "Self-service" });
  await uiHelper.verifyHeading("Self-service");
  await page.waitForLoadState("domcontentloaded");
  await uiHelper.clickBtnInCard("Greeting Test Picker", "Choose");
  await uiHelper.verifyHeading(/Greeting Test Picker/i, 30_000);
}

export async function waitForScaffolderTerminalState(
  page: Page,
  timeoutMs = 120_000,
): Promise<void> {
  const completed = page.getByText(/Completed|succeeded|finished/i);
  const conflictError = page.getByText(/409 Conflict/i);
  const startOver = page.getByRole("button", { name: "Start Over" });
  await completed
    .or(conflictError)
    .or(startOver)
    .first()
    .waitFor({ state: "visible", timeout: timeoutMs });
}

export async function clickCreateAndWaitForScaffolderTerminalState(
  page: Page,
  timeoutMs = 120_000,
): Promise<void> {
  const createButton = page.getByRole("button", { name: /Create/i });
  await createButton.waitFor({ state: "visible", timeout: 10_000 });
  await createButton.click();
  await waitForScaffolderTerminalState(page, timeoutMs);
}

export async function deleteRoleAndPolicies(
  apiToken: string,
  roleName: string,
): Promise<void> {
  const rbacApi = await RbacApiHelper.build(apiToken);
  const apiName = roleApiName(roleName);
  try {
    const policiesResponse = await rbacApi.getPoliciesByRole(apiName);
    if (policiesResponse.ok()) {
      const policies =
        await Response.removeMetadataFromResponse(policiesResponse);
      await rbacApi.deletePolicy(apiName, policies as Policy[]);
    }
    await rbacApi.deleteRole(apiName);
  } catch {
    // role may not exist yet
  }
}

export async function ensureBaselineRole(
  browser: Browser,
  _testInfo: TestInfo,
): Promise<void> {
  await test.runOnce("rbac-baseline-setup", async () => {
    await withTempPage(browser, async (page) => {
      const loginHelper = new LoginHelper(page);
      await loginHelper.loginAsKeycloakUser();
      const token = await new AuthApiHelper(page).getToken();
      const rbacApi = await RbacApiHelper.build(token);

      await rbacApi.createRoles({
        memberReferences: [PRIMARY_USER],
        name: BASELINE_ROLE_NAME,
      });

      await rbacApi.createPolicies(BASELINE_POLICIES);
    });
  });
}

export async function removeBaselineRole(
  browser: Browser,
  _testInfo: TestInfo,
): Promise<void> {
  await test.runOnce("rbac-baseline-cleanup", async () => {
    await withTempPage(browser, async (page) => {
      const loginHelper = new LoginHelper(page);
      await loginHelper.loginAsKeycloakUser();
      const token = await new AuthApiHelper(page).getToken();
      await deleteRoleAndPolicies(token, BASELINE_ROLE_NAME);

      const rbacApi = await RbacApiHelper.build(token);
      const verifyResponse = await rbacApi.getRoles();
      if (verifyResponse.ok()) {
        const roles = await verifyResponse.json();
        const found = roles.find(
          (r: { name: string }) => r.name === BASELINE_ROLE_NAME,
        );
        if (found) {
          console.warn(
            "[rbac-baseline] WARNING: Baseline role was NOT removed successfully!",
          );
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Catalog cleanup
// ---------------------------------------------------------------------------

export async function cleanupGreetingComponentEntity(): Promise<void> {
  try {
    const locationId = await APIHelper.getLocationIdByTarget(
      GREETING_COMPONENT_LOCATION,
    );
    if (locationId) {
      await APIHelper.deleteEntityLocationById(locationId);
    }
  } catch (e) {
    console.warn("Cleanup of greeting-test-component location failed:", e);
  }
}

// ---------------------------------------------------------------------------
// SonataFlow deployment
// ---------------------------------------------------------------------------

export async function deploySonataflow(namespace: string): Promise<void> {
  await installOrchestrator(namespace);

  const oslFullVersion = detectOperatorVersion(
    "operators.coreos.com/logic-operator.openshift-operators",
    "operators.coreos.com/logic-operator-rhel8.openshift-operators",
  );
  const oslMajorMinor = oslFullVersion.replace(/^(\d+\.\d+).*/, "$1") || "";

  const osFullVersion = detectOperatorVersion(
    "operators.coreos.com/serverless-operator.openshift-operators",
  );
  const osMajorMinor = osFullVersion.replace(/^(\d+\.\d+).*/, "$1") || "";

  if (oslMajorMinor && osMajorMinor && oslMajorMinor !== osMajorMinor) {
    console.warn(
      `[deploy-sonataflow] WARNING: OS (${osMajorMinor}) and OSL (${oslMajorMinor}) major.minor versions differ — this may cause Knative API incompatibilities`,
    );
  } else {
    console.warn(
      `[deploy-sonataflow] Operator versions: OS=${osFullVersion || "unknown"}, OSL=${oslFullVersion || "unknown"}`,
    );
  }

  hardenSonataFlowPlatform(namespace);

  const workflowDir = `/tmp/serverless-workflows-${process.pid}`;
  try {
    await $`git clone --depth=1 ${WORKFLOW_REPO} ${workflowDir}`;
    await $`git -C ${workflowDir} fetch --depth=1 origin ${WORKFLOW_REPO_REF}`;
    await $`git -C ${workflowDir} checkout --detach ${WORKFLOW_REPO_REF}`;

    for (const rel of MANIFEST_DIRS) {
      const fullPath = join(workflowDir, rel);
      await $`oc apply -n ${namespace} -f ${fullPath}`;
    }
  } finally {
    await $`rm -rf ${workflowDir}`.catch(() => {});
  }

  await waitForCRs(namespace);

  // Patch persistence before image alignment so the operator never materializes
  // ReplicaSets that still reference upstream `sonataflow-psql-postgresql` (missing).
  for (const workflow of WORKFLOWS) {
    patchWorkflowPostgres(namespace, workflow);
  }

  alignWorkflowImages(namespace, oslMajorMinor);

  // Image patch can trigger another reconcile; re-apply persistence for safety.
  for (const workflow of WORKFLOWS) {
    patchWorkflowPostgres(namespace, workflow);
  }

  for (const workflow of WORKFLOWS) {
    await waitForReconciliation(namespace, workflow, 60);
    runOc(
      [
        "rollout",
        "status",
        `deployment/${workflow}`,
        "-n",
        namespace,
        "--timeout=600s",
      ],
      610_000,
    );
  }
}

function patchWorkflowPostgres(namespace: string, workflow: string): string {
  const patch = JSON.stringify({
    spec: {
      persistence: {
        postgresql: {
          secretRef: {
            name: "backstage-psql-secret",
            userKey: "POSTGRES_USER",
            passwordKey: "POSTGRES_PASSWORD",
          },
          serviceRef: {
            name: "backstage-psql",
            namespace,
            databaseName: "backstage_plugin_orchestrator",
          },
        },
      },
    },
  });
  return runOc([
    "-n",
    namespace,
    "patch",
    "sonataflow",
    workflow,
    "--type",
    "merge",
    "-p",
    patch,
  ]);
}

async function waitForCRs(namespace: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const out = runOc(["get", "sonataflow", "-n", namespace, "--no-headers"]);
      const found = out.split("\n").filter(Boolean).length;
      if (found >= WORKFLOWS.length) {
        return;
      }
    } catch {
      // not available yet
    }
    await sleep(5_000);
  }
  console.warn(
    `[deploy-sonataflow] TIMEOUT: Only found fewer than ${WORKFLOWS.length} SonataFlow CRs after ${attempt} attempts`,
  );
}

async function waitForReconciliation(
  namespace: string,
  workflow: string,
  timeoutSecs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutSecs * 1_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const status = runOc([
        "get",
        "deployment",
        workflow,
        "-n",
        namespace,
        "-o",
        'jsonpath={.status.conditions[?(@.type=="Progressing")].status}',
      ]);
      const cleaned = status.replaceAll("'", "");
      if (cleaned === "True") {
        return;
      }
    } catch {
      // not available yet
    }
    await sleep(2_000);
  }
  console.warn(
    `[deploy-sonataflow] TIMEOUT waiting for reconciliation of ${workflow} after ${timeoutSecs}s (${attempt} attempts)`,
  );
}

function hardenSonataFlowPlatform(namespace: string): void {
  try {
    const sfpPatch = JSON.stringify({
      spec: {
        services: {
          dataIndex: {
            podTemplate: {
              container: {
                resources: {
                  requests: { memory: "64Mi", cpu: "250m" },
                  limits: { memory: "1Gi", cpu: "500m" },
                },
                livenessProbe: {
                  failureThreshold: 200,
                  httpGet: {
                    path: "/q/health/live",
                    port: 8080,
                    scheme: "HTTP",
                  },
                  periodSeconds: 10,
                  timeoutSeconds: 10,
                },
                readinessProbe: {
                  failureThreshold: 200,
                  httpGet: {
                    path: "/q/health/ready",
                    port: 8080,
                    scheme: "HTTP",
                  },
                  periodSeconds: 10,
                  timeoutSeconds: 10,
                },
              },
            },
          },
          jobService: {
            podTemplate: {
              container: {
                resources: {
                  requests: { memory: "64Mi", cpu: "250m" },
                  limits: { memory: "1Gi", cpu: "500m" },
                },
              },
            },
          },
        },
      },
    });
    runOc([
      "-n",
      namespace,
      "patch",
      "sonataflowplatform",
      "sonataflow-platform",
      "--type",
      "merge",
      "-p",
      sfpPatch,
    ]);
    runOc(
      [
        "rollout",
        "status",
        "deployment/sonataflow-platform-data-index-service",
        "-n",
        namespace,
        "--timeout=300s",
      ],
      310_000,
    );
    runOc(
      [
        "rollout",
        "status",
        "deployment/sonataflow-platform-jobs-service",
        "-n",
        namespace,
        "--timeout=300s",
      ],
      310_000,
    );
  } catch {
    /* SFP patch non-fatal */
  }
}

function alignWorkflowImages(namespace: string, oslMajorMinor: string): void {
  if (!oslMajorMinor || oslMajorMinor === "1.37") return;

  const oslTag = `osl_${oslMajorMinor.replace(".", "_")}`;
  const imageMap: Record<string, string> = {
    greeting: `quay.io/orchestrator/serverless-workflow-greeting:${oslTag}`,
    failswitch: `quay.io/orchestrator/fail-switch:${oslTag}`,
  };
  for (const wf of WORKFLOWS) {
    const image = imageMap[wf];
    if (!image) continue;
    try {
      const imgPatch = JSON.stringify({
        spec: { podTemplate: { container: { image } } },
      });
      runOc([
        "-n",
        namespace,
        "patch",
        "sonataflow",
        wf,
        "--type",
        "merge",
        "-p",
        imgPatch,
      ]);
    } catch {
      /* ignore per-workflow patch failure */
    }
  }
}

export function runOc(args: string[], timeoutMs = 30_000): string {
  return execFileSync("oc", args, {
    encoding: "utf-8",
    timeout: timeoutMs,
  }).trim();
}

/**
 * Best-effort diagnostics bundle for CI when `rhdh.deploy()` fails waiting for RHDH.
 * Keep this intentionally stderr-heavy: it should only run on failure paths.
 */
export function logOrchestratorDeployFailureDiagnostics(
  namespace: string,
): void {
  const banner = (title: string) => {
    // eslint-disable-next-line no-console -- diagnostics for CI triage
    console.error(`\n===== [orchestrator-e2e diagnostics] ${title} =====\n`);
  };

  const safeOc = (args: string[], timeoutMs = 120_000): string | undefined => {
    try {
      return runOc(args, timeoutMs);
    } catch (err) {
      // eslint-disable-next-line no-console -- diagnostics for CI triage
      console.error(
        `[orchestrator-e2e diagnostics] oc ${args.join(" ")} failed:`,
      );
      // eslint-disable-next-line no-console -- diagnostics for CI triage
      console.error(err);
      return undefined;
    }
  };

  banner(`namespace=${namespace}`);

  const hubPod = safeOc([
    "get",
    "pods",
    "-n",
    namespace,
    "-l",
    "app.kubernetes.io/instance=redhat-developer-hub",
    "-o",
    "jsonpath={.items[0].metadata.name}",
  ]);

  if (hubPod) {
    banner(`redhat-developer-hub pod describe (${hubPod})`);
    safeOc(["describe", "pod", "-n", namespace, hubPod], 120_000);

    banner(`redhat-developer-hub pod logs (${hubPod}) --all-containers`);
    safeOc(
      ["logs", "-n", namespace, hubPod, "--all-containers", "--tail=400"],
      180_000,
    );

    banner(
      `redhat-developer-hub previous pod logs (${hubPod}) --all-containers`,
    );
    safeOc(
      [
        "logs",
        "-n",
        namespace,
        hubPod,
        "--all-containers",
        "--previous",
        "--tail=400",
      ],
      180_000,
    );
  } else {
    banner("redhat-developer-hub pod not found via label selector");
    safeOc(["get", "pods", "-n", namespace, "-o", "wide"], 120_000);
  }

  banner("sonataflow platform pods (wide)");
  safeOc(
    [
      "get",
      "pods",
      "-n",
      namespace,
      "-l",
      "app.kubernetes.io/name=logic-operator",
      "-o",
      "wide",
    ],
    120_000,
  );
  safeOc(
    [
      "get",
      "pods",
      "-n",
      namespace,
      "-l",
      "app.kubernetes.io/component=sonataflow-platform",
      "-o",
      "wide",
    ],
    120_000,
  );

  banner("sonataflow workflow pods (failswitch/greeting)");
  safeOc(
    [
      "get",
      "pods",
      "-n",
      namespace,
      "-l",
      "sonataflow.org/workflowName=failswitch",
      "-o",
      "wide",
    ],
    120_000,
  );
  safeOc(
    [
      "get",
      "pods",
      "-n",
      namespace,
      "-l",
      "sonataflow.org/workflowName=greeting",
      "-o",
      "wide",
    ],
    120_000,
  );

  banner("recent namespace warnings/errors (last 200 events)");
  safeOc(
    ["get", "events", "-n", namespace, "--sort-by=.lastTimestamp"],
    120_000,
  );
}

function detectOperatorVersion(...labels: string[]): string {
  for (const label of labels) {
    try {
      const version = runOc([
        "get",
        "csv",
        "-n",
        "openshift-operators",
        "-o",
        "jsonpath={.items[0].spec.version}",
        "-l",
        label,
      ]);
      if (version) return version;
    } catch {
      /* try next candidate */
    }
  }
  return "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
