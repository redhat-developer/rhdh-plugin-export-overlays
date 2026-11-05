# Dynamic Plugins Overlay Repository - User Guide

This guide covers the essential workflows for using the **rhdh-plugin-export-overlays** repository to export, maintain, and publish dynamic plugins for Backstage-based platforms.

## Table of Contents

| Document | Description |
|----------|-------------|
| [01 - Getting Started](./01-getting-started.md) | Core concepts, repository structure, and prerequisites |
| [02 - Export Tools](./02-export-tools.md) | Using the dynamic plugins export tools and CLI |
| [03 - Plugin Owner Responsibilities](./03-plugin-owner-responsibilities.md) | Ownership model and maintenance obligations |
| [04 - Metadata Synchronization](./04-metadata-synchronization.md) | Keeping source and overlay metadata in sync |
| [05 - Version Updates](./05-version-updates.md) | Updating Backstage target/minimum versions |
| [06 - Patch Management](./06-patch-management.md) | Creating, updating, and retiring patches |
| [07 - Plugin Catalog Index](./07-plugin-catalog-index.md) | How the catalog index is built, published, and monitored |
| [08 - Creating Release Branches](./08-creating-release-branches.md) | Admin runbook for cutting `release-x.y` from `main` |
| [09 - Managing E2E Secrets](./09-managing-e2e-secrets.md) | Repository secret naming, local test entry points, and upstream secrets reference |

---

## Quick Reference

### Key Repository Files

| Path | Purpose |
|------|---------|
| `versions.json` | Target Backstage version, Node version, CLI version |
| `e2e-secrets.profile.json` | Collection and path selectors for local E2E secrets |
| `plugins-regexps` | Auto-discovery scope patterns |
| `workspaces/[name]/source.json` | Source repo URL, ref, and Backstage version (Model A: overlay build) |
| `workspaces/[name]/plugins-list.yaml` | Plugin paths and export arguments |
| `workspaces/[name]/metadata/*.yaml` | Package entity definitions |
| `workspaces/[name]/patches/*.patch` | Unified diff patches |
| `workspaces/[name]/plugins/[plugin]/` | Plugin-specific overlays |
| `catalog-entities/extensions/plugins/*.yaml` | Plugin catalog listing entities (Model A and Model B / catalog-only; PM approval required for curated catalog tiers) |
| `catalog-entities/extensions/collections/*.yaml` | Collection groupings (required only if PM approved) |
| `rhdh-community-packages.txt` / `rhdh-supported-packages.txt` | Curated Optional Extras / Supported Plugins catalog tier lists (required only if PM approved; support level is in metadata YAML) |
| `default.packages.yaml` | GA packages under `enabled:` / `disabled:` (required only if PM approved; GA only) |

### Common Workflows

| Task | Start Here |
|------|-----------|
| Add a new plugin (overlay export) | [01 - Getting Started](./01-getting-started.md#adding-a-new-plugin) |
| Catalog-only plugin (external OCI build) | [03 - Plugin Owner Responsibilities](./03-plugin-owner-responsibilities.md#two-ways-a-plugin-can-appear-in-this-repository) |
| Update plugin version | [05 - Version Updates](./05-version-updates.md) |
| Fix build failure | [02 - Export Tools](./02-export-tools.md#troubleshooting) |
| Sync metadata | [04 - Metadata Synchronization](./04-metadata-synchronization.md) |
| Create/update a patch | [06 - Patch Management](./06-patch-management.md) |
| Create a release branch from main | [08 - Creating Release Branches](./08-creating-release-branches.md) |
| Manage E2E secrets | [09 - Managing E2E Secrets](./09-managing-e2e-secrets.md) |
| Check branch workspace status reports | [Workspace Status Reports](https://github.com/redhat-developer/rhdh-plugin-export-overlays/wiki/Workspace-Status-Reports) |

---

## Current Versions

<!-- AUTO:VERSIONS_TABLE -->

> 🔄 *Auto-generated when synced to wiki*

---

## Prerequisites

- **Git** with access to this repository
- **Node.js** version `{{AUTO:NODE_VERSION}}` (or as specified in `versions.json`)
- **GitHub CLI** (`gh`) for workflow triggers
- Basic understanding of Backstage plugin architecture
