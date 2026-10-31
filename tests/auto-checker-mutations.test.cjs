'use strict';
// Explicit real-Lean guard qualification; never run by default npm tests.
const { it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const rootScript = path.resolve(__dirname, '../scripts/fvs-checker.mjs');
const rootHelper = path.resolve(__dirname, '../scripts/FvsKernelAudit.lean');
const lean = path.join(os.homedir(), '.elan/toolchains/leanprover--lean4---v4.31.0/bin/lean');
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const roots = [];
after(() => { for (const root of roots) process.stdout.write(`Retained mutation evidence: ${root}\n`); });

it('real negatives detect omission of each core identity/replay guard', { skip: process.env.FVS_CHECKER_MUTATIONS !== '1' }, async (t) => {
  assert.ok(fs.existsSync(lean), 'installed Lean4.31 is required; no missing-capability skip');
  const invalid = 'import Lean\nopen Lean Elab Command\nset_option debug.skipKernelTC true in\nrun_cmd do\n  liftCoreM <| addDecl (.thmDecl { name := `Fixture.dependency, levelParams := [], type := mkConst ``True, value := mkNatLit 0 })\ntheorem Fixture.target : True := Fixture.dependency\n';
  const cases = [
    { name: 'exact-type', before: 'theorem Fixture.target (n : Nat) : n = n := rfl\n', after: 'theorem Fixture.target (m : Nat) : m = m := rfl\n',
      from: 'unless e.levelParams == a.levelParams && Expr.equal e.type a.type do', to: 'unless true do', reason: /statement identity mismatch/ },
    { name: 'semantic-definition', before: 'def Fixture.meaning : Nat := 0\ntheorem Fixture.target : Fixture.meaning = Fixture.meaning := rfl\n',
      after: 'def Fixture.meaning : Nat := 1\ntheorem Fixture.target : Fixture.meaning = Fixture.meaning := rfl\n',
      from: 'unless sameInfo expected actual false do', to: 'unless true do', reason: /semantic definition identity mismatch/ },
    { name: 'helper-proof-identity', before: 'theorem Fixture.dependency : True := True.intro\ntheorem Fixture.target : True := True.intro\n',
      after: 'theorem Fixture.dependency : True := True.intro\ntheorem Fixture.target : True := Fixture.dependency\n', reuse: true,
      from: 'unless sameInfo expected actual true do\n          throw <| IO.userError s!"changed accepted helper proof identity {name}"',
      to: 'unless true do\n          throw <| IO.userError s!"changed accepted helper proof identity {name}"', reason: /changed accepted helper proof identity/ },
    { name: 'kernel-replay-and-coverage', before: invalid, after: invalid,
      from: '  let checked ← env.replay project\n  for (name, expected) in project.toList do\n    let some actual := checked.toKernelEnv.find? name\n      | throw <| IO.userError s!"kernel replay omitted {name}"\n    unless sameInfo expected actual true do\n      throw <| IO.userError s!"kernel replay identity mismatch {name}"',
      to: '  let checked := env', reason: /while replaying declaration 'Fixture.dependency'/ },
  ];
  for (const c of cases) await t.test(c.name, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-checker-mutation-')); roots.push(root);
    const compile = (role, text) => {
      const dir = path.join(root, role); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'Fixture.lean'), text);
      const run = spawnSync(lean, ['-o', 'Fixture.olean', 'Fixture.lean'], { cwd: dir, encoding: 'utf8', timeout: 30000 });
      fs.writeFileSync(path.join(dir, 'compile.stdout'), run.stdout ?? ''); fs.writeFileSync(path.join(dir, 'compile.stderr'), run.stderr ?? '');
      assert.equal(run.status, 0, run.stdout + run.stderr); return path.join(dir, 'Fixture.olean');
    };
    const reference = compile('reference', c.before), candidate = compile('candidate', c.after);
    const script = path.join(root, 'fvs-checker.mjs'), helper = path.join(root, 'FvsKernelAudit.lean');
    fs.copyFileSync(rootScript, script); const original = fs.readFileSync(rootHelper, 'utf8');
    assert.equal(original.split(c.from).length, 2, 'mutation must identify one exact logical guard');
    fs.writeFileSync(helper, original.replace(c.from, c.to).replace('open Lean\n', 'open Lean\nset_option linter.unusedVariables false\n'));
    fs.writeFileSync(path.join(root, 'mutation.json'), JSON.stringify({ guard: c.name, logicalOmission: c.from, replacement: c.to,
      suppressUnusedVariableWarnings: true, originalScriptSha256: hash(rootScript), originalHelperSha256: hash(rootHelper),
      mutantScriptSha256: hash(script), mutantHelperSha256: hash(helper) }, null, 2) + '\n', { flag: 'wx' });
    const runs = [];
    for (const [name, executable, exit] of [['original', rootScript, 4], ['mutant', script, 0]]) {
      const request = path.join(root, `${name}.json`);
      fs.writeFileSync(request, JSON.stringify({ schema: 'fvs-checker/kernel-request', version: 1, runId: `${c.name}-${name}`,
        lean: { path: lean, sha256: hash(lean) }, deadlineMs: Date.now() + 60000, externalSearchPaths: [], externalImports: ['Lean'],
        modules: [{ name: 'Fixture', parts: [candidate] }], referenceModules: [{ name: 'Fixture', parts: [reference] }],
        targets: [{ name: 'Fixture.target', expectedName: 'Fixture.target' }], meaningRoots: [], ...(c.reuse ? { proofIdentityRoots: ['Fixture.target'] } : {}) }));
      const argv = [executable, 'audit', '--request', request, '--out', path.join(root, name)];
      const run = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 65000 });
      fs.writeFileSync(path.join(root, `${name}.stdout`), run.stdout ?? ''); fs.writeFileSync(path.join(root, `${name}.stderr`), run.stderr ?? '');
      runs.push({ argv: [process.execPath, ...argv], exit: run.status, signal: run.signal, requestSha256: hash(request) });
      fs.writeFileSync(path.join(root, `${name}.attempt.json`), JSON.stringify(runs.at(-1), null, 2) + '\n', { flag: 'wx' });
      assert.equal(run.status, exit, run.stdout + run.stderr);
      if (name === 'original') assert.match(JSON.parse(run.stdout).message, c.reason);
      else assert.equal(JSON.parse(run.stdout).authority, 'audit-only');
    }
    fs.writeFileSync(path.join(root, 'runs.json'), JSON.stringify(runs, null, 2) + '\n', { flag: 'wx' });
  });
});
