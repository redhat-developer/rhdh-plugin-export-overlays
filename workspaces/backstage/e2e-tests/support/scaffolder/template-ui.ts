import type { Page, TestInfo } from "@playwright/test";

import type { UIhelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";

const SCAFFOLDER_POLL_TIMEOUT_MS = 30_000;

type GuestLoginHelper = {
  loginAsGuest: () => Promise<void>;
};

type PrefixedScaffolderState = {
  testPrefix: string;
};

export async function waitForScaffolderSuccess(page: Page): Promise<void> {
  await expect(
    page.getByRole("button", { name: "Create", exact: true }),
  ).toBeHidden({ timeout: 120_000 });
  await expect(
    page.getByRole("article").getByRole("progressbar").first(),
  ).toHaveAttribute("aria-valuenow", "100", { timeout: 120_000 });
  await expect(page.getByRole("article").getByRole("alert")).toHaveCount(0);
}

export async function runScaffolderTemplate(
  page: Page,
  uiHelper: UIhelper,
  templateTitle: string,
  fillParameters: () => Promise<void>,
): Promise<void> {
  await uiHelper.verifyHeading("Templates");
  await expect(async () => {
    await uiHelper.clickBtnInCard(templateTitle, "Choose");
    await expect(
      page.getByRole("heading", { name: templateTitle, level: 2 }),
    ).toBeVisible();
  }).toPass({ timeout: 5000 });
  await fillParameters();
  const reviewButton = page.getByRole("button", { name: "Review" });
  await expect(reviewButton).toBeEnabled();
  await reviewButton.click();
  const createButton = page.getByRole("button", {
    name: "Create",
    exact: true,
  });
  await expect(createButton).toBeVisible();
  await createButton.click();
  await waitForScaffolderSuccess(page);
}

export async function fillRepositoryLocation(
  uiHelper: UIhelper,
  repoUrl: string,
): Promise<void> {
  await uiHelper.fillTextInputByLabel("Repository Location", repoUrl);
}

export async function prepareScaffolderCreatePage(
  page: Page,
  loginHelper: GuestLoginHelper,
  uiHelper: UIhelper,
  testInfo: TestInfo,
): Promise<void> {
  await loginHelper.loginAsGuest();
  await uiHelper.goToPageUrl("/create");
  await uiHelper.dismissQuickstartIfVisible();

  if (testInfo.retry > 0) {
    console.info(
      `Attempt ${testInfo.retry + 1} failed, waiting for scaffolder page to be ready before retry...`,
    );
    await uiHelper.verifyHeading("Templates");
    await expect(
      page.getByRole("button", { name: "Create", exact: true }),
    ).toBeHidden();
  }
}

export async function pollUntil(probe: () => Promise<boolean>): Promise<void> {
  await expect.poll(probe, { timeout: SCAFFOLDER_POLL_TIMEOUT_MS }).toBe(true);
}

export async function pollUntilDefined<T>(
  probe: () => Promise<T>,
): Promise<void> {
  await expect
    .poll(probe, { timeout: SCAFFOLDER_POLL_TIMEOUT_MS })
    .toBeDefined();
}

/**
 * Creates the per-project scaffolder prefix once, deploys the hub once, and
 * returns the state file contents for this worker.
 */
export async function ensureScaffolderState<
  T extends PrefixedScaffolderState,
>(options: {
  projectName: string;
  runOnceKey: string;
  readState: (projectName: string) => T;
  writeState: (projectName: string, state: T) => void;
  generatePrefix: () => string;
  deploy: () => Promise<void>;
}): Promise<T> {
  const {
    projectName,
    runOnceKey,
    readState,
    writeState,
    generatePrefix,
    deploy,
  } = options;

  await test.runOnce(runOnceKey, async () => {
    const state = readState(projectName);
    if (!state.testPrefix) {
      state.testPrefix = generatePrefix();
      writeState(projectName, state);
    }
    await deploy();
  });

  return readState(projectName);
}
