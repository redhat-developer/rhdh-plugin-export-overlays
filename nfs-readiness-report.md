## NFS Readiness Report

**Generated:** 2026-08-10 13:58 UTC

### Summary

| Status | Count | Description |
|--------|-------|-------------|
| :green_circle: nfs-ready | 41 | All entry points are NFS feature types |
| :yellow_circle: mixed | 0 | Some NFS entry points, some legacy/unrecognized |
| :orange_circle: legacy-only | 0 | Entry points present but none are NFS types |
| :red_circle: no-features | 31 | `backstage.features` field absent or empty in OCI artifact |
| :blue_circle: baked-in | 1 | Ships inside the RHDH container image (local path, not OCI) |
| :purple_circle: external-registry | 1 | Hosted on a non-GHCR registry (cannot inspect) |
| :white_circle: unknown | 0 | Could not determine status (no `--oci` flag or pull failed) |
| — backend-only | 106 | Backend plugin (not applicable) |

**Frontend plugins:** 74 total — **41** NFS-ready (55%)

### By Support Tier

#### Red Hat Supported (GA + Tech Preview) (19/20 frontend plugins NFS-ready — 95%)

| Plugin | Workspace | Status | Features |
|--------|-----------|--------|----------|
| @red-hat-developer-hub/backstage-plugin-extensions | extensions | :blue_circle: baked-in | — |
| @red-hat-developer-hub/backstage-plugin-adoption-insights | adoption-insights | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendPlugin, `./adoption-insights-translations-module` → @backstage/FrontendModule |
| @backstage-community/plugin-analytics-provider-segment | analytics | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendModule |
| @red-hat-developer-hub/backstage-plugin-app-auth | app-defaults | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendModule |
| @red-hat-developer-hub/backstage-plugin-app-defaults | app-defaults | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendModule |
| @red-hat-developer-hub/backstage-plugin-app-integrations | app-defaults | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendModule |
| @backstage/plugin-kubernetes | backstage | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendPlugin |
| @backstage/plugin-notifications | backstage | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendPlugin |
| @backstage/plugin-signals | backstage | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendPlugin |
| @backstage/plugin-techdocs | backstage | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendPlugin |
| @red-hat-developer-hub/backstage-plugin-bulk-import | bulk-import | :green_circle: nfs-ready | `.` → @backstage/FrontendPlugin |
| @red-hat-developer-hub/backstage-plugin-global-header | global-header | :green_circle: nfs-ready | `.` → @backstage/FrontendPlugin, `./global-header-module` → @backstage/FrontendModule, `./global-header-translations-module` → @backstage/FrontendModule |
| @red-hat-developer-hub/backstage-plugin-homepage | homepage | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendModule, `./homepage-translations-module` → @backstage/FrontendModule |
| @red-hat-developer-hub/backstage-plugin-intelligent-assistant | intelligent-assistant | :green_circle: nfs-ready | `.` → @backstage/FrontendPlugin, `./intelligent-assistant-fab-module` → @backstage/FrontendModule, `./intelligent-assistant-translations-module` → @backstage/FrontendModule |
| @red-hat-developer-hub/backstage-plugin-orchestrator | orchestrator | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendPlugin, `./orchestrator-translations-module` → @backstage/FrontendModule |
| @red-hat-developer-hub/backstage-plugin-orchestrator-form-widgets | orchestrator | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendPlugin |
| @red-hat-developer-hub/backstage-plugin-quickstart | quickstart | :green_circle: nfs-ready | `.` → @backstage/FrontendPlugin, `./quickstart-init-module` → @backstage/FrontendModule, `./quickstart-translations-module` → @backstage/FrontendModule |
| @backstage-community/plugin-rbac | rbac | :green_circle: nfs-ready | `.` → @backstage/FrontendPlugin, `./translations` → @backstage/FrontendModule |
| @backstage-community/plugin-tech-radar | tech-radar | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendPlugin |
| @backstage-community/plugin-topology | topology | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendPlugin, `./translations` → @backstage/FrontendModule |

#### Community (14/24 frontend plugins NFS-ready — 58%)

| Plugin | Workspace | Status | Features |
|--------|-----------|--------|----------|
| @backstage-community/plugin-acr | acr | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendPlugin, `./translations` → @backstage/FrontendModule |
| @backstage-community/plugin-azure-devops | azure-devops | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendPlugin |
| @backstage-community/plugin-dynatrace | dynatrace | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendPlugin |
| @backstage-community/plugin-github-actions | github | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendPlugin |
| @backstage-community/plugin-github-deployments | github | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendPlugin |
| @backstage-community/plugin-github-discussions | github | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendPlugin |
| @backstage-community/plugin-github-issues | github | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendPlugin |
| @backstage-community/plugin-github-pull-requests-board | github | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendPlugin |
| @backstage-community/plugin-jenkins | jenkins | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendPlugin |
| @backstage-community/plugin-lighthouse | lighthouse | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendPlugin |
| @backstage-community/plugin-nexus-repository-manager | nexus-repository-manager | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendPlugin, `./translations` → @backstage/FrontendModule |
| @backstage-community/plugin-quay | quay | :green_circle: nfs-ready | `.` → @backstage/FrontendPlugin |
| @red-hat-developer-hub/backstage-plugin-scorecard | scorecard | :green_circle: nfs-ready | `.` → @backstage/FrontendPlugin, `./scorecard-translations-module` → @backstage/FrontendModule |
| @backstage-community/plugin-tekton | tekton | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendPlugin, `./translations` → @backstage/FrontendModule |
| @backstage-community/plugin-argocd | argocd | :red_circle: no-features | — |
| @immobiliarelabs/backstage-plugin-gitlab | gitlab | :red_circle: no-features | — |
| @backstage-community/plugin-jfrog-artifactory | jfrog-artifactory | :red_circle: no-features | — |
| @pagerduty/backstage-plugin | pagerduty | :red_circle: no-features | — |
| @roadiehq/backstage-plugin-datadog | roadie-backstage-plugins | :red_circle: no-features | — |
| @roadiehq/backstage-plugin-github-insights | roadie-backstage-plugins | :red_circle: no-features | — |
| @roadiehq/backstage-plugin-github-pull-requests | roadie-backstage-plugins | :red_circle: no-features | — |
| @roadiehq/backstage-plugin-jira | roadie-backstage-plugins | :red_circle: no-features | — |
| @roadiehq/backstage-plugin-security-insights | roadie-backstage-plugins | :red_circle: no-features | — |
| @backstage-community/plugin-sonarqube | sonarqube | :red_circle: no-features | — |

#### Other (8/30 frontend plugins NFS-ready — 26%)

| Plugin | Workspace | Status | Features |
|--------|-----------|--------|----------|
| @red-hat-developer-hub/plugin-cost-management | cost-management | :purple_circle: external-registry | — |
| @backstage-community/plugin-adr | adr | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendPlugin |
| @backstage-community/plugin-announcements | announcements | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendPlugin |
| @backstage/plugin-app-visualizer | backstage | :green_circle: nfs-ready | `.` → @backstage/FrontendPlugin |
| @backstage/plugin-auth | backstage | :green_circle: nfs-ready | `.` → @backstage/FrontendPlugin |
| @backstage-community/plugin-servicenow | servicenow | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendPlugin, `./translations` → @backstage/FrontendModule |
| @red-hat-developer-hub/backstage-plugin-theme | theme | :green_circle: nfs-ready | `.` → @backstage/FrontendModule |
| @backstage-community/plugin-todo | todo | :green_circle: nfs-ready | `./alpha` → @backstage/FrontendPlugin |
| @red-hat-developer-hub/backstage-plugin-translations | translations | :green_circle: nfs-ready | `.` → @backstage/FrontendPlugin, `./translations-api-module` → @backstage/FrontendModule, `./translations-pseudo-localization-module` → @backstage/FrontendModule |
| @backstage-community/plugin-acs | acs | :red_circle: no-features | — |
| @aws/amazon-ecs-plugin-for-backstage | backstage-plugins-for-aws | :red_circle: no-features | — |
| @aws/aws-codebuild-plugin-for-backstage | backstage-plugins-for-aws | :red_circle: no-features | — |
| @aws/aws-codepipeline-plugin-for-backstage | backstage-plugins-for-aws | :red_circle: no-features | — |
| @backstage-community/plugin-bookmarks | bookmarks | :red_circle: no-features | — |
| @proberaum/backstage-plugin-config-viewer | config-viewer | :red_circle: no-features | — |
| @dynatrace/backstage-plugin-dql | dynatrace-dql | :red_circle: no-features | — |
| @proberaum/backstage-plugin-env-viewer | env-viewer | :red_circle: no-features | — |
| @proberaum/backstage-plugin-icon-viewer | icon-viewer | :red_circle: no-features | — |
| @backstage-community/plugin-kiali | kiali | :red_circle: no-features | — |
| @red-hat-developer-hub/backstage-plugin-konflux | konflux | :red_circle: no-features | — |
| @backstage-community/plugin-mcp-chat | mcp-chat | :red_circle: no-features | — |
| @backstage-community/backstage-plugin-mta-frontend | mta | :red_circle: no-features | — |
| @backstage-community/plugin-multi-source-security-viewer | multi-source-security-viewer | :red_circle: no-features | — |
| @backstage-community/plugin-npm | npm | :red_circle: no-features | — |
| @roadiehq/backstage-plugin-argo-cd | roadie-backstage-plugins | :red_circle: no-features | — |
| @backstage-community/plugin-tech-insights | tech-insights | :red_circle: no-features | — |
| @backstage-community/plugin-tech-insights-maturity | tech-insights | :red_circle: no-features | — |
| @red-hat-developer-hub/backstage-plugin-qe-theme | theme | :red_circle: no-features | — |
| @red-hat-developer-hub/backstage-plugin-x2a | x2a | :red_circle: no-features | — |
| @red-hat-developer-hub/backstage-plugin-x2a-dcr | x2a | :red_circle: no-features | — |

### Backend-Only Plugins (not applicable)

<details>
<summary>106 backend plugins (no NFS classification needed)</summary>

| Plugin | Workspace | Tier |
|--------|-----------|------|
| @backstage-community/plugin-3scale-backend | 3scale | community |
| @red-hat-developer-hub/backstage-plugin-adoption-insights-backend | adoption-insights | supported |
| @red-hat-developer-hub/backstage-plugin-analytics-module-adoption-insights | adoption-insights | supported |
| @backstage-community/plugin-adr-backend | adr | other |
| @backstage-community/search-backend-module-adr | adr | other |
| @red-hat-developer-hub/backstage-plugin-catalog-backend-module-model-catalog | ai-integrations | other |
| @red-hat-developer-hub/backstage-plugin-catalog-techdoc-url-reader-backend | ai-integrations | other |
| @backstage-community/plugin-analytics-module-ga4 | analytics | supported |
| @backstage-community/plugin-analytics-module-matomo | analytics | supported |
| @backstage-community/plugin-analytics-module-newrelic-browser | analytics | supported |
| @backstage-community/plugin-announcements-backend | announcements | other |
| @backstage-community/plugin-search-backend-module-announcements | announcements | other |
| apic-backstage | apiconnect | other |
| @backstage-community/plugin-argocd-backend | argocd | community |
| @backstage-community/plugin-azure-devops-backend | azure-devops | community |
| @backstage-community/plugin-catalog-backend-module-azure-devops-annotator-processor | azure-devops | community |
| @backstage-community/plugin-scaffolder-backend-module-azure-devops | azure-devops | community |
| @backstage-community/plugin-scaffolder-backend-module-dotnet | azure-devops | community |
| @backstage-community/plugin-search-backend-module-azure-devops | azure-devops | community |
| @aws/amazon-ecs-plugin-for-backstage-backend | backstage-plugins-for-aws | other |
| @aws/aws-codebuild-plugin-for-backstage-backend | backstage-plugins-for-aws | other |
| @aws/aws-codepipeline-plugin-for-backstage-backend | backstage-plugins-for-aws | other |
| @backstage/plugin-catalog-backend-module-bitbucket-cloud | backstage | community |
| @backstage/plugin-catalog-backend-module-bitbucket-server | backstage | community |
| @backstage/plugin-catalog-backend-module-github-org | backstage | supported |
| @backstage/plugin-catalog-backend-module-github | backstage | supported |
| @backstage/plugin-catalog-backend-module-gitlab-org | backstage | supported |
| @backstage/plugin-catalog-backend-module-gitlab | backstage | supported |
| @backstage/plugin-catalog-backend-module-ldap | backstage | supported |
| @backstage/plugin-catalog-backend-module-msgraph | backstage | supported |
| @backstage/plugin-events-backend-module-github | backstage | supported |
| @backstage/plugin-events-backend-module-gitlab | backstage | supported |
| @backstage/plugin-kubernetes-backend | backstage | supported |
| @backstage/plugin-mcp-actions-backend | backstage | other |
| @backstage/plugin-notifications-backend-module-email | backstage | supported |
| @backstage/plugin-notifications-backend | backstage | supported |
| @backstage/plugin-scaffolder-backend-module-azure | backstage | community |
| @backstage/plugin-scaffolder-backend-module-bitbucket-cloud | backstage | community |
| @backstage/plugin-scaffolder-backend-module-bitbucket-server | backstage | community |
| @backstage/plugin-scaffolder-backend-module-gerrit | backstage | community |
| @backstage/plugin-scaffolder-backend-module-github | backstage | supported |
| @backstage/plugin-scaffolder-backend-module-gitlab | backstage | supported |
| @backstage/plugin-signals-backend | backstage | supported |
| @backstage/plugin-techdocs-backend | backstage | supported |
| @backstage/plugin-techdocs-module-addons-contrib | backstage | supported |
| @red-hat-developer-hub/backstage-plugin-bulk-import-backend | bulk-import | supported |
| @proberaum/backstage-plugin-config-viewer-backend | config-viewer | other |
| @red-hat-developer-hub/plugin-cost-management-backend | cost-management | other |
| @dynatrace/backstage-plugin-dql-backend | dynatrace-dql | other |
| @proberaum/backstage-plugin-env-viewer-backend | env-viewer | other |
| @red-hat-developer-hub/backstage-plugin-catalog-backend-module-extensions | extensions | supported |
| @red-hat-developer-hub/backstage-plugin-extensions-backend | extensions | supported |
| @proberaum/backstage-plugin-github-notifications-backend | github-notifications | other |
| @backstage-community/plugin-search-backend-module-github-discussions | github | community |
| @immobiliarelabs/backstage-plugin-gitlab-backend | gitlab | community |
| @red-hat-developer-hub/backstage-plugin-homepage-backend | homepage | supported |
| @red-hat-developer-hub/backstage-plugin-intelligent-assistant-backend | intelligent-assistant | supported |
| @backstage-community/plugin-jenkins-backend | jenkins | community |
| @backstage-community/plugin-scaffolder-backend-module-jenkins | jenkins | community |
| @backstage-community/plugin-catalog-backend-module-keycloak | keycloak | supported |
| @backstage-community/plugin-kiali-backend | kiali | other |
| @red-hat-developer-hub/backstage-plugin-konflux-backend | konflux | other |
| @backstage-community/plugin-lighthouse-backend | lighthouse | community |
| @backstage-community/plugin-mcp-chat-backend | mcp-chat | other |
| @red-hat-developer-hub/backstage-plugin-scaffolder-mcp-extras | mcp-integrations | other |
| @red-hat-developer-hub/backstage-plugin-software-catalog-mcp-extras | mcp-integrations | other |
| @red-hat-developer-hub/backstage-plugin-techdocs-mcp-extras | mcp-integrations | other |
| @backstage-community/backstage-plugin-catalog-backend-module-mta-entity-provider | mta | other |
| @backstage-community/backstage-plugin-mta-backend | mta | other |
| @backstage-community/backstage-plugin-scaffolder-backend-module-mta | mta | other |
| @backstage-community/plugin-multi-source-security-viewer-backend | multi-source-security-viewer | other |
| @backstage-community/plugin-npm-backend | npm | other |
| @red-hat-developer-hub/backstage-plugin-orchestrator-backend-module-loki | orchestrator | supported |
| @red-hat-developer-hub/backstage-plugin-orchestrator-backend | orchestrator | supported |
| @red-hat-developer-hub/backstage-plugin-scaffolder-backend-module-orchestrator | orchestrator | supported |
| @pagerduty/backstage-plugin-backend | pagerduty | community |
| @pagerduty/backstage-plugin-entity-processor | pagerduty | community |
| @pagerduty/backstage-plugin-scaffolder-actions | pagerduty | community |
| @backstage-community/plugin-catalog-backend-module-pingidentity | pingidentity | supported |
| @backstage-community/plugin-quay-backend | quay | community |
| @backstage-community/plugin-scaffolder-backend-module-quay | quay | community |
| @roadiehq/backstage-plugin-argo-cd-backend | roadie-backstage-plugins | community |
| @roadiehq/scaffolder-backend-argocd | roadie-backstage-plugins | community |
| @roadiehq/scaffolder-backend-module-aws | roadie-backstage-plugins | other |
| @roadiehq/scaffolder-backend-module-http-request | roadie-backstage-plugins | supported |
| @roadiehq/scaffolder-backend-module-utils | roadie-backstage-plugins | community |
| @backstage-community/plugin-scaffolder-backend-module-kubernetes | scaffolder-backend-module-kubernetes | supported |
| @backstage-community/plugin-scaffolder-backend-module-regex | scaffolder-backend-module-regex | supported |
| @backstage-community/plugin-scaffolder-backend-module-servicenow | scaffolder-backend-module-servicenow | community |
| @backstage-community/plugin-scaffolder-backend-module-sonarqube | scaffolder-backend-module-sonarqube | community |
| @backstage-community/plugin-catalog-backend-module-scaffolder-relation-processor | scaffolder-relation-processor | supported |
| @red-hat-developer-hub/backstage-plugin-scorecard-backend-module-dependabot | scorecard | community |
| @red-hat-developer-hub/backstage-plugin-scorecard-backend-module-filecheck | scorecard | community |
| @red-hat-developer-hub/backstage-plugin-scorecard-backend-module-github | scorecard | community |
| @red-hat-developer-hub/backstage-plugin-scorecard-backend-module-jira | scorecard | community |
| @red-hat-developer-hub/backstage-plugin-scorecard-backend-module-openssf | scorecard | community |
| @red-hat-developer-hub/backstage-plugin-scorecard-backend-module-sonarqube | scorecard | community |
| @red-hat-developer-hub/backstage-plugin-scorecard-backend | scorecard | community |
| @backstage-community/plugin-servicenow-backend | servicenow | other |
| @backstage-community/plugin-sonarqube-backend | sonarqube | community |
| @backstage-community/plugin-tech-insights-backend-module-jsonfc | tech-insights | other |
| @backstage-community/plugin-tech-radar-backend | tech-radar | supported |
| @backstage-community/plugin-todo-backend | todo | other |
| @red-hat-developer-hub/backstage-plugin-scaffolder-backend-module-x2a | x2a | other |
| @red-hat-developer-hub/backstage-plugin-x2a-backend | x2a | other |
| @red-hat-developer-hub/backstage-plugin-x2a-mcp-extras | x2a | other |

</details>

---

### Classification Reference

The NFS readiness status is derived from the `backstage.features` field in each plugin's
`dist-dynamic/package.json`, which is populated by `rhdh-cli >= 1.11.3` during
`export-dynamic-plugin`.

The classification aligns with the [`nfsModuleFilter`](https://github.com/redhat-developer/rhdh/blob/main/packages/backend/src/modules/nfsModuleFilter.ts)
logic in RHDH, which recognizes these NFS feature types:

- `@backstage/FrontendPlugin`
- `@backstage/FrontendModule`

Plugins classified as **no-features** were exported with `rhdh-cli >= 1.11.3` but don't
have standard Module Federation exports that the CLI can detect.

Plugins classified as **baked-in** ship inside the RHDH container image and are not
published as separate OCI artifacts.

Plugins classified as **external-registry** are hosted on a non-GHCR registry
(e.g., `quay.io`) and cannot be inspected by this report.

