'use strict';

// Patch-mode extraction engine: ordered translation patches applied in a
// disposable copy of the Rust input set, never in the original checkout.
// Fixtures are a tiny crate plus `git diff -W` patches; no Rust toolchain runs.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'fvs-extract-patches.mjs');
const FIXTURES = path.join(__dirname, 'fixtures', 'extract-patches');
const TMP = fs.realpathSync(os.tmpdir());
const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(TMP, prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// A project root holding the fixture crate and the named fixture patches. The
// engine applies patches in file-name order, so a numeric prefix declares the
// order given here.
function project(patches = [], { config } = {}) {
  const root = temporaryDirectory('fvs-extract-project-');
  fs.cpSync(path.join(FIXTURES, 'crate'), root, { recursive: true });
  if (patches.length > 0) fs.mkdirSync(path.join(root, 'translation-patches'));
  patches.forEach((name, index) => {
    fs.copyFileSync(
      path.join(FIXTURES, 'patches', `${name}.patch`),
      path.join(root, 'translation-patches', `${String(index + 1).padStart(2, '0')}-${name}.patch`),
    );
  });
  if (config) {
    fs.mkdirSync(path.join(root, '.formalising'));
    fs.writeFileSync(path.join(root, '.formalising', 'fvs-config.json'), JSON.stringify(config));
  }
  return root;
}

function outDirectory() {
  return path.join(temporaryDirectory('fvs-extract-out-'), 'copy');
}

function run(...args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    // left null: the assertion on json reports the raw output
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

// Every entry under root with its mode and content (or link target).
function snapshot(root) {
  const entries = {};
  (function walk(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) entries[relative] = `link:${fs.readlinkSync(absolute)}`;
      else if (stat.isDirectory()) walk(absolute);
      else entries[relative] = `${(stat.mode & 0o777).toString(8)}:${sha256(fs.readFileSync(absolute))}`;
    }
  })(root);
  return entries;
}

function readManifest(out) {
  return JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
}

const PRISTINE_LIMITS = fs.readFileSync(path.join(FIXTURES, 'crate', 'src', 'limits.rs'));

const PATCHED_LIMITS = [
  'use core::cmp::Ordering;',
  '',
  'pub fn clamp(x: u32) -> u32 {',
  '    match x.cmp(&100) {',
  '        Ordering::Greater => 100,',
  '        _ => x,',
  '    }',
  '}',
  '',
  'pub fn halve(x: u32) -> u32 {',
  '    x / 2',
  '}',
  '',
].join('\n');

describe('fvs-extract-patches: clean ordered extraction', () => {
  it('applies the patches first to last in a disposable copy and records a manifest', () => {
    const root = project(['limits-imports', 'limits-clamp', 'lib-double']);
    const before = snapshot(root);
    const out = outDirectory();

    const prepared = run('prepare', '--project-root', root, '--out', out);
    assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
    assert.equal(prepared.json.ok, true);

    const manifest = readManifest(out);
    assert.equal(manifest.status, 'prepared');
    assert.equal(manifest.mode, 'translation-patches');
    assert.deepEqual(manifest.source.inputs, ['Cargo.toml', 'src']);
    assert.deepEqual(Object.keys(manifest.source.files).sort(), ['Cargo.toml', 'src/lib.rs', 'src/limits.rs']);
    assert.deepEqual(
      manifest.patches.map(patch => [patch.file, patch.kind]),
      [
        ['01-limits-imports.patch', 'supporting'],
        ['02-limits-clamp.patch', 'translation'],
        ['03-lib-double.patch', 'translation'],
      ],
    );
    assert.equal(
      manifest.patches[0].sha256,
      sha256(fs.readFileSync(path.join(FIXTURES, 'patches', 'limits-imports.patch'))),
    );
    // Per-patch pre and post state; the dependent patch starts from its predecessor's result.
    assert.equal(manifest.patches[0].pre['src/limits.rs'].sha256, sha256(PRISTINE_LIMITS));
    assert.deepEqual(manifest.patches[1].pre, manifest.patches[0].post);
    assert.equal(manifest.patches[1].post['src/limits.rs'].sha256, sha256(PATCHED_LIMITS));

    assert.equal(fs.readFileSync(path.join(out, 'tree', 'src', 'limits.rs'), 'utf8'), PATCHED_LIMITS);
    assert.match(fs.readFileSync(path.join(out, 'tree', 'src', 'lib.rs'), 'utf8'), /x\.wrapping_mul\(2\)/);
    assert.deepEqual(snapshot(root), before, 'the original checkout changed');

    const restored = run('verify-restore', '--out', out);
    assert.equal(restored.status, 0, restored.stdout);
    assert.equal(restored.json.ok, true);

    const status = run('status', '--out', out);
    assert.equal(status.status, 0, status.stdout);
    assert.equal(status.json.manifest.status, 'prepared');
  });

  it('checks the patch list without writing anything into the project', () => {
    const root = project(['limits-imports', 'limits-clamp', 'lib-double']);
    const before = snapshot(root);
    const checked = run('check', '--project-root', root);
    assert.equal(checked.status, 0, checked.stderr + checked.stdout);
    assert.equal(checked.json.ok, true);
    assert.deepEqual(checked.json.patches.map(patch => patch.file),
      ['01-limits-imports.patch', '02-limits-clamp.patch', '03-lib-double.patch']);
    assert.deepEqual(snapshot(root), before);
  });
});

describe('fvs-extract-patches: stale and already-applied patches', () => {
  function assertRefusedUntouched(root, kind, patch, index) {
    const before = snapshot(root);
    const checked = run('check', '--project-root', root);
    assert.equal(checked.status, 1, checked.stdout);
    assert.deepEqual([checked.json.code, checked.json.kind, checked.json.patch, checked.json.index],
      ['stale', kind, patch, index]);
    const prepared = run('prepare', '--project-root', root, '--out', outDirectory());
    assert.equal(prepared.status, 1, prepared.stdout);
    assert.equal(prepared.json.kind, kind);
    assert.deepEqual(snapshot(root), before, 'the original checkout changed');
  }

  it('refuses a patch written against other source', () => {
    assertRefusedUntouched(project(['limits-halve']), 'stale', '01-limits-halve.patch', 0);
  });

  it('refuses a patch whose change the original source already carries', () => {
    const root = project(['lib-double']);
    const lib = path.join(root, 'src', 'lib.rs');
    fs.writeFileSync(lib, fs.readFileSync(lib, 'utf8').replace('x.wrapping_add(x)', 'x.wrapping_mul(2)'));
    assertRefusedUntouched(root, 'already-applied', '01-lib-double.patch', 0);
  });

  it('refuses a patch that an earlier patch in the list already applied', () => {
    assertRefusedUntouched(project(['lib-double', 'lib-double']), 'already-applied', '02-lib-double.patch', 1);
  });
});

describe('fvs-extract-patches: failure part-way through the list', () => {
  it('keeps the original and its evidence intact and records the copy as partial', () => {
    const root = project(['limits-imports', 'limits-clamp', 'limits-halve', 'lib-double']);
    fs.writeFileSync(path.join(root, 'src-assumptions.md'), '# Source assumptions\n\n- A1: `halve` is total.\n');
    const gate = path.join(root, '.formalising', 'extract', 'fixture', 'equivalence-gate');
    fs.mkdirSync(gate, { recursive: true });
    fs.writeFileSync(path.join(gate, 'M1.md'), 'equivalence-ratified: owner 2026-10-01\n');
    const before = snapshot(root);
    const out = outDirectory();

    const prepared = run('prepare', '--project-root', root, '--out', out);
    assert.equal(prepared.status, 1, prepared.stdout);

    const manifest = readManifest(out);
    assert.equal(manifest.status, 'partial');
    assert.deepEqual(manifest.patches.map(patch => patch.file), ['01-limits-imports.patch', '02-limits-clamp.patch']);
    assert.ok(manifest.patches.every(patch => patch.pre && patch.post));
    assert.deepEqual([manifest.failure.code, manifest.failure.patch, manifest.failure.index],
      ['stale', '03-limits-halve.patch', 2]);
    assert.deepEqual(snapshot(root), before, 'the original source or its evidence changed');

    const status = run('status', '--out', out);
    assert.equal(status.status, 6, status.stdout);
    assert.equal(status.json.ok, false);
    assert.equal(status.json.code, 'partial');

    assert.equal(run('verify-restore', '--out', out).status, 0);
  });
});

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture',
    '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

describe('fvs-extract-patches: dirty originals', () => {
  it('copies uncommitted sources as they are, records them, and leaves them untouched', () => {
    const root = project(['lib-double']);
    git(root, 'init', '-q');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'fixture');
    const commit = git(root, 'rev-parse', 'HEAD');
    const lib = path.join(root, 'src', 'lib.rs');
    const dirtyLib = `${fs.readFileSync(lib, 'utf8')}\npub fn local_edit() {}\n`;
    fs.writeFileSync(lib, dirtyLib);
    fs.writeFileSync(path.join(root, 'src', 'scratch.rs'), 'pub fn untracked() {}\n');
    const before = snapshot(root);
    const out = outDirectory();

    const prepared = run('prepare', '--project-root', root, '--out', out);
    assert.equal(prepared.status, 0, prepared.stdout);
    const manifest = readManifest(out);
    assert.equal(manifest.source.commit, commit);
    assert.deepEqual(manifest.source.dirty, ['src/lib.rs', 'src/scratch.rs']);
    assert.equal(manifest.source.files['src/lib.rs'].sha256, sha256(dirtyLib));
    assert.ok(manifest.source.files['src/scratch.rs']);
    const copied = fs.readFileSync(path.join(out, 'tree', 'src', 'lib.rs'), 'utf8');
    assert.match(copied, /pub fn local_edit\(\) \{\}/);
    assert.match(copied, /x\.wrapping_mul\(2\)/);
    assert.deepEqual(snapshot(root), before, 'the dirty original or its git metadata changed');
  });
});

describe('fvs-extract-patches: overlapping patches', () => {
  // The `sum` signature hunk carries the last line of `double` as context, so
  // the two patches overlap and only one order works for a given pair.
  it('follows the declared order for patches whose hunks overlap', () => {
    assert.equal(run('check', '--project-root', project(['lib-double', 'lib-sum-array-after-double'])).status, 0);
    const reversed = run('check', '--project-root', project(['lib-sum-array-after-double', 'lib-double']));
    assert.equal(reversed.status, 1, reversed.stdout);
    assert.deepEqual([reversed.json.kind, reversed.json.index], ['stale', 0]);
  });

  it('checks each patch against its predecessor state, not the pristine source', () => {
    assert.equal(run('check', '--project-root', project(['lib-sum-array'])).status, 0);
    const checked = run('check', '--project-root', project(['lib-double', 'lib-sum-array']));
    assert.equal(checked.status, 1, checked.stdout);
    assert.deepEqual([checked.json.kind, checked.json.patch], ['stale', '02-lib-sum-array.patch']);
  });

  it('tests a patch on its own only when it declares Independent: yes', () => {
    const root = project(['lib-double', 'lib-sum-array-after-double']);
    const patch = path.join(root, 'translation-patches', '02-lib-sum-array-after-double.patch');
    fs.writeFileSync(patch, fs.readFileSync(patch, 'utf8').replace('Behaviour:', 'Independent: yes\nBehaviour:'));
    const checked = run('check', '--project-root', root);
    assert.equal(checked.status, 1, checked.stdout);
    assert.deepEqual([checked.json.kind, checked.json.patch], ['not-independent', '02-lib-sum-array-after-double.patch']);

    const declared = run('check', '--project-root', project(['limits-imports', 'limits-clamp', 'lib-double', 'lib-sum']));
    assert.equal(declared.status, 0, declared.stdout);
    assert.deepEqual(declared.json.patches.map(entry => entry.independent), [false, false, true, true]);
  });
});

describe('fvs-extract-patches: extraction mode', () => {
  const LEDGER = 'diff --git a/src/lib.rs b/src/lib.rs\n';

  function withLedger(root) {
    fs.writeFileSync(path.join(root, 'src-modifications.diff'), LEDGER);
    return root;
  }

  it('refuses a legacy ledger alongside an active patch list and touches neither', () => {
    for (const root of [
      withLedger(project(['lib-double'], { config: { extraction: { mode: 'translation-patches' } } })),
      withLedger(project(['lib-double'])),
      project(['lib-double'], { config: { extraction: { mode: 'legacy-source-ledger' } } }),
    ]) {
      const before = snapshot(root);
      const out = outDirectory();
      const prepared = run('prepare', '--project-root', root, '--out', out);
      assert.equal(prepared.status, 4, prepared.stdout);
      assert.equal(prepared.json.code, 'mixed-mode');
      assert.match(prepared.json.message, /mixed/);
      assert.equal(fs.existsSync(out), false, 'a refused run created the extraction copy');
      assert.deepEqual(snapshot(root), before);
    }
    const named = run('check', '--project-root', withLedger(project(['lib-double'])));
    assert.match(named.json.message, /src-modifications\.diff/);
  });

  it('keeps a legacy-ledger project on the legacy interpretation until it migrates', () => {
    for (const root of [
      withLedger(project()),
      project([], { config: { extraction: { mode: 'legacy-source-ledger' } } }),
    ]) {
      const checked = run('check', '--project-root', root);
      assert.equal(checked.status, 4, checked.stdout);
      assert.equal(checked.json.code, 'legacy-mode');
      assert.equal(checked.json.mode, 'legacy-source-ledger');
    }
    const migrated = run('check', '--project-root', project([], { config: { extraction: { mode: 'translation-patches' } } }));
    assert.equal(migrated.status, 0, migrated.stdout);
  });

  it('rejects an unknown extraction mode', () => {
    const checked = run('check', '--project-root', project([], { config: { extraction: { mode: 'patches' } } }));
    assert.equal(checked.status, 5, checked.stdout);
    assert.equal(checked.json.code, 'invalid-input');
  });
});

describe('fvs-extract-patches: copy boundary', () => {
  it('rejects a symbolic link in the input set instead of following it', () => {
    const outside = temporaryDirectory('fvs-extract-outside-');
    fs.writeFileSync(path.join(outside, 'shared.rs'), 'pub fn shared() {}\n');
    const fileLink = project(['lib-double']);
    fs.symlinkSync(path.join(outside, 'shared.rs'), path.join(fileLink, 'src', 'shared.rs'));
    const directoryLink = project([], { config: { extraction: { inputs: ['Cargo.toml', 'linked'] } } });
    fs.symlinkSync(outside, path.join(directoryLink, 'linked'));

    for (const [root, link] of [[fileLink, 'src/shared.rs'], [directoryLink, 'linked']]) {
      const before = snapshot(root);
      const out = outDirectory();
      const prepared = run('prepare', '--project-root', root, '--out', out);
      assert.equal(prepared.status, 5, prepared.stdout);
      assert.deepEqual([prepared.json.code, prepared.json.kind, prepared.json.path], ['invalid-input', 'symlink', link]);
      assert.equal(fs.existsSync(out), false);
      assert.deepEqual(snapshot(root), before);
    }
    assert.equal(fs.readFileSync(path.join(outside, 'shared.rs'), 'utf8'), 'pub fn shared() {}\n');
  });

  it('rejects a patch that touches a file outside the recorded input set', () => {
    const root = project(['lib-double'], { config: { extraction: { inputs: ['Cargo.toml', 'src/limits.rs'] } } });
    const checked = run('check', '--project-root', root);
    assert.equal(checked.status, 5, checked.stdout);
    assert.equal(checked.json.code, 'invalid-input');
    assert.match(checked.json.message, /src\/lib\.rs/);
  });

  it('refuses an extraction copy inside the project checkout', () => {
    const root = project(['lib-double']);
    const prepared = run('prepare', '--project-root', root, '--out', path.join(root, 'extract-copy'));
    assert.equal(prepared.status, 5, prepared.stdout);
    assert.equal(fs.existsSync(path.join(root, 'extract-copy')), false);
  });

  it('patches the copy even when the copy sits inside another git repository', () => {
    const enclosing = temporaryDirectory('fvs-extract-enclosing-');
    git(enclosing, 'init', '-q');
    const out = path.join(enclosing, 'copy');
    const prepared = run('prepare', '--project-root', project(['lib-double']), '--out', out);
    assert.equal(prepared.status, 0, prepared.stdout);
    assert.match(fs.readFileSync(path.join(out, 'tree', 'src', 'lib.rs'), 'utf8'), /x\.wrapping_mul\(2\)/);
  });
});

describe('fvs-extract-patches: restoration check', () => {
  it('compares the touched original sources byte for byte and mode for mode', () => {
    const root = project(['lib-double']);
    const out = outDirectory();
    assert.equal(run('prepare', '--project-root', root, '--out', out).status, 0);
    const lib = path.join(root, 'src', 'lib.rs');
    const original = fs.readFileSync(lib);

    fs.writeFileSync(lib, Buffer.concat([original, Buffer.from(' ')]));
    const edited = run('verify-restore', '--out', out);
    assert.equal(edited.status, 3, edited.stdout);
    assert.deepEqual([edited.json.code, edited.json.changed], ['dirty-original', ['src/lib.rs']]);

    fs.writeFileSync(lib, original);
    fs.chmodSync(lib, 0o755);
    const chmodded = run('verify-restore', '--out', out);
    assert.equal(chmodded.status, 3, chmodded.stdout);
    assert.deepEqual(chmodded.json.changed, ['src/lib.rs']);

    fs.chmodSync(lib, 0o644);
    assert.equal(run('verify-restore', '--out', out).status, 0);
  });

  it('records and undoes a patch that changes only a file mode', () => {
    const root = project(['limits-mode']);
    assert.equal(run('check', '--project-root', root).status, 0);
    const out = outDirectory();
    const prepared = run('prepare', '--project-root', root, '--out', out);
    assert.equal(prepared.status, 0, prepared.stdout);
    const [record] = readManifest(out).patches;
    assert.deepEqual([record.pre['src/limits.rs'].mode, record.post['src/limits.rs'].mode], ['644', '755']);
    assert.equal(record.pre['src/limits.rs'].sha256, record.post['src/limits.rs'].sha256);
    assert.equal(fs.statSync(path.join(out, 'tree', 'src', 'limits.rs')).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(root, 'src', 'limits.rs')).mode & 0o777, 0o644);
  });
});

describe('fvs-extract-patches: patch file convention', () => {
  it('rejects a patch without the Change, Why and Behaviour header', () => {
    const root = project(['lib-double']);
    const patch = path.join(root, 'translation-patches', '01-lib-double.patch');
    const body = fs.readFileSync(patch, 'utf8');
    fs.writeFileSync(patch, body.slice(body.indexOf('diff --git')));
    const checked = run('check', '--project-root', root);
    assert.equal(checked.status, 5, checked.stdout);
    assert.deepEqual(checked.json.missing, ['Change', 'Why', 'Behaviour']);
  });

  it('reports in plain text when asked', () => {
    const checked = run('check', '--project-root', project(['limits-halve']), '--format', 'text');
    assert.equal(checked.status, 1);
    assert.match(checked.stdout, /^FVS >> stale: 01-limits-halve\.patch does not apply/);
  });
});

describe('fvs-extract-patches: dependent patches', () => {
  it('applies a dependent patch only on the state its predecessor leaves', () => {
    const checked = run('check', '--project-root', project(['lib-double', 'lib-double-shift']));
    assert.equal(checked.status, 0, checked.stdout);
    assert.deepEqual(checked.json.patches[1].pre, checked.json.patches[0].post);
  });

  it('fails loud on the reversed order and searches no other order', () => {
    const root = project(['lib-double-shift', 'lib-double']);
    const before = snapshot(root);
    const checked = run('check', '--project-root', root);
    assert.equal(checked.status, 1, checked.stdout);
    assert.equal(checked.json.code, 'stale');
    assert.equal(checked.json.kind, 'stale');
    assert.equal(checked.json.patch, '01-lib-double-shift.patch');
    assert.equal(checked.json.index, 0);

    const out = outDirectory();
    const prepared = run('prepare', '--project-root', root, '--out', out);
    assert.equal(prepared.status, 1, prepared.stdout);
    assert.equal(readManifest(out).status, 'partial');
    assert.deepEqual(readManifest(out).patches, []);
    assert.deepEqual(snapshot(root), before);
  });
});
