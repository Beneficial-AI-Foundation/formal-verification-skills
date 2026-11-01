// Relational protocol fixtures AFTER historical publication validation. These
// are not Lean evidence or accepted receipts; the opt-in real lane supplies those.
const { before, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
let currentAcceptedRows;
before(async () => { ({ currentAcceptedRows } = await import('../scripts/fvs-checker-auto.mjs')); });
const C1 = { commit: 'a'.repeat(40), tree: '1'.repeat(40) }, C2 = { commit: 'b'.repeat(40), tree: '2'.repeat(40) };
const frozen = 'f'.repeat(64), registry = 'e'.repeat(64);
function history() {
  const h = { records: [], heads: new Map() };
  h.publish = (node, integrated, dependencies = []) => {
    // Establish historical dependency validity at each publication, not merely
    // a self-consistent final map. Later publications may supersede these heads.
    for (const d of dependencies) assert.equal(h.heads.get(d.node)?.sha256, d.sha256);
    const record = { seq: h.records.length, prev: h.records.at(-1)?.sha256 ?? null, node, integrated, frozenSha256: frozen, registryHeadSha256: registry, dependencies };
    const row = { record, sha256: crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex') };
    h.records.push(row); h.heads.set(node, row); return row;
  };
  return h;
}
const options = (source = C2) => ({ selection: new Set([19, 20, 21]), source: { commit: source.commit, expectedTree: source.tree }, frozenSha256: frozen, registryHeadSha256: registry });
it('an unrelated C2 acceptance cannot make the retained C1 root20 proof current', () => {
  const h = history(), a = h.publish(19, C1); h.publish(20, C1, [{ node: 19, sha256: a.sha256 }]);
  const b = h.publish(19, C2); h.publish(21, C2, [{ node: 19, sha256: b.sha256 }]);
  const before = JSON.stringify(h.records);
  assert.throws(() => currentAcceptedRows(h, options()), (e) => e.code === 'stale-input' && /node 20 integrated source/.test(e.message));
  assert.equal(JSON.stringify(h.records), before, 'inspection publishes/rebases nothing');
});
it('a historically valid helper reference must also be the current helper head', () => {
  const h = history(), a = h.publish(19, C2); h.publish(20, C2, [{ node: 19, sha256: a.sha256 }]);
  const b = h.publish(19, C2); h.publish(21, C2, [{ node: 19, sha256: b.sha256 }]);
  assert.throws(() => currentAcceptedRows(h, options()), (e) => e.code === 'stale-input' && /superseded helper/.test(e.message));
});
it('foreign/latest-unselected and no-selected-node histories supply no accepted baseline', () => {
  for (const withSelected of [false, true]) {
    const h = history(); if (withSelected) h.publish(19, C2); h.publish(99, C2);
    assert.throws(() => currentAcceptedRows(h, options()), (e) => e.code === 'stale-input' && /outside.*selected context/.test(e.message));
  }
});
it('all-current node/source/context/dependency heads remain reusable without a new event', () => {
  const h = history(), a = h.publish(19, C2); h.publish(20, C2, [{ node: 19, sha256: a.sha256 }]); h.publish(21, C2, [{ node: 19, sha256: a.sha256 }]);
  const before = JSON.stringify(h.records), rows = currentAcceptedRows(h, options());
  assert.deepEqual(rows.map((r) => r.record.node), [19, 20, 21]); assert.equal(JSON.stringify(h.records), before);
  assert.throws(() => currentAcceptedRows(h, { ...options(), frozenSha256: '0'.repeat(64) }), /foreign current context/);
});
