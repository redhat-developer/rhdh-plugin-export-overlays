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

## OSL release-candidate smoke test

Trigger `periodic-ci-redhat-developer-rhdh-plugin-export-overlays-<branch>-e2e-ocp-helm-osl-rc`
for `main` or `release-2.1` using the [Gangway REST API](https://docs.ci.openshift.org/docs/how-tos/triggering-prowjobs-via-rest/).
These periodics do not run on a schedule. The Helm nightlies are unchanged.

Select the Logic IIB for the OCP minor in the job's `cluster_claim`. Resolve its
tag to a digest and read the exact Logic CSV and channel from the catalog.
Set these keys under `pod_spec_options.envs`:

- `MULTISTAGE_PARAM_OVERRIDE_OSL_IIB`: `registry-proxy.engineering.redhat.com/rh-osbs/iib@sha256:<digest>`
- `MULTISTAGE_PARAM_OVERRIDE_OSL_OCP_VERSION`: the OCP minor the candidate targets.
- `MULTISTAGE_PARAM_OVERRIDE_OSL_STARTING_CSV`: exact `logic-operator.v...` from the catalog.
- `MULTISTAGE_PARAM_OVERRIDE_OSL_CHANNEL`: optional; defaults to `stable`.
- `MULTISTAGE_PARAM_OVERRIDE_OSL_OPERATOR_DIGEST`: optional; verifies the digest of the operator image in the installed CSV.

The setup uses mounted registry credentials, never Gangway inputs. The shared
overlays runner tests only Orchestrator and saves its reports as job artifacts.
RC runs use the official overlays repository and the job's configured branch.
Rehearsals without any candidate inputs exercise GA and do not validate the RC setup.
RC runs reject overlays revisions without `ORCHESTRATOR_STRICT_DATA_INDEX`
support. Land that change on both overlays branches before enabling the jobs.
RC runs retain test namespaces for Prow's gather step.
