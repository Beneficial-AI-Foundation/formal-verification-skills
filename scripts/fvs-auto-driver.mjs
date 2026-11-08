// Production coordinator plumbing. Imports start no actors, tools or providers.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as auto from './fvs-auto.mjs';
import { parseResumeRequest } from './fvs-auto-resume.mjs';
import { transitionData, transitionSame, transitionSave, transitionBytes, transitionBound, readTransitionAction, readWorkPacket, workerMemoryEvidence, verifyTransitionAuthorization } from './fvs-auto-transitions.mjs';
import { candidateOf, contractProblems, contextOf, readChain, reviewProblems, validatePlan } from './fvs-contract-registry.mjs';
import { observeAssignedActor } from './fvs-auto-resume.mjs';
import { runExpired, withProcessCancellation } from './fvs-execution.mjs';
import { spawnSync } from 'node:child_process';

export class DriverError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (message) => { throw new DriverError('driver-invalid-input', message); };
const same = transitionSame;
function closed(value, keys, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) fail('Expected closed ' + label);
  return value;
}
function outputDirectory(out, roots) {
  if (!path.isAbsolute(out ?? '') || path.resolve(out) !== out || fs.realpathSync(path.dirname(out)) !== path.dirname(out)) fail('Output needs a canonical existing parent');
  for (const root of roots.filter(Boolean)) {
    if (out === root || out.startsWith(root + path.sep) || root.startsWith(out + path.sep)) fail('Output overlaps protected project/source/store');
  }
  fs.mkdirSync(out, { mode: 0o700 });
}
function roots(projectRoot, request) {
  return [projectRoot, request?.source.root, request?.inputs.acceptedStore?.root];
}
function resultRef(out) {
  const file = path.join(out, 'result.json');
  return { file, sha256: crypto.createHash('sha256').update(transitionBytes(file)).digest('hex') };
}

// Context is caller-held source/input evidence, not a request to rediscover or reset it.
export function prepareCurrentRequest(raw) {
  const { projectRoot, context, phase, transition } = closed(transitionData(raw), ['projectRoot', 'context', 'phase', 'transition'], 'request preparation');
  closed(context, ['runId', 'ao', 'source', 'inputs', 'associations', 'priorAccounting'], 'request context');
  const state = auto.readState({ projectRoot, requireAgreement: true }).state;
  if (state.schemaVersion !== 2) fail('This preview adapter requires existing v2 choices; it does not migrate v1');
  const runtime = auto.readRuntimeState({ projectRoot });
  if (runtime.state && runtime.state.run.runId !== context.runId) fail('Context is not the original run');
  if (runtime.state && phase === 'start') fail('An existing run must resume');
  const attemptId = crypto.randomUUID(), resumeId = phase === 'start' ? null : crypto.randomUUID();
  const memoryRequest = state.choices.memory.mode === 'disabled' ? null : auto.prepareMemoryRequest({ projectRoot, attemptId, operation: 'coordinator-refresh', phase,
    target: { projectId: context.ao.projectId, sessionId: context.ao.coordinatorSessionId, resumeId } });
  return parseResumeRequest(Buffer.from(JSON.stringify({ schema: 'fvs/auto-resume-request', schemaVersion: 2, ...context, attemptId, phase, resumeId,
    expectedHeadSha256: runtime.headSha256, memoryRequest, transition })));
}

export async function recordCheckpoint(raw) {
  const { projectRoot, request: input, out } = closed(transitionData(raw), ['projectRoot', 'request', 'out'], 'checkpoint');
  const request = parseResumeRequest(Buffer.from(JSON.stringify(input)));
  if (request.schemaVersion !== 2) fail('A v2 request is required');
  const operation = request.transition === null ? auto.reconcileState : auto.checkpointState;
  const value = await operation({ projectRoot, request, out });
  const verification = await (request.transition === null ? auto.verifyReconciliation : auto.verifyTransition)({ projectRoot, request, out });
  return { request: value.requestInput, result: resultRef(out), out, value, verification };
}

export async function advanceOnce(raw) {
  const { projectRoot, currentRequest, out } = closed(transitionData(raw), ['projectRoot', 'currentRequest', 'out'], 'advance');
  closed(currentRequest, ['resume', 'registry', 'authorization', 'profile'], 'current proposal context');
  if (currentRequest.resume.transition !== null) {
    if (currentRequest.resume.transition.position !== 'before') fail('Use recordAfter for an after observation');
    const action = readTransitionAction(currentRequest.resume.transition.intent.request);
    if (!same(action.authorization, currentRequest.authorization) || !same(action.profile, currentRequest.profile)) fail('Action differs from held authorization/profile');
    return { status: 'before-recorded', checkpoint: await recordCheckpoint({ projectRoot, request: currentRequest.resume, out }), executable: false, proofAuthority: 'none' };
  }
  return await auto.nextTransition({ projectRoot, currentRequest, out });
}

// Returns command evidence only. The caller must supply the freshly observed after request.
export async function runPairedEffect(raw) {
  const { projectRoot, request: input, out } = closed(transitionData(raw), ['projectRoot', 'request', 'out'], 'paired effect');
  const request = parseResumeRequest(Buffer.from(JSON.stringify(input)));
  if (request.schemaVersion !== 2 || request.transition?.position !== 'before') fail('A concrete v2 before request is required');
  const action = request.transition.intent.request;
  readTransitionAction(action);
  outputDirectory(out, roots(projectRoot, request));
  transitionSave(path.join(out, 'request.json'), request);
  return await withProcessCancellation(async services => {
    const before = await recordCheckpoint({ projectRoot, request, out: path.join(out, 'before') });
    const producer = await auto.executeTransition({ projectRoot, request, beforeOut: before.out, producerOut: path.join(out, 'producer'), evidenceDir: path.join(out, 'effect') }, services);
    const value = { schema: 'fvs/auto-driver-effect', schemaVersion: 1, action, before, producer, status: producer.status, executable: false, proofAuthority: 'none; completion and independently verified after required' };
    transitionSave(path.join(out, 'result.json'), value);
    return value;
  }, { stdinCancelId: readTransitionAction(action).transitionId });
}

export async function recordAfter(raw) {
  const { projectRoot, request, out } = closed(transitionData(raw), ['projectRoot', 'request', 'out'], 'after');
  if (request.schemaVersion !== 2 || request.transition?.position !== 'after') fail('An exact v2 after request is required');
  const checkpoint = await recordCheckpoint({ projectRoot, request, out });
  const facts = checkpoint.verification.observation.transition.admissibility;
  const basis = facts.status === 'facts-recorded-partial' ? { version: 2, beforeEventSha256: facts.beforeEventSha256,
    afterEventSha256: checkpoint.value.recordedEventSha256, completion: facts.completion, workCompletion: null } : null;
  return { status: facts.status, checkpoint, basis, executable: false, proofAuthority: 'none; every successor needs a fresh validated before' };
}

function currentCandidate({ projectRoot, plan, graph, registry, contract }) {
  const p = { json: transitionBound(plan), sha256: plan.sha256 }, g = { json: transitionBound(graph), sha256: graph.sha256 };
  const view = validatePlan(p, g), c = transitionBound(contract);
  if (view.problems.length || !view.union.has(c.node) || view.nodes.get(c.node)?.eligibility !== 'eligible') fail('Review needs a supported selected node');
  const context = contextOf(p, g, view, c.node), problems = contractProblems(c, context, projectRoot), chain = readChain(registry);
  if (problems.length || chain.pending) fail('Contract/context unavailable: ' + problems.join('; '));
  return { contract: c, context, chain, candidateSha256: candidateOf(c, context), registryHeadSha256: chain.records.at(-1)?.sha ?? null };
}
function packetSources(projectRoot, packet, prompt) {
  if (packet.version !== 2 || packet.root !== projectRoot || packet.request?.runtime !== 'other' || !Array.isArray(packet.inputs) || !packet.inputs.length) fail('Expected an actual grounded Other packet');
  if (!transitionBytes(prompt.file).length) fail('Missing exported prompt');
  const sources = [];
  for (const input of [...packet.inputs, ...(packet.history ?? [])]) {
    const file = path.resolve(projectRoot, input.path);
    if (!file.startsWith(projectRoot + path.sep)) fail('Review source escapes project');
    transitionBound({ file, sha256: input.sha256 }, false);
    sources.push({ file, sha256: input.sha256 });
  }
  return sources;
}
function reviewAuthority(projectRoot, launch, run) {
  const view = auto.readState({ projectRoot, requireAgreement: true });
  verifyTransitionAuthorization(launch, { view, envelope: view.agreement.agreement });
  if (view.agreement.contextSha256 !== run.agreementContextSha256 || view.state.choicesGeneration !== run.choicesGeneration) fail('Original review agreement changed');
}

// Freeze14's fingerprint and the exported prompt before issuing the review packet.
export function prepareReviewBinding(raw) {
  const q = closed(transitionData(raw), ['projectRoot', 'plan', 'graph', 'registry', 'contract', 'packet', 'prompt', 'out'], 'review preparation');
  const current = currentCandidate(q), packet = transitionBound(q.packet);
  transitionBound(q.prompt, false);
  if (q.prompt.file !== path.join(path.dirname(q.packet.file), 'prompt.md') || path.basename(q.packet.file) !== 'packet.json') fail('Use the original exported packet/prompt pair');
  const sources = packetSources(q.projectRoot, packet, q.prompt);
  outputDirectory(q.out, [q.projectRoot, q.registry]);
  const input = transitionSave(path.join(q.out, 'input.json'), { schema: 'fvs/auto-review-input', schemaVersion: 1, node: current.contract.node,
    contract: q.contract, candidateSha256: current.candidateSha256, registryHeadSha256: current.registryHeadSha256 });
  const binding = transitionSave(path.join(q.out, 'binding.json'), { schema: 'fvs/auto-driver-review-binding', schemaVersion: 1,
    projectRoot: q.projectRoot, plan: q.plan, graph: q.graph, registry: q.registry, contract: q.contract, packet: q.packet, prompt: q.prompt,
    input, sources, context: current.context, author: current.contract.author });
  return { binding, input, authority: 'pre-dispatch context only; no review verdict' };
}

// Observations are retained trusted-controller evidence, never model/OS attestation.
export async function importReviewedContract(raw) {
  const q = closed(transitionData(raw), ['projectRoot', 'binding', 'workPacket', 'marker', 'response', 'session', 'settings', 'out'], 'review import');
  const b = transitionBound(q.binding), p = readWorkPacket(q.workPacket), launch = readTransitionAction(p.launch), input = transitionBound(b.input);
  if (b.schema !== 'fvs/auto-driver-review-binding' || b.schemaVersion !== 1 || b.projectRoot !== q.projectRoot
    || launch.stage !== 'review' || p.schemaVersion !== 2 || !p.inputs.some(r => same(r, b.input))
    || !p.inputs.some(r => same(r, q.binding)) || !launch.nodes.includes(input.node)) fail('Review is not this pre-dispatch binding/assignment');
  const current = currentCandidate(b);
  if (current.candidateSha256 !== input.candidateSha256 || current.registryHeadSha256 !== input.registryHeadSha256 || !same(current.context, b.context)) fail('Review candidate/head/context changed; prepare a fresh review');
  const packet = transitionBound(b.packet); transitionBound(b.prompt, false);
  if (!same(packetSources(q.projectRoot, packet, b.prompt), b.sources)) fail('Exported review sources changed');
  const marker = transitionBound(q.marker), runtime = auto.readRuntimeState({ projectRoot: q.projectRoot }), reservation = runtime.reservations.get(p.actor.reservationId);
  if (!runtime.state || runtime.state.run.runId !== p.runId || marker.runId !== p.runId || runExpired(runtime.state.run) || q.marker.file !== p.startMarker || marker.schema !== 'fvs/auto-execution-start' || marker.schemaVersion !== 2
    || marker.status !== 'execution-uncertain' || !same(marker.packet, q.workPacket) || !same(marker.actor, p.actor)
    || marker.actionSha256 !== p.actionSha256 || marker.challenge !== p.challenge || marker.deliveryHandle !== p.deliveryHandle || !same(marker.memoryRequest, p.memoryRequest)
    || !reservation || reservation.state !== 'active'
    || !same(reservation.intent.request, p.launch) || reservation.sessionId !== p.actor.sessionId) fail('Missing current distinct reviewer start/assignment');
  reviewAuthority(q.projectRoot, launch, runtime.state.run);
  const release = runtime.state.history.find(r => r.event.position === 'before' && r.event.intent.request && (() => {
    const a = readTransitionAction(r.event.intent.request); return a.kind === 'release' && same(a.target.packet, q.workPacket);
  })());
  if (!release || !runtime.state.history.some(r => r.event.position === 'after' && r.event.beforeEventSha256 === release.sha256 && r.event.outcome === 'succeeded')) fail('Review release is not published');
  if (!same(marker.memoryEvidence, workerMemoryEvidence(marker.memoryEvidence?.out, p.memoryRequest, launch.before.fixed))) fail('Reviewer memory evidence changed');
  if (runtime.state.run.memory.mode === 'beads') auto.verifyMemoryBootstrap({ projectRoot: q.projectRoot, callerRoot: p.actor.worktree.path, request: p.memoryRequest, out: marker.memoryEvidence.out });
  const session = transitionBound(q.session).session, settings = transitionBound(q.settings), selected = transitionBound(launch.profile).stages[launch.target.selectionStage];
  const setting = id => settings.options?.find(o => o.id === id)?.currentValue;
  if (!session || session.id !== p.actor.sessionId || session.projectId !== p.actor.projectId || session.isTerminated || session.harness !== selected.harness
    || setting('model') !== selected.model || setting('effort') !== selected.effort || packet.request.model !== selected.model || packet.request.effort !== selected.effort) fail('Required actual reviewer/settings evidence unavailable or mismatched');
  const reviewer = { session: p.actor.sessionId, harness: session.harness, model: setting('model'), runId: launch.transitionId };
  if (reviewer.session === b.author.session || reviewer.runId === b.author.runId) fail('Reviewer must be a distinct fresh invocation');
  outputDirectory(q.out, [q.projectRoot, b.registry, p.actor.worktree.path]);
  const actor = observeAssignedActor({ projectRoot: q.projectRoot, ao: { tool: launch.before.fixed.aoTool, stateHome: runtime.state.run.aoStateHome,
    projectId: runtime.state.run.aoProjectId }, actor: p.actor, attemptId: crypto.randomUUID(), out: path.join(q.out, 'actor') });
  if (!same(actor, p.actor) || actor.worktree.dirty) fail('Read-only reviewer source changed');
  const returned = closed(transitionBound(q.response), ['workPacket', 'marker', 'binding', 'response', 'reviewerInvocation'], 'actual returned review');
  if (!same(returned.workPacket, q.workPacket) || !same(returned.marker, q.marker) || !same(returned.binding, q.binding) || returned.reviewerInvocation !== launch.transitionId) fail('Response belongs to another packet/binding/invocation');
  const response = transitionBound(returned.response, false);
  const helper = fileURLToPath(new URL('./fvs-spec-review.mjs', import.meta.url));
  const argv = [process.execPath, helper, 'import', path.dirname(b.packet.file), returned.response.file];
  const env = { PATH: '/usr/bin:/bin', LANG: 'C', HOME: runtime.state.run.aoStateHome, GIT_NO_LAZY_FETCH: '1' };
  const tool = { file: helper, sha256: crypto.createHash('sha256').update(transitionBytes(helper)).digest('hex') };
  const result = spawnSync(argv[0], argv.slice(1), { cwd: q.projectRoot, env, timeout: 30000, maxBuffer: 1024 * 1024 });
  const receipt = transitionSave(path.join(q.out, 'import.json'), { argv, cwd: q.projectRoot, env, tool, exitCode: result.status, signal: result.signal,
    error: result.error?.code ?? null, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') });
  if (result.status !== 0 || result.signal || result.error) fail('Other import refused; preserve response/import evidence');
  reviewAuthority(q.projectRoot, launch, runtime.state.run);
  if (crypto.createHash('sha256').update(transitionBytes(helper)).digest('hex') !== tool.sha256) fail('Import helper changed');
  if (!same(currentCandidate(b).candidateSha256, input.candidateSha256) || currentCandidate(b).registryHeadSha256 !== input.registryHeadSha256
    || auto.readRuntimeState({ projectRoot: q.projectRoot }).headSha256 !== runtime.headSha256 || runExpired(runtime.state.run)) fail('Context advanced during import; no review publication');
  const verdict = response.toString('utf8').trim().split(/\r?\n/).at(-1).trim().replace(/^[-\s]*VERDICT:\s*/i, '').toUpperCase();
  const evidence = transitionSave(path.join(q.out, 'evidence.json'), { binding: q.binding, workPacket: q.workPacket, marker: q.marker, response: q.response,
    session: q.session, settings: q.settings, actor, import: receipt, reviewer, requested: selected, observed: { harness: reviewer.harness, model: reviewer.model, effort: setting('effort') },
    provenance: 'Other externally supplied/unverified; trusted controller observations; independence declared-distinct verified:false' });
  if (verdict === 'BLOCKED') return { status: 'review-blocked', evidence, review: null, executable: false };
  if (!['PASS', 'APPROVE-WITH-EDITS', 'REVISE'].includes(verdict)) fail('Unrecognized imported verdict');
  const review = { candidateSha256: input.candidateSha256, registryHeadSha256: input.registryHeadSha256,
    verdict: verdict === 'PASS' ? 'pass' : 'changes-requested', reviewer, evidence };
  const problems = reviewProblems(review, path.join(q.out, 'review.json'), current.contract, current.candidateSha256, current.chain);
  if (problems.length) fail(problems.join('; '));
  return { status: verdict === 'PASS' ? 'review-pass-candidate' : 'review-changes-requested', review: transitionSave(path.join(q.out, 'review.json'), review), evidence,
    executable: false, proofAuthority: 'none;14 publication still needs its current paired transition' };
}

async function cli(args) {
  const [command, ...rest] = args;
  if (rest.length !== 2 || rest[0] !== '--input') fail('Usage: fvs-auto-driver.mjs prepare|advance|effect|after|prepare-review|import-review --input FILE');
  const operations = { prepare: prepareCurrentRequest, advance: advanceOnce, effect: runPairedEffect, after: recordAfter,
    'prepare-review': prepareReviewBinding, 'import-review': importReviewedContract };
  if (!Object.hasOwn(operations, command)) fail('Unknown driver operation');
  return await operations[command](transitionBound({ file: fs.realpathSync(rest[1]), sha256: crypto.createHash('sha256').update(fs.readFileSync(rest[1])).digest('hex') }));
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).then(value => {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
    if (['execution-unverified', 'facts-unverified', 'partial', 'review-blocked'].includes(value.status)) process.exitCode = 1;
  }).catch(error => {
    process.stderr.write(JSON.stringify({ code: error.code ?? 'driver-unverified', message: error.message }) + '\n'); process.exitCode = 1;
  });
}
