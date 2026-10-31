'use strict';
const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const SCRIPT = path.resolve(__dirname, '../scripts/fvs-contract-registry.mjs');
const FIX = path.join(__dirname, 'fixtures/auto-contract-registry');
const tmp = [];
let api;
before(async () => { api = await import('../scripts/fvs-contract-registry.mjs'); });
after(() => { for (const dir of tmp) fs.rmSync(dir, { recursive: true, force: true }); });
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (file, data) => { fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data)); return file; };
const wrapped = (file) => ({ json: JSON.parse(fs.readFileSync(file)), sha256: sha(fs.readFileSync(file)) });
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-registry-')); tmp.push(dir);
  for (const file of ['plan.json', 'graph.json']) fs.copyFileSync(path.join(FIX, file), path.join(dir, file));
  write(path.join(dir, 'Defs.lean'), 'def Shared := Nat\ndef Other := Nat\n');
  return { dir, registry: path.join(dir, 'registry'), plan: path.join(dir, 'plan.json'), graph: path.join(dir, 'graph.json'), specRoot: dir };
}
function contract(f, node = 19, patch = {}) {
  return { node, role: node === 19 ? 'helper' : 'root', statement: `m1demo.${node === 19 ? 'helper' : node === 20 ? 'root_sum' : 'root_twice'} = m1demo.${node === 19 ? 'helper' : node === 20 ? 'root_sum' : 'root_twice'}`,
    assumptions: [], grounding: { kind: 'none', reason: 'Labelled registry test, no source correspondence asserted' },
    implementationDependencies: [`probe:m1demo.${node === 19 ? 'helper' : node === 20 ? 'root_sum' : 'root_twice'}`],
    specDefinitions: [{ name: 'Shared', file: 'Defs.lean', sha256: sha(fs.readFileSync(path.join(f.specRoot, 'Defs.lean'))) }],
    externalReferences: [{ name: 'Eq', provenance: { environment: { leanToolchain: 'leanprover/lean4:v4.31.0', lakeManifestSha256: 'a'.repeat(64) } } }],
    author: { session: 'fixture-author', harness: 'fixture', model: 'none', runId: 'author-run' }, ...patch };
}
let serial = 0;
function review(f, c, patch = {}) {
  const plan = wrapped(f.plan), graph = wrapped(f.graph), view = api.validatePlan(plan, graph);
  assert.deepEqual(view.problems, [], 'review generated only from otherwise valid plan');
  const candidate = api.candidateOf(c, api.contextOf(plan, graph, view, c.node));
  const id = ++serial;
  const evidence = write(path.join(f.dir, `review-${id}.md`), `Labelled test evidence for candidate ${candidate}; run ${id}.\n`);
  return { candidateSha256: candidate, registryHeadSha256: api.readChain(f.registry).records.at(-1)?.sha ?? null,
    verdict: 'pass', reviewer: { session: 'fixture-reviewer', harness: 'fixture', model: 'none', runId: `review-run-${id}` }, evidence: { file: evidence, sha256: sha(fs.readFileSync(evidence)) }, ...patch };
}
function args(f, command, c, r, previous) {
  const argv = [SCRIPT, command, '--plan', f.plan, '--graph', f.graph, '--registry', f.registry, '--spec-root', f.specRoot];
  if (c) argv.push('--contract', write(path.join(f.dir, `contract-${++serial}.json`), c));
  if (r) argv.push('--review', write(path.join(f.dir, `review-${++serial}.json`), r));
  if (previous) argv.push('--previous', previous);
  return argv;
}
function invoke(argv, options = {}) {
  const out = spawnSync(process.execPath, argv, { encoding: 'utf8', ...options });
  assert.equal(out.signal, null, out.stderr);
  return { exit: out.status, result: JSON.parse(out.stdout) };
}
const run = (f, command, c, r, previous) => invoke(args(f, command, c, r, previous));
function register(f, node, patch) {
  const c = contract(f, node, patch), r = review(f, c);
  const out = run(f, 'register', c, r); assert.equal(out.exit, 0, out.result.message); return out.result;
}
function mutatePlan(f, change) { const p = wrapped(f.plan).json; change(p); write(f.plan, p); }
function mutateGraph(f, change) { const g = wrapped(f.graph).json; change(g); write(f.graph, g); mutatePlan(f, (p) => { p.inputs.graphSha256 = sha(fs.readFileSync(f.graph)); }); }
function graphEdges(g) {
  g.edges = Object.entries(g.nodes).flatMap(([from, n]) => [['type', 'type'], ['value', 'term']].flatMap(([lane, kind]) => n[lane].map((to) => ({ from, to, kind,
    resolution: !Object.hasOwn(g.nodes, to) ? 'external' : g.nodes[to].probeAtom ? 'local' : 'generated' }))));
}
function disjoint(f) {
  // Labelled graph AND plan mutation: these roots really have no helper dependency.
  mutateGraph(f, (g) => { for (const id of ['probe:m1demo.root_sum', 'probe:m1demo.root_twice']) { g.nodes[id].type = []; g.nodes[id].value = []; } graphEdges(g); });
  mutatePlan(f, (p) => {
    for (const id of [20, 21]) {
      Object.assign(p.nodes[id], { dependsOn: [], generatedDependencies: [], typeDependencies: [], dependencyPaths: {} });
      Object.assign(p.roots.find((r) => r.defId === id), { closure: [id], definitionClosure: [...p.nodes[id].declarations] });
    }
    p.nodes[19].sharedBy = []; p.nodes[19].ownerRoot = null;
  });
}
function blockedHelper(f, eligibility) {
  mutatePlan(f, (p) => {
    p.nodes[19].eligibility = eligibility; p.selection.failed = eligibility === 'failed' ? [19] : []; p.status = 'partial';
    p.roots.forEach((r) => { r.status = 'blocked'; p.nodes[r.defId].eligibility = 'blocked-by-dependency'; });
  });
}
function state(f) { const out = run(f, 'status'); assert.equal(out.exit, 0, out.result.message); return out.result.nodes; }
function appendChild(argv) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = '';
    p.stdout.on('data', (b) => { out += b; }); p.stderr.on('data', (b) => { err += b; }); p.on('error', reject);
    p.on('close', (exit) => { try { resolve({ exit, result: JSON.parse(out) }); } catch (error) { reject(new Error(err || error.message)); } });
  });
}

describe('contract registry: recorded paired fixture and declared reviews', () => {
  it('retains the exact reviewed plan and graph bytes', () => {
    assert.equal(sha(fs.readFileSync(path.join(FIX, 'plan.json'))), 'f3a57d76661f76388eb45a07148b5ddda392fdd783149a41eb8c776bd687d83e');
    assert.equal(sha(fs.readFileSync(path.join(FIX, 'graph.json'))), 'd653bfda8a94ebbead3b9ae74bf49c9766502d3d5342850bdfcae5390bbeacbd');
  });
  it('records the real helper and both roots with global and per-node chains', () => {
    const f = setup(); const records = [19, 20, 21].map((id) => register(f, id));
    for (const [index, r] of records.entries()) {
      assert.equal(r.record.seq, index); assert.equal(r.record.prev, index ? records[index - 1].recordSha256 : null);
      assert.equal(r.record.previousForNode, null); assert.equal(r.record.state, 'machine-reviewed-provisional');
      assert.deepEqual(r.record.independence, { basis: 'declared-distinct-session-and-run', verified: false });
      assert.equal(r.record.durability, 'process-crash-consistent');
    }
    assert.ok(!records[0].record.binding.implementationClosure.includes('probe:m1demo.root_sum'), 'helper uses its own closure');
    assert.ok(records[0].record.binding.implementationClosure.includes('probe:m1demo.Pair.mk'));
    assert.equal(Object.keys(state(f)).length, 3);
  });
  for (const [label, change] of [
    ['same session', (r, c) => { r.reviewer.session = c.author.session; }],
    ['same run', (r, c) => { r.reviewer.runId = c.author.runId; }],
    ['wrong candidate', (r) => { r.candidateSha256 = '0'.repeat(64); }],
    ['tampered evidence', (r) => { fs.appendFileSync(r.evidence.file, 'changed'); }],
  ]) it(`refuses ${label} as the sole review defect`, () => {
    const f = setup(), c = contract(f), r = review(f, c); change(r, c);
    assert.equal(run(f, 'register', c, r).exit, 7); assert.equal(api.readChain(f.registry).records.length, 0);
  });
  it('refuses review reuse for a different candidate', () => {
    const f = setup(); const c = contract(f), r = review(f, c); const head = run(f, 'register', c, r).result.recordSha256;
    const next = contract(f, 19, { assumptions: ['new assumption'] }); const fresh = review(f, next);
    fresh.reviewer.runId = r.reviewer.runId;
    assert.match(run(f, 'revise', next, fresh, head).result.message, /already used/);
    const fresh2 = review(f, next); fresh2.evidence = r.evidence;
    assert.match(run(f, 'revise', next, fresh2, head).result.message, /already used/);
  });
  it('records changes-requested roots as blocked without claiming approval', () => {
    const f = setup(), c = contract(f, 20), r = review(f, c, { verdict: 'changes-requested' });
    const out = run(f, 'register', c, r); assert.equal(out.exit, 6); assert.equal(out.result.record.blocked, true);
    assert.equal(state(f)[20].state, 'changes-requested');
  });
});

describe('contract registry: revisions and semantic invalidation', () => {
  it('identical semantic inputs request recheck of the changed node and consumers', () => {
    const f = setup(); const helper = register(f, 19); register(f, 20); register(f, 21);
    const c = contract(f, 19, { proofOnly: false });
    const out = run(f, 'revise', c, null, helper.recordSha256);
    assert.equal(out.exit, 6); assert.equal(out.result.record.changeClass, 'unchanged-semantic-inputs');
    assert.deepEqual(out.result.record.invalidates.map((e) => e.defId), [19, 20, 21]);
    assert.deepEqual(Object.values(state(f)).map((n) => n.state), ['recheck-required', 'recheck-required', 'recheck-required']);
  });
  for (const [label, patch] of [
    ['statement', { statement: 'True', proofOnly: true }],
    ['assumption removal', { assumptions: [] }],
    ['grounding', { grounding: { kind: 'source', source: 'RFC fixture', version: '2', locator: 'section 1' } }],
    ['external provenance', { externalReferences: [{ name: 'Eq', provenance: { source: 'Lean', version: 'changed', locator: 'Init' } }] }],
  ]) it(`${label} changes require fresh review, even with a caller proofOnly flag`, () => {
    const f = setup(); const before = contract(f, 19, { assumptions: ['explicit assumption'] });
    const h = run(f, 'register', before, review(f, before)).result.recordSha256;
    const c = { ...before, ...patch };
    const staleReview = review(f, before);
    assert.equal(run(f, 'revise', c, staleReview, h).exit, 7);
    const pending = run(f, 'revise', c, null, h); assert.equal(pending.exit, 6);
    assert.equal(pending.result.record.state, 'needs-semantic-review');
    const approved = run(f, 'revise', c, review(f, c), pending.result.recordSha256);
    assert.equal(approved.result.record.state, 'recheck-required', 'same semantic candidate still requires the checker');
  });
  it('first contracts without review are needs-review; a reviewed semantic revision is provisional', () => {
    const f = setup(), c = contract(f); const pending = run(f, 'register', c, null);
    assert.equal(pending.exit, 6); assert.equal(pending.result.record.state, 'needs-review');
    const changed = { ...c, statement: 'True' };
    assert.equal(run(f, 'revise', changed, review(f, changed), pending.result.recordSha256).result.record.state, 'machine-reviewed-provisional');
  });
  it('an unchanged append cannot clear an unresolved first review', () => {
    const f = setup(), c = contract(f), pending = run(f, 'register', c, null);
    const again = run(f, 'revise', c, null, pending.result.recordSha256);
    assert.equal(again.result.record.state, 'needs-review');
  });
  it('an invalidated consumer needs fresh review even if its own candidate is unchanged', () => {
    const f = setup(); const helper = register(f, 19), c = contract(f, 20, { implementationDependencies: ['probe:m1demo.helper'] }), oldReview = review(f, c);
    const root = run(f, 'register', c, oldReview);
    const changed = contract(f, 19, { statement: 'True' });
    run(f, 'revise', changed, review(f, changed), helper.recordSha256);
    assert.equal(state(f)[20].state, 'needs-semantic-review');
    const noReview = run(f, 'revise', c, null, root.result.recordSha256);
    assert.equal(noReview.result.record.state, 'needs-semantic-review');
    assert.equal(run(f, 'revise', c, oldReview, noReview.result.recordSha256).exit, 7);
    assert.equal(run(f, 'revise', c, review(f, c), noReview.result.recordSha256).result.record.state, 'recheck-required');
  });
  for (const existingRoot of [true, false]) it(`rejects an unused pre-helper-change review for ${existingRoot ? 'an existing root' : 'first root registration'}`, () => {
    const f = setup(), helper = register(f, 19), c = contract(f, 20, { implementationDependencies: ['probe:m1demo.helper'] });
    const root = existingRoot ? run(f, 'register', c, review(f, c)) : null;
    const delayed = review(f, c); // Valid, distinct and not yet recorded anywhere.
    const changed = contract(f, 19, { statement: 'True' });
    assert.equal(run(f, 'revise', changed, review(f, changed), helper.recordSha256).exit, 0);
    const command = existingRoot ? 'revise' : 'register', previous = root?.result.recordSha256;
    assert.match(run(f, command, c, delayed, previous).result.message, /registry head is stale/);
    if (existingRoot) assert.equal(state(f)[20].state, 'needs-semantic-review');
    const fresh = run(f, command, c, review(f, c), previous);
    assert.equal(fresh.result.record.state, existingRoot ? 'recheck-required' : 'machine-reviewed-provisional');
  });
  it('conservatively rejects an unused review after an unrelated append; a fresh packet succeeds', () => {
    const f = setup(); register(f, 19); const c = contract(f, 20), delayed = review(f, c);
    register(f, 21);
    assert.match(run(f, 'register', c, delayed).result.message, /registry head is stale/);
    assert.equal(run(f, 'register', c, review(f, c)).exit, 0);
  });
  it('checks the review context under the lock after a concurrent helper commit', async () => {
    const f = setup(), helper = register(f, 19), c = contract(f, 20, { implementationDependencies: ['probe:m1demo.helper'] });
    const root = run(f, 'register', c, review(f, c)), delayed = review(f, c), changed = contract(f, 19, { statement: 'True' });
    const barrier = path.join(f.dir, 'helper-committed');
    const hook = write(path.join(f.dir, 'wait-for-helper.mjs'), `import fs from 'node:fs';
const mkdir=fs.mkdirSync; fs.mkdirSync=function(file,...rest){ if(String(file).endsWith('/lock')) { let n=0; while(!fs.existsSync(${JSON.stringify(barrier)})) { if(++n>200)throw new Error('helper barrier timed out'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50); } } return mkdir.call(this,file,...rest); };\n`);
    const pending = appendChild(['--import', hook, ...args(f, 'revise', c, delayed, root.result.recordSha256)]);
    try {
      assert.equal((await appendChild(args(f, 'revise', changed, review(f, changed), helper.recordSha256))).exit, 0);
    } finally { write(barrier, 'committed'); }
    const refused = await pending; assert.equal(refused.exit, 7); assert.match(refused.result.message, /registry head is stale/);
    assert.equal(state(f)[20].state, 'needs-semantic-review');
    assert.equal(run(f, 'revise', c, review(f, c), root.result.recordSha256).result.record.state, 'recheck-required');
  });
  it('a shared definition revision reaches disjoint roots; semantic review wins over recheck', () => {
    const f = setup();
    disjoint(f);
    const first = register(f, 20); register(f, 21);
    fs.appendFileSync(path.join(f.specRoot, 'Defs.lean'), '-- changed bytes\n');
    const c = contract(f, 20); const out = run(f, 'revise', c, review(f, c), first.recordSha256);
    assert.equal(out.exit, 0); assert.equal(state(f)[21].state, 'needs-semantic-review');
    assert.ok(out.result.record.invalidates.some((e) => e.defId === 21 && e.effect === 'needs-semantic-review'));
  });
  it('actual definition bytes affect every direct user and all consumers, with no state downgrade', () => {
    const f = setup(); register(f, 19); register(f, 20, { specDefinitions: [] }); register(f, 21, { specDefinitions: [{ name: 'Other', file: 'Defs.lean', sha256: sha(fs.readFileSync(path.join(f.specRoot, 'Defs.lean'))) }] });
    fs.appendFileSync(path.join(f.specRoot, 'Defs.lean'), '-- whole-file change\n');
    const s = state(f); assert.equal(s[19].state, 'needs-semantic-review'); assert.equal(s[20].state, 'recheck-required'); assert.equal(s[21].state, 'needs-semantic-review');
  });
});

describe('contract registry: sole-reason input refusals and current status', () => {
  for (const [label, change] of [
    ['implementation outside helper closure', (c) => { c.implementationDependencies = ['probe:m1demo.root_sum']; }],
    ['spec hash absent', (c) => { delete c.specDefinitions[0].sha256; }],
    ['spec byte mismatch', (c) => { c.specDefinitions[0].sha256 = '0'.repeat(64); }],
    ['spec path escape', (c) => { c.specDefinitions[0].file = '../Defs.lean'; }],
    ['missing spec file', (c) => { c.specDefinitions[0].file = 'Missing.lean'; }],
    ['external unbound', (c) => { c.externalReferences[0].provenance = {}; }],
    ['grounding missing', (c) => { delete c.grounding; }],
    ['source version missing', (c) => { c.grounding = { kind: 'source', source: 'fixture', locator: '1' }; }],
    ['source locator missing', (c) => { c.grounding = { kind: 'source', source: 'fixture', version: '1' }; }],
    ['assumptions missing', (c) => { delete c.assumptions; }],
    ['wrong role', (c) => { c.role = 'root'; }],
  ]) it(`refuses ${label}`, () => { const f = setup(), c = contract(f); change(c); assert.equal(run(f, 'register', c, null).exit, 7); });
  it('refuses a symlink outside the explicit spec root', () => {
    const f = setup(), other = setup(), c = contract(f); fs.symlinkSync(path.join(other.dir, 'Defs.lean'), path.join(f.dir, 'Link.lean'));
    c.specDefinitions[0].file = 'Link.lean'; assert.equal(run(f, 'register', c, null).exit, 7);
  });
  for (const [label, change] of [
    ['admissible with blockers', (p) => { p.admissibility.blockers = ['contradiction']; }],
    ['schema 1', (p) => { p.qualification.graphSchemaVersion = 1; }],
    ['unknown endpoint', (p) => { p.nodes[19].dependsOn = [999]; }],
    ['fabricated closure', (p) => { p.roots[0].closure = [20]; }],
    ['wrong sharedBy', (p) => { p.nodes[19].sharedBy = [20]; }],
    ['wrong owner', (p) => { p.nodes[19].ownerRoot = 21; }],
    ['ready with failed helper', (p) => { p.nodes[19].eligibility = 'failed'; }],
    ['family not probe atom', (p) => { p.nodes[19].declarations = ['probe:m1demo.Pair.mk']; }],
    ['duplicate family', (p) => { p.nodes[20].declarations = p.nodes[19].declarations; }],
  ]) it(`refuses inconsistent plan: ${label}`, () => {
    const f = setup(); mutatePlan(f, change); assert.equal(run(f, 'register', contract(f), null).exit, 7);
  });
  for (const [label, change] of [
    ['unbound', (g) => { g.binding.status = 'unbound'; }],
    ['complete with blockers', (g) => { g.blockers.push('contradiction'); }],
    ['verified with obligations', (g) => { g.fidelity.obligations.push('contradiction'); }],
    ['wrong capability', (g) => { g.capability = 'other'; }],
    ['malformed lane', (g) => { g.nodes['probe:m1demo.helper'].value = null; }],
    ['inconsistent lanes and edges', (g) => { g.nodes['probe:m1demo.root_sum'].value = []; }],
    ['missing published Lean', (g) => { g.binding.generatedLean = []; }],
  ]) it(`refuses graph ${label} even when its bytes match the plan hash`, () => { const f = setup(); mutateGraph(f, change); assert.equal(run(f, 'register', contract(f), null).exit, 7); });
  it('refuses unknown and out-of-scope eligible nodes', () => {
    const f = setup(); assert.equal(run(f, 'register', contract(f, 999), null).exit, 7);
    disjoint(f);
    assert.match(run(f, 'register', contract(f), null).result.message, /outside/);
  });
  for (const eligibility of ['recursion-unqualified', 'failed', 'unknown']) it(`refuses ${eligibility} without an unrelated consistency defect`, () => {
    const f = setup(); blockedHelper(f, eligibility);
    assert.match(run(f, 'register', contract(f), null).result.message, /unsupported/);
  });
  it('reports current eligibility/scope changes as stale and unchanged semantic context as recheck', () => {
    const f = setup(); register(f, 19);
    fs.appendFileSync(f.plan, '\n'); assert.equal(state(f)[19].state, 'recheck-required');
    blockedHelper(f, 'failed');
    assert.equal(state(f)[19].state, 'stale');
  });
  it('reports a changed plan binding as stale, even with unchanged spec bytes', () => {
    const f = setup(); register(f, 19); mutatePlan(f, (p) => { p.inputs.identitySha256 = 'f'.repeat(64); });
    assert.equal(state(f)[19].state, 'stale');
  });
  it('rejects coordinated dependency, closure, sharing and owner deletion against an unchanged graph', () => {
    const f = setup(); register(f, 19); register(f, 20); register(f, 21);
    mutatePlan(f, (p) => {
      p.selection.requestedRoots = [19, 20, 21];
      p.roots = [19, 20, 21].map((id) => ({ defId: id, rustName: p.nodes[id].rustName, status: 'ready', closure: [id], blockers: [] }));
      for (const id of [19, 20, 21]) Object.assign(p.nodes[id], { dependsOn: [], sharedBy: [id], ownerRoot: id });
    });
    const out = run(f, 'revise', contract(f, 19, { role: 'root' }), null, state(f)[19].head);
    assert.equal(out.exit, 7); assert.match(out.result.message, /bound graph's scheduling expansion/);
    const status = run(f, 'status'); assert.equal(status.result.consistent, false);
    assert.ok(Object.values(status.result.nodes).every((n) => n.state === 'stale'));
  });
  it('uses both scheduling lanes, generated pass-through and structure-member expansion', () => {
    for (const mode of ['type', 'generated', 'structure']) {
      const f = setup();
      mutateGraph(f, (g) => {
        const root = g.nodes['probe:m1demo.root_sum'];
        if (mode === 'type') { root.value = root.value.filter((id) => id !== 'probe:m1demo.helper'); root.type.push('probe:m1demo.helper'); }
        if (mode === 'generated') {
          root.value = root.value.map((id) => id === 'probe:m1demo.helper' ? 'probe:fixture.generated' : id);
          g.nodes['probe:fixture.generated'] = { kind: 'def', source: false, probeAtom: false, type: [], value: ['probe:m1demo.helper'], axioms: [] };
          g.trust['probe:fixture.generated'] = [];
        }
        if (mode === 'structure') g.nodes['probe:m1demo.Pair.a'].value.push('probe:m1demo.root_sum');
        graphEdges(g);
      });
      if (mode === 'structure') assert.match(run(f, 'register', contract(f), null).result.message, /scheduling expansion/);
      else {
        assert.equal(run(f, 'register', contract(f), null).exit, 6);
        mutatePlan(f, (p) => { p.nodes[20].dependsOn = []; p.roots[0].closure = [20]; p.nodes[19].sharedBy = [21]; p.nodes[19].ownerRoot = 21; });
        assert.match(run(f, 'register', contract(f, 20), null).result.message, /scheduling expansion/);
      }
    }
  });
  it('rejects eligibility that omits failure propagation from the bound graph', () => {
    const f = setup(); blockedHelper(f, 'failed');
    mutatePlan(f, (p) => { p.nodes[20].eligibility = 'eligible'; });
    assert.match(run(f, 'register', contract(f, 20), null).result.message, /graph\/failure expansion/);
  });
});

describe('contract registry: atomic expected-head publication and replay', () => {
  it('refuses overwrite, stale predecessor and predecessor from a different node', () => {
    const f = setup(); const h = register(f, 19), root = register(f, 20), c = contract(f), r = review(f, c);
    assert.equal(run(f, 'register', c, r).exit, 7);
    assert.equal(run(f, 'revise', c, r, root.recordSha256).exit, 7);
    const next = run(f, 'revise', c, r, h.recordSha256); assert.equal(next.exit, 6);
    assert.equal(run(f, 'revise', c, r, h.recordSha256).exit, 7);
    assert.equal(api.readChain(f.registry).records.length, 3);
  });
  it('commits at most one concurrent append from the same node head', async () => {
    const f = setup(), h = register(f, 19), c = contract(f);
    const argv = args(f, 'revise', c, review(f, c), h.recordSha256);
    const out = await Promise.all([appendChild(argv), appendChild(argv)]);
    assert.equal(out.filter((r) => r.exit === 6).length, 1);
    assert.equal(out.filter((r) => [7, 8].includes(r.exit)).length, 1);
    assert.equal(api.readChain(f.registry).records.length, 2);
  });
  it('leftover lock or temporary record makes all current states pending', () => {
    const f = setup(); register(f, 19); fs.mkdirSync(path.join(f.registry, 'lock'));
    assert.equal(run(f, 'status').exit, 8); assert.deepEqual(run(f, 'status').result.nodes, {});
    fs.rmdirSync(path.join(f.registry, 'lock')); write(path.join(f.registry, '.tmp-interrupted'), '{}');
    assert.equal(run(f, 'status').exit, 8);
  });
  for (const mode of ['truncated', 'hash', 'fork', 'previousForNode']) it(`rejects a ${mode} chain`, () => {
    const f = setup(); register(f, 19); register(f, 20); const dir = path.join(f.registry, 'records'), names = fs.readdirSync(dir).sort();
    const file = path.join(dir, names[1]), r = JSON.parse(fs.readFileSync(file));
    if (mode === 'truncated') fs.writeFileSync(file, '{');
    if (mode === 'hash') fs.appendFileSync(file, ' ');
    if (mode === 'fork') { r.seq = 0; r.prev = null; }
    if (mode === 'previousForNode') r.previousForNode = 'f'.repeat(64);
    if (['fork', 'previousForNode'].includes(mode)) {
      const bytes = `${JSON.stringify(r)}\n`; fs.unlinkSync(file); write(path.join(dir, `${String(r.seq).padStart(6, '0')}-${sha(bytes)}.json`), bytes);
    }
    assert.equal(run(f, 'status').exit, 8);
  });
  for (const stage of ['write', 'rename', 'directory-fsync']) it(`failure at ${stage} leaves pending state and complete history only`, () => {
    const f = setup(); register(f, 19); const c = contract(f, 20), argv = args(f, 'register', c, review(f, c));
    const hook = write(path.join(f.dir, 'fault.mjs'), `import fs from 'node:fs';\nconst original = fs.${stage === 'write' ? 'writeFileSync' : stage === 'rename' ? 'renameSync' : 'fsyncSync'};\nlet calls=0; fs.${stage === 'write' ? 'writeFileSync' : stage === 'rename' ? 'renameSync' : 'fsyncSync'} = function(...args) { if (${stage === 'directory-fsync' ? '++calls === 2' : 'true'}) throw new Error('injected publication failure'); return original.apply(this,args); };\n`);
    const out = invoke(['--import', hook, ...argv]); assert.equal(out.exit, 2); assert.match(out.result.message, /injected/);
    assert.equal(run(f, 'status').exit, 8);
    // Inspect history under the retained lock, never remove a recovery marker to claim success.
    const names = fs.readdirSync(path.join(f.registry, 'records'));
    assert.equal(names.length, stage === 'directory-fsync' ? 2 : 1);
    for (const name of names) assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(f.registry, 'records', name))));
  });
});
