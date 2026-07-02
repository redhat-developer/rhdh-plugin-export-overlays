import { AuthApiHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { expect, type Page } from "@red-hat-developer-hub/e2e-test-utils/test";
import type { UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { waitForAppReady } from "./wait-for-app-ready";

/** Obtain a bearer token from the logged-in browser session. */
export async function getSessionAuthToken(
  page: Page,
  uiHelper: UIhelper,
  baseUrl: string,
): Promise<string> {
  const authApiHelper = new AuthApiHelper(page);

  const readToken = async (): Promise<string | undefined> => {
    try {
      const value = await authApiHelper.getToken();
      return value?.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  };

  // Prefer the session from loginHelper.beforeEach without forcing navigation.
  const existingToken = await readToken();
  if (existingToken) {
    return existingToken;
  }

  await page.goto(baseUrl);
  await waitForAppReady(page, uiHelper);

  let token = "";
  await expect
    .poll(
      async () => {
        const value = await readToken();
        if (value) {
          token = value;
          return true;
        }
        return false;
      },
      {
        message: "Token should be retrieved after session is established",
        timeout: 30_000,
        intervals: [2_000],
      },
    )
    .toBe(true);

  return token;
}
