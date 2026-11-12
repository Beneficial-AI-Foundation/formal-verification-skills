// Shared only by the new driver tests. Real Git/16/22, owned AO/Beads doubles; no proof evidence.
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const f = require('./transition-v2-fixture.cjs');
async function world(engineRoot = path.resolve(__dirname, '../..'), policy = {}) {
  const module = name => pathToFileURL(path.join(engineRoot, 'scripts', name)).href;
  const [driver, auto, t, m] = await Promise.all([import(module('fvs-auto-driver.mjs')), import(module('fvs-auto.mjs')), import(module('fvs-auto-transitions.mjs')), import(module('fvs-project-memory.mjs'))]);
  const x = await f.fixture(auto, t, policy);
  const effects = `
if(args[0]==='spawn'){const cp=require('node:child_process'),branch=args[args.indexOf('--branch')+1],n=c.rows.filter(r=>/^review-worker/.test(r.id)).length,wt=n?c.workerPath+'-'+n:c.workerPath;
 const p=cp.spawnSync('/usr/bin/git',['-C',${JSON.stringify(x.root)},'worktree','add','-q','-b',branch,wt],{env:{PATH:'/usr/bin:/bin',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_NO_LAZY_FETCH:'1'}});
 if(p.status!==0)process.exit(p.status);
 const session={id:n?'review-worker-'+n:'review-worker',projectId:'fixture-project',role:'worker',harness:'fixture',activity:'idle',status:'idle',isTerminated:false,branch};c.rows.push(session);fs.writeFileSync(${JSON.stringify(x.control)},JSON.stringify(c));console.log(JSON.stringify({session,worktree:wt}));return;}
if(args[0]==='session'&&args[1]==='kill'){const r=c.rows.find(r=>r.id===args[2]);if(!r)process.exit(7);Object.assign(r,{isTerminated:true,status:'killed',activity:'exited'});fs.writeFileSync(${JSON.stringify(x.control)},JSON.stringify(c));console.log(JSON.stringify({session:r}));return;}
if(args[0]==='send'){console.log(JSON.stringify({deliveryHandle:args[args.indexOf('--client-message-id')+1],authority:'delivery-only'}));return;}
`;
  fs.writeFileSync(x.tool, fs.readFileSync(x.tool, 'utf8').replace("if (args[0] !== 'session'", effects + "if (args[0] !== 'session'"));
  x.writeControl({ workerPath: path.join(x.owned, 'review-worker') });
  let associations = [], sourceRoot = x.root;
  const inputs = { extraction: f.json(x.owned, 'fixture-extraction', { authority: 'metadata only; no extraction claim' }),
    plan: f.ref(path.resolve(__dirname, '../fixtures/auto-contract-registry/plan.json')), graph: f.ref(path.resolve(__dirname, '../fixtures/auto-contract-registry/graph.json')), baseline: null, acceptedStore: null };
  const source = () => ({ kind: 'git', root: sourceRoot, commit: f.git(sourceRoot, 'rev-parse', 'HEAD'), expectedTree: f.git(sourceRoot, 'rev-parse', 'HEAD^{tree}') });
  const context = () => { const q = x.request({ inputs, associations, source: source() }); return Object.fromEntries(['runId', 'ao', 'source', 'inputs', 'associations', 'priorAccounting'].map(k => [k, q[k]])); };
  const request = transition => driver.prepareCurrentRequest({ projectRoot: x.root, context: context(), phase: 'resume', transition: transition ?? null });
  const worktree = p => ({ path: p, gitDir: fs.realpathSync(path.resolve(p, f.git(p, 'rev-parse', '--git-dir'))), gitCommonDir: fs.realpathSync(path.resolve(p, f.git(p, 'rev-parse', '--git-common-dir'))),
    branchRef: f.git(p, 'symbolic-ref', 'HEAD'), commit: f.git(p, 'rev-parse', 'HEAD'), tree: f.git(p, 'rev-parse', 'HEAD^{tree}'), dirty: f.git(p, 'status', '--porcelain=v1', '--untracked-files=all') !== '' });
  // `basis` is the engine's v2 explanation of this successor (the prior recorded paired output, optionally with the
  // consumed actor work completion); the engine validates it whenever present and requires it once acceptance is stale.
  async function paired({ kind, stage, nodes = [], target, sessionId = null, registryRoot = null, effect = { kind: 'local', operation: stage }, result = raw => raw, after = () => ({ sessionId: null, association: null }), execute = true, basis = null }) {
    const observed = await driver.recordCheckpoint({ projectRoot: x.root, request: request(), out: x.out() }), q = request();
    const ids = { transitionId: f.uuid(), reservationId: f.uuid() }, owner = 'worker-owner';
    const actorId = sessionId ?? target.sessionId ?? null;
    const before = t.transitionSnapshot({ q, run: x.run(), canonical: x.canonical(), observation: observed.value.observation,
      action: { schemaVersion: 2, kind, before: { registry: registryRoot ? { root: registryRoot } : null }, target: actorId ? { sessionId: actorId } : {}, owner, nodes, authorization: x.auth, profile: x.profile } },
    // A stop's resolution after AO removed the worker's worktree mirrors the engine's recorded absence; the engine decides.
    { profileObservation: x.profileObservation, observeWorktree: o => fs.existsSync(o.path) ? worktree(o.path) : t.absentWorktree(o) });
    const action = { schema: 'fvs/auto-transition-request', schemaVersion: 2, runId: x.runId, ...ids, kind, stage, nodes, owner, expectedHeadSha256: q.expectedHeadSha256, before, target, authorization: x.auth, profile: x.profile, basis };
    const actionRef = f.json(x.owned, 'action', action), intent = { ...ids, stage, nodes, owner, effect, request: actionRef };
    const beforeRequest = request({ position: 'before', intent, beforeEventSha256: null, outcome: null, effect: null });
    const produced = execute ? await driver.runPairedEffect({ projectRoot: x.root, request: beforeRequest, out: x.out() })
      : { status: 'before-recorded', mode: 'checkpoint-only', before: await driver.recordCheckpoint({ projectRoot: x.root, request: beforeRequest, out: x.out() }), producer: null };
    // A registry revision that records a non-pass state (e.g. recheck-required) is a completed producer run, not a failure.
    if (execute && !['command-completed', 'command-recorded-partial'].includes(produced.status)) throw Error(produced.status);
    let raw; if (execute) try { raw = JSON.parse(t.transitionBound(t.transitionBound(produced.producer.command).stdout, false)); } catch {}
    const completion = execute ? f.json(x.owned, 'completion', { schema: 'fvs/auto-transition-completion', schemaVersion: 2, runId: x.runId, ...ids, actionSha256: m.memoryHash(action),
      beforeEventSha256: produced.before.value.recordedEventSha256, command: produced.producer.command, result: f.json(x.owned, 'producer-result', result(raw)) }) : null;
    const actual = after(raw, produced.before.value.recordedEventSha256, intent);
    // An after that consumes released actor work (basis.workCompletion) must retain that exact envelope as evidence.
    const evidence = [...(actual.evidence ?? (completion ? [completion] : [])), ...(basis?.workCompletion ? [basis.workCompletion] : [])];
    const afterRequest = request({ position: 'after', intent, beforeEventSha256: produced.before.value.recordedEventSha256,
      outcome: 'succeeded', effect: { resolution: null, ...actual, evidence } });
    afterRequest.associations = afterRequest.associations.filter(r => !actual.association || r.sha256 !== actual.association.sha256);
    const recorded = await driver.recordAfter({ projectRoot: x.root, request: afterRequest, out: x.out() });
    return { action, actionRef, produced, recorded, completion, raw };
  }
  // Review defaults; a proof task passes its own stage/selection/invocation/procedure/inputs/nodes and binding null.
  async function releaseReview(binding, { basis = null, chain = basis !== null, stage = 'review', nodes = null, selectionStage = 'spec_review', invocation = null,
    procedure = 'lean-spec-review/Other', inputs = null, registryRoot = null } = {}) {
    // A chained successor compares whole snapshots, so every action in one chain observes the same registry root.
    const assignmentId = f.uuid(), branchRef = 'refs/heads/review-' + f.uuid().slice(0, 8), startup = { challenge: f.uuid(), attemptId: f.uuid(), phase: 'resume', resumeId: f.uuid() };
    let association;
    const launched = await paired({ kind: 'launch', stage, registryRoot, nodes: nodes ?? [t.transitionBound(binding.input).node], effect: { kind: 'ao-launch', projectId: 'fixture-project', intendedBranchRef: branchRef, assignmentId, sessionId: null },
      target: { projectId: 'fixture-project', branchRef, assignmentId, selectionStage, invocation, startup, resumeOf: null }, basis, after: (raw, before, intent) => {
        association = x.associate(raw.session.id, raw.worktree, intent, before); associations = [association]; return { sessionId: raw.session.id, association };
      } });
    let actor = { projectId: 'fixture-project', sessionId: launched.raw.session.id, reservationId: launched.action.reservationId, assignmentId, worktree: worktree(launched.raw.worktree), profile: null };
    const caller = s => ({ attemptId: s.attemptId, phase: s.phase, target: { projectId: actor.projectId, sessionId: actor.sessionId, resumeId: s.resumeId } });
    // A Beads run issues and primes a worker-readonly request, as the shared startup fixture does; disabled memory keeps its marker.
    const beads = auto.readState({ projectRoot: x.root }).state.choices.memory.mode === 'beads';
    const workerMemory = c => { if (!beads) return { request: t.disabledWorkerMemoryRequest(launched.action.before.fixed, c), out: null };
      const request = auto.prepareMemoryRequest({ projectRoot: x.root, ...c, operation: 'worker-readonly' }), out = x.out(); auto.primeMemory({ projectRoot: x.root, callerRoot: actor.worktree.path, request, out }); return { request, out }; };
    const startupMemory = workerMemory(caller(startup)), startupRequest = startupMemory.request;
    const startupAck = f.json(x.owned, 'startup', { schema: 'fvs/auto-startup-ack', schemaVersion: 2, runId: x.runId, actionSha256: m.memoryHash(launched.action),
      beforeEventSha256: launched.produced.before.value.recordedEventSha256, challenge: startup.challenge, actor, memoryRequest: startupRequest, memoryOut: startupMemory.out,
      memoryEvidence: t.workerMemoryEvidence(startupMemory.out, startupRequest, launched.action.before.fixed), waiting: true });
    const candidate = source();
    const prep = await paired({ kind: 'prepare-input', stage: 'integration', sessionId: actor.sessionId, registryRoot,
      target: { sessionId: actor.sessionId, association, launch: launched.actionRef, startupAck, startupRequest, candidate: { commit: candidate.commit, expectedTree: candidate.expectedTree } },
      result: () => ({ status: 'prepared', candidate: { commit: candidate.commit } }), basis: chain ? launched.recorded.basis : null, after: () => {
        const intent = launched.produced.before.value.request.transition.intent;
        association = x.associate(actor.sessionId, actor.worktree.path, intent, launched.produced.before.value.recordedEventSha256); associations = [association];
        return { sessionId: null, association: null };
      } });
    actor = { ...actor, worktree: worktree(actor.worktree.path) };
    const packetMemory = workerMemory(caller({ attemptId: f.uuid(), phase: 'resume', resumeId: f.uuid() })), packetRequest = packetMemory.request;
    const packet = f.json(x.owned, 'review-work', { schema: 'fvs/auto-work-packet', schemaVersion: 2, runId: x.runId, actionSha256: m.memoryHash(launched.action), launch: launched.actionRef,
      beforeEventSha256: launched.produced.before.value.recordedEventSha256, challenge: f.uuid(), actor, deliveryHandle: 'release-' + f.uuid(), memoryRequest: packetRequest,
      procedure, inputs: inputs ?? [binding.binding, binding.input], resumeOf: null, startMarker: path.join(x.owned, 'review-start-' + f.uuid() + '.json') });
    const released = await paired({ kind: 'release', stage: 'integration', registryRoot, target: { sessionId: actor.sessionId, association, packet, handle: t.readWorkPacket(packet).deliveryHandle }, basis: chain ? prep.recorded.basis : null });
    const markerPath = t.readWorkPacket(packet).startMarker;
    const ack = auto.acknowledgeWorkPacket({ projectRoot: x.root, ao: { tool: f.ref(x.tool), stateHome: x.stateHome, projectId: 'fixture-project' }, out: x.out(),
      actor, expectedMemoryRequest: packetRequest, memoryOut: packetMemory.out, packet, marker: markerPath });
    if (!ack.mayStart) throw Error('fixture start refused');
    return { packet, marker: f.ref(markerPath), actor, launch: launched, prepared: prep, released };
  }
  return { driver, auto, t, m, x, inputs, context, request, paired, releaseReview, source, useSource: root => { sourceRoot = root; }, useAssociations: list => { associations = list; } };
}
module.exports = { ...f, world };
