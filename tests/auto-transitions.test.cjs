// Component protocol only. AO/Beads are doubles; checker simulation is supplied
// by code below, never enabled by an input flag or a fabricated proof receipt.
const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const f = require('./helpers/resume-fixture.cjs');
let auto, t, resume, memory, registry, checker; const owned = [];
before(async () => { auto = await import('../scripts/fvs-auto.mjs'); t = await import('../scripts/fvs-auto-transitions.mjs'); resume = await import('../scripts/fvs-auto-resume.mjs'); memory = await import('../scripts/fvs-project-memory.mjs'); registry = await import('../scripts/fvs-contract-registry.mjs'); checker = await import('../scripts/fvs-checker-auto.mjs'); });
after(() => { if (!process.env.FVS_TRANSITIONS_QUAL_OUT && !process.env.FVS_TRANSITIONS_NATIVE_OUT) for (const p of owned) fs.rmSync(p, { recursive: true, force: true }); });
const reject = (code, fn) => assert.throws(fn, (e) => e.code === code, code);
function fixture(native = false) {
  const output = native ? process.env.FVS_TRANSITIONS_NATIVE_OUT : process.env.FVS_TRANSITIONS_QUAL_OUT;
  if (output && !fs.existsSync(output)) fs.mkdirSync(output);
  const bd = native ? fs.realpathSync(process.env.FVS_TRANSITIONS_BD) : null;
  const x = f.fixture(auto, output ? fs.realpathSync(output) : undefined, bd); owned.push(x.owned);
  if (native) {
    assert.equal(process.env.FVS_TRANSITIONS_NATIVE, '1');
    assert.equal(f.sha(fs.readFileSync(bd)), '842879338715dc25b5a9f48864ae55846e9792195876e2803d6b51d3ec524a92');
    const args = ['--sandbox', 'init', '--backend', 'dolt', '--skip-agents', '--skip-hooks', '--non-interactive', '--prefix', 'transitions-fixture'];
    const startedAtMs = Date.now(), p = spawnSync(bd, args, { cwd: x.root, env: process.env, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }), endedAtMs = Date.now();
    const stream = (suffix, b) => { const file = path.join(x.owned, 'native-init.' + suffix); fs.writeFileSync(file, b ?? Buffer.alloc(0)); return f.ref(file); };
    f.json(x.owned, 'native-init-receipt', { argv: [bd, ...args], cwd: x.root, startedAtMs, endedAtMs, exitCode: p.status, signal: p.signal, error: p.error?.code ?? null, tool: f.ref(bd), stdout: stream('stdout', p.stdout), stderr: stream('stderr', p.stderr) });
    assert.equal(p.status, 0, p.stderr?.toString()); assert.equal(f.git(x.root, 'status', '--porcelain=v1', '--untracked-files=all'), '?? .gitignore');
    f.git(x.root, 'add', '--', '.gitignore'); f.git(x.root, 'commit', '-qm', 'fixture native backend setup');
    const whereArgs = ['-C', x.root, '--sandbox', '--readonly', 'where', '--json'], start = Date.now(), where = spawnSync(bd, whereArgs, { cwd: x.root, env: process.env, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }), finish = Date.now();
    const stdout = path.join(x.owned, 'native-where.stdout'), stderr = path.join(x.owned, 'native-where.stderr'); fs.writeFileSync(stdout, where.stdout ?? Buffer.alloc(0)); fs.writeFileSync(stderr, where.stderr ?? Buffer.alloc(0));
    f.json(x.owned, 'native-where-receipt', { argv: [bd, ...whereArgs], cwd: x.root, startedAtMs: start, endedAtMs: finish, exitCode: where.status, signal: where.signal, error: where.error?.code ?? null, tool: f.ref(bd), stdout: f.ref(stdout), stderr: f.ref(stderr) });
    assert.equal(where.status, 0, where.stderr?.toString());
    auto.recordMemory({ projectRoot: x.root, registration: { backend: 'beads', canonicalRoot: x.root, storeDir: path.join(x.root, '.beads'), databasePath: JSON.parse(where.stdout).database_path, bdPath: bd } });
  }
  const view = auto.readState({ projectRoot: x.root, requireAgreement: true }), a = JSON.parse(JSON.stringify(view.agreement.agreement));
  for (const k of ['choicesGeneration', 'contextSha256', 'recordedAt']) delete a[k];
  a.payload.contextVersion += 1; a.payload.execution = { actions: ['fixture delegated work'], reference: 'fixture:execution' }; a.approvedPayloadSha256 = auto.agreementPayloadSha256(a);
  fs.writeFileSync(f.roadmapFile(x.root), '## Decisions\n```fvs-auto-agreement\n' + JSON.stringify(a) + '\n```\n');
  auto.recordAgreement({ projectRoot: x.root, agreement: a, confirmOverwrite: true });
  x.canonical = () => { const view = auto.readState({ projectRoot: x.root, requireAgreement: true }); return { view, envelope: view.agreement.agreement }; };
  const current = x.canonical();
  x.project = { id: 'fixture-project', path: x.root, agent: 'fixture', config: { worker: { agent: 'fixture', agentConfig: { model: 'fixture' } } } };
  const writeControl = x.writeControl; x.writeControl = (extra = {}) => writeControl({ project: x.project, ...extra }); x.writeControl();
  x.profileObservation = t.redactAOProfile(Buffer.from(JSON.stringify({ project: x.project })));
  x.auth = f.json(x.owned, 'authorization', { schema: 'fvs/auto-action-authorization', schemaVersion: 1, agreementContextSha256: current.view.agreement.contextSha256,
    approvedPayloadSha256: a.approvedPayloadSha256, execution: a.payload.execution, correspondence: ['construct', 'launch', 'prepare-input', 'release', 'terminate', 'compose-spec', 'materialize-proof', 'registry-revise', 'freeze', 'check', 'accept', 'handoff'].map((kind) => ({ kind, action: 'fixture delegated work', reference: 'fixture:execution' })) });
  x.profile = f.json(x.owned, 'profiles', { schema: 'fvs/auto-stage-profile', schemaVersion: 1, source: 'explicit fixture; no real model qualification', controller: x.profileObservation, stages: Object.fromEntries(['reconcile', 'extraction', 'specification', 'review', 'proof', 'integration', 'check', 'acceptance', 'research', 'fc_spec', 'spec_review', 'fc_proof_plan', 'fc_proof_execution'].map((s) => [s, { harness: 'fixture', model: 'fixture', effort: 'fixture', provenance: 'requested fixture profile; effective settings unknown' }])) });
  x.initial = x.invoke();
  x.snapshot = (q = x.request(), action = { before: { registry: x.registryRoot ? { root: x.registryRoot } : null }, target: {}, authorization: x.auth, profile: x.profile }) => t.transitionSnapshot({ q, run: auto.readRuntimeState({ projectRoot: x.root }).state.run, canonical: x.canonical(), observation: x.initial.result.observation, action }, { ...x.transitionServices, profileObservation: x.profileObservation });
  x.action = (kind = 'construct', target = { procedure: 'auto-extract' }, options = {}) => {
    const { intent: supplied, ...aOptions } = options;
    const intent = supplied ?? x.local(options.nodes ?? [], options.stage ?? 'extraction'), q = x.request();
    if (kind === 'launch') {
      let invocation = null;
      if (intent.stage === 'proof') {
        const run = auto.readRuntimeState({ projectRoot: x.root }).state.run, startedAtMs = Date.now(), budgetMs = 4 * 3600000;
        invocation = f.json(x.owned, 'proof-invocation', { schema: 'fvs/auto-proof-invocation', schemaVersion: 1, runId: x.runId, invocationId: f.uuid(), startedAtMs, budgetMs, deadlineMs: Math.min(run.deadlineMs, startedAtMs + budgetMs) });
      }
      target = { selectionStage: ({ specification: 'fc_spec', proof: 'fc_proof_execution', review: 'spec_review' })[intent.stage] ?? intent.stage, invocation, ...target };
    }
    const a = { schema: 'fvs/auto-transition-request', schemaVersion: 1, runId: x.runId, transitionId: intent.transitionId, reservationId: intent.reservationId, kind, stage: intent.stage, nodes: intent.nodes, owner: intent.owner,
      expectedHeadSha256: q.expectedHeadSha256, before: x.snapshot(q), target, authorization: x.auth, profile: x.profile, basis: null, ...aOptions };
    const actionRef = f.json(x.owned, 'action', a); intent.request = actionRef;
    q.transition = x.before(intent); return { a, actionRef, q, intent };
  };
  x.startup = () => {
    const action = x.action('launch', { projectId: 'fixture-project', branchRef: 'refs/heads/fixture-stage', assignmentId: f.uuid(), startup: { challenge: f.uuid(), attemptId: f.uuid(), phase: 'resume', resumeId: f.uuid() } }, { stage: 'proof' });
    const actor = { projectId: 'fixture-project', sessionId: 'owned-worker', reservationId: action.a.reservationId, assignmentId: action.a.target.assignmentId,
      worktree: { path: x.root, gitDir: path.join(x.root, '.git'), gitCommonDir: path.join(x.root, '.git'), branchRef: f.git(x.root, 'symbolic-ref', 'HEAD'), commit: f.git(x.root, 'rev-parse', 'HEAD'), tree: f.git(x.root, 'rev-parse', 'HEAD^{tree}'), dirty: false }, profile: null };
    const allocated = action.a.target.startup;
    const request = auto.prepareMemoryRequest({ projectRoot: x.root, attemptId: allocated.attemptId, phase: allocated.phase, operation: 'worker-readonly', target: { projectId: actor.projectId, sessionId: actor.sessionId, resumeId: allocated.resumeId } });
    const memoryOut = x.out(); auto.primeMemory({ projectRoot: x.root, callerRoot: x.root, request, out: memoryOut });
    const beforeEventSha256 = 'd'.repeat(64);
    const acknowledgement = f.json(x.owned, 'startup-ack', { schema: 'fvs/auto-startup-ack', schemaVersion: 1, runId: x.runId, actionSha256: memory.memoryHash(action.a), beforeEventSha256, challenge: allocated.challenge, actor, memoryRequest: request, memoryOut, memoryEvidence: t.workerMemoryEvidence(memoryOut, request), waiting: true });
    const services = { memoryOut, beforeForAction: () => beforeEventSha256, verifyMemory: (o) => auto.verifyMemoryBootstrap({ ...o, projectRoot: x.root }), observeActor: (a) => a };
    return { action, actor, request, memoryOut, acknowledgement, services };
  };
  x.packet = () => {
    const s = x.startup();
    s.request = auto.prepareMemoryRequest({ projectRoot: x.root, attemptId: f.uuid(), phase: 'resume', operation: 'worker-readonly', target: { projectId: s.actor.projectId, sessionId: s.actor.sessionId, resumeId: f.uuid() } });
    s.memoryOut = x.out(); auto.primeMemory({ projectRoot: x.root, callerRoot: x.root, request: s.request, out: s.memoryOut }); s.services.memoryOut = s.memoryOut;
    s.services.currentClock = () => { const v = auto.readRuntimeState({ projectRoot: x.root }); return { runId: v.state.run.runId, startedAtMs: v.state.run.startedAtMs, deadlineMs: v.state.run.deadlineMs, lastObservedAtMs: v.lastObservedAtMs }; };
    s.services.verifyReleasedPacket = () => ({ clock: { ...s.services.currentClock(), observedAtMs: Date.now() } }); // Unit boundary; integration uses the fixed reader.
    const ref = f.json(x.owned, 'packet', { schema: 'fvs/auto-work-packet', schemaVersion: 1, runId: x.runId, actionSha256: memory.memoryHash(s.action.a), launch: s.action.actionRef, beforeEventSha256: s.services.beforeForAction(), challenge: f.uuid(), actor: s.actor,
      deliveryHandle: 'release-' + f.uuid(), memoryRequest: s.request, procedure: 'lean-verify/controller-direct', inputs: [s.action.a.target.invocation], resumeOf: null, startMarker: path.join(x.owned, 'start-' + f.uuid() + '.json') });
    return { ...s, packet: ref, marker: t.readWorkPacket(ref).startMarker };
  };
  return x;
}
function assess(x, item, actual = item.a.before, extra = {}, services = {}) {
  return t.assessTransition({ actionRef: item.actionRef, q: item.q, view: auto.readRuntimeState({ projectRoot: x.root }), canonical: x.canonical(), run: auto.readRuntimeState({ projectRoot: x.root }).state.run,
    actual, reasons: [], now: Date.now(), ...extra }, services);
}
function commandReceipt(x, item, argv, result, before) {
  const env = { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  const startedAtMs = Date.now(), p = spawnSync(argv[0], argv.slice(1), { cwd: x.root, env }), endedAtMs = Date.now();
  assert.equal(p.status, 0, p.stderr?.toString());
  const stream = (name, b) => { const file = path.join(x.owned, name + f.uuid()); fs.writeFileSync(file, b); return f.ref(file); };
  const command = f.json(x.owned, 'actual-command', { schema: 'fvs/auto-command-receipt', schemaVersion: 1, runId: x.runId, transitionId: item.a.transitionId, actionSha256: memory.memoryHash(item.a), argv, cwd: x.root, env,
    tool: f.ref(fs.realpathSync(argv[0])), startedAtMs, endedAtMs, exitCode: p.status, signal: p.signal, error: p.error?.code ?? null, stdout: stream('stdout', p.stdout), stderr: stream('stderr', p.stderr) });
  return f.json(x.owned, 'completion', { schema: 'fvs/auto-transition-completion', schemaVersion: 1, runId: x.runId, transitionId: item.a.transitionId, reservationId: item.a.reservationId,
    actionSha256: memory.memoryHash(item.a), beforeEventSha256: before.result.recordedEventSha256, command, result: f.json(x.owned, 'materialized-result', result) });
}
function composition(x) {
  // Existing16 assigned actor is a migration input, never a guessed AO path.
  const intent = x.launch([19, 20]); intent.stage = 'specification';
  const beforeLaunch = x.invoke(x.request({ transition: x.before(intent) }), 'checkpoint');
  const worker = path.join(x.owned, 'author'); f.git(x.root, 'worktree', 'add', '-q', '-b', intent.effect.intendedBranchRef.slice(11), worker);
  fs.writeFileSync(path.join(worker, 'Defs.lean'), 'def Shared := Nat\n'); f.git(worker, 'add', 'Defs.lean'); f.git(worker, 'commit', '-qm', 'fixture candidate');
  x.rows.push(f.row('author')); x.writeControl();
  const assignment = x.associate('author', worker, intent, beforeLaunch.result.recordedEventSha256);
  x.invoke(x.request({ transition: x.after(beforeLaunch, { sessionId: 'author', association: assignment, evidence: [], resolution: null }) }), 'checkpoint');
  const request = x.request; x.request = (extra = {}) => request({ associations: [assignment], ...extra });
  const commit = f.git(worker, 'rev-parse', 'HEAD'), tree = f.git(worker, 'rev-parse', 'HEAD^{tree}'), files = { 'Defs.lean': f.sha(fs.readFileSync(path.join(worker, 'Defs.lean'))) };
  const item = x.action('compose-spec', { parent: f.git(x.root, 'rev-parse', 'HEAD'), candidates: [{ commit, tree, files, assignment }], files }, { stage: 'integration' });
  const before = x.invoke(item.q, 'checkpoint');
  const completion = commandReceipt(x, item, ['/usr/bin/git', '-C', x.root, '-c', 'core.hooksPath=/dev/null', 'merge', '--ff-only', commit], { status: 'materialized', commit, tree }, before);
  const afterRequest = () => x.request({ transition: x.after(before, { sessionId: null, association: null, evidence: [completion], resolution: null }) });
  return { item, before, completion, afterRequest, commit, tree, worker, assignment };
}
function effectDouble(x) {
  // Installed only in this owned fixture, never selected by a production flag.
  let code = fs.readFileSync(x.tool, 'utf8');
  const effects = `
if(args[0]==='spawn') {
 const cp=require('node:child_process'), i=args.indexOf('--branch'), branch=args[i+1];
 const p=cp.spawnSync('/usr/bin/git',['-C',${JSON.stringify(x.root)},'worktree','add','-q','-b',branch,c.workerPath],{env:{PATH:'/usr/bin:/bin',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_NO_LAZY_FETCH:'1'}});
 if(p.status!==0){process.stderr.write(p.stderr);process.exit(p.status);}
 const session={id:c.nextSession,projectId:'fixture-project',role:'worker',activity:'idle',status:'idle',isTerminated:false,branch:'stale-hint'};
 c.rows.push(session);fs.writeFileSync(${JSON.stringify(x.control)},JSON.stringify(c));console.log(JSON.stringify({session}));return;
}
if(args[0]==='send'){console.log(JSON.stringify({deliveryHandle:args[args.indexOf('--client-message-id')+1],authority:'delivery-only'}));return;}
if(args[0]==='session'&&args[1]==='kill'){
 const row=c.rows.find(r=>r.id===args[2]);if(!row)process.exit(7);row.isTerminated=true;row.activity='terminated';row.status='terminated';
 fs.writeFileSync(${JSON.stringify(x.control)},JSON.stringify(c)); console.log(JSON.stringify({session:row}));return;
}
`;
  code = code.replace("if (args[0] !== 'session'", effects + "if (args[0] !== 'session'"); fs.writeFileSync(x.tool, code);
  x.writeControl({ nextSession: 'stage-worker', workerPath: path.join(x.owned, 'allocated-worktree') });
}
function controllerCompletion(x, item, before, command, result) {
  return f.json(x.owned, 'controller-completion', { schema: 'fvs/auto-transition-completion', schemaVersion: 1, runId: x.runId, transitionId: item.a.transitionId, reservationId: item.a.reservationId,
    actionSha256: memory.memoryHash(item.a), beforeEventSha256: before.result.recordedEventSha256, command, result: f.json(x.owned, 'producer-result', result) });
}
function syncRows(x) { x.rows = JSON.parse(fs.readFileSync(x.control)).rows; }
function trackRegistry(x) {
  x.registryRoot = path.join(x.owned, 'registry');
  x.plan = f.ref(path.join(f.ROOT, 'tests/fixtures/auto-contract-registry/plan.json')); x.graph = f.ref(path.join(f.ROOT, 'tests/fixtures/auto-contract-registry/graph.json'));
  const request = x.request, inputs = { extraction: f.json(x.owned, 'metadata-only-extraction', { authority: 'protocol simulation only; not a Rust/Lean producer claim' }), plan: x.plan, graph: x.graph, baseline: null, acceptedStore: null };
  x.request = (extra = {}) => request({ inputs, ...extra });
}
function contract(x, node = 19, patch = {}) {
  const name = node === 19 ? 'helper' : node === 20 ? 'root_sum' : 'root_twice';
  return { node, role: node === 19 ? 'helper' : 'root', statement: `m1demo.${name} = m1demo.${name}`, assumptions: [], grounding: { kind: 'none', reason: 'Labelled protocol fixture, no source correspondence asserted' },
    implementationDependencies: ['probe:m1demo.' + name], specDefinitions: [{ name: 'Shared', file: 'Defs.lean', sha256: f.sha(fs.readFileSync(path.join(x.root, 'Defs.lean'))) }],
    externalReferences: [{ name: 'Eq', provenance: { environment: { leanToolchain: 'leanprover/lean4:v4.31.0', lakeManifestSha256: 'a'.repeat(64) } } }], author: { session: 'fixture-author', harness: 'fixture', model: 'none', runId: f.uuid() }, ...patch };
}
function reviewedInvocation(x, c, verdict = 'pass') {
  const plan = { json: t.transitionBound(x.plan), sha256: x.plan.sha256 }, graph = { json: t.transitionBound(x.graph), sha256: x.graph.sha256 }, view = registry.validatePlan(plan, graph);
  assert.deepEqual(view.problems, []);
  const candidateSha256 = registry.candidateOf(c, registry.contextOf(plan, graph, view, c.node)), chain = registry.readChain(x.registryRoot);
  const reviewRun = f.uuid(), evidenceFile = path.join(x.owned, 'review-' + f.uuid() + '.md'); fs.writeFileSync(evidenceFile, 'Protocol fixture declared review only. Run ' + reviewRun + '; verdict ' + verdict + '; candidate ' + candidateSha256);
  const review = f.json(x.owned, 'review', { candidateSha256, registryHeadSha256: chain.records.at(-1)?.sha ?? null, verdict,
    reviewer: { session: 'fresh-reviewer-' + f.uuid(), harness: 'fixture', model: 'none', runId: reviewRun }, evidence: f.ref(evidenceFile) });
  const previous = chain.heads.get(c.node)?.sha ?? null;
  const invocation = { schema: 'fvs/auto-registry-invocation', schemaVersion: 1, plan: x.plan, graph: x.graph, registry: x.registryRoot, specRoot: x.root, contract: f.json(x.owned, 'contract', c), review, previous };
  const argv = [fs.realpathSync(process.execPath), path.join(f.ROOT, 'scripts/fvs-contract-registry.mjs'), previous === null ? 'register' : 'revise', '--plan', x.plan.file, '--graph', x.graph.file, '--registry', x.registryRoot, '--spec-root', x.root, '--contract', invocation.contract.file, '--review', review.file, ...(previous === null ? [] : ['--previous', previous])];
  return { request: f.json(x.owned, 'registry-invocation', invocation), review, candidateSha256, argv };
}
function publishRegistry(input) {
  const i = t.transitionBound(input.request), env = { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' };
  const startedAtMs = Date.now(), r = spawnSync(input.argv[0], input.argv.slice(1), { cwd: i.specRoot, env }), endedAtMs = Date.now();
  const stream = (name, b) => { const file = path.join(path.dirname(input.request.file), name + f.uuid()); fs.writeFileSync(file, b); return f.ref(file); };
  input.execution = { argv: input.argv, cwd: i.specRoot, env, tool: f.ref(fs.realpathSync(input.argv[0])), startedAtMs, endedAtMs, exitCode: r.status, signal: r.signal, error: r.error?.code ?? null, stdout: stream('registry.stdout', r.stdout), stderr: stream('registry.stderr', r.stderr) };
  const result = JSON.parse(r.stdout);
  assert.equal(r.status, result.code === 'recorded' && result.record?.state === 'changes-requested' ? 6 : 0, r.stderr?.toString());
  if (r.status === 6) assert.equal(result.record.review.verdict, 'changes-requested', 'recorded rejection remains unready');
  return result;
}
function stageLaunch(x, nodes = [19], stage = 'specification') {
  if (!x.registryRoot) trackRegistry(x);
  const intent = x.launch(nodes); intent.stage = stage;
  const item = x.action('launch', { projectId: 'fixture-project', branchRef: intent.effect.intendedBranchRef, assignmentId: intent.effect.assignmentId,
    startup: { challenge: f.uuid(), attemptId: f.uuid(), phase: 'resume', resumeId: f.uuid() } }, { intent });
  const before = x.invoke(item.q, 'checkpoint');
  const executed = (x.execute ?? auto.executeTransition)({ projectRoot: x.root, request: item.q, beforeOut: before.out, producerOut: x.out(), evidenceDir: x.out() });
  assert.equal(executed.status, 'command-completed'); syncRows(x);
  const command = t.transitionBound(executed.command), result = JSON.parse(t.transitionBound(command.stdout, false));
  const worktree = path.join(x.owned, 'allocated-worktree'); // Fixture controller input; production correlates Git porcelain.
  const assignment = x.associate(result.session.id, worktree, intent, before.result.recordedEventSha256, { rulesProfile: { provenance: 'retained-controller-observation', evidence: [x.profile] } });
  const completion = controllerCompletion(x, item, before, executed.command, result);
  const after = x.invoke(x.request({ transition: x.after(before, { sessionId: result.session.id, association: assignment, evidence: [completion], resolution: null }) }), 'checkpoint');
  return { item, before, executed, result, worktree, assignment, after };
}
describe('bounded transition authority and current facts', () => {
  it('actual15 copied freeze request binds by full bytes/value rather than its producer-owned filename', () => {
    const x = fixture(), q = x.request(), registryHead = 'b'.repeat(64), job = { runId: 'fixture-copied-request', baseline: { source: q.source }, registry: { root: path.join(x.owned, 'registry'), headSha256: registryHead } };
    const request = f.json(x.owned, 'original-request', job), copied = f.json(x.owned, 'producer-request-copy', job), frozen = f.json(x.owned, 'metadata-only-frozen', { input: copied, controllerInput: copied });
    assert.notEqual(copied.file, request.file); assert.equal(copied.sha256, request.sha256);
    let inspected = 0; const tools = { auto: f.ref(path.join(f.ROOT, 'scripts/fvs-auto.mjs')) }, validators = t.transitionValidators({ tools, git() { throw new Error('not used'); }, inspectBaseline() { inspected++; } });
    const actual = { baseline: frozen, source: { commit: q.source.commit, tree: q.source.expectedTree }, registry: { headSha256: registryHead }, fixed: { deadlineMs: Date.now() + 60000 } };
    const evidence = { result: { authority: 'expectations-only', targetProofsChecked: false }, command: { argv: [fs.realpathSync(process.execPath), tools.auto.file, 'freeze', '--request', request.file, '--out', x.out()] } };
    validators.verifyBaseline({ target: { request } }, actual, evidence); assert.equal(inspected, 1, 'metadata seam only, independent inspector explicitly stubbed; no Lean/proof claim');
    const altered = f.json(x.owned, 'different-request-copy', { ...job, runId: 'foreign' });
    reject('transition-freeze-unverified', () => validators.verifyBaseline({ target: { request } }, { ...actual, baseline: f.json(x.owned, 'foreign-frozen', { input: altered, controllerInput: copied }) }, evidence));
    assert.equal(inspected, 1);
  });
  it('compact runtime retains every v1 event/hash and reads legacy pretty JSON without migration', () => {
    const x = fixture(), file = path.join(x.root, '.formalising/auto-fv/resume/state.json'), compact = fs.readFileSync(file), before = auto.readRuntimeState({ projectRoot: x.root }), canonical = fs.readFileSync(f.stateFile(x.root));
    const pretty = Buffer.from(JSON.stringify(before.state, null, 2) + '\n'); assert.ok(compact.length < pretty.length);
    fs.writeFileSync(file, pretty); const after = auto.readRuntimeState({ projectRoot: x.root });
    assert.deepEqual(after.state, before.state); assert.equal(after.headSha256, before.headSha256); assert.deepEqual(fs.readFileSync(file), pretty);
    assert.deepEqual(fs.readFileSync(f.stateFile(x.root)), canonical);
  });
  it('empty no-spec construction uses actual agreement/memory/run and the production16 checkpoint extension', () => {
    const x = fixture(), item = x.action();
    assert.equal(assess(x, item).status, 'next-action-eligible');
    const result = auto.checkpointState({ projectRoot: x.root, request: item.q, out: x.out() });
    assert.equal(result.observation.transition.admissibility.status, 'next-action-eligible');
    assert.equal(result.effectExecutable, false);
    assert.equal(auto.readRuntimeState({ projectRoot: x.root }).state.history.at(-1).event.intent.request.sha256, item.actionRef.sha256);
    const e = auto.readRuntimeState({ projectRoot: x.root }).state.history.at(-1).event;
    assert.equal(e.observation, null); assert.deepEqual(t.readRuntimeObservation(e), result.observation);
  });
  it('public next-transition reconciles its own request and proposes construction without reserving/dispatching it', () => {
    const x = fixture(), q = x.request(), out = x.out(), currentRequest = { resume: q, registry: { root: path.join(x.owned, 'new-registry'), headSha256: null }, authorization: x.auth, profile: x.profile };
    const result = auto.nextTransition({ projectRoot: x.root, currentRequest, out });
    assert.equal(result.kind, 'construct'); assert.equal(result.executable, false);
    assert.ok([...auto.readRuntimeState({ projectRoot: x.root }).reservations.values()].every((r) => r.state === 'closed'));
    assert.equal(fs.readFileSync(x.log, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter((a) => a[0] === 'spawn').length, 0);
  });
  for (const mutation of ['changed', 'missing', 'symlink', 'oversized']) it('bound22 observation ' + mutation + ' refuses before another effect without rewriting history', () => {
    const x = fixture(), item = x.action(), before = x.invoke(item.q, 'checkpoint'), stateFile = path.join(x.root, '.formalising/auto-fv/resume/state.json'), stateBytes = fs.readFileSync(stateFile);
    const e = auto.readRuntimeState({ projectRoot: x.root }).state.history.at(-1).event, file = e.observationInput.file, original = file + '.original'; fs.copyFileSync(file, original);
    if (mutation === 'changed') fs.appendFileSync(file, ' ');
    if (mutation === 'missing') fs.renameSync(file, file + '.missing-original');
    if (mutation === 'symlink') { fs.renameSync(file, file + '.symlink-original'); fs.symlinkSync(file + '.symlink-original', file); }
    if (mutation === 'oversized') fs.writeFileSync(file, Buffer.alloc(memory.MEMORY_LIMITS.maxBytes + 1));
    reject(mutation === 'oversized' ? 'resume-history-invalid' : 'resume-evidence-invalid', () => auto.verifyTransition({ projectRoot: x.root, request: item.q, out: before.out }));
    assert.deepEqual(fs.readFileSync(stateFile), stateBytes); assert.equal(fs.existsSync(path.join(x.root, '.formalising/auto-fv/resume/effects')), false);
  });
  for (const [key, value] of [['authorization', null], ['profile', null]]) it('refuses missing ' + key + ' without state mutation', () => {
    const x = fixture(), item = x.action(), a = { ...item.a, [key]: value }, old = auto.readRuntimeState({ projectRoot: x.root }).fileSha256;
    reject('transition-invalid-input', () => t.readTransitionAction(f.json(x.owned, 'bad', a)));
    assert.equal(auto.readRuntimeState({ projectRoot: x.root }).fileSha256, old);
  });
  it('a null execution grant, stale context and hidden profile fallback never grant a stage', () => {
    const x = fixture(), item = x.action(), c = x.canonical(); c.envelope.payload.execution = null;
    reject('transition-grant-required', () => assess(x, item, item.a.before, { canonical: c }));
    const stale = x.canonical(); stale.view.agreement.contextSha256 = 'a'.repeat(64);
    reject('transition-grant-required', () => assess(x, item, item.a.before, { canonical: stale }));
    const p = t.transitionBound(x.profile); p.stages.extraction.effort = '';
    item.a.profile = f.json(x.owned, 'incomplete', p); item.actionRef = f.json(x.owned, 'bad-profile', item.a);
    reject('transition-profile-required', () => assess(x, item));
  });
  it('distinct FVS research/execution selections remain explicit and cannot collapse into a hidden override', () => {
    const x = fixture(), s = x.packet(), p = t.readWorkPacket(s.packet), launch = structuredClone(s.action.a), profile = t.transitionBound(x.profile);
    profile.stages.fc_proof_plan.model = 'different-planner'; launch.profile = f.json(x.owned, 'split-profile', profile);
    launch.before.fixed.profile = launch.profile;
    const launchRef = f.json(x.owned, 'split-launch', launch), combined = f.json(x.owned, 'forbidden-combined-packet', { ...p, launch: launchRef, actionSha256: memory.memoryHash(launch) });
    reject('transition-profile-required', () => t.readWorkPacket(combined));
    const prove = f.json(x.owned, 'explicit-proof-role', { ...p, launch: launchRef, actionSha256: memory.memoryHash(launch), procedure: 'lean-verify/prove-direct' });
    assert.equal(t.readWorkPacket(prove).procedure, 'lean-verify/prove-direct');
    const argv = t.launchArguments(launch, launchRef, 'a'.repeat(64));
    assert.ok(argv.includes('fixture')); assert.ok(!argv.includes('different-planner')); assert.ok(argv.at(-1).includes(launchRef.sha256)); assert.ok(argv.at(-1).includes('a'.repeat(64)));
  });
  it('requires the exact predecessor, fixed scope, source and unexpired original budget', () => {
    const x = fixture(), item = x.action(), run = auto.readRuntimeState({ projectRoot: x.root }).state.run;
    reject('transition-predecessor-stale', () => assess(x, item, item.a.before, { q: { ...item.q, expectedHeadSha256: null } }));
    const changed = structuredClone(item.a.before); changed.source.tree = 'b'.repeat(40);
    reject('transition-extra-drift', () => assess(x, item, changed));
    reject('transition-budget-exhausted', () => assess(x, item, item.a.before, { now: run.deadlineMs }));
    reject('transition-context-unavailable', () => assess(x, item, item.a.before, { reasons: ['association-git-or-session-mismatch'] }));
  });
  it('proof invocation expiry does not become a new per-node budget or another launch', () => {
    const x = fixture(), intent = x.launch([19]); intent.stage = 'proof';
    const item = x.action('launch', { projectId: 'fixture-project', branchRef: intent.effect.intendedBranchRef, assignmentId: intent.effect.assignmentId,
      startup: { challenge: f.uuid(), attemptId: f.uuid(), phase: 'resume', resumeId: f.uuid() } }, { intent });
    const clock = t.transitionBound(item.a.target.invocation), held = auto.readRuntimeState({ projectRoot: x.root }).fileSha256;
    reject('transition-invocation-exhausted', () => assess(x, item, item.a.before, { now: clock.deadlineMs + 1 }, { verifyProofLaunch() {} }));
    assert.equal(auto.readRuntimeState({ projectRoot: x.root }).fileSha256, held);
  });
  it('an unverified cache needs a paired completed explanation, never a worker ready flag', () => {
    const x = fixture(), item = x.action();
    reject('transition-explanation-required', () => assess(x, item, item.a.before, { reasons: ['acceptance-unverified'] }));
  });
  it('descriptor hooks/duplicate JSON/modified evidence are refused before callbacks', () => {
    const x = fixture(), item = x.action(); let calls = 0;
    Object.defineProperty(item.a, 'toJSON', { value() { calls++; return {}; } });
    assert.throws(() => t.transitionData(item.a)); assert.equal(calls, 0);
    const file = path.join(x.owned, 'duplicates.json'); fs.writeFileSync(file, '{"x":1,"x":2}'); reject('transition-invalid-input', () => t.transitionBound(f.ref(file)));
    fs.appendFileSync(item.actionRef.file, ' '); reject('transition-evidence-invalid', () => t.readTransitionAction(item.actionRef));
  });
  it('production JSON cannot select a checker simulation or ignored actor/effect mode', () => {
    const x = fixture(), out = x.out(), head = auto.readRuntimeState({ projectRoot: x.root }).headSha256;
    reject('transition-invalid-input', () => auto.nextTransition({ projectRoot: x.root, currentRequest: {}, out, simulation: true }));
    reject('transition-invalid-input', () => auto.executeTransition({ projectRoot: x.root, request: {}, beforeOut: out, producerOut: out, evidenceDir: out, simulation: true }));
    assert.equal(fs.existsSync(out), false); assert.equal(auto.readRuntimeState({ projectRoot: x.root }).headSha256, head);
  });
});
describe('actor startup and exactly-once packet start', () => {
  for (const phase of ['memory', 'actor', 'rollback', 'before-link', 'after-link']) it('non-proof start enforces the final original clock fence: ' + phase, () => {
    const x = fixture(), s = x.packet(), body = t.readWorkPacket(s.packet), launch = structuredClone(s.action.a);
    launch.stage = 'specification'; launch.target.selectionStage = 'fc_spec'; launch.target.invocation = null;
    const launchRef = f.json(x.owned, 'non-proof-launch', launch);
    const packet = f.json(x.owned, 'non-proof-clock-packet', { ...body, launch: launchRef, actionSha256: memory.memoryHash(launch), procedure: 'lean-specify/controller-direct', inputs: [] });
    const run = s.services.currentClock(); let now = run.deadlineMs - 10, calls = 0;
    const services = { ...s.services, now: () => now, verifyReleasedPacket: () => ({ clock: { ...run, observedAtMs: now } }) };
    const memoryCheck = services.verifyMemory, actorCheck = services.observeActor;
    if (phase === 'memory') services.verifyMemory = (o) => { const r = memoryCheck(o); now = run.deadlineMs + 1; return r; };
    if (phase === 'actor' || phase === 'rollback') services.observeActor = (a) => { const r = actorCheck(a); now = phase === 'rollback' ? now - 100 : run.deadlineMs + 1; return r; };
    if (phase === 'before-link') services.beforeMarkerCommit = () => { now = run.deadlineMs + 1; };
    if (phase === 'after-link') services.afterMarkerCommit = () => { now = run.deadlineMs + 1; };
    const options = { packet, actor: s.actor, expectedMemoryRequest: s.request, marker: s.marker };
    reject(phase === 'rollback' ? 'transition-clock-rollback' : phase.endsWith('link') ? 'transition-start-uncertain' : 'transition-budget-exhausted', () => { const r = t.acknowledgeStart(options, services); if (r.mayStart) calls++; });
    assert.equal(calls, 0); assert.equal(fs.existsSync(s.marker), phase === 'after-link');
    if (phase === 'after-link') assert.equal(t.acknowledgeStart(options, services).mayStart, false, 'created marker is uncertainty, never a second permission');
    if (phase === 'before-link') assert.ok(fs.readdirSync(x.owned).some((n) => n.startsWith('.' + path.basename(s.marker) + '.start-')));
  });
  it('fresh independent worker prime and exact actor challenge acknowledge startup', () => {
    const x = fixture(), s = x.startup();
    assert.equal(t.verifyStartup({ actionRef: s.action.actionRef, acknowledgement: s.acknowledgement, actor: s.actor, expectedMemoryRequest: s.request }, s.services).status, 'startup-acknowledged');
  });
  for (const name of ['session', 'challenge', 'before', 'request', 'source']) it('refuses wrong startup ' + name + ' without a start marker', () => {
    const x = fixture(), s = x.startup(), ack = t.transitionBound(s.acknowledgement);
    if (name === 'session') ack.actor.sessionId = 'other';
    if (name === 'challenge') ack.challenge = f.uuid();
    if (name === 'before') ack.beforeEventSha256 = 'c'.repeat(64);
    if (name === 'request') ack.memoryRequest.attemptId = f.uuid();
    if (name === 'source') s.services.observeActor = (a) => ({ ...a, worktree: { ...a.worktree, dirty: true } });
    const ref = f.json(x.owned, 'wrong-ack', ack);
    reject(name === 'source' ? 'transition-startup-uncertain' : 'transition-startup-ack-mismatch', () => t.verifyStartup({ actionRef: s.action.actionRef, acknowledgement: ref, actor: s.actor, expectedMemoryRequest: s.request }, s.services));
  });
  it('durably publishes the marker before work and duplicates/restarts cannot start twice', () => {
    const x = fixture(), s = x.packet(), options = { packet: s.packet, actor: s.actor, expectedMemoryRequest: s.request, marker: s.marker };
    const start = t.acknowledgeStart(options, s.services); assert.equal(start.mayStart, true); assert.ok(fs.existsSync(s.marker));
    const first = fs.readFileSync(s.marker), again = t.acknowledgeStart(options, s.services);
    assert.equal(again.status, 'already-started-uncertain'); assert.equal(again.mayStart, false); assert.deepEqual(fs.readFileSync(s.marker), first);
    const staleRead = t.acknowledgeStart(options, { ...s.services, verifyReleasedPacket() { throw new Error('old context must not grant a new start'); } });
    assert.equal(staleRead.mayStart, false, 'duplicate reads old uncertainty without claiming current execution permission');
  });
  it('a crash before atomic marker publication leaves uncertainty and never retries work', () => {
    const x = fixture(), s = x.packet(), options = { packet: s.packet, actor: s.actor, expectedMemoryRequest: s.request, marker: s.marker };
    assert.throws(() => t.acknowledgeStart(options, { ...s.services, beforeMarkerCommit() { throw new Error('simulated controller death'); } }), /simulated controller death/);
    assert.equal(fs.existsSync(s.marker), false); reject('transition-marker-uncertain', () => t.acknowledgeStart(options, s.services));
  });
  it('a competing marker cannot be overwritten or interpreted as our acknowledgement', () => {
    const x = fixture(), s = x.packet(), options = { packet: s.packet, actor: s.actor, expectedMemoryRequest: s.request, marker: s.marker };
    reject('transition-marker-uncertain', () => t.acknowledgeStart(options, { ...s.services, beforeMarkerCommit() { fs.writeFileSync(s.marker, 'another packet'); } }));
    assert.equal(fs.readFileSync(s.marker, 'utf8'), 'another packet');
  });
  it('wrong actor/source/current memory or marker path cannot start work', () => {
    const x = fixture(), s = x.packet(), options = { packet: s.packet, actor: s.actor, expectedMemoryRequest: s.request, marker: s.marker };
    reject('transition-packet-actor-mismatch', () => t.acknowledgeStart({ ...options, actor: { ...s.actor, sessionId: 'other' } }, s.services));
    reject('transition-packet-source-drift', () => t.acknowledgeStart(options, { ...s.services, observeActor: (a) => ({ ...a, worktree: { ...a.worktree, commit: 'f'.repeat(40) } }) }));
    reject('transition-marker-invalid', () => t.acknowledgeStart({ ...options, marker: s.marker + '.other' }, s.services));
    assert.equal(fs.existsSync(s.marker), false);
  });
  it('release recovery retains one original packet/handle and is observation-only', () => {
    const x = fixture(), s = x.packet(), p = t.readWorkPacket(s.packet), a = x.action('release', { sessionId: s.actor.sessionId, association: null, packet: s.packet, handle: p.deliveryHandle });
    const args = t.releaseArguments({ actionRef: a.actionRef, packet: s.packet }), recovery = t.releaseArguments({ actionRef: a.actionRef, packet: s.packet, recovery: true });
    assert.deepEqual(args.slice(0, 6), recovery.slice(0, 6)); assert.ok(recovery.includes('--recover-only')); assert.ok(!recovery.includes('--message')); assert.equal(recovery[5], p.deliveryHandle);
  });
});
describe('completed action evidence and bounded staleness', () => {
  it('real assigned candidate composition records exact source delta as partial facts, not proof permission', () => {
    const x = fixture(), c = composition(x), q = c.afterRequest(), out = x.out(), r = auto.checkpointState({ projectRoot: x.root, request: q, out });
    assert.equal(r.observation.transition.admissibility.status, 'facts-recorded-partial');
    assert.equal(r.observation.transition.admissibility.next, 'registry-revise'); assert.equal(r.effectExecutable, false);
    assert.equal(r.observation.transition.snapshot.source.commit, c.commit);
    assert.equal(auto.verifyTransition({ projectRoot: x.root, request: q, out }).position, 'after');
    reject('transition-before-required', () => auto.executeTransition({ projectRoot: x.root, request: q, beforeOut: out, producerOut: x.out(), evidenceDir: x.out() }));
  });
  it('unrelated source content is not explained by an otherwise real composition receipt', () => {
    const x = fixture(), c = composition(x); fs.writeFileSync(path.join(x.root, 'unrelated.txt'), 'must not be silently accepted');
    f.git(x.root, 'add', 'unrelated.txt'); f.git(x.root, 'commit', '-qm', 'fixture unrelated drift');
    const old = auto.readRuntimeState({ projectRoot: x.root }).fileSha256;
    reject('transition-materialization-unverified', () => x.invoke(c.afterRequest(), 'checkpoint'));
    assert.equal(auto.readRuntimeState({ projectRoot: x.root }).fileSha256, old);
  });
  it('wrong before/completion binding refuses without changing protected runtime history', () => {
    const x = fixture(), c = composition(x), changed = t.transitionBound(c.completion); changed.beforeEventSha256 = 'f'.repeat(64);
    const q = c.afterRequest(); q.transition.effect.evidence = [f.json(x.owned, 'wrong-before-completion', changed)]; const old = auto.readRuntimeState({ projectRoot: x.root }).fileSha256;
    reject('transition-completion-mismatch', () => x.invoke(q, 'checkpoint')); assert.equal(auto.readRuntimeState({ projectRoot: x.root }).fileSha256, old);
  });
  it('missing completion or worker success alone does not explain a source change', () => {
    const x = fixture(), c = composition(x), q = c.afterRequest(); q.transition.effect.evidence = [f.json(x.owned, 'worker-ready', { status: 'ready', verified: true })];
    reject('transition-completion-required', () => x.invoke(q, 'checkpoint'));
  });
  it('current AO settings drift refuses without recording authority or exposing env/rules', () => {
    const x = fixture(), item = x.action(), old = auto.readRuntimeState({ projectRoot: x.root }).fileSha256;
    x.project.config.worker.agentConfig.model = 'changed'; x.project.config.env = { PRIVATE: 'fixture-secret-must-not-persist' }; x.writeControl();
    const out = x.out(); reject('transition-profile-required', () => auto.checkpointState({ projectRoot: x.root, request: item.q, out }));
    assert.equal(auto.readRuntimeState({ projectRoot: x.root }).fileSha256, old);
    for (const n of fs.readdirSync(path.join(out, 'receipts'))) assert.ok(!fs.readFileSync(path.join(out, 'receipts', n), 'utf8').includes('fixture-secret-must-not-persist'));
  });
  it('actual14 append plus source composition is extra drift, never an explained exception', () => {
    const x = fixture(); trackRegistry(x); const c = composition(x), published = publishRegistry(reviewedInvocation(x, contract(x))), old = auto.readRuntimeState({ projectRoot: x.root }).fileSha256;
    assert.equal(registry.readChain(x.registryRoot).records.at(-1).sha, published.recordSha256);
    reject('transition-extra-drift', () => x.invoke(c.afterRequest(), 'checkpoint'));
    assert.equal(auto.readRuntimeState({ projectRoot: x.root }).fileSha256, old); assert.equal(registry.readChain(x.registryRoot).records.length, 1);
  });
  it('spec-definition materialization derives actual14 self/consumer invalidation while preserving its exact head', () => {
    const x = fixture(); trackRegistry(x); const c = composition(x); x.initial = x.invoke(c.afterRequest(), 'checkpoint');
    for (const node of [19, 20, 21]) publishRegistry(reviewedInvocation(x, contract(x, node)));
    const head = registry.readChain(x.registryRoot).records.at(-1).sha, original = t.transitionBound(c.assignment), reserved = auto.readRuntimeState({ projectRoot: x.root }).reservations.get(original.reservationId);
    fs.writeFileSync(path.join(c.worker, 'Defs.lean'), 'def Shared := Int\n'); f.git(c.worker, 'add', 'Defs.lean'); f.git(c.worker, 'commit', '-qm', 'fixture semantic definition change');
    const updated = x.associate('author', c.worker, reserved.intent, reserved.before), request = x.request; x.request = (extra = {}) => request({ associations: [updated], ...extra });
    const commit = f.git(c.worker, 'rev-parse', 'HEAD'), tree = f.git(c.worker, 'rev-parse', 'HEAD^{tree}'), files = { 'Defs.lean': f.sha(fs.readFileSync(path.join(c.worker, 'Defs.lean'))) };
    const item = x.action('compose-spec', { parent: f.git(x.root, 'rev-parse', 'HEAD'), candidates: [{ commit, tree, files, assignment: updated }], files }, { stage: 'integration' }), before = x.invoke(item.q, 'checkpoint');
    const completion = commandReceipt(x, item, ['/usr/bin/git', '-C', x.root, '-c', 'core.hooksPath=/dev/null', 'merge', '--ff-only', commit], { status: 'materialized', commit, tree }, before);
    const result = x.invoke(x.request({ transition: x.after(before, { sessionId: null, association: null, evidence: [completion], resolution: null }) }), 'checkpoint').result;
    assert.equal(result.observation.transition.snapshot.registry.headSha256, head);
    for (const node of [19, 20, 21]) assert.equal(result.observation.transition.snapshot.registry.nodes[node].state, 'needs-semantic-review');
    assert.equal(result.observation.transition.admissibility.next, 'registry-revise'); assert.equal(result.effectExecutable, false); assert.deepEqual(result.observation.acceptance.nodes, []);
  });
  it('actual14 revision plus unrelated source change refuses without advancing runtime', () => {
    const x = fixture(); trackRegistry(x); const c = composition(x); x.initial = x.invoke(c.afterRequest(), 'checkpoint'); publishRegistry(reviewedInvocation(x, contract(x)));
    const target = reviewedInvocation(x, contract(x, 19, { assumptions: ['fixture declared bounded premise'] }));
    const item = x.action('registry-revise', { request: target.request, review: target.review, candidateSha256: target.candidateSha256 }, { stage: 'review' }), before = x.invoke(item.q, 'checkpoint');
    const actual = publishRegistry(target);
    const command = f.json(x.owned, 'registry-command', { schema: 'fvs/auto-command-receipt', schemaVersion: 1, runId: x.runId, transitionId: item.a.transitionId, actionSha256: memory.memoryHash(item.a), ...target.execution });
    fs.writeFileSync(path.join(x.root, 'unrelated.txt'), 'unexpected source delta'); f.git(x.root, 'add', 'unrelated.txt'); f.git(x.root, 'commit', '-qm', 'fixture source drift');
    const old = auto.readRuntimeState({ projectRoot: x.root }).fileSha256;
    const q = x.request({ transition: x.after(before, { sessionId: null, association: null, evidence: [controllerCompletion(x, item, before, command, actual)], resolution: null }) });
    reject('transition-extra-drift', () => x.invoke(q, 'checkpoint')); assert.equal(auto.readRuntimeState({ projectRoot: x.root }).fileSha256, old);
  });
});
function retainedStoreSimulation(x) {
  const contracts = {};
  for (const node of [19, 20, 21]) {
    contracts[node] = { node, role: node === 19 ? 'helper' : 'root', statement: 'True', assumptions: [], grounding: { kind: 'none', reason: 'Protocol simulation only' }, implementationDependencies: [], specDefinitions: [], externalReferences: [], author: { session: 'fixture-author', harness: 'fixture', model: 'none', runId: f.uuid() } };
    publishRegistry(reviewedInvocation(x, contracts[node]));
  }
  const reg = registry.readChain(x.registryRoot).records.at(-1).sha, source = x.request().source, storeRoot = path.join(x.owned, 'simulation-accepted'); fs.mkdirSync(storeRoot);
  const records = [19, 20, 21].map(node => ({ file: 'SIMULATION-NOT-CANONICAL', sha256: f.sha('simulation-' + node), record: { schema: 'fvs/test-simulation-accepted', authority: 'simulation-authority', node, integrated: { commit: source.commit, tree: source.expectedTree }, frozenSha256: '1'.repeat(64), registryHeadSha256: reg, dependencies: [] } }));
  const history = { records, heads: new Map(records.map(r => [r.record.node, r])), headSha256: records.at(-1).sha256 };
  const state = { baseline: null, ledger: path.join(storeRoot, 'simulation-ledger.json'), history, contracts }; fs.writeFileSync(state.ledger, JSON.stringify(records));
  const request = x.request; x.request = (extra = {}) => { const q = request(extra); q.inputs = { ...q.inputs, baseline: state.baseline, acceptedStore: { root: storeRoot, expectedHeadSha256: history.headSha256 } }; return q; };
  const validators = t.transitionValidators({ tools: { auto: f.ref(path.join(f.ROOT, 'scripts/fvs-auto.mjs')), registry: f.ref(path.join(f.ROOT, 'scripts/fvs-contract-registry.mjs')), ao: x.request().ao.tool }, readStore: () => history,
    inspectBaseline: ({ baseline }) => ({ registry: t.transitionBound(baseline).registry, nodes: [19, 20, 21], dependencies: { 19: [], 20: [19], 21: [19] } }),
    git(root, args, binary = false, status = false) { const p = spawnSync('/usr/bin/git', ['-C', root, ...args], { env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' } }); if (status) return p.status; assert.equal(p.status, 0, p.stderr?.toString()); return binary ? p.stdout : p.stdout.toString(); } });
  state.services = { loadCanonical: x.canonical, refreshMemory: auto.refreshMemory, verifyMemory: auto.verifyMemoryBootstrap,
    inspectAcceptance() { if (registry.readChain(x.registryRoot).records.at(-1).sha !== reg) { const e = new Error('simulation stale H/A/B context'); e.code = 'stale-input'; throw e; } return { status: 'current', acceptedBaseline: { commit: source.commit, tree: source.expectedTree }, nodes: [], storeHeadSha256: history.headSha256 }; },
    transitions: { ...validators, readStore: () => history, inspectBaseline: ({ baseline }) => ({ registry: t.transitionBound(baseline).registry, nodes: [19, 20, 21], dependencies: { 19: [], 20: [19], 21: [19] } }),
      verifyBaseline(a, actual, e) { assert.equal(e.result.schema, 'fvs/test-simulation-freeze'); assert.deepEqual(e.result.baseline, actual.baseline); } } };
  x.execute = ({ projectRoot, request, beforeOut, producerOut, evidenceDir }) => {
    const checked = resume.consumeTransition({ projectRoot, request, out: beforeOut }, state.services), runtime = auto.readRuntimeState({ projectRoot });
    assert.equal(checked.position, 'before');
    return t.performTransition({ actionRef: checked.action, ao: request.ao.tool, tools: { auto: f.ref(path.join(f.ROOT, 'scripts/fvs-auto.mjs')), registry: f.ref(path.join(f.ROOT, 'scripts/fvs-contract-registry.mjs')) }, producerOut, evidenceDir,
      beforeEventSha256: runtime.state.history.at(-1).sha256, committedHeadSha256: checked.committedHeadSha256, runtimeRoot: path.join(projectRoot, '.formalising/auto-fv/resume'), deadlineMs: runtime.state.run.deadlineMs, lastObservedAtMs: runtime.lastObservedAtMs }, { head: () => auto.readRuntimeState({ projectRoot }).headSha256 });
  };
  x.ack = ({ projectRoot, ao, packet, actor, expectedMemoryRequest, memoryOut, marker, out }) => t.acknowledgeStart({ packet, actor, expectedMemoryRequest, marker }, {
    memoryOut,
    beforeForAction(ref) { return auto.readRuntimeState({ projectRoot }).state.history.find(r => r.event.position === 'before' && r.event.intent.request?.sha256 === ref.sha256).sha256; },
    currentClock() { const v = auto.readRuntimeState({ projectRoot }); return { runId: v.state.run.runId, startedAtMs: v.state.run.startedAtMs, deadlineMs: v.state.run.deadlineMs, lastObservedAtMs: v.lastObservedAtMs }; },
    verifyReleasedPacket(packet) { return resume.verifyReleasedPacketContext({ projectRoot, ao, packet, memoryRequest: expectedMemoryRequest, out: out + '-context' }, { loadCanonical: x.canonical, transitions: state.services.transitions }); },
    verifyMemory(options) { return auto.verifyMemoryBootstrap({ ...options, projectRoot }); },
    observeActor(actor) { return resume.observeAssignedActor({ projectRoot, ao, actor, attemptId: expectedMemoryRequest.attemptId, out: out + '-actor' }); },
  });
  x.transitionServices = state.services.transitions; x.invoke = (q = x.request(), op = 'state', out = x.out()) => ({ q, out, result: resume.runResume(op, { projectRoot: x.root, request: q, out }, state.services) });
  return state;
}
function lifecycle(x, { noOp = false, crashPublication = false, stalePreparation = false, consumeCandidate = false, consumeReview = false, staleRetirement = false } = {}) {
  const canonicalBefore = f.sha(fs.readFileSync(f.stateFile(x.root)));
    if (consumeReview) trackRegistry(x);
    effectDouble(x); const stale = staleRetirement ? retainedStoreSimulation(x) : null;
    const l = stageLaunch(x, [19], consumeReview ? 'review' : 'specification'), value = t.transitionBound(l.assignment);
    const actor = { projectId: 'fixture-project', sessionId: l.result.session.id, reservationId: value.reservationId, assignmentId: value.assignmentId, worktree: { ...value.worktree, dirty: false }, profile: value.rulesProfile };
    const startup = l.item.a.target.startup, startupRequest = auto.prepareMemoryRequest({ projectRoot: x.root, attemptId: startup.attemptId, phase: startup.phase, operation: 'worker-readonly', target: { projectId: actor.projectId, sessionId: actor.sessionId, resumeId: startup.resumeId } });
    const memoryOut = x.out(); auto.primeMemory({ projectRoot: x.root, callerRoot: l.worktree, request: startupRequest, out: memoryOut });
    const startupAck = f.json(x.owned, 'startup', { schema: 'fvs/auto-startup-ack', schemaVersion: 1, runId: x.runId, actionSha256: memory.memoryHash(l.item.a), beforeEventSha256: l.before.result.recordedEventSha256,
      challenge: startup.challenge, actor, memoryRequest: startupRequest, memoryOut, memoryEvidence: t.workerMemoryEvidence(memoryOut, startupRequest), waiting: true });
    assert.equal(auto.verifyWorkerStartup({ projectRoot: x.root, ao: l.item.q.ao, actionRef: l.item.actionRef, acknowledgement: startupAck, actor, expectedMemoryRequest: startupRequest, out: x.out() }).status, 'startup-acknowledged');
    const request = x.request; x.request = (extra = {}) => request({ associations: [l.assignment], ...extra });
    const staging = path.join(x.owned, 'prepared-context'); f.git(x.root, 'worktree', 'add', '-q', '-b', 'prepared-context', staging);
    if (!noOp) { fs.writeFileSync(path.join(staging, 'Context.lean'), 'def Context := Nat\n'); f.git(staging, 'add', 'Context.lean'); f.git(staging, 'commit', '-qm', 'fixture prepared context'); }
    const wrongActor = { ...actor, worktree: { ...actor.worktree, path: staging, gitDir: fs.realpathSync(path.resolve(staging, f.git(staging, 'rev-parse', '--git-dir'))) } };
    const otherPrime = x.out(); auto.primeMemory({ projectRoot: x.root, callerRoot: staging, request: startupRequest, out: otherPrime });
    const wrongAck = f.json(x.owned, 'wrong-actor-path-ack', { ...t.transitionBound(startupAck), actor: wrongActor, memoryOut: otherPrime, memoryEvidence: t.workerMemoryEvidence(otherPrime, startupRequest) }), heldActorHead = auto.readRuntimeState({ projectRoot: x.root }).headSha256;
    reject('resume-association-invalid', () => auto.verifyWorkerStartup({ projectRoot: x.root, ao: l.item.q.ao, actionRef: l.item.actionRef, acknowledgement: wrongAck, actor: wrongActor, expectedMemoryRequest: startupRequest, out: x.out() }));
    assert.equal(auto.readRuntimeState({ projectRoot: x.root }).headSha256, heldActorHead);
    const candidate = { commit: f.git(staging, 'rev-parse', 'HEAD'), expectedTree: f.git(staging, 'rev-parse', 'HEAD^{tree}') };
    let q = x.request(), run = auto.readRuntimeState({ projectRoot: x.root }).state.run;
    const snap = (target) => t.transitionSnapshot({ q, run, canonical: x.canonical(), observation: { ...x.initial.result.observation, associations: [{ reference: l.assignment, value }] },
      action: { before: { registry: x.registryRoot ? { root: x.registryRoot } : null }, target, owner: value.owner, nodes: [], authorization: x.auth, profile: x.profile } }, { ...x.transitionServices, profileObservation: x.profileObservation, observeWorktree: () => actor.worktree });
    const p = x.action('prepare-input', { sessionId: actor.sessionId, association: l.assignment, launch: l.item.actionRef, startupAck, startupRequest, candidate }, { before: snap({ sessionId: actor.sessionId }), stage: 'integration' });
    const mutable = x.action('prepare-input', { ...p.a.target, candidate: { ...candidate, commit: 'HEAD' } }, { before: p.a.before, stage: 'integration' }), held = auto.readRuntimeState({ projectRoot: x.root }).headSha256;
    reject('transition-preparation-unverified', () => x.invoke(mutable.q, 'checkpoint')); assert.equal(auto.readRuntimeState({ projectRoot: x.root }).headSha256, held);
    const before = x.invoke(p.q, 'checkpoint');
    const exec = (x.execute ?? auto.executeTransition)({ projectRoot: x.root, request: p.q, beforeOut: before.out, producerOut: x.out(), evidenceDir: x.out() }); assert.equal(exec.status, 'command-completed');
    const updated = x.associate(actor.sessionId, l.worktree, l.item.intent, l.before.result.recordedEventSha256, { rulesProfile: value.rulesProfile });
    const nextActor = { ...actor, worktree: { ...t.transitionBound(updated).worktree, dirty: false } };
    x.request = (extra = {}) => request({ associations: [updated], ...extra });
    const completion = controllerCompletion(x, p, before, exec.command, { status: 'prepared', candidate });
    const after = x.invoke(x.request({ transition: x.after(before, { sessionId: null, association: null, evidence: [completion], resolution: null }) }), 'checkpoint');
    assert.equal(after.result.observation.transition.admissibility.next, 'release');
    const primeRequest = auto.prepareMemoryRequest({ projectRoot: x.root, attemptId: f.uuid(), phase: 'resume', operation: 'worker-readonly', target: { projectId: actor.projectId, sessionId: actor.sessionId, resumeId: f.uuid() } });
    let issuedReview = null;
    if (consumeReview) {
      const c = { node: 19, role: 'helper', statement: staleRetirement ? 'True ∧ True' : 'True', assumptions: [], grounding: { kind: 'none', reason: 'Explicit protocol simulation, no semantic authority' },
        implementationDependencies: [], specDefinitions: [], externalReferences: [], author: { session: 'fixture-author', harness: 'fixture', model: 'none', runId: f.uuid() } };
      const input = reviewedInvocation(x, c), invocation = t.transitionBound(input.request), oldReview = t.transitionBound(input.review);
      input.review = f.json(x.owned, 'actor-review', { ...oldReview, reviewer: { ...oldReview.reviewer, session: actor.sessionId } });
      input.request = f.json(x.owned, 'actor-review-invocation', { ...invocation, review: input.review });
      input.issued = f.json(x.owned, 'issued-review', { schema: 'fvs/auto-review-input', schemaVersion: 1, node: 19, contract: invocation.contract, candidateSha256: input.candidateSha256, registryHeadSha256: oldReview.registryHeadSha256 });
      issuedReview = input;
    }
    const packet = f.json(x.owned, 'work', { schema: 'fvs/auto-work-packet', schemaVersion: 1, runId: x.runId, actionSha256: memory.memoryHash(l.item.a), launch: l.item.actionRef, beforeEventSha256: l.before.result.recordedEventSha256,
      challenge: f.uuid(), actor: nextActor, deliveryHandle: 'release-' + f.uuid(), memoryRequest: primeRequest, procedure: consumeReview ? 'lean-spec-review/Other' : 'lean-specify/controller-direct', inputs: [x.profile, ...(issuedReview ? [issuedReview.issued] : [])], resumeOf: null, startMarker: path.join(x.owned, 'worker-start.json') });
    q = x.request(); const releaseSnapshot = { ...after.result.observation.transition.snapshot, worker: { ...after.result.observation.transition.snapshot.worker, worktree: nextActor.worktree } };
    if (stalePreparation) {
      f.git(l.worktree, 'commit', '--allow-empty', '-qm', 'fixture stale prepared candidate');
      const changed = x.associate(actor.sessionId, l.worktree, l.item.intent, l.before.result.recordedEventSha256, { rulesProfile: value.rulesProfile }), changedActor = { ...actor, worktree: { ...t.transitionBound(changed).worktree, dirty: false } };
      x.request = (extra = {}) => request({ associations: [changed], ...extra });
      const body = { ...t.readWorkPacket(packet), actor: changedActor }, changedPacket = f.json(x.owned, 'stale-prepared-packet', body), snapshot = { ...releaseSnapshot, worker: { ...releaseSnapshot.worker, worktree: changedActor.worktree } };
      const bad = x.action('release', { sessionId: actor.sessionId, association: changed, packet: changedPacket, handle: body.deliveryHandle }, { before: snapshot, stage: 'integration' }), original = fs.readFileSync(path.join(x.root, '.formalising/auto-fv/resume/state.json'));
      reject('transition-preparation-required', () => x.invoke(bad.q, 'checkpoint'));
      assert.deepEqual(fs.readFileSync(path.join(x.root, '.formalising/auto-fv/resume/state.json')), original); assert.equal(fs.existsSync(body.startMarker), false);
      assert.equal(fs.readFileSync(x.log, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter((a) => a[0] === 'send').length, 0);
      return { scope: 'stale actor/candidate cannot reuse an earlier preparation, even at the same tree', runId: x.runId };
    }
    const release = x.action('release', { sessionId: actor.sessionId, association: updated, packet, handle: t.readWorkPacket(packet).deliveryHandle }, { before: releaseSnapshot, stage: 'integration' });
    const rb = x.invoke(release.q, 'checkpoint'), sent = (x.execute ?? auto.executeTransition)({ projectRoot: x.root, request: release.q, beforeOut: rb.out, producerOut: x.out(), evidenceDir: x.out() });
    assert.equal(sent.status, 'command-completed');
    const replacementBody = t.readWorkPacket(packet); replacementBody.deliveryHandle = 'replacement-' + f.uuid(); replacementBody.startMarker += '.replacement';
    const replacementPacket = f.json(x.owned, 'forbidden-new-handle', replacementBody), replacement = x.action('release', { sessionId: actor.sessionId, association: updated, packet: replacementPacket, handle: replacementBody.deliveryHandle }, { before: releaseSnapshot, stage: 'integration' });
    const headBeforeReplacement = auto.readRuntimeState({ projectRoot: x.root }).headSha256;
    reject('transition-release-uncertain', () => x.invoke(replacement.q, 'checkpoint'));
    assert.equal(auto.readRuntimeState({ projectRoot: x.root }).headSha256, headBeforeReplacement);
    reject('transition-effect-uncertain', () => (x.execute ?? auto.executeTransition)({ projectRoot: x.root, request: release.q, beforeOut: rb.out, producerOut: x.out(), evidenceDir: x.out() }));
    const freshOut = x.out(); auto.primeMemory({ projectRoot: x.root, callerRoot: l.worktree, request: primeRequest, out: freshOut });
    const startOptions = { projectRoot: x.root, ao: release.q.ao, packet, actor: nextActor, expectedMemoryRequest: primeRequest, memoryOut: freshOut, marker: t.readWorkPacket(packet).startMarker };
    reject('transition-release-not-published', () => (x.ack ?? auto.acknowledgeWorkPacket)({ ...startOptions, out: x.out() }));
    assert.equal(fs.existsSync(startOptions.marker), false, 'received packet cannot start before delivery publication');
    const sendResult = JSON.parse(t.transitionBound(t.transitionBound(sent.command).stdout, false));
    const deliveredRequest = x.request({ transition: x.after(rb, { sessionId: null, association: null, evidence: [controllerCompletion(x, release, rb, sent.command, sendResult)], resolution: null }) });
    if (crashPublication) {
      const stateFile = path.join(x.root, '.formalising/auto-fv/resume/state.json'), original = fs.readFileSync(stateFile);
      const services = { loadCanonical: x.canonical, refreshMemory: auto.refreshMemory, verifyMemory: auto.verifyMemoryBootstrap, inspectAcceptance() { throw new Error('not used'); },
        transitions: t.transitionValidators({ tools: { auto: f.ref(path.join(f.ROOT, 'scripts/fvs-auto.mjs')), registry: f.ref(path.join(f.ROOT, 'scripts/fvs-contract-registry.mjs')), ao: release.q.ao.tool }, git() { throw new Error('not used'); } }), beforeRename() { throw new Error('simulated delivery publication crash'); } };
      assert.throws(() => resume.runResume('checkpoint', { projectRoot: x.root, request: deliveredRequest, out: x.out() }, services), /simulated delivery publication crash/);
      assert.deepEqual(fs.readFileSync(stateFile), original); assert.ok(fs.existsSync(path.join(path.dirname(stateFile), 'lock')));
      reject('resume-pending', () => (x.ack ?? auto.acknowledgeWorkPacket)({ ...startOptions, out: x.out() }));
      assert.equal(fs.existsSync(startOptions.marker), false); assert.equal(fs.readFileSync(x.log, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter((a) => a[0] === 'send').length, 1);
      return { scope: 'delivery after publication crash: old complete runtime/pending evidence retained, no start or duplicate send', runId: x.runId };
    }
    const delivered = x.invoke(deliveredRequest, 'checkpoint');
    const ack = (x.ack ?? auto.acknowledgeWorkPacket)({ projectRoot: x.root, ao: release.q.ao, packet, actor: nextActor, expectedMemoryRequest: primeRequest, memoryOut: freshOut, marker: t.readWorkPacket(packet).startMarker, out: x.out() });
    assert.equal(ack.mayStart, true);
    if (!consumeReview) { fs.writeFileSync(path.join(l.worktree, 'Authored.lean'), 'def Authored := Nat\n'); f.git(l.worktree, 'add', 'Authored.lean'); f.git(l.worktree, 'commit', '-qm', 'fixture immediate authorized progress'); }
    const progressed = x.associate(actor.sessionId, l.worktree, l.item.intent, l.before.result.recordedEventSha256, { rulesProfile: value.rulesProfile });
    const progressActor = { ...actor, worktree: { ...t.transitionBound(progressed).worktree, dirty: false } };
    x.request = (extra = {}) => request({ associations: [progressed], ...extra });
    assert.equal((x.ack ?? auto.acknowledgeWorkPacket)({ projectRoot: x.root, ao: release.q.ao, packet, actor: nextActor, expectedMemoryRequest: primeRequest, memoryOut: freshOut, marker: t.readWorkPacket(packet).startMarker, out: x.out() }).mayStart, false);
    const publishedHead = auto.readRuntimeState({ projectRoot: x.root }).headSha256;
    assert.equal(x.invoke(deliveredRequest, 'checkpoint').result.code, 'already-recorded');
    assert.equal(auto.readRuntimeState({ projectRoot: x.root }).headSha256, publishedHead, 'immediate progress cannot invalidate/re-publish the already completed delivery');
    assert.equal(fs.readFileSync(x.log, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter((a) => a[0] === 'send').length, 1);
    if (consumeReview) {
      const input = issuedReview, invocation = t.transitionBound(input.request), oldReview = t.transitionBound(input.review);
      const typed = { schema: 'fvs/auto-work-result', schemaVersion: 1, runId: x.runId, packet, marker: ack.marker, actionSha256: memory.memoryHash(l.item.a), actor: nextActor, kind: 'review',
        prepared: { commit: nextActor.worktree.commit, tree: nextActor.worktree.tree }, result: { contract: invocation.contract, review: input.review }, controllerObservedAtMs: Date.now(), controllerSessionId: 'coordinator' };
      const work = f.json(x.owned, 'conclusive-review', { schema: 'fvs/auto-work-completion', schemaVersion: 1, runId: x.runId, packet, marker: ack.marker, sourceAfter: typed.prepared, outcome: 'completed',
        artifacts: [f.json(x.owned, 'typed-review', typed)], controllerSessionId: 'coordinator' });
      const basis = { version: 2, beforeEventSha256: rb.result.recordedEventSha256, afterEventSha256: delivered.result.recordedEventSha256, completion: deliveredRequest.transition.effect.evidence[0], workCompletion: work };
      const target = { candidateSha256: input.candidateSha256, review: input.review, request: input.request };
      const item = x.action('registry-revise', target, { basis, stage: 'review' }), held = auto.readRuntimeState({ projectRoot: x.root }).fileSha256;
      const wrong = f.json(x.owned, 'wrong-review-actor', { ...t.transitionBound(input.review), reviewer: { ...oldReview.reviewer, session: 'unrelated-reviewer' } });
      const badWork = f.json(x.owned, 'bad-review-completion', { ...t.transitionBound(work), artifacts: [f.json(x.owned, 'bad-review-result', { ...typed, result: { contract: invocation.contract, review: wrong } })] });
      const badRequest = f.json(x.owned, 'bad-review-invocation', { ...t.transitionBound(input.request), review: wrong });
      const bad = x.action('registry-revise', { ...target, review: wrong, request: badRequest }, { basis: { ...basis, workCompletion: badWork }, stage: 'review' });
      reject('transition-work-result-invalid', () => x.invoke(bad.q, 'checkpoint')); assert.equal(auto.readRuntimeState({ projectRoot: x.root }).fileSha256, held);
      for (const c of [{ ...t.transitionBound(invocation.contract), node: 20, role: 'root' }, { ...t.transitionBound(invocation.contract), statement: '(True ∧ True) ∧ True' }]) {
        const foreign = reviewedInvocation(x, c), i = t.transitionBound(foreign.request), review = t.transitionBound(foreign.review);
        foreign.review = f.json(x.owned, 'wrong-issued-review', { ...review, reviewer: { ...review.reviewer, session: actor.sessionId } });
        foreign.request = f.json(x.owned, 'wrong-issued-invocation', { ...i, review: foreign.review });
        const body = { ...typed, result: { contract: i.contract, review: foreign.review } }, complete = { ...t.transitionBound(work), artifacts: [f.json(x.owned, 'wrong-issued-result', body)] };
        const bad = x.action('registry-revise', { candidateSha256: foreign.candidateSha256, review: foreign.review, request: foreign.request }, { basis: { ...basis, workCompletion: f.json(x.owned, 'wrong-issued-completion', complete) }, stage: 'review' });
        reject('transition-work-result-invalid', () => x.invoke(bad.q, 'checkpoint')); assert.equal(auto.readRuntimeState({ projectRoot: x.root }).fileSha256, held); assert.equal(registry.readChain(x.registryRoot).records.length, staleRetirement ? 3 : 0);
      }
      const before = x.invoke(item.q, 'checkpoint'), executed = (x.execute ?? auto.executeTransition)({ projectRoot: x.root, request: item.q, beforeOut: before.out, producerOut: x.out(), evidenceDir: x.out() });
      assert.equal(executed.status, 'command-completed');
      const result = JSON.parse(t.transitionBound(t.transitionBound(executed.command).stdout, false)), completion = controllerCompletion(x, item, before, executed.command, result);
      const after = x.invoke(x.request({ transition: x.after(before, { sessionId: null, association: null, evidence: [completion, work], resolution: null }) }), 'checkpoint');
      assert.equal(after.result.observation.transition.snapshot.registry.nodes[19].state, 'machine-reviewed-provisional');
      assert.equal(registry.readChain(x.registryRoot).records.length, staleRetirement ? 4 : 1);
      if (staleRetirement) {
        const originalLedger = fs.readFileSync(stale.ledger), held = auto.readRuntimeState({ projectRoot: x.root }).fileSha256;
        const worker = { sessionId: actor.sessionId, assignmentId: actor.assignmentId, reservationId: actor.reservationId, worktree: progressActor.worktree, profile: progressActor.profile };
        const retirementSnapshot = { ...after.result.observation.transition.snapshot, worker }, outputBasis = { version: 2, beforeEventSha256: before.result.recordedEventSha256, afterEventSha256: after.result.recordedEventSha256, completion, workCompletion: null };
        const missing = x.action('terminate', { operation: 'resolve-terminated-reservation', sessionId: actor.sessionId, association: progressed }, { before: retirementSnapshot, basis: outputBasis, stage: 'reconcile', intent: { ...x.local([], 'reconcile'), effect: { kind: 'reservation-resolution', targetReservationId: actor.reservationId } } });
        reject('transition-retirement-unverified', () => x.invoke(missing.q, 'checkpoint'));
        assert.equal(auto.readRuntimeState({ projectRoot: x.root }).fileSha256, held); assert.equal(auto.readRuntimeState({ projectRoot: x.root }).reservations.get(actor.reservationId).state, 'active');
        const bad = x.action('terminate', { sessionId: 'unrelated-worker', association: progressed }, { before: retirementSnapshot, basis: outputBasis, stage: 'integration' });
        reject('transition-actor-mismatch', () => x.invoke(bad.q, 'checkpoint')); assert.equal(auto.readRuntimeState({ projectRoot: x.root }).fileSha256, held);
        const intent = x.action('terminate', { sessionId: actor.sessionId, association: progressed }, { before: retirementSnapshot, basis: outputBasis, stage: 'integration' });
        const view = auto.readRuntimeState({ projectRoot: x.root });
        reject('transition-budget-exhausted', () => assess(x, intent, retirementSnapshot, { view, now: view.state.run.deadlineMs }, stale.services.transitions));
        const uncertain = { ...view, state: { ...view.state, history: view.state.history.map(r => r.sha256 === after.result.recordedEventSha256 ? { ...r, event: { ...r.event, outcome: 'uncertain' } } : r) } };
        reject('transition-explanation-required', () => assess(x, intent, retirementSnapshot, { view: uncertain, reasons: ['acceptance-unverified'] }, { ...stale.services.transitions, verifyTarget() {} }));
        const tb = x.invoke(intent.q, 'checkpoint'), killed = (x.execute ?? auto.executeTransition)({ projectRoot: x.root, request: intent.q, beforeOut: tb.out, producerOut: x.out(), evidenceDir: x.out() });
        assert.equal(killed.status, 'command-completed'); syncRows(x);
        const terminated = JSON.parse(t.transitionBound(t.transitionBound(killed.command).stdout, false)), termination = controllerCompletion(x, intent, tb, killed.command, terminated);
        const ta = x.invoke(x.request({ transition: x.after(tb, { sessionId: null, association: null, evidence: [termination], resolution: null }) }), 'checkpoint');
        assert.equal(auto.readRuntimeState({ projectRoot: x.root }).reservations.get(actor.reservationId).state, 'active', 'termination alone does not free capacity');
        const resolveIntent = { ...x.local([], 'reconcile'), effect: { kind: 'reservation-resolution', targetReservationId: actor.reservationId } }, basis = { version: 2, beforeEventSha256: tb.result.recordedEventSha256, afterEventSha256: ta.result.recordedEventSha256, completion: termination, workCompletion: null };
        const resolution = x.action('terminate', { operation: 'resolve-terminated-reservation', sessionId: actor.sessionId, association: progressed }, { intent: resolveIntent, before: ta.result.observation.transition.snapshot, basis, stage: 'reconcile' });
        const wrongReservation = x.action('terminate', resolution.a.target, { intent: { ...x.local([], 'reconcile'), effect: { kind: 'reservation-resolution', targetReservationId: f.uuid() } }, before: resolution.a.before, basis, stage: 'reconcile' });
        const stillHeld = auto.readRuntimeState({ projectRoot: x.root }).fileSha256;
        reject('transition-action-mismatch', () => x.invoke(wrongReservation.q, 'checkpoint')); assert.equal(auto.readRuntimeState({ projectRoot: x.root }).fileSha256, stillHeld);
        const rb = x.invoke(resolution.q, 'checkpoint');
        reject('transition-procedure-required', () => t.transitionCommand({ actionRef: resolution.actionRef, ao: resolution.q.ao.tool, tools: {}, out: x.out(), beforeEventSha256: rb.result.recordedEventSha256 }));
        const terminationObservation = f.json(x.owned, 'fresh-termination', terminated), rq = x.request({ transition: x.after(rb, { sessionId: null, association: null, evidence: [terminationObservation], resolution: { reason: 'session-terminated', evidence: terminationObservation } }) });
        const resolved = x.invoke(rq, 'checkpoint');
        const consumed = resume.consumeTransition({ projectRoot: x.root, request: rq, out: resolved.out }, stale.services);
        assert.equal(consumed.code, 'transition-reconciled'); assert.equal(consumed.effectExecutable, false);
        assert.equal(resolved.result.code, 'partial'); assert.equal(consumed.observation.acceptance.status, 'unverified');
        assert.ok(consumed.observation.reasons.includes('acceptance-unverified')); assert.equal(consumed.observation.transition.admissibility.status, 'facts-recorded-partial');
        assert.equal(auto.readRuntimeState({ projectRoot: x.root }).reservations.get(actor.reservationId).state, 'closed');
        let nextBasis = { version: 2, beforeEventSha256: rb.result.recordedEventSha256, afterEventSha256: resolved.result.recordedEventSha256, completion: terminationObservation, workCompletion: null };
        for (const node of [20, 21]) {
          const target = reviewedInvocation(x, stale.contracts[node]), item = x.action('registry-revise', { request: target.request, review: target.review, candidateSha256: target.candidateSha256 }, { basis: nextBasis, stage: 'review' });
          const before = x.invoke(item.q, 'checkpoint'), command = (x.execute ?? auto.executeTransition)({ projectRoot: x.root, request: item.q, beforeOut: before.out, producerOut: x.out(), evidenceDir: x.out() });
          const result = JSON.parse(t.transitionBound(t.transitionBound(command.command).stdout, false)), completion = controllerCompletion(x, item, before, command.command, result);
          const after = x.invoke(x.request({ transition: x.after(before, { sessionId: null, association: null, evidence: [completion], resolution: null }) }), 'checkpoint');
          nextBasis = { version: 2, beforeEventSha256: before.result.recordedEventSha256, afterEventSha256: after.result.recordedEventSha256, completion, workCompletion: null };
        }
        const q = x.request(), reg = { root: x.registryRoot, headSha256: registry.readChain(x.registryRoot).records.at(-1).sha };
        const frozen = f.json(x.owned, 'SIMULATION-FROZEN', { schema: 'fvs/test-simulation-baseline', registry: reg, overlayFiles: [] });
        const job = f.json(x.owned, 'simulation-freeze-request', { baseline: { source: q.source }, registry: reg, extraction: { identity: q.inputs.extraction, graph: q.inputs.graph, plan: q.inputs.plan }, deadlineMs: auto.readRuntimeState({ projectRoot: x.root }).state.run.deadlineMs });
        const freeze = x.action('freeze', { request: job }, { basis: nextBasis, stage: 'check' }), fb = x.invoke(freeze.q, 'checkpoint');
        const emitter = path.join(x.owned, 'simulation-freeze.cjs'); fs.writeFileSync(emitter, 'process.stdout.write(process.argv[2]);\n'); stale.baseline = frozen;
        const body = { schema: 'fvs/test-simulation-freeze', authority: 'simulation-authority', baseline: frozen }, fc = commandReceipt(x, freeze, [fs.realpathSync(process.execPath), emitter, JSON.stringify(body)], body, fb);
        const fa = x.invoke(x.request({ transition: x.after(fb, { sessionId: null, association: null, evidence: [fc], resolution: null }) }), 'checkpoint');
        const launchIntent = x.launch([19]); launchIntent.stage = 'proof';
        const proof = x.action('launch', { projectId: 'fixture-project', branchRef: launchIntent.effect.intendedBranchRef, assignmentId: launchIntent.effect.assignmentId, startup: { challenge: f.uuid(), attemptId: f.uuid(), phase: 'start', resumeId: null } }, { intent: launchIntent, basis: { version: 2, beforeEventSha256: fb.result.recordedEventSha256, afterEventSha256: fa.result.recordedEventSha256, completion: fc, workCompletion: null } });
        const permitted = x.invoke(proof.q, 'checkpoint'); assert.equal(permitted.result.observation.transition.admissibility.status, 'next-action-eligible');
        assert.equal(auto.readRuntimeState({ projectRoot: x.root }).reservations.get(proof.a.reservationId).state, 'pending');
        assert.deepEqual(fs.readFileSync(stale.ledger), originalLedger); assert.equal(stale.history.records.length, 3);
        reject('stale-input', () => checker.currentAcceptedRows(stale.history, { selection: new Set([19, 20, 21]), source: q.source, frozenSha256: frozen.sha256, registryHeadSha256: reg.headSha256 }));
        assert.equal(auto.readRuntimeState({ projectRoot: x.root }).state.run.startedAtMs, view.state.run.startedAtMs);
      }
      assert.equal(f.sha(fs.readFileSync(f.stateFile(x.root))), canonicalBefore);
      return { scope: 'actual14 append under v2 review-result route; review/AO/Beads are protocol fixtures', basis };
    }
    if (consumeCandidate) {
      const candidate = { commit: progressActor.worktree.commit, tree: progressActor.worktree.tree,
        files: { 'Authored.lean': f.sha(fs.readFileSync(path.join(l.worktree, 'Authored.lean'))) }, assignment: progressed };
      const typed = { schema: 'fvs/auto-work-result', schemaVersion: 1, runId: x.runId, packet, marker: ack.marker, actionSha256: memory.memoryHash(l.item.a), actor: nextActor,
        kind: 'candidate', prepared: { commit: nextActor.worktree.commit, tree: nextActor.worktree.tree }, result: candidate, controllerObservedAtMs: Date.now(), controllerSessionId: 'coordinator' };
      const terminal = { schema: 'fvs/auto-work-completion', schemaVersion: 1, runId: x.runId, packet, marker: ack.marker,
        sourceAfter: { commit: candidate.commit, tree: candidate.tree }, outcome: 'completed', artifacts: [f.json(x.owned, 'typed-result', typed)], controllerSessionId: 'coordinator' };
      const basis = { version: 2, beforeEventSha256: rb.result.recordedEventSha256, afterEventSha256: delivered.result.recordedEventSha256,
        completion: deliveredRequest.transition.effect.evidence[0], workCompletion: f.json(x.owned, 'completed-work', terminal) };
      const target = { parent: f.git(x.root, 'rev-parse', 'HEAD'), candidates: [candidate], files: candidate.files }, held = auto.readRuntimeState({ projectRoot: x.root }).fileSha256;
      const attempt = (body, code = 'transition-work-result-invalid') => {
        const item = x.action('compose-spec', target, { stage: 'integration', basis: { ...basis, workCompletion: f.json(x.owned, 'refused-completion', body) } });
        reject(code, () => x.invoke(item.q, 'checkpoint')); assert.equal(auto.readRuntimeState({ projectRoot: x.root }).fileSha256, held);
      };
      attempt({ ...terminal, schemaVersion: 2 });
      attempt({ ...terminal, actor: nextActor }, 'transition-invalid-input');
      attempt({ ...terminal, artifacts: [x.profile] });
      attempt({ ...terminal, artifacts: [...terminal.artifacts, f.json(x.owned, 'second-result', typed)] });
      for (const patch of [{ schemaVersion: 2 }, { kind: 'future-kind' }, { actionSha256: 'f'.repeat(64) }, { prepared: terminal.sourceAfter },
        { controllerObservedAtMs: delivered.result.observation.transition.snapshot.fixed.startedAtMs - 1 }, { controllerObservedAtMs: auto.readRuntimeState({ projectRoot: x.root }).lastObservedAtMs - 1 }, { controllerObservedAtMs: Date.now() + 10000 }, { actor: progressActor }]) {
        attempt({ ...terminal, artifacts: [f.json(x.owned, 'bad-typed-result', { ...typed, ...patch })] });
      }
      const wrongAssignment = f.json(x.owned, 'wrong-assignment', { ...t.transitionBound(progressed), assignmentId: f.uuid() });
      attempt({ ...terminal, artifacts: [f.json(x.owned, 'foreign-assignment-result', { ...typed, result: { ...candidate, assignment: wrongAssignment } })] });
      const item = x.action('compose-spec', target, { stage: 'integration', basis }), before = x.invoke(item.q, 'checkpoint');
      assert.equal(auto.verifyTransition({ projectRoot: x.root, request: item.q, out: before.out }).observation.transition.admissibility.status, 'next-action-eligible');
      const reservedHead = auto.readRuntimeState({ projectRoot: x.root }).fileSha256;
      const reobserved = f.json(x.owned, 'copied-reobserved-work', { ...terminal, artifacts: [f.json(x.owned, 'reobserved-result', { ...typed, controllerObservedAtMs: Date.now() })] });
      const duplicate = x.action('compose-spec', target, { stage: 'integration', basis: { ...basis, workCompletion: reobserved } });
      reject('transition-work-result-replayed', () => x.invoke(duplicate.q, 'checkpoint'));
      assert.equal(auto.readRuntimeState({ projectRoot: x.root }).fileSha256, reservedHead, 'copied completion cannot reserve another consumer while the first is pending');
      const completion = commandReceipt(x, item, ['/usr/bin/git', '-C', x.root, '-c', 'core.hooksPath=/dev/null', 'merge', '--ff-only', candidate.commit], { status: 'materialized', ...candidate }, before);
      const q = x.request({ transition: x.after(before, { sessionId: null, association: null, evidence: [completion, basis.workCompletion], resolution: null }) }), after = x.invoke(q, 'checkpoint');
      assert.equal(after.result.observation.transition.admissibility.next, 'registry-revise');
      assert.equal(f.git(x.root, 'rev-parse', 'HEAD'), candidate.commit);
      assert.ok(t.readRuntimeObservation(auto.readRuntimeState({ projectRoot: x.root }).state.history.at(-1).event).associations.some((r) => r.value.worktree.commit === candidate.commit));
      assert.equal(f.sha(fs.readFileSync(f.stateFile(x.root))), canonicalBefore);
      return { scope: 'real Git candidate consumption via v2 basis; AO/Beads doubles, no proof authority', terminal, basis };
    }
    const terminal = f.json(x.owned, 'conclusive-partial', { schema: 'fvs/auto-work-completion', schemaVersion: 1, runId: x.runId, packet, marker: ack.marker,
      sourceAfter: { commit: progressActor.worktree.commit, tree: progressActor.worktree.tree }, outcome: 'partial', artifacts: [f.json(x.owned, 'partial-artifact', { status: 'partial', note: 'Protocol fixture, no proof authority' })], controllerSessionId: 'coordinator' });
    const resumeRequest = auto.prepareMemoryRequest({ projectRoot: x.root, attemptId: f.uuid(), phase: 'resume', operation: 'worker-readonly', target: { projectId: actor.projectId, sessionId: actor.sessionId, resumeId: f.uuid() } });
    const resumeBody = { ...t.readWorkPacket(packet), actor: progressActor, resumeOf: terminal, memoryRequest: resumeRequest, challenge: f.uuid(), deliveryHandle: 'resume-' + f.uuid(), startMarker: path.join(x.owned, 'resumed-worker-start.json') };
    const progressSnapshot = { ...releaseSnapshot, worker: { ...releaseSnapshot.worker, worktree: progressActor.worktree } };
    const resumedPacket = f.json(x.owned, 'linked-resume-packet', resumeBody);
    const unrecorded = x.action('release', { sessionId: actor.sessionId, association: progressed, packet: resumedPacket, handle: resumeBody.deliveryHandle }, { before: progressSnapshot, stage: 'integration' });
    reject('transition-release-uncertain', () => x.invoke(unrecorded.q, 'checkpoint'));
    const terminalIntent = x.local([], 'reconcile'), terminalBefore = x.invoke(x.request({ transition: x.before(terminalIntent) }), 'checkpoint');
    x.invoke(x.request({ transition: x.after(terminalBefore, { sessionId: null, association: null, evidence: [terminal], resolution: null }) }), 'checkpoint');
    const resumed = x.action('release', { sessionId: actor.sessionId, association: progressed, packet: resumedPacket, handle: resumeBody.deliveryHandle }, { before: progressSnapshot, stage: 'integration' });
    const resumedBefore = x.invoke(resumed.q, 'checkpoint'), resumedSent = (x.execute ?? auto.executeTransition)({ projectRoot: x.root, request: resumed.q, beforeOut: resumedBefore.out, producerOut: x.out(), evidenceDir: x.out() });
    const resumedPrime = x.out(); auto.primeMemory({ projectRoot: x.root, callerRoot: l.worktree, request: resumeRequest, out: resumedPrime });
    const resumedResult = JSON.parse(t.transitionBound(t.transitionBound(resumedSent.command).stdout, false));
    x.invoke(x.request({ transition: x.after(resumedBefore, { sessionId: null, association: null, evidence: [controllerCompletion(x, resumed, resumedBefore, resumedSent.command, resumedResult)], resolution: null }) }), 'checkpoint');
    const resumedAck = (x.ack ?? auto.acknowledgeWorkPacket)({ projectRoot: x.root, ao: resumed.q.ao, packet: resumedPacket, actor: progressActor, expectedMemoryRequest: resumeRequest, memoryOut: resumedPrime, marker: resumeBody.startMarker, out: x.out() });
    assert.equal(resumedAck.mayStart, true, 'one explicitly linked invocation after a recorded conclusive partial');
    assert.equal(fs.readFileSync(x.log, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter((a) => a[0] === 'send').length, 2, 'two different handles only across the conclusive linked resume, never a retry');
    const termination = x.action('terminate', { sessionId: actor.sessionId, association: progressed }, { before: progressSnapshot, stage: 'integration' }), tb = x.invoke(termination.q, 'checkpoint');
    const killed = (x.execute ?? auto.executeTransition)({ projectRoot: x.root, request: termination.q, beforeOut: tb.out, producerOut: x.out(), evidenceDir: x.out() });
    syncRows(x); const killedResult = JSON.parse(t.transitionBound(t.transitionBound(killed.command).stdout, false));
    x.invoke(x.request({ transition: x.after(tb, { sessionId: null, association: null, evidence: [controllerCompletion(x, termination, tb, killed.command, killedResult)], resolution: null }) }), 'checkpoint');
    assert.equal(auto.readRuntimeState({ projectRoot: x.root }).reservations.get(l.item.a.reservationId).state, 'active', 'termination alone is not a capacity resolution');
    const resolution = { transitionId: f.uuid(), reservationId: f.uuid(), stage: 'reconcile', nodes: [], owner: 'coordinator', effect: { kind: 'reservation-resolution', targetReservationId: l.item.a.reservationId } };
    const resolutionBefore = x.invoke(x.request({ transition: x.before(resolution) }), 'checkpoint');
    x.invoke(x.request({ transition: x.after(resolutionBefore, { sessionId: null, association: null, evidence: [], resolution: { reason: 'session-terminated', evidence: f.json(x.owned, 'termination-observation', killedResult) } }) }), 'checkpoint');
    assert.equal(auto.readRuntimeState({ projectRoot: x.root }).reservations.get(l.item.a.reservationId).state, 'closed');
    assert.ok(fs.existsSync(l.worktree));
  assert.equal(f.sha(fs.readFileSync(f.stateFile(x.root))), canonicalBefore);
  return { scope: "genuine Beads when explicitly enabled; AO remains a protocol double; no provider/proof/target authority", runId: x.runId, initialLaunch: l.item.actionRef, startupAck, packet, startAck: ack, linkedResume: resumedPacket, resumedStartAck: resumedAck, runtime: f.ref(path.join(x.root, ".formalising/auto-fv/resume/state.json")), canonicalStateUnchanged: true };
}
describe('stock command adapter with owned AO lifecycle double', () => {
  it('retains stale H/A/B through actual14 review publication, owned retirement/resolution and same-node proof reservation (checker/AO/Beads simulation)', () => lifecycle(fixture(), { noOp: true, consumeReview: true, staleRetirement: true }));
  it('published release consumes an exact independently bound review result via actual local14 publication', () => lifecycle(fixture(), { noOp: true, consumeReview: true }));
  it('published release with exact conclusive typed candidate permits composition and rejects mixed/old/future bindings without history writes', () => lifecycle(fixture(), { noOp: true, consumeCandidate: true }));
  it('first release and worker consumption reject a valid launch/current packet without startup/preparation', () => {
    const x = fixture(); effectDouble(x); const l = stageLaunch(x), a = t.transitionBound(l.assignment), snapshot = l.after.result.observation.transition.snapshot;
    const actor = { projectId: a.projectId, sessionId: a.sessionId, reservationId: a.reservationId, assignmentId: a.assignmentId, worktree: { ...a.worktree, dirty: false }, profile: a.rulesProfile };
    const primeRequest = auto.prepareMemoryRequest({ projectRoot: x.root, attemptId: f.uuid(), phase: 'resume', operation: 'worker-readonly', target: { projectId: a.projectId, sessionId: a.sessionId, resumeId: f.uuid() } }), memoryOut = x.out();
    auto.primeMemory({ projectRoot: x.root, callerRoot: l.worktree, request: primeRequest, out: memoryOut });
    const packet = f.json(x.owned, 'shortened-first-release', { schema: 'fvs/auto-work-packet', schemaVersion: 1, runId: x.runId, actionSha256: memory.memoryHash(l.item.a), launch: l.item.actionRef, beforeEventSha256: l.before.result.recordedEventSha256,
      actor, challenge: f.uuid(), deliveryHandle: 'shortened-' + f.uuid(), memoryRequest: primeRequest, procedure: 'lean-specify/controller-direct', inputs: [x.profile], resumeOf: null, startMarker: path.join(x.owned, 'forbidden-start.json') });
    const request = x.request; x.request = (extra = {}) => request({ associations: [l.assignment], ...extra });
    const release = x.action('release', { sessionId: actor.sessionId, association: l.assignment, packet, handle: t.readWorkPacket(packet).deliveryHandle }, { before: snapshot, stage: 'integration' });
    const original = fs.readFileSync(path.join(x.root, '.formalising/auto-fv/resume/state.json'));
    reject('transition-preparation-required', () => x.invoke(release.q, 'checkpoint'));
    const validators = t.transitionValidators({ tools: {}, git() { throw new Error('must not reach Git'); } });
    reject('transition-preparation-required', () => t.validateReleasedContext({ actionRef: release.actionRef, packet, canonical: x.canonical(), actual: snapshot, view: auto.readRuntimeState({ projectRoot: x.root }) }, validators));
    reject('resume-pair-conflict', () => auto.acknowledgeWorkPacket({ projectRoot: x.root, ao: release.q.ao, packet, actor, expectedMemoryRequest: primeRequest, memoryOut, marker: t.readWorkPacket(packet).startMarker, out: x.out() }));
    assert.deepEqual(fs.readFileSync(path.join(x.root, '.formalising/auto-fv/resume/state.json')), original); assert.equal(fs.existsSync(t.readWorkPacket(packet).startMarker), false);
    assert.equal(fs.readFileSync(x.log, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter((r) => r[0] === 'send').length, 0);
  });
  it('a missing unresolved actor association cannot use22 eligibility to dispatch despite spare capacity', () => {
    const x = fixture(); effectDouble(x); stageLaunch(x);
    syncRows(x); x.rows.find((r) => r.id === 'stage-worker').isTerminated = true; x.writeControl();
    const item = x.action(), before = fs.readFileSync(path.join(x.root, '.formalising/auto-fv/resume/state.json'));
    reject('transition-context-unavailable', () => x.invoke(item.q, 'checkpoint'));
    assert.deepEqual(fs.readFileSync(path.join(x.root, '.formalising/auto-fv/resume/state.json')), before);
    assert.equal(fs.readFileSync(x.log, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter((a) => a[0] === 'spawn').length, 1);
  });
  it('one reserved launch invokes once and unknown/replayed execution keeps its original handle/capacity', () => {
    const x = fixture(); effectDouble(x); const launch = stageLaunch(x, [19, 20]);
    assert.equal(launch.after.result.observation.transition.admissibility.next, 'prepare-input');
    assert.equal(auto.readRuntimeState({ projectRoot: x.root }).reservations.get(launch.item.a.reservationId).state, 'active');
    const oldCalls = fs.readFileSync(x.log, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter((a) => a[0] === 'spawn').length;
    reject('resume-head-stale', () => auto.executeTransition({ projectRoot: x.root, request: launch.item.q, beforeOut: launch.before.out, producerOut: x.out(), evidenceDir: x.out() }));
    const calls = fs.readFileSync(x.log, 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter((a) => a[0] === 'spawn').length;
    assert.equal(oldCalls, 1); assert.equal(calls, 1);
  });
  it('startup/FF/one release, conclusive partial resume and owned termination', () => { lifecycle(fixture()); });
  it('already-correct worker source still uses an explicit validated no-op preparation', () => { lifecycle(fixture(), { noOp: true }); });
  it('crash during delivery publication retains uncertainty and cannot start or resend work', () => { lifecycle(fixture(), { crashPublication: true }); });
  it('first release refuses an old preparation for a stale actor/candidate even at the same tree', () => { lifecycle(fixture(), { stalePreparation: true }); });
  it('genuine installed Beads primary/linked actor transition lane (AO double)', { skip: process.env.FVS_TRANSITIONS_NATIVE !== '1' }, () => { const x = fixture(true); f.json(x.owned, 'native-qualification', lifecycle(x)); });
});
describe('simulation-authority checker control trace (not Lean/proof qualification)', () => {
  it('no specs -> rejection/fresh revision -> freeze -> helper-first fixed-tree rechecks/serial accepts ->17 reference handoff', () => {
    const x = fixture(); trackRegistry(x);
    const plan = t.transitionBound(x.plan), graph = t.transitionBound(x.graph), view = registry.validatePlan({ json: plan, sha256: x.plan.sha256 }, { json: graph, sha256: x.graph.sha256 });
    const nodes = [...view.union].map((id) => ({ defId: id, ...view.nodes.get(id), owner: 'root:' + view.nodes.get(id).ownerRoot }));
    const first = t.proposeNext({ nodes, registry: {}, accepted: {}, assignments: [], baseline: null, registryHeadSha256: null, remainingMs: 100000, scope: 'fixture scope' });
    assert.deepEqual(first.nodes, [19, 20]);
    const parallel = t.proposeNext({ nodes, registry: {}, accepted: {}, assignments: [{ nodes: first.nodes, reservationId: f.uuid(), state: 'active' }], baseline: null, registryHeadSha256: null, remainingMs: 100000, scope: 'fixture scope' });
    assert.deepEqual(parallel.nodes, [21], 'independent owner remains schedulable; shared helper is never duplicated');
    const c = composition(x); x.initial = x.invoke(c.afterRequest(), 'checkpoint');
    const state = { baseline: null, records: [], heads: new Map(), checks: new Map() }, storeRoot = path.join(x.owned, 'simulation-store'); fs.mkdirSync(storeRoot);
    fs.writeFileSync(path.join(storeRoot, 'AUTHORITY.txt'), 'SIMULATION ONLY. No canonical15 event or kernel proof receipt.');
    const readStore = () => ({ records: state.records, heads: state.heads, headSha256: state.records.at(-1)?.sha256 ?? null });
    const inspectBaseline = ({ baseline }) => {
      const b = t.transitionBound(baseline); assert.equal(b.schema, 'fvs/test-simulation-baseline');
      return { registry: b.registry, nodes: [...view.union], dependencies: Object.fromEntries([...view.union].map((id) => [id, view.nodes.get(id).dependsOn])), overlays: b.overlayFiles };
    };
    const emitter = path.join(x.owned, 'simulation-producer.cjs'); fs.writeFileSync(emitter, "process.stdout.write(process.argv[2]);\n");
    const checkSimulation = (a, actual, e) => {
      assert.equal(e.command.argv[1], emitter); assert.equal(e.result.schema, 'fvs/test-simulation-check'); assert.equal(e.result.authority, 'simulation-authority');
      assert.deepEqual(e.result.nodes, a.target.nodes); assert.deepEqual(e.result.baseline, actual.baseline); assert.equal(e.result.tree, actual.source.tree);
    };
    const validators = t.transitionValidators({ tools: { auto: f.ref(path.join(f.ROOT, 'scripts/fvs-auto.mjs')), registry: f.ref(path.join(f.ROOT, 'scripts/fvs-contract-registry.mjs')), ao: x.request().ao.tool }, inspectBaseline, readStore,
      git(root, args, binary = false, status = false) { const p = spawnSync('/usr/bin/git', ['-C', root, ...args]); if (status) return p.status; assert.equal(p.status, 0, p.stderr?.toString()); return binary ? p.stdout : p.stdout.toString(); } });
    const services = { loadCanonical: x.canonical, refreshMemory: auto.refreshMemory, verifyMemory: auto.verifyMemoryBootstrap,
      inspectAcceptance({ baseline, source, store }) {
        if (store.expectedHeadSha256 !== readStore().headSha256 || [...state.heads.values()].some((r) => r.record.integrated.commit !== source.commit || r.record.frozenSha256 !== baseline?.sha256 || r.record.registryHeadSha256 !== registry.readChain(x.registryRoot).records.at(-1)?.sha
          || r.record.dependencies.some((d) => state.heads.get(d.node)?.sha256 !== d.sha256))) { const e = new Error('simulation stale source/context/helper-generation'); e.code = 'stale-input'; throw e; }
        return { status: state.heads.size ? 'current' : 'not-established', acceptedBaseline: state.heads.size ? { commit: source.commit, tree: source.expectedTree } : null, storeHeadSha256: readStore().headSha256,
          nodes: [...state.heads].map(([node, r]) => ({ node, receipt: { file: r.file, sha256: r.sha256 }, integrated: r.record.integrated })) };
      },
      transitions: { ...validators, inspectBaseline, readStore,
        verifyBaseline(a, actual, e) { assert.equal(e.command.argv[1], emitter); assert.equal(e.result.schema, 'fvs/test-simulation-freeze'); assert.equal(e.result.authority, 'simulation-authority'); assert.deepEqual(e.result.baseline, actual.baseline); },
        verifyCheck: checkSimulation,
        verifyAccept(a, before, actual, e) { assert.equal(e.command.argv[1], emitter); assert.equal(e.result.schema, 'fvs/test-simulation-accept'); assert.equal(e.result.authority, 'simulation-authority');
          const row = state.records.at(-1); assert.equal(row.record.prev, before.store.headSha256); assert.equal(row.sha256, actual.store.headSha256); assert.equal(row.record.node, a.target.node); assert.deepEqual(e.result.acceptedReceipt, { file: row.file, sha256: row.sha256 }); },
      } };
    x.transitionServices = services.transitions;
    const request = x.request; let associations = [c.assignment];
    x.request = (extra = {}) => { const q = request({ associations, ...extra }); q.inputs = { ...q.inputs, baseline: state.baseline, acceptedStore: { root: storeRoot, expectedHeadSha256: readStore().headSha256 } }; return q; };
    x.invoke = (q = x.request(), op = 'state', out = x.out()) => ({ q, out, result: resume.runResume(op, { projectRoot: x.root, request: q, out }, services) });
    function close(intent, id) {
      x.rows.find((r) => r.id === id).isTerminated = true; x.writeControl();
      const resolution = { transitionId: f.uuid(), reservationId: f.uuid(), stage: 'reconcile', nodes: [], owner: 'coordinator', effect: { kind: 'reservation-resolution', targetReservationId: intent.reservationId } };
      const before = x.invoke(x.request({ transition: x.before(resolution) }), 'checkpoint');
      x.invoke(x.request({ transition: x.after(before, { sessionId: null, association: null, evidence: [], resolution: { reason: 'session-terminated', evidence: f.json(x.owned, 'owned-termination', { session: x.rows.find((r) => r.id === id) }) } }) }), 'checkpoint');
    }
    close({ reservationId: t.transitionBound(c.assignment).reservationId }, 'author');
    // The actual assignment reservation is retained independently of its later source revision.
    function runAction(kind, target, body, change = () => {}, basis = null) {
      const stage = kind === 'freeze' ? 'check' : kind === 'check' ? 'check' : kind === 'accept' ? 'acceptance' : 'review';
      const item = x.action(kind, target, { stage, basis }), before = x.invoke(item.q, 'checkpoint');
      change();
      const completion = commandReceipt(x, item, [fs.realpathSync(process.execPath), emitter, JSON.stringify(body)], body, before), q = x.request({ transition: x.after(before, { sessionId: null, association: null, evidence: [completion], resolution: null }) }), after = x.invoke(q, 'checkpoint');
      x.initial = after;
      return { before, after, completion, basis: { beforeEventSha256: before.result.recordedEventSha256, afterEventSha256: after.result.recordedEventSha256, completion } };
    }
    const rejected = publishRegistry(reviewedInvocation(x, contract(x, 19), 'changes-requested')); assert.equal(rejected.record.state, 'changes-requested');
    const staleReview = reviewedInvocation(x, contract(x, 20));
    publishRegistry(reviewedInvocation(x, contract(x, 19, { statement: '(m1demo.helper = m1demo.helper)' }))); // Same goal, revised syntax and a distinct fresh review after rejection.
    const replay = spawnSync(staleReview.argv[0], staleReview.argv.slice(1), { encoding: 'utf8' }); assert.notEqual(replay.status, 0); assert.match(replay.stdout, /review registry head is stale/);
    publishRegistry(reviewedInvocation(x, contract(x, 20))); publishRegistry(reviewedInvocation(x, contract(x, 21)));
    assert.ok(Object.values(registry.registryStatus({ plan: x.plan.file, graph: x.graph.file, registry: x.registryRoot, 'spec-root': x.root }).nodes).every((r) => r.state === 'machine-reviewed-provisional'));
    const q0 = x.request(), reg = { root: x.registryRoot, headSha256: registry.readChain(x.registryRoot).records.at(-1).sha };
    const frozen = f.json(x.owned, 'SIMULATION-EXPECTATIONS', { schema: 'fvs/test-simulation-baseline', authority: 'simulation-authority', registry: reg, overlayFiles: ['Proofs19.lean', 'Proofs20.lean', 'Proofs21.lean'] });
    const freezeRequest = f.json(x.owned, 'simulation-freeze-request', { deadlineMs: auto.readRuntimeState({ projectRoot: x.root }).state.run.deadlineMs, baseline: { source: q0.source }, registry: reg, extraction: { identity: q0.inputs.extraction, graph: q0.inputs.graph, plan: q0.inputs.plan } });
    runAction('freeze', { request: freezeRequest }, { schema: 'fvs/test-simulation-freeze', authority: 'simulation-authority', baseline: frozen }, () => { state.baseline = frozen; });
    for (const node of [19, 20, 21]) {
      const q = x.request(), actual = x.snapshot(q);
      if (node !== 19) validators.verifyProofLaunch({ stage: 'proof', nodes: [node] }, actual);
      const intent = x.launch([node]); intent.stage = 'proof'; const beforeLaunch = x.invoke(x.request({ transition: x.before(intent) }), 'checkpoint');
      const worker = path.join(x.owned, 'proof-' + node); f.git(x.root, 'worktree', 'add', '-q', '-b', intent.effect.intendedBranchRef.slice(11), worker);
      const id = 'proof-' + node; x.rows.push(f.row(id)); x.writeControl();
      const initial = x.associate(id, worker, intent, beforeLaunch.result.recordedEventSha256); associations = [...associations, initial];
      x.invoke(x.request({ associations: associations.filter((r) => r !== initial), transition: x.after(beforeLaunch, { sessionId: id, association: initial, evidence: [], resolution: null }) }), 'checkpoint');
      const name = 'Proofs' + node + '.lean'; fs.writeFileSync(path.join(worker, name), '-- simulated proof candidate, no real Lean acceptance\n'); f.git(worker, 'add', name); f.git(worker, 'commit', '-qm', 'fixture proof candidate');
      const submitted = x.associate(id, worker, intent, beforeLaunch.result.recordedEventSha256); associations = associations.map((r) => r === initial ? submitted : r);
      const commit = f.git(worker, 'rev-parse', 'HEAD'), tree = f.git(worker, 'rev-parse', 'HEAD^{tree}'), files = { [name]: f.sha(fs.readFileSync(path.join(worker, name))) };
      const item = x.action('materialize-proof', { parent: q.source.commit, candidates: [{ commit, tree, files, assignment: submitted }], files }, { stage: 'integration' }), before = x.invoke(item.q, 'checkpoint');
      const completion = commandReceipt(x, item, ['/usr/bin/git', '-C', x.root, '-c', 'core.hooksPath=/dev/null', 'merge', '--ff-only', commit], { authority: 'simulation candidate only', commit, tree }, before);
      const materialized = x.invoke(x.request({ transition: x.after(before, { sessionId: null, association: null, evidence: [completion], resolution: null }) }), 'checkpoint'); x.initial = materialized;
      const basis = { beforeEventSha256: before.result.recordedEventSha256, afterEventSha256: materialized.result.recordedEventSha256, completion };
      assert.equal(materialized.result.observation.transition.admissibility.next, 'check');
      const current = x.request(), batch = [19, 20, 21].filter((id) => id <= node), checkBody = { schema: 'fvs/test-simulation-check', authority: 'simulation-authority', nodes: batch, baseline: frozen, tree };
      const checkRequest = f.json(x.owned, 'simulation-check-request', { baseline: frozen, source: current.source, nodes: batch, deadlineMs: auto.readRuntimeState({ projectRoot: x.root }).state.run.deadlineMs });
      const checked = runAction('check', { request: checkRequest, nodes: batch }, checkBody, () => {}, node === 19 ? null : basis);
      let acceptBasis = checked.basis;
      for (const acceptedNode of batch) {
        const source = x.request().source, job = f.json(x.owned, 'simulation-accept-request', { baseline: frozen, source, node: acceptedNode, store: { root: storeRoot, expectedHeadSha256: readStore().headSha256 }, deadlineMs: auto.readRuntimeState({ projectRoot: x.root }).state.run.deadlineMs });
        const record = { schema: 'fvs/test-simulation-accepted-event', authority: 'simulation-authority', node: acceptedNode, prev: readStore().headSha256, integrated: { commit: source.commit, tree: source.expectedTree }, frozenSha256: frozen.sha256, registryHeadSha256: reg.headSha256,
          dependencies: view.nodes.get(acceptedNode).dependsOn.map((id) => ({ node: id, sha256: state.heads.get(id).sha256 })) };
        const receipt = f.json(x.owned, 'SIMULATION-NOT-CANONICAL', record), row = { ...receipt, record };
        const accepted = runAction('accept', { request: job, node: acceptedNode }, { schema: 'fvs/test-simulation-accept', authority: 'simulation-authority', acceptedReceipt: receipt }, () => { state.records.push(row); state.heads.set(acceptedNode, row); }, acceptBasis);
        acceptBasis = accepted.basis;
      }
      const strict = x.invoke(); assert.equal(resume.consumeResume({ projectRoot: x.root, request: strict.q, out: strict.out }, services).code, 'reconciled'); x.initial = strict;
      close(intent, id);
    }
    const accepted = Object.fromEntries([...state.heads].map(([node, r]) => [node, { current: true, receipt: { file: r.file, sha256: r.sha256 } }]));
    const handoff = t.proposeNext({ nodes, registry: registry.registryStatus({ plan: x.plan.file, graph: x.graph.file, registry: x.registryRoot, 'spec-root': x.root }).nodes, accepted, assignments: [], baseline: frozen, registryHeadSha256: reg.headSha256, remainingMs: 10000, scope: 'fixture scope' });
    assert.equal(handoff.status, 'handoff-to-17'); assert.equal(handoff.accepted.length, 3); assert.match(handoff.bundleAuthority, /not implemented/); assert.equal(handoff.executable, false);
    assert.equal(state.records.length, 6, 'one fixed tree per batch; helpers/older dependency generations refreshed bottom-up');
    assert.ok(state.records.every((r) => r.record.authority === 'simulation-authority'));
    assert.throws(() => auto.reconcileState({ projectRoot: x.root, request: x.request(), out: x.out() }), (e) => ['stale-input', 'invalid-input'].includes(e.code), 'production cannot select/consume this coded simulation service or its fake store');
    assert.deepEqual(fs.readdirSync(storeRoot), ['AUTHORITY.txt']);
  });
});

// Pure row/reader boundary tests. Supplied services below are explicit protocol
// doubles; these records are not canonical proof or real Lean qualification.
function successorFixture(kind = 'freeze') {
  const x = fixture(); trackRegistry(x);
  const storeRoot = path.join(x.owned, 'simulation-accepted'), registryRoot = path.join(x.owned, 'simulation-registry');
  fs.mkdirSync(storeRoot); fs.mkdirSync(registryRoot);
  const b = x.snapshot(), source = b.source, nodes = [19, 20, 21], registry = { root: registryRoot, headSha256: 'a'.repeat(64), pending: false,
    nodes: Object.fromEntries(nodes.map(n => [n, { state: 'recheck-required' }])) };
  const frozen = f.json(x.owned, 'simulation-frozen', { authority: 'simulation-authority' }), oldFrozen = f.json(x.owned, 'old-simulation-frozen', { authority: 'simulation-authority' });
  const heads = nodes.map(node => ({ node, sha256: f.sha(String(node)), integrated: { commit: '1'.repeat(40), tree: '2'.repeat(40) }, frozenSha256: oldFrozen.sha256, registryHeadSha256: 'b'.repeat(64), dependencies: [] }));
  const priorBefore = { ...b, registry, baseline: oldFrozen, store: { root: storeRoot, headSha256: 'c'.repeat(64), pending: false, heads } };
  const recorded = { ...priorBefore, baseline: kind === 'freeze' ? frozen : oldFrozen };
  if (kind === 'accept') {
    recorded.store = { ...priorBefore.store, headSha256: 'd'.repeat(64), heads: heads.map(r => r.node === 19 ? { ...r, integrated: { commit: source.commit, tree: source.tree }, frozenSha256: oldFrozen.sha256, registryHeadSha256: registry.headSha256 } : r) };
  }
  if (kind === 'registry-revise') {
    priorBefore.registry = { ...registry, headSha256: 'e'.repeat(64) };
    recorded.registry = { ...registry, nodes: { ...registry.nodes, 20: { state: 'needs-semantic-review' }, 21: { state: 'needs-semantic-review' } } };
  }
  const simulatedInvocation = f.json(x.owned, 'simulation-registry-invocation', { schema: 'fvs/auto-registry-invocation', schemaVersion: 1, plan: x.plan, graph: x.graph, registry: registryRoot, specRoot: x.root, contract: x.profile, review: x.profile, previous: null });
  const prior = x.action(kind, kind === 'freeze' ? { request: x.profile } : kind === 'accept' ? { request: x.profile, node: 19 } : { request: simulatedInvocation, review: x.profile, candidateSha256: 'f'.repeat(64) }, { before: priorBefore, stage: 'check' });
  const before = { sha256: '3'.repeat(64), event: { position: 'before', intent: prior.intent, observedAtMs: Date.now() - 100 } };
  const result = kind === 'freeze' ? { baseline: frozen } : kind === 'accept' ? { acceptedReceipt: { sha256: recorded.store.headSha256 } }
    : { recordSha256: recorded.registry.headSha256, record: { prev: priorBefore.registry.headSha256, candidateSha256: prior.a.target.candidateSha256 } };
  const completion = commandReceipt(x, prior, ['/usr/bin/true'], result, { result: { recordedEventSha256: before.sha256 } });
  const after = { sha256: '4'.repeat(64), event: { position: 'after', beforeEventSha256: before.sha256, intent: prior.intent, observedAtMs: Date.now(), outcome: 'succeeded', effect: { evidence: [completion] },
    observation: { transition: { snapshot: recorded, admissibility: { status: 'facts-recorded-partial', beforeEventSha256: before.sha256, completion } } } } };
  const run = auto.readRuntimeState({ projectRoot: x.root }).state.run, history = [before, after], view = { state: { run, history }, lastObservedAtMs: after.event.observedAtMs };
  const validators = t.transitionValidators({ tools: {}, git() { throw Error('unexpected Git in protocol dependency test'); }, inspectBaseline() { return { nodes, registry: { root: registryRoot, headSha256: registry.headSha256 }, dependencies: { 19: [], 20: [19], 21: [19] } }; } });
  let protectedChecks = 0, registryChecks = 0;
  const services = { ...validators, verifyTarget() {}, verifyBaseline() {}, verifyAccept() {}, verifyRegistry() {},
    verifyProtectedCheck(a, actual) { protectedChecks++; validators.verifyProofLaunch({ ...a, nodes: a.target.nodes, stage: 'proof' }, actual); },
    verifyRegistryBefore() { registryChecks++; } };
  const basis = { version: 2, beforeEventSha256: before.sha256, afterEventSha256: after.sha256, completion, workCompletion: null };
  const action = (kind, options = {}) => {
    const intent = kind === 'launch' ? x.launch(options.nodes ?? [19]) : x.local(options.nodes ?? [19], options.stage ?? 'check');
    intent.stage = options.stage ?? (kind === 'launch' ? 'proof' : 'check');
    const target = kind === 'check' ? { request: x.profile, nodes: [19] } : kind === 'launch' ? { projectId: 'fixture-project', branchRef: intent.effect.intendedBranchRef, assignmentId: intent.effect.assignmentId, startup: { challenge: f.uuid(), attemptId: f.uuid(), phase: 'start', resumeId: null } }
      : kind === 'accept' ? { request: x.profile, node: 20 } : kind === 'freeze' ? { request: x.profile } : { request: simulatedInvocation, review: x.profile, candidateSha256: 'f'.repeat(64) };
    return x.action(kind, target, { basis, before: recorded, nodes: [19], stage: intent.stage, ...options, intent });
  };
  const invoke = (item, extra = {}, overrides = {}) => assess(x, item, item.a.before, { view, run, reasons: ['acceptance-unverified'], ...extra }, { ...services, ...overrides });
  return { x, basis, prior, before, after, recorded, view, run, action, invoke, services, protectedChecks: () => protectedChecks, registryChecks: () => registryChecks };
}
describe('fresh registry successor preflight (actual14, declared review fixture)', () => {
  it('same shared contract/review readers reject stale, mismatched and reused publication before append', () => {
    const x = fixture(); trackRegistry(x);
    const contract = { node: 19, role: 'helper', statement: 'True', assumptions: [], grounding: { kind: 'none', reason: 'Protocol fixture only' }, implementationDependencies: [], specDefinitions: [], externalReferences: [], author: { session: 'fixture-author', harness: 'fixture', model: 'none', runId: f.uuid() } };
    const input = reviewedInvocation(x, contract), v = t.transitionValidators({ tools: {}, git() { throw Error('not used'); } });
    const actual = () => ({ source: { root: x.root }, registry: { root: x.registryRoot, headSha256: registry.readChain(x.registryRoot).records.at(-1)?.sha ?? null } });
    const a = { target: { request: input.request, review: input.review, candidateSha256: input.candidateSha256 } };
    v.verifyRegistryBefore(a, actual()); assert.equal(registry.readChain(x.registryRoot).records.length, 0);
    const original = t.transitionBound(input.request), runtime = auto.readRuntimeState({ projectRoot: x.root }).fileSha256;
    for (const body of [{ ...original, schemaVersion: 2 }, { ...original, extra: true }, Object.fromEntries(Object.entries(original).filter(([k]) => k !== 'schema'))]) {
      const request = f.json(x.owned, 'malformed-registry-invocation', body), action = x.action('registry-revise', { ...a.target, request }, { stage: 'review' });
      assert.throws(() => v.verifyRegistryBefore({ target: { ...a.target, request } }, actual()), e => ['transition-registry-unverified', 'transition-invalid-input'].includes(e.code));
      assert.throws(() => x.invoke(action.q, 'checkpoint'), e => ['transition-registry-unverified', 'transition-invalid-input'].includes(e.code));
      assert.throws(() => t.transitionCommand({ actionRef: action.actionRef, ao: action.q.ao.tool, tools: {}, out: x.out(), beforeEventSha256: 'a'.repeat(64) }), e => ['transition-registry-unverified', 'transition-invalid-input'].includes(e.code));
      assert.equal(registry.readChain(x.registryRoot).records.length, 0); assert.equal(auto.readRuntimeState({ projectRoot: x.root }).fileSha256, runtime);
    }

    for (const key of ['contract', 'review']) {
      const stale = { ...original, [key]: { ...original[key], sha256: '0'.repeat(64) } }, request = f.json(x.owned, 'stale-bound-registry-input', stale);
      const action = x.action('registry-revise', { ...a.target, request, review: stale.review }, { stage: 'review' });
      reject('transition-evidence-invalid', () => x.invoke(action.q, 'checkpoint'));
      reject('transition-evidence-invalid', () => t.transitionCommand({ actionRef: action.actionRef, ao: action.q.ao.tool, tools: {}, out: x.out(), beforeEventSha256: 'a'.repeat(64) }));
      assert.equal(registry.readChain(x.registryRoot).records.length, 0); assert.equal(auto.readRuntimeState({ projectRoot: x.root }).fileSha256, runtime);
    }
    reject('transition-registry-unverified', () => v.verifyRegistryBefore({ target: { ...a.target, candidateSha256: 'b'.repeat(64) } }, actual()));
    publishRegistry(input); const head = registry.readChain(x.registryRoot).records.at(-1).sha;
    reject('transition-registry-unverified', () => v.verifyRegistryBefore(a, actual()));
    const reused = f.json(x.owned, 'reused-review-at-new-head', { ...t.transitionBound(input.review), registryHeadSha256: head });
    const request = f.json(x.owned, 'reused-invocation', { ...t.transitionBound(input.request), previous: head, review: reused });
    reject('transition-registry-unverified', () => v.verifyRegistryBefore({ target: { ...a.target, request, review: reused } }, actual()));
    assert.equal(registry.readChain(x.registryRoot).records.at(-1).sha, head); assert.equal(registry.readChain(x.registryRoot).records.length, 1);
  });
});
describe('v2 finite frontiers with retained stale heads (protocol doubles)', () => {
  it('completed freeze permits protected H recheck while all H/A/B old heads remain historical', () => {
    const z = successorFixture(), item = z.action('check');
    assert.equal(z.invoke(item).status, 'next-action-eligible'); assert.equal(z.protectedChecks(), 1);
    assert.equal(z.recorded.store.heads.length, 3); assert.ok(z.recorded.store.heads.every(r => r.integrated.commit !== z.recorded.source.commit));
    reject('transition-proof-dependencies-unverified', () => z.invoke(z.action('check', { nodes: [20], target: { request: z.x.profile, nodes: [20] } })));
  });
  it('current H accept permits A proof launch with unrelated stale A/B still present; old helper generations refuse', () => {
    const z = successorFixture('accept');
    assert.equal(z.invoke(z.action('launch', { nodes: [20] })).status, 'next-action-eligible');
    z.after.event.observation.transition.snapshot.store.heads[0].frozenSha256 = '0'.repeat(64);
    reject('transition-proof-dependencies-unverified', () => z.invoke(z.action('launch', { nodes: [20] })));
    assert.equal(z.recorded.store.heads.length, 3);
  });
  it('registry frontier admits exact new publication/needed review, but not proof or premature freeze', () => {
    const z = successorFixture('registry-revise');
    assert.equal(z.invoke(z.action('registry-revise')).status, 'next-action-eligible'); assert.equal(z.registryChecks(), 1);
    assert.equal(z.invoke(z.action('launch', { nodes: [20], stage: 'review' })).status, 'next-action-eligible');
    reject('transition-scope-unverified', () => z.invoke(z.action('launch', { nodes: [999], stage: 'review' })));
    reject('transition-next-action-forbidden', () => z.invoke(z.action('freeze')));
    reject('transition-next-action-forbidden', () => z.invoke(z.action('launch', { nodes: [20] })));
    reject('transition-next-action-forbidden', () => z.invoke(z.action('launch', { nodes: [19], stage: 'review' })));
  });
  for (const field of ['source', 'registry', 'baseline', 'store', 'fixed']) it('coherently changed action/current ' + field + ' cannot reuse an old recorded after snapshot', () => {
    const z = successorFixture(), actual = JSON.parse(JSON.stringify(z.recorded));
    if (field === 'source') actual.source.commit = '5'.repeat(40);
    if (field === 'registry') actual.registry.headSha256 = '5'.repeat(64);
    if (field === 'baseline') actual.baseline = z.x.profile;
    if (field === 'store') actual.store.heads = actual.store.heads.slice(1);
    if (field === 'fixed') actual.fixed.scopeSha256 = '5'.repeat(64);
    reject('transition-extra-drift', () => z.invoke(z.action('check', { before: actual })));
  });
  it('unrecorded/mismatched after, pending state and extra work evidence refuse', () => {
    const z = successorFixture();
    z.after.event.observation.transition.admissibility.status = 'facts-unverified';
    reject('transition-explanation-required', () => z.invoke(z.action('check')));
    z.after.event.observation.transition.admissibility.status = 'facts-recorded-partial';
    const actual = { ...z.recorded, store: { ...z.recorded.store, pending: true } };
    reject('transition-context-unavailable', () => z.invoke(z.action('check', { before: actual })));
    reject('transition-work-result-invalid', () => z.invoke(z.action('check', { basis: { ...z.basis, workCompletion: z.x.profile } })));
  });
  it('clock crossing during last guard or rolling back cannot publish new permission', () => {
    const z = successorFixture(), item = z.action('check');
    reject('transition-budget-exhausted', () => z.invoke(item, {}, { now: () => z.run.deadlineMs }));
    reject('transition-clock-rollback', () => z.invoke(item, {}, { now: () => z.before.event.observedAtMs - 1 }));
  });
  it('unknown basis versions/hybrids never coerce into legacy authority', () => {
    const z = successorFixture();
    reject('transition-invalid-input', () => z.invoke(z.action('check', { basis: { ...z.basis, version: 3 } })));
    reject('transition-invalid-input', () => z.invoke(z.action('check', { basis: { ...z.basis, extra: true } })));
    const legacy = { beforeEventSha256: z.basis.beforeEventSha256, afterEventSha256: z.basis.afterEventSha256, completion: z.basis.completion };
    reject('transition-next-action-forbidden', () => z.invoke(z.action('check', { basis: legacy })));
  });
  it('protected-target reader binds prior target/module/file plus current frozen protected bytes, never a mutable/future target', () => {
    const x = fixture(), file = 'Proof.lean', identity = { sha256: f.sha('theorem fixture : True := by trivial\n'), size: 42 };
    const target = { node: 19, name: 'fixture', module: 'Proof' }, build = { source: { files: { [file]: identity } }, modules: [{ name: 'Proof', source: file }] };
    const old = f.json(x.owned, 'SIMULATION-prior-frozen', { targets: [target] }), checked = f.json(x.owned, 'SIMULATION-integrated', { build });
    const history = { records: [{ record: { node: 19, baseline: old, integratedCheck: checked } }] };
    const v = t.transitionValidators({ tools: {}, readStore: () => history, inspectBaseline: () => ({ nodes: [19], registry: { root: x.root, headSha256: 'a'.repeat(64) }, dependencies: { 19: [] } }),
      git() { return Buffer.from('theorem fixture : True := by trivial\n'); } });
    const actual = { source: { root: x.root, commit: '1'.repeat(40) }, baseline: f.json(x.owned, 'SIMULATION-current-frozen', { targets: [target], build, overlayFiles: [] }), fixed: { deadlineMs: Date.now() + 10000 },
      registry: { root: x.root, headSha256: 'a'.repeat(64), nodes: { 19: { state: 'recheck-required' } } }, store: { root: x.owned, heads: [] } };
    v.verifyProtectedCheck({ target: { nodes: [19] } }, actual);
    for (const body of [{ targets: [target], build, overlayFiles: [file] }, { targets: [{ ...target, name: 'new_target' }], build, overlayFiles: [] },
      { targets: [target], build: { ...build, modules: [] }, overlayFiles: [] }, { targets: [target], build: { ...build, source: { files: { [file]: { ...identity, sha256: 'b'.repeat(64) } } } }, overlayFiles: [] }]) {
      reject('transition-protected-proof-required', () => v.verifyProtectedCheck({ target: { nodes: [19] } }, { ...actual, baseline: f.json(x.owned, 'refused-frozen', body) }));
    }
  });
});
