import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import type { BrowserContext, Page } from "@playwright/test";
import { LoginHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { NotebookSurfacePage } from "../support/notebook-surface-page";
import { NOTEBOOK_EDITOR_URL_RE } from "../support/notebook-constants";
import { ensureLightspeedDeployment } from "../support/test-helper";

test.describe("Intelligent Assistant notebooks smoke", () => {
  test.describe.configure({ mode: "serial", timeout: 5 * 60 * 1000 });

  let context: BrowserContext;
  let page: Page;
  let notebooks: NotebookSurfacePage;

  test.beforeAll(async ({ browser, rhdh }) => {
    test.setTimeout(10 * 60 * 1000);
    await ensureLightspeedDeployment(rhdh);

    context = await browser.newContext({
      baseURL: process.env.RHDH_BASE_URL,
    });
    page = await context.newPage();
    await new LoginHelper(page).loginAsKeycloakUser();
    notebooks = new NotebookSurfacePage(page);
    await notebooks.gotoFullscreenNotebooksTab();
    await notebooks.deleteLeftoverNotebookCards();
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("notebooks tab opens and a new notebook reaches the editor", async () => {
    await notebooks.gotoFullscreenNotebooksTab();
    await notebooks.expectNotebookListHeaderControlsVisible();

    await notebooks.clickCreateNotebookFromEmptyList();
    await expect(page).toHaveURL(NOTEBOOK_EDITOR_URL_RE);
    await notebooks.expectNewNotebookEditorEmptyStateOnboarding();

    await notebooks.clickCloseNotebookEditor();
    await expect(notebooks.myNotebooksHeading()).toBeVisible();
  });
});
