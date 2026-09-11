import { expect, type Locator, type Page } from "@playwright/test";
import type { UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";

/**
 * GitLab OAuth popup login (ported from RHDH core Common.gitlabLogin).
 * Not yet on LoginHelper in e2e-test-utils.
 */
export async function gitlabLogin(
  page: Page,
  uiHelper: UIhelper,
  username: string,
  password: string,
): Promise<string> {
  await page.goto("/");
  await page.waitForSelector('p:has-text("Sign in using GitLab")');

  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    uiHelper.clickButton("Sign In"),
  ]);

  await expect(async () => {
    await popup.waitForLoadState("domcontentloaded");
  }).toPass({
    intervals: [5_000, 10_000],
    timeout: 20_000,
  });

  try {
    await popup.waitForEvent("close", { timeout: 5000 });
    return "Already logged in";
  } catch {
    // Popup stayed open — continue with credentials.
  }

  await popup.locator("#user_login").click({ timeout: 5000 });
  await popup.locator("#user_login").fill(username, { timeout: 5000 });
  await popup.locator("#user_password").click({ timeout: 5000 });
  await popup.locator("#user_password").fill(password, { timeout: 5000 });
  await popup.getByTestId("sign-in-button").click({ timeout: 5000 });

  await popup
    .waitForLoadState("domcontentloaded", { timeout: 10_000 })
    .catch(() => undefined);

  if (popup.isClosed()) {
    return "Login successful";
  }

  const twoFactorInput = popup.locator("#user_otp_attempt");
  if (await twoFactorInput.isVisible({ timeout: 5000 }).catch(() => false)) {
    await popup.waitForEvent("close", { timeout: 20_000 });
    return "Login successful";
  }

  // GitLab EE button text is "Authorize <app-name>"; prefer role + testid.
  const authorizeCandidates: Locator[] = [
    popup.getByRole("button", { name: /Authorize/ }),
    popup.getByTestId("authorize-button"),
    popup.locator('button:has-text("Authorize")'),
  ];

  let buttonToClick: Locator | undefined;
  await expect(async () => {
    buttonToClick = undefined;
    for (const candidate of authorizeCandidates) {
      if (await candidate.isVisible({ timeout: 2000 }).catch(() => false)) {
        buttonToClick = candidate;
        break;
      }
    }
    if (buttonToClick) {
      await buttonToClick.waitFor({ state: "visible", timeout: 5000 });
      await expect(buttonToClick).toBeEnabled({ timeout: 10_000 });
      await buttonToClick.scrollIntoViewIfNeeded({ timeout: 5000 });
      return;
    }
    if (popup.isClosed()) {
      return;
    }
    throw new Error("Authorization button not found");
  }).toPass({
    intervals: [1000, 2000],
    timeout: 15_000,
  });

  if (!buttonToClick) {
    if (popup.isClosed()) {
      return "Login successful";
    }
    throw new Error("Failed to find authorization button");
  }

  await popup
    .getByRole("document")
    .click({ timeout: 1000 })
    .catch(() => undefined);

  try {
    await buttonToClick.click({ timeout: 5000 });
  } catch {
    await buttonToClick.click({ force: true, timeout: 5000 });
  }

  try {
    await popup.waitForEvent("close", { timeout: 20_000 });
  } catch {
    if (!popup.isClosed()) {
      throw new Error("GitLab login popup did not close after sign-in");
    }
  }
  return "Login successful";
}
