import { expect, type Locator, type Page } from "@playwright/test";

export class RenameNotebookModalPage {
  constructor(
    private readonly page: Page,
    private readonly currentNotebookName: string,
  ) {}

  expectedRenameDialogHeading(): string {
    return `Rename ${this.currentNotebookName}?`;
  }

  dialog(): Locator {
    return this.page.getByRole("dialog").filter({
      hasText: this.expectedRenameDialogHeading(),
    });
  }

  newNameTextbox(): Locator {
    return this.dialog().getByRole("textbox", { name: "New name" });
  }

  submitRenameButton(): Locator {
    return this.dialog().getByRole("button", { name: "Submit" });
  }

  async expectDialogVisible(): Promise<void> {
    await expect(this.dialog()).toBeVisible();
  }

  async enterNewDisplayedNameAndSubmit(newName: string): Promise<void> {
    await this.newNameTextbox().fill(newName);
    await this.submitRenameButton().click();
  }
}
