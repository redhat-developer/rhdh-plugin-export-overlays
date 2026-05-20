import type { Locator, Page } from "@playwright/test";
import {
  BULK_IMPORT_ACCORDION_LABEL,
  LOGIN_REQUIRED_DIALOG_NAME,
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
