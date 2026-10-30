'use strict';

// Ticket 13: the join of ticket 10's Rust identity record and ticket 21's Lean
// graph record, and the union closure of requested roots with one owner per
// shared helper. The positive and recursion inputs are recorded outputs of real
// runs (fixtures/auto-closure-plan); every other case is a labelled mutation of
// them. Graph mutations change the declarations' dependency lists and the edge
// list together, the graph's two representations. No tool runs here.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'fvs-closure-plan.mjs');
const FIXTURES = path.join(__dirname, 'fixtures', 'auto-closure-plan');
const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

const scratch = () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fvs-closure-'));
  temporaryDirectories.push(dir);
  return dir;
};
const read = (run, name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, run, name), 'utf8'));
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const llbcText = (run) => zlib.gunzipSync(fs.readFileSync(path.join(FIXTURES, run, 'm1demo.llbc.gz'))).toString('utf8');

// Writes the (possibly mutated) records of RUN and plans ROOTS; returns { status, result }.
// The recorded positive graph predates ticket 21's fidelity check, so the algorithm cases add a
// verified fidelity result to it (labelled mutation); rawGraph keeps the recorded bytes' meaning.
const verified = (g) => ({ ...g, fidelity: { status: 'verified', represented: [], obligations: [] } });
function plan(run, { identity = (x) => x, graph = (x) => x, llbc = null, roots = [21, 22, 23], failed = null, rawGraph = false } = {}) {
  const dir = scratch();
  const write = (name, value) => { const file = path.join(dir, name); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  const args = [SCRIPT, 'plan', '--identity', write('identity.json', identity(read(run, 'identity-record.json'))),
    '--graph', write('graph.json', graph(rawGraph || run !== 'positive' ? read(run, 'graph-record.json') : verified(read(run, 'graph-record.json')))), '--roots', roots.join(',')];
  if (failed) args.push('--failed', failed.join(','));
  if (llbc) args.push('--llbc', write('m1demo.llbc', llbc));
  const out = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { status: out.status, result: JSON.parse(out.stdout) };
}
const root = (result, id) => result.record.roots.find((entry) => entry.defId === id);
// Adds a local term dependency to the declaration and to the edge list together.
const addDependency = (graph, from, to) => {
  graph.declarations[from]['term-dependencies'].push(to);
  graph.declarations[from].dependencies = [...(graph.declarations[from].dependencies ?? []), to];
  graph.edges.push({ from, to, kind: 'term', resolution: 'local' });
  return graph;
};
const nonExact = (defId, reasons, correspondence = 'unsupported') => (identity) => {
  const item = identity.items.find((entry) => entry.defId === defId);
  item.correspondence = correspondence;
  item.reasons = reasons;
  identity.status = 'partial';
  return identity;
};

describe('closure plan: recorded positive (two roots, one shared helper, a loop, an independent root)', () => {
  it('joins the two bound records and makes every requested root ready, with one owner for the shared helper', () => {
    const { status, result } = plan('positive', { llbc: llbcText('positive') });
    assert.equal(status, 0);
    assert.equal(result.code, 'ok');
    const rec = result.record;
    assert.equal(rec.admissibility.status, 'admissible');
    assert.equal(rec.qualification.graphFidelity, 'verified', 'labelled mutation: verified fidelity supplied');
    assert.deepEqual(rec.selection, { requestedRoots: [21, 22, 23], failed: [] });
    assert.deepEqual(root(result, 21).closure, [19, 21]);
    assert.deepEqual(root(result, 22).closure, [19, 20, 22]);
    assert.deepEqual(root(result, 23).closure, [23]);
    assert.deepEqual(rec.nodes[19].sharedBy, [21, 22]);
    assert.equal(rec.nodes[19].ownerRoot, 21);
    assert.match(rec.ownership.rule, /lowest-numbered requested root/);
    assert.deepEqual(rec.nodes[22].dependsOn, [19, 20], 'consumer -> dependency, as declared');
    assert.deepEqual(rec.nodes[20].declarations.sort(), ['probe:m1demo.sum_to', 'probe:m1demo.sum_to_loop', 'probe:m1demo.sum_to_loop.body']);
    assert.deepEqual(rec.nodes[19].recursionGroup, { kind: 'NonRec', members: [19] });
    assert.deepEqual(rec.observedCycles, []);
  });

  it('blocks the recorded positive as it is: a pre-fidelity graph record has unverified dependencies', () => {
    const { status, result } = plan('positive', { rawGraph: true });
    assert.equal(status, 7);
    assert.ok(result.record.admissibility.blockers.some((b) => b.code === 'graph-fidelity-not-verified'));
    assert.match(result.record.qualification.graphFidelity, /not-supplied/);
    assert.ok(result.record.roots.every((r) => r.status === 'blocked' && r.closure === null));
  });

  it('accepts verified fidelity with no open obligations, and blocks any other status or a verified claim with obligations', () => {
    const ok = plan('positive', { graph: (g) => ({ ...g, fidelity: { status: 'verified', represented: [], obligations: [] } }) });
    assert.equal(ok.status, 0);
    assert.equal(ok.result.record.qualification.graphFidelity, 'verified');
    for (const status of ['unverified', 'incomplete']) {
      const { result } = plan('positive', { graph: (g) => ({ ...g, fidelity: { status, represented: [], obligations: [] } }) });
      assert.ok(result.record.admissibility.blockers.some((b) => b.code === 'graph-fidelity-not-verified'), status);
    }
    const open = [{ declaration: 'probe:m1demo.root_a', constant: 'm1demo.helper', obligation: 'proof-dependencies-unaudited' }];
    for (const [label, fidelity] of [['open obligation', { status: 'verified', represented: [], obligations: open }], ['no obligations list', { status: 'verified', represented: [] }]]) {
      const { status, result } = plan('positive', { graph: (g) => ({ ...g, fidelity }) });
      assert.equal(status, 7, label);
      assert.deepEqual(result.record.admissibility.blockers.map((b) => b.code), ['graph-fidelity-contradiction'], label);
    }
  });

  it('blocks the consumers of a failed helper while an independent root stays ready', () => {
    const { status, result } = plan('positive', { failed: [19] });
    assert.equal(status, 6);
    assert.equal(root(result, 21).status, 'blocked');
    assert.equal(root(result, 22).status, 'blocked');
    assert.equal(root(result, 23).status, 'ready');
    assert.equal(result.record.nodes[21].eligibility, 'blocked-by-dependency');
    assert.deepEqual(result.record.selection.failed, [19]);
  });

  it('judges each root by its own closure when the ticket 10 record is partial (labelled mutation)', () => {
    const { status, result } = plan('positive', { identity: nonExact(20, ['mapping-method-not-def-id'], 'fallback-only') });
    assert.equal(status, 6);
    assert.equal(root(result, 21).status, 'ready', 'a disjoint closure keeps its own ready result');
    assert.equal(root(result, 22).status, 'blocked');
    assert.equal(result.record.nodes[20].eligibility, 'blocked-upstream');
    assert.deepEqual(result.record.nodes[20].upstream, { correspondence: 'fallback-only', reasons: ['mapping-method-not-def-id'] }, 'raw upstream kept');
  });
});

describe('closure plan: recursion stays unqualified', () => {
  it('blocks the recorded recursion run (graph incomplete and unbound), keeping the requested roots without a closure', () => {
    const { status, result } = plan('recursion', { llbc: llbcText('recursion'), roots: [22, 23, 24] });
    assert.equal(status, 7);
    const codes = result.record.admissibility.blockers.map((b) => b.code);
    assert.ok(codes.includes('graph-incomplete'));
    assert.ok(codes.includes('graph-unbound'));
    assert.deepEqual(result.record.selection.requestedRoots, [22, 23, 24]);
    assert.deepEqual(result.record.roots.map((r) => [r.defId, r.status, r.closure, r.blockers[0].code]),
      [[22, 'blocked', null, 'not-admissible'], [23, 'blocked', null, 'not-admissible'], [24, 'blocked', null, 'not-admissible']]);
    assert.deepEqual(result.record.nodes, {}, 'no node is planned from an incomplete graph');
  });

  it('reports a recursive helper as recursion-unqualified, keeps every raw reason, and blocks its consumers (labelled)', () => {
    for (const reasons of [['recursion'], ['recursion', 'span-mismatch']]) {
      const { status, result } = plan('positive', { identity: nonExact(19, reasons) });
      assert.equal(status, 6, reasons.join());
      assert.equal(result.record.nodes[19].eligibility, 'recursion-unqualified', reasons.join());
      assert.deepEqual(result.record.nodes[19].upstream.reasons, reasons, 'every upstream reason is kept');
      assert.equal(root(result, 21).status, 'blocked');
      assert.equal(root(result, 23).status, 'ready');
    }
  });

  it('exposes a recursion group from the attempt\'s LLBC for information only (labelled)', () => {
    const llbc = JSON.parse(llbcText('positive'));
    llbc.translated.ordered_decls = llbc.translated.ordered_decls.map((entry) => (entry.Fun?.NonRec === 19 ? { Fun: { Rec: [19] } } : entry));
    const text = JSON.stringify(llbc);
    const both = (record) => { record.provenance.llbcSha256 = sha(text); return record; };
    const { status, result } = plan('positive', { identity: both, graph: both, llbc: text });
    assert.equal(status, 0, 'a recursion group alone changes no eligibility');
    assert.deepEqual(result.record.nodes[19].recursionGroup, { kind: 'Rec', members: [19] });
  });
});

describe('closure plan: cycles over the full declaration graph (labelled mutations)', () => {
  it('makes a cycle between exact nodes a joint-plan blocker, never split', () => {
    const { status, result } = plan('positive', { graph: (g) => addDependency(g, 'probe:m1demo.helper', 'probe:m1demo.root_a') });
    assert.equal(status, 6);
    assert.equal(result.record.nodes[19].eligibility, 'joint-plan-blocker');
    assert.equal(result.record.nodes[21].eligibility, 'joint-plan-blocker');
    assert.deepEqual(result.record.nodes[19].observedCycle, { nodes: [19, 21], unmappedDeclarations: [] });
    assert.equal(root(result, 22).status, 'blocked', 'a consumer of the cycle is blocked');
    assert.equal(root(result, 23).status, 'ready');
  });

  it('finds a cycle through a blocked (upstream-unsupported) node, keeping its raw reasons', () => {
    const { status, result } = plan('positive', {
      graph: (g) => addDependency(g, 'probe:m1demo.helper', 'probe:m1demo.root_b'),
      identity: nonExact(22, ['mapping-method-not-def-id'], 'fallback-only'),
    });
    assert.equal(status, 6);
    assert.equal(result.record.nodes[22].eligibility, 'blocked-upstream');
    assert.deepEqual(result.record.nodes[22].upstream.reasons, ['mapping-method-not-def-id']);
    assert.equal(result.record.nodes[19].eligibility, 'joint-plan-blocker', 'an exact-only subgraph would hide this cycle');
    assert.deepEqual(result.record.nodes[19].observedCycle.nodes, [19, 22]);
    assert.equal(root(result, 21).status, 'blocked');
    assert.equal(root(result, 23).status, 'ready');
  });

  it('finds a cycle A -> H -> B -> A through an unmapped declaration H', () => {
    const viaUnmapped = (g) => {
      g.declarations['probe:m1demo.hub'] = { kind: 'def', 'type-dependencies': [], 'term-dependencies': [], 'type-dependencies-external': [], 'term-dependencies-external': [], dependencies: [] };
      addDependency(g, 'probe:m1demo.root_a', 'probe:m1demo.hub');
      addDependency(g, 'probe:m1demo.hub', 'probe:m1demo.root_b');
      return addDependency(g, 'probe:m1demo.root_b', 'probe:m1demo.root_a');
    };
    const { result } = plan('positive', { graph: viaUnmapped });
    const cycle = result.record.observedCycles.find((c) => c.schedulingCycle);
    assert.deepEqual(cycle.nodes, [21, 22]);
    assert.deepEqual(cycle.unmappedDeclarations, ['probe:m1demo.hub']);
    assert.deepEqual(result.record.nodes[22].observedCycle, { nodes: [21, 22], unmappedDeclarations: ['probe:m1demo.hub'] });
    assert.notEqual(result.record.nodes[22].eligibility, 'eligible');
    assert.equal(root(result, 23).status, 'ready');
  });

  it('reports a cycle of one node with an unmapped declaration as a scheduling cycle', () => {
    const loopThroughHub = (g) => {
      g.declarations['probe:m1demo.hub'] = { kind: 'def', 'type-dependencies': [], 'term-dependencies': [], 'type-dependencies-external': [], 'term-dependencies-external': [], dependencies: [] };
      addDependency(g, 'probe:m1demo.root_a', 'probe:m1demo.hub');
      return addDependency(g, 'probe:m1demo.hub', 'probe:m1demo.root_a');
    };
    const { result } = plan('positive', { graph: loopThroughHub });
    const cycle = result.record.observedCycles.find((c) => c.declarations.includes('probe:m1demo.hub'));
    assert.equal(cycle.schedulingCycle, true);
    assert.deepEqual(result.record.nodes[21].observedCycle, { nodes: [21], unmappedDeclarations: ['probe:m1demo.hub'] });
  });
});

describe('closure plan: admissibility negatives (labelled mutations)', () => {
  const blocked = (options, code) => {
    const { status, result } = plan('positive', options);
    assert.equal(status, 7, code);
    assert.ok(result.record.admissibility.blockers.some((b) => b.code === code), `${code}: ${JSON.stringify(result.record.admissibility.blockers)}`);
    assert.ok(result.record.roots.every((r) => r.status === 'blocked' && r.closure === null), `${code}: no closure claimed`);
    assert.deepEqual(result.record.roots.map((r) => r.defId), [21, 22, 23], `${code}: the selection stays visible`);
  };

  it('blocks disagreeing, one-sided and matching malformed provenance', () => {
    for (const field of ['sourceCommit', 'leanProjectCommit', 'translationSha256', 'charonVersion', 'aeneasVersion', 'manifestSha256', 'llbcSha256', 'configSha256']) {
      const other = field.endsWith('Version') ? 'other' : '0'.repeat(field.endsWith('Commit') ? 40 : 64);
      blocked({ graph: (g) => { g.provenance[field] = other; return g; } }, 'provenance-mismatch');
      blocked({ identity: (i) => { i.provenance[field] = null; return i; } }, 'provenance-missing');
      if (!field.endsWith('Version')) {
        const same = (r) => { r.provenance[field] = 'not-a-hash'; return r; };
        blocked({ identity: same, graph: same }, 'provenance-malformed');
      }
    }
    const blank = (r) => { r.provenance.charonVersion = '  '; return r; };
    blocked({ identity: blank, graph: blank }, 'provenance-malformed');
  });

  it('blocks unbound, contradictory and incomplete records', () => {
    blocked({ identity: (i) => { i.binding = { status: 'unbound', reasons: [] }; return i; } }, 'identity-unbound');
    blocked({ graph: (g) => { g.binding = { ...g.binding, status: 'unbound' }; return g; } }, 'graph-unbound');
    blocked({ identity: (i) => { i.status = 'blocked'; return i; } }, 'identity-blocked');
    blocked({ identity: (i) => { i.blockers = [{ code: 'x', message: 'y' }]; return i; } }, 'identity-contradiction');
    blocked({ identity: (i) => { i.items[0].correspondence = 'ambiguous'; return i; } }, 'identity-contradiction');
    blocked({ graph: (g) => { g.state = 'incomplete'; return g; } }, 'graph-incomplete');
    blocked({ graph: (g) => { g.blockers = [{ code: 'x' }]; return g; } }, 'graph-contradiction');
    blocked({ graph: (g) => { g.binding.reasons = ['run-not-bound']; return g; } }, 'graph-contradiction');
  });

  it('keeps an upstream unsupported graph as a non-admissible diagnostic, not malformed input', () => {
    blocked({ graph: (g) => ({ ...g, state: 'unsupported', declarations: {}, edges: [], blockers: [{ code: 'unsupported-probe-schema' }] }) }, 'graph-unsupported');
  });

  it('blocks different, missing, malformed or repeated published Lean files, and an LLBC that is not the attempt\'s', () => {
    blocked({ graph: (g) => { g.binding.generatedLean[0].sha256 = 'f'.repeat(64); return g; } }, 'generated-lean-mismatch');
    blocked({ identity: (i) => { i.binding.generatedLean = []; return i; } }, 'generated-lean-missing');
    const empty = (r) => { r.binding.generatedLean = [{}]; return r; };
    blocked({ identity: empty, graph: empty }, 'generated-lean-malformed');
    const repeated = (r) => { r.binding.generatedLean = [r.binding.generatedLean[0], r.binding.generatedLean[0]]; return r; };
    blocked({ identity: repeated, graph: repeated }, 'generated-lean-malformed');
    blocked({ llbc: `${llbcText('positive')} ` }, 'llbc-mismatch');
  });

  it('refuses a graph whose edge list disagrees with its declarations, so a dependency cannot be lost', () => {
    blocked({ graph: (g) => { g.edges = []; return g; } }, 'graph-edges-inconsistent');
    blocked({ graph: (g) => { g.edges = []; return g; }, failed: [19] }, 'graph-edges-inconsistent');
    blocked({ graph: (g) => { g.edges.push({ from: 'probe:m1demo.root_a', to: 'probe:m1demo.ghost', kind: 'term', resolution: 'local' }); return g; } }, 'graph-edges-inconsistent');
    blocked({ graph: (g) => { g.edges = g.edges.map((e) => (e.resolution === 'local' ? { ...e, resolution: 'external' } : e)); return g; } }, 'graph-edges-inconsistent');
    const unresolved = (g) => {
      g.declarations['probe:m1demo.root_a']['term-dependencies'].push('probe:m1demo.ghost');
      g.edges.push({ from: 'probe:m1demo.root_a', to: 'probe:m1demo.ghost', kind: 'term', resolution: 'unresolved' });
      return g;
    };
    blocked({ graph: unresolved }, 'graph-contradiction');
    blocked({ graph: (g) => { delete g.declarations['probe:m1demo.root_a']['term-dependencies']; return g; } }, 'graph-declarations-malformed');
  });

  it('refuses a declared helper relabelled external in both the declaration and the edge list (verified fidelity, so only this check fires)', () => {
    const hide = (g) => {
      const atom = g.declarations['probe:m1demo.root_a'];
      assert.ok(atom['term-dependencies'].includes('probe:m1demo.helper'));
      atom['term-dependencies'] = atom['term-dependencies'].filter((to) => to !== 'probe:m1demo.helper');
      atom['term-dependencies-external'] = [...(atom['term-dependencies-external'] ?? []), 'probe:m1demo.helper'];
      g.edges = g.edges.map((e) => (e.from === 'probe:m1demo.root_a' && e.to === 'probe:m1demo.helper' ? { ...e, resolution: 'external' } : e));
      return g;
    };
    for (const failed of [null, [19]]) {
      const { status, result } = plan('positive', { graph: hide, failed });
      assert.equal(status, 7, `failed ${failed}`);
      assert.deepEqual(result.record.admissibility.blockers.map((b) => b.code), ['graph-contradiction'], `failed ${failed}`);
      assert.match(result.record.admissibility.blockers[0].message, /probe:m1demo\.helper/);
      assert.equal(root(result, 21).closure, null, 'root 21 never loses helper 19 and stays ready');
    }
  });
});

describe('closure plan: identity gaps stay visible (labelled mutations)', () => {
  it('blocks an exact item whose generated family is empty, repeated, or lacks its target', () => {
    for (const [label, edit] of [
      ['empty family', (item) => { item.generated = []; }],
      ['repeated member', (item) => { item.generated = [item.generated[0], item.generated[0]]; }],
      ['target outside the family', (item) => { item.target = 'm1demo.elsewhere'; }],
      ['no target', (item) => { item.target = null; }],
    ]) {
      const { result } = plan('positive', { identity: (i) => { edit(i.items.find((x) => x.defId === 19)); return i; } });
      assert.equal(result.record.nodes[19].eligibility, 'blocked-family-invalid', label);
      assert.equal(root(result, 21).status, 'blocked', label);
      assert.equal(root(result, 23).status, 'ready', label);
    }
  });

  it('blocks both items when one Lean declaration is claimed by two families, instead of picking one', () => {
    const shared = (i) => { i.items.find((x) => x.defId === 21).generated.push({ leanName: 'm1demo.helper' }); return i; };
    const { result } = plan('positive', { identity: shared });
    assert.equal(result.record.nodes[19].eligibility, 'blocked-ambiguous-ownership');
    assert.equal(result.record.nodes[21].eligibility, 'blocked-ambiguous-ownership');
    assert.equal(root(result, 22).status, 'blocked', 'a consumer of the ambiguous helper is blocked');
    assert.equal(root(result, 23).status, 'ready');
  });

  it('does not schedule an item labelled exact that carries ticket 10 reasons, keeping its raw fields', () => {
    const exactButRecursive = (i) => { i.items.find((x) => x.defId === 19).reasons = ['recursion']; return i; };
    const { status, result } = plan('positive', { identity: exactButRecursive });
    assert.equal(status, 6);
    assert.equal(result.record.nodes[19].eligibility, 'blocked-upstream-contradiction');
    assert.deepEqual(result.record.nodes[19].upstream, { correspondence: 'exact', reasons: ['recursion'] });
    assert.equal(root(result, 21).status, 'blocked');
    assert.equal(root(result, 23).status, 'ready');
  });

  it('blocks a node whose generated family member is missing from the graph', () => {
    const ghost = (i) => { i.items.find((x) => x.defId === 20).generated.push({ leanName: 'm1demo.sum_to_ghost' }); return i; };
    const { result } = plan('positive', { identity: ghost });
    assert.equal(result.record.nodes[20].eligibility, 'blocked-unmatched');
    assert.equal(root(result, 22).status, 'blocked');
    assert.equal(root(result, 21).status, 'ready');
  });

  it('blocks a node that depends on a local declaration no ticket 10 item owns', () => {
    const unmapped = (g) => {
      g.declarations['probe:m1demo.extra'] = { kind: 'def', 'type-dependencies': [], 'term-dependencies': [], 'type-dependencies-external': [], 'term-dependencies-external': [], dependencies: [] };
      return addDependency(g, 'probe:m1demo.root_a', 'probe:m1demo.extra');
    };
    const { result } = plan('positive', { graph: unmapped });
    assert.equal(result.record.nodes[21].eligibility, 'blocked-unmapped-dependency');
    assert.deepEqual(result.record.nodes[21].unmappedDependencies, ['probe:m1demo.extra']);
    assert.equal(root(result, 21).status, 'blocked');
  });

  it('reports an unknown root without a closure, and refuses an unknown failed node and foreign records', () => {
    const { status, result } = plan('positive', { roots: [21, 99] });
    assert.equal(status, 6);
    assert.deepEqual([root(result, 99).closure, root(result, 99).blockers[0].code], [null, 'unknown-root']);
    assert.equal(plan('positive', { failed: [99] }).result.code, 'invalid-input');
    assert.equal(plan('positive', { identity: (i) => ({ ...i, schema: 'other' }) }).result.code, 'invalid-input');
    assert.equal(plan('positive', { graph: (g) => ({ ...g, schemaVersion: 2 }) }).result.code, 'invalid-input');
  });

  it('validates the exported builder\'s wrappers and selections', async () => {
    const { buildPlan } = await import(require('node:url').pathToFileURL(SCRIPT).href);
    const load = (name) => { const text = fs.readFileSync(path.join(FIXTURES, 'positive', name), 'utf8'); return { json: JSON.parse(text), sha256: sha(text) }; };
    const valid = () => ({ identity: load('identity-record.json'), graph: load('graph-record.json'), roots: [21, 22], failed: [] });
    assert.equal(buildPlan(valid()).status, 'blocked', 'the recorded pre-fidelity graph is not admissible');
    const withFidelity = valid();
    withFidelity.graph = { json: verified(withFidelity.graph.json), sha256: withFidelity.graph.sha256 };
    assert.equal(buildPlan(withFidelity).status, 'ready', 'labelled mutation: verified fidelity');
    const boundWithReasons = valid();
    boundWithReasons.graph = { json: verified({ ...boundWithReasons.graph.json, binding: { ...boundWithReasons.graph.json.binding, reasons: ['x'] } }), sha256: boundWithReasons.graph.sha256 };
    assert.ok(buildPlan(boundWithReasons).admissibility.blockers.some((b) => b.code === 'graph-contradiction'), 'bound graph with binding reasons');
    const exactWithReason = { ...withFidelity, identity: load('identity-record.json') };
    exactWithReason.identity.json.items.find((x) => x.defId === 19).reasons = ['recursion'];
    const contradictory = buildPlan(exactWithReason);
    assert.equal(contradictory.nodes[19].eligibility, 'blocked-upstream-contradiction');
    assert.equal(contradictory.roots.find((r) => r.defId === 21).status, 'blocked');
    for (const [label, edit] of [
      ['identity without a digest', (x) => { delete x.identity.sha256; }],
      ['graph with a malformed digest', (x) => { x.graph.sha256 = 'nope'; }],
      ['empty roots', (x) => { x.roots = []; }],
      ['non-integer root', (x) => { x.roots = ['21']; }],
      ['repeated root', (x) => { x.roots = [21, 21]; }],
      ['failed not an array', (x) => { x.failed = 19; }],
      ['repeated failed', (x) => { x.failed = [19, 19]; }],
      ['malformed llbc wrapper', (x) => { x.llbc = { json: {} }; }],
    ]) {
      const input = valid();
      edit(input);
      assert.throws(() => buildPlan(input), (error) => error.code === 'invalid-input', label);
    }
  });
});
