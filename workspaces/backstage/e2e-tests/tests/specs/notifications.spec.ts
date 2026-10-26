import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  AuthApiHelper,
  CatalogApiHelper,
  LoginHelper,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { DEFAULT_USERS } from "@red-hat-developer-hub/e2e-test-utils/keycloak";
import { NotificationPage } from "@red-hat-developer-hub/e2e-test-utils/pages";
import * as path from "node:path";
import {
  createNotification,
  NOTIFICATIONS_API_TOKEN,
} from "../../support/api/notifications-helper";

interface NotificationListResponse {
  notifications: {
    id: string;
    user: string | null;
    payload: { title: string };
  }[];
}

const TEST1_USER = DEFAULT_USERS[0];
const TEST1_ENTITY = `user:default/${TEST1_USER.username}`;

function deployedBaseUrl(): string {
  const baseURL = process.env.RHDH_BASE_URL;
  if (!baseURL) {
    throw new Error("RHDH_BASE_URL is not set after deployment");
  }
  return baseURL;
}

test.describe("Backstage Notifications Plugin", () => {
  let notificationPage: NotificationPage;

  test.beforeAll(async ({ rhdh }) => {
    const configBase = path.resolve(
      process.cwd(),
      "tests/config/notifications/",
    );
    await rhdh.configure({
      appConfig: `${configBase}/app-config-rhdh.yaml`,
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
      await expect(async () => {
        await notificationPage.selectNotification(notificationId);
      }).toPass({ timeout: 3000 });
      await notificationPage.saveSelected();
      await notificationPage.viewSaved();
      await notificationPage.notificationContains(
        new RegExp(`${notificationId}.*(a few seconds ago)|(a minute ago)`),
      );
    });
  });

  test.describe("Backend delivery", () => {
    test.afterAll(async () => {
      await CatalogApiHelper.dispose();
    });

    test("entity notification is visible only to its recipient", async ({
      page,
      browser,
      request,
    }) => {
      test.setTimeout(240_000);

      const baseURL = deployedBaseUrl();

      await expect
        .poll(
          () =>
            CatalogApiHelper.entityExists(
              baseURL,
              NOTIFICATIONS_API_TOKEN,
              "user",
              TEST1_USER.username,
            ),
          {
            timeout: 120_000,
            message: `Timed out waiting for ${TEST1_ENTITY} in the catalog`,
          },
        )
        .toBe(true);

      const title = await createNotification("Backend entity delivery", {
        type: "entity",
        entityRef: TEST1_ENTITY,
      });
      const test1Token = await new AuthApiHelper(page).getToken();

      const test2Context = await browser.newContext({
        baseURL,
        ignoreHTTPSErrors: true,
      });

      try {
        const test2Page = await test2Context.newPage();
        await new LoginHelper(test2Page).loginAsKeycloakUser(
          DEFAULT_USERS[1].username,
          DEFAULT_USERS[1].password,
        );
        const test2Token = await new AuthApiHelper(test2Page).getToken();

        const listForUser = async (
          token: string,
        ): Promise<NotificationListResponse> => {
          const response = await request.get(
            "/api/notifications/notifications",
            {
              headers: { Authorization: `Bearer ${token}` },
              params: { search: title },
            },
          );
          expect(
            response.status(),
            `list notifications failed: ${await response.text()}`,
          ).toBe(200);
          return (await response.json()) as NotificationListResponse;
        };

        const test1List = await listForUser(test1Token);
        const test1Matches = test1List.notifications.filter(
          (notification) => notification.payload.title === title,
        );
        expect(test1Matches).toHaveLength(1);
        expect(test1Matches[0].user).toBe(TEST1_ENTITY);

        const test2List = await listForUser(test2Token);
        expect(
          test2List.notifications.filter(
            (notification) => notification.payload.title === title,
          ),
        ).toHaveLength(0);

        const detailUrl = `/api/notifications/notifications/${test1Matches[0].id}`;
        const test1Detail = await request.get(detailUrl, {
          headers: { Authorization: `Bearer ${test1Token}` },
        });
        expect(test1Detail.status()).toBe(200);
        expect(await test1Detail.json()).toMatchObject({
          id: test1Matches[0].id,
          user: TEST1_ENTITY,
          payload: { title },
        });

        const test2Detail = await request.get(detailUrl, {
          headers: { Authorization: `Bearer ${test2Token}` },
        });
        expect(test2Detail.status()).toBe(404);
      } finally {
        await test2Context.close();
      }
    });
  });
});
