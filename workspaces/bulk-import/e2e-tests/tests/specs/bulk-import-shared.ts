import { expect, type Frame, type Locator, type Page } from "@playwright/test";
import { LoginHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";

export const WAIT_OBJECTS = {
  muiLinearProgress: 'div[class*="MuiLinearProgress-root"]',
  muiCircularProgress: '[class*="MuiCircularProgress-root"]',
};

export const GITHUB_ORG = "janus-qe";

/**
 * Save in the catalog-info preview. `uiHelper.clickButton("Save")` matches globally and `.first()`
 * can resolve to an off-screen duplicate; Playwright then fails even with `force: true`. We scope to
 * the top dialog when present and trigger a native click (bypasses viewport actionability).
 */
export async function clickBulkImportPreviewSave(page: Page): Promise<Locator> {
  const save =
    (await page.getByRole("dialog").count()) > 0
      ? page
          .getByRole("dialog")
          .last()
          .getByRole("button", { name: "Save", exact: true })
      : page.getByRole("button", { name: "Save", exact: true }).last();

  await expect(save).toBeVisible({ timeout: 30_000 });
  await save.evaluate((el: { scrollIntoView: (opts?: object) => void; click: () => void }) => {
    el.scrollIntoView({ block: "center", inline: "nearest" });
    el.click();
  });
  return save;
}

/** Prefix for errors that must propagate (not swallowed by generic catch). */
const GITHUB_AUTH_BLOCKED = "[bulk-import e2e] GitHub auth blocked:";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * GitHub may require device verification (new browser / automation) or 2FA — not automatable in CI.
 * @see https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github
 */
function assertGitHubPopupCompletable(popup: Page, phase: string): void {
  if (popup.isClosed()) {
    return;
  }
  const u = popup.url();
  if (u.includes("/sessions/verified-device")) {
    throw new Error(
      `${GITHUB_AUTH_BLOCKED} device verification (${phase}). GitHub opened ${u} — enter the code from email/app once for this browser, or mark the device trusted / reduce triggers for this account. Fully automated e2e cannot complete this step.`,
    );
  }
}

/** GitHub puts OAuth failures in the popup URL (`error=`, `error_description=`). */
function throwIfGitHubOAuthErrorInUrl(popup: Page): void {
  if (popup.isClosed()) {
    return;
  }
  const u = popup.url();
  if (!u.includes("error=")) {
    return;
  }
  try {
    const parsed = new URL(u);
    const err = parsed.searchParams.get("error") ?? "";
    const rawDesc = parsed.searchParams.get("error_description") ?? "";
    let desc = rawDesc;
    try {
      desc = decodeURIComponent(rawDesc);
    } catch {
      /* keep raw */
    }
    throw new Error(
      `[bulk-import e2e] GitHub OAuth error in popup: error=${err} description=${desc}. For redirect_uri_mismatch: GitHub → Developer settings → OAuth App (or GitHub App → User authorization callback URL) must list EXACTLY the same origin/path as redirect_uri (typically https://<rhdh-route>/api/auth/github/handler/frame — match RHDH_BASE_URL, no extra slash).`,
    );
  } catch (e) {
    if (
      e instanceof Error &&
      e.message.includes("GitHub OAuth error in popup")
    ) {
      throw e;
    }
    throw new Error(
      `[bulk-import e2e] GitHub OAuth error URL could not be parsed: ${u}`,
    );
  }
}

async function logGitHubAuthorizeBanner(popup: Page): Promise<void> {
  if (popup.isClosed() || !popup.url().includes("/login/oauth/authorize")) {
    return;
  }
  const banner = popup
    .locator(".flash-error, .flash-alert, [role='alert'], .Layout-sidebar")
    .first();
  const text = await banner.innerText().catch(() => "");
  const trimmed = text.trim().slice(0, 500);
  if (trimmed) {
    // eslint-disable-next-line no-console
    console.warn(
      "[bulk-import e2e] GitHub /oauth/authorize page text:",
      trimmed,
    );
  }
}

const GH_OAUTH_INTERSTITIAL_MAX_DEPTH = 6;

/**
 * Reauthorization / SSO sometimes opens in a **new** browser page while the first OAuth popup stays
 * behind. Listen on the browser context for a new `page`, then continue automation on the GitHub tab.
 */
async function withOptionalGitHubChildPopup(
  current: Page,
  action: () => Promise<void>,
): Promise<Page> {
  const pending = current
    .context()
    .waitForEvent("page", { timeout: 12_000 })
    .catch(() => null);

  await action();

  const opened = await pending;
  if (!opened) {
    return current;
  }

  await opened.waitForLoadState("domcontentloaded").catch(() => {});
  let url = "";
  try {
    url = opened.url();
  } catch {
    await opened.close().catch(() => {});
    return current;
  }

  if (!/github\.com/i.test(url)) {
    await opened.waitForURL(/github\.com/, { timeout: 15_000 }).catch(() => {});
    try {
      url = opened.url();
    } catch {
      await opened.close().catch(() => {});
      return current;
    }
  }

  if (!/github\.com/i.test(url)) {
    await opened.close().catch(() => {});
    return current;
  }

  return opened;
}

/**
 * GitHub sometimes inserts steps before the final Authorize control:
 * - "Reauthorization required" + Continue
 * - Org / repository access checkboxes (must be checked or Authorize stays disabled → timeouts / deny)
 */
async function ensureGitHubOAuthAuthorizePageReady(
  popup: Page,
  depth = 0,
): Promise<Page> {
  if (
    popup.isClosed() ||
    depth > GH_OAUTH_INTERSTITIAL_MAX_DEPTH ||
    !popup.url().includes("/login/oauth/authorize")
  ) {
    return popup;
  }

  const checkboxGroups = [
    popup.locator("form.oauth-authorization-form input[type='checkbox']"),
    popup.locator(".oauth-org-access-details input[type='checkbox']"),
    popup.locator(".oauth-application-summary").locator("input[type='checkbox']"),
  ];

  for (const group of checkboxGroups) {
    const n = await group.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const cb = group.nth(i);
      if (!(await cb.isVisible({ timeout: 200 }).catch(() => false))) {
        continue;
      }
      if (await cb.isChecked().catch(() => false)) {
        continue;
      }
      await cb.check({ force: true }).catch(() => {});
    }
  }

  /** Authorize may be visible but disabled until org scopes / interstitial — treat as "not ready". */
  const hasClickableAuthorizeControl = async (): Promise<boolean> => {
    const selectors = [
      "#oauth-authorization-submit-btn",
      'button[name="authorize"]',
      'input[type="submit"][name="authorize"]',
      "button.js-oauth-authorization-btn",
    ];
    for (const sel of selectors) {
      const loc = popup.locator(sel).first();
      if (
        (await loc.isVisible({ timeout: 400 }).catch(() => false)) &&
        (await loc.isEnabled().catch(() => false))
      ) {
        return true;
      }
    }
    return false;
  };

  const continueBtn = popup.getByRole("button", {
    name: /^(continue|proceed)(\s|$)/i,
  });
  const continueLink = popup.getByRole("link", {
    name: /^(continue|proceed)(\s|$)/i,
  });

  const continueVisible =
    (await continueBtn.first().isVisible({ timeout: 800 }).catch(() => false)) ||
    (await continueLink.first().isVisible({ timeout: 800 }).catch(() => false));

  if (continueVisible && !(await hasClickableAuthorizeControl())) {
    const next = await withOptionalGitHubChildPopup(popup, async () => {
      if (await continueBtn.first().isVisible({ timeout: 400 }).catch(() => false)) {
        await continueBtn.first().click({ force: true });
      } else {
        await continueLink.first().click({ force: true });
      }
    });
    await next.waitForLoadState("domcontentloaded").catch(() => {});
    await sleep(700);
    return ensureGitHubOAuthAuthorizePageReady(next, depth + 1);
  }

  return popup;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function pickGitHubOAuthAuthorizeClickTarget(
  popup: Page,
): Promise<Locator | null> {
  const { user } = getGitHubLoginCredentials();

  const candidates: Locator[] = [];

  const login = user?.trim();
  if (login) {
    const safe = escapeRegExp(login);
    const nameForUser = new RegExp(`^Authorize\\s+${safe}\\b`, "i");
    candidates.push(
      popup.getByRole("button", { name: nameForUser }),
      popup.getByRole("link", { name: nameForUser }),
    );
  }

  candidates.push(
    popup.locator("#oauth-authorization-submit-btn"),
    popup.locator("button.js-oauth-authorization-btn"),
    popup.locator('button[name="authorize"]'),
    popup.locator('input[type="submit"][name="authorize"]'),
    popup.locator('form.oauth-authorization-form button[type="submit"]'),
    popup.locator('[data-test-selector="oauth-authorization-submit-btn"]'),
    popup.getByRole("button", { name: /^authorize\b/i }),
    popup.getByRole("button", { name: /authorize/i }),
    popup.getByRole("link", { name: /authorize/i }),
  );

  for (const loc of candidates) {
    const el = loc.first();
    if (await el.isVisible({ timeout: 1200 }).catch(() => false)) {
      return el;
    }
  }
  return null;
}

/**
 * GitHub OAuth consent (`/login/oauth/authorize`).
 * Use exactly one click on the first matching control — the old loop could click candidate A, stay on
 * the page while navigation was still in flight, then click candidate B (e.g. Cancel / duplicate),
 * which intermittently produced `error=access_denied`.
 */
async function approveGitHubOAuthConsent(popup: Page): Promise<[boolean, Page]> {
  if (popup.isClosed()) {
    return [false, popup];
  }
  if (!popup.url().includes("/login/oauth/authorize")) {
    return [false, popup];
  }

  throwIfGitHubOAuthErrorInUrl(popup);

  let active = await ensureGitHubOAuthAuthorizePageReady(popup);

  let target = await pickGitHubOAuthAuthorizeClickTarget(active);
  if (!target) {
    await sleep(1200);
    active = await ensureGitHubOAuthAuthorizePageReady(active);
    target = await pickGitHubOAuthAuthorizeClickTarget(active);
  }
  if (!target) {
    return [false, active];
  }

  try {
    await expect(target).toBeEnabled({ timeout: 30_000 });
  } catch {
    /* GitHub may keep the button in a weird half-enabled state while org scope loads */
  }

  const authorizeEl = target;
  active = await withOptionalGitHubChildPopup(active, async () => {
    await authorizeEl.click({ force: true });
  });
  await active.waitForLoadState("domcontentloaded").catch(() => {});

  await Promise.race([
    active.waitForURL(/\/api\/auth\/github\/handler/, { timeout: 60_000 }),
    active.waitForURL(
      (u) => {
        const href = typeof u === "string" ? u : u.href;
        return (
          !href.includes("/login/oauth/authorize") || href.includes("error=")
        );
      },
      { timeout: 60_000 },
    ),
  ]).catch(() => {});

  throwIfGitHubOAuthErrorInUrl(active);

  return [!active.url().includes("/login/oauth/authorize"), active];
}

async function approveOAuthConsentUntilRedirect(popup: Page): Promise<Page> {
  let current = popup;
  for (let attempt = 0; attempt < 15 && !current.isClosed(); attempt++) {
    assertGitHubPopupCompletable(current, "before OAuth consent");
    throwIfGitHubOAuthErrorInUrl(current);
    if (!current.url().includes("/login/oauth/authorize")) {
      return current;
    }
    const [, nextPage] = await approveGitHubOAuthConsent(current);
    current = nextPage;
    throwIfGitHubOAuthErrorInUrl(current);
    if (!current.url().includes("/login/oauth/authorize")) {
      return current;
    }
    await sleep(1200);
  }

  if (!current.isClosed() && current.url().includes("/login/oauth/authorize")) {
    await logGitHubAuthorizeBanner(current);
    // eslint-disable-next-line no-console
    console.warn(
      "[bulk-import e2e] Still on /login/oauth/authorize after consent retries — register exact callback on the GitHub OAuth App (…/api/auth/github/handler/frame), org approval for the app, or UI changed.",
    );
  }
  return current;
}

const OTP_SINGLE_SELECTORS = [
  "#app_totp",
  "#otp",
  'input[name="otp"]',
  'input[name="app_otp"]',
  'input[autocomplete="one-time-code"]',
  "input.FormControl-input",
  ".js-two-factor-input input",
  ".two-factor-input input",
];

/** GitHub may render one `<input>` or six single-digit boxes; OTP may live in an iframe. */
async function findGitHubTotpTarget(
  popup: Page,
): Promise<
  | { mode: "single"; locator: Locator }
  | { mode: "six"; locators: Locator }
  | null
> {
  const roots: (Page | Frame)[] = [
    popup,
    ...popup.frames().filter((f) => f !== popup.mainFrame()),
  ];

  for (const root of roots) {
    for (const sel of OTP_SINGLE_SELECTORS) {
      const loc = root.locator(sel).first();
      if (await loc.isVisible({ timeout: 800 }).catch(() => false)) {
        return { mode: "single", locator: loc };
      }
    }

    const sixRow = root.locator(
      [
        "input.js-verification-code-char",
        ".js-verification-code-char-wrap input",
        'input[maxlength="1"][type="text"]',
        'fieldset[data-testid="otp-input"] input',
      ].join(", "),
    );
    const count = await sixRow.count().catch(() => 0);
    if (count >= 6) {
      if (
        await sixRow
          .first()
          .isVisible({ timeout: 1500 })
          .catch(() => false)
      ) {
        return { mode: "six", locators: sixRow };
      }
    }
  }

  const fallback = popup.locator(OTP_SINGLE_SELECTORS.join(", ")).first();
  try {
    await fallback.waitFor({ state: "visible", timeout: 20_000 });
    return { mode: "single", locator: fallback };
  } catch {
    return null;
  }
}

/**
 * Authenticator TOTP — `LoginHelper.getGitHub2FAOTP` + `VAULT_GH_2FA_SECRET`.
 */
async function submitGitHubTotpIfPresent(popup: Page, user: string) {
  await popup
    .waitForURL(/github\.com\/(sessions\/two-factor|login\/two-factor)/, {
      timeout: 35_000,
    })
    .catch(() => {});

  if (!/\/sessions\/two-factor|\/login\/two-factor/i.test(popup.url())) {
    return;
  }

  await sleep(400);

  const loginHelper = new LoginHelper(popup);
  try {
    loginHelper.getGitHub2FAOTP(user);
  } catch (e) {
    const msg =
      e instanceof Error ? e.message : String(e);
    throw new Error(
      `[bulk-import e2e] GitHub 2FA page is shown but OTP cannot be generated (check VAULT_GH_USER_ID vs login user and VAULT_GH_2FA_SECRET): ${msg}`,
    );
  }

  const fillAndSubmit = async () => {
    const code = loginHelper.getGitHub2FAOTP(user);
    const target = await findGitHubTotpTarget(popup);
    if (!target) {
      throw new Error(
        `[bulk-import e2e] GitHub 2FA URL but no OTP input found: ${popup.url()}`,
      );
    }

    if (target.mode === "single") {
      await target.locator.scrollIntoViewIfNeeded().catch(() => {});
      await target.locator.click({ timeout: 3000 }).catch(() => {});
      await target.locator.fill("", { force: true });
      await target.locator.fill(code, { force: true });
      await target.locator.press("Enter").catch(() => {});
    } else {
      const digits = code.replace(/\s/g, "");
      const n = await target.locators.count();
      const len = Math.min(6, digits.length, n);
      for (let i = 0; i < len; i++) {
        await target.locators.nth(i).fill(digits[i]!, { force: true });
      }
    }

    // Whole words only — `/next/i` must not match "cyberbitnext" on the OAuth Authorize button.
    const primary = popup.getByRole("button", {
      name: /\b(verify|continue|next|submit)\b/i,
    });
    if (
      await primary
        .first()
        .isVisible({ timeout: 2500 })
        .catch(() => false)
    ) {
      await primary.first().click();
    }

    await popup.waitForLoadState("domcontentloaded").catch(() => {});
    await popup
      .waitForLoadState("networkidle", { timeout: 15_000 })
      .catch(() => {});
  };

  for (let attempt = 0; attempt < 5; attempt++) {
    if (!/\/sessions\/two-factor|\/login\/two-factor/i.test(popup.url())) {
      break;
    }

    await fillAndSubmit();
    await sleep(1500);

    const stale = popup.getByText(
      /two-factor code you entered has already been used|too many codes have been submitted/i,
    );
    if (await stale.isVisible({ timeout: 2500 }).catch(() => false)) {
      await sleep(4000);
      continue;
    }

    if (!/\/sessions\/two-factor|\/login\/two-factor/i.test(popup.url())) {
      break;
    }
  }

  // eslint-disable-next-line no-console
  console.log("[bulk-import e2e] After GitHub TOTP:", popup.url());
}

async function submitGitHubLoginForm(popup: Page, user: string, pass: string) {
  await popup.locator('input[name="login"]').fill(user);
  await popup.locator('input[name="password"]').fill(pass);

  const signIn = popup.getByRole("button", { name: /^sign in$/i });
  const commitSubmit = popup.locator(
    'input[type="submit"][name="commit"], input[type="submit"][data-sign-in-label]',
  );

  if (await signIn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await signIn.click();
  } else if (
    await commitSubmit
      .first()
      .isVisible({ timeout: 2000 })
      .catch(() => false)
  ) {
    await commitSubmit.first().click();
  } else {
    await popup.locator('input[type="submit"]').first().click();
  }

  await popup.waitForLoadState("domcontentloaded").catch(() => {});
  await popup
    .waitForURL(
      /github\.com\/(sessions\/two-factor|login\/two-factor|login\/oauth\/authorize)/,
      { timeout: 40_000 },
    )
    .catch(() => {});

  await submitGitHubTotpIfPresent(popup, user);

  assertGitHubPopupCompletable(popup, "after GitHub password submit");

  if (
    popup.url().includes("github.com/login") &&
    (await popup
      .locator('input[name="login"]')
      .isVisible({ timeout: 800 })
      .catch(() => false))
  ) {
    const flash = popup
      .locator(".js-flash-alert, .flash-error, [role='alert']")
      .first();
    const flashText = await flash.innerText().catch(() => "");
    if (flashText.trim()) {
      // eslint-disable-next-line no-console
      console.warn(
        "[bulk-import e2e] GitHub login page message:",
        flashText.trim(),
      );
    }
  }
}

/** GitHub browser-login credentials (Vault naming preferred in CI). */
export function getGitHubLoginCredentials(): {
  user: string | undefined;
  pass: string | undefined;
} {
  const user =
    process.env.VAULT_GH_USER_ID?.trim() || process.env.GITHUB_USERNAME?.trim();
  const pass =
    process.env.VAULT_GH_USER_PASS?.trim() ||
    process.env.GITHUB_PASSWORD?.trim();
  return { user, pass };
}

function isGitHubOAuthAccessDeniedError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    msg.includes("access_denied") ||
    msg.includes("denied your application access")
  );
}

/**
 * Handles Bulk Import "Login Required" → GitHub OAuth popup.
 * Logs the popup URL so CI logs show what GitHub rendered (consent vs login form).
 * Prefers Authorize / Install / Continue over credential login; completes credentials + 2FA when needed.
 * Throws if the OAuth flow does not finish and the Login Required dialog stays open.
 * Retries the full flow when GitHub returns `access_denied` (race / duplicate-click flake).
 */
export async function handleGitHubAuthDialogIfPresent(
  page: Page,
  waitForDialogMs = 4000,
): Promise<void> {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await completeBulkImportGitHubOAuthOnce(page, waitForDialogMs);
      return;
    } catch (e) {
      if (isGitHubOAuthAccessDeniedError(e) && attempt < maxAttempts) {
        // eslint-disable-next-line no-console
        console.warn(
          `[bulk-import e2e] GitHub OAuth access_denied (attempt ${attempt}/${maxAttempts}), retrying Log in flow.`,
        );
        await sleep(2500);
        continue;
      }
      throw e instanceof Error ? e : new Error(String(e));
    }
  }
}

async function completeBulkImportGitHubOAuthOnce(
  page: Page,
  waitForDialogMs: number,
): Promise<void> {
  const loginDialog = page.getByRole("dialog", { name: "Login Required" });
  const appeared = await loginDialog
    .waitFor({ state: "visible", timeout: waitForDialogMs })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    return;
  }

  const loginTrigger = loginDialog.getByRole("button", { name: "Log in" });
  if (!(await loginTrigger.isVisible({ timeout: 3000 }).catch(() => false))) {
    throw new Error(
      "[bulk-import e2e] Login Required dialog is open but the Log in control is not available.",
    );
  }

  let popup: Page;
  try {
    [popup] = await Promise.all([
      page.waitForEvent("popup", { timeout: 60_000 }),
      loginTrigger.click(),
    ]);
  } catch {
    throw new Error(
      "[bulk-import e2e] GitHub OAuth popup did not open after clicking Log in.",
    );
  }

  await popup.waitForLoadState("domcontentloaded");
  // eslint-disable-next-line no-console
  console.log("[bulk-import e2e] GitHub OAuth popup opened:", popup.url());

  const { user, pass } = getGitHubLoginCredentials();

  try {
    assertGitHubPopupCompletable(popup, "popup opened");

    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline && !popup.isClosed()) {
      assertGitHubPopupCompletable(popup, "initial OAuth loop");
      if (popup.url().includes("/login/oauth/authorize")) {
        popup = await approveOAuthConsentUntilRedirect(popup);
        break;
      }

      const authorizeBtn = popup
        .getByRole("button", { name: /authorize/i })
        .first();
      const installBtn = popup
        .getByRole("button", { name: /^install\b/i })
        .first();
      const continueBtn = popup
        .getByRole("button", { name: /^continue\b/i })
        .first();
      const loginField = popup.locator('input[name="login"]');

      if (await authorizeBtn.isVisible({ timeout: 400 }).catch(() => false)) {
        popup = await withOptionalGitHubChildPopup(popup, async () => {
          await authorizeBtn.click();
        });
        await popup.waitForLoadState("domcontentloaded").catch(() => {});
        break;
      }
      if (await installBtn.isVisible({ timeout: 400 }).catch(() => false)) {
        popup = await withOptionalGitHubChildPopup(popup, async () => {
          await installBtn.click();
        });
        await popup.waitForLoadState("domcontentloaded").catch(() => {});
        break;
      }
      if (await continueBtn.isVisible({ timeout: 400 }).catch(() => false)) {
        popup = await withOptionalGitHubChildPopup(popup, async () => {
          await continueBtn.click();
        });
        await popup.waitForLoadState("domcontentloaded").catch(() => {});
        break;
      }
      if (await loginField.isVisible({ timeout: 400 }).catch(() => false)) {
        break;
      }
      await sleep(350);
    }

    if (
      user &&
      pass &&
      (await popup
        .locator('input[name="login"]')
        .isVisible({ timeout: 5000 })
        .catch(() => false))
    ) {
      await submitGitHubLoginForm(popup, user, pass);
      // eslint-disable-next-line no-console
      console.log(
        "[bulk-import e2e] After GitHub credential submit:",
        popup.url(),
      );

      await popup
        .waitForURL(/github\.com\/(login\/oauth\/authorize|sessions\/oauth)/, {
          timeout: 60_000,
        })
        .catch(() => {});

      popup = await approveOAuthConsentUntilRedirect(popup);
    }

    if (!popup.isClosed() && popup.url().includes("/login/oauth/authorize")) {
      popup = await approveOAuthConsentUntilRedirect(popup);
    }

    assertGitHubPopupCompletable(popup, "before waiting for OAuth redirect");

    if (!popup.isClosed()) {
      await Promise.race([
        popup.waitForEvent("close", { timeout: 120_000 }),
        popup.waitForURL(/\/api\/auth\/github\/handler/, { timeout: 120_000 }),
      ]).catch(() => {});
    }

    if (!popup.isClosed() && /\/api\/auth\/github\/handler/.test(popup.url())) {
      await popup.waitForEvent("close", { timeout: 90_000 }).catch(() => {});
    }

    if (!popup.isClosed()) {
      // eslint-disable-next-line no-console
      console.log(
        "[bulk-import e2e] GitHub popup still open after wait:",
        popup.url(),
      );
      await popup.close().catch(() => {});
    }
  } catch (e) {
    if (!popup.isClosed()) {
      await popup.close().catch(() => {});
    }
    throw e instanceof Error ? e : new Error(String(e));
  }

  await loginDialog.waitFor({ state: "hidden", timeout: 60_000 });
}
