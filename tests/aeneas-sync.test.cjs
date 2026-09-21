'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const META_PATH = path.join(ROOT, 'fv-skills', 'upstream', 'aeneas', '_sync-meta.json');
const COMMAND_PATH = path.join(ROOT, 'commands', 'fvs', 'sync-aeneas-verif.md');
const WORKFLOW_PATH = path.join(ROOT, 'fv-skills', 'workflows', 'sync-aeneas-verif.md');
const AGENT_PATH = path.join(ROOT, 'agents', 'fvs-doc-syncer.md');
const CONFIG_PATH = path.join(ROOT, 'fv-skills', 'templates', 'config.json');
const MODEL_PROFILES_PATH = path.join(ROOT, 'fv-skills', 'references', 'model-profiles.md');
const CONFIGURE_PATH = path.join(ROOT, 'commands', 'fvs', 'configure.md');
const meta = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
const command = fs.readFileSync(COMMAND_PATH, 'utf8');
const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');
const agent = fs.readFileSync(AGENT_PATH, 'utf8');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const modelProfiles = fs.readFileSync(MODEL_PROFILES_PATH, 'utf8');
const configure = fs.readFileSync(CONFIGURE_PATH, 'utf8');

const FROZEN_AENEAS_SHA = '227f4e7ac70d687a6b1a4871b3304f5a1c6994bf';
const FROZEN_AENEAS_DATE = '2026-09-17T17:20:51Z';
const FROZEN_CHARON_PIN = 'a5591f6b94c8575a6ba2ae71090614a722f2b011';
const FROZEN_CHARON_MAIN_SHA = 'eb5814f1185f1b274e34d89417e5f30909aa20cd';
const FROZEN_CHARON_MAIN_DATE = '2026-09-21T07:32:51Z';

const EXPECTED_EXTRACTION_INPUTS = {
  'AeneasVerif/aeneas': [
    'README.md',
    'documentation/README.md',
    'documentation/aeneas-overview.md',
    'documentation/crypto-verification.md',
    'documentation/emit-json.md',
    'documentation/getting-started.md',
    'documentation/glossary.md',
    'documentation/proof-strategies.md',
    'documentation/skills/aeneas-compiler-dev.instructions.md',
    'documentation/skills/aeneas-crypto-verification.instructions.md',
    'documentation/skills/aeneas-lean-core.instructions.md',
    'documentation/skills/aeneas-tactics-quickref.instructions.md',
    'documentation/skills/agent-fleet-management.instructions.md',
    'documentation/skills/formalizing-crypto-specs.instructions.md',
    'documentation/skills/launching-proof-agents.instructions.md',
    'documentation/skills/lean-lsp-mcp.instructions.md',
    'documentation/skills/proof-patterns.instructions.md',
    'documentation/skills/skill-file-authoring.instructions.md',
    'documentation/skills/verification-campaigns.instructions.md',
    'documentation/tactics-reference.md',
    'documentation/tips-and-tricks.md',
    'tests/README.md',
  ],
  'AeneasVerif/charon': [
    '.github/ISSUE_TEMPLATE/bug_report.md',
    '.github/ISSUE_TEMPLATE/unsupported-language-feature.md',
    'CONTRIBUTING.md',
    'README.md',
    'docs/limitations.md',
    'docs/transformations.md',
    'docs/what_charon_translates.md',
  ],
};

describe('Aeneas sync metadata', () => {
  it('defines one explicit local snapshot target for every extraction input', () => {
    assert.ok(Array.isArray(meta.extraction_inputs),
      'sync metadata must define extraction_inputs');

    const actual = new Map();
    for (const input of meta.extraction_inputs) {
      assert.equal(typeof input.repository, 'string', 'extraction input repository');
      assert.equal(typeof input.upstream_path, 'string', 'extraction input upstream_path');
      assert.equal(typeof input.snapshot_target, 'string', 'extraction input snapshot_target');
      assert.match(input.snapshot_target, /^fv-skills\/upstream\/(aeneas|charon)\//,
        `snapshot target escapes the vendored upstream roots: ${input.snapshot_target}`);
      assert.ok(!/[?*\[\]]/.test(input.upstream_path),
        `extraction inputs must be exact paths, not globs: ${input.upstream_path}`);
      assert.ok(['sync', 'defer', 'evidence', 'review'].includes(input.disposition),
        `invalid disposition for ${input.repository}:${input.upstream_path}`);

      const key = `${input.repository}:${input.upstream_path}`;
      assert.ok(!actual.has(key), `duplicate extraction input: ${key}`);
      actual.set(key, input);
    }

    for (const [repository, paths] of Object.entries(EXPECTED_EXTRACTION_INPUTS)) {
      for (const upstreamPath of paths) {
        const key = `${repository}:${upstreamPath}`;
        assert.ok(actual.has(key), `missing extraction input: ${key}`);
      }
    }
  });

  it('binds synchronized snapshot bytes to the frozen upstream provenance', () => {
    assert.equal(meta.snapshot_commit, FROZEN_AENEAS_SHA);
    assert.equal(meta.snapshot_date, FROZEN_AENEAS_DATE);
    assert.equal(meta.charon_pin, FROZEN_CHARON_PIN);
    assert.deepEqual(meta.charon_main_checked, {
      commit: FROZEN_CHARON_MAIN_SHA,
      date: FROZEN_CHARON_MAIN_DATE,
    });

    for (const input of meta.extraction_inputs.filter(x => x.disposition === 'sync')) {
      assert.match(input.sha256 || '', /^[a-f0-9]{64}$/,
        `missing snapshot hash for ${input.upstream_path}`);
      const target = path.join(ROOT, input.snapshot_target);
      assert.ok(fs.existsSync(target), `snapshot target missing: ${input.snapshot_target}`);
      const actual = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
      assert.equal(actual, input.sha256,
        `snapshot hash does not match metadata: ${input.snapshot_target}`);
    }
  });

  it('maps only headings that exist in hash-bound synchronized snapshots', () => {
    for (const mapping of meta.mapping.filter(x => x.merge_strategy !== 'defer')) {
      const sources = meta.extraction_inputs.filter(input =>
        input.repository === 'AeneasVerif/aeneas' &&
        input.disposition === 'sync' &&
        path.basename(input.upstream_path) === mapping.upstream);
      assert.equal(sources.length, 1,
        `mapping source must resolve uniquely: ${mapping.upstream}`);

      const text = fs.readFileSync(path.join(ROOT, sources[0].snapshot_target), 'utf8');
      const headings = new Set(text.split('\n')
        .map(line => line.match(/^#{1,6}\s+(.+?)\s*$/)?.[1]?.toLowerCase())
        .filter(Boolean));
      for (const section of mapping.upstream_sections) {
        assert.ok(headings.has(section.toLowerCase()),
          `missing upstream section ${mapping.upstream}#${section}`);
      }
    }
  });

  it('freezes Aeneas main and its Charon pin without inventing an Aeneas self-pin', () => {
    for (const [name, text] of [['command', command], ['workflow', workflow]]) {
      assert.doesNotMatch(text, /lakefile[- ]pinned rev/i,
        `${name} still assumes Aeneas has a lakefile self-pin`);
      for (const token of [
        'FROZEN_AENEAS_SHA',
        'FROZEN_AENEAS_DATE',
        'FROZEN_CHARON_PIN',
        'FROZEN_CHARON_MAIN_SHA',
      ]) {
        assert.match(text, new RegExp(`\\b${token}\\b`), `${name} missing ${token}`);
      }
    }
  });

  it('defaults native_decide to ask and records every effective policy in manifests', () => {
    assert.equal(config.native_decide, 'ask');
    for (const value of ['avoid', 'ask', 'allow']) {
      assert.match(modelProfiles, new RegExp(`\\b${value}\\b`),
        `model profiles missing native_decide value ${value}`);
    }
    assert.match(modelProfiles, /native_decide[^\n]*effective/i,
      'manifest contract must report the effective native_decide policy');
    assert.match(modelProfiles, /one-run[^\n]*(does not persist|never persists)/i,
      'one-run native_decide overrides must not persist');
    assert.match(configure, /native_decide/,
      'configure command must expose the project native_decide policy');
  });

  it('keeps fetch, proposal, approved writes, verification, and metadata commit distinct', () => {
    for (const [name, text] of [
      ['command', command],
      ['workflow', workflow],
      ['agent', agent],
    ]) {
      assert.match(text, /snapshot_target/, `${name} missing explicit snapshot targets`);
      assert.match(text, /FROZEN_AENEAS_SHA/, `${name} missing frozen Aeneas source`);
      assert.match(text, /propos/i, `${name} missing proposal phase`);
      assert.match(text, /verif/i, `${name} missing verification phase`);
      assert.match(text, /metadata[^\n]*last|_sync-meta\.json`?\s+last/i,
        `${name} must update metadata last`);
    }
  });
});
