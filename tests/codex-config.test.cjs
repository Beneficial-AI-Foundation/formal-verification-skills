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
  ensureCodexHooksFeature,
  rewriteLegacyCodexHookBlock,
  resolveCodexNodeRunner,
  FVS_CODEX_MARKER,
  CODEX_AGENT_SANDBOX,
  FVS_CODEX_AGENT_EFFORT,
} = require('../bin/install.js');

// Representative FVS agents and their expected sandbox/effort tiers, including
// the write-capable crypto executor (workspace-write so its file writes are not
// silently dropped on Codex; high effort as the dial-down implementation stage).
const AGENTS = [
  { name: 'fvs-executor', sandbox: 'workspace-write', effort: 'xhigh' },
  { name: 'fvs-lean-refactorer', sandbox: 'workspace-write', effort: 'xhigh' },
  { name: 'fvs-explainer', sandbox: 'read-only', effort: 'xhigh' },
  { name: 'fvs-researcher', sandbox: 'read-only', effort: 'high' },
  { name: 'fvs-crypto-executor', sandbox: 'workspace-write', effort: 'high' },
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

  it('strips the FVS-owned hooks feature gate so an FVS-only config returns null', () => {
    // Reproduces the real install shape: the feature flag sits under [features]
    // before the first FVS table. Stripping the marker and tables must also drop
    // the orphaned managed feature gate so the file is recognized as empty.
    const block = generateCodexConfigBlock(
      [{ name: 'fvs-executor', description: 'x' }, { name: 'fvs-researcher', description: 'y' }],
      '/home/user/.codex',
    );
    const installed = ensureCodexHooksFeature(block).content;
    assert.ok(/^\[features\]$/m.test(installed), 'precondition: [features] table was inserted');
    assert.ok(/^hooks = true$/m.test(installed), 'precondition: hooks feature flag was inserted');
    assert.ok(!installed.startsWith('hooks = true'), 'precondition: no root-level hooks flag');
    assert.equal(stripFvsFromCodexConfig(installed), null, 'FVS-only config must strip to null');
  });

  it('removes the orphaned managed feature flag while preserving foreign content', () => {
    const block = generateCodexConfigBlock(
      [{ name: 'fvs-executor', description: 'x' }],
      '/home/user/.codex',
    );
    const withFlag = ensureCodexHooksFeature(block).content;
    // A foreign [model] table sits below the FVS block.
    const content = `${withFlag}\n[model]\nname = "gpt-5"\n`;
    const cleaned = stripFvsFromCodexConfig(content);
    assert.ok(cleaned !== null, 'foreign content must survive');
    assert.ok(cleaned.includes('[model]'), 'foreign [model] table preserved');
    assert.ok(cleaned.includes('name = "gpt-5"'), 'foreign table body preserved');
    assert.ok(!/^\s*hooks\s*=\s*true\s*$/m.test(cleaned), 'orphaned hooks flag removed');
    assert.ok(!/^\s*codex_hooks\s*=\s*true\s*$/m.test(cleaned), 'orphaned legacy flag removed');
    assert.ok(!cleaned.includes('[features]'), 'empty FVS-created [features] table removed');
  });

  it('preserves a user-owned [features].hooks flag when no FVS marker is present', () => {
    // The flag is FVS-owned only when FVS inserted its ownership comment. A
    // [features] flag in a config FVS never touched belongs to the user.
    const content = ['[features]', 'hooks = true', '', '[model]', 'name = "gpt-5"', ''].join('\n');
    const cleaned = stripFvsFromCodexConfig(content);
    assert.ok(cleaned !== null, 'foreign-only config is not empty');
    assert.ok(/^\[features\]$/m.test(cleaned), 'user-owned [features] table preserved');
    assert.ok(/^hooks = true$/m.test(cleaned), 'user-owned flag preserved');
  });

  it('keeps CRLF line endings consistent after a strip', () => {
    const content = [
      '[model]',
      'name = "gpt-5"',
      '',
      FVS_CODEX_MARKER,
      '',
      '[agents.fvs-executor]',
      'description = "x"',
      'config_file = "/home/user/.codex/agents/fvs-executor.toml"',
      '',
    ].join('\r\n');
    const cleaned = stripFvsFromCodexConfig(content);
    assert.ok(cleaned !== null, 'foreign content survives');
    assert.ok(!/\n{3,}/.test(cleaned.replace(/\r/g, '')), 'no uncollapsed blank-line runs');
    assert.ok(!/[^\r]\n/.test(cleaned), 'no bare LF (mixed endings) in CRLF output');
    assert.ok(cleaned.endsWith('\r\n'), 'CRLF terminator');
  });
});

describe('Codex per-agent .toml triple-quote safety (generateCodexAgentToml)', () => {
  function agentWithBody(name, body) {
    return `---\nname: ${name}\ndescription: An agent\n---\n\n${body}\n`;
  }

  it('emits valid TOML when the body contains a literal triple-quote', () => {
    // A body containing ''' would terminate a TOML literal string early. The
    // emit must fall back to an escaped basic string so the result parses.
    const body = "Run a fenced block:\n'''lean\nexample : 1 = 1 := rfl\n'''\nmore text";
    const toml = generateCodexAgentToml('fvs-explainer', agentWithBody('fvs-explainer', body));

    // The literal delimiter must not be used, and the lone trailing ''' that
    // would corrupt the file must not appear as a delimiter.
    assert.ok(!toml.includes("developer_instructions = '''"), 'must not use a literal string for a body with ' + "'''");
    assert.ok(toml.includes('developer_instructions = """'), 'falls back to basic multiline string');

    // No unescaped """ inside the basic string would terminate it early. The
    // only """ delimiters are the opening and closing ones.
    const tripleDoubleCount = (toml.match(/"""/g) || []).length;
    assert.equal(tripleDoubleCount, 2, 'exactly one opening and one closing basic delimiter');

    // The triple-single-quotes from the body survive as content (escaped basic
    // strings have no quoting issue with single quotes).
    assert.ok(toml.includes("'''lean"), 'body triple-single-quotes retained as content');
  });

  it('rejects an unsafe agent name in the config block (fail closed)', () => {
    assert.throws(
      () => generateCodexConfigBlock([{ name: 'evil]\nmalicious = true', description: 'x' }], '/home/user/.codex'),
      /unsafe name/,
    );
  });

  it('builds config_file via JSON.stringify so paths are always quoted', () => {
    const block = generateCodexConfigBlock([{ name: 'fvs-executor', description: 'x' }], '/home/user/.codex');
    assert.ok(
      block.includes('config_file = "/home/user/.codex/agents/fvs-executor.toml"'),
      'config_file is a JSON-quoted absolute path',
    );
  });
});

describe('Codex hooks feature gate (ensureCodexHooksFeature)', () => {
  it('repairs the v2.0.1 root hooks boolean into [features].hooks', () => {
    const broken = [
      FVS_CODEX_MARKER,
      '',
      'hooks = true',
      '',
      '[agents.fvs-executor]',
      'description = "x"',
      'config_file = "/home/user/.codex/agents/fvs-executor.toml"',
      '',
    ].join('\n');

    const result = ensureCodexHooksFeature(broken).content;
    const featuresIndex = result.indexOf('[features]');
    const agentsIndex = result.indexOf('[agents.fvs-executor]');
    assert.ok(featuresIndex !== -1, 'creates [features]');
    assert.ok(featuresIndex < agentsIndex, 'features gate appears before FVS agent tables');
    assert.ok(/^hooks = true$/m.test(result), 'enables hooks under [features]');
    assert.ok(!/^hooks = true$/m.test(result.slice(0, featuresIndex)), 'does not leave a root-level hooks flag');
  });

  it('preserves valid root dotted features.hooks without adding a [features] table', () => {
    const result = ensureCodexHooksFeature('features.codex_hooks = true\n[model]\nname = "gpt-5"\n').content;
    assert.ok(/^features\.hooks = true$/m.test(result), 'legacy dotted key is normalized');
    assert.ok(!/^\[features\]$/m.test(result), 'does not add a duplicate [features] table');
    assert.ok(result.includes('[model]'), 'preserves following tables');
  });
});

describe('Legacy Codex hook rewrite (rewriteLegacyCodexHookBlock)', () => {
  it('rewrites a bare-node FVS hook command to the absolute-node form', () => {
    const runner = resolveCodexNodeRunner();
    assert.ok(runner, 'a node runner token is available in the test env');
    const configDir = '/home/user/.codex';
    const scriptPath = '/home/user/.codex/hooks/fvs-check-update.js';
    const content = [
      '[hooks]',
      `command = "node ${scriptPath}"`,
      '',
    ].join('\n');
    const { content: rewritten, changed } = rewriteLegacyCodexHookBlock(content, runner, configDir);
    assert.ok(changed, 'a legacy FVS command should be rewritten');
    const interpreter = JSON.parse(runner);
    assert.ok(rewritten.includes(interpreter), 'absolute node interpreter present');
    assert.ok(!/command\s*=\s*"node\s/.test(rewritten), 'no bare-node command remains');
  });

  it('does not rewrite a foreign command outside the config hooks dir', () => {
    const runner = resolveCodexNodeRunner();
    const configDir = '/home/user/.codex';
    // A path that ends in fvs-check-update.js but lives elsewhere must be left
    // alone — the directory-containment guard protects foreign content.
    const content = 'command = "node /opt/other/fvs-check-update.js"\n';
    const { changed } = rewriteLegacyCodexHookBlock(content, runner, configDir);
    assert.equal(changed, false, 'foreign command outside the config hooks dir is untouched');
  });
});
