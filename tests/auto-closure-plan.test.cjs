'use strict';

// Ticket 13: the join of ticket 10's Rust identity record and ticket 21's Lean
// graph record, and the union closure of requested roots with one owner per
// shared helper. The positive and recursion inputs are recorded outputs of real
// runs (fixtures/auto-closure-plan); every other case is a labelled mutation of
// them. No tool runs here.

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

// Writes the (possibly mutated) records of RUN and plans ROOTS; returns { status, result }.
function plan(run, { identity = (x) => x, graph = (x) => x, llbc = null, roots = [21, 22, 23], failed = null } = {}) {
  const dir = scratch();
  const write = (name, value) => { const file = path.join(dir, name); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  const args = [SCRIPT, 'plan', '--identity', write('identity.json', identity(read(run, 'identity-record.json'))),
    '--graph', write('graph.json', graph(read(run, 'graph-record.json'))), '--roots', roots.join(',')];
  if (failed) args.push('--failed', failed.join(','));
  if (llbc) args.push('--llbc', write('m1demo.llbc', llbc));
  const out = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { status: out.status, result: JSON.parse(out.stdout) };
}
const llbcText = (run) => zlib.gunzipSync(fs.readFileSync(path.join(FIXTURES, run, 'm1demo.llbc.gz'))).toString('utf8');
const root = (result, id) => result.record.roots.find((entry) => entry.defId === id);

describe('closure plan: recorded positive (two roots, one shared helper, a loop, an independent root)', () => {
  it('joins the two bound records and makes every requested root ready, with one owner for the shared helper', () => {
    const { status, result } = plan('positive', { llbc: llbcText('positive') });
    assert.equal(status, 0);
    assert.equal(result.code, 'ok');
    const rec = result.record;
    assert.equal(rec.admissibility.status, 'admissible');
    assert.deepEqual(root(result, 21).closure, [19, 21]);
    assert.deepEqual(root(result, 22).closure, [19, 20, 22]);
    assert.deepEqual(root(result, 23).closure, [23]);
    const helper = rec.nodes[19];
    assert.deepEqual(helper.sharedBy, [21, 22]);
    assert.equal(helper.ownerRoot, 21);
    assert.match(rec.ownership.rule, /lowest-numbered requested root/);
    assert.deepEqual(rec.nodes[22].dependsOn, [19, 20], 'consumer -> dependency, as recorded');
    assert.deepEqual(rec.nodes[20].declarations.sort(), ['probe:m1demo.sum_to', 'probe:m1demo.sum_to_loop', 'probe:m1demo.sum_to_loop.body']);
    assert.deepEqual(rec.nodes[19].recursionGroup, { kind: 'NonRec', members: [19] });
  });

  it('blocks the consumers of a failed helper while an independent root stays ready', () => {
    const { status, result } = plan('positive', { failed: [19] });
    assert.equal(status, 6);
    assert.equal(root(result, 21).status, 'blocked');
    assert.equal(root(result, 22).status, 'blocked');
    assert.equal(root(result, 23).status, 'ready');
    assert.equal(result.record.nodes[21].eligibility, 'blocked-by-dependency');
  });

  it('judges each root by its own closure when the ticket 10 record is partial (labelled mutation)', () => {
    const unsupported = (identity) => {
      const item = identity.items.find((entry) => entry.defId === 20);
      item.correspondence = 'fallback-only';
      item.reasons = ['mapping-method-not-def-id'];
      identity.status = 'partial';
      return identity;
    };
    const { status, result } = plan('positive', { identity: unsupported });
    assert.equal(status, 6);
    assert.equal(root(result, 21).status, 'ready', 'a disjoint closure keeps its own ready result');
    assert.equal(root(result, 22).status, 'blocked');
    assert.equal(result.record.nodes[20].eligibility, 'blocked-upstream');
    assert.deepEqual(result.record.nodes[20].upstream, { correspondence: 'fallback-only', reasons: ['mapping-method-not-def-id'] }, 'raw upstream kept');
  });
});

describe('closure plan: recursion stays unqualified', () => {
  it('blocks the recorded recursion run: its graph is incomplete and unbound, and nothing is salvaged', () => {
    const { status, result } = plan('recursion', { llbc: llbcText('recursion'), roots: [22, 23, 24] });
    assert.equal(status, 7);
    const codes = result.record.admissibility.blockers.map((b) => b.code);
    assert.ok(codes.includes('graph-incomplete'));
    assert.ok(codes.includes('graph-unbound'));
    assert.deepEqual(result.record.roots, [], 'no closure is claimed from an incomplete graph');
    const identity = read('recursion', 'identity-record.json');
    assert.deepEqual(identity.items.filter((item) => item.reasons.includes('recursion')).map((item) => item.defId), [19, 20, 21]);
  });

  it('reports a recursive helper as recursion-unqualified, keeps the raw upstream status, and blocks its consumers (labelled)', () => {
    for (const reasons of [['recursion'], ['recursion', 'span-mismatch']]) {
      const recursive = (identity) => {
        const item = identity.items.find((entry) => entry.defId === 19);
        item.correspondence = 'unsupported';
        item.reasons = reasons;
        identity.status = 'partial';
        return identity;
      };
      const { status, result } = plan('positive', { identity: recursive });
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

  it('makes a dependency cycle between exact nodes a joint-plan blocker, never split (labelled)', () => {
    const cycle = (graph) => {
      graph.edges.push({ from: 'probe:m1demo.helper', to: 'probe:m1demo.root_a', kind: 'term', resolution: 'local' });
      return graph;
    };
    const { status, result } = plan('positive', { graph: cycle });
    assert.equal(status, 6);
    assert.equal(result.record.nodes[19].eligibility, 'joint-plan-blocker');
    assert.equal(result.record.nodes[21].eligibility, 'joint-plan-blocker');
    assert.deepEqual(result.record.nodes[19].observedCycle, [19, 21]);
    assert.equal(root(result, 22).status, 'blocked', 'a consumer of the cycle is blocked');
    assert.equal(root(result, 23).status, 'ready');
  });
});

describe('closure plan: cycles are found before eligibility filtering', () => {
  it('marks an eligible node in a cycle with a blocked node as a joint-plan blocker (labelled)', () => {
    const cycle = (graph) => {
      graph.edges.push({ from: 'probe:m1demo.helper', to: 'probe:m1demo.root_b', kind: 'term', resolution: 'local' });
      return graph;
    };
    const blockedRootB = (identity) => {
      const item = identity.items.find((entry) => entry.defId === 22);
      item.correspondence = 'fallback-only';
      item.reasons = ['mapping-method-not-def-id'];
      identity.status = 'partial';
      return identity;
    };
    const { status, result } = plan('positive', { graph: cycle, identity: blockedRootB });
    assert.equal(status, 6);
    assert.equal(result.record.nodes[22].eligibility, 'blocked-upstream', 'the blocked placeholder keeps its upstream eligibility');
    assert.equal(result.record.nodes[19].eligibility, 'joint-plan-blocker', 'an exact-only subgraph would hide this cycle');
    assert.deepEqual(result.record.nodes[19].observedCycle, [19, 22]);
    assert.equal(root(result, 21).status, 'blocked');
    assert.equal(root(result, 23).status, 'ready');
  });
});

describe('closure plan: admissibility negatives (labelled mutations)', () => {
  const blocked = (options, code) => {
    const { status, result } = plan('positive', options);
    assert.equal(status, 7, code);
    assert.ok(result.record.admissibility.blockers.some((b) => b.code === code), `${code}: ${JSON.stringify(result.record.admissibility.blockers)}`);
    assert.deepEqual(result.record.roots, [], `${code}: no closure claimed`);
  };

  it('blocks disagreeing or one-sided provenance', () => {
    for (const field of ['sourceCommit', 'leanProjectCommit', 'translationSha256', 'charonVersion', 'aeneasVersion', 'manifestSha256', 'llbcSha256', 'configSha256']) {
      blocked({ graph: (g) => { g.provenance[field] = field.endsWith('Version') ? 'other' : '0'.repeat(field.endsWith('Commit') ? 40 : 64); return g; } }, 'provenance-mismatch');
      blocked({ identity: (i) => { i.provenance[field] = null; return i; } }, 'provenance-missing');
    }
  });

  it('blocks unbound records, a blocked identity record and an incomplete graph', () => {
    blocked({ identity: (i) => { i.binding = { status: 'unbound', reasons: [] }; return i; } }, 'identity-unbound');
    blocked({ graph: (g) => { g.binding = { status: 'unbound', reasons: [] }; return g; } }, 'graph-unbound');
    blocked({ identity: (i) => { i.status = 'blocked'; return i; } }, 'identity-blocked');
    blocked({ graph: (g) => { g.state = 'incomplete'; return g; } }, 'graph-incomplete');
  });

  it('blocks different or missing published Lean files, and an LLBC that is not the attempt\'s', () => {
    blocked({ graph: (g) => { g.binding.generatedLean[0].sha256 = 'f'.repeat(64); return g; } }, 'generated-lean-mismatch');
    blocked({ identity: (i) => { i.binding.generatedLean = []; return i; } }, 'generated-lean-missing');
    blocked({ llbc: `${llbcText('positive')} ` }, 'llbc-mismatch');
  });
});

describe('closure plan: identity gaps stay visible (labelled mutations)', () => {
  it('blocks a node whose generated family is missing from the graph', () => {
    const missing = (graph) => { delete graph.declarations['probe:m1demo.sum_to_loop.body']; return graph; };
    const { status, result } = plan('positive', { graph: missing });
    assert.equal(status, 6);
    assert.equal(result.record.nodes[20].eligibility, 'blocked-unmatched');
    assert.equal(root(result, 22).status, 'blocked');
    assert.equal(root(result, 21).status, 'ready');
  });

  it('blocks a node that depends on a local declaration no ticket 10 item owns', () => {
    const unmapped = (graph) => {
      graph.declarations['probe:m1demo.extra'] = { kind: 'def' };
      graph.edges.push({ from: 'probe:m1demo.root_a', to: 'probe:m1demo.extra', kind: 'term', resolution: 'local' });
      return graph;
    };
    const { result } = plan('positive', { graph: unmapped });
    assert.equal(result.record.nodes[21].eligibility, 'blocked-unmapped-dependency');
    assert.deepEqual(result.record.nodes[21].unmappedDependencies, ['probe:m1demo.extra']);
    assert.equal(root(result, 21).status, 'blocked');
  });

  it('reports an unknown root, and refuses an unknown failed node and foreign records', () => {
    const { status, result } = plan('positive', { roots: [21, 99] });
    assert.equal(status, 6);
    assert.equal(root(result, 99).blockers[0].code, 'unknown-root');
    assert.equal(plan('positive', { failed: [99] }).result.code, 'invalid-input');
    assert.equal(plan('positive', { identity: (i) => ({ ...i, schema: 'other' }) }).result.code, 'invalid-input');
    assert.equal(plan('positive', { graph: (g) => ({ ...g, schemaVersion: 2 }) }).result.code, 'invalid-input');
  });
});
