import {
  expect,
  Locator,
  Page,
} from "@red-hat-developer-hub/e2e-test-utils/test";
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

  async openTemplateFromCatalogByName(
    templateName: string | RegExp,
    catalogHeading: string | RegExp = /Catalog|All/,
  ): Promise<void> {
    await this.uiHelper.openSidebar("Catalog");
    await this.uiHelper.verifyHeading(catalogHeading);
    await this.uiHelper.selectMuiBox("Kind", "Template");
    const templateLink = ORCHESTRATOR_COMPONENTS.templateLink(
      this.page,
      templateName,
    );
    await expect(templateLink).toBeVisible({ timeout: 30_000 });
    await templateLink.click();
    await this.page.waitForLoadState("domcontentloaded");
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
    const workflowsTab = ORCHESTRATOR_COMPONENTS.workflowsTab(this.page);
    const count = await workflowsTab.count();
    if (count === 0) {
      return false;
    }
    await workflowsTab.click();
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
}
