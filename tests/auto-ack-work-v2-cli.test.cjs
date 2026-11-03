// Non-stubbed v2 `ack-work` CLI regressions. AO is the labelled protocol double from the transition
// fixtures; released-context checks, handoff guards, Git observations and runtime history are real.
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
if(args[0]==='spawn'){const cp=require('node:child_process'),branch=args[args.indexOf('--branch')+1],n=c.rows.filter(r=>r.role==='worker').length,wt=c.workerPath+'-'+n;
 const p=cp.spawnSync('/usr/bin/git',['-C',${JSON.stringify(x.root)},'worktree','add','-q','-b',branch,wt],{env:{PATH:'/usr/bin:/bin',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_NO_LAZY_FETCH:'1'}});
 if(p.status!==0){process.stderr.write(p.stderr);process.exit(p.status);}
 const session={id:'stage-worker-'+n,projectId:'fixture-project',role:'worker',activity:'idle',status:'idle',isTerminated:false,branch};
 c.rows.push(session);fs.writeFileSync(${JSON.stringify(x.control)},JSON.stringify(c));console.log(JSON.stringify({session,worktree:wt}));return;}
if(args[0]==='send'){console.log(JSON.stringify({deliveryHandle:args[args.indexOf('--client-message-id')+1],authority:'delivery-only'}));return;}
if(args[0]==='session'&&args[1]==='kill'){const row=c.rows.find(r=>r.id===args[2]);if(!row)process.exit(7);Object.assign(row,{isTerminated:true,activity:'terminated',status:'terminated'});
 fs.writeFileSync(${JSON.stringify(x.control)},JSON.stringify(c));console.log(JSON.stringify({session:row}));return;}
`;
  fs.writeFileSync(x.tool, fs.readFileSync(x.tool, 'utf8').replace("if (args[0] !== 'session'", effects + "if (args[0] !== 'session'"));
  x.writeControl({ workerPath: path.join(x.owned, 'allocated-worktree') });
}

async function world() {
  const [auto, t, m] = await ready, x = await f.fixture(auto, t); owned.push(x.owned); effectDouble(x);
  const inputs = { extraction: f.json(x.owned, 'metadata-only-extraction', { authority: 'protocol simulation only' }),
    plan: f.ref(path.join(ROOT, 'tests/fixtures/auto-contract-registry/plan.json')), graph: f.ref(path.join(ROOT, 'tests/fixtures/auto-contract-registry/graph.json')), baseline: null, acceptedStore: null };
  const base = x.request, w = { auto, t, m, x, associations: [], owner: 'worker-owner', ao: () => ({ tool: f.ref(x.tool), stateHome: x.stateHome, projectId: 'fixture-project' }) };
  x.request = (extra = {}) => base({ inputs, associations: w.associations, ...extra });
  const run = () => auto.readRuntimeState({ projectRoot: x.root }).state.run;
  w.worktree = (p) => ({ path: p, gitDir: fs.realpathSync(path.resolve(p, f.git(p, 'rev-parse', '--git-dir'))), gitCommonDir: fs.realpathSync(path.resolve(p, f.git(p, 'rev-parse', '--git-common-dir'))),
    branchRef: f.git(p, 'symbolic-ref', 'HEAD'), commit: f.git(p, 'rev-parse', 'HEAD'), tree: f.git(p, 'rev-parse', 'HEAD^{tree}'), dirty: f.git(p, 'status', '--porcelain=v1', '--untracked-files=all') !== '' });
  w.snapshot = (q, sessionId, nodes, kind = null) => t.transitionSnapshot({ q, run: run(), canonical: x.canonical(), observation: x.invoke(x.request()).result.observation,
    action: { schemaVersion: 2, kind, before: { registry: null }, target: sessionId ? { sessionId } : {}, owner: w.owner, nodes, authorization: x.auth, profile: x.profile } }, { profileObservation: x.profileObservation, observeWorktree: (o) => w.worktree(o.path) });
  w.completion = (a, before, command, result) => f.json(x.owned, 'completion', { schema: 'fvs/auto-transition-completion', schemaVersion: 2, runId: a.runId, transitionId: a.transitionId, reservationId: a.reservationId,
    actionSha256: m.memoryHash(a), beforeEventSha256: before, command, result: f.json(x.owned, 'result', result) });
  // One paired transition through the engine; `execute:false` is the paired-only resolution route.
  w.paired = async ({ kind, stage, nodes, effect, target, sessionId = null, before = null, execute = true, result, afterEffect }) => {
    const ids = { transitionId: f.uuid(), reservationId: f.uuid() }, snap = before ?? w.snapshot(x.request(), sessionId, nodes, kind === 'terminate' ? 'terminate' : null), q0 = x.request();
    const a = { schema: 'fvs/auto-transition-request', schemaVersion: 2, runId: x.runId, ...ids, kind, stage, nodes, owner: w.owner, expectedHeadSha256: q0.expectedHeadSha256, before: snap, target, authorization: x.auth, profile: x.profile, basis: null };
    const actionRef = f.json(x.owned, kind + '-action', a), intent = { ...ids, stage, nodes, owner: w.owner, effect, request: actionRef };
    const bq = x.request({ transition: { position: 'before', intent, beforeEventSha256: null, outcome: null, effect: null } }), b = x.invoke(bq, 'checkpoint');
    let out = null, done = null;
    if (execute) {
      const exec = await auto.executeTransition({ projectRoot: x.root, request: bq, beforeOut: b.out, producerOut: x.out(), evidenceDir: x.out() });
      assert.equal(exec.status, 'command-completed', kind);
      try { out = JSON.parse(String(t.transitionBound(t.transitionBound(exec.command).stdout, false))); } catch {}
      done = w.completion(a, b.result.recordedEventSha256, exec.command, result(out));
    }
    const eff = afterEffect(out, b.result.recordedEventSha256, intent, done);
    const af = x.invoke(x.request({ transition: { position: 'after', intent, beforeEventSha256: b.result.recordedEventSha256, outcome: 'succeeded', effect: { evidence: [done], resolution: null, ...eff } } }), 'checkpoint');
    assert.ok(af.result.recordedEventSha256, kind + ' after recorded');
    return { a, actionRef, before: b, after: af, done, out };
  };
  return w;
}

// Launch -> startup -> prepare-input -> release for one actor (specification role, no Lean).
async function releasedActor(w, resumeOf = null) {
  const { auto, t, m, x } = w, branchRef = 'refs/heads/stage-' + f.uuid().slice(0, 8), assignmentId = f.uuid(), startup = { challenge: f.uuid(), attemptId: f.uuid(), phase: 'resume', resumeId: f.uuid() };
  let association, wtPath;
  const launch = await w.paired({ kind: 'launch', stage: 'specification', nodes: [19], effect: { kind: 'ao-launch', projectId: 'fixture-project', intendedBranchRef: branchRef, assignmentId, sessionId: null },
    target: { projectId: 'fixture-project', branchRef, assignmentId, selectionStage: 'fc_spec', invocation: null, startup, resumeOf }, result: (out) => ({ session: out.session }),
    afterEffect: (out, beforeSha, intent) => { wtPath = out.worktree; association = x.associate(out.session.id, wtPath, intent, beforeSha); return { sessionId: out.session.id, association }; } });
  w.associations = [association];
  const assigned = t.transitionBound(association), fixed = launch.a.before.fixed;
  const actor = { projectId: 'fixture-project', sessionId: assigned.sessionId, reservationId: assigned.reservationId, assignmentId: assigned.assignmentId, worktree: w.worktree(wtPath), profile: null };
  const caller = (ids) => ({ attemptId: ids.attemptId, phase: ids.phase, target: { projectId: 'fixture-project', sessionId: actor.sessionId, resumeId: ids.resumeId } });
  const startupRequest = t.disabledWorkerMemoryRequest(fixed, caller(startup));
  const startupAck = f.json(x.owned, 'startup-ack', { schema: 'fvs/auto-startup-ack', schemaVersion: 2, runId: x.runId, actionSha256: m.memoryHash(launch.a), beforeEventSha256: launch.before.result.recordedEventSha256,
    challenge: startup.challenge, actor, memoryRequest: startupRequest, memoryOut: null, memoryEvidence: t.workerMemoryEvidence(null, startupRequest, fixed), waiting: true });
  assert.equal(auto.verifyWorkerStartup({ projectRoot: x.root, ao: w.ao(), out: x.out(), actor, expectedMemoryRequest: startupRequest, actionRef: launch.actionRef, acknowledgement: startupAck }).status, 'startup-acknowledged');
  const local = { kind: 'local', operation: 'integration' }, none = () => ({ sessionId: null, association: null });
  const prep = await w.paired({ kind: 'prepare-input', stage: 'integration', nodes: [], effect: local, sessionId: actor.sessionId,
    target: { sessionId: actor.sessionId, association, launch: launch.actionRef, startupAck, startupRequest, candidate: { commit: actor.worktree.commit, expectedTree: actor.worktree.tree } },
    result: () => ({ status: 'prepared', candidate: { commit: actor.worktree.commit } }), afterEffect: none });
  const packetRequest = t.disabledWorkerMemoryRequest(fixed, caller({ attemptId: f.uuid(), phase: 'resume', resumeId: f.uuid() }));
  const packet = f.json(x.owned, 'work', { schema: 'fvs/auto-work-packet', schemaVersion: 2, runId: x.runId, actionSha256: m.memoryHash(launch.a), launch: launch.actionRef, beforeEventSha256: launch.before.result.recordedEventSha256,
    challenge: f.uuid(), actor, deliveryHandle: 'release-' + f.uuid(), memoryRequest: packetRequest, procedure: 'lean-specify/controller-direct', inputs: [x.profile], resumeOf, startMarker: path.join(x.owned, 'start-' + f.uuid() + '.json') });
  const p = t.readWorkPacket(packet);
  await w.paired({ kind: 'release', stage: 'integration', nodes: [], effect: local, target: { sessionId: actor.sessionId, association, packet, handle: p.deliveryHandle },
    before: prep.after.result.observation.transition.snapshot, result: () => ({ deliveryHandle: p.deliveryHandle, authority: 'delivery-only' }), afterEffect: none });
  return { actor, association, packet, packetRequest, marker: p.startMarker };
}
function ackWork(w, s) {
  const out = w.x.out(), input = f.json(w.x.owned, 'ack-work-input', { projectRoot: w.x.root, ao: w.ao(), out, actor: s.actor, expectedMemoryRequest: s.packetRequest, memoryOut: null, packet: s.packet, marker: s.marker });
  const r = spawnSync(process.execPath, [AUTO, 'ack-work', '--input', input.file, '--project-root', w.x.root], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
  return { out, result: JSON.parse(r.stdout), status: r.status };
}
test('real v2 ack-work CLI grants start with a fresh owned output for each released-context check', async () => {
  const w = await world(), s = await releasedActor(w), { out, result, status } = ackWork(w, s);
  assert.equal(status, 0, JSON.stringify(result)); assert.equal(result.ok, true); assert.equal(result.mayStart, true); assert.equal(result.status, 'new-start-acknowledged');
  for (const n of [1, 2]) {
    const dir = out + '-context-' + n; assert.ok(fs.existsSync(dir), 'check ' + n + ' owns its output');
    assert.ok(fs.readdirSync(path.join(dir, 'receipts')).length > 0, 'check ' + n + ' ran real AO/Git observations');
  }
  assert.equal(fs.existsSync(out + '-context'), false, 'no shared context output');
  assert.equal(JSON.parse(fs.readFileSync(s.marker)).timeOrigin, 'worker-entry-acknowledgement');
});

test('real v2 ack-work CLI still refuses a changed released context and writes no start marker', async () => {
  const w = await world(), s = await releasedActor(w), control = JSON.parse(fs.readFileSync(w.x.control));
  fs.writeFileSync(w.x.control, JSON.stringify({ ...control, project: { ...control.project, config: { worker: { agent: 'fixture', agentConfig: { model: 'drifted' } } } } }));
  const { result, status } = ackWork(w, s);
  assert.equal(status, 1); assert.equal(result.ok, false); assert.match(result.code, /^transition-(packet-context-stale|profile-required|start-uncertain)$/);
  assert.equal(fs.existsSync(s.marker), false);
});
// Replacement (resumeOf task progress) exists only for proof tasks, whose launch needs a real auto
// freeze; that non-stubbed path is exercised by the native Phase C rehearsal, not this default suite.
