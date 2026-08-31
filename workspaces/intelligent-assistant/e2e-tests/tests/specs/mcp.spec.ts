import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import type { BrowserContext, Page } from "@playwright/test";
import { LoginHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import {
  sendMessage,
  waitForChatMessageLoadingHidden,
} from "../support/conversation-helper";
import { ensureLightspeedDeployment } from "../support/test-helper";
import {
  DEFAULT_CHAT_MODEL,
  selectChatModel,
} from "../support/lightspeed-page";
import {
  clickMcpNameColumnSort,
  closeConfigureServerModal,
  closeMcpSettings,
  ensureOrganizationTokenMode,
  MCP_EXTRA_SERVER_NAME,
  getMcpServerNamesInOrder,
  getMcpServerRow,
  getMcpServerSwitch,
  MCP_SERVER_NAME,
  MCP_TOKEN_REQUIRED_SERVER_NAME,
  openConfigureServerModal,
  openMcpSettingsInMode,
  selectPersonalTokenMode,
  toggleMcpServer,
  waitForMcpCredentialValidation,
  waitForMcpServerPatch,
} from "../support/mcp-helper";

const VALID_MCP_TOKEN = process.env.MCP_TOKEN ?? "mysecret123";
const MCP_TOOL_CALL_PROMPT =
  "Use the query-catalog-entities tool to list catalog entities, then respond with exactly: MCP tool call done.";
const MCP_TOOL_RESPONSE_BUTTON =
  /Tool response: (mcp_list_tools|query-catalog-entities)/i;

test.describe("Intelligent Assistant MCP", () => {
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
      await openConfigureServerModal(page, serverName);
      await selectPersonalTokenMode(page);
    }

    async function saveTokenAndWaitValidation(token: string): Promise<void> {
      await page.locator("#mcp-pat-input").fill(token);
      const validationPromise = waitForMcpCredentialValidation(page);
      await page.getByRole("button", { name: "Save" }).click();
      const validationResponse = await validationPromise;
      expect(validationResponse.ok()).toBeTruthy();
    }

    // mcp-integration-tools is shipped with an organization token. Org mode
    // hides #mcp-pat-input (rhdh-plugins MCP configure modal refactor #3698).
    test("edit opens configure modal with organization token - overlay", async () => {
      await openMcpSettingsInMode(page, "Overlay");
      await openConfigureServerModal(page, MCP_SERVER_NAME);
      const modal = await ensureOrganizationTokenMode(page, MCP_SERVER_NAME);

      await expect(
        modal.getByRole("heading", {
          name: `${MCP_SERVER_NAME} MCP server settings`,
        }),
      ).toBeVisible();

      await expect(modal.getByText("Status", { exact: true })).toBeVisible();
      // Heading is "Tools (N)"; .first() avoids matching a list with the same name.
      await expect(modal.getByText(/^Tools \(\d+\)$/).first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(modal.getByText("Enabled", { exact: true })).toBeVisible();
      await expect(
        modal.getByText("Authentication", { exact: true }),
      ).toBeVisible();

      const organizationTokenRadio = modal.getByRole("radio", {
        name: "Use organization default token",
      });
      const personalTokenRadio = modal.getByRole("radio", {
        name: "Use personal token",
      });

      await expect(organizationTokenRadio).toBeChecked();
      await expect(personalTokenRadio).toBeVisible();
      await expect(page.locator("#mcp-pat-input")).toBeHidden();

      await personalTokenRadio.click();
      const patInput = page.locator("#mcp-pat-input");
      await expect(patInput).toBeVisible();
      await expect(patInput).toHaveAttribute("type", /password/i);

      await closeConfigureServerModal(page);
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
    await closeMcpSettings(page);

    // NFS/app-next serves /intelligent-assistant as a Backstage 404; stay on the FAB chatbot.
    // New chat is disabled on an empty conversation after closing MCP settings.
    await selectChatModel(page, DEFAULT_CHAT_MODEL);
    await sendMessage(MCP_TOOL_CALL_PROMPT, page, false);
    await waitForChatMessageLoadingHidden(page);

    await expect(
      page.getByRole("button", { name: MCP_TOOL_RESPONSE_BUTTON }).first(),
    ).toBeVisible({ timeout: 60_000 });
  });
});
