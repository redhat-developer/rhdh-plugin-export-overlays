import { expect, Page } from "@red-hat-developer-hub/e2e-test-utils/test";
import { waitForMuiProgressHidden } from "../utils/wait";

/**
 * Catalog "Import an existing Git repository" without CatalogImportPage.analyzeAndWait
 * (that helper ties success to Analyze disappearing, which flakes).
 */
export class CatalogImportPO {
  constructor(private readonly page: Page) {}

  async registerFromComponentUrl(url: string): Promise<void> {
    await this.page.locator('input[name="url"]').fill(url);
    await this.page.getByRole("button", { name: "Analyze" }).click();
    await waitForMuiProgressHidden(this.page);

    const importButton = this.page.getByRole("button", {
      name: "Import",
      exact: true,
    });
    const refreshButton = this.page.getByRole("button", {
      name: "Refresh",
      exact: true,
    });

    await expect(importButton.or(refreshButton)).toBeVisible({
      timeout: 60_000,
    });

    if (await refreshButton.isVisible()) {
      return;
    }

    await expect(importButton).toBeEnabled({ timeout: 30_000 });
    await importButton.click();
    await waitForMuiProgressHidden(this.page);
  }
}
