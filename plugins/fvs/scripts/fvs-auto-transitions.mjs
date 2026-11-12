// Finite controller protocol. No AO/provider/backend work runs on import.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requestControl, parseExecution, createExecution, runControl, runExpired, unbudgetedRun, runExecutionFields, runOwned, assertRunning, initializeOwnedWork, closeOwnedWork, observeOwnedWork } from './fvs-execution.mjs';
import { memoryDataSnapshot, memoryHash, MEMORY_LIMITS } from './fvs-project-memory.mjs';
import { duplicateKeys } from './fvs-lean-graph.mjs';
import { recordValidatedResponse } from './fvs-spec-review.mjs';
import { readChain, registryStatus, validatePlan, contextOf, contractProblems, candidateOf, reviewProblems } from './fvs-contract-registry.mjs';
import { readAcceptedStore, inspectAutoBaselineArtifacts, inspectAutoProvisional, extractionContext } from './fvs-checker-auto.mjs';

export class TransitionError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
const stop = (code, message, details) => { throw new TransitionError(code, message, details); };
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
const SHA = /^[0-9a-f]{64}$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// AO launch/release/terminate calls get their own bound, separate from short metadata observations: a real
// `ao spawn` creates a worktree and starts an agent, which takes seconds and much longer under load.
export const ADMINISTRATIVE_TIMEOUT_MS = 120000;
const text = (v) => typeof v === 'string' && v.trim() !== '';
const isSha = (v) => typeof v === 'string' && SHA.test(v);
const isUuid = (v) => typeof v === 'string' && UUID.test(v);
export const transitionData = (v) => JSON.parse(JSON.stringify(memoryDataSnapshot(v)));
export const transitionSame = (a, b) => memoryHash(a) === memoryHash(b);
const same = transitionSame;
function closed(v, keys, label) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some((k) => !Object.hasOwn(v, k))) stop('transition-invalid-input', 'invalid closed ' + label);
}
export function transitionBytes(file) {
  try {
    if (!text(file) || !path.isAbsolute(file) || fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()) throw new Error('not a canonical regular file');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
  } catch (e) { stop('transition-evidence-invalid', 'required regular input unavailable: ' + String(file)); }
}
export function transitionJson(bytes) {
  try {
    const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (duplicateKeys(s).length) throw new Error('duplicate keys');
    return transitionData(JSON.parse(s));
  } catch (e) { stop('transition-invalid-input', 'invalid complete JSON data: ' + e.message); }
}
export function transitionBound(ref, json = true) {
  closed(ref, ['file', 'sha256'], 'evidence reference');
  if (!isSha(ref.sha256)) stop('transition-evidence-invalid', 'invalid bound digest');
  const b = transitionBytes(ref.file);
  if (hash(b) !== ref.sha256) stop('transition-evidence-invalid', 'bound bytes changed: ' + ref.file);
  return json ? transitionJson(b) : b;
}
export function transitionSave(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return { file, sha256: hash(transitionBytes(file)) };
}
export function readRuntimeObservation(e) {
  if (!Object.hasOwn(e, 'observationInput')) return e.observation;
  if (e.observation !== null || !e.intent?.request) stop('resume-history-invalid', 'bound observation is only the explicit22 event extension');
  const ref = e.observationInput;
  closed(ref, ['file', 'sha256'], 'observation reference');
  try {
    if (!text(ref.file) || !path.isAbsolute(ref.file) || fs.lstatSync(ref.file).size > MEMORY_LIMITS.maxBytes) stop('resume-history-invalid', 'observation exceeds the unchanged byte bound');
    return transitionBound(ref);
  } catch (error) {
    if (error.code === 'resume-history-invalid') throw error;
    stop('resume-evidence-invalid', 'bound observation is missing, malformed, aliased or changed');
  }
}
function canonicalStore(root) {
  if (!text(root) || !path.isAbsolute(root) || path.resolve(root) !== root || (fs.existsSync(root) ? fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory() : fs.realpathSync(path.dirname(root)) !== path.dirname(root))) stop('transition-context-unavailable', 'canonical explicit store directory required');
}
const SNAPSHOT_KEYS = ['fixed', 'source', 'worker', 'registry', 'baseline', 'store'];
function snapshotValid(s, version = 1) {
  closed(s, SNAPSHOT_KEYS, 'transition snapshot');
  if (!s.fixed || !s.source) stop('transition-invalid-input', 'missing fixed/source identities');
  if (version !== 2 && (Object.hasOwn(s.fixed, 'schemaVersion') || Object.hasOwn(s.fixed, 'budget') || Object.hasOwn(s.fixed, 'memory'))) stop('transition-invalid-input', 'mixed legacy fixed context');
  if (version === 2) {
    closed(s.fixed, ['schemaVersion','runId','canonicalRoot','gitCommonDir','projectId','stateHome','aoTool','coordinatorSessionId','controllerProfile','choicesGeneration','agreementContextSha256','scopeSha256','limitsSha256','startedAtMs','budget','memory','authorization','profile','extraction','graph','plan'], 'v2 fixed context');
    if (s.fixed.schemaVersion !== 2) stop('transition-invalid-input', 'mixed snapshot versions');
    runControl(s.fixed);
    closed(s.fixed.memory, s.fixed.memory?.mode === 'disabled' ? ['mode'] : ['mode','bindingSha256'], 'memory disposition');
    if (!['disabled','beads'].includes(s.fixed.memory.mode) || (s.fixed.memory.mode === 'beads' && !isSha(s.fixed.memory.bindingSha256))) stop('transition-invalid-input', 'invalid memory disposition');
  }
  closed(s.source, ['root', 'commit', 'tree', 'branchRef', 'gitCommonDir', 'dirty'], 'source identity');
  if (!text(s.source.root) || !/^[0-9a-f]{40}$/.test(s.source.commit ?? '') || !/^[0-9a-f]{40}$/.test(s.source.tree ?? '') || s.source.dirty !== false) stop('transition-context-unavailable', 'source must be a known clean immutable identity');
  if (s.baseline !== null) transitionBound(s.baseline);
  if (s.registry !== null) { closed(s.registry, ['root', 'headSha256', 'pending', 'nodes'], 'registry observation'); canonicalStore(s.registry.root); }
  if (s.store !== null) { closed(s.store, ['root', 'headSha256', 'pending', 'heads'], 'historical store observation'); canonicalStore(s.store.root); }
}
export const lifecycleOnlyAction = a => a?.schemaVersion === 2 && a.kind === 'terminate';
// AO's session kill may remove the stopped worker's worktree. A stop or its resolution then records the retained
// last-known identity with absent:true; a controller building a stop's before uses this same shape. The resume
// observer alone decides when an absence is admitted. Nothing is deleted or recreated.
export const absentWorktree = (w) => ({ path: w.path, gitDir: w.gitDir, gitCommonDir: w.gitCommonDir, branchRef: w.branchRef, commit: w.commit, tree: w.tree, dirty: null, absent: true });
const resolving =(a) => a.kind === 'terminate' && a.target.operation === 'resolve-terminated-reservation';
function registryInvocation(ref) {
  const i = transitionBound(ref);
  closed(i, ['schema', 'schemaVersion', 'plan', 'graph', 'registry', 'specRoot', 'contract', 'review', 'previous'], 'registry invocation');
  if (i.schema !== 'fvs/auto-registry-invocation' || i.schemaVersion !== 1) stop('transition-registry-unverified', 'unsupported registry invocation schema/version');
  for (const key of ['plan', 'graph', 'contract', 'review']) transitionBound(i[key]);
  return i;
}
const KINDS = ['construct', 'launch', 'prepare-input', 'compose-spec', 'materialize-proof', 'registry-revise', 'freeze', 'check', 'accept', 'release', 'terminate', 'handoff'];
export function readTransitionAction(ref) {
  const a = transitionBound(ref);
  closed(a, ['schema', 'schemaVersion', 'runId', 'transitionId', 'reservationId', 'kind', 'stage', 'nodes', 'owner', 'expectedHeadSha256', 'before', 'target', 'authorization', 'profile', 'basis'], 'action');
  if (a.schema !== 'fvs/auto-transition-request' || ![1, 2].includes(a.schemaVersion) || ![a.runId, a.transitionId, a.reservationId].every(isUuid) || !KINDS.includes(a.kind)
    || !text(a.stage) || !text(a.owner) || !(a.expectedHeadSha256 === null || isSha(a.expectedHeadSha256)) || !Array.isArray(a.nodes) || a.nodes.some((n, i) => !Number.isSafeInteger(n) || n < 0 || (i && n <= a.nodes[i - 1]))) stop('transition-invalid-input', 'invalid finite action identity');
  snapshotValid(a.before, a.schemaVersion);
  transitionBound(a.authorization); transitionBound(a.profile);
  if (a.basis !== null) {
    closed(a.basis, a.basis.version === 2 ? ['version', 'beforeEventSha256', 'afterEventSha256', 'completion', 'workCompletion'] : ['beforeEventSha256', 'afterEventSha256', 'completion'], 'prior explanation');
    if (![a.basis.beforeEventSha256, a.basis.afterEventSha256].every(isSha)) stop('transition-invalid-input', 'invalid historical explanation hashes');
    transitionBound(a.basis.completion);
    if (a.basis.version === 2 && a.basis.workCompletion !== null) transitionBound(a.basis.workCompletion);
  }
  const keys = {
    construct: ['procedure'], launch: ['projectId', 'branchRef', 'assignmentId', 'selectionStage', 'invocation', 'startup', ...(a.schemaVersion === 2 ? ['resumeOf'] : [])],
    'prepare-input': ['sessionId', 'association', 'launch', 'startupAck', 'startupRequest', 'candidate'],
    'compose-spec': ['parent', 'candidates', 'files'], 'materialize-proof': ['parent', 'candidates', 'files'],
    'registry-revise': ['candidateSha256', 'review', 'request'], freeze: ['request'], check: ['request', 'nodes'], accept: ['request', 'node'],
    release: ['sessionId', 'association', 'packet', 'handle'], terminate: ['sessionId', 'association', ...(a.schemaVersion === 2 ? ['progress'] : []), ...(Object.hasOwn(a.target, 'operation') ? ['operation'] : [])], handoff: ['scope'],
  };
  closed(a.target, keys[a.kind], a.kind + ' target');
  if (a.kind === 'terminate' && Object.hasOwn(a.target, 'operation') && !['terminate-session', 'resolve-terminated-reservation'].includes(a.target.operation)) stop('transition-invalid-input', 'unsupported termination operation');
  if (lifecycleOnlyAction(a) && a.target.progress !== null) readKnownWork(a.target.progress);
  if (a.kind === 'registry-revise') registryInvocation(a.target.request);
  if (a.kind === 'launch') { startupValid(a.target.startup); if (a.schemaVersion === 2 && a.target.resumeOf !== null) transitionBound(a.target.resumeOf); }
  return a;
}
function authorize(a, canonical) {
  const g = transitionBound(a.authorization), p = transitionBound(a.profile), envelope = canonical.envelope;
  closed(g, ['schema', 'schemaVersion', 'agreementContextSha256', 'approvedPayloadSha256', 'execution', 'correspondence'], 'execution correspondence');
  if (g.schema !== 'fvs/auto-action-authorization' || g.schemaVersion !== 1 || g.agreementContextSha256 !== canonical.view.agreement.contextSha256
    || g.approvedPayloadSha256 !== envelope.approvedPayloadSha256 || envelope.payload.execution === null || !same(g.execution, envelope.payload.execution)
    || !Array.isArray(g.correspondence)) stop('transition-grant-required', 'current actual execution grant/content is required; no Boolean or remembered authority');
  const row = g.correspondence.find((r) => r.kind === a.kind);
  if (!row || !g.execution.actions.includes(row.action) || row.reference !== g.execution.reference) stop('transition-grant-required', 'action is not linked to an actual retained grant');
  closed(p, ['schema', 'schemaVersion', 'stages', 'source', 'controller'], 'selection manifest');
  const selectionStage = a.kind === 'launch' ? a.target.selectionStage : a.stage, stage = p.stages?.[selectionStage];
  const compatible = { specification: ['research', 'fc_spec'], review: ['spec_review'], proof: ['fc_proof_plan', 'fc_proof_execution'], extraction: ['extraction'] };
  if (a.kind === 'launch' && !compatible[a.stage]?.includes(selectionStage)) stop('transition-profile-required', 'select the actual applicable FVS role, not a stage-name/default model');
  if (p.schema !== 'fvs/auto-stage-profile' || p.schemaVersion !== 1 || !text(p.source) || !stage) stop('transition-profile-required', 'complete applicable explicit/persisted stage selection is required');
  closed(stage, ['harness', 'model', 'effort', 'provenance'], 'stage selection');
  if (![stage.harness, stage.model, stage.effort].every((s) => text(s) && /^[A-Za-z0-9][A-Za-z0-9/._:-]*$/.test(s)) || !text(stage.provenance)) stop('transition-profile-required', 'unknown or incomplete profile; no fallback');
  // These remain requested/resolved inputs, not independently observed identity.
  return { authorization: a.authorization, profile: a.profile, selectionStage, stage, provenance: 'requested/resolved inputs; effective child identity unknown unless independently observed' };
}
function sameExcept(before, actual, allowed) {
  for (const key of SNAPSHOT_KEYS) if (!allowed.includes(key) && !same(before[key], actual[key])) stop('transition-extra-drift', 'unexpected ' + key + ' change');
}
function proofInvocation(launch, now = Date.now()) {
  if (launch.stage !== 'proof') { if (launch.target.invocation !== null) stop('transition-invalid-input', 'only proof roles use a proof-invocation clock'); return; }
  const clock = transitionBound(launch.target.invocation), run = launch.before.fixed;
  if (launch.schemaVersion === 2) {
    closed(clock, ['schema','schemaVersion','runId','invocationId','execution'], 'v2 proof invocation');
    if (clock.schema !== 'fvs/auto-proof-invocation' || clock.schemaVersion !== 2 || clock.runId !== run.runId || !isUuid(clock.invocationId) || !same(parseExecution(clock.execution), runControl(run))) stop('transition-invalid-input', 'proof invocation lost original run policy');
    if (runExpired(run, now)) stop('transition-invocation-exhausted', 'selected original budget exhausted');
    return clock;
  }
  closed(clock, ['schema', 'schemaVersion', 'runId', 'invocationId', 'startedAtMs', 'budgetMs', 'deadlineMs'], 'proof invocation');
  if (clock.schema !== 'fvs/auto-proof-invocation' || clock.schemaVersion !== 1 || clock.runId !== run.runId || !isUuid(clock.invocationId)
    || !Number.isSafeInteger(clock.startedAtMs) || clock.startedAtMs < run.startedAtMs || clock.startedAtMs > now || !Number.isSafeInteger(clock.budgetMs)
    || clock.budgetMs < 60000 || clock.budgetMs > 4 * 3600000 || clock.budgetMs % 60000 !== 0
    || clock.deadlineMs !== Math.min(run.deadlineMs, clock.startedAtMs + clock.budgetMs)) stop('transition-invalid-input', 'proof invocation cannot reset the original clock or invent a node deadline');
  if (now >= clock.deadlineMs) stop('transition-invocation-exhausted', 'checkpoint this invocation within the remaining original run budget');
  return clock;
}
// Head/chain facts only for stopping owned work. These never establish proof validity.
function lifecycleStore(root) {
  canonicalStore(root);
  if(!fs.existsSync(root))return{root,headSha256:null,pending:false,heads:null};
  const dir=path.join(root,'records'),names=fs.existsSync(dir)?fs.readdirSync(dir).sort():[];
  if(names.length>100000)stop('transition-context-unavailable','store metadata exceeds inventory bound');
  let head=null;
  for(const[index,name]of names.entries()){
    const match=/^(\d{6})-([0-9a-f]{64})\.json$/.exec(name),bytes=transitionBytes(path.join(dir,name)),record=transitionJson(bytes);
    if(!match||Number(match[1])!==index||hash(bytes)!==match[2]||record.schema!=='fvs-checker/accepted-event'||record.version!==1||record.seq!==index||record.prev!==head)stop('transition-context-unavailable','unverified store chain metadata');
    head=match[2];
  }
  if(!same(names,fs.existsSync(dir)?fs.readdirSync(dir).sort():[]))stop('transition-extra-drift','store metadata changed while observing');
  return{root,headSha256:head,pending:fs.existsSync(path.join(root,'lock'))||fs.readdirSync(root).some(n=>n.startsWith('.tmp-')),heads:null};
}
function verifyStopScope(a,actual,view,{requireStopped=false}={}) {
  const association=transitionBound(a.target.association),reservation=view.reservations.get(association.reservationId);
  if(!reservation||(reservation.state!=='active'&&!(resolving(a)&&reservation.state==='closed'&&view.transitions.get(a.transitionId)?.after))||reservation.sessionId!==a.target.sessionId||reservation.intent.effect.kind!=='ao-launch'||reservation.intent.effect.assignmentId!==association.assignmentId||reservation.intent.owner!==a.owner||!same(reservation.intent.nodes,association.nodes))stop('transition-actor-mismatch','stop is not the exact retained active assignment');
  if(a.target.progress===null){
    if(requireStopped&&view.state.history.some(row=>row.event.position==='before'&&row.event.intent.request&&(()=>{const old=readTransitionAction(row.event.intent.request);return old.kind==='release'&&transitionBound(old.target.association).reservationId===association.reservationId;})()))stop('transition-owned-work-uncertain','released or uncertain delivery needs its exact known-work handoff');
    return null;
  }
  const p=readKnownWork(a.target.progress),packet=readWorkPacket(p.packet),launch=readTransitionAction(packet.launch);
  if(p.actor.sessionId!==a.target.sessionId||p.actor.assignmentId!==association.assignmentId||p.actor.reservationId!==association.reservationId||p.runId!==a.runId||!same(launch.nodes,association.nodes)||!same(p.actor.worktree.path,association.worktree.path))stop('transition-progress-invalid','handoff is not this owned assignment');
  const issued=view.state.history.find(row=>row.event.position==='before'&&row.event.intent.request&&same(row.event.intent.request,packet.launch));
  if(!issued||issued.sha256!==packet.beforeEventSha256)stop('transition-progress-invalid','handoff launch is not retained in this run');
  const scope=observeOwnedWork(p.packet,p.actor);
  if(requireStopped&&(!scope.closed||scope.status!=='quiescent'))stop('transition-owned-work-uncertain','known SWVF work is not conclusively sealed and quiescent',{scope});
  return p;
}

export function verifyTaskHandoff(a,view,services) {
  if(a.schemaVersion!==2||a.kind!=='launch'||a.target.resumeOf===null)return;
  const p=readTaskProgress(a.target.resumeOf),oldPacket=readWorkPacket(p.packet),oldLaunch=readTransitionAction(oldPacket.launch),reserved=view.reservations.get(p.actor.reservationId);
  if(p.runId!==a.runId||!same(p.context,actionTaskContext(a))||!same(oldLaunch.nodes,a.nodes)||oldLaunch.stage!==a.stage||oldLaunch.owner!==a.owner
    ||a.reservationId===p.actor.reservationId||a.target.assignmentId===p.actor.assignmentId||a.before.fixed.startedAtMs!==oldLaunch.before.fixed.startedAtMs)stop('transition-handoff-stale','replacement must retain exact task/context/original policy and use a new assignment');
  const session=services.observeSession?.(p.actor.sessionId);
  if(!reserved||reserved.state!=='closed'||reserved.sessionId!==p.actor.sessionId||session?.id!==p.actor.sessionId||session.projectId!==a.before.fixed.projectId||session.isTerminated!==true)stop('transition-replacement-blocked','old session/reservation is not conclusively stopped and closed');
  const resolution=view.state.history.find(row=>row.event.position==='after'&&row.event.outcome==='succeeded'&&row.event.intent.effect.kind==='reservation-resolution'&&row.event.intent.effect.targetReservationId===p.actor.reservationId
    &&row.event.effect.resolution?.reason==='session-terminated'&&same(transitionBound(row.event.effect.resolution.evidence).progress,a.target.resumeOf));
  const scope=observeOwnedWork(p.packet,p.actor);
  if(!resolution||!scope.closed||scope.status!=='quiescent')stop('transition-replacement-blocked','exact handoff closure and fresh known-work quiescence required',{scope});
  if(oldLaunch.target.resumeOf!==null&&transitionBound(oldLaunch.target.resumeOf).schema==='fvs/auto-task-progress'){
    const prior=readTaskProgress(oldLaunch.target.resumeOf),key=b=>b&&({kind:b.kind,description:b.description});
    if(p.blocker!==null&&same(key(p.blocker),key(prior.blocker))&&p.blockerResolution===null)stop('transition-replan-required','persistent same blocker requires decomposition/helper/specification review, not another blind restart');
  }
}


export function transitionSnapshot({ q, run, canonical, observation, action }, services = {}) {
  const stopping=lifecycleOnlyAction(action);
  const b = action.before, root = q.inputs.baseline === null ? null : transitionBound(q.inputs.baseline).registry?.root;
  const registryRoot = root ?? b.registry?.root ?? null;
  if (root && b.registry && root !== b.registry.root) stop('transition-extra-drift', 'baseline/registry location changed');
  let registry = null, store = null;
  if (registryRoot !== null) {
    const c = (services.readRegistry ?? readChain)(registryRoot);
    const status = !stopping && q.inputs.plan && q.inputs.graph ? (services.registryStatus ?? registryStatus)({ plan: q.inputs.plan.file, graph: q.inputs.graph.file, registry: registryRoot, 'spec-root': q.source.root }) : null;
    registry = { root: registryRoot, headSha256: c.records.at(-1)?.sha ?? null, pending: !!c.pending || status?.code === 'pending', nodes: stopping ? null : status?.nodes ?? {} };
  }
  if (q.inputs.acceptedStore !== null) {
    if(stopping)store=lifecycleStore(q.inputs.acceptedStore.root);
    else {
    const c = (services.readStore ?? readAcceptedStore)(q.inputs.acceptedStore.root);
    store = { root: q.inputs.acceptedStore.root, headSha256: c.headSha256, pending: false,
      heads: [...c.heads].map(([node, row]) => ({ node, sha256: row.sha256, integrated: row.record.integrated, frozenSha256: row.record.frozenSha256, registryHeadSha256: row.record.registryHeadSha256, dependencies: row.record.dependencies })).sort((a, b) => a.node - b.node) };
  }
    }
  if (q.inputs.baseline !== null && !stopping && !runExpired(run)) (services.inspectBaseline ?? inspectAutoBaselineArtifacts)({ baseline: q.inputs.baseline, ...runExecutionFields(run) });
  const source = observation.identity.source;
  const actorId = action.target.sessionId ?? q.transition?.effect?.sessionId ?? null;
  let worker = null;
  if (actorId) {
    const a = observation.associations.find((a) => a.value.sessionId === actorId)?.value;
    if (!a) stop('transition-actor-mismatch', 'the intended actor has no retained association');
    services.verifyAssociation?.(a);
    if (a.scopeRelation !== 'run-assignment' || a.owner !== action.owner || (action.nodes.length && !same(a.nodes, action.nodes))) stop('transition-actor-mismatch', 'action is not the exact reserved assignment/owner');
    worker = { sessionId: a.sessionId, assignmentId: a.assignmentId, reservationId: a.reservationId, worktree: services.observeWorktree(a.worktree), profile: a.rulesProfile };
  }
  const profile = services.profileObservation;
  if (!profile || !same(profile, transitionBound(action.profile).controller) || profile.projectId !== run.aoProjectId || profile.path !== run.canonicalRoot) stop('transition-profile-required', 'current AO configuration differs/unavailable; no profile fallback');
  return { fixed: { runId: run.runId, canonicalRoot: run.canonicalRoot, gitCommonDir: run.gitCommonDir, projectId: run.aoProjectId, stateHome: run.aoStateHome, aoTool: q.ao.tool, coordinatorSessionId: run.coordinatorSessionId, controllerProfile: profile,
    choicesGeneration: run.choicesGeneration, agreementContextSha256: run.agreementContextSha256, scopeSha256: memoryHash(run.scope), limitsSha256: memoryHash(run.limits), startedAtMs: run.startedAtMs, ...(run.schemaVersion === 2 ? { schemaVersion: 2, budget: run.budget, memory: run.memory.mode === 'disabled' ? { mode: 'disabled' } : { mode: 'beads', bindingSha256: q.memoryRequest.expected.bindingSha256 } } : { deadlineMs: run.deadlineMs, memoryBindingSha256: q.memoryRequest.expected.bindingSha256 }), authorization: action.authorization, profile: action.profile,
    extraction: q.inputs.extraction, graph: q.inputs.graph, plan: q.inputs.plan },
    source: { root: source.root, commit: source.commit, tree: source.tree, branchRef: source.branchRef, gitCommonDir: source.gitCommonDir, dirty: source.dirty },
    worker, registry, baseline: q.inputs.baseline, store };
}

export function redactAOProfile(bytes) {
  const response = transitionJson(bytes), p = response.project;
  if (!p || !text(p.id) || !text(p.path) || !Object.hasOwn(p, 'config')) stop('transition-profile-required', 'unknown/partial AO project configuration');
  return { projectId: p.id, path: p.path, configSha256: memoryHash({ agent: p.agent ?? null, config: p.config }),
    observation: 'current CLI configuration fingerprint; omitted effort/effective child identity remain unknown' };
}

function receiptArgv(evidence, script, command, request) {
  transitionBound(request);
  const argv = evidence.command.argv;
  if (argv.length !== 7 || argv[0] !== fs.realpathSync(process.execPath) || argv[1] !== script.file || argv[2] !== command || argv[3] !== '--request' || argv[4] !== request.file || argv[5] !== '--out' || !path.isAbsolute(argv[6])) stop('transition-command-unverified', 'not the exact trusted producer/request/output argv');
  transitionBound(script, false);
}
// Production readers below are fixed by the installed controller, never JSON
// callbacks or a worker-selected success service.
export function transitionValidators({ tools, git, inspectBaseline = inspectAutoBaselineArtifacts, inspectCheck = inspectAutoProvisional, readStore = readAcceptedStore }) {
  return {
    verifyConstruction(a, actual, evidence) {
      const context = extractionContext(evidence.result.extraction);
      if (context.identity.json.provenance.sourceCommit !== a.before.source.commit || !same(evidence.result.inputs, { extraction: actual.fixed.extraction, graph: actual.fixed.graph, plan: actual.fixed.plan })
        || !same(evidence.result.extraction.identity, actual.fixed.extraction) || !same(evidence.result.extraction.graph, actual.fixed.graph) || !same(evidence.result.extraction.plan, actual.fixed.plan)) stop('transition-construction-unverified', 'construction must reproduce10/21/13 from the selected source/configuration');
    },
    verifyTarget(a, actual) {
      if (a.kind === 'prepare-input') {
        closed(a.target.candidate, ['commit', 'expectedTree'], 'immutable prepared candidate');
        if (![a.target.candidate.commit, a.target.candidate.expectedTree].every((v) => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v))) stop('transition-preparation-unverified', 'preparation requires exact commit/tree object IDs');
      }
      if (['compose-spec', 'materialize-proof'].includes(a.kind)) {
        if (a.target.parent !== actual.source.commit) stop('transition-materialization-unverified', 'candidate composition parent is stale');
        this.verifyCandidateInputs(a);
      }
      if (a.kind === 'launch' && (a.target.projectId !== actual.fixed.projectId || !/^refs\/heads\/[A-Za-z0-9/_-]+$/.test(a.target.branchRef ?? '') || !isUuid(a.target.assignmentId))) stop('transition-actor-mismatch', 'invalid launch target');
      if (['prepare-input', 'release', 'terminate'].includes(a.kind)) {
        const association = transitionBound(a.target.association);
        if (!actual.worker || association.sessionId !== actual.worker.sessionId || association.assignmentId !== actual.worker.assignmentId || association.reservationId !== actual.worker.reservationId || association.runId !== a.runId
          || association.owner !== a.owner || association.scopeRelation !== 'run-assignment') stop('transition-actor-mismatch', 'not the retained owned assignment');
      }
      if (['freeze', 'check', 'accept'].includes(a.kind)) {
        const job = transitionBound(a.target.request), s = job.source ?? job.baseline?.source;
        if (!s || s.root !== actual.source.root || s.commit !== actual.source.commit || s.expectedTree !== actual.source.tree || (a.schemaVersion === 2 ? job.version !== 2 : (Object.hasOwn(job,'version') && job.version !== 1) || Object.hasOwn(job,'execution')) || (a.schemaVersion === 2 ? !same(requestControl(job), runControl(actual.fixed)) || runExpired(actual.fixed) : !Number.isSafeInteger(job.deadlineMs) || job.deadlineMs > actual.fixed.deadlineMs || job.deadlineMs <= Date.now())) stop('transition-target-stale', 'producer must bind exact current source and remaining original deadline');
        if (a.kind === 'freeze') {
          if (!same(job.registry, { root: actual.registry?.root, headSha256: actual.registry?.headSha256 }) || !same(job.extraction.identity, actual.fixed.extraction) || !same(job.extraction.graph, actual.fixed.graph) || !same(job.extraction.plan, actual.fixed.plan)) stop('transition-target-stale', 'freeze is for another extraction/registry');
        } else if (!same(job.baseline, actual.baseline)) stop('transition-target-stale', 'producer is for another frozen context');
        if (a.kind === 'check' && !same(job.nodes, a.target.nodes)) stop('transition-target-stale', 'check nodes differ');
        if (a.kind === 'accept') {
          if (!same(job.store, { root: actual.store?.root, expectedHeadSha256: actual.store?.headSha256 }) || job.node !== a.target.node) stop('transition-target-stale', 'accept target/head differs');
          this.verifyProofLaunch({ ...a, stage: 'proof', nodes: [job.node] }, actual);
        }
      }
      if (a.kind === 'registry-revise') {
        const i = registryInvocation(a.target.request);
        if (i.registry !== actual.registry?.root || i.specRoot !== actual.source.root || !same(i.plan, actual.fixed.plan) || !same(i.graph, actual.fixed.graph) || !same(i.review, a.target.review)) stop('transition-target-stale', 'registry producer cannot change target stores/context');
      }
    },
    verifyLaunch(a, before, actual, evidence) {
      const launch = evidence.result;
      if (!actual.worker || launch.session?.id !== actual.worker.sessionId || launch.session.projectId !== actual.fixed.projectId || readRuntimeObservation(evidence.beforeEvent).ao.some((s) => s.id === actual.worker.sessionId)
        || actual.worker.assignmentId !== a.target.assignmentId || actual.worker.reservationId !== a.reservationId || actual.worker.worktree.branchRef !== a.target.branchRef) stop('transition-launch-unverified', 'no exact returned session/controller Git association');
      if (!same(evidence.command.argv, [tools.ao.file, ...launchArguments(a, evidence.actionRef, evidence.completion.beforeEventSha256)])) stop('transition-command-unverified', 'not the exact stock AO launch');
      transitionBound(tools.ao, false);
    },
    verifyCandidateInputs(a) {
      if (!Array.isArray(a.target.candidates) || !a.target.candidates.length || !a.target.files || typeof a.target.files !== 'object') stop('transition-materialization-unverified', 'bound candidate/content manifest required');
      const available = new Map();
      const owners = new Map();
      for (const candidate of a.target.candidates) {
        closed(candidate, ['commit', 'tree', 'files', 'assignment'], 'candidate commit');
        const assignment = transitionBound(candidate.assignment);
        this.verifyCandidateAssignment(candidate.assignment, a.kind === 'materialize-proof' ? 'proof' : 'specification');
        if (assignment.worktree.commit !== candidate.commit || assignment.worktree.tree !== candidate.tree) stop('transition-materialization-unverified', 'candidate is not its retained assignment source');
        for (const node of assignment.nodes) {
          if (owners.has(node) && owners.get(node) !== assignment.owner) stop('transition-materialization-unverified', 'duplicate node owners');
          owners.set(node, assignment.owner);
        }
        if (git(a.before.source.root, ['rev-parse', candidate.commit + '^{tree}']).trim() !== candidate.tree) stop('transition-materialization-unverified', 'candidate tree mismatch');
        for (const [file, sha256] of Object.entries(candidate.files)) {
          if (available.has(file) && available.get(file) !== sha256) stop('transition-materialization-unverified', 'sibling commits conflict');
          const content = git(a.before.source.root, ['show', candidate.commit + ':' + file], true);
          if (hash(content) !== sha256) stop('transition-materialization-unverified', 'candidate content differs'); available.set(file, sha256);
        }
      }
      for (const [file, sha256] of Object.entries(a.target.files)) {
        if (!text(file) || path.isAbsolute(file) || file.split('/').some((p) => !p || ['.', '..'].includes(p)) || available.get(file) !== sha256) stop('transition-materialization-unverified', 'unexplained candidate bytes');
      }
      if (a.kind === 'materialize-proof') {
        const frozen = transitionBound(a.before.baseline);
        if (Object.keys(a.target.files).some((n) => !frozen.overlayFiles.includes(n))) stop('transition-materialization-unverified', 'proof materialization changed a protected source/context');
      }
    },
    verifyMaterialization(a, before, actual) {
      this.verifyCandidateInputs(a);
      const parent = git(actual.source.root, ['rev-list', '--parents', '-n', '1', actual.source.commit]).trim().split(' ');
      if (parent.length !== 2 || parent[1] !== before.source.commit) stop('transition-materialization-unverified', 'composition is not based on the exact expected parent');
      const names = git(actual.source.root, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', actual.source.commit]).split('\0').filter(Boolean).sort();
      if (!same(names, Object.keys(a.target.files).sort()) || names.some((file) => hash(git(actual.source.root, ['show', actual.source.commit + ':' + file], true)) !== a.target.files[file])) stop('transition-materialization-unverified', 'unexpected/missing materialized content');
    },
    verifyRegistry(a, before, actual, evidence) {
      const committed = readChain(actual.registry.root).records.at(-1);
      if (!committed || committed.sha !== actual.registry.headSha256 || !same(committed.record, evidence.result.record)) stop('transition-registry-unverified', 'result is not the actual committed event body');
      const invocation = registryInvocation(a.target.request);
      const contract = transitionBound(invocation.contract), previous = before.registry.nodes[contract.node]?.head ?? null;
      const argv = [fs.realpathSync(process.execPath), tools.registry.file, previous === null ? 'register' : 'revise', '--plan', invocation.plan.file, '--graph', invocation.graph.file, '--registry', invocation.registry, '--spec-root', invocation.specRoot, '--contract', invocation.contract.file, '--review', invocation.review.file, ...(previous === null ? [] : ['--previous', previous])];
      if (invocation.schema !== 'fvs/auto-registry-invocation' || invocation.schemaVersion !== 1 || !same(evidence.command.argv, argv)
        || invocation.previous !== previous || invocation.registry !== before.registry.root || !same(invocation.review, a.target.review)
        || !same(invocation.plan, actual.fixed.plan) || !same(invocation.graph, actual.fixed.graph) || invocation.specRoot !== actual.source.root) stop('transition-registry-unverified', 'not the bound actual registry CLI invocation');
      transitionBound(tools.registry, false);
      const review = transitionBound(a.target.review);
      if (review.registryHeadSha256 !== before.registry.headSha256 || review.candidateSha256 !== a.target.candidateSha256 || !same(evidence.result.record.review, review)) stop('transition-registry-unverified', 'stale/different actual review');
    },
    verifyBaseline(a, actual, evidence) {
      if (evidence.result.authority !== 'expectations-only' || evidence.result.targetProofsChecked !== false) stop('transition-freeze-unverified', 'not a trusted expectations-only freeze');
      receiptArgv(evidence, tools.auto, 'freeze', a.target.request);
      const job = transitionBound(a.target.request), frozen = transitionBound(actual.baseline);
      if (!same(transitionBound(frozen.input), job) || frozen.controllerInput?.sha256 !== a.target.request.sha256 || job.baseline.source.commit !== actual.source.commit || job.baseline.source.expectedTree !== actual.source.tree || job.registry.headSha256 !== actual.registry.headSha256) stop('transition-freeze-unverified', 'freeze lost current source/registry/request bytes');
      transitionBound(frozen.controllerInput);
      inspectBaseline({ baseline: actual.baseline, ...runExecutionFields(actual.fixed) });
    },
    verifyCheck(a, actual, evidence) {
      if (evidence.result.status !== 'provisional' || evidence.result.authority !== 'provisional-only') stop('transition-check-unverified', 'worker/standalone verdict is not an auto provisional check');
      receiptArgv(evidence, tools.auto, 'check', a.target.request);
      const job = transitionBound(a.target.request);
      if (evidence.result.runId !== job.runId || evidence.result.controllerInput?.sha256 !== a.target.request.sha256 || !same(transitionBound(evidence.result.adapterInput), job)) stop('transition-check-unverified', 'provisional result is not this actual producer run/request');
      transitionBound(evidence.result.controllerInput);
      inspectCheck({ evidence: evidence.completion.result, baseline: actual.baseline,
        source: { commit: actual.source.commit, expectedTree: actual.source.tree }, nodes: a.target.nodes, ...runExecutionFields(actual.fixed) });
    },
    verifyAccept(a, before, actual, evidence) {
      if (evidence.result.status !== 'accepted' || evidence.result.authority !== 'canonical-checker') stop('transition-accept-unverified', 'not a canonical checker result');
      receiptArgv(evidence, tools.auto, 'accept', a.target.request);
      const job = transitionBound(a.target.request), c = readStore(actual.store.root), latest = c.records.at(-1);
      if (!latest || latest.sha256 !== actual.store.headSha256 || latest.record.prev !== before.store.headSha256 || latest.record.node !== a.target.node || !same(evidence.result.acceptedReceipt, { file: latest.file, sha256: latest.sha256 })
        || latest.record.runId !== job.runId || !same(latest.record.candidateCheck, job.candidateCheck) || latest.record.controllerInput?.sha256 !== a.target.request.sha256 || !same(transitionBound(latest.record.adapterInput), job)
        || latest.record.integrated.commit !== actual.source.commit || latest.record.integrated.tree !== actual.source.tree || latest.record.frozenSha256 !== actual.baseline.sha256 || latest.record.registryHeadSha256 !== actual.registry.headSha256) stop('transition-accept-unverified', 'publication is not the exact expected run/request/successor');
      transitionBound(latest.record.controllerInput);
    },
    verifyProofLaunch(a, actual) {
      if (a.stage !== 'proof') return;
      if (actual.baseline === null) stop('transition-proof-dependencies-unverified', 'proof work requires a validated frozen context');
      const baseline = inspectBaseline({ baseline: actual.baseline, ...runExecutionFields(actual.fixed) });
      if (!a.nodes.length || a.nodes.some((node) => !baseline.nodes.includes(node))) stop('transition-proof-dependencies-unverified', 'unknown proof scope');
      // The strict current inspector remains the authority for dependencies.
      if (actual.store?.pending || actual.registry?.pending) stop('transition-proof-dependencies-unverified', 'pending proof context');
      if (baseline.registry.root !== actual.registry?.root || baseline.registry.headSha256 !== actual.registry.headSha256) stop('transition-proof-dependencies-unverified', 'freeze is not for the current semantic context');
      for (const node of a.nodes) {
        if (!['machine-reviewed-provisional', 'recheck-required'].includes(actual.registry.nodes[node]?.state)) stop('transition-proof-dependencies-unverified', 'node lacks current semantic review');
        for (const dependency of baseline.dependencies[node]) {
          const row = actual.store?.heads.find((r) => r.node === dependency);
          if (!row || row.integrated.commit !== actual.source.commit || row.integrated.tree !== actual.source.tree || row.frozenSha256 !== actual.baseline.sha256 || row.registryHeadSha256 !== actual.registry.headSha256
            || row.dependencies.some((d) => actual.store.heads.find((r) => r.node === d.node)?.sha256 !== d.sha256)) stop('transition-proof-dependencies-unverified', 'helper lacks an exact current accepted receipt');
        }
      }
    },
    verifySelection(a, actual) {
      if (!actual.fixed.plan || !actual.fixed.graph) stop('transition-scope-unverified', 'supported selected13 scope is required');
      const plan = { json: transitionBound(actual.fixed.plan), sha256: actual.fixed.plan.sha256 }, graph = { json: transitionBound(actual.fixed.graph), sha256: actual.fixed.graph.sha256 }, view = validatePlan(plan, graph);
      if (view.problems.length || !a.nodes.length || a.nodes.some((id) => !view.union.has(id) || view.nodes.get(id)?.eligibility !== 'eligible')) stop('transition-scope-unverified', 'assigned nodes must belong to the supported selected13 union');
    },
    verifyResolution(a, actual, evidence) {
      const observed = evidence.result.session;
      if (!actual.worker || observed?.id !== a.target.sessionId || observed.projectId !== actual.fixed.projectId || observed.isTerminated !== true
        || this.observeSession(a.target.sessionId)?.isTerminated !== true) stop('transition-resolution-unverified', 'exact current owned termination is required; idle/delivery is insufficient');
    },
    verifyProtectedCheck(a, actual) {
      this.verifyProofLaunch({ ...a, stage: 'proof', nodes: a.target.nodes }, actual);
      if (!actual.store) stop('transition-protected-proof-required', 'protected recheck requires retained accepted proof history');
      const frozen = transitionBound(actual.baseline), history = readStore(actual.store.root);
      for (const node of a.target.nodes) {
        const target = frozen.targets.find((t) => t.node === node), mod = frozen.build.modules.find((m) => m.name === target?.module);
        const prior = [...history.records].reverse().find(({ record }) => {
          if (record.node !== node) return false;
          const old = transitionBound(record.baseline).targets.find((t) => t.node === node);
          return old?.name === target?.name && old?.module === target?.module;
        });
        if (!prior || !mod || frozen.overlayFiles.includes(mod.source) || !isSha(frozen.build.source.files[mod.source]?.sha256)
          || hash(git(actual.source.root, ['show', actual.source.commit + ':' + mod.source], true)) !== frozen.build.source.files[mod.source].sha256) stop('transition-protected-proof-required', 'recheck requires the exact previously accepted target in protected frozen source');
        const checked = transitionBound(prior.record.integratedCheck), oldBuild = checked.build;
        if (!oldBuild || !same(oldBuild.source?.files[mod.source], frozen.build.source.files[mod.source])) stop('transition-protected-proof-required', 'prior integrated proof bytes do not match this protected target');
      }
    },
    verifyRegistryBefore(a, actual) {
      const i = registryInvocation(a.target.request), contract = transitionBound(i.contract), review = transitionBound(a.target.review);
      const plan = { json: transitionBound(i.plan), sha256: i.plan.sha256 }, graph = { json: transitionBound(i.graph), sha256: i.graph.sha256 }, view = validatePlan(plan, graph);
      if (view.problems.length || !view.nodes.has(contract.node) || view.nodes.get(contract.node).eligibility !== 'eligible') stop('transition-registry-unverified', 'review publication needs a supported actual bound node');
      const context = contextOf(plan, graph, view, contract.node), chain = readChain(actual.registry.root);
      if (chain.pending) stop('transition-registry-unverified', 'registry publication is pending');
      if (context.role === 'out-of-scope' || contractProblems(contract, context, actual.source.root).length || candidateOf(contract, context) !== a.target.candidateSha256
        || i.previous !== (chain.heads.get(contract.node)?.sha ?? null) || (chain.records.at(-1)?.sha ?? null) !== actual.registry.headSha256
        || reviewProblems(review, a.target.review.file, contract, a.target.candidateSha256, chain).length
        || chain.records.some(({ record }) => record.review && (record.review.reviewer.runId === review.reviewer.runId || record.review.evidence.sha256 === review.evidence.sha256))) stop('transition-registry-unverified', 'fresh exact current-candidate independent unused review is required');
    },
    verifyWorkCandidate(a, prepared, result, actor) {
      const assignment = transitionBound(result.assignment), { dirty, ...worktree } = actor.worktree;
      this.verifyCandidateAssignment(result.assignment, a.kind === 'materialize-proof' ? 'proof' : 'specification');
      if (!same(assignment.worktree, worktree) || assignment.sessionId !== actor.sessionId || assignment.reservationId !== actor.reservationId || assignment.assignmentId !== actor.assignmentId
        || !same(assignment.rulesProfile, actor.profile) || !same(this.observeActor(actor), actor)
        || git(actor.worktree.path, ['merge-base', '--is-ancestor', prepared.commit, result.commit], false, true) !== 0) stop('transition-work-result-invalid', 'candidate is not independently observed progress of this exact owned assignment');
      this.verifyCandidateInputs(a);
      const changed = git(actor.worktree.path, ['diff', '--name-only', '-z', prepared.commit, result.commit]).split('\0').filter(Boolean).sort();
      if (!same(changed, Object.keys(result.files).sort())) stop('transition-work-result-invalid', 'actor changed unrecorded candidate paths');
    },
    verifyPreparation(a, before, actual, evidence) {
      const w = actual.worker?.worktree, old = before.worker?.worktree;
      const observeGit = this.observeGit ?? git;
      if (!w || !old || w.path !== old.path || w.gitDir !== old.gitDir || w.gitCommonDir !== old.gitCommonDir || w.branchRef !== old.branchRef || w.dirty || old.dirty
        || observeGit(w.path, ['merge-base', '--is-ancestor', old.commit, w.commit], false, true) !== 0) stop('transition-preparation-unverified', 'FF/association source checks failed');
      if (!same(evidence.command.argv, ['/usr/bin/git', '-C', old.path, '-c', 'core.hooksPath=/dev/null', 'merge', '--ff-only', a.target.candidate.commit])) stop('transition-command-unverified', 'not the exact owned FF argv');
      const actor = { projectId: actual.fixed.projectId, sessionId: actual.worker.sessionId, reservationId: actual.worker.reservationId,
        assignmentId: actual.worker.assignmentId, worktree: old, profile: actual.worker.profile };
      startupAcknowledgement({ actionRef: a.target.launch, acknowledgement: a.target.startupAck, actor, expectedMemoryRequest: a.target.startupRequest }, this);
    },
    verifyPreparationBefore(a, actual) {
      const w = actual.worker;
      if (!w || w.sessionId !== a.target.sessionId) stop('transition-preparation-unverified', 'missing assigned worker');
      const actor = { projectId: actual.fixed.projectId, ...w };
      verifyStartup({ actionRef: a.target.launch, acknowledgement: a.target.startupAck, actor, expectedMemoryRequest: a.target.startupRequest }, this);
      if (git(w.worktree.path, ['merge-base', '--is-ancestor', w.worktree.commit, a.target.candidate.commit], false, true) !== 0
        || git(w.worktree.path, ['rev-parse', a.target.candidate.commit + '^{tree}']).trim() !== a.target.candidate.expectedTree) stop('transition-preparation-unverified', 'candidate must be an exact known FF descendant');
    },
    verifyRelease(a, before, actual, evidence) {
      const argv = [tools.ao.file, ...releaseArguments({ actionRef: evidence.actionRef, packet: a.target.packet })];
      if (!same(evidence.command.argv, argv) || evidence.result.deliveryHandle !== a.target.handle || evidence.result.authority !== 'delivery-only') stop('transition-release-unverified', 'no exact delivery-only receipt; unknown execution retains capacity');
    },
    verifyTermination(a, before, actual, evidence) {
      if (!same(evidence.command.argv, [tools.ao.file, 'session', 'kill', a.target.sessionId, '--project', actual.fixed.projectId])
        || evidence.result.session?.id !== a.target.sessionId || evidence.result.session.projectId !== actual.fixed.projectId || evidence.result.session.isTerminated !== true
        || this.observeSession(a.target.sessionId)?.isTerminated !== true) stop('transition-termination-unverified', 'fresh exact owned-session termination required');
    },
  };
}
function completionFor(a, ref, before, history) {
  if (resolving(a)) {
    const association = transitionBound(a.target.association);
    if (before.event.intent.effect.kind !== 'reservation-resolution' || before.event.intent.effect.targetReservationId !== association.reservationId) stop('transition-action-mismatch', 'resolution lost its exact retained reservation');
    return { completion: { beforeEventSha256: before.sha256 }, result: transitionBound(ref), command: null, actionRef: before.event.intent.request, beforeEvent: before.event };
  }
  const c = transitionBound(ref);
  closed(c, ['schema', 'schemaVersion', 'runId', 'transitionId', 'reservationId', 'actionSha256', 'beforeEventSha256', 'command', 'result'], 'effect completion');
  if (c.schema !== 'fvs/auto-transition-completion' || c.schemaVersion !== a.schemaVersion || c.runId !== a.runId || c.transitionId !== a.transitionId || c.reservationId !== a.reservationId
    || c.actionSha256 !== memoryHash(a) || c.beforeEventSha256 !== before.sha256) stop('transition-completion-mismatch', 'completion is not for this exact retained before/action');
  const cmd = transitionBound(c.command), result = transitionBound(c.result);
  closed(cmd, ['schema', 'schemaVersion', 'runId', 'transitionId', 'actionSha256', 'argv', 'cwd', 'env', 'tool', 'startedAtMs', 'endedAtMs', 'exitCode', 'signal', 'error', 'stdout', 'stderr', ...(a.schemaVersion === 2 ? ['execution','supervision'] : [])], 'command receipt');
  if (cmd.schema !== 'fvs/auto-command-receipt' || cmd.schemaVersion !== a.schemaVersion || cmd.runId !== a.runId || cmd.transitionId !== a.transitionId || cmd.actionSha256 !== memoryHash(a)
    || !Array.isArray(cmd.argv) || !cmd.argv.length || !cmd.argv.every(text)
    || !(cmd.exitCode === 0 || (a.kind === 'registry-revise' && cmd.exitCode === 6 && result.code === 'recorded' && ['changes-requested', 'needs-review', 'needs-semantic-review', 'recheck-required'].includes(result.record?.state))) || cmd.signal !== null || cmd.error !== null
    || !Number.isSafeInteger(cmd.startedAtMs) || !Number.isSafeInteger(cmd.endedAtMs) || (!unbudgetedRun(a.before.fixed) && cmd.endedAtMs < cmd.startedAtMs)) stop('transition-command-unverified', 'no definite successful effect receipt');
  if ((!unbudgetedRun(a.before.fixed) && (cmd.startedAtMs < before.event.observedAtMs || cmd.endedAtMs > Date.now())) || cmd.cwd !== a.before.source.root || !cmd.env || Object.keys(cmd.env).some((k) => !['PATH', 'LANG', 'LC_ALL', 'HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_NO_LAZY_FETCH', 'GIT_NO_REPLACE_OBJECTS', 'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT', 'DISABLE_TELEMETRY', 'DO_NOT_TRACK', ...(a.schemaVersion === 2 ? ['FVS_OWNED_EXECUTION_SCOPE'] : [])].includes(k))
    || cmd.env.GIT_NO_LAZY_FETCH !== '1') stop('transition-command-unverified', 'command time/cwd/offline allowlisted environment is not bound to this before');
  if (a.schemaVersion === 2 && (!same(parseExecution(cmd.execution), runControl(a.before.fixed)) || cmd.supervision.cancelled || cmd.supervision.timedOut || cmd.supervision.cleanupComplete !== true)) stop('transition-command-unverified', 'v2 command lacks conclusive owned execution');
  transitionBound(cmd.tool, false); transitionBound(cmd.stdout, false); transitionBound(cmd.stderr, false);
  if (cmd.argv[0] !== cmd.tool.file) stop('transition-command-unverified', 'command lost actual executable binding');
  // An after-event is the sole consumer of this completion; replay is handled
  if (history.some((r) => r.event.position === 'after' && r.event.beforeEventSha256 !== before.sha256 && r.event.effect.evidence.some((e) => same(e, ref)))) stop('transition-completion-replayed', 'completion already belongs to another transition');
  return { completion: c, command: cmd, result, actionRef: before.event.intent.request, beforeEvent: before.event };
}
// Read-only consumers reuse the exact protocol validators, never a verdict flag.
export { completionFor as readTransitionCompletion, authorize as verifyTransitionAuthorization };
function validateDelta(a, before, actual, evidence, services) {
  snapshotValid(actual, a.schemaVersion);
  const stages = ['extraction', 'graph', 'plan'];
  const fixed = (v) => Object.fromEntries(Object.entries(v).filter(([k]) => a.kind !== 'construct' || !stages.includes(k)));
  if (!same(fixed(before.fixed), fixed(actual.fixed))) stop('transition-extra-drift', 'fixed scope/grant/profile/actor/memory identities changed');
  const result = evidence.result;
  switch (a.kind) {
    case 'construct': {
      const rest = (v) => ({ ...v, fixed: fixed(v.fixed) });
      sameExcept(rest(before), rest(actual), []);
      if (before.baseline !== null || before.registry?.headSha256 != null || before.store?.headSha256 != null || stages.some((k) => before.fixed[k] !== null || actual.fixed[k] === null)) stop('transition-construction-unverified', 'only initial empty-to-bound stage inputs are admitted');
      services.verifyConstruction(a, actual, evidence); return 'launch';
    }
    case 'launch': {
      sameExcept(before, actual, ['worker']);
      if (before.worker !== null) stop('transition-launch-unverified', 'launch cannot replace an existing assignment');
      services.verifyLaunch(a, before, actual, evidence); return 'prepare-input';
    }
    case 'prepare-input': {
      sameExcept(before, actual, ['worker']);
      if (!actual.worker || actual.worker.sessionId !== a.target.sessionId || actual.worker.worktree.commit !== a.target.candidate.commit || actual.worker.worktree.tree !== a.target.candidate.expectedTree) stop('transition-preparation-unverified', 'not the exact prepared worker input');
      services.verifyPreparation(a, before, actual, evidence); return 'release';
    }
    case 'compose-spec': case 'materialize-proof': {
      sameExcept(before, actual, a.kind === 'compose-spec' ? ['source', 'registry'] : ['source']);
      if (a.kind === 'compose-spec') {
        const immutableHead = (r) => r === null ? null : { root: r.root, headSha256: r.headSha256, pending: r.pending };
        if (!same(immutableHead(before.registry), immutableHead(actual.registry))) stop('transition-extra-drift', 'spec composition cannot append/rebind the registry');
        // Effective node states are independently derived from the new spec
        // files by14; they are expected invalidation, never current proof.
      }
      if (a.target.parent !== before.source.commit || actual.source.root !== before.source.root || actual.source.branchRef !== before.source.branchRef || actual.source.gitCommonDir !== before.source.gitCommonDir) stop('transition-materialization-unverified', 'unexpected parent/branch/root');
      services.verifyMaterialization(a, before, actual, evidence);
      return a.kind === 'compose-spec' ? 'registry-revise' : 'check';
    }
    case 'registry-revise': {
      sameExcept(before, actual, ['registry']);
      if (!actual.registry || actual.registry.pending || actual.registry.root !== before.registry?.root || result.recordSha256 !== actual.registry.headSha256
        || result.record?.prev !== before.registry.headSha256 || result.record?.candidateSha256 !== a.target.candidateSha256) stop('transition-registry-unverified', 'not the exact completed registry event');
      services.verifyRegistry(a, before, actual, evidence);
      return Object.values(actual.registry.nodes).every((r) => ['machine-reviewed-provisional', 'recheck-required'].includes(r.state)) ? 'freeze' : 'launch';
    }
    case 'freeze': {
      sameExcept(before, actual, ['baseline']);
      if (!result.baseline || !same(result.baseline, actual.baseline)) stop('transition-freeze-unverified', 'not the exact actual new baseline reference');
      services.verifyBaseline(a, actual, evidence); return 'launch';
    }
    case 'check': {
      sameExcept(before, actual, []);
      services.verifyCheck(a, actual, evidence); return 'accept';
    }
    case 'accept': {
      sameExcept(before, actual, ['store']);
      if (!actual.store || actual.store.pending || actual.store.root !== before.store?.root
        || result.acceptedReceipt?.sha256 !== actual.store.headSha256) stop('transition-accept-unverified', 'not the exact checker publication');
      services.verifyAccept(a, before, actual, evidence); return 'accept-or-strict';
    }
    case 'release': sameExcept(before, actual, []); services.verifyRelease(a, before, actual, evidence); return null;
    case 'terminate': if(lifecycleOnlyAction(a)){sameExcept(before,actual,['worker']);const stable=w=>w&&({...w,worktree:{path:w.worktree.path,gitDir:w.worktree.gitDir,gitCommonDir:w.worktree.gitCommonDir,branchRef:w.worktree.branchRef}});if(!same(stable(before.worker),stable(actual.worker)))stop('transition-actor-mismatch','stop changed assigned worker identity');if(before.worker?.worktree.absent===true&&actual.worker?.worktree.absent!==true)stop('transition-actor-mismatch','a removed stopped worktree cannot reappear');}else sameExcept(before, actual, []); if (resolving(a)) services.verifyResolution(a, actual, evidence); else services.verifyTermination(a, before, actual, evidence); return null;
    default: sameExcept(before, actual, []); return null;
  }
}

const legacyNext = (next, kind) => next === kind || (next === 'accept-or-strict' && kind === 'accept');
function conclusiveWork(a, release, after, actual, view, now, services) {
  const ref = a.basis.workCompletion, c = transitionBound(ref);
  closed(c, ['schema', 'schemaVersion', 'runId', 'packet', 'marker', 'sourceAfter', 'outcome', 'artifacts', 'controllerSessionId'], 'conclusive work completion');
  const p = readWorkPacket(release.target.packet), marker = transitionBound(c.marker);
  closed(marker, ['schema', 'schemaVersion', 'runId', 'packet', 'actor', 'actionSha256', 'challenge', 'deliveryHandle', 'memoryRequest', 'status', 'memoryEvidence', ...(p.schemaVersion === 2 ? ['activatedAtMs','timeOrigin'] : [])], 'execution start marker');
  if (c.schema !== 'fvs/auto-work-completion' || c.schemaVersion !== p.schemaVersion || c.runId !== a.runId || c.outcome !== 'completed' || c.controllerSessionId !== actual.fixed.coordinatorSessionId
    || !same(c.packet, release.target.packet) || !Array.isArray(c.artifacts) || !c.artifacts.length || new Set(c.artifacts.map((r) => r.file)).size !== c.artifacts.length
    || c.marker.file !== p.startMarker || marker.schema !== 'fvs/auto-execution-start' || marker.schemaVersion !== p.schemaVersion || marker.runId !== a.runId || marker.status !== 'execution-uncertain'
    || !same(marker.packet, c.packet) || !same(marker.actor, p.actor) || marker.actionSha256 !== p.actionSha256 || marker.challenge !== p.challenge || marker.deliveryHandle !== p.deliveryHandle
    || !same(marker.memoryRequest, p.memoryRequest) || !same(marker.memoryEvidence, workerMemoryEvidence(marker.memoryEvidence?.out, p.memoryRequest, readTransitionAction(p.launch).before.fixed))) stop('transition-work-result-invalid', 'exact published packet/start/current prime and conclusive v1 envelope are required');
  validateReleasePreparation(release, p, view, services);
  const results = [];
  for (const artifact of c.artifacts) {
    const b = transitionBound(artifact, false);
    try { const v = transitionJson(b); if (v.schema === 'fvs/auto-work-result') results.push(v); } catch (error) { if (error.code !== 'transition-invalid-input') throw error; }
  }
  if (results.length !== 1) stop('transition-work-result-invalid', 'exactly one separately typed actor result is required');
  const r = results[0];
  closed(r, ['schema', 'schemaVersion', 'runId', 'packet', 'marker', 'actionSha256', 'actor', 'kind', 'prepared', 'result', 'controllerObservedAtMs', 'controllerSessionId'], 'typed work result');
  const prepared = { commit: p.actor.worktree.commit, tree: p.actor.worktree.tree }, floor = view.state.history.filter((row) => row.event.intent.transitionId !== a.transitionId).at(-1)?.event.observedAtMs ?? actual.fixed.startedAtMs;
  if (r.schemaVersion !== p.schemaVersion || r.runId !== a.runId || !same(r.packet, c.packet) || !same(r.marker, c.marker) || r.actionSha256 !== p.actionSha256 || !same(r.actor, p.actor)
    || !same(r.prepared, prepared) || r.controllerSessionId !== c.controllerSessionId || !['candidate', 'review'].includes(r.kind)
    || !Number.isSafeInteger(r.controllerObservedAtMs) || (!unbudgetedRun(actual.fixed) && (r.controllerObservedAtMs < Math.max(floor, after.event.observedAtMs, actual.fixed.startedAtMs) || r.controllerObservedAtMs > now))
    || runExpired(actual.fixed, r.controllerObservedAtMs)) stop('transition-work-result-invalid', 'result lost its exact actor/prepared source or actual controller-observation bounds');
  proofInvocation(readTransitionAction(p.launch), r.controllerObservedAtMs);
  if (view.state.history.some((row) => {
    if (row.event.position !== 'before' || row.event.intent.transitionId === a.transitionId || !row.event.intent.request) return false;
    const oldRef = readTransitionAction(row.event.intent.request).basis?.workCompletion;
    if (!oldRef) return false;
    const old = transitionBound(oldRef);
    return same(old.packet, c.packet) && old.marker?.file === p.startMarker;
  })) stop('transition-work-result-replayed', 'this issued packet/start already has a reserved result consumer; recover it');
  if (r.kind === 'candidate') {
    closed(r.result, ['commit', 'tree', 'files', 'assignment'], 'candidate result');
    if (!['compose-spec', 'materialize-proof'].includes(a.kind) || !same(a.target.candidates, [r.result]) || !same(a.target.files, r.result.files)
      || !same(c.sourceAfter, { commit: r.result.commit, tree: r.result.tree })) stop('transition-work-result-invalid', 'materialization must use exactly the observed candidate');
    const actor = { ...p.actor, worktree: { ...p.actor.worktree, commit: r.result.commit, tree: r.result.tree } };
    services.verifyWorkCandidate(a, prepared, r.result, actor);
  } else {
    closed(r.result, ['contract', 'review'], 'review result');
    const i = a.kind === 'registry-revise' ? transitionBound(a.target.request) : null;
    if (!i || !same(i.contract, r.result.contract) || !same(i.review, r.result.review) || !same(c.sourceAfter, prepared) || !same(services.observeActor(p.actor), p.actor)
      || readTransitionAction(p.launch).stage !== 'review') stop('transition-work-result-invalid', 'publication must use this exact observed reviewer/source/result');
    const review = transitionBound(r.result.review), launch = readTransitionAction(p.launch), issued = p.inputs.map((ref) => ({ ref, value: transitionBound(ref) })).filter(({ value }) => value.schema === 'fvs/auto-review-input');
    if (issued.length !== 1) stop('transition-work-result-invalid', 'one exact issued review input is required');
    const input = issued[0].value;
    closed(input, ['schema', 'schemaVersion', 'node', 'contract', 'candidateSha256', 'registryHeadSha256'], 'issued review input');
    const contract = transitionBound(r.result.contract);
    services.verifySelection(launch, actual);
    if (input.schemaVersion !== 1 || !launch.nodes.includes(contract.node) || input.node !== contract.node || !same(input.contract, r.result.contract)
      || input.candidateSha256 !== a.target.candidateSha256 || input.candidateSha256 !== review.candidateSha256 || input.registryHeadSha256 !== actual.registry.headSha256
      || input.registryHeadSha256 !== review.registryHeadSha256) stop('transition-work-result-invalid', 'review must match its assigned node and exact issued candidate/context');
    if (review.reviewer?.session !== p.actor.sessionId) stop('transition-work-result-invalid', 'review result belongs to another actor');
  }
  return r.controllerObservedAtMs;
}
function basisRecord(a, view, services, allowWork = false) {
  if (a.basis?.version !== 2 || (!allowWork && a.basis.workCompletion !== null)) stop('transition-retirement-unverified', 'retirement requires the exact completed v2 output chain');
  const before = view.state.history.find(r => r.sha256 === a.basis.beforeEventSha256), after = view.state.history.find(r => r.sha256 === a.basis.afterEventSha256);
  if (!before || !after || before.event.position !== 'before' || after.event.position !== 'after' || after.event.outcome !== 'succeeded' || after.event.beforeEventSha256 !== before.sha256
    || !same(before.event.intent, after.event.intent) || !after.event.effect.evidence.some(r => same(r, a.basis.completion))) stop('transition-retirement-unverified', 'retirement chain lost its paired successful output');
  const action = readTransitionAction(before.event.intent.request), observation = readRuntimeObservation(after.event), facts = observation.transition?.admissibility;
  if (facts?.status !== 'facts-recorded-partial' || !same(facts.completion, a.basis.completion) || facts.beforeEventSha256 !== before.sha256) stop('transition-retirement-unverified', 'no independently published output observation');
  const evidence = completionFor(action, a.basis.completion, before, view.state.history.filter(r => r !== after));
  validateDelta(action, action.before, observation.transition.snapshot, evidence, services);
  return { action, after, snapshot: observation.transition.snapshot };
}
function retirementOutput(prior, view, services) {
  let output = { action: prior };
  if (resolving(output.action)) output = basisRecord(output.action, view, services);
  if (output.action.kind === 'terminate') output = basisRecord(output.action, view, services);
  const a = output.action;
  if (!['compose-spec', 'materialize-proof', 'registry-revise'].includes(a.kind) || a.basis?.version !== 2 || a.basis.workCompletion === null) stop('transition-retirement-unverified', 'only this actor completed output permits stale-store retirement');
  const c = transitionBound(a.basis.workCompletion), packet = readWorkPacket(c.packet);
  const release = basisRecord(a, view, services, true);
  if (release.action.kind !== 'release' || !same(release.action.target.packet, c.packet) || c.outcome !== 'completed') stop('transition-retirement-unverified', 'output lost its exact completed issued actor');
  return { ...output, completion: c, packet };
}
function retirementOwner(a, output, actual, view, services, closedReservation = false) {
  const association = transitionBound(a.target.association), p = output.packet, c = output.completion, r = view.reservations.get(association.reservationId), observed = services.observeSession(a.target.sessionId);
  services.verifyCandidateAssignment(a.target.association, readTransitionAction(p.launch).stage);
  const fixedWorker = w => ({ path: w.path, gitDir: w.gitDir, gitCommonDir: w.gitCommonDir, branchRef: w.branchRef });
  if (a.nodes.length || !r || r.state !== (closedReservation ? 'closed' : 'active') || r.sessionId !== a.target.sessionId || association.sessionId !== p.actor.sessionId || association.reservationId !== p.actor.reservationId
    || association.assignmentId !== p.actor.assignmentId || association.projectId !== p.actor.projectId || a.target.sessionId !== p.actor.sessionId || !same(association.rulesProfile, p.actor.profile)
    || !same(fixedWorker(association.worktree), fixedWorker(p.actor.worktree)) || association.worktree.commit !== c.sourceAfter?.commit || association.worktree.tree !== c.sourceAfter?.tree
    || observed?.id !== p.actor.sessionId || observed.projectId !== actual.fixed.projectId || observed.kind !== 'worker'
    || observed.isTerminated !== (closedReservation || resolving(a))) stop('transition-retirement-unverified', 'exact owned result/actor/reservation and current termination state are required');
  if (!closedReservation && (!actual.worker || actual.worker.reservationId !== r.id || actual.worker.worktree.commit !== c.sourceAfter.commit || actual.worker.worktree.tree !== c.sourceAfter.tree)) stop('transition-retirement-unverified', 'retirement actor source drifted');
}
function frontier(kind, a, next = null) {
  if (kind === 'freeze') return a.kind === 'check' || (a.kind === 'launch' && a.stage === 'proof');
  if (kind === 'accept') return ['accept', 'check'].includes(a.kind) || (a.kind === 'launch' && ['proof', 'review'].includes(a.stage));
  if (kind === 'registry-revise') return ['registry-revise', 'freeze'].includes(a.kind) || (a.kind === 'launch' && ['specification', 'review'].includes(a.stage));
  if (kind === 'compose-spec') return a.kind === 'registry-revise';
  if (kind === 'materialize-proof') return a.kind === 'check';
  return legacyNext(next, a.kind);
}
function validateSuccessor(a, prior, before, after, completed, actual, view, now, services) {
  const observation = readRuntimeObservation(after.event), recorded = observation.transition?.snapshot, facts = observation.transition?.admissibility;
  if (!recorded || facts?.status !== 'facts-recorded-partial' || !same(facts.completion, a.basis.completion) || facts.beforeEventSha256 !== before.sha256
    || !same(after.event.intent, before.event.intent)) stop('transition-explanation-required', 'basis needs the independently published exact after snapshot');
  const next = validateDelta(prior, prior.before, recorded, completed, services);
  sameExcept(recorded, actual, ['worker']);
  let effectiveKind = prior.kind, permitted = frontier(prior.kind, a, next), observedAtMs = now;
  if (a.kind === 'terminate') {
    if (a.basis.workCompletion !== null || resolving(prior) || (!resolving(a) && prior.kind === 'terminate')) stop('transition-retirement-unverified', 'no duplicate termination or unrelated retirement row');
    const output = retirementOutput(prior, view, services);
    retirementOwner(a, output, actual, view, services);
    permitted = true;
  } else if (resolving(prior)) {
    const output = retirementOutput(prior, view, services);
    retirementOwner(prior, output, actual, view, services, true);
    if (actual.worker !== null || a.basis.workCompletion !== null) stop('transition-extra-drift', 'resolved actor cannot explain new worker progress');
    effectiveKind = output.action.kind; permitted = frontier(effectiveKind, a);
  } else if (prior.kind === 'release') {
    if (a.basis.workCompletion === null) stop('transition-work-result-invalid', 'delivery/start alone grants no successor');
    observedAtMs = conclusiveWork(a, prior, after, actual, view, now, services);
    if (actual.worker !== null) stop('transition-extra-drift', 'local result consumption does not select an unexplained actor');
    permitted = ['materialize-proof', 'compose-spec', 'registry-revise'].includes(a.kind);
  } else {
    if (a.basis.workCompletion !== null) stop('transition-work-result-invalid', 'only a published release consumes conclusive actor work');
    if (!same(recorded.worker, actual.worker)) stop('transition-extra-drift', 'unexplained actor progress');
  }
  if (!permitted) stop('transition-next-action-forbidden', 'completed facts do not admit this finite successor');
  if (a.kind === 'check' && ['freeze', 'accept'].includes(effectiveKind)) {
    if (!same(a.nodes, a.target.nodes) || !a.nodes.length) stop('transition-protected-proof-required', 'exact nonempty reserved recheck scope required');
    services.verifyProtectedCheck(a, actual);
  }
  if (a.kind === 'launch') {
    services.verifyProofLaunch(a, actual);
    if (a.stage !== 'proof' && (!a.nodes.length || a.nodes.some((n) => ['machine-reviewed-provisional', 'recheck-required'].includes(actual.registry?.nodes[n]?.state)))) stop('transition-next-action-forbidden', 'specification/review launch must address actual missing or pending contracts');
  }
  if (a.kind === 'freeze' && (!actual.registry || !Object.keys(actual.registry.nodes).length || Object.values(actual.registry.nodes).some((r) => !['machine-reviewed-provisional', 'recheck-required'].includes(r.state)))) stop('transition-next-action-forbidden', 'freeze requires current reviewed14 readiness');
  if (a.kind === 'registry-revise') services.verifyRegistryBefore(a, actual);
  const end = (services.now ?? Date.now)();
  if (!unbudgetedRun(actual.fixed) && end < Math.max(now, observedAtMs, view.lastObservedAtMs ?? actual.fixed.startedAtMs)) stop('transition-clock-rollback', 'continuation clock moved behind its conclusive observations');
  if (runExpired(actual.fixed, end)) stop('transition-budget-exhausted', 'original limit expired during continuation validation');
}

// Called with fresh observations and a fully validated16 history, never a
// caller-supplied expected-stale flag. It records facts OR names one next row.
export function assessTransition({ actionRef, q, view, canonical, run, actual, reasons, now, evidenceRefs = [] }, services) {
  const a = readTransitionAction(actionRef), selected = authorize(a, canonical);
  if (a.schemaVersion !== q.schemaVersion || a.schemaVersion !== (run.schemaVersion ?? 1)) stop('transition-action-mismatch', 'action/request/runtime versions differ');
  if (a.runId !== run.runId || a.transitionId !== q.transition.intent.transitionId || a.reservationId !== q.transition.intent.reservationId || a.stage !== q.transition.intent.stage || a.owner !== q.transition.intent.owner || !same(a.nodes, q.transition.intent.nodes)) stop('transition-action-mismatch', 'action and reserved effect identities differ');
  if ((a.kind === 'launch' && (q.transition.intent.effect.kind !== 'ao-launch' || q.transition.intent.effect.projectId !== a.target.projectId || q.transition.intent.effect.intendedBranchRef !== a.target.branchRef || q.transition.intent.effect.assignmentId !== a.target.assignmentId))
    || (a.kind !== 'launch' && (resolving(a) ? q.transition.intent.effect.kind !== 'reservation-resolution' || q.transition.intent.effect.targetReservationId !== transitionBound(a.target.association).reservationId : q.transition.intent.effect.kind !== 'local'))) stop('transition-action-mismatch', 'action lost its finite16 effect discriminator');
  const stopping=lifecycleOnlyAction(a);
  if(!stopping&&(actual.registry?.nodes===null||actual.store?.heads===null))stop('transition-context-unavailable','stop-only metadata cannot authorize proof or dispatch');
  if (runExpired(run, now) && !stopping && q.transition.position !== 'after') stop('transition-budget-exhausted', 'original budget exhausted; no new action permission');
  const fatal = reasons.filter((r) => r !== 'acceptance-unverified' && !(stopping && ['lifecycle-only-unverified','original-limit-exhausted'].includes(r)) && !(q.transition.position === 'after' && r === 'original-limit-exhausted'));
  if (fatal.length) stop('transition-context-unavailable', 'fresh memory/actor/Git/scope/budget context is unavailable', { reasons: fatal });
  if (q.transition.position === 'after') {
    const before = view.state.history.find((r) => r.sha256 === q.transition.beforeEventSha256);
    if (!before || before.event.position !== 'before' || !same(before.event.intent.request, actionRef)) stop('transition-before-required', 'no matching retained before-event');
    if (q.transition.outcome !== 'succeeded' || (!stopping && runExpired(run, now))) return { status: 'facts-unverified', action: a.kind, next: null, executable: false, selected,
      reason: runExpired(run, now) ? 'original-limit-exhausted' : 'effect-outcome-' + q.transition.outcome };
    if (resolving(a) && (q.transition.effect.resolution?.reason !== 'session-terminated' || !evidenceRefs.some((r) => same(r, q.transition.effect.resolution.evidence)))) stop('transition-resolution-unverified', 'resolution after must retain the exact session-terminated evidence');
    const candidates = resolving(a) ? [q.transition.effect.resolution.evidence] : evidenceRefs.filter((ref) => { try { return transitionBound(ref).schema === 'fvs/auto-transition-completion'; } catch { return false; } });
    if (candidates.length !== 1) stop('transition-completion-required', 'exactly one actual completion is required');
    const completed = completionFor(a, candidates[0], before, view.state.history);
    if(stopping){verifyStopScope(a,actual,view,{requireStopped:a.target.progress!==null});if(resolving(a)){
      const proof=completed.result;closed(proof,['schema','schemaVersion','session','progress','terminationCompletion'],'owned termination resolution');
      if(proof.schema!=='fvs/auto-owned-session-termination'||proof.schemaVersion!==1||!same(proof.progress,a.target.progress))stop('transition-resolution-unverified','resolution lost exact typed handoff');
      const prior=view.state.history.find(row=>row.event.position==='after'&&row.event.outcome==='succeeded'&&row.event.intent.request&&(()=>{const old=readTransitionAction(row.event.intent.request);return lifecycleOnlyAction(old)&&!resolving(old)&&old.target.sessionId===a.target.sessionId&&same(old.target.progress,a.target.progress)&&same(readRuntimeObservation(row.event).transition?.admissibility.completion,proof.terminationCompletion);})());
      if(!prior||!same(transitionBound(transitionBound(proof.terminationCompletion).result).session,proof.session))stop('transition-resolution-unverified','resolution is not the actual successful stop completion');
    }}
    const next = validateDelta(a, a.before, actual, completed, services);
    if (a.basis?.version === 2 && a.basis.workCompletion !== null && !evidenceRefs.some((r) => same(r, a.basis.workCompletion))) stop('transition-work-result-invalid', 'after must retain its conclusive actor envelope for linked resume');
    return { status: 'facts-recorded-partial', action: a.kind, next, completion: candidates[0], beforeEventSha256: before.sha256, executable: false, selected, ...(stopping&&a.target.progress!==null?{knownWork:(()=>{const p=readKnownWork(a.target.progress);return observeOwnedWork(p.packet,p.actor);})()}:{} ) };
  }
  if (a.expectedHeadSha256 !== q.expectedHeadSha256) stop('transition-predecessor-stale', 'proposal predecessor is stale');
  if (!same(a.before, actual)) stop('transition-extra-drift', 'proposal does not match actual current identities');
  if (!stopping && (actual.registry?.pending || actual.store?.pending)) stop('transition-context-unavailable', 'pending canonical producer context cannot authorize another action');
  services.verifyTarget?.(a, actual);
  if(stopping){
    verifyStopScope(a,actual,view,{requireStopped:resolving(a)});
    if(resolving(a)){const terminated=view.state.history.some(row=>row.event.position==='after'&&row.event.outcome==='succeeded'&&row.event.intent.request&&(()=>{const old=readTransitionAction(row.event.intent.request);return lifecycleOnlyAction(old)&&!resolving(old)&&old.target.sessionId===a.target.sessionId&&same(old.target.progress,a.target.progress)&&readRuntimeObservation(row.event).transition?.admissibility.status==='facts-recorded-partial';})());if(!terminated)stop('transition-resolution-unverified','need exact successful owned termination before reservation closure');}
    return{status:'next-action-eligible',action:a.kind,mode:'owned-lifecycle-only',next:null,executable:false,selected,proofAuthority:'none; stale proofs remain unverified'};
  }
  if (a.kind === 'launch') verifyTaskHandoff(a,view,services);
  if (a.kind === 'launch' && ['specification', 'review'].includes(a.stage)) services.verifySelection(a, actual);
  if (resolving(a) && a.basis?.version !== 2) stop('transition-explanation-required', 'bound resolution requires its exact v2 completed context');
  if (reasons.includes('acceptance-unverified') || a.basis !== null) {
    if (a.basis === null) stop('transition-explanation-required', 'unverified cache needs a retained completed explanation');
    const before = view.state.history.find((r) => r.sha256 === a.basis.beforeEventSha256), after = view.state.history.find((r) => r.sha256 === a.basis.afterEventSha256);
    if (!before || !after || before.event.position !== 'before' || after.event.position !== 'after' || after.event.beforeEventSha256 !== before.sha256
      || after.event.outcome !== 'succeeded' || !after.event.effect.evidence.some((r) => same(r, a.basis.completion))) stop('transition-explanation-required', 'no exact completed historical explanation');
    const prior = readTransitionAction(before.event.intent.request), completed = completionFor(prior, a.basis.completion, before, view.state.history.filter((r) => r.sha256 !== after.sha256));
    if (a.basis.version === 2) validateSuccessor(a, prior, before, after, completed, actual, view, now, services);
    else {
      const next = validateDelta(prior, prior.before, actual, completed, services);
      if (!legacyNext(next, a.kind)) stop('transition-next-action-forbidden', 'explained facts permit only the exact next row');
      if (a.kind === 'launch') services.verifyProofLaunch(a, actual);
    }
  } else if (a.kind === 'launch' && a.stage === 'proof') services.verifyProofLaunch(a, actual);
  if (a.kind === 'prepare-input') services.verifyPreparationBefore(a, actual);
  if (a.kind === 'launch') {
    const clock = proofInvocation(a, now);
    if (clock) for (const row of view.state.history) if (row.event.position === 'before' && row.event.intent.request) {
      const old = readTransitionAction(row.event.intent.request);
      if (old.kind === 'launch' && old.stage === 'proof') { const previous = transitionBound(old.target.invocation); if (previous.invocationId === clock.invocationId && !same(previous, clock)) stop('transition-invocation-exhausted', 'split FVS roles must retain the same immutable invocation clock'); }
    }
  }
  if (a.kind === 'release') {
    const packet = readWorkPacket(a.target.packet);
    if (!actual.worker || !same(packet.actor, { projectId: actual.fixed.projectId, ...actual.worker })) stop('transition-release-mismatch', 'prepared actor/source/profile differs');
    releaseHistory(a, packet, view, services);
    validateReleasePreparation(a, packet, view, services);
    services.verifyProofLaunch(readTransitionAction(packet.launch), actual);
    proofInvocation(readTransitionAction(packet.launch), now);
  }
  if (a.kind === 'construct' && (actual.baseline !== null || actual.store?.headSha256 != null || actual.registry?.headSha256 != null)) stop('transition-initial-state-unverified', 'initial construction cannot infer current proof from missing input');
  return { status: 'next-action-eligible', action: a.kind, executable: false, selected };
}

export function validateReleasePreparation(a, packet, view, services) {
  // acknowledgeStart requires the start marker beside its packet and outside protected roots. A published release
  // cannot be withdrawn, so a packet that could never be acknowledged is refused here, before publication.
  const marker = packet.startMarker, roots = readTransitionAction(packet.launch).before;
  if (path.dirname(marker) !== path.dirname(a.target.packet.file) || fs.realpathSync(path.dirname(marker)) !== path.dirname(marker)
    || [packet.actor.worktree.path, roots.source.root, roots.fixed.canonicalRoot].some((root) => marker === root || marker.startsWith(root + path.sep))) stop('transition-marker-invalid', 'start marker must be beside its packet, outside protected source, before release');
  const launched =view.state.history.find((r) => r.event.position === 'before' && same(r.event.intent.request ?? null, packet.launch));
  if (!launched || launched.sha256 !== packet.beforeEventSha256 || launched.event.intent.reservationId !== packet.actor.reservationId) stop('transition-preparation-required', 'release has no exact retained launch');
  // Every resume retains the first release's startup barrier. Its own conclusive
  // source/artifact link is checked separately by releaseHistory.
  const previous = view.state.history.filter((r) => r.event.position === 'before' && r.event.intent.request).map((r) => ({ row: r, action: readTransitionAction(r.event.intent.request) }))
    .filter(({ action }) => action.kind === 'release' && readWorkPacket(action.target.packet).actor.reservationId === packet.actor.reservationId);
  const initial = previous[0], first = initial?.action ?? a, firstPacket = initial ? readWorkPacket(first.target.packet) : packet;
  const prepared = [...view.state.history].reverse().find((r) => {
    if (r.event.position !== 'after' || r.event.outcome !== 'succeeded' || !r.event.intent.request || (initial && r.event.seq >= initial.row.event.seq)) return false;
    const p = readTransitionAction(r.event.intent.request), o = readRuntimeObservation(r.event);
    return p.kind === 'prepare-input' && same(p.target.launch, firstPacket.launch) && p.target.sessionId === firstPacket.actor.sessionId
      && same(o.transition?.snapshot, first.before) && o.transition?.admissibility.status === 'facts-recorded-partial';
  });
  if (!prepared) stop('transition-preparation-required', 'first release requires its exact successful startup/preparation and prepared source');
  const prior = readTransitionAction(prepared.event.intent.request), before = view.state.history.find((r) => r.sha256 === prepared.event.beforeEventSha256), observation = readRuntimeObservation(prepared.event);
  if (!before || prior.target.candidate.commit !== firstPacket.actor.worktree.commit || prior.target.candidate.expectedTree !== firstPacket.actor.worktree.tree) stop('transition-preparation-required', 'preparation belongs to another candidate/actor');
  const ref = observation.transition.admissibility.completion;
  if (!prepared.event.effect.evidence.some((r) => same(r, ref))) stop('transition-preparation-required', 'preparation completion was not retained');
  const evidence = completionFor(prior, ref, before, view.state.history.filter((r) => r.sha256 !== prepared.sha256));
  services.verifyPreparation(prior, prior.before, observation.transition.snapshot, evidence);
}

function releaseHistory(a, packet, view, services) {
  const prior = view.state.history.filter((r) => r.event.position === 'before' && r.event.intent.request).map((r) => ({ ...r, action: readTransitionAction(r.event.intent.request) }))
    .filter((r) => r.action.kind === 'release' && r.action.transitionId !== a.transitionId && readWorkPacket(r.action.target.packet).actor.reservationId === packet.actor.reservationId);
  if (packet.resumeOf === null) {
    if (prior.length) stop('transition-release-uncertain', 'assignment already released; recover its original handle, never send a new packet');
    return;
  }
  const c = transitionBound(packet.resumeOf);
  if(packet.schemaVersion===2&&c.schema==='fvs/auto-task-progress'){
    if(prior.length)stop('transition-release-uncertain','new assignment already released; recover the same handle');
    const launch=readTransitionAction(packet.launch);if(!same(launch.target.resumeOf,packet.resumeOf))stop('transition-handoff-stale','packet lost launch handoff');verifyTaskHandoff(launch,view,services);return;
  }
  closed(c, ['schema', 'schemaVersion', 'runId', 'packet', 'marker', 'sourceAfter', 'outcome', 'artifacts', 'controllerSessionId'], 'conclusive work completion');
  const old = prior.at(-1), marker = transitionBound(c.marker);
  const recorded = view.state.history.find((r) => r.event.position === 'after' && r.event.outcome === 'succeeded' && r.event.effect.evidence.some((ref) => same(ref, packet.resumeOf)));
  if (!old || !recorded || c.schema !== 'fvs/auto-work-completion' || c.schemaVersion !== packet.schemaVersion || c.runId !== a.runId || !same(c.packet, old.action.target.packet)
    || !['completed', 'partial', 'failed'].includes(c.outcome) || c.controllerSessionId !== view.state.run.coordinatorSessionId || !Array.isArray(c.artifacts) || !c.artifacts.length
    || marker.schema !== 'fvs/auto-execution-start' || marker.schemaVersion !== readWorkPacket(old.action.target.packet).schemaVersion || marker.runId !== a.runId || marker.status !== 'execution-uncertain' || c.marker.file !== readWorkPacket(old.action.target.packet).startMarker || !same(marker.packet, c.packet) || marker.actor.reservationId !== packet.actor.reservationId
    || !readRuntimeObservation(recorded.event).associations.some((r) => r.value.sessionId === packet.actor.sessionId && r.value.reservationId === packet.actor.reservationId && r.value.assignmentId === packet.actor.assignmentId && r.value.worktree.commit === c.sourceAfter?.commit && r.value.worktree.tree === c.sourceAfter?.tree)) stop('transition-release-uncertain', 'resume requires independently recorded exact terminal work/marker/artifact evidence');
  if (packet.actor.worktree.commit !== c.sourceAfter.commit || packet.actor.worktree.tree !== c.sourceAfter.tree) stop('transition-release-uncertain', 'resume source is not the recorded conclusive worker result');
  for (const ref of c.artifacts) transitionBound(ref, false);
}

function startupValid(s) {
  closed(s, ['challenge', 'attemptId', 'phase', 'resumeId'], 'startup challenge');
  if (!isUuid(s.challenge) || !isUuid(s.attemptId) || !['start', 'resume'].includes(s.phase) || (s.phase === 'start' ? s.resumeId !== null : !isUuid(s.resumeId))) stop('transition-invalid-input', 'invalid startup identity');
}
function actorValid(a) {
  closed(a, ['projectId', 'sessionId', 'reservationId', 'assignmentId', 'worktree', 'profile'], 'actor');
  if (![a.projectId, a.sessionId].every(text) || ![a.reservationId, a.assignmentId].every(isUuid)) stop('transition-actor-mismatch', 'invalid actor identity');
  closed(a.worktree, ['path', 'gitDir', 'gitCommonDir', 'branchRef', 'commit', 'tree', 'dirty'], 'actor worktree');
  if (!path.isAbsolute(a.worktree.path ?? '') || a.worktree.dirty !== false || !/^[0-9a-f]{40}$/.test(a.worktree.commit ?? '') || !/^[0-9a-f]{40}$/.test(a.worktree.tree ?? '')) stop('transition-actor-mismatch', 'actor source must be a known clean identity');
  if (a.profile !== null) transitionData(a.profile);
}
function disabledMemoryPolicy(fixed) {
  return memoryHash({ runId: fixed.runId, generation: fixed.choicesGeneration, agreement: fixed.agreementContextSha256, memory: fixed.memory });
}
// Scheduling facts only: no acceptance, dispatch, automatic kill or one-hour deadline.
function taskContext(packet) {
  return actionTaskContext(readTransitionAction(packet.launch));
}
function actionTaskContext(a) {
  const frozen=a.before.baseline===null?null:transitionBound(a.before.baseline);
  return { execution:runControl(a.before.fixed), agreement:a.before.fixed.agreementContextSha256, scope:a.before.fixed.scopeSha256,
    source:a.before.source, baseline:a.before.baseline, registry:a.before.registry===null?null:{root:a.before.registry.root,headSha256:a.before.registry.headSha256},
    nodes:a.nodes.map(node=>({node,contractSha256:frozen?.records?.[node]?.sha256??null})) };
}
function progressEvidence(refs,label) {
  if(!Array.isArray(refs)||refs.length>1000)stop('transition-progress-invalid','bounded '+label+' evidence required');
  for(const ref of refs)transitionBound(ref,false);
}
export function readTaskProgress(ref, seen=new Set()) {
  if(seen.has(ref.file)||seen.size>=1000)stop('transition-progress-invalid','cyclic/oversize progress history');seen.add(ref.file);
  return taskProgressData(transitionBound(ref),seen);
}
// A stop's known-work handoff: a proof task's retained progress, or a finished review assignment's typed actor
// completion (the existing work-completion/work-result envelope). Either is execution accounting only; terminate and
// resolve still require the actual stop and a sealed quiescent known-work scope.
export function readKnownWork(ref) {
  return transitionBound(ref).schema === 'fvs/auto-work-completion' ? readReviewWorkCompletion(ref) : readTaskProgress(ref);
}
const REVIEW_OUTCOMES = { PASS: ['completed', 'pass'], 'APPROVE-WITH-EDITS': ['completed', 'changes-requested'], REVISE: ['completed', 'changes-requested'], BLOCKED: ['failed', null] };
export function readReviewWorkCompletion(ref) {
  const c = transitionBound(ref);
  closed(c, ['schema', 'schemaVersion', 'runId', 'packet', 'marker', 'sourceAfter', 'outcome', 'artifacts', 'controllerSessionId'], 'review work completion');
  const p = readWorkPacket(c.packet), launch = readTransitionAction(p.launch), marker = transitionBound(c.marker);
  if (c.schema !== 'fvs/auto-work-completion' || c.schemaVersion !== 2 || p.schemaVersion !== 2 || c.runId !== p.runId || launch.kind !== 'launch' || launch.stage !== 'review'
    || c.controllerSessionId !== launch.before.fixed.coordinatorSessionId || !['completed', 'failed'].includes(c.outcome) || !Array.isArray(c.artifacts) || c.artifacts.length !== 2
    || c.marker.file !== p.startMarker || marker.schema !== 'fvs/auto-execution-start' || marker.schemaVersion !== 2 || marker.runId !== p.runId || marker.status !== 'execution-uncertain'
    || !same(marker.packet, c.packet) || !same(marker.actor, p.actor) || marker.actionSha256 !== p.actionSha256 || marker.challenge !== p.challenge || marker.deliveryHandle !== p.deliveryHandle
    || !same(c.sourceAfter, { commit: p.actor.worktree.commit, tree: p.actor.worktree.tree })) stop('transition-progress-invalid', 'review completion lost its exact issued review packet, start or read-only source');
  const values = c.artifacts.map(r => transitionBound(r)), r = values.find(v => v.schema === 'fvs/auto-work-result'), e = values.find(v => v !== r);
  if (!r || !e) stop('transition-progress-invalid', 'one typed review result and its import evidence are required');
  closed(r, ['schema', 'schemaVersion', 'runId', 'packet', 'marker', 'actionSha256', 'actor', 'kind', 'prepared', 'result', 'controllerObservedAtMs', 'controllerSessionId'], 'typed work result');
  closed(r.result, ['contract', 'review'], 'review result');
  if (r.schemaVersion !== 2 || r.runId !== c.runId || !same(r.packet, c.packet) || !same(r.marker, c.marker) || r.actionSha256 !== p.actionSha256 || !same(r.actor, p.actor) || r.kind !== 'review'
    || !same(r.prepared, c.sourceAfter) || r.controllerSessionId !== c.controllerSessionId || !Number.isSafeInteger(r.controllerObservedAtMs)) stop('transition-progress-invalid', 'review result lost its exact actor/packet');
  // The import evidence must be the validated import for this exact issued review: the frozen pre-dispatch binding and
  // review input (historical node/contract/candidate/head, never the current registry), the returned and sealed
  // response, the importer's normalized artifacts with the verdict they state, and the actor observed exactly at the
  // prepared read-only source.
  if (!same(e.workPacket, c.packet) || !same(e.marker, c.marker) || !same(e.actor, p.actor) || p.actor.worktree.dirty !== false || e.reviewer?.session !== p.actor.sessionId || e.reviewer?.runId !== launch.transitionId)
    stop('transition-progress-invalid', 'import evidence is for another review packet, start or observed actor/source');
  const b = transitionBound(e.binding), inputRef = b.input, input = transitionBound(inputRef);
  if (b.schema !== 'fvs/auto-driver-review-binding' || b.schemaVersion !== 1 || !p.inputs.some(ref => same(ref, e.binding)) || !p.inputs.some(ref => same(ref, inputRef))
    || input.schema !== 'fvs/auto-review-input' || input.schemaVersion !== 1 || !launch.nodes.includes(input.node) || !same(input.contract, b.contract) || !same(r.result.contract, input.contract)
    || transitionBound(input.contract).node !== input.node) stop('transition-progress-invalid', 'review result is not the issued contract/node');
  const returned = transitionBound(e.response);
  if (!same(returned.workPacket, c.packet) || !same(returned.marker, c.marker) || !same(returned.binding, e.binding) || returned.reviewerInvocation !== launch.transitionId) stop('transition-progress-invalid', 'returned response belongs to another packet/binding/invocation');
  const sealed = transitionBound(e.sealedResponse, false), imported = e.imported ?? {};
  if (['raw', 'normalized', 'transformation', 'review'].some(k => !imported[k])) stop('transition-progress-invalid', 'the complete retained import artifacts are required');
  const normalizedBytes = transitionBound(imported.normalized, false), transformation = transitionBound(imported.transformation), normalized = normalizedBytes.toString('utf8');
  if (transitionBound(returned.response, false).compare(sealed) !== 0 || transitionBound(imported.raw, false).compare(sealed) !== 0 || transformation.validated !== true || transformation.replay_matches !== true
    || transformation.hashes?.['normalized-response.md'] !== imported.normalized.sha256 || !transitionBound(imported.review, false).toString('utf8').endsWith('\n\n' + normalized.trim() + '\n'))
    stop('transition-progress-invalid', 'import artifacts do not form the validated sealed/normalized chain');
  // The retained normalized text must be what the existing review validator derives from the sealed bytes; the replay
  // writes only into a throwaway directory and reads no registry, baseline or reviewer.
  const replayRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fvs-review-replay-'));
  let replayed = null;
  try { replayed = recordValidatedResponse(replayRoot, sealed, { verdicts: ['PASS', 'APPROVE-WITH-EDITS', 'REVISE', 'BLOCKED'], headings: ['Findings', 'Content coverage statement', 'Coverage', 'Evidence'], warnings: [] }); }
  catch { replayed = null; } finally { fs.rmSync(replayRoot, { recursive: true, force: true }); }
  if (replayed !== normalized) stop('transition-progress-invalid', 'retained normalized response is not the validator replay of the sealed response');
  const stated = normalized.trim().split(/\r?\n/).at(-1).trim().replace(/^[-\s]*VERDICT:\s*/i, '').toUpperCase(), expected = REVIEW_OUTCOMES[stated];
  if (!expected || e.verdict !== stated || c.outcome !== expected[0]) stop('transition-progress-invalid', 'completion outcome differs from the validated normalized verdict');
  if (expected[1] === null ? r.result.review !== null : (() => { const v = transitionBound(r.result.review); return v.verdict !== expected[1] || v.candidateSha256 !== input.candidateSha256 || v.registryHeadSha256 !== input.registryHeadSha256
    || v.reviewer?.session !== p.actor.sessionId || v.reviewer?.runId !== launch.transitionId || !same(v.evidence, c.artifacts[values.indexOf(e)]); })())
    stop('transition-progress-invalid', 'review envelope differs from the issued candidate/head or the validated verdict/evidence');
  return { packet: c.packet, marker: c.marker, actor: p.actor, runId: c.runId, outcome: c.outcome, review: r.result.review };
}
// Controller wrapper for a validated review import (driver evidence + optional envelope); never a proof or PASS record.
export function recordReviewWorkCompletion(options) {
  const v = transitionData(options); closed(v, ['importEvidence', 'contract', 'review', 'controllerSessionId', 'out'], 'review completion options');
  const e = transitionBound(v.importEvidence), p = readWorkPacket(e.workPacket), prepared = { commit: p.actor.worktree.commit, tree: p.actor.worktree.tree };
  if (fs.existsSync(v.out) || !path.isAbsolute(v.out) || fs.realpathSync(path.dirname(v.out)) !== path.dirname(v.out)) stop('transition-progress-invalid', 'exclusive review completion output required');
  fs.mkdirSync(v.out, { mode: 0o700 });
  const result = transitionSave(path.join(v.out, 'review-result.json'), { schema: 'fvs/auto-work-result', schemaVersion: 2, runId: p.runId, packet: e.workPacket, marker: e.marker, actionSha256: p.actionSha256,
    actor: p.actor, kind: 'review', prepared, result: { contract: v.contract, review: v.review }, controllerObservedAtMs: Date.now(), controllerSessionId: v.controllerSessionId });
  const completion = transitionSave(path.join(v.out, 'review-completion.json'), { schema: 'fvs/auto-work-completion', schemaVersion: 2, runId: p.runId, packet: e.workPacket, marker: e.marker,
    sourceAfter: prepared, outcome: REVIEW_OUTCOMES[e.verdict]?.[0] ?? null, artifacts: [result, v.importEvidence], controllerSessionId: v.controllerSessionId });
  readReviewWorkCompletion(completion); return { status: 'review-completion-recorded', completion, proofAuthority: 'none', executable: false };
}
function taskProgressData(p,seen=new Set()) {
  closed(p,['schema','schemaVersion','runId','packet','marker','actor','observedActor','context','logicalTask','attemptStartedAtMs','observedAtMs','lastMeaningfulProgress','currentGoal','failedApproaches','blocker','nextStep','blockerResolution','previous'],'task progress');
  const packet=readWorkPacket(p.packet),marker=transitionBound(p.marker),launch=readTransitionAction(packet.launch);
  if(p.schema!=='fvs/auto-task-progress'||p.schemaVersion!==1||packet.schemaVersion!==2||p.runId!==packet.runId||!same(p.actor,packet.actor)
    ||p.marker.file!==packet.startMarker||marker.schema!=='fvs/auto-execution-start'||marker.schemaVersion!==2||marker.status!=='execution-uncertain'||!same(marker.packet,p.packet)||!same(marker.actor,p.actor)
    ||marker.timeOrigin!=='worker-entry-acknowledgement'||!Number.isSafeInteger(marker.activatedAtMs)||p.attemptStartedAtMs!==marker.activatedAtMs||!same(p.context,taskContext(packet)))stop('transition-progress-invalid','progress lost exact packet, activation or proof context');
  const stableActor=a=>({...a,worktree:{path:a.worktree.path,gitDir:a.worktree.gitDir,gitCommonDir:a.worktree.gitCommonDir,branchRef:a.worktree.branchRef}});
  if(!p.observedActor||!same(stableActor(p.actor),stableActor(p.observedActor))||!Number.isSafeInteger(p.observedAtMs)||p.observedAtMs<0||!text(p.currentGoal)||!(p.nextStep===null||text(p.nextStep)))stop('transition-progress-invalid','progress needs exact assigned actor and concrete goal');
  closed(p.observedActor.worktree,['path','gitDir','gitCommonDir','branchRef','commit','tree','dirty'],'observed progress worktree');
  if(!/^[0-9a-f]{40}$/.test(p.observedActor.worktree.commit)||!/^[0-9a-f]{40}$/.test(p.observedActor.worktree.tree)||typeof p.observedActor.worktree.dirty!=='boolean')stop('transition-progress-invalid','unknown observed worktree');
  closed(p.lastMeaningfulProgress,['observedAtMs','description','evidence'],'meaningful progress');
  if(!Number.isSafeInteger(p.lastMeaningfulProgress.observedAtMs)||p.lastMeaningfulProgress.observedAtMs<0||!text(p.lastMeaningfulProgress.description))stop('transition-progress-invalid','meaningful progress needs an observation and description');
  progressEvidence(p.lastMeaningfulProgress.evidence,'meaningful progress');if(!p.lastMeaningfulProgress.evidence.length)stop('transition-progress-invalid','a heartbeat is not meaningful progress');
  if(!Array.isArray(p.failedApproaches)||p.failedApproaches.length>1000)stop('transition-progress-invalid','bounded failed approaches required');
  for(const f of p.failedApproaches){closed(f,['hypothesis','evidence'],'failed approach');if(!text(f.hypothesis))stop('transition-progress-invalid','failed approach needs its actual hypothesis');progressEvidence(f.evidence,'failed approach');}
  if(p.blocker!==null){closed(p.blocker,['kind','description','evidence'],'blocker');if(!['missing-lemma','specification','tooling','unknown'].includes(p.blocker.kind)||!text(p.blocker.description))stop('transition-progress-invalid','concrete blocker required');progressEvidence(p.blocker.evidence,'blocker');}
  if(p.blockerResolution!==null){closed(p.blockerResolution,['route','evidence','nextStep'],'blocker resolution');if(!['decomposition','helper-lemma','independent-specification-review'].includes(p.blockerResolution.route)||!text(p.blockerResolution.nextStep))stop('transition-progress-invalid','persistent blocker requires grounded replan');progressEvidence(p.blockerResolution.evidence,'blocker resolution');if(!p.blockerResolution.evidence.length)stop('transition-progress-invalid','replan cannot be a Boolean');}
  const prior=p.previous===null?null:readTaskProgress(p.previous,new Set(seen));
  const inherited=launch.target.resumeOf===null||transitionBound(launch.target.resumeOf).schema!=='fvs/auto-task-progress'?null:readTaskProgress(launch.target.resumeOf,new Set(seen));
  const logical=inherited?.logicalTask??{packet:p.packet,startedAtMs:marker.activatedAtMs};
  closed(p.logicalTask,['packet','startedAtMs'],'logical task');
  if(!same(p.logicalTask,logical))stop('transition-progress-invalid','replacement cannot reset logical task start/history');
  if(prior&&(!same(prior.packet,p.packet)||!same(prior.context,p.context)||!same(prior.logicalTask,p.logicalTask)||p.failedApproaches.length<prior.failedApproaches.length||!same(p.failedApproaches.slice(0,prior.failedApproaches.length),prior.failedApproaches)))stop('transition-progress-invalid','same-attempt progress cannot erase context or failed approaches');
  if(inherited&&(!same(inherited.context,p.context)||p.failedApproaches.length<inherited.failedApproaches.length||!same(p.failedApproaches.slice(0,inherited.failedApproaches.length),inherited.failedApproaches)))stop('transition-progress-invalid','replacement cannot erase context/attempt evidence');
  return p;
}
export function assessTaskProgress(progress, now=Date.now()) {
  // Read and validation happen at the caller; this pure result never permits an effect.
  const elapsed=now-progress.attemptStartedAtMs,last=now-progress.lastMeaningfulProgress.observedAtMs;
  if(!Number.isSafeInteger(now)||elapsed<0||last<0)return{kind:'observe-existing',reason:'audit-clock-uncertain',executable:false};
  if(progress.blocker!==null)return{kind:'diagnose-blocker',reason:progress.blocker.kind,nextStep:progress.nextStep,executable:false};
  if(elapsed>=3600000)return{kind:'assess-small-proof',reason:last>=3600000?'no-recent-meaningful-progress':'meaningful-progress-retained',nextStep:progress.nextStep,executable:false,automaticTermination:false};
  return{kind:'observe-existing',reason:'progress-facts-only',executable:false};
}
export function recordTaskProgress(options,services) {
  const v=transitionData(options);
  closed(v,['packet','marker','previous','currentGoal','failedApproaches','lastMeaningfulProgress','blocker','nextStep','blockerResolution','out'],'progress options');
  const packet=readWorkPacket(v.packet),marker=transitionBound(v.marker),launch=readTransitionAction(packet.launch),inherited=launch.target.resumeOf===null||transitionBound(launch.target.resumeOf).schema!=='fvs/auto-task-progress'?null:readTaskProgress(launch.target.resumeOf);
  const value={schema:'fvs/auto-task-progress',schemaVersion:1,runId:packet.runId,packet:v.packet,marker:v.marker,actor:packet.actor,observedActor:services.observeActor(packet.actor),context:taskContext(packet),logicalTask:inherited?.logicalTask??{packet:v.packet,startedAtMs:marker.activatedAtMs},attemptStartedAtMs:marker.activatedAtMs,observedAtMs:services.now?.()??Date.now(),lastMeaningfulProgress:v.lastMeaningfulProgress,currentGoal:v.currentGoal,failedApproaches:v.failedApproaches,blocker:v.blocker,nextStep:v.nextStep,blockerResolution:v.blockerResolution,previous:v.previous};
  taskProgressData(value);
  if(fs.existsSync(v.out)||!path.isAbsolute(v.out)||fs.realpathSync(path.dirname(v.out))!==path.dirname(v.out))stop('transition-progress-invalid','exclusive progress output required');
  fs.mkdirSync(v.out,{mode:0o700});const ref=transitionSave(path.join(v.out,'progress.json'),value);
  const p=readTaskProgress(ref);return{status:'progress-recorded',progress:ref,assessment:assessTaskProgress(p,services.now?.()??Date.now()),proofAuthority:'none',executable:false};
}

export function disabledWorkerMemoryRequest(fixed, caller) {
  if (fixed?.schemaVersion !== 2 || fixed.memory?.mode !== 'disabled') stop('transition-startup-ack-mismatch', 'disabled memory is not the actual v2 policy');
  const request = { schema: 'fvs/auto-memory-disabled-request', schemaVersion: 2, runId: fixed.runId, ...transitionData(caller), policySha256: disabledMemoryPolicy(fixed) };
  validateDisabledMemory(request, fixed); return request;
}
function validateDisabledMemory(request, fixed) {
  closed(request, ['schema','schemaVersion','runId','attemptId','phase','target','policySha256'], 'disabled worker context request');
  closed(request.target, ['projectId','sessionId','resumeId'], 'disabled worker target');
  if (fixed?.schemaVersion !== 2 || fixed.memory?.mode !== 'disabled' || request.schema !== 'fvs/auto-memory-disabled-request' || request.schemaVersion !== 2 || request.runId !== fixed.runId
    || request.policySha256 !== disabledMemoryPolicy(fixed) || !isUuid(request.attemptId) || !['start','resume'].includes(request.phase)
    || request.target.projectId !== fixed.projectId || !text(request.target.sessionId) || (request.phase === 'start' ? request.target.resumeId !== null : !isUuid(request.target.resumeId))) stop('transition-startup-ack-mismatch', 'disabled worker context is not this exact run/caller');
}
const disabledMemory = fixed => fixed?.schemaVersion === 2 && fixed.memory?.mode === 'disabled';
export function workerMemoryEvidence(out, request, fixed) {
  if (disabledMemory(fixed)) {
    validateDisabledMemory(request, fixed);
    if (out !== null && out !== undefined) stop('transition-startup-ack-mismatch', 'disabled memory cannot claim backend output');
    return { status: 'disabled', requestSha256: memoryHash(request), policySha256: request.policySha256 };
  }
  if (!text(out) || !path.isAbsolute(out) || fs.realpathSync(out) !== out) stop('transition-startup-ack-mismatch', 'canonical actual memory output required');
  const ref = (file) => ({ file, sha256: hash(transitionBytes(file)) }), result = ref(path.join(out, 'result.json')), r = transitionBound(result);
  const requestInput = ref(path.join(out, 'request.json')), prime = ref(path.join(out, 'prime.txt'));
  if (r.schema !== 'fvs/auto-memory-bootstrap-result' || r.schemaVersion !== 1 || r.status !== 'memory-primed' || r.route !== 'worker-readonly'
    || r.requestSha256 !== memoryHash(request) || !same(r.request, request) || r.requestInputSha256 !== requestInput.sha256 || r.prime?.file !== 'prime.txt' || r.prime.sha256 !== prime.sha256
    || r.prime.bytes !== transitionBytes(prime.file).length) stop('transition-startup-ack-mismatch', 'memory result/request/actual prime bytes are not this own current request');
  return { out, result, requestInput, prime };
}
function startupAcknowledgement({ actionRef, acknowledgement, actor, expectedMemoryRequest }, services) {
  const a = readTransitionAction(actionRef), ack = transitionBound(acknowledgement); actor = transitionData(actor); actorValid(actor);
  if (a.kind !== 'launch') stop('transition-actor-mismatch', 'startup is for a launch');
  closed(ack, ['schema', 'schemaVersion', 'runId', 'actionSha256', 'beforeEventSha256', 'challenge', 'actor', 'memoryRequest', 'memoryOut', 'memoryEvidence', 'waiting'], 'startup acknowledgement');
  if (ack.schema !== 'fvs/auto-startup-ack' || ack.schemaVersion !== a.schemaVersion || ack.runId !== a.runId || ack.actionSha256 !== memoryHash(a) || ack.challenge !== a.target.startup.challenge
    || !same(ack.actor, actor) || actor.projectId !== a.target.projectId || actor.reservationId !== a.reservationId || actor.assignmentId !== a.target.assignmentId || ack.waiting !== true
    || ack.beforeEventSha256 !== services.beforeForAction(actionRef) || !isSha(ack.beforeEventSha256)
    || !same(ack.memoryRequest, expectedMemoryRequest)) stop('transition-startup-ack-mismatch', 'not this actual actor/current startup request');
  if (expectedMemoryRequest.attemptId !== a.target.startup.attemptId || expectedMemoryRequest.phase !== a.target.startup.phase || expectedMemoryRequest.target.sessionId !== actor.sessionId || expectedMemoryRequest.target.resumeId !== a.target.startup.resumeId) stop('transition-startup-ack-mismatch', 'caller expectation is not the allocated startup');
  if (disabledMemory(a.before.fixed) && ack.memoryOut !== null) stop('transition-startup-ack-mismatch', 'disabled startup requires explicit null backend output');
  if (!same(ack.memoryEvidence, workerMemoryEvidence(ack.memoryOut, expectedMemoryRequest, a.before.fixed))) stop('transition-startup-ack-mismatch', 'startup evidence changed');
  return { a, ack, actor };
}
export function verifyStartup(options, services) {
  const { a, ack, actor } = startupAcknowledgement(options, services), { expectedMemoryRequest } = options;
  if (!disabledMemory(a.before.fixed)) services.verifyMemory({ request: expectedMemoryRequest, out: ack.memoryOut, callerRoot: actor.worktree.path });
  const current = services.observeActor(actor);
  if (!same(current, actor) || actor.worktree.dirty !== false) stop('transition-startup-uncertain', 'worker changed source/profile before release; instruction is not OS suspension');
  return { status: 'startup-acknowledged', actor, challenge: ack.challenge, memoryEvidence: ack.memoryEvidence, pauseAuthority: 'trusted instruction/ack only', executable: false };
}
export function launchArguments(a, actionRef, beforeEventSha256) {
  if (a.kind !== 'launch') stop('transition-invalid-input', 'launch action required');
  if (!isSha(beforeEventSha256) || !same(readTransitionAction(actionRef), a)) stop('transition-before-required', 'startup prompt must bind the actual action and committed before');
  const selected = transitionBound(a.profile).stages[a.target.selectionStage];
  const guidance=a.schemaVersion===2?'. V2 execution policy '+JSON.stringify(runControl(a.before.fixed))+'. Continue until completion, cancellation, chosen-budget exhaustion or genuine blocker. Use run-owned for concrete compiler/checker commands and record-progress for this small roadmap proof unit. About1h unresolved triggers progress diagnosis, not an automatic kill/deadline. Preserve failed approaches; replacement requires retained handoff, actual old-session stop and reservation closure. '+(a.target.resumeOf===null?'':('Read handoff '+a.target.resumeOf.file+' sha256 '+a.target.resumeOf.sha256+'; retain original task start/context/budget/history. '))+'Research and pinned acquisition may use configured network-enabled tools under existing grants; checking uses stable pinned inputs.':'';
  const gate = fs.realpathSync(fileURLToPath(new URL('./fvs-auto.mjs', import.meta.url))), reference = fs.realpathSync(fileURLToPath(new URL('../fv-skills/references/auto-transitions.md', import.meta.url)));
  const permissionHold = a.schemaVersion === 2 ? ' Before any gate call, WAIT for the controller permission-ready notice binding this launch, your actual AO session/worktree and verified permission installation receipt. Read those exact retained bytes; uncertainty keeps startup held. This is a trusted instruction, not OS suspension or permission bypass.' : '';
  return ['spawn', '--project', a.target.projectId, '--kind', 'worker', '--branch', a.target.branchRef.replace(/^refs\/heads\//, ''), '--name', a.stage + ' ' + a.transitionId,
    '--harness', selected.harness, '--model', selected.model, '--effort', selected.effort, '--prompt',
    'Trusted FVS controller protocol: read ' + reference + '.' + permissionHold + ' Use installed gate ' + gate + ' sha256 ' + hash(transitionBytes(gate)) + ', never a consumer-provided script. Read closed action ' + actionRef.file + ' sha256 ' + actionRef.sha256 +
    '; committed before ' + beforeEventSha256 + '; run ' + a.runId + '; primary canonical root ' + a.before.fixed.canonicalRoot + '; assignment ' + a.target.assignmentId + '; selected FVS role ' + a.target.selectionStage +
    guidance + '. Startup challenge ' + a.target.startup.challenge + (disabledMemory(a.before.fixed) ? '. Retain an explicit disabled-memory worker context request (no backend prime) using allocated attempt ' : '. Retain your own fresh worker-readonly memory request using allocated attempt ') + a.target.startup.attemptId + ', phase ' + a.target.startup.phase + ', resume ' + a.target.startup.resumeId +
    ', actual AO session id and Git worktree. Report the actor-bound startup acknowledgement/artifact; WAIT for the exact bound work packet and durable start acknowledgement before any task/source edits. This is a trusted instruction, not OS suspension. ' + (a.schemaVersion===2?'Assigned':'Local') + ' stage only: no publication/GH/main/release or nested provider children. Preserve all worktrees/uncommitted work.'];
}
export function readWorkPacket(ref) {
  const p = transitionBound(ref);
  closed(p, ['schema', 'schemaVersion', 'runId', 'actionSha256', 'launch', 'beforeEventSha256', 'challenge', 'actor', 'deliveryHandle', 'memoryRequest', 'procedure', 'inputs', 'resumeOf', 'startMarker'], 'work packet');
  if (p.schema !== 'fvs/auto-work-packet' || ![1, 2].includes(p.schemaVersion) || !isUuid(p.runId) || !isSha(p.actionSha256) || !isUuid(p.challenge) || !text(p.deliveryHandle) || !text(p.procedure) || !text(p.startMarker) || !path.isAbsolute(p.startMarker)) stop('transition-invalid-input', 'invalid bound packet');
  actorValid(p.actor);
  const launch = readTransitionAction(p.launch);
  if (launch.schemaVersion !== p.schemaVersion || launch.kind !== 'launch' || memoryHash(launch) !== p.actionSha256 || launch.runId !== p.runId || !isSha(p.beforeEventSha256) || p.actor.reservationId !== launch.reservationId || p.actor.assignmentId !== launch.target.assignmentId || p.actor.projectId !== launch.target.projectId
    || (!disabledMemory(launch.before.fixed) && p.memoryRequest.operation !== 'worker-readonly') || p.memoryRequest.target?.sessionId !== p.actor.sessionId || p.memoryRequest.target.projectId !== p.actor.projectId
    || p.memoryRequest.attemptId === launch.target.startup.attemptId || !Array.isArray(p.inputs)) stop('transition-packet-actor-mismatch', 'packet is not for this exact assignment/new worker prime/direct procedure');
  if(p.schemaVersion===2&&launch.target.resumeOf!==null&&!same(p.resumeOf,launch.target.resumeOf))stop('transition-handoff-stale','replacement packet must carry exact launch handoff');
  if (disabledMemory(launch.before.fixed)) validateDisabledMemory(p.memoryRequest, launch.before.fixed);
  const routes = { 'auto-extract/controller-direct': ['extraction'], 'lean-specify/research-direct': ['research'], 'lean-specify/author-direct': ['fc_spec'], 'lean-spec-review/Other': ['spec_review'], 'lean-verify/plan-direct': ['fc_proof_plan'], 'lean-verify/prove-direct': ['fc_proof_execution'],
    'lean-specify/controller-direct': ['research', 'fc_spec'], 'lean-verify/controller-direct': ['fc_proof_plan', 'fc_proof_execution'] };
  const roles = routes[p.procedure], profiles = transitionBound(launch.profile).stages, tuple = (v) => v && { harness: v.harness, model: v.model, effort: v.effort };
  if (!roles?.includes(launch.target.selectionStage) || roles.some((role) => !profiles[role] || !same(tuple(profiles[role]), tuple(profiles[launch.target.selectionStage])))) stop('transition-profile-required', 'split differently configured FVS research/execution roles into separately selected AO stages; no hidden child or override');
  for (const ref of p.inputs) transitionBound(ref);
  if (launch.stage === 'proof' && !p.inputs.some((ref) => same(ref, launch.target.invocation))) stop('transition-packet-actor-mismatch', 'proof packet must retain the launch invocation clock');
  return p;
}
// One atomic immutable marker is both the start acknowledgement and the
// uncertainty boundary. A crash after it cannot be interpreted as no execution.
export function acknowledgeStart({ packet, actor, expectedMemoryRequest, marker }, services) {
  const clock = services.now ?? Date.now, began = clock();
  const p = readWorkPacket(packet); actor = transitionData(actor); actorValid(actor);
  if (!same(p.actor, actor) || !same(p.memoryRequest, expectedMemoryRequest)) stop('transition-packet-actor-mismatch', 'not the exact released actor/source/current prime');
  if (services.beforeForAction(p.launch) !== p.beforeEventSha256) stop('transition-packet-actor-mismatch', 'packet lost its actual launch-before binding');
  const identity = { schema: 'fvs/auto-execution-start', schemaVersion: p.schemaVersion, runId: p.runId, packet, actor, actionSha256: p.actionSha256, challenge: p.challenge, deliveryHandle: p.deliveryHandle, memoryRequest: expectedMemoryRequest, status: 'execution-uncertain' };
  if (marker !== p.startMarker || !text(marker) || !path.isAbsolute(marker) || fs.realpathSync(path.dirname(marker)) !== path.dirname(marker)) stop('transition-marker-invalid', 'canonical owned marker path required');
  const launch = readTransitionAction(p.launch);
  if (path.dirname(marker) !== path.dirname(packet.file) || [actor.worktree.path, launch.before.source.root, launch.before.fixed.canonicalRoot].some((root) => marker === root || marker.startsWith(root + path.sep))) stop('transition-marker-invalid', 'start evidence belongs beside its owned packet, outside protected source');
  if (fs.existsSync(marker)) {
    const existing = transitionJson(transitionBytes(marker)), { memoryEvidence, activatedAtMs, timeOrigin, ...boundIdentity } = existing;
    if (p.schemaVersion === 1 && (Object.hasOwn(existing, 'activatedAtMs') || Object.hasOwn(existing, 'timeOrigin'))) stop('transition-marker-conflict', 'legacy marker cannot acquire v2 activation fields');
    if (p.schemaVersion === 2 && (!Number.isSafeInteger(activatedAtMs) || timeOrigin !== 'worker-entry-acknowledgement')) stop('transition-marker-conflict', 'missing actual v2 activation observation');
    if (!same(boundIdentity, identity) || !same(memoryEvidence, workerMemoryEvidence(memoryEvidence?.out, expectedMemoryRequest, launch.before.fixed))) stop('transition-marker-conflict', 'different packet/actor or changed evidence owns start marker');
    return { status: 'already-started-uncertain', marker: { file: marker, sha256: hash(transitionBytes(marker)) }, mayStart: false };
  }
  const context = services.verifyReleasedPacket(packet), originalClock = context?.clock;
  if (!originalClock || originalClock.runId !== p.runId || !Number.isSafeInteger(originalClock.lastObservedAtMs) || !Number.isSafeInteger(originalClock.observedAtMs)) stop('transition-start-context-required', 'actual current run clock is required');
  let floor = Math.max(began, originalClock.lastObservedAtMs, originalClock.observedAtMs);
  const fence = () => {
    const current = services.currentClock?.() ?? originalClock, now = clock();
    if (current.runId !== p.runId || current.startedAtMs !== originalClock.startedAtMs || !same(runExecutionFields(current), runExecutionFields(originalClock))) stop('transition-packet-context-stale', 'original run/accounting changed during start');
    floor = Math.max(floor, current.lastObservedAtMs);
    if (!unbudgetedRun(current) && (now < floor || now < current.startedAtMs)) stop('transition-clock-rollback', 'start clock moved behind authoritative observed accounting');
    if (runExpired(current, now)) stop('transition-budget-exhausted', 'original limit expired before start permission');
    floor = now; proofInvocation(readTransitionAction(p.launch), now);
  };
  fence();
  if (!disabledMemory(launch.before.fixed)) services.verifyMemory({ request: expectedMemoryRequest, out: services.memoryOut, callerRoot: actor.worktree.path });
  if (!same(services.observeActor(actor), actor) || actor.worktree.dirty !== false) stop('transition-packet-source-drift', 'prepared input/actor changed');
  fence();
  const prefix = '.' + path.basename(marker) + '.start-';
  proofInvocation(readTransitionAction(p.launch));
  const value = { ...identity, memoryEvidence: workerMemoryEvidence(services.memoryOut, expectedMemoryRequest, launch.before.fixed), ...(p.schemaVersion === 2 ? { activatedAtMs: clock(), timeOrigin: 'worker-entry-acknowledgement' } : {}) };
  if (fs.readdirSync(path.dirname(marker)).some((name) => name.startsWith(prefix))) stop('transition-marker-uncertain', 'interrupted/competing marker creation; no execution inferred');
  const temporary = path.join(path.dirname(marker), prefix + crypto.randomUUID());
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  services.beforeMarkerCommit?.();
  const commitFence = () => { try { fence(); } catch (error) { stop('transition-start-uncertain', 'clock/context changed at the allocated start boundary; no permission', { reason: error.code, marker, temporary }); } };
  commitFence();
  try { fs.linkSync(temporary, marker); } catch (e) {
    if (e.code === 'EEXIST') stop('transition-marker-uncertain', 'competing start; no work may execute');
    throw e;
  }
  const dir = fs.openSync(path.dirname(marker), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  services.afterMarkerCommit?.(); commitFence();
  if (p.schemaVersion === 2) {
    try { services.verifyReleasedPacket(packet); fence(); } catch (error) { stop('transition-start-uncertain', 'current context changed before start permission', { reason: error.code, marker }); }
  }
  if (p.schemaVersion === 2) { initializeOwnedWork(packet, actor, { file: marker, sha256: hash(transitionBytes(marker)) }); fence(); }
  // The temp hardlink is retained evidence; never infer completion from it.
  return { status: 'new-start-acknowledged', marker: { file: marker, sha256: hash(transitionBytes(marker)) }, mayStart: true };
}

export function validateReleasedContext({ actionRef, packet, canonical, actual, view }, services) {
  const a = readTransitionAction(actionRef), p = readWorkPacket(packet);
  authorize(a, canonical);
  if (a.kind !== 'release' || !same(a.target.packet, packet) || a.target.sessionId !== p.actor.sessionId || !same(a.before, actual) || runExpired(actual.fixed)) stop('transition-packet-context-stale', 'released packet is not the exact current authorized source/registry/store/profile context');
  services.verifyTarget(a, actual);
  releaseHistory(a, p, view, services);
  validateReleasePreparation(a, p, view, services);
  services.verifyProofLaunch(readTransitionAction(p.launch), actual);
  proofInvocation(readTransitionAction(p.launch));
}

export function releaseArguments({ actionRef, packet, recovery = false }) {
  const a = readTransitionAction(actionRef), p = readWorkPacket(packet);
  if (a.kind !== 'release' || !same(a.target.packet, packet) || p.runId !== a.runId || p.actor.sessionId !== a.target.sessionId || p.deliveryHandle !== a.target.handle) stop('transition-release-mismatch', 'release/action packet identity mismatch');
  return ['send', '--session', a.target.sessionId, '--steer', '--client-message-id', a.target.handle,
    ...(recovery ? ['--recover-only'] : ['--message', 'Execute only the independently verified bound work packet ' + packet.file + ' sha256 ' + packet.sha256 + '; acknowledge durable start before effects.'])];
}

// Argv only, never shell text. Construction/composition are the existing
// orchestrator procedures; their resulting commits are checked at the fence.
export function transitionCommand({ actionRef, ao, tools, out, beforeEventSha256 }) {
  const a = readTransitionAction(actionRef);
  transitionBound(ao, false);
  if (!path.isAbsolute(out) || fs.realpathSync(path.dirname(out)) !== path.dirname(out)) stop('transition-invalid-input', 'canonical exclusive producer output required');
  if (a.kind === 'launch') return [ao.file, ...launchArguments(a, actionRef, beforeEventSha256)];
  if (a.kind === 'release') return [ao.file, ...releaseArguments({ actionRef, packet: a.target.packet })];
  if (resolving(a)) stop('transition-procedure-required', 'reservation resolution is the existing16 paired checkpoint only, never an executable command');
  if (a.kind === 'terminate') return [ao.file, 'session', 'kill', a.target.sessionId, '--project', a.before.fixed.projectId];
  if (a.kind === 'prepare-input') return ['/usr/bin/git', '-C', a.before.worker.worktree.path, '-c', 'core.hooksPath=/dev/null', 'merge', '--ff-only', a.target.candidate.commit];
  if (['freeze', 'check', 'accept'].includes(a.kind)) {
    transitionBound(tools.auto, false); transitionBound(a.target.request);
    return [fs.realpathSync(process.execPath), tools.auto.file, a.kind, '--request', a.target.request.file, '--out', out];
  }
  if (a.kind === 'registry-revise') {
    const i = registryInvocation(a.target.request); transitionBound(tools.registry, false);
    return [fs.realpathSync(process.execPath), tools.registry.file, i.previous === null ? 'register' : 'revise', '--plan', i.plan.file, '--graph', i.graph.file, '--registry', i.registry,
      '--spec-root', i.specRoot, '--contract', i.contract.file, '--review', i.review.file, ...(i.previous === null ? [] : ['--previous', i.previous])];
  }
  stop('transition-procedure-required', 'use the existing ' + a.kind + ' procedure and retain exact command/commit evidence');
}

// Caller has just independently consumed this exact committed before through16.
// The marker is effect evidence under that reservation, never a work queue.
export function performTransition(options, services) {
  const { actionRef, ao, tools, producerOut, evidenceDir, beforeEventSha256, committedHeadSha256, runtimeRoot, deadlineMs, lastObservedAtMs } = options;
  const a = readTransitionAction(actionRef);
  if (a.schemaVersion === 2) return performTransitionV2(options, services, a);
  if (Object.hasOwn(options, 'execution') || Object.hasOwn(options, 'version')) stop('transition-invalid-input', 'legacy effect cannot mix v2 controls');
  if (runtimeRoot !== path.join(a.before.fixed.canonicalRoot, '.formalising/auto-fv/resume') || deadlineMs !== a.before.fixed.deadlineMs) stop('transition-invalid-input', 'effect marker/accounting must belong to this exact original run');
  for (const output of [producerOut, evidenceDir]) if (output === a.before.source.root || output.startsWith(a.before.source.root + path.sep)) stop('transition-evidence-invalid', 'output must be outside the protected source');
  if (!isSha(beforeEventSha256) || !isSha(committedHeadSha256) || services.head() !== committedHeadSha256) stop('transition-predecessor-stale', 'before is no longer the current committed controller head');
  if (Date.now() >= deadlineMs) stop('transition-budget-exhausted', 'no execution after the original limit');
  if (a.kind === 'launch') proofInvocation(a);
  if (a.kind === 'release') proofInvocation(readTransitionAction(readWorkPacket(a.target.packet).launch));
  if (!Number.isSafeInteger(lastObservedAtMs) || Date.now() < lastObservedAtMs || Date.now() < a.before.fixed.startedAtMs) stop('transition-clock-rollback', 'execution clock moved behind current recorded accounting');
  const argv = transitionCommand({ actionRef, ao, tools, out: producerOut, beforeEventSha256 });
  if (fs.existsSync(evidenceDir) || !path.isAbsolute(evidenceDir) || fs.realpathSync(path.dirname(evidenceDir)) !== path.dirname(evidenceDir)) stop('transition-evidence-invalid', 'exclusive evidence directory required');
  fs.mkdirSync(evidenceDir, { mode: 0o700 });
  const markers = path.join(runtimeRoot, 'effects');
  if (!fs.existsSync(markers)) fs.mkdirSync(markers, { mode: 0o700 });
  if (fs.realpathSync(markers) !== markers || !fs.lstatSync(markers).isDirectory()) stop('transition-marker-invalid', 'canonical effect evidence directory required');
  const marker = path.join(markers, beforeEventSha256 + '.json');
  if (fs.existsSync(marker)) stop('transition-effect-uncertain', 'this before was already attempted; recover its outcome, never execute again', { marker });
  transitionSave(marker, { schema: 'fvs/auto-effect-start', schemaVersion: 1, action: actionRef, beforeEventSha256, committedHeadSha256, status: 'execution-uncertain', evidenceDir });
  const d = fs.openSync(markers, 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
  if (services.head() !== committedHeadSha256 || Date.now() >= deadlineMs || Date.now() < lastObservedAtMs) stop('transition-effect-uncertain', 'context/clock changed at the final execution fence; marker retained');
  const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...(argv[0] === ao.file ? { HOME: a.before.fixed.stateHome } : {}) };
  const tool = { file: fs.realpathSync(argv[0]), sha256: hash(transitionBytes(fs.realpathSync(argv[0]))) };
  if (argv[0] === ao.file && tool.sha256 !== ao.sha256) stop('transition-evidence-invalid', 'AO tool changed before invocation');
  const startedAtMs = Date.now(), cwd = a.before.source.root;
  const p = (services.spawn ?? spawnSync)(argv[0], argv.slice(1), { cwd, env, maxBuffer: 1024 * 1024, timeout: Math.max(1, Math.min(deadlineMs - startedAtMs, ['freeze', 'check', 'accept'].includes(a.kind) ? 600000 : 30000)) });
  const endedAtMs = Date.now(), stream = (name, b) => { const file = path.join(evidenceDir, name); fs.writeFileSync(file, b, { flag: 'wx' }); return { file, sha256: hash(b) }; };
  const command = transitionSave(path.join(evidenceDir, 'command.json'), { schema: 'fvs/auto-command-receipt', schemaVersion: 1, runId: a.runId, transitionId: a.transitionId, actionSha256: memoryHash(a), argv, cwd, env, tool,
    startedAtMs, endedAtMs, exitCode: p.status, signal: p.signal, error: p.error?.code ?? null, stdout: stream('stdout', p.stdout ?? Buffer.alloc(0)), stderr: stream('stderr', p.stderr ?? Buffer.alloc(0)) });
  const toolUnchanged = hash(transitionBytes(tool.file)) === tool.sha256;
  let recorded = false;
  if (a.kind === 'registry-revise' && p.status === 6) { try { const r = transitionJson(p.stdout); recorded = r.code === 'recorded' && ['changes-requested', 'needs-review', 'needs-semantic-review', 'recheck-required'].includes(r.record?.state); } catch {} }
  return { status: (p.status === 0 || recorded) && !p.signal && !p.error && endedAtMs >= startedAtMs && endedAtMs < deadlineMs && toolUnchanged ? recorded ? 'command-recorded-partial' : 'command-completed' : 'execution-unverified', command,
    marker: { file: marker, sha256: hash(transitionBytes(marker)) }, proofAuthority: 'none; fresh actual completion/after validation still required', executable: false };
}

async function performTransitionV2(options, services, a) {
  closed(options, ['actionRef','ao','tools','producerOut','evidenceDir','beforeEventSha256','committedHeadSha256','runtimeRoot','version','execution','lastObservedAtMs'], 'v2 effect options');
  const { actionRef, ao, tools, producerOut, evidenceDir, beforeEventSha256, committedHeadSha256, runtimeRoot, lastObservedAtMs } = options;
  const control = requestControl(options),stopping=lifecycleOnlyAction(a),effectControl=stopping?createExecution(a.runId,{kind:'none'}):control;
  if (runtimeRoot !== path.join(a.before.fixed.canonicalRoot, '.formalising/auto-fv/resume') || !same(control, runControl(a.before.fixed))) stop('transition-invalid-input', 'effect lost exact original policy');
  for (const output of [producerOut,evidenceDir]) if (!path.isAbsolute(output) || output === a.before.source.root || output.startsWith(a.before.source.root + path.sep)) stop('transition-evidence-invalid', 'owned output outside protected source required');
  if (!isSha(beforeEventSha256) || !isSha(committedHeadSha256) || services.head() !== committedHeadSha256) stop('transition-predecessor-stale', 'before is no longer current');
  assertRunning(effectControl, services);
  if (a.kind === 'launch') proofInvocation(a);
  if (a.kind === 'release') proofInvocation(readTransitionAction(readWorkPacket(a.target.packet).launch));
  if (!unbudgetedRun(a.before.fixed) && (Date.now() < lastObservedAtMs || Date.now() < a.before.fixed.startedAtMs)) stop('transition-clock-rollback', 'selected-budget clock moved backwards');
  const argv = transitionCommand({ actionRef, ao, tools, out: producerOut, beforeEventSha256 });
  if (fs.existsSync(evidenceDir) || fs.realpathSync(path.dirname(evidenceDir)) !== path.dirname(evidenceDir)) stop('transition-evidence-invalid', 'exclusive evidence output required');
  fs.mkdirSync(evidenceDir,{mode:0o700}); const markers=path.join(runtimeRoot,'effects');
  if (!fs.existsSync(markers)) fs.mkdirSync(markers,{mode:0o700});
  if (fs.realpathSync(markers)!==markers || !fs.lstatSync(markers).isDirectory()) stop('transition-marker-invalid','canonical marker directory required');
  const marker=path.join(markers,beforeEventSha256+'.json');
  if (fs.existsSync(marker)) stop('transition-effect-uncertain','already attempted; reconcile, never execute twice',{marker});
  transitionSave(marker,{schema:'fvs/auto-effect-start',schemaVersion:2,action:actionRef,beforeEventSha256,committedHeadSha256,execution:control,status:'execution-uncertain',evidenceDir});
  const directory=fs.openSync(markers,'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
  if (services.head()!==committedHeadSha256) stop('transition-effect-uncertain','head changed at execution fence',{marker});
  assertRunning(effectControl, services);
  const env={PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C',DISABLE_TELEMETRY:'1',DO_NOT_TRACK:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',...(argv[0]===ao.file?{HOME:a.before.fixed.stateHome}:{})};
  if (['freeze','check','accept'].includes(a.kind)) env.FVS_OWNED_EXECUTION_SCOPE='transition-v2';
  const tool={file:fs.realpathSync(argv[0]),sha256:hash(transitionBytes(fs.realpathSync(argv[0])))};
  if (argv[0]===ao.file && tool.sha256!==ao.sha256) stop('transition-evidence-invalid','AO tool changed');
  const startedAtMs=Date.now(),started=performance.now();
  // Metadata RPC/Git/registry calls keep a named administrative transport bound; proof/build work does not.
  const administrative=['launch','release','terminate'].includes(a.kind);
  const deadline=administrative?(stopping||unbudgetedRun(a.before.fixed)?Date.now()+ADMINISTRATIVE_TIMEOUT_MS:Math.min(Date.now()+ADMINISTRATIVE_TIMEOUT_MS,a.before.fixed.budget.deadlineMs)):null;
  const operationControl=administrative?createExecution(a.runId,{kind:'deadline',deadlineMs:deadline}):control;
  if(stopping&&a.target.progress!==null){const p=readKnownWork(a.target.progress);closeOwnedWork(p.packet,p.actor);}
  const processResult=await runOwned(argv,{cwd:a.before.source.root,env,maxBuffer:1024*1024},operationControl,services);
  const endedAtMs=Date.now(),stream=(name,b)=>{const file=path.join(evidenceDir,name);fs.writeFileSync(file,b,{flag:'wx'});return{file,sha256:hash(b)};};
  const supervision={cancelled:processResult.cancelled,timedOut:processResult.timedOut,cleanupComplete:processResult.cleanupComplete,cleanup:processResult.cleanup,operationKind:administrative?'administrative':['freeze','check','accept'].includes(a.kind)?'proof':'work',administrativeTimeoutMs:administrative?ADMINISTRATIVE_TIMEOUT_MS:null,workScope:administrative?'direct-administrative-child':'known-fvs-command-group',descendantMapping:'no arbitrary AO descendant guarantee',elapsedMs:performance.now()-started};
  const command=transitionSave(path.join(evidenceDir,'command.json'),{schema:'fvs/auto-command-receipt',schemaVersion:2,runId:a.runId,transitionId:a.transitionId,actionSha256:memoryHash(a),argv,cwd:a.before.source.root,env,tool,startedAtMs,endedAtMs,exitCode:processResult.status,signal:processResult.signal,error:processResult.error?.code??null,stdout:stream('stdout',processResult.stdout),stderr:stream('stderr',processResult.stderr),execution:control,supervision});
  const unchanged=hash(transitionBytes(tool.file))===tool.sha256;
  let recorded=false;
  if (a.kind==='registry-revise' && processResult.status===6) { try { const r=transitionJson(processResult.stdout);recorded=r.code==='recorded'&&['changes-requested','needs-review','needs-semantic-review','recheck-required'].includes(r.record?.state); } catch {} }
  const success=(processResult.status===0||recorded)&&!processResult.signal&&!processResult.error&&!processResult.cancelled&&!processResult.timedOut&&processResult.cleanupComplete&&unchanged&&(stopping||!runExpired(a.before.fixed,endedAtMs));
  return{status:success?(recorded?'command-recorded-partial':'command-completed'):'execution-unverified',...(success?{}:{code:processResult.cancelled?'cancelled':processResult.timedOut?'timeout':'execution-unverified'}),command,marker:{file:marker,sha256:hash(transitionBytes(marker))},proofAuthority:'none; actual completion/after validation required',executable:false};
}

export function nextTransitionFacts({ currentRequest, reconciled, runtime, canonical }) {
  const c = transitionData(currentRequest);
  closed(c, ['resume', 'registry', 'authorization', 'profile'], 'current proposal request');
  if (c.resume.transition !== null || !same(c.resume, reconciled.request)) stop('transition-invalid-input', 'proposal needs its own current observation, not a before reservation');
  const fake = { kind: 'construct', stage: 'extraction', authorization: c.authorization, profile: c.profile };
  authorize(fake, canonical);
  closed(c.registry, ['root', 'headSha256'], 'proposal registry'); canonicalStore(c.registry.root);
  if (reconciled.observation.reasons.length) return { status: 'partial', reasons: reconciled.observation.reasons, executable: false };
  const q = c.resume, registry = readChain(c.registry.root);
  if (registry.pending || (registry.records.at(-1)?.sha ?? null) !== c.registry.headSha256) stop('transition-registry-unverified', 'proposal registry is pending/stale');
  if (q.inputs.plan === null || q.inputs.graph === null) return { status: 'proposal', kind: 'construct', procedure: 'auto-extract then map-code/closure-plan', executable: false, scope: runtime.state.run.scope };
  const plan = { json: transitionBound(q.inputs.plan), sha256: q.inputs.plan.sha256 }, graph = { json: transitionBound(q.inputs.graph), sha256: q.inputs.graph.sha256 }, view = validatePlan(plan, graph);
  if (view.problems.length) return { status: 'partial', reasons: view.problems, executable: false };
  const status = registryStatus({ plan: q.inputs.plan.file, graph: q.inputs.graph.file, registry: c.registry.root, 'spec-root': q.source.root });
  const accepted = Object.fromEntries(reconciled.observation.acceptance.nodes.map((r) => [r.node, { current: true, receipt: r.receipt }]));
  const assignments = [...runtime.reservations.values()].filter((r) => r.state !== 'closed').map((r) => ({ nodes: r.intent.nodes, state: r.state, reservationId: r.id, sessionId: r.sessionId }));
  return proposeNext({ nodes: [...view.union].map((id) => ({ defId: id, ...view.nodes.get(id), owner: 'root:' + view.nodes.get(id).ownerRoot })), registry: status.nodes, accepted, assignments,
    baseline: q.inputs.baseline, registryHeadSha256: status.registryHeadSha256, remainingMs: unbudgetedRun(runtime.state.run) ? null : runtime.state.run.deadlineMs !== undefined ? runtime.state.run.deadlineMs - Date.now() : runtime.state.run.budget.deadlineMs - Date.now(), scope: runtime.state.run.scope });
}

// A proposal is never dispatch permission. Authoritative views are supplied by
// the fixed production readers, or explicitly labelled internal test services.
export function proposeNext({ nodes, registry, accepted, assignments, baseline, registryHeadSha256, remainingMs, scope }) {
  if (remainingMs !== null && remainingMs <= 0) return { status: 'partial', reasons: ['original-limit-exhausted'], scope, executable: false };
  const eligible = [...nodes].sort((a, b) => a.defId - b.defId);
  const working = new Map();
  for (const n of eligible) {
    if (n.eligibility !== 'eligible') continue;
    const live = assignments.find((r) => r.nodes.includes(n.defId) && r.state !== 'closed');
    if (live) { working.set(live.reservationId, live); continue; }
    const r = registry[n.defId];
    if (!r) return { status: 'proposal', kind: 'author', node: n.defId, nodes: eligible.filter((p) => p.eligibility === 'eligible' && p.owner === n.owner && !registry[p.defId]).map((p) => p.defId), owner: n.owner, executable: false };
    if (!['machine-reviewed-provisional', 'recheck-required'].includes(r.state)) return { status: 'proposal', kind: 'review-or-revise', node: n.defId, executable: false };
  }
  if (working.size) return { status: 'proposal', kind: 'observe-existing', assignments: [...working.values()], executable: false };
  if (baseline === null || transitionBound(baseline).registry.headSha256 !== registryHeadSha256) return { status: 'proposal', kind: 'freeze', executable: false };
  for (const n of eligible) if (n.eligibility === 'eligible' && !accepted[n.defId]?.current && n.dependsOn.every((id) => accepted[id]?.current === true)) return { status: 'proposal', kind: 'prove', node: n.defId, owner: n.owner, executable: false };
  const unfinished = eligible.filter((n) => !accepted[n.defId]?.current).map((n) => ({ node: n.defId, reason: n.eligibility !== 'eligible' ? n.eligibility : 'dependency/review/proof pending' }));
  return { status: unfinished.length ? 'partial' : 'handoff-to-17', scope, unfinished, accepted: Object.values(accepted).map((r) => r.receipt), executable: false, bundleAuthority: '17 materialization not implemented here',
    coverageAuthority: 'bound13 plan only; canonical scope applicability and omission reporting remain mandatory workflow checks' };
}
