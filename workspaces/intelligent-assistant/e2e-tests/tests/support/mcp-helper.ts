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
  await page.getByRole("button", { name: "Options" }).click();
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
  const optionsButton = page.getByRole("button", { name: "Options" });
  if (await optionsButton.isVisible().catch(() => false)) {
    return;
  }

  const openAssistantButton = page.getByRole("button", {
    name: "Open intelligent assistant",
  });
  if (await openAssistantButton.isVisible().catch(() => false)) {
    await openChatbot(page);
    await expect(optionsButton).toBeVisible();
    return;
  }

  // NFS/app-next: /intelligent-assistant is a Backstage 404. Recover from Catalog.
  await page.goto("/");
  await openChatbot(page);
  await expect(optionsButton).toBeVisible();
}

export async function closeMcpSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: /close mcp settings/i }).click();
  await expect(getMcpSettingsTable(page)).toBeHidden();
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
          `/api/intelligent-assistant/mcp-servers/${encodeURIComponent(serverName)}`,
        ),
  );
}

export async function waitForMcpCredentialValidation(
  page: Page,
): Promise<Response> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response
        .url()
        .includes("/api/intelligent-assistant/mcp-servers/validate"),
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

/** Configure-server modal (token and org-credential flows). */
export function mcpConfigureModal(page: Page): Locator {
  return page
    .locator("[role='dialog'], .pf-v6-c-modal-box")
    .filter({ has: page.locator("#mcp-configure-modal-body") });
}

export async function openConfigureServerModal(
  page: Page,
  serverName: string,
): Promise<Locator> {
  const row = await getMcpServerRow(page, serverName);
  const editButton = row.getByRole("button", {
    name: `Edit ${serverName}`,
    exact: true,
  });
  // Pencil control is icon-only in some builds; aria-label is Edit {name} on NFS.
  if ((await editButton.count()) > 0) {
    await editButton.click();
  } else {
    await row.getByRole("button").last().click();
  }

  const modal = mcpConfigureModal(page);
  await expect(modal).toBeVisible();
  return modal;
}

export async function closeConfigureServerModal(page: Page): Promise<void> {
  const modal = mcpConfigureModal(page);
  await modal.getByRole("button", { name: "Cancel" }).click();
  await expect(modal).toBeHidden();
}

/**
 * Modal opens in personal mode when a user PAT is already stored (`hasUserToken`
 * wins over the org default). Saving organization mode clears that PAT.
 */
export async function ensureOrganizationTokenMode(
  page: Page,
  serverName: string,
): Promise<Locator> {
  const modal = mcpConfigureModal(page);
  const organizationTokenRadio = modal.getByRole("radio", {
    name: "Use organization default token",
  });
  const personalTokenRadio = modal.getByRole("radio", {
    name: "Use personal token",
  });

  if ((await personalTokenRadio.count()) === 0) {
    return modal;
  }

  if (await organizationTokenRadio.isChecked()) {
    return modal;
  }

  await organizationTokenRadio.click();
  await modal.getByRole("button", { name: "Save" }).click();
  await expect(modal).toBeHidden({ timeout: 30_000 });
  return openConfigureServerModal(page, serverName);
}

/** PAT field is hidden while the organization-token radio is selected. */
export async function selectPersonalTokenMode(page: Page): Promise<void> {
  const modal = mcpConfigureModal(page);
  const personalTokenRadio = modal.getByRole("radio", {
    name: "Use personal token",
  });
  // Token-required servers have no org token, so radios are omitted and PAT is already shown.
  if ((await personalTokenRadio.count()) > 0) {
    // PatternFly Radio onChange is click-driven; check() can leave the field hidden.
    await personalTokenRadio.click();
  }
  await expect(page.locator("#mcp-pat-input")).toBeVisible();
}
