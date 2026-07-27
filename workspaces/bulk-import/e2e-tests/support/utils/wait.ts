import type { Page } from "@playwright/test";
import { WAIT_OBJECTS } from "../constants/bulk-import-selectors";

export async function waitForMuiProgressHidden(
  page: Page,
  timeoutMs = 12_000,
): Promise<void> {
  for (const item of Object.values(WAIT_OBJECTS)) {
    await page
      .waitForSelector(item, { state: "hidden", timeout: timeoutMs })
      .catch(() => {});
  }
}
