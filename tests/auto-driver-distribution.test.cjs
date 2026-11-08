'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
test('generated plugin carries both actual helpers and resolves driver dependencies without running a stage', () => {
  for (const name of ['fvs-auto-driver.mjs', 'fvs-auto-actor-permissions.py']) {
    assert.deepEqual(fs.readFileSync(path.join(ROOT, 'plugins/fvs/scripts', name)), fs.readFileSync(path.join(ROOT, 'scripts', name)));
  }
  const result = spawnSync(process.execPath, [path.join(ROOT, 'plugins/fvs/scripts/fvs-auto-driver.mjs')], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(result.status, 1); assert.match(result.stderr, /driver-invalid-input.*Usage:/);
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|ENOENT/);
  for (const name of ['auto-init', 'auto-top-specs', 'auto-execute']) {
    assert.match(fs.readFileSync(path.join(ROOT, 'plugins/fvs/skills', name, 'SKILL.md'), 'utf8'), /authorized v2|actual v2 AO/);
    assert.match(fs.readFileSync(path.join(ROOT, 'pi/skills/fvs-' + name, 'SKILL.md'), 'utf8'), /production driver/);
  }
});
