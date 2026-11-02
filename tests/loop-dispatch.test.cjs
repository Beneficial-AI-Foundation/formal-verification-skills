'use strict';

// Instruction-contract regressions for per-pass sub-agent dispatch. These check the shipped
// text that tells the parent to dispatch a fresh child for every delegated pass; they are not
// host enforcement and cannot show that a runtime actually dispatched each pass.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const flat = file => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\s+/g, ' ');

const RULE = '**Fresh child per pass:** every pass or round of this loop that delegates work dispatches a new ' +
  'child of the role named here, with the current inputs and the confirmed settings; the parent never ' +
  "performs that role's work itself. Wait for the child's terminal result through the runtime's normal wait " +
  'or notification; a spawn acknowledgement or progress message is not a result. If the dispatch fails, the ' +
  'child cannot be confirmed, or it ends in a terminal error, stop and report the affected pass. Valid results ' +
  'such as a failed build, NOVEL, REJECT, REVISE or FOLLOWUP still route as this step describes, and ' +
  'parent-owned baseline, build, revert and report steps stay with the parent.';

// Delegated per-pass/round re-entry sites in scope. External reviewer processes, one-shot
// dispatches and lean-specify's REVISE re-authoring are deliberately not listed.
const SITES = {
  'commands/fvs/lean-refactor.md': 1, 'fv-skills/workflows/lean-refactor.md': 1,
  'commands/fvs/lean-verify.md': 1, 'fv-skills/workflows/lean-verify.md': 1,
  'commands/fvs/aeneas-extract.md': 1, 'fv-skills/workflows/aeneas-extract.md': 1,
  'commands/fvs/crypto-plan.md': 1, 'fv-skills/workflows/crypto-plan.md': 1,
  'commands/fvs/crypto-followup.md': 1, 'fv-skills/workflows/crypto-followup.md': 1,
  'commands/fvs/crypto-eval.md': 1, 'fv-skills/workflows/crypto-eval.md': 1,
  'fv-skills/workflows/lean-formalise.md': 1,
  'commands/fvs/lean-specify.md': 1, 'fv-skills/workflows/lean-specify.md': 1,
  'fv-skills/workflows/model-external.md': 2,
};

describe('Fresh child per pass: delegated loop sites', () => {
  for (const [file, count] of Object.entries(SITES)) {
    it(`${file} states the rule at each delegated loop site`, () => {
      assert.equal(flat(file).split(RULE).length - 1, count);
    });
  }

  it('lean-refactor stops on a refactorer ERROR instead of starting another pass', () => {
    for (const file of ['commands/fvs/lean-refactor.md', 'fv-skills/workflows/lean-refactor.md']) {
      const text = flat(file);
      assert.doesNotMatch(text, /## ERROR: Store error, PASS \+= 1/);
      assert.match(text, /## ERROR`: Stop the affected batch and report the error/);
    }
  });

  it('keeps existing terminal gates that already stop', () => {
    assert.match(flat('commands/fvs/lean-verify.md'), /If ## ERROR:/);
    assert.match(flat('commands/fvs/crypto-plan.md'), /Failed, cancelled, pending, and unverified states also stop/);
  });

  it('extends the Codex delegation authorization to every pass of a loop', () => {
    const { getCodexSkillAdapterHeader } = require('../bin/install.js');
    for (const header of [getCodexSkillAdapterHeader('lean-refactor'),
      getCodexSkillAdapterHeader('lean-verify', { pluginName: 'fvs' })]) {
      assert.match(header, /Each `Task\(\.\.\.\)` dispatch in the workflow body, including every pass of a loop, is a skill instruction/);
    }
  });
});
