// Preparation-only integration: never runs Lean, Lake, probes, versions or capture steps.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const HARNESS = path.join(__dirname, 'helpers/lean-witness-capture/paired-run3.sh');
function world(t, copy = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-witness-preparation-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project space $& $'"), base = path.join(root, 'exclusive outputs');
  fs.mkdirSync(project); fs.mkdirSync(base); fs.writeFileSync(path.join(project, 'M1demo.lean'), '-- inert implementation input\n');
  let harness = HARNESS;
  if (copy) {
    const dest = path.join(root, 'owned-helper'); fs.cpSync(path.dirname(HARNESS), dest, { recursive: true }); harness = path.join(dest, 'paired-run3.sh');
  }
  const run = (name = 'prepared', roots = 'M1demo') => spawnSync('/bin/bash', [harness, name, project, roots], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin', FVS_WITNESS_BASE: base, FVS_WITNESS_PREPARE_ONLY: '1' },
  });
  return { root, project, base, run, harness };
}
test('relocated harness shell parses without executing a program', () => {
  const p = spawnSync('/bin/bash', ['-n', HARNESS], { encoding: 'utf8' }); assert.equal(p.status, 0, p.stderr);
});
test('preparation emits exact real capped/cache argv and M1demo-only programs with quoted literal paths', t => {
  const x = world(t), p = x.run(); assert.equal(p.status, 0, p.stderr);
  const out = path.join(x.base, 'prepared'), plan = JSON.parse(fs.readFileSync(path.join(out, '00-planned-argv.json')));
  const lake = '/Users/ada/.elan/toolchains/leanprover--lean4---v4.31.0/bin/lake';
  assert.equal(plan.status, 'prepared-not-executed'); assert.equal(plan.cwd, x.project);
  assert.deepEqual(plan.commands.build, [lake, '--no-cache', '--rehash', '--verbose', 'build', 'M1demo']);
  assert.deepEqual(plan.commands.discovery, [lake, 'env', 'lean', '--threads=2', path.join(out, 'work/Discover.lean')]);
  assert.deepEqual(plan.commands.oracle, [lake, 'env', 'lean', '--threads=2', path.join(out, 'work/LeanConstantsV3.lean')]);
  assert.deepEqual(plan.commands.probe.slice(1), ['extract', x.project, '-o', path.join(out, 'work/lean.json'), '--library', 'M1demo']);
  for (const name of ['Discover.lean', 'LeanConstantsV3.lean']) {
    const text = fs.readFileSync(path.join(out, 'work', name), 'utf8');
    assert.match(text, /^import M1demo\n/); assert.doesNotMatch(text, /^import Specs/m);
  }
  assert.match(fs.readFileSync(path.join(out, 'work/LeanConstantsV3.lean'), 'utf8'), /projectRoots : List Name := \[`M1demo\]/);
  for (const file of ['lean.json','receipt.json','constants.json','constants-run.json','01-lake-build.log']) assert.equal(fs.existsSync(path.join(out, file)), false);
  assert.deepEqual(fs.readdirSync(x.project), ['M1demo.lean']);
});
test('existing output refuses without overwriting its prepared bytes', t => {
  const x = world(t); assert.equal(x.run().status, 0);
  const p = path.join(x.base, 'prepared/00-planned-argv.json'), before = fs.readFileSync(p);
  const run = x.run(); assert.notEqual(run.status, 0); assert.deepEqual(fs.readFileSync(p), before);
});
test('scope/name/source contamination and changed qualified support refuse before any capture step', async t => {
  for (const kind of ['wrong roots','traversal name','Specs','state','changed support']) await t.test(kind, tt => {
    const x = world(tt, kind === 'changed support');
    if (kind === 'Specs') fs.mkdirSync(path.join(x.project, 'Specs'));
    if (kind === 'state') fs.mkdirSync(path.join(x.project, '.formalising'));
    if (kind === 'changed support') fs.appendFileSync(path.join(path.dirname(x.harness), 'qualified/receipt5.py'), '\n# changed\n');
    const p = x.run(kind === 'traversal name' ? '../escape' : 'prepared', kind === 'wrong roots' ? 'M1demo,Specs' : 'M1demo');
    assert.notEqual(p.status, 0, p.stdout + p.stderr);
    const out = path.join(x.base, 'prepared');
    for (const file of ['01-lake-build.log','receipt.json','constants.json','constants-run.json']) assert.equal(fs.existsSync(path.join(out, file)), false);
  });
});
