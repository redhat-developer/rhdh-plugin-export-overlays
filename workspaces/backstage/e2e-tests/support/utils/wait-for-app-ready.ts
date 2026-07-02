import type { Page } from "@playwright/test";
import type { UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";

/**
 * BUI loading indicators not yet covered by uiHelper.waitForLoad() (MUI-only).
 * Keep in sync with @red-hat-developer-hub/e2e-test-utils WAIT_OBJECTS when that
 * package adds BUI support; until then this extends waits locally per workspace.
 */
const BUI_WAIT_OBJECTS = {
  progressBar: '[role="progressbar"]',
  buttonSpinner: ".bui-ButtonSpinner, .bui-ButtonIconSpinner",
  alertSpinner: ".bui-AlertSpinner",
} as const;

/** Wait for MUI (via uiHelper) and BUI loading indicators to clear. */
export async function waitForAppReady(
  page: Page,
  uiHelper: UIhelper,
  timeout = 120_000,
): Promise<void> {
  await uiHelper.waitForLoad(timeout);
  for (const selector of Object.values(BUI_WAIT_OBJECTS)) {
    await page.waitForSelector(selector, { state: "hidden", timeout });
  }
}
