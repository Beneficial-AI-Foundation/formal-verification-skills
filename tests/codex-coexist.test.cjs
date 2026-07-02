'use strict';

// Dual-surface coexistence gate for a Codex install.
//
// GSD and FVS both write into the same Codex config dir. FVS must never clobber
// a GSD- or user-authored block. This suite drives the real installer through a
// temp --config-dir and asserts that, across install -> reinstall -> uninstall:
//   * config.toml keeps the foreign GSD agent table and the user [model] table
//     while adding (and later removing only) the FVS agent tables, and
//   * hooks.json keeps the foreign GSD SessionStart command while adding (and
//     later removing only) the FVS update-check SessionStart entry — for both
//     the nested { hooks: { SessionStart } } and flat { SessionStart } shapes.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const INSTALLER = path.join(ROOT, 'bin', 'install.js');

const tempDirs = [];
function makeTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function installCodex(dir) {
  execFileSync(process.execPath, [
    INSTALLER, '--codex', '--global', '--config-dir', dir,
  ], { cwd: ROOT, env: { ...process.env, HOME: dir, CODEX_HOME: dir }, stdio: 'pipe' });
}

function uninstallCodex(dir) {
  execFileSync(process.execPath, [
    INSTALLER, '--codex', '--global', '--config-dir', dir, '--uninstall',
  ], { cwd: ROOT, env: { ...process.env, HOME: dir, CODEX_HOME: dir }, stdio: 'pipe' });
}

function readToml(dir) {
  return fs.readFileSync(path.join(dir, 'config.toml'), 'utf8');
}

// Collect every SessionStart hook command string from hooks.json, tolerating
// both the nested { hooks: { SessionStart: [...] } } and flat { SessionStart }
// shapes.
function readSessionStartCommands(dir) {
  const p = path.join(dir, 'hooks.json');
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf8');
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw);
  const table = parsed && parsed.hooks && typeof parsed.hooks === 'object' && !Array.isArray(parsed.hooks)
    ? parsed.hooks
    : parsed;
  const entries = Array.isArray(table.SessionStart) ? table.SessionStart : [];
  const commands = [];
  for (const entry of entries) {
    const hooks = entry && Array.isArray(entry.hooks) ? entry.hooks : [];
    for (const h of hooks) {
      if (h && typeof h.command === 'string') commands.push(h.command);
    }
  }
  return commands;
}

describe('Codex config.toml coexistence (GSD + FVS + user tables)', () => {
  let tmpDir;

  it('seeds a GSD-managed agent table and a user table, then installs FVS', () => {
    tmpDir = makeTmpDir('fvs-codex-coexist-toml-');
    const seed = [
      '[model]',
      'name = "gpt-5-codex"',
      '',
      '# GSD Agent Configuration',
      '[agents.gsd-foo]',
      'description = "a GSD-managed agent"',
      'sandbox_mode = "read-only"',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, 'config.toml'), seed);
    installCodex(tmpDir);
  });

  it('keeps all three of [agents.gsd-, [agents.fvs-, and [model] after install', () => {
    const content = readToml(tmpDir);
    assert.ok(content.includes('[agents.gsd-'), 'GSD agent table clobbered');
    assert.ok(content.includes('[agents.fvs-'), 'FVS agent table missing');
    assert.ok(content.includes('[model]'), 'user [model] table clobbered');
  });

  it('does not duplicate the FVS block on reinstall', () => {
    installCodex(tmpDir);
    const content = readToml(tmpDir);
    const markerCount = content.split('FVS Agent Configuration').length - 1;
    assert.equal(markerCount, 1, `expected exactly one FVS marker, got ${markerCount}`);
    const featuresCount = content.split(/\n/).filter((l) => /^\[features\]\s*$/.test(l)).length;
    assert.equal(featuresCount, 1, `expected exactly one [features] table, got ${featuresCount}`);
    const flagCount = content.split(/\n/).filter((l) => /^hooks\s*=\s*true\s*$/.test(l)).length;
    assert.equal(flagCount, 1, `expected exactly one [features].hooks flag, got ${flagCount}`);
    assert.ok(content.indexOf('[features]') < content.indexOf('hooks = true'), 'hooks flag is inside [features]');
  });

  it('removes only the FVS tables on uninstall; GSD and user tables survive', () => {
    uninstallCodex(tmpDir);
    const content = readToml(tmpDir);
    assert.ok(content.includes('[agents.gsd-'), 'GSD agent table removed by FVS uninstall');
    assert.ok(content.includes('[model]'), 'user [model] table removed by FVS uninstall');
    assert.ok(!content.includes('[agents.fvs-'), 'FVS agent table not removed');
  });
});

describe('Codex hooks.json SessionStart coexistence (nested shape)', () => {
  let tmpDir;

  it('seeds a foreign GSD SessionStart entry (nested) then installs FVS', () => {
    tmpDir = makeTmpDir('fvs-codex-coexist-hooks-nested-');
    fs.mkdirSync(path.join(tmpDir, 'hooks'), { recursive: true });
    const seed = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'node /somewhere/gsd-check-update.js' }] },
        ],
      },
    };
    fs.writeFileSync(path.join(tmpDir, 'hooks.json'), `${JSON.stringify(seed, null, 2)}\n`);
    installCodex(tmpDir);
  });

  it('keeps the GSD command and adds the fvs-check-update command', () => {
    const commands = readSessionStartCommands(tmpDir);
    assert.ok(commands.some((c) => c.includes('gsd-check-update')), 'GSD SessionStart entry clobbered');
    assert.ok(commands.some((c) => c.includes('fvs-check-update')), 'FVS SessionStart entry missing');
  });

  it('preserves the nested { hooks: { SessionStart } } shape', () => {
    const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf8'));
    assert.ok(parsed.hooks && parsed.hooks.SessionStart, 'nested shape not preserved');
  });

  it('removes only the fvs-check-update entry on uninstall', () => {
    uninstallCodex(tmpDir);
    const commands = readSessionStartCommands(tmpDir);
    assert.ok(commands.some((c) => c.includes('gsd-check-update')), 'GSD SessionStart entry removed by FVS uninstall');
    assert.ok(!commands.some((c) => c.includes('fvs-check-update')), 'FVS SessionStart entry not removed');
  });

  it('preserves the foreign GSD entry as a non-empty hooks.json after uninstall', () => {
    assert.ok(fs.existsSync(path.join(tmpDir, 'hooks.json')), 'foreign hooks.json must survive');
    const raw = fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf8');
    assert.notEqual(raw.trim(), '{}', 'foreign hooks.json must not collapse to an empty object');
  });
});

describe('Codex FVS-only install then uninstall (clean removal)', () => {
  let tmpDir;

  it('installs FVS into an empty config dir', () => {
    tmpDir = makeTmpDir('fvs-codex-only-');
    installCodex(tmpDir);
    assert.ok(fs.existsSync(path.join(tmpDir, 'config.toml')), 'config.toml written');
    assert.ok(fs.existsSync(path.join(tmpDir, 'hooks.json')), 'hooks.json written');
  });

  it('deletes the FVS-only config.toml on uninstall (no orphaned feature flag)', () => {
    uninstallCodex(tmpDir);
    assert.ok(
      !fs.existsSync(path.join(tmpDir, 'config.toml')),
      'an FVS-only config.toml must be deleted, not left with an orphaned hooks feature flag',
    );
  });

  it('deletes the FVS-only hooks.json on uninstall (no leftover empty object)', () => {
    assert.ok(
      !fs.existsSync(path.join(tmpDir, 'hooks.json')),
      'an FVS-only hooks.json must be deleted, not left as {}',
    );
  });
});

describe('Codex hooks.json SessionStart coexistence (flat shape)', () => {
  let tmpDir;

  it('seeds a foreign GSD SessionStart entry (flat) then installs FVS', () => {
    tmpDir = makeTmpDir('fvs-codex-coexist-hooks-flat-');
    fs.mkdirSync(path.join(tmpDir, 'hooks'), { recursive: true });
    const seed = {
      SessionStart: [
        { hooks: [{ type: 'command', command: 'node /elsewhere/gsd-check-update.js' }] },
      ],
    };
    fs.writeFileSync(path.join(tmpDir, 'hooks.json'), `${JSON.stringify(seed, null, 2)}\n`);
    installCodex(tmpDir);
  });

  it('keeps the GSD command and adds the fvs-check-update command', () => {
    const commands = readSessionStartCommands(tmpDir);
    assert.ok(commands.some((c) => c.includes('gsd-check-update')), 'GSD SessionStart entry clobbered');
    assert.ok(commands.some((c) => c.includes('fvs-check-update')), 'FVS SessionStart entry missing');
  });

  it('preserves the flat { SessionStart } shape (no nested hooks object)', () => {
    const parsed = JSON.parse(fs.readFileSync(path.join(tmpDir, 'hooks.json'), 'utf8'));
    assert.ok(Array.isArray(parsed.SessionStart), 'flat shape not preserved');
    assert.ok(!parsed.hooks, 'flat seed must not gain a nested hooks object');
  });

  it('removes only the fvs-check-update entry on uninstall', () => {
    uninstallCodex(tmpDir);
    const commands = readSessionStartCommands(tmpDir);
    assert.ok(commands.some((c) => c.includes('gsd-check-update')), 'GSD SessionStart entry removed by FVS uninstall');
    assert.ok(!commands.some((c) => c.includes('fvs-check-update')), 'FVS SessionStart entry not removed');
  });
});
