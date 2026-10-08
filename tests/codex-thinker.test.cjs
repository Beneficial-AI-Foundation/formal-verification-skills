'use strict';

// Executes the real wrapper against a simulated private CLI, never a model provider.
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/fvs-codex-think.mjs');
const ROLE = path.join(ROOT, 'agents/fvs-crypto-thinker.md');
const digest = text => createHash('sha256').update(text).digest('hex');

it('returns full-role Codex authoring to parent-owned plans with unknown observations', () => {
  const tmp = fs.mkdtempSync(path.join(process.env.FVS_TEST_EVIDENCE_ROOT || os.tmpdir(), 'thinker-simulation-'));
  const project = path.join(tmp, 'project');
  const topic = path.join(project, '.formalising/fv-plans/topic');
  const bin = path.join(tmp, 'bin');
  for (const dir of [topic, bin, path.join(tmp, 'home')]) fs.mkdirSync(dir, { recursive: true });
  const log = path.join(tmp, 'launch.json');
  const body = fs.readFileSync(ROLE, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  fs.writeFileSync(path.join(bin, 'codex'), [
    '#!/usr/bin/env node',
    "const fs = require('node:fs'); const args = process.argv.slice(2);",
    "if (args[0] === '--version') { console.log('codex-cli 0.160.0'); process.exit(0); }",
    "if (args[0] === 'login') process.exit(0);",
    "const prompt = fs.readFileSync(0, 'utf8');",
    'fs.writeFileSync(process.env.FVS_THINKER_LOG, JSON.stringify({args,prompt,cwd:process.cwd()}));',
    "const stage = prompt.split('>')[1].split('<')[0];",
    "const mode = process.env.FVS_THINKER_MODE;",
    "if (mode === 'fail') process.exit(9);",
    "if (mode === 'signal') process.kill(process.pid, 'SIGTERM');",
    "if (mode === 'timeout') { setInterval(() => {}, 1000); return; }",
    "if (mode === 'missing') process.exit(0);",
    "let response = stage === 'eval' ? '## EVAL COMPLETE\\n**Stage:** eval\\n**Decision:** BLOCKED\\n**Statement challenge:** Missing build evidence.' : '## PLAN COMPLETE\\n**Stage:** ' + stage + '\\n**Bounded:** yes\\n## Reuse audit\\nExisting declarations inspected.';",
    "if (mode === 'incomplete') response = 'partial plan';",
    "const file = args[args.indexOf('--output-last-message') + 1];",
    "fs.writeFileSync(file, mode === 'utf8' ? Buffer.from([0xff]) : response);",
    "console.log('progress is not the final response');",
  ].join('\n'));
  fs.chmodSync(path.join(bin, 'codex'), 0o755);
  const context = path.join(topic, 'context.json');
  const run = (stage, mode = '', roleFile = ROLE, model = 'exact-model') => {
    fs.writeFileSync(context, JSON.stringify({ stage, topic: 'topic', branch_state: 'main, clean',
      kb_sources: 'paper excerpt', prior: 'no previous iteration', proof_engineering_context: 'none',
      plan: 'approved plan', executed: 'build missing', eval_findings: 'FOLLOWUP', human_ruling: 'not required' }));
    return spawnSync(process.execPath, [SCRIPT, stage, '--topic', topic, '--model', model,
      '--effort', 'low', '--role-file', roleFile, '--context-file', context], {
      cwd: project, encoding: 'utf8', env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
        HOME: path.join(tmp, 'home'), CODEX_HOME: path.join(tmp, 'home'), FVS_THINKER_LOG: log,
        FVS_THINKER_MODE: mode, FVS_THINKER_TIMEOUT_MS: mode === 'timeout' ? '150' : '5000' },
    });
  };
  const result = run('plan');
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.stage, 'crypto_plan');
  assert.equal(envelope.status, 'complete');
  assert.match(envelope.response, /## PLAN COMPLETE/);
  assert.equal(envelope.role.sha256, digest(body));
  assert.equal(envelope.settings.resolved.model, 'exact-model');
  assert.equal(envelope.settings.resolved.effort, 'low');
  assert.equal(envelope.settings.observed.model.value, 'unknown');
  assert.equal(envelope.settings.observed.effort.value, 'unknown');
  assert.ok(!fs.existsSync(path.join(topic, 'plans')), 'child must not persist the named plans');
  fs.mkdirSync(path.join(topic, 'plans'));
  for (const file of ['PLAN_n1.md', 'EXEC_PLAN_n1.md']) {
    fs.writeFileSync(path.join(topic, 'plans', file), 'Authoring runtime: Codex CLI\n' +
      'Stage settings: ' + JSON.stringify(envelope.settings) + '\n' + envelope.response);
    assert.match(fs.readFileSync(path.join(topic, 'plans', file), 'utf8'), /"value":"unknown"/);
  }
  const launch = JSON.parse(fs.readFileSync(log));
  assert.equal(launch.args[launch.args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(launch.args.includes('--ignore-user-config') && launch.args.includes('--ephemeral'));
  assert.ok(launch.args.includes('model_reasoning_effort="low"'));
  assert.ok(launch.args.includes('developer_instructions=' + JSON.stringify(body)));
  assert.match(launch.prompt, /<thinker_mode>plan<\/thinker_mode>/);
  assert.match(launch.prompt, /paper excerpt/);
  for (const stage of ['eval', 'followup']) {
    const r = run(stage); assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).stage, `crypto_${stage}`);
  }
  for (const mode of ['fail', 'signal', 'timeout', 'missing', 'utf8', 'incomplete']) {
    const r = run('plan', mode); assert.notEqual(r.status, 0, mode); assert.equal(r.stdout, '');
  }
  const { generateCodexAgentToml } = require('../bin/install.js');
  const toml = path.join(tmp, 'role.toml');
  fs.writeFileSync(toml, generateCodexAgentToml('fvs-crypto-thinker', fs.readFileSync(ROLE, 'utf8')));
  assert.equal(JSON.parse(run('plan', '', toml).stdout).role.sha256, digest(body));
  // Exercise the generator's basic multiline representation without changing instructions.
  fs.writeFileSync(toml, 'name = "fvs-crypto-thinker"\nsandbox_mode = "read-only"\ndeveloper_instructions = """\n' +
    body.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"') + '\n"""\n');
  assert.equal(JSON.parse(run('plan', '', toml).stdout).role.sha256, digest(body));
  fs.writeFileSync(toml, 'name = "fvs-crypto-thinker"\ndeveloper_instructions = """\nshort checklist\n"""\n');
  fs.unlinkSync(log);
  assert.notEqual(run('plan', '', toml).status, 0);
  assert.ok(!fs.existsSync(log), 'incomplete role must fail before launch');
  assert.equal(run('plan', '', ROLE, 'inherit').status, 0);
  assert.ok(!JSON.parse(fs.readFileSync(log)).args.includes('-m'));
  // Retained test setup/logs live only in an explicitly selected proof root when requested.
  if (!process.env.FVS_TEST_EVIDENCE_ROOT) fs.rmSync(tmp, { recursive: true, force: true });
});
