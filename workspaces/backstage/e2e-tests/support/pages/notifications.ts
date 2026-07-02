import { expect, type Page } from "@red-hat-developer-hub/e2e-test-utils/test";
import { type UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { waitForAppReady } from "../utils/wait-for-app-ready";

export class NotificationPage {
  private readonly page: Page;
  private readonly uiHelper: UIhelper;

  constructor(page: Page, uiHelper: UIhelper) {
    this.page = page;
    this.uiHelper = uiHelper;
  }

  async clickNotificationsNavBarItem() {
    await this.dismissNotificationToasts();
    await expect(async () => {
      await this.page.goto("/notifications");
      await waitForAppReady(this.page, this.uiHelper);
      await expect(this.page).toHaveURL(/\/notifications/);
      await this.uiHelper.verifyHeading("Notifications", 30_000);
    }).toPass({ timeout: 60_000, intervals: [2_000] });
  }

  async notificationContains(text: string | RegExp) {
    await this.dismissNotificationToasts();
    const row = this.notificationRows().filter({ hasText: text }).first();
    if (!(await row.isVisible())) {
      await this.setRowsPerPage(20);
    }
    await expect(row).toBeVisible();
  }

  async selectNotification(text?: string) {
    await this.dismissNotificationToasts();
    let row = text
      ? this.notificationRows().filter({ hasText: text }).first()
      : this.notificationRows().first();
    if (text && !(await row.isVisible())) {
      await this.setRowsPerPage(20);
      row = this.notificationRows().filter({ hasText: text }).first();
    }
    const checkbox = row.getByRole("checkbox", {
      name: "Select notification",
    });
    await checkbox.check({ force: true });
  }

  async selectSeverity(severity = "") {
    await this.page.getByLabel("Min severity").click();
    await this.page.getByRole("option", { name: severity }).click();
    await expect(
      this.page.getByRole("table").filter({ hasText: "Rows per page" }),
    ).toBeVisible();
    await waitForAppReady(this.page, this.uiHelper, 30_000);
  }

  async saveSelected() {
    // Header BulkActions: use aria-label on the real <button>, not the draggable wrapper.
    await this.page
      .locator('thead button[aria-label="Save selected for later"]')
      .click();
    await waitForAppReady(this.page, this.uiHelper, 30_000);
  }

  async viewSaved() {
    await this.page.getByLabel("View").click();
    await this.page.getByRole("option", { name: "Saved" }).click();
    await waitForAppReady(this.page, this.uiHelper, 30_000);
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
    await waitForAppReady(this.page, this.uiHelper, 30_000);
  }

  async viewUnRead() {
    await this.page.getByLabel("View").click();
    await this.page
      .getByRole("option", { name: "Unread notifications", exact: true })
      .click();
    await waitForAppReady(this.page, this.uiHelper, 30_000);
  }

  private notificationRows() {
    return this.page.getByRole("row").filter({
      has: this.page.getByRole("checkbox", { name: "Select notification" }),
    });
  }

  /** Broadcast toasts from parallel filter tests can block table interactions. */
  private async dismissNotificationToasts() {
    const toasts = this.page.locator(
      "#notistack-snackbar, .notistack-CollapseWrapper",
    );
    if (
      await toasts
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      await expect(toasts.first()).toBeHidden({ timeout: 15_000 });
    }
  }

  private async setRowsPerPage(size: number) {
    await this.dismissNotificationToasts();
    await this.page
      .getByRole("button", { name: /rows per page/i })
      .click({ force: true });
    await this.page.getByRole("option", { name: String(size) }).click();
    await waitForAppReady(this.page, this.uiHelper, 30_000);
  }

  private async toggleRead(currentState: "read" | "unread", text?: string) {
    await this.dismissNotificationToasts();
    const rows = this.notificationRows();
    const count = await rows.count();

    const row = text ? rows.filter({ hasText: text }) : rows.first();
    const readButtonName =
      currentState === "unread"
        ? /Mark selected as read/i
        : /Return selected among unread/i;
    await row.getByRole("button", { name: readButtonName }).click();
    await waitForAppReady(this.page, this.uiHelper, 30_000);

    const viewPattern =
      currentState === "unread"
        ? /Unread notifications \(/
        : /Read notifications \(/;
    if (await this.page.getByText(viewPattern).isVisible()) {
      await expect(async () => {
        await expect(rows).toHaveCount(count - 1);
      }).toPass({ timeout: 15_000, intervals: [1_000] });
    }
  }
}
