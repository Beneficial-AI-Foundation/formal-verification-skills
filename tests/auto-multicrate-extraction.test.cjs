'use strict';

// A succeeded extraction over several crates in scripts/fvs-auto.mjs: each unit is
// validated as a whole single-crate run, a reader can ask for one crate's run, and
// read-state reports the crates with an order that puts providers before consumers.
// Every extraction record here is built by hand in a temporary git fixture; no
// Charon, Aeneas or Lean runs.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fixtures = require('./helpers/multicrate-fixtures.cjs');

const { ROOT, ZEROS, cli, readState, writeState, fn, unit, extracted, hmacAndSha2 } = fixtures;
let auto = null;

before(async () => {
  auto = await import(pathToFileURL(path.join(ROOT, 'scripts', 'fvs-auto.mjs')).href);
  fixtures.use(auto);
});

after(fixtures.cleanup);

describe('a succeeded extraction over several crates', () => {
  it('read-state reports the crates, providers before consumers, in the full and brief results', () => {
    const root = extracted(hmacAndSha2);
    for (const flags of [[], ['--brief']]) {
      const result = cli('read-state', '--project-root', root, ...flags);
      assert.equal(result.status, 0, result.stdout);
      assert.deepEqual(result.json.crates, {
        order: ['libcrux_sha2', 'libcrux_hmac'],
        targets: ['libcrux_sha2', 'libcrux_hmac'],
        nonTargets: [],
        units: [
          { crate: 'libcrux_hmac', package: 'libcrux-hmac', dir: 'crates/libcrux_hmac', dependsOn: ['libcrux_sha2'], hasErrorItems: [] },
          { crate: 'libcrux_sha2', package: 'libcrux-sha2', dir: 'crates/libcrux_sha2', dependsOn: [], hasErrorItems: [] },
        ],
      }, flags.join(' ') || 'full');
    }
  });

  it('takes a dependency from imports, a stitch provider or a target the LLBC reaches, and ignores other crates', () => {
    const root = extracted((directory) => [
      unit(directory, 'app', [], { stitch: [{ provider: 'mid', modules: ['Mid'], replaced: [], assumed: [], copies: [], files: [] }, { provider: 'elsewhere' }] }),
      unit(directory, 'mid', [], { foreignCrates: [{ crate: 'base', kind: 'target' }, { crate: 'core', kind: 'external' }, { crate: 'loose', kind: 'non-target' }] }),
      unit(directory, 'base', []),
      unit(directory, 'loose', []),
    ]);
    const { crates } = cli('read-state', '--project-root', root, '--brief').json;
    assert.deepEqual(Object.fromEntries(crates.units.map((entry) => [entry.crate, entry.dependsOn])),
      { app: ['mid'], mid: ['base'], base: [], loose: [] }, 'elsewhere is no extracted crate, and loose is only a non-target the LLBC reaches');
    assert.deepEqual(crates.order, ['base', 'loose', 'mid', 'app'], 'derived order: ties by name, every provider first');
  });

  it('warns when a crate uses a verified crate it is neither stitched to nor imports, and not for a crate the owner does not verify', () => {
    const reaches = (crate, kind = 'target') => ({ foreignCrates: [{ crate, kind }, { crate: 'core', kind: 'external' }] });
    const warnings = (root) => cli('read-state', '--project-root', root, '--brief').json.warnings.filter((text) => /without being stitched/.test(text));
    const open = extracted((directory) => [unit(directory, 'app', [], reaches('base')), unit(directory, 'base', [])]);
    assert.deepEqual(warnings(open), ["crate app uses items of base, which is verified, without being stitched to it: they would be axioms in app's Lean, not base's translation. Stitch app to base in the extraction spec, or have the owner record base as a non-target in the agreement"]);
    const stitched = extracted((directory) => [unit(directory, 'app', [], { ...reaches('base'), stitch: [{ provider: 'base', modules: ['Base'], replaced: [], assumed: [], copies: [], files: [] }] }), unit(directory, 'base', [])]);
    assert.deepEqual(warnings(stitched), []);
    const imported = extracted((directory) => [unit(directory, 'app', [], { ...reaches('base'), imports: ['base'] }), unit(directory, 'base', [])]);
    assert.deepEqual(warnings(imported), []);
    // A crate the extraction itself marks a non-target, and one the owner drops afterwards, may be assumed.
    const nonTarget = extracted((directory) => [unit(directory, 'app', [], reaches('base', 'non-target')), unit(directory, 'base', [])]);
    assert.deepEqual(warnings(nonTarget), []);
    const dropped = extracted((directory) => [unit(directory, 'app', [], reaches('base')), unit(directory, 'base', [])]);
    fixtures.recordAgreement(dropped, fixtures.agreementFor(dropped, { targets: { crates: ['app'], nonTargets: [{ crate: 'base', decision: 'Not verified; its behaviour is assumed.' }] } }));
    assert.deepEqual(warnings(dropped), [], 'a crate the owner drops is only assumed');
  });

  it('reads a stitch given as one entry as well as a list', () => {
    const root = extracted((directory) => [
      unit(directory, 'app', [], { stitch: { provider: 'base', modules: [], replaced: [], assumed: [] } }),
      unit(directory, 'base', []),
    ]);
    assert.deepEqual(cli('read-state', '--project-root', root, '--brief').json.crates.order, ['base', 'app']);
  });

  it('keeps the extraction\'s own order when it puts every provider first, and derives one when it does not', () => {
    const own = extracted(hmacAndSha2, { run: { order: ['libcrux_sha2', 'libcrux_hmac'] } });
    assert.deepEqual(cli('read-state', '--project-root', own, '--brief').json.crates.order, ['libcrux_sha2', 'libcrux_hmac']);
    const wrong = extracted(hmacAndSha2, { run: { order: ['libcrux_hmac', 'libcrux_sha2'] } });
    assert.deepEqual(cli('read-state', '--project-root', wrong, '--brief').json.crates.order, ['libcrux_sha2', 'libcrux_hmac']);
  });

  it('names the crates of a dependency cycle instead of an order', () => {
    const root = extracted((directory) => [
      unit(directory, 'a', [], { imports: ['b'] }),
      unit(directory, 'b', [], { imports: ['a'] }),
      unit(directory, 'c', []),
    ]);
    const { crates } = cli('read-state', '--project-root', root, '--brief').json;
    assert.deepEqual(crates.cycle, ['a', 'b']);
    assert.deepEqual(crates.order, ['c']);
    assert.deepEqual(crates.targets, ['c', 'a', 'b'], 'a crate in a cycle is still a target');
  });

  it('lists the items an extraction could not translate with their crate', () => {
    const root = extracted((directory) => [
      unit(directory, 'libcrux_hmac', [], { hasErrors: { value: true, items: ['libcrux_hmac::hmac::update'], itemCount: 1 } }),
      unit(directory, 'libcrux_sha2', []),
    ]);
    assert.deepEqual(cli('read-state', '--project-root', root, '--brief').json.crates.units[0].hasErrorItems, ['libcrux_hmac::hmac::update']);
  });

  it('a single-crate extraction, with or without a one-row units list, has no crate view', () => {
    const plain = extracted((directory) => [unit(directory, 'libcrux_hmac', [])]);
    const state = readState(plain);
    const oneRow = state.extraction.run.units;
    for (const units of [null, oneRow]) {
      if (units === null) delete state.extraction.run.units;
      else state.extraction.run.units = units;
      writeState(plain, state);
      const result = cli('read-state', '--project-root', plain);
      assert.equal(result.status, 0, result.stdout);
      assert.equal('crates' in result.json, false);
      assert.equal('crates' in cli('read-state', '--project-root', plain, '--brief').json, false);
    }
  });

  it('a record that is not the whole run of every crate does not read as state', () => {
    const cases = {
      'a unit from another manifest': (state) => { state.extraction.run.units[1].manifestSha256 = '1'.repeat(64); },
      'two units of one crate': (state) => { state.extraction.run.units[1].crate = 'libcrux_hmac'; },
      'a unit with no status': (state) => { delete state.extraction.run.units[1].status; },
      'a unit that is not a run': (state) => { delete state.extraction.run.units[1].translation; },
      'an empty units list': (state) => { state.extraction.run.units = []; },
      'an order that misses a crate': (state) => { state.extraction.run.order = ['libcrux_sha2']; },
      'an order with a crate that is not extracted': (state) => { state.extraction.run.order = ['libcrux_sha2', 'libcrux_other']; },
    };
    for (const [label, change] of Object.entries(cases)) {
      const root = extracted(hmacAndSha2);
      const state = readState(root);
      change(state);
      writeState(root, state);
      const result = cli('read-state', '--project-root', root);
      assert.equal(result.status, 3, `${label}: ${result.stdout}`);
      assert.equal(result.json.code, 'malformed-state', label);
      assert.match(result.json.message, /extraction\.run must be the re-validated extraction attempt/, label);
    }
  });
});

// What stops record-extraction from recording a run over several crates as succeeded. The
// patch engine refuses a cyclic extraction itself, so a cycle only reaches the engine in a
// hand-built run; the rows here are the same ones the state tests above use.
describe('crateProblems', () => {
  const runOf = (units) => readState(extracted(units)).extraction.run;
  const reaches = (crate, kind = 'target') => ({ foreignCrates: [{ crate, kind }, { crate: 'core', kind: 'external' }] });
  const stitchTo = (provider) => ({ stitch: [{ provider, modules: ['M'], replaced: [], assumed: [], copies: [], files: [] }] });
  const unstitched = "crate app uses items of base, which is verified, without being stitched to it: they would be axioms in app's Lean, not base's translation. Stitch app to base in the extraction spec, or have the owner record base as a non-target in the agreement";

  it('names the crates of a dependency cycle', () => {
    const run = runOf((directory) => [unit(directory, 'a', [], { imports: ['b'] }), unit(directory, 'b', [], { imports: ['a'] }), unit(directory, 'c', [])]);
    assert.deepEqual(auto.crateProblems(run), ['the crates a, b depend on each other, so no order puts providers before consumers']);
  });

  it('names a cycle made of crates the LLBC reaches as well as the crates left unstitched in it', () => {
    const run = runOf((directory) => [unit(directory, 'a', [], reaches('b')), unit(directory, 'b', [], reaches('a'))]);
    assert.deepEqual(auto.crateProblems(run), [
      'the crates a, b depend on each other, so no order puts providers before consumers',
      "crate a uses items of b, which is verified, without being stitched to it: they would be axioms in a's Lean, not b's translation. Stitch a to b in the extraction spec, or have the owner record b as a non-target in the agreement",
      "crate b uses items of a, which is verified, without being stitched to it: they would be axioms in b's Lean, not a's translation. Stitch b to a in the extraction spec, or have the owner record a as a non-target in the agreement",
    ]);
  });

  it('refuses a verified crate that uses another verified crate without being stitched to it, naming the fix', () => {
    const run = runOf((directory) => [unit(directory, 'app', [], reaches('base')), unit(directory, 'base', [])]);
    assert.deepEqual(auto.crateProblems(run), [unstitched]);
  });

  it('accepts a crate that is stitched or imports the provider, and a run with no cycle', () => {
    const stitched = runOf((directory) => [unit(directory, 'app', [], { ...reaches('base'), ...stitchTo('base') }), unit(directory, 'base', [])]);
    const imported = runOf((directory) => [unit(directory, 'app', [], { ...reaches('base'), imports: ['base'] }), unit(directory, 'base', [])]);
    assert.deepEqual(auto.crateProblems(stitched), []);
    assert.deepEqual(auto.crateProblems(imported), []);
  });

  it('does not refuse a provider the extraction declares a non-target, or one the owner drops, or a consumer the owner drops', () => {
    const declared = runOf((directory) => [unit(directory, 'app', [], reaches('base', 'non-target')), unit(directory, 'base', [])]);
    assert.deepEqual(auto.crateProblems(declared), []);
    const open = runOf((directory) => [unit(directory, 'app', [], reaches('base')), unit(directory, 'base', [])]);
    const decision = { decision: 'Not verified; its behaviour is assumed.' };
    assert.deepEqual(auto.crateProblems(open, { crates: ['app'], nonTargets: [{ crate: 'base', ...decision }] }), [], 'the owner does not verify the provider');
    assert.deepEqual(auto.crateProblems(open, { crates: ['base'], nonTargets: [{ crate: 'app', ...decision }] }), [], 'the owner does not verify the consumer');
    assert.deepEqual(auto.crateProblems(open, { crates: ['app', 'base'], nonTargets: [] }), [unstitched], 'the owner verifies both');
  });

  it('refuses a crate the extraction itself names as left unstitched, even when the LLBC list does not show it', () => {
    const run = runOf((directory) => [unit(directory, 'app', [], { unstitched: ['base'] }), unit(directory, 'base', [])]);
    assert.deepEqual(auto.crateProblems(run), [unstitched]);
    assert.deepEqual(auto.crateProblems(run, { crates: ['app'], nonTargets: [{ crate: 'base', decision: 'Not verified; its behaviour is assumed.' }] }), [], 'a provider the owner does not verify is only assumed');
  });

  it('reads the dependencies a unit names itself, so the order puts the provider first', () => {
    const root = extracted((directory) => [unit(directory, 'app', [], { dependsOn: ['base'] }), unit(directory, 'base', [])]);
    const { crates } = cli('read-state', '--project-root', root, '--brief').json;
    assert.deepEqual(crates.units.find((entry) => entry.crate === 'app').dependsOn, ['base']);
    assert.deepEqual(crates.order, ['base', 'app']);
  });

  it('refuses a crate whose extraction did not complete', () => {
    const run = runOf((directory) => [unit(directory, 'app', []), unit(directory, 'base', [], { status: 'partial' })]);
    assert.deepEqual(auto.crateProblems(run), ['crate base did not complete its extraction (partial)']);
  });

  it('does not refuse the one crate of an extraction that declares non-targets: its run has no status', () => {
    const run = runOf((directory) => [unit(directory, 'app', [], { nonTargets: [{ crate: 'dep', dir: 'dep', sources: [] }] })]);
    delete run.units;
    delete run.status;
    assert.deepEqual(auto.crateProblems(run), []);
  });

  it('has nothing to say about a single crate or a run that was not recorded', () => {
    assert.deepEqual(auto.crateProblems(runOf((directory) => [unit(directory, 'app', [], reaches('base'))])), []);
    assert.deepEqual(auto.crateProblems(undefined), []);
  });
});

describe('runOf', () => {
  it('is the main run without a crate, a crate\'s unit with one, and null for a crate the extraction does not hold', () => {
    const root = extracted(hmacAndSha2);
    const { state } = cli('read-state', '--project-root', root).json;
    assert.equal(auto.runOf(state), state.extraction.run);
    assert.equal(auto.runOf(state, 'libcrux_sha2').crate, 'libcrux_sha2');
    assert.equal(auto.runOf(state, 'libcrux_hmac').translation.projectPath, path.join(root, 'libcrux_hmac', 'translation.json'));
    assert.equal(auto.runOf(state, 'libcrux_traits'), null);
    assert.equal(auto.runOf({ extraction: null }, 'libcrux_sha2'), null);
    assert.equal(auto.runOf({ extraction: null }), null);
  });

  it('without a units list the main run is the only crate, matched by its own crate name', () => {
    const state = { extraction: { run: { crate: 'demo', translation: {} } } };
    assert.equal(auto.runOf(state, 'demo'), state.extraction.run);
    assert.equal(auto.runOf(state, 'other'), null);
  });
});

describe('list-items --crate', () => {
  it('lists the crate\'s own translation, and asks for a crate when the extraction has several', () => {
    const root = extracted(hmacAndSha2);
    const sha2 = cli('list-items', '--project-root', root, '--crate', 'libcrux_sha2');
    assert.equal(sha2.status, 0, sha2.stdout);
    assert.deepEqual(sha2.json.items.map((item) => item.rustName), ['libcrux_sha2::hacl::hash_256']);
    assert.equal(sha2.json.translation, path.join(root, 'libcrux_sha2', 'translation.json'));
    assert.equal(sha2.json.crate, 'libcrux_sha2');
    assert.deepEqual(cli('list-items', '--project-root', root, '--crate', 'libcrux_hmac').json.items.map((item) => item.rustName), ['libcrux_hmac::hmac::hmac']);

    const none = cli('list-items', '--project-root', root);
    assert.equal(none.status, 1);
    assert.equal(none.json.code, 'invalid-input');
    assert.match(none.json.message, /several crates: pass --crate NAME/);
    assert.deepEqual(none.json.crates, ['libcrux_hmac', 'libcrux_sha2']);
  });

  it('refuses a crate the extraction does not hold, and a crate together with --translation', () => {
    const root = extracted(hmacAndSha2);
    const unknown = cli('list-items', '--project-root', root, '--crate', 'libcrux_traits');
    assert.equal(unknown.json.code, 'invalid-input');
    assert.match(unknown.json.message, /no crate libcrux_traits/);
    assert.deepEqual(unknown.json.crates, ['libcrux_hmac', 'libcrux_sha2']);
    const both = cli('list-items', '--project-root', root, '--crate', 'libcrux_sha2', '--translation', 'libcrux_sha2/translation.json');
    assert.equal(both.status, 2);
    assert.equal(both.json.code, 'usage');
  });

  it('a single-crate extraction lists as before, with no --crate, or with its own crate name', () => {
    const root = extracted((directory) => [unit(directory, 'libcrux_hmac', [fn('libcrux_hmac::hmac::hmac', 'src/hmac.rs', 10)])]);
    const state = readState(root);
    delete state.extraction.run.units;
    writeState(root, state);
    assert.equal(cli('list-items', '--project-root', root).json.items.length, 1);
    assert.equal(cli('list-items', '--project-root', root, '--crate', 'libcrux_hmac').json.items.length, 1);
    assert.equal(cli('list-items', '--project-root', root, '--crate', 'other').json.code, 'invalid-input');
  });
});
