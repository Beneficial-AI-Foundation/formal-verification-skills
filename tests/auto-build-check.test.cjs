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
  write(path.join(lean, 'lakefile.toml'), 'name = "fixture"\n\n[[lean_lib]]\nname = "Specs"\n');
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
  return { status: run.status, json, stderr: run.stderr };
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
    assert.match(result.json.report.join('\n'), /Dep\.foo: built; axioms: propext, Classical\.choice, Quot\.sound/);
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
      const lakefile = `name = "fixture"\n\n[[lean_lib]]\nname = "Specs"\n${option}\n`;
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
    assert.match(result.json.report.join('\n'), /^warning: symbolic links lead out/m);
  });
});

describe('what the check reports and flags', () => {
  test('flags native_decide and bv_decide axioms without failing the check', () => {
    const axioms = '[propext, Dep.foo._native.native_decide.ax_1_2, Dep.foo._native.bv_decide.ax_1_3]';
    const result = check(fixture({ spec: `import Dep\nrecall Dep.foo : True\n${GUARD('Dep.foo', axioms)}` }));
    assert.equal(result.json.accepted, true);
    assert.deepEqual(statementOf(result, 'Dep.foo').flags, ['native_decide', 'bv_decide']);
    assert.equal(result.json.flags.length, 1);
    assert.match(result.json.report.join('\n'), /flagged: native_decide, bv_decide/);
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
    assert.match(result.json.report.join('\n'), /Dep\.baz: failing \(.*guard mismatch\); claimed axioms, not confirmed: propext/);
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
