import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";

/*
 * Segment uses @segment/analytics-next (bundled). AnalyticsBrowser.load()
 * first fetches project settings from cdn.segment.com/v1/projects/{key}/settings,
 * then analytics.page() and analytics.track() send JSON payloads to api.segment.io.
 *
 * We mock the CDN settings endpoint with a minimal valid response and intercept
 * api.segment.io requests to verify the correct analytics payloads are sent.
 */

/* eslint-disable @typescript-eslint/naming-convention */
const SEGMENT_SETTINGS_RESPONSE = {
  integrations: {
    "Segment.io": {
      apiKey: "test-segment-write-key-e2e",
      unbundledIntegrations: [],
      addBundledMetadata: true,
      mapiEndpoint: "https://api.segment.io",
      apiHost: "api.segment.io/v1",
    },
  },
  plan: {
    track: { __default: { enabled: true, integrations: {} } },
    identify: { __default: { enabled: true } },
    group: { __default: { enabled: true } },
  },
  edgeFunction: {},
  analyticsNextEnabled: true,
  middlewareSettings: {},
  enabledMiddleware: {},
  metrics: { sampleRate: 0 },
  legacyVideoPluginsEnabled: false,
  remotePlugins: [],
};
/* eslint-enable @typescript-eslint/naming-convention */

test.describe("Test Segment Analytics Plugin", () => {
  test.beforeAll(async ({ rhdh }) => {
    await rhdh.configure({ auth: "guest" });
    await rhdh.deploy();
  });

  test("Verify analytics events are sent to Segment on navigation", async ({
    page,
    loginHelper,
    uiHelper,
  }) => {
    await page.route("**/cdn.segment.com/**", (route) => {
      if (route.request().url().includes("/settings")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(SEGMENT_SETTINGS_RESPONSE),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: "/* mock */",
      });
    });

    const segmentRequests: {
      url: string;
      method: string;
      body: Record<string, unknown> | null;
    }[] = [];

    await page.route("**/api.segment.io/**", (route) => {
      let body: Record<string, unknown> | null = null;
      const postData = route.request().postData();
      if (postData) {
        try {
          body = JSON.parse(postData) as Record<string, unknown>;
        } catch {
          /* raw post data, not JSON */
        }
      }

      segmentRequests.push({
        url: route.request().url(),
        method: route.request().method(),
        body,
      });

      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      });
    });

    await loginHelper.loginAsGuest();
    await uiHelper.openSidebar("Catalog");
    await uiHelper.clickLink("Red Hat Developer Hub");

    await expect
      .poll(() => segmentRequests.length, {
        message: "Waiting for Segment API requests",
        timeout: 10_000,
      })
      .toBeGreaterThan(0);

    const pageRequests = segmentRequests.filter((r) => r.url.includes("/v1/p"));
    expect(pageRequests.length).toBeGreaterThan(0);
  });
});
