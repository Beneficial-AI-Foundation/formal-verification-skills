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

test('the update banner appears only when the published latest is a higher SemVer version', async () => {
  for (const [installed, latest, expected] of [
    ['2.3.11', '2.3.12', true],
    ['2.3.12', '2.3.12', false],
    ['3.0.0-rc1', '2.3.12', false],
    ['3.0.0-rc1', '3.0.0', true],
    ['3.0.0-rc.2', '3.0.0-rc.10', true],
    ['2.4.0', '2.3.12', false],
    ['2.3.12', 'not-a-version', false],
    [null, '2.3.12', false],
  ]) {
    const result = await banner(installed, latest);
    assert.equal(result.update_available === true, expected, `installed ${installed}, latest ${latest}`);
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

  test(`${runtime}: the installed comparison block orders SemVer prereleases correctly`, () => {
    const { doc, project } = installed(runtime, 'global');
    const compare = block(doc, 'compare_versions');
    for (const [installedVersion, latest, expected] of [
      ['2.3.11', '2.3.12', 'update'],
      ['2.3.12', '2.3.12', 'current'],
      ['3.0.0-rc1', '2.3.12', 'ahead'],
      ['3.0.0-rc1', '3.0.0', 'update'],
      ['3.0.0-rc.2', '3.0.0-rc.10', 'update'],
      ['2.4.0', '2.3.12', 'ahead'],
      ['2.3.12', 'not-a-version', 'unknown'],
    ]) {
      const run = bash(compare, project, { INSTALLED: installedVersion, LATEST: latest });
      assert.equal(run.stdout.trim(), expected, `installed ${installedVersion}, latest ${latest}: ${run.stderr}`);
    }
  });
}

test('the update command never downgrades a prerelease to an older latest (text guard)', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'commands/fvs/update.md'), 'utf8');
  for (const token of ['npx fv-skills-baif@next', 'npx fv-skills-baif@<version>', 'Never run `@latest` from a prerelease that is ahead of it']) {
    assert.ok(doc.includes(token), token);
  }
  assert.ok(/for dir in \.claude \.codex /.test(doc), 'the cache clear covers Codex');
});

test('the Pi update skill pins prereleases and never treats an unknown version as old (text guard)', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'pi/skills/fvs-update/SKILL.md'), 'utf8');
  for (const token of ['pi update npm:fv-skills-baif', 'npm:fv-skills-baif@<version>', 'npm:fv-skills-baif@next',
    'never the bare `npm:fv-skills-baif`', 'the installed version cannot be determined']) assert.ok(skill.includes(token), token);
});

test('the installer refuses to replace a higher installed version unless explicitly allowed', () => {
  const home = tmp('fvs-downgrade-'), project = path.join(home, 'project');
  fs.mkdirSync(project);
  const versionFile = path.join(home, '.codex', 'fv-skills', 'VERSION');
  fs.mkdirSync(path.dirname(versionFile), { recursive: true });
  fs.writeFileSync(versionFile, '99.0.0\n');
  const run = (...flags) => spawnSync(process.execPath, [INSTALLER, '--claude', '--codex', '--global', ...flags], { cwd: project, env: env({ HOME: home }), encoding: 'utf8', input: '' });
  const refused = run();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr + refused.stdout, /99\.0\.0 is newer than this installer/);
  assert.equal(fs.readFileSync(versionFile, 'utf8'), '99.0.0\n', 'the higher install is untouched');
  assert.equal(fs.existsSync(path.join(home, '.claude')), false, 'no other runtime is touched before the refusal');
  const allowed = run('--allow-downgrade');
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(fs.readFileSync(versionFile, 'utf8').trim(), PKG_VERSION);
});
