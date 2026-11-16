import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";

import { PQCHelper } from "../../support/openssl/pqc-helper.js";
import { resolvedKeyExchangeGroup } from "../../support/openssl/s-client.js";
import { CONFIG_DIR, TLS_GROUPS } from "../config/openssl-pqc/fixture.js";

/**
 * OpenSSL PQC HTTPS checks inspired by rhdh fips-compliance.spec.ts.
 *
 * Deploys ubi10/httpd-24 with in-pod TLS (mod_ssl / UBI OpenSSL on 8443) via
 * PQCHelper, then runs openssl s_client inside the RHDH hub container against
 * the in-cluster Service DNS (east-west), not an OpenShift Route.
 */
test.describe("OpenSSL PQC HTTPS", () => {
  let pqc: PQCHelper;

  test.beforeAll(async ({ rhdh }, testInfo) => {
    test.setTimeout(600_000);
    const namespace = rhdh.deploymentConfig.namespace;
    testInfo.annotations.push({
      type: "component",
      description: "openssl-pqc",
    });

    pqc = new PQCHelper();

    await test.runOnce(`openssl-pqc-https-setup-${namespace}`, async () => {
      await rhdh.configure({
        auth: "guest",
        dynamicPlugins: `${CONFIG_DIR}/dynamic-plugins.yaml`,
      });
      await rhdh.deploy();
      await pqc.deploy(namespace);
    });

    // Survive worker restart when runOnce skips deploy.
    pqc.deploymentConfig.namespace = namespace;
    pqc.resolveService();
  });

  test("RHDH container can establish hybrid KEM HTTPS", async () => {
    test.setTimeout(120_000);

    const group = TLS_GROUPS.hybrid;
    const host = pqc.getServiceHost();
    const port = pqc.getServicePort();
    const tlsInfo = pqc.runSClientFromRhdhPod(group);
    const negotiated = resolvedKeyExchangeGroup(tlsInfo);

    console.info(`[PQC] target=https://${host}:${port} group=${group}`);
    console.info(`[PQC] Protocol: ${tlsInfo.protocol ?? "unknown"}`);
    console.info(`[PQC] Negotiated key exchange: ${negotiated ?? "unknown"}`);
    console.info(
      `[PQC] Verify return code: ${tlsInfo.verifyReturnCode ?? "unknown"}`,
    );

    expect(
      tlsInfo.hasHandshakeError,
      `handshake failed for group ${group}:\n${tlsInfo.raw}`,
    ).toBe(false);
    expect(tlsInfo.protocol).toMatch(/TLSv1\.3/iu);
    expect(negotiated?.toLowerCase()).toBe(group.toLowerCase());
  });

  test("RHDH container can fall back to classical HTTPS against a PQ-capable peer", async () => {
    test.setTimeout(120_000);

    const group = TLS_GROUPS.classical;
    const host = pqc.getServiceHost();
    const port = pqc.getServicePort();
    const tlsInfo = pqc.runSClientFromRhdhPod(group);
    const negotiated = resolvedKeyExchangeGroup(tlsInfo);

    console.info(
      `[PQC] target=https://${host}:${port} group=${group} (classical fallback)`,
    );
    console.info(`[PQC] Protocol: ${tlsInfo.protocol ?? "unknown"}`);
    console.info(`[PQC] Negotiated key exchange: ${negotiated ?? "unknown"}`);
    console.info(
      `[PQC] Verify return code: ${tlsInfo.verifyReturnCode ?? "unknown"}`,
    );

    expect(
      tlsInfo.hasHandshakeError,
      `classical fallback handshake failed:\n${tlsInfo.raw}`,
    ).toBe(false);
    expect(tlsInfo.protocol).toMatch(/TLSv1\.3/iu);
    // Classical OpenSSL output often uses "Peer Temp Key: X25519" instead of
    // "Negotiated TLS1.3 group".
    expect(negotiated?.toLowerCase()).toBe(group.toLowerCase());
  });
});
