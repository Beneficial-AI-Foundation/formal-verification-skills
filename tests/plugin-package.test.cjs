'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN_ROOT = path.join(ROOT, 'plugins', 'fvs');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function filesUnder(root, relative = '') {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true })
    .flatMap((entry) => {
      const child = relative ? path.join(relative, entry.name) : entry.name;
      return entry.isDirectory() ? filesUnder(root, child) : [child];
    })
    .sort();
}

function basenames(root, suffix) {
  return fs.readdirSync(root)
    .filter((name) => name.endsWith(suffix))
    .map((name) => name.slice(0, -suffix.length))
    .sort();
}

describe('published FVS plugin package', () => {
  it('is synchronized with its deterministic generator', () => {
    childProcess.execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-plugin.cjs'), '--check'], {
      cwd: ROOT,
      stdio: 'pipe',
    });
  });

  it('keeps the 2.2.1 package, payload, and both plugin manifests on one version', () => {
    const version = readJson('package.json').version;
    assert.equal(version, '2.2.1');
    assert.equal(fs.readFileSync(path.join(ROOT, 'fv-skills', 'VERSION'), 'utf8'), version);
    assert.equal(readJson('plugins/fvs/.claude-plugin/plugin.json').version, version);
    assert.equal(readJson('plugins/fvs/.codex-plugin/plugin.json').version, version);
  });

  it('keeps only nested FVS payload manifests, leaving catalog ownership to BAIF', () => {
    assert.ok(!fs.existsSync(path.join(ROOT, '.claude-plugin', 'marketplace.json')));
    assert.ok(!fs.existsSync(path.join(ROOT, '.agents', 'plugins', 'marketplace.json')));

    const claudeManifest = readJson('plugins/fvs/.claude-plugin/plugin.json');
    const codexManifest = readJson('plugins/fvs/.codex-plugin/plugin.json');
    assert.equal(claudeManifest.name, 'fvs');
    assert.equal(codexManifest.name, 'fvs');
  });

  it('exposes every canonical command as a namespaced shared skill', () => {
    const commandNames = basenames(path.join(ROOT, 'commands', 'fvs'), '.md');
    const skillNames = fs.readdirSync(path.join(PLUGIN_ROOT, 'skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    assert.equal(commandNames.length, 27);
    assert.deepEqual(skillNames, commandNames);

    for (const skillName of skillNames) {
      const raw = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', skillName, 'SKILL.md'), 'utf8');
      assert.match(raw, new RegExp(`^name: ${skillName}$`, 'm'), `${skillName} has a portable name`);
      assert.ok(raw.includes('<plugin_runtime>'), `${skillName} has the plugin-root contract`);
      assert.ok(raw.includes('<codex_skill_adapter>'), `${skillName} has the Codex adapter`);
      assert.ok(raw.includes(`$fvs:${skillName}`), `${skillName} documents its Codex invocation`);
    }
  });

  it('bundles every Claude agent and the intended support payload', () => {
    assert.deepEqual(
      basenames(path.join(PLUGIN_ROOT, 'agents'), '.md'),
      basenames(path.join(ROOT, 'agents'), '.md'),
    );
    assert.equal(basenames(path.join(PLUGIN_ROOT, 'agents'), '.md').length, 13);

    const canonicalSupport = filesUnder(path.join(ROOT, 'fv-skills'))
      .filter((relative) => relative !== path.join('workflows', 'update.md'));
    assert.deepEqual(filesUnder(path.join(PLUGIN_ROOT, 'fv-skills')), canonicalSupport);
    assert.deepEqual(
      filesUnder(path.join(PLUGIN_ROOT, 'scripts')),
      [
        'fvs-codex-think.mjs',
        'fvs-kb-query.py',
        'fvs-lean-style-check.mjs',
        'fvs-probe-inventory.mjs',
      ].sort(),
    );
  });

  it('uses the portable plugin-root inventory helper in map-code and trust-audit', () => {
    for (const skillName of ['map-code', 'trust-audit']) {
      const raw = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', skillName, 'SKILL.md'), 'utf8');
      assert.ok(raw.includes('${CLAUDE_PLUGIN_ROOT}/scripts/fvs-probe-inventory.mjs'));
      assert.ok(!raw.includes('~/.claude/scripts/fvs-probe-inventory.mjs'));
    }
  });

  it('contains only plugin-root paths and no mutable npm-install updater', () => {
    for (const relative of filesUnder(PLUGIN_ROOT)) {
      if (relative.endsWith('.png')) continue;
      const raw = fs.readFileSync(path.join(PLUGIN_ROOT, relative), 'utf8');
      assert.ok(!raw.includes('~/.claude/'), `${relative} contains a home Claude path`);
      assert.ok(!raw.includes('$HOME/.claude/'), `${relative} contains a HOME Claude path`);
      assert.ok(!raw.includes('./.claude/'), `${relative} contains a project Claude path`);
    }

    assert.ok(!fs.existsSync(path.join(PLUGIN_ROOT, 'fv-skills', 'workflows', 'update.md')));
    const updateSkill = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', 'update', 'SKILL.md'), 'utf8');
    assert.ok(updateSkill.includes('claude plugin update fvs@beneficial-ai-foundation'));
    assert.ok(updateSkill.includes('codex plugin marketplace upgrade beneficial-ai-foundation'));
    assert.ok(updateSkill.includes('codex plugin add fvs@beneficial-ai-foundation'));
    assert.ok(!updateSkill.includes('npx fv-skills-baif'));
  });

  it('documents the BAIF catalog install and update contract for both runtimes', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const publicText = [readme, fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', 'update', 'SKILL.md'), 'utf8')].join('\n');
    assert.ok(readme.includes('Beneficial-AI-Foundation/plugins'));
    assert.ok(readme.includes('claude plugin marketplace add Beneficial-AI-Foundation/plugins'));
    assert.ok(readme.includes('claude plugin install fvs@beneficial-ai-foundation'));
    assert.ok(readme.includes('codex plugin marketplace add Beneficial-AI-Foundation/plugins'));
    assert.ok(readme.includes('codex plugin add fvs@beneficial-ai-foundation'));
    assert.ok(readme.includes('/fvs:help'));
    assert.ok(readme.includes('$fvs:help'));
    assert.ok(!publicText.includes('@formal-verification-skills'));
  });
});
