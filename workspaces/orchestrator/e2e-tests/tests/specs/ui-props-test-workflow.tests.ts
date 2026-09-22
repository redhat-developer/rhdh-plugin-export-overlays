import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import { createDataIndexGuard } from "../support/utils/orchestrator-workflow-helpers.js";
import { loginAsKeycloakUserWithRetry } from "./orchestrator-rbac.tests.js";
import {
  PRIMARY_USER,
  setupAuthenticatedPage,
  createRoleWithPolicies,
  deleteRoleAndPolicies,
  globalWorkflowPolicies,
  type PolicySpec,
  waitForLokiWorkflowLogs,
} from "../support/utils/test-helpers.js";
import { OrchestratorPO } from "../support/pages/orchestrator-po.js";

const ensureDataIndexOrSkip = createDataIndexGuard();

const UI_PROPS_RBAC_ROLE = "role:default/uiPropsWorkflowTest";

function uiPropsRbacPolicies(): PolicySpec[] {
  return [
    ...globalWorkflowPolicies("allow", "allow"),
    {
      permission: "orchestrator.workflowAdminView",
      policy: "read",
      effect: "allow",
    },
  ];
}

export function registerUiPropsTestWorkflowTests(): void {
  test.describe("Test Object Type Support in ui:props (orchestrator workflow)", () => {
    let apiToken: string;

    test.beforeAll(async ({ browser }, testInfo) => {
      ({ apiToken } = await setupAuthenticatedPage(browser, testInfo));
      await deleteRoleAndPolicies(apiToken, UI_PROPS_RBAC_ROLE);
      await createRoleWithPolicies(
        apiToken,
        UI_PROPS_RBAC_ROLE,
        [PRIMARY_USER],
        uiPropsRbacPolicies(),
      );
    });

    test.beforeEach(async ({ page, loginHelper }, testInfo) => {
      test.setTimeout(240_000);
      await loginAsKeycloakUserWithRetry(
        page,
        loginHelper,
        "test1",
        "test1@123",
      );
      await ensureDataIndexOrSkip(testInfo.project.name, test);
    });

    test.afterAll(async () => {
      await deleteRoleAndPolicies(apiToken, UI_PROPS_RBAC_ROLE);
    });

    test("ui:props test workflow", async ({ page, uiHelper }) => {
      test.setTimeout(300_000);
      const orchestratorPo = new OrchestratorPO(page, uiHelper);
      await uiHelper.openSidebar("Orchestrator");
      await expect(
        page.getByRole("cell", { name: "Test Object Type Support" }),
      ).toBeVisible();
      await page
        .getByRole("link", { name: /Test Object Type Support in ui:props/i })
        .click();
      const runButton = page
        .getByRole("button", { name: "Run", exact: true })
        .first();
      await expect(runButton).toBeEnabled();
      await runButton.click();
      await page.getByRole("textbox", { name: "Name" }).fill("test-name");
      await page.getByRole("textbox", { name: "Email" }).click();
      await page.getByRole("textbox", { name: "Email" }).fill("test@test.com");
      await page.getByRole("button", { name: "Next" }).click();
      await page
        .getByRole("textbox", { name: "Simple Text Field" })
        .fill("sample testing");
      await page.getByRole("textbox", { name: "Object Type Example" }).click();
      await page
        .getByRole("textbox", { name: "Object Type Example" })
        .fill('{"kind":"demo","id":42,"tags":["a","b"]}');
      await page.getByRole("button", { name: "Next" }).click();
      await expect(page.getByText("Run workflow")).toBeVisible();
      await page.getByRole("button", { name: "Run" }).click();
      await expect(page.getByText("Run status Completed")).toBeVisible();
      await expect(page.getByText("ResultsRun completed")).toBeVisible();
      await expect(page.getByText("WorkflowTest object type")).toBeVisible();
      await expect(page.getByText("Workflow Status Available")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Run ID" })).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Duration" }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Started" }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Description" }),
      ).toBeVisible();
      const runId = await orchestratorPo.getCurrentRunId();
      await waitForLokiWorkflowLogs(runId);
      const logsDialog = await orchestratorPo.openRunLogsDialog();
      await expect(
        logsDialog.getByText(/No logs available for this workflow run/i),
      ).toBeHidden();
      await expect(
        logsDialog.getByRole("button", { name: "Copy" }),
      ).toBeVisible();
      await logsDialog
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await expect(logsDialog).toBeHidden();
      await page.getByRole("link", { name: "View variables" }).click();
      await expect(
        page.getByText('{ "name": "test-name", "email'),
      ).toBeVisible();
      await expect(page.getByText('{ "simpleText": "sample')).toBeVisible();
      await expect(
        page.getByRole("dialog", { name: "Run Variables close" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Close", exact: true }).click();
    });
  });
}
