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
// A derived run's constants record: the recorded one, re-bound to the files the
// derived receipt names (the edits these tests make do not change declarations).
const rebound = (run, files) => JSON.stringify({ ...JSON.parse(read(run, 'constants.json')), inputs: { files } });
const THEOREM = 'probe:m1demo.spec.double_spec';
const FITS = 'probe:m1demo.spec.DoubleFits';
const temporaryDirectories = [];

let buildLeanGraph;
let readLog;
let projectInputs;
let moduleHeader;
before(async () => {
  ({ buildLeanGraph, readLog, projectInputs, moduleHeader } = await import(pathToFileURL(SCRIPT).href));
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
    constantsText: read(BOUND, 'constants.json'),
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
  return graph({ extractText: text, logText, receiptText: JSON.stringify(signed), projectRoot,
    constantsText: rebound(BOUND, signed.inputs.files) });
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
// A receipt-bound run whose constants record does not bind the compiled modules
// (every recorded run before the compiled-module receipts) ends with this blocker.
const withUnverified = (list) => [...list, 'fidelity-unverified'];
const local = (record, kind, from) => record.edges
  .filter((edge) => edge.from === from && edge.kind === kind && edge.resolution === 'local')
  .map((edge) => edge.to).sort();

describe('recorded positive: a bound run of a proved theorem over an extracted definition', () => {
  it('is structurally complete and records provenance, but without compiled-module binding its fidelity is unverified', () => {
    const result = cli([recorded(BOUND, 'lean.json'), '--library', 'M1demo', '--log', recorded(BOUND, 'probe.log'),
      '--receipt', recorded(BOUND, 'receipt.json'), '--project-root', PROJECT, '--manifest', MANIFEST,
      '--constants', recorded(BOUND, 'constants.json')]);
    assert.equal(result.status, 1, result.stderr);
    const record = JSON.parse(result.stdout);
    assert.equal(record.state, 'incomplete');
    assert.deepEqual(codes(record), ['fidelity-unverified']);
    assert.match(record.blockers[0].reason, /compiled-environment-not-bound/);
    assert.deepEqual(record.provenance, {
      sourceCommit: '8c8955e1193744a42ee464d56893c87d8a172826',
      leanProjectCommit: 'eef73c8fedf3fbcb640c35467b52b63ca6b7c1bd',
      translationSha256: 'bb20ee964531c310e47f3bc466e5e1ac5aefe25cfa0f2df04cd4bd5644265093',
      charonVersion: '0.1.274',
      aeneasVersion: 'nightly-2026.09.30-0855ce1',
      manifestSha256: '02b41307fa63ec30eecd79a9bb6fad390416aa170993b5d13a1dd0648978ad89',
      llbcSha256: null,
      configSha256: null,
    });
    assert.deepEqual(record.binding, {
      status: 'unbound',
      reasons: ['no-state'],
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
    assert.deepEqual(closure.blockers, [{ code: 'graph-incomplete' }]);
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

  it('without a patch manifest no new blocker appears and the binding says why', () => {
    const record = graph({ manifestText: null });
    assert.deepEqual(codes(record), ['fidelity-unverified']);
    assert.equal(record.provenance.sourceCommit, null);
    assert.equal(record.provenance.manifestSha256, null);
    assert.deepEqual(record.binding.reasons, ['no-state', 'no-manifest']);
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
    assert.deepEqual(codes(record), withUnverified(['unqualified-kind']));
    assert.deepEqual(record.closures[THEOREM].blockers, [{ code: 'graph-incomplete' }]);
  });

  it('a duplicate declaration key is refused, not resolved last-wins', () => {
    const text = read(BOUND, 'lean.json');
    const doubled = text.replace('"probe:m1demo.double":', '"probe:m1demo.double": {"kind": "def"},\n "probe:m1demo.double":');
    assert.notEqual(doubled, text);
    assert.deepEqual(codes(derived({ extractText: doubled })), withUnverified(['duplicate-declaration']));
  });

  it('a duplicate spelled with a JSON escape is the same declaration', () => {
    const text = read(BOUND, 'lean.json');
    const doubled = text.replace('"probe:m1demo.double":', '"probe:m1demo.double": {"kind": "def"},\n "\\u0070robe:m1demo.double":');
    assert.equal(Object.keys(JSON.parse(doubled).data).length, 9, 'JSON.parse silently keeps one');
    assert.deepEqual(codes(derived({ extractText: doubled })), withUnverified(['duplicate-declaration']));
  });

  it('an escaped key that is not repeated, and colons or braces inside strings, are fine', () => {
    const text = read(BOUND, 'lean.json');
    const escaped = text.replace('"probe:m1demo.double":', '"\\u0070robe:m1demo.double":');
    assert.notEqual(escaped, text);
    const quoted = escaped.replace('"display-name": "double"', '"display-name": "double", "note": "a: {b} [c] \\" d:"');
    const record = derived({ extractText: quoted });
    assert.deepEqual(codes(record), withUnverified([]));
    assert.equal(record.declarations['probe:m1demo.double'].note, 'a: {b} [c] " d:');
  });

  it('a field repeated inside one declaration is refused', () => {
    const text = read(BOUND, 'lean.json');
    const doubled = text.replace('"display-name": "double"', '"display-name": "double", "type-dependencies": []');
    assert.notEqual(doubled, text);
    assert.deepEqual(codes(derived({ extractText: doubled })), withUnverified(['duplicate-key']));
  });

  it('dependencies disagreeing with type and term dependencies blocks', () => {
    const record = derived({ edit: (data) => { data[FITS].dependencies = []; } });
    assert.deepEqual(codes(record), withUnverified(['dependency-fields-disagree']));
  });
});

describe('derived: in-project declarations labelled external are unresolved', () => {
  it('a present handwritten definition moved to the external list', () => {
    const record = derived({ edit: (data) => {
      const atom = data[THEOREM];
      atom['type-dependencies'] = atom['type-dependencies'].filter((id) => id !== FITS);
      atom['type-dependencies-external'].push(FITS);
    } });
    assert.deepEqual(codes(record), withUnverified(['unresolved-edge']));
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
    assert.deepEqual(codes(record), withUnverified(['missing-declarations', 'unresolved-edge']));
  });
});

describe('derived: completeness needs the requested scope, not one atom or a cache message', () => {
  it('an extract of the generated module alone omits the spec module', () => {
    const record = derived({
      edit: (data) => { for (const id of Object.keys(data)) if (data[id]['code-module'] === 'M1demo.Spec') delete data[id]; },
      log: wrote(5),
    });
    assert.deepEqual(codes(record), withUnverified(['missing-declarations']));
    assert.equal(record.completeness.missingDeclarations.length, 4);
    assert.deepEqual(record.closures, {});
  });

  it('a run filtered by --module, or whose lake build missed the library, is refused', () => {
    assert.deepEqual(codes(derived({ receipt: (r) => r.probe.argv.push('--module', 'M1demo.Spec') })), withUnverified(['scope-not-requested']));
    assert.deepEqual(codes(derived({ receipt: (r) => { r.lakeBuild.argv = ['lake', 'build']; } })), withUnverified(['scope-not-requested']));
    assert.deepEqual(codes(derived({ receipt: (r) => { r.lakeBuild.exitCode = 1; } })), withUnverified(['run-failed']));
  });

  it('a project module outside the requested libraries blocks', () => {
    const projectRoot = projectCopy((directory) => fs.writeFileSync(path.join(directory, 'Other.lean'), 'def other : Nat := 1\n'));
    const record = derived({ projectRoot, receipt: (r) => { r.inputs.files = projectInputs(projectRoot); } });
    assert.deepEqual(codes(record), withUnverified(['modules-outside-scope']));
  });

  it('a requested module whose .ilean the run never produced blocks', () => {
    const projectRoot = projectCopy((directory) => fs.rmSync(path.join(directory, '.lake/build/lib/lean/M1demo/Spec.ilean')));
    const record = derived({ projectRoot, receipt: (r) => { r.inputs.files = projectInputs(projectRoot); } });
    assert.deepEqual(codes(record), withUnverified(['missing-ilean', 'atom-outside-scope']));
  });

  it('a recorded receipt that no longer lists a module .ilean on disk blocks', () => {
    const record = derived({ receipt: (r) => { delete r.inputs.files['.lake/build/lib/lean/M1demo/Spec.ilean']; } });
    assert.deepEqual(codes(record), ['inputs-changed']);
  });
});

describe('derived: provenance binds the extract, log and inputs to one run', () => {
  it('an older extract and log cannot adopt the bound run', () => {
    const stale = graph({ extractText: read('positive-theorem', 'lean.json'), logText: read('positive-theorem', 'probe.log') });
    assert.deepEqual(codes(stale), withUnverified(['run-mismatch', 'run-mismatch']));
    assert.deepEqual(codes(graph({ logText: read('positive-theorem', 'probe.log') })), withUnverified(['run-mismatch']));
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
    assert.deepEqual(codes(record), withUnverified(['invalid-lean-commit']));
  });

  it('a receipt for another commit, or no receipt at all, blocks', () => {
    assert.deepEqual(codes(derived({ receipt: (r) => { r.inputs.leanProjectCommit = '8c8955e1193744a42ee464d56893c87d8a172826'; } })), withUnverified(['run-mismatch']));
    assert.deepEqual(codes(graph({ receiptText: null })), ['unbound-run']);
    assert.deepEqual(codes(graph({ receiptText: '{"schema":"fvs/lean-probe-run"}' })), ['invalid-receipt']);
  });

  it('a manifest of the wrong kind is refused, not hashed', () => {
    const record = graph({ manifestText: fs.readFileSync(path.join(PROJECT, 'lake-manifest.json'), 'utf8') });
    assert.deepEqual(codes(record), withUnverified(['invalid-manifest']));
    assert.equal(record.provenance.manifestSha256, null);
    assert.equal(record.provenance.sourceCommit, null);
    const dirty = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    dirty.source.dirty = ['src/lib.rs'];
    assert.deepEqual(codes(graph({ manifestText: JSON.stringify(dirty) })), withUnverified(['invalid-manifest']));
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
    assert.deepEqual(codes(derived({ log: (text) => text.replace(/^Wrote .*$/m, '') })), withUnverified(['log-incomplete']));
    assert.deepEqual(codes(derived({ log: wrote(10) })), withUnverified(['atom-count-mismatch']));
  });

  it('a dropped proof-only lemma does not enter the closure, but still blocks the graph', () => {
    const record = derived({ edit: (data) => { delete data['probe:m1demo.spec.doubleNat_eq']; }, log: wrote(8) });
    assert.deepEqual(codes(record), withUnverified(['missing-declarations', 'unresolved-edge']));
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

describe('binding to the recorded extraction attempt', () => {
  const PUBLISHED = path.join(FIXTURES, 'bound-project');
  const ATTEMPT_MANIFEST = path.join(FIXTURES, 'extraction', 'attempt-manifest.json');
  const STATE = '.formalising/auto-fv/state.json';
  const LIBS = ['M1demo', 'Specs'];

  // The bound project as the run saw it: the fixture files plus the recorded
  // state, which lives beside the run because .formalising/ paths are kept out
  // of the repository.
  function boundProject() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-lean-binding-'));
    temporaryDirectories.push(root);
    fs.cpSync(PUBLISHED, root, { recursive: true });
    fs.mkdirSync(path.join(root, path.dirname(STATE)), { recursive: true });
    fs.copyFileSync(recorded('bound-positive', 'state.json'), path.join(root, STATE));
    return root;
  }

  function boundGraph(run = 'bound-positive', overrides = {}) {
    return buildLeanGraph({
      extractText: read(run, 'lean.json'),
      logText: read(run, 'probe.log'),
      receiptText: read(run, 'receipt.json'),
      libraries: LIBS,
      projectRoot: overrides.projectRoot ?? boundProject(),
      manifestText: fs.readFileSync(ATTEMPT_MANIFEST, 'utf8'),
      constantsText: run === 'bound-positive' ? read('bound-positive', 'constants.json') : null,
      ...overrides,
    });
  }

  // A copy of the bound project with its state or files edited, and the
  // receipt re-signed over the edited inputs (or left stale when asked).
  function edited({ state = null, project = () => {}, resign = true, extract = null, receipt: editReceipt = () => {}, ...overrides } = {}) {
    const root = boundProject();
    if (state) {
      const file = path.join(root, STATE);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      state(parsed, parsed.extraction.run);
      fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
    }
    project(root);
    const receipt = JSON.parse(read('bound-positive', 'receipt.json'));
    let extractText = read('bound-positive', 'lean.json');
    if (extract) {
      const envelope = JSON.parse(extractText);
      extract(envelope.data);
      extractText = JSON.stringify(envelope);
      receipt.outputs.extractSha256 = sha256(extractText);
    }
    if (resign) receipt.inputs.files = projectInputs(root);
    editReceipt(receipt);
    return boundGraph('bound-positive', { projectRoot: root, extractText, receiptText: JSON.stringify(receipt),
      constantsText: rebound('bound-positive', receipt.inputs.files), ...overrides });
  }
  const binding = (record) => [record.binding.status, ...record.binding.reasons];

  it('recorded positive: the analysed generated Lean is the published output, so the record is bound', () => {
    const root = boundProject();
    assert.deepEqual(projectInputs(root), JSON.parse(read('bound-positive', 'receipt.json')).inputs.files);
    const result = cli([recorded('bound-positive', 'lean.json'), '--library', LIBS.join(','),
      '--log', recorded('bound-positive', 'probe.log'), '--receipt', recorded('bound-positive', 'receipt.json'),
      '--project-root', root, '--manifest', ATTEMPT_MANIFEST, '--constants', recorded('bound-positive', 'constants.json')]);
    assert.equal(result.status, 1, result.stderr);
    const record = JSON.parse(result.stdout);
    assert.deepEqual(codes(record), ['fidelity-unverified']);
    const run = JSON.parse(read('bound-positive', 'state.json')).extraction.run;
    assert.equal(record.binding.status, 'bound');
    assert.equal(record.binding.trust, 'local-host-and-reviewed-scripts');
    assert.equal(record.binding.configSha256, run.configSha256);
    assert.deepEqual(record.binding.generatedLean, run.publication.map(({ projectPath, sha256: hash }) => ({ projectPath, sha256: hash })));
    assert.equal(record.provenance.llbcSha256, run.llbc.sha256);
    assert.equal(record.provenance.configSha256, run.configSha256);
    assert.equal(record.provenance.translationSha256, run.translation.sha256);
    assert.equal(record.provenance.sourceCommit, record.provenance.leanProjectCommit);
    assert.deepEqual(Object.keys(record.completeness.modules), ['M1demo', 'M1demo.M1demo', 'Specs', 'Specs.Double']);
    assert.deepEqual(record.closures[THEOREM].declarations, ['probe:m1demo.double', FITS, 'probe:m1demo.spec.doubleNat']);
  });

  it('recorded negative: a hand-edited published body (tools exit 0) blocks', () => {
    const root = boundProject();
    fs.copyFileSync(recorded('bound-mutated-body', 'M1demo.lean'), path.join(root, 'M1demo', 'M1demo.lean'));
    const record = boundGraph('bound-mutated-body', { projectRoot: root });
    // No Lean constants record was taken for this run.
    assert.deepEqual(codes(record), ['generated-lean-differs-from-attempt', 'fidelity-unverified']);
    assert.deepEqual(binding(record), ['unbound', 'inputs-disagree-with-attempt']);
    assert.equal(record.provenance.llbcSha256, null);
  });

  it('seeded mutation: another configuration\'s Lean body under this attempt\'s state blocks', () => {
    // The published M1demo.lean of a recorded --features alt attempt (same translation.json as its
    // positive, different Lean bytes), placed over this project's published file.
    const record = edited({ project: (root) => fs.copyFileSync(path.join(FIXTURES, 'seeded', 'feature-alt-M1demo.lean'),
      path.join(root, 'M1demo', 'M1demo.lean')) });
    assert.deepEqual(codes(record), withUnverified(['generated-lean-differs-from-attempt']));
    assert.deepEqual(binding(record), ['unbound', 'inputs-disagree-with-attempt']);
  });

  it('a copy reached through a symbolic link still binds by content', () => {
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-lean-alias-')), 'project');
    temporaryDirectories.push(path.dirname(link));
    fs.symlinkSync(boundProject(), link);
    assert.deepEqual(binding(boundGraph('bound-positive', { projectRoot: link })), ['bound']);
  });

  it('absent or unsupported evidence leaves the binding unbound without adding a graph blocker', () => {
    const cases = [
      [{ project: (root) => fs.rmSync(path.join(root, STATE)) }, ['unbound', 'no-state']],
      [{ state: (s) => { delete s.extraction.run; } }, ['unbound', 'no-extraction-attempt']],
      [{ state: (s, run) => { run.supported = false; } }, ['unbound', 'unsupported-configuration']],
      [{ state: (s) => { s.extraction.status = 'failed'; s.extraction.reasons = ['the build failed']; } }, ['unbound', 'extraction-not-succeeded']],
      [{ state: (s, run) => { run.residuals = ['.cargo/config.toml']; } }, ['unbound', 'unsupported-configuration']],
      [{ manifestText: null }, ['unbound', 'no-manifest']],
    ];
    for (const [edit, expected] of cases) {
      const record = edited(edit);
      assert.deepEqual(codes(record), withUnverified([]), JSON.stringify(expected));
      assert.deepEqual(binding(record), expected);
      assert.equal(record.provenance.llbcSha256, null);
    }
    assert.deepEqual(binding(boundGraph('bound-positive', { receiptText: null })), ['unbound', 'run-not-bound']);
  });

  it('evidence that disagrees with the attempt blocks', () => {
    const cases = [
      [{ manifestText: fs.readFileSync(MANIFEST, 'utf8') }, ['attempt-manifest-mismatch']],
      [{ state: (s, run) => { run.config.extra = true; } }, ['attempt-config-mismatch']],
      [{ state: (s, run) => { run.publication = run.publication.filter((entry) => entry.projectPath === run.translation.projectPath); } },
        ['attempt-publication-mismatch', 'generated-declaration-outside-publication']],
      [{ state: (s, run) => { run.publication.push({ ...run.publication[0], attemptPath: '/x/Extra.lean', projectPath: path.posix.join(path.posix.dirname(run.translation.projectPath), 'Extra.lean') }); } },
        ['generated-lean-differs-from-attempt', 'attempt-publication-mismatch']],
      [{ state: (s, run) => { for (const entry of [run.translation, ...run.publication]) if (entry.projectPath.endsWith('translation.json')) entry.sha256 = '0'.repeat(64); } },
        ['attempt-translation-mismatch', 'generated-lean-differs-from-attempt']],
      [{ state: (s) => { s.extraction.inputs.crateRoot = '/elsewhere'; } },
        ['attempt-translation-mismatch', 'generated-lean-differs-from-attempt', 'attempt-publication-mismatch', 'generated-declaration-outside-publication']],
      [{ extract: (data) => { data['probe:m1demo.clamp']['code-path'] = 'Specs/Double.lean'; } }, ['generated-declaration-outside-publication']],
    ];
    for (const [edit, expected] of cases) {
      const record = edited(edit);
      assert.deepEqual(codes(record), withUnverified(expected));
      assert.deepEqual(binding(record), ['unbound', 'inputs-disagree-with-attempt']);
    }
  });

  it('a malformed or empty recorded publication is refused by the state validator', () => {
    for (const state of [(s, run) => { run.publication = []; }, (s, run) => { delete run.translation; }, (s, run) => { run.llbc = 'x'; }]) {
      const record = edited({ state });
      assert.deepEqual(codes(record), withUnverified(['malformed-state']));
      assert.equal(record.binding.status, 'unbound');
    }
  });

  it('a receipt that fails its own checks never binds, even when the project files match', () => {
    const cases = [
      [{ extractText: JSON.stringify(JSON.parse(read('bound-positive', 'lean.json'))) }, 'run-mismatch'],
      [{ logText: `${read('bound-positive', 'probe.log')}\n` }, 'run-mismatch'],
      [{ receipt: (r) => { r.probe.exitCode = 1; } }, 'run-failed'],
      [{ receipt: (r) => { r.lakeBuild.exitCode = 2; } }, 'run-failed'],
      [{ receipt: (r) => { r.inputs.leanProjectCommit = 'f'.repeat(40); } }, 'run-mismatch'],
      [{ receipt: (r) => { r.probe.argv.push('--module', 'Specs.Double'); } }, 'scope-not-requested'],
    ];
    for (const [edit, code] of cases) {
      const record = edited(edit);
      assert.equal(record.state, 'incomplete', code);
      assert.deepEqual(codes(record), withUnverified([code]));
      assert.deepEqual(binding(record), ['unbound', 'run-receipt-disagrees']);
      assert.equal(record.binding.generatedLean, undefined);
      assert.equal(record.provenance.llbcSha256, null);
      assert.equal(record.provenance.configSha256, null);
    }
  });

  it('the CLI reports a failed recorded run as incomplete and unbound', () => {
    const root = boundProject();
    const receipt = JSON.parse(read('bound-positive', 'receipt.json'));
    receipt.probe.exitCode = 1;
    const file = path.join(root, 'failed-receipt.json');
    fs.writeFileSync(file, JSON.stringify(receipt));
    const result = cli([recorded('bound-positive', 'lean.json'), '--library', LIBS.join(','),
      '--log', recorded('bound-positive', 'probe.log'), '--receipt', file, '--project-root', root, '--manifest', ATTEMPT_MANIFEST,
      '--constants', recorded('bound-positive', 'constants.json')]);
    assert.equal(result.status, 1);
    const record = JSON.parse(result.stdout);
    assert.deepEqual(codes(record), withUnverified(['run-failed']));
    assert.deepEqual(binding(record), ['unbound', 'run-receipt-disagrees']);
  });

  it('publication entries that alias after normalisation are refused, not collapsed', () => {
    // Labelled state mutation: a second M1demo.lean entry spelled with /./ in both recorded paths.
    const record = edited({ state: (s, run) => {
      const lean = run.publication.find((entry) => entry.projectPath.endsWith('/M1demo.lean'));
      const alias = (file) => file.replace(/\/M1demo\.lean$/, '/./M1demo.lean');
      run.publication.push({ ...lean, attemptPath: alias(lean.attemptPath), projectPath: alias(lean.projectPath) });
    } });
    assert.deepEqual(codes(record), withUnverified(['attempt-publication-alias']));
    assert.deepEqual(binding(record), ['unbound', 'inputs-disagree-with-attempt']);
  });

  it('an alias in only the project path or only the attempt path is refused too', () => {
    const lean = (run) => run.publication.find((entry) => entry.projectPath.endsWith('/M1demo.lean'));
    const projectOnly = edited({ state: (s, run) => {
      const entry = lean(run);
      run.publication.push({ ...entry, attemptPath: entry.attemptPath.replace(/M1demo\.lean$/, 'Copy.lean'),
        projectPath: entry.projectPath.replace(/\/M1demo\.lean$/, '//M1demo.lean') });
    } });
    assert.deepEqual(codes(projectOnly), withUnverified(['attempt-publication-alias']));
    const attemptOnly = edited({ state: (s, run) => {
      const entry = lean(run);
      const specs = path.posix.join(s.extraction.inputs.crateRoot, 'Specs.lean');
      run.publication.push({ attemptPath: entry.attemptPath.replace(/\/M1demo\.lean$/, '/./M1demo.lean'), projectPath: specs,
        sha256: projectInputs(PUBLISHED)['Specs.lean'] });
    } });
    assert.ok(codes(attemptOnly).includes('attempt-publication-alias'));
    assert.deepEqual(binding(attemptOnly), ['unbound', 'inputs-disagree-with-attempt']);
  });

  it('a state changed after the probe run is stale, not adopted', () => {
    const record = edited({ state: (s, run) => { run.supported = false; }, resign: false });
    assert.deepEqual(codes(record), ['inputs-changed']);
    assert.deepEqual(binding(record), ['unbound', 'run-not-bound']);
  });
});

describe('omitted external lists and the structure and projection kinds', () => {
  const KINDS = path.join(FIXTURES, 'kinds-project');
  const ATTEMPT_MANIFEST = path.join(FIXTURES, 'extraction', 'attempt-manifest.json');
  const STATE = '.formalising/auto-fv/state.json';
  const LIBS = ['M1demo', 'Specs'];
  const A = 'sparse-structures';
  const B = 'sparse-kinds';
  const K = (name) => `probe:m1demo.kinds.${name}`;

  // Run A's project, or run B's (the same project with B's Kinds module), with
  // the recorded state put back in place.
  function kindsProject(run = A) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-lean-kinds-'));
    temporaryDirectories.push(root);
    fs.cpSync(KINDS, root, { recursive: true });
    fs.mkdirSync(path.join(root, path.dirname(STATE)), { recursive: true });
    fs.copyFileSync(recorded('bound-positive', 'state.json'), path.join(root, STATE));
    if (run === B) {
      fs.copyFileSync(recorded(B, 'Kinds.lean'), path.join(root, 'Specs', 'Kinds.lean'));
      fs.copyFileSync(recorded(B, 'Kinds.ilean'), path.join(root, '.lake', 'build', 'lib', 'lean', 'Specs', 'Kinds.ilean'));
    }
    return root;
  }

  function kindsGraph(run = A, overrides = {}) {
    return buildLeanGraph({
      extractText: read(run, 'lean.json'),
      logText: read(run, 'probe.log'),
      receiptText: read(run, 'receipt.json'),
      libraries: LIBS,
      projectRoot: kindsProject(run),
      manifestText: fs.readFileSync(ATTEMPT_MANIFEST, 'utf8'),
      constantsText: run === A ? read(A, 'constants.json') : null,
      ...overrides,
    });
  }

  // An edit of run A's extract (and log), with the receipt re-signed over it.
  function kindsDerived(edit, log = (text) => text) {
    const envelope = JSON.parse(read(A, 'lean.json'));
    edit(envelope.data);
    const extractText = JSON.stringify(envelope);
    const logText = log(read(A, 'probe.log'));
    const receipt = JSON.parse(read(A, 'receipt.json'));
    receipt.outputs = { extractSha256: sha256(extractText), logSha256: sha256(logText) };
    return kindsGraph(A, { extractText, logText, receiptText: JSON.stringify(receipt) });
  }

  it('recorded qualification: an external list is omitted exactly when Lean records no external constant', () => {
    for (const run of [A, B]) {
      const lean = JSON.parse(read(run, 'lean-constants.json').trim().split('\n').at(-1));
      const project = new Set(lean.map((entry) => entry.name));
      const byName = new Map(lean.map((entry) => [entry.name, entry]));
      const data = JSON.parse(read(run, 'lean.json')).data;
      let lists = 0;
      for (const [id, atom] of Object.entries(data)) {
        const truth = byName.get(id.slice('probe:'.length));
        assert.ok(truth, id);
        assert.ok(truth.kind !== 'theorem' || truth.hasValue, `${id}: Lean ground truth must include the proof`);
        for (const [field, source] of [['type-dependencies-external', 'type'], ['term-dependencies-external', 'value']]) {
          const external = truth[source].filter((name) => !project.has(name));
          assert.equal(Object.hasOwn(atom, field), external.length > 0, `${run} ${id} ${field}`);
          if (Object.hasOwn(atom, field)) assert.ok(atom[field].length > 0);
          lists += 1;
        }
        for (const field of ['type-dependencies', 'term-dependencies', 'dependencies']) assert.ok(Array.isArray(atom[field]), `${id} ${field}`);
      }
      assert.equal(lists, 54);
    }
  });

  it('recorded run A: structures, projections and instances give a structurally complete, bound graph', () => {
    const root = kindsProject(A);
    const result = cli([recorded(A, 'lean.json'), '--library', LIBS.join(','), '--log', recorded(A, 'probe.log'),
      '--receipt', recorded(A, 'receipt.json'), '--project-root', root, '--manifest', ATTEMPT_MANIFEST,
      '--constants', recorded(A, 'constants.json')]);
    assert.equal(result.status, 1, result.stderr);
    const record = JSON.parse(result.stdout);
    assert.deepEqual(codes(record), ['fidelity-unverified']);
    assert.equal(record.binding.status, 'bound');
    assert.deepEqual(record.closures[K('wrap_x')].declarations, [K('Pt'), K('Pt.x'), K('Pt.y'), K('Wrap'), K('Wrap.pt')]);
    assert.deepEqual(record.closures[K('wrap_x')].external, ['probe:Eq', 'probe:Nat']);
    assert.deepEqual(record.closures[K('meter_v')].declarations, [K('Meter'), K('Meter.v')]);
    assert.deepEqual(record.closures[K('meter_v')].external, ['probe:Aeneas.Std.U32', 'probe:Eq']);
    assert.deepEqual(record.closures[K('selfImp')].declarations, []);
    assert.equal(record.declarations[K('shiftPt')].kind, 'def');
    // Raw atoms stay verbatim: the omitted lists are not filled in.
    assert.ok(!Object.hasOwn(record.declarations[K('idT')], 'type-dependencies-external'));
    assert.ok(!Object.hasOwn(record.declarations[K('Pt')], 'term-dependencies-external'));
    assert.ok(!record.edges.some((edge) => edge.from === K('idT')));
  });

  it('coverage counts every declaration the module defines, not only the .ilean decls list', () => {
    const record = kindsGraph(A);
    for (const name of ['idT', 'selfImp', 'Pt.x', 'Wrap.pt']) assert.ok(record.completeness.modules['Specs.Kinds'].includes(`m1demo.kinds.${name}`), name);
    const dropped = kindsDerived((data) => { delete data[K('idT')]; }, (text) => text.replace('Wrote 27 ', 'Wrote 26 '));
    assert.deepEqual(codes(dropped), withUnverified(['missing-declarations']));
    assert.deepEqual(dropped.completeness.missingDeclarations, [K('idT')]);
  });

  it('recorded run B: an inductive type stays unqualified, and its constructors are missing', () => {
    const record = kindsGraph(B);
    assert.equal(record.state, 'incomplete');
    assert.deepEqual(codes(record), ['unqualified-kind', 'missing-declarations', 'unresolved-edge', 'fidelity-unverified']);
    assert.deepEqual(record.completeness.missingDeclarations, [K('Color.green'), K('Color.red')]);
    assert.equal(record.blockers[0].declaration, K('Color'));
  });

  it('a present empty external list or an absent local list is malformed', () => {
    assert.deepEqual(codes(kindsDerived((data) => { data[K('Pt.x')]['term-dependencies-external'] = []; })), ['malformed-atom']);
    assert.deepEqual(codes(kindsDerived((data) => { delete data[K('idT')]['type-dependencies']; })), ['malformed-atom']);
    assert.deepEqual(codes(kindsDerived((data) => { data[K('twice')]['type-dependencies-external'] = 'probe:Nat'; })), ['malformed-atom']);
  });

  it('an omitted list on an unqualified kind is not accepted', () => {
    assert.deepEqual(codes(kindsDerived((data) => { data[K('Pt')].kind = 'inductive'; })), withUnverified(['unqualified-kind']));
  });

  it('an external list dropped after the run is caught by the receipt, never read as empty', () => {
    const envelope = JSON.parse(read(A, 'lean.json'));
    delete envelope.data[K('twice')]['type-dependencies-external'];
    const record = kindsGraph(A, { extractText: JSON.stringify(envelope) });
    // The receipt catches the edit (run A's receipt has no compiled modules, so fidelity is not reached).
    assert.deepEqual(codes(record), withUnverified(['run-mismatch']));
    assert.deepEqual([record.binding.status, ...record.binding.reasons], ['unbound', 'run-receipt-disagrees']);
  });
});

describe('dependency fidelity against the Lean constants record', () => {
  // The compiled-module-bound run: probe-lean and the Lean constants oracle on
  // run A's project, both recording the same compiled modules.
  const RUN = 'compiled-run';
  const KINDS = path.join(FIXTURES, 'kinds-project');
  const ATTEMPT_MANIFEST = path.join(FIXTURES, 'extraction', 'attempt-manifest.json');
  const STATE = '.formalising/auto-fv/state.json';
  const id = (name) => `probe:${name}`;

  function project() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-lean-fidelity-'));
    temporaryDirectories.push(root);
    fs.cpSync(KINDS, root, { recursive: true });
    fs.mkdirSync(path.join(root, path.dirname(STATE)), { recursive: true });
    fs.copyFileSync(recorded('bound-positive', 'state.json'), path.join(root, STATE));
    return root;
  }
  const constants = () => JSON.parse(read(RUN, 'constants.json'));
  // Synthetic, not evidence: a constants record whose project entries say
  // exactly what probe-lean reported, so the verified path can be exercised.
  function synthetic() {
    const record = constants();
    const data = JSON.parse(read(RUN, 'lean.json')).data;
    for (const entry of record.project) {
      const atom = data[id(entry.name)];
      if (!atom) continue;
      const names = (fields) => [...new Set(fields.flatMap((field) => atom[field] ?? []).map((dep) => dep.slice('probe:'.length)))];
      entry.type = names(['type-dependencies', 'type-dependencies-external']);
      entry.value = names(['term-dependencies', 'term-dependencies-external']);
    }
    return record;
  }
  function fidelityGraph(edit = null, overrides = {}) {
    const record = edit === 'real' ? constants() : synthetic();
    if (typeof edit === 'function') edit(record);
    return buildLeanGraph({
      extractText: read(RUN, 'lean.json'),
      logText: read(RUN, 'probe.log'),
      receiptText: read(RUN, 'receipt.json'),
      libraries: ['M1demo', 'Specs'],
      projectRoot: project(),
      manifestText: fs.readFileSync(ATTEMPT_MANIFEST, 'utf8'),
      constantsText: JSON.stringify(record),
      ...overrides,
    });
  }
  const entry = (record, name) => record.project.find((item) => item.name === name);
  const blocked = (record, code) => record.blockers.filter((item) => item.code === code).map((item) => item.declaration).sort();

  it('recorded compiled-bound run: probe-lean under-reports, so the graph is incomplete', () => {
    const run = JSON.parse(read(RUN, 'receipt.json'));
    assert.deepEqual(JSON.parse(read(RUN, 'constants.json')).inputs.compiled, run.inputs.compiled);
    const record = fidelityGraph('real');
    assert.equal(record.state, 'incomplete');
    assert.equal(record.fidelity.status, 'incomplete');
    // Generated constructors (Prod.mk, and Shift.mk in both instances) are not folded.
    assert.deepEqual(blocked(record, 'dependency-not-reported'), [id('m1demo.kinds.shiftNat'), id('m1demo.kinds.shiftPt'),
      id('m1demo.spec.double_spec'), id('m1demo.sum_to'), id('m1demo.sum_to_loop'), id('m1demo.sum_to_loop.body')]);
    assert.deepEqual(blocked(record, 'proof-dependencies-unaudited'),
      [id('m1demo.spec.double_spec'), id('m1demo.sum_to'), id('m1demo.sum_to_loop.body')]);
    assert.equal(record.blockers.length, 9);
    assert.ok(record.closures[id('m1demo.spec.double_spec')].blockers.some((item) => item.code === 'dependency-not-reported'));
  });

  it('a constructor is not excused by its inductive being reported', () => {
    const record = fidelityGraph('real');
    const loop = record.declarations[id('m1demo.sum_to_loop')];
    assert.ok(loop['term-dependencies-external'].includes('probe:Prod'));
    const reason = record.blockers.find((item) => item.declaration === id('m1demo.sum_to_loop')).reason;
    assert.match(reason, /Prod\.mk \(value, ctor\)/);
    assert.ok(!record.fidelity.represented.some((item) => item.constant === 'Prod.mk'));
  });

  it('a generated theorem is folded through its statement and its proof stays an open obligation', () => {
    const record = fidelityGraph('real');
    assert.ok(record.fidelity.represented.some((item) => item.declaration === id('m1demo.spec.double_spec') &&
      item.constant === 'm1demo.spec.DoubleFits.eq_1' && item.rule === 'statement-fold'));
    assert.ok(record.fidelity.obligations.some((item) => item.declaration === id('m1demo.spec.double_spec') &&
      item.constant === 'm1demo.spec.DoubleFits.eq_1' && item.obligation === 'proof-dependencies-unaudited'));
    // The simp lemma's proof uses propext; the proof is not audited, so it stays an obligation.
    assert.ok(entry(constants(), 'm1demo.spec.double_spec._simp_1_9').value.includes('propext'));
    assert.ok(record.fidelity.obligations.some((item) => item.constant === 'm1demo.spec.double_spec._simp_1_9'));
    // An unreported statement constant of a generated theorem is a coverage failure, not waived:
    // in the real record DoubleFits.eq_1 folds; with Nat.add in its statement it no longer does.
    assert.ok(!record.blockers.find((item) => item.declaration === id('m1demo.spec.double_spec') &&
      item.code === 'dependency-not-reported').reason.includes('DoubleFits.eq_1'));
    const real = constants();
    entry(real, 'm1demo.spec.DoubleFits.eq_1').type.push('Nat.add');
    const statement = fidelityGraph(null, { constantsText: JSON.stringify(real) });
    assert.match(statement.blockers.find((item) => item.code === 'dependency-not-reported' &&
      item.declaration === id('m1demo.spec.double_spec')).reason, /DoubleFits\.eq_1 \(value, theorem\)/);
  });

  it('synthetic: a constants record that agrees with the reported lists is verified', () => {
    const record = fidelityGraph();
    assert.equal(record.state, 'complete');
    assert.equal(record.fidelity.status, 'verified');
    assert.deepEqual(record.fidelity.obligations, []);
  });

  it('an unreported constant, constructor or type-lane constant blocks and taints closures', () => {
    for (const [constant, list] of [['Nat.add', 'value'], ['Prod.mk', 'value'], ['Aeneas.Std.U32.max', 'type']]) {
      const record = fidelityGraph((record2) => { entry(record2, 'm1demo.kinds.Pt.x')[list].push(constant); });
      assert.deepEqual(codes(record), ['dependency-not-reported'], constant);
      assert.equal(record.blockers[0].declaration, id('m1demo.kinds.Pt.x'));
      assert.ok(record.closures[id('m1demo.kinds.wrap_x')].blockers.some((item) => item.code === 'dependency-not-reported'));
    }
    const termOnly = fidelityGraph((record2) => { entry(record2, 'm1demo.spec.double_spec').type.push('Aeneas.Std.U32.add_spec'); });
    assert.match(termOnly.blockers[0].reason, /U32\.add_spec \(type, theorem\)/);
  });

  it('a generated axiom is a trust boundary and an unqualified kind is not folded', () => {
    const generated = (kind) => fidelityGraph((record2) => {
      record2.project.push({ name: 'm1demo.kinds.generated_1', module: 'Specs.Kinds', kind, owners: [], type: ['Nat'], value: [] });
      entry(record2, 'm1demo.kinds.Pt.x').value.push('m1demo.kinds.generated_1');
    });
    const axiom = generated('axiom');
    assert.deepEqual(codes(axiom), ['dependency-not-reported', 'axiom-boundary']);
    assert.deepEqual(axiom.fidelity.obligations, [{ declaration: id('m1demo.kinds.Pt.x'), constant: 'm1demo.kinds.generated_1', obligation: 'axiom-boundary' }]);
    assert.ok(!axiom.fidelity.represented.some((item) => item.constant === 'm1demo.kinds.generated_1'));
    for (const kind of ['opaque', 'ctor', 'recursor', 'mystery']) {
      const record = generated(kind);
      assert.deepEqual(codes(record), ['dependency-not-reported'], kind);
      assert.match(record.blockers[0].reason, new RegExp(`generated_1 \\(value, ${kind}\\)`));
    }
    // A generated definition of the same shape folds.
    assert.deepEqual(codes(generated('def')), []);
  });

  it('the compiled inventory must cover every analysed module with its companions, and nothing else', () => {
    const both = (edit) => {
      const receipt = JSON.parse(read(RUN, 'receipt.json'));
      edit(receipt.inputs.compiled);
      return fidelityGraph((record2) => { record2.inputs.compiled = receipt.inputs.compiled; }, { receiptText: JSON.stringify(receipt) });
    };
    const kinds = '.lake/build/lib/lean/Specs/Kinds';
    for (const [label, edit] of [
      ['a module missing from both', (map) => { delete map[`${kinds}.olean`]; delete map[`${kinds}.olean.hash`]; }],
      ['a module-system companion missing from both', (map) => { delete map['.lake/build/lib/lean/M1demo/M1demo.olean.private']; }],
      ['only a sidecar hash', (map) => { for (const file of Object.keys(map)) if (file !== '.lake/build/lib/lean/M1demo.olean.hash') delete map[file]; }],
      ['an unrelated module', (map) => { map['.lake/build/lib/lean/Other.olean'] = '0'.repeat(64); }],
      ['an aliased path', (map) => { map['.lake/build/lib/lean/./Specs.olean'] = map['.lake/build/lib/lean/Specs.olean']; }],
    ]) {
      const record = both(edit);
      assert.deepEqual(codes(record), ['compiled-inventory-incomplete'], label);
    }
  });

  it('the compiled modules must be recorded by both and be the same', () => {
    assert.match(fidelityGraph((record2) => { delete record2.inputs.compiled; }).blockers[0].reason, /compiled-environment-not-bound/);
    const receipt = JSON.parse(read(RUN, 'receipt.json'));
    delete receipt.inputs.compiled;
    assert.deepEqual(codes(fidelityGraph(null, { receiptText: JSON.stringify(receipt) })), ['fidelity-unverified']);
    const stale = fidelityGraph((record2) => {
      const file = Object.keys(record2.inputs.compiled).find((name) => name.endsWith('M1demo/M1demo.olean'));
      record2.inputs.compiled[file] = '0'.repeat(64);
    });
    assert.deepEqual(codes(stale), ['fidelity-unbound']);
    const bad = JSON.parse(read(RUN, 'receipt.json'));
    bad.inputs.compiled = { x: 'not-a-digest' };
    assert.ok(codes(fidelityGraph(null, { receiptText: JSON.stringify(bad) })).includes('invalid-receipt'));
  });

  it('the module header is read as Lean 4.31 reads it, and an unclassifiable one fails closed', () => {
    for (const [source, expected] of [
      ['module\n', true], ['  module -- the header\n', true], ['\n\nmodule\n', true], ['-- note\nmodule\n', true],
      ['/- a /- nested -/ comment -/ module\n', true], ['module--c\n', true],
      ['/-- doc -/\nmodule\n', false], ['modules\n', false], ['/-\nmodule\n-/\ndef x := 1\n', false],
      ['-- module\nimport Foo\n', false], ['import M1demo.M1demo\n', false],
      ['\tmodule\n', null], ['/- unterminated', null],
    ]) assert.equal(moduleHeader(source), expected, JSON.stringify(source));
  });

  it('a module header in any accepted form requires the companions, even when both maps agree', () => {
    // Labelled source mutation of run A's Specs/Kinds.lean; both maps still list only its .olean.
    const withHeader = (header) => {
      const root = project();
      const file = path.join(root, 'Specs', 'Kinds.lean');
      fs.writeFileSync(file, header + fs.readFileSync(file, 'utf8'));
      const receipt = JSON.parse(read(RUN, 'receipt.json'));
      receipt.inputs.files = projectInputs(root);
      const record = synthetic();
      record.inputs.files = receipt.inputs.files;
      return buildLeanGraph({
        extractText: read(RUN, 'lean.json'), logText: read(RUN, 'probe.log'), receiptText: JSON.stringify(receipt),
        libraries: ['M1demo', 'Specs'], projectRoot: root, manifestText: fs.readFileSync(ATTEMPT_MANIFEST, 'utf8'),
        constantsText: JSON.stringify(record),
      });
    };
    for (const header of ['  module -- leading space and a comment\n', '-- generated\nmodule\n', '/- a note -/ module\n']) {
      const record = withHeader(header);
      assert.deepEqual(codes(record), ['compiled-inventory-incomplete'], JSON.stringify(header));
      assert.match(record.blockers[0].reason, /Specs\/Kinds\.olean\.private/);
    }
    // A commented-out module word is not a header: .olean alone is enough.
    for (const header of ['-- module\n', '/-\nmodule\n-/\n']) assert.deepEqual(codes(withHeader(header)), [], JSON.stringify(header));
    assert.match(withHeader('/- never closed\n').blockers[0].reason, /could not be classified/);
  });

  it('a missing, malformed, unbound or partial constants record establishes nothing', () => {
    assert.deepEqual(codes(fidelityGraph(null, { constantsText: null })), ['fidelity-unverified']);
    assert.deepEqual(codes(fidelityGraph(null, { constantsText: '{"schema":"fvs/lean-constants","version":1}' })), ['invalid-constants']);
    assert.deepEqual(codes(fidelityGraph((record2) => { record2.referenced.push({ ...record2.referenced[0] }); })), ['invalid-constants']);
    assert.deepEqual(codes(fidelityGraph((record2) => { record2.inputs.files['M1demo.lean'] = '0'.repeat(64); })), ['fidelity-unbound']);
    assert.deepEqual(codes(fidelityGraph((record2) => { record2.project = record2.project.filter((item) => item.name !== 'm1demo.clamp'); })),
      ['constants-missing-declaration']);
  });

  it('an .ilean without a references map is not coverage evidence; an empty map is', () => {
    for (const references of [undefined, [], 'x']) {
      const projectRoot = projectCopy((directory) => {
        const file = path.join(directory, '.lake', 'build', 'lib', 'lean', 'M1demo', 'Spec.ilean');
        const ilean = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (references === undefined) delete ilean.references;
        else ilean.references = references;
        fs.writeFileSync(file, JSON.stringify(ilean));
      });
      const record = derived({ projectRoot, receipt: (r) => { r.inputs.files = projectInputs(projectRoot); } });
      assert.deepEqual(codes(record), withUnverified(['ilean-references-missing']), JSON.stringify(references));
    }
    const root = JSON.parse(fs.readFileSync(path.join(PROJECT, '.lake', 'build', 'lib', 'lean', 'M1demo.ilean'), 'utf8'));
    assert.deepEqual(root.references, {});
    assert.deepEqual(codes(graph()), ['fidelity-unverified']);
  });
});

describe('oracle lanes: constants version 2 as the dependency authority', () => {
  // Real paired capture of the two-roots-one-helper fixture (probe-lean 0.24.0 and
  // the Lean constants extractor over one discovered import inventory).
  const V2 = path.join(FIXTURES, 'oracle-v2');
  const run = (file) => fs.readFileSync(path.join(V2, 'run', file), 'utf8');
  const IMPORTS = require('node:zlib').gunzipSync(fs.readFileSync(path.join(V2, 'run', 'imports.json.gz'))).toString('utf8');
  const STATE = '.formalising/auto-fv/state.json';
  const LIBS = ['M1demo', 'Specs'];
  const N = (name) => `probe:m1demo.${name}`;

  function v2Project(edit = () => {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-lean-v2-'));
    temporaryDirectories.push(root);
    fs.cpSync(path.join(V2, 'project'), root, { recursive: true });
    fs.mkdirSync(path.join(root, path.dirname(STATE)), { recursive: true });
    fs.copyFileSync(path.join(V2, 'run', 'state.json'), path.join(root, STATE));
    edit(root);
    return root;
  }

  // Derived runs: edit the record, its run receipt, the probe receipt or the
  // extract; the run receipt is re-signed over the edited record unless asked not to.
  function v2Graph({ constants = () => {}, constantsRun = () => {}, receipt = () => {}, extract = null, log = (text) => text,
    resign = true, overrides = {} } = {}) {
    const record = JSON.parse(run('constants.json'));
    constants(record, Object.fromEntries(record.nodes.map((node) => [node.name, node])));
    const constantsText = JSON.stringify(record);
    const runReceipt = JSON.parse(run('constants-run.json'));
    if (resign) Object.assign(runReceipt, { outputSha256: sha256(constantsText), outputBytes: Buffer.byteLength(constantsText) });
    constantsRun(runReceipt);
    const probe = JSON.parse(run('receipt.json'));
    let extractText = run('lean.json');
    let logText = log(run('probe.log'));
    if (extract) {
      const envelope = JSON.parse(extractText);
      extract(envelope.data);
      extractText = JSON.stringify(envelope);
    }
    probe.outputs = { extractSha256: sha256(extractText), logSha256: sha256(logText) };
    receipt(probe);
    return buildLeanGraph({
      extractText, logText, receiptText: JSON.stringify(probe), libraries: LIBS, projectRoot: v2Project(),
      manifestText: run('attempt-manifest.json'), constantsText, constantsRunText: JSON.stringify(runReceipt), importsText: IMPORTS, ...overrides,
    });
  }
  const has = (record, code) => codes(record).includes(code);
  // Re-sign an edited import manifest consistently in the record, both receipts and the run.
  const resigned = (edit, constants = () => {}) => {
    const manifest = JSON.parse(IMPORTS);
    edit(manifest.modules);
    const text = JSON.stringify(manifest);
    const summary = { digest: sha256(text), modules: Object.keys(manifest.modules).length,
      files: Object.values(manifest.modules).reduce((count, entry) => count + Object.keys(entry.parts).length, 0) };
    return v2Graph({ constants: (c, n) => { c.inputs.imports = summary; constants(c, n); }, receipt: (r) => { r.inputs.imports = summary; },
      constantsRun: (r) => { r.inventoryBefore = r.inventoryAfter = summary.digest; }, overrides: { importsText: text } });
  };

  it('recorded paired run: complete, bound and verified, with authoritative lanes for every node', () => {
    const root = v2Project();
    const imports = path.join(root, 'imports.json');
    fs.writeFileSync(imports, IMPORTS);
    const result = cli([path.join(V2, 'run', 'lean.json'), '--library', LIBS.join(','), '--log', path.join(V2, 'run', 'probe.log'),
      '--receipt', path.join(V2, 'run', 'receipt.json'), '--project-root', root, '--manifest', path.join(V2, 'run', 'attempt-manifest.json'),
      '--constants', path.join(V2, 'run', 'constants.json'), '--constants-receipt', path.join(V2, 'run', 'constants-run.json'), '--imports', imports]);
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(result.stdout);
    assert.equal(record.schemaVersion, 2);
    assert.equal(record.capability, 'oracle-lanes');
    assert.equal(record.state, 'complete');
    assert.equal(record.binding.status, 'bound');
    assert.deepEqual([record.fidelity.status, record.fidelity.obligations], ['verified', []]);
    // declarations are exactly the probe-atom nodes; generated nodes have no probe identity.
    assert.deepEqual(Object.keys(record.declarations).sort(), Object.keys(record.nodes).filter((id) => record.nodes[id].probeAtom).sort());
    assert.ok(Object.values(record.nodes).some((node) => !node.probeAtom));
    // One edge per lane entry, resolved by node membership.
    const lanes = Object.entries(record.nodes).flatMap(([from, node]) => [
      ...node.type.map((to) => `${from} ${to} type`), ...node.value.map((to) => `${from} ${to} term`)]).sort();
    assert.deepEqual(record.edges.map((edge) => `${edge.from} ${edge.to} ${edge.kind}`).sort(), lanes);
    for (const edge of record.edges) {
      const target = record.nodes[edge.to];
      assert.equal(edge.resolution, !target ? 'external' : target.probeAtom ? 'local' : 'generated', JSON.stringify(edge));
    }
    for (const theorem of ['roots.root_sum_eq', 'roots.root_twice_eq']) {
      const closure = record.closures[N(theorem)];
      assert.deepEqual(closure.blockers, []);
      for (const member of ['helper', 'Pair', 'Pair.a', 'Pair.b', 'Pair.mk']) assert.ok(closure.declarations.includes(N(member)), `${theorem} ${member}`);
    }
    assert.deepEqual(record.nodes[N('Pair')].fields.map((field) => field.projection), ['m1demo.Pair.a', 'm1demo.Pair.b']);
    assert.ok(record.fidelity.probeUnderReport.some((item) => item.declaration === N('root_twice') && item.constants.includes('m1demo.root_twice._proof_1')));
    assert.deepEqual(record.trust[N('helper')], ['propext', 'Quot.sound']);
  });

  it('artifact drift and failed capture: nothing unbound or partial is accepted', () => {
    assert.ok(has(v2Graph({ constantsRun: (r) => { r.inventoryAfter = '0'.repeat(64); } }), 'constants-run-invalid'));
    assert.ok(has(v2Graph({ constantsRun: (r) => { r.exitCode = 1; } }), 'constants-run-invalid'));
    assert.ok(has(v2Graph({ constants: (c) => { c.nodes[0].kind = c.nodes[0].kind; c.producer.extractorSha256 = '1'.repeat(64); }, constantsRun: () => {} , resign: true }), 'constants-run-invalid'));
    assert.ok(has(v2Graph({ resign: false, constants: (c) => { c.nodes.reverse(); } }), 'constants-run-invalid'));
    // Only the digest is stale (length re-signed): the exact-bytes check alone refuses it.
    assert.ok(has(v2Graph({ constantsRun: (r) => { r.outputSha256 = '4'.repeat(64); } }), 'constants-run-invalid'));
    assert.ok(has(v2Graph({ overrides: { constantsRunText: null } }), 'constants-run-missing'));
    // Stale compiled module: the record names other bytes than the probe run.
    assert.ok(has(v2Graph({ constants: (c) => { const file = Object.keys(c.inputs.compiled)[0]; c.inputs.compiled[file] = '0'.repeat(64); } }), 'fidelity-unbound'));
    // A different import inventory between the probe and the oracle.
    assert.ok(has(v2Graph({ constants: (c) => { c.inputs.imports.digest = '2'.repeat(64); }, constantsRun: (r) => { r.inventoryBefore = r.inventoryAfter = '2'.repeat(64); } }), 'fidelity-unbound'));
    // A missing module-system companion in both maps.
    const companion = '.lake/build/lib/lean/M1demo/M1demo.olean.private';
    assert.ok(has(v2Graph({ constants: (c) => { delete c.inputs.compiled[companion]; }, receipt: (r) => { delete r.inputs.compiled[companion]; } }), 'compiled-inventory-incomplete'));
  });

  it('coverage: nodes outside the analysed modules and definitions without axiom sets block', () => {
    assert.ok(has(v2Graph({ constants: (c, n) => { n['m1demo.helper'].module = 'Elsewhere'; } }), 'node-outside-inventory'));
    for (const name of ['m1demo.helper', 'm1demo.root_twice._proof_1']) {
      assert.ok(has(v2Graph({ constants: (c, n) => { delete n[name].axioms; } }), 'axioms-missing'), name);
    }
  });

  it('probe-lean and the oracle must cover each other; a source node is never treated as generated', () => {
    assert.ok(has(v2Graph({ constants: (c) => { c.nodes = c.nodes.filter((node) => node.name !== 'm1demo.root_sum'); } }), 'probe-atom-without-node'));
    const unmapped = v2Graph({ extract: (data) => { delete data[N('root_sum')]; }, log: (text) => text.replace(/Wrote (\d+) /, (m, k) => `Wrote ${Number(k) - 1} `) });
    assert.ok(has(unmapped, 'unmapped-source-node'));
    assert.ok(!Object.hasOwn(unmapped.nodes ?? {}, N('root_sum')) || unmapped.nodes[N('root_sum')].probeAtom === false);
  });

  it('kernel and probe-lean kinds must agree', () => {
    assert.ok(has(v2Graph({ constants: (c, n) => { n['m1demo.Pair.a'].isProjection = false; } }), 'kind-mismatch'));
    assert.ok(has(v2Graph({ constants: (c, n) => { n['m1demo.Pair'].isStructure = false; delete n['m1demo.Pair'].fields; } }), 'kind-mismatch'));
    assert.ok(has(v2Graph({ constants: (c, n) => { n['m1demo.helper'].kind = 'theorem'; } }), 'kind-mismatch'));
    // A theorem projection (a Prop-valued field) blocks whatever probe-lean calls it, source or generated.
    for (const name of ['m1demo.roots.root_sum_eq', 'm1demo.root_twice._proof_1']) {
      assert.ok(has(v2Graph({ constants: (c, n) => { n[name].isProjection = true; } }), 'unsupported-projection'), name);
    }
    assert.ok(has(v2Graph({ constants: (c, n) => { n['m1demo.roots.root_sum_eq'].isProjection = true; }, extract: (data) => { data[N('roots.root_sum_eq')].kind = 'projection'; } }),
      'unsupported-projection'));
    // probe-lean 0.24 class and instance labels need Lean's own registries to agree.
    assert.ok(has(v2Graph({ extract: (data) => { data[N('Pair')].kind = 'class'; } }), 'kind-mismatch'));
    assert.ok(!has(v2Graph({ extract: (data) => { data[N('Pair')].kind = 'class'; }, constants: (c, n) => { n['m1demo.Pair'].isClass = true; } }), 'kind-mismatch'));
    assert.ok(has(v2Graph({ extract: (data) => { data[N('helper')].kind = 'instance'; } }), 'kind-mismatch'));
    assert.ok(!has(v2Graph({ extract: (data) => { data[N('helper')].kind = 'instance'; }, constants: (c, n) => { n['m1demo.helper'].isInstance = true; } }), 'kind-mismatch'));
  });

  it('lanes: a swapped or omitted dependency is refused, an endpoint must exist', () => {
    // helper's type lane holds Pair; moving it to the value lane is a lane swap.
    assert.ok(has(v2Graph({ constants: (c, n) => { const node = n['m1demo.helper']; node.type = node.type.filter((x) => x !== 'm1demo.Pair'); node.value.push('m1demo.Pair'); } }),
      'probe-dependency-not-in-lane'));
    // An external constant probe-lean reports, omitted from the oracle lane.
    assert.ok(has(v2Graph({ constants: (c, n) => { const node = n['m1demo.helper']; node.type = node.type.filter((x) => x !== 'Aeneas.Std.U32'); } }),
      'probe-dependency-not-in-lane'));
    // A missing generated endpoint: the constructor node is gone.
    assert.ok(has(v2Graph({ constants: (c) => { c.nodes = c.nodes.filter((node) => node.name !== 'm1demo.Pair.mk'); } }), 'invalid-structure-family'));
  });

  it('trust: non-policy axioms block on a definition and on a generated proof; malformed sets are refused', () => {
    for (const name of ['m1demo.helper', 'm1demo.root_twice._proof_1']) {
      const record = v2Graph({ constants: (c, n) => { n[name].axioms.push('sorryAx'); } });
      assert.ok(has(record, 'non-policy-axiom'), name);
      assert.equal(record.fidelity.status, 'incomplete');
      assert.ok(record.fidelity.obligations.some((item) => item.code === 'non-policy-axiom'));
    }
    assert.ok(has(v2Graph({ constants: (c, n) => { n['m1demo.helper'].axioms = 'propext'; } }), 'invalid-constants'));
    // The obligation reaches the consumers' closures.
    const tainted = v2Graph({ constants: (c, n) => { n['m1demo.helper'].axioms.push('sorryAx'); } });
    assert.ok(tainted.closures[N('roots.root_sum_eq')].blockers.some((item) => item.declaration === N('helper')));
  });

  it('families and kinds: unqualified generated kinds, broken families and generated-only cycles block', () => {
    assert.ok(has(v2Graph({ constants: (c, n) => { n['m1demo.Pair.ctorIdx'].kind = 'mystery'; } }), 'unsupported-generated-kind'));
    assert.ok(has(v2Graph({ constants: (c, n) => { n['m1demo.Pair.ctorIdx'].kind = 'axiom'; } }), 'unsupported-generated-kind'));
    assert.ok(has(v2Graph({ constants: (c, n) => { n['m1demo.Pair.mk'].family.inductive = 'm1demo.Other'; } }), 'unsupported-generated-kind'));
    assert.ok(has(v2Graph({ constants: (c, n) => { n['m1demo.Pair'].fields[0].projection = 'm1demo.Pair.missing'; } }), 'invalid-structure-family'));
    const loop = (n) => { n['m1demo.Pair.casesOn'].value.push('m1demo.Pair.recOn'); n['m1demo.Pair.recOn'].value.push('m1demo.Pair.casesOn'); };
    // Unreachable from any source declaration: not part of any claim, so not blocking.
    assert.ok(!has(v2Graph({ constants: (c, n) => loop(n) }), 'generated-cycle'));
    // Reached through a source definition's value lane: blocks.
    const reached = v2Graph({ constants: (c, n) => { loop(n); n['m1demo.root_sum'].value.push('m1demo.Pair.casesOn'); } });
    assert.ok(has(reached, 'generated-cycle'));
  });

  it('identity and versions: other producers, other versions and malformed output are refused', () => {
    assert.ok(has(v2Graph({ constantsRun: (r) => { r.producer = { ...r.producer, harnessSha256: '3'.repeat(64) }; } }), 'constants-run-invalid'));
    assert.ok(has(v2Graph({ constants: (c) => { c.nodes.push({ ...c.nodes[0] }); } }), 'invalid-constants'));
    const truncated = run('constants.json').slice(0, 200);
    // Unreadable, so no version 2 record backs the 0.24.0 extract.
    assert.deepEqual(codes(v2Graph({ overrides: { constantsText: truncated } })), ['unqualified-interface']);
    // probe-lean 0.24.0 is qualified only beside a version 2 record.
    const v3 = v2Graph({ constants: (c) => { c.version = 3; } });
    assert.equal(v3.schemaVersion, 1);
    assert.deepEqual([v3.state, codes(v3)], ['unsupported', ['unqualified-interface']]);
    assert.equal(v2Graph({ overrides: { constantsText: null } }).state, 'unsupported');
    assert.ok(has(v2Graph({ receipt: (r) => { r.probe.version = '0.14.0'; } }), 'run-mismatch'));
    assert.deepEqual([v2Graph().tool.version, v2Graph().state], ['0.24.0', 'complete']);
  });

  it('every dependency view comes from the oracle lanes, externals included', () => {
    const record = v2Graph();
    assert.equal(record.state, 'complete');
    const externals = [...new Set(record.edges.filter((edge) => edge.resolution === 'external').map((edge) => edge.to))].sort();
    assert.deepEqual(record.external, externals);
    // Lean-only boundary constants probe-lean never lists.
    for (const name of ['And.intro', 'SizeOf.sizeOf', 'Eq.ndrec']) assert.ok(record.external.includes(`probe:${name}`), name);
    // A private declaration keeps Lean's raw name on both sides.
    const priv = 'probe:_private.Specs.Roots.0.m1demo.roots.helper_self';
    assert.deepEqual([record.nodes[priv].probeAtom, record.nodes[priv].kind], [true, 'theorem']);
    // Without accepted lanes no probe-derived edges or closures are emitted.
    const refused = v2Graph({ overrides: { constantsRunText: null } });
    assert.deepEqual([refused.edges, refused.external, refused.closures], [[], [], {}]);
  });

  it('a missing project constant never becomes an external leaf', () => {
    const proof = 'm1demo.root_twice._proof_1';
    // Gone from the nodes, so its reference is unclassified (probe-lean omits it too).
    const gone = v2Graph({ constants: (c) => { c.nodes = c.nodes.filter((node) => node.name !== proof); } });
    assert.ok(has(gone, 'unclassified-reference'));
    assert.ok(gone.edges.some((edge) => edge.to === `probe:${proof}` && edge.resolution === 'unresolved'));
    assert.ok(!gone.external.includes(`probe:${proof}`));
    // Declared as a reference from a project module, or from no module: still a gap.
    for (const module of ['M1demo.M1demo', 'Specs', null]) {
      const moved = v2Graph({ constants: (c) => { c.nodes = c.nodes.filter((node) => node.name !== proof); c.referenced.push({ name: proof, module }); } });
      assert.ok(has(moved, 'missing-project-node'), String(module));
    }
    // An external reference with no classification, and a classification no lane uses.
    assert.ok(has(v2Graph({ constants: (c) => { c.referenced = c.referenced.filter((entry) => entry.name !== 'And.intro'); } }), 'unclassified-reference'));
    assert.ok(has(v2Graph({ constants: (c) => { c.referenced.push({ name: 'Unused.constant', module: 'Init.Prelude' }); } }), 'unclassified-reference'));
    // A dropped project constant placed in a module Lean never loaded is not external either.
    // A loaded project module the probe did not analyse is still the project's.
    const extra = resigned((m) => { m['Specs.Extra'] = { olean: m.Specs.olean.replace('Specs.olean', 'Specs/Extra.olean'), parts: { '.olean': '6'.repeat(64) } }; },
      (c) => { c.nodes = c.nodes.filter((node) => node.name !== proof); c.referenced.push({ name: proof, module: 'Specs.Extra' }); });
    assert.ok(has(extra, 'missing-project-node'));
    const forged = v2Graph({ constants: (c) => { c.nodes = c.nodes.filter((node) => node.name !== proof); c.referenced.push({ name: proof, module: 'Forged.Module' }); } });
    assert.ok(has(forged, 'import-project-mismatch'));
  });

  it('the record namespace and kind-specific metadata are required, missing is not empty', () => {
    for (const [label, edit] of [
      ['schema', (c) => { c.schema = 'other/constants'; }],
      ['fields', (c, n) => { delete n['m1demo.Pair'].fields; }],
      ['ctors', (c, n) => { n['m1demo.Pair'].family.ctors = 'm1demo.Pair.mk'; }],
      ['recursors', (c, n) => { delete n['m1demo.Pair'].family.recursors; }],
      ['ctor family', (c, n) => { delete n['m1demo.Pair.mk'].family; }],
      ['recursor family', (c, n) => { n['m1demo.Pair.rec'].family.inductives = []; }],
      ['family on a def', (c, n) => { n['m1demo.helper'].family = { ctors: [] }; }],
      ['isClass', (c, n) => { delete n['m1demo.helper'].isClass; }],
      ['referenced', (c) => { delete c.referenced; }],
      ['referenced module', (c) => { delete c.referenced[0].module; }],
      ['referenced node', (c) => { c.referenced.push({ name: 'm1demo.helper', module: 'M1demo.M1demo' }); }],
    ]) assert.ok(has(v2Graph({ constants: edit }), 'invalid-constants'), label);
    // An explicitly empty field list is still well formed.
    assert.ok(!has(v2Graph({ constants: (c, n) => { n['m1demo.Pair'].fields = []; } }), 'invalid-constants'));
  });

  it('the analysed modules must resolve to the recorded compiled bytes in the import manifest', () => {
    assert.equal(resigned(() => {}).state, 'complete');
    // Lean resolved a project module from somewhere else.
    assert.ok(has(resigned((m) => { m['Specs.Roots'].olean = '/elsewhere/Specs/Roots.olean'; }), 'import-project-mismatch'));
    // Lean resolved other bytes, or another part set, than the project build recorded.
    assert.ok(has(resigned((m) => { m['Specs.Roots'].parts['.olean'] = '5'.repeat(64); }), 'import-project-mismatch'));
    assert.ok(has(resigned((m) => { delete m['M1demo.M1demo'].parts['.private']; }), 'import-project-mismatch'));
    // The analysed modules from two project roots.
    assert.ok(has(resigned((m) => { m.Specs.olean = m.Specs.olean.replace('roots-r9', 'roots-other'); }), 'import-project-mismatch'));
    // A missing analysed module.
    assert.ok(has(resigned((m) => { delete m.Specs; }), 'import-project-mismatch'));
    // No manifest, other bytes, or counts the record misdescribes.
    assert.ok(has(v2Graph({ overrides: { importsText: null } }), 'import-project-mismatch'));
    assert.ok(has(v2Graph({ overrides: { importsText: `${IMPORTS} ` } }), 'import-project-mismatch'));
    const miscounted = { ...JSON.parse(run('constants.json')).inputs.imports, modules: 3915 };
    assert.ok(has(v2Graph({ constants: (c) => { c.inputs.imports = miscounted; }, receipt: (r) => { r.inputs.imports = miscounted; } }), 'import-project-mismatch'));
  });

  it('the run receipt records the actual extractor invocation', () => {
    for (const edit of [
      (r) => { r.argv = ['lake', 'env', 'lean']; },
      (r) => { r.argv = ['/usr/bin/lean', 'env', 'lean', '/w/LeanConstants.lean']; },
      (r) => { r.argv[3] = '/w/LeanConstants.txt'; },
      (r) => { delete r.cwd; },
    ]) assert.ok(has(v2Graph({ constantsRun: edit }), 'constants-run-invalid'));
  });
});
