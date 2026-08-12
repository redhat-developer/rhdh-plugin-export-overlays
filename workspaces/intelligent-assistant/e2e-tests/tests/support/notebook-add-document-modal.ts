import { expect, type Locator, type Page } from "@playwright/test";

export class NotebookAddDocumentModalPage {
  constructor(private readonly page: Page) {}

  dialog(): Locator {
    return this.page.getByRole("dialog", {
      name: "Add a document to Notebook",
    });
  }

  browseFilesButton(): Locator {
    return this.dialog().getByRole("button", { name: "Upload", exact: true });
  }

  addFilesButton(stagedCount: number): Locator {
    return this.dialog().getByRole("button", {
      name: `Add (${stagedCount})`,
    });
  }

  cancelButton(): Locator {
    return this.dialog().getByRole("button", {
      name: "Cancel",
      exact: true,
    });
  }

  async expectUploadAreaFullyDescribed(): Promise<void> {
    await expect(
      this.dialog().getByText("Drag and drop files here"),
    ).toBeVisible();
    await expect(this.dialog().getByText("or", { exact: true })).toBeVisible();
    await expect(this.browseFilesButton()).toBeVisible();
    await expect(
      this.dialog().getByText(
        "Accepted file types: .md, .txt, .pdf, .json, .yaml, .log",
        { exact: true },
      ),
    ).toBeVisible();
  }

  async expectModalTitleBarMatchesAriaSnapshot(): Promise<void> {
    await expect(this.dialog()).toContainText("Add a document to Notebook");
  }

  async expectAddFilesButtonDisabled(stagedCount: number): Promise<void> {
    await expect(this.addFilesButton(stagedCount)).toBeDisabled();
  }

  async selectFilesViaBrowsePicker(filePaths: string[]): Promise<void> {
    const [fileChooser] = await Promise.all([
      this.page.waitForEvent("filechooser"),
      this.browseFilesButton().click(),
    ]);
    await fileChooser.setFiles(filePaths);
  }

  async expectStagedFileCountCaptionVisible(
    stagedCount: number,
    maxSelectable: number,
  ): Promise<void> {
    await expect(
      this.dialog().getByText(
        `${stagedCount} of ${maxSelectable} files selected`,
        { exact: true },
      ),
    ).toBeVisible();
  }

  async clickAddFilesForStagedCount(stagedCount: number): Promise<void> {
    await this.addFilesButton(stagedCount).click();
  }

  async clickCancel(): Promise<void> {
    await this.cancelButton().click();
  }
}
