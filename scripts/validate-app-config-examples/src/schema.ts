/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Semantic validation of appConfigExamples against the plugin's own config
// schema (RHIDP-13509).
//
// Schemas come from the *published* package rather than the source repo: the
// metadata already pins `packageName` + `version`, that tarball is the artifact
// users actually install, and it needs no cross-repo SHA resolution.
//
// @backstage/config-loader does the heavy lifting. It reads `configSchema` from
// package.json and handles both forms found across this catalogue — a compiled
// `config.schema.json`, or a raw `config.d.ts` that it compiles with the
// TypeScript compiler — while applying Backstage's @visibility conventions. So
// the gate enforces what Backstage enforces at runtime, not an approximation.

import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { loadConfigSchema } from '@backstage/config-loader';
import type { JsonObject } from '@backstage/types';

const execFileAsync = promisify(execFile);

/**
 * Narrows parsed YAML to the shape `ConfigSchema.process` accepts.
 *
 * The values come from `yaml.parse`, so they are structurally JSON already —
 * this only rules out the non-object roots (arrays, scalars, null) that an
 * app-config fragment can never be.
 */
function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type SchemaOutcome =
  | { kind: 'ok' }
  | { kind: 'invalid'; errors: string[] }
  | { kind: 'no-schema' }
  | { kind: 'unavailable'; reason: string };

type ResolvedSchema =
  | { kind: 'schema'; schema: Awaited<ReturnType<typeof loadConfigSchema>> }
  | { kind: 'no-schema' }
  | { kind: 'unavailable'; reason: string };

/**
 * Downloads a published package and loads its config schema.
 *
 * Results are cached by `name@version`. That key is immutable on the registry,
 * so caching is safe and stops a full-tree run re-fetching the same tarball
 * once per metadata file that references it.
 */
export class SchemaResolver {
  private readonly cache = new Map<string, Promise<ResolvedSchema>>();
  private readonly tempDirs: string[] = [];

  async resolve(name: string, version: string): Promise<ResolvedSchema> {
    const key = `${name}@${version}`;
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.load(key);
      this.cache.set(key, pending);
    }
    return pending;
  }

  /** Removes every temp directory this resolver created. */
  async cleanup(): Promise<void> {
    await Promise.all(
      this.tempDirs.map(dir => rm(dir, { recursive: true, force: true })),
    );
    this.tempDirs.length = 0;
  }

  private async load(spec: string): Promise<ResolvedSchema> {
    let dir: string;
    try {
      dir = await mkdtemp(join(tmpdir(), 'app-config-schema-'));
      this.tempDirs.push(dir);
    } catch (error) {
      return { kind: 'unavailable', reason: `temp dir failed: ${error}` };
    }

    let packageDir: string;
    try {
      packageDir = await extractPackage(spec, dir);
    } catch (error) {
      // Plenty of packages in this catalogue are not on the public registry.
      // That is not a metadata defect, so it is reported rather than failed.
      return { kind: 'unavailable', reason: describeError(error) };
    }

    try {
      const schema = await loadConfigSchema({
        packagePaths: [join(packageDir, 'package.json')],
        // Only this package's own schema matters; pulling in its dependency
        // tree would validate the example against unrelated plugins' keys.
        dependencies: [],
        excludePackageDependencies: true,
      });
      // A package with no `configSchema` still yields a schema object — an
      // empty one that accepts anything. Detect that so the result is reported
      // honestly instead of as a vacuous pass.
      if (!hasConstraints(schema.serialize())) {
        return { kind: 'no-schema' };
      }
      return { kind: 'schema', schema };
    } catch (error) {
      return { kind: 'unavailable', reason: describeError(error) };
    }
  }
}

/** `npm pack` the spec into `dir` and unpack it. Returns the package root. */
async function extractPackage(spec: string, dir: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'npm',
    ['pack', spec, '--pack-destination', dir, '--loglevel', 'error'],
    { cwd: dir },
  );
  const tarball = stdout.trim().split('\n').pop()?.trim();
  if (!tarball) {
    throw new Error(`npm pack produced no tarball for ${spec}`);
  }
  await execFileAsync('tar', ['-xzf', tarball, '-C', dir], { cwd: dir });

  // npm tarballs conventionally unpack into `package/`, but that is not
  // guaranteed. Find the directory rather than assume it, so a surprising
  // layout reports clearly instead of failing on a missing path.
  const entries = await readdir(dir, { withFileTypes: true });
  const root = entries.find(entry => entry.isDirectory());
  if (!root) {
    throw new Error(`no package directory in the tarball for ${spec}`);
  }
  return join(dir, root.name);
}

/**
 * True when a serialized schema actually constrains anything.
 *
 * config-loader always returns a wrapper document; for a package without a
 * `configSchema` the wrapper carries no per-package schemas. Treating that as
 * a pass would let every example through regardless of content.
 */
function hasConstraints(serialized: unknown): boolean {
  if (!isJsonObject(serialized)) {
    return false;
  }
  const { schemas } = serialized;
  return Array.isArray(schemas) && schemas.length > 0;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.split('\n')[0].trim();
  }
  return String(error);
}

/**
 * Validates one example's content against a package's schema.
 *
 * Note what this does *not* do: undeclared keys are tolerated. Examples
 * legitimately carry RHDH wiring that belongs to no plugin schema — most of
 * this catalogue's examples contain a `dynamicPlugins` block, and many contain
 * nothing else — so `noUndeclaredProperties` would fail them en masse. The
 * trade-off is that a typo in a key name passes silently, while wrong types and
 * wrong nesting on declared keys are caught.
 *
 * Errors are returned rather than thrown so one bad example cannot abort a run.
 */
export async function validateExample(
  resolver: SchemaResolver,
  pkg: { name: string; version: string },
  context: string,
  content: unknown,
): Promise<SchemaOutcome> {
  const resolved = await resolver.resolve(pkg.name, pkg.version);
  if (resolved.kind !== 'schema') {
    return resolved.kind === 'no-schema'
      ? { kind: 'no-schema' }
      : { kind: 'unavailable', reason: resolved.reason };
  }

  if (!isJsonObject(content)) {
    return {
      kind: 'invalid',
      errors: ['app-config content must be a mapping'],
    };
  }

  try {
    resolved.schema.process(
      [{ data: content, context }],
      // No visibility filter: an example documents a full app-config, so
      // frontend and backend keys are both legitimate.
      { ignoreSchemaErrors: false },
    );
    return { kind: 'ok' };
  } catch (error) {
    return { kind: 'invalid', errors: splitSchemaErrors(error) };
  }
}

/**
 * config-loader reports every violation in one multi-line message. Splitting it
 * keeps CI output to one finding per line instead of a wall of text.
 */
function splitSchemaErrors(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error);
  const lines = message
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '');
  return lines.length > 0 ? lines : [String(error)];
}
