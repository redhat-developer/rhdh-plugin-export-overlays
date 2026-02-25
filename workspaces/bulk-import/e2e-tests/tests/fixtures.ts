/**
 * Custom Playwright test with RHDH fixtures.
 * Uses standard @playwright/test so timeout is not overridden by rhdh-e2e-test-utils (500s).
 */
import { test as base } from "@playwright/test";
import { RHDHDeployment } from "rhdh-e2e-test-utils/rhdh";
import { LoginHelper, UIhelper } from "rhdh-e2e-test-utils/helpers";
import { $ } from "rhdh-e2e-test-utils/utils";

const BEFORE_ALL_TIMEOUT_MS = 30 * 60 * 1000; // 30 min for orchestrator + RHDH deploy

export const test = base.extend<{
  rhdhDeploymentWorker: RHDHDeployment;
  rhdh: RHDHDeployment;
  uiHelper: UIhelper;
  loginHelper: LoginHelper;
  baseURL: string;
}>({
  rhdhDeploymentWorker: [
    async ({}, use, workerInfo) => {
      const projectName = workerInfo.project.name;
      console.log(
        `Deploying rhdh for plugin ${projectName} in namespace ${projectName}`,
      );
      const rhdhDeployment = new RHDHDeployment(projectName);

      try {
        base.setTimeout(BEFORE_ALL_TIMEOUT_MS);

        await rhdhDeployment.configure({ auth: "keycloak" });

        const orchestratorNamespace = "orchestrator";
        await $`bash tests/scripts/install-orchestrator.sh ${orchestratorNamespace}`;

        await rhdhDeployment.deploy({ timeoutMs: BEFORE_ALL_TIMEOUT_MS });

        await use(rhdhDeployment);
      } finally {
        if (process.env.CI) {
          console.log(`Deleting namespace ${projectName}`);
          await rhdhDeployment.teardown();
        }
      }
    },
    { scope: "worker", auto: true },
  ],

  rhdh: [
    async ({ rhdhDeploymentWorker }, use) => {
      await use(rhdhDeploymentWorker);
    },
    { scope: "test", auto: true },
  ],

  uiHelper: [
    async ({ page }, use) => {
      await use(new UIhelper(page));
    },
    { scope: "test" },
  ],

  loginHelper: [
    async ({ page }, use) => {
      await use(new LoginHelper(page));
    },
    { scope: "test" },
  ],

  baseURL: [
    async ({ rhdhDeploymentWorker }, use) => {
      await use(rhdhDeploymentWorker.rhdhUrl);
    },
    { scope: "test" },
  ],
});

export { expect } from "@playwright/test";
export type { Page } from "@playwright/test";
