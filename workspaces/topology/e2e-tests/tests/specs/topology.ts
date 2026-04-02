import { expect, Locator, Page } from "@playwright/test";
import { UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import fs from "fs";

async function downloadAndReadFile(
  page: Page,
  locator: Locator,
): Promise<string | undefined> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    locator.click(),
  ]);

  const filePath = await download.path();

  if (filePath) {
    return fs.readFileSync(filePath, "utf-8");
  } else {
    console.error("Download failed or path is not available");
    return undefined;
  }
}

export class Topology {
  private page: Page;
  private uiHelper: UIhelper;

  constructor(page: Page) {
    this.page = page;
    this.uiHelper = new UIhelper(page);
  }

  async hoverOnPodStatusIndicator() {
    const locator = this.page
      .locator('[data-test-id="topology-test"]')
      .getByText("1Pod")
      .first();
    await locator.hover();
    await this.page.waitForTimeout(1000);
  }

  async verifyMissingTopologyPermission() {
    await this.uiHelper.verifyHeading("Missing Permission");
    await this.uiHelper.verifyText("kubernetes.clusters.read");
    await this.uiHelper.verifyText("kubernetes.resources.read");
    await expect(this.page.getByLabel("Pod")).toBeHidden();
  }

  async verifyDeployment(name: string) {
    await this.uiHelper.verifyText(name);
    const deployment = this.page
      .locator(`[data-test-id="${name}"] image`)
      .first();
    await expect(deployment).toBeVisible();
    await deployment.click();
    await this.page.getByLabel("Pod").click();
    await this.page.getByLabel("Pod").getByText("1", { exact: true }).click();
  }

  async verifyPodLogs(allowed: boolean) {
    await this.uiHelper.clickTab("Resources");
    await this.page
      .locator('button:has(span:text("View Logs"))')
      .first()
      .click();

    if (allowed) {
      const downloadLogsButton = this.page.getByRole("button", {
        name: "download logs",
      });
      const fileContent = await downloadAndReadFile(
        this.page,
        downloadLogsButton,
      );
      expect(fileContent).not.toBeUndefined();
      expect(fileContent).not.toBe("");
    } else {
      await this.uiHelper.verifyHeading("Missing Permission");
      await this.uiHelper.verifyText("kubernetes.proxy");
    }
  }
}
