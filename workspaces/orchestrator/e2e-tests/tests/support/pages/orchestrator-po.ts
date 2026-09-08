import {
  expect,
  Locator,
  Page,
} from "@red-hat-developer-hub/e2e-test-utils/test";
import { UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { ORCHESTRATOR_COMPONENTS } from "./orchestrator-obj.js";

const workflowsTable = (page: Page) =>
  page.locator("#root div").filter({ hasText: "Workflows" }).nth(2);

export class OrchestratorPO {
  constructor(
    private readonly page: Page,
    private readonly uiHelper: UIhelper,
  ) {}

  private workflowsCatalogControl(): Locator {
    // NFS entity header looks like tabs but the control is often a link.
    return ORCHESTRATOR_COMPONENTS.workflowsTab(this.page).or(
      ORCHESTRATOR_COMPONENTS.workflowsLink(this.page),
    );
  }

  async clickWorkflowsCatalogControl(): Promise<void> {
    await this.workflowsCatalogControl().click({ timeout: 30_000 });
    await this.page.waitForLoadState("domcontentloaded");
  }

  async verifyWorkflowsCatalogControlVisible(): Promise<void> {
    await expect(this.workflowsCatalogControl()).toBeVisible({
      timeout: 30_000,
    });
  }

  async openWorkflowsPage(): Promise<void> {
    await this.page.goto("/orchestrator");
    await expect(this.page).toHaveURL("/orchestrator");
    await expect(
      ORCHESTRATOR_COMPONENTS.workflowsHeading(this.page),
    ).toBeVisible({ timeout: 120_000 });
    await expect(this.page.getByRole("tablist", { name: "tabs" })).toBeVisible({
      timeout: 30_000,
    });
  }

  async openOrchestratorFromSidebar(): Promise<void> {
    const adminButton = this.page
      .getByRole("button", { name: "Administration" })
      .first();
    const orchestratorLink = this.page
      .locator('nav a:has-text("Orchestrator")')
      .first();
    if (!(await orchestratorLink.isVisible().catch(() => false))) {
      await adminButton.waitFor({ state: "visible", timeout: 120_000 });
      await adminButton.click();
    }
    await this.uiHelper.openSidebar("Orchestrator");
    await expect(
      ORCHESTRATOR_COMPONENTS.workflowsHeading(this.page),
    ).toBeVisible();
  }

  async openWorkflow(name: string | RegExp): Promise<void> {
    const workflow = ORCHESTRATOR_COMPONENTS.workflowLink(this.page, name);
    await expect(workflow).toBeVisible({ timeout: 30_000 });
    await workflow.click();
  }

  async openWorkflowFromSidebar(name: string | RegExp): Promise<void> {
    await this.openOrchestratorFromSidebar();
    await this.openWorkflow(name);
  }

  async openGreetingWorkflowFromSidebar(): Promise<void> {
    await this.openWorkflowFromSidebar(/Greeting workflow/i);
  }

  async openFailswitchWorkflowFromSidebar(): Promise<void> {
    await this.openWorkflowFromSidebar(/Failswitch workflow/i);
  }

  async verifyWorkflowHidden(name: string | RegExp): Promise<void> {
    await expect(
      ORCHESTRATOR_COMPONENTS.workflowLink(this.page, name),
    ).toHaveCount(0);
  }

  async verifyRunButtonState(
    state: "enabled" | "disabled" | "absent" | "disabled-or-absent",
  ): Promise<void> {
    const runButton = ORCHESTRATOR_COMPONENTS.runButton(this.page);
    if (state === "absent") {
      await expect(runButton).toHaveCount(0);
      return;
    }
    if (state === "disabled-or-absent") {
      const count = await runButton.count();
      if (count === 0) {
        await expect(runButton).toHaveCount(0);
        return;
      }
      await expect(runButton).toBeVisible();
      await expect(runButton).toBeDisabled();
      return;
    }
    await expect(runButton).toBeVisible();
    if (state === "enabled") {
      await expect(runButton).toBeEnabled();
      return;
    }
    await expect(runButton).toBeDisabled();
  }

  async runWorkflowInDetailsPage(): Promise<void> {
    const runButton = ORCHESTRATOR_COMPONENTS.runButton(this.page);
    await expect(runButton).toBeVisible();
    await runButton.click();
  }

  async openLockFlowWorkflowFromSidebar(): Promise<void> {
    // SonataFlow CR is lock-flow; Data Index / UI catalog name is callback-flow.
    await this.openWorkflowFromSidebar(/callback-flow|lock-flow/i);
  }

  /**
   * On the execute/review page, click Run as Event (not the HTTP Run submit).
   * Event-only workflows reject plain Run with "no start node that matches the trigger none".
   */
  async clickRunAsEvent(): Promise<void> {
    const runAsEvent = ORCHESTRATOR_COMPONENTS.runAsEventButton(this.page);
    await expect(runAsEvent).toBeVisible({ timeout: 30_000 });
    await expect(runAsEvent).toBeEnabled();
    await runAsEvent.click();
  }

  /**
   * After Run as Event: wait for a live run status only.
   * The pre-run alert only proves RHDH accepted the request; Access Denied is an
   * RBAC failure (this suite grants instanceAdminView) and must not pass.
   */
  async verifyEventTriggeredOrRunVisible(timeoutMs = 300_000): Promise<void> {
    // Prefer .first(): diagram nodes also render exact "Completed"/"Running" text,
    // so a bare getByText union hits Playwright strict mode once the run is live.
    const completed = ORCHESTRATOR_COMPONENTS.completedStatus(
      this.page,
    ).first();
    const running = ORCHESTRATOR_COMPONENTS.runningStatus(this.page).first();
    await expect(completed.or(running).first()).toBeVisible({
      timeout: timeoutMs,
    });
  }

  async runLockFlowAsEvent(): Promise<void> {
    await this.openLockFlowWorkflowFromSidebar();
    await this.runWorkflowInDetailsPage();
    await this.clickRunAsEvent();
    // Keep assertion budget under the 600s test timeout so failures surface as
    // locator errors instead of generic "Test timeout exceeded".
    await this.verifyEventTriggeredOrRunVisible(300_000);
  }

  async runGreetingWorkflow(
    language = "English",
    status = "Completed",
  ): Promise<void> {
    const runButton = this.page.getByRole("button", {
      name: "Run",
      exact: true,
    });
    await expect(runButton).toBeVisible();
    await runButton.click();
    await this.page.getByLabel("Language").click();
    await this.page.getByRole("option", { name: language }).click();
    await this.page.getByRole("button", { name: "Next" }).click();
    await this.page.getByRole("button", { name: "Run" }).click();
    await expect(
      this.page.getByText(`${status}`, { exact: true }).first(),
    ).toBeVisible({ timeout: 600_000 });
  }

  async reRunGreetingWorkflow(
    language = "English",
    status = "Completed",
  ): Promise<void> {
    await expect(this.page.getByText("Run again")).toBeVisible();
    await this.page.getByText("Run again").click();
    await this.page.getByLabel("Language").click();
    await this.page.getByRole("option", { name: language }).click();
    await this.page.getByRole("button", { name: "Next" }).click();
    await this.page.getByRole("button", { name: "Run" }).click();
    await expect(
      this.page.getByText(`${status}`, { exact: true }).first(),
    ).toBeVisible({ timeout: 600_000 });
  }

  async runFailSwitchWorkflow(input = "OK"): Promise<void> {
    const runButton = this.page.getByRole("button", {
      name: "Run",
      exact: true,
    });
    await expect(runButton).toBeVisible();
    await runButton.click();
    await this.page.getByLabel(/switch/i).click();
    await this.page.getByRole("option", { name: input }).click();
    await this.page.getByRole("button", { name: "Next" }).click();
    await this.page.getByRole("button", { name: "Run" }).click();
    switch (input) {
      case "OK":
        await this.validateCurrentWorkflowStatus("Completed");
        break;
      case "KO":
        await this.validateCurrentWorkflowStatus("Failed");
        break;
      case "Wait":
        await this.validateCurrentWorkflowStatus("Running");
        break;
    }
  }

  async validateCurrentWorkflowStatus(
    status = "Completed",
    timeout = 120_000,
  ): Promise<void> {
    await expect(
      this.page.getByText(`${status}`, { exact: true }).first(),
    ).toBeVisible({ timeout });
  }

  async validateWorkflowAllRuns(): Promise<void> {
    await this.page.getByRole("tab", { name: "all runs" }).click();
    await expect(
      this.page
        .locator("tbody")
        .getByRole("row")
        .nth(0)
        .getByRole("cell")
        .nth(0),
    ).toBeVisible();
    await expect(this.page.getByTestId("select").first()).toHaveAttribute(
      "aria-label",
      "Status",
    );
    await this.page
      .getByLabel("Status")
      .getByRole("button", { name: "All" })
      .click();
    const statuses = ["All", "Running", "Failed", "Completed", "Aborted"];
    for (const status of statuses) {
      await expect(this.page.getByRole("option", { name: status })).toHaveText(
        status,
      );
      await this.page.getByRole("option", { name: status }).click();
      await this.page
        .getByLabel("Status")
        .getByRole("button", { name: status })
        .click();
    }
    await this.page.getByRole("option", { name: "All" }).click();
    const columnHeaders = [
      "ID",
      "Workflow name",
      "Version",
      "Entity",
      "Status",
      "Started",
      "Run by",
    ];
    for (const columnHeader of columnHeaders) {
      await expect(
        this.page.getByRole("columnheader", {
          name: columnHeader,
          exact: true,
        }),
      ).toBeVisible();
    }
  }

  async validateWorkflowStatusDetails(status = "Completed"): Promise<void> {
    const details = this.page.getByRole("article").filter({
      has: this.page.getByRole("heading", { name: "Workflow" }),
    });
    if (status === "Running") {
      await expect(
        details.getByRole("heading", { name: /Run\s*status/i }),
      ).toBeVisible();
      await expect(
        this.page
          .locator("b")
          .filter({ hasText: "Running" })
          .getByRole("progressbar"),
      ).toBeVisible();
      const workflowButtons = this.page
        .locator("div")
        .filter({ hasText: "Abort Running..." })
        .nth(4);
      await expect(workflowButtons).toHaveText(/Running/i);
      await expect(workflowButtons.getByRole("progressbar")).toBeVisible();
      await expect(this.page.getByTestId("InfoOutlinedIcon")).toBeVisible();
      await expect(
        this.page.getByText(
          /workflow is running\.?\s*Started at\s+\d{1,2}\/\d{1,2}\/\d{4},\s+\d{1,2}:\d{2}:\d{2}\s+(AM|PM)/i,
        ),
      ).toBeVisible();
    }
    if (status === "Failed") {
      await expect(
        details.getByTestId("ErrorOutlineOutlinedIcon"),
      ).toBeVisible();
      await expect(
        this.page.getByText(
          /Run has failed at\s+\d{1,2}\/\d{1,2}\/\d{4},\s+\d{1,2}:\d{2}:\d{2}\s+(AM|PM)/,
        ),
      ).toBeVisible();
      await expect(
        this.page.getByTestId("ErrorOutlineOutlinedIcon"),
      ).toBeVisible();
    }
    if (status === "Completed") {
      await expect(
        this.page
          .locator("b")
          .filter({ hasText: "Completed" })
          .getByTestId("CheckCircleOutlinedIcon"),
      ).toBeVisible();
      await expect(
        this.page.getByText(
          /Run completed at\s+\d{1,2}\/\d{1,2}\/\d{4},\s+\d{1,2}:\d{2}:\d{2}\s+(AM|PM)/,
        ),
      ).toBeVisible();
      await expect(this.page.getByTestId("SuccessOutlinedIcon")).toBeVisible();
    }
  }

  async abortWorkflow(): Promise<void> {
    await expect(
      this.page.getByRole("button", { name: "Abort" }),
    ).toBeEnabled();
    await this.page.getByRole("button", { name: "Abort" }).click();
    await this.page
      .getByRole("dialog", { name: /Abort workflow run\?/i })
      .getByRole("button", { name: "Abort" })
      .click();
    await expect(this.page.getByText("Run was aborted")).toBeVisible();
    await expect(this.page.getByText("-- Aborted")).toBeVisible();
  }

  async runGreetingWorkflowAndCaptureInstanceId(): Promise<string> {
    await this.runWorkflowInDetailsPage();
    await expect(ORCHESTRATOR_COMPONENTS.nextButton(this.page)).toBeVisible();
    await ORCHESTRATOR_COMPONENTS.nextButton(this.page).click();
    await this.runWorkflowInDetailsPage();
    await this.page.waitForURL(/\/orchestrator\/instances\/[a-f0-9-]+/);
    const match = this.page
      .url()
      .match(/\/orchestrator\/instances\/([a-f0-9-]+)/);
    if (!match) {
      throw new Error("Workflow instance id not found in URL");
    }
    return match[1];
  }

  async openGreetingTemplateFromCatalog(
    catalogHeading: string | RegExp = /Catalog|All/,
  ): Promise<void> {
    await this.openCatalogTemplates(catalogHeading);
    const templateLink = ORCHESTRATOR_COMPONENTS.templateLink(
      this.page,
      /Greeting Test Picker/i,
    );
    await expect(templateLink).toBeVisible({ timeout: 30_000 });
    await templateLink.click();
    await this.page.waitForLoadState("domcontentloaded");
  }
  private async clickChooseOnTemplateCard(
    templateTitle: string,
  ): Promise<void> {
    // Match hashed MUI classes (css-*-MuiCard-root); exact .MuiCard-root misses them.
    const chooseButton = this.page
      .locator('[class*="MuiCard-root"]')
      .filter({ hasText: templateTitle })
      .getByRole("button", { name: /Choose/i })
      .first();
    await expect(chooseButton).toBeVisible({ timeout: 30_000 });
    await chooseButton.click();
  }

  async openGreetingTemplateFromSelfService(): Promise<void> {
    await this.page.goto("/create");
    await this.page.waitForLoadState("domcontentloaded");
    await expect(
      this.page.getByRole("heading", { name: /Self-service|Create/i }).first(),
    ).toBeVisible({ timeout: 30_000 });
    // clickBtnInCard can detach under NFS re-renders; click Choose directly.
    await this.clickChooseOnTemplateCard("Greeting Test Picker");
    await this.page.waitForURL(/\/create\/templates\//, { timeout: 30_000 });
    await this.page.waitForLoadState("domcontentloaded");
    await this.uiHelper.verifyHeading(/Greeting Test Picker/i, 30_000);
  }

  async openTemplateFromCatalogByName(
    templateName: string | RegExp,
    catalogHeading: string | RegExp = /Catalog|All/,
  ): Promise<void> {
    await this.openCatalogTemplates(catalogHeading);
    const templateLink = ORCHESTRATOR_COMPONENTS.templateLink(
      this.page,
      templateName,
    );
    await expect(templateLink).toBeVisible({ timeout: 30_000 });
    await templateLink.click();
    await this.page.waitForLoadState("domcontentloaded");
  }

  private async openCatalogTemplates(
    catalogHeading: string | RegExp,
  ): Promise<void> {
    await this.page.goto("/catalog");
    await this.page.waitForLoadState("domcontentloaded");
    await this.uiHelper.verifyHeading(catalogHeading);
    await this.uiHelper.selectMuiBox("Kind", "Template");
  }

  async fillGreetingTemplateFormAndSubmit(options?: {
    uniqueName?: string;
    selectLanguage?: boolean;
    submitCreate?: boolean;
  }): Promise<string> {
    const uniqueName = options?.uniqueName || `test-entity-${Date.now()}`;
    const selectLanguage = options?.selectLanguage ?? true;
    const submitCreate = options?.submitCreate ?? true;

    if (selectLanguage) {
      const languageField = ORCHESTRATOR_COMPONENTS.languageField(this.page);
      if (await languageField.isVisible({ timeout: 5_000 })) {
        await languageField.click();
        await this.page.getByRole("option", { name: "English" }).click();
      }
    }

    const nameField = ORCHESTRATOR_COMPONENTS.nameField(this.page);
    await expect(nameField).toBeVisible({ timeout: 10_000 });
    await nameField.fill(uniqueName);

    const reviewButton = ORCHESTRATOR_COMPONENTS.reviewButton(this.page);
    await expect(reviewButton).toBeVisible({ timeout: 10_000 });
    await reviewButton.click();
    await this.page.waitForLoadState("domcontentloaded");

    const createButton = ORCHESTRATOR_COMPONENTS.createButton(this.page);
    if (submitCreate) {
      await expect(createButton).toBeVisible({ timeout: 10_000 });
      await createButton.click();
    }
    return uniqueName;
  }

  async waitForTemplateRunCompletionArtifacts(
    timeoutMs = 120_000,
  ): Promise<void> {
    await expect(this.templateRunCompletionArtifacts()).toBeVisible({
      timeout: timeoutMs,
    });
  }

  templateRunCompletionArtifacts(): Locator {
    const viewInCatalog = ORCHESTRATOR_COMPONENTS.viewInCatalogLink(this.page);
    const openWorkflowRun = ORCHESTRATOR_COMPONENTS.openWorkflowRunLink(
      this.page,
    );
    const startOver = ORCHESTRATOR_COMPONENTS.startOverButton(this.page);
    return viewInCatalog.or(openWorkflowRun).or(startOver);
  }

  async openWorkflowsTabIfVisible(): Promise<boolean> {
    const workflowsControl = this.workflowsCatalogControl();
    const count = await workflowsControl.count();
    if (count === 0) {
      return false;
    }
    await workflowsControl.click();
    await this.page.waitForLoadState("domcontentloaded");
    return true;
  }

  async followEntityBreadcrumbIfVisible(entityName: string): Promise<boolean> {
    const breadcrumb = ORCHESTRATOR_COMPONENTS.breadcrumbNav(this.page);
    const breadcrumbCount = await breadcrumb.count();
    if (breadcrumbCount === 0) {
      return false;
    }

    const entityBreadcrumb = breadcrumb.getByText(entityName);
    const entityBreadcrumbCount = await entityBreadcrumb.count();
    if (entityBreadcrumbCount === 0) {
      return false;
    }

    await entityBreadcrumb.click();
    await this.page.waitForLoadState("load");
    return true;
  }

  async openWorkflowInstance(instanceId: string): Promise<void> {
    await this.uiHelper.goToPageUrl(`/orchestrator/instances/${instanceId}`);
  }

  async getCurrentRunId(): Promise<string> {
    const runIdCell = this.page
      .getByRole("heading", { name: "Run ID" })
      .locator("+ *");
    await expect(runIdCell).toBeVisible();
    const runId = (await runIdCell.innerText()).trim();
    expect(runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    return runId;
  }

  async openRunLogsDialog(name: string | RegExp): Promise<Locator> {
    await this.page.getByRole("button", { name: "View logs" }).click();
    const dialogName =
      name instanceof RegExp
        ? new RegExp(`${name.source}.*workflow logs`, name.flags)
        : `${name} workflow logs`;
    const logsDialog = this.page.getByRole("dialog", { name: dialogName });
    await expect(logsDialog).toBeVisible();
    return logsDialog;
  }

  async isWorkflowCompletedStatusVisible(timeoutMs = 3_000): Promise<boolean> {
    return ORCHESTRATOR_COMPONENTS.completedStatus(this.page)
      .isVisible({ timeout: timeoutMs })
      .catch(() => false);
  }

  async verifyWorkflowCompletedStatusVisible(timeoutMs: number): Promise<void> {
    await expect(
      ORCHESTRATOR_COMPONENTS.completedStatus(this.page).first(),
    ).toBeVisible({
      timeout: timeoutMs,
    });
  }

  async followSuggestedGreetingWorkflow(): Promise<void> {
    await expect(
      ORCHESTRATOR_COMPONENTS.suggestedNextWorkflowHeading(this.page),
    ).toBeVisible();
    const greetingLink = ORCHESTRATOR_COMPONENTS.suggestedGreetingLink(
      this.page,
    );
    await expect(greetingLink).toBeVisible();
    await greetingLink.click();

    await expect(
      ORCHESTRATOR_COMPONENTS.greetingWorkflowDialog(this.page),
    ).toBeVisible();
    const runWorkflowButton = ORCHESTRATOR_COMPONENTS.runWorkflowButton(
      this.page,
    );
    await expect(runWorkflowButton).toBeVisible();
    await runWorkflowButton.click();

    await expect(
      this.page.getByRole("heading", { name: "Greeting workflow" }),
    ).toBeVisible();
    await expect(ORCHESTRATOR_COMPONENTS.nextButton(this.page)).toBeVisible();
  }

  async validateGreetingWorkflow(): Promise<void> {
    await this.page.getByRole("tab", { name: "Workflows" }).click();
    const workflowHeader = ORCHESTRATOR_COMPONENTS.workflowsHeading(this.page);
    await expect(workflowHeader).toBeVisible();
    await expect(workflowHeader).toContainText("Workflows");
    await expect(workflowsTable(this.page)).toBeVisible();
    await expect(
      this.page.getByRole("textbox", { name: "Filter" }),
    ).toBeVisible();
    await expect(
      this.page.getByRole("columnheader", { name: "Name", exact: true }),
    ).toBeVisible();
    await expect(
      this.page.getByRole("columnheader", {
        name: "Workflow Status",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      this.page.getByRole("columnheader", {
        name: "Runs (last month)",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      this.page.getByRole("columnheader", {
        name: "Success ratio",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      this.page.getByRole("columnheader", { name: "Actions", exact: true }),
    ).toBeVisible();
    const workFlowRow = this.page.locator(`tr:has-text("Greeting workflow")`);
    await expect(workFlowRow.locator("td").nth(0)).toHaveText(
      "Greeting workflow",
    );
    await expect(workFlowRow.locator("td").nth(1)).toHaveText("Available");
    await expect(workFlowRow.locator("td").nth(2)).toHaveText(
      /^\d+\.\d+(\.\d+)?$/,
    );
    await expect(workFlowRow.locator("td").nth(3)).toHaveText(/^\d+$/);
    await expect(workFlowRow.locator("td").nth(4)).toHaveText(/^\d+%$/);
    await expect(
      workFlowRow.getByRole("button", { name: "Run", exact: true }).first(),
    ).toBeVisible();
    await expect(
      workFlowRow.getByRole("button", { name: "View runs" }).first(),
    ).toBeVisible();
    // await expect(
    //   workFlowRow
    //     .getByRole("button", { name: "View input schema" })
    //     .first(),
    // ).toBeVisible();
  }
}
