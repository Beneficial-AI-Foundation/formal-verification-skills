// Coordinator checkpoint metadata. No dispatch, backend, or Git runs on import.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { memoryDataSnapshot, memoryHash, MEMORY_LIMITS } from './fvs-project-memory.mjs';
import { duplicateKeys } from './fvs-lean-graph.mjs';

const SHA = /^[0-9a-f]{64}$/, COMMIT = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAGES = ['extraction', 'specification', 'review', 'proof', 'check', 'integration', 'acceptance', 'reconcile'];
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
const text = (v) => typeof v === 'string' && v.trim() !== '';
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const matches = (v, re) => typeof v === 'string' && re.test(v);
const same = (a, b) => memoryHash(a) === memoryHash(b);
const snapshot = (v) => JSON.parse(JSON.stringify(memoryDataSnapshot(v)));
export class ResumeError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
const stop = (code, message, details) => { throw new ResumeError(code, message, details); };
function closed(v, keys, label) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some((k) => !Object.hasOwn(v, k))) stop('resume-invalid-input', 'invalid closed ' + label);
}
function parse(bytes) {
  try {
    const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (duplicateKeys(s).length) throw new Error('duplicate keys');
    return snapshot(JSON.parse(s));
  } catch (e) { stop('resume-invalid-input', 'invalid complete JSON data: ' + e.message); }
}
export const parseResumeRequest = (bytes) => validateRequest(parse(bytes));
function implementation() {
  return Object.fromEntries(['fvs-auto-resume.mjs', 'fvs-auto.mjs', 'fvs-project-memory.mjs', 'fvs-checker-auto.mjs'].map((name) => {
    const file = fileURLToPath(new URL(name, import.meta.url)); return [file, hash(bytes(file))];
  }));
}
function bytes(file) {
  if (!text(file) || !path.isAbsolute(file) || fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()) stop('resume-evidence-invalid', 'expected a canonical regular file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
}
function boundBytes(ref) {
  closed(ref, ['file', 'sha256'], 'evidence reference');
  if (!matches(ref.sha256, SHA)) stop('resume-evidence-invalid', 'invalid evidence digest');
  const b = bytes(ref.file);
  if (hash(b) !== ref.sha256) stop('resume-evidence-invalid', 'evidence bytes changed: ' + ref.file);
  return b;
}
const bound = (ref) => parse(boundBytes(ref));
function save(out, name, value) {
  const file = path.join(out, name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  return { file, sha256: hash(bytes(file)) };
}
function directory(p) {
  if (fs.realpathSync(p) !== p || !fs.lstatSync(p).isDirectory()) stop('resume-path-invalid', 'expected a canonical directory: ' + p);
  return p;
}
function ownOutput(out, root) {
  if (!text(out) || !path.isAbsolute(out) || path.join(fs.realpathSync(path.dirname(out)), path.basename(out)) !== out
    || out === root || out.startsWith(root + path.sep)) stop('resume-path-invalid', 'exclusive output must be canonical and outside the protected project');
  fs.mkdirSync(out, { mode: 0o700 });
  fs.mkdirSync(path.join(out, 'receipts')); return out;
}
function runtimeDir(root, create = false) {
  let p = directory(root);
  for (const name of ['.formalising', 'auto-fv', 'resume']) {
    p = path.join(p, name);
    if (!fs.existsSync(p)) { if (!create) return null; fs.mkdirSync(p); }
    directory(p);
  }
  return p;
}
const runKeys = ['runId', 'canonicalRoot', 'gitCommonDir', 'aoProjectId', 'aoStateHome', 'coordinatorSessionId', 'choicesGeneration', 'agreementContextSha256', 'scope', 'limits', 'startedAtMs', 'deadlineMs'];
function runValid(run) {
  closed(run, runKeys, 'runtime run');
  if (!matches(run.runId, UUID) || ![run.canonicalRoot, run.gitCommonDir, run.aoStateHome].every((p) => text(p) && path.isAbsolute(p))
    || ![run.aoProjectId, run.coordinatorSessionId, run.scope].every(text) || !integer(run.choicesGeneration) || !matches(run.agreementContextSha256, SHA)
    || !integer(run.startedAtMs) || !integer(run.deadlineMs)) stop('resume-history-invalid', 'invalid run binding');
  closed(run.limits, ['workers', 'nodeHours', 'wallClockHours'], 'original limits');
  if (!Number.isSafeInteger(run.limits.workers) || run.limits.workers < 1 || !(typeof run.limits.nodeHours === 'number' && run.limits.nodeHours > 0) || !(typeof run.limits.wallClockHours === 'number' && run.limits.wallClockHours > 0)
    || run.deadlineMs !== Math.floor(run.startedAtMs + run.limits.wallClockHours * 3600000)) stop('resume-history-invalid', 'invalid original limits/deadline');
}
function intentValid(t) {
  closed(t, ['transitionId', 'reservationId', 'stage', 'nodes', 'owner', 'effect'], 'transition intent');
  if (![t.transitionId, t.reservationId].every((v) => matches(v, UUID)) || !STAGES.includes(t.stage) || !text(t.owner)
    || !Array.isArray(t.nodes) || t.nodes.some((n, i) => !integer(n) || (i && n <= t.nodes[i - 1]))) stop('resume-invalid-input', 'invalid transition identity/nodes');
  const e = t.effect;
  if (e?.kind === 'ao-launch') {
    closed(e, ['kind', 'projectId', 'intendedBranchRef', 'assignmentId', 'sessionId'], 'launch effect');
    if (!text(e.projectId) || !/^refs\/heads\/[A-Za-z0-9/_-]+$/.test(e.intendedBranchRef ?? '') || !matches(e.assignmentId, UUID) || e.sessionId !== null || !t.nodes.length) stop('resume-invalid-input', 'launch needs an explicit branch/assignment and null future session');
  } else if (e?.kind === 'local') {
    closed(e, ['kind', 'operation'], 'local effect');
    if (e.operation !== t.stage) stop('resume-invalid-input', 'local operation must match its stage');
  } else if (e?.kind === 'reservation-resolution') {
    closed(e, ['kind', 'targetReservationId'], 'resolution effect');
    if (t.stage !== 'reconcile' || !matches(e.targetReservationId, UUID)) stop('resume-invalid-input', 'invalid resolution target');
  } else stop('resume-invalid-input', 'unsupported effect discriminator');
}
function eventValid(e) {
  closed(e, ['seq', 'prev', 'runSha256', 'observedAtMs', 'attemptId', 'position', 'intent', 'beforeEventSha256', 'outcome', 'effect', 'observation'], 'checkpoint event');
  if (!integer(e.seq) || !(e.prev === null || matches(e.prev, SHA)) || !matches(e.runSha256, SHA) || !integer(e.observedAtMs) || !matches(e.attemptId, UUID)) stop('resume-history-invalid', 'invalid event binding');
  intentValid(e.intent);
  if (e.position === 'before') {
    if (e.beforeEventSha256 !== null || e.outcome !== null || e.effect !== null) stop('resume-history-invalid', 'before cannot claim an effect');
  } else if (e.position === 'after') {
    if (!matches(e.beforeEventSha256, SHA) || !['succeeded', 'failed', 'uncertain'].includes(e.outcome)) stop('resume-history-invalid', 'invalid paired after');
    closed(e.effect, ['sessionId', 'association', 'evidence', 'resolution'], 'actual effect');
    if (!(e.effect.sessionId === null || text(e.effect.sessionId)) || !Array.isArray(e.effect.evidence)) stop('resume-history-invalid', 'invalid actual effect');
  } else stop('resume-history-invalid', 'invalid event position');
  closed(e.observation, ['identity', 'inputs', 'memory', 'ao', 'associations', 'acceptance', 'reasons', 'receipts'], 'observation');
}
// Derive reservations from verified events, never a caller's stored status/count.
function replay(history, run) {
  const transitions = new Map(), reservations = new Map(); let prev = null, time = run.startedAtMs;
  for (const [index, row] of history.entries()) {
    closed(row, ['event', 'sha256'], 'history row'); const e = row.event; eventValid(e);
    if (row.sha256 !== memoryHash(e) || e.seq !== index || e.prev !== prev || e.runSha256 !== memoryHash(run) || e.observedAtMs < time) stop('resume-history-invalid', 'history chain/time mismatch');
    time = e.observedAtMs; prev = row.sha256;
    const id = e.intent.transitionId, rId = e.intent.reservationId, old = transitions.get(id);
    if (e.position === 'before') {
      if (old || reservations.has(rId)) stop('resume-history-invalid', 'duplicate transition/reservation');
      const resolving = e.intent.effect.kind === 'reservation-resolution' ? e.intent.effect.targetReservationId : null;
      for (const r of reservations.values()) if (r.state !== 'closed' && r.id !== resolving && e.intent.nodes.some((n) => r.intent.nodes.includes(n))) stop('resume-reservation-conflict', 'node already reserved');
      const held = [...reservations.values()].filter((r) => r.state !== 'closed' && r.intent.effect.kind === 'ao-launch');
      const liveUnreserved = e.observation.associations.filter((a) => a.value.scopeRelation === 'run-assignment' && e.observation.ao.some((s) => s.id === a.value.sessionId && !s.isTerminated) && !held.some((r) => r.sessionId === a.value.sessionId));
      if (e.intent.effect.kind === 'ao-launch' && liveUnreserved.some((a) => a.value.nodes.some((n) => e.intent.nodes.includes(n)))) stop('resume-reservation-conflict', 'a live associated assignment already owns this node');
      const active = held.length + liveUnreserved.length;
      if (e.intent.effect.kind === 'ao-launch' && active >= run.limits.workers) stop('resume-capacity-exhausted', 'original worker capacity is reserved');
      const r = { id: rId, intent: e.intent, before: row.sha256, state: 'pending', sessionId: null, after: null };
      reservations.set(rId, r); transitions.set(id, r);
    } else {
      if (!old || old.after || e.beforeEventSha256 !== old.before || !same(e.intent, old.intent)) stop('resume-pair-conflict', 'orphan/conflicting after-event');
      for (const ref of e.effect.evidence) boundBytes(ref);
      if (e.intent.effect.kind === 'ao-launch') {
        if (e.outcome === 'succeeded') {
          if (!text(e.effect.sessionId) || !e.effect.association || e.effect.resolution !== null) stop('resume-pair-conflict', 'launch success needs actual association');
          const a = association(e.effect.association, run);
          if (a.sessionId !== e.effect.sessionId || a.reservationId !== rId || a.assignmentId !== e.intent.effect.assignmentId || a.worktree.branchRef !== e.intent.effect.intendedBranchRef || a.provenance.kind !== 'controller-launch'
            || a.provenance.beforeEventSha256 !== old.before || a.owner !== e.intent.owner || !same(a.nodes, e.intent.nodes) || a.scopeRelation !== 'run-assignment') stop('resume-pair-conflict', 'launch association lost its exact intent');
          old.state = 'active'; old.sessionId = a.sessionId;
        } else {
          if (e.effect.sessionId !== null || e.effect.association !== null || e.effect.resolution !== null) stop('resume-pair-conflict', 'unconfirmed launch cannot bind a success');
          old.state = 'uncertain';
        }
      } else if (e.intent.effect.kind === 'reservation-resolution') {
        const target = reservations.get(e.intent.effect.targetReservationId), resolution = e.effect.resolution;
        if (!target || target.state === 'closed' || e.outcome !== 'succeeded' || e.effect.sessionId !== null || e.effect.association !== null) stop('resume-pair-conflict', 'invalid reservation resolution');
        closed(resolution, ['reason', 'evidence'], 'resolution'); const proof = bound(resolution.evidence);
        if (resolution.reason === 'not-invoked') {
          closed(proof, ['schema', 'schemaVersion', 'runId', 'reservationId', 'controllerSessionId', 'effectInvoked'], 'controller no-effect evidence');
          if (proof.schema !== 'fvs/auto-effect-not-invoked' || proof.schemaVersion !== 1 || proof.runId !== run.runId || proof.reservationId !== target.id || proof.controllerSessionId !== run.coordinatorSessionId || proof.effectInvoked !== false || target.sessionId !== null) stop('resume-pair-conflict', 'unproven no-effect resolution');
        } else if (resolution.reason === 'session-terminated') {
          const observed = proof.session;
          if (!target.sessionId || observed?.id !== target.sessionId || observed.projectId !== run.aoProjectId || observed.isTerminated !== true
            || !e.observation.ao.some((s) => s.id === observed.id && s.isTerminated)) stop('resume-pair-conflict', 'missing current matched termination');
        } else stop('resume-pair-conflict', 'unsupported resolution evidence');
        target.state = 'closed'; old.state = 'closed';
      } else {
        if (e.effect.sessionId !== null || e.effect.association !== null || e.effect.resolution !== null) stop('resume-pair-conflict', 'local effect cannot claim a launch');
        old.state = e.outcome === 'uncertain' ? 'uncertain' : 'closed';
      }
      old.after = row.sha256;
    }
  }
  return { transitions, reservations, headSha256: prev, lastObservedAtMs: time };
}
export function readRuntime(root, { ignoreLock = false } = {}) {
  const dir = runtimeDir(root);
  if (!dir) return { state: null, headSha256: null, transitions: new Map(), reservations: new Map(), lastObservedAtMs: null };
  if ((!ignoreLock && fs.existsSync(path.join(dir, 'lock'))) || fs.readdirSync(dir).some((n) => n.startsWith('.tmp-'))) stop('resume-pending', 'runtime is pending; preserve lock/temporary evidence');
  const file = path.join(dir, 'state.json');
  if (!fs.existsSync(file)) return { state: null, headSha256: null, transitions: new Map(), reservations: new Map(), lastObservedAtMs: null };
  const b = bytes(file); if (b.length > MEMORY_LIMITS.maxBytes) stop('resume-history-invalid', 'runtime history exceeds supported metadata size');
  const state = parse(b); closed(state, ['schema', 'schemaVersion', 'run', 'history'], 'runtime state');
  if (state.schema !== 'fvs/auto-runtime' || state.schemaVersion !== 1 || !Array.isArray(state.history) || !state.history.length) stop('resume-history-invalid', 'unsupported runtime state');
  runValid(state.run); const view = replay(state.history, state.run);
  if (!ignoreLock && fs.existsSync(path.join(dir, 'lock'))) stop('resume-pending', 'runtime lock appeared');
  return { state, fileSha256: hash(b), ...view };
}

function validateRequest(raw) {
  const q = snapshot(raw);
  closed(q, ['schema', 'schemaVersion', 'attemptId', 'runId', 'phase', 'resumeId', 'ao', 'expectedHeadSha256', 'source', 'inputs', 'associations', 'priorAccounting', 'memoryRequest', 'transition'], 'resume request');
  closed(q.ao, ['tool', 'stateHome', 'projectId', 'coordinatorSessionId'], 'AO request'); closed(q.ao.tool, ['file', 'sha256'], 'AO tool');
  closed(q.source, ['kind', 'root', 'commit', 'expectedTree'], 'integration source');
  closed(q.inputs, ['extraction', 'graph', 'plan', 'baseline', 'acceptedStore'], 'stage inputs');
  if (q.schema !== 'fvs/auto-resume-request' || q.schemaVersion !== 1 || ![q.attemptId, q.runId].every((v) => matches(v, UUID)) || !['start', 'resume'].includes(q.phase)
    || (q.phase === 'start' ? q.resumeId !== null : !matches(q.resumeId, UUID)) || !(q.expectedHeadSha256 === null || matches(q.expectedHeadSha256, SHA))
    || !text(q.ao.projectId) || !text(q.ao.coordinatorSessionId) || !matches(q.ao.tool.sha256, SHA) || q.source.kind !== 'git' || !matches(q.source.commit, COMMIT) || !matches(q.source.expectedTree, COMMIT)
    || !Array.isArray(q.associations)) stop('resume-invalid-input', 'invalid resume identity/source');
  try { directory(q.ao.stateHome); directory(path.join(q.ao.stateHome, '.ao')); }
  catch { stop('resume-ao-state-required', 'select an existing canonical HOME/.ao controller profile; this adapter does not initialize one'); }
  for (const k of ['extraction', 'graph', 'plan', 'baseline']) if (q.inputs[k] !== null) bound(q.inputs[k]);
  if (q.inputs.acceptedStore !== null) {
    closed(q.inputs.acceptedStore, ['root', 'expectedHeadSha256'], 'accepted store');
    if (!path.isAbsolute(q.inputs.acceptedStore.root ?? '') || !(q.inputs.acceptedStore.expectedHeadSha256 === null || matches(q.inputs.acceptedStore.expectedHeadSha256, SHA))) stop('resume-invalid-input', 'invalid accepted store');
  }
  if (q.priorAccounting !== null) bound(q.priorAccounting);
  const m = q.memoryRequest;
  if (!m || m.attemptId !== q.attemptId || m.phase !== q.phase || m.operation !== 'coordinator-refresh' || m.target?.projectId !== q.ao.projectId || m.target.sessionId !== q.ao.coordinatorSessionId || m.target.resumeId !== q.resumeId) stop('resume-memory-mismatch', 'independently prepared memory request must bind this exact caller/phase');
  if (q.transition !== null) {
    closed(q.transition, ['position', 'intent', 'beforeEventSha256', 'outcome', 'effect'], 'checkpoint transition');
    intentValid(q.transition.intent);
    if (q.transition.intent.effect.kind === 'ao-launch' && q.transition.intent.effect.projectId !== q.ao.projectId) stop('resume-invalid-input', 'foreign launch project');
    if (q.transition.position === 'before') {
      if (q.transition.beforeEventSha256 !== null || q.transition.outcome !== null || q.transition.effect !== null) stop('resume-invalid-input', 'before has an actual effect');
    } else if (q.transition.position !== 'after') stop('resume-invalid-input', 'invalid checkpoint position');
  }
  return q;
}
function runner(out, q) {
  const refs = [];
  function run(tool, args, cwd, ao = false) {
    const toolBefore = hash(bytes(tool));
    if (ao && toolBefore !== q.ao.tool.sha256) stop('resume-tool-changed', 'AO tool identity changed');
    const env = { PATH: '/usr/bin:/bin', ...(ao ? { HOME: q.ao.stateHome } : {}), LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' };
    // AO is the installed local controller CLI. No caller URL/provider credentials are forwarded.
    const startedAtMs = Date.now(), p = spawnSync(tool, args, { cwd, env, timeout: MEMORY_LIMITS.timeoutMs, maxBuffer: MEMORY_LIMITS.maxBytes });
    const endedAtMs = Date.now(), n = String(refs.length + 1).padStart(4, '0'), stdout = p.stdout ?? Buffer.alloc(0), stderr = p.stderr ?? Buffer.alloc(0);
    const stream = (suffix, b) => { const file = path.join(out, 'receipts', n + suffix); fs.writeFileSync(file, b, { flag: 'wx' }); return { file, sha256: hash(b) }; };
    const receipt = save(out, 'receipts/' + n + '.json', { attemptId: q.attemptId, requestSha256: memoryHash(q), argv: [tool, ...args], cwd, env,
      startedAtMs, endedAtMs, toolBefore, toolAfter: hash(bytes(tool)), exitCode: p.status, signal: p.signal, error: p.error?.code ?? null,
      stdout: stream('.stdout', stdout), stderr: stream('.stderr', stderr) });
    refs.push(receipt);
    if (p.error || p.status !== 0 || p.signal || hash(bytes(tool)) !== toolBefore) stop('resume-command-failed', 'bounded local metadata observation failed', { receipt });
    return stdout;
  }
  return { run, refs };
}
function git(root, r) {
  directory(root);
  const call = (...args) => r.run('/usr/bin/git', ['-C', root, ...args], root).toString('utf8').trim();
  if (call('rev-parse', '--is-bare-repository') !== 'false') stop('resume-project-mismatch', 'non-bare Git required');
  const gitDir = fs.realpathSync(path.resolve(root, call('rev-parse', '--git-dir'))), common = fs.realpathSync(path.resolve(root, call('rev-parse', '--git-common-dir')));
  return { root, gitDir, gitCommonDir: common, branchRef: call('symbolic-ref', '-q', 'HEAD'), commit: call('rev-parse', '--verify', 'HEAD'), tree: call('rev-parse', '--verify', 'HEAD^{tree}'), dirty: call('status', '--porcelain=v1', '--untracked-files=all') !== '', worktrees: call('worktree', 'list', '--porcelain') };
}
function association(ref, run) {
  const a = bound(ref);
  closed(a, ['schema', 'schemaVersion', 'runId', 'assignmentId', 'reservationId', 'projectId', 'sessionId', 'scopeRelation', 'nodes', 'owner', 'controllerSessionId', 'worktree', 'provenance', 'rulesProfile'], 'controller association');
  closed(a.worktree, ['path', 'gitDir', 'gitCommonDir', 'branchRef', 'commit', 'tree'], 'association worktree');
  closed(a.provenance, ['kind', 'beforeEventSha256', 'evidence'], 'controller provenance');
  if (a.schema !== 'fvs/auto-session-association' || a.schemaVersion !== 1 || a.runId !== run.runId || a.projectId !== run.aoProjectId || a.controllerSessionId !== run.coordinatorSessionId
    || ![a.assignmentId, a.reservationId].every((v) => matches(v, UUID)) || !text(a.sessionId) || !text(a.owner) || !['run-assignment', 'unrelated-work'].includes(a.scopeRelation)
    || !Array.isArray(a.nodes) || a.nodes.some((n) => !integer(n)) || (a.scopeRelation === 'unrelated-work' && a.nodes.length)
    || !['controller-launch', 'controller-existing-assignment'].includes(a.provenance.kind) || !Array.isArray(a.provenance.evidence) || !a.provenance.evidence.length
    || (a.provenance.kind === 'controller-launch' ? !matches(a.provenance.beforeEventSha256, SHA) : a.provenance.beforeEventSha256 !== null)
    || !matches(a.worktree.commit, COMMIT) || !matches(a.worktree.tree, COMMIT) || !text(a.worktree.branchRef)) stop('resume-association-invalid', 'invalid retained controller association');
  for (const evidence of a.provenance.evidence) boundBytes(evidence);
  if (a.rulesProfile !== null) {
    closed(a.rulesProfile, ['provenance', 'evidence'], 'rules/profile observation');
    if (a.rulesProfile.provenance !== 'retained-controller-observation' || !Array.isArray(a.rulesProfile.evidence)) stop('resume-association-invalid', 'no AO effective-profile attestation is available');
    for (const evidence of a.rulesProfile.evidence) boundBytes(evidence);
  }
  return a;
}
function lifecycle(s, kind) {
  if (!s || !text(s.id) || !text(s.projectId) || !['worker', 'orchestrator'].includes(s[kind]) || typeof s.isTerminated !== 'boolean' || !text(s.status)) stop('resume-ao-invalid', 'unsupported AO lifecycle record');
  const activity = kind === 'role' ? s.activity : s.activity?.state;
  if (!['active', 'idle', 'exited', 'terminated', 'waiting'].includes(activity)) stop('resume-ao-invalid', 'unknown AO activity');
  return { id: s.id, projectId: s.projectId, kind: s[kind], status: s.status, activity, isTerminated: s.isTerminated };
}
function aoObserve(q, run, r) {
  const list = parse(r.run(q.ao.tool.file, ['session', 'ls', '--all', '--include-terminated', '--project', q.ao.projectId, '--json'], run.canonicalRoot, true));
  if (!Array.isArray(list.data) || list.meta?.hiddenTerminatedCount !== 0 || list.meta?.hiddenOrchestratorCount !== 0) stop('resume-ao-invalid', 'AO inventory is hidden/partial');
  const rows = list.data.map((v) => lifecycle(v, 'role')), ids = rows.map((v) => v.id);
  if (new Set(ids).size !== ids.length || rows.some((v) => v.projectId !== run.aoProjectId) || !ids.includes(run.coordinatorSessionId)) stop('resume-ao-invalid', 'missing/conflicting AO project/session identity');
  return rows.map((row) => {
    const detail = parse(r.run(q.ao.tool.file, ['session', 'get', row.id, '--project', q.ao.projectId, '--json'], run.canonicalRoot, true));
    const actual = lifecycle(detail.session, 'kind');
    if (!same(actual, row)) stop('resume-ao-conflict', 'AO list/get lifecycle changed or conflicts');
    return actual;
  }).sort((a, b) => a.id.localeCompare(b.id));
}
function canonicalRun(root, q, canonical, identity, previous, now) {
  const c = canonical.view, envelope = canonical.envelope;
  if (identity.gitDir !== identity.gitCommonDir) stop('resume-project-mismatch', 'canonical control root must be primary');
  let startedAtMs = previous?.startedAtMs ?? now;
  if (!previous && q.priorAccounting !== null) {
    const a = bound(q.priorAccounting);
    closed(a, ['schema', 'schemaVersion', 'runId', 'startedAtMs', 'lastObservedAtMs', 'limits'], 'prior accounting');
    if (a.schema !== 'fvs/auto-runtime-accounting' || a.schemaVersion !== 1 || a.runId !== q.runId || !integer(a.startedAtMs) || !integer(a.lastObservedAtMs) || a.lastObservedAtMs < a.startedAtMs || a.lastObservedAtMs > now || !same(a.limits, c.state.choices.limits)) stop('resume-accounting-invalid', 'prior accounting cannot reset/increase limits');
    startedAtMs = a.startedAtMs;
  }
  const run = { runId: q.runId, canonicalRoot: root, gitCommonDir: identity.gitCommonDir, aoProjectId: q.ao.projectId, aoStateHome: q.ao.stateHome, coordinatorSessionId: q.ao.coordinatorSessionId,
    choicesGeneration: c.state.choicesGeneration, agreementContextSha256: c.agreement.contextSha256, scope: c.state.choices.scope, limits: c.state.choices.limits,
    startedAtMs, deadlineMs: Math.floor(startedAtMs + c.state.choices.limits.wallClockHours * 3600000) };
  runValid(run);
  if (previous && !same(run, previous)) stop('resume-context-stale', 'original run scope/limits/context changed; preserve history and limits');
  if (envelope.mode !== 'nonpublic-intent') stop('resume-context-stale', 'only the reviewed nonpublic route is supported');
  return run;
}
function observe(root, q, services, out, previous, now, memory = null, unanchored = !previous) {
  for (const key of ['extraction', 'graph', 'plan', 'baseline']) if (q.inputs[key] !== null) bound(q.inputs[key]);
  const r = runner(out, q), identity = git(root, r), canonical = services.loadCanonical();
  const run = canonicalRun(root, q, canonical, identity, previous, now);
  const source = git(q.source.root, r), reasons = [];
  if (source.gitCommonDir !== identity.gitCommonDir || source.commit !== q.source.commit || source.tree !== q.source.expectedTree || source.dirty) reasons.push('integration-source-mismatch');
  if (now < run.startedAtMs) stop('resume-clock-rollback', 'clock precedes original run start');
  if (now >= run.deadlineMs) reasons.push('original-limit-exhausted');
  const ao = aoObserve(q, run, r), associations = [];
  if (ao.find((s) => s.id === run.coordinatorSessionId)?.kind !== 'orchestrator') stop('resume-route-mismatch', 'checkpoint/refresh is the declared coordinator route, not worker authentication');
  const refs = [...q.associations];
  if (q.transition?.position === 'after' && q.transition.effect?.association) refs.push(q.transition.effect.association);
  const seen = new Set();
  for (const ref of refs) {
    const a = association(ref, run);
    if (seen.has(a.sessionId)) stop('resume-association-invalid', 'duplicate/conflicting controller association');
    seen.add(a.sessionId);
    const actual = git(a.worktree.path, r), expected = { path: actual.root, gitDir: actual.gitDir, gitCommonDir: actual.gitCommonDir, branchRef: actual.branchRef, commit: actual.commit, tree: actual.tree };
    const registered = actual.worktrees.split('\n\n').some((s) => s.split('\n').includes('worktree ' + a.worktree.path) && s.split('\n').includes('branch ' + a.worktree.branchRef));
    if (!same(a.worktree, expected) || actual.gitCommonDir !== run.gitCommonDir || !registered || !ao.some((s) => s.id === a.sessionId)) reasons.push('association-git-or-session-mismatch');
    associations.push({ reference: ref, value: a });
  }
  for (const s of ao) if (s.id !== run.coordinatorSessionId && !s.isTerminated && !seen.has(s.id)) reasons.push('unclassified-ao-session:' + s.id);
  let acceptance = { status: 'not-established', acceptedBaseline: null, nodes: [], storeHeadSha256: null };
  if (q.inputs.acceptedStore !== null) acceptance = services.inspectAcceptance({ baseline: q.inputs.baseline, store: q.inputs.acceptedStore, source: q.source, deadlineMs: run.deadlineMs, out: path.join(out, 'acceptance') });
  else if (q.inputs.baseline !== null) reasons.push('accepted-store-required');
  if (acceptance.inputs) for (const key of ['extraction', 'graph', 'plan']) {
    if (q.inputs[key] !== null && !same(q.inputs[key], acceptance.inputs[key])) reasons.push('stage-context-mismatch:' + key);
  }
  if (unanchored && q.priorAccounting === null && (acceptance.acceptedBaseline || ao.some((s) => s.kind === 'worker') || q.associations.length)) reasons.push('prior-accounting-unknown');
  if (memory === null) {
    services.refreshMemory({ projectRoot: root, callerRoot: root, request: q.memoryRequest, out: path.join(out, 'memory') });
    memory = { out: path.join(out, 'memory'), requestSha256: memoryHash(q.memoryRequest) };
  }
  const consumed = services.verifyMemory({ projectRoot: root, callerRoot: root, request: q.memoryRequest, out: memory.out });
  if (consumed.status !== 'memory-primed') stop('resume-memory-mismatch', 'actual current prime was not consumed');
  return { run, observation: { identity: { primary: identity, source }, inputs: q.inputs, memory, ao, associations, acceptance, reasons: [...new Set(reasons)], receipts: r.refs } };
}
function event(state, q, transition, observation, now) {
  const row = { seq: state.history.length, prev: state.history.at(-1)?.sha256 ?? null, runSha256: memoryHash(state.run), observedAtMs: now, attemptId: q.attemptId,
    ...transition, observation };
  const result = { event: row, sha256: memoryHash(row) }; state.history.push(result); return result;
}
function stableObservation(o) { return { identity: o.identity, inputs: o.inputs, ao: o.ao, associations: o.associations, acceptance: o.acceptance, reasons: o.reasons }; }
function commit(root, q, state, expected, services, fence) {
  const dir = runtimeDir(root, true), lock = path.join(dir, 'lock');
  try { fs.mkdirSync(lock); } catch { stop('resume-pending', 'another checkpoint holds the runtime fence'); }
  let writing = false, completed = false;
  try {
    const current = readRuntime(root, { ignoreLock: true });
    if (current.headSha256 !== q.expectedHeadSha256 || current.headSha256 !== expected) stop('resume-head-stale', 'runtime predecessor changed');
    fence();
    replay(state.history, state.run);
    const b = Buffer.from(JSON.stringify(state, null, 2) + '\n');
    if (b.length > MEMORY_LIMITS.maxBytes) stop('resume-history-invalid', 'runtime metadata limit reached; no compaction/reset');
    const tmp = path.join(dir, '.tmp-' + q.attemptId), fd = fs.openSync(tmp, 'wx'); writing = true;
    try { fs.writeFileSync(fd, b); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    services.beforeRename?.(); fs.renameSync(tmp, path.join(dir, 'state.json'));
    const d = fs.openSync(dir, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
    completed = true;
    return { committedHeadSha256: state.history.at(-1).sha256, runtimeFileSha256: hash(b) };
  } finally { if (!writing || completed) fs.rmdirSync(lock); }
}
export function runResume(operation, options, services) {
  const data = snapshot(options); closed(data, ['projectRoot', 'request', 'out'], 'resume options');
  const root = directory(data.projectRoot), q = validateRequest(data.request), previous = readRuntime(root);
  if (operation === 'checkpoint' ? q.transition === null : q.transition !== null) stop('resume-invalid-input', 'wrong operation/transition');
  if (previous.state && (previous.state.run.runId !== q.runId || previous.state.run.canonicalRoot !== root || previous.state.run.aoProjectId !== q.ao.projectId || previous.state.run.aoStateHome !== q.ao.stateHome || previous.state.run.coordinatorSessionId !== q.ao.coordinatorSessionId)) stop('resume-context-stale', 'request is not for this recorded run/controller');
  const old = q.transition ? previous.transitions.get(q.transition.intent.transitionId) : null;
  if (old) {
    const existing = q.transition.position === 'before' ? old.before : old.after;
    if (existing) {
      const e = previous.state.history.find((r) => r.sha256 === existing).event;
      if (!same(e.intent, q.transition.intent) || e.beforeEventSha256 !== q.transition.beforeEventSha256 || e.outcome !== q.transition.outcome || !same(e.effect, q.transition.effect)) stop('resume-pair-conflict', 'transition replay payload changed');
      ownOutput(data.out, root);
      const result = { code: old.state === 'pending' || old.state === 'uncertain' ? 'uncertain' : 'already-recorded', request: q, requestSha256: memoryHash(q), expectedPredecessorHeadSha256: q.expectedHeadSha256, committedHeadSha256: null, observedHeadSha256: previous.headSha256, recordedEventSha256: existing, effectExecutable: false };
      save(data.out, 'result.json', result); return result;
    }
  }
  if (q.transition?.position === 'after' && (!old || old.before !== q.transition.beforeEventSha256 || !same(old.intent, q.transition.intent))) stop('resume-pair-conflict', 'orphan/conflicting after-event');
  if (previous.headSha256 !== q.expectedHeadSha256) stop('resume-head-stale', 'request predecessor does not match runtime');
  ownOutput(data.out, root);
  const requestInput = save(data.out, 'request.json', q), scriptIdentity = implementation();
  try {
    const now = services.now?.() ?? Date.now();
    if (previous.lastObservedAtMs !== null && now < previous.lastObservedAtMs) stop('resume-clock-rollback', 'clock/accounting moved backwards');
    const { run, observation } = observe(root, q, services, data.out, previous.state?.run, now);
    if (!previous.state && observation.reasons.includes('prior-accounting-unknown')) {
      const result = { schema: 'fvs/auto-resume-result', schemaVersion: 1, code: 'partial', request: q, requestSha256: memoryHash(q), expectedPredecessorHeadSha256: q.expectedHeadSha256, committedHeadSha256: null, observation, effectExecutable: false, reason: 'prior accounting unknown; no execution anchor or runtime was created' };
      if (q.transition) stop('resume-partial', result.reason, { reasons: observation.reasons });
      save(data.out, 'result.json', result); return result;
    }
    const state = previous.state ? snapshot(previous.state) : { schema: 'fvs/auto-runtime', schemaVersion: 1, run, history: [] };
    for (const r of previous.reservations.values()) if (r.state !== 'closed') {
      if (r.intent.effect.kind === 'ao-launch' && r.sessionId && !observation.associations.some((a) => a.value.sessionId === r.sessionId && a.value.reservationId === r.id)) observation.reasons.push('reserved-association-missing');
    }
    let recorded;
    if (q.transition) {
      if (q.transition.position === 'before' && observation.reasons.length) stop('resume-partial', 'continuation is blocked by current observations', { reasons: observation.reasons });
      recorded = event(state, q, q.transition, observation, now);
    } else {
      const intent = { transitionId: q.attemptId, reservationId: q.attemptId, stage: 'reconcile', nodes: [], owner: run.coordinatorSessionId, effect: { kind: 'local', operation: 'reconcile' } };
      const before = event(state, q, { position: 'before', intent, beforeEventSha256: null, outcome: null, effect: null }, observation, now);
      recorded = event(state, q, { position: 'after', intent, beforeEventSha256: before.sha256, outcome: 'succeeded', effect: { sessionId: null, association: null, evidence: [], resolution: null } }, observation, now);
    }
    replay(state.history, run);
    const published = commit(root, q, state, previous.headSha256, services, () => {
      const fenceOut = ownOutput(path.join(data.out, 'fence'), root);
      const fenceAtMs = services.now?.() ?? Date.now();
      if (fenceAtMs < now) stop('resume-clock-rollback', 'clock moved backwards at the observation fence');
      const checked = observe(root, q, services, fenceOut, run, fenceAtMs, observation.memory, !previous.state);
      if (!same(stableObservation(checked.observation), stableObservation(observation))) stop('resume-context-stale', 'AO/Git/receipt/context changed before checkpoint');
      validateRequest(q); // Rehash caller-bound inputs at the publication fence.
      const endedAtMs = services.now?.() ?? Date.now();
      if (endedAtMs < now) stop('resume-clock-rollback', 'clock moved backwards during observation');
      if (endedAtMs >= run.deadlineMs) {
        if (q.transition?.position === 'before') stop('resume-partial', 'original limit expired before intent publication', { reasons: ['original-limit-exhausted'] });
        if (!observation.reasons.includes('original-limit-exhausted')) observation.reasons.push('original-limit-exhausted');
      }
      // Only this new suffix changes; predecessor history stays byte-identical.
      const rewritten = new Map();
      for (let i = previous.state?.history.length ?? 0; i < state.history.length; i++) {
        const row = state.history[i], oldSha = row.sha256;
        row.event.observedAtMs = endedAtMs; row.event.prev = state.history[i - 1]?.sha256 ?? null;
        row.event.beforeEventSha256 = rewritten.get(row.event.beforeEventSha256) ?? row.event.beforeEventSha256;
        row.sha256 = memoryHash(row.event); rewritten.set(oldSha, row.sha256);
      }
    });
    const result = { schema: 'fvs/auto-resume-result', schemaVersion: 1, code: observation.reasons.length ? 'partial' : operation === 'state' ? 'reconciled' : 'checkpointed', request: q, requestSha256: memoryHash(q),
      expectedPredecessorHeadSha256: q.expectedHeadSha256, ...published, recordedEventSha256: recorded.sha256, observation, requestInput, implementation: scriptIdentity, effectExecutable: false,
      semanticCheckRequired: 'Current canonical agreement applicability/actions remain a mandatory workflow check. No dispatch or proof authority.' };
    save(data.out, 'result.json', result); return result;
  } catch (e) { save(data.out, 'failure.json', { code: e.code ?? 'resume-unverified', message: e.message }); throw e; }
}
export function consumeResume(options, services) {
  const data = snapshot(options); closed(data, ['projectRoot', 'request', 'out'], 'resume consumer');
  const q = validateRequest(data.request), root = directory(data.projectRoot), result = parse(bytes(path.join(data.out, 'result.json')));
  if (result.schema !== 'fvs/auto-resume-result' || result.schemaVersion !== 1 || result.code !== 'reconciled' || result.requestSha256 !== memoryHash(q) || !same(result.request, q)
    || result.expectedPredecessorHeadSha256 !== q.expectedHeadSha256 || !matches(result.committedHeadSha256, SHA)) stop('resume-result-mismatch', 'not this caller current reconciliation result');
  if (!same(bound(result.requestInput), q) || !same(result.implementation, implementation())) stop('resume-evidence-invalid', 'request or adapter implementation changed');
  const current = readRuntime(root), latest = current.state?.history.at(-1);
  if (current.headSha256 !== result.committedHeadSha256 || current.fileSha256 !== result.runtimeFileSha256 || !same(latest.event.observation, result.observation)) stop('resume-head-stale', 'reconciliation committed head/bytes changed');
  for (const ref of result.observation.receipts) {
    const receipt = bound(ref);
    if (receipt.requestSha256 !== memoryHash(q) || receipt.attemptId !== q.attemptId || receipt.exitCode !== 0 || receipt.signal || receipt.error || receipt.toolBefore !== receipt.toolAfter) stop('resume-evidence-invalid', 'invalid observation receipt');
    for (const stream of [receipt.stdout, receipt.stderr]) { const b = bytes(stream.file); if (hash(b) !== stream.sha256) stop('resume-evidence-invalid', 'observation output changed'); }
  }
  const out = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fvs-resume-consume-')); fs.mkdirSync(path.join(out, 'receipts'));
  const now = services.now?.() ?? Date.now();
  if (now < current.lastObservedAtMs) stop('resume-clock-rollback', 'clock/accounting moved backwards');
  const observed = observe(root, q, services, out, current.state.run, now, result.observation.memory);
  if (observed.observation.reasons.length || !same(stableObservation(observed.observation), stableObservation(result.observation)) || readRuntime(root).headSha256 !== result.committedHeadSha256) stop('resume-context-stale', 'current observation no longer matches the committed reconciliation');
  return { code: 'reconciled', committedHeadSha256: current.headSha256, observation: observed.observation, semanticCheckRequired: result.semanticCheckRequired, effectExecutable: false, verificationEvidence: out };
}
