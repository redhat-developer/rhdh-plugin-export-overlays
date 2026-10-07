import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";

test.describe("Auth plugin", { tag: "@auth-tests" }, () => {
  test.skip(
    !!process.env.E2E_NIGHTLY_MODE,
    "RHDH init container crashes -- missing OCI tag quay.io/rhdh/backstage-plugin-org:2.1.0--0.7.8 in catalog-index default plugins",
  );

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
    await page.goto("/oauth2/authorize/test-session");
    // 400 is expected — we don't have a real OAuth token, but the error
    // confirms the auth plugin loaded and the backend rejected the session.
    await expect(page.getByText("Authorization Error")).toBeVisible();
    await expect(page.getByText("HTTP 400: Bad Request")).toBeVisible();
  });
});
