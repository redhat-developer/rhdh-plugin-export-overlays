import { expect, type Locator, type Page } from "@playwright/test";
import { $ } from "@red-hat-developer-hub/e2e-test-utils/utils";
import { LoginHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { dismissBulkImportLoginDialogIfPresent } from "../../support/utils/auth";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RHDHDeployment } from "@red-hat-developer-hub/e2e-test-utils/rhdh";
import {
  WAIT_OBJECTS,
  BULK_IMPORT_ACCORDION_LABEL,
} from "../../support/constants/bulk-import-selectors";

export { GITHUB_ORG } from "../../support/constants/github";
export { GITHUB_CREDENTIAL_ENV_KEYS } from "../../support/constants/github";
export {
  WAIT_OBJECTS,
  BULK_IMPORT_ACCORDION_LABEL,
  BULK_IMPORT_HEADING,
  LOGIN_REQUIRED_DIALOG_NAME,
  LOGIN_REQUIRED_LOG_IN_BUTTON,
  LOGIN_REQUIRED_REJECT_ALL_BUTTON,
  REPO_STATUS_READY_TO_IMPORT,
  REPO_STATUS_IMPORTED,
  REPO_STATUS_WAIT_PR_APPROVAL,
  REPO_STATUS_ALREADY_IMPORTED,
  GITHUB_PROVIDER_LABEL,
  GITLAB_PROVIDER_LABEL,
  GITLAB_LOGIN_REJECTED_EMPTY_STATE,
  NO_REPOSITORIES_FOUND_TEST_ID,
} from "../../support/constants/bulk-import-selectors";
export {
  catalogDefaultComponentPath,
  CATALOG_FIXTURE_REPOS,
} from "../../support/constants/catalog";

export type BulkImportRhdhDeployOptions = {
  auth?: "github";
  appConfig?: string;
  dynamicPlugins?: string;
  valueFile?: string;
  deployTimeoutMs?: number;
};

/**
 * RBAC ConfigMap → Helm/operator deploy (GitHub OAuth via e2e-test-utils secrets / Vault).
 * Call once per Playwright project namespace in `beforeAll` (wrap in `test.runOnce`).
 */
export async function setupBulkImportRhdh(
  rhdh: RHDHDeployment,
  options: BulkImportRhdhDeployOptions = {},
): Promise<void> {
  const namespace = rhdh.deploymentConfig.namespace;
  await applyBulkImportRbacConfigmap(namespace);
  await rhdh.configure({
    auth: options.auth ?? "github",
    appConfig: options.appConfig ?? "tests/config/app-config-rhdh.yaml",
    valueFile: options.valueFile ?? "tests/config/values.yaml",
    ...(options.dynamicPlugins
      ? { dynamicPlugins: options.dynamicPlugins }
      : {}),
  });
  await rhdh.deploy({
    timeout: options.deployTimeoutMs ?? 20 * 60 * 1000,
  });
}

export async function waitForBulkImportPageLoad(page: Page): Promise<void> {
  for (const item of Object.values(WAIT_OBJECTS)) {
    await page
      .waitForSelector(item, { state: "hidden", timeout: 12_000 })
      .catch(() => {});
  }
}

export async function ensureBulkImportAccordionOpen(page: Page): Promise<void> {
  const btn = page.getByRole("button", {
    name: BULK_IMPORT_ACCORDION_LABEL,
  });
  if ((await btn.getAttribute("aria-expanded")) !== "true") {
    await btn.click();
    await expect(btn).toHaveAttribute("aria-expanded", "true");
  }
}

export async function expectCatalogComponentVisible(
  page: Page,
  componentName: string,
): Promise<void> {
  await expect(page).toHaveURL(
    new RegExp(
      `/catalog/default/component/${encodeURIComponent(componentName)}`,
    ),
    { timeout: 60_000 },
  );
  await expect(
    page.getByRole("heading", { level: 1, name: componentName }),
  ).toBeVisible({ timeout: 60_000 });
}

/** Catalog-imported repos must not appear on Bulk import (already in catalog). */
export async function assertRepoAbsentOnBulkImport(
  page: Page,
  loginHelper: LoginHelper,
  uiHelper: { searchInputPlaceholder: (text: string) => Promise<void> },
  repoName: string,
): Promise<void> {
  await waitForBulkImportPageLoad(page);
  await ensureBulkImportAccordionOpen(page);
  await dismissBulkImportLoginDialogIfPresent(page, loginHelper);

  await uiHelper.searchInputPlaceholder(repoName);
  await expect(page.locator(`tr:has(:text-is("${repoName}"))`)).toHaveCount(0, {
    timeout: 30_000,
  });

  const addedHeading = page.getByText(/Added repositories/i).first();
  if (await addedHeading.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await addedHeading.scrollIntoViewIfNeeded();
    await uiHelper.searchInputPlaceholder(repoName);
    await expect(page.locator(`tr:has(:text-is("${repoName}"))`)).toHaveCount(
      0,
      { timeout: 15_000 },
    );
  }
}

/**
 * Save in the catalog-info preview. `uiHelper.clickButton("Save")` matches globally and `.first()`
 * can resolve to an off-screen duplicate; Playwright then fails even with `force: true`. We scope to
 * the top dialog when present and trigger a native click (bypasses viewport actionability).
 */
export async function clickBulkImportPreviewSave(page: Page): Promise<Locator> {
  const save =
    (await page.getByRole("dialog").count()) > 0
      ? page
          .getByRole("dialog")
          .last()
          .getByRole("button", { name: "Save", exact: true })
      : page.getByRole("button", { name: "Save", exact: true }).last();

  await expect(save).toBeVisible({ timeout: 30_000 });
  await save.evaluate(
    (el: { scrollIntoView: (opts?: object) => void; click: () => void }) => {
      el.scrollIntoView({ block: "center", inline: "nearest" });
      el.click();
    },
  );
  return save;
}

/** GitHub browser-login credentials (Vault naming preferred in CI). */
export function getGitHubLoginCredentials(): {
  user: string | undefined;
  pass: string | undefined;
} {
  const user =
    process.env.VAULT_GH_USER_ID?.trim() || process.env.GITHUB_USERNAME?.trim();
  const pass =
    process.env.VAULT_GH_USER_PASS?.trim() ||
    process.env.GITHUB_PASSWORD?.trim();
  return { user, pass };
}

/** Applies RBAC ConfigMap with `GHE2EUSER_PLACEHOLDER` replaced by the GitHub login used for e2e. */
export async function applyBulkImportRbacConfigmap(
  namespace: string,
): Promise<void> {
  const { user } = getGitHubLoginCredentials();
  const login = user?.trim();
  if (!login) {
    throw new Error(
      "[bulk-import e2e] Set VAULT_GH_USER_ID or GITHUB_USERNAME so RBAC can grant bulk-importer to user:default/<login> (GitHub sign-in).",
    );
  }
  const rbacPath = path.resolve(
    process.cwd(),
    "tests/config/rbac-configmap.yaml",
  );
  const rendered = fs
    .readFileSync(rbacPath, "utf8")
    .replaceAll("GHE2EUSER_PLACEHOLDER", login);
  const tmp = path.join(
    os.tmpdir(),
    `rbac-policy-bulk-import-${namespace}-${Date.now()}.yaml`,
  );
  fs.writeFileSync(tmp, rendered);
  await $`kubectl apply -f ${tmp} -n ${namespace}`;
}
