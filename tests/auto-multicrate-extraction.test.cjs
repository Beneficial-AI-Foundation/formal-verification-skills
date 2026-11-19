'use strict';

// A succeeded extraction over several crates in scripts/fvs-auto.mjs: each unit is
// validated as a whole single-crate run, a reader can ask for one crate's run, and
// read-state reports the crates with an order that puts providers before consumers.
// Every extraction record here is built by hand in a temporary git fixture; no
// Charon, Aeneas or Lean runs.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'fvs-auto.mjs');
const PROFILE_FIXTURES = path.join(__dirname, 'fixtures', 'auto-profile');
const CRATE = path.join(__dirname, 'fixtures', 'extract-patches', 'crate');
const TMP = fs.realpathSync(os.tmpdir());
const temporaryDirectories = [];
let auto = null;

before(async () => {
  auto = await import(pathToFileURL(SCRIPT).href);
});

after(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(TMP, prefix));
  temporaryDirectories.push(directory);
  return directory;
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const ZEROS = '0'.repeat(64);

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, '-c', 'user.name=fvs', '-c', 'user.email=fvs@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function project() {
  const root = temporaryDirectory('fvs-multicrate-');
  fs.cpSync(CRATE, root, { recursive: true });
  fs.cpSync(path.join(PROFILE_FIXTURES, 'fresh'), root, { recursive: true });
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture');
  return root;
}

function init(root) {
  const environment = {
    HOME: path.join(PROFILE_FIXTURES, 'home'),
    PATH: [path.join(PROFILE_FIXTURES, 'bin'), '/usr/bin', '/bin'].join(path.delimiter),
    FVS_TOOLS_HOME: path.join(PROFILE_FIXTURES, 'no-fvs-tools'),
  };
  const saved = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try {
    return auto.initState({ projectRoot: root, platform: 'aarch64-apple-darwin',
      choices: { source: { revision: 'HEAD', configuration: 'default features' }, scope: 'every crate of the repository', limits: { wallClockHours: 40 } } });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function cli(...args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    // left null: the assertion on json shows the raw output
  }
  return { status: result.status, stdout: result.stdout, json };
}

const stateFile = (root) => path.join(root, '.formalising', 'auto-fv', 'state.json');

const fn = (rust, file, line) => ({ def_id: line, lean_name: rust.replace(/::/g, '.'), lean_file: 'X.lean', rust_name: rust, is_local: true,
  source: { file, begin_line: line, end_line: line + 2 }, is_opaque: false, can_fail: true });

// One crate's whole single-crate run: its own folder and its own translation.json.
function unit(root, crate, functions, extra = {}) {
  const directory = path.join(root, crate);
  fs.mkdirSync(directory, { recursive: true });
  const published = path.join(directory, 'translation.json');
  fs.writeFileSync(published, JSON.stringify({ aeneas_version: 'x', charon_version: 'y', crate, functions, types: [], globals: [], trait_decls: [], trait_impls: [] }));
  const entry = { attemptPath: `/attempt/${crate}/translation.json`, projectPath: published, sha256: sha256(fs.readFileSync(published)) };
  return {
    attemptSha256: ZEROS, manifestSha256: ZEROS, configSha256: ZEROS, config: {}, supported: true, residuals: [], trust: 'local-host-and-reviewed-scripts',
    stages: { charon: ZEROS, aeneas: ZEROS, publish: ZEROS }, llbc: { path: `${crate}.llbc`, sha256: ZEROS },
    translation: entry, publication: [entry],
    crate, package: crate.replace(/_/g, '-'), dir: `crates/${crate}`, status: 'complete',
    hasErrors: { value: false, items: [], itemCount: 0 }, ...extra,
  };
}

// A project whose recorded extraction succeeded over the given crates; `main` is the first.
function extracted(units, { run = {} } = {}) {
  const root = project();
  init(root);
  const state = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
  const rows = units(root);
  state.extraction = {
    status: 'succeeded', recordedAt: '2026-11-19T00:00:00.000Z', reasons: [], note: 'not a proof',
    selected: { ...state.choices.source },
    declared: { buildExitCode: 0, oracle: 'complete' },
    checks: { status: { ok: true }, 'verify-tree': { ok: true }, 'verify-restore': { ok: true } },
    inputs: { out: path.join(root, 'copy'), manifestSha256: ZEROS, crateRoot: root, mode: 'translation-patches', sourceCommit: 'a'.repeat(40), patches: [] },
    run: { ...rows[0], units: rows, ...run },
  };
  fs.writeFileSync(stateFile(root), JSON.stringify(state));
  return root;
}

const hmacAndSha2 = (root) => [
  unit(root, 'libcrux_hmac', [fn('libcrux_hmac::hmac::hmac', 'src/hmac.rs', 10)], { imports: ['libcrux_sha2'] }),
  unit(root, 'libcrux_sha2', [fn('libcrux_sha2::hacl::hash_256', 'src/hacl.rs', 5)]),
];

describe('a succeeded extraction over several crates', () => {
  it('read-state reports the crates, providers before consumers, in the full and brief results', () => {
    const root = extracted(hmacAndSha2);
    for (const flags of [[], ['--brief']]) {
      const result = cli('read-state', '--project-root', root, ...flags);
      assert.equal(result.status, 0, result.stdout);
      assert.deepEqual(result.json.crates, {
        order: ['libcrux_sha2', 'libcrux_hmac'],
        units: [
          { crate: 'libcrux_hmac', package: 'libcrux-hmac', dir: 'crates/libcrux_hmac', dependsOn: ['libcrux_sha2'], hasErrorItems: [] },
          { crate: 'libcrux_sha2', package: 'libcrux-sha2', dir: 'crates/libcrux_sha2', dependsOn: [], hasErrorItems: [] },
        ],
      }, flags.join(' ') || 'full');
    }
  });

  it('takes a dependency from imports, prerequisites or a target the LLBC reaches, and ignores non-targets and unknown crates', () => {
    const root = extracted((directory) => [
      unit(directory, 'app', [], { prerequisites: [{ providerCrate: 'mid', rustPath: 'mid::f' }, { providerCrate: 'elsewhere', rustPath: 'elsewhere::g' }] }),
      unit(directory, 'mid', [], { llbc: { path: 'mid.llbc', sha256: ZEROS, foreignCrates: [{ crate: 'base', target: true }, { crate: 'core', target: false }] } }),
      unit(directory, 'base', []),
      unit(directory, 'loose', []),
    ]);
    const { crates } = cli('read-state', '--project-root', root, '--brief').json;
    assert.deepEqual(Object.fromEntries(crates.units.map((entry) => [entry.crate, entry.dependsOn])),
      { app: ['mid'], mid: ['base'], base: [], loose: [] });
    assert.deepEqual(crates.order, ['base', 'loose', 'mid', 'app'], 'derived order: ties by name, every provider first');
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
    const state = JSON.parse(fs.readFileSync(stateFile(plain), 'utf8'));
    const oneRow = state.extraction.run.units;
    for (const units of [null, oneRow]) {
      if (units === null) delete state.extraction.run.units;
      else state.extraction.run.units = units;
      fs.writeFileSync(stateFile(plain), JSON.stringify(state));
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
      const state = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
      change(state);
      fs.writeFileSync(stateFile(root), JSON.stringify(state));
      const result = cli('read-state', '--project-root', root);
      assert.equal(result.status, 3, `${label}: ${result.stdout}`);
      assert.equal(result.json.code, 'malformed-state', label);
      assert.match(result.json.message, /extraction\.run must be the re-validated extraction attempt/, label);
    }
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
    const state = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
    delete state.extraction.run.units;
    fs.writeFileSync(stateFile(root), JSON.stringify(state));
    assert.equal(cli('list-items', '--project-root', root).json.items.length, 1);
    assert.equal(cli('list-items', '--project-root', root, '--crate', 'libcrux_hmac').json.items.length, 1);
    assert.equal(cli('list-items', '--project-root', root, '--crate', 'other').json.code, 'invalid-input');
  });
});
