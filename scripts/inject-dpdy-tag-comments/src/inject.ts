#!/usr/bin/env node

// Annotate dynamic-plugins.default.yaml with Tag and Build date from plugin_builds JSON.

import { glob, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { basename } from "node:path/posix";
import { parseArgs } from "node:util";
import { parseReference } from "./distribution-reference.ts";

const PKG_LINE_RE = /^ {2}- package: (?<val>\S+)/;
const TAG_LINE_RE = /^\s*# Tag:/;
const OCI_PREFIX = "oci://";
const USAGE = "Usage: inject-dpdy-tag-comments <dpdy-file> <plugin-builds-dir>\n";

const RHIDH_IMAGE_PREFIX_LONG = "red-hat-developer-hub-";
const RHIDH_IMAGE_PREFIX_SHORT = "rhdh-";

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

interface TagInfo {
  tag: string;
  buildDate: string;
}

async function loadTagByKey(pluginBuildsDir: string): Promise<Map<string, TagInfo>> {
  if (!(await isDirectory(pluginBuildsDir))) {
    throw new Error(`Plugin builds directory not found: ${pluginBuildsDir}`);
  }

  const tagByKey = new Map<string, TagInfo>();

  for await (const path of glob(join(pluginBuildsDir, "*/*.json"))) {
    const data = await readJsonFile(path);

    if (!isPlainObject(data)) {
      console.warn(`Warning: Skipping invalid plugin build file: ${path}`);
      continue;
    }

    for (const [name, entry] of Object.entries(data)) {
      const info = tagInfoFromPluginBuildEntry(entry);

      if (!info) {
        console.warn(`Warning: Skipping invalid plugin entry "${name}" in ${path}`);
        continue;
      }

      tagByKey.set(name, info);
      tagByKey.set(name.replaceAll(RHIDH_IMAGE_PREFIX_LONG, RHIDH_IMAGE_PREFIX_SHORT), info);
    }
  }

  if (tagByKey.size === 0) {
    throw new Error(`No plugin build tags found in ${pluginBuildsDir}`);
  }

  return tagByKey;
}

function commentForPackage(pkg: string, tagByKey: Map<string, TagInfo>): string | null {
  const info = tagByKey.get(pkg);

  if (!info) {
    return null;
  }

  return `  # Tag: ${info.tag}, Build date: ${info.buildDate}\n`;
}

function packageNameFromOciValue(value: string): string | null {
  if (!value.startsWith(OCI_PREFIX)) {
    return null;
  }

  const body = value.slice(OCI_PREFIX.length);
  const pluginPathSep = body.indexOf("!");
  const bare = pluginPathSep === -1 ? body : body.slice(0, pluginPathSep);

  try {
    const { path } = parseReference(bare);
    return basename(path);
  } catch {
    return null;
  }
}

function tagCommentForPackageLine(val: string, tagByKey: Map<string, TagInfo>): string | null {
  const pkg = packageNameFromOciValue(val);

  if (!pkg) {
    return null;
  }

  return commentForPackage(pkg, tagByKey);
}

export async function inject(dpdyPath: string, pluginBuildsDir: string): Promise<boolean> {
  if (!(await isFile(dpdyPath))) {
    throw new Error(`DPDY file not found: ${dpdyPath}`);
  }

  const tagByKey = await loadTagByKey(pluginBuildsDir);
  const text = await readFile(dpdyPath, "utf8");
  const lines = text.split(/(?<=\n)/);
  const result: string[] = [];
  let changed = false;
  // Inject is idempotent: do not add another Tag comment when YAML already has one for this package.
  let mayInjectTag = true;

  for (const line of lines) {
    if (TAG_LINE_RE.test(line)) {
      mayInjectTag = false;
    }

    const packageValue = PKG_LINE_RE.exec(line)?.groups?.val;
    const comment =
      packageValue && mayInjectTag ? tagCommentForPackageLine(packageValue, tagByKey) : null;

    if (packageValue) {
      mayInjectTag = true;
    }

    if (comment) {
      result.push(comment);
      changed = true;
    }

    result.push(line);
  }

  if (changed) {
    await writeFile(dpdyPath, result.join(""), "utf8");
  }

  return changed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tagInfoFromPluginBuildEntry(value: unknown): TagInfo | null {
  if (
    !isPlainObject(value) ||
    typeof value.registryReference !== "string" ||
    typeof value["build-date"] !== "string"
  ) {
    return null;
  }

  try {
    const tag = parseReference(value.registryReference).tag;

    return tag ? { tag, buildDate: value["build-date"] } : null;
  } catch {
    return null;
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stderr.write(USAGE);
    process.exit(0);
  }

  const [dpdyFile, pluginBuildsDir] = positionals;
  if (!dpdyFile || !pluginBuildsDir) {
    process.stderr.write(USAGE);
    process.exit(1);
  }

  try {
    await inject(dpdyFile, pluginBuildsDir);
  } catch (error) {
    process.stderr.write(`Error: ${describeError(error)}\n`);
    process.exit(1);
  }
}

/* v8 ignore if */
if (import.meta.main) {
  await main();
}
