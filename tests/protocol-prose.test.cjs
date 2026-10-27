'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('prose revision is explicit, bounded and stays in the current session', () => {
  const command = read('commands/fvs/protocol-prose.md');
  const workflow = read('fv-skills/workflows/protocol-prose.md');
  assert.match(command, /Opt-in/);
  assert.match(command, /<file-or-topic>/);
  assert.doesNotMatch(command, /\n  - (?:Task|Skill)\n|subagent_type=/);
  assert.match(workflow, /paths outside.*repository.*generated\/extracted.*symlink escapes/s);
  assert.match(workflow, /Preserve unrelated edits/);
  assert.match(workflow, /historical execution records remain intact/);
  assert.match(workflow, /suggestion in chat without editing/);
});

test('requires primary source alignment or explicitly blocked terminology validation', () => {
  const workflow = read('fv-skills/workflows/protocol-prose.md');
  const reference = read('fv-skills/references/protocol-prose.md');
  assert.match(workflow, /style guide.*nearby accepted/s);
  assert.match(workflow, /primary source is\nunavailable.*BLOCKED/s);
  assert.match(workflow, /Do not claim source alignment from memory or a summary/);
  for (const meaning of ['quantifier order', 'adversary capabilities', 'advantage normalization',
    'reduction direction', 'equality in distribution', 'documented deviations', 'citation targets']) {
    assert.ok(reference.includes(meaning), meaning);
  }
  assert.match(reference, /conflict with anonymization.*rather than silently removing attribution/s);
});

test('Lean edits require a green baseline, immutable formal content and a revised build', () => {
  const workflow = read('fv-skills/workflows/protocol-prose.md');
  assert.ok(workflow.indexOf('<step name="baseline">') < workflow.indexOf('<step name="revise">'));
  assert.match(workflow, /CACHE_STATUS=\$\?/);
  assert.match(workflow, /BUILD_STATUS=\$\?/);
  assert.match(workflow, /exit "\$BUILD_STATUS"/);
  assert.match(workflow, /all bytes\noutside.*imports.*definitions.*statements,\nproofs/s);
  assert.match(workflow, /nested comments and strings containing comment\nmarkers/);
  assert.match(workflow, /same project build after revision.*module explicitly/s);
  assert.match(workflow, /restore only this invocation's\nedits/);
  assert.match(workflow, /never label unrun or unavailable checks green/);
});

test('existing authoring calls receive full prose context without a new dispatch', () => {
  for (const base of ['commands/fvs', 'fv-skills/workflows']) {
    for (const name of ['crypto-plan', 'crypto-execute', 'lean-formalise']) {
      const source = read(`${base}/${name}.md`);
      const expected = name === 'lean-formalise' ? 2 : 1;
      assert.equal(source.split('<protocol_prose>\n$PROTOCOL_PROSE\n</protocol_prose>').length - 1,
        expected, `${base}/${name}: actual prompt must contain the reference`);
      assert.match(source, /read `fv-skills\/references\/protocol-prose.md`/i);
      assert.match(source, /no model call, review gate/);
      if (name === 'crypto-plan') assert.match(source, /context JSON as `protocol_prose`/);
    }
  }
  assert.doesNotMatch(read('commands/fvs/natural-language.md'), /protocol-prose/);
});

test('prose entry point and reference reach both generated native packages', () => {
  for (const file of ['plugins/fvs/skills/protocol-prose/SKILL.md',
    'pi/skills/fvs-protocol-prose/SKILL.md']) {
    assert.match(read(file), /workflows\/protocol-prose.md/);
    assert.match(read(file), /references\/protocol-prose.md/);
  }
  assert.equal(read('plugins/fvs/fv-skills/references/protocol-prose.md'),
    read('fv-skills/references/protocol-prose.md'));
});

test('new public prose resources are self-contained and use synthetic examples', () => {
  const reference = read('fv-skills/references/protocol-prose.md');
  assert.match(reference, /invented editorial examples/);
  for (const file of ['commands/fvs/protocol-prose.md', 'fv-skills/workflows/protocol-prose.md',
    'fv-skills/references/protocol-prose.md']) {
    assert.doesNotMatch(read(file), /\/Users\/|\/home\/|\.agents\/skills|\.codex\/skills|discussion_r\d+|pullrequestreview-\d+/);
  }
});
