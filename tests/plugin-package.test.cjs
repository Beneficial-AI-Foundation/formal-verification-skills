'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN_ROOT = path.join(ROOT, 'plugins', 'fvs');
const { renderPluginSkill } = require('../scripts/build-plugin.cjs');

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
  it('marketplace role warning is conditional in emitted skill adapters', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const marketplace = readme.slice(readme.indexOf('### Plugin marketplace'), readme.indexOf('### Unified npm installer'));
    const prose = marketplace.replace(/\s+/g, ' ');
    assert.match(prose, /ships the FVS agent prompts as Markdown but does not register them as Codex agent roles/);
    assert.match(prose, /asks for an FVS specialist that Codex has not registered, FVS warns you/);
    assert.match(prose, /does not guarantee the specialist's identity, sandbox, model, or reasoning effort/);
    assert.match(prose, /FVS stops before starting the agent or writing files/);
    assert.match(marketplace, /#### Codex specialist roles/);
    assert.match(prose, /The npm installer installs a complete, separately managed FVS for Codex/);
    assert.match(marketplace, /codex plugin remove fvs@beneficial-ai-foundation\nnpx fv-skills-baif --codex --global/);
    assert.match(prose, /including with `\$fvs:update`, never registers roles or runs the npm installer/);
    const manifest = readJson('plugins/fvs/.codex-plugin/plugin.json');
    assert.ok(!Object.prototype.hasOwnProperty.call(manifest, 'agents'), 'marketplace manifest must not claim agent registration');
    for (const skillName of ['map-code', 'lean-specify', 'help']) {
      const source = path.join(ROOT, 'commands', 'fvs', `${skillName}.md`);
      const rendered = renderPluginSkill(source, skillName);
      const adapter = rendered.match(/<codex_skill_adapter>[\s\S]*?<\/codex_skill_adapter>/)?.[0];
      assert.ok(adapter, `${skillName} has a generated-in-memory Codex adapter`);
      assert.match(adapter, /When a workflow requests a named FVS specialist/);
      assert.match(adapter, /warn the user in plain language: Requested FVS specialist <agent-name>/);
      assert.match(adapter, /If the exact role is registered[\s\S]*WITHOUT a missing-role warning/);
      assert.match(adapter, /even if `agent_type` is present, warn/);
      assert.match(adapter, /If the field is absent, typed dispatch is also unavailable/);
      assert.match(adapter, /generic-agent workaround/);
      assert.match(adapter, /stop before dispatch or artifact writes/);
      assert.match(adapter, /This block applies only when this shared skill runs in Codex. Claude Code must ignore it/);
      assert.ok(!rendered.slice(0, rendered.indexOf('<codex_skill_adapter>')).includes('Requested FVS specialist <agent-name>'), 'no cross-runtime warning');
      assert.ok(!rendered.slice(0, rendered.indexOf('## C. Task()')).includes('Requested FVS specialist <agent-name>'), 'no entry-time warning');
    }
  });
  it('is synchronized with its deterministic generator', () => {
    childProcess.execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-plugin.cjs'), '--check'], {
      cwd: ROOT,
      stdio: 'pipe',
    });
  });

  it('keeps the 2.3.6 package, payload, and both plugin manifests on one version', () => {
    const version = readJson('package.json').version;
    assert.equal(version, '2.3.6');
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
    assert.equal(commandNames.length, 30);
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
    assert.equal(basenames(path.join(PLUGIN_ROOT, 'agents'), '.md').length, 14);

    const canonicalSupport = filesUnder(path.join(ROOT, 'fv-skills'))
      .filter((relative) => relative !== path.join('workflows', 'update.md'));
    assert.deepEqual(filesUnder(path.join(PLUGIN_ROOT, 'fv-skills')), canonicalSupport);
    assert.deepEqual(
      filesUnder(path.join(PLUGIN_ROOT, 'scripts')),
      [
        'fvs-codex-think.mjs',
        'fvs-kb-query.py',
        'fvs-lean-style-check.mjs',
        'fvs-model-external.mjs',
        'fvs-model-review.mjs',
        'fvs-probe-inventory.mjs',
        'fvs-review-grounding.mjs',
        'fvs-spec-review.mjs',
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
    // Marketplace and npm installs are separate channels; no plugin file may send a user to npm.
    for (const relative of filesUnder(PLUGIN_ROOT)) {
      if (relative.endsWith('.png')) continue;
      assert.ok(!fs.readFileSync(path.join(PLUGIN_ROOT, relative), 'utf8').includes('npx fv-skills-baif'),
        `${relative} points marketplace users at the npm installer`);
    }
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
