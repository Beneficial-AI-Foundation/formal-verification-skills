const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const f = require('./helpers/bundle-fixture.cjs');
const resumeFixture = require('./helpers/resume-fixture.cjs');
let api, auto; const owned = [];
before(async () => { api = await import('../scripts/fvs-auto-bundle.mjs'); auto = await import('../scripts/fvs-auto.mjs'); });
after(() => { if (!process.env.FVS_BUNDLE_QUAL_OUT) for (const dir of owned) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() { const x = f.fixture(auto, process.env.FVS_BUNDLE_QUAL_OUT ?? undefined); owned.push(x.owned); return x; }
const read = file => JSON.parse(fs.readFileSync(file));
const reject = (code, fn) => assert.throws(fn, e => e.code === code, code);
function build(x, q = x.request()) { const out = x.out('bundle'), result = api.buildReviewBundle(q, out); return { q, out, result, manifest: read(result.manifest.file) }; }
function verify(x, b, context = api.bundleExpectedContext(b.q)) { return api.verifyReviewBundle({ manifest: b.result.manifest, expectedContext: context, deadlineMs: Date.now() + 120000, out: x.out('verify') }); }
function editManifest(b, mutate) { const m = read(b.result.manifest.file); mutate(m); fs.writeFileSync(b.result.manifest.file, JSON.stringify(m)); b.result.manifest = f.ref(b.result.manifest.file); }
function editViews(b, m, changeCard = v => v) {
  const file = path.join(b.out, 'contract.lean'), lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  fs.writeFileSync(file, lines.map((line, i) => i < 2 ? line : '-- ' + JSON.stringify(changeCard(JSON.parse(line.slice(3))))).join('\n') + '\n');
  m.views.contract.sha256 = f.ref(file).sha256;
}

describe('read-only review bundle coverage and integrity', () => {
  it('publishes all requested roots and shared helper without inventing proof or human approval', () => {
    const x = fixture(), b = build(x), v = verify(x, b);
    assert.equal(b.result.status, 'review-bundle-written'); assert.equal(v.integrity.status, 'valid'); assert.equal(v.currentness.status, 'unverified');
    assert.deepEqual(b.manifest.facts.requestedRoots, [20, 21]); assert.deepEqual(b.manifest.facts.union, [19, 20, 21]);
    assert.deepEqual(b.manifest.facts.nodes.map(n => n.node), [19, 20, 21]); assert.equal(b.manifest.facts.proofCoverage, 'partial-at-capture');
    assert.equal(b.manifest.humanReview, 'pending'); assert.match(fs.readFileSync(path.join(b.out, 'contract.lean'), 'utf8'), /^-- FVS review bundle/);
    assert.ok(b.manifest.facts.nodes.every(n => n.proofAtCapture !== 'current-accepted-at-capture'));
  });
  it('retains inadmissible requested/failed IDs and null closure as unknown', () => {
    const x = fixture(); x.planData.status = 'blocked'; x.planData.admissibility = { status: 'blocked', blockers: ['fixture incompatibility'] };
    x.planData.selection.failed = [19]; x.planData.nodes = {}; x.planData.roots.forEach(r => { r.closure = null; r.status = 'blocked'; });
    const b = build(x); assert.equal(b.manifest.facts.union, null); assert.deepEqual(b.manifest.facts.requestedRoots, [20, 21]);
    assert.deepEqual(b.manifest.facts.failed, [19]); assert.deepEqual(b.manifest.facts.nodes.map(n => n.node), [19, 20, 21]);
    assert.ok(b.manifest.facts.nodes.every(n => n.closure === null && n.owner === null && n.dependencies === null));
    assert.equal(verify(x, b).integrity.status, 'valid');
  });
  it('retains malformed raw node/root entries as diagnostics without inventing validated owners', () => {
    const x = fixture(); x.planData.nodes[19] = { note: 'unusable declared node, preserved' }; x.planData.roots.push(null);
    const b = build(x); assert.equal(b.manifest.facts.union, null); assert.equal(b.manifest.facts.declaredPlan.nodes[19].note, 'unusable declared node, preserved');
    assert.ok(b.manifest.facts.declaredPlan.roots.includes(null)); assert.deepEqual(b.manifest.facts.requestedRoots, [20, 21]);
    assert.ok(b.manifest.facts.nodes.every(n => n.owner === null && n.dependencies === null));
  });
  for (const defect of ['absent inventory', 'conflicting roots', 'omitted applicability', 'omitted root']) it('refuses ' + defect, () => {
    const x = fixture(), q = x.request();
    if (defect === 'absent inventory') q.scopeInventory = null;
    else { const inv = read(q.scopeInventory.file); if (defect === 'conflicting roots') inv.requestedRoots = [20]; if (defect === 'omitted applicability') inv.applicability = null; if (defect === 'omitted root') inv.applicability[0].roots = [20]; q.scopeInventory = f.write(x.owned, 'bad-scope', inv); }
    const out = x.out('invalid'); assert.throws(() => api.buildReviewBundle(q, out)); assert.equal(fs.existsSync(path.join(out, 'manifest.json')), false);
  });
  it('keeps captured integrity valid after a real HEAD change, with stale fresh currentness', () => {
    const x = fixture(), b = build(x), before = fs.readFileSync(b.result.manifest.file);
    f.git(x.root, 'commit', '--allow-empty', '-qm', 'test(fixture): advance live source identity');
    const v = verify(x, b); assert.equal(v.integrity.status, 'valid'); assert.equal(v.currentness.status, 'stale');
    assert.deepEqual(fs.readFileSync(b.result.manifest.file), before);
  });
  it('unavailable original project paths do not corrupt retained snapshot integrity', () => {
    const x = fixture(), b = build(x), expected = api.bundleExpectedContext(b.q); fs.renameSync(x.root, path.join(x.owned, 'moved-project'));
    const v = verify(x, b, expected); assert.equal(v.integrity.status, 'valid'); assert.equal(v.currentness.status, 'unverified'); assert.equal(v.currentness.reason, 'original-only-material-unavailable');
  });
  it('keeps captured integrity valid after a real registry pending marker', () => {
    const x = fixture(), b = build(x); fs.mkdirSync(path.join(x.registry, 'lock')); const v = verify(x, b);
    assert.equal(v.integrity.status, 'valid'); assert.equal(v.currentness.status, 'pending'); assert.ok(fs.existsSync(path.join(x.registry, 'lock')));
  });
  it('keeps captured integrity valid but detects a real registry append without a pending marker', async () => {
    const x = fixture(), b = build(x); await x.register(b.q);
    const v = verify(x, b); assert.equal(v.integrity.status, 'valid'); assert.equal(v.currentness.status, 'stale'); assert.equal(v.currentness.reason, 'registry-head-changed');
  });
  it('requires the consumer own context; saved ready-looking content is not authority', () => {
    const x = fixture(), b = build(x), context = api.bundleExpectedContext(b.q); context.agreement.contextSha256 = 'a'.repeat(64);
    const v = verify(x, b, context); assert.equal(v.integrity.status, 'valid'); assert.equal(v.currentness.status, 'stale'); assert.equal(v.humanReview, 'pending');
  });
  for (const kind of ['view', 'copy', 'source']) it('refuses changed ' + kind + ' bytes', () => {
    const x = fixture(), b = build(x);
    const file = kind === 'view' ? path.join(b.out, 'contract.lean') : kind === 'source' ? path.join(b.out, b.manifest.sources[0].view) : path.join(b.out, b.manifest.copies[0].stored);
    fs.appendFileSync(file, 'changed'); assert.throws(() => verify(x, b));
  });
  it('cannot hide a missing required input by removing its copy-index row', () => {
    const x = fixture(), b = build(x); editManifest(b, m => { m.copies = m.copies.filter(r => r.original !== b.q.extraction.file); });
    reject('bundle-integrity-invalid', () => verify(x, b));
  });
  for (const omission of ['head list', 'middle list', 'head copy', 'middle copy']) it('refuses consistently edited registered ' + omission + ' omission', async () => {
    const x = fixture(), q = x.request(); await x.register(q); const r = await x.register(q, 20); q.registry.expectedHeadSha256 = r.recordSha256;
    const b = build(x, q), before = fs.readFileSync(q.agreement.state.file), out = x.out('omitted-record');
    editManifest(b, m => {
      const target = m.snapshot.registry.records[omission.startsWith('head') ? 1 : 0], node = read(target.file).defId;
      m.snapshot.registry.records = m.snapshot.registry.records.filter(v => v.file !== target.file);
      m.snapshot.registry.sourceVersions = m.snapshot.registry.sourceVersions.filter(v => v.node !== node);
      m.facts.nodes.find(n => n.node === node).registered = null;
      editViews(b, m, v => v.node === node ? { ...v, registered: null, registeredRecord: null } : v);
      if (omission.endsWith('copy')) m.copies = m.copies.filter(v => v.original !== target.file);
    });
    assert.throws(() => api.verifyReviewBundle({ manifest: b.result.manifest, expectedContext: api.bundleExpectedContext(q), deadlineMs: Date.now() + 120000, out }), e => e.code === 'bundle-integrity-invalid' && /committed.*inventory/.test(e.message));
    assert.equal(fs.existsSync(out), false); assert.deepEqual(fs.readFileSync(q.agreement.state.file), before);
  });
  it('cannot erase a source view by consistently editing both indexes/facts/recall', () => {
    const x = fixture(), b = build(x);
    editManifest(b, m => {
      const target = m.sources[0]; m.sources = m.sources.slice(1); m.snapshot.sourceViews = m.sources; m.facts.sourceViews = m.sources;
      const file = path.join(b.out, 'recall.md'); fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').filter(line => !line.includes('](' + target.view + ')')).join('\n')); m.views.recall.sha256 = f.ref(file).sha256;
    });
    assert.throws(() => verify(x, b), e => e.code === 'bundle-integrity-invalid' && /source-view inventory/.test(e.message));
  });
  it('cannot substitute request heads while keeping the original captured context', async () => {
    const x = fixture(), q = x.request(), r = await x.register(q); q.registry.expectedHeadSha256 = r.recordSha256; const b = build(x, q);
    editManifest(b, m => { m.snapshot.request.registry.expectedHeadSha256 = null; });
    assert.throws(() => verify(x, b), e => e.code === 'bundle-integrity-invalid' && /request differs/.test(e.message));
  });
  it('a changed captured assumption remains integrity-invalid even if the view bytes are not changed', async () => {
    const x = fixture(), q = x.request(), r = await x.register(q); q.registry.expectedHeadSha256 = r.recordSha256; const b = build(x, q);
    const row = b.manifest.copies.find(row => row.original.includes('/records/'));
    const file = path.join(b.out, row.stored), record = read(file); record.contract.assumptions = ['tampered']; fs.writeFileSync(file, JSON.stringify(record));
    reject('bundle-integrity-invalid', () => verify(x, b));
  });
  it('does not recompute immutable cards from changed live definition bytes', () => {
    const x = fixture(), b = build(x), old = fs.readFileSync(path.join(b.out, 'recall.md'));
    fs.appendFileSync(path.join(x.root, 'Defs.lean'), '\ndef Later := Int\n');
    const v = verify(x, b); assert.equal(v.integrity.status, 'valid'); assert.equal(v.currentness.status, 'stale'); assert.deepEqual(fs.readFileSync(path.join(b.out, 'recall.md')), old);
  });
  it('refuses output collisions, protected trees and input symlink aliases', () => {
    const x = fixture(), q = x.request(), out = x.out('existing'); fs.mkdirSync(out); reject('bundle-output-collision', () => api.buildReviewBundle(q, out));
    const bad = path.join(x.root, 'must-not-exist'); reject('bundle-output-protected', () => api.buildReviewBundle(q, bad)); assert.equal(fs.existsSync(bad), false);
    const link = path.join(x.owned, 'graph-link.json'); fs.symlinkSync(q.graph.file, link); q.graph = { ...q.graph, file: link };
    assert.throws(() => api.buildReviewBundle(q, x.out('aliased')));
  });
  it('discovers a protected checker-evidence parent before writing output there', () => {
    const x = fixture(), dir = path.join(x.owned, 'producer-evidence'); fs.mkdirSync(dir);
    const q = x.request({ handoff: f.write(dir, 'handoff', { authority: 'metadata-only' }) }); q.absenceReasons.handoff = null;
    const out = path.join(dir, 'must-not-exist'); reject('bundle-output-protected', () => api.buildReviewBundle(q, out)); assert.equal(fs.existsSync(out), false);
  });
  it('protects a retained build dependency directory before creating output', () => {
    const x = fixture(), producer = path.join(x.owned, 'producer'), donor = path.join(x.owned, 'retained-dependencies'); fs.mkdirSync(producer); fs.mkdirSync(donor);
    const handoff = f.write(producer, 'build-request', { schema: 'fvs-checker/build-request', source: { root: x.root }, dependencies: { root: donor }, out: path.join(producer, 'build') });
    const q = x.request({ handoff }); q.absenceReasons.handoff = null; const out = path.join(donor, 'must-not-exist'); reject('bundle-output-protected', () => api.buildReviewBundle(q, out)); assert.equal(fs.existsSync(out), false);
  });
  it('refuses a mixed-version snapshot before final manifest publication', () => {
    const x = fixture(), q = x.request(), out = x.out('drift'), mkdir = fs.mkdirSync;
    fs.mkdirSync = function(file, ...rest) { const result = mkdir.call(fs, file, ...rest); if (file === out) fs.appendFileSync(q.scopeInventory.file, ' '); return result; };
    try { reject('bundle-snapshot-drift', () => api.buildReviewBundle(q, out)); } finally { fs.mkdirSync = mkdir; }
    assert.equal(fs.existsSync(path.join(out, 'manifest.json')), false);
  });
  it('refuses a foreign Git source with an otherwise complete caller tuple', () => {
    const x = fixture(), y = fixture(), q = x.request(); q.source = y.request().source;
    reject('bundle-project-mismatch', () => api.buildReviewBundle(q, x.out('foreign')));
  });
  it('rejects hidden hooks without executing them', () => {
    const x = fixture(), q = x.request(); let calls = 0;
    Object.defineProperty(q, 'toJSON', { value() { calls++; return {}; } }); assert.throws(() => api.buildReviewBundle(q, x.out('hook'))); assert.equal(calls, 0);
  });
  it('the CLI rejects duplicate JSON before producing output', () => {
    const x = fixture(), file = path.join(x.owned, 'duplicate.json'); fs.writeFileSync(file, '{"schema":1,"schema":2}');
    const p = spawnSync(process.execPath, [path.join(f.ROOT, 'scripts/fvs-auto-bundle.mjs'), 'build', '--request', file, '--out', x.out('duplicate')], { encoding: 'utf8' });
    assert.equal(p.status, 7); assert.match(p.stdout, /duplicate keys/);
  });
  it('CLI build and fresh verify retain separate integrity/currentness results', () => {
    const x = fixture(), q = x.request(), input = f.write(x.owned, 'cli-input', q), out = x.out('cli-bundle'), script = path.join(f.ROOT, 'scripts/fvs-auto-bundle.mjs');
    const p = spawnSync(process.execPath, [script, 'build', '--request', input.file, '--out', out], { encoding: 'utf8' }); assert.equal(p.status, 0, p.stdout + p.stderr);
    const result = JSON.parse(p.stdout), inspection = f.write(x.owned, 'cli-verify', { manifest: result.manifest, expectedContext: api.bundleExpectedContext(q), deadlineMs: Date.now() + 120000 });
    const v = spawnSync(process.execPath, [script, 'verify', '--request', inspection.file, '--out', x.out('cli-verification')], { encoding: 'utf8' }); assert.equal(v.status, 0, v.stdout + v.stderr);
    const checked = JSON.parse(v.stdout); assert.equal(checked.integrity.status, 'valid'); assert.equal(checked.currentness.status, 'unverified'); assert.equal(checked.humanReview, 'pending');
  });
  it('worker and standalone handoff verdicts cannot manufacture acceptance', () => {
    const x = fixture(), evidence = path.join(x.owned, 'worker-input'); fs.mkdirSync(evidence);
    const q = x.request({ handoff: f.write(evidence, 'worker-verdict', { status: 'VERIFIED', authority: 'worker', accepted: [19, 20, 21] }) }); q.absenceReasons.handoff = null;
    const b = build(x, q); assert.ok(b.manifest.facts.nodes.every(n => n.proofAtCapture === 'unknown')); assert.equal(b.manifest.facts.proofCoverage, 'partial-at-capture');
    q.baseline = q.handoff; q.absenceReasons.baseline = null; reject('bundle-evidence-invalid', () => build(x, q));
  });
  it('structured imports/checker metadata is not mistaken for a frozen digest map', () => {
    const x = fixture(), dir = path.join(x.owned, 'producer'); fs.mkdirSync(dir);
    const handoff = f.write(dir, 'structured', { imports: { modules: [{ name: 'Fixture', parts: [] }] }, checker: { schema: 'fixture-tool-observation' } });
    const q = x.request({ handoff }); q.absenceReasons.handoff = null; const b = build(x, q); assert.equal(verify(x, b).integrity.status, 'valid');
  });
  it('compiled import parts are indexed while structured import metadata stays copied', () => {
    const x = fixture(), dir = path.join(x.owned, 'producer'); fs.mkdirSync(dir); const body = path.join(dir, 'Fixture.olean.private'); fs.writeFileSync(body, 'owned compiled-part fixture');
    const handoff = f.write(dir, 'imports', { attempt: { imports: [{ module: 'Fixture', parts: [f.ref(body)] }] } }), q = x.request({ handoff }); q.absenceReasons.handoff = null;
    const b = build(x, q); assert.ok(b.manifest.indexOnly.some(r => r.original === body)); assert.ok(b.manifest.copies.some(r => r.original === handoff.file)); assert.equal(verify(x, b).integrity.status, 'valid');
  });
  for (const omission of [null, 'request bytes', 'request row', 'compiled row', 'sealed row', 'runtime row']) it('kernel input closure ' + (omission ?? 'copies extensionless metadata and indexes bodies'), () => {
    const x = fixture(), k = f.kernelFixture(x), q = x.request({ handoff: k.attempt }); q.absenceReasons.handoff = null;
    const b = build(x, q), copied = r => b.manifest.copies.find(v => v.original === r.file), indexed = r => b.manifest.indexOnly.some(v => v.original === r.file && v.sha256 === r.sha256);
    assert.ok(copied(k.request)); assert.ok(copied(k.context)); for (const r of [k.compiled, k.copied, k.runtime, k.lean, k.node]) assert.ok(indexed(r));
    if (!omission) { fs.unlinkSync(k.compiled.file); const v = verify(x, b); assert.equal(v.integrity.status, 'valid'); assert.equal(v.availability.status, 'unavailable'); assert.notEqual(v.currentness.status, 'current'); return; }
    if (omission === 'request bytes') fs.unlinkSync(path.join(b.out, copied(k.request).stored));
    else editManifest(b, m => {
      if (omission === 'request row') m.copies = m.copies.filter(v => v.original !== k.request.file);
      else { const r = omission === 'compiled row' ? k.compiled : omission === 'sealed row' ? k.copied : k.runtime; m.indexOnly = m.indexOnly.filter(v => v.original !== r.file); }
    });
    const out = x.out('omitted-kernel'); assert.throws(() => api.verifyReviewBundle({ manifest: b.result.manifest, expectedContext: api.bundleExpectedContext(q), deadlineMs: Date.now() + 120000, out })); assert.equal(fs.existsSync(out), false);
  });
  it('refuses an unsupported reordered kernel input layout before publication', () => {
    const x = fixture(), k = f.kernelFixture(x), attempt = read(k.attempt.file); attempt.inputs = Object.fromEntries(Object.entries(attempt.inputs).reverse());
    const q = x.request({ handoff: f.write(path.dirname(k.attempt.file), 'reordered', attempt) }); q.absenceReasons.handoff = null; const out = x.out('reordered-inputs');
    assert.throws(() => api.buildReviewBundle(q, out), e => e.code === 'bundle-evidence-invalid' && /kernel input layout/.test(e.message)); assert.equal(fs.existsSync(out), false);
  });
  it('missing original-only indexed material preserves integrity but never current acceptance', () => {
    const x = fixture(), dir = path.join(x.owned, 'producer'); fs.mkdirSync(dir); const body = path.join(dir, 'fixture.ir'); fs.writeFileSync(body, 'owned indexed fixture body');
    const handoff = f.write(dir, 'indexed-body', { authority: 'no-proof', tool: f.ref(body) }), q = x.request({ handoff }); q.absenceReasons.handoff = null;
    const b = build(x, q), old = fs.readFileSync(b.result.manifest.file); fs.unlinkSync(body);
    const v = verify(x, b); assert.equal(v.integrity.status, 'valid'); assert.equal(v.availability.status, 'unavailable'); assert.notEqual(v.currentness.status, 'current'); assert.deepEqual(fs.readFileSync(b.result.manifest.file), old);
  });
  it('untrusted statement text stays in single-line comment views', async () => {
    const x = fixture(), q = x.request(), statement = 'True\n-/\n#eval panic! "injected"\u2028next';
    const r = await x.register(q, 19, { statement }); q.registry.expectedHeadSha256 = r.recordSha256; const b = build(x, q);
    const content = fs.readFileSync(path.join(b.out, 'contract.lean'), 'utf8'); assert.ok(content.trimEnd().split('\n').every(line => line.startsWith('-- '))); assert.ok(content.includes('\\u2028'));
    assert.equal(verify(x, b).integrity.status, 'valid');
  });
  it('an ABA choices generation cannot be substituted by the same scope text', () => {
    const x = fixture(), b = build(x), context = api.bundleExpectedContext(b.q); context.agreement.choicesGeneration += 2;
    const v = verify(x, b, context); assert.equal(v.integrity.status, 'valid'); assert.equal(v.currentness.status, 'stale');
  });
  it('deadline exhaustion neither publishes nor mutates source', () => {
    const x = fixture(), q = x.request(), before = fs.readFileSync(f.stateFile(x.root)); q.deadlineMs = Date.now() - 1;
    const out = x.out('expired'); reject('bundle-deadline-exhausted', () => api.buildReviewBundle(q, out)); assert.equal(fs.existsSync(out), false); assert.deepEqual(fs.readFileSync(f.stateFile(x.root)), before);
  });
});

describe('pending committed snapshots keep weaker validation', () => {
  it('reads actual14 committed history under a lock without making it current', async () => {
    const x = fixture(), q = x.request(); const r = await x.register(q); q.registry.expectedHeadSha256 = r.recordSha256;
    fs.mkdirSync(path.join(x.registry, 'lock')); const b = build(x, q);
    assert.equal(b.manifest.snapshot.registry.validation, 'committed-history-validated'); assert.equal(b.manifest.snapshot.registry.status, 'pending');
    assert.equal(b.manifest.snapshot.registry.effectiveNodes, null); assert.equal(b.manifest.facts.nodes.find(n => n.node === 19).registered.contract.statement, 'm1demo.helper = m1demo.helper');
    assert.equal(verify(x, b).currentness.status, 'pending'); assert.ok(fs.existsSync(path.join(x.registry, 'lock')));
  });
  it('an extensionless review record remains required copied evidence', async () => {
    const x = fixture(); x.reviewEvidenceSuffix = ''; const q = x.request(), r = await x.register(q); q.registry.expectedHeadSha256 = r.recordSha256;
    const b = build(x, q), review = r.record.review.evidence;
    const copied = b.manifest.copies.find(row => row.original === review.file); assert.ok(copied); assert.equal(copied.policy, 'required-copy');
    assert.ok(!b.manifest.indexOnly.some(row => row.original === review.file)); fs.unlinkSync(path.join(b.out, copied.stored));
    assert.throws(() => verify(x, b));
  });
  it('temporary14 state retains raw records and every root without a validated snapshot', async () => {
    const x = fixture(), q = x.request(); const r = await x.register(q); q.registry.expectedHeadSha256 = r.recordSha256;
    fs.mkdirSync(path.join(x.registry, '.tmp-owned')); const b = build(x, q);
    assert.equal(b.manifest.snapshot.registry.validation, 'raw-captured-unvalidated'); assert.equal(b.manifest.snapshot.registry.effectiveNodes, null);
    assert.deepEqual(b.manifest.facts.requestedRoots, [20, 21]); assert.equal(b.manifest.facts.nodes[0].registered.validation, 'raw-captured-unvalidated');
    assert.equal(verify(x, b).integrity.status, 'valid');
  });
  it('a pending raw accepted inventory cannot omit its requested head', () => {
    const x = fixture(), store = path.join(x.owned, 'raw-store'); fs.mkdirSync(store); fs.mkdirSync(path.join(store, 'records')); fs.mkdirSync(path.join(store, '.tmp-owned'));
    const bytes = JSON.stringify({ schema: 'fvs-checker/accepted-event', version: 1, seq: 0, prev: null, authority: 'protocol-only, deliberately not validated' }), digest = f.sha(bytes);
    fs.writeFileSync(path.join(store, 'records', '000000-' + digest + '.json'), bytes);
    const q = x.request({ acceptedStore: { root: store, expectedHeadSha256: digest } }); q.absenceReasons.acceptedStore = null;
    const b = build(x, q); assert.equal(verify(x, b).integrity.status, 'valid'); assert.equal(b.manifest.snapshot.accepted.validation, 'raw-captured-unvalidated');
    editManifest(b, m => { m.snapshot.accepted.rawRecords = []; });
    assert.throws(() => verify(x, b), e => e.code === 'bundle-integrity-invalid' && /record inventory/.test(e.message));
  });
  it('corrupt committed bytes cannot be hidden by a pending marker', async () => {
    const x = fixture(), q = x.request(); const r = await x.register(q); q.registry.expectedHeadSha256 = r.recordSha256;
    const file = path.join(x.registry, 'records', fs.readdirSync(path.join(x.registry, 'records'))[0]); fs.appendFileSync(file, 'bad'); fs.mkdirSync(path.join(x.registry, 'lock'));
    reject('bundle-evidence-invalid', () => build(x, q));
  });
  it('an uncreated pending runtime keeps spending and reservations unknown', () => {
    const x = fixture(), dir = path.join(x.root, '.formalising/auto-fv/resume'); fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(path.join(dir, 'lock'));
    const q = x.request({ runtime: { root: x.root, state: null, absenceReason: 'not-yet-committed' } }); q.absenceReasons.runtime = null;
    const b = build(x, q); assert.equal(b.manifest.snapshot.runtime.status, 'pending'); assert.equal(b.manifest.snapshot.runtime.validatedSnapshot, null); assert.equal(b.manifest.facts.agreedLimits.wallClockHours, 40);
  });
  it('a lock-only empty15 store retains known committed history while remaining pending', () => {
    const x = fixture(), store = path.join(x.owned, 'store'); fs.mkdirSync(store); fs.mkdirSync(path.join(store, 'lock'));
    const q = x.request({ acceptedStore: { root: store, expectedHeadSha256: null } }); q.absenceReasons.acceptedStore = null;
    const b = build(x, q); assert.equal(b.manifest.snapshot.accepted.validation, 'history-chain-and-bound-evidence-validated'); assert.equal(b.manifest.snapshot.currentnessAtCapture.status, 'pending');
    assert.ok(b.manifest.facts.nodes.every(n => n.proofAtCapture === 'not-accepted')); assert.ok(fs.existsSync(path.join(store, 'lock')));
  });
  for (const marker of ['lock', '.tmp-owned']) it('actual16 committed runtime with ' + marker + ' preserves the appropriate level', () => {
    const rx = resumeFixture.fixture(auto); owned.push(rx.owned); rx.invoke();
    const x = f.fixture(auto, rx.owned, rx.root); owned.push(x.owned);
    const file = path.join(x.root, '.formalising/auto-fv/resume/state.json'), before = fs.readFileSync(file), state = read(file);
    fs.mkdirSync(path.join(path.dirname(file), marker)); const q = x.request({ runtime: { root: x.root, state: f.ref(file), absenceReason: null } }); q.absenceReasons.runtime = null;
    const b = build(x, q), r = b.manifest.snapshot.runtime; assert.equal(r.status, 'pending');
    assert.equal(r.validation, marker === 'lock' ? 'committed-history-validated' : 'raw-captured-unvalidated');
    if (marker === 'lock') { assert.deepEqual(r.validatedSnapshot.run, state.run); assert.ok(Array.isArray(r.validatedSnapshot.reservations)); }
    else assert.equal(r.validatedSnapshot, null);
    assert.deepEqual(fs.readFileSync(file), before); assert.ok(fs.existsSync(path.join(path.dirname(file), marker)));
    assert.equal(verify(x, b).currentness.status, 'pending');
  });
  it('malformed committed16 state under a lock refuses publication', () => {
    const x = fixture(), dir = path.join(x.root, '.formalising/auto-fv/resume'); fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(path.join(dir, 'lock'));
    const file = path.join(dir, 'state.json'); fs.writeFileSync(file, '{"schema":"fvs/auto-runtime","schemaVersion":1,"run":{},"history":[]}');
    const q = x.request({ runtime: { root: x.root, state: f.ref(file), absenceReason: null } }); q.absenceReasons.runtime = null;
    reject('bundle-evidence-invalid', () => build(x, q));
  });
});
