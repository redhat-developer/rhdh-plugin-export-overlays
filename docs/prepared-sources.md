# Prepared Source OCI Artifacts

Tracking: [RHIDP-15699](https://redhat.atlassian.net/browse/RHIDP-15699), [RHDHPLAN-1568](https://redhat.atlassian.net/browse/RHDHPLAN-1568)

## Goal

Publish **per-workspace prepared source trees** from this overlays repository so downstream
(`rhdh-plugin-catalog` / Konflux) can consume a stable OCI contract instead of re-running
Loops 1–3 in `sync-midstream.sh`.

Source preparation belongs in overlays (engineering ownership). Productization then becomes
mechanical consumption of these artifacts.

## Registry contract

| Field | Value |
|-------|-------|
| Image | `quay.io/rhdh/prepared-sources/<workspace>` |
| Tag | Overlay branch name (`main`, `release-1.10`, …) — mutable |
| Artifact type | `application/vnd.rhdh.prepared-source.v1+tar` |

### Annotations

| Annotation | Meaning |
|------------|---------|
| `org.rhdh.overlay-commit` | SHA of the overlays commit used to build the tree |
| `org.rhdh.source-ref` | Upstream git ref from `workspaces/<workspace>/source.json` (`repo-ref`) |

### Example

```text
quay.io/rhdh/prepared-sources/topology:main
quay.io/rhdh/prepared-sources/orchestrator:release-1.10
```

Reference artifacts produced temporarily from midstream (if any) use a separate prefix
`quay.io/rhdh/prepared-sources-ref/<workspace>` so the two never collide. Consumers switch
by changing only the registry prefix.

## Freshness (consumer side)

After pull, consumers must verify the artifact is not stale relative to the overlays clone:

```bash
git log <org.rhdh.overlay-commit>..HEAD -- \
  workspaces/<workspace>/ \
  versions.json \
  rhdh-supported-packages.txt \
  rhdh-community-packages.txt
```

Non-empty output → fail the build (no fallback to Loops 1–3).

## Producer workflow (this repo)

`.github/workflows/publish-prepared-sources.yaml`

- Manual (`workflow_dispatch`) first, so we can validate Quay repos and content before wiring
  to every `main` / `release-*` publish.
- Per-workspace job: clone upstream → apply overlays/patches → yarn install → export
  dynamic plugins → scrub install caches → `oras push`.
- Push helper: `scripts/prepared-sources/push-prepared-source.sh`

### Current content vs midstream Loop 3

| Step | Overlays producer (this PR) | Midstream `sync-midstream` |
|------|-----------------------------|----------------------------|
| Clone + overlay/patches | Yes | Yes (Loop 1) |
| Dynamic export (`dist-dynamic`) | Yes | Yes |
| `update-workspace.js` transforms (Loop 2) | **Not yet** | Yes |
| Re-export + dependency drift gate (Loop 3) | **Not yet** | Yes |

This PR establishes the **OCI publish path and annotations in overlays**. Follow-ups under
RHDHPLAN-1568 will bring Loop 2/3–equivalent transforms into this repo (TypeScript + tests)
so artifacts are Konflux-ready without further midstream mutation.

## Local usage

```bash
# After preparing a workspace tree locally:
./scripts/prepared-sources/push-prepared-source.sh \
  --dir /path/to/prepared/topology \
  --image quay.io/rhdh/prepared-sources/topology:main \
  --overlay-commit "$(git rev-parse HEAD)" \
  --source-ref "$(jq -r '."repo-ref"' workspaces/topology/source.json)"
```

Requires `oras` on `PATH` and registry credentials (`oras login quay.io`).
