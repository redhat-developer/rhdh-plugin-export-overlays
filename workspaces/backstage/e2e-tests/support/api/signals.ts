import {
  type APIRequestContext,
  type APIResponse,
  type Page,
} from "@playwright/test";
import { AuthApiHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";

export const E2E_SIGNALS_CHANNEL = "e2e-signals";
export const E2E_RECEIVED_SIGNAL_TEST_ID = "e2e-received-signal";

export interface SignalMessage {
  id: string;
  text: string;
}

export type SignalRecipients =
  | { type: "broadcast" }
  | { type: "user"; entityRef: string | string[] };

export interface SignalPayload {
  recipients: SignalRecipients;
  channel: string;
  message: SignalMessage;
}

export class SignalsApiHelper {
  constructor(private readonly request: APIRequestContext) {}

  async publishBroadcast(
    channel: string,
    message: SignalMessage,
  ): Promise<APIResponse> {
    const payload: SignalPayload = {
      recipients: { type: "broadcast" },
      channel,
      message,
    };

    return this.request.post("/api/events/http/signals", { data: payload });
  }
}

export async function getGuestIdentityToken(page: Page): Promise<string> {
  const token: unknown = await new AuthApiHelper(page).getToken("guest");
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Expected a guest Backstage identity token");
  }
  return token;
}

export function signalsWebSocketUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/signals";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * Opens an authenticated WebSocket on the RHDH page, subscribes to `channel`,
 * and appends each received frame to a `data-testid` node. The socket is kept
 * on globalThis so it is not garbage-collected before publish.
 */
export async function subscribeToSignalsChannel(
  page: Page,
  options: {
    wsUrl: string;
    token: string;
    channel: string;
    testId: string;
  },
): Promise<void> {
  await page.evaluate(async ({ wsUrl, token, channel, testId }) => {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, token);
      const holder = globalThis as typeof globalThis & {
        e2eSignalsWs?: WebSocket;
      };
      holder.e2eSignalsWs = ws;

      const timeout = globalThis.setTimeout(() => {
        reject(new Error("WebSocket connect timeout"));
      }, 15_000);

      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ action: "subscribe", channel }));
        // Give SignalManager time to record the subscription before publish.
        globalThis.setTimeout(() => {
          globalThis.clearTimeout(timeout);
          resolve();
        }, 500);
      });

      ws.addEventListener("error", () => {
        globalThis.clearTimeout(timeout);
        reject(new Error(`WebSocket error connecting to ${wsUrl}`));
      });

      ws.addEventListener("message", (event) => {
        const marker = document.createElement("div");
        marker.setAttribute("data-testid", testId);
        marker.textContent =
          typeof event.data === "string" ? event.data : String(event.data);
        document.body.appendChild(marker);
      });
    });
  }, options);
}
