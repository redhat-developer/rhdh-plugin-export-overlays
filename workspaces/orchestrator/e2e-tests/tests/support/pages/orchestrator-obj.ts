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
};
