'use strict';

// The proof phase over several crates in scripts/fvs-auto.mjs. The build check builds the
// whole project once and writes one receipt for a head; the state reports done only when
// that receipt also holds for every verified crate: each has a built statement, none rests
// on an axiom without an accepted externals record or on an assumption about another
// verified crate's function, and every crate it depends on is accepted too. A project with
// one crate reaches done on an accepting receipt alone, as before. Every project is a
// temporary git fixture and every receipt is written by hand; no build runs.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fixtures = require('./helpers/multicrate-fixtures.cjs');

const { ROOT, cli, git, extracted, fn, unit, hmacAndSha2 } = fixtures;
let auto = null;

before(async () => {
  auto = await import(pathToFileURL(path.join(ROOT, 'scripts', 'fvs-auto.mjs')).href);
  fixtures.use(auto);
});

after(fixtures.cleanup);

const HMAC_SPEC = 'formal/specs/Specs/Hmac.lean';
const SHA2_SPEC = 'formal/specs/Specs/Sha2.lean';
const HMAC_ITEM = 'libcrux_hmac::hmac::hmac';
const SHA2_ITEM = 'libcrux_sha2::hacl::hash_256';

const statement = (name, extra = {}) => ({ name, line: 1, status: 'built', reason: null, axioms: [], beyondStandard: [], flags: [], ...extra });
const specFile = (file, statements, extra = {}) => ({ path: file, sha256: '0'.repeat(64), status: 'built', reason: null, statements, ...extra });

// A project in the proof phase: both crates have a reviewed spec file, the spec PR is merged
// and a draft proof PR is recorded at the head. `units` builds the extraction's crates.
function proofPhase(units = hmacAndSha2, { targets = null, noSpecs = false } = {}) {
  const root = extracted(units);
  if (targets) fixtures.recordAgreement(root, fixtures.agreementFor(root, { targets }));
  fs.mkdirSync(path.join(root, 'formal/specs/Specs'), { recursive: true });
  fs.writeFileSync(path.join(root, HMAC_SPEC), 'recall hmac_spec\n');
  fs.writeFileSync(path.join(root, SHA2_SPEC), 'recall sha2_spec\n');
  fs.writeFileSync(path.join(root, 'review.md'), 'pass\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'specs');
  const recordSpec = (file, item) => assert.equal(cli('record-spec', '--project-root', root, '--spec-file', file, '--items', item,
    '--round', '1', '--verdict', 'pass', '--review', 'review.md').status, 0);
  if (!noSpecs) {
    recordSpec(HMAC_SPEC, HMAC_ITEM);
    if (!targets) recordSpec(SHA2_SPEC, SHA2_ITEM);
  }
  const head = git(root, 'rev-parse', 'HEAD');
  assert.equal(cli('record-pr', '--project-root', root, '--kind', 'spec', '--url', 'https://example.invalid/pr/1', '--branch', 'specs', '--head', head).status, 0);
  assert.equal(cli('record-pr', '--project-root', root, '--kind', 'spec', '--merged', '--merge-commit', head).status, 0);
  assert.equal(cli('record-pr', '--project-root', root, '--kind', 'proof', '--url', 'https://example.invalid/pr/2', '--branch', 'proofs', '--head', head).status, 0);
  return { root, head };
}

function receipt(root, head, files, extra = {}) {
  const directory = path.join(root, '.formalising', 'auto-fv', 'build-check');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${head}.json`), JSON.stringify({ schema: 1, kind: 'fvs-build-check', accepted: true,
    label: 'accepted (build check)', commit: head, specBase: head, specFiles: files, ...extra }));
}

const bothBuilt = () => [specFile(HMAC_SPEC, [statement('hmac_spec')]), specFile(SHA2_SPEC, [statement('hash_256_spec')])];
const view = (root) => cli('read-state', '--project-root', root).json;

function boundary(symbol, model, overrides = {}) {
  return { id: `ext-${model}`, kind: 'handwritten-model', source: { symbol, commit: 'a'.repeat(40) }, model: { symbol: model, sha256: 'b'.repeat(64) },
    claimedBehaviour: 'the stated behaviour', reason: 'the owner accepts it', affectedRoots: [], evidence: ['note.md'], status: 'assumption-accepted',
    decision: { by: 'the owner', at: '2026-11-19T00:00:00.000Z', evidence: 'reply' }, ...overrides };
}
const record = (root, ...records) => assert.equal(auto.recordExternals({ projectRoot: root, records }).code, 'recorded');

describe('the proof phase over several crates', () => {
  it('is done when the receipt holds and every crate has a built statement', () => {
    const { root, head } = proofPhase();
    receipt(root, head, bothBuilt());
    const result = view(root);
    assert.equal(result.phase, 'done', result.nextAction);
    assert.deepEqual(result.crates.units.map((entry) => [entry.crate, entry.accepted]), [['libcrux_hmac', true], ['libcrux_sha2', true]]);
  });

  it('is not done while a crate has no spec file in the receipt, and says which', () => {
    const { root, head } = proofPhase();
    receipt(root, head, [specFile(HMAC_SPEC, [statement('hmac_spec')])]);
    const result = view(root);
    assert.equal(result.phase, 'proofs');
    assert.match(result.nextAction, /^The build check accepted the draft proof PR https:\/\/example\.invalid\/pr\/2 at [0-9a-f]{40}, but not every verified crate is accepted: crate libcrux_sha2: formal\/specs\/Specs\/Sha2\.lean is not among the files the build check built; crate libcrux_hmac: it depends on libcrux_sha2, which is not accepted\. Fix what is named/);
    assert.deepEqual(result.crates.units.map((entry) => [entry.crate, entry.accepted]), [['libcrux_hmac', false], ['libcrux_sha2', false]]);
  });

  it('is not done while a crate has a spec file with no built statement', () => {
    const { root, head } = proofPhase();
    receipt(root, head, [specFile(HMAC_SPEC, [statement('hmac_spec')]), specFile(SHA2_SPEC, [])]);
    const result = view(root);
    assert.equal(result.phase, 'proofs');
    assert.match(result.nextAction, /crate libcrux_sha2: the build check built no statement of this crate/);
  });

  it('a crate that depends on an unaccepted crate is not accepted, and the provider is the one named first', () => {
    const { root, head } = proofPhase();
    receipt(root, head, [specFile(HMAC_SPEC, [statement('hmac_spec')]), specFile(SHA2_SPEC, [statement('hash_256_spec', { status: 'failing' })])]);
    const result = view(root);
    assert.equal(result.phase, 'proofs');
    assert.match(result.nextAction, /crate libcrux_sha2: the statement hash_256_spec did not build in the check; crate libcrux_hmac: it depends on libcrux_sha2, which is not accepted/);
    assert.equal(result.crates.units.find((entry) => entry.crate === 'libcrux_sha2').reason, 'the statement hash_256_spec did not build in the check');
  });

  it('a statement of one crate resting on a hand-written assumption about another verified crate is refused', () => {
    const { root, head } = proofPhase();
    record(root, boundary(SHA2_ITEM, 'Trusted.hash_256_spec'));
    receipt(root, head, [specFile(HMAC_SPEC, [statement('hmac_spec', { axioms: ['Trusted.hash_256_spec'], beyondStandard: ['Trusted.hash_256_spec'] })]), specFile(SHA2_SPEC, [statement('hash_256_spec')])]);
    const result = view(root);
    assert.equal(result.phase, 'proofs');
    assert.match(result.nextAction, /crate libcrux_hmac: the statement hmac_spec rests on the axiom Trusted\.hash_256_spec, a hand-written assumption about libcrux_sha2::hacl::hash_256, an item of the verified crate libcrux_sha2: prove it there and use that crate's theorem/);
    assert.deepEqual(result.crates.units.map((entry) => [entry.crate, entry.accepted]), [['libcrux_hmac', false], ['libcrux_sha2', true]], 'the provider itself is accepted');
  });

  it('an axiom without an accepted externals record is refused, also when its record is still open', () => {
    const { root, head } = proofPhase();
    const files = [specFile(HMAC_SPEC, [statement('hmac_spec', { beyondStandard: ['Trusted.hash_256_spec'] })]), specFile(SHA2_SPEC, [statement('hash_256_spec')])];
    receipt(root, head, files);
    assert.match(view(root).nextAction, /crate libcrux_hmac: the statement hmac_spec rests on the axiom Trusted\.hash_256_spec, which has no accepted externals record/);
    record(root, boundary(SHA2_ITEM, 'Trusted.hash_256_spec', { status: 'open', decision: null }));
    assert.match(view(root).nextAction, /which has no accepted externals record/);
  });

  it('an assumption about a crate the owner does not verify, about another library or about the crate itself is accepted', () => {
    const declared = { nonTargets: [{ crate: 'libcrux_traits', dir: 'crates/traits', sources: [] }] };
    const { root, head } = proofPhase((directory) => [
      unit(directory, 'libcrux_hmac', [fn(HMAC_ITEM, 'src/hmac.rs', 10)], { imports: ['libcrux_sha2'], ...declared }),
      unit(directory, 'libcrux_sha2', [fn(SHA2_ITEM, 'src/hacl.rs', 5)], declared),
    ]);
    record(root, boundary('libcrux_traits::Digest::hash', 'Trusted.digest_hash'), boundary('core::cmp::min', 'Trusted.min'), boundary('libcrux_hmac::hmac::wipe', 'Trusted.wipe'));
    receipt(root, head, [specFile(HMAC_SPEC, [statement('hmac_spec', { beyondStandard: ['Trusted.digest_hash', 'Trusted.min', 'Trusted.wipe'] })]), specFile(SHA2_SPEC, [statement('hash_256_spec')])]);
    const result = view(root);
    assert.equal(result.phase, 'done', result.nextAction);
  });

  // The extraction names an assumed item as the constant declared in the consuming crate's
  // namespace (`libcrux_sha2.hacl.sha256_update`), so Lean prints it with the crate in front.
  for (const printed of ['libcrux_hmac.libcrux_sha2.hacl.sha256_update', 'libcrux_sha2.hacl.sha256_update']) {
    it(`an assumption about an item the provider has no definition for is accepted when the extraction lists it and the owner accepted it (printed ${printed})`, () => {
      const gap = 'libcrux_sha2::hacl::sha256_update';
      const { root, head } = proofPhase((directory) => [
        unit(directory, 'libcrux_hmac', [fn(HMAC_ITEM, 'src/hmac.rs', 10)], { imports: ['libcrux_sha2'],
          stitch: [{ provider: 'libcrux_sha2', modules: ['Sha2'], replaced: [], assumed: [{ rustPath: gap, name: 'libcrux_sha2.hacl.sha256_update', reason: 'opaque in the provider' }] }] }),
        unit(directory, 'libcrux_sha2', [fn(SHA2_ITEM, 'src/hacl.rs', 5)]),
      ]);
      const files = [specFile(HMAC_SPEC, [statement('hmac_spec', { beyondStandard: [printed] })]), specFile(SHA2_SPEC, [statement('hash_256_spec')])];
      receipt(root, head, files);
      assert.match(view(root).nextAction, /which has no accepted externals record/, 'the listed gap still needs the owner\'s record');
      record(root, boundary(gap, printed));
      const result = view(root);
      assert.equal(result.phase, 'done', result.nextAction);
    });
  }

  it('an item named in the extraction\'s assumed list does not excuse another constant, nor another item under the same name', () => {
    const gap = 'libcrux_sha2::hacl::sha256_update';
    const { root, head } = proofPhase((directory) => [
      unit(directory, 'libcrux_hmac', [fn(HMAC_ITEM, 'src/hmac.rs', 10)], { imports: ['libcrux_sha2'],
        stitch: [{ provider: 'libcrux_sha2', modules: ['Sha2'], replaced: [], assumed: [{ rustPath: gap, name: 'libcrux_sha2.hacl.sha256_update', reason: 'opaque in the provider' }] }] }),
      unit(directory, 'libcrux_sha2', [fn(SHA2_ITEM, 'src/hacl.rs', 5)]),
    ]);
    // A model of another function of the provider, and of the listed gap under a name the extraction did not give it.
    record(root, boundary(SHA2_ITEM, 'Trusted.hash_256_spec'), boundary(gap, 'Elsewhere.libcrux_sha2.hacl.sha256_update'));
    for (const axiom of ['Trusted.hash_256_spec', 'Elsewhere.libcrux_sha2.hacl.sha256_update']) {
      receipt(root, head, [specFile(HMAC_SPEC, [statement('hmac_spec', { beyondStandard: [axiom] })]), specFile(SHA2_SPEC, [statement('hash_256_spec')])]);
      assert.match(view(root).nextAction, new RegExp(`crate libcrux_hmac: the statement hmac_spec rests on the axiom ${axiom.replaceAll('.', '\\.')}, a hand-written assumption`), axiom);
    }
  });

  it('an axiom the accepted provider\'s own statements rest on is not a new assumption in its consumer', () => {
    // The provider's own item the extraction left opaque: its owner accepted the assumption for the provider,
    // and a consumer that uses the provider's theorem rests on the same constant.
    const opaque = 'libcrux_sha2::hacl::opaque_step';
    const { root, head } = proofPhase();
    record(root, boundary(opaque, 'libcrux_sha2.hacl.opaque_step'));
    const shared = ['libcrux_sha2.hacl.opaque_step'];
    receipt(root, head, [specFile(HMAC_SPEC, [statement('hmac_spec', { beyondStandard: shared })]), specFile(SHA2_SPEC, [statement('hash_256_spec', { beyondStandard: shared })])]);
    const result = view(root);
    assert.equal(result.phase, 'done', result.nextAction);
    // Only the provider's statements vet it: used by the consumer alone, the same assumption is refused.
    receipt(root, head, [specFile(HMAC_SPEC, [statement('hmac_spec', { beyondStandard: shared })]), specFile(SHA2_SPEC, [statement('hash_256_spec')])]);
    assert.match(view(root).nextAction, /crate libcrux_hmac: the statement hmac_spec rests on the axiom libcrux_sha2\.hacl\.opaque_step, a hand-written assumption about libcrux_sha2::hacl::opaque_step/);
  });

  it('a receipt that was not accepted, or made against another spec base, keeps its own message', () => {
    const { root, head } = proofPhase();
    receipt(root, head, bothBuilt(), { accepted: false, label: 'build check failed: a proof has sorry' });
    assert.match(view(root).nextAction, /^The build check failed for the draft proof PR .*: build check failed: a proof has sorry\. Fix the proofs/);
    receipt(root, head, bothBuilt(), { specBase: 'f'.repeat(40) });
    assert.match(view(root).nextAction, /does not count: it was made against the spec base f{40}/);
  });

  it('a project the owner narrowed to one crate is judged on that crate alone', () => {
    const targets = { crates: ['libcrux_hmac'], nonTargets: [{ crate: 'libcrux_sha2', decision: 'Not verified; its behaviour is assumed.' }] };
    const { root, head } = proofPhase(hmacAndSha2, { targets });
    receipt(root, head, [specFile(HMAC_SPEC, [statement('hmac_spec')])]);
    const result = view(root);
    assert.equal(result.phase, 'done', result.nextAction);
    assert.deepEqual(result.crates.units.map((entry) => [entry.crate, entry.accepted]), [['libcrux_hmac', true], ['libcrux_sha2', undefined]]);
  });

  it('the one crate left to verify still needs a built statement', () => {
    const { root, head } = proofPhase(hmacAndSha2, { targets: { crates: ['libcrux_hmac'], nonTargets: [{ crate: 'libcrux_sha2', decision: 'x' }] } });
    receipt(root, head, [specFile(HMAC_SPEC, [])]);
    assert.match(view(root).nextAction, /crate libcrux_hmac: the build check built no statement of this crate/);
  });

  it('an agreement that drops every extracted crate leaves nothing verified, so the phase is not done', () => {
    const targets = { crates: ['libcrux_traits'], nonTargets: [{ crate: 'libcrux_hmac', decision: 'x' }, { crate: 'libcrux_sha2', decision: 'y' }] };
    const { root, head } = proofPhase(hmacAndSha2, { targets, noSpecs: true });
    receipt(root, head, []);
    const result = view(root);
    assert.equal(result.phase, 'proofs');
    assert.match(result.nextAction, /crate \(none\): the agreement drops every extracted crate, so nothing is verified/);
  });
});

describe('a project with one crate', () => {
  const oneCrate = (keepUnits) => {
    const { root, head } = proofPhase((directory) => [unit(directory, 'libcrux_hmac', [fn(HMAC_ITEM, 'src/hmac.rs', 10)])]);
    if (!keepUnits) {
      const state = fixtures.readState(root);
      delete state.extraction.run.units;
      fixtures.writeState(root, state);
    }
    return { root, head };
  };

  it('reaches done on an accepting receipt alone, whatever axioms the statements rest on', () => {
    for (const keepUnits of [true, false]) {
      const { root, head } = oneCrate(keepUnits);
      receipt(root, head, [specFile(HMAC_SPEC, [statement('hmac_spec', { axioms: ['Trusted.anything'], beyondStandard: ['Trusted.anything'] })])]);
      const result = view(root);
      assert.equal(result.phase, 'done', `${keepUnits ? 'one-row units' : 'no units'}: ${result.nextAction}`);
      assert.equal('crates' in result, false);
    }
  });

  it('still needs the receipt to accept and to be held to the spec merge', () => {
    const { root, head } = oneCrate(true);
    receipt(root, head, [specFile(HMAC_SPEC, [statement('hmac_spec')])], { accepted: false, label: 'build check failed: x' });
    assert.equal(view(root).phase, 'proofs');
    receipt(root, head, [specFile(HMAC_SPEC, [statement('hmac_spec')])], { specBase: null });
    assert.match(view(root).nextAction, /without a spec base/);
  });
});
