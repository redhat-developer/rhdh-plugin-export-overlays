import {
  expect,
  type Locator,
  Page,
} from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  LoginHelper,
  UIhelper,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";
import {
  BULK_IMPORT_HEADING,
  BULK_IMPORT_ROUTE,
  GITHUB_PROVIDER_LABEL,
  REPO_STATUS_READY_TO_IMPORT,
  WORKFLOW_STATUS_LABELS,
} from "../constants/bulk-import-selectors";
import { dismissBulkImportLoginDialogIfPresent } from "../utils/auth";
import { waitForMuiProgressHidden } from "../utils/wait";
import {
  addRepositoryImportButton,
  bulkImportImportHistoryPath,
  importAccordionButton,
  repoRowCheckbox,
  repositoriesArticle,
  resolvePreviewSaveButton,
  importHistoryRepoUrlCandidates,
  repoRow,
  viewWorkflowLink,
  viewWorkflowLinkInRepoRow,
} from "./bulk-import-obj";

export class BulkImportPO {
  constructor(
    private readonly page: Page,
    private readonly uiHelper: UIhelper,
    private readonly loginHelper?: LoginHelper,
  ) {}

  async verifyHeading(): Promise<void> {
    await this.uiHelper.verifyHeading(BULK_IMPORT_HEADING);
  }

  async ensureAccordionOpen(): Promise<void> {
    const btn = importAccordionButton(this.page);
    // Orchestrator mode uses a flat "Selected repositories" layout — no accordion.
    if (!(await btn.isVisible().catch(() => false))) {
      return;
    }
    if ((await btn.getAttribute("aria-expanded")) !== "true") {
      await btn.click();
      await expect(btn).toHaveAttribute("aria-expanded", "true");
    }
  }

  async reloadAndWait(): Promise<void> {
    await this.page.reload();
    await waitForMuiProgressHidden(this.page);
    await this.ensureAccordionOpen();
  }

  async toggleAccordionClosed(): Promise<void> {
    await importAccordionButton(this.page).click();
    await expect(importAccordionButton(this.page)).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  }

  async expectAccordionExpanded(expanded: boolean): Promise<void> {
    await expect(importAccordionButton(this.page)).toHaveAttribute(
      "aria-expanded",
      expanded ? "true" : "false",
    );
  }

  async checkRepoRowCheckbox(repoName: string): Promise<void> {
    await repoRowCheckbox(this.page, repoName).check();
  }

  async searchAndExpectRow(repoName: string, cells: string[]): Promise<void> {
    await this.uiHelper.searchInputPlaceholder(repoName);
    await this.uiHelper.verifyRowInTableByUniqueText(repoName, cells);
  }

  async clickPreviewFileLink(repoName: string): Promise<void> {
    await this.uiHelper.clickOnLinkInTableByUniqueText(
      repoName,
      "Preview file",
    );
  }

  async savePreview(): Promise<Locator> {
    const save = await resolvePreviewSaveButton(this.page);
    await expect(save).toBeVisible({ timeout: 30_000 });
    await save.evaluate(
      (el: { scrollIntoView: (opts?: object) => void; click: () => void }) => {
        el.scrollIntoView({ block: "center", inline: "nearest" });
        el.click();
      },
    );
    return save;
  }

  async assertRepoAbsent(repoName: string): Promise<void> {
    if (!this.loginHelper) {
      throw new Error(
        "BulkImportPO.assertRepoAbsent requires loginHelper in constructor",
      );
    }
    await waitForMuiProgressHidden(this.page);
    await this.ensureAccordionOpen();
    await dismissBulkImportLoginDialogIfPresent(this.page, this.loginHelper);

    await this.uiHelper.searchInputPlaceholder(repoName);
    await expect(
      this.page.locator(`tr:has(:text-is("${repoName}"))`),
    ).toHaveCount(0, { timeout: 30_000 });

    const addedHeading = this.page.getByText(/Added repositories/i).first();
    if (await addedHeading.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await addedHeading.scrollIntoViewIfNeeded();
      await this.uiHelper.searchInputPlaceholder(repoName);
      await expect(
        this.page.locator(`tr:has(:text-is("${repoName}"))`),
      ).toHaveCount(0, { timeout: 15_000 });
    }
  }

  async expectGithubProviderChecked(): Promise<void> {
    await expect(
      this.page.getByRole("radio", { name: GITHUB_PROVIDER_LABEL }),
    ).toBeChecked();
  }

  async selectGithubProvider(): Promise<void> {
    await this.page.getByRole("radio", { name: GITHUB_PROVIDER_LABEL }).check();
  }

  async expectOrchestratorSelectedReposEmpty(): Promise<void> {
    await expect(
      this.page.locator("text=Selected repositories (0)"),
    ).toBeVisible();
  }

  /** Repositories table layout: headers, select-all, Import, and Cancel. */
  async expectRepositoriesTableColumns(): Promise<void> {
    const article = repositoriesArticle(this.page);
    await expect(article).toBeVisible();
    await expect(article.getByRole("table")).toBeVisible();
    for (const name of ["Name", "URL", "Organization", "Status"]) {
      await expect(article.getByRole("columnheader", { name })).toBeVisible();
    }
    await expect(
      article.getByRole("checkbox", { name: "select all repositories" }),
    ).toBeVisible();

    const importButton = addRepositoryImportButton(this.page);
    await expect(importButton).toBeVisible();
    await expect(importButton).toBeDisabled();

    await expect(article.getByRole("link", { name: "Cancel" })).toBeVisible();
  }

  async clickAddRepositoryImport(): Promise<void> {
    const importButton = addRepositoryImportButton(this.page);
    await expect(importButton).toBeEnabled({ timeout: 10_000 });
    await importButton.click();
  }

  /** Wait for the footer Import control to finish submitting (no full page reload). */
  async clickAddRepositoryImportAndWaitForSubmit(): Promise<void> {
    const importButton = addRepositoryImportButton(this.page);
    await expect(importButton).toBeEnabled({ timeout: 10_000 });
    await importButton.click();
    await expect(importButton)
      .toBeDisabled({ timeout: 5_000 })
      .catch(() => undefined);
  }

  /** Navigate to add-repositories UI (fresh mount — avoids `page.reload()`). */
  async gotoBulkImportAddPage(): Promise<void> {
    await this.page.goto(BULK_IMPORT_ROUTE);
    await this.uiHelper.waitForLoad(12_000);
    await this.ensureAccordionOpen();
    if (this.loginHelper) {
      await dismissBulkImportLoginDialogIfPresent(this.page, this.loginHelper);
    }
  }

  /** Close a secondary tab (e.g. orchestrator popup); no-op for same-tab navigation. */
  async closePageIfNotPrimary(targetPage: Page): Promise<void> {
    if (targetPage !== this.page) {
      await targetPage.close();
    }
  }

  /**
   * Import history lists orchestrator workflows; open instance and return target page.
   * PR_URL on the instance page confirms the workflow was triggered.
   */
  async openImportHistoryVerifyWorkflowAndOpenInstance(
    repoUrl: string,
    options: { timeout?: number; intervals?: number[] } = {},
  ): Promise<Page> {
    const timeout = options.timeout ?? 120_000;
    const intervals = options.intervals ?? [5_000, 10_000, 15_000];
    const historyRepoUrls = importHistoryRepoUrlCandidates(repoUrl);

    let link: Locator = viewWorkflowLink(this.page).first();

    await expect(async () => {
      let found = false;
      for (const url of historyRepoUrls) {
        await this.page.goto(bulkImportImportHistoryPath(url));
        await this.uiHelper.waitForLoad(12_000);
        const historyLink = viewWorkflowLink(this.page).first();
        try {
          await expect(historyLink).toBeVisible({ timeout: 15_000 });
          link = historyLink;
          found = true;
          break;
        } catch {
          /* try next URL candidate */
        }
      }
      expect(found).toBe(true);
    }).toPass({ intervals, timeout });

    const popupWait = this.page.waitForEvent("popup", { timeout: 8_000 });
    await link.click();
    const popup = await popupWait.catch(() => null);
    if (popup) {
      await popup.waitForLoadState();
      return popup;
    }
    await this.page.waitForLoadState();
    return this.page;
  }

  /**
   * Return to bulk import, re-search repo, assert workflow UI on the row
   * (importAction refetch — same effect as reload without `page.reload()`).
   */
  async expectRepoRowShowsWorkflowAfterImport(
    repoName: string,
    options: { timeout?: number; intervals?: number[] } = {},
  ): Promise<void> {
    const timeout = options.timeout ?? 120_000;
    const intervals = options.intervals ?? [5_000, 10_000, 15_000];
    const row = repoRow(this.page, repoName);

    await expect(async () => {
      await this.gotoBulkImportAddPage();
      await this.searchAndExpectRow(repoName, []);
      await expect(viewWorkflowLinkInRepoRow(this.page, repoName)).toBeVisible({
        timeout: 30_000,
      });
      await expect(row.getByText(REPO_STATUS_READY_TO_IMPORT)).toHaveCount(0);
      const workflowStatus = row.getByText(
        new RegExp(WORKFLOW_STATUS_LABELS.join("|")),
      );
      await expect(workflowStatus.first()).toBeVisible({ timeout: 5_000 });
    }).toPass({ intervals, timeout });
  }

  /** Opens a link in a popup when present; otherwise same-tab navigation. */
  async clickLinkOpensTargetPage(name: string | RegExp): Promise<Page> {
    const link = this.page.getByRole("link", { name });
    await expect(link).toBeVisible({ timeout: 10_000 });

    const popupWait = this.page.waitForEvent("popup", { timeout: 8_000 });
    await link.click();
    const popup = await popupWait.catch(() => null);
    if (popup) {
      await popup.waitForLoadState();
      return popup;
    }
    await this.page.waitForLoadState();
    return this.page;
  }

  /** Poll until repo row shows expected status cells (e.g. Ready to import). */
  async pollUntilRepoRowVisible(
    repoName: string,
    cells: string[] = [REPO_STATUS_READY_TO_IMPORT],
    options: { timeout?: number; intervals?: number[] } = {},
  ): Promise<void> {
    await expect(async () => {
      await this.reloadAndWait();
      await this.searchAndExpectRow(repoName, cells);
    }).toPass({
      intervals: options.intervals ?? [5_000, 10_000, 15_000],
      timeout: options.timeout ?? 120_000,
    });
  }
}
