'use strict';

// What record-extraction does with the scope of the extraction. A single crate is a fact the extraction
// established when it prepared the copy (the manifest's `scope`), never what is left when nothing says
// otherwise: a copy that records no scope, or an unknown one, is never recorded as a success, and when
// the scope is several crates (the copy's scope, the agreement, or the workspace) only a completed
// attempt over all of them is recorded; a missing attempt, or the attempt of one crate, is never read
// as "nothing else to verify". A project with one crate records as before. The copies are prepared and
// attempted with the fake extraction tools; no Charon, Aeneas or Lean runs.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fixtures = require('./helpers/multicrate-fixtures.cjs');
const { fakeTools, engine, writeSpec, recordScope, LONE_CRATE } = require('./helpers/fake-extraction-tools.cjs');

const { ROOT, project, init, agreementFor, recordAgreement, readState } = fixtures;
const ENGINE = path.join(ROOT, 'scripts', 'fvs-extract-patches.mjs');
const PROFILE_FIXTURES = path.join(__dirname, 'fixtures', 'auto-profile');
let auto = null;

before(async () => {
  auto = await import(pathToFileURL(path.join(ROOT, 'scripts', 'fvs-auto.mjs')).href);
  fixtures.use(auto);
});

after(fixtures.cleanup);

// Runs `fn` with the profile tests' stub tools as the only tools on PATH.
function withStubs(fn) {
  const environment = {
    HOME: path.join(PROFILE_FIXTURES, 'home'),
    PATH: [path.join(PROFILE_FIXTURES, 'bin'), '/usr/bin', '/bin'].join(path.delimiter),
    FVS_TOOLS_HOME: path.join(PROFILE_FIXTURES, 'no-fvs-tools'),
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

// The scope of a workspace of the fixture's crate `demo` and another library crate `other`.
const SEVERAL = { kind: 'multi-crate', basis: 'cargo', libraryCrates: ['demo', 'other'] };
const UNKNOWN = { kind: 'unknown', basis: 'none', reason: 'a workspace prepared without a release folder is not read by cargo' };

// Sets the scope in a prepared copy's manifest (a missing one with `undefined`), before any attempt, which
// is bound to the manifest's bytes.
function editScope(out, scope) {
  const file = path.join(out, 'manifest.json');
  const { scope: _recorded, ...manifest } = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, `${JSON.stringify(scope === undefined ? manifest : { ...manifest, scope }, null, 2)}\n`);
}

// A prepared copy of the project, with the scope it records (the lone crate's unless `scope` says another;
// `undefined` records none). With `attempt` the fake tools also ran the attempt of its one crate: the result
// is then `{ out, refused }`, where `refused` holds the engine's own refusal when it will not attempt that
// scope at all.
function copyOf(root, options) {
  const { attempt } = options;
  const scope = 'scope' in options ? options.scope : LONE_CRATE;
  const tools = fakeTools(root, fixtures.temporaryDirectory('fvs-scope-tools-'));
  const out = path.join(fixtures.temporaryDirectory('fvs-scope-out-'), 'copy');
  const prepare = spawnSync(process.execPath, [ENGINE, 'prepare', '--project-root', root, '--out', out], { encoding: 'utf8' });
  assert.equal(prepare.status, 0, prepare.stdout);
  if (scope === LONE_CRATE) recordScope(out);
  else editScope(out, scope);
  if (!attempt) return { out, refused: null };
  const started = engine(tools, ['attempt', '--out', out, '--spec', writeSpec(path.join(tools.scratch, 'spec.json'))]);
  if (started.status !== 0) return { out, refused: started.stdout };
  for (const step of ['charon', 'aeneas', 'publish']) assert.equal(engine(tools, ['run', '--out', out, '--step', step]).status, 0, step);
  return { out, refused: null };
}

const record = (root, out) => withStubs(() => auto.recordExtraction({ projectRoot: root, out, buildExitCode: 0, oracle: 'complete' }));
const refusedWith = (pattern) => (error) => error instanceof auto.Refusal && error.code === 'extraction-failed' && pattern.test(error.message);

// An agreement that names the crates `demo` (the fixture's own crate) and `other`.
const severalTargets = { crates: ['demo', 'other'], nonTargets: [] };

describe('record-extraction when the scope is several crates', () => {
  it('refuses a copy with no extraction attempt when the agreement names several crates', () => {
    const root = project();
    init(root);
    assert.equal(recordAgreement(root, agreementFor(root, { targets: severalTargets })).code, 'recorded');
    const { out } = copyOf(root, { attempt: false });
    assert.throws(() => record(root, out), refusedWith(/the crates demo, other are in scope .* the copy holds no extraction attempt/));
    const { extraction } = readState(root);
    assert.equal(extraction.status, 'failed');
    assert.equal('run' in extraction, false);
  });

  it('refuses the attempt of one crate when the agreement names several', () => {
    const root = project();
    init(root);
    assert.equal(recordAgreement(root, agreementFor(root, { targets: { crates: ['demo'], nonTargets: [{ crate: 'other', decision: 'Not verified; assumed.' }] } })).code, 'recorded');
    const { out } = copyOf(root, { attempt: true });
    assert.throws(() => record(root, out), refusedWith(/the crates demo, other are in scope .* the copy holds the attempt of one crate only/));
    assert.equal(readState(root).extraction.status, 'failed');
  });

  it('records the same copy when the agreement names one crate, or none', () => {
    for (const targets of [{ crates: ['demo'], nonTargets: [] }, null]) {
      const root = project();
      init(root);
      if (targets) assert.equal(recordAgreement(root, agreementFor(root, { targets })).code, 'recorded');
      const { out } = copyOf(root, { attempt: true });
      assert.equal(record(root, out).code, 'recorded');
      assert.equal(readState(root).extraction.status, 'succeeded');
    }
  });

  it('refuses a copy whose scope is several crates when it holds no attempt, with no agreement at all', () => {
    const root = project();
    init(root);
    const { out } = copyOf(root, { attempt: false, scope: SEVERAL });
    assert.throws(() => record(root, out), refusedWith(/the crates demo, other are in scope \(the copy's scope, .*\), but the copy holds no extraction attempt/));
    const { extraction } = readState(root);
    assert.equal(extraction.status, 'failed');
    assert.deepEqual(extraction.scope, SEVERAL, 'the failed record says which scope it answered');
  });

  it('refuses the attempt of one crate when the copy\'s scope is several crates, with no agreement at all', () => {
    const root = project();
    init(root);
    const { out, refused } = copyOf(root, { attempt: true, scope: SEVERAL });
    // An extraction engine that refuses a single-crate attempt on this scope stops it there; the engine's own tests pin that.
    if (refused !== null) return assert.match(refused, /scope/);
    assert.throws(() => record(root, out), refusedWith(/the crates demo, other are in scope .* the copy holds the attempt of one crate only/));
    assert.equal(readState(root).extraction.status, 'failed');
  });
});

describe('record-extraction when the scope is not established', () => {
  it('refuses a copy whose manifest records no scope, and says an unknown scope is never a single crate', () => {
    const root = project();
    init(root);
    const { out } = copyOf(root, { attempt: false, scope: undefined });
    assert.throws(() => record(root, out), refusedWith(/the scope of this extraction is not established \(the copy records no scope .*\), and an unknown scope is never read as a single crate: prepare the copy again/));
    const { extraction } = readState(root);
    assert.equal(extraction.status, 'failed');
    assert.equal(extraction.scope.kind, 'unknown');
  });

  it('refuses a copy whose scope the engine could not classify, with the engine\'s reason', () => {
    const root = project();
    init(root);
    const { out } = copyOf(root, { attempt: false, scope: UNKNOWN });
    assert.throws(() => record(root, out), refusedWith(/the scope of this extraction is not established \(a workspace prepared without a release folder is not read by cargo\)/));
  });

  it('refuses a two-member workspace prepared without a release folder, with an attempt of one crate or none', () => {
    // No inventory and no targets field in the agreement: nothing says which crates are in scope, so the
    // one crate that was attempted is not taken for all of them.
    for (const attempt of [false, true]) {
      const root = project();
      init(root);
      const { out, refused } = copyOf(root, { attempt, scope: UNKNOWN });
      if (refused !== null) { assert.match(refused, /scope/); continue; }
      assert.throws(() => record(root, out), refusedWith(/the scope of this extraction is not established/), attempt ? 'one crate attempted' : 'no attempt');
      assert.equal(readState(root).extraction.status, 'failed');
    }
  });

  it('records a copy whose scope is positively one crate, with or without an attempt, and keeps that scope in the record', () => {
    for (const attempt of [false, true]) {
      const root = project();
      init(root);
      const { out } = copyOf(root, { attempt });
      assert.equal(record(root, out).code, 'recorded', attempt ? 'with an attempt' : 'without one');
      const { extraction } = readState(root);
      assert.equal(extraction.status, 'succeeded');
      assert.equal(extraction.scope.kind, 'single-crate');
      assert.equal(JSON.parse(fs.readFileSync(path.join(extraction.inputs.out, 'manifest.json'), 'utf8')).scope.kind, 'single-crate');
    }
  });
});

// The same, against a real workspace of two crates and the extraction engine's own record of its scope: the
// extraction lane's toy workspace (an app crate and a library crate it depends on). These need that lane's
// fake tools, so they run where its test helper is present and are skipped where it is not.
const MULTI_TOOLS = path.join(__dirname, 'helpers', 'fake-multicrate-tools.cjs');
const multi = fs.existsSync(MULTI_TOOLS) ? require(MULTI_TOOLS) : null;

describe('a real workspace of two crates', { skip: multi === null ? 'the extraction lane\'s multi-crate test tools are not in this tree' : false }, () => {
  const scopeOf = (out) => JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')).scope;
  const prepareIn = (ws, name, extra = []) => {
    const out = path.join(ws.root, 'copies', name);
    const prepared = multi.run(ws, ['prepare', '--project-root', ws.project, '--out', out, ...extra]);
    assert.equal(prepared.status, 0, prepared.stdout);
    return out;
  };
  // The workspace as a committed project with setup state, which is what record-extraction needs: the
  // Lean project files the stub profile accepts are laid next to the crates.
  function toyProject(behaviour = {}) {
    const ws = multi.workspace(behaviour);
    fs.cpSync(path.join(PROFILE_FIXTURES, 'fresh'), ws.project, { recursive: true });
    fixtures.git(ws.project, 'init', '-q');
    fixtures.git(ws.project, 'add', '-A');
    fixtures.git(ws.project, 'commit', '-q', '-m', 'workspace');
    init(ws.project);
    return ws;
  }

  it('prepared without a release folder has an unknown scope, no attempt is taken, and nothing records as a success', () => {
    const ws = toyProject();
    const out = prepareIn(ws, 'plain');
    assert.equal(scopeOf(out).kind, 'unknown', 'no inventory and no targets field: nothing establishes a single crate');
    for (const spec of [multi.toySpec(), { release: multi.RELEASE, cargoArgs: ['--locked'], crate: 'toy_lib', publishDir: 'Lean/Lib', moduleRoot: 'Toy.Lib' }]) {
      const attempt = multi.run(ws, ['attempt', '--out', out, '--spec', multi.specFile(ws, spec)]);
      assert.notEqual(attempt.status, 0, attempt.stdout);
      assert.match(attempt.stdout, /records no workspace inventory|never takes an unknown scope for a single crate/);
    }
    assert.throws(() => record(ws.project, out), refusedWith(/the scope of this extraction is not established \(.*Cargo\.toml files.*\), and an unknown scope is never read as a single crate/));
    const { extraction } = readState(ws.project);
    assert.equal(extraction.status, 'failed');
    assert.equal(extraction.scope.kind, 'unknown');
  });

  it('prepared with a release folder is several crates: no attempt, or one of one crate, is not recorded, and the attempt over both is', () => {
    const ws = toyProject();
    const out = prepareIn(ws, 'release', ['--release', multi.RELEASE]);
    assert.deepEqual(scopeOf(out), { kind: 'multi-crate', basis: 'cargo', libraryCrates: ['toy_app', 'toy_lib'] });
    assert.throws(() => record(ws.project, out), refusedWith(/the crates toy_app, toy_lib are in scope \(the copy's scope, .*\), but the copy holds no extraction attempt/));
    const single = multi.run(ws, ['attempt', '--out', out, '--spec', multi.specFile(ws, { release: multi.RELEASE, cargoArgs: ['--locked'], crate: 'toy_lib', publishDir: 'Lean/Lib', moduleRoot: 'Toy.Lib' })]);
    assert.notEqual(single.status, 0, 'the extraction engine takes no single-crate attempt on this scope');
    assert.equal(readState(ws.project).extraction.status, 'failed');

    const whole = multi.complete(ws, multi.toySpec());
    assert.equal(record(ws.project, whole).code, 'recorded');
    const { extraction } = readState(ws.project);
    assert.equal(extraction.status, 'succeeded');
    assert.equal(extraction.scope.kind, 'multi-crate');
    assert.deepEqual(extraction.run.units.map((unit) => unit.crate).sort(), ['toy_app', 'toy_lib']);
    assert.deepEqual(extraction.run.scope, extraction.scope, 'the attempt repeats the scope of the copy');
    assert.equal(fixtures.cli('read-state', '--project-root', ws.project).json.code, 'ok');
  });

  it('records a crates list of one with the other crate a non-target, and the state reads', () => {
    const ws = toyProject();
    const spec = multi.toySpec({ main: 'toy_lib', crates: [multi.toySpec().crates[0]], nonTargets: [{ crate: 'toy_app', dir: 'app' }] });
    const { out, recorded } = multi.attempted(ws, spec);
    assert.equal(recorded.status, 0, recorded.stdout);
    multi.completeUnit(ws, out, 'toy_lib');
    assert.equal(record(ws.project, out).code, 'recorded');
    const { extraction } = readState(ws.project);
    assert.equal(extraction.scope.kind, 'multi-crate');
    assert.deepEqual(extraction.run.units.map((unit) => unit.crate), ['toy_lib']);
    assert.deepEqual(extraction.run.roster.nonTargets.map((entry) => entry.crate), ['toy_app']);
    const read = fixtures.cli('read-state', '--project-root', ws.project);
    assert.equal(read.json.code, 'ok', read.stdout);
    assert.deepEqual(read.json.crates.targets, ['toy_lib']);
  });

  // The app crate's Lean holds an axiom for the library's function; the stitch replaces it by a checked
  // alias and the extraction records the Lean check that proves the alias, which a build-check receipt
  // must later reproduce exactly.
  const LEAN_HEADER = 'module\npublic import Aeneas\n@[expose] public section\nopen Aeneas Aeneas.Std Result\n';
  const LIBRARY_LEAN = `${LEAN_HEADER}namespace toy_lib\n\n/-- [toy_lib::one]:\n    Source: 'lib/src/lib.rs', lines 1:0-1:24\n    Visibility: public -/\ndef one : Result Std.U32 := ok 1#u32\n\nend toy_lib\n`;
  const APP_LEAN = `${LEAN_HEADER}namespace toy_app\n\n/-- [toy_lib::one]:\n    Source: 'lib/src/lib.rs', lines 1:0-1:24\n    Name pattern: [toy_lib::one]\n    Visibility: public -/\n@[rust_fun "toy_lib::one"]\naxiom toy_lib.one : Result Std.U32\n\n/-- [toy_app::three]:\n    Source: 'app/src/lib.rs', lines 1:0-1:50\n    Visibility: public -/\ndef three : Result Std.U32 := do\n  let x ← toy_lib.one\n  ok x\n\nend toy_app\n`;

  it('records the Lean checks of a stitch that replaced an alias with every field a receipt must match', () => {
    const ws = toyProject({ toy_lib: { lean: LIBRARY_LEAN }, toy_app: { lean: APP_LEAN } });
    const out = multi.complete(ws, multi.toySpec());
    assert.equal(record(ws.project, out).code, 'recorded');
    const { run } = readState(ws.project).extraction;
    const app = run.units.find((unit) => unit.crate === 'toy_app');
    assert.equal(app.stitch.flatMap((entry) => entry.replaced).length, 1, 'the stitch replaced the axiom of the library function');
    assert.equal(app.leanChecks.length, 1, 'a stitch that replaced an alias records the Lean check for it');
    const [check] = app.leanChecks;
    for (const key of ['file', 'relativePath', 'module', 'blockSha256', 'fileSha256']) assert.equal(typeof check[key], 'string', `leanChecks.${key}`);
    assert.equal(check.items, 1);
    assert.equal(check.relativePath, 'Lean/App/ToyApp.lean');
    assert.equal(run.units.find((unit) => unit.crate === 'toy_lib').leanChecks, undefined, 'the provider replaced nothing and records none');
  });
});

const backupsOf = (root) => fs.readdirSync(path.dirname(fixtures.stateFile(root))).filter((name) => name.endsWith('.bak')).sort();
const BACKUP_NAME = /^state\.json\.\d{4}-\d{2}-\d{2}T[\d-]+Z\.bak$/;

describe('an extraction record that no longer reads', () => {
  // A run that kept its roster but lost the rows of its crates: the extraction record no longer reads.
  const unreadable = (before) => ({ ...before, extraction: { ...before.extraction, run: { ...before.extraction.run, order: ['demo'], roster: { main: 'demo' }, rosterSha256: '1'.repeat(64) } } });

  it('is replaced by extracting again, and nothing else in the state is touched', () => {
    const root = project();
    init(root);
    const { out } = copyOf(root, { attempt: true });
    assert.equal(record(root, out).code, 'recorded');
    assert.deepEqual(backupsOf(root), [], 'an ordinary record keeps no backup');
    const before = readState(root);
    fixtures.writeState(root, unreadable(before));
    const unread = fixtures.cli('read-state', '--project-root', root);
    assert.equal(unread.json.code, 'malformed-state');
    assert.match(unread.json.nextStep, /rerun \/fvs:auto-extract/);
    assert.match(unread.json.nextStep, /kept beside it as .*state\.json\.<time>\.bak/);
    assert.deepEqual(backupsOf(root), [], 'reading the state keeps no backup');
    const result = record(root, out);
    assert.equal(result.code, 'recorded');
    const after = readState(root);
    assert.equal(after.extraction.status, 'succeeded');
    assert.deepEqual({ ...after, extraction: null }, { ...before, extraction: null });
    assert.match(result.message, /could not be read was replaced; the state file as it was is kept in /);
  });

  it('keeps the state file as it was in a timestamped backup beside it, and says where', () => {
    const root = project();
    init(root);
    const { out } = copyOf(root, { attempt: true });
    assert.equal(record(root, out).code, 'recorded');
    fixtures.writeState(root, unreadable(readState(root)));
    const bytes = fs.readFileSync(fixtures.stateFile(root));
    const result = record(root, out);
    const [name, ...others] = backupsOf(root);
    assert.deepEqual(others, [], 'one backup for the one replacement');
    assert.match(name, BACKUP_NAME);
    assert.equal(result.backup, path.join(path.dirname(fixtures.stateFile(root)), name));
    assert.ok(result.message.includes(result.backup), 'the message names the backup');
    assert.deepEqual(fs.readFileSync(result.backup), bytes, 'the backup holds the unreadable state byte for byte');
    assert.notDeepEqual(fs.readFileSync(fixtures.stateFile(root)), bytes);
    // Replacing a record that now reads, as an ordinary rerun does, keeps no further backup.
    assert.equal(record(root, out).code, 'recorded');
    assert.deepEqual(backupsOf(root), [name]);
    assert.equal(record(root, out).backup, undefined);
  });

  it('keeps the backup also when the extraction recorded in its place failed', () => {
    const root = project();
    init(root);
    const { out } = copyOf(root, { attempt: true });
    assert.equal(record(root, out).code, 'recorded');
    fixtures.writeState(root, unreadable(readState(root)));
    const bytes = fs.readFileSync(fixtures.stateFile(root));
    const { out: unfinished } = copyOf(root, { attempt: false, scope: SEVERAL });
    assert.throws(() => record(root, unfinished), (error) => error.code === 'extraction-failed'
      && BACKUP_NAME.test(path.basename(error.details.backup)) && error.message.includes(error.details.backup));
    assert.equal(readState(root).extraction.status, 'failed');
    assert.deepEqual(fs.readFileSync(path.join(path.dirname(fixtures.stateFile(root)), backupsOf(root)[0])), bytes);
  });

  it('is recorded again when it has no scope, as a record made before the scope was kept has none', () => {
    const root = project();
    init(root);
    const { out } = copyOf(root, { attempt: true });
    assert.equal(record(root, out).code, 'recorded');
    const state = readState(root);
    delete state.extraction.scope;
    fixtures.writeState(root, state);
    const held = fixtures.cli('read-state', '--project-root', root);
    assert.equal(held.json.phase, 'extract', 'a record that keeps no scope is not moved past');
    assert.match(held.json.nextAction, /^Rerun \/fvs:auto-extract: the recorded extraction does not say whether it is of a single crate or of several/);
    assert.equal(record(root, out).code, 'recorded');
    assert.notEqual(fixtures.cli('read-state', '--project-root', root).json.phase, 'extract');
    assert.deepEqual(backupsOf(root), [], 'a record that reads is replaced as before, with no backup');
  });

  it('is not replaced when the state has another fault', () => {
    const root = project();
    init(root);
    const { out } = copyOf(root, { attempt: true });
    assert.equal(record(root, out).code, 'recorded');
    const state = readState(root);
    state.extraction.run.units = [];
    state.choices = null;
    fixtures.writeState(root, state);
    const bytes = fs.readFileSync(fixtures.stateFile(root));
    assert.throws(() => record(root, out), (error) => error.code === 'malformed-state' && !/rerun \/fvs:auto-extract/.test(error.details.nextStep));
    assert.deepEqual(fs.readFileSync(fixtures.stateFile(root)), bytes, 'the state file is left as it was');
    assert.deepEqual(backupsOf(root), []);
  });
});

describe('the crates in scope', () => {
  it('are those the agreement names, targets and non-targets, and the in-repo library crates of the workspace', () => {
    assert.deepEqual(auto.declaredCrates({ targets: { crates: ['b', 'a'], nonTargets: [{ crate: 'c', decision: 'x' }] } }), ['a', 'b', 'c']);
    const manifest = { workspace: { original: { crates: [{ crate: 'x', library: true }, { crate: 'y', library: false }, { crate: 'z', library: true }] } } };
    assert.deepEqual(auto.declaredCrates({ manifest }), ['x', 'z'], 'a crate with no library is not a verification target');
    assert.deepEqual(auto.declaredCrates({ manifest, targets: { crates: ['x'], nonTargets: [] } }), ['x', 'z']);
    assert.deepEqual(auto.declaredCrates({ manifest: { projectRoot: '/somewhere' } }), [], 'a copy prepared without an inventory names none');
    assert.deepEqual(auto.declaredCrates(), []);
  });
});
