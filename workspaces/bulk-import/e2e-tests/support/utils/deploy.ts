import { $, WorkspacePaths } from "@red-hat-developer-hub/e2e-test-utils/utils";
import type { RHDHDeployment } from "@red-hat-developer-hub/e2e-test-utils/rhdh";

export type BulkImportRhdhDeployOptions = {
  appConfig: string;
  dynamicPlugins?: string;
  valueFile?: string;
  deployTimeoutMs?: number;
};

/** Applies tests/config/rbac-configmap.yaml (canonical user: rhdh-qe-2). */
export async function applyBulkImportRbacConfigmap(
  namespace: string,
): Promise<void> {
  const rbacPath = WorkspacePaths.resolve("tests/config/rbac-configmap.yaml");
  await $`kubectl apply -f ${rbacPath} -n ${namespace}`;
}

/** RBAC ConfigMap → configure → deploy. Use inside `test.runOnce` in `beforeAll`. */
export async function setupBulkImportRhdh(
  rhdh: RHDHDeployment,
  options: BulkImportRhdhDeployOptions,
): Promise<void> {
  const namespace = rhdh.deploymentConfig.namespace;
  await applyBulkImportRbacConfigmap(namespace);
  await rhdh.configure({
    auth: "github",
    appConfig: options.appConfig,
    ...(options.dynamicPlugins
      ? { dynamicPlugins: options.dynamicPlugins }
      : {}),
    ...(options.valueFile ? { valueFile: options.valueFile } : {}),
  });
  await rhdh.deploy({
    timeout: options.deployTimeoutMs ?? 20 * 60 * 1000,
  });
}
