import {
  expect,
  type Locator,
  type Page,
  type Response,
} from "@playwright/test";
import {
  openChatbot,
  selectDisplayMode,
  type DisplayMode,
} from "./lightspeed-page";

export const MCP_SERVER_NAME = "mcp-integration-tools";
export const MCP_TOKEN_REQUIRED_SERVER_NAME = "mcp-token-required-tools";
export const MCP_EXTRA_SERVER_NAME = "mcp-observability-tools";
const MCP_SERVERS_LOADING_TEXT = "Loading MCP servers...";

async function openMcpSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Chatbot options" }).click();
  await page.getByRole("menuitem", { name: "MCP settings" }).click();
}

export async function getMcpServerRow(
  page: Page,
  serverName: string,
): Promise<Locator> {
  const row = getMcpSettingsTable(page)
    .getByRole("row")
    .filter({ has: page.getByText(serverName, { exact: true }) })
    .first();
  await expect(row).toBeVisible();
  return row;
}

export async function getMcpServerSwitch(
  page: Page,
  serverName: string,
): Promise<Locator> {
  const row = await getMcpServerRow(page, serverName);
  const toggle = row.getByRole("switch", {
    name: `Toggle ${serverName}`,
    exact: true,
  });
  await expect(toggle).toBeVisible();
  return toggle;
}

function getMcpSettingsTable(page: Page): Locator {
  return page
    .locator("table[aria-label*='MCP'], table[aria-label*='mcp']")
    .first();
}

async function closeMcpOverlaysIfOpen(page: Page): Promise<void> {
  const closeConfigureModalButton = page.getByRole("button", {
    name: /close configure modal/i,
  });
  if (await closeConfigureModalButton.isVisible().catch(() => false)) {
    await closeConfigureModalButton.click();
  }

  const closeMcpSettingsButton = page.getByRole("button", {
    name: /close mcp settings/i,
  });
  if (await closeMcpSettingsButton.isVisible().catch(() => false)) {
    await closeMcpSettingsButton.click();
  }
}

async function ensureChatbotIsOpen(page: Page): Promise<void> {
  const optionsButton = page.getByRole("button", { name: "Chatbot options" });
  if (await optionsButton.isVisible().catch(() => false)) {
    return;
  }

  const openLightspeedButton = page.getByRole("button", {
    name: "Open Lightspeed",
  });
  if (await openLightspeedButton.isVisible().catch(() => false)) {
    await openChatbot(page);
    await expect(optionsButton).toBeVisible();
    return;
  }

  // Fallback only when the current page is not recoverable for chatbot interactions.
  await page.goto("/");
  await openChatbot(page);
  await expect(optionsButton).toBeVisible();
}

export async function openMcpSettingsInMode(
  page: Page,
  mode: DisplayMode,
): Promise<void> {
  await closeMcpOverlaysIfOpen(page);
  await ensureChatbotIsOpen(page);
  await selectDisplayMode(page, mode);
  await openMcpSettings(page);
  const table = getMcpSettingsTable(page);
  await expect(table).toBeVisible();
  await table
    .getByRole("gridcell", {
      name: MCP_SERVERS_LOADING_TEXT,
      exact: true,
    })
    .waitFor({ state: "hidden", timeout: 30_000 });
}

export async function waitForMcpServerPatch(
  page: Page,
  serverName: string,
): Promise<Response> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response
        .url()
        .includes(
          `/api/lightspeed/mcp-servers/${encodeURIComponent(serverName)}`,
        ),
  );
}

export async function waitForMcpCredentialValidation(
  page: Page,
): Promise<Response> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/api/lightspeed/mcp-servers/validate"),
  );
}

export async function getMcpServerNamesInOrder(page: Page): Promise<string[]> {
  const table = getMcpSettingsTable(page);
  const rows = table.locator("tbody tr");
  const rowCount = await rows.count();
  const names: string[] = [];

  for (let index = 0; index < rowCount; index += 1) {
    names.push((await rows.nth(index).locator("td").nth(1).innerText()).trim());
  }

  return names;
}

export async function clickMcpNameColumnSort(page: Page): Promise<void> {
  const table = getMcpSettingsTable(page);
  await table.getByRole("button", { name: /name/i }).click();
}

export async function toggleMcpServer(
  page: Page,
  serverName: string,
): Promise<void> {
  const table = getMcpSettingsTable(page);
  const toggleCell = table.getByRole("gridcell", {
    name: `Toggle ${serverName}`,
    exact: true,
  });
  await expect(toggleCell).toBeVisible();
  await toggleCell.locator("span").first().click();
}
