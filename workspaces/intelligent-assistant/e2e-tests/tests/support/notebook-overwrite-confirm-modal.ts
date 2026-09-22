import { expect, type Locator, type Page } from "@playwright/test";

export class NotebookOverwriteConfirmModalPage {
  constructor(private readonly page: Page) {}

  dialog(): Locator {
    return this.page.getByRole("dialog").filter({
      has: this.page.getByRole("heading", {
        name: "File already exists",
        level: 2,
      }),
    });
  }

  async expectDialogVisible(timeout = 15_000): Promise<void> {
    await expect(this.dialog()).toBeVisible({ timeout });
  }

  async expectListedOverwriteFile(fileName: string): Promise<void> {
    await expect(
      this.dialog().getByText(fileName, { exact: true }),
    ).toBeVisible();
  }

  async clickBack(): Promise<void> {
    await this.dialog()
      .getByRole("button", { name: "Back", exact: true })
      .click();
  }

  uploadButtonPattern(): RegExp {
    return /Upload \(\d+\)/;
  }

  async clickUpload(): Promise<void> {
    await this.dialog()
      .getByRole("button", { name: this.uploadButtonPattern() })
      .click();
  }
}
