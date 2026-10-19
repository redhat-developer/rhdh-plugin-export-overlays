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
  valueFile?: string;
  beforeDeploy?: (rhdh: RHDHDeployment) => Promise<void>;
};

/** Configures and deploys RHDH with keycloak auth using the project-standard version. */
export async function deployRhdh(
  rhdh: RHDHDeployment,
  options: ScorecardDeployOptions,
): Promise<void> {
  await rhdh.configure({
    auth: "keycloak",
    version: process.env.RHDH_VERSION,
    ...(options.appConfig ? { appConfig: options.appConfig } : {}),
    ...(options.valueFile ? { valueFile: options.valueFile } : {}),
    dynamicPlugins: options.dynamicPlugins,
  });
  await options.beforeDeploy?.(rhdh);
  await rhdh.deploy();
}

const LOGIN_MAX_ATTEMPTS = 3;

/**
 * Creates a browser context pointed at `rhdhUrl`, initialises all scorecard helpers,
 * and logs in as a Keycloak user. Returns the context and all helper instances.
 *
 * Login is retried up to {@link LOGIN_MAX_ATTEMPTS} times because the Keycloak
 * SSO popup can occasionally time out in CI environments.
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

  let lastError: unknown;
  for (let attempt = 1; attempt <= LOGIN_MAX_ATTEMPTS; attempt++) {
    try {
      await new LoginHelper(page).loginAsKeycloakUser();
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < LOGIN_MAX_ATTEMPTS) {
        console.warn(
          `[scorecard] Keycloak login attempt ${attempt}/${LOGIN_MAX_ATTEMPTS} failed, retrying…`,
          error,
        );
        await page.reload();
      }
    }
  }
  if (lastError) {
    throw new Error(
      `Keycloak login failed after ${LOGIN_MAX_ATTEMPTS} attempts`,
      { cause: lastError },
    );
  }

  await uiHelper.goToPageUrl("/catalog", "Catalog");
  return { context, page, catalog, scorecard, aggregated };
}
