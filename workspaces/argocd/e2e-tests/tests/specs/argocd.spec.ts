import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import { $ } from "@red-hat-developer-hub/e2e-test-utils/utils";
import path from "path";
import {
  navigateToComponent,
  expandAllSections,
  switchFilter,
  toggleCheckboxFilter,
  rowByNameAndKind,
} from "./argocd-helper";

const setupScript = path.join(
  import.meta.dirname,
  "deploy-openshift-gitops.sh",
);
const $pipe = $({ stdio: "pipe" });

test.describe("Test ArgoCD plugin", () => {
  test.beforeAll(async ({ rhdh }) => {
    test.setTimeout(900_000);

    await test.runOnce("argocd-infra", async () => {
      const namespace = rhdh.deploymentConfig.namespace;
      await $`bash ${setupScript} ${namespace}`;
    });

    const argoRoute = await rhdh.k8sClient.getRouteLocation(
      "openshift-gitops",
      "openshift-gitops-server",
    );

    const jsonpath = String.raw`{.data.admin\.password}`;
    const secretResult =
      await $pipe`oc get secret openshift-gitops-cluster -n openshift-gitops -o jsonpath=${jsonpath}`;
    const argoPassword = Buffer.from(
      secretResult.stdout.trim(),
      "base64",
    ).toString();

    process.env.ARGOCD_INSTANCE1_URL = argoRoute;
    process.env.ARGOCD_USERNAME = "admin";
    process.env.ARGOCD_PASSWORD = argoPassword;

    await rhdh.configure({ auth: "keycloak" });
    await rhdh.deploy({ timeout: 900_000 });
  });

  test.beforeEach(async ({ page, loginHelper, uiHelper }) => {
    await loginHelper.loginAsKeycloakUser();
    await navigateToComponent(page, uiHelper);
    await uiHelper.clickTab("CD");
    await uiHelper.clickByDataTestId("test-argocd-app-card");
  });

  test("Verify deployment summary card and drawer close button", async ({
    page,
    uiHelper,
  }) => {
    await uiHelper.clickButtonByLabel("Close the drawer");

    const card = page.getByTestId("test-argocd-app-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("test-argocd-app");
    await expect(card).toContainText("Synced");
    await expect(card).toContainText(/Healthy|Degraded/);
  });

  test("Verify app drawer shows instance details", async ({ uiHelper }) => {
    await uiHelper.verifyHeading("test-argocd-app");
    await uiHelper.verifyText("Synced");
    await uiHelper.verifyText(/Healthy|Degraded/);
    await uiHelper.verifyText("argoInstance1");
    await uiHelper.verifyText("https://kubernetes.default.svc", false);
    await uiHelper.verifyText("argocd");
  });

  test("Verify resources table lists expected resources", async ({
    page,
    uiHelper,
  }) => {
    await uiHelper.verifyText("Resources");

    await uiHelper.clickButtonByLabel("rows");
    await page.getByRole("option", { name: "10 rows" }).click();

    await uiHelper.verifyColumnHeading([
      "Name",
      "Kind",
      "Sync status",
      "Health status",
    ]);

    await uiHelper.verifyRowInTableByUniqueText("always-pass", [
      "AnalysisTemplate",
      "Synced",
    ]);
    await uiHelper.verifyRowInTableByUniqueText("random-fail", [
      "AnalysisTemplate",
      "Synced",
    ]);
    await uiHelper.verifyRowInTableByUniqueText("rollout-bluegreen-active", [
      "Service",
      "Synced",
      "Healthy",
    ]);
    await uiHelper.verifyRowInTableByUniqueText("rollout-bluegreen-preview", [
      "Service",
      "Synced",
      "Healthy",
    ]);
    await uiHelper.verifyRowInTableByUniqueText("rollout-bluegreen", [
      /Rollout/,
      /Synced/,
      /Healthy|Degraded/,
    ]);

    const row = (name: string, kind: string) =>
      rowByNameAndKind(page, name, kind);

    await expect(row("canary-rollout-analysis", "Service")).toBeVisible();
    await expect(row("canary-rollout-analysis", "Rollout")).toBeVisible();
    await expect(row("test-argocd-app", "Service")).toBeVisible();
    await expect(row("test-argocd-app", "Deployment")).toBeVisible();
  });

  test("Verify resources table filters by Kind, Name, Sync and Health status", async ({
    page,
    uiHelper,
  }) => {
    await uiHelper.verifyText("Resources");

    const toolbar = page.locator("#toolbar-with-filter");

    await switchFilter(page, "Filter by", "Kind");
    await toggleCheckboxFilter(page, "Kind", ["AnalysisTemplate", "Rollout"]);

    await expect(toolbar).toContainText("Filter by Kind 2");
    await uiHelper.verifyCellsInTable(["AnalysisTemplate", "Rollout"]);
    for (const kind of ["Service", "Deployment"]) {
      await expect(page.getByRole("cell", { name: kind })).toHaveCount(0);
    }

    await uiHelper.clickButtonByLabel("Clear all filters");
    await uiHelper.verifyCellsInTable(["Service"]);

    await switchFilter(page, "Kind", "Name");
    await page.getByRole("textbox", { name: "Search by name" }).fill("active");
    await uiHelper.verifyRowsInTable(["rollout-bluegreen-active"]);
    await uiHelper.clickButtonByLabel("Reset");

    await switchFilter(page, "Name", "Sync status");
    await uiHelper.clickButtonByLabel("Filter by Sync status");
    for (const status of ["Synced", "OutOfSync", "Unknown"]) {
      await expect(page.getByRole("menuitem", { name: status })).toBeVisible();
    }
    await uiHelper.clickButtonByLabel("Filter by Sync status");

    for (const status of ["OutOfSync", "Unknown"]) {
      await toggleCheckboxFilter(page, "Sync status", [status]);
      await expect(toolbar).toContainText("Filter by Sync status 1");
      await uiHelper.verifyText("No Resources found");
      await uiHelper.clickButtonByLabel("Clear all filters");
    }

    await switchFilter(page, "Sync status", "Health status");
    await uiHelper.clickByDataTestId("health-status-toggle");
    for (const status of [
      "Healthy",
      "Degraded",
      "Suspended",
      "Progressing",
      "Missing",
      "Unknown",
    ]) {
      await expect(page.getByRole("menuitem", { name: status })).toBeVisible();
    }
    await uiHelper.clickByDataTestId("health-status-toggle");
  });

  test("Verify deployment lifecycle on CD tab shows revisions", async ({
    uiHelper,
  }) => {
    await uiHelper.verifyText(/Revision \d+/);
  });

  test("Verify bluegreen rollout details and analysis runs", async ({
    page,
  }) => {
    await expandAllSections(page);

    const bluegreen = page.locator('[data-testid^="rollout-bluegreen-"]');
    await expect(
      bluegreen.getByText(/Traffic to image argoproj\//).first(),
    ).toBeVisible();
    await expect(bluegreen.getByText("Stable").first()).toBeVisible();
    await expect(bluegreen.getByText("Analysis Runs").first()).toBeVisible();
    await expect(bluegreen.getByText(/Analysis \d+-pre/).first()).toBeVisible();
  });

  test("Verify canary rollout details and analysis runs", async ({ page }) => {
    await expandAllSections(page);

    const canary = page.locator('[data-testid^="canary-rollout-analysis-"]');
    await expect(canary.getByText("Stable").first()).toBeVisible();
    await expect(
      canary.getByText(/Traffic to image argoproj\//).first(),
    ).toBeVisible();
    await expect(canary.getByText("Analysis Runs").first()).toBeVisible();
    await expect(canary.getByText(/Analysis \d+-/).first()).toBeVisible();
  });
});
