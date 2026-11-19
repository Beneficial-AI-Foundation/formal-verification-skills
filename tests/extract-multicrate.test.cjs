'use strict';

// Multi-crate extraction in the patch engine: every in-repo target crate gets its
// own attempt chain inside one prepared copy; the LLBC identity rule keeps the main
// crate exact and accepts another declared crate's null contents only under its own
// label; a failed or missing crate never leaves a complete attempt. Charon, Aeneas,
// rustc and cargo are fake scripts that read the toy workspace; no real tool runs.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
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
      const { units: _, order: __, roster: ___, ...main } = run;
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
    spec.crates = spec.crates.slice(1).map(({ stitch, ...rest }) => rest);
    const { out, recorded } = attempted(ws, spec);
    assert.equal(recorded.status, 8, recorded.stdout);
    assert.match(recorded.result.message, /the workspace is not accounted for: 1 in-repo crate\(s\) of the workspace are neither a target, a non-target nor dropped: toy_lib; every in-repo crate is a target unless the owner decides otherwise/);
    assert.equal(fs.existsSync(path.join(out, 'attempt.json')), false, 'nothing is recorded');
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

describe('multi-crate extraction: the roster binds an attempt to its crates', () => {
  const rosterHash = (roster) => crypto.createHash('sha256').update(JSON.stringify(roster)).digest('hex');
  const edit = (out, change) => {
    const file = path.join(out, 'attempt.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    change(record);
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  };
  // toy_app fails at Charon and toy_lib, the main crate, completes: without the roster a status that
  // has lost toy_app's row sees only a complete crate.
  const withFailedApp = () => {
    const ws = workspace({ toy_app: { charonExit: 1 } });
    const { out, recorded } = attempted(ws, toySpec({ main: 'toy_lib' }));
    assert.equal(recorded.status, 0, recorded.stdout);
    assert.equal(step(ws, out, 'charon', 'toy_app').status, 9);
    completeUnit(ws, out, 'toy_lib');
    assert.equal(engine(ws, ['attempt-status', '--out', out]).status, 8, 'the failed crate keeps the attempt incomplete');
    return { ws, out };
  };
  const refusedStatus = (ws, out, pattern) => {
    const status = engine(ws, ['attempt-status', '--out', out]);
    assert.equal(status.status, 8, status.stdout);
    assert.match(status.result.message, pattern);
  };

  it('puts one canonical roster, and its hash, in the top-level record, in every unit record and in the status', () => {
    const ws = workspace();
    const out = complete(ws);
    const attempt = JSON.parse(fs.readFileSync(path.join(out, 'attempt.json'), 'utf8'));
    assert.deepEqual(attempt.roster, {
      main: 'toy_app',
      order: ['toy_lib', 'toy_app'],
      units: [{ crate: 'toy_lib', package: 'toy-lib', dir: 'lib', stitch: [] }, { crate: 'toy_app', package: 'toy-app', dir: 'app', stitch: ['toy_lib'] }],
      nonTargets: [],
      dropped: [],
    });
    assert.equal(attempt.rosterSha256, rosterHash(attempt.roster));
    for (const crate of ['toy_lib', 'toy_app']) {
      const unit = JSON.parse(fs.readFileSync(path.join(out, 'units', crate, 'attempt.json'), 'utf8'));
      assert.deepEqual(unit.roster, attempt.roster);
      assert.equal(unit.rosterSha256, attempt.rosterSha256);
    }
    const { run } = engine(ws, ['attempt-status', '--out', out]).result;
    assert.equal(run.rosterSha256, attempt.rosterSha256);
    assert.deepEqual(run.roster, attempt.roster);
    assert.deepEqual(run.units.map((unit) => unit.rosterSha256), [attempt.rosterSha256, attempt.rosterSha256]);
  });

  it('refuses a status whose top-level record lost the row of a failed crate, with nothing else changed', () => {
    const { ws, out } = withFailedApp();
    edit(out, (record) => { record.units = record.units.filter((unit) => unit.crate !== 'toy_app'); });
    refusedStatus(ws, out, /the units \(toy_lib\) are not the crates of the roster \(toy_lib, toy_app\)/);
  });

  it('refuses it as well when the roster, its hash and the order were rewritten to match the shorter list', () => {
    const { ws, out } = withFailedApp();
    edit(out, (record) => {
      record.units = record.units.filter((unit) => unit.crate !== 'toy_app');
      record.order = ['toy_lib'];
      record.roster = { ...record.roster, order: ['toy_lib'], units: record.roster.units.filter((unit) => unit.crate === 'toy_lib') };
      record.rosterSha256 = rosterHash(record.roster);
    });
    refusedStatus(ws, out, /the attempt record of crate toy_lib does not carry this attempt's roster/);
  });

  it('refuses a changed main, a changed row, changed dropped crates and a stray unit directory', () => {
    const { ws, out } = withFailedApp();
    const original = fs.readFileSync(path.join(out, 'attempt.json'), 'utf8');
    const restore = () => fs.writeFileSync(path.join(out, 'attempt.json'), original);
    edit(out, (record) => { record.main = 'toy_app'; });
    refusedStatus(ws, out, /main is toy_app, the roster says toy_lib/);
    restore();
    edit(out, (record) => { record.units.find((unit) => unit.crate === 'toy_lib').package = 'toy-app'; });
    refusedStatus(ws, out, /the row of crate toy_lib \(package toy-app, directory lib, imports none\) is not what the roster says \(package toy-lib/);
    restore();
    edit(out, (record) => { record.dropped = [{ crate: 'ghost', reason: 'left out by hand' }]; });
    refusedStatus(ws, out, /the dropped crates are not the roster's/);
    restore();
    fs.mkdirSync(path.join(out, 'units', 'ghost'));
    refusedStatus(ws, out, /the directories under units \(ghost, toy_app, toy_lib\) are not the crates of the roster/);
    fs.rmdirSync(path.join(out, 'units', 'ghost'));
    refusedStatus(ws, out, /toy_app failed at charon/);
  });

  it('refuses to read one crate of a multi-crate attempt without the copy, where the roster is checked', () => {
    const { ws, out } = withFailedApp();
    const alone = engine(ws, ['attempt-status', '--out', path.join(out, 'units', 'toy_lib')]);
    assert.equal(alone.status, 8, alone.stdout);
    assert.match(alone.result.message, /is one crate of a multi-crate attempt; read it with attempt-status --out .* --crate toy_lib/);
    const through = engine(ws, ['attempt-status', '--out', out, '--crate', 'toy_lib']);
    assert.equal(through.status, 0, through.stdout);
    assert.equal(through.result.unit.status, 'complete');
  });

  it('refuses every stage once a unit record carries another roster', () => {
    const ws = workspace();
    const { out } = attempted(ws);
    const file = path.join(out, 'units', 'toy_lib', 'attempt.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    record.roster.units = record.roster.units.slice(1);
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    const refused = step(ws, out, 'charon', 'toy_app');
    assert.equal(refused.status, 8, refused.stdout);
    assert.match(refused.result.message, /the attempt record of crate toy_lib changed after it was recorded/);
  });
});

describe('multi-crate extraction: a failed or missing crate is never a complete attempt', () => {
  it('ends only the failing crate\'s chain and refuses the whole status, naming the crate', () => {
    const ws = workspace({ toy_app: { charonExit: 1 } });
    const { out, recorded } = attempted(ws);
    assert.equal(recorded.status, 0, recorded.stdout);
    completeUnit(ws, out, 'toy_lib');
    assert.equal(step(ws, out, 'charon', 'toy_app').status, 9);
    assert.match(failedCharon(out, 'toy_app').reasons.join(' '), /Charon exited 1/);
    const status = engine(ws, ['attempt-status', '--out', out]);
    assert.equal(status.status, 8, status.stdout);
    assert.equal(status.result.code, 'attempt-refused');
    assert.match(status.result.message, /toy_app failed at charon/);
    assert.deepEqual(status.result.units.map((unit) => [unit.crate, unit.status]), [['toy_lib', 'complete'], ['toy_app', 'failed at charon']]);
    const unit = engine(ws, ['attempt-status', '--out', out, '--crate', 'toy_lib']);
    assert.equal(unit.status, 0, unit.stdout);
    assert.equal(unit.result.unit.status, 'complete');
    assert.equal(engine(ws, ['attempt-status', '--out', out, '--crate', 'toy_app']).result.unit.status, 'failed at charon');
  });

  it('names the first error lines of a failed Charon log in the reasons, bounded', () => {
    const many = Array.from({ length: 8 }, (_, index) => `error[E000${index}]: problem number ${index} ${'x'.repeat(index === 0 ? 400 : 1)}`);
    const ws = workspace({ toy_lib: { charonExit: 101, charonLog: ['Compiling toy-lib', 'warning: unused import', ...many, ''].join('\n') } });
    const { out } = attempted(ws);
    const failed = step(ws, out, 'charon', 'toy_lib');
    assert.equal(failed.status, 9, failed.stdout);
    const reasons = failedCharon(out, 'toy_lib').reasons;
    const logged = reasons.filter((reason) => reason.startsWith('Charon\'s log: '));
    assert.equal(logged.length, 6, 'five error lines and a count of the rest');
    assert.match(logged[0], /^Charon's log: error\[E0000\]: problem number 0 x+\.\.\.$/);
    assert.ok(logged[0].length < 240, 'a long line is cut');
    assert.equal(logged[5], 'Charon\'s log: (3 more error line(s) in the log)');
    assert.ok(!reasons.join(' ').includes('warning'), 'only error lines are shown');
  });

  it('refuses the status while a crate has not run at all', () => {
    const ws = workspace();
    const { out } = attempted(ws);
    completeUnit(ws, out, 'toy_lib');
    const status = engine(ws, ['attempt-status', '--out', out]);
    assert.equal(status.status, 8, status.stdout);
    assert.match(status.result.message, /toy_app not run: charon is next/);
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

describe('multi-crate extraction: crates the owner chose not to verify', () => {
  const appOnly = (nonTargets) => {
    const spec = toySpec();
    spec.crates = spec.crates.slice(1).map(({ stitch, ...rest }) => rest);
    spec.nonTargets = nonTargets;
    return spec;
  };

  it('accepts the sources of a declared non-target under its own label and records them, tree-pinned', () => {
    const ws = workspace();
    const out = complete(ws, appOnly([{ crate: 'toy_lib', dir: 'lib' }]));
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    const charon = charonRecord(out, 'toy_app').llbc;
    assert.deepEqual(charon.foreignSources, []);
    assert.deepEqual(charon.nonTargetSources.map((entry) => [entry.crate, entry.file]), [['toy_lib', 'lib/src/lib.rs'], ['toy_lib', 'lib/src/more.rs']]);
    for (const entry of charon.nonTargetSources) assert.equal(entry.sha256, manifest.final.files[entry.file].sha256);
    const { run } = engine(ws, ['attempt-status', '--out', out]).result;
    assert.deepEqual(run.nonTargets.map(({ crate, dir, sources }) => [crate, dir, sources.map((source) => source.file)]), [['toy_lib', 'lib', ['lib/src/lib.rs', 'lib/src/more.rs']]]);
    assert.deepEqual(run.foreignCrates, [{ crate: 'core', kind: 'external' }, { crate: 'toy_lib', kind: 'non-target' }]);
  });

  it('reports a target crate the LLBC reaches as a target, and the standard library as external', () => {
    const ws = workspace();
    const out = complete(ws);
    const { run } = engine(ws, ['attempt-status', '--out', out]).result;
    assert.deepEqual(run.units.find((unit) => unit.crate === 'toy_app').foreignCrates, [{ crate: 'core', kind: 'external' }, { crate: 'toy_lib', kind: 'target' }]);
    assert.equal(run.nonTargets, undefined, 'no non-target was declared');
  });

  it('gives every translation and published file also relative to the project root', () => {
    const ws = workspace();
    const out = complete(ws);
    const { run } = engine(ws, ['attempt-status', '--out', out]).result;
    for (const unit of [run, ...run.units]) {
      assert.equal(path.isAbsolute(unit.translation.projectPath), true, 'the recorded path is unchanged');
      assert.equal(unit.translation.relativePath, `${unit.publishDir}/translation.json`);
      for (const entry of unit.publication) assert.equal(path.join(ws.project, entry.relativePath), fs.realpathSync(entry.projectPath));
      assert.ok(unit.publication.every((entry) => !path.isAbsolute(entry.relativePath) && !entry.relativePath.startsWith('..')));
    }
  });

  it('says which target crates a crate reaches and which of them it does not import', () => {
    const ws = workspace();
    const out = complete(ws);
    const { run } = engine(ws, ['attempt-status', '--out', out]).result;
    const app = run.units.find((unit) => unit.crate === 'toy_app');
    assert.deepEqual([app.dependsOn, app.unstitched, app.prerequisites], [['toy_lib'], [], []], 'a target the crate calls is stitched, or the crate is not published');
    const library = run.units.find((unit) => unit.crate === 'toy_lib');
    assert.deepEqual([library.dependsOn, library.unstitched], [[], []]);
  });

  it('still refuses a non-target\'s source labelled with another crate', () => {
    const ws = workspace({ toy_app: { relabelForeign: 'other_crate' } });
    const { out } = attempted(ws, appOnly([{ crate: 'toy_lib', dir: 'lib' }]));
    const charon = step(ws, out, 'charon', 'toy_app');
    assert.equal(charon.status, 9, charon.stdout);
    assert.match(charon.result.message, /labels lib\/src\/lib\.rs with crate "other_crate", but the file lies under declared crate "toy_lib"/);
  });

  it('refuses a malformed or contradictory declaration before anything is written', () => {
    const refused = (spec, pattern) => {
      const ws = workspace();
      const { out, recorded } = attempted(ws, spec);
      assert.equal(recorded.status, 5, recorded.stdout);
      assert.match(recorded.result.message, pattern);
      assert.equal(fs.existsSync(path.join(out, 'units')), false);
    };
    refused(appOnly([{ crate: 'toy_app', dir: 'lib' }]), /nonTargets\[0\]\.crate toy_app is also a target/);
    refused(appOnly([{ crate: 'toy_lib', dir: 'lib' }, { crate: 'toy_lib', dir: 'lib' }]), /nonTargets names crate toy_lib more than once/);
    refused(appOnly([{ crate: 'toy_lib', dir: 'nowhere' }]), /nonTargets\[0\]\.dir nowhere holds no Cargo\.toml/);
    refused(appOnly([{ crate: 'toy_lib', dir: 'app' }]), /nonTargets\[0\]\.dir app is the directory of target crate toy_app/);
    refused(appOnly([{ crate: 'toy-lib', dir: 'lib' }]), /nonTargets\[0\]\.crate "toy-lib" has a hyphen/);
    refused(appOnly([{ crate: 'toy_lib', dir: 'lib', reason: 'x' }]), /nonTargets\[0\] has unsupported fields: reason/);
    const ws = workspace();
    const out = prepared(ws);
    const single = engine(ws, ['attempt', '--out', out, '--spec', specFile(ws, { release: toySpec().release, crate: 'toy_app', publishDir: 'Lean/App', nonTargets: [{ crate: 'toy_lib', dir: 'lib' }] })]);
    assert.equal(single.status, 5, single.stdout);
    assert.match(single.result.message, /nonTargets belongs to a multi-crate spec: list this crate under crates/);
  });
});


describe('crates: the in-repo crates of a prepared copy', () => {
  // The toy workspace plus a library that depends on toy-lib and, only for its tests,
  // on toy-app, and a package with no library.
  function withExtras(ws) {
    const write = (file, text) => {
      fs.mkdirSync(path.dirname(path.join(ws.project, file)), { recursive: true });
      fs.writeFileSync(path.join(ws.project, file), text);
    };
    write('tool/Cargo.toml', '[package]\nname = "toy-tool"\nversion = "0.1.0"\n\n[dependencies]\ntoy-lib = { path = "../lib" }\n\n[dev-dependencies]\ntoy-app = { path = "../app" }\n');
    write('tool/src/lib.rs', 'pub fn four() -> u32 { 4 }\n');
    write('script/Cargo.toml', '[package]\nname = "toy-script"\nversion = "0.1.0"\n');
    write('script/src/main.rs', 'fn main() {}\n');
    write('.formalising/fvs-config.json', JSON.stringify({ extraction: { inputs: ['Cargo.toml', 'Cargo.lock', 'app', 'lib', 'tool', 'script'] } }));
  }
  const crates = (ws, out) => engine(ws, ['crates', '--out', out, '--release', toySpec().release]);

  it('lists the crates, what each depends on in the repo and an order with providers first', () => {
    const ws = workspace();
    withExtras(ws);
    const out = prepared(ws);
    const listed = crates(ws, out);
    assert.equal(listed.status, 0, listed.stdout);
    const row = (crate) => listed.result.crates.find((item) => item.package === crate);
    assert.deepEqual(row('toy-app'), { package: 'toy-app', crate: 'toy_app', dir: 'app', library: true, deps: ['toy_lib'] });
    assert.deepEqual(row('toy-lib'), { package: 'toy-lib', crate: 'toy_lib', dir: 'lib', library: true, deps: [] });
    assert.deepEqual(row('toy-tool'), { package: 'toy-tool', crate: 'toy_tool', dir: 'tool', library: true, deps: ['toy_lib'] }, 'a dev-dependency is not a dependency of an extraction');
    assert.deepEqual(row('toy-script'), { package: 'toy-script', crate: null, dir: 'script', library: false, deps: [] }, 'a package without a library cannot be a target');
    assert.deepEqual(listed.result.order, ['toy_lib', 'toy_app', 'toy_tool']);
    assert.equal(listed.result.workspaceRoot, '.');
    assert.deepEqual(listed.result.unlisted, []);
    assert.equal(fs.existsSync(path.join(out, 'attempt.json')), false, 'the command changes nothing');
  });

  it('describes a fresh checkout before any copy exists and proposes the inputs a copy needs', () => {
    const ws = workspace();
    withExtras(ws);
    fs.symlinkSync('lib.rs', path.join(ws.project, 'lib', 'src', 'alias.rs'));
    for (const name of ['one.sh', 'two.sh']) {
      fs.mkdirSync(path.join(ws.project, 'lib', 'extracts'), { recursive: true });
      fs.symlinkSync('../src/lib.rs', path.join(ws.project, 'lib', 'extracts', name));
    }
    const before = fs.readdirSync(path.join(ws.project, 'lib', 'src')).sort();
    const listed = engine(ws, ['crates', '--project-root', ws.project, '--release', toySpec().release]);
    assert.equal(listed.status, 0, listed.stdout);
    assert.deepEqual(listed.result.order, ['toy_lib', 'toy_app', 'toy_tool']);
    assert.deepEqual(listed.result.inputs, ['Cargo.lock', 'Cargo.toml', 'app', 'lib', 'script', 'tool']);
    assert.deepEqual(listed.result.links, ['lib/src/alias.rs'], 'a link the build can read, which a copy refuses, is named');
    assert.deepEqual(listed.result.ignoredLinks, ['lib/extracts/one.sh', 'lib/extracts/two.sh'], 'a link it cannot read is only reported');
    assert.equal(listed.result.ignoredLinkCount, 2);
    assert.equal(listed.result.compared, undefined, 'there is no copy to compare with');
    assert.deepEqual(fs.readdirSync(path.join(ws.project, 'lib', 'src')).sort(), before, 'the checkout is not touched');
  });

  it('says what the patched copy lost compared with the checkout', () => {
    const ws = workspace();
    withExtras(ws);
    const out = prepared(ws);
    let listed = crates(ws, out);
    assert.deepEqual(listed.result.compared, { available: true, packagesNotInCopy: [], pathDependenciesRemoved: [] });
    fs.writeFileSync(path.join(out, 'tree', 'app', 'Cargo.toml'), fs.readFileSync(path.join(out, 'tree', 'app', 'Cargo.toml'), 'utf8').replace('toy-lib = { path = "../lib" }', 'toy-lib = "0.1.0"'));
    fs.rmSync(path.join(out, 'tree', 'script'), { recursive: true });
    listed = crates(ws, out);
    assert.equal(listed.status, 0, listed.stdout);
    assert.deepEqual(listed.result.compared.pathDependenciesRemoved, [{ package: 'toy-app', dependency: 'toy-lib', dir: 'lib' }], 'a path dependency a patch turned into a registry one is named');
    assert.deepEqual(listed.result.compared.packagesNotInCopy, [{ package: 'toy-script', dir: 'script' }]);
    assert.deepEqual(listed.result.crates.find((item) => item.package === 'toy-app').deps, [], 'and it is no longer an in-repo dependency of the copy');
  });

  it('needs exactly one of a prepared copy and a checkout', () => {
    const ws = workspace();
    const out = prepared(ws);
    const both = engine(ws, ['crates', '--out', out, '--project-root', ws.project, '--release', toySpec().release]);
    assert.equal(both.status, 2, both.stdout);
    assert.match(both.result.message, /exactly one of --out \(a prepared copy\) and --project-root \(a checkout\)/);
    assert.equal(engine(ws, ['crates', '--release', toySpec().release]).status, 2);
  });

  it('names a path dependency inside the copy that is not a workspace member', () => {
    const ws = workspace();
    const out = prepared(ws);
    fs.writeFileSync(path.join(ws.tools.cargoHome, 'bin', 'metadata-hide.txt'), 'lib\n');
    const listed = crates(ws, out);
    assert.equal(listed.status, 0, listed.stdout);
    assert.deepEqual(listed.result.unlisted, ['lib']);
    assert.deepEqual(listed.result.crates.map((item) => item.package), ['toy-app']);
    assert.deepEqual(listed.result.crates[0].deps, [], 'a crate that is not listed is not a dependency in the list');
  });

  it('reports a workspace cargo cannot read with cargo\'s own first lines', () => {
    const ws = workspace();
    const out = prepared(ws);
    fs.writeFileSync(path.join(ws.tools.cargoHome, 'bin', 'metadata-failure.txt'), 'error: failed to load manifest for workspace member `/x/lib`\nCaused by:\n  failed to read `/x/lib/Cargo.toml`\n');
    const listed = crates(ws, out);
    assert.equal(listed.status, 9, listed.stdout);
    assert.match(listed.result.message, /cargo cannot read the workspace of the extraction copy: error: failed to load manifest for workspace member `\/x\/lib` \| Caused by: \| failed to read/);
  });

  it('needs a prepared copy and a release', () => {
    const ws = workspace();
    const none = engine(ws, ['crates', '--out', path.join(ws.root, 'copies', 'missing'), '--release', toySpec().release]);
    assert.equal(none.status, 2, none.stdout);
    const out = prepared(ws);
    const noRelease = engine(ws, ['crates', '--out', out]);
    assert.equal(noRelease.status, 2, noRelease.stdout);
    assert.match(noRelease.result.message, /--release is required/);
    const wrong = engine(ws, ['crates', '--out', out, '--release', 'no/such/release']);
    assert.equal(wrong.status, 5, wrong.stdout);
  });
});

// Every in-repo library crate is a target, a declared non-target, or declared dropped, and a
// path dependency a patch removed is declared dropped too; the check is enforced by the
// attempt, from the workspace the copy recorded when it was prepared with the release.
describe('multi-crate extraction: the workspace is accounted for', () => {
  const { RELEASE } = require('./helpers/fake-multicrate-tools.cjs');
  const write = (ws, file, text) => {
    fs.mkdirSync(path.dirname(path.join(ws.project, file)), { recursive: true });
    fs.writeFileSync(path.join(ws.project, file), text);
  };
  const dropped = (...crates) => crates.map((crate) => ({ crate, reason: 'the owner decided to leave it out' }));
  let copies = 0;
  const prepareWith = (ws, extra = ['--release', RELEASE]) => {
    const out = path.join(ws.root, 'copies', `ws-${(copies += 1)}`);
    const done = engine(ws, ['prepare', '--project-root', ws.project, '--out', out, ...extra]);
    assert.equal(done.status, 0, done.stdout);
    return { out, manifest: done.result.manifest };
  };
  const attempt = (ws, out, spec) => engine(ws, ['attempt', '--out', out, '--spec', specFile(ws, spec)]);
  // A crate in the project that the copy does not take: it is not an extraction input.
  const outsideTheCopy = (ws) => {
    write(ws, 'extra/Cargo.toml', '[package]\nname = "toy-extra"\nversion = "0.1.0"\nedition = "2021"\n');
    write(ws, 'extra/src/lib.rs', 'pub fn extra() {}\n');
  };
  // A patch that turns the path dependency of toy-app into a registry one.
  const registryPatch = (ws) => {
    const directory = path.join(ws.project, 'translation-patches');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, '01-registry.patch'), [
      'Translation patch: toy::registry', '', 'Change: the dependency on toy-lib comes from the registry.', 'Why: fixture for the workspace coverage tests.', 'Behaviour: identical.', 'Independent: yes', '',
      'diff --git a/app/Cargo.toml b/app/Cargo.toml', '--- a/app/Cargo.toml', '+++ b/app/Cargo.toml', '@@ -5,3 +5,3 @@ edition.workspace = true',
      ' ', ' [dependencies]', '-toy-lib = { path = "../lib" }', '+toy-lib = "0.1"', '',
    ].join('\n'));
    fs.writeFileSync(path.join(directory, 'series'), '01-registry.patch\n');
  };

  it('records the workspace of the checkout and of the copy when prepare is given the release', () => {
    const ws = workspace();
    outsideTheCopy(ws);
    const { manifest } = prepareWith(ws);
    assert.deepEqual(manifest.workspace.original.crates.filter((row) => row.library).map((row) => row.crate).sort(), ['toy_app', 'toy_extra', 'toy_lib']);
    assert.deepEqual(manifest.workspace.copy.crates.filter((row) => row.library).map((row) => row.crate).sort(), ['toy_app', 'toy_lib']);
    assert.deepEqual(manifest.workspace.notInCopy.map((row) => row.crate), ['toy_extra']);
    assert.deepEqual(manifest.workspace.removedPathDependencies, []);
    assert.equal(prepareWith(ws, []).manifest.workspace, undefined, 'without the release nothing is recorded');
  });

  it('refuses a multi-crate attempt on a copy prepared without the release', () => {
    const ws = workspace();
    const { out } = prepareWith(ws, []);
    const refused = attempt(ws, out, toySpec());
    assert.equal(refused.status, 8, refused.stdout);
    assert.match(refused.result.message, /the copy was prepared without --release, so it records no workspace inventory; prepare a new copy with --release DIR/);
    assert.equal(fs.existsSync(path.join(out, 'attempt.json')), false);
  });

  it('refuses an in-repo crate that is neither a target, a non-target nor dropped, and accepts it once dropped', () => {
    const ws = workspace();
    outsideTheCopy(ws);
    const { out } = prepareWith(ws);
    const refused = attempt(ws, out, toySpec());
    assert.equal(refused.status, 8, refused.stdout);
    assert.match(refused.result.message, /neither a target, a non-target nor dropped: toy_extra; .* each crate left out is named in nonTargets \(its sources are in the copy\) or dropped \(they are not\)/);
    const accepted = attempt(ws, out, toySpec({ dropped: dropped('toy_extra') }));
    assert.equal(accepted.status, 0, accepted.stdout);
    assert.deepEqual(accepted.result.attempt.dropped, dropped('toy_extra'), 'the decision is recorded with the attempt');
  });

  it('checks the dropped list itself', () => {
    const ws = workspace();
    outsideTheCopy(ws);
    const { out } = prepareWith(ws);
    const refused = (list, pattern, status = 5) => {
      const done = attempt(ws, out, toySpec({ dropped: list }));
      assert.equal(done.status, status, done.stdout);
      assert.match(done.result.message, pattern);
    };
    refused([{ crate: 'toy_extra' }], /dropped\[0\]\.reason must say who decided/);
    refused([{ crate: 'toy_extra', reason: 'x', note: 1 }], /dropped\[0\] has unsupported fields: note/);
    refused([{ crate: 'toy-extra', reason: 'x' }], /dropped\[0\]\.crate "toy-extra" has a hyphen/);
    refused(dropped('toy_extra', 'toy_extra'), /dropped names crate toy_extra more than once/);
    refused(dropped('toy_extra', 'nobody'), /dropped names crate nobody, which is not an in-repo crate of the workspace/, 8);
    refused(dropped('toy_extra', 'toy_lib'), /dropped names crate toy_lib, which is also a target or a non-target/, 8);
  });

  it('refuses a path dependency a patch removed unless it is dropped, and a dropped crate that is still in the copy', () => {
    const ws = workspace();
    registryPatch(ws);
    const { out, manifest } = prepareWith(ws);
    assert.deepEqual(manifest.workspace.removedPathDependencies, [{ package: 'toy-app', dependency: 'toy-lib', crate: 'toy_lib', dir: 'lib' }]);
    const refused = attempt(ws, out, toySpec());
    assert.equal(refused.status, 8, refused.stdout);
    assert.match(refused.result.message, /a patch removed the path dependency on toy_lib \(from toy-app\), so the build would use a registry release of an in-repo crate; name each crate in dropped with the owner's decision/);
    const alone = { release: RELEASE, crates: [toySpec().crates[1]].map(({ stitch, ...rest }) => rest), main: 'toy_app', dropped: dropped('toy_lib') };
    const stillThere = attempt(ws, out, alone);
    assert.equal(stillThere.status, 8, stillThere.stdout);
    assert.match(stillThere.result.message, /dropped names crate toy_lib, which is still in the extraction copy; a crate is either in the copy or dropped/);
  });

  it('applies to a single-crate attempt too', () => {
    const ws = workspace();
    registryPatch(ws);
    fs.writeFileSync(path.join(ws.project, '.formalising', 'fvs-config.json'), JSON.stringify({ extraction: { inputs: ['Cargo.toml', 'Cargo.lock', 'app'] } }));
    const { out } = prepareWith(ws);
    const single = { release: RELEASE, crate: 'toy_app', publishDir: 'Lean/App', cargoArgs: ['--locked', '--package', 'toy-app'] };
    const refused = attempt(ws, out, single);
    assert.equal(refused.status, 8, refused.stdout);
    assert.match(refused.result.message, /a patch removed the path dependency on toy_lib \(from toy-app\)/);
    const accepted = attempt(ws, out, { ...single, dropped: dropped('toy_lib') });
    assert.equal(accepted.status, 0, accepted.stdout);
  });

  it('names a workspace member that resolves outside the checkout, and holds it to the same rule', () => {
    const ws = workspace();
    const outside = path.join(ws.root, 'outside-ext');
    fs.mkdirSync(path.join(outside, 'src'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'Cargo.toml'), '[package]\nname = "toy-ext"\nversion = "0.1.0"\nedition = "2021"\n');
    fs.writeFileSync(path.join(outside, 'src', 'lib.rs'), 'pub fn ext() {}\n');
    fs.symlinkSync(outside, path.join(ws.project, 'ext'));
    const listed = engine(ws, ['crates', '--project-root', ws.project, '--release', RELEASE]);
    assert.equal(listed.status, 0, listed.stdout);
    assert.deepEqual(listed.result.outside.map((row) => row.package), ['toy-ext']);
    const { out, manifest } = prepareWith(ws);
    assert.deepEqual(manifest.workspace.original.crates.find((row) => row.package === 'toy-ext'), { package: 'toy-ext', crate: 'toy_ext', dir: null, library: true, member: true, outside: true });
    const refused = attempt(ws, out, toySpec());
    assert.equal(refused.status, 8, refused.stdout);
    assert.match(refused.result.message, /neither a target, a non-target nor dropped: toy_ext/);
    assert.equal(attempt(ws, out, toySpec({ dropped: dropped('toy_ext') })).status, 0);
  });

  it('follows path dependencies of a crate that is not a workspace member, to any depth', () => {
    const ws = workspace();
    write(ws, 'lib/Cargo.toml', '[package]\nname = "toy-lib"\nversion.workspace = true\nedition.workspace = true\n\n[dependencies]\ntoy-deep = { path = "../deep" }\n');
    write(ws, 'deep/Cargo.toml', '[package]\nname = "toy-deep"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\ntoy-deeper = { path = "../deeper" }\n');
    write(ws, 'deep/src/lib.rs', 'pub fn deep() {}\n');
    write(ws, 'deeper/Cargo.toml', '[package]\nname = "toy-deeper"\nversion = "0.1.0"\nedition = "2021"\n');
    write(ws, 'deeper/src/lib.rs', 'pub fn deeper() {}\n');
    fs.writeFileSync(path.join(ws.tools.cargoHome, 'bin', 'metadata-hide.txt'), 'lib\ndeep\ndeeper\n');
    const listed = engine(ws, ['crates', '--project-root', ws.project, '--release', RELEASE]);
    assert.equal(listed.status, 0, listed.stdout);
    assert.deepEqual(listed.result.unlisted, ['deep', 'deeper', 'lib'], 'one manifest per call would stop at lib');
    assert.deepEqual(listed.result.inputs.filter((input) => ['deep', 'deeper', 'lib'].includes(input)), ['deep', 'deeper', 'lib']);
  });
});
