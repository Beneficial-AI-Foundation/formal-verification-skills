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

async function reviewed(verdict = 'PASS') {
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
  fs.writeFileSync(response, (verdict === 'PASS' ? RESPONSE : EDITS).replace('VERDICT: PASS', 'VERDICT: ' + verdict));
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
