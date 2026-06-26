'use strict';

// Structural gates for the fc-bundle trust audit.
//
// These assertions close the structural rows for the trust-audit requirements
// (AUDIT-01..04): machine-enforced invariants over the trust-audit command +
// workflow, so a future edit that weakens them fails the suite rather than
// silently regressing an audit property.
//
// The command + workflow arrive in a later wave (Plan 03 creates
// commands/fvs/trust-audit.md + fv-skills/workflows/trust-audit.md). Until each
// file exists, its checks are SKIPPED via a guarded existence check, so this
// gate stays green before those files land and turns into a live assertion the
// moment each file is created.
//
// Enforced invariants (once the files exist):
//   1. Build-backed introspection: nice -n 19 lake build + set -o pipefail +
//      ${PIPESTATUS (build precondition, green-build guard).
//   2. The #print axioms oracle + the sorryAx => sorry classification.
//   3. The standard classical trio (propext / Classical.choice / Quot.sound).
//   4. The fail-if-unjustified NOT-CLEAN gate language.
//   5. The output path .formalising/audits/.
//   6. Strict-scope language (inventory != cone; prerequisites surfaced apart).
//   7. The topological-order language.
//
// Pure node:test + node:assert/strict, zero npm dependencies.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const COMMAND = path.join(ROOT, 'commands', 'fvs', 'trust-audit.md');
const WORKFLOW = path.join(ROOT, 'fv-skills', 'workflows', 'trust-audit.md');

function rel(absPath) {
  return path.relative(ROOT, absPath);
}

// Drop leading-'#' heading/comment lines so a token in header prose alone does
// not satisfy a gate.
function readContent(absPath) {
  return fs.readFileSync(absPath, 'utf8')
    .split('\n')
    .filter(line => !/^\s*#/.test(line))
    .join('\n');
}

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

for (const target of [COMMAND, WORKFLOW]) {
  whenExists(target, `Trust audit: structural gate over ${rel(target)} (AUDIT-01..04)`, (content, absPath) => {
    // 1. Build-backed introspection + green-build guard.
    it('runs the build precondition via nice -n 19 lake build (never a bare lake build)', () => {
      assert.ok(/nice -n 19 lake build/.test(content),
        `${rel(absPath)} missing the nice -n 19 lake build precondition`);
    });
    it('uses the pipefail / PIPESTATUS green-build trap guard', () => {
      assert.ok(/set -o pipefail/.test(content) && /\$\{PIPESTATUS/.test(content),
        `${rel(absPath)} missing the pipefail / PIPESTATUS guard`);
    });

    // 2. #print axioms oracle + sorryAx classification.
    it('uses #print axioms as the authoritative oracle', () => {
      assert.ok(/#print axioms/.test(content), `${rel(absPath)} missing the #print axioms oracle`);
    });
    it('classifies a sorryAx dependence as a sorry', () => {
      assert.ok(/sorryAx/.test(content), `${rel(absPath)} missing the sorryAx classification token`);
    });

    // 3. Standard classical trio.
    for (const ax of ['propext', 'Classical.choice', 'Quot.sound']) {
      it(`names the classical-trio axiom ${ax}`, () => {
        assert.ok(content.includes(ax), `${rel(absPath)} missing the classical-trio axiom ${ax}`);
      });
    }

    // 4. Fail-if-unjustified NOT-CLEAN gate.
    it('carries the fail-if-unjustified NOT-CLEAN gate language', () => {
      assert.ok(/NOT-CLEAN/.test(content), `${rel(absPath)} missing the NOT-CLEAN gate language`);
    });

    // 5. Output path.
    it('writes the audit output under .formalising/audits/', () => {
      assert.ok(/\.formalising\/audits\//.test(content),
        `${rel(absPath)} missing the .formalising/audits/ output path`);
    });

    // 6. Strict-scope language (inventory != cone).
    it('carries the strict-scope language (inventory is not the cone)', () => {
      assert.ok(/strict(ly)?[- ]scope/i.test(content) || /prerequisite/i.test(content),
        `${rel(absPath)} missing the strict-scope / surfaced-prerequisite language`);
    });

    // 7. Topological order.
    it('carries the topological-order language', () => {
      assert.ok(/topolog/i.test(content) || /dependency[- ]order/i.test(content),
        `${rel(absPath)} missing the topological / dependency-order language`);
    });
  });
}
