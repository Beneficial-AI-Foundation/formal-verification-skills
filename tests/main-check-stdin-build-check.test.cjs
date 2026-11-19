'use strict';

// The build check's main check, in the same three cases the other scripts' main checks are held to:
// a script read from stdin has the argument `-`, which names no file, so it is not the main script
// and must neither throw nor start the command line; an import runs nothing; a file run still runs.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPTS = path.resolve(__dirname, '..', 'scripts');
const NAME = 'fvs-build-check.mjs';

// Relative imports of a stdin script resolve from the working directory.
const node = (args, input) => spawnSync(process.execPath, args, { cwd: SCRIPTS, encoding: 'utf8', input });

describe(`${NAME} main check`, () => {
  it('runs nothing and prints nothing when its text is read from stdin', () => {
    const result = node(['--input-type=module', '-'], fs.readFileSync(path.join(SCRIPTS, NAME), 'utf8'));
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, '');
    assert.equal(result.status, 0);
  });

  it('runs nothing when imported as a module', () => {
    const result = node(['--input-type=module', '-e', `await import('./${NAME}')`]);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, '');
    assert.equal(result.status, 0);
  });

  it('still runs its command line when started as a file: a refusal with the usage code, one JSON object on stdout', () => {
    const result = node([NAME]);
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).code, 'usage');
  });
});
