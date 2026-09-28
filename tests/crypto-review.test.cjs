'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'fvs-codex-think.mjs');
const REVIEW = '# FVS Crypto Plan Review\n\n## Authority hierarchy\nPaper, then implementation.\n\n' +
  '## Findings\n\nNone.\n\n## Content coverage statement\nChecked source fidelity against cited definitions.\n\n' +
  '## Cleared surfaces\n\nChecked source fidelity and gates.\n\n' +
  '## Probe log\n\nRepository reads were sufficient.\n\n## Resolution map\n\n' +
  '| Finding | Suggested edit | Destination plan/section |\n|---|---|---|\n\nVERDICT: APPROVE\n';

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
    fs.writeFileSync(path.join(project, 'helper.lean'), 'theorem helper : True := by trivial\n');
    fs.writeFileSync(path.join(project, 'inventory.json'), JSON.stringify({ version: 1,
      declarations: [], cited_apis: [{ path: 'helper.lean', start: 1, end: 1 }] }));

    const fake = [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      "if (args[0] === '--version') { console.log('2.1.267'); process.exit(0); }",
      "const mode = process.env.FVS_REVIEW_TEST_MODE || '';",
      "if (['login', 'auth'].includes(args[0])) process.exit(mode === 'auth' ? 1 : 0);",
      "const input = fs.readFileSync(0, 'utf8');",
      'fs.writeFileSync(process.env.FVS_REVIEW_TEST_LOG, JSON.stringify({ runtime: process.argv[1], args, input, cwd: process.cwd() }));',
      "if (mode === 'fail') process.exit(9);",
      "if (mode === 'changed') fs.appendFileSync('.formalising/fv-plans/changed/plans/PLAN_n1.md', '\\nchanged');",
      `let review = mode === 'invalid' ? 'VERDICT: APPROVE' : ${JSON.stringify(REVIEW)};`,
      "if (mode === 'duplicate') review += '\\nVERDICT: REJECT';",
      "if (mode === 'styled') review = '```markdown\\n' + review.trim().replace('VERDICT: APPROVE', '**VERDICT:** APPROVE') + '\\n```';",
      "if (mode === 'wrapper') review = 'All evidence is gathered; writing the review.\\n\\n' + review;",
      "if (mode === 'root-exited') { const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:['ignore','inherit','inherit']}); fs.writeFileSync(process.env.FVS_FAKE_PID_FILE, String(child.pid)); }",
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
    const invoke = (args, mode = '', env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: project,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
        FVS_REVIEW_TEST_LOG: log,
        FVS_REVIEW_TEST_MODE: mode,
        ...env,
      },
    });
    const piEnv = { PI_CODING_AGENT: 'true', AI_AGENT: 'pi' };
    const nonPiEnv = { PI_CODING_AGENT: '', AI_AGENT: '' };
    const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
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

    const run = (name, reviewer, authorMarkers, extra = [], mode = '', env = {}) => {
      const topic = makeTopic(name, authorMarkers);
      const before = fs.readFileSync(path.join(topic, 'plans', 'PLAN_n1.md'), 'utf8');
      const selected = reviewer === 'claude'
        ? ['--model', 'catalog-claude-model', '--effort', 'high']
        : reviewer === 'pi'
          ? ['--model', 'openai/catalog-pi-authority', '--effort', 'max']
          : reviewer === 'other'
            ? ['--model', 'external-catalog-model', '--effort', 'low']
            : ['--model', 'catalog-codex-model', '--effort', 'max'];
      const result = invoke(['review', '--topic', `.formalising/fv-plans/${name}`,
        '--iteration', 'n1', '--target', 'plan', '--reviewer', reviewer,
        ...selected, ...extra], mode, env);
      assert.equal(fs.readFileSync(path.join(topic, 'plans', 'PLAN_n1.md'), 'utf8'), before);
      return { topic, result, before };
    };

    makeTopic('missing-selection', ['Claude Code', 'Claude Code']);
    const missingSelection = invoke(['review', '--topic', '.formalising/fv-plans/missing-selection',
      '--iteration', 'n1', '--target', 'plan', '--reviewer', 'codex']);
    assert.notEqual(missingSelection.status, 0, 'review model/effort must be explicit');

    const codex = run('codex-cross', 'codex', ['Claude Code', 'Claude Code'],
      ['--model', 'catalog-codex-authority', '--effort', 'max', '--grounding', 'inventory.json']);
    assert.equal(codex.result.status, 0, codex.result.stderr);
    let record = fs.readFileSync(path.join(codex.topic, 'reviews', 'PLAN_REVIEW_n1.md'), 'utf8');
    assert.match(record, /Provenance: cross-runtime/);
    assert.match(record, /Requested reviewer: codex/);
    assert.match(record, /Requested model: catalog-codex-authority/);
    let call = JSON.parse(fs.readFileSync(log));
    assert.equal(call.args[call.args.indexOf('--sandbox') + 1], 'workspace-write');
    assert.ok(call.args.includes('--ignore-user-config') && call.args.includes('--ephemeral'));
    assert.ok(call.args.includes('catalog-codex-authority') &&
      call.args.includes('model_reasoning_effort="max"'));
    const codexScratch = call.args[call.args.indexOf('-C') + 1];
    assert.equal(call.cwd, codexScratch);
    assert.ok(codexScratch.includes(`${path.sep}attempt-`) && codexScratch.endsWith(`${path.sep}scratch`));
    assert.ok(fs.statSync(codexScratch).isDirectory(), 'Codex scratch must survive with the review attempt');
    assert.ok(call.input.includes('Source fidelity') && call.input.includes('PLAN_n1.md'));
    assert.ok(call.input.includes('theorem helper : True := by trivial'));

    const claude = run('claude-cross', 'claude', ['Codex CLI', 'Codex CLI'],
      ['--model', 'catalog-claude-scout', '--effort', 'high']);
    assert.equal(claude.result.status, 0, claude.result.stderr);
    record = fs.readFileSync(path.join(claude.topic, 'reviews', 'PLAN_REVIEW_n1.md'), 'utf8');
    assert.match(record, /Provenance: cross-runtime/);
    assert.match(record, /Runtime-reported models: claude-observed/);
    call = JSON.parse(fs.readFileSync(log));
    for (const flag of ['--safe-mode', '--strict-mcp-config', '--no-session-persistence']) {
      assert.ok(call.args.includes(flag));
    }
    assert.equal(call.args[call.args.indexOf('--tools') + 1], 'Read,Glob,Grep,Bash');

    makeTopic('pi-outside-host', ['Claude Code', 'Claude Code']);
    const piOutsideHost = invoke(['review', '--topic', '.formalising/fv-plans/pi-outside-host',
      '--iteration', 'n1', '--target', 'plan', '--reviewer', 'pi', '--model',
      'openai/catalog-pi-authority', '--effort', 'max'], '', nonPiEnv);
    assert.notEqual(piOutsideHost.status, 0, 'Pi reviewer must require an active Pi host');
    makeTopic('pi-bare-model', ['Claude Code', 'Claude Code']);
    const piBareModel = invoke(['review', '--topic', '.formalising/fv-plans/pi-bare-model',
      '--iteration', 'n1', '--target', 'plan', '--reviewer', 'pi', '--model',
      'catalog-pi-authority', '--effort', 'max'], '', piEnv);
    assert.notEqual(piBareModel.status, 0, 'Pi reviewer model must be provider-qualified');

    const pi = run('pi-cross', 'pi', ['Claude Code', 'Claude Code'], [], '', piEnv);
    assert.equal(pi.result.status, 0, pi.result.stderr);
    assert.match(pi.result.stdout, /PI_READY/);
    const piPacket = path.join(project, pi.result.stdout.match(/Review packet: (.+)/)[1]);
    const piResponse = path.join(project, 'pi-response.md');
    const piReceipt = path.join(project, 'pi-receipt.json');
    fs.writeFileSync(piResponse, REVIEW);
    const piImportArgs = ['review-import-pi', '--topic', '.formalising/fv-plans/pi-cross',
      '--packet', path.relative(project, piPacket), '--response', 'pi-response.md',
      '--dispatch-receipt', 'pi-receipt.json'];
    assert.notEqual(invoke(['review-import', '--topic', '.formalising/fv-plans/pi-cross',
      '--packet', path.relative(project, piPacket), '--response', 'pi-response.md']).status, 0,
    'Other importer must reject Pi packets');
    assert.notEqual(invoke(piImportArgs.slice(0, -2), '', piEnv).status, 0,
      'Pi import must require dispatch evidence');
    const receipt = {
      version: 1,
      run_id: 'pi-child-test-run',
      status: 'complete',
      fresh_context: true,
      read_only: true,
      model: 'openai/catalog-pi-authority',
      effort: 'low',
      packet_sha256: sha256(path.join(piPacket, 'packet.json')),
      response_sha256: sha256(piResponse),
    };
    fs.writeFileSync(piReceipt, JSON.stringify(receipt));
    assert.notEqual(invoke(piImportArgs, '', piEnv).status, 0,
      'Pi import must reject a child effort mismatch');
    receipt.effort = 'max';
    fs.writeFileSync(piReceipt, JSON.stringify(receipt));
    assert.notEqual(invoke(piImportArgs, '', nonPiEnv).status, 0,
      'Pi import must require an active Pi host');
    const piImported = invoke(piImportArgs, '', piEnv);
    assert.equal(piImported.status, 0, piImported.stderr);
    record = fs.readFileSync(path.join(pi.topic, 'reviews', 'PLAN_REVIEW_n1.md'), 'utf8');
    assert.match(record, /Requested reviewer: pi/);
    assert.match(record, /Requested model: openai\/catalog-pi-authority/);
    assert.match(record, /Provenance: cross-runtime/);
    assert.match(record, /Runtime-reported models: openai\/catalog-pi-authority/);
    assert.match(record, /Runtime-reported effort: max/);
    assert.match(record, /Pi dispatch evidence: run pi-child-test-run/);

    const same = run('same-runtime', 'codex', ['Codex CLI', 'Codex CLI'],
      ['--effort', 'medium']);
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

    const provenanceTamper = run('provenance-tamper', 'other', ['Claude Code', 'Claude Code']);
    const provenancePacket = path.join(project,
      provenanceTamper.result.stdout.match(/Review packet: (.+)/)[1]);
    const provenanceJson = path.join(provenancePacket, 'packet.json');
    const altered = JSON.parse(fs.readFileSync(provenanceJson, 'utf8'));
    altered.request.author_runtime = 'codex';
    altered.request.observed_author_runtime = 'Codex CLI';
    altered.provenance = 'unverified (record the external reviewer/author identities in triage)';
    fs.writeFileSync(provenanceJson, JSON.stringify(altered));
    const rejectedProvenance = invoke(['review-import', '--topic',
      '.formalising/fv-plans/provenance-tamper', '--packet', path.relative(project, provenancePacket),
      '--response', 'external-response.md']);
    assert.notEqual(rejectedProvenance.status, 0, 'must reject tampered author metadata');
    assert.ok(!fs.existsSync(path.join(provenanceTamper.topic, 'reviews', 'PLAN_REVIEW_n1.md')));
    altered.request.author_runtime = 'claude';
    altered.request.observed_author_runtime = 'Claude Code';
    altered.provenance = 'cross-runtime';
    fs.writeFileSync(provenanceJson, JSON.stringify(altered));
    const rejectedLabel = invoke(['review-import', '--topic',
      '.formalising/fv-plans/provenance-tamper', '--packet', path.relative(project, provenancePacket),
      '--response', 'external-response.md']);
    assert.notEqual(rejectedLabel.status, 0, 'must reject tampered provenance');
    assert.ok(!fs.existsSync(path.join(provenanceTamper.topic, 'reviews', 'PLAN_REVIEW_n1.md')));

    const styled = run('styled-output', 'codex', ['Claude Code', 'Claude Code'], [], 'styled');
    assert.equal(styled.result.status, 0, styled.result.stderr);
    const styledPacket = path.join(project, styled.result.stdout.match(/Review packet: (.+)/)[1]);
    const validation = fs.readdirSync(styledPacket).find(name => name.startsWith('validation-'));
    const validationDir = path.join(styledPacket, validation);
    assert.match(fs.readFileSync(path.join(validationDir, 'raw-response.md'), 'utf8'), /^```markdown/);
    assert.equal(fs.readFileSync(path.join(validationDir, 'normalized-response.md'), 'utf8'), REVIEW.trimEnd());
    assert.match(fs.readFileSync(path.join(validationDir, 'README.md'), 'utf8'), /raw-response\.md.*unchanged/s);

    const wrapped = run('wrapped-output', 'codex', ['Claude Code', 'Claude Code'], [], 'wrapper');
    assert.equal(wrapped.result.status, 0, wrapped.result.stderr);
    assert.match(fs.readFileSync(path.join(wrapped.topic, 'reviews', 'PLAN_REVIEW_n1.md'), 'utf8'), /VERDICT: APPROVE/);
    const descendant = run('orphan-stdout', 'codex', ['Claude Code', 'Claude Code'], [], 'root-exited',
      { FVS_REVIEW_TIMEOUT_MS: '1100', FVS_REVIEW_AUTH_TIMEOUT_MS: '2500',
        FVS_FAKE_PID_FILE: path.join(tmp, 'orphan.pid') });
    assert.notEqual(descendant.result.status, 0);
    assert.throws(() => process.kill(Number(fs.readFileSync(path.join(tmp, 'orphan.pid'), 'utf8')), 0), /ESRCH/);
    assert.match(descendant.result.stderr, /deadline.*Review attempt preserved/s);
    assert.ok(!fs.existsSync(path.join(descendant.topic, 'reviews', 'PLAN_REVIEW_n1.md')));
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
    const grounded = run('grounded-import', 'other', ['Claude Code', 'Claude Code'],
      ['--model', 'external', '--grounding', 'inventory.json']);
    const groundedDir = path.join(project, grounded.result.stdout.match(/Review packet: (.+)/)[1]);
    fs.appendFileSync(path.join(project, 'helper.lean'), '-- changed upstream\n');
    assert.notEqual(invoke(['review-import', '--topic', '.formalising/fv-plans/grounded-import',
      '--packet', path.relative(project, groundedDir), '--response', 'external-response.md']).status, 0);
    assert.ok(!fs.existsSync(path.join(grounded.topic, 'reviews/PLAN_REVIEW_n1.md')));
    const tampered = JSON.parse(fs.readFileSync(path.join(groundedDir, 'packet.json')));
    tampered.output = '../escaped.md';
    fs.writeFileSync(path.join(groundedDir, 'packet.json'), JSON.stringify(tampered));
    fs.writeFileSync(response, 'invalid external response');
    assert.notEqual(invoke(['review-import', '--topic', '.formalising/fv-plans/grounded-import',
      '--packet', path.relative(project, groundedDir), '--response', 'external-response.md']).status, 0);
    assert.ok(!fs.existsSync(path.join(tmp, 'escaped.md')));
    assert.ok(fs.readdirSync(groundedDir).some(name => name.startsWith('validation-')));
    assert.notEqual(invoke(['review-import', '--topic', '.formalising/fv-plans/external',
      '--packet', path.relative(project, packetDir), '--response', '../response.md']).status, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
