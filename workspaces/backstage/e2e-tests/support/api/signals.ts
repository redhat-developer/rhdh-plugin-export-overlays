import {
  type APIRequestContext,
  type APIResponse,
  type Page,
} from "@playwright/test";
import { AuthApiHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";

export const E2E_SIGNALS_CHANNEL = "e2e-signals";
export const E2E_RECEIVED_SIGNAL_TEST_ID = "e2e-received-signal";

/**
 * First attempt: fail fast on signals-backend's dropped handshake
 * (mirrors SignalClient.DEFAULT_CONNECT_TIMEOUT_MS).
 */
const WS_CONNECT_FIRST_TIMEOUT_MS = 1_000;
/**
 * Later attempts: cluster-sized budget. OpenShift route + TLS often exceeds
 * SignalClient's 1s local timeout; the pre-harden helper used a single 15s
 * wait and passed in CI.
 */
const WS_CONNECT_RETRY_TIMEOUT_MS = 15_000;
/** Short backoff between connect attempts — do not copy SignalClient's 5s reconnect. */
const WS_CONNECT_RETRY_DELAY_MS = 200;
const WS_CONNECT_MAX_ATTEMPTS = 4;

interface SignalMessage {
  id: string;
  text: string;
}

interface SignalPayload {
  recipients: { type: "broadcast" };
  channel: string;
  message: SignalMessage;
}

/** Close diagnostics stored on the page for assertion-failure triage. */
interface SignalsWsDiagnostics {
  code?: number;
  reason?: string;
  closedAfterOpen?: boolean;
}

type E2ESignalsHolder = typeof globalThis & {
  e2eSignalsWs?: WebSocket;
  e2eSignalsWsDiagnostics?: SignalsWsDiagnostics;
};

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
 * Reads close diagnostics recorded by {@link subscribeToSignalsChannel}.
 * Useful when a receive assertion fails after the socket dropped.
 */
async function getSignalsWsDiagnostics(
  page: Page,
): Promise<SignalsWsDiagnostics | undefined> {
  return page.evaluate(() => {
    const holder = globalThis as E2ESignalsHolder;
    return holder.e2eSignalsWsDiagnostics;
  });
}

/** Formats close diagnostics for assertion-failure messages. */
function formatSignalsWsDiagnostics(
  diagnostics: SignalsWsDiagnostics | undefined,
): string {
  if (!diagnostics) {
    return "signals WS close: (no diagnostics recorded)";
  }
  return `signals WS close: code=${diagnostics.code}, reason=${diagnostics.reason || "none"}, closedAfterOpen=${diagnostics.closedAfterOpen}`;
}

/** Re-throws with WS close diagnostics appended (for receive-assertion failures). */
export async function rethrowWithSignalsWsDiagnostics(
  page: Page,
  err: unknown,
): Promise<never> {
  const diagnostics = await getSignalsWsDiagnostics(page);
  const message = err instanceof Error ? err.message : String(err);
  throw new Error(`${message}\n${formatSignalsWsDiagnostics(diagnostics)}`, {
    cause: err,
  });
}

/**
 * Closes the e2e signals WebSocket if still open (normal close code 1000).
 */
export async function closeSignalsWebSocket(page: Page): Promise<void> {
  await page.evaluate(() => {
    const holder = globalThis as E2ESignalsHolder;
    const ws = holder.e2eSignalsWs;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.close(1000);
    }
  });
}

/**
 * Opens an authenticated WebSocket on the RHDH page, subscribes to `channel`,
 * and appends each received frame to a `data-testid` node.
 *
 * Retries connect because signals-backend installs its upgrade listener lazily
 * as a side effect of the first handshake and drops that request (see
 * SignalClient.connect / reconnect). Attempt 1 uses a 1s budget; later
 * attempts use 15s so a slow OpenShift handshake can complete. There is no
 * subscribe ack from the server — callers should publish with a fresh
 * message id per attempt.
 *
 * The socket handle and close diagnostics are kept on globalThis so the
 * test can surface close code/reason on failure and close explicitly.
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
  await page.evaluate(
    async ({
      wsUrl,
      token,
      channel,
      testId,
      firstTimeoutMs,
      retryTimeoutMs,
      retryDelayMs,
      maxAttempts,
    }) => {
      const holder = globalThis as E2ESignalsHolder;
      holder.e2eSignalsWsDiagnostics = {};

      const sleep = (ms: number) =>
        new Promise<void>((r) => globalThis.setTimeout(r, ms));

      const tryConnect = (connectTimeoutMs: number): Promise<WebSocket> =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(wsUrl, token);
          let settled = false;

          const timeout = globalThis.setTimeout(() => {
            finish(new Error("WebSocket connect timeout"));
          }, connectTimeoutMs);

          const onOpen = () => finish();
          const onError = () => {
            finish(new Error(`WebSocket error connecting to ${wsUrl}`));
          };
          // Connect-attempt closes are retry noise — keep code/reason on the
          // thrown error, not on e2eSignalsWsDiagnostics (that field is for
          // the socket we actually keep after a successful open).
          const onClose = (event: CloseEvent) => {
            finish(
              new Error(
                `WebSocket closed during connect (code=${event.code}, reason=${event.reason || "none"})`,
              ),
            );
          };

          const cleanup = () => {
            globalThis.clearTimeout(timeout);
            ws.removeEventListener("open", onOpen);
            ws.removeEventListener("error", onError);
            ws.removeEventListener("close", onClose);
          };

          const finish = (err?: Error) => {
            if (settled) {
              return;
            }
            settled = true;
            cleanup();
            if (err) {
              if (
                ws.readyState === WebSocket.CONNECTING ||
                ws.readyState === WebSocket.OPEN
              ) {
                ws.close();
              }
              reject(err);
            } else {
              resolve(ws);
            }
          };

          ws.addEventListener("open", onOpen);
          ws.addEventListener("error", onError);
          ws.addEventListener("close", onClose);
        });

      let lastError: unknown;
      let ws: WebSocket | undefined;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const connectTimeoutMs =
            attempt === 1 ? firstTimeoutMs : retryTimeoutMs;
          ws = await tryConnect(connectTimeoutMs);
          break;
        } catch (err) {
          lastError = err;
          if (attempt < maxAttempts) {
            await sleep(retryDelayMs);
          }
        }
      }

      if (!ws) {
        throw new Error(
          `WebSocket connect timeout after ${maxAttempts} attempts` +
            (lastError instanceof Error ? `: ${lastError.message}` : ""),
        );
      }

      holder.e2eSignalsWs = ws;
      holder.e2eSignalsWsDiagnostics = {};

      ws.addEventListener("close", (event) => {
        holder.e2eSignalsWsDiagnostics = {
          code: event.code,
          reason: event.reason,
          closedAfterOpen: true,
        };
      });

      ws.addEventListener("message", (event) => {
        const marker = document.createElement("div");
        marker.setAttribute("data-testid", testId);
        marker.textContent =
          typeof event.data === "string" ? event.data : String(event.data);
        document.body.appendChild(marker);
      });

      ws.send(JSON.stringify({ action: "subscribe", channel }));
    },
    {
      ...options,
      firstTimeoutMs: WS_CONNECT_FIRST_TIMEOUT_MS,
      retryTimeoutMs: WS_CONNECT_RETRY_TIMEOUT_MS,
      retryDelayMs: WS_CONNECT_RETRY_DELAY_MS,
      maxAttempts: WS_CONNECT_MAX_ATTEMPTS,
    },
  );
}
