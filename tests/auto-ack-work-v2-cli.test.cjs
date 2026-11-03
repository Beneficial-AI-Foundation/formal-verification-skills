// Non-stubbed v2 `ack-work` CLI regression. AO is the labelled protocol double from the transition
// fixtures; the released-context checks, Git observations and runtime history are real engine paths.
'use strict';
const { test, after } = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
const f = require('./helpers/transition-v2-fixture.cjs');
const ROOT = path.resolve(__dirname, '..'), AUTO = path.join(ROOT, 'scripts/fvs-auto.mjs');
const ready = Promise.all([import('../scripts/fvs-auto.mjs'), import('../scripts/fvs-auto-transitions.mjs'), import('../scripts/fvs-project-memory.mjs')]), owned = [];
after(() => { for (const r of owned) fs.rmSync(r, { recursive: true, force: true }); });

function effectDouble(x) {
  // Installed only in this owned fixture's AO double, never selected by a production flag.
  const effects = `
if(args[0]==='spawn'){const cp=require('node:child_process'),branch=args[args.indexOf('--branch')+1];
 const p=cp.spawnSync('/usr/bin/git',['-C',${JSON.stringify(x.root)},'worktree','add','-q','-b',branch,c.workerPath],{env:{PATH:'/usr/bin:/bin',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_NO_LAZY_FETCH:'1'}});
 if(p.status!==0){process.stderr.write(p.stderr);process.exit(p.status);}
 const session={id:c.nextSession,projectId:'fixture-project',role:'worker',activity:'idle',status:'idle',isTerminated:false,branch};
 c.rows.push(session);fs.writeFileSync(${JSON.stringify(x.control)},JSON.stringify(c));console.log(JSON.stringify({session}));return;}
if(args[0]==='send'){console.log(JSON.stringify({deliveryHandle:args[args.indexOf('--client-message-id')+1],authority:'delivery-only'}));return;}
`;
  fs.writeFileSync(x.tool, fs.readFileSync(x.tool, 'utf8').replace("if (args[0] !== 'session'", effects + "if (args[0] !== 'session'"));
  x.effects = { nextSession: 'stage-worker', workerPath: path.join(x.owned, 'allocated-worktree') };
  x.writeControl(x.effects);
}

// Launch -> startup -> prepare-input -> release, all recorded through the engine with its real services.
async function released() {
  const [auto, t, m] = await ready, x = await f.fixture(auto, t); owned.push(x.owned); effectDouble(x);
  const inputs = { extraction: f.json(x.owned, 'metadata-only-extraction', { authority: 'protocol simulation only' }),
    plan: f.ref(path.join(ROOT, 'tests/fixtures/auto-contract-registry/plan.json')), graph: f.ref(path.join(ROOT, 'tests/fixtures/auto-contract-registry/graph.json')), baseline: null, acceptedStore: null };
  const base = x.request; let associations = [];
  x.request = (extra = {}) => base({ inputs, associations, ...extra });
  const run = () => auto.readRuntimeState({ projectRoot: x.root }).state.run, owner = 'worker-owner';
  const worktree = (p) => ({ path: p, gitDir: fs.realpathSync(path.resolve(p, f.git(p, 'rev-parse', '--git-dir'))), gitCommonDir: fs.realpathSync(path.resolve(p, f.git(p, 'rev-parse', '--git-common-dir'))),
    branchRef: f.git(p, 'symbolic-ref', 'HEAD'), commit: f.git(p, 'rev-parse', 'HEAD'), tree: f.git(p, 'rev-parse', 'HEAD^{tree}'), dirty: f.git(p, 'status', '--porcelain=v1', '--untracked-files=all') !== '' });
  const snapshot = (q, sessionId, nodes) => t.transitionSnapshot({ q, run: run(), canonical: x.canonical(), observation: x.invoke(x.request()).result.observation,
    action: { before: { registry: null }, target: sessionId ? { sessionId } : {}, owner, nodes, authorization: x.auth, profile: x.profile } }, { profileObservation: x.profileObservation, observeWorktree: (w) => worktree(w.path) });
  const paired = async (kind, stage, nodes, effect, target, { sessionId = null, before = null } = {}, result, afterEffect) => {
    const ids = { transitionId: f.uuid(), reservationId: f.uuid() }, snap = before ?? snapshot(x.request(), sessionId, nodes), q0 = x.request();
    const a = { schema: 'fvs/auto-transition-request', schemaVersion: 2, runId: x.runId, ...ids, kind, stage, nodes, owner, expectedHeadSha256: q0.expectedHeadSha256, before: snap, target, authorization: x.auth, profile: x.profile, basis: null };
    const actionRef = f.json(x.owned, kind + '-action', a), intent = { ...ids, stage, nodes, owner, effect, request: actionRef };
    const bq = x.request({ transition: { position: 'before', intent, beforeEventSha256: null, outcome: null, effect: null } }), b = x.invoke(bq, 'checkpoint');
    const exec = await auto.executeTransition({ projectRoot: x.root, request: bq, beforeOut: b.out, producerOut: x.out(), evidenceDir: x.out() });
    assert.equal(exec.status, 'command-completed', kind);
    const raw = String(t.transitionBound(t.transitionBound(exec.command).stdout, false)); let out = null; try { out = JSON.parse(raw); } catch {} const res = result(out);
    const done = f.json(x.owned, 'completion', { schema: 'fvs/auto-transition-completion', schemaVersion: 2, runId: a.runId, transitionId: a.transitionId, reservationId: a.reservationId,
      actionSha256: m.memoryHash(a), beforeEventSha256: b.result.recordedEventSha256, command: exec.command, result: f.json(x.owned, 'result', res) });
    const eff = afterEffect(out, b.result.recordedEventSha256, intent);
    const af = x.invoke(x.request({ transition: { position: 'after', intent, beforeEventSha256: b.result.recordedEventSha256, outcome: 'succeeded', effect: { ...eff, evidence: [done], resolution: null } } }), 'checkpoint');
    assert.ok(af.result.recordedEventSha256, kind + ' after recorded');
    return { a, actionRef, before: b, after: af };
  };
  const branchRef = 'refs/heads/stage-worker-branch', assignmentId = f.uuid(), startup = { challenge: f.uuid(), attemptId: f.uuid(), phase: 'resume', resumeId: f.uuid() };
  let association;
  const launch = await paired('launch', 'specification', [19], { kind: 'ao-launch', projectId: 'fixture-project', intendedBranchRef: branchRef, assignmentId, sessionId: null },
    { projectId: 'fixture-project', branchRef, assignmentId, selectionStage: 'fc_spec', invocation: null, startup, resumeOf: null }, {}, (out) => out,
    (out, beforeSha, intent) => { association = x.associate(out.session.id, x.effects.workerPath, { ...intent, effect: { ...intent.effect } }, beforeSha); return { sessionId: out.session.id, association }; });
  associations = [association];
  const assigned = t.transitionBound(association), fixed = launch.a.before.fixed;
  const actor = { projectId: 'fixture-project', sessionId: assigned.sessionId, reservationId: assigned.reservationId, assignmentId: assigned.assignmentId, worktree: worktree(x.effects.workerPath), profile: null };
  const caller = (ids) => ({ attemptId: ids.attemptId, phase: ids.phase, target: { projectId: 'fixture-project', sessionId: actor.sessionId, resumeId: ids.resumeId } });
  const startupRequest = t.disabledWorkerMemoryRequest(fixed, caller(startup)), ao = { tool: f.ref(x.tool), stateHome: x.stateHome, projectId: 'fixture-project' };
  const startupAck = f.json(x.owned, 'startup-ack', { schema: 'fvs/auto-startup-ack', schemaVersion: 2, runId: x.runId, actionSha256: m.memoryHash(launch.a), beforeEventSha256: launch.before.result.recordedEventSha256,
    challenge: startup.challenge, actor, memoryRequest: startupRequest, memoryOut: null, memoryEvidence: t.workerMemoryEvidence(null, startupRequest, fixed), waiting: true });
  assert.equal(auto.verifyWorkerStartup({ projectRoot: x.root, ao, out: x.out(), actor, expectedMemoryRequest: startupRequest, actionRef: launch.actionRef, acknowledgement: startupAck }).status, 'startup-acknowledged');
  const prep = await paired('prepare-input', 'integration', [], { kind: 'local', operation: 'integration' },
    { sessionId: actor.sessionId, association, launch: launch.actionRef, startupAck, startupRequest, candidate: { commit: actor.worktree.commit, expectedTree: actor.worktree.tree } }, { sessionId: actor.sessionId },
    () => ({ status: 'prepared', candidate: { commit: actor.worktree.commit } }), () => ({ sessionId: null, association: null }));
  const packetRequest = t.disabledWorkerMemoryRequest(fixed, caller({ attemptId: f.uuid(), phase: 'resume', resumeId: f.uuid() }));
  const packet = f.json(x.owned, 'work', { schema: 'fvs/auto-work-packet', schemaVersion: 2, runId: x.runId, actionSha256: m.memoryHash(launch.a), launch: launch.actionRef, beforeEventSha256: launch.before.result.recordedEventSha256,
    challenge: f.uuid(), actor, deliveryHandle: 'release-' + f.uuid(), memoryRequest: packetRequest, procedure: 'lean-specify/controller-direct', inputs: [x.profile], resumeOf: null, startMarker: path.join(x.owned, 'start-' + f.uuid() + '.json') });
  const p = t.readWorkPacket(packet);
  const prepSnapshot = prep.after.result.observation.transition.snapshot;
  await paired('release', 'integration', [], { kind: 'local', operation: 'integration' }, { sessionId: actor.sessionId, association, packet, handle: p.deliveryHandle }, { before: prepSnapshot },
    () => ({ deliveryHandle: p.deliveryHandle, authority: 'delivery-only' }), () => ({ sessionId: null, association: null }));
  return { x, ao, actor, packet, packetRequest, marker: p.startMarker };
}
function ackWork(s) {
  const out = s.x.out(), input = f.json(s.x.owned, 'ack-work-input', { projectRoot: s.x.root, ao: s.ao, out, actor: s.actor, expectedMemoryRequest: s.packetRequest, memoryOut: null, packet: s.packet, marker: s.marker });
  const r = spawnSync(process.execPath, [AUTO, 'ack-work', '--input', input.file, '--project-root', s.x.root], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
  return { out, result: JSON.parse(r.stdout), status: r.status };
}

test('real v2 ack-work CLI grants start with a fresh owned output for each released-context check', async () => {
  const s = await released(), { out, result, status } = ackWork(s);
  assert.equal(status, 0, JSON.stringify(result)); assert.equal(result.ok, true); assert.equal(result.mayStart, true); assert.equal(result.status, 'new-start-acknowledged');
  for (const n of [1, 2]) {
    const dir = out + '-context-' + n; assert.ok(fs.existsSync(dir), 'check ' + n + ' owns its output');
    assert.ok(fs.readdirSync(path.join(dir, 'receipts')).length > 0, 'check ' + n + ' ran real AO/Git observations');
  }
  assert.equal(fs.existsSync(out + '-context'), false, 'no shared context output');
  assert.equal(JSON.parse(fs.readFileSync(s.marker)).timeOrigin, 'worker-entry-acknowledgement');
});

test('real v2 ack-work CLI still refuses a changed released context and writes no start marker', async () => {
  const s = await released();
  const control = JSON.parse(fs.readFileSync(s.x.control));
  fs.writeFileSync(s.x.control, JSON.stringify({ ...control, project: { ...control.project, config: { worker: { agent: 'fixture', agentConfig: { model: 'drifted' } } } } }));
  const { result, status } = ackWork(s);
  assert.equal(status, 1); assert.equal(result.ok, false); assert.match(result.code, /^transition-(packet-context-stale|profile-required|start-uncertain)$/);
  assert.equal(fs.existsSync(s.marker), false);
});
