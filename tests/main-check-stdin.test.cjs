'use strict';

// A script read from stdin has the argument `-`, which names no file. Its main
// check must treat that as "not the main script" rather than throw, and a stdin
// run must never start the command line. fvs-auto.mjs imports the review script,
// so a throw there also broke a stdin run of the engine itself.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPTS = path.resolve(__dirname, '..', 'scripts');

// Relative imports of a stdin script resolve from the working directory.
function node(args, input) {
  return spawnSync(process.execPath, args, { cwd: SCRIPTS, encoding: 'utf8', input });
}

const FOUR = ['fvs-spec-review.mjs', 'fvs-model-review.mjs', 'fvs-model-external.mjs', 'fvs-auto-driver.mjs'];
const BUILD_CHECK = 'fvs-build-check.mjs';

for (const name of [...FOUR, 'fvs-auto.mjs', BUILD_CHECK]) {
  describe(`${name} main check`, () => {
    it('runs nothing and prints nothing when its text is read from stdin', () => {
      const result = node(['--input-type=module', '-'], fs.readFileSync(path.join(SCRIPTS, name), 'utf8'));
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, '');
      assert.equal(result.status, 0);
    });

    it('runs nothing when imported as a module', () => {
      const result = node(['--input-type=module', '-e', `await import('./${name}')`]);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, '');
      assert.equal(result.status, 0);
    });

    if (FOUR.includes(name)) {
      it('still runs its command line when started as a file', () => {
        const result = node([name]);
        assert.match(result.stdout + result.stderr, /Usage: fvs-[a-z-]+\.mjs/);
        assert.notEqual(result.status, 0);
      });
    } else if (name === BUILD_CHECK) {
      // The build check has no --help: a run with no subcommand refuses with the usage code and one JSON object.
      it('still runs its command line when started as a file: a refusal with the usage code, one JSON object on stdout', () => {
        const result = node([name]);
        assert.equal(result.status, 2);
        assert.equal(JSON.parse(result.stdout).code, 'usage');
      });
    } else {
      it('still runs its command line when started as a file', () => {
        const result = node([name, '--help']);
        assert.match(result.stdout, /^Usage: node fvs-auto\.mjs/);
        assert.equal(result.status, 0);
      });
    }
  });
}
