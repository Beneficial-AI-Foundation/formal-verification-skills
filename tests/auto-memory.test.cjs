// Protocol fixtures; the explicit auto-memory-real lane qualifies actual Beads separately.
const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const f = require('./helpers/memory-fixture.cjs');
const dirs = [];
let auto, memory;
before(async () => { memory = await import(pathToFileURL(path.join(f.ROOT, 'scripts/fvs-project-memory.mjs')).href); auto = await import(pathToFileURL(path.join(f.ROOT, 'scripts/fvs-auto.mjs')).href); });
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function project() { const root = f.createProject(auto); dirs.push(root); return root; }
function fixture() { const root = project(), registration = f.fakeStore(root); auto.recordMemory({ projectRoot: root, registration }); return { root, registration }; }
function bytes(root) { return fs.readFileSync(f.stateFile(root)); }
function stored(root) { return JSON.parse(bytes(root)); }
function context(root) { const p = path.join(root, '.beads/context.txt'); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; }
function refuses(code, fn) { let failure; assert.throws(fn, (e) => { failure = e; return e instanceof auto.Refusal && e.code === code; }); return failure; }
function invoke(root, q, route = 'worker', name = 'observe') {
  const out = f.output(root, name);
  return (route === 'worker' ? auto.primeMemory : auto.refreshMemory)({ projectRoot: root, callerRoot: root, request: q, out });
}
function seeded() { const x = fixture(), q = f.request(auto, x.root, 'coordinator-refresh'); const result = invoke(x.root, q, 'coordinator'); return { ...x, q, result }; }
function cli(root, args) {
  const r = spawnSync(process.execPath, [path.join(f.ROOT, 'scripts/fvs-auto.mjs'), ...args, '--project-root', root], { cwd: root, encoding: 'utf8' });
  return { ...r, json: JSON.parse(r.stdout) };
}

describe('project memory registration', () => {
  it('never creates a missing store and leaves legacy state untouched', () => {
    const root = project(), before = bytes(root);
    refuses('memory-store-missing', () => auto.recordMemory({ projectRoot: root, registration: { backend: 'beads', canonicalRoot: root, storeDir: path.join(root, '.beads'), databasePath: path.join(root, '.beads/embeddeddolt'), bdPath: process.execPath } }));
    assert.deepEqual(bytes(root), before); assert.equal(fs.existsSync(path.join(root, '.beads')), false);
    assert.equal('memoryBindings' in stored(root), false);
  });
  it('does not turn a metadata-only clone into an initialized database', () => {
    const root = project(), registration = f.fakeStore(root), db = path.join(root, '.beads/embeddeddolt');
    fs.renameSync(db, path.join(root, 'retained-fixture-database'));
    const before = bytes(root);
    refuses('memory-store-missing', () => auto.recordMemory({ projectRoot: root, registration }));
    assert.equal(fs.existsSync(db), false); assert.deepEqual(bytes(root), before);
    assert.equal(f.calls(root).some((c) => ['remember', 'init'].includes(c.cmd)), false);
  });
  it('records actual identities once, preserves writer history/limits and reads without invoking backend', () => {
    const { root, registration } = fixture(); const before = bytes(root), s = stored(root), n = f.calls(root).length;
    assert.equal(s.memoryBindings[0].bindingRevision, 0); assert.equal(s.memoryBindings[0].backendProjectId, JSON.parse(fs.readFileSync(path.join(root, '.beads/metadata.json'))).project_id);
    auto.readState({ projectRoot: root }); assert.equal(f.calls(root).length, n);
    assert.equal(auto.recordMemory({ projectRoot: root, registration }).code, 'unchanged'); assert.deepEqual(bytes(root), before);
    auto.recordRoadmap({ projectRoot: root, decision: 'declined' });
    assert.deepEqual(stored(root).memoryBindings, s.memoryBindings); assert.deepEqual(stored(root).choices.limits, s.choices.limits);
    assert.equal(stored(root).choicesGeneration, s.choicesGeneration);
  });
  it('refuses registration if actual Git identity drifts during backend inspection', () => {
    const root = project(), registration = f.fakeStore(root), before = bytes(root);
    f.control(root, { driftGitOnInfo: true });
    refuses('memory-project-mismatch', () => auto.recordMemory({ projectRoot: root, registration }));
    assert.deepEqual(bytes(root), before); assert.equal('memoryBindings' in stored(root), false); assert.equal(context(root), null);
  });
  it('confirms changed tool identity and appends rather than replacing bindings', () => {
    const { root, registration } = fixture(); const before = bytes(root);
    fs.appendFileSync(registration.bdPath, '\n// changed installed build\n');
    refuses('confirmation-required', () => auto.recordMemory({ projectRoot: root, registration })); assert.deepEqual(bytes(root), before);
    auto.recordMemory({ projectRoot: root, registration, confirmOverwrite: true });
    assert.deepEqual(stored(root).memoryBindings.map((b) => b.bindingRevision), [0, 1]); assert.equal(stored(root).choicesGeneration, 0);
  });
  it('preserves optional binding during a confirmed M1 init change without invoking memory backend', () => {
    const { root } = fixture(); const initial = stored(root), n = f.calls(root).length;
    const keys = ['HOME', 'PATH', 'FVS_TOOLS_HOME'], old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.HOME = path.join(f.ROOT, 'tests/fixtures/auto-profile/home');
    process.env.PATH = path.join(f.ROOT, 'tests/fixtures/auto-profile/bin') + path.delimiter + '/usr/bin:/bin';
    process.env.FVS_TOOLS_HOME = path.join(f.ROOT, 'tests/fixtures/auto-profile/no-fvs-tools');
    try { auto.initState({ projectRoot: root, choices: { ...initial.choices, scope: 'changed scope' }, confirmOverwrite: true, platform: 'aarch64-apple-darwin' }); }
    finally { for (const k of keys) if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
    assert.deepEqual(stored(root).memoryBindings, initial.memoryBindings); assert.equal(f.calls(root).length, n); assert.equal(stored(root).choicesGeneration, 1);
  });
  it('rejects unknown malformed binding data on default reads without repair', () => {
    const { root } = fixture(), valid = stored(root);
    for (const change of [(s) => { s.memoryBindings[0].schemaVersion = 2; }, (s) => { s.memoryBindings[0].extra = true; }, (s) => { s.memoryBindings.push(s.memoryBindings[0]); }]) {
      const s = structuredClone(valid); change(s); fs.writeFileSync(f.stateFile(root), JSON.stringify(s)); const before = bytes(root);
      refuses('malformed-state', () => auto.readState({ projectRoot: root })); assert.deepEqual(bytes(root), before);
    }
  });
  it('supports an explicit canonical monorepo control subdirectory without cwd discovery', () => {
    const primary = project(), root = path.join(primary, 'LeanControl'); fs.mkdirSync(root);
    fs.cpSync(path.join(primary, '.formalising'), path.join(root, '.formalising'), { recursive: true });
    const registration = f.fakeStore(root); auto.recordMemory({ projectRoot: root, registration });
    const q = f.request(auto, root, 'coordinator-refresh'), observed = invoke(root, q, 'coordinator');
    assert.equal(observed.result.context.project.canonicalRoot, root);
    assert.equal(observed.result.context.project.gitCommonDir, path.join(primary, '.git'));
    assert.equal(auto.verifyMemoryBootstrap({ projectRoot: root, callerRoot: root, request: q, out: observed.out }).status, 'memory-primed');
    assert.equal(fs.existsSync(path.join(primary, '.beads')), false);
  });
  it('refuses a worktree-local registration and an escaping store symlink', () => {
    const { root } = fixture(), parent = path.dirname(root), linked = path.join(parent, 'fvs-memory-linked-' + crypto.randomUUID()); dirs.push(linked);
    f.git(root, 'worktree', 'add', '-qb', 'worker', linked);
    fs.cpSync(path.join(root, '.formalising'), path.join(linked, '.formalising'), { recursive: true });
    const local = f.fakeStore(linked);
    refuses('memory-not-primary', () => auto.recordMemory({ projectRoot: linked, registration: local }));
    const other = project(), registration = { backend: 'beads', canonicalRoot: other, storeDir: path.join(other, '.beads'), databasePath: path.join(other, '.beads/embeddeddolt'), bdPath: local.bdPath };
    fs.symlinkSync(path.join(root, '.beads'), registration.storeDir);
    refuses('memory-store-missing', () => auto.recordMemory({ projectRoot: other, registration }));
  });
});

describe('fresh project-memory bootstrap', () => {
  it('coordinator seeds actual context, worker consumes actual prime and runtime observations do not rewrite state', () => {
    const { root, q, result } = seeded(); const before = bytes(root), value = context(root);
    const c = auto.verifyMemoryBootstrap({ projectRoot: root, callerRoot: root, request: q, out: result.out });
    assert.equal(c.status, 'memory-primed'); assert.ok(c.primeText.includes(value));
    const worker = f.request(auto, root), observation = invoke(root, worker);
    assert.equal(auto.verifyMemoryBootstrap({ projectRoot: root, callerRoot: root, request: worker, out: observation.out }).status, 'memory-primed');
    assert.deepEqual(bytes(root), before); assert.equal(context(root), value); assert.equal(stored(root).choicesGeneration, 0);
    assert.equal(f.calls(root).filter((c) => c.cmd === 'remember').length, 1);
    assert.equal(JSON.parse(value).authority, 'context-only'); assert.equal(JSON.parse(value).agreement.payload.execution, null);
    assert.ok(!value.includes(worker.attemptId)); assert.ok(!value.includes(worker.target.sessionId));
  });
  it('two unchanged-content resumes bind different caller identities and reject old result substitution', () => {
    const { root } = seeded(), a = f.request(auto, root), b = f.request(auto, root);
    const first = invoke(root, a), second = invoke(root, b); assert.notEqual(a.attemptId, b.attemptId);
    assert.equal(first.result.prime.sha256, second.result.prime.sha256);
    refuses('memory-result-mismatch', () => auto.verifyMemoryBootstrap({ projectRoot: root, callerRoot: root, request: b, out: first.out }));
    assert.equal(auto.verifyMemoryBootstrap({ projectRoot: root, callerRoot: root, request: b, out: second.out }).status, 'memory-primed');
    const sameResumeNewAttempt = { ...b, attemptId: crypto.randomUUID() };
    refuses('memory-result-mismatch', () => auto.verifyMemoryBootstrap({ projectRoot: root, callerRoot: root, request: sameResumeNewAttempt, out: second.out }));
  });
  it('shares the canonical primary store with a linked worker and strips backend redirects', () => {
    const { root } = seeded(), linked = path.join(path.dirname(root), 'fvs-memory-linked-' + crypto.randomUUID()); dirs.push(linked);
    f.git(root, 'worktree', 'add', '-qb', 'linked', linked);
    const q = f.request(auto, root), out = f.output(root); const old = process.env.BEADS_DIR; process.env.BEADS_DIR = '/wrong/global-store';
    try { auto.primeMemory({ projectRoot: root, callerRoot: linked, request: q, out }); }
    finally { if (old === undefined) delete process.env.BEADS_DIR; else process.env.BEADS_DIR = old; }
    assert.equal(fs.existsSync(path.join(linked, '.beads')), false);
    assert.ok(f.calls(root).every((c) => !c.redirected)); assert.equal(auto.verifyMemoryBootstrap({ projectRoot: root, callerRoot: linked, request: q, out }).status, 'memory-primed');
  });
  it('readonly missing/stale content cannot reach remember; coordinator refreshes recognized stale data', () => {
    const { root } = fixture(), q = f.request(auto, root), before = bytes(root);
    refuses('memory-content-missing', () => invoke(root, q)); assert.equal(context(root), null); assert.equal(f.calls(root).some((c) => c.cmd === 'remember'), false);
    const seed = invoke(root, f.request(auto, root, 'coordinator-refresh'), 'coordinator');
    const stale = structuredClone(seed.result.context); stale.continuation.nextAction = 'stale continuation';
    fs.writeFileSync(path.join(root, '.beads/context.txt'), JSON.stringify(stale)); const old = context(root), n = f.calls(root).filter((c) => c.cmd === 'remember').length;
    refuses('memory-content-stale', () => invoke(root, f.request(auto, root))); assert.equal(context(root), old);
    assert.equal(f.calls(root).filter((c) => c.cmd === 'remember').length, n);
    invoke(root, f.request(auto, root, 'coordinator-refresh'), 'coordinator'); assert.notEqual(context(root), old); assert.deepEqual(bytes(root), before);
  });
  it('worker CLI/API refresh requests and coordinator operation refuse before writes', () => {
    const { root } = fixture(), worker = f.request(auto, root), before = bytes(root), n = f.calls(root).length;
    refuses('invalid-input', () => auto.primeMemory({ projectRoot: root, callerRoot: root, request: worker, out: f.output(root), refresh: true }));
    refuses('memory-route-mismatch', () => invoke(root, f.request(auto, root, 'coordinator-refresh')));
    const input = path.join(root, 'request.json'); fs.writeFileSync(input, JSON.stringify(worker));
    const cliResult = cli(root, ['prime-memory', '--request', input, '--out', f.output(root), '--refresh']);
    assert.equal(cliResult.status, 2); assert.equal(cliResult.json.code, 'usage'); assert.equal(f.calls(root).length, n);
    assert.deepEqual(bytes(root), before); assert.equal(context(root), null);
  });
  it('rejects malformed closed caller requests before any backend call or store write', () => {
    const { root } = fixture(), good = f.request(auto, root), before = bytes(root), n = f.calls(root).length;
    for (const mutate of [(q) => { q.schemaVersion = 2; }, (q) => { q.refresh = true; }, (q) => { q.attemptId = 'not-fresh-uuid'; },
      (q) => { q.phase = 'start'; }, (q) => { q.expected.extra = true; }]) {
      const q = structuredClone(good); mutate(q); refuses('invalid-input', () => invoke(root, q));
      assert.deepEqual(bytes(root), before); assert.equal(context(root), null); assert.equal(f.calls(root).length, n);
    }
  });
  it('rejects inherited or custom-serialized target identities instead of omitting them from the request hash', () => {
    const { root } = fixture(), q = f.request(auto, root), n = f.calls(root).length, before = bytes(root);
    const inherited = { ...q, target: Object.create(q.target) };
    const custom = { ...q, target: Object.assign(Object.create({ toJSON() { return {}; } }), q.target) };
    for (const request of [inherited, custom]) refuses('invalid-input', () => invoke(root, request));
    assert.equal(f.calls(root).length, n); assert.deepEqual(bytes(root), before); assert.equal(context(root), null);
  });
  it('requires the actual prime invocation and request-bound outputs, not a self-consistent ready envelope', () => {
    const { root } = seeded(), q = f.request(auto, root), observed = invoke(root, q);
    for (const kind of ['missing-prime-invocation', 'forged-prime-file', 'wrong-receipt-attempt']) {
      const out = f.output(root, kind); fs.cpSync(observed.out, out, { recursive: true });
      const file = path.join(out, 'result.json'), r = JSON.parse(fs.readFileSync(file));
      if (kind === 'missing-prime-invocation') {
        r.receipts = r.receipts.filter((ref) => !JSON.parse(fs.readFileSync(path.join(out, ref.file))).argv.includes('prime'));
      } else if (kind === 'forged-prime-file') {
        const prime = fs.readFileSync(path.join(out, 'prime.txt')); const forged = Buffer.concat([Buffer.from('fabricated prefix\n'), prime]);
        fs.writeFileSync(path.join(out, 'prime.txt'), forged); r.prime.sha256 = crypto.createHash('sha256').update(forged).digest('hex'); r.prime.bytes = forged.length;
      } else {
        const ref = r.receipts[0], receiptPath = path.join(out, ref.file), receipt = JSON.parse(fs.readFileSync(receiptPath));
        receipt.attemptId = crypto.randomUUID(); fs.writeFileSync(receiptPath, JSON.stringify(receipt));
        ref.sha256 = crypto.createHash('sha256').update(fs.readFileSync(receiptPath)).digest('hex');
      }
      fs.writeFileSync(file, JSON.stringify(r));
      refuses('memory-evidence-invalid', () => auto.verifyMemoryBootstrap({ projectRoot: root, callerRoot: root, request: q, out }));
    }
  });
  it('does not silently migrate changed backend project identity or database selection', () => {
    const { root } = seeded(), metadata = path.join(root, '.beads/metadata.json'), m = JSON.parse(fs.readFileSync(metadata));
    m.project_id = 'different-project'; fs.writeFileSync(metadata, JSON.stringify(m)); const before = bytes(root), value = context(root);
    refuses('memory-store-mismatch', () => invoke(root, f.request(auto, root))); assert.equal(context(root), value); assert.deepEqual(bytes(root), before);
    m.project_id = stored(root).memoryBindings[0].backendProjectId; fs.writeFileSync(metadata, JSON.stringify(m));
    f.control(root, { databasePath: path.join(root, '.beads') });
    refuses('memory-store-mismatch', () => invoke(root, f.request(auto, root))); assert.equal(context(root), value); assert.deepEqual(bytes(root), before);
  });
  it('pins the logical database even if its container and project id stay unchanged', () => {
    const { root } = seeded(), metadata = path.join(root, '.beads/metadata.json'), m = JSON.parse(fs.readFileSync(metadata));
    assert.equal(stored(root).memoryBindings[0].databaseName, m.dolt_database);
    fs.mkdirSync(path.join(root, '.beads/embeddeddolt/other_db/.dolt'), { recursive: true });
    m.dolt_database = 'other_db'; fs.writeFileSync(metadata, JSON.stringify(m));
    const before = bytes(root), value = context(root), n = f.calls(root).length;
    for (const route of ['worker', 'coordinator']) refuses('memory-store-mismatch', () => invoke(root, f.request(auto, root, route === 'worker' ? 'worker-readonly' : 'coordinator-refresh'), route));
    assert.equal(f.calls(root).length, n); assert.deepEqual(bytes(root), before); assert.equal(context(root), value);
  });
  for (const [mode, code] of [[{ driftStateOnRead: true }, 'stale-agreement'], [{ driftSelectorOnRead: true }, 'memory-store-mismatch']]) {
    it('rechecks canonical/store identity before remember after an intervening query drift: ' + code, () => {
      const { root } = fixture(); f.control(root, mode);
      const failure = refuses(code, () => invoke(root, f.request(auto, root, 'coordinator-refresh'), 'coordinator'));
      assert.equal(failure.details.result.status, 'blocked'); assert.equal(context(root), null);
      assert.equal(f.calls(root).some((c) => c.cmd === 'remember'), false);
    });
  }
  for (const phase of ['read-before-write', 'prime-before-ready']) {
    it('refuses actual primary Git-control drift at ' + phase, () => {
      const data = phase === 'read-before-write' ? fixture() : seeded(), { root } = data;
      f.control(root, phase === 'read-before-write' ? { driftGitOnRead: true } : { driftGitOnPrime: true });
      const before = bytes(root), value = context(root), priorWrites = f.calls(root).filter((c) => c.cmd === 'remember').length;
      const operation = phase === 'read-before-write' ? 'coordinator-refresh' : 'worker-readonly';
      const failure = refuses('memory-project-mismatch', () => invoke(root, f.request(auto, root, operation), phase === 'read-before-write' ? 'coordinator' : 'worker'));
      assert.equal(failure.details.result.status, 'blocked'); assert.equal(failure.details.result.prime, null);
      assert.equal(context(root), value); assert.deepEqual(bytes(root), before);
      assert.equal(f.calls(root).filter((c) => c.cmd === 'remember').length, priorWrites);
      assert.ok(fs.existsSync(path.join(root, '.git-held'))); assert.equal(fs.existsSync(path.join(root, '.git')), false);
    });
  }
  for (const kind of ['removed', 'redirected']) {
    it('refuses consumption after primary Git metadata is ' + kind, () => {
      const { root } = seeded(), q = f.request(auto, root), observed = invoke(root, q), before = bytes(root), value = context(root);
      fs.renameSync(path.join(root, '.git'), path.join(root, '.git-held'));
      if (kind === 'redirected') { const other = project(); fs.writeFileSync(path.join(root, '.git'), 'gitdir: ' + path.join(other, '.git') + '\n'); }
      refuses('memory-project-mismatch', () => auto.verifyMemoryBootstrap({ projectRoot: root, callerRoot: root, request: q, out: observed.out }));
      assert.equal(context(root), value); assert.deepEqual(bytes(root), before);
    });
  }
  it('retains and rechecks the linked producer caller relationship at consumption', () => {
    const { root } = seeded(), linked = path.join(path.dirname(root), 'fvs-memory-linked-' + crypto.randomUUID()); dirs.push(linked);
    f.git(root, 'worktree', 'add', '-qb', 'consumer-linked', linked);
    const q = f.request(auto, root), out = f.output(root);
    auto.primeMemory({ projectRoot: root, callerRoot: linked, request: q, out });
    assert.equal(auto.verifyMemoryBootstrap({ projectRoot: root, callerRoot: linked, request: q, out }).status, 'memory-primed');
    fs.renameSync(path.join(linked, '.git'), path.join(linked, '.git-held'));
    refuses('memory-project-mismatch', () => auto.verifyMemoryBootstrap({ projectRoot: root, callerRoot: linked, request: q, out }));
  });
  it('rejects hidden/accessor/coercion API identities without executing hooks or allocating output', () => {
    const { root } = fixture(), good = f.request(auto, root), before = bytes(root), n = f.calls(root).length;
    let executed = 0;
    const variants = [];
    let q = structuredClone(good); q.expected.memoryContextSha256 = '0'.repeat(64);
    Object.defineProperty(q.expected, 'toJSON', { value() { executed++; return good.expected; } }); variants.push(q);
    q = structuredClone(good); Object.defineProperty(q.target, 'toJSON', { value() { executed++; return good.target; } }); variants.push(q);
    q = structuredClone(good); Object.defineProperty(q, 'attemptId', { enumerable: true, get() { executed++; return good.attemptId; } }); variants.push(q);
    q = structuredClone(good); Object.defineProperty(q.expected, 'bindingSha256', { enumerable: true, get() { executed++; return good.expected.bindingSha256; } }); variants.push(q);
    q = structuredClone(good); q.attemptId = { toString() { executed++; return good.attemptId; } }; variants.push(q);
    q = structuredClone(good); q.expected.bindingSha256 = { toString() { executed++; return good.expected.bindingSha256; } }; variants.push(q);
    q = structuredClone(good); q.target[Symbol('hidden')] = 'not-json'; variants.push(q);
    q = structuredClone(good); q.attemptId = [good.attemptId]; variants.push(q);
    q = structuredClone(good); q.expected.bindingSha256 = [good.expected.bindingSha256]; variants.push(q);
    for (const value of [undefined, NaN, Infinity, 1n, () => 'not-data']) { q = structuredClone(good); q.expected.bindingSha256 = value; variants.push(q); }
    for (const request of variants) {
      const out = f.output(root, 'must-not-allocate');
      refuses('invalid-input', () => auto.primeMemory({ projectRoot: root, callerRoot: root, request, out }));
      assert.equal(fs.existsSync(out), false);
    }
    const options = { projectRoot: root, operation: 'worker-readonly', phase: 'resume', target: good.target };
    Object.defineProperty(options, 'attemptId', { enumerable: true, get() { executed++; return good.attemptId; } });
    refuses('invalid-input', () => auto.prepareMemoryRequest(options));
    const direct = { loadCanonical() { executed++; throw new Error('must not run'); }, operation: 'worker-readonly', phase: 'resume', target: good.target };
    Object.defineProperty(direct, 'attemptId', { enumerable: true, get() { executed++; return good.attemptId; } });
    assert.throws(() => memory.prepareMemoryBootstrapRequest(direct), (e) => e.code === 'invalid-input');
    assert.equal(executed, 0); assert.equal(f.calls(root).length, n); assert.equal(context(root), null); assert.deepEqual(bytes(root), before);
  });
  it('accepts ordinary parsed/null-prototype JSON and retains a stable validated snapshot', () => {
    const { root } = seeded(), plain = JSON.parse(JSON.stringify(f.request(auto, root)));
    const q = Object.assign(Object.create(null), plain); q.target = Object.assign(Object.create(null), plain.target); q.expected = Object.assign(Object.create(null), plain.expected);
    const observed = invoke(root, q); const consumed = auto.verifyMemoryBootstrap({ projectRoot: root, callerRoot: root, request: q, out: observed.out });
    assert.equal(consumed.status, 'memory-primed'); assert.ok(consumed.gitObservation.primary.gitCommonDir.endsWith('.git'));
    assert.ok(consumed.gitEvidence.receipts.length > 0);
  });
  it('actual CLI start observations retain request bytes and independent current-request consumption', () => {
    const { root } = seeded(), q = f.request(auto, root, 'worker-readonly', { phase: 'start', target: { projectId: 'fixture-project', sessionId: 'new-worker', resumeId: null } });
    const file = path.join(root, 'request.json'); const raw = JSON.stringify(q, null, 1) + '\n'; fs.writeFileSync(file, raw);
    const out = f.output(root); const r = cli(root, ['prime-memory', '--request', file, '--out', out]);
    assert.equal(r.status, 0, r.stderr); assert.equal(r.json.code, 'memory-primed'); assert.equal(fs.readFileSync(path.join(out, 'request.json'), 'utf8'), raw);
    assert.equal(auto.verifyMemoryBootstrap({ projectRoot: root, callerRoot: root, request: q, out }).status, 'memory-primed');
  });
  for (const [name, change, expected] of [
    ['binding revision', (q) => { q.expected.bindingRevision++; }, 'memory-expectation-stale'],
    ['binding hash', (q) => { q.expected.bindingSha256 = '0'.repeat(64); }, 'memory-expectation-stale'],
    ['context', (q) => { q.expected.memoryContextSha256 = '0'.repeat(64); }, 'memory-expectation-stale'],
    ['phase', (q) => { q.phase = 'start'; q.target.resumeId = null; }, 'memory-result-mismatch'],
    ['project', (q) => { q.target.projectId = 'other'; }, 'memory-result-mismatch'],
    ['session', (q) => { q.target.sessionId = 'other'; }, 'memory-result-mismatch'],
    ['resume', (q) => { q.target.resumeId = 'other'; }, 'memory-result-mismatch'],
  ]) it('refuses substituted wrong ' + name + ' against the consumer own request', () => {
    const { root } = seeded(), q = f.request(auto, root), observed = invoke(root, q), altered = structuredClone(q); change(altered);
    refuses(expected, () => auto.verifyMemoryBootstrap({ projectRoot: root, callerRoot: root, request: altered, out: observed.out }));
    if (expected === 'memory-expectation-stale') {
      const value = context(root); refuses(expected, () => invoke(root, altered)); assert.equal(context(root), value);
    }
  });
  for (const [name, value, expected] of [
    ['malformed', '{broken', 'memory-content-invalid'],
    ['unknown', JSON.stringify({ schema: 'unknown' }), 'memory-content-invalid'],
    ['foreign', null, 'memory-content-foreign'],
  ]) it('preserves ' + name + ' memory instead of overwriting it', () => {
    const { root, result } = seeded(); const other = structuredClone(result.result.context); other.project.backendProjectId = 'foreign';
    const raw = value ?? JSON.stringify(other); fs.writeFileSync(path.join(root, '.beads/context.txt'), raw); const before = bytes(root);
    refuses(expected, () => invoke(root, f.request(auto, root, 'coordinator-refresh'), 'coordinator'));
    assert.equal(context(root), raw); assert.deepEqual(bytes(root), before);
  });
  for (const [name, mode, code] of [
    ['missing prime', { missingPrime: true }, 'memory-prime-missing'],
    ['failed query', { fail: 'memories' }, 'memory-command-failed'],
    ['malformed query', { badJson: true }, 'memory-output-invalid'],
    ['oversize output', { oversize: true }, 'memory-command-failed'],
    ['timeout', { timeout: true }, 'memory-command-failed'],
    ['canonical drift during prime', { driftState: true }, 'stale-agreement'],
  ]) it('does not become ready after ' + name, () => {
    const { root } = seeded(); f.control(root, mode); const value = context(root);
    const q = f.request(auto, root); const failure = refuses(code, () => invoke(root, q)); assert.equal(context(root), value);
    if (mode.oversize || mode.timeout) {
      const ref = failure.details.result.receipts.at(-1);
      const last = JSON.parse(fs.readFileSync(path.join(failure.details.out, ref.file)));
      assert.ok(last.argv.includes('prime')); assert.equal(last.error.code, mode.oversize ? 'ENOBUFS' : 'ETIMEDOUT');
      assert.equal(failure.details.result.prime, null);
    }
  });
  it('preserves a partial remember outcome without pretending it primed or rolling it back', () => {
    const { root } = fixture(); f.control(root, { partialRemember: true }); const before = bytes(root);
    let failure; try { invoke(root, f.request(auto, root, 'coordinator-refresh'), 'coordinator'); } catch (e) { failure = e; }
    assert.equal(failure.code, 'memory-command-failed'); assert.equal(failure.details.result.status, 'partial'); assert.ok(context(root));
    assert.deepEqual(bytes(root), before); assert.equal(failure.details.result.prime, null);
  });
  it('refuses changed backend/tool/project and missing/mutated actual evidence', () => {
    const { root, registration } = seeded(), q = f.request(auto, root), result = invoke(root, q); const before = bytes(root);
    fs.writeFileSync(path.join(result.out, 'prime.txt'), 'altered actual output');
    refuses('memory-evidence-invalid', () => auto.verifyMemoryBootstrap({ projectRoot: root, callerRoot: root, request: q, out: result.out }));
    fs.appendFileSync(registration.bdPath, '\n// byte drift');
    refuses('memory-tool-changed', () => auto.verifyMemoryBootstrap({ projectRoot: root, callerRoot: root, request: q, out: result.out }));
    refuses('memory-tool-changed', () => invoke(root, f.request(auto, root)));
    assert.deepEqual(bytes(root), before);
  });
  it('rejects a logical selector change between a valid observation and consumption', () => {
    const { root } = seeded(), q = f.request(auto, root), observed = invoke(root, q);
    const file = path.join(root, '.beads/metadata.json'), m = JSON.parse(fs.readFileSync(file)); m.dolt_database = 'other_db';
    fs.writeFileSync(file, JSON.stringify(m));
    refuses('memory-store-mismatch', () => auto.verifyMemoryBootstrap({ projectRoot: root, callerRoot: root, request: q, out: observed.out }));
  });
  it('rejects wrong actual database profile and a different Git caller', () => {
    const { root } = seeded(); f.control(root, { mode: 'server' });
    refuses('memory-backend-unsupported', () => invoke(root, f.request(auto, root)));
    f.control(root, {}); const other = project();
    refuses('memory-project-mismatch', () => auto.primeMemory({ projectRoot: root, callerRoot: other, request: f.request(auto, root), out: f.output(root) }));
  });
});


describe('memory bootstrap workflow boundary', () => {
  it('requires fresh memory bootstrap after agreement reuse and consumes actual caller-bound bytes', () => {
    const workflow = fs.readFileSync(path.join(f.ROOT, 'fv-skills/workflows/auto-init.md'), 'utf8');
    const reference = fs.readFileSync(path.join(f.ROOT, 'fv-skills/references/auto-memory.md'), 'utf8');
    assert.match(workflow, /proceed to Step6's recorded memory disposition/);
    assert.match(workflow, /Every start\/resume[\s\S]*own current request; enabled memory also needs the fresh prime/);
    assert.match(workflow, /"\$AUTO" refresh-memory --project-root "\$PRIMARY" --request "\$REQUEST" --out "\$MEMORY_OUT"/);
    assert.match(workflow, /"\$AUTO" prime-memory --project-root "\$PRIMARY" --request "\$REQUEST" --out "\$MEMORY_OUT"/);
    assert.match(workflow, /independently held request/);
    assert.match(reference, /actualWorkerContext = current\.primeText/);
    assert.match(reference, /not OS\/provider authentication/);
    assert.match(reference, /No memory result[\s\S]*proves a theorem/);
    assert.match(reference, /16 coordinator consumer[\s\S]*auto-resume\.md[\s\S]*22 dispatch wiring/);
    assert.match(reference, /This memory adapter itself establishes neither/);
  });
});
