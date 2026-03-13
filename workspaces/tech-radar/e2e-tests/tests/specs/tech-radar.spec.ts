import { test, expect, Page } from "@red-hat-developer-hub/e2e-test-utils/test";
import { $ } from "@red-hat-developer-hub/e2e-test-utils/utils";
import path from "path";

const secretsFileAppNext = "tests/config/rhdh-secrets-next.yaml";
const configFileAppNext = "tests/config/app-config-rhdh-next.yaml";
const setupScript = path.join(
  import.meta.dirname,
  "deploy-customization-provider.sh",
);

test.describe("Test tech-radar plugin", () => {
  test.beforeAll(async ({ rhdh }) => {
    const project = rhdh.deploymentConfig.namespace;
    await rhdh.configure({
      auth: "keycloak",
      ...(project === "tech-radar-app-next" && {
        appConfig: configFileAppNext,
        secrets: secretsFileAppNext,
      }),
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
  });
});

async function verifyRadarDetails(page: Page, section: string, text: string) {
  const sectionLocator = page
    .locator(`h2:has-text("${section}")`)
    .locator("xpath=ancestor::*")
    .locator(`text=${text}`);
  await sectionLocator.scrollIntoViewIfNeeded();
  await expect(sectionLocator).toBeVisible();
}
