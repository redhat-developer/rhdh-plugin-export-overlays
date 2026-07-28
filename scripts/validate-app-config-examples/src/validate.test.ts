/*
 * Copyright (c) Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

// The CLI's reporting and exit-code policy. `report` takes writers rather than
// touching process.stdout so these can assert on the exact output CI shows.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { main, report, type Row, type SchemaTally } from './validate.js';

const NO_SCHEMAS: SchemaTally = {
  validated: 0,
  mismatched: 0,
  noSchema: 0,
  unavailable: 0,
};

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    write: (text: string) => void out.push(text),
    writeError: (text: string) => void err.push(text),
    get stdout() {
      return out.join('');
    },
    get stderr() {
      return err.join('');
    },
  };
}

const passing: Row = {
  status: 'PASS',
  path: 'workspaces/a/metadata/x.yaml',
  detail: 'has non-empty first example content',
  notes: [],
};

describe('report exit codes', () => {
  it('returns 0 when nothing failed', () => {
    const io = capture();
    assert.equal(report([passing], NO_SCHEMAS, false, io.write, io.writeError), 0);
    assert.equal(io.stderr, '');
  });

  it('returns 1 and says so on stderr when a row failed', () => {
    const io = capture();
    const failing: Row = { ...passing, status: 'FAIL', detail: 'boom' };
    assert.equal(report([failing], NO_SCHEMAS, false, io.write, io.writeError), 1);
    assert.match(io.stderr, /Validation failed/);
  });

  it('stays 0 when mismatches were only counted, never applied to a row', () => {
    // The workflow_dispatch sweep runs --warn-only precisely so the pre-existing
    // backlog reports without wedging the run. If mismatches ever fed the exit
    // code, that sweep would start red.
    const io = capture();
    const tally: SchemaTally = { ...NO_SCHEMAS, validated: 4, mismatched: 3 };
    assert.equal(report([passing], tally, true, io.write, io.writeError), 0);
    assert.match(io.stdout, /mismatched: 3/);
  });
});

describe('report output', () => {
  it('appends the detail only to non-passing rows', () => {
    const io = capture();
    report(
      [passing, { ...passing, status: 'FAIL', path: 'b.yaml', detail: 'why' }],
      NO_SCHEMAS,
      false,
      io.write,
      io.writeError,
    );
    assert.ok(!io.stdout.includes('# has non-empty first example content'));
    assert.match(io.stdout, /FAIL\s+b\.yaml\s+# why/);
  });

  it('indents notes beneath their row', () => {
    const io = capture();
    report(
      [{ ...passing, notes: ['schema unavailable: HTTP 404'] }],
      NO_SCHEMAS,
      true,
      io.write,
      io.writeError,
    );
    assert.match(io.stdout, /\n\s{4,}- schema unavailable: HTTP 404\n/);
  });

  it('omits the schema line entirely when schemas were not checked', () => {
    const io = capture();
    report([passing], NO_SCHEMAS, false, io.write, io.writeError);
    assert.ok(!io.stdout.includes('Schemas —'));
  });

  it('warns loudly when a schema run validated nothing', () => {
    // Without this a proxy outage or an all-unavailable catalogue reports
    // "PASS: 1  FAIL: 0" and reads as a green gate, having checked nothing.
    const io = capture();
    const tally: SchemaTally = { ...NO_SCHEMAS, noSchema: 1, unavailable: 5 };
    report([passing], tally, true, io.write, io.writeError);
    assert.match(io.stdout, /no example was checked against a schema/);
  });

  it('does not warn when at least one example was validated', () => {
    const io = capture();
    const tally: SchemaTally = { ...NO_SCHEMAS, validated: 1 };
    report([passing], tally, true, io.write, io.writeError);
    assert.ok(!io.stdout.includes('no example was checked'));
  });

  it('prints a header even with no rows at all', () => {
    const io = capture();
    assert.equal(report([], NO_SCHEMAS, false, io.write, io.writeError), 0);
    assert.match(io.stdout, /^STATUS {2}FILE\n/);
    assert.match(io.stdout, /Total: 0 {2}PASS: 0 {2}FAIL: 0/);
  });
});

describe('main argument handling', () => {
  it('prints usage and exits 0 for --help', async () => {
    const io = capture();
    assert.equal(await main(['--help'], io.write, io.writeError), 0);
    assert.match(io.stdout, /Usage: validate-app-config-examples/);
  });

  it('rejects an empty --since instead of silently scanning the whole tree', async () => {
    // A blank value is falsy, so this would otherwise fall through to a
    // full-tree run — with --check-schemas, that is 178 package downloads.
    const io = capture();
    assert.equal(await main(['--since', ''], io.write, io.writeError), 2);
    assert.match(io.stderr, /--since needs a commit-ish/);
  });

  it('exits 0 with an explanation when the range touches no metadata', async () => {
    const io = capture();
    assert.equal(await main(['--since', 'HEAD'], io.write, io.writeError), 0);
    assert.match(io.stdout, /nothing to validate/);
  });
});
