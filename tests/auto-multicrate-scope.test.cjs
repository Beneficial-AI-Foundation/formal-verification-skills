'use strict';

// What record-extraction does when the scope is several crates. The extraction of a copy that holds no
// attempt, or the attempt of one crate only, is never read as "nothing else to verify": when the
// owner's agreement names several crates, or the workspace holds several, only a completed attempt over
// all of them is recorded. A project with one crate records as before. The copies are prepared and
// attempted with the fake extraction tools; no Charon, Aeneas or Lean runs.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fixtures = require('./helpers/multicrate-fixtures.cjs');
const { fakeTools, engine, writeSpec } = require('./helpers/fake-extraction-tools.cjs');

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

// A prepared copy of the project; with `attempt` the fake tools also ran the attempt of its one crate.
function copyOf(root, { attempt }) {
  const tools = fakeTools(root, fixtures.temporaryDirectory('fvs-scope-tools-'));
  const out = path.join(fixtures.temporaryDirectory('fvs-scope-out-'), 'copy');
  const prepare = spawnSync(process.execPath, [ENGINE, 'prepare', '--project-root', root, '--out', out], { encoding: 'utf8' });
  assert.equal(prepare.status, 0, prepare.stdout);
  if (attempt) {
    const started = engine(tools, ['attempt', '--out', out, '--spec', writeSpec(path.join(tools.scratch, 'spec.json'))]);
    assert.equal(started.status, 0, started.stdout);
    for (const step of ['charon', 'aeneas', 'publish']) assert.equal(engine(tools, ['run', '--out', out, '--step', step]).status, 0, step);
  }
  return out;
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
    const out = copyOf(root, { attempt: false });
    assert.throws(() => record(root, out), refusedWith(/the crates demo, other are in scope .* the copy holds no extraction attempt/));
    const { extraction } = readState(root);
    assert.equal(extraction.status, 'failed');
    assert.equal('run' in extraction, false);
  });

  it('refuses the attempt of one crate when the agreement names several', () => {
    const root = project();
    init(root);
    assert.equal(recordAgreement(root, agreementFor(root, { targets: { crates: ['demo'], nonTargets: [{ crate: 'other', decision: 'Not verified; assumed.' }] } })).code, 'recorded');
    const out = copyOf(root, { attempt: true });
    assert.throws(() => record(root, out), refusedWith(/the crates demo, other are in scope .* the copy holds the attempt of one crate only/));
    assert.equal(readState(root).extraction.status, 'failed');
  });

  it('records the same copy when the agreement names one crate, or none', () => {
    for (const targets of [{ crates: ['demo'], nonTargets: [] }, null]) {
      const root = project();
      init(root);
      if (targets) assert.equal(recordAgreement(root, agreementFor(root, { targets })).code, 'recorded');
      assert.equal(record(root, copyOf(root, { attempt: true })).code, 'recorded');
      assert.equal(readState(root).extraction.status, 'succeeded');
    }
  });

  it('records a copy with no attempt when nothing names several crates, as a project with one crate always did', () => {
    const root = project();
    init(root);
    assert.equal(record(root, copyOf(root, { attempt: false })).code, 'recorded');
  });
});

describe('an extraction record that no longer reads', () => {
  it('is replaced by extracting again, and nothing else in the state is touched', () => {
    const root = project();
    init(root);
    const out = copyOf(root, { attempt: true });
    assert.equal(record(root, out).code, 'recorded');
    const before = readState(root);
    // A run that kept its roster but lost the rows of its crates: the state does not read.
    const broken = { ...before, extraction: { ...before.extraction, run: { ...before.extraction.run, order: ['demo'], roster: { main: 'demo' }, rosterSha256: '1'.repeat(64) } } };
    fixtures.writeState(root, broken);
    const unread = fixtures.cli('read-state', '--project-root', root);
    assert.equal(unread.json.code, 'malformed-state');
    assert.match(unread.json.nextStep, /rerun \/fvs:auto-extract/);
    assert.equal(record(root, out).code, 'recorded');
    const after = readState(root);
    assert.equal(after.extraction.status, 'succeeded');
    assert.deepEqual({ ...after, extraction: null }, { ...before, extraction: null });
  });

  it('is not replaced when the state has another fault', () => {
    const root = project();
    init(root);
    const out = copyOf(root, { attempt: true });
    assert.equal(record(root, out).code, 'recorded');
    const state = readState(root);
    state.extraction.run.units = [];
    state.choices = null;
    fixtures.writeState(root, state);
    assert.throws(() => record(root, out), (error) => error.code === 'malformed-state' && !/rerun \/fvs:auto-extract/.test(error.details.nextStep));
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
