import { $ } from "@red-hat-developer-hub/e2e-test-utils/utils";
import type { RHDHDeployment } from "@red-hat-developer-hub/e2e-test-utils/rhdh";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getGitHubLoginCredentials } from "./github-credentials";

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
