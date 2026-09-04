import { expect, type Locator, type Page } from "@playwright/test";

const DROP_ZONE_LABEL = "Drag and drop files here, or click to browse";

export class NotebookAddDocumentModalPage {
  constructor(private readonly page: Page) {}

  dialog(): Locator {
    return this.page.getByRole("dialog", {
      name: "Add resources",
    });
  }

  dragAndDropInstructions(): Locator {
    return this.dialog().getByText(DROP_ZONE_LABEL);
  }

  supportedFormatsLabel(): Locator {
    return this.dialog().getByText("Supported formats:", { exact: true });
  }

  maxFileSizeText(): Locator {
    return this.dialog().getByText("Maximum file size is 25 MB.", {
      exact: true,
    });
  }

  addFilesButton(stagedCount: number): Locator {
    return this.dialog().getByRole("button", {
      name: stagedCount === 0 ? "Add" : `Add (${stagedCount})`,
      exact: true,
    });
  }

  cancelButton(): Locator {
    return this.dialog().getByRole("button", {
      name: "Cancel",
      exact: true,
    });
  }

  errorAlert(message: string): Locator {
    return this.dialog().getByRole("heading", {
      name: `Danger alert: ${message}`,
    });
  }

  async expectUploadAreaFullyDescribed(): Promise<void> {
    await expect(this.dragAndDropInstructions()).toBeVisible();
    await expect(this.supportedFormatsLabel()).toBeVisible();
    await expect(this.maxFileSizeText()).toBeVisible();
  }

  modalTitleAccessibilityRegion(): Locator {
    return this.page.locator("#add-document-modal-title");
  }

  async expectModalTitleBarMatchesAriaSnapshot(): Promise<void> {
    await expect(this.modalTitleAccessibilityRegion()).toMatchAriaSnapshot(`
      - heading :
        - heading "Add resources"
        - button "Close"
      `);
  }

  async expectAddFilesButtonDisabled(stagedCount: number): Promise<void> {
    await expect(this.addFilesButton(stagedCount)).toBeDisabled();
  }

  async selectFilesViaBrowsePicker(filePaths: string[]): Promise<void> {
    const [fileChooser] = await Promise.all([
      this.page.waitForEvent("filechooser"),
      this.dragAndDropInstructions().click(),
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
