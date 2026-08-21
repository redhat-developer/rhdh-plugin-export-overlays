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
import { selectDisplayMode } from "./lightspeed-page";

export { NOTEBOOK_UNTITLED_GRID_NAME };

const INLINE_RENAME_TOOLTIP = "Click to rename";

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

  /** Removes leftover cards so serial tests can start from an empty list. */
  async deleteLeftoverNotebookCards(): Promise<void> {
    const cards = this.chatbotRegion().locator(".pf-v6-c-card");
    while ((await cards.count()) > 0) {
      const remaining = await cards.count();
      const card = cards.first();
      const title =
        (await this.notebookCardTitleText(card).textContent())?.trim() ||
        NOTEBOOK_UNTITLED_GRID_NAME;
      await this.notebookCardOverflowMenuButton(card).click();
      await this.deleteNotebookOverflowMenuItem().click();
      await this.notebookDeleteConfirmationDialog(title).confirmDeletion();
      await expect(cards).toHaveCount(remaining - 1, { timeout: 10_000 });
    }
  }

  async clickCreateNotebookFromEmptyList(): Promise<void> {
    await this.createNotebookFromEmptyStateButton().click();
  }

  async clickPrimaryNotebookCreate(): Promise<void> {
    await this.createNotebookFromEmptyStateButton().click();
  }

  closeNotebookButton(): Locator {
    return this.page.getByRole("button", { name: "Close notebook" });
  }

  uploadResourceHeading(): Locator {
    return this.page.getByText("Add a resource to get started", {
      exact: true,
    });
  }

  uploadResourceActionButton(): Locator {
    return this.page.getByRole("button", { name: "Add a resource" });
  }

  disabledComposerPlaceholder(): Locator {
    return this.chatbotRegion().getByRole("textbox", {
      name: "Ask about your resources...",
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

  /**
   * Sidebar Add, never the composer `+` (same accessible name).
   * Expanded: labeled "Add" in DocumentSidebar. Collapsed: icon-only button
   * in the expand strip (DocumentSidebar unmounts when collapsed).
   */
  sidebarAddDocumentButton(): Locator {
    const labeledAdd = this.chatbotRegion()
      .getByRole("button", { name: "Add", exact: true })
      .filter({ hasText: /^Add$/ });
    const collapsedStripAdd = this.chatbotRegion()
      .locator("div")
      .filter({ has: this.sidebarExpandButton() })
      .filter({
        has: this.page.getByRole("button", { name: "Add", exact: true }),
      })
      .last()
      .getByRole("button", { name: "Add", exact: true });
    return labeledAdd.or(collapsedStripAdd);
  }

  async clickOpenUploadDocumentModal(): Promise<void> {
    await this.uploadResourceActionButton()
      .or(this.sidebarAddDocumentButton())
      .first()
      .click();
    await expect(this.uploadDocumentModal().dialog()).toBeVisible();
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

  async renameNotebookInline(newName: string): Promise<void> {
    const input = this.inlineRenameInput();
    await expect(input).toBeVisible();
    await input.fill(newName);
    await input.press("Enter");
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

    const disabledPrompt = this.disabledComposerPlaceholder();
    await expect(disabledPrompt).toBeDisabled();
    // Disabled composer does not receive pointer events; hover the wrapper instead.
    // eslint-disable-next-line playwright/no-force-option
    await disabledPrompt.locator("..").hover({ force: true });
    await expect(
      this.page.getByRole("tooltip", {
        name: "Select at least one loaded resource to start chatting",
      }),
    ).toBeVisible();

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
    return this.chatbotRegion().locator(".doc-kebab").first();
  }

  private firstDocumentFileName(): Locator {
    return this.chatbotRegion()
      .locator("[title]")
      .filter({ hasText: /.+\..+/ })
      .first();
  }

  private async hoverDocumentRowAndClickKebab(): Promise<void> {
    await this.firstDocumentFileName().hover();
    await this.firstListedDocumentOverflowMenuToggle().click();
  }

  documentRowDeleteMenuItem(): Locator {
    return this.page.getByRole("menuitem", {
      name: "Delete",
      exact: true,
    });
  }

  documentRowRenameMenuItem(): Locator {
    return this.page.getByRole("menuitem", {
      name: "Rename",
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
    await this.hoverDocumentRowAndClickKebab();
    await this.documentRowDeleteMenuItem().click();
    await expect(this.deleteDocumentConfirmDialog()).toBeVisible();
    await this.deleteDocumentConfirmButton().click();
  }

  documentFileName(name: string): Locator {
    return this.chatbotRegion().getByText(name, { exact: true }).first();
  }

  async renameDocumentInlineViaClick(
    oldName: string,
    newName: string,
  ): Promise<void> {
    await this.documentFileName(oldName).click();
    const input = this.chatbotRegion().getByRole("textbox", {
      name: "Rename",
    });
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.clear();
    await input.fill(newName);
    await input.press("Enter");
  }

  async renameDocumentViaKebabMenu(
    oldName: string,
    newName: string,
  ): Promise<void> {
    await this.hoverDocumentRowAndClickKebab();
    await this.documentRowRenameMenuItem().click();
    const input = this.chatbotRegion().getByRole("textbox", {
      name: "Rename",
    });
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.clear();
    await input.fill(newName);
    await input.press("Enter");
  }

  async expectDocumentFileListedInSidebar(fileName: string): Promise<void> {
    await expect(
      this.chatbotRegion().getByText(fileName, { exact: true }).first(),
    ).toBeVisible({ timeout: 60_000 });
  }

  uploadDocumentProgressbar(): Locator {
    return this.page.getByRole("progressbar", {
      name: "Uploading resource",
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

  formatNotebookCardDocumentsSummary(documentCount: number): string {
    return documentCount === 1
      ? `${documentCount} Resource`
      : `${documentCount} Resources`;
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
    const card = this.newestUntitledNotebookCard();
    await expect(card).toContainText(
      this.formatNotebookCardDocumentsSummary(documentCountOnCard),
    );
    await expect(card).toContainText("Updated today");
  }

  notebookCardTitleText(card: Locator): Locator {
    return card.locator(`[title="${INLINE_RENAME_TOOLTIP}"]`);
  }

  inlineRenameInput(): Locator {
    return this.chatbotRegion().getByRole("textbox", {
      name: INLINE_RENAME_TOOLTIP,
    });
  }

  async clickCardTitle(card: Locator): Promise<void> {
    await this.notebookCardTitleText(card).click();
  }

  sidebarTitleText(): Locator {
    return this.chatbotRegion().locator(`[title="${INLINE_RENAME_TOOLTIP}"]`);
  }

  async clickSidebarTitle(): Promise<void> {
    const title = this.sidebarTitleText();
    const input = this.inlineRenameInput();
    await expect(title).toBeVisible();
    await expect(async () => {
      await title.click();
      await expect(input).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });
  }

  /**
   * Notebook rename is optimistic in the UI; wait for PUT /v1/sessions/:id
   * so close does not auto-delete an still-untitled backend session.
   */
  waitForSessionRenamePut(): Promise<unknown> {
    return this.page.waitForResponse((response) => {
      if (response.request().method() !== "PUT" || !response.ok()) {
        return false;
      }
      try {
        return /\/v1\/sessions\/[^/]+$/.test(new URL(response.url()).pathname);
      } catch {
        return false;
      }
    });
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
