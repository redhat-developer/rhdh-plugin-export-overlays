import { expect, type Locator, type Page } from "@playwright/test";
import {
  NOTEBOOK_UNTITLED_GRID_NAME,
  localeNotebookUploadPath,
  NOTEBOOK_SESSION_MAX_DOCUMENTS,
} from "./notebook-constants";
import { openLightspeed } from "./test-helper";
import { NotebookAddDocumentModalPage } from "./notebook-add-document-modal";
import { NotebookDeleteDialogPage } from "./notebook-delete-dialog";
import { NotebookOverwriteConfirmModalPage } from "./notebook-overwrite-confirm-modal";
import { RenameNotebookModalPage } from "./notebook-rename-modal";
import { selectDisplayMode } from "./lightspeed-page";

export { NOTEBOOK_UNTITLED_GRID_NAME };

export class NotebookSurfacePage {
  constructor(private readonly page: Page) {}

  chatbotRegion(): Locator {
    return this.page.getByLabel("Chatbot", { exact: true });
  }

  async gotoFullscreenNotebooksTab(): Promise<void> {
    await openLightspeed(this.page);
    await selectDisplayMode(this.page, "Fullscreen");
    await this.page.getByRole("tab", { name: "Notebooks" }).click();
  }

  notebooksTab(): Locator {
    return this.page.getByRole("tab", { name: "Notebooks" });
  }

  myNotebooksHeading(): Locator {
    return this.page.getByRole("heading", { name: "My Notebooks" });
  }

  createNotebookFromEmptyStateButton(): Locator {
    return this.page
      .getByRole("button", { name: "Create a new notebook" })
      .first();
  }

  async expectNotebookListHeaderControlsVisible(): Promise<void> {
    await expect(this.notebooksTab()).toBeVisible();
    await expect(this.myNotebooksHeading()).toBeVisible();
    await expect(this.createNotebookFromEmptyStateButton()).toBeVisible();
  }

  async expectEmptyNotebookListMatchesAriaSnapshot(): Promise<void> {
    await expect(this.chatbotRegion()).toContainText("No created notebooks");
    await expect(this.chatbotRegion()).toContainText(
      "Start a new notebook to organize your sources and generate AI-powered insights.",
    );
    await expect(this.createNotebookFromEmptyStateButton()).toBeVisible();
  }

  async clickCreateNotebookFromEmptyList(): Promise<void> {
    await this.createNotebookFromEmptyStateButton().click();
  }

  closeNotebookButton(): Locator {
    return this.page.getByRole("button", { name: "Close notebook" });
  }

  uploadResourceHeading(): Locator {
    return this.page.getByText("Upload a resource to get started", {
      exact: true,
    });
  }

  uploadResourceActionButton(): Locator {
    return this.page.getByRole("button", { name: "Upload a resource" });
  }

  disabledComposerPlaceholder(): Locator {
    return this.chatbotRegion().getByRole("textbox", {
      name: "Ask about your documents...",
    });
  }

  sidebarCollapseButton(): Locator {
    return this.page.getByRole("button", {
      name: "Collapse sidebar",
    });
  }

  sidebarExpandButton(): Locator {
    return this.page.getByRole("button", {
      name: "Expand sidebar",
    });
  }

  sidebarAddDocumentButton(): Locator {
    return this.chatbotRegion()
      .getByRole("button", { name: "Add", exact: true })
      .first();
  }

  async clickOpenUploadDocumentModal(): Promise<void> {
    await this.sidebarAddDocumentButton().click();
  }

  uploadDocumentModal(): NotebookAddDocumentModalPage {
    return new NotebookAddDocumentModalPage(this.page);
  }

  notebookOverwriteConfirmModal(): NotebookOverwriteConfirmModalPage {
    return new NotebookOverwriteConfirmModalPage(this.page);
  }

  notebookDeleteConfirmationDialog(
    notebookDisplayName: string,
  ): NotebookDeleteDialogPage {
    return new NotebookDeleteDialogPage(this.page, notebookDisplayName);
  }

  renameNotebookDialog(
    currentDisplayedNotebookName: string,
  ): RenameNotebookModalPage {
    return new RenameNotebookModalPage(this.page, currentDisplayedNotebookName);
  }

  async expectNewNotebookEditorEmptyStateOnboarding(): Promise<void> {
    await expect(this.closeNotebookButton()).toBeVisible();
    await expect(this.uploadResourceHeading()).toBeVisible();
    await expect(this.uploadResourceActionButton()).toBeVisible();
    await expect(
      this.page.getByText(
        "This feature uses AI technology. Do not include any personal information or any other sensitive information in your input. Interactions may be used to improve Red Hat's products or services.",
        { exact: true },
      ),
    ).toBeVisible();

    await expect(this.disabledComposerPlaceholder()).toBeDisabled();
    await expect(this.sidebarCollapseButton()).toBeVisible();
    await expect(this.sidebarAddDocumentButton()).toBeVisible();
  }

  async collapseThenExpandDocumentSidebar(): Promise<void> {
    await expect(this.sidebarCollapseButton()).toBeVisible();
    await this.sidebarCollapseButton().click();
    await expect(this.sidebarExpandButton()).toBeVisible();
    await expect(this.sidebarCollapseButton()).toBeHidden();
    await expect(this.sidebarAddDocumentButton()).toBeVisible();
    await this.sidebarExpandButton().click();
    await expect(this.sidebarCollapseButton()).toBeVisible();
  }

  firstListedDocumentOverflowMenuToggle(): Locator {
    return this.chatbotRegion()
      .getByRole("button", {
        name: "Delete",
        exact: true,
      })
      .first();
  }

  documentRowDeleteMenuItem(): Locator {
    return this.page.getByRole("menuitem", {
      name: "Delete",
      exact: true,
    });
  }

  deleteDocumentConfirmDialog(): Locator {
    return this.page.getByRole("dialog").filter({
      hasText: "Remove resource?",
    });
  }

  deleteDocumentConfirmButton(): Locator {
    return this.deleteDocumentConfirmDialog().getByRole("button", {
      name: "Remove",
      exact: true,
    });
  }

  async deleteFirstListedDocumentFromSidebarOverflowMenu(): Promise<void> {
    await this.firstListedDocumentOverflowMenuToggle().click();
    await this.documentRowDeleteMenuItem().click();
    await expect(this.deleteDocumentConfirmDialog()).toBeVisible();
    await this.deleteDocumentConfirmButton().click();
  }

  async expectDocumentFileListedInSidebar(fileName: string): Promise<void> {
    await expect(
      this.chatbotRegion().getByText(fileName, { exact: true }).first(),
    ).toBeVisible({ timeout: 60_000 });
  }

  uploadDocumentProgressbar(): Locator {
    return this.page.getByRole("progressbar", {
      name: "Uploading document",
    });
  }

  async expectDocumentUploadCompletes(fileName: string): Promise<void> {
    const progressbar = this.uploadDocumentProgressbar();

    // Upload can complete too quickly to reliably catch visible state in every run.
    await progressbar
      .waitFor({ state: "visible", timeout: 10_000 })
      .catch(() => {
        /* no-op */
      });
    await this.expectDocumentFileListedInSidebar(fileName);
    await expect(progressbar).toBeHidden({ timeout: 60_000 });
  }

  async expectNotebookEditorUploadResourceButtonVisible(
    timeout = 5_000,
  ): Promise<void> {
    await expect(this.uploadResourceActionButton()).toBeVisible({ timeout });
  }

  untitledNotebookCards(): Locator {
    return this.chatbotRegion()
      .locator(".pf-v6-c-card")
      .filter({ hasText: NOTEBOOK_UNTITLED_GRID_NAME });
  }

  newestUntitledNotebookCard(): Locator {
    return this.untitledNotebookCards().last();
  }

  notebookCardOverflowMenuButton(card: Locator): Locator {
    return card.getByRole("button", {
      name: "Options",
      exact: true,
    });
  }

  notebookCardByDisplayedName(notebookDisplayedName: string): Locator {
    return this.chatbotRegion()
      .locator(".pf-v6-c-card")
      .filter({ hasText: notebookDisplayedName })
      .first();
  }

  renameNotebookOverflowMenuItem(): Locator {
    return this.page.getByRole("menuitem", {
      name: "Rename",
    });
  }

  deleteNotebookOverflowMenuItem(): Locator {
    return this.page.getByRole("menuitem", {
      name: "Delete",
    });
  }

  async expectUntitledNotebookCardCount(expected: number): Promise<void> {
    await expect(this.untitledNotebookCards()).toHaveCount(expected, {
      timeout: 5_000,
    });
  }

  async expectNotebookCardAbsent(notebookDisplayedName: string): Promise<void> {
    await expect(
      this.chatbotRegion()
        .locator(".pf-v6-c-card")
        .filter({ hasText: notebookDisplayedName }),
    ).toHaveCount(0, { timeout: 5_000 });
  }

  async clickCloseNotebookEditor(): Promise<void> {
    await this.closeNotebookButton().click();
  }

  async expectNotebookListShowsDocumentCountSummaryAndUpdatedToday(
    documentCountOnCard = 0,
  ): Promise<void> {
    await expect(this.chatbotRegion()).toContainText(
      `${documentCountOnCard} Documents`,
    );
    await expect(this.chatbotRegion()).toContainText("Updated today");
  }

  async uploadSingleDefaultDocumentForConversation(): Promise<string> {
    const { absolutePath, fileName } = localeNotebookUploadPath();
    await this.clickOpenUploadDocumentModal();
    const uploadModal = this.uploadDocumentModal();
    await uploadModal.selectFilesViaBrowsePicker([absolutePath]);
    await uploadModal.expectStagedFileCountCaptionVisible(
      1,
      NOTEBOOK_SESSION_MAX_DOCUMENTS,
    );
    await uploadModal.clickAddFilesForStagedCount(1);
    await this.expectDocumentUploadCompletes(fileName);
    return fileName;
  }
}
