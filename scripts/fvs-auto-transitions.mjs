// Finite controller protocol. No AO/provider/backend work runs on import.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { memoryDataSnapshot, memoryHash, MEMORY_LIMITS } from './fvs-project-memory.mjs';
import { duplicateKeys } from './fvs-lean-graph.mjs';
import { readChain, registryStatus, validatePlan } from './fvs-contract-registry.mjs';
import { readAcceptedStore, inspectAutoBaselineArtifacts, inspectAutoProvisional, extractionContext } from './fvs-checker-auto.mjs';

export class TransitionError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
const stop = (code, message, details) => { throw new TransitionError(code, message, details); };
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
const SHA = /^[0-9a-f]{64}$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
function snapshotValid(s) {
  closed(s, SNAPSHOT_KEYS, 'transition snapshot');
  if (!s.fixed || !s.source) stop('transition-invalid-input', 'missing fixed/source identities');
  closed(s.source, ['root', 'commit', 'tree', 'branchRef', 'gitCommonDir', 'dirty'], 'source identity');
  if (!text(s.source.root) || !/^[0-9a-f]{40}$/.test(s.source.commit ?? '') || !/^[0-9a-f]{40}$/.test(s.source.tree ?? '') || s.source.dirty !== false) stop('transition-context-unavailable', 'source must be a known clean immutable identity');
  if (s.baseline !== null) transitionBound(s.baseline);
  if (s.registry !== null) { closed(s.registry, ['root', 'headSha256', 'pending', 'nodes'], 'registry observation'); canonicalStore(s.registry.root); }
  if (s.store !== null) { closed(s.store, ['root', 'headSha256', 'pending', 'heads'], 'historical store observation'); canonicalStore(s.store.root); }
}
const KINDS = ['construct', 'launch', 'prepare-input', 'compose-spec', 'materialize-proof', 'registry-revise', 'freeze', 'check', 'accept', 'release', 'terminate', 'handoff'];
export function readTransitionAction(ref) {
  const a = transitionBound(ref);
  closed(a, ['schema', 'schemaVersion', 'runId', 'transitionId', 'reservationId', 'kind', 'stage', 'nodes', 'owner', 'expectedHeadSha256', 'before', 'target', 'authorization', 'profile', 'basis'], 'action');
  if (a.schema !== 'fvs/auto-transition-request' || a.schemaVersion !== 1 || ![a.runId, a.transitionId, a.reservationId].every(isUuid) || !KINDS.includes(a.kind)
    || !text(a.stage) || !text(a.owner) || !(a.expectedHeadSha256 === null || isSha(a.expectedHeadSha256)) || !Array.isArray(a.nodes) || a.nodes.some((n, i) => !Number.isSafeInteger(n) || n < 0 || (i && n <= a.nodes[i - 1]))) stop('transition-invalid-input', 'invalid finite action identity');
  snapshotValid(a.before);
  transitionBound(a.authorization); transitionBound(a.profile);
  if (a.basis !== null) closed(a.basis, ['beforeEventSha256', 'afterEventSha256', 'completion'], 'prior explanation');
  const keys = {
    construct: ['procedure'], launch: ['projectId', 'branchRef', 'assignmentId', 'selectionStage', 'invocation', 'startup'],
    'prepare-input': ['sessionId', 'association', 'launch', 'startupAck', 'startupRequest', 'candidate'],
    'compose-spec': ['parent', 'candidates', 'files'], 'materialize-proof': ['parent', 'candidates', 'files'],
    'registry-revise': ['candidateSha256', 'review', 'request'], freeze: ['request'], check: ['request', 'nodes'], accept: ['request', 'node'],
    release: ['sessionId', 'association', 'packet', 'handle'], terminate: ['sessionId', 'association'], handoff: ['scope'],
  };
  closed(a.target, keys[a.kind], a.kind + ' target');
  if (a.kind === 'launch') startupValid(a.target.startup);
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
  closed(clock, ['schema', 'schemaVersion', 'runId', 'invocationId', 'startedAtMs', 'budgetMs', 'deadlineMs'], 'proof invocation');
  if (clock.schema !== 'fvs/auto-proof-invocation' || clock.schemaVersion !== 1 || clock.runId !== run.runId || !isUuid(clock.invocationId)
    || !Number.isSafeInteger(clock.startedAtMs) || clock.startedAtMs < run.startedAtMs || clock.startedAtMs > now || !Number.isSafeInteger(clock.budgetMs)
    || clock.budgetMs < 60000 || clock.budgetMs > 4 * 3600000 || clock.budgetMs % 60000 !== 0
    || clock.deadlineMs !== Math.min(run.deadlineMs, clock.startedAtMs + clock.budgetMs)) stop('transition-invalid-input', 'proof invocation cannot reset the original clock or invent a node deadline');
  if (now >= clock.deadlineMs) stop('transition-invocation-exhausted', 'checkpoint this invocation within the remaining original run budget');
  return clock;
}
export function transitionSnapshot({ q, run, canonical, observation, action }, services = {}) {
  const b = action.before, root = q.inputs.baseline === null ? null : transitionBound(q.inputs.baseline).registry?.root;
  const registryRoot = root ?? b.registry?.root ?? null;
  if (root && b.registry && root !== b.registry.root) stop('transition-extra-drift', 'baseline/registry location changed');
  let registry = null, store = null;
  if (registryRoot !== null) {
    const c = (services.readRegistry ?? readChain)(registryRoot);
    const status = q.inputs.plan && q.inputs.graph ? (services.registryStatus ?? registryStatus)({ plan: q.inputs.plan.file, graph: q.inputs.graph.file, registry: registryRoot, 'spec-root': q.source.root }) : null;
    registry = { root: registryRoot, headSha256: c.records.at(-1)?.sha ?? null, pending: !!c.pending || status?.code === 'pending', nodes: status?.nodes ?? {} };
  }
  if (q.inputs.acceptedStore !== null) {
    const c = (services.readStore ?? readAcceptedStore)(q.inputs.acceptedStore.root);
    store = { root: q.inputs.acceptedStore.root, headSha256: c.headSha256, pending: false,
      heads: [...c.heads].map(([node, row]) => ({ node, sha256: row.sha256, integrated: row.record.integrated, frozenSha256: row.record.frozenSha256, registryHeadSha256: row.record.registryHeadSha256, dependencies: row.record.dependencies })).sort((a, b) => a.node - b.node) };
  }
  if (q.inputs.baseline !== null && Date.now() < run.deadlineMs) (services.inspectBaseline ?? inspectAutoBaselineArtifacts)({ baseline: q.inputs.baseline, deadlineMs: run.deadlineMs });
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
    choicesGeneration: run.choicesGeneration, agreementContextSha256: run.agreementContextSha256, scopeSha256: memoryHash(run.scope), limitsSha256: memoryHash(run.limits), startedAtMs: run.startedAtMs, deadlineMs: run.deadlineMs,
    memoryBindingSha256: q.memoryRequest.expected.bindingSha256, authorization: action.authorization, profile: action.profile,
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
        if (!s || s.root !== actual.source.root || s.commit !== actual.source.commit || s.expectedTree !== actual.source.tree || !Number.isSafeInteger(job.deadlineMs) || job.deadlineMs > actual.fixed.deadlineMs || job.deadlineMs <= Date.now()) stop('transition-target-stale', 'producer must bind exact current source and remaining original deadline');
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
        const i = transitionBound(a.target.request);
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
      const invocation = transitionBound(a.target.request);
      closed(invocation, ['schema', 'schemaVersion', 'plan', 'graph', 'registry', 'specRoot', 'contract', 'review', 'previous'], 'registry invocation');
      for (const key of ['plan', 'graph', 'contract', 'review']) transitionBound(invocation[key]);
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
      inspectBaseline({ baseline: actual.baseline, deadlineMs: actual.fixed.deadlineMs });
    },
    verifyCheck(a, actual, evidence) {
      if (evidence.result.status !== 'provisional' || evidence.result.authority !== 'provisional-only') stop('transition-check-unverified', 'worker/standalone verdict is not an auto provisional check');
      receiptArgv(evidence, tools.auto, 'check', a.target.request);
      const job = transitionBound(a.target.request);
      if (evidence.result.runId !== job.runId || evidence.result.controllerInput?.sha256 !== a.target.request.sha256 || !same(transitionBound(evidence.result.adapterInput), job)) stop('transition-check-unverified', 'provisional result is not this actual producer run/request');
      transitionBound(evidence.result.controllerInput);
      inspectCheck({ evidence: evidence.completion.result, baseline: actual.baseline,
        source: { commit: actual.source.commit, expectedTree: actual.source.tree }, nodes: a.target.nodes, deadlineMs: actual.fixed.deadlineMs });
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
      const baseline = inspectBaseline({ baseline: actual.baseline, deadlineMs: actual.fixed.deadlineMs });
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
  const c = transitionBound(ref);
  closed(c, ['schema', 'schemaVersion', 'runId', 'transitionId', 'reservationId', 'actionSha256', 'beforeEventSha256', 'command', 'result'], 'effect completion');
  if (c.schema !== 'fvs/auto-transition-completion' || c.schemaVersion !== 1 || c.runId !== a.runId || c.transitionId !== a.transitionId || c.reservationId !== a.reservationId
    || c.actionSha256 !== memoryHash(a) || c.beforeEventSha256 !== before.sha256) stop('transition-completion-mismatch', 'completion is not for this exact retained before/action');
  const cmd = transitionBound(c.command), result = transitionBound(c.result);
  closed(cmd, ['schema', 'schemaVersion', 'runId', 'transitionId', 'actionSha256', 'argv', 'cwd', 'env', 'tool', 'startedAtMs', 'endedAtMs', 'exitCode', 'signal', 'error', 'stdout', 'stderr'], 'command receipt');
  if (cmd.schema !== 'fvs/auto-command-receipt' || cmd.schemaVersion !== 1 || cmd.runId !== a.runId || cmd.transitionId !== a.transitionId || cmd.actionSha256 !== memoryHash(a)
    || !Array.isArray(cmd.argv) || !cmd.argv.length || !cmd.argv.every(text)
    || !(cmd.exitCode === 0 || (a.kind === 'registry-revise' && cmd.exitCode === 6 && result.code === 'recorded' && ['changes-requested', 'needs-review', 'needs-semantic-review', 'recheck-required'].includes(result.record?.state))) || cmd.signal !== null || cmd.error !== null
    || !Number.isSafeInteger(cmd.startedAtMs) || !Number.isSafeInteger(cmd.endedAtMs) || cmd.endedAtMs < cmd.startedAtMs) stop('transition-command-unverified', 'no definite successful effect receipt');
  if (cmd.startedAtMs < before.event.observedAtMs || cmd.endedAtMs > Date.now() || cmd.cwd !== a.before.source.root || !cmd.env || Object.keys(cmd.env).some((k) => !['PATH', 'LANG', 'LC_ALL', 'HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_NO_LAZY_FETCH', 'GIT_NO_REPLACE_OBJECTS', 'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT', 'DISABLE_TELEMETRY', 'DO_NOT_TRACK'].includes(k))
    || cmd.env.GIT_NO_LAZY_FETCH !== '1') stop('transition-command-unverified', 'command time/cwd/offline allowlisted environment is not bound to this before');
  transitionBound(cmd.tool, false); transitionBound(cmd.stdout, false); transitionBound(cmd.stderr, false);
  if (cmd.argv[0] !== cmd.tool.file) stop('transition-command-unverified', 'command lost actual executable binding');
  // An after-event is the sole consumer of this completion; replay is handled
  if (history.some((r) => r.event.position === 'after' && r.event.beforeEventSha256 !== before.sha256 && r.event.effect.evidence.some((e) => same(e, ref)))) stop('transition-completion-replayed', 'completion already belongs to another transition');
  return { completion: c, command: cmd, result, actionRef: before.event.intent.request, beforeEvent: before.event };
}
// Read-only consumers reuse the exact protocol validators, never a verdict flag.
export { completionFor as readTransitionCompletion, authorize as verifyTransitionAuthorization };
function validateDelta(a, before, actual, evidence, services) {
  snapshotValid(actual);
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
    case 'terminate': sameExcept(before, actual, []); services.verifyTermination(a, before, actual, evidence); return null;
    default: sameExcept(before, actual, []); return null;
  }
}

// Called with fresh observations and a fully validated16 history, never a
// caller-supplied expected-stale flag. It records facts OR names one next row.
export function assessTransition({ actionRef, q, view, canonical, run, actual, reasons, now, evidenceRefs = [] }, services) {
  const a = readTransitionAction(actionRef), selected = authorize(a, canonical);
  if (a.runId !== run.runId || a.transitionId !== q.transition.intent.transitionId || a.reservationId !== q.transition.intent.reservationId || a.stage !== q.transition.intent.stage || a.owner !== q.transition.intent.owner || !same(a.nodes, q.transition.intent.nodes)) stop('transition-action-mismatch', 'action and reserved effect identities differ');
  if ((a.kind === 'launch' && (q.transition.intent.effect.kind !== 'ao-launch' || q.transition.intent.effect.projectId !== a.target.projectId || q.transition.intent.effect.intendedBranchRef !== a.target.branchRef || q.transition.intent.effect.assignmentId !== a.target.assignmentId))
    || (a.kind !== 'launch' && q.transition.intent.effect.kind !== 'local')) stop('transition-action-mismatch', 'action lost its finite16 effect discriminator');
  if (now >= run.deadlineMs && q.transition.position !== 'after') stop('transition-budget-exhausted', 'original budget exhausted; no new action permission');
  const fatal = reasons.filter((r) => r !== 'acceptance-unverified' && !(q.transition.position === 'after' && r === 'original-limit-exhausted'));
  if (fatal.length) stop('transition-context-unavailable', 'fresh memory/actor/Git/scope/budget context is unavailable', { reasons: fatal });
  if (q.transition.position === 'after') {
    const before = view.state.history.find((r) => r.sha256 === q.transition.beforeEventSha256);
    if (!before || before.event.position !== 'before' || !same(before.event.intent.request, actionRef)) stop('transition-before-required', 'no matching retained before-event');
    if (q.transition.outcome !== 'succeeded' || now >= run.deadlineMs) return { status: 'facts-unverified', action: a.kind, next: null, executable: false, selected,
      reason: now >= run.deadlineMs ? 'original-limit-exhausted' : 'effect-outcome-' + q.transition.outcome };
    const candidates = evidenceRefs.filter((ref) => { try { return transitionBound(ref).schema === 'fvs/auto-transition-completion'; } catch { return false; } });
    if (candidates.length !== 1) stop('transition-completion-required', 'exactly one actual completion is required');
    const completed = completionFor(a, candidates[0], before, view.state.history);
    const next = validateDelta(a, a.before, actual, completed, services);
    return { status: 'facts-recorded-partial', action: a.kind, next, completion: candidates[0], beforeEventSha256: before.sha256, executable: false, selected };
  }
  if (a.expectedHeadSha256 !== q.expectedHeadSha256) stop('transition-predecessor-stale', 'proposal predecessor is stale');
  if (!same(a.before, actual)) stop('transition-extra-drift', 'proposal does not match actual current identities');
  if (actual.registry?.pending || actual.store?.pending) stop('transition-context-unavailable', 'pending canonical producer context cannot authorize another action');
  services.verifyTarget?.(a, actual);
  if (reasons.includes('acceptance-unverified') || a.basis !== null) {
    if (a.basis === null) stop('transition-explanation-required', 'unverified cache needs a retained completed explanation');
    const before = view.state.history.find((r) => r.sha256 === a.basis.beforeEventSha256), after = view.state.history.find((r) => r.sha256 === a.basis.afterEventSha256);
    if (!before || !after || before.event.position !== 'before' || after.event.position !== 'after' || after.event.beforeEventSha256 !== before.sha256
      || after.event.outcome !== 'succeeded' || !after.event.effect.evidence.some((r) => same(r, a.basis.completion))) stop('transition-explanation-required', 'no exact completed historical explanation');
    const prior = readTransitionAction(before.event.intent.request), completed = completionFor(prior, a.basis.completion, before, view.state.history.filter((r) => r.sha256 !== after.sha256));
    const next = validateDelta(prior, prior.before, actual, completed, services);
    const permitted = next === a.kind || (next === 'accept-or-strict' && a.kind === 'accept') || (next === 'launch' && a.kind === 'launch');
    if (!permitted) stop('transition-next-action-forbidden', 'explained facts permit only the exact next row');
    if (a.kind === 'launch') services.verifyProofLaunch(a, actual);
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
    releaseHistory(a, packet, view);
    validateReleasePreparation(a, packet, view, services);
    services.verifyProofLaunch(readTransitionAction(packet.launch), actual);
    proofInvocation(readTransitionAction(packet.launch), now);
  }
  if (a.kind === 'construct' && (actual.baseline !== null || actual.store?.headSha256 != null || actual.registry?.headSha256 != null)) stop('transition-initial-state-unverified', 'initial construction cannot infer current proof from missing input');
  return { status: 'next-action-eligible', action: a.kind, executable: false, selected };
}

export function validateReleasePreparation(a, packet, view, services) {
  const launched = view.state.history.find((r) => r.event.position === 'before' && same(r.event.intent.request ?? null, packet.launch));
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

function releaseHistory(a, packet, view) {
  const prior = view.state.history.filter((r) => r.event.position === 'before' && r.event.intent.request).map((r) => ({ ...r, action: readTransitionAction(r.event.intent.request) }))
    .filter((r) => r.action.kind === 'release' && r.action.transitionId !== a.transitionId && readWorkPacket(r.action.target.packet).actor.reservationId === packet.actor.reservationId);
  if (packet.resumeOf === null) {
    if (prior.length) stop('transition-release-uncertain', 'assignment already released; recover its original handle, never send a new packet');
    return;
  }
  const c = transitionBound(packet.resumeOf);
  closed(c, ['schema', 'schemaVersion', 'runId', 'packet', 'marker', 'sourceAfter', 'outcome', 'artifacts', 'controllerSessionId'], 'conclusive work completion');
  const old = prior.at(-1), marker = transitionBound(c.marker);
  const recorded = view.state.history.find((r) => r.event.position === 'after' && r.event.outcome === 'succeeded' && r.event.effect.evidence.some((ref) => same(ref, packet.resumeOf)));
  if (!old || !recorded || c.schema !== 'fvs/auto-work-completion' || c.schemaVersion !== 1 || c.runId !== a.runId || !same(c.packet, old.action.target.packet)
    || !['completed', 'partial', 'failed'].includes(c.outcome) || c.controllerSessionId !== view.state.run.coordinatorSessionId || !Array.isArray(c.artifacts) || !c.artifacts.length
    || marker.schema !== 'fvs/auto-execution-start' || marker.schemaVersion !== 1 || marker.runId !== a.runId || marker.status !== 'execution-uncertain' || c.marker.file !== readWorkPacket(old.action.target.packet).startMarker || !same(marker.packet, c.packet) || marker.actor.reservationId !== packet.actor.reservationId
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
export function workerMemoryEvidence(out, request) {
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
  if (ack.schema !== 'fvs/auto-startup-ack' || ack.schemaVersion !== 1 || ack.runId !== a.runId || ack.actionSha256 !== memoryHash(a) || ack.challenge !== a.target.startup.challenge
    || !same(ack.actor, actor) || actor.projectId !== a.target.projectId || actor.reservationId !== a.reservationId || actor.assignmentId !== a.target.assignmentId || ack.waiting !== true
    || ack.beforeEventSha256 !== services.beforeForAction(actionRef) || !isSha(ack.beforeEventSha256)
    || !same(ack.memoryRequest, expectedMemoryRequest)) stop('transition-startup-ack-mismatch', 'not this actual actor/current startup request');
  if (expectedMemoryRequest.attemptId !== a.target.startup.attemptId || expectedMemoryRequest.phase !== a.target.startup.phase || expectedMemoryRequest.target.sessionId !== actor.sessionId || expectedMemoryRequest.target.resumeId !== a.target.startup.resumeId) stop('transition-startup-ack-mismatch', 'caller expectation is not the allocated startup');
  if (!same(ack.memoryEvidence, workerMemoryEvidence(ack.memoryOut, expectedMemoryRequest))) stop('transition-startup-ack-mismatch', 'startup evidence changed');
  return { a, ack, actor };
}
export function verifyStartup(options, services) {
  const { a, ack, actor } = startupAcknowledgement(options, services), { expectedMemoryRequest } = options;
  services.verifyMemory({ request: expectedMemoryRequest, out: ack.memoryOut, callerRoot: actor.worktree.path });
  const current = services.observeActor(actor);
  if (!same(current, actor) || actor.worktree.dirty !== false) stop('transition-startup-uncertain', 'worker changed source/profile before release; instruction is not OS suspension');
  return { status: 'startup-acknowledged', actor, challenge: ack.challenge, memoryEvidence: ack.memoryEvidence, pauseAuthority: 'trusted instruction/ack only', executable: false };
}
export function launchArguments(a, actionRef, beforeEventSha256) {
  if (a.kind !== 'launch') stop('transition-invalid-input', 'launch action required');
  if (!isSha(beforeEventSha256) || !same(readTransitionAction(actionRef), a)) stop('transition-before-required', 'startup prompt must bind the actual action and committed before');
  const selected = transitionBound(a.profile).stages[a.target.selectionStage];
  const gate = fs.realpathSync(fileURLToPath(new URL('./fvs-auto.mjs', import.meta.url))), reference = fs.realpathSync(fileURLToPath(new URL('../fv-skills/references/auto-transitions.md', import.meta.url)));
  return ['spawn', '--project', a.target.projectId, '--kind', 'worker', '--branch', a.target.branchRef.replace(/^refs\/heads\//, ''), '--name', a.stage + ' ' + a.transitionId,
    '--harness', selected.harness, '--model', selected.model, '--effort', selected.effort, '--prompt',
    'Trusted FVS controller protocol: read ' + reference + '. Use installed gate ' + gate + ' sha256 ' + hash(transitionBytes(gate)) + ', never a consumer-provided script. Read closed action ' + actionRef.file + ' sha256 ' + actionRef.sha256 +
    '; committed before ' + beforeEventSha256 + '; run ' + a.runId + '; primary canonical root ' + a.before.fixed.canonicalRoot + '; assignment ' + a.target.assignmentId + '; selected FVS role ' + a.target.selectionStage +
    '. Startup challenge ' + a.target.startup.challenge + '. Retain your own fresh worker-readonly memory request using allocated attempt ' + a.target.startup.attemptId + ', phase ' + a.target.startup.phase + ', resume ' + a.target.startup.resumeId +
    ', actual AO session id and Git worktree. Report the actor-bound startup acknowledgement/artifact; WAIT for the exact bound work packet and durable start acknowledgement before any task/source edits. This is a trusted instruction, not OS suspension. Local stage only: no publication/GH/main/release or nested provider children. Preserve all worktrees/uncommitted work.'];
}
export function readWorkPacket(ref) {
  const p = transitionBound(ref);
  closed(p, ['schema', 'schemaVersion', 'runId', 'actionSha256', 'launch', 'beforeEventSha256', 'challenge', 'actor', 'deliveryHandle', 'memoryRequest', 'procedure', 'inputs', 'resumeOf', 'startMarker'], 'work packet');
  if (p.schema !== 'fvs/auto-work-packet' || p.schemaVersion !== 1 || !isUuid(p.runId) || !isSha(p.actionSha256) || !isUuid(p.challenge) || !text(p.deliveryHandle) || !text(p.procedure) || !text(p.startMarker) || !path.isAbsolute(p.startMarker)) stop('transition-invalid-input', 'invalid bound packet');
  actorValid(p.actor);
  const launch = readTransitionAction(p.launch);
  if (launch.kind !== 'launch' || memoryHash(launch) !== p.actionSha256 || launch.runId !== p.runId || !isSha(p.beforeEventSha256) || p.actor.reservationId !== launch.reservationId || p.actor.assignmentId !== launch.target.assignmentId || p.actor.projectId !== launch.target.projectId
    || p.memoryRequest.operation !== 'worker-readonly' || p.memoryRequest.target?.sessionId !== p.actor.sessionId || p.memoryRequest.target.projectId !== p.actor.projectId
    || p.memoryRequest.attemptId === launch.target.startup.attemptId || !Array.isArray(p.inputs)) stop('transition-packet-actor-mismatch', 'packet is not for this exact assignment/new worker prime/direct procedure');
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
  const identity = { schema: 'fvs/auto-execution-start', schemaVersion: 1, runId: p.runId, packet, actor, actionSha256: p.actionSha256, challenge: p.challenge, deliveryHandle: p.deliveryHandle, memoryRequest: expectedMemoryRequest, status: 'execution-uncertain' };
  if (marker !== p.startMarker || !text(marker) || !path.isAbsolute(marker) || fs.realpathSync(path.dirname(marker)) !== path.dirname(marker)) stop('transition-marker-invalid', 'canonical owned marker path required');
  const launch = readTransitionAction(p.launch);
  if (path.dirname(marker) !== path.dirname(packet.file) || [actor.worktree.path, launch.before.source.root, launch.before.fixed.canonicalRoot].some((root) => marker === root || marker.startsWith(root + path.sep))) stop('transition-marker-invalid', 'start evidence belongs beside its owned packet, outside protected source');
  if (fs.existsSync(marker)) {
    const existing = transitionJson(transitionBytes(marker)), { memoryEvidence, ...boundIdentity } = existing;
    if (!same(boundIdentity, identity) || !same(memoryEvidence, workerMemoryEvidence(memoryEvidence?.out, expectedMemoryRequest))) stop('transition-marker-conflict', 'different packet/actor or changed evidence owns start marker');
    return { status: 'already-started-uncertain', marker: { file: marker, sha256: hash(transitionBytes(marker)) }, mayStart: false };
  }
  const context = services.verifyReleasedPacket(packet), originalClock = context?.clock;
  if (!originalClock || originalClock.runId !== p.runId || !Number.isSafeInteger(originalClock.lastObservedAtMs) || !Number.isSafeInteger(originalClock.observedAtMs)) stop('transition-start-context-required', 'actual current run clock is required');
  let floor = Math.max(began, originalClock.lastObservedAtMs, originalClock.observedAtMs);
  const fence = () => {
    const current = services.currentClock?.() ?? originalClock, now = clock();
    if (current.runId !== p.runId || current.startedAtMs !== originalClock.startedAtMs || current.deadlineMs !== originalClock.deadlineMs) stop('transition-packet-context-stale', 'original run/accounting changed during start');
    floor = Math.max(floor, current.lastObservedAtMs);
    if (now < floor || now < current.startedAtMs) stop('transition-clock-rollback', 'start clock moved behind authoritative observed accounting');
    if (now >= current.deadlineMs) stop('transition-budget-exhausted', 'original limit expired before start permission');
    floor = now; proofInvocation(readTransitionAction(p.launch), now);
  };
  fence();
  services.verifyMemory({ request: expectedMemoryRequest, out: services.memoryOut, callerRoot: actor.worktree.path });
  if (!same(services.observeActor(actor), actor) || actor.worktree.dirty !== false) stop('transition-packet-source-drift', 'prepared input/actor changed');
  fence();
  const prefix = '.' + path.basename(marker) + '.start-';
  proofInvocation(readTransitionAction(p.launch));
  const value = { ...identity, memoryEvidence: workerMemoryEvidence(services.memoryOut, expectedMemoryRequest) };
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
  // The temp hardlink is retained evidence; never infer completion from it.
  return { status: 'new-start-acknowledged', marker: { file: marker, sha256: hash(transitionBytes(marker)) }, mayStart: true };
}

export function validateReleasedContext({ actionRef, packet, canonical, actual, view }, services) {
  const a = readTransitionAction(actionRef), p = readWorkPacket(packet);
  authorize(a, canonical);
  if (a.kind !== 'release' || !same(a.target.packet, packet) || a.target.sessionId !== p.actor.sessionId || !same(a.before, actual) || Date.now() >= actual.fixed.deadlineMs) stop('transition-packet-context-stale', 'released packet is not the exact current authorized source/registry/store/profile context');
  services.verifyTarget(a, actual);
  releaseHistory(a, p, view);
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
  if (a.kind === 'terminate') return [ao.file, 'session', 'kill', a.target.sessionId, '--project', a.before.fixed.projectId];
  if (a.kind === 'prepare-input') return ['/usr/bin/git', '-C', a.before.worker.worktree.path, '-c', 'core.hooksPath=/dev/null', 'merge', '--ff-only', a.target.candidate.commit];
  if (['freeze', 'check', 'accept'].includes(a.kind)) {
    transitionBound(tools.auto, false); transitionBound(a.target.request);
    return [fs.realpathSync(process.execPath), tools.auto.file, a.kind, '--request', a.target.request.file, '--out', out];
  }
  if (a.kind === 'registry-revise') {
    const i = transitionBound(a.target.request); transitionBound(tools.registry, false);
    return [fs.realpathSync(process.execPath), tools.registry.file, i.previous === null ? 'register' : 'revise', '--plan', i.plan.file, '--graph', i.graph.file, '--registry', i.registry,
      '--spec-root', i.specRoot, '--contract', i.contract.file, '--review', i.review.file, ...(i.previous === null ? [] : ['--previous', i.previous])];
  }
  stop('transition-procedure-required', 'use the existing ' + a.kind + ' procedure and retain exact command/commit evidence');
}

// Caller has just independently consumed this exact committed before through16.
// The marker is effect evidence under that reservation, never a work queue.
export function performTransition({ actionRef, ao, tools, producerOut, evidenceDir, beforeEventSha256, committedHeadSha256, runtimeRoot, deadlineMs, lastObservedAtMs }, services) {
  const a = readTransitionAction(actionRef);
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
    baseline: q.inputs.baseline, registryHeadSha256: status.registryHeadSha256, remainingMs: runtime.state.run.deadlineMs - Date.now(), scope: runtime.state.run.scope });
}

// A proposal is never dispatch permission. Authoritative views are supplied by
// the fixed production readers, or explicitly labelled internal test services.
export function proposeNext({ nodes, registry, accepted, assignments, baseline, registryHeadSha256, remainingMs, scope }) {
  if (remainingMs <= 0) return { status: 'partial', reasons: ['original-limit-exhausted'], scope, executable: false };
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
