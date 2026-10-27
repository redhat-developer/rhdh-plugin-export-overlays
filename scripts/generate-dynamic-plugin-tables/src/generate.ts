/*
 * Copyright (c) Red Hat, Inc.
 * SPDX-License-Identifier: EPL-2.0
 */

/**
 * Render docs from a resolved catalog index without querying a registry.
 *
 * index.json selects packages and provides digest refs and artifact tags.
 * Package entities provide titles, versions, roles, lifecycle, and app config.
 * Example: spec.packageName "@backstage-community/plugin-3scale-backend"
 *   -> index key "backstage-community-plugin-3scale-backend"
 * A Package entity copied into the directory without an index entry is omitted.
 * Supported output also intersects index entries with default.packages.yaml.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type Tier = "supported" | "community";
type RowGroup = "ga" | "technology-preview" | "deprecated";
type DebugLog = (message: string) => void;

/** Documentation row combining an index entry with its matching Package entity. */
export type Plugin = {
  package: string;
  title: string;
  version: string;
  reference: string;
  tag: string;
  support: string;
  lifecycle: string;
  role: string;
  variables: string[];
};

export class TableGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TableGenerationError";
  }
}

export const DOCS_DIR = "extend_dynamic-plugins-reference";
export const CSV_COLUMNS = [
  "Name",
  "Plugin",
  "Role",
  "Version",
  "Support Level",
  "Lifecycle",
  "Path",
  "Required Variables",
  "Default",
] as const;

const TEMPLATES_DIR = fileURLToPath(new URL("../templates/", import.meta.url));
const COMMUNITY_SUPPORT = new Set(["community", "dev-preview"]);
const SUPPORTED_SUPPORT = new Set(["generally-available", "tech-preview"]);
const VARIABLE_PATTERN = /\$\{([^}]+)\}/g;

/**
 * Resolve a CLI path beneath root, following symlinks in existing components.
 * Missing components are kept so a nested output directory can be created.
 * Catalog paths derived from the CLI index are checked too: they may be symlinks.
 */
export function requireContained(flag: string, arg: string, root: string = process.cwd()): string {
  const base = realpathSync(root);
  let existing = resolve(base, arg);
  const missing: string[] = [];
  while (true) {
    try {
      existing = realpathSync(existing);
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(basename(existing));
      existing = parent;
    }
  }

  const resolved = resolve(existing, ...missing);
  if (resolved !== base && !resolved.startsWith(`${base}${sep}`)) {
    throw new Error(
      `${flag} must resolve inside ${base}: ${JSON.stringify(arg)} resolves to ${resolved}`,
    );
  }
  return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

/**
 * Preserve the generated docs' string order for row fields and identifiers.
 * Plugin rows need an explicit comparator; their default sort sees every
 * value as "[object Object]". localeCompare() would reorder names with underscores.
 */
function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** @backstage-community/plugin-3scale-backend -> index key backstage-community-plugin-3scale-backend */
function imageKeyFromPackage(packageName: string): string {
  return packageName.replace(/^@+/, "").replaceAll("/", "-");
}

/** Extract sorted unique placeholders from the first appConfig example.
 * ${TOKEN}, ${URL}, ${TOKEN} -> ["TOKEN", "URL"]
 * Mapping content is serialized before scanning because entities often use YAML objects.
 */
function requiredVariables(spec: Record<string, unknown>): string[] {
  const examples = spec.appConfigExamples;
  if (!Array.isArray(examples) || !isRecord(examples[0])) return [];
  const content: unknown = examples[0].content || "";
  const serialized = typeof content === "string" ? content : stringifyYaml(content);
  return [
    ...new Set([...serialized.matchAll(VARIABLE_PATTERN)].map((match) => match[1]!)),
  ].toSorted(compareStrings);
}

/**
 * Select Package entities by spec.packageName, not filename.
 * Both upstream tiers copy all workspace metadata, and some filenames are
 * shortened. Unselected malformed entities do not block this tier's output.
 */
function loadEntities(
  packagesDir: string,
  selectedImageKeys: Set<string>,
): Map<string, Record<string, unknown>> {
  if (!isDirectory(packagesDir)) {
    throw new TableGenerationError(`Package entity directory is missing: ${packagesDir}`);
  }

  const entities = new Map<string, Record<string, unknown>>();
  const paths = readdirSync(packagesDir).filter(
    (name) => name.endsWith(".yaml") && name !== "all.yaml",
  );
  for (const filename of paths) {
    // A catalog YAML symlink must stay inside the selected Package directory.
    const path = requireContained("Package entity", filename, packagesDir);
    const selectedFile = selectedImageKeys.has(basename(filename, ".yaml"));
    let entity: unknown;
    try {
      entity = parseYaml(readFileSync(path, "utf8"));
    } catch (error) {
      if (selectedFile) {
        throw new TableGenerationError(`Invalid Package entity ${path}: ${String(error)}`);
      }
      continue;
    }
    if (!isRecord(entity) || entity.kind !== "Package" || !isRecord(entity.spec)) {
      if (selectedFile) {
        throw new TableGenerationError(`Invalid Package entity: ${path}`);
      }
      continue;
    }
    const packageName = entity.spec.packageName;
    if (typeof packageName !== "string" || !packageName) {
      if (selectedFile) {
        throw new TableGenerationError(`Package entity has no packageName: ${path}`);
      }
      continue;
    }
    const imageKey = imageKeyFromPackage(packageName);
    if (!selectedImageKeys.has(imageKey)) continue;
    if (entities.has(imageKey)) {
      throw new TableGenerationError(`Duplicate Package entity for ${imageKey}: ${path}`);
    }
    entities.set(imageKey, entity);
  }
  return entities;
}

/** Reject a missing table field before publishing an incomplete row. */
function requiredString(value: unknown, field: string, imageKey: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TableGenerationError(`Missing or invalid ${field} for ${imageKey}`);
  }
  return value;
}

/**
 * Join each published index entry to its Package entity for a documentation row.
 * index.json selects images and supplies their support, registry ref, and tag;
 * Package YAML supplies the display name, version, role, and config examples.
 * registryReference "ghcr.io/org/plugin@sha256:abc"
 *   -> table Path "oci://ghcr.io/org/plugin@sha256:abc"
 */
export function loadPlugins(indexDir: string, tier: Tier): Plugin[] {
  // Parse index.json as image keys -> published index entries; reject external symlinks.
  const indexFile = requireContained("Catalog index", "index.json", indexDir);
  if (!isFile(indexFile)) throw new TableGenerationError(`Catalog index is missing: ${indexFile}`);
  let index: unknown;
  try {
    index = JSON.parse(readFileSync(indexFile, "utf8"));
  } catch (error) {
    throw new TableGenerationError(`Invalid catalog index ${indexFile}: ${String(error)}`);
  }
  if (!isRecord(index)) {
    throw new TableGenerationError(`Catalog index must be an object: ${indexFile}`);
  }

  // Index key "org-plugin" -> Package spec.packageName "@org/plugin".
  // Load only entities named by the published index.
  const entities = loadEntities(
    requireContained(
      "Package entity directory",
      join("catalog-entities", "extensions", "packages"),
      indexDir,
    ),
    new Set(Object.keys(index)),
  );
  const expectedSupport = tier === "supported" ? SUPPORTED_SUPPORT : COMMUNITY_SUPPORT;
  const plugins: Plugin[] = [];
  // Join each index.json image key with its Package YAML entity to make
  // one table row. Entity spec/metadata supplies name, version, role, and
  // config variables; the index supplies the tag and verifies the OCI ref.
  for (const [imageKey, indexEntry] of Object.entries(index)) {
    if (!isRecord(indexEntry)) throw new TableGenerationError(`Invalid index entry: ${imageKey}`);
    const entity = entities.get(imageKey);
    if (!entity)
      throw new TableGenerationError(`Indexed package has no Package entity: ${imageKey}`);
    const spec = entity.spec;
    const metadata = entity.metadata;
    if (!isRecord(spec) || !isRecord(metadata)) {
      throw new TableGenerationError(`Invalid Package metadata for ${imageKey}`);
    }

    // Both sources declare support; reject a mismatch or the wrong catalog tier.
    const support = requiredString(spec.support, "support", imageKey);
    if (support !== indexEntry.support) {
      throw new TableGenerationError(
        `Support mismatch for ${imageKey}: index=${String(indexEntry.support)}, entity=${support}`,
      );
    }
    if (!expectedSupport.has(support)) {
      throw new TableGenerationError(
        `Unexpected ${tier} support level for ${imageKey}: ${support}`,
      );
    }

    // Entity fields describe the plugin; index fields identify its published image.
    const packageName = requiredString(spec.packageName, "packageName", imageKey);
    const title = requiredString(metadata.title || packageName, "title", imageKey);
    const version = requiredString(spec.version, "version", imageKey);
    const artifact = requiredString(spec.dynamicArtifact, "dynamicArtifact", imageKey);
    const registryReference = requiredString(
      indexEntry.registryReference,
      "registryReference",
      imageKey,
    );
    const tag = requiredString(indexEntry.imageTag, "imageTag", imageKey);
    // A dynamicArtifact may carry a plugin suffix after "!". The index ref
    // identifies the image itself and has no such suffix.
    const reference = artifact.split("!", 1)[0]!;
    if (reference !== `oci://${registryReference}`) {
      throw new TableGenerationError(`Index and Package OCI references differ for ${imageKey}`);
    }
    if (tier === "community" && !reference.startsWith("oci://ghcr.io/")) {
      throw new TableGenerationError(`Community package has a non-GHCR reference: ${imageKey}`);
    }

    // Optional role/lifecycle use "unknown"; config examples supply ${VAR} names.
    const backstage = spec.backstage;
    const role =
      isRecord(backstage) && typeof backstage.role === "string" && backstage.role
        ? backstage.role
        : "unknown";
    plugins.push({
      package: packageName,
      title,
      version,
      reference,
      tag,
      support,
      lifecycle: typeof spec.lifecycle === "string" && spec.lifecycle ? spec.lifecycle : "unknown",
      role,
      variables: requiredVariables(spec),
    });
  }
  return plugins;
}

/** Replace required %%MARKERS%%, failing if a template has changed unexpectedly. */
function template(name: string, replacements: Record<string, string>): string {
  const path = join(TEMPLATES_DIR, `${name}.template.adoc`);
  let content = readFileSync(path, "utf8");
  for (const [marker, value] of Object.entries(replacements)) {
    if (!content.includes(marker)) {
      throw new TableGenerationError(`Template ${path} is missing ${marker}`);
    }
    content = content.replaceAll(marker, value);
  }
  return content;
}

/** Keep a page's title and abstract marker when its table has no rows. */
function emptyPage(name: string, sentence: string): string {
  const content = template(name, {});
  const marker = '[role="_abstract"]';
  const position = content.indexOf(marker);
  if (position < 0)
    throw new TableGenerationError(`Template ${name} is missing its abstract marker`);
  return `${content.slice(0, position + marker.length)}\n${sentence}\n`;
}

/** "first|second\nthird" -> "first\\|second third" inside one table cell. */
function adocCell(value: string): string {
  return value.replaceAll("\n", " ").replaceAll("|", String.raw`\|`);
}

/** ["TOKEN", "URL"] -> two code paragraphs inside one AsciiDoc cell. */
function adocVariables(plugin: Plugin): string {
  return plugin.variables.map((variable) => `\`${variable}\`\n\n`).join("");
}

/** Escape embedded quotes and wrap the entire CSV field in quotes. */
function quoteCsvField(field: string): string {
  return `"${field.replaceAll('"', '""')}"`;
}

/** Quote every CSV field, matching the supported inventory's existing schema. */
function csvContent(rows: string[][]): string {
  return [CSV_COLUMNS, ...rows].map((row) => row.map(quoteCsvField).join(",")).join("\n") + "\n";
}

/** Render a community page and CSV from packages sorted by metadata.title,
 * then spec.packageName to break title ties.
 * title "3Scale" -> AsciiDoc |*3Scale* and CSV Name "3Scale".
 * Developer Preview packages retain their own Support Level label in the CSV.
 */
function renderCommunity(plugins: Plugin[], debug?: DebugLog): Record<string, string> {
  const name = "ref-community-supported-plugins";
  const rows: string[] = [];
  const csvRows: string[][] = [];
  for (const plugin of plugins.toSorted(
    (left, right) =>
      compareStrings(left.title, right.title) || compareStrings(left.package, right.package),
  )) {
    rows.push(
      `|*${adocCell(plugin.title)}*\n|${adocCell(plugin.version)}\n` +
        `|\`${plugin.reference}\`\n\n${adocVariables(plugin)}|${adocCell(plugin.tag)}\n`,
    );
    csvRows.push([
      plugin.title,
      plugin.package,
      plugin.role.includes("front") ? "Frontend" : "Backend",
      plugin.version,
      plugin.support === "dev-preview" ? "Developer Preview" : "Community Support",
      plugin.lifecycle,
      plugin.reference,
      plugin.variables.map((variable) => `\`${variable}\``).join(";"),
      "N/A", // This tier has no default.packages.yaml or DPDY.
    ]);
    debug?.(
      `Add ${name}.adoc and rhdh-community-plugins.csv: ${JSON.stringify({
        title: plugin.title,
        package: plugin.package,
        role: plugin.role,
        version: plugin.version,
        support: plugin.support,
        lifecycle: plugin.lifecycle,
        path: plugin.reference,
        tag: plugin.tag,
        requiredVariables: plugin.variables,
      })}`,
    );
  }
  const content = rows.length
    ? template(name, {
        "%%COMMUNITY_TABLE_COUNT%%": String(rows.length),
        "%%COMMUNITY_TABLE_CONTENT%%": rows.join("\n"),
      })
    : emptyPage(
        name,
        "There are no community supported plugins in this release of " +
          "{product} ({product-very-short})",
      );
  return {
    [`${name}.adoc`]: content,
    "rhdh-community-plugins.csv": csvContent(csvRows),
  };
}

/** Map package names to enabled/disabled status and reject duplicates.
 * packages.enabled: [{package: "@org/foo"}] -> {"@org/foo": "enabled"}
 */
function loadDefaults(path: string): Map<string, "enabled" | "disabled"> {
  if (!isFile(path))
    throw new TableGenerationError(`Supported package defaults are missing: ${path}`);
  let data: unknown;
  try {
    data = parseYaml(readFileSync(path, "utf8"));
  } catch (error) {
    throw new TableGenerationError(`Invalid package defaults ${path}: ${String(error)}`);
  }
  const packages = isRecord(data) ? data.packages : null;
  if (!isRecord(packages)) throw new TableGenerationError(`Invalid package defaults: ${path}`);

  const defaults = new Map<string, "enabled" | "disabled">();
  for (const status of ["enabled", "disabled"] as const) {
    const entries = packages[status] || [];
    if (!Array.isArray(entries)) {
      throw new TableGenerationError(`Invalid ${status} packages in ${path}`);
    }
    for (const entry of entries) {
      const packageName = isRecord(entry) ? entry.package : null;
      if (typeof packageName !== "string" || !packageName) {
        throw new TableGenerationError(`Invalid ${status} package in ${path}`);
      }
      if (defaults.has(packageName)) {
        throw new TableGenerationError(`Package appears twice in ${path}: ${packageName}`);
      }
      defaults.set(packageName, status);
    }
  }
  return defaults;
}

/** Preserve supported-page display names derived from npm names.
 * @backstage/plugin-auth-backend-module-github-provider
 *   -> "Auth Backend Module GitHub Provider"
 * Community output uses metadata.title instead.
 */
function prettyName(packageName: string): string {
  if (packageName.includes("pagerduty")) return "PagerDuty";
  if (packageName.includes("redhat-argocd")) return "Argo CD (Red Hat)";
  if (packageName.includes("scaffolder-backend-argocd")) return "Argo CD";
  if (packageName.includes("notifications-backend-module-email")) return "Notifications";

  let name = packageName.replace(/^@/, "").split("/", 2).at(-1)!;
  for (const prefix of [
    "backstage-community-",
    "red-hat-developer-hub-",
    "redhat-",
    "roadiehq-",
    "immobiliarelabs-",
    "parfuemerie-douglas-",
    "backstage-plugin-",
    "plugin-",
    "catalog-backend-module-",
    "plugin-catalog-backend-module-",
    "scaffolder-backend-module-",
  ]) {
    if (name.startsWith(prefix)) name = name.slice(prefix.length);
  }
  if (name.endsWith("-backend")) name = name.slice(0, -"-backend".length);
  const special: Record<string, string> = {
    aap: "Ansible Automation Platform (AAP)",
    acr: "ACR",
    cd: "CD",
    ocm: "OCM",
    rbac: "RBAC",
    argocd: "Argo CD",
    github: "GitHub",
    gitlab: "GitLab",
    jfrog: "JFrog",
    msgraph: "MS Graph",
    pagerduty: "PagerDuty",
    servicenow: "ServiceNow",
    sonarqube: "SonarQube",
    techdocs: "TechDocs",
  };
  return name
    .split("-")
    .map(
      (word) => special[word] ?? (word ? word[0]!.toUpperCase() + word.slice(1).toLowerCase() : ""),
    )
    .join(" ");
}

/** tech-preview -> "Red Hat Tech Preview"; GA -> "Production". */
function supportLabel(support: string): string {
  return support === "tech-preview" ? "Red Hat Tech Preview" : "Production";
}

/** Sort priority for plugin roles: frontend, backend/other, scaffolder. */
function roleOrder(plugin: Plugin): number {
  if (plugin.package.includes("scaffolder")) return 3;
  return plugin.role.includes("front") ? 1 : 2;
}

/**
 * Supported row sort priority: displayed name from prettyName(), then role
 * priority from roleOrder(), then raw spec.backstage.role, then npm package name.
 * The final two comparisons make rows with the same name and role deterministic.
 */
function compareSupportedPlugins(left: Plugin, right: Plugin): number {
  return (
    compareStrings(prettyName(left.package), prettyName(right.package)) ||
    roleOrder(left) - roleOrder(right) ||
    compareStrings(left.role, right.role) ||
    compareStrings(left.package, right.package)
  );
}

/** Render four supported pages and a CSV from packages in both index and defaults.
 * Deprecated lifecycle takes precedence over GA or Technology Preview placement.
 * A default package absent from index.json contributes no row.
 */
function renderSupported(
  plugins: Plugin[],
  defaults: Map<string, "enabled" | "disabled">,
  debug?: DebugLog,
): Record<string, string> {
  const selected = plugins
    .filter((plugin) => defaults.has(plugin.package))
    .toSorted(compareSupportedPlugins);
  const groups: Record<RowGroup, string[]> = {
    ga: [],
    "technology-preview": [],
    deprecated: [],
  };
  const csvRows: Record<RowGroup, string[][]> = {
    ga: [],
    "technology-preview": [],
    deprecated: [],
  };
  const enabled = new Set<string>();
  let disabledReference: string | undefined;

  for (const plugin of selected) {
    const name = prettyName(plugin.package);
    const label = supportLabel(plugin.support);
    const role = plugin.role.includes("front") ? "Frontend" : "Backend";
    const status = defaults.get(plugin.package)!;
    if (status === "enabled") enabled.add(plugin.package);
    else disabledReference ??= plugin.reference;
    // Deprecated lifecycle takes precedence over GA or Technology Preview.
    let group: RowGroup = "ga";
    if (plugin.lifecycle === "deprecated") group = "deprecated";
    else if (plugin.support === "tech-preview") group = "technology-preview";
    groups[group].push(
      `|${adocCell(name)} ` +
        `|\`https://npmjs.com/package/${plugin.package}/v/${plugin.version}[${plugin.package}]\` ` +
        `|${adocCell(plugin.version)}\n|\`${plugin.reference}\`\n\n` +
        `${adocVariables(plugin)}|${adocCell(plugin.tag)}\n`,
    );
    // RHIDP-4196: TechDocs stays in the pages and enabled list, but not CSV.
    const includeCsv = !plugin.package.toLowerCase().includes("techdocs");
    if (includeCsv) {
      csvRows[group].push([
        name,
        plugin.package,
        role,
        plugin.version,
        label,
        plugin.lifecycle,
        plugin.reference,
        plugin.variables.map((variable) => `\`${variable}\``).join(";"),
        status === "enabled" ? "Enabled" : "Disabled",
      ]);
    }
    debug?.(
      `Add ref-${group}-plugins.adoc: ${JSON.stringify({
        name,
        package: plugin.package,
        role,
        version: plugin.version,
        support: label,
        lifecycle: plugin.lifecycle,
        path: plugin.reference,
        tag: plugin.tag,
        requiredVariables: plugin.variables,
        default: status,
        csv: includeCsv,
      })}`,
    );
  }

  const outputs: Record<string, string> = {};
  const specs: Array<{
    group: RowGroup;
    name: string;
    count: string;
    content: string;
    empty: string;
  }> = [
    {
      group: "ga",
      name: "ref-ga-plugins",
      count: "%%COUNT_1%%",
      content: "%%TABLE_CONTENT_1%%",
      empty:
        "There are no {generally-available} plugins in this release of {product} ({product-very-short})",
    },
    {
      group: "technology-preview",
      name: "ref-technology-preview-plugins",
      count: "%%COUNT_2%%",
      content: "%%TABLE_CONTENT_2%%",
      empty:
        "There are no {technology-preview} plugins in this release of {product} ({product-very-short})",
    },
    {
      group: "deprecated",
      name: "ref-deprecated-plugins",
      count: "%%COUNT_3%%",
      content: "%%TABLE_CONTENT_3%%",
      empty: "There are no deprecated plugins in this release of {product} ({product-very-short})",
    },
  ];
  for (const spec of specs) {
    const rows = groups[spec.group];
    outputs[`${spec.name}.adoc`] = rows.length
      ? template(spec.name, {
          [spec.count]: String(rows.length),
          [spec.content]: rows.join(""),
        })
      : emptyPage(spec.name, spec.empty);
  }

  // Choose an actual disabled image from this index for the docs example.
  const bullets = [...enabled]
    .toSorted(compareStrings)
    .map((name) => `* \`${name}\``)
    .join("\n");
  const exampleRef = disabledReference ?? "oci://<registry>/<plugin>@sha256:<digest>";
  outputs["con-preinstalled-dynamic-plugins.adoc"] = template("con-preinstalled-dynamic-plugins", {
    "%%COUNT_ENABLED_PLUGINS%%": String(enabled.size),
    "%%ENABLED_PLUGINS%%": bullets,
    "%%DISABLED_PLUGIN_REF%%": exampleRef,
  });
  // Each group already has the table order; the CSV only needs section order.
  outputs["rhdh-supported-plugins.csv"] = csvContent([
    ...csvRows.ga,
    ...csvRows["technology-preview"],
    ...csvRows.deprecated,
  ]);
  return outputs;
}

/** Pick one renderer after validating every indexed package.
 * defaultsFile lets downstream keep its defaults outside indexDir.
 * Returned keys are filenames relative to the CLI's output directory.
 */
export function renderTables(
  tier: Tier,
  indexDir: string,
  defaultsFile?: string,
  debug?: DebugLog,
): Record<string, string> {
  const plugins = loadPlugins(indexDir, tier);
  debug?.(`Loaded ${plugins.length} ${tier} indexed packages`);
  if (tier === "community") return renderCommunity(plugins, debug);
  return renderSupported(
    plugins,
    loadDefaults(
      defaultsFile ?? requireContained("Package defaults", "default.packages.yaml", indexDir),
    ),
    debug,
  );
}
