// REQUIRED explicit backend lane for ticket20; default Node fixtures never substitute for it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const f = require('./helpers/memory-fixture.cjs');
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');

test('genuine local Beads1.3.1 primary/linked bootstrap and refusal qualification', { skip: process.env.FVS_MEMORY_REAL !== '1' }, async () => {
  const auto = await import(pathToFileURL(path.join(f.ROOT, 'scripts/fvs-auto.mjs')).href);
  const out = path.resolve(process.env.FVS_MEMORY_REAL_OUT); fs.mkdirSync(out); // Exclusive, retained, never cleaned/reused.
  const bd = fs.realpathSync(process.env.FVS_MEMORY_BD); const bdSha = sha(fs.readFileSync(bd));
  const ledger = path.join(out, 'cases.jsonl'); let sequence = 0;
  const record = (value) => fs.appendFileSync(ledger, JSON.stringify(value) + '\n');
  const raw = (args, cwd) => {
    const number = String(++sequence).padStart(3, '0'), startedAt = Date.now();
    const r = spawnSync(bd, args, { cwd, env: process.env, encoding: null, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    const processEndedAt = Date.now();
    fs.writeFileSync(path.join(out, number + '.stdout'), r.stdout ?? Buffer.alloc(0));
    fs.writeFileSync(path.join(out, number + '.stderr'), r.stderr ?? Buffer.alloc(0));
    const receipt = { argv: [bd, ...args], cwd, startedAt, processEndedAt, exitCode: r.status, signal: r.signal,
      error: r.error ? { code: r.error.code, message: r.error.message } : null, toolSha256: bdSha,
      stdout: { file: number + '.stdout', sha256: sha(r.stdout ?? Buffer.alloc(0)) }, stderr: { file: number + '.stderr', sha256: sha(r.stderr ?? Buffer.alloc(0)) } };
    fs.writeFileSync(path.join(out, number + '.json'), JSON.stringify(receipt, null, 2));
    assert.equal(sha(fs.readFileSync(bd)), bdSha, 'installed backend unchanged');
    assert.equal(r.status, 0, (r.stderr ?? '').toString()); assert.equal(r.error, undefined);
    return (r.stdout ?? '').toString('utf8');
  };
  const primary = f.createProject(auto, out);
  // Beads1.3.1 -C requires an existing store, so explicit fixture initialization uses cwd.
  raw(['--sandbox', 'init', '--backend', 'dolt', '--skip-agents', '--skip-hooks', '--non-interactive', '--prefix', 'memory-fixture'], primary);
  const registration = { backend: 'beads', canonicalRoot: primary, storeDir: path.join(primary, '.beads'), bdPath: bd };
  const registered = auto.recordMemory({ projectRoot: primary, registration });
  record({ case: 'registered-primary', inspection: registered.inspection, binding: registered.state.memoryBindings.at(-1) });
  const binding = registered.state.memoryBindings.at(-1);
  const prefix = ['-C', primary, '--db', binding.databasePath, '--sandbox'];
  const value = () => JSON.parse(raw([...prefix, '--readonly', 'memories', 'fvs-auto-project-context', '--json'], primary))['fvs-auto-project-context'] ?? null;
  const beforeState = fs.readFileSync(f.stateFile(primary));
  function negative(name, code, fn) {
    let failure; try { fn(); } catch (e) { failure = e; }
    assert.ok(failure instanceof auto.Refusal, name + ' must refuse'); assert.equal(failure.code, code, name + ': ' + failure.message);
    record({ case: name, expectedCode: code, actualCode: failure.code, output: failure.details.out ?? null, resultStatus: failure.details.result?.status ?? null });
    assert.deepEqual(fs.readFileSync(f.stateFile(primary)), beforeState, 'runtime observation cannot rewrite canonical state');
    return failure;
  }
  const missing = f.request(auto, primary);
  negative('missing-owned-context', 'memory-content-missing', () => auto.primeMemory({ projectRoot: primary, callerRoot: primary, request: missing, out: f.output(primary) }));
  assert.equal(value(), null);
  const seedRequest = f.request(auto, primary, 'coordinator-refresh');
  const seed = auto.refreshMemory({ projectRoot: primary, callerRoot: primary, request: seedRequest, out: f.output(primary) });
  const canonicalValue = value(); assert.equal(typeof canonicalValue, 'string');
  const seedConsumed = auto.verifyMemoryBootstrap({ projectRoot: primary, request: seedRequest, out: seed.out });
  assert.ok(seedConsumed.primeText.includes(canonicalValue)); record({ case: 'coordinator-seed-prime', request: seedRequest, out: seed.out, primeSha256: seed.result.prime.sha256 });
  const linked = path.join(out, 'linked-worker'); f.git(primary, 'worktree', 'add', '-qb', 'memory-worker', linked);
  // Init1.3.1 commits metadata to Git. Metadata checkout is not a second backing database.
  const linkedMetadata = () => {
    const dir = path.join(linked, '.beads');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).sort().map((name) => {
      const p = path.join(dir, name); assert.ok(fs.lstatSync(p).isFile(), 'linked store must contain only checked-out metadata');
      return { name, sha256: sha(fs.readFileSync(p)) };
    });
  };
  const metadataBefore = linkedMetadata();
  const linkedDatabase = path.join(linked, '.beads', path.relative(binding.storeDir, binding.databasePath));
  assert.equal(fs.existsSync(linkedDatabase), false);

  const observe = (q) => auto.primeMemory({ projectRoot: primary, callerRoot: linked, request: q, out: f.output(primary) });
  const a = f.request(auto, primary), b = f.request(auto, primary);
  const first = observe(a), second = observe(b); assert.equal(first.result.prime.sha256, second.result.prime.sha256);
  assert.equal(auto.verifyMemoryBootstrap({ projectRoot: primary, request: a, out: first.out }).status, 'memory-primed');
  assert.equal(auto.verifyMemoryBootstrap({ projectRoot: primary, request: b, out: second.out }).status, 'memory-primed');
  assert.equal(fs.existsSync(linkedDatabase), false); assert.deepEqual(linkedMetadata(), metadataBefore); assert.equal(value(), canonicalValue);
  record({ case: 'two-unchanged-linked-resumes', requests: [a, b], outputs: [first.out, second.out], noLinkedDatabase: true, linkedMetadataUnchanged: metadataBefore });
  negative('old-result-substitution', 'memory-result-mismatch', () => auto.verifyMemoryBootstrap({ projectRoot: primary, request: b, out: first.out }));
  for (const [name, change] of [['phase', (q) => { q.phase = 'start'; q.target.resumeId = null; }], ['session', (q) => { q.target.sessionId = 'other'; }], ['resume', (q) => { q.target.resumeId = 'other'; }]]) {
    const q = structuredClone(b); change(q); negative('wrong-' + name, 'memory-result-mismatch', () => auto.verifyMemoryBootstrap({ projectRoot: primary, request: q, out: second.out }));
  }
  const wrongContext = structuredClone(b); wrongContext.expected.memoryContextSha256 = '0'.repeat(64);
  negative('wrong-expected-context', 'memory-expectation-stale', () => observe(wrongContext));
  negative('worker-coordinator-operation', 'memory-route-mismatch', () => observe(seedRequest));
  negative('worker-refresh-selector', 'invalid-input', () => auto.primeMemory({ projectRoot: primary, callerRoot: linked, request: b, out: f.output(primary), refresh: true }));
  assert.equal(value(), canonicalValue);
  const requestFile = path.join(out, 'worker-request.json'); fs.writeFileSync(requestFile, JSON.stringify(b));
  const cli = spawnSync(process.execPath, [path.join(f.ROOT, 'scripts/fvs-auto.mjs'), 'prime-memory', '--project-root', primary, '--request', requestFile, '--out', f.output(primary), '--refresh'], { cwd: linked, env: process.env, encoding: 'utf8' });
  fs.writeFileSync(path.join(out, 'worker-refresh-cli.stdout'), cli.stdout); fs.writeFileSync(path.join(out, 'worker-refresh-cli.stderr'), cli.stderr);
  assert.equal(cli.status, 2); assert.equal(JSON.parse(cli.stdout).code, 'usage'); record({ case: 'worker-refresh-cli', exitCode: cli.status, code: JSON.parse(cli.stdout).code });
  // Change only the backend's logical selector: same container/project_id must still refuse.
  const metadataFile = path.join(primary, '.beads/metadata.json'), metadataBytes = fs.readFileSync(metadataFile);
  fs.writeFileSync(path.join(out, 'metadata-before-selector-case.json'), metadataBytes);
  const selected = JSON.parse(metadataBytes); selected.dolt_database += '_other';
  fs.writeFileSync(metadataFile, JSON.stringify(selected));
  const wrongSelector = negative('logical-database-selector-drift', 'memory-store-mismatch', () => observe(f.request(auto, primary)));
  assert.equal(wrongSelector.details.result.receipts.length, 0, 'refuse before a backend command can target the other logical database');
  negative('logical-selector-drift-before-consumption', 'memory-store-mismatch', () => auto.verifyMemoryBootstrap({ projectRoot: primary, request: b, out: second.out }));
  fs.writeFileSync(path.join(out, 'metadata-selector-mutation.json'), fs.readFileSync(metadataFile));
  fs.writeFileSync(metadataFile, metadataBytes); // Explicit fixture restoration, never product migration.
  assert.equal(value(), canonicalValue);
  const malformed = '{"schema":"not-project-context"}'; raw([...prefix, 'remember', '--key', 'fvs-auto-project-context', malformed], primary);
  negative('malformed-owned-context', 'memory-content-invalid', () => auto.refreshMemory({ projectRoot: primary, callerRoot: primary, request: f.request(auto, primary, 'coordinator-refresh'), out: f.output(primary) }));
  assert.equal(value(), malformed);
  // Explicit fixture mutation, not automatic product repair. Every before/after value is retained in argv receipts.
  raw([...prefix, 'remember', '--key', 'fvs-auto-project-context', canonicalValue], primary);
  const stale = JSON.parse(canonicalValue); stale.continuation.nextAction = 'old fixture continuation'; const staleValue = JSON.stringify(stale);
  raw([...prefix, 'remember', '--key', 'fvs-auto-project-context', staleValue], primary);
  negative('stale-worker-context', 'memory-content-stale', () => observe(f.request(auto, primary))); assert.equal(value(), staleValue);
  const refreshRequest = f.request(auto, primary, 'coordinator-refresh');
  const refreshed = auto.refreshMemory({ projectRoot: primary, callerRoot: primary, request: refreshRequest, out: f.output(primary) });
  assert.equal(value(), canonicalValue); assert.equal(auto.verifyMemoryBootstrap({ projectRoot: primary, request: refreshRequest, out: refreshed.out }).status, 'memory-primed');
  record({ case: 'coordinator-stale-refresh', out: refreshed.out, request: refreshRequest });
  const noStore = f.createProject(auto, out); const missingState = fs.readFileSync(f.stateFile(noStore));
  let noStoreError; try { auto.recordMemory({ projectRoot: noStore, registration: { backend: 'beads', canonicalRoot: noStore, storeDir: path.join(noStore, '.beads'), bdPath: bd } }); } catch (e) { noStoreError = e; }
  assert.equal(noStoreError.code, 'memory-store-missing'); assert.equal(fs.existsSync(path.join(noStore, '.beads')), false); assert.deepEqual(fs.readFileSync(f.stateFile(noStore)), missingState);
  record({ case: 'missing-store-no-auto-init', code: noStoreError.code, project: noStore, storeAbsent: true });
  const mutant = path.join(out, 'altered-prime-case'); fs.cpSync(first.out, mutant, { recursive: true }); fs.writeFileSync(path.join(mutant, 'prime.txt'), 'altered actual prime');
  negative('altered-prime-bytes', 'memory-evidence-invalid', () => auto.verifyMemoryBootstrap({ projectRoot: primary, request: a, out: mutant }));
  // Actual backend output-bound refusal: unrelated fixture memories exceed the fixed 1MiB capture.
  for (let i = 0; i < 280; i++) raw([...prefix, 'remember', '--key', 'fixture-padding-' + i, 'x'.repeat(4000)], primary);
  const bounded = negative('genuine-prime-output-bound', 'memory-command-failed', () => observe(f.request(auto, primary)));
  const lastRef = bounded.details.result.receipts.at(-1);
  const last = JSON.parse(fs.readFileSync(path.join(bounded.details.out, lastRef.file)));
  assert.ok(last.argv.includes('prime')); assert.equal(last.error.code, 'ENOBUFS');
  assert.ok(last.stdout.bytes >= 1024 * 1024); assert.equal(bounded.details.result.prime, null);
  record({ case: 'genuine-prime-cap-cause', argv: last.argv, error: last.error, capturedBytes: last.stdout.bytes });
  assert.equal(value(), canonicalValue); assert.deepEqual(fs.readFileSync(f.stateFile(primary)), beforeState);
  const summary = { scope: 'actual local Beads1.3.1 fixture only, not AO execution/proof acceptance', primary, linked, bd, bdSha256: bdSha,
    sourceRoot: f.ROOT, cases: fs.readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse), stateUnchangedAfterBootstrap: true, noLinkedDatabase: true, linkedMetadataUnchanged: metadataBefore, allOutputsRetained: true };
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2)); console.log('FVS_MEMORY_REAL_EVIDENCE=' + out);
});
