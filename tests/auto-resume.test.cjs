const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync, spawn } = require('node:child_process');
const f = require('./helpers/resume-fixture.cjs');
let auto, resume; const owned = [];
before(async () => { auto = await import(pathToFileURL(path.join(f.ROOT, 'scripts/fvs-auto.mjs')).href); resume = await import(pathToFileURL(path.join(f.ROOT, 'scripts/fvs-auto-resume.mjs')).href); });
after(() => { for (const p of owned) fs.rmSync(p, { recursive: true, force: true }); });
const make = () => { const x = f.fixture(auto); owned.push(x.owned); return x; };
const file = (x) => path.join(x.root, '.formalising/auto-fv/resume/state.json');
const stateBytes = (x) => fs.existsSync(file(x)) ? fs.readFileSync(file(x)) : null;
function refuses(code, fn) { assert.throws(fn, (e) => e.code === code, code); }
function verify(x, y) { return auto.verifyReconciliation({ projectRoot: x.root, request: y.q, out: y.out }); }
function services(x, overrides = {}) {
  return { loadCanonical() { const view = auto.readState({ projectRoot: x.root, requireAgreement: true }); return { view, envelope: { mode: view.agreement.agreement.mode } }; },
    refreshMemory: auto.refreshMemory, verifyMemory: auto.verifyMemoryBootstrap,
    inspectAcceptance() { throw new Error('not used by this protocol fixture'); }, ...overrides };
}

describe('runtime checkpoint/current reconciliation', () => {
  it('new observation commits paired history, consumes fresh prime, and validates its own committed head', () => {
    const x = make(), original = fs.readFileSync(f.stateFile(x.root)), y = x.invoke();
    assert.equal(y.result.code, 'reconciled'); assert.equal(y.result.expectedPredecessorHeadSha256, null); assert.equal(verify(x, y).code, 'reconciled');
    assert.notEqual(y.result.committedHeadSha256, y.result.expectedPredecessorHeadSha256);
    assert.equal(auto.readRuntimeState({ projectRoot: x.root }).state.history.length, 2);
    assert.deepEqual(fs.readFileSync(f.stateFile(x.root)), original); assert.equal(y.result.observation.acceptance.acceptedBaseline, null);
    assert.equal(y.result.effectExecutable, false);
  });
  it('two unchanged resumes have distinct request/result identity and stale old results cannot substitute', () => {
    const x = make(), first = x.invoke(), second = x.invoke();
    assert.equal(second.result.code, 'reconciled'); assert.equal(verify(x, second).code, 'reconciled');
    refuses('resume-head-stale', () => verify(x, first));
    refuses('resume-result-mismatch', () => auto.verifyReconciliation({ projectRoot: x.root, request: second.q, out: first.out }));
    assert.notEqual(first.q.attemptId, second.q.attemptId); assert.notEqual(first.q.resumeId, second.q.resumeId);
  });
  it('reads legacy M1 without writes or a fabricated execution clock', () => {
    const x = make(), b = fs.readFileSync(f.stateFile(x.root));
    assert.equal(auto.readRuntimeState({ projectRoot: x.root }).state, null); auto.readState({ projectRoot: x.root });
    assert.equal(fs.existsSync(file(x)), false); assert.deepEqual(fs.readFileSync(f.stateFile(x.root)), b);
  });
  for (const status of ['failed', 'succeeded']) {
    it('legacy ' + status + ' extraction cannot silently acquire a fresh clock with no live worker', () => {
      const x = make(), s = JSON.parse(fs.readFileSync(f.stateFile(x.root)));
      s.extraction = { status, recordedAt: 'legacy fixture execution', selected: s.choices.source,
        reasons: status === 'failed' ? ['recorded synthetic failure'] : [], declared: { buildExitCode: status === 'failed' ? 1 : 0, oracle: status === 'failed' ? 'refused' : 'complete' },
        checks: Object.fromEntries(['status', 'verify-tree', 'verify-restore'].map((k) => [k, { ok: status === 'succeeded' }])),
        inputs: status === 'failed' ? null : { out: x.owned, manifestSha256: 'a'.repeat(64), crateRoot: x.root, mode: 'translation-patches', sourceCommit: f.git(x.root, 'rev-parse', 'HEAD'), patches: [] },
        note: 'Protocol legacy execution pointer; not a genuine extraction claim.' };
      fs.writeFileSync(f.stateFile(x.root), JSON.stringify(s)); const before = fs.readFileSync(f.stateFile(x.root));
      const y = x.invoke(); assert.equal(y.result.code, 'partial'); assert.ok(y.result.observation.reasons.includes('prior-accounting-unknown'));
      assert.equal(stateBytes(x), null); assert.deepEqual(fs.readFileSync(f.stateFile(x.root)), before);
      const accounting = x.accounting(), original = JSON.parse(fs.readFileSync(accounting.file));
      const recovered = x.invoke(x.request({ priorAccounting: accounting }));
      assert.equal(recovered.result.code, 'reconciled');
      const run = auto.readRuntimeState({ projectRoot: x.root }).state.run;
      assert.equal(run.startedAtMs, original.startedAtMs); assert.equal(run.deadlineMs, Math.floor(original.startedAtMs + original.limits.wallClockHours * 3600000));
      assert.deepEqual(fs.readFileSync(f.stateFile(x.root)), before);
    });
  }
  it('pre-acceptance stage evidence of unknown run relation cannot imply zero earlier execution', () => {
    for (const stage of ['extraction', 'graph', 'plan', 'baseline']) {
      const x = make(), q = x.request(); q.inputs[stage] = f.json(x.owned, 'earlier-stage', { scope: 'protocol earlier-stage pointer, not genuine proof evidence' });
      const y = x.invoke(q); assert.equal(y.result.code, 'partial'); assert.ok(y.result.observation.reasons.includes('prior-accounting-unknown')); assert.equal(stateBytes(x), null);
    }
  });
  it('a checkpoint and process restart preserve the original start/deadline and inactive nodeHours', () => {
    const x = make(), a = x.invoke(), prior = auto.readRuntimeState({ projectRoot: x.root }).state.run;
    const q = x.request(), input = f.json(x.owned, 'request', q), out = x.out();
    const p = spawnSync(process.execPath, [path.join(f.ROOT, 'scripts/fvs-auto.mjs'), 'state', '--project-root', x.root, '--request', input.file, '--out', out], { encoding: 'utf8' });
    assert.equal(p.status, 0, p.stderr); assert.equal(JSON.parse(p.stdout).code, 'reconciled');
    const current = auto.readRuntimeState({ projectRoot: x.root }).state.run;
    assert.deepEqual(current, prior); assert.equal(current.limits.nodeHours, 2); assert.equal(current.deadlineMs - current.startedAtMs, 40 * 3600000);
    assert.equal(a.result.observation.identity.primary.commit, current ? q.source.commit : null);
  });
  it('absolute exhaustion is resumable partial, never resets start or silently reduces scope', () => {
    const x = make(); x.invoke(); const prior = auto.readRuntimeState({ projectRoot: x.root }).state.run;
    const q = x.request(), out = x.out();
    const result = resume.runResume('state', { projectRoot: x.root, request: q, out }, services(x, { now: () => prior.deadlineMs + 1 }));
    assert.equal(result.code, 'partial'); assert.ok(result.observation.reasons.includes('original-limit-exhausted'));
    assert.deepEqual(auto.readRuntimeState({ projectRoot: x.root }).state.run, prior);
    const intent = x.launch(), next = x.request({ transition: x.before(intent) }), before = stateBytes(x);
    refuses('resume-partial', () => resume.runResume('checkpoint', { projectRoot: x.root, request: next, out: x.out() }, services(x, { now: () => prior.deadlineMs + 2 })));
    assert.deepEqual(stateBytes(x), before);
  });
  it('clock rollback, stale canonical context, stale predecessor and changed observation refuse without overwriting history', () => {
    const x = make(); x.invoke(); const runtime = auto.readRuntimeState({ projectRoot: x.root }), b = stateBytes(x);
    refuses('resume-clock-rollback', () => resume.runResume('state', { projectRoot: x.root, request: x.request(), out: x.out() }, services(x, { now: () => runtime.lastObservedAtMs - 1 })));
    refuses('resume-head-stale', () => x.invoke(x.request({ expectedHeadSha256: null })));
    const q = x.request(); q.source.expectedTree = '0'.repeat(40);
    assert.equal(x.invoke(q).result.code, 'partial');
    assert.deepEqual(auto.readRuntimeState({ projectRoot: x.root }).state.run, runtime.state.run);
    assert.ok(b.length > 0);
  });
  it('API hooks and duplicate CLI keys reject before backend/output allocation', () => {
    const x = make(); let invoked = 0; const q = x.request(), out = x.out();
    Object.defineProperty(q, 'toJSON', { value() { invoked++; return {}; } });
    refuses('invalid-input', () => x.invoke(q, 'state', out)); assert.equal(invoked, 0); assert.equal(fs.existsSync(out), false); assert.equal(f.calls(x.root).filter((c) => c.cmd === 'remember').length, 0);
    const hiddenRoot = {}; Object.defineProperty(hiddenRoot, 'projectRoot', { enumerable: true, get() { invoked++; return x.root; } });
    refuses('invalid-input', () => auto.readRuntimeState(hiddenRoot)); assert.equal(invoked, 0);
    const input = path.join(x.owned, 'duplicate.json'); fs.writeFileSync(input, '{"schema":1,"schema":2}');
    const p = spawnSync(process.execPath, [path.join(f.ROOT, 'scripts/fvs-auto.mjs'), 'state', '--project-root', x.root, '--request', input, '--out', x.out()], { encoding: 'utf8' });
    assert.equal(p.status, 1); assert.equal(JSON.parse(p.stdout).code, 'resume-invalid-input');
  });
  it('the final publication fence records its end time and cannot publish a new intent after the cap', () => {
    const x = make(); x.invoke(); const view = auto.readRuntimeState({ projectRoot: x.root }), run = view.state.run, b = stateBytes(x);
    const before = x.request({ transition: x.before(x.launch()) });
    let times = [view.lastObservedAtMs + 1, view.lastObservedAtMs + 2, run.deadlineMs + 1];
    refuses('resume-partial', () => resume.runResume('checkpoint', { projectRoot: x.root, request: before, out: x.out() }, services(x, { now: () => times.shift() })));
    assert.deepEqual(stateBytes(x), b);
    times = [view.lastObservedAtMs + 1, view.lastObservedAtMs + 2, run.deadlineMs + 1];
    const result = resume.runResume('state', { projectRoot: x.root, request: x.request(), out: x.out() }, services(x, { now: () => times.shift() }));
    const current = auto.readRuntimeState({ projectRoot: x.root });
    assert.equal(result.code, 'partial'); assert.ok(result.observation.reasons.includes('original-limit-exhausted'));
    assert.equal(current.lastObservedAtMs, run.deadlineMs + 1); assert.deepEqual(current.state.run, run);
    assert.deepEqual(current.state.history.slice(0, view.state.history.length), view.state.history);
  });
  it('clock rollback inside the final fence leaves the prior complete runtime unchanged', () => {
    const x = make(); x.invoke(); const v = auto.readRuntimeState({ projectRoot: x.root }), b = stateBytes(x);
    for (const times of [[v.lastObservedAtMs + 10, v.lastObservedAtMs + 11, v.lastObservedAtMs + 9], [v.lastObservedAtMs + 10, v.lastObservedAtMs + 9, v.lastObservedAtMs + 11]]) {
      refuses('resume-clock-rollback', () => resume.runResume('state', { projectRoot: x.root, request: x.request(), out: x.out() }, services(x, { now: () => times.shift() })));
      assert.deepEqual(stateBytes(x), b);
    }
  });
  it('consumer end fence catches cap expiry/rollback after observations, preserving the checkpoint', () => {
    const x = make(), y = x.invoke(), current = auto.readRuntimeState({ projectRoot: x.root }), before = stateBytes(x);
    for (const [end, code] of [[current.state.run.deadlineMs + 1, 'resume-partial'], [current.lastObservedAtMs + 9, 'resume-clock-rollback']]) {
      const times = [current.lastObservedAtMs + 10, end];
      refuses(code, () => resume.consumeResume({ projectRoot: x.root, request: y.q, out: y.out }, services(x, { now: () => times.shift() })));
      assert.deepEqual(stateBytes(x), before);
    }
    assert.equal(resume.consumeResume({ projectRoot: x.root, request: y.q, out: y.out }, services(x, { now: () => current.lastObservedAtMs + 1 })).code, 'reconciled');
  });
  it('exhaustion checkpoints partial with unverified acceptance instead of demanding an expired inspection', () => {
    const x = make(); x.invoke(); const original = auto.readRuntimeState({ projectRoot: x.root }).state.run, q = x.request();
    q.inputs.acceptedStore = { root: path.join(x.owned, 'empty-store'), expectedHeadSha256: null }; let inspected = 0;
    const result = resume.runResume('state', { projectRoot: x.root, request: q, out: x.out() }, services(x, { now: () => original.deadlineMs + 1, inspectAcceptance() { inspected++; throw Object.assign(new Error('expired'), { code: 'timeout' }); } }));
    assert.equal(result.code, 'partial'); assert.equal(result.observation.acceptance.status, 'unverified'); assert.equal(result.observation.acceptance.acceptedBaseline, null);
    assert.equal(inspected, 0); assert.deepEqual(auto.readRuntimeState({ projectRoot: x.root }).state.run, original);
  });
  it('inspection crossing the cap commits the same semantic partial while retaining both raw diagnostics', () => {
    const x = make(); x.invoke(); const original = auto.readRuntimeState({ projectRoot: x.root }), q = x.request(), out = x.out();
    q.inputs.acceptedStore = { root: path.join(x.owned, 'store'), expectedHeadSha256: null };
    let now = original.lastObservedAtMs + 1, inspected = 0;
    const result = resume.runResume('state', { projectRoot: x.root, request: q, out }, services(x, { now: () => now, inspectAcceptance() {
      inspected++; now = original.state.run.deadlineMs + 1; throw Object.assign(new Error('retained inspector deadline diagnostic'), { code: 'timeout' });
    } }));
    assert.equal(inspected, 1); assert.equal(result.code, 'partial'); assert.equal(result.observation.acceptance.status, 'unverified');
    assert.equal(result.observation.acceptance.acceptedBaseline, null); assert.equal(result.observation.acceptance.reason, 'original-limit-exhausted');
    assert.deepEqual(result.observation.acceptance.diagnostic, { code: 'timeout', message: 'retained inspector deadline diagnostic' });
    const fence = JSON.parse(fs.readFileSync(path.join(out, 'fence/observation.json')));
    assert.equal(fence.acceptance.diagnostic.code, 'original-limit-exhausted'); assert.ok(result.observation.reasons.includes('original-limit-exhausted'));
    const current = auto.readRuntimeState({ projectRoot: x.root }); assert.deepEqual(current.state.run, original.state.run);
    assert.deepEqual(current.state.history.slice(0, original.state.history.length), original.state.history);
  });
  it('budget diagnostic normalization cannot hide actual source/context drift', () => {
    const x = make(); x.invoke(); const original = auto.readRuntimeState({ projectRoot: x.root }), before = stateBytes(x), q = x.request();
    q.inputs.acceptedStore = { root: path.join(x.owned, 'store'), expectedHeadSha256: null }; let now = original.lastObservedAtMs + 1;
    refuses('resume-context-stale', () => resume.runResume('state', { projectRoot: x.root, request: q, out: x.out() }, services(x, { now: () => now, inspectAcceptance() {
      fs.appendFileSync(path.join(x.root, 'README.md'), '\nactual owned negative source drift\n'); now = original.state.run.deadlineMs + 1;
      throw Object.assign(new Error('timeout during real context drift'), { code: 'timeout' });
    } })));
    assert.deepEqual(stateBytes(x), before); assert.deepEqual(auto.readRuntimeState({ projectRoot: x.root }).state.run, original.state.run);
  });
});

describe('paired effects, reservations and serial capacity', () => {
  it('exact before replay cannot become another fake launch opportunity', () => {
    const x = make(), intent = x.launch(), first = x.invoke(x.request({ transition: x.before(intent) }), 'checkpoint'); let fakeSpawns = 0;
    if (first.result.committedHeadSha256) fakeSpawns++;
    const b = stateBytes(x), replay = x.invoke(x.request({ transition: x.before(intent) }), 'checkpoint');
    if (replay.result.committedHeadSha256) fakeSpawns++;
    assert.equal(fakeSpawns, 1); assert.equal(replay.result.code, 'uncertain'); assert.equal(replay.result.committedHeadSha256, null); assert.equal(replay.result.effectExecutable, false); assert.deepEqual(stateBytes(x), b);
    assert.equal(auto.readRuntimeState({ projectRoot: x.root }).reservations.get(intent.reservationId).state, 'pending');
    refuses('resume-context-stale', () => x.invoke(x.request({ runId: f.uuid(), transition: x.before(intent) }), 'checkpoint'));
  });
  it('orphan, changed-effect, wrong-reservation and conflicting after refuse', () => {
    const x = make(), intent = x.local(), q = x.request({ transition: { position: 'after', intent, beforeEventSha256: '0'.repeat(64), outcome: 'succeeded', effect: { sessionId: null, association: null, evidence: [], resolution: null } } });
    refuses('resume-pair-conflict', () => x.invoke(q, 'checkpoint')); assert.equal(stateBytes(x), null);
    const before = x.invoke(x.request({ transition: x.before(intent) }), 'checkpoint');
    for (const mutate of [(t) => t.intent.owner = 'different', (t) => t.intent.reservationId = f.uuid(), (t) => t.intent.effect.operation = 'review']) {
      const t = structuredClone(x.after(before)); mutate(t);
      assert.throws(() => x.invoke(x.request({ transition: t }), 'checkpoint'));
    }
    const after = x.invoke(x.request({ transition: x.after(before) }), 'checkpoint');
    assert.equal(auto.readRuntimeState({ projectRoot: x.root }).reservations.get(intent.reservationId).state, 'closed');
    const b = stateBytes(x); refuses('resume-pair-conflict', () => x.invoke(x.request({ transition: { ...x.after(before), outcome: 'uncertain' } }), 'checkpoint')); assert.deepEqual(stateBytes(x), b); assert.equal(after.result.code, 'checkpointed');
  });
  it('missing AO rows do not release pending launch capacity and local uncertainty stays blocked', () => {
    const x = make(); const s = JSON.parse(fs.readFileSync(f.stateFile(x.root))); s.choices.limits.workers = 1;
    // Re-record a coherent fixture agreement; this is setup, before the runtime exists.
    const a = JSON.parse(fs.readFileSync(f.roadmapFile(x.root), 'utf8').split('```fvs-auto-agreement\n')[1].split('\n```')[0]);
    a.payload.choices.limits.workers = 1; a.approvedPayloadSha256 = auto.agreementPayloadSha256(a); fs.writeFileSync(f.stateFile(x.root), JSON.stringify({ ...s, agreements: [], choicesGeneration: 0 }));
    fs.writeFileSync(f.roadmapFile(x.root), '## Decisions\n```fvs-auto-agreement\n' + JSON.stringify(a) + '\n```\n'); auto.recordAgreement({ projectRoot: x.root, agreement: a });
    const intent = x.launch(), first = x.invoke(x.request({ transition: x.before(intent) }), 'checkpoint');
    x.invoke(x.request({ transition: x.after(first, { sessionId: null, association: null, evidence: [], resolution: null }, 'failed') }), 'checkpoint');
    const b = stateBytes(x); refuses('resume-capacity-exhausted', () => x.invoke(x.request({ transition: x.before(x.launch([20])) }), 'checkpoint')); assert.deepEqual(stateBytes(x), b);
    assert.equal(auto.readRuntimeState({ projectRoot: x.root }).reservations.get(intent.reservationId).state, 'uncertain');
    const local = x.local([21]), l = x.invoke(x.request({ transition: x.before(local) }), 'checkpoint');
    x.invoke(x.request({ transition: x.after(l, undefined, 'uncertain') }), 'checkpoint');
    refuses('resume-reservation-conflict', () => x.invoke(x.request({ transition: x.before(x.local([21])) }), 'checkpoint'));
  });
  it('owned crash before rename keeps pending markers and old complete history, without repair', () => {
    const x = make(); x.invoke(); const b = stateBytes(x), q = x.request();
    assert.throws(() => resume.runResume('state', { projectRoot: x.root, request: q, out: x.out() }, services(x, { beforeRename() { throw new Error('fixture crash'); } })), /fixture crash/);
    assert.deepEqual(stateBytes(x), b); refuses('resume-pending', () => auto.readRuntimeState({ projectRoot: x.root }));
    const dir = path.dirname(file(x)); assert.ok(fs.existsSync(path.join(dir, 'lock'))); assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('.tmp-')));
  });
  it('a retained before followed by fake spawn reconciles the actual session without ever spawning on replay', () => {
    const x = make(), intent = x.launch(), first = x.invoke(x.request({ transition: x.before(intent) }), 'checkpoint');
    const linked = path.join(x.owned, 'spawned-worktree'); let spawns = 0;
    const fakeSpawn = () => { spawns++; f.git(x.root, 'worktree', 'add', '-qb', intent.effect.intendedBranchRef.slice('refs/heads/'.length), linked); x.rows.push(f.row('spawned')); x.writeControl(); };
    fakeSpawn(); // Model process death before the matching after checkpoint.
    const a = x.associate('spawned', linked, intent, first.result.recordedEventSha256), recovered = x.invoke(x.request({ associations: [a] }));
    assert.equal(recovered.result.code, 'reconciled');
    const replay = x.invoke(x.request({ associations: [a], transition: x.before(intent) }), 'checkpoint');
    if (replay.result.committedHeadSha256) fakeSpawn();
    assert.equal(spawns, 1); assert.equal(replay.result.code, 'uncertain');
    const t = x.after(first, { sessionId: 'spawned', association: a, evidence: [], resolution: null });
    const after = x.invoke(x.request({ transition: t }), 'checkpoint');
    assert.equal(after.result.code, 'checkpointed');
    const runtime = auto.readRuntimeState({ projectRoot: x.root });
    assert.equal(runtime.reservations.get(intent.reservationId).state, 'active');
    assert.equal(runtime.reservations.get(intent.reservationId).sessionId, 'spawned');
    const y = x.invoke(x.request({ associations: [a] })); assert.equal(verify(x, y).code, 'reconciled');
    // Idle/exited is still assigned, never an automatic slot release.
    x.rows[1].activity = 'exited'; x.rows[1].status = 'exited'; x.writeControl();
    const z = x.invoke(x.request({ associations: [a] }));
    assert.equal(z.result.code, 'reconciled'); assert.equal(auto.readRuntimeState({ projectRoot: x.root }).reservations.get(intent.reservationId).state, 'active');
  });
  it('explicit not-invoked resolution closes only its exact held reservation; a failed return alone did not', () => {
    const x = make(), intent = x.launch(), first = x.invoke(x.request({ transition: x.before(intent) }), 'checkpoint');
    const resolution = { ...x.local([], 'reconcile'), effect: { kind: 'reservation-resolution', targetReservationId: intent.reservationId } };
    const before = x.invoke(x.request({ transition: x.before(resolution) }), 'checkpoint');
    const proof = (invoked) => f.json(x.owned, 'no-effect', { schema: 'fvs/auto-effect-not-invoked', schemaVersion: 1, runId: x.runId, reservationId: intent.reservationId, controllerSessionId: 'coordinator', effectInvoked: invoked });
    const effect = (p) => ({ sessionId: null, association: null, evidence: [], resolution: { reason: 'not-invoked', evidence: p } });
    const b = stateBytes(x);
    refuses('resume-pair-conflict', () => x.invoke(x.request({ transition: x.after(before, effect(proof(true))) }), 'checkpoint')); assert.deepEqual(stateBytes(x), b);
    x.invoke(x.request({ transition: x.after(before, effect(proof(false))) }), 'checkpoint');
    assert.equal(auto.readRuntimeState({ projectRoot: x.root }).reservations.get(intent.reservationId).state, 'closed');
    const replay = x.invoke(x.request({ transition: x.before(intent) }), 'checkpoint');
    assert.equal(replay.result.committedHeadSha256, null); assert.equal(replay.result.code, 'already-recorded'); assert.ok(first.result.recordedEventSha256);
  });
  for (const terminalOutcome of ['succeeded', 'failed']) {
    it('recovered ' + terminalOutcome + ' local completion closes execution uncertainty without proving anything', () => {
      const x = make(), intent = x.local([19], 'check'), first = x.invoke(x.request({ transition: x.before(intent) }), 'checkpoint');
      x.invoke(x.request({ transition: x.after(first, undefined, 'uncertain') }), 'checkpoint');
      const unresolved = auto.readRuntimeState({ projectRoot: x.root }), prefix = JSON.stringify(unresolved.state.history);
      const resolution = { ...x.local([], 'reconcile'), effect: { kind: 'reservation-resolution', targetReservationId: intent.reservationId } }, before = x.invoke(x.request({ transition: x.before(resolution) }), 'checkpoint');
      const evidence = f.json(x.owned, 'terminal-command', { argv: ['fixture-checker'], exitCode: terminalOutcome === 'succeeded' ? 0 : 9 });
      const proof = { schema: 'fvs/auto-local-effect-completion', schemaVersion: 1, runId: x.runId, reservationId: intent.reservationId, transitionId: intent.transitionId, beforeEventSha256: first.result.recordedEventSha256,
        stage: intent.stage, operation: intent.effect.operation, controllerSessionId: 'coordinator', effectInvoked: true, terminalOutcome, effectEvidence: [evidence] };
      const effect = (p) => ({ sessionId: null, association: null, evidence: [], resolution: { reason: 'local-completed', evidence: f.json(x.owned, 'completion', p) } });
      for (const change of [(p) => p.operation = 'integration', (p) => p.reservationId = f.uuid(), (p) => p.beforeEventSha256 = '0'.repeat(64), (p) => p.effectEvidence = []]) {
        const p = structuredClone(proof); change(p); const b = stateBytes(x);
        refuses('resume-pair-conflict', () => x.invoke(x.request({ transition: x.after(before, effect(p)) }), 'checkpoint')); assert.deepEqual(stateBytes(x), b);
      }
      const changed = f.json(x.owned, 'changed-effect', { exitCode: 0 }); fs.appendFileSync(changed.file, '\n');
      refuses('resume-evidence-invalid', () => x.invoke(x.request({ transition: x.after(before, effect({ ...proof, effectEvidence: [changed] })) }), 'checkpoint'));
      x.invoke(x.request({ transition: x.after(before, effect(proof)) }), 'checkpoint');
      const closed = auto.readRuntimeState({ projectRoot: x.root });
      assert.equal(closed.reservations.get(intent.reservationId).state, 'closed'); assert.equal(closed.reservations.get(intent.reservationId).terminalOutcome, terminalOutcome);
      assert.equal(JSON.stringify(closed.state.history.slice(0, unresolved.state.history.length)), prefix); assert.deepEqual(closed.state.run, unresolved.state.run);
      assert.equal(fs.existsSync(path.join(x.owned, 'store')), false, 'completion is not a proof receipt');
    });
  }
  it('a local-completed controller record cannot release a launch reservation', () => {
    const x = make(), launch = x.launch(), first = x.invoke(x.request({ transition: x.before(launch) }), 'checkpoint');
    const intent = { ...x.local([], 'reconcile'), effect: { kind: 'reservation-resolution', targetReservationId: launch.reservationId } }, before = x.invoke(x.request({ transition: x.before(intent) }), 'checkpoint');
    const proof = f.json(x.owned, 'not-local', { schema: 'fvs/auto-local-effect-completion', schemaVersion: 1, runId: x.runId, reservationId: launch.reservationId, transitionId: launch.transitionId,
      beforeEventSha256: first.result.recordedEventSha256, stage: launch.stage, operation: 'proof', controllerSessionId: 'coordinator', effectInvoked: true, terminalOutcome: 'succeeded', effectEvidence: [f.json(x.owned, 'effect', { exitCode: 0 })] });
    const b = stateBytes(x); refuses('resume-pair-conflict', () => x.invoke(x.request({ transition: x.after(before, { sessionId: null, association: null, evidence: [], resolution: { reason: 'local-completed', evidence: proof } }) }), 'checkpoint'));
    assert.deepEqual(stateBytes(x), b); assert.equal(auto.readRuntimeState({ projectRoot: x.root }).reservations.get(launch.reservationId).state, 'pending');
  });
  it('two competing last-slot CLI intents cannot oversubscribe capacity', async () => {
    const x = make(); x.invoke();
    // This test uses the last free slot under the original limit3.
    for (const n of [19, 20]) x.invoke(x.request({ transition: x.before(x.launch([n])) }), 'checkpoint');
    const head = auto.readRuntimeState({ projectRoot: x.root }).headSha256;
    const requests = [21, 22].map((node) => x.request({ expectedHeadSha256: head, transition: x.before(x.launch([node])) }));
    const run = (q) => new Promise((resolve, reject) => {
      const input = f.json(x.owned, 'race-request', q);
      const child = spawn(process.execPath, [path.join(f.ROOT, 'scripts/fvs-auto.mjs'), 'checkpoint', '--project-root', x.root, '--request', input.file, '--out', x.out()]);
      let stdout = '', stderr = ''; child.stdout.on('data', (b) => stdout += b); child.stderr.on('data', (b) => stderr += b); child.on('error', reject);
      child.on('close', (exit) => resolve({ exit, stdout, stderr, result: JSON.parse(stdout) }));
    });
    const results = await Promise.all(requests.map(run));
    assert.equal(results.filter((r) => r.exit === 0).length, 1, JSON.stringify(results));
    assert.ok(['resume-head-stale', 'resume-pending', 'resume-capacity-exhausted'].includes(results.find((r) => r.exit !== 0).result.code));
    const held = [...auto.readRuntimeState({ projectRoot: x.root }).reservations.values()].filter((r) => r.intent.effect.kind === 'ao-launch' && r.state !== 'closed');
    assert.equal(held.length, 3);
  });
});

describe('actual AO shapes plus retained controller associations', () => {
  it('unassigned same-project session stays partial, never inferred unrelated from stale branch/name', () => {
    const x = make(); x.rows.push(f.row('other')); x.writeControl();
    const y = x.invoke(); assert.equal(y.result.code, 'partial'); assert.ok(y.result.observation.reasons.includes('unclassified-ao-session:other')); assert.ok(y.result.observation.reasons.includes('prior-accounting-unknown'));
    assert.equal(stateBytes(x), null, 'unknown prior execution must not establish a new clock');
    assert.equal(y.result.observation.ao[0].kind, 'orchestrator'); assert.equal('worktreePath' in y.result.observation.ao[0], false);
  });
  it('fresh role/kind/activity shapes join to explicit controller/Git association despite stale AO branch hint', () => {
    const x = make(), linked = path.join(x.owned, 'linked'); f.git(x.root, 'worktree', 'add', '-qb', 'worker', linked);
    x.rows.push(f.row('worker')); x.writeControl();
    const ref = x.associate('worker', linked), q = x.request({ associations: [ref], priorAccounting: x.accounting() }), y = x.invoke(q);
    assert.equal(y.result.code, 'reconciled'); assert.equal(verify(x, y).code, 'reconciled');
    assert.equal(y.result.observation.associations[0].value.worktree.path, linked);
    const old = fs.readFileSync(f.stateFile(x.root)); f.git(linked, 'checkout', '-qb', 'reassigned');
    refuses('resume-context-stale', () => verify(x, y)); assert.deepEqual(fs.readFileSync(f.stateFile(x.root)), old);
  });
  it('retained rules/profile bytes are labelled controller evidence and drift refuses, without AO attestation', () => {
    const x = make(); x.rows.push(f.row('worker')); x.writeControl();
    const rules = path.join(x.owned, 'retained-rules.md'); fs.writeFileSync(rules, '# Controller-observed fixture rules\n');
    const a = x.associate('worker', x.root, x.local(), null, { rulesProfile: { provenance: 'retained-controller-observation', evidence: [f.ref(rules)] } });
    const y = x.invoke(x.request({ associations: [a], priorAccounting: x.accounting() })); assert.equal(y.result.code, 'reconciled');
    fs.appendFileSync(rules, 'changed'); refuses('resume-evidence-invalid', () => verify(x, y));
  });
  it('coordinator route cannot be selected by a worker lifecycle row', () => {
    const x = make(); x.rows = [f.row('coordinator', 'worker')]; x.writeControl();
    refuses('resume-route-mismatch', () => x.invoke()); assert.equal(f.calls(x.root).some((c) => c.cmd === 'remember'), false);
  });
  it('the local AO profile HOME is explicit/existing and cannot silently change within a run', () => {
    const x = make(), q = x.request(), out = x.out(); q.ao.stateHome = path.join(x.owned, 'missing-home');
    refuses('resume-ao-state-required', () => x.invoke(q, 'state', out)); assert.equal(fs.existsSync(out), false); assert.equal(fs.existsSync(q.ao.stateHome), false);
    const y = x.invoke();
    const other = path.join(x.owned, 'other-home'); fs.mkdirSync(path.join(other, '.ao'), { recursive: true });
    const switched = x.request(); switched.ao.stateHome = other;
    refuses('resume-context-stale', () => x.invoke(switched)); assert.equal(verify(x, y).code, 'reconciled');
    const receipts = y.result.observation.receipts.map((r) => JSON.parse(fs.readFileSync(r.file)));
    assert.ok(receipts.filter((r) => r.argv[0] === x.tool).every((r) => r.env.HOME === x.stateHome));
    assert.ok(receipts.filter((r) => r.argv[0] === '/usr/bin/git').every((r) => r.env.HOME === undefined));
  });
  for (const [name, extra, code] of [['hidden inventory', { meta: { hiddenTerminatedCount: 1, hiddenOrchestratorCount: 0 } }, 'resume-ao-invalid'], ['conflicting get', { details: [f.row('coordinator', 'orchestrator', { activity: 'active' })] }, 'resume-ao-conflict'], ['duplicate ids', { rows: [f.row('coordinator', 'orchestrator'), f.row('coordinator', 'orchestrator')] }, 'resume-ao-invalid'], ['oversize output', { oversize: true }, 'resume-command-failed'], ['unknown activity', { rows: [f.row('coordinator', 'orchestrator', { activity: 'unknown' })] }, 'resume-ao-invalid'], ['missing coordinator', { rows: [] }, 'resume-ao-invalid']]) {
    it(name + ' fails closed before memory write', () => {
      const x = make(); x.writeControl(extra); refuses(code, () => x.invoke()); assert.equal(stateBytes(x), null); assert.equal(f.calls(x.root).some((c) => c.cmd === 'remember'), false);
    });
  }
  it('a malformed/changed controller reference cannot fabricate a session/path association', () => {
    const x = make(); x.rows.push(f.row('worker')); x.writeControl();
    const a = x.associate('worker'), before = fs.readFileSync(f.stateFile(x.root));
    fs.appendFileSync(a.file, '\n');
    refuses('resume-evidence-invalid', () => x.invoke(x.request({ associations: [a], priorAccounting: x.accounting() })));
    assert.equal(stateBytes(x), null); assert.deepEqual(fs.readFileSync(f.stateFile(x.root)), before);
  });
  it('missing or old memory result and source/receipt drift cannot clear a current consumer gate', () => {
    const x = make(), y = x.invoke();
    const prime = path.join(y.result.observation.memory.out, 'prime.txt'); fs.appendFileSync(prime, 'changed');
    refuses('memory-evidence-invalid', () => verify(x, y));
    const z = x.invoke(); fs.appendFileSync(path.join(x.root, 'README.md'), 'dirty source');
    refuses('resume-context-stale', () => verify(x, z));
  });
  it('hidden worker refresh selectors and wrong memory phase/session refuse before allocation', () => {
    const x = make();
    for (const change of [(q) => q.memoryRequest.operation = 'worker-readonly', (q) => q.memoryRequest.target.sessionId = 'worker', (q) => q.memoryRequest.phase = 'start']) {
      const q = x.request(), out = x.out(); change(q); refuses('resume-memory-mismatch', () => x.invoke(q, 'state', out)); assert.equal(fs.existsSync(out), false);
    }
    assert.equal(f.calls(x.root).some((c) => c.cmd === 'remember'), false);
  });
  it('corrupt runtime bytes are never repaired or silently treated as a fresh run', () => {
    const x = make(); x.invoke(); const s = JSON.parse(stateBytes(x)); s.history[0].event.prev = '0'.repeat(64); fs.writeFileSync(file(x), JSON.stringify(s));
    const b = stateBytes(x); refuses('resume-history-invalid', () => auto.readRuntimeState({ projectRoot: x.root })); assert.deepEqual(stateBytes(x), b);
  });
});

describe('controller turn activity versus meaningful AO drift at consumption', () => {
  const coordinator = (extra) => f.row('coordinator', 'orchestrator', extra);
  it('the coordinator\'s own idle/working flip between checkpoint and consumption is not context drift', () => {
    for (const [from, to] of [[{}, { status: 'working', activity: 'active' }], [{ status: 'working', activity: 'active' }, {}], [{}, { status: 'needs_input', activity: 'waiting' }]]) {
      const x = make(); x.rows = [coordinator(from)]; x.writeControl(); const y = x.invoke(); assert.equal(y.result.code, 'reconciled');
      x.rows = [coordinator(to)]; x.writeControl(); assert.equal(verify(x, y).code, 'reconciled');
    }
  });
  it('a coordinator whose agent exited or terminated still refuses', () => {
    for (const extra of [{ status: 'idle', activity: 'exited' }, { status: 'terminated', activity: 'exited', isTerminated: true }]) {
      const x = make(), y = x.invoke(); x.rows = [coordinator(extra)]; x.writeControl();
      assert.throws(() => verify(x, y), (e) => typeof e.code === 'string' && e.code.startsWith('resume-'));
    }
  });
  it('a new unassigned session still refuses', () => {
    const x = make(), y = x.invoke(); x.rows.push(f.row('other')); x.writeControl();
    refuses('resume-context-stale', () => verify(x, y));
  });
  it('an assigned actor\'s status/activity change is still compared raw', () => {
    const x = make(), linked = path.join(x.owned, 'linked'); f.git(x.root, 'worktree', 'add', '-qb', 'worker', linked);
    x.rows.push(f.row('worker')); x.writeControl();
    const ref = x.associate('worker', linked), y = x.invoke(x.request({ associations: [ref], priorAccounting: x.accounting() }));
    assert.equal(y.result.code, 'reconciled');
    x.rows = [x.rows[0], f.row('worker', 'worker', { status: 'working', activity: 'active' })]; x.writeControl();
    refuses('resume-context-stale', () => verify(x, y));
  });
});
