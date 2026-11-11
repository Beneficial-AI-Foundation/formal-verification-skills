// Feedback correspondence and current observations; never dispatch/proof authority.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseExecution, assertRunning, controlDeadline, runControl, runExpired, unbudgetedRun, runExecutionFields, timeoutOptions, withProcessCancellation } from './fvs-execution.mjs';
import { which } from './fvs-probe-inventory.mjs';
import { memoryDataSnapshot, memoryHash } from './fvs-project-memory.mjs';
import { readState, verifyReconciliation, verifyTransition, verifyMemoryBootstrap } from './fvs-auto.mjs';
import { readRuntime, readRuntimeAssignment } from './fvs-auto-resume.mjs';
import { transitionJson, readTransitionAction, readRuntimeObservation, readTransitionCompletion, verifyTransitionAuthorization, transitionValidators } from './fvs-auto-transitions.mjs';
import { validatePlan, readChain, registryStatus } from './fvs-contract-registry.mjs';
import { inspectAutoAcceptance, readAcceptedStore } from './fvs-checker-auto.mjs';
import { bundleExpectedContext, readReviewSnapshot, legacyInspectCodeCaptures, BUNDLE_LIMITS } from './fvs-auto-bundle.mjs';

export class RespecError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new RespecError(code, message); };
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const data = v => JSON.parse(JSON.stringify(memoryDataSnapshot(v)));
const same = (a, b) => memoryHash(a) === memoryHash(b);
const text = v => typeof v === 'string' && v.trim() !== '';
const sha = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const ids = a => Array.isArray(a) && a.every((id, i) => Number.isSafeInteger(id) && id >= 0 && (!i || id > a[i - 1]));
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const diagnostic = e => ({ code: e.code ?? 'respec-unverified', message: e.message });
function closed(v, keys, label) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) fail('respec-invalid-input', 'closed ' + label + ' required');
}
function bytes(file) {
  try {
    if (!text(file) || !path.isAbsolute(file) || fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()) throw Error('not canonical');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { if (fs.fstatSync(fd).size > BUNDLE_LIMITS.fileBytes) throw Error('oversized'); const b = fs.readFileSync(fd); if (b.length > BUNDLE_LIMITS.fileBytes) throw Error('grew'); return b; }
    finally { fs.closeSync(fd); }
  } catch { fail('respec-evidence-invalid', 'bounded regular input unavailable: ' + file); }
}
function reference(r) {
  closed(r, ['file', 'sha256'], 'reference');
  if (!text(r.file) || !path.isAbsolute(r.file) || !sha(r.sha256)) fail('respec-invalid-input', 'absolute reference/SHA256 required');
}
function bound(r, json = true) {
  reference(r); const b = bytes(r.file);
  if (hash(b) !== r.sha256) fail('respec-evidence-invalid', 'bound bytes changed: ' + r.file);
  return json ? transitionJson(b) : b;
}
// Largest executable in the supported pinned A122 cohort: Beads1.3.1,142769104B.
// No headroom for unqualified tool upgrades; document/source limits stay unchanged.
export const TERMINATION_EXECUTABLE_BYTES = 142769104;
// This pinned Apple dispatcher is legitimately hardlinked across system tool names.
const SYSTEM_GIT_EXECUTABLE = { file: '/usr/bin/git', sha256: 'b8763cf250e607a778bb4603cecb5b90338814d0a3dfcba0d57b1de242f610e9', size: 118640, links: 78, mode: 0o100755 };
export function terminationExecutableIdentity(raw, deadlineMs) {
  const r = data(raw); reference(r); return executableIdentity(r.file, deadlineMs, r.sha256);
}
function executableIdentity(file, deadlineMs, expectedSha256 = null) {
  if (!text(file) || !path.isAbsolute(file)) fail('respec-evidence-invalid', 'absolute executable path required');
  const r = { file, sha256: expectedSha256 }; checkControl(deadlineMs); const began = Date.now();
  const tick = () => {
    const now = Date.now();
    if (typeof deadlineMs !== 'object' && now < began) fail('respec-clock-rollback', 'tool identity clock moved backwards');
    if (controlDeadline(deadlineMs)!==null && now >= controlDeadline(deadlineMs)) fail('respec-deadline-exhausted', 'tool identity inspection deadline exhausted');
  };
  const pathStat = () => {
    if (path.normalize(r.file) !== r.file || /[\u0000-\u001f\u007f]/.test(r.file)) fail('respec-evidence-invalid', 'canonical executable path required');
    let current = path.parse(r.file).root;
    for (const part of r.file.slice(current.length).split('/')) { current = path.join(current, part); if (fs.lstatSync(current).isSymbolicLink()) fail('respec-evidence-invalid', 'executable path alias refused'); }
    if (fs.realpathSync(r.file) !== r.file) fail('respec-evidence-invalid', 'executable canonical path changed');
    return fs.lstatSync(r.file);
  };
  const sameFile = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'mode', 'uid', 'gid', 'nlink'].every(key => a[key] === b[key]);
  const valid = s => {
    const systemDispatcher = r.file === SYSTEM_GIT_EXECUTABLE.file && (r.sha256 === null || r.sha256 === SYSTEM_GIT_EXECUTABLE.sha256)
      && s.size === SYSTEM_GIT_EXECUTABLE.size && s.mode === SYSTEM_GIT_EXECUTABLE.mode && s.uid === 0 && s.gid === 0 && s.nlink >= 1 && s.nlink <= SYSTEM_GIT_EXECUTABLE.links;
    if (!s.isFile() || (s.nlink !== 1 && !systemDispatcher) || !(s.mode & 0o111)) fail('respec-evidence-invalid', 'regular non-aliased executable required');
    if (!Number.isSafeInteger(s.size) || s.size < 1 || s.size > TERMINATION_EXECUTABLE_BYTES) fail('respec-evidence-invalid', 'executable exceeds supported pinned tool size bound');
  };
  let fd;
  try {
    tick(); const original = pathStat(); valid(original);
    fd = fs.openSync(r.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(fd); valid(before);
    if (!sameFile(original, before)) fail('respec-evidence-invalid', 'executable path changed before hashing');
    // Reuse the builder digest's bounded fd-stream and before/after-stat pattern.
    const buffer = Buffer.allocUnsafe(1024 * 1024), digest = crypto.createHash('sha256'); let remaining = before.size;
    while (remaining > 0) {
      tick(); const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
      if (!count) fail('respec-evidence-invalid', 'executable shrank while hashing');
      digest.update(buffer.subarray(0, count)); remaining -= count;
    }
    tick(); if (fs.readSync(fd, buffer, 0, 1, null)) fail('respec-evidence-invalid', 'executable grew while hashing');
    const after = fs.fstatSync(fd), current = pathStat(); valid(after); valid(current); tick();
    if (!sameFile(before, after) || !sameFile(after, current)) fail('respec-evidence-invalid', 'executable identity drifted while hashing');
    const actualSha256 = digest.digest('hex');
    if (r.sha256 !== null && actualSha256 !== r.sha256) fail('respec-evidence-invalid', 'executable hash changed: ' + r.file);
    if (after.nlink !== 1 && actualSha256 !== SYSTEM_GIT_EXECUTABLE.sha256) fail('respec-evidence-invalid', 'unqualified executable alias identity');
    return { file: r.file, sha256: actualSha256, sizeBytes: after.size };
  } catch (e) {
    if (e instanceof RespecError) throw e;
    fail('respec-evidence-invalid', 'required executable identity unavailable: ' + r.file + ': ' + e.code);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function save(out, name, value) {
  const file = path.join(out, name), b = Buffer.from(JSON.stringify(data(value), null, 2) + '\n');
  const fd = fs.openSync(file, 'wx', 0o600); try { fs.writeFileSync(fd, b); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return { file, sha256: hash(b) };
}
function deadline(ms) { if (!Number.isSafeInteger(ms) || ms <= Date.now() || ms > Date.now() + BUNDLE_LIMITS.deadlineMs) fail('respec-deadline-exhausted', 'future bounded600s inspection required'); }
const controlOf=q=>{if(q.schemaVersion===2)return parseExecution(q.execution);if(!Number.isSafeInteger(q.deadlineMs))fail('respec-deadline-exhausted','future bounded600s inspection required');return q.deadlineMs;};
function checkControl(control){if(typeof control==='object')assertRunning(parseExecution(control));else deadline(control);}
const inspectionFields=q=>q.schemaVersion===2?{version:2,execution:parseExecution(q.execution)}:{deadlineMs:q.deadlineMs};
const requestExpired=(q,at)=>controlDeadline(controlOf(q))!==null&&at>=controlDeadline(controlOf(q));
const disabledMemory=q=>q.schemaVersion===2&&q.current.memory.mode==='disabled';
function respecDriver(steps) { let step=steps.next();while(!step.done){try{const d=step.value;step=steps.next(publish(d.q,d.x,d.out,d.name,d.value));}catch(error){step=steps.throw(error);}}return step.value; }
async function respecDriverV2(steps,q,services) {
  assertRunning(controlOf(q),services);let step=steps.next();
  while(!step.done){try{
    const d=step.value;await new Promise(done=>setImmediate(done));assertRunning(controlOf(q),services);
    services.beforePublication?.();assertRunning(controlOf(q),services);fence(d.q,d.x);assertRunning(controlOf(q),services);
    step=steps.next(publish(d.q,d.x,d.out,d.name,d.value));
  }catch(error){step=steps.throw(error);}}
  return step.value;
}
function versions(v, nodes, allowUnestablished = false) {
  if (!Array.isArray(v) || !same(v.map(r => r.node), nodes)) fail('respec-invalid-input', 'exact sorted node versions required');
  for (const r of v) {
    if (allowUnestablished && Object.hasOwn(r, 'unestablished')) { closed(r, ['node', 'unestablished'], 'unestablished node version'); if (!text(r.unestablished)) fail('respec-invalid-input', 'explicit unestablished reason required'); }
    else { closed(r, ['node', 'recordSha256', 'candidateSha256'], 'node version'); if (![r.recordSha256, r.candidateSha256].every(sha)) fail('respec-invalid-input', 'record/candidate identity required'); }
  }
}
function request(raw) {
  const q = data(raw);
  closed(q, ['schema', 'schemaVersion', 'revisionId', 'attemptId', 'operation', 'ownerFeedback', 'priorBundle', 'current', 'requestedItems', 'inspectEvidence', ...(q.schemaVersion===2?['execution']:['deadlineMs'])], 'revision request');
  if (q.schema !== 'fvs/auto-respec-request' || ![1,2].includes(q.schemaVersion) || ![q.revisionId, q.attemptId].every(uuid) || !['inspect', 'finish'].includes(q.operation)) fail('respec-invalid-input', 'supported revision/attempt/operation required');
  closed(q.ownerFeedback, ['ownerReference', 'evidence'], 'actual owner feedback'); if (!text(q.ownerFeedback.ownerReference)) fail('respec-invalid-input', 'retained owner reference required'); reference(q.ownerFeedback.evidence);
  closed(q.priorBundle, ['manifest', 'expectedContext'], 'prior bundle'); reference(q.priorBundle.manifest);
  closed(q.current, ['bundle', 'resume', 'memory', 'authorization', 'profile'], 'current inputs');
  closed(q.current.resume, ['request', 'result', 'committedHeadSha256'], 'current reconciliation');
  closed(q.current.memory,q.schemaVersion===2?(q.current.memory?.mode==='disabled'?['mode']:['mode','request','result']):['request','result'],'current bootstrap');
  if(q.schemaVersion===2&&!['disabled','beads'].includes(q.current.memory.mode))fail('respec-invalid-input','explicit supported memory disposition required');
  for (const r of [q.current.resume.request, q.current.resume.result, ...(!disabledMemory(q)?[q.current.memory.request,q.current.memory.result]:[]), q.current.authorization, q.current.profile]) reference(r);
  if (!sha(q.current.resume.committedHeadSha256)) fail('respec-invalid-input', 'independent committed runtime head required');
  for (const r of [q.current.resume.result,...(!disabledMemory(q)?[q.current.memory.result]:[])]) if (path.basename(r.file) !== 'result.json') fail('respec-invalid-input', 'canonical result.json required');
  if (q.operation === 'inspect' ? q.inspectEvidence !== null : !q.inspectEvidence) fail('respec-invalid-input', 'finish must pin initial inspect request/result');
  if (q.inspectEvidence !== null) { closed(q.inspectEvidence, ['request', 'result'], 'initial inspect'); reference(q.inspectEvidence.request); reference(q.inspectEvidence.result); }
  if (!Array.isArray(q.requestedItems) || !q.requestedItems.length || q.requestedItems.length > 1000) fail('respec-invalid-input', 'bounded nonempty requested items required');
  const itemIds = new Set();
  for (const item of q.requestedItems) {
    closed(item, ['itemId', 'nodes', 'expectedRecords', 'feedback', 'evidence', 'response'], 'requested item');
    if (!text(item.itemId) || itemIds.has(item.itemId) || !ids(item.nodes) || !item.nodes.length || !text(item.feedback) || !Array.isArray(item.evidence) || !item.evidence.length) fail('respec-invalid-input', 'explicit unique item/nodes/feedback evidence required');
    itemIds.add(item.itemId); versions(item.expectedRecords, item.nodes, true); item.evidence.forEach(reference);
    if (q.operation === 'inspect' && item.response !== null) fail('respec-invalid-input', 'initial inspect cannot predeclare completion');
    if (item.response !== null) reference(item.response);
  }
  checkControl(controlOf(q)); return q;
}
function canonicalAgreement(view) { return { contextSha256: view.agreement.contextSha256, choicesGeneration: view.state.choicesGeneration, approvedPayloadSha256: view.agreement.agreement.approvedPayloadSha256 }; }
function scopeOf(facts) {
  return { requestedRoots: facts.requestedRoots, failed: facts.failed, applicability: facts.applicability.map(a => ({ ...a, evidence: a.evidence.map(r => r.sha256) })) };
}
function itemFrame(items) { return items.map(({ response, ...item }) => item); }
function sourceOf(s) { return { root: s.root, commit: s.commit, tree: s.expectedTree ?? s.tree }; }
function tupleOfBundle(b) { return { source: sourceOf(b.source), registry: { root: b.registry.root, headSha256: b.registry.expectedHeadSha256 }, baseline: b.baseline, store: b.acceptedStore === null ? null : { root: b.acceptedStore.root, headSha256: b.acceptedStore.expectedHeadSha256 } }; }
function tupleOfAction(s) { return { source: sourceOf(s.source), registry: s.registry === null ? null : { root: s.registry.root, headSha256: s.registry.headSha256 }, baseline: s.baseline, store: s.store === null ? null : { root: s.store.root, headSha256: s.store.headSha256 } }; }
function frameOf(q, prior, run) {
  const b = q.current.bundle;
  return { revisionId: q.revisionId, ownerFeedback: q.ownerFeedback, priorBundle: q.priorBundle, projectRoot: b.projectRoot, sourceRoot: b.source.root,
    agreement: { contextSha256: b.agreement.contextSha256, choicesGeneration: b.agreement.choicesGeneration, approvedPayloadSha256: b.agreement.approvedPayloadSha256 },
    stages: { extraction: b.extraction, graph: b.graph, plan: b.plan }, scope: scopeOf(prior.body.facts), run,
    registryRoot: b.registry.root, storeRoot: b.acceptedStore?.root ?? null, authorization: q.current.authorization, profile: q.current.profile, requestedItems: itemFrame(q.requestedItems) };
}
function protect(out, q, prior) {
  if (!text(out) || !path.isAbsolute(out) || path.normalize(out) !== out || fs.existsSync(out) || fs.realpathSync(path.dirname(out)) !== path.dirname(out)) fail('respec-output-invalid', 'new canonical exclusive output required');
  const b = q.current.bundle, roots = [b.projectRoot, b.source.root, b.registry.root, b.acceptedStore?.root, prior.root, ...prior.protectedRoots, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')];
  if (b.baseline) {
    const frozen = bound(b.baseline), job = bound(frozen.input);
    roots.push(path.dirname(b.baseline.file), frozen.build?.projectRoot, frozen.build?.buildRoot, job.baseline?.source?.root, job.baseline?.dependencies?.root);
  }
  for (const binding of bound(b.agreement.state).memoryBindings ?? []) roots.push(binding.storeDir, binding.databasePath);
  if (roots.filter(Boolean).some(root => inside(root, out) || inside(out, root))) fail('respec-output-protected', 'output overlaps source/backend/receipt/bundle inputs');
}
function setup(q) {
  const prior = readReviewSnapshot({ manifest: q.priorBundle.manifest, ...inspectionFields(q) });
  if (!same(q.priorBundle.expectedContext, prior.body.snapshot.context)) fail('respec-frame-mismatch', 'prior bundle is not the independently requested captured context');
  const b = q.current.bundle, ctx = bundleExpectedContext(b), old = prior.body.snapshot.request;
  if (b.schemaVersion!==q.schemaVersion || old.schemaVersion!==q.schemaVersion || (q.schemaVersion===2?!same(b.execution,q.execution):b.deadlineMs > q.deadlineMs) || b.projectRoot !== old.projectRoot || b.source.root !== old.source.root) fail('respec-frame-mismatch', 'same primary/source and bounded current context required');
  for (const key of ['extraction', 'graph', 'plan']) if (!same(b[key], old[key])) fail('respec-frame-mismatch', 'nonempty-run stage identity replacement is unsupported');
  bound(q.ownerFeedback.evidence, false); q.requestedItems.forEach(item => item.evidence.forEach(r => bound(r, false)));
  const view = readState({ projectRoot: b.projectRoot, requireAgreement: true }), agreement = canonicalAgreement(view);
  if (view.agreement.agreement.mode !== 'nonpublic-intent' || !same(agreement, { contextSha256: b.agreement.contextSha256, choicesGeneration: b.agreement.choicesGeneration, approvedPayloadSha256: b.agreement.approvedPayloadSha256 })
    || !same(agreement, { contextSha256: old.agreement.contextSha256, choicesGeneration: old.agreement.choicesGeneration, approvedPayloadSha256: old.agreement.approvedPayloadSha256 })) fail('respec-context-stale', 'current canonical nonpublic agreement/generation differs');
  bound(b.agreement.state); bound(b.agreement.roadmap, false);
  const plan = bound(b.plan), graph = bound(b.graph), inv = bound(b.scopeInventory), validation = validatePlan({ json: plan, sha256: b.plan.sha256 }, { json: graph, sha256: b.graph.sha256 });
  if (inv.schema !== 'fvs/auto-bundle-scope-inventory' || inv.schemaVersion !== 1 || !same(inv.agreement, b.agreement) || !same(inv.plan, b.plan)
    || !same({ requestedRoots: inv.requestedRoots, failed: inv.failed, applicability: inv.applicability.map(a => ({ ...a, evidence: a.evidence.map(r => r.sha256) })) }, scopeOf(prior.body.facts))
    || !same(plan.selection.requestedRoots, inv.requestedRoots) || !same(plan.selection.failed, inv.failed)) fail('respec-scope-mismatch', 'full original requested/failed/applicability inventory required');
  inv.applicability.forEach(a => a.evidence.forEach(r => bound(r, false)));
  const rq = bound(q.current.resume.request), rr = bound(q.current.resume.result), mq = disabledMemory(q)?null:bound(q.current.memory.request), mr = disabledMemory(q)?null:bound(q.current.memory.result);
  if (rq.schemaVersion!==q.schemaVersion || rr.schemaVersion!==q.schemaVersion || rq.phase !== 'resume' || rq.attemptId !== q.attemptId || !same(rq.source, b.source) || !same(rq.memoryRequest, mq)
    || !same(rr.request, rq) || rr.requestSha256 !== memoryHash(rq) || rr.committedHeadSha256 !== q.current.resume.committedHeadSha256
    || (disabledMemory(q)?rr.observation?.memory?.status!=='disabled':rr.observation?.memory?.out !== path.dirname(q.current.memory.result.file) || mr.requestSha256 !== memoryHash(mq) || !same(mr.request, mq))) fail('respec-current-request-mismatch', 'own current16/20 attempt/phase/source/result required');
  for (const key of ['graph', 'plan', 'baseline']) if (!same(rq.inputs[key], b[key])) fail('respec-current-request-mismatch', 'resume stage tuple differs');
  if (!same(rq.inputs.extraction, b.extraction) || !same(rq.inputs.acceptedStore, b.acceptedStore)) fail('respec-current-request-mismatch', 'resume extraction/store tuple differs');
  const runtime = readRuntime(b.projectRoot);
  if (!runtime.state || runtime.headSha256 !== q.current.resume.committedHeadSha256 || runtime.fileSha256 !== b.runtime?.state?.sha256 || b.runtime.state.file !== path.join(b.projectRoot, '.formalising/auto-fv/resume/state.json')) fail('respec-context-stale', 'actual current committed runtime/bytes required');
  if (!same(runtime.state.run.choicesGeneration, agreement.choicesGeneration) || runtime.state.run.agreementContextSha256 !== agreement.contextSha256 || runtime.state.run.runId !== rq.runId) fail('respec-frame-mismatch', 'run context changed');
  if(runtime.state.schemaVersion!==q.schemaVersion || (q.schemaVersion===2&&(!same(runControl(runtime.state.run),q.execution)||runtime.state.run.memory.mode!==q.current.memory.mode)))fail('respec-context-stale','runtime execution/memory policy differs');
  const canonical = { view, envelope: view.agreement.agreement };
  for (const [kind, stage] of [['registry-revise', 'specification'], ['freeze', 'check'], ['check', 'check'], ['accept', 'acceptance'], ['materialize-proof', 'integration'], ['handoff', 'integration']]) verifyTransitionAuthorization({ kind, stage, authorization: q.current.authorization, profile: q.current.profile }, canonical);
  const chain = readChain(b.registry.root);
  if (chain.pending || (chain.records.at(-1)?.sha ?? null) !== b.registry.expectedHeadSha256) fail('respec-context-stale', 'pending/stale current registry');
  const store = b.acceptedStore === null ? null : readAcceptedStore(b.acceptedStore.root);
  if (store && store.headSha256 !== b.acceptedStore.expectedHeadSha256) fail('respec-context-stale', 'current store head differs');
  return { prior, b, ctx, view, runtime, rq, rr, mq, mr, chain, store, plan, inv, validation, frame: frameOf(q, prior, runtime.state.run) };
}

function chainPrefix(rows, head, shaKey) {
  if (head === null) return [];
  const index = rows.findIndex(r => r[shaKey] === head); if (index < 0) fail('respec-history-mismatch', 'expected committed prefix unavailable');
  return rows.slice(0, index + 1);
}
function nodeHeads(rows) { const m = new Map(); rows.forEach(r => m.set(r.record.defId, r)); return m; }
function checkVersions(items, heads) {
  for (const item of items) for (const r of item.expectedRecords) {
    const actual = heads.get(r.node);
    if (Object.hasOwn(r, 'unestablished')) { if (actual) fail('respec-request-stale', 'unestablished item now has a registered version; prepare a fresh inspect'); continue; }
    if (!actual || actual.sha !== r.recordSha256 || actual.record.candidateSha256 !== r.candidateSha256) fail('respec-request-stale', 'feedback is for another exact node version');
  }
}
function promotionGuard(before, after, storeRows, registryRows) {
  if (before.baseline === null || after.baseline === null) return [];
  const old = bound(before.baseline), next = bound(after.baseline), retired = old.overlayFiles.filter(file => !next.overlayFiles.includes(file)), promoted = [];
  for (const file of retired) {
    const source = next.build.source.files[file];
    if (!source) fail('respec-promotion-invalid', 'retired overlay is not protected source');
    const candidates = Object.entries(next.records).filter(([, r]) => r.contract.specDefinitions.some(d => d.file === file && d.sha256 === source.sha256));
    if (!candidates.length) fail('respec-promotion-invalid', 'prior proof must receive a new reviewed exact source descriptor');
    for (const [id, r] of candidates) {
      const node = Number(id), reviewed = registryRows.find(row => row.sha === r.semanticReview);
      if (!reviewed?.record.review || reviewed.record.review.verdict !== 'pass' || reviewed.record.candidateSha256 !== r.candidateSha256
        || old.records[id]?.candidateSha256 === r.candidateSha256 || old.records[id]?.semanticReview === r.semanticReview) fail('respec-promotion-invalid', 'promotion needs a fresh semantic review/candidate');
      const accepted = [...storeRows].reverse().find(row => row.record.node === node);
      if (!accepted || accepted.record.frozenSha256 !== before.baseline.sha256 || accepted.record.registryHeadSha256 !== old.registry.headSha256
        || accepted.record.integrated.commit !== next.fixtureSource.commit || accepted.record.integrated.tree !== next.fixtureSource.tree) fail('respec-promotion-invalid', 'no prior exact current integrated proof source for promotion');
      const checked = bound(accepted.record.integratedCheck);
      if (checked.build.source.files[file]?.sha256 !== source.sha256 || checked.source.commit !== next.fixtureSource.commit || checked.source.tree !== next.fixtureSource.tree) fail('respec-promotion-invalid', 'whole proof bytes/Git mode tree differs from prior acceptance');
      const modules = [file.slice(0, -5).replaceAll('/', '.'), ...next.overlayFiles.map(f => f.slice(0, -5).replaceAll('/', '.'))];
      if (next.expected.contexts.some(c => c.projectImports.some(m => modules.includes(m.name)))) fail('respec-promotion-invalid', 'expected context imports a prior or mutable proof module');
      promoted.push({ node, file, sha256: source.sha256, source: { commit: next.fixtureSource.commit, tree: next.fixtureSource.tree }, priorReceiptSha256: accepted.sha256, semanticReviewSha256: r.semanticReview });
    }
  }
  return promoted;
}
const legacyInspect = {
  respec: '6593d0f4f8ef6d0ddc510666644946ce4fc85898a161610fdc2f00d6c121a866',
  bundle: '340a0278d334c43036acd147341c2d72009de36f5fba49f63f4e043cdac10e5a',
};
function inspectImplementation(v) {
  const current = implementation();
  if (same(v, current)) return true;
  const expected = { respec: { file: current.respec.file, sha256: legacyInspect.respec }, bundle: { file: current.bundle.file, sha256: legacyInspect.bundle } };
  // Historical340a is retained as data beside6593, independently of the
  // upgraded current collector. Only this exact old inspect pair is accepted.
  if (!same(v, expected)) return false;
  try { return legacyInspectCodeCaptures(v).every(c => (fs.statSync(c.archive.file).mode & 0o777) === c.mode
    && hash(bytes(c.archive.file)) === c.archive.sha256); }
  catch { return false; }
}
function storeHeads(rows) {
  const heads = new Map();
  for (const { sha256, record } of rows) heads.set(record.node, { node: record.node, sha256, integrated: record.integrated,
    frozenSha256: record.frozenSha256, registryHeadSha256: record.registryHeadSha256, dependencies: record.dependencies });
  return [...heads.values()].sort((a, b) => a.node - b.node);
}
function failedLocalSnapshot(a, before, after, observation, run, registryRows, storeRows) {
  const bad = message => fail('respec-failure-unverified', message), e = after.event, snapshot = observation.transition?.snapshot;
  if (e.position !== 'after' || e.outcome !== 'failed' || before?.event.position !== 'before' || e.beforeEventSha256 !== before.sha256
    || !same(e.intent, before.event.intent) || e.intent.effect.kind !== 'local' || !same(e.intent.request, before.event.intent.request)
    || !['check', 'accept', 'freeze'].includes(a.kind) || a.stage !== (a.kind === 'accept' ? 'acceptance' : 'check')
    || a.runId !== run.runId || a.transitionId !== e.intent.transitionId || a.reservationId !== e.intent.reservationId
    || a.owner !== e.intent.owner || !same(a.nodes, e.intent.nodes) || a.expectedHeadSha256 !== before.event.prev
    || e.effect.sessionId !== null || e.effect.association !== null || e.effect.resolution !== null
    || observation.transition?.admissibility.status !== 'facts-unverified' || observation.transition.admissibility.next !== null
    || observation.transition.admissibility.executable !== false || observation.transition.admissibility.reason !== 'effect-outcome-failed'
    || !snapshot || a.before.worker !== null || !same(a.before, snapshot)) bad('exact failed local producer with unchanged complete snapshot required');
  const original = readRuntimeObservation(before.event);
  if (original.transition?.admissibility.status !== 'next-action-eligible' || !same(original.transition.snapshot, a.before)) bad('original independently eligible before observation required');
  const fixed = a.before.fixed;
  if (fixed.runId !== run.runId || fixed.canonicalRoot !== run.canonicalRoot || fixed.gitCommonDir !== run.gitCommonDir
    || fixed.startedAtMs !== run.startedAtMs || fixed.deadlineMs !== run.deadlineMs || fixed.choicesGeneration !== run.choicesGeneration
    || fixed.agreementContextSha256 !== run.agreementContextSha256 || fixed.scopeSha256 !== memoryHash(run.scope)
    || fixed.limitsSha256 !== memoryHash(run.limits) || !same(fixed.authorization, a.authorization) || !same(fixed.profile, a.profile)
    || snapshot.source.dirty || snapshot.registry?.pending || snapshot.store?.pending) bad('original run/grant/context or pending canonical mutation changed');
  if (snapshot.baseline) bound(snapshot.baseline);
  if (snapshot.registry) chainPrefix(registryRows, snapshot.registry.headSha256, 'sha');
  if (snapshot.store && !same(snapshot.store.heads, storeHeads(chainPrefix(storeRows, snapshot.store.headSha256, 'sha256')))) bad('complete accepted-store prefix/heads differ');
  return snapshot;
}
function conclusiveLocalFailure(a, before, after, observation, run, registryRows, storeRows, identityDeadlineMs) {
  const snapshot = failedLocalSnapshot(a, before, after, observation, run, registryRows, storeRows), e = after.event;
  const bad = message => fail('respec-failure-unverified', message);
  const commands = e.effect.evidence.filter(ref => { try { return transitionJson(bound(ref, false)).schema === 'fvs/auto-command-receipt'; } catch (err) { if (err.code !== 'transition-invalid-input') throw err; return false; } });
  if (commands.length !== 1) bad('one exact retained terminal command required');
  const command = bound(commands[0]);
  closed(command, ['schema', 'schemaVersion', 'runId', 'transitionId', 'actionSha256', 'argv', 'cwd', 'env', 'tool', 'startedAtMs', 'endedAtMs', 'exitCode', 'signal', 'error', 'stdout', 'stderr'], 'terminal command');
  const autoFile = fileURLToPath(new URL('fvs-auto.mjs', import.meta.url)), argv = command.argv, job = bound(a.target.request), source = job.source ?? job.baseline?.source;
  if (command.schemaVersion !== 1 || command.runId !== run.runId || command.transitionId !== a.transitionId || command.actionSha256 !== memoryHash(a)
    || !Array.isArray(argv) || argv.length !== 7 || !same(argv.slice(0, 6), [process.execPath, autoFile, a.kind, '--request', a.target.request.file, '--out'])
    || !text(argv[6]) || !path.isAbsolute(argv[6]) || path.normalize(argv[6]) !== argv[6] || command.cwd !== snapshot.source.root
    || command.tool.file !== process.execPath || job.schema !== 'fvs-checker/' + a.kind + '-request' || job.version !== 1 || job.purpose !== 'auto'
    || !source || source.root !== snapshot.source.root || source.commit !== snapshot.source.commit || source.expectedTree !== snapshot.source.tree
    || !Number.isSafeInteger(job.deadlineMs) || job.deadlineMs > run.deadlineMs || job.deadlineMs <= before.event.observedAtMs
    || !Number.isSafeInteger(command.startedAtMs) || !Number.isSafeInteger(command.endedAtMs) || command.startedAtMs < before.event.observedAtMs
    || command.endedAtMs < command.startedAtMs || command.endedAtMs > e.observedAtMs || command.endedAtMs > Date.now()
    || command.signal !== null || command.error !== null) bad('command is not the original exact producer invocation/terminal interval');
  const allowedEnv = ['PATH', 'LANG', 'LC_ALL', 'HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_NO_LAZY_FETCH', 'GIT_NO_REPLACE_OBJECTS', 'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT', 'DISABLE_TELEMETRY', 'DO_NOT_TRACK'];
  if (!command.env || Object.keys(command.env).some(k => !allowedEnv.includes(k) || typeof command.env[k] !== 'string') || command.env.GIT_NO_LAZY_FETCH !== '1') bad('command environment is not the retained offline allowlist');
  if (a.kind === 'accept' && (job.node !== a.target.node || !same(job.store, { root: snapshot.store?.root, expectedHeadSha256: snapshot.store?.headSha256 }))) bad('acceptance target/store differs');
  if (a.kind === 'check' && !same(job.nodes, a.target.nodes)) bad('check scope differs');
  if (a.kind !== 'freeze' && !same(job.baseline, snapshot.baseline)) bad('producer frozen context differs');
  if (a.kind === 'freeze' && !same(job.registry, { root: snapshot.registry?.root, headSha256: snapshot.registry?.headSha256 })) bad('freeze registry differs');
  terminationExecutableIdentity(command.tool, identityDeadlineMs); const output = bound(command.stdout), stderr = bound(command.stderr, false).toString('utf8');
  closed(output, ['ok', 'status', 'code', 'message'], 'terminal refusal');
  const codes = { 4: ['audit-failed'], 5: ['invalid-input'], 6: ['unsupported', 'baseline-unavailable'], 7: ['stale-input'], 8: ['timeout'] };
  if (!Number.isInteger(command.exitCode) || !codes[command.exitCode]?.includes(output.code) || output.ok !== false || output.status !== 'unverified' || !text(output.message)
    || !stderr.trim().endsWith('FVS >> ' + output.code + ': ' + output.message)) bad('definite matching non-success command/refusal required');
  return { beforeEventSha256: before.sha256, afterEventSha256: after.sha256, action: before.event.intent.request, command: commands[0],
    runId: run.runId, reservationId: a.reservationId, terminalOutcome: 'failed', diagnostic: output, canonical: tupleOfAction(snapshot),
    authority: 'execution-closure-only; no tuple advance or successor', effectExecutable: false, proofAuthority: 'none' };
}
function failureRequest(raw) {
  const q = data(raw);
  closed(q, ['schema', 'schemaVersion', 'attemptId', 'runId', 'expectedBeforeEventSha256', 'expectedAction', 'expectedCommand', 'afterRequest', 'afterResult', 'committedHeadSha256', 'deadlineMs'], 'failure consumer request');
  if (q.schema !== 'fvs/auto-respec-failure-request' || q.schemaVersion !== 1 || ![q.attemptId, q.runId].every(uuid)
    || ![q.expectedBeforeEventSha256, q.committedHeadSha256].every(sha)) fail('respec-invalid-input', 'exact caller-owned failure identities required');
  for (const r of [q.expectedAction, q.expectedCommand, q.afterRequest, q.afterResult]) reference(r);
  if (path.basename(q.afterResult.file) !== 'result.json') fail('respec-invalid-input', 'canonical after result required');
  deadline(q.deadlineMs); return q;
}

const terminationProfile = 'configured-git-local-accept-finalization-v1';
const terminationCode = {
  controller: '62315a0f29dc442f7510bca27b131395b88b43f8b7434adb8ee29db3272ef11c',
  wrapper: '20880aa84d4c501c11e957efd9153713d7ee6302712e8cc98afff37c28dd34a3',
  driver: '42ed95891be91d31e808ed2cc1f1df6f545c25243408e0b8897e0d8ab816089d',
  builder: '6558d19c217cd25158e47521e18202e4fecbfd8a09c87c6b4512479577eea246',
};
const terminationTrust = 'trusted-host known managed lifecycle; no retrospective full PID lineage or inner producer outcome';
const processArgs = ['-axo', 'pid=,ppid=,pgid=,command='];
const integer = v => Number.isSafeInteger(v) && v > 0;
const terminationBad = message => fail('respec-termination-unverified', message);
function canonicalPath(file) {
  if (!text(file) || !path.isAbsolute(file) || path.normalize(file) !== file) terminationBad('canonical absolute lifecycle path required');
}
function processInventory(ref, tool, floor, ceiling, pid, pgid, ownedPaths, identityDeadlineMs) {
  const r = bound(ref);
  closed(r, ['schema', 'schemaVersion', 'tool', 'argv', 'cwd', 'observerPid', 'startedAtMs', 'endedAtMs', 'exitCode', 'signal', 'error', 'outputLimitExceeded', 'stdout', 'stderr'], 'complete process observation');
  if (r.schema !== 'fvs/auto-process-inventory' || r.schemaVersion !== 1 || !same(r.tool, tool)
    || tool.file !== fs.realpathSync('/bin/ps') || !same(r.argv, [tool.file, ...processArgs]) || r.cwd !== '/'
    || !integer(r.observerPid) || !Number.isSafeInteger(r.startedAtMs) || !Number.isSafeInteger(r.endedAtMs)
    || r.startedAtMs < floor || r.endedAtMs < r.startedAtMs || r.endedAtMs > ceiling
    || r.exitCode !== 0 || r.signal !== null || r.error !== null || r.outputLimitExceeded !== false) terminationBad('failed, incomplete or unrelated process observer');
  terminationExecutableIdentity(tool, identityDeadlineMs); const stdout = bound(r.stdout, false).toString('utf8'), stderr = bound(r.stderr, false).toString('utf8');
  if (!stdout.trim() || stderr.trim()) terminationBad('empty or incomplete process inventory is not quiescence');
  const seen = new Set();
  for (const line of stdout.trimEnd().split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*)$/.exec(line);
    if (!m || [m[1], m[2], m[3]].some(v => !Number.isSafeInteger(Number(v)) || Number(v) < 0) || seen.has(Number(m[1]))) terminationBad('malformed or duplicate process row');
    seen.add(Number(m[1]));
    if (Number(m[1]) === pid || Number(m[3]) === pgid) terminationBad('controller or managed process group still present');
    if (Number(m[1]) !== r.observerPid && ownedPaths.some(file => m[4].includes(file))) terminationBad('owned or detached work remains visible');
  }
  if (!seen.has(1) || !seen.has(r.observerPid)) terminationBad('observer inventory omits its own process or init');
  return { evidence: ref, observedAtMs: r.endedAtMs, processCount: seen.size, scope: terminationTrust };
}
// A current, bounded observation only. It never records or closes a reservation.
export function captureControllerProcessObservation(options) {
  options = data(options); closed(options, ['action', 'tool', 'out', 'deadlineMs'], 'process capture');
  const { action, tool, out, deadlineMs } = options; reference(tool); deadline(deadlineMs); terminationExecutableIdentity(tool, deadlineMs);
  const a = readTransitionAction(action);
  if (tool.file !== fs.realpathSync('/bin/ps')) terminationBad('only the fixed complete process query is supported');
  canonicalPath(out);
  const roots = [a.before.fixed.canonicalRoot, a.before.fixed.gitCommonDir, a.before.source.root, a.before.registry?.root, a.before.store?.root,
    a.before.baseline && path.dirname(a.before.baseline.file), path.dirname(action.file), path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')].filter(Boolean);
  if (fs.existsSync(out) || fs.realpathSync(path.dirname(out)) !== path.dirname(out) || roots.some(root => inside(root, out) || inside(out, root))) fail('respec-output-invalid', 'exclusive process evidence outside canonical/input state required');
  fs.mkdirSync(out, { mode: 0o700 }); const argv = [tool.file, ...processArgs], startedAtMs = Date.now();
  const p = spawnSync(argv[0], argv.slice(1), { cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    timeout: Math.max(1, Math.min(10000, deadlineMs - startedAtMs)), maxBuffer: 1024 * 1024 });
  const stream = (name, b) => { const file = path.join(out, name); fs.writeFileSync(file, b, { flag: 'wx', mode: 0o600 }); return { file, sha256: hash(b) }; };
  const value = { schema: 'fvs/auto-process-inventory', schemaVersion: 1, tool, argv, cwd: '/', observerPid: process.pid,
    startedAtMs, endedAtMs: Date.now(), exitCode: p.status, signal: p.signal, error: p.error?.code ?? null,
    outputLimitExceeded: p.error?.code === 'ENOBUFS', stdout: stream('stdout', p.stdout ?? Buffer.alloc(0)), stderr: stream('stderr', p.stderr ?? Buffer.alloc(0)) };
  const evidence = save(out, 'result.json', value);
  if (value.exitCode !== 0 || value.signal !== null || value.error !== null || value.endedAtMs >= deadlineMs) terminationBad('process query did not complete within its bound');
  return { ...value, evidence, authority: 'process observation only; no execution closure or proof' };
}
function terminationContext(raw, identityDeadlineMs) {
  const c = data(raw);
  closed(c, ['schema', 'schemaVersion', 'lifecycle', 'trustScope', 'runId', 'beforeEventSha256', 'transitionId', 'reservationId', 'action', 'job',
    'caseRoot', 'evidenceRoot', 'producerOut', 'step', 'code', 'tools', 'sourceSnapshot', 'beforeRequest', 'beforeResult', 'marker',
    'launch', 'outer', 'prepared', 'controllerBefore', 'caseContext', 'candidateCheckOrigin', 'recoveryBefore', 'build', 'observer', 'canonicalObservations', 'innerProducer'], 'controller termination context');
  if (c.schema !== 'fvs/auto-controller-termination-context' || c.schemaVersion !== 2 || c.lifecycle !== terminationProfile || c.trustScope !== terminationTrust
    || ![c.runId, c.transitionId, c.reservationId].every(uuid) || !sha(c.beforeEventSha256) || !/^\d{3}-[a-z0-9-]+$/.test(c.step)) terminationBad('unsupported lifecycle or independently expected identities');
  for (const key of ['caseRoot', 'evidenceRoot', 'producerOut']) canonicalPath(c[key]);
  closed(c.code, Object.keys(terminationCode), 'assessed source identities');
  for (const [key, digest] of Object.entries(terminationCode)) { reference(c.code[key]); if (c.code[key].sha256 !== digest) terminationBad('unassessed controller or producer lifecycle'); bound(c.code[key], false); }
  closed(c.tools, ['node', 'bd', 'lean', 'lake', 'ps'], 'independent tool identities');
  for (const r of Object.values(c.tools)) terminationExecutableIdentity(r, identityDeadlineMs);
  closed(c.sourceSnapshot, ['head', 'tree', 'files'], 'historical source snapshot');
  if (!/^[0-9a-f]{40}$/.test(c.sourceSnapshot.head) || !/^[0-9a-f]{40}$/.test(c.sourceSnapshot.tree)
    || !Array.isArray(c.sourceSnapshot.files) || !c.sourceSnapshot.files.length || c.sourceSnapshot.files.length > 10000) terminationBad('complete historical source identities required');
  const paths = new Set();
  for (const f of c.sourceSnapshot.files) {
    closed(f, ['path', 'sha256', 'mode', 'size'], 'historical source file');
    if (!text(f.path) || path.isAbsolute(f.path) || f.path.split('/').some(p => !p || p === '.' || p === '..') || paths.has(f.path)
      || !sha(f.sha256) || !['100644', '100755'].includes(f.mode) || !Number.isSafeInteger(f.size) || f.size < 0) terminationBad('malformed or duplicate historical source identity');
    paths.add(f.path);
  }
  for (const key of ['action', 'job', 'beforeRequest', 'beforeResult', 'marker', 'launch', 'outer', 'prepared', 'controllerBefore', 'caseContext', 'candidateCheckOrigin', 'recoveryBefore', 'observer', 'canonicalObservations']) reference(c[key]);
  closed(c.innerProducer, ['startedAtMs', 'endedAtMs', 'exitCode', 'signal', 'error', 'status'], 'unknown inner outcome');
  if (!same(c.innerProducer, { startedAtMs: null, endedAtMs: null, exitCode: null, signal: null, error: null, status: 'unknown' })) terminationBad('missing inner outcome must remain unknown');
  closed(c.build, ['root', 'source', 'runtime', 'dependenciesBefore', 'dependenciesAfter', 'ownedDependenciesAfter', 'libraries', 'children'], 'known finalization boundary');
  canonicalPath(c.build.root);
  for (const key of ['source', 'runtime', 'dependenciesBefore', 'dependenciesAfter', 'ownedDependenciesAfter']) reference(c.build[key]);
  if (!Array.isArray(c.build.children) || c.build.children.length < 10 || c.build.children.length > 1000 || !Array.isArray(c.build.libraries)
    || !c.build.libraries.length || c.build.libraries.some(v => !text(v))) terminationBad('complete bounded configured child sequence required');
  c.build.children.forEach(reference); return c;
}
// Correspondence assertion only, never termination/currentness/closure authority.
// The public verifier always uses the real bound reader; tests may supply copied metadata.
export function assertKnownControllerPreparation(raw, read = bound) {
  const { context: c, action: a, before, run, beforeRequest: bq, beforeResult: br, prepared: p, outer, history } = data(raw);
  const eq = (x, y) => x !== undefined && y !== undefined && same(x, y);
  const bad = message => terminationBad('assessed controller profile: ' + message);
  const get = r => { reference(r); return read(r); };
  const base = '/private/tmp/fvs45-ticket18-native-episode-0c4c1ino', step = '122-e1-accept-20-continuous';
  const root = '/Users/ada/.ao/data/worktrees/formal-verification-skills/formal-verification-skills-45';
  if (c.schema !== 'fvs/auto-controller-termination-context' || c.schemaVersion !== 2 || c.lifecycle !== terminationProfile || c.trustScope !== terminationTrust
    || c.caseRoot !== base || c.step !== step || a.kind !== 'accept' || a.stage !== 'acceptance' || a.target.node !== 20 || a.nodes.length
    || a.owner !== 'qualification-controller' || run.runId !== '386aca9c-66af-4a02-be70-6afff41a60d5' || c.runId !== run.runId
    || run.startedAtMs !== 1793592237017 || run.deadlineMs !== 1793736237017) bad('unsupported case, step, target or original run');
  if (outer.cwd !== root || outer.head !== '226e540c1e954c2f891f72edb9d86642a4e375f3' || outer.tree !== '0f6cd1105a38e23a64f6473fbcb9b2a4fcac40a9'
    || c.sourceSnapshot.head !== outer.head || c.sourceSnapshot.tree !== outer.tree
    || memoryHash(c.sourceSnapshot) !== '404af7b2293e645e0922a2fdc9b9c038711d73463cc180d7e38a6eb6a34bb889'
    || c.code.controller.file !== '/private/tmp/fvs45-ticket18-continuous-proposal-v34.mjs'
    || c.code.wrapper.file !== '/private/tmp/fvs45-ticket18-continuous-phase-proposal-v40.py'
    || c.code.driver.file !== '/private/tmp/fvs45-ticket18-continuous-driver-proposal-v41.py') bad('unsupported wrapper/source invocation');
  if (c.controllerBefore.file !== path.join(base, 'steps', step, 'before.json') || c.caseContext.file !== path.join(base, 'context.json')
    || c.job.file !== path.join(base, 'steps', step, 'producer-request.json') || c.prepared.file !== path.join(c.evidenceRoot, 'prepared-inputs.json')) bad('durable controller input paths disagree');
  closed(p, ['schema', 'version', 'status', 'runId', 'q', 'snapshot', 'runtimeFileSha256', 'closure', 'closureConsumed', 'proposalOrigin', 'beganAtMs', 'endedAtMs', 'authority'], 'controller preparation');
  if (p.schema !== 'fvs/owned-continuous-input-preparation' || p.version !== 1 || p.status !== 'non-authoritative-inputs-only' || p.runId !== run.runId
    || !p.q?.inputs || !p.q?.source || !p.q?.ao || !p.q?.memoryRequest?.expected || !p.snapshot?.fixed || !p.snapshot?.store || !p.snapshot?.source || !p.snapshot?.registry) bad('incomplete prepared request/snapshot');
  const item = get(c.controllerBefore), cc = get(c.caseContext), job = get(c.job);
  closed(item, ['q', 'action', 'actionRef', 'before', 'prepared', 'recoveryClosure', 'proposalOrigin'], 'controller before envelope');
  if (item.before) closed(item.before, ['q', 'out', 'result', 'manifest'], 'recorded controller before invocation');
  if (!item.before || !eq(item.actionRef, c.action) || !eq(item.action, a) || !eq(item.q, bq) || !eq(item.before.q, bq) || !eq(item.before.result, br)
    || item.before.out !== path.dirname(c.beforeResult.file) || c.beforeRequest.file !== path.join(item.before.out, 'request.json')
    || c.beforeResult.file !== path.join(item.before.out, 'result.json') || !eq(item.prepared, c.prepared)
    || !eq(get(item.before.manifest), { q: bq, out: item.before.out, result: br })) bad('controller before envelope does not bind the actual before/action');
  if (!cc.extraction || cc.schema !== 'fvs/owned-native-transition-qualification' || cc.schemaVersion !== 1 || cc.runId !== run.runId
    || cc.root !== path.join(base, 'control') || cc.root !== run.canonicalRoot || cc.integration !== path.join(base, 'integration')
    || cc.registry !== path.join(base, 'registry') || cc.registry !== a.before.registry.root || job.source.root !== cc.integration
    || !eq(cc.authorization, a.authorization) || !eq(cc.profile, a.profile) || !eq(cc.accounting, p.q.priorAccounting)
    || cc.projectId !== p.q.ao.projectId || cc.aoHome !== p.q.ao.stateHome || cc.aoTool !== p.q.ao.tool.file
    || !eq(cc.extraction.identity, p.q.inputs.extraction) || !eq(cc.extraction.graph, p.q.inputs.graph) || !eq(cc.extraction.plan, p.q.inputs.plan)) bad('case context does not bind the prepared workflow');
  const resetBefore = { ...bq, transition: null }, frozen = get(job.baseline);
  if (!eq(p.q, resetBefore) || p.q.transition !== null || p.q.runId !== run.runId || p.q.expectedHeadSha256 !== before.event.prev
    || !eq(p.q.source, job.source) || !eq(p.q.inputs.baseline, job.baseline) || !eq(p.q.inputs.acceptedStore, job.store)
    || !eq(p.snapshot, a.before) || !eq(p.snapshot.baseline, job.baseline) || p.snapshot.source.root !== job.source.root
    || p.snapshot.source.commit !== job.source.commit || p.snapshot.source.tree !== job.source.expectedTree || p.snapshot.worker !== null
    || p.snapshot.store.root !== job.store.root || p.snapshot.store.headSha256 !== job.store.expectedHeadSha256
    || !eq(frozen.overlayFiles, ['Specs/CheckerOverlayV1.lean']) || !eq(frozen.registry, { root: p.snapshot.registry.root, headSha256: p.snapshot.registry.headSha256 })
    || !eq(p.snapshot.fixed.graph, p.q.inputs.graph) || !eq(p.snapshot.fixed.plan, p.q.inputs.plan)
    || p.snapshot.fixed.memoryBindingSha256 !== p.q.memoryRequest.expected.bindingSha256) bad('prepared source/baseline/store/snapshot disagreement');
  const origin = path.join(base, 'steps', '110-e1-accept-19', 'after.json');
  if (p.proposalOrigin.file !== origin || !eq(item.proposalOrigin, { scope: 'NON-AUTHORITATIVE prior successful after snapshot; production before/execute/consume unchanged', file: p.proposalOrigin })) bad('unrelated prepared snapshot origin');
  const prior = get(p.proposalOrigin), priorRow = history.find(r => r.sha256 === prior.afterEventSha256);
  if (!priorRow || priorRow.event.outcome !== 'succeeded' || priorRow.event.beforeEventSha256 !== prior.beforeEventSha256
    || !priorRow.event.effect.evidence.some(r => eq(r, prior.completion)) || prior.recorded.result.recordedEventSha256 !== prior.afterEventSha256
    || !eq(prior.recorded.result.observation.transition.snapshot, p.snapshot)
    || !eq(a.basis, { version: 2, beforeEventSha256: prior.beforeEventSha256, afterEventSha256: prior.afterEventSha256, completion: prior.completion, workCompletion: null })) bad('prepared prior snapshot/basis is not its retained successful row');
  const check = get(c.candidateCheckOrigin);
  if (c.candidateCheckOrigin.file !== path.join(base, 'steps', '100-e1-check', 'after.json') || !eq(job.candidateCheck, check.result)
    || !job.runId.startsWith('owned18-' + step + '-') || !uuid(job.runId.slice(('owned18-' + step + '-').length))) bad('job is not the exact prepared acceptance request');
  const closure = get(p.closure), consumed = get(p.closureConsumed), rq = get(closure.request), closedAfter = get(rq.afterResult), closedRequest = get(rq.afterRequest);
  const failed = get(c.recoveryBefore), previous = history.find(r => r.sha256 === closure.head);
  const oldImplementation = Object.fromEntries(['respec', 'bundle'].map(name => {
    const rel = 'scripts/fvs-auto-' + name + '.mjs';
    return [name, { file: path.join(root, rel), sha256: c.sourceSnapshot.files.find(row => row.path === rel)?.sha256 }];
  }));
  if (c.recoveryBefore.file !== path.join(base, 'steps', '121-e1-accept-20-recovery', 'before.json')
    || closure.schema !== 'fvs/owned-respec-failure-closure' || closure.version !== 1
    || rq.schema !== 'fvs/auto-respec-failure-request' || rq.schemaVersion !== 1
    || rq.expectedBeforeEventSha256 !== 'b9116775d9678f3f0ca91b01c94b8f0235663dcaa56f1ea24fdd6624ac685f4a'
    || rq.expectedCommand.sha256 !== 'eede7dd199db9f3fdeb4a139e1384ec7dc0a16dc001a705e0e6645a77a8c2248'
    || !eq(rq.expectedAction, failed.actionRef) || !eq(item.recoveryClosure, { closure: p.closure, consumed: p.closureConsumed })
    || !previous || previous.event.position !== 'after' || previous.event.outcome !== 'failed' || previous.event.beforeEventSha256 !== rq.expectedBeforeEventSha256
    || !eq(previous.event.intent.request, rq.expectedAction) || previous.event.intent.reservationId !== failed.action.reservationId
    || closure.head !== before.event.prev || closure.head !== p.q.expectedHeadSha256 || rq.committedHeadSha256 !== closure.head || rq.runId !== run.runId
    || closedAfter.committedHeadSha256 !== closure.head || closedAfter.recordedEventSha256 !== closure.head
    || !eq(closedAfter.request, closedRequest) || closedAfter.requestSha256 !== memoryHash(closedRequest)
    || closedAfter.runtimeFileSha256 !== p.runtimeFileSha256 || consumed.runtimeFileSha256 !== p.runtimeFileSha256
    || consumed.schema !== 'fvs/auto-respec-local-failure' || consumed.schemaVersion !== 1 || consumed.terminalOutcome !== 'failed'
    || consumed.authority !== 'execution-closure-only; no tuple advance or successor'
    || consumed.status !== 'conclusive-no-canonical-effect' || consumed.proofAuthority !== 'none' || consumed.effectExecutable !== false
    || consumed.committedHeadSha256 !== closure.head || consumed.afterEventSha256 !== closure.head || consumed.runId !== run.runId
    || consumed.reservationId !== failed.action.reservationId || !eq(consumed.action, rq.expectedAction) || !eq(consumed.implementation, oldImplementation)
    || consumed.beforeEventSha256 !== rq.expectedBeforeEventSha256
    || !eq(consumed.request, rq) || consumed.requestSha256 !== memoryHash(rq) || !eq(consumed.command, rq.expectedCommand)
    || !eq(outer.immutableInputsBefore, [p.closure, c.prepared]) || !eq(outer.immutableInputsAfter, [p.closure, c.prepared])) bad('unrelated predecessor/runtime/closure');
  if (![p.beganAtMs, p.endedAtMs, consumed.beganAtMs, consumed.endedAtMs].every(Number.isSafeInteger)
    || p.beganAtMs < run.startedAtMs || p.endedAtMs < p.beganAtMs || consumed.beganAtMs < p.beganAtMs || consumed.endedAtMs > p.endedAtMs
    || p.endedAtMs > outer.startedAtMs || outer.startedAtMs > before.event.observedAtMs
    || job.deadlineMs < outer.absoluteDeadlineMs || job.deadlineMs > Math.min(before.event.observedAtMs + 600000, run.deadlineMs)) bad('recorded preparation/before/job ordering disagrees');
}
function terminationChildren(c, job, before, outer) {
  const source = bound(c.build.source), runtime = bound(c.build.runtime), beforeDeps = bound(c.build.dependenciesBefore), afterDeps = bound(c.build.dependenciesAfter), ownedDeps = bound(c.build.ownedDependenciesAfter);
  if (c.build.root !== path.join(c.producerOut, 'integrated/candidate-build') || c.build.source.file !== path.join(c.build.root, 'receipts/source.json')
    || source.kind !== 'git' || source.originalRoot !== job.source.root || source.commit !== job.source.commit || source.tree !== job.source.expectedTree
    || !source.files || !Object.keys(source.files).length || !runtime.files || !Object.keys(runtime.files).length || !same(beforeDeps, afterDeps)) terminationBad('source/runtime/dependency snapshots do not establish the known build');
  const changes = Object.keys({ ...beforeDeps, ...ownedDeps }).filter(file => !same(beforeDeps[file] ?? null, ownedDeps[file] ?? null));
  if (changes.some(file => !file.endsWith('/.git/index'))) terminationBad('owned dependency source/config drift');
  for (const name of ['outputs.json', 'result.json', 'failure.json']) if (fs.existsSync(path.join(c.build.root, 'receipts', name))) terminationBad('unsupported or advanced finalization boundary');
  if (fs.existsSync(path.join(c.producerOut, 'integrated/kernel-request.json'))) terminationBad('unobserved later kernel work is unsupported');
  const directory = path.join(c.build.root, 'receipts'), count = c.build.children.length, expected = Array.from({ length: count }, (_, i) => String(i + 1).padStart(4, '0'));
  const numeric = fs.readdirSync(directory).filter(n => /^\d{4}\.(json|stdout|stderr)$/.test(n)).sort();
  if (!same(numeric, expected.flatMap(id => [id + '.json', id + '.stderr', id + '.stdout']).sort())) terminationBad('missing, extra or unreceipted child sequence');
  const children = c.build.children.map((ref, i) => {
    if (ref.file !== path.join(directory, expected[i] + '.json')) terminationBad('reordered or foreign child receipt');
    const r = bound(ref); closed(r, ['argv', 'cwd', 'exit', 'signal', 'timedOut', 'startedAt', 'endedAt', 'stdout', 'stderr', 'inputsBefore', 'inputsAfter', 'outputLimitExceeded',
      ...(Object.hasOwn(r, 'error') ? ['error'] : []), ...(Object.hasOwn(r, 'drift') ? ['drift'] : [])], 'terminal child');
    if (r.exit !== 0 || r.signal !== null || r.timedOut !== false || r.outputLimitExceeded !== false || Object.hasOwn(r, 'error') || Object.hasOwn(r, 'drift')
      || !sha(r.inputsBefore) || r.inputsBefore !== r.inputsAfter || !Number.isSafeInteger(r.startedAt) || !Number.isSafeInteger(r.endedAt)
      || r.startedAt < before.event.observedAtMs || r.endedAt < r.startedAt || r.endedAt > outer.endedAtMs) terminationBad('nonterminal, failed or drifting child is not quiescence');
    for (const [key, suffix] of [['stdout', '.stdout'], ['stderr', '.stderr']]) { if (r[key].file !== path.join(directory, expected[i] + suffix)) terminationBad('foreign child output'); bound(r[key], false); }
    return r;
  });
  for (let i = 1; i < count; i++) if (children[i].startedAt < children[i - 1].endedAt) terminationBad('unknown concurrent or detached work');
  const prefix = ['/usr/bin/sandbox-exec', '-f', path.join(c.build.root, 'build.sb')], project = path.join(c.build.root, 'source');
  const final = [
    [...prefix, c.tools.lean.file, '--version'], [...prefix, c.tools.lake.file, '--version'],
    [...prefix, c.tools.lake.file, '--no-cache', '--rehash', '--verbose', 'build', ...c.build.libraries],
    [...prefix, c.tools.lake.file, 'env', '/usr/bin/printenv', 'LEAN_PATH'],
  ];
  let cursor = 0;
  const git = (...args) => {
    const r = children[cursor++];
    if (!r || cursor > count - 4 || !same(r.argv, ['/usr/bin/git', ...args]) || r.cwd !== job.source.root) terminationBad('missing or foreign Git export child');
    return bound(r.stdout, false);
  };
  const objectHash = (kind, b) => crypto.createHash('sha1').update(Buffer.from(kind + ' ' + b.length + '\0')).update(b).digest('hex');
  if (git('rev-parse', '--show-toplevel').toString().trim() !== job.source.root) terminationBad('Git root differs');
  const commit = git('cat-file', 'commit', job.source.commit);
  if (objectHash('commit', commit) !== job.source.commit || !commit.toString().startsWith('tree ' + source.tree + '\n')
    || git('rev-parse', job.source.commit + '^{tree}').toString().trim() !== source.tree) terminationBad('Git commit identity differs');
  const trees = new Map();
  const tree = oid => {
    const b = git('cat-file', 'tree', oid), entries = [];
    if (objectHash('tree', b) !== oid) terminationBad('Git tree identity differs');
    for (let at = 0; at < b.length;) {
      const space = b.indexOf(32, at), zero = b.indexOf(0, space + 1);
      if (space < at || zero < space || zero + 21 > b.length) terminationBad('incomplete Git tree entry');
      const mode = b.subarray(at, space).toString(), raw = b.subarray(space + 1, zero), name = raw.toString('utf8');
      if (!['40000', '100644', '100755'].includes(mode) || !name || name.includes('/') || !Buffer.from(name).equals(raw)) terminationBad('unsupported Git tree entry');
      entries.push({ mode: mode.padStart(6, '0'), name, oid: b.subarray(zero + 1, zero + 21).toString('hex') }); at = zero + 21;
    }
    trees.set(oid, entries);
  };
  tree(source.tree);
  const files = [], listing = git('ls-tree', '-rzt', '--full-tree', job.source.commit).toString().split('\0').filter(Boolean);
  for (const entry of listing) {
    const m = /^(040000|100644|100755) (tree|blob) ([a-f0-9]{40})\t(.+)$/.exec(entry);
    if (!m || path.isAbsolute(m[4]) || m[4].split('/').some(p => !p || ['.', '..', '.git', '.lake'].includes(p))) terminationBad('unsupported source export entry');
    if (m[1] === '040000' && m[2] === 'tree') { tree(m[3]); continue; }
    if (m[2] !== 'blob' || m[1] === '040000' || files.includes(m[4])) terminationBad('ambiguous source export');
    const b = git('cat-file', 'blob', m[3]), row = source.files[m[4]];
    if (objectHash('blob', b) !== m[3] || row?.sha256 !== hash(b) || row.size !== b.length) terminationBad('source export inventory differs');
    files.push(m[4]);
  }
  const expectedListing = [];
  const walk = (oid, prefix = '', ancestors = new Set()) => {
    if (!trees.has(oid) || ancestors.has(oid)) terminationBad('missing or cyclic exported subtree');
    for (const e of trees.get(oid)) {
      const directory = e.mode === '040000', name = prefix + e.name;
      expectedListing.push(e.mode + ' ' + (directory ? 'tree' : 'blob') + ' ' + e.oid + '\t' + name);
      if (directory) walk(e.oid, name + '/', new Set([...ancestors, oid]));
    }
  };
  walk(source.tree);
  if (!same(listing, expectedListing)) terminationBad('Git listing omits or changes the bound tree inventory');
  if (!same(files.sort(), Object.keys(source.files).sort()) || cursor !== count - 4) terminationBad('incomplete or additional Git export work');
  if ((!source.files['lakefile.lean'] && !source.files['lakefile.toml']) || (source.files['lakefile.lean'] && source.files['lakefile.toml'])
    || !source.files['lean-toolchain'] || !source.files['lake-manifest.json']) terminationBad('only the assessed configured build profile is supported');
  final.forEach((argv, i) => { const r = children[cursor + i]; if (!same(r.argv, argv) || r.cwd !== project) terminationBad('unknown subprocess after configured final query'); });
  return { count, firstStartedAtMs: children[0].startedAt, lastEndedAtMs: children.at(-1).endedAt, allTerminal: true,
    boundary: 'after final environment query, before synchronous build snapshot publication', pidLineage: 'not retrospectively reconstructed' };
}
function controllerTerminationFacts(c, a, before, after, observation, run, registryRows, storeRows, history, identityDeadlineMs) {
  const snapshot = failedLocalSnapshot(a, before, after, observation, run, registryRows, storeRows), job = bound(c.job), launch = bound(c.launch), outer = bound(c.outer);
  if (a.kind !== 'accept' || a.runId !== c.runId || c.runId !== run.runId || c.beforeEventSha256 !== before.sha256 || c.transitionId !== a.transitionId
    || c.reservationId !== a.reservationId || !same(c.action, before.event.intent.request) || !same(c.job, a.target.request)
    || job.schema !== 'fvs-checker/accept-request' || job.version !== 1 || job.purpose !== 'auto' || job.node !== a.target.node
    || !same(job.source, { kind: 'git', root: snapshot.source.root, commit: snapshot.source.commit, expectedTree: snapshot.source.tree })
    || !same(job.baseline, snapshot.baseline) || !same(job.store, { root: snapshot.store?.root, expectedHeadSha256: snapshot.store?.headSha256 })
    || snapshot.baseline === null || !Number.isSafeInteger(job.deadlineMs) || job.deadlineMs <= before.event.observedAtMs || job.deadlineMs > run.deadlineMs) terminationBad('termination context is not this exact local producer');
  const frozen = bound(snapshot.baseline), original = bound(frozen.input);
  for (const key of ['lean', 'lake']) if (!original.baseline?.[key] || !same(c.tools[key], { file: original.baseline[key].path, sha256: original.baseline[key].sha256 })) terminationBad('producer tool differs from frozen identity');
  for (const [file, digest] of Object.entries(frozen.checker ?? {})) {
    if (file === process.execPath || file === '/usr/bin/git') { terminationExecutableIdentity({ file, sha256: digest }, identityDeadlineMs); continue; }
    const relative = path.relative(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), file);
    if (relative.startsWith('..') || !c.sourceSnapshot.files.some(f => f.path === relative && f.sha256 === digest)) terminationBad('historical source omits a frozen engine identity');
    bound({ file, sha256: digest }, false);
  }
  const inventory = bound(c.build.source), sourceRoot = original.baseline.sourceRoot ?? '.';
  if (path.isAbsolute(sourceRoot) || sourceRoot.split('/').some(p => p === '..')) terminationBad('unsupported source-root profile');
  const overlays = (frozen.overlayFiles ?? []).filter(file => Object.hasOwn(inventory.files ?? {}, file)).map(file => {
    const rel = path.posix.relative(sourceRoot === '.' ? '' : sourceRoot, file);
    if (!rel.endsWith('.lean') || rel.startsWith('../')) terminationBad('overlay module escapes source root');
    return rel.slice(0, -5).replaceAll('/', '.');
  });
  if (!same(c.build.libraries, [...new Set([...(original.baseline.libraries ?? []), ...overlays])])) terminationBad('build libraries differ from frozen/proof inputs');
  const br = bound(c.beforeResult), bq = bound(c.beforeRequest), marker = bound(c.marker), prepared = bound(c.prepared);
  assertKnownControllerPreparation({ context: c, action: a, before, run, beforeRequest: bq, beforeResult: br, prepared, outer, history });
  for (const file of ['command.json', 'run.json', 'after.json', 'continuous-timing.json']) {
    const root = file === 'command.json' ? path.join(c.caseRoot, 'steps', c.step, 'command') : path.join(c.caseRoot, 'steps', c.step);
    if (fs.existsSync(path.join(root, file))) terminationBad('ordinary outcome or later controller progress cannot use termination-only recovery');
  }
  if (br.recordedEventSha256 !== before.sha256 || br.committedHeadSha256 !== before.sha256 || !same(br.request, bq)
    || !same(bq.transition?.intent, before.event.intent) || bq.transition.position !== 'before' || !same(br.observation.transition?.snapshot, a.before)
    || c.marker.file !== path.join(run.canonicalRoot, '.formalising/auto-fv/resume/effects', before.sha256 + '.json')
    || marker.schema !== 'fvs/auto-effect-start' || marker.schemaVersion !== 1 || marker.status !== 'execution-uncertain'
    || marker.beforeEventSha256 !== before.sha256 || marker.committedHeadSha256 !== before.sha256 || !same(marker.action, c.action)
    || marker.evidenceDir !== path.join(c.caseRoot, 'steps', c.step, 'command') || c.producerOut !== path.join(c.caseRoot, 'steps', c.step, 'producer')
    || prepared.schema !== 'fvs/owned-continuous-input-preparation' || prepared.version !== 1 || prepared.runId !== run.runId
    || prepared.status !== 'non-authoritative-inputs-only' || prepared.q?.expectedHeadSha256 !== before.event.prev) terminationBad('before, marker or prepared input identity disagreement');
  if (![outer.startedAtMs, outer.absoluteDeadlineMs, outer.endedAtMs].every(Number.isSafeInteger)
    || !integer(launch.pid) || !same(launch.argv, outer.argv) || launch.startedAtMs !== outer.startedAtMs || launch.deadlineMs !== outer.absoluteDeadlineMs
    || outer.mode !== 'before-run' || outer.step !== c.step || outer.exitCode !== -9 || outer.signal !== 9 || outer.timedOut !== true
    || outer.deadlineSeconds !== 600 || outer.absoluteDeadlineMs !== Math.min(outer.startedAtMs + 600000, run.deadlineMs)
    || !Number.isSafeInteger(outer.endedAtMs) || outer.endedAtMs < outer.absoluteDeadlineMs || outer.endedAtMs > after.event.observedAtMs
    || outer.durationMs !== outer.endedAtMs - outer.startedAtMs || outer.startedAtMs < run.startedAtMs
    || !['sourceUnchanged', 'protectedUnchanged', 'controllersUnchanged', 'immutableInputsUnchanged'].every(k => outer[k] === true)
    || !same(outer.sourceBefore, outer.sourceAfter) || !same(outer.sourceBefore, c.sourceSnapshot)
    || !same(outer.protectedBefore, outer.protectedAfter) || !same(outer.immutableInputsBefore, outer.immutableInputsAfter)
    || !same(outer.controllersBefore, [c.code.controller, c.code.wrapper]) || !same(outer.controllersBefore, outer.controllersAfter)
    || !same(outer.node, c.tools.node) || !same(outer.bd, c.tools.bd) || c.tools.node.file !== process.execPath) terminationBad('outer launch, kill, wait or immutable input evidence is incomplete');
  const expectedEnv = { PATH: path.dirname(c.tools.node.file) + ':/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1',
    HOME: path.join(c.evidenceRoot, 'home'), TMPDIR: path.join(c.evidenceRoot, 'tmp'), XDG_CACHE_HOME: path.join(c.evidenceRoot, 'cache'),
    XDG_CONFIG_HOME: path.join(c.evidenceRoot, 'config'), XDG_DATA_HOME: path.join(c.evidenceRoot, 'data'), FVS_BRIDGE_BD: c.tools.bd.file };
  const argv = ['/usr/bin/env', '-i', ...Object.entries(expectedEnv).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + '=' + v), c.tools.node.file,
    c.code.controller.file, 'before-run', c.caseRoot, c.step, c.evidenceRoot, prepared.closure.file, prepared.closure.sha256, c.prepared.sha256];
  if (!same(outer.env, expectedEnv) || !same(outer.argv, argv) || !same(outer.inhibitor?.argv, ['/usr/bin/caffeinate', '-is', '-w', String(launch.pid)])
    || outer.inhibitor.terminated !== true || outer.inhibitor.exitCode !== 0) terminationBad('unsupported controller invocation or incomplete owned cleanup');
  bound(outer.stdout, false); bound(outer.stderr, false);
  const children = terminationChildren(c, job, before, outer), observed = processInventory(c.observer, c.tools.ps, outer.endedAtMs, after.event.observedAtMs, launch.pid, launch.pid, terminationPaths(c), identityDeadlineMs);
  const canonical = bound(c.canonicalObservations), rawBefore = bound(canonical.runtimeBefore, false);
  reference(canonical.runtimeCurrent);
  if (canonical.schema !== 'fvs/owned-a122-readonly-observations' || canonical.version !== 1 || canonical.runId !== run.runId
    || !canonical.snapshotBefore || !canonical.snapshotAfter || ![canonical.startedAtMs, canonical.endedAtMs].every(Number.isSafeInteger)
    || canonical.currentHead !== before.sha256 || canonical.expectedBeforeEventSha256 !== before.sha256 || !same(canonical.expectedAction, c.action)
    || !same(canonical.snapshotBefore, snapshot) || !same(canonical.snapshotAfter, snapshot) || canonical.runtimeBefore.sha256 !== canonical.runtimeCurrent.sha256
    || canonical.runtimeCurrent.file !== path.join(run.canonicalRoot, '.formalising/auto-fv/resume/state.json')
    || hash(rawBefore) !== br.runtimeFileSha256 || canonical.startedAtMs < outer.endedAtMs || canonical.endedAtMs < canonical.startedAtMs
    || canonical.endedAtMs > after.event.observedAtMs || canonical.originalRunDeadlineMs !== run.deadlineMs) terminationBad('incomplete, mismatched or stale canonical observations');
  return { failureType: 'controller-termination', beforeEventSha256: before.sha256, afterEventSha256: after.sha256, action: c.action,
    runId: run.runId, reservationId: a.reservationId, terminalOutcome: 'controller-terminated', innerProducer: c.innerProducer,
    context: c, controller: { pid: launch.pid, pgid: launch.pid, signal: 9, outerDeadlineMs: outer.absoluteDeadlineMs, endedAtMs: outer.endedAtMs },
    children, quiescence: observed, canonical: tupleOfAction(snapshot), trustScope: terminationTrust,
    authority: 'execution-closure-only; no tuple advance or successor', effectExecutable: false, proofAuthority: 'none' };
}
function terminationPaths(c) { return [c.caseRoot, c.evidenceRoot, c.producerOut, ...['controller', 'wrapper', 'driver'].map(key => c.code[key].file)]; }
function terminationRequest(raw) {
  const q = data(raw);
  closed(q, ['schema', 'schemaVersion', 'attemptId', 'runId', 'expectedBeforeEventSha256', 'expectedAction', 'expectedContext', 'terminationEvidence', 'afterRequest', 'afterResult', 'committedHeadSha256', 'deadlineMs'], 'controller termination request');
  if (q.schema !== 'fvs/auto-respec-controller-termination-request' || q.schemaVersion !== 1 || ![q.attemptId, q.runId].every(uuid)
    || ![q.expectedBeforeEventSha256, q.committedHeadSha256].every(sha)) fail('respec-invalid-input', 'caller-owned versioned termination request required');
  for (const r of [q.expectedAction, q.terminationEvidence, q.afterRequest, q.afterResult]) reference(r);
  deadline(q.deadlineMs); q.expectedContext = terminationContext(q.expectedContext, q.deadlineMs);
  if (!same(bound(q.terminationEvidence), q.expectedContext) || q.expectedContext.runId !== q.runId
    || q.expectedContext.beforeEventSha256 !== q.expectedBeforeEventSha256 || !same(q.expectedContext.action, q.expectedAction)
    || path.basename(q.afterResult.file) !== 'result.json') terminationBad('returned evidence cannot select this caller expected context');
  deadline(q.deadlineMs); return q;
}
function terminationInputs(projectRoot, q) {
  const runtime = readRuntime(projectRoot), run = runtime.state?.run, rq = bound(q.afterRequest), result = bound(q.afterResult), a = readTransitionAction(q.expectedAction);
  if (!run || run.runId !== q.runId || runtime.headSha256 !== q.committedHeadSha256 || result.committedHeadSha256 !== q.committedHeadSha256
    || runtime.fileSha256 !== result.runtimeFileSha256 || !same(result.request, rq) || result.requestSha256 !== memoryHash(rq)
    || rq.runId !== q.runId || rq.transition?.position !== 'after' || rq.transition.outcome !== 'failed'
    || rq.transition.beforeEventSha256 !== q.expectedBeforeEventSha256 || !same(rq.transition.intent.request, q.expectedAction)
    || !same(rq.transition.effect.evidence, [q.terminationEvidence])) terminationBad('not this exact actual failed-after/current head and context');
  const after = runtime.state.history.find(r => r.sha256 === result.recordedEventSha256), before = runtime.state.history.find(r => r.sha256 === q.expectedBeforeEventSha256);
  if (!before || !after || after.sha256 !== runtime.headSha256 || runtime.reservations.get(a.reservationId)?.state !== 'closed'
    || runtime.reservations.get(a.reservationId)?.after !== after.sha256) terminationBad('actual paired failed-after must close only this exact reservation');
  const registry = a.before.registry === null ? null : readChain(a.before.registry.root), store = a.before.store === null ? null : readAcceptedStore(a.before.store.root);
  if (registry?.pending || store?.pending || (registry?.records.at(-1)?.sha ?? null) !== (a.before.registry?.headSha256 ?? null)
    || (store?.headSha256 ?? null) !== (a.before.store?.headSha256 ?? null)) terminationBad('canonical producer prefix/head changed or is pending');
  const facts = controllerTerminationFacts(q.expectedContext, a, before, after, readRuntimeObservation(after.event), run, registry?.records ?? [], store?.records ?? [], runtime.state.history, Math.min(q.deadlineMs, run.deadlineMs));
  return { runtime, run, rq, result, a, facts };
}
function terminationOutput(out, projectRoot, c, a) {
  canonicalPath(out);
  if (fs.existsSync(out) || fs.realpathSync(path.dirname(out)) !== path.dirname(out)) fail('respec-output-invalid', 'exclusive controller termination output required');
  const roots = [projectRoot, c.caseRoot, c.evidenceRoot, c.producerOut, c.build.root, a.before.fixed.canonicalRoot, a.before.fixed.gitCommonDir, a.before.source.root,
    a.before.registry?.root, a.before.store?.root, a.before.baseline && path.dirname(a.before.baseline.file),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')].filter(Boolean);
  if (roots.some(root => inside(root, out) || inside(out, root))) fail('respec-output-protected', 'termination output overlaps canonical or evidence inputs');
}
// Distinct from an ordinary producer exit. These functions never append an after.
export function verifyControllerTermination(options) {
  options = data(options); closed(options, ['projectRoot', 'request', 'out'], 'controller termination verifier');
  const { projectRoot, out } = options, q = terminationRequest(options.request), x = terminationInputs(projectRoot, q), began = failureClock(q, x.run, x.runtime.lastObservedAtMs);
  terminationOutput(out, projectRoot, q.expectedContext, x.a); fs.mkdirSync(out, { mode: 0o700 }); const input = save(out, 'request.json', q), product = implementation();
  try {
    const capture = label => {
      const value = captureControllerProcessObservation({ action: q.expectedAction, tool: q.expectedContext.tools.ps, out: path.join(out, label), deadlineMs: q.deadlineMs });
      return processInventory(value.evidence, q.expectedContext.tools.ps, began, Date.now(), x.facts.controller.pid, x.facts.controller.pgid, terminationPaths(q.expectedContext), Math.min(q.deadlineMs, x.run.deadlineMs));
    };
    const beforeProcess = capture('process-before'), consumed = verifyTransition({ projectRoot, request: x.rq, out: path.dirname(q.afterResult.file) });
    if (consumed.position !== 'after' || consumed.committedHeadSha256 !== q.committedHeadSha256) terminationBad('independent16 consumer did not confirm this actual after');
    const afterProcess = capture('process-after'), finalConsumer = verifyTransition({ projectRoot, request: x.rq, out: path.dirname(q.afterResult.file) });
    if (finalConsumer.position !== 'after' || finalConsumer.committedHeadSha256 !== q.committedHeadSha256) terminationBad('final full canonical consumer fence failed');
    const final = terminationInputs(projectRoot, q);
    // These historical lifecycle identities are separate from15 proof currentness.
    for (const ref of Object.values(q.expectedContext.code)) bound(ref, false);
    for (const ref of Object.values(q.expectedContext.tools)) terminationExecutableIdentity(ref, Math.min(q.deadlineMs, x.run.deadlineMs));
    const endedAtMs = failureClock(q, x.run, began);
    if (final.runtime.fileSha256 !== x.runtime.fileSha256 || !same(final.facts, x.facts) || !same(product, implementation())) terminationBad('head, bytes, context or implementation changed during consumption');
    const value = { schema: 'fvs/auto-respec-controller-termination', schemaVersion: 1, request: q, requestSha256: memoryHash(q), requestInput: input,
      implementation: product, status: 'conclusive-known-lifecycle-termination', ...x.facts, committedHeadSha256: q.committedHeadSha256,
      runtimeFileSha256: final.runtime.fileSha256, beganAtMs: began, endedAtMs, currentProcesses: [beforeProcess, afterProcess], verificationEvidence: [consumed.verificationEvidence, finalConsumer.verificationEvidence] };
    const evidence = save(out, 'result.json', value); failureClock(q, x.run, endedAtMs); return { ...value, evidence };
  } catch (e) { save(out, 'failure.json', diagnostic(e)); throw e; }
}
export function consumeControllerTermination(options) {
  options = data(options); closed(options, ['projectRoot', 'request', 'out'], 'controller termination consumer');
  const q = terminationRequest(options.request), result = bound({ file: path.join(options.out, 'result.json'), sha256: hash(bytes(path.join(options.out, 'result.json'))) });
  if (fs.existsSync(path.join(options.out, 'failure.json')) || result.schema !== 'fvs/auto-respec-controller-termination' || result.schemaVersion !== 1
    || !same(result.request, q) || result.requestSha256 !== memoryHash(q) || !same(bound(result.requestInput), q)
    || !same(result.implementation, implementation()) || result.status !== 'conclusive-known-lifecycle-termination' || result.proofAuthority !== 'none' || result.effectExecutable !== false
    || !same(result.innerProducer, q.expectedContext.innerProducer) || result.authority !== 'execution-closure-only; no tuple advance or successor'
    || !Number.isSafeInteger(result.beganAtMs) || !Number.isSafeInteger(result.endedAtMs) || result.endedAtMs < result.beganAtMs
    || result.endedAtMs >= q.deadlineMs || result.endedAtMs > Date.now()) terminationBad('not this caller/current implementation successfully published termination evidence');
  if (!Array.isArray(result.currentProcesses) || result.currentProcesses.length !== 2) terminationBad('both fresh process fences required');
  for (const p of result.currentProcesses) processInventory(p.evidence, q.expectedContext.tools.ps, result.beganAtMs, result.endedAtMs, result.controller.pid, result.controller.pgid, terminationPaths(q.expectedContext), q.deadlineMs);
  const out = path.join(fs.realpathSync(os.tmpdir()), 'fvs-controller-termination-consume-' + crypto.randomUUID());
  const fresh = verifyControllerTermination({ projectRoot: options.projectRoot, request: q, out });
  const stable = v => { const { beganAtMs, endedAtMs, currentProcesses, verificationEvidence, requestInput, evidence, ...rest } = v; return rest; };
  if (!same(stable(result), stable(fresh))) terminationBad('saved termination evidence differs from fresh independent observation');
  return { ...fresh, effectExecutable: false };
}
function failureClock(q, run, floor) {
  const now = Date.now();
  if (now < floor) fail('respec-clock-rollback', 'failure consumer clock moved backwards');
  if (now >= q.deadlineMs || now >= run.deadlineMs) fail('respec-deadline-exhausted', 'failure inspection/original deadline exhausted');
  return now;
}
function failureInputs(projectRoot, q) {
  const runtime = readRuntime(projectRoot), run = runtime.state?.run, rq = bound(q.afterRequest), result = bound(q.afterResult), a = readTransitionAction(q.expectedAction);
  if (!run || run.runId !== q.runId || runtime.headSha256 !== q.committedHeadSha256 || result.committedHeadSha256 !== q.committedHeadSha256
    || runtime.fileSha256 !== result.runtimeFileSha256 || !same(result.request, rq) || result.requestSha256 !== memoryHash(rq)
    || rq.runId !== q.runId || rq.transition?.position !== 'after' || rq.transition.outcome !== 'failed'
    || rq.transition.beforeEventSha256 !== q.expectedBeforeEventSha256 || !same(rq.transition.intent.request, q.expectedAction)
    || !rq.transition.effect.evidence.some(r => same(r, q.expectedCommand))) fail('respec-failure-unverified', 'not the current exact failed-after request/result');
  const after = runtime.state.history.find(r => r.sha256 === result.recordedEventSha256), before = runtime.state.history.find(r => r.sha256 === q.expectedBeforeEventSha256);
  if (!after || after.sha256 !== runtime.headSha256 || !before || !same(after.event.intent.request, q.expectedAction)
    || runtime.reservations.get(a.reservationId)?.state !== 'closed' || runtime.reservations.get(a.reservationId)?.after !== after.sha256) fail('respec-failure-unverified', 'exact failed after must conclusively close this local reservation');
  const registry = a.before.registry === null ? null : readChain(a.before.registry.root), store = a.before.store === null ? null : readAcceptedStore(a.before.store.root);
  if (registry?.pending || (registry?.records.at(-1)?.sha ?? null) !== (a.before.registry?.headSha256 ?? null)
    || (store?.headSha256 ?? null) !== (a.before.store?.headSha256 ?? null)) fail('respec-failure-unverified', 'canonical heads/pending state changed since the failed effect');
  const observation = readRuntimeObservation(after.event), facts = conclusiveLocalFailure(a, before, after, observation, run, registry?.records ?? [], store?.records ?? [], Math.min(q.deadlineMs, run.deadlineMs));
  if (!same(facts.command, q.expectedCommand)) fail('respec-failure-unverified', 'another terminal command is not this caller expected failure');
  return { runtime, run, rq, result, a, facts };
}
function failureOutput(out, projectRoot, x) {
  if (!text(out) || !path.isAbsolute(out) || path.normalize(out) !== out || fs.existsSync(out) || fs.realpathSync(path.dirname(out)) !== path.dirname(out)) fail('respec-output-invalid', 'exclusive canonical failure output required');
  const cmd = bound(x.facts.command), roots = [projectRoot, x.a.before.source.root, x.a.before.registry?.root, x.a.before.store?.root,
    cmd.argv[6], path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')];
  if (x.a.before.baseline) {
    const frozen = bound(x.a.before.baseline), job = bound(frozen.input);
    roots.push(path.dirname(x.a.before.baseline.file), frozen.build?.projectRoot, frozen.build?.buildRoot, job.baseline?.source?.root, job.baseline?.dependencies?.root);
  }
  for (const binding of readState({ projectRoot, requireAgreement: true }).state.memoryBindings ?? []) roots.push(binding.storeDir, binding.databasePath);
  if (roots.filter(Boolean).some(root => inside(root, out) || inside(out, root))) fail('respec-output-protected', 'failure output overlaps canonical/producer/input state');
}
// This consumes a truthful16 failed-after; it never records or grants an effect.
export function verifyConclusiveLocalFailure(options) {
  options = data(options); closed(options, ['projectRoot', 'request', 'out'], 'failure verifier');
  const { projectRoot, out } = options, q = failureRequest(options.request), x = failureInputs(projectRoot, q), began = failureClock(q, x.run, x.runtime.lastObservedAtMs);
  failureOutput(out, projectRoot, x); fs.mkdirSync(out, { mode: 0o700 }); const input = save(out, 'request.json', q), product = implementation();
  try {
    const consumed = verifyTransition({ projectRoot, request: x.rq, out: path.dirname(q.afterResult.file) });
    if (consumed.position !== 'after' || consumed.committedHeadSha256 !== q.committedHeadSha256) fail('respec-failure-unverified', 'independent16 consumer did not confirm this failed after');
    const final = failureInputs(projectRoot, q), endedAtMs = failureClock(q, x.run, began);
    if (final.runtime.fileSha256 !== x.runtime.fileSha256 || !same(final.facts, x.facts) || !same(product, implementation())) fail('respec-failure-unverified', 'failure context/implementation changed during consumption');
    const value = { schema: 'fvs/auto-respec-local-failure', schemaVersion: 1, request: q, requestSha256: memoryHash(q), requestInput: input,
      implementation: product, status: 'conclusive-no-canonical-effect', ...x.facts, committedHeadSha256: q.committedHeadSha256,
      runtimeFileSha256: final.runtime.fileSha256, beganAtMs: began, endedAtMs, verificationEvidence: consumed.verificationEvidence };
    const evidence = save(out, 'result.json', value); failureClock(q, x.run, endedAtMs);
    return { ...value, evidence };
  } catch (e) { save(out, 'failure.json', diagnostic(e)); throw e; }
}
export function consumeConclusiveLocalFailure(options) {
  options = data(options); closed(options, ['projectRoot', 'request', 'out'], 'failure evidence consumer');
  const q = failureRequest(options.request), result = bound({ file: path.join(options.out, 'result.json'), sha256: hash(bytes(path.join(options.out, 'result.json'))) });
  if (fs.existsSync(path.join(options.out, 'failure.json')) || result.schema !== 'fvs/auto-respec-local-failure' || result.schemaVersion !== 1
    || result.requestSha256 !== memoryHash(q) || !same(result.request, q) || !same(bound(result.requestInput), q)
    || !same(result.implementation, implementation()) || result.status !== 'conclusive-no-canonical-effect' || result.effectExecutable !== false
    || result.proofAuthority !== 'none' || result.authority !== 'execution-closure-only; no tuple advance or successor'
    || !Number.isSafeInteger(result.beganAtMs) || !Number.isSafeInteger(result.endedAtMs) || result.endedAtMs < result.beganAtMs
    || result.endedAtMs >= q.deadlineMs || result.endedAtMs > Date.now()) fail('respec-failure-unverified', 'not this caller/current implementation failure evidence');
  const output = path.join(fs.realpathSync(os.tmpdir()), 'fvs-respec-failure-consume-' + crypto.randomUUID());
  const fresh = verifyConclusiveLocalFailure({ projectRoot: options.projectRoot, request: q, out: output });
  const stable = v => { const { beganAtMs, endedAtMs, verificationEvidence, requestInput, evidence, ...rest } = v; return rest; };
  if (!same(stable(result), stable(fresh))) fail('respec-failure-unverified', 'saved failure evidence differs from fresh independent validation');
  return { ...fresh, effectExecutable: false };
}
function trace(q, x, initial, out) {
  const original = bound(initial.request), result = bound(initial.result);
  const inspectPublication = publicationOf(path.dirname(initial.result.file), original, initial.result, result);
  if (original.schemaVersion!==q.schemaVersion || result.schemaVersion!==q.schemaVersion || original.operation !== 'inspect' || result.schema !== 'fvs/auto-respec-result' || result.operation !== 'inspect' || result.requestSha256 !== memoryHash(original) || !same(result.request, original) || !inspectImplementation(result.implementation)) fail('respec-inspect-mismatch', 'not the exact original inspect request/result/implementation');
  const originalFrame = frameOf(original, x.prior, x.runtime.state.run);
  if (!same(originalFrame, result.frame) || !same(originalFrame, x.frame)) fail('respec-frame-mismatch', 'original feedback/scope/run/accounting frame changed');
  const head = original.current.resume.committedHeadSha256, index = x.runtime.state.history.findIndex(row => row.sha256 === head);
  if (index < 0) fail('respec-history-mismatch', 'initial committed runtime prefix is missing');
  checkVersions(original.requestedItems, nodeHeads(chainPrefix(x.chain.records, original.current.bundle.registry.expectedHeadSha256, 'sha')));
  let current = tupleOfBundle(original.current.bundle); const effects = [], failures = [], promotions = [], gitEvidence = [];
  const toolRef = name => { const file = fileURLToPath(new URL(name, import.meta.url)); return { file, sha256: hash(bytes(file)) }; };
  const validators = transitionValidators({ tools: { auto: toolRef('fvs-auto.mjs'), registry: toolRef('fvs-contract-registry.mjs') }, git(root, args, buffer = false) {
    if (root !== x.b.source.root || !['rev-parse', 'show', 'rev-list', 'diff-tree'].includes(args[0])) fail('respec-history-mismatch', 'unexpected historical Git read');
    const gitTool=q.schemaVersion===2?fs.realpathSync(which('git')??''): '/usr/bin/git';
    const argv = [gitTool, '-C', root, ...args], toolSha256 = executableIdentity(gitTool, controlOf(q)).sha256;
    const env = { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
    const startedAtMs = Date.now(), p = spawnSync(argv[0], argv.slice(1), { cwd: root, env, ...(q.schemaVersion===2?timeoutOptions(q.execution,{administrativeMs:10000}):{timeout:Math.max(1,Math.min(10000,q.deadlineMs-startedAtMs))}), maxBuffer: 16 * 1024 * 1024 });
    const stream = (suffix, b) => { const file = path.join(out, 'trace-git-' + gitEvidence.length + '.' + suffix); fs.writeFileSync(file, b, { flag: 'wx' }); return { file, sha256: hash(b) }; };
    const receipt = save(out, 'trace-git-' + gitEvidence.length + '.json', { argv, cwd: root, env, requestSha256: memoryHash(q), startedAtMs, endedAtMs: Date.now(), toolSha256, exitCode: p.status,
      signal: p.signal, error: p.error?.code ?? null, stdout: stream('stdout', p.stdout ?? Buffer.alloc(0)), stderr: stream('stderr', p.stderr ?? Buffer.alloc(0)) });
    gitEvidence.push(receipt);
    if (p.error || p.signal || p.status !== 0) fail('respec-history-mismatch', 'bounded historical Git read failed');
    terminationExecutableIdentity({ file: gitTool, sha256: toolSha256 }, controlOf(q));
    return buffer ? p.stdout : p.stdout.toString('utf8');
  } });
  validators.verifyCandidateAssignment = (ref, stage) => readRuntimeAssignment(ref, x.runtime, x.runtime.state.run, stage);
  for (const row of x.runtime.state.history.slice(index + 1)) {
    const event = row.event; if (!event.intent.request || event.position !== 'after') continue;
    const observation = readRuntimeObservation(event), a = readTransitionAction(event.intent.request), snapshot = observation.transition?.snapshot;
    if (event.outcome === 'failed') {
      const before = x.runtime.state.history.find(r => r.sha256 === event.beforeEventSha256);
      if (!same(tupleOfAction(a.before), current) || !same(a.authorization, x.frame.authorization) || !same(a.profile, x.frame.profile)
        || !same(a.before.fixed.extraction, x.frame.stages.extraction) || !same(a.before.fixed.graph, x.frame.stages.graph)
        || !same(a.before.fixed.plan, x.frame.stages.plan)) fail('respec-history-mismatch', 'failed action lost the original trace frame');
      const termination = event.effect.evidence.filter(ref => {
        try { return bound(ref).schema === 'fvs/auto-controller-termination-context'; }
        catch (error) { if (error.code !== 'transition-invalid-input') throw error; return false; }
      });
      if (termination.length) {
        if (termination.length !== 1 || event.effect.evidence.length !== 1) terminationBad('mixed or ambiguous controller termination evidence');
        const context = terminationContext(bound(termination[0]), q.deadlineMs);
        failures.push(controllerTerminationFacts(context, a, before, row, observation, x.runtime.state.run, x.chain.records, x.store?.records ?? [], x.runtime.state.history, q.deadlineMs));
      } else failures.push(conclusiveLocalFailure(a, before, row, observation, x.runtime.state.run, x.chain.records, x.store?.records ?? [], q.deadlineMs));
      continue; // A failure grants no progress; a fresh before must justify any retry.
    }
    if (event.outcome !== 'succeeded' || observation.transition?.admissibility.status !== 'facts-recorded-partial' || !snapshot) fail('respec-history-mismatch', 'effect completion remains uncertain/unverified');
    const before = x.runtime.state.history.find(r => r.sha256 === event.beforeEventSha256);
    const completion = observation.transition.admissibility.completion;
    if (!before || !completion || !event.effect.evidence.some(r => same(r, completion))) fail('respec-history-mismatch', 'paired actual completion required');
    const evidence = readTransitionCompletion(a, completion, before, x.runtime.state.history.filter(r => r !== row));
    const fixed = a.before.fixed, run = x.runtime.state.run;
    if (a.runId !== run.runId || a.transitionId !== event.intent.transitionId || a.reservationId !== event.intent.reservationId || a.owner !== event.intent.owner || !same(a.nodes, event.intent.nodes)
      || a.expectedHeadSha256 !== before.event.prev || !same(a.authorization, x.frame.authorization) || !same(a.profile, x.frame.profile) || !same(fixed, snapshot.fixed)
      || fixed.runId !== run.runId || fixed.canonicalRoot !== run.canonicalRoot || fixed.gitCommonDir !== run.gitCommonDir || fixed.startedAtMs !== run.startedAtMs || (q.schemaVersion===2?!same(runControl(fixed),runControl(run)):fixed.deadlineMs !== run.deadlineMs)
      || fixed.choicesGeneration !== run.choicesGeneration || fixed.agreementContextSha256 !== run.agreementContextSha256 || fixed.scopeSha256 !== memoryHash(run.scope) || fixed.limitsSha256 !== memoryHash(run.limits)) fail('respec-history-mismatch', 'historical action lost the original grant/run/head/accounting');
    const prior = tupleOfAction(a.before), after = tupleOfAction(snapshot);
    if (!same(prior, current)) fail('respec-history-mismatch', 'unexplained source/registry/frozen/store advance');
    const allowed = ({ 'compose-spec': ['source'], 'materialize-proof': ['source'], 'registry-revise': ['registry'], freeze: ['baseline'], accept: ['store'] })[a.kind] ?? [];
    if (Object.keys(current).some(k => !allowed.includes(k) && !same(current[k], after[k]))) fail('respec-history-mismatch', 'row changed an unpermitted identity');
    if (!same(a.before.fixed.extraction, x.frame.stages.extraction) || !same(a.before.fixed.graph, x.frame.stages.graph) || !same(a.before.fixed.plan, x.frame.stages.plan)) fail('respec-history-mismatch', 'stage scope changed during revision');
    chainPrefix(x.chain.records, after.registry?.headSha256 ?? null, 'sha');
    if (after.registry?.root !== x.frame.registryRoot || (after.store?.root ?? null) !== x.frame.storeRoot) fail('respec-history-mismatch', 'canonical store location changed');
    const accepted = x.store ? chainPrefix(x.store.records, prior.store?.headSha256 ?? null, 'sha256') : [];
    if (['compose-spec', 'materialize-proof'].includes(a.kind)) validators.verifyMaterialization(a, a.before, snapshot, evidence);
    if (a.kind === 'freeze') { validators.verifyBaseline(a, snapshot, evidence); promotions.push(...promotionGuard(prior, after, accepted, x.chain.records)); }
    if (a.kind === 'registry-revise') {
      const committed = x.chain.records.find(r => r.sha === after.registry.headSha256);
      if (!committed || committed.record.prev !== prior.registry.headSha256 || evidence.result.recordSha256 !== committed.sha || !same(evidence.result.record, committed.record)
        || committed.record.candidateSha256 !== a.target.candidateSha256 || !same(committed.record.review, bound(a.target.review))) fail('respec-history-mismatch', 'registry completion is not the actual committed reviewed event');
    }
    if (a.kind === 'accept') {
      const committed = x.store?.records.find(r => r.sha256 === after.store.headSha256);
      if (!committed || committed.record.prev !== prior.store.headSha256 || committed.record.node !== a.target.node || evidence.result.acceptedReceipt?.sha256 !== committed.sha256
        || committed.record.frozenSha256 !== prior.baseline?.sha256 || committed.record.integrated.commit !== prior.source.commit || committed.record.integrated.tree !== prior.source.tree) fail('respec-history-mismatch', 'accept completion is not the actual current-context event');
    }
    current = after; effects.push({ beforeEventSha256: before.sha256, afterEventSha256: row.sha256, kind: a.kind, completion });
  }
  if (!same(current, tupleOfBundle(x.b))) fail('respec-history-mismatch', 'current context has no complete paired revision path');
  return { effects, failures, promotions, gitEvidence, inspectPublication };
}
function implementation() {
  return Object.fromEntries([['respec', 'fvs-auto-respec.mjs'], ['bundle', 'fvs-auto-bundle.mjs']].map(([key, name]) => {
    const file = fileURLToPath(new URL(name, import.meta.url)); return [key, { file, sha256: hash(bytes(file)) }];
  }));
}
function memoryEvidence(q, x) {
  if(disabledMemory(q))return{status:'disabled',request:null,policy:x.runtime.state.run.memory};
  const root = path.dirname(q.current.memory.result.file), r = x.mr;
  const absolute = ref => { const file = path.resolve(root, ref.file); if (!inside(root, file)) fail('respec-evidence-invalid', 'bootstrap evidence escaped its original output'); const boundRef = { file, sha256: ref.sha256 }; bound(boundRef, false); return boundRef; };
  const receipts = [];
  for (const ref of r.receipts) { const receipt = absolute(ref), body = bound(receipt); receipts.push({ receipt, stdout: absolute(body.stdout), stderr: absolute(body.stderr) }); }
  const binding = x.view.state.memoryBindings.at(-1);
  return { request: q.current.memory.request, result: q.current.memory.result, prime: absolute(r.prime), receipts, bd: { file: binding.bdPath, sha256: binding.bdSha256 } };
}
function receiptFacts(refs, request) {
  if (!Array.isArray(refs) || !refs.length) fail('respec-evidence-invalid', 'current consumer receipts missing');
  return refs.map(ref => {
    const r = bound(ref);
    if (r.requestSha256 !== memoryHash(request) || r.attemptId !== request.attemptId || r.exitCode !== 0 || r.signal || r.error || r.toolBefore !== r.toolAfter) fail('respec-evidence-invalid', 'consumer receipt is not this current request');
    bound(r.stdout, false); bound(r.stderr, false);
    //16 compares normalized live observations; raw AO metadata may be volatile.
    return { argv: r.argv, cwd: r.cwd, requestSha256: r.requestSha256, attemptId: r.attemptId, toolBefore: r.toolBefore, toolAfter: r.toolAfter };
  });
}
function responseFor(q, item, heads) {
  if (item.expectedRecords.some(r => Object.hasOwn(r, 'unestablished'))) {
    if (item.response !== null) bound(item.response);
    return { itemId: item.itemId, status: 'pending', reason: 'requested-version-unestablished', nodes: item.nodes, versions: item.expectedRecords, response: item.response };
  }
  if (item.response === null) return { itemId: item.itemId, status: 'pending', reason: 'feedback-response-not-recorded', contracts: [] };
  const r = bound(item.response);
  closed(r, ['schema', 'schemaVersion', 'revisionId', 'itemId', 'ownerFeedbackSha256', 'priorCandidates', 'contracts', 'correspondenceEvidence'], 'feedback response');
  if (r.schema !== 'fvs/auto-respec-response' || r.schemaVersion !== 1 || r.revisionId !== q.revisionId || r.itemId !== item.itemId || r.ownerFeedbackSha256 !== q.ownerFeedback.evidence.sha256 || !same(r.priorCandidates, item.expectedRecords)
    || !Array.isArray(r.correspondenceEvidence) || !r.correspondenceEvidence.length) fail('respec-response-mismatch', 'response lost actual feedback/initial candidates');
  r.correspondenceEvidence.forEach(e => bound(e, false)); versions(r.contracts, item.nodes);
  for (const v of r.contracts) {
    const row = heads.get(v.node);
    if (!row || row.sha !== v.recordSha256 || row.record.candidateSha256 !== v.candidateSha256) fail('respec-response-mismatch', 'response is not the current registered contract');
  }
  return { itemId: item.itemId, status: 'response-prepared', response: item.response, contracts: r.contracts, correspondenceAuthority: 'declared workflow mapping; mandatory semantic feedback review, no language classifier or human approval' };
}
function fence(q, x) {
  const runtime = readRuntime(x.b.projectRoot), view = readState({ projectRoot: x.b.projectRoot, requireAgreement: true }), chain = readChain(x.b.registry.root), store = x.b.acceptedStore === null ? null : readAcceptedStore(x.b.acceptedStore.root);
  if (runtime.headSha256 !== x.runtime.headSha256 || runtime.fileSha256 !== x.runtime.fileSha256 || !same(canonicalAgreement(view), x.frame.agreement) || chain.pending || (chain.records.at(-1)?.sha ?? null) !== x.b.registry.expectedHeadSha256
    || (store?.headSha256 ?? null) !== (x.b.acceptedStore?.expectedHeadSha256 ?? null)) fail('respec-context-stale', 'currentness fence changed');
  for (const r of [x.b.agreement.state, x.b.agreement.roadmap, x.b.extraction, x.b.graph, x.b.plan, x.b.scopeInventory, q.ownerFeedback.evidence]) bound(r, false);
}
function observe(q, x, out) {
  const began = Date.now(), reasons = [...x.validation.problems], run = x.runtime.state.run;
  const expired = runExpired(run,began);
  if (!unbudgetedRun(run) && began < x.runtime.lastObservedAtMs) fail('respec-clock-rollback', 'clock precedes current accounting');
  let consumed = null, actualMemory = null, currentness = { status: 'unverified', reason: 'current-proof-not-established', nodes: [] };
  if (expired) reasons.push('original-limit-exhausted');
  else {
    if(!disabledMemory(q))verifyMemoryBootstrap({ projectRoot: x.b.projectRoot, callerRoot: x.b.projectRoot, request: x.mq, out: path.dirname(q.current.memory.result.file) });
    actualMemory = memoryEvidence(q, x);
    consumed = (x.rq.transition === null ? verifyReconciliation : verifyTransition)({ projectRoot: x.b.projectRoot, request: x.rq, out: path.dirname(q.current.resume.result.file) });
    if (consumed.committedHeadSha256 !== x.runtime.headSha256) fail('respec-context-stale', 'consumer observed another runtime head');
    if (x.b.baseline && x.b.acceptedStore && !x.validation.problems.length) {
      try { currentness = inspectAutoAcceptance({ baseline: x.b.baseline, store: x.b.acceptedStore, source: x.b.source, ...(q.schemaVersion===2?runExecutionFields(run):{deadlineMs:Math.min(q.deadlineMs,run.deadlineMs)}), out: path.join(out, 'current-proof') }); }
      catch (e) { currentness = { status: 'unverified', diagnostic: diagnostic(e), nodes: [] }; }
    }
  }
  if (q.operation === 'inspect') checkVersions(q.requestedItems, x.chain.heads);
  const history = q.operation === 'finish' ? trace(q, x, q.inspectEvidence, out) : { effects: [], promotions: [], gitEvidence: [] };
  const registered = registryStatus({ plan: x.b.plan.file, graph: x.b.graph.file, registry: x.b.registry.root, 'spec-root': x.b.source.root });
  const selection = x.prior.body.facts, originalNodes = selection.nodes.map(n => n.node), requested = q.requestedItems.flatMap(i => i.nodes), known = [...new Set([...originalNodes, ...requested])].sort((a, b) => a - b);
  for (const node of requested) if (!originalNodes.includes(node) || !x.validation.union?.has(node)) reasons.push('requested-node-unsupported:' + node);
  for (const item of q.requestedItems) for (const r of item.expectedRecords) if (Object.hasOwn(r, 'unestablished')) reasons.push('requested-version-unestablished:' + r.node);
  const items = q.requestedItems.map(item => responseFor(q, item, x.chain.heads));
  const nodes = known.map(node => ({ node, role: selection.nodes.find(n => n.node === node)?.role ?? 'requested-unmapped', registryState: registered.nodes?.[node]?.state ?? 'unknown',
    proof: currentness.status === 'current' && currentness.nodes?.some(r => r.node === node) ? 'current' : 'unverified', currentReceipt: currentness.status === 'current' ? currentness.nodes.find(r => r.node === node)?.receipt ?? null : null }));
  if (selection.failed.length || selection.applicability.some(a => a.disposition !== 'mapped')) reasons.push('original-scope-has-unfinished-applicability');
  if (currentness.status !== 'current') reasons.push('whole-scope-currentness-unverified');
  if (x.validation.union && [...x.validation.union].some(id => !nodes.some(n => n.node === id && n.proof === 'current'))) reasons.push('selected-proof-node-missing');
  if (items.some(i => i.status === 'pending')) reasons.push('feedback-response-pending');
  fence(q, x);
  if (!expired) {
    if(!disabledMemory(q))verifyMemoryBootstrap({ projectRoot: x.b.projectRoot, callerRoot: x.b.projectRoot, request: x.mq, out: path.dirname(q.current.memory.result.file) });
    (x.rq.transition === null ? verifyReconciliation : verifyTransition)({ projectRoot: x.b.projectRoot, request: x.rq, out: path.dirname(q.current.resume.result.file) });
  }
  fence(q, x);
  const ended = clock(q, x, began);
  if (runExpired(run,ended)) reasons.push('original-limit-exhausted');
  return { source: x.b.source, committedRuntimeHeadSha256: x.runtime.headSha256, runtimeFileSha256: x.runtime.fileSha256, originalRun: run,
    stageValidation: x.validation.problems, currentness, nodes, items, history, reasons: [...new Set(reasons)], beganAtMs: began, endedAtMs: ended,
    memoryEvidence: actualMemory, currentConsumer: consumed === null ? null : { code: consumed.code, evidence: consumed.verificationEvidence, receipts: consumed.observation.receipts }, semanticCheckRequired: 'Workflow must compare actual owner feedback with proposed contracts/applicability; no Boolean authentication or proof/dispatch authority.' };
}

function statusOf(q, observation) {
  if (q.operation === 'finish') return observation.reasons.length ? 'partial' : 'ready-for-final-human-review';
  const expected = ['whole-scope-currentness-unverified', 'selected-proof-node-missing', 'feedback-response-pending'];
  return observation.reasons.some(r => !expected.includes(r)) ? 'partial' : 'revision-proposed';
}
function clock(q, x, floor) {
  const at = Date.now();
  if (!unbudgetedRun(x.runtime.state.run) && (at < floor || at < x.runtime.lastObservedAtMs)) fail('respec-clock-rollback', 'clock moved backwards during final reads/publication');
  checkControl(controlOf(q));
  return at;
}
function stamp(q, x, observation) {
  observation.endedAtMs = clock(q, x, observation.endedAtMs);
  if (runExpired(x.runtime.state.run,observation.endedAtMs) && !observation.reasons.includes('original-limit-exhausted')) observation.reasons.push('original-limit-exhausted');
}
function publish(q, x, out, name, value) {
  stamp(q, x, value.observation); value.status = statusOf(q, value.observation);
  const evidence = save(out, name, value), at = clock(q, x, value.observation.endedAtMs);
  if (runExpired(x.runtime.state.run,at) && !value.observation.reasons.includes('original-limit-exhausted')) fail('respec-publication-stale', 'original limit expired while output was being published; staged artifact is unverified');
  const publication = save(out, name.replace(/\.json$/, '-clock.json'), { schema: 'fvs/auto-respec-publication', schemaVersion: q.schemaVersion, requestSha256: memoryHash(q), result: evidence, status: value.status, publishedAtMs: at });
  const last = clock(q, x, at);
  if (runExpired(x.runtime.state.run,last) && !value.observation.reasons.includes('original-limit-exhausted')) fail('respec-publication-stale', 'original limit expired at the final publication fence');
  return { evidence, publication };
}
function publicationOf(out, q, ref, result) {
  if (fs.existsSync(path.join(out, 'failure.json'))) fail('respec-result-mismatch', 'failed/staged output cannot supply readiness');
  const file = path.join(out, 'result-clock.json'), raw = bytes(file), p = transitionJson(raw);
  closed(p, ['schema', 'schemaVersion', 'requestSha256', 'result', 'status', 'publishedAtMs'], 'publication clock');
  if (p.schema !== 'fvs/auto-respec-publication' || p.schemaVersion !== q.schemaVersion || p.requestSha256 !== memoryHash(q) || !same(p.result, ref) || p.status !== result.status
    || !Number.isSafeInteger(p.publishedAtMs) || (!unbudgetedRun(result.frame.run)&&p.publishedAtMs < result.observation.endedAtMs) || requestExpired(q,p.publishedAtMs)
    || (runExpired(result.frame.run,p.publishedAtMs) && !result.observation.reasons.includes('original-limit-exhausted'))) fail('respec-result-mismatch', 'not this successfully published bounded result');
  if (!unbudgetedRun(result.frame.run) && Date.now() < p.publishedAtMs) fail('respec-clock-rollback', 'clock precedes successful publication');
  return { file, sha256: hash(raw) };
}
export function runRespec(options,services={}) {
  const value=data(options),q=request(value.request);return q.schemaVersion===2?respecDriverV2(runRespecSteps(value),q,services):respecDriver(runRespecSteps(value));
}
function* runRespecSteps(options) {
  options = data(options); closed(options, ['request', 'out'], 'respec operation'); const { request: raw, out } = options;
  const q = request(raw), x = setup(q); protect(out, q, x.prior); fs.mkdirSync(out, { mode: 0o700 });
  const input = save(out, 'request.json', q), product = implementation();
  try {
    const observation = observe(q, x, out), status = statusOf(q, observation);
    const result = { schema: 'fvs/auto-respec-result', schemaVersion: q.schemaVersion, operation: q.operation, status, authority: 'no-proof-dispatch-or-human-approval-authority',
      request: q, requestSha256: memoryHash(q), requestInput: input, implementation: product, frame: x.frame, observation, humanReview: 'pending', effectExecutable: false };
    if (!same(product, implementation())) fail('respec-implementation-changed', 'implementation changed during inspection');
    const published = yield{q,x,out,name:'result.json',value:result}; return { ...result, ...published };
  } catch (e) { save(out, 'failure.json', diagnostic(e)); throw e; }
}
export function verifyRespecResult(options,services={}) {
  const value=data(options),q=request(value.request);return q.schemaVersion===2?respecDriverV2(verifyRespecSteps(value),q,services):respecDriver(verifyRespecSteps(value));
}
function* verifyRespecSteps(options) {
  options = data(options); closed(options, ['request', 'out'], 'respec consumer'); const { request: raw, out } = options;
  const q = request(raw), resultRef = { file: path.join(out, 'result.json'), sha256: hash(bytes(path.join(out, 'result.json'))) }, result = bound(resultRef);
  publicationOf(out, q, resultRef, result);
  if (result.schema !== 'fvs/auto-respec-result' || result.schemaVersion !== q.schemaVersion || result.operation !== q.operation || result.requestSha256 !== memoryHash(q) || !same(result.request, q)
    || !same(bound(result.requestInput), q) || !same(result.implementation, implementation()) || result.effectExecutable !== false || result.humanReview !== 'pending') fail('respec-result-mismatch', 'not this independent current caller request/result');
  const x = setup(q);
  if (!same(x.frame, result.frame)) fail('respec-frame-mismatch', 'saved revision frame differs');
  const verificationOut = path.join(fs.realpathSync(os.tmpdir()), 'fvs-respec-consume-' + crypto.randomUUID()); protect(verificationOut, q, x.prior); fs.mkdirSync(verificationOut);
  const observed = observe(q, x, verificationOut);
  if ((observed.currentConsumer === null) !== (result.observation.currentConsumer === null)) fail('respec-evidence-invalid', 'saved consumer presence differs');
  if (observed.currentConsumer !== null && (observed.currentConsumer.code !== result.observation.currentConsumer.code
    || !same(receiptFacts(observed.currentConsumer.receipts, x.rq), receiptFacts(result.observation.currentConsumer.receipts, x.rq)))) fail('respec-evidence-invalid', 'current consumer invocation/output changed');
  for (const ref of result.observation.history.gitEvidence) { const r = bound(ref); if (r.requestSha256 !== memoryHash(q) || r.exitCode !== 0 || r.signal || r.error || !sha(r.toolSha256)) fail('respec-evidence-invalid', 'historical Git observation is not this caller request/tool'); terminationExecutableIdentity({ file: q.schemaVersion===2?r.argv[0]:'/usr/bin/git', sha256: r.toolSha256 }, controlOf(q)); bound(r.stdout, false); bound(r.stderr, false); }
  const stable = o => { const { beganAtMs, endedAtMs, currentConsumer, ...rest } = o; const { gitEvidence, ...history } = rest.history; return { ...rest, history }; };
  stamp(q, x, observed);
  if (!same(stable(observed), stable(result.observation))) fail('respec-context-stale', 'current revision observation changed');
  const status = statusOf(q, observed);
  if (result.status !== status || result.authority !== 'no-proof-dispatch-or-human-approval-authority') fail('respec-result-mismatch', 'saved result overstates current facts');
  const checked = { status, frame: x.frame, observation: observed, authority: result.authority, effectExecutable: false, humanReview: 'pending', verificationEvidence: verificationOut };
  try { const published = yield{q,x,out:verificationOut,name:'verification.json',value:checked}; return { ...checked, ...published }; }
  catch (e) { save(verificationOut, 'failure.json', diagnostic(e)); throw e; }
}
async function cli(args) {
  const operation = args.shift(), flags = {};
  if (['inspect', 'finish'].includes(operation)) fail('respec-unsupported', 'Human re-specification is unsupported in FVS 3.0.0-rc1. Preserve feedback, the complete scope and historical receipts; no revision work is started.');
  while (args.length) { const key = args.shift(), value = args.shift(); if (!['--request', '--out'].includes(key) || !value || Object.hasOwn(flags, key)) fail('respec-usage', 'Human re-specification is unsupported in 3.0.0-rc1; diagnostic verify --request FILE --out DIR'); flags[key] = value; }
  if (!['inspect', 'finish', 'verify'].includes(operation) || !flags['--request'] || !flags['--out']) fail('respec-usage', 'Human re-specification is unsupported in 3.0.0-rc1; diagnostic verify --request FILE --out DIR');
  const q = transitionJson(bytes(path.resolve(flags['--request'])));
  if (operation !== 'verify' && q.operation !== operation) fail('respec-invalid-input', 'CLI/request operation differs');
  const call=services=>(operation==='verify'?verifyRespecResult:runRespec)({request:q,out:path.resolve(flags['--out'])},services);
  return q.schemaVersion===2?withProcessCancellation(call):call({});
}
let direct = false; try { direct = fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch {}
if (direct) { try { console.log(JSON.stringify(await cli(process.argv.slice(2)), null, 2)); } catch (e) { console.log(JSON.stringify({ status: e.code === 'respec-unsupported' ? 'unsupported' : 'unverified', ...diagnostic(e) }, null, 2)); process.exitCode = e.code==='cancelled'?130:7; } }
