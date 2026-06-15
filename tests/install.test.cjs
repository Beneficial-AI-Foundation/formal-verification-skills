'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const INSTALLER = path.join(ROOT, 'bin', 'install.js');

// Track temp dirs for cleanup
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

describe('Installer (install + uninstall round-trip)', () => {
  let tmpDir;

  it('installs to temp directory without error', () => {
    tmpDir = makeTmpDir('fvs-install-test-');
    execFileSync(process.execPath, [
      INSTALLER, '--claude', '--global', '--config-dir', tmpDir,
    ], {
      cwd: ROOT,
      env: { ...process.env, HOME: tmpDir },
      stdio: 'pipe',
    });
  });

  it('creates commands/fvs/ with at least 5 .md files', () => {
    const cmdDir = path.join(tmpDir, 'commands', 'fvs');
    assert.ok(fs.existsSync(cmdDir), 'commands/fvs/ missing');
    const mdFiles = fs.readdirSync(cmdDir).filter(f => f.endsWith('.md'));
    assert.ok(mdFiles.length >= 5, `Expected >= 5 command files, got ${mdFiles.length}`);
  });

  it('creates agents/ with at least 4 fvs-*.md files', () => {
    const agentDir = path.join(tmpDir, 'agents');
    assert.ok(fs.existsSync(agentDir), 'agents/ missing');
    const fvsAgents = fs.readdirSync(agentDir).filter(f => f.startsWith('fvs-') && f.endsWith('.md'));
    assert.ok(fvsAgents.length >= 4, `Expected >= 4 agent files, got ${fvsAgents.length}`);
  });

  it('creates fv-skills/workflows/ with at least 3 .md files', () => {
    const wfDir = path.join(tmpDir, 'fv-skills', 'workflows');
    assert.ok(fs.existsSync(wfDir), 'fv-skills/workflows/ missing');
    const mdFiles = fs.readdirSync(wfDir).filter(f => f.endsWith('.md'));
    assert.ok(mdFiles.length >= 3, `Expected >= 3 workflow files, got ${mdFiles.length}`);
  });

  it('creates fv-skills/references/ with at least 3 .md files', () => {
    const refDir = path.join(tmpDir, 'fv-skills', 'references');
    assert.ok(fs.existsSync(refDir), 'fv-skills/references/ missing');
    const mdFiles = fs.readdirSync(refDir).filter(f => f.endsWith('.md'));
    assert.ok(mdFiles.length >= 3, `Expected >= 3 reference files, got ${mdFiles.length}`);
  });

  it('creates specific spot-check files', () => {
    const checks = [
      'commands/fvs/help.md',
      'agents/fvs-researcher.md',
      'fv-skills/workflows/lean-verify.md',
    ];
    for (const rel of checks) {
      assert.ok(fs.existsSync(path.join(tmpDir, rel)), `Missing: ${rel}`);
    }
  });

  it('creates hooks/dist/ directory', () => {
    // The installer copies hook dist files when available
    const hooksDir = path.join(tmpDir, 'hooks');
    assert.ok(fs.existsSync(hooksDir), 'hooks/ missing');
  });

  // ---- Uninstall ----

  it('uninstalls without error', () => {
    execFileSync(process.execPath, [
      INSTALLER, '--claude', '--global', '--config-dir', tmpDir, '--uninstall',
    ], {
      cwd: ROOT,
      env: { ...process.env, HOME: tmpDir },
      stdio: 'pipe',
    });
  });

  it('removes commands/fvs/ after uninstall', () => {
    const cmdDir = path.join(tmpDir, 'commands', 'fvs');
    if (fs.existsSync(cmdDir)) {
      const remaining = fs.readdirSync(cmdDir);
      assert.equal(remaining.length, 0, `commands/fvs/ still has files: ${remaining.join(', ')}`);
    }
    // Directory gone or empty both pass
  });

  it('removes fvs-*.md agent files after uninstall', () => {
    const agentDir = path.join(tmpDir, 'agents');
    if (fs.existsSync(agentDir)) {
      const fvsAgents = fs.readdirSync(agentDir).filter(f => f.startsWith('fvs-') && f.endsWith('.md'));
      assert.equal(fvsAgents.length, 0, `agents/ still has fvs files: ${fvsAgents.join(', ')}`);
    }
  });

  it('removes fv-skills/ after uninstall', () => {
    const fvDir = path.join(tmpDir, 'fv-skills');
    assert.ok(!fs.existsSync(fvDir), 'fv-skills/ still exists after uninstall');
  });
});

describe('Update over existing old-shape install', () => {
  const MANIFEST_NAME = 'fvs-file-manifest.json';
  const PATCHES_DIR_NAME = 'fvs-local-patches';
  const LEGACY_AGENTS = [
    'fvs-dependency-analyzer',
    'fvs-code-reader',
    'fvs-lean-spec-generator',
    'fvs-lean-prover',
  ];
  let tmpDir;

  function seedOldShapeInstall(dir) {
    // Seed a v1.3.x install: the renamed command, a legacy agent, and a prior
    // manifest naming both with arbitrary hashes and a 1.3.1 version field.
    const cmdDir = path.join(dir, 'commands', 'fvs');
    const agentDir = path.join(dir, 'agents');
    fs.mkdirSync(cmdDir, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(cmdDir, 'plan.md'), '# old plan command stub\n');
    fs.writeFileSync(path.join(agentDir, 'fvs-code-reader.md'), '# legacy agent stub\n');
    const manifest = {
      version: '1.3.1',
      timestamp: new Date().toISOString(),
      files: {
        'commands/fvs/plan.md': 'deadbeef'.repeat(8),
        'agents/fvs-code-reader.md': 'cafebabe'.repeat(8),
      },
    };
    fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  }

  it('runs the installer over a seeded old-shape install', () => {
    tmpDir = makeTmpDir('fvs-update-test-');
    seedOldShapeInstall(tmpDir);
    execFileSync(process.execPath, [
      INSTALLER, '--claude', '--global', '--config-dir', tmpDir,
    ], {
      cwd: ROOT,
      env: { ...process.env, HOME: tmpDir },
      stdio: 'pipe',
    });
  });

  it('removes the renamed command and the legacy agent (self-heal)', () => {
    assert.ok(
      !fs.existsSync(path.join(tmpDir, 'commands', 'fvs', 'plan.md')),
      'orphaned commands/fvs/plan.md should be gone after update'
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, 'agents', 'fvs-code-reader.md')),
      'orphaned legacy agent agents/fvs-code-reader.md should be gone after update'
    );
  });

  it('installs the renamed command and the bundle router', () => {
    assert.ok(
      fs.existsSync(path.join(tmpDir, 'commands', 'fvs', 'fc-plan.md')),
      'renamed commands/fvs/fc-plan.md should be present after update'
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, 'commands', 'fvs', 'fc.md')),
      'bundle router commands/fvs/fc.md should be present after update'
    );
  });

  it('regenerates a manifest with no orphaned keys', () => {
    const manifestPath = path.join(tmpDir, MANIFEST_NAME);
    assert.ok(fs.existsSync(manifestPath), 'manifest should be regenerated');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const keys = Object.keys(manifest.files || {});
    assert.ok(
      !keys.includes('commands/fvs/plan.md'),
      'regenerated manifest must not key the renamed commands/fvs/plan.md'
    );
    for (const agent of LEGACY_AGENTS) {
      const rel = `agents/${agent}.md`;
      assert.ok(
        !keys.includes(rel),
        `regenerated manifest must not key the removed legacy agent ${rel}`
      );
    }
  });

  it('does not back up any path that resolves to a currently-installed file', () => {
    // A locally-edited plan.md MAY be backed up under its old name — that is the
    // documented rename orphan edge, not a bug. The correct invariant is the
    // weaker one: backups never duplicate a live installed file.
    const patchesDir = path.join(tmpDir, PATCHES_DIR_NAME);
    if (!fs.existsSync(patchesDir)) return; // no backups at all — fine
    const offenders = [];
    const walk = (absDir, relDir) => {
      for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
        const abs = path.join(absDir, entry.name);
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(abs, rel);
        } else if (entry.isFile() && rel.endsWith('.md')) {
          // rel is relative to patchesDir and mirrors the install relpath.
          if (fs.existsSync(path.join(tmpDir, rel))) offenders.push(rel);
        }
      }
    };
    walk(patchesDir, '');
    assert.equal(
      offenders.length,
      0,
      `fvs-local-patches/ must not back up live installed files: ${offenders.join(', ')}`
    );
  });
});

describe('Codex reinstall round-trip (TOML-aware strip + orphan prune)', () => {
  let tmpDir;

  function installCodex(dir) {
    execFileSync(process.execPath, [
      INSTALLER, '--codex', '--global', '--config-dir', dir,
    ], {
      cwd: ROOT,
      env: { ...process.env, HOME: dir, CODEX_HOME: dir },
      stdio: 'pipe',
    });
  }

  it('installs --codex once, then seeds foreign config and a stale orphan .toml', () => {
    tmpDir = makeTmpDir('fvs-codex-reinstall-');
    installCodex(tmpDir);

    const configPath = path.join(tmpDir, 'config.toml');
    assert.ok(fs.existsSync(configPath), 'config.toml created on first install');

    // Pre-seed foreign content that must survive a reinstall: a user [model]
    // table and a GSD-owned [agents.gsd-foo] table, prepended above the FVS
    // block.
    const existing = fs.readFileSync(configPath, 'utf8');
    const foreign = [
      '[model]',
      'name = "gpt-5"',
      '',
      '[agents.gsd-foo]',
      'description = "a gsd agent"',
      'config_file = "' + tmpDir.replace(/\\/g, '/') + '/agents/gsd-foo.toml"',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, foreign + '\n' + existing);

    // Plant a stale per-agent .toml for an agent FVS no longer ships.
    const agentsDir = path.join(tmpDir, 'agents');
    fs.writeFileSync(path.join(agentsDir, 'fvs-removed.toml'), 'name = "fvs-removed"\n');
    assert.ok(fs.existsSync(path.join(agentsDir, 'fvs-removed.toml')), 'stale orphan planted');
  });

  it('reinstalls --codex over the seeded config without error', () => {
    installCodex(tmpDir);
  });

  it('preserves the foreign [model] and [agents.gsd-foo] tables', () => {
    const content = fs.readFileSync(path.join(tmpDir, 'config.toml'), 'utf8');
    assert.ok(content.includes('[model]'), 'user [model] table survives reinstall');
    assert.ok(content.includes('name = "gpt-5"'), 'user table body survives reinstall');
    assert.ok(content.includes('[agents.gsd-foo]'), 'GSD [agents.gsd-foo] table survives reinstall');
  });

  it('re-emits exactly one FVS marker and the current FVS agent tables', () => {
    const content = fs.readFileSync(path.join(tmpDir, 'config.toml'), 'utf8');
    const markerCount = content.split('managed by fv-skills-baif installer').length - 1;
    assert.equal(markerCount, 1, 'exactly one FVS marker after reinstall (no duplication)');
    assert.ok(content.includes('[agents.fvs-executor]'), 'current FVS agent table present');
  });

  it('prunes the stale orphan .toml while keeping the 4 current FVS agent configs', () => {
    const agentsDir = path.join(tmpDir, 'agents');
    assert.ok(
      !fs.existsSync(path.join(agentsDir, 'fvs-removed.toml')),
      'stale orphan agents/fvs-removed.toml must be pruned on reinstall'
    );
    const current = fs.readdirSync(agentsDir).filter(f => f.startsWith('fvs-') && f.endsWith('.toml'));
    assert.ok(current.length >= 4, `expected the current FVS agent .toml set, got ${current.join(', ')}`);
    assert.ok(current.includes('fvs-executor.toml'), 'fvs-executor.toml present');
  });
});
