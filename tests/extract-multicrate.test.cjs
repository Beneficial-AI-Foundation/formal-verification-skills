'use strict';

// Multi-crate extraction in the patch engine: every in-repo target crate gets its
// own attempt chain inside one prepared copy; the LLBC identity rule keeps the main
// crate exact and accepts another declared crate's null contents only under its own
// label; a failed or missing crate never leaves a complete attempt. Charon, Aeneas,
// rustc and cargo are fake scripts that read the toy workspace; no real tool runs.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { toySpec, cleanup, workspace, run: engine, prepared, specFile, attempted, step, completeUnit, complete } = require('./helpers/fake-multicrate-tools.cjs');

after(cleanup);

const charonRecord = (out, crate) => JSON.parse(fs.readFileSync(path.join(out, 'units', crate, 'stage-1-charon.completed.json'), 'utf8'));
const failedCharon = (out, crate) => JSON.parse(fs.readFileSync(path.join(out, 'units', crate, 'stage-1-charon.failed.json'), 'utf8'));

describe('multi-crate extraction: the toy workspace', () => {
  it('records one attempt per crate in one prepared copy and runs every chain to publication', () => {
    const ws = workspace();
    const out = complete(ws);
    const attempt = JSON.parse(fs.readFileSync(path.join(out, 'attempt.json'), 'utf8'));
    assert.equal(attempt.schema, 'fvs-extract-patches/multi-attempt');
    assert.equal(attempt.main, 'toy_app');
    assert.deepEqual(attempt.units.map((unit) => unit.crate), ['toy_lib', 'toy_app']);
    for (const crate of ['toy_lib', 'toy_app']) {
      const unit = JSON.parse(fs.readFileSync(path.join(out, 'units', crate, 'attempt.json'), 'utf8'));
      assert.equal(unit.manifestSha256, attempt.manifestSha256, 'every crate is bound to the one prepared manifest');
      assert.equal(unit.crate, crate);
      assert.ok(unit.charon.argv.includes('--package'), 'the unit adds its own --package');
    }
    const status = engine(ws, ['attempt-status', '--out', out]);
    assert.equal(status.status, 0, status.stdout);
    const { run } = status.result;
    assert.equal(run.crate, 'toy_app', 'the top-level run is the main crate\'s');
    assert.equal(run.supported, true);
    assert.deepEqual(Object.keys(run.stages), ['charon', 'aeneas', 'publish']);
    assert.deepEqual(run.units.map((unit) => [unit.crate, unit.status, unit.publishDir]), [['toy_lib', 'complete', 'Lean/Lib'], ['toy_app', 'complete', 'Lean/App']]);
    assert.ok(fs.existsSync(path.join(ws.project, 'Lean', 'Lib', 'ToyLib.lean')));
    assert.ok(fs.existsSync(path.join(ws.project, 'Lean', 'App', 'ToyApp.lean')));
    assert.equal(run.translation.projectPath, path.join(ws.project, 'Lean', 'App', 'translation.json'));
    assert.deepEqual(run.publication.map((entry) => path.dirname(entry.projectPath)), [path.join(ws.project, 'Lean', 'App'), path.join(ws.project, 'Lean', 'App')]);
    assert.equal(engine(ws, ['verify-restore', '--out', out]).status, 0);
    assert.equal(engine(ws, ['verify-tree', '--out', out]).status, 0);
  });

  it('hands every crate out as a whole single-crate run, so a reader written for one crate reads any of them', () => {
    const ws = workspace();
    const out = complete(ws);
    const { run } = engine(ws, ['attempt-status', '--out', out]).result;
    for (const unit of run.units) {
      for (const field of ['attemptSha256', 'stages', 'manifestSha256', 'config', 'configSha256', 'llbc', 'translation', 'publication', 'hasErrors']) assert.ok(unit[field] !== undefined, `${unit.crate} row lacks ${field}`);
      const one = engine(ws, ['attempt-status', '--out', out, '--crate', unit.crate]).result;
      const { units: _, order: __, ...main } = run;
      assert.equal(one.run.crate, unit.crate);
      assert.equal(one.run.attemptSha256, unit.attemptSha256);
      assert.equal(one.run.translation.projectPath, path.join(ws.project, unit.publishDir, 'translation.json'));
      if (unit.crate === run.crate) assert.deepEqual(one.run, main, 'the main crate\'s run is the top-level run');
    }
    assert.notEqual(run.units[0].attemptSha256, run.units[1].attemptSha256);
  });

  it('treats the library as a target: its sources arrive under its own label and are pinned by the tree record', () => {
    const ws = workspace();
    const out = complete(ws);
    const app = charonRecord(out, 'toy_app');
    assert.equal(app.llbc.crate, 'toy_app');
    assert.deepEqual(app.llbc.foreignSources.map((entry) => [entry.crate, entry.file]), [['toy_lib', 'lib/src/lib.rs'], ['toy_lib', 'lib/src/more.rs']]);
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    for (const entry of app.llbc.foreignSources) assert.equal(entry.sha256, manifest.final.files[entry.file].sha256, 'each foreign source carries its recorded tree hash');
    assert.deepEqual(charonRecord(out, 'toy_lib').llbc.foreignSources, []);
    const seen = JSON.parse(fs.readFileSync(path.join(ws.release, 'seen-charon-toy_app.json'), 'utf8'));
    assert.deepEqual(seen.args.slice(seen.args.indexOf('--')), ['--', '--locked', '--package', 'toy-app']);
  });

  it('lets an overlay replace a base field, lists included', () => {
    const ws = workspace();
    const spec = toySpec({ charonArgs: ['--opaque', 'toy_lib::one'] });
    spec.crates[1].charonArgs = [];
    spec.crates[0].cargoArgs = ['--locked', '--lib'];
    const { out, recorded } = attempted(ws, spec);
    assert.equal(recorded.status, 0, recorded.stdout);
    const unit = (crate) => JSON.parse(fs.readFileSync(path.join(out, 'units', crate, 'attempt.json'), 'utf8')).spec;
    assert.deepEqual(unit('toy_lib').charonArgs, ['--opaque', 'toy_lib::one'], 'the base list applies where the overlay is silent');
    assert.deepEqual(unit('toy_lib').cargoArgs, ['--locked', '--lib', '--package', 'toy-lib']);
    assert.deepEqual(unit('toy_app').charonArgs, [], 'an overlay list replaces the base list, it is never joined');
    assert.deepEqual(unit('toy_app').cargoArgs, ['--locked', '--package', 'toy-app']);
  });
});

describe('multi-crate extraction: the LLBC identity rule', () => {
  it('refuses a declared crate\'s sources labelled with another crate', () => {
    const ws = workspace({ toy_app: { relabelForeign: 'other_crate' } });
    const { out } = attempted(ws);
    const charon = step(ws, out, 'charon', 'toy_app');
    assert.equal(charon.status, 9, charon.stdout);
    assert.match(charon.result.message, /labels lib\/src\/lib\.rs with crate "other_crate", but the file lies under declared crate "toy_lib"/);
  });

  it('refuses an in-repo crate nobody declared as a target, so none is silently made opaque', () => {
    const ws = workspace();
    const spec = toySpec();
    spec.crates = spec.crates.slice(1);
    const { out, recorded } = attempted(ws, spec);
    assert.equal(recorded.status, 0, recorded.stdout);
    const charon = step(ws, out, 'charon', 'toy_app');
    assert.equal(charon.status, 9, charon.stdout);
    assert.match(charon.result.message, /lib\/src\/lib\.rs with crate "toy_lib", but the file lies under no declared crate, so it is an in-repo crate nobody declared as a target/);
    assert.equal(fs.existsSync(path.join(out, 'units', 'toy_app', 'stage-1-charon.failed.json')), true);
  });

  it('refuses altered contents of the main crate and of a declared crate that carries contents', () => {
    for (const [behaviour, pattern] of [
      [{ toy_app: { alterMain: true } }, /the LLBC's app\/src\/lib\.rs is not the prepared source/],
      [{ toy_app: { alterForeign: true } }, /the LLBC's lib\/src\/lib\.rs is not the prepared source/],
    ]) {
      const ws = workspace(behaviour);
      const { out } = attempted(ws);
      const charon = step(ws, out, 'charon', 'toy_app');
      assert.equal(charon.status, 9, charon.stdout);
      assert.match(charon.result.message, pattern);
    }
  });

  it('refuses an LLBC for another crate than the unit names', () => {
    const ws = workspace({ toy_lib: { llbcCrate: 'toy_app' } });
    const { out } = attempted(ws);
    const charon = step(ws, out, 'charon', 'toy_lib');
    assert.equal(charon.status, 9, charon.stdout);
    assert.match(charon.result.message, /the LLBC is for crate "toy_app", not "toy_lib"/);
  });

  it('records has_errors and the affected items even though Charon exited 0', () => {
    const ws = workspace({ toy_lib: { hasErrors: true, errorItems: ['hacl::sha256_update', 'hacl::sha512_update'] } });
    const out = complete(ws);
    const lib = charonRecord(out, 'toy_lib').llbc;
    assert.equal(lib.hasErrors, true);
    assert.deepEqual(lib.items, ['fun toy_lib::hacl::sha256_update', 'fun toy_lib::hacl::sha512_update']);
    const { run } = engine(ws, ['attempt-status', '--out', out]).result;
    const row = run.units.find((unit) => unit.crate === 'toy_lib');
    assert.deepEqual(row.hasErrors, { value: true, items: lib.items, itemCount: 2 });
    assert.equal(run.units.find((unit) => unit.crate === 'toy_app').hasErrors.value, false);
    assert.equal(run.hasErrors.value, false, 'the top-level run is the main crate\'s own');
  });
});

describe('multi-crate extraction: a failed or missing crate is never a complete attempt', () => {
  it('ends only the failing crate\'s chain and refuses the whole status, naming the crate', () => {
    const ws = workspace({ toy_lib: { charonExit: 1 } });
    const { out, recorded } = attempted(ws);
    assert.equal(recorded.status, 0, recorded.stdout);
    assert.equal(step(ws, out, 'charon', 'toy_lib').status, 9);
    assert.match(failedCharon(out, 'toy_lib').reasons.join(' '), /Charon exited 1/);
    completeUnit(ws, out, 'toy_app');
    const status = engine(ws, ['attempt-status', '--out', out]);
    assert.equal(status.status, 8, status.stdout);
    assert.equal(status.result.code, 'attempt-refused');
    assert.match(status.result.message, /toy_lib failed at charon/);
    assert.deepEqual(status.result.units.map((unit) => [unit.crate, unit.status]), [['toy_lib', 'failed at charon'], ['toy_app', 'complete']]);
    const unit = engine(ws, ['attempt-status', '--out', out, '--crate', 'toy_app']);
    assert.equal(unit.status, 0, unit.stdout);
    assert.equal(unit.result.unit.status, 'complete');
    assert.equal(engine(ws, ['attempt-status', '--out', out, '--crate', 'toy_lib']).result.unit.status, 'failed at charon');
  });

  it('refuses the status while a crate has not run at all', () => {
    const ws = workspace();
    const { out } = attempted(ws);
    completeUnit(ws, out, 'toy_app');
    const status = engine(ws, ['attempt-status', '--out', out]);
    assert.equal(status.status, 8, status.stdout);
    assert.match(status.result.message, /toy_lib not run: charon is next/);
  });

  it('needs --crate for a multi-crate attempt and refuses it for a single crate', () => {
    const ws = workspace();
    const { out } = attempted(ws);
    const missing = step(ws, out, 'charon');
    assert.equal(missing.status, 2, missing.stdout);
    assert.match(missing.result.message, /--crate is required and must be one of toy_lib, toy_app/);
    assert.equal(step(ws, out, 'charon', 'nope').status, 2);
    const single = workspace();
    const spec = specFile(single, { release: toySpec().release, crate: 'toy_lib', publishDir: 'Lean/Lib', cargoArgs: ['--locked', '--package', 'toy-lib'] });
    const copy = prepared(single);
    assert.equal(engine(single, ['attempt', '--out', copy, '--spec', spec]).status, 0);
    const extra = step(single, copy, 'charon', 'toy_lib');
    assert.equal(extra.status, 2, extra.stdout);
    assert.match(extra.result.message, /--crate is only for a multi-crate attempt/);
  });

  it('refuses a crate\'s stage once its attempt record was changed after recording', () => {
    const ws = workspace();
    const { out } = attempted(ws);
    const file = path.join(out, 'units', 'toy_lib', 'attempt.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    record.supported = !record.supported;
    fs.writeFileSync(file, JSON.stringify(record));
    const charon = step(ws, out, 'charon', 'toy_lib');
    assert.equal(charon.status, 8, charon.stdout);
    assert.match(charon.result.message, /the attempt record of crate toy_lib changed after it was recorded/);
  });
});

describe('multi-crate extraction: the spec is checked before anything is written', () => {
  const refused = (spec, pattern) => {
    const ws = workspace();
    const { out, recorded } = attempted(ws, spec);
    assert.equal(recorded.status, 5, recorded.stdout);
    assert.equal(recorded.result.code, 'invalid-input');
    assert.match(recorded.result.message, pattern);
    assert.equal(fs.existsSync(path.join(out, 'attempt.json')), false, 'no attempt record was written');
    assert.equal(fs.existsSync(path.join(out, 'units')), false, 'no crate directory was created');
  };

  it('refuses a hyphenated crate name and says which name to use', () => {
    const spec = toySpec();
    spec.crates[0].crate = 'toy-lib';
    refused(spec, /crates\[0\]\.crate "toy-lib" has a hyphen; Charon labels a crate with its underscored name, so use "toy_lib"/);
  });

  it('refuses a hyphenated crate name in a single-crate spec as well', () => {
    const ws = workspace();
    const out = prepared(ws);
    const recorded = engine(ws, ['attempt', '--out', out, '--spec', specFile(ws, { release: toySpec().release, crate: 'toy-lib', publishDir: 'Lean/Lib' })]);
    assert.equal(recorded.status, 5, recorded.stdout);
    assert.match(recorded.result.message, /spec\.crate "toy-lib" has a hyphen/);
    assert.equal(fs.existsSync(path.join(out, 'attempt.json')), false);
  });

  it('refuses nested or equal output directories, a missing main, a crate directory outside the copy and --package in cargoArgs', () => {
    const nested = toySpec();
    nested.crates[1].publishDir = 'Lean/Lib/App';
    refused(nested, /the publishDir of toy_lib \(Lean\/Lib\) and of toy_app \(Lean\/Lib\/App\) are the same or nested/);
    refused(toySpec({ main: 'toy_other' }), /main must name one of the crates \(toy_lib, toy_app\)/);
    const away = toySpec();
    away.crates[0].dir = 'missing';
    refused(away, /crates\[0\]\.dir missing holds no Cargo\.toml in the extraction copy/);
    const packaged = toySpec();
    packaged.crates[0].cargoArgs = ['--locked', '--package', 'toy-lib'];
    refused(packaged, /crates\[0\]\.cargoArgs must not carry --package/);
    refused(toySpec({ crate: 'toy_app' }), /unsupported fields: crate/);
    const twice = toySpec();
    twice.crates[1].crate = 'toy_lib';
    refused(twice, /crates names crate toy_lib more than once/);
  });
});
