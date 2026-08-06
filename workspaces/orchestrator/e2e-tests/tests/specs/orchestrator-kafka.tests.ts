import { test } from "@red-hat-developer-hub/e2e-test-utils/test";
import { OrchestratorPO } from "../support/pages/orchestrator-po.js";
import {
  PRIMARY_USER,
  configureOrchestratorKafka,
  createRoleWithPolicies,
  deleteRoleAndPolicies,
  deployLockFlowWorkflow,
  globalWorkflowPolicies,
  setupAuthenticatedPage,
  type PolicySpec,
} from "../support/utils/test-helpers.js";
import { createDataIndexGuard } from "../support/utils/orchestrator-workflow-helpers.js";

const ensureDataIndexOrSkip = createDataIndexGuard();

const KAFKA_RBAC_ROLE = "role:default/kafkaRunAsEventTest";

function kafkaE2eEnabled(): boolean {
  const v = process.env.ORCH_E2E_KAFKA ?? "";
  return v === "1" || v.toLowerCase() === "true";
}

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
 * Optional L4b: Kafka + lock-flow Run as Event.
 * Enable with ORCH_E2E_KAFKA=1 (see README / yarn test:kafka).
 */
export function registerOrchestratorKafkaTests(): void {
  test.describe("Kafka Run as Event", () => {
    test.skip(
      !kafkaE2eEnabled(),
      "Set ORCH_E2E_KAFKA=1 to run optional Kafka Run as Event e2e",
    );

    let apiToken: string;

    test.beforeAll(async ({ browser, rhdh }, testInfo) => {
      // Kafka install + workflow deploy + RHDH restart can exceed 40 minutes.
      test.setTimeout(60 * 60 * 1000);
      await test.runOnce(
        `orchestrator-kafka-setup-${testInfo.project.name}`,
        async () => {
          const namespace = rhdh.deploymentConfig.namespace;
          await configureOrchestratorKafka(namespace);
          await deployLockFlowWorkflow(namespace);
        },
      );

      ({ apiToken } = await setupAuthenticatedPage(browser, testInfo));
      await deleteRoleAndPolicies(apiToken, KAFKA_RBAC_ROLE);
      await createRoleWithPolicies(
        apiToken,
        KAFKA_RBAC_ROLE,
        [PRIMARY_USER],
        kafkaRbacPolicies(),
      );
    });

    test.afterAll(async () => {
      if (apiToken) {
        await deleteRoleAndPolicies(apiToken, KAFKA_RBAC_ROLE);
      }
    });

    // Assertions live in OrchestratorPO.runLockFlowAsEvent / expectEventTriggeredOrRunVisible.
    // eslint-disable-next-line playwright/expect-expect
    test("Run lock-flow as Event and verify trigger", async ({
      page,
      loginHelper,
      uiHelper,
    }, testInfo) => {
      test.setTimeout(600_000);
      const orchestratorPo = new OrchestratorPO(page, uiHelper);
      await loginHelper.loginAsKeycloakUser();
      await ensureDataIndexOrSkip(testInfo.project.name, test);
      await orchestratorPo.runLockFlowAsEvent();
    });
  });
}
