// The optional supplied-root path of the shared protocol fixtures (used by the real re-specification scenario).
// Protocol doubles only; no proof, Lean or provider evidence.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const rf = require('./helpers/resume-fixture.cjs');
const memory = require('./helpers/memory-fixture.cjs');
const ROOT = path.resolve(__dirname, '..');
const owned = [];
after(() => { for (const p of owned) fs.rmSync(p, { recursive: true, force: true }); });
const auto = () => import(pathToFileURL(path.join(ROOT, 'scripts/fvs-auto.mjs')).href);
const read = p => fs.readFileSync(p);
function prepared(a, policy) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-d-supplied-'))); owned.push(base);
  return memory.createProject(a, base, policy);
}

test('default callers still create and own a synthetic project', async () => {
  const a = await auto(), x = rf.fixture(a, undefined, null, { schemaVersion: 2 }); owned.push(x.owned);
  assert.ok((x.root + path.sep).startsWith(x.owned + path.sep));
  assert.match(read(path.join(x.root, '.git/info/exclude')).toString(), /\.formalising\//);
});

test('a supplied root is used as-is: not owned, no excludes, no synthetic memory store', async () => {
  const a = await auto(), root = prepared(a, { schemaVersion: 2, memory: 'beads' });
  const exclude = read(path.join(root, '.git/info/exclude')), state = read(path.join(root, '.formalising/auto-fv/state.json'));
  const x = rf.fixture(a, undefined, null, { schemaVersion: 2, memory: 'beads', root }); owned.push(x.owned);
  assert.equal(x.root, root);
  assert.equal((root + path.sep).startsWith(x.owned + path.sep), false, 'supplied root must not be inside the owned cleanup directory');
  assert.deepEqual(read(path.join(root, '.git/info/exclude')), exclude);
  assert.deepEqual(read(path.join(root, '.formalising/auto-fv/state.json')), state, 'no fake Beads registration is recorded for a supplied root');
  assert.equal(fs.existsSync(path.join(root, '.beads')), false);
  fs.rmSync(x.owned, { recursive: true, force: true });
  assert.ok(fs.existsSync(path.join(root, '.git')), 'owned cleanup leaves the supplied root intact');
});

test('relative or aliased (symlink) roots are refused before any fixture state is written', async () => {
  const a = await auto(), root = prepared(a, { schemaVersion: 2 }), parent = fs.realpathSync(os.tmpdir());
  const link = path.join(path.dirname(root), 'alias'); fs.symlinkSync(root, link);
  const state = read(path.join(root, '.formalising/auto-fv/state.json'));
  for (const bad of [path.relative(process.cwd(), root), link]) assert.throws(() => rf.fixture(a, parent, null, { schemaVersion: 2, root: bad }), /supplied fixture root/);
  assert.deepEqual(read(path.join(root, '.formalising/auto-fv/state.json')), state);
});

test('the driver world forwards its policy to the shared fixture', async () => {
  const { world } = require('./helpers/auto-driver-fixture.cjs');
  const a = await auto(), root = prepared(a, { schemaVersion: 2 });
  const w = await world(ROOT, { root }); owned.push(w.x.owned);
  assert.equal(w.x.root, root); assert.equal(w.source().root, root);
});
