// Explicit owned qualification only. Default tests cannot invent a real receipt.
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const read = r => { const b = fs.readFileSync(r.file); assert.equal(hash(b), r.sha256); return JSON.parse(b); };
it('genuine owned two-generation re-specification/currentness (FVS_REAL_RESPEC=1)', { skip: process.env.FVS_REAL_RESPEC !== '1' }, async () => {
  assert.ok(process.env.FVS_REAL_RESPEC_CONTEXT, 'fresh immutable controller context required');
  const c = JSON.parse(fs.readFileSync(process.env.FVS_REAL_RESPEC_CONTEXT));
  assert.equal(c.schema, 'fvs/owned-respec-qualification'); assert.equal(c.schemaVersion, 1); assert.equal(c.scope, 'qualification-only');
  const api = await import('../scripts/fvs-auto-respec.mjs'), initial = read(c.initial.result), finalRequest = read(c.final.request), final = read(c.final.result);
  assert.equal(initial.operation, 'inspect'); assert.equal(final.operation, 'finish'); assert.equal(final.status, 'ready-for-final-human-review');
  assert.deepEqual(final.frame, initial.frame); assert.equal(final.effectExecutable, false); assert.equal(final.humanReview, 'pending');
  assert.equal(finalRequest.schemaVersion, 2, 'qualification consumes the current v2 respec request');
  const consumed = await api.verifyRespecResult({ request: finalRequest, out: c.final.out }); assert.equal(consumed.status, final.status);
  assert.deepEqual(consumed.observation.nodes.map(n => n.node), [19, 20, 21]); assert.ok(consumed.observation.nodes.every(n => n.proof === 'current'));
  assert.ok(consumed.observation.history.promotions.some(p => p.node === 19 && p.file === 'Specs/CheckerOverlayV1.lean'));
  const f1 = read(c.episode1.baseline), f2 = read(c.episode2.baseline);
  assert.deepEqual(f1.overlayFiles, ['Specs/CheckerOverlayV1.lean']); assert.deepEqual(f2.overlayFiles, ['Specs/CheckerOverlayV2.lean']);
  assert.equal(f2.fixtureSource.commit, c.episode1.source.commit); assert.notEqual(c.episode1.source.commit, c.episode2.source.commit);
  const root = finalRequest.current.bundle.source.root;
  const git = (...args) => {
    const p = spawnSync('/usr/bin/git', ['-C', root, ...args], { timeout: 10000, maxBuffer: 32 * 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(p.status, 0, p.stderr?.toString()); return p.stdout;
  };
  const inventory = s => {
    assert.equal(git('rev-parse', s.commit + '^{tree}').toString().trim(), s.expectedTree);
    return Object.fromEntries(git('ls-tree', '-rz', '--full-tree', s.commit).toString().split('\0').filter(Boolean).map(line => {
      const [head, file] = line.split('\t'); assert.match(head, /^100(?:644|755) blob [0-9a-f]{40}$/); return [file, head];
    }));
  };
  assert.equal(c.initialSource.commit, 'c1dca808811357a10839287cf12a5316a130c95d');
  assert.equal(c.initialSource.expectedTree, 'f3b44d57710592be2e3458182efa0057e37e17df');
  const i0 = inventory(c.initialSource), i1 = inventory(c.episode1.source), i2 = inventory(c.episode2.source); assert.equal(Object.keys(i0).length, 15);
  for (const [file, value] of Object.entries(i0)) { assert.equal(i1[file], value); assert.equal(i2[file], value); }
  assert.deepEqual(Object.keys(i1).filter(k => !Object.hasOwn(i0, k)), ['Specs/CheckerOverlayV1.lean']);
  assert.deepEqual(Object.keys(i2).filter(k => !Object.hasOwn(i0, k)), ['Specs/CheckerOverlayV1.lean', 'Specs/CheckerOverlayV2.lean']);
  assert.equal(i1['Specs/CheckerOverlayV1.lean'], i2['Specs/CheckerOverlayV1.lean']);
  assert.ok(f2.build.modules.some(m => m.name === 'Specs.CheckerOverlayV1'));
  assert.ok(f2.expected.contexts.every(ctx => ctx.projectImports.every(m => !['Specs.CheckerOverlayV1', 'Specs.CheckerOverlayV2'].includes(m.name))));
  assert.equal(f2.records[19].contract.specDefinitions.find(d => d.file === 'Specs/CheckerOverlayV1.lean').sha256, hash(git('show', c.episode1.source.commit + ':Specs/CheckerOverlayV1.lean')));
  assert.ok(c.negatives.length >= 8);
  for (const r of c.negatives) {
    const n = read(r); assert.equal(n.refused, true); assert.notEqual(n.exitCode, 0); assert.equal(n.timedOut, false); assert.equal(n.acceptedOutputCreated, false);
    const output = JSON.parse(fs.readFileSync(n.stdout.file)); assert.equal(hash(fs.readFileSync(n.stdout.file)), n.stdout.sha256); assert.equal(output.code, n.expectedCode);
    assert.deepEqual(n.canonicalAfter, n.canonicalBefore);
  }
});
