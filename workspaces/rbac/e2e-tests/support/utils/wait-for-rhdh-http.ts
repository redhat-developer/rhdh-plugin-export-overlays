/**
 * After an OpenShift rollout or scale event, pods can report Ready while the
 * route still returns 503 or connections fail briefly. This polls the public
 * URL until HTTP responses indicate the app is actually reachable.
 *
 */
import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";

export type WaitForRhdhHttpOptions = {
  /** Total time to keep polling. */
  timeoutMs?: number;
  /** Delay between full retry rounds. */
  intervalMs?: number;
  /** Per-request timeout. */
  requestTimeoutMs?: number;
};

function responseLooksHealthy(status: number): boolean {
  if (status >= 200 && status < 400) {
    return true;
  }
  if (status === 401 || status === 403) {
    return true;
  }
  return false;
}

/** Single GET; follows one level of redirect via returned location. */
function getOnce(
  url: URL,
  requestTimeoutMs: number,
): Promise<{ statusCode: number; location?: string }> {
  const isHttps = url.protocol === "https:";
  const mod = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { Accept: "*/*" },
        timeout: requestTimeoutMs,
        ...(isHttps
          ? {
              agent: new https.Agent({
                rejectUnauthorized: false,
              }),
            }
          : {}),
      },
      (res) => {
        res.resume();
        const loc = res.headers.location;
        resolve({
          statusCode: res.statusCode ?? 0,
          location: typeof loc === "string" ? loc : undefined,
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("request timeout"));
    });
    req.end();
  });
}

async function fetchStatusFollowingRedirects(
  startUrl: string,
  requestTimeoutMs: number,
  maxRedirects = 5,
): Promise<number> {
  let url = new URL(startUrl);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const { statusCode, location } = await getOnce(url, requestTimeoutMs);
    if (statusCode >= 300 && statusCode < 400 && location) {
      url = new URL(location, url);
      continue;
    }
    return statusCode;
  }
  throw new Error("too many redirects");
}

export async function waitUntilRhdhServesHttp(
  baseUrl: string,
  options: WaitForRhdhHttpOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 300_000;
  const intervalMs = options.intervalMs ?? 3_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  const pingUrl = new URL("/", baseUrl).toString();

  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const status = await fetchStatusFollowingRedirects(
        pingUrl,
        requestTimeoutMs,
      );
      if (responseLooksHealthy(status)) {
        console.log(
          `[waitUntilRhdhServesHttp] OK after ${attempt} attempt(s): ${pingUrl} -> ${status}`,
        );
        return;
      }
    } catch (err) {
      console.log(
        `[waitUntilRhdhServesHttp] attempt ${attempt} ${pingUrl}: ${err instanceof Error ? err.message : err}`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error(
    `RHDH URL did not become HTTP-ready within ${timeoutMs}ms: ${baseUrl}`,
  );
}
