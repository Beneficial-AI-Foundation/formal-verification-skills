'use strict';

// The allowed axioms of a run over several crates (scripts/fvs-auto.mjs, `allowed-axioms`). The
// engine lists, fully qualified and from the blobs of one commit, the axioms the owner may
// assume: the extraction's own declarations for items of crates the owner does not verify, the
// ones its stitch assumes or that the owner accepted for the crate's own opaque items, and the
// hand-written Trusted axioms that cite an accepted record. Everything else is withheld and
// named. The list has one section for each verified crate: its spec files and the axioms its
// statements may rest on, which include those of the crates it depends on. Projects are
// temporary git fixtures; no build runs.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const fixtures = require('./helpers/multicrate-fixtures.cjs');

const { ROOT, cli, git, extracted, fn, unit } = fixtures;
let auto = null;

before(async () => {
  auto = await import(pathToFileURL(path.join(ROOT, 'scripts', 'fvs-auto.mjs')).href);
  fixtures.use(auto);
});

after(fixtures.cleanup);

const HEADER = 'module\npublic import Aeneas\n@[expose] public section\nnoncomputable section\n';

// What Aeneas writes for an axiom: a doc comment with the Rust path, an attribute on lines of
// its own, then the keyword with the name on the next line.
const extractionAxiom = (rust, name, type = 'Result Unit') => `/-- [${rust}]:
    Source: 'src/x.rs', lines 1:0-1:10
    Name pattern: [${rust}]
    Visibility: public -/
@[rust_fun
  "${rust}"]
axiom ${name}
  :
  ${type}
`;
const leanFile = (crate, ...bodies) => `${HEADER}\nnamespace ${crate}\n\n${bodies.join('\n')}\nend ${crate}\n`;
const trustedFile = (...bodies) => `namespace libcrux_hmac.Trusted\n\n${bodies.join('\n')}\nend libcrux_hmac.Trusted\n`;

const record = (id, source, overrides = {}) => ({ id, kind: 'external', source: { symbol: source, commit: 'a'.repeat(40) }, model: { symbol: `${id} model`, sha256: 'b'.repeat(64) },
  claimedBehaviour: 'the stated behaviour', reason: 'the owner accepts it', affectedRoots: [], evidence: ['note.md'], status: 'assumption-accepted',
  decision: { by: 'the owner', at: '2026-11-19T00:00:00.000Z', evidence: 'reply' }, ...overrides });
const open = (id, source) => record(id, source, { status: 'open', decision: null });

const FOREIGN = [{ crate: 'core', kind: 'external' }, { crate: 'libcrux_traits', kind: 'non-target' }, { crate: 'libcrux_sha2', kind: 'target' }];

// hmac and sha2, both verified. `files` are the Lean files the extraction published for hmac,
// `trusted` the hand-written files, `stitch` hmac's stitch to sha2; everything is committed. With
// `thirdFiles` the project holds a third crate, libcrux_c, that sha2 imports.
function scenario({ files = {}, trusted = {}, stitch = [], records = [], sha2Files = {}, thirdFiles = null, commit = true, below = false } = {}) {
  const root = extracted((directory) => {
    const row = (crate, lean, extra) => {
      const made = unit(directory, crate, [fn(`${crate}::x::f`, 'src/x.rs', 1)], extra);
      for (const [name, text] of Object.entries(lean)) {
        const file = path.join(directory, crate, name);
        fs.writeFileSync(file, text);
        made.publication.push({ attemptPath: `/attempt/${crate}/${name}`, projectPath: file, sha256: crypto.createHash('sha256').update(text).digest('hex') });
      }
      return made;
    };
    const core = { foreignCrates: [{ crate: 'core', kind: 'external' }] };
    return [row('libcrux_hmac', files, { imports: ['libcrux_sha2'], stitch, foreignCrates: FOREIGN }), row('libcrux_sha2', sha2Files, thirdFiles ? { ...core, imports: ['libcrux_c'] } : core),
      ...(thirdFiles ? [row('libcrux_c', thirdFiles, core)] : [])];
  }, { below });
  for (const [name, text] of Object.entries(trusted)) {
    fs.mkdirSync(path.join(root, 'formal', 'Trusted'), { recursive: true });
    fs.writeFileSync(path.join(root, 'formal', 'Trusted', name), text);
  }
  if (records.length > 0) assert.equal(auto.recordExternals({ projectRoot: root, records }).code, 'recorded');
  if (commit) {
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'files');
  }
  return root;
}

const write = (root, ...args) => cli('allowed-axioms', '--project-root', root, ...args);
const sections = (root) => JSON.parse(fs.readFileSync(path.join(root, '.formalising', 'auto-fv', 'allowed-axioms.json'), 'utf8')).crates;
// The distinct names over every crate's section.
const listed = (root) => [...new Set(sections(root).flatMap((entry) => entry.axioms))].sort();

describe('the Lean axiom reader', () => {
  it('reads the names Aeneas writes on the line after the keyword, in the enclosing namespaces', () => {
    const { axioms, unread } = auto.leanAxioms(leanFile('libcrux_hmac',
      extractionAxiom('core::num::{u32}::wrapping_div', 'core.num.U32.wrapping_div', 'Std.U32 → Std.U32 → Result Std.U32'),
      extractionAxiom('libcrux_sha2::impl_hacl::Sha256', 'libcrux_sha2.impl_hacl.Sha256', 'Type')));
    assert.equal(unread, 0);
    assert.deepEqual(axioms.map((axiom) => axiom.full), ['libcrux_hmac.core.num.U32.wrapping_div', 'libcrux_hmac.libcrux_sha2.impl_hacl.Sha256']);
    assert.match(axioms[0].doc, /^\/-- \[core::num::\{u32\}::wrapping_div\]:/, 'the doc comment before the attribute lines belongs to the axiom');
  });

  it('follows sections, dotted namespaces, ends and root names', () => {
    const { axioms, unread } = auto.leanAxioms(`namespace A.B
section
axiom one : True
end
namespace C
axiom two : True
end C
axiom _root_.three : True
axiom four : True
end A.B
axiom five : True
`);
    assert.equal(unread, 0);
    assert.deepEqual(axioms.map((axiom) => axiom.full), ['A.B.one', 'A.B.C.two', 'three', 'A.B.four', 'five']);
  });

  it('is not misled by the word in comments, strings or longer names, and counts one it cannot place', () => {
    const quiet = auto.leanAxioms('namespace N\n-- axiom in a line comment\n/- axiom in /- a nested -/ block -/\ndef s := "axiom in a string"\ndef axioms_list := 1\ntheorem t : True := trivial\n/-- axiom in a docstring -/\naxiom real : True\nend N\n');
    assert.deepEqual(quiet.axioms.map((axiom) => axiom.full), ['N.real']);
    assert.equal(quiet.unread, 0);
    assert.equal(auto.leanAxioms('def x := axiom\n').unread, 1, 'a keyword that starts no declaration is counted, so the file is not read');
  });

  it('reads an axiom with its attributes on the same line and no doc comment', () => {
    const { axioms } = auto.leanAxioms('namespace N\n@[simp] axiom a : True\nnoncomputable axiom b : True\nend N\n');
    assert.deepEqual(axioms.map((axiom) => [axiom.full, axiom.doc]), [['N.a', null], ['N.b', null]]);
  });
});

describe('the allowed axioms of a run over several crates', () => {
  it('lists the axioms the extraction declares for other libraries and for crates the owner does not verify, fully qualified, in a file with its digest', () => {
    const root = scenario({ files: { 'Hmac.lean': leanFile('libcrux_hmac',
      extractionAxiom('core::num::{u32}::wrapping_div', 'core.num.U32.wrapping_div', 'Std.U32 → Std.U32 → Result Std.U32'),
      extractionAxiom('libcrux_traits::digest::Foo', 'libcrux_traits.digest.Foo', 'Type')) } });
    const result = write(root);
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(result.json.withheld, []);
    const file = path.join(root, '.formalising', 'auto-fv', 'allowed-axioms.json');
    const bytes = fs.readFileSync(file);
    assert.equal(result.json.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.equal(result.json.file, file);
    assert.equal(bytes.toString('utf8'), `${JSON.stringify({ schema: 'fvs/auto-allowed-axioms', schemaVersion: 2, crates: [
      { crate: 'libcrux_hmac', specFiles: [], axioms: ['libcrux_hmac.core.num.U32.wrapping_div', 'libcrux_hmac.libcrux_traits.digest.Foo'] },
      { crate: 'libcrux_sha2', specFiles: [], axioms: [] },
    ] }, null, 2)}\n`);
    assert.equal(result.json.names, 2);
    assert.equal(result.json.crates, 2);
  });

  describe('one section for each verified crate', () => {
    const own = (crate, rust, name) => leanFile(crate, extractionAxiom(rust, name));

    it('a crate rests on its own axioms and those of the crates it depends on, never on a consumer\'s', () => {
      const root = scenario({ files: { 'Hmac.lean': own('libcrux_hmac', 'core::a', 'core.a') }, sha2Files: { 'Sha2.lean': own('libcrux_sha2', 'core::b', 'core.b') } });
      assert.equal(write(root).status, 0);
      assert.deepEqual(sections(root).map((entry) => [entry.crate, entry.axioms]), [
        ['libcrux_hmac', ['libcrux_hmac.core.a', 'libcrux_sha2.core.b']],
        ['libcrux_sha2', ['libcrux_sha2.core.b']],
      ]);
    });

    it('a statement of the provider cannot rest on the consumer\'s stitch assumption', () => {
      const stitch = [{ provider: 'libcrux_sha2', modules: ['Sha2'], replaced: [], assumed: [{ rustPath: 'libcrux_sha2::hacl::hash_256', name: 'libcrux_sha2.hacl.hash_256', reason: 'opaque in the provider' }] }];
      const root = scenario({ files: { 'Hmac.lean': own('libcrux_hmac', 'libcrux_sha2::hacl::hash_256', 'libcrux_sha2.hacl.hash_256') }, stitch });
      assert.equal(write(root).status, 0);
      const [hmac, sha2] = sections(root);
      assert.deepEqual(hmac.axioms, ['libcrux_hmac.libcrux_sha2.hacl.hash_256']);
      assert.deepEqual(sha2.axioms, []);
    });

    it('a Trusted axiom tied to an accepted record is in every section', () => {
      const root = scenario({ records: [record('gap-div', 'core::num::{u32}::wrapping_div')],
        trusted: { 'Core.lean': trustedFile('/-- Accepted assumption, `gap-div`. -/\naxiom wrapping_div_spec : True\n') } });
      assert.equal(write(root).status, 0);
      assert.deepEqual(sections(root).map((entry) => [entry.crate, entry.axioms]), [
        ['libcrux_hmac', ['libcrux_hmac.Trusted.wrapping_div_spec']],
        ['libcrux_sha2', ['libcrux_hmac.Trusted.wrapping_div_spec']],
      ]);
    });

    it('an axiom of a crate the owner dropped reaches a verified crate stitched to it, and no section of its own exists', () => {
      const dropped = { crates: ['libcrux_hmac'], nonTargets: [{ crate: 'libcrux_sha2', decision: 'Not verified; its behaviour is assumed.' }] };
      const root = scenario({ sha2Files: { 'Sha2.lean': own('libcrux_sha2', 'core::b', 'core.b') } });
      fixtures.recordAgreement(root, fixtures.agreementFor(root, { targets: dropped }));
      assert.equal(write(root).status, 0);
      assert.deepEqual(sections(root).map((entry) => [entry.crate, entry.axioms]), [['libcrux_hmac', ['libcrux_sha2.core.b']]]);
    });

    it('a crate rests on the axioms of a crate its provider depends on, through the whole chain', () => {
      const root = scenario({ files: { 'Hmac.lean': own('libcrux_hmac', 'core::a', 'core.a') }, sha2Files: { 'Sha2.lean': own('libcrux_sha2', 'core::b', 'core.b') },
        thirdFiles: { 'C.lean': own('libcrux_c', 'core::c', 'core.c') } });
      assert.equal(write(root).status, 0);
      assert.deepEqual(sections(root).map((entry) => [entry.crate, entry.axioms]), [
        ['libcrux_c', ['libcrux_c.core.c']],
        ['libcrux_hmac', ['libcrux_c.core.c', 'libcrux_hmac.core.a', 'libcrux_sha2.core.b']],
        ['libcrux_sha2', ['libcrux_c.core.c', 'libcrux_sha2.core.b']],
      ]);
    });

    it('crates that depend on each other hold each other\'s axioms, and the list is still written', () => {
      const root = scenario({ files: { 'Hmac.lean': own('libcrux_hmac', 'core::a', 'core.a') }, sha2Files: { 'Sha2.lean': own('libcrux_sha2', 'core::b', 'core.b') } });
      const state = fixtures.readState(root);
      state.extraction.run.units[1].imports = ['libcrux_hmac'];
      fixtures.writeState(root, state);
      assert.equal(write(root).status, 0);
      assert.deepEqual(sections(root).map((entry) => [entry.crate, entry.axioms]), [
        ['libcrux_hmac', ['libcrux_hmac.core.a', 'libcrux_sha2.core.b']],
        ['libcrux_sha2', ['libcrux_hmac.core.a', 'libcrux_sha2.core.b']],
      ]);
    });
  });

  it('the file is the same bytes on every run, so its digest is the identity of the list', () => {
    const root = scenario({ files: { 'Hmac.lean': leanFile('libcrux_hmac', extractionAxiom('core::a', 'core.a')) } });
    assert.equal(write(root).json.sha256, write(root).json.sha256);
  });

  it('withholds an axiom for another verified crate\'s item, and lists it when the extraction\'s stitch assumes that item', () => {
    const files = { 'Hmac.lean': leanFile('libcrux_hmac', extractionAxiom('libcrux_sha2::hacl::hash_256', 'libcrux_sha2.hacl.hash_256')) };
    const open = write(scenario({ files }));
    assert.equal(open.status, 0, open.stdout);
    assert.deepEqual(open.json.withheld.map((entry) => entry.name), ['libcrux_hmac.libcrux_sha2.hacl.hash_256']);
    assert.match(open.json.withheld[0].reason, /it stands for libcrux_sha2::hacl::hash_256, an item of the verified crate libcrux_sha2: stitch libcrux_hmac to libcrux_sha2, or prove the function there/);
    const stitch = [{ provider: 'libcrux_sha2', modules: ['Sha2'], replaced: [], assumed: [{ rustPath: 'libcrux_sha2::hacl::hash_256', name: 'libcrux_sha2.hacl.hash_256', reason: 'opaque in the provider' }] }];
    const root = scenario({ files, stitch });
    assert.deepEqual(write(root).json.withheld, []);
    assert.deepEqual(listed(root), ['libcrux_hmac.libcrux_sha2.hacl.hash_256']);
  });

  it('the same function declared by the provider itself is a different constant: the consumer\'s copy stays withheld', () => {
    const files = { 'Hmac.lean': leanFile('libcrux_hmac', extractionAxiom('libcrux_sha2::hacl::hash_256', 'libcrux_sha2.hacl.hash_256')) };
    const sha2Files = { 'Sha2.lean': leanFile('libcrux_sha2', extractionAxiom('libcrux_sha2::hacl::hash_256', 'hacl.hash_256')) };
    const root = scenario({ files, sha2Files, records: [record('opaque-hash', 'libcrux_sha2::hacl::hash_256 (opaque there)')] });
    const result = write(root);
    assert.deepEqual(listed(root), ['libcrux_sha2.hacl.hash_256'], 'sha2\'s own opaque item, which its owner accepted');
    assert.deepEqual(result.json.withheld.map((entry) => entry.name), ['libcrux_hmac.libcrux_sha2.hacl.hash_256']);
  });

  it('lists an item of the crate itself that the extraction left opaque only with an accepted record whose source starts with its path', () => {
    const own = { 'Hmac.lean': leanFile('libcrux_hmac', extractionAxiom('libcrux_hmac::incremental::hmac_slices', 'incremental.hmac_slices')) };
    const reasons = (records) => write(scenario({ files: own, records })).json.withheld.map((entry) => entry.reason);
    assert.match(reasons([])[0], /an item of the verified crate libcrux_hmac that has no definition there: the owner accepts it with an externals record whose source starts with that path/);
    assert.equal(reasons([open('a3', 'libcrux_hmac::incremental::hmac_slices')]).length, 1, 'an open record is not an acceptance');
    assert.equal(reasons([record('a3', 'libcrux_hmac::incremental::hmac_slices_more')]).length, 1, 'another path that only begins the same');
    const root = scenario({ files: own, records: [record('a3', 'libcrux_hmac::incremental::hmac_slices (crates/hmac/src/incremental.rs lines 94-107)')] });
    assert.deepEqual(write(root).json.withheld, []);
    assert.deepEqual(listed(root), ['libcrux_hmac.incremental.hmac_slices']);
  });

  it('withholds an extraction axiom whose crate the extraction did not record, and one with no Rust path', () => {
    const root = scenario({ files: { 'Hmac.lean': leanFile('libcrux_hmac', extractionAxiom('mystery::f', 'mystery.f'), '/-- A fact someone stated. -/\naxiom my_fact : 1 = 1\n') } });
    const { withheld } = write(root).json;
    assert.deepEqual(withheld.map((entry) => entry.name), ['libcrux_hmac.mystery.f', 'libcrux_hmac.my_fact']);
    assert.match(withheld[0].reason, /^its crate mystery is not one the extraction recorded for libcrux_hmac$/);
    assert.match(withheld[1].reason, /^its doc comment gives no Rust path, so its crate cannot be read$/);
    assert.deepEqual(listed(root), []);
  });
});

describe('hand-written Trusted axioms', () => {
  const cite = (id, name) => `/-- Accepted assumption, \`${id}\`. -/\naxiom ${name} : True\n`;
  const records = [record('gap-div', 'core::num::{u32}::wrapping_div'), record('a2-sha2', 'libcrux_sha2::hacl::{h256, h384} (libcrux-sha2 0.0.8, crates.io; 2 functions)'),
    open('gap-open', 'core::num::{u32}::wrapping_rem'), record('vague', 'the hash function')];
  const trusted = { 'Gaps.lean': trustedFile(cite('gap-div', 'div_spec'), cite('a2-sha2', 'h256_spec'), cite('gap-open', 'rem_spec'), cite('vague', 'vague_spec'), '/-- Nobody accepted this. -/\naxiom loose_spec : True\n') };

  it('are listed when their docstring cites an accepted record about a crate that is not verified, and withheld otherwise', () => {
    const root = scenario({ trusted, records });
    const { withheld } = write(root).json;
    assert.deepEqual(listed(root), ['libcrux_hmac.Trusted.div_spec']);
    assert.deepEqual(withheld.map((entry) => [entry.name.replace('libcrux_hmac.Trusted.', ''), entry.reason]), [
      ['h256_spec', 'the record a2-sha2 is about libcrux_sha2, a verified crate: prove it there'],
      ['rem_spec', 'its docstring cites no accepted externals record (the record id in backticks)'],
      ['vague_spec', 'the record vague names no crate path in its source'],
      ['loose_spec', 'its docstring cites no accepted externals record (the record id in backticks)'],
    ]);
  });

  it('a record about a crate the owner chose not to verify makes its axioms listable', () => {
    const root = scenario({ trusted, records });
    const targets = { crates: ['libcrux_hmac'], nonTargets: [{ crate: 'libcrux_sha2', decision: 'Not verified; its behaviour is assumed.' }] };
    fixtures.recordAgreement(root, fixtures.agreementFor(root, { targets }));
    write(root);
    assert.deepEqual(listed(root), ['libcrux_hmac.Trusted.div_spec', 'libcrux_hmac.Trusted.h256_spec']);
  });

  it('are read from the commit: a file in the working tree only is not listed, and an edit after the commit changes nothing', () => {
    const root = scenario({ trusted, records, commit: false });
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'files');
    fs.writeFileSync(path.join(root, 'formal', 'Trusted', 'More.lean'), trustedFile(cite('gap-div', 'extra_spec')));
    fs.appendFileSync(path.join(root, 'formal', 'Trusted', 'Gaps.lean'), 'axiom added_later : True\n');
    write(root);
    assert.deepEqual(listed(root), ['libcrux_hmac.Trusted.div_spec']);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'more');
    write(root);
    assert.deepEqual(listed(root), ['libcrux_hmac.Trusted.div_spec', 'libcrux_hmac.Trusted.extra_spec']);
  });
});

describe('a Lean project below the top of the repository', () => {
  it('reads the published files and the Trusted files at the commit, by their place in the project', () => {
    const trusted = { 'Gaps.lean': trustedFile('/-- Accepted assumption, `gap-div`. -/\naxiom div_spec : True\n') };
    const root = scenario({ below: true, trusted, records: [record('gap-div', 'core::num::{u32}::wrapping_div')],
      files: { 'Hmac.lean': leanFile('libcrux_hmac', extractionAxiom('core::a', 'core.a')) } });
    assert.equal(fs.existsSync(path.join(path.dirname(root), '.git')), true, 'the repository top is the parent of the project');
    const result = write(root);
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(listed(root), ['libcrux_hmac.Trusted.div_spec', 'libcrux_hmac.core.a']);
    assert.deepEqual(result.json.withheld, []);
  });
});

describe('what stops the list from being written', () => {
  const lean = { 'Hmac.lean': leanFile('libcrux_hmac', extractionAxiom('core::a', 'core.a')) };

  it('refuses a published file that is not the file the extraction recorded', () => {
    const root = scenario({ files: lean, commit: false });
    fs.appendFileSync(path.join(root, 'libcrux_hmac', 'Hmac.lean'), '-- edited\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'files');
    const result = write(root);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.json.code, 'allowed-axioms-unreadable');
    assert.match(result.json.message, /libcrux_hmac\/Hmac\.lean differs from the file the extraction published/);
  });

  it('refuses a published file that the commit does not hold', () => {
    const root = scenario({ files: lean, commit: false });
    const result = write(root);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.json.message, /libcrux_hmac\/Hmac\.lean is not in the commit [0-9a-f]{40}/);
  });

  it('refuses a file with an axiom keyword it cannot place, and a commit that is not in the checkout', () => {
    const text = `${leanFile('libcrux_hmac', extractionAxiom('core::a', 'core.a'))}def x := axiom\n`;
    const root = scenario({ files: { 'Hmac.lean': text } });
    assert.match(write(root).json.message, /holds 1 axiom keyword\(s\) the engine could not place in a declaration/);
    assert.match(write(root, '--commit', 'f'.repeat(40)).json.message, /is not a commit in this checkout/);
  });

  it('names the real cause when a published file lies outside this checkout', () => {
    const root = scenario({ files: lean });
    const state = fixtures.readState(root);
    for (const row of state.extraction.run.units) for (const entry of row.publication) if (entry.projectPath.endsWith('.lean')) entry.projectPath = `/elsewhere/checkout/${path.basename(entry.projectPath)}`;
    fixtures.writeState(root, state);
    const result = write(root);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.json.message, /is outside this project \(.*\), so it cannot be read at [0-9a-f]{40}: the extraction was recorded from another checkout, so record it again from this one/);
  });

  it('is not written for a project with one crate', () => {
    const root = extracted((directory) => [unit(directory, 'libcrux_hmac', [fn('libcrux_hmac::x::f', 'src/x.rs', 1)])]);
    const result = write(root);
    assert.equal(result.status, 1, result.stdout);
    assert.equal(result.json.code, 'not-multi-crate');
    assert.equal(fs.existsSync(path.join(root, '.formalising', 'auto-fv', 'allowed-axioms.json')), false);
  });
});

// The real extraction of libcrux-hmac and its records, read from git objects. Set
// FVS_RC2_LIBCRUX_VERIFY to a libcrux-verify checkout that holds the rc2 head (default commit
// 0951181; FVS_RC2_COMMIT names another); without it this block is skipped.
const REAL = process.env.FVS_RC2_LIBCRUX_VERIFY;
describe('the real libcrux-hmac extraction', { skip: REAL ? false : 'set FVS_RC2_LIBCRUX_VERIFY to a libcrux-verify checkout' }, () => {
  const rev = process.env.FVS_RC2_COMMIT ?? '0951181';
  const commit = () => spawnSync('git', ['-C', REAL, 'rev-parse', rev], { encoding: 'utf8' }).stdout.trim();
  const context = (targets) => {
    const blob = spawnSync('git', ['-C', REAL, 'cat-file', 'blob', `${commit()}:./LibcruxHmac/Extraction/LibcruxHmac.lean`], { maxBuffer: 1 << 28 }).stdout;
    const hmac = { crate: 'libcrux_hmac', package: 'libcrux-hmac', stitch: [], publication: [{ attemptPath: 'x', projectPath: `${REAL}/LibcruxHmac/Extraction/LibcruxHmac.lean`, sha256: crypto.createHash('sha256').update(blob).digest('hex') }],
      foreignCrates: [...['core', 'alloc'].map((crate) => ({ crate, kind: 'external' })), ...['libcrux_sha2', 'libcrux_hacl_rs', 'libcrux_traits'].map((crate) => ({ crate, kind: 'non-target' }))] };
    const others = targets.filter((crate) => crate !== 'libcrux_hmac').map((crate) => ({ crate, package: crate.replace(/_/g, '-'), publication: [], stitch: [], foreignCrates: [] }));
    const units = [hmac, ...others];
    return { units, targets, view: { units: units.map((entry) => ({ crate: entry.crate, dependsOn: [] })) } };
  };

  it('lists every axiom the guards of the rc2 head print, fully qualified, when hmac is the only crate verified', () => {
    const result = auto.allowedAxiomList(REAL, {}, context(['libcrux_hmac']), commit());
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.withheld, []);
    assert.equal(result.axioms.length, 71, '43 declared by the extraction (42 for other crates and libraries and hmac\'s own opaque item), 28 Trusted');
    assert.ok(result.axioms.includes('libcrux_hmac.Trusted.hash_256_spec'));
    assert.ok(result.axioms.includes('libcrux_hmac.core.num.U32.wrapping_div'));
    assert.ok(result.axioms.includes('libcrux_hmac.incremental.hmac_slices'), 'the crate\'s own opaque item, through its accepted record');
  });

  it('withholds everything about sha2 once sha2 is verified too: its items and the Trusted axioms accepted for them', () => {
    const result = auto.allowedAxiomList(REAL, {}, context(['libcrux_hmac', 'libcrux_sha2']), commit());
    assert.deepEqual(result.problems, []);
    assert.equal(result.axioms.includes('libcrux_hmac.libcrux_sha2.hacl.hash_256'), false);
    assert.equal(result.axioms.includes('libcrux_hmac.Trusted.hash_256_spec'), false);
    assert.equal(result.axioms.includes('libcrux_hmac.core.num.U32.wrapping_div'), true, 'a core function stays assumable');
    assert.equal(result.withheld.length, 54, '33 extraction axioms for sha2 items and 21 Trusted axioms accepted through sha2 records');
  });
});
