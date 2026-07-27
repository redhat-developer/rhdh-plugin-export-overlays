import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import type { BrowserContext, Page } from "@playwright/test";
import { LoginHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import {
  NotebookSurfacePage,
  NOTEBOOK_UNTITLED_GRID_NAME,
} from "../support/notebook-surface-page";
import {
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

  test("upload modal: drop zone, disabled add, and duplicate file prompt", async () => {
    const { absolutePath, fileName } = localeNotebookUploadPath();

    await notebooks.clickOpenUploadDocumentModal();
    let uploadModal = notebooks.uploadDocumentModal();

    await uploadModal.expectUploadAreaFullyDescribed();
    await uploadModal.expectModalTitleBarMatchesAriaSnapshot();
    await uploadModal.expectAddFilesButtonDisabled(0);

    await uploadModal.selectFilesViaBrowsePicker([absolutePath]);
    await uploadModal.expectStagedFileCountCaptionVisible(
      1,
      NOTEBOOK_SESSION_MAX_DOCUMENTS,
    );
    await uploadModal.clickAddFilesForStagedCount(1);
    await expect(uploadModal.dialog()).toBeHidden();
    await notebooks.expectDocumentUploadCompletes(fileName);

    await notebooks.clickOpenUploadDocumentModal();
    uploadModal = notebooks.uploadDocumentModal();
    await uploadModal.selectFilesViaBrowsePicker([absolutePath]);

    const overwriteModal = notebooks.notebookOverwriteConfirmModal();
    await overwriteModal.expectDialogVisible();
    await overwriteModal.expectListedOverwriteFile(fileName);
    await overwriteModal.clickCancel();
    await expect(overwriteModal.dialog()).toBeHidden();
    await expect(uploadModal.dialog()).toBeVisible();
    await uploadModal.clickCancel();

    await notebooks.deleteFirstListedDocumentFromSidebarOverflowMenu();
    await notebooks.expectNotebookEditorUploadResourceButtonVisible();
  });

  test("document sidebar: collapse and expand", async () => {
    await notebooks.collapseThenExpandDocumentSidebar();
  });

  test("sidebar: add file then remove", async () => {
    const { absolutePath, fileName } =
      localeNotebookUploadPath("en.upload2.json");

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

  test("upload modal: eleven files rejected at cap", async () => {
    await notebooks.clickOpenUploadDocumentModal();
    const uploadModal = notebooks.uploadDocumentModal();
    await uploadModal.selectFilesViaBrowsePicker(
      notebookElevenFileStagingPaths(),
    );
    await expect(uploadModal.dialog().getByRole("alert")).toContainText(
      `Upload error: Maximum of ${NOTEBOOK_SESSION_MAX_DOCUMENTS} files allowed.`,
    );
    await uploadModal.clickCancel();
  });

  test("upload modal: unsupported extension rejected", async () => {
    await notebooks.clickOpenUploadDocumentModal();
    const uploadModal = notebooks.uploadDocumentModal();
    await uploadModal.selectFilesViaBrowsePicker([
      notebookUnsupportedTypeFixturePath(),
    ]);
    await expect(uploadModal.dialog().getByRole("alert")).toContainText(
      "Upload error: Unsupported file type(s) found. Please upload only supported file types.",
    );
    await uploadModal.clickCancel();
  });

  test("grid: close editor, rename, delete", async () => {
    const untitledBefore = await notebooks.untitledNotebookCards().count();

    await notebooks.clickCloseNotebookEditor();
    await notebooks.expectUntitledNotebookCardCount(untitledBefore + 1);
    await expect(notebooks.newestUntitledNotebookCard()).toBeVisible();

    await notebooks.expectNotebookListShowsDocumentCountSummaryAndUpdatedToday(
      0,
    );

    await notebooks
      .notebookCardOverflowMenuButton(notebooks.newestUntitledNotebookCard())
      .click();
    await notebooks.renameNotebookOverflowMenuItem().click();

    const renameModal = notebooks.renameNotebookDialog(
      NOTEBOOK_UNTITLED_GRID_NAME,
    );
    await renameModal.expectDialogVisible();
    await renameModal.enterNewDisplayedNameAndSubmit(RENAMED_NOTEBOOK_TITLE);

    await expect(page.getByText(RENAMED_NOTEBOOK_TITLE)).toBeVisible();

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
    await expect(page.getByText(RENAMED_NOTEBOOK_TITLE)).toBeHidden();
  });

  test("notebook tab: conversation, feedback, clipboard, and delete notebook", async () => {
    await notebooks.gotoFullscreenNotebooksTab();
    await notebooks.clickCreateNotebookFromEmptyList();
    await expect(page).toHaveURL(NOTEBOOK_EDITOR_URL_RE);

    const uploadedFile =
      await notebooks.uploadSingleDefaultDocumentForConversation();

    const prompt = `Tell me about ${uploadedFile} in one short sentence.`;
    const notebookInput = page.getByRole("textbox", {
      name: "Ask about your documents...",
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
    await page.waitForTimeout(2000);
    await submitFeedback(page, "Good response");
    await submitFeedback(page, "Bad response");
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
