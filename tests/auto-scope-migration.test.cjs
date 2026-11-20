'use strict';

// An extraction recorded before the extraction kept its scope has none, and a scope that is missing is not a
// single crate. Extracting again settles it, but costs a whole Charon and Aeneas run, so record-scope offers
// the other way: the workspace at the commit the extraction was made from is read with the extraction
// engine's crate scan, and when it holds exactly one library crate the owner confirms that and the scope is
// recorded, with nothing extracted again. The scan is replaced by a fake in the refusal cases; the cases with
// a real workspace need the extraction lane's test tools and are skipped where that helper is absent.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fixtures = require('./helpers/multicrate-fixtures.cjs');

const { ROOT, extracted, readState, writeState, stateFile, git, cli, unit, fn } = fixtures;
const TMP = fs.realpathSync(os.tmpdir());
const PROFILE_FIXTURES = path.join(__dirname, 'fixtures', 'auto-profile');
// The extraction record as an earlier FVS wrote it, taken from a state file of that time.
const LEGACY = require('./fixtures/auto-lean-graph/recorded/bound-positive/state.json').extraction;
let auto = null;

before(async () => {
  auto = await import(pathToFileURL(path.join(ROOT, 'scripts', 'fvs-auto.mjs')).href);
  fixtures.use(auto);
});

after(fixtures.cleanup);

const ONE = { kind: 'single-crate', basis: 'cargo', libraryCrates: ['demo'] };
const found = (scope) => () => ({ ok: true, code: 'ok', command: 'crates', scope });
const refusedWith = (code, pattern) => (error) => error instanceof auto.Refusal && error.code === code && pattern.test(error.message);
const bytes = (root) => fs.readFileSync(stateFile(root), 'utf8');

// A project whose recorded extraction is the single crate `demo`, in the shape an earlier FVS recorded: no
// scope, and a run with the keys of that time. Its source commit is the project's own head commit.
function legacyRecord() {
  const root = extracted((dir) => [unit(dir, 'demo', [fn('demo::f', 'src/lib.rs', 1)])]);
  const state = readState(root);
  const { extraction } = state;
  delete extraction.scope;
  extraction.run = Object.fromEntries(Object.keys(LEGACY.run).map((key) => [key, extraction.run[key]]));
  extraction.inputs.sourceCommit = git(root, 'rev-parse', 'HEAD');
  writeState(root, state);
  return root;
}

const settle = (root, scan, options = {}) => auto.recordScope({ projectRoot: root, release: '.aeneas/release', scan, ...options });

describe('an extraction recorded before the scope was kept', () => {
  it('has the key set an earlier FVS recorded, and the state holds at the extract phase with the way to settle it', () => {
    const root = legacyRecord();
    const { extraction } = readState(root);
    assert.deepEqual(Object.keys(extraction).sort(), Object.keys(LEGACY).sort());
    assert.deepEqual(Object.keys(extraction.inputs).sort(), Object.keys(LEGACY.inputs).sort());
    const read = cli('read-state', '--project-root', root).json;
    assert.equal(read.phase, 'extract');
    assert.match(read.nextAction, /^Rerun \/fvs:auto-extract: the recorded extraction does not say whether it is of a single crate or of several/);
    assert.match(read.nextAction, /settled without extracting again: run record-scope --release DIR/);
  });

  it('reports the one crate and writes nothing until the owner confirms', () => {
    const root = legacyRecord();
    const before = bytes(root);
    const calls = [];
    const result = settle(root, (request) => { calls.push(request); return found(ONE)(); });
    assert.equal(result.code, 'scope-found');
    assert.equal(result.recorded, false);
    assert.match(result.message, /holds exactly one library crate, demo; nothing is recorded yet/);
    assert.match(result.nextStep, /rerun this command with --confirm once they agree/);
    assert.equal(bytes(root), before, 'the state is not touched');
    assert.deepEqual(calls.map(({ commit, release }) => [commit, release]), [[readState(root).extraction.inputs.sourceCommit, path.resolve(root, '.aeneas/release')]], 'the recorded source commit, not the working tree, is scanned, with the release folder resolved from the project root');
  });

  it('records the scan\'s scope verbatim when confirmed, leaves the run as it was, and moves the phase on', () => {
    const root = legacyRecord();
    const { extraction: old } = readState(root);
    const result = settle(root, found(ONE), { confirm: true });
    assert.equal(result.code, 'recorded');
    const { extraction } = readState(root);
    assert.deepEqual(extraction.scope, ONE);
    assert.deepEqual(extraction.scopeSettled.sourceCommit, old.inputs.sourceCommit);
    assert.match(extraction.scopeSettled.recordedAt, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(extraction.run, old.run, 'no part of the run is changed');
    assert.deepEqual(extraction.inputs, old.inputs);
    const read = cli('read-state', '--project-root', root).json;
    assert.equal(read.code, 'ok');
    assert.notEqual(read.phase, 'extract', 'the state moves past the extraction');
    assert.throws(() => settle(root, found(ONE), { confirm: true }), refusedWith('scope-recorded', /already records its scope \(single-crate\)/), 'it is never changed afterwards');
  });

  const REFUSALS = [
    ['several library crates', found({ kind: 'multi-crate', basis: 'cargo', libraryCrates: ['demo', 'other'] }), 'multi-crate-extraction-needed', /holds several library crates \(demo, other\), so a multi-crate extraction is needed/],
    ['a scope the engine cannot establish', found({ kind: 'unknown', basis: 'none', reason: 'cargo cannot read the workspace' }), 'scope-unsettled', /is not established \(cargo cannot read the workspace\)/],
    ['a single crate with no library crate in it', found({ kind: 'single-crate', basis: 'cargo', libraryCrates: [] }), 'scope-scan-failed', /does not name exactly one library crate \(none\)/],
    ['a single crate read only from a manifest', found({ kind: 'single-crate', basis: 'manifest', manifest: 'Cargo.toml' }), 'scope-scan-failed', /does not name exactly one library crate/],
    ['an engine that reports no scope', () => ({ ok: true, code: 'ok', crates: [] }), 'scope-scan-failed', /reports no scope .* update FVS, or extract again/],
    ['a scan that failed', () => ({ ok: false, code: 'scope-scan-failed', message: 'cargo metadata failed' }), 'scope-scan-failed', /could not be read: cargo metadata failed/],
    ['a crate the recorded run did not translate', found({ kind: 'single-crate', basis: 'cargo', libraryCrates: ['other'] }), 'scope-mismatch', /holds the library crate other, but the recorded extraction translated demo/],
  ];
  for (const [name, scan, code, pattern] of REFUSALS) {
    it(`refuses ${name}, with or without the confirmation, and writes nothing`, () => {
      const root = legacyRecord();
      const before = bytes(root);
      for (const confirm of [false, true]) assert.throws(() => settle(root, scan, { confirm }), refusedWith(code, pattern));
      assert.equal(bytes(root), before);
    });
  }

  it('refuses a record that has no succeeded extraction, a scope already, or a run of several crates, and writes nothing', () => {
    const none = fixtures.project();
    fixtures.init(none);
    assert.throws(() => settle(none, found(ONE), { confirm: true }), refusedWith('no-extraction', /no succeeded extraction record/));

    const failed = legacyRecord();
    const state = readState(failed);
    state.extraction.status = 'failed';
    state.extraction.reasons = ['the build exited 1'];
    writeState(failed, state);
    assert.throws(() => settle(failed, found(ONE), { confirm: true }), refusedWith('no-extraction', /no succeeded extraction record/));

    const scoped = extracted((dir) => [unit(dir, 'demo', [fn('demo::f', 'src/lib.rs', 1)])]);
    assert.throws(() => settle(scoped, found(ONE), { confirm: true }), refusedWith('scope-recorded', /already records its scope/));

    // A record of two crates that lost its scope is the extraction of several crates, which this never settles.
    const aggregate = extracted(fixtures.hmacAndSha2);
    const several = readState(aggregate);
    delete several.extraction.scope;
    writeState(aggregate, several);
    const before = bytes(aggregate);
    assert.throws(() => settle(aggregate, found(ONE), { confirm: true }), refusedWith('aggregate-run', /an extraction of several crates and is never settled as one crate/));
    assert.equal(bytes(aggregate), before);
  });

  it('is a command that needs the release folder', () => {
    const root = legacyRecord();
    const result = cli('record-scope', '--project-root', root);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /--release/);
  });
});

// The same against a real workspace and the extraction engine's own scan.
const MULTI_TOOLS = path.join(__dirname, 'helpers', 'fake-multicrate-tools.cjs');
const multi = fs.existsSync(MULTI_TOOLS) ? require(MULTI_TOOLS) : null;
const SINGLE_SPEC = { release: multi?.RELEASE, cargoArgs: ['--locked', '--package', 'toy-lib'], crate: 'toy_lib', publishDir: 'Lean/Lib', moduleRoot: 'Toy.Lib' };

// Runs `fn` with the environment the fake tools of the workspace expect, and the stub profile for setup.
function withTools(ws, fn) {
  const environment = {
    HOME: path.join(ws.tools.scratch, 'home'), RUSTUP_HOME: path.join(ws.tools.scratch, 'rustup'), CARGO_HOME: ws.tools.cargoHome,
    PATH: [path.join(PROFILE_FIXTURES, 'bin'), '/usr/bin', '/bin'].join(path.delimiter), FVS_TOOLS_HOME: path.join(PROFILE_FIXTURES, 'no-fvs-tools'),
  };
  const saved = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const WORKSPACE_TOML = (members) => `[workspace]\nmembers = [${members.map((member) => `"${member}"`).join(', ')}]\nresolver = "2"\n\n[workspace.package]\nversion = "0.1.0"\nedition = "2021"\n`;

describe('an old record settled against a real workspace', { skip: multi === null ? 'the extraction lane\'s multi-crate test tools are not in this tree' : false }, () => {
  // One library crate is extracted and recorded; the record is then given the shape an earlier FVS wrote
  // (no scope), and a second crate arrives in a later commit.
  function oneCrateThenTwo() {
    const ws = multi.workspace();
    const write = (file, text) => fs.writeFileSync(path.join(ws.project, file), text);
    fs.rmSync(path.join(ws.project, 'app'), { recursive: true });
    write('Cargo.toml', WORKSPACE_TOML(['lib']));
    write('.formalising/fvs-config.json', JSON.stringify({ extraction: { inputs: ['Cargo.toml', 'Cargo.lock', 'lib'] } }));
    fs.cpSync(path.join(PROFILE_FIXTURES, 'fresh'), ws.project, { recursive: true });
    git(ws.project, 'init', '-q');
    git(ws.project, 'add', '-A');
    git(ws.project, 'commit', '-q', '-m', 'one crate');
    const extractedAt = git(ws.project, 'rev-parse', 'HEAD');
    withTools(ws, () => fixtures.init(ws.project));
    const out = path.join(ws.root, 'copies', 'one');
    assert.equal(multi.run(ws, ['prepare', '--project-root', ws.project, '--out', out, '--release', multi.RELEASE]).status, 0);
    const attempt = multi.run(ws, ['attempt', '--out', out, '--spec', multi.specFile(ws, SINGLE_SPEC)]);
    assert.equal(attempt.status, 0, attempt.stdout);
    for (const name of ['charon', 'aeneas', 'publish']) {
      const done = multi.step(ws, out, name);
      assert.equal(done.status, 0, `${name}: ${done.stdout}`);
    }
    withTools(ws, () => auto.recordExtraction({ projectRoot: ws.project, out, buildExitCode: 0, oracle: 'complete' }));
    const state = readState(ws.project);
    assert.equal(state.extraction.scope.kind, 'single-crate', 'the extraction records its scope as a single crate');
    assert.equal(state.extraction.run.scope.kind, 'single-crate');
    delete state.extraction.scope;
    delete state.extraction.run.scope;
    writeState(ws.project, state);

    fs.mkdirSync(path.join(ws.project, 'app', 'src'), { recursive: true });
    write('app/Cargo.toml', '[package]\nname = "toy-app"\nversion.workspace = true\nedition.workspace = true\n\n[dependencies]\ntoy-lib = { path = "../lib" }\n');
    write('app/src/lib.rs', 'pub fn three() -> u32 { toy_lib::one() + 2 }\n');
    write('Cargo.toml', WORKSPACE_TOML(['app', 'lib']));
    git(ws.project, 'add', '-A');
    git(ws.project, 'commit', '-q', '-m', 'a second crate');
    return { ws, extractedAt, later: git(ws.project, 'rev-parse', 'HEAD') };
  }

  it('reads the workspace at the commit the extraction was made from, not at the working tree where a second crate has been added', () => {
    const { ws, extractedAt, later } = oneCrateThenTwo();
    assert.notEqual(extractedAt, later);
    const head = multi.run(ws, ['crates', '--project-root', ws.project, '--release', multi.RELEASE]).result;
    assert.equal(head.scope.kind, 'multi-crate', 'the working tree now holds two library crates');
    const release = path.join(ws.project, multi.RELEASE);
    const seen = withTools(ws, () => auto.recordScope({ projectRoot: ws.project, release }));
    assert.equal(seen.code, 'scope-found', seen.message);
    assert.deepEqual(seen.scope, { kind: 'single-crate', basis: 'cargo', libraryCrates: ['toy_lib'] });
    const unchanged = fs.readFileSync(stateFile(ws.project), 'utf8');
    assert.equal(withTools(ws, () => auto.recordScope({ projectRoot: ws.project, release })).code, 'scope-found');
    assert.equal(fs.readFileSync(stateFile(ws.project), 'utf8'), unchanged, 'the unconfirmed calls write nothing');
    assert.equal(withTools(ws, () => auto.recordScope({ projectRoot: ws.project, release, confirm: true })).code, 'recorded');
    const { extraction } = readState(ws.project);
    assert.equal(extraction.scope.kind, 'single-crate');
    assert.equal(extraction.scopeSettled.sourceCommit, extractedAt);
    assert.notEqual(cli('read-state', '--project-root', ws.project).json.phase, 'extract');
    assert.deepEqual(fs.readdirSync(TMP).filter((name) => name.startsWith('fvs-scope-')), [], 'the export was removed');
  });

  it('refuses a record whose recorded commit holds two library crates', () => {
    const { ws, later } = oneCrateThenTwo();
    const state = readState(ws.project);
    state.extraction.inputs.sourceCommit = later;
    writeState(ws.project, state);
    const before = fs.readFileSync(stateFile(ws.project), 'utf8');
    const release = path.join(ws.project, multi.RELEASE);
    assert.throws(() => withTools(ws, () => auto.recordScope({ projectRoot: ws.project, release, confirm: true })), refusedWith('multi-crate-extraction-needed', /holds several library crates \(toy_app, toy_lib\)/));
    assert.equal(fs.readFileSync(stateFile(ws.project), 'utf8'), before);
  });
});
