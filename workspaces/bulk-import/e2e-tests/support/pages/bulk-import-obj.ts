import type { Locator, Page } from "@playwright/test";
import {
  ADD_REPOSITORY_FOOTER_TEST_ID,
  BULK_IMPORT_ACCORDION_LABEL,
  LOGIN_REQUIRED_DIALOG_NAME,
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

/** "View workflow" in repo row Status after orchestrator import. */
export function viewWorkflowLinkInRepoRow(
  page: Page,
  repoName: string,
): Locator {
  const row = repoRow(page, repoName);
  return row
    .getByTestId(VIEW_WORKFLOW_LINK_TEST_ID)
    .or(row.locator('a[href*="/orchestrator/instances/"]'));
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
