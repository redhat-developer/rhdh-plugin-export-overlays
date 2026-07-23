import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  CatalogApiHelper,
  type NotificationRecipients,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { $ } from "@red-hat-developer-hub/e2e-test-utils/utils";
import * as path from "node:path";
import {
  MailpitApiHelper,
  type MailpitMessage,
} from "../../support/api/mailpit-api-helper";
import {
  createNotification,
  NOTIFICATIONS_API_TOKEN,
} from "../../support/api/notifications-helper";
import { NotificationSettingsApiHelper } from "../../support/api/notification-settings-api-helper";

const SENDER_EMAIL = "backstage-e2e@example.com";
const TEST1_EMAIL = "test1@example.com";
const TEST2_EMAIL = "test2@example.com";
const TEST1_ENTITY = "user:default/test1";
const DEVELOPERS_GROUP = "group:default/developers";

function mailpitQuery(email: string, title: string): string {
  return `to:${email} subject:${title}`;
}

function assertSender(messages: MailpitMessage[]) {
  for (const message of messages) {
    expect(message.From.Address).toBe(SENDER_EMAIL);
  }
}

function parseEntityRef(entityRef: string): {
  kind: string;
  namespace: string;
  name: string;
} {
  const [kind, rest] = entityRef.split(":");
  const [namespace, name] = rest.split("/");

  return { kind, namespace, name };
}

async function waitForCatalogEntity(entityRef: string): Promise<void> {
  const { kind, namespace, name } = parseEntityRef(entityRef);
  const baseUrl = process.env.RHDH_BASE_URL?.replace(/\/$/, "");
  if (!baseUrl) {
    throw new Error(
      "RHDH_BASE_URL is not set — deploy RHDH before querying the catalog",
    );
  }

  await expect
    .poll(
      async () =>
        CatalogApiHelper.entityExists(
          baseUrl,
          NOTIFICATIONS_API_TOKEN,
          kind,
          name,
          namespace,
        ),
      {
        timeout: 120_000,
        message: `Timed out waiting for catalog entity ${entityRef}`,
      },
    )
    .toBe(true);
}

async function createNotificationWhenCatalogReady(
  notificationTitle: string,
  recipients: NotificationRecipients,
  severity?: string,
): Promise<string> {
  if (recipients.type === "entity") {
    const entityRefs = Array.isArray(recipients.entityRef)
      ? recipients.entityRef
      : [recipients.entityRef];

    for (const entityRef of entityRefs) {
      await waitForCatalogEntity(entityRef);
    }
  }

  return createNotification(notificationTitle, recipients, severity);
}

test.describe("Notifications email processor", () => {
  let mailpitApi: MailpitApiHelper;

  test.beforeAll(async ({ rhdh }) => {
    const namespace = rhdh.deploymentConfig.namespace;
    const configBase = path.resolve(
      process.cwd(),
      "tests/config/notifications-email/",
    );

    await test.runOnce("notifications-email-setup", async () => {
      await $`kubectl apply -f ${configBase}/mailpit.yaml -n ${namespace}`;
      await $`kubectl apply -f ${configBase}/mailpit-route.yaml -n ${namespace}`;

      process.env.MAILPIT_SMTP_HOST = `mailpit.${namespace}.svc.cluster.local`;
      process.env.MAILPIT_DENYLIST_EMAIL = TEST2_EMAIL;

      await rhdh.configure({
        valueFile: `${configBase}/value-file.yaml`,
        appConfig: `${configBase}/app-config-rhdh.yaml`,
        dynamicPlugins: `${configBase}/dynamic-plugins.yaml`,
        secrets: `${configBase}/rhdh-secrets.yaml`,
        auth: "keycloak",
      });
      await rhdh.deploy();
    });

    const mailpitApiUrl = await rhdh.k8sClient.getRouteLocation(
      namespace,
      "mailpit",
    );
    mailpitApi = new MailpitApiHelper(mailpitApiUrl);
    await mailpitApi.waitUntilReady();

    // Keycloak org sync: test1 and test2 belong to developers
    // (rhdh-e2e-test-utils DEFAULT_USERS / DEFAULT_GROUPS).
    await expect
      .poll(
        async () => {
          const members = await CatalogApiHelper.getGroupMembers(
            process.env.RHDH_BASE_URL!,
            NOTIFICATIONS_API_TOKEN,
            "developers",
          );

          return members.includes("test1") && members.includes("test2");
        },
        {
          timeout: 120_000,
          message:
            "Expected Keycloak-synced developers group to include test1 and test2",
        },
      )
      .toBe(true);
  });

  test.afterAll(async () => {
    await mailpitApi?.dispose();
    await CatalogApiHelper.dispose();
  });

  test("entity notification delivers email to the targeted user", async () => {
    const title = await createNotificationWhenCatalogReady(
      "Email entity notification",
      { type: "entity", entityRef: TEST1_ENTITY },
    );

    const messages = await mailpitApi.waitForMessages(
      mailpitQuery(TEST1_EMAIL, title),
      { expectedCount: 1 },
    );

    expect(messages).toHaveLength(1);
    assertSender(messages);
  });

  test("group notification fans out email to eligible group members", async () => {
    const title = await createNotificationWhenCatalogReady(
      "Email group notification",
      { type: "entity", entityRef: DEVELOPERS_GROUP },
    );

    const test1Messages = await mailpitApi.waitForMessages(
      mailpitQuery(TEST1_EMAIL, title),
      { expectedCount: 1 },
    );

    expect(test1Messages).toHaveLength(1);
    assertSender(test1Messages);

    await expect
      .poll(
        async () => mailpitApi.countMessages(mailpitQuery(TEST2_EMAIL, title)),
        {
          timeout: 15_000,
          message: `Expected denylisted group member ${TEST2_EMAIL} to receive no email`,
        },
      )
      .toBe(0);
  });

  test("broadcast notification delivers email to eligible users", async () => {
    const title = await createNotification("Email broadcast notification", {
      type: "broadcast",
    });

    const test1Messages = await mailpitApi.waitForMessages(
      mailpitQuery(TEST1_EMAIL, title),
      { expectedCount: 1 },
    );

    expect(test1Messages).toHaveLength(1);
    assertSender(test1Messages);
  });

  test("denylist prevents configured addresses from receiving broadcast email", async () => {
    const title = await createNotification("Email denylist broadcast", {
      type: "broadcast",
    });

    const allowedMessages = await mailpitApi.waitForMessages(
      mailpitQuery(TEST1_EMAIL, title),
      { expectedCount: 1 },
    );

    await expect
      .poll(
        async () => mailpitApi.countMessages(mailpitQuery(TEST2_EMAIL, title)),
        {
          timeout: 15_000,
          message: `Expected denylisted address ${TEST2_EMAIL} to receive no email`,
        },
      )
      .toBe(0);

    expect(allowedMessages).toHaveLength(1);
    assertSender(allowedMessages);
  });

  test("broadcast email ignores per-user email channel opt-out", async ({
    page,
    loginHelper,
  }) => {
    const settingsApi = new NotificationSettingsApiHelper(page);
    await loginHelper.loginAsKeycloakUser();
    await settingsApi.setEmailChannelEnabled(false);

    try {
      const entityTitle = await createNotificationWhenCatalogReady(
        "Email opt-out entity notification",
        { type: "entity", entityRef: TEST1_ENTITY },
      );

      await expect
        .poll(
          async () =>
            mailpitApi.countMessages(mailpitQuery(TEST1_EMAIL, entityTitle)),
          {
            timeout: 15_000,
            message:
              "Entity email should be suppressed when the channel is off",
          },
        )
        .toBe(0);

      const broadcastTitle = await createNotification(
        "Email opt-out broadcast notification",
        { type: "broadcast" },
      );

      const broadcastMessages = await mailpitApi.waitForMessages(
        mailpitQuery(TEST1_EMAIL, broadcastTitle),
        { expectedCount: 1 },
      );

      expect(broadcastMessages).toHaveLength(1);
      assertSender(broadcastMessages);
    } finally {
      await settingsApi.setEmailChannelEnabled(true);
    }

    const resumedTitle = await createNotificationWhenCatalogReady(
      "Email opt-out resumed entity notification",
      { type: "entity", entityRef: TEST1_ENTITY },
    );

    const resumedMessages = await mailpitApi.waitForMessages(
      mailpitQuery(TEST1_EMAIL, resumedTitle),
      { expectedCount: 1 },
    );

    expect(resumedMessages).toHaveLength(1);
    assertSender(resumedMessages);
  });
});
