import { expect, type Locator, type Page } from "@playwright/test";

const DROP_ZONE_LABEL = "Drag and drop files here, or click to browse";
const MODAL_TITLE = "Add resources";

export class NotebookAddDocumentModalPage {
  constructor(private readonly page: Page) {}

  dialog(): Locator {
    return this.page
      .locator('[role="dialog"][aria-labelledby="add-document-modal-title"]')
      .filter({ hasText: DROP_ZONE_LABEL });
  }

  /** Footer actions are outside the nested-dialog a11y tree in compact modes. */
  private dialogActions(): Locator {
    return this.dialog().locator('[class*="MuiDialogActions-root"]');
  }

  private dialogFooterButton(label: string): Locator {
    const escapedLabel = label.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return this.dialogActions().locator(`button:text-is("${escapedLabel}")`);
  }

  modalTitleAccessibilityRegion(): Locator {
    return this.dialog()
      .locator("h2")
      .filter({ hasText: MODAL_TITLE })
      .first();
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
    const label = stagedCount === 0 ? "Add" : `Add (${stagedCount})`;
    return this.dialogFooterButton(label);
  }

  cancelButton(): Locator {
    return this.dialogFooterButton("Cancel");
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
    await this.expectSupportedFileTypeChipsVisible();
  }

  async expectSupportedFileTypeChipsVisible(): Promise<void> {
    for (const label of ["TXT", "MD", "PDF", "JSON", "YAML", "LOG"]) {
      await expect(
        this.dialog().getByText(label, { exact: true }),
      ).toBeVisible();
    }
  }

  titleCloseButton(): Locator {
    return this.dialog().locator('button[aria-label="Close"]');
  }

  async clickTitleClose(): Promise<void> {
    const close = this.titleCloseButton();
    await close.scrollIntoViewIfNeeded();
    // eslint-disable-next-line playwright/no-force-option
    await close.click({ force: true });
  }

  async dismiss(): Promise<void> {
    const cancel = this.cancelButton();
    if (await cancel.count()) {
      // eslint-disable-next-line playwright/no-force-option
      await cancel.click({ force: true });
    } else {
      await this.clickTitleClose();
    }
    await expect(this.dialog()).toBeHidden({ timeout: 10_000 });
  }

  dropzoneClickArea(): Locator {
    const escapedLabel = DROP_ZONE_LABEL.replace(/\\/g, "\\\\").replace(
      /"/g,
      '\\"',
    );
    return this.dialog().locator(
      `[role="button"][aria-label="${escapedLabel}"]`,
    );
  }

  async expectDropzoneDisabled(): Promise<void> {
    await expect(this.dropzoneClickArea()).toHaveAttribute("tabindex", "-1");
  }

  async expectMaxReachedTooltipOnDropzoneHover(): Promise<void> {
    // eslint-disable-next-line playwright/no-force-option
    await this.dropzoneClickArea().hover({ force: true });
    await expect(
      this.page.getByRole("tooltip", {
        name: "Maximum 10 resources are allowed. Delete a resource to upload a new resource.",
      }),
    ).toBeVisible();
  }

  async expectModalTitleBarMatchesAriaSnapshot(): Promise<void> {
    await expect(this.modalTitleAccessibilityRegion()).toBeVisible();
    await expect(this.titleCloseButton()).toBeVisible();
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
    const button = this.addFilesButton(stagedCount);
    // eslint-disable-next-line playwright/no-force-option
    await button.click({ force: true });
  }

  async clickCancel(): Promise<void> {
    await this.dismiss();
  }
}
