'use strict';

// Edits to the generated Lean: the exact text substitutions of the spec, and stitching a
// crate to the crate whose real translation replaces its axioms. Charon, Aeneas, rustc
// and cargo are fake scripts; the Lean text they write has the shape Aeneas writes (a
// doc comment with the Rust path, a `rust_*` attribute on a foreign axiom). Lean itself
// is the signature gate in a real project; the engine pre-check only refuses a
// difference it can read.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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

// Aeneas names a shadowed local with a middle dot (U+00B7), which a Lean name cannot contain.
const SHADOWED = APP.replace('let x ← toy_lib.one\n  ok x', 'let x· ← toy_lib.one\n  ok x·');
const shadowed = (extra = {}) => behaviour({ toy_app: { lean: SHADOWED }, ...extra });

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
    assert.deepEqual(entry.replaced.map((item) => item.check), Array(4).fill('pending-lean-build'), 'no check has run: Lean runs it when the published module builds');
    assert.deepEqual(entry.replaced.map((item) => item.textComparison), ['equal', 'equal', 'undecided', 'equal'], 'what the engine could read of each signature');
    // The check itself is part of the published module, so the normal build runs it.
    assert.match(text, /\nopen Lean Meta Elab Command in\nrun_cmd liftTermElabM do\n {2}for \(consumer, provider, lift\) in \[\n {6}\(`toy_app\.toy_lib\.one, `toy_lib\.one, false\),\n {6}\(`toy_app\.toy_lib\.TWO, `toy_lib\.TWO, true\),\n {6}\(`toy_app\.toy_lib\.Thing, `toy_lib\.Thing, false\),\n {6}\(`toy_app\.toy_lib\.grow, `toy_lib\.grow, false\)\] do\n/);
    assert.match(text, /unless a\.levelParams\.length == b\.levelParams\.length do/);
    assert.match(text, /unless \(← isDefEq a\.type expected\) do/);
    assert.doesNotMatch(text, /other_mod\.skipped, /, 'an assumed item stays an axiom and is not compared');
    assert.deepEqual(app.leanChecks.map(({ file, module, items }) => [file, module, items]), [['ToyApp.lean', 'Toy.App.ToyApp', 4]]);
    // A reader may refuse a unit that replaced aliases without a block: the two always go together, because
    // the block is built from the same list of replaced items, one block per file that has any.
    const replacedTotal = app.stitch.reduce((sum, provider) => sum + provider.replaced.length, 0);
    assert.equal(app.leanChecks.reduce((sum, check) => sum + check.items, 0), replacedTotal);
    assert.deepEqual(app.leanChecks.map((check) => check.file).sort(), [...new Set(app.stitch.flatMap((provider) => provider.files))].sort());
    assert.match(app.leanChecks[0].blockSha256, /^[0-9a-f]{64}$/);
    const publishedFile = app.publication.find((entry) => entry.relativePath.endsWith('Lean/App/ToyApp.lean'));
    assert.equal(app.leanChecks[0].fileSha256, publishedFile.sha256, 'the file the block was appended to is the published file');
    assert.notEqual(app.leanChecks[0].blockSha256, app.leanChecks[0].fileSha256);
    // The block is the exact suffix of the published file, so its length and hash can be checked without knowing its text.
    const publishedText = fs.readFileSync(path.join(ws.project, 'Lean/App/ToyApp.lean'));
    assert.equal(crypto.createHash('sha256').update(publishedText.subarray(publishedText.length - app.leanChecks[0].blockBytes)).digest('hex'), app.leanChecks[0].blockSha256);
    assert.equal(app.leanChecks[0].relativePath, 'Lean/App/ToyApp.lean');
    assert.equal(app.leanChecks[0].relativePath, publishedFile.relativePath);
    assert.deepEqual(library.leanChecks ?? [], [], 'a crate that stitches nothing has no check');
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
    assert.equal(step(ws, out, 'publish', 'toy_lib').status, 0, 'the provider is published first');
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
    assert.equal(step(ws, out, 'publish', 'toy_lib').status, 0, 'the provider is published first');
    const publish = step(ws, out, 'publish', 'toy_app');
    assert.equal(publish.status, 9, publish.stdout);
    assert.match(publish.result.message, /toy_lib::other_mod::skipped \(toy_lib\.other_mod\.skipped\) is not defined by toy_lib; stitching never keeps an axiom silently/);
  });

  it('waits for the provider\'s publication and then publishes, without ending the crate\'s chain', () => {
    const ws = workspace(behaviour());
    const { out } = attempted(ws, stitched());
    assert.equal(step(ws, out, 'charon', 'toy_app').status, 0);
    assert.equal(step(ws, out, 'aeneas', 'toy_app').status, 0);
    const early = step(ws, out, 'publish', 'toy_app');
    assert.equal(early.status, 8, early.stdout);
    assert.match(early.result.message, /stitching to crate toy_lib: its charon stage is not completed; run that crate through publish first/);
    assert.equal(fs.existsSync(path.join(out, 'units', 'toy_app', 'stage-3-publish.failed.json')), false, 'a provider that is not ready is not a failure of this crate');
    assert.equal(step(ws, out, 'charon', 'toy_lib').status, 0);
    assert.equal(step(ws, out, 'aeneas', 'toy_lib').status, 0);
    const unpublished = step(ws, out, 'publish', 'toy_app');
    assert.equal(unpublished.status, 8, unpublished.stdout);
    assert.match(unpublished.result.message, /stitching to crate toy_lib: its publish stage is not completed; run that crate through publish first, because this crate imports what it published/, 'the Aeneas output of the provider is not what Lean loads');
    assert.equal(step(ws, out, 'publish', 'toy_lib').status, 0);
    assert.equal(step(ws, out, 'publish', 'toy_app').status, 0);
    assert.equal(engine(ws, ['attempt-status', '--out', out]).status, 0);
  });

  it('refuses the status when the published Lean no longer reproduces from the recorded inputs', () => {
    for (const tamper of [
      (ws, out) => fs.appendFileSync(path.join(ws.project, 'Lean/App/ToyApp.lean'), '-- edited\n'),
      (ws, out) => fs.writeFileSync(path.join(ws.project, 'Lean/App/ToyApp.lean'), fs.readFileSync(path.join(ws.project, 'Lean/App/ToyApp.lean'), 'utf8').replace(/\n\/-! The declared type[\s\S]*$/, '\n')),
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

describe('the provider is its final publication, and an item has one declaration', () => {
  const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
  const blockOf = (text, rustPath) => text.split(/\n{2,}/).find((candidate) => candidate.startsWith('/--') && candidate.includes(`[${rustPath}]`));
  const reasonText = 'Aeneas names a shadowed local with a middle dot, which a Lean name cannot contain';
  // Charon and Aeneas of both crates; the publications are left to the test.
  const throughAeneas = (ws, spec) => {
    const { out } = attempted(ws, spec);
    for (const name of ['charon', 'aeneas']) for (const crate of ['toy_lib', 'toy_app']) assert.equal(step(ws, out, name, crate).status, 0);
    return out;
  };
  const GROW_AXIOM = '@[rust_fun "toy_lib::grow"]\naxiom toy_lib.grow\n  : Std.U32 → Std.U32 → Result Std.U32';
  const SKIPPED_AXIOM = '@[rust_fun "toy_lib::other_mod::skipped"]\naxiom toy_lib.other_mod.skipped : Result Unit';
  const consumer = (...pairs) => behaviour({ toy_app: { lean: pairs.reduce((text, [from, to]) => { assert.ok(text.includes(from), from); return text.replace(from, to); }, APP) } });
  const twice = (name, rustPath, namespace) => `/-- [${rustPath}]:\n    Source: 'x.rs', lines 1:0-1:1\n    Visibility: public -/\ndef ${name} : Result Std.U32 := ok 2#u32\n\nend ${namespace}`;

  it('takes the declaration hashes from the provider\'s final Lean, not from the raw Aeneas output', () => {
    const shadowedLib = lib().replace('Result Std.U32 := do\n  a + b', 'Result Std.U32 := do\n  let x· ← ok a\n  x· + b');
    const ws = workspace(behaviour({ toy_lib: { lean: shadowedLib } }));
    const spec = stitched();
    spec.crates[0].substitutions = [{ file: 'ToyLib.lean', find: 'x·', replace: 'x_mid', count: 2, reason: reasonText }];
    const out = complete(ws, spec);
    const finalBlock = blockOf(published(ws, 'Lean/Lib/ToyLib.lean'), 'toy_lib::grow');
    assert.match(finalBlock, /x_mid/);
    const entry = engine(ws, ['attempt-status', '--out', out]).result.run.units.find((unit) => unit.crate === 'toy_app').stitch[0];
    const grow = entry.replaced.find((item) => item.rustPath === 'toy_lib::grow');
    assert.equal(grow.providerDeclSha256, hash(finalBlock));
    const raw = fs.readFileSync(path.join(out, 'units', 'toy_lib', 'aeneas-dest', 'ToyLib.lean'), 'utf8');
    assert.notEqual(grow.providerDeclSha256, hash(blockOf(raw, 'toy_lib::grow')), 'the raw output is not what Lean loads');
    assert.equal(entry.providerStage, 'publish');
  });

  it('refuses to publish against a provider whose published Lean changed after its publication', () => {
    const ws = workspace(behaviour());
    const out = throughAeneas(ws, stitched());
    assert.equal(step(ws, out, 'publish', 'toy_lib').status, 0);
    fs.appendFileSync(path.join(ws.project, 'Lean/Lib/ToyLib.lean'), '-- edited\n');
    const refused = step(ws, out, 'publish', 'toy_app');
    assert.equal(refused.status, 8, refused.stdout);
    assert.match(refused.result.message, /stitching to crate toy_lib: its attempt is not consistent \(.*changed after publication.*\)/);
    assert.equal(fs.existsSync(path.join(ws.project, 'Lean', 'App')), false);
  });

  it('refuses a name declared twice, in the provider or in the consumer, instead of binding to the last one', () => {
    const provider = workspace(behaviour({ toy_lib: { lean: lib().replace('end toy_lib', twice('one', 'toy_lib::one', 'toy_lib')) } }));
    const out = throughAeneas(provider, stitched());
    assert.equal(step(provider, out, 'publish', 'toy_lib').status, 0);
    const refused = step(provider, out, 'publish', 'toy_app');
    assert.equal(refused.status, 8, refused.stdout);
    assert.match(refused.result.message, /stitching to crate toy_lib: its published Lean declares one more than once, so no declaration of it is a unique target/);

    const ws = workspace(consumer(['end toy_app', twice('three', 'toy_app::three', 'toy_app')]));
    const outApp = throughAeneas(ws, stitched());
    assert.equal(step(ws, outApp, 'publish', 'toy_lib').status, 0);
    const own = step(ws, outApp, 'publish', 'toy_app');
    assert.equal(own.status, 9, own.stdout);
    assert.match(own.result.message, /this crate's Lean declares three more than once, so a declaration of it is not a unique target/);
  });

  it('reads a declaration with explicit universe parameters as the item it is, so it is stitched and cannot be assumed', () => {
    const universe = workspace(behaviour({ toy_lib: { lean: lib().replace('def one : Result Std.U32 := ok 1#u32', 'def one.{u} : Result Std.U32 := ok 1#u32') } }));
    const out = throughAeneas(universe, stitched());
    assert.equal(step(universe, out, 'publish', 'toy_lib').status, 0);
    const done = step(universe, out, 'publish', 'toy_app');
    assert.equal(done.status, 0, done.stdout);
    const entry = engine(universe, ['attempt-status', '--out', out]).result.run.units.find((unit) => unit.crate === 'toy_app').stitch[0];
    assert.ok(entry.replaced.some((item) => item.rustPath === 'toy_lib::one'), 'the item with a universe binder is replaced like any other');
  });

  it('refuses an assume over an item the provider defines under another name', () => {
    const ws = workspace(consumer(['axiom toy_lib.grow\n', 'axiom toy_lib.grow_alt\n']));
    const out = throughAeneas(ws, stitched({ stitch: [{ crate: 'toy_lib', assume: ['toy_lib::grow'] }] }));
    assert.equal(step(ws, out, 'publish', 'toy_lib').status, 0);
    const refused = step(ws, out, 'publish', 'toy_app');
    assert.equal(refused.status, 9, refused.stdout);
    assert.match(refused.result.message, /toy_lib::grow \(toy_lib\.grow_alt\) is named in the assume list, but toy_lib declares it \(def\)/);
  });

  describe('a copy of an item of the provider', () => {
    const attemptWith = (variant, spec) => {
      const ws = workspace(variant);
      const out = throughAeneas(ws, spec);
      assert.equal(step(ws, out, 'publish', 'toy_lib').status, 0);
      return { ws, out, publish: step(ws, out, 'publish', 'toy_app') };
    };

    it('is refused when the provider defines the same item too', () => {
      const { publish, ws } = attemptWith(consumer([GROW_AXIOM, 'def toy_lib.grow (a : Std.U32) (b : Std.U32) : Result Std.U32 := do\n  a + b']), stitched());
      assert.equal(publish.status, 9, publish.stdout);
      assert.match(publish.result.message, /toy_lib::grow \(toy_lib\.grow\) is also defined as a def in this crate's Lean, and toy_lib defines it too \(def\): two declarations stand for one Rust item, and toy_lib's theorems concern the other one/);
      assert.equal(fs.existsSync(path.join(ws.project, 'Lean', 'App')), false);
    });

    it('is refused when the provider does not define it and the owner did not say so', () => {
      const { publish } = attemptWith(consumer([SKIPPED_AXIOM, 'def toy_lib.other_mod.skipped : Result Unit := ok ()']), stitched({ stitch: [{ crate: 'toy_lib' }] }));
      assert.equal(publish.status, 9, publish.stdout);
      assert.match(publish.result.message, /toy_lib::other_mod::skipped \(toy_lib\.other_mod\.skipped\) is an item of toy_lib that this crate's Lean defines itself, and toy_lib does not define it; name it in the stitch assume list/);
    });

    it('is recorded, with the assume prefix that covers it, when the provider does not define it', () => {
      const { ws, out, publish } = attemptWith(consumer([SKIPPED_AXIOM, 'def toy_lib.other_mod.skipped : Result Unit := ok ()']), stitched());
      assert.equal(publish.status, 0, publish.stdout);
      const entry = engine(ws, ['attempt-status', '--out', out]).result.run.units.find((unit) => unit.crate === 'toy_app').stitch[0];
      assert.deepEqual(entry.copies, [{ rustPath: 'toy_lib::other_mod::skipped', name: 'toy_lib.other_mod.skipped', keyword: 'def', assume: 'toy_lib::other_mod' }]);
      assert.deepEqual(entry.assumed, [], 'a copy is a definition here, not an assumed axiom');
    });
  });
});

describe('a target the crate calls is stitched, or nothing is published', () => {
  const stitchedStages = (ws, spec) => {
    const { out } = attempted(ws, spec);
    for (const name of ['charon', 'aeneas']) for (const crate of ['toy_lib', 'toy_app']) assert.equal(step(ws, out, name, crate).status, 0);
    assert.equal(step(ws, out, 'publish', 'toy_lib').status, 0, 'the provider is published first');
    return { out, publish: step(ws, out, 'publish', 'toy_app') };
  };
  const refusedPublish = (ws, spec, pattern) => {
    const { publish } = stitchedStages(ws, spec);
    assert.equal(publish.status, 9, publish.stdout);
    assert.match(publish.result.message, pattern);
    assert.equal(fs.existsSync(path.join(ws.project, 'Lean', 'App')), false, 'nothing is published');
  };
  const withApp = (...pairs) => behaviour({ toy_app: { lean: pairs.reduce((text, [from, to]) => { assert.ok(text.includes(from), from); return text.replace(from, to); }, APP) } });

  it('refuses a crate that reaches a target with no stitch entry', () => {
    refusedPublish(workspace(behaviour()), stitched({ stitch: undefined }), /the LLBC reaches target crate toy_lib, and the spec has no stitch entry for it, so its items would stay axioms here; add a stitch entry, or declare toy_lib a non-target/);
  });

  it('refuses a target-wide assume, an assume over an item the provider declares, and a stale assume entry', () => {
    const ws = workspace(behaviour());
    const { recorded } = attempted(ws, stitched({ stitch: [{ crate: 'toy_lib', assume: ['toy_lib'] }] }));
    assert.equal(recorded.status, 5, recorded.stdout);
    assert.match(recorded.result.message, /stitch\[0\]\.assume names the whole crate toy_lib; list the modules or items it does not define/);
    refusedPublish(workspace(behaviour()), stitched({ stitch: [{ crate: 'toy_lib', assume: ['toy_lib::other_mod', 'toy_lib::one'] }] }), /toy_lib::one \(toy_lib\.one\) is named in the assume list, but toy_lib declares it \(def\); it is stitched, and the assume list only names items the provider does not declare/);
    refusedPublish(workspace(behaviour()), stitched({ stitch: [{ crate: 'toy_lib', assume: ['toy_lib::other_mod', 'toy_lib::gone'] }] }), /stitch to toy_lib: the assume entry toy_lib::gone matches no axiom of this crate, so it is stale/);
  });

  it('refuses an axiom for a target\'s item that stitching neither replaced nor recorded', () => {
    const hidden = ['/-- [toy_app::three]:', '/-- [toy_lib::hidden]:\n    Visibility: public -/\naxiom toy_lib.hidden : Result Unit\n\n/-- [toy_app::three]:'];
    refusedPublish(workspace(withApp(hidden)), stitched(), /ToyApp\.lean: the axiom toy_lib\.hidden stands for toy_lib::hidden, an item of target crate toy_lib, which stitching neither replaces nor records as assumed/);
  });

  it('refuses an axiom that carries no readable Rust path', () => {
    const bare = ['/-- [toy_app::three]:', 'axiom toy_app.mystery : Result Unit\n\n/-- [toy_app::three]:'];
    refusedPublish(workspace(withApp(bare)), stitched(), /ToyApp\.lean: the axiom toy_app\.mystery carries no readable Rust path, so it cannot be classified/);
  });

  it('accepts the crate\'s own axioms and the standard library\'s, and still records the assumed ones', () => {
    const own = ['/-- [toy_app::three]:', '/-- [core::mem::swap]:\n    Visibility: public -/\n@[rust_fun "core::mem::swap"]\naxiom core.mem.swap : Result Unit\n\n/-- [toy_app::own]:\n    Visibility: public -/\naxiom toy_app.own : Result Unit\n\n/-- [toy_app::three]:'];
    const ws = workspace(withApp(own));
    const out = complete(ws, stitched());
    const { run } = engine(ws, ['attempt-status', '--out', out]).result;
    assert.deepEqual(run.units.find((unit) => unit.crate === 'toy_app').stitch[0].assumed.map((item) => item.rustPath), ['toy_lib::other_mod::skipped']);
  });

  it('records that an alias stands for an item the provider itself leaves opaque', () => {
    const opaque = lib().replace('def one : Result Std.U32 := ok 1#u32', 'axiom one : Result Std.U32');
    const ws = workspace(behaviour({ toy_lib: { lean: opaque } }));
    const out = complete(ws, stitched());
    const { run } = engine(ws, ['attempt-status', '--out', out]).result;
    const [stitch] = run.units.find((unit) => unit.crate === 'toy_app').stitch;
    assert.deepEqual(stitch.replaced.map(({ rustPath, providerKind, providerOpaque }) => [rustPath, providerKind, providerOpaque]), [
      ['toy_lib::one', 'axiom', true], ['toy_lib::TWO', 'def', false], ['toy_lib::Thing', 'structure', false], ['toy_lib::grow', 'def', false],
    ]);
  });
});

describe('substitutions: a rename of a name Lean cannot read, with the match count it must find', () => {
  const edit = (extra = {}) => ({ file: 'ToyApp.lean', find: 'x·', replace: 'x_mid', count: 2, reason: 'Aeneas names a shadowed local with a middle dot, which a Lean name cannot contain', ...extra });
  const only = /a substitution only renames such a name, and any other change to the translation is a translation patch of the Rust source/;

  // The spec is refused when the attempt is recorded, before anything is written.
  const specRefused = (substitutions, pattern) => {
    const ws = workspace(shadowed());
    const { recorded } = attempted(ws, stitched({ substitutions: [].concat(substitutions) }));
    assert.equal(recorded.status, 5, recorded.stdout);
    assert.match(recorded.result.message, pattern);
  };
  // The publish stage refuses and publishes nothing.
  const publishRefused = (variant, substitutions, pattern) => {
    const ws = workspace(variant);
    const { out } = attempted(ws, stitched({ substitutions: [].concat(substitutions) }));
    for (const name of ['charon', 'aeneas']) for (const crate of ['toy_lib', 'toy_app']) assert.equal(step(ws, out, name, crate).status, 0);
    assert.equal(step(ws, out, 'publish', 'toy_lib').status, 0, 'the provider is published first');
    const publish = step(ws, out, 'publish', 'toy_app');
    assert.equal(publish.status, 9, publish.stdout);
    assert.match(publish.result.message, pattern);
    assert.equal(fs.existsSync(path.join(ws.project, 'Lean', 'App')), false, 'nothing is published from a refused edit');
  };
  const variantOf = (...pairs) => behaviour({ toy_app: { lean: pairs.reduce((text, [from, to]) => { assert.ok(text.includes(from), from); return text.replace(from, to); }, APP) } });

  it('applies the rename, records both hashes, and publishes the renamed file', () => {
    const ws = workspace(shadowed());
    const out = complete(ws, stitched({ substitutions: [edit()] }));
    assert.match(published(ws, 'Lean/App/ToyApp.lean'), /let x_mid ← toy_lib\.one\n {2}ok x_mid/);
    const { run } = engine(ws, ['attempt-status', '--out', out]).result;
    const app = run.units.find((unit) => unit.crate === 'toy_app');
    assert.equal(app.substitutions.length, 1);
    const [entry] = app.substitutions;
    assert.deepEqual([entry.file, entry.count], ['ToyApp.lean', 2]);
    assert.match(entry.reason, /shadowed local/);
    assert.notEqual(entry.beforeSha256, entry.afterSha256);
    assert.equal(app.publication.find((item) => item.projectPath.endsWith('ToyApp.lean')).sha256, crypto.createHash('sha256').update(published(ws, 'Lean/App/ToyApp.lean')).digest('hex'), 'the file is published after the rename and the stitching');
    assert.equal(app.stitch.length, 1, 'the rename and the stitching are both recorded');
  });

  it('fails the publish stage when the text matches a different number of times, and publishes nothing', () => {
    publishRefused(shadowed(), edit({ count: 3 }), /substitution 0 expects 3 match\(es\) of .* in ToyApp\.lean and finds 2/);
  });

  it('refuses a substitution that names a file the translation did not produce', () => {
    publishRefused(shadowed(), edit({ file: 'Missing.lean' }), /a substitution names Missing\.lean, which is not a generated Lean file \(ToyApp\.lean\)/);
  });

  describe('is never an edit of the code', () => {
    it('refuses a change of a value, a call or a declaration', () => {
      specRefused(edit({ find: 'ok x·', replace: 'ok 7#u32' }), only);
      specRefused(edit({ find: 'toy_lib.one', replace: 'toy_lib.grow' }), only);
      specRefused(edit({ find: 'axiom toy_lib.other_mod.skipped : Result Unit', replace: 'axiom toy_lib.other_mod.skipped : 1 = 1' }), only);
      specRefused(edit({ find: 'def three : Result Std.U32 := do', replace: 'def four : Result Std.U32 := do' }), only);
      specRefused(edit({ find: 'x', replace: 'y' }), only);
    });

    it('refuses a find that is not a plain name fragment and a replace that is not a plain identifier', () => {
      specRefused(edit({ find: 'x· ←' }), only);
      specRefused(edit({ find: 'a.x·' }), only);
      specRefused(edit({ find: '' }), /find must be the exact non-empty text/);
      for (const replace of ['x·y', 'x_mid + 1', 'x.mid', '9x', '']) specRefused(edit({ replace }), /replace must be a plain identifier/);
    });

    it('refuses two renames that share a new name', () => {
      specRefused([edit(), edit({ find: 'y·' })], /substitutions\[0\]\.replace "x_mid" is also used by substitutions\[1\]: two renames never share a new name/);
    });

    it('refuses a new name that already occurs in the crate\'s generated Lean', () => {
      publishRefused(shadowed(), edit({ replace: 'three' }), /"three" already occurs in ToyApp\.lean, so the renamed name could capture an existing one/);
      publishRefused(shadowed(), edit({ replace: 'ok' }), /"ok" already occurs in ToyApp\.lean/);
    });

    it('refuses to rename a field or a part of a qualified name', () => {
      publishRefused(variantOf(['let x ← toy_lib.one\n  ok x', 'let x· ← toy_lib.one\n  ok p.x·']), edit(), /a match of "x·" follows a '\.', and a substitution never renames a field or a part of a qualified name/);
    });
  });

  // Defense in depth: the rename itself can only be made inside a definition's body. Aeneas
  // output with the unreadable character in a declaration, an axiom or a doc comment is refused.
  describe('never reaches a declaration', () => {
    it('refuses to retype an axiom', () => {
      publishRefused(variantOf(['axiom toy_lib.other_mod.skipped : Result Unit', 'axiom toy_lib.other_mod.skipped : Result Unit·']),
        edit({ find: 'Unit·', replace: 'Unit_x', count: 1 }), /substitution 0 is refused in ToyApp\.lean: it changes the axiom toy_lib\.other_mod\.skipped, and a substitution never edits an axiom/);
    });

    it('refuses to rename a definition, or the Rust path of its doc comment', () => {
      publishRefused(variantOf(['def three : Result Std.U32 := do', 'def three· : Result Std.U32 := do']),
        edit({ find: 'three·', replace: 'three_x', count: 1 }), /it changes the name or type of three·, and a substitution edits only the body of a definition/);
      publishRefused(variantOf(['/-- [toy_app::three]:', '/-- [toy_app::three·]:']),
        edit({ find: 'three·', replace: 'three_x', count: 1 }), /it changes the name or type of three/);
    });

    it('refuses text outside any definition, such as an open line', () => {
      publishRefused(variantOf(['open Aeneas Aeneas.Std Result\nnamespace toy_app', 'open Aeneas Aeneas.Std Result\nopen Foo·\nnamespace toy_app']),
        edit({ find: 'Foo·', replace: 'Foo_x', count: 1 }), /it changes text outside a definition body \("open Foo/);
    });

    it('names no Trusted file: a substitution under a Trusted directory is refused before anything is written', () => {
      specRefused(edit({ file: 'Trusted/Sha2.lean' }), /substitutions\[0\]\.file is under a Trusted directory; a substitution edits generated Lean only, never a Trusted file/);
    });
  });

  it('works for a single-crate attempt as well', () => {
    const ws = workspace({ toy_lib: { lean: lib().replace('def one : Result Std.U32 := ok 1#u32', 'def one : Result Std.U32 := do\n  let n· := 1#u32\n  ok n·') } });
    const out = path.join(ws.root, 'copies', 'single');
    assert.equal(engine(ws, ['prepare', '--project-root', ws.project, '--out', out]).status, 0);
    const spec = { release: toySpec().release, crate: 'toy_lib', publishDir: 'Lean/Lib', cargoArgs: ['--locked', '--package', 'toy-lib'], substitutions: [{ file: 'ToyLib.lean', find: 'n·', replace: 'n_one', count: 2, reason: 'a local named with a middle dot' }] };
    assert.equal(engine(ws, ['attempt', '--out', out, '--spec', specFile(ws, spec)]).status, 0);
    for (const name of ['charon', 'aeneas', 'publish']) assert.equal(engine(ws, ['run', '--out', out, '--step', name]).status, 0);
    assert.match(published(ws, 'Lean/Lib/ToyLib.lean'), /let n_one := 1#u32\n {2}ok n_one/);
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
    const base = { file: 'ToyApp.lean', find: 'x·', replace: 'y', count: 1, reason: 'why' };
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
