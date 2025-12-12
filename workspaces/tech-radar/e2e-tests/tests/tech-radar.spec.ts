import { test, expect } from "rhdh-e2e-test-utils/test";
import { $ } from "rhdh-e2e-test-utils/utils";
import path from "path";

const setupScript = path.join(import.meta.dirname, "tech-radar-setup.sh");

test.describe("Tech Radar e2e tests", () => {
  test.beforeAll(async ({ rhdh }, ) => {
    await rhdh.configure();
    const project = rhdh.deploymentConfig.namespace;

    await $`bash ${setupScript} ${project}`;

    process.env.DH_TARGET_URL = (await rhdh.k8sClient.getRouteLocation(
      project,
      "test-backstage-customization-provider",
    )).replace("http://", "");



    await rhdh.deploy();
  });

  test("Tech Radar e2e test", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Enter" }).click(); // Login as guest user
    await page.getByRole("button", { name: "Hide" }).click();
    await page.getByRole("link", { name: "Tech Radar" }).click(); // Navigate to Tech Radar page

    // Verify that the page contains the title "Company Radar"
    await expect(page.getByTestId("header-title")).toContainText(
      "Company Radar"
    );
  });

});
