import { test } from "@red-hat-developer-hub/e2e-test-utils/test";
import * as path from "node:path";
import { NotificationPage } from "../../support/pages/notifications";
import {
  Notifications,
  RhdhNotificationsApi,
} from "../../support/api/notifications";

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

  const notification: Notifications = {
    recipients: {
      type: "broadcast",
      entityRef: [""],
    },
    payload: {
      title,
      description: `Test ${title}`,
      severity: severity || "Normal",
      topic: `Testing ${title}`,
    },
  };
  await notificationsApi.createNotification(notification);
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
        const notifiationId = await createNotification(
          notificationTitle,
          severity,
        );
        await notificationPage.clickNotificationsNavBarItem();
        await notificationPage.selectSeverity(severity);
        await notificationPage.notificationContains(notifiationId);
      });
    }
  });

  test.describe("Mark notification tests", () => {
    test("Mark notification as read", async () => {
      const notifiationId = await createNotification(
        "UI Notification Mark as read",
      );
      await notificationPage.clickNotificationsNavBarItem();
      await notificationPage.notificationContains(`${notifiationId}`);
      await notificationPage.markNotificationAsRead(`${notifiationId}`);
      await notificationPage.viewRead();
      await notificationPage.notificationContains(
        new RegExp(`${notifiationId}.*(a few seconds ago)|(a minute ago)`),
      );
    });

    test("Mark notification as unread", async () => {
      const notifiationId = await createNotification(
        "UI Notification Mark as unread",
      );
      await notificationPage.clickNotificationsNavBarItem();
      await notificationPage.notificationContains(`${notifiationId}`);
      await notificationPage.markNotificationAsRead(`${notifiationId}`);
      await notificationPage.viewRead();
      await notificationPage.notificationContains(
        new RegExp(`${notifiationId}.*(a few seconds ago)|(a minute ago)`),
      );
      await notificationPage.markLastNotificationAsUnRead();
      await notificationPage.viewUnRead();
      await notificationPage.notificationContains(
        new RegExp(`${notifiationId}.*(a few seconds ago)|(a minute ago)`),
      );
    });

    test("Mark notification as saved", async () => {
      const notifiationId = await createNotification(
        "UI Notification Mark as saved",
      );
      await notificationPage.clickNotificationsNavBarItem();
      await notificationPage.selectNotification();
      await notificationPage.saveSelected();
      await notificationPage.viewSaved();
      await notificationPage.notificationContains(
        new RegExp(`${notifiationId}.*(a few seconds ago)|(a minute ago)`),
      );
    });
  });
});
