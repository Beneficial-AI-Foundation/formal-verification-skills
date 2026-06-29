'use strict';

// Structural gates for the Aeneas extraction repair loop.
//
// These assertions close the Wave-0 structural rows for the extraction
// requirements: they are machine-enforced invariants over the shipped command,
// workflow, draft agent, and config template -- so a future edit that weakens
// them fails the suite rather than silently regressing a safety property.
//
// Enforced invariants:
//   1. No upstream-artifact OPEN/CREATE invocation appears in the extraction
//      command or the draft agent (the repudiation guard -- drafting is opt-in
//      HTML+MD to disk; opening/creating an issue or PR is forbidden). Read-only
//      listing (`gh api`) is the deliberately-shipped precedent and is allowed;
//      only the create/open verbs are banned. The forbidden verbs are assembled
//      at runtime so this test file does not self-match.
//   2. The config template carries the three clone/workspace keys.
//   3. No absolute sibling-clone path is hardcoded in the command or workflow
//      (clone paths are resolved via config -> auto-detect -> prompt -> error).
//   4. The command/workflow carry the pin-audit block (`charon-pin`), the
//      loop-bounds block (attempt-cap + no-progress), and the pipefail /
//      PIPESTATUS guard so a piped build failure is never masked.
//   5. The success-oracle token grep (`equivalence-ratified:`) is present.
//
// Pure node:test + node:assert/strict, zero npm dependencies.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const COMMAND = path.join(ROOT, 'commands', 'fvs', 'aeneas-extract.md');
const WORKFLOW = path.join(ROOT, 'fv-skills', 'workflows', 'aeneas-extract.md');
const DRAFT_AGENT = path.join(ROOT, 'agents', 'fvs-draft-investigator.md');
const CONFIG = path.join(ROOT, 'fv-skills', 'templates', 'config.json');

function readLines(absPath) {
  return fs.readFileSync(absPath, 'utf8').split('\n');
}

function rel(absPath) {
  return path.relative(ROOT, absPath);
}

// ---------------------------------------------------------------------------
// 1. No upstream-artifact open/create invocation in the draft path.
//
// EXTR-07 bans AUTO-OPENING/CREATING an upstream artifact. Read-only `gh api`
// listing is the shipped precedent (the sync-aeneas-verif command and the draft
// agent's precedent mining) and is NOT banned. The forbidden verbs are the create/open forms;
// they are built at runtime from fragments so the literal token does not appear
// in this test file's own source.
// ---------------------------------------------------------------------------
describe('Extraction loop: no upstream-artifact open/create in the draft path (EXTR-07)', () => {
  const GH = 'gh';
  // gh issue create | gh pr create | gh issue open | gh pr open | gh release create
  const FORBIDDEN = [
    new RegExp(`\\b${GH}\\s+issue\\s+create\\b`),
    new RegExp(`\\b${GH}\\s+pr\\s+create\\b`),
    new RegExp(`\\b${GH}\\s+issue\\s+open\\b`),
    new RegExp(`\\b${GH}\\s+pr\\s+open\\b`),
    new RegExp(`\\b${GH}\\s+release\\s+create\\b`),
  ];

  const AGENTS_DIR = path.join(ROOT, 'agents');
  const CMD_DIR = path.join(ROOT, 'commands', 'fvs');
  const SCRIPTS_DIR = path.join(ROOT, 'scripts');
  const EXTR07_TARGETS = [
    COMMAND,
    WORKFLOW,
    DRAFT_AGENT,
    path.join(AGENTS_DIR, 'fvs-doc-syncer.md'),
    path.join(AGENTS_DIR, 'fvs-equivalence-assessor.md'),
    path.join(AGENTS_DIR, 'fvs-extract-applier.md'),
    path.join(AGENTS_DIR, 'fvs-extract-bisector.md'),
    path.join(AGENTS_DIR, 'fvs-extract-classifier.md'),
    // Phase-13 crypto loop + trust audit surface. The two new agents exist now;
    // the stage command files arrive in later waves and the Codex-think helper
    // scripts arrive later still -- each is guarded by an existence check below
    // so the no-gh-open invariant covers them the moment they land.
    path.join(AGENTS_DIR, 'fvs-crypto-thinker.md'),
    path.join(AGENTS_DIR, 'fvs-axiom-auditor.md'),
    path.join(CMD_DIR, 'crypto-plan.md'),
    path.join(CMD_DIR, 'crypto-execute.md'),
    path.join(CMD_DIR, 'crypto-eval.md'),
    path.join(CMD_DIR, 'crypto-followup.md'),
    path.join(CMD_DIR, 'trust-audit.md'),
    path.join(SCRIPTS_DIR, 'fvs-codex-think.mjs'),
    path.join(SCRIPTS_DIR, 'fvs-codex-think.sh'),
  ];
  // The Codex-think helper now ships, so its no-gh-open invariant is asserted
  // UNCONDITIONALLY: this gate fails if the script is deleted/renamed as well as
  // if it ever grows an open/create verb. The remaining existence-guarded targets
  // (the trust-audit command, the future .sh shim) attach the moment they land.
  const UNCONDITIONAL = new Set([
    path.join(SCRIPTS_DIR, 'fvs-codex-think.mjs'),
  ]);

  for (const target of EXTR07_TARGETS) {
    const unconditional = UNCONDITIONAL.has(target);
    it(`${rel(target)} contains no open/create upstream-artifact invocation`, () => {
      if (!fs.existsSync(target)) {
        if (unconditional) {
          assert.fail(`${rel(target)} must exist (no-gh-open invariant is unconditional for it)`);
        }
        // Not yet created (arrives in a later wave) -- the invariant attaches
        // the moment the file exists; nothing to scan before then.
        return;
      }
      const offenders = [];
      readLines(target).forEach((line, i) => {
        if (FORBIDDEN.some(re => re.test(line))) {
          offenders.push(`${rel(target)}:${i + 1}`);
        }
      });
      assert.deepStrictEqual(offenders, [],
        `Forbidden upstream open/create invocation found: ${offenders.join(', ')}`);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Config template carries the clone/workspace keys (EXTR-08).
// ---------------------------------------------------------------------------
describe('Extraction loop: config clone/workspace keys present (EXTR-08)', () => {
  const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const project = config.project || {};

  for (const key of ['charon_clone_path', 'aeneas_clone_path', 'extract_workspace']) {
    it(`config.json project carries ${key}`, () => {
      assert.ok(
        Object.prototype.hasOwnProperty.call(project, key),
        `config template missing project.${key}`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 3. No hardcoded absolute sibling-clone path in the command or workflow.
//
// The clone paths must be resolved via config -> auto-detect -> prompt -> error,
// never baked in as a literal absolute path. The forbidden path fragments are
// assembled at runtime so this test file does not self-match.
// ---------------------------------------------------------------------------
describe('Extraction loop: no hardcoded absolute clone path (V5 / T-12-05)', () => {
  const SEG = '/GitHub/' + 'BAIF_GH/';
  const FORBIDDEN = [
    new RegExp(SEG.replace(/\//g, '\\/') + 'charon'),
    new RegExp(SEG.replace(/\//g, '\\/') + 'aeneas'),
  ];

  for (const target of [COMMAND, WORKFLOW]) {
    it(`${rel(target)} hardcodes no absolute clone path`, () => {
      const offenders = [];
      readLines(target).forEach((line, i) => {
        if (FORBIDDEN.some(re => re.test(line))) {
          offenders.push(`${rel(target)}:${i + 1}`);
        }
      });
      assert.deepStrictEqual(offenders, [],
        `Hardcoded absolute clone path found: ${offenders.join(', ')}`);
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Pin-audit, loop-bounds, and pipefail guard present (EXTR-03/06; T-12-06).
// ---------------------------------------------------------------------------
describe('Extraction loop: pin-audit / loop-bounds / pipefail tokens present', () => {
  const commandText = fs.readFileSync(COMMAND, 'utf8');
  const workflowText = fs.readFileSync(WORKFLOW, 'utf8');

  function present(text, re) {
    return re.test(text);
  }

  it('the workflow carries the pin-audit block (charon-pin)', () => {
    assert.ok(present(workflowText, /charon-pin/),
      'workflow missing the pin-audit token charon-pin');
  });

  it('the command references the pin audit (charon-pin)', () => {
    assert.ok(present(commandText, /charon-pin/),
      'command missing the pin-audit token charon-pin');
  });

  it('the workflow carries the loop-bounds block (attempt-cap)', () => {
    assert.ok(present(workflowText, /attempt[- ]cap/i),
      'workflow missing the attempt-cap loop-bound token');
  });

  it('the workflow carries the no-progress rule', () => {
    assert.ok(present(workflowText, /no[- ]progress/i),
      'workflow missing the no-progress loop-bound token');
  });

  it('the command references attempt-cap + no-progress', () => {
    assert.ok(present(commandText, /attempt[- ]cap/i) && present(commandText, /no[- ]progress/i),
      'command missing the loop-bounds tokens');
  });

  it('the workflow uses the pipefail / PIPESTATUS green-build trap guard', () => {
    assert.ok(present(workflowText, /set -o pipefail/) && present(workflowText, /\$\{PIPESTATUS/),
      'workflow missing the pipefail / PIPESTATUS guard');
  });

  it('the command uses the pipefail / PIPESTATUS green-build trap guard', () => {
    assert.ok(present(commandText, /set -o pipefail/) && present(commandText, /\$\{PIPESTATUS/),
      'command missing the pipefail / PIPESTATUS guard');
  });
});

// ---------------------------------------------------------------------------
// 5. Success-oracle token grep present (EXTR-05).
// ---------------------------------------------------------------------------
describe('Extraction loop: success-oracle ratification token present (EXTR-05)', () => {
  const TOKEN = /equivalence-ratified:/;

  it('the workflow greps the equivalence-ratified token', () => {
    assert.ok(TOKEN.test(fs.readFileSync(WORKFLOW, 'utf8')),
      'workflow missing the equivalence-ratified: oracle token');
  });

  it('the command greps the equivalence-ratified token', () => {
    assert.ok(TOKEN.test(fs.readFileSync(COMMAND, 'utf8')),
      'command missing the equivalence-ratified: oracle token');
  });
});
