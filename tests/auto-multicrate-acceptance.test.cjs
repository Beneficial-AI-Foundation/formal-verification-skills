'use strict';

// The proof phase over several crates in scripts/fvs-auto.mjs. The build check builds the
// whole project once and writes one receipt for a head; the state reports done only when
// that receipt also holds for every verified crate (each has a built statement and every
// crate it depends on is accepted too) and was made with the allowed axioms the engine
// writes for that commit. A project with one crate reaches done on an accepting receipt
// alone, as before. Every project is a temporary git fixture and every receipt is written
// by hand; no build runs. What the allowed axioms hold is tested in auto-multicrate-axioms.

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
// With `prune` the owner removes that spec file before merging, with `below` the Lean project is a
// folder of the repository.
function proofPhase(units = hmacAndSha2, { targets = null, noSpecs = false, prune = null, below = false } = {}) {
  const root = extracted(units, { below });
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
  if (prune) {
    fs.rmSync(path.join(root, prune));
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'the owner prunes a spec file');
  }
  const head = git(root, 'rev-parse', 'HEAD');
  assert.equal(cli('record-pr', '--project-root', root, '--kind', 'spec', '--url', 'https://example.invalid/pr/1', '--branch', 'specs', '--head', head).status, 0);
  assert.equal(cli('record-pr', '--project-root', root, '--kind', 'spec', '--merged', '--merge-commit', head).status, 0);
  assert.equal(cli('record-pr', '--project-root', root, '--kind', 'proof', '--url', 'https://example.invalid/pr/2', '--branch', 'proofs', '--head', head).status, 0);
  return { root, head };
}

// The allowed axioms the build check was given, as it records them in a receipt: the engine's
// own list for the commit, or null for a project with one crate, which runs without one.
function allowAxioms(root, head) {
  const written = cli('allowed-axioms', '--project-root', root, '--commit', head);
  return written.json?.sha256 ? { file: written.json.file, sha256: written.json.sha256, names: written.json.names } : null;
}

// What a version 2 acceptance carries besides the statements: the Lean-level comparison of them with
// the merged spec, which an acceptance without it does not count.
const LEAN_COMPARISON = { toolchain: { lean: 'Lean (version 4.35.0)', githash: 'a'.repeat(40) }, statements: [{ name: 'f', declaration: 'f', constants: 2, sha256: 'a'.repeat(64) }],
  bindings: [], dumps: { base: 'b'.repeat(64), head: 'c'.repeat(64) } };

// The digest of the externals file as the build check records it in a receipt: null when there is none.
function externalsDigest(root) {
  const file = path.join(root, '.formalising', 'auto-fv', 'externals.json');
  return fs.existsSync(file) ? fixtures.sha256(fs.readFileSync(file)) : null;
}

function receipt(root, head, files, extra = {}) {
  const directory = path.join(root, '.formalising', 'auto-fv', 'build-check');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${head}.json`), JSON.stringify({ schema: 2, kind: 'fvs-build-check', accepted: true,
    label: 'accepted (build check)', commit: head, specBase: head, specFiles: files, allowAxioms: allowAxioms(root, head),
    externals: { file: path.join(root, '.formalising', 'auto-fv', 'externals.json'), sha256: externalsDigest(root), records: [] },
    integrity: { semantic: LEAN_COMPARISON }, ...extra }));
}

const bothBuilt = () => [specFile(HMAC_SPEC, [statement('hmac_spec')]), specFile(SHA2_SPEC, [statement('hash_256_spec')])];
const view = (root) => cli('read-state', '--project-root', root).json;

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
    assert.match(result.nextAction, /^The build check accepted the draft proof PR https:\/\/example\.invalid\/pr\/2 at [0-9a-f]{40}, but not every verified crate is accepted: crate libcrux_sha2: formal\/specs\/Specs\/Sha2\.lean is not among the files the build check built; crate libcrux_hmac: it depends on libcrux_sha2, which is not accepted\. Fix what is named, push with the FVS push command \(`node <FVS scripts folder>\/fvs-auto-push\.mjs --branch fvs\/<name>`, never git push\), record the new head/);
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

  describe('the allowed axioms of the checked commit', () => {
    it('a receipt made without them, or with another list, does not count, and the next action gives both steps', () => {
      const { root, head } = proofPhase();
      receipt(root, head, bothBuilt(), { allowAxioms: null });
      const result = view(root);
      assert.equal(result.phase, 'proofs');
      assert.match(result.nextAction, /does not count: it was not made with the allowed axioms of this commit \(it holds none\)\. Write the allowed axioms: node fvs-auto\.mjs allowed-axioms --project-root \S+ --commit [0-9a-f]{40}; then run the build check: node fvs-build-check\.mjs --project-root \S+ --commit [0-9a-f]{40} --spec-base [0-9a-f]{40} --allow-axioms \S+allowed-axioms\.json; read-state reports done when it accepts/);
      // The per-crate report reads the same verdict: no crate is accepted through a receipt the phase refuses.
      assert.deepEqual(result.crates.units.map((entry) => [entry.crate, entry.accepted]), [['libcrux_hmac', false], ['libcrux_sha2', false]]);
      assert.match(result.crates.units[0].reason, /^the build check receipt does not count: it was not made with the allowed axioms of this commit \(it holds none\)$/);
      receipt(root, head, bothBuilt(), { allowAxioms: { file: 'x', sha256: 'e'.repeat(64), names: 3 } });
      const other = view(root);
      assert.match(other.nextAction, /\(it holds another list\)/);
      assert.deepEqual(other.crates.units.map((entry) => entry.accepted), [false, false]);
      receipt(root, head, bothBuilt());
      assert.equal(view(root).phase, 'done');
    });

    it('names each crate\'s live spec files, in the form the build check reports them, so a statement is held to its own crate', () => {
      const sectionsOf = (setup) => {
        const written = cli('allowed-axioms', '--project-root', setup.root, '--commit', setup.head);
        assert.equal(written.status, 0, written.stdout);
        return JSON.parse(fs.readFileSync(written.json.file, 'utf8')).crates.map((entry) => [entry.crate, entry.specFiles]);
      };
      assert.deepEqual(sectionsOf(proofPhase()), [['libcrux_hmac', [HMAC_SPEC]], ['libcrux_sha2', [SHA2_SPEC]]]);
      assert.deepEqual(sectionsOf(proofPhase(hmacAndSha2, { below: true })), [['libcrux_hmac', [`lean/${HMAC_SPEC}`]], ['libcrux_sha2', [`lean/${SHA2_SPEC}`]]],
        'a project below the repository top: the path starts at the top, as the receipt\'s does');
      assert.deepEqual(sectionsOf(proofPhase(hmacAndSha2, { prune: SHA2_SPEC })), [['libcrux_hmac', [HMAC_SPEC]], ['libcrux_sha2', []]], 'a file the owner pruned is not live');
    });

    it('derives the same list for a project root reached through a symbolic link', () => {
      const { root, head } = proofPhase(hmacAndSha2, { below: true });
      const link = path.join(fixtures.temporaryDirectory('fvs-link-'), 'project');
      fs.symlinkSync(root, link);
      const state = fixtures.readState(root);
      const specs = JSON.parse(fs.readFileSync(path.join(root, '.formalising', 'auto-fv', 'specs.json'), 'utf8'));
      const units = state.extraction.run.units;
      const context = { units, targets: units.map((row) => row.crate), view: { units: units.map((row) => ({ crate: row.crate, dependsOn: row.imports ?? [] })) } };
      const real = auto.allowedAxiomList(root, state, context, head, specs);
      const linked = auto.allowedAxiomList(link, state, context, head, specs);
      assert.deepEqual(linked.problems, []);
      assert.deepEqual(linked.crates.map((entry) => [entry.crate, entry.specFiles]), [['libcrux_hmac', [`lean/${HMAC_SPEC}`]], ['libcrux_sha2', [`lean/${SHA2_SPEC}`]]]);
      assert.equal(linked.sha256, real.sha256);
    });

    it('a recorded proof PR with no receipt yet is told to write the list before the check', () => {
      const { root } = proofPhase();
      assert.match(view(root).nextAction, /is recorded at [0-9a-f]{40}\. Write the allowed axioms: node fvs-auto\.mjs allowed-axioms .* then run the build check: node fvs-build-check\.mjs .* --allow-axioms /);
    });

    it('the list is the one derived from the commit: a receipt made with an older list stops counting when the records change', () => {
      const { root, head } = proofPhase();
      receipt(root, head, bothBuilt());
      assert.equal(view(root).phase, 'done');
      // The owner accepts an assumption about a core function, and a Trusted file cites its record.
      assert.equal(auto.recordExternals({ projectRoot: root, records: [{ id: 'gap-core-div', kind: 'external', source: { symbol: 'core::num::{u32}::wrapping_div', commit: 'a'.repeat(40) },
        model: { symbol: 'wrapping_div_spec', sha256: 'b'.repeat(64) }, claimedBehaviour: 'the stated behaviour', reason: 'the owner accepts it', affectedRoots: [], evidence: ['note.md'],
        status: 'assumption-accepted', decision: { by: 'the owner', at: '2026-11-19T00:00:00.000Z', evidence: 'reply' } }] }).code, 'recorded');
      fs.mkdirSync(path.join(root, 'formal/Trusted'), { recursive: true });
      fs.writeFileSync(path.join(root, 'formal/Trusted/Core.lean'), 'namespace libcrux_hmac.Trusted\n/-- Accepted assumption, `gap-core-div`. -/\naxiom wrapping_div_spec : True\nend libcrux_hmac.Trusted\n');
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'a Trusted axiom');
      const next = git(root, 'rev-parse', 'HEAD');
      assert.equal(cli('record-pr', '--project-root', root, '--kind', 'proof', '--url', 'https://example.invalid/pr/2', '--branch', 'proofs', '--head', next).status, 0);
      const stale = allowAxioms(root, head);
      // The spec merge stays the first commit; only the proof PR's head moved.
      receipt(root, next, bothBuilt(), { specBase: head, allowAxioms: stale });
      const old = view(root);
      assert.equal(old.phase, 'proofs', 'a receipt for the new head made with the list of the old one');
      assert.match(old.nextAction, /was not made with the allowed axioms of this commit \(it holds another list\)/);
      receipt(root, next, bothBuilt(), { specBase: head });
      assert.equal(view(root).phase, 'done');
    });

    it('an extraction file that no longer matches what the extraction published stops the phase, with the reason', () => {
      const { root, head } = proofPhase((directory) => {
        const rows = hmacAndSha2(directory);
        const lean = path.join(directory, 'libcrux_hmac', 'Hmac.lean');
        fs.writeFileSync(lean, 'namespace libcrux_hmac\nend libcrux_hmac\n');
        rows[0].publication.push({ attemptPath: '/attempt/Hmac.lean', projectPath: lean, sha256: '1'.repeat(64) });
        return rows;
      });
      receipt(root, head, bothBuilt(), { allowAxioms: { file: 'x', sha256: 'e'.repeat(64), names: 0 } });
      const result = view(root);
      assert.equal(result.phase, 'proofs');
      assert.match(result.nextAction, /the allowed axioms cannot be derived at that commit: libcrux_hmac\/Hmac\.lean differs from the file the extraction published/);
      assert.deepEqual(result.crates.units.map((entry) => entry.accepted), [false, false], 'a list that cannot be derived accepts no crate');
      assert.match(result.crates.units[1].reason, /^the build check receipt does not count: the allowed axioms cannot be derived at that commit: libcrux_hmac\/Hmac\.lean differs/);
    });

    it('a project with one crate is not asked for a list', () => {
      const { root, head } = proofPhase((directory) => [unit(directory, 'libcrux_hmac', [fn(HMAC_ITEM, 'src/hmac.rs', 10)])]);
      assert.doesNotMatch(view(root).nextAction, /allowed-axioms/);
      receipt(root, head, [specFile(HMAC_SPEC, [statement('hmac_spec')])]);
      assert.equal(view(root).phase, 'done');
    });
  });

  it('a receipt that was not accepted, or made against another spec base, keeps its own message', () => {
    const { root, head } = proofPhase();
    receipt(root, head, bothBuilt(), { accepted: false, label: 'build check failed: a proof has sorry' });
    assert.match(view(root).nextAction, /^The build check failed for the draft proof PR .*: build check failed: a proof has sorry\. Fix the proofs/);
    receipt(root, head, bothBuilt(), { specBase: 'f'.repeat(40) });
    assert.match(view(root).nextAction, /does not count: it was made against the spec base f{40}/);
  });

  describe('a receipt that does not count', () => {
    it('accepts no crate when it is of an older version or carries no Lean-level comparison', () => {
      const { root, head } = proofPhase();
      for (const [name, extra, said] of [
        ['a version 1 receipt', { schema: 1 }, /it is a version 1 receipt/],
        ['a receipt with no version', { schema: undefined }, /it is a version unknown receipt/],
        ['a receipt without the comparison', { integrity: undefined }, /it carries no Lean-level comparison/],
        ['a comparison of no statement', { integrity: { semantic: { ...LEAN_COMPARISON, statements: [] } } }, /it carries no Lean-level comparison/],
      ]) {
        receipt(root, head, bothBuilt(), extra);
        const result = view(root);
        assert.equal(result.phase, 'proofs', name);
        assert.match(result.nextAction, said, name);
        assert.match(result.nextAction, /Write the allowed axioms: node fvs-auto\.mjs allowed-axioms/, `${name}: the next steps are those of a run over several crates`);
        assert.equal(result.crates.units.some((entry) => entry.accepted === true), false, name);
      }
      receipt(root, head, bothBuilt());
      assert.equal(view(root).phase, 'done');
    });

    it('stops counting when an accepted record changed after the check, though the list names the same axioms', () => {
      const { root, head } = proofPhase();
      assert.equal(auto.recordExternals({ projectRoot: root, records: [{ id: 'gap-core-div', kind: 'external', source: { symbol: 'core::num::{u32}::wrapping_div', commit: 'a'.repeat(40) },
        model: { symbol: 'wrapping_div_spec', sha256: 'b'.repeat(64) }, claimedBehaviour: 'the stated behaviour', reason: 'the owner accepts it', affectedRoots: [], evidence: ['note.md'],
        status: 'assumption-accepted', decision: { by: 'the owner', at: '2026-11-19T00:00:00.000Z', evidence: 'reply' } }] }).code, 'recorded');
      fs.mkdirSync(path.join(root, 'formal/Trusted'), { recursive: true });
      fs.writeFileSync(path.join(root, 'formal/Trusted/Core.lean'), 'namespace libcrux_hmac.Trusted\n/-- Accepted assumption, `gap-core-div`. -/\naxiom wrapping_div_spec : True\nend libcrux_hmac.Trusted\n');
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'a Trusted axiom');
      const next = git(root, 'rev-parse', 'HEAD');
      assert.equal(cli('record-pr', '--project-root', root, '--kind', 'proof', '--url', 'https://example.invalid/pr/2', '--branch', 'proofs', '--head', next).status, 0);
      receipt(root, next, bothBuilt(), { specBase: head });
      assert.equal(view(root).phase, 'done');
      const listBefore = allowAxioms(root, next).sha256;
      // The owner changes what the record assumes; its id, status and source crate stay.
      const file = path.join(root, '.formalising', 'auto-fv', 'externals.json');
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      data.records[0].model.sha256 = 'c'.repeat(64);
      fs.writeFileSync(file, JSON.stringify(data));
      assert.equal(allowAxioms(root, next).sha256, listBefore, 'the list names the same axioms, so its digest is the same');
      const result = view(root);
      assert.equal(result.phase, 'proofs');
      assert.match(result.nextAction, /does not count: the externals records are not the ones the check read/);
      assert.match(result.nextAction, /Write the allowed axioms: node fvs-auto\.mjs allowed-axioms/);
      assert.deepEqual(result.crates.units.map((entry) => entry.accepted), [false, false]);
      assert.match(result.crates.units[0].reason, /^the build check receipt does not count: the externals records are not the ones the check read/);
      // A check made after the change reads the new file.
      receipt(root, next, bothBuilt(), { specBase: head });
      assert.equal(view(root).phase, 'done');
    });
  });

  it('a project the owner narrowed to one crate is judged on that crate alone', () => {
    const targets = { crates: ['libcrux_hmac'], nonTargets: [{ crate: 'libcrux_sha2', decision: 'Not verified; its behaviour is assumed.' }] };
    const { root, head } = proofPhase(hmacAndSha2, { targets });
    receipt(root, head, [specFile(HMAC_SPEC, [statement('hmac_spec')])]);
    const result = view(root);
    assert.equal(result.phase, 'done', result.nextAction);
    assert.deepEqual(result.crates.units.map((entry) => [entry.crate, entry.accepted]), [['libcrux_hmac', true], ['libcrux_sha2', undefined]]);
  });

  describe('a verified crate that uses another verified crate without being stitched to it', () => {
    // hmac's LLBC reaches sha2 items, but its Lean neither imports sha2 nor is stitched to it, so
    // each of those items would be an axiom in hmac's own Lean.
    const unstitched = (directory) => {
      const [hmac, sha2] = hmacAndSha2(directory);
      delete hmac.imports;
      hmac.foreignCrates = [{ crate: 'libcrux_sha2', kind: 'target' }, { crate: 'core', kind: 'external' }];
      return [hmac, sha2];
    };

    it('is not accepted, though every statement built, and the reason names the crate and the fix', () => {
      const { root, head } = proofPhase(unstitched);
      receipt(root, head, bothBuilt());
      const result = view(root);
      assert.equal(result.phase, 'proofs');
      assert.match(result.nextAction, /crate libcrux_hmac: it uses items of libcrux_sha2, which is verified, without being stitched to it: they would be axioms in libcrux_hmac's Lean, not libcrux_sha2's translation\. Stitch libcrux_hmac to libcrux_sha2 in the extraction spec, or have the owner record libcrux_sha2 as a non-target in the agreement\./);
      assert.deepEqual(result.crates.units.map((entry) => [entry.crate, entry.accepted]), [['libcrux_hmac', false], ['libcrux_sha2', true]], 'the provider is accepted on its own statements');
      assert.ok(result.warnings.some((text) => /^crate libcrux_hmac uses items of libcrux_sha2, which is verified, without being stitched to it/.test(text)));
    });

    it('is accepted once the owner records the provider as a non-target, and the state is done on the consumer alone', () => {
      const targets = { crates: ['libcrux_hmac'], nonTargets: [{ crate: 'libcrux_sha2', decision: 'Not verified; its behaviour is assumed.' }] };
      const { root, head } = proofPhase(unstitched, { targets });
      receipt(root, head, [specFile(HMAC_SPEC, [statement('hmac_spec')])]);
      const result = view(root);
      assert.equal(result.phase, 'done', result.nextAction);
      assert.deepEqual(result.warnings.filter((text) => /without being stitched/.test(text)), []);
    });
  });

  describe('a crate the extraction only assumes', () => {
    // The extraction declares libcrux_traits a non-target: its items are axioms in the crates that call it.
    const assumes = (directory) => {
      const rows = hmacAndSha2(directory);
      rows[0].nonTargets = [{ crate: 'libcrux_traits', source: 'the tree pinned by the extraction' }];
      return rows;
    };

    it('keeps the run from being done until the owner records the decision in the agreement', () => {
      const { root, head } = proofPhase(assumes);
      receipt(root, head, bothBuilt());
      const result = view(root);
      assert.equal(result.phase, 'proofs');
      assert.match(result.nextAction, /but not every verified crate is accepted: crate libcrux_traits: the extraction assumes this crate as a non-target, and the owner has not recorded that decision in the agreement\. Fix what is named/);
      assert.ok(result.pendingDecisions.includes('non-target crate libcrux_traits: the owner has not recorded a decision in the agreement'));
      assert.deepEqual(result.crates.units.map((entry) => [entry.crate, entry.accepted]), [['libcrux_hmac', true], ['libcrux_sha2', true]], 'the verified crates are accepted on their own statements');
    });

    it('is done once the agreement records it, as the owner\'s decision', () => {
      const targets = { crates: ['libcrux_hmac'], nonTargets: [{ crate: 'libcrux_traits', decision: 'Not verified; its behaviour is assumed.' }, { crate: 'libcrux_sha2', decision: 'Not verified either.' }] };
      const { root, head } = proofPhase(assumes, { targets });
      receipt(root, head, [specFile(HMAC_SPEC, [statement('hmac_spec')])]);
      const result = view(root);
      assert.equal(result.phase, 'done', result.nextAction);
      assert.deepEqual(result.pendingDecisions.filter((text) => /non-target/.test(text)), []);
    });
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
