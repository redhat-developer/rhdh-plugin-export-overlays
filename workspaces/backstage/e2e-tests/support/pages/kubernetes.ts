import { Page, expect } from "@playwright/test";
import { UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { KUBERNETES_COMPONENTS } from "./kubernetes-po";

export class KubernetesPage {
  private page: Page;
  private uiHelper: UIhelper;

  constructor(page: Page) {
    this.page = page;
    this.uiHelper = new UIhelper(page);
  }

  async navigateToTabForComponent(componentName: string) {
    await this.uiHelper.openCatalogSidebar("Component");
    await this.uiHelper.clickLink(componentName);
    await this.uiHelper.clickTab("Kubernetes");
  }

  async verifyDeployment(text: string) {
    const deploymentCard = this.page
      .getByRole("button")
      .filter({ hasText: `${text}Deploymentnamespace: backstage-kubernetes` })
      .first();
    await deploymentCard.scrollIntoViewIfNeeded();
    await expect(deploymentCard).toBeVisible();

    await expect(deploymentCard).toContainText(/1 pods?/i);
    await expect(deploymentCard).toContainText(/no pods with errors/i);
    await expect(
      deploymentCard.locator(KUBERNETES_COMPONENTS.statusOk).first(),
    ).toBeVisible();
    await deploymentCard.click();
    await expect(
      this.page.locator(
        `table ${KUBERNETES_COMPONENTS.statusOk}:has-text("OK")`,
      ),
    ).toBeVisible();
  }

  async verifyPodLogs(text: string, heading: string, allowed?: boolean) {
    await this.verifyDeployment(text);
    const podNameButton = this.page
      .locator("table tbody")
      .getByRole("button", { name: text });
    await podNameButton.scrollIntoViewIfNeeded();
    await podNameButton.click();

    const podLogs = this.page.locator(KUBERNETES_COMPONENTS.podLogs).first();
    await podLogs.scrollIntoViewIfNeeded();
    await podLogs.click();

    await this.uiHelper.verifyHeading(heading);

    if (allowed) {
      await expect(
        this.page.getByRole("textbox", { name: /search/i }),
      ).toBeVisible();
    } else {
      await this.page
        .locator(KUBERNETES_COMPONENTS.MuiSnackbarContent)
        .waitFor({ state: "visible" });
      expect(
        await this.page
          .locator(KUBERNETES_COMPONENTS.MuiSnackbarContent)
          .textContent(),
      ).toContain("NotAllowedError");
    }
  }
}
