// Shared only by the new driver tests. Real Git/16/22, owned AO/Beads doubles; no proof evidence.
const fs = require('node:fs'), path = require('node:path');
const f = require('./transition-v2-fixture.cjs');
async function world() {
  const [driver, auto, t, m] = await Promise.all([import('../../scripts/fvs-auto-driver.mjs'), import('../../scripts/fvs-auto.mjs'), import('../../scripts/fvs-auto-transitions.mjs'), import('../../scripts/fvs-project-memory.mjs')]);
  const x = await f.fixture(auto, t);
  const effects = `
if(args[0]==='spawn'){const cp=require('node:child_process'),branch=args[args.indexOf('--branch')+1],wt=c.workerPath;
 const p=cp.spawnSync('/usr/bin/git',['-C',${JSON.stringify(x.root)},'worktree','add','-q','-b',branch,wt],{env:{PATH:'/usr/bin:/bin',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_NO_LAZY_FETCH:'1'}});
 if(p.status!==0)process.exit(p.status);
 const session={id:'review-worker',projectId:'fixture-project',role:'worker',harness:'fixture',activity:'idle',status:'idle',isTerminated:false,branch};c.rows.push(session);fs.writeFileSync(${JSON.stringify(x.control)},JSON.stringify(c));console.log(JSON.stringify({session,worktree:wt}));return;}
if(args[0]==='send'){console.log(JSON.stringify({deliveryHandle:args[args.indexOf('--client-message-id')+1],authority:'delivery-only'}));return;}
`;
  fs.writeFileSync(x.tool, fs.readFileSync(x.tool, 'utf8').replace("if (args[0] !== 'session'", effects + "if (args[0] !== 'session'"));
  x.writeControl({ workerPath: path.join(x.owned, 'review-worker') });
  let associations = [];
  const inputs = { extraction: f.json(x.owned, 'fixture-extraction', { authority: 'metadata only; no extraction claim' }),
    plan: f.ref(path.resolve(__dirname, '../fixtures/auto-contract-registry/plan.json')), graph: f.ref(path.resolve(__dirname, '../fixtures/auto-contract-registry/graph.json')), baseline: null, acceptedStore: null };
  const context = () => { const q = x.request({ inputs, associations }); return Object.fromEntries(['runId', 'ao', 'source', 'inputs', 'associations', 'priorAccounting'].map(k => [k, q[k]])); };
  const request = transition => driver.prepareCurrentRequest({ projectRoot: x.root, context: context(), phase: 'resume', transition: transition ?? null });
  const worktree = p => ({ path: p, gitDir: fs.realpathSync(path.resolve(p, f.git(p, 'rev-parse', '--git-dir'))), gitCommonDir: fs.realpathSync(path.resolve(p, f.git(p, 'rev-parse', '--git-common-dir'))),
    branchRef: f.git(p, 'symbolic-ref', 'HEAD'), commit: f.git(p, 'rev-parse', 'HEAD'), tree: f.git(p, 'rev-parse', 'HEAD^{tree}'), dirty: f.git(p, 'status', '--porcelain=v1', '--untracked-files=all') !== '' });
  async function paired({ kind, stage, nodes = [], target, sessionId = null, effect = { kind: 'local', operation: stage }, result = raw => raw, after = () => ({ sessionId: null, association: null }) }) {
    const observed = await driver.recordCheckpoint({ projectRoot: x.root, request: request(), out: x.out() }), q = request();
    const ids = { transitionId: f.uuid(), reservationId: f.uuid() }, owner = 'worker-owner';
    const actorId = sessionId ?? target.sessionId ?? null;
    const before = t.transitionSnapshot({ q, run: x.run(), canonical: x.canonical(), observation: observed.value.observation,
      action: { schemaVersion: 2, kind, before: { registry: null }, target: actorId ? { sessionId: actorId } : {}, owner, nodes, authorization: x.auth, profile: x.profile } },
    { profileObservation: x.profileObservation, observeWorktree: o => worktree(o.path) });
    const action = { schema: 'fvs/auto-transition-request', schemaVersion: 2, runId: x.runId, ...ids, kind, stage, nodes, owner, expectedHeadSha256: q.expectedHeadSha256, before, target, authorization: x.auth, profile: x.profile, basis: null };
    const actionRef = f.json(x.owned, 'action', action), intent = { ...ids, stage, nodes, owner, effect, request: actionRef };
    const produced = await driver.runPairedEffect({ projectRoot: x.root, request: request({ position: 'before', intent, beforeEventSha256: null, outcome: null, effect: null }), out: x.out() });
    if (produced.status !== 'command-completed') throw Error(produced.status);
    let raw; try { raw = JSON.parse(t.transitionBound(t.transitionBound(produced.producer.command).stdout, false)); } catch {}
    const completion = f.json(x.owned, 'completion', { schema: 'fvs/auto-transition-completion', schemaVersion: 2, runId: x.runId, ...ids, actionSha256: m.memoryHash(action),
      beforeEventSha256: produced.before.value.recordedEventSha256, command: produced.producer.command, result: f.json(x.owned, 'producer-result', result(raw)) });
    const actual = after(raw, produced.before.value.recordedEventSha256, intent);
    const afterRequest = request({ position: 'after', intent, beforeEventSha256: produced.before.value.recordedEventSha256,
      outcome: 'succeeded', effect: { evidence: [completion], resolution: null, ...actual } });
    afterRequest.associations = afterRequest.associations.filter(r => !actual.association || r.sha256 !== actual.association.sha256);
    const recorded = await driver.recordAfter({ projectRoot: x.root, request: afterRequest, out: x.out() });
    return { action, actionRef, produced, recorded, completion, raw };
  }
  async function releaseReview(binding) {
    const assignmentId = f.uuid(), branchRef = 'refs/heads/review-' + f.uuid().slice(0, 8), startup = { challenge: f.uuid(), attemptId: f.uuid(), phase: 'resume', resumeId: f.uuid() };
    let association;
    const launched = await paired({ kind: 'launch', stage: 'review', nodes: [19], effect: { kind: 'ao-launch', projectId: 'fixture-project', intendedBranchRef: branchRef, assignmentId, sessionId: null },
      target: { projectId: 'fixture-project', branchRef, assignmentId, selectionStage: 'spec_review', invocation: null, startup, resumeOf: null }, after: (raw, before, intent) => {
        association = x.associate(raw.session.id, raw.worktree, intent, before); associations = [association]; return { sessionId: raw.session.id, association };
      } });
    const actor = { projectId: 'fixture-project', sessionId: launched.raw.session.id, reservationId: launched.action.reservationId, assignmentId, worktree: worktree(launched.raw.worktree), profile: null };
    const caller = s => ({ attemptId: s.attemptId, phase: s.phase, target: { projectId: actor.projectId, sessionId: actor.sessionId, resumeId: s.resumeId } });
    const startupRequest = t.disabledWorkerMemoryRequest(launched.action.before.fixed, caller(startup));
    const startupAck = f.json(x.owned, 'startup', { schema: 'fvs/auto-startup-ack', schemaVersion: 2, runId: x.runId, actionSha256: m.memoryHash(launched.action),
      beforeEventSha256: launched.produced.before.value.recordedEventSha256, challenge: startup.challenge, actor, memoryRequest: startupRequest, memoryOut: null,
      memoryEvidence: t.workerMemoryEvidence(null, startupRequest, launched.action.before.fixed), waiting: true });
    const prep = await paired({ kind: 'prepare-input', stage: 'integration', sessionId: actor.sessionId,
      target: { sessionId: actor.sessionId, association, launch: launched.actionRef, startupAck, startupRequest, candidate: { commit: actor.worktree.commit, expectedTree: actor.worktree.tree } },
      result: () => ({ status: 'prepared', candidate: { commit: actor.worktree.commit } }) });
    const packetRequest = t.disabledWorkerMemoryRequest(launched.action.before.fixed, caller({ attemptId: f.uuid(), phase: 'resume', resumeId: f.uuid() }));
    const packet = f.json(x.owned, 'review-work', { schema: 'fvs/auto-work-packet', schemaVersion: 2, runId: x.runId, actionSha256: m.memoryHash(launched.action), launch: launched.actionRef,
      beforeEventSha256: launched.produced.before.value.recordedEventSha256, challenge: f.uuid(), actor, deliveryHandle: 'release-' + f.uuid(), memoryRequest: packetRequest,
      procedure: 'lean-spec-review/Other', inputs: [binding.binding, binding.input], resumeOf: null, startMarker: path.join(x.owned, 'review-start.json') });
    await paired({ kind: 'release', stage: 'integration', target: { sessionId: actor.sessionId, association, packet, handle: t.readWorkPacket(packet).deliveryHandle } });
    const markerPath = t.readWorkPacket(packet).startMarker;
    const ack = auto.acknowledgeWorkPacket({ projectRoot: x.root, ao: { tool: f.ref(x.tool), stateHome: x.stateHome, projectId: 'fixture-project' }, out: x.out(),
      actor, expectedMemoryRequest: packetRequest, memoryOut: null, packet, marker: markerPath });
    if (!ack.mayStart) throw Error('fixture start refused');
    return { packet, marker: f.ref(markerPath), actor, launch: launched };
  }
  return { driver, auto, t, m, x, inputs, context, request, paired, releaseReview };
}
module.exports = { ...f, world };
