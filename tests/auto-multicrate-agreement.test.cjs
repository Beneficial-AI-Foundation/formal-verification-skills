'use strict';

// The owner's crate decisions in the agreement, and how the engine reads them next to
// the extraction: the crates to verify (default every extracted crate) and each crate
// the owner decided not to verify, with the decision in their own words. A crate the
// owner dropped, or the extraction declares as a non-target, only has assumptions.
// Every project is a temporary git fixture; no Charon, Aeneas or Lean runs.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fixtures = require('./helpers/multicrate-fixtures.cjs');

const { ROOT, cli, git, sha256, project, extracted, fn, unit, hmacAndSha2 } = fixtures;
let auto = null;

before(async () => {
  auto = await import(pathToFileURL(path.join(ROOT, 'scripts', 'fvs-auto.mjs')).href);
  fixtures.use(auto);
});

after(fixtures.cleanup);

const { canonical, agreementFor, recordAgreement: record } = fixtures;

const TARGETS = {
  crates: ['libcrux_hmac'],
  nonTargets: [{ crate: 'libcrux_sha2', decision: 'The owner does not verify sha2 and accepts its behaviour as assumed.' }],
};

describe('the agreement\'s targets key', () => {
  it('is recorded with the agreement and read back', () => {
    const root = extracted(hmacAndSha2);
    assert.equal(record(root, agreementFor(root, { targets: TARGETS })).code, 'recorded');
    assert.deepEqual(auto.readState({ projectRoot: root }).state.agreements.at(-1).payload.targets, TARGETS);
  });

  it('is refused when it is malformed, naming the field', () => {
    const root = extracted(hmacAndSha2);
    const cases = [
      ['a single-crate layout', agreementFor(root, { targets: TARGETS }, 'single-crate'), /targets applies to layout monorepo only/],
      ['no crates', agreementFor(root, { targets: { crates: [], nonTargets: [] } }), /targets\.crates must be a list of distinct crate names with at least one entry/],
      ['a repeated crate', agreementFor(root, { targets: { crates: ['a', 'a'], nonTargets: [] } }), /distinct crate names/],
      ['a crate name with a path', agreementFor(root, { targets: { crates: ['a::b'], nonTargets: [] } }), /distinct crate names/],
      ['no non-target list', agreementFor(root, { targets: { crates: ['a'] } }), /nonTargets must be a list, empty when the owner drops no crate/],
      ['a crate that is both', agreementFor(root, { targets: { crates: ['a'], nonTargets: [{ crate: 'a', decision: 'x' }] } }), /nonTargets\[0\]\.crate a is also a target/],
      ['a decision with no words', agreementFor(root, { targets: { crates: ['a'], nonTargets: [{ crate: 'b', decision: ' ' }] } }), /nonTargets\[0\]\.decision must be the owner's decision in words/],
      ['a non-target named twice', agreementFor(root, { targets: { crates: ['a'], nonTargets: [{ crate: 'b', decision: 'x' }, { crate: 'b', decision: 'y' }] } }), /names a crate twice/],
      ['an unknown field', agreementFor(root, { targets: { crates: ['a'], nonTargets: [], extra: 1 } }), /targets\.extra is not a known field/],
    ];
    for (const [label, agreement, pattern] of cases) {
      assert.throws(() => record(root, agreement), (error) => error instanceof auto.Refusal && error.code === 'invalid-input' && pattern.test(error.message), label);
    }
    assert.equal(auto.readState({ projectRoot: root }).state.agreements, undefined, 'a refusal records nothing');
  });

  it('leaves the digest of an agreement without it as it was, and the state still validates', () => {
    const root = extracted(hmacAndSha2);
    const agreement = agreementFor(root);
    assert.equal('targets' in agreement.payload, false);
    const { schema, schemaVersion, mode, payload } = agreement;
    assert.equal(agreement.approvedPayloadSha256, sha256(canonical({ schema, schemaVersion, mode, payload })));
    assert.equal(record(root, agreement).code, 'recorded');
    assert.equal(cli('read-state', '--project-root', root).status, 0);
  });
});

describe('read-state with the owner\'s crate decisions', () => {
  it('without an agreement every extracted crate is a target', () => {
    const root = extracted(hmacAndSha2);
    const { crates, warnings, pendingDecisions } = cli('read-state', '--project-root', root, '--brief').json;
    assert.deepEqual(crates.targets, ['libcrux_sha2', 'libcrux_hmac']);
    assert.deepEqual(crates.nonTargets, []);
    assert.deepEqual(pendingDecisions, ['roadmap']);
    assert.equal(warnings.some((warning) => /agreement names/.test(warning)), false);
  });

  it('a crate the owner dropped is a non-target, and the other crate is the only target', () => {
    const root = extracted(hmacAndSha2);
    record(root, agreementFor(root, { targets: TARGETS }));
    const { crates, warnings } = cli('read-state', '--project-root', root, '--brief').json;
    assert.deepEqual(crates.targets, ['libcrux_hmac']);
    assert.deepEqual(crates.nonTargets, ['libcrux_sha2']);
    assert.deepEqual(warnings.filter((warning) => /libcrux_sha2/.test(warning)), []);
  });

  it('a crate the agreement names as a target but the extraction lacks is missing, and a warning says so', () => {
    const root = extracted(hmacAndSha2);
    record(root, agreementFor(root, { targets: { crates: ['libcrux_hmac', 'libcrux_sha2', 'libcrux_traits'], nonTargets: [] } }));
    const { crates, warnings } = cli('read-state', '--project-root', root, '--brief').json;
    assert.deepEqual(crates.missing, ['libcrux_traits']);
    assert.ok(warnings.includes('the agreement names libcrux_traits as a target, but the extraction does not hold it'), warnings.join('; '));
  });

  it('an extracted crate the agreement names as neither target nor non-target stays a target, with a warning', () => {
    const root = extracted(hmacAndSha2);
    record(root, agreementFor(root, { targets: { crates: ['libcrux_hmac'], nonTargets: [] } }));
    const { crates, warnings } = cli('read-state', '--project-root', root, '--brief').json;
    assert.deepEqual(crates.targets, ['libcrux_sha2', 'libcrux_hmac']);
    assert.ok(warnings.some((warning) => /the extraction holds libcrux_sha2, which the agreement names as neither a target nor a non-target/.test(warning)), warnings.join('; '));
  });

  it('a non-target crate the extraction declares waits for the owner\'s decision, even with one crate extracted', () => {
    const declared = { nonTargets: [{ crate: 'libcrux_traits', dir: 'crates/traits', sources: [] }] };
    const root = extracted((directory) => [unit(directory, 'libcrux_hmac', [fn('libcrux_hmac::hmac::hmac', 'src/hmac.rs', 10)], declared)]);
    const pending = () => cli('read-state', '--project-root', root, '--brief').json;
    assert.deepEqual(pending().crates.targets, ['libcrux_hmac']);
    assert.deepEqual(pending().crates.nonTargets, ['libcrux_traits']);
    assert.ok(pending().pendingDecisions.includes('non-target crate libcrux_traits: the owner has not recorded a decision in the agreement'));

    record(root, agreementFor(root, { targets: { crates: ['libcrux_hmac'], nonTargets: [{ crate: 'libcrux_traits', decision: 'Not verified; assumed.' }] } }));
    assert.deepEqual(pending().pendingDecisions, ['roadmap']);
    assert.deepEqual(pending().warnings.filter((warning) => /agreement names/.test(warning)), []);
  });
});

describe('spec rounds with the owner\'s crate decisions', () => {
  const HMAC_SPEC = 'formal/specs/Specs/Hmac.lean';
  const SHA2_SPEC = 'formal/specs/Specs/Sha2.lean';
  function withSpecs(root) {
    fs.mkdirSync(path.join(root, 'formal/specs/Specs'), { recursive: true });
    fs.writeFileSync(path.join(root, HMAC_SPEC), 'recall hmac_spec\n');
    fs.writeFileSync(path.join(root, SHA2_SPEC), 'recall sha2_spec\n');
    fs.writeFileSync(path.join(root, 'review.md'), 'pass\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'specs');
    return root;
  }
  const spec = (root, file, items) => cli('record-spec', '--project-root', root, '--spec-file', file, '--items', items, '--round', '1', '--verdict', 'pass', '--review', 'review.md');
  const status = (root) => cli('spec-status', '--project-root', root).json;

  it('refuses an item of a crate the owner dropped, and needs no spec files for it', () => {
    const root = withSpecs(extracted(hmacAndSha2));
    record(root, agreementFor(root, { targets: TARGETS }));
    const refused = spec(root, SHA2_SPEC, 'libcrux_sha2::hacl::hash_256');
    assert.equal(refused.json.code, 'invalid-input');
    assert.match(refused.json.message, /crate libcrux_sha2 is not a verification target, so its items get no statement; the owner may only assume them/);
    assert.equal(spec(root, HMAC_SPEC, 'libcrux_hmac::hmac::hmac').status, 0);
    const view = status(root);
    assert.deepEqual(view.crates.units.map((entry) => [entry.crate, entry.ready]), [['libcrux_hmac', true]]);
    assert.equal(view.readyForPr, true, 'the dropped crate is not a crate to cover');
  });

  it('refuses an item of a target the extraction lacks, naming the crate, and the PR is not ready', () => {
    const root = withSpecs(extracted(hmacAndSha2));
    record(root, agreementFor(root, { targets: { crates: ['libcrux_hmac', 'libcrux_sha2', 'libcrux_traits'], nonTargets: [] } }));
    const refused = spec(root, HMAC_SPEC, 'libcrux_traits::Digest::hash');
    assert.equal(refused.json.code, 'invalid-input');
    assert.match(refused.json.message, /crate libcrux_traits is a target in the agreement but the extraction does not hold it; extract it, or record the owner's decision to drop it/);
    assert.equal(spec(root, HMAC_SPEC, 'libcrux_hmac::hmac::hmac').status, 0);
    assert.equal(spec(root, SHA2_SPEC, 'libcrux_sha2::hacl::hash_256').status, 0);
    const view = status(root);
    assert.equal(view.readyForPr, false);
    assert.deepEqual(view.crates.units.at(-1), { crate: 'libcrux_traits', dependsOn: [],
      specFiles: [], ready: false, label: 'the agreement names this crate as a target, but the extraction does not hold it' });
  });

  it('refuses an item of a non-target crate the extraction declares, with one crate extracted', () => {
    const declared = { nonTargets: [{ crate: 'libcrux_traits', dir: 'crates/traits', sources: [] }] };
    const root = withSpecs(extracted((directory) => [unit(directory, 'libcrux_hmac', [], declared)]));
    assert.equal(spec(root, HMAC_SPEC, 'libcrux_traits::Digest::hash').json.code, 'invalid-input');
    assert.equal(spec(root, HMAC_SPEC, 'libcrux_hmac::hmac::hmac').status, 0);
    assert.equal(status(root).readyForPr, true);
  });
});

describe('a single-crate project with no crate decision', () => {
  it('has no crate view, no pending crate decision and no crate warning', () => {
    const root = project();
    fixtures.init(root);
    const result = cli('read-state', '--project-root', root);
    assert.equal('crates' in result.json, false);
    assert.deepEqual(result.json.pendingDecisions, ['roadmap']);
  });
});
