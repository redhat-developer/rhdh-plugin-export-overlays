import { expect, type Locator, type Page } from "@playwright/test";

export class NotebookDeleteDialogPage {
  constructor(
    private readonly page: Page,
    private readonly notebookDisplayName: string,
  ) {}

  dialog(): Locator {
    return this.page.getByRole("dialog").filter({
      hasText: this.notebookDisplayName,
    });
  }

  deleteNotebookConfirmButton(): Locator {
    return this.dialog().getByRole("button", {
      name: "Delete",
      exact: true,
    });
  }

  async expectDialogVisible(): Promise<void> {
    await expect(this.dialog()).toBeVisible();
  }

  async expectPermanentDeletionWarningText(): Promise<void> {
    await expect(this.dialog()).toContainText(
      "You'll no longer see this notebook here. This will also delete related activity like prompts, responses, and feedback from your Lightspeed Activity.",
    );
  }

  async confirmDeletion(): Promise<void> {
    await this.deleteNotebookConfirmButton().click();
  }
}
