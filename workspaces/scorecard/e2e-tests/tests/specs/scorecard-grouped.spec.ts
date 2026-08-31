import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import { type CatalogPage } from "@red-hat-developer-hub/e2e-test-utils/pages";
import { type BrowserContext, type Locator, type Page } from "@playwright/test";
import {
  createScorecardContext,
  deployRhdh,
  type ScorecardHelpers,
} from "../utils/setup";

test.describe.serial("Scorecard Grouped Metrics", () => {
  let context: BrowserContext | undefined;
  let page: Page;
  let catalog: CatalogPage;
  let scorecard: ScorecardHelpers;

  const GROUP_CARDS = [
    {
      title: "Security Alerts",
      description: "Security vulnerability alerts from Dependabot",
    },
    {
      title: "Code Health",
      description: "Development health and code quality metrics",
    },
  ] as const;

  async function getGroupCard(
    title: string,
    timeout = 30_000,
  ): Promise<Locator> {
    const card = page
      .locator('[role="article"]')
      .filter({ hasText: title })
      .first();
    await expect(card).toBeVisible({ timeout });
    return card;
  }

  /** Open the "Data sources" dialog from a group card's overflow menu. */
  async function openDataSourcesDialog(card: Locator): Promise<Locator> {
    await card.getByRole("button", { name: /menu|more/i }).click();
    await page.getByText(/data sources/i).click();
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    return dialog;
  }

  /** Close a dialog and optionally assert it disappears. */
  async function closeDialog(
    dialog: Locator,
    { expectHidden = false } = {},
  ): Promise<void> {
    await dialog.getByLabel("Close").click();
    if (expectHidden) await expect(dialog).toBeHidden();
  }

  test.beforeAll(async ({ browser, rhdh }) => {
    await deployRhdh(rhdh, {
      appConfig: "tests/config/grouped/app-config-rhdh.yaml",
      dynamicPlugins: "tests/config/dynamic-plugins.yaml",
    });
    await new Promise((resolve) => setTimeout(resolve, 2 * 60 * 1000));
    ({ context, page, catalog, scorecard } = await createScorecardContext(
      browser,
      rhdh.rhdhUrl,
    ));
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("Verify group cards render with titles and descriptions", async () => {
    await catalog.go();
    await catalog.goToByName("dependabot-scorecard-only");
    await scorecard.openTab();

    for (const group of GROUP_CARDS) {
      const card = await getGroupCard(group.title);
      await expect(card.getByText(group.description)).toBeVisible();
    }
  });

  test("Verify group cards display bucket tiles", async () => {
    for (const group of GROUP_CARDS) {
      const card = await getGroupCard(group.title);
      const bucketTiles = card.locator('[role="button"]');
      await expect(bucketTiles.first()).toBeVisible({ timeout: 60_000 });
    }
  });

  test("Verify data sources dialog opens from group card menu", async () => {
    const card = await getGroupCard(GROUP_CARDS[0].title);
    const dialog = await openDataSourcesDialog(card);

    const expectedColumns = [
      "PLUGIN",
      "CHECK",
      "VALUE",
      "STATUS",
      "LAST SYNCED",
    ];
    for (const col of expectedColumns) {
      await expect(dialog.getByText(col, { exact: true })).toBeVisible();
    }

    await closeDialog(dialog, { expectHidden: true });
  });

  test("Verify filter pills filter data sources by threshold", async () => {
    const card = await getGroupCard(GROUP_CARDS[0].title);
    const dialog = await openDataSourcesDialog(card);

    const tableRows = dialog.locator("tbody [role='row']");
    await expect(tableRows.first()).toBeVisible({ timeout: 30_000 });
    const initialCount = await tableRows.count();

    const filterPills = dialog.locator('[role="button"][aria-pressed]');
    const firstPill = filterPills.first();
    await expect(firstPill).toBeVisible();
    await expect(firstPill).toHaveAttribute("aria-pressed", "false");

    await firstPill.click();
    await expect(firstPill).toHaveAttribute("aria-pressed", "true");

    await expect(async () => {
      const filteredCount = await tableRows.count();
      expect(filteredCount).toBeLessThan(initialCount);
    }).toPass({ timeout: 10_000 });

    await firstPill.click();
    await expect(firstPill).toHaveAttribute("aria-pressed", "false");

    await closeDialog(dialog);
  });

  test("Verify clicking bucket tile opens dialog with filter pre-applied", async () => {
    const card = await getGroupCard(GROUP_CARDS[0].title);
    await card.locator('[role="button"]').first().click();

    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    const activePill = dialog.locator('[role="button"][aria-pressed="true"]');
    await expect(activePill).toBeVisible();

    await closeDialog(dialog, { expectHidden: true });
  });

  test("Verify ungrouped metrics still render as individual cards", async () => {
    await catalog.go();
    await catalog.goToByName("all-scorecards");
    await scorecard.openTab();

    const jiraCard = page.locator("article").filter({
      has: page.locator('[aria-label="Jira open blocking tickets"]'),
    });
    await expect(jiraCard).toBeVisible({ timeout: 60_000 });
  });
});
