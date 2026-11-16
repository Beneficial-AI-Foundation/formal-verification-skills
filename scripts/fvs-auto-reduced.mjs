#!/usr/bin/env node
// The reduced lane: proof work for a degraded closure plan (no Lean graph, or
// a translation-only identity). Proof acceptance needs the Lean graph, so here
// nothing is ever accepted. The engine itself builds each item's proof file
// with Lean and records one terminal, labelled outcome; the run then moves on
// to the next item and ends with a plain summary.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectInputs, ILEAN_DIR } from './fvs-lean-graph.mjs';
import { toolchain, Refusal } from './fvs-lean-constants.mjs';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const refuse = (message) => { throw new Refusal(message); };

export const LEDGER_DIR = '.formalising/auto-fv/reduced';
const LEDGER = `${LEDGER_DIR}/outcomes.json`;
export const LABELS = {
  built: 'built by Lean, not accepted (reduced)',
  'built-with-sorry': 'built by Lean with sorry, not accepted (reduced)',
  'build-failed': 'Lean build failed, not accepted (reduced)',
  'no-proof': 'no proof produced, not accepted (reduced)',
};
const NOT_ACCEPTED = 'Nothing in this lane is accepted: proof acceptance (freeze, check, accept) needs the Lean graph, so it waits for probe-lean.';

function readPlan(planArg) {
  if (!planArg || !fs.statSync(planArg, { throwIfNoEntry: false })?.isFile()) refuse('--plan must be an existing closure plan file');
  const bytes = fs.readFileSync(planArg);
  let plan;
  try { plan = JSON.parse(bytes.toString('utf8')); } catch { refuse('--plan is not JSON'); }
  if (plan?.schema !== 'fvs-closure-plan/record') refuse('--plan is not a closure plan record');
  if (plan.status !== 'degraded') refuse(`the plan is ${plan.status}, not degraded: use the strict lane (freeze, check, accept)`);
  if (!Array.isArray(plan.degraded?.sourceOrder)) refuse('the degraded plan has no source order');
  return { plan, sha256: sha256(bytes) };
}

function projectRoot(rootArg) {
  if (!rootArg || !fs.statSync(rootArg, { throwIfNoEntry: false })?.isDirectory()) refuse('--project-root must be an existing directory');
  return fs.realpathSync(rootArg);
}

function readLedger(root) {
  const file = path.join(root, LEDGER);
  if (!fs.existsSync(file)) return { schema: 'fvs/auto-reduced-outcomes', version: 1, records: [] };
  const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (ledger.schema !== 'fvs/auto-reduced-outcomes' || ledger.version !== 1 || !Array.isArray(ledger.records)) refuse(`${LEDGER} is not a reduced outcome ledger`);
  return ledger;
}

const publish = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
};

// The latest record of each item for this plan; a later record replaces an earlier one.
function latest(ledger, planSha256) {
  const map = new Map();
  for (const record of ledger.records) if (record.planSha256 === planSha256) map.set(record.defId, record);
  return map;
}

const fileSha = (root, file) => {
  const absolute = path.join(root, file);
  return fs.existsSync(absolute) ? sha256(fs.readFileSync(absolute)) : null;
};

export function next({ projectRoot: rootArg, plan: planArg }) {
  const root = projectRoot(rootArg);
  const { plan, sha256: planSha256 } = readPlan(planArg);
  const recorded = latest(readLedger(root), planSha256);
  const items = plan.degraded.sourceOrder;
  const index = items.findIndex((item) => !recorded.has(item.defId));
  if (index >= 0) {
    return { status: 'item', item: items[index], position: { index: index + 1, total: items.length, recorded: recorded.size },
      lost: plan.degraded.lost, note: `Give this item to one worker, who writes its spec and proof in one Lean file inside the project. Then record it with: record --def-id ${items[index].defId} --lean FILE (or --no-proof REASON). This lane has no spec review. ${NOT_ACCEPTED}` };
  }
  const rows = items.map((item) => {
    const record = recorded.get(item.defId);
    const stale = record.file !== null && fileSha(root, record.file) !== record.fileSha256;
    return { defId: item.defId, rustName: item.rustName, outcome: record.outcome, label: record.label, file: record.file, ...(stale ? { stale: 'the proof file changed after it was recorded' } : {}) };
  });
  const counts = Object.fromEntries(Object.keys(LABELS).map((outcome) => [outcome, rows.filter((row) => row.outcome === outcome).length]));
  const stale = rows.filter((row) => row.stale).length;
  const line = `Reduced run finished: ${items.length} items. ${Object.entries(counts).map(([outcome, n]) => `${LABELS[outcome]}: ${n}`).join('; ')}.${stale ? ` Warning: ${stale} proof files changed after recording (stale).` : ''} ${NOT_ACCEPTED}`;
  return { status: 'summary', planSha256, counts, items: rows, line };
}

// The builder's command: `lake lean FILE` builds the file's imports and
// elaborates it in the project's workspace.
export function record({ projectRoot: rootArg, plan: planArg, defId: defIdArg, lean, noProof, out: outArg, lake: lakeArg }) {
  const root = projectRoot(rootArg);
  const { plan, sha256: planSha256 } = readPlan(planArg);
  const defId = Number(defIdArg);
  const item = plan.degraded.sourceOrder.find((entry) => entry.defId === defId);
  if (!item) refuse(`def_id ${defIdArg} is not an item of this degraded plan`);
  if ((lean === undefined) === (noProof === undefined)) refuse('give exactly one of --lean FILE or --no-proof REASON');
  const git = (args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  const head = git(['rev-parse', 'HEAD']);
  const base = { schema: 'fvs/auto-reduced-outcome', version: 1, planSha256, defId, rustName: item.rustName, commit: head.status === 0 ? head.stdout.trim() : null, recordedAt: new Date().toISOString() };
  let entry;
  if (noProof !== undefined) {
    if (!noProof.trim()) refuse('--no-proof needs a reason');
    entry = { ...base, outcome: 'no-proof', label: LABELS['no-proof'], reason: noProof, file: null, fileSha256: null };
  } else {
    if (path.isAbsolute(lean) || !lean.endsWith('.lean') || path.normalize(lean).split(path.sep).includes('..')) refuse('--lean must be a .lean file path relative to the project root');
    const file = path.normalize(lean);
    const absolute = path.join(root, file);
    if (!fs.statSync(absolute, { throwIfNoEntry: false })?.isFile() || !fs.realpathSync(absolute).startsWith(`${root}${path.sep}`)) refuse(`no proof file at ${file} inside the project`);
    if (!outArg) refuse('--out (a new scratch directory outside the project, for the build log) is required');
    const out = path.join(fs.realpathSync(path.dirname(path.resolve(outArg))), path.basename(outArg));
    if (out === root || out.startsWith(`${root}${path.sep}`)) refuse('--out must be outside the project');
    if (fs.existsSync(out)) refuse('--out must be a new directory');
    const tools = toolchain(root, lakeArg);
    const sources = (inputs) => Object.fromEntries(Object.entries(inputs).filter(([name]) => !name.startsWith(`${ILEAN_DIR}/`)));
    const before = sources(projectInputs(root));
    fs.mkdirSync(out);
    const log = path.join(out, 'build.log');
    const fd = fs.openSync(log, 'wx');
    const argv = [tools.lake, 'lean', file];
    let result;
    try { result = spawnSync(argv[0], argv.slice(1), { cwd: root, stdio: ['ignore', fd, fd], env: { ...process.env, LEAN_NUM_THREADS: '2' } }); } finally { fs.closeSync(fd); }
    if (result.error) refuse(`lake lean: ${result.error.message}`);
    const after = sources(projectInputs(root));
    const warnings = [];
    // Lake writes lake-manifest.json on a project's first build; that is its own output, not a user edit.
    if (before['lake-manifest.json'] === undefined && after['lake-manifest.json'] !== undefined) {
      warnings.push(`Lake created lake-manifest.json during the build (sha256 ${after['lake-manifest.json']})`);
      delete after['lake-manifest.json'];
    }
    const touched = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((name) => before[name] !== after[name]).sort();
    // The label claims a build of these exact bytes, so a change during the build voids the claim.
    if (touched.length > 0) refuse(`the project files changed during the build (only build outputs under .lake may change): ${touched.join(', ')}`);
    const text = fs.readFileSync(log);
    const logSha256 = sha256(text);
    const kept = path.join(root, LEDGER_DIR, 'logs', `${logSha256}.log`);
    fs.mkdirSync(path.dirname(kept), { recursive: true });
    if (!fs.existsSync(kept)) fs.copyFileSync(log, kept);
    const outcome = result.status !== 0 ? 'build-failed' : /declaration uses ['`]sorry['`]/.test(text.toString('utf8')) ? 'built-with-sorry' : 'built';
    const dirty = git(['status', '--porcelain', '--', file]);
    entry = { ...base, outcome, label: LABELS[outcome], file, fileSha256: before[file] ?? sha256(fs.readFileSync(absolute)),
      fileCommitted: head.status === 0 && dirty.status === 0 && dirty.stdout.trim() === '',
      build: { argv, exitCode: result.status, signal: result.signal ?? null, toolchain: tools.name, leanSha256: sha256(fs.readFileSync(tools.lean)), lakeSha256: sha256(fs.readFileSync(tools.lake)),
        log: `${LEDGER_DIR}/logs/${logSha256}.log`, logSha256 }, warnings };
  }
  const ledger = readLedger(root);
  ledger.records.push(entry);
  publish(path.join(root, LEDGER), `${JSON.stringify(ledger, null, 1)}\n`);
  return entry;
}

function usage() {
  process.stdout.write([
    'Usage: node fvs-auto-reduced.mjs next --project-root DIR --plan FILE',
    '       node fvs-auto-reduced.mjs record --project-root DIR --plan FILE --def-id N (--lean FILE --out DIR [--lake FILE] | --no-proof REASON)',
    '',
    'The reduced lane for a degraded closure plan. next prints the next item without an outcome, or the',
    'final summary. record builds FILE (relative to the project root) with `lake lean` and records one',
    `outcome in ${LEDGER}: ${Object.values(LABELS).join('; ')}.`,
    NOT_ACCEPTED,
    'Exit: 0 printed or recorded; 1 refused; 2 usage.',
    '',
  ].join('\n'));
}

function main(argv) {
  const command = argv[0];
  if (!['next', 'record'].includes(command)) { usage(); return ['--help', '-h'].includes(command) ? 0 : 2; }
  const known = { 'project-root': 'projectRoot', plan: 'plan', 'def-id': 'defId', lean: 'lean', 'no-proof': 'noProof', out: 'out', lake: 'lake' };
  const flags = {};
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]?.startsWith('--') ? known[argv[index].slice(2)] : undefined;
    if (!name || argv[index + 1] === undefined || Object.hasOwn(flags, name)) { usage(); return 2; }
    flags[name] = argv[index + 1];
  }
  try {
    process.stdout.write(`${JSON.stringify(command === 'next' ? next(flags) : record(flags), null, 1)}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    process.stderr.write(`refused: ${error.message}\n`);
    return 1;
  }
}

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) process.exitCode = main(process.argv.slice(2));
