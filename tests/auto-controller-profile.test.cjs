// REAL profile predicate, copied retained metadata only. No live-case reads,
// state/program/OS/backend/producer invocation, and no execution-closure claim.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const original = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures/auto-respec-controller/a122-profile.json.gz'))));
let api, memoryHash;
before(async () => { api = await import('../scripts/fvs-auto-respec.mjs'); ({ memoryHash } = await import('../scripts/fvs-project-memory.mjs')); });
const copy = () => structuredClone(original);
const reader = x => ref => {
  const row = x.bodies[ref.file];
  assert.ok(row, 'copied metadata only: ' + ref.file); assert.equal(sha(row.text), ref.sha256, 'literal reference digest');
  return JSON.parse(row.text);
};
// Mutations preserve original logical paths, re-sign their copied bytes and all
// reached refs, then refresh the explicit raw inputs. No incidental stale hash.
function edit(x, file, change) {
  const body = JSON.parse(x.bodies[file].text); change(body); x.bodies[file].text = JSON.stringify(body);
}
function resign(x) {
  for (let n = 0; n < 20; n++) {
    const hashes = Object.fromEntries(Object.entries(x.bodies).map(([file, row]) => [file, sha(row.text)])); let changed = false;
    const walk = v => {
      if (!v || typeof v !== 'object') return false;
      let edited = false;
      if (!Array.isArray(v) && typeof v.file === 'string' && typeof v.sha256 === 'string' && hashes[v.file] && v.sha256 !== hashes[v.file]) { v.sha256 = hashes[v.file]; edited = true; }
      for (const item of Object.values(v)) if (walk(item)) edited = true;
      if (v.request?.schema && typeof v.requestSha256 === 'string') { const digest = memoryHash(v.request); if (v.requestSha256 !== digest) { v.requestSha256 = digest; edited = true; } }
      return edited;
    };
    for (const row of Object.values(x.bodies)) { const value = JSON.parse(row.text); if (walk(value)) { row.text = JSON.stringify(value); changed = true; } }
    if (walk(x.raw)) changed = true;
    if (!changed) break;
    if (n === 19) throw Error('reference resign did not converge');
  }
  const c = x.raw.context, get = reader(x);
  x.raw.action = get(c.action); // action is not separately needed by the predicate reader table
  x.raw.beforeRequest = get(c.beforeRequest); x.raw.beforeResult = get(c.beforeResult); x.raw.prepared = get(c.prepared); x.raw.outer = get(c.outer);
  return x;
}
function refused(x, reason) {
  let reads = 0;
  assert.throws(() => api.assertKnownControllerPreparation(x.raw, ref => { reads++; return reader(x)(ref); }), e => e.code === 'respec-termination-unverified' && reason.test(e.message));
  return reads;
}
describe('exact A122 controller profile correspondence (copied metadata, no closure)', () => {
  it('matches the assessed case/step/node20 and actual durable preparation/before/predecessor', () => {
    const x = copy(); assert.equal(x.raw.context.caseRoot, '/private/tmp/fvs45-ticket18-native-episode-0c4c1ino'); assert.equal(x.raw.action.target.node, 20);
    let reads = 0; assert.equal(api.assertKnownControllerPreparation(x.raw, ref => { reads++; return reader(x)(ref); }), undefined);
    assert.ok(reads >= 10); assert.equal(x.authority.includes('no OS/termination'), true);
  });
  it('keeps an unchanged coherently signed copied input valid', () => {
    const x = resign(copy()); assert.equal(api.assertKnownControllerPreparation(x.raw, reader(x)), undefined);
  });
  for (const [name, change] of Object.entries({ case: x => x.raw.context.caseRoot += '-other', step: x => x.raw.context.step = '122-protocol-accept',
    target: x => x.raw.action.target.node = 19, run: x => x.raw.run.runId = '00000000-0000-4000-8000-000000000000',
    clock: x => x.raw.run.deadlineMs++, cwd: x => x.raw.outer.cwd = '/private/tmp', source: x => x.raw.context.sourceSnapshot.files.pop() })) {
    it('rejects unsupported profile ' + name, () => { const x = copy(); change(x); refused(x, /unsupported/); });
  }
  const preparedMutations = { source: p => p.q.source.commit = 'f'.repeat(40), baseline: p => p.q.inputs.baseline = p.closure,
    store: p => p.q.inputs.acceptedStore.expectedHeadSha256 = 'f'.repeat(64), snapshot: p => p.snapshot.source.tree = 'f'.repeat(40),
    predecessor: p => p.q.expectedHeadSha256 = 'f'.repeat(64), runtime: p => p.runtimeFileSha256 = 'f'.repeat(64),
    ordering: p => p.endedAtMs = p.beganAtMs - 1 };
  for (const [name, change] of Object.entries(preparedMutations)) it('rejects coherently re-signed prepared ' + name + ' disagreement', () => {
    const x = copy(); edit(x, x.raw.context.prepared.file, change); resign(x);
    refused(x, /prepared|predecessor|ordering/);
  });
  it('refuses absent copied controller before envelope without falling back to caller values', () => {
    const x = copy(); delete x.bodies[x.raw.context.controllerBefore.file];
    assert.throws(() => api.assertKnownControllerPreparation(x.raw, reader(x)), /copied metadata only/);
  });
  for (const field of ['q', 'action', 'prepared', 'before']) it('rejects re-signed durable before ' + field, () => {
    const x = copy(); edit(x, x.raw.context.controllerBefore.file, item => {
      if (field === 'q') item.q.attemptId = '00000000-0000-4000-8000-000000000000';
      if (field === 'action') item.action.owner = 'another-owner';
      if (field === 'prepared') item.prepared = item.actionRef;
      if (field === 'before') item.before.out += '-other';
    }); resign(x); refused(x, /before envelope/);
  });
  it('rejects a coherently edited closure as unrelated to the A121 predecessor', () => {
    const x = copy(), p = x.raw.prepared, closure = reader(x)(p.closure);
    edit(x, closure.request.file, q => q.expectedBeforeEventSha256 = 'f'.repeat(64)); resign(x); refused(x, /predecessor\/runtime\/closure/);
  });
  it('rejects a re-signed case context pointing at another integration', () => {
    const x = copy(); edit(x, x.raw.context.caseContext.file, c => c.integration += '-other'); resign(x); refused(x, /case context/);
  });
  it('rejects a re-signed candidate-check origin that supplies another result', () => {
    const x = copy(); edit(x, x.raw.context.candidateCheckOrigin.file, c => c.result = x.raw.context.job); resign(x); refused(x, /exact prepared acceptance/);
  });
  for (const field of ['reservation', 'implementation', 'version']) it('rejects re-signed old closure ' + field, () => {
    const x = copy(); edit(x, x.raw.prepared.closureConsumed.file, value => {
      if (field === 'reservation') value.reservationId = '00000000-0000-4000-8000-000000000000';
      else if (field === 'implementation') value.implementation.respec.sha256 = 'f'.repeat(64);
      else value.schemaVersion = 99;
    }); resign(x); refused(x, /predecessor\/runtime\/closure/);
  });
});
