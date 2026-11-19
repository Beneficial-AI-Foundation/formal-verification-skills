'use strict';

// Engine ergonomics of scripts/fvs-auto.mjs: the short read-state, recording a
// spec review from a commit, and run overrides. Every project is a temporary
// git fixture; no Charon, Aeneas or Lean runs.

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

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, '-c', 'user.name=fvs', '-c', 'user.email=fvs@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

// A committed Lean project the stub profile accepts.
function project() {
  const root = temporaryDirectory('fvs-ergonomics-');
  fs.cpSync(CRATE, root, { recursive: true });
  fs.cpSync(path.join(PROFILE_FIXTURES, 'fresh'), root, { recursive: true });
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture');
  return root;
}

// Setup state recorded with the profile tests' stub tools as the only tools.
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
      choices: { source: { revision: 'HEAD', configuration: 'default features' }, scope: 'the portable NTT module only', limits: { wallClockHours: 40 } } });
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
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

describe('read-state --brief', () => {
  it('keeps the phase, next action, warnings, pending decisions and externals, and drops the profile', () => {
    const root = project();
    init(root);
    const full = cli('read-state', '--project-root', root);
    const brief = cli('read-state', '--project-root', root, '--brief');
    assert.equal(brief.status, 0);
    assert.equal(brief.json.ok, true);
    assert.equal(brief.json.brief, true);
    for (const key of ['phase', 'nextAction', 'warnings', 'pendingDecisions', 'externals']) {
      assert.deepEqual(brief.json[key], full.json[key], `${key} is the same as in the full result`);
    }
    assert.equal(brief.json.phase, 'extract');
    assert.equal(brief.json.state, undefined, 'no recorded state, so no probe profile');
    assert.equal(brief.json.readiness, undefined);
    assert.ok(brief.stdout.length * 4 < full.stdout.length, `brief ${brief.stdout.length} bytes against full ${full.stdout.length}`);
  });

  it('on a fresh project it reports no state, still brief', () => {
    const brief = cli('read-state', '--project-root', project(), '--brief');
    assert.equal(brief.json.code, 'no-state');
    assert.equal(brief.json.phase, 'setup');
    assert.equal(brief.json.brief, true);
  });

  it('refuses to be combined with --require-agreement, writing nothing', () => {
    const root = project();
    init(root);
    const before = fs.readFileSync(path.join(root, '.formalising', 'auto-fv', 'state.json'));
    const result = cli('read-state', '--project-root', root, '--brief', '--require-agreement');
    assert.equal(result.status, 2);
    assert.equal(result.json.code, 'usage');
    assert.match(result.json.message, /--brief cannot be combined with --require-agreement/);
    assert.deepEqual(fs.readFileSync(path.join(root, '.formalising', 'auto-fv', 'state.json')), before);
  });
});
