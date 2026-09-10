'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'fvs-codex-think.mjs');
const REVIEW = '# FVS Crypto Plan Review\n\n- VERDICT: APPROVE\n\n' +
  '## Findings\n\nNone.\n\n## Cleared surfaces\n\nChecked source fidelity and gates.\n\n' +
  '## Probe log\n\nRepository reads were sufficient.\n\n## Resolution map\n\n' +
  '| Finding | Suggested edit | Destination plan/section |\n|---|---|---|\n';

it('runs crypto review through selected read-only runtimes and immutable packets', {
  skip: process.platform === 'win32',
}, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-crypto-review-test-'));
  try {
    const project = path.join(tmp, 'project with spaces');
    const bin = path.join(tmp, 'bin');
    const topicRoot = path.join(project, '.formalising', 'fv-plans');
    const log = path.join(tmp, 'invocation.json');
    fs.mkdirSync(topicRoot, { recursive: true });
    fs.mkdirSync(bin);

    const fake = [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      "if (args[0] === '--version') { console.log('2.1.267'); process.exit(0); }",
      "const mode = process.env.FVS_REVIEW_TEST_MODE || '';",
      "if (['login', 'auth'].includes(args[0])) process.exit(mode === 'auth' ? 1 : 0);",
      "const input = fs.readFileSync(0, 'utf8');",
      'fs.writeFileSync(process.env.FVS_REVIEW_TEST_LOG, JSON.stringify({ runtime: process.argv[1], args, input }));',
      "if (mode === 'fail') process.exit(9);",
      "if (mode === 'changed') fs.appendFileSync('.formalising/fv-plans/changed/plans/PLAN_n1.md', '\\nchanged');",
      `let review = mode === 'invalid' ? 'VERDICT: APPROVE' : ${JSON.stringify(REVIEW)};`,
      "if (mode === 'duplicate') review += '\\nVERDICT: REJECT';",
      "if (args[0] === 'exec') fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], review);",
      "else console.log(JSON.stringify({ result: review, is_error: mode === 'error', modelUsage: { 'claude-observed': {} } }));",
    ].join('\n');
    for (const runtime of ['codex', 'claude']) {
      fs.writeFileSync(path.join(bin, runtime), fake);
      fs.chmodSync(path.join(bin, runtime), 0o755);
    }

    const makeTopic = (name, markers = ['Claude Code', 'Claude Code']) => {
      const topic = path.join(topicRoot, name);
      fs.mkdirSync(path.join(topic, 'plans'), { recursive: true });
      fs.mkdirSync(path.join(topic, 'reviews'), { recursive: true });
      for (const [file, marker] of [['PLAN_n1.md', markers[0]], ['EXEC_PLAN_n1.md', markers[1]]]) {
        fs.writeFileSync(path.join(topic, 'plans', file),
          `# ${file}\n\n${marker === null ? '' : `Authoring runtime: ${marker}\n`}`);
      }
      fs.writeFileSync(path.join(topic, 'plans', 'FOLLOWUP_PLAN_n1.md'),
        '# Follow-up\n\nAuthoring runtime: Codex CLI\n');
      return topic;
    };
    const invoke = (args, mode = '') => spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: project,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
        FVS_REVIEW_TEST_LOG: log,
        FVS_REVIEW_TEST_MODE: mode,
      },
    });
    const config = path.join(project, '.formalising', 'fvs-config.json');
    assert.equal(invoke(['review-automatic']).stdout.trim(), 'true');
    assert.ok(!fs.existsSync(config), 'default lookup must not create config');
    for (const [value, expected] of [[{}, 'true'], [{ crypto_review: {} }, 'true'],
      [{ crypto_review: { automatic: false } }, 'false'],
      [{ crypto_review: { automatic: true } }, 'true']]) {
      fs.writeFileSync(config, JSON.stringify(value));
      assert.equal(invoke(['review-automatic']).stdout.trim(), expected);
    }
    fs.writeFileSync(config, '{"crypto_review":{"automatic":"false"}}');
    assert.notEqual(invoke(['review-automatic']).status, 0);
    fs.writeFileSync(config, 'broken JSON');
    assert.notEqual(invoke(['review-automatic']).status, 0);
    fs.writeFileSync(config, '{"crypto_review":{"automatic":false}}');

    const run = (name, reviewer, authorMarkers, extra = [], mode = '') => {
      const topic = makeTopic(name, authorMarkers);
      const before = fs.readFileSync(path.join(topic, 'plans', 'PLAN_n1.md'), 'utf8');
      const result = invoke(['review', '--topic', `.formalising/fv-plans/${name}`,
        '--iteration', 'n1', '--target', 'plan', '--reviewer', reviewer, ...extra], mode);
      assert.equal(fs.readFileSync(path.join(topic, 'plans', 'PLAN_n1.md'), 'utf8'),
        mode === 'changed' ? `${before}\nchanged` : before);
      return { topic, result, before };
    };

    const codex = run('codex-cross', 'codex', ['Claude Code', 'Claude Code'],
      ['--model', 'gpt-6-astra', '--effort', 'max']);
    assert.equal(codex.result.status, 0, codex.result.stderr);
    let record = fs.readFileSync(path.join(codex.topic, 'reviews', 'PLAN_REVIEW_n1.md'), 'utf8');
    assert.match(record, /Provenance: cross-runtime/);
    assert.match(record, /Requested reviewer: codex/);
    assert.match(record, /Requested model: gpt-6-astra/);
    let call = JSON.parse(fs.readFileSync(log));
    assert.equal(call.args[call.args.indexOf('--sandbox') + 1], 'read-only');
    assert.ok(call.args.includes('--ignore-user-config') && call.args.includes('--ephemeral'));
    assert.ok(call.args.includes('gpt-6-astra') && call.args.includes('model_reasoning_effort="max"'));
    assert.ok(call.input.includes('Source fidelity') && call.input.includes('PLAN_n1.md'));

    const claude = run('claude-cross', 'claude', ['Codex CLI', 'Codex CLI'],
      ['--model', 'sonnet', '--effort', 'high']);
    assert.equal(claude.result.status, 0, claude.result.stderr);
    record = fs.readFileSync(path.join(claude.topic, 'reviews', 'PLAN_REVIEW_n1.md'), 'utf8');
    assert.match(record, /Provenance: cross-runtime/);
    assert.match(record, /Runtime-reported models: claude-observed/);
    call = JSON.parse(fs.readFileSync(log));
    for (const flag of ['--safe-mode', '--strict-mcp-config', '--no-session-persistence']) {
      assert.ok(call.args.includes(flag));
    }
    assert.equal(call.args[call.args.indexOf('--tools') + 1], 'Read,Glob,Grep,Bash');

    const same = run('same-runtime', 'codex', ['Codex CLI', 'Codex CLI'],
      ['--effort', 'low']);
    assert.equal(same.result.status, 0, same.result.stderr);
    assert.match(fs.readFileSync(path.join(same.topic, 'reviews', 'PLAN_REVIEW_n1.md'), 'utf8'),
      /same-runtime, fresh reviewer/);
    for (const [name, markers] of [
      ['unknown-author', [null, null]],
      ['foreign-author', ['Local Model', 'Local Model']],
      ['conflicting-author', ['Claude Code', 'Codex CLI']],
    ]) {
      const unverified = run(name, 'codex', markers);
      assert.equal(unverified.result.status, 0, unverified.result.stderr);
      assert.match(fs.readFileSync(path.join(unverified.topic, 'reviews', 'PLAN_REVIEW_n1.md'), 'utf8'),
        /Provenance: unverified/);
    }

    const external = run('external', 'other', ['Claude Code', 'Claude Code'],
      ['--model', 'reviewer/model', '--effort', '8192-token-budget']);
    assert.equal(external.result.status, 0, external.result.stderr);
    assert.match(external.result.stdout, /PENDING/);
    const packetMatch = external.result.stdout.match(/Review packet: (.+)/);
    assert.ok(packetMatch, external.result.stdout);
    const packetDir = path.join(project, packetMatch[1]);
    assert.ok(fs.readFileSync(path.join(packetDir, 'prompt.md'), 'utf8').includes('PLAN_n1.md'));
    const response = path.join(project, 'external-response.md');
    fs.writeFileSync(response, REVIEW);
    const imported = invoke(['review-import', '--topic', '.formalising/fv-plans/external',
      '--packet', path.relative(project, packetDir), '--response', 'external-response.md']);
    assert.equal(imported.status, 0, imported.stderr);
    assert.match(fs.readFileSync(path.join(external.topic, 'reviews', 'PLAN_REVIEW_n1.md'), 'utf8'),
      /externally supplied response/);
    assert.notEqual(invoke(['review-import', '--topic', '.formalising/fv-plans/external',
      '--packet', path.relative(project, packetDir), '--response', 'external-response.md']).status, 0,
    'must not overwrite a final review');

    for (const [name, mode] of [['auth-failure', 'auth'], ['process-failure', 'fail'],
      ['invalid-output', 'invalid'], ['duplicate-verdict', 'duplicate'], ['changed', 'changed']]) {
      const failed = run(name, 'codex', ['Claude Code', 'Claude Code'], [], mode);
      assert.notEqual(failed.result.status, 0, name);
      assert.ok(!fs.existsSync(path.join(failed.topic, 'reviews', 'PLAN_REVIEW_n1.md')), name);
    }
    const stalePacket = run('stale-import', 'other', ['Claude Code', 'Claude Code'],
      ['--model', 'reviewer/model', '--effort', 'custom']);
    const staleDir = path.join(project, stalePacket.result.stdout.match(/Review packet: (.+)/)[1]);
    fs.appendFileSync(path.join(stalePacket.topic, 'plans', 'PLAN_n1.md'), '\nchanged');
    assert.notEqual(invoke(['review-import', '--topic', '.formalising/fv-plans/stale-import',
      '--packet', path.relative(project, staleDir), '--response', 'external-response.md']).status, 0);
    assert.notEqual(invoke(['review-import', '--topic', '.formalising/fv-plans/external',
      '--packet', path.relative(project, packetDir), '--response', '../response.md']).status, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
