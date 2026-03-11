# DevPortal Plugin Distribution Pipeline — Resumo Executivo

**Para:** Andre (Tech Lead)
**Data:** 2026-03-11

---

## 1. O que foi feito

Forkamos o sistema de exportacao de plugins do RHDH (Red Hat Developer Hub) para a org `veecode-platform` e adaptamos toda a pipeline para o DevPortal.
O resultado sao dois repositorios que, juntos, compilam plugins upstream do Backstage como dynamic plugins e publicam cada um como artefato OCI no GitHub Container Registry.
Hoje temos **67 workspaces** configurados (31 validados e publicando), cobrindo **~75 plugins** so do workspace `backstage` core, alem de integrações como ArgoCD, Tekton, Jenkins, GitLab, Kubernetes, SonarQube e muitas outras.

---

## 2. Como funciona

```
 workspaces/<nome>/source.json        ->  aponta para o repo upstream + commit/tag
 workspaces/<nome>/plugins-list.yaml  ->  lista quais plugins exportar
 workspaces/<nome>/metadata/          ->  metadados de cada plugin (opcional)
                   |
                   v
        GitHub Actions (push to main ou workflow_dispatch)
                   |
                   v
        @red-hat-developer-hub/cli 1.10.0  -->  export do plugin
                   |
                   v
        ghcr.io/veecode-platform/devportal-plugin-export-overlays/<plugin>:<tag>
```

**Triggers:**

| Evento | Quando |
|--------|--------|
| Push to `main` | Quando `workspaces/**` ou `versions.json` mudam |
| Cron (discovery) | Diariamente as 22h UTC, dias uteis |
| Manual | `workflow_dispatch` via GitHub Actions |

**Versoes fixadas em `versions.json`:**

| Componente | Versao |
|------------|--------|
| Backstage | 1.48.4 |
| Node | 22.19.0 |
| CLI (`@red-hat-developer-hub/cli`) | 1.10.0 |

---

## 3. Workspaces ativos

Os 67 workspaces cobrem as seguintes areas (lista resumida dos principais):

| Categoria | Workspaces |
|-----------|-----------|
| **CI/CD** | argocd, tekton, jenkins, github-actions |
| **SCM / Code** | gitlab, github-issues, github-pull-requests-board, github-notifications |
| **Qualidade** | sonarqube, lighthouse, scorecard, tech-insights |
| **Infra / Cloud** | kubernetes, topology, aws-codebuild, aws-ecs, azure-devops, acr, acs |
| **Backstage Core** | backstage (~75 plugins: auth modules, catalog modules, scaffolder modules, techdocs, notifications, search, etc.) |
| **Observabilidade** | dynatrace, dynatrace-dql, pagerduty |
| **Registry / Artifacts** | quay, jfrog-artifactory, nexus-repository-manager, npm |
| **AI / MCP** | lightspeed, mcp-chat, mcp-integrations, ai-integrations |
| **Outros** | announcements, bookmarks, todo, tech-radar, adr, homepage, theme, translations, rbac, keycloak, kiali, servicenow, ocm, orchestrator, bulk-import |

O workspace `backstage` sozinho exporta ~75 plugins (auth providers, catalog backends, scaffolder modules, techdocs, notifications, kubernetes, etc.).

---

## 4. Como adicionar um plugin novo

1. **Criar o diretorio:**
   ```bash
   mkdir -p workspaces/<nome-do-workspace>
   ```

2. **Adicionar `source.json`** apontando para o repositorio upstream:
   ```json
   {
     "repo": "https://github.com/<org>/<repo>",
     "repo-ref": "<commit-sha-ou-tag>",
     "repo-flat": false,
     "repo-backstage-version": "1.48.4"
   }
   ```
   - `repo-flat: true` se os plugins vivem na raiz do repo (ex: `backstage/backstage`).
   - `repo-flat: false` se estao dentro de um subfolder de workspace.

3. **Adicionar `plugins-list.yaml`** listando os plugins:
   ```yaml
   plugins/meu-plugin:
   plugins/meu-plugin-backend: --embed-package @scope/dependencia
   ```

4. **(Opcional)** Adicionar `metadata/`, overlays ou patches conforme necessario.

5. **Push para `main`** — a pipeline roda automaticamente.

Para **desabilitar** um workspace: renomear `plugins-list.yaml` para `plugins-list.yaml.disabled`.

---

## 5. Como consumir no DevPortal

Referencia o artefato OCI no `dynamic-plugins.yaml` da instalacao do DevPortal:

```yaml
plugins:
  # Exemplo: ArgoCD frontend
  - package: oci://ghcr.io/veecode-platform/devportal-plugin-export-overlays/backstage-community-plugin-argocd:bs_1.48.4__2.4.3!backstage-community-plugin-argocd
    disabled: false
    pluginConfig: {}

  # Exemplo: ArgoCD backend
  - package: oci://ghcr.io/veecode-platform/devportal-plugin-export-overlays/backstage-community-plugin-argocd-backend:bs_1.48.4__2.4.3!backstage-community-plugin-argocd-backend
    disabled: false
    pluginConfig:
      argocd:
        baseUrl: https://argocd.example.com

  # Exemplo: Techdocs
  - package: oci://ghcr.io/veecode-platform/devportal-plugin-export-overlays/backstage-plugin-techdocs:bs_1.48.4__1.12.6!backstage-plugin-techdocs
    disabled: false
    pluginConfig: {}
```

**Formato da tag:** `bs_<versao_backstage>__<versao_plugin>` (ex: `bs_1.48.4__2.4.3`).

O sufixo `!` apos a tag indica o sub-path de integridade dentro da imagem OCI.

---

## 6. Proximos passos sugeridos

1. **Testar consumo end-to-end:** Subir uma instancia do DevPortal com 5-10 plugins OCI e validar que carregam corretamente (argocd, techdocs, kubernetes, github-actions, sonarqube).

2. **Quay.io como registry alternativo:** A pipeline ja esta preparada para publicar em outro registry. Basta adicionar o secret de autenticacao e ajustar o prefixo do registry no workflow. Isso da redundancia e pode ser necessario para clientes com restricoes de rede.

3. **Expandir workspaces:** Avaliar os workspaces que ainda nao estao validados e habilitar os mais relevantes para clientes.

4. **Smoke tests automatizados:** Configurar os smoke tests que ja existem na estrutura do repo para rodar apos cada publish.

5. **Versionamento de Backstage:** Quando sair uma nova versao do Backstage, atualizar `versions.json` e rodar a pipeline completa. O SYNC.md documenta como puxar melhorias do upstream RHDH.

6. **Documentacao de catalogo:** Usar os `catalog-entities/` para registrar os plugins dinamicos no proprio DevPortal como componentes do catalogo.

---

## 7. Links uteis

| Recurso | Link |
|---------|------|
| Repo Overlays (definicoes de plugins) | https://github.com/veecode-platform/devportal-plugin-export-overlays |
| Repo Utils (workflows e tooling) | https://github.com/veecode-platform/devportal-plugin-export-utils |
| Packages publicados (GHCR) | https://github.com/orgs/veecode-platform/packages?repo_name=devportal-plugin-export-overlays |
| Upstream RHDH Overlays | https://github.com/redhat-developer/rhdh-plugin-export-overlays |
| Upstream RHDH Utils | https://github.com/redhat-developer/rhdh-plugin-export-utils |
| Plano de implementacao | `docs/superpowers/plans/2026-03-10-devportal-plugin-distribution.md` |
| Guia de sync com upstream | `SYNC.md` |
