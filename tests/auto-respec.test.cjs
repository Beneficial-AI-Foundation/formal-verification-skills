const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const f = require('./helpers/respec-fixture.cjs');
let auto, bundle, transitions, api;
before(async () => { auto = await import('../scripts/fvs-auto.mjs'); bundle = await import('../scripts/fvs-auto-bundle.mjs'); transitions = await import('../scripts/fvs-auto-transitions.mjs'); api = await import('../scripts/fvs-auto-respec.mjs'); });
const fixture = () => f.fixture(auto, bundle, transitions, process.env.FVS_RESPEC_QUAL_OUT ?? undefined);
const read = p => JSON.parse(fs.readFileSync(p));
function begin(x) { const q = x.respecRequest(), out = x.output('inspect'), result = api.runRespec({ request: q, out }); return { q, out, result, evidence: { request: result.requestInput, result: result.evidence } }; }
const reject = (code, fn) => assert.throws(fn, e => e.code === code, code);
function mutatePublished(out, change) {
  const file = path.join(out, 'result.json'), r = read(file); change(r); fs.writeFileSync(file, JSON.stringify(r));
  const clockFile = path.join(out, 'result-clock.json'), p = read(clockFile); p.result = f.ref(file); p.status = r.status; fs.writeFileSync(clockFile, JSON.stringify(p));
}
async function failedProducer(patch = {}) {
  const x = await fixture(), initial = begin(x), inputs = read(initial.q.current.resume.request.file).inputs;
  if (patch.emptyStore) { const root = path.join(x.owned, 'empty-accepted-store'); fs.mkdirSync(root); inputs.acceptedStore = { root, expectedHeadSha256: null }; }
  const q = x.request({ inputs }), intent = x.local([], 'check'), target = { request: f.json(x.owned, 'failed-job', {
    schema: 'fvs-checker/check-request', version: 1, purpose: 'auto', runId: 'protocol-failure', deadlineMs: Date.now() + 120000,
    source: q.source, baseline: inputs.baseline, nodes: [19] }), nodes: [19] };
  const view = auto.readState({ projectRoot: x.root, requireAgreement: true }), profile = initial.q.current.profile, authorization = initial.q.current.authorization;
  const snapshot = transitions.transitionSnapshot({ q, run: auto.readRuntimeState({ projectRoot: x.root }).state.run,
    canonical: { view, envelope: view.agreement.agreement }, observation: { identity: { source: { root: x.root, commit: q.source.commit, tree: q.source.expectedTree,
      branchRef: f.git(x.root, 'symbolic-ref', 'HEAD'), gitCommonDir: x.root + '/.git', dirty: false } }, associations: [] },
    action: { before: { registry: { root: x.registry } }, target, authorization, profile, owner: intent.owner, nodes: [] } }, { profileObservation: read(profile.file).controller });
  const action = { schema: 'fvs/auto-transition-request', schemaVersion: 1, runId: x.runId, transitionId: intent.transitionId, reservationId: intent.reservationId,
    kind: 'check', stage: 'check', nodes: [], owner: intent.owner, expectedHeadSha256: q.expectedHeadSha256, before: snapshot, target, authorization, profile, basis: null };
  const actionRef = f.json(x.owned, 'failed-action', action); intent.request = actionRef; q.transition = x.before(intent); const before = x.invoke(q, 'checkpoint');
  const memory = await import('../scripts/fvs-project-memory.mjs'), stdout = f.json(x.owned, 'failed-stdout', { ok: false, status: 'unverified', code: 'timeout', message: 'Protocol-only terminal timeout; no compiler executed' });
  const errFile = path.join(x.owned, 'failure-stderr'); fs.writeFileSync(errFile, 'FVS >> timeout: Protocol-only terminal timeout; no compiler executed\n');
  const now = Date.now(), command = { schema: 'fvs/auto-command-receipt', schemaVersion: 1, runId: x.runId, transitionId: intent.transitionId, actionSha256: memory.memoryHash(action),
    argv: [process.execPath, path.join(f.ROOT, 'scripts/fvs-auto.mjs'), 'check', '--request', target.request.file, '--out', x.output('unused-producer')], cwd: x.root,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' },
    tool: f.ref(process.execPath), startedAtMs: now, endedAtMs: now, exitCode: 8, signal: null, error: null, stdout, stderr: f.ref(errFile) };
  patch.command?.(command); const commandRef = f.json(x.owned, 'failed-command', command);
  if (patch.delta === 'source') f.git(x.root, 'commit', '--allow-empty', '-qm', 'test(fixture): retain failed action source drift');
  if (patch.delta === 'registry') await x.registryFixture.register(x.bundle, 19, { statement: 'True' }, 'revise');
  const afterQ = x.request({ inputs, transition: x.after(before, { sessionId: null, association: null, evidence: [commandRef], resolution: null }, patch.outcome ?? 'failed') });
  const after = x.invoke(afterQ, 'checkpoint');
  const request = { schema: 'fvs/auto-respec-failure-request', schemaVersion: 1, attemptId: f.uuid(), runId: x.runId,
    expectedBeforeEventSha256: before.result.recordedEventSha256, expectedAction: actionRef, expectedCommand: commandRef,
    afterRequest: f.ref(path.join(after.out, 'request.json')), afterResult: f.ref(path.join(after.out, 'result.json')),
    committedHeadSha256: after.result.committedHeadSha256, deadlineMs: Date.now() + 120000 };
  return { x, initial, before, after, request, commandRef, inputs, action, actionRef };
}

describe('conclusive local failures and exact legacy inspect compatibility (protocol only)', () => {
  it('closes execution without tuple progress/permission, consumes exact caller evidence and retains a later valid action', async () => {
    const p = await failedProducer(), { x, request } = p, state = f.ref(path.join(x.root, '.formalising/auto-fv/resume/state.json')), out = x.output('failure-proof');
    assert.equal(auto.readRuntimeState({ projectRoot: x.root }).reservations.get(p.action.reservationId).state, 'closed');
    const v = api.verifyConclusiveLocalFailure({ projectRoot: x.root, request, out }); assert.equal(v.status, 'conclusive-no-canonical-effect'); assert.equal(v.proofAuthority, 'none'); assert.equal(v.effectExecutable, false);
    assert.equal(api.consumeConclusiveLocalFailure({ projectRoot: x.root, request, out }).afterEventSha256, v.afterEventSha256);
    assert.deepEqual(f.ref(state.file), state);
    const composed = x.compose(), q = x.respecRequest('finish', p.initial.evidence), result = api.runRespec({ request: q, out: x.output('after-failure') });
    assert.equal(composed.after.result.observation.transition.admissibility.status, 'facts-recorded-partial'); assert.equal(result.status, 'partial');
    assert.equal(result.observation.history.failures.length, 1); assert.equal(result.observation.history.effects.length, 1); assert.equal(result.observation.history.effects[0].kind, 'compose-spec');
    assert.equal(result.observation.history.failures[0].terminalOutcome, 'failed'); assert.deepEqual(result.frame, p.initial.result.frame);
  });
  for (const field of ['before', 'action', 'command', 'run', 'head']) it('rejects another caller expected ' + field + ' without state writes', async () => {
    const p = await failedProducer(), q = structuredClone(p.request), state = f.ref(path.join(p.x.root, '.formalising/auto-fv/resume/state.json'));
    if (field === 'before') q.expectedBeforeEventSha256 = 'f'.repeat(64);
    if (field === 'action') q.expectedAction = f.json(p.x.owned, 'other-action', { ...p.action, owner: 'other' });
    if (field === 'command') q.expectedCommand = f.json(p.x.owned, 'other-command', { other: true });
    if (field === 'run') q.runId = f.uuid(); if (field === 'head') q.committedHeadSha256 = 'f'.repeat(64);
    assert.throws(() => api.verifyConclusiveLocalFailure({ projectRoot: p.x.root, request: q, out: p.x.output('wrong') })); assert.deepEqual(f.ref(state.file), state);
  });
  for (const delta of ['source', 'registry']) it('refuses a failed action with canonical ' + delta + ' change', async () => {
    const p = await failedProducer({ delta }), state = f.ref(path.join(p.x.root, '.formalising/auto-fv/resume/state.json'));
    reject('respec-failure-unverified', () => api.verifyConclusiveLocalFailure({ projectRoot: p.x.root, request: p.request, out: p.x.output('delta') })); assert.deepEqual(f.ref(state.file), state);
    const q = p.x.respecRequest('finish', p.initial.evidence); assert.throws(() => api.runRespec({ request: q, out: p.x.output('delta-finish') }));
  });
  const commandChanges = { success: c => c.exitCode = 0, stringExit: c => c.exitCode = '8', signal: c => c.signal = 'SIGKILL', error: c => c.error = 'ETIMEDOUT', argv: c => c.argv[2] = 'freeze',
    action: c => c.actionSha256 = 'f'.repeat(64), tool: c => c.tool = c.stdout, environment: c => c.env.EXTRA_PERMISSION = 'yes', start: c => c.startedAtMs = 0, end: c => c.endedAtMs = Date.now() + 60000 };
  commandChanges.environmentType = c => c.env.PATH = { unexpected: true };
  for (const [name, command] of Object.entries(commandChanges)) it('rejects nonconclusive or foreign command ' + name, async () => {
    const p = await failedProducer({ command }), state = f.ref(path.join(p.x.root, '.formalising/auto-fv/resume/state.json'));
    reject('respec-failure-unverified', () => api.verifyConclusiveLocalFailure({ projectRoot: p.x.root, request: p.request, out: p.x.output('bad-command') })); assert.deepEqual(f.ref(state.file), state);
  });
  it('uncertain effects remain held and cannot supply conclusive failure evidence', async () => {
    const p = await failedProducer({ outcome: 'uncertain' }); assert.equal(auto.readRuntimeState({ projectRoot: p.x.root }).reservations.get(p.action.reservationId).state, 'uncertain');
    reject('respec-failure-unverified', () => api.verifyConclusiveLocalFailure({ projectRoot: p.x.root, request: p.request, out: p.x.output('uncertain') }));
  });
  it('validates a complete unchanged empty store without inventing proof authority', async () => {
    const p = await failedProducer({ emptyStore: true }), out = p.x.output('empty-store');
    const v = api.verifyConclusiveLocalFailure({ projectRoot: p.x.root, request: p.request, out });
    assert.equal(v.canonical.store.headSha256, null); assert.equal(v.proofAuthority, 'none');
    assert.deepEqual(fs.readdirSync(p.inputs.acceptedStore.root), []);
  });
  for (const change of ['pending', 'prefix']) it('refuses accepted-store ' + change + ' even without a selected-node delta', async () => {
    const p = await failedProducer({ emptyStore: true }), root = p.inputs.acceptedStore.root;
    if (change === 'pending') fs.mkdirSync(path.join(root, 'lock'));
    else { fs.mkdirSync(path.join(root, 'records')); fs.writeFileSync(path.join(root, 'records', '000000-' + 'f'.repeat(64) + '.json'), '{}'); }
    const state = f.ref(path.join(p.x.root, '.formalising/auto-fv/resume/state.json'));
    assert.throws(() => api.verifyConclusiveLocalFailure({ projectRoot: p.x.root, request: p.request, out: p.x.output('bad-store') }));
    assert.deepEqual(f.ref(state.file), state);
  });
  it('does not authenticate a changed immutable producer/frozen-context input', async () => {
    const p = await failedProducer(), file = p.action.target.request.file, body = read(file), state = f.ref(path.join(p.x.root, '.formalising/auto-fv/resume/state.json'));
    body.baseline = { file: file, sha256: 'f'.repeat(64) }; fs.writeFileSync(file, JSON.stringify(body));
    assert.throws(() => api.verifyConclusiveLocalFailure({ projectRoot: p.x.root, request: p.request, out: p.x.output('changed-baseline') }));
    assert.deepEqual(f.ref(state.file), state);
  });
  it('a failed row itself cannot grant a fresh bound producer successor', async () => {
    const p = await failedProducer(), x = p.x, q = x.request({ inputs: p.inputs }), intent = x.local([], 'check'), action = { ...p.action,
      transitionId: intent.transitionId, reservationId: intent.reservationId, expectedHeadSha256: q.expectedHeadSha256,
      basis: { version: 2, beforeEventSha256: p.before.result.recordedEventSha256, afterEventSha256: p.after.result.recordedEventSha256, completion: p.commandRef, workCompletion: null } };
    intent.request = f.json(x.owned, 'invalid-failure-successor', action); q.transition = x.before(intent);
    const state = f.ref(path.join(x.root, '.formalising/auto-fv/resume/state.json'));
    reject('transition-explanation-required', () => x.invoke(q, 'checkpoint')); assert.deepEqual(f.ref(state.file), state);
  });
  it('another same-content attempt or coherently edited saved closure cannot replace caller evidence', async () => {
    const p = await failedProducer(), out = p.x.output('closure'); api.verifyConclusiveLocalFailure({ projectRoot: p.x.root, request: p.request, out });
    reject('respec-failure-unverified', () => api.consumeConclusiveLocalFailure({ projectRoot: p.x.root, request: { ...p.request, attemptId: f.uuid() }, out }));
    const file = path.join(out, 'result.json'), v = read(file); v.canonical.source.commit = 'f'.repeat(40); fs.writeFileSync(file, JSON.stringify(v));
    reject('respec-failure-unverified', () => api.consumeConclusiveLocalFailure({ projectRoot: p.x.root, request: p.request, out }));
  });
  it('coherently edited closure clock fields cannot overstate a bounded publication', async () => {
    const p = await failedProducer(), out = p.x.output('clock-tamper'); api.verifyConclusiveLocalFailure({ projectRoot: p.x.root, request: p.request, out });
    const file = path.join(out, 'result.json'), v = read(file); v.endedAtMs = p.request.deadlineMs; fs.writeFileSync(file, JSON.stringify(v));
    reject('respec-failure-unverified', () => api.consumeConclusiveLocalFailure({ projectRoot: p.x.root, request: p.request, out }));
  });
  for (const kind of ['inspection', 'run', 'rollback']) it('failure evidence refuses a late publication clock: ' + kind, async () => {
    const p = await failedProducer(), out = p.x.output('late-failure'), realNow = Date.now, open = fs.openSync, fsync = fs.fsyncSync;
    const state = f.ref(path.join(p.x.root, '.formalising/auto-fv/resume/state.json')), run = auto.readRuntimeState({ projectRoot: p.x.root }).state.run;
    let now = realNow(), resultFd; Date.now = () => now;
    fs.openSync = function(file, ...args) { const fd = open.call(fs, file, ...args); if (file === path.join(out, 'result.json')) resultFd = fd; return fd; };
    fs.fsyncSync = function(fd) { const v = fsync.call(fs, fd); if (fd === resultFd) now = kind === 'inspection' ? p.request.deadlineMs + 1 : kind === 'run' ? run.deadlineMs + 1 : now - 60000; return v; };
    try { reject(kind === 'rollback' ? 'respec-clock-rollback' : 'respec-deadline-exhausted', () => api.verifyConclusiveLocalFailure({ projectRoot: p.x.root, request: p.request, out })); }
    finally { Date.now = realNow; fs.openSync = open; fs.fsyncSync = fsync; }
    assert.ok(fs.existsSync(path.join(out, 'failure.json'))); assert.deepEqual(f.ref(state.file), state);
    reject('respec-failure-unverified', () => api.consumeConclusiveLocalFailure({ projectRoot: p.x.root, request: p.request, out }));
  });
  it('accepts only the exact retained old inspect pair for historical inspect and keeps current results current', async () => {
    const x = await fixture(), b = begin(x), old = '6593d0f4f8ef6d0ddc510666644946ce4fc85898a161610fdc2f00d6c121a866';
    mutatePublished(b.out, r => { r.implementation.respec.sha256 = old; }); b.evidence.result = f.ref(path.join(b.out, 'result.json'));
    reject('respec-result-mismatch', () => api.verifyRespecResult({ request: b.q, out: b.out }));
    const q = x.respecRequest('finish', b.evidence), out = x.output('legacy-finish'), result = api.runRespec({ request: q, out });
    assert.equal(result.status, 'partial'); assert.notEqual(result.implementation.respec.sha256, old); assert.equal(api.verifyRespecResult({ request: q, out }).status, 'partial');
  });
  for (const change of ['respec', 'bundle', 'path', 'archive']) it('rejects legacy inspect substitution: ' + change, async () => {
    const x = await fixture(), b = begin(x), old = '6593d0f4f8ef6d0ddc510666644946ce4fc85898a161610fdc2f00d6c121a866';
    mutatePublished(b.out, r => { r.implementation.respec.sha256 = old; if (change === 'respec') r.implementation.respec.sha256 = 'f'.repeat(64); if (change === 'bundle') r.implementation.bundle.sha256 = 'f'.repeat(64); if (change === 'path') r.implementation.respec.file = r.implementation.bundle.file; });
    b.evidence.result = f.ref(path.join(b.out, 'result.json')); const q = x.respecRequest('finish', b.evidence), open = fs.openSync, readFile = fs.readFileSync; let archiveFd;
    if (change === 'archive') { fs.openSync = function(file, ...args) { const fd = open.call(fs, file, ...args); if (file.endsWith?.('auto-respec-inspect-v1-6593d0f4.source.txt')) archiveFd = fd; return fd; }; fs.readFileSync = function(file, ...args) { const value = readFile.call(fs, file, ...args); return file === archiveFd ? Buffer.concat([value, Buffer.from('changed')]) : value; }; }
    try { reject('respec-inspect-mismatch', () => api.runRespec({ request: q, out: x.output('bad-legacy') })); } finally { fs.openSync = open; fs.readFileSync = readFile; }
  });
});

describe('same-pipeline feedback currentness (protocol only)', () => {
  it('captures full scope and independently consumes the actual caller16/20 requests', async () => {
    const x = await fixture(), b = begin(x), before = f.ref(path.join(x.root, '.formalising/auto-fv/resume/state.json'));
    assert.equal(b.result.status, 'revision-proposed'); assert.equal(b.result.effectExecutable, false); assert.equal(b.result.humanReview, 'pending');
    assert.deepEqual(Object.keys(b.result.observation.history).sort(), ['effects', 'gitEvidence', 'promotions'], 'inspect-v1 historical contract stays unchanged');
    assert.deepEqual(b.result.frame.scope.requestedRoots, [20, 21]); assert.deepEqual(b.result.observation.nodes.map(n => n.node), [19, 20, 21]);
    assert.equal(b.result.implementation.respec.file, path.join(f.ROOT, 'scripts/fvs-auto-respec.mjs')); assert.equal(b.result.implementation.respec.sha256, f.ref(b.result.implementation.respec.file).sha256);
    assert.ok(path.isAbsolute(b.result.observation.memoryEvidence.prime.file)); assert.ok(b.result.observation.memoryEvidence.receipts.every(r => path.isAbsolute(r.stdout.file) && path.isAbsolute(r.receipt.file)));
    const v = api.verifyRespecResult({ request: b.q, out: b.out }); assert.equal(v.status, 'revision-proposed'); assert.deepEqual(f.ref(before.file), before);
    assert.ok(v.observation.reasons.includes('whole-scope-currentness-unverified')); assert.ok(v.observation.nodes.every(n => n.proof === 'unverified'));
  });
  it('finishes partial while an original requested item has no response', async () => {
    const x = await fixture(), b = begin(x), q = x.respecRequest('finish', b.evidence); q.requestedItems[0].response = x.response(q, q.requestedItems[0]);
    const out = x.output('finish'), r = api.runRespec({ request: q, out }); assert.equal(r.status, 'partial');
    assert.equal(r.observation.items[0].status, 'response-prepared'); assert.equal(r.observation.items[1].status, 'pending');
    assert.equal(api.verifyRespecResult({ request: q, out }).status, 'partial');
  });
  it('declared correspondence cannot turn protocol/provisional evidence into current proof', async () => {
    const x = await fixture(), b = begin(x), q = x.respecRequest('finish', b.evidence); q.requestedItems.forEach(i => { i.response = x.response(q, i); });
    const r = api.runRespec({ request: q, out: x.output('responses') }); assert.equal(r.status, 'partial'); assert.ok(r.observation.items.every(i => i.status === 'response-prepared'));
    assert.ok(r.observation.reasons.includes('whole-scope-currentness-unverified'));
  });
  it('two unchanged-content resumes require their own attempt/result', async () => {
    const x = await fixture(), b = begin(x), second = x.respecRequest();
    reject('respec-result-mismatch', () => api.verifyRespecResult({ request: second, out: b.out }));
    const out = x.output('second'); api.runRespec({ request: second, out }); assert.equal(api.verifyRespecResult({ request: second, out }).status, 'revision-proposed');
  });
  for (const field of ['revisionId', 'ownerFeedback', 'requestedItems', 'priorBundle']) it('cannot change pinned ' + field + ' at finish', async () => {
    const x = await fixture(), b = begin(x), q = x.respecRequest('finish', b.evidence);
    if (field === 'revisionId') q.revisionId = f.uuid();
    if (field === 'ownerFeedback') q.ownerFeedback.ownerReference = 'different-owner-reference';
    if (field === 'requestedItems') q.requestedItems = q.requestedItems.slice(0, 1);
    if (field === 'priorBundle') q.priorBundle.expectedContext.agreement.choicesGeneration += 2;
    assert.throws(() => api.runRespec({ request: q, out: x.output('wrong-frame') }));
  });
  for (const kind of ['attempt', 'phase', 'memory', 'head', 'source']) it('rejects wrong current ' + kind + ' before backend consumption', async () => {
    const x = await fixture(), q = x.respecRequest(), before = fs.readFileSync(x.log), bdLog = path.join(x.root, '.fixture-bd-calls.jsonl'), dbBefore = fs.readFileSync(bdLog);
    if (kind === 'attempt') q.attemptId = f.uuid();
    if (kind === 'phase') { const r = read(q.current.resume.request.file); r.phase = 'start'; r.resumeId = null; q.current.resume.request = f.json(x.owned, 'wrong-phase', r); }
    if (kind === 'memory') { const r = read(q.current.memory.request.file); r.attemptId = f.uuid(); q.current.memory.request = f.json(x.owned, 'wrong-memory', r); }
    if (kind === 'head') q.current.resume.committedHeadSha256 = 'f'.repeat(64);
    if (kind === 'source') q.current.bundle.source.commit = 'f'.repeat(40);
    const out = x.output('bad-current'); reject('respec-current-request-mismatch', () => api.runRespec({ request: q, out }));
    assert.equal(fs.existsSync(out), false); assert.deepEqual(fs.readFileSync(x.log), before); assert.deepEqual(fs.readFileSync(bdLog), dbBefore);
  });
  it('refuses mismatched response feedback/current contract instead of clearing pending', async () => {
    const x = await fixture(), b = begin(x), q = x.respecRequest('finish', b.evidence), r = read(x.response(q, q.requestedItems[0]).file); r.ownerFeedbackSha256 = 'a'.repeat(64);
    q.requestedItems[0].response = f.json(x.owned, 'foreign-response', r); reject('respec-response-mismatch', () => api.runRespec({ request: q, out: x.output('foreign-response') }));
  });
  it('a coherent saved ready label cannot bypass whole-scope fresh proof checks', async () => {
    const x = await fixture(), b = begin(x), q = x.respecRequest('finish', b.evidence), out = x.output('fake-ready'); api.runRespec({ request: q, out });
    mutatePublished(out, result => { result.status = 'ready-for-final-human-review'; result.observation.reasons = []; });
    reject('respec-context-stale', () => api.verifyRespecResult({ request: q, out }));
  });
  it('omitted or tampered current consumer receipts do not pass independent verification', async () => {
    const x = await fixture(), b = begin(x); mutatePublished(b.out, r => { r.observation.currentConsumer.receipts = []; });
    reject('respec-evidence-invalid', () => api.verifyRespecResult({ request: b.q, out: b.out }));
  });
  it('retains raw AO evidence without treating irrelevant output metadata as semantic drift', async () => {
    const x = await fixture(), b = begin(x); x.rows[0].debugRevision = 'unrelated metadata'; x.writeControl();
    assert.equal(api.verifyRespecResult({ request: b.q, out: b.out }).status, 'revision-proposed');
  });
  it('rejects hidden/non-JSON hooks without executing them', async () => {
    const x = await fixture(), q = x.respecRequest(); let calls = 0; Object.defineProperty(q.ownerFeedback, 'toJSON', { value() { calls++; return {}; } });
    assert.throws(() => api.runRespec({ request: q, out: x.output('hook') })); assert.equal(calls, 0);
    const opts = {}; Object.defineProperty(opts, 'request', { get() { calls++; return q; } }); assert.throws(() => api.runRespec(opts)); assert.equal(calls, 0);
  });
  it('protects canonical source and old bundle outputs before any backend activity', async () => {
    const x = await fixture(), q = x.respecRequest(), before = fs.readFileSync(x.log);
    reject('respec-output-protected', () => api.runRespec({ request: q, out: path.join(x.root, 'must-not-exist') }));
    reject('respec-output-protected', () => api.runRespec({ request: q, out: path.join(path.dirname(q.priorBundle.manifest.file), 'must-not-exist') })); assert.deepEqual(fs.readFileSync(x.log), before);
  });
  it('CLI rejects duplicate JSON and wrong operation before output', async () => {
    const x = await fixture(), q = x.respecRequest(), p = path.join(x.owned, 'duplicate.json'); fs.writeFileSync(p, '{"schema":1,"schema":2}');
    const script = path.join(f.ROOT, 'scripts/fvs-auto-respec.mjs'), out = x.output('duplicate');
    const bad = spawnSync(process.execPath, [script, 'inspect', '--request', p, '--out', out], { encoding: 'utf8' }); assert.equal(bad.status, 7); assert.match(bad.stdout, /duplicate keys/); assert.equal(fs.existsSync(out), false);
    const r = f.json(x.owned, 'cli-q', q), wrong = spawnSync(process.execPath, [script, 'finish', '--request', r.file, '--out', out], { encoding: 'utf8' }); assert.equal(wrong.status, 7); assert.match(wrong.stdout, /operation differs/);
  });
  it('CLI inspect/verify preserve partial facts and do not dispatch', async () => {
    const x = await fixture(), q = x.respecRequest(), p = f.json(x.owned, 'cli-q', q), out = x.output('cli'), script = path.join(f.ROOT, 'scripts/fvs-auto-respec.mjs');
    for (const operation of ['inspect', 'verify']) {
      const r = spawnSync(process.execPath, [script, operation, '--request', p.file, '--out', out], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stdout + r.stderr); const body = JSON.parse(r.stdout); assert.equal(body.status, 'revision-proposed'); assert.equal(body.effectExecutable, false);
    }
  });
  it('ordinary status logs preserve the initial semantic agreement/feedback frame', async () => {
    const x = await fixture(), b = begin(x), oldRoadmap = x.bundle.agreement.roadmap;
    fs.appendFileSync(f.roadmapFile(x.root), '\n## Progress\nOrdinary status only.\n');
    x.bundle.agreement.roadmap = f.ref(f.roadmapFile(x.root));
    const inventory = read(x.bundle.scopeInventory.file); inventory.agreement = x.bundle.agreement;
    inventory.applicability[0].evidence = [{ file: path.join(path.dirname(b.q.priorBundle.manifest.file), 'evidence', oldRoadmap.sha256), sha256: oldRoadmap.sha256 }];
    x.bundle.scopeInventory = f.json(x.owned, 'current-scope', inventory);
    const q = x.respecRequest('finish', b.evidence), out = x.output('status-only'), result = api.runRespec({ request: q, out });
    assert.equal(result.status, 'partial'); assert.equal(result.frame.agreement.contextSha256, b.result.frame.agreement.contextSha256);
    assert.equal(api.verifyRespecResult({ request: q, out }).status, 'partial');
  });
  it('a real source advance without a paired22 completion cannot finish', async () => {
    const x = await fixture(), b = begin(x); f.git(x.root, 'commit', '--allow-empty', '-qm', 'test(fixture): retain unpaired source advance');
    const q = x.respecRequest('finish', b.evidence); reject('respec-history-mismatch', () => api.runRespec({ request: q, out: x.output('unpaired-source') }));
  });
  it('a genuine paired22 source composition is retained without claiming proof readiness', async () => {
    const x = await fixture(), b = begin(x), composed = x.compose(), q = x.respecRequest('finish', b.evidence), out = x.output('paired-source');
    assert.equal(composed.after.result.observation.transition.admissibility.status, 'facts-recorded-partial');
    const result = api.runRespec({ request: q, out }); assert.equal(result.status, 'partial'); assert.equal(result.observation.history.effects.length, 1);
    assert.equal(result.observation.history.effects[0].kind, 'compose-spec'); assert.ok(result.observation.history.gitEvidence.length > 0);
    assert.equal(api.verifyRespecResult({ request: q, out }).status, 'partial');
  });
  it('a registry semantic ABA cannot resurrect an earlier feedback approval', async () => {
    const x = await fixture(), b = begin(x); const first = await x.registryFixture.register(x.bundle, 19, { statement: 'True' }, 'revise');
    const last = await x.registryFixture.register(x.bundle, 19, {}, 'revise'); assert.notEqual(first.recordSha256, last.recordSha256);
    x.bundle.registry.expectedHeadSha256 = last.recordSha256;
    const q = x.respecRequest('finish', b.evidence); reject('respec-history-mismatch', () => api.runRespec({ request: q, out: x.output('unpaired-ABA') }));
  });
  it('a publication-fence registry race preserves old results/runtime and refuses a new result', async () => {
    const x = await fixture(), q = x.respecRequest(), before = f.ref(path.join(x.root, '.formalising/auto-fv/resume/state.json')), out = x.output('fence-race'), mkdir = fs.mkdirSync;
    fs.mkdirSync = function(p, ...rest) { const v = mkdir.call(fs, p, ...rest); if (p === out) mkdir.call(fs, path.join(x.registry, 'lock')); return v; };
    try { reject('respec-context-stale', () => api.runRespec({ request: q, out })); } finally { fs.mkdirSync = mkdir; }
    assert.ok(fs.existsSync(path.join(x.registry, 'lock'))); assert.equal(fs.existsSync(path.join(out, 'result.json')), false); assert.deepEqual(f.ref(before.file), before);
  });
  it('expired original accounting is partial and never starts another current consumer', async () => {
    const x = await fixture(), q = x.respecRequest(), runtime = auto.readRuntimeState({ projectRoot: x.root }), clock = runtime.state.run.deadlineMs + 1, now = Date.now;
    q.deadlineMs = clock + 60000; q.current.bundle.deadlineMs = q.deadlineMs;
    const log = fs.readFileSync(x.log), state = f.ref(path.join(x.root, '.formalising/auto-fv/resume/state.json'));
    Date.now = () => clock;
    try {
      const result = api.runRespec({ request: q, out: x.output('expired') }); assert.equal(result.status, 'partial'); assert.ok(result.observation.reasons.includes('original-limit-exhausted'));
      assert.equal(result.frame.run.startedAtMs, runtime.state.run.startedAtMs); assert.equal(result.frame.run.deadlineMs, runtime.state.run.deadlineMs);
    } finally { Date.now = now; }
    assert.deepEqual(fs.readFileSync(x.log), log); assert.deepEqual(f.ref(state.file), state);
  });
  it('clock rollback after setup refuses before backend consumption', async () => {
    const x = await fixture(), q = x.respecRequest(), out = x.output('rollback'), now = Date.now, mkdir = fs.mkdirSync, last = auto.readRuntimeState({ projectRoot: x.root }).lastObservedAtMs;
    const log = fs.readFileSync(x.log);
    fs.mkdirSync = function(p, ...rest) { const v = mkdir.call(fs, p, ...rest); if (p === out) Date.now = () => last - 1; return v; };
    try { reject('respec-clock-rollback', () => api.runRespec({ request: q, out })); } finally { Date.now = now; fs.mkdirSync = mkdir; }
    assert.equal(fs.existsSync(path.join(out, 'result.json')), false); assert.deepEqual(fs.readFileSync(x.log), log);
  });
  for (const kind of ['selected', 'unmapped', 'mixed']) it('retains ' + kind + ' unestablished feedback without invented hashes', async () => {
    const x = await fixture(), q = x.respecRequest();
    const unknown = node => ({ itemId: 'unestablished-' + node, nodes: [node], expectedRecords: [{ node, unestablished: node === 21 ? 'selected root has no registered contract' : 'no supported mapping/record' }], feedback: 'requested item must remain visible', evidence: [q.ownerFeedback.evidence], response: null });
    q.requestedItems = kind === 'selected' ? [unknown(21)] : kind === 'unmapped' ? [unknown(999)] : [...q.requestedItems, unknown(21), unknown(999)];
    const out = x.output('unknown'), r = api.runRespec({ request: q, out }); assert.equal(r.status, 'partial'); assert.equal(r.effectExecutable, false);
    assert.deepEqual(r.frame.requestedItems.map(i => i.itemId), q.requestedItems.map(i => i.itemId));
    for (const id of kind === 'selected' ? [21] : kind === 'unmapped' ? [999] : [21, 999]) { assert.ok(r.observation.nodes.some(n => n.node === id)); assert.ok(r.observation.reasons.includes('requested-version-unestablished:' + id)); }
    assert.equal(api.verifyRespecResult({ request: q, out }).status, 'partial');
  });
  it('a response cannot clear an originally unestablished version', async () => {
    const x = await fixture(), q = x.respecRequest(); q.requestedItems.push({ itemId: 'missing-B', nodes: [21], expectedRecords: [{ node: 21, unestablished: 'no14 record' }], feedback: 'keep B', evidence: [q.ownerFeedback.evidence], response: null });
    const initial = api.runRespec({ request: q, out: x.output('unknown-inspect') }), next = x.respecRequest('finish', { request: initial.requestInput, result: initial.evidence });
    next.requestedItems = structuredClone(q.requestedItems); next.requestedItems.forEach(i => { i.response = f.json(x.owned, 'claimed-response', { claimed: 'done', node: i.nodes[0] }); });
    // Known responses remain valid workflow declarations; unknown B cannot be upgraded.
    next.requestedItems.slice(0, 2).forEach(i => { i.response = x.response(next, i); });
    const r = api.runRespec({ request: next, out: x.output('unknown-finish') }); assert.equal(r.status, 'partial'); assert.equal(r.observation.items.at(-1).reason, 'requested-version-unestablished');
  });
  it('incorrect known versions still refuse and cannot become unestablished flags', async () => {
    const x = await fixture(), q = x.respecRequest(); q.requestedItems[0].expectedRecords[0].recordSha256 = 'f'.repeat(64);
    reject('respec-request-stale', () => api.runRespec({ request: q, out: x.output('known-stale') }));
    q.requestedItems[0].expectedRecords = [{ node: 19, unestablished: 'caller says missing' }];
    reject('respec-request-stale', () => api.runRespec({ request: q, out: x.output('known-hidden') }));
  });
  for (const consumer of [false, true]) for (const crossing of ['run', 'inspection', 'rollback']) it((consumer ? 'consumer' : 'producer') + ' clocks after the last fence: ' + crossing, async () => {
    const x = await fixture(), realNow = Date.now, open = fs.openSync, mkdir = fs.mkdirSync;
    const run = auto.readRuntimeState({ projectRoot: x.root }).state.run; let now = crossing === 'run' ? run.deadlineMs - 60000 : realNow(); const start = now;
    Date.now = () => now;
    try {
      const q = x.respecRequest(), out = x.output('last-fence'), before = f.ref(path.join(x.root, '.formalising/auto-fv/resume/state.json'));
      if (consumer) api.runRespec({ request: q, out });
      let active = !consumer, reads = 0;
      fs.mkdirSync = function(file, ...rest) { const value = mkdir.call(fs, file, ...rest); if (consumer && path.basename(file).startsWith('fvs-respec-consume-')) active = true; return value; };
      fs.openSync = function(file, ...rest) {
        const fd = open.call(fs, file, ...rest);
        if (active && file === q.ownerFeedback.evidence.file && (consumer || fs.existsSync(out)) && ++reads === 2) now = crossing === 'run' ? run.deadlineMs + 1 : crossing === 'inspection' ? q.deadlineMs + 1 : start - 1;
        return fd;
      };
      const action = () => consumer ? api.verifyRespecResult({ request: q, out }) : api.runRespec({ request: q, out });
      if (crossing === 'run' && !consumer) { const r = action(); assert.equal(r.status, 'partial'); assert.ok(r.observation.reasons.includes('original-limit-exhausted')); assert.ok(r.observation.endedAtMs >= run.deadlineMs); }
      else reject(crossing === 'run' ? 'respec-context-stale' : crossing === 'inspection' ? 'respec-deadline-exhausted' : 'respec-clock-rollback', action);
      assert.equal(reads, 2); assert.deepEqual(f.ref(before.file), before);
    } finally { Date.now = realNow; fs.openSync = open; fs.mkdirSync = mkdir; }
  });
  it('late durable result output stays failed/unverified rather than returning ready/proposed', async () => {
    const x = await fixture(), realNow = Date.now, run = auto.readRuntimeState({ projectRoot: x.root }).state.run; let now = run.deadlineMs - 60000;
    Date.now = () => now;
    try {
      const q = x.respecRequest(), out = x.output('late-write'), fsync = fs.fsyncSync, open = fs.openSync; let resultFd;
      fs.openSync = function(file, ...rest) { const fd = open.call(fs, file, ...rest); if (file === path.join(out, 'result.json')) resultFd = fd; return fd; };
      fs.fsyncSync = function(fd) { const result = fsync.call(fs, fd); if (fd === resultFd) now = run.deadlineMs + 1; return result; };
      try { reject('respec-publication-stale', () => api.runRespec({ request: q, out })); }
      finally { fs.fsyncSync = fsync; fs.openSync = open; }
      assert.ok(fs.existsSync(path.join(out, 'failure.json'))); reject('respec-result-mismatch', () => api.verifyRespecResult({ request: q, out }));
    } finally { Date.now = realNow; }
  });
});
