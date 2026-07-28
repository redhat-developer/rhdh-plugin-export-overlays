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

// Structural checks on Package metadata. This is a behaviour-preserving port of
// scripts/validate-app-config-examples.py (RHIDP-12590) — the verdicts and
// messages here are deliberately identical to that script's, so the CI gate
// behaves exactly as it did before. The semantic layer in schema.ts is layered
// on top of these verdicts rather than replacing them.

import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';

const execFileAsync = promisify(execFile);

export type Status = 'PASS' | 'FAIL' | 'SKIP';

export type StructuralResult = {
  status: Status;
  detail: string;
  /** Parsed document, present whenever the YAML itself was readable. */
  doc?: Record<string, unknown>;
};

/**
 * Mirrors the Python `_is_empty_content`: null/undefined, an empty mapping, an
 * empty sequence, and a blank string all count as "no content". An empty
 * mapping (`{}`) is deliberately a failure rather than a pass — see RHIDP-12590.
 */
export function isEmptyContent(content: unknown): boolean {
  if (content === null || content === undefined) {
    return true;
  }
  if (Array.isArray(content)) {
    return content.length === 0;
  }
  if (isPlainObject(content)) {
    return Object.keys(content).length === 0;
  }
  if (typeof content === 'string') {
    return content.trim() === '';
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Evaluates one metadata document. Pure — takes text, so it is easy to test. */
export function evaluateDocument(text: string): StructuralResult {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (error) {
    return { status: 'FAIL', detail: `YAML error: ${error}` };
  }

  if (!isPlainObject(doc)) {
    return { status: 'FAIL', detail: 'YAML error: root must be a mapping' };
  }

  if (doc.kind !== 'Package') {
    return { status: 'SKIP', detail: 'kind is not Package', doc };
  }

  const spec = doc.spec;
  if (!isPlainObject(spec)) {
    return { status: 'FAIL', detail: 'missing or invalid spec', doc };
  }

  const notRequired = spec.appConfigNotRequired === true;
  const examples = spec.appConfigExamples ?? [];

  if (!Array.isArray(examples)) {
    return { status: 'FAIL', detail: 'appConfigExamples must be a list', doc };
  }

  if (examples.length === 0) {
    return notRequired
      ? { status: 'PASS', detail: 'opt-out (appConfigNotRequired)', doc }
      : {
          status: 'FAIL',
          detail:
            'empty appConfigExamples without spec.appConfigNotRequired: true',
          doc,
        };
  }

  const first = examples[0];
  if (!isPlainObject(first)) {
    return {
      status: 'FAIL',
      detail: 'appConfigExamples[0] must be a mapping',
      doc,
    };
  }

  if (isEmptyContent(first.content)) {
    return {
      status: 'FAIL',
      detail: 'appConfigExamples[0].content is empty or {}',
      doc,
    };
  }

  return { status: 'PASS', detail: 'has non-empty first example content', doc };
}

export async function evaluateFile(path: string): Promise<StructuralResult> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    return { status: 'FAIL', detail: `YAML error: ${error}` };
  }
  return evaluateDocument(text);
}

/** True for paths shaped like `workspaces/<ws>/metadata/<name>.yaml`. */
export function isMetadataPath(path: string): boolean {
  const parts = path.split('/');
  return (
    parts.length >= 4 &&
    parts[0] === 'workspaces' &&
    parts[2] === 'metadata' &&
    path.endsWith('.yaml')
  );
}

/**
 * Metadata paths added/copied/modified/renamed between `since` and HEAD,
 * relative to `repoRoot`. Deleted files are excluded by the diff filter,
 * matching the Python script.
 */
export async function changedMetadataPaths(
  since: string,
  repoRoot: string,
): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'git',
    ['diff', '--name-only', '--diff-filter=ACMR', `${since}...HEAD`],
    { cwd: repoRoot },
  );
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && isMetadataPath(line))
    .sort();
}

/**
 * The npm coordinates a Package metadata document points at, when it has them.
 * Both halves are required: the name alone leaves the version floating, and
 * validating against a different version than the one shipped is worse than
 * not validating at all.
 */
export function packageCoordinates(
  doc: Record<string, unknown> | undefined,
): { name: string; version: string } | undefined {
  if (!doc || !isPlainObject(doc.spec)) {
    return undefined;
  }
  const { packageName, version } = doc.spec;
  if (typeof packageName !== 'string' || typeof version !== 'string') {
    return undefined;
  }
  if (packageName === '' || version === '') {
    return undefined;
  }
  return { name: packageName, version };
}

/** Every `appConfigExamples[]` entry that carries content worth validating. */
export function configExamples(
  doc: Record<string, unknown> | undefined,
): { title: string; content: unknown }[] {
  if (!doc || !isPlainObject(doc.spec)) {
    return [];
  }
  const examples = doc.spec.appConfigExamples;
  if (!Array.isArray(examples)) {
    return [];
  }
  return examples
    .filter(isPlainObject)
    .filter(example => !isEmptyContent(example.content))
    .map((example, index) => ({
      title:
        typeof example.title === 'string' && example.title !== ''
          ? example.title
          : `appConfigExamples[${index}]`,
      content: example.content,
    }));
}
