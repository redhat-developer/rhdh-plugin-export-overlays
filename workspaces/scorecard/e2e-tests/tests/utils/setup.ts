import { type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  LoginHelper,
  UIhelper,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { CatalogPage } from "@red-hat-developer-hub/e2e-test-utils/pages";
import { type RHDHDeployment } from "@red-hat-developer-hub/e2e-test-utils/rhdh";
import {
  aggregatedScorecardHelpers,
  type AggregatedScorecardHelpers,
} from "./aggregated-scorecard";
import { scorecardHelpers, type ScorecardHelpers } from "./scorecard";

export type { ScorecardHelpers, AggregatedScorecardHelpers };

export interface ScorecardTestContext {
  context: BrowserContext;
  page: Page;
  catalog: CatalogPage;
  scorecard: ScorecardHelpers;
  aggregated: AggregatedScorecardHelpers;
}

export type ScorecardDeployOptions = {
  appConfig?: string;
  dynamicPlugins: string;
};

/** Configures and deploys RHDH with keycloak auth using the project-standard version. */
export async function deployRhdh(
  rhdh: RHDHDeployment,
  options: ScorecardDeployOptions,
): Promise<void> {
  await rhdh.configure({
    auth: "keycloak",
    version: process.env.RHDH_VERSION ?? "1.10",
    ...(options.appConfig ? { appConfig: options.appConfig } : {}),
    dynamicPlugins: options.dynamicPlugins,
  });
  await rhdh.deploy();
}

/**
 * Creates a browser context pointed at `rhdhUrl`, initialises all scorecard helpers,
 * and logs in as a Keycloak user. Returns the context and all helper instances.
 */
export async function createScorecardContext(
  browser: Browser,
  rhdhUrl: string,
): Promise<ScorecardTestContext> {
  const context = await browser.newContext({ baseURL: rhdhUrl });
  const page = await context.newPage();
  const uiHelper = new UIhelper(page);
  const catalog = new CatalogPage(page);
  const scorecard = scorecardHelpers(page, uiHelper);
  const aggregated = aggregatedScorecardHelpers(page);
  await new LoginHelper(page).loginAsKeycloakUser();
  await uiHelper.goToPageUrl("/", "Welcome back!");
  return { context, page, catalog, scorecard, aggregated };
}
