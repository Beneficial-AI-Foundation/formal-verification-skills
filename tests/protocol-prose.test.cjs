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

test('eval prose correction is opted in, parent-owned and capped without new verdicts', () => {
  const contract = read('fv-skills/workflows/protocol-prose.md');
  assert.match(contract, /Only `\/fvs:crypto-eval <topic> nN --fix-prose` opts into this path/);
  assert.match(contract, /at most one correction pass in the parent seat/);
  assert.match(contract, /Reuse the normal\n   eval dispatch once in a fresh invocation/);
  assert.match(contract, /preserving existing reviewer-selection\/independence/);
  assert.match(contract, /No second correction pass\n   or planning restart/);
  for (const base of ['commands/fvs', 'fv-skills/workflows']) {
    const source = read(`${base}/crypto-eval.md`);
    assert.match(source, /eval_editorial_correction/);
    assert.match(source, /eval_result_resolution/);
    assert.match(source, /prose_correction/);
    assert.match(source, /Omit editorial\ncriteria when the flag is absent/);
    assert.match(source, /parent-only; never forward it as a helper CLI flag/);
    assert.match(source, /<protocol_prose>\n\$PROTOCOL_PROSE\n<\/protocol_prose>/);
    assert.match(source, /<prose_correction>/);
    assert.match(source, /read-only role/);
    assert.match(source, /unresolved findings prevent ACCEPT/);
  }
});

test('editorial qualification cannot authorize semantic fixes or widen source scope', () => {
  const reference = read('fv-skills/references/protocol-prose.md');
  const contract = read('fv-skills/workflows/protocol-prose.md');
  assert.match(reference, /missing assumption, changed quantifier, security claim, source\ninterpretation, theorem statement, definition or proof is never editorial/);
  assert.match(reference, /Mixed findings do not\nqualify/);
  assert.match(contract, /semantic, source, trust and required build checks all pass/);
  assert.match(contract, /intersection\n   of these spans and the approved task\/plan's exact editable files/);
  assert.match(contract, /Generated files,\n   historical plans\/evals and unapproved paths are ineligible/);
  assert.match(contract, /restores only this pass's edits.*BLOCKED/s);
});

test('final eval checks corrected prose and all findings with current immutable evidence', () => {
  const contract = read('fv-skills/workflows/protocol-prose.md');
  for (const name of ['PROSE_BASELINE_nN.md', 'PROSE_CORRECTION_nN.md', 'PROSE_RECHECK_nN.md']) {
    assert.ok(contract.includes(name), name);
  }
  assert.match(contract, /hash the\n   entire evaluated file set, approved plan and source\/trust\/build evidence/);
  assert.match(contract, /evaluator must\n   inspect the corrected prose, check every original finding/);
  assert.match(contract, /Reject an `ACCEPT` response with any unresolved finding/);
  assert.match(contract, /Only the authoritative final eval may validate lessons/);
  assert.match(contract, /No.*byte preservation.*prove prose quality|byte preservation and green builds do not prove prose quality/s);
  assert.match(contract, /absent\/partial\/malformed evidence blocks acceptance/);
  assert.match(contract, /missing recheck acceptance alone does not force a whole-topic pause/);
  assert.match(contract, /Missing correction metadata alone does not prohibit\nreviewed semantic followup/);
  assert.match(contract, /actual failed build, missing grounding\/access prerequisite\nor failed restoration still takes `BLOCKED`/);
  assert.match(contract, /hashes equal to the\n  current files/);
  assert.match(contract, /never fall back to an older `ACCEPT`/);
});

test('followup and discovery route editorial attempts without bypassing semantic review', () => {
  for (const base of ['commands/fvs', 'fv-skills/workflows']) {
    const source = read(`${base}/crypto-followup.md`);
    assert.match(source, /eval_result_resolution/);
    assert.match(source, /incomplete\/stale correction evidence blocks acceptance/);
    assert.match(source, /acceptance-unverified.*semantic followup/s);
    assert.match(source, /--fix-prose/);
    assert.match(source, /already attempted.*normal\nsemantic followup\/HUMAN_RULING/s);
    assert.match(source, /never edits protocol prose itself/);
  }
  assert.doesNotMatch(read('commands/fvs/crypto-followup.md'), /grep -Eo.*ACCEPT/);
  for (const file of ['README.md', 'commands/fvs/help.md', 'commands/fvs/crypto-execute.md',
    'fv-skills/workflows/crypto-execute.md']) assert.match(read(file), /--fix-prose/);
});
