'use strict';

// Emit-shape regression gate for the Codex converter.
//
// Asserts the two emit functions produce TOML that current Codex CLI (>=0.124)
// accepts: struct-form [agents.<name>] tables with absolute config_file paths,
// no deprecated [features]/multi_agent/[agents] globals, per-agent sandbox
// settings, and an effort-only model policy (model_reasoning_effort present,
// model absent — Codex owns the model, FVS owns the thinking budget).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  generateCodexConfigBlock,
  generateCodexAgentToml,
  getCodexSkillAdapterHeader,
  convertClaudeToCodexMarkdown,
  stripFvsFromCodexConfig,
  FVS_CODEX_MARKER,
  CODEX_AGENT_SANDBOX,
  FVS_CODEX_AGENT_EFFORT,
} = require('../bin/install.js');

// The four currently-shipped FVS agents and their expected sandbox/effort tiers.
const AGENTS = [
  { name: 'fvs-executor', sandbox: 'workspace-write', effort: 'xhigh' },
  { name: 'fvs-lean-refactorer', sandbox: 'workspace-write', effort: 'xhigh' },
  { name: 'fvs-explainer', sandbox: 'read-only', effort: 'xhigh' },
  { name: 'fvs-researcher', sandbox: 'read-only', effort: 'high' },
];

function agentMarkdown(name, description) {
  return `---\nname: ${name}\ndescription: ${description}\ntools: Read, Write\ncolor: orange\n---\n\n# ${name}\n\nDo the work. Preserve regexes like \\d+ and shell snippets like $(pwd).\n`;
}

describe('Codex config block (generateCodexConfigBlock)', () => {
  const blockAgents = AGENTS.map((a) => ({ name: a.name, description: `The ${a.name} agent` }));

  it('starts with the FVS marker', () => {
    const result = generateCodexConfigBlock(blockAgents, '/home/user/.codex');
    assert.ok(result.startsWith(FVS_CODEX_MARKER), 'block must open with FVS_CODEX_MARKER');
  });

  it('emits no deprecated [features]/multi_agent/global [agents] keys', () => {
    const result = generateCodexConfigBlock(blockAgents, '/home/user/.codex');
    assert.ok(!result.includes('[features]'), 'no [features] block');
    assert.ok(!result.includes('multi_agent'), 'no multi_agent key');
    assert.ok(!result.includes('default_mode_request_user_input'), 'no default_mode_request_user_input key');
    assert.ok(!result.includes('max_threads'), 'no max_threads key');
    assert.ok(!result.includes('max_depth'), 'no max_depth key');
    assert.ok(!/^\[agents\]\s*$/m.test(result), 'no bare [agents] line');
    assert.ok(!result.includes('[[agents]]'), 'no [[agents]] array-of-tables');
  });

  it('emits a struct-form [agents.<name>] header per agent', () => {
    const result = generateCodexConfigBlock(blockAgents, '/home/user/.codex');
    for (const { name } of blockAgents) {
      assert.ok(result.includes(`[agents.${name}]`), `missing [agents.${name}] table`);
    }
  });

  it('emits absolute forward-slash config_file paths under targetDir', () => {
    const result = generateCodexConfigBlock(blockAgents, '/home/user/.codex');
    assert.ok(
      result.includes('config_file = "/home/user/.codex/agents/fvs-executor.toml"'),
      'config_file must be an absolute path under targetDir',
    );
    assert.ok(!result.includes('config_file = "agents/'), 'config_file must never be relative');
  });
});

describe('Codex per-agent .toml (generateCodexAgentToml)', () => {
  for (const { name, sandbox, effort } of AGENTS) {
    it(`emits the correct sandbox and effort for ${name}`, () => {
      const toml = generateCodexAgentToml(name, agentMarkdown(name, `The ${name} agent`));
      assert.ok(toml.includes(`sandbox_mode = "${sandbox}"`), `${name} must be ${sandbox}`);
      assert.ok(
        toml.includes(`model_reasoning_effort = "${effort}"`),
        `${name} must run at ${effort}`,
      );
    });

    it(`emits no model line and uses a literal triple-quote delimiter for ${name}`, () => {
      const toml = generateCodexAgentToml(name, agentMarkdown(name, `The ${name} agent`));
      assert.ok(!/^model = /m.test(toml), `${name} must inherit the Codex model (no model line)`);
      assert.ok(toml.includes("developer_instructions = '''"), 'instructions use literal triple-quote');
      assert.ok(!toml.includes('developer_instructions = """'), 'no basic double-quote delimiter');
    });

    it(`quotes name/description/sandbox/effort values for ${name}`, () => {
      const toml = generateCodexAgentToml(name, agentMarkdown(name, `The ${name} agent`));
      assert.ok(toml.includes(`name = "${name}"`), 'name quoted');
      assert.ok(toml.includes('description = "The ' + name + ' agent"'), 'description quoted');
    });
  }

  it('fails closed for an agent absent from both maps', () => {
    assert.equal(CODEX_AGENT_SANDBOX['fvs-unknown'], undefined);
    assert.equal(FVS_CODEX_AGENT_EFFORT['fvs-unknown'], undefined);
    const toml = generateCodexAgentToml('fvs-unknown', agentMarkdown('fvs-unknown', 'Unknown agent'));
    assert.ok(toml.includes('sandbox_mode = "read-only"'), 'unmapped name -> read-only');
    assert.ok(toml.includes('model_reasoning_effort = "high"'), 'unmapped name -> high effort');
  });
});

describe('Codex skill adapter header (getCodexSkillAdapterHeader)', () => {
  it('wraps the header in the codex_skill_adapter tag and has A/B/C sections', () => {
    const header = getCodexSkillAdapterHeader('fvs-fc-plan');
    assert.ok(header.includes('<codex_skill_adapter>'), 'has opening tag');
    assert.ok(header.includes('</codex_skill_adapter>'), 'has closing tag');
    assert.ok(header.includes('## A.'), 'has section A');
    assert.ok(header.includes('## B.'), 'has section B');
    assert.ok(header.includes('## C.'), 'has section C');
  });

  it('documents invocation, the FVS_ARGS token, and the skill name', () => {
    const header = getCodexSkillAdapterHeader('fvs-fc-plan');
    assert.ok(header.includes('`$fvs-fc-plan`'), 'documents the $skillName invocation');
    assert.ok(header.includes('{{FVS_ARGS}}'), 'emits the {{FVS_ARGS}} token');
  });

  it('maps AskUserQuestion to request_user_input with multi-select handling', () => {
    const header = getCodexSkillAdapterHeader('fvs-lean-verify');
    assert.ok(header.includes('request_user_input'), 'maps to request_user_input');
    assert.ok(header.includes('multiSelect'), 'documents the multiSelect workaround');
    assert.ok(header.includes('Execute mode'), 'documents the Execute mode fallback');
  });

  it('is fail-closed in execute mode (no silent default, no artifact writes)', () => {
    const header = getCodexSkillAdapterHeader('fvs-lean-verify');
    assert.ok(
      /Do NOT pick a default/.test(header),
      'instructs the runtime not to pick a default in execute mode',
    );
    assert.ok(
      /Do NOT write workflow artifacts/.test(header),
      'instructs the runtime not to write artifacts before the user answers',
    );
    assert.ok(
      !header.includes('pick a reasonable default'),
      'must not retain the old "pick a reasonable default" wording',
    );
  });

  it('maps Task() to spawn_agent', () => {
    const header = getCodexSkillAdapterHeader('fvs-fc-plan');
    assert.ok(header.includes('spawn_agent'), 'maps Task() to spawn_agent');
    assert.ok(header.includes('agent_type'), 'maps subagent_type to agent_type');
  });
});

describe('Codex markdown conversion (convertClaudeToCodexMarkdown)', () => {
  it('does not blanket-replace AskUserQuestion or Task( in skill bodies', () => {
    const body = 'Call AskUserQuestion then Task(subagent_type="x")';
    const converted = convertClaudeToCodexMarkdown(body);
    assert.ok(converted.includes('AskUserQuestion'), 'AskUserQuestion survives in the body');
    assert.ok(converted.includes('Task('), 'Task( survives in the body');
    assert.ok(!converted.includes('request_user_input'), 'no blanket request_user_input rewrite');
    assert.ok(!converted.includes('spawn_agent'), 'no blanket spawn_agent rewrite');
  });

  it('still rewrites $ARGUMENTS to the {{FVS_ARGS}} token', () => {
    const converted = convertClaudeToCodexMarkdown('uses $ARGUMENTS');
    assert.ok(converted.includes('{{FVS_ARGS}}'), '$ARGUMENTS becomes {{FVS_ARGS}}');
    assert.ok(!converted.includes('$ARGUMENTS'), 'no raw $ARGUMENTS remains');
  });

  it('still converts /fvs: slash mentions to skill mentions', () => {
    const converted = convertClaudeToCodexMarkdown('see /fvs:lean-verify for details');
    assert.ok(converted.includes('$fvs-lean-verify'), 'slash mention becomes skill mention');
  });
});

describe('TOML-aware config strip (stripFvsFromCodexConfig)', () => {
  it('strips FVS struct tables but retains foreign user and GSD tables', () => {
    const content = [
      '[model]',
      'name = "gpt-5"',
      '',
      '[agents.gsd-foo]',
      'description = "a gsd agent"',
      'config_file = "/home/user/.codex/agents/gsd-foo.toml"',
      '',
      FVS_CODEX_MARKER,
      '',
      '[agents.fvs-executor]',
      'description = "the fvs executor"',
      'config_file = "/home/user/.codex/agents/fvs-executor.toml"',
      '',
    ].join('\n');

    const cleaned = stripFvsFromCodexConfig(content);
    assert.ok(cleaned !== null, 'file is not empty after strip');
    assert.ok(!cleaned.includes('agents.fvs-executor'), 'FVS struct table removed');
    assert.ok(!cleaned.includes(FVS_CODEX_MARKER), 'FVS marker removed');
    assert.ok(cleaned.includes('[agents.gsd-foo]'), 'GSD table preserved');
    assert.ok(cleaned.includes('[model]'), 'user table preserved');
    assert.ok(cleaned.includes('name = "gpt-5"'), 'user table body preserved');
  });

  it('strips a legacy [[agents]] block whose name is fvs-*', () => {
    const content = [
      '[model]',
      'name = "gpt-5"',
      '',
      '[[agents]]',
      'name = "fvs-legacy"',
      'config_file = "/home/user/.codex/agents/fvs-legacy.toml"',
      '',
      '[[agents]]',
      'name = "user-custom"',
      'config_file = "/home/user/.codex/agents/user-custom.toml"',
      '',
    ].join('\n');

    const cleaned = stripFvsFromCodexConfig(content);
    assert.ok(cleaned !== null, 'file is not empty after strip');
    assert.ok(!cleaned.includes('fvs-legacy'), 'legacy fvs- array entry removed');
    assert.ok(cleaned.includes('name = "user-custom"'), 'foreign [[agents]] entry preserved');
    assert.ok(cleaned.includes('[model]'), 'user table preserved');
  });

  it('returns null when the file is FVS-only', () => {
    const content = [
      FVS_CODEX_MARKER,
      '',
      '[agents.fvs-executor]',
      'description = "x"',
      'config_file = "/home/user/.codex/agents/fvs-executor.toml"',
      '',
    ].join('\n');
    assert.equal(stripFvsFromCodexConfig(content), null);
  });
});
