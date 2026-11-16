'use strict';

// The auto track's milestone 1 state operations in scripts/fvs-auto.mjs:
// setup state written by auto-init, the roadmap decision, the extraction
// record and the externals record. Every project here is a temporary fixture;
// no Charon, Aeneas or Lean runs, and no fixture is a real extraction.

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
const ENGINE = path.join(ROOT, 'scripts', 'fvs-extract-patches.mjs');
const PROFILE_FIXTURES = path.join(__dirname, 'fixtures', 'auto-profile');
const BIN = path.join(PROFILE_FIXTURES, 'bin');
const CRATE = path.join(__dirname, 'fixtures', 'extract-patches', 'crate');
const PATCHES = path.join(__dirname, 'fixtures', 'extract-patches', 'patches');
const PLATFORM = 'aarch64-apple-darwin';
const TMP = fs.realpathSync(os.tmpdir());
const temporaryDirectories = [];
let auto = null;

before(async () => {
  auto = await import(pathToFileURL(SCRIPT).href);
});

after(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix = 'fvs-auto-state-') {
  const directory = fs.mkdtempSync(path.join(TMP, prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// The stub tools of the profile tests as the only tools on PATH, so the
// recorded profile does not depend on what the test machine has installed.
function withStubs(bin, fn) {
  const environment = {
    HOME: path.join(PROFILE_FIXTURES, 'home'),
    PATH: [bin, '/usr/bin', '/bin'].join(path.delimiter),
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

function binWithout(...absent) {
  const bin = temporaryDirectory('fvs-auto-bin-');
  for (const name of fs.readdirSync(BIN).filter((entry) => !absent.includes(entry))) {
    fs.symlinkSync(path.join(BIN, name), path.join(bin, name));
  }
  return bin;
}

// A git checkout of the extraction fixture crate that is also a Lean project
// the stub profile accepts (the profile tests' fresh fixture), committed once.
function project() {
  const root = temporaryDirectory('fvs-auto-project-');
  fs.cpSync(CRATE, root, { recursive: true });
  fs.cpSync(path.join(PROFILE_FIXTURES, 'fresh'), root, { recursive: true });
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture');
  return root;
}

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, '-c', 'user.name=fvs', '-c', 'user.email=fvs@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const CHOICES = {
  source: { revision: 'HEAD', configuration: 'default features' },
  scope: 'the portable NTT module only',
  limits: { wallClockHours: 40 },
};

function run(fn, bin = BIN) {
  try {
    return withStubs(bin, fn);
  } catch (error) {
    if (error instanceof auto.Refusal) return { ok: false, code: error.code, message: error.message, ...error.details };
    throw error;
  }
}

function init(root, choices = CHOICES, { bin = BIN, ...options } = {}) {
  return run(() => auto.initState({ projectRoot: root, choices, platform: PLATFORM, ...options }), bin);
}

function cli(...args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    // left null: the assertion on json shows the raw output
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

function stateFile(root) {
  return path.join(root, '.formalising', 'auto-fv', 'state.json');
}

function externalsFile(root) {
  return path.join(root, '.formalising', 'auto-fv', 'externals.json');
}

describe('auto-init setup state', () => {
  it('a fresh init writes the profile, the owner choices and the default limits', () => {
    const root = project();
    const result = init(root);
    assert.equal(result.code, 'created');
    const state = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
    assert.equal(state.schema, 'fvs/auto-state');
    assert.equal(state.schemaVersion, 1);
    assert.equal(state.profile.schema, 'fvs/auto-profile');
    assert.deepEqual(state.profile.items.map((item) => item.id), ['host', 'ao', 'rust', 'lean', 'aeneas', 'probe']);
    assert.deepEqual(state.choices.source, CHOICES.source);
    assert.equal(state.choices.scope, CHOICES.scope);
    assert.deepEqual(state.choices.limits, { nodeHours: 2, workers: 3, wallClockHours: 40 });
    assert.equal(state.roadmap, null);
    assert.equal(state.extraction, null);
    assert.deepEqual(fs.readdirSync(path.dirname(stateFile(root))), ['state.json'], 'no temporary file is left behind');
  });

  it('a rerun with the same choices reports the recorded state and writes nothing', () => {
    const root = project();
    init(root);
    const before = fs.readFileSync(stateFile(root));
    const mtime = fs.statSync(stateFile(root)).mtimeMs;
    const result = init(root, structuredClone(CHOICES));
    assert.equal(result.code, 'unchanged');
    assert.deepEqual(result.state.choices.limits, { nodeHours: 2, workers: 3, wallClockHours: 40 });
    assert.deepEqual(fs.readFileSync(stateFile(root)), before);
    assert.equal(fs.statSync(stateFile(root)).mtimeMs, mtime);
  });

  it('a changed owner choice asks before overwriting and names every change', () => {
    const root = project();
    init(root);
    const before = fs.readFileSync(stateFile(root));
    const changed = { ...CHOICES, limits: { wallClockHours: 40, workers: 5 } };
    const refused = init(root, changed);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'confirmation-required');
    assert.deepEqual(refused.changes, [{ field: 'limits.workers', recorded: 3, requested: 5 }]);
    assert.deepEqual(fs.readFileSync(stateFile(root)), before, 'nothing is overwritten without confirmation');
    const confirmed = init(root, changed, { confirmOverwrite: true });
    assert.equal(confirmed.code, 'updated');
    assert.equal(JSON.parse(fs.readFileSync(stateFile(root), 'utf8')).choices.limits.workers, 5);
  });

  it('a confirmed overwrite keeps the roadmap decision and the extraction record', () => {
    const root = project();
    init(root);
    auto.recordRoadmap({ projectRoot: root, decision: 'declined' });
    const { out } = prepared(root);
    assert.equal(record(root, out, 0).code, 'recorded');
    init(root, { ...CHOICES, scope: 'two modules' }, { confirmOverwrite: true });
    const state = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
    assert.equal(state.roadmap.decision, 'declined');
    assert.equal(state.extraction.status, 'succeeded');
    assert.match(auto.readState({ projectRoot: root }).nextAction, /\/fvs:auto-top-specs/, 'a scope change keeps the extraction current');
  });

  it('a confirmed change of the source keeps the old extraction but asks for a new one', () => {
    const root = project();
    init(root);
    const { out } = prepared(root);
    record(root, out, 0);
    init(root, { ...CHOICES, source: { revision: 'HEAD', configuration: 'feature simd' } }, { confirmOverwrite: true });
    const read = auto.readState({ projectRoot: root });
    assert.equal(read.state.extraction.status, 'succeeded', 'the history is kept');
    assert.deepEqual(read.state.extraction.selected, CHOICES.source);
    assert.match(read.nextAction, /\/fvs:auto-extract.*default features/);
  });

  it('new choices with no selected budget use v2 defaults without phantom legacy hours', () => {
    const root=project(),result=init(root,{source:CHOICES.source,scope:CHOICES.scope,limits:{}});
    assert.equal(result.code,'created');const state=JSON.parse(fs.readFileSync(stateFile(root),'utf8'));
    assert.equal(state.schemaVersion,2);assert.deepEqual(state.choices.limits,{workers:3});
    assert.deepEqual(state.choices.budget,{kind:'none'});assert.deepEqual(state.choices.memory,{mode:'disabled'});
  });

  it('missing or invalid choices are refused before anything is written', () => {
    const root = project();
    for (const choices of [
      { ...CHOICES, limits: { nodeHours: 2, workers: 3 } },
      { ...CHOICES, limits: { wallClockHours: 0 } },
      { ...CHOICES, limits: { wallClockHours: 10, workers: 1.5 } },
      { ...CHOICES, source: { revision: '', configuration: 'x' } },
      { ...CHOICES, scope: '  ' },
      { ...CHOICES, extra: true },
    ]) {
      const result = init(root, choices);
      assert.equal(result.code, 'invalid-input', JSON.stringify(choices));
    }
    assert.equal(fs.existsSync(stateFile(root)), false);
  });

  it('a host without the ao CLI stops with the profile next step and writes nothing', () => {
    const root = project();
    const result = init(root, CHOICES, { bin: binWithout('ao') });
    assert.equal(result.code, 'profile-blocked');
    assert.deepEqual(result.blocking.map((item) => item.id), ['ao']);
    assert.match(result.blocking[0].nextStep, /Install Agent Orchestrator/);
    assert.equal(fs.existsSync(stateFile(root)), false);
  });

  it('an incompatible or missing toolchain stops with each item next step', () => {
    const root = project();
    fs.rmSync(path.join(root, 'lean-toolchain'));
    const result = init(root);
    assert.equal(result.code, 'profile-blocked');
    assert.deepEqual(result.blocking.map((item) => [item.id, item.verdict]), [['lean', 'missing']]);
    assert.ok(result.blocking[0].nextStep);
  });

  it('a root with no Lean project names the one subfolder that holds it, and writes nothing', () => {
    const repo = temporaryDirectory('fvs-auto-layout-');
    fs.cpSync(CRATE, repo, { recursive: true });
    fs.cpSync(path.join(PROFILE_FIXTURES, 'fresh'), path.join(repo, 'formal'), { recursive: true });
    const files = () => fs.readdirSync(repo, { recursive: true }).sort();
    const before = files();
    const leanOf = () => run(() => auto.profile({ projectRoot: repo, platform: PLATFORM })).items.find((entry) => entry.id === 'lean');

    const lean = leanOf();
    assert.equal(lean.verdict, 'missing');
    assert.match(lean.reason, /the Lean project is in formal\//);
    assert.match(lean.nextStep, /^Rerun with the project root at formal\//);
    assert.doesNotMatch(lean.nextStep, /Add a lean-toolchain/);

    const blocked = init(repo);
    assert.equal(blocked.code, 'profile-blocked');
    assert.deepEqual(blocked.blocking.map((entry) => entry.id), ['lean', 'aeneas']);
    assert.match(blocked.message, /the Lean project is in formal\/, so rerun with the project root at formal\//);
    assert.match(blocked.nextStep, /project root at formal\//);
    assert.doesNotMatch(blocked.nextStep, /Add a lean-toolchain|Require the Aeneas/);
    assert.deepEqual(files(), before, 'no toolchain, state or other file is written into the project');

    // Two candidate folders name neither: the existing step stays.
    fs.cpSync(path.join(PROFILE_FIXTURES, 'fresh'), path.join(repo, 'other'), { recursive: true });
    assert.match(leanOf().nextStep, /Add a lean-toolchain/);
    fs.rmSync(path.join(repo, 'other'), { recursive: true });

    assert.equal(init(path.join(repo, 'formal')).code, 'created', 'the named root is accepted');
  });

  it('a missing probe never stops auto-init, and an unsupported host stops only for its own missing tools', () => {
    const root = project();
    const result = init(root, CHOICES, { bin: binWithout('probe-aeneas', 'probe-rust') });
    assert.equal(result.code, 'created', JSON.stringify(result.blocking ?? result.message));
    assert.ok(fs.existsSync(stateFile(root)));
    // This fixture ships Aeneas binaries for macOS arm64 only; host and probe never block.
    const windows = init(project(), CHOICES, { platform: 'x86_64-pc-windows-msvc' });
    assert.equal(windows.code, 'profile-blocked');
    assert.deepEqual(windows.blocking.map((entry) => [entry.id, entry.verdict]), [['aeneas', 'missing']]);
  });

  it('malformed state is an actionable failure, never a crash or an overwrite', () => {
    const root = project();
    fs.mkdirSync(path.dirname(stateFile(root)), { recursive: true });
    fs.writeFileSync(stateFile(root), '{"schema": "fvs/auto-state",');
    const result = init(root, CHOICES, { confirmOverwrite: true });
    assert.equal(result.code, 'malformed-state');
    assert.match(result.message, /state\.json/);
    assert.match(result.nextStep, /move it aside/);
    assert.equal(fs.readFileSync(stateFile(root), 'utf8'), '{"schema": "fvs/auto-state",');

    const viaCli = cli('read-state', '--project-root', root);
    assert.equal(viaCli.status, 3);
    assert.equal(viaCli.json.code, 'malformed-state');
    assert.doesNotMatch(viaCli.stderr, /at .*fvs-auto\.mjs/, 'no stack trace');
  });

  it('state with a valid shape but wrong content is malformed too', () => {
    const root = project();
    init(root);
    const state = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
    state.choices.limits.workers = -1;
    fs.writeFileSync(stateFile(root), JSON.stringify(state));
    const result = cli('read-state', '--project-root', root);
    assert.equal(result.json.code, 'malformed-state');
    assert.match(result.json.message, /limits\.workers/);
  });

  it('read-state names the next action, and reports no state on a fresh project', () => {
    const root = project();
    const none = cli('read-state', '--project-root', root);
    assert.equal(none.status, 0);
    assert.equal(none.json.code, 'no-state');
    assert.match(none.json.nextAction, /\/fvs:auto-init/);
    assert.equal(none.json.phase, 'setup');
    assert.deepEqual(none.json.warnings, []);
    init(root);
    const recorded = cli('read-state', '--project-root', root);
    assert.equal(recorded.json.code, 'ok');
    assert.match(recorded.json.nextAction, /\/fvs:auto-extract/);
    assert.equal(recorded.json.phase, 'extract');
    assert.deepEqual(recorded.json.pendingDecisions, ['roadmap']);
  });
});

describe('auto-init roadmap offer', () => {
  it('a fresh init reports the roadmap offer as pending in its own result', () => {
    const root = project();
    const created = init(root);
    assert.equal(created.code, 'created');
    assert.deepEqual(created.pendingDecisions, ['roadmap']);
    assert.match(created.nextAction, /\/fvs:auto-extract/);
    auto.recordRoadmap({ projectRoot: root, decision: 'declined' });
    assert.deepEqual(init(root).pendingDecisions, [], 'an unchanged rerun after a decline offers nothing');
  });

  it('a decline is recorded once and is not a pending decision on rerun', () => {
    const root = project();
    init(root);
    assert.equal(auto.recordRoadmap({ projectRoot: root, decision: 'declined' }).code, 'recorded');
    assert.equal(auto.recordRoadmap({ projectRoot: root, decision: 'declined' }).code, 'unchanged');
    const state = auto.readState({ projectRoot: root });
    assert.deepEqual(state.pendingDecisions, []);
    assert.equal(state.state.roadmap.path, null);
  });

  it('changing a recorded decision needs the owner confirmation', () => {
    const root = project();
    init(root);
    auto.recordRoadmap({ projectRoot: root, decision: 'declined' });
    const refused = run(() => auto.recordRoadmap({ projectRoot: root, decision: 'accepted' }));
    assert.equal(refused.code, 'confirmation-required');
    const accepted = auto.recordRoadmap({ projectRoot: root, decision: 'accepted', confirmOverwrite: true });
    assert.equal(accepted.code, 'recorded');
    assert.equal(accepted.state.roadmap.path, '.formalising/auto-fv/ROADMAP.md');
    assert.equal(auto.readState({ projectRoot: root }).roadmapPresent, false, 'acceptance alone writes no roadmap');
  });

  it('the roadmap decision never gates extraction', () => {
    const root = project();
    init(root);
    assert.match(auto.readState({ projectRoot: root }).nextAction, /\/fvs:auto-extract/);
  });
});

// A prepared extraction copy made by the real patch engine from the project.
function prepared(root, patches = ['lib-double']) {
  if (patches.length > 0) {
    const directory = path.join(root, 'translation-patches');
    fs.mkdirSync(directory, { recursive: true });
    for (const name of patches) fs.copyFileSync(path.join(PATCHES, `${name}.patch`), path.join(directory, `${name}.patch`));
    fs.writeFileSync(path.join(directory, 'series'), `${patches.map((name) => `${name}.patch`).join('\n')}\n`);
    git(root, 'add', 'translation-patches');
    git(root, 'commit', '-q', '-m', 'patches');
  }
  const out = path.join(temporaryDirectory('fvs-auto-out-'), 'copy');
  const result = spawnSync(process.execPath, [ENGINE, 'prepare', '--project-root', root, '--out', out], { encoding: 'utf8' });
  return { out, status: result.status };
}

// `oracle` is the shared extractor's final success-oracle verdict from its run-end summary.
function record(root, out, buildExitCode, oracle = 'complete', oracleReason = undefined) {
  return run(() => auto.recordExtraction({ projectRoot: root, out, buildExitCode, oracle, oracleReason }));
}

describe('auto-extract extraction record: recorded extraction attempt', () => {
  const { fakeTools, engine, writeSpec } = require('./helpers/fake-extraction-tools.cjs');

  // A completed attempt (fake Charon and Aeneas) on a prepared copy of the project.
  function attempted(root) {
    const tools = fakeTools(root, temporaryDirectory('fvs-auto-tools-'));
    const { out, status } = prepared(root, []);
    assert.equal(status, 0);
    const recorded = engine(tools, ['attempt', '--out', out, '--spec', writeSpec(path.join(tools.scratch, 'spec.json'))]);
    assert.equal(recorded.status, 0, recorded.stdout);
    for (const step of ['charon', 'aeneas', 'publish']) assert.equal(engine(tools, ['run', '--out', out, '--step', step]).status, 0, step);
    return out;
  }

  it('attaches the re-validated attempt to a successful extraction record, and the state still reads', () => {
    const root = project();
    init(root);
    const agreement = {
      schema: 'fvs/auto-agreement', schemaVersion: 1, mode: 'nonpublic-intent',
      payload: { choicesGeneration: 0, choices: auto.readState({ projectRoot: root }).state.choices,
        contextVersion: 1, boundaries: [], conventions: [], layout: 'single-crate', claims: ['fixture'],
        trust: ['fixture policy'], acceptance: ['fixture evidence'], ownerReserved: ['human final decision'],
        execution: null, draftPr: null },
      ownerEvidence: { reference: 'fixture:response', response: 'Fixture initial agreement only' },
    };
    agreement.approvedPayloadSha256 = auto.agreementPayloadSha256(agreement);
    fs.writeFileSync(path.join(root, '.formalising/auto-fv/ROADMAP.md'),
      '## Decisions\n```fvs-auto-agreement\n' + JSON.stringify(agreement) + '\n```\n');
    auto.recordAgreement({ projectRoot: root, agreement });
    const history = auto.readState({ projectRoot: root }).state.agreements;
    const { fakeStore } = require('./helpers/memory-fixture.cjs');
    auto.recordMemory({ projectRoot: root, registration: fakeStore(root) });
    const memoryBindings = auto.readState({ projectRoot: root }).state.memoryBindings;
    const out = attempted(root);
    const result = record(root, out, 0);
    assert.equal(result.code, 'recorded', JSON.stringify(result));
    const preserved = auto.readState({ projectRoot: root }).state;
    assert.deepEqual(preserved.agreements, history, 'record-extraction preserves the optional agreement history');
    assert.deepEqual(preserved.memoryBindings, memoryBindings, 'record-extraction preserves the optional memory registration');
    assert.equal(preserved.choicesGeneration, 0);
    assert.equal(auto.readState({ projectRoot: root, requireAgreement: true }).agreement.status, 'stored-context-current');
    const { extraction } = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
    assert.equal(extraction.run.supported, true);
    assert.equal(extraction.run.manifestSha256, extraction.inputs.manifestSha256);
    assert.equal(extraction.run.translation.projectPath, path.join(root, 'Demo', 'translation.json'));
    assert.equal(cli('read-state', '--project-root', root).json.code, 'ok');
  });

  it('records the extraction as failed when the attempt no longer checks out', () => {
    const root = project();
    init(root);
    const out = attempted(root);
    fs.appendFileSync(path.join(root, 'Demo', 'Demo.lean'), '-- edited after publication\n');
    const result = record(root, out, 0);
    assert.equal(result.code, 'extraction-failed');
    const { extraction } = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
    assert.equal(extraction.status, 'failed');
    assert.match(extraction.reasons.join('\n'), /recorded extraction attempt does not check out/);
    assert.equal('run' in extraction, false);
  });

  it('leaves a copy extracted without the recorder with no run, and refuses a malformed stored run', () => {
    const root = project();
    init(root);
    const { out } = prepared(root);
    assert.equal(record(root, out, 0).code, 'recorded');
    const file = stateFile(root);
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal('run' in state.extraction, false);
    state.extraction.run = { supported: true };
    fs.writeFileSync(file, JSON.stringify(state));
    assert.notEqual(cli('read-state', '--project-root', root).json.code, 'ok');
  });

  it('refuses a stored run with an empty publication or missing stage identities', () => {
    const root = project();
    init(root);
    const out = attempted(root);
    assert.equal(record(root, out, 0).code, 'recorded');
    const file = stateFile(root);
    const saved = fs.readFileSync(file, 'utf8');
    for (const edit of [(run) => { run.publication = []; }, (run) => { run.stages = {}; }, (run) => { delete run.attemptSha256; }, (run) => { run.trust = 'x'; }]) {
      const state = JSON.parse(saved);
      edit(state.extraction.run);
      fs.writeFileSync(file, JSON.stringify(state));
      assert.notEqual(cli('read-state', '--project-root', root).json.code, 'ok');
    }
    fs.writeFileSync(file, saved);
    assert.equal(cli('read-state', '--project-root', root).json.code, 'ok');
  });
});

describe('auto-extract extraction record', () => {
  it('a clean build of a verified copy is recorded as success with its inputs, and as not a proof', () => {
    const root = project();
    init(root);
    const { out, status } = prepared(root);
    assert.equal(status, 0);
    const result = record(root, out, 0);
    assert.equal(result.code, 'recorded', JSON.stringify(result));
    const { extraction } = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
    assert.equal(extraction.status, 'succeeded');
    assert.deepEqual(extraction.reasons, []);
    assert.deepEqual(extraction.declared, { buildExitCode: 0, oracle: 'complete' });
    assert.equal(extraction.inputs.mode, 'translation-patches');
    assert.equal(extraction.inputs.sourceCommit, git(root, 'rev-parse', 'HEAD'));
    assert.deepEqual(extraction.inputs.patches.map((patch) => patch.file), ['lib-double.patch']);
    assert.equal(extraction.inputs.manifestSha256, sha256(fs.readFileSync(path.join(out, 'manifest.json'))));
    assert.match(extraction.note, /not a proof/);
  });

  it('a relative --out is read from the project root, not the shell working directory', () => {
    const root = project();
    init(root);
    const { out } = prepared(root);
    // The CLI runs from the FVS checkout; the copy lies beside the project, so only
    // resolution against --project-root reaches it.
    const relative = path.relative(root, out);
    assert.ok(!path.isAbsolute(relative) && relative.startsWith('..'));
    const result = cli('record-extraction', '--project-root', root, '--out', relative, '--build-exit-code', '0', '--oracle', 'complete');
    assert.equal(result.status, 0, result.stdout || result.stderr);
    assert.equal(result.json.code, 'recorded');
    const { extraction } = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
    assert.equal(extraction.status, 'succeeded');
    assert.equal(extraction.inputs.out, out);
  });

  // One git repository: the crate at its root and the Lean project in formal/.
  function layout() {
    const repo = temporaryDirectory('fvs-auto-layout-');
    fs.cpSync(CRATE, repo, { recursive: true });
    fs.cpSync(path.join(PROFILE_FIXTURES, 'fresh'), path.join(repo, 'formal'), { recursive: true });
    git(repo, 'init', '-q');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'fixture');
    return { repo, lean: path.join(repo, 'formal') };
  }

  function recordedExtraction(root) {
    return JSON.parse(fs.readFileSync(stateFile(root), 'utf8')).extraction;
  }

  it('a crate beside the Lean project in one repository is recorded, bound to the recorded commit', () => {
    const { repo, lean } = layout();
    assert.equal(init(lean).code, 'created');
    const { out, status } = prepared(repo);
    assert.equal(status, 0);
    const result = record(lean, out, 0);
    assert.equal(result.code, 'recorded', JSON.stringify(result));
    const { extraction } = auto.readState({ projectRoot: lean }).state;
    assert.equal(extraction.status, 'succeeded');
    assert.equal(extraction.inputs.crateRoot, repo);
    assert.equal(extraction.inputs.sourceCommit, git(repo, 'rev-parse', 'HEAD'));
  });

  it('the revision and uncommitted-change checks still bind a crate outside the Lean root', () => {
    // Uncommitted extraction inputs fail the record for that reason, not the location.
    const dirty = layout();
    init(dirty.lean);
    fs.appendFileSync(path.join(dirty.repo, 'src', 'lib.rs'), '\n// not committed\n');
    assert.equal(record(dirty.lean, prepared(dirty.repo, []).out, 0).code, 'extraction-failed');
    const dirtyReasons = recordedExtraction(dirty.lean).reasons.join('\n');
    assert.match(dirtyReasons, /uncommitted changes: src\/lib\.rs/);
    assert.doesNotMatch(dirtyReasons, /git working tree of this project/);

    // A crate at another commit than the recorded revision fails the record.
    const moved = layout();
    const first = git(moved.repo, 'rev-parse', 'HEAD');
    init(moved.lean, { ...CHOICES, source: { revision: first, configuration: 'default features' } });
    git(moved.repo, 'commit', '-q', '--allow-empty', '-m', 'later');
    assert.equal(record(moved.lean, prepared(moved.repo, []).out, 0).code, 'extraction-failed');
    const movedReasons = recordedExtraction(moved.lean).reasons.join('\n');
    assert.match(movedReasons, new RegExp(`but the recorded revision ${first} is ${first}`));
    assert.doesNotMatch(movedReasons, /git working tree of this project/);
  });

  it('a crate in another repository than the Lean project is still refused for its location', () => {
    const root = project();
    init(root);
    const other = project();
    assert.equal(record(root, prepared(other).out, 0).code, 'extraction-failed');
    const { reasons, status } = recordedExtraction(root);
    assert.equal(status, 'failed');
    assert.match(reasons.join('\n'), new RegExp(`prepared from ${other}, which is not in the git working tree of this project`));
  });

  // Another checkout inside the Lean root has its own commit history, so a clean copy
  // of it must not stand for this project at the recorded revision.
  it('a crate in a nested repository inside the Lean root is refused', () => {
    const root = project();
    init(root);
    const nested = path.join(root, 'vendor', 'crate');
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.cpSync(CRATE, nested, { recursive: true });
    git(nested, 'init', '-q');
    git(nested, 'add', '-A');
    git(nested, 'commit', '-q', '-m', 'nested fixture');
    assert.equal(record(root, prepared(nested, []).out, 0).code, 'extraction-failed');
    assert.match(recordedExtraction(root).reasons.join('\n'), new RegExp(`prepared from ${fs.realpathSync(nested)}, which is not in the git working tree of this project`));
  });

  it('a crate in a linked worktree inside the Lean root is refused', () => {
    const root = project();
    init(root);
    const linked = path.join(root, 'linked');
    git(root, 'worktree', 'add', '-q', '--detach', linked);
    assert.equal(record(root, prepared(linked, []).out, 0).code, 'extraction-failed');
    assert.match(recordedExtraction(root).reasons.join('\n'), new RegExp(`prepared from ${fs.realpathSync(linked)}, which is not in the git working tree of this project`));
  });

  it('a crate in a subfolder of the same repository is recorded', () => {
    const root = project();
    init(root);
    const inner = path.join(root, 'crates', 'inner');
    fs.mkdirSync(path.dirname(inner), { recursive: true });
    fs.cpSync(CRATE, inner, { recursive: true });
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'inner crate');
    const result = record(root, prepared(inner, []).out, 0);
    assert.equal(result.code, 'recorded', JSON.stringify(result));
    assert.equal(recordedExtraction(root).inputs.crateRoot, fs.realpathSync(inner));
  });

  it('a failed build is recorded as failure, never as success', () => {
    const root = project();
    init(root);
    const { out } = prepared(root);
    const result = record(root, out, 1);
    assert.equal(result.code, 'extraction-failed');
    const { extraction } = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
    assert.equal(extraction.status, 'failed');
    assert.match(extraction.reasons.join('\n'), /build exited 1/);
  });

  // The recorded Aeneas versions disagree: setup goes on with a warning, and
  // only a failed build of the recorded extraction stops the run.
  it('a provenance conflict warns at setup and stops only when the recorded build fails', () => {
    const conflicted = () => {
      const root = project();
      fs.copyFileSync(path.join(PROFILE_FIXTURES, 'pilot', 'lake-manifest.json'), path.join(root, 'lake-manifest.json'));
      fs.writeFileSync(path.join(root, 'aeneas-config.yml'), 'aeneas:\n  commit: "deadbeef"\n');
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'conflicting provenance');
      return root;
    };
    const built = conflicted();
    assert.equal(init(built).code, 'created');
    const aeneas = auto.readState({ projectRoot: built }).state.profile.items.find((entry) => entry.id === 'aeneas');
    assert.equal(aeneas.verdict, 'available-but-unverified');
    assert.match(aeneas.reason, /^warning: conflict: aeneas-config\.yml aeneas\.commit deadbeef does not match lake-manifest\.json aeneas 0855ce1b/);
    assert.match(aeneas.reason, /the run goes on if the recorded extraction builds against the pinned Lean library/);
    assert.match(aeneas.nextStep, /To clear the provenance warning: Regenerate the extraction/);
    assert.equal(aeneas.evidence.provenanceConflicts.length, 1);
    assert.equal(record(built, prepared(built).out, 0).code, 'recorded');
    assert.match(auto.readState({ projectRoot: built }).nextAction, /\/fvs:auto-top-specs/);

    const broken = conflicted();
    assert.equal(init(broken).code, 'created');
    assert.equal(record(broken, prepared(broken).out, 1).code, 'extraction-failed');
    assert.match(auto.readState({ projectRoot: broken }).nextAction, /Rerun \/fvs:auto-extract after fixing the recorded failure reasons/);
  });

  it('a green build whose shared success oracle refused completion is recorded as failure', () => {
    const root = project();
    init(root);
    const { out } = prepared(root);
    for (const [oracle, reason, pattern] of [
      ['refused', 'lib-double.patch is Category B without a ratification bound to its sha256', /refused.*ratification bound/],
      ['refused', 'diff-to-record check failed: series lists lib-double.patch without a Classification: line', /diff-to-record/],
      ['unknown', undefined, /did not report|unknown/],
    ]) {
      const result = record(root, out, 0, oracle, reason);
      assert.equal(result.code, 'extraction-failed', oracle);
      const { extraction } = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
      assert.equal(extraction.status, 'failed');
      assert.equal(extraction.declared.buildExitCode, 0, 'the real build exit is kept apart from the verdict');
      assert.equal(extraction.declared.oracle, oracle);
      assert.match(extraction.reasons.join('\n'), pattern);
      assert.match(auto.readState({ projectRoot: root }).nextAction, /\/fvs:auto-extract/);
    }
  });

  it('a blank oracle reason is omitted, so the written record stays readable', () => {
    const root = project();
    init(root);
    const { out } = prepared(root);
    const result = cli('record-extraction', '--project-root', root, '--out', out, '--build-exit-code', '0',
      '--oracle', 'unknown', '--oracle-reason', '   ');
    assert.equal(result.status, 1);
    assert.equal(result.json.code, 'extraction-failed');
    const read = cli('read-state', '--project-root', root);
    assert.equal(read.status, 0, read.stdout);
    assert.equal(read.json.state.extraction.status, 'failed');
    assert.equal('oracleReason' in read.json.state.extraction.declared, false);
  });

  it('a non-string oracle reason is refused before anything is written', () => {
    const root = project();
    init(root);
    const { out } = prepared(root);
    assert.equal(record(root, out, 0).code, 'recorded');
    const before = fs.readFileSync(stateFile(root));
    for (const reason of [{ clause: 'ratification' }, 7, null, ['x']]) {
      const result = record(root, out, 0, 'refused', reason);
      assert.equal(result.code, 'usage', JSON.stringify(reason));
      assert.match(result.message, /oracle reason must be text/);
    }
    assert.deepEqual(fs.readFileSync(stateFile(root)), before);
    assert.equal(cli('read-state', '--project-root', root).json.code, 'ok');
  });

  it('an absent or unrecognised oracle verdict records nothing', () => {
    const root = project();
    init(root);
    const { out } = prepared(root);
    const missing = cli('record-extraction', '--project-root', root, '--out', out, '--build-exit-code', '0');
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /--oracle is required/);
    const bogus = cli('record-extraction', '--project-root', root, '--out', out, '--build-exit-code', '0', '--oracle', 'passed');
    assert.equal(bogus.status, 2);
    assert.match(bogus.stderr, /--oracle must be complete, refused or unknown/);
    assert.equal(JSON.parse(fs.readFileSync(stateFile(root), 'utf8')).extraction, null);
  });

  it('an engine refusal (a partial copy from a stale patch) is never recorded as success', () => {
    const root = project();
    init(root);
    const { out, status } = prepared(root, ['limits-halve']);
    assert.notEqual(status, 0);
    const result = record(root, out, 0);
    assert.equal(result.code, 'extraction-failed');
    assert.equal(JSON.parse(fs.readFileSync(stateFile(root), 'utf8')).extraction.status, 'failed');
  });

  it('a source changed after prepare or a copy repaired in place fails the record', () => {
    const root = project();
    init(root);
    const { out } = prepared(root);
    fs.appendFileSync(path.join(out, 'tree', 'src', 'lib.rs'), '\n// repaired in the copy\n');
    assert.equal(record(root, out, 0).code, 'extraction-failed');

    const other = project();
    init(other);
    const second = prepared(other);
    fs.appendFileSync(path.join(other, 'src', 'lib.rs'), '\n// edited original\n');
    const result = record(other, second.out, 0);
    assert.equal(result.code, 'extraction-failed');
    assert.match(JSON.parse(fs.readFileSync(stateFile(other), 'utf8')).extraction.reasons.join('\n'), /verify-restore/);
  });

  it('an extraction of another revision than the recorded one fails the record', () => {
    const root = project();
    const first = git(root, 'rev-parse', 'HEAD');
    init(root, { ...CHOICES, source: { revision: first, configuration: 'default features' } });
    const { out } = prepared(root);
    const result = record(root, out, 0);
    assert.equal(result.code, 'extraction-failed');
    assert.match(JSON.parse(fs.readFileSync(stateFile(root), 'utf8')).extraction.reasons.join('\n'), /revision/);
  });

  it('a later failure replaces an earlier success, and the next action asks for extraction again', () => {
    const root = project();
    init(root);
    const { out } = prepared(root);
    assert.equal(record(root, out, 0).code, 'recorded');
    assert.match(auto.readState({ projectRoot: root }).nextAction, /\/fvs:auto-top-specs/);
    assert.equal(record(root, out, 2).code, 'extraction-failed');
    assert.match(auto.readState({ projectRoot: root }).nextAction, /\/fvs:auto-extract/);
  });

  it('without a probe the stage runs reduced with a warning, and installing it refreshes only the profile', () => {
    const root = project();
    assert.equal(init(root, CHOICES, { bin: binWithout('probe-aeneas') }).code, 'created');
    const { out } = prepared(root);
    assert.equal(record(root, out, 0).code, 'recorded');
    const blocked = auto.readState({ projectRoot: root });
    assert.equal(blocked.readiness.find((entry) => entry.stage === 'auto-top-specs').status, 'ready-reduced');
    assert.equal(blocked.phase, 'specs');
    assert.match(blocked.nextAction, /^Run \/fvs:auto-top-specs from the AO orchestrator for the spec phase: .* Warning: auto-top-specs: ready, reduced - without probe-aeneas; /);
    assert.match(blocked.nextAction, /To restore, the owner can install probe-aeneas \(or set its path override\), then rerun \/fvs:auto-init/);
    assert.match(blocked.warnings[0], /^auto-top-specs: ready, reduced - without probe-aeneas; /);
    assert.match(blocked.warnings[1], /^no agreement is recorded: .*the spec phase does not wait for it$/);

    // The owner installs probe-aeneas; the agent reruns init-state with the same choices.
    const refreshed = init(root);
    assert.equal(refreshed.code, 'profile-refreshed', JSON.stringify(refreshed));
    const after = refreshed.state;
    assert.deepEqual(after.extraction, blocked.state.extraction, 'the extraction is kept');
    assert.deepEqual(after.choices, blocked.state.choices);
    assert.equal(after.choicesGeneration, blocked.state.choicesGeneration, 'a refresh is not a choice change');
    assert.equal(after.profile.probes.find((entry) => entry.id === 'probe-aeneas').status, 'present-unqualified');
    assert.match(refreshed.nextAction, /^Run \/fvs:auto-top-specs from the AO orchestrator for the spec phase/);
    assert.doesNotMatch(refreshed.nextAction, /ready, reduced/);
    const bytes = fs.readFileSync(stateFile(root));
    assert.equal(init(root).code, 'unchanged');
    assert.deepEqual(fs.readFileSync(stateFile(root)), bytes, 'a replay on the same host writes nothing');
  });

  it('a refresh refuses, writing nothing, when another command changed the state after it was read', () => {
    const root = project();
    assert.equal(init(root).code, 'created');
    // Between this refresh's read and its write, a separate process records the
    // roadmap decision through the real command.
    const open = fs.openSync;
    let raced = null;
    fs.openSync = function (file, ...rest) {
      if (raced === null && String(file) === `${stateFile(root)}.lock`) {
        raced = cli('record-roadmap', '--decision', 'declined', '--project-root', root);
      }
      return open.call(this, file, ...rest);
    };
    let refreshed;
    try {
      refreshed = init(root, CHOICES, { bin: binWithout('probe-aeneas') });
    } finally {
      fs.openSync = open;
    }
    assert.equal(raced.json?.code, 'recorded', raced.stdout + raced.stderr);
    assert.equal(refreshed.code, 'state-changed', JSON.stringify(refreshed));
    const state = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
    assert.equal(state.roadmap.decision, 'declined', 'the newer decision survives');
    assert.equal(state.profile.probes.find((entry) => entry.id === 'probe-aeneas').status, 'present-unqualified', 'the stale refresh wrote nothing');
    assert.equal(fs.existsSync(`${stateFile(root)}.lock`), false);

    const retried = init(root, CHOICES, { bin: binWithout('probe-aeneas') });
    assert.equal(retried.code, 'profile-refreshed', 'a rerun starts from the current state');
    assert.equal(retried.state.roadmap.decision, 'declined');
    assert.equal(retried.state.profile.probes.find((entry) => entry.id === 'probe-aeneas').status, 'missing');
  });

  it('a state write refuses while another writer holds the lock, and names the lock file', () => {
    const root = project();
    init(root);
    const bytes = fs.readFileSync(stateFile(root));
    fs.writeFileSync(`${stateFile(root)}.lock`, '1\n');
    const refused = init(root, CHOICES, { bin: binWithout('probe-aeneas') });
    assert.equal(refused.code, 'state-locked');
    assert.match(refused.nextStep, /state\.json\.lock/);
    assert.deepEqual(fs.readFileSync(stateFile(root)), bytes);
    assert.equal(run(() => auto.recordRoadmap({ projectRoot: root, decision: 'declined' })).code, 'state-locked');
    fs.rmSync(`${stateFile(root)}.lock`);
    assert.equal(run(() => auto.recordRoadmap({ projectRoot: root, decision: 'declined' })).code, 'recorded');
  });

  it('a refresh after AO is removed saves the gap, keeps the choices and extraction, then reports the blocker', () => {
    const root = project();
    init(root);
    const { out } = prepared(root);
    assert.equal(record(root, out, 0).code, 'recorded');
    const before = auto.readState({ projectRoot: root }).state;

    const noAo = binWithout('ao');
    const blocked = init(root, CHOICES, { bin: noAo });
    assert.equal(blocked.code, 'profile-blocked', JSON.stringify(blocked));
    assert.match(blocked.message, /ao is missing; the recorded profile now holds these facts/);
    const view = auto.readState({ projectRoot: root });
    assert.equal(view.state.profile.items.find((entry) => entry.id === 'ao').verdict, 'missing');
    assert.deepEqual(view.state.extraction, before.extraction);
    assert.deepEqual(view.state.choices, before.choices);
    assert.equal(view.state.choicesGeneration, before.choicesGeneration);
    assert.equal(view.readiness.find((entry) => entry.stage === 'auto-top-specs').status, 'no-route');
    assert.match(view.nextAction, /^Setup is blocked: ao is missing\. .*Then rerun \/fvs:auto-init\.$/);
    assert.equal(view.phase, 'setup');

    const bytes = fs.readFileSync(stateFile(root));
    assert.equal(init(root, CHOICES, { bin: noAo }).code, 'profile-blocked', 'a rerun on the same host still reports the blocker');
    assert.deepEqual(fs.readFileSync(stateFile(root)), bytes);
    assert.equal(init(root, { ...CHOICES, scope: 'another scope' }, { bin: noAo, confirmOverwrite: true }).code, 'profile-blocked');
    assert.deepEqual(auto.readState({ projectRoot: root }).state.choices, before.choices, 'a blocked choice change saves no choices');

    assert.equal(init(root).code, 'profile-refreshed', 'restoring AO clears the blocker');
    assert.doesNotMatch(auto.readState({ projectRoot: root }).nextAction, /^Setup is blocked/);
  });

  it('after extraction the next action is the spec phase, with no grant, stage profile or permission install; the agreement is a warning', () => {
    const root = project();
    init(root);
    const { out } = prepared(root);
    assert.equal(record(root, out, 0).code, 'recorded');
    const state = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
    for (const entry of state.profile.items) {
      if (['ao', 'lean'].includes(entry.id)) entry.verdict = 'available-but-unverified';
    }
    state.profile.probes = ['probe-aeneas', 'probe-rust', 'scip', 'rust-analyzer', 'probe-lean']
      .map((id) => ({ id, status: 'present-unqualified', path: `/opt/${id}`, lost: null }));
    fs.writeFileSync(stateFile(root), JSON.stringify(state));
    const unverified = /^auto-top-specs: ready, unverified - probe-aeneas, probe-rust, scip, rust-analyzer, probe-lean not qualified/;
    const first = auto.readState({ projectRoot: root });
    assert.equal(first.phase, 'specs');
    assert.match(first.nextAction, /^Run \/fvs:auto-top-specs from the AO orchestrator for the spec phase: .*draft spec PR on the project's own repository/);
    assert.doesNotMatch(first.nextAction, /grants|stage profile \(|permission-ready|Before \/fvs/);
    assert.equal(first.warnings.length, 2);
    assert.match(first.warnings[0], unverified);
    assert.match(first.warnings[1], /^no agreement is recorded/);

    const agree = (execution, generation, contextVersion) => {
      const agreement = {
        schema: 'fvs/auto-agreement', schemaVersion: 1, mode: 'nonpublic-intent',
        payload: { choicesGeneration: generation, choices: auto.readState({ projectRoot: root }).state.choices,
          contextVersion, boundaries: [], conventions: [], layout: 'single-crate', claims: ['fixture'],
          trust: ['fixture policy'], acceptance: ['fixture evidence'], ownerReserved: ['human final decision'],
          execution, draftPr: null },
        ownerEvidence: { reference: 'fixture:response', response: 'Fixture agreement' },
      };
      agreement.approvedPayloadSha256 = auto.agreementPayloadSha256(agreement);
      fs.writeFileSync(path.join(root, '.formalising/auto-fv/ROADMAP.md'),
        '## Decisions\n```fvs-auto-agreement\n' + JSON.stringify(agreement) + '\n```\n');
      auto.recordAgreement({ projectRoot: root, agreement, confirmOverwrite: contextVersion > 1 });
    };
    agree(null, 0, 1);
    const agreed = auto.readState({ projectRoot: root });
    assert.equal(agreed.phase, 'specs', 'an agreement without an execution grant does not hold the spec phase');
    assert.equal(agreed.warnings.length, 1);
    assert.match(agreed.warnings[0], unverified);
    assert.match(agreed.nextAction, /Warning: auto-top-specs: ready, unverified - /);

    const advanced = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
    advanced.choicesGeneration += 1;
    fs.writeFileSync(stateFile(root), JSON.stringify(advanced));
    const outdated = auto.readState({ projectRoot: root });
    assert.equal(outdated.phase, 'specs');
    assert.match(outdated.warnings[1], /^the recorded agreement covers earlier choices: .*does not wait for it$/);
  });

  it('no flag lets a caller state the result', () => {
    const root = project();
    init(root);
    const { out } = prepared(root);
    const result = cli('record-extraction', '--project-root', root, '--out', out, '--build-exit-code', '0', '--oracle', 'complete', '--status', 'succeeded');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unknown argument "--status"/);
    assert.equal(JSON.parse(fs.readFileSync(stateFile(root), 'utf8')).extraction, null);
  });

  it('extraction needs recorded setup state first', () => {
    const root = project();
    const { out } = prepared(root);
    assert.equal(record(root, out, 0).code, 'no-state');
  });
});

describe('stored extraction records', () => {
  function recorded() {
    const root = project();
    init(root);
    const { out } = prepared(root);
    assert.equal(record(root, out, 0).code, 'recorded');
    return root;
  }

  it('a contradictory or incomplete success record is malformed state, never a success', () => {
    for (const [label, edit] of [
      ['nonzero declared build exit', (x) => { x.declared.buildExitCode = 1; }],
      ['refused oracle verdict', (x) => { x.declared.oracle = 'refused'; }],
      ['missing oracle verdict', (x) => { delete x.declared.oracle; }],
      ['missing inputs', (x) => { delete x.inputs; }],
      ['null inputs', (x) => { x.inputs = null; }],
      ['inputs without patches', (x) => { delete x.inputs.patches; }],
      ['missing checks', (x) => { delete x.checks; }],
      ['a refused required check', (x) => { x.checks['verify-restore'].ok = false; }],
      ['missing note', (x) => { delete x.note; }],
    ]) {
      const root = recorded();
      const state = JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
      edit(state.extraction);
      const bytes = `${JSON.stringify(state, null, 2)}\n`;
      fs.writeFileSync(stateFile(root), bytes);
      const result = cli('read-state', '--project-root', root);
      assert.equal(result.status, 3, label);
      assert.equal(result.json.code, 'malformed-state', label);
      assert.match(result.json.nextStep, /move it aside/, label);
      assert.equal(fs.readFileSync(stateFile(root), 'utf8'), bytes, `${label}: never rewritten`);
    }
  });

  it('a failed record without manifest inputs stays valid', () => {
    const root = project();
    init(root);
    const { out } = prepared(root, ['limits-halve']);
    assert.equal(record(root, out, 0).code, 'extraction-failed');
    const read = auto.readState({ projectRoot: root });
    assert.equal(read.code, 'ok');
    assert.equal(read.state.extraction.inputs, null);
  });
});

function boundary(overrides = {}) {
  return {
    id: 'ext-sha3',
    kind: 'external',
    source: { symbol: 'libcrux_sha3::portable::shake128', commit: 'a'.repeat(40) },
    model: { symbol: 'libcrux_sha3.portable.shake128', sha256: 'b'.repeat(64) },
    claimedBehaviour: 'returns the SHAKE128 output of its input',
    reason: 'outside the extracted crate',
    affectedRoots: [],
    evidence: ['equivalence-gate/sha3.md'],
    status: 'open',
    decision: null,
    ...overrides,
  };
}

function externals(root, records) {
  return run(() => auto.recordExternals({ projectRoot: root, records }));
}

describe('externals record', () => {
  it('valid records are written and survive a rerun', () => {
    const root = project();
    init(root);
    assert.equal(externals(root, [boundary()]).code, 'recorded');
    const second = boundary({ id: 'patch-ntt', kind: 'semantic-patch' });
    assert.equal(externals(root, [boundary(), second]).code, 'recorded');
    const written = JSON.parse(fs.readFileSync(externalsFile(root), 'utf8'));
    assert.equal(written.schema, 'fvs/auto-externals');
    assert.deepEqual(written.records.map((entry) => entry.id), ['ext-sha3', 'patch-ntt']);
    assert.equal(auto.readState({ projectRoot: root }).externals.open, 2);
  });

  it('a rerun that drops a recorded boundary is refused and the record kept', () => {
    const root = project();
    init(root);
    externals(root, [boundary(), boundary({ id: 'opaque-reduce', kind: 'opaque' })]);
    const before = fs.readFileSync(externalsFile(root));
    const result = externals(root, [boundary()]);
    assert.equal(result.code, 'record-loss');
    assert.deepEqual(result.lost, ['opaque-reduce']);
    assert.deepEqual(fs.readFileSync(externalsFile(root)), before);
  });

  it('every schema field is checked', () => {
    const root = project();
    init(root);
    for (const bad of [
      boundary({ kind: 'axiom' }),
      boundary({ status: 'closed' }),
      boundary({ id: '' }),
      boundary({ source: { symbol: 'x' } }),
      boundary({ model: { symbol: 'x', sha256: 'not-a-hash' } }),
      boundary({ claimedBehaviour: '' }),
      boundary({ affectedRoots: 'all' }),
      boundary({ evidence: [1] }),
      boundary({ status: 'assumption-accepted', decision: null }),
      boundary({ decision: { by: 'owner' } }),
      boundary({ unexpected: 1 }),
    ]) {
      assert.equal(externals(root, [bad]).code, 'invalid-input', JSON.stringify(bad));
    }
    assert.equal(externals(root, [boundary(), boundary()]).code, 'invalid-input', 'duplicate ids');
    assert.equal(fs.existsSync(externalsFile(root)), false);
  });

  it('an accepted assumption carries who decided, when and on what evidence', () => {
    const root = project();
    init(root);
    const decision = { by: 'owner', at: '2026-10-27T10:00:00Z', evidence: 'chat approval' };
    assert.equal(externals(root, [boundary({ status: 'assumption-accepted', decision })]).code, 'recorded');
  });

  // Milestone 1 has no checker for correspondence receipts, so nothing can show
  // that a receipt is checked correspondence evidence: the status is refused.
  describe('correspondence-proved', () => {
    const decision = { by: 'coordinator', at: '2026-10-27T10:00:00Z', evidence: 'checked receipt' };

    it('is refused on a ratification packet or review links alone', () => {
      const root = project();
      init(root);
      const proved = boundary({
        status: 'correspondence-proved',
        decision,
        evidence: ['equivalence-gate/sha3.md', 'https://github.com/example/repo/pull/1#pullrequestreview-1'],
      });
      const result = externals(root, [proved]);
      assert.equal(result.code, 'invalid-input');
      assert.match(result.message, /not implemented in this milestone/);
    });

    it('a well-formed receipt path and matching hash cannot promote a boundary, and the record is unchanged', () => {
      const root = project();
      init(root);
      const accepted = boundary({
        id: 'opaque-reduce',
        kind: 'opaque',
        status: 'assumption-accepted',
        decision: { by: 'owner', at: '2026-10-27T09:00:00Z', evidence: 'chat approval' },
      });
      assert.equal(externals(root, [boundary(), accepted]).code, 'recorded');
      const receipts = path.join(root, '.formalising', 'auto-fv', 'receipts');
      fs.mkdirSync(receipts, { recursive: true });
      fs.writeFileSync(path.join(receipts, 'sha3.json'), '{"status":"accepted"}');
      const before = { externals: fs.readFileSync(externalsFile(root)), state: fs.readFileSync(stateFile(root)) };

      const promoted = boundary({
        status: 'correspondence-proved',
        decision,
        correspondenceReceipt: { path: 'receipts/sha3.json', sha256: sha256('{"status":"accepted"}') },
      });
      const result = externals(root, [promoted, accepted]);
      assert.equal(result.code, 'invalid-input');
      assert.match(result.message, /records\[0\]: correspondence-proved is not available: checked correspondence receipt validation is not implemented in this milestone/);
      assert.deepEqual(fs.readFileSync(externalsFile(root)), before.externals, 'the recorded boundaries are untouched');
      assert.deepEqual(fs.readFileSync(stateFile(root)), before.state);
      const counts = auto.readState({ projectRoot: root }).externals;
      assert.deepEqual([counts.total, counts.open, counts['assumption-accepted'], counts['correspondence-proved']], [2, 1, 1, 0]);
    });

    it('a hand-edited record claiming it is reported as malformed, never counted', () => {
      const root = project();
      init(root);
      externals(root, [boundary()]);
      const file = JSON.parse(fs.readFileSync(externalsFile(root), 'utf8'));
      file.records[0] = { ...file.records[0], status: 'correspondence-proved', decision };
      fs.writeFileSync(externalsFile(root), JSON.stringify(file));
      const result = cli('read-state', '--project-root', root);
      assert.equal(result.status, 3);
      assert.equal(result.json.code, 'malformed-externals');
      assert.match(result.json.message, /not implemented in this milestone/);
    });
  });

  it('a malformed externals file is reported, never replaced', () => {
    const root = project();
    init(root);
    fs.writeFileSync(externalsFile(root), '[]');
    assert.equal(externals(root, [boundary()]).code, 'malformed-externals');
    assert.equal(fs.readFileSync(externalsFile(root), 'utf8'), '[]');
    assert.equal(cli('read-state', '--project-root', root).json.code, 'malformed-externals');
  });

  it('the CLI reads records from an input file', () => {
    const root = project();
    init(root);
    const input = path.join(temporaryDirectory(), 'externals.json');
    fs.writeFileSync(input, JSON.stringify([boundary()]));
    const result = cli('record-externals', '--project-root', root, '--input', input);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.json.code, 'recorded');
  });
});

// The command and workflow text calls the state operations above; these
// checks keep the text and the script in step.
describe('auto command and workflow text', () => {
  it('the per-node hours are shown as inactive, not as a proof deadline', () => {
    for (const relative of ['fv-skills/workflows/auto-init.md', 'commands/fvs/help.md']) {
      const body = fs.readFileSync(path.join(ROOT, relative), 'utf8');
      assert.match(body, /no arbitrary per-node proof timeout/, relative);
      assert.match(body, /not enforced/, relative);
    }
  });

  const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
  const members = ['auto-init', 'auto-extract', 'auto-top-specs', 'auto-execute'];
  const text = (name) => `${read(`commands/fvs/${name}.md`)}\n${read(`fv-skills/workflows/${name}.md`)}`;

  it('every command reports the state, the next action and the pending decision', () => {
    for (const name of [...members, 'auto']) {
      const body = name === 'auto' ? read('commands/fvs/auto.md') : text(name);
      for (const line of ['State:', 'Next action:', 'Pending decision:']) assert.ok(body.includes(line), `${name} lacks ${line}`);
    }
  });

  it('every member requires the ao CLI and reads state only through the script', () => {
    for (const name of members) {
      const workflow = read(`fv-skills/workflows/${name}.md`);
      assert.match(workflow, /command -v ao/, name);
      assert.match(workflow, /"\$AUTO" read-state --project-root \./, name);
    }
  });

  it('every fvs-auto.mjs subcommand the workflows call exists', () => {
    const help = cli('--help').stdout;
    for (const name of members) {
      for (const [, subcommand] of read(`fv-skills/workflows/${name}.md`).matchAll(/"\$AUTO" ([a-z-]+)/g)) {
        assert.match(help, new RegExp(`fvs-auto\\.mjs ${subcommand} `), `${name} calls ${subcommand}`);
      }
    }
  });

  it('top-specs and execute retain legacy stops and gate the authorized v2 driver route', () => {
    for (const name of ['auto-top-specs', 'auto-execute']) {
      const body = text(name);
      assert.match(body, /milestone 2 functionality not yet available/, name);
      assert.match(body, /"Auto track" section of the FVS README/, name);
      const command = read(`commands/fvs/${name}.md`);
      assert.match(command, /Legacy\/read-only and missing-context invocations retain the reporting stop without dispatch/);
      assert.match(command, /^ {2}- Write$/m);
      assert.match(command, /explicit execution grant/);
      assert.match(body, /Production driver: authorized v2 continuation/);
      assert.match(body, /runPairedEffect/);
      assert.match(body, /recordAfter/);
      assert.match(body, /partial/);
      assert.doesNotMatch(body, /record-(roadmap|extraction|externals)|init-state/, name);
    }
    assert.match(read('README.md'), /^### Auto track$/m);
  });

  it('top-specs says how agreement boundaries reach the closure plan as allowed axioms', () => {
    const body = text('auto-top-specs').replace(/\s+/g, ' ');
    assert.match(body, /Prose agreement boundaries do not match axioms automatically, so the orchestrator translates them once into exact Lean names and passes them with `--allow-axioms`/);
    assert.doesNotMatch(body, /assumption-accepted|allowed automatically|came from where/, 'the planner does not yet allow recorded externals or record where an allowed axiom came from');
    assert.doesNotMatch(body, /Run13|\bticket\b/);
  });

  it('auto-extract hands off to the shared extractor and records every attempt through the script', () => {
    const body = text('auto-extract');
    assert.match(body, /\/fvs:aeneas-extract "\$CRATE_ROOT"/);
    assert.match(body, /"\$AUTO" record-extraction --project-root \. --out "\$OUT" --build-exit-code "\$BUILD_STATUS" --oracle "\$ORACLE"\n/);
    assert.match(body, /Add `--oracle-reason "<reason>"` only when the summary gives a reason/, 'no empty reason argument');
    assert.match(read('fv-skills/workflows/aeneas-extract.md'), /^Oracle: {16}\{complete \| refused: /m,
      'the shared extractor reports its final success-oracle verdict');
    assert.match(body, /Record every attempt, success or failure/);
    assert.match(body, /"\$AUTO" record-externals --project-root \. --input "\$RECORDS"/);
    assert.match(body, /never migrate/i);
    assert.match(body, /Extraction success is not a proof/);
    assert.match(body, /`correspondence-proved` is refused in this milestone/);
    assert.match(body, /`aeneas-config\.yml` recording `aeneas\.commit`[\s\S]*`crate\.dir`[\s\S]*`aeneas_args\.dest`/,
      'auto-extract tells the owner how the resolver finds the extraction metadata');
    assert.doesNotMatch(body, /correspondenceReceipt/, 'no text offers a path and hash as correspondence evidence');
    assert.match(read('fv-skills/workflows/aeneas-extract.md'), /^Copy: {18}\{the OUT of the last cycle\}; build exit/m,
      'the shared extractor reports the copy and the build status the handoff records');
  });

  it('auto-init reuses current evidence and gates M2 on stored AND semantic agreement checks', () => {
    const body = text('auto-init');
    assert.match(body, /"\$AUTO" init-state --project-root \. --input "\$CHOICES"/);
    assert.match(body, /Only on an explicit yes rerun\s+the same command with `--confirm-overwrite`/);
    assert.match(body, /node "\$HELPER" --project-root \. --input "\$DRAFT"\n/, 'the helper drafts without recording');
    assert.match(body, /node "\$HELPER" --project-root \. --input "\$DRAFT" --out "\$AGREEMENT"/);
    assert.match(body, /ask the owner to run the printed command\s+in their own terminal: it is `fvs-auto\.mjs record-agreement`/,
      'the record step is named as owner-run');
    assert.match(body, /The helper never records the agreement\s+and never edits the roadmap or the state/);
    assert.match(body, /Never write that reply yourself/);
    assert.match(body, /"\$AUTO" read-state --project-root \. --require-agreement/);
    assert.match(body, /Do not ask Keep\/Change/);
    assert.match(body, /A recorded decline is not asked again/);
    assert.match(body, /actual referenced owner response/);
    assert.match(body, /conflicting\/missing\/superseding canonical statement stops/);
    assert.match(body, /stored-context-current/);
    assert.match(body, /Routine Status log appends outside the fence/);
    assert.match(body, /there is no per-round human contract approval/);
    assert.match(body, /Final PR acceptance remains human/);
    assert.match(body, /`public-api`\s+mode is not supported in this release: report that refusal without retrying it/);
    assert.ok(!/visibility join|separately permitted|ticket11/.test(body), 'the public-API sentence names no landing condition');
    assert.match(body, /Agreement storage alone launches no workers/);
    assert.match(body, /Without that complete opt-in context[\s\S]*stop/);
    assert.match(body, /fv-skills\/references\/auto-transitions\.md/);
    assert.match(body, /Actual live provider execution[\s\S]*separately granted concrete setup\/permission/);
    assert.match(body, /verifyReconciliation/);
    assert.match(read('commands/fvs/roadmap.md'), /`\.formalising\/auto-fv\/ROADMAP\.md`; `\/fvs:auto-init`/);
    assert.match(read('fv-skills/workflows/roadmap.md'), /\*\.md\) FILE=\$ROADMAP_PATH/);
    assert.match(read('fv-skills/workflows/roadmap.md'), /Generic roadmaps outside auto-init require no machine envelope/);
  });
});
