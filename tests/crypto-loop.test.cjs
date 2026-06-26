'use strict';

// Structural gates for the crypto formalisation iteration loop.
//
// These assertions close the structural rows for the crypto-loop requirements
// (FORM-01..06): they are machine-enforced invariants over the four stage
// command + workflow files, so a future edit that weakens them fails the suite
// rather than silently regressing a loop property.
//
// The four stage command + workflow files arrive across later waves (Plans 02
// and 03 create crypto-plan/crypto-execute/crypto-eval/crypto-followup). Until a
// given file exists, its checks are SKIPPED via a guarded existence check, so
// this gate stays green before those files land and turns into a live assertion
// the moment each file is created. The intent is documented per-block.
//
// Enforced invariants (once the files exist):
//   1. Loop artifact layout: fv-plans/<topic>/{plans,reviews,sources,merge}.
//   2. The bounded-plan contract headings (stop conditions, verification
//      commands, immutable public statements).
//   3. The always-adversarial decision verbs ACCEPT|FOLLOWUP|HUMAN_RULING|BLOCKED.
//   4. The KB grounding language: loud-fail-once + labeled-degrade +
//      /fvs:kb-setup + fvs-kb-query.py + the sources/ cache-before-requery rule.
//   5. The single-runtime dispatch shape (fvs-crypto-thinker + fvs-executor).
//   6. The set -o pipefail + ${PIPESTATUS green-build guard in crypto-execute.
//
// Pure node:test + node:assert/strict, zero npm dependencies.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CMD_DIR = path.join(ROOT, 'commands', 'fvs');
const WF_DIR = path.join(ROOT, 'fv-skills', 'workflows');

function rel(absPath) {
  return path.relative(ROOT, absPath);
}

// Read a file, dropping markdown comment / header-prose lines that begin with
// '#', so a token appearing only in explanatory prose does not satisfy a gate.
// We keep code-fence and content lines; we drop leading-'#' heading lines.
function readContentLines(absPath) {
  return fs.readFileSync(absPath, 'utf8')
    .split('\n')
    .filter(line => !/^\s*#/.test(line));
}

function readContent(absPath) {
  return readContentLines(absPath).join('\n');
}

// Guarded describe: only register the assertions if the target file exists.
// Before Plans 02/03 land their files this is a no-op (green); afterward it is a
// live gate. We register a single bookkeeping `it` either way so the suite shows
// the gate is wired.
function whenExists(absPath, label, register) {
  describe(label, () => {
    if (!fs.existsSync(absPath)) {
      it(`${rel(absPath)} not yet present -- gate dormant (created in a later wave)`, () => {
        assert.ok(true);
      });
      return;
    }
    register(readContent(absPath), absPath);
  });
}

const STAGE_FILES = {
  cmdPlan: path.join(CMD_DIR, 'crypto-plan.md'),
  cmdExecute: path.join(CMD_DIR, 'crypto-execute.md'),
  cmdEval: path.join(CMD_DIR, 'crypto-eval.md'),
  cmdFollowup: path.join(CMD_DIR, 'crypto-followup.md'),
  wfPlan: path.join(WF_DIR, 'crypto-plan.md'),
  wfExecute: path.join(WF_DIR, 'crypto-execute.md'),
  wfEval: path.join(WF_DIR, 'crypto-eval.md'),
  wfFollowup: path.join(WF_DIR, 'crypto-followup.md'),
};

// ---------------------------------------------------------------------------
// 1. Loop artifact layout: fv-plans/<topic>/{plans,reviews,sources,merge}.
//    The plan command + workflow define the layout; assert each subfolder name
//    appears alongside the fv-plans root.
// ---------------------------------------------------------------------------
for (const key of ['cmdPlan', 'wfPlan']) {
  whenExists(STAGE_FILES[key], `Crypto loop: artifact layout in ${rel(STAGE_FILES[key])} (FORM-01)`, (content, absPath) => {
    it('references the fv-plans/<topic> root', () => {
      assert.ok(/fv-plans\//.test(content), `${rel(absPath)} missing fv-plans/ artifact root`);
    });
    for (const sub of ['plans', 'reviews', 'sources', 'merge']) {
      it(`references the ${sub}/ subfolder`, () => {
        assert.ok(new RegExp(`\\b${sub}\\b`).test(content),
          `${rel(absPath)} missing the ${sub} loop subfolder`);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// 2. Bounded-plan contract headings (FORM-02).
// ---------------------------------------------------------------------------
for (const key of ['cmdPlan', 'wfPlan']) {
  whenExists(STAGE_FILES[key], `Crypto loop: bounded-plan contract in ${rel(STAGE_FILES[key])} (FORM-02)`, (content, absPath) => {
    it('carries the stop-conditions contract heading', () => {
      assert.ok(/stop[- ]condition/i.test(content), `${rel(absPath)} missing stop-conditions contract`);
    });
    it('carries the verification-commands contract heading', () => {
      assert.ok(/verification command/i.test(content), `${rel(absPath)} missing verification-commands contract`);
    });
    it('carries the immutable-public-statements contract', () => {
      assert.ok(/public statement|must not change|immutable/i.test(content),
        `${rel(absPath)} missing the immutable-public-statements contract`);
    });
    it('verifies via nice -n 19 lake build (never a bare lake build)', () => {
      assert.ok(/nice -n 19 lake build/.test(content),
        `${rel(absPath)} missing the nice -n 19 lake build verification command`);
    });
  });
}

// ---------------------------------------------------------------------------
// 3. Always-adversarial decision verbs (FORM-04).
//    The eval stage must end in exactly one of these four; the followup stage
//    must HALT on HUMAN_RULING.
// ---------------------------------------------------------------------------
for (const key of ['cmdEval', 'wfEval']) {
  whenExists(STAGE_FILES[key], `Crypto loop: adversarial decision verbs in ${rel(STAGE_FILES[key])} (FORM-04)`, (content, absPath) => {
    for (const verb of ['ACCEPT', 'FOLLOWUP', 'HUMAN_RULING', 'BLOCKED']) {
      it(`carries the ${verb} decision verb`, () => {
        assert.ok(new RegExp(`\\b${verb}\\b`).test(content),
          `${rel(absPath)} missing the ${verb} decision verb`);
      });
    }
  });
}

for (const key of ['cmdFollowup', 'wfFollowup']) {
  whenExists(STAGE_FILES[key], `Crypto loop: followup HALTs on HUMAN_RULING in ${rel(STAGE_FILES[key])} (FORM-04)`, (content, absPath) => {
    it('HALTs on HUMAN_RULING (never fabricates a plan)', () => {
      assert.ok(/HUMAN_RULING/.test(content) && /HALT/i.test(content),
        `${rel(absPath)} missing the HUMAN_RULING HALT discipline`);
    });
  });
}

// ---------------------------------------------------------------------------
// 4. KB grounding: loud-fail-once + labeled-degrade + setup + cache (FORM-03/06).
// ---------------------------------------------------------------------------
for (const key of ['cmdPlan', 'wfPlan']) {
  whenExists(STAGE_FILES[key], `Crypto loop: KB grounding in ${rel(STAGE_FILES[key])} (FORM-03/06)`, (content, absPath) => {
    it('references the KB setup command (/fvs:kb-setup)', () => {
      assert.ok(/\/fvs:kb-setup/.test(content), `${rel(absPath)} missing /fvs:kb-setup reference`);
    });
    it('references the KB query script (fvs-kb-query.py)', () => {
      assert.ok(/fvs-kb-query\.py/.test(content), `${rel(absPath)} missing fvs-kb-query.py reference`);
    });
    it('carries the loud-fail-once + labeled-degrade language', () => {
      assert.ok(/loud[- ]fail/i.test(content) && /degrad/i.test(content),
        `${rel(absPath)} missing the loud-fail-once / labeled-degrade KB language`);
    });
    it('caches KB answers under sources/ (cache-before-requery)', () => {
      assert.ok(/sources\//.test(content) && /cache/i.test(content),
        `${rel(absPath)} missing the sources/ cache-before-requery rule`);
    });
  });
}

// ---------------------------------------------------------------------------
// 5. Single-runtime dispatch shape: thinker then executor.
// ---------------------------------------------------------------------------
for (const key of ['cmdPlan', 'cmdExecute', 'cmdEval', 'cmdFollowup']) {
  whenExists(STAGE_FILES[key], `Crypto loop: dispatch shape in ${rel(STAGE_FILES[key])} (FORM-04)`, (content, absPath) => {
    const isExecuteStage = /crypto-execute/.test(absPath);
    if (isExecuteStage) {
      it('dispatches the executor (fvs-executor)', () => {
        assert.ok(/subagent_type="fvs-executor"/.test(content),
          `${rel(absPath)} missing the fvs-executor dispatch`);
      });
    } else {
      it('dispatches the high-effort thinker (fvs-crypto-thinker)', () => {
        assert.ok(/subagent_type="fvs-crypto-thinker"/.test(content),
          `${rel(absPath)} missing the fvs-crypto-thinker dispatch`);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// 6. crypto-execute green-build guard: set -o pipefail + ${PIPESTATUS.
// ---------------------------------------------------------------------------
for (const key of ['cmdExecute', 'wfExecute']) {
  whenExists(STAGE_FILES[key], `Crypto loop: green-build guard in ${rel(STAGE_FILES[key])}`, (content, absPath) => {
    it('uses the pipefail / PIPESTATUS green-build trap guard', () => {
      assert.ok(/set -o pipefail/.test(content) && /\$\{PIPESTATUS/.test(content),
        `${rel(absPath)} missing the pipefail / PIPESTATUS guard`);
    });
    it('verifies via nice -n 19 lake build (never a bare lake build)', () => {
      assert.ok(/nice -n 19 lake build/.test(content),
        `${rel(absPath)} missing the nice -n 19 lake build command`);
    });
  });
}
