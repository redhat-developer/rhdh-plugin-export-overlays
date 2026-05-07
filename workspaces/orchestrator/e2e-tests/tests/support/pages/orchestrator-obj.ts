import { Page, Locator } from "@red-hat-developer-hub/e2e-test-utils/test";

export const ORCHESTRATOR_COMPONENTS = {
  workflowsHeading: (page: Page): Locator =>
    page.getByRole("heading", { name: "Workflows" }),
  workflowLink: (page: Page, workflowName: string | RegExp): Locator =>
    page.getByRole("link", { name: workflowName }),
  runButton: (page: Page): Locator => page.getByRole("button", { name: "Run" }),
  breadcrumbNav: (page: Page): Locator =>
    page.getByRole("navigation", { name: /breadcrumb/i }),
  templateLink: (page: Page, name: string | RegExp): Locator =>
    page.getByRole("link", { name }),
  languageField: (page: Page): Locator => page.getByLabel("Language"),
  nameField: (page: Page): Locator => page.getByLabel("Name"),
  reviewButton: (page: Page): Locator =>
    page.getByRole("button", { name: /Review/i }),
  createButton: (page: Page): Locator =>
    page.getByRole("button", { name: /Create/i }),
  viewInCatalogLink: (page: Page): Locator =>
    page.getByRole("link", { name: "View in catalog" }),
  openWorkflowRunLink: (page: Page): Locator =>
    page.getByRole("link", { name: "Open workflow run" }),
  startOverButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Start Over" }),
  workflowsTab: (page: Page): Locator =>
    page.getByRole("tab", { name: "Workflows" }),
};
