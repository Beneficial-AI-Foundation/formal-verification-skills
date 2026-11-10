// Two-revision re-specification scenario over the reused real C0 fixture (owned copies only). Selected explicitly with
// FVS_D_CONFIG (local persistent materials). AO and reviewers are labelled protocol doubles; without FVS_REAL_RESPEC_D=1
// no Lean freeze/check/accept runs and nothing here is proof evidence.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { dWorld, reviseContract, freezeRequest, admitFreeze, runE0, runE1, registryStatus, git, sha } = require('./helpers/d-respec-world.cjs');
const ROOT = path.resolve(__dirname, '..');
const cfg = process.env.FVS_D_CONFIG ? JSON.parse(fs.readFileSync(process.env.FVS_D_CONFIG)) : null;
const skip = cfg ? false : 'FVS_D_CONFIG not set (local qualification materials required)';
const owned = [];
// FVS_D_SCRATCH=<persistent dir> creates the inert worlds there and keeps them (receipts for diagnosis);
// FVS_D_KEEP=1 keeps temporary ones. Kept worlds are printed instead of removed.
const scratch = process.env.FVS_D_SCRATCH ? fs.realpathSync(process.env.FVS_D_SCRATCH) : null, keep = scratch !== null || process.env.FVS_D_KEEP === '1';
after(() => { for (const p of owned) keep ? console.log('kept:', p) : fs.rmSync(p, { recursive: true, force: true }); });
async function setup() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(scratch ?? os.tmpdir(), 'fvs-d-world-'))); owned.push(base);
  const w = await dWorld({ engineRoot: ROOT, base, materials: cfg.materials, bd: cfg.bd }); owned.push(w.x.owned);
  return w;
}

test('real C0 world reconciles current with real Beads, registry G0 and the real extraction inputs', { skip }, async () => {
  const w = await setup(), { x, real } = w, c0 = cfg.materials.c0;
  assert.equal(git(real.root, 'rev-parse', 'HEAD'), c0.commit);
  assert.equal(git(real.source, 'rev-parse', 'HEAD^{tree}'), c0.tree);
  assert.equal(git(real.source, 'status', '--porcelain=v1', '--untracked-files=all'), '');
  assert.deepEqual(w.source(), { kind: 'git', root: real.source, commit: c0.commit, expectedTree: c0.tree });
  const status = JSON.parse(spawnSync(process.execPath, [path.join(ROOT, 'scripts/fvs-contract-registry.mjs'), 'status', '--plan', w.inputs.plan.file, '--graph', w.inputs.graph.file,
    '--registry', real.registry, '--spec-root', real.source], { encoding: 'utf8' }).stdout);
  assert.equal(status.registryHeadSha256, cfg.materials.registry.headSha256);
  for (const n of ['19', '20', '21']) assert.equal(status.nodes[n].state, 'machine-reviewed-provisional');
  const { result } = x.invoke(x.request({ inputs: w.inputs, source: w.source() }));
  assert.equal(result.code, 'reconciled', JSON.stringify(result).slice(0, 600)); assert.deepEqual(result.observation.reasons, []);
  assert.equal(x.auto.readState({ projectRoot: real.root }).state.choices.memory.mode, 'beads');
});

// E1 semantic step: H (node 19) gets the revised statement its overlay proof must state exactly; Roots.lean seals the
// elaboration context. The reviewer is a labelled double, so the record is protocol evidence, not semantic review.
function g0Contract(node) {
  const dir = path.join(cfg.materials.registry.root, 'records');
  return structuredClone(fs.readdirSync(dir).sort().map(n => JSON.parse(fs.readFileSync(path.join(dir, n)))).find(r => r.contract.node === node).contract);
}
function reviseH(w, chaining = {}) {
  const roots = fs.readFileSync(path.join(w.source().root, 'Specs/Roots.lean'));
  const contract = { ...g0Contract(19), statement: '\u2200 (p : m1demo.Pair), m1demo.helper p = p.a + p.b',
    assumptions: ['Lean-only checker qualification; Rust translation correspondence is not established.'],
    grounding: { kind: 'source', source: 'C0 M1demo/M1demo.lean helper and Specs/Roots.lean context', version: cfg.materials.c0.commit, locator: 'm1demo.helper' },
    specDefinitions: [{ name: 'm1demo.roots (statement context)', file: 'Specs/Roots.lean', sha256: sha(roots) }],
    author: { session: 'd-scripted-author', harness: 'scripted', model: 'none', runId: 'd-e1-revise-h-' + crypto.randomUUID() } };
  const draft = 'import Specs.Roots\nopen Aeneas Aeneas.Std Result\ntheorem helper_eq_sum : \u2200 (p : m1demo.Pair), m1demo.helper p = p.a + p.b := by sorry\n';
  return reviseContract(w, { contract, draft, cited: [{ path: 'Specs/Roots.lean', start: 1, end: 17 }], ...chaining });
}

function reviewUnchanged(w, node, statement, chaining = {}) {
  const contract = { ...g0Contract(node), author: { session: 'd-scripted-author', harness: 'scripted', model: 'none', runId: 'd-e1-review-' + node + '-' + crypto.randomUUID() } };
  return reviseContract(w, { contract, draft: 'import Specs.Roots\nopen Aeneas Aeneas.Std Result\n' + statement + '\n', cited: [{ path: 'Specs/Roots.lean', start: 1, end: 17 }], ...chaining });
}

test('E1 revises H through the exported packet, a fresh reviewer assignment and the paired registry transition', { skip }, async () => {
  const w = await setup(), before = registryStatus(w);
  // Every step carries the engine's v2 basis (validated whenever present), as it must once E0's acceptances are stale.
  const r = await reviseH(w, { chain: true });
  assert.ok(r.basis?.version === 2, 'each review returns the basis for its successor');
  assert.equal(r.previous, before.nodes['19'].head);
  assert.equal(r.published.recorded.status, 'facts-recorded-partial');
  assert.equal(r.published.raw.record.state, 'machine-reviewed-provisional');
  const after = registryStatus(w);
  assert.notEqual(after.registryHeadSha256, before.registryHeadSha256);
  assert.equal(after.nodes['19'].state, 'machine-reviewed-provisional');
  assert.equal(git(w.source().root, 'status', '--porcelain=v1', '--untracked-files=all'), '', 'review drafts stay git-ignored');
  assert.deepEqual([after.nodes['20'].state, after.nodes['21'].state], ['needs-semantic-review', 'needs-semantic-review'], 'consumers of a revised helper need fresh review');
  // Unchanged consumer contracts receive fresh reviews against the revised helper; the freeze needs all three current.
  const a = await reviewUnchanged(w, 20, 'theorem root_sum_eq : \u2200 (p : m1demo.Pair), m1demo.root_sum p = m1demo.helper p := by sorry', { basis: r.basis });
  await reviewUnchanged(w, 21, 'theorem root_twice_eq : \u2200 (p : m1demo.Pair), m1demo.root_twice p = (do let i \u2190 m1demo.helper p; i * 2#u32) := by sorry', { basis: a.basis });
  const ready = registryStatus(w);
  // Freeze readiness: every node machine-reviewed or awaiting only a proof recheck after unchanged semantic inputs.
  assert.equal(ready.nodes['19'].state, 'machine-reviewed-provisional');
  for (const n of ['20', '21']) assert.ok(['machine-reviewed-provisional', 'recheck-required'].includes(ready.nodes[n].state), n + ' ' + ready.nodes[n].state);
  const launches = [...w.auto.readRuntimeState({ projectRoot: w.x.root }).reservations.values()].filter(r => r.intent.effect.kind === 'ao-launch');
  assert.equal(launches.length, 3); assert.ok(launches.every(r => r.state === 'closed'), 'every reviewer reservation is closed; no open node reservation remains');
  console.log('E1 freeze readiness:', JSON.stringify(Object.fromEntries(Object.entries(ready.nodes).map(([k, v]) => [k, v.state]))));
});

// E0 readiness without Lean: the F0 request (pristine C0, no overlays, G0 registry) is admitted by the engine's paired
// freeze validation. The producer (the first real build) is not run here.
test('F0 freeze request at C0 is admitted by the paired transition validation (no build)', { skip }, async () => {
  const w = await setup(), request = freezeRequest(w, cfg.materials), job = w.t.transitionBound(request);
  assert.deepEqual(job.overlayFiles, []); assert.equal(job.registry.headSha256, cfg.materials.registry.headSha256);
  assert.deepEqual(job.extraction.identity, w.inputs.extraction); assert.deepEqual(job.baseline.source, w.source());
  // A refused before records no transition (paired's opening reconcile may still commit an observation), so the same
  // world then admits the exact request.
  const befores = () => w.auto.readRuntimeState({ projectRoot: w.x.root }).state.history.filter(r => r.event.position === 'before' && r.event.intent?.request && w.t.readTransitionAction(r.event.intent.request).kind === 'freeze').length, start = befores();
  const variant = patch => { const v = structuredClone(job); patch(v); return { file: request.file + '-' + crypto.randomUUID() + '.json', value: v }; };
  for (const [label, patch] of [['stale registry head', v => { v.registry.headSha256 = '0'.repeat(64); }], ['other source tree', v => { v.baseline.source.expectedTree = '0'.repeat(40); }],
    ['fresh execution control', v => { v.execution = w.e.createExecution('d-other-run-' + crypto.randomUUID(), { kind: 'none' }); }]]) {
    const { file, value } = variant(patch); fs.writeFileSync(file, JSON.stringify(value));
    await assert.rejects(admitFreeze(w, { file, sha256: sha(fs.readFileSync(file)) }), { code: 'transition-target-stale' }, label);
    assert.equal(befores(), start, label + ' recorded no before');
  }
  assert.equal(await admitFreeze(w, request), true);
  assert.equal(befores(), start + 1, 'exactly the admitted freeze before is recorded');
});

// Real Lean (explicit allocation only): E0 = F0 freeze, one provisional check, accept H then A and B.
// Evidence is retained: an explicit new run root outside the OS temporary directory, never cleaned up here, and the
// engine is the pinned commit with a clean tree.
async function realWorld() {
  const runRoot = process.env.FVS_D_RUN_ROOT, pinned = process.env.FVS_D_ENGINE_COMMIT, tmp = fs.realpathSync(os.tmpdir());
  assert.ok(runRoot && path.isAbsolute(runRoot) && !fs.existsSync(runRoot) && !(path.resolve(runRoot) + path.sep).startsWith(tmp + path.sep), 'FVS_D_RUN_ROOT must be a new absolute path outside the temporary directory');
  assert.equal(git(ROOT, 'rev-parse', 'HEAD'), pinned, 'FVS_D_ENGINE_COMMIT must name the checked-out engine');
  assert.equal(git(ROOT, 'status', '--porcelain=v1', '--untracked-files=all'), '', 'pinned engine tree must be clean');
  fs.mkdirSync(runRoot, { recursive: true }); const base = fs.realpathSync(runRoot);
  const w = await dWorld({ engineRoot: ROOT, base, materials: cfg.materials, bd: cfg.bd });
  fs.writeFileSync(path.join(base, 'engine.json'), JSON.stringify({ commit: pinned, tree: git(ROOT, 'rev-parse', 'HEAD^{tree}'), root: ROOT, startedAt: new Date().toISOString() }) + '\n');
  return w;
}
const realSkip = skip || (process.env.FVS_REAL_RESPEC_D !== '1' && 'real Lean run requires FVS_REAL_RESPEC_D=1 and an owner allocation');

test('E0 real: F0 freeze, check and canonical acceptance of H, A, B (FVS_REAL_RESPEC_D=1)', { skip: realSkip }, async () => {
  const w = await realWorld(), r = await runE0(w, cfg.materials), store = w.ca.readAcceptedStore(r.storeRoot);
  assert.deepEqual(store.records.map(x => x.record.node), [19, 20, 21]);
  assert.ok(store.records.every(x => x.record.authority === 'canonical-checker' && x.record.integrated.commit === cfg.materials.c0.commit));
  console.log('E0 receipts:', JSON.stringify({ storeRoot: r.storeRoot, head: store.headSha256, baseline: w.inputs.baseline }));
});

// E0 then E1 in one run (the E0 acceptances go stale once H is revised, so E1 carries the v2 basis chain throughout).
const FIX = path.join(__dirname, 'fixtures', 'd-respec');
const OVERLAY_V1 = { file: 'Specs/CheckerOverlayV1.lean', wrong: path.join(FIX, 'CheckerOverlayV1.wrong-lemma.lean'), correct: path.join(FIX, 'CheckerOverlayV1.lean'),
  target: { node: 19, module: 'Specs.CheckerOverlayV1', name: 'm1demo.overlay.v1.helper_eq_sum', contextFile: 'Specs/Roots.lean' } };
function e1Reviews(w) {
  const roots = fs.readFileSync(path.join(w.source().root, 'Specs/Roots.lean')), cited = [{ path: 'Specs/Roots.lean', start: 1, end: 17 }], head = 'import Specs.Roots\nopen Aeneas Aeneas.Std Result\n';
  const author = id => ({ session: 'd-scripted-author', harness: 'scripted', model: 'none', runId: id + '-' + crypto.randomUUID() });
  return [
    { contract: { ...g0Contract(19), statement: '∀ (p : m1demo.Pair), m1demo.helper p = p.a + p.b', assumptions: ['Lean-only checker qualification; Rust translation correspondence is not established.'],
      grounding: { kind: 'source', source: 'C0 M1demo/M1demo.lean helper and Specs/Roots.lean context', version: cfg.materials.c0.commit, locator: 'm1demo.helper' },
      specDefinitions: [{ name: 'm1demo.roots (statement context)', file: 'Specs/Roots.lean', sha256: sha(roots) }], author: author('d-e1-revise-h') },
      draft: head + 'theorem helper_eq_sum : ∀ (p : m1demo.Pair), m1demo.helper p = p.a + p.b := by sorry\n', cited },
    { contract: { ...g0Contract(20), author: author('d-e1-review-20') }, draft: head + 'theorem root_sum_eq : ∀ (p : m1demo.Pair), m1demo.root_sum p = m1demo.helper p := by sorry\n', cited },
    { contract: { ...g0Contract(21), author: author('d-e1-review-21') }, draft: head + 'theorem root_twice_eq : ∀ (p : m1demo.Pair), m1demo.root_twice p = (do let i ← m1demo.helper p; i * 2#u32) := by sorry\n', cited },
  ];
}
test('E0+E1 real: revise H, freeze F1, scripted writer to I1, re-accept H, A, B (FVS_REAL_RESPEC_D=1)', { skip: realSkip }, async () => {
  const w = await realWorld(), e0 = await runE0(w, cfg.materials);
  const e1 = await runE1(w, cfg.materials, { storeRoot: e0.storeRoot, basis: e0.basis, reviews: e1Reviews(w), overlay: OVERLAY_V1 });
  const store = w.ca.readAcceptedStore(e0.storeRoot), i1 = w.source(), f1 = w.t.transitionBound(w.inputs.baseline);
  assert.deepEqual(store.records.map(x => x.record.node), [19, 20, 21, 19, 20, 21]);
  assert.ok(store.records.slice(3).every(x => x.record.authority === 'canonical-checker' && x.record.integrated.commit === i1.commit && x.record.frozenSha256 === w.inputs.baseline.sha256));
  assert.deepEqual(f1.overlayFiles, [OVERLAY_V1.file]);
  assert.deepEqual(git(i1.root, 'diff', '--name-only', cfg.materials.c0.commit, i1.commit).split('\n').filter(Boolean), [OVERLAY_V1.file], 'I1 adds only the V1 overlay');
  assert.equal(w.t.readTaskProgress(e1.writer.progress).failedApproaches.length, 1, 'the failed attempt is retained');
  assert.ok([...w.auto.readRuntimeState({ projectRoot: w.x.root }).reservations.values()].filter(r => r.intent.effect.kind === 'ao-launch').every(r => r.state === 'closed'));
  console.log('E1 receipts:', JSON.stringify({ storeRoot: e0.storeRoot, head: store.headSha256, f1: w.inputs.baseline, i1 }));
});
