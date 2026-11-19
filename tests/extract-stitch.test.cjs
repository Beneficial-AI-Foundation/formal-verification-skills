'use strict';

// Edits to the generated Lean: the exact text substitutions of the spec, and stitching a
// crate to the crate whose real translation replaces its axioms. Charon, Aeneas, rustc
// and cargo are fake scripts; the Lean text they write has the shape Aeneas writes (a
// doc comment with the Rust path, a `rust_*` attribute on a foreign axiom). Lean itself
// is the signature gate in a real project; the engine pre-check only refuses a
// difference it can read.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { toySpec, cleanup, workspace, run: engine, specFile, attempted, step, completeUnit, complete } = require('./helpers/fake-multicrate-tools.cjs');

after(cleanup);

const HEADER = 'module\npublic import Aeneas\n@[expose] public section\nopen Aeneas Aeneas.Std Result\n';

const lib = (grow = '(a : Std.U32) (b : Std.U32) : Result Std.U32') => `${HEADER}namespace toy_lib

/-- [toy_lib::one]:
    Source: 'lib/src/lib.rs', lines 1:0-1:24
    Visibility: public -/
def one : Result Std.U32 := ok 1#u32

/-- [toy_lib::TWO]
    Source: 'lib/src/lib.rs', lines 3:0-3:20
    Visibility: public -/
@[global_simps, irreducible]
def TWO : Std.U32 := 2#u32

/-- [toy_lib::Thing]
    Source: 'lib/src/lib.rs', lines 5:0-5:20
    Visibility: public -/
structure Thing where
  x : Std.U32

/-- [toy_lib::grow]:
    Source: 'lib/src/lib.rs', lines 7:0-9:1
    Visibility: public -/
def grow ${grow} := do
  a + b

end toy_lib
`;

const APP = `${HEADER}namespace toy_app

/-- [toy_lib::one]:
    Source: 'lib/src/lib.rs', lines 1:0-1:24
    Name pattern: [toy_lib::one]
    Visibility: public -/
@[rust_fun "toy_lib::one"]
axiom toy_lib.one : Result Std.U32

/-- [toy_lib::TWO]
    Source: 'lib/src/lib.rs', lines 3:0-3:20
    Name pattern: [toy_lib::TWO]
    Visibility: public -/
@[rust_const "toy_lib::TWO"]
axiom toy_lib.TWO : Result Std.U32

/-- [toy_lib::Thing]
    Source: 'lib/src/lib.rs', lines 5:0-5:20
    Name pattern: [toy_lib::Thing]
    Visibility: public -/
@[rust_type "toy_lib::Thing"]
axiom toy_lib.Thing : Type

/-- [toy_lib::grow]:
    Source: 'lib/src/lib.rs', lines 7:0-9:1
    Name pattern: [toy_lib::grow]
    Visibility: public -/
@[rust_fun "toy_lib::grow"]
axiom toy_lib.grow
  : Std.U32 → Std.U32 → Result Std.U32

/-- [toy_lib::other_mod::skipped]:
    Source: 'lib/src/other_mod.rs', lines 1:0-1:30
    Name pattern: [toy_lib::other_mod::skipped]
    Visibility: public -/
@[rust_fun "toy_lib::other_mod::skipped"]
axiom toy_lib.other_mod.skipped : Result Unit

/-- [toy_app::three]:
    Source: 'app/src/lib.rs', lines 1:0-1:50
    Visibility: public -/
def three : Result Std.U32 := do
  let x ← toy_lib.one
  ok x

end toy_app
`;

const behaviour = (extra = {}) => ({ toy_lib: { lean: lib() }, toy_app: { lean: APP }, ...extra });

function stitched(spec = {}) {
  const base = toySpec();
  base.crates[0].moduleRoot = 'Toy.Lib';
  base.crates[1].moduleRoot = 'Toy.App';
  base.crates[1].stitch = [{ crate: 'toy_lib', assume: ['toy_lib::other_mod'] }];
  for (const [key, value] of Object.entries(spec)) {
    if (value === undefined) delete base.crates[1][key];
    else base.crates[1][key] = value;
  }
  return base;
}

const published = (ws, file) => fs.readFileSync(path.join(ws.project, file), 'utf8');

describe('stitching: the consumer\'s axioms become checked aliases of the provider\'s real definitions', () => {
  it('replaces each foreign axiom the provider defines, keeps the one the spec assumes, and records both', () => {
    const ws = workspace(behaviour());
    const out = complete(ws, stitched());
    const text = published(ws, 'Lean/App/ToyApp.lean');
    assert.match(text, /public import Aeneas\npublic import Toy\.Lib\.ToyLib\n@\[expose\] public section/);
    assert.match(text, /@\[reducible, rust_fun "toy_lib::one"\]\ndef toy_lib\.one : Result Std\.U32\n {2}:= _root_\.toy_lib\.one/);
    assert.match(text, /@\[rust_const "toy_lib::TWO"\]\ndef toy_lib\.TWO : Result Std\.U32\n {2}:= Result\.ok _root_\.toy_lib\.TWO/, 'a foreign global is typed Result T, so the real value is lifted, and is not reducible');
    assert.match(text, /@\[reducible, rust_type "toy_lib::Thing"\]\ndef toy_lib\.Thing : Type\n {2}:= _root_\.toy_lib\.Thing/);
    assert.match(text, /def toy_lib\.grow\n {2}: Std\.U32 → Std\.U32 → Result Std\.U32\n {2}:= _root_\.toy_lib\.grow/);
    assert.match(text, /\naxiom toy_lib\.other_mod\.skipped : Result Unit/, 'an assumed item stays an axiom');
    assert.match(text, /def three : Result Std\.U32 := do\n {2}let x ← toy_lib\.one\n {2}ok x/, 'the crate\'s own code is not touched');
    assert.doesNotMatch(published(ws, 'Lean/Lib/ToyLib.lean'), /_root_|@\[reducible/, 'the provider\'s Lean is published as Aeneas wrote it');

    const { run } = engine(ws, ['attempt-status', '--out', out]).result;
    assert.deepEqual(run.order, ['toy_lib', 'toy_app']);
    const app = run.units.find((unit) => unit.crate === 'toy_app');
    const library = run.units.find((unit) => unit.crate === 'toy_lib');
    assert.deepEqual(app.imports, ['toy_lib']);
    assert.deepEqual(library.imports, []);
    assert.deepEqual(library.stitch, []);
    assert.equal(app.stitch.length, 1);
    const [entry] = app.stitch;
    assert.equal(entry.provider, 'toy_lib');
    assert.deepEqual(entry.modules, ['Toy.Lib.ToyLib']);
    assert.deepEqual(entry.replaced.map(({ rustPath, kind, lift }) => [rustPath, kind, lift]), [
      ['toy_lib::one', 'fun', false], ['toy_lib::TWO', 'const', true], ['toy_lib::Thing', 'type', false], ['toy_lib::grow', 'fun', false],
    ]);
    assert.deepEqual(entry.replaced.map((item) => item.check), ['text-and-lean-build', 'text-and-lean-build', 'lean-build', 'text-and-lean-build'], 'a signature the engine cannot read is left to the Lean build, and the record says so');
    assert.ok(entry.replaced.every((item) => /^[0-9a-f]{64}$/.test(item.signatureSha256) && /^[0-9a-f]{64}$/.test(item.providerDeclSha256)));
    assert.deepEqual(entry.assumed, [{ rustPath: 'toy_lib::other_mod::skipped', name: 'toy_lib.other_mod.skipped', qualifiedName: 'toy_app.toy_lib.other_mod.skipped', reason: 'named in the stitch assume list' }]);
    // The generated file declares everything inside `namespace <crate>`: this is the name
    // `#print axioms` prints at the root; the provider's own constant is the alias target `_root_.<name>`.
    assert.deepEqual(entry.replaced.map((item) => [item.qualifiedName, item.providerQualifiedName]).slice(0, 2), [
      ['toy_app.toy_lib.one', 'toy_lib.one'], ['toy_app.toy_lib.TWO', 'toy_lib.TWO'],
    ]);
    assert.deepEqual(app.dependsOn, ['toy_lib']);
    assert.deepEqual(app.unstitched, []);
    assert.deepEqual(app.prerequisites, entry.replaced.map((item) => ({ providerCrate: 'toy_lib', rustPath: item.rustPath })));
    assert.deepEqual([library.dependsOn, library.unstitched, library.prerequisites], [[], [], []]);
    assert.deepEqual(entry.files, ['ToyApp.lean']);
    assert.equal(app.translation.attemptPath.endsWith('aeneas-dest/translation.json'), true, 'translation.json is not edited');
  });

  it('refuses a provider whose real type is not the one the consumer was translated against', () => {
    const ws = workspace(behaviour({ toy_lib: { lean: lib('(a : Std.U64) (b : Std.U32) : Result Std.U32') } }));
    const { out } = attempted(ws, stitched());
    for (const name of ['charon', 'aeneas']) for (const crate of ['toy_lib', 'toy_app']) assert.equal(step(ws, out, name, crate).status, 0);
    const publish = step(ws, out, 'publish', 'toy_app');
    assert.equal(publish.status, 9, publish.stdout);
    assert.match(publish.result.message, /toy_lib::grow: the type of toy_lib\.grow here \(: Std\.U32 → Std\.U32 → Result Std\.U32\) is not the type toy_lib defines/);
    assert.equal(fs.existsSync(path.join(ws.project, 'Lean', 'App')), false, 'nothing is published from a refused edit');
    assert.equal(fs.existsSync(path.join(out, 'units', 'toy_app', 'stage-3-publish.failed.json')), true);
  });

  it('never keeps an axiom silently: an item the provider does not define must be named in the assume list', () => {
    const ws = workspace(behaviour());
    const { out } = attempted(ws, stitched({ stitch: [{ crate: 'toy_lib' }] }));
    for (const name of ['charon', 'aeneas']) for (const crate of ['toy_lib', 'toy_app']) assert.equal(step(ws, out, name, crate).status, 0);
    const publish = step(ws, out, 'publish', 'toy_app');
    assert.equal(publish.status, 9, publish.stdout);
    assert.match(publish.result.message, /toy_lib::other_mod::skipped \(toy_lib\.other_mod\.skipped\) is not defined by toy_lib; stitching never keeps an axiom silently/);
  });

  it('waits for the provider\'s Aeneas output and then publishes, without ending the crate\'s chain', () => {
    const ws = workspace(behaviour());
    const { out } = attempted(ws, stitched());
    assert.equal(step(ws, out, 'charon', 'toy_app').status, 0);
    assert.equal(step(ws, out, 'aeneas', 'toy_app').status, 0);
    const early = step(ws, out, 'publish', 'toy_app');
    assert.equal(early.status, 8, early.stdout);
    assert.match(early.result.message, /stitching to crate toy_lib: its Aeneas stage is not completed/);
    assert.equal(fs.existsSync(path.join(out, 'units', 'toy_app', 'stage-3-publish.failed.json')), false, 'a provider that is not ready is not a failure of this crate');
    assert.equal(step(ws, out, 'charon', 'toy_lib').status, 0);
    assert.equal(step(ws, out, 'aeneas', 'toy_lib').status, 0);
    assert.equal(step(ws, out, 'publish', 'toy_app').status, 0);
    assert.equal(step(ws, out, 'publish', 'toy_lib').status, 0);
    assert.equal(engine(ws, ['attempt-status', '--out', out]).status, 0);
  });

  it('refuses the status when the published Lean no longer reproduces from the recorded inputs', () => {
    for (const tamper of [
      (ws, out) => fs.appendFileSync(path.join(ws.project, 'Lean/App/ToyApp.lean'), '-- edited\n'),
      (ws, out) => fs.appendFileSync(path.join(out, 'units', 'toy_app', 'publish-dest', 'ToyApp.lean'), '-- edited\n'),
      (ws, out) => fs.appendFileSync(path.join(out, 'units', 'toy_lib', 'aeneas-dest', 'ToyLib.lean'), '-- edited\n'),
    ]) {
      const ws = workspace(behaviour());
      const out = complete(ws, stitched());
      assert.equal(engine(ws, ['attempt-status', '--out', out]).status, 0);
      tamper(ws, out);
      const status = engine(ws, ['attempt-status', '--out', out]);
      assert.equal(status.status, 8, status.stdout);
      assert.equal(status.result.code, 'attempt-refused');
    }
  });
});

describe('substitutions: exact text edits of the generated Lean with the match count they must find', () => {
  const edit = (extra = {}) => ({ file: 'ToyApp.lean', find: 'let x ← toy_lib.one\n  ok x', replace: 'let y ← toy_lib.one\n  ok y', count: 1, reason: 'rename a local that the project\'s specs name', ...extra });

  it('applies the edit, records both hashes, and publishes the edited file', () => {
    const ws = workspace(behaviour());
    const out = complete(ws, stitched({ stitch: undefined, substitutions: [edit()] }));
    assert.match(published(ws, 'Lean/App/ToyApp.lean'), /let y ← toy_lib\.one\n {2}ok y/);
    const { run } = engine(ws, ['attempt-status', '--out', out]).result;
    const app = run.units.find((unit) => unit.crate === 'toy_app');
    assert.equal(app.substitutions.length, 1);
    const [entry] = app.substitutions;
    assert.deepEqual([entry.file, entry.count, entry.reason], ['ToyApp.lean', 1, 'rename a local that the project\'s specs name']);
    assert.notEqual(entry.beforeSha256, entry.afterSha256);
    assert.equal(app.publication.find((item) => item.projectPath.endsWith('ToyApp.lean')).sha256, entry.afterSha256);
    assert.deepEqual(app.stitch, [], 'no stitching was declared');
  });

  it('fails the publish stage when the text matches a different number of times, and publishes nothing', () => {
    const ws = workspace(behaviour());
    const { out } = attempted(ws, stitched({ stitch: undefined, substitutions: [edit({ count: 2 })] }));
    for (const name of ['charon', 'aeneas']) assert.equal(step(ws, out, name, 'toy_app').status, 0);
    const publish = step(ws, out, 'publish', 'toy_app');
    assert.equal(publish.status, 9, publish.stdout);
    assert.match(publish.result.message, /substitution 0 expects 2 match\(es\) of .* in ToyApp\.lean and finds 1/);
    assert.equal(fs.existsSync(path.join(ws.project, 'Lean', 'App')), false);
  });

  it('refuses a substitution that names a file the translation did not produce', () => {
    const ws = workspace(behaviour());
    const { out } = attempted(ws, stitched({ stitch: undefined, substitutions: [edit({ file: 'Missing.lean' })] }));
    for (const name of ['charon', 'aeneas']) assert.equal(step(ws, out, name, 'toy_app').status, 0);
    const publish = step(ws, out, 'publish', 'toy_app');
    assert.equal(publish.status, 9, publish.stdout);
    assert.match(publish.result.message, /a substitution names Missing\.lean, which is not a generated Lean file \(ToyApp\.lean\)/);
  });

  it('works for a single-crate attempt as well', () => {
    const ws = workspace({ toy_lib: { lean: lib() } });
    const out = path.join(ws.root, 'copies', 'single');
    assert.equal(engine(ws, ['prepare', '--project-root', ws.project, '--out', out]).status, 0);
    const spec = { release: toySpec().release, crate: 'toy_lib', publishDir: 'Lean/Lib', cargoArgs: ['--locked', '--package', 'toy-lib'], substitutions: [{ file: 'ToyLib.lean', find: 'def one : Result Std.U32 := ok 1#u32', replace: 'def one : Result Std.U32 := ok 7#u32', count: 1, reason: 'exercise the edit' }] };
    assert.equal(engine(ws, ['attempt', '--out', out, '--spec', specFile(ws, spec)]).status, 0);
    for (const name of ['charon', 'aeneas', 'publish']) assert.equal(engine(ws, ['run', '--out', out, '--step', name]).status, 0);
    assert.match(published(ws, 'Lean/Lib/ToyLib.lean'), /ok 7#u32/);
    const status = engine(ws, ['attempt-status', '--out', out]);
    assert.equal(status.status, 0, status.stdout);
    assert.equal(status.result.run.substitutions.length, 1);
  });
});

describe('stitching and substitutions: the spec is checked before anything is written', () => {
  const refused = (spec, pattern) => {
    const ws = workspace(behaviour());
    const { out, recorded } = attempted(ws, spec);
    assert.equal(recorded.status, 5, recorded.stdout);
    assert.equal(recorded.result.code, 'invalid-input');
    assert.match(recorded.result.message, pattern);
    assert.equal(fs.existsSync(path.join(out, 'attempt.json')), false);
    assert.equal(fs.existsSync(path.join(out, 'units')), false);
  };

  it('refuses a stitch that cannot be imported or that goes round in a circle', () => {
    refused(stitched({ stitch: [{ crate: 'toy_other' }] }), /stitch\[0\]\.crate toy_other is not a crate of this attempt/);
    refused(stitched({ stitch: [{ crate: 'toy_app' }] }), /stitch\[0\]\.crate names the crate itself/);
    refused(stitched({ stitch: [{ crate: 'toy_lib' }, { crate: 'toy_lib' }] }), /stitch names crate toy_lib more than once/);
    refused(stitched({ stitch: [{ crate: 'toy_lib', assume: ['toy_app::x'] }] }), /stitch\[0\]\.assume must list Rust paths of crate toy_lib/);
    const noRoot = stitched();
    delete noRoot.crates[0].moduleRoot;
    refused(noRoot, /toy_app is stitched to toy_lib, which names no moduleRoot/);
    const circle = stitched();
    circle.crates[0].stitch = [{ crate: 'toy_app' }];
    refused(circle, /stitching is circular through/);
    const badRoot = stitched();
    badRoot.crates[0].moduleRoot = 'Toy..Lib';
    refused(badRoot, /spec\.moduleRoot must be the Lean module name/);
  });

  it('refuses malformed substitutions', () => {
    const base = { file: 'ToyApp.lean', find: 'x', replace: 'y', count: 1, reason: 'why' };
    refused(stitched({ substitutions: [{ ...base, count: 0 }] }), /substitutions\[0\]\.count must be the exact number of matches/);
    refused(stitched({ substitutions: [{ ...base, find: '' }] }), /substitutions\[0\]\.find must be the exact non-empty text/);
    refused(stitched({ substitutions: [{ ...base, reason: ' ' }] }), /substitutions\[0\]\.reason must say why/);
    refused(stitched({ substitutions: [{ ...base, file: '../ToyApp.lean' }] }), /substitutions\[0\]\.file must name a generated Lean file/);
    refused(stitched({ substitutions: [{ ...base, regex: true }] }), /substitutions\[0\] has unsupported fields: regex/);
  });

  it('refuses stitching in a single-crate spec', () => {
    const ws = workspace(behaviour());
    const out = path.join(ws.root, 'copies', 'single');
    assert.equal(engine(ws, ['prepare', '--project-root', ws.project, '--out', out]).status, 0);
    const spec = { release: toySpec().release, crate: 'toy_app', publishDir: 'Lean/App', stitch: [{ crate: 'toy_lib' }] };
    const recorded = engine(ws, ['attempt', '--out', out, '--spec', specFile(ws, spec)]);
    assert.equal(recorded.status, 5, recorded.stdout);
    assert.match(recorded.result.message, /stitch needs a multi-crate spec/);
  });
});
