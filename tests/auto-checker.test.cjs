'use strict';
const { it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const SCRIPT = path.resolve(__dirname, '../scripts/fvs-checker.mjs');
const directories = [];
after(() => { for (const dir of directories) fs.rmSync(dir, { recursive: true, force: true }); });
function scratch() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-checker-')); directories.push(dir); return dir; }
const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

it('a worker PASS is not a check request and creates no checker record', () => {
  const dir = scratch(), request = path.join(dir, 'worker.json'), out = path.join(dir, 'output');
  fs.writeFileSync(request, JSON.stringify({ schema: 'worker-report', status: 'PASS', axioms: [] }));
  const run = spawnSync(process.execPath, [SCRIPT, 'check', '--request', request, '--out', out], { encoding: 'utf8' });
  assert.equal(run.status, 5, run.stderr);
  assert.equal(JSON.parse(run.stdout).code, 'invalid-input');
  assert.equal(fs.existsSync(out), false);
});

it('auto dispatch cannot promote a standalone result or worker receipt', () => {
  for (const command of ['freeze', 'check', 'accept']) {
    const dir = scratch(), request = path.join(dir, 'forged.json'), out = path.join(dir, 'output');
    fs.writeFileSync(request, JSON.stringify({ schema: `fvs-checker/${command}-request`, version: 1, purpose: 'auto',
      runId: 'worker-pass', deadlineMs: Date.now() + 10000, status: 'PASS', authority: 'canonical-checker', axioms: [] }));
    const run = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/fvs-auto.mjs'), command, '--request', request, '--out', out], { encoding: 'utf8' });
    assert.equal(run.status, 5, run.stdout + run.stderr);
    assert.equal(JSON.parse(run.stdout).status, 'unverified');
    assert.equal(fs.existsSync(out), false);
  }
});

it('an interrupted accepted store is pending, never an empty accepted history', async () => {
  const { readAcceptedStore } = await import('../scripts/fvs-checker-auto.mjs');
  const dir = scratch();
  assert.equal(readAcceptedStore(path.join(dir, 'absent')).headSha256, null);
  fs.mkdirSync(path.join(dir, 'lock'));
  assert.throws(() => readAcceptedStore(dir), /pending/);
});

it('duplicate JSON authority fields and exhausted deadlines create no auto records', () => {
  const cases = [
    ['duplicate', '{"schema":"fvs-checker/check-request","version":1,"purpose":"auto","purpose":"auto","runId":"duplicate","deadlineMs":9999999999999}', 5],
    ['expired', JSON.stringify({ schema: 'fvs-checker/check-request', version: 1, purpose: 'auto', runId: 'expired', deadlineMs: 1 }), 8],
  ];
  for (const [name, body, exit] of cases) {
    const dir = scratch(), request = path.join(dir, `${name}.json`), out = path.join(dir, 'output'); fs.writeFileSync(request, body);
    const run = spawnSync(process.execPath, [SCRIPT, 'check', '--request', request, '--out', out], { encoding: 'utf8' });
    assert.equal(run.status, exit, run.stdout + run.stderr);
    assert.equal(JSON.parse(run.stdout).status, 'unverified');
    assert.equal(fs.existsSync(out), false);
  }
});

it('binds observed dependencies to actual compiler origins and frozen bytes (protocol fixture)', async (t) => {
  const { verifyBuildImports } = await import('../scripts/fvs-checker.mjs');
  const dir = fs.realpathSync(scratch()), runtime = path.join(dir, 'runtime'), owned = path.join(dir, 'dependencies'), project = path.join(dir, 'project'), compiled = path.join(dir, 'build');
  fs.mkdirSync(project); fs.mkdirSync(compiled); fs.writeFileSync(path.join(project, 'Project.lean'), 'protocol fixture source'); fs.writeFileSync(path.join(compiled, 'Project.olean'), 'protocol fixture output');
  fs.mkdirSync(path.join(runtime, 'lean'), { recursive: true }); fs.mkdirSync(path.join(owned, 'first'), { recursive: true }); fs.mkdirSync(path.join(owned, 'second'));
  const standard = path.join(runtime, 'lean/Std.olean'), first = path.join(owned, 'first/Shared.olean'), second = path.join(owned, 'second/Shared.olean');
  fs.writeFileSync(standard, 'fixture standard bytes'); fs.writeFileSync(first, 'same fixture module'); fs.writeFileSync(second, 'same fixture module');
  const identity = (file) => ({ sha256: digest(file), size: fs.statSync(file).size });
  const sealed = (name, value) => { const file = path.join(dir, `${name}.json`); fs.writeFileSync(file, JSON.stringify(value), { flag: 'wx' }); return { file, sha256: digest(file) }; };
  const output = (externalFiles) => ({ root: compiled, files: { 'Project.olean': identity(path.join(compiled, 'Project.olean')) }, externalFiles, externalRoots: { [path.join(runtime, 'lean')]: { kind: 'toolchain' }, [path.join(owned, 'first')]: { kind: 'dependency' }, [path.join(owned, 'second')]: { kind: 'dependency' } } });
  const source = { kind: 'worktree', originalRoot: project, commit: null, tree: null, files: { 'Project.lean': identity(path.join(project, 'Project.lean')) } };
  const build = { source, projectRoot: project, buildRoot: compiled, inventories: { source: sealed('source', source), outputs: sealed('outputs', output({ [first]: identity(first) })) },
    lean: { runtime: sealed('runtime', { root: runtime, files: { 'lean/Std.olean': identity(standard) } }) },
    dependencies: { owned: { root: owned }, before: sealed('dependencies', { 'first/Shared.olean': identity(first), 'second/Shared.olean': identity(second) }) } };
  const observed = [{ name: 'Std', project: false, parts: [{ file: standard, sha256: digest(standard) }] },
    { name: 'Shared', project: false, parts: [{ file: first, sha256: digest(first) }] }];
  await t.test('matching actual origin and bytes succeed', () => assert.doesNotThrow(() => verifyBuildImports(build, observed)));
  await t.test('same bytes at a different selected compiler origin refuse', () => {
    const changed = { ...build, inventories: { ...build.inventories, outputs: sealed('other-origin', output({ [second]: identity(second) })) } };
    assert.equal(digest(first), digest(second));
    assert.throws(() => verifyBuildImports(changed, observed), /witness\/compiler import origin mismatch/);
  });
  await t.test('ambiguous actual compiler origins refuse conservatively', () => {
    const changed = { ...build, inventories: { ...build.inventories, outputs: sealed('ambiguous-origin', output({ [first]: identity(first), [second]: identity(second) })) } };
    assert.throws(() => verifyBuildImports(changed, observed), /witness\/compiler import origin mismatch/);
  });
  await t.test('an observed runtime byte change cannot use the old inventory', () => {
    fs.writeFileSync(standard, 'changed fixture standard bytes');
    const changed = [{ ...observed[0], parts: [{ file: standard, sha256: digest(standard) }] }, observed[1]];
    assert.throws(() => verifyBuildImports(build, changed), /unbound compiler dependency part/);
    fs.writeFileSync(standard, 'fixture standard bytes');
  });
  await t.test('substituted project outputs cannot use the old build receipt', () => {
    fs.writeFileSync(path.join(compiled, 'Project.olean'), 'substituted protocol output');
    assert.throws(() => verifyBuildImports(build, observed), /source\/compiler output changed/);
    fs.writeFileSync(path.join(compiled, 'Project.olean'), 'protocol fixture output');
  });
  await t.test('source mutation cannot use a successful earlier build', () => {
    fs.writeFileSync(path.join(project, 'Project.lean'), 'changed source after build');
    assert.throws(() => verifyBuildImports(build, observed), /source\/compiler output changed/);
  });
});

it('refuses project modules that shadow the pinned checker toolchain before executing tools', () => {
  const dir = scratch(), bin = path.join(dir, 'toolchain/bin'), lib = path.join(dir, 'toolchain/lib/lean');
  fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(lib, { recursive: true });
  const lean = path.join(bin, 'lean'), submitted = path.join(dir, 'Lean.olean');
  fs.writeFileSync(lean, 'protocol fixture tool, must never execute'); fs.writeFileSync(path.join(lib, 'Lean.olean'), 'pinned standard module'); fs.writeFileSync(submitted, 'submitted module');
  const request = path.join(dir, 'request.json'), out = path.join(dir, 'out');
  fs.writeFileSync(request, JSON.stringify({ schema: 'fvs-checker/kernel-request', version: 1, runId: 'shadow', lean: { path: lean, sha256: digest(lean) },
    deadlineMs: Date.now() + 10000, externalSearchPaths: [], externalImports: ['Lean'], modules: [{ name: 'Lean', parts: [submitted] }],
    referenceModules: [{ name: 'Lean', parts: [submitted] }], targets: [{ name: 'target', expectedName: 'target' }], meaningRoots: [] }));
  const run = spawnSync(process.execPath, [SCRIPT, 'audit', '--request', request, '--out', out], { encoding: 'utf8' });
  assert.equal(run.status, 6, run.stdout + run.stderr); assert.match(JSON.parse(run.stdout).message, /project module shadows the pinned toolchain/);
  assert.equal(fs.existsSync(out), false);
});
