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

---

## Quick Reference

### Key Repository Files

| Path | Purpose |
|------|---------|
| `versions.json` | Target Backstage version, Node version, CLI version |
| `plugins-regexps` | Auto-discovery scope patterns |
| `workspaces/[name]/source.json` | Source repo URL, ref, and Backstage version |
| `workspaces/[name]/plugins-list.yaml` | Plugin paths and export arguments |
| `workspaces/[name]/metadata/*.yaml` | Package entity definitions |
| `workspaces/[name]/patches/*.patch` | Unified diff patches |
| `workspaces/[name]/plugins/[plugin]/` | Plugin-specific overlays |

### Common Workflows

| Task | Start Here |
|------|-----------|
| Add a new plugin | [01 - Getting Started](./01-getting-started.md#adding-a-new-plugin) |
| Update plugin version | [05 - Version Updates](./05-version-updates.md) |
| Fix build failure | [02 - Export Tools](./02-export-tools.md#troubleshooting) |
| Sync metadata | [04 - Metadata Synchronization](./04-metadata-synchronization.md) |
| Create/update a patch | [06 - Patch Management](./06-patch-management.md) |

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
