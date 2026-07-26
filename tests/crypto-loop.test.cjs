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
const AGENTS_DIR = path.join(ROOT, 'agents');

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
  cmdReview: path.join(CMD_DIR, 'crypto-review.md'),
  wfPlan: path.join(WF_DIR, 'crypto-plan.md'),
  wfExecute: path.join(WF_DIR, 'crypto-execute.md'),
  wfEval: path.join(WF_DIR, 'crypto-eval.md'),
  wfFollowup: path.join(WF_DIR, 'crypto-followup.md'),
  wfReview: path.join(WF_DIR, 'crypto-review.md'),
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
      it('dispatches the crypto executor (fvs-crypto-executor)', () => {
        assert.ok(/subagent_type="fvs-crypto-executor"/.test(content),
          `${rel(absPath)} missing the fvs-crypto-executor dispatch`);
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
// 7. --codex thinker mode on the three thinker stages (FORM-05 / D-06 / D-08).
//
//    The --codex mode swaps the in-runtime thinker dispatch for the FVS-owned
//    helper scripts/fvs-codex-think.mjs at the plan / eval / followup stages. It
//    must be EFFORT-ONLY (passes --effort xhigh, NEVER --model) and carry the
//    artifact-mediated / no-live-bridge language (the swappable thinker is not a
//    second loop, not a streaming IPC). The execute stage has no thinker, so it
//    is intentionally excluded here.
//
//    We strip leading-'#' prose lines (readContent), but a Codex flag could still
//    appear in explanatory prose; the regexes target the concrete invocation
//    token (fvs-codex-think) so a mere mention cannot satisfy the gate.
// ---------------------------------------------------------------------------
for (const key of ['cmdPlan', 'cmdEval', 'cmdFollowup']) {
  whenExists(STAGE_FILES[key], `Crypto loop: --codex thinker mode in ${rel(STAGE_FILES[key])} (FORM-05)`, (content, absPath) => {
    it('carries the --codex mode flag', () => {
      assert.ok(/--codex/.test(content), `${rel(absPath)} missing the --codex mode flag`);
    });
    it('invokes the FVS-owned Codex helper (fvs-codex-think)', () => {
      assert.ok(/fvs-codex-think/.test(content),
        `${rel(absPath)} missing the fvs-codex-think helper invocation`);
    });
    it('is effort-only at >= xhigh (passes --effort xhigh)', () => {
      assert.ok(/--effort\s+xhigh/.test(content),
        `${rel(absPath)} missing the --effort xhigh thinker floor`);
    });
    it('passes NO --model (effort-only policy)', () => {
      // The effort-only policy forbids a --model flag on the Codex helper line.
      const offenders = content
        .split('\n')
        .filter(line => /fvs-codex-think/.test(line) && /--model\b/.test(line));
      assert.deepStrictEqual(offenders, [],
        `${rel(absPath)} passes --model on a fvs-codex-think line (must be effort-only)`);
    });
    it('declares artifact-mediated coordination / no live bridge', () => {
      assert.ok(/artifact[- ]mediated/i.test(content) && /no\b[^\n]*live[- ]?(cross[- ]process )?bridge/i.test(content),
        `${rel(absPath)} missing the artifact-mediated / no-live-bridge language`);
    });
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

// ---------------------------------------------------------------------------
// 10. Crypto executor discipline (D-01/D-04).
//     The dedicated crypto executor must carry the whole-unit
//     implement -> check -> complete -> escalate -> BLOCKED discipline, drive
//     proofs via the runtime getDiagnostics tool, report to IMPLEMENTATION_nN.md,
//     and EXPECT style warnings that surface only at lake build. It must NOT
//     carry the FC proof-attempt one-sorry framing (that grind stays FC-only).
//     Dormant until the agent file lands (created this wave); the crypto-execute
//     dispatch-shape token retarget is owned by a later wave and is intentionally
//     NOT asserted here.
// ---------------------------------------------------------------------------
const CRYPTO_EXECUTOR = path.join(AGENTS_DIR, 'fvs-crypto-executor.md');
whenExists(CRYPTO_EXECUTOR, `Crypto loop: executor discipline in ${rel(CRYPTO_EXECUTOR)} (D-01/D-04)`, (content, absPath) => {
  it('completes proofs via the runtime getDiagnostics tool', () => {
    assert.ok(/mcp__ide__getDiagnostics/.test(content),
      `${rel(absPath)} missing the mcp__ide__getDiagnostics runtime tool reference`);
  });
  it('reports to an IMPLEMENTATION_ report file', () => {
    assert.ok(/IMPLEMENTATION_/.test(content),
      `${rel(absPath)} missing the IMPLEMENTATION_ report contract`);
  });
  it('carries the escalate + BLOCKED discipline', () => {
    assert.ok(/escalate/i.test(content) && /\bBLOCKED\b/.test(content),
      `${rel(absPath)} missing the escalate / BLOCKED handback discipline`);
  });
  it('expects style warnings that surface only at lake build (D-04)', () => {
    assert.ok(/nice -n 19 lake build/.test(content) && /style/i.test(content),
      `${rel(absPath)} missing the lake-build style-authority expectation`);
  });
  it('explicitly rejects the one-sorry / <=3-line / compile-between-steps grind', () => {
    assert.ok(/reject/i.test(content) && /pair-programm/i.test(content),
      `${rel(absPath)} missing the explicit rejection of the proof-attempt grind`);
  });
  it('does NOT carry the affirmative proof-attempt one-sorry framing', () => {
    assert.ok(!/Work ONE sorry at a time/.test(content),
      `${rel(absPath)} must not carry the FC proof-attempt "Work ONE sorry at a time" framing`);
  });
});

// ---------------------------------------------------------------------------
// 11. Independent pre-execution plan review (#35).
// ---------------------------------------------------------------------------
for (const key of ['cmdReview', 'wfReview']) {
  whenExists(STAGE_FILES[key], `Crypto loop: independent plan review in ${rel(STAGE_FILES[key])} (#35)`, (content, absPath) => {
    it('preflights Codex authentication and never silently falls back', () => {
      assert.ok(/codex login status/.test(content),
        `${rel(absPath)} missing Codex authentication preflight`);
      assert.ok(/no silent|never silently|no same-runtime fallback/i.test(content),
        `${rel(absPath)} missing no-fallback independence rule`);
    });
    it('supports both initial and follow-up plan review artifacts', () => {
      for (const token of ['PLAN_REVIEW_', 'FOLLOWUP_REVIEW_']) {
        assert.ok(content.includes(token), `${rel(absPath)} missing ${token} artifact contract`);
      }
    });
    it('requires read-only, xhigh, effort-only Codex review', () => {
      assert.ok(/read-only/i.test(content) && /xhigh/i.test(content) && /no `--model`|no model override|effort-only/i.test(content),
        `${rel(absPath)} missing read-only/xhigh/effort-only review contract`);
    });
    it('fails closed on self-review or unknown provenance', () => {
      assert.ok(/Authoring runtime:/.test(content) && /self-review|independ/i.test(content) &&
        /missing provenance|provenance is unverified|unknown provenance/i.test(content),
      `${rel(absPath)} missing provenance-based self-review refusal`);
    });
    it('routes only APPROVE to execution', () => {
      for (const verdict of ['APPROVE', 'APPROVE-WITH-EDITS', 'REJECT']) {
        assert.ok(content.includes(verdict), `${rel(absPath)} missing ${verdict} verdict`);
      }
      assert.ok(/Only APPROVE|`APPROVE`.*proceed|APPROVE.*routes/i.test(content),
        `${rel(absPath)} does not gate execution on APPROVE`);
    });
  });
}

const REVIEW_CONTRACT = path.join(ROOT, 'fv-skills', 'references', 'crypto-plan-review.md');
whenExists(REVIEW_CONTRACT, 'Crypto loop: adversarial review contract covers formal-verification failure modes', (content, absPath) => {
  for (const surface of [
    'Source fidelity',
    'Statement-level soundness',
    'Semantic closure',
    'Precedent and interface realism',
    'Gates',
    'Boundedness and safety',
    'Roadmap coherence',
  ]) {
    it(`covers ${surface}`, () => {
      assert.ok(content.includes(surface), `${rel(absPath)} missing ${surface}`);
    });
  }
  it('forbids proof attempts and requires cited evidence', () => {
    assert.ok(/MUST NOT[\s\S]*Attempt proofs/i.test(content) && /path:line/.test(content),
      `${rel(absPath)} missing proof-attempt fence or evidence standard`);
  });
  it('requires exactly one pre-execution verdict', () => {
    for (const verdict of ['APPROVE', 'APPROVE-WITH-EDITS', 'REJECT']) {
      assert.ok(content.includes(verdict), `${rel(absPath)} missing ${verdict}`);
    }
    assert.ok(/VERDICT:.*exactly once|exactly one verdict/is.test(content),
      `${rel(absPath)} missing exactly-one-verdict requirement`);
  });
});

for (const key of ['cmdPlan', 'cmdFollowup']) {
  whenExists(STAGE_FILES[key], `Crypto loop: ${rel(STAGE_FILES[key])} routes through review`, (content, absPath) => {
    it('records truthful authoring-runtime provenance', () => {
      assert.ok(/Authoring runtime:/.test(content),
        `${rel(absPath)} missing Authoring runtime marker contract`);
    });
    it('routes Next Up through /fvs:crypto-review', () => {
      assert.ok(/\/fvs:crypto-review/.test(content),
        `${rel(absPath)} bypasses the independent review stage`);
    });
  });
}

// ---------------------------------------------------------------------------
// 8. fvs-codex-think.mjs path confinement (security): a --topic that resolves
//    outside .formalising/fv-plans/ must be refused BEFORE any codex spawn, so a
//    `..` escape cannot hand the thinker workspace-write access to an arbitrary
//    directory. Runs the real script; topic validation precedes the codex probe,
//    so this holds whether or not codex is installed.
// ---------------------------------------------------------------------------
const CODEX_THINK = path.join(ROOT, 'scripts', 'fvs-codex-think.mjs');
whenExists(CODEX_THINK, 'Crypto loop: fvs-codex-think.mjs confines --topic to the loop tree', () => {
  const { spawnSync } = require('node:child_process');
  for (const escape of ['/tmp', '../../../tmp', '.formalising/fv-plans/../../escape']) {
    it(`refuses --topic "${escape}" (resolves outside the loop tree)`, () => {
      const r = spawnSync(process.execPath, [CODEX_THINK, 'plan', '--topic', escape, '--effort', 'xhigh'], {
        cwd: ROOT, encoding: 'utf8',
      });
      assert.notStrictEqual(r.status, 0,
        `expected non-zero exit refusing escaping --topic "${escape}"`);
      assert.match(`${r.stderr || ''}${r.stdout || ''}`, /outside \.formalising\/fv-plans|path traversal|refusing/i,
        `expected a confinement refusal for "${escape}"`);
    });
  }
});

whenExists(CODEX_THINK, 'Crypto loop: Codex review helper is authenticated, read-only, and wrapper-persisted', (content, absPath) => {
  it('checks codex login status in addition to binary availability', () => {
    assert.ok(/\['login', 'status'\]/.test(content),
      `${rel(absPath)} missing codex login status defense-in-depth preflight`);
  });
  it('uses read-only + ephemeral review invocation and output-last-message capture', () => {
    for (const token of ["'read-only'", "'--ephemeral'", "'--output-last-message'"]) {
      assert.ok(content.includes(token), `${rel(absPath)} missing ${token}`);
    }
    assert.ok(/fs\.writeFileSync\(review\.outputPath/.test(content),
      `${rel(absPath)} does not make the wrapper own the review artifact write`);
  });
  it('loads the shipped crypto-plan-review contract', () => {
    assert.ok(/crypto-plan-review\.md/.test(content),
      `${rel(absPath)} missing the specialised review contract`);
  });
  it('marks Codex-authored plans so later review cannot masquerade as independent', () => {
    assert.ok(/Authoring runtime: Codex CLI/.test(content),
      `${rel(absPath)} does not stamp Codex authoring provenance`);
  });
});

describe('Crypto loop: fvs-codex-think review stage with a fake Codex CLI', () => {
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');

  it('captures one validated review while giving Codex read-only repository access', {
    skip: process.platform === 'win32',
  }, () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-review-test-'));
    try {
      const fakeBin = path.join(tmpRoot, 'bin');
      const project = path.join(tmpRoot, 'project');
      const topic = path.join(project, '.formalising', 'fv-plans', 'demo');
      const plans = path.join(topic, 'plans');
      const reviews = path.join(topic, 'reviews');
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.mkdirSync(plans, { recursive: true });
      fs.mkdirSync(reviews, { recursive: true });
      fs.writeFileSync(
        path.join(plans, 'PLAN_n1.md'),
        '# Plan\n\nAuthoring runtime: Claude Code\n'
      );
      fs.writeFileSync(
        path.join(plans, 'EXEC_PLAN_n1.md'),
        '# Executor Plan\n\nAuthoring runtime: Claude Code\n'
      );

      const fakeCodex = path.join(fakeBin, 'codex');
      fs.writeFileSync(fakeCodex, [
        '#!/usr/bin/env node',
        "'use strict';",
        "const fs = require('node:fs');",
        'const args = process.argv.slice(2);',
        "if (args[0] === '--version') { console.log('codex-cli fake'); process.exit(0); }",
        "if (args[0] === 'login' && args[1] === 'status') { console.log('Logged in'); process.exit(0); }",
        "if (args[0] !== 'exec') process.exit(9);",
        "const outAt = args.indexOf('--output-last-message');",
        'if (outAt < 0 || !args[outAt + 1]) process.exit(8);',
        "fs.writeFileSync(args[outAt + 1], '# FVS Crypto Plan Review\\n\\n- VERDICT: APPROVE\\n\\n## Findings\\n\\nNone.\\n\\n## Cleared surfaces\\n\\nChecked.\\n\\n## Probe log\\n\\nNone.\\n\\n## Resolution map\\n\\n| Finding | Suggested edit | Destination plan/section |\\n|---|---|---|\\n');",
        "fs.writeFileSync(process.env.FVS_FAKE_CODEX_LOG, JSON.stringify(args));",
      ].join('\n'));
      fs.chmodSync(fakeCodex, 0o755);

      const logPath = path.join(tmpRoot, 'codex-args.json');
      const run = spawnSync(process.execPath, [
        CODEX_THINK,
        'review',
        '--topic', '.formalising/fv-plans/demo',
        '--iteration', 'n1',
        '--target', 'plan',
        '--effort', 'xhigh',
      ], {
        cwd: project,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
          FVS_FAKE_CODEX_LOG: logPath,
        },
      });
      assert.equal(run.status, 0, `${run.stderr || ''}\n${run.stdout || ''}`);

      const artifact = path.join(reviews, 'PLAN_REVIEW_n1.md');
      assert.ok(fs.existsSync(artifact), 'wrapper did not persist PLAN_REVIEW_n1.md');
      assert.match(fs.readFileSync(artifact, 'utf8'), /VERDICT: APPROVE/);

      const args = JSON.parse(fs.readFileSync(logPath, 'utf8'));
      const sandboxAt = args.indexOf('--sandbox');
      assert.ok(sandboxAt >= 0, 'codex exec missing --sandbox');
      assert.equal(args[sandboxAt + 1], 'read-only', 'reviewer sandbox must be read-only');
      assert.ok(args.includes('--ephemeral'), 'reviewer must be ephemeral');
      assert.ok(args.includes('--output-last-message'), 'review output must be captured');
      assert.ok(!args.includes('--model') && !args.includes('-m'),
        'review helper must not pass a model override');
      const prompt = args[args.length - 1];
      assert.ok(prompt.includes('Source fidelity') &&
        prompt.includes('Statement-level soundness'),
      'specialised adversarial review contract was not included in the prompt');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('fails before invocation or artifact creation when any target lacks provenance', {
    skip: process.platform === 'win32',
  }, () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-review-provenance-test-'));
    try {
      const fakeBin = path.join(tmpRoot, 'bin');
      const project = path.join(tmpRoot, 'project');
      const topic = path.join(project, '.formalising', 'fv-plans', 'demo');
      const plans = path.join(topic, 'plans');
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.mkdirSync(plans, { recursive: true });
      fs.writeFileSync(
        path.join(plans, 'PLAN_n1.md'),
        '# Plan\n\nAuthoring runtime: Claude Code\n'
      );
      fs.writeFileSync(
        path.join(plans, 'EXEC_PLAN_n1.md'),
        '# Executor Plan\n\nNo provenance marker here.\n'
      );

      const fakeCodex = path.join(fakeBin, 'codex');
      fs.writeFileSync(fakeCodex, [
        '#!/usr/bin/env node',
        "'use strict';",
        "const fs = require('node:fs');",
        'const args = process.argv.slice(2);',
        "if (args[0] === '--version') process.exit(0);",
        "if (args[0] === 'login' && args[1] === 'status') process.exit(0);",
        "fs.writeFileSync(process.env.FVS_FAKE_CODEX_LOG, 'invoked');",
      ].join('\n'));
      fs.chmodSync(fakeCodex, 0o755);

      const logPath = path.join(tmpRoot, 'codex-invoked');
      const run = spawnSync(process.execPath, [
        CODEX_THINK,
        'review',
        '--topic', '.formalising/fv-plans/demo',
        '--iteration', 'n1',
        '--target', 'plan',
        '--effort', 'xhigh',
      ], {
        cwd: project,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
          FVS_FAKE_CODEX_LOG: logPath,
        },
      });

      assert.notEqual(run.status, 0, 'review unexpectedly accepted incomplete provenance');
      assert.match(run.stderr, /every review target.*Authoring runtime|independence.*unverified/i);
      assert.ok(!fs.existsSync(logPath), 'Codex was invoked despite incomplete provenance');
      assert.ok(!fs.existsSync(path.join(topic, 'reviews')),
        'review directory was created before provenance validation');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Command-layer path-traversal guard (security): the slug guard must reject
//    `..` and `/` so a topic cannot escape .formalising/fv-plans/ on the
//    single-runtime (non --codex) path, which never goes through
//    fvs-codex-think.mjs.
// ---------------------------------------------------------------------------
for (const key of ['cmdPlan', 'cmdReview', 'cmdExecute', 'cmdEval', 'cmdFollowup']) {
  whenExists(STAGE_FILES[key], `Crypto loop: path-traversal guard in ${rel(STAGE_FILES[key])}`, (content, absPath) => {
    it('rejects a topic containing ".." or "/" (path traversal)', () => {
      assert.match(content, /\*\.\.\*\|\*\/\*|path traversal/,
        `${rel(absPath)} missing a path-traversal (.. or /) rejection in the slug guard`);
    });
  });
}
