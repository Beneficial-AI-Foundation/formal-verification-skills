'use strict';

// Spec rounds over several crates in scripts/fvs-auto.mjs: an item belongs to the
// crate named by the first segment of its Rust path, and the crate must be one the
// extraction covers. spec-status reports each crate with its spec files, providers
// first, and the PR is ready only when every crate has reviewed spec files. A
// project with one crate records and reads as before. Every project is a
// temporary git fixture; no Charon, Aeneas or Lean runs.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fixtures = require('./helpers/multicrate-fixtures.cjs');

const { ROOT, cli, git, project, extracted, fn, unit, hmacAndSha2 } = fixtures;

before(async () => {
  fixtures.use(await import(pathToFileURL(path.join(ROOT, 'scripts', 'fvs-auto.mjs')).href));
});

after(fixtures.cleanup);

const HMAC_SPEC = 'formal/specs/Specs/Hmac.lean';
const SHA2_SPEC = 'formal/specs/Specs/Sha2.lean';

// The two-crate project with a spec file per crate and a review report, all committed.
function twoCrates(units = hmacAndSha2) {
  const root = extracted(units);
  fs.mkdirSync(path.join(root, 'formal/specs/Specs'), { recursive: true });
  fs.writeFileSync(path.join(root, HMAC_SPEC), 'recall hmac_spec\n');
  fs.writeFileSync(path.join(root, SHA2_SPEC), 'recall sha2_spec\n');
  fs.writeFileSync(path.join(root, 'review.md'), 'pass\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'specs');
  return root;
}

const record = (root, file, items, verdict = 'pass', ...extra) => cli('record-spec', '--project-root', root, '--spec-file', file,
  '--items', items, '--round', '1', '--verdict', verdict, '--review', 'review.md', ...extra);
const status = (root) => cli('spec-status', '--project-root', root).json;
const specsFile = (root) => path.join(root, '.formalising', 'auto-fv', 'specs.json');

describe('record-spec over several crates', () => {
  it('records the items of an extracted crate', () => {
    const root = twoCrates();
    const result = record(root, SHA2_SPEC, 'libcrux_sha2::hacl::hash_256');
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(result.json.row.items, ['libcrux_sha2::hacl::hash_256']);
  });

  it('refuses an item of a crate the extraction does not hold, naming the crates it does', () => {
    const root = twoCrates();
    const result = record(root, SHA2_SPEC, 'libcrux_traits::Digest::hash');
    assert.equal(result.status, 1);
    assert.equal(result.json.code, 'invalid-input');
    assert.match(result.json.message, /crate libcrux_traits is not in the recorded extraction \(crates: libcrux_hmac, libcrux_sha2\)/);
    assert.deepEqual(result.json.crates, ['libcrux_hmac', 'libcrux_sha2']);
    assert.equal(fs.existsSync(specsFile(root)), false, 'a refusal writes nothing');
  });

  it('refuses an item of a declared non-target crate: its items can only be assumed', () => {
    const root = twoCrates((directory) => [
      unit(directory, 'libcrux_hmac', [fn('libcrux_hmac::hmac::hmac', 'src/hmac.rs', 10)],
        { nonTargets: [{ crate: 'libcrux_traits', dir: 'crates/traits', sources: [] }] }),
      unit(directory, 'libcrux_sha2', [], { nonTargets: [{ crate: 'libcrux_traits', dir: 'crates/traits', sources: [] }] }),
    ]);
    const result = record(root, SHA2_SPEC, 'libcrux_traits::Digest::hash');
    assert.equal(result.json.code, 'invalid-input');
    assert.match(result.json.message, /crate libcrux_traits is not a verification target, so its items get no statement; the owner may only assume them/);
    assert.equal(fs.existsSync(specsFile(root)), false);
  });

  it('refuses an item Charon could not translate, but accepts it as out of scope', () => {
    const root = twoCrates((directory) => [
      unit(directory, 'libcrux_hmac', [], { hasErrors: { value: true, items: ['libcrux_hmac::hmac::update'], itemCount: 1 } }),
      unit(directory, 'libcrux_sha2', []),
    ]);
    const refused = record(root, HMAC_SPEC, 'libcrux_hmac::hmac::update');
    assert.equal(refused.json.code, 'invalid-input');
    assert.match(refused.json.message, /libcrux_hmac::hmac::update was not translated \(Charon reported errors on it\), so it cannot have a statement; name it in --out-of-scope/);
    const accepted = record(root, HMAC_SPEC, 'libcrux_hmac::hmac::hmac', 'pass', '--out-of-scope', 'libcrux_hmac::hmac::update');
    assert.equal(accepted.status, 0, accepted.stdout);
    assert.deepEqual(accepted.json.row.outOfScope, ['libcrux_hmac::hmac::update']);
  });

  it('refuses a spec file that covers items of two crates', () => {
    const root = twoCrates();
    const result = record(root, HMAC_SPEC, 'libcrux_hmac::hmac::hmac,libcrux_sha2::hacl::hash_256');
    assert.equal(result.json.code, 'invalid-input');
    assert.match(result.json.message, /--items names items of libcrux_hmac, libcrux_sha2: a spec file covers one crate, so record one file per crate/);
    assert.deepEqual(result.json.crates, ['libcrux_hmac', 'libcrux_sha2']);
  });

  it('checks nothing for a single-crate extraction, with or without a one-row units list', () => {
    for (const keepUnits of [true, false]) {
      const root = extracted((directory) => [unit(directory, 'libcrux_hmac', [])]);
      if (!keepUnits) {
        const state = fixtures.readState(root);
        delete state.extraction.run.units;
        fixtures.writeState(root, state);
      }
      fs.mkdirSync(path.join(root, 'formal/specs/Specs'), { recursive: true });
      fs.writeFileSync(path.join(root, HMAC_SPEC), 'recall hmac_spec\n');
      fs.writeFileSync(path.join(root, 'review.md'), 'pass\n');
      const result = record(root, HMAC_SPEC, 'crate::module::function,another_crate::other');
      assert.equal(result.status, 0, `${keepUnits ? 'one-row units' : 'no units'}: ${result.stdout}`);
    }
  });

  it('checks nothing when no state is recorded', () => {
    const root = project();
    fs.writeFileSync(path.join(root, 'review.md'), 'pass\n');
    fs.writeFileSync(path.join(root, 'Spec.lean'), 'recall x\n');
    assert.equal(record(root, 'Spec.lean', 'anything::at::all').status, 0);
  });
});

describe('spec-status over several crates', () => {
  it('reports each crate, providers first, with the spec files that state its items', () => {
    const root = twoCrates();
    record(root, HMAC_SPEC, 'libcrux_hmac::hmac::hmac');
    const view = status(root);
    assert.deepEqual(view.crates, {
      order: ['libcrux_sha2', 'libcrux_hmac'],
      units: [
        { crate: 'libcrux_sha2', dependsOn: [], specFiles: [], ready: false, label: 'no spec file is recorded for this crate' },
        { crate: 'libcrux_hmac', dependsOn: ['libcrux_sha2'], specFiles: [HMAC_SPEC], ready: true, label: 'spec files reviewed: pass' },
      ],
    });
    assert.deepEqual(view.specFiles[0].crates, ['libcrux_hmac']);
  });

  it('is ready for the PR only when every crate has reviewed spec files', () => {
    const root = twoCrates();
    record(root, HMAC_SPEC, 'libcrux_hmac::hmac::hmac');
    assert.equal(status(root).readyForPr, false, 'a pass for one crate is not enough');
    record(root, SHA2_SPEC, 'libcrux_sha2::hacl::hash_256');
    assert.equal(status(root).readyForPr, true);
    assert.deepEqual(status(root).crates.units.map((entry) => entry.ready), [true, true]);
  });

  it('a spec file waiting for changes holds only its own crate', () => {
    const root = twoCrates();
    record(root, HMAC_SPEC, 'libcrux_hmac::hmac::hmac');
    record(root, SHA2_SPEC, 'libcrux_sha2::hacl::hash_256', 'changes');
    const view = status(root);
    assert.equal(view.readyForPr, false);
    assert.deepEqual(view.crates.units.map((entry) => [entry.crate, entry.ready, entry.label]), [
      ['libcrux_sha2', false, 'a spec file is waiting for changes or changed after its review'],
      ['libcrux_hmac', true, 'spec files reviewed: pass'],
    ]);
  });

  it('an edited spec file makes its crate stale and not ready', () => {
    const root = twoCrates();
    record(root, HMAC_SPEC, 'libcrux_hmac::hmac::hmac');
    record(root, SHA2_SPEC, 'libcrux_sha2::hacl::hash_256');
    fs.appendFileSync(path.join(root, SHA2_SPEC), '-- edited\n');
    const view = status(root);
    assert.deepEqual(view.crates.units.map((entry) => [entry.crate, entry.ready]), [['libcrux_sha2', false], ['libcrux_hmac', true]]);
    assert.equal(view.readyForPr, false);
  });

  it('a crate whose only spec file is blocked has no reviewed pass', () => {
    const root = twoCrates();
    record(root, HMAC_SPEC, 'libcrux_hmac::hmac::hmac');
    record(root, SHA2_SPEC, 'libcrux_sha2::hacl::hash_256', 'blocked');
    const view = status(root);
    assert.equal(view.crates.units[0].label, 'no spec file of this crate has a reviewed pass');
    assert.equal(view.readyForPr, false);
    assert.deepEqual(view.blocked, [SHA2_SPEC]);
  });

  it('record-pr names each crate that is not ready, as a warning, and still records the PR', () => {
    const root = twoCrates();
    record(root, HMAC_SPEC, 'libcrux_hmac::hmac::hmac');
    const result = cli('record-pr', '--project-root', root, '--kind', 'spec', '--url', 'https://example.invalid/pr/1', '--branch', 'specs', '--head', 'HEAD');
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(result.json.warnings, [
      'spec-status is not ready for the PR (a file is waiting for changes or changed after its review)',
      'crate libcrux_sha2: no spec file is recorded for this crate',
    ]);
  });

  it('a single-crate project has no crate view and the same readiness as before', () => {
    const root = extracted((directory) => [unit(directory, 'libcrux_hmac', [])]);
    fs.mkdirSync(path.join(root, 'formal/specs/Specs'), { recursive: true });
    fs.writeFileSync(path.join(root, HMAC_SPEC), 'recall hmac_spec\n');
    fs.writeFileSync(path.join(root, 'review.md'), 'pass\n');
    assert.equal(record(root, HMAC_SPEC, 'libcrux_hmac::hmac::hmac').status, 0);
    const view = status(root);
    assert.equal('crates' in view, false);
    assert.equal('crates' in view.specFiles[0], false);
    assert.equal(view.readyForPr, true);
  });
});
