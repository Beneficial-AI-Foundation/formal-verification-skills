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
function init(root, { scope = 'the portable NTT module only', confirmOverwrite = false } = {}) {
  const environment = {
    HOME: path.join(PROFILE_FIXTURES, 'home'),
    PATH: [path.join(PROFILE_FIXTURES, 'bin'), '/usr/bin', '/bin'].join(path.delimiter),
    FVS_TOOLS_HOME: path.join(PROFILE_FIXTURES, 'no-fvs-tools'),
  };
  const saved = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try {
    return auto.initState({ projectRoot: root, platform: 'aarch64-apple-darwin', confirmOverwrite,
      choices: { source: { revision: 'HEAD', configuration: 'default features' }, scope, limits: { wallClockHours: 40 } } });
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

describe('run overrides', () => {
  const overridesFile = (root) => path.join(root, '.formalising', 'auto-fv', 'overrides.json');
  const override = (root, key, value, reason) => cli('record-override', '--project-root', root, '--key', key, '--value', value, '--reason', reason);

  it('are recorded with their reason and shown by every later read-state, full and brief', () => {
    const root = project();
    init(root);
    assert.equal(cli('read-state', '--project-root', root).json.overrides, undefined, 'none recorded, none shown');

    const result = override(root, 'pr-base', 'release/3.0.0-rc3', 'the run brief moved the base');
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.json.code, 'recorded');
    assert.match(result.json.message, /do not amend the agreement/);
    assert.equal(result.json.overrides['pr-base'].value, 'release/3.0.0-rc3');

    // Each command below is a new process, as a resumed session would be.
    for (const flags of [[], ['--brief']]) {
      const view = cli('read-state', '--project-root', root, ...flags).json;
      assert.equal(view.overrides['pr-base'].value, 'release/3.0.0-rc3', flags.join(' '));
      assert.equal(view.overrides['pr-base'].reason, 'the run brief moved the base');
      assert.match(view.overridesNote, /do not amend the agreement/);
    }
  });

  it('keep history: a later value for a key is the one in force, an unchanged one writes nothing', () => {
    const root = project();
    init(root);
    override(root, 'pr-base', 'main', 'first brief');
    override(root, 'a2-exception', 'does not apply', 'owner ruling');
    const bytes = fs.readFileSync(overridesFile(root));
    assert.equal(override(root, 'pr-base', 'main', 'again').json.code, 'unchanged');
    assert.deepEqual(fs.readFileSync(overridesFile(root)), bytes, 'nothing was written');

    assert.equal(override(root, 'pr-base', 'release/3.0.0-rc3', 'second brief').json.code, 'recorded');
    const view = cli('read-state', '--project-root', root, '--brief').json;
    assert.deepEqual(Object.keys(view.overrides).sort(), ['a2-exception', 'pr-base']);
    assert.equal(view.overrides['pr-base'].value, 'release/3.0.0-rc3');
    const rows = JSON.parse(fs.readFileSync(overridesFile(root), 'utf8')).overrides;
    assert.deepEqual(rows.map((row) => [row.key, row.value]), [['pr-base', 'main'], ['a2-exception', 'does not apply'], ['pr-base', 'release/3.0.0-rc3']]);
  });

  it('survive a re-init with changed choices, and recording one leaves state.json untouched', () => {
    const root = project();
    init(root);
    const stateFile = path.join(root, '.formalising', 'auto-fv', 'state.json');
    const stateBefore = fs.readFileSync(stateFile);
    override(root, 'pr-base', 'release/3.0.0-rc3', 'brief');
    assert.deepEqual(fs.readFileSync(stateFile), stateBefore, 'the agreement and choices in state.json are not amended');

    const changed = init(root, { scope: 'the whole crate', confirmOverwrite: true });
    assert.equal(changed.code, 'updated');
    assert.equal(cli('read-state', '--project-root', root).json.overrides['pr-base'].value, 'release/3.0.0-rc3');
  });

  it('are refused without state, with a bad key, or without a value or reason, writing nothing', () => {
    const fresh = project();
    assert.equal(override(fresh, 'pr-base', 'main', 'why').json.code, 'no-state');
    const root = project();
    init(root);
    for (const [key, value, reason, code] of [['PR base', 'main', 'why', 'usage'], ['pr-base', ' ', 'why', 'usage'], ['pr-base', 'main', ' ', 'usage'], ['', 'main', 'why', 'usage']]) {
      assert.equal(cli('record-override', '--project-root', root, '--key', key, '--value', value, '--reason', reason).json.code, code, JSON.stringify([key, value, reason]));
    }
    assert.equal(cli('record-override', '--project-root', root, '--key', 'pr-base', '--value', 'main').status, 2, 'the reason is required');
    assert.equal(fs.existsSync(overridesFile(root)), false);
  });

  it('a malformed overrides file is reported with exit 3 and never overwritten', () => {
    const root = project();
    init(root);
    fs.writeFileSync(overridesFile(root), '{"schema":"fvs/auto-overrides","schemaVersion":1,"overrides":[{"key":"pr-base"}]}');
    const before = fs.readFileSync(overridesFile(root));
    for (const result of [cli('read-state', '--project-root', root), override(root, 'pr-base', 'main', 'why')]) {
      assert.equal(result.status, 3);
      assert.equal(result.json.code, 'malformed-overrides');
    }
    assert.deepEqual(fs.readFileSync(overridesFile(root)), before);
  });
});

describe('list-items', () => {
  const fn = (rust, file, line, extra = {}) => ({ def_id: line, lean_name: rust.replace(/::/g, '.'), lean_file: 'Demo.lean', rust_name: rust, is_local: true,
    source: { file, begin_line: line, end_line: line + 3 }, is_opaque: false, can_fail: true, ...extra });
  const TRANSLATION = {
    aeneas_version: 'nightly-2026.09.30', charon_version: '0.1.274', crate: 'libcrux_hmac',
    functions: [
      fn('libcrux_hmac::hmac::hmac', 'src/hmac.rs', 40),
      fn('libcrux_hmac::hkdf::expand', 'src/hkdf.rs', 5),
      fn('libcrux_hmac::hmac::{impl libcrux_hmac::hmac::Mac}::new', 'src/hmac.rs', 10),
      fn('core::cmp::min', null, 0, { is_local: false, source: undefined }),
      fn('libcrux_hmac::util::wipe', 'src/util.rs', 3, { is_opaque: true }),
    ],
    types: [], globals: [], trait_decls: [], trait_impls: [],
  };
  function withTranslation(data) {
    const root = project();
    const file = path.join(root, 'translation.json');
    fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
    return { root, file };
  }
  const list = (root, ...extra) => cli('list-items', '--project-root', root, '--translation', 'translation.json', ...extra);

  it('lists the local translated functions in source order and counts what it left out', () => {
    const { root, file } = withTranslation(TRANSLATION);
    const result = list(root);
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(result.json.items.map((item) => [item.source.file, item.source.beginLine, item.rustName]), [
      ['src/hkdf.rs', 5, 'libcrux_hmac::hkdf::expand'],
      ['src/hmac.rs', 10, 'libcrux_hmac::hmac::{impl libcrux_hmac::hmac::Mac}::new'],
      ['src/hmac.rs', 40, 'libcrux_hmac::hmac::hmac'],
      ['src/util.rs', 3, 'libcrux_hmac::util::wipe'],
    ]);
    assert.deepEqual(result.json.excluded, { notLocal: 1, outOfScope: 0 });
    assert.equal(result.json.items[3].opaque, true);
    assert.equal(result.json.crate, 'libcrux_hmac');
    assert.equal(result.json.translationSha256, sha256(fs.readFileSync(file)));
    assert.match(result.json.visibility, /^not recorded: translation\.json holds no visibility/);
  });

  it('narrows to an explicit scope: a source file, a directory or a whole Rust path segment', () => {
    const { root } = withTranslation(TRANSLATION);
    const names = (...scope) => list(root, '--scope', scope.join(',')).json.items.map((item) => item.rustName);
    assert.deepEqual(names('src/hmac.rs'), ['libcrux_hmac::hmac::{impl libcrux_hmac::hmac::Mac}::new', 'libcrux_hmac::hmac::hmac']);
    assert.equal(names('src').length, 4, 'a directory takes everything under it');
    assert.deepEqual(names('libcrux_hmac::hkdf'), ['libcrux_hmac::hkdf::expand']);
    assert.deepEqual(names('libcrux_hmac::hkdf::expand'), ['libcrux_hmac::hkdf::expand'], 'a full item path');
    assert.deepEqual(names('libcrux_hmac::hm'), [], 'a prefix must end at a path segment');
    assert.deepEqual(names('src/hm'), [], 'nor may a file prefix cut a name');
    assert.deepEqual(names('src/hkdf.rs', 'src/util.rs').length, 2, 'several scopes add up');
    assert.deepEqual(list(root, '--scope', 'src/hkdf.rs').json.excluded, { notLocal: 1, outOfScope: 3 });
  });

  it('names a wrong shape instead of failing inside a loop over its entries', () => {
    for (const [label, data, pattern] of [
      ['a top-level list', [], /found a list/],
      ['a top-level string', '"text"', /found string/],
      ['an object with no functions list', { crate: 'x' }, /"functions" list/],
      ['functions as text', { functions: 'x' }, /"functions" list/],
      ['an entry that is text', { functions: ['x'] }, /functions\[0\] must be an object/],
      ['an entry without a rust_name', { functions: [{ lean_name: 'a', is_local: true }] }, /functions\[0\] must be an object/],
      ['invalid JSON', '{', /cannot read .* as JSON/],
    ]) {
      const { root } = withTranslation(data);
      const result = list(root);
      assert.equal(result.status, 1, label);
      assert.equal(result.json.code, 'invalid-input', label);
      assert.match(result.json.message, pattern, label);
    }
    assert.equal(cli('list-items', '--project-root', project(), '--translation', 'missing.json').json.code, 'invalid-input');
  });

  it('without --translation it needs a succeeded extraction that names one', () => {
    const root = project();
    const none = cli('list-items', '--project-root', root);
    assert.equal(none.json.code, 'invalid-input');
    assert.match(none.json.message, /pass --translation PATH/);

    init(root);
    const published = path.join(root, 'Demo', 'translation.json');
    fs.mkdirSync(path.dirname(published));
    fs.writeFileSync(published, JSON.stringify(TRANSLATION));
    const hash = sha256(fs.readFileSync(published));
    const stateFile = path.join(root, '.formalising', 'auto-fv', 'state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const zeros = '0'.repeat(64);
    // A structurally complete record of a succeeded extraction; nothing here runs a tool.
    state.extraction = {
      status: 'succeeded', recordedAt: '2026-11-19T00:00:00.000Z', reasons: [], note: 'not a proof',
      selected: { ...state.choices.source },
      declared: { buildExitCode: 0, oracle: 'complete' },
      checks: { status: { ok: true }, 'verify-tree': { ok: true }, 'verify-restore': { ok: true } },
      inputs: { out: path.join(root, 'copy'), manifestSha256: zeros, crateRoot: root, mode: 'translation-patches', sourceCommit: 'a'.repeat(40), patches: [] },
      run: {
        attemptSha256: zeros, manifestSha256: zeros, configSha256: zeros, config: {}, supported: true, residuals: [], trust: 'local-host-and-reviewed-scripts',
        stages: { charon: zeros, aeneas: zeros, publish: zeros }, llbc: { path: 'demo.llbc', sha256: zeros },
        translation: { attemptPath: '/attempt/translation.json', projectPath: published, sha256: hash },
        publication: [{ attemptPath: '/attempt/translation.json', projectPath: published, sha256: hash }],
      },
    };
    fs.writeFileSync(stateFile, JSON.stringify(state));
    const result = cli('list-items', '--project-root', root, '--scope', 'src/hmac.rs');
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.json.translation, published);
    assert.equal(result.json.items.length, 2);

    state.extraction.status = 'failed';
    state.extraction.reasons = ['the build exited 1'];
    state.extraction.declared.buildExitCode = 1;
    fs.writeFileSync(stateFile, JSON.stringify(state));
    assert.equal(cli('list-items', '--project-root', root).json.code, 'invalid-input', 'a failed extraction names no translation');
  });
});
