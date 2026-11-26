/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0.
 */

/**
 * Frontend render check for the release sanity run: opens the RHDH app the container
 * serves in headless Chromium, signs in as guest, waits for the signed-in shell, and
 * records what the dynamic frontend loader reported for each community frontend
 * package. The verdict is frontend-render-logic.ts's; this file only drives the browser.
 *
 * Needs a Chromium that playwright-core can launch:
 *   yarn playwright-core install chromium
 */

import { chromium, type Browser, type Page } from "playwright-core";
import {
  REMOTES_PATH,
  evaluateFrontendRender,
  parseRemotes,
  type BrowserMessage,
  type FailedRequest,
  type FrontendRenderReport,
} from "./frontend-render-logic";

// The app loads every dynamic remote before it renders, and ~50 community frontend
// packages plus the catalog index ones take a while on a cold container.
const SHELL_TIMEOUT_MS = 3 * 60 * 1000;

export type FrontendRenderOptions = {
  baseUrl: string;
  /** Installed community frontend package names, after render exclusions. */
  expected: string[];
  excluded: { packageName: string; ticket: string }[];
  /** Installed packages that ship dist/mf-manifest.json. */
  withManifest: string[];
  /** Where to save a screenshot when the shell does not render. */
  screenshotPath: string;
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message.split("\n")[0] : String(err);
}

/** Records loader output and failed remote asset requests for the page's lifetime. */
function observe(page: Page): {
  messages: BrowserMessage[];
  failedRequests: FailedRequest[];
} {
  const messages: BrowserMessage[] = [];
  const failedRequests: FailedRequest[] = [];
  page.on("console", (msg) =>
    messages.push({ type: msg.type(), text: msg.text() }),
  );
  page.on("requestfailed", (req) => {
    if (req.url().includes(REMOTES_PATH)) {
      failedRequests.push({
        url: req.url(),
        failure: req.failure()?.errorText ?? "request failed",
      });
    }
  });
  page.on("response", (res) => {
    if (res.url().includes(REMOTES_PATH) && res.status() >= 400) {
      failedRequests.push({ url: res.url(), failure: `HTTP ${res.status()}` });
    }
  });
  // The guest provider can prompt before signing in; accept rather than hang.
  page.on("dialog", (dialog) => void dialog.accept());
  return { messages, failedRequests };
}

/** Signs in as guest when asked, then waits for the sidebar: the positive DOM fact. */
async function waitForShell(page: Page, baseUrl: string): Promise<void> {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const sidebarLink = page.getByLabel("sidebar nav").getByRole("link").first();
  const signIn = page.getByRole("heading", { name: "Select a sign-in method" });
  await sidebarLink
    .or(signIn)
    .first()
    .waitFor({ state: "visible", timeout: SHELL_TIMEOUT_MS });
  if (await signIn.isVisible()) {
    await page.getByRole("button", { name: "Enter" }).click();
  }
  await sidebarLink.waitFor({ state: "visible", timeout: SHELL_TIMEOUT_MS });
}

export async function checkFrontendRender(
  options: FrontendRenderOptions,
): Promise<FrontendRenderReport> {
  const res = await fetch(`${options.baseUrl}${REMOTES_PATH}`);
  if (!res.ok) {
    throw new Error(`${REMOTES_PATH} responded ${res.status}`);
  }
  const remotes = parseRemotes(await res.json());

  let browser: Browser | undefined;
  let shellError: string | undefined;
  let observed: ReturnType<typeof observe>;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    observed = observe(page);
    try {
      await waitForShell(page, options.baseUrl);
    } catch (err) {
      shellError = `the signed-in shell did not render: ${errorText(err)}`;
      await page
        .screenshot({ path: options.screenshotPath, fullPage: true })
        .catch(() => undefined);
    }
  } finally {
    await browser?.close();
  }

  return evaluateFrontendRender({
    expected: options.expected,
    excluded: options.excluded,
    remotes,
    messages: observed.messages,
    failedRequests: observed.failedRequests,
    withManifest: options.withManifest,
    shellError,
  });
}
