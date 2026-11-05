import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { $, WorkspacePaths } from "@red-hat-developer-hub/e2e-test-utils/utils";

import {
  MailpitApiHelper,
  type MailpitMessage,
} from "../../support/api/mailpit-api-helper";
import { createNotification } from "../../support/api/notifications-helper";
import {
  applyMailpitTlsSecret,
  applyOpensslConfigMap,
  deleteMailpitTls,
  generateMailpitTls,
} from "../../support/notifications/mailpit-pqc-tls";
import {
  CONFIG_DIR,
  RECIPIENT_EMAIL,
  SENDER_EMAIL,
  mailpitSmtpHost,
} from "../config/notifications-email-pqc/fixture";

/**
 * Force OpenSSL Groups=X25519MLKEM768 on the hub and require SMTP STARTTLS to
 * Mailpit. Mailpit v1.30 uses Go 1.25 TLS, which can offer that hybrid group.
 * The assertion is behavioral: the broadcast message arrives. It does not
 * parse a handshake log.
 */
test.describe("Notifications email PQC (forced ML-KEM)", () => {
  let mailpitApi: MailpitApiHelper;

  test.beforeAll(async ({ rhdh }) => {
    test.setTimeout(600_000);

    const namespace = rhdh.deploymentConfig.namespace;
    const configBase = WorkspacePaths.resolve(CONFIG_DIR);

    await test.runOnce(
      `notifications-email-pqc-setup-${namespace}`,
      async () => {
        await rhdh.k8sClient.createNamespaceIfNotExists(namespace);

        const hostname = mailpitSmtpHost(namespace);
        const material = await generateMailpitTls(hostname);
        try {
          await applyMailpitTlsSecret(namespace, material);
          await applyOpensslConfigMap(namespace, material.caCertPath);
        } finally {
          await deleteMailpitTls(material);
        }

        process.env.MAILPIT_SMTP_HOST = hostname;

        await $`kubectl apply -f ${configBase}/mailpit.yaml -n ${namespace}`;
        await $`kubectl apply -f ${configBase}/mailpit-route.yaml -n ${namespace}`;

        await rhdh.configure({
          auth: "guest",
          appConfig: `${CONFIG_DIR}/app-config-rhdh.yaml`,
          dynamicPlugins: `${CONFIG_DIR}/dynamic-plugins.yaml`,
          secrets: `${CONFIG_DIR}/rhdh-secrets.yaml`,
          valueFile: `${CONFIG_DIR}/values.yaml`,
          subscription: `${CONFIG_DIR}/subscription.yaml`,
        });
        await rhdh.deploy();
      },
    );

    const mailpitApiUrl = await rhdh.k8sClient.getRouteLocation(
      namespace,
      "mailpit",
    );
    mailpitApi = new MailpitApiHelper(mailpitApiUrl);
    await mailpitApi.waitUntilReady();
  });

  test.afterAll(async () => {
    await mailpitApi?.dispose();
  });

  test("broadcast email is delivered over SMTP STARTTLS when ML-KEM is forced", async () => {
    const title = await createNotification("Email PQC forced ML-KEM", {
      type: "broadcast",
    });

    const messages = await mailpitApi.waitForMessages(
      `to:${RECIPIENT_EMAIL} subject:${title}`,
      { expectedCount: 1 },
    );

    expect(messages).toHaveLength(1);
    assertSender(messages);
  });
});

function assertSender(messages: MailpitMessage[]): void {
  for (const message of messages) {
    expect(message.From.Address).toBe(SENDER_EMAIL);
  }
}
