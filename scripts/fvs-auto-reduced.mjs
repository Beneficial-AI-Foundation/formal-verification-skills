#!/usr/bin/env node
// The reduced lane: proof work for a degraded closure plan (no Lean graph, or
// a translation-only identity). Proof acceptance needs the Lean graph, so here
// nothing is ever accepted. The engine itself builds each item's proof file
// with Lean, asks Lean which axioms the file's declarations use, and records
// one terminal, labelled outcome; the run then moves on to the next item and
// ends with a plain summary.
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
const STANDARD_AXIOMS = ['propext', 'Classical.choice', 'Quot.sound'];
export const LABELS = {
  built: 'built by Lean, not accepted (reduced)',
  'built-with-axioms': 'built by Lean using axioms beyond propext, Classical.choice and Quot.sound, not accepted (reduced)',
  'built-unaudited': 'built by Lean, axioms not audited, not accepted (reduced)',
  'built-with-sorry': 'built by Lean with sorry, not accepted (reduced)',
  'build-failed': 'Lean build failed, not accepted (reduced)',
  'no-proof': 'no proof produced, not accepted (reduced)',
};
const NOT_ACCEPTED = 'Nothing in this lane is accepted: proof acceptance (freeze, check, accept) needs the Lean graph and the strict lane, so the reduced lane never promises it.';

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

function directory(arg, flag) {
  if (!arg || !fs.statSync(arg, { throwIfNoEntry: false })?.isDirectory()) refuse(`${flag} must be an existing directory`);
  return fs.realpathSync(arg);
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

const fileSha = (absolute) => (fs.existsSync(absolute) ? sha256(fs.readFileSync(absolute)) : null);

export function next({ projectRoot: rootArg, plan: planArg }) {
  const root = directory(rootArg, '--project-root');
  const { plan, sha256: planSha256 } = readPlan(planArg);
  const ledger = readLedger(root);
  const recorded = latest(ledger, planSha256);
  const other = ledger.records.filter((record) => record.planSha256 !== planSha256).length;
  // Outcomes are bound to the plan's bytes: a regenerated plan starts again, and says so.
  const warnings = other > 0 ? [`${other} recorded outcomes belong to another plan (the plan file changed since they were recorded); they do not count for this plan.`] : [];
  const items = plan.degraded.sourceOrder;
  const index = items.findIndex((item) => !recorded.has(item.defId));
  if (index >= 0) {
    return { status: 'item', item: items[index], position: { index: index + 1, total: items.length, recorded: recorded.size },
      lost: plan.degraded.lost, warnings,
      note: `Give this item to one worker, who writes its spec and proof in one Lean file and commits it in its own checkout. Then, from this project root, record it with: record --def-id ${items[index].defId} --lean FILE --worktree WORKER_CHECKOUT --out SCRATCH_DIR (or --no-proof REASON). This lane has no spec review. ${NOT_ACCEPTED}` };
  }
  const rows = items.map((item) => {
    const record = recorded.get(item.defId);
    const stale = record.file !== null && fileSha(path.join(record.source?.worktree ?? root, record.file)) !== record.fileSha256;
    return { defId: item.defId, rustName: item.rustName, outcome: record.outcome, label: record.label, file: record.file,
      ...(record.source ? { worktree: record.source.worktree } : {}), axioms: record.axioms ?? null,
      ...(stale ? { stale: 'the proof file changed or is gone since it was recorded' } : {}) };
  });
  const counts = Object.fromEntries(Object.keys(LABELS).map((outcome) => [outcome, rows.filter((row) => row.outcome === outcome).length]));
  const stale = rows.filter((row) => row.stale).length;
  const line = `Reduced run finished: ${items.length} items. ${Object.entries(counts).filter(([, n]) => n > 0).map(([outcome, n]) => `${LABELS[outcome]}: ${n}`).join('; ')}.${stale ? ` Warning: ${stale} proof files changed after recording (stale).` : ''} ${NOT_ACCEPTED}`;
  return { status: 'summary', planSha256, counts, items: rows, warnings, line };
}

// Appended to a scratch copy of the proof file: every constant the file
// declares and the axioms Lean.collectAxioms reports for it. The canary is a
// sorry the audit must find, or its declaration list is not trusted; the nonce
// keeps the file itself from printing a result.
const auditSource = (text, nonce) => `import Lean ${text}

theorem _root_.fvsReducedCanary_${nonce} : True := sorry

#eval show _root_.Lean.CoreM Unit from do
  let env ← _root_.Lean.getEnv
  let mut rows : Array _root_.Lean.Json := #[]
  for (nm, _) in env.constants.map₂.toList do
    rows := rows.push (_root_.Lean.Json.mkObj [("name", _root_.Lean.toJson nm), ("axioms", _root_.Lean.toJson (← _root_.Lean.collectAxioms nm))])
  _root_.IO.println s!"FVS-REDUCED-AUDIT-${nonce} {(_root_.Lean.Json.arr rows).compress}"
`;

function readAudit(text, nonce) {
  const tag = `FVS-REDUCED-AUDIT-${nonce} `;
  const lines = text.split('\n').filter((line) => line.startsWith(tag));
  const no = (reason) => ({ status: 'not-audited', reason });
  if (lines.length !== 1) return no(`the audit printed ${lines.length} results, not one`);
  let rows;
  try { rows = JSON.parse(lines[0].slice(tag.length)); } catch { return no('the audit result is not JSON'); }
  if (!Array.isArray(rows) || !rows.every((row) => typeof row?.name === 'string' && Array.isArray(row.axioms) && row.axioms.every((a) => typeof a === 'string'))) return no('the audit result is malformed');
  const canary = `fvsReducedCanary_${nonce}`;
  if (!rows.some((row) => row.name === canary && row.axioms.includes('sorryAx'))) return no('the audit missed its own sorry canary, so its list of declarations may be incomplete');
  const own = rows.filter((row) => row.name !== canary);
  return { status: 'audited', declarations: own.length, axioms: [...new Set(own.flatMap((row) => row.axioms))].sort() };
}

// Runs one Lean step with its output in DIR/NAME.log and keeps the log under the ledger, named by its hash.
function leanStep(root, out, name, argv) {
  const log = path.join(out, `${name}.log`);
  const fd = fs.openSync(log, 'wx');
  let result;
  try { result = spawnSync(argv[0], argv.slice(1), { cwd: root, stdio: ['ignore', fd, fd], env: { ...process.env, LEAN_NUM_THREADS: '2' } }); } finally { fs.closeSync(fd); }
  if (result.error) refuse(`${argv.slice(1, 3).join(' ')}: ${result.error.message}`);
  const text = fs.readFileSync(log);
  const logSha256 = sha256(text);
  const kept = path.join(root, LEDGER_DIR, 'logs', `${logSha256}.log`);
  fs.mkdirSync(path.dirname(kept), { recursive: true });
  if (!fs.existsSync(kept)) fs.copyFileSync(log, kept);
  return { text: text.toString('utf8'), evidence: { argv, exitCode: result.status, signal: result.signal ?? null, log: `${LEDGER_DIR}/logs/${logSha256}.log`, logSha256 } };
}

// Builds in the project root, whose .lake holds the built packages, and reads
// the proof file from the worker's checkout (by default the project root).
export function record({ projectRoot: rootArg, plan: planArg, defId: defIdArg, lean, noProof, worktree: worktreeArg, out: outArg, lake: lakeArg }) {
  const root = directory(rootArg, '--project-root');
  const { plan, sha256: planSha256 } = readPlan(planArg);
  const defId = Number(defIdArg);
  const item = plan.degraded.sourceOrder.find((entry) => entry.defId === defId);
  if (!item) refuse(`def_id ${defIdArg} is not an item of this degraded plan`);
  if ((lean === undefined) === (noProof === undefined)) refuse('give exactly one of --lean FILE or --no-proof REASON');
  const git = (dir, args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  const headOf = (dir) => { const head = git(dir, ['rev-parse', 'HEAD']); return head.status === 0 ? head.stdout.trim() : null; };
  const base = { schema: 'fvs/auto-reduced-outcome', version: 1, planSha256, defId, rustName: item.rustName, commit: headOf(root), recordedAt: new Date().toISOString() };
  let entry;
  if (noProof !== undefined) {
    if (!noProof.trim()) refuse('--no-proof needs a reason');
    entry = { ...base, outcome: 'no-proof', label: LABELS['no-proof'], reason: noProof, file: null, fileSha256: null, axioms: null };
  } else {
    const worktree = worktreeArg === undefined ? root : directory(worktreeArg, '--worktree');
    if (path.isAbsolute(lean) || !lean.endsWith('.lean') || path.normalize(lean).split(path.sep).includes('..')) refuse('--lean must be a .lean file path relative to the worker checkout');
    const file = path.normalize(lean);
    const absolute = path.join(worktree, file);
    if (!fs.statSync(absolute, { throwIfNoEntry: false })?.isFile() || !fs.realpathSync(absolute).startsWith(`${worktree}${path.sep}`)) refuse(`no proof file at ${file} inside ${worktree}`);
    if (!outArg) refuse('--out (a new scratch directory outside the project, for the build log) is required');
    const out = path.join(fs.realpathSync(path.dirname(path.resolve(outArg))), path.basename(outArg));
    if (out === root || out.startsWith(`${root}${path.sep}`)) refuse('--out must be outside the project');
    if (fs.existsSync(out)) refuse('--out must be a new directory');
    const tools = toolchain(root, lakeArg);
    const sources = (inputs) => Object.fromEntries(Object.entries(inputs).filter(([name]) => !name.startsWith(`${ILEAN_DIR}/`)));
    const before = sources(projectInputs(root));
    const bytes = fs.readFileSync(absolute);
    fs.mkdirSync(out);
    // `lake lean FILE` builds the file's imports and elaborates it in the project's workspace.
    const build = leanStep(root, out, 'build', [tools.lake, 'lean', worktree === root ? file : absolute]);
    let audit = null;
    if (build.evidence.exitCode === 0) {
      const nonce = crypto.randomBytes(16).toString('hex');
      const auditFile = path.join(out, 'audit.lean');
      fs.writeFileSync(auditFile, auditSource(bytes.toString('utf8'), nonce));
      const run = leanStep(root, out, 'audit', [tools.lake, 'env', 'lean', '--threads=2', auditFile]);
      audit = { ...readAudit(run.text, nonce), ...run.evidence };
    }
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
    if (fileSha(absolute) !== sha256(bytes)) refuse(`${file} changed during the build`);
    // Lean's own sorry warning and the audit must agree, or the audit is not trusted.
    const sorryWarning = /declaration uses ['`]sorry['`]/.test(build.text);
    if (audit?.status === 'audited' && sorryWarning && !audit.axioms.includes('sorryAx')) audit = { ...audit, status: 'not-audited', reason: 'Lean warned about sorry but the audit found no sorryAx' };
    const audited = audit?.status === 'audited';
    const outcome = build.evidence.exitCode !== 0 ? 'build-failed'
      : sorryWarning || (audited && audit.axioms.includes('sorryAx')) ? 'built-with-sorry'
        : !audited ? 'built-unaudited'
          : audit.axioms.some((axiom) => !STANDARD_AXIOMS.includes(axiom)) ? 'built-with-axioms' : 'built';
    const dirty = git(worktree, ['status', '--porcelain', '--', file]);
    const sourceHead = headOf(worktree);
    entry = { ...base, ...(worktree === root ? {} : { source: { worktree, commit: sourceHead } }),
      outcome, label: LABELS[outcome], file, fileSha256: sha256(bytes),
      fileCommitted: sourceHead !== null && dirty.status === 0 && dirty.stdout.trim() === '',
      axioms: audited ? audit.axioms : null,
      build: { ...build.evidence, toolchain: tools.name, leanSha256: sha256(fs.readFileSync(tools.lean)), lakeSha256: sha256(fs.readFileSync(tools.lake)) },
      audit, warnings };
  }
  const ledger = readLedger(root);
  ledger.records.push(entry);
  publish(path.join(root, LEDGER), `${JSON.stringify(ledger, null, 1)}\n`);
  return entry;
}

function usage() {
  process.stdout.write([
    'Usage: node fvs-auto-reduced.mjs next --project-root DIR --plan FILE',
    '       node fvs-auto-reduced.mjs record --project-root DIR --plan FILE --def-id N',
    '            (--lean FILE [--worktree DIR] --out DIR [--lake FILE] | --no-proof REASON)',
    '',
    'The reduced lane for a degraded closure plan. next prints the next item without an outcome, or the',
    'final summary. record builds FILE (relative to --worktree, the worker\'s checkout; by default the',
    'project root) with `lake lean` in the project root, asks Lean which axioms its declarations use, and',
    `records one outcome in ${LEDGER}: ${Object.values(LABELS).join('; ')}.`,
    NOT_ACCEPTED,
    'Exit: 0 printed or recorded; 1 refused; 2 usage.',
    '',
  ].join('\n'));
}

function main(argv) {
  const command = argv[0];
  if (!['next', 'record'].includes(command)) { usage(); return ['--help', '-h'].includes(command) ? 0 : 2; }
  const known = { 'project-root': 'projectRoot', plan: 'plan', 'def-id': 'defId', lean: 'lean', 'no-proof': 'noProof', worktree: 'worktree', out: 'out', lake: 'lake' };
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
