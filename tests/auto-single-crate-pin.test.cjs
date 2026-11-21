'use strict';

// Pins the recorded shapes of a single-crate auto-track run in
// scripts/fvs-auto.mjs, so that supporting several verification targets in one
// repository cannot change what a project with one target records or reads.
// Key sets of the records the engine owns are exact; `extraction.run` comes from
// the extraction engine, so only the keys the engine reads are required.
// Every project is a temporary git fixture; no Charon, Aeneas or Lean runs.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { fakeTools, engine, writeSpec, recordScope } = require('./helpers/fake-extraction-tools.cjs');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'fvs-auto.mjs');
const ENGINE = path.join(ROOT, 'scripts', 'fvs-extract-patches.mjs');
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

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, '-c', 'user.name=fvs', '-c', 'user.email=fvs@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

// A committed single-crate Lean project that the stub profile accepts.
function project() {
  const root = temporaryDirectory('fvs-single-crate-');
  fs.cpSync(CRATE, root, { recursive: true });
  fs.cpSync(path.join(PROFILE_FIXTURES, 'fresh'), root, { recursive: true });
  // An extraction attempt needs the lock the build would otherwise write into the copy.
  fs.writeFileSync(path.join(root, 'Cargo.lock'), 'version = 3\n');
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture');
  return root;
}

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

function init(root) {
  return withStubs(() => auto.initState({ projectRoot: root, platform: 'aarch64-apple-darwin',
    choices: { source: { revision: 'HEAD', configuration: 'default features' }, scope: 'the portable NTT module only', limits: { wallClockHours: 40 } } }));
}

// A completed fake extraction attempt on a prepared copy of the project.
function attempted(root) {
  const tools = fakeTools(root, temporaryDirectory('fvs-single-crate-tools-'));
  const out = path.join(temporaryDirectory('fvs-single-crate-out-'), 'copy');
  const prepare = spawnSync(process.execPath, [ENGINE, 'prepare', '--project-root', root, '--out', out], { encoding: 'utf8' });
  assert.equal(prepare.status, 0, prepare.stdout);
  recordScope(out);
  const started = engine(tools, ['attempt', '--out', out, '--spec', writeSpec(path.join(tools.scratch, 'spec.json'))]);
  assert.equal(started.status, 0, started.stdout);
  for (const step of ['charon', 'aeneas', 'publish']) assert.equal(engine(tools, ['run', '--out', out, '--step', step]).status, 0, step);
  return out;
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

const keys = (value) => Object.keys(value).sort();
const stateFile = (root) => path.join(root, '.formalising', 'auto-fv', 'state.json');
const specsFile = (root) => path.join(root, '.formalising', 'auto-fv', 'specs.json');

const READ_STATE_KEYS = ['code', 'command', 'externals', 'fvs', 'message', 'nextAction', 'ok', 'pendingDecisions',
  'phase', 'readiness', 'roadmapPresent', 'state', 'warnings'];
const BRIEF_KEYS = ['brief', 'code', 'command', 'externals', 'fvs', 'message', 'nextAction', 'ok', 'pendingDecisions',
  'phase', 'warnings'];
const STATE_KEYS = ['choices', 'extraction', 'profile', 'profiledAt', 'roadmap', 'schema', 'schemaVersion'];
// `scope` is the one field the record of a single crate gained: the scope the copy recorded when it was prepared, so that
// a single crate is established and never inferred from what is missing.
const EXTRACTION_KEYS = ['checks', 'declared', 'inputs', 'note', 'reasons', 'recordedAt', 'run', 'scope', 'selected', 'status'];
const INPUTS_KEYS = ['crateRoot', 'manifestSha256', 'mode', 'out', 'patches', 'sourceCommit'];
// What the engine reads from the extraction engine's run record.
const RUN_REQUIRED_KEYS = ['attemptSha256', 'config', 'configSha256', 'llbc', 'manifestSha256', 'publication', 'residuals',
  'stages', 'supported', 'translation', 'trust'];

describe('a single-crate run records and reads what it always did', () => {
  it('a fresh project reads as the extract phase with the closed state shape', () => {
    const root = project();
    assert.equal(init(root).code, 'created');
    const full = cli('read-state', '--project-root', root);
    assert.equal(full.status, 0, full.stdout);
    assert.deepEqual(keys(full.json), READ_STATE_KEYS);
    assert.equal(full.json.phase, 'extract');
    assert.deepEqual(keys(full.json.state), STATE_KEYS);
    assert.equal(full.json.state.extraction, null, 'no extraction is recorded yet');
    assert.deepEqual(keys(cli('read-state', '--project-root', root, '--brief').json), BRIEF_KEYS);
    assert.deepEqual(fs.readdirSync(path.dirname(stateFile(root))).sort(), ['state.json'],
      'setup writes the state file and nothing else');
  });

  it('a succeeded extraction is one record, with no per-crate part, and moves the phase to specs', () => {
    const root = project();
    init(root);
    const out = attempted(root);
    const recorded = withStubs(() => auto.recordExtraction({ projectRoot: root, out, buildExitCode: 0, oracle: 'complete' }));
    assert.equal(recorded.code, 'recorded', JSON.stringify(recorded));
    assert.deepEqual(keys(recorded), ['code', 'extraction', 'message']);

    const read = cli('read-state', '--project-root', root);
    assert.deepEqual(keys(read.json), READ_STATE_KEYS);
    assert.equal(read.json.phase, 'specs');
    assert.match(read.json.nextAction, /^Run \/fvs:auto-top-specs from the orchestrator session for the spec phase/);
    assert.deepEqual(keys(read.json.state), STATE_KEYS);

    const { extraction } = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
    assert.deepEqual(keys(extraction), EXTRACTION_KEYS);
    assert.equal(extraction.status, 'succeeded');
    assert.equal(extraction.scope.kind, 'single-crate');
    assert.deepEqual(extraction.reasons, []);
    assert.deepEqual(keys(extraction.inputs), INPUTS_KEYS);
    for (const key of RUN_REQUIRED_KEYS) assert.ok(key in extraction.run, `extraction.run.${key}`);
    assert.equal(extraction.run.supported, true);
    assert.equal(extraction.run.manifestSha256, extraction.inputs.manifestSha256);
    // The extraction may also record the translation's path relative to the project; that field is optional.
    assert.deepEqual(keys(extraction.run.translation).filter((key) => key !== 'relativePath'), ['attemptPath', 'projectPath', 'sha256']);
    assert.deepEqual(keys(extraction.run.llbc), ['path', 'sha256']);
    assert.equal(extraction.run.translation.projectPath, path.join(root, 'Demo', 'translation.json'));
    assert.equal('targets' in extraction, false, 'no target list without a declared set of targets');
  });

  it('an extraction whose build fails is recorded failed, with its reasons, in the same shape', () => {
    const root = project();
    init(root);
    const out = attempted(root);
    assert.throws(() => withStubs(() => auto.recordExtraction({ projectRoot: root, out, buildExitCode: 1, oracle: 'complete' })),
      (error) => error instanceof auto.Refusal && error.code === 'extraction-failed' && /the build exited 1/.test(error.message));
    const { extraction } = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
    assert.deepEqual(keys(extraction), EXTRACTION_KEYS);
    assert.equal(extraction.status, 'failed');
    assert.ok(extraction.reasons.length > 0, 'a failed extraction says why');
    assert.equal(cli('read-state', '--project-root', root).json.phase, 'extract', 'a failed extraction stays in the extract phase');
  });

  it('spec rounds, the draft spec pull request and its merge keep their rows and phases', () => {
    const root = project();
    init(root);
    const out = attempted(root);
    assert.equal(withStubs(() => auto.recordExtraction({ projectRoot: root, out, buildExitCode: 0, oracle: 'complete' })).code, 'recorded');
    fs.mkdirSync(path.join(root, 'formal', 'specs', 'Specs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'formal/specs/Specs/Demo.lean'), 'recall demo_spec\n');
    fs.writeFileSync(path.join(root, 'review.md'), 'pass\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'spec');

    const round = cli('record-spec', '--project-root', root, '--spec-file', 'formal/specs/Specs/Demo.lean',
      '--items', 'demo::double', '--round', '1', '--verdict', 'pass', '--review', 'review.md');
    assert.equal(round.status, 0, round.stdout);
    assert.deepEqual(keys(round.json), ['code', 'command', 'message', 'ok', 'row', 'warnings']);
    assert.deepEqual(keys(round.json.row), ['items', 'outOfScope', 'recordedAt', 'review', 'reviewSha256', 'round', 'specFile',
      'specSha256', 'verdict']);
    assert.deepEqual(round.json.row.items, ['demo::double'], 'an item is its Rust path, with no crate qualifier added');

    const status = cli('spec-status', '--project-root', root);
    assert.deepEqual(keys(status.json), ['blocked', 'code', 'command', 'message', 'ok', 'readyForPr', 'specFiles']);
    assert.deepEqual(keys(status.json.specFiles[0]), ['items', 'label', 'missing', 'outOfScope', 'ownerChange', 'review', 'round',
      'rounds', 'specFile', 'stale', 'verdict']);
    assert.equal(status.json.readyForPr, true);

    const opened = cli('record-pr', '--project-root', root, '--kind', 'spec', '--url', 'https://example.invalid/pr/1',
      '--branch', 'specs', '--head', 'HEAD');
    assert.equal(opened.status, 0, opened.stdout);
    assert.deepEqual(keys(opened.json), ['code', 'command', 'message', 'ok', 'pr', 'warnings']);
    assert.deepEqual(opened.json.warnings, []);
    assert.deepEqual(keys(opened.json.pr), ['branch', 'head', 'kind', 'recordedAt', 'url']);
    assert.equal(cli('read-state', '--project-root', root).json.phase, 'specs');

    const merged = cli('record-pr', '--project-root', root, '--kind', 'spec', '--merged', '--merge-commit', 'HEAD');
    assert.equal(merged.status, 0, merged.stdout);
    assert.deepEqual(keys(merged.json.pr), ['kind', 'mergeCommit', 'merged', 'ownerChanges', 'recordedAt', 'url']);
    assert.equal(cli('read-state', '--project-root', root).json.phase, 'proofs');

    const specs = JSON.parse(fs.readFileSync(specsFile(root), 'utf8'));
    assert.deepEqual(keys(specs), ['prs', 'schema', 'schemaVersion', 'specs']);
    assert.equal(specs.schemaVersion, 1);
    assert.equal(specs.specs.length, 1);
    assert.equal(specs.prs.length, 2);
    assert.deepEqual(fs.readdirSync(path.dirname(stateFile(root))).sort(), ['specs.json', 'state.json'],
      'no record file appears beyond the state and the spec rounds');
  });
});
