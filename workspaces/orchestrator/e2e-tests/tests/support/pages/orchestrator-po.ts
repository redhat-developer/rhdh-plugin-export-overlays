import { expect, Page } from "@red-hat-developer-hub/e2e-test-utils/test";
import { UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { ORCHESTRATOR_COMPONENTS } from "./orchestrator-obj.js";

export class OrchestratorPO {
  constructor(
    private readonly page: Page,
    private readonly uiHelper: UIhelper,
  ) {}

  async openWorkflowsPage(): Promise<void> {
    await this.uiHelper.goToPageUrl("/orchestrator");
    await this.uiHelper.verifyHeading("Workflows");
  }

  async openOrchestratorFromSidebar(): Promise<void> {
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

  async verifyWorkflowHidden(name: string | RegExp): Promise<void> {
    await expect(
      ORCHESTRATOR_COMPONENTS.workflowLink(this.page, name),
    ).toHaveCount(0);
  }

  async verifyRunButtonState(
    state: "enabled" | "disabled" | "absent",
  ): Promise<void> {
    const runButton = ORCHESTRATOR_COMPONENTS.runButton(this.page);
    if (state === "absent") {
      await expect(runButton).toHaveCount(0);
      return;
    }
    await expect(runButton).toBeVisible();
    if (state === "enabled") {
      await expect(runButton).toBeEnabled();
      return;
    }
    await expect(runButton).toBeDisabled();
  }

  async openGreetingTemplateFromCatalog(
    catalogHeading: string | RegExp = /Catalog|All/,
  ): Promise<void> {
    await this.uiHelper.openSidebar("Catalog");
    await this.uiHelper.verifyHeading(catalogHeading);
    await this.uiHelper.selectMuiBox("Kind", "Template");
    const templateLink = ORCHESTRATOR_COMPONENTS.templateLink(
      this.page,
      /Greeting Test Picker/i,
    );
    await expect(templateLink).toBeVisible({ timeout: 30_000 });
    await templateLink.click();
    await this.page.waitForLoadState("domcontentloaded");
  }
  async openGreetingTemplateFromSelfService(): Promise<void> {
    await this.uiHelper.clickLink({ ariaLabel: "Self-service" });
    await this.uiHelper.verifyHeading("Self-service");
    await this.page.waitForLoadState("domcontentloaded");
    await this.uiHelper.clickBtnInCard("Greeting Test Picker", "Choose");
    await this.page.waitForURL(/\/create\/templates\//, { timeout: 30_000 });
    await this.page.waitForLoadState("domcontentloaded");
    await this.uiHelper.verifyHeading(/Greeting Test Picker/i, 30_000);
  }
}
