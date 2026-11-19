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

describe('multi-crate extraction: crates the owner chose not to verify', () => {
  const appOnly = (nonTargets) => {
    const spec = toySpec();
    spec.crates = spec.crates.slice(1);
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

  it('says which target crates a crate reaches and which of them it does not import', () => {
    const ws = workspace();
    const out = complete(ws);
    const { run } = engine(ws, ['attempt-status', '--out', out]).result;
    const app = run.units.find((unit) => unit.crate === 'toy_app');
    assert.deepEqual([app.dependsOn, app.unstitched, app.prerequisites], [['toy_lib'], ['toy_lib'], []], 'a target called with no stitch entry is data the acceptance side can refuse on');
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
    const before = fs.readdirSync(path.join(ws.project, 'lib', 'src')).sort();
    const listed = engine(ws, ['crates', '--project-root', ws.project, '--release', toySpec().release]);
    assert.equal(listed.status, 0, listed.stdout);
    assert.deepEqual(listed.result.order, ['toy_lib', 'toy_app', 'toy_tool']);
    assert.deepEqual(listed.result.inputs, ['Cargo.lock', 'Cargo.toml', 'app', 'lib', 'script', 'tool']);
    assert.deepEqual(listed.result.links, ['lib/src/alias.rs'], 'a link a copy would refuse is named');
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
