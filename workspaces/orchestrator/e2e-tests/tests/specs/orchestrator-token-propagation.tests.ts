import { test, expect } from "@red-hat-developer-hub/e2e-test-utils/test";
import { AuthApiHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import { runOc } from "../support/utils/test-helpers.js";

interface WorkflowNode {
  name: string;
  errorMessage: string | null;
  exit: string | null;
}

interface WorkflowInstance {
  state: string;
  workflowdata: {
    result: {
      completedWith: string;
      message: string;
    };
  };
  nodes: WorkflowNode[];
  serviceUrl?: string;
}

type RequireEnvVar = (name: string) => string;

const TOKEN_PROPAGATION_TIMEOUT_MS = 5 * 60 * 1000;
const TOKEN_PROPAGATION_POLL_INTERVAL_MS = 5_000;
const TOKEN_PROPAGATION_MAX_POLLS = 30;
const TOKEN_PROPAGATION_POLL_TIMEOUT_MS =
  TOKEN_PROPAGATION_POLL_INTERVAL_MS * TOKEN_PROPAGATION_MAX_POLLS;

export function registerTokenPropagationWorkflowTests(
  requireEnvVar: RequireEnvVar,
): void {
  test.describe("Token propagation workflow API", () => {
    test("Execute token-propagation workflow via API", async ({
      page,
      loginHelper,
    }) => {
      // 5 minutes for workflow execution + polling
      test.setTimeout(TOKEN_PROPAGATION_TIMEOUT_MS);

      await loginHelper.loginAsKeycloakUser();

      const backstageToken = await new AuthApiHelper(page).getToken();

      const kcBaseUrl = requireEnvVar("KEYCLOAK_BASE_URL");
      const kcRealm = requireEnvVar("KEYCLOAK_REALM");
      const kcClientId = requireEnvVar("KEYCLOAK_CLIENT_ID");
      const kcClientSecret = requireEnvVar("KEYCLOAK_CLIENT_SECRET");
      const username = process.env.GH_USER_ID || "test1";
      const password = process.env.GH_USER_PASS || "test1@123";

      const tokenUrl = `${kcBaseUrl}/realms/${kcRealm}/protocol/openid-connect/token`;

      const tokenResponse = await page.request.post(tokenUrl, {
        form: {
          /* eslint-disable @typescript-eslint/naming-convention */
          grant_type: "password",
          client_id: kcClientId,
          client_secret: kcClientSecret,
          /* eslint-enable @typescript-eslint/naming-convention */
          username,
          password,
          scope: "openid",
        },
      });
      // eslint-disable-next-line playwright/no-conditional-in-test
      if (!tokenResponse.ok()) {
        console.error(
          `Keycloak token request failed: ${tokenResponse.status()} ${await tokenResponse.text()}`,
        );
      }
      expect(tokenResponse.ok()).toBeTruthy();
      const tokenBody = await tokenResponse.json();
      const oidcToken = tokenBody.access_token;
      expect(oidcToken).toBeTruthy();

      const executeResponse = await page.request.post(
        `/api/orchestrator/v2/workflows/token-propagation/execute`,
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${backstageToken}`,
          },
          data: {
            inputData: {},
            authTokens: [
              { provider: "OAuth2", token: oidcToken },
              {
                provider: "SimpleBearerToken",
                token: "test-simple-bearer-token-value",
              },
            ],
          },
        },
      );
      // eslint-disable-next-line playwright/no-conditional-in-test
      if (!executeResponse.ok()) {
        console.error(
          `Workflow execution failed: ${executeResponse.status()} ${await executeResponse.text()}`,
        );
      }
      expect(executeResponse.ok()).toBeTruthy();
      const { id: instanceId } = await executeResponse.json();
      expect(instanceId).toBeTruthy();

      let statusBody: WorkflowInstance = {} as WorkflowInstance;
      await expect
        .poll(
          async () => {
            const statusResponse = await page.request.get(
              `/api/orchestrator/v2/workflows/instances/${instanceId}`,
              {
                headers: {
                  Authorization: `Bearer ${backstageToken}`,
                },
              },
            );
            expect(statusResponse.ok()).toBeTruthy();
            statusBody = await statusResponse.json();
            if (statusBody.state === "ERROR") {
              throw new Error(
                `Token propagation workflow reached ERROR state: ${JSON.stringify(statusBody)}`,
              );
            }
            return statusBody.state;
          },
          {
            timeout: TOKEN_PROPAGATION_POLL_TIMEOUT_MS,
            intervals: [TOKEN_PROPAGATION_POLL_INTERVAL_MS],
          },
        )
        .toBe("COMPLETED");

      expect(statusBody.workflowdata.result.completedWith).toBe("success");
      expect(statusBody.workflowdata.result.message).toContain(
        "Token propagated",
      );

      const nodes = statusBody.nodes;
      const expectedNodes = [
        "getWithBearerTokenSecurityScheme",
        "getWithOtherBearerTokenSecurityScheme",
        "getWithSimpleBearerTokenSecurityScheme",
        "extractUser",
      ];
      for (const nodeName of expectedNodes) {
        const node = nodes.find((n: WorkflowNode) => n.name === nodeName);
        expect(node, `Node '${nodeName}' should exist`).toBeDefined();
        // eslint-disable-next-line playwright/no-conditional-in-test
        if (!node) continue;
        expect(
          node.errorMessage,
          `Node '${nodeName}' should have no error`,
        ).toBeNull();
        expect(
          node.exit,
          `Node '${nodeName}' should have completed`,
        ).not.toBeNull();
      }

      // eslint-disable-next-line playwright/no-conditional-in-test
      if (process.env.IS_OPENSHIFT !== "true") {
        return;
      }

      const serviceUrl = statusBody.serviceUrl || "";
      const nsMatch = /token-propagation\.([^:/]+)/.exec(serviceUrl);
      const namespace = nsMatch?.[1] || process.env.NAME_SPACE || "";

      // eslint-disable-next-line playwright/no-conditional-in-test
      if (!namespace) {
        return;
      }

      // Validate namespace conforms to Kubernetes DNS-1123 label format
      // to prevent command injection via shell metacharacters
      // eslint-disable-next-line playwright/no-conditional-in-test
      if (!/^[a-z0-9-]+$/.test(namespace)) {
        throw new Error(
          `Invalid namespace format: "${namespace}". Must contain only lowercase alphanumeric characters and hyphens.`,
        );
      }

      const sampleServerLogs = runOc(
        ["logs", "-l", "app=sample-server", "-n", namespace, "--tail=200"],
        30_000,
      );

      expect(
        sampleServerLogs,
        "Sample-server should log /first endpoint request",
      ).toContain("Headers for first");
      expect(
        sampleServerLogs,
        "Sample-server should log /other endpoint request",
      ).toContain("Headers for other");
      expect(
        sampleServerLogs,
        "Sample-server should log /simple endpoint request",
      ).toContain("Headers for simple");
    });
  });
}
