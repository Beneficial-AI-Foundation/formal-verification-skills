'use strict';

// Fixture tests only: nothing here runs Lean, Lake or probe-lean. The recorded
// fixtures are real probe-lean 0.14.0 outputs and logs (see the fixture README);
// the derived cases are edits of the recorded positive made in this file.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'fvs-lean-graph.mjs');
const FIXTURES = path.join(__dirname, 'fixtures', 'auto-lean-graph');
const PROJECT = path.join(FIXTURES, 'project');
const recorded = (run, file) => path.join(FIXTURES, 'recorded', run, file);
const read = (run, file) => fs.readFileSync(recorded(run, file), 'utf8');

let buildLeanGraph;
let readLog;
before(async () => {
  ({ buildLeanGraph, readLog } = await import(pathToFileURL(SCRIPT).href));
});

function graph(run, overrides = {}) {
  return buildLeanGraph({
    extractText: read(run, 'lean.json'),
    logText: read(run, 'probe.log'),
    libraries: ['M1demo'],
    projectRoot: PROJECT,
    ...overrides,
  });
}

function cli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

const codes = (record) => record.blockers.map((item) => item.code);
const local = (record, kind, from) => record.edges
  .filter((edge) => edge.from === from && edge.kind === kind && edge.resolution === 'local')
  .map((edge) => edge.to).sort();
const THEOREM = 'probe:m1demo.spec.double_spec';

describe('recorded positive: proved theorem over an extracted definition', () => {
  it('is complete, exits 0, and binds the extraction provenance', () => {
    const result = cli([recorded('positive-theorem', 'lean.json'), '--library', 'M1demo',
      '--log', recorded('positive-theorem', 'probe.log'), '--project-root', PROJECT]);
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(result.stdout);
    assert.equal(record.state, 'complete');
    assert.deepEqual(record.blockers, []);
    assert.deepEqual(record.provenance, {
      sourceCommit: 'eef73c8fedf3fbcb640c35467b52b63ca6b7c1bd',
      translationSha256: 'bb20ee964531c310e47f3bc466e5e1ac5aefe25cfa0f2df04cd4bd5644265093',
      charonVersion: '0.1.274',
      aeneasVersion: 'nightly-2026.09.30-0855ce1',
      manifestSha256: null,
    });
    assert.deepEqual(record.completeness.log, { builtLibraries: ['M1demo'], buildSkipped: false, writtenAtoms: 9 });
    assert.equal(record.completeness.translationDeclarations, 5);
    assert.deepEqual(record.completeness.missingDeclarations, []);
  });

  it('orients edges from dependent to dependency and keeps type and term edges apart', () => {
    const record = graph('positive-theorem');
    assert.deepEqual(local(record, 'term', 'probe:m1demo.sum_to'), ['probe:m1demo.sum_to_loop']);
    assert.deepEqual(local(record, 'term', 'probe:m1demo.sum_to_loop'), ['probe:m1demo.sum_to_loop.body']);
    assert.deepEqual(local(record, 'term', 'probe:m1demo.sum_to_loop.body'), []);
    assert.deepEqual(local(record, 'type', THEOREM),
      ['probe:m1demo.double', 'probe:m1demo.spec.DoubleFits', 'probe:m1demo.spec.doubleNat']);
    assert.ok(local(record, 'term', THEOREM).includes('probe:m1demo.spec.doubleNat_eq'));
    assert.ok(!local(record, 'type', THEOREM).includes('probe:m1demo.spec.doubleNat_eq'));
    assert.ok(record.external.includes('probe:Aeneas.Std.WP.spec'));
    assert.ok(record.edges.every((edge) => edge.resolution !== 'unresolved'));
  });

  it('computes the semantic-definition closure from the statement, not the proof', () => {
    const closure = graph('positive-theorem').closures[THEOREM];
    assert.equal(closure.state, 'complete');
    assert.deepEqual(closure.declarations,
      ['probe:m1demo.double', 'probe:m1demo.spec.DoubleFits', 'probe:m1demo.spec.doubleNat']);
    assert.ok(!closure.declarations.includes('probe:m1demo.spec.doubleNat_eq'));
    for (const name of ['probe:Aeneas.Std.WP.spec', 'probe:Aeneas.Std.U32.max', 'probe:Aeneas.Std.instHAddUScalarResult']) {
      assert.ok(closure.external.includes(name), name);
    }
    assert.ok(!closure.external.includes('probe:Aeneas.Std.U32.add_spec'), 'proof-only external');
  });

  it('preserves raw tool fields, including contradictory ones', () => {
    const record = graph('positive-theorem');
    assert.deepEqual(record.declarations, JSON.parse(read('positive-theorem', 'lean.json')).data);
    assert.equal(record.declarations['probe:m1demo.double']['is-aeneas-generated'], false);
    assert.equal(record.declarations['probe:m1demo.spec.DoubleFits']['primary-spec'], THEOREM);
    assert.equal(record.declarations[THEOREM]['is-primary-spec'], false);
    assert.equal(record.declarations[THEOREM]['codomain-is-prop'], false);
    assert.deepEqual(record.anomalies.map((item) => item.declaration).sort(), [
      'probe:m1demo.clamp', 'probe:m1demo.double', 'probe:m1demo.sum_to',
      'probe:m1demo.sum_to_loop', 'probe:m1demo.sum_to_loop.body',
    ]);
    assert.ok(record.anomalies.every((item) => item.code === 'aeneas-generated-false-for-translation-declaration'));
  });

  it('records the patch-engine manifest hash only when one is given', () => {
    const manifest = path.join(PROJECT, 'lake-manifest.json');
    const record = graph('positive-theorem', { manifestPath: manifest });
    assert.equal(record.provenance.manifestSha256,
      crypto.createHash('sha256').update(fs.readFileSync(manifest)).digest('hex'));
  });
});

describe('recorded negatives: real probe-lean runs never give an empty-success graph', () => {
  it('Aeneas library outside defaultTargets, fresh build: exit 0 from the tool, incomplete here', () => {
    const record = graph('neg-default-targets-fresh');
    assert.equal(record.state, 'incomplete');
    assert.deepEqual(codes(record), ['library-not-built', 'library-not-analysed', 'missing-declarations']);
    assert.equal(record.completeness.missingDeclarations.length, 5);
    const result = cli([recorded('neg-default-targets-fresh', 'lean.json'), '--library', 'M1demo',
      '--log', recorded('neg-default-targets-fresh', 'probe.log'), '--project-root', PROJECT]);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).state, 'incomplete');
  });

  it('Aeneas library outside defaultTargets, stale build cache: atoms present but not built by this run', () => {
    const record = graph('neg-default-targets');
    assert.deepEqual(codes(record), ['library-not-built']);
    assert.deepEqual(record.completeness.log.builtLibraries, ['Other']);
    assert.deepEqual(record.closures[THEOREM].blockers, [{ code: 'graph-incomplete' }]);
    assert.equal(record.closures[THEOREM].state, 'incomplete');
  });

  it('module filter: an extracted definition reported as external is an unresolved edge', () => {
    const record = graph('neg-module-filter');
    assert.equal(record.state, 'incomplete');
    assert.ok(codes(record).includes('missing-declarations'));
    const unresolved = record.blockers.find((item) => item.code === 'unresolved-edge');
    assert.equal(unresolved.declaration, THEOREM);
    assert.ok(record.edges.some((edge) => edge.from === THEOREM && edge.to === 'probe:m1demo.double' &&
      edge.kind === 'type' && edge.resolution === 'unresolved'));
    assert.ok(!record.external.includes('probe:m1demo.double'));
    assert.deepEqual(record.closures[THEOREM].blockers,
      [{ code: 'graph-incomplete' }, { code: 'unresolved-edge', dependency: 'probe:m1demo.double' }]);
  });

  it('empty library: an empty extract (tool exit 0) is incomplete with no closures', () => {
    const record = graph('neg-empty-library');
    assert.equal(record.state, 'incomplete');
    assert.equal(codes(record)[0], 'empty-extract');
    assert.deepEqual(record.closures, {});
  });

  it('failed runs (unknown --library, missing Aeneas package) wrote no extract', () => {
    for (const run of ['neg-unknown-library', 'neg-missing-aeneas-package']) {
      assert.ok(!fs.existsSync(recorded(run, 'lean.json')), run);
      assert.match(read(run, 'probe.log'), /^EXIT=1$/m);
      assert.equal(readLog(read(run, 'probe.log')).writtenAtoms, null);
      const record = buildLeanGraph({ extractText: '', logText: read(run, 'probe.log'), libraries: ['M1demo'], projectRoot: PROJECT });
      assert.equal(record.state, 'incomplete');
      assert.deepEqual(codes(record), ['unreadable-extract']);
    }
  });
});

describe('derived negatives: edits of the recorded positive', () => {
  it('a truncated extract is incomplete, never a smaller graph', () => {
    const text = read('positive-theorem', 'lean.json');
    const record = graph('positive-theorem', { extractText: text.slice(0, Math.floor(text.length / 2)) });
    assert.equal(record.state, 'incomplete');
    assert.deepEqual(codes(record), ['unreadable-extract']);
    assert.deepEqual(record.declarations, {});
  });

  it('a truncated log or a disagreeing atom count is incomplete', () => {
    const log = read('positive-theorem', 'probe.log');
    assert.deepEqual(codes(graph('positive-theorem', { logText: log.replace(/^Wrote .*$/m, '') })), ['log-incomplete']);
    assert.deepEqual(codes(graph('positive-theorem', { logText: log.replace('Wrote 9 ', 'Wrote 10 ') })), ['atom-count-mismatch']);
  });

  it('a dropped semantic definition blocks every closure that reaches it', () => {
    const envelope = JSON.parse(read('positive-theorem', 'lean.json'));
    delete envelope.data['probe:m1demo.spec.doubleNat'];
    const record = graph('positive-theorem', {
      extractText: JSON.stringify(envelope),
      logText: read('positive-theorem', 'probe.log').replace('Wrote 9 ', 'Wrote 8 '),
    });
    assert.deepEqual(record.blockers.filter((item) => item.code === 'unresolved-edge').map((item) => item.declaration),
      ['probe:m1demo.spec.DoubleFits', 'probe:m1demo.spec.doubleNat_eq', THEOREM]);
    assert.deepEqual(record.closures[THEOREM].blockers,
      [{ code: 'graph-incomplete' }, { code: 'unresolved-edge', dependency: 'probe:m1demo.spec.doubleNat' }]);
  });

  it('a dropped proof-only lemma does not enter the closure, but still blocks the graph', () => {
    const envelope = JSON.parse(read('positive-theorem', 'lean.json'));
    delete envelope.data['probe:m1demo.spec.doubleNat_eq'];
    const record = graph('positive-theorem', {
      extractText: JSON.stringify(envelope),
      logText: read('positive-theorem', 'probe.log').replace('Wrote 9 ', 'Wrote 8 '),
    });
    assert.deepEqual(codes(record), ['unresolved-edge']);
    assert.deepEqual(record.closures[THEOREM].blockers, [{ code: 'graph-incomplete' }]);
  });

  it('missing completeness or provenance evidence is incomplete', () => {
    assert.ok(codes(graph('positive-theorem', { logText: null })).includes('no-log'));
    assert.ok(codes(graph('positive-theorem', { projectRoot: null })).includes('no-translation'));
    assert.equal(graph('positive-theorem', { projectRoot: null }).provenance.translationSha256, null);
    const envelope = JSON.parse(read('positive-theorem', 'lean.json'));
    envelope.source.commit = '';
    assert.deepEqual(codes(graph('positive-theorem', { extractText: JSON.stringify(envelope) })), ['no-source-commit']);
    assert.deepEqual(codes(graph('positive-theorem', { libraries: ['M1demo', 'Specs'] })),
      ['library-not-built', 'library-not-analysed']);
  });

  it('an unqualified tool version or schema is unsupported', () => {
    for (const edit of [
      (envelope) => { envelope.tool.version = '0.13.0'; },
      (envelope) => { envelope['schema-version'] = '2.0'; },
      (envelope) => { envelope.schema = 'probe-aeneas/extract'; },
    ]) {
      const envelope = JSON.parse(read('positive-theorem', 'lean.json'));
      edit(envelope);
      const record = graph('positive-theorem', { extractText: JSON.stringify(envelope) });
      assert.equal(record.state, 'unsupported');
      assert.deepEqual(codes(record), ['unqualified-interface']);
      assert.deepEqual(record.declarations, {});
    }
  });

  it('rejects a missing --library as a usage error', () => {
    const result = cli([recorded('positive-theorem', 'lean.json')]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--library is required/);
  });
});
