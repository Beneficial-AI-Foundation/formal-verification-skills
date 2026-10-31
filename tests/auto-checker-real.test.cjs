'use strict';
// Explicit offline Lean qualification. Default npm tests do not run Lean.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const SCRIPT = path.resolve(__dirname, '../scripts/fvs-checker.mjs');
const LEAN = path.join(os.homedir(), '.elan/toolchains/leanprover--lean4---v4.31.0/bin/lean');
const STANDALONE_MS = 180000;
const STANDALONE_TIMEOUT = 185000;
const temporary = [];
after(() => { for (const dir of temporary) process.stdout.write(`Retained working evidence: ${dir}\n`); });
function scratch() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-checker-real-')); temporary.push(dir); return dir; }
function compile(root, source, module = 'Fixture') {
  fs.mkdirSync(root); fs.writeFileSync(path.join(root, `${module}.lean`), source);
  const run = spawnSync(LEAN, ['-o', `${module}.olean`, `${module}.lean`], { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stdout + run.stderr); return path.join(root, `${module}.olean`);
}
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function response(stdout) {
  const envelope = JSON.parse(stdout);
  if (!envelope.evidence) return envelope;
  assert.equal(hash(envelope.evidence.file), envelope.evidence.sha256, 'retained result matches its console binding');
  return { ...JSON.parse(fs.readFileSync(envelope.evidence.file)), ...envelope };
}

describe('real checker core (FVS_REAL_CHECKER=1)', { skip: process.env.FVS_REAL_CHECKER !== '1' }, () => {
  it('times out an actual running compiler and retains its failed attempt', () => {
    const dir = scratch(), project = path.join(dir, 'project'); fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'Fixture.lean'), 'import Lean\nopen Lean Elab Command\nrun_cmd do\n  liftIO do\n    let some tmp ← IO.getEnv "TMPDIR" | throw <| IO.userError "missing TMPDIR"\n    IO.FS.writeFile (System.FilePath.mk tmp / "compiler-entered") "yes"\n    IO.sleep 60000\ntheorem target : True := True.intro\n');
    const request = path.join(dir, 'freeze.json'), out = path.join(dir, 'baseline');
    fs.writeFileSync(request, JSON.stringify({ schema: 'fvs-checker/freeze-request', version: 1, purpose: 'standalone', runId: 'running-compiler-timeout',
      projectRoot: project, specFile: 'Fixture.lean', lean: { path: LEAN, sha256: hash(LEAN) }, deadlineMs: Date.now() + 20000,
      externalSearchPaths: [], externalImports: ['Lean'] }));
    const run = spawnSync(process.execPath, [SCRIPT, 'freeze', '--request', request, '--out', out], { encoding: 'utf8', timeout: 25000 });
    assert.equal(run.status, 8, run.stdout + run.stderr); assert.equal(JSON.parse(run.stdout).status, 'unverified');
    assert.equal(fs.readFileSync(path.join(out, 'project-build/tmp/compiler-entered'), 'utf8'), 'yes');
    const failed = JSON.parse(fs.readFileSync(path.join(out, 'project-build/receipts/failure.json')));
    const receipt = failed.receipts.at(-1);
    assert.equal(receipt.timedOut, true); assert.equal(receipt.exit, null); assert.ok(receipt.signal);
    assert.equal(fs.existsSync(path.join(out, 'frozen.json')), false);
  });
  it('captures a configured Lake project before editing and uses the same standalone engine', () => {
    const dir = fs.realpathSync(scratch()), project = path.join(dir, 'project'); fs.mkdirSync(project);
    const source = 'import Lean\nnamespace Configured\nsection\nvariable {α : Type}\ntheorem target [Inhabited α] (x : α) : x = x := by sorry\nend\nend Configured\n';
    fs.writeFileSync(path.join(project, 'Fixture.lean'), source);
    fs.writeFileSync(path.join(project, 'lean-toolchain'), 'leanprover/lean4:v4.31.0\n');
    fs.writeFileSync(path.join(project, 'lakefile.toml'), 'name = "fixture"\n[[lean_lib]]\nname = "Fixture"\n');
    fs.writeFileSync(path.join(project, 'lake-manifest.json'), JSON.stringify({ version: '1.1.0', packagesDir: '.lake/packages', packages: [], name: 'fixture', lakeDir: '.lake' }));
    const lake = path.join(path.dirname(LEAN), 'lake'), request = path.join(dir, 'freeze.json'), out = path.join(dir, 'baseline');
    fs.writeFileSync(request, JSON.stringify({ schema: 'fvs-checker/freeze-request', version: 1, purpose: 'standalone', runId: 'configured-pre-edit',
      projectRoot: project, specFile: 'Fixture.lean', lean: { path: LEAN, sha256: hash(LEAN) }, deadlineMs: Date.now() + 180000,
      externalSearchPaths: [], externalImports: [], build: { lake: { path: lake, sha256: hash(lake) }, libraries: ['Fixture'] } }));
    let run = spawnSync(process.execPath, [SCRIPT, 'freeze', '--request', request, '--out', out], { encoding: 'utf8', timeout: 185000 });
    assert.equal(run.status, 0, run.stdout + run.stderr); const baseline = response(run.stdout).baseline;
    const frozen = JSON.parse(fs.readFileSync(baseline.file));
    assert.deepEqual(frozen.targets.map((t) => t.name), ['Configured.target']); assert.ok(frozen.buildProfile);
    fs.writeFileSync(path.join(project, 'Fixture.lean'), source.replace('by sorry', 'by rfl'));
    const check = path.join(dir, 'check.json');
    fs.writeFileSync(check, JSON.stringify({ schema: 'fvs-checker/check-request', version: 1, purpose: 'standalone', runId: 'configured-candidate',
      projectRoot: project, baseline, deadlineMs: Date.now() + 180000 }));
    run = spawnSync(process.execPath, [SCRIPT, 'check', '--request', check, '--out', path.join(dir, 'candidate')], { encoding: 'utf8', timeout: 185000 });
    assert.equal(run.status, 0, run.stdout + run.stderr); const result = response(run.stdout);
    assert.equal(result.sourceIdentity, 'matched'); assert.equal(result.authority, 'audit-only');
    assert.equal(result.audit.status, 'kernel-checked'); assert.equal(result.acceptedReceipt, undefined);
  });
  it('requires a compiling pre-edit baseline even after a broken original is repaired', () => {
    const dir = scratch(), project = path.join(dir, 'project'); fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'Fixture.lean'), 'theorem target : False := True.intro\n');
    const request = path.join(dir, 'freeze.json'), out = path.join(dir, 'baseline');
    fs.writeFileSync(request, JSON.stringify({ schema: 'fvs-checker/freeze-request', version: 1, purpose: 'standalone', runId: 'broken-original',
      projectRoot: project, specFile: 'Fixture.lean', lean: { path: LEAN, sha256: hash(LEAN) }, deadlineMs: Date.now() + STANDALONE_MS,
      externalSearchPaths: [], externalImports: ['Init'] }));
    let run = spawnSync(process.execPath, [SCRIPT, 'freeze', '--request', request, '--out', out], { encoding: 'utf8', timeout: STANDALONE_TIMEOUT });
    assert.equal(run.status, 6, run.stdout + run.stderr); assert.equal(JSON.parse(run.stdout).code, 'baseline-unavailable');
    assert.equal(fs.existsSync(path.join(out, 'frozen.json')), false);
    fs.writeFileSync(path.join(project, 'Fixture.lean'), 'theorem target : True := True.intro\n');
    const check = path.join(dir, 'check.json'), candidate = path.join(dir, 'candidate');
    fs.writeFileSync(check, JSON.stringify({ schema: 'fvs-checker/check-request', version: 1, purpose: 'standalone', runId: 'no-late-adoption',
      projectRoot: project, baseline: { file: path.join(out, 'frozen.json'), sha256: '0'.repeat(64) }, deadlineMs: Date.now() + STANDALONE_MS }));
    run = spawnSync(process.execPath, [SCRIPT, 'check', '--request', check, '--out', candidate], { encoding: 'utf8', timeout: STANDALONE_TIMEOUT });
    assert.equal(run.status, 6, run.stdout + run.stderr); assert.equal(JSON.parse(run.stdout).code, 'baseline-unavailable');
    assert.equal(fs.existsSync(candidate), false);
  });
  it('audits an unchanged zero-sorry standalone spec against its pre-edit baseline', () => {
    const dir = scratch(), project = path.join(dir, 'project'); fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'Fixture.lean'), 'theorem target : True := True.intro\n');
    const request = path.join(dir, 'freeze.json'), out = path.join(dir, 'baseline');
    fs.writeFileSync(request, JSON.stringify({ schema: 'fvs-checker/freeze-request', version: 1, purpose: 'standalone', runId: 'zero-sorry-original',
      projectRoot: project, specFile: 'Fixture.lean', lean: { path: LEAN, sha256: hash(LEAN) }, deadlineMs: Date.now() + STANDALONE_MS,
      externalSearchPaths: [], externalImports: ['Init'] }));
    let run = spawnSync(process.execPath, [SCRIPT, 'freeze', '--request', request, '--out', out], { encoding: 'utf8', timeout: STANDALONE_TIMEOUT });
    assert.equal(run.status, 0, run.stdout + run.stderr); const baseline = response(run.stdout).baseline;
    const check = path.join(dir, 'check.json');
    fs.writeFileSync(check, JSON.stringify({ schema: 'fvs-checker/check-request', version: 1, purpose: 'standalone', runId: 'zero-sorry-check',
      projectRoot: project, baseline, deadlineMs: Date.now() + STANDALONE_MS }));
    run = spawnSync(process.execPath, [SCRIPT, 'check', '--request', check, '--out', path.join(dir, 'candidate')], { encoding: 'utf8', timeout: STANDALONE_TIMEOUT });
    assert.equal(run.status, 0, run.stdout + run.stderr); const result = response(run.stdout);
    assert.equal(result.schema, 'fvs-checker/standalone-result'); assert.equal(result.authority, 'audit-only');
    assert.equal(result.audit.status, 'kernel-checked'); assert.deepEqual(result.audit.targets, ['target']);
  });
  it('uses exact binder/type identity and preserves private and instance meaning', async (t) => {
    const cases = [
      ['binder-name', 'theorem target (n : Nat) : n = n := rfl', 'theorem target (m : Nat) : m = m := rfl', /statement identity mismatch/],
      ['binder-annotation', 'theorem target (n : Nat) : n = n := rfl', 'theorem target {n : Nat} : n = n := rfl', /statement identity mismatch/],
      ['definitionally-equal-type', 'theorem target (n : Nat) : n = n := rfl', 'theorem target (n : Nat) : n + 0 = n := by simp', /statement identity mismatch/],
      ['private-meaning', 'private def meaning : Nat := 0\ntheorem target : meaning = meaning := rfl', 'private def meaning : Nat := 1\ntheorem target : meaning = meaning := rfl', /semantic definition identity mismatch/],
      ['instance-meaning', 'instance : Inhabited Nat := ⟨0⟩\ndef meaning : Nat := default\ntheorem target : meaning = meaning := rfl', 'instance : Inhabited Nat := ⟨1⟩\ndef meaning : Nat := default\ntheorem target : meaning = meaning := rfl', /semantic definition identity mismatch/],
    ];
    for (const [name, before, after, diagnostic] of cases) await t.test(name, () => {
      const dir = scratch(), wrap = (s) => `import Lean\nnamespace Fixture\n${s}\nend Fixture\n`;
      const reference = compile(path.join(dir, 'reference'), wrap(before)), candidate = compile(path.join(dir, 'candidate'), wrap(after));
      const request = path.join(dir, 'request.json');
      fs.writeFileSync(request, JSON.stringify({ schema: 'fvs-checker/kernel-request', version: 1, runId: name,
        lean: { path: LEAN, sha256: hash(LEAN) }, deadlineMs: Date.now() + 60000, externalSearchPaths: [], externalImports: ['Lean'],
        modules: [{ name: 'Fixture', parts: [candidate] }], referenceModules: [{ name: 'Fixture', parts: [reference] }],
        targets: [{ name: 'Fixture.target', expectedName: 'Fixture.target' }], meaningRoots: [] }));
      const run = spawnSync(process.execPath, [SCRIPT, 'audit', '--request', request, '--out', path.join(dir, 'audit')], { encoding: 'utf8', timeout: 65000 });
      assert.equal(run.status, 4, run.stdout + run.stderr); assert.match(response(run.stdout).message, diagnostic);
    });
  });
  it('reuses only an exact accepted-helper proof closure, allowing unrelated proofs', async (t) => {
    const dir = scratch(), prefix = 'import Lean\nnamespace Fixture\ntheorem dependency : True := True.intro\n';
    const reference = compile(path.join(dir, 'reference'), prefix + 'theorem target : True := True.intro\nend Fixture\n');
    for (const [name, body, reuse, exit] of [
      ['unchanged', 'True.intro', true, 0], ['changed-valid', 'dependency', false, 0], ['changed-stale', 'dependency', true, 4],
    ]) await t.test(name, () => {
      const candidate = compile(path.join(dir, name), prefix + `theorem target : True := ${body}\ntheorem unrelated : True := dependency\nend Fixture\n`);
      const request = path.join(dir, `${name}.json`);
      fs.writeFileSync(request, JSON.stringify({ schema: 'fvs-checker/kernel-request', version: 1, runId: name,
        lean: { path: LEAN, sha256: hash(LEAN) }, deadlineMs: Date.now() + 60000, externalSearchPaths: [], externalImports: ['Lean'],
        modules: [{ name: 'Fixture', parts: [candidate] }], referenceModules: [{ name: 'Fixture', parts: [reference] }],
        targets: [{ name: 'Fixture.target', expectedName: 'Fixture.target' }], meaningRoots: [], ...(reuse ? { proofIdentityRoots: ['Fixture.target'] } : {}) }));
      const run = spawnSync(process.execPath, [SCRIPT, 'audit', '--request', request, '--out', path.join(dir, `audit-${name}`)], { encoding: 'utf8', timeout: 65000 });
      assert.equal(run.status, exit, run.stdout + run.stderr);
      if (exit) assert.match(response(run.stdout).message, /changed accepted helper proof identity Fixture.target/);
      else assert.equal(response(run.stdout).audit.status, 'kernel-checked');
    });
  });
  it('rejects real changed statements, meaning, hidden axioms and admissions with a fresh valid twin', async (t) => {
    const dir = scratch();
    const baselineSource = 'import Lean\nnamespace Fixture\ndef meaning : Nat := 0\ntheorem target : meaning = 0 := rfl\nend Fixture\n';
    const reference = compile(path.join(dir, 'reference'), baselineSource);
    const cases = [
      ['fresh', baselineSource, 0, null],
      ['different-statement', baselineSource.replace('meaning = 0', 'meaning = meaning'), 4, /statement identity mismatch/],
      ['different-definition', baselineSource.replace('Nat := 0', 'Nat := 1').replace('meaning = 0', 'meaning = 0').replace(':= rfl\nend', ':= by sorry\nend'), 4, /semantic definition identity mismatch/],
      ['hidden-axiom', 'import Lean\nnamespace Fixture\ndef meaning : Nat := 0\naxiom forged : meaning = 0\ndef hidden : meaning = 0 := forged\ntheorem target : meaning = 0 := hidden\nend Fixture\n', 4, /forbidden axiom Fixture.forged/],
      ['sorry', baselineSource.replace(':= rfl', ':= by sorry'), 4, /forbidden axiom sorryAx/],
      ['compiler-axiom', baselineSource.replace(':= rfl', ':= by native_decide'), 4, /forbidden axiom (Lean.ofReduceBool|Lean.trustCompiler|Fixture.target._native.native_decide.ax_)/],
      ['missing-root', baselineSource.replace('theorem target', 'theorem other'), 4, /missing or ambiguous declaration Fixture.target/],
    ];
    for (const [name, source, exit, diagnostic] of cases) await t.test(name, () => {
      const candidate = compile(path.join(dir, name), source);
      const request = path.join(dir, `${name}.json`);
      fs.writeFileSync(request, JSON.stringify({ schema: 'fvs-checker/kernel-request', version: 1, runId: name,
        lean: { path: LEAN, sha256: hash(LEAN) }, deadlineMs: Date.now() + 60000,
        externalSearchPaths: [], externalImports: ['Lean'], modules: [{ name: 'Fixture', parts: [candidate] }],
        referenceModules: [{ name: 'Fixture', parts: [reference] }], targets: [{ name: 'Fixture.target', expectedName: 'Fixture.target' }], meaningRoots: [] }));
      const run = spawnSync(process.execPath, [SCRIPT, 'audit', '--request', request, '--out', path.join(dir, `audit-${name}`)], { encoding: 'utf8', timeout: 65000 });
      assert.equal(run.status, exit, run.stdout + run.stderr);
      const result = response(run.stdout);
      if (diagnostic) { assert.equal(result.status, 'unverified'); assert.match(result.message, diagnostic); }
      else assert.equal(result.audit.status, 'kernel-checked');
      assert.equal(result.acceptedReceipt, undefined);
    });
    const request = path.join(dir, 'fresh.json'), valid = JSON.parse(fs.readFileSync(request));
    for (const [name, update, exit] of [
      ['altered-tool', { lean: { path: LEAN, sha256: '0'.repeat(64) } }, 7],
      ['expired', { deadlineMs: Date.now() - 1 }, 8],
      ['worker-receipt', { verdict: 'PASS' }, 5],
    ]) await t.test(name, () => {
      const changed = path.join(dir, `${name}.json`), out = path.join(dir, `audit-${name}`);
      fs.writeFileSync(changed, JSON.stringify({ ...valid, deadlineMs: Date.now() + 60000, ...update }));
      const run = spawnSync(process.execPath, [SCRIPT, 'audit', '--request', changed, '--out', out], { encoding: 'utf8', timeout: 65000 });
      assert.equal(run.status, exit, run.stdout + run.stderr);
      assert.equal(JSON.parse(run.stdout).status, 'unverified');
      assert.equal(fs.existsSync(out), false);
    });
  });
  it('kernel-checks a private proof dependency against a type-only pre-edit witness', () => {
    assert.ok(fs.existsSync(LEAN), 'required installed Lean4.31 is unavailable');
    const dir = scratch();
    const prefix = 'import Lean\nnamespace Fixture\ndef meaning (n : Nat) : Nat := n + 0\nprivate theorem aux (n : Nat) : n = n := rfl\n';
    const reference = compile(path.join(dir, 'reference'), prefix + 'theorem target (n : Nat) : meaning n = meaning n := by sorry\nend Fixture\n');
    const candidate = compile(path.join(dir, 'candidate'), prefix + 'theorem target (n : Nat) : meaning n = meaning n := aux (meaning n)\nend Fixture\n');
    const request = path.join(dir, 'request.json'), out = path.join(dir, 'audit');
    fs.writeFileSync(request, JSON.stringify({ schema: 'fvs-checker/kernel-request', version: 1, runId: 'private-proof-positive',
      lean: { path: LEAN, sha256: hash(LEAN) }, deadlineMs: Date.now() + 60000,
      externalSearchPaths: [], externalImports: ['Lean'],
      modules: [{ name: 'Fixture', parts: [candidate] }], referenceModules: [{ name: 'Fixture', parts: [reference] }],
      targets: [{ name: 'Fixture.target', expectedName: 'Fixture.target' }], meaningRoots: [] }));
    const run = spawnSync(process.execPath, [SCRIPT, 'audit', '--request', request, '--out', out], { encoding: 'utf8', timeout: 65000 });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const result = response(run.stdout);
    assert.equal(result.authority, 'audit-only');
    assert.equal(result.audit.status, 'kernel-checked');
    assert.ok(result.audit.replayed.includes('_private.Fixture.0.Fixture.aux'));
    assert.ok(result.audit.replayed.includes('Fixture.meaning'));
    assert.equal(result.acceptedReceipt, undefined);
    assert.equal(result.attempt.argv[2], result.attempt.snapshots.helper);
    assert.deepEqual(fs.readFileSync(result.attempt.snapshots.helper), fs.readFileSync(path.resolve(__dirname, '../scripts/FvsKernelAudit.lean')));
    const captured = result.attempt.snapshots.modules.find((m) => m.source === candidate);
    assert.deepEqual(fs.readFileSync(captured.file), fs.readFileSync(candidate));
    const prelude = result.attempt.imports.find((m) => m.name === 'Init.Prelude');
    assert.ok(prelude && prelude.parts.length > 0, 'resolved imported parts are bound in the attempt');
    for (const part of prelude.parts) assert.equal(hash(part.file), part.sha256);
  });
  it('never treats an unchanged axiom-clean project proof as kernel justification', () => {
    for (const invalid of [false, true]) {
      const dir = scratch();
      // Adversarial owned fixture only: the guard is exercised below source/config
      // preflight, so an unchanged invalid proof really reaches the fresh kernel.
      const source = `import Lean\nopen Lean Elab Command\nset_option debug.skipKernelTC true in\nrun_cmd do\n  liftCoreM <| addDecl (.thmDecl { name := \`Fixture.dependency, levelParams := [], type := mkConst \`\`True, value := ${invalid ? 'mkNatLit 0' : 'mkConst ``True.intro'} })\ntheorem Fixture.target : True := Fixture.dependency\n`;
      const compiled = compile(path.join(dir, 'project'), source);
      const request = path.join(dir, 'request.json');
      fs.writeFileSync(request, JSON.stringify({ schema: 'fvs-checker/kernel-request', version: 1, runId: invalid ? 'invalid-unchanged-project-lemma' : 'valid-unchanged-project-lemma',
        lean: { path: LEAN, sha256: hash(LEAN) }, deadlineMs: Date.now() + 60000, externalSearchPaths: [], externalImports: ['Lean'],
        modules: [{ name: 'Fixture', parts: [compiled] }], referenceModules: [{ name: 'Fixture', parts: [compiled] }],
        targets: [{ name: 'Fixture.target', expectedName: 'Fixture.target' }], meaningRoots: [] }));
      const run = spawnSync(process.execPath, [SCRIPT, 'audit', '--request', request, '--out', path.join(dir, 'audit')], { encoding: 'utf8', timeout: 65000 });
      const result = response(run.stdout);
      assert.equal(run.status, invalid ? 4 : 0, run.stdout + run.stderr);
      if (invalid) {
        assert.match(result.message, /while replaying declaration 'Fixture.dependency'/);
        assert.doesNotMatch(result.message, /forbidden axiom|semantic definition identity mismatch/);
      } else assert.equal(result.audit.status, 'kernel-checked');
    }
  });
  it('checks a modern module from its complete ordered private prefix', () => {
    const dir = scratch();
    const source = 'module\npublic import Lean\n@[expose] public section\nnamespace Fixture\nstructure Box where\n  value : Nat\n  other : Nat\ndef meaning (b : Box) : Nat := b.value + 0\nprivate theorem aux (n : Nat) : n = n := rfl\ntheorem target (b : Box) : meaning b = meaning b := aux (meaning b)\nend Fixture\n';
    const compiled = compile(path.join(dir, 'project'), source);
    const parts = [compiled, `${compiled}.server`, `${compiled}.private`];
    assert.ok(parts.every((p) => fs.existsSync(p)), 'the real compiler must produce all three ordered parts');
    const request = path.join(dir, 'request.json');
    fs.writeFileSync(request, JSON.stringify({ schema: 'fvs-checker/kernel-request', version: 1, runId: 'modern-private-positive',
      lean: { path: LEAN, sha256: hash(LEAN) }, deadlineMs: Date.now() + 60000, externalSearchPaths: [], externalImports: ['Lean'],
      modules: [{ name: 'Fixture', parts }], referenceModules: [{ name: 'Fixture', parts }],
      targets: [{ name: 'Fixture.target', expectedName: 'Fixture.target' }], meaningRoots: [] }));
    const run = spawnSync(process.execPath, [SCRIPT, 'audit', '--request', request, '--out', path.join(dir, 'audit')], { encoding: 'utf8', timeout: 65000 });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const result = response(run.stdout);
    assert.ok(result.audit.replayed.includes('_private.Fixture.0.Fixture.aux'));
    assert.ok(result.audit.replayed.includes('Fixture.Box.rec'));
    assert.ok(result.audit.meaning.includes('Fixture.Box.other'), 'unused structure fields retain their projection meaning');
  });
  it('returns unverified for an exported-only view of a modern baseline', () => {
    const dir = scratch();
    const compiled = compile(path.join(dir, 'project'), 'module\npublic import Lean\n@[expose] public section\ntheorem Fixture.target : True := True.intro\n');
    const request = path.join(dir, 'request.json');
    fs.writeFileSync(request, JSON.stringify({ schema: 'fvs-checker/kernel-request', version: 1, runId: 'missing-private-prefix',
      lean: { path: LEAN, sha256: hash(LEAN) }, deadlineMs: Date.now() + 60000, externalSearchPaths: [], externalImports: ['Lean'],
      modules: [{ name: 'Fixture', parts: [compiled, `${compiled}.server`, `${compiled}.private`] }],
      referenceModules: [{ name: 'Fixture', parts: [compiled] }],
      targets: [{ name: 'Fixture.target', expectedName: 'Fixture.target' }], meaningRoots: [] }));
    const run = spawnSync(process.execPath, [SCRIPT, 'audit', '--request', request, '--out', path.join(dir, 'audit')], { encoding: 'utf8', timeout: 65000 });
    assert.equal(run.status, 6, run.stdout + run.stderr);
    const result = response(run.stdout);
    assert.equal(result.code, 'unsupported'); assert.equal(result.status, 'unverified');
    assert.equal(result.acceptedReceipt, undefined);
  });
  it('freezes a compiling contextual standalone spec before its sorry proof is edited', async (t) => {
    const dir = scratch(), project = path.join(dir, 'project'); fs.mkdirSync(project);
    const source = 'import Lean\nnamespace Demo\nsection\nvariable {α : Type}\ntheorem reflexive [Inhabited α] (x : α) : x = x := by sorry\nend\nend Demo\n';
    fs.writeFileSync(path.join(project, 'Fixture.lean'), source);
    fs.writeFileSync(path.join(project, 'lean-toolchain'), 'leanprover/lean4:v4.31.0\n');
    const request = path.join(dir, 'freeze.json'), out = path.join(dir, 'baseline');
    fs.writeFileSync(request, JSON.stringify({ schema: 'fvs-checker/freeze-request', version: 1, purpose: 'standalone', runId: 'pre-edit-contextual-baseline',
      projectRoot: project, specFile: 'Fixture.lean', lean: { path: LEAN, sha256: hash(LEAN) }, deadlineMs: Date.now() + STANDALONE_MS,
      externalSearchPaths: [], externalImports: ['Lean'] }));
    const run = spawnSync(process.execPath, [SCRIPT, 'freeze', '--request', request, '--out', out], { encoding: 'utf8', timeout: STANDALONE_TIMEOUT });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const result = response(run.stdout);
    assert.equal(result.authority, 'audit-only');
    const baseline = JSON.parse(fs.readFileSync(result.baseline.file));
    assert.equal(baseline.purpose, 'standalone');
    assert.deepEqual(baseline.targets.map((t) => t.name), ['Demo.reflexive']);
    assert.equal(fs.readFileSync(path.join(out, 'source/Fixture.lean'), 'utf8'), source);
    assert.equal(result.acceptedReceipt, undefined);
    fs.writeFileSync(path.join(project, 'Fixture.lean'), source.replace('by sorry', 'by rfl') + '\ntheorem Demo.extra : True := True.intro\n');
    const check = path.join(dir, 'check.json');
    fs.writeFileSync(check, JSON.stringify({ schema: 'fvs-checker/check-request', version: 1, purpose: 'standalone', runId: 'completed-contextual-spec',
      baseline: result.baseline, projectRoot: project, deadlineMs: Date.now() + STANDALONE_MS }));
    const checked = spawnSync(process.execPath, [SCRIPT, 'check', '--request', check, '--out', path.join(dir, 'candidate-check')], { encoding: 'utf8', timeout: STANDALONE_TIMEOUT });
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
    const audited = response(checked.stdout);
    assert.equal(audited.authority, 'audit-only');
    assert.equal(audited.audit.status, 'kernel-checked');
    assert.ok(audited.audit.replayed.includes('Demo.extra'), 'new unused helper lemmas are audited too');
    assert.equal(audited.sourceIdentity, 'matched');
    assert.equal(audited.acceptedReceipt, undefined);
    const good = fs.readFileSync(path.join(project, 'Fixture.lean'), 'utf8');
    for (const [label, changed, exit, diagnostic] of [
      ['binder edit', good.replace('(x : α) : x = x', '(y : α) : y = y'), 7, /protected theorem header changed/],
      ['new meaning definition', `${good}\ndef Demo.backdoor : Nat := 0\n`, 7, /new meaning declarations/],
      ['unused admitted helper', good.replace('Demo.extra : True := True.intro', 'Demo.extra : True := by sorry'), 4, /forbidden axiom sorryAx/],
    ]) await t.test(label, () => {
      fs.writeFileSync(path.join(project, 'Fixture.lean'), changed);
      const file = path.join(dir, `negative-${label.replaceAll(' ', '-')}.json`);
      fs.writeFileSync(file, JSON.stringify({ schema: 'fvs-checker/check-request', version: 1, purpose: 'standalone', runId: label.replaceAll(' ', '-'),
        baseline: result.baseline, projectRoot: project, deadlineMs: Date.now() + STANDALONE_MS }));
      const negative = spawnSync(process.execPath, [SCRIPT, 'check', '--request', file, '--out', path.join(dir, `out-${label.replaceAll(' ', '-')}`)], { encoding: 'utf8', timeout: STANDALONE_TIMEOUT });
      assert.equal(negative.status, exit, negative.stdout.slice(0, 3000) + negative.stderr);
      assert.match(response(negative.stdout).message, diagnostic);
      fs.writeFileSync(path.join(project, 'Fixture.lean'), good);
    });
  });
  it('checks external expected-type policy through the shared baseline engine', async (t) => {
    for (const axiom of [false, true]) await t.test(axiom ? 'external axiom refuses' : 'external definition succeeds', () => {
      const dir = scratch(), external = path.join(dir, 'external');
      compile(external, axiom ? 'axiom Assumptions.P : Prop\n' : 'def Assumptions.P : Prop := True\n', 'Assumptions');
      const project = path.join(dir, 'project'); fs.mkdirSync(project);
      fs.writeFileSync(path.join(project, 'Fixture.lean'), 'import Assumptions\ntheorem Demo.goal : Assumptions.P := by sorry\n');
      const built = spawnSync(LEAN, ['-o', 'Fixture.olean', 'Fixture.lean'], { cwd: project, encoding: 'utf8', timeout: 30000,
        env: { PATH: `${path.dirname(LEAN)}:/usr/bin:/bin`, LEAN_PATH: external } });
      assert.equal(built.status, 0, built.stdout + built.stderr);
      const request = path.join(dir, 'baseline.json'), compiled = path.join(project, 'Fixture.olean');
      fs.writeFileSync(request, JSON.stringify({ schema: 'fvs-checker/kernel-request', version: 1, runId: axiom ? 'external-type-axiom' : 'external-type-definition',
        lean: { path: LEAN, sha256: hash(LEAN) }, deadlineMs: Date.now() + 60000, externalSearchPaths: [external], externalImports: ['Lean', 'Assumptions'],
        modules: [{ name: 'Fixture', parts: [compiled] }], referenceModules: [{ name: 'Fixture', parts: [compiled] }],
        targets: [{ name: 'Demo.goal', expectedName: 'Demo.goal' }], meaningRoots: [] }));
      const runner = path.join(dir, 'baseline-engine.mjs');
      fs.writeFileSync(runner, `import {runKernelAudit} from ${JSON.stringify(require('node:url').pathToFileURL(SCRIPT).href)};\ntry { const r=runKernelAudit({request:process.argv[2],out:process.argv[3]},{baseline:true}); console.log(JSON.stringify({ok:true,authority:r.authority,evidence:r.evidence})); } catch(e) { console.log(JSON.stringify({ok:false,status:'unverified',code:e.code,message:e.message})); process.exitCode=4; }\n`);
      const run = spawnSync(process.execPath, [runner, request, path.join(dir, 'baseline')], { encoding: 'utf8', timeout: 65000 });
      assert.equal(run.status, axiom ? 4 : 0, run.stdout + run.stderr);
      if (axiom) assert.match(response(run.stdout).message, /forbidden axiom Assumptions.P/);
      else { const result = response(run.stdout); assert.equal(result.audit.status, 'meaning-checked'); assert.equal(result.audit.targetProofsChecked, false); }
    });
  });
});
