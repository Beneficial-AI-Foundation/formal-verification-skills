// Explicit offline qualification. AO is a labelled protocol double; Beads,
// Git and the separately supplied fresh accepted checker history are genuine.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const f = require('./helpers/resume-fixture.cjs');
const save = (root, name, value) => { const file = path.join(root, name + '.json'); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); return f.ref(file); };

test('genuine installed-Beads primary/linked wired resumes (AO protocol fixture)', { skip: process.env.FVS_RESUME_REAL !== '1' }, async () => {
  const auto = await import(pathToFileURL(path.join(f.ROOT, 'scripts/fvs-auto.mjs')).href);
  const out = path.resolve(process.env.FVS_RESUME_REAL_OUT); fs.mkdirSync(out); // Retained/exclusive.
  const bd = fs.realpathSync(process.env.FVS_RESUME_BD), bdSha = f.sha(fs.readFileSync(bd)), cases = [];
  assert.equal(bdSha, '842879338715dc25b5a9f48864ae55846e9792195876e2803d6b51d3ec524a92', 'qualified installed Beads1.3.1 profile');
  const x = f.fixture(auto, out, bd); let sequence = 0;
  const command = (args) => {
    const startedAtMs = Date.now(), p = spawnSync(bd, args, { cwd: x.root, env: process.env, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    const n = String(++sequence).padStart(3, '0');
    const stream = (suffix, bytes) => { const file = path.join(out, n + suffix); fs.writeFileSync(file, bytes ?? Buffer.alloc(0), { flag: 'wx' }); return f.ref(file); };
    save(out, n + '-command', { argv: [bd, ...args], cwd: x.root, toolSha256: bdSha, startedAtMs, endedAtMs: Date.now(), exitCode: p.status, signal: p.signal,
      error: p.error?.code ?? null, stdout: stream('.stdout', p.stdout), stderr: stream('.stderr', p.stderr) });
    assert.equal(p.status, 0, String(p.stderr)); assert.equal(p.error, undefined); assert.equal(f.sha(fs.readFileSync(bd)), bdSha);
    return JSON.parse(p.stdout.toString('utf8'));
  };
  // Native fixture setup is expressly separate from product registration/prime.
  const init = spawnSync(bd, ['--sandbox', 'init', '--backend', 'dolt', '--skip-agents', '--skip-hooks', '--non-interactive', '--prefix', 'resume-fixture'], { cwd: x.root, env: process.env, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  fs.writeFileSync(path.join(out, 'init.stdout'), init.stdout ?? Buffer.alloc(0)); fs.writeFileSync(path.join(out, 'init.stderr'), init.stderr ?? Buffer.alloc(0));
  save(out, 'init-command', { argv: [bd, '--sandbox', 'init', '--backend', 'dolt', '--skip-agents', '--skip-hooks', '--non-interactive', '--prefix', 'resume-fixture'], cwd: x.root,
    exitCode: init.status, signal: init.signal, error: init.error?.code ?? null, toolSha256: bdSha, stdout: f.ref(path.join(out, 'init.stdout')), stderr: f.ref(path.join(out, 'init.stderr')) });
  assert.equal(init.status, 0, String(init.stderr));
  // Native1.3.1 creates this setup file. Commit its known bytes BEFORE selecting
  // the initial integration snapshot; a dirty-source partial is correct behavior.
  const setupStatus = f.git(x.root, 'status', '--porcelain=v1', '--untracked-files=all');
  assert.equal(setupStatus, '?? .gitignore', 'only the known native fixture setup file is pending');
  const setupFile = f.ref(path.join(x.root, '.gitignore')), setupParent = f.git(x.root, 'rev-parse', 'HEAD');
  f.git(x.root, 'add', '--', '.gitignore'); f.git(x.root, 'commit', '-qm', 'fixture: record native backend setup');
  assert.equal(f.git(x.root, 'status', '--porcelain=v1', '--untracked-files=all'), '');
  cases.push({ name: 'native-setup-source-snapshot', setupFile, setupParent, commit: f.git(x.root, 'rev-parse', 'HEAD'), tree: f.git(x.root, 'rev-parse', 'HEAD^{tree}') });
  const where = command(['-C', x.root, '--sandbox', '--readonly', 'where', '--json']);
  const registration = auto.recordMemory({ projectRoot: x.root, registration: { backend: 'beads', canonicalRoot: x.root, storeDir: path.join(x.root, '.beads'), databasePath: where.database_path, bdPath: bd } });
  cases.push({ name: 'native-registration', inspection: registration.inspection, binding: registration.state.memoryBindings.at(-1) });
  const canonicalBefore = fs.readFileSync(f.stateFile(x.root)), first = x.invoke();
  assert.equal(first.result.code, 'reconciled'); assert.equal(auto.verifyReconciliation({ projectRoot: x.root, request: first.q, out: first.out }).code, 'reconciled');
  const linked = path.join(x.owned, 'linked'); f.git(x.root, 'worktree', 'add', '-qb', 'resume-worker', linked);
  x.rows.push(f.row('worker')); x.writeControl(); const association = x.associate('worker', linked);
  const second = x.invoke(x.request({ associations: [association] }));
  assert.equal(second.result.code, 'reconciled'); assert.equal(auto.verifyReconciliation({ projectRoot: x.root, request: second.q, out: second.out }).code, 'reconciled');
  assert.notEqual(first.q.attemptId, second.q.attemptId); assert.notEqual(first.q.resumeId, second.q.resumeId);
  const workerRequest = auto.prepareMemoryRequest({ projectRoot: x.root, attemptId: f.uuid(), operation: 'worker-readonly', phase: 'resume', target: { projectId: 'fixture-project', sessionId: 'worker', resumeId: f.uuid() } });
  const worker = auto.primeMemory({ projectRoot: x.root, callerRoot: linked, request: workerRequest, out: x.out() });
  const consumed = auto.verifyMemoryBootstrap({ projectRoot: x.root, callerRoot: linked, request: workerRequest, out: worker.out });
  assert.equal(consumed.status, 'memory-primed'); assert.ok(consumed.primeText.includes('fvs-auto-project-context'));
  assert.equal(fs.existsSync(path.join(linked, '.beads/embeddeddolt')), false);
  cases.push({ name: 'two-current-wired-resumes', first: { request: first.q, out: first.out }, second: { request: second.q, out: second.out }, actualLinkedWorkerPrime: { request: workerRequest, out: worker.out } });
  function refuses(name, code, fn) {
    const before = fs.readFileSync(path.join(x.root, '.formalising/auto-fv/resume/state.json'));
    assert.throws(fn, (e) => { cases.push({ name, actualCode: e.code, message: e.message }); return e.code === code; });
    assert.deepEqual(fs.readFileSync(path.join(x.root, '.formalising/auto-fv/resume/state.json')), before);
    assert.deepEqual(fs.readFileSync(f.stateFile(x.root)), canonicalBefore);
  }
  refuses('old-result-substitution', 'resume-result-mismatch', () => auto.verifyReconciliation({ projectRoot: x.root, request: second.q, out: first.out }));
  refuses('old-committed-head', 'resume-head-stale', () => auto.verifyReconciliation({ projectRoot: x.root, request: first.q, out: first.out }));
  const wrongRole = x.request({ associations: [association] }); wrongRole.memoryRequest.operation = 'worker-readonly';
  refuses('worker-refresh-not-coordinator', 'resume-memory-mismatch', () => x.invoke(wrongRole));
  const changedRequest = structuredClone(second.q); changedRequest.resumeId = f.uuid(); changedRequest.memoryRequest.target.resumeId = changedRequest.resumeId;
  refuses('wrong-current-resume', 'resume-result-mismatch', () => auto.verifyReconciliation({ projectRoot: x.root, request: changedRequest, out: second.out }));
  fs.appendFileSync(path.join(x.root, 'README.md'), '\nowned negative: actual source drift\n');
  refuses('real-source-drift', 'resume-context-stale', () => auto.verifyReconciliation({ projectRoot: x.root, request: second.q, out: second.out }));
  assert.deepEqual(fs.readFileSync(f.stateFile(x.root)), canonicalBefore);
  save(out, 'qualification', { scope: 'primary/linked backend plus wired resume qualification; AO protocol double, no provider/dispatch/proof authority', cases, source: { file: __filename, sha256: f.sha(fs.readFileSync(__filename)) }, ownedRoot: x.owned });
});

test('fresh real accepted history is inspected currently, then pending registry refuses reuse', { skip: !process.env.FVS_RESUME_CHECKER_CONTEXT }, async () => {
  const api = await import(pathToFileURL(path.join(f.ROOT, 'scripts/fvs-checker-auto.mjs')).href);
  const contextFile = path.resolve(process.env.FVS_RESUME_CHECKER_CONTEXT), c = JSON.parse(fs.readFileSync(contextFile));
  assert.equal(c.schema, 'fvs/auto-resume-checker-qualification'); assert.equal(c.schemaVersion, 1); assert.equal(c.scope, 'qualification-only');
  assert.equal(f.sha(fs.readFileSync(c.baseline.file)), c.baseline.sha256);
  const frozen = JSON.parse(fs.readFileSync(c.baseline.file));
  assert.equal(frozen.checker[path.join(f.ROOT, 'scripts/fvs-auto.mjs')], f.sha(fs.readFileSync(path.join(f.ROOT, 'scripts/fvs-auto.mjs'))));
  assert.equal(frozen.registry.root, c.registryRoot);
  for (const p of [c.registryRoot, c.store.root, c.out]) assert.ok(p.startsWith(c.ownedRoot + path.sep), 'negative mutation/output is exclusively owned');
  fs.mkdirSync(c.out); const before = api.readAcceptedStore(c.store.root), records = before.records.map((r) => f.ref(r.file));
  assert.equal(before.headSha256, c.store.expectedHeadSha256); assert.ok(before.heads.has(19), 'real helper kernel check/acceptance prerequisite');
  const request = { baseline: c.baseline, store: c.store, source: c.source, deadlineMs: Date.now() + 600000, out: path.join(c.out, 'positive') };
  const result = api.inspectAutoAcceptance(request);
  assert.equal(result.status, 'current'); assert.deepEqual(result.acceptedBaseline, { commit: c.source.commit, tree: c.source.expectedTree });
  assert.ok(result.nodes.some((r) => r.node === 19)); save(c.out, 'positive', { request, result });
  fs.mkdirSync(path.join(c.registryRoot, 'lock')); // New owned marker; no old record/input is overwritten/reset.
  assert.equal(api.readAcceptedStore(c.store.root).headSha256, before.headSha256, 'historical chain is still valid');
  let refusal;
  assert.throws(() => api.inspectAutoAcceptance({ ...request, out: path.join(c.out, 'negative') }), (e) => { refusal = { code: e.code, message: e.message }; return e.code === 'stale-input' && /pending|head changed/.test(e.message); });
  assert.equal(fs.existsSync(path.join(c.out, 'negative')), false, 'refuses before allocating new currentness output');
  for (const r of records) assert.equal(f.sha(fs.readFileSync(r.file)), r.sha256);
  save(c.out, 'qualification', { scope: 'qualification-only helper19 receipt/currentness; no target-project promotion', context: f.ref(contextFile), result, refusal, acceptedRecordsUnchanged: records, pendingMarkerRetained: path.join(c.registryRoot, 'lock') });
});
