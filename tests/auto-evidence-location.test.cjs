'use strict';
// Consumer verification evidence lives beside the output it verifies (durable, caller-owned), never in anonymous
// system-temporary directories that nothing reclaims. Protocol fixture: AO/Beads doubles; no proof evidence.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const rf = require('./helpers/resume-fixture.cjs');
const owned = [];
after(() => { for (const p of owned) fs.rmSync(p, { recursive: true, force: true }); });
const auto = () => import(pathToFileURL(path.resolve(__dirname, '../scripts/fvs-auto.mjs')).href);
const tmp = fs.realpathSync(os.tmpdir());
const inside = (dir, file) => (file + path.sep).startsWith(dir + path.sep) && file !== dir;
const bound = r => crypto.createHash('sha256').update(fs.readFileSync(r.file)).digest('hex') === r.sha256;

async function reconciled() {
  const a = await auto(), x = rf.fixture(a, undefined, null, { schemaVersion: 2, memory: 'beads' }); owned.push(x.owned);
  const { q, out, result } = x.invoke();
  assert.equal(result.code, 'reconciled');
  return { a, x, q, out: fs.realpathSync(out) };
}

test('resume and memory consumers keep their verification evidence beside the verified outputs', async () => {
  const { a, x, q, out } = await reconciled();
  const v = a.verifyReconciliation({ projectRoot: x.root, request: q, out });
  assert.ok(inside(out, v.verificationEvidence), 'resume verification evidence is under the verified result output');
  assert.equal(inside(tmp, v.verificationEvidence) && !inside(out, v.verificationEvidence), false);
  assert.ok(v.observation.receipts.length && v.observation.receipts.every(r => inside(v.verificationEvidence, r.file) && bound(r)), 'every re-observation receipt is retained and bound');
  const memoryOut = fs.realpathSync(v.observation.memory.out), consumed = fs.readdirSync(memoryOut).filter(n => n.startsWith('fvs-memory-consume-'));
  assert.ok(consumed.length >= 1, 'the memory consumer Git observation is retained inside the bootstrap output it verifies');
  assert.ok(consumed.every(n => fs.readdirSync(path.join(memoryOut, n, 'receipts')).length > 0));
});

test('repeated verification of one result retains each call evidence; earlier references stay valid', async () => {
  const { a, x, q, out } = await reconciled();
  const first = a.verifyReconciliation({ projectRoot: x.root, request: q, out });
  const second = a.verifyReconciliation({ projectRoot: x.root, request: q, out });
  assert.notEqual(first.verificationEvidence, second.verificationEvidence);
  for (const v of [first, second]) assert.ok(v.observation.receipts.every(r => fs.existsSync(r.file) && bound(r)), 'delayed consumers can re-read the bound receipts');
});

test('a refused verification keeps its diagnostic evidence under the caller output', async () => {
  const { a, x, q, out } = await reconciled();
  fs.writeFileSync(path.join(x.root, 'untracked-' + crypto.randomUUID()), 'changes the observed source\n');
  const before = new Set(fs.readdirSync(out));
  assert.throws(() => a.verifyReconciliation({ projectRoot: x.root, request: q, out }), { code: 'resume-context-stale' });
  const added = fs.readdirSync(out).filter(n => !before.has(n));
  assert.deepEqual(added.map(n => n.replace(/-[^-]+$/, '')), ['verify'], 'the refused consumer left its evidence directory beside the result');
  assert.ok(fs.readdirSync(path.join(out, added[0], 'receipts')).length > 0, 'refusal diagnostics retained');
});
