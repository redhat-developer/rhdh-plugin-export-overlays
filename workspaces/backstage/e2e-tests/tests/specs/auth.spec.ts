import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";

const isNightlyMode =
  !!process.env.E2E_NIGHTLY_MODE ||
  (process.env.JOB_NAME?.includes("periodic-") ?? false);

test.describe("Auth plugin", () => {
  test.beforeAll(async ({ rhdh }) => {
    await rhdh.configure({
      auth: "guest",
      appConfig: "tests/config/auth/app-config-rhdh.yaml",
      dynamicPlugins: "tests/config/auth/dynamic-plugins.yaml",
    });
    await rhdh.deploy();
  });

  test.beforeEach(async ({ loginHelper }) => {
    await loginHelper.loginAsGuest();
  });

  test("Verify auth plugin renders on /oauth2 route", async ({ page }) => {
    test.skip(
      isNightlyMode,
      "auth plugin dynamic route /oauth2/* not registered (RHDHBUGS-3357)",
    );
    await page.goto("/oauth2/authorize/test-session");
    // 400 is expected — we don't have a real OAuth token, but the error
    // confirms the auth plugin loaded and the backend rejected the session.
    await expect(page.getByText("Authorization Error")).toBeVisible();
    await expect(page.getByText("HTTP 400: Bad Request")).toBeVisible();
  });
});
