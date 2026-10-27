'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { convertClaudeToAntigravityAgent, convertClaudeToOpencodeFrontmatter,
  generateCodexAgentToml, convertClaudeAgentToCodexAgent, extractFrontmatterAndBody } = require('../bin/install.js');

const ROOT = path.resolve(__dirname, '..');
const PAIR = ['lean_diagnostic_messages', 'lean_goal'];
const CLAUDE_PAIR = PAIR.map(name => `mcp__lean-lsp__${name}`);

// Source-labelled contracts, not loaded runtime code or actual-child evidence.
// Antigravity (agy 1.4.3): `agy plugin validate` requires agents' `tools:` to be a
// YAML list and does not check the names, so the installed footprint below is
// validation-backed only; how agy resolves Claude tool names at runtime is unverified.
const SOURCE_PROVENANCE = {
  opencode: {
    version: '1.18.31',
    binarySha256: '16c960ba77421da11b53e785f359b73f328a86118b48feb4af143db5d9afb198',
    namingSourceBytes: '68195550-68202000; connected catalog 68284100-68284592',
    // Naming: sanitize(server) + '_' + sanitize(tool), replacing /[^a-zA-Z0-9_-]/g.
  },
};

function role(name) {
  return fs.readFileSync(path.join(ROOT, 'agents', `${name}.md`), 'utf8');
}
function frontmatter(source) {
  return source.match(/^---\n([\s\S]*?)\n---/)[1];
}
function claudeTools(source) {
  return frontmatter(source).match(/^tools:\s*(.+)$/m)[1].split(',').map(name => name.trim());
}
function antigravityTools(source) {
  return [...frontmatter(source).matchAll(/^  - (.+)$/gm)].map(match => match[1]);
}
function opencodeTools(source) {
  return [...frontmatter(source).matchAll(/^  (\S+): true$/gm)].map(match => match[1]);
}

// Minimal explicit-registry-selection fixture. Never calls a tool or attests a child.
function registryFixture(separator, server = 'lean-lsp', schemaQualified = false) {
  return PAIR.map(raw => ({
    selector: `${server}${separator}${raw}`, server, raw,
    schema: { name: schemaQualified ? `${server}${separator}${raw}` : raw },
  }));
}
function selectFixture(selectors, registry, denied = []) {
  return selectors.map(name => registry.find(tool => tool.selector === name))
    .filter(tool => tool && !denied.includes(tool.selector));
}
function assertPair(selected) {
  assert.deepEqual(selected.map(tool => [tool.server, tool.raw]), PAIR.map(raw => ['lean-lsp', raw]));
}

const WRITERS = [
  ['fvs-crypto-executor', true], ['fvs-executor', false],
  ['fvs-external-modeler', true], ['fvs-lean-refactorer', false],
];

const CRYPTO = 'fvs-crypto-executor';
describe('Crypto definition -> actual converter -> registry-selection fixture', () => {
  it('grants only the existing built-ins, conditional IDE and narrow Lean pair', () => {
    assert.deepEqual(claudeTools(role(CRYPTO)), [
      'Read', 'Bash', 'Grep', 'Glob', 'Write', 'Edit', 'mcp__ide__getDiagnostics', ...CLAUDE_PAIR,
    ]);
  });

  it('Antigravity installs the exact Claude selectors as a YAML list (validation-backed footprint, runtime resolution unverified)', () => {
    const source = role(CRYPTO);
    const converted = convertClaudeToAntigravityAgent(source);
    assert.deepEqual(antigravityTools(converted), claudeTools(source));
    assert.match(frontmatter(converted), /^tools:\n(?:  - .+\n?)+/m);
  });

  it('OpenCode emits the inspected server_tool selectors without changing built-ins', () => {
    const selectors = opencodeTools(convertClaudeToOpencodeFrontmatter(role(CRYPTO)));
    assertPair(selectFixture(selectors, registryFixture('_')));
    assert.deepEqual(selectors, ['read', 'bash', 'grep', 'glob', 'write', 'edit',
      'ide_getDiagnostics', ...PAIR.map(raw => `lean-lsp_${raw}`)]);
  });

  it('denies wrong server, unqualified selector, missing goals and effective permission denial in fixtures', () => {
    const selectors = PAIR.map(raw => `lean-lsp_${raw}`);
    for (const [requested, registry, denied] of [
      [selectors, registryFixture('_', 'other-server'), []],
      [PAIR, registryFixture('_'), []],
      [selectors, registryFixture('_').slice(0, 1), []],
      [selectors, registryFixture('_'), ['lean-lsp_lean_goal']],
    ]) {
      assert.throws(() => assertPair(selectFixture(requested, registry, denied)), assert.AssertionError);
    }
  });

  it('changes only the tools line for Antigravity (validation-backed footprint, runtime resolution unverified)', () => {
    const source = '---\nname: test\ndescription: d\ntools: Read, Task, mcp__custom__lean_goal\ncolor: pink\n---\n${ROOT} <sub>note</sub>\n';
    assert.equal(convertClaudeToAntigravityAgent(source),
      '---\nname: test\ndescription: d\ntools:\n  - Read\n  - Task\n  - mcp__custom__lean_goal\ncolor: pink\n---\n${ROOT} <sub>note</sub>\n');
    assert.equal(SOURCE_PROVENANCE.opencode.version, '1.18.31');
  });
});

describe('All canonical Lean writers and existing full-role delivery', () => {
  for (const [name, hasIde] of WRITERS) {
    it(`${name} retains exact built-ins and only the standard diagnostic/goal pair`, () => {
      assert.deepEqual(claudeTools(role(name)), ['Read', 'Bash', 'Grep', 'Glob', 'Write',
        ...(name === CRYPTO ? ['Edit'] : []),
        ...(hasIde ? ['mcp__ide__getDiagnostics'] : []), ...CLAUDE_PAIR]);
      // Antigravity: validation-backed installed footprint; runtime resolution unverified.
      assert.deepEqual(antigravityTools(convertClaudeToAntigravityAgent(role(name))), claudeTools(role(name)));
      const opencode = opencodeTools(convertClaudeToOpencodeFrontmatter(role(name)));
      assertPair(selectFixture(opencode, registryFixture('_')));
    });

    it(`${name} gives Codex full body guidance without pretending frontmatter grants permissions`, () => {
      const source = role(name);
      const { body } = extractFrontmatterAndBody(source);
      const toml = generateCodexAgentToml(name, source);
      assert.ok(toml.includes(body.trim()), 'complete body must survive TOML generation');
      assert.doesNotMatch(toml, /^tools\s*=/m, 'no invented native TOML tools key');
      const converted = convertClaudeAgentToCodexAgent(source);
      for (const output of [body, toml, converted]) {
        assert.match(output, /lean_diagnostic_messages/);
        assert.match(output, /lean_goal/);
        assert.match(output, /actual child\s+inventory/i);
        assert.match(output, /other runtimes[\s\S]{0,130}(?:names|selectors)/i);
      }
    });
  }

  it('reaches the same roles through existing named writing dispatches', () => {
    for (const [command, writer] of [
      ['crypto-execute', 'fvs-crypto-executor'], ['lean-specify', 'fvs-executor'],
      ['lean-verify', 'fvs-executor'], ['lean-formalise', 'fvs-executor'],
      ['lean-refactor', 'fvs-lean-refactorer'],
    ]) {
      assert.match(fs.readFileSync(path.join(ROOT, 'commands/fvs', `${command}.md`), 'utf8'),
        new RegExp(`subagent_type="${writer}"`));
    }
    assert.match(fs.readFileSync(path.join(ROOT, 'fv-skills/workflows/model-external.md'), 'utf8'), /fvs-external-modeler/);
    assert.match(fs.readFileSync(path.join(ROOT, 'commands/fvs/lean-formalise.md'), 'utf8'), /Execute mode: formalise/);
  });

  it('scopes executor feedback to Lean writing and leaves map-code/plan alone', () => {
    const source = role('fvs-executor');
    assert.match(source, /spec-generation[\s\S]{0,140}proof-attempt[\s\S]{0,140}formalise[\s\S]{0,140}repairs/i);
    for (const mode of ['map-code', 'plan']) {
      const section = source.split(`<mode name="${mode}">`)[1].split('</mode>')[0];
      assert.doesNotMatch(section, /lean_diagnostic_messages|lean_goal|diagnostics prerequisite/);
    }
  });

  it('keeps Pi canonical-role and plugin-copy contracts without adding an extension or helper', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts/build-plugin.cjs'), 'utf8');
    assert.match(source, /Agent role instructions live under[\s\S]{0,150}agents/);
    assert.match(source, /copyTextTree\(path\.join\(ROOT, 'agents'\), path\.join\(pluginRoot, 'agents'\)\)/);
    assert.doesNotMatch(source, /fvs-lean-diagnostics\.mjs/);
  });
});
