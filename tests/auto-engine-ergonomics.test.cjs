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

describe('record-spec --commit', () => {
  const SPEC = 'formal/specs/Specs/Hmac.lean';
  const SPEC_TEXT = 'recall hmac_spec\n';

  // The primary checkout stays on the default branch, which holds no spec file;
  // the spec lives only on the spec branch, as when an author pushed it.
  function checkoutWithSpecBranch(directory = '') {
    const repository = temporaryDirectory('fvs-ergonomics-specs-');
    const root = path.join(repository, directory);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'README.md'), 'project\n');
    git(repository, 'init', '-q', '-b', 'main');
    fs.appendFileSync(path.join(repository, '.git', 'info', 'exclude'), '.formalising/\n');
    git(repository, 'add', '-A');
    git(repository, 'commit', '-q', '-m', 'project');
    git(repository, 'checkout', '-q', '-b', 'specs');
    fs.mkdirSync(path.dirname(path.join(root, SPEC)), { recursive: true });
    fs.writeFileSync(path.join(root, SPEC), SPEC_TEXT);
    git(repository, 'add', '-A');
    git(repository, 'commit', '-q', '-m', 'spec');
    const specCommit = git(repository, 'rev-parse', 'HEAD');
    git(repository, 'checkout', '-q', 'main');
    fs.mkdirSync(path.join(root, '.formalising'), { recursive: true });
    fs.writeFileSync(path.join(root, '.formalising', 'review.md'), 'round 1: pass\n');
    return { repository, root, specCommit };
  }

  const record = (root, ...extra) => cli('record-spec', '--project-root', root, '--spec-file', SPEC, '--items', 'libcrux_hmac::hmac',
    '--round', '1', '--verdict', 'pass', '--review', '.formalising/review.md', ...extra);

  it('hashes the spec file from the commit and leaves the checkout alone', () => {
    const { repository, root, specCommit } = checkoutWithSpecBranch();
    const headBefore = git(repository, 'rev-parse', 'HEAD');
    assert.equal(fs.existsSync(path.join(root, SPEC)), false, 'the checkout holds no spec file');

    const result = record(root, '--commit', specCommit);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.json.row.specSha256, sha256(SPEC_TEXT));
    assert.equal(result.json.row.commit, specCommit);
    assert.equal(result.json.row.reviewSha256, sha256('round 1: pass\n'), 'the review report is still read from disk');

    assert.equal(git(repository, 'rev-parse', 'HEAD'), headBefore, 'HEAD did not move');
    assert.equal(git(repository, 'symbolic-ref', '--short', 'HEAD'), 'main', 'no detached HEAD');
    assert.equal(git(repository, 'status', '--porcelain'), '', 'no file in the checkout changed');
    assert.equal(fs.existsSync(path.join(root, SPEC)), false);
  });

  it('spec-status and record-pr judge the spec file at a commit when the checkout has none', () => {
    const { root, specCommit } = checkoutWithSpecBranch();
    assert.equal(record(root, '--commit', specCommit).status, 0);

    const onDisk = cli('spec-status', '--project-root', root).json;
    assert.deepEqual([onDisk.specFiles[0].missing, onDisk.readyForPr], [true, false], 'the checkout alone cannot show the file');
    const atCommit = cli('spec-status', '--project-root', root, '--commit', specCommit).json;
    assert.equal(atCommit.commit, specCommit);
    assert.deepEqual([atCommit.specFiles[0].stale, atCommit.specFiles[0].missing, atCommit.readyForPr], [false, false, true]);

    const pr = cli('record-pr', '--project-root', root, '--kind', 'spec', '--url', 'https://example.invalid/pr/1', '--branch', 'specs', '--head', specCommit);
    assert.equal(pr.status, 0, pr.stdout);
    assert.deepEqual(pr.json.warnings, [], 'readiness is judged at the PR head');
  });

  it('a commit whose file differs from the recorded bytes is stale', () => {
    const { repository, root, specCommit } = checkoutWithSpecBranch();
    assert.equal(record(root, '--commit', specCommit).status, 0);
    git(repository, 'checkout', '-q', 'specs');
    fs.appendFileSync(path.join(repository, SPEC), '-- edited\n');
    git(repository, 'commit', '-qam', 'edit');
    const edited = git(repository, 'rev-parse', 'HEAD');
    git(repository, 'checkout', '-q', 'main');
    const view = cli('spec-status', '--project-root', root, '--commit', edited).json;
    assert.deepEqual([view.specFiles[0].stale, view.readyForPr], [true, false]);
  });

  it('works when the project root is a subdirectory of the repository', () => {
    const { root, specCommit } = checkoutWithSpecBranch('verify');
    const result = record(root, '--commit', specCommit);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.json.row.specSha256, sha256(SPEC_TEXT));
    assert.equal(cli('spec-status', '--project-root', root, '--commit', specCommit).json.readyForPr, true);
  });

  it('refuses a commit that is not local, a missing file, a directory and a path outside the root, writing nothing', () => {
    const { root, specCommit } = checkoutWithSpecBranch();
    for (const [args, pattern] of [
      [['--commit', 'f'.repeat(40)], /is not a local commit/],
      [['--commit', specCommit, '--spec-file', 'formal/specs/Specs/Missing.lean'], /is not a file in commit/],
      [['--commit', specCommit, '--spec-file', 'formal/specs/Specs'], /is not a file in commit/],
      [['--commit', specCommit, '--spec-file', '../Outside.lean'], /must name a file inside the project root/],
      [['--commit', specCommit, '--spec-file', path.join(path.dirname(root), 'Outside.lean')], /must name a file inside the project root/],
    ]) {
      const flags = args.includes('--spec-file') ? [] : ['--spec-file', SPEC];
      const result = cli('record-spec', '--project-root', root, ...flags, '--items', 'libcrux_hmac::hmac', '--round', '1', '--verdict', 'pass',
        '--review', '.formalising/review.md', ...args);
      assert.equal(result.json.code, 'invalid-input', args.join(' '));
      assert.match(result.json.message, pattern);
      assert.equal(fs.existsSync(path.join(root, '.formalising', 'auto-fv', 'specs.json')), false, 'a refusal writes nothing');
    }
    assert.equal(cli('spec-status', '--project-root', root, '--commit', 'f'.repeat(40)).json.code, 'invalid-input');
  });

  it('without --commit it still reads the working tree, as before', () => {
    const { repository, root } = checkoutWithSpecBranch();
    git(repository, 'checkout', '-q', 'specs');
    const result = record(root);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.json.row.commit, undefined);
    assert.equal(cli('spec-status', '--project-root', root).json.readyForPr, true);
  });
});
