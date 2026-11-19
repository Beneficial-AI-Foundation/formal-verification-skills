'use strict';

// The build check in a clean copy, run against a stub `lake` so no real Lean build happens.
// The stub records where it ran and what it saw, and prints whatever log the test hands it.

const { after, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
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
side=head
case "$(pwd)" in */fvs-build-check-*/base|*/fvs-build-check-*/base/*) side=base;; esac
if [ "$1" = env ]; then
  pwd > "$STUB/dump-$side-cwd"
  echo "$LEAN_NUM_THREADS" > "$STUB/dump-$side-threads"
  cp "$5" "$STUB/dump-$side-args.json"
  exec "$NODE" "$STUB/dump.js" "$side" "$5"
fi
if [ "$1" = build ]; then
  tag=""
  if [ "$side" = base ]; then tag="base-"; fi
  pwd > "$STUB/\${tag}build-cwd"
  echo "$*" > "$STUB/\${tag}build-args"
  echo "$LEAN_NUM_THREADS" > "$STUB/\${tag}threads"
  if [ -f "$STUB/hang" ] && [ -z "$tag" ]; then
    echo $$ > "$STUB/lake-pid"
    sleep 60 &
    echo $! > "$STUB/child-pid"
    wait
  fi
  ls .lake/build > "$STUB/\${tag}prebuild-listing" 2>&1
  cat Specs/A.lean > "$STUB/\${tag}seen-A.lean" 2>/dev/null
  if [ -f "$STUB/\${tag}oleans" ] || [ -f "$STUB/oleans" ]; then
    list="$STUB/oleans"; if [ -f "$STUB/\${tag}oleans" ]; then list="$STUB/\${tag}oleans"; fi
    while read -r m; do
      if [ "$m" = "*" ]; then
        for f in $(find . -name '*.lean' -not -path './.lake/*'); do f="\${f#./}"; f="\${f%.lean}"; mkdir -p ".lake/build/lib/lean/$(dirname "$f")"; : > ".lake/build/lib/lean/$f.olean"; done
      else
        mkdir -p ".lake/build/lib/lean/$(dirname "$m")"; : > ".lake/build/lib/lean/$m.olean"
      fi
    done < "$list"
  fi
  if [ -f "$STUB/\${tag}build.out" ] || [ -f "$STUB/build.out" ]; then
    if [ -f "$STUB/\${tag}build.out" ]; then cat "$STUB/\${tag}build.out"; elif [ -z "$tag" ]; then cat "$STUB/build.out"; fi
  fi
  if [ -f "$STUB/\${tag}status" ]; then exit "$(cat "$STUB/\${tag}status")"; fi
  if [ -z "$tag" ] && [ -f "$STUB/status" ]; then exit "$(cat "$STUB/status")"; fi
  exit 0
fi
exit 9
`;

// What the stub prints for \`lake env lean --run Dump.lean args.json\`: a canned dump for the side when the
// test gives one, else a dump in which every recalled name is its own declaration resting on no axiom.
const STUB_DUMP = `const fs = require('node:fs');
const [side, argsFile] = process.argv.slice(2);
const stub = process.env.STUB;
if (fs.existsSync(stub + '/dump-' + side + '-fail')) { console.error('stub: the Lean program failed'); process.exit(Number(fs.readFileSync(stub + '/dump-' + side + '-fail', 'utf8')) || 1); }
if (fs.existsSync(stub + '/dump-' + side + '.jsonl')) { process.stdout.write(fs.readFileSync(stub + '/dump-' + side + '.jsonl')); process.exit(0); }
const args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
console.log(JSON.stringify({ toolchain: 'Lean (stub)', githash: 'stub' }));
for (const id of args.recalls) {
  console.log(JSON.stringify({ recall: id, matches: [id], rests: [{ n: id, axioms: [] }] }));
  console.log(JSON.stringify({ n: id, k: 'thm', m: 'Stub', lp: [], t: 'stub statement', d: [] }));
}
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
function fixture({ spec = SPEC, sub = '', files = {}, attributes = '', manifestExtra = [], dsl = false } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-bc-')));
  const repo = path.join(base, 'repo');
  const lean = path.join(repo, sub);
  const stub = path.join(base, 'stub');
  const bin = path.join(base, 'bin');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(stub);
  write(path.join(bin, 'lake'), STUB_LAKE);
  write(path.join(stub, 'dump.js'), STUB_DUMP);
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
  if (!dsl) write(path.join(lean, 'lakefile.toml'), LAKEFILE());
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

// A check with no --spec-base given is held to the commit itself, so these tests ask for the checks they
// are about; `noBase` runs the check with no spec base at all.
function check(fx, { args = [], root = fx.repo, commit = fx.commit, noBase = false, preflight, out, status, oleans = ['Specs/A'], baseOleans, baseStatus, baseOut, dump = {}, dumpFail = {}, env = {} } = {}) {
  if (!noBase && !args.includes('--spec-base') && /^[0-9a-f]{7,64}$/i.test(commit)) args = ['--spec-base', commit, ...args];
  if (preflight) write(path.join(fx.stub, 'preflight'), preflight);
  if (out) write(path.join(fx.stub, 'build.out'), out);
  if (baseOut) write(path.join(fx.stub, 'base-build.out'), baseOut);
  if (status !== undefined) write(path.join(fx.stub, 'status'), String(status));
  if (baseStatus !== undefined) write(path.join(fx.stub, 'base-status'), String(baseStatus));
  const listed = (names) => (names === 'all' ? '*\n' : names.map((name) => `${name}\n`).join(''));
  write(path.join(fx.stub, 'oleans'), listed(oleans));
  if (baseOleans) write(path.join(fx.stub, 'base-oleans'), listed(baseOleans));
  for (const side of ['head', 'base']) {
    if (dump[side] !== undefined) write(path.join(fx.stub, `dump-${side}.jsonl`), dump[side]);
    if (dumpFail[side] !== undefined) write(path.join(fx.stub, `dump-${side}-fail`), String(dumpFail[side]));
  }
  const run = sh(fx.base, process.execPath, [SCRIPT, '--project-root', root, '--commit', commit, '--receipt-dir', fx.receipts, '--workdir', fx.work, ...args], { PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`, STUB: fx.stub, NODE: process.execPath, TMPDIR: fx.base, ...env });
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
  // A refusal before the check is admitted (a bad argument, an unknown commit, a lock that is taken)
  // writes nothing. One after it leaves a non-accepting receipt for the commit, so an earlier accepting
  // receipt cannot stand in for a check that was refused.
  const refused = (fx, result, code, { writes = true, commit = fx.commit } = {}) => {
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.code, code);
    assert.equal(fs.existsSync(path.join(fx.stub, 'build-cwd')), false, 'no build ran');
    assert.deepEqual(fs.readdirSync(fx.work), []);
    if (!writes) {
      assert.equal(receipts(fx).length, 0);
      assert.equal(fs.existsSync(fx.receipts), false, 'nothing was written for a refusal before admission');
      return;
    }
    assert.deepEqual(receipts(fx), [`${commit}.json`]);
    const receipt = JSON.parse(fs.readFileSync(path.join(fx.receipts, `${commit}.json`), 'utf8'));
    assert.equal(receipt.accepted, false);
    assert.deepEqual(receipt.refusal.code, code);
    assert.match(receipt.label, new RegExp(`^build check refused \\(${code}\\): `));
    assert.equal(result.json.receipt, path.join(fx.receipts, `${commit}.json`));
  };

  test('a commit argument that is not a hexadecimal hash', () => {
    const fx = fixture();
    refused(fx, check(fx, { commit: 'HEAD' }), 'usage', { writes: false });
    refused(fx, check(fx, { commit: 'abc; rm -rf /' }), 'usage', { writes: false });
    refused(fx, check(fx, { commit: '--upload-pack=x' }), 'usage', { writes: false });
  });

  test('a commit that does not exist', () => {
    const fx = fixture();
    refused(fx, check(fx, { commit: 'deadbeef' }), 'commit-not-found', { writes: false });
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
    const commit = git(fx.repo, 'rev-parse', 'HEAD');
    refused(fx, check(fx, { commit }), 'no-lean-project', { commit });
  });

  test('a build check already running anywhere on the machine, but not a stale lock of a dead process', () => {
    const fx = fixture();
    const lock = path.join(fx.base, 'fvs-build-check.lock');
    write(path.join(lock, 'pid'), String(process.pid));
    refused(fx, check(fx, { args: ['--receipt-dir', path.join(fx.base, 'another-receipts')] }), 'build-check-running', { writes: false });
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

describe('a check that is refused or does not finish leaves no accepting receipt', () => {
  const left = (fx, commit) => JSON.parse(fs.readFileSync(path.join(fx.receipts, `${commit}.json`), 'utf8'));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

  test('a recheck refused after an acceptance replaces the acceptance: the externals it needs became unreadable', () => {
    const fx = layered();
    const first = checkTip(fx);
    assert.equal(first.json.accepted, true, first.stderr);
    assert.equal(left(fx, fx.tip).accepted, true);
    write(path.join(fx.repo, '.formalising', 'auto-fv', 'externals.json'), '{not json');
    const again = checkTip(fx);
    assert.equal(again.status, 2);
    assert.equal(again.json.code, 'run-state-unreadable');
    assert.equal(again.json.receipt, path.join(fx.receipts, `${fx.tip}.json`));
    const receipt = left(fx, fx.tip);
    assert.equal(receipt.accepted, false);
    assert.deepEqual(receipt.refusal.code, 'run-state-unreadable');
    assert.match(receipt.label, /^build check refused \(run-state-unreadable\): /);
    // Repairing the file and checking again accepts again, and the receipt is the new verdict.
    write(path.join(fx.repo, '.formalising', 'auto-fv', 'externals.json'), JSON.stringify(EXTERNALS(record())));
    assert.equal(checkTip(fx).json.accepted, true);
    assert.equal(left(fx, fx.tip).accepted, true);
  });

  test('a spec base that is not the recorded merge refuses and leaves a non-accepting receipt as well', () => {
    const fx = layered({ recorded: true });
    assert.equal(check(fx, { commit: fx.tip, oleans: OLEANS, noBase: true }).json.accepted, true);
    const result = check(fx, { commit: fx.tip, args: ['--spec-base', fx.tip], oleans: OLEANS });
    assert.equal(result.json.code, 'spec-base-mismatch');
    assert.equal(left(fx, fx.tip).accepted, false);
    assert.equal(left(fx, fx.tip).refusal.code, 'spec-base-mismatch');
  });

  test('a check that dies while it builds leaves a receipt that is not an acceptance', async () => {
    const fx = layered();
    assert.equal(checkTip(fx).json.accepted, true);
    write(path.join(fx.stub, 'hang'), '');
    const child = spawn(process.execPath, [SCRIPT, '--project-root', fx.repo, '--commit', fx.tip, '--spec-base', fx.merged, '--receipt-dir', fx.receipts, '--workdir', fx.work],
      { env: { ...process.env, PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`, STUB: fx.stub, TMPDIR: fx.base }, stdio: 'ignore' });
    const pidFile = path.join(fx.stub, 'lake-pid');
    for (let wait = 0; wait < 200 && !fs.existsSync(pidFile); wait += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(fs.existsSync(pidFile), 'the build started');
    child.kill('SIGKILL');
    await once(child, 'exit');
    const receipt = left(fx, fx.tip);
    assert.equal(receipt.accepted, false, 'the old acceptance does not stand in for a check that did not finish');
    assert.match(receipt.label, /^build check failed: the check started and did not finish/);
    for (const name of ['lake-pid', 'child-pid']) { try { process.kill(Number(seen(fx, name)), 'SIGKILL'); } catch { /* gone already */ } }
    for (let wait = 0; wait < 40 && alive(Number(seen(fx, 'lake-pid'))); wait += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  });

  test('a caller that is refused the lock does not change the receipt of a finished check', () => {
    const fx = layered();
    assert.equal(checkTip(fx).json.accepted, true);
    const before = fs.readFileSync(path.join(fx.receipts, `${fx.tip}.json`), 'utf8');
    write(path.join(fx.base, 'fvs-build-check.lock', 'pid'), String(process.pid));
    const busy = checkTip(fx);
    assert.equal(busy.json.code, 'build-check-running');
    assert.equal(Object.hasOwn(busy.json, 'receipt'), false);
    assert.equal(fs.readFileSync(path.join(fx.receipts, `${fx.tip}.json`), 'utf8'), before);
  });

  test('the receipt binds a digest of each externals record the acceptance relied on', async () => {
    const { recordDigest } = await library();
    const fx = layered();
    const result = checkTip(fx);
    assert.deepEqual(result.json.externals.records, [{ id: 'gap-div', sha256: recordDigest(record()) }]);
    assert.equal(result.json.externals.sha256, sha256(fs.readFileSync(path.join(fx.repo, '.formalising', 'auto-fv', 'externals.json'))));
    assert.equal(recordDigest(Object.fromEntries(Object.entries(record()).reverse())), recordDigest(record()), 'key order does not change a digest');
    assert.notEqual(recordDigest(record({ status: 'open' })), recordDigest(record()));
    // A check that relied on no record lists none, and a failed integrity receipt carries the binding too.
    assert.deepEqual(check(fixture()).json.externals, { file: null, sha256: null, records: [] });
    const failing = layered({ head: { ...HEAD_FILES, 'formal/specs/Specs/A.lean': SPEC_HEAD.replace('0 < n', '0 ≤ n') } });
    assert.ok(Array.isArray(checkTip(failing).json.externals.records));
  });
});

describe('running the script', () => {
  test('imported, or read from stdin, it does not run and does not fail', () => {
    const stdin = spawnSync(process.execPath, ['--input-type=module', '-'], { input: fs.readFileSync(SCRIPT), encoding: 'utf8' });
    assert.equal(stdin.status, 0, stdin.stderr);
    assert.equal(stdin.stdout, '');
    assert.equal(stdin.stderr, '');
    const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(SCRIPT).href)})`], { encoding: 'utf8' });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout, '');
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
const OLEANS = 'all';
const record = (fields = {}) => ({ id: 'gap-div', kind: 'external', source: { symbol: 'Nat.div', commit: 'c' }, model: { symbol: 'Gap.div_spec', sha256: '0'.repeat(64) },
  claimedBehaviour: 'division', reason: 'no model', affectedRoots: [], evidence: [], status: 'assumption-accepted', decision: { by: 'owner', at: '2026-11-18', evidence: 'ruling' }, ...fields });
const EXTERNALS = (...records) => ({ schema: 'fvs/auto-externals', schemaVersion: 1, records });

// Commits BASE_FILES (the merged spec), then the head files on top, and writes the run state.
// `merged` is the spec merge commit, `tip` the proof head.
// `sub` puts the Lean project in a folder of the repository, and `base` replaces the merged spec's files.
function layered({ head = HEAD_FILES, base = BASE_FILES, remove = [], lakefile = FORMAL_LAKEFILE, externals = EXTERNALS(record()), recorded = false, sub = '', dsl = false } = {}) {
  const fx = fixture({ spec: 'import Dep\n', sub, dsl, files: { ...base, ...(dsl ? { 'lakefile.lean': 'import Lake\nopen Lake DSL\n\npackage fixture\n' } : { 'lakefile.toml': lakefile }) } });
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
    const result = check(fx, { commit: fx.tip, oleans: OLEANS, noBase: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.specBase, fx.merged);
    assert.equal(result.json.integrity.compared, true);
  });

  test('without a spec base a build is not an acceptance: its own label, a non-zero exit, and the report says why', () => {
    const fx = layered();
    const result = check(fx, { commit: fx.tip, oleans: OLEANS, noBase: true });
    assert.equal(result.json.accepted, false);
    assert.equal(result.json.label, 'built, integrity not checked');
    assert.equal(result.json.code, 'unchecked');
    assert.equal(result.status, 1, 'exit 0 is only for an acceptance');
    assert.equal(result.json.specBase, null);
    assert.equal(result.json.integrity.compared, false);
    assert.match(result.stderr, /^built, integrity not checked\n/);
    assert.match(result.stderr, /not compared with a merged spec and this is not an acceptance/);
    assert.doesNotMatch(result.stderr, /accepted \(build check\)/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(fx.receipts, `${fx.tip}.json`), 'utf8')).accepted, false);
    // A build that fails still says it failed, base or no base.
    const failing = check(fx, { commit: fx.tip, oleans: [], noBase: true, status: 1, out: 'error: Specs/A.lean:6:0: unsolved goals\n' });
    assert.match(failing.json.label, /^build check failed: Specs\/A\.lean:6/);
    assert.equal(failing.json.code, 'failed');
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

  test('comments, docstrings and guards are free in a frozen file; spacing, indentation and strings are not', async () => {
    const { checkIntegrity, memoryTree } = await library();
    const file = 'formal/specs/Defs/K.lean';
    const run = (text) => checkIntegrity({ base: memoryTree({ [file]: 'def k : String := "ab"\n' }), head: memoryTree({ [file]: text }) }).problems;
    assert.equal(run('def k : String := "ab"\n').length, 0);
    assert.equal(run('def k : String := "ab"   -- note\n').length, 0, 'a trailing comment');
    assert.equal(run('/- header -/\n-- a line\ndef k : String := "ab"\n\n/- end -/\n').length, 0, 'comment lines and blank lines');
    assert.equal(run('/-- A docstring. -/\ndef k : String := "ab"\n#print axioms k\n').length, 0, 'a docstring and a guard');
    assert.equal(run('def k : String := "ac"\n')[0].kind, 'frozen-file-changed');
    assert.equal(run('deffk : String := "ab"\n')[0].kind, 'frozen-file-changed');
    assert.equal(run('def  k : String := "ab"\n')[0].kind, 'frozen-file-changed', 'spacing between tokens counts');
    assert.equal(run('def k : String :=\n  "ab"\n')[0].kind, 'frozen-file-changed', 'a reflowed line counts');
  });

  test('a comment is a token boundary: P/- c -/Q is not the identifier PQ, in a frozen file or in a statement', async () => {
    const { checkIntegrity, memoryTree } = await library();
    const frozen = 'formal/specs/Defs/K.lean';
    const inFrozen = (was, now) => checkIntegrity({ base: memoryTree({ [frozen]: was }), head: memoryTree({ [frozen]: now }) }).problems.map((p) => p.kind);
    assert.deepEqual(inFrozen('def a := f x\n', 'def a := f/- sep -/x\n'), ['frozen-file-changed'], 'a comment inside a line counts by its width, as the spaces it replaces');
    assert.deepEqual(inFrozen('def a := f x -- one\n', 'def a := f x -- another\n'), [], 'a comment at the end of a line is free');
    assert.deepEqual(inFrozen('def a := f/- sep -/x\n', 'def a := fx\n'), ['frozen-file-changed'], 'deleting the comment joins two tokens into one identifier');
    assert.deepEqual(inFrozen('def a := fx\n', 'def a := f/- sep -/x\n'), ['frozen-file-changed']);
    const spec = 'formal/specs/Specs/S.lean';
    const inSpec = (was, now) => checkIntegrity({ base: memoryTree({ [spec]: `recall Dep.foo : ${was}\n` }), head: memoryTree({ [spec]: `recall Dep.foo : ${now}\n` }) }).problems.map((p) => [p.kind, p.statement]);
    assert.deepEqual(inSpec('P Q', 'P/- sep -/Q'), []);
    assert.deepEqual(inSpec('P/- sep -/Q', 'PQ'), [['statement-changed', 'Dep.foo']]);
    assert.deepEqual(inSpec('PQ', 'P/- sep -/Q'), [['statement-changed', 'Dep.foo']]);
  });

  test('indentation is part of a frozen file: an assignment moved into a do branch is a change', async () => {
    const { checkIntegrity, memoryTree } = await library();
    const file = 'formal/extraction/F.lean';
    const program = (indent) => `def f (c : Bool) : Id Nat := do\n  let mut x := 0\n  if c then\n    x := 1\n${indent}x := 2\n  return x\n`;
    const run = (now) => checkIntegrity({ base: memoryTree({ [file]: program('  ') }), head: memoryTree({ [file]: now }) }).problems.map((p) => [p.kind, p.file]);
    assert.deepEqual(run(program('  ')), []);
    assert.deepEqual(run(program('    ')), [['frozen-file-changed', file]], 'the same tokens, another program');
    assert.deepEqual(run(`${program('  ')}\n-- a trailing note\n`), []);
  });

  test('a recalled statement may be reflowed; the code around it may not', async () => {
    const { checkIntegrity, memoryTree } = await library();
    const spec = 'formal/specs/Specs/S.lean';
    const run = (was, now) => checkIntegrity({ base: memoryTree({ [spec]: was }), head: memoryTree({ [spec]: now }) }).problems.map((p) => p.kind);
    const base = 'import Dep\n\nrecall Dep.foo (n : Nat) (h : 0 < n) :\n    n ≠ 0\n\ndef k := 1\n';
    assert.deepEqual(run(base, 'import Dep\n\nrecall Dep.foo (n : Nat)\n  (h : 0 < n)\n  : n ≠ 0 -- reflowed\n\ndef k := 1\n'), []);
    assert.deepEqual(run(base, base.replace('def k := 1', 'def k :=  1')), ['spec-code-changed'], 'spacing outside a statement counts');
    assert.deepEqual(run(base, base.replace('n ≠ 0', 'n ≠ 1')), ['statement-changed']);
  });

  test('an axiom is identified by its name and its type, not counted: swapping one for another is an addition', async () => {
    const { checkIntegrity, memoryTree } = await library();
    const file = 'formal/proofs/P.lean';
    const run = (was, now) => checkIntegrity({ base: memoryTree({ [file]: was }), head: memoryTree({ [file]: now }) }).problems.map((p) => [p.kind, p.token, p.statement]);
    const harmless = 'import Dep\n\naxiom harmless : True\n';
    assert.deepEqual(run(harmless, harmless.replace('import Dep\n', 'import Dep\n-- reflowed\n')), [], 'the same axiom stays');
    assert.deepEqual(run(harmless, 'import Dep\n\naxiom escape : False\n'), [['forbidden-added', 'axiom', 'escape']], 'equal count, another axiom');
    assert.deepEqual(run(harmless, 'import Dep\n\naxiom harmless : False\n'), [['forbidden-added', 'axiom', 'harmless']], 'the same name with a stronger type');
    assert.deepEqual(run(harmless, `${harmless}axiom harmless : True\n`).length, 1, 'a second copy is an addition');
    const aeneas = 'axiom\n  core.f\n  : Result Nat\n';
    assert.deepEqual(run(aeneas, aeneas), [], 'an axiom with its name on the next line');
    assert.deepEqual(run(aeneas, aeneas.replace('Result Nat', 'False')), [['forbidden-added', 'axiom', 'core.f']]);
  });

  test('a forbidden word is identified by its declaration: a native_decide moved to another declaration is an addition', async () => {
    const { checkIntegrity, memoryTree } = await library();
    const file = 'formal/proofs/P.lean';
    const run = (was, now) => checkIntegrity({ base: memoryTree({ [file]: was }), head: memoryTree({ [file]: now }) }).problems.map((p) => [p.kind, p.token, p.statement]);
    const was = 'import Dep\n\ntheorem a : True := by native_decide\ntheorem b : True := trivial\n';
    assert.deepEqual(run(was, was), []);
    assert.deepEqual(run(was, 'import Dep\n\ntheorem a : True := trivial\ntheorem b : True := by native_decide\n'), [['forbidden-added', 'native_decide', 'b']], 'the count is one before and one now');
    assert.deepEqual(run(was, 'import Dep\n\ntheorem a : True := by sorry\ntheorem b : True := trivial\n'), [['forbidden-added', 'sorry', 'a']], 'one word swapped for another in place');
    assert.deepEqual(run('import Dep\n\ntheorem a : True := by sorry\n', 'import Dep\n\ntheorem a : True := by sorry\n'), [], 'an old sorry stays an old sorry');
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
    assert.equal(check(fx, { commit: fx.tip, oleans: OLEANS, args: ['--spec-base', fx.tip] }).json.accepted, true, 'held to itself, nothing differs');
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

  test('a folder with a lakefile of its own that the build reaches is judged like any other', async () => {
    const { checkIntegrity, memoryTree } = await library();
    const lake = 'defaultTargets = ["Foo"]\n[[lean_lib]]\nname = "Foo"\nglobs = ["Foo.+"]\n';
    const tree = (files, lakefile = true) => memoryTree({ 'lakefile.toml': lake, ...(lakefile ? { 'Foo/Sub/lakefile.toml': 'name = "sub"\n' } : {}), 'Foo/Sub/X.lean': 'def x := 1\n', ...files });
    const base = tree({ 'Foo/P.lean': 'def p := 1\n' });
    const added = checkIntegrity({ base, head: tree({ 'Foo/P.lean': 'import Foo.Sub.Evil\ndef p := 1\n', 'Foo/Sub/Evil.lean': 'axiom evil : False\n' }) });
    assert.deepEqual(added.problems.map((p) => [p.kind, p.file, p.statement]), [['forbidden-added', 'Foo/Sub/Evil.lean', 'evil']], 'the glob reaches Foo/Sub, so the nested lakefile hides nothing');
    const unlocked = checkIntegrity({ base, head: tree({ 'Foo/P.lean': 'def p := 1\n', 'Foo/Sub/X.lean': 'theorem t : True := by sorry\n' }, false) });
    assert.deepEqual(unlocked.problems.map((p) => [p.kind, p.token, p.file]), [['forbidden-added', 'sorry', 'Foo/Sub/X.lean']], 'removing the nested lakefile does not hide the folder either');
    assert.deepEqual(checkIntegrity({ base, head: tree({ 'Foo/P.lean': 'def p := 1\n' }) }).problems, [], 'unchanged, a reached nested folder adds nothing');
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

  test('a Lean file or lakefile that names debug.skipKernelTC or addDeclWithoutChecking is refused before any build', async () => {
    const proofs = (text) => ({ ...HEAD_FILES, 'formal/proofs/Lemmas/L.lean': `import Dep\n${text}` });
    for (const [name, text, token] of [
      ['the option in front of a theorem', 'set_option debug.skipKernelTC true in\ntheorem helper : 1 = 2 := by decide\n', 'debug.skipKernelTC'],
      ['the option with other spacing', 'set_option   debug.skipKernelTC   true\ntheorem helper : True := trivial\n', 'debug.skipKernelTC'],
      ['the option in a comment', '/- set_option debug.skipKernelTC true -/\ntheorem helper : True := trivial\n', 'debug.skipKernelTC'],
      ['the option as a string', 'def o : String := "debug.skipKernelTC"\ntheorem helper : True := trivial\n', 'debug.skipKernelTC'],
      ['the function in a command', 'open Lean Elab Command in\nelab "evil" : command => modifyEnv fun e => e.addDeclWithoutChecking default\ntheorem helper : True := trivial\n', 'addDeclWithoutChecking'],
    ]) {
      const fx = layered({ head: proofs(text) });
      const result = checkTip(fx);
      assert.equal(result.status, 1, name);
      assert.deepEqual(result.json.integrity.problems.map((p) => [p.kind, p.token, p.file]), [['unchecked-declaration', token, 'formal/proofs/Lemmas/L.lean']], name);
      assert.match(result.json.label, /^build check failed: .*lets Lean accept a declaration without running its kernel/, name);
      noBuild(fx);
    }
    const { checkIntegrity, memoryTree } = await library();
    const lake = (extra) => `defaultTargets = ["Foo"]\n[[lean_lib]]\nname = "Foo"\nglobs = ["Foo.+"]\n${extra}`;
    const kinds = (files, base = null) => checkIntegrity({ base: base && memoryTree(base), head: memoryTree(files) }).problems.map((p) => [p.kind, p.file]);
    const same = { 'lakefile.toml': lake('moreLeanArgs = ["-Ddebug.skipKernelTC=true"]\n'), 'Foo/P.lean': 'def p := 1\n' };
    assert.deepEqual(kinds(same, same), [['unchecked-declaration', 'lakefile.toml']], 'a lakefile that sets it, unchanged since the merged spec');
    assert.deepEqual(kinds({ 'lakefile.lean': 'import Lake\nopen Lake DSL\n\npackage p where\n  moreLeanArgs := #["-Ddebug.skipKernelTC=true"]\n', 'Foo/P.lean': 'def p := 1\n' }),
      [['unchecked-declaration', 'lakefile.lean']], 'a lakefile.lean, with no merged spec to compare with');
    const old = { 'lakefile.toml': lake(''), 'Foo/P.lean': 'set_option debug.skipKernelTC true\ndef p := 1\n' };
    assert.deepEqual(kinds(old, old), [['unchecked-declaration', 'Foo/P.lean']], 'the same text in the merged spec itself is refused too');
    assert.deepEqual(kinds({ 'lakefile.toml': lake(''), 'Foo/P.lean': 'def p := 1\n', '.lake/packages/dep/Dep.lean': 'set_option debug.skipKernelTC true\n', 'README.md': 'debug.skipKernelTC\n' }), [], 'a prebuilt package and a file that is not Lean are not read');
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
    const at = (...parts) => path.join(fx.repo, 'proj', ...parts);
    // A crate's row carries a whole run (translation and publication, absolute paths) and may name publishDir.
    const state = { extraction: { run: {
      translation: { projectPath: at('Out', 'translation.json') },
      publication: [{ projectPath: at('Out', 'Main.lean') }, { projectPath: 'proj/Out/translation.json' }],
      units: [{ crate: 'a', translation: { projectPath: at('Lean', 'Traits', 'translation.json') }, publication: [{ projectPath: at('Lean', 'Traits', 'T.lean') }] },
        { crate: 'b', publishDir: 'proj/Lean/Hmac/' }, { crate: 'c', publishDir: 'elsewhere/Lean' }, { crate: 'd', publishDir: 'proj' }, { crate: 'e', publishDir: '../up' }, { crate: 'f' },
        { crate: 'g', translation: { projectPath: at('translation.json') } }],
    } } };
    const layout = extractionLayout(state, { root: fx.repo, top: fx.repo, prefix: 'proj' });
    assert.deepEqual(layout.folders, ['out/', 'lean/traits/', 'lean/hmac/'], 'a folder outside the project, the project itself and a missing one are left out');
    assert.deepEqual(layout.files, ['out/main.lean', 'out/translation.json', 'lean/traits/t.lean']);
    assert.equal(isFrozen('Lean/Hmac/Out.lean', layout), true);
    assert.equal(isFrozen('Out/Main.lean', layout), true);
    assert.equal(isFrozen('Out/Other.lean', layout), true, 'the folder of a published translation is frozen');
    assert.equal(isFrozen('Other/X.lean', layout), false);
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
    assert.deepEqual(run({ 'Lean/Hmac/H.lean': 'def h := 1 -- note\n' }).filter(([kind]) => kind !== 'not-covered-by-lean-lib'), []);
    assert.deepEqual(run({ 'Lean/Hmac/H.lean': 'def  h := 1\n' }).filter(([kind]) => kind !== 'not-covered-by-lean-lib'), [['frozen-file-changed', 'Lean/Hmac/H.lean']], 'spacing counts');
    assert.ok(run({}).some(([kind, file]) => kind === 'not-covered-by-lean-lib' && file === 'Lean/Hmac/H.lean'), 'no glob reaches the output, so Lake would not compile it');
    assert.deepEqual(checkIntegrity({ base, head: base, layout: LAYOUT('lean/hmac/h.lean') }).problems.map((p) => p.file), ['Lean/Hmac/H.lean'], 'a published file is judged without its folder, and its sibling is not');
  });

  test('the build check reads the run state, so a changed unit output stops the check before any build', () => {
    const base = { ...BASE_FILES, 'formal/hmac/Out.lean': 'def out := 1\n', 'formal/traits/Out.lean': 'def out := 1\n' };
    const lakefile = 'name = "fixture"\ndefaultTargets = ["Formal"]\n\n[[lean_lib]]\nname = "Formal"\nglobs = ["formal.+"]\n';
    const run = (head) => {
      const fx = layered({ base, head: { ...HEAD_FILES, ...head }, lakefile });
      // One crate as a whole run with absolute paths, the other as a row that names its publish folder.
      const hmac = { crate: 'hmac', translation: { projectPath: path.join(fx.repo, 'formal', 'hmac', 'translation.json') }, publication: [{ projectPath: path.join(fx.repo, 'formal', 'hmac', 'Out.lean') }] };
      write(path.join(fx.repo, '.formalising', 'auto-fv', 'state.json'), JSON.stringify({ extraction: { run: { units: [hmac, { crate: 'traits', publishDir: 'formal/traits' }] } } }));
      return [fx, checkTip(fx)];
    };
    const [, same] = run({});
    assert.equal(same.status, 0, same.stderr);
    assert.match(same.stderr, /extraction output held fixed.*: formal\/hmac\/, formal\/traits\/, formal\/hmac\/out\.lean/);
    assert.deepEqual(same.json.integrity.extraction, { folders: ['formal/hmac/', 'formal/traits/'], files: ['formal/hmac/out.lean'] });
    const [, added] = run({ 'formal/hmac/More.lean': 'def more := 1\n' });
    assert.equal(firstProblem(added).kind, 'frozen-file-added', 'a file added to a crate\'s publish folder');
    const bare = layered({ base, lakefile });
    const noState = check(bare, { commit: bare.tip, oleans: OLEANS });
    assert.deepEqual(noState.json.integrity.extraction, { folders: [], files: [] });
    assert.match(noState.stderr, /extraction output held fixed.*: none recorded in the run state/);
    const [fx, changed] = run({ 'formal/traits/Out.lean': 'def out := 2\n' });
    assert.equal(changed.status, 1);
    assert.equal(firstProblem(changed).kind, 'frozen-file-changed');
    assert.equal(firstProblem(changed).file, 'formal/traits/Out.lean');
    noBuild(fx);
    write(path.join(fx.repo, '.formalising', 'auto-fv', 'state.json'), '{ not json');
    assert.equal(check(fx, { commit: fx.tip, args: ['--spec-base', fx.merged], oleans: OLEANS }).json.code, 'run-state-unreadable');
  });
});

// A multi-crate run: crate A (hmac) and crate B (sha2) are both targets. The engine lists the axioms that
// have a legitimate record. The list holds full names, and a statement's axioms are read from Lean's
// environment, which gives full names too, so a name is covered only by itself.
describe('the allowed axioms', () => {
  const LIST = (...axioms) => JSON.stringify({ schema: 'fvs/auto-allowed-axioms', schemaVersion: 1, axioms });
  const CRATES = (...crates) => JSON.stringify({ schema: 'fvs/auto-allowed-axioms', schemaVersion: 2, crates: crates.map(([crate, specFiles, axioms]) => ({ crate, specFiles, axioms })) });
  const EXTERNAL = 'libcrux_hmac.libcrux_sha2.hacl.hash_256'; // generated for a crate that is not a target: says only that a function exists
  const GAP = 'libcrux_hmac.Trusted.u32_wrapping_div_spec'; // a recorded gap assumption, hand-written: asserts something
  const ABOUT_TARGET = 'libcrux_hmac.Trusted.sha2_hash_spec'; // hand-written, about a function of crate B, which is a target
  const AXIOMS = {
    [EXTERNAL]: { m: 'Extraction.Out', asserts: false },
    [GAP]: { m: 'Trusted.Gaps', asserts: true },
    [ABOUT_TARGET]: { m: 'Trusted.Gaps', asserts: true },
  };
  const axiomConstant = (name, { m, asserts }) => constant(name, { k: 'axiom', m, t: asserts ? 'a proposition' : 'a type', v: undefined, pr: asserts });
  // The merged spec and the head both hold these axioms, so only the list is in question.
  const resting = (names, extra = {}) => {
    const dump = leanDump({
      recalls: { 'Dep.foo': { axioms: ['propext', 'Classical.choice', 'Quot.sound', ...names] } },
      constants: [constant('Dep.foo', { k: 'thm', t: 'a statement', v: undefined }), ...names.map((name) => axiomConstant(name, extra[name] ?? AXIOMS[name] ?? { m: 'Extraction.Out', asserts: false }))],
    });
    return { base: dump, head: dump };
  };
  const run = (fx, listText, dump, extra = []) => {
    const file = path.join(fx.base, 'allowed.json');
    write(file, listText);
    return { file, result: check(fx, { args: ['--allow-axioms', file, ...extra], dump }) };
  };
  const problemOf = (result, kind) => result.json.integrity.problems.find((problem) => problem.kind === kind);

  test('accepts a statement that rests on a non-target external axiom and on a recorded gap', () => {
    const fx = fixture();
    const { file, result } = run(fx, LIST(EXTERNAL, GAP, 'libcrux_hmac.Trusted.unused_spec'), resting([EXTERNAL, GAP]));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.accepted, true);
    assert.deepEqual(result.json.allowAxioms, { file, sha256: sha256(fs.readFileSync(file)), names: 3 });
    assert.match(result.stderr, /allowed axioms: 3 names from .*allowed\.json \(sha256 [0-9a-f]{64}\)/);
  });

  test('refuses a targeted crate\'s statement that rests on a hand-written axiom about another targeted crate\'s function', () => {
    const fx = fixture();
    const { result } = run(fx, LIST(EXTERNAL, GAP), resting([EXTERNAL, GAP, ABOUT_TARGET]));
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.json.accepted, false);
    assert.equal(result.json.label, `build check failed: Specs/A.lean: Dep.foo: the statement Dep.foo (Dep.foo) rests on the axiom ${ABOUT_TARGET}, which the allowed axioms do not name`);
    assert.equal(problemOf(result, 'axiom-not-allowed').statement, 'Dep.foo');
    assert.equal(JSON.parse(fs.readFileSync(path.join(fx.receipts, `${fx.commit}.json`), 'utf8')).accepted, false);
  });

  test('names every unlisted axiom, and the first three in the label', () => {
    const names = ['a.one', 'a.two', 'a.three', 'a.four', EXTERNAL.replace('libcrux_hmac.', '')];
    const { result } = run(fixture(), LIST(EXTERNAL), resting(names));
    assert.match(result.json.label, /the statement Dep\.foo \(Dep\.foo\) rests on the axioms a\.one, a\.two, a\.three and 2 more, which the allowed axioms do not name$/);
  });

  test('a name is covered only by itself: the same tail under another namespace is another constant, in either direction', () => {
    const own = 'libcrux_sha2.hacl.hash_256'; // sha2's own constant, declared in sha2's namespace
    const mine = run(fixture(), LIST(own), resting([EXTERNAL]));
    assert.equal(mine.result.json.accepted, false, "listing sha2's own constant does not cover hmac's copy");
    assert.match(mine.result.json.label, new RegExp(`rests on the axiom ${EXTERNAL.replaceAll('.', '\\.')}, which`));
    const copy = run(fixture(), LIST(EXTERNAL), resting([own]));
    assert.equal(copy.result.json.accepted, false, "listing hmac's copy does not cover sha2's own constant");
  });

  test('with no list given nothing changes, and the receipt says so', () => {
    const fx = fixture();
    const result = check(fx, { dump: resting([EXTERNAL, ABOUT_TARGET]) });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.allowAxioms, null);
    assert.match(result.stderr, /allowed axioms: no list given/);
  });

  test('an empty list allows only the three standard axioms', () => {
    const standard = run(fixture(), LIST(), resting([])).result;
    assert.equal(standard.status, 0, standard.stderr);
    assert.equal(standard.json.allowAxioms.names, 0);
    assert.equal(run(fixture(), LIST(), resting([EXTERNAL])).result.json.accepted, false);
  });

  test('an axiom that sorry, native_decide or bv_decide would add is refused with a list or without, listed or not', () => {
    const native = 'Dep.foo._native.native_decide.ax_1';
    const asNew = (names) => { const { head } = resting(names); return { base: resting([]).base, head }; };
    const without = check(fixture(), { dump: asNew([native]) });
    assert.equal(without.json.accepted, false);
    assert.equal(problemOf(without, 'axiom-not-allowed').statement, native);
    const listed = run(fixture(), LIST(native), asNew([native])).result;
    assert.equal(listed.json.accepted, false, 'a list does not make a new axiom outside Trusted acceptable');
    assert.match(problemOf(listed, 'axiom-not-allowed').detail, /declared outside Trusted/);
  });

  test('an axiom whose type is a proposition must be a hand-written Trusted axiom, even when it is listed', () => {
    const generated = { m: 'Extraction.Out', asserts: true };
    const { result } = run(fixture(), LIST(EXTERNAL), resting([EXTERNAL], { [EXTERNAL]: generated }));
    assert.equal(result.status, 1, result.stderr);
    const problem = problemOf(result, 'prop-axiom-outside-trusted');
    assert.match(problem.detail, new RegExp(`rests on ${EXTERNAL.replaceAll('.', '\\.')}, an axiom whose type is a proposition, declared outside Trusted/ \\(in Extraction\\.Out\\)`));
    const bound = run(fixture(), LIST(GAP), resting([GAP])).result;
    assert.equal(bound.status, 0, 'a Prop-valued axiom in Trusted, listed, passes');
    const data = run(fixture(), LIST(EXTERNAL), resting([EXTERNAL], { [EXTERNAL]: { m: 'Trusted.Out', asserts: false } })).result;
    assert.equal(data.status, 0, 'a data axiom passes wherever it is');
  });

  test('a Prop-valued axiom that is not on the list is refused for being unlisted, once', () => {
    const { result } = run(fixture(), LIST(), resting([GAP]));
    assert.deepEqual(result.json.integrity.problems.map((problem) => problem.kind), ['axiom-not-allowed']);
  });

  test('a new Trusted axiom that asserts something and cites an open record is refused although the list names it', () => {
    const head = leanDump({
      recalls: { 'Dep.foo': { axioms: ['propext', 'Classical.choice', 'Quot.sound', GAP] } },
      docs: [{ name: GAP, m: 'Trusted.Gaps', cites: ['gap-open'], axiom: true }],
      constants: [constant('Dep.foo', { k: 'thm', t: 'a statement', v: undefined }), axiomConstant(GAP, AXIOMS[GAP])],
    });
    const { result } = run(fixture(), LIST(GAP), { base: resting([]).base, head });
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.json.integrity.problems.map((problem) => problem.kind), ['trusted-axiom-unbound']);
    assert.match(problemOf(result, 'trusted-axiom-unbound').detail, /must cite exactly one accepted externals record in its docstring \(it cites 0\)/);
  });

  test('the digest is that of the raw bytes, and a statement with another fault keeps its own reason', () => {
    const fx = fixture();
    const text = `  ${LIST(EXTERNAL)}\n\n`;
    const { file, result } = run(fx, text, resting([EXTERNAL]));
    assert.equal(result.json.allowAxioms.sha256, sha256(text));
    assert.equal(result.json.allowAxioms.sha256, sha256(fs.readFileSync(file)));
    const unguarded = fixture({ spec: `import Dep\n\nrecall Dep.foo : True\n` });
    assert.equal(run(unguarded, LIST()).result.json.specFiles[0].statements[0].reason, 'no #guard_msgs on #print axioms');
  });

  test('a list that is missing or malformed is a refusal, never a fallback to no list', () => {
    const fx = fixture();
    const missing = check(fx, { args: ['--allow-axioms', path.join(fx.base, 'nope.json')] });
    assert.equal(missing.status, 2);
    assert.equal(missing.json.code, 'allow-axioms-unreadable');
    const v1 = (axioms) => JSON.stringify({ schema: 'fvs/auto-allowed-axioms', schemaVersion: 1, axioms });
    const v2 = (fields) => JSON.stringify({ schema: 'fvs/auto-allowed-axioms', schemaVersion: 2, ...fields });
    const crate = (fields) => ({ crate: 'a', specFiles: ['S.lean'], axioms: [], ...fields });
    for (const bad of ['{ not json', JSON.stringify({ schema: 'other', schemaVersion: 1, axioms: [] }), JSON.stringify({ schema: 'fvs/auto-allowed-axioms', schemaVersion: 3, axioms: [] }),
      JSON.stringify({ schema: 'fvs/auto-allowed-axioms', schemaVersion: 1 }), v1('a.b'), v1(['a.b', '']), v1([' a.b']), v1([1]), 'null',
      v2({ axioms: [] }), v2({ crates: 'a' }), v2({ crates: [null] }), v2({ crates: [], extra: 1 }), v2({ crates: [crate({ extra: 1 })] }),
      v2({ crates: [crate({ crate: '' })] }), v2({ crates: [crate({ crate: ' a' })] }), v2({ crates: [crate({ specFiles: 'S.lean' })] }), v2({ crates: [crate({ axioms: [1] })] }),
      v2({ crates: [crate({ axioms: ['a.b', ''] })] }), v2({ crates: [crate({ specFiles: [''] })] }), v2({ crates: [crate(), crate()] }),
      v2({ crates: [crate(), crate({ crate: 'b' })] })]) {
      const { result } = run(fx, bad);
      assert.equal(result.status, 2, bad);
      assert.equal(result.json.code, 'allow-axioms-invalid', bad);
    }
    const left = JSON.parse(fs.readFileSync(path.join(fx.receipts, `${fx.commit}.json`), 'utf8'));
    assert.equal(left.accepted, false, 'the refusal left a non-accepting receipt');
    assert.equal(left.refusal.code, 'allow-axioms-invalid');
    assert.equal(check(fx, { args: ['--allow-axioms'] }).json.code, 'usage');
  });

  test('a commit that fails the integrity guards still records the list it was given', () => {
    const fx = layered({ head: { ...HEAD_FILES, 'formal/specs/Specs/A.lean': SPEC_HEAD.replace('(h : 0 < n)', '(h : 0 ≤ n)') } });
    const file = path.join(fx.base, 'allowed.json');
    write(file, LIST());
    const result = check(fx, { commit: fx.tip, args: ['--spec-base', fx.merged, '--allow-axioms', file], oleans: OLEANS });
    assert.equal(result.json.accepted, false);
    assert.equal(firstProblem(result).kind, 'statement-changed');
    assert.deepEqual(result.json.allowAxioms, { file, sha256: sha256(LIST()), names: 0 });
    noBuild(fx);
  });

  describe('one list for each crate (version 2)', () => {
    const SPEC_FILE = 'Specs/A.lean';
    test('a statement is held to the list of the crate whose spec files hold it', () => {
      const text = CRATES(['libcrux_hmac', [SPEC_FILE], [EXTERNAL, GAP]], ['libcrux_sha2', ['sha2/Specs/B.lean'], [ABOUT_TARGET]]);
      const accepted = run(fixture(), text, resting([EXTERNAL, GAP]));
      assert.equal(accepted.result.status, 0, accepted.result.stderr);
      assert.deepEqual(accepted.result.json.allowAxioms, { file: accepted.file, sha256: sha256(text), names: 3, crates: 2 });
      assert.match(accepted.result.stderr, /allowed axioms: 3 names in 2 crates from /);
      const other = run(fixture(), text, resting([EXTERNAL, ABOUT_TARGET])).result;
      assert.equal(other.status, 1, 'an axiom that only the other crate lists is not this crate\'s');
      assert.match(other.json.label, new RegExp(`rests on the axiom ${ABOUT_TARGET.replaceAll('.', '\\.')}, which the allowed axioms of the crate libcrux_hmac do not name`));
    });

    test('the same bare tail under another namespace is not covered by the crate list either', () => {
      const text = CRATES(['libcrux_hmac', [SPEC_FILE], ['libcrux_sha2.hacl.hash_256']]);
      const { result } = run(fixture(), text, resting([EXTERNAL]));
      assert.equal(result.json.accepted, false);
      assert.equal(problemOf(result, 'axiom-not-allowed').file, SPEC_FILE);
    });

    test('a statement in a spec file that no crate lists is refused, naming the file', () => {
      const { result } = run(fixture(), CRATES(['libcrux_hmac', ['Specs/Other.lean'], [EXTERNAL]]), resting([EXTERNAL]));
      assert.equal(result.status, 1, result.stderr);
      const problem = problemOf(result, 'allowed-axioms-crate-unknown');
      assert.equal(problem.file, SPEC_FILE);
      assert.match(problem.detail, /the spec file Specs\/A\.lean is listed under no crate of the allowed axioms/);
    });

    test('the Prop rule and the unlisted rule apply per crate too', () => {
      const generated = { m: 'Extraction.Out', asserts: true };
      const { result } = run(fixture(), CRATES(['libcrux_hmac', [SPEC_FILE], [EXTERNAL]]), resting([EXTERNAL], { [EXTERNAL]: generated }));
      assert.ok(problemOf(result, 'prop-axiom-outside-trusted'));
    });

    test('a list read for the check is the list the receipt digest names', () => {
      const text = CRATES(['libcrux_hmac', [SPEC_FILE], []]);
      const { result, file } = run(fixture(), text, resting([]));
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.json.allowAxioms.sha256, sha256(fs.readFileSync(file)));
    });
  });

  test('a listed name covers itself and nothing else', async () => {
    const { axiomsNotAllowed } = await library();
    const allowed = new Set([EXTERNAL]);
    const left = (...names) => axiomsNotAllowed(names, allowed);
    assert.deepEqual(left(EXTERNAL), []);
    assert.deepEqual(left('libcrux_sha2.hacl.hash_256', 'hacl.hash_256', 'x.libcrux_hmac.libcrux_sha2.hacl.hash_256', 'libcrux_hmac.libcrux_sha2.hacl', 'libcrux_hmac.libcrux_sha2.hacl.hash_25'),
      ['libcrux_sha2.hacl.hash_256', 'hacl.hash_256', 'x.libcrux_hmac.libcrux_sha2.hacl.hash_256', 'libcrux_hmac.libcrux_sha2.hacl', 'libcrux_hmac.libcrux_sha2.hacl.hash_25']);
    assert.deepEqual(left('propext', 'Classical.choice', 'Quot.sound'), [], 'the standard axioms need no entry');
    assert.deepEqual(axiomsNotAllowed(null, allowed), []);
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
      const result = check(fx, { commit: fx.tip, args, oleans: OLEANS, noBase: args.length === 0 });
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

// ---- the Lean-level comparison with the merged spec -----------------------------------------------------
//
// Text cannot say that a statement still means what it meant: a helper, a notation, a macro or an instance in a
// file that is not frozen can change what unchanged text elaborates to. After the build a Lean program dumps, for
// each recalled statement, what it rests on, and the same program runs on the merged spec. Here the program is
// stubbed: a test hands the stub the dump each side would print (leanDump), so the comparison, the axiom rules and
// the plumbing are checked without a build. The gated block further down runs real Lean.

const TOOLCHAIN = { toolchain: 'Lean (version 4.35.0, stub)', githash: 'abc123' };
const constant = (n, fields = {}) => ({ n, k: 'defn', m: 'formal.proofs.A', lp: [], t: `type of ${n}`, d: [], v: `value of ${n}`, ...fields });
const leanDump = ({ toolchain = TOOLCHAIN, recalls = {}, docs = [], constants = [] } = {}) => `${[
  JSON.stringify(toolchain),
  ...Object.entries(recalls).map(([id, { matches = [id], axioms = [] } = {}]) => JSON.stringify({ recall: id, matches, rests: matches.map((n) => ({ n, axioms })) })),
  ...docs.map((entry) => JSON.stringify({ doc: entry.name, m: entry.m ?? 'formal.specs.Defs.Gaps', cites: entry.cites, prop: entry.prop ?? false, axiom: entry.axiom ?? false })),
  ...constants.map((entry) => JSON.stringify(entry)),
].join('\n')}\n`;

const FOO = constant('Dep.foo', { k: 'thm', t: 'a statement about Div', d: ['Div'], v: undefined });
const DIV = (value = 'a / b = a / b') => constant('Div', { m: 'formal.specs.Defs.Gaps', t: 'Prop', v: value });
const GAP_AXIOM = (fields = {}) => constant('Gap.div_spec', { k: 'axiom', m: 'formal.trusted.Gaps', t: 'Div', d: ['Div'], v: undefined, tc: 'Div', ...fields });
const BASE_DOCS = [{ name: 'Div', cites: ['gap-div'], prop: true }];
const HEAD_DOCS = [{ name: 'Gap.div_spec', m: 'formal.trusted.Gaps', cites: ['gap-div'], axiom: true }];
// The dumps of an unchanged merged spec; a test replaces the part it is about.
const DUMPS = (head = {}, base = {}) => ({
  base: leanDump({ recalls: { 'Dep.foo': {} }, docs: BASE_DOCS, constants: [FOO, DIV()], ...base }),
  head: leanDump({ recalls: { 'Dep.foo': { axioms: ['propext', 'Classical.choice', 'Quot.sound'] } }, docs: [...BASE_DOCS, ...HEAD_DOCS], constants: [FOO, DIV(), GAP_AXIOM()], ...head }),
});
const compare = async ({ base, head, recalled = ['Dep.foo'], ids = ['gap-div'] }) => {
  const { parseDump, semanticProblems } = await library();
  return semanticProblems({ base: parseDump(base), head: parseDump(head), recalled, acceptedIds: new Set(ids) });
};
const kinds = (result) => result.problems.map((problem) => problem.kind);

describe('the Lean program: what runs, and what an unusable run means', () => {
  test('it runs on the built head and on a build of the merged spec in a copy of its own, and the receipt records both', () => {
    const fx = layered();
    const dump = DUMPS();
    const result = checkTip(fx, { dump });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.label, LABEL);
    const [head, base] = ['head', 'base'].map((side) => JSON.parse(seen(fx, `dump-${side}-args.json`)));
    assert.deepEqual(head.recalls, ['Dep.foo']);
    assert.deepEqual(head.ids, ['gap-div'], 'only the records the owner accepted');
    assert.deepEqual(base.recalls, head.recalls);
    for (const module of ['formal.specs.Specs.A', 'formal.proofs.A', 'formal.proofs.Lemmas.L', 'formal.extraction.Ext']) assert.ok(head.modules.includes(module), `${module} is dumped`);
    assert.ok(!base.modules.includes('formal.proofs.Lemmas.L'), 'the merged spec has its own modules');
    assert.match(seen(fx, 'build-args'), /build --wfail --no-ansi/, 'the head is built with warnings as errors');
    assert.equal(seen(fx, 'base-build-args'), 'build --no-ansi', 'the merged spec is built as it stands');
    assert.ok(seen(fx, 'base-build-cwd').startsWith(fx.work) && seen(fx, 'base-build-cwd') !== seen(fx, 'build-cwd'), 'in a copy of its own');
    assert.ok(seen(fx, 'dump-head-cwd').endsWith('tree') && seen(fx, 'dump-base-cwd').endsWith('base'));
    for (const name of ['threads', 'base-threads', 'dump-head-threads', 'dump-base-threads']) assert.equal(seen(fx, name), '2');
    assert.equal(result.json.schema, 2, 'the receipt version whose acceptance carries this comparison');
    assert.equal(JSON.parse(fs.readFileSync(path.join(fx.receipts, `${fx.tip}.json`), 'utf8')).schema, 2);
    const { semantic } = result.json.integrity;
    assert.deepEqual(semantic.toolchain, { lean: TOOLCHAIN.toolchain, githash: TOOLCHAIN.githash });
    assert.deepEqual(semantic.bindings, [{ axiom: 'Gap.div_spec', record: 'gap-div', proposition: 'Div' }]);
    assert.deepEqual(semantic.statements.map((s) => [s.name, s.declaration, s.constants]), [['Dep.foo', 'Dep.foo', 2]]);
    assert.deepEqual(semantic.dumps, { base: sha256(dump.base), head: sha256(dump.head) });
    assert.match(result.stderr, /Lean check \(Lean \(version 4\.35\.0, stub\)\): recalled declarations compared: 1 \(2 project constants\); new Trusted axioms bound to their records: 1/);
    assert.deepEqual(result.json.externals.records.map((r) => r.id), ['gap-div']);
  });

  test('without a merged spec nothing is compared and no Lean program runs', () => {
    const fx = layered();
    const result = check(fx, { commit: fx.tip, oleans: OLEANS, noBase: true });
    assert.equal(result.json.label, 'built, integrity not checked');
    assert.equal(fs.existsSync(path.join(fx.stub, 'dump-head-args.json')), false);
    assert.equal(fs.existsSync(path.join(fx.stub, 'base-build-args')), false, 'the merged spec is not built either');
  });

  test('a Lean program that fails or prints nothing usable is not an acceptance, on either side', () => {
    for (const [side, options, expected] of [
      ['head', { dumpFail: { head: 3 } }, /the Lean check could not run: the Lean program failed on the head \(exit 3\)/],
      ['base', { dumpFail: { base: 4 } }, /the Lean check could not run: the Lean program failed on the base \(exit 4\)/],
      ['head', { dump: { head: 'nothing but noise\n' } }, /the Lean check could not run: the Lean program's output for the head cannot be read \(the Lean program printed no toolchain line\)/],
      ['base', { dump: { base: '' } }, /output for the base cannot be read/],
    ]) {
      const fx = layered();
      const result = checkTip(fx, options);
      assert.equal(result.status, 1, `${side}: ${result.stderr}`);
      assert.equal(result.json.accepted, false);
      assert.match(result.json.label, expected);
      assert.equal(JSON.parse(fs.readFileSync(result.json.receipt, 'utf8')).accepted, false);
    }
  });

  test('a merged spec that does not build cannot be compared with, so the head is not accepted', () => {
    const fx = layered();
    const result = checkTip(fx, { baseStatus: 1, baseOut: 'error: Specs/A.lean:3:0: unknown identifier\n' });
    assert.equal(result.status, 1);
    assert.match(result.json.label, /the Lean check could not run: the merged spec [0-9a-f]{12} does not build/);
  });
});

describe('the Lean program: what a changed meaning is', () => {
  test('a definition a statement rests on that changed is refused, with unchanged statement text', () => {
    const fx = layered();
    const dump = DUMPS({ constants: [FOO, DIV('a / b = b'), GAP_AXIOM()] });
    const result = checkTip(fx, { dump });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.json.accepted, false);
    const problem = result.json.integrity.problems.find((p) => p.kind === 'statement-meaning-changed');
    assert.equal(problem.statement, 'Dep.foo');
    assert.match(problem.detail, /Div, which it rests on, changed/);
    assert.match(result.json.label, /^build check failed: Lean check: Dep\.foo: the statement Dep\.foo \(Dep\.foo\) no longer means what it meant/);
    assert.match(result.stderr, /not accepted: statement-meaning-changed/);
  });

  test('the statement itself changed, a definition it rests on is gone, a toolchain that moved', async () => {
    const statement = await compare({ ...DUMPS({ constants: [constant('Dep.foo', { k: 'thm', t: 'weaker', d: ['Div'], v: undefined }), DIV(), GAP_AXIOM()] }) });
    assert.match(statement.problems[0].detail, /its type changed/);
    const gone = await compare({ ...DUMPS({ constants: [FOO, GAP_AXIOM()] }) });
    assert.match(gone.problems[0].detail, /Div, which it rests on, is gone/);
    const moved = await compare({ ...DUMPS({ toolchain: { toolchain: 'Lean (version 4.36.0)', githash: 'ffff' } }) });
    assert.deepEqual(kinds(moved), ['toolchain-changed']);
  });

  test('what a statement does not rest on may change, and a proof is not part of what it rests on', async () => {
    const side = (extra) => leanDump({ recalls: { 'Dep.foo': {} }, constants: [FOO, DIV(), ...extra] });
    const unrelated = await compare({ base: side([constant('Other', { v: 'one' })]), head: side([constant('Other', { v: 'two' })]) });
    assert.deepEqual(unrelated.problems, []);
    const proofChanged = await compare({ base: side([]), head: leanDump({ recalls: { 'Dep.foo': {} }, constants: [constant('Dep.foo', { k: 'thm', t: 'a statement about Div', d: ['Div', 'helper'], v: undefined }), DIV(), constant('helper', { v: 'a proof helper' })] }) });
    assert.deepEqual(proofChanged.problems, [], 'a theorem is its type only; a new helper it cites is not a dependency of its type');
  });

  test('a declaration whose name ends with the recalled name that the merged spec lacked is a shadow', async () => {
    const shadow = await compare({ ...DUMPS({ recalls: { 'Dep.foo': { matches: ['Dep.foo', 'Cheat.Dep.foo'] } } }) });
    assert.deepEqual(kinds(shadow), ['statement-shadowed']);
    assert.match(shadow.problems[0].detail, /Cheat\.Dep\.foo \(added\)/);
    const gone = await compare({ ...DUMPS({ recalls: { 'Dep.foo': { matches: [] } } }) });
    assert.match(gone.problems[0].detail, /Dep\.foo \(gone\)/);
  });

  test('a recall that resolves to no project declaration at the merged spec cannot be compared', async () => {
    const unresolved = await compare({ ...DUMPS({}, { recalls: { 'Dep.foo': { matches: [] } } }) });
    assert.deepEqual(kinds(unresolved).slice(0, 1), ['statement-unresolved']);
  });
});

describe('the Lean program: the axioms a statement may rest on', () => {
  test('Lean’s three, a project axiom the merged spec had, and an axiom bound to its accepted record are allowed', async () => {
    const result = await compare({ ...DUMPS() });
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.bindings, [{ axiom: 'Gap.div_spec', record: 'gap-div', proposition: 'Div' }]);
    const old = constant('Old.sha_spec', { k: 'axiom', m: 'formal.trusted.Sha', t: 'True', v: undefined, tc: 'True' });
    const had = leanDump({ recalls: { 'Dep.foo': { axioms: ['Old.sha_spec'] } }, constants: [FOO, DIV(), old] });
    assert.deepEqual((await compare({ base: had, head: had })).problems, [], 'an axiom the merged spec had, unchanged');
    const changed = await compare({ base: had, head: leanDump({ recalls: { 'Dep.foo': { axioms: ['Old.sha_spec'] } }, constants: [FOO, DIV(), constant('Old.sha_spec', { k: 'axiom', m: 'formal.trusted.Sha', t: 'False', v: undefined, tc: 'False' })] }) });
    assert.deepEqual(kinds(changed), ['axiom-changed']);
  });

  test('sorry, native_decide and bv_decide add axioms that are not the project’s, so a statement resting on one is refused', async () => {
    for (const axiom of ['sorryAx', 'Lean.ofReduceBool', 'Dep.foo._native.bv_decide.ax_1']) {
      const result = await compare({ ...DUMPS({ recalls: { 'Dep.foo': { axioms: ['propext', axiom] } } }) });
      assert.ok(kinds(result).includes('axiom-not-allowed'), axiom);
      assert.match(result.problems.find((p) => p.kind === 'axiom-not-allowed').detail, new RegExp(`rests on the axiom ${axiom.replaceAll('.', '\\.')}`));
    }
  });

  test('a new axiom outside Trusted is refused even when its docstring cites an accepted record', async () => {
    const result = await compare({ ...DUMPS({ constants: [FOO, DIV(), GAP_AXIOM({ m: 'formal.proofs.Cheat' })], docs: [...BASE_DOCS, { ...HEAD_DOCS[0], m: 'formal.proofs.Cheat' }] }) });
    assert.deepEqual(kinds(result), ['axiom-not-allowed']);
    assert.match(result.problems[0].detail, /declared outside Trusted/);
  });

  test('an axiom that asserts something other than the proposition its record is tied to is refused, False included', async () => {
    const strengthened = await compare({ ...DUMPS({ constants: [FOO, DIV(), GAP_AXIOM({ tc: 'False', d: [] })] }) });
    assert.deepEqual(kinds(strengthened), ['trusted-axiom-unbound']);
    assert.match(strengthened.problems[0].detail, /asserts False, but the record gap-div is tied to the proposition Div/);
    const compound = await compare({ ...DUMPS({ constants: [FOO, DIV(), GAP_AXIOM({ tc: null })] }) });
    assert.match(compound.problems[0].detail, /something that is not one proposition/);
  });

  test('the record must be accepted, and tied to exactly one frozen proposition in the merged spec', async () => {
    const notAccepted = await compare({ ...DUMPS(), ids: [] });
    assert.match(notAccepted.problems[0].detail, /must cite exactly one accepted externals record in its docstring \(it cites 0\)/);
    const untied = await compare({ ...DUMPS({}, { docs: [] }) });
    assert.match(untied.problems[0].detail, /tied to 0 propositions in the frozen spec of the merged spec/);
    const inTrusted = await compare({ ...DUMPS({}, { docs: [{ name: 'Div', m: 'formal.trusted.Old', cites: ['gap-div'], prop: true }] }) });
    assert.match(inTrusted.problems[0].detail, /tied to 0 propositions/, 'a proposition in Trusted is not a frozen spec statement');
    const twice = await compare({ ...DUMPS({}, { docs: [...BASE_DOCS, { name: 'Other', cites: ['gap-div'], prop: true }] }) });
    assert.match(twice.problems[0].detail, /tied to 2 propositions/);
  });

  test('the proposition a record is tied to must be the merged spec’s own', async () => {
    const result = await compare({ ...DUMPS({ constants: [FOO, DIV('a / b = b'), GAP_AXIOM()] }), recalled: [] });
    assert.deepEqual(kinds(result), ['trusted-axiom-unbound']);
    assert.match(result.problems[0].detail, /the proposition Div that the record gap-div is tied to changed/);
  });

  test('a record that an axiom of the merged spec already cites cannot authorise a second axiom', async () => {
    const old = constant('Old.div_spec', { k: 'axiom', m: 'formal.trusted.Old', t: 'Div', d: ['Div'], v: undefined, tc: 'Div' });
    const oldDoc = { name: 'Old.div_spec', m: 'formal.trusted.Old', cites: ['gap-div'], axiom: true };
    const result = await compare({ ...DUMPS({ constants: [FOO, DIV(), old, GAP_AXIOM()], docs: [...BASE_DOCS, oldDoc, ...HEAD_DOCS] }, { constants: [FOO, DIV(), old], docs: [...BASE_DOCS, oldDoc] }) });
    assert.deepEqual(kinds(result), ['trusted-axiom-unbound']);
    assert.match(result.problems[0].detail, /is cited by 2 axioms/);
  });

  test('the same record cited by two new axioms ties only one', async () => {
    const second = GAP_AXIOM({ n: 'Gap.div_spec2' });
    const result = await compare({ ...DUMPS({ constants: [FOO, DIV(), GAP_AXIOM(), second], docs: [...BASE_DOCS, ...HEAD_DOCS, { ...HEAD_DOCS[0], name: 'Gap.div_spec2' }] }) });
    assert.deepEqual(kinds(result), ['trusted-axiom-unbound', 'trusted-axiom-unbound']);
  });

  test('a recalled declaration the Lean program printed no constant for is refused, never compared as empty', async () => {
    const without = () => leanDump({ recalls: { 'Dep.foo': {} }, constants: [DIV()] });
    const head = await compare({ base: leanDump({ recalls: { 'Dep.foo': {} }, constants: [FOO, DIV()] }), head: without() });
    assert.deepEqual(kinds(head), ['statement-unresolved']);
    assert.match(head.problems[0].detail, /printed no constant for Dep\.foo on the head/);
    const both = await compare({ base: without(), head: without() });
    assert.match(both.problems[0].detail, /on the base and head/);
  });

  test('a line of the output that starts like JSON and is not is an error', async () => {
    const { parseDump } = await library();
    assert.throws(() => parseDump(`${leanDump()}{"n": broken\n`), /not valid JSON/);
  });

  test('a declaration that was not an axiom at the merged spec and is one now is a new axiom', async () => {
    const was = constant('Gap.div_spec', { k: 'thm', t: 'Div', d: ['Div'], v: undefined });
    const result = await compare({ base: leanDump({ constants: [DIV(), was] }), head: leanDump({ constants: [DIV(), GAP_AXIOM({ m: 'formal.proofs.Cheat' })] }), recalled: [] });
    assert.deepEqual(kinds(result), ['axiom-not-allowed']);
    assert.match(result.problems[0].detail, /new since the merged spec and is declared outside Trusted/);
  });

  test('a Lean program output without its toolchain line is an error, and lines that are not JSON are skipped', async () => {
    const { parseDump } = await library();
    assert.throws(() => parseDump('{"recall":"x","matches":[],"rests":[]}\n'), /no toolchain line/);
    assert.equal(parseDump(`warning: something\n${leanDump()}`).toolchain.githash, 'abc123');
  });
});

describe('every spec, proof and extraction file must have been built', () => {
  test('a proof file whose module Lake did not build is refused, whatever the lakefile says and with no recall in the file', () => {
    const fx = layered();
    const result = checkTip(fx, { oleans: ['formal/specs/Specs/A', 'formal/proofs/Lemmas/L', 'formal/extraction/Ext'] });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.json.accepted, false);
    assert.match(result.json.label, /^build check failed: no \.olean was produced for formal\/proofs\/A\.lean \(module formal\.proofs\.A\), so Lake did not build it$/);
    assert.equal(fs.existsSync(path.join(fx.stub, 'dump-head-args.json')), false, 'no Lean program runs on a build that is incomplete');
  });

  test('an extraction file and a new lemma file are held to it too, and the label counts the rest', () => {
    const fx = layered();
    const result = checkTip(fx, { oleans: ['formal/specs/Specs/A'] });
    assert.match(result.json.label, /no \.olean was produced for formal\/extraction\/Ext\.lean .* \(and 2 more\)$/);
  });

  test('in a lakefile.lean project, where no globs are read, the same holds, and a module named below a source folder counts', () => {
    const dsl = layered({ dsl: true });
    const missing = checkTip(dsl, { oleans: ['formal/specs/Specs/A', 'formal/proofs/A', 'formal/proofs/Lemmas/L'] });
    assert.match(missing.json.label, /no \.olean was produced for formal\/extraction\/Ext\.lean/);
    const shifted = layered({ dsl: true });
    const accepted = checkTip(shifted, { oleans: ['formal/specs/Specs/A', 'proofs/A', 'proofs/Lemmas/L', 'extraction/Ext'] });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(accepted.json.accepted, true);
  });

  test('which modules a file can have: below a library’s source folder, or for a lakefile.lean its path or any suffix of it', async () => {
    const { checkIntegrity, memoryTree } = await library();
    const toml = checkIntegrity({ base: null, head: memoryTree({ 'lakefile.toml': 'defaultTargets = ["P"]\n[[lean_lib]]\nname = "P"\nsrcDir = "formal"\nglobs = ["P.+"]\n', 'formal/P/proofs/X.lean': 'def x := 1\n' }) });
    assert.deepEqual(toml.required.map((r) => [r.rel, r.modules]), [['formal/P/proofs/X.lean', ['P.proofs.X']]]);
    const dsl = checkIntegrity({ base: null, head: memoryTree({ 'lakefile.lean': 'import Lake\n', 'formal/proofs/P.lean': 'def p := 1\n', 'lean-toolchain': 'x\n' }) });
    assert.deepEqual(dsl.required.map((r) => [r.rel, r.modules]), [['formal/proofs/P.lean', ['formal.proofs.P', 'proofs.P', 'P']]]);
  });

  test('a lean-toolchain that changed since the merged spec is refused like the lakefile', async () => {
    const { checkIntegrity, memoryTree } = await library();
    const lake = 'defaultTargets = ["P"]\n[[lean_lib]]\nname = "P"\n';
    const was = memoryTree({ 'lakefile.toml': lake, 'lean-toolchain': 'leanprover/lean4:v4.35.0\n' });
    const now = memoryTree({ 'lakefile.toml': lake, 'lean-toolchain': 'leanprover/lean4:v4.36.0\n' });
    const { problems } = checkIntegrity({ base: was, head: now });
    assert.deepEqual(problems.map((p) => [p.kind, p.file]), [['frozen-file-changed', 'lean-toolchain']]);
  });
});

// ---- real Lean ---------------------------------------------------------------------------------------------
//
// Small projects with no dependency, built by the real `lake` and checked by the real Lean program. They run only
// when FVS_REAL_LEAN names a toolchain that is installed, for example:
//   FVS_REAL_LEAN=leanprover/lean4:v4.35.0 node --test --test-concurrency=2 tests/auto-build-check.test.cjs
// Each check builds the merged spec and the head, so these take some seconds each.

const REAL_LEAN = process.env.FVS_REAL_LEAN;
const REAL_LAKEFILE = 'name = "fx"\ndefaultTargets = ["Fx"]\n\n[[lean_lib]]\nname = "Fx"\nglobs = ["Fx.+"]\n';
const GUARD_NONE = (name) => `/-- '${name}' does not depend on any axioms -/\n#guard_msgs (whitespace := lax, substring := true) in\n#print axioms ${name}\n`;
const GAPS = '/-- The behaviour of the assumed operation, `gap-add`. -/\ndef Gap : Prop := ∀ n : Nat, n + 0 = n\n';
const REAL_BASE = {
  'lakefile.toml': REAL_LAKEFILE,
  'lean-toolchain': `${REAL_LEAN}\n`,
  'lake-manifest.json': JSON.stringify({ version: '1.1.0', packagesDir: '.lake/packages', packages: [], name: 'fx', lakeDir: '.lake' }),
  'Fx/Specs/Defs/Gaps.lean': GAPS,
  'Fx/Proofs/Helper.lean': 'def Fx.limit : Nat := 10\n',
  'Fx/Proofs/P.lean': 'import Fx.Proofs.Helper\n\ntheorem Fx.foo_spec : Fx.limit = 10 := by\n  sorry\n',
  'Fx/Specs/A.lean': 'import Fx.Proofs.P\n\nrecall Fx.foo_spec : Fx.limit = 10\n\n#print axioms Fx.foo_spec\n',
};
const REAL_HEAD = {
  'Fx/Proofs/P.lean': 'import Fx.Proofs.Helper\n\ntheorem Fx.foo_spec : Fx.limit = 10 := rfl\n',
  'Fx/Specs/A.lean': `import Fx.Proofs.P\n\nrecall Fx.foo_spec : Fx.limit = 10\n\n${GUARD_NONE('Fx.foo_spec')}`,
};

// Commits `REAL_BASE` then `head` on top, with the externals records the check reads.
const realFolders = [];
function realProject(head, { externals = EXTERNALS(record({ id: 'gap-add' })), remove = [], baseFiles = {} } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-real-')));
  realFolders.push(base);
  const repo = path.join(base, 'repo');
  fs.mkdirSync(path.join(base, 'work'));
  git(base, 'init', '-q', '-b', 'main', repo);
  write(path.join(repo, '.gitignore'), '.lake/\n');
  for (const [name, text] of Object.entries({ ...REAL_BASE, ...baseFiles })) write(path.join(repo, name), text);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'merged spec');
  const merged = git(repo, 'rev-parse', 'HEAD');
  for (const [name, text] of Object.entries(head)) write(path.join(repo, name), text);
  for (const name of remove) fs.rmSync(path.join(repo, name));
  write(path.join(repo, '.formalising', 'auto-fv', 'externals.json'), JSON.stringify(externals));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'proofs');
  return { base, repo, merged, tip: git(repo, 'rev-parse', 'HEAD'), receipts: path.join(base, 'receipts'), work: path.join(base, 'work') };
}
function realCheck(fx, args = []) {
  const run = sh(fx.base, process.execPath, [SCRIPT, '--project-root', fx.repo, '--commit', fx.tip, '--spec-base', fx.merged, '--receipt-dir', fx.receipts, '--workdir', fx.work, ...args], { TMPDIR: fx.base, LEAN_NUM_THREADS: '2' });
  let json = null;
  try { json = JSON.parse(run.stdout); } catch { /* reported by the assertions */ }
  return { status: run.status, json, stderr: run.stderr };
}

describe('real Lean: a statement that still reads the same but does not mean the same', { skip: REAL_LEAN ? false : 'FVS_REAL_LEAN does not name an installed toolchain' }, () => {
  after(() => { for (const folder of realFolders) fs.rmSync(folder, { recursive: true, force: true }); });

  test('proofs on top of an unchanged spec are accepted, and the receipt carries the comparison', () => {
    const result = realCheck(realProject(REAL_HEAD));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.label, LABEL);
    assert.deepEqual(result.json.integrity.semantic.statements.map((s) => [s.name, s.declaration]), [['Fx.foo_spec', 'Fx.foo_spec']]);
    assert.ok(result.json.integrity.semantic.statements[0].constants >= 2);
  });

  test('a helper in the proof folder that the statement reads, changed under unchanged statement text, is refused', () => {
    const result = realCheck(realProject({ ...REAL_HEAD, 'Fx/Proofs/Helper.lean': 'def Fx.limit : Nat := 5 + 5\n' }));
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.json.integrity.problems[0].kind, 'statement-meaning-changed');
    assert.match(result.json.integrity.problems[0].detail, /Fx\.limit, which it rests on, changed/);
  });

  test('a notation redefined in an imported file changes the elaborated statement under unchanged text, and is refused', () => {
    const notation = (body) => `notation "LIMIT" => (${body} : Nat)\n`;
    const baseFiles = {
      'Fx/Proofs/Helper.lean': notation('10'),
      'Fx/Proofs/P.lean': 'import Fx.Proofs.Helper\n\ntheorem Fx.foo_spec : LIMIT = 10 := by\n  sorry\n',
      'Fx/Specs/A.lean': 'import Fx.Proofs.P\n\nrecall Fx.foo_spec : LIMIT = 10\n\n#print axioms Fx.foo_spec\n',
    };
    const head = {
      'Fx/Proofs/P.lean': 'import Fx.Proofs.Helper\n\ntheorem Fx.foo_spec : LIMIT = 10 := rfl\n',
      'Fx/Specs/A.lean': `import Fx.Proofs.P\n\nrecall Fx.foo_spec : LIMIT = 10\n\n${GUARD_NONE('Fx.foo_spec')}`,
    };
    assert.equal(realCheck(realProject({ ...head, 'Fx/Proofs/Helper.lean': `${notation('10')}\n-- a comment\n` }, { baseFiles })).status, 0, 'the same notation is accepted');
    const result = realCheck(realProject({ ...head, 'Fx/Proofs/Helper.lean': notation('5 + 5') }, { baseFiles }));
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.json.integrity.problems[0].kind, 'statement-meaning-changed');
    assert.match(result.json.integrity.problems[0].detail, /its type changed/);
  });

  // The statement text and the spec file stay the same; only the imported helper differs between the two sides.
  const redefined = (statement, baseHelper, headHelper) => realCheck(realProject({
    'Fx/Proofs/Helper.lean': headHelper,
    'Fx/Proofs/P.lean': `import Fx.Proofs.Helper\n\ntheorem Fx.foo_spec : ${statement} := rfl\n`,
    'Fx/Specs/A.lean': `import Fx.Proofs.P\n\nrecall Fx.foo_spec : ${statement}\n\n${GUARD_NONE('Fx.foo_spec')}`,
  }, { baseFiles: {
    'Fx/Proofs/Helper.lean': baseHelper,
    'Fx/Proofs/P.lean': `import Fx.Proofs.Helper\n\ntheorem Fx.foo_spec : ${statement} := by\n  sorry\n`,
    'Fx/Specs/A.lean': `import Fx.Proofs.P\n\nrecall Fx.foo_spec : ${statement}\n\n#print axioms Fx.foo_spec\n`,
  } }));

  test('a macro redefined in an imported file changes the elaborated statement under unchanged text, and is refused', () => {
    const macro = (body) => `macro "LIMIT" : term => \`((${body} : Nat))\n`;
    const result = redefined('LIMIT = 10', macro('10'), macro('5 + 5'));
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.json.integrity.problems[0].kind, 'statement-meaning-changed');
  });

  test('an instance redefined in an imported file changes what the statement rests on, under unchanged text, and is refused', () => {
    const helper = (body) => `class Fx.HasLimit (α : Type) where\n  limit : Nat\n\ninstance Fx.instHasLimitNat : Fx.HasLimit Nat := ⟨${body}⟩\n`;
    assert.equal(redefined('@Fx.HasLimit.limit Nat _ = 10', helper('10'), `${helper('10')}\n-- a comment\n`).status, 0, 'the same instance is accepted');
    const result = redefined('@Fx.HasLimit.limit Nat _ = 10', helper('10'), helper('5 + 5'));
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.json.integrity.problems[0].kind, 'statement-meaning-changed');
    assert.match(result.json.integrity.problems[0].detail, /Fx\.instHasLimitNat, which it rests on, changed/);
  });

  test('a new Trusted axiom asserting False under a record tied to another proposition is refused; the bound one is accepted', () => {
    const trusted = (type) => `/-- Accepted assumption, \`gap-add\`. -/\naxiom Fx.gap_add_spec : ${type}\n`;
    const bound = realCheck(realProject({ ...REAL_HEAD, 'Fx/Trusted/Gaps.lean': `import Fx.Specs.Defs.Gaps\n\n${trusted('Gap')}` }));
    assert.equal(bound.status, 0, bound.stderr);
    assert.deepEqual(bound.json.integrity.semantic.bindings, [{ axiom: 'Fx.gap_add_spec', record: 'gap-add', proposition: 'Gap' }]);
    const strengthened = realCheck(realProject({ ...REAL_HEAD, 'Fx/Trusted/Gaps.lean': `import Fx.Specs.Defs.Gaps\n\n${trusted('False')}` }));
    assert.equal(strengthened.status, 1, strengthened.stderr);
    assert.ok(strengthened.json.integrity.problems.some((p) => p.kind === 'trusted-axiom-unbound' && /asserts False/.test(p.detail)), strengthened.stderr);
  });

  // The names a statement rests on come from Lean's environment, in full, and whether an axiom's type is a
  // proposition comes from Lean too. The axiom is declared in the merged spec, so only the list is in question.
  test('the allowed axioms are matched by full name; a proposition outside Trusted is refused even when listed', () => {
    const rests = ({ folder, axiom, type, statement, proof }) => realProject({
      'Fx/Proofs/P.lean': `import Fx.${folder}.Out\n\ntheorem Fx.foo_spec : ${statement} := ${proof}\n`,
      'Fx/Specs/A.lean': `import Fx.Proofs.P\n\nrecall Fx.foo_spec : ${statement}\n\n/-- 'Fx.foo_spec' depends on axioms: [${axiom}] -/\n#guard_msgs (whitespace := lax, substring := true) in\n#print axioms Fx.foo_spec\n`,
    }, { baseFiles: {
      [`Fx/${folder}/Out.lean`]: `axiom ${axiom} : ${type}\n`,
      'Fx/Proofs/P.lean': `import Fx.${folder}.Out\n\ntheorem Fx.foo_spec : ${statement} := by\n  sorry\n`,
      'Fx/Specs/A.lean': `import Fx.Proofs.P\n\nrecall Fx.foo_spec : ${statement}\n\n#print axioms Fx.foo_spec\n`,
    } });
    const allowing = (fx, ...names) => {
      const file = path.join(fx.base, 'allowed.json');
      write(file, JSON.stringify({ schema: 'fvs/auto-allowed-axioms', schemaVersion: 1, axioms: names }));
      return realCheck(fx, ['--allow-axioms', file]);
    };
    const data = { folder: 'Extraction', axiom: 'Fx.ext_value', type: 'Nat', statement: 'Fx.ext_value = Fx.ext_value', proof: 'rfl' };
    const listed = allowing(rests(data), 'Fx.ext_value');
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(listed.json.allowAxioms.names, 1);
    const unlisted = allowing(rests(data));
    assert.equal(unlisted.status, 1, unlisted.stderr);
    assert.deepEqual(unlisted.json.integrity.problems.map((p) => p.kind), ['axiom-not-allowed']);
    assert.match(unlisted.json.integrity.problems[0].detail, /rests on the axiom Fx\.ext_value, which the allowed axioms do not name/);
    assert.equal(allowing(rests(data), 'ext_value').status, 1, 'the end of a name is not the name');
    const prop = { folder: 'Extraction', axiom: 'Fx.ext_fact', type: '(10 : Nat) = 10', statement: '(10 : Nat) = 10', proof: 'Fx.ext_fact' };
    const generated = allowing(rests(prop), 'Fx.ext_fact');
    assert.equal(generated.status, 1, generated.stderr);
    assert.deepEqual(generated.json.integrity.problems.map((p) => p.kind), ['prop-axiom-outside-trusted']);
    const handWritten = allowing(rests({ ...prop, folder: 'Trusted' }), 'Fx.ext_fact');
    assert.equal(handWritten.status, 0, handWritten.stderr);
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
// The run's own externals records, or null when the checkout has none. Records of the right shape are never
// made up: a test that needs the real ones is skipped without them.
const realRecords = () => realRunState('externals.json')?.records ?? null;
const NO_RECORDS = 'the checkout has no externals.json, so the real records are not available';

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

  test('is accepted: guard blocks, docstring and prose edits, and the Trusted file under the accepted ruling', async (t) => {
    const records = realRecords();
    if (!records) return t.skip(NO_RECORDS);
    const { checkIntegrity, base, head, layout } = await load();
    const { problems, ties } = checkIntegrity({ base, head, layout, externals: () => records });
    assert.deepEqual(problems, []);
    assert.deepEqual(ties.map((tie) => tie.record).sort(), [...GAP_IDS].sort());
    assert.ok(ties.every((tie) => tie.file === 'LibcruxHmac/Formal/Trusted/CoreAllocGaps.lean'));
  });

  test('is refused once a statement is weakened, a Defs body changes, or the ruling is missing', async (t) => {
    const records = realRecords();
    if (!records) return t.skip(NO_RECORDS);
    const { checkIntegrity, memoryTree, base, head, layout } = await load();
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
    const records = realRecords();
    if (!records) return t.skip(NO_RECORDS);
    const open = records.find((record) => record.status !== 'assumption-accepted');
    if (!open) return t.skip('the checkout has no externals record that is still open');
    const { checkIntegrity, memoryTree, base, head, layout } = await load();
    const file = 'LibcruxHmac/Formal/Trusted/CoreAllocGaps.lean';
    const copy = new Map(head);
    copy.set(file, memoryTree({ [file]: head.get(file).text().replaceAll('gap-core-u32-wrapping-div', open.id) }).get(file));
    const { problems } = checkIntegrity({ base, head: copy, layout, externals: () => records });
    assert.deepEqual(problems.map((p) => [p.kind, p.file]), [['trusted-axiom-untied', file]]);
  });

  // The engine lists full names and the Lean program reports full names. The guards in the spec files print
  // names relative to `namespace libcrux_hmac`, so here each printed name is resolved to the one declared name
  // it ends, and the Lean program's report is built from the files: an axiom declared under a Trusted folder
  // asserts something (a proposition), one in the extraction is a function, type or constant (measured with the
  // real Lean program on this run).
  test('the real statements pass the allowed-axioms check with the full names of what the extraction and Trusted files declare, and only with those', async () => {
    const { gitTree, readSpecSource, parseDump, allowedProblems, readAllowedAxioms } = await library();
    const head = gitTree(REAL.repo, REAL.head, '');
    const declared = new Map();
    const statements = new Map();
    const standard = ['propext', 'Classical.choice', 'Quot.sound'];
    for (const [rel, entry] of head) {
      if (!rel.endsWith('.lean')) continue;
      const text = entry.text();
      for (const statement of readSpecSource(text).statements) statements.set(statement.name, { rel, printed: (statement.axioms ?? []).filter((name) => !standard.includes(name)) });
      if (!/\/(Extraction|Trusted)\//.test(rel)) continue;
      // Aeneas puts `axiom` on one line and the name on the next, so the scan reads across lines.
      const namespaces = [];
      for (const match of text.matchAll(/^(?:namespace\s+(\S+)|(end)\s+\S+|(?:@\[[^\]]*\]\s*)?axiom\s+(\S+))/gm)) {
        if (match[1]) namespaces.push(match[1]);
        else if (match[2]) namespaces.pop();
        else declared.set([...namespaces, match[3]].join('.'), rel);
      }
    }
    const full = (printed) => {
      const hits = [...declared.keys()].filter((name) => name === printed || name.endsWith(`.${printed}`));
      assert.equal(hits.length, 1, `${printed} ends exactly one declared axiom`);
      return hits[0];
    };
    const resting = new Map([...statements].map(([name, { printed }]) => [name, printed.map(full)]));
    const used = new Set([...resting.values()].flat());
    assert.ok(statements.size >= 30 && used.size >= 70, `${statements.size} statements rest on ${used.size} non-standard axioms`);
    const target = 'libcrux_hmac.libcrux_sha2.hacl.hash_256';
    assert.ok(used.has(target));
    const dump = (asserting = (rel) => /\/Trusted\//.test(rel)) => parseDump(leanDump({
      recalls: Object.fromEntries([...resting].map(([name, axioms]) => [name, { axioms: [...standard, ...axioms] }])),
      constants: [...declared].map(([name, rel]) => constant(name, { k: 'axiom', m: rel.replace(/\.lean$/, '').replaceAll('/', '.'), t: 'type', v: undefined, pr: asserting(rel) })),
    }));
    const recalledFiles = new Map([...statements].map(([name, { rel }]) => [name, [rel]]));
    const list = (names) => ({ names: new Set(names), crates: null });
    const problems = (names, head = dump()) => allowedProblems({ head, recalledFiles, allowed: list(names) });

    assert.deepEqual(problems([...used]), [], 'the names the statements rest on, in full, cover them all');
    assert.deepEqual(problems([...declared.keys()]), [], 'so do all the declared axioms');
    const without = problems([...used].filter((name) => name !== target));
    assert.ok(without.length >= 1 && without.every((problem) => problem.kind === 'axiom-not-allowed' && problem.detail.includes(target)), 'the axiom left out is named, and nothing else is refused');
    assert.equal(new Set(without.map((problem) => problem.statement)).size, [...resting.values()].filter((axioms) => axioms.includes(target)).length);
    const printed = new Set([...statements.values()].flatMap((statement) => statement.printed));
    assert.equal(problems([...printed]).length, [...resting.values()].filter((axioms) => axioms.length > 0).length, 'names as the guards print them are not the names Lean reports: every statement with an axiom is refused');
    const asserting = problems([...used], dump((rel) => rel === declared.get(target)));
    assert.ok(asserting.length >= 1 && asserting.every((problem) => problem.kind === 'prop-axiom-outside-trusted' && problem.detail.includes('declared outside Trusted/')), 'an extraction axiom whose type is a proposition is refused even though it is listed');

    // One crate holds every spec file here: its list is the list, and a spec file under no crate is refused.
    const files = [...new Set([...statements.values()].map((statement) => statement.rel))];
    const crates = (specFiles, axioms) => readAllowedAxioms(JSON.stringify({ schema: 'fvs/auto-allowed-axioms', schemaVersion: 2, crates: [{ crate: 'libcrux_hmac', specFiles, axioms }] }));
    assert.deepEqual(allowedProblems({ head: dump(), recalledFiles, allowed: crates(files, [...used]) }), []);
    const partial = allowedProblems({ head: dump(), recalledFiles, allowed: crates(files.slice(1), [...used]) });
    assert.deepEqual([...new Set(partial.map((problem) => problem.kind))], ['allowed-axioms-crate-unknown']);
    assert.deepEqual([...new Set(partial.map((problem) => problem.file))], [files[0]]);
  });
});
