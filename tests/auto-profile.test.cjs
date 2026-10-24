'use strict';

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
// Fixture projects and stub tools; none of them is a real extraction.
const FIXTURES = path.join(__dirname, 'fixtures', 'auto-profile');
const BIN = path.join(FIXTURES, 'bin');
const PLATFORM = 'aarch64-apple-darwin';
const temporaryDirectories = [];
// Version checks run only where the resolver can confine them (sandbox-exec
// on macOS, bubblewrap on Linux); elsewhere they are skipped as not checked.
// CONFINED holds for the persistent fixtures; a copied fixture under the
// system temp directory needs confinedAt, because bubblewrap refuses /tmp.
let readOnlyRun = null;
let CONFINED = false;

before(async () => {
  ({ readOnlyRun } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'fvs-probe-inventory.mjs')).href));
  CONFINED = confinedAt(FIXTURES);
});

// Probed under the same fixture environment the profile runs in: the Linux
// sandbox planner validates HOME and PATH, so the inherited ones must not
// decide what a test expects.
function confinedAt(cwd, projectRoot = cwd, bin = BIN) {
  return withStubEnvironment(bin, () => readOnlyRun('/bin/sh', ['-c', 'exit 0'], cwd, { projectRoot }).ok);
}

after(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-auto-profile-'));
  temporaryDirectories.push(directory);
  return directory;
}

function stubEnvironment(bin = BIN) {
  return {
    HOME: path.join(FIXTURES, 'home'),
    PATH: [bin, '/usr/bin', '/bin'].join(path.delimiter),
    FVS_TOOLS_HOME: path.join(FIXTURES, 'no-fvs-tools'),
  };
}

// Runs fn with the stub tools as the only tools on PATH, then restores the
// caller's environment.
function withStubEnvironment(bin, fn) {
  const environment = stubEnvironment(bin);
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

// Runs the exported profile in-process under the stub environment, so
// verdicts do not depend on what the test machine has installed.
async function profileOf(projectRoot, { bin, platform = PLATFORM, script = SCRIPT } = {}) {
  const { profile } = await import(pathToFileURL(script).href);
  return withStubEnvironment(bin, () => profile({ projectRoot, platform }));
}

// A copy of the scripts whose pinned probe-aeneas digest is the stub's, so the
// stub passes the official-binary check, as the probe tests do.
function officialStubScripts() {
  const scripts = path.join(temporaryDirectory(), 'scripts');
  fs.mkdirSync(scripts);
  const evidence = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'probe-compatibility.json'), 'utf8'));
  const pinned = evidence.release.assets[PLATFORM].executableSha256;
  const stub = crypto.createHash('sha256').update(fs.readFileSync(path.join(BIN, 'probe-aeneas'))).digest('hex');
  const resolver = fs.readFileSync(path.join(ROOT, 'scripts', 'fvs-probe-inventory.mjs'), 'utf8');
  assert.ok(resolver.includes(pinned), 'the shipped resolver pins the fixture digest');
  fs.writeFileSync(path.join(scripts, 'fvs-probe-inventory.mjs'), resolver.replace(pinned, stub));
  for (const name of ['fvs-auto.mjs', 'fvs-probe-linux.mjs']) {
    fs.copyFileSync(path.join(ROOT, 'scripts', name), path.join(scripts, name));
  }
  return path.join(scripts, 'fvs-auto.mjs');
}

// A stub tool directory with some tools left out.
function binWithout(...absent) {
  const bin = temporaryDirectory();
  for (const name of fs.readdirSync(BIN).filter((entry) => !absent.includes(entry))) {
    fs.symlinkSync(path.join(BIN, name), path.join(bin, name));
  }
  return bin;
}

// A temporary copy of a fixture project, with paths left out or rewritten.
function copyFixture(name, { omit = [], files = {} } = {}) {
  const source = path.join(FIXTURES, name);
  const root = path.join(temporaryDirectory(), name);
  fs.cpSync(source, root, { recursive: true, filter: (entry) => !omit.includes(path.relative(source, entry)) });
  for (const [relative, content] of Object.entries(files)) fs.writeFileSync(path.join(root, relative), content);
  return root;
}

function translation(fields) {
  return JSON.stringify({ note: 'test fixture, not a real extraction', ...fields });
}

// The pilot after an extraction that recorded its own Aeneas and Charon.
function extractedPilot() {
  return copyFixture('pilot', {
    files: {
      'aeneas-config.yml': 'aeneas:\n  commit: "0855ce1b"\n',
      'translation.json': translation({ aeneas_version: '0855ce1b', charon_version: '0.1.274' }),
    },
  });
}

function item(result, id) {
  const found = result.items.find((entry) => entry.id === id);
  assert.ok(found, `no ${id} item`);
  return found;
}

describe('fvs-auto profile confinement probe', () => {
  it('probes confinement under the fixture environment, not the inherited one', () => {
    const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
    // A Windows-mounted PATH entry and a root HOME, both of which the Linux
    // sandbox planner rejects; the profile itself never sees them.
    process.env.PATH = ['/mnt/c/Windows/System32', saved.PATH].join(path.delimiter);
    process.env.HOME = '/';
    try {
      assert.equal(confinedAt(FIXTURES), CONFINED);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('fvs-auto profile verdicts', () => {
  it('reports a fresh pre-extraction project as not extracted yet, with nothing missing', async () => {
    const result = await profileOf(path.join(FIXTURES, 'fresh'));
    assert.equal(item(result, 'probe').verdict, 'not-extracted-yet');
    assert.deepEqual(result.items.filter((entry) => entry.verdict === 'missing').map((entry) => entry.id), []);
  });

  it('does not mistake an Aeneas extraction without translation.json for a fresh project', async () => {
    const project = copyFixture('fresh');
    fs.mkdirSync(path.join(project, 'Fresh'));
    fs.writeFileSync(path.join(project, 'Fresh', 'Funs.lean'),
      '-- THIS FILE WAS AUTOMATICALLY GENERATED BY AENEAS\n-- [fresh]: function definitions\nimport Aeneas\n');
    const probe = item(await profileOf(project), 'probe');
    assert.equal(probe.verdict, 'available-but-unverified');
    assert.match(probe.reason, /^provenance unknown: .*generated translation\.json is missing/);
    assert.equal(probe.evidence.generatedLean, path.join('Fresh', 'Funs.lean'));
  });

  it('reports an absent required tool as missing, with the manual step', async () => {
    const result = await profileOf(path.join(FIXTURES, 'fresh'), { bin: binWithout('lake', 'ao') });
    const lean = item(result, 'lean');
    assert.equal(lean.verdict, 'missing');
    assert.match(lean.reason, /lake is not on PATH/);
    assert.match(lean.nextStep, /Install elan \(https:\/\/github\.com\/leanprover\/elan\)/);
    const ao = item(result, 'ao');
    assert.equal(ao.verdict, 'missing');
    assert.match(ao.nextStep, /Install Agent Orchestrator/);
  });

  it('reports the present but untested pilot tuple as available but unverified, naming the tested tuple', async () => {
    const aeneas = item(await profileOf(path.join(FIXTURES, 'pilot')), 'aeneas');
    assert.equal(aeneas.verdict, 'available-but-unverified');
    assert.match(aeneas.reason, /differs from aeneas-6e167c9b-charon-0\.1\.225-lean-v4\.31\.0/);
    assert.match(aeneas.reason, /Aeneas 0855ce1b8ed3958512b6c19de6bf3035b7acb552 vs 6e167c9b/);
    assert.doesNotMatch(aeneas.reason, /Lean /, 'the pilot shares the tested Lean toolchain');
    if (CONFINED) {
      assert.match(aeneas.reason, /Charon 0\.1\.274 vs 0\.1\.225/);
      assert.equal(aeneas.evidence.charon.version, '0.1.274');
    } else {
      assert.match(aeneas.reason, /Charon unknown vs 0\.1\.225/);
      assert.equal(aeneas.evidence.charon.version, null);
      assert.match(aeneas.evidence.charon.output, /^not checked: /);
    }
  });

  it('reports the same pilot tuple as missing, not unverified, when its binaries are absent', async () => {
    const aeneas = item(await profileOf(copyFixture('pilot', { omit: ['.aeneas'] })), 'aeneas');
    assert.equal(aeneas.verdict, 'missing');
    assert.match(aeneas.reason, /aeneas and charon not found/);
    assert.match(aeneas.nextStep, /nightly-2026\.09\.30-0855ce1/);
  });

  it('counts only Aeneas releases built for this host, keeping foreign ones as evidence', async () => {
    const linux = 'x86_64-unknown-linux-gnu';
    const foreignOnly = item(await profileOf(path.join(FIXTURES, 'pilot'), { platform: linux }), 'aeneas');
    assert.equal(foreignOnly.verdict, 'missing', 'darwin-arm64 binaries are not available on Linux');
    assert.match(foreignOnly.reason, /aeneas and charon not found for x86_64-unknown-linux-gnu/);
    assert.match(foreignOnly.reason, /installed releases are for other hosts: nightly-2026\.09\.30-0855ce1\/darwin-arm64/);
    assert.deepEqual(foreignOnly.evidence.releases.map((entry) => [entry.platform, entry.forHost]), [['darwin-arm64', false]]);

    // darwin-arm64 sorts before linux-x64, so selection must not take the first match.
    const project = copyFixture('pilot');
    const local = path.join(project, '.aeneas', 'releases', 'nightly-2026.09.30-0855ce1', 'linux-x64');
    fs.cpSync(path.join(project, '.aeneas', 'releases', 'nightly-2026.09.30-0855ce1', 'darwin-arm64'), local, { recursive: true });
    const mixed = item(await profileOf(project, { platform: linux }), 'aeneas');
    assert.equal(mixed.verdict, 'available-but-unverified');
    assert.equal(mixed.evidence.aeneas, path.join(local, 'aeneas'));
    assert.equal(mixed.evidence.charon.path, path.join(local, 'charon'));
    assert.deepEqual(mixed.evidence.releases.map((entry) => [entry.platform, entry.forHost]),
      [['darwin-arm64', false], ['linux-x64', true]]);
  });

  it('reports provenance that contradicts a tested tuple on a pinned field as incompatible', async () => {
    const project = copyFixture('tested', {
      files: { 'Lean/translation.json': translation({ aeneas_version: '6e167c9b', charon_version: '0.1.226' }) },
    });
    const probe = item(await profileOf(project), 'probe');
    assert.equal(probe.verdict, 'incompatible');
    assert.match(probe.reason,
      /Aeneas 6e167c9b63a4dafd66d0e0edd9d94669f957ff7b was tested with Charon 0\.1\.225 \(aeneas-6e167c9b-charon-0\.1\.225-lean-v4\.31\.0\); this project has Charon 0\.1\.226/);
    assert.equal(probe.evidence.resolver.status, 'incompatible', 'raw resolver evidence is preserved');
  });

  it('reports disagreeing provenance pins as incompatible', async () => {
    const project = copyFixture('tested', {
      files: { 'Lean/translation.json': translation({ aeneas_version: 'deadbeef', charon_version: '0.1.225' }) },
    });
    const probe = item(await profileOf(project), 'probe');
    assert.equal(probe.verdict, 'incompatible');
    assert.match(probe.reason,
      /^conflict: translation\.json aeneas_version deadbeef does not match lake-manifest\.json aeneas 6e167c9b/);
  });

  it('reports an extracted but untested pilot tuple as unverified with the qualification route', async () => {
    const probe = item(await profileOf(extractedPilot()), 'probe');
    assert.equal(probe.verdict, 'available-but-unverified');
    assert.match(probe.reason,
      /differs from aeneas-6e167c9b-charon-0\.1\.225-lean-v4\.31\.0 \(Aeneas 0855ce1b8ed3958512b6c19de6bf3035b7acb552 vs 6e167c9b63a4dafd66d0e0edd9d94669f957ff7b, Charon 0\.1\.274 vs 0\.1\.225\)/);
    assert.match(probe.nextStep, /run probe-aeneas v0\.20\.0 confined against this project/);
    assert.match(probe.nextStep, /TESTED_TUPLES/);
    assert.equal(probe.evidence.resolver.status, 'incompatible', 'the resolver verdict is kept as raw evidence');
  });

  it('reports the probe as missing, not unverified, when probe-aeneas is absent', async () => {
    const bin = binWithout('probe-aeneas');
    for (const project of [extractedPilot(), copyFixture('tested', { files: { 'Lean/translation.json': '{ not json' } })]) {
      const probe = item(await profileOf(project, { bin }), 'probe');
      assert.equal(probe.verdict, 'missing');
      assert.match(probe.reason, /^probe-aeneas is not installed, and /);
    }
  });

  it('reports a lakefile Aeneas pin that lake-manifest.json has not resolved as unverified until lake update', async () => {
    const lakefile = fs.readFileSync(path.join(FIXTURES, 'pilot', 'lakefile.toml'), 'utf8')
      .replace('nightly-2026.09.30-0855ce1', 'nightly-2026.10.14-1234abc');
    const stale = /lakefile\.toml requires Aeneas nightly-2026\.10\.14-1234abc but lake-manifest\.json resolved nightly-2026\.09\.30-0855ce1/;
    const aeneas = item(await profileOf(copyFixture('pilot', { files: { 'lakefile.toml': lakefile } })), 'aeneas');
    assert.equal(aeneas.verdict, 'available-but-unverified');
    assert.match(aeneas.reason, stale);
    assert.match(aeneas.nextStep, /lake update/);

    const absent = item(await profileOf(copyFixture('pilot', { omit: ['.aeneas'], files: { 'lakefile.toml': lakefile } })), 'aeneas');
    assert.equal(absent.verdict, 'missing', 'an uncertain pin never hides absent binaries');
    assert.match(absent.reason, /aeneas and charon not found/);
    assert.match(absent.reason, stale);
    assert.match(absent.nextStep, /lake update.*install Aeneas and Charon for nightly-2026\.10\.14-1234abc/);
  });

  it('reads the Rust toolchain pin the crate directory sees', async () => {
    const project = copyFixture('tested', { files: { 'rust/rust-toolchain': '1.98.1\n' } });
    const rust = item(await profileOf(project), 'rust');
    assert.equal(rust.evidence.toolchainFile, path.join('rust', 'rust-toolchain'));
    assert.equal(rust.evidence.toolchainPin, '1.98.1');
    assert.match(rust.reason, /pinned by rust\/rust-toolchain/);
    // rustc -vV runs in the crate directory of this copied project.
    if (confinedAt(path.join(project, 'rust'), project)) {
      assert.equal(rust.evidence.version, 'rustc 1.98.1 (fixture stub)');
    } else {
      assert.equal(rust.evidence.version, null);
      assert.match(rust.reason, /the version was not checked: /);
    }
  });

  it('reports hosts by their recorded probe evidence and every other host as unsupported', async () => {
    const project = path.join(FIXTURES, 'fresh');
    const linux = await profileOf(project, { platform: 'x86_64-unknown-linux-gnu' });
    assert.equal(item(linux, 'host').verdict, 'available-but-unverified');
    assert.match(item(linux, 'host').reason,
      /x86_64-unknown-linux-gnu has recorded confined-run evidence only for the probe-aeneas inventory operation/);
    assert.equal(item(linux, 'probe').verdict, 'not-extracted-yet');
    for (const [platform, reason] of [['aarch64-unknown-linux-gnu', /#77/], ['x86_64-pc-windows-msvc', /no Windows binaries/]]) {
      const host = item(await profileOf(project, { platform }), 'host');
      assert.equal(host.verdict, 'unsupported-platform', platform);
      assert.match(host.reason, reason);
    }
  });

  it('reports an Aeneas requirement without a readable revision as unverified, never inventing one', async () => {
    const lakefile = fs.readFileSync(path.join(FIXTURES, 'fresh', 'lakefile.toml'), 'utf8')
      .replace(/^rev = .*\n/m, '');
    const unread = /lakefile\.toml requires aeneas but no revision was read from it/;
    const aeneas = item(await profileOf(copyFixture('fresh', { files: { 'lakefile.toml': lakefile } })), 'aeneas');
    assert.equal(aeneas.verdict, 'available-but-unverified');
    assert.match(aeneas.reason, unread);
    assert.deepEqual(aeneas.evidence.lakefile, { file: 'lakefile.toml', required: true, rev: null });

    const absent = item(await profileOf(copyFixture('fresh', { omit: ['.aeneas'], files: { 'lakefile.toml': lakefile } })), 'aeneas');
    assert.equal(absent.verdict, 'missing', 'an unread pin never hides absent binaries');
    assert.match(absent.reason, /aeneas and charon not found/);
    assert.match(absent.reason, unread);
    assert.match(absent.nextStep, /^Pin the Aeneas rev in the lakefile, then install Aeneas and Charon for it/);
    assert.equal(absent.evidence.lakefile.rev, null, 'no revision is invented');
  });

  it('reports the exact tested tuple on aarch64-apple-darwin as supported and tested, scoped to the probe inventory', async (t) => {
    // The resolver checks probe and helpers only on the actual host and only
    // under confinement; the stub helpers mirror the macOS tested versions.
    if (process.platform !== 'darwin' || process.arch !== 'arm64' || !CONFINED) {
      t.skip('requires the confined macOS arm64 host');
      return;
    }
    const unofficial = item(await profileOf(path.join(FIXTURES, 'tested')), 'probe');
    assert.equal(unofficial.verdict, 'incompatible', 'a probe-aeneas without the pinned digest is not the tested binary');
    assert.match(unofficial.reason, /does not match the pinned executable digest/);

    const result = await profileOf(path.join(FIXTURES, 'tested'), { script: officialStubScripts() });
    const probe = item(result, 'probe');
    assert.equal(probe.verdict, 'supported-and-tested', probe.reason);
    assert.deepEqual(probe.scope, {
      operation: 'probe-aeneas inventory (confined)',
      tuple: 'aeneas-6e167c9b-charon-0.1.225-lean-v4.31.0',
      platform: 'aarch64-apple-darwin',
    });
    assert.equal(probe.nextStep, null);
    assert.deepEqual(result.items.filter((entry) => entry.verdict === 'supported-and-tested').map((entry) => entry.id),
      ['probe'], 'one tested operation qualifies nothing else');
  });

  it('reports malformed or missing provenance as unknown, with the raw evidence and no invented values', async () => {
    for (const [variant, problem, unknownField] of [
      [{ files: { 'Lean/translation.json': '{ not json' } }, /cannot read translation\.json/, 'charonVersion'],
      [{ files: { 'Lean/translation.json': translation({ aeneas_version: '6e167c9b' }) } },
        /translation\.json has no charon_version/, 'charonVersion'],
      [{ omit: ['lake-manifest.json'] }, /cannot read lake-manifest\.json/, 'aeneasRev'],
      [{ files: { 'aeneas-config.yml': 'crate:\n  dir: "rust"\naeneas_args:\n  dest: "../outside"\n' } },
        /aeneas_args\.dest escapes the project root/, 'translationJson'],
    ]) {
      const probe = item(await profileOf(copyFixture('tested', variant)), 'probe');
      assert.equal(probe.verdict, 'available-but-unverified', problem.source);
      assert.match(probe.reason, /^provenance unknown: /);
      assert.match(probe.reason, problem);
      const { resolver } = probe.evidence;
      assert.equal(resolver.status, 'unknown');
      assert.ok(resolver.provenance.problems.some((entry) => problem.test(entry)), 'the raw problem is kept');
      assert.equal(resolver.provenance[unknownField], null, `${unknownField} stays unknown`);
    }
  });
});

describe('fvs-auto profile output', () => {
  function cli(args) {
    return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: stubEnvironment(), encoding: 'utf8' });
  }

  function listing(directory) {
    return fs.readdirSync(directory, { recursive: true }).sort().map((relative) => {
      const stat = fs.statSync(path.join(directory, relative));
      return `${relative} ${stat.size} ${stat.mtimeMs}`;
    });
  }

  it('prints byte-identical JSON across runs and modifies nothing', () => {
    const project = path.join(FIXTURES, 'pilot');
    const before = listing(project);
    const args = ['profile', '--project-root', project, '--format', 'json'];
    const first = cli(args);
    const second = cli(args);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, second.stdout);
    assert.equal(JSON.parse(first.stdout).schema, 'fvs/auto-profile');
    assert.deepEqual(listing(project), before);
    assert.ok(!fs.existsSync(stubEnvironment().FVS_TOOLS_HOME), 'the FVS tool directory is never created');
  });

  it('prints exactly one next step per non-green item as text', () => {
    const project = path.join(FIXTURES, 'tested');
    const json = cli(['profile', '--project-root', project]);
    assert.equal(json.status, 0, json.stderr);
    const text = cli(['profile', '--project-root', project, '--format', 'text']);
    assert.equal(text.status, 0, text.stderr);
    const nonGreen = JSON.parse(json.stdout).items.filter((entry) => entry.verdict !== 'supported-and-tested');
    assert.ok(nonGreen.length > 0);
    assert.deepEqual(text.stdout.split('\n').filter((line) => line.startsWith('  next: ')),
      nonGreen.map((entry) => `  next: ${entry.nextStep}`));
  });

  it('fails with a readable error for an unusable project root or subcommand', () => {
    const absent = cli(['profile', '--project-root', path.join(FIXTURES, 'no-such-project')]);
    assert.equal(absent.status, 2);
    assert.match(absent.stderr, /^FVS_AUTO_ERROR: project root is not a directory: /);
    const unknown = cli(['roots']);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown subcommand "roots"; available: profile/);
  });
});
