# DevPortal Plugin Distribution Pipeline — Executive Summary

**To:** Andre (Tech Lead)
**Date:** 2026-03-11

---

## 1. What was done

We forked the RHDH (Red Hat Developer Hub) plugin export system into the `veecode-platform` org and adapted the entire pipeline for DevPortal.
The result is two repositories that together compile upstream Backstage plugins as dynamic plugins and publish each one as an OCI artifact to GitHub Container Registry.
We currently have **67 workspaces** configured (31 validated and publishing), covering **~75 plugins** from the `backstage` core workspace alone, plus integrations like ArgoCD, Tekton, Jenkins, GitLab, Kubernetes, SonarQube, and many others.

---

## 2. How it works

```
 workspaces/<name>/source.json        ->  points to upstream repo + commit/tag
 workspaces/<name>/plugins-list.yaml  ->  lists which plugins to export
 workspaces/<name>/metadata/          ->  package metadata for each plugin (optional)
                   |
                   v
        GitHub Actions (push to main or workflow_dispatch)
                   |
                   v
        @red-hat-developer-hub/cli 1.10.0  -->  plugin export
                   |
                   v
        ghcr.io/veecode-platform/devportal-plugin-export-overlays/<plugin>:<tag>
```

**Triggers:**

| Event | When |
|-------|------|
| Push to `main` | When `workspaces/**` or `versions.json` change |
| Cron (discovery) | Daily at 22h UTC, weekdays |
| Manual | `workflow_dispatch` via GitHub Actions |

**Versions pinned in `versions.json`:**

| Component | Version |
|-----------|---------|
| Backstage | 1.48.4 |
| Node | 22.19.0 |
| CLI (`@red-hat-developer-hub/cli`) | 1.10.0 |

---

## 3. Active workspaces

The 67 workspaces cover the following areas (summarized):

| Category | Workspaces |
|----------|-----------|
| **CI/CD** | argocd, tekton, jenkins, github-actions |
| **SCM / Code** | gitlab, github-issues, github-pull-requests-board, github-notifications |
| **Quality** | sonarqube, lighthouse, scorecard, tech-insights |
| **Infra / Cloud** | kubernetes, topology, aws-codebuild, aws-ecs, azure-devops, acr, acs |
| **Backstage Core** | backstage (~75 plugins: auth modules, catalog modules, scaffolder modules, techdocs, notifications, search, etc.) |
| **Observability** | dynatrace, dynatrace-dql, pagerduty |
| **Registry / Artifacts** | quay, jfrog-artifactory, nexus-repository-manager, npm |
| **AI / MCP** | lightspeed, mcp-chat, mcp-integrations, ai-integrations |
| **Other** | announcements, bookmarks, todo, tech-radar, adr, homepage, theme, translations, rbac, keycloak, kiali, servicenow, ocm, orchestrator, bulk-import |

The `backstage` workspace alone exports ~75 plugins (auth providers, catalog backends, scaffolder modules, techdocs, notifications, kubernetes, etc.).

---

## 4. Adding a new plugin

1. **Create the directory:**
   ```bash
   mkdir -p workspaces/<workspace-name>
   ```

2. **Add `source.json`** pointing to the upstream repo:
   ```json
   {
     "repo": "https://github.com/<org>/<repo>",
     "repo-ref": "<commit-sha-or-tag>",
     "repo-flat": false,
     "repo-backstage-version": "1.48.4"
   }
   ```
   - `repo-flat: true` if plugins live at the repo root (e.g. `backstage/backstage`).
   - `repo-flat: false` if they are inside a workspace subfolder.

3. **Add `plugins-list.yaml`** listing the plugins:
   ```yaml
   plugins/my-plugin:
   plugins/my-plugin-backend: --embed-package @scope/dependency
   ```

4. **(Optional)** Add `metadata/`, overlays, or patches as needed.

5. **Push to `main`** — the pipeline runs automatically.

To **disable** a workspace: rename `plugins-list.yaml` to `plugins-list.yaml.disabled`.

---

## 5. Consuming plugins in DevPortal

Reference the OCI artifact in your DevPortal's `dynamic-plugins.yaml`:

```yaml
plugins:
  # Example: ArgoCD frontend
  - package: oci://ghcr.io/veecode-platform/devportal-plugin-export-overlays/backstage-community-plugin-argocd:bs_1.48.4__2.4.3!backstage-community-plugin-argocd
    disabled: false
    pluginConfig: {}

  # Example: ArgoCD backend
  - package: oci://ghcr.io/veecode-platform/devportal-plugin-export-overlays/backstage-community-plugin-argocd-backend:bs_1.48.4__2.4.3!backstage-community-plugin-argocd-backend
    disabled: false
    pluginConfig:
      argocd:
        baseUrl: https://argocd.example.com

  # Example: Techdocs
  - package: oci://ghcr.io/veecode-platform/devportal-plugin-export-overlays/backstage-plugin-techdocs:bs_1.48.4__1.12.6!backstage-plugin-techdocs
    disabled: false
    pluginConfig: {}
```

**Tag format:** `bs_<backstage_version>__<plugin_version>` (e.g. `bs_1.48.4__2.4.3`).

The `!` suffix after the tag specifies the integrity sub-path inside the OCI image.

---

## 6. End-to-end validation

Consumption was tested locally with success. OCI plugins (tekton, todo, todo-backend) were downloaded from ghcr.io via skopeo, extracted, configured, and loaded in DevPortal without any recompilation.

- Backend: plugin registered routes automatically
- Frontend: plugin rendered card in the UI via Scalprum + pluginConfig mount points
- API `/api/dynamic-plugins-info/loaded-plugins` confirmed loading

**Note on authentication:** packages on ghcr.io are private by default in organizations. To consume them, you need to mount Docker credentials in the container (see distro documentation) or make the packages public.

---

## 7. Suggested next steps

1. **Define package visibility:** Public (no auth, good for open source) or private (requires credentials in the cluster). Consider Quay.io as an alternative registry — the pipeline already supports it, just adjust `image-repository-prefix` and add the authentication secret.

2. **Expand workspaces:** Evaluate workspaces that are not yet validated and enable the most relevant ones for customers.

3. **Automated smoke tests:** Configure the smoke tests that already exist in the repo structure to run after each publish.

4. **Backstage versioning:** When a new Backstage version is released, update `versions.json` and run the full pipeline. SYNC.md documents how to pull upstream RHDH improvements.

5. **Catalog documentation:** Use `catalog-entities/` to register dynamic plugins in DevPortal itself as catalog components.

---

## 8. Useful links

| Resource | Link |
|----------|------|
| Overlays repo (plugin definitions) | https://github.com/veecode-platform/devportal-plugin-export-overlays |
| Utils repo (workflows and tooling) | https://github.com/veecode-platform/devportal-plugin-export-utils |
| Published packages (GHCR) | https://github.com/orgs/veecode-platform/packages?repo_name=devportal-plugin-export-overlays |
| Upstream RHDH Overlays | https://github.com/redhat-developer/rhdh-plugin-export-overlays |
| Upstream RHDH Utils | https://github.com/redhat-developer/rhdh-plugin-export-utils |
| Upstream sync guide | `SYNC.md` |
