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
    await this.uiHelper.verifyHeading("Notifications");
    await this.uiHelper.waitForLoad();
  }

  async notificationContains(text: string | RegExp) {
    await this.page.getByLabel("rows").click();
    // always expand the notifications table to show as many notifications as possible
    await this.page.getByRole("option", { name: "20" }).click();
    await this.uiHelper.waitForLoad();
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
    await this.uiHelper.waitForLoad();
  }

  async saveSelected() {
    await this.page
      .locator("thead")
      .getByTitle("Save selected for later")
      .getByRole("button")
      .click();
    await this.uiHelper.waitForLoad();
  }

  async viewSaved() {
    await this.page.getByLabel("View").click();
    await this.page.getByRole("option", { name: "Saved" }).click();
    await this.uiHelper.waitForLoad();
  }

  async markNotificationAsRead(text: string) {
    await this.toggleRead("unread", text);
  }

  async markLastNotificationAsUnRead() {
    await this.toggleRead("read");
  }

  async viewRead() {
    await this.page.getByLabel("View").click();
    await this.page
      .getByRole("option", { name: "Read notifications", exact: true })
      .click();
    await this.uiHelper.waitForLoad();
  }

  async viewUnRead() {
    await this.page.getByLabel("View").click();
    await this.page
      .getByRole("option", { name: "Unread notifications", exact: true })
      .click();
    await this.uiHelper.waitForLoad();
  }

  private async toggleRead(currentState: "read" | "unread", text?: string) {
    const rows = this.page.getByRole("row").filter({ hasText: "Notification" });
    const count = await rows.count();

    const row = text ? rows.filter({ hasText: text }) : rows.first();
    await row.getByRole("button").nth(1).click();

    if (
      await this.page.getByText(`${currentState} notifications (`).isVisible()
    ) {
      await expect(rows).toHaveCount(count - 1);
    }
  }
}
