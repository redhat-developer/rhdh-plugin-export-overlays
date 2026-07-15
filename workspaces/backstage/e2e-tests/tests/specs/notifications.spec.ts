import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  type NotificationRequest,
  type NotificationSeverity,
  RhdhNotificationsApi,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { NotificationPage } from "@red-hat-developer-hub/e2e-test-utils/pages";
import * as path from "node:path";

async function createNotification(
  notificationTitle: string,
  severity?: string,
) {
  const apiToken = "test-token";
  const r = crypto.randomUUID();
  const notificationsApi = await RhdhNotificationsApi.build(apiToken);
  const title = severity
    ? `${notificationTitle} ${severity}-${r}`
    : `${notificationTitle}-${r}`;
  const apiSeverity = (
    severity ?? "normal"
  ).toLowerCase() as NotificationSeverity;

  const notification: NotificationRequest = {
    recipients: { type: "broadcast" },
    payload: {
      title,
      description: `Test ${title}`,
      severity: apiSeverity,
      topic: `Testing ${title}`,
    },
  };
  const response = await notificationsApi.createNotification(notification);
  expect(
    response.ok(),
    `create notification failed (${response.status()}): ${await response.text()}`,
  ).toBeTruthy();
  return title;
}

test.describe("Backstage Notifications Plugin", () => {
  let notificationPage: NotificationPage;

  test.beforeAll(async ({ rhdh }) => {
    const configBase = path.resolve(
      process.cwd(),
      "tests/config/notifications/",
    );
    await rhdh.configure({
      valueFile: `${configBase}/value-file.yaml`,
      dynamicPlugins: `${configBase}/dynamic-plugins.yaml`,
      auth: "keycloak",
    });
    await rhdh.deploy();
  });

  test.beforeEach(async ({ page, uiHelper, loginHelper }) => {
    notificationPage = new NotificationPage(page, uiHelper);
    await loginHelper.loginAsKeycloakUser();
  });

  test.describe("Filter notifications", () => {
    const severities = ["Critical", "High", "Normal", "Low"];
    const notificationTitle = "UI Notification By Severity";

    for (const severity of severities) {
      test(`Filter notifications by severity - ${severity}`, async () => {
        const notificationId = await createNotification(
          notificationTitle,
          severity,
        );
        await notificationPage.navigateToNotifications();
        await notificationPage.selectSeverity(severity);
        await notificationPage.notificationContains(notificationId);
      });
    }
  });

  test.describe("Mark notification tests", () => {
    test("Mark notification as read", async () => {
      const notificationId = await createNotification(
        "UI Notification Mark as read",
      );
      await notificationPage.navigateToNotifications();
      await notificationPage.notificationContains(`${notificationId}`);
      await notificationPage.markNotificationAsRead(`${notificationId}`);
      await notificationPage.viewRead();
      await notificationPage.notificationContains(
        new RegExp(`${notificationId}.*(a few seconds ago)|(a minute ago)`),
      );
    });

    test("Mark notification as unread", async () => {
      const notificationId = await createNotification(
        "UI Notification Mark as unread",
      );
      await notificationPage.navigateToNotifications();
      await notificationPage.notificationContains(`${notificationId}`);
      await notificationPage.markNotificationAsRead(`${notificationId}`);
      await notificationPage.viewRead();
      await notificationPage.notificationContains(
        new RegExp(`${notificationId}.*(a few seconds ago)|(a minute ago)`),
      );
      await notificationPage.markLastNotificationAsUnRead();
      await notificationPage.viewUnRead();
      await notificationPage.notificationContains(
        new RegExp(`${notificationId}.*(a few seconds ago)|(a minute ago)`),
      );
    });

    test("Mark notification as saved", async () => {
      const notificationId = await createNotification(
        "UI Notification Mark as saved",
      );
      await notificationPage.navigateToNotifications();
      await notificationPage.notificationContains(`${notificationId}`);
      await notificationPage.selectNotification(notificationId);
      await notificationPage.saveSelected();
      await notificationPage.viewSaved();
      await notificationPage.notificationContains(
        new RegExp(`${notificationId}.*(a few seconds ago)|(a minute ago)`),
      );
    });
  });
});
