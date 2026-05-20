import { $ } from "@red-hat-developer-hub/e2e-test-utils/utils";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RHDHDeployment } from "@red-hat-developer-hub/e2e-test-utils/rhdh";

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
