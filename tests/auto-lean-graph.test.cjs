'use strict';

// Fixture tests only: nothing here runs Lean, Lake or probe-lean. The recorded
// fixtures are real probe-lean 0.14.0 outputs, logs and run receipts (see the
// fixture README); the derived cases are edits of the recorded bound positive
// made in this file. Derived edits re-sign the receipt's output hashes, so each
// case shows its own check catching a consistent but wrong run.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'fvs-lean-graph.mjs');
const FIXTURES = path.join(__dirname, 'fixtures', 'auto-lean-graph');
const PROJECT = path.join(FIXTURES, 'project');
const MANIFEST = path.join(FIXTURES, 'extraction', 'manifest.json');
const recorded = (run, file) => path.join(FIXTURES, 'recorded', run, file);
const read = (run, file) => fs.readFileSync(recorded(run, file), 'utf8');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const BOUND = 'positive-bound';
const THEOREM = 'probe:m1demo.spec.double_spec';
const FITS = 'probe:m1demo.spec.DoubleFits';
const temporaryDirectories = [];

let buildLeanGraph;
let readLog;
let projectInputs;
before(async () => {
  ({ buildLeanGraph, readLog, projectInputs } = await import(pathToFileURL(SCRIPT).href));
});
after(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

function graph(overrides = {}) {
  return buildLeanGraph({
    extractText: read(BOUND, 'lean.json'),
    logText: read(BOUND, 'probe.log'),
    receiptText: read(BOUND, 'receipt.json'),
    libraries: ['M1demo'],
    projectRoot: PROJECT,
    manifestText: fs.readFileSync(MANIFEST, 'utf8'),
    ...overrides,
  });
}

// A derived run: edit the bound positive's extract, log or receipt, then re-sign
// the receipt so it names the edited extract and log.
function derived({ edit = () => {}, extractText = null, log = (text) => text, receipt = () => {}, projectRoot = PROJECT } = {}) {
  const envelope = JSON.parse(read(BOUND, 'lean.json'));
  edit(envelope.data, envelope);
  const text = extractText ?? JSON.stringify(envelope);
  const logText = log(read(BOUND, 'probe.log'));
  const signed = JSON.parse(read(BOUND, 'receipt.json'));
  signed.outputs = { extractSha256: sha256(text), logSha256: sha256(logText) };
  receipt(signed);
  return graph({ extractText: text, logText, receiptText: JSON.stringify(signed), projectRoot });
}

const wrote = (count) => (text) => text.replace('Wrote 9 ', `Wrote ${count} `);

function projectCopy(edit) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-lean-graph-'));
  temporaryDirectories.push(directory);
  fs.cpSync(PROJECT, directory, { recursive: true });
  edit(directory);
  return directory;
}

function cli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

const codes = (record) => record.blockers.map((item) => item.code);
const local = (record, kind, from) => record.edges
  .filter((edge) => edge.from === from && edge.kind === kind && edge.resolution === 'local')
  .map((edge) => edge.to).sort();

describe('recorded positive: a bound run of a proved theorem over an extracted definition', () => {
  it('is complete, exits 0, and records provenance with the binding kept separate', () => {
    const result = cli([recorded(BOUND, 'lean.json'), '--library', 'M1demo', '--log', recorded(BOUND, 'probe.log'),
      '--receipt', recorded(BOUND, 'receipt.json'), '--project-root', PROJECT, '--manifest', MANIFEST]);
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(result.stdout);
    assert.equal(record.state, 'complete');
    assert.deepEqual(record.blockers, []);
    assert.deepEqual(record.provenance, {
      sourceCommit: '8c8955e1193744a42ee464d56893c87d8a172826',
      leanProjectCommit: 'eef73c8fedf3fbcb640c35467b52b63ca6b7c1bd',
      translationSha256: 'bb20ee964531c310e47f3bc466e5e1ac5aefe25cfa0f2df04cd4bd5644265093',
      charonVersion: '0.1.274',
      aeneasVersion: 'nightly-2026.09.30-0855ce1',
      manifestSha256: '02b41307fa63ec30eecd79a9bb6fad390416aa170993b5d13a1dd0648978ad89',
    });
    assert.deepEqual(record.binding, {
      status: 'unbound',
      reasons: ['translation-not-bound-to-manifest', 'lean-project-commit-differs-from-source-commit'],
    });
    assert.deepEqual(Object.keys(record.completeness.modules), ['M1demo', 'M1demo.M1demo', 'M1demo.Spec']);
    assert.equal(record.completeness.expectedDeclarations, 9);
    assert.deepEqual(record.completeness.missingDeclarations, []);
  });

  it('the recorded receipt binds exactly the fixture project', () => {
    assert.deepEqual(projectInputs(PROJECT), JSON.parse(read(BOUND, 'receipt.json')).inputs.files);
  });

  it('orients edges from dependent to dependency and keeps type and term edges apart', () => {
    const record = graph();
    assert.deepEqual(local(record, 'term', 'probe:m1demo.sum_to'), ['probe:m1demo.sum_to_loop']);
    assert.deepEqual(local(record, 'term', 'probe:m1demo.sum_to_loop'), ['probe:m1demo.sum_to_loop.body']);
    assert.deepEqual(local(record, 'type', THEOREM), ['probe:m1demo.double', FITS, 'probe:m1demo.spec.doubleNat']);
    assert.ok(local(record, 'term', THEOREM).includes('probe:m1demo.spec.doubleNat_eq'));
    assert.ok(!local(record, 'type', THEOREM).includes('probe:m1demo.spec.doubleNat_eq'));
    assert.ok(record.external.includes('probe:Aeneas.Std.WP.spec'));
    assert.ok(record.edges.every((edge) => edge.resolution !== 'unresolved'));
  });

  it('computes the semantic-definition closure from the statement, not the proof', () => {
    const closure = graph().closures[THEOREM];
    assert.equal(closure.state, 'complete');
    assert.deepEqual(closure.declarations, ['probe:m1demo.double', FITS, 'probe:m1demo.spec.doubleNat']);
    for (const name of ['probe:Aeneas.Std.WP.spec', 'probe:Aeneas.Std.U32.max', 'probe:Aeneas.Std.instHAddUScalarResult']) {
      assert.ok(closure.external.includes(name), name);
    }
    assert.ok(!closure.external.includes('probe:Aeneas.Std.U32.add_spec'), 'proof-only external');
  });

  it('preserves raw tool fields, including contradictory ones', () => {
    const record = graph();
    assert.deepEqual(record.declarations, JSON.parse(read(BOUND, 'lean.json')).data);
    assert.equal(record.declarations['probe:m1demo.double']['is-aeneas-generated'], false);
    assert.equal(record.declarations[FITS]['primary-spec'], THEOREM);
    assert.equal(record.declarations[THEOREM]['is-primary-spec'], false);
    assert.equal(record.declarations[THEOREM]['codomain-is-prop'], false);
    assert.equal(record.anomalies.length, 5);
    assert.ok(record.anomalies.every((item) => item.code === 'aeneas-generated-false-for-translation-declaration'));
  });

  it('without a patch manifest the graph stays complete and the binding says why', () => {
    const record = graph({ manifestText: null });
    assert.equal(record.state, 'complete');
    assert.equal(record.provenance.sourceCommit, null);
    assert.equal(record.provenance.manifestSha256, null);
    assert.deepEqual(record.binding.reasons, ['translation-not-bound-to-manifest', 'no-manifest']);
  });
});

describe('recorded negatives: real probe-lean runs never give an empty-success graph', () => {
  const unbound = (run) => graph({ extractText: read(run, 'lean.json'), logText: read(run, 'probe.log'), receiptText: null });

  it('a run without a receipt is unbound, even the earlier positive', () => {
    const record = unbound('positive-theorem');
    assert.deepEqual(codes(record), ['unbound-run']);
    assert.equal(record.provenance.translationSha256, null);
    assert.deepEqual(record.closures[THEOREM].blockers, [{ code: 'graph-incomplete' }]);
  });

  it('Aeneas library outside defaultTargets, warm cache, no --library: exit 0 from the tool, scope refused here', () => {
    const run = 'neg-default-targets-cache-hit';
    assert.ok(readLog(read(run, 'probe.log')).buildSkipped);
    const record = graph({ extractText: read(run, 'lean.json'), logText: read(run, 'probe.log'), receiptText: read(run, 'receipt.json') });
    assert.equal(record.state, 'incomplete');
    assert.ok(codes(record).includes('scope-not-requested'));
  });

  it('Aeneas library outside defaultTargets, fresh build: incomplete', () => {
    const record = unbound('neg-default-targets-fresh');
    for (const code of ['library-not-built', 'library-not-analysed', 'missing-declarations']) assert.ok(codes(record).includes(code), code);
    const result = cli([recorded('neg-default-targets-fresh', 'lean.json'), '--library', 'M1demo',
      '--log', recorded('neg-default-targets-fresh', 'probe.log'), '--project-root', PROJECT]);
    assert.equal(result.status, 1);
  });

  it('Aeneas library outside defaultTargets, stale cache: atoms present but not built by this run', () => {
    assert.ok(codes(unbound('neg-default-targets')).includes('library-not-built'));
  });

  it('module filter: an extracted definition reported as external is an unresolved edge', () => {
    const record = unbound('neg-module-filter');
    assert.ok(record.edges.some((edge) => edge.from === THEOREM && edge.to === 'probe:m1demo.double' && edge.resolution === 'unresolved'));
    assert.ok(codes(record).includes('missing-declarations'));
  });

  it('empty library: an empty extract (tool exit 0) is incomplete with no closures', () => {
    const record = unbound('neg-empty-library');
    assert.ok(codes(record).includes('empty-extract'));
    assert.deepEqual(record.closures, {});
  });

  it('failed runs (unknown --library, missing Aeneas package) wrote no extract', () => {
    for (const run of ['neg-unknown-library', 'neg-missing-aeneas-package']) {
      assert.ok(!fs.existsSync(recorded(run, 'lean.json')), run);
      assert.match(read(run, 'probe.log'), /^EXIT=1$/m);
      const record = graph({ extractText: '', logText: read(run, 'probe.log'), receiptText: null });
      assert.deepEqual(codes(record), ['unreadable-extract']);
    }
  });
});

describe('derived: missing or contradictory fields are never zero dependencies', () => {
  it('a theorem without its type-dependency lists is malformed, not an empty closure', () => {
    const record = derived({ edit: (data) => {
      delete data[THEOREM]['type-dependencies'];
      delete data[THEOREM]['type-dependencies-external'];
    } });
    assert.equal(record.state, 'incomplete');
    assert.deepEqual(codes(record), ['malformed-atom']);
    assert.deepEqual(record.closures, {});
  });

  it('ill-typed lists, a missing kind or module and non-probe ids are malformed', () => {
    for (const edit of [
      (data) => { data[FITS]['term-dependencies'] = 'probe:m1demo.spec.doubleNat'; },
      (data) => { data[FITS]['term-dependencies-external'].push(7); },
      (data) => { delete data[THEOREM].kind; },
      (data) => { delete data[FITS]['code-module']; },
      (data) => { data[FITS].dependencies = ['m1demo.spec.doubleNat']; },
    ]) {
      assert.deepEqual(codes(derived({ edit })), ['malformed-atom']);
    }
  });

  it('a declaration kind no fixture has qualified blocks', () => {
    const record = derived({ edit: (data) => { data[FITS].kind = 'opaque'; } });
    assert.deepEqual(codes(record), ['unqualified-kind']);
    assert.deepEqual(record.closures[THEOREM].blockers, [{ code: 'graph-incomplete' }]);
  });

  it('a duplicate declaration key is refused, not resolved last-wins', () => {
    const text = read(BOUND, 'lean.json');
    const doubled = text.replace('"probe:m1demo.double":', '"probe:m1demo.double": {"kind": "def"},\n "probe:m1demo.double":');
    assert.notEqual(doubled, text);
    assert.deepEqual(codes(derived({ extractText: doubled })), ['duplicate-declaration']);
  });

  it('a duplicate spelled with a JSON escape is the same declaration', () => {
    const text = read(BOUND, 'lean.json');
    const doubled = text.replace('"probe:m1demo.double":', '"probe:m1demo.double": {"kind": "def"},\n "\\u0070robe:m1demo.double":');
    assert.equal(Object.keys(JSON.parse(doubled).data).length, 9, 'JSON.parse silently keeps one');
    assert.deepEqual(codes(derived({ extractText: doubled })), ['duplicate-declaration']);
  });

  it('an escaped key that is not repeated, and colons or braces inside strings, are fine', () => {
    const text = read(BOUND, 'lean.json');
    const escaped = text.replace('"probe:m1demo.double":', '"\\u0070robe:m1demo.double":');
    assert.notEqual(escaped, text);
    const quoted = escaped.replace('"display-name": "double"', '"display-name": "double", "note": "a: {b} [c] \\" d:"');
    const record = derived({ extractText: quoted });
    assert.equal(record.state, 'complete');
    assert.equal(record.declarations['probe:m1demo.double'].note, 'a: {b} [c] " d:');
  });

  it('a field repeated inside one declaration is refused', () => {
    const text = read(BOUND, 'lean.json');
    const doubled = text.replace('"display-name": "double"', '"display-name": "double", "type-dependencies": []');
    assert.notEqual(doubled, text);
    assert.deepEqual(codes(derived({ extractText: doubled })), ['duplicate-key']);
  });

  it('dependencies disagreeing with type and term dependencies blocks', () => {
    const record = derived({ edit: (data) => { data[FITS].dependencies = []; } });
    assert.deepEqual(codes(record), ['dependency-fields-disagree']);
  });
});

describe('derived: in-project declarations labelled external are unresolved', () => {
  it('a present handwritten definition moved to the external list', () => {
    const record = derived({ edit: (data) => {
      const atom = data[THEOREM];
      atom['type-dependencies'] = atom['type-dependencies'].filter((id) => id !== FITS);
      atom['type-dependencies-external'].push(FITS);
    } });
    assert.deepEqual(codes(record), ['unresolved-edge']);
    assert.ok(!record.external.includes(FITS));
    assert.deepEqual(record.closures[THEOREM].blockers, [{ code: 'graph-incomplete' }, { code: 'unresolved-edge', dependency: FITS }]);
  });

  it('a filtered-out handwritten helper with every use reclassified as external', () => {
    const record = derived({
      edit: (data) => {
        delete data[FITS];
        for (const atom of Object.values(data)) {
          for (const kind of ['type', 'term']) {
            if (!atom[`${kind}-dependencies`].includes(FITS)) continue;
            atom[`${kind}-dependencies`] = atom[`${kind}-dependencies`].filter((id) => id !== FITS);
            atom[`${kind}-dependencies-external`].push(FITS);
          }
          atom.dependencies = atom.dependencies.filter((id) => id !== FITS);
        }
      },
      log: wrote(8),
    });
    assert.deepEqual(record.completeness.missingDeclarations, [FITS]);
    assert.deepEqual(codes(record), ['missing-declarations', 'unresolved-edge']);
  });
});

describe('derived: completeness needs the requested scope, not one atom or a cache message', () => {
  it('an extract of the generated module alone omits the spec module', () => {
    const record = derived({
      edit: (data) => { for (const id of Object.keys(data)) if (data[id]['code-module'] === 'M1demo.Spec') delete data[id]; },
      log: wrote(5),
    });
    assert.deepEqual(codes(record), ['missing-declarations']);
    assert.equal(record.completeness.missingDeclarations.length, 4);
    assert.deepEqual(record.closures, {});
  });

  it('a run filtered by --module, or whose lake build missed the library, is refused', () => {
    assert.deepEqual(codes(derived({ receipt: (r) => r.probe.argv.push('--module', 'M1demo.Spec') })), ['scope-not-requested']);
    assert.deepEqual(codes(derived({ receipt: (r) => { r.lakeBuild.argv = ['lake', 'build']; } })), ['scope-not-requested']);
    assert.deepEqual(codes(derived({ receipt: (r) => { r.lakeBuild.exitCode = 1; } })), ['run-failed']);
  });

  it('a project module outside the requested libraries blocks', () => {
    const projectRoot = projectCopy((directory) => fs.writeFileSync(path.join(directory, 'Other.lean'), 'def other : Nat := 1\n'));
    const record = derived({ projectRoot, receipt: (r) => { r.inputs.files = projectInputs(projectRoot); } });
    assert.deepEqual(codes(record), ['modules-outside-scope']);
  });

  it('a requested module whose .ilean the run never produced blocks', () => {
    const projectRoot = projectCopy((directory) => fs.rmSync(path.join(directory, '.lake/build/lib/lean/M1demo/Spec.ilean')));
    const record = derived({ projectRoot, receipt: (r) => { r.inputs.files = projectInputs(projectRoot); } });
    assert.deepEqual(codes(record), ['missing-ilean', 'atom-outside-scope']);
  });

  it('a recorded receipt that no longer lists a module .ilean on disk blocks', () => {
    const record = derived({ receipt: (r) => { delete r.inputs.files['.lake/build/lib/lean/M1demo/Spec.ilean']; } });
    assert.deepEqual(codes(record), ['inputs-changed']);
  });
});

describe('derived: provenance binds the extract, log and inputs to one run', () => {
  it('an older extract and log cannot adopt the bound run', () => {
    const stale = graph({ extractText: read('positive-theorem', 'lean.json'), logText: read('positive-theorem', 'probe.log') });
    assert.deepEqual(codes(stale), ['run-mismatch', 'run-mismatch']);
    assert.deepEqual(codes(graph({ logText: read('positive-theorem', 'probe.log') })), ['run-mismatch']);
  });

  it('a changed translation.json is not adopted', () => {
    const projectRoot = projectCopy((directory) => {
      const file = path.join(directory, 'M1demo', 'translation.json');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"0.1.274"', '"0.1.275"'));
    });
    const record = graph({ projectRoot });
    assert.deepEqual(codes(record), ['inputs-changed']);
    assert.equal(record.provenance.translationSha256, null);
    assert.equal(record.provenance.charonVersion, null);
  });

  it('an invalid Lean project commit blocks', () => {
    const record = derived({ edit: (data, envelope) => { envelope.source.commit = 'eef73c8'; }, receipt: (r) => { r.inputs.leanProjectCommit = 'eef73c8'; } });
    assert.deepEqual(codes(record), ['invalid-lean-commit']);
  });

  it('a receipt for another commit, or no receipt at all, blocks', () => {
    assert.deepEqual(codes(derived({ receipt: (r) => { r.inputs.leanProjectCommit = '8c8955e1193744a42ee464d56893c87d8a172826'; } })), ['run-mismatch']);
    assert.deepEqual(codes(graph({ receiptText: null })), ['unbound-run']);
    assert.deepEqual(codes(graph({ receiptText: '{"schema":"fvs/lean-probe-run"}' })), ['invalid-receipt']);
  });

  it('a manifest of the wrong kind is refused, not hashed', () => {
    const record = graph({ manifestText: fs.readFileSync(path.join(PROJECT, 'lake-manifest.json'), 'utf8') });
    assert.deepEqual(codes(record), ['invalid-manifest']);
    assert.equal(record.provenance.manifestSha256, null);
    assert.equal(record.provenance.sourceCommit, null);
    const dirty = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    dirty.source.dirty = ['src/lib.rs'];
    assert.deepEqual(codes(graph({ manifestText: JSON.stringify(dirty) })), ['invalid-manifest']);
  });
});

describe('derived: other edits of the bound positive', () => {
  it('a truncated extract is incomplete, never a smaller graph', () => {
    const text = read(BOUND, 'lean.json');
    const record = graph({ extractText: text.slice(0, Math.floor(text.length / 2)) });
    assert.deepEqual(codes(record), ['unreadable-extract']);
    assert.deepEqual(record.declarations, {});
  });

  it('a truncated log or a disagreeing atom count is incomplete', () => {
    assert.deepEqual(codes(derived({ log: (text) => text.replace(/^Wrote .*$/m, '') })), ['log-incomplete']);
    assert.deepEqual(codes(derived({ log: wrote(10) })), ['atom-count-mismatch']);
  });

  it('a dropped proof-only lemma does not enter the closure, but still blocks the graph', () => {
    const record = derived({ edit: (data) => { delete data['probe:m1demo.spec.doubleNat_eq']; }, log: wrote(8) });
    assert.deepEqual(codes(record), ['missing-declarations', 'unresolved-edge']);
    assert.deepEqual(record.closures[THEOREM].blockers, [{ code: 'graph-incomplete' }]);
  });

  it('an unqualified tool version or schema is unsupported', () => {
    for (const edit of [
      (data, envelope) => { envelope.tool.version = '0.13.0'; },
      (data, envelope) => { envelope['schema-version'] = '2.0'; },
      (data, envelope) => { envelope.schema = 'probe-aeneas/extract'; },
    ]) {
      const record = derived({ edit });
      assert.equal(record.state, 'unsupported');
      assert.deepEqual(codes(record), ['unqualified-interface']);
    }
  });

  it('rejects a missing --library as a usage error', () => {
    const result = cli([recorded(BOUND, 'lean.json')]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--library is required/);
  });
});
