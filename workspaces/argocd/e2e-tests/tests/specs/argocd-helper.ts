import { Page } from "@playwright/test";
import { UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";

export async function navigateToComponent(page: Page, uiHelper: UIhelper) {
  await uiHelper.openCatalogSidebar("Component");
  await page.getByText("test-argocd-component").click();
}

export async function expandAllSections(page: Page) {
  const uiHelper = new UIhelper(page);
  await uiHelper.clickButtonByLabel("rows");
  await page.getByRole("option", { name: "10 rows" }).click();

  const expanders = page.locator('[data-testid^="expander-"]');
  const count = await expanders.count();
  for (let i = 0; i < count; i++) {
    await expanders.nth(i).click();
  }
}

export async function switchFilter(page: Page, from: string, to: string) {
  const toolbar = page.locator("#toolbar-with-filter");
  await toolbar.getByRole("button", { name: from, exact: true }).click();
  await page.getByRole("option", { name: to }).click();
}

export async function toggleCheckboxFilter(
  page: Page,
  label: string,
  options: string[],
) {
  const uiHelper = new UIhelper(page);
  await uiHelper.clickButtonByLabel(`Filter by ${label}`);
  for (const opt of options) {
    await uiHelper.checkCheckbox(opt);
  }
  await uiHelper.clickButtonByLabel(`Filter by ${label}`);
}

export function rowByNameAndKind(page: Page, name: string, kind: string) {
  return page
    .locator("tr")
    .filter({ has: page.getByRole("cell", { name, exact: true }) })
    .filter({ has: page.getByRole("cell", { name: kind, exact: true }) });
}
