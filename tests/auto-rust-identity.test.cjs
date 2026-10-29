'use strict';

// Rust identity record: every local Rust function of one extraction mapped to its
// Lean definitions by Charon def_id, bound to that extraction's provenance.
// The positive case reads recorded outputs of the pinned tools
// (fixtures/auto-rust-identity/qualified-run1); each negative case is a labelled
// mutation of a copy of those outputs. No probe, Charon, Aeneas or Lean runs here.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'fvs-rust-identity.mjs');
const RUN1 = path.join(__dirname, 'fixtures', 'auto-rust-identity', 'qualified-run1');
const COMMIT = 'fac7cf2c1672e7db2b5176ef616e4c86ec3baab8';
const FILES = ['translation.json', 'manifest.json', 'rust.json', 'translations.json', 'lean.json', 'functions.json'];
const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

const read = (name) => JSON.parse(fs.readFileSync(path.join(RUN1, name), 'utf8'));
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// A copy of the recorded run with `mutate(json)` applied to the named files.
// `mutations` maps a file name to a function returning the new JSON value, or to
// null to delete the file, or to a string to write raw bytes.
function inputs(mutations = {}) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fvs-rust-identity-'));
  temporaryDirectories.push(dir);
  for (const name of FILES) {
    const change = mutations[name];
    if (change === null) continue;
    if (change === undefined) fs.copyFileSync(path.join(RUN1, name), path.join(dir, name));
    else if (typeof change === 'string') fs.writeFileSync(path.join(dir, name), change);
    else fs.writeFileSync(path.join(dir, name), `${JSON.stringify(change(read(name)), null, 2)}\n`);
  }
  return dir;
}

function record(dir, extra = [], { commit = COMMIT } = {}) {
  const args = [SCRIPT, 'record', '--source-commit', commit];
  for (const [flag, name] of [['--translation', 'translation.json'], ['--manifest', 'manifest.json'], ['--rust', 'rust.json'],
    ['--mappings', 'translations.json'], ['--lean', 'lean.json'], ['--functions', 'functions.json']]) {
    if (fs.existsSync(path.join(dir, name)) || name === 'manifest.json') args.push(flag, path.join(dir, name));
  }
  const run = spawnSync(process.execPath, [...args, ...extra], { encoding: 'utf8' });
  return { status: run.status, result: JSON.parse(run.stdout), stdout: run.stdout };
}

const item = (result, rustName) => result.record.items.find((entry) => entry.rustName === rustName);
const rustAtoms = (fn) => (json) => {
  for (const [name, atom] of Object.entries(json.data)) if (name.startsWith('probe:m1demo/')) fn(atom, name);
  return json;
};

describe('Rust identity record: recorded qualification run (positive)', () => {
  const { status, result } = record(inputs());

  it('maps every local function by charon-def-id, keeping provenance and raw evidence', () => {
    assert.equal(result.code, 'partial', 'recursion stays unsupported, so the record is partial, not complete');
    assert.equal(status, 6);
    const { record: rec } = result;
    assert.equal(rec.schema, 'fvs-rust-identity/record');
    assert.deepEqual(rec.blockers, []);
    assert.equal(rec.provenance.sourceCommit, COMMIT);
    assert.equal(rec.provenance.charonVersion, '0.1.274');
    assert.equal(rec.provenance.aeneasVersion, 'nightly-2026.09.30-0855ce1');
    assert.equal(rec.provenance.crate, 'm1demo');
    assert.equal(rec.provenance.manifestSha256, sha256(path.join(RUN1, 'manifest.json')));
    assert.equal(rec.provenance.translationSha256, sha256(path.join(RUN1, 'translation.json')));
    assert.equal(rec.provenance.linkage, 'triangulated');
    assert.equal(rec.provenance.configSha256, null);
    assert.equal(rec.items.length, 7);
    const exact = rec.items.filter((entry) => entry.correspondence === 'exact').map((entry) => entry.target).sort();
    assert.deepEqual(exact, [
      'm1demo.Meter.Insts.CoreConvertFromU8.from',
      'm1demo.Meter.Insts.M1demoScore.score',
      'm1demo.U8.Insts.CoreConvertFromMeter.from',
      'm1demo.left.helper',
      'm1demo.right.helper',
      'm1demo.sum_to',
    ]);
    for (const entry of rec.items) assert.equal(entry.mapping.method, 'charon-def-id');
  });

  it('maps the trait impl and both From impls, whose Rust names differ only in brace notation, to distinct targets', () => {
    const score = item(result, 'm1demo::{impl m1demo::Score for m1demo::Meter}::score');
    assert.equal(score.correspondence, 'exact');
    assert.equal(score.defId, 22);
    // probe-rust and Aeneas spell trait-impl names differently; both are kept verbatim.
    assert.equal(score.rustQualifiedName, 'm1demo::Meter::score');
    assert.deepEqual(score.corroboration, { span: 'match', name: 'differs' });
    const fromU8 = item(result, 'm1demo::{impl core::convert::From<u8> for m1demo::Meter}::from');
    const intoU8 = item(result, 'm1demo::{impl core::convert::From<m1demo::Meter> for u8}::from');
    assert.equal(fromU8.target, 'm1demo.Meter.Insts.CoreConvertFromU8.from');
    assert.equal(intoU8.target, 'm1demo.U8.Insts.CoreConvertFromMeter.from');
    assert.notEqual(fromU8.rustAtom, intoU8.rustAtom);
  });

  it('folds the loop split into one target and keeps every generated definition with raw flags and dependencies', () => {
    const sum = item(result, 'm1demo::sum_to');
    assert.equal(sum.target, 'm1demo.sum_to');
    assert.deepEqual(sum.generated.map((g) => g.leanName).sort(), ['m1demo.sum_to', 'm1demo.sum_to_loop', 'm1demo.sum_to_loop.body']);
    const body = sum.generated.find((g) => g.leanName === 'm1demo.sum_to_loop.body');
    assert.deepEqual(body.loop, { id: 0, pos: [0], is_body: true });
    assert.equal(body.parentLeanName, 'm1demo.sum_to');
    const wrapper = sum.generated.find((g) => g.leanName === 'm1demo.sum_to');
    assert.deepEqual(wrapper.dependencies, ['probe:m1demo.sum_to_loop']);
    const lean = read('lean.json').data['probe:m1demo.sum_to_loop'];
    assert.deepEqual(sum.generated.find((g) => g.leanName === 'm1demo.sum_to_loop').lean, lean, 'raw probe-lean atom kept verbatim');
    const functions = read('functions.json').functions.find((f) => f.lean_name === 'm1demo.sum_to_loop');
    assert.deepEqual(sum.generated.find((g) => g.leanName === 'm1demo.sum_to_loop').functionsRecord, functions ?? null);
  });

  it('reports recursion as unsupported while keeping its exact mapping', () => {
    const down = item(result, 'm1demo::count_down');
    assert.equal(down.correspondence, 'unsupported');
    assert.deepEqual(down.reasons, ['recursion']);
    assert.equal(down.mapping.method, 'charon-def-id');
    assert.equal(down.target, 'm1demo.count_down');
  });

  it('keys only translation.json functions: types, traits and trait impls reuse integers in separate id spaces', () => {
    const translation = read('translation.json');
    const otherIds = [...translation.types, ...translation.trait_decls, ...translation.trait_impls].map((t) => t.def_id);
    assert.ok(otherIds.length > 0);
    assert.deepEqual(result.record.items.map((entry) => entry.defId).sort((a, b) => a - b), [19, 20, 22, 23, 24, 25, 26]);
  });

  it('is deterministic and records a config hash when given', () => {
    const dir = inputs();
    const config = path.join(dir, 'aeneas-config.yml');
    fs.writeFileSync(config, 'crate:\n  dir: "."\n');
    const first = record(dir, ['--config', config]);
    const second = record(dir, ['--config', config]);
    assert.equal(first.stdout, second.stdout);
    assert.equal(first.result.record.provenance.configSha256, sha256(config));
  });

  it('writes the record atomically with --out', () => {
    const dir = inputs();
    const out = path.join(dir, 'identity.json');
    const run = record(dir, ['--out', out]);
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), run.result.record);
  });
});

describe('Rust identity record: negatives (labelled mutations of the recorded run)', () => {
  it('blocks without a manifest', () => {
    const { status, result } = record(inputs({ 'manifest.json': null }));
    assert.equal(result.code, 'blocked');
    assert.equal(status, 7);
    assert.ok(result.record.blockers.some((b) => b.code === 'missing-manifest'));
    assert.equal(result.record.items.length, 0, 'a blocked record claims no items');
  });

  it('blocks without a Charon version in translation.json', () => {
    const { result } = record(inputs({ 'translation.json': (t) => ({ ...t, charon_version: '' }) }));
    assert.equal(result.code, 'blocked');
    assert.ok(result.record.blockers.some((b) => b.code === 'missing-charon-version'));
  });

  it('blocks a Rust atom produced by a different Charon version', () => {
    const { result } = record(inputs({ 'rust.json': rustAtoms((atom, name) => { if (name.includes('left')) atom['charon-version'] = '0.1.273'; }) }));
    assert.equal(result.code, 'blocked');
    assert.ok(result.record.blockers.some((b) => b.code === 'charon-version-mismatch'));
  });

  it('blocks same Charon version but a different source commit (manifest, probe-rust or caller disagree)', () => {
    const other = '0'.repeat(40);
    assert.ok(record(inputs(), [], { commit: other }).result.record.blockers.some((b) => b.code === 'source-commit-mismatch'));
    const rust = record(inputs({ 'rust.json': (r) => ({ ...r, source: { ...r.source, commit: other } }) }));
    assert.ok(rust.result.record.blockers.some((b) => b.code === 'source-commit-mismatch'));
    const dirty = record(inputs({ 'manifest.json': (m) => ({ ...m, source: { ...m.source, dirty: ['src/lib.rs'] } }) }));
    assert.ok(dirty.result.record.blockers.some((b) => b.code === 'dirty-source'));
  });

  it('blocks same Charon version but different source content: def_ids land on other spans', () => {
    // A translation.json from another source revision of the same Charon version: the
    // ids still resolve, but the spans no longer match the probed source.
    const shifted = (t) => ({ ...t, functions: t.functions.map((f) => ({ ...f, source: { ...f.source, begin_line: f.source.begin_line + 40, end_line: f.source.end_line + 40 } })) });
    const { result } = record(inputs({ 'translation.json': shifted }));
    assert.equal(result.code, 'blocked');
    assert.ok(result.record.blockers.some((b) => b.code === 'correspondence-conflict'));
  });

  it('blocks a translation.json from a different crate (duplicate def_ids across extractions)', () => {
    const { result } = record(inputs({ 'translation.json': (t) => ({ ...t, crate: 'other_crate' }) }));
    assert.ok(result.record.blockers.some((b) => b.code === 'crate-mismatch'));
  });

  it('blocks a state record bound to another manifest', () => {
    const dir = inputs();
    const state = path.join(dir, 'state.json');
    fs.writeFileSync(state, JSON.stringify({ extraction: { inputs: { manifestSha256: 'f'.repeat(64), sourceCommit: COMMIT } } }));
    assert.ok(record(dir, ['--state', state]).result.record.blockers.some((b) => b.code === 'manifest-mismatch'));
  });

  it('marks two Rust atoms carrying one def_id ambiguous instead of binding the first', () => {
    const { result } = record(inputs({ 'rust.json': rustAtoms((atom, name) => { if (name.includes('right')) atom['charon-def-id'] = 25; }) }));
    const left = item(result, 'm1demo::left::helper');
    assert.equal(left.correspondence, 'ambiguous');
    assert.deepEqual(left.reasons, ['duplicate-charon-def-id']);
    assert.equal(left.rustAtom, null);
    assert.equal(left.candidates.length, 2);
    assert.notEqual(result.code, 'ok');
  });

  it('rejects the name-collision fallback: without def_ids the From impls only match by normalized name', () => {
    // Mutation: probe-rust output without charon-def-id, and the mapping probe-aeneas
    // makes in that case (rust-qualified-name), for the two From impls.
    const strip = rustAtoms((atom, name) => { if (name.includes('From')) { delete atom['charon-def-id']; delete atom['charon-version']; } });
    const fallback = (m) => ({ ...m, mappings: m.mappings.map((x) => (x.from.includes('From') ? { ...x, method: 'rust-qualified-name' } : x)) });
    const { result } = record(inputs({ 'rust.json': strip, 'translations.json': fallback }));
    assert.equal(result.code, 'partial');
    const unkeyed = result.record.unkeyedRustAtoms;
    assert.equal(unkeyed.length, 2);
    for (const atom of unkeyed) {
      assert.equal(atom.correspondence, 'fallback-only');
      assert.equal(atom.mapping.method, 'rust-qualified-name');
    }
    for (const name of ['m1demo::{impl core::convert::From<u8> for m1demo::Meter}::from', 'm1demo::{impl core::convert::From<m1demo::Meter> for u8}::from']) {
      assert.equal(item(result, name).correspondence, 'unmatched');
    }
  });

  it('rejects a mapping made by another strategy even when the def_id is present', () => {
    const spans = (m) => ({ ...m, mappings: m.mappings.map((x) => (x.from.includes('left') ? { ...x, method: 'file+line-overlap', confidence: 'medium' } : x)) });
    const { result } = record(inputs({ 'translations.json': spans }));
    const left = item(result, 'm1demo::left::helper');
    assert.equal(left.correspondence, 'fallback-only');
    assert.equal(left.mapping.method, 'file+line-overlap');
  });

  it('marks two atoms mapped to one Lean target ambiguous (collision symptom)', () => {
    const twice = (m) => ({ ...m, mappings: m.mappings.map((x) => (x.from.includes('right') ? { ...x, to: 'probe:m1demo.left.helper' } : x)) });
    const { result } = record(inputs({ 'translations.json': twice }));
    assert.equal(item(result, 'm1demo::left::helper').correspondence, 'ambiguous');
    assert.ok(item(result, 'm1demo::left::helper').reasons.includes('lean-target-claimed-twice'));
    assert.ok(item(result, 'm1demo::right::helper').reasons.includes('lean-target-claimed-twice'));
  });

  it('reports a non-loop split as unsupported', () => {
    const split = (t) => ({ ...t, functions: [...t.functions, { ...t.functions.find((f) => f.def_id === 25), lean_name: 'm1demo.left.helper_wrapper' }] });
    const { result } = record(inputs({ 'translation.json': split }));
    const left = item(result, 'm1demo::left::helper');
    assert.equal(left.correspondence, 'unsupported');
    assert.ok(left.reasons.includes('non-loop-split'));
  });

  it('blocks empty discovery instead of reporting an empty success', () => {
    const empty = record(inputs({ 'translation.json': (t) => ({ ...t, functions: [] }) }));
    assert.equal(empty.result.code, 'blocked');
    assert.ok(empty.result.record.blockers.some((b) => b.code === 'empty-discovery'));
    const noAtoms = record(inputs({ 'rust.json': (r) => ({ ...r, data: Object.fromEntries(Object.entries(r.data).filter(([k]) => !k.startsWith('probe:m1demo/'))) }) }));
    assert.ok(noAtoms.result.record.blockers.some((b) => b.code === 'empty-discovery'));
  });

  it('reports truncated discovery: unmatched functions and orphan Rust atoms make the record partial', () => {
    const missingAtom = record(inputs({ 'rust.json': (r) => { delete r.data['probe:m1demo/0.1.0/left/helper()']; return r; } }));
    assert.equal(missingAtom.result.code, 'partial');
    assert.equal(item(missingAtom.result, 'm1demo::left::helper').correspondence, 'unmatched');
    const missingFunction = record(inputs({ 'translation.json': (t) => ({ ...t, functions: t.functions.filter((f) => f.def_id !== 26) }) }));
    assert.equal(missingFunction.result.code, 'partial');
    assert.deepEqual(missingFunction.result.record.orphanRustAtoms.map((o) => o.defId), [26]);
  });

  it('refuses a truncated (unparseable) input file', () => {
    const raw = fs.readFileSync(path.join(RUN1, 'translation.json'), 'utf8');
    const { status, result } = record(inputs({ 'translation.json': raw.slice(0, raw.length / 2) }));
    assert.equal(result.code, 'invalid-input');
    assert.equal(status, 5);
  });

  it('lists opaque functions as externals and non-local functions as out of scope, never dropping them', () => {
    const tweak = (t) => ({
      ...t,
      functions: [...t.functions.map((f) => (f.def_id === 26 ? { ...f, is_opaque: true } : f)),
        { def_id: 90, lean_name: 'core.num.u32.checked_add', rust_name: 'core::num::u32::checked_add', is_local: false, is_opaque: true }],
    });
    const { result } = record(inputs({ 'translation.json': tweak }));
    assert.deepEqual(result.record.externals.map((e) => e.defId), [26]);
    assert.deepEqual(result.record.outOfScope.map((e) => e.defId), [90]);
    assert.equal(item(result, 'm1demo::right::helper').opaque, true);
  });
});

describe('Rust identity record: recorded run 2 (one source commit later, same Charon version)', () => {
  const RUN2 = path.join(__dirname, 'fixtures', 'auto-rust-identity', 'qualified-run2');
  const COMMIT2 = 'bfe6580e83e22febdeb028576952c74812b353ca';
  const run2 = (overrides = {}, commit = COMMIT2) => {
    const at = (name) => overrides[name] ?? path.join(RUN2, name);
    const args = [SCRIPT, 'record', '--source-commit', commit, '--translation', at('translation.json'), '--manifest', at('manifest.json'),
      '--rust', at('rust.json'), '--mappings', at('translations.json'), '--lean', at('lean.json'), '--functions', at('functions.json')];
    return JSON.parse(spawnSync(process.execPath, args, { encoding: 'utf8' }).stdout);
  };

  it('maps a type-generic function by def_id; no pinned interface marks it generic, so the record cannot either', () => {
    const result = run2();
    const pick = item(result, 'm1demo::pick');
    assert.equal(pick.correspondence, 'exact');
    assert.equal(pick.target, 'm1demo.pick');
    assert.equal(pick.defId, 21);
    assert.deepEqual(result.record.provenance.gaps, ['type-genericity-not-exposed']);
  });

  it('blocks mixing the two runs: def_ids were renumbered by the source change', () => {
    const mixed = run2({ 'rust.json': path.join(RUN1, 'rust.json'), 'translations.json': path.join(RUN1, 'translations.json'), 'lean.json': path.join(RUN1, 'lean.json') });
    assert.equal(mixed.code, 'blocked');
    assert.ok(mixed.record.blockers.some((b) => b.code === 'source-commit-mismatch'));
    // Even with every commit check satisfied by a forged manifest and caller, the
    // renumbered def_ids land on other spans and targets.
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fvs-rust-identity-'));
    temporaryDirectories.push(dir);
    const manifest = JSON.parse(fs.readFileSync(path.join(RUN2, 'manifest.json'), 'utf8'));
    manifest.source.commit = COMMIT;
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    const forged = run2({ 'manifest.json': path.join(dir, 'manifest.json'), 'rust.json': path.join(RUN1, 'rust.json'),
      'translations.json': path.join(RUN1, 'translations.json'), 'lean.json': path.join(RUN1, 'lean.json') }, COMMIT);
    assert.equal(forged.code, 'blocked');
    assert.deepEqual(forged.record.blockers.map((b) => b.code), ['correspondence-conflict']);
  });
});

describe('Rust identity record: claims stay bounded by the evidence', () => {
  // Run 1 without its one unsupported (recursive) function, so every item maps exactly.
  const withoutRecursion = {
    'translation.json': (t) => ({ ...t, functions: t.functions.filter((f) => f.def_id !== 20) }),
    'rust.json': (r) => { delete r.data['probe:m1demo/0.1.0/count_down()']; return r; },
    'translations.json': (m) => ({ ...m, mappings: m.mappings.filter((x) => !x.from.includes('count_down')) }),
  };

  it('never reports a fully matched record as complete while translation linkage and configuration are unbound', () => {
    const { status, result } = record(inputs(withoutRecursion));
    assert.equal(result.code, 'unbound');
    assert.equal(status, 8);
    assert.equal(result.ok, false);
    assert.ok(result.record.items.every((entry) => entry.correspondence === 'exact'));
    assert.deepEqual(result.record.binding, { status: 'unbound', reasons: ['translation-linkage-triangulated', 'extraction-configuration-not-bound'] });
  });

  it('cannot tell two configurations apart: unchanged commit, version and spans stay unbound under either', () => {
    const dir = inputs(withoutRecursion);
    const [a, b] = ['a.yml', 'b.yml'].map((name, i) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, `charon:\n  cargo_args: [${i ? '"--features", "alt"' : ''}]\n`);
      return file;
    });
    const first = record(dir, ['--config', a]).result;
    const second = record(dir, ['--config', b]).result;
    assert.notEqual(first.record.provenance.configSha256, second.record.provenance.configSha256);
    for (const run of [first, second]) {
      assert.equal(run.code, 'unbound');
      assert.ok(run.record.binding.reasons.includes('extraction-configuration-not-bound'));
    }
  });

  it('does not match spans whose line bounds are missing on both sides', () => {
    const noLines = {
      'translation.json': (t) => ({ ...t, functions: t.functions.map((f) => (f.def_id === 25 ? { ...f, source: { file: f.source.file } } : f)) }),
    };
    assert.equal(record(inputs(noLines)).result.code, 'invalid-input', 'a translation source without line bounds is refused');
    const atomLines = rustAtoms((atom, name) => { if (name.includes('left')) atom['code-text'] = {}; });
    const left = item(record(inputs({ 'rust.json': atomLines })).result, 'm1demo::left::helper');
    assert.equal(left.corroboration.span, 'missing');
    assert.equal(left.correspondence, 'ambiguous');
  });

  it('refuses mistyped identity fields and foreign or unprepared envelopes', () => {
    const cases = {
      'string def_id in translation.json': { 'translation.json': (t) => ({ ...t, functions: t.functions.map((f) => (f.def_id === 25 ? { ...f, def_id: '25' } : f)) }) },
      'missing is_rec on a local function': { 'translation.json': (t) => ({ ...t, functions: t.functions.map((f) => { const { is_rec: _drop, ...rest } = f; return f.def_id === 25 ? rest : f; }) }) },
      'string charon-def-id in probe-rust': { 'rust.json': rustAtoms((atom, name) => { if (name.includes('left')) atom['charon-def-id'] = '25'; }) },
      'another schema for probe-rust': { 'rust.json': (r) => ({ ...r, schema: 'probe-lean/extract' }) },
      'array instead of an object': { 'rust.json': () => [] },
      'mappings not from translate': { 'translations.json': (m) => ({ ...m, tool: { ...m.tool, command: 'extract' } }) },
      'manifest without its prepared status': { 'manifest.json': (m) => ({ source: { commit: m.source.commit, dirty: [] } }) },
      'functions.json without a functions array': { 'functions.json': () => ({}) },
    };
    for (const [label, mutation] of Object.entries(cases)) {
      const { status, result } = record(inputs(mutation));
      assert.equal(result.code, 'invalid-input', label);
      assert.equal(status, 5, label);
    }
  });

  it('does not take a differently rooted path as the same file', () => {
    const other = rustAtoms((atom, name) => { if (name.includes('left')) atom['code-path'] = 'other-crate/src/lib.rs'; });
    const { result } = record(inputs({ 'rust.json': other }));
    assert.equal(item(result, 'm1demo::left::helper').corroboration.span, 'mismatch');
    assert.equal(result.code, 'blocked');
    const outside = rustAtoms((atom, name) => { if (name.includes('left')) atom['code-path'] = '../src/lib.rs'; });
    const left = item(record(inputs({ 'rust.json': outside })).result, 'm1demo::left::helper');
    assert.equal(left.corroboration.span, 'unsupported-path');
    assert.equal(left.correspondence, 'ambiguous');
  });

  it('makes competing mappings for one Rust atom ambiguous in either order, and tolerates identical duplicates', () => {
    const bad = { confidence: 'medium', from: 'probe:m1demo/0.1.0/left/helper()', method: 'file+display-name', to: 'probe:m1demo.right.helper' };
    for (const order of ['bad-first', 'bad-last']) {
      const competing = (m) => ({ ...m, mappings: order === 'bad-first' ? [bad, ...m.mappings] : [...m.mappings, bad] });
      const left = item(record(inputs({ 'translations.json': competing })).result, 'm1demo::left::helper');
      assert.equal(left.correspondence, 'ambiguous', order);
      assert.deepEqual(left.reasons, ['conflicting-mappings'], order);
      assert.equal(left.mappingCandidates.length, 2, order);
    }
    const identical = (m) => ({ ...m, mappings: [...m.mappings, m.mappings.find((x) => x.from.includes('left'))] });
    assert.equal(item(record(inputs({ 'translations.json': identical })).result, 'm1demo::left::helper').correspondence, 'exact');
  });

  it('detects a loop body dropped from translation.json although the primary still maps exactly', () => {
    const { result } = record(inputs({ 'translation.json': (t) => ({ ...t, functions: t.functions.filter((f) => f.lean_name !== 'm1demo.sum_to_loop.body') }) }));
    const sum = item(result, 'm1demo::sum_to');
    assert.equal(sum.correspondence, 'incomplete');
    assert.ok(sum.reasons.includes('family-incomplete'));
    assert.deepEqual(sum.missingGenerated, ['loop-0-pair', 'm1demo.sum_to_loop.body']);
    assert.equal(sum.mapping.method, 'charon-def-id', 'the mapping itself is unchanged');
    assert.equal(result.code, 'partial');
    assert.deepEqual(result.record.orphanRustAtoms, []);
  });

  it('detects a lost family member through the Lean dependency even when functions.json omits it too', () => {
    const { result } = record(inputs({
      'translation.json': (t) => ({ ...t, functions: t.functions.filter((f) => f.lean_name !== 'm1demo.sum_to_loop.body').map((f) => (f.lean_name === 'm1demo.sum_to_loop' ? { ...f, loop: { ...f.loop, is_body: true } } : f)) }),
      'functions.json': (j) => ({ functions: j.functions.filter((f) => f.lean_name !== 'm1demo.sum_to_loop.body') }),
    }));
    const sum = item(result, 'm1demo::sum_to');
    assert.equal(sum.correspondence, 'incomplete');
    assert.ok(sum.missingGenerated.includes('m1demo.sum_to_loop.body'), 'sum_to_loop still depends on the dropped body');
  });

  it('requires the Lean evidence the family check uses', () => {
    const dir = inputs();
    fs.rmSync(path.join(dir, 'lean.json'));
    const run = spawnSync(process.execPath, [SCRIPT, 'record', '--source-commit', COMMIT, '--translation', path.join(dir, 'translation.json'),
      '--manifest', path.join(dir, 'manifest.json'), '--rust', path.join(dir, 'rust.json'), '--mappings', path.join(dir, 'translations.json'),
      '--functions', path.join(dir, 'functions.json')], { encoding: 'utf8' });
    assert.equal(run.status, 2);
  });
});

describe('Rust identity record: usage', () => {
  it('requires the source commit and the extraction inputs', () => {
    const run = spawnSync(process.execPath, [SCRIPT, 'record', '--translation', 'x'], { encoding: 'utf8' });
    assert.equal(run.status, 2);
    assert.equal(JSON.parse(run.stdout).code, 'usage');
  });
});
