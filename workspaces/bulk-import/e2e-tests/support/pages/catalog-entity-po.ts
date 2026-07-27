import { expect, Page } from "@red-hat-developer-hub/e2e-test-utils/test";
import { catalogDefaultComponentPath } from "../constants/catalog";

export class CatalogEntityPO {
  constructor(private readonly page: Page) {}

  async gotoComponent(componentName: string): Promise<void> {
    await this.page.goto(catalogDefaultComponentPath(componentName));
  }

  async expectComponentVisible(componentName: string): Promise<void> {
    await expect(this.page).toHaveURL(
      new RegExp(
        `/catalog/default/component/${encodeURIComponent(componentName)}`,
      ),
      { timeout: 60_000 },
    );
    await expect(
      this.page.getByRole("heading", { level: 1, name: componentName }),
    ).toBeVisible({ timeout: 60_000 });
  }
}
