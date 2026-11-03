// Coordinator checkpoint metadata. No dispatch, backend, or Git runs on import.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { memoryDataSnapshot, memoryHash, MEMORY_LIMITS } from './fvs-project-memory.mjs';
import { duplicateKeys } from './fvs-lean-graph.mjs';
import { parseBudget, resolveBudget, runControl, runExpired, unbudgetedRun, runExecutionFields } from './fvs-execution.mjs';
import { readTransitionAction, readWorkPacket, readRuntimeObservation, transitionSnapshot, assessTransition, validateReleasedContext, redactAOProfile, lifecycleOnlyAction } from './fvs-auto-transitions.mjs';

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
  return Object.fromEntries(['fvs-auto-resume.mjs', 'fvs-auto-transitions.mjs', 'fvs-auto.mjs', 'fvs-project-memory.mjs', 'fvs-checker-auto.mjs'].map((name) => {
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
  if (run?.schemaVersion === 2) {
    closed(run, [...runKeys.filter(k => k !== 'deadlineMs'), 'schemaVersion', 'budget', 'memory'], 'v2 runtime run');
    if (!matches(run.runId, UUID) || ![run.canonicalRoot, run.gitCommonDir, run.aoStateHome].every(p => text(p) && path.isAbsolute(p))
      || ![run.aoProjectId, run.coordinatorSessionId, run.scope].every(text) || !integer(run.choicesGeneration) || !matches(run.agreementContextSha256, SHA) || !integer(run.startedAtMs)) stop('resume-history-invalid', 'invalid v2 run identity');
    closed(run.limits, ['workers'], 'v2 capacity');
    if (!Number.isSafeInteger(run.limits.workers) || run.limits.workers < 1) stop('resume-history-invalid', 'invalid capacity');
    parseBudget(run.budget, true); closed(run.memory, ['mode'], 'v2 memory disposition');
    if (!['disabled', 'beads'].includes(run.memory.mode)) stop('resume-history-invalid', 'invalid memory disposition');
    return;
  }
  closed(run, runKeys, 'runtime run');
  if (!matches(run.runId, UUID) || ![run.canonicalRoot, run.gitCommonDir, run.aoStateHome].every((p) => text(p) && path.isAbsolute(p))
    || ![run.aoProjectId, run.coordinatorSessionId, run.scope].every(text) || !integer(run.choicesGeneration) || !matches(run.agreementContextSha256, SHA)
    || !integer(run.startedAtMs) || !integer(run.deadlineMs)) stop('resume-history-invalid', 'invalid run binding');
  closed(run.limits, ['workers', 'nodeHours', 'wallClockHours'], 'original limits');
  if (!Number.isSafeInteger(run.limits.workers) || run.limits.workers < 1 || !(typeof run.limits.nodeHours === 'number' && run.limits.nodeHours > 0) || !(typeof run.limits.wallClockHours === 'number' && run.limits.wallClockHours > 0)
    || run.deadlineMs !== Math.floor(run.startedAtMs + run.limits.wallClockHours * 3600000)) stop('resume-history-invalid', 'invalid original limits/deadline');
}
function intentValid(t) {
  closed(t, ['transitionId', 'reservationId', 'stage', 'nodes', 'owner', 'effect', ...(Object.hasOwn(t, 'request') ? ['request'] : [])], 'transition intent');
  if (Object.hasOwn(t, 'request')) {
    const action = readTransitionAction(t.request);
    if (action.transitionId !== t.transitionId || action.reservationId !== t.reservationId || action.stage !== t.stage || action.owner !== t.owner || !same(action.nodes, t.nodes)) stop('resume-invalid-input', 'bound action is not this exact intent');
  }
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
  closed(e, ['seq', 'prev', 'runSha256', 'observedAtMs', 'attemptId', 'position', 'intent', 'beforeEventSha256', 'outcome', 'effect', 'observation', ...(Object.hasOwn(e, 'observationInput') ? ['observationInput'] : [])], 'checkpoint event');
  if (!integer(e.seq) || !(e.prev === null || matches(e.prev, SHA)) || !matches(e.runSha256, SHA) || !integer(e.observedAtMs) || !matches(e.attemptId, UUID)) stop('resume-history-invalid', 'invalid event binding');
  intentValid(e.intent);
  if (e.position === 'before') {
    if (e.beforeEventSha256 !== null || e.outcome !== null || e.effect !== null) stop('resume-history-invalid', 'before cannot claim an effect');
  } else if (e.position === 'after') {
    if (!matches(e.beforeEventSha256, SHA) || !['succeeded', 'failed', 'uncertain'].includes(e.outcome)) stop('resume-history-invalid', 'invalid paired after');
    closed(e.effect, ['sessionId', 'association', 'evidence', 'resolution'], 'actual effect');
    if (!(e.effect.sessionId === null || text(e.effect.sessionId)) || !Array.isArray(e.effect.evidence)) stop('resume-history-invalid', 'invalid actual effect');
  } else stop('resume-history-invalid', 'invalid event position');
  const observation = readRuntimeObservation(e);
  closed(observation, ['identity', 'inputs', 'memory', 'ao', 'associations', 'acceptance', 'reasons', 'receipts', ...(Object.hasOwn(observation, 'transition') ? ['transition'] : [])], 'observation');
  return observation;
}
// Derive reservations from verified events, never a caller's stored status/count.
function replay(history, run) {
  const transitions = new Map(), reservations = new Map(); let prev = null, time = run.startedAtMs;
  for (const [index, row] of history.entries()) {
    closed(row, ['event', 'sha256'], 'history row'); const e = row.event, observation = eventValid(e);
    if (row.sha256 !== memoryHash(e) || e.seq !== index || e.prev !== prev || e.runSha256 !== memoryHash(run) || (e.observedAtMs < time && !unbudgetedRun(run))) stop('resume-history-invalid', 'history chain/time mismatch');
    time = e.observedAtMs; prev = row.sha256;
    const id = e.intent.transitionId, rId = e.intent.reservationId, old = transitions.get(id);
    if (e.position === 'before') {
      if (old || reservations.has(rId)) stop('resume-history-invalid', 'duplicate transition/reservation');
      const resolving = e.intent.effect.kind === 'reservation-resolution' ? e.intent.effect.targetReservationId : null;
      for (const r of reservations.values()) if (r.state !== 'closed' && r.id !== resolving && e.intent.nodes.some((n) => r.intent.nodes.includes(n))) stop('resume-reservation-conflict', 'node already reserved');
      const held = [...reservations.values()].filter((r) => r.state !== 'closed' && r.intent.effect.kind === 'ao-launch');
      const liveUnreserved = observation.associations.filter((a) => a.value.scopeRelation === 'run-assignment' && observation.ao.some((s) => s.id === a.value.sessionId && !s.isTerminated) && !held.some((r) => r.sessionId === a.value.sessionId));
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
          if(run.schemaVersion===2){
            closed(proof,['schema','schemaVersion','session','progress','terminationCompletion'],'owned termination evidence');
            if(proof.schema!=='fvs/auto-owned-session-termination'||proof.schemaVersion!==1)stop('resume-pair-conflict','v2 closure requires exact typed termination completion');
            if(proof.progress===null){if([...transitions.values()].some(r=>r.intent.request&&(()=>{const a=readTransitionAction(r.intent.request);return a.kind==='release'&&bound(a.target.association).reservationId===target.id;})()))stop('resume-pair-conflict','uncertain/released work cannot close without exact handoff');}else boundBytes(proof.progress);boundBytes(proof.terminationCompletion);
          }
          const observed = proof.session;
          if (!target.sessionId || observed?.id !== target.sessionId || observed.projectId !== run.aoProjectId || observed.isTerminated !== true
            || !observation.ao.some((s) => s.id === observed.id && s.isTerminated)) stop('resume-pair-conflict', 'missing current matched termination');
        } else if (resolution.reason === 'local-completed') {
          closed(proof, ['schema', 'schemaVersion', 'runId', 'reservationId', 'transitionId', 'beforeEventSha256', 'stage', 'operation', 'controllerSessionId', 'effectInvoked', 'terminalOutcome', 'effectEvidence'], 'recovered local completion');
          if (target.intent.effect.kind !== 'local' || !['pending', 'uncertain'].includes(target.state)
            || proof.schema !== 'fvs/auto-local-effect-completion' || proof.schemaVersion !== 1 || proof.runId !== run.runId || proof.reservationId !== target.id
            || proof.transitionId !== target.intent.transitionId || proof.beforeEventSha256 !== target.before || proof.stage !== target.intent.stage || proof.operation !== target.intent.effect.operation
            || proof.controllerSessionId !== run.coordinatorSessionId || proof.effectInvoked !== true || !['succeeded', 'failed'].includes(proof.terminalOutcome)
            || !Array.isArray(proof.effectEvidence) || !proof.effectEvidence.length) stop('resume-pair-conflict', 'completion is not for this invoked local effect');
          for (const ref of proof.effectEvidence) boundBytes(ref);
          target.terminalOutcome = proof.terminalOutcome; // Execution closure only, never proof acceptance.
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
  if (state.schema !== 'fvs/auto-runtime' || ![1, 2].includes(state.schemaVersion) || (state.schemaVersion === 2) !== (state.run?.schemaVersion === 2) || !Array.isArray(state.history) || !state.history.length) stop('resume-history-invalid', 'unsupported runtime state');
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
  if (q.schema !== 'fvs/auto-resume-request' || ![1, 2].includes(q.schemaVersion) || ![q.attemptId, q.runId].every((v) => matches(v, UUID)) || !['start', 'resume'].includes(q.phase)
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
  if (!(q.schemaVersion === 2 && m === null) && (!m || m.attemptId !== q.attemptId || m.phase !== q.phase || m.operation !== 'coordinator-refresh' || m.target?.projectId !== q.ao.projectId || m.target.sessionId !== q.ao.coordinatorSessionId || m.target.resumeId !== q.resumeId)) stop('resume-memory-mismatch', 'independently prepared memory request must bind this exact caller/phase');
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
  function run(tool, args, cwd, ao = false, redact = null) {
    const toolBefore = hash(bytes(tool));
    if (ao && toolBefore !== q.ao.tool.sha256) stop('resume-tool-changed', 'AO tool identity changed');
    const env = { PATH: '/usr/bin:/bin', ...(ao ? { HOME: q.ao.stateHome } : {}), LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' };
    // AO is the installed local controller CLI. No caller URL/provider credentials are forwarded.
    const startedAtMs = Date.now(), p = spawnSync(tool, args, { cwd, env, timeout: MEMORY_LIMITS.timeoutMs, maxBuffer: MEMORY_LIMITS.maxBytes });
    const endedAtMs = Date.now(), n = String(refs.length + 1).padStart(4, '0'), stdout = p.stdout ?? Buffer.alloc(0), stderr = p.stderr ?? Buffer.alloc(0);
    const stream = (suffix, b) => { const file = path.join(out, 'receipts', n + suffix); fs.writeFileSync(file, b, { flag: 'wx' }); return { file, sha256: hash(b) }; };
    const receipt = save(out, 'receipts/' + n + '.json', { attemptId: q.attemptId, requestSha256: memoryHash(q), argv: [tool, ...args], cwd, env,
      startedAtMs, endedAtMs, toolBefore, toolAfter: hash(bytes(tool)), exitCode: p.status, signal: p.signal, error: p.error?.code ?? null,
      ...(redact ? { rawStdoutSha256: hash(stdout), rawStderrSha256: hash(stderr), redaction: 'project config fingerprint only; no env/rules contents' } : {}),
      stdout: stream('.stdout', redact ? Buffer.from(JSON.stringify(redact(stdout))) : stdout), stderr: stream('.stderr', redact ? Buffer.alloc(0) : stderr) });
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
function reservedAssociation(a, view, run, { stage = null, live = false, pending = false } = {}) {
  const r = view.reservations.get(a.reservationId);
  if (!r || a.projectId !== run.aoProjectId || r.intent.effect.kind !== 'ao-launch' || r.intent.effect.assignmentId !== a.assignmentId || r.intent.owner !== a.owner || !same(r.intent.nodes, a.nodes)
    || r.intent.effect.intendedBranchRef !== a.worktree.branchRef || (stage !== null && r.intent.stage !== stage)) stop('resume-association-invalid', 'actor/candidate lost its exact reserved assignment');
  if (pending && r.state === 'pending' && r.sessionId === null && a.provenance.kind === 'controller-launch' && a.provenance.beforeEventSha256 === r.before) return;
  if (r.sessionId !== a.sessionId || !(live ? r.state === 'active' : ['active', 'closed'].includes(r.state))) stop('resume-association-invalid', 'actor is not the conclusively associated reserved session');
  const after = view.state.history.find((row) => row.sha256 === r.after), original = association(after.event.effect.association, run);
  const fixed = (value) => ({ ...Object.fromEntries(['path', 'gitDir', 'gitCommonDir', 'branchRef'].map((key) => [key, value.worktree[key]])), profile: value.rulesProfile });
  if (!same(fixed(a), fixed(original))) stop('resume-association-invalid', 'reserved actor path/commonGit/branch/profile changed');
}
export function readRuntimeAssignment(ref, view, run, stage) {
  const value = association(ref, run); reservedAssociation(value, view, run, { stage }); return value;
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
    closed(a, ['schema', 'schemaVersion', 'runId', 'startedAtMs', 'lastObservedAtMs', 'limits', ...(q.schemaVersion === 2 ? ['budget'] : [])], 'prior accounting');
    if (a.schema !== 'fvs/auto-runtime-accounting' || a.schemaVersion !== q.schemaVersion || (q.schemaVersion === 2 && !same(a.budget, c.state.choices.budget)) || a.runId !== q.runId || !integer(a.startedAtMs) || !integer(a.lastObservedAtMs) || a.lastObservedAtMs < a.startedAtMs || a.lastObservedAtMs > now || !same(a.limits, c.state.choices.limits)) stop('resume-accounting-invalid', 'prior accounting cannot reset/increase limits');
    startedAtMs = a.startedAtMs;
  }
  if (q.schemaVersion !== c.state.schemaVersion) stop('resume-context-stale', 'setup/runtime request versions differ; no implicit migration');
  const run = { runId: q.runId, canonicalRoot: root, gitCommonDir: identity.gitCommonDir, aoProjectId: q.ao.projectId, aoStateHome: q.ao.stateHome, coordinatorSessionId: q.ao.coordinatorSessionId,
    choicesGeneration: c.state.choicesGeneration, agreementContextSha256: c.agreement.contextSha256, scope: c.state.choices.scope, limits: c.state.choices.limits,
    startedAtMs, ...(q.schemaVersion === 2 ? { schemaVersion: 2, budget: resolveBudget(c.state.choices.budget, startedAtMs), memory: c.state.choices.memory } : { deadlineMs: Math.floor(startedAtMs + c.state.choices.limits.wallClockHours * 3600000) }) };
  runValid(run);
  if (previous && !same(run, previous)) stop('resume-context-stale', 'original run scope/limits/context changed; preserve history and limits');
  if (envelope.mode !== 'nonpublic-intent') stop('resume-context-stale', 'only the reviewed nonpublic route is supported');
  return run;
}
function observe(root, q, services, out, previous, now, memory = null, unanchored = !previous, history = null) {
  const actionRef = q.transition?.intent?.request ?? null;
  const action = actionRef === null ? null : readTransitionAction(actionRef),stopping=lifecycleOnlyAction(action);
  for (const key of ['extraction', 'graph', 'plan', 'baseline']) if (q.inputs[key] !== null) bound(q.inputs[key]);
  const r = runner(out, q), identity = git(root, r), canonical = services.loadCanonical();
  const run = canonicalRun(root, q, canonical, identity, previous, now);
  const source = git(q.source.root, r), reasons = [];
  if (source.gitCommonDir !== identity.gitCommonDir || source.commit !== q.source.commit || source.tree !== q.source.expectedTree || source.dirty) reasons.push('integration-source-mismatch');
  if (!unbudgetedRun(run) && now < run.startedAtMs) stop('resume-clock-rollback', 'clock precedes original run start');
  if (runExpired(run, now)) reasons.push('original-limit-exhausted');
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
    if ((!stopping && !same(a.worktree, expected)) || (stopping && ['path','gitDir','gitCommonDir','branchRef'].some(k=>a.worktree[k]!==expected[k])) || actual.gitCommonDir !== run.gitCommonDir || !registered || !ao.some((s) => s.id === a.sessionId)) reasons.push('association-git-or-session-mismatch');
    associations.push({ reference: ref, value: a });
  }
  for (const s of ao) if (s.id !== run.coordinatorSessionId && !s.isTerminated && !seen.has(s.id)) reasons.push('unclassified-ao-session:' + s.id);
  if (history) for (const reserved of history.reservations.values()) if (reserved.state !== 'closed' && reserved.intent.effect.kind === 'ao-launch' && reserved.sessionId
    && !associations.some((a) => a.value.sessionId === reserved.sessionId && a.value.reservationId === reserved.id)) reasons.push('reserved-association-missing');
  let acceptance = { status: 'not-established', acceptedBaseline: null, nodes: [], storeHeadSha256: null };
  if(stopping){acceptance={status:'unverified',reason:'lifecycle-only-unverified',acceptedBaseline:null,nodes:null,storeHeadSha256:null};reasons.push('lifecycle-only-unverified');}
  else if (q.inputs.acceptedStore !== null) {
    if (runExpired(run, now)) acceptance = { status: 'unverified', reason: 'original-limit-exhausted', diagnostic: { code: 'original-limit-exhausted', message: 'currentness inspection skipped after the original deadline' }, acceptedBaseline: null, nodes: [], storeHeadSha256: null };
    else {
      try { acceptance = services.inspectAcceptance({ baseline: q.inputs.baseline, store: q.inputs.acceptedStore, source: q.source, ...runExecutionFields(run), out: path.join(out, 'acceptance') }); }
      catch (e) {
        if (e.code === 'timeout') {
          acceptance = { status: 'unverified', reason: 'original-limit-exhausted', diagnostic: { code: e.code, message: e.message }, acceptedBaseline: null, nodes: [], storeHeadSha256: null };
          reasons.push('original-limit-exhausted');
        } else if (action && e.code === 'stale-input') {
          // The row validator below must independently validate actual metadata,
          // immutable artifacts and a completed explanation. No current proof.
          acceptance = { status: 'unverified', reason: 'acceptance-recheck-required', diagnostic: { code: e.code, message: e.message }, acceptedBaseline: null, nodes: [], storeHeadSha256: null };
          reasons.push('acceptance-unverified');
        } else throw e;
      }
    }
  }
  else if (q.inputs.baseline !== null) reasons.push('accepted-store-required');
  if (acceptance.inputs) for (const key of ['extraction', 'graph', 'plan']) {
    if (q.inputs[key] !== null && !same(q.inputs[key], acceptance.inputs[key])) reasons.push('stage-context-mismatch:' + key);
  }
  const earlierExecution = canonical.view.state.extraction !== null || ['extraction', 'graph', 'plan', 'baseline'].some((key) => q.inputs[key] !== null)
    || q.inputs.acceptedStore?.expectedHeadSha256 != null || acceptance.acceptedBaseline || ao.some((s) => s.kind === 'worker') || q.associations.length;
  if (unanchored && !unbudgetedRun(run) && q.priorAccounting === null && earlierExecution) reasons.push('prior-accounting-unknown');
  if (run.schemaVersion === 2 && run.memory.mode === 'disabled') {
    if (q.memoryRequest !== null) stop('resume-memory-mismatch', 'disabled memory cannot consume a bootstrap receipt');
    const disabled = { status: 'disabled', policySha256: memoryHash({ generation: run.choicesGeneration, agreement: run.agreementContextSha256, memory: run.memory }), request: null };
    if (memory !== null && !same(memory, disabled)) stop('resume-memory-mismatch', 'disabled memory disposition changed');
    memory = disabled;
  } else {
    if (q.memoryRequest === null) stop('resume-memory-mismatch', 'enabled memory needs its independent current caller request');
    if (memory === null) {
      services.refreshMemory({ projectRoot: root, callerRoot: root, request: q.memoryRequest, out: path.join(out, 'memory') });
      memory = { out: path.join(out, 'memory'), requestSha256: memoryHash(q.memoryRequest) };
    }
    const consumed = services.verifyMemory({ projectRoot: root, callerRoot: root, request: q.memoryRequest, out: memory.out });
    if (consumed.status !== 'memory-primed') stop('resume-memory-mismatch', 'actual current prime was not consumed');
  }
  const observation = { identity: { primary: identity, source }, inputs: q.inputs, memory, ao, associations, acceptance, reasons: [...new Set(reasons)], receipts: r.refs };
  if (action) {
    if (!history || !services.transitions) stop('resume-transition-unavailable', 'bound22 transition services/history are required');
    const transitionServices = { ...services.transitions,
      profileObservation: redactAOProfile(r.run(q.ao.tool.file, ['project', 'get', run.aoProjectId, '--json'], root, true, redactAOProfile)),
      observeSession: (id) => ao.find((s) => s.id === id),
      verifyAssociation(a) { reservedAssociation(a, history, run, { live: !(action.kind === 'terminate' && action.target.operation === 'resolve-terminated-reservation' && q.transition.position === 'after'), pending: action.kind === 'launch' && q.transition.position === 'after' }); },
      verifyCandidateAssignment(ref, stage) {
        reservedAssociation(association(ref, run), history, run, { stage });
      },
      beforeForAction(ref) {
        const row = history.state?.history.find((r) => r.event.position === 'before' && same(r.event.intent.request ?? null, ref));
        if (!row) stop('resume-pair-conflict', 'startup requires the actual retained launch-before event');
        return row.sha256;
      },
      verifyMemory: (o) => services.verifyMemory({ ...o, projectRoot: root }),
      observeActor(actor) {
        const s = ao.find((s) => s.id === actor.sessionId);
        if (!s || s.kind !== 'worker' || s.isTerminated || actor.projectId !== run.aoProjectId) stop('resume-association-invalid', 'actor is not a current owned worker');
        const g = git(actor.worktree.path, r);
        return { ...actor, worktree: { path: g.root, gitDir: g.gitDir, gitCommonDir: g.gitCommonDir, branchRef: g.branchRef, commit: g.commit, tree: g.tree, dirty: g.dirty } };
      },
    };
    const observed = transitionSnapshot({ q, run, canonical, observation, action }, {
      ...transitionServices,
      observeWorktree(expected) {
        const g = git(expected.path, r);
        return { path: g.root, gitDir: g.gitDir, gitCommonDir: g.gitCommonDir, branchRef: g.branchRef, commit: g.commit, tree: g.tree, dirty: g.dirty };
      },
    });
    observation.transition = { snapshot: observed, admissibility: assessTransition({ actionRef, q, view: history, canonical, run, actual: observed, reasons: observation.reasons, now,
      evidenceRefs: q.transition.effect?.evidence ?? [] }, transitionServices) };
  }
  return { run, observation };
}
function event(state, q, transition, observation, now) {
  const row = { seq: state.history.length, prev: state.history.at(-1)?.sha256 ?? null, runSha256: memoryHash(state.run), observedAtMs: now, attemptId: q.attemptId,
    ...transition, observation };
  const result = { event: row, sha256: memoryHash(row) }; state.history.push(result); return result;
}
function stableObservation(o) {
  // Timeout-before-cap and skipped-after-cap are the same unavailable budget
  // state. Preserve raw diagnostics in each observation; compare every other
  // context/head/acceptance field, and never normalize current proof evidence.
  const budgetPartial = o.acceptance.status === 'unverified' && o.acceptance.reason === 'original-limit-exhausted' && o.reasons.includes('original-limit-exhausted');
  return { identity: o.identity, inputs: o.inputs, ao: o.ao, associations: o.associations, ...(Object.hasOwn(o, 'transition') ? { transition: o.transition } : {}),
    acceptance: budgetPartial ? { ...o.acceptance, diagnostic: null } : o.acceptance,
    reasons: budgetPartial ? [...o.reasons].sort() : o.reasons };
}
function commit(root, q, state, expected, services, fence) {
  const dir = runtimeDir(root, true), lock = path.join(dir, 'lock');
  try { fs.mkdirSync(lock); } catch { stop('resume-pending', 'another checkpoint holds the runtime fence'); }
  let writing = false, completed = false;
  try {
    const current = readRuntime(root, { ignoreLock: true });
    if (current.headSha256 !== q.expectedHeadSha256 || current.headSha256 !== expected) stop('resume-head-stale', 'runtime predecessor changed');
    fence();
    replay(state.history, state.run);
    // Retain every event/field under the same byte cap; whitespace is not history.
    const b = Buffer.from(JSON.stringify(state) + '\n');
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
  if (previous.state && (previous.state.schemaVersion !== q.schemaVersion || previous.state.run.runId !== q.runId || previous.state.run.canonicalRoot !== root || previous.state.run.aoProjectId !== q.ao.projectId || previous.state.run.aoStateHome !== q.ao.stateHome || previous.state.run.coordinatorSessionId !== q.ao.coordinatorSessionId)) stop('resume-context-stale', 'request is not for this recorded run/controller');
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
    if (previous.lastObservedAtMs !== null && !unbudgetedRun(previous.state?.run) && now < previous.lastObservedAtMs) stop('resume-clock-rollback', 'clock/accounting moved backwards');
    const { run, observation } = observe(root, q, services, data.out, previous.state?.run, now, null, !previous.state, previous);
    if (!previous.state && observation.reasons.includes('prior-accounting-unknown')) {
      const result = { schema: 'fvs/auto-resume-result', schemaVersion: q.schemaVersion, code: 'partial', request: q, requestSha256: memoryHash(q), expectedPredecessorHeadSha256: q.expectedHeadSha256, committedHeadSha256: null, observation, effectExecutable: false, reason: 'prior accounting unknown; no execution anchor or runtime was created' };
      if (q.transition) stop('resume-partial', result.reason, { reasons: observation.reasons });
      save(data.out, 'result.json', result); return result;
    }
    const state = previous.state ? snapshot(previous.state) : { schema: 'fvs/auto-runtime', schemaVersion: q.schemaVersion, run, history: [] };
    let recorded;
    if (q.transition) {
      if (q.transition.position === 'before' && observation.reasons.length && observation.transition?.admissibility.status !== 'next-action-eligible') stop('resume-partial', 'continuation is blocked by current observations', { reasons: observation.reasons });
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
      if (!unbudgetedRun(run) && fenceAtMs < now) stop('resume-clock-rollback', 'clock moved backwards at the observation fence');
      const checked = observe(root, q, services, fenceOut, run, fenceAtMs, observation.memory, !previous.state, previous);
      save(fenceOut, 'observation.json', checked.observation);
      if (!same(stableObservation(checked.observation), stableObservation(observation))) stop('resume-context-stale', 'AO/Git/receipt/context changed before checkpoint');
      validateRequest(q); // Rehash caller-bound inputs at the publication fence.
      const endedAtMs = services.now?.() ?? Date.now();
      if (!unbudgetedRun(run) && endedAtMs < now) stop('resume-clock-rollback', 'clock moved backwards during observation');
      if (runExpired(run, endedAtMs)) {
        if (q.transition?.position === 'before' && !lifecycleOnlyAction(q.transition?.intent.request?readTransitionAction(q.transition.intent.request):null)) stop('resume-partial', 'original limit expired before intent publication', { reasons: ['original-limit-exhausted'] });
        if (!observation.reasons.includes('original-limit-exhausted')) observation.reasons.push('original-limit-exhausted');
      }
      const observationInput = q.transition?.intent.request ? save(data.out, 'observation.json', observation) : null;
      // Only this new suffix changes; predecessor history stays byte-identical.
      const rewritten = new Map();
      for (let i = previous.state?.history.length ?? 0; i < state.history.length; i++) {
        const row = state.history[i], oldSha = row.sha256;
        row.event.observedAtMs = endedAtMs; row.event.prev = state.history[i - 1]?.sha256 ?? null;
        row.event.beforeEventSha256 = rewritten.get(row.event.beforeEventSha256) ?? row.event.beforeEventSha256;
        if (observationInput) { row.event.observation = null; row.event.observationInput = observationInput; }
        row.sha256 = memoryHash(row.event); rewritten.set(oldSha, row.sha256);
      }
    });
    const result = { schema: 'fvs/auto-resume-result', schemaVersion: q.schemaVersion, code: observation.reasons.length ? 'partial' : operation === 'state' ? 'reconciled' : 'checkpointed', request: q, requestSha256: memoryHash(q),
      expectedPredecessorHeadSha256: q.expectedHeadSha256, ...published, recordedEventSha256: recorded.sha256, observation, requestInput, implementation: scriptIdentity, effectExecutable: false,
      semanticCheckRequired: 'Current canonical agreement applicability/actions remain a mandatory workflow check. No dispatch or proof authority.' };
    save(data.out, 'result.json', result); return result;
  } catch (e) { save(data.out, 'failure.json', { code: e.code ?? 'resume-unverified', message: e.message }); throw e; }
}
export function consumeResume(options, services) { return consume(options, services, false); }
export function consumeTransition(options, services) { return consume(options, services, true); }
function consume(options, services, transition) {
  const data = snapshot(options); closed(data, ['projectRoot', 'request', 'out'], 'resume consumer');
  const q = validateRequest(data.request), root = directory(data.projectRoot), result = parse(bytes(path.join(data.out, 'result.json')));
  if (result.schema !== 'fvs/auto-resume-result' || result.schemaVersion !== q.schemaVersion || !(result.code === 'reconciled' || (transition && ['partial', 'checkpointed'].includes(result.code))) || result.requestSha256 !== memoryHash(q) || !same(result.request, q)
    || result.expectedPredecessorHeadSha256 !== q.expectedHeadSha256 || !matches(result.committedHeadSha256, SHA)) stop('resume-result-mismatch', 'not this caller current reconciliation result');
  if (!same(bound(result.requestInput), q) || !same(result.implementation, implementation())) stop('resume-evidence-invalid', 'request or adapter implementation changed');
  const current = readRuntime(root), latest = current.state?.history.at(-1);
  if (current.headSha256 !== result.committedHeadSha256 || current.fileSha256 !== result.runtimeFileSha256 || !same(readRuntimeObservation(latest.event), result.observation)) stop('resume-head-stale', 'reconciliation committed head/bytes changed');
  for (const ref of result.observation.receipts) {
    const receipt = bound(ref);
    if (receipt.requestSha256 !== memoryHash(q) || receipt.attemptId !== q.attemptId || receipt.exitCode !== 0 || receipt.signal || receipt.error || receipt.toolBefore !== receipt.toolAfter) stop('resume-evidence-invalid', 'invalid observation receipt');
    for (const stream of [receipt.stdout, receipt.stderr]) { const b = bytes(stream.file); if (hash(b) !== stream.sha256) stop('resume-evidence-invalid', 'observation output changed'); }
  }
  const out = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fvs-resume-consume-')); fs.mkdirSync(path.join(out, 'receipts'));
  const now = services.now?.() ?? Date.now();
  if (!unbudgetedRun(current.state.run) && now < current.lastObservedAtMs) stop('resume-clock-rollback', 'clock/accounting moved backwards');
  const observed = observe(root, q, services, out, current.state.run, now, result.observation.memory, false, current);
  const finalHead = readRuntime(root).headSha256, endedAtMs = services.now?.() ?? Date.now();
  if (!unbudgetedRun(current.state.run) && (endedAtMs < now || endedAtMs < current.lastObservedAtMs)) stop('resume-clock-rollback', 'clock moved backwards during consumption', { verificationEvidence: out });
  if (runExpired(current.state.run, endedAtMs) && !lifecycleOnlyAction(q.transition?.intent.request?readTransitionAction(q.transition.intent.request):null) && !(transition && q.transition?.position === 'after')) stop('resume-partial', 'original limit expired during consumption; preserve the resumable checkpoint', { reasons: ['original-limit-exhausted'], verificationEvidence: out });
  if ((!transition && observed.observation.reasons.length) || !same(stableObservation(observed.observation), stableObservation(result.observation)) || finalHead !== result.committedHeadSha256) stop('resume-context-stale', 'current observation no longer matches the committed reconciliation');
  if (transition) {
    const row = observed.observation.transition?.admissibility;
    if (!row || !q.transition?.intent.request || (q.transition.position === 'before' && row.status !== 'next-action-eligible')) stop('resume-partial', 'no independently current bounded transition');
    return { code: 'transition-reconciled', committedHeadSha256: current.headSha256, observation: observed.observation, effectExecutable: false,
      action: q.transition.intent.request, position: q.transition.position, verificationEvidence: out };
  }
  return { code: 'reconciled', committedHeadSha256: current.headSha256, observation: observed.observation, semanticCheckRequired: result.semanticCheckRequired, effectExecutable: false, verificationEvidence: out };
}

// Startup/packet consumers supply their own current request; AO has no path
// field, so the retained controller association is joined with actual Git.
export function observeAssignedActor({ projectRoot, ao, actor, attemptId, out }) {
  const view = readRuntime(projectRoot), run = view.state?.run;
  if (!run || ao.projectId !== run.aoProjectId || ao.stateHome !== run.aoStateHome || actor.projectId !== run.aoProjectId) stop('resume-project-mismatch', 'actor must belong to the current controller run');
  const reservation = view.reservations.get(actor.reservationId);
  if (!reservation) stop('resume-association-invalid', 'actor has no retained reservation');
  reservedAssociation({ ...actor, owner: reservation.intent.owner, nodes: reservation.intent.nodes, rulesProfile: actor.profile }, view, run, { live: true });
  ownOutput(out, projectRoot);
  const r = runner(out, { ao, attemptId }), rows = aoObserve({ ao }, run, r);
  if (!rows.some((s) => s.id === actor.sessionId && s.kind === 'worker' && !s.isTerminated)) stop('resume-association-invalid', 'no fresh live same-project actor');
  const g = git(actor.worktree.path, r);
  if (g.gitCommonDir !== run.gitCommonDir || !g.worktrees.split('\n\n').some((s) => s.split('\n').includes('worktree ' + g.root) && s.split('\n').includes('branch ' + g.branchRef))) stop('resume-association-invalid', 'actor is not an actual registered worktree');
  return { ...actor, worktree: { path: g.root, gitDir: g.gitDir, gitCommonDir: g.gitCommonDir, branchRef: g.branchRef, commit: g.commit, tree: g.tree, dirty: g.dirty } };
}

export function verifyReleasedPacketContext({ projectRoot, ao, packet, memoryRequest, out }, services) {
  const view = readRuntime(projectRoot), run = view.state?.run, p = readWorkPacket(packet);
  const before = view.state?.history.find((r) => r.event.position === 'before' && r.event.intent.request && (() => {
    const a = readTransitionAction(r.event.intent.request); return a.kind === 'release' && same(a.target.packet, packet);
  })());
  if (!before || !run || ao.projectId !== run.aoProjectId || ao.stateHome !== run.aoStateHome) stop('resume-pair-conflict', 'no retained release-before for this packet/controller');
  const a = readTransitionAction(before.event.intent.request), canonical = services.loadCanonical();
  const delivered = view.state.history.find((row) => row.event.position === 'after' && row.event.beforeEventSha256 === before.sha256 && row.event.outcome === 'succeeded' && same(row.event.intent, before.event.intent));
  if (!delivered) stop('transition-release-not-published', 'wait for the exact successful delivery after-event; recover the original handle, never resend');
  if (canonical.view.state.choicesGeneration !== run.choicesGeneration || canonical.view.agreement.contextSha256 !== run.agreementContextSha256) stop('resume-context-stale', 'packet canonical agreement changed');
  ownOutput(out, projectRoot);
  const q = { ao, attemptId: memoryRequest.attemptId, inputs: readRuntimeObservation(before.event).inputs, memoryRequest, source: { root: a.before.source.root }, associations: [], transition: null };
  const r = runner(out, q), rows = aoObserve(q, run, r);
  const known = new Set([...view.reservations.values()].filter((r) => r.state === 'active').map((r) => r.sessionId));
  if (!known.has(p.actor.sessionId) || rows.some((s) => s.kind === 'worker' && !s.isTerminated && !known.has(s.id))) stop('resume-association-invalid', 'packet actor or another current worker lacks an active controller assignment');
  const source = git(a.before.source.root, r), associated = association(a.target.association, run);
  // Replacement handoff checks need the old actor's lifecycle; use the rows observed just above.
  const ts = { ...services.transitions, observeSession: (id) => rows.find((s) => s.id === id), profileObservation: redactAOProfile(r.run(ao.tool.file, ['project', 'get', run.aoProjectId, '--json'], projectRoot, true, redactAOProfile)),
    beforeForAction(ref) { const row = view.state.history.find((row) => row.event.position === 'before' && same(row.event.intent.request ?? null, ref)); if (!row) stop('resume-pair-conflict', 'missing retained launch-before'); return row.sha256; },
    observeGit(root, args, binary = false, status = false) { const b = r.run('/usr/bin/git', ['-C', root, ...args], root); return status ? 0 : binary ? b : b.toString('utf8'); },
    verifyAssociation(a) { reservedAssociation(a, view, run, { live: true }); },
    observeWorktree(expected) { const g = git(expected.path, r); return { path: g.root, gitDir: g.gitDir, gitCommonDir: g.gitCommonDir, branchRef: g.branchRef, commit: g.commit, tree: g.tree, dirty: g.dirty }; } };
  const actual = transitionSnapshot({ q, run, canonical, action: a, observation: { identity: { source }, associations: [{ reference: a.target.association, value: associated }] } }, ts);
  validateReleasedContext({ actionRef: before.event.intent.request, packet, canonical, actual, view }, ts);
  const current = readRuntime(projectRoot), observedAtMs = Date.now();
  if (!same(current.state.run, run) || observedAtMs < current.lastObservedAtMs) stop('resume-clock-rollback', 'run/clock changed during packet observations');
  if (runExpired(run, observedAtMs)) stop('transition-budget-exhausted', 'original limit expired during packet observations');
  return { status: 'released-context-current', releaseBeforeEventSha256: before.sha256, deliveryAfterEventSha256: delivered.sha256, receipts: r.refs, executable: false,
    clock: { runId: run.runId, startedAtMs: run.startedAtMs, ...(run.schemaVersion === 2 ? { schemaVersion: 2, budget: run.budget } : { deadlineMs: run.deadlineMs }), lastObservedAtMs: current.lastObservedAtMs, observedAtMs } };
}
