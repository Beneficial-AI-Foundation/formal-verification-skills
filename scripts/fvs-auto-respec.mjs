// Feedback correspondence and current observations; never dispatch/proof authority.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { memoryDataSnapshot, memoryHash } from './fvs-project-memory.mjs';
import { readState, verifyReconciliation, verifyTransition, verifyMemoryBootstrap } from './fvs-auto.mjs';
import { readRuntime, readRuntimeAssignment } from './fvs-auto-resume.mjs';
import { transitionJson, readTransitionAction, readRuntimeObservation, readTransitionCompletion, verifyTransitionAuthorization, transitionValidators } from './fvs-auto-transitions.mjs';
import { validatePlan, readChain, registryStatus } from './fvs-contract-registry.mjs';
import { inspectAutoAcceptance, readAcceptedStore } from './fvs-checker-auto.mjs';
import { bundleExpectedContext, readReviewSnapshot, BUNDLE_LIMITS } from './fvs-auto-bundle.mjs';

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
function save(out, name, value) {
  const file = path.join(out, name), b = Buffer.from(JSON.stringify(data(value), null, 2) + '\n');
  const fd = fs.openSync(file, 'wx', 0o600); try { fs.writeFileSync(fd, b); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return { file, sha256: hash(b) };
}
function deadline(ms) { if (!Number.isSafeInteger(ms) || ms <= Date.now() || ms > Date.now() + BUNDLE_LIMITS.deadlineMs) fail('respec-deadline-exhausted', 'future bounded600s inspection required'); }
function versions(v, nodes, allowUnestablished = false) {
  if (!Array.isArray(v) || !same(v.map(r => r.node), nodes)) fail('respec-invalid-input', 'exact sorted node versions required');
  for (const r of v) {
    if (allowUnestablished && Object.hasOwn(r, 'unestablished')) { closed(r, ['node', 'unestablished'], 'unestablished node version'); if (!text(r.unestablished)) fail('respec-invalid-input', 'explicit unestablished reason required'); }
    else { closed(r, ['node', 'recordSha256', 'candidateSha256'], 'node version'); if (![r.recordSha256, r.candidateSha256].every(sha)) fail('respec-invalid-input', 'record/candidate identity required'); }
  }
}
function request(raw) {
  const q = data(raw);
  closed(q, ['schema', 'schemaVersion', 'revisionId', 'attemptId', 'operation', 'ownerFeedback', 'priorBundle', 'current', 'requestedItems', 'inspectEvidence', 'deadlineMs'], 'revision request');
  if (q.schema !== 'fvs/auto-respec-request' || q.schemaVersion !== 1 || ![q.revisionId, q.attemptId].every(uuid) || !['inspect', 'finish'].includes(q.operation)) fail('respec-invalid-input', 'version1 revision/attempt/operation required');
  closed(q.ownerFeedback, ['ownerReference', 'evidence'], 'actual owner feedback'); if (!text(q.ownerFeedback.ownerReference)) fail('respec-invalid-input', 'retained owner reference required'); reference(q.ownerFeedback.evidence);
  closed(q.priorBundle, ['manifest', 'expectedContext'], 'prior bundle'); reference(q.priorBundle.manifest);
  closed(q.current, ['bundle', 'resume', 'memory', 'authorization', 'profile'], 'current inputs');
  closed(q.current.resume, ['request', 'result', 'committedHeadSha256'], 'current reconciliation');
  closed(q.current.memory, ['request', 'result'], 'current bootstrap');
  for (const r of [q.current.resume.request, q.current.resume.result, q.current.memory.request, q.current.memory.result, q.current.authorization, q.current.profile]) reference(r);
  if (!sha(q.current.resume.committedHeadSha256)) fail('respec-invalid-input', 'independent committed runtime head required');
  for (const r of [q.current.resume.result, q.current.memory.result]) if (path.basename(r.file) !== 'result.json') fail('respec-invalid-input', 'canonical result.json required');
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
  deadline(q.deadlineMs); return q;
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
  const prior = readReviewSnapshot({ manifest: q.priorBundle.manifest, deadlineMs: q.deadlineMs });
  if (!same(q.priorBundle.expectedContext, prior.body.snapshot.context)) fail('respec-frame-mismatch', 'prior bundle is not the independently requested captured context');
  const b = q.current.bundle, ctx = bundleExpectedContext(b), old = prior.body.snapshot.request;
  if (b.deadlineMs > q.deadlineMs || b.projectRoot !== old.projectRoot || b.source.root !== old.source.root) fail('respec-frame-mismatch', 'same primary/source and bounded current context required');
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
  const rq = bound(q.current.resume.request), rr = bound(q.current.resume.result), mq = bound(q.current.memory.request), mr = bound(q.current.memory.result);
  if (rq.phase !== 'resume' || rq.attemptId !== q.attemptId || !same(rq.source, b.source) || !same(rq.memoryRequest, mq)
    || !same(rr.request, rq) || rr.requestSha256 !== memoryHash(rq) || rr.committedHeadSha256 !== q.current.resume.committedHeadSha256
    || rr.observation?.memory?.out !== path.dirname(q.current.memory.result.file) || mr.requestSha256 !== memoryHash(mq) || !same(mr.request, mq)) fail('respec-current-request-mismatch', 'own current16/20 attempt/phase/source/result required');
  for (const key of ['graph', 'plan', 'baseline']) if (!same(rq.inputs[key], b[key])) fail('respec-current-request-mismatch', 'resume stage tuple differs');
  if (!same(rq.inputs.extraction, b.extraction) || !same(rq.inputs.acceptedStore, b.acceptedStore)) fail('respec-current-request-mismatch', 'resume extraction/store tuple differs');
  const runtime = readRuntime(b.projectRoot);
  if (!runtime.state || runtime.headSha256 !== q.current.resume.committedHeadSha256 || runtime.fileSha256 !== b.runtime?.state?.sha256 || b.runtime.state.file !== path.join(b.projectRoot, '.formalising/auto-fv/resume/state.json')) fail('respec-context-stale', 'actual current committed runtime/bytes required');
  if (!same(runtime.state.run.choicesGeneration, agreement.choicesGeneration) || runtime.state.run.agreementContextSha256 !== agreement.contextSha256 || runtime.state.run.runId !== rq.runId) fail('respec-frame-mismatch', 'run context changed');
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
const legacyInspectSource = fileURLToPath(new URL('../fv-skills/references/auto-respec-inspect-v1-6593d0f4.source.txt', import.meta.url));
function inspectImplementation(v) {
  const current = implementation();
  if (same(v, current)) return true;
  const expected = { respec: { file: current.respec.file, sha256: legacyInspect.respec }, bundle: { file: current.bundle.file, sha256: legacyInspect.bundle } };
  // Only the unchanged inspect-v1 contract may read this exact retained version.
  return current.bundle.sha256 === legacyInspect.bundle && same(v, expected)
    && !(fs.statSync(legacyInspectSource).mode & 0o111) && hash(bytes(legacyInspectSource)) === legacyInspect.respec;
}
function storeHeads(rows) {
  const heads = new Map();
  for (const { sha256, record } of rows) heads.set(record.node, { node: record.node, sha256, integrated: record.integrated,
    frozenSha256: record.frozenSha256, registryHeadSha256: record.registryHeadSha256, dependencies: record.dependencies });
  return [...heads.values()].sort((a, b) => a.node - b.node);
}
function conclusiveLocalFailure(a, before, after, observation, run, registryRows, storeRows) {
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
  bound(command.tool, false); const output = bound(command.stdout), stderr = bound(command.stderr, false).toString('utf8');
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
  const observation = readRuntimeObservation(after.event), facts = conclusiveLocalFailure(a, before, after, observation, run, registry?.records ?? [], store?.records ?? []);
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
  publicationOf(path.dirname(initial.result.file), original, initial.result, result);
  if (original.operation !== 'inspect' || result.schema !== 'fvs/auto-respec-result' || result.operation !== 'inspect' || result.requestSha256 !== memoryHash(original) || !same(result.request, original) || !inspectImplementation(result.implementation)) fail('respec-inspect-mismatch', 'not the exact original inspect request/result/implementation');
  const originalFrame = frameOf(original, x.prior, x.runtime.state.run);
  if (!same(originalFrame, result.frame) || !same(originalFrame, x.frame)) fail('respec-frame-mismatch', 'original feedback/scope/run/accounting frame changed');
  const head = original.current.resume.committedHeadSha256, index = x.runtime.state.history.findIndex(row => row.sha256 === head);
  if (index < 0) fail('respec-history-mismatch', 'initial committed runtime prefix is missing');
  checkVersions(original.requestedItems, nodeHeads(chainPrefix(x.chain.records, original.current.bundle.registry.expectedHeadSha256, 'sha')));
  let current = tupleOfBundle(original.current.bundle); const effects = [], failures = [], promotions = [], gitEvidence = [];
  const toolRef = name => { const file = fileURLToPath(new URL(name, import.meta.url)); return { file, sha256: hash(bytes(file)) }; };
  const validators = transitionValidators({ tools: { auto: toolRef('fvs-auto.mjs'), registry: toolRef('fvs-contract-registry.mjs') }, git(root, args, buffer = false) {
    if (root !== x.b.source.root || !['rev-parse', 'show', 'rev-list', 'diff-tree'].includes(args[0])) fail('respec-history-mismatch', 'unexpected historical Git read');
    const argv = ['/usr/bin/git', '-C', root, ...args], toolSha256 = hash(bytes('/usr/bin/git'));
    const env = { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
    const startedAtMs = Date.now(), p = spawnSync(argv[0], argv.slice(1), { cwd: root, env, timeout: Math.max(1, Math.min(10000, q.deadlineMs - startedAtMs)), maxBuffer: 16 * 1024 * 1024 });
    const stream = (suffix, b) => { const file = path.join(out, 'trace-git-' + gitEvidence.length + '.' + suffix); fs.writeFileSync(file, b, { flag: 'wx' }); return { file, sha256: hash(b) }; };
    const receipt = save(out, 'trace-git-' + gitEvidence.length + '.json', { argv, cwd: root, env, requestSha256: memoryHash(q), startedAtMs, endedAtMs: Date.now(), toolSha256, exitCode: p.status,
      signal: p.signal, error: p.error?.code ?? null, stdout: stream('stdout', p.stdout ?? Buffer.alloc(0)), stderr: stream('stderr', p.stderr ?? Buffer.alloc(0)) });
    gitEvidence.push(receipt);
    if (p.error || p.signal || p.status !== 0 || toolSha256 !== hash(bytes('/usr/bin/git'))) fail('respec-history-mismatch', 'bounded historical Git read failed');
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
      failures.push(conclusiveLocalFailure(a, before, row, observation, x.runtime.state.run, x.chain.records, x.store?.records ?? []));
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
      || fixed.runId !== run.runId || fixed.canonicalRoot !== run.canonicalRoot || fixed.gitCommonDir !== run.gitCommonDir || fixed.startedAtMs !== run.startedAtMs || fixed.deadlineMs !== run.deadlineMs
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
  return { effects, failures, promotions, gitEvidence };
}
function implementation() {
  return Object.fromEntries([['respec', 'fvs-auto-respec.mjs'], ['bundle', 'fvs-auto-bundle.mjs']].map(([key, name]) => {
    const file = fileURLToPath(new URL(name, import.meta.url)); return [key, { file, sha256: hash(bytes(file)) }];
  }));
}
function memoryEvidence(q, x) {
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
  const expired = began >= run.deadlineMs;
  if (began < x.runtime.lastObservedAtMs) fail('respec-clock-rollback', 'clock precedes current accounting');
  let consumed = null, actualMemory = null, currentness = { status: 'unverified', reason: 'current-proof-not-established', nodes: [] };
  if (expired) reasons.push('original-limit-exhausted');
  else {
    verifyMemoryBootstrap({ projectRoot: x.b.projectRoot, callerRoot: x.b.projectRoot, request: x.mq, out: path.dirname(q.current.memory.result.file) });
    actualMemory = memoryEvidence(q, x);
    consumed = (x.rq.transition === null ? verifyReconciliation : verifyTransition)({ projectRoot: x.b.projectRoot, request: x.rq, out: path.dirname(q.current.resume.result.file) });
    if (consumed.committedHeadSha256 !== x.runtime.headSha256) fail('respec-context-stale', 'consumer observed another runtime head');
    if (x.b.baseline && x.b.acceptedStore && !x.validation.problems.length) {
      try { currentness = inspectAutoAcceptance({ baseline: x.b.baseline, store: x.b.acceptedStore, source: x.b.source, deadlineMs: Math.min(q.deadlineMs, run.deadlineMs), out: path.join(out, 'current-proof') }); }
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
    verifyMemoryBootstrap({ projectRoot: x.b.projectRoot, callerRoot: x.b.projectRoot, request: x.mq, out: path.dirname(q.current.memory.result.file) });
    (x.rq.transition === null ? verifyReconciliation : verifyTransition)({ projectRoot: x.b.projectRoot, request: x.rq, out: path.dirname(q.current.resume.result.file) });
  }
  fence(q, x);
  const ended = clock(q, x, began);
  if (ended >= run.deadlineMs) reasons.push('original-limit-exhausted');
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
  if (at < floor || at < x.runtime.lastObservedAtMs) fail('respec-clock-rollback', 'clock moved backwards during final reads/publication');
  if (at >= q.deadlineMs) fail('respec-deadline-exhausted', 'inspection deadline expired during final reads/publication');
  return at;
}
function stamp(q, x, observation) {
  observation.endedAtMs = clock(q, x, observation.endedAtMs);
  if (observation.endedAtMs >= x.runtime.state.run.deadlineMs && !observation.reasons.includes('original-limit-exhausted')) observation.reasons.push('original-limit-exhausted');
}
function publish(q, x, out, name, value) {
  stamp(q, x, value.observation); value.status = statusOf(q, value.observation);
  const evidence = save(out, name, value), at = clock(q, x, value.observation.endedAtMs);
  if (at >= x.runtime.state.run.deadlineMs && !value.observation.reasons.includes('original-limit-exhausted')) fail('respec-publication-stale', 'original limit expired while output was being published; staged artifact is unverified');
  const publication = save(out, name.replace(/\.json$/, '-clock.json'), { schema: 'fvs/auto-respec-publication', schemaVersion: 1, requestSha256: memoryHash(q), result: evidence, status: value.status, publishedAtMs: at });
  const last = clock(q, x, at);
  if (last >= x.runtime.state.run.deadlineMs && !value.observation.reasons.includes('original-limit-exhausted')) fail('respec-publication-stale', 'original limit expired at the final publication fence');
  return { evidence, publication };
}
function publicationOf(out, q, ref, result) {
  if (fs.existsSync(path.join(out, 'failure.json'))) fail('respec-result-mismatch', 'failed/staged output cannot supply readiness');
  const file = path.join(out, 'result-clock.json'), p = transitionJson(bytes(file));
  closed(p, ['schema', 'schemaVersion', 'requestSha256', 'result', 'status', 'publishedAtMs'], 'publication clock');
  if (p.schema !== 'fvs/auto-respec-publication' || p.schemaVersion !== 1 || p.requestSha256 !== memoryHash(q) || !same(p.result, ref) || p.status !== result.status
    || !Number.isSafeInteger(p.publishedAtMs) || p.publishedAtMs < result.observation.endedAtMs || p.publishedAtMs >= q.deadlineMs
    || (p.publishedAtMs >= result.frame.run.deadlineMs && !result.observation.reasons.includes('original-limit-exhausted'))) fail('respec-result-mismatch', 'not this successfully published bounded result');
  if (Date.now() < p.publishedAtMs) fail('respec-clock-rollback', 'clock precedes successful publication');
}
export function runRespec(options) {
  options = data(options); closed(options, ['request', 'out'], 'respec operation'); const { request: raw, out } = options;
  const q = request(raw), x = setup(q); protect(out, q, x.prior); fs.mkdirSync(out, { mode: 0o700 });
  const input = save(out, 'request.json', q), product = implementation();
  try {
    const observation = observe(q, x, out), status = statusOf(q, observation);
    const result = { schema: 'fvs/auto-respec-result', schemaVersion: 1, operation: q.operation, status, authority: 'no-proof-dispatch-or-human-approval-authority',
      request: q, requestSha256: memoryHash(q), requestInput: input, implementation: product, frame: x.frame, observation, humanReview: 'pending', effectExecutable: false };
    if (!same(product, implementation())) fail('respec-implementation-changed', 'implementation changed during inspection');
    const published = publish(q, x, out, 'result.json', result); return { ...result, ...published };
  } catch (e) { save(out, 'failure.json', diagnostic(e)); throw e; }
}
export function verifyRespecResult(options) {
  options = data(options); closed(options, ['request', 'out'], 'respec consumer'); const { request: raw, out } = options;
  const q = request(raw), resultRef = { file: path.join(out, 'result.json'), sha256: hash(bytes(path.join(out, 'result.json'))) }, result = bound(resultRef);
  publicationOf(out, q, resultRef, result);
  if (result.schema !== 'fvs/auto-respec-result' || result.schemaVersion !== 1 || result.operation !== q.operation || result.requestSha256 !== memoryHash(q) || !same(result.request, q)
    || !same(bound(result.requestInput), q) || !same(result.implementation, implementation()) || result.effectExecutable !== false || result.humanReview !== 'pending') fail('respec-result-mismatch', 'not this independent current caller request/result');
  const x = setup(q);
  if (!same(x.frame, result.frame)) fail('respec-frame-mismatch', 'saved revision frame differs');
  const verificationOut = path.join(fs.realpathSync(os.tmpdir()), 'fvs-respec-consume-' + crypto.randomUUID()); protect(verificationOut, q, x.prior); fs.mkdirSync(verificationOut);
  const observed = observe(q, x, verificationOut);
  if ((observed.currentConsumer === null) !== (result.observation.currentConsumer === null)) fail('respec-evidence-invalid', 'saved consumer presence differs');
  if (observed.currentConsumer !== null && (observed.currentConsumer.code !== result.observation.currentConsumer.code
    || !same(receiptFacts(observed.currentConsumer.receipts, x.rq), receiptFacts(result.observation.currentConsumer.receipts, x.rq)))) fail('respec-evidence-invalid', 'current consumer invocation/output changed');
  for (const ref of result.observation.history.gitEvidence) { const r = bound(ref); if (r.requestSha256 !== memoryHash(q) || r.exitCode !== 0 || r.signal || r.error || r.toolSha256 !== hash(bytes('/usr/bin/git'))) fail('respec-evidence-invalid', 'historical Git observation is not this caller request/tool'); bound(r.stdout, false); bound(r.stderr, false); }
  const stable = o => { const { beganAtMs, endedAtMs, currentConsumer, ...rest } = o; const { gitEvidence, ...history } = rest.history; return { ...rest, history }; };
  stamp(q, x, observed);
  if (!same(stable(observed), stable(result.observation))) fail('respec-context-stale', 'current revision observation changed');
  const status = statusOf(q, observed);
  if (result.status !== status || result.authority !== 'no-proof-dispatch-or-human-approval-authority') fail('respec-result-mismatch', 'saved result overstates current facts');
  const checked = { status, frame: x.frame, observation: observed, authority: result.authority, effectExecutable: false, humanReview: 'pending', verificationEvidence: verificationOut };
  try { const published = publish(q, x, verificationOut, 'verification.json', checked); return { ...checked, ...published }; }
  catch (e) { save(verificationOut, 'failure.json', diagnostic(e)); throw e; }
}
function cli(args) {
  const operation = args.shift(), flags = {};
  while (args.length) { const key = args.shift(), value = args.shift(); if (!['--request', '--out'].includes(key) || !value || Object.hasOwn(flags, key)) fail('respec-usage', 'inspect/finish/verify --request FILE --out DIR'); flags[key] = value; }
  if (!['inspect', 'finish', 'verify'].includes(operation) || !flags['--request'] || !flags['--out']) fail('respec-usage', 'inspect/finish/verify --request FILE --out DIR');
  const q = transitionJson(bytes(path.resolve(flags['--request'])));
  if (operation !== 'verify' && q.operation !== operation) fail('respec-invalid-input', 'CLI/request operation differs');
  return (operation === 'verify' ? verifyRespecResult : runRespec)({ request: q, out: path.resolve(flags['--out']) });
}
let direct = false; try { direct = fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch {}
if (direct) { try { console.log(JSON.stringify(cli(process.argv.slice(2)), null, 2)); } catch (e) { console.log(JSON.stringify({ status: 'unverified', ...diagnostic(e) }, null, 2)); process.exitCode = 7; } }
