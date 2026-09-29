'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
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
    const calls = path.join(tmp, 'calls.jsonl');
    const fake = [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      "fs.appendFileSync(process.env.FVS_REVIEW_TEST_CALLS, JSON.stringify(args) + '\\n');",
      "if (args[0] === '--version') { console.log('2.1.267'); process.exit(0); }",
      "const mode = process.env.FVS_REVIEW_TEST_MODE;",
      "if (['login', 'auth'].includes(args[0])) process.exit(mode === 'auth' ? 1 : 0);",
      "const input = fs.readFileSync(0, 'utf8');",
      'fs.writeFileSync(process.env.FVS_REVIEW_TEST_LOG, JSON.stringify({ args, input, cwd: process.cwd() }));',
      "if (mode === 'fail') process.exit(9);",
      "if (mode === 'changed') fs.appendFileSync(process.env.FVS_REVIEW_PROJECT_SOURCE, '// changed');",
      `let review = mode === 'invalid' ? 'empty review' : ${JSON.stringify(REVIEW)};`,
      "if (mode === 'blank') review = 'VERDICT: PASS\\n## Findings\\nNone\\n## Coverage\\n\\n## Evidence\\nfile:1';",
      "if (mode === 'duplicate') review += '\\nVERDICT: REVISE';",
      "if (mode === 'revise') review = review.replace('VERDICT: PASS', 'VERDICT: REVISE');",
      "if (mode === 'edits') review = review.replace('VERDICT: PASS', 'VERDICT: APPROVE-WITH-EDITS');",
      "if (args[0] === 'exec') {",
      "  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], review);",
      '} else {',
      "  console.log(JSON.stringify({ result: review, is_error: mode === 'error', modelUsage: { 'claude-reported-test-model': {} } }));",
      '}',
    ].join('\n');
    for (const runtime of ['codex', 'claude']) {
      fs.writeFileSync(path.join(bin, runtime), fake);
      fs.chmodSync(path.join(bin, runtime), 0o755);
    }
    const invoke = (args, mode = '', env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: project, encoding: 'utf8', env: { ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
        FVS_REVIEW_TEST_LOG: log, FVS_REVIEW_TEST_CALLS: calls, FVS_REVIEW_TEST_MODE: mode,
        FVS_REVIEW_PROJECT_SOURCE: path.join(project, 'lib.rs'),
        ...env,
      },
    });
    const piEnv = { PI_CODING_AGENT: 'true', AI_AGENT: 'pi' };
    const nonPiEnv = { PI_CODING_AGENT: '', AI_AGENT: '' };
    const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
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
    const request = { spec, context: ['lib.rs', 'Funs.lean'], runtime: 'codex',
      model: 'catalog-codex-model', effort: 'max', author_runtime: 'claude',
      grounding: 'inventory.json' };
    const run = (changes = {}, mode, env = {}) => {
      fs.writeFileSync(requestFile, JSON.stringify({ ...request, ...changes }));
      return invoke(['run', requestFile], mode, env);
    };
    const directory = result => path.join(project, result.stdout.match(/Review packet: (.+)/)[1]);

    // Budget preflight uses the run request's sources and never creates review state.
    fs.writeFileSync(path.join(project, 'Api.lean'),
      Array.from({ length: 10 }, (_, i) => `-- line ${i + 1}`).join('\n') + '\n');
    const budgetInventory = (file, count, cited = []) => fs.writeFileSync(path.join(project, file),
      JSON.stringify({ version: 1, cited_apis: cited, declarations: Array.from({ length: count }, (_, i) => ({
        name: `D${i}`, signature: 'True',
        analogs: [{ path: 'Api.lean', start: 1, end: 10, handling: 'REUSE-AS-IS' }],
        search: { queries: ['Api.lean'], roots: ['.'], conclusion: 'fixture' } })) }));
    budgetInventory('budget-ok.json', 20);
    budgetInventory('budget-over.json', 20, [{ path: 'Api.lean', start: 1, end: 10 },
      { path: 'Funs.lean', start: 1, end: 1 }]);
    const tree = () => fs.readdirSync(project, { recursive: true }).sort().map(name => {
      const file = path.join(project, name);
      return fs.statSync(file).isFile() ? `${name}:${sha256(file)}` : name;
    });
    const preflight = (changes = {}, env = {}) => {
      fs.writeFileSync(requestFile, JSON.stringify({ ...request, ...changes }));
      return invoke(['preflight', requestFile], '', env);
    };
    const reviewsRoot = path.join(project, '.formalising', 'spec-reviews');
    const treeBefore = tree();
    const accepted = preflight({ grounding: 'budget-ok.json', context: ['lib.rs', 'Funs.lean', 'lib.rs'] });
    assert.equal(accepted.status, 0, accepted.stderr);
    const acceptedBudget = accepted.stdout.match(/Grounding budget: (.+)/)[1];
    assert.match(acceptedBudget, /^charged 200\/200 signature lines \(analogs 200, cited_apis 0\); 1 distinct span \(10 lines\)/);
    const overflow = preflight({ grounding: 'budget-over.json', runtime: 'pi',
      model: 'openai/catalog-pi-authority' }, nonPiEnv);
    assert.notEqual(overflow.status, 0);
    assert.match(overflow.stderr, /charged 211\/200 .*analogs 200, cited_apis 11.*2 distinct spans \(11 lines\).*first overflow at cited_apis\[0\] Api\.lean:1-10 \(cumulative 210\)/);
    assert.notEqual(preflight({ grounding: 'budget-ok.json', spec: '../outside.lean' }).status, 0);
    assert.notEqual(preflight({ grounding: 'budget-ok.json', model: undefined }).status, 0);
    assert.deepEqual(tree(), treeBefore, 'preflight must not change the project');
    assert.ok(!fs.existsSync(reviewsRoot));
    assert.ok(!fs.existsSync(calls) && !fs.existsSync(log), 'preflight must not invoke a provider or auth probe');
    const rejectedBuild = run({ grounding: 'budget-over.json', runtime: 'other', model: 'external', effort: 'low' });
    assert.notEqual(rejectedBuild.status, 0);
    assert.equal(rejectedBuild.stderr, overflow.stderr, 'build and preflight must report the same budget outcome');
    assert.ok(!fs.existsSync(reviewsRoot), 'over-budget run must not create spec-reviews/');
    fs.writeFileSync(path.join(project, 'Api.lean'), '-- edited after preflight\n' +
      Array.from({ length: 9 }, (_, i) => `-- line ${i + 2}`).join('\n') + '\n');
    const acceptedBuild = run({ grounding: 'budget-ok.json', context: ['lib.rs', 'Funs.lean', 'lib.rs'],
      runtime: 'other', model: 'external', effort: 'low' });
    assert.equal(acceptedBuild.status, 0, acceptedBuild.stderr);
    assert.equal(acceptedBuild.stdout.match(/Grounding budget: (.+)/)[1], acceptedBudget);
    const builtGrounding = JSON.parse(fs.readFileSync(path.join(directory(acceptedBuild), 'grounding.json'), 'utf8'));
    assert.match(builtGrounding.declarations[0].analogs[0].signature, /^-- edited after preflight/,
      'run must re-read current source rather than reuse the preflight');
    assert.deepEqual(builtGrounding.source_index.map(input => input.path), [spec, 'lib.rs', 'Funs.lean']);
    assert.notEqual(run({ model: undefined }).status, 0, 'review model must be explicit');
    assert.notEqual(run({ effort: undefined }).status, 0, 'review effort must be explicit');
    const successful = run();
    assert.equal(successful.status, 0, successful.stderr);
    const first = directory(successful);
    const firstReview = fs.readFileSync(path.join(first, 'review.md'), 'utf8');
    assert.match(firstReview, /Provenance: cross-runtime/);
    assert.match(firstReview, /Requested effort: max/);
    assert.ok(firstReview.endsWith(REVIEW));
    let call = JSON.parse(fs.readFileSync(log));
    assert.equal(call.args[call.args.indexOf('--model') + 1], 'catalog-codex-model');
    assert.equal(call.args[call.args.indexOf('--sandbox') + 1], 'workspace-write');
    assert.equal(call.args[call.args.indexOf('-C') + 1], call.cwd);
    assert.ok(call.cwd.endsWith(`${path.sep}scratch`));
    assert.ok(call.args.includes('--ephemeral') && call.args.includes('--ignore-user-config'));
    assert.ok(call.args.includes('model_reasoning_effort="max"'));
    assert.equal(call.args.at(-1), '-');
    assert.ok(call.input.includes('Source fidelity') && call.input.includes('fn example()'));
    assert.match(call.input, /grounding_data_untrusted/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(first, 'grounding.json'))).cited_apis[0].signature, 'def example := 1');
    assert.ok(!fs.existsSync(path.join(project, 'INJECTED')));

    const same = run({ author_runtime: 'codex', model: 'catalog-codex-authority', effort: 'medium' });
    assert.equal(same.status, 0, same.stderr);
    assert.notEqual(directory(same), first);
    assert.match(fs.readFileSync(path.join(directory(same), 'review.md'), 'utf8'), /same-runtime, fresh reviewer/);
    call = JSON.parse(fs.readFileSync(log));
    assert.ok(call.args.includes('catalog-codex-authority') &&
      call.args.includes('model_reasoning_effort="medium"'));
    assert.equal(run({ model: 'custom-catalog-model', effort: 'provider-native-effort' }).status, 0);
    call = JSON.parse(fs.readFileSync(log));
    assert.ok(call.args.includes('custom-catalog-model'));
    assert.ok(call.args.includes('model_reasoning_effort="provider-native-effort"'));
    assert.notEqual(run({ effort: 'runtime-default' }).status, 0);

    const claude = run({ runtime: 'claude', model: 'catalog-claude-model', effort: 'high',
      author_runtime: 'codex' });
    assert.equal(claude.status, 0, claude.stderr);
    call = JSON.parse(fs.readFileSync(log));
    for (const flag of ['--safe-mode', '--strict-mcp-config', '--no-session-persistence']) {
      assert.ok(call.args.includes(flag));
    }
    assert.equal(call.args[call.args.indexOf('--tools') + 1], 'Read,Glob,Grep,Bash');
    assert.equal(call.args[call.args.indexOf('--model') + 1], 'catalog-claude-model');
    assert.equal(call.args[call.args.indexOf('--effort') + 1], 'high');
    assert.match(fs.readFileSync(path.join(directory(claude), 'review.md'), 'utf8'),
      /claude-reported-test-model/);

    const piOutsideHost = run({ runtime: 'pi', model: 'openai/catalog-pi-authority', effort: 'max',
      author_runtime: 'claude' }, 'pi-outside', nonPiEnv);
    assert.notEqual(piOutsideHost.status, 0, 'Pi reviewer must require an active Pi host');
    const piBareModel = run({ runtime: 'pi', model: 'catalog-pi-authority', effort: 'max',
      author_runtime: 'claude' }, 'pi-bare', piEnv);
    assert.notEqual(piBareModel.status, 0, 'Pi reviewer model must be provider-qualified');

    const pi = run({ runtime: 'pi', model: 'openai/catalog-pi-authority', effort: 'max',
      author_runtime: 'claude' }, 'pi-valid', piEnv);
    assert.equal(pi.status, 0, pi.stderr);
    assert.match(pi.stdout, /PI_READY/);
    const piDirectory = directory(pi);
    const piResponse = path.join(tmp, 'pi-response.md');
    const piReceipt = path.join(tmp, 'pi-receipt.json');
    fs.writeFileSync(piResponse, REVIEW);
    assert.notEqual(invoke(['import', piDirectory, piResponse]).status, 0,
      'Other importer must reject Pi packets');
    assert.notEqual(invoke(['import-pi', piDirectory, piResponse], '', piEnv).status, 0,
      'Pi import must require dispatch evidence');
    const receipt = {
      version: 1,
      run_id: 'pi-child-test-run',
      status: 'complete',
      fresh_context: true,
      read_only: true,
      model: 'openai/catalog-pi-authority',
      effort: 'low',
      packet_sha256: sha256(path.join(piDirectory, 'packet.json')),
      response_sha256: sha256(piResponse),
    };
    receipt.run_id = '   ';
    receipt.effort = 'max';
    fs.writeFileSync(piReceipt, JSON.stringify(receipt));
    assert.notEqual(invoke(['import-pi', piDirectory, piResponse, piReceipt], '', piEnv).status, 0,
      'Pi import must reject a blank child run ID');
    receipt.run_id = 'pi-child-test-run';
    receipt.effort = 'low';
    fs.writeFileSync(piReceipt, JSON.stringify(receipt));
    assert.notEqual(invoke(['import-pi', piDirectory, piResponse, piReceipt], '', piEnv).status, 0,
      'Pi import must reject a child effort mismatch');
    receipt.effort = 'max';
    fs.writeFileSync(piReceipt, JSON.stringify(receipt));
    fs.appendFileSync(piResponse, '\ntampered after child completion\n');
    assert.notEqual(invoke(['import-pi', piDirectory, piResponse, piReceipt], '', piEnv).status, 0,
      'Pi import must reject a response changed after child completion');
    fs.writeFileSync(piResponse, REVIEW);
    assert.notEqual(invoke(['import-pi', piDirectory, piResponse, piReceipt], '', nonPiEnv).status, 0,
      'Pi import must require an active Pi host');
    assert.equal(invoke(['import-pi', piDirectory, piResponse, piReceipt], '', piEnv).status, 0);
    const piRecord = fs.readFileSync(path.join(piDirectory, 'review.md'), 'utf8');
    assert.match(piRecord, /Requested reviewer: pi/);
    assert.match(piRecord, /Requested model: openai\/catalog-pi-authority/);
    assert.match(piRecord, /Provenance: cross-runtime/);
    assert.match(piRecord, /Runtime-reported models: openai\/catalog-pi-authority/);
    assert.match(piRecord, /Runtime-reported effort: max/);
    assert.match(piRecord, /Pi dispatch evidence: run pi-child-test-run/);

    for (const mode of ['fail', 'auth', 'invalid', 'blank', 'duplicate', 'changed', 'revise', 'edits']) {
      const result = run({}, mode);
      assert.notEqual(result.status, 0, mode);
      assert.ok(!fs.existsSync(path.join(directory(result), 'review.md')), mode);
      if (mode === 'invalid') {
        const attempt = fs.readdirSync(directory(result)).find(name => name.startsWith('attempt-'));
        assert.equal(fs.readFileSync(path.join(directory(result), attempt, 'response.md'), 'utf8'), 'empty review');
      }
    }
    const errored = run({ runtime: 'claude', model: 'catalog-claude-model', effort: 'high' }, 'error');
    assert.notEqual(errored.status, 0);
    assert.ok(!fs.existsSync(path.join(directory(errored), 'review.md')));
    const external = run({ runtime: 'other', model: 'my-provider/model', effort: '8192-token-budget' });
    assert.equal(external.status, 0, external.stderr);
    assert.match(external.stdout, /PENDING/);
    const response = path.join(tmp, 'response.md');
    fs.writeFileSync(response, REVIEW);
    assert.equal(invoke(['import', directory(external), response]).status, 0);
    assert.match(fs.readFileSync(path.join(directory(external), 'review.md'), 'utf8'), /externally supplied response/);
    assert.notEqual(invoke(['import', directory(external), response]).status, 0, 'must not overwrite');
    const neutral = run({ runtime: 'other', model: 'my-provider/model', effort: 'low' });
    fs.writeFileSync(response, 'Review complete.\n' + REVIEW);
    assert.equal(invoke(['import', directory(neutral), response]).status, 0);
    assert.ok(fs.readFileSync(path.join(directory(neutral), 'review.md'), 'utf8').endsWith(REVIEW));
    const validation = path.join(directory(neutral), fs.readdirSync(directory(neutral))
      .find(name => name.startsWith('validation-')));
    const transform = JSON.parse(fs.readFileSync(path.join(validation, 'transformation.json')));
    assert.equal(transform.replay_matches, true);
    assert.equal(transform.hashes['raw-response.md'], sha256(path.join(validation, 'raw-response.md')));
    assert.equal(transform.hashes['normalized-response.md'], sha256(path.join(validation, 'normalized-response.md')));
    fs.writeFileSync(response, Buffer.from([0xff, 0xfe]));
    const undecodable = run({ runtime: 'other', model: 'my-provider/model', effort: 'low' });
    assert.notEqual(invoke(['import', directory(undecodable), response]).status, 0);
    assert.ok(!fs.existsSync(path.join(directory(undecodable), 'review.md')));
    fs.writeFileSync(response, REVIEW);
    assert.notEqual(invoke(['import', first, response]).status, 0, 'must reject stale inputs');
    for (const field of ['model', 'effort']) {
      const tampered = run({ runtime: 'other', model: 'external-catalog-model', effort: 'low' });
      const tamperedDir = directory(tampered);
      const packetPath = path.join(tamperedDir, 'packet.json');
      const packet = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
      delete packet.request[field];
      fs.writeFileSync(packetPath, JSON.stringify(packet));
      assert.notEqual(invoke(['import', tamperedDir, response]).status, 0,
        `import must reject missing request.${field}`);
      assert.ok(!fs.existsSync(path.join(tamperedDir, 'review.md')),
        `tampered request.${field} must not produce a review`);
    }
    const staleGrounding = run({ runtime: 'other', model: 'external', effort: 'low' });
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
