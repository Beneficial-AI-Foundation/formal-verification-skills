#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../..');
const PIN = '958f4b7389ba698b0a6a26a1e505ae2af82364d2';
const INTEGRITY = 'sha512-LUHR/+3D3evhwejiMfBStH7ndqJkV9UlwkjH1LpQ8j1g1cJO1yrXs+R+xS0AuV6E7iX0uZt44xEMAPZC+o40nA==';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function canonicalDirectory(directory) {
  assert.ok(path.isAbsolute(directory), 'absolute owned root required');
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), `symlink/non-directory ancestor: ${current}`);
  }
  assert.equal(fs.realpathSync(directory), directory);
}
function verifyFile(record) {
  const stat = fs.lstatSync(record.path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `nonregular qualified file: ${record.path}`);
  assert.equal(digest(fs.readFileSync(record.path)), record.sha256, `integrity mismatch: ${record.path}`);
  if (record.bytes !== undefined) assert.equal(stat.size, record.bytes);
}
function validateQualification(file, acceptanceFile, env = process.env) {
  assert.ok(file && acceptanceFile, 'explicit qualification and parent acceptance required before invocation');
  assert.equal(env.DISABLE_TELEMETRY, '1', 'telemetry opt-out required before invocation');
  assert.equal(env.DO_NOT_TRACK, '1', 'tracking opt-out required before invocation');
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1048576, 'unsafe qualification');
  const bytes = fs.readFileSync(file);
  const q = JSON.parse(bytes);
  const a = JSON.parse(fs.readFileSync(acceptanceFile, 'utf8'));
  assert.equal(a.packet, file);
  assert.equal(a.packetSha256, digest(bytes));
  assert.equal(a.packetBytes, bytes.length);
  assert.ok(a.ownerEvents.includes('200f55c3') && a.ownerEvents.includes('cd7275c8'));
  assert.equal(q.cli.version, '1.7.1');
  assert.equal(q.cli.gitHead, PIN);
  assert.equal(q.cli.integrity, INTEGRITY);
  assert.equal(q.cli.installedFileCount, 19);
  assert.equal(q.ownerPurposeEvent, 'cd7275c8');
  assert.equal(q.ownerRestorationEvent, '200f55c3');
  canonicalDirectory(q.root);
  assert.equal(fs.statSync(q.root).uid, process.getuid());
  assert.equal(q.confinement.insideWrite, 'write-succeeded');
  assert.equal(q.confinement.outsideWrite, 'EPERM');
  assert.equal(q.confinement.networkSocket, 'EPERM');
  assert.equal(q.confinement.qaNetwork, 'deny network*');
  assert.equal(q.environment.DISABLE_TELEMETRY, '1');
  assert.equal(q.environment.DO_NOT_TRACK, '1');
  assert.equal(q.consent.fixtureInstall, true);
  assert.equal(q.consent.noReportingOrPublicInstall, true);
  function verify(value) {
    if (Array.isArray(value)) return value.forEach(verify);
    if (!value || typeof value !== 'object') return;
    if (typeof value.path === 'string' && value.sha256) verifyFile(value);
    Object.values(value).forEach(verify);
  }
  verify(q);
  assert.equal(q.restoration.length, 8);
  assert.equal(q.restoration.find(p => p.name === 'skills').installedFiles.length, 19);
  return q;
}
function environment(q, area) {
  const dirs = ['home', 'tmp', 'config', 'cache', 'data', 'state', 'claude', 'codex', 'pi', 'opencode', 'git-empty'];
  for (const name of dirs) fs.mkdirSync(path.join(area, name), { recursive: true, mode: 0o700 });
  return {
    PATH: `${path.dirname(q.tools.node.path)}:/usr/bin:/bin`, HOME: path.join(area, 'home'),
    TMPDIR: path.join(area, 'tmp'), TMP: path.join(area, 'tmp'), TEMP: path.join(area, 'tmp'),
    XDG_CONFIG_HOME: path.join(area, 'config'), XDG_CACHE_HOME: path.join(area, 'cache'),
    XDG_DATA_HOME: path.join(area, 'data'), XDG_STATE_HOME: path.join(area, 'state'),
    CLAUDE_CONFIG_DIR: path.join(area, 'claude'), CODEX_HOME: path.join(area, 'codex'),
    PI_CODING_AGENT_DIR: path.join(area, 'pi'),
    OPENCODE_CONFIG_DIR: path.join(area, 'opencode'),
    npm_config_cache: path.join(area, 'cache'), npm_config_prefix: path.join(area, 'npm-prefix'),
    npm_config_userconfig: path.join(area, 'npmrc'), npm_config_globalconfig: path.join(area, 'global-npmrc'),
    npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TEMPLATE_DIR: path.join(area, 'git-empty'),
    GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false', SSH_ASKPASS: '/usr/bin/false', GIT_SSH_COMMAND: '/usr/bin/false',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: path.join(area, 'git-empty'),
    DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', NODE_DISABLE_COMPILE_CACHE: '1', PI_OFFLINE: '1',
    CI: '1', NO_COLOR: '1', SKILLS_CLONE_TIMEOUT_MS: '10000',
  };
}
function unitEnvironment(env) {
  const result = { ...env };
  // Installer tests intentionally replace HOME for each independent fixture.
  for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'OPENCODE_CONFIG_DIR', 'PI_CODING_AGENT_DIR']) delete result[name];
  return result;
}
function run(q, area, label, argv, cwd, env, { timeout = 15000, maxBytes = 1048576 } = {}) {
  assert.ok(cwd === q.root || cwd.startsWith(q.root + path.sep), 'subprocess cwd escapes owned root');
  const raw = path.join(area, label);
  const command = [q.tools.sandbox.path, '-f', q.confinement.qaProfile.path, ...argv];
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = fs.openSync(raw + '.stdout', 'wx');
    const stderr = fs.openSync(raw + '.stderr', 'wx');
    let count = 0; let reason = null; let output = ''; let errors = '';
    const stop = why => {
      if (reason) return;
      reason = why;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    const timer = setTimeout(() => stop('deadline'), timeout);
    child.stdout.on('data', b => { fs.writeSync(stdout, b); count += b.length; output += b; if (count > maxBytes) stop('output-overflow'); });
    child.stderr.on('data', b => { fs.writeSync(stderr, b); count += b.length; errors += b; if (count > maxBytes) stop('output-overflow'); });
    child.once('error', error => { clearTimeout(timer); fs.closeSync(stdout); fs.closeSync(stderr); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer); fs.closeSync(stdout); fs.closeSync(stderr);
      const result = { argv: command, cwd, env, code, signal, reason, bytes: count };
      fs.writeFileSync(raw + '.json', JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
      resolve({ ...result, stdout: output, stderr: errors });
    });
  });
}
function assertSuccess(result) {
  assert.equal(result.reason, null, result.reason || 'bounded subprocess');
  assert.equal(result.signal, null, result.signal || 'no signal');
  assert.equal(result.code, 0, result.stderr || result.stdout);
}
function sourceSnapshot(q, area) {
  const destination = path.join(area, 'source');
  fs.mkdirSync(destination);
  const listing = spawnSync(q.tools.sandbox.path, ['-f', q.confinement.qaProfile.path, q.tools.git.path, '-C', ROOT, 'ls-files', '-z'], { env: environment(q, path.join(area, 'git-profile')), encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  const files = [...new Set([...listing.stdout.split('\0').filter(Boolean), 'tests/skills-distribution.test.cjs', 'tests/helpers/skills-distribution-smoke.cjs'])];
  const sourceFiles = [];
  for (const relative of files) {
    assert.ok(!path.isAbsolute(relative) && !relative.split('/').includes('..'));
    assert.ok(!relative.startsWith('.planning/') && !relative.startsWith('node_modules/'));
    const source = path.join(ROOT, relative);
    assert.ok(fs.lstatSync(source).isFile(), `nonregular source: ${relative}`);
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    sourceFiles.push({ path: source, relative, sha256: digest(fs.readFileSync(source)), bytes: fs.statSync(source).size });
  }
  const generator = require(path.join(destination, 'scripts/build-plugin.cjs'));
  generator.buildPlugin(path.join(destination, 'plugins/fvs'));
  generator.buildPiSkills(path.join(destination, 'pi/skills'));
  if (generator.buildSetupSkill) generator.buildSetupSkill(path.join(destination, 'skills/fvs-setup'));
  fs.writeFileSync(path.join(area, 'source-binding.json'), JSON.stringify({ base: q.sourceHead, sourceFiles }, null, 2) + '\n');
  return destination;
}
function assertContract(text) {
  assert.match(text, /^---\nname: fvs-setup\ndescription: .*native.*setup/m, 'installed setup identity');
  for (const heading of ['Scope', 'Consent', 'Complete source installation', 'Native controls', 'Privacy']) {
    assert.ok(text.includes(`## ${heading}`), `installed semantic section: ${heading}`);
  }
  assert.ok(text.indexOf('## Consent') < text.indexOf('## Complete source installation'), 'consent barrier precedes command recipe');
  assert.match(text, /WAIT/);
  assert.match(text, /inspection consent is not installation consent/i);
  assert.doesNotMatch(text, /CLAUDE_PLUGIN_ROOT|@\.{1,2}\/|(?:\]\()\.{1,2}\//, 'transported bootstrap must not use adjacent relative resource loaders');
  assert.doesNotMatch(text, /\.\.\/\.\.\//, 'transported bootstrap must not load parents');
}
function requireResource(file) {
  assert.ok(fs.existsSync(file) && fs.statSync(file).isFile(), `missing native resource: ${file}`);
}
async function nativeFootprint(q, area, source, env, runtime = 'claude') {
  const project = path.join(area, `native-${runtime}`);
  fs.mkdirSync(project);
  // Antigravity installs under .agents/plugins/fvs; seed an old Gemini settings file instead,
  // which the legacy cleanup must leave with its foreign entry intact.
  const config = path.join(project, runtime === 'antigravity' ? '.gemini' : `.${runtime}`);
  fs.mkdirSync(config);
  if (runtime === 'codex') fs.writeFileSync(path.join(config, 'config.toml'), 'foreign_setting = "keep"\n');
  else fs.writeFileSync(path.join(config, runtime === 'opencode' ? 'opencode.json' : 'settings.json'), JSON.stringify({ foreignSetting: 'keep' }));
  const build = await run(q, area, `hook-build-${runtime}`, [q.tools.node.path, path.join(source, 'scripts/build-hooks.js')], source, env);
  assertSuccess(build);
  const result = await run(q, area, `native-install-${runtime}`, [q.tools.node.path, path.join(source, 'bin/install.js'), `--${runtime}`, '--local'], project, env);
  assertSuccess(result);
  const manifests = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name === 'fvs-file-manifest.json') manifests.push(file);
    }
  }
  walk(project);
  assert.equal(manifests.length, 1, 'one actual installed FVS manifest');
  const nativeRoot = fs.realpathSync(path.dirname(manifests[0]));
  const manifest = JSON.parse(fs.readFileSync(manifests[0], 'utf8'));
  assert.equal(manifest.version, JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version);
  const resources = [];
  function closure(sourceDir, relative = '') {
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) closure(path.join(sourceDir, entry.name), child);
      else {
        const installed = path.join(nativeRoot, 'fv-skills', child);
        assert.ok(fs.statSync(installed).isFile(), `complete installed support: ${child}`);
        resources.push({ path: installed, bytes: fs.statSync(installed).size, sha256: digest(fs.readFileSync(installed)) });
      }
    }
  }
  closure(path.join(source, 'fv-skills'));
  for (const script of fs.readdirSync(path.join(source, 'plugins/fvs/scripts'))) {
    const installed = path.join(nativeRoot, 'scripts', script);
    assert.ok(fs.statSync(installed).isFile(), `complete generator-owned script inventory: ${script}`);
    resources.push({ path: installed, bytes: fs.statSync(installed).size, sha256: digest(fs.readFileSync(installed)) });
  }
  for (const role of fs.readdirSync(path.join(source, 'agents')).filter(n => n.endsWith('.md'))) {
    assert.ok(fs.statSync(path.join(nativeRoot, 'agents', role)).isFile(), `complete role: ${role}`);
  }
  const hooks = runtime === 'codex' ? ['fvs-check-update.js'] : ['fvs-check-update.js', 'fvs-statusline.js'];
  for (const hook of hooks) {
    const original = fs.readFileSync(path.join(source, 'hooks/dist', hook), 'utf8');
    // Local installation templates only quoted config-directory literals.
    const expected = original.replace(/'\.claude'/g, runtime === 'antigravity' ? "'.agents/plugins/fvs'" : `'.${runtime}'`);
    assert.equal(fs.readFileSync(path.join(nativeRoot, 'hooks', hook), 'utf8'), expected, `exact ${runtime} hook conversion`);
  }
  if (runtime === 'codex') assert.equal(fs.existsSync(path.join(nativeRoot, 'hooks/fvs-statusline.js')), false);
  const commandsDirectory = path.join(nativeRoot, ['codex', 'antigravity'].includes(runtime) ? 'skills' : runtime === 'opencode' ? 'command' : 'commands/fvs');
  const commands = fs.readdirSync(commandsDirectory);
  assert.equal(commands.length, 30);
  let commandPath;
  if (runtime === 'codex') commandPath = path.join(commandsDirectory, 'fvs-fc-plan/SKILL.md');
  else if (runtime === 'opencode') commandPath = path.join(commandsDirectory, 'fvs-fc-plan.md');
  else if (runtime === 'antigravity') commandPath = path.join(commandsDirectory, 'fc-plan/references/fc-plan.md');
  else commandPath = path.join(commandsDirectory, 'fc-plan.md');
  const installedCommand = fs.readFileSync(commandPath, 'utf8');
  if (runtime !== 'claude') assert.doesNotMatch(installedCommand, /~\/\.claude\//, 'native command paths converted');
  const configFile = runtime === 'antigravity' ? path.join(config, 'settings.json')
    : path.join(nativeRoot, runtime === 'codex' ? 'config.toml' : runtime === 'opencode' ? 'opencode.json' : 'settings.json');
  assert.match(fs.readFileSync(configFile, 'utf8'), /keep/, 'unrelated seeded settings survive');
  if (runtime === 'codex') {
    const installer = require(path.join(source, 'bin/install.js'));
    const roles = fs.readdirSync(path.join(nativeRoot, 'agents')).filter(n => n.endsWith('.toml'));
    assert.equal(roles.length, 14);
    for (const role of roles) {
      const markdown = fs.readFileSync(path.join(source, 'agents', role.replace(/\.toml$/, '.md')), 'utf8')
        .replace(/~\/\.claude\//g, nativeRoot + '/')
        .replace(/\$HOME\/\.claude\//g, nativeRoot + '/');
      assert.equal(fs.readFileSync(path.join(nativeRoot, 'agents', role), 'utf8'), installer.generateCodexAgentToml(role.slice(0, -5), markdown), 'complete source-owned role body in actual Codex TOML');
    }
    assert.match(fs.readFileSync(path.join(nativeRoot, 'hooks.json'), 'utf8'), /fvs-check-update\.js/);
  }
  fs.writeFileSync(path.join(area, `native-${runtime}-resources.json`), JSON.stringify({ nativeRoot, manifest: manifests[0], resources, commandsDirectory, commandPath, configFile }, null, 2) + '\n');
  for (const rel of ['fv-skills/workflows/fc-plan.md', 'fv-skills/workflows/crypto-review.md', 'fv-skills/templates/config.json', 'fv-skills/references/fc-spec-review.md', 'scripts/fvs-probe-inventory.mjs', 'agents/fvs-researcher.md', 'hooks/fvs-check-update.js', 'fv-skills/VERSION']) {
    requireResource(path.join(nativeRoot, rel));
  }
  if (runtime === 'claude') {
    const settings = fs.readFileSync(path.join(nativeRoot, 'settings.json'), 'utf8');
    assert.match(settings, /fvs-check-update\.js/);
    assert.match(settings, /fvs-statusline\.js/);
  }
  return { nativeRoot, resources: 'installed-footprint-only-not-model-enforcement' };
}
async function tracer(q, area) {
  const env = environment(q, path.join(area, 'profile'));
  const source = sourceSnapshot(q, area);
  assertSuccess(await run(q, area, 'verification-hook-build', [q.tools.node.path, path.join(source, 'scripts/build-hooks.js')], source, env));
  assertSuccess(await run(q, area, 'verification-unit', [q.tools.node.path, '--test', 'tests/skills-distribution.test.cjs'], source, unitEnvironment(env)));
  const project = path.join(area, 'transport-project');
  fs.mkdirSync(project);
  const list = await run(q, area, 'root-list', [q.tools.node.path, q.cli.path, 'add', source, '--list'], project, env);
  const copy = await run(q, area, 'claude-copy', [q.tools.node.path, q.cli.path, 'add', source, '--skill', 'fvs-setup', '--agent', 'claude-code', '--copy', '--yes'], project, env);
  assertSuccess(list);
  assert.equal(copy.code, 0, 'real selected copy must install the generated fvs-setup entry');
  assert.match(list.stdout, /Found 1 skill\b/);
  assert.match(list.stdout, /fvs-setup/);
  const installed = path.join(project, '.claude/skills/fvs-setup/SKILL.md');
  const text = fs.readFileSync(installed, 'utf8');
  assertContract(text);
  assert.equal(text, fs.readFileSync(path.join(source, 'skills/fvs-setup/SKILL.md'), 'utf8'));
  const relocated = path.join(area, 'unrelated-entry');
  fs.mkdirSync(relocated);
  fs.copyFileSync(installed, path.join(relocated, 'SKILL.md'));
  assertContract(fs.readFileSync(path.join(relocated, 'SKILL.md'), 'utf8'));
  const native = await nativeFootprint(q, area, source, env);
  return { discovery: 'one', installed, installedSha256: digest(text), relocated, native };
}
async function nativeResources(q, area, full = false) {
  const env = environment(q, path.join(area, 'profile'));
  const source = sourceSnapshot(q, area);
  assertSuccess(await run(q, area, 'verification-hook-build', [q.tools.node.path, path.join(source, 'scripts/build-hooks.js')], source, env));
  assertSuccess(await run(q, area, 'verification-unit', [q.tools.node.path, '--test', 'tests/skills-distribution.test.cjs', 'tests/pi-installer.test.cjs', 'tests/install.test.cjs', 'tests/codex-config.test.cjs', ...(full ? ['tests/task-ref-sweep.test.cjs'] : [])], source, unitEnvironment(env), { timeout: 45000 }));
  const results = {};
  for (const runtime of ['claude', 'opencode', 'antigravity', 'codex']) {
    results[runtime] = await nativeFootprint(q, area, source, env, runtime);
  }
  const piProject = path.join(area, 'native-pi');
  fs.mkdirSync(path.join(piProject, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(piProject, '.pi/settings.json'), JSON.stringify({ foreignSetting: 'keep' }));
  const driver = `
    import fs from 'node:fs';
    import path from 'node:path';
    const base = ${JSON.stringify(q.pi.packageRoot)};
    const {DefaultPackageManager} = await import(base + '/dist/core/package-manager.js');
    const {SettingsManager} = await import(base + '/dist/core/settings-manager.js');
    const {loadSkills} = await import(base + '/dist/core/skills.js');
    const cwd = ${JSON.stringify(piProject)};
    const agentDir = ${JSON.stringify(env.PI_CODING_AGENT_DIR)};
    const source = ${JSON.stringify(source)};
    const settings = SettingsManager.create(cwd, agentDir, {projectTrusted: true});
    const manager = new DefaultPackageManager({cwd, agentDir, settingsManager: settings});
    await manager.installAndPersist(source, {local: true});
    await settings.flush();
    const resolved = await manager.resolve(() => {throw new Error('unexpected missing package');});
    const entries = resolved.skills.filter(x => x.metadata.origin === 'package');
    const loaded = loadSkills({cwd, agentDir, includeDefaults: false, skillPaths: entries.filter(x => x.enabled).map(x => x.path)});
    console.log(JSON.stringify({configured: manager.listConfiguredPackages(), projectSettings: settings.getProjectSettings(), entries, loaded}, null, 2));
  `;
  const driverPath = path.join(area, 'pi-resource-discovery.mjs');
  fs.writeFileSync(driverPath, driver);
  const pi = await run(q, area, 'pi-resource-discovery', [q.tools.node.path, driverPath], piProject, env);
  assertSuccess(pi);
  const observed = JSON.parse(pi.stdout);
  assert.equal(observed.projectSettings.foreignSetting, 'keep');
  assert.equal(observed.entries.length, 30);
  assert.equal(observed.loaded.skills.length, 30);
  assert.deepEqual(observed.loaded.diagnostics, []);
  assert.ok(observed.configured.some(e => e.scope === 'project' && e.installedPath === source));
  const nativeRoots = [...new Set(observed.entries.map(e => e.metadata.packageRoot))];
  assert.equal(nativeRoots.length, 1);
  const nativeRoot = fs.realpathSync(nativeRoots[0]);
  assert.equal(nativeRoot, fs.realpathSync(source), 'actual Pi resolver metadata identifies complete sourceRoot');
  for (const rel of ['fv-skills/workflows/fc-plan.md', 'fv-skills/workflows/crypto-review.md', 'scripts/fvs-probe-inventory.mjs', 'agents/fvs-researcher.md']) assert.ok(fs.statSync(path.join(nativeRoot, rel)).isFile());
  assert.ok(observed.loaded.skills.every(s => s.filePath.startsWith(path.join(nativeRoot, 'pi/skills') + path.sep)));
  results.pi = { nativeRoot, actualResourceDiscovery: true, projectScope: true, skills: 30, modelSession: false };
  return results;
}

async function transport(q, area) {
  const env = environment(q, path.join(area, 'profile'));
  const source = sourceSnapshot(q, area);
  const result = { copies: {}, discovery: {} };
  const listingProject = path.join(area, 'listing-project');
  fs.mkdirSync(listingProject);
  for (const [name, input, flags, count] of [
    ['root', source, [], 1], ['direct', path.join(source, 'skills/fvs-setup'), [], 1],
    ['full-depth', source, ['--full-depth'], 61], ['pi-subpath', path.join(source, 'pi/skills'), [], 30],
    ['plugin-subpath', path.join(source, 'plugins/fvs/skills'), [], 30],
  ]) {
    const listed = await run(q, area, `list-${name}`, [q.tools.node.path, q.cli.path, 'add', input, '--list', ...flags], listingProject, env);
    assertSuccess(listed);
    assert.match(listed.stdout, new RegExp(`Found ${count} skills?\\b`));
    result.discovery[name] = count;
  }
  for (const agent of ['claude-code', 'codex', 'gemini-cli', 'opencode', 'pi']) {
    const project = path.join(area, `copy-${agent}`);
    fs.mkdirSync(project);
    const input = agent === 'pi' ? path.join(source, 'skills/fvs-setup') : source;
    const copied = await run(q, area, `copy-${agent}`, [q.tools.node.path, q.cli.path, 'add', input, '--skill', 'fvs-setup', '--agent', agent, '--copy', '--yes'], project, env);
    assertSuccess(copied);
    const directory = path.join(project, agent === 'claude-code' ? '.claude/skills/fvs-setup' : '.agents/skills/fvs-setup');
    assert.ok(fs.lstatSync(directory).isDirectory() && !fs.lstatSync(directory).isSymbolicLink());
    assert.deepEqual(fs.readdirSync(directory), ['SKILL.md']);
    const text = fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8');
    assertContract(text);
    assert.equal(text, fs.readFileSync(path.join(source, 'skills/fvs-setup/SKILL.md'), 'utf8'));
    assert.ok(fs.statSync(path.join(project, 'skills-lock.json')).isFile());
    result.copies[agent] = { directory, sha256: digest(text), lock: path.join(project, 'skills-lock.json'), evidence: 'transport-only-not-host-loading' };
  }
  const project = path.join(area, 'multi-agent-symlink');
  fs.mkdirSync(project);
  const linked = await run(q, area, 'multi-agent-symlink', [q.tools.node.path, q.cli.path, 'add', source, '--skill', 'fvs-setup', '--agent', 'claude-code', 'codex', '--yes'], project, env);
  assertSuccess(linked);
  const alias = path.join(project, '.claude/skills/fvs-setup');
  const canonical = path.join(project, '.agents/skills/fvs-setup');
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), true, 'genuine multi-target symlink required');
  assert.ok(fs.lstatSync(canonical).isDirectory() && !fs.lstatSync(canonical).isSymbolicLink());
  assert.equal(fs.realpathSync(alias), fs.realpathSync(canonical));
  const relocatedSource = path.join(area, 'source-relocated');
  fs.renameSync(source, relocatedSource);
  assert.equal(fs.existsSync(source), false);
  for (const directory of [alias, canonical]) assertContract(fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8'));
  result.symlink = { alias, canonical, readlink: fs.readlinkSync(alias), realpath: fs.realpathSync(alias), originalSource: source, relocatedSource, sourceRetained: true, installedSha256: digest(fs.readFileSync(path.join(alias, 'SKILL.md'))) };
  return result;
}
async function denials(q, area, qualification, acceptance) {
  const env = environment(q, path.join(area, 'profile'));
  const results = {};
  for (const variable of ['DISABLE_TELEMETRY', 'DO_NOT_TRACK']) {
    const missing = { DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' };
    delete missing[variable];
    assert.throws(() => validateQualification(qualification, acceptance, missing), /opt-out/);
    results[variable] = 'rejected-before-invocation';
  }
  assert.throws(() => validateQualification(null, acceptance), /qualification/);
  for (const [name, argv, options, check] of [
    ['nonzero', ['-e', 'process.exit(17)'], {}, r => assert.equal(r.code, 17)],
    ['signal', ['-e', "process.kill(process.pid, 'SIGTERM')"], {}, r => assert.equal(r.signal, 'SIGTERM')],
    ['deadline', ['-e', 'setInterval(()=>{},1000)'], { timeout: 100 }, r => assert.equal(r.reason, 'deadline')],
    ['overflow', ['-e', "process.stdout.write('x'.repeat(524288)); setInterval(()=>{},1000)"], { maxBytes: 1024 }, r => assert.equal(r.reason, 'output-overflow')],
  ]) {
    const observed = await run(q, area, `denial-${name}`, [q.tools.node.path, ...argv], area, env, options);
    check(observed);
    assert.throws(() => assertSuccess(observed));
    results[name] = 'cannot-pass';
  }
  const malformed = path.join(area, 'qualification-altered.json');
  const changed = JSON.parse(fs.readFileSync(qualification, 'utf8'));
  changed.cli.version = '0.0.0';
  fs.writeFileSync(malformed, JSON.stringify(changed));
  assert.throws(() => validateQualification(malformed, acceptance), /Expected values|integrity|equal/);
  results.alteredQualification = 'rejected-before-invocation';
  const official = q.restoration.find(p => p.name === 'skills').installedFiles.find(f => f.path === q.cli.path);
  const altered = path.join(area, 'altered-cli.mjs');
  fs.writeFileSync(altered, fs.readFileSync(q.cli.path, 'utf8') + '\n// altered fixture\n');
  assert.throws(() => verifyFile({ ...official, path: altered }), /integrity mismatch/);
  const dep = q.restoration.find(p => p.name === 'yaml').installedFiles[0];
  const alteredDep = path.join(area, 'altered-dependency');
  fs.writeFileSync(alteredDep, 'changed');
  assert.throws(() => verifyFile({ ...dep, path: alteredDep }), /integrity mismatch/);
  results.alteredOfficialAndDependency = 'rejected-before-execution';
  const linked = path.join(area, 'redirected-root');
  fs.symlinkSync(q.root, linked);
  assert.throws(() => canonicalDirectory(linked), /symlink/);
  results.redirectedRoot = 'rejected';
  assert.throws(() => requireResource(path.join(area, 'absent-native-resource')), /missing native resource/);
  results.absentNativeResource = 'cannot-pass-footprint-check';
  results.consentAndControlDenials = 'renderer semantic states tested; no fabricated conversational enforcement or hidden installer invoked';
  return results;
}
async function acceptance(q, area, qualification, acceptanceFile) {
  const results = {};
  for (const [name, execute] of [
    ['tracer', child => tracer(q, child)],
    ['native-resources', child => nativeResources(q, child, true)],
    ['transport', child => transport(q, child)],
    ['denials', child => denials(q, child, qualification, acceptanceFile)],
  ]) {
    const child = path.join(area, name);
    fs.mkdirSync(child);
    results[name] = await execute(child);
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const qualification = args[args.indexOf('--qualification') + 1];
  assert.ok(args.includes('--qualification'), 'qualification required before any invocation');
  const q = validateQualification(qualification, process.env.FVS_SKILLS_DISTRIBUTION_ACCEPTANCE);
  const which = args[args.indexOf('--case') + 1];
  assert.ok(['tracer', 'native-resources', 'transport', 'acceptance'].includes(which), 'supported case required');
  const area = fs.mkdtempSync(path.join(q.root, 'profiles', `${which}-`));
  const started = Date.now();
  try {
    const cases = { tracer, 'native-resources': nativeResources, transport, acceptance: (record, root) => acceptance(record, root, qualification, process.env.FVS_SKILLS_DISTRIBUTION_ACCEPTANCE) };
    const result = await cases[which](q, area);
    assert.ok(Date.now() - started < 60000, 'local case wall-time budget exceeded');
    fs.writeFileSync(path.join(area, 'outcome.json'), JSON.stringify({ status: 'pass', elapsedMs: Date.now() - started, result }, null, 2) + '\n');
    console.log(JSON.stringify({ status: 'pass', case: which, area, result }));
  } catch (error) {
    fs.writeFileSync(path.join(area, 'outcome.json'), JSON.stringify({ status: 'fail', elapsedMs: Date.now() - started, error: error.message, stack: error.stack }, null, 2) + '\n');
    throw error;
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { validateQualification, assertContract, canonicalDirectory, environment, run };
