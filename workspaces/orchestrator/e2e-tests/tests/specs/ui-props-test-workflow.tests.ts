import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import { ensureBaselineRole } from "../support/utils/test-helpers.js";
import { createDataIndexGuard } from "../support/utils/orchestrator-workflow-helpers.js";
import { loginAsKeycloakUserWithRetry } from "./orchestrator-rbac.tests.js";

const ensureDataIndexOrSkip = createDataIndexGuard();

export function registerUiPropsTestWorkflowTests(): void {
  test.describe("Test Object Type Support in ui:props (orchestrator workflow)", () => {
    test.beforeAll(async ({ browser }, testInfo) => {
      // await restoreBaselineRole(browser, testInfo);
      await ensureBaselineRole(browser, testInfo);
    });

    test.beforeEach(async ({ page, loginHelper }, testInfo) => {
      test.setTimeout(240_000);
      // await loginHelper.loginAsKeycloakUser();
      await loginAsKeycloakUserWithRetry(page, loginHelper, "test1", "test1@123");
      await ensureDataIndexOrSkip(testInfo.project.name, test);
    });

    test("ui:props test workflow", async ({ page, uiHelper }) => {
      test.setTimeout(300_000);
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
