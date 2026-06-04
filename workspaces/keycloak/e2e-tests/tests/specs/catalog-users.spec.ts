import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import type { RHDHDeployment } from "@red-hat-developer-hub/e2e-test-utils/rhdh";
import type {
  LoginHelper,
  UIhelper,
} from "@red-hat-developer-hub/e2e-test-utils/helpers";
import type { Page } from "@playwright/test";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { $ } from "@red-hat-developer-hub/e2e-test-utils/utils";
import {
  KeycloakHelper,
  type KeycloakUserConfig,
} from "@red-hat-developer-hub/e2e-test-utils/keycloak";
import { CatalogUsersPO } from "../support/page-objects/catalog-users-obj";

test.describe("Test Keycloak plugin", () => {
  let keycloakHelper: KeycloakHelper;
  let keycloakRealm: string;

  test.beforeAll(async ({ rhdh }: { rhdh: RHDHDeployment }) => {
    await rhdh.configure({ auth: "keycloak" });
    await rhdh.deploy();

    keycloakHelper = new KeycloakHelper();
    const realm = process.env.KEYCLOAK_REALM;
    if (!realm) {
      throw new Error("KEYCLOAK_REALM is required for Keycloak plugin tests");
    }
    keycloakRealm = realm;
    await keycloakHelper.connect({
      baseUrl: process.env.KEYCLOAK_BASE_URL!,
      realm: keycloakRealm,
      clientId: process.env.KEYCLOAK_CLIENT_ID!,
      clientSecret: process.env.KEYCLOAK_CLIENT_SECRET!,
    });
  });

  test.beforeEach(
    async ({ page, loginHelper }: { page: Page; loginHelper: LoginHelper }) => {
      await loginHelper.loginAsKeycloakUser();
      await CatalogUsersPO.visitBaseURL(page);
    },
  );

  test("Users on keycloak should match users on backstage", async ({
    page,
    uiHelper,
  }: {
    page: Page;
    uiHelper: UIhelper;
  }) => {
    const keycloakUsers = await keycloakHelper.getUsers(keycloakRealm);
    const backStageUsersLocator = CatalogUsersPO.getListOfUsers(page);
    await uiHelper.waitForLoad();
    await backStageUsersLocator.first().waitFor({ state: "visible" });
    const backStageUsersCount = await backStageUsersLocator.count();

    expect(keycloakUsers.length).toBeGreaterThan(0);
    expect(backStageUsersCount).toBeGreaterThan(0);

    for (let i = 0; i < backStageUsersCount; i++) {
      const backStageUser = backStageUsersLocator.nth(i);
      const backStageUserText = await backStageUser.textContent();
      const userFound = keycloakUsers.find(
        (user) => user.username === backStageUserText,
      );
      expect(userFound).not.toBeNull();

      // eslint-disable-next-line playwright/no-conditional-in-test
      if (userFound) {
        await checkUserDetails(
          page,
          userFound,
          keycloakHelper,
          keycloakRealm,
          uiHelper,
        );
      }
    }
  });
});

async function checkUserDetails(
  page: Page,
  keycloakUser: KeycloakUserConfig,
  keycloakHelper: KeycloakHelper,
  keycloakRealm: string,
  uiHelper: UIhelper,
) {
  await CatalogUsersPO.visitUserPage(page, keycloakUser.username);
  const emailLink = CatalogUsersPO.getEmailLink(page);
  await expect(emailLink).toBeVisible();
  await uiHelper.verifyText(
    `${keycloakUser.firstName ?? ""} ${keycloakUser.lastName ?? ""}`.trim(),
  );

  const groups = await keycloakHelper.getGroupsOfUser(
    keycloakRealm,
    keycloakUser.username,
  );
  for (const group of groups) {
    const groupLink = CatalogUsersPO.getGroupLink(page, group.name);
    await expect(groupLink).toBeVisible();
  }

  await CatalogUsersPO.visitBaseURL(page);
}

test.describe("Test Keycloak plugin metrics", () => {
  let portForward: ChildProcessWithoutNullStreams;

  test.beforeAll(() => {
    test.info().annotations.push({
      type: "component",
      description: "plugins",
    });
  });

  test.beforeEach(async ({ rhdh }: { rhdh: RHDHDeployment }) => {
    const namespace = rhdh.deploymentConfig.namespace;
    const result = await $({
      stdio: ["pipe", "pipe", "pipe"],
    })`kubectl get pods -n ${namespace} --field-selector=status.phase=Running -o json`;
    const pods = JSON.parse(result.stdout ?? "") as {
      items?: Array<{
        metadata?: { name?: string };
      }>;
    };
    const rhdhPod = pods.items?.find((pod) => {
      const name = pod.metadata?.name ?? "";
      return (
        (name.includes("backstage") || name.includes("developer-hub")) &&
        !name.includes("postgresql") &&
        !name.includes("psql")
      );
    });
    const podName = rhdhPod?.metadata?.name;
    if (!podName) {
      throw new Error(
        `No RHDH pod found in namespace ${namespace}. ` +
          `List pods with: kubectl get pods -n ${namespace}`,
      );
    }

    const login =
      process.env.K8S_CLUSTER_TOKEN && process.env.K8S_CLUSTER_URL
        ? `oc login --token="${process.env.K8S_CLUSTER_TOKEN}" --server="${process.env.K8S_CLUSTER_URL}" --insecure-skip-tls-verify=true && `
        : "";
    const cmd = `${login}kubectl config set-context --current --namespace="${namespace}" 2>/dev/null; kubectl port-forward pod/${podName} 9464:9464 --namespace="${namespace}"`;
    portForward = spawn("/bin/sh", ["-c", cmd]);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Port-forward readiness timeout"));
      }, 15000);
      portForward.stdout?.on("data", (data: Buffer) => {
        if (data.toString().includes("Forwarding from 127.0.0.1:9464")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      portForward.stderr?.on("data", (data: Buffer) => {
        const s = data.toString();
        if (s.includes("Forwarding from 127.0.0.1:9464")) {
          clearTimeout(timeout);
          resolve();
        } else {
          console.error("Port-forward stderr:", s);
        }
      });
      portForward.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  });

  test.afterEach(async () => {
    if (portForward?.pid) {
      try {
        portForward.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
    await $`pkill -f 'kubectl port-forward.*9464:9464' 2>/dev/null || true`.nothrow();
  });

  test("keycloak metrics with failure counters", async () => {
    const metricsEndpointURL = "http://localhost:9464/metrics";
    const metricLines = await fetchMetrics(metricsEndpointURL);

    const catalogMetricPrefix =
      'backend_keycloak_fetch_task_failure_count_total{taskInstanceId="';
    const hasCatalogMetric = metricLines.some(
      (line) =>
        line.startsWith(catalogMetricPrefix) && /"} \d+$/.test(line.trimEnd()),
    );
    const hasKeycloakRelatedMetric = metricLines.some((l) =>
      /keycloak/i.test(l),
    );

    expect(metricLines.length).toBeGreaterThan(0);
    expect(
      hasCatalogMetric || hasKeycloakRelatedMetric,
      "Expected /metrics to contain backend_keycloak_fetch_task_failure_count_total or keycloak-related metrics (e.g. RHDH Keycloak instance)",
    ).toBeTruthy();
  });
});

async function fetchMetrics(metricsEndpointUrl: string): Promise<string[]> {
  const response = await fetch(metricsEndpointUrl, {
    method: "GET",
    headers: { Accept: "text/plain" },
  });

  if (response.status !== 200) {
    throw new Error(
      `Failed to retrieve metrics from RHDH (${response.status})`,
    );
  }
  const data = await response.text();
  return data.split("\n");
}
