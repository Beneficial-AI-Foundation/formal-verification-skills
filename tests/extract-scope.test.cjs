'use strict';

// The scope of an extraction is recorded by prepare, with or without the release, and a single
// crate is never inferred from missing data: with the release cargo says how many library crates
// the checkout holds; without it a static scan claims a single crate only when the manifests
// positively show a lone package, and anything cargo could read differently is unknown. An attempt
// refuses an unknown scope and carries the scope it was made under.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { RELEASE, toySpec, cleanup, workspace, run, attempted, specFile } = require('./helpers/fake-multicrate-tools.cjs');

after(cleanup);

let copies = 0;
const prepare = (ws, withRelease) => {
  const out = path.join(ws.root, 'copies', `scope-${(copies += 1)}`);
  const result = run(ws, ['prepare', '--project-root', ws.project, '--out', out, ...(withRelease ? ['--release', RELEASE] : [])]);
  return { out, result };
};
const scopeOf = (prepared) => {
  assert.equal(prepared.result.status, 0, prepared.result.stdout);
  return prepared.result.result.manifest.scope;
};

const write = (ws, file, text) => {
  fs.mkdirSync(path.dirname(path.join(ws.project, file)), { recursive: true });
  fs.writeFileSync(path.join(ws.project, file), text);
};

// A project that is one plain package, with the manifest and an optional extra file of the caller's.
const SOLO = '[package]\nname = "toy-solo"\nversion = "0.1.0"\nedition = "2021"\n';
function solo({ manifest = SOLO, extra = {}, inputs = ['Cargo.toml', 'Cargo.lock', 'src'] } = {}) {
  const ws = workspace();
  fs.rmSync(path.join(ws.project, 'app'), { recursive: true });
  fs.rmSync(path.join(ws.project, 'lib'), { recursive: true });
  write(ws, 'Cargo.toml', manifest);
  write(ws, 'src/lib.rs', 'pub fn solo() -> u32 { 1 }\n');
  for (const [file, text] of Object.entries(extra)) write(ws, file, text);
  write(ws, '.formalising/fvs-config.json', JSON.stringify({ extraction: { inputs } }));
  return ws;
}

describe('the scope prepare records', () => {
  it('names a two-member workspace prepared without the release unknown, and no attempt takes it for a single crate', () => {
    const ws = workspace();
    const prepared = prepare(ws, false);
    const scope = scopeOf(prepared);
    assert.equal(scope.kind, 'unknown');
    assert.equal(scope.basis, 'none');
    assert.match(scope.reason, /the inputs hold 3 Cargo\.toml files \(Cargo\.toml, app\/Cargo\.toml, lib\/Cargo\.toml\), and a single crate is not established without cargo; prepare with --release DIR/);
    // The manifest is what status shows, so a reader that never sees an attempt still sees the scope.
    assert.deepEqual(run(ws, ['status', '--out', prepared.out]).result.manifest.scope, scope);

    for (const spec of [{ release: RELEASE, cargoArgs: ['--locked'], crate: 'toy_app', publishDir: 'Lean/App', moduleRoot: 'Toy.App' }, { release: RELEASE }]) {
      const refused = run(ws, ['attempt', '--out', prepared.out, '--spec', specFile(ws, spec)]);
      assert.equal(refused.status, 8, refused.stdout);
      assert.match(refused.result.message, /the scope of this extraction is not established .* an attempt never takes an unknown scope for a single crate; prepare a new copy with --release DIR/);
      assert.equal(refused.result.scope?.kind, 'unknown');
      assert.equal(fs.existsSync(path.join(prepared.out, 'attempt.json')), false, 'a refused attempt records nothing');
    }
    // The aggregate form needs the inventory, which only the release gives.
    const aggregate = run(ws, ['attempt', '--out', prepared.out, '--spec', specFile(ws, toySpec())]);
    assert.equal(aggregate.status, 8, aggregate.stdout);
    assert.match(aggregate.result.message, /prepared without --release, so it records no workspace inventory/);
  });

  it('records the multi-crate scope from cargo with the release, with the library crates the coverage gate counts', () => {
    const ws = workspace();
    const prepared = prepare(ws, true);
    const scope = scopeOf(prepared);
    assert.deepEqual(scope, { kind: 'multi-crate', basis: 'cargo', libraryCrates: ['toy_app', 'toy_lib'] });
    const inventory = prepared.result.result.manifest.workspace.original.crates.filter((row) => row.library).map((row) => row.crate).sort();
    assert.deepEqual(scope.libraryCrates, inventory);
  });

  it('claims a single crate without the release only for a plain lone package, and cargo agrees on every such fixture', () => {
    const fixtures = {
      plain: {},
      'a library path': { manifest: `${SOLO}\n[lib]\npath = "src/lib.rs"\n` },
      'a binary path': { manifest: `${SOLO}\n[[bin]]\nname = "solo-bin"\npath = "src/main.rs"\n`, extra: { 'src/main.rs': 'fn main() {}\n' } },
      'registry dependencies': { manifest: `${SOLO}\n[dependencies]\nrand_core = "0.9"\n\n[dev-dependencies.tempfile]\nversion = "3"\n` },
    };
    for (const [name, options] of Object.entries(fixtures)) {
      const ws = solo(options);
      const scanned = scopeOf(prepare(ws, false));
      assert.deepEqual(scanned, { kind: 'single-crate', basis: 'manifest', manifest: 'Cargo.toml' }, name);
      const cargo = scopeOf(prepare(ws, true));
      assert.equal(cargo.kind, 'single-crate', `${name}: cargo agrees`);
      assert.equal(cargo.basis, 'cargo');
      assert.deepEqual(cargo.libraryCrates, ['toy_solo'], name);
    }
  });

  it('is unknown without the release wherever cargo could read the project differently, and says why', () => {
    const cases = [
      ['a [workspace] table', { manifest: `${SOLO}\n[workspace]\nmembers = []\n` }, /has a \[workspace\] table/],
      ['workspace inheritance in a dotted key', { manifest: '[package]\nname = "toy-solo"\nversion.workspace = true\nedition = "2021"\n' }, /inherits from or names a workspace \(version\.workspace\)/],
      ['a package workspace key', { manifest: `${SOLO}workspace = "../"\n` }, /inherits from or names a workspace \(workspace\)/],
      ['an inherited dependency', { manifest: `${SOLO}\n[dependencies]\nserde = { workspace = true }\n` }, /inherits from or names a workspace \(serde\)/],
      ['a path dependency in an inline table', { manifest: `${SOLO}\n[dependencies]\ndep = { path = "../dep" }\n` }, /has a path dependency \(dependencies\.dep\)/],
      ['a path dependency in its own table', { manifest: `${SOLO}\n[dependencies.dep]\npath = "../dep"\n` }, /has a path dependency \(dependencies\.dep\.path\)/],
      ['a dotted path dependency', { manifest: `${SOLO}\n[build-dependencies]\ndep.path = "../dep"\n` }, /has a path dependency \(build-dependencies\.dep\.path\)/],
      ['a patch table', { manifest: `${SOLO}\n[patch.crates-io]\nfoo = { path = "../foo" }\n` }, /has a \[patch\.crates-io\] table/],
      ['a second manifest among the inputs', { extra: { 'extra/Cargo.toml': SOLO.replace('toy-solo', 'toy-extra'), 'extra/src/lib.rs': '' }, inputs: ['Cargo.toml', 'Cargo.lock', 'src', 'extra'] }, /the inputs hold 2 Cargo\.toml files \(Cargo\.toml, extra\/Cargo\.toml\)/],
      ['a manifest the line reader cannot read', { manifest: `${SOLO}this line is neither a table nor a key\n` }, /is a manifest the scan cannot read line by line/],
      ['no package table', { manifest: '[lib]\nname = "x"\n' }, /has no \[package\] table/],
    ];
    for (const [name, options, why] of cases) {
      const scope = scopeOf(prepare(solo(options), false));
      assert.equal(scope.kind, 'unknown', name);
      assert.equal(scope.basis, 'none', name);
      assert.match(scope.reason, why, name);
      assert.match(scope.reason, /prepare with --release DIR so that cargo reads the workspace$/, name);
    }
  });

  it('is unknown when a directory above the project or the copy holds a workspace manifest', () => {
    const above = solo();
    write({ project: above.root }, 'Cargo.toml', '[workspace]\nmembers = ["project"]\n');
    const scope = scopeOf(prepare(above, false));
    assert.equal(scope.kind, 'unknown');
    assert.match(scope.reason, new RegExp(`${above.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/Cargo\\.toml, above the project, is a workspace manifest`));

    // A manifest above that is not a workspace does not stop a single crate.
    const plain = solo();
    write({ project: plain.root }, 'Cargo.toml', '[package]\nname = "unrelated"\nversion = "0.1.0"\n');
    assert.equal(scopeOf(prepare(plain, false)).kind, 'single-crate');
  });

  it('treats a manifest without a scope as unknown, so an older copy is never a single crate by default', () => {
    const ws = solo();
    const prepared = prepare(ws, false);
    scopeOf(prepared);
    const file = path.join(prepared.out, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete manifest.scope;
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    const refused = run(ws, ['attempt', '--out', prepared.out, '--spec', specFile(ws, { release: RELEASE })]);
    assert.equal(refused.status, 8, refused.stdout);
    assert.match(refused.result.message, /the copy records no scope \(it was prepared before the scope was recorded\)/);
  });
});

describe('the scope an attempt carries', () => {
  it('copies the manifest scope into the attempt, every unit and the status of a multi-crate run', () => {
    const ws = workspace();
    const { out, recorded } = attempted(ws);
    assert.equal(recorded.status, 0, recorded.stdout);
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    assert.equal(manifest.scope.kind, 'multi-crate');
    assert.deepEqual(recorded.result.attempt.scope, manifest.scope);
    for (const crate of ['toy_lib', 'toy_app']) {
      const unit = JSON.parse(fs.readFileSync(path.join(out, 'units', crate, 'attempt.json'), 'utf8'));
      assert.deepEqual(unit.scope, manifest.scope, `${crate} records the scope it was attempted under`);
    }
  });

  it('refuses an attempt record whose scope differs from the manifest', () => {
    const ws = workspace();
    const { out } = attempted(ws);
    const file = path.join(out, 'attempt.json');
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    record.scope = { kind: 'single-crate', basis: 'manifest', manifest: 'Cargo.toml' };
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    const refused = run(ws, ['attempt-status', '--out', out]);
    assert.equal(refused.status, 8, refused.stdout);
    assert.match(refused.result.message, /the scope recorded in the attempt differs from the scope in the manifest/);
  });

  it('records the single-crate scope of a lone crate in its attempt', () => {
    const ws = solo();
    const prepared = prepare(ws, false);
    const manifestScope = scopeOf(prepared);
    const recorded = run(ws, ['attempt', '--out', prepared.out, '--spec', specFile(ws, { release: RELEASE, cargoArgs: ['--locked'], crate: 'toy_solo', publishDir: 'Lean/Solo', moduleRoot: 'Toy.Solo' })]);
    assert.equal(recorded.status, 0, recorded.stdout);
    assert.deepEqual(recorded.result.attempt.scope, manifestScope);
    assert.equal(recorded.result.attempt.scope.kind, 'single-crate');
  });
});
