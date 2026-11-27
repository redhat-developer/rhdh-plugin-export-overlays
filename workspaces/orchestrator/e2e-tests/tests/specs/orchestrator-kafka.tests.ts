import { expect, test } from "@red-hat-developer-hub/e2e-test-utils/test";
import {
  resolvedKeyExchangeGroup,
  runOpensslSClientFromRhdhPod,
  TLS_GROUPS,
} from "@red-hat-developer-hub/e2e-test-utils/pqc";
import { AuthApiHelper } from "@red-hat-developer-hub/e2e-test-utils/helpers";
import {
  PRIMARY_USER,
  configureOrchestratorKafka,
  createOrchestratorPO,
  createRoleWithPolicies,
  deleteRoleAndPolicies,
  deployLockFlowWorkflow,
  globalWorkflowPolicies,
  type PolicySpec,
} from "../support/utils/test-helpers.js";
import { createDataIndexGuard } from "../support/utils/orchestrator-workflow-helpers.js";

const ensureDataIndexOrSkip = createDataIndexGuard();

const KAFKA_RBAC_ROLE = "role:default/kafkaRunAsEventTest";

// Nightly-only gate disabled so the Kafka/PQC lane also runs in PR checks.
// function kafkaE2eEnabled(): boolean {
//   return (
//     process.env.E2E_NIGHTLY_MODE === "true" ||
//     process.env.E2E_NIGHTLY_MODE === "1"
//   );
// }

function kafkaRbacPolicies(): PolicySpec[] {
  return [
    ...globalWorkflowPolicies("allow", "allow"),
    // Event-triggered runs often lack initiator ownership; need admin view to open the instance.
    {
      permission: "orchestrator.instanceAdminView",
      policy: "read",
      effect: "allow",
    },
  ];
}

/**
 * L4b: Kafka + lock-flow Run as Event.
 * Runs in both the PR e2e check and the nightly lanes.
 */
export function registerOrchestratorKafkaTests(): void {
  test.describe("Kafka Run as Event", () => {
    test.describe.configure({ timeout: 3_600_000 });
    // test.skip(
    //   !kafkaE2eEnabled(),
    //   "Kafka Run as Event e2e runs on nightlies only (E2E_NIGHTLY_MODE)",
    // );

    test.beforeAll(async ({ rhdh }, testInfo) => {
      await test.runOnce(
        `orchestrator-kafka-setup-${testInfo.project.name}`,
        async () => {
          const namespace = rhdh.deploymentConfig.namespace;
          const bootstrap = await configureOrchestratorKafka(
            namespace,
            rhdh.deploymentConfig.method,
          );
          await deployLockFlowWorkflow(namespace, bootstrap);
        },
      );
    });

    test("Verify RHDH establishes Post-Quantum (PQC) TLS 1.3 handshake with Kafka broker", async ({
      rhdh,
    }) => {
      const namespace = rhdh.deploymentConfig.namespace;
      const host = `kafka-pq.${namespace}.svc`;
      const port = 9093;
      const group = TLS_GROUPS.hybrid;

      const tlsInfo = runOpensslSClientFromRhdhPod({
        namespace,
        host,
        port,
        group,
      });
      const negotiated = resolvedKeyExchangeGroup(tlsInfo);

      console.warn(`[Kafka-PQC] target=${host}:${port} group=${group}`);
      console.warn(`[Kafka-PQC] Protocol: ${tlsInfo.protocol ?? "unknown"}`);
      console.warn(`[Kafka-PQC] Key exchange: ${negotiated ?? "unknown"}`);

      expect(
        tlsInfo.hasHandshakeError,
        `PQC TLS 1.3 handshake to Kafka on port ${port} failed for group ${group}:\n${tlsInfo.raw}`,
      ).toBe(false);
      expect(tlsInfo.protocol).toMatch(/TLSv1\.3/iu);
      expect(negotiated?.toLowerCase()).toBe(group.toLowerCase());
    });

    // Assertions live in OrchestratorPO.runLockFlowAsEvent / verifyEventTriggeredOrRunVisible.
    // eslint-disable-next-line playwright/expect-expect
    test("Run lock-flow as Event and verify trigger", async ({
      page,
      loginHelper,
      uiHelper,
    }, testInfo) => {
      test.setTimeout(600_000);
      const orchestratorPo = createOrchestratorPO(page, uiHelper);
      await loginHelper.loginAsKeycloakUser();
      await ensureDataIndexOrSkip(testInfo.project.name, test);

      const apiToken = await new AuthApiHelper(page).getToken();
      await deleteRoleAndPolicies(apiToken, KAFKA_RBAC_ROLE);
      await createRoleWithPolicies(
        apiToken,
        KAFKA_RBAC_ROLE,
        [PRIMARY_USER],
        kafkaRbacPolicies(),
      );
      try {
        await orchestratorPo.runLockFlowAsEvent();
      } finally {
        await deleteRoleAndPolicies(apiToken, KAFKA_RBAC_ROLE);
      }
    });
  });
}
