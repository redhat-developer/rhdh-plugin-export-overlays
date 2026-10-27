import { $ } from "@red-hat-developer-hub/e2e-test-utils/utils";

export const CONFIG_DIR = "tests/config/gitlab-pqc";
export const GITLAB_GROUP_PATH = "e2e-pqc-group";

const HUB_DEPLOY = "deploy/redhat-developer-hub";
const HUB_CONTAINER = "backstage-backend";

const $pipe = $({ stdio: ["pipe", "pipe", "pipe"] });

export async function gitlabHttpCodeFromHub(
  namespace: string,
): Promise<string> {
  const script =
    'curl -sS -o /dev/null -w "%{http_code}" --max-time 15 -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "https://$GITLAB_HOST/api/v4/user" || printf 000';
  const result =
    await $pipe`oc exec -n ${namespace} ${HUB_DEPLOY} -c ${HUB_CONTAINER} -- sh -c ${script}`;
  return String(result.stdout).trim();
}

export async function hubEnvVar(
  namespace: string,
  name: string,
): Promise<string> {
  const result =
    await $pipe`oc exec -n ${namespace} ${HUB_DEPLOY} -c ${HUB_CONTAINER} -- printenv ${name}`;
  return String(result.stdout).trim();
}

/**
 * Wait until GitlabDiscoveryEntityProvider:provider finished a refresh.
 * Empty groups are OK ("Processed 0 from scanned 0 projects").
 */
export async function waitForGitlabDiscoveryScan(
  namespace: string,
  timeoutMs = 120_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result =
      await $pipe`oc logs -n ${namespace} ${HUB_DEPLOY} -c ${HUB_CONTAINER} --tail=800`;
    const logs = String(result.stdout);
    if (
      logs.includes("GitlabDiscoveryEntityProvider:provider") &&
      /Processed \d+ from scanned \d+ projects/.test(logs)
    ) {
      return logs;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }

  throw new Error(
    `Timed out waiting for GitlabDiscoveryEntityProvider:provider scan in ${namespace}`,
  );
}
