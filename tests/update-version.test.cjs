'use strict';
// Version checks around updates: the SessionStart update banner, the installed update command's location and
// comparison blocks, the Pi update skill and the installer's downgrade refusal. Fixture versions are explicit
// and independent of the package version, so these tests hold on any release line.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const INSTALLER = path.join(ROOT, 'bin', 'install.js');
const HOOK = path.join(ROOT, 'hooks', 'fvs-check-update.js');
const PKG_VERSION = require('../package.json').version;
const owned = [];
after(() => { for (const p of owned) fs.rmSync(p, { recursive: true, force: true }); });
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); owned.push(d); return fs.realpathSync(d); };
// Never let a developer's real config directories leak into a fixture HOME.
const env = (extra) => { const e = { ...process.env, ...extra }; for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME']) delete e[k]; return e; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function banner(installed, latest) {
  const home = tmp('fvs-banner-'), bin = path.join(home, 'bin'), project = path.join(home, 'project');
  fs.mkdirSync(bin); fs.mkdirSync(project);
  if (installed !== null) {
    fs.mkdirSync(path.join(home, '.claude', 'fv-skills'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'fv-skills', 'VERSION'), installed + '\n');
  }
  // The only PATH entry is a fake npm; no Aeneas sync metadata exists, so the check makes no network call.
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\necho '${latest}'\n`, { mode: 0o755 });
  const run = spawnSync(process.execPath, [HOOK], { cwd: project, env: env({ HOME: home, PATH: bin }), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const cache = path.join(home, '.claude', 'cache', 'fvs-update-check.json');
  for (let i = 0; i < 200; i++) {
    try { return JSON.parse(fs.readFileSync(cache, 'utf8')); } catch { await sleep(50); }
  }
  throw new Error('update check wrote no cache');
}

// [installed, latest, expected]: the SemVer verdict for moving from installed to latest. Every comparison copy (the
// update hook, the installer and the installed update command) is checked against this one table.
const CASES = [
  ['2.3.11', '2.3.12', 'update'],
  ['2.3.12', '2.3.12', 'current'],
  ['3.0.0-rc1', '2.3.12', 'ahead'],
  ['3.0.0-rc1', '3.0.0', 'update'],
  ['3.0.0-rc.2', '3.0.0-rc.10', 'update'],
  ['2.4.0', '2.3.12', 'ahead'],
  ['1.0.0+build.5', '1.0.0', 'current'],
  ['3.0.0-rc.9007199254740992', '3.0.0-rc.9007199254740993', 'update'],
  ['9007199254740993.0.0', '9007199254740992.0.0', 'ahead'],
  // The SemVer 2.0.0 precedence example, pairwise.
  ...['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0']
    .map((v, i, all) => [v, all[i + 1], 'update']).slice(0, -1),
  ['2.3.12', 'not-a-version', 'unknown'],
  ['3.0.0-rc..1', '3.0.0', 'unknown'],
  ['3.0.0-01', '3.0.0', 'unknown'],
  ['03.0.0', '3.0.0', 'unknown'],
  ['1.0.0+', '1.0.0', 'unknown'],
  ['1.0.0+a..b', '1.0.0', 'unknown'],
  ['', '1.0.0', 'unknown'],
];

test('the update banner appears only when the published latest is a higher SemVer version', async () => {
  for (const [installed, latest, expected] of [...CASES, [null, '2.3.12', 'unknown']]) {
    const result = await banner(installed, latest);
    assert.equal(result.update_available === true, expected === 'update', `installed ${installed}, latest ${latest}`);
  }
});

test('the installer comparison matches the shared SemVer table', () => {
  const { semverCompare } = require('../bin/install.js');
  assert.equal(typeof semverCompare, 'function');
  for (const [installed, latest, expected] of CASES) {
    assert.equal(semverCompare(installed, latest), { update: -1, current: 0, ahead: 1, unknown: null }[expected], `${installed} vs ${latest}`);
  }
});

const RUNTIMES = {
  claude: '.claude/commands/fvs/update.md',
  opencode: '.config/opencode/command/fvs-update.md',
  antigravity: '.gemini/config/plugins/fvs/skills/update/references/update.md',
  codex: '.codex/skills/fvs-update/SKILL.md',
};
const LOCAL_VERSION = { claude: '.claude', opencode: '.opencode', antigravity: '.agents/plugins/fvs', codex: '.codex' };
const block = (doc, step) => {
  const m = new RegExp(`<step name="${step}">[\\s\\S]*?\`\`\`bash\\n([\\s\\S]*?)\`\`\``).exec(doc);
  assert.ok(m, `no bash block in step ${step}`);
  return m[1];
};
const bash = (script, cwd, extra) => spawnSync('bash', ['-c', script], { cwd, env: env(extra), encoding: 'utf8' });
function installed(runtime, scope, home = tmp('fvs-update-home-')) {
  const project = path.join(home, 'project');
  fs.mkdirSync(project, { recursive: true });
  const run = spawnSync(process.execPath, [INSTALLER, '--' + runtime, '--' + scope], { cwd: project, env: env({ HOME: home }), encoding: 'utf8', input: '' });
  assert.equal(run.status, 0, run.stderr);
  const doc = fs.readFileSync(path.join(scope === 'global' ? home : project, scope === 'global' ? RUNTIMES[runtime] : RUNTIMES[runtime].replace('.config/opencode', '.opencode').replace('.gemini/config/plugins/fvs', '.agents/plugins/fvs')), 'utf8');
  return { home, project, doc };
}

for (const runtime of Object.keys(RUNTIMES)) {
  test(`${runtime}: the installed update command finds its own global and local install, and an unknown one stops`, () => {
    const g = installed(runtime, 'global'), detect = (doc, cwd, home = g.home) => bash(block(doc, 'get_installed_version'), cwd, { HOME: home }).stdout.trim().split('\n');
    const plain = path.join(g.home, 'plain');
    fs.mkdirSync(plain);
    assert.deepEqual(detect(g.doc, plain), [PKG_VERSION, 'GLOBAL'], 'global install from a project without a local one');
    assert.deepEqual(detect(g.doc, g.home), [PKG_VERSION, 'GLOBAL'], 'global install from $HOME itself');
    const l = installed(runtime, 'local', g.home);
    assert.ok(fs.existsSync(path.join(l.project, LOCAL_VERSION[runtime], 'fv-skills', 'VERSION')));
    assert.deepEqual(detect(l.doc, l.project), [PKG_VERSION, 'LOCAL'], 'local install, with a global one too');
    assert.deepEqual(detect(g.doc, l.project), [PKG_VERSION, 'LOCAL'], 'the local install takes priority');
    const bare = tmp('fvs-update-bare-');
    assert.deepEqual(detect(g.doc, bare, bare), ['UNKNOWN']);
    assert.doesNotMatch(g.doc, /0\.0\.0|fresh install|\(or unknown\)/, 'an unknown install is never treated as version 0.0.0');
    assert.match(g.doc, /If "UNKNOWN": the installed version cannot be determined\. STOP/);
  });

  test(`${runtime}: the installed comparison block matches the shared SemVer table`, () => {
    const { doc, project } = installed(runtime, 'global');
    const compare = block(doc, 'compare_versions');
    for (const [installedVersion, latest, expected] of CASES) {
      const run = bash(compare, project, { INSTALLED: installedVersion, LATEST: latest });
      assert.equal(run.stdout.trim(), expected, `installed ${installedVersion}, latest ${latest}: ${run.stderr}`);
    }
  });

  test(`${runtime}: no installed file keeps the old unknown-as-0.0.0 update route`, () => {
    const { home } = installed(runtime, 'global');
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
    for (const file of walk(home).filter((f) => f.endsWith('.md'))) {
      assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /treat as (version )?0\.0\.0|Running fresh install/, file);
    }
  });
}

test('the update command pins a verified version and never uses a floating tag (text guard)', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'commands/fvs/update.md'), 'utf8');
  for (const token of ['npm view fv-skills-baif dist-tags.next', 'npx fv-skills-baif@<version>',
    'Never run `@latest` from a prerelease that is ahead of it', 'never a floating `@next`']) assert.ok(doc.includes(token), token);
  assert.ok(!doc.includes('npx fv-skills-baif@next'), 'no unchecked @next install');
  assert.ok(!doc.includes('`npx fv-skills-baif --global`'), 'no bare manual install advice');
  assert.ok(doc.includes('a bare `npx fv-skills-baif` installs npm latest'));
  assert.ok(/for dir in \.claude \.codex /.test(doc), 'the cache clear covers Codex');
});

test('the Pi update skill pins a verified version and never treats an unknown version as old (text guard)', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'pi/skills/fvs-update/SKILL.md'), 'utf8');
  for (const token of ['pi update npm:fv-skills-baif', 'pi install npm:fv-skills-baif@<version>', 'npm view fv-skills-baif dist-tags',
    'never the bare `npm:fv-skills-baif` or a floating tag', 'the installed version cannot be determined']) assert.ok(skill.includes(token), token);
  assert.ok(!skill.includes('npm:fv-skills-baif@next'), 'no unchecked @next source');
});

const installer = (home, cwd, flags, extra = {}) => spawnSync(process.execPath, [INSTALLER, ...flags], { cwd, env: env({ HOME: home, ...extra }), encoding: 'utf8', input: '' });

test('the installer refuses to replace a higher or unknown installed version unless explicitly allowed', () => {
  // Each seed shapes an existing Codex install; the snapshot proves the refusal changed nothing.
  const MANIFEST = 'fvs-file-manifest.json';
  for (const [name, seed, message] of [
    ['a higher version', (d) => fs.writeFileSync(path.join(d, 'fv-skills/VERSION'), '99.0.0\n'), /99\.0\.0 is newer than this installer/],
    ['a higher manifest version without VERSION', (d) => fs.writeFileSync(path.join(d, MANIFEST), JSON.stringify({ version: '99.0.0', files: {} })), /99\.0\.0 is newer than this installer/],
    ['an invalid version', (d) => fs.writeFileSync(path.join(d, 'fv-skills/VERSION'), 'UNKNOWN\n'), /Cannot read a valid installed FVS version/],
    ['an empty version', (d) => fs.writeFileSync(path.join(d, 'fv-skills/VERSION'), ''), /Cannot read a valid installed FVS version/],
    ['an unreadable version', (d) => fs.writeFileSync(path.join(d, 'fv-skills/VERSION'), '1.0.0\n', { mode: 0 }), /Cannot read a valid installed FVS version/],
    ['a version path that is a directory', (d) => fs.mkdirSync(path.join(d, 'fv-skills/VERSION')), /Cannot read a valid installed FVS version/],
  ]) {
    const home = tmp('fvs-downgrade-'), project = path.join(home, 'project'), codex = path.join(home, '.codex');
    fs.mkdirSync(project);
    fs.mkdirSync(path.join(codex, 'fv-skills'), { recursive: true });
    seed(codex);
    const snapshot = () => spawnSync('ls', ['-lR', codex], { encoding: 'utf8' }).stdout;
    const before = snapshot();
    const refused = installer(home, project, ['--claude', '--codex', '--global']);
    assert.notEqual(refused.status, 0, name);
    assert.match(refused.stderr + refused.stdout, message, name);
    assert.equal(snapshot(), before, name + ': the existing install is untouched');
    assert.equal(fs.existsSync(path.join(home, '.claude')), false, name + ': no other runtime is touched before the refusal');
    if (name === 'a higher version') {
      const allowed = installer(home, project, ['--claude', '--codex', '--global', '--allow-downgrade']);
      assert.equal(allowed.status, 0, allowed.stderr);
      assert.equal(fs.readFileSync(path.join(codex, 'fv-skills/VERSION'), 'utf8').trim(), PKG_VERSION);
    }
  }
});

// A fake `pi` that answers capability checks and logs every mutating call.
function fakePi(root) {
  const bin = path.join(root, 'bin'), log = path.join(root, 'pi-argv.jsonl');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'pi'), `#!${process.execPath}\nconst fs=require('fs');const a=process.argv.slice(2);\nif(a[0]==='--version'){console.log('0.85.1');process.exit(0)}\nif(a[1]==='--help'){console.log('Usage: pi '+a[0]+' <source> [--local]');process.exit(0)}\nfs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');\n`, { mode: 0o755 });
  return { path: `${bin}${path.delimiter}${process.env.PATH}`, calls: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}
const piSettings = (file, ...packages) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ packages })); };

test('the Pi installer refuses a lower, unverified or unknown replacement before any Pi call', () => {
  for (const [name, setup, flags, expected] of [
    ['floating latest over a pinned prerelease', (h) => piSettings(path.join(h, '.pi/agent/settings.json'), 'npm:fv-skills-baif@99.0.0-rc1'), ['--pi', '--global'], /pinned at 99\.0\.0-rc1/],
    ['a lower exact version', (h) => piSettings(path.join(h, '.pi/agent/settings.json'), 'npm:fv-skills-baif@99.0.0'), ['--pi', '--global', '--pi-version', '98.0.0'], /99\.0\.0 is newer than the requested 98\.0\.0/],
    ['a lower exact version in project scope', (h, p) => piSettings(path.join(p, '.pi/settings.json'), 'npm:fv-skills-baif@99.0.0'), ['--pi', '--local', '--pi-version', '98.0.0'], /99\.0\.0 is newer than the requested 98\.0\.0/],
    ['an unknown pinned tag', (h) => piSettings(path.join(h, '.pi/agent/settings.json'), 'npm:fv-skills-baif@next'), ['--pi', '--global', '--pi-version', '99.0.1'], /cannot be compared/],
    ['moving away a higher opposite-scope pin', (h) => piSettings(path.join(h, '.pi/agent/settings.json'), 'npm:fv-skills-baif@99.0.0'), ['--pi', '--local', '--pi-version', '98.0.0', '--pi-conflict', 'move'], /99\.0\.0 is newer than the requested 98\.0\.0/],
    ['moving away an exact pin for the floating latest', (h) => piSettings(path.join(h, '.pi/agent/settings.json'), 'npm:fv-skills-baif@2.3.3'), ['--pi', '--local', '--pi-conflict', 'move'], /pinned at 2\.3\.3/],
    ['a mixed selection', (h) => piSettings(path.join(h, '.pi/agent/settings.json'), 'npm:fv-skills-baif@99.0.0'), ['--pi', '--codex', '--global', '--pi-version', '98.0.0'], /99\.0\.0 is newer than the requested 98\.0\.0/],
  ]) {
    const home = tmp('fvs-pi-guard-'), project = path.join(home, 'project');
    fs.mkdirSync(project);
    setup(home, project);
    const pi = fakePi(home), run = installer(home, project, flags, { PATH: pi.path });
    assert.notEqual(run.status, 0, name);
    assert.match(run.stderr + run.stdout, expected, name);
    assert.deepEqual(pi.calls(), [], name + ': no Pi install or remove ran');
    assert.equal(fs.existsSync(path.join(home, '.codex')), false, name + ': no other runtime was touched');
  }
});

test('the Pi installer still installs a verified higher version, a floating update or an explicit override', () => {
  for (const [name, source, flags, call] of [
    ['a higher exact version', 'npm:fv-skills-baif@99.0.0', ['--pi', '--global', '--pi-version', '99.0.1'], ['install', 'npm:fv-skills-baif@99.0.1']],
    ['floating latest over floating latest', 'npm:fv-skills-baif', ['--pi', '--global'], ['install', 'npm:fv-skills-baif']],
    ['an explicit override', 'npm:fv-skills-baif@99.0.0', ['--pi', '--global', '--pi-version', '98.0.0', '--allow-downgrade'], ['install', 'npm:fv-skills-baif@98.0.0']],
  ]) {
    const home = tmp('fvs-pi-ok-'), project = path.join(home, 'project');
    fs.mkdirSync(project);
    piSettings(path.join(home, '.pi/agent/settings.json'), source);
    const pi = fakePi(home), run = installer(home, project, flags, { PATH: pi.path });
    assert.equal(run.status, 0, name + ': ' + run.stderr);
    assert.deepEqual(pi.calls(), [call], name);
  }
});
