# Orchestrator e2e tests

Playwright suite for the Orchestrator overlays workspace. Default `yarn test` deploys SonataFlow workflows (greeting, failswitch, etc.) and runs the core UI/API tests.

## Kafka Run as Event (nightlies only)

L4b coverage for cloud-event workflow execution ([RHIDP-16050](https://redhat.atlassian.net/browse/RHIDP-16050)). Enabled when `E2E_NIGHTLY_MODE` is set (nightly CI); skipped in default PR e2e:

1. Installs a small Streams for Apache Kafka cluster (1 broker + 1 controller, RF=1) in the e2e namespace
2. Patches RHDH `app-config-rhdh` with `orchestrator.kafka` and restarts RHDH (scale 0→1)
3. Deploys `lock-flow` from [orchestrator-demo `08_kafka_events/callback-flow`](https://github.com/rhdhorchestrator/orchestrator-demo/tree/main/08_kafka_events/callback-flow)
4. Asserts UI **Run as Event** produces a live run (**Running** or **Completed**)

### How to run locally (simulate nightly)

```bash
# After the usual e2e cluster/auth prerequisites (oc login, Keycloak env, etc.)
yarn test:kafka
# equivalent: E2E_NIGHTLY_MODE=true yarn test
```

### Capacity / runtime

- Expect **~15–40 minutes** extra for Kafka operator + cluster Ready + workflow deploy + RHDH restart on a clean job
- Prefer at least moderate worker capacity; default 3+3 Kafka is intentionally **not** used (QE-sized 1+1)
- Release-event / `LOCK_ID` console-producer path stays **manual** (not automated here)

### Prerequisites for the Kafka suite

- Cluster-admin (or enough rights for OperatorHub Subscription + Kafka CRs)
- Same base orchestrator e2e substrate as the main suite (OSL / SonataFlow / RHDH via `orchestrator.spec.ts`)

### Optional env knobs

| Var                             | Role                                                                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `E2E_NIGHTLY_MODE=true`         | Enable Kafka Run as Event suite (set automatically in nightly CI)                                                                        |
| `SKIP_ORCHESTRATOR_DEPLOY=true` | Skip SonataFlow/Loki/RHDH redeploy (local/dev on an already-live substrate). Requires `RHDH_BASE_URL` (errors if unset). Not used in CI. |
| `DEMO_WORKFLOW_REPO_REF`        | Pin `orchestrator-demo` clone (branch/tag/SHA) for lock-flow and token-propagation; unset uses default-branch tip                        |
| `KAFKA_CLUSTER_NAME`            | Kafka CR name (default `my-cluster`). RHDH brokers and lock-flow props are patched to the same bootstrap                                 |
