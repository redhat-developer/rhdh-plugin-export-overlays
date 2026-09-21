import { Page, Locator } from "@red-hat-developer-hub/e2e-test-utils/test";

export const ORCHESTRATOR_COMPONENTS = {
  workflowsHeading: (page: Page): Locator =>
    page.getByText(/Workflows \(\d+\)/).last(),
  workflowLink: (page: Page, workflowName: string | RegExp): Locator =>
    page.getByRole("link", { name: workflowName }),
  runButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Run", exact: true }),
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
  // NFS catalog entity header: same control is often a link, not a tab.
  workflowsLink: (page: Page): Locator =>
    page.getByRole("link", { name: "Workflows", exact: true }),
  nextButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Next" }),
  runWorkflowButton: (page: Page): Locator =>
    page.getByRole("button", { name: /run workflow/i }),
  suggestedNextWorkflowHeading: (page: Page): Locator =>
    page.getByRole("heading", { name: /suggested next workflow/i }),
  suggestedGreetingLink: (page: Page): Locator =>
    page.getByRole("link", { name: /greeting/i }),
  greetingWorkflowDialog: (page: Page): Locator =>
    page.getByRole("dialog", { name: /greeting workflow/i }),
  completedStatus: (page: Page): Locator =>
    page.getByText("Completed", { exact: true }),
  runAsEventButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Run as Event" }),
  eventTriggeredAlert: (page: Page): Locator =>
    page.getByText(
      "An event was sent to trigger this workflow. It will appear once the run starts.",
    ),
  runningStatus: (page: Page): Locator =>
    page.getByText("Running", { exact: true }),
  /** Event-started instance without ownership — proves Run as Event produced a run id. */
  eventInstanceAccessDenied: (page: Page): Locator =>
    page.getByText(/Access denied for instance `[0-9a-f-]{36}`/i),
};
