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

  it('creates agents/ with at least 5 fvs-*.md files', () => {
    const agentDir = path.join(tmpDir, 'agents');
    assert.ok(fs.existsSync(agentDir), 'agents/ missing');
    const fvsAgents = fs.readdirSync(agentDir).filter(f => f.startsWith('fvs-') && f.endsWith('.md'));
    assert.ok(fvsAgents.length >= 5, `Expected >= 5 agent files, got ${fvsAgents.length}`);
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
