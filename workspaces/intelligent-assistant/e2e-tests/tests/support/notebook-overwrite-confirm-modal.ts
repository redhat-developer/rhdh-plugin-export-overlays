import { expect, type Locator, type Page } from "@playwright/test";

export class NotebookOverwriteConfirmModalPage {
  constructor(private readonly page: Page) {}

  dialog(): Locator {
    return this.page.getByRole("dialog").filter({
      has: this.page.getByRole("heading", {
        name: "Overwrite Files?",
        level: 2,
      }),
    });
  }

  async expectDialogVisible(timeout = 15_000): Promise<void> {
    await expect(this.dialog()).toBeVisible({ timeout });
    await expect(
      this.dialog().getByText(
        "The following files already exist in this notebook. Do you want to overwrite them with the new versions?",
        { exact: true },
      ),
    ).toBeVisible();
  }

  async expectListedOverwriteFile(fileName: string): Promise<void> {
    await expect(
      this.dialog().getByText(fileName, { exact: true }),
    ).toBeVisible();
  }

  async clickCancel(): Promise<void> {
    await this.dialog()
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
  }
}
