import { test, expect, Page } from "@red-hat-developer-hub/e2e-test-utils/test";
import { $ } from "@red-hat-developer-hub/e2e-test-utils/utils";
import path from "path";

const setupScript = path.join(
  import.meta.dirname,
  "deploy-customization-provider.sh",
);

test.describe("Test tech-radar plugin", () => {
  test.beforeAll(async ({ rhdh }) => {
    const project = rhdh.deploymentConfig.namespace;
    // This skip can be removed once the tech-radar wrapper is removed
    test.skip(
      project === "tech-radar-app-next" &&
        process.env.E2E_NIGHTLY_MODE === "true",
      "app-next not ready for nightly",
    );
    await rhdh.configure({
      auth: "keycloak",
    });
    await $`bash ${setupScript} ${project}`;
    process.env.TECH_RADAR_DATA_URL = (
      await rhdh.k8sClient.getRouteLocation(
        project,
        "test-backstage-customization-provider",
      )
    ).replace("http://", "");
    await rhdh.deploy();
  });

  test.beforeEach(async ({ loginHelper }) => {
    await loginHelper.loginAsKeycloakUser();
  });

  test("Verify tech-radar", async ({ page, uiHelper }) => {
    await uiHelper.openSidebar("Tech Radar");
    await uiHelper.verifyHeading("Tech Radar");
    await uiHelper.verifyHeading("Company Radar");

    await verifyRadarDetails(page, "Languages", "JavaScript");
    // TODO: This is cluster-dependent and we need tests cluster-agnostic, remove if not needed
    // await verifyRadarDetails(page, "Storage", "AWS S3");
    await verifyRadarDetails(page, "Frameworks", "React");
    await verifyRadarDetails(page, "Infrastructure", "GitHub Actions");

    // Diagnostic only: confirm whether the JS bundles RHDH actually SERVES at
    // runtime are the instrumented ones. The `__coverage` image instruments the
    // plugin's `dist/` (and now `dist-scalprum/`), but if RHDH serves/regenerates
    // a different bundle, `window.__coverage__` is never created. The probe fetches
    // the served Module Federation and Scalprum entry points and reports whether
    // they contain Istanbul markers. No-op outside coverage mode; never fails.
    await probeServedAssetsForInstrumentation(page);
  });
});

async function probeServedAssetsForInstrumentation(page: Page) {
  if (
    process.env.E2E_COLLECT_COVERAGE !== "true" &&
    process.env.E2E_COLLECT_COVERAGE !== "1"
  ) {
    return;
  }

  const origin = new URL(page.url()).origin;

  // Report whether a fetched JS body carries Istanbul instrumentation.
  const reportBody = (url: string, body: string) => {
    const hasCoverageVar = body.includes("__coverage__");
    const hasCovFn = /cov_[a-z0-9]+\(\)/.test(body);
    const hasUnfixedGlobal = body.includes('new Function("return this")');
    console.warn(
      `[coverage-probe] instrumented=${hasCoverageVar && hasCovFn} __coverage__=${hasCoverageVar} cov_fn=${hasCovFn} unfixedGlobal=${hasUnfixedGlobal} bytes=${body.length} <- ${url}`,
    );
  };

  const fetchText = async (url: string): Promise<string | null> => {
    try {
      const res = await page.request.get(url);
      if (!res.ok()) {
        console.warn(`[coverage-probe] HTTP ${res.status()} <- ${url}`);
        return null;
      }
      return await res.text();
    } catch (err) {
      console.warn(`[coverage-probe] fetch failed for ${url}: ${err}`);
      return null;
    }
  };

  // 1) Module Federation entry point (served from the plugin's dist/).
  const remoteEntry = `${origin}/dynamic-features/remotes/@backstage-community/plugin-tech-radar-dynamic/remoteEntry.js`;
  const remoteEntryBody = await fetchText(remoteEntry);
  if (remoteEntryBody !== null) reportBody(remoteEntry, remoteEntryBody);

  // 2) Scalprum bundle (served from the plugin's dist-scalprum/): discover the
  //    actual hashed script name from the plugin manifest, then fetch it.
  const scalprumBase = `${origin}/api/scalprum/backstage-community.plugin-tech-radar`;
  const manifestBody = await fetchText(`${scalprumBase}/plugin-manifest.json`);
  if (manifestBody !== null) {
    try {
      const manifest = JSON.parse(manifestBody) as { loadScripts?: string[] };
      for (const script of manifest.loadScripts ?? []) {
        const scriptUrl = `${scalprumBase}/${script}`;
        const scriptBody = await fetchText(scriptUrl);
        if (scriptBody !== null) reportBody(scriptUrl, scriptBody);
      }
    } catch (err) {
      console.warn(
        `[coverage-probe] could not parse scalprum manifest: ${err}`,
      );
    }
  }
}

async function verifyRadarDetails(page: Page, section: string, text: string) {
  const sectionLocator = page
    .locator(`h2:has-text("${section}")`)
    .locator("xpath=ancestor::*")
    .locator(`text=${text}`);
  await sectionLocator.scrollIntoViewIfNeeded();
  await expect(sectionLocator).toBeVisible();
}
