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

const { ROOT, ZEROS, cli, readState, writeState, fn, stitchOf, unit, extracted, hmacAndSha2 } = fixtures;
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
      unit(directory, 'app', [], { stitch: [{ provider: 'mid', modules: ['Mid'], replaced: [], assumed: [], copies: [], files: [] }] }),
      unit(directory, 'mid', [], { foreignCrates: [{ crate: 'base', kind: 'target' }, { crate: 'core', kind: 'external' }, { crate: 'loose', kind: 'non-target' }] }),
      unit(directory, 'base', []),
      unit(directory, 'loose', []),
    ]);
    const { crates } = cli('read-state', '--project-root', root, '--brief').json;
    assert.deepEqual(Object.fromEntries(crates.units.map((entry) => [entry.crate, entry.dependsOn])),
      { app: ['mid'], mid: ['base'], base: [], loose: [] }, 'loose is only a non-target the LLBC reaches');
    assert.deepEqual(crates.order, ['base', 'loose', 'mid', 'app'], 'derived order: ties by name, every provider first');
  });

  it('warns when a crate uses a verified crate it is not stitched to, and not for a crate the owner does not verify', () => {
    const reaches = (crate, kind = 'target') => ({ foreignCrates: [{ crate, kind }, { crate: 'core', kind: 'external' }] });
    const warnings = (root) => cli('read-state', '--project-root', root, '--brief').json.warnings.filter((text) => /without being stitched/.test(text));
    const open = extracted((directory) => [unit(directory, 'app', [], reaches('base')), unit(directory, 'base', [])]);
    assert.deepEqual(warnings(open), ["crate app uses items of base, which is verified, without being stitched to it: they would be axioms in app's Lean, not base's translation. Stitch app to base in the extraction spec, or have the owner record base as a non-target in the agreement"]);
    const stitched = extracted((directory) => [unit(directory, 'app', [], { ...reaches('base'), stitch: [{ provider: 'base', modules: ['Base'], replaced: [], assumed: [], copies: [], files: [] }] }), unit(directory, 'base', [])]);
    assert.deepEqual(warnings(stitched), []);
    // A crate the extraction itself marks a non-target, and one the owner drops afterwards, may be assumed.
    const nonTarget = extracted((directory) => [unit(directory, 'app', [], reaches('base', 'non-target')), unit(directory, 'base', [])]);
    assert.deepEqual(warnings(nonTarget), []);
    const dropped = extracted((directory) => [unit(directory, 'app', [], reaches('base')), unit(directory, 'base', [])]);
    fixtures.recordAgreement(dropped, fixtures.agreementFor(dropped, { targets: { crates: ['app'], nonTargets: [{ crate: 'base', decision: 'Not verified; its behaviour is assumed.' }] } }));
    assert.deepEqual(warnings(dropped), [], 'a crate the owner drops is only assumed');
  });

  it('reads a stitch given as one entry as well as a list', () => {
    const root = extracted((directory) => [
      unit(directory, 'app', [], { stitch: { provider: 'base', modules: ['Base'], replaced: [], assumed: [] } }),
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
    for (const oneRow of [true, false]) {
      const state = readState(plain);
      if (!oneRow) fixtures.asSingleCrate(state.extraction.run);
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
      'a run over several crates with no roster hash': (state) => { delete state.extraction.run.rosterSha256; },
      'a roster that does not hash to the run\'s digest': (state) => { state.extraction.run.roster.main = 'libcrux_sha2'; },
      'a unit row of another roster': (state) => { state.extraction.run.units[1].rosterSha256 = '1'.repeat(64); },
      'a unit row with no roster hash': (state) => { delete state.extraction.run.units[1].rosterSha256; },
      'a crate removed from the aggregate while the roster still names it': (state) => { state.extraction.run.units.pop(); state.extraction.run.order = ['libcrux_hmac']; },
      'an order that is not the roster\'s': (state) => { state.extraction.run.order = ['libcrux_sha2', 'libcrux_hmac']; },
      'a crate whose package is not the roster\'s': (state) => { state.extraction.run.units[1].package = 'another-package'; },
      'a crate whose folder is not the roster\'s': (state) => { state.extraction.run.units[1].dir = 'crates/elsewhere'; },
      'a stitch added to a crate after the roster was made': (state) => { state.extraction.run.units[1].stitch = stitchOf('libcrux_hmac'); },
      'a stitch removed from a crate after the roster was made': (state) => { state.extraction.run.units[0].stitch = []; state.extraction.run.units[0].imports = []; },
      'a non-target on one crate only': (state) => { state.extraction.run.units[1].nonTargets = [{ crate: 'libcrux_traits', dir: 'crates/traits', sources: [] }]; },
      'a stitch with no digest of the provider\'s publication': (state) => { delete state.extraction.run.units[0].stitch[0].providerStageSha256; },
      'a stitch made from another publication of the provider': (state) => { state.extraction.run.units[0].stitch[0].providerStageSha256 = '1'.repeat(64); },
      'a stitch that imports no module': (state) => { state.extraction.run.units[0].stitch[0].modules = []; },
      'a run that kept its roster, its hash and its order but lost its crate rows': (state) => { delete state.extraction.run.units; },
      'a run that kept only its roster': (state) => { delete state.extraction.run.units; delete state.extraction.run.order; delete state.extraction.run.rosterSha256; },
      'a run that kept only its order': (state) => { delete state.extraction.run.units; delete state.extraction.run.roster; delete state.extraction.run.rosterSha256; },
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

// The rows of the aggregate are bound to the roster the extraction engine hashed, and a stitch counts
// only with the digest of the provider's publication it was made from.
// The extraction record keeps the scope the copy recorded, apart from the run. A single crate is a fact the
// extraction established, never what is left when nothing says otherwise, and a scope of several crates
// needs the run over all of them, so a run that lost its rows or is gone cannot pass for one crate.
describe('the scope of a recorded extraction', () => {
  const unreadable = (change, said, units = hmacAndSha2, options = {}) => {
    const root = extracted(units, options);
    const state = readState(root);
    change(state);
    writeState(root, state);
    const result = cli('read-state', '--project-root', root);
    assert.equal(result.status, 3, result.stdout);
    assert.equal(result.json.code, 'malformed-state');
    assert.match(result.json.message, said);
    assert.match(result.json.nextStep, /rerun \/fvs:auto-extract/, 'the owner is told that extracting again replaces the record');
  };
  // The scope of the record and the one the attempt repeats change together: they are the copy's one scope.
  const rescope = (state, scope) => { state.extraction.scope = scope; if (state.extraction.run) state.extraction.run.scope = scope; };
  const UNSETTLED = /^Rerun \/fvs:auto-extract: the recorded extraction does not say whether it is of a single crate or of several, and an unknown scope is never read as a single crate\.$/;
  // A record with no scope, or an unknown one, reads, but the phase does not move past the extraction.
  const holds = (change, units = hmacAndSha2) => {
    const root = extracted(units);
    const state = readState(root);
    change(state);
    writeState(root, state);
    for (const args of [[], ['--brief']]) {
      const result = cli('read-state', '--project-root', root, ...args);
      assert.equal(result.status, 0, result.stdout);
      assert.equal(result.json.phase, 'extract');
      assert.match(result.json.nextAction, UNSETTLED);
      assert.equal('crates' in result.json, false, 'no crate is counted on an extraction whose scope is not settled');
    }
  };
  const NO_RUN = /extraction\.scope: the scope is several crates \(libcrux_hmac, libcrux_sha2\), but the record holds no run over them/;

  it('holds the phase at the extraction when the record has no scope, or an unknown one, whatever the run holds', () => {
    holds((state) => { delete state.extraction.scope; });
    holds((state) => { state.extraction.scope = { kind: 'unknown', basis: 'none', reason: 'no inventory' }; });
    holds((state) => { state.extraction.scope = { kind: 'one' }; });
    holds((state) => { state.extraction.scope = null; });
    holds((state) => { delete state.extraction.scope; }, (directory) => [unit(directory, 'libcrux_hmac', [])]);
    holds((state) => { delete state.extraction.scope; fixtures.asSingleCrate(state.extraction.run); }, (directory) => [unit(directory, 'libcrux_hmac', [])]);
  });

  it('does not read when the scope is several crates and the record holds no run over them', () => {
    unreadable((state) => { delete state.extraction.run; }, NO_RUN);
    unreadable((state) => { fixtures.asSingleCrate(state.extraction.run); }, NO_RUN);
    unreadable((state) => { delete state.extraction.run.units; }, /extraction\.run must be the re-validated extraction attempt/);
    unreadable((state) => { state.extraction.run.units = []; }, /extraction\.run must be the re-validated extraction attempt/);
  });

  it('does not read when the scope names crates the run neither extracts nor lists as a non-target or dropped', () => {
    unreadable((state) => rescope(state, { ...state.extraction.scope, libraryCrates: [...state.extraction.scope.libraryCrates, 'libcrux_traits'] }), /extraction\.scope: the scope names libcrux_traits, which the run neither extracts nor lists/);
    unreadable((state) => rescope(state, { kind: 'multi-crate', basis: 'cargo' }), /extraction\.scope: the scope is several crates but does not name them/);
    unreadable((state) => rescope(state, { ...state.extraction.scope, libraryCrates: ['libcrux_hmac'] }), /extraction\.scope: the scope is several crates but does not name them/);
  });

  it('does not read when the attempt recorded another scope than the copy\'s', () => {
    unreadable((state) => { state.extraction.run.scope = { kind: 'single-crate', basis: 'manifest' }; }, /extraction\.scope: the scope the attempt recorded is not the scope of the copy/);
  });

  it('refuses the readers that would take a null crate context for one crate, when the scope is not settled', () => {
    const unsettled = [(state) => { delete state.extraction.scope; }, (state) => { state.extraction.scope = { kind: 'unknown', basis: 'none', reason: 'no inventory' }; }];
    for (const change of unsettled) {
      const root = extracted(hmacAndSha2);
      const state = readState(root);
      change(state);
      writeState(root, state);
      for (const args of [
        ['record-spec', '--project-root', root, '--spec-file', 'S.lean', '--items', 'libcrux_hmac::hmac::hmac', '--round', '1', '--verdict', 'pass', '--review', 'r.md'],
        ['spec-status', '--project-root', root],
        ['record-pr', '--project-root', root, '--kind', 'spec', '--url', 'https://example.invalid/pr/1', '--branch', 'b', '--head', 'a'.repeat(40)],
        ['allowed-axioms', '--project-root', root],
      ]) {
        const result = cli(...args);
        assert.equal(result.json.code, 'scope-unsettled', `${args[0]}: ${result.stdout}`);
        assert.match(result.json.nextStep, /rerun \/fvs:auto-extract/i, args[0]);
      }
    }
  });

  it('reads a scope that is one crate, with the run of that crate, a one-row list, or no run', () => {
    const lone = (directory) => [unit(directory, 'libcrux_hmac', [])];
    for (const change of [(state) => fixtures.asSingleCrate(state.extraction.run), () => {}, (state) => { delete state.extraction.run; }]) {
      const root = extracted(lone);
      const state = readState(root);
      change(state);
      writeState(root, state);
      const result = cli('read-state', '--project-root', root);
      assert.equal(result.status, 0, result.stdout);
      assert.equal(result.json.state.extraction.scope.kind, 'single-crate');
      assert.equal('crates' in result.json, false);
    }
  });

  it('counts the crates a scope of several names as owed, even when the run is gone', () => {
    // A state is not read without its run, so this holds the obligation where a reader is given one anyway.
    const state = readState(extracted(hmacAndSha2));
    delete state.extraction.run;
    const context = auto.crateContextOf(state);
    assert.deepEqual(context.missing, ['libcrux_hmac', 'libcrux_sha2']);
    assert.deepEqual(context.extracted, []);
  });
});

describe('what binds the crates of a run to its roster and stitch', () => {
  const runOf = (units, options) => readState(extracted(units, options)).extraction.run;
  const problem = (change, units = hmacAndSha2) => {
    const run = runOf(units);
    change(run);
    return auto.unitsProblem(run);
  };
  const hmac = (run) => run.units[0];

  it('agrees with a run built as the extraction builds it', () => {
    assert.equal(auto.unitsProblem(runOf(hmacAndSha2)), null);
    assert.equal(auto.unitsProblem(runOf((directory) => [unit(directory, 'app', [], { nonTargets: [{ crate: 'dep', dir: 'dep', sources: [] }] }), unit(directory, 'base', [])])), null,
      'a non-target is on every row and in the roster');
  });

  it('names the disagreement of a row with the roster', () => {
    assert.match(problem((run) => { run.units[1].package = 'another-package'; }), /^crate libcrux_sha2 does not match its roster entry/);
    assert.match(problem((run) => { run.units[1].dir = 'crates/elsewhere'; }), /^crate libcrux_sha2 does not match its roster entry/);
    assert.match(problem((run) => { hmac(run).stitch = []; hmac(run).imports = []; }), /^crate libcrux_hmac does not match its roster entry/);
    assert.match(problem((run) => { run.order = ['libcrux_sha2', 'libcrux_hmac']; }), /^the order of the crates is not the roster's/);
    assert.match(problem((run) => { run.units[1].nonTargets = [{ crate: 'x', dir: 'x', sources: [] }]; }), /^crate libcrux_sha2 names other non-target crates than the roster/);
    assert.match(problem((run) => { run.units.pop(); }), /^a crate is missing from the run, or was added to it/);
    assert.match(problem((run) => { run.roster.main = 'libcrux_sha2'; }), /^the roster does not match its hash/);
  });

  it('refuses a crate the roster says a patch removed from the copy when the run still holds it', () => {
    const run = runOf(hmacAndSha2, { dropped: [{ crate: 'libcrux_sha2', reason: 'a patch removed it' }] });
    assert.match(auto.unitsProblem(run), /^a dropped crate is also in the run or a non-target/);
  });

  it('refuses a stitch that is only a label', () => {
    assert.match(problem((run) => { delete hmac(run).stitch[0].providerStageSha256; }), /^the stitch of libcrux_hmac to libcrux_sha2 carries no evidence/);
    assert.match(problem((run) => { hmac(run).stitch[0].modules = []; }), /^the stitch of libcrux_hmac to libcrux_sha2 carries no evidence/);
  });

  it('refuses a stitch made from another publication of the provider than the run holds', () => {
    assert.match(problem((run) => { hmac(run).stitch[0].providerStageSha256 = '1'.repeat(64); }),
      /^the stitch of libcrux_hmac was made from another publication of libcrux_sha2 than the run holds/);
  });

  it('says in the malformed-state message why a recorded run no longer reads', () => {
    const root = extracted(hmacAndSha2);
    const state = readState(root);
    state.extraction.run.units[0].stitch[0].providerStageSha256 = '1'.repeat(64);
    writeState(root, state);
    const result = cli('read-state', '--project-root', root);
    assert.equal(result.status, 3, result.stdout);
    assert.match(result.json.message, /extraction\.run must be the re-validated extraction attempt \(the stitch of libcrux_hmac was made from another publication of libcrux_sha2 than the run holds\)/);
  });

  it('names a run that lost its crate rows, and a single crate\'s own run has none of the aggregate fields', () => {
    assert.match(problem((run) => { delete run.units; }), /^the run carries its roster, rosterSha256, order but lists none of its crates/);
    assert.match(problem((run) => { delete run.units; delete run.roster; delete run.rosterSha256; }), /^the run carries its order but lists none of its crates/);
    assert.equal(problem((run) => { delete run.units; delete run.roster; delete run.rosterSha256; delete run.order; }), null,
      'a run with none of the aggregate fields is a single crate\'s run, which says nothing about scope');
  });

  it('refuses a stitch that replaced aliases but records no Lean check for them, in a crate of a run and in a single crate\'s own run', () => {
    const replaced = (run) => { run.units[0].stitch[0].replaced = ['libcrux_sha2::hacl::hash_256']; };
    assert.match(problem(replaced), /^crate libcrux_hmac stitched 1 alias but records no Lean check for it/);
    assert.equal(problem((run) => { replaced(run); run.units[0].leanChecks = []; }) === null, false, 'an empty list is no record');
    assert.equal(problem((run) => { replaced(run); run.units[0].leanChecks = [{ file: 'Funs.lean' }]; }), null);
    const lone = runOf(hmacAndSha2);
    fixtures.asSingleCrate(lone);
    lone.stitch = stitchOf({ provider: 'libcrux_sha2', replaced: ['a', 'b'] });
    assert.match(auto.unitsProblem(lone), /^crate libcrux_hmac stitched 2 aliases but records no Lean check for them/);
    lone.leanChecks = [{ file: 'Funs.lean' }];
    assert.equal(auto.unitsProblem(lone), null);
  });

  it('refuses a stitch to a crate that is not another crate of the run, and one to the crate itself', () => {
    assert.match(auto.unitsProblem(runOf((directory) => [unit(directory, 'app', [], { stitch: ['elsewhere'] }), unit(directory, 'base', [])])),
      /^crate app is stitched to elsewhere, which is not another crate of the run/);
    assert.match(auto.unitsProblem(runOf((directory) => [unit(directory, 'app', [], { stitch: ['app'] }), unit(directory, 'base', [])])),
      /^crate app is stitched to app, which is not another crate of the run/);
  });

  it('refuses imports its stitch does not name, so a label alone does not link the crates', () => {
    const run = runOf((directory) => [unit(directory, 'app', [], { imports: ['base'], stitch: [] }), unit(directory, 'base', [])]);
    assert.match(auto.unitsProblem(run), /^crate app imports crates its stitch does not name/);
  });

  it('counts an edge named only by dependsOn as one that still needs its stitch', () => {
    const run = runOf((directory) => [unit(directory, 'app', [], { dependsOn: ['base'] }), unit(directory, 'base', [])]);
    assert.equal(auto.unitsProblem(run), null);
    assert.match(auto.crateProblems(run)[0], /^crate app uses items of base, which is verified, without being stitched to it/);
  });

  it('counts a stitch entry without its evidence as no link when the crates are read directly', () => {
    const stitchless = runOf((directory) => [unit(directory, 'app', [], { dependsOn: ['base'] }), unit(directory, 'base', [])]);
    stitchless.units[0].stitch = [{ provider: 'base' }];
    assert.match(auto.crateProblems(stitchless)[0], /^crate app uses items of base, which is verified, without being stitched to it/);
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

  it('accepts a crate that is stitched to the provider, and a run with no cycle', () => {
    const stitched = runOf((directory) => [unit(directory, 'app', [], { ...reaches('base'), ...stitchTo('base') }), unit(directory, 'base', [])]);
    assert.deepEqual(auto.crateProblems(stitched), []);
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
    fixtures.asSingleCrate(run);
    delete run.status;
    assert.deepEqual(auto.crateProblems(run), []);
  });

  it('has nothing to say about a single crate or a run that was not recorded', () => {
    assert.deepEqual(auto.crateProblems(runOf((directory) => [unit(directory, 'app', [], reaches('base'))])), []);
    assert.deepEqual(auto.crateProblems(undefined), []);
  });
});

describe('what the project does after stitching', () => {
  const said = /After the stitching the project has work FVS does not do: regenerate the pinned axiom lists in its own Lean project as a reviewed change, record an externals entry for each axiom that newly appears, and replace the hand-written Trusted axioms/;
  const stitchTo = (provider) => ({ stitch: [{ provider, modules: ['M'], replaced: [], assumed: [], copies: [], files: [] }] });

  it('is in the next action once a crate is stitched, and not before', () => {
    const stitched = extracted((directory) => [unit(directory, 'app', [], stitchTo('base')), unit(directory, 'base', [])]);
    assert.match(cli('read-state', '--project-root', stitched, '--brief').json.nextAction, said);
    const plain = extracted((directory) => [unit(directory, 'app', []), unit(directory, 'base', [])]);
    assert.doesNotMatch(cli('read-state', '--project-root', plain, '--brief').json.nextAction, /After the stitching/);
    const none = extracted((directory) => [unit(directory, 'app', [], { stitch: [] }), unit(directory, 'base', [])]);
    assert.doesNotMatch(cli('read-state', '--project-root', none, '--brief').json.nextAction, /After the stitching/, 'an empty stitch list changes nothing');
  });
});

describe('the roster of a run over several crates', () => {
  it('a single crate\'s run has no roster, and none is required of it', () => {
    const root = extracted((directory) => [unit(directory, 'libcrux_hmac', [])]);
    const state = readState(root);
    fixtures.asSingleCrate(state.extraction.run);
    writeState(root, state);
    const result = cli('read-state', '--project-root', root);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.json.code, 'ok');
  });

  it('is kept in the extraction record, with each unit row carrying the same hash', () => {
    const root = extracted(hmacAndSha2);
    const { run } = readState(root).extraction;
    assert.match(run.rosterSha256, /^[0-9a-f]{64}$/);
    assert.equal(run.rosterSha256, fixtures.sha256(JSON.stringify(run.roster)));
    assert.deepEqual(run.units.map((row) => row.rosterSha256), [run.rosterSha256, run.rosterSha256]);
    assert.deepEqual(run.roster.units.map((entry) => entry.crate), run.roster.order);
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
    fixtures.asSingleCrate(state.extraction.run);
    writeState(root, state);
    assert.equal(cli('list-items', '--project-root', root).json.items.length, 1);
    assert.equal(cli('list-items', '--project-root', root, '--crate', 'libcrux_hmac').json.items.length, 1);
    assert.equal(cli('list-items', '--project-root', root, '--crate', 'other').json.code, 'invalid-input');
  });
});
