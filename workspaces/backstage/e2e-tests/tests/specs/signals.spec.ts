import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  E2E_RECEIVED_SIGNAL_TEST_ID,
  E2E_SIGNALS_CHANNEL,
  SignalsApiHelper,
  closeSignalsWebSocket,
  getGuestIdentityToken,
  rethrowWithSignalsWsDiagnostics,
  signalsWebSocketUrl,
  subscribeToSignalsChannel,
} from "../../support/api/signals";

/** Chart dist wrapper names (see ../metadata `spec.dynamicArtifact` basenames). */
const SIGNALS_WRAPPER_DIST_NAMES: string[] = [
  "backstage-plugin-signals",
  "backstage-plugin-signals-backend-dynamic",
];

/**
 * Frontend package is enabled (and wrappers disabled) so PR OCI replaces the
 * chart dist artifact. Receive is asserted via a raw WebSocket — the signals
 * frontend only registers SignalClient / signalApiRef (no routes). Client usage
 * is covered by the notifications suite (useSignal('notifications')).
 */
test.describe("Backstage Signals Plugin", () => {
  test.beforeAll(async ({ rhdh }) => {
    await rhdh.configure({
      auth: "guest",
      appConfig: "tests/config/signals/app-config-rhdh.yaml",
      dynamicPlugins: "tests/config/signals/dynamic-plugins.yaml",
      disablePlugins: SIGNALS_WRAPPER_DIST_NAMES,
    });
    await rhdh.deploy();
  });

  test("Verify signals backend health endpoint", async ({ request }) => {
    const response = await request.get("/api/signals/health");
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("Verify a broadcast signal is received in the browser", async ({
    page,
    request,
    loginHelper,
  }) => {
    await loginHelper.loginAsGuest();

    const token = await getGuestIdentityToken(page);
    const baseUrl = process.env.RHDH_BASE_URL ?? new URL(page.url()).origin;
    const signalsApi = new SignalsApiHelper(request);

    await subscribeToSignalsChannel(page, {
      wsUrl: signalsWebSocketUrl(baseUrl),
      token,
      channel: E2E_SIGNALS_CHANNEL,
      testId: E2E_RECEIVED_SIGNAL_TEST_ID,
    });

    try {
      await expect(async () => {
        const messageId = crypto.randomUUID();
        const response = await signalsApi.publishBroadcast(
          E2E_SIGNALS_CHANNEL,
          {
            id: messageId,
            text: `e2e-signal-${messageId}`,
          },
        );
        expect(
          response.status(),
          `publish signal failed (${response.status()}): ${await response.text()}`,
        ).toBe(202);

        await expect(
          page
            .getByTestId(E2E_RECEIVED_SIGNAL_TEST_ID)
            .filter({ hasText: messageId }),
        ).toBeVisible({ timeout: 5_000 });
      }).toPass({ timeout: 30_000 });
    } catch (err) {
      await rethrowWithSignalsWsDiagnostics(page, err);
    } finally {
      await closeSignalsWebSocket(page);
    }
  });
});
