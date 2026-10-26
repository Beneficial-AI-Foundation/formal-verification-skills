'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const generator = require('../scripts/build-plugin.cjs');
const root = path.resolve(__dirname, '..');
const { ALL_RUNTIMES, PI_PACKAGE_NAME, buildPiPackageSource } = require('../bin/install.js');

test('renders one self-contained native setup entry rather than relocated workflows', () => {
  const text = generator.renderSetupSkill?.() ?? '';
  assert.match(text, /^---\nname: fvs-setup\ndescription: .*native.*setup/m);
  assert.match(text, /## Scope/);
  assert.match(text, /thirty-three commands/);
  assert.doesNotMatch(text, /\bthirty commands/);
  assert.match(text, /## Consent/);
  assert.match(text, /## Complete source installation/);
  assert.match(text, /## Privacy/);
  assert.doesNotMatch(text, /CLAUDE_PLUGIN_ROOT|@\.\.\/|\.\.\/\.\.\//);
  assert.equal(fs.readdirSync(path.join(root, 'commands/fvs')).filter(n => n.endsWith('.md')).length, 33);
  assert.equal(fs.readdirSync(path.join(root, 'pi/skills')).length, 33);
  assert.equal(fs.readdirSync(path.join(root, 'plugins/fvs/skills')).length, 33);
});

test('covers all supported native channels without hidden registry or role substitution', () => {
  const text = generator.renderSetupSkill();
  assert.match(text, /## Runtime and channel choices/);
  for (const runtime of ALL_RUNTIMES) assert.ok(text.includes(`| ${runtime} |`), `native candidate ${runtime}`);
  for (const runtime of ALL_RUNTIMES.filter(r => r !== 'pi')) assert.ok(text.includes(`--${runtime}`));
  assert.ok(text.includes(buildPiPackageSource(require('../package.json').version)));
  assert.ok(text.includes(PI_PACKAGE_NAME));
  assert.match(text, /pi install "\$sourceRoot" --local/);
  assert.match(text, /project trust/i);
  assert.match(text, /marketplace add Beneficial-AI-Foundation\/plugins/);
  assert.match(text, /claude plugin install fvs@beneficial-ai-foundation/);
  assert.match(text, /codex plugin add fvs@beneficial-ai-foundation/);
  assert.match(text, /does not register.*Codex.*roles/i);
  assert.match(text, /unified --pi.*delegates to npm/i);
});

test('names explicit refusal states without pretending a Markdown contract enforces conversations', () => {
  const text = generator.renderSetupSkill();
  assert.match(text, /## Stop conditions/);
  const stops = text.split('## Stop conditions')[1].split('\n## ')[0];
  for (const state of ['declined setup', 'missing runtime', 'missing tool', 'missing setting', 'required-live', 'fresh-review missing', 'source/version mismatch', 'unpublished npm pin']) {
    assert.ok(stops.includes(state), `explicit stop contract: ${state}`);
  }
  assert.match(text, /not.*conversational enforcement/i);
  assert.match(text, /fresh review inline/);
  assert.match(text, /triage/);
  assert.match(text, /author-owned/);
  assert.match(text, /Compiler-only fallback needs/);
  assert.match(text, /Conditional IDE diagnostics are not goals/);
  assert.doesNotMatch(text, /Beam|readiness-only|write-promotion broker/);
});

test('rejects hidden adjacent bootstrap loaders and malformed installed entries', () => {
  const { assertContract } = require('./helpers/skills-distribution-smoke.cjs');
  const text = generator.renderSetupSkill();
  assert.throws(() => assertContract(text + '\nRead @./hidden.md before setup.\n'), /adjacent|relative|loader/);
  assert.throws(() => assertContract(text.replace('name: fvs-setup', 'name: [malformed]')), /identity/);
});

test('builds only a deterministic owned setup file without damaging siblings', () => {
  assert.equal(typeof generator.buildSetupSkill, 'function', 'setup output builder must exist');
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fvs-setup-unit-'));
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
