#!/usr/bin/env node
'use strict';

// FVS-owned minimal Codex thinker invocation.
//
// This is a small, self-contained wrapper around the `codex` CLI that lets a
// Codex thinker take one of the formalisation-loop thinker stages (plan / eval /
// followup) in place of the in-runtime thinker. It is INSPIRED BY the openai-codex
// plugin's companion script but deliberately depends on NOTHING from it: no import,
// no require, no shared state. The plugin showed the mechanism (an argv-array spawn
// of `codex`, an effort allowlist, a cwd-scoped non-interactive call); this file
// re-implements the minimum FVS needs and owns its own security posture.
//
// Coordination is ARTIFACT-MEDIATED ONLY. The Codex thinker is pointed at a topic
// folder (.formalising/fv-plans/<topic>/), reads the loop's on-disk records, writes
// its stage artifact under plans/ or reviews/, and the process EXITS. There is no
// live cross-process bridge, no kept-alive daemon across stages, and no passed file
// descriptors -- the next stage simply reads the artifact this one wrote.
//
// Security posture (this is the genuinely new surface in the loop):
//   * Spawn is always an ARGV ARRAY -- never a shell string, never { shell: true },
//     never eval. The topic path and the free-form prompt are discrete argv elements
//     (or stdin), so a topic name or prompt can never be interpreted as a shell
//     command. This is the primary argument/shell-injection mitigation.
//   * Effort is EFFORT-ONLY and gated: it is validated against the Codex effort
//     allowlist AND additionally required to be `xhigh` or higher. Anything below
//     xhigh is rejected, never silently downgraded. No --model / -m is ever passed
//     (the FVS effort-only policy: the runtime's configured model is used as-is).
//   * The child cwd is the resolved topic folder ONLY, and only after it is
//     confirmed to be an existing directory whose name carries no shell
//     metacharacters.
//   * If `codex` is not installed, this fails GRACEFULLY with install instructions
//     and a non-zero exit (no stack trace). Single-runtime mode still works without
//     Codex; this helper is an optional add-on.
//   * No `gh ... create` / `gh ... open` is ever invoked, and no absolute clone path
//     is printed or embedded -- everything is resolved relative to the topic folder.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// Effort allowlist mirrored from the inspiration source's set of Codex reasoning
// efforts. FVS additionally REQUIRES the thinker to run at >= xhigh.
const VALID_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
// Ordered weakest -> strongest so we can enforce a floor without hardcoding "only xhigh".
const EFFORT_RANK = Object.fromEntries(VALID_EFFORTS.map((e, i) => [e, i]));
const MIN_EFFORT = 'xhigh';

const STAGES = ['plan', 'eval', 'followup'];

// Shell metacharacters we refuse to see in a resolved topic path. The spawn is an
// argv array so these can never reach a shell, but rejecting them keeps the surface
// obviously safe and matches the path-safety discipline of the loop commands.
const SHELL_METACHARS = /[;|&$`()<>\n\r*?{}\[\]!\\"']/;

function printUsage() {
  // Usage block mirroring the inspiration source's task-subcommand surface.
  console.log(
    [
      'FVS Codex thinker -- a minimal, artifact-mediated Codex invocation for the',
      'crypto formalisation loop. Points a Codex thinker at a topic folder for one',
      'bounded stage (plan | eval | followup), then exits. No live cross-process bridge.',
      '',
      'Usage:',
      '  node scripts/fvs-codex-think.mjs <plan|eval|followup> --topic <dir> [--effort xhigh] [--prompt <text>]',
      '',
      'Arguments:',
      '  <plan|eval|followup>   The thinker stage to run.',
      '  --topic <dir>          The topic folder (.formalising/fv-plans/<topic>/). Becomes the',
      '                         Codex working root; must already exist.',
      '  --effort <level>       Reasoning effort. Allowlist: none|minimal|low|medium|high|xhigh.',
      '                         FVS REQUIRES >= xhigh for the thinker (default: xhigh).',
      '  --prompt <text>        Optional extra instructions, passed to Codex as argv/stdin.',
      '  --help                 Print this usage and exit.',
      '',
      'Policy: effort-only (no --model is ever passed); >= xhigh enforced; argv-array spawn',
      '(never a shell string); cwd = the topic folder; artifact-mediated (the thinker writes',
      'its stage artifact under plans/ or reviews/ and the process exits).',
    ].join('\n'),
  );
}

function fail(msg, code = 1) {
  // Graceful, stack-trace-free failure on the FVS error channel.
  process.stderr.write(`FVS >> ${msg}\n`);
  process.exit(code);
}

// Mirror the fvs-kb-query.py NOT_INSTALLED style: a clear message + install
// guidance + a non-zero exit, never a stack trace, never a silent fallback that
// hides which runtime ran.
function failCodexAbsent(detail) {
  process.stderr.write(
    [
      'FVS >> CODEX NOT AVAILABLE -- the --codex thinker mode needs the codex CLI.',
      detail ? `  detail: ${detail}` : '',
      '  Install the Codex CLI, then re-run with --codex. Without it, the loop still',
      '  runs single-runtime (drop --codex) -- the in-runtime thinker takes the stage.',
      '  Install guidance: https://github.com/openai/codex (npm i -g @openai/codex or',
      '  your platform package), then confirm with: codex --version',
    ]
      .filter(Boolean)
      .join('\n') + '\n',
  );
  process.exit(1);
}

function parseArgs(argv) {
  const out = { stage: null, topic: null, effort: MIN_EFFORT, prompt: null, help: false };
  const rest = [...argv];
  while (rest.length) {
    const tok = rest.shift();
    if (tok === '--help' || tok === '-h') {
      out.help = true;
    } else if (tok === '--topic') {
      out.topic = rest.shift() ?? null;
    } else if (tok === '--effort') {
      out.effort = rest.shift() ?? null;
    } else if (tok === '--prompt') {
      out.prompt = rest.shift() ?? null;
    } else if (tok.startsWith('--')) {
      fail(`unknown flag: ${tok} (try --help)`);
    } else if (out.stage === null) {
      out.stage = tok;
    } else {
      fail(`unexpected argument: ${tok} (try --help)`);
    }
  }
  return out;
}

// Detect the codex binary WITHOUT a shell. spawnSync with an argv array; ENOENT
// means the binary is absent. This is read-only and side-effect-free.
function codexAvailable() {
  const probe = spawnSync('codex', ['--version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
  if (probe.error && probe.error.code === 'ENOENT') {
    return { available: false, detail: 'codex not found on PATH' };
  }
  if (probe.error) {
    return { available: false, detail: probe.error.message };
  }
  if (probe.status !== 0) {
    return { available: false, detail: (probe.stderr || probe.stdout || '').toString().trim() };
  }
  return { available: true, detail: (probe.stdout || '').toString().trim() };
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.stage === null) {
    printUsage();
    // --help is a clean exit; a missing stage is a usage error.
    process.exit(args.help ? 0 : 2);
  }

  // --- Validate the stage ---
  if (!STAGES.includes(args.stage)) {
    fail(`unknown stage "${args.stage}" -- expected one of ${STAGES.join(' | ')}`, 2);
  }

  // --- Validate the effort (allowlist + >= xhigh floor; effort-only) ---
  if (!args.effort || !VALID_EFFORTS.includes(args.effort)) {
    fail(
      `invalid --effort "${args.effort}" -- allowlist is ${VALID_EFFORTS.join('|')}`,
      2,
    );
  }
  if (EFFORT_RANK[args.effort] < EFFORT_RANK[MIN_EFFORT]) {
    // Refuse, do NOT silently downgrade or upgrade -- the thinker tier is a policy floor.
    fail(
      `--effort "${args.effort}" is below the required thinker floor "${MIN_EFFORT}". ` +
        `The Codex thinker must run at >= ${MIN_EFFORT}; rerun with --effort ${MIN_EFFORT}.`,
      2,
    );
  }

  // --- Validate the topic folder (path safety + must exist) ---
  if (!args.topic) {
    fail('missing --topic <dir> (the .formalising/fv-plans/<topic>/ folder)', 2);
  }
  if (SHELL_METACHARS.test(args.topic)) {
    fail('--topic contains shell metacharacters; refusing', 2);
  }
  const topicDir = path.resolve(args.topic);
  let st;
  try {
    st = fs.statSync(topicDir);
  } catch {
    st = null;
  }
  if (!st || !st.isDirectory()) {
    fail(`--topic "${args.topic}" is not an existing directory`, 2);
  }

  // --- Detect codex; graceful fail with install guidance if absent ---
  const avail = codexAvailable();
  if (!avail.available) {
    failCodexAbsent(avail.detail);
  }

  // --- Build the prompt (argv element / stdin, never a shell string) ---
  // The Codex thinker is told to read the topic folder's loop records and write its
  // stage artifact there, then exit. Coordination is purely via those on-disk files.
  const stageArtifact = {
    plan: 'plans/PLAN_nN.md (high-level) + plans/EXEC_PLAN_nN.md (bounded executor plan)',
    eval: 'reviews/EVAL_nN.md (adversarial; exactly one of ACCEPT | FOLLOWUP | HUMAN_RULING | BLOCKED)',
    followup: 'plans/FOLLOWUP_PLAN_nN.md (the next bounded follow-up plan)',
  }[args.stage];

  const basePrompt = [
    `You are the FVS crypto formalisation thinker, ${args.stage} stage.`,
    'Your working root is this topic folder. Read its on-disk loop records under',
    'plans/, reviews/, and sources/, then WRITE your stage artifact:',
    `  ${stageArtifact}`,
    'Coordination is artifact-mediated: write your artifact to disk and EXIT. Do not',
    'attempt any live cross-process bridge, daemon, or kept-alive session. Keep the',
    'public statements immutable, judge any `sorry` as a named obligation (never by',
    'count), and verify builds with `nice -n 19 lake build` (never a bare lake build).',
    args.prompt ? `\nAdditional instructions:\n${args.prompt}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  // codex exec: non-interactive one-shot. Effort via the config override
  // model_reasoning_effort (effort-only: NO -m/--model). Working root via -C.
  // read-only sandbox + skip-git-repo-check so it runs cleanly inside the topic
  // folder. The prompt is a discrete argv element (NOT interpolated into a shell).
  const codexArgs = [
    'exec',
    '-C',
    topicDir,
    '-c',
    `model_reasoning_effort="${args.effort}"`,
    '--sandbox',
    'workspace-write',
    '--skip-git-repo-check',
    basePrompt,
  ];

  const run = spawnSync('codex', codexArgs, {
    cwd: topicDir,
    // Close stdin so codex does not block waiting for piped input; the full prompt
    // is already supplied as an argv element.
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: false,
    windowsHide: true,
  });

  if (run.error) {
    if (run.error.code === 'ENOENT') {
      failCodexAbsent('codex disappeared from PATH between probe and invocation');
    }
    fail(`codex invocation failed: ${run.error.message}`);
  }
  process.exit(run.status ?? 0);
}

main();
