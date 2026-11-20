import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { $, WorkspacePaths } from "@red-hat-developer-hub/e2e-test-utils/utils";

import {
  applyMailpitTlsSecret,
  deleteMailpitTls,
  generateMailpitTls,
} from "../../support/notifications/mailpit-pqc-tls";
import {
  type OpensslSClientResult,
  resolvedKeyExchangeGroup,
  runOpensslSClientFromRhdhPod,
} from "../../support/openssl/s-client";
import { TLS_GROUPS, type TlsGroup } from "../config/openssl-pqc/fixture";
import {
  CONFIG_DIR,
  MAILPIT_SMTP_PORT,
  mailpitSmtpHost,
} from "../config/notifications-email-pqc/fixture";

/**
 * SMTP STARTTLS from the hub pod to Mailpit, for the hybrid group and the
 * classical fallback. Mail delivery stays in the notifications-email project.
 */
test.describe("Notifications email PQC", () => {
  let namespace: string;

  test.beforeAll(async ({ rhdh }) => {
    test.setTimeout(600_000);

    namespace = rhdh.deploymentConfig.namespace;
    const configBase = WorkspacePaths.resolve(CONFIG_DIR);

    await test.runOnce(
      `notifications-email-pqc-setup-${namespace}`,
      async () => {
        await rhdh.k8sClient.createNamespaceIfNotExists(namespace);

        const hostname = mailpitSmtpHost(namespace);
        const material = await generateMailpitTls(hostname);
        try {
          await applyMailpitTlsSecret(namespace, material);
        } finally {
          await deleteMailpitTls(material);
        }

        await $`kubectl apply -f ${configBase}/mailpit.yaml -n ${namespace}`;
        await rhdh.configure({
          auth: "guest",
          dynamicPlugins: `${CONFIG_DIR}/dynamic-plugins.yaml`,
        });
        await rhdh.deploy();
      },
    );

    await rhdh.k8sClient.waitForPodsWithFailureDetection(
      namespace,
      "app=mailpit",
    );
  });

  test("RHDH container can establish hybrid KEM SMTP STARTTLS", async () => {
    test.setTimeout(120_000);
    const group = TLS_GROUPS.hybrid;
    const { tlsInfo, negotiated } = handshake(group, namespace);

    expect(
      tlsInfo.hasHandshakeError,
      `handshake failed for group ${group}:\n${tlsInfo.raw}`,
    ).toBe(false);
    expect(tlsInfo.protocol).toMatch(/TLSv1\.3/iu);
    expect(negotiated?.toLowerCase()).toBe(group.toLowerCase());
  });

  test("RHDH container can fall back to classical SMTP STARTTLS against a PQ-capable peer", async () => {
    test.setTimeout(120_000);
    const group = TLS_GROUPS.classical;
    const { tlsInfo, negotiated } = handshake(group, namespace);

    expect(
      tlsInfo.hasHandshakeError,
      `handshake failed for group ${group}:\n${tlsInfo.raw}`,
    ).toBe(false);
    expect(tlsInfo.protocol).toMatch(/TLSv1\.3/iu);
    expect(negotiated?.toLowerCase()).toBe(group.toLowerCase());
  });
});

function handshake(
  group: TlsGroup,
  namespace: string,
): { tlsInfo: OpensslSClientResult; negotiated: string | undefined } {
  const tlsInfo = runOpensslSClientFromRhdhPod({
    namespace,
    host: mailpitSmtpHost(namespace),
    port: MAILPIT_SMTP_PORT,
    group,
    starttls: "smtp",
  });
  return { tlsInfo, negotiated: resolvedKeyExchangeGroup(tlsInfo) };
}
