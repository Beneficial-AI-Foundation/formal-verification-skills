'use strict';
// Real16/22 readers, Git and effect processes; AO/Beads are owned protocol doubles.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');
const f = require('./helpers/transition-v2-fixture.cjs');
const owned = [];
after(() => { for (const root of owned) fs.rmSync(root, { recursive: true, force: true }); });
const ready = Promise.all([import('../scripts/fvs-auto-driver.mjs'), import('../scripts/fvs-auto.mjs'), import('../scripts/fvs-auto-transitions.mjs'), import('../scripts/fvs-project-memory.mjs')]);

async function world(policy = {}) {
  const [driver, auto, t, m] = await ready, x = await f.fixture(auto, t, policy);
  owned.push(x.owned);
  const effect = `
if(args[0]==='spawn'){
 const cp=require('node:child_process'),branch=args[args.indexOf('--branch')+1],wt=${JSON.stringify(path.join(x.owned, 'worker'))};
 const p=cp.spawnSync('/usr/bin/git',['-C',${JSON.stringify(x.root)},'worktree','add','-q','-b',branch,wt],{env:{PATH:'/usr/bin:/bin',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_NO_LAZY_FETCH:'1'}});
 if(p.status!==0)process.exit(p.status);
 const session={id:'owned-worker',projectId:'fixture-project',role:'worker',activity:'idle',status:'idle',isTerminated:false,branch};
 c.rows.push(session);fs.writeFileSync(${JSON.stringify(x.control)},JSON.stringify(c));console.log(JSON.stringify({session,worktree:wt}));return;}
`;
  fs.writeFileSync(x.tool, fs.readFileSync(x.tool, 'utf8').replace("if (args[0] !== 'session'", effect + "if (args[0] !== 'session'"));
  const context = () => {
    const q = x.request();
    return Object.fromEntries(['runId', 'ao', 'source', 'inputs', 'associations', 'priorAccounting'].map(k => [k, q[k]]));
  };
  const prepare = (transition = null) => driver.prepareCurrentRequest({ projectRoot: x.root, context: context(), phase: 'resume', transition });
  return { driver, auto, t, m, x, context, prepare };
}

test('fresh v2 caller requests preserve original policy and disabled/enabled memory', async () => {
  for (const policy of [{}, { memory: 'beads', budget: { kind: 'wall-clock', hours: 1 } }]) {
    const w = await world(policy), { driver, x, context } = w, before = x.run();
    const a = w.prepare(), b = w.prepare();
    assert.notEqual(a.attemptId, b.attemptId); assert.notEqual(a.resumeId, b.resumeId);
    assert.equal(a.runId, before.runId); assert.deepEqual(x.run(), before);
    assert.equal(a.expectedHeadSha256, w.auto.readRuntimeState({ projectRoot: x.root }).headSha256);
    if (policy.memory) { assert.equal(a.memoryRequest.attemptId, a.attemptId); assert.notDeepEqual(a.memoryRequest, b.memoryRequest); }
    else assert.equal(a.memoryRequest, null);
    assert.throws(() => driver.prepareCurrentRequest({ projectRoot: x.root, context: { ...context(), runId: f.uuid() }, phase: 'resume', transition: null }), /original run/);
    assert.throws(() => driver.prepareCurrentRequest({ projectRoot: x.root, context: context(), phase: 'start', transition: null }), /must resume/);
  }
});

test('ordinary proposal uses the actual strict readers and never dispatches', async () => {
  const { driver, x, prepare } = await world();
  const result = await driver.advanceOnce({ projectRoot: x.root, currentRequest: { resume: prepare(), registry: { root: path.join(x.owned, 'registry'), headSha256: null }, authorization: x.auth, profile: x.profile }, out: x.out() });
  assert.equal(result.kind, 'construct'); assert.equal(result.executable, false);
  assert.equal(JSON.parse(fs.readFileSync(x.control)).rows.length, 1);
});

test('concrete action advances through actual before/command/after, never an unconditional proposal', async () => {
  const w = await world(), { driver, auto, t, m, x } = w;
  const base = x.request;
  const inputs = { extraction: f.json(x.owned, 'unqualified-extraction', { authority: 'protocol fixture only' }),
    graph: f.ref(path.resolve(__dirname, 'fixtures/auto-contract-registry/graph.json')), plan: f.ref(path.resolve(__dirname, 'fixtures/auto-contract-registry/plan.json')), baseline: null, acceptedStore: null };
  x.request = extra => base({ inputs, ...extra });
  const q = w.prepare(), ids = { transitionId: f.uuid(), reservationId: f.uuid() }, branchRef = 'refs/heads/driver-' + f.uuid().slice(0, 8), assignmentId = f.uuid();
  const intent = { ...ids, stage: 'specification', nodes: [19], owner: 'worker-owner', effect: { kind: 'ao-launch', projectId: 'fixture-project', intendedBranchRef: branchRef, assignmentId, sessionId: null } };
  const prior = await driver.recordCheckpoint({ projectRoot: x.root, request: q, out: x.out() });
  const fresh = w.prepare();
  const snapshot = t.transitionSnapshot({ q: fresh, run: x.run(), canonical: x.canonical(), observation: prior.value.observation,
    action: { before: { registry: null }, target: {}, authorization: x.auth, profile: x.profile } }, { profileObservation: x.profileObservation });
  const a = { schema: 'fvs/auto-transition-request', schemaVersion: 2, runId: x.runId, ...ids, kind: 'launch', stage: intent.stage, nodes: intent.nodes, owner: intent.owner,
    expectedHeadSha256: fresh.expectedHeadSha256, before: snapshot, target: { projectId: 'fixture-project', branchRef, assignmentId, selectionStage: 'fc_spec', invocation: null,
      startup: { challenge: f.uuid(), attemptId: f.uuid(), phase: 'resume', resumeId: f.uuid() }, resumeOf: null }, authorization: x.auth, profile: x.profile, basis: null };
  const action = f.json(x.owned, 'launch-action', a); intent.request = action;
  const request = w.prepare({ position: 'before', intent, beforeEventSha256: null, outcome: null, effect: null });
  const beforeHead = auto.readRuntimeState({ projectRoot: x.root }).headSha256;
  const produced = await driver.runPairedEffect({ projectRoot: x.root, request, out: x.out() });
  assert.equal(produced.status, 'command-completed'); assert.equal(produced.executable, false);
  assert.equal(produced.before.value.expectedPredecessorHeadSha256, beforeHead);
  const command = t.transitionBound(produced.producer.command), raw = JSON.parse(t.transitionBound(command.stdout, false));
  assert.equal(command.argv[1], 'spawn'); assert.deepEqual(command.execution.budget, x.run().budget);
  const association = x.associate(raw.session.id, raw.worktree, intent, produced.before.value.recordedEventSha256);
  const completion = f.json(x.owned, 'completion', { schema: 'fvs/auto-transition-completion', schemaVersion: 2, runId: x.runId, ...ids,
    actionSha256: m.memoryHash(a), beforeEventSha256: produced.before.value.recordedEventSha256, command: produced.producer.command, result: f.json(x.owned, 'launch-result', raw) });
  const afterRequest = w.prepare({ position: 'after', intent, beforeEventSha256: produced.before.value.recordedEventSha256, outcome: 'succeeded',
    effect: { sessionId: raw.session.id, association, evidence: [completion], resolution: null } });
  const afterResult = await driver.recordAfter({ projectRoot: x.root, request: afterRequest, out: x.out() });
  assert.equal(afterResult.status, 'facts-recorded-partial'); assert.equal(afterResult.basis.version, 2);
  assert.equal(afterResult.basis.beforeEventSha256, produced.before.value.recordedEventSha256);
  assert.deepEqual(afterResult.basis.completion, completion); assert.equal(afterResult.basis.workCompletion, null);
  assert.equal(afterResult.executable, false);
  await assert.rejects(driver.recordAfter({ projectRoot: x.root, request: afterRequest, out: x.out() }), { code: 'resume-result-mismatch' });
});

test('explicit before path does not require ordinary strict registry proposal readiness', async () => {
  const { driver, x } = await world();
  const a = x.action('construct', { procedure: 'auto-extract' });
  const result = await driver.advanceOnce({ projectRoot: x.root, currentRequest: { resume: a.q,
    registry: { root: path.join(x.owned, 'not-established'), headSha256: null }, authorization: x.auth, profile: x.profile }, out: x.out() });
  assert.equal(result.status, 'before-recorded');
  assert.equal(result.checkpoint.verification.observation.transition.admissibility.status, 'next-action-eligible');
  assert.equal(result.executable, false);
});

test('action path rejects a foreign held profile instead of executing', async () => {
  const { driver, x } = await world();
  const a = x.action('construct', { procedure: 'auto-extract' });
  await assert.rejects(driver.advanceOnce({ projectRoot: x.root, currentRequest: { resume: a.q, registry: { root: x.owned, headSha256: null }, authorization: x.auth, profile: x.auth }, out: x.out() }), /authorization\/profile/);
  assert.equal(JSON.parse(fs.readFileSync(x.control)).rows.length, 1);
});

test('stored v2 choices without the current execution grant cannot dispatch', async () => {
  const { driver, auto, x, prepare } = await world(), agreement = structuredClone(x.canonical().envelope);
  delete agreement.contextSha256; delete agreement.recordedAt;
  agreement.payload.contextVersion++; agreement.payload.execution = null; agreement.approvedPayloadSha256 = auto.agreementPayloadSha256(agreement);
  fs.writeFileSync(f.roadmapFile(x.root), '## Decisions\n```fvs-auto-agreement\n' + JSON.stringify(agreement) + '\n```\n');
  auto.recordAgreement({ projectRoot: x.root, agreement, confirmOverwrite: true });
  const head = auto.readRuntimeState({ projectRoot: x.root }).headSha256;
  await assert.rejects(driver.advanceOnce({ projectRoot: x.root, currentRequest: { resume: prepare(), registry: { root: x.owned, headSha256: null },
    authorization: x.auth, profile: x.profile }, out: x.out() }), { code: 'transition-grant-required' });
  assert.equal(auto.readRuntimeState({ projectRoot: x.root }).headSha256, head);
  assert.equal(JSON.parse(fs.readFileSync(x.control)).rows.length, 1);
});

test('driver CLI cancellation awaits the owned process and keeps the pending launch reservation', async () => {
  const w = await world(), { x, auto, t } = w;
  fs.writeFileSync(x.tool, fs.readFileSync(x.tool, 'utf8').replace("if(args[0]==='spawn'){", "if(args[0]==='spawn'){setInterval(()=>{},1000);setTimeout(()=>process.exit(89),5000);return;"));
  const base = x.request, inputs = { extraction: f.json(x.owned, 'metadata', { authority: 'protocol only' }), graph: f.ref(path.resolve(__dirname, 'fixtures/auto-contract-registry/graph.json')),
    plan: f.ref(path.resolve(__dirname, 'fixtures/auto-contract-registry/plan.json')), baseline: null, acceptedStore: null };
  x.request = extra => base({ inputs, ...extra });
  const observed = await w.driver.recordCheckpoint({ projectRoot: x.root, request: w.prepare(), out: x.out() }), q = w.prepare();
  const ids = { transitionId: f.uuid(), reservationId: f.uuid() }, branchRef = 'refs/heads/cancel-' + f.uuid().slice(0, 8), assignmentId = f.uuid(), owner = 'worker-owner';
  const snapshot = t.transitionSnapshot({ q, run: x.run(), canonical: x.canonical(), observation: observed.value.observation,
    action: { before: { registry: null }, target: {}, authorization: x.auth, profile: x.profile } }, { profileObservation: x.profileObservation });
  const action = f.json(x.owned, 'cancel-action', { schema: 'fvs/auto-transition-request', schemaVersion: 2, runId: x.runId, ...ids, kind: 'launch', stage: 'specification', nodes: [19], owner,
    expectedHeadSha256: q.expectedHeadSha256, before: snapshot, target: { projectId: 'fixture-project', branchRef, assignmentId, selectionStage: 'fc_spec', invocation: null,
      startup: { challenge: f.uuid(), attemptId: f.uuid(), phase: 'resume', resumeId: f.uuid() }, resumeOf: null }, authorization: x.auth, profile: x.profile, basis: null });
  const intent = { ...ids, stage: 'specification', nodes: [19], owner, effect: { kind: 'ao-launch', projectId: 'fixture-project', intendedBranchRef: branchRef, assignmentId, sessionId: null }, request: action };
  const request = w.prepare({ position: 'before', intent, beforeEventSha256: null, outcome: null, effect: null }), out = x.out();
  const input = f.json(x.owned, 'driver-input', { projectRoot: x.root, request, out });
  const child = spawn(process.execPath, [path.resolve(__dirname, '../scripts/fvs-auto-driver.mjs'), 'effect', '--input', input.file], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
  let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const closed = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => resolve({ code, signal })); });
  const end = Date.now() + 10000;
  while (!(fs.existsSync(x.log) && fs.readFileSync(x.log, 'utf8').split('\n').filter(Boolean).some(line => JSON.parse(line)[0] === 'spawn'))) {
    if (Date.now() > end) { child.kill('SIGTERM'); throw Error('owned double did not start'); }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  child.stdin.end(JSON.stringify({ kind: 'cancel', invocationId: ids.transitionId }) + '\n');
  const terminal = await closed; assert.equal(terminal.code, 1, stderr); assert.equal(terminal.signal, null);
  const value = JSON.parse(stdout); assert.equal(value.status, 'execution-unverified'); assert.equal(value.producer.code, 'cancelled');
  const receipt = t.transitionBound(value.producer.command); assert.equal(receipt.supervision.cleanupComplete, true); assert.equal(receipt.supervision.cancelled, true);
  const runtime = auto.readRuntimeState({ projectRoot: x.root }); assert.equal(runtime.reservations.get(ids.reservationId).state, 'pending');
  assert.equal(runtime.state.history.at(-1).event.position, 'before');
});
