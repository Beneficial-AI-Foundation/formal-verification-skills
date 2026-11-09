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
const { dWorld, reviseContract, freezeRequest, admitFreeze, runE0, registryStatus, git, sha } = require('./helpers/d-respec-world.cjs');
const ROOT = path.resolve(__dirname, '..');
const cfg = process.env.FVS_D_CONFIG ? JSON.parse(fs.readFileSync(process.env.FVS_D_CONFIG)) : null;
const skip = cfg ? false : 'FVS_D_CONFIG not set (local qualification materials required)';
const owned = [];
after(() => { for (const p of owned) fs.rmSync(p, { recursive: true, force: true }); });
async function setup() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-d-world-'))); owned.push(base);
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
function reviseH(w) {
  const roots = fs.readFileSync(path.join(w.source().root, 'Specs/Roots.lean'));
  const contract = { ...g0Contract(19), statement: '\u2200 (p : m1demo.Pair), m1demo.helper p = p.a + p.b',
    assumptions: ['Lean-only checker qualification; Rust translation correspondence is not established.'],
    grounding: { kind: 'source', source: 'C0 M1demo/M1demo.lean helper and Specs/Roots.lean context', version: cfg.materials.c0.commit, locator: 'm1demo.helper' },
    specDefinitions: [{ name: 'm1demo.roots (statement context)', file: 'Specs/Roots.lean', sha256: sha(roots) }],
    author: { session: 'd-scripted-author', harness: 'scripted', model: 'none', runId: 'd-e1-revise-h-' + crypto.randomUUID() } };
  const draft = 'import Specs.Roots\nopen Aeneas Aeneas.Std Result\ntheorem helper_eq_sum : \u2200 (p : m1demo.Pair), m1demo.helper p = p.a + p.b := by sorry\n';
  return reviseContract(w, { contract, draft, cited: [{ path: 'Specs/Roots.lean', start: 1, end: 17 }] });
}

function reviewUnchanged(w, node, statement) {
  const contract = { ...g0Contract(node), author: { session: 'd-scripted-author', harness: 'scripted', model: 'none', runId: 'd-e1-review-' + node + '-' + crypto.randomUUID() } };
  return reviseContract(w, { contract, draft: 'import Specs.Roots\nopen Aeneas Aeneas.Std Result\n' + statement + '\n', cited: [{ path: 'Specs/Roots.lean', start: 1, end: 17 }] });
}

test('E1 revises H through the exported packet, a fresh reviewer assignment and the paired registry transition', { skip }, async () => {
  const w = await setup(), before = registryStatus(w);
  const r = await reviseH(w);
  assert.equal(r.previous, before.nodes['19'].head);
  assert.equal(r.published.recorded.status, 'facts-recorded-partial');
  assert.equal(r.published.raw.record.state, 'machine-reviewed-provisional');
  const after = registryStatus(w);
  assert.notEqual(after.registryHeadSha256, before.registryHeadSha256);
  assert.equal(after.nodes['19'].state, 'machine-reviewed-provisional');
  assert.equal(git(w.source().root, 'status', '--porcelain=v1', '--untracked-files=all'), '', 'review drafts stay git-ignored');
  assert.deepEqual([after.nodes['20'].state, after.nodes['21'].state], ['needs-semantic-review', 'needs-semantic-review'], 'consumers of a revised helper need fresh review');
  // Unchanged consumer contracts receive fresh reviews against the revised helper; the freeze needs all three current.
  await reviewUnchanged(w, 20, 'theorem root_sum_eq : \u2200 (p : m1demo.Pair), m1demo.root_sum p = m1demo.helper p := by sorry');
  await reviewUnchanged(w, 21, 'theorem root_twice_eq : \u2200 (p : m1demo.Pair), m1demo.root_twice p = (do let i \u2190 m1demo.helper p; i * 2#u32) := by sorry');
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
test('E0 real: F0 freeze, check and canonical acceptance of H, A, B (FVS_REAL_RESPEC_D=1)', { skip: skip || (process.env.FVS_REAL_RESPEC_D !== '1' && 'real Lean run requires FVS_REAL_RESPEC_D=1 and an owner allocation') }, async () => {
  const w = await setup(), r = await runE0(w, cfg.materials), store = w.ca.readAcceptedStore(r.storeRoot);
  assert.deepEqual(store.records.map(x => x.record.node), [19, 20, 21]);
  assert.ok(store.records.every(x => x.record.authority === 'canonical-checker' && x.record.integrated.commit === cfg.materials.c0.commit));
  console.log('E0 receipts:', JSON.stringify({ storeRoot: r.storeRoot, head: store.headSha256, baseline: w.inputs.baseline }));
});
