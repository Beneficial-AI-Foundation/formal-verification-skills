'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const filesUnder = relative => {
  const base = path.join(ROOT, relative);
  return fs.readdirSync(base, { withFileTypes: true }).flatMap(entry => {
    const child = path.join(relative, entry.name);
    return entry.isDirectory() ? filesUnder(child) : [child];
  });
};

const DISPATCH_STAGES = {
  'commands/fvs/aeneas-extract.md': ['extract_classify', 'extract_apply', 'extract_bisect',
    'extract_assess', 'extract_investigate'],
  'commands/fvs/crypto-eval.md': ['crypto_eval'],
  'commands/fvs/crypto-execute.md': ['crypto_execute'],
  'commands/fvs/crypto-followup.md': ['crypto_followup'],
  'commands/fvs/crypto-plan.md': ['crypto_plan'],
  'commands/fvs/fc-plan.md': ['research', 'fc_plan'],
  'commands/fvs/lean-formalise.md': ['fc_proof_plan', 'fc_spec'],
  'commands/fvs/lean-refactor.md': ['research', 'lean_refactor'],
  'commands/fvs/lean-specify.md': ['research', 'fc_spec'],
  'commands/fvs/lean-verify.md': ['fc_proof_plan', 'fc_proof_execution'],
  'commands/fvs/map-code.md': ['map_code'],
  'commands/fvs/natural-language.md': ['explain'],
  'commands/fvs/sync-aeneas-verif.md': ['doc_sync'],
  'commands/fvs/trust-audit.md': ['trust_audit'],
};

describe('runtime-aware FVS model settings', () => {
  it('ships stage-scoped overrides and profile-driven review defaults', () => {
    const config = JSON.parse(read('fv-skills/templates/config.json'));
    assert.equal(config.model_profile, 'quality');
    for (const runtime of ['claude', 'codex', 'pi', 'opencode', 'gemini']) {
      assert.deepEqual(config.stage_overrides[runtime], {});
      assert.deepEqual(config.model_overrides[runtime], {});
      assert.deepEqual(config.effort_overrides[runtime], {});
    }

    for (const key of ['spec_review', 'crypto_review']) {
      assert.equal(config[key].automatic, true);
      assert.equal(config[key].reviewer, null);
      assert.equal(config[key].model, null);
      assert.equal(config[key].effort, null);
    }
  });

  it('defines the confirmed quality stage and runtime matrices once', () => {
    const profiles = read('fv-skills/references/model-profiles.md');
    for (const stage of new Set(Object.values(DISPATCH_STAGES).flat().concat('spec_review', 'crypto_review'))) {
      assert.ok(profiles.includes(`\`${stage}\``), `missing canonical stage ${stage}`);
    }
    for (const row of [
      /Claude Code \| detected Fable \+ `max` \| detected Opus \+ `xhigh` \| detected Sonnet \+ `high`/,
      /Codex \/ OpenAI \| detected Astra \+ `max` \| detected Sol \+ `xhigh` \| detected Terra \+ `high`/,
    ]) assert.match(profiles, row);
    assert.match(profiles, /balanced \| `inherit` \| `high`/);
    assert.match(profiles, /budget \| `inherit` \| `medium`/);
    assert.ok(profiles.includes('stage_overrides[runtime][stage]'));
    assert.doesNotMatch(profiles, /gpt-[0-9]|openai-codex\/gpt/i,
      'configuration examples must use catalog placeholders');
  });

  it('provides stage and review configuration with safe catalog handling', () => {
    const command = read('commands/fvs/configure.md');
    for (const token of ['AskUserQuestion', '.formalising/fvs-config.json', 'PI_CODING_AGENT',
      'AI_AGENT', 'stage_overrides[runtime][stage]', 'provider-qualified', 'notes', 'reconfirm']) {
      assert.ok(command.includes(token), `configure missing ${token}`);
    }
    assert.match(command, /offer every value the selected catalog model reports as supported/i);
    assert.match(command, /ordinary Pi stages[\s\S]*active provider/i);
    assert.match(command, /preserve unknown/i);
  });

  it('requires each dispatch command to declare stages, confirm once, and pass effort', () => {
    for (const [file, stages] of Object.entries(DISPATCH_STAGES)) {
      const source = read(file);
      for (const stage of stages) assert.ok(source.includes(`\`${stage}\``), `${file} missing ${stage}`);
      assert.match(source, /selection manifest/i, `${file} missing command-level selection manifest`);
      assert.match(source, /confirm/i, `${file} missing manifest confirmation`);
      assert.match(source, /reasoning_effort=/i, `${file} does not pass resolved effort`);
      assert.doesNotMatch(source, /model=.*silently ignored|effort[^\n]*no-op/i,
        `${file} permits a confirmed setting to be ignored`);
    }
  });

  it('keeps concrete model families out of generic dispatch commands', () => {
    for (const file of Object.keys(DISPATCH_STAGES)) {
      assert.doesNotMatch(read(file), /\b(?:sonnet|haiku|opus|fable|astra|sol|luna|terra)\b/i, file);
    }
  });

  it('keeps concrete family fixtures inside the canonical profile contract only', () => {
    const files = ['README.md', ...filesUnder('commands/fvs'), ...filesUnder('fv-skills/workflows'),
      ...filesUnder('fv-skills/references').filter(file => file !== 'fv-skills/references/model-profiles.md'),
      'scripts/fvs-spec-review.mjs', 'scripts/fvs-codex-think.mjs',
      ...filesUnder('tests').filter(file => file.endsWith('.cjs') &&
        file !== 'tests/model-settings.test.cjs')];
    const concrete = /gpt-[0-9]|openai-codex\/gpt|\b(?:sonnet|haiku|opus|fable|astra|sol|luna|terra)\b/i;
    for (const file of files) assert.doesNotMatch(read(file), concrete, file);
  });

  it('uses profile routing and saved overrides for both review menus', () => {
    for (const [file, section, stage] of [
      ['commands/fvs/lean-spec-review.md', 'spec_review', 'spec_review'],
      ['commands/fvs/crypto-review.md', 'crypto_review', 'crypto_review'],
    ]) {
      const source = read(file);
      assert.ok(source.includes(`${section}.reviewer`));
      assert.ok(source.includes(`${section}.model`));
      assert.ok(source.includes(`${section}.effort`));
      assert.ok(source.includes(`\`${stage}\``));
      assert.match(source, /selection manifest/i);
      assert.match(source, /opposite/i);
      assert.match(source, /provider-qualified[\s\S]*Pi/i);
      assert.match(source, /Unreviewed \(user skipped\)/);
    }
  });

  it('defines visible one-run control and fail-closed noninteractive behavior', () => {
    const profiles = read('fv-skills/references/model-profiles.md');
    for (const token of ['Continue once', 'Adjust once', 'Save override', 'Cancel',
      'rebuilt and must be\nconfirmed again', 'fails before dispatch']) {
      assert.ok(profiles.includes(token), `model profiles missing ${token}`);
    }
    assert.match(profiles, /one confirmation covers the command/i);
    assert.match(profiles, /fresh provider-qualified OpenAI Pi seat[\s\S]*Codex CLI/i);
    assert.match(profiles, /Claude Code CLI with detected Fable \+ `max`/i);
    assert.match(profiles, /candidate's\s+provider metadata[\s\S]*active Pi provider/i);
    assert.match(profiles, /active\/inherited model[\s\S]*fail before dispatch/i);

    const adapter = read('bin/install.js');
    assert.match(adapter, /Selection-capability gate \(before manifest confirmation\)/);
    assert.match(adapter, /Never confirm a requested model or effort and then omit it/i);

    const reviewHelper = read('scripts/fvs-spec-review.mjs');
    assert.doesNotMatch(reviewHelper, /reviewerDefaults|defaultEffort/);
    assert.match(reviewHelper, /Select an explicit model from the reviewer runtime catalog/);
    assert.match(reviewHelper, /Select an explicit effort reported for the selected reviewer model/);
    assert.match(reviewHelper, /codex', 'claude', 'pi', 'other/);
    assert.match(reviewHelper, /Pi reviewer models must be provider-qualified/);
    assert.match(reviewHelper, /validatePiDispatchReceipt/);
    assert.match(reviewHelper, /requires an active Pi host/);
    const reviewWorkflow = read('fv-skills/workflows/lean-spec-review.md');
    assert.ok(reviewWorkflow.includes('"model": "<exact catalog ID>"'));
    assert.ok(reviewWorkflow.includes('"effort": "<supported effort>"'));
    assert.match(reviewWorkflow, /PI_READY[\s\S]*dispatch receipt[\s\S]*import-pi/);
    assert.match(read('fv-skills/workflows/crypto-review.md'),
      /PI_READY[\s\S]*dispatch receipt[\s\S]*review-import-pi/);
    assert.match(read('scripts/fvs-codex-think.mjs'), /review-import-pi[\s\S]*dispatch-receipt/);
  });
});
