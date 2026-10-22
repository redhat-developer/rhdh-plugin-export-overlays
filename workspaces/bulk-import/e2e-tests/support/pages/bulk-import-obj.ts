import type { Locator, Page } from "@playwright/test";
import {
  ADD_REPOSITORY_FOOTER_TEST_ID,
  BULK_IMPORT_ACCORDION_LABEL,
  LOGIN_REQUIRED_DIALOG_NAME,
  VIEW_WORKFLOW_LINK_LABEL,
  VIEW_WORKFLOW_LINK_TEST_ID,
} from "../constants/bulk-import-selectors";

export function repoRow(page: Page, repoName: string): Locator {
  return page.locator(`tr:has(:text-is("${repoName}"))`);
}

export function repoRowCheckbox(page: Page, repoName: string): Locator {
  return repoRow(page, repoName).getByRole("checkbox");
}

export function importAccordionButton(page: Page): Locator {
  return page.getByRole("button", { name: BULK_IMPORT_ACCORDION_LABEL });
}

export function loginRequiredDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: LOGIN_REQUIRED_DIALOG_NAME });
}

export function repositoriesArticle(page: Page): Locator {
  return page.getByRole("article");
}

/** Table footer Import — not the accordion summary (substring "Import" match). */
export function addRepositoryImportButton(page: Page): Locator {
  return page
    .getByTestId(ADD_REPOSITORY_FOOTER_TEST_ID)
    .getByRole("button", { name: "Import", exact: true });
}

function viewWorkflowLinkCandidates(scope: Page | Locator): Locator {
  return scope
    .getByTestId(VIEW_WORKFLOW_LINK_TEST_ID)
    .or(scope.getByRole("link", { name: VIEW_WORKFLOW_LINK_LABEL }));
}

/** Orchestrator mode: link in repo row Status after workflow is created. */
export function viewWorkflowLinkInRepoRow(
  page: Page,
  repoName: string,
): Locator {
  return viewWorkflowLinkCandidates(repoRow(page, repoName));
}

/** Import history table or repo row — test id when present, else link label. */
export function viewWorkflowLink(page: Page): Locator {
  return viewWorkflowLinkCandidates(page);
}

export function bulkImportImportHistoryPath(repoUrl: string): string {
  return `/bulk-import/import-history/${encodeURIComponent(repoUrl)}`;
}

/** Repo URL forms stored on import jobs / history routes. */
export function importHistoryRepoUrlCandidates(repoUrl: string): string[] {
  return repoUrl.startsWith("http")
    ? [repoUrl]
    : [`https://${repoUrl}`, repoUrl];
}

/** Dialog-scoped Save when preview is open; otherwise last Save on page. */
export async function resolvePreviewSaveButton(page: Page): Promise<Locator> {
  const dialogCount = await page.getByRole("dialog").count();
  if (dialogCount > 0) {
    return page
      .getByRole("dialog")
      .last()
      .getByRole("button", { name: "Save", exact: true });
  }
  return page.getByRole("button", { name: "Save", exact: true }).last();
}
