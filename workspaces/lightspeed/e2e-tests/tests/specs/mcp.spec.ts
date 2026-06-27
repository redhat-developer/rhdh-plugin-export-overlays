import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import type { BrowserContext, Page } from "@playwright/test";
import { LoginHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { sendMessage } from "../support/conversation-helper";
import {
  ensureLightspeedDeployment,
  openLightspeed,
} from "../support/test-helper";
import { selectChatModel } from "../support/lightspeed-page";
import {
  clickMcpNameColumnSort,
  MCP_EXTRA_SERVER_NAME,
  getMcpServerNamesInOrder,
  getMcpServerRow,
  getMcpServerSwitch,
  MCP_SERVER_NAME,
  MCP_TOKEN_REQUIRED_SERVER_NAME,
  openMcpSettingsInMode,
  toggleMcpServer,
  waitForMcpCredentialValidation,
  waitForMcpServerPatch,
} from "../support/mcp-helper";

const VALID_MCP_TOKEN = process.env.MCP_TOKEN ?? "mysecret123";
const MCP_TOOL_CALL_PROMPT =
  "Use the mcp_list_tools tool for server mcp-integration-tools, then respond with exactly: MCP tool call done.";

test.describe("Lightspeed MCP", () => {
  test.describe.configure({ mode: "serial", timeout: 7 * 60 * 1000 });

  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser, rhdh }) => {
    test.setTimeout(12 * 60 * 1000);
    await ensureLightspeedDeployment(rhdh);

    context = await browser.newContext({
      baseURL: process.env.RHDH_BASE_URL,
      permissions: ["clipboard-read", "clipboard-write"],
    });
    page = await context.newPage();
    await new LoginHelper(page).loginAsKeycloakUser();
  });

  test.afterAll(async () => {
    await context?.close();
  });

  async function ensureMcpServerEnabled(serverName: string): Promise<void> {
    const serverSwitch = await getMcpServerSwitch(page, serverName);
    if (await serverSwitch.isChecked()) {
      return;
    }

    const enablePatchPromise = waitForMcpServerPatch(page, serverName);
    await toggleMcpServer(page, serverName);
    const enablePatch = await enablePatchPromise;
    expect(enablePatch.ok()).toBeTruthy();
  }

  test.describe("MCP settings overlay", () => {
    test("lists configured MCP servers with mixed token states", async () => {
      await openMcpSettingsInMode(page, "Overlay");
      const tokenRequiredRow = await getMcpServerRow(
        page,
        MCP_TOKEN_REQUIRED_SERVER_NAME,
      );

      const integrationSwitch = await getMcpServerSwitch(page, MCP_SERVER_NAME);
      const observabilitySwitch = await getMcpServerSwitch(
        page,
        MCP_EXTRA_SERVER_NAME,
      );
      const tokenRequiredSwitch = await getMcpServerSwitch(
        page,
        MCP_TOKEN_REQUIRED_SERVER_NAME,
      );

      await expect(integrationSwitch).toBeEnabled();
      await expect(observabilitySwitch).toBeEnabled();
      await expect(tokenRequiredSwitch).toBeDisabled();
      await expect(tokenRequiredRow.getByText(/token required/i)).toBeVisible();
    });

    test("shows MCP settings row and syncs enable toggle with backend", async () => {
      const row = await getMcpServerRow(page, MCP_SERVER_NAME);
      const toggle = await getMcpServerSwitch(page, MCP_SERVER_NAME);
      await expect(toggle).toBeEnabled();

      const initialEnabled = await toggle.isChecked();

      const firstPatchPromise = waitForMcpServerPatch(page, MCP_SERVER_NAME);
      await toggleMcpServer(page, MCP_SERVER_NAME);
      const firstPatch = await firstPatchPromise;
      expect(firstPatch.ok()).toBeTruthy();

      const firstPatchBody = (await firstPatch.json()) as {
        server?: { enabled?: boolean };
      };
      expect(firstPatchBody.server?.enabled).toBe(!initialEnabled);

      const disabledLabel = row.getByText(/disabled/i);
      await expect
        .poll(async () => disabledLabel.isVisible())
        .toBe(initialEnabled);

      const secondPatchPromise = waitForMcpServerPatch(page, MCP_SERVER_NAME);
      await toggleMcpServer(page, MCP_SERVER_NAME);
      const secondPatch = await secondPatchPromise;
      expect(secondPatch.ok()).toBeTruthy();
      const secondPatchBody = (await secondPatch.json()) as {
        server?: { enabled?: boolean };
      };
      expect(secondPatchBody.server?.enabled).toBe(initialEnabled);
    });

    test("sorts MCP server names when clicking Name column", async () => {
      const initialOrder = await getMcpServerNamesInOrder(page);
      const expectedAsc = [
        MCP_SERVER_NAME,
        MCP_EXTRA_SERVER_NAME,
        MCP_TOKEN_REQUIRED_SERVER_NAME,
      ];
      expect(initialOrder.slice(0, expectedAsc.length)).toEqual(expectedAsc);

      await clickMcpNameColumnSort(page);
      const sortedDesc = await getMcpServerNamesInOrder(page);
      const expectedDesc = [...expectedAsc].reverse();
      expect(sortedDesc.slice(0, expectedDesc.length)).toEqual(expectedDesc);
    });

    test('shows "Token required" for server without configured token', async () => {
      const row = await getMcpServerRow(page, MCP_TOKEN_REQUIRED_SERVER_NAME);
      await expect(row.getByText(/token required/i)).toBeVisible();
    });
  });

  test.describe("Configure MCP server token", () => {
    async function openConfigureTokenModal(serverName: string): Promise<void> {
      const row = await getMcpServerRow(page, serverName);
      await row.getByRole("button").last().click();
      await expect(page.locator("#mcp-pat-input")).toBeVisible();
    }

    async function saveTokenAndWaitValidation(token: string): Promise<void> {
      await page.locator("#mcp-pat-input").fill(token);
      const validationPromise = waitForMcpCredentialValidation(page);
      await page.getByRole("button", { name: "Save" }).click();
      const validationResponse = await validationPromise;
      expect(validationResponse.ok()).toBeTruthy();
    }

    test("valid token saves and row no longer shows token required - overlay", async () => {
      await openMcpSettingsInMode(page, "Overlay");
      await openConfigureTokenModal(MCP_SERVER_NAME);

      await saveTokenAndWaitValidation(VALID_MCP_TOKEN);
      await expect(page.locator("#mcp-pat-input")).toBeHidden();

      const row = await getMcpServerRow(page, MCP_SERVER_NAME);
      await expect(row.getByText(/token required/i)).toBeHidden();
    });

    test("invalid token then valid token - dock to window", async () => {
      await openMcpSettingsInMode(page, "Dock to window");
      await openConfigureTokenModal(MCP_SERVER_NAME);

      await saveTokenAndWaitValidation("bad-token");
      await expect(
        page.getByText(
          /invalid credentials|401\/403|validation failed|unable to validate/i,
        ),
      ).toBeVisible();

      await saveTokenAndWaitValidation(VALID_MCP_TOKEN);
      await expect(page.locator("#mcp-pat-input")).toBeHidden();
    });

    test("cancel discards token input without saving - fullscreen", async () => {
      await openMcpSettingsInMode(page, "Fullscreen");
      await openConfigureTokenModal(MCP_TOKEN_REQUIRED_SERVER_NAME);

      const tokenInput = page.locator("#mcp-pat-input");
      await tokenInput.fill("draft-token");
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(tokenInput).toBeHidden();

      const row = await getMcpServerRow(page, MCP_TOKEN_REQUIRED_SERVER_NAME);
      await expect(row.getByText(/token required/i)).toBeVisible();
    });

    test("missing server URL shows validation error - dock to window", async () => {
      await openMcpSettingsInMode(page, "Dock to window");
      await openConfigureTokenModal(MCP_TOKEN_REQUIRED_SERVER_NAME);

      await page.locator("#mcp-pat-input").fill(VALID_MCP_TOKEN);
      await page.getByRole("button", { name: "Save" }).click();
      await expect(
        page.getByText(
          /unable to validate token because server url is not available/i,
        ),
      ).toBeVisible();
      await page.getByRole("button", { name: "Cancel" }).click();
    });

    test("clear token input empties PAT field - fullscreen", async () => {
      await openMcpSettingsInMode(page, "Fullscreen");
      await openConfigureTokenModal(MCP_TOKEN_REQUIRED_SERVER_NAME);

      const tokenInput = page.locator("#mcp-pat-input");
      const typedPat = "e2e-draft-personal-access-token";

      // PAT input must be rendered as a masked password field.
      await expect(tokenInput).toHaveAttribute("type", /password/i);
      await tokenInput.fill(typedPat);
      await expect(tokenInput).toHaveValue(typedPat);
      await expect(page.getByText(typedPat, { exact: true })).toHaveCount(0);

      // Clear icon label is localized; regex keeps this robust in translated UIs.
      await page.getByRole("button", { name: /clear/i }).click();
      await expect(tokenInput).toHaveValue("");

      await page.getByRole("button", { name: "Cancel" }).click();
    });
  });

  test("MCP tool calling renders in UI", async () => {
    await openMcpSettingsInMode(page, "Fullscreen");
    await ensureMcpServerEnabled(MCP_SERVER_NAME);

    await page.getByRole("button", { name: /close mcp settings/i }).click();
    await openLightspeed(page);
    await selectChatModel(page, "gpt-5.1");

    await sendMessage(MCP_TOOL_CALL_PROMPT, page);

    await expect(
      page.getByRole("button", { name: /mcp_list_tools/i }).first(),
    ).toBeVisible({ timeout: 30_000 });
  });
});
