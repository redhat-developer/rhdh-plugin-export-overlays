import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import type { BrowserContext, Page } from "@playwright/test";
import { LoginHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { ensureLightspeedDeployment } from "../support/test-helper";
import {
  closeConfigureServerModal,
  getMcpServerRow,
  getMcpServerSwitch,
  MCP_SERVER_NAME,
  openConfigureServerModal,
  openMcpSettingsInMode,
} from "../support/mcp-helper";

test.describe("Intelligent Assistant MCP smoke", () => {
  test.describe.configure({ mode: "serial", timeout: 5 * 60 * 1000 });

  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser, rhdh }) => {
    test.setTimeout(10 * 60 * 1000);
    await ensureLightspeedDeployment(rhdh);

    context = await browser.newContext({
      baseURL: process.env.RHDH_BASE_URL,
    });
    page = await context.newPage();
    await new LoginHelper(page).loginAsKeycloakUser();
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("lists the integration MCP server", async () => {
    await openMcpSettingsInMode(page, "Overlay");
    const row = await getMcpServerRow(page, MCP_SERVER_NAME);
    const integrationSwitch = await getMcpServerSwitch(page, MCP_SERVER_NAME);

    await expect(row.getByText(MCP_SERVER_NAME, { exact: true })).toBeVisible();
    await expect(integrationSwitch).toBeEnabled();
  });

  test("configure modal shows the server is connected", async () => {
    const modal = await openConfigureServerModal(page, MCP_SERVER_NAME);

    await expect(
      modal.getByRole("heading", {
        name: `${MCP_SERVER_NAME} MCP server settings`,
      }),
    ).toBeVisible();
    await expect(modal.getByText("Status", { exact: true })).toBeVisible();
    await expect(modal.getByText(/^Tools \(\d+\)$/).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(modal.getByText("Enabled", { exact: true })).toBeVisible();

    await closeConfigureServerModal(page);
  });
});
