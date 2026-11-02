// Protocol metadata only. The explicit inspector double is installed by the test.
// No producer/compiler runs and these objects never establish proof acceptance.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const f = require('./respec-fixture.cjs');
const read = file => JSON.parse(fs.readFileSync(file));
const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); return f.ref(file); };
const sourceFiles = ['fvs-auto.mjs', 'fvs-auto-resume.mjs', 'fvs-auto-transitions.mjs', 'fvs-project-memory.mjs', 'fvs-checker.mjs', 'FvsKernelAudit.lean', 'fvs-checker-auto.mjs', 'fvs-checker-build.mjs', 'fvs-rust-identity.mjs', 'fvs-lean-graph.mjs', 'fvs-closure-plan.mjs', 'fvs-contract-registry.mjs', 'fvs-probe-inventory.mjs', 'fvs-probe-linux.mjs', 'fvs-extract-patches.mjs'];
async function fixture(auto, bundle, transitions, api, clock) {
  const { memoryHash } = await import('../../scripts/fvs-project-memory.mjs');
  const x = await f.fixture(auto, bundle, transitions, process.env.FVS_RESPEC_QUAL_OUT ?? undefined);
  fs.writeFileSync(path.join(x.root, 'lean-toolchain'), 'leanprover/lean4:v4.31.0\n');
  fs.writeFileSync(path.join(x.root, 'lake-manifest.json'), '{"packages":[]}\n');
  f.git(x.root, 'add', '--', 'lean-toolchain', 'lake-manifest.json'); f.git(x.root, 'commit', '-qm', 'test(fixture): bind configured producer context');
  const template = x.respecRequest();
  const b = x.bundle, last = await x.registryFixture.register(b, 21); b.registry.expectedHeadSha256 = last.recordSha256;
  const store = path.join(x.owned, 'empty-store'); fs.mkdirSync(store);
  const tools = { node: f.ref(process.execPath), bd: f.ref(path.join(x.root, 'fixture-bd.cjs')), ps: f.ref(fs.realpathSync('/bin/ps')) };
  tools.lean = write(path.join(x.owned, 'lean-tool'), 'protocol identity only; not executable'); tools.lake = write(path.join(x.owned, 'lake-tool'), 'protocol identity only; not executable');
  const engine = Object.fromEntries([process.execPath, '/usr/bin/git', ...sourceFiles.map(n => path.join(f.ROOT, 'scripts', n))].map(file => [file, f.ref(file).sha256]));
  const input = f.json(x.owned, 'SIMULATION-freeze-input', { baseline: { source: x.request().source, libraries: ['Defs'], sourceRoot: '.',
    lean: { path: tools.lean.file, sha256: tools.lean.sha256 }, lake: { path: tools.lake.file, sha256: tools.lake.sha256 } } });
  const baseline = f.json(x.owned, 'SIMULATION-baseline', { schema: 'fvs-checker/auto-baseline', version: 1, purpose: 'auto', authority: 'expectations-only',
    input, overlayFiles: [], records: {}, targets: [], checker: engine, build: { projectRoot: x.root }, compiled: {}, imports: {}, runtimes: {} });
  const inputs = { extraction: b.extraction, graph: b.graph, plan: b.plan, baseline, acceptedStore: { root: store, expectedHeadSha256: null } };
  global.__terminationInspectors.set(baseline.file, { baseline, registry: { root: x.registry, headSha256: last.recordSha256 }, source: x.request().source,
    nodes: [19, 20, 21], dependencies: { 19: [], 20: [19], 21: [19] }, inputs: { extraction: b.extraction, graph: b.graph, plan: b.plan } });
  const revisionRequest = (operation = 'inspect', inspectEvidence = null) => {
    const current = x.invoke(x.request({ inputs })), q = structuredClone(template);
    q.operation = operation; q.inspectEvidence = inspectEvidence; q.attemptId = current.q.attemptId; q.deadlineMs = Date.now() + 120000;
    q.current.bundle = { ...structuredClone(b), source: current.q.source, baseline, acceptedStore: inputs.acceptedStore,
      bundleId: f.uuid(), deadlineMs: q.deadlineMs, runtime: { root: x.root, state: f.ref(path.join(x.root, '.formalising/auto-fv/resume/state.json')), absenceReason: null },
      absenceReasons: { baseline: null, acceptedStore: null, runtime: null, handoff: 'protocol only' } };
    q.current.resume = { request: f.ref(path.join(current.out, 'request.json')), result: f.ref(path.join(current.out, 'result.json')), committedHeadSha256: current.result.committedHeadSha256 };
    q.current.memory = { request: f.ref(path.join(current.result.observation.memory.out, 'request.json')), result: f.ref(path.join(current.result.observation.memory.out, 'result.json')) };
    return q;
  };
  const initialQ = revisionRequest(), initial = api.runRespec({ request: initialQ, out: x.output('initial') });
  const priorManifest = read(initial.request.priorBundle.manifest.file), priorRuntime = priorManifest.snapshot.request.runtime.state;
  const priorCopy = priorManifest.copies.find(r => r.original === priorRuntime.file && r.sha256 === priorRuntime.sha256);
  const historicalCaptures = [
    { schema: 'fvs/auto-bundle-historical-input', schemaVersion: 1, original: initial.request.current.bundle.runtime.state,
      archive: write(path.join(x.owned, 'initial-runtime.json'), fs.readFileSync(initial.request.current.bundle.runtime.state.file)), mode: 0o600 },
    { schema: 'fvs/auto-bundle-historical-input', schemaVersion: 1, original: priorRuntime,
      archive: f.ref(path.join(path.dirname(initial.request.priorBundle.manifest.file), priorCopy.stored)), mode: priorCopy.mode },
  ];
  const q = x.request({ inputs }), intent = x.local([], 'acceptance'), step = '122-protocol-accept';
  const caseRoot = path.join(x.owned, 'protocol-case'), evidenceRoot = path.join(x.owned, 'protocol-outer'), producerOut = path.join(caseRoot, 'steps', step, 'producer');
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const target = { request: write(path.join(caseRoot, 'steps', step, 'producer-request.json'), { schema: 'fvs-checker/accept-request', version: 1, purpose: 'auto',
    runId: 'protocol-only-no-compiler', node: 19, source: q.source, baseline, store: inputs.acceptedStore, deadlineMs: Date.now() + 600000 }), node: 19 };
  const view = auto.readState({ projectRoot: x.root, requireAgreement: true }), profile = initialQ.current.profile, authorization = initialQ.current.authorization;
  const snapshot = transitions.transitionSnapshot({ q, run: auto.readRuntimeState({ projectRoot: x.root }).state.run, canonical: { view, envelope: view.agreement.agreement },
    observation: { identity: { source: { root: x.root, commit: q.source.commit, tree: q.source.expectedTree, branchRef: f.git(x.root, 'symbolic-ref', 'HEAD'), gitCommonDir: x.root + '/.git', dirty: false } }, associations: [] },
    action: { before: { registry: { root: x.registry } }, target, authorization, profile, owner: intent.owner, nodes: [] } }, { profileObservation: read(profile.file).controller });
  const action = { schema: 'fvs/auto-transition-request', schemaVersion: 1, runId: x.runId, transitionId: intent.transitionId, reservationId: intent.reservationId,
    kind: 'accept', stage: 'acceptance', nodes: [], owner: intent.owner, expectedHeadSha256: q.expectedHeadSha256, before: snapshot, target, authorization, profile, basis: null };
  const actionRef = f.json(x.owned, 'action', action); intent.request = actionRef; q.transition = x.before(intent); const before = x.invoke(q, 'checkpoint');
  const stateFile = path.join(x.root, '.formalising/auto-fv/resume/state.json'), beforeBytes = fs.readFileSync(stateFile), runtimeBefore = write(path.join(evidenceRoot, 'runtime-before.json'), beforeBytes);
  const marker = write(path.join(x.root, '.formalising/auto-fv/resume/effects', before.result.recordedEventSha256 + '.json'), {
    schema: 'fvs/auto-effect-start', schemaVersion: 1, status: 'execution-uncertain', beforeEventSha256: before.result.recordedEventSha256,
    committedHeadSha256: before.result.recordedEventSha256, action: actionRef, evidenceDir: path.join(caseRoot, 'steps', step, 'command') });
  const code = Object.fromEntries(['controller', 'wrapper', 'driver'].map(k => [k, f.ref(path.join(f.ROOT, 'fv-skills/references/controller-termination-v1-' + k + '.source.txt'))]));
  code.builder = f.ref(path.join(f.ROOT, 'scripts/fvs-checker-build.mjs'));
  const sourceSnapshot = { head: f.git(f.ROOT, 'rev-parse', 'HEAD'), tree: f.git(f.ROOT, 'rev-parse', 'HEAD^{tree}'), files: sourceFiles.map(n => {
    const file = path.join(f.ROOT, 'scripts', n); return { path: 'scripts/' + n, sha256: f.ref(file).sha256, mode: '100644', size: fs.statSync(file).size };
  }) };
  const prepared = f.json(evidenceRoot, 'prepared', { schema: 'fvs/owned-continuous-input-preparation', version: 1, runId: x.runId, status: 'non-authoritative-inputs-only', q: { expectedHeadSha256: q.expectedHeadSha256 }, closure: f.json(evidenceRoot, 'prior-closure', { authority: 'protocol-only' }) });
  const began = before.result.observation.observedAtMs ?? auto.readRuntimeState({ projectRoot: x.root }).lastObservedAtMs;
  const outerStart = Math.max(began, Date.now()), end = outerStart + 600098;
  clock.advance(end + 2000);
  const env = { PATH: path.dirname(tools.node.file) + ':/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', HOME: path.join(evidenceRoot, 'home'), TMPDIR: path.join(evidenceRoot, 'tmp'), XDG_CACHE_HOME: path.join(evidenceRoot, 'cache'), XDG_CONFIG_HOME: path.join(evidenceRoot, 'config'), XDG_DATA_HOME: path.join(evidenceRoot, 'data'), FVS_BRIDGE_BD: tools.bd.file };
  const argv = ['/usr/bin/env', '-i', ...Object.entries(env).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + '=' + v), tools.node.file, code.controller.file, 'before-run', caseRoot, step, evidenceRoot, read(prepared.file).closure.file, read(prepared.file).closure.sha256, prepared.sha256];
  const pid = 1900000000, launch = f.json(evidenceRoot, 'launch', { pid, argv, startedAtMs: outerStart, deadlineMs: outerStart + 600000 });
  const outer = f.json(evidenceRoot, 'outer', { mode: 'before-run', step, argv, env, startedAtMs: outerStart, absoluteDeadlineMs: outerStart + 600000, endedAtMs: end, durationMs: 600098,
    deadlineSeconds: 600, exitCode: -9, signal: 9, timedOut: true, sourceUnchanged: true, protectedUnchanged: true, controllersUnchanged: true, immutableInputsUnchanged: true,
    sourceBefore: sourceSnapshot, sourceAfter: sourceSnapshot, protectedBefore: [], protectedAfter: [], immutableInputsBefore: [], immutableInputsAfter: [],
    controllersBefore: [code.controller, code.wrapper], controllersAfter: [code.controller, code.wrapper], node: tools.node, bd: tools.bd,
    inhibitor: { argv: ['/usr/bin/caffeinate', '-is', '-w', String(pid)], terminated: true, exitCode: 0 }, stdout: write(path.join(evidenceRoot, 'outer.stdout'), ''), stderr: write(path.join(evidenceRoot, 'outer.stderr'), '') });
  const buildRoot = path.join(producerOut, 'integrated/candidate-build'), receipts = path.join(buildRoot, 'receipts'), project = path.join(buildRoot, 'source');
  fs.mkdirSync(project, { recursive: true }); fs.mkdirSync(receipts, { recursive: true });
  let tick = outerStart, children = [];
  const child = (args, cwd, output) => {
    const id = String(children.length + 1).padStart(4, '0'), r = write(path.join(receipts, id + '.json'), { argv: args, cwd, exit: 0, signal: null, timedOut: false,
      startedAt: ++tick, endedAt: ++tick, stdout: write(path.join(receipts, id + '.stdout'), output), stderr: write(path.join(receipts, id + '.stderr'), ''),
      inputsBefore: 'a'.repeat(64), inputsAfter: 'a'.repeat(64), outputLimitExceeded: false }); children.push(r); return output;
  };
  const git = (...args) => { const p = spawnSync('/usr/bin/git', ['-C', x.root, ...args], { env: { PATH: '/usr/bin:/bin', GIT_NO_LAZY_FETCH: '1' } }); if (p.status !== 0) throw Error(p.stderr); return child(['/usr/bin/git', ...args], x.root, p.stdout); };
  git('rev-parse', '--show-toplevel'); git('cat-file', 'commit', q.source.commit); git('rev-parse', q.source.commit + '^{tree}'); git('cat-file', 'tree', q.source.expectedTree);
  const files = {};
  for (const entry of git('ls-tree', '-rzt', '--full-tree', q.source.commit).toString().split('\0').filter(Boolean)) {
    const m = /^(\d+) (tree|blob) ([a-f0-9]+)\t(.+)$/.exec(entry), body = git('cat-file', m[2], m[3]);
    if (m[2] === 'blob') files[m[4]] = { sha256: f.sha(body), size: body.length };
  }
  const prefix = ['/usr/bin/sandbox-exec', '-f', path.join(buildRoot, 'build.sb')];
  for (const args of [[tools.lean.file, '--version'], [tools.lake.file, '--version'], [tools.lake.file, '--no-cache', '--rehash', '--verbose', 'build', 'Defs'], [tools.lake.file, 'env', '/usr/bin/printenv', 'LEAN_PATH']]) child([...prefix, ...args], project, 'protocol-only: this child was not executed\n');
  const build = { root: buildRoot, source: write(path.join(receipts, 'source.json'), { kind: 'git', originalRoot: x.root, commit: q.source.commit, tree: q.source.expectedTree, files }),
    runtime: write(path.join(receipts, 'runtime.json'), { files: { 'protocol-runtime': { sha256: 'a'.repeat(64), size: 1 } } }),
    dependenciesBefore: write(path.join(receipts, 'dependencies-before.json'), {}), dependenciesAfter: write(path.join(receipts, 'dependencies-after.json'), {}), ownedDependenciesAfter: write(path.join(receipts, 'dependencies-owned-after.json'), {}), libraries: ['Defs'], children };
  const observer = f.json(evidenceRoot, 'observer', { schema: 'fvs/auto-process-inventory', schemaVersion: 1, tool: tools.ps, argv: [tools.ps.file, '-axo', 'pid=,ppid=,pgid=,command='], cwd: '/',
    observerPid: process.pid, startedAtMs: end + 1, endedAtMs: end + 2, exitCode: 0, signal: null, error: null, outputLimitExceeded: false,
    stdout: write(path.join(evidenceRoot, 'observer.stdout'), '1 0 1 /sbin/launchd\n' + process.pid + ' 1 ' + process.pid + ' node protocol-observer\n'), stderr: write(path.join(evidenceRoot, 'observer.stderr'), '') });
  const canonicalObservations = f.json(evidenceRoot, 'canonical', { schema: 'fvs/owned-a122-readonly-observations', version: 1, runId: x.runId, currentHead: before.result.recordedEventSha256,
    expectedBeforeEventSha256: before.result.recordedEventSha256, expectedAction: actionRef, snapshotBefore: snapshot, snapshotAfter: snapshot,
    runtimeBefore, runtimeCurrent: f.ref(stateFile), startedAtMs: end + 1, endedAtMs: end + 2, originalRunDeadlineMs: snapshot.fixed.deadlineMs });
  const context = { schema: 'fvs/auto-controller-termination-context', schemaVersion: 1, lifecycle: 'configured-git-local-accept-finalization-v1',
    trustScope: 'trusted-host known managed lifecycle; no retrospective full PID lineage or inner producer outcome', runId: x.runId, beforeEventSha256: before.result.recordedEventSha256,
    transitionId: action.transitionId, reservationId: action.reservationId, action: actionRef, job: target.request, caseRoot, evidenceRoot, producerOut, step, code, tools, sourceSnapshot,
    beforeRequest: f.ref(path.join(before.out, 'request.json')), beforeResult: f.ref(path.join(before.out, 'result.json')), marker, launch, outer, prepared, build, observer, canonicalObservations,
    innerProducer: { startedAtMs: null, endedAtMs: null, exitCode: null, signal: null, error: null, status: 'unknown' } };
  // Branch an owned protocol fixture at its before bytes. This is never a live run.
  const complete = change => {
    fs.writeFileSync(stateFile, beforeBytes); const c = structuredClone(context); change?.(c);
    const evidence = f.json(evidenceRoot, 'termination-context', c), after = x.invoke(x.request({ inputs, transition: x.after(before, { sessionId: null, association: null, evidence: [evidence], resolution: null }, 'failed') }), 'checkpoint');
    const request = { schema: 'fvs/auto-respec-controller-termination-request', schemaVersion: 1, attemptId: f.uuid(), runId: x.runId,
      expectedBeforeEventSha256: before.result.recordedEventSha256, expectedAction: actionRef, expectedContext: c, terminationEvidence: evidence,
      afterRequest: f.ref(path.join(after.out, 'request.json')), afterResult: f.ref(path.join(after.out, 'result.json')), committedHeadSha256: after.result.committedHeadSha256, deadlineMs: Date.now() + 120000 };
    return { request, after, state: f.ref(stateFile) };
  };
  return { x, context, complete, initial, initialQ, revisionRequest, historicalCaptures, before, action, actionRef, stateFile, store, write, read, memoryHash };
}
module.exports = { ...f, fixture, read, write };
