'use strict';
// Actual Other export/import and14 fingerprint/registry; AO/model metadata is explicitly doubled.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
const f = require('./helpers/auto-driver-fixture.cjs');
const owned = [];
after(() => { for (const p of owned) fs.rmSync(p, { recursive: true, force: true }); });
const ROOT = path.resolve(__dirname, '..');
const RESPONSE = '# FC Specification Review\n\n## Findings\nNone.\n\n## Content coverage statement\nFixture source covered.\n\n## Coverage\nFixture only.\n\n## Evidence\nFuns.lean:1.\n\nVERDICT: PASS\n';
async function setup(authorSession = 'different-author') {
  const w = await f.world(), { x, t, driver } = w; owned.push(x.owned);
  const profile = t.transitionBound(x.profile); profile.stages.spec_review.effort = 'xhigh'; x.profile = f.json(x.owned, 'profile-review', profile);
  fs.writeFileSync(path.join(x.root, 'Funs.lean'), 'def m1demo.helper := 1\n');
  fs.writeFileSync(path.join(x.root, 'Spec.lean'), 'theorem helper_spec : m1demo.helper = m1demo.helper := by sorry\n');
  fs.writeFileSync(path.join(x.root, 'lib.rs'), 'fn helper() -> u64 { 1 }\n');
  fs.writeFileSync(path.join(x.root, 'inventory.json'), JSON.stringify({ version: 1, declarations: [], cited_apis: [{ path: 'Funs.lean', start: 1, end: 1 }] }));
  f.git(x.root, 'add', '--', 'Funs.lean', 'Spec.lean', 'lib.rs', 'inventory.json'); f.git(x.root, 'commit', '-qm', 'test(fixture): retain review source');
  const request = f.json(x.owned, 'other-request', { spec: 'Spec.lean', context: ['Funs.lean', 'lib.rs'], runtime: 'other', model: 'fixture', effort: 'xhigh', author_runtime: 'unknown', grounding: 'inventory.json' });
  const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts/fvs-spec-review.mjs'), 'run', request.file], { cwd: x.root, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(run.status, 0, run.stderr);
  const reviewDir = path.join(x.root, run.stdout.match(/Review packet: (.+)/)[1]);
  const contract = f.json(x.owned, 'contract', { node: 19, role: 'helper', statement: 'm1demo.helper = m1demo.helper', assumptions: [], grounding: { kind: 'none', reason: 'Inert protocol fixture only' },
    implementationDependencies: ['probe:m1demo.helper'], specDefinitions: [], externalReferences: [], author: { session: authorSession, harness: 'fixture', model: 'fixture', runId: f.uuid() } });
  const args = { projectRoot: x.root, plan: w.inputs.plan, graph: w.inputs.graph, registry: path.join(x.owned, 'registry'), contract,
    packet: f.ref(path.join(reviewDir, 'packet.json')), prompt: f.ref(path.join(reviewDir, 'prompt.md')), out: x.out() };
  const binding = driver.prepareReviewBinding(args);
  return { ...w, args, binding, reviewDir };
}
async function released(authorSession) {
  const w = await setup(authorSession), s = await w.releaseReview(w.binding), { x } = w;
  const response = path.join(x.owned, 'response.md'); fs.writeFileSync(response, RESPONSE);
  const returned = f.json(x.owned, 'returned', { workPacket: s.packet, marker: s.marker, binding: w.binding.binding, response: f.ref(response), reviewerInvocation: s.launch.action.transitionId });
  const session = f.json(x.owned, 'session', { session: { id: s.actor.sessionId, projectId: 'fixture-project', harness: 'fixture', isTerminated: false } });
  const settings = f.json(x.owned, 'settings', { options: [{ id: 'model', currentValue: 'fixture' }, { id: 'effort', currentValue: 'xhigh' }] });
  return { ...w, s, response, query: { projectRoot: x.root, binding: w.binding.binding, workPacket: s.packet, marker: s.marker, response: returned, session, settings, out: x.out() } };
}
test('pre-dispatch binding uses actual14 candidate/head and exact Other packet, not a PASS label', async () => {
  const w = await setup(), b = w.t.transitionBound(w.binding.binding), input = w.t.transitionBound(w.binding.input);
  assert.equal(input.schema, 'fvs/auto-review-input'); assert.equal(input.registryHeadSha256, null); assert.equal(input.node, 19);
  assert.equal('verdict' in b, false); assert.equal(input.contract.sha256, w.args.contract.sha256);
  fs.appendFileSync(path.join(w.x.root, 'Funs.lean'), '-- changed\n');
  assert.throws(() => w.driver.prepareReviewBinding({ ...w.args, out: w.x.out() }), /changed|bytes/i);
});
test('fresh actual16/22 review assignment + Other import produces an exact14 envelope, no proof claim', async () => {
  const w = await released(), result = await w.driver.importReviewedContract(w.query);
  assert.equal(result.status, 'review-pass-candidate'); assert.equal(result.executable, false);
  const review = w.t.transitionBound(result.review), input = w.t.transitionBound(w.binding.input);
  assert.equal(review.candidateSha256, input.candidateSha256); assert.equal(review.registryHeadSha256, input.registryHeadSha256);
  assert.equal(review.reviewer.session, w.s.actor.sessionId); assert.equal(review.reviewer.runId, w.s.launch.action.transitionId);
  assert.equal(review.verdict, 'pass'); assert.match(w.t.transitionBound(result.evidence).provenance, /unverified.*verified:false/);
  const agreement = structuredClone(w.x.canonical().envelope); delete agreement.contextSha256; delete agreement.recordedAt;
  agreement.payload.contextVersion++; agreement.payload.execution = null; agreement.approvedPayloadSha256 = w.auto.agreementPayloadSha256(agreement);
  fs.writeFileSync(f.roadmapFile(w.x.root), '## Decisions\n```fvs-auto-agreement\n' + JSON.stringify(agreement) + '\n```\n');
  w.auto.recordAgreement({ projectRoot: w.x.root, agreement, confirmOverwrite: true });
  await assert.rejects(w.driver.importReviewedContract({ ...w.query, out: w.x.out() }), { code: 'transition-grant-required' });
});
test('bridge holds mismatched packet/response, missing observed model and changed candidate before import', async () => {
  const w = await released();
  const returned = w.t.transitionBound(w.query.response);
  await assert.rejects(w.driver.importReviewedContract({ ...w.query, response: f.json(w.x.owned, 'wrong-return', { ...returned, reviewerInvocation: f.uuid() }), out: w.x.out() }), /another packet/);
  await assert.rejects(w.driver.importReviewedContract({ ...w.query, settings: f.json(w.x.owned, 'missing-model', { options: [] }), out: w.x.out() }), /reviewer\/settings/);
  const binding = w.t.transitionBound(w.binding.binding), c = w.t.transitionBound(w.args.contract);
  const reused = f.json(w.x.owned, 'reused-author-contract', { ...c, author: { ...c.author, session: w.s.actor.sessionId, runId: w.s.launch.action.transitionId } });
  const candidate = await import('../scripts/fvs-contract-registry.mjs');
  assert.equal(candidate.candidateOf(c, binding.context), candidate.candidateOf(w.t.transitionBound(reused), binding.context), 'author identity is not the semantic fingerprint');
  const badBinding = f.json(w.x.owned, 'different-binding', { ...binding, author: w.t.transitionBound(reused).author });
  await assert.rejects(w.driver.importReviewedContract({ ...w.query, binding: badBinding, out: w.x.out() }), /assignment/);
  fs.appendFileSync(w.args.contract.file, ' ');
  await assert.rejects(w.driver.importReviewedContract({ ...w.query, out: w.x.out() }), /changed|bytes/);
  assert.equal(fs.existsSync(path.join(w.reviewDir, 'review.md')), false);
});

test('BLOCKED response stays pending and creates no14 PASS envelope', async () => {
  const w = await released(); fs.writeFileSync(w.response, RESPONSE.replace('VERDICT: PASS', 'VERDICT: BLOCKED'));
  const returned = w.t.transitionBound(w.query.response);
  const result = await w.driver.importReviewedContract({ ...w.query, response: f.json(w.x.owned, 'blocked-return', { ...returned, response: f.ref(w.response) }), out: w.x.out() });
  assert.equal(result.status, 'review-blocked'); assert.equal(result.review, null); assert.equal(result.executable, false);
});

for (const verdict of ['APPROVE-WITH-EDITS', 'REVISE']) test(verdict + ' imports as changes-requested, never pass', async () => {
  const w = await released();
  const response = RESPONSE.replace('None.', '### F-1 — MINOR\nClass: CONTENT\nClaim: Fixture needs an edit.\nEvidence: Funs.lean:1\nSuggested change: Fix the fixture statement.').replace('VERDICT: PASS', 'VERDICT: ' + verdict);
  fs.writeFileSync(w.response, response);
  const returned = w.t.transitionBound(w.query.response);
  const result = await w.driver.importReviewedContract({ ...w.query, response: f.json(w.x.owned, 'edits-return', { ...returned, response: f.ref(w.response) }), out: w.x.out() });
  assert.equal(result.status, 'review-changes-requested'); assert.equal(w.t.transitionBound(result.review).verdict, 'changes-requested');
});

test('an actually issued reviewer with the author session cannot supply14 PASS', async () => {
  const w = await released('review-worker');
  await assert.rejects(w.driver.importReviewedContract(w.query), /distinct fresh invocation/);
  assert.equal(fs.existsSync(path.join(w.reviewDir, 'review.md')), false);
});

test('an actual intervening14 append invalidates the held global head before reviewer import', async () => {
  const w = await setup(), b = w.t.transitionBound(w.binding.binding), input = w.t.transitionBound(w.binding.input);
  const evidence = f.json(w.x.owned, 'labelled-review', { scope: 'registry metadata fixture; no semantic/proof qualification' });
  const review = f.json(w.x.owned, 'review-envelope', { candidateSha256: input.candidateSha256, registryHeadSha256: null, verdict: 'pass',
    reviewer: { session: 'other-metadata-reviewer', harness: 'fixture', model: 'fixture', runId: f.uuid() }, evidence });
  const published = spawnSync(process.execPath, [path.join(ROOT, 'scripts/fvs-contract-registry.mjs'), 'register', '--plan', b.plan.file, '--graph', b.graph.file,
    '--registry', b.registry, '--spec-root', w.x.root, '--contract', b.contract.file, '--review', review.file], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(published.status, 0, published.stderr);
  // A fresh assignment may still carry this old binding; the import must compare the actual14 head.
  const s = await w.releaseReview(w.binding), raw = path.join(w.x.owned, 'late-response.md'); fs.writeFileSync(raw, RESPONSE);
  await assert.rejects(w.driver.importReviewedContract({ projectRoot: w.x.root, binding: w.binding.binding, workPacket: s.packet, marker: s.marker,
    response: f.json(w.x.owned, 'late-return', { workPacket: s.packet, marker: s.marker, binding: w.binding.binding, response: f.ref(raw), reviewerInvocation: s.launch.action.transitionId }),
    session: f.json(w.x.owned, 'not-needed-session', {}), settings: f.json(w.x.owned, 'not-needed-settings', {}), out: w.x.out() }), /head\/context changed/);
});
