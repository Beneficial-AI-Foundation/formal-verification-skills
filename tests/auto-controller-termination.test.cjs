// Generic algorithm tests explicitly double18's exact-profile assertion,15
// inspectors and PS. The separate auto-controller-profile tests use the REAL
// profile assertion on copied retained metadata. No production applicability claim.
const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { registerHooks, syncBuiltinESMExports } = require('node:module');
const { pathToFileURL } = require('node:url');
const f = require('./helpers/termination-fixture.cjs');
global.__terminationInspectors = new Map();
const realChecker = pathToFileURL(path.join(f.ROOT, 'scripts/fvs-checker-auto.mjs')).href;
const realRespec = pathToFileURL(path.join(f.ROOT, 'scripts/fvs-auto-respec.mjs')).href;
let profileDoubleCalls = 0;
global.__terminationProfileDouble = () => { profileDoubleCalls++; };
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.endsWith('/fvs-checker-auto.mjs') || specifier === './fvs-checker-auto.mjs') return { url: 'termination-protocol:checker', shortCircuit: true };
  return next(specifier, context);
}, load(url, context, next) {
  if (url === realRespec) {
    const source = fs.readFileSync(path.join(f.ROOT, 'scripts/fvs-auto-respec.mjs'), 'utf8');
    const call = 'assertKnownControllerPreparation({ context: c, action: a, before, run, beforeRequest: bq, beforeResult: br, prepared, outer, history });';
    assert.equal(source.split(call).length, 2, 'one explicit test-only profile double seam');
    return { format: 'module', shortCircuit: true, source: source.replace(call, 'globalThis.__terminationProfileDouble();') };
  }
  if (url !== 'termination-protocol:checker') return next(url, context);
  return { format: 'module', shortCircuit: true, source: `export * from ${JSON.stringify(realChecker + '?original-protocol-reader')};
    import fs from 'node:fs';
    const facts = b => { const v = globalThis.__terminationInspectors.get(b.file); if (!v || !fs.existsSync(b.file)) throw Error('unregistered inspector double'); return v; };
    export function inspectAutoBaselineArtifacts({baseline}) { return {status:'artifacts-valid',authority:'expectations-only',targetProofsChecked:false,...facts(baseline)}; }
    export function inspectAutoAcceptance({baseline}) { const v=facts(baseline); return {status:'current',acceptedBaseline:baseline,nodes:[],storeHeadSha256:null,inputs:v.inputs}; }` };
} });
let auto, bundle, transitions, api, exactApi, p, savedSpawn = cp.spawnSync, realNow = Date.now, offset = 0, processPatch = null;
const clock = { advance(time) { offset = Math.max(offset, time - realNow()); } };
before(async () => {
  Date.now = () => realNow() + offset;
  cp.spawnSync = function(file, args, options) {
    if (file !== fs.realpathSync('/bin/ps')) return savedSpawn.call(cp, file, args, options);
    const value = { status: 0, signal: null, stdout: Buffer.from('1 0 1 /sbin/launchd\n' + process.pid + ' 1 ' + process.pid + ' node protocol-observer\n'), stderr: Buffer.alloc(0) };
    processPatch?.(value); return value;
  }; syncBuiltinESMExports();
  auto = await import('../scripts/fvs-auto.mjs'); bundle = await import('../scripts/fvs-auto-bundle.mjs');
  transitions = await import('../scripts/fvs-auto-transitions.mjs'); api = await import('../scripts/fvs-auto-respec.mjs');
  exactApi = await import('../scripts/fvs-auto-respec.mjs?unmocked-profile');
  p = await f.fixture(auto, bundle, transitions, api, clock);
});
after(() => { cp.spawnSync = savedSpawn; syncBuiltinESMExports(); Date.now = realNow; hooks.deregister(); delete global.__terminationInspectors; delete global.__terminationProfileDouble; });
const changeRef = (c, field, edit) => { const body = f.read(c[field].file); edit(body); c[field] = f.json(p.x.owned, field, body); };
const verify = q => api.verifyControllerTermination({ projectRoot: p.x.root, request: q, out: p.x.output('termination') });
const refused = (q, expression, reason) => {
  const state = f.ref(p.stateFile), before = fs.readdirSync(p.store);
  assert.throws(expression ?? (() => verify(q)), e => typeof e.code === 'string' && /respec|resume|transition|stale/.test(e.code) && (!reason || reason.test(e.message)), 'typed refusal');
  assert.deepEqual(f.ref(p.stateFile), state); assert.deepEqual(fs.readdirSync(p.store), before);
};
describe('controller termination algorithm: exact-profile/inspector/PS doubles', () => {
  it('retains SIGKILL/unknown producer, consumes the actual16 failed-after, and builds AND verifies a17 handoff', () => {
    const v = p.complete(), out = p.x.output('verified'), before = f.ref(p.stateFile);
    const result = api.verifyControllerTermination({ projectRoot: p.x.root, request: v.request, out });
    assert.ok(profileDoubleCalls > 0, 'algorithm positive is explicitly NOT an applicability positive');
    assert.equal(result.status, 'conclusive-known-lifecycle-termination'); assert.equal(result.effectExecutable, false); assert.equal(result.proofAuthority, 'none');
    assert.equal(result.terminalOutcome, 'controller-terminated'); assert.equal(result.controller.signal, 9);
    assert.deepEqual(result.innerProducer, { startedAtMs: null, endedAtMs: null, exitCode: null, signal: null, error: null, status: 'unknown' });
    assert.match(result.trustScope, /no retrospective full PID lineage/); assert.ok(result.children.allTerminal); assert.equal(result.children.count, p.context.build.children.length);
    assert.equal(auto.readRuntimeState({ projectRoot: p.x.root }).reservations.get(p.action.reservationId).state, 'closed');
    assert.equal(api.consumeControllerTermination({ projectRoot: p.x.root, request: v.request, out }).afterEventSha256, result.afterEventSha256);
    refused(v.request, () => exactApi.consumeControllerTermination({ projectRoot: p.x.root, request: v.request, out }), /unsupported case, step, target or original run/);
    assert.deepEqual(f.ref(p.stateFile), before); assert.deepEqual(fs.readdirSync(p.store), []);
    const beforeRuntime = f.read(p.context.canonicalObservations.file).runtimeBefore;
    const current = p.revisionRequest('finish', { request: p.initial.requestInput, result: p.initial.evidence });
    const finish = api.runRespec({ request: current, out: p.x.output('finish') });
    assert.equal(finish.status, 'partial'); assert.deepEqual(finish.frame, p.initial.frame);
    assert.equal(finish.observation.history.failures[0].failureType, 'controller-termination'); assert.equal(finish.observation.history.effects.length, 0);
    assert.equal(finish.observation.history.failures[0].effectExecutable, false);
    // All mutable historical references retain original path/digest and raw bytes.
    const captures = [...p.historicalCaptures, { schema: 'fvs/auto-bundle-historical-input', schemaVersion: 1,
      original: f.read(p.context.canonicalObservations.file).runtimeCurrent,
      archive: f.write(path.join(p.x.owned, 'bundle-before-archive.json'), fs.readFileSync(beforeRuntime.file)), mode: 0o600 }];
    const handoff = f.json(p.x.owned, 'finish-handoff', { finish, executionClosure: result.evidence }), request = { ...current.current.bundle, handoff,
      historicalCaptures: captures, absenceReasons: { ...current.current.bundle.absenceReasons, handoff: null } };
    const missingArchive = { ...request, historicalCaptures: captures.filter(c => c !== p.oldSourceCapture) };
    assert.throws(() => bundle.buildReviewBundle(missingArchive, p.x.output('missing-old-code')), e => e.code === 'bundle-evidence-invalid');
    const built = bundle.buildReviewBundle(request, p.x.output('bundle'));
    const checked = bundle.verifyReviewBundle({ manifest: built.manifest, expectedContext: bundle.bundleExpectedContext(request), deadlineMs: Date.now() + 120000, out: p.x.output('verify-bundle') });
    assert.equal(checked.integrity.status, 'valid');
    const manifest = f.read(built.manifest.file);
    const old = p.oldSourceCapture;
    assert.deepEqual(manifest.copies.find(row => row.original === old.original.file && row.sha256 === old.original.sha256).historicalCapture, old);
    assert.ok(manifest.copies.some(row => row.original === old.archive.file && row.sha256 === old.archive.sha256));
    for (const ref of [p.context.outer, p.context.marker, p.context.code.controller, v.request.terminationEvidence, result.evidence, finish.evidence, finish.publication]) assert.ok(manifest.copies.some(row => row.original === ref.file && row.sha256 === ref.sha256), 'retained input ' + ref.file);
  });
  const mutations = {
    lifecycle: c => c.lifecycle = 'arbitrary-process', version: c => c.schemaVersion = 3, extra: c => c.unsupported = true,
    wrongRun: c => c.runId = f.uuid(), wrongBefore: c => c.beforeEventSha256 = 'f'.repeat(64), wrongReservation: c => c.reservationId = f.uuid(),
    wrongTransition: c => c.transitionId = f.uuid(), wrongJob: c => c.job = c.prepared,
    code: c => c.code.controller = c.code.wrapper, tool: c => c.tools.lean = c.tools.lake,
    missingInnerOutcome: c => delete c.innerProducer.exitCode, inventedExit: c => c.innerProducer.exitCode = 8,
    inventoryOmission: c => c.sourceSnapshot.files.pop(),
    marker: c => changeRef(c, 'marker', r => r.status = 'closed'),
    notKilled: c => changeRef(c, 'outer', r => r.signal = null), notWaited: c => changeRef(c, 'outer', r => r.exitCode = null),
    outerClock: c => changeRef(c, 'outer', r => r.absoluteDeadlineMs++), cleanFlag: c => changeRef(c, 'outer', r => r.sourceUnchanged = false),
    outerClockType: c => changeRef(c, 'outer', r => r.startedAtMs = String(r.startedAtMs)),
    sourceMismatch: c => changeRef(c, 'outer', r => r.sourceAfter.head = 'f'.repeat(40)), inhibitor: c => changeRef(c, 'outer', r => r.inhibitor.terminated = false),
    wrongLaunch: c => changeRef(c, 'launch', r => r.pid++),
    missingChild: c => c.build.children.splice(2, 1), reorderChild: c => c.build.children.reverse(),
    observerFailed: c => changeRef(c, 'observer', r => r.exitCode = 1), observerSignal: c => changeRef(c, 'observer', r => r.signal = 'SIGKILL'),
    observerError: c => changeRef(c, 'observer', r => r.error = 'ENOBUFS'), observerTruncated: c => changeRef(c, 'observer', r => r.outputLimitExceeded = true),
    observerEmpty: c => changeRef(c, 'observer', r => r.stdout = f.write(path.join(p.x.owned, f.uuid()), '')),
    observerIncomplete: c => changeRef(c, 'observer', r => r.stdout = f.write(path.join(p.x.owned, f.uuid()), '1 0 1 /sbin/launchd\n')),
    observerMalformed: c => changeRef(c, 'observer', r => r.stdout = f.write(path.join(p.x.owned, f.uuid()), 'not a process table\n')),
    observerFuture: c => changeRef(c, 'observer', r => r.endedAtMs = Date.now() + 100000),
    survivor: c => changeRef(c, 'observer', r => r.stdout = f.write(path.join(p.x.owned, f.uuid()), '1 0 1 init\n' + process.pid + ' 1 2 observer\n1900000000 1 1900000000 node\n')),
    detached: c => changeRef(c, 'observer', r => r.stdout = f.write(path.join(p.x.owned, f.uuid()), '1 0 1 init\n' + process.pid + ' 1 2 observer\n99999 1 99999 node ' + c.caseRoot + '/unknown-work\n')),
    canonicalIncomplete: c => changeRef(c, 'canonicalObservations', r => delete r.snapshotAfter), canonicalChanged: c => changeRef(c, 'canonicalObservations', r => r.snapshotAfter.source.commit = 'f'.repeat(40)),
    wrongClock: c => changeRef(c, 'canonicalObservations', r => r.originalRunDeadlineMs++),
    missingCanonicalClock: c => changeRef(c, 'canonicalObservations', r => delete r.startedAtMs),
  };
  for (const [name, change] of Object.entries(mutations)) it('refuses ' + name + ' without canonical writes', () => { const v = p.complete(change); refused(v.request); });
  it('the unmocked public verifier rejects this generic node19/other-case fixture', () => {
    const v = p.complete(); refused(v.request, () => exactApi.verifyControllerTermination({ projectRoot: p.x.root, request: v.request, out: p.x.output('unsupported-profile') }), /unsupported case, step, target or original run/);
  });
  it('requires independently held expectations and current actual failed-after bytes/head', () => {
    const v = p.complete();
    for (const change of [q => q.expectedContext.step += '-other', q => q.expectedAction = p.context.job, q => q.expectedBeforeEventSha256 = 'f'.repeat(64), q => q.committedHeadSha256 = 'f'.repeat(64), q => q.attemptId = 'not-a-uuid']) {
      const q = structuredClone(v.request); change(q); refused(q);
    }
    const bytes = fs.readFileSync(v.request.afterResult.file); fs.writeFileSync(v.request.afterResult.file, bytes.toString() + '\n'); refused(v.request); fs.writeFileSync(v.request.afterResult.file, bytes);
  });
  it('refuses live observer failure, empty/incomplete output and detached work, retaining failure output', () => {
    const v = p.complete();
    for (const change of [r => r.status = 1, r => r.error = { code: 'ENOBUFS' }, r => r.stdout = Buffer.alloc(0), r => r.stdout = Buffer.from('1 0 1 init\n'),
      r => r.stdout = Buffer.from('1 0 1 init\n' + process.pid + ' 1 2 observer\n99999 1 99999 node ' + p.context.caseRoot + '/unknown\n')]) {
      processPatch = change; try { refused(v.request); } finally { processPatch = null; }
    }
  });
  for (const [name, edit] of Object.entries({ nonterminal: r => r.exit = null, killed: r => r.signal = 'SIGKILL', timeout: r => r.timedOut = true,
    drift: r => r.inputsAfter = 'f'.repeat(64), overlap: r => r.startedAt = 0, unknownLastCall: r => r.argv.push('unsupported'), output: r => r.outputLimitExceeded = true })) {
    it('rejects exact child ' + name + ' at the lifecycle boundary', () => {
      const original = p.context.build.children.at(-1), bytes = fs.readFileSync(original.file), body = JSON.parse(bytes); edit(body);
      const archive = f.json(p.x.owned, 'retained-mutant-child-' + name, body);
      fs.writeFileSync(original.file, fs.readFileSync(archive.file));
      f.json(p.x.owned, 'retained-mutant-identity-' + name, { original: f.ref(original.file), archive });
      try {
        const v = p.complete(c => c.build.children[c.build.children.length - 1] = f.ref(original.file));
        refused(v.request, undefined, /child|subprocess|concurrent|detached/);
      } finally { fs.writeFileSync(original.file, bytes); }
    });
  }
  it('refuses unreceipted or advanced work rather than inferring absence from a missing append', () => {
    for (const relative of ['receipts/9999.stdout', 'receipts/result.json', '../kernel-request.json']) {
      const file = path.resolve(p.context.build.root, relative), archived = f.write(file, 'protocol unsupported publication');
      try { const v = p.complete(); refused(v.request); } finally { fs.renameSync(file, file + '.retained-' + archived.sha256); }
    }
  });
  it('rejects coordinated listing/source/child omission against the original bound Git tree', () => {
    const refs = p.context.build.children, originals = refs.flatMap(ref => [ref.file, ref.file.replace(/json$/, 'stdout'), ref.file.replace(/json$/, 'stderr')]);
    const saved = new Map(originals.map(file => [file, fs.readFileSync(file)]));
    const dir = path.dirname(refs[0].file), archiveDir = path.join(p.x.owned, 'coordinated-omission-originals'); fs.mkdirSync(archiveDir);
    for (const [file, bytes] of saved) { f.write(path.join(archiveDir, path.basename(file)), bytes); fs.renameSync(file, file + '.retained-original'); }
    const rows = refs.map(ref => JSON.parse(saved.get(ref.file))), source = f.read(p.context.build.source.file);
    const listing = saved.get(rows[4].stdout.file).toString().split('\0').filter(Boolean), removed = listing.find(line => line.endsWith('\tDefs.lean'));
    const oid = removed.split(' ')[2].split('\t')[0]; delete source.files['Defs.lean'];
    rows[4].stdout = f.write(path.join(p.x.owned, 'incomplete-listing.stdout'), listing.filter(line => line !== removed).join('\0') + '\0');
    const reduced = rows.filter(row => !(row.argv[1] === 'cat-file' && row.argv[2] === 'blob' && row.argv[3] === oid)), newRefs = [];
    for (const [i, row] of reduced.entries()) {
      const id = String(i + 1).padStart(4, '0');
      for (const kind of ['stdout', 'stderr']) row[kind] = f.write(path.join(dir, id + '.' + kind), row === rows[4] && kind === 'stdout' ? fs.readFileSync(row[kind].file) : saved.get(row[kind].file));
      newRefs.push(f.write(path.join(dir, id + '.json'), row));
    }
    const sourceBytes = fs.readFileSync(p.context.build.source.file), mutantArchive = f.json(p.x.owned, 'incomplete-source-inventory', source);
    fs.writeFileSync(p.context.build.source.file, fs.readFileSync(mutantArchive.file));
    try {
      const v = p.complete(c => { c.build.children = newRefs; c.build.source = f.ref(p.context.build.source.file); });
      refused(v.request, undefined, /bound tree inventory/);
    } finally {
      fs.writeFileSync(p.context.build.source.file, sourceBytes);
      for (const ref of newRefs) for (const file of [ref.file, ref.file.replace(/json$/, 'stdout'), ref.file.replace(/json$/, 'stderr')]) fs.renameSync(file, file + '.retained-mutant');
      for (const [file, bytes] of saved) f.write(file, bytes);
    }
  });
  it('refuses pending canonical publication and protected output paths without writing canonical state', () => {
    const v = p.complete();
    refused(v.request, () => api.verifyControllerTermination({ projectRoot: p.x.root, request: v.request, out: path.join(p.store, 'closure') }));
    assert.equal(fs.existsSync(path.join(p.store, 'closure')), false);
    const lock = path.join(p.store, 'lock'); fs.mkdirSync(lock);
    try { refused(v.request); } finally { fs.renameSync(lock, path.join(p.x.owned, 'retained-store-lock-' + f.uuid())); }
  });
  it('rejects another attempt, coherently changed certificate and expired publication without accepting anything', () => {
    const v = p.complete(), out = p.x.output('consumer-replay'); api.verifyControllerTermination({ projectRoot: p.x.root, request: v.request, out });
    refused(v.request, () => api.consumeControllerTermination({ projectRoot: p.x.root, request: { ...v.request, attemptId: f.uuid() }, out }));
    const file = path.join(out, 'result.json'), original = fs.readFileSync(file), changed = JSON.parse(original); changed.innerProducer.exitCode = 8;
    fs.writeFileSync(file, JSON.stringify(changed));
    try { refused(v.request, () => api.consumeControllerTermination({ projectRoot: p.x.root, request: v.request, out })); }
    finally { fs.writeFileSync(file, original); }
    const lateOut = p.x.output('publication-deadline'), open = fs.openSync, sync = fs.fsyncSync; let fd;
    fs.openSync = function(file, ...args) { const result = open.call(fs, file, ...args); if (file === path.join(lateOut, 'result.json')) fd = result; return result; };
    fs.fsyncSync = function(n) { const result = sync.call(fs, n); if (n === fd) clock.advance(v.request.deadlineMs + 1); return result; };
    try { refused(v.request, () => api.verifyControllerTermination({ projectRoot: p.x.root, request: v.request, out: lateOut })); }
    finally { fs.openSync = open; fs.fsyncSync = sync; }
    assert.ok(fs.existsSync(path.join(lateOut, 'failure.json')));
    refused(v.request, () => api.consumeControllerTermination({ projectRoot: p.x.root, request: v.request, out: lateOut }));
  });
  it('rechecks exact lifecycle and tool bytes after the slow consumer reads', () => {
    const v = p.complete(), file = p.context.tools.lean.file, original = fs.readFileSync(file); let calls = 0;
    processPatch = () => { if (++calls === 2) fs.writeFileSync(file, 'changed owned protocol tool'); };
    try { refused(v.request, undefined, /executable hash changed/); }
    finally { f.write(path.join(p.x.owned, 'retained-late-tool-mutant'), fs.readFileSync(file)); fs.writeFileSync(file, original); processPatch = null; }
  });
  it('keeps the32MiB metadata/source bound separate from larger streamed tools', async () => {
    const file = path.join(p.x.owned, 'oversized-before-request.json'), fd = fs.openSync(file, 'wx', 0o600);
    fs.ftruncateSync(fd, 33554433); fs.closeSync(fd);
    const hash = require('node:crypto').createHash('sha256');
    for await (const chunk of fs.createReadStream(file, { highWaterMark: 65536 })) hash.update(chunk);
    const ref = { file, sha256: hash.digest('hex') }, v = p.complete(c => c.beforeRequest = ref);
    refused(v.request, undefined, /bounded regular input unavailable/);
  });
  it('does not let a late process read hide canonical drift or an exhausted deadline', () => {
    const rollback = p.complete(), now = Date.now;
    Date.now = () => now() - 60000;
    try { refused(rollback.request, undefined, /backwards/); } finally { Date.now = now; }
    for (const kind of ['deadline', 'drift']) {
      const v = p.complete(); let calls = 0;
      processPatch = () => { if (++calls !== 2) return; if (kind === 'deadline') clock.advance(v.request.deadlineMs + 1);
        else f.git(p.x.root, 'commit', '--allow-empty', '-qm', 'test(fixture): expose final consumer source drift'); };
      try { refused(v.request); } finally { processPatch = null; }
      if (kind === 'drift') break; // This owned fixture is now deliberately stale; no reset.
    }
  });
});
