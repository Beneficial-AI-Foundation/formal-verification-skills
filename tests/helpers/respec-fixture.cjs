// Protocol fixtures: AO/Beads/reviews are doubles, never canonical proof evidence.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const rf = require('./resume-fixture.cjs');
const bf = require('./bundle-fixture.cjs');
async function fixture(auto, bundle, transitions, parent, policy = {}) {
  const execution=await import('../../scripts/fvs-execution.mjs');
  const { memoryHash } = await import('../../scripts/fvs-project-memory.mjs');
  const x = rf.fixture(auto, parent, null, policy), y = bf.fixture(auto, x.owned, x.root);
  const view = auto.readState({ projectRoot: x.root, requireAgreement: true }), approval = structuredClone(view.agreement.agreement);
  for (const k of ['choicesGeneration', 'contextSha256', 'recordedAt']) delete approval[k];
  approval.payload.contextVersion++; approval.payload.execution = { actions: ['fixture delegated work'], reference: 'fixture:execution' };
  approval.approvedPayloadSha256 = auto.agreementPayloadSha256(approval);
  fs.writeFileSync(rf.roadmapFile(x.root), '## Decisions\n```fvs-auto-agreement\n' + JSON.stringify(approval) + '\n```\n');
  auto.recordAgreement({ projectRoot: x.root, agreement: approval, confirmOverwrite: true });
  const canonical = auto.readState({ projectRoot: x.root, requireAgreement: true });
  const auth = rf.json(x.owned, 'authorization', { schema: 'fvs/auto-action-authorization', schemaVersion: 1, agreementContextSha256: canonical.agreement.contextSha256,
    approvedPayloadSha256: approval.approvedPayloadSha256, execution: approval.payload.execution,
    correspondence: ['construct', 'launch', 'prepare-input', 'release', 'terminate', 'compose-spec', 'materialize-proof', 'registry-revise', 'freeze', 'check', 'accept', 'handoff'].map(kind => ({ kind, action: 'fixture delegated work', reference: 'fixture:execution' })) });
  const project = { id: 'fixture-project', path: x.root, agent: 'fixture', config: {} }, writeControl = x.writeControl;
  x.writeControl = (extra = {}) => writeControl({ project, ...extra }); x.writeControl();
  const controller = transitions.redactAOProfile(Buffer.from(JSON.stringify({ project })));
  const profile = rf.json(x.owned, 'profile', { schema: 'fvs/auto-stage-profile', schemaVersion: 1, source: 'protocol only', controller,
    stages: Object.fromEntries(['specification', 'review', 'proof', 'integration', 'check', 'acceptance', 'extraction'].map(k => [k, { harness: 'fixture', model: 'fixture', effort: 'fixture', provenance: 'no real model invocation' }])) });
  if(policy.schemaVersion===2)x.invoke();
  const b = y.request(), h = await y.register(b), a = await y.register(b, 20); b.registry.expectedHeadSha256 = a.recordSha256;
  const stages = { extraction: b.extraction, graph: b.graph, plan: b.plan, baseline: null, acceptedStore: null };
  x.invoke(x.request({ inputs: stages, priorAccounting: policy.schemaVersion===2?null:x.accounting() }));
  if(policy.schemaVersion===2){b.schemaVersion=2;b.execution=execution.runControl(auto.readRuntimeState({projectRoot:x.root}).state.run);delete b.deadlineMs;}
  b.runtime = { root: x.root, state: rf.ref(path.join(x.root, '.formalising/auto-fv/resume/state.json')), absenceReason: null }; b.absenceReasons.runtime = null;
  const prior = await bundle.buildReviewBundle(b, y.out('prior-bundle')), priorContext = bundle.bundleExpectedContext(b);
  const feedback = rf.json(x.owned, 'owner-feedback', { owner: 'protocol owner reference', requests: ['revise H', 'revise A'], authority: 'not human authentication' });
  const version = r => ({ node: r.record.defId, recordSha256: r.recordSha256, candidateSha256: r.record.candidateSha256 });
  const initialItems = [h, a].map((r, i) => ({ itemId: i ? 'A' : 'H', nodes: [r.record.defId], expectedRecords: [version(r)], feedback: i ? 'revise A' : 'revise H', evidence: [feedback], response: null }));
  const revisionId = rf.uuid();
  let associations = [];
  x.respecRequest = (operation = 'inspect', inspectEvidence = null) => {
    const current = x.invoke(x.request({ inputs: stages, associations }));
    const req = structuredClone(b); req.bundleId = rf.uuid(); if(policy.schemaVersion!==2)req.deadlineMs = Date.now() + 120000; req.source = current.q.source;
    req.runtime.state = rf.ref(path.join(x.root, '.formalising/auto-fv/resume/state.json'));
    return { schema: 'fvs/auto-respec-request', schemaVersion:policy.schemaVersion??1, revisionId, attemptId: current.q.attemptId, operation,
      ownerFeedback: { ownerReference: 'protocol-owner-request', evidence: feedback }, priorBundle: { manifest: prior.manifest, expectedContext: priorContext },
      current: { bundle: req, resume: { request: rf.ref(path.join(current.out, 'request.json')), result: rf.ref(path.join(current.out, 'result.json')), committedHeadSha256: current.result.committedHeadSha256 },
        memory: policy.schemaVersion===2&&policy.memory!=='beads'?{mode:'disabled'}:{...(policy.schemaVersion===2?{mode:'beads'}:{}),request: rf.ref(path.join(current.result.observation.memory.out, 'request.json')), result: rf.ref(path.join(current.result.observation.memory.out, 'result.json')) }, authorization: auth, profile },
      requestedItems: structuredClone(initialItems), inspectEvidence, ...(policy.schemaVersion===2?{execution:req.execution}:{deadlineMs:req.deadlineMs}) };
  };
  x.response = (q, item) => rf.json(x.owned, 'response', { schema: 'fvs/auto-respec-response', schemaVersion: 1, revisionId, itemId: item.itemId,
    ownerFeedbackSha256: feedback.sha256, priorCandidates: item.expectedRecords, contracts: item.expectedRecords, correspondenceEvidence: [feedback] });
  const outputs = fs.mkdtempSync(path.join(parent ?? fs.realpathSync(os.tmpdir()), 'fvs-respec-outputs-'));
  x.output = name => path.join(outputs, name + '-' + rf.uuid()); x.registry = y.registry; x.bundle = b; x.registryFixture = y;
  x.compose = () => {
    const intent = x.launch([19]); intent.stage = 'specification';
    const lb = x.invoke(x.request({ inputs: stages, transition: x.before(intent) }), 'checkpoint');
    const worker = path.join(x.owned, 'spec-worker'); rf.git(x.root, 'worktree', 'add', '-q', '-b', intent.effect.intendedBranchRef.slice(11), worker, 'HEAD');
    x.rows.push(rf.row('spec-worker')); x.writeControl();
    let association = x.associate('spec-worker', worker, intent, lb.result.recordedEventSha256);
    x.invoke(x.request({ inputs: stages, transition: x.after(lb, { sessionId: 'spec-worker', association, evidence: [rf.json(x.owned, 'owned-launch', { authority: 'AO double only; actual owned Git worktree' })], resolution: null }) }), 'checkpoint');
    fs.writeFileSync(path.join(worker, 'Extra.lean'), 'def Extra := Nat\n'); rf.git(worker, 'add', '--', 'Extra.lean'); rf.git(worker, 'commit', '-qm', 'test(fixture): retain specification candidate');
    association = x.associate('spec-worker', worker, intent, lb.result.recordedEventSha256); associations = [association];
    const candidate = { commit: rf.git(worker, 'rev-parse', 'HEAD'), tree: rf.git(worker, 'rev-parse', 'HEAD^{tree}'), files: { 'Extra.lean': rf.ref(path.join(worker, 'Extra.lean')).sha256 }, assignment: association };
    const target = { parent: rf.git(x.root, 'rev-parse', 'HEAD'), candidates: [candidate], files: candidate.files }, q = x.request({ inputs: stages, associations });
    const local = x.local([], 'integration'), view = auto.readState({ projectRoot: x.root, requireAgreement: true }), source = { root: x.root, commit: q.source.commit, tree: q.source.expectedTree,
      branchRef: rf.git(x.root, 'symbolic-ref', 'HEAD'), gitCommonDir: x.root + '/.git', dirty: false };
    const snapshot = transitions.transitionSnapshot({ q, run: auto.readRuntimeState({ projectRoot: x.root }).state.run, canonical: { view, envelope: view.agreement.agreement },
      observation: { identity: { source }, associations: [{ reference: association, value: JSON.parse(fs.readFileSync(association.file)) }] },
      action: { before: { registry: { root: y.registry } }, target, authorization: auth, profile, owner: local.owner, nodes: local.nodes } }, { profileObservation: controller });
    const action = { schema: 'fvs/auto-transition-request', schemaVersion: 1, runId: x.runId, transitionId: local.transitionId, reservationId: local.reservationId, kind: 'compose-spec',
      stage: local.stage, nodes: local.nodes, owner: local.owner, expectedHeadSha256: q.expectedHeadSha256, before: snapshot, target, authorization: auth, profile, basis: null };
    const actionRef = rf.json(x.owned, 'compose-action', action); local.request = actionRef; q.transition = x.before(local); const before = x.invoke(q, 'checkpoint');
    const argv = ['/usr/bin/git', '-C', x.root, 'merge', '--ff-only', candidate.commit], env = { PATH: '/usr/bin:/bin', LANG: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
    const startedAtMs = Date.now(), p = spawnSync(argv[0], argv.slice(1), { cwd: x.root, env }), endedAtMs = Date.now(); if (p.status !== 0) throw Error(p.stderr.toString());
    const stream = (name, bytes) => { const file = path.join(x.owned, name + rf.uuid()); fs.writeFileSync(file, bytes); return rf.ref(file); };
    const command = rf.json(x.owned, 'compose-command', { schema: 'fvs/auto-command-receipt', schemaVersion: 1, runId: x.runId, transitionId: action.transitionId,
      actionSha256: memoryHash(action), argv, cwd: x.root, env, startedAtMs, endedAtMs, exitCode: p.status, signal: p.signal, error: null, tool: rf.ref('/usr/bin/git'), stdout: stream('stdout', p.stdout), stderr: stream('stderr', p.stderr) });
    const result = rf.json(x.owned, 'composed', { source: candidate.commit });
    const completion = rf.json(x.owned, 'compose-completion', { schema: 'fvs/auto-transition-completion', schemaVersion: 1, runId: x.runId, transitionId: action.transitionId, reservationId: action.reservationId,
      actionSha256: memoryHash(action), beforeEventSha256: before.result.recordedEventSha256, command, result });
    const after = x.invoke(x.request({ inputs: stages, associations, transition: x.after(before, { sessionId: null, association: null, evidence: [completion], resolution: null }) }), 'checkpoint');
    return { before, after, completion, candidate };
  };
  return x;
}
module.exports = { ...rf, fixture };
