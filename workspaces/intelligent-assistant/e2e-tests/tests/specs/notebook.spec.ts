import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import type { BrowserContext, Page } from "@playwright/test";
import { LoginHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import {
  NotebookSurfacePage,
  NOTEBOOK_UNTITLED_GRID_NAME,
} from "../support/notebook-surface-page";
import {
  localeNotebookUploadCopyAs,
  localeNotebookUploadPath,
  NOTEBOOK_EDITOR_URL_RE,
  NOTEBOOK_SESSION_MAX_DOCUMENTS,
  notebookElevenFileStagingPaths,
  notebookUnsupportedTypeFixturePath,
} from "../support/notebook-constants";
import {
  assertLastBotResponseCopiedToClipboard,
  submitFeedback,
  verifyFeedbackButtons,
} from "../support/conversation-helper";
import { ensureLightspeedDeployment } from "../support/test-helper";

const RENAMED_NOTEBOOK_TITLE = "E2E Notebook Renamed";

function notebookFileNameParts(fileName: string): {
  baseName: string;
  ext: string;
} {
  const baseName = fileName.replace(/\.[^.]+$/, "");
  return { baseName, ext: fileName.slice(baseName.length) };
}

test.describe("Lightspeed notebooks", () => {
  test.describe.configure({ mode: "serial", timeout: 7 * 60 * 1000 });

  let context: BrowserContext;
  let page: Page;
  let notebooks: NotebookSurfacePage;

  test.beforeAll(async ({ browser, rhdh }) => {
    test.setTimeout(10 * 60 * 1000);
    await ensureLightspeedDeployment(rhdh);

    context = await browser.newContext({
      baseURL: process.env.RHDH_BASE_URL,
      permissions: ["clipboard-read", "clipboard-write"],
    });
    page = await context.newPage();
    await new LoginHelper(page).loginAsKeycloakUser();
    notebooks = new NotebookSurfacePage(page);
    await notebooks.gotoFullscreenNotebooksTab();
    await notebooks.deleteLeftoverNotebookCards();
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("fullscreen list: header and empty state", async () => {
    await notebooks.gotoFullscreenNotebooksTab();
    await notebooks.expectNotebookListHeaderControlsVisible();
    await notebooks.expectEmptyNotebookListMatchesAriaSnapshot();
  });

  test("new notebook: editor onboarding", async () => {
    await notebooks.gotoFullscreenNotebooksTab();
    await notebooks.clickCreateNotebookFromEmptyList();
    await expect(page).toHaveURL(NOTEBOOK_EDITOR_URL_RE);
    await notebooks.expectNewNotebookEditorEmptyStateOnboarding();
  });

  test("upload modal: drop zone and disabled add", async () => {
    await notebooks.clickOpenUploadDocumentModal();
    const uploadModal = notebooks.uploadDocumentModal();

    await uploadModal.expectUploadAreaFullyDescribed();
    await uploadModal.expectModalTitleBarMatchesAriaSnapshot();
    await uploadModal.expectAddFilesButtonDisabled(0);
    await uploadModal.clickCancel();
  });

  test("document sidebar: collapse and expand", async () => {
    await notebooks.collapseThenExpandDocumentSidebar();
  });

  test("sidebar: add file then remove", async () => {
    const { absolutePath, fileName } = localeNotebookUploadPath();

    await notebooks.clickOpenUploadDocumentModal();
    const uploadModal = notebooks.uploadDocumentModal();
    await uploadModal.selectFilesViaBrowsePicker([absolutePath]);

    await uploadModal.expectStagedFileCountCaptionVisible(
      1,
      NOTEBOOK_SESSION_MAX_DOCUMENTS,
    );
    await uploadModal.clickAddFilesForStagedCount(1);

    await notebooks.expectDocumentUploadCompletes(fileName);
    await notebooks.deleteFirstListedDocumentFromSidebarOverflowMenu();
    await notebooks.expectNotebookEditorUploadResourceButtonVisible();
  });

  test("document sidebar: rename document via click", async () => {
    const { absolutePath, fileName } =
      localeNotebookUploadPath("en.upload2.json");
    const { baseName, ext } = notebookFileNameParts(fileName);
    const renamedFileName = `${baseName}-renamed${ext}`;

    await notebooks.clickOpenUploadDocumentModal();
    const uploadModal = notebooks.uploadDocumentModal();
    await uploadModal.selectFilesViaBrowsePicker([absolutePath]);
    await uploadModal.expectStagedFileCountCaptionVisible(
      1,
      NOTEBOOK_SESSION_MAX_DOCUMENTS,
    );
    await uploadModal.clickAddFilesForStagedCount(1);
    await expect(uploadModal.dialog()).toBeHidden();
    await notebooks.expectDocumentUploadCompletes(fileName);
    // eslint-disable-next-line playwright/no-wait-for-timeout
    await page.waitForTimeout(500);

    await notebooks.renameDocumentInlineViaClick(
      fileName,
      `${baseName}-renamed`,
    );
    // eslint-disable-next-line playwright/no-wait-for-timeout
    await page.waitForTimeout(500);
    await notebooks.expectDocumentFileListedInSidebar(renamedFileName);
  });

  test("upload modal: duplicate file confirms overwrite then upload", async () => {
    const { fileName: originalFileName } =
      localeNotebookUploadPath("en.upload2.json");
    const { baseName, ext } = notebookFileNameParts(originalFileName);
    const listedFileName = `${baseName}-renamed${ext}`;
    const { absolutePath, fileName } =
      localeNotebookUploadCopyAs(listedFileName);

    await notebooks.expectDocumentFileListedInSidebar(fileName);

    await notebooks.clickOpenUploadDocumentModal();
    const uploadModal = notebooks.uploadDocumentModal();
    await uploadModal.selectFilesViaBrowsePicker([absolutePath]);
    await uploadModal.clickAddFilesForStagedCount(1);

    const overwriteModal = notebooks.notebookOverwriteConfirmModal();
    await overwriteModal.expectDialogVisible();
    await overwriteModal.expectListedOverwriteFile(fileName);
    await overwriteModal.clickBack();
    await expect(overwriteModal.dialog()).toBeHidden();
    await expect(uploadModal.dialog()).toBeVisible();
    await uploadModal.clickCancel();
  });

  test("document sidebar: rename document via kebab menu", async () => {
    const { fileName } = localeNotebookUploadPath("en.upload2.json");
    const { baseName, ext } = notebookFileNameParts(fileName);
    const renamedFileName = `${baseName}-renamed${ext}`;
    const kebabFileName = `${baseName}-kebab${ext}`;

    await notebooks.expectDocumentFileListedInSidebar(renamedFileName);
    await notebooks.renameDocumentViaKebabMenu(
      renamedFileName,
      `${baseName}-kebab`,
    );
    await notebooks.expectDocumentFileListedInSidebar(kebabFileName);
  });

  test("upload modal: eleven files rejected at cap", async () => {
    await notebooks.clickOpenUploadDocumentModal();
    const uploadModal = notebooks.uploadDocumentModal();
    await uploadModal.selectFilesViaBrowsePicker(
      notebookElevenFileStagingPaths(),
    );
    await expect(
      uploadModal.errorAlert(
        `Upload error: Maximum of ${NOTEBOOK_SESSION_MAX_DOCUMENTS} files allowed.`,
      ),
    ).toBeVisible();
    await uploadModal.clickCancel();
  });

  test("upload modal: unsupported extension rejected", async () => {
    await notebooks.clickOpenUploadDocumentModal();
    const uploadModal = notebooks.uploadDocumentModal();
    await uploadModal.selectFilesViaBrowsePicker([
      notebookUnsupportedTypeFixturePath(),
    ]);
    await expect(
      uploadModal.errorAlert(
        "Upload error: Unsupported file type(s) found. Please upload only supported file types.",
      ),
    ).toBeVisible();
    await uploadModal.clickCancel();
  });

  test("grid: close editor, rename, delete", async () => {
    const untitledBefore = await notebooks.untitledNotebookCards().count();

    await notebooks.clickCloseNotebookEditor();
    await notebooks.expectUntitledNotebookCardCount(untitledBefore + 1);
    await expect(notebooks.newestUntitledNotebookCard()).toBeVisible();

    await notebooks.expectNotebookListShowsDocumentCountSummaryAndUpdatedToday(
      1,
    );

    await notebooks
      .notebookCardOverflowMenuButton(notebooks.newestUntitledNotebookCard())
      .click();
    await notebooks.renameNotebookOverflowMenuItem().click();
    await notebooks.renameNotebookInline(RENAMED_NOTEBOOK_TITLE);

    await expect(
      notebooks.notebookCardByDisplayedName(RENAMED_NOTEBOOK_TITLE),
    ).toBeVisible();

    await notebooks
      .notebookCardOverflowMenuButton(
        notebooks.notebookCardByDisplayedName(RENAMED_NOTEBOOK_TITLE),
      )
      .click();
    await notebooks.deleteNotebookOverflowMenuItem().click();

    const confirmDelete = notebooks.notebookDeleteConfirmationDialog(
      RENAMED_NOTEBOOK_TITLE,
    );
    await confirmDelete.expectDialogVisible();
    await confirmDelete.expectPermanentDeletionWarningText();
    await confirmDelete.confirmDeletion();

    await notebooks.expectNotebookCardAbsent(RENAMED_NOTEBOOK_TITLE);
    await notebooks.expectUntitledNotebookCardCount(untitledBefore);
  });

  test("grid: click card title triggers inline rename", async () => {
    const { absolutePath, fileName } = localeNotebookUploadPath();

    await notebooks.clickPrimaryNotebookCreate();

    await notebooks.clickOpenUploadDocumentModal();
    const uploadModal = notebooks.uploadDocumentModal();
    await uploadModal.selectFilesViaBrowsePicker([absolutePath]);
    await uploadModal.clickAddFilesForStagedCount(1);
    await notebooks.expectDocumentUploadCompletes(fileName);

    await notebooks.clickCloseNotebookEditor();

    const card = notebooks.newestUntitledNotebookCard();
    await expect(card).toBeVisible();

    await notebooks.clickCardTitle(card);
    await expect(notebooks.inlineRenameInput()).toBeVisible();

    const newName = "DoubleClick Renamed";
    await notebooks.inlineRenameInput().fill(newName);
    await notebooks.inlineRenameInput().press("Enter");

    await expect(notebooks.notebookCardByDisplayedName(newName)).toBeVisible();

    await notebooks
      .notebookCardOverflowMenuButton(
        notebooks.notebookCardByDisplayedName(newName),
      )
      .click();
    await notebooks.deleteNotebookOverflowMenuItem().click();
    const confirmDelete = notebooks.notebookDeleteConfirmationDialog(newName);
    await confirmDelete.confirmDeletion();
    await notebooks.expectNotebookCardAbsent(newName);
  });

  test("grid: Escape cancels inline rename", async () => {
    const { absolutePath, fileName } = localeNotebookUploadPath();

    await notebooks.clickPrimaryNotebookCreate();

    await notebooks.clickOpenUploadDocumentModal();
    const uploadModal = notebooks.uploadDocumentModal();
    await uploadModal.selectFilesViaBrowsePicker([absolutePath]);
    await uploadModal.clickAddFilesForStagedCount(1);
    await notebooks.expectDocumentUploadCompletes(fileName);

    await notebooks.clickCloseNotebookEditor();

    const card = notebooks.newestUntitledNotebookCard();
    await expect(card).toBeVisible();

    await notebooks.notebookCardOverflowMenuButton(card).click();
    await notebooks.renameNotebookOverflowMenuItem().click();
    await expect(notebooks.inlineRenameInput()).toBeVisible();

    await notebooks.inlineRenameInput().fill("Should Not Save");
    await notebooks.inlineRenameInput().press("Escape");

    await expect(notebooks.inlineRenameInput()).toBeHidden();
    await expect(
      notebooks.notebookCardByDisplayedName(NOTEBOOK_UNTITLED_GRID_NAME),
    ).toBeVisible();
    await notebooks.expectNotebookCardAbsent("Should Not Save");

    await notebooks
      .notebookCardOverflowMenuButton(notebooks.newestUntitledNotebookCard())
      .click();
    await notebooks.deleteNotebookOverflowMenuItem().click();
    const confirmDelete = notebooks.notebookDeleteConfirmationDialog(
      NOTEBOOK_UNTITLED_GRID_NAME,
    );
    await confirmDelete.confirmDeletion();
  });

  test("grid: blur saves inline rename", async () => {
    const { absolutePath, fileName } = localeNotebookUploadPath();

    await notebooks.clickPrimaryNotebookCreate();

    await notebooks.clickOpenUploadDocumentModal();
    const uploadModal = notebooks.uploadDocumentModal();
    await uploadModal.selectFilesViaBrowsePicker([absolutePath]);
    await uploadModal.clickAddFilesForStagedCount(1);
    await notebooks.expectDocumentUploadCompletes(fileName);

    await notebooks.clickCloseNotebookEditor();

    const card = notebooks.newestUntitledNotebookCard();
    await expect(card).toBeVisible();

    await notebooks.clickCardTitle(card);
    await expect(notebooks.inlineRenameInput()).toBeVisible();

    const newName = "Blur Saved Name";
    await notebooks.inlineRenameInput().fill(newName);
    await notebooks.myNotebooksHeading().click();

    await expect(notebooks.inlineRenameInput()).toBeHidden();
    await expect(notebooks.notebookCardByDisplayedName(newName)).toBeVisible();

    await notebooks
      .notebookCardOverflowMenuButton(
        notebooks.notebookCardByDisplayedName(newName),
      )
      .click();
    await notebooks.deleteNotebookOverflowMenuItem().click();
    const confirmDelete = notebooks.notebookDeleteConfirmationDialog(newName);
    await confirmDelete.confirmDeletion();
    await notebooks.expectNotebookCardAbsent(newName);
  });

  test("grid: empty or unchanged name cancels rename", async () => {
    const { absolutePath, fileName } = localeNotebookUploadPath();

    await notebooks.clickPrimaryNotebookCreate();

    await notebooks.clickOpenUploadDocumentModal();
    const uploadModal = notebooks.uploadDocumentModal();
    await uploadModal.selectFilesViaBrowsePicker([absolutePath]);
    await uploadModal.clickAddFilesForStagedCount(1);
    await notebooks.expectDocumentUploadCompletes(fileName);

    await notebooks.clickCloseNotebookEditor();

    const card = notebooks.newestUntitledNotebookCard();
    await expect(card).toBeVisible();

    await notebooks.clickCardTitle(card);
    await expect(notebooks.inlineRenameInput()).toBeVisible();

    await notebooks.inlineRenameInput().fill("");
    await notebooks.inlineRenameInput().press("Enter");

    await expect(notebooks.inlineRenameInput()).toBeHidden();
    await expect(
      notebooks.notebookCardByDisplayedName(NOTEBOOK_UNTITLED_GRID_NAME),
    ).toBeVisible();

    await notebooks.clickCardTitle(notebooks.newestUntitledNotebookCard());
    await expect(notebooks.inlineRenameInput()).toBeVisible();
    await notebooks.inlineRenameInput().press("Enter");

    await expect(notebooks.inlineRenameInput()).toBeHidden();
    await expect(
      notebooks.notebookCardByDisplayedName(NOTEBOOK_UNTITLED_GRID_NAME),
    ).toBeVisible();

    await notebooks
      .notebookCardOverflowMenuButton(notebooks.newestUntitledNotebookCard())
      .click();
    await notebooks.deleteNotebookOverflowMenuItem().click();
    const confirmDelete = notebooks.notebookDeleteConfirmationDialog(
      NOTEBOOK_UNTITLED_GRID_NAME,
    );
    await confirmDelete.confirmDeletion();
  });

  test("sidebar: click title to rename inside editor", async () => {
    await notebooks.clickPrimaryNotebookCreate();
    await expect(page).toHaveURL(NOTEBOOK_EDITOR_URL_RE);

    await expect(notebooks.sidebarTitleText()).toBeVisible();
    await notebooks.clickSidebarTitle();

    const sidebarInput = notebooks.inlineRenameInput();
    await expect(sidebarInput).toBeVisible();

    const newName = "Sidebar Renamed";
    await sidebarInput.fill(newName);
    const renamePersisted = notebooks.waitForSessionRenamePut();
    await sidebarInput.press("Enter");
    await renamePersisted;

    await expect(sidebarInput).toBeHidden();
    await expect(notebooks.sidebarTitleText()).toContainText(newName);

    await notebooks.clickCloseNotebookEditor();
    await expect(notebooks.myNotebooksHeading()).toBeVisible();

    await expect(notebooks.notebookCardByDisplayedName(newName)).toBeVisible({
      timeout: 15_000,
    });

    await notebooks
      .notebookCardOverflowMenuButton(
        notebooks.notebookCardByDisplayedName(newName),
      )
      .click();
    await notebooks.deleteNotebookOverflowMenuItem().click();
    const confirmDelete = notebooks.notebookDeleteConfirmationDialog(newName);
    await confirmDelete.confirmDeletion();
    await notebooks.expectNotebookCardAbsent(newName);
  });

  test("auto-delete: empty untitled notebook is discarded on close", async () => {
    await notebooks.gotoFullscreenNotebooksTab();
    const cardsBefore = await notebooks.untitledNotebookCards().count();

    await notebooks.clickCreateNotebookFromEmptyList();
    await expect(page).toHaveURL(NOTEBOOK_EDITOR_URL_RE);

    await notebooks.clickCloseNotebookEditor();

    await notebooks.expectUntitledNotebookCardCount(cardsBefore);
  });

  test("auto-delete: notebook with uploaded file persists on close", async () => {
    const { absolutePath, fileName } = localeNotebookUploadPath();
    const cardsBefore = await notebooks.untitledNotebookCards().count();

    await notebooks.clickCreateNotebookFromEmptyList();
    await expect(page).toHaveURL(NOTEBOOK_EDITOR_URL_RE);

    await notebooks.clickOpenUploadDocumentModal();
    const uploadModal = notebooks.uploadDocumentModal();
    await uploadModal.selectFilesViaBrowsePicker([absolutePath]);
    await uploadModal.clickAddFilesForStagedCount(1);
    await notebooks.expectDocumentUploadCompletes(fileName);
    // eslint-disable-next-line playwright/no-wait-for-timeout
    await page.waitForTimeout(500);

    await notebooks.clickCloseNotebookEditor();

    await notebooks.expectUntitledNotebookCardCount(cardsBefore + 1);

    await notebooks
      .notebookCardOverflowMenuButton(notebooks.newestUntitledNotebookCard())
      .click();
    await notebooks.deleteNotebookOverflowMenuItem().click();
    const confirmDelete = notebooks.notebookDeleteConfirmationDialog(
      NOTEBOOK_UNTITLED_GRID_NAME,
    );
    await confirmDelete.confirmDeletion();
    await notebooks.expectUntitledNotebookCardCount(cardsBefore);
  });

  test("auto-delete: renamed notebook persists on close", async () => {
    await notebooks.gotoFullscreenNotebooksTab();

    await notebooks.clickCreateNotebookFromEmptyList();
    await expect(page).toHaveURL(NOTEBOOK_EDITOR_URL_RE);

    await notebooks.clickSidebarTitle();
    const sidebarInput = notebooks.inlineRenameInput();
    await expect(sidebarInput).toBeVisible();
    const renamedName = "Renamed Persists";
    await sidebarInput.fill(renamedName);
    const renamePersisted = notebooks.waitForSessionRenamePut();
    await sidebarInput.press("Enter");
    await renamePersisted;

    await expect(sidebarInput).toBeHidden();
    await expect(notebooks.sidebarTitleText()).toContainText(renamedName);

    await notebooks.clickCloseNotebookEditor();
    await expect(notebooks.myNotebooksHeading()).toBeVisible();

    await expect(
      notebooks.notebookCardByDisplayedName(renamedName),
    ).toBeVisible({ timeout: 15_000 });

    await notebooks
      .notebookCardOverflowMenuButton(
        notebooks.notebookCardByDisplayedName(renamedName),
      )
      .click();
    await notebooks.deleteNotebookOverflowMenuItem().click();
    const confirmDelete =
      notebooks.notebookDeleteConfirmationDialog(renamedName);
    await confirmDelete.confirmDeletion();
    await notebooks.expectNotebookCardAbsent(renamedName);
  });

  test("notebook tab: conversation, feedback, clipboard, and delete notebook", async () => {
    await notebooks.gotoFullscreenNotebooksTab();
    await notebooks.clickCreateNotebookFromEmptyList();
    await expect(page).toHaveURL(NOTEBOOK_EDITOR_URL_RE);

    const uploadedFile =
      await notebooks.uploadSingleDefaultDocumentForConversation();

    const prompt = `Tell me about ${uploadedFile} in one short sentence.`;
    const notebookInput = page.getByRole("textbox", {
      name: "Ask about your resources...",
    });
    await expect(notebookInput).toBeEnabled({ timeout: 120_000 });
    await notebookInput.fill(prompt);
    await page.getByRole("button", { name: "Send" }).click();

    await page.locator(".pf-chatbot__message-loading").waitFor({
      state: "hidden",
      timeout: 180_000,
    });

    const region = notebooks.chatbotRegion();
    const userMessage = region.locator(".pf-chatbot__message--user").last();
    const botMessage = region.locator(".pf-chatbot__message--bot").last();

    await expect(userMessage).toContainText(prompt);
    await expect(botMessage).toBeVisible();
    await expect(
      botMessage.locator(".pf-chatbot__message-response"),
    ).not.toBeEmpty();

    await verifyFeedbackButtons(page);
    // eslint-disable-next-line playwright/no-wait-for-timeout
    await page.waitForTimeout(500);
    await submitFeedback(page, "Good Response");
    await submitFeedback(page, "Bad Response");
    await assertLastBotResponseCopiedToClipboard(page);

    await notebooks.clickCloseNotebookEditor();
    const untitledCountBeforeDelete = await notebooks
      .untitledNotebookCards()
      .count();

    const cardCreatedThisTest = notebooks.newestUntitledNotebookCard();
    await notebooks.notebookCardOverflowMenuButton(cardCreatedThisTest).click();
    await notebooks.deleteNotebookOverflowMenuItem().click();

    const confirmDelete = notebooks.notebookDeleteConfirmationDialog(
      NOTEBOOK_UNTITLED_GRID_NAME,
    );
    await confirmDelete.expectDialogVisible();
    await confirmDelete.expectPermanentDeletionWarningText();
    await confirmDelete.confirmDeletion();

    await notebooks.expectUntitledNotebookCardCount(
      Math.max(0, untitledCountBeforeDelete - 1),
    );
  });
});
