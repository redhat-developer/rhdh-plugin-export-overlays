# Orchestrator e2e tests

Playwright suite for the Orchestrator overlays workspace. Default `yarn test` deploys SonataFlow workflows (greeting, failswitch, etc.) and runs the core UI/API tests.

## Optional: Kafka Run as Event (`ORCH_E2E_KAFKA`)

Env-gated L4b coverage for cloud-event workflow execution ([RHIDP-16050](https://redhat.atlassian.net/browse/RHIDP-16050)):

1. Installs a small Streams for Apache Kafka cluster (1 broker + 1 controller, RF=1) in the e2e namespace
2. Patches RHDH `app-config-rhdh` with `orchestrator.kafka` and restarts RHDH (scale 0→1)
3. Deploys `lock-flow` from [orchestrator-demo `08_kafka_events/callback-flow`](https://github.com/rhdhorchestrator/orchestrator-demo/tree/main/08_kafka_events/callback-flow)
4. Asserts UI **Run as Event** triggers the workflow (event alert and/or Running/Completed)

### How to run

```bash
# After the usual e2e cluster/auth prerequisites (oc login, Keycloak env, etc.)
yarn test:kafka
# equivalent: ORCH_E2E_KAFKA=true yarn test
```

Without `ORCH_E2E_KAFKA=true`, the Kafka suite is skipped and does not affect the default job.

### Capacity / runtime

- Expect **~15–40 minutes** extra for Kafka operator + cluster Ready + workflow deploy + RHDH restart on a clean job
- Prefer at least moderate worker capacity; default 3+3 Kafka is intentionally **not** used (QE-sized 1+1)
- Release-event / `LOCK_ID` console-producer path stays **manual** (not automated here)

### Prerequisites for the Kafka suite

- Cluster-admin (or enough rights for OperatorHub Subscription + Kafka CRs)
- PyYAML available to `python3` (`python3 -c 'import yaml'`) for app-config merge
- Same base orchestrator e2e substrate as the main suite (OSL / SonataFlow / RHDH via `orchestrator.spec.ts`)

### Optional env knobs

| Var                              | Role                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORCH_E2E_KAFKA=true`            | Enable Kafka Run as Event suite                                                                                                                   |
| `SKIP_ORCHESTRATOR_DEPLOY=true`  | Skip SonataFlow/Loki/RHDH redeploy (local/dev on an already-live substrate). Requires `RHDH_BASE_URL` (errors if unset). Not used in CI.          |
| `DEMO_WORKFLOW_REPO_REF`         | Pin `orchestrator-demo` clone (branch/tag/SHA) for lock-flow and token-propagation; unset uses default-branch tip                                 |
