'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

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

describe('Fresh local Codex install', () => {
  it('creates .codex before inspecting local patches', () => {
    const project = makeTmpDir('fvs-fresh-local-codex-');
    assert.ok(!fs.existsSync(path.join(project, '.codex')));
    execFileSync(process.execPath, [INSTALLER, '--codex', '--local'], {
      cwd: project,
      env: { ...process.env, HOME: project },
      stdio: 'pipe',
    });
    assert.ok(fs.existsSync(path.join(project, '.codex', 'fvs-file-manifest.json')));
  });
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
      'commands/fvs/crypto-review.md',
      'commands/fvs/lean-spec-review.md',
      'agents/fvs-researcher.md',
      'fv-skills/references/crypto-plan-review.md',
      'fv-skills/references/fc-spec-review.md',
      'fv-skills/references/proof-engineering-loop.md',
      'fv-skills/templates/proof-engineering-index.md',
      'fv-skills/templates/proof-engineering-lesson.md',
      'fv-skills/workflows/crypto-review.md',
      'fv-skills/workflows/lean-verify.md',
      'fv-skills/workflows/lean-spec-review.md',
      'fv-skills/upstream/aeneas/_sync-meta.json',
      'scripts/fvs-codex-think.mjs',
      'scripts/fvs-lean-style-check.mjs',
      'scripts/fvs-probe-inventory.mjs',
      'scripts/fvs-probe-linux.mjs',
      'scripts/fvs-spec-review.mjs',
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
  let reconciledConfig;

  function installCodex(dir) {
    execFileSync(process.execPath, [
      INSTALLER, '--codex', '--global', '--config-dir', dir,
    ], {
      cwd: ROOT,
      env: { ...process.env, HOME: dir, CODEX_HOME: dir },
      stdio: 'pipe',
    });
  }

  function installedRoleNames(dir, configContent) {
    const agentsDir = path.join(dir, 'agents');
    const standalone = fs.readdirSync(agentsDir)
      .filter((file) => /^fvs-.*\.toml$/.test(file))
      .map((file) => fs.readFileSync(path.join(agentsDir, file), 'utf8').match(/^name = "([^"]+)"$/m)?.[1])
      .filter(Boolean);
    const declared = [...configContent.matchAll(/^\[agents\.(fvs-[^\]]+)\]$/gm)].map((match) => match[1]);
    return [...standalone, ...declared];
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
      'name = "catalog-user-model"',
      '',
      '[agents.gsd-foo]',
      'description = "a gsd agent"',
      'config_file = "' + tmpDir.replace(/\\/g, '/') + '/agents/gsd-foo.toml"',
      '',
    ].join('\n');
    const legacy = [
      '[agents.fvs-legacy]',
      'description = "legacy FVS role"',
      'config_file = "' + tmpDir.replace(/\\/g, '/') + '/agents/fvs-legacy.toml"',
      '',
      '[[agents]]',
      'name = "fvs-array-legacy"',
      'config_file = "' + tmpDir.replace(/\\/g, '/') + '/agents/fvs-array-legacy.toml"',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, foreign + '\n' + legacy + existing);

    // Plant a stale per-agent .toml for an agent FVS no longer ships.
    const agentsDir = path.join(tmpDir, 'agents');
    fs.writeFileSync(path.join(agentsDir, 'fvs-removed.toml'), 'name = "fvs-removed"\n');
    assert.ok(fs.existsSync(path.join(agentsDir, 'fvs-removed.toml')), 'stale orphan planted');
  });

  it('reinstalls --codex over the seeded config without error', () => {
    installCodex(tmpDir);
    reconciledConfig = fs.readFileSync(path.join(tmpDir, 'config.toml'), 'utf8');
  });

  it('is byte-stable on a second reinstall', () => {
    installCodex(tmpDir);
    assert.equal(
      fs.readFileSync(path.join(tmpDir, 'config.toml'), 'utf8'),
      reconciledConfig,
      'reinstall should converge to one stable config shape',
    );
  });

  it('preserves the foreign [model] and [agents.gsd-foo] tables', () => {
    const content = fs.readFileSync(path.join(tmpDir, 'config.toml'), 'utf8');
    assert.ok(content.includes('[model]'), 'user [model] table survives reinstall');
    assert.ok(content.includes('name = "catalog-user-model"'), 'user table body survives reinstall');
    assert.ok(content.includes('[agents.gsd-foo]'), 'GSD [agents.gsd-foo] table survives reinstall');
  });

  it('re-emits one marker, migrates legacy roles, and keeps role identities unique', () => {
    const content = fs.readFileSync(path.join(tmpDir, 'config.toml'), 'utf8');
    const markerCount = content.split('managed by fv-skills-baif installer').length - 1;
    assert.equal(markerCount, 1, 'exactly one FVS marker after reinstall (no duplication)');
    assert.match(content, /^\[agents\]$/m, 'global [agents] settings table present');
    assert.match(content, /^max_concurrent_threads_per_session = 4$/m, 'canonical concurrency default present');
    assert.ok(!content.includes('[agents.fvs-'), 'current FVS roles are not repeated in config.toml');
    assert.ok(!content.includes('fvs-legacy'), 'legacy struct role removed');
    assert.ok(!content.includes('fvs-array-legacy'), 'legacy array role removed');
    const names = installedRoleNames(tmpDir, content);
    assert.ok(names.length > 0, 'current standalone FVS TOMLs present');
    assert.equal(new Set(names).size, names.length, 'every installed FVS role occurs once');
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

  it('uninstalls FVS settings without deleting foreign model, GSD, or user agent settings', () => {
    const configPath = path.join(tmpDir, 'config.toml');
    const content = fs.readFileSync(configPath, 'utf8');
    fs.writeFileSync(configPath, content.replace(
      '[agents]',
      '[agents]\ncustom_user_agent_setting = true',
    ));
    execFileSync(process.execPath, [INSTALLER, '--codex', '--global', '--config-dir', tmpDir, '--uninstall'], {
      cwd: ROOT,
      env: { ...process.env, HOME: tmpDir, CODEX_HOME: tmpDir },
      stdio: 'pipe',
    });
    const cleaned = fs.readFileSync(configPath, 'utf8');
    assert.ok(cleaned.includes('[model]'), 'foreign model table preserved on uninstall');
    assert.ok(cleaned.includes('[agents.gsd-foo]'), 'foreign GSD agent table preserved on uninstall');
    assert.ok(cleaned.includes('custom_user_agent_setting = true'), 'user [agents] setting preserved');
    assert.ok(!cleaned.includes('max_concurrent_threads_per_session = 4'), 'only FVS-owned default removed');
    assert.ok(!cleaned.includes('managed by fv-skills-baif installer'), 'FVS marker removed');
  });
});

describe('Codex portable standalone discovery', () => {
  let originalDir;
  let relocatedDir;

  it('installs once, relocates the config directory, and leaves no original path in config.toml', () => {
    originalDir = makeTmpDir('fvs-codex-original-');
    relocatedDir = makeTmpDir('fvs-codex-relocated-');
    execFileSync(process.execPath, [INSTALLER, '--codex', '--global', '--config-dir', originalDir], {
      cwd: ROOT,
      env: { ...process.env, HOME: originalDir, CODEX_HOME: originalDir },
      stdio: 'pipe',
    });
    fs.cpSync(originalDir, relocatedDir, { recursive: true });
    const config = fs.readFileSync(path.join(relocatedDir, 'config.toml'), 'utf8');
    assert.ok(!config.includes(originalDir.replace(/\\/g, '/')), 'config.toml contains no original absolute path');
    assert.ok(!config.includes('config_file'), 'standalone discovery needs no config_file reference');
    const names = fs.readdirSync(path.join(relocatedDir, 'agents'))
      .filter((file) => /^fvs-.*\.toml$/.test(file))
      .map((file) => fs.readFileSync(path.join(relocatedDir, 'agents', file), 'utf8').match(/^name = "([^"]+)"$/m)?.[1]);
    assert.ok(names.every(Boolean), 'every installed standalone TOML declares its name');
    assert.equal(new Set(names).size, names.length, 'relocated roles remain unique');
  });
});

describe('installed tree matches final bundle shape', () => {
  // Upgrades the round-trip from the >= N directory-shape granularity to exact
  // bundle granularity: a fresh install must carry all 5 bundle routers and all
  // 8 new-bundle agents. This catches an installer copy-list omission that the
  // source-only frontmatter gate cannot see (a file present in the source tree
  // but missing from bin/install.js's copy list).
  let tmpDir;

  const ROUTERS = ['aeneas.md', 'fc.md', 'formalise.md', 'context.md', 'manage.md'];
  const NEW_AGENTS = [
    'fvs-extract-classifier.md', 'fvs-extract-applier.md', 'fvs-extract-bisector.md',
    'fvs-equivalence-assessor.md', 'fvs-draft-investigator.md', 'fvs-doc-syncer.md',
    'fvs-crypto-thinker.md', 'fvs-axiom-auditor.md',
  ];

  it('installs to a temp directory without error', () => {
    tmpDir = makeTmpDir('fvs-final-shape-');
    execFileSync(process.execPath, [
      INSTALLER, '--claude', '--global', '--config-dir', tmpDir,
    ], {
      cwd: ROOT,
      env: { ...process.env, HOME: tmpDir },
      stdio: 'pipe',
    });
  });

  it('installs all 5 bundle routers under commands/fvs', () => {
    for (const r of ROUTERS) {
      assert.ok(
        fs.existsSync(path.join(tmpDir, 'commands', 'fvs', r)),
        `router missing after install: ${r}`
      );
    }
  });

  it('installs all 8 new-bundle agents under agents/', () => {
    for (const a of NEW_AGENTS) {
      assert.ok(
        fs.existsSync(path.join(tmpDir, 'agents', a)),
        `new-bundle agent missing after install: ${a}`
      );
    }
  });

  it('installs valid Aeneas sync metadata (issue #29)', () => {
    const metaPath = path.join(
      tmpDir, 'fv-skills', 'upstream', 'aeneas', '_sync-meta.json'
    );
    assert.ok(fs.existsSync(metaPath), '_sync-meta.json missing after install');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.equal(meta.upstream_source, 'AeneasVerif/aeneas');
    assert.ok(Array.isArray(meta.mapping) && meta.mapping.length > 0,
      'sync metadata must contain at least one mapping');
    assert.ok(meta.tactic_renames && typeof meta.tactic_renames === 'object',
      'sync metadata must contain tactic_renames');
    assert.match(meta.snapshot_commit, /^[a-f0-9]{40}$/,
      'sync metadata must contain an exact snapshot commit');
    assert.ok(!Number.isNaN(Date.parse(meta.snapshot_date)),
      'sync metadata must contain a parseable snapshot commit date');
    assert.match(meta.charon_pin, /^[a-f0-9]{40}$/,
      'sync metadata must contain the Aeneas Charon pin');
    assert.ok(Array.isArray(meta.extraction_inputs) && meta.extraction_inputs.length > 0,
      'sync metadata must contain exact extraction inputs');
    for (const input of meta.extraction_inputs.filter(x => x.disposition === 'sync')) {
      const target = path.join(tmpDir, input.snapshot_target);
      assert.ok(fs.existsSync(target), `installed snapshot missing: ${input.snapshot_target}`);
      const hash = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
      assert.equal(hash, input.sha256, `installed snapshot hash mismatch: ${input.snapshot_target}`);
    }
  });

  it('installs runtime-scoped model and effort overrides', () => {
    const configPath = path.join(tmpDir, 'fv-skills', 'templates', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(config.model_profile, 'quality',
      'model_profile must use the top-level schema consumed by commands');
    for (const runtime of ['claude', 'codex', 'pi', 'opencode', 'antigravity']) {
      assert.deepEqual(config.model_overrides?.[runtime], {}, `${runtime} model overrides`);
      assert.deepEqual(config.effort_overrides?.[runtime], {}, `${runtime} effort overrides`);
    }
    assert.ok(!Object.hasOwn(config, 'model'),
      'obsolete nested model config would be ignored by command resolvers');
  });
});

describe('probe runtime dependencies in every direct install mode', () => {
  for (const runtime of ['claude', 'codex', 'opencode', 'antigravity']) {
    for (const scope of ['local', 'global']) {
      it(`${runtime} ${scope} installs both probe modules and resolves without missing imports`, () => {
        const directory = makeTmpDir(`fvs-probe-${runtime}-${scope}-`);
        const home = path.join(directory, 'home');
        const project = path.join(directory, 'project');
        fs.mkdirSync(home);
        fs.mkdirSync(project);
        const configDir = scope === 'global' ? path.join(directory, 'installed')
          : path.join(project, runtime === 'antigravity' ? '.agents' : `.${runtime}`);
        const target = runtime === 'antigravity' ? path.join(configDir, 'plugins', 'fvs') : configDir;
        const args = [INSTALLER, `--${runtime}`, `--${scope}`];
        if (scope === 'global') args.push('--config-dir', configDir);
        const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };
        execFileSync(process.execPath, args, { cwd: project, env, stdio: 'pipe' });
        for (const name of ['fvs-probe-inventory.mjs', 'fvs-probe-linux.mjs']) {
          assert.ok(fs.existsSync(path.join(target, 'scripts', name)), name);
        }
        const result = JSON.parse(execFileSync(process.execPath, [path.join(target, 'scripts', 'fvs-probe-inventory.mjs'), 'resolve', '--project-root', project], { env, encoding: 'utf8' }));
        assert.ok(['unsupported-platform', 'unknown'].includes(result.status));
      });
    }
  }
});

describe('Antigravity native plugin install', () => {
  const pkgVersion = require('../package.json').version;
  // Every run gets a scratch HOME and cwd: the installer also sweeps ~/.gemini.
  function runInstaller(scratch, argv, cwd = scratch) {
    return spawnSync(process.execPath, [INSTALLER, ...argv], {
      cwd, env: { ...process.env, HOME: scratch, USERPROFILE: scratch }, encoding: 'utf8',
    });
  }
  function hashTree(dir, skip = () => false) {
    const out = {};
    const walk = (current, rel = '') => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (skip(childRel)) continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full, childRel);
        else out[childRel] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      }
    };
    if (fs.existsSync(dir)) walk(dir);
    return out;
  }
  function write(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  function seedLegacyGemini(gemini) {
    write(path.join(gemini, 'commands/fvs/help.toml'), 'prompt = "x"\n');
    write(path.join(gemini, 'agents/fvs-executor.md'), '---\nname: fvs-executor\n---\n');
    write(path.join(gemini, 'agents/user-agent.md'), '---\nname: user-agent\n---\n');
    write(path.join(gemini, 'fv-skills/VERSION'), '2.0.0');
    write(path.join(gemini, 'hooks/fvs-check-update.js'), '// old\n');
    write(path.join(gemini, 'settings.json'), JSON.stringify({
      foreign: 'keep',
      hooks: { SessionStart: [
        { hooks: [{ type: 'command', command: 'node foreign-hook.js' }] },
        { hooks: [{ type: 'command', command: `node "${gemini}/hooks/fvs-check-update.js"` }] },
      ] },
      statusLine: { type: 'command', command: `node "${gemini}/hooks/fvs-statusline.js"` },
      experimental: { enableAgents: true },
    }));
    // agy's own files: must survive byte-identical.
    write(path.join(gemini, 'config/config.json'), '{"plugins":{"other":true}}\n');
    write(path.join(gemini, 'config/plugins/other/plugin.json'), '{"name":"other"}\n');
    write(path.join(gemini, 'config/skills/fvs-own/SKILL.md'), '---\nname: fvs-own\n---\nmine\n');
    write(path.join(gemini, 'antigravity-cli/fvs-note.md'), 'note\n');
  }
  const agyOwned = gemini => ({
    config: hashTree(path.join(gemini, 'config'), rel => rel === 'plugins/fvs'),
    cli: hashTree(path.join(gemini, 'antigravity-cli')),
  });
  function assertLegacyCleaned(gemini) {
    assert.ok(!fs.existsSync(path.join(gemini, 'commands/fvs')), 'legacy commands/fvs removed');
    assert.ok(!fs.existsSync(path.join(gemini, 'agents/fvs-executor.md')), 'legacy FVS agent removed');
    assert.ok(fs.existsSync(path.join(gemini, 'agents/user-agent.md')), 'foreign agent kept');
    assert.ok(!fs.existsSync(path.join(gemini, 'fv-skills')), 'legacy fv-skills removed');
    assert.ok(!fs.existsSync(path.join(gemini, 'hooks/fvs-check-update.js')), 'legacy hook removed');
    const settings = JSON.parse(fs.readFileSync(path.join(gemini, 'settings.json'), 'utf8'));
    assert.deepEqual(settings, {
      foreign: 'keep',
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node foreign-hook.js' }] }] },
    });
  }

  const scratch = makeTmpDir('fvs-agy-global-');
  const gemini = path.join(scratch, '.gemini');
  const pluginRoot = path.join(gemini, 'config', 'plugins', 'fvs');
  let before;

  it('installs a native plugin under ~/.gemini/config/plugins/fvs and clears the old Gemini install', () => {
    seedLegacyGemini(gemini);
    before = agyOwned(gemini);
    const result = runInstaller(scratch, ['--antigravity', '--global']);
    assert.equal(result.status, 0, result.stderr);

    const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'plugin.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest).sort(), ['description', 'displayName', 'name', 'version']);
    assert.equal(manifest.name, 'fvs');
    assert.equal(manifest.version, pkgVersion);

    const skills = fs.readdirSync(path.join(pluginRoot, 'skills'));
    assert.equal(skills.length, 32);
    for (const name of skills) {
      const skillFile = path.join(pluginRoot, 'skills', name, 'SKILL.md');
      const text = fs.readFileSync(skillFile, 'utf8');
      assert.match(text, new RegExp(`^---\\nname: ${name}\\ndescription: "`), `${name} frontmatter`);
      assert.ok(fs.statSync(skillFile).size < 24000, `${name} stub under agy's body limit`);
      assert.ok(text.includes(`${pluginRoot}/skills/${name}/references/${name}.md`), `${name} stub names its reference`);
      const reference = fs.readFileSync(path.join(pluginRoot, 'skills', name, 'references', `${name}.md`), 'utf8');
      assert.doesNotMatch(reference, /~\/\.claude\//, `${name} reference paths converted`);
    }

    const agents = fs.readdirSync(path.join(pluginRoot, 'agents')).filter(n => /^fvs-.*\.md$/.test(n));
    assert.equal(agents.length, 14);
    for (const agent of agents) {
      assert.match(fs.readFileSync(path.join(pluginRoot, 'agents', agent), 'utf8'), /^tools:\n  - \S/m, agent);
    }

    assert.ok(fs.existsSync(path.join(pluginRoot, 'hooks', 'fvs-check-update.js')));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(pluginRoot, 'hooks.json'), 'utf8')), {
      'fvs-check-update': { SessionStart: [{ type: 'command', command: 'node hooks/fvs-check-update.js' }] },
    });
    assert.equal(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'), '{"type":"commonjs"}\n');
    assert.ok(fs.existsSync(path.join(pluginRoot, 'fvs-file-manifest.json')));
    assert.ok(!fs.existsSync(path.join(pluginRoot, 'settings.json')), 'agy install never writes settings.json');

    assertLegacyCleaned(gemini);
    assert.deepEqual(agyOwned(gemini), before, 'agy config and antigravity-cli untouched by install');
  });

  it('uninstalls the plugin directory but keeps local patches and sibling plugins', () => {
    write(path.join(pluginRoot, 'fvs-local-patches', 'agents', 'fvs-executor.md'), 'patched\n');
    const result = runInstaller(scratch, ['--agy', '--global', '--uninstall']);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readdirSync(pluginRoot), ['fvs-local-patches']);
    assert.ok(fs.existsSync(path.join(gemini, 'config/plugins/other/plugin.json')));
    assert.deepEqual(agyOwned(gemini), before, 'agy config and antigravity-cli untouched by uninstall');
  });

  it('uninstall clears an old Gemini install even without a plugin directory', () => {
    const home = makeTmpDir('fvs-agy-legacy-only-');
    const legacy = path.join(home, '.gemini');
    seedLegacyGemini(legacy);
    const owned = agyOwned(legacy);
    const result = runInstaller(home, ['--antigravity', '--global', '--uninstall']);
    assert.equal(result.status, 0, result.stderr);
    assertLegacyCleaned(legacy);
    assert.deepEqual(agyOwned(legacy), owned);
  });

  it('installs locally under .agents/plugins/fvs with project-relative stub paths', () => {
    const project = makeTmpDir('fvs-agy-local-');
    const result = runInstaller(project, ['--agy', '--local']);
    assert.equal(result.status, 0, result.stderr);
    const stub = fs.readFileSync(path.join(project, '.agents/plugins/fvs/skills/help/SKILL.md'), 'utf8');
    assert.ok(stub.includes('./.agents/plugins/fvs/skills/help/references/help.md'));
    assert.ok(fs.existsSync(path.join(project, '.agents/plugins/fvs/plugin.json')));
  });

  it('--gemini points to --antigravity and installs nothing', () => {
    const home = makeTmpDir('fvs-agy-gemini-flag-');
    const result = runInstaller(home, ['--gemini', '--global']);
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}${result.stderr}`, /--antigravity/);
    assert.ok(!fs.existsSync(path.join(home, '.claude')));
    assert.ok(!fs.existsSync(path.join(home, '.gemini')));
  });

  it('refuses a symlinked plugin directory', () => {
    const home = makeTmpDir('fvs-agy-symlink-');
    const target = makeTmpDir('fvs-agy-symlink-target-');
    write(path.join(target, 'sentinel'), 'keep\n');
    fs.mkdirSync(path.join(home, '.gemini/config/plugins'), { recursive: true });
    fs.symlinkSync(target, path.join(home, '.gemini/config/plugins/fvs'));
    const result = runInstaller(home, ['--antigravity', '--global']);
    assert.notEqual(result.status, 0);
    assert.deepEqual(fs.readdirSync(target), ['sentinel']);
  });

  it('passes agy plugin validate (scratch HOME) when agy is on PATH', t => {
    const home = makeTmpDir('fvs-agy-validate-');
    assert.equal(runInstaller(home, ['--antigravity', '--global']).status, 0);
    const root = path.join(home, '.gemini/config/plugins/fvs');
    const result = spawnSync('agy', ['plugin', 'validate', root, '--json'], {
      cwd: home, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 60000,
    });
    if (result.error?.code === 'ENOENT') {
      t.skip('agy is not on PATH');
      return;
    }
    assert.ifError(result.error);
    const report = JSON.parse(result.stdout);
    assert.deepEqual((report.findings ?? []).filter(f => f.severity === 'error'), []);
    assert.equal(report.components.agents, 14);
    assert.equal(report.components.skills, 32);
    assert.equal(report.components.hooks, 1);
  });
});
