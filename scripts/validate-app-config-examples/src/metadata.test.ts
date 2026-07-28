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

// These lock in the verdicts and wording inherited from the Python script this
// module replaces. A change here means the CI gate's behaviour changed, so it
// should be deliberate rather than incidental.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  evaluateDocument,
  isEmptyContent,
  isMetadataPath,
} from './metadata.js';

const PACKAGE_HEAD = 'apiVersion: extensions.backstage.io/v1alpha1\nkind: Package\n';

describe('isEmptyContent', () => {
  it('treats absent, blank and empty containers as empty', () => {
    for (const value of [null, undefined, {}, [], '', '   ', '\n']) {
      assert.equal(isEmptyContent(value), true, `expected ${JSON.stringify(value)} to be empty`);
    }
  });

  it('treats populated values as non-empty', () => {
    for (const value of [{ a: 1 }, [1], 'x', 0, false]) {
      assert.equal(isEmptyContent(value), false, `expected ${JSON.stringify(value)} to be non-empty`);
    }
  });
});

describe('evaluateDocument', () => {
  it('passes a Package with non-empty first example content', () => {
    const result = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  appConfigExamples:\n    - title: Default\n      content:\n        app:\n          x: 1\n`,
    );
    assert.equal(result.status, 'PASS');
    assert.equal(result.detail, 'has non-empty first example content');
  });

  it('passes an explicit opt-out', () => {
    const result = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  appConfigNotRequired: true\n  appConfigExamples: []\n`,
    );
    assert.equal(result.status, 'PASS');
    assert.equal(result.detail, 'opt-out (appConfigNotRequired)');
  });

  it('fails an empty example list without the opt-out', () => {
    const result = evaluateDocument(`${PACKAGE_HEAD}spec:\n  appConfigExamples: []\n`);
    assert.equal(result.status, 'FAIL');
    assert.equal(
      result.detail,
      'empty appConfigExamples without spec.appConfigNotRequired: true',
    );
  });

  it('fails a missing appConfigExamples the same way as an empty one', () => {
    const result = evaluateDocument(`${PACKAGE_HEAD}spec:\n  packageName: "@scope/thing"\n`);
    assert.equal(result.status, 'FAIL');
    assert.equal(
      result.detail,
      'empty appConfigExamples without spec.appConfigNotRequired: true',
    );
  });

  it('fails an empty mapping as content — {} is not a real example', () => {
    const result = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  appConfigExamples:\n    - title: Default\n      content: {}\n`,
    );
    assert.equal(result.status, 'FAIL');
    assert.equal(result.detail, 'appConfigExamples[0].content is empty or {}');
  });

  it('fails when appConfigExamples is not a list', () => {
    const result = evaluateDocument(`${PACKAGE_HEAD}spec:\n  appConfigExamples: nope\n`);
    assert.equal(result.status, 'FAIL');
    assert.equal(result.detail, 'appConfigExamples must be a list');
  });

  it('fails when the first example is not a mapping', () => {
    const result = evaluateDocument(
      `${PACKAGE_HEAD}spec:\n  appConfigExamples:\n    - just-a-string\n`,
    );
    assert.equal(result.status, 'FAIL');
    assert.equal(result.detail, 'appConfigExamples[0] must be a mapping');
  });

  it('fails a missing or non-mapping spec', () => {
    assert.equal(evaluateDocument(PACKAGE_HEAD).status, 'FAIL');
    assert.equal(evaluateDocument(`${PACKAGE_HEAD}spec: nope\n`).detail, 'missing or invalid spec');
  });

  it('skips documents that are not Packages', () => {
    const result = evaluateDocument('kind: Plugin\nspec: {}\n');
    assert.equal(result.status, 'SKIP');
    assert.equal(result.detail, 'kind is not Package');
  });

  it('fails a document whose root is not a mapping', () => {
    assert.equal(evaluateDocument('- a\n- b\n').status, 'FAIL');
    assert.equal(evaluateDocument('').status, 'FAIL');
  });

  it('fails unparseable YAML rather than throwing', () => {
    const result = evaluateDocument('key: [unclosed\n');
    assert.equal(result.status, 'FAIL');
    assert.match(result.detail, /^YAML error:/);
  });
});

describe('isMetadataPath', () => {
  it('accepts metadata YAML and rejects everything else', () => {
    assert.equal(isMetadataPath('workspaces/acr/metadata/thing.yaml'), true);
    assert.equal(isMetadataPath('workspaces/acr/metadata/thing.yml'), false);
    assert.equal(isMetadataPath('workspaces/acr/other/thing.yaml'), false);
    assert.equal(isMetadataPath('scripts/thing.yaml'), false);
    assert.equal(isMetadataPath('workspaces/acr/metadata'), false);
  });
});
