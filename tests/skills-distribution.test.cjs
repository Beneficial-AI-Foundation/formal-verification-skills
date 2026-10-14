'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const generator = require('../scripts/build-plugin.cjs');
const root = path.resolve(__dirname, '..');

test('renders one self-contained native setup entry rather than relocated workflows', () => {
  const text = generator.renderSetupSkill?.() ?? '';
  assert.match(text, /^---\nname: fvs-setup\ndescription: .*native.*setup/m);
  assert.match(text, /## Scope/);
  assert.match(text, /## Consent/);
  assert.match(text, /## Complete source installation/);
  assert.match(text, /## Privacy/);
  assert.doesNotMatch(text, /CLAUDE_PLUGIN_ROOT|@\.\.\/|\.\.\/\.\.\//);
  assert.equal(fs.readdirSync(path.join(root, 'commands/fvs')).filter(n => n.endsWith('.md')).length, 30);
  assert.equal(fs.readdirSync(path.join(root, 'pi/skills')).length, 30);
  assert.equal(fs.readdirSync(path.join(root, 'plugins/fvs/skills')).length, 30);
});

test('builds only a deterministic owned setup file without damaging siblings', () => {
  assert.equal(typeof generator.buildSetupSkill, 'function', 'setup output builder must exist');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-setup-unit-'));
  const dest = path.join(tmp, 'skills/fvs-setup');
  fs.mkdirSync(path.join(tmp, 'skills/unrelated'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'skills/unrelated/keep.txt'), 'keep');
  generator.buildSetupSkill(dest);
  const first = fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8');
  generator.buildSetupSkill(dest);
  assert.equal(fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8'), first);
  assert.deepEqual(fs.readdirSync(dest), ['SKILL.md']);
  assert.equal(fs.readFileSync(path.join(tmp, 'skills/unrelated/keep.txt'), 'utf8'), 'keep');
  assert.throws(() => generator.buildSetupSkill(root), /unsafe|must end/i);
  assert.throws(() => generator.buildSetupSkill(path.parse(root).root), /unsafe|must end/i);
  fs.writeFileSync(path.join(dest, 'unknown'), 'do not erase');
  assert.throws(() => generator.buildSetupSkill(dest), /unknown|unexpected/i);
  assert.equal(fs.readFileSync(path.join(dest, 'unknown'), 'utf8'), 'do not erase');
  fs.symlinkSync(path.join(tmp, 'skills'), path.join(tmp, 'redirect'));
  assert.throws(() => generator.buildSetupSkill(path.join(tmp, 'redirect/fvs-setup')), /symlink/i);
});
