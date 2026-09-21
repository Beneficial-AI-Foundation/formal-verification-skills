'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const INSTALLER = path.join(ROOT, 'bin', 'install.js');
const tempDirs = [];

function temp(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

after(() => {
  for (const directory of tempDirs) fs.rmSync(directory, { recursive: true, force: true });
});

function makeFakePi(root) {
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'pi-argv.jsonl');
  fs.mkdirSync(bin, { recursive: true });
  const script = path.join(bin, 'pi.js');
  fs.writeFileSync(script, `#!/usr/bin/env node\nconst fs=require('fs');\nconst args=process.argv.slice(2);\nif(args[0]==='--version'){console.log('0.85.1');process.exit(0)}\nif(args[1]==='--help'){console.log('Usage: pi '+args[0]+' <source> [--local]');process.exit(0)}\nfs.appendFileSync(process.env.FVS_PI_TEST_LOG,JSON.stringify(args)+'\\n');\nif(process.env.PI_REQUIRE_ABSENT&&fs.existsSync(process.env.PI_REQUIRE_ABSENT)){console.error('non-Pi mutation happened before Pi');process.exit(18)}\nif(process.env.PI_FAKE_FAIL_ACTION===args[0]){console.error('requested fake failure');process.exit(19)}\n`);
  fs.chmodSync(script, 0o755);
  const executable = path.join(bin, process.platform === 'win32' ? 'pi.cmd' : 'pi');
  if (process.platform === 'win32') {
    fs.writeFileSync(executable, '@node "%~dp0\\pi.js" %*\r\n');
  } else {
    fs.copyFileSync(script, executable);
    fs.chmodSync(executable, 0o755);
  }
  return { bin, log };
}

function runInstaller(root, fake, args, extraEnv = {}) {
  return spawnSync(process.execPath, [INSTALLER, ...args], {
    cwd: root,
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      PATH: `${fake.bin}${path.delimiter}${process.env.PATH ?? ''}`,
      FVS_PI_TEST_LOG: fake.log,
      ...extraEnv,
    },
    encoding: 'utf8',
  });
}

function invocations(log) {
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

describe('Pi installer adapter', () => {
  it('builds updateable latest and exact npm sources without substitution', () => {
    const installer = require('../bin/install.js');
    assert.equal(installer.buildPiPackageSource('latest'), 'npm:fv-skills-baif');
    assert.equal(installer.buildPiPackageSource('2.3.4'), 'npm:fv-skills-baif@2.3.4');
    assert.throws(() => installer.buildPiPackageSource('v2.3.4'), /latest or X\.Y\.Z/);
    assert.deepEqual(installer.buildPiCommand('install', 'latest', true),
      ['install', 'npm:fv-skills-baif']);
    assert.deepEqual(installer.buildPiCommand('install', '2.3.4', false),
      ['install', 'npm:fv-skills-baif@2.3.4', '--local']);
    assert.deepEqual(installer.buildPiCommand('remove', 'latest', false),
      ['remove', 'npm:fv-skills-baif', '--local']);
  });

  it('detects user/project package identity without modifying either settings file', () => {
    const root = temp('fvs-pi-scopes-');
    const user = path.join(root, 'home', '.pi', 'agent', 'settings.json');
    const project = path.join(root, 'project', '.pi', 'settings.json');
    fs.mkdirSync(path.dirname(user), { recursive: true });
    fs.mkdirSync(path.dirname(project), { recursive: true });
    fs.writeFileSync(user, JSON.stringify({ packages: ['npm:foreign', 'npm:fv-skills-baif@2.3.4'], theme: 'x' }));
    fs.writeFileSync(project, JSON.stringify({ packages: [{ source: 'npm:fv-skills-baif', skills: ['x'] }], foreign: true }));
    const before = [fs.readFileSync(user), fs.readFileSync(project)];

    const { detectPiPackageScopes } = require('../bin/install.js');
    assert.deepEqual(detectPiPackageScopes({ home: path.join(root, 'home'), cwd: path.join(root, 'project') }), {
      user: ['npm:fv-skills-baif@2.3.4'],
      project: ['npm:fv-skills-baif'],
    });
    assert.deepEqual([fs.readFileSync(user), fs.readFileSync(project)], before);
  });

  it('validates Pi options and exposes them in CLI help', () => {
    const installer = require('../bin/install.js');
    assert.deepEqual(installer.parsePiOptions(['--pi-version', 'latest', '--pi-conflict', 'move']), {
      version: 'latest',
      conflict: 'move',
    });
    assert.throws(() => installer.parsePiOptions(['--pi-version', '2.3']), /latest or X\.Y\.Z/);
    assert.throws(() => installer.parsePiOptions(['--pi-conflict', 'cancel']), /keep or move/);
    assert.equal(installer.resolvePiVersionChoice('1'), 'latest');
    assert.equal(installer.resolvePiVersionChoice('2', '2.3.4'), '2.3.4');
    assert.equal(installer.resolvePiConflictChoice('1'), 'keep');
    assert.equal(installer.resolvePiConflictChoice('2'), 'move');
    assert.equal(installer.resolvePiConflictChoice('3'), 'cancel');
    assert.deepEqual(installer.resolveRuntimeChoice('5'), ['pi']);
    assert.deepEqual(installer.resolveRuntimeChoice('6'), installer.ALL_RUNTIMES);

    const help = spawnSync(process.execPath, [INSTALLER, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--pi\b/);
    assert.match(help.stdout, /--pi-version <latest\|X\.Y\.Z>/);
    assert.match(help.stdout, /--pi-conflict <keep\|move>/);
    assert.match(help.stdout, /--config-dir is reported and ignored for Pi/);
  });

  it('delegates global latest and local exact installs to Pi', () => {
    const globalRoot = temp('fvs-pi-global-');
    const globalPi = makeFakePi(globalRoot);
    const global = runInstaller(globalRoot, globalPi, ['--pi', '--global', '--pi-version', 'latest']);
    assert.equal(global.status, 0, global.stderr);
    assert.deepEqual(invocations(globalPi.log), [['install', 'npm:fv-skills-baif']]);

    const localRoot = temp('fvs-pi-local-');
    const localPi = makeFakePi(localRoot);
    const local = runInstaller(localRoot, localPi, ['--pi', '--local', '--pi-version=2.3.4']);
    assert.equal(local.status, 0, local.stderr);
    assert.deepEqual(invocations(localPi.log), [['install', 'npm:fv-skills-baif@2.3.4', '--local']]);
  });

  it('uses matching-scope native removal and ignores config-dir only for Pi', () => {
    const root = temp('fvs-pi-remove-');
    const fake = makeFakePi(root);
    const custom = path.join(root, 'foreign-config');
    const result = runInstaller(root, fake, [
      '--pi', '--local', '--config-dir', custom, '--uninstall',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--config-dir.*ignored for Pi/i);
    assert.deepEqual(invocations(fake.log), [['remove', 'npm:fv-skills-baif', '--local']]);
    assert.equal(fs.existsSync(custom), false);
  });

  it('requires explicit noninteractive keep/move policy for an opposite-scope conflict', () => {
    const root = temp('fvs-pi-conflict-');
    const fake = makeFakePi(root);
    const settings = path.join(root, '.pi', 'agent', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ packages: ['npm:fv-skills-baif'], foreign: true }));

    const blocked = runInstaller(root, fake, ['--pi', '--local']);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /--pi-conflict keep\|move/i);
    assert.deepEqual(invocations(fake.log), []);

    const kept = runInstaller(root, fake, ['--pi', '--local', '--pi-conflict', 'keep']);
    assert.equal(kept.status, 0, kept.stderr);
    assert.deepEqual(invocations(fake.log), [['install', 'npm:fv-skills-baif', '--local']]);
  });

  it('moves only the opposite-scope FVS package after the requested install succeeds', () => {
    const root = temp('fvs-pi-move-');
    const fake = makeFakePi(root);
    const settings = path.join(root, '.pi', 'agent', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ packages: ['npm:foreign', 'npm:fv-skills-baif@2.3.3'] }));

    const moved = runInstaller(root, fake, ['--pi', '--local', '--pi-conflict=move']);
    assert.equal(moved.status, 0, moved.stderr);
    assert.deepEqual(invocations(fake.log), [
      ['install', 'npm:fv-skills-baif', '--local'],
      ['remove', 'npm:fv-skills-baif'],
    ]);
  });

  it('fails noninteractive --all before mutating other runtimes when Pi is unavailable', () => {
    const root = temp('fvs-pi-missing-');
    const emptyBin = path.join(root, 'empty-bin');
    fs.mkdirSync(emptyBin);
    const result = spawnSync(process.execPath, [INSTALLER, '--all', '--global'], {
      cwd: root,
      env: { ...process.env, HOME: root, USERPROFILE: root, PATH: emptyBin },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Pi executable.*unavailable/i);
    for (const directory of ['.claude', '.codex', '.gemini', '.config']) {
      assert.equal(fs.existsSync(path.join(root, directory)), false, `${directory} mutated before Pi preflight`);
    }
  });

  it('preflights every non-Pi target before invoking Pi', () => {
    const root = temp('fvs-pi-preflight-');
    const fake = makeFakePi(root);
    fs.writeFileSync(path.join(root, '.claude'), 'not a directory');

    const result = runInstaller(root, fake, ['--all', '--global']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Installer target is not a directory/);
    assert.deepEqual(invocations(fake.log), []);
  });

  it('executes Pi first for --all and retains later runtime installation', () => {
    const root = temp('fvs-pi-all-');
    const fake = makeFakePi(root);
    const claudeCommands = path.join(root, '.claude', 'commands', 'fvs');
    const result = runInstaller(root, fake, ['--all', '--global'], {
      PI_REQUIRE_ABSENT: claudeCommands,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(invocations(fake.log)[0], ['install', 'npm:fv-skills-baif']);
    assert.ok(fs.existsSync(claudeCommands));
  });

  it('stops before non-Pi mutation when native Pi installation fails', () => {
    const root = temp('fvs-pi-failure-');
    const fake = makeFakePi(root);
    const result = runInstaller(root, fake, ['--all', '--global'], {
      PI_FAKE_FAIL_ACTION: 'install',
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Pi install .* failed/);
    assert.ok(!fs.existsSync(path.join(root, '.claude', 'commands', 'fvs')));
  });

  it('documents Pi selection, versions, conflicts, scope precedence, update, rollback, and removal', () => {
    const help = spawnSync(process.execPath, [INSTALLER, '--help'], { encoding: 'utf8' });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--pi/);
    assert.match(help.stdout, /--pi-version/);
    assert.match(help.stdout, /--pi-conflict/);
    assert.match(help.stdout, /Pi/);

    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    for (const pattern of [
      /npx fv-skills-baif --pi --global/,
      /pi install npm:fv-skills-baif/,
      /project.*(?:wins|precedence)/i,
      /pi update npm:fv-skills-baif/,
      /--pi-version 2\.3\.4/,
      /--pi.*--uninstall/,
    ]) assert.match(readme, pattern);
  });
});
