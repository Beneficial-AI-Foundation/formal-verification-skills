'use strict';
// Mandatory genuine bound-auto qualification when explicitly selected. Default
// npm tests do not execute Lean or publish fixture acceptance events.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const SCRIPT = path.resolve(__dirname, '../scripts/fvs-auto.mjs');
const PRELOAD = path.resolve(__dirname, 'fixtures/checker-publication.cjs');
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save = (file, value) => { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); return { file, sha256: hash(file) }; };
const read = (ref) => { assert.equal(hash(ref.file), ref.sha256); return JSON.parse(fs.readFileSync(ref.file)); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('genuine paired auto lifecycle (FVS_REAL_AUTO=1)', { skip: process.env.FVS_REAL_AUTO !== '1', concurrency: 1 }, () => {
  let context, frozen, invalidatable, api, root, provisional, helper, sum, operations = [];
  before(async () => {
    assert.ok(process.env.FVS_REAL_AUTO_CONTEXT, 'an immutable controller qualification context is required');
    context = JSON.parse(fs.readFileSync(process.env.FVS_REAL_AUTO_CONTEXT));
    assert.equal(context.schema, 'fvs-checker/qualification-context'); assert.equal(context.version, 1); assert.equal(context.scope, 'qualification-only');
    frozen = read(context.baseline); assert.equal(frozen.schema, 'fvs-checker/auto-baseline');
    invalidatable = read(context.invalidatableBaseline); assert.equal(invalidatable.schema, 'fvs-checker/auto-baseline');
    assert.notEqual(invalidatable.registry.root, frozen.registry.root, 'semantic invalidation has its own real frozen registry context');
    assert.equal(frozen.checker[SCRIPT], hash(SCRIPT), 'the qualification must use this exact checker export');
    assert.equal(invalidatable.checker[SCRIPT], hash(SCRIPT));
    assert.deepEqual(frozen.targets.map((t) => t.node).sort((a, b) => a - b), [19, 20, 21]);
    assert.equal(frozen.extractionSourceCommit, '2359861154ccd5180021702637cad43e6f562ec6');
    assert.equal(context.source.commit, 'c1dca808811357a10839287cf12a5316a130c95d');
    assert.equal(context.source.expectedTree, frozen.fixtureSource.tree);
    assert.equal(context.nonCurrentSource.commit, context.source.commit); assert.equal(context.nonCurrentSource.expectedTree, context.source.expectedTree);
    assert.notEqual(context.nonCurrentSource.root, context.source.root);
    root = context.evidenceRoot; fs.mkdirSync(root); fs.mkdirSync(path.join(root, 'home')); fs.mkdirSync(path.join(root, 'tmp'));
    assert.equal(path.dirname(context.storeRoot), root, 'the accepted store belongs to this exclusive qualification root');
    api = await import(pathToFileURL(path.resolve(__dirname, '../scripts/fvs-checker-auto.mjs')).href);
    assert.equal(api.readAcceptedStore(context.storeRoot).headSha256, null);
  });
  after(() => {
    if (!root || !fs.existsSync(root)) return;
    save(path.join(root, 'qualification.json'), { scope: 'qualification-only', checker: { file: SCRIPT, sha256: hash(SCRIPT) },
      test: { file: __filename, sha256: hash(__filename) }, publicationFixture: { file: PRELOAD, sha256: hash(PRELOAD) },
      context: { file: process.env.FVS_REAL_AUTO_CONTEXT, sha256: hash(process.env.FVS_REAL_AUTO_CONTEXT) }, baseline: context.baseline, operations });
    process.stdout.write('Retained real-auto qualification: ' + root + '\n');
  });
  function start(command, fields, label, hook = null) {
    const id = label + '-' + crypto.randomUUID(), out = path.join(root, id), request = path.join(root, id + '.request.json');
    const job = { schema: 'fvs-checker/' + command + '-request', version: 1, purpose: 'auto', runId: id,
      deadlineMs: Date.now() + 600000, baseline: context.baseline, ...fields };
    save(request, job);
    const argv = [...(hook ? ['--require', PRELOAD] : []), SCRIPT, command, '--request', request, '--out', out];
    const env = { PATH: path.dirname(process.execPath) + ':/usr/bin:/bin', HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'tmp'), LANG: 'C',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', ...(hook ?? {}) };
    const stdoutFile = path.join(root, id + '.stdout'), stderrFile = path.join(root, id + '.stderr');
    const stdout = fs.openSync(stdoutFile, 'wx'), stderr = fs.openSync(stderrFile, 'wx');
    const child = spawn(process.execPath, argv, { env, stdio: ['ignore', stdout, stderr] });
    const handle = { out, id, finished: false };
    const timer = setTimeout(() => child.kill('SIGKILL'), 630000);
    handle.done = new Promise((resolve) => child.on('close', (exit, signal) => {
      clearTimeout(timer); fs.fsyncSync(stdout); fs.fsyncSync(stderr); fs.closeSync(stdout); fs.closeSync(stderr);
      const text = fs.readFileSync(stdoutFile, 'utf8'); let result = null;
      try { const envelope = JSON.parse(text); result = envelope.evidence ? { ...read(envelope.evidence), ...envelope } : envelope; } catch {}
      const receipt = { argv: [process.execPath, ...argv], env, request: { file: request, sha256: hash(request) }, out, exit, signal,
        stdout: { file: stdoutFile, sha256: hash(stdoutFile) }, stderr: { file: stderrFile, sha256: hash(stderrFile) } };
      operations.push(save(path.join(root, id + '.attempt.json'), receipt));
      Object.assign(handle, { exit, signal, result, finished: true }); resolve(handle);
    }));
    return handle;
  }
  const invoke = (...args) => start(...args).done;
  const store = () => api.readAcceptedStore(context.storeRoot);
  const acceptance = (node, expectedHeadSha256 = store().headSha256) => ({ node, candidateCheck: provisional.evidence,
    source: context.source, store: { root: context.storeRoot, expectedHeadSha256 } });
  function refused(run, exit, message) { assert.equal(run.exit, exit, JSON.stringify(run.result)); assert.equal(run.result.status, 'unverified'); if (message) assert.match(run.result.message, message); }

  it('checks the genuine immutable candidate provisionally without releasing a consumer', async () => {
    const run = await invoke('check', { source: context.source, nodes: [19, 20, 21] }, 'provisional');
    assert.equal(run.exit, 0, JSON.stringify(run.result)); provisional = run.result;
    assert.equal(provisional.status, 'provisional'); assert.equal(provisional.authority, 'provisional-only');
    assert.equal(provisional.acceptedReceipt, undefined); assert.equal(store().headSha256, null);
    assert.deepEqual([...provisional.audit.targets].sort(), frozen.targets.map((t) => t.name).sort());
    assert.equal(provisional.extractionSourceCommit, frozen.extractionSourceCommit);
  });
  it('refuses a root before its real helper receipt, and refuses worker PASS evidence', async () => {
    let run = await invoke('accept', acceptance(20), 'missing-helper'); refused(run, 7, /helper 19/); assert.equal(store().headSha256, null);
    const worker = save(path.join(root, 'worker-pass.json'), { schema: 'worker-report', status: 'PASS', axioms: [] });
    run = await invoke('accept', { ...acceptance(19), candidateCheck: worker }, 'worker-pass'); refused(run, 5); assert.equal(store().headSha256, null);
    const foreign = JSON.parse(JSON.stringify(provisional)); foreign.runId = 'unbound-unused-run';
    const packet = save(path.join(root, 'foreign-run.json'), foreign);
    run = await invoke('accept', { ...acceptance(19), candidateCheck: packet }, 'foreign-run'); refused(run, 7, /request|foreign|incomplete/);
    assert.equal(store().headSha256, null);
  });
  it('a pending semantic registry releases nothing', async () => {
    const lock = path.join(frozen.registry.root, 'lock'); fs.mkdirSync(lock);
    try { const run = await invoke('check', { source: context.source, nodes: [20] }, 'pending-registry'); refused(run, 7, /registry/); }
    finally { fs.rmdirSync(lock); }
    assert.equal(store().headSha256, null);
  });
  it('serially accepts the helper only after its fresh integrated check', async () => {
    const run = await invoke('accept', acceptance(19), 'helper'); assert.equal(run.exit, 0, JSON.stringify(run.result)); helper = run.result.acceptedReceipt;
    const event = read(helper); assert.equal(event.node, 19); assert.deepEqual(event.dependencies, []); assert.equal(store().records.length, 1);
    assert.notEqual(event.integratedCheck.sha256, provisional.evidence.sha256); assert.equal(event.integrated.commit, context.source.commit);
  });
  it('refuses stale store heads, altered integrated trees, and expired requests without publication', async () => {
    const before = store().headSha256;
    let run = await invoke('accept', acceptance(20, '0'.repeat(64)), 'stale-store'); refused(run, 7, /expected head/);
    run = await invoke('accept', { ...acceptance(20), source: { ...context.source, expectedTree: '0'.repeat(40) } }, 'wrong-tree'); refused(run, 4, /tree identity mismatch/);
    run = await invoke('accept', { ...acceptance(20), source: context.nonCurrentSource }, 'non-current-integration'); refused(run, 7, /not the current target HEAD/);
    run = await invoke('check', { source: context.source, nodes: [20], deadlineMs: 1 }, 'expired'); refused(run, 8);
    assert.equal(store().headSha256, before); assert.equal(store().records.length, 1);
  });
  it('accepts the first root with the exact helper dependency and rechecked proof closure', async () => {
    const run = await invoke('accept', acceptance(20), 'root-sum'); assert.equal(run.exit, 0, JSON.stringify(run.result)); sum = run.result.acceptedReceipt;
    const event = read(sum); assert.deepEqual(event.dependencies, [{ node: 19, sha256: helper.sha256 }]); assert.equal(event.helperIdentityChecks.length, 1);
    assert.equal(store().records.length, 2);
  });
  it('commits at most one simultaneous root publication from the same expected head', async () => {
    const gate = path.join(root, 'concurrency'); fs.mkdirSync(gate);
    const fields = acceptance(21), extra = (token) => ({ FVS_TEST_PUBLICATION: 'barrier', FVS_TEST_STORE: context.storeRoot,
      FVS_TEST_GATE: gate, FVS_TEST_TOKEN: token, FVS_TEST_GATE_DEADLINE: String(Date.now() + 610000) });
    const left = start('accept', fields, 'concurrent-left', extra('left')), right = start('accept', fields, 'concurrent-right', extra('right'));
    const deadline = Date.now() + 615000;
    try {
      while (!['left', 'right'].every((t) => fs.existsSync(path.join(gate, t + '.ready')))) {
        assert.ok(Date.now() < deadline, 'publication barrier deadline');
        assert.ok(!left.finished && !right.finished, 'both real integrated checks must reach the publication barrier');
        await sleep(50);
      }
      assert.ok(fs.existsSync(path.join(left.out, 'integrated/result.json'))); assert.ok(fs.existsSync(path.join(right.out, 'integrated/result.json')));
    } finally { fs.writeFileSync(path.join(gate, 'release'), 'release\n', { flag: 'wx' }); }
    const results = await Promise.all([left.done, right.done]); assert.deepEqual(results.map((r) => r.exit).sort((a, b) => a - b), [0, 7]);
    assert.equal(store().records.length, 3); assert.equal(store().heads.get(21).record.dependencies[0].sha256, helper.sha256);
  });
  it('rejects a changed accepted policy and mismatched dependency receipt (fixture copies)', () => {
    const records = store().records;
    function copyCase(label, rows) {
      const target = path.join(root, label); fs.mkdirSync(target); fs.mkdirSync(path.join(target, 'records'));
      for (const record of rows) { const bytes = Buffer.from(JSON.stringify(record, null, 2) + '\n'), digest = crypto.createHash('sha256').update(bytes).digest('hex');
        fs.writeFileSync(path.join(target, 'records', String(record.seq).padStart(6, '0') + '-' + digest + '.json'), bytes, { flag: 'wx' }); }
      return target;
    }
    const policy = JSON.parse(JSON.stringify(records[0].record)); policy.policy.axioms.push('Fixture.forged');
    assert.throws(() => api.readAcceptedStore(copyCase('wrong-policy', [policy])), /policy bindings/);
    const dependency = JSON.parse(JSON.stringify(records[1].record)); dependency.dependencies[0].sha256 = '0'.repeat(64);
    assert.throws(() => api.readAcceptedStore(copyCase('wrong-dependency', [records[0].record, dependency])), /current predecessor/);
  });
  it('a real helper semantic revision invalidates the separate frozen context', async () => {
    const original = read(invalidatable.input), head = api.readAcceptedStore(context.storeRoot).headSha256;
    const proposed = JSON.parse(JSON.stringify(invalidatable.records[19].contract)); proposed.statement = 'True'; proposed.author.runId = 'qualification-proposed-semantic-revision';
    const contract = save(path.join(root, 'proposed-helper.json'), proposed);
    const registryScript = path.resolve(__dirname, '../scripts/fvs-contract-registry.mjs');
    const argv = [registryScript, 'revise', '--plan', original.extraction.plan.file, '--graph', original.extraction.graph.file, '--registry', invalidatable.registry.root,
      '--spec-root', context.source.root, '--contract', contract.file, '--previous', invalidatable.records[19].sha256];
    const revision = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 30000 });
    fs.writeFileSync(path.join(root, 'semantic-revision.stdout'), revision.stdout ?? '', { flag: 'wx' }); fs.writeFileSync(path.join(root, 'semantic-revision.stderr'), revision.stderr ?? '', { flag: 'wx' });
    operations.push(save(path.join(root, 'semantic-revision.attempt.json'), { argv: [process.execPath, ...argv], exit: revision.status, signal: revision.signal,
      stdoutSha256: hash(path.join(root, 'semantic-revision.stdout')), stderrSha256: hash(path.join(root, 'semantic-revision.stderr')) }));
    assert.equal(revision.status, 0, revision.stdout + revision.stderr); assert.equal(JSON.parse(revision.stdout).record.state, 'needs-semantic-review');
    const run = await invoke('check', { baseline: context.invalidatableBaseline, source: context.source, nodes: [20] }, 'stale-semantic-context');
    refused(run, 7, /registry/); assert.equal(store().headSha256, head);
  });
  it('a crash after integrated checking releases no new accepted event', async () => {
    const before = store().headSha256, gate = path.join(root, 'crash'); fs.mkdirSync(gate);
    const run = await invoke('accept', acceptance(20), 'crash-before-publication', { FVS_TEST_PUBLICATION: 'crash', FVS_TEST_STORE: context.storeRoot,
      FVS_TEST_GATE: gate, FVS_TEST_TOKEN: 'crash' });
    assert.equal(run.exit, 86); assert.ok(fs.existsSync(path.join(run.out, 'integrated/result.json'))); assert.equal(store().headSha256, before);
    assert.equal(store().records.length, 3);
  });
  it('an interrupted rename leaves pending markers and no fourth accepted record', async () => {
    const run = await invoke('accept', acceptance(20), 'interrupted-rename', { FVS_TEST_PUBLICATION: 'rename-failure', FVS_TEST_STORE: context.storeRoot });
    assert.notEqual(run.exit, 0); assert.equal(run.result.status, 'unverified');
    assert.equal(fs.readdirSync(path.join(context.storeRoot, 'records')).length, 3);
    assert.ok(fs.existsSync(path.join(context.storeRoot, 'lock'))); assert.ok(fs.existsSync(path.join(frozen.registry.root, 'lock')));
    assert.throws(() => store(), /pending/);
  });
});
