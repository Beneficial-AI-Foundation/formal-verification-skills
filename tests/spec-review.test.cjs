'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'fvs-spec-review.mjs');
const REVIEW = '# FC Specification Review\n\n## Findings\nNone.\n' +
  '\n## Content coverage statement\nChecked arithmetic against the implementation.\n' +
  '\n## Coverage\nChecked source arithmetic.\n\n## Evidence\nlib.rs:1 and Funs.lean:1.\n\nVERDICT: PASS\n';

it('runs FC reviews with explicit choices, honest failures, and immutable input history', {
  skip: process.platform === 'win32',
}, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-spec-review-test-'));
  try {
    const project = path.join(tmp, 'project with spaces');
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(project);
    fs.mkdirSync(bin);
    const spec = 'Spec $(touch INJECTED).lean';
    const specText = 'theorem example_spec : True := by sorry\n';
    fs.writeFileSync(path.join(project, spec), specText);
    fs.writeFileSync(path.join(project, 'lib.rs'), 'fn example() -> u64 { 1 }\n');
    fs.writeFileSync(path.join(project, 'Funs.lean'), 'def example := 1\n');
    fs.writeFileSync(path.join(project, 'inventory.json'), JSON.stringify({ version: 1,
      declarations: [], cited_apis: [{ path: 'Funs.lean', start: 1, end: 1 }] }));
    const log = path.join(tmp, 'invocation.json');
    const fake = [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      "if (args[0] === '--version') { console.log('2.1.267'); process.exit(0); }",
      "const mode = process.env.FVS_REVIEW_TEST_MODE;",
      "if (['login', 'auth'].includes(args[0])) process.exit(mode === 'auth' ? 1 : 0);",
      "const input = fs.readFileSync(0, 'utf8');",
      'fs.writeFileSync(process.env.FVS_REVIEW_TEST_LOG, JSON.stringify({ args, input }));',
      "if (mode === 'fail') process.exit(9);",
      "if (mode === 'changed') fs.appendFileSync('lib.rs', '// changed');",
      `let review = mode === 'invalid' ? 'empty review' : ${JSON.stringify(REVIEW)};`,
      "if (mode === 'blank') review = 'VERDICT: PASS\\n## Findings\\nNone\\n## Coverage\\n\\n## Evidence\\nfile:1';",
      "if (mode === 'duplicate') review += '\\nVERDICT: REVISE';",
      "if (mode === 'revise') review = review.replace('VERDICT: PASS', 'VERDICT: REVISE');",
      "if (mode === 'edits') review = review.replace('VERDICT: PASS', 'VERDICT: APPROVE-WITH-EDITS');",
      "if (args[0] === 'exec') {",
      "  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], review);",
      '} else {',
      "  console.log(JSON.stringify({ result: review, is_error: mode === 'error', modelUsage: { 'claude-fable-test': {} } }));",
      '}',
    ].join('\n');
    for (const runtime of ['codex', 'claude']) {
      fs.writeFileSync(path.join(bin, runtime), fake);
      fs.chmodSync(path.join(bin, runtime), 0o755);
    }
    const invoke = (args, mode = '') => spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: project, encoding: 'utf8', env: { ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
        FVS_REVIEW_TEST_LOG: log, FVS_REVIEW_TEST_MODE: mode,
      },
    });
    const config = path.join(project, '.formalising', 'fvs-config.json');
    assert.equal(invoke(['automatic']).stdout.trim(), 'true');
    assert.ok(!fs.existsSync(path.dirname(config)), 'missing config must not create state');
    fs.mkdirSync(path.dirname(config));
    for (const [value, expected] of [[{}, 'true'], [{ spec_review: {} }, 'true'],
      [{ spec_review: { automatic: false } }, 'false'],
      [{ spec_review: { automatic: true } }, 'true']]) {
      fs.writeFileSync(config, JSON.stringify(value));
      assert.equal(invoke(['automatic']).stdout.trim(), expected);
    }
    fs.writeFileSync(config, '{"spec_review":{"automatic":"false"}}');
    assert.notEqual(invoke(['automatic']).status, 0);
    fs.writeFileSync(config, 'broken JSON');
    assert.notEqual(invoke(['automatic']).status, 0);
    fs.writeFileSync(config, '{"spec_review":{"automatic":false}}');

    const requestFile = path.join(tmp, 'request.json');
    const request = { spec, context: ['lib.rs', 'Funs.lean'], runtime: 'codex', author_runtime: 'claude', grounding: 'inventory.json' };
    const run = (changes = {}, mode) => {
      fs.writeFileSync(requestFile, JSON.stringify({ ...request, ...changes }));
      return invoke(['run', requestFile], mode);
    };
    const directory = result => path.join(project, result.stdout.match(/Review packet: (.+)/)[1]);
    const successful = run();
    assert.equal(successful.status, 0, successful.stderr);
    const first = directory(successful);
    const firstReview = fs.readFileSync(path.join(first, 'review.md'), 'utf8');
    assert.match(firstReview, /Provenance: cross-runtime/);
    assert.match(firstReview, /Requested effort: max/);
    assert.ok(firstReview.endsWith(REVIEW));
    let call = JSON.parse(fs.readFileSync(log));
    assert.equal(call.args[call.args.indexOf('--model') + 1], 'gpt-5.6-sol');
    assert.equal(call.args[call.args.indexOf('--sandbox') + 1], 'read-only');
    assert.ok(call.args.includes('--ephemeral') && call.args.includes('--ignore-user-config'));
    assert.ok(call.args.includes('model_reasoning_effort="max"'));
    assert.equal(call.args.at(-1), '-');
    assert.ok(call.input.includes('Source fidelity') && call.input.includes('fn example()'));
    assert.match(call.input, /grounding_data_untrusted/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(first, 'grounding.json'))).cited_apis[0].signature, 'def example := 1');
    assert.ok(!fs.existsSync(path.join(project, 'INJECTED')));

    const same = run({ author_runtime: 'codex', model: 'gpt-6-astra', effort: 'low' });
    assert.equal(same.status, 0, same.stderr);
    assert.notEqual(directory(same), first);
    assert.match(fs.readFileSync(path.join(directory(same), 'review.md'), 'utf8'), /same-runtime, fresh reviewer/);
    call = JSON.parse(fs.readFileSync(log));
    assert.ok(call.args.includes('gpt-6-astra') && call.args.includes('model_reasoning_effort="low"'));
    assert.equal(run({ model: 'custom-cheaper-model', effort: 'runtime-default' }).status, 0);
    call = JSON.parse(fs.readFileSync(log));
    assert.ok(call.args.includes('custom-cheaper-model'));
    assert.ok(!call.args.some(arg => arg.startsWith('model_reasoning_effort=')));

    const claude = run({ runtime: 'claude', author_runtime: 'codex' });
    assert.equal(claude.status, 0, claude.stderr);
    call = JSON.parse(fs.readFileSync(log));
    for (const flag of ['--safe-mode', '--strict-mcp-config', '--no-session-persistence']) {
      assert.ok(call.args.includes(flag));
    }
    assert.equal(call.args[call.args.indexOf('--tools') + 1], 'Read,Glob,Grep,Bash');
    assert.equal(call.args[call.args.indexOf('--model') + 1], 'fable');
    assert.equal(call.args[call.args.indexOf('--effort') + 1], 'max');
    assert.match(fs.readFileSync(path.join(directory(claude), 'review.md'), 'utf8'), /claude-fable-test/);

    for (const mode of ['fail', 'auth', 'invalid', 'blank', 'duplicate', 'changed']) {
      const result = run({}, mode);
      assert.notEqual(result.status, 0, mode);
      assert.ok(!fs.existsSync(path.join(directory(result), 'review.md')), mode);
      if (mode === 'invalid') {
        const attempt = fs.readdirSync(directory(result)).find(name => name.startsWith('attempt-'));
        assert.equal(fs.readFileSync(path.join(directory(result), attempt, 'response.md'), 'utf8'), 'empty review');
      }
    }
    const errored = run({ runtime: 'claude' }, 'error');
    assert.notEqual(errored.status, 0);
    assert.ok(!fs.existsSync(path.join(directory(errored), 'review.md')));
    const revised = run({}, 'revise');
    assert.equal(revised.status, 0, revised.stderr);
    assert.match(fs.readFileSync(path.join(directory(revised), 'review.md'), 'utf8'), /VERDICT: REVISE/);
    const edited = run({}, 'edits');
    assert.equal(edited.status, 0, edited.stderr);
    assert.match(fs.readFileSync(path.join(directory(edited), 'review.md'), 'utf8'),
      /VERDICT: APPROVE-WITH-EDITS/);
    const external = run({ runtime: 'other', model: 'my-provider/model', effort: '8192-token-budget' });
    assert.equal(external.status, 0, external.stderr);
    assert.match(external.stdout, /PENDING/);
    const response = path.join(tmp, 'response.md');
    fs.writeFileSync(response, REVIEW);
    assert.equal(invoke(['import', directory(external), response]).status, 0);
    assert.match(fs.readFileSync(path.join(directory(external), 'review.md'), 'utf8'), /externally supplied response/);
    assert.notEqual(invoke(['import', directory(external), response]).status, 0, 'must not overwrite');
    assert.notEqual(invoke(['import', first, response]).status, 0, 'must reject stale inputs');
    const staleGrounding = run({ runtime: 'other', model: 'external', effort: 'runtime-default' });
    fs.appendFileSync(path.join(project, 'inventory.json'), '\n');
    assert.notEqual(invoke(['import', directory(staleGrounding), response]).status, 0, 'must reject stale grounding inventory');
    fs.copyFileSync(path.join(directory(external), 'packet.json'), path.join(project, 'packet.json'));
    assert.notEqual(invoke(['import', project, response]).status, 0, 'must confine imported results');
    assert.ok(!fs.existsSync(path.join(project, 'review.md')));
    fs.writeFileSync(path.join(tmp, 'outside.lean'), 'outside');
    assert.notEqual(run({ spec: '../outside.lean' }).status, 0);
    fs.symlinkSync(path.join(tmp, 'outside.lean'), path.join(project, 'escape.lean'));
    assert.notEqual(run({ spec: 'escape.lean' }).status, 0);
    assert.equal(fs.readFileSync(path.join(project, spec), 'utf8'), specText);
    assert.equal(fs.readFileSync(path.join(first, 'review.md'), 'utf8'), firstReview);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
