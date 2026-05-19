import { chromium, type Locator, type Page } from "@playwright/test";
import os from "os";
import path from "path";
import { authenticator } from "otplib";
import { getGitHubLoginCredentials } from "../specs/bulk-import-shared";

const GITHUB_ORIGIN = "https://github.com";
const USER_AGENT = "rhdh-bulk-import-e2e/1.0";

/** OAuth app missing or already deleted — teardown should not fail the suite. */
export class OAuthApplicationNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthApplicationNotFoundError";
  }
}

function launchGitHubAutomationBrowser() {
  return chromium.launch({
    headless: process.env.PLAYWRIGHT_HEADLESS !== "0",
  });
}

/** Legacy `Iv1.*`, `Ov23li*`, and newer ids like `Ov23ctx…` / `0v23ctx…` (font may use zero). */
const CLIENT_ID_PATTERN =
  /\b(Iv1\.[a-zA-Z0-9._-]+|(?:Ov|0v)\d+(?:li)?[a-zA-Z0-9]+)\b/i;

function normalizeGitHubClientId(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(CLIENT_ID_PATTERN);
  return match?.[0] ?? trimmed;
}

export class GitHubWebSession {
  private readonly cookies = new Map<string, string>();

  cookieHeader(): string {
    return [...this.cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  ingestCookies(response: Response): void {
    const setCookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [];

    for (const header of setCookies) {
      const part = header.split(";")[0]?.trim();
      if (!part) {
        continue;
      }
      const eq = part.indexOf("=");
      if (eq <= 0) {
        continue;
      }
      const name = part.slice(0, eq);
      const value = part.slice(eq + 1);
      if (value === "" || value.toLowerCase() === "deleted") {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  /** Settings pages redirect to /login when there is no session. */
  async isAuthenticated(): Promise<boolean> {
    const probe = await this.get("/settings/applications/new");
    return !probe.url.includes("/login");
  }

  private async request(
    url: string,
    init: RequestInit = {},
  ): Promise<{ response: Response; html: string; url: string }> {
    const headers = new Headers(init.headers);
    headers.set("User-Agent", USER_AGENT);
    headers.set(
      "Accept",
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    );
    const cookie = this.cookieHeader();
    if (cookie) {
      headers.set("Cookie", cookie);
    }

    let currentUrl = url;
    let response = await fetch(currentUrl, {
      ...init,
      headers,
      redirect: "manual",
    });
    this.ingestCookies(response);

    for (let hop = 0; hop < 12; hop++) {
      if (response.status < 300 || response.status >= 400) {
        break;
      }
      const location = response.headers.get("location");
      if (!location) {
        break;
      }
      currentUrl = new URL(location, currentUrl).href;
      response = await fetch(currentUrl, {
        headers: {
          Cookie: this.cookieHeader(),
          "User-Agent": USER_AGENT,
          Accept: headers.get("Accept") ?? "*/*",
        },
        redirect: "manual",
      });
      this.ingestCookies(response);
    }

    const html = await response.text();
    return { response, html, url: currentUrl };
  }

  async get(path: string): Promise<{ response: Response; html: string; url: string }> {
    return this.request(`${GITHUB_ORIGIN}${path}`);
  }

  async postForm(
    path: string,
    fields: Record<string, string>,
    referer?: string,
  ): Promise<{ response: Response; html: string; url: string }> {
    const body = new URLSearchParams(fields);
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (referer) {
      headers.Referer = referer;
    }
    return this.request(`${GITHUB_ORIGIN}${path}`, {
      method: "POST",
      headers,
      body,
    });
  }

  importPlaywrightCookies(
    cookies: ReadonlyArray<{ name: string; value: string }>,
  ): void {
    for (const cookie of cookies) {
      if (cookie.value) {
        this.cookies.set(cookie.name, cookie.value);
      }
    }
  }

  private async performGitHubLoginOnPage(
    page: Page,
    user: string,
    pass: string,
    totpSecret: string,
  ): Promise<void> {
    await page.goto("https://github.com/login", { waitUntil: "domcontentloaded" });
    await page.locator("#login_field").fill(user);
    await page.locator("#password").fill(pass);
    await page.locator('[value="Sign in"]').click();
    await page.waitForURL(
      (url) => {
        if (!url.hostname.endsWith("github.com")) {
          return false;
        }
        if (url.pathname.includes("/sessions/two-factor")) {
          return true;
        }
        return !url.pathname.startsWith("/login");
      },
      { timeout: 60_000 },
    );

    const submitTotpIfShown = async (): Promise<void> => {
      const totp = page.locator("#app_totp");
      if (!(await totp.isVisible({ timeout: 15_000 }).catch(() => false))) {
        return;
      }
      await totp.fill(authenticator.generate(totpSecret), { force: true });
      await page.waitForTimeout(3_000);
    };

    if (page.url().includes("/sessions/two-factor")) {
      await submitTotpIfShown();
      if (
        await page
          .getByText(/already been used|too many codes/i)
          .isVisible({ timeout: 3000 })
          .catch(() => false)
      ) {
        await page.waitForTimeout(35_000);
        await submitTotpIfShown();
      }
      await page.waitForURL(
        (url) => !url.pathname.includes("/sessions/two-factor"),
        { timeout: 60_000 },
      );
    } else if (page.url().includes("/login")) {
      throw new Error(
        `[bulk-import e2e] GitHub sign-in did not leave /login (URL: ${page.url()}).`,
      );
    }
  }

  private requireGitHubLoginCredentials(): {
    user: string;
    pass: string;
    totpSecret: string;
  } {
    const { user, pass } = getGitHubLoginCredentials();
    if (!user || !pass) {
      throw new Error(
        "[bulk-import e2e] Set VAULT_GH_USER_ID and VAULT_GH_USER_PASS for GitHub OAuth app provisioning.",
      );
    }
    const totpSecret = process.env.VAULT_GH_2FA_SECRET?.trim();
    if (!totpSecret) {
      throw new Error(
        "[bulk-import e2e] VAULT_GH_2FA_SECRET is required for GitHub login (TOTP).",
      );
    }
    return { user, pass, totpSecret };
  }

  /**
   * GitHub 2FA + session cookies are unreliable over raw fetch; reuse the same
   * headless flow as e2e-test-utils LoginHelper, then copy cookies for form POSTs.
   */
  async loginViaPlaywright(): Promise<void> {
    if (await this.isAuthenticated()) {
      return;
    }

    const { user, pass, totpSecret } = this.requireGitHubLoginCredentials();
    const browser = await launchGitHubAutomationBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await this.performGitHubLoginOnPage(page, user, pass, totpSecret);
      this.importPlaywrightCookies(await context.cookies());
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }

    if (!(await this.isAuthenticated())) {
      throw new Error(
        "[bulk-import e2e] GitHub Playwright login did not establish a settings session.",
      );
    }
  }

  async login(): Promise<void> {
    if (await this.isAuthenticated()) {
      return;
    }

    // GitHub 2FA/session cookies are unreliable over fetch; Playwright matches LoginHelper.
    await this.loginViaPlaywright();
  }

  private async loginViaHttp(): Promise<void> {
    const { user, pass } = getGitHubLoginCredentials();
    if (!user || !pass) {
      throw new Error(
        "[bulk-import e2e] Set VAULT_GH_USER_ID and VAULT_GH_USER_PASS (or GITHUB_USERNAME / GITHUB_PASSWORD) for GitHub OAuth app provisioning.",
      );
    }

    const loginPage = await this.get("/login");
    if (!loginPage.url.includes("/login")) {
      if (await this.isAuthenticated()) {
        return;
      }
      throw new Error(
        `[bulk-import e2e] Unexpected GitHub login page URL: ${loginPage.url}`,
      );
    }

    const token = extractAuthenticityToken(loginPage.html);
    const sessionAttempt = await this.postForm(
      "/session",
      {
        authenticity_token: token,
        commit: "Sign in",
        login: user,
        password: pass,
        "webauthn-support": "supported",
        "webauthn-iuvpaa-support": "supported",
      },
      `${GITHUB_ORIGIN}/login`,
    );

    if (
      isGitHubLoginForm(sessionAttempt.html) &&
      !needsTwoFactor(sessionAttempt.html, sessionAttempt.url)
    ) {
      const detail = extractGitHubFlashError(sessionAttempt.html);
      throw new Error(
        `[bulk-import e2e] GitHub rejected login for ${user}${detail ? `: ${detail}` : ""}.`,
      );
    }

    if (needsDeviceVerification(sessionAttempt.html, sessionAttempt.url)) {
      throw new Error(
        "[bulk-import e2e] GitHub device verification required — approve the device in email/app once, then re-run tests.",
      );
    }

    let { html: stepHtml, url: stepUrl } = await this.completeTwoFactorIfNeeded(
      sessionAttempt.html,
      sessionAttempt.url,
    );

    if (!stepUrl.includes("/login") && needsTwoFactor(stepHtml, stepUrl)) {
      ({ html: stepHtml, url: stepUrl } = await this.completeTwoFactorIfNeeded(
        stepHtml,
        stepUrl,
      ));
    }

    if (!(await this.isAuthenticated())) {
      throw new Error(
        `[bulk-import e2e] GitHub HTTP login failed (last URL: ${stepUrl}).`,
      );
    }
  }

  private async completeTwoFactorIfNeeded(
    html: string,
    url: string,
  ): Promise<{ html: string; url: string }> {
    if (!needsTwoFactor(html, url)) {
      return { html, url };
    }

    const secret = process.env.VAULT_GH_2FA_SECRET?.trim();
    if (!secret) {
      throw new Error(
        "[bulk-import e2e] GitHub 2FA required but VAULT_GH_2FA_SECRET is not set.",
      );
    }

    let referer = url.startsWith("http") ? url : `${GITHUB_ORIGIN}${url}`;
    let twoFactorPath = new URL(referer).pathname;

    // After password login GitHub redirects to /sessions/two-factor/app — POST must use that path.
    if (!/\/sessions\/two-factor/i.test(twoFactorPath)) {
      const twoFactorPage = await this.get("/sessions/two-factor/app");
      referer = twoFactorPage.url;
      twoFactorPath = new URL(referer).pathname;
      html = twoFactorPage.html;
    }

    const submitTwoFactor = async (
      pageHtml: string,
      pageUrl: string,
      otpCode: string,
    ) => {
      const pageReferer = pageUrl.startsWith("http")
        ? pageUrl
        : `${GITHUB_ORIGIN}${pageUrl}`;
      const postPath = new URL(pageReferer).pathname;
      const otpField = parseOtpFieldName(pageHtml) ?? "otp";
      const commit = parseTwoFactorCommitValue(pageHtml);
      const fields: Record<string, string> = {
        authenticity_token: extractAuthenticityToken(pageHtml),
        [otpField]: otpCode,
      };
      if (commit) {
        fields.commit = commit;
      }
      return this.postForm(postPath, fields, pageReferer);
    };

    let otpCode = authenticator.generate(secret);
    let twoFactor = await submitTwoFactor(html, referer, otpCode);

    if (
      twoFactor.html.includes("already been used") ||
      twoFactor.html.includes("too many codes")
    ) {
      await sleep(35_000);
      otpCode = authenticator.generate(secret);
      twoFactor = await submitTwoFactor(twoFactor.html, twoFactor.url, otpCode);
    }

    if (await this.isAuthenticated()) {
      return { html: twoFactor.html, url: twoFactor.url };
    }

    if (twoFactor.url.includes("/login")) {
      const detail = extractGitHubFlashError(twoFactor.html);
      throw new Error(
        `[bulk-import e2e] GitHub 2FA failed — redirected to login${detail ? `: ${detail}` : ""}.`,
      );
    }

    const detail = extractGitHubFlashError(twoFactor.html);
    throw new Error(
      `[bulk-import e2e] GitHub 2FA failed (URL: ${twoFactor.url})${detail ? `: ${detail}` : ""}.`,
    );
  }

  /**
   * Create OAuth app in browser — developer settings list is React; fetch HTML is empty.
   */
  async createOAuthApplicationViaPlaywright(params: {
    name: string;
    homepageUrl: string;
    callbackUrl: string;
  }): Promise<{ settingsAppId: string; clientId: string; clientSecret: string }> {
    const { user, pass, totpSecret } = this.requireGitHubLoginCredentials();
    const browser = await launchGitHubAutomationBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await this.performGitHubLoginOnPage(page, user, pass, totpSecret);

      await page.goto(`${GITHUB_ORIGIN}/settings/applications/new`, {
        waitUntil: "domcontentloaded",
      });
      if (page.url().includes("/login")) {
        throw new Error(
          "[bulk-import e2e] Not authenticated for GitHub developer settings.",
        );
      }

      const nameInput = page
        .locator(
          '#oauth_application_name, input[name="oauth_application[name]"], input#application_name',
        )
        .first();
      await nameInput.waitFor({ state: "visible", timeout: 60_000 });
      await nameInput.fill(params.name);
      await page
        .locator(
          '#oauth_application_url, input[name="oauth_application[url]"], input#application_url',
        )
        .first()
        .fill(params.homepageUrl);
      await page
        .locator(
          '#oauth_application_callback_url, input[name="oauth_application[callback_url]"], input#application_callback_url',
        )
        .first()
        .fill(params.callbackUrl);

      await page
        .getByRole("button", {
          name: /Register application|Create application/i,
        })
        .click();

      await page.waitForURL(/\/settings\/applications/, { timeout: 90_000 });

      if (!page.url().match(/\/settings\/applications\/\d+/)) {
        const appLink = page.getByRole("link", { name: params.name });
        await appLink.waitFor({ state: "visible", timeout: 30_000 });
        await appLink.click();
        await page.waitForURL(/\/settings\/applications\/\d+/, {
          timeout: 60_000,
        });
      }

      const settingsAppId = page.url().match(/\/settings\/applications\/(\d+)/)?.[1];
      if (!settingsAppId) {
        throw new Error(
          `[bulk-import e2e] Could not parse OAuth app id from ${page.url()}.`,
        );
      }

      await page
        .getByText(/Application created successfully/i)
        .waitFor({ state: "visible", timeout: 30_000 })
        .catch(() => {});
      await page.waitForLoadState("networkidle").catch(() => {});

      const clientId = await readOAuthClientIdFromPage(page);
      await page
        .getByRole("button", {
          name: /Generate a new client secret|Generate client secret/i,
        })
        .click();
      const clientSecret = await readOAuthClientSecretFromPage(page);

      return { settingsAppId, clientId, clientSecret };
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  async createOAuthApplication(params: {
    name: string;
    homepageUrl: string;
    callbackUrl: string;
  }): Promise<{ settingsAppId: string; clientId: string; clientSecret: string }> {
    return this.createOAuthApplicationViaPlaywright(params);
  }

  /** GitHub may redirect to /settings/applications (list) instead of /applications/{id}. */
  private async resolveOAuthApplicationDetailPage(
    afterCreate: { html: string; url: string },
    appName: string,
  ): Promise<{ html: string; url: string }> {
    const directId = afterCreate.url.match(/\/settings\/applications\/(\d+)/)?.[1];
    if (directId) {
      return afterCreate;
    }

    const listPath = findOAuthApplicationSettingsPath(afterCreate.html, appName);
    if (listPath) {
      return this.get(listPath);
    }

    const flash = extractGitHubFlashError(afterCreate.html);
    throw new Error(
      `[bulk-import e2e] OAuth app "${appName}" not found after register (URL: ${afterCreate.url})${flash ? ` — ${flash}` : ""}.`,
    );
  }

  private async generateOAuthClientSecret(
    settingsAppId: string,
    settingsHtml: string,
    settingsUrl: string,
  ): Promise<string> {
    const existing = parseClientSecretFromHtml(settingsHtml);
    if (existing) {
      return existing;
    }

    const token = extractAuthenticityToken(settingsHtml);
    const secretPath =
      extractFormActionNear(settingsHtml, /Generate a new client secret/i) ??
      `/settings/applications/${settingsAppId}/secret`;

    const generated = await this.postForm(
      secretPath,
      {
        authenticity_token: token,
        commit: "Generate a new client secret",
      },
      settingsUrl,
    );

    const secret = parseClientSecretFromHtml(generated.html);
    if (!secret) {
      throw new Error(
        `[bulk-import e2e] Client secret not found after generation on ${generated.url}.`,
      );
    }
    return secret;
  }

  /**
   * Delete via browser — fetch POST no longer removes apps on GitHub's React settings UI.
   */
  async deleteOAuthApplicationViaPlaywright(params: {
    settingsAppId: string;
    appName?: string;
    clientId?: string;
  }): Promise<void> {
    const { user, pass, totpSecret } = this.requireGitHubLoginCredentials();
    const browser = await launchGitHubAutomationBrowser();
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await this.performGitHubLoginOnPage(page, user, pass, totpSecret);

      if (page.url().includes("/login")) {
        throw new Error(
          "[bulk-import e2e] Not authenticated for GitHub developer settings during OAuth delete.",
        );
      }

      const opened = await openOAuthApplicationSettingsPage(page, params);
      if (!opened) {
        throw new OAuthApplicationNotFoundError(
          `[bulk-import e2e] OAuth app not found for delete (settings id ${params.settingsAppId}, name ${params.appName ?? "n/a"}).`,
        );
      }

      await navigateToOAuthDeleteAction(page);
      await confirmOAuthApplicationDeletion(page, params.appName);
      await assertOAuthApplicationRemoved(
        page,
        params.settingsAppId,
        params.appName,
      );
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  async deleteOAuthApplication(
    settingsAppId: string,
    options?: { appName?: string; clientId?: string },
  ): Promise<void> {
    await this.deleteOAuthApplicationViaPlaywright({
      settingsAppId,
      appName: options?.appName,
      clientId: options?.clientId,
    });
  }
}

export function extractAuthenticityToken(html: string): string {
  const patterns = [
    /name="authenticity_token"\s+value="([^"]+)"/,
    /name='authenticity_token'\s+value='([^']+)'/,
    /content="([^"]+)"\s+name="csrf-token"/,
    /name="csrf-token"\s+content="([^"]+)"/,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  throw new Error(
    "[bulk-import e2e] authenticity_token / csrf-token not found in GitHub HTML response.",
  );
}

export function parseClientIdFromHtml(html: string): string {
  const inputMatch = html.match(
    /id="oauth_application_client_id"[^>]*value="([^"]+)"/i,
  );
  if (inputMatch?.[1]?.trim()) {
    return normalizeGitHubClientId(inputMatch[1]);
  }

  const codeNearLabel = html.match(
    /Client ID[\s\S]{0,600}?<code[^>]*>([^<]+)<\/code>/i,
  );
  if (codeNearLabel?.[1]?.trim()) {
    return normalizeGitHubClientId(codeNearLabel[1]);
  }

  const labeled = html.match(
    /Client ID[\s\S]{0,400}?(?:<code[^>]*>|<dd[^>]*>|<input[^>]*value=")([^<"]+)/i,
  );
  if (labeled?.[1]) {
    return normalizeGitHubClientId(labeled[1]);
  }

  const clipboard = html.match(/data-clipboard-text="((?:Ov|0v|Iv)[^"]+)"/i);
  if (clipboard?.[1]) {
    return normalizeGitHubClientId(clipboard[1]);
  }

  const any = html.match(CLIENT_ID_PATTERN);
  if (any?.[0]) {
    return normalizeGitHubClientId(any[0]);
  }

  throw new Error(
    "[bulk-import e2e] Could not parse GitHub OAuth client id from settings HTML.",
  );
}

export function parseClientSecretFromHtml(html: string): string | null {
  const inputMatch = html.match(
    /id="oauth_application_client_secret"[^>]*value="([^"]+)"/i,
  );
  if (inputMatch?.[1]?.trim()) {
    return inputMatch[1].trim();
  }

  const labeled = html.match(
    /Client secret[\s\S]{0,400}?(?:<code[^>]*>)([a-f0-9]{20,})/i,
  );
  if (labeled?.[1]) {
    return labeled[1].trim();
  }

  const flash = html.match(
    /client secret[^<]{0,80}?<code[^>]*>([a-f0-9]{20,})<\/code>/i,
  );
  if (flash?.[1]) {
    return flash[1].trim();
  }

  return null;
}

function needsTwoFactor(html: string, url: string): boolean {
  return (
    /\/sessions\/two-factor|\/login\/two-factor/i.test(url) ||
    /id="app_totp"|name="otp"|two-factor authentication/i.test(html)
  );
}

function parseOtpFieldName(html: string): string | null {
  const byId = html.match(/id="app_totp"[^>]*\sname="([^"]+)"/i);
  if (byId?.[1]) {
    return byId[1];
  }
  const byName = html.match(/name="(otp|app_otp)"[^>]*id="app_totp"/i);
  if (byName?.[1]) {
    return byName[1];
  }
  return null;
}

function parseTwoFactorCommitValue(html: string): string | null {
  return (
    html.match(
      /<button[^>]*type="submit"[^>]*value="([^"]+)"/i,
    )?.[1] ??
    html.match(/<input[^>]*type="submit"[^>]*value="([^"]+)"/i)?.[1] ??
    "Verify"
  );
}

function needsDeviceVerification(html: string, url: string): boolean {
  return /\/login\/device|device verification/i.test(`${url} ${html}`);
}

function isGitHubLoginForm(html: string): boolean {
  return /id="login_field"|name="login"[^>]*type="text"/i.test(html);
}

async function isGitHub404Page(page: Page): Promise<boolean> {
  const title = await page.title();
  if (/404|not found/i.test(title)) {
    return true;
  }

  const body = await page.locator("body").innerText().catch(() => "");
  return /not the web page you are looking for|We couldn.t find that page|404 – Page not found/i.test(
    body,
  );
}

async function isOAuthAppSettingsPageLoaded(page: Page): Promise<boolean> {
  if (page.url().includes("/login")) {
    return false;
  }
  if (!/\/settings\/applications\/\d+/.test(page.url())) {
    return false;
  }
  if (await isGitHub404Page(page)) {
    return false;
  }

  const clientIdInput = page.locator("#oauth_application_client_id").first();
  if (await clientIdInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
    return true;
  }

  return page
    .getByText(/Application name|Client ID|Generate a new client secret/i)
    .first()
    .isVisible({ timeout: 5_000 })
    .catch(() => false);
}

async function openOAuthApplicationSettingsPage(
  page: Page,
  params: { settingsAppId: string; appName?: string; clientId?: string },
): Promise<boolean> {
  await page.goto(
    `${GITHUB_ORIGIN}/settings/applications/${params.settingsAppId}`,
    { waitUntil: "domcontentloaded" },
  );

  if (await isOAuthAppSettingsPageLoaded(page)) {
    return true;
  }

  await page.goto(`${GITHUB_ORIGIN}/settings/applications`, {
    waitUntil: "domcontentloaded",
  });

  if (params.appName) {
    const byName = page.getByRole("link", { name: params.appName, exact: true });
    if (await byName.isVisible({ timeout: 15_000 }).catch(() => false)) {
      await byName.click();
      await page.waitForURL(/\/settings\/applications\/\d+/, { timeout: 60_000 });
      if (await isOAuthAppSettingsPageLoaded(page)) {
        return true;
      }
    }
  }

  if (params.clientId) {
    const row = page.locator(`tr:has-text("${params.clientId}")`).first();
    if (await row.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await row.getByRole("link").first().click();
      await page.waitForURL(/\/settings\/applications\/\d+/, { timeout: 60_000 });
      if (await isOAuthAppSettingsPageLoaded(page)) {
        return true;
      }
    }
  }

  return false;
}

async function clickGitHubSettingsControl(locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  try {
    await locator.click({ timeout: 15_000 });
  } catch {
    await locator.evaluate((el) => {
      el.scrollIntoView({ block: "center", inline: "nearest" });
      el.click();
    });
  }
}

/** Step 1 on Advanced: opens the delete confirmation popup (not "Delete OAuth application"). */
function oauthOpenDeleteDialogControl(page: Page): Locator {
  return page
    .getByRole("button", { name: /^Delete application$/i })
    .or(page.getByRole("link", { name: /^Delete application$/i }))
    .or(
      page
        .locator("button.btn-danger, input.btn-danger[type='submit']")
        .filter({ hasText: /^Delete application$/i }),
    );
}

async function scrollToOAuthDangerZone(page: Page): Promise<void> {
  const danger = page.getByText(/danger zone|delete application/i).last();
  await danger.scrollIntoViewIfNeeded().catch(() => {});
  await page.keyboard.press("End").catch(() => {});
}

async function waitForOAuthDeleteDialog(page: Page): Promise<Locator> {
  const modal = page
    .locator(
      '[role="dialog"], [role="alertdialog"], dialog, .modal-dialog, div[aria-modal="true"]',
    )
    .filter({ hasText: /Delete OAuth application/i })
    .last();
  await modal.waitFor({ state: "visible", timeout: 60_000 });
  return modal;
}

/** Step 2 inside popup: confirms deletion. */
function oauthDeleteInDialogControl(dialog: Locator): Locator {
  return dialog
    .getByRole("button", { name: /Delete OAuth application/i })
    .or(dialog.getByRole("link", { name: /Delete OAuth application/i }))
    .or(
      dialog
        .locator("button.btn-danger, input.btn-danger[type='submit']")
        .filter({ hasText: /Delete OAuth application/i }),
    )
    .or(dialog.getByRole("button", { name: /Delete this OAuth Application/i }))
    .or(
      dialog.locator(
        'input[type="submit"][value*="Delete this OAuth Application"]',
      ),
    );
}

async function navigateToOAuthDeleteAction(page: Page): Promise<void> {
  const appId = page.url().match(/\/settings\/applications\/(\d+)/)?.[1];
  if (!appId) {
    throw new Error(
      `[bulk-import e2e] Expected OAuth app settings URL, got ${page.url()}.`,
    );
  }

  const paths = ["", "/advanced"];
  for (const suffix of paths) {
    await page.goto(`${GITHUB_ORIGIN}/settings/applications/${appId}${suffix}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("networkidle").catch(() => {});

    if (await isGitHub404Page(page)) {
      throw new OAuthApplicationNotFoundError(
        `[bulk-import e2e] OAuth app ${appId} returned GitHub 404 — already deleted or inaccessible.`,
      );
    }

    await scrollToOAuthDangerZone(page);

    const openDialog = oauthOpenDeleteDialogControl(page).first();
    if (await openDialog.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await clickGitHubSettingsControl(openDialog);
      return;
    }
  }

  if (await isGitHub404Page(page)) {
    throw new OAuthApplicationNotFoundError(
      `[bulk-import e2e] OAuth app ${appId} returned GitHub 404 — already deleted or inaccessible.`,
    );
  }

  const screenshot = path.join(
    os.tmpdir(),
    "oauth-delete-missing-open-button.png",
  );
  await page.screenshot({ path: screenshot, fullPage: true });
  throw new Error(
    `[bulk-import e2e] "Delete application" not found for app ${appId} (screenshot: ${screenshot}).`,
  );
}

async function confirmOAuthApplicationDeletion(
  page: Page,
  appName?: string,
): Promise<void> {
  const dialog = await waitForOAuthDeleteDialog(page);
  const confirm = oauthDeleteInDialogControl(dialog).first();
  await confirm.waitFor({ state: "visible", timeout: 60_000 });
  await clickGitHubSettingsControl(confirm);

  await page
    .locator('[role="dialog"], [role="alertdialog"], div[aria-modal="true"]')
    .first()
    .waitFor({ state: "hidden", timeout: 90_000 })
    .catch(() => {});

  await page
    .waitForURL(
      (url) =>
        url.pathname === "/settings/applications" ||
        url.pathname === "/settings/developers",
      { timeout: 90_000 },
    )
    .catch(() => {});

  await page
    .getByText(/has been deleted|successfully deleted|application deleted/i)
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});

  if (appName) {
    await assertOAuthApplicationNotListed(page, appName);
  }
}

async function assertOAuthApplicationNotListed(
  page: Page,
  appName: string,
): Promise<void> {
  await page.goto(`${GITHUB_ORIGIN}/settings/applications`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForLoadState("networkidle").catch(() => {});

  const stillListed = await page
    .getByRole("link", { name: appName, exact: true })
    .isVisible({ timeout: 5_000 })
    .catch(() => false);

  if (stillListed) {
    throw new Error(
      `[bulk-import e2e] OAuth app "${appName}" still listed after delete confirm.`,
    );
  }
}

async function assertOAuthApplicationRemoved(
  page: Page,
  settingsAppId: string,
  appName?: string,
): Promise<void> {
  if (appName) {
    await assertOAuthApplicationNotListed(page, appName);
    return;
  }

  const response = await page.goto(
    `${GITHUB_ORIGIN}/settings/applications/${settingsAppId}`,
    { waitUntil: "domcontentloaded" },
  );

  const status = response?.status() ?? 0;
  const body = await page.locator("body").innerText();

  if (status === 404 || status === 410) {
    return;
  }

  const redirectedAway = !page.url().includes(`/applications/${settingsAppId}`);
  const notFoundCopy = /404|not found|doesn't exist|We couldn.t find|page could not be found|This application (?:was|has been) deleted/i.test(
    body,
  );

  if (redirectedAway || notFoundCopy) {
    return;
  }

  const clientIdInput = page.locator("#oauth_application_client_id").first();
  const hasLiveClientId =
    (await clientIdInput.isVisible({ timeout: 2_000 }).catch(() => false)) &&
    CLIENT_ID_PATTERN.test((await clientIdInput.inputValue().catch(() => "")).trim());

  if (!hasLiveClientId) {
    return;
  }

  throw new Error(
    `[bulk-import e2e] OAuth app ${settingsAppId} still present after delete (HTTP ${status}, URL: ${page.url()}).`,
  );
}

async function readOAuthClientIdFromPage(page: Page): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const input = page.locator(
      '#oauth_application_client_id, input[name="oauth_application[client_id]"], input[readonly][value^="Ov"], input[readonly][value^="0v"], input[readonly][value^="Iv"]',
    );
    if (await input.first().isVisible({ timeout: 2000 }).catch(() => false)) {
      const value =
        (await input.first().inputValue().catch(() => "")) ||
        (await input.first().getAttribute("value").catch(() => "")) ||
        (await input.first().innerText().catch(() => ""));
      if (value.trim()) {
        return normalizeGitHubClientId(value);
      }
    }

    const clientIdRow = page
      .locator("li, div, tr, dl")
      .filter({ has: page.getByText(/^Client ID$/i) })
      .first();
    const codeInRow = clientIdRow.locator("code").first();
    if (await codeInRow.isVisible({ timeout: 1000 }).catch(() => false)) {
      const text = (await codeInRow.innerText()).trim();
      if (CLIENT_ID_PATTERN.test(text)) {
        return normalizeGitHubClientId(text);
      }
    }

    const codes = page.locator("code");
    const codeCount = await codes.count();
    for (let i = 0; i < codeCount; i++) {
      const text = (await codes.nth(i).innerText()).trim();
      if (CLIENT_ID_PATTERN.test(text)) {
        return normalizeGitHubClientId(text);
      }
    }

    try {
      return parseClientIdFromHtml(await page.content());
    } catch {
      // React may still be hydrating — retry.
    }

    await page.waitForTimeout(500);
  }

  const screenshot = path.join(os.tmpdir(), "oauth-create-missing-client-id.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  throw new Error(
    `[bulk-import e2e] Could not read GitHub OAuth client id on ${page.url()} (screenshot: ${screenshot}).`,
  );
}

async function readOAuthClientSecretFromPage(page: Page): Promise<string> {
  const input = page.locator("#oauth_application_client_secret");
  if (await input.isVisible({ timeout: 5000 }).catch(() => false)) {
    const value = await input.inputValue().catch(() => "");
    if (value.trim()) {
      return value.trim();
    }
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    const codes = page.locator("code");
    const n = await codes.count();
    for (let i = 0; i < n; i++) {
      const text = (await codes.nth(i).innerText()).trim();
      if (text.length >= 32 && /^[a-f0-9]+$/i.test(text) && !text.startsWith("Iv")) {
        return text;
      }
    }
    const fromBody = parseClientSecretFromHtml(await page.locator("body").innerText());
    if (fromBody) {
      return fromBody;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(
    `[bulk-import e2e] Client secret not found on ${page.url()} after generation.`,
  );
}

/** Path like `/settings/applications/12345` from the developer settings list page. */
export function findOAuthApplicationSettingsPath(
  html: string,
  appName: string,
): string | null {
  const escaped = appName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const direct = html.match(
    new RegExp(
      `href="(/settings/applications/(\\d+))"[^>]*>\\s*${escaped}`,
      "i",
    ),
  );
  if (direct?.[1]) {
    return direct[1];
  }

  const linkBeforeName = html.match(
    new RegExp(
      `href="(/settings/applications/\\d+)"[^>]*>[\\s\\S]{0,500}?${escaped}`,
      "i",
    ),
  );
  if (linkBeforeName?.[1]) {
    return linkBeforeName[1];
  }

  const nameBeforeLink = html.match(
    new RegExp(
      `${escaped}[\\s\\S]{0,500}?href="(/settings/applications/\\d+)"`,
      "i",
    ),
  );
  if (nameBeforeLink?.[1]) {
    return nameBeforeLink[1];
  }

  const idNearName = html.match(
    new RegExp(`settings/applications/(\\d+)[\\s\\S]{0,600}?${escaped}`, "i"),
  );
  if (idNearName?.[1]) {
    return `/settings/applications/${idNearName[1]}`;
  }

  return null;
}

function extractGitHubFlashError(html: string): string | null {
  return (
    html.match(/class="flash-error[^"]*"[^>]*>\s*([^<]+)/i)?.[1]?.trim() ??
    html.match(/id="js-flash-container"[^>]*>[\s\S]*?flash-error[^>]*>([^<]+)/i)?.[1]?.trim() ??
    null
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractFormActionNear(
  html: string,
  label: RegExp,
): string | null {
  const idx = html.search(label);
  if (idx < 0) {
    return null;
  }
  const slice = html.slice(Math.max(0, idx - 1500), idx + 500);
  const action = slice.match(/<form[^>]*action="([^"]+)"/i)?.[1];
  if (!action) {
    return null;
  }
  if (action.startsWith("http")) {
    return new URL(action).pathname;
  }
  return action.startsWith("/") ? action : `/${action}`;
}
