#!/usr/bin/env node
// Drafts the auto-track initial-scope agreement for the owner to approve.
//
// It reads the recorded state for the choices, generation and schema version (so they are never retyped),
// builds the agreement envelope, computes the approval digest with the engine's own function, checks the
// result against the engine's record rules on a scratch copy, and prints the roadmap fence plus the one
// command only the owner runs. It never records the agreement, never edits the roadmap or the state, and
// reads no standard input. It is a drafting aid, not part of the checker's frozen engine files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agreementPayloadSha256, readState, recordAgreement, Refusal } from './fvs-auto.mjs';

const STATE_FILE = '.formalising/auto-fv/state.json';
const ROADMAP_FILE = '.formalising/auto-fv/ROADMAP.md';
const ENGINE = fileURLToPath(new URL('./fvs-auto.mjs', import.meta.url));
const INPUT_FIELDS = ['contextVersion', 'boundaries', 'conventions', 'layout', 'claims', 'trust', 'acceptance', 'ownerReserved', 'execution', 'draftPr', 'ownerEvidence'];

const USAGE = [
  'Usage: node fvs-auto-agreement.mjs --input DRAFT.json [--project-root DIR] [--out AGREEMENT.json]',
  '',
  'DRAFT.json holds the owner-visible fields: layout (single-crate or monorepo); claims, trust, acceptance and',
  'ownerReserved (each a list with at least one entry); boundaries and conventions (lists); execution and draftPr',
  '(null, or the objects the engine documents); contextVersion (optional, defaults to the next free number).',
  'The choices, generation and schema version come from the recorded state, not from DRAFT.json.',
  '',
  'Without ownerEvidence the helper prints the payload and its digest for you to show the owner.',
  'With ownerEvidence ({"reference": ..., "response": ...}, the owner\'s own reply word for word) it also',
  'needs --out, writes that new file, and prints the roadmap fence and the owner-run record command.',
  'It never records the agreement and never overwrites a file.',
].join('\n') + '\n';

class UsageError extends Error {}

function parseArguments(argv) {
  const flags = { 'project-root': process.cwd() };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!['--input', '--project-root', '--out'].includes(flag)) throw new UsageError(`unknown argument ${JSON.stringify(flag)}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new UsageError(`${flag} requires a value`);
    flags[flag.slice(2)] = value;
  }
  if (!flags.input) throw new UsageError('--input is required');
  return flags;
}

function readDraft(file) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new UsageError(`cannot read ${file} as JSON: ${error.message}`); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new UsageError('the draft must be a JSON object');
  const unknown = Object.keys(value).filter((key) => !INPUT_FIELDS.includes(key));
  if (unknown.length) throw new UsageError(`unknown draft field(s): ${unknown.join(', ')}; the choices, generation and schema version come from the recorded state`);
  return value;
}

function buildEnvelope(state, draft) {
  const previous = state.agreements?.at(-1);
  const header = { schema: 'fvs/auto-agreement', schemaVersion: state.schemaVersion, mode: 'nonpublic-intent' };
  const payload = {
    choicesGeneration: state.choicesGeneration ?? 0,
    choices: state.choices,
    contextVersion: draft.contextVersion ?? (previous ? previous.payload.contextVersion + 1 : 1),
    boundaries: draft.boundaries ?? [],
    conventions: draft.conventions ?? [],
    layout: draft.layout,
    claims: draft.claims,
    trust: draft.trust,
    acceptance: draft.acceptance,
    ownerReserved: draft.ownerReserved,
    execution: draft.execution ?? null,
    draftPr: draft.draftPr ?? null,
  };
  const withEvidence = (ownerEvidence) => ({ ...header, payload, ownerEvidence, approvedPayloadSha256: agreementPayloadSha256({ ...header, payload }) });
  return { payload, digest: agreementPayloadSha256({ ...header, payload }), withEvidence, previous };
}

// The engine's own record step, run on a scratch copy of the state with the fence in a scratch roadmap, so
// the answer cannot drift from what recording will accept. The real project is never touched.
function checkWithEngine(root, envelope) {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fvs-agreement-draft-'));
  try {
    for (const file of [STATE_FILE, ROADMAP_FILE]) fs.mkdirSync(path.dirname(path.join(scratch, file)), { recursive: true });
    fs.copyFileSync(path.join(root, STATE_FILE), path.join(scratch, STATE_FILE));
    fs.writeFileSync(path.join(scratch, ROADMAP_FILE), `# Draft\n\n## Decisions\n\n${fence(envelope)}\n`);
    return recordAgreement({ projectRoot: scratch, agreement: envelope, confirmOverwrite: true });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

const fence = (envelope) => '```fvs-auto-agreement\n' + JSON.stringify(envelope, null, 2) + '\n```';
// Single quotes are literal in bash, zsh and dash; an embedded quote is closed, escaped and reopened.
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'";

function run(argv) {
  const flags = parseArguments(argv);
  const view = readState({ projectRoot: flags['project-root'] });
  if (view.code === 'no-state') throw new UsageError(`${view.message}; run /fvs:auto-init first`);
  const root = fs.realpathSync(flags['project-root']);
  const draft = readDraft(flags.input);
  const built = buildEnvelope(view.state, draft);
  const checked = built.withEvidence(draft.ownerEvidence ?? { reference: 'scratch-check', response: 'scratch check only; the owner has not replied' });
  const result = checkWithEngine(root, checked);
  const lines = [];
  if (result.code === 'unchanged') lines.push('This exact agreement is already recorded; recording it again changes nothing.');
  lines.push(`Digest (sha256 of the canonical payload): ${built.digest}`,
    `Context version ${built.payload.contextVersion}, choices generation ${built.payload.choicesGeneration}, state schema version ${view.state.schemaVersion}.`,
    'The engine accepts this payload (checked on a scratch copy; nothing was written to the project).', '');
  if (!draft.ownerEvidence) {
    lines.push('Show the owner exactly this payload and ask whether they approve it:', JSON.stringify(built.payload, null, 2), '',
      'Next: when the owner replies, add their reply word for word to the draft as ownerEvidence ({"reference": "where the reply is", "response": "the reply text"}),',
      'then run this helper again with --out. Do not write the reply yourself.');
    return lines.join('\n') + '\n';
  }
  if (!flags.out) throw new UsageError('--out is required once ownerEvidence is present: a new file for the agreement JSON');
  const out = path.resolve(flags.out);
  try { fs.writeFileSync(out, JSON.stringify(checked, null, 2) + '\n', { flag: 'wx' }); }
  catch (error) { throw new UsageError(`cannot create ${out}: ${error.code === 'EEXIST' ? 'it already exists and is never overwritten' : error.message}`); }
  const successor = Boolean(built.previous);
  lines.push(`Agreement written to ${out} (not recorded).`, '',
    `Put this block under "## Decisions" in ${path.join(root, ROADMAP_FILE)} as the only fvs-auto-agreement fence${successor ? ', replacing the recorded one' : ''}:`, fence(checked), '',
    'Owner step (only the owner runs it, in their own terminal; the helper never records the agreement):',
    `node ${quote(ENGINE)} record-agreement --input ${quote(out)} --project-root ${quote(root)}${successor ? ' --confirm-overwrite' : ''}`);
  if (successor) lines.push('This replaces the recorded agreement. Add --confirm-overwrite only after the owner has confirmed this exact payload.');
  return lines.join('\n') + '\n';
}

if (process.argv.includes('--help') || process.argv.includes('-h') || process.argv.length === 2) {
  process.stdout.write(USAGE);
} else {
  try {
    process.stdout.write(run(process.argv.slice(2)));
  } catch (error) {
    if (error instanceof Refusal) {
      process.stderr.write(`Refused (${error.code}): ${error.message}\n`);
      for (const detail of error.details?.errors ?? []) process.stderr.write(`  - ${detail}\n`);
      process.exitCode = 1;
    } else if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
    } else throw error;
  }
}
