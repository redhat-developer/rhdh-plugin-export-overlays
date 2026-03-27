import { expect, type Page } from "@red-hat-developer-hub/e2e-test-utils/test";
import { type UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";

export class NotificationPage {
  private readonly page: Page;
  private readonly uiHelper: UIhelper;

  constructor(page: Page, uiHelper: UIhelper) {
    this.page = page;
    this.uiHelper = uiHelper;
  }

  async clickNotificationsNavBarItem() {
    await this.uiHelper.openSidebar("Notifications");
    await expect(
      this.page.getByTestId("loading-indicator").getByRole("img"),
    ).toHaveCount(0);
  }

  async notificationContains(text: string | RegExp) {
    await this.page.getByLabel("rows").click();
    // always expand the notifications table to show as many notifications as possible
    await this.page.getByRole("option", { name: "20" }).click();
    await expect(
      this.page.getByTestId("loading-indicator").getByRole("img"),
    ).toHaveCount(0);
    const row = this.page.locator(`tr`, { hasText: text }).first();
    await expect(row).toHaveCount(1);
  }

  async selectNotification(nth = 1) {
    await this.page.getByRole("checkbox").nth(nth).click();
  }

  async selectSeverity(severity = "") {
    await this.page.getByLabel("Severity").click();
    await this.page.getByRole("option", { name: severity }).click();
    await expect(
      this.page.getByRole("table").filter({ hasText: "Rows per page" }),
    ).toBeVisible();
    await expect(
      this.page.getByTestId("loading-indicator").getByRole("img"),
    ).toHaveCount(0);
  }

  async saveSelected() {
    await this.page
      .locator("thead")
      .getByTitle("Save selected for later")
      .getByRole("button")
      .click();
    await expect(
      this.page.getByTestId("loading-indicator").getByRole("img"),
    ).toHaveCount(0);
  }

  async viewSaved() {
    await this.page.getByLabel("View").click();
    await this.page.getByRole("option", { name: "Saved" }).click();
    await expect(
      this.page.getByTestId("loading-indicator").getByRole("img"),
    ).toHaveCount(0);
  }

  async markNotificationAsRead(text: string) {
    const row = this.page.locator(`tr:has-text("${text}")`);
    await row.getByRole("button").nth(1).click();
  }

  async markLastNotificationAsUnRead() {
    const row = this.page.locator("td:nth-child(3) > div").first();
    await row.getByRole("button").nth(1).click();
  }

  async viewRead() {
    await this.page.getByLabel("View").click();
    await this.page
      .getByRole("option", { name: "Read notifications", exact: true })
      .click();
    await expect(
      this.page.getByTestId("loading-indicator").getByRole("img"),
    ).toHaveCount(0);
  }

  async viewUnRead() {
    await this.page.getByLabel("View").click();
    await this.page
      .getByRole("option", { name: "Unread notifications", exact: true })
      .click();
    await expect(
      this.page.getByTestId("loading-indicator").getByRole("img"),
    ).toHaveCount(0);
  }
}
