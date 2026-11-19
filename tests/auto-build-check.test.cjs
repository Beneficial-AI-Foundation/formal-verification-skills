'use strict';

// The build check in a clean copy, run against a stub `lake` so no real Lean build happens.
// The stub records where it ran and what it saw, and prints whatever log the test hands it.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'fvs-build-check.mjs');
const LABEL = 'accepted (build check)';
const STANDARD = '[propext, Classical.choice, Quot.sound]';

const GUARD = (name, axioms = STANDARD) => `/-- ${axioms} -/\n#guard_msgs (whitespace := lax, substring := true) in\n#print axioms ${name}\n`;
const SPEC = `import Dep\n\nrecall Dep.foo : True\n\n${GUARD('Dep.foo')}`;

// The default target builds every module below Specs, as a real project's lakefile must say.
const LAKEFILE = (extra = '') => `name = "fixture"\ndefaultTargets = ["Specs"]\n\n[[lean_lib]]\nname = "Specs"\nglobs = ["Specs.+"]\n${extra}`;

const STUB_LAKE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "Lake version 5.0.0-stub"; exit 0; fi
if [ "$1" = build ] && [ "$2" = --no-build ]; then
  if [ -f "$STUB/preflight" ]; then cat "$STUB/preflight"; exit 3; fi
  exit 0
fi
if [ "$1" = build ]; then
  pwd > "$STUB/build-cwd"
  echo "$*" > "$STUB/build-args"
  echo "$LEAN_NUM_THREADS" > "$STUB/threads"
  if [ -f "$STUB/hang" ]; then
    echo $$ > "$STUB/lake-pid"
    sleep 60 &
    echo $! > "$STUB/child-pid"
    wait
  fi
  ls .lake/build > "$STUB/prebuild-listing" 2>&1
  cat Specs/A.lean > "$STUB/seen-A.lean" 2>/dev/null
  if [ -f "$STUB/oleans" ]; then
    while read -r m; do mkdir -p ".lake/build/lib/lean/$(dirname "$m")"; : > ".lake/build/lib/lean/$m.olean"; done < "$STUB/oleans"
  fi
  if [ -f "$STUB/build.out" ]; then cat "$STUB/build.out"; fi
  if [ -f "$STUB/status" ]; then exit "$(cat "$STUB/status")"; fi
  exit 0
fi
exit 9
`;

const sh = (cwd, file, args, env = {}) => {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) if (key.startsWith('GIT_')) delete clean[key];
  return spawnSync(file, args, { cwd, encoding: 'utf8', env: { ...clean, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...env } });
};
const git = (cwd, ...args) => {
  const run = sh(cwd, 'git', args);
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
};
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

// A git repository holding a Lean project (optionally one folder down) and a prebuilt package.
function fixture({ spec = SPEC, sub = '', files = {}, attributes = '', manifestExtra = [] } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-bc-')));
  const repo = path.join(base, 'repo');
  const lean = path.join(repo, sub);
  const stub = path.join(base, 'stub');
  const bin = path.join(base, 'bin');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(stub);
  write(path.join(bin, 'lake'), STUB_LAKE);
  fs.chmodSync(path.join(bin, 'lake'), 0o755);
  git(repo, 'init', '-q', '-b', 'main');
  const dep = path.join(lean, '.lake', 'packages', 'dep');
  write(path.join(dep, 'Dep.lean'), 'def Dep.x := 1\n');
  git(dep, 'init', '-q', '-b', 'main');
  git(dep, 'add', '-A');
  git(dep, 'commit', '-q', '-m', 'dep');
  const rev = git(dep, 'rev-parse', 'HEAD');
  write(path.join(repo, '.gitignore'), '.lake/\n');
  if (attributes) write(path.join(repo, '.gitattributes'), attributes);
  write(path.join(lean, 'lakefile.toml'), LAKEFILE());
  write(path.join(lean, 'lean-toolchain'), 'leanprover/lean4:v4.35.0\n');
  write(path.join(lean, 'lake-manifest.json'), JSON.stringify({ version: '1.1.0', packages: [{ type: 'git', name: 'dep', url: 'https://example.invalid/dep', rev, inputRev: 'main', configFile: 'lakefile.toml', inherited: false }, ...manifestExtra] }));
  write(path.join(lean, 'Specs', 'A.lean'), spec);
  for (const [name, text] of Object.entries(files)) write(path.join(lean, name), text);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'project');
  const commit = git(repo, 'rev-parse', 'HEAD');
  const receipts = path.join(base, 'receipts');
  const work = path.join(base, 'work');
  fs.mkdirSync(work);
  return { base, repo, lean, stub, bin, dep, rev, commit, receipts, work };
}

function check(fx, { args = [], root = fx.repo, commit = fx.commit, preflight, out, status, oleans = ['Specs/A'], env = {} } = {}) {
  if (preflight) write(path.join(fx.stub, 'preflight'), preflight);
  if (out) write(path.join(fx.stub, 'build.out'), out);
  if (status !== undefined) write(path.join(fx.stub, 'status'), String(status));
  write(path.join(fx.stub, 'oleans'), oleans.map((name) => `${name}\n`).join(''));
  const run = sh(fx.base, process.execPath, [SCRIPT, '--project-root', root, '--commit', commit, '--receipt-dir', fx.receipts, '--workdir', fx.work, ...args], { PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`, STUB: fx.stub, TMPDIR: fx.base, ...env });
  let json = null;
  try { json = JSON.parse(run.stdout); } catch { /* reported by the assertions */ }
  return { status: run.status, json, stdout: run.stdout, stderr: run.stderr };
}

const seen = (fx, name) => fs.readFileSync(path.join(fx.stub, name), 'utf8').trim();
const receipts = (fx) => (fs.existsSync(fx.receipts) ? fs.readdirSync(fx.receipts).filter((name) => name.endsWith('.json')) : []);
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const statementOf = (result, name) => result.json.specFiles.flatMap((file) => file.statements).find((s) => s.name === name);

describe('a build that passes', () => {
  test('is accepted, with the label, per-statement axioms and a receipt bound to the commit and tree', () => {
    const fx = fixture();
    const result = check(fx);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.accepted, true);
    assert.equal(result.json.label, LABEL);
    assert.equal(result.json.commit, fx.commit);
    assert.equal(result.json.tree, git(fx.repo, 'rev-parse', `${fx.commit}^{tree}`));
    assert.deepEqual(statementOf(result, 'Dep.foo').axioms, ['propext', 'Classical.choice', 'Quot.sound']);
    assert.equal(statementOf(result, 'Dep.foo').status, 'built');
    assert.match(result.stderr, /Dep\.foo: built; axioms: propext, Classical\.choice, Quot\.sound/);
    const receiptFile = path.join(fx.receipts, `${fx.commit}.json`);
    assert.equal(result.json.receipt, receiptFile);
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    assert.equal(receipt.kind, 'fvs-build-check');
    assert.equal(receipt.tree, result.json.tree);
    assert.equal(receipt.specFiles[0].sha256, sha256(SPEC));
    assert.equal(receipt.packages.revisions.dep, fx.rev);
    assert.equal(receipt.toolchain, 'leanprover/lean4:v4.35.0');
    assert.equal(receipt.build.logSha256, sha256(fs.readFileSync(receipt.build.log)));
  });

  test('builds with warnings as errors on two threads, in a copy outside the checkout, and removes the copy', () => {
    const fx = fixture();
    check(fx);
    assert.match(seen(fx, 'build-args'), /build --wfail --no-ansi/);
    assert.equal(seen(fx, 'threads'), '2');
    const where = seen(fx, 'build-cwd');
    assert.ok(where.startsWith(fx.work), `${where} is under the work directory`);
    assert.deepEqual(fs.readdirSync(fx.work), []);
  });

  test('keeps the copy on request', () => {
    const fx = fixture();
    check(fx, { args: ['--keep'] });
    assert.equal(fs.readdirSync(fx.work).length, 1);
  });

  test('builds the committed files, not the working tree, and never the author’s own build output', () => {
    const fx = fixture();
    write(path.join(fx.repo, 'Specs', 'A.lean'), 'import Dep\n-- edited after the commit\n');
    write(path.join(fx.repo, 'Specs', 'Untracked.lean'), `recall Dep.bar\n${GUARD('Dep.bar')}`);
    write(path.join(fx.lean, '.lake', 'build', 'lib', 'lean', 'Specs', 'A.olean'), 'stale');
    const result = check(fx);
    assert.equal(result.json.accepted, true);
    assert.equal(seen(fx, 'seen-A.lean'), SPEC.trim());
    assert.equal(result.json.specFiles.length, 1);
    assert.doesNotMatch(seen(fx, 'prebuild-listing'), /lib/);
  });

  test('leaves the author’s packages as they were', () => {
    const fx = fixture();
    const before = spawnSync('ls', ['-laR', fx.dep], { encoding: 'utf8' }).stdout;
    const result = check(fx);
    assert.equal(result.json.accepted, true);
    assert.equal(spawnSync('ls', ['-laR', fx.dep], { encoding: 'utf8' }).stdout, before);
    assert.equal(git(fx.dep, 'status', '--porcelain'), '');
  });

  test('reuses packages given with --packages', () => {
    const fx = fixture();
    const elsewhere = path.join(fx.base, 'packages');
    spawnSync('cp', ['-R', path.join(fx.lean, '.lake', 'packages'), elsewhere]);
    fs.rmSync(path.join(fx.lean, '.lake'), { recursive: true });
    const result = check(fx, { args: ['--packages', elsewhere] });
    assert.equal(result.json.accepted, true);
  });

  test('includes files marked export-ignore, as a build of the commit needs them', () => {
    const fx = fixture({ attributes: 'Specs/B.lean export-ignore\n', files: { 'Specs/B.lean': `recall Dep.bar\n${GUARD('Dep.bar')}` } });
    const result = check(fx, { oleans: ['Specs/A', 'Specs/B'] });
    assert.equal(result.json.accepted, true);
    assert.deepEqual(result.json.specFiles.map((file) => file.path), ['Specs/A.lean', 'Specs/B.lean']);
  });

  test('finds a Lean project one folder below the project root', () => {
    const fx = fixture({ sub: 'formal' });
    const result = check(fx, { root: fx.repo });
    assert.equal(result.json.accepted, true, JSON.stringify(result.json));
    assert.equal(result.json.leanRoot, 'formal');
    assert.equal(check(fx, { root: path.join(fx.repo, 'formal') }).json.accepted, true);
  });
});

describe('a build that does not pass', () => {
  test('a failing build is not accepted and the reason names the file and line', () => {
    const fx = fixture();
    const result = check(fx, { status: 1, oleans: [], out: 'error: Specs/A.lean:6:0: unsolved goals\nSome required targets logged failures:\n- Specs.A\n' });
    assert.equal(result.status, 1);
    assert.equal(result.json.accepted, false);
    assert.match(result.json.label, /^build check failed: Specs\/A\.lean:6: unsolved goals/);
    assert.equal(result.json.specFiles[0].status, 'failing');
    assert.match(statementOf(result, 'Dep.foo').reason, /Specs\/A\.lean:6/);
    assert.equal(receipts(fx).length, 1);
  });

  test('a build that runs past the time limit fails, and nothing it started is still running afterwards', () => {
    const fx = fixture();
    write(path.join(fx.stub, 'hang'), '');
    const result = check(fx, { args: ['--timeout', '1'], oleans: [] });
    assert.equal(result.status, 1);
    assert.equal(result.json.accepted, false);
    assert.match(result.json.label, /^build check failed: lake exited with status 124/);
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
    for (const name of ['lake-pid', 'child-pid']) {
      const pid = Number(seen(fx, name));
      // A killed process can linger briefly as a zombie until its parent reaps it.
      for (let wait = 0; wait < 40 && alive(pid); wait += 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      const running = alive(pid);
      if (running) process.kill(pid, 'SIGKILL');
      assert.equal(running, false, `${name} (${pid}) was still running after the check returned`);
    }
  });

  test('a sorry warning fails the build and is reported', () => {
    const fx = fixture();
    const result = check(fx, { status: 1, oleans: [], out: "warning: Specs/A.lean:3:0: declaration uses 'sorry'\n" });
    assert.equal(result.json.accepted, false);
    assert.match(result.json.label, /declaration uses 'sorry'/);
  });

  test('a statement that is fine is still failing when its file did not build, and says why', () => {
    const spec = `recall Dep.foo : True\n${GUARD('Dep.foo')}recall Dep.bar : True\n${GUARD('Dep.bar')}`;
    const result = check(fixture({ spec }), { status: 1, oleans: [], out: 'error: Specs/A.lean:11:0: guard mismatch\n' });
    assert.equal(statementOf(result, 'Dep.foo').status, 'failing');
    assert.match(statementOf(result, 'Dep.foo').reason, /its spec file did not build \(Specs\/A\.lean:11: guard mismatch\)/);
  });

  test('a message in a spec file fails the check even if Lake exited cleanly', () => {
    const fx = fixture();
    const result = check(fx, { status: 0, out: "warning: Specs/A.lean:3:0: declaration uses 'sorry'\n" });
    assert.equal(result.json.accepted, false);
    assert.match(result.json.label, /sorry/);
  });

  test('a spec file that was not built is not accepted', () => {
    const fx = fixture();
    const result = check(fx, { oleans: [] });
    assert.equal(result.json.accepted, false);
    assert.match(result.json.label, /not part of the build|was not built/);
  });

  test('a statement with no guard, an empty guard, a dropping guard or a sorryAx guard is not accepted', () => {
    const cases = {
      'no guard': ['import Dep\nrecall Dep.foo : True\n', /no #guard_msgs/],
      'empty guard': [`import Dep\nrecall Dep.foo : True\n${GUARD('Dep.foo', '')}`, /expects nothing/],
      'dropping guard': ['import Dep\nrecall Dep.foo : True\n/-- [propext] -/\n#guard_msgs (drop all) in\n#print axioms Dep.foo\n', /drops messages/],
      'sorryAx guard': [`import Dep\nrecall Dep.foo : True\n${GUARD('Dep.foo', '[propext, sorryAx]')}`, /sorryAx/],
      'no recall': [`import Dep\n${GUARD('Dep.foo')}`, /not restated with recall/],
      'no axiom list': [`import Dep\nrecall Dep.foo : True\n${GUARD('Dep.foo', 'fine')}`, /lists no axioms/],
    };
    for (const [name, [spec, reason]] of Object.entries(cases)) {
      const result = check(fixture({ spec }));
      assert.equal(result.json.accepted, false, name);
      assert.match(statementOf(result, 'Dep.foo').reason, reason, name);
      assert.match(result.json.label, /^build check failed:/, name);
    }
  });

  test('guards and recalls inside comments and strings are not counted', () => {
    const spec = `import Dep\n/-\nrecall Dep.foo : True\n${GUARD('Dep.foo')}\n-/\n-- recall Dep.bar : True\ndef s := "recall Dep.baz\\n#print axioms Dep.baz"\n`;
    const result = check(fixture({ spec }));
    assert.equal(result.json.accepted, false);
    assert.deepEqual(result.json.specFiles, []);
    assert.match(result.json.label, /no spec file restates a statement/);
  });

  test('a project with no spec files is not accepted', () => {
    const result = check(fixture({ spec: 'import Dep\ndef x := 1\n' }));
    assert.equal(result.json.accepted, false);
    assert.match(result.json.label, /no spec file/);
  });

  test('switching off the sorry warning in a source file is not accepted', () => {
    const spec = `import Dep\nset_option warn.sorry false\nrecall Dep.foo : True\n${GUARD('Dep.foo')}`;
    const result = check(fixture({ spec }));
    assert.equal(result.json.accepted, false);
    assert.match(result.json.label, /switches off the sorry warning/);
  });

  test('switching off the sorry warning in a lakefile option is not accepted, however it is written', () => {
    for (const option of ['moreLeanArgs = ["-Dwarn.sorry=false"]', 'leanOptions = { "warn.sorry" = false }']) {
      const lakefile = LAKEFILE(`${option}\n`);
      const result = check(fixture({ files: { 'lakefile.toml': lakefile } }));
      assert.equal(result.json.accepted, false, option);
      assert.match(result.json.label, /lakefile\.toml mentions warn\.sorry/, option);
    }
  });

  test('a symbolic link that leaves the commit for a Lean file or a Lean folder is not accepted', () => {
    const fx = fixture();
    write(path.join(fx.base, 'elsewhere', 'Extra.lean'), 'def y := 2\n');
    fs.symlinkSync(path.join(fx.base, 'elsewhere', 'Extra.lean'), path.join(fx.repo, 'Specs', 'Link.lean'));
    git(fx.repo, 'add', '-A');
    git(fx.repo, 'commit', '-q', '-m', 'link');
    const result = check(fx, { commit: git(fx.repo, 'rev-parse', 'HEAD') });
    assert.equal(result.json.accepted, false);
    assert.match(result.json.label, /lead out of the commit to a folder or a Lean file: Specs\/Link\.lean/);

    const folder = fixture();
    write(path.join(folder.base, 'elsewhere', 'Extra.lean'), 'def y := 2\n');
    fs.symlinkSync(path.join(folder.base, 'elsewhere'), path.join(folder.repo, 'Linked'));
    git(folder.repo, 'add', '-A');
    git(folder.repo, 'commit', '-q', '-m', 'link');
    const second = check(folder, { commit: git(folder.repo, 'rev-parse', 'HEAD') });
    assert.equal(second.json.accepted, false);
    assert.match(second.json.label, /Linked/);

    const chain = fixture();
    write(path.join(chain.base, 'elsewhere', 'data.txt'), 'x\n');
    fs.symlinkSync(path.join(chain.base, 'elsewhere'), path.join(chain.repo, 'second'));
    fs.symlinkSync('second', path.join(chain.repo, 'first'));
    git(chain.repo, 'add', '-A');
    git(chain.repo, 'commit', '-q', '-m', 'chain');
    const third = check(chain, { commit: git(chain.repo, 'rev-parse', 'HEAD') });
    assert.equal(third.json.accepted, false, 'a link to a link that leaves the commit is followed to its end');
    assert.match(third.json.label, /first, second|second, first/);
  });

  test('other symbolic links only warn, and links inside the commit are fine', () => {
    const fx = fixture({ files: { 'notes/readme.txt': 'x\n' } });
    fs.symlinkSync('/etc/hosts', path.join(fx.repo, 'notes', 'hosts'));
    fs.symlinkSync('/nonexistent/place', path.join(fx.repo, 'notes', 'dangling'));
    fs.symlinkSync('readme.txt', path.join(fx.repo, 'notes', 'inside'));
    fs.symlinkSync('../Specs', path.join(fx.repo, 'notes', 'specs'));
    git(fx.repo, 'add', '-A');
    git(fx.repo, 'commit', '-q', '-m', 'links');
    const result = check(fx, { commit: git(fx.repo, 'rev-parse', 'HEAD') });
    assert.equal(result.json.accepted, true, JSON.stringify(result.json.label));
    assert.equal(result.json.warnings.length, 1);
    assert.match(result.json.warnings[0], /lead out of the commit to files Lake does not read as Lean sources: notes\/hosts$/);
    assert.match(result.stderr, /^warning: symbolic links lead out/m);
  });
});

describe('what the check reports and flags', () => {
  test('flags native_decide and bv_decide axioms without failing the check', () => {
    const axioms = '[propext, Dep.foo._native.native_decide.ax_1_2, Dep.foo._native.bv_decide.ax_1_3]';
    const result = check(fixture({ spec: `import Dep\nrecall Dep.foo : True\n${GUARD('Dep.foo', axioms)}` }));
    assert.equal(result.json.accepted, true);
    assert.deepEqual(statementOf(result, 'Dep.foo').flags, ['native_decide', 'bv_decide']);
    assert.equal(result.json.flags.length, 1);
    assert.match(result.stderr, /flagged: native_decide, bv_decide/);
  });

  test('lists the axioms beyond the standard three that a statement rests on', () => {
    const result = check(fixture({ spec: `import Dep\nrecall Dep.foo : True\n${GUARD('Dep.foo', '[propext, RustAx.subtle]')}` }));
    assert.equal(result.json.accepted, true);
    assert.deepEqual(statementOf(result, 'Dep.foo').beyondStandard, ['RustAx.subtle']);
  });

  test('reads "does not depend on any axioms" as an empty list', () => {
    const result = check(fixture({ spec: `import Dep\nrecall Dep.foo : True\n${GUARD('Dep.foo', "'Dep.foo' does not depend on any axioms")}` }));
    assert.equal(result.json.accepted, true);
    assert.deepEqual(statementOf(result, 'Dep.foo').axioms, []);
  });

  test('reports each statement of several spec files', () => {
    const second = `recall Dep.bar : True\nrecall Dep.baz : True\n${GUARD('Dep.bar')}${GUARD('Dep.baz', '[propext]')}`;
    const fx = fixture({ files: { 'Specs/B.lean': second } });
    const result = check(fx, { oleans: ['Specs/A', 'Specs/B'], status: 1, out: 'error: Specs/B.lean:7:0: guard mismatch\n' });
    assert.equal(result.json.accepted, false);
    assert.equal(result.json.specFiles.find((f) => f.path === 'Specs/A.lean').status, 'built');
    const bar = statementOf(result, 'Dep.bar');
    const baz = statementOf(result, 'Dep.baz');
    assert.equal(bar.status, 'failing');
    assert.match(bar.reason, /its spec file did not build/);
    assert.equal(baz.status, 'failing');
    assert.match(baz.reason, /Specs\/B\.lean:7: guard mismatch/);
    assert.match(result.stderr, /Dep\.baz: failing \(.*guard mismatch\); claimed axioms, not confirmed: propext/);
    const lines = result.json.specFiles.find((f) => f.path === 'Specs/B.lean').statements;
    assert.equal(lines.length, 2);
  });
});

describe('refusals', () => {
  const refused = (fx, result, code) => {
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.code, code);
    assert.equal(receipts(fx).length, 0);
    assert.equal(fs.existsSync(fx.receipts), false, 'nothing was written for a refusal');
    assert.equal(fs.existsSync(path.join(fx.stub, 'build-cwd')), false, 'no build ran');
    assert.deepEqual(fs.readdirSync(fx.work), []);
  };

  test('a commit argument that is not a hexadecimal hash', () => {
    const fx = fixture();
    refused(fx, check(fx, { commit: 'HEAD' }), 'usage');
    refused(fx, check(fx, { commit: 'abc; rm -rf /' }), 'usage');
    refused(fx, check(fx, { commit: '--upload-pack=x' }), 'usage');
  });

  test('a commit that does not exist', () => {
    const fx = fixture();
    refused(fx, check(fx, { commit: 'deadbeef' }), 'commit-not-found');
  });

  test('a prebuilt package at another revision than the manifest', () => {
    const fx = fixture();
    write(path.join(fx.dep, 'More.lean'), 'x\n');
    git(fx.dep, 'add', '-A');
    git(fx.dep, 'commit', '-q', '-m', 'move');
    const result = check(fx);
    refused(fx, result, 'packages-differ');
    assert.match(result.json.message, /dep is at [0-9a-f]{12} .* needs [0-9a-f]{12}/);
  });

  test('a prebuilt package that is missing', () => {
    const fx = fixture();
    fs.rmSync(path.join(fx.lean, '.lake'), { recursive: true });
    refused(fx, check(fx), 'packages-missing');
  });

  test('a path dependency outside the commit', () => {
    const fx = fixture({ manifestExtra: [{ type: 'path', name: 'sibling', dir: '../outside', inherited: false, configFile: 'lakefile.toml' }] });
    refused(fx, check(fx), 'path-dependency-outside-tree');
  });

  test('a dependency Lake would rebuild, named, while the project’s own modules may be missing', () => {
    const fx = fixture();
    const result = check(fx, { preflight: 'error: target is out-of-date\nSome required targets logged failures:\n- Mathlib.Algebra.Foo\n- Specs.A\n' });
    refused(fx, result, 'dependencies-not-prebuilt');
    assert.match(result.json.message, /Mathlib\.Algebra\.Foo/);
    assert.doesNotMatch(result.json.message, /Specs\.A/);
    const ok = check(fixture(), { preflight: 'Some required targets logged failures:\n- Specs.A\n- Specs\n' });
    assert.equal(ok.json.accepted, true, JSON.stringify(ok.json));
  });

  test('a project with no Lean project in the commit', () => {
    const fx = fixture();
    git(fx.repo, 'rm', '-q', 'lakefile.toml');
    git(fx.repo, 'commit', '-q', '-m', 'no lakefile');
    refused(fx, check(fx, { commit: git(fx.repo, 'rev-parse', 'HEAD') }), 'no-lean-project');
  });

  test('a build check already running anywhere on the machine, but not a stale lock of a dead process', () => {
    const fx = fixture();
    const lock = path.join(fx.base, 'fvs-build-check.lock');
    write(path.join(lock, 'pid'), String(process.pid));
    refused(fx, check(fx, { args: ['--receipt-dir', path.join(fx.base, 'another-receipts')] }), 'build-check-running');
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
    write(path.join(lock, 'pid'), dead);
    assert.equal(check(fx).json.accepted, true);
    assert.equal(fs.existsSync(lock), false, 'the lock is released');
  });

  test('a prebuilt package whose tracked files were changed', () => {
    const fx = fixture();
    fs.appendFileSync(path.join(fx.dep, 'Dep.lean'), 'def Dep.edited := 2\n');
    const result = check(fx);
    refused(fx, result, 'packages-modified');
    assert.match(result.json.message, /dep .* modified tracked files/);
  });
});

describe('reading Lean source', () => {
  const load = () => import(pathToFileURL(SCRIPT).href);

  test('keeps docstrings, drops nested comments, line comments and strings', async () => {
    const { stripLean } = await load();
    const { code, docstrings } = stripLean('/- a /- b -/ c -/\nx -- y\n"s -/ \\" t"\n/-- d -/\nz\n');
    assert.deepEqual(docstrings, [' d ']);
    assert.equal(code.split('\n').length, 6);
    assert.doesNotMatch(code, /[abcst]\b/);
    assert.match(code, /z/);
  });

  test('pairs a recall with its guard by exact name', async () => {
    const { readSpecSource } = await load();
    const source = readSpecSource(`recall A.f\nrecall A.fg\n${GUARD('A.fg')}`);
    const f = source.statements.find((s) => s.name === 'A.f');
    const fg = source.statements.find((s) => s.name === 'A.fg');
    assert.match(f.problems.join(), /no #guard_msgs/);
    assert.deepEqual(fg.problems, []);
  });
});

// ---- the merged spec: what may change after it, and which files Lake builds ----------------------
//
// A synthetic project in the default layout (formal/specs/Defs, formal/specs/Specs, formal/trusted,
// formal/extraction, formal/proofs). It has the change kinds of a real proof pull request: guard blocks
// added, docstrings and prose edited, a statement reflowed, a new Trusted file for an accepted
// assumption, and proofs plus a new lemma file.

const FORMAL_LAKEFILE = 'name = "fixture"\ndefaultTargets = ["Formal"]\n\n[[lean_lib]]\nname = "Formal"\nglobs = ["formal.+"]\n';
const DEFS = (prose) => `import Dep\n\n/-! # Gaps: ${prose} -/\n\n/-- Division: ${prose}. -/\ndef Div : Prop := ∀ a b : Nat, b ≠ 0 → a / b = a / b\n`;
const SPEC_BASE = 'import Dep\n\n/-! Each `#print axioms` below has a pending guard. -/\n\nrecall Dep.foo (n : Nat) (h : 0 < n) :\n    n ≠ 0 ∧ Div\n\n#print axioms Dep.foo\n/- Axiom guard (pending): propext. -/\n';
const SPEC_HEAD = `import Dep\n\n/-! Each \`#print axioms\` below is checked by \`#guard_msgs\`. -/\n\nrecall Dep.foo (n : Nat)\n    (h : 0 < n) :\n    n ≠ 0 ∧ Div\n\n${GUARD('Dep.foo')}/- Axiom guard: propext, Classical.choice, Quot.sound. -/\n`;
const PROOF_BASE = 'import Dep\n\ntheorem Dep.foo (n : Nat) (h : 0 < n) : n ≠ 0 ∧ Div := by\n  sorry\n';
const PROOF_HEAD = 'import Dep\nimport formal.proofs.Lemmas.L\n\ntheorem Dep.foo (n : Nat) (h : 0 < n) : n ≠ 0 ∧ Div := by\n  exact ⟨by omega, helper⟩\n';
const TRUSTED_NEW = 'import Dep\n\nnamespace Gap\n\n/-- Accepted assumption, `gap-div` (owner ruling): division is division. -/\naxiom div_spec : Div\n\nend Gap\n';
const BASE_FILES = {
  'formal/specs/Defs/Gaps.lean': DEFS('open'), 'formal/specs/Specs/A.lean': SPEC_BASE, 'formal/proofs/A.lean': PROOF_BASE,
  'formal/trusted/Sha.lean': 'import Dep\n\n/-- Earlier trusted axiom. -/\naxiom sha_spec : True\n', 'formal/extraction/Ext.lean': 'def x := 1\n',
};
const HEAD_FILES = {
  'formal/specs/Defs/Gaps.lean': DEFS('accepted'), 'formal/specs/Specs/A.lean': SPEC_HEAD, 'formal/proofs/A.lean': PROOF_HEAD,
  'formal/proofs/Lemmas/L.lean': 'import Dep\n\ntheorem helper : True := trivial\n', 'formal/trusted/Gaps.lean': TRUSTED_NEW,
};
const OLEANS = ['formal/specs/Specs/A'];
const record = (fields = {}) => ({ id: 'gap-div', kind: 'external', source: { symbol: 'Nat.div', commit: 'c' }, model: { symbol: 'Gap.div_spec', sha256: '0'.repeat(64) },
  claimedBehaviour: 'division', reason: 'no model', affectedRoots: [], evidence: [], status: 'assumption-accepted', decision: { by: 'owner', at: '2026-11-18', evidence: 'ruling' }, ...fields });
const EXTERNALS = (...records) => ({ schema: 'fvs/auto-externals', schemaVersion: 1, records });

// Commits BASE_FILES (the merged spec), then the head files on top, and writes the run state.
// `merged` is the spec merge commit, `tip` the proof head.
// `sub` puts the Lean project in a folder of the repository, and `base` replaces the merged spec's files.
function layered({ head = HEAD_FILES, base = BASE_FILES, remove = [], lakefile = FORMAL_LAKEFILE, externals = EXTERNALS(record()), recorded = false, sub = '' } = {}) {
  const fx = fixture({ spec: 'import Dep\n', sub, files: { ...base, 'lakefile.toml': lakefile } });
  const merged = fx.commit;
  for (const [name, text] of Object.entries(head)) write(path.join(fx.lean, name), text);
  for (const name of remove) fs.rmSync(path.join(fx.lean, name));
  git(fx.repo, 'add', '-A');
  git(fx.repo, 'commit', '-q', '--allow-empty', '-m', 'proofs');
  const state = path.join(fx.repo, '.formalising', 'auto-fv');
  if (externals) write(path.join(state, 'externals.json'), JSON.stringify(externals));
  if (recorded) write(path.join(state, 'specs.json'), JSON.stringify({ schema: 'fvs/auto-specs', schemaVersion: 1, prs: [{ kind: 'spec', merged: true, mergeCommit: merged, recordedAt: '2026-11-17T00:00:00Z' }] }));
  return { ...fx, merged, tip: git(fx.repo, 'rev-parse', 'HEAD') };
}
const checkTip = (fx, options = {}) => check(fx, { commit: fx.tip, args: ['--spec-base', fx.merged], oleans: OLEANS, ...options });
const noBuild = (fx) => assert.equal(fs.existsSync(path.join(fx.stub, 'build-cwd')), false, 'no build ran');
const firstProblem = (result) => result.json.integrity.problems[0];
const library = () => import(pathToFileURL(SCRIPT).href);

describe('the merged spec: changes that are allowed', () => {
  test('guard blocks, docstring and prose edits, a reflowed statement, a new accepted Trusted file and proofs are accepted', () => {
    const fx = layered();
    const result = checkTip(fx);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.label, LABEL);
    assert.equal(result.json.specBase, fx.merged);
    assert.deepEqual(result.json.integrity.problems, []);
    assert.deepEqual(result.json.integrity.ties, [{ file: 'formal/trusted/Gaps.lean', axiom: 'div_spec', record: 'gap-div' }]);
    assert.match(result.stderr, /accepted assumption: axiom div_spec \(formal\/trusted\/Gaps\.lean\) is tied to externals record gap-div/);
    assert.match(result.stderr, new RegExp(`spec base ${fx.merged}`));
  });

  test('stdout holds the JSON result and nothing else; the report goes to stderr; the receipt keeps its place', () => {
    const fx = layered();
    const result = checkTip(fx);
    assert.equal(`${JSON.stringify(JSON.parse(result.stdout), null, 2)}\n`, result.stdout, 'stdout is exactly one JSON object');
    assert.equal(Object.hasOwn(result.json, 'report'), false);
    assert.equal(result.json.receipt, path.join(fx.receipts, `${fx.tip}.json`));
    assert.ok(fs.existsSync(result.json.receipt));
    assert.match(result.stderr, new RegExp(`^${LABEL.replace(/[()]/g, '\\$&')}\\ncommit ${fx.tip}`));
    assert.doesNotMatch(result.stdout, /spec base/);
    const refused = check(fx, { commit: 'deadbeef' });
    assert.equal(refused.json.code, 'commit-not-found');
    assert.match(refused.stderr, /refused \(commit-not-found\)/);
  });

  test('the recorded spec merge is used when no --spec-base is given', () => {
    const fx = layered({ recorded: true });
    const result = check(fx, { commit: fx.tip, oleans: OLEANS });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.specBase, fx.merged);
    assert.equal(result.json.integrity.compared, true);
  });

  test('without a spec base the statements are not compared, and the report says so', () => {
    const fx = layered();
    const result = check(fx, { commit: fx.tip, oleans: OLEANS });
    assert.equal(result.json.accepted, true, result.json.label);
    assert.equal(result.json.specBase, null);
    assert.equal(result.json.integrity.compared, false);
    assert.match(result.stderr, /not compared with a merged spec/);
  });
});

test('a guard added below an indented statement does not change the statement', async () => {
  const { checkIntegrity, memoryTree } = await library();
  const lake = 'defaultTargets = ["Foo"]\n[[lean_lib]]\nname = "Foo"\nglobs = ["Foo.+"]\n';
  const spec = (body) => memoryTree({ 'lakefile.toml': lake, 'Foo/S.lean': `namespace N\n  recall foo (n : Nat) :\n      n = n\n${body}end N\n` });
  const run = (body) => checkIntegrity({ base: spec('  #print axioms foo\n'), head: spec(body) }).problems;
  assert.deepEqual(run('  /-- [propext] -/\n  #guard_msgs in\n  #print axioms foo\n'), []);
  assert.equal(run('  #print axioms foo\n').length, 0);
  assert.equal(run('  #eval 1\n')[0].kind, 'statement-changed', 'in an indented layout a statement runs to the next line in column 0');
});

describe('the merged spec: changes that are refused', () => {
  // A refusal is a failed verdict: exit 1, a receipt that says not accepted, and no build.
  const refusedAs = (result, fx, kind, file, statement) => {
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.json.accepted, false);
    assert.match(result.json.label, /^build check failed: /);
    const problem = firstProblem(result);
    assert.equal(problem.kind, kind);
    assert.equal(problem.file, file);
    assert.equal(problem.statement, statement);
    assert.ok(result.json.label.includes(file), 'the label names the file');
    noBuild(fx);
    const receipt = JSON.parse(fs.readFileSync(path.join(fx.receipts, `${fx.tip}.json`), 'utf8'));
    assert.equal(receipt.accepted, false);
    assert.equal(receipt.build, null);
    assert.equal(receipt.integrity.problems[0].kind, kind);
  };

  test('a weakened hypothesis in a recalled statement', () => {
    const fx = layered({ head: { ...HEAD_FILES, 'formal/specs/Specs/A.lean': SPEC_HEAD.replace('(h : 0 < n)', '(h : 0 ≤ n)') } });
    const result = checkTip(fx);
    refusedAs(result, fx, 'statement-changed', 'formal/specs/Specs/A.lean', 'Dep.foo');
    assert.match(firstProblem(result).detail, /0 < n/);
    assert.match(firstProblem(result).detail, /0 ≤ n/);
  });

  test('a dropped hypothesis, a changed conclusion and a removed recall', () => {
    for (const [change, kind] of [[(t) => t.replace('(h : 0 < n)', ''), 'statement-changed'], [(t) => t.replace('n ≠ 0 ∧ Div', 'n ≠ 0'), 'statement-changed'],
      [(t) => t.replace(/recall[\s\S]*?Div\n/, ''), 'statement-removed']]) {
      const fx = layered({ head: { ...HEAD_FILES, 'formal/specs/Specs/A.lean': change(SPEC_HEAD) } });
      const result = checkTip(fx);
      assert.equal(result.json.accepted, false, kind);
      assert.equal(firstProblem(result).kind, kind);
    }
  });

  test('a changed Defs body, even with a docstring edit beside it', () => {
    const fx = layered({ head: { ...HEAD_FILES, 'formal/specs/Defs/Gaps.lean': DEFS('accepted').replace('b ≠ 0 → a / b', 'b ≠ 1 → a / b') } });
    refusedAs(checkTip(fx), fx, 'frozen-file-changed', 'formal/specs/Defs/Gaps.lean', 'Div');
  });

  test('a changed extraction file, a removed Trusted file, a changed lakefile and a new Defs file', () => {
    const cases = [[{ 'formal/extraction/Ext.lean': 'def x := 2\n' }, [], 'frozen-file-changed'], [{}, ['formal/trusted/Sha.lean'], 'frozen-file-removed'],
      [{ 'lakefile.toml': `${FORMAL_LAKEFILE}\n# note\n` }, [], 'frozen-file-changed'], [{ 'formal/specs/Defs/More.lean': 'def y := 1\n' }, [], 'frozen-file-added']];
    for (const [change, remove, kind] of cases) {
      const result = checkTip(layered({ head: { ...HEAD_FILES, ...change }, remove }));
      assert.equal(result.json.accepted, false, kind);
      assert.equal(firstProblem(result).kind, kind, JSON.stringify(change));
    }
  });

  test('comments and whitespace are free in a frozen file, and strings are compared with their contents', async () => {
    const { checkIntegrity, memoryTree } = await library();
    const file = 'formal/specs/Defs/K.lean';
    const run = (text) => checkIntegrity({ base: memoryTree({ [file]: 'def k : String := "ab"\n' }), head: memoryTree({ [file]: text }) }).problems;
    assert.equal(run('def k : String := "ab"\n').length, 0);
    assert.equal(run('def  k : String :=\n  "ab"   -- note\n').length, 0);
    assert.equal(run('/-- A docstring. -/\ndef k : String := "ab"\n#print axioms k\n').length, 0);
    assert.equal(run('def k : String := "ac"\n')[0].kind, 'frozen-file-changed');
    assert.equal(run('deffk : String := "ab"\n')[0].kind, 'frozen-file-changed');
  });

  test('a new Trusted axiom with no accepted externals record', () => {
    for (const externals of [null, EXTERNALS(), EXTERNALS(record({ status: 'open', decision: null })), EXTERNALS(record({ id: 'other' }))]) {
      const fx = layered({ externals });
      const result = checkTip(fx);
      refusedAs(result, fx, 'trusted-axiom-untied', 'formal/trusted/Gaps.lean', 'div_spec');
      assert.match(firstProblem(result).detail, /assumption-accepted/);
    }
  });

  test('a record ties one axiom only, and a new Trusted file holds nothing but axioms', () => {
    const twice = `${TRUSTED_NEW}\n/-- Same record, \`gap-div\`. -/\naxiom div_again : Div\n`;
    const fx = layered({ head: { ...HEAD_FILES, 'formal/trusted/Gaps.lean': twice } });
    assert.match(firstProblem(checkTip(fx)).detail, /already tied to axiom div_spec/);
    const other = layered({ head: { ...HEAD_FILES, 'formal/trusted/Gaps.lean': TRUSTED_NEW.replace('end Gap', 'def helper := 1\n\nend Gap') } });
    assert.equal(firstProblem(checkTip(other)).kind, 'trusted-file-extra-code');
  });

  test('an axiom outside Trusted, sorry, admit, native_decide and bv_decide that a proof adds', () => {
    const cases = [['axiom', 'axiom bad : False\n', 'bad'], ['sorry', 'theorem t : True := by sorry\n', 't'], ['admit', 'theorem t : True := by admit\n', 't'],
      ['native_decide', 'theorem t : 1 = 1 := by native_decide\n', 't'], ['bv_decide', 'theorem t : 1 = 1 := by bv_decide\n', 't']];
    for (const [token, line, name] of cases) {
      const fx = layered({ head: { ...HEAD_FILES, 'formal/proofs/Lemmas/L.lean': `import Dep\n${line}` } });
      const result = checkTip(fx);
      assert.equal(result.json.accepted, false, token);
      const problem = firstProblem(result);
      assert.deepEqual([problem.kind, problem.token, problem.file, problem.statement], ['forbidden-added', token, 'formal/proofs/Lemmas/L.lean', name], token);
      noBuild(fx);
    }
  });

  test('the same words in a comment, a docstring or a string are not additions', () => {
    const lemma = 'import Dep\n\n/-- Never `sorry`, `admit`, `native_decide` or `axiom`. -/\n-- sorry\ntheorem helper : "sorry" = "sorry" := rfl\n';
    const fx = layered({ head: { ...HEAD_FILES, 'formal/proofs/Lemmas/L.lean': lemma } });
    assert.equal(checkTip(fx).json.accepted, true);
  });

  test('a spec file added, or removed, since the merged spec', () => {
    const added = layered({ head: { ...HEAD_FILES, 'formal/specs/Specs/B.lean': 'import Dep\n\nrecall Dep.bar : True\n' } });
    assert.equal(firstProblem(checkTip(added)).kind, 'spec-file-added');
    assert.equal(firstProblem(checkTip(layered({ remove: ['formal/specs/Specs/A.lean'] }))).kind, 'spec-file-removed');
  });

  test('code outside the recalled statements that changes what they mean', () => {
    const fx = layered({ head: { ...HEAD_FILES, 'formal/specs/Specs/A.lean': SPEC_HEAD.replace('recall', 'local notation "Div" => False\n\nrecall') } });
    assert.equal(firstProblem(checkTip(fx)).kind, 'spec-code-changed');
  });

  test('a failed verdict replaces an accepted receipt that an earlier run left for the same commit', () => {
    const fx = layered({ head: { ...HEAD_FILES, 'formal/specs/Specs/A.lean': SPEC_HEAD.replace('0 < n', '0 ≤ n') } });
    assert.equal(check(fx, { commit: fx.tip, oleans: OLEANS }).json.accepted, true, 'with no spec base there is nothing to compare');
    const receiptFile = path.join(fx.receipts, `${fx.tip}.json`);
    assert.equal(JSON.parse(fs.readFileSync(receiptFile, 'utf8')).accepted, true);
    assert.equal(checkTip(fx).json.accepted, false);
    assert.equal(JSON.parse(fs.readFileSync(receiptFile, 'utf8')).accepted, false);
  });

  test('a lakefile added below the root does not hide the folder it sits in', () => {
    const sorryLemma = 'import Dep\ntheorem t : True := by sorry\n';
    const proofs = layered({ head: { ...HEAD_FILES, 'formal/proofs/lakefile.toml': 'name = "other"\n', 'formal/proofs/Lemmas/L.lean': sorryLemma } });
    const found = checkTip(proofs).json.integrity.problems.map((p) => [p.kind, p.file]);
    assert.deepEqual(found, [['forbidden-added', 'formal/proofs/Lemmas/L.lean'], ['frozen-file-added', 'formal/proofs/lakefile.toml']]);
    const trusted = layered({ head: { ...HEAD_FILES, 'formal/trusted/x/lakefile.toml': 'name = "other"\n', 'formal/trusted/x/Evil.lean': 'import Dep\naxiom evil : False\n' } });
    const result = checkTip(trusted);
    assert.equal(result.json.accepted, false);
    assert.ok(result.json.integrity.problems.some((p) => p.kind === 'frozen-file-added' && p.file === 'formal/trusted/x/lakefile.toml'));
    assert.ok(result.json.integrity.problems.some((p) => p.kind === 'trusted-axiom-untied' && p.statement === 'evil'), 'the axiom below it is still judged');
    noBuild(trusted);
  });

  test('a folder with a lakefile of its own in the merged spec stays out of the comparison', async () => {
    const { checkIntegrity, memoryTree } = await library();
    const lake = 'defaultTargets = ["Foo"]\n[[lean_lib]]\nname = "Foo"\nglobs = ["Foo.+"]\n';
    const tree = (other) => memoryTree({ 'lakefile.toml': lake, 'vendor/other/lakefile.toml': 'name = "other"\n', 'vendor/other/X.lean': other });
    assert.deepEqual(checkIntegrity({ base: tree('recall y : True\n'), head: tree('recall y : False\naxiom z : False\n') }).problems, [], 'another Lake project is not this project');
  });

  test('source that a naive reader would lose track of in does not hide a sorry', () => {
    const hidden = 'theorem t : True := by sorry\ndef u := "x"\n';
    for (const [name, prefix] of [['a raw string that ends in a backslash', 'def s := r"\\"\n'], ['an escaped quote as a character', "def c : Char := '\\\"'\n"], ['a raw string with hashes', 'def s := r#"a "quoted" b"#\n']]) {
      const fx = layered({ head: { ...HEAD_FILES, 'formal/proofs/Lemmas/L.lean': `import Dep\n${prefix}${hidden}` } });
      const problem = firstProblem(checkTip(fx));
      assert.deepEqual([problem?.kind, problem?.token, problem?.statement], ['forbidden-added', 'sorry', 't'], name);
    }
  });

  test('a prime inside an identifier does not start a character literal', async () => {
    const { stripLean } = await library();
    assert.match(stripLean("def a'b' := sorry\n").code, /sorry/);
    assert.match(stripLean("theorem t (h' : P) (k' : Q) : True := sorry\n").code, /sorry/);
    assert.doesNotMatch(stripLean("def c := 'a' ++ \"sorry\" ++ r\"sorry\"\n").code, /sorry/);
  });

  test('strings are compared exactly: spacing inside one counts, and text that looks like a guard is not removed', async () => {
    const { checkIntegrity, memoryTree } = await library();
    const file = 'formal/specs/Defs/K.lean';
    const run = (was, now) => checkIntegrity({ base: memoryTree({ [file]: `def k : String := ${was}\n` }), head: memoryTree({ [file]: `def k : String := ${now}\n` }) }).problems.map((p) => p.kind);
    assert.deepEqual(run('"a  b"', '"a b"'), ['frozen-file-changed']);
    assert.deepEqual(run('"#print axioms x"', '""'), ['frozen-file-changed']);
    assert.deepEqual(run('r"a  b"', 'r"a b"'), ['frozen-file-changed']);
    assert.deepEqual(run('"a  b"', '"a  b"   -- same'), []);
  });

  test('an axiom that starts a line is counted even when the comment reader would skip it', async () => {
    const { checkIntegrity, memoryTree } = await library();
    const lake = 'defaultTargets = ["Foo"]\n[[lean_lib]]\nname = "Foo"\nglobs = ["Foo.+"]\n';
    const tree = (files) => memoryTree({ 'lakefile.toml': lake, ...files });
    const added = checkIntegrity({ base: tree({ 'Foo/P.lean': 'def p := 1\n' }), head: tree({ 'Foo/P.lean': 'def p := 1\n/- never closed\naxiom bad : False\n' }) });
    assert.deepEqual(added.problems.map((p) => [p.kind, p.token, p.statement]), [['forbidden-added', 'axiom', 'bad']]);
    const trusted = checkIntegrity({ base: tree({ 'Foo/P.lean': 'def p := 1\n' }), head: tree({ 'Foo/P.lean': 'def p := 1\n', 'Foo/Trusted/T.lean': '/- never closed\n/-- `gap-div` -/\naxiom sneaky : False\n' }), externals: () => [record()] });
    assert.ok(trusted.problems.some((p) => p.kind === 'trusted-axiom-untied' && p.statement === 'sneaky'));
    const prose = checkIntegrity({ base: tree({ 'Foo/D.lean': '/-- Gaps. -/\ndef d := 1\n' }), head: tree({ 'Foo/D.lean': '/-- Gaps: one\naxiom per `Prop` is asserted. -/\ndef d := 1\n' }) });
    assert.deepEqual(prose.problems, [], 'docstring prose that starts a line with the word is not a declaration');
  });

  test('a project one folder below the repository root is compared by the same rules', () => {
    const fx = layered({ sub: 'proj' });
    const result = checkTip(fx);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.json.integrity.ties, [{ file: 'formal/trusted/Gaps.lean', axiom: 'div_spec', record: 'gap-div' }]);
    const weak = layered({ sub: 'proj', head: { ...HEAD_FILES, 'formal/specs/Specs/A.lean': SPEC_HEAD.replace('(h : 0 < n)', '(h : 0 ≤ n)') } });
    assert.equal(firstProblem(checkTip(weak)).kind, 'statement-changed');
    const frozen = layered({ sub: 'proj', head: { ...HEAD_FILES, 'formal/extraction/Ext.lean': 'def x := 2\n' } });
    assert.equal(firstProblem(checkTip(frozen)).kind, 'frozen-file-changed');
    const outside = layered({ sub: 'proj', lakefile: 'name = "fixture"\ndefaultTargets = ["Formal"]\n\n[[lean_lib]]\nname = "Formal"\nglobs = ["formal.specs.+"]\n' });
    assert.equal(firstProblem(checkTip(outside)).kind, 'not-covered-by-lean-lib');
  });
});

describe('extraction folders in a multi-crate run', () => {
  const LAYOUT = (...entries) => ({ folders: entries.filter((e) => e.endsWith('/')), files: entries.filter((e) => !e.endsWith('/')) });

  test('every folder whose name starts with Extraction is frozen, whatever follows it', async () => {
    const { isFrozen } = await library();
    for (const rel of ['formal/extraction/A.lean', 'Proj/Extraction/A.lean', 'formal/ExtractionCrates/Traits/A.lean', 'formal/extraction_hmac/A.lean']) assert.equal(isFrozen(rel), true, rel);
    for (const rel of ['formal/proofs/A.lean', 'formal/specs/Specs/A.lean', 'formal/extractions.lean']) assert.equal(isFrozen(rel), false, rel);
  });

  test('the publish folders and published files of the run state are frozen too', async () => {
    const { isFrozen, extractionLayout } = await library();
    const fx = layered({ sub: 'proj' });
    const state = { extraction: { run: {
      publication: [{ projectPath: path.join(fx.repo, 'proj', 'Out', 'Main.lean') }, { projectPath: 'proj/Out/translation.json' }],
      units: [{ crate: 'a', publishDir: 'proj/Lean/Traits/', publication: [{ projectPath: path.join(fx.repo, 'proj', 'Lean', 'Traits', 'T.lean') }] }, { crate: 'b', publishDir: 'proj/Lean/Hmac' },
        { crate: 'c', publishDir: 'elsewhere/Lean' }, { crate: 'd', publishDir: 'proj' }, { crate: 'e', publishDir: '../up' }, { crate: 'f' }],
    } } };
    const layout = extractionLayout(state, { root: fx.repo, top: fx.repo, prefix: 'proj' });
    assert.deepEqual(layout.folders, ['lean/traits/', 'lean/hmac/'], 'a folder outside the project, the project itself and a missing one are left out');
    assert.deepEqual(layout.files, ['out/main.lean', 'out/translation.json', 'lean/traits/t.lean']);
    assert.equal(isFrozen('Lean/Hmac/Out.lean', layout), true);
    assert.equal(isFrozen('Out/Main.lean', layout), true);
    assert.equal(isFrozen('Out/Other.lean', layout), false);
    assert.deepEqual(extractionLayout(null, { root: fx.repo, top: fx.repo, prefix: '' }), { folders: [], files: [] });
    assert.deepEqual(extractionLayout({ extraction: { run: { units: 'x', publication: 7 } } }, { root: fx.repo, top: fx.repo, prefix: '' }), { folders: [], files: [] });
  });

  test('a change or an addition in a publish folder is refused, and an unbuilt output file is named', async () => {
    const { checkIntegrity, memoryTree } = await library();
    const lake = 'defaultTargets = ["Foo"]\n[[lean_lib]]\nname = "Foo"\nglobs = ["Foo.+"]\n';
    const layout = LAYOUT('lean/traits/', 'lean/hmac/');
    const tree = (files) => memoryTree({ 'lakefile.toml': lake, ...files });
    const base = tree({ 'Lean/Traits/T.lean': 'def t := 1\n', 'Lean/Hmac/H.lean': 'def h := 1\n' });
    const run = (files) => checkIntegrity({ base, head: tree({ 'Lean/Traits/T.lean': 'def t := 1\n', 'Lean/Hmac/H.lean': 'def h := 1\n', ...files }), layout }).problems.map((p) => [p.kind, p.file]);
    assert.deepEqual(run({ 'Lean/Hmac/H.lean': 'def h := 2\n' }).filter(([kind]) => kind !== 'not-covered-by-lean-lib'), [['frozen-file-changed', 'Lean/Hmac/H.lean']]);
    assert.deepEqual(run({ 'Lean/Traits/More.lean': 'def m := 1\n' }).filter(([kind]) => kind !== 'not-covered-by-lean-lib'), [['frozen-file-added', 'Lean/Traits/More.lean']]);
    assert.deepEqual(run({ 'Lean/Hmac/H.lean': 'def  h := 1 -- note\n' }).filter(([kind]) => kind !== 'not-covered-by-lean-lib'), []);
    assert.ok(run({}).some(([kind, file]) => kind === 'not-covered-by-lean-lib' && file === 'Lean/Hmac/H.lean'), 'no glob reaches the output, so Lake would not compile it');
    assert.deepEqual(checkIntegrity({ base, head: base, layout: LAYOUT('lean/hmac/h.lean') }).problems.map((p) => p.file), ['Lean/Hmac/H.lean'], 'a published file is judged without its folder, and its sibling is not');
  });

  test('the build check reads the run state, so a changed unit output stops the check before any build', () => {
    const base = { ...BASE_FILES, 'formal/hmac/Out.lean': 'def out := 1\n', 'formal/traits/Out.lean': 'def out := 1\n' };
    const lakefile = 'name = "fixture"\ndefaultTargets = ["Formal"]\n\n[[lean_lib]]\nname = "Formal"\nglobs = ["formal.+"]\n';
    const state = JSON.stringify({ extraction: { run: { units: [{ crate: 'hmac', publishDir: 'formal/hmac' }, { crate: 'traits', publishDir: 'formal/traits' }] } } });
    const run = (head) => {
      const fx = layered({ base, head: { ...HEAD_FILES, ...head }, lakefile });
      write(path.join(fx.repo, '.formalising', 'auto-fv', 'state.json'), state);
      return [fx, checkTip(fx)];
    };
    const [, same] = run({});
    assert.equal(same.status, 0, same.stderr);
    const [fx, changed] = run({ 'formal/traits/Out.lean': 'def out := 2\n' });
    assert.equal(changed.status, 1);
    assert.equal(firstProblem(changed).kind, 'frozen-file-changed');
    assert.equal(firstProblem(changed).file, 'formal/traits/Out.lean');
    noBuild(fx);
    write(path.join(fx.repo, '.formalising', 'auto-fv', 'state.json'), '{ not json');
    assert.equal(check(fx, { commit: fx.tip, args: ['--spec-base', fx.merged], oleans: OLEANS }).json.code, 'run-state-unreadable');
  });
});

describe('the spec base itself', () => {
  test('refuses a --spec-base that is not the recorded spec merge', () => {
    const fx = layered({ recorded: true });
    const result = check(fx, { commit: fx.tip, args: ['--spec-base', fx.tip], oleans: OLEANS });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.json.code, 'spec-base-mismatch');
  });

  test('refuses a spec base that is not in the history of the commit, and one that does not exist', () => {
    const fx = layered();
    git(fx.repo, 'checkout', '-q', '--orphan', 'other');
    git(fx.repo, 'commit', '-q', '--allow-empty', '-m', 'unrelated');
    const unrelated = git(fx.repo, 'rev-parse', 'HEAD');
    assert.equal(check(fx, { commit: fx.tip, args: ['--spec-base', unrelated], oleans: OLEANS }).json.code, 'spec-base-not-ancestor');
    assert.equal(check(fx, { commit: fx.tip, args: ['--spec-base', 'deadbeefdeadbeef'], oleans: OLEANS }).json.code, 'spec-base-not-found');
    assert.equal(check(fx, { commit: fx.tip, args: ['--spec-base', 'zz'], oleans: OLEANS }).json.code, 'usage');
  });

  test('refuses a run state that cannot be read', () => {
    const fx = layered();
    write(path.join(fx.repo, '.formalising', 'auto-fv', 'specs.json'), '{ not json');
    assert.equal(check(fx, { commit: fx.tip, oleans: OLEANS }).json.code, 'run-state-unreadable');
  });

  test('the last merged spec pull request is the base', async () => {
    const { recordedSpecMerge } = await library();
    const prs = [{ kind: 'spec', merged: true, mergeCommit: 'a' }, { kind: 'proof', merged: true, mergeCommit: 'p' }, { kind: 'spec', merged: true, mergeCommit: 'b' }, { kind: 'spec', url: 'u', branch: 'b', head: 'h' }];
    assert.equal(recordedSpecMerge({ prs }), 'b');
    assert.equal(recordedSpecMerge({ prs: [] }), null);
    assert.equal(recordedSpecMerge(null), null);
  });
});

describe('files that no lean_lib glob reaches', () => {
  test('a spec file outside the globs is refused, naming the file and the globs, with or without a spec base', () => {
    const lakefile = 'name = "fixture"\ndefaultTargets = ["Proj"]\n\n[[lean_lib]]\nname = "Proj"\nglobs = ["Proj.+"]\n';
    const fx = layered({ lakefile, head: {} });
    for (const args of [[], ['--spec-base', fx.merged]]) {
      const result = check(fx, { commit: fx.tip, args, oleans: OLEANS });
      assert.equal(result.status, 1, result.stderr);
      const problem = result.json.integrity.problems.find((p) => p.file === 'formal/specs/Specs/A.lean');
      assert.equal(problem.kind, 'not-covered-by-lean-lib');
      assert.match(problem.detail, /Proj: Proj\.\+/);
      assert.match(result.json.label, /not covered by any lean_lib glob.*\(and 2 more\)$/, 'the label names the first file and counts the rest');
      assert.deepEqual(result.json.integrity.problems.map((p) => p.file), ['formal/extraction/Ext.lean', 'formal/proofs/A.lean', 'formal/specs/Specs/A.lean'], 'an extraction file is judged like a proof file');
      assert.match(result.stderr, /not accepted: not-covered-by-lean-lib: formal\/specs\/Specs\/A\.lean: .*Proj: Proj\.\+/);
      noBuild(fx);
    }
  });

  test('a proof file outside the globs is refused too, and an unrelated file is not judged', async () => {
    const { checkIntegrity, memoryTree } = await library();
    const lake = 'defaultTargets = ["Proj"]\n[[lean_lib]]\nname = "Proj"\nglobs = ["Proj.+"]\n';
    const { problems } = checkIntegrity({ base: null, head: memoryTree({ 'lakefile.toml': lake, 'Proj/Ok.lean': 'def a := 1\n', 'formal/proofs/P.lean': 'theorem p : True := trivial\n', 'tools/scratch.lean': 'def s := 1\n' }) });
    assert.deepEqual(problems.map((p) => [p.kind, p.file]), [['not-covered-by-lean-lib', 'formal/proofs/P.lean']]);
  });

  test('Lake glob forms: Foo is one module, Foo.+ its submodules, Foo.* the module and its submodules; default globs are the roots', async () => {
    const { checkIntegrity, memoryTree } = await library();
    const files = ['Foo', 'Foo.A', 'Foo.A.B', 'Bar'];
    const tree = (lakefile) => memoryTree({ 'lakefile.toml': lakefile, ...Object.fromEntries(files.map((m) => [`proofs/${m.replaceAll('.', '/')}.lean`, 'def a := 1\n'])) });
    const unbuilt = (globs) => checkIntegrity({ base: null, head: tree(`defaultTargets = ["Foo"]\n[[lean_lib]]\nname = "Foo"\nsrcDir = "proofs"\n${globs}\n`) })
      .problems.map((p) => p.file.replace(/^proofs\//, '').replace(/\.lean$/, '').replaceAll('/', '.')).sort();
    assert.deepEqual(unbuilt('globs = ["Foo.+"]'), ['Bar', 'Foo']);
    assert.deepEqual(unbuilt('globs = ["Foo.*"]'), ['Bar']);
    assert.deepEqual(unbuilt('globs = ["Foo"]'), ['Bar', 'Foo.A', 'Foo.A.B']);
    assert.deepEqual(unbuilt(''), ['Bar', 'Foo.A', 'Foo.A.B'], 'the default glob is the root, one module');
    assert.deepEqual(unbuilt('roots = ["Foo", "Bar"]'), ['Foo.A', 'Foo.A.B']);
    assert.deepEqual(unbuilt('globs = "Foo.*"'), ['Bar'], 'a single glob may be a string');
    assert.deepEqual(unbuilt('globs = [\n  "Foo.+", # the submodules\n  "Bar",\n]'), ['Foo']);
  });

  test('a module that a built module imports is built, so it is covered', async () => {
    const { checkIntegrity, memoryTree } = await library();
    const lake = 'defaultTargets = ["Foo"]\n[[lean_lib]]\nname = "Foo"\n';
    const unbuilt = (rootText) => checkIntegrity({ base: null, head: memoryTree({ 'lakefile.toml': lake, 'Foo.lean': rootText, 'Foo/Specs/A.lean': 'import Foo.Proofs.P\nrecall x : True\n',
      'Foo/Proofs/P.lean': 'import Foo.Proofs.Q\n', 'Foo/Proofs/Q.lean': 'def q := 1\n', 'Foo/Proofs/R.lean': 'def r := 1\n' }) }).problems.map((p) => p.file).sort();
    assert.deepEqual(unbuilt('import Foo.Specs.A\n'), ['Foo/Proofs/R.lean']);
    assert.deepEqual(unbuilt('-- import Foo.Specs.A\n'), ['Foo/Proofs/P.lean', 'Foo/Proofs/Q.lean', 'Foo/Proofs/R.lean', 'Foo/Specs/A.lean']);
  });

  test('no default target means a bare lake build builds nothing, so a spec file is refused', async () => {
    const { checkIntegrity, memoryTree } = await library();
    const { problems } = checkIntegrity({ base: null, head: memoryTree({ 'lakefile.toml': 'name = "x"\n[[lean_lib]]\nname = "Foo"\nglobs = ["Foo.+"]\n', 'Foo/A.lean': 'recall x : True\n' }) });
    assert.equal(problems.length, 1);
    assert.match(problems[0].detail, /no lean_lib is a default target/);
  });

  test('another Lake project below the root, and a lakefile.lean, are not judged', async () => {
    const { checkIntegrity, memoryTree } = await library();
    const lake = 'defaultTargets = ["Foo"]\n[[lean_lib]]\nname = "Foo"\nglobs = ["Foo.+"]\n';
    const nested = checkIntegrity({ base: null, head: memoryTree({ 'lakefile.toml': lake, 'sub/proofs/lakefile.toml': 'name = "other"\n', 'sub/proofs/X.lean': 'recall y : True\n' }) });
    assert.deepEqual(nested.problems, []);
    const dsl = checkIntegrity({ base: null, head: memoryTree({ 'lakefile.lean': 'import Lake\n', 'formal/proofs/P.lean': 'def p := 1\n' }) });
    assert.deepEqual(dsl.problems, [], 'a lakefile.lean is not read; the missing-olean check backs it up');
  });
});

// The real run: the spec merged in the libcrux-hmac rc2 run and the proof head that followed it. The
// range adds guard blocks and docstring and prose edits in the spec files, edits prose in Defs/Gaps.lean,
// and adds Trusted/CoreAllocGaps.lean under the owner's ruling. Both trees are read from git objects.
// The checkout is named by FVS_RC2_LIBCRUX_VERIFY, and the test is skipped when that is not set:
//   FVS_RC2_LIBCRUX_VERIFY=/path/to/libcrux-verify node --test tests/auto-build-check.test.cjs
// Nothing in the checkout is written. Its run state (.formalising/auto-fv), when present, is only read.
const REAL = {
  repo: process.env.FVS_RC2_LIBCRUX_VERIFY,
  base: '7a2cd67422e2fbe8b6923f69893d7dd7ecb8ae43',
  head: '09511814c181892b0c31da2084ace9a7874f356a',
};
const haveReal = Boolean(REAL.repo) && fs.existsSync(REAL.repo) && [REAL.base, REAL.head].every((sha) => sh(REAL.repo, 'git', ['--no-optional-locks', 'cat-file', '-e', `${sha}^{commit}`]).status === 0);
const GAP_IDS = ['gap-core-u32-wrapping-div', 'gap-core-u32-wrapping-rem', 'gap-alloc-vec-into-boxed-slice', 'gap-alloc-vec-truncate'];
const realRunState = (name) => {
  const file = path.join(REAL.repo, '.formalising', 'auto-fv', name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
};
// The run's own externals records when the checkout has them, else records of the same shape.
const realRecords = () => realRunState('externals.json')?.records ?? GAP_IDS.map((id) => record({ id }));

describe('the real libcrux-hmac rc2 range', { skip: haveReal ? false : 'FVS_RC2_LIBCRUX_VERIFY does not name a libcrux-verify checkout with the rc2 commits' }, () => {
  const load = async () => {
    const { gitTree, checkIntegrity, memoryTree, extractionLayout } = await library();
    const layout = extractionLayout(realRunState('state.json'), { root: REAL.repo, top: REAL.repo, prefix: '' });
    return { checkIntegrity, memoryTree, layout, base: gitTree(REAL.repo, REAL.base, '', layout), head: gitTree(REAL.repo, REAL.head, '', layout) };
  };

  test('the run state records the spec merge that is the base of the range', async (t) => {
    const specs = realRunState('specs.json');
    if (!specs) return t.skip('the checkout has no recorded specs.json');
    const { recordedSpecMerge } = await library();
    assert.equal(recordedSpecMerge({ prs: specs.prs.filter((pr) => pr.kind === 'spec') }), REAL.base);
  });

  test('is accepted: guard blocks, docstring and prose edits, and the Trusted file under the accepted ruling', async () => {
    const { checkIntegrity, base, head, layout } = await load();
    const records = realRecords();
    const { problems, ties } = checkIntegrity({ base, head, layout, externals: () => records });
    assert.deepEqual(problems, []);
    assert.deepEqual(ties.map((tie) => tie.record).sort(), [...GAP_IDS].sort());
    assert.ok(ties.every((tie) => tie.file === 'LibcruxHmac/Formal/Trusted/CoreAllocGaps.lean'));
  });

  test('is refused once a statement is weakened, a Defs body changes, or the ruling is missing', async () => {
    const { checkIntegrity, memoryTree, base, head, layout } = await load();
    const records = realRecords();
    const edit = (file, from, to) => { const copy = new Map(head); copy.set(file, memoryTree({ [file]: head.get(file).text().replace(from, to) }).get(file)); return copy; };
    const spec = 'LibcruxHmac/Formal/Specs/Specs/Hmac.lean';
    const weak = checkIntegrity({ base, head: edit(spec, '(h : U32.max < key.length ∨ U32.max < data.length)', '(h : U32.max < key.length)'), layout, externals: () => records });
    assert.deepEqual(weak.problems.map((p) => [p.kind, p.file, p.statement]), [['statement-changed', spec, 'hmac_panic']]);
    const defs = 'LibcruxHmac/Formal/Specs/Defs/Gaps.lean';
    const body = checkIntegrity({ base, head: edit(defs, 'b.val ≠ 0 → wrapping_div a b', 'b.val ≠ 1 → wrapping_div a b'), layout, externals: () => records });
    assert.deepEqual(body.problems.map((p) => [p.kind, p.file, p.statement]), [['frozen-file-changed', defs, 'U32WrappingDiv']]);
    const unruled = checkIntegrity({ base, head, layout, externals: () => [] });
    assert.deepEqual([...new Set(unruled.problems.map((p) => p.kind))], ['trusted-axiom-untied']);
    assert.equal(unruled.problems.length, 4);
  });

  test('is refused when the new axioms cite a record the owner has not accepted', async (t) => {
    const open = realRecords().find((record) => record.status !== 'assumption-accepted');
    if (!open) return t.skip('the checkout has no externals record that is still open');
    const { checkIntegrity, memoryTree, base, head, layout } = await load();
    const file = 'LibcruxHmac/Formal/Trusted/CoreAllocGaps.lean';
    const copy = new Map(head);
    copy.set(file, memoryTree({ [file]: head.get(file).text().replaceAll('gap-core-u32-wrapping-div', open.id) }).get(file));
    const { problems } = checkIntegrity({ base, head: copy, layout, externals: realRecords });
    assert.deepEqual(problems.map((p) => [p.kind, p.file]), [['trusted-axiom-untied', file]]);
  });
});
