'use strict';
// Closing a released review assignment with its validated import as the known-work handoff. AO/reviewer are labelled
// protocol doubles; closure is execution accounting only (never a review PASS or proof evidence).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
const f = require('./helpers/auto-driver-fixture.cjs');
const { closeAssignment } = require('./helpers/d-respec-world.cjs');
const owned = [];
after(() => { for (const p of owned) fs.rmSync(p, { recursive: true, force: true }); });
const ROOT = path.resolve(__dirname, '..');
const RESPONSE = '# FC Specification Review\n\n## Findings\nNone.\n\n## Content coverage statement\nFixture source covered.\n\n## Coverage\nFixture only.\n\n## Evidence\nFuns.lean:1.\n\nVERDICT: PASS\n';
const EDITS = RESPONSE.replace('None.', '### F-1 — MINOR\nClass: CONTENT\nClaim: Needs an edit.\nEvidence: Funs.lean:1\nSuggested change: Edit.');

async function reviewed(verdict = 'PASS', text = null) {
  const w = await f.world(), { x, t, driver } = w; owned.push(x.owned);
  const profile = t.transitionBound(x.profile); profile.stages.spec_review.effort = 'xhigh'; x.profile = f.json(x.owned, 'profile-review', profile);
  const root = w.source().root;
  fs.writeFileSync(path.join(root, 'Funs.lean'), 'def m1demo.helper := 1\n');
  fs.writeFileSync(path.join(root, 'Spec.lean'), 'theorem helper_spec : m1demo.helper = m1demo.helper := by sorry\n');
  fs.writeFileSync(path.join(root, 'inventory.json'), JSON.stringify({ version: 1, declarations: [], cited_apis: [{ path: 'Funs.lean', start: 1, end: 1 }] }));
  f.git(root, 'add', '--', 'Funs.lean', 'Spec.lean', 'inventory.json'); f.git(root, 'commit', '-qm', 'test(fixture): retain review source');
  const request = f.json(x.owned, 'other-request', { spec: 'Spec.lean', context: ['Funs.lean'], runtime: 'other', model: 'fixture', effort: 'xhigh', author_runtime: 'unknown', grounding: 'inventory.json' });
  const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts/fvs-spec-review.mjs'), 'run', request.file], { cwd: root, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(run.status, 0, run.stderr);
  const dir = path.join(root, run.stdout.match(/Review packet: (.+)/)[1]);
  const contract = f.json(x.owned, 'contract', { node: 19, role: 'helper', statement: 'm1demo.helper = m1demo.helper', assumptions: [], grounding: { kind: 'none', reason: 'Inert protocol fixture only' },
    implementationDependencies: ['probe:m1demo.helper'], specDefinitions: [], externalReferences: [], author: { session: 'different-author', harness: 'fixture', model: 'fixture', runId: f.uuid() } });
  const binding = driver.prepareReviewBinding({ projectRoot: x.root, source: w.source(), plan: w.inputs.plan, graph: w.inputs.graph, registry: path.join(x.owned, 'registry'), contract,
    packet: f.ref(path.join(dir, 'packet.json')), prompt: f.ref(path.join(dir, 'prompt.md')), out: x.out() });
  const s = await w.releaseReview(binding), response = path.join(x.owned, 'response-' + f.uuid() + '.md');
  fs.writeFileSync(response, text ?? (verdict === 'PASS' ? RESPONSE : EDITS).replace('VERDICT: PASS', 'VERDICT: ' + verdict));
  const imported = await driver.importReviewedContract({ projectRoot: x.root, binding: binding.binding, workPacket: s.packet, marker: s.marker,
    response: f.json(x.owned, 'returned', { workPacket: s.packet, marker: s.marker, binding: binding.binding, response: f.ref(response), reviewerInvocation: s.launch.action.transitionId }),
    session: f.json(x.owned, 'session', { session: { id: s.actor.sessionId, projectId: 'fixture-project', harness: 'fixture', isTerminated: false } }),
    settings: f.json(x.owned, 'settings', { options: [{ id: 'model', currentValue: 'fixture' }, { id: 'effort', currentValue: 'xhigh' }] }), out: x.out() });
  const completion = () => t.recordReviewWorkCompletion({ importEvidence: imported.evidence, contract, review: imported.review, controllerSessionId: w.context().ao.coordinatorSessionId, out: x.out() }).completion;
  return { ...w, binding, s, imported, completion, response };
}
const reservation = (w, id) => w.auto.readRuntimeState({ projectRoot: w.x.root }).reservations.get(id);

test('a closed review reservation admits the next intent on the same node; closure is not a PASS', async () => {
  const w = await reviewed(), handoff = w.completion();
  assert.equal(w.t.readKnownWork(handoff).outcome, 'completed');
  await assert.rejects(w.releaseReview(w.binding), /node already reserved/, 'an open reviewer reservation blocks the node');
  const association = w.context().associations.find(a => w.t.transitionBound(a).sessionId === w.s.actor.sessionId);
  const closed = await closeAssignment(w, w.s.actor, handoff);
  assert.equal(closed.resolved.recorded.status, 'facts-recorded-partial');
  assert.equal(reservation(w, w.s.actor.reservationId).state, 'closed');
  const evidence = w.t.transitionBound(closed.resolved.recorded.checkpoint.request).transition.effect.resolution.evidence;
  await assert.rejects(w.paired({ kind: 'terminate', stage: 'reconcile', sessionId: w.s.actor.sessionId, execute: false, effect: { kind: 'reservation-resolution', targetReservationId: w.s.actor.reservationId },
    target: { sessionId: w.s.actor.sessionId, association, progress: handoff, operation: 'resolve-terminated-reservation' }, after: () => ({ sessionId: null, association: null, evidence: [evidence], resolution: { reason: 'session-terminated', evidence } }) }),
    /actor|reservation|assignment|conflict/i, 'double close refuses');
  const again = await w.releaseReview(w.binding);
  assert.equal(reservation(w, again.actor.reservationId).state, 'active', 'next intent on node 19 is admitted after closure');
});

for (const [verdict, outcome] of [['BLOCKED', 'failed'], ['REVISE', 'completed']]) test(verdict + ' review closes as execution accounting', async () => {
  const w = await reviewed(verdict), handoff = w.completion();
  assert.equal(w.t.readKnownWork(handoff).outcome, outcome);
  await closeAssignment(w, w.s.actor, handoff);
  assert.equal(reservation(w, w.s.actor.reservationId).state, 'closed');
});

test('forged, stale or tampered handoffs refuse before any stop effect', async () => {
  const w = await reviewed(), { t, x } = w, value = t.transitionBound(w.completion());
  const [result, evidenceRef] = value.artifacts, typed = t.transitionBound(result), forged = patch => f.json(x.owned, 'forged-completion', { ...value, ...patch });
  for (const bad of [forged({ outcome: 'failed' }), forged({ outcome: 'partial' }), forged({ packet: f.json(x.owned, 'other-packet', {}) }), forged({ artifacts: [result] }),
    forged({ artifacts: [f.json(x.owned, 'no-review', { ...typed, result: { ...typed.result, review: null } }), evidenceRef] }),
    forged({ artifacts: [f.json(x.owned, 'other-kind', { ...typed, kind: 'candidate' }), evidenceRef] }),
    forged({ artifacts: [result, f.json(x.owned, 'other-evidence', { ...t.transitionBound(evidenceRef), workPacket: f.json(x.owned, 'p', {}) })] }),
    forged({ sourceAfter: { commit: '0'.repeat(40), tree: '0'.repeat(40) } }), forged({ controllerSessionId: 'other-controller' })])
    assert.throws(() => t.readKnownWork(bad), { name: /Error/ });
  assert.throws(() => t.readTaskProgress(w.completion()), /task progress/, 'a review completion is never a proof replacement handoff');
  const handoff = w.completion();
  fs.appendFileSync(w.response, 'tampered\n');
  const evidence = t.transitionBound(value.artifacts[1]);
  fs.appendFileSync(evidence.sealedResponse.file, 'x');
  await assert.rejects(closeAssignment(w, w.s.actor, handoff), /changed|bytes|sha|bound/i);
  assert.equal(reservation(w, w.s.actor.reservationId).state, 'active', 'no closure from tampered evidence');
});

test('a live actor or open known-work issuance cannot be resolved', async () => {
  const w = await reviewed(), { x, t } = w, handoff = w.completion();
  const association = w.context().associations.find(a => t.transitionBound(a).sessionId === w.s.actor.sessionId);
  const evidence = f.json(x.owned, 'premature-termination', { schema: 'fvs/auto-owned-session-termination', schemaVersion: 1, session: { id: w.s.actor.sessionId, projectId: 'fixture-project', isTerminated: true }, progress: handoff, terminationCompletion: f.json(x.owned, 'none', {}) });
  await assert.rejects(w.paired({ kind: 'terminate', stage: 'reconcile', sessionId: w.s.actor.sessionId, execute: false, effect: { kind: 'reservation-resolution', targetReservationId: w.s.actor.reservationId },
    target: { sessionId: w.s.actor.sessionId, association, progress: handoff, operation: 'resolve-terminated-reservation' }, after: () => ({ sessionId: null, association: null, evidence: [evidence], resolution: { reason: 'session-terminated', evidence } }) }),
    /termination|stopped|quiescent|uncertain/i, 'no resolve before an actual successful stop');
  const lock = path.join(w.e?.ownedWorkRoot?.(w.s.packet) ?? path.join(path.dirname(w.s.packet.file), 'owned-work-' + w.s.packet.sha256), 'issuance-lock');
  fs.mkdirSync(lock);
  await assert.rejects(closeAssignment(w, w.s.actor, handoff), /busy|uncertain|issuance/i, 'pending known-work issuance is not empty work');
  fs.rmdirSync(lock);
  assert.equal(reservation(w, w.s.actor.reservationId).state, 'active');
});

// An observation-only reconcile between a stop's before and after does not change the closure facts; the after is
// re-validated at the then-current head. A stale after submitted once the head has moved must refuse.
test('a resolution after submitted at a moved head refuses and never closes twice', async () => {
  const w = await reviewed(), { x } = w, closed = await closeAssignment(w, w.s.actor, w.completion());
  const recorded = w.t.transitionBound(closed.resolved.recorded.checkpoint.request), moved = w.auto.readRuntimeState({ projectRoot: x.root }).headSha256;
  x.invoke(x.request({ inputs: w.inputs, associations: w.context().associations, source: w.source() }));
  const head = w.auto.readRuntimeState({ projectRoot: x.root }).headSha256;
  assert.notEqual(head, moved);
  // Fresh caller identity, same transition, the head it was computed against: only the head differs from a valid submission.
  const stale = { ...w.request(recorded.transition), expectedHeadSha256: moved };
  const codes = [];
  for (const request of [stale, w.request(recorded.transition)]) {
    await assert.rejects(w.driver.recordAfter({ projectRoot: x.root, request, out: x.out() }), e => { codes.push(e.code + ': ' + e.message); return true; });
    assert.equal(w.auto.readRuntimeState({ projectRoot: x.root }).headSha256, head, 'a refused after commits nothing');
  }
  console.log('stale-head / replay refusals:', JSON.stringify(codes));
  assert.equal(reservation(w, w.s.actor.reservationId).state, 'closed');
});

// Coordinated edits with every affected reference correctly rehashed: the handoff must still be the validated import for
// the issued contract/candidate/head, its normalized verdict and the exactly observed prepared source.
function rebuild(w, value, { evidence, result, review, completion } = {}) {
  const { t, x } = w, [resultRef, evidenceRef] = value.artifacts, r0 = t.transitionBound(resultRef);
  const ev = evidence ? f.json(x.owned, 'rehashed-evidence', evidence(structuredClone(t.transitionBound(evidenceRef)))) : evidenceRef;
  let env = r0.result.review;
  if (review) env = review(env);
  else if (env && evidence) env = f.json(x.owned, 'rehashed-review', { ...t.transitionBound(env), evidence: ev });
  const r1 = { ...r0, result: { ...r0.result, review: env } }, res = f.json(x.owned, 'rehashed-result', result ? result(r1) : r1), c1 = { ...value, artifacts: [res, ev] };
  return f.json(x.owned, 'rehashed-completion', completion ? completion(c1) : c1);
}
test('G1-1: rehashed contract, candidate/head, verdict, artifact and observed-source substitutions refuse', async () => {
  const w = await reviewed(), { t, x } = w, value = t.transitionBound(w.completion()), contract = t.transitionBound(t.transitionBound(value.artifacts[0]).result.contract);
  assert.equal(t.readKnownWork(rebuild(w, value)).outcome, 'completed', 'a faithful rehash is still accepted');
  const env = ref => t.transitionBound(ref);
  const cases = {
    'other-node contract': { result: r => ({ ...r, result: { ...r.result, contract: f.json(x.owned, 'other-contract', { ...contract, node: 20 }) } }) },
    'same-node other statement': { result: r => ({ ...r, result: { ...r.result, contract: f.json(x.owned, 'other-statement', { ...contract, statement: 'm1demo.helper = 2' }) } }) },
    'envelope other candidate': { review: ref => f.json(x.owned, 'other-candidate', { ...env(ref), candidateSha256: 'a'.repeat(64) }) },
    'envelope other head': { review: ref => f.json(x.owned, 'other-head', { ...env(ref), registryHeadSha256: 'b'.repeat(64) }) },
    'PASS relabelled BLOCKED': { evidence: e => ({ ...e, verdict: 'BLOCKED' }), review: () => null, completion: c => ({ ...c, outcome: 'failed' }) },
    'PASS relabelled REVISE': { evidence: e => ({ ...e, verdict: 'REVISE' }), review: ref => f.json(x.owned, 'relabel', { ...env(ref), verdict: 'changes-requested' }) },
    'missing normalized artifact': { evidence: e => ({ ...e, imported: { raw: e.imported.raw, transformation: e.imported.transformation, review: e.imported.review } }) },
    'missing transformation artifact': { evidence: e => ({ ...e, imported: { raw: e.imported.raw, normalized: e.imported.normalized, review: e.imported.review } }) },
    'other observed commit/tree': { evidence: e => ({ ...e, actor: { ...e.actor, worktree: { ...e.actor.worktree, commit: '0'.repeat(40), tree: '0'.repeat(40) } } }) },
  };
  for (const [label, patch] of Object.entries(cases)) assert.throws(() => t.readKnownWork(rebuild(w, value, patch)), { code: 'transition-progress-invalid' }, label);
  await assert.rejects(closeAssignment(w, w.s.actor, rebuild(w, value, cases['PASS relabelled BLOCKED'])), { code: 'transition-progress-invalid' });
  assert.equal(reservation(w, w.s.actor.reservationId).state, 'active', 'refused before any stop effect');
});

// G1-1R: the retained normalized text must be the validator's replay of the sealed bytes, not merely self-consistent.
test('G1-1R: a normalized response closes; a coherent normalized/transformation/review substitution refuses', async () => {
  const bold = 'Review complete.\n' + RESPONSE.replace('VERDICT: PASS', '**VERDICT: PASS**');
  const p = await reviewed('PASS', bold), pe = p.t.transitionBound(p.imported.evidence);
  assert.notEqual(pe.imported.normalized.sha256, pe.sealedResponse.sha256, 'the importer actually normalized this response');
  await closeAssignment(p, p.s.actor, p.completion());
  assert.equal(reservation(p, p.s.actor.reservationId).state, 'closed', 'a faithfully normalized response closes');
  const w = await reviewed(), { t, x } = w, value = t.transitionBound(w.completion());
  const forgedNormalized = RESPONSE.replace('VERDICT: PASS', 'VERDICT: BLOCKED'), file = name => path.join(x.owned, name + '-' + f.uuid());
  const coherent = e => {
    const normalized = file('normalized'); fs.writeFileSync(normalized, forgedNormalized);
    const transformation = file('transformation'); fs.writeFileSync(transformation, JSON.stringify({ ...t.transitionBound(e.imported.transformation), hashes: { ...t.transitionBound(e.imported.transformation).hashes, 'normalized-response.md': f.ref(normalized).sha256 } }));
    const review = file('review'); fs.writeFileSync(review, '# Imported review\n\n' + forgedNormalized.trim() + '\n');
    return { ...e, verdict: 'BLOCKED', imported: { raw: e.imported.raw, normalized: f.ref(normalized), transformation: f.ref(transformation), review: f.ref(review) } };
  };
  const forged = rebuild(w, value, { evidence: coherent, review: () => null, completion: c => ({ ...c, outcome: 'failed' }) });
  assert.throws(() => t.readKnownWork(forged), { code: 'transition-progress-invalid', message: /validator replay/ });
  await assert.rejects(closeAssignment(w, w.s.actor, forged), { code: 'transition-progress-invalid' });
  assert.equal(reservation(w, w.s.actor.reservationId).state, 'active', 'refused before any stop effect');
});

// Current AO's `session kill` also removes the worker's workspace: the worktree is unregistered and its directory is
// gone, while the branch stays. `afterKill` runs between the owned kill and its paired after, as AO's cleanup does.
const unregister = (w, actor) => f.git(w.x.root, 'worktree', 'remove', '--force', actor.worktree.path);
const associationOf = (w, actor) => w.context().associations.find(a => w.t.transitionBound(a).sessionId === actor.sessionId);
const target = (actor, association, progress, operation) => ({ sessionId: actor.sessionId, association, progress, operation });
const ownedStop = (w, actor, association, progress, afterKill = unregister, stopEvidence = null) => w.paired({ kind: 'terminate', stage: 'reconcile', sessionId: actor.sessionId,
  effect: { kind: 'local', operation: 'reconcile' }, target: target(actor, association, progress, 'terminate-session'),
  after: () => { afterKill(w, actor); return { sessionId: null, association: null, ...(stopEvidence ? { evidence: stopEvidence } : {}) }; } });
function resolveStop(w, actor, association, progress, stopped) {
  const evidence = f.json(w.x.owned, 'owned-session-termination', { schema: 'fvs/auto-owned-session-termination', schemaVersion: 1, session: stopped.raw.session, progress, terminationCompletion: stopped.completion });
  return w.paired({ kind: 'terminate', stage: 'reconcile', sessionId: actor.sessionId, execute: false, effect: { kind: 'reservation-resolution', targetReservationId: actor.reservationId },
    target: target(actor, association, progress, 'resolve-terminated-reservation'), after: () => ({ sessionId: null, association: null, evidence: [evidence], resolution: { reason: 'session-terminated', evidence } }) });
}
async function closeWithCleanup(w, actor, progress, afterKill = unregister, stopEvidence = null, beforeResolve = () => {}) {
  const association = associationOf(w, actor), stopped = await ownedStop(w, actor, association, progress, afterKill, stopEvidence);
  beforeResolve(w, actor);
  return { stopped, resolved: await resolveStop(w, actor, association, progress, stopped) };
}
const stopSnapshots = (w, sessionId) => w.auto.readRuntimeState({ projectRoot: w.x.root }).state.history.filter(r => r.event.position === 'after' && r.event.intent.request
  && (a => a.kind === 'terminate' && a.target.sessionId === sessionId)(w.t.readTransitionAction(r.event.intent.request))).map(r => w.t.readRuntimeObservation(r.event).transition.snapshot.worker.worktree);

test('an owned kill that removes the reviewer worktree records its absence and still closes the reservation', async () => {
  const w = await reviewed(), handoff = w.completion(), branch = w.s.actor.worktree.branchRef;
  await closeWithCleanup(w, w.s.actor, handoff);
  assert.equal(reservation(w, w.s.actor.reservationId).state, 'closed');
  const [stop, resolution] = stopSnapshots(w, w.s.actor.sessionId);
  for (const worktree of [stop, resolution]) assert.deepEqual(worktree, w.t.absentWorktree(w.t.transitionBound(w.context().associations.find(a => w.t.transitionBound(a).sessionId === w.s.actor.sessionId)).worktree));
  assert.equal(fs.existsSync(w.s.actor.worktree.path), false, 'nothing recreates the removed worktree');
  assert.match(f.git(w.x.root, 'rev-parse', '--verify', branch), /^[0-9a-f]{40}$/, 'the branch is kept');
  const again = await w.releaseReview(w.binding);
  assert.equal(reservation(w, again.actor.reservationId).state, 'active', 'next intent on node 19 is admitted after closure');
});

for (const [name, afterKill, code] of [
  ['the worktree is only deleted and still registered', (w, actor) => fs.rmSync(actor.worktree.path, { recursive: true, force: true }), /resume-path-invalid|ENOENT/],
  ['AO no longer reports the session terminated', (w, actor) => { unregister(w, actor); const c = JSON.parse(fs.readFileSync(w.x.control, 'utf8')); c.rows.find(r => r.id === actor.sessionId).isTerminated = false; fs.writeFileSync(w.x.control, JSON.stringify(c)); }, /resume-path-invalid|ENOENT/],
  ['the worktree is still present but on another branch', (w, actor) => f.git(actor.worktree.path, 'checkout', '-q', '-b', 'moved-' + f.uuid().slice(0, 8)), /transition-actor-mismatch|context is unavailable/],
]) test('a stop after refuses when ' + name, async () => {
  const w = await reviewed(), handoff = w.completion();
  await assert.rejects(closeWithCleanup(w, w.s.actor, handoff, afterKill), code);
  assert.equal(reservation(w, w.s.actor.reservationId).state, 'active', 'the reservation stays open');
});

test('a removed worktree without the owned kill receipt is not a recorded stop', async () => {
  const w = await reviewed(), handoff = w.completion();
  await assert.rejects(closeWithCleanup(w, w.s.actor, handoff, unregister, []), { code: 'transition-completion-required' });
  assert.equal(reservation(w, w.s.actor.reservationId).state, 'active');
});

test('a worktree removed before any owned stop refuses the stop itself', async () => {
  const w = await reviewed(), handoff = w.completion();
  unregister(w, w.s.actor);
  await assert.rejects(closeWithCleanup(w, w.s.actor, handoff, () => {}), /resume-path-invalid|ENOENT/);
  assert.equal(reservation(w, w.s.actor.reservationId).state, 'active');
});

test('a recorded absence binds only the exact retained association in later reconciliation', async () => {
  const w = await reviewed(), handoff = w.completion();
  const ref = w.context().associations.find(a => w.t.transitionBound(a).sessionId === w.s.actor.sessionId), original = w.t.transitionBound(ref);
  await closeWithCleanup(w, w.s.actor, handoff);
  const reconcile = () => w.driver.recordCheckpoint({ projectRoot: w.x.root, request: w.request(), out: w.x.out() });
  const held = w.auto.readRuntimeState({ projectRoot: w.x.root }).headSha256;
  for (const [name, change] of [
    ['a foreign missing path', v => { v.worktree.path = path.join(w.x.owned, 'elsewhere-' + f.uuid().slice(0, 8)); }],
    ['a traversal of the same path', v => { v.worktree.path = path.dirname(v.worktree.path) + '/sub/../' + path.basename(v.worktree.path); }],
    ['another assignment', v => { v.assignmentId = f.uuid(); }],
    ['another reservation', v => { v.reservationId = f.uuid(); }],
    ['another session', v => { v.sessionId = 'review-worker-other'; }],
    ['an altered last-known commit', v => { v.worktree.commit = 'a'.repeat(40); }],
  ]) {
    const value = structuredClone(original); change(value);
    w.useAssociations([f.json(w.x.owned, 'forged-association', value)]);
    await assert.rejects(reconcile(), e => /resume-association-invalid|resume-path-invalid|ENOENT/.test(String(e.code) + ' ' + e.message), name);
    assert.equal(w.auto.readRuntimeState({ projectRoot: w.x.root }).headSha256, held, name + ' publishes nothing');
  }
  w.useAssociations([ref]);
  await reconcile();
});

test('a worktree re-added after its stop recorded the removal refuses the resolution', async () => {
  const w = await reviewed(), handoff = w.completion(), branch = w.s.actor.worktree.branchRef.replace('refs/heads/', '');
  const readd = (w, actor) => f.git(w.x.root, 'worktree', 'add', '-q', actor.worktree.path, branch);
  await assert.rejects(closeWithCleanup(w, w.s.actor, handoff, unregister, null, readd), /reappeared/);
  assert.equal(reservation(w, w.s.actor.reservationId).state, 'active', 'the reservation stays open');
});

// The assignment stays active until its resolution, so a second owned stop is admitted after one that left the worktree
// present. The later recorded removal must stay final: an earlier present stop cannot hide it.
for (const readd of [false, true]) test('after a present stop, a later stop recording the removal ' + (readd ? 'refuses a re-added worktree' : 'still resolves while it is gone'), async () => {
  const w = await reviewed(), handoff = w.completion(), actor = w.s.actor, association = associationOf(w, actor), branch = actor.worktree.branchRef.replace('refs/heads/', '');
  await ownedStop(w, actor, association, handoff, () => {});
  const stopped = await ownedStop(w, actor, association, handoff);
  assert.deepEqual(stopSnapshots(w, actor.sessionId).map(x => x.absent === true), [false, true], 'present stop, then the stop recording the removal');
  if (!readd) {
    await resolveStop(w, actor, association, handoff, stopped);
    assert.equal(reservation(w, actor.reservationId).state, 'closed');
    return;
  }
  f.git(w.x.root, 'worktree', 'add', '-q', actor.worktree.path, branch);
  await assert.rejects(resolveStop(w, actor, association, handoff, stopped), /reappeared/);
  assert.equal(reservation(w, actor.reservationId).state, 'active', 'the reservation stays open');
});
