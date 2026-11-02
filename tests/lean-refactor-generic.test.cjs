'use strict';

// Instruction-contract checks: lean-refactor accepts ordinary Lean files, keeps Aeneas guidance
// conditional, and keeps its compiled-proof and statement-preservation safety rules.
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const flat = file => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\s+/g, ' ');
const SOURCES = ['commands/fvs/lean-refactor.md', 'fv-skills/workflows/lean-refactor.md'];

it('targets any compiling Lean file and routes broken or unfinished files to lean-verify', () => {
  for (const file of SOURCES) {
    const text = flat(file);
    assert.match(text, /The target is any Lean file whose proofs already compile: an FVS spec or an ordinary Lean project file/);
    assert.match(text, /If the file has `sorry` or does not build, stop and route it to `\/fvs:lean-verify`; never promise to refactor a broken file/);
  }
});

it('confirms the protected boundary and scope before edits', () => {
  for (const file of SOURCES) {
    const text = flat(file);
    for (const term of ['editable files/declarations/helper locations', 'protected statements', 'core definitions',
      'assumptions', 'attributes', 'public interfaces', 'Contract.lean', 'actual source/diff']) assert.ok(text.includes(term), `${file}: ${term}`);
    assert.match(text, /Confirm uncovered or changed boundaries before edits/);
    assert.ok(text.indexOf('## Step 2: Confirm') < text.indexOf('## Step 3: Establish'));
    assert.match(text, /<agreement>\$CONFIRMED_BOUNDARY_AND_PROTECTED_SOURCE<\/agreement>/);
  }
});

it('targets net LoC over the whole agreed scope including helpers and wiring', () => {
  const reference = flat('fv-skills/references/lean-refactoring.md');
  assert.match(reference, /complete before\/after source union/);
  assert.match(reference, /New files have baseline zero; removed files final zero/);
  assert.match(reference, /net code LoC change = final code total - baseline code total/);
  assert.match(reference, /Count new helpers and import or compatibility wiring/);
  assert.match(reference, /Retain a result only when the measured or explicitly reviewed full-scope net code total decreases without format\/prose deletion credit/);
  for (const file of SOURCES) {
    const text = flat(file);
    assert.match(text, /Retain a result only with evidence of full-scope net code reduction without formatting\/comment-deletion credit/);
    assert.match(text, /Keep conventional formatting and useful explanations/);
    assert.match(text, /final net code LoC across the baseline\/new-file union/);
    assert.match(text, /actual diff, including new\/untracked helper files/);
    assert.match(text, /source\/configuration cost in the combined net total/);
  }
});

it('requires a concrete broader-scope proposal before expansion', () => {
  for (const file of SOURCES) {
    const text = flat(file);
    assert.match(text, /concrete affected files, the shared abstraction and estimated net benefit with basis\/uncertainty versus the narrow option/);
    assert.match(text, /Ask BEFORE expanding/);
    assert.ok(text.indexOf('Ask BEFORE expanding') < text.indexOf('subagent_type="fvs-lean-refactorer"'));
    assert.match(text, /A new public API or protected change requires a concrete proposal and approval first/);
  }
  const role = flat('agents/fvs-lean-refactorer.md');
  assert.match(role, /A new public declaration or protected change needs a concrete proposal and recorded approval/);
  assert.match(role, /return `## PROPOSAL` BEFORE editing it/);
  assert.match(role, /Never add an axiom or `sorry`/);
});

it('makes Aeneas context conditional while allowing an agreed strategy change', () => {
  for (const file of SOURCES) assert.match(flat(file), /Apply Aeneas conventions only to Aeneas-extracted projects/);
  const reference = flat('fv-skills/references/lean-refactoring.md');
  assert.match(reference, /In an Aeneas project, inspect the current generated code and proof support/);
  assert.match(reference, /change strategy only within that agreement/);
  assert.doesNotMatch(reference, /NEVER refactor:|NEVER.*unfold.*step/);
});

it('keeps legacy flags explicit and retains per-target pass budgets', () => {
  assert.match(flat('commands/fvs/lean-refactor.md'), /argument-hint: "<lean_file_path> \[--theorem name\] \[--mode safe\|balanced\|aggressive\] \[--max-passes N\] \[--report-only\]"/);
  for (const file of SOURCES) {
    const text = flat(file);
    assert.match(text, /The default mode needs no compatibility question/);
    assert.match(text, /nonnegative per-target ceiling, default 5, cap 20/);
    assert.match(text, /zero allows no editing passes/);
    assert.match(text, /At zero or an exhausted budget, dispatch no edit worker/);
    assert.match(text, /`--theorem` limits editable proof targets/);
    assert.match(text, /`--report-only` returns findings\/proposals here without changing proof sources/);
  }
});

it('scales research and independent workers without changing configured roles', () => {
  for (const file of SOURCES) {
    const text = flat(file);
    assert.match(text, /two fresh read-only scouts with distinct questions/);
    assert.match(text, /at most five independent workers in a batch/);
    assert.match(text, /Units with a direct or transitive import relation are dependent and run serially/);
    assert.match(text, /A new module imported by another owned unit is dependent too/);
    assert.match(text, /A small cleanup uses one worker/);
    assert.match(text, /do not rewrite roles or substitute cheaper models/);
    assert.match(text, /Refactoring `--mode` is independent of `model_profile`/);
    assert.match(text, /Wait for every launched worker to be terminal before integration or recovery/);
  }
});

it('records comparable actual timing and blocks material regression acceptance', () => {
  for (const file of SOURCES) {
    const text = flat(file);
    assert.match(text, /baseline\/final LoC inventory and comparable build\/elaboration commands, cache conditions/);
    assert.match(text, /same three warm serial timing samples/);
    assert.match(text, /a repeatable material regression blocks automatic acceptance/);
    assert.match(text, /Present an owner trade-off with actual samples\/cost and uncertainty/);
    assert.match(text, /Incomparable measurements remain inconclusive/);
    assert.match(text, /At a budget\/resource limit, report partial completion/);
  }
  const reference = flat('fv-skills/references/lean-refactoring.md');
  assert.match(reference, /Stop when worthwhile permitted opportunities are exhausted/);
  assert.match(reference, /remaining out-of-scope opportunities/);
});

it('requires parent-only serial gates and executable pristine boundary comparisons', () => {
  for (const file of SOURCES) {
    const text=flat(file);
    assert.match(text,/Children never run Lake in the shared workspace/);
    assert.match(text,/one edit worker at a time, with parent gates between units/);
    assert.match(text,/printed boundary recipe: capture the pristine source\/context and fixed protected-name query/);
    assert.match(text,/Do not recapture the baseline after edits/);
    assert.match(text,/Complete the explicit review\/checkable comparison/);
    assert.match(text,/Missing compilation or axiom evidence still blocks retention of the affected unit/);
    assert.match(text,/A helper limitation does not make a valid Lean file unrefactorable/);
    assert.match(text,/continue with a clearly reviewed full-scope comparison/);
    assert.match(text,/metric supports readability judgment, not scoring/);
    assert.match(text,/restore only the failed owner's files from its unit snapshot/);
  }
  const ref=flat('fv-skills/references/lean-refactoring.md');
  for(const token of ['#check @MyProject.publicRoot','#print MyProject.coreDefinition','#print axioms MyProject.publicRoot','messages "$BOUNDARY_QUERY"','diff -u "$BASELINE_DIR/view.json" "$FINAL_DIR/view.json"','not a kernel identity proof','metricWin','unsupported language','BOUNDARY_DEFINITION_SLOTS','set_option pp.maxSteps 20000','never `#print` their proofs','profiler.threshold','mixedPackingFiles']) assert.ok(ref.includes(token),token);
  const child=flat('agents/fvs-lean-refactorer.md');
  assert.match(child,/Do not run Lake, Lean, compiler-backed project scripts or build\/timing commands in the shared workspace/);
  assert.match(child,/Compiler\/gate\/timing status is UNRUN by child/i);
});

it('replaces unsupported tactic and performance rules with evidence and pinned provenance', () => {
  for (const file of [...SOURCES, 'fv-skills/references/lean-refactoring.md', 'agents/fvs-lean-refactorer.md']) {
    assert.doesNotMatch(flat(file), /Zero-risk|Zero chance|No behavioral change possible|Tier [1-4]|tier ceiling|~20%|N \* 0\.3|O\(1\)/i);
  }
  const reference = flat('fv-skills/references/lean-refactoring.md');
  for (const term of ['83582df9d9172456993929f32ac4dd9d99c6211c', 'MIT-licensed', 'PrivateName.lean',
    'Meta/Tactic/Assumption.lean', 'newly written', 'no upstream text or code is copied']) assert.ok(reference.includes(term), term);
  assert.ok(flat('README.md').includes('83582df9d9172456993929f32ac4dd9d99c6211c'));
});

// Default checks execute the snippets against a fake `lake`; the real-Lake regression is opt-in.
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const blocks = file => [...fs.readFileSync(path.join(ROOT, file), 'utf8').matchAll(/```bash\n([\s\S]*?)```/g)].map(m => m[1]);
const block = (file, needle) => blocks(file).find(b => b.includes(needle));

function project({ mathlib = false, behaviour = {}, manifest = null, lakefile = null } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-refactor-gate-')));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const [lakeName, lakeText] = lakefile ?? ['lakefile.toml', 'name = "demo"\n'];
  fs.writeFileSync(path.join(dir, lakeName), lakeText);
  fs.writeFileSync(path.join(dir, 'lean-toolchain'), 'leanprover/lean4:v4.31.0\n');
  const m = manifest ?? (mathlib ? { name: 'demo', packages: [{ name: 'mathlib' }] } : null);
  if (m) fs.writeFileSync(path.join(dir, 'lake-manifest.json'), JSON.stringify(m) + '\n');
  fs.writeFileSync(path.join(bin, 'lake'), [
    '#!/bin/sh', 'echo "$*" >> "$FAKE_LAKE_LOG"', 'key=$(echo "$*" | tr " /." "___")',
    'case "$key" in', ...Object.entries(behaviour).map(([k, [out, code]]) => `  ${k}) echo "${out}"; exit ${code};;`),
    '  *) exit 0;;', 'esac', ''].join('\n'));
  fs.chmodSync(path.join(bin, 'lake'), 0o755);
  return dir;
}
function run(dir, script) {
  const log = path.join(dir, 'lake.log');
  const r = spawnSync('bash', ['-c', `SPEC_PATH=Extra/Broken.lean\n${script}\necho "STATUS ${'$'}{FILE_GATE_STATUS:-} ${'$'}{PROJECT_STATUS:-}"`],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: path.join(dir, 'bin') + path.delimiter + process.env.PATH, FAKE_LAKE_LOG: log } });
  return { ...r, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}

for (const file of SOURCES) {
  it(`${file}: cache preflight is skipped without a cache executable and stops on a real cache failure`, () => {
    const cache = block(file, 'lake exe cache get');
    const plain = run(project(), cache);
    assert.equal(plain.status, 0); assert.match(plain.stdout, /Cache preflight not applicable/); assert.equal(plain.calls, '');
    const ok = run(project({ mathlib: true }), cache);
    assert.equal(ok.status, 0); assert.match(ok.calls, /^exe cache get$/m);
    const failed = run(project({ mathlib: true, behaviour: { exe_cache_get: ['offline', 7] } }), cache);
    assert.equal(failed.status, 7); assert.match(failed.stderr, /Lake cache preflight failed/);
    // Exact identity only: similar names or a library target called mathlib are not the Mathlib package.
    const lookalike = run(project({ lakefile: ['lakefile.lean', 'import Lake\nopen Lake DSL\npackage mathlib_utils\n'],
      manifest: { name: 'mathlib_utils', packages: [{ name: 'mathlib_utils' }] } }), cache);
    assert.equal(lookalike.status, 0); assert.equal(lookalike.calls, ''); assert.match(lookalike.stdout, /not applicable/);
    const libTarget = run(project({ lakefile: ['lakefile.toml', 'name = "demo"\n\n[[lean_lib]]\nname = "mathlib"\n'],
      manifest: { name: 'demo', packages: [] } }), cache);
    assert.equal(libTarget.status, 0); assert.equal(libTarget.calls, ''); assert.match(libTarget.stdout, /not applicable/);
    const root = run(project({ manifest: { name: 'mathlib', packages: [{ name: 'batteries' }] } }), cache);
    assert.equal(root.status, 0); assert.match(root.calls, /^exe cache get$/m);
  });

  it(`${file}: the selected-file gate keeps the real status and covers files outside the default build`, () => {
    const moduleGate = block(file, 'lake build "$SPEC_PATH"');
    const directGate = block(file, 'lake lean "$SPEC_PATH"');
    const good = run(project(), moduleGate);
    assert.match(good.stdout, /STATUS 0/); assert.match(good.calls, /^build Extra\/Broken\.lean$/m);
    const broken = run(project({ behaviour: { build_Extra_Broken_lean: ['error: Broken.lean:3: type mismatch', 1] } }), moduleGate);
    assert.match(broken.stdout, /STATUS 1 /, 'tail must not mask the build failure');
    // Outside every library: use the import-building direct check, not a default build or env alone.
    const outside = { build_Extra_Broken_lean: ['error: unknown target', 1], lean_Extra_Broken_lean: ['error: unsolved goals', 1] };
    assert.match(run(project({ behaviour: outside }), moduleGate).stdout, /unknown target/);
    const fallback = run(project({ behaviour: outside }), directGate);
    assert.match(fallback.stdout, /STATUS 1 /, 'tail must not hide a failed import build or direct check');
    assert.equal(fallback.calls, 'lean Extra/Broken.lean\n');
    const scoped = run(project({ behaviour: { build_Extra_Broken_lean: ['error: unknown target', 1] } }), directGate);
    assert.match(scoped.stdout, /STATUS 0 /, 'a correct proof outside default targets passes');
    const unsupported = run(project({ behaviour: { lean_Extra_Broken_lean: ['unknown command lean', 2] } }), directGate);
    assert.match(unsupported.stdout, /STATUS 2 /, 'an unsupported gate must fail rather than use stale artifacts');
  });

  it(`${file}: every pass reruns the recorded file gate and the session ends with a project build`, () => {
    const text = flat(file);
    assert.match(text, /runs the recorded FILE_GATE with `set -o pipefail` and uses its captured status/);
    assert.match(text, /Keep this import preparation in `FILE_GATE` on every pass/);
    assert.match(text, /After the last integrated batch, the parent serially reruns all affected file gates and the required project gate/);
    assert.doesNotMatch(text, /lake build 2>&1 \| tail -20/);
  });

  it(`${file}: the refactorer prompt carries the file gate and the helper and preservation rules`, () => {
    const text = flat(file);
    assert.match(text, /<file_gate>\$FILE_GATE<\/file_gate>/);
    assert.match(text, /A new public API or protected change requires a concrete proposal and approval first/);
    assert.match(text, /Apply Aeneas conventions only to Aeneas-extracted projects/);
  });
}

// Explicitly opt in with an installed, pinned Lake; ordinary npm test never acquires a toolchain.
const REAL_LAKE = process.env.FVS_REFACTOR_TEST_LAKE;
it('real Lake rebuilds non-default imports for the external-file gate on every pass',
  { skip: !REAL_LAKE }, t => {
    assert.ok(path.isAbsolute(REAL_LAKE), 'FVS_REFACTOR_TEST_LAKE must name an absolute installed Lake');
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-refactor-imports-')));
    for (const name of ['home', 'tmp', 'Other', 'Extra']) fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, 'lean-toolchain'), 'leanprover/lean4:v4.31.0\n');
    fs.writeFileSync(path.join(dir, 'lakefile.toml'), [
      'name = "refactor_gate"', 'defaultTargets = ["Main"]',
      '[[lean_lib]]', 'name = "Main"', '[[lean_lib]]', 'name = "Other"', ''].join('\n'));
    fs.writeFileSync(path.join(dir, 'Main.lean'), 'def mainValue : Nat := 0\n');
    fs.writeFileSync(path.join(dir, 'Other.lean'), 'import Other.Basic\n');
    const imported = path.join(dir, 'Other', 'Basic.lean');
    const proof = path.join(dir, 'Extra', 'Proof.lean');
    fs.writeFileSync(imported, 'def importedValue : Nat := 1\n');
    fs.writeFileSync(proof, 'import Other.Basic\nexample : importedValue = 1 := rfl\n');
    const env = { PATH: path.dirname(REAL_LAKE) + path.delimiter + '/usr/bin:/bin',
      HOME: path.join(dir, 'home'), TMPDIR: path.join(dir, 'tmp'), LEAN_NUM_THREADS: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
      LANG: 'C', LC_ALL: 'C', LAKE_NO_CACHE: '1' };
    const options = { cwd: dir, env, encoding: 'utf8', timeout: 60000 };
    const lake = args => spawnSync('nice', ['-n', '19', REAL_LAKE, '--no-cache', ...args], options);
    const success = r => assert.equal(r.status, 0, r.error?.message || r.stderr + r.stdout);
    const gates = SOURCES.map(file => block(file, 'lake lean "$SPEC_PATH"'));
    assert.ok(gates[0], 'the import-building direct gate must be present');
    assert.equal(gates[0], gates[1], 'command and workflow must use the same import-building gate');
    const gate = () => spawnSync('/bin/bash', ['-c',
      `SPEC_PATH=Extra/Proof.lean\n${gates[0]}\nexit "$FILE_GATE_STATUS"`],
      { cwd: dir, env, encoding: 'utf8', timeout: 60000 });
    const version = spawnSync('nice', ['-n', '19', REAL_LAKE, '--version'], options);
    success(version);
    assert.match(version.stdout, /Lean version 4\.31\.0/);
    success(lake(['build']));
    const artifact = path.join(dir, '.lake/build/lib/lean/Other/Basic.olean');
    assert.equal(fs.existsSync(artifact), false, 'the default build must leave the non-default import unbuilt');
    assert.notEqual(lake(['build', 'Extra/Proof.lean']).status, 0, 'the selected file must be outside library roots');
    assert.notEqual(lake(['env', 'lean', 'Extra/Proof.lean']).status, 0, 'raw direct check fails with a missing import');
    success(gate());
    const previous = fs.readFileSync(artifact);
    fs.writeFileSync(imported, 'def importedValue : Nat := 2\n');
    success(lake(['build']));
    assert.deepEqual(fs.readFileSync(artifact), previous, 'default build leaves the old import artifact');
    success(lake(['env', 'lean', 'Extra/Proof.lean'])); // Demonstrate the stale-artifact false positive.
    const stale = gate();
    assert.equal(stale.status, 1, stale.stderr + stale.stdout);
    assert.notDeepEqual(fs.readFileSync(artifact), previous, 'the recorded gate rebuilt the changed import');
    fs.writeFileSync(proof, 'import Other.Basic\nexample : importedValue = 2 := rfl\n');
    success(gate());
    t.diagnostic(`Real-Lake missing/stale-import fixture retained at ${dir}`);
  });

it('child roles state the file gate, helper boundary and conditional Funs.lean handling', () => {
  const refactorer = flat('agents/fvs-lean-refactorer.md');
  assert.match(refactorer, /ready for the parent file gate in `<file_gate>`/);
  assert.match(refactorer, /A new public declaration or protected change needs a concrete proposal and recorded approval/);
  const researcher = flat('agents/fvs-researcher.md');
  assert.match(researcher, /In an Aeneas project, locate the actual generated implementation through the supplied project evidence/);
  assert.match(researcher, /`Funs\.lean` is a convention, not a required filename/);
  assert.match(researcher, /Another generated filename, or an ordinary Lean project without Aeneas, is not a blocker/);
});
