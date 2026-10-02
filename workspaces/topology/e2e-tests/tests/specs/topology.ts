import { expect, Locator, Page } from "@playwright/test";
import { UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import fs from "fs";

const BACKSTAGE_JANUS_COMPONENT = "backstage-janus";
const BACKSTAGE_JANUS_PATH = `/catalog/default/component/${BACKSTAGE_JANUS_COMPONENT}`;

/**
 * Locator for the Topology entity tab inside the "Deployment" dropdown.
 * The NFS entity page groups tabs by default — topology falls under the
 * "Deployment" content group (see page:catalog/entity default groups).
 */
export function topologyEntityTab(page: Page) {
  return page.getByRole("menuitemradio", { name: "Topology" });
}

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

  /**
   * Opens the entity page and asserts the Topology tab is hidden when the user
   * lacks kubernetes.clusters.read / kubernetes.resources.read (NFS permission gate).
   */
  async verifyMissingTopologyTab() {
    await this.page.goto(BACKSTAGE_JANUS_PATH);
    await expect(
      this.page.getByRole("heading", { name: BACKSTAGE_JANUS_COMPONENT }),
    ).toBeVisible({ timeout: 30_000 });
    await this.uiHelper.clickButtonByLabel("Deployment");
    await expect(topologyEntityTab(this.page)).toBeHidden();
  }

  /**
   * Navigates to the entity page and selects the Topology view from the
   * "Deployment" dropdown.
   */
  async navigateToTopologyView() {
    await this.page.goto(BACKSTAGE_JANUS_PATH);
    await expect(
      this.page.getByRole("heading", { name: BACKSTAGE_JANUS_COMPONENT }),
    ).toBeVisible({ timeout: 30_000 });
    await this.uiHelper.clickButtonByLabel("Deployment");
    await expect(topologyEntityTab(this.page)).toBeVisible();
    await topologyEntityTab(this.page).click();
    await this.uiHelper.verifyHeading(BACKSTAGE_JANUS_COMPONENT);
  }

  async verifyDeployment(name: string) {
    await this.uiHelper.verifyText(name);
    const deployment = this.page
      .locator(`[data-test-id="${name}"] image`)
      .first();
    await expect(deployment).toBeVisible();
    await deployment.click({ force: true });
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
        name: "download",
      });
      const fileContent = await downloadAndReadFile(
        this.page,
        downloadLogsButton,
      );
      expect(fileContent).not.toBeUndefined();
      expect(fileContent).not.toBe("");
    } else {
      await this.uiHelper.verifyText("Missing Permission");
      await this.uiHelper.verifyText("kubernetes.proxy");
    }
  }
}
