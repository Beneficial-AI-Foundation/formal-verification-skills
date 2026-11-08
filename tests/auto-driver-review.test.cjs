'use strict';
// Actual Other export/import and14 fingerprint/registry; AO/model metadata is explicitly doubled.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), { spawnSync } = require('node:child_process');
const f = require('./helpers/auto-driver-fixture.cjs');
const owned = [];
after(() => { for (const p of owned) fs.rmSync(p, { recursive: true, force: true }); });
const ROOT = path.resolve(__dirname, '..');
const RESPONSE = '# FC Specification Review\n\n## Findings\nNone.\n\n## Content coverage statement\nFixture source covered.\n\n## Coverage\nFixture only.\n\n## Evidence\nFuns.lean:1.\n\nVERDICT: PASS\n';
async function setup(authorSession = 'different-author', options = {}) {
  const w = await f.world(options.engineRoot), { x, t, driver } = w; owned.push(x.owned);
  if (options.split) {
    const integration = path.join(x.owned, 'integration'); f.git(x.root, 'worktree', 'add', '-q', '-b', 'integration', integration); w.useSource(integration);
  }
  const specRoot = w.source().root;
  const profile = t.transitionBound(x.profile); profile.stages.spec_review.effort = 'xhigh'; x.profile = f.json(x.owned, 'profile-review', profile);
  fs.writeFileSync(path.join(specRoot, 'Funs.lean'), 'def m1demo.helper := 1\n');
  fs.writeFileSync(path.join(specRoot, 'Spec.lean'), 'theorem helper_spec : m1demo.helper = m1demo.helper := by sorry\n');
  fs.writeFileSync(path.join(specRoot, 'lib.rs'), 'fn helper() -> u64 { 1 }\n');
  fs.writeFileSync(path.join(specRoot, 'inventory.json'), JSON.stringify({ version: 1, declarations: [], cited_apis: [{ path: 'Funs.lean', start: 1, end: 1 }] }));
  const definitions = [];
  if (options.split) { fs.writeFileSync(path.join(specRoot, 'NewSpecDef.lean'), 'def NewSpecDef := Nat\n'); definitions.push({ name: 'NewSpecDef', file: 'NewSpecDef.lean', sha256: f.ref(path.join(specRoot, 'NewSpecDef.lean')).sha256 }); }
  f.git(specRoot, 'add', '--', 'Funs.lean', 'Spec.lean', 'lib.rs', 'inventory.json', ...(options.split ? ['NewSpecDef.lean'] : [])); f.git(specRoot, 'commit', '-qm', 'test(fixture): retain review source');
  const request = f.json(x.owned, 'other-request', { spec: 'Spec.lean', context: ['Funs.lean', 'lib.rs', ...(options.split ? ['NewSpecDef.lean'] : [])], runtime: 'other', model: 'fixture', effort: 'xhigh', author_runtime: 'unknown', grounding: 'inventory.json' });
  const run = spawnSync(process.execPath, [path.join(options.engineRoot ?? ROOT, 'scripts/fvs-spec-review.mjs'), 'run', request.file], { cwd: specRoot, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(run.status, 0, run.stderr);
  const reviewDir = path.join(specRoot, run.stdout.match(/Review packet: (.+)/)[1]);
  const contract = f.json(x.owned, 'contract', { node: 19, role: 'helper', statement: 'm1demo.helper = m1demo.helper', assumptions: [], grounding: { kind: 'none', reason: 'Inert protocol fixture only' },
    implementationDependencies: ['probe:m1demo.helper'], specDefinitions: definitions, externalReferences: [], author: { session: authorSession, harness: 'fixture', model: 'fixture', runId: f.uuid() } });
  const args = { projectRoot: x.root, source: w.source(), plan: w.inputs.plan, graph: w.inputs.graph, registry: path.join(x.owned, 'registry'), contract,
    packet: f.ref(path.join(reviewDir, 'packet.json')), prompt: f.ref(path.join(reviewDir, 'prompt.md')), out: x.out() };
  const binding = driver.prepareReviewBinding(args);
  return { ...w, args, binding, reviewDir };
}
async function released(authorSession, options) {
  const w = await setup(authorSession, options), s = await w.releaseReview(w.binding), { x } = w;
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
  const out = w.x.out();
  assert.throws(() => w.driver.prepareReviewBinding({ ...w.args, out }), /source moved or is dirty/i);
  assert.equal(fs.existsSync(out), false);
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

test('split primary/integration root reviews a new specDefinition and publishes through actual14 transition', async () => {
  const w = await released('different-author', { split: true });
  assert.equal(fs.existsSync(path.join(w.x.root, 'NewSpecDef.lean')), false);
  const result = await w.driver.importReviewedContract(w.query), input = w.t.transitionBound(w.binding.input);
  assert.equal(result.status, 'review-pass-candidate');
  const invocation = f.json(w.x.owned, 'registry-request', { schema: 'fvs/auto-registry-invocation', schemaVersion: 1, plan: w.inputs.plan, graph: w.inputs.graph,
    registry: w.args.registry, specRoot: w.source().root, contract: w.args.contract, review: result.review, previous: null });
  const published = await w.paired({ kind: 'registry-revise', stage: 'review', registryRoot: w.args.registry,
    target: { candidateSha256: input.candidateSha256, review: result.review, request: invocation } });
  assert.equal(published.recorded.status, 'facts-recorded-partial');
  assert.equal(published.raw.record.state, 'machine-reviewed-provisional');
});

test('normalized imported response determines the14 verdict', async () => {
  const w = await released(); fs.writeFileSync(w.response, 'Review complete.\n' + RESPONSE.replace('VERDICT: PASS', '**VERDICT: PASS**'));
  const returned = w.t.transitionBound(w.query.response);
  const result = await w.driver.importReviewedContract({ ...w.query, response: f.json(w.x.owned, 'normalized-return', { ...returned, response: f.ref(w.response) }), out: w.x.out() });
  assert.equal(result.status, 'review-pass-candidate');
  const evidence = w.t.transitionBound(result.evidence);
  assert.equal(evidence.imported.raw.sha256, evidence.sealedResponse.sha256);
  assert.notEqual(evidence.imported.normalized.sha256, evidence.sealedResponse.sha256);
  assert.equal(evidence.verdict, 'PASS');
});

for (const coordinated of [false, true]) test('import-boundary response substitution refuses' + (coordinated ? ' coordinated metadata/sealed tampering' : ''), async () => {
  const engine = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fvs-owned-import-engine-')); owned.push(engine);
  fs.cpSync(path.join(ROOT, 'scripts'), path.join(engine, 'scripts'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'fv-skills'), path.join(engine, 'fv-skills'), { recursive: true });
  const w = await released('different-author', { engineRoot: engine });
  const revise = RESPONSE.replace('None.', '### F-1 — MINOR\nClass: CONTENT\nClaim: Change needed.\nEvidence: Funs.lean:1\nSuggested change: Revise.').replace('VERDICT: PASS', 'VERDICT: REVISE');
  // Instrument only this owned importer copy, after the parent's response read and before the actual child reopens it.
  const helper = path.join(engine, 'scripts/fvs-spec-review.mjs');
  const hook = `import {writeFileSync as sdWrite,readFileSync as sdRead} from 'node:fs';\nimport {createHash as sdHash} from 'node:crypto';\nif(process.argv[2]==='import'){const bytes=${JSON.stringify(revise)};sdWrite(${JSON.stringify(w.response)},bytes);${coordinated ? `sdWrite(process.argv[4],bytes);const record=JSON.parse(sdRead(${JSON.stringify(w.query.response.file)}));record.response.sha256=sdHash('sha256').update(bytes).digest('hex');sdWrite(${JSON.stringify(w.query.response.file)},JSON.stringify(record));` : ''}}\n`;
  fs.writeFileSync(helper, hook + fs.readFileSync(helper, 'utf8').replace(/^#!.*\n/, ''));
  await assert.rejects(w.driver.importReviewedContract(w.query), /changed|digest|response|import/i);
  assert.equal(fs.existsSync(path.join(w.query.out, 'review.json')), false);
});

test('review binding refuses foreign Git roots and dirty or advanced held source', async () => {
  const w = await setup('different-author', { split: true }), foreign = path.join(w.x.owned, 'foreign'); fs.mkdirSync(foreign);
  f.git(foreign, 'init', '-q'); fs.writeFileSync(path.join(foreign, 'Foreign.lean'), 'def Foreign := Nat\n');
  f.git(foreign, 'add', '--', 'Foreign.lean'); f.git(foreign, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'test(fixture): retain foreign root');
  const source = { kind: 'git', root: foreign, commit: f.git(foreign, 'rev-parse', 'HEAD'), expectedTree: f.git(foreign, 'rev-parse', 'HEAD^{tree}') };
  assert.throws(() => w.driver.prepareReviewBinding({ ...w.args, source, out: w.x.out() }), /primary Git store/);
  const newFile = path.join(w.source().root, 'Unrelated.lean'); fs.writeFileSync(newFile, 'def Unrelated := Nat\n');
  assert.throws(() => w.driver.prepareReviewBinding({ ...w.args, out: w.x.out() }), /source moved or is dirty/);
  f.git(w.source().root, 'add', '--', 'Unrelated.lean'); f.git(w.source().root, 'commit', '-qm', 'test(fixture): advance integration source');
  assert.throws(() => w.driver.prepareReviewBinding({ ...w.args, out: w.x.out() }), /source moved or is dirty/);
});

test('same-store fresh actor cannot reuse a binding for another integration worktree', async () => {
  const w = await setup('different-author', { split: true }), other = path.join(w.x.owned, 'other-integration');
  f.git(w.x.root, 'worktree', 'add', '-q', '-b', 'other-integration', other, w.source().commit); w.useSource(other);
  const s = await w.releaseReview(w.binding);
  await assert.rejects(w.driver.importReviewedContract({ projectRoot: w.x.root, binding: w.binding.binding, workPacket: s.packet, marker: s.marker,
    response: f.json(w.x.owned, 'unused-return', {}), session: f.json(w.x.owned, 'unused-session', {}), settings: f.json(w.x.owned, 'unused-settings', {}), out: w.x.out() }), /issued integration\/prepared context/);
});
