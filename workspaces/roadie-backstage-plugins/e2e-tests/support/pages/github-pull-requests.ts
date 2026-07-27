import type { Page } from "@playwright/test";
import { expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import type { UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { TABLE_SELECTORS } from "../constants/github-pull-requests";
import type { GitHubPR } from "../api/github-pull-requests";

export class PullRequestsPage {
  constructor(
    private readonly page: Page,
    private readonly uiHelper: UIhelper,
  ) {}

  async verifyPRRows(
    prs: GitHubPR[],
    startRow: number,
    endRow: number,
  ): Promise<void> {
    for (let i = startRow; i < endRow; i++) {
      await this.uiHelper.verifyRowsInTable([prs[i].title], false);
    }
  }

  async selectRowsPerPage(rows: number): Promise<void> {
    await this.page.locator(TABLE_SELECTORS.pageSelectBox).click();
    await this.page
      .locator(`ul[role="listbox"] li[data-value="${rows}"]`)
      .click();
  }

  async verifyPRRowsPerPage(rows: number, allPRs: GitHubPR[]): Promise<void> {
    await this.selectRowsPerPage(rows);
    await this.uiHelper.waitForLoad();

    await this.uiHelper.verifyText(allPRs[rows - 1].title, false);
    await this.uiHelper.verifyLink(allPRs[rows].number.toString(), {
      exact: false,
      notVisible: true,
    });

    const tableRows = this.page.locator(TABLE_SELECTORS.rows);
    await expect(tableRows).toHaveCount(rows);
  }
}
