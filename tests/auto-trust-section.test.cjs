'use strict';

// The pull request trust section is generated from the run records: the build check receipt of a
// commit, externals.json and specs.json. These tests build a small project on disk and check the
// join between axiom lists and records, the labels, the refusals and that nothing is written.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'fvs-auto-bundle.mjs');
const COMMIT = 'a'.repeat(40);
const STANDARD = ['propext', 'Classical.choice', 'Quot.sound'];
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

const record = (id, kind, status, source, model, extra = {}) => ({
  id, kind, source: { symbol: source, commit: 'c'.repeat(40) }, model: { symbol: model, sha256: 'd'.repeat(64) },
  claimedBehaviour: 'behaves as the Rust code does', reason: 'no model at the pin', affectedRoots: [], evidence: ['extraction line 1'], status,
  decision: status === 'open' ? null : { by: 'owner', at: '2026-11-18', evidence: 'ruling' }, ...extra,
});
const EXTERNALS = [
  // The id says "gap" but the source crate is a dependency: the layer follows the source, not the id.
  record('gap-sha2-hacl', 'external', 'assumption-accepted', 'libcrux_sha2::hacl::{h256, h384} (libcrux-sha2 0.0.8)', 'demo.libcrux_sha2.hacl.* (2 axioms)'),
  record('a2-impl', 'external', 'assumption-accepted', 'libcrux_sha2::impl_hacl::{Sha256, Sha384}', 'demo.libcrux_sha2.impl_hacl.{Sha256, Sha384} (2 axioms)'),
  record('std-div', 'external', 'assumption-accepted', 'core::num::{u32}::wrapping_div', 'demo.core.num.U32.wrapping_div (axiom)'),
  record('std-fmt', 'external', 'open', 'core::num::error::{impl Debug for TryFromIntError}::fmt', 'demo.core.num.error.TryFromIntError.Insts.CoreFmtDebug.fmt (axiom)'),
  record('opaque-slices', 'opaque', 'assumption-accepted', 'demo::incremental::hmac_slices', 'demo.incremental.hmac_slices (1 axiom)'),
  record('sp-01', 'semantic-patch', 'assumption-accepted', 'demo::hmac::compute', 'demo.hacl.hmac.compute'),
];
const statement = (name, axioms, extra = {}) => ({ name, line: 1, status: 'built', reason: null, axioms: [...STANDARD, ...axioms],
  beyondStandard: axioms, flags: [], ...extra });
const FILES = {
  'Demo/Specs/Hmac.lean': [
    statement('tag_size_spec', []),
    statement('hmac_spec', ['core.num.U32.wrapping_div', 'core.num.error.TryFromIntError.Insts.CoreFmtDebug.fmt', 'libcrux_sha2.hacl.h256', 'Trusted.div_spec']),
  ],
  'Demo/Specs/Incremental.lean': [
    statement('new_spec', ['libcrux_sha2.impl_hacl.Sha256', 'libcrux_sha2.hacl.h384', 'core.num.U32.wrapping_div']),
  ],
  'Demo/Specs/Other.lean': [statement('other_spec', ['libcrux_sha2.impl_hacl.Sha384'])],
};

function makeProject({ files = FILES, externals = EXTERNALS, receipt = {}, specs = true, prs = [] } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-trust-')));
  const auto = path.join(root, '.formalising', 'auto-fv');
  fs.mkdirSync(path.join(auto, 'build-check'), { recursive: true });
  const specRows = [];
  for (const [file, statements] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), `-- ${file}\n`);
    fs.writeFileSync(path.join(root, 'review.md'), 'review\n');
    specRows.push({ specFile: file, items: ['demo::item'], outOfScope: [], round: 2, verdict: 'pass', specSha256: sha256(`-- ${file}\n`),
      review: 'review.md', reviewSha256: sha256('review\n'), recordedAt: '2026-11-17T00:00:00.000Z', statements });
  }
  const fileRows = Object.entries(files).map(([file, statements]) => ({ path: file, sha256: 'e'.repeat(64), status: 'built', reason: null, statements }));
  fs.writeFileSync(path.join(auto, 'build-check', `${COMMIT}.json`), JSON.stringify({ schema: 1, kind: 'fvs-build-check', accepted: true, label: 'accepted (build check)',
    commit: COMMIT, tree: 'b'.repeat(40), specFiles: fileRows, flags: [], warnings: [], ...receipt }));
  if (externals !== null) fs.writeFileSync(path.join(auto, 'externals.json'), JSON.stringify({ schema: 'fvs/auto-externals', schemaVersion: 1, records: externals }));
  if (specs) fs.writeFileSync(path.join(auto, 'specs.json'), JSON.stringify({ schema: 'fvs/auto-specs', schemaVersion: 1, specs: specRows.map(({ statements, ...row }) => row), prs }));
  return root;
}
// Makes the project a git repository with one commit and moves the receipt to that commit, the way a
// real run has it: the receipt names the commit that was built and checked.
function gitify(root, { change } = {}) {
  const git = (...args) => {
    const run = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  git('init', '-q');
  if (change) fs.appendFileSync(path.join(root, change), '-- changed after the review\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'project');
  const sha = git('rev-parse', 'HEAD');
  const dir = path.join(root, '.formalising', 'auto-fv', 'build-check');
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, `${COMMIT}.json`), 'utf8'));
  fs.rmSync(path.join(dir, `${COMMIT}.json`));
  fs.writeFileSync(path.join(dir, `${sha}.json`), JSON.stringify({ ...receipt, commit: sha }));
  return sha;
}
const writeNotes = (root, notes) => {
  const file = path.join(root, 'notes.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 'fvs/auto-pr-notes', schemaVersion: 1, ...notes }));
  return file;
};
const snapshot = (root) => {
  const rows = [];
  const walk = (dir) => { for (const name of fs.readdirSync(dir).sort()) { const file = path.join(dir, name); fs.statSync(file).isDirectory() ? walk(file) : rows.push(`${file} ${sha256(fs.readFileSync(file))}`); } };
  walk(root);
  return rows;
};

describe('pull request trust section', () => {
  let api;
  const roots = [];
  const project = (options) => { const root = makeProject(options); roots.push(root); return root; };
  const refuses = (fn, code) => assert.throws(fn, (error) => { assert.equal(error.code, code, error.message); return true; });
  before(async () => { api = await import('../scripts/fvs-auto-bundle.mjs'); });
  after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

  it('joins axiom lists to records by glob, brace group and exact name, and keeps the rest visible', () => {
    const root = project();
    const result = api.trustSection({ projectRoot: root, commit: COMMIT });
    // 3 Lean + (wrapping_div, fmt, h256, h384, Sha256, Sha384) named by records + Trusted.div_spec named by none.
    assert.deepEqual(result.checks.axioms, { distinct: 10, leanStandard: 3, namedByRecords: 6, namedByNoRecord: 1 });
    assert.deepEqual(result.unnamedAxioms, ['Trusted.div_spec']);
    const hmac = result.statements.find((s) => s.name === 'hmac_spec');
    assert.deepEqual(hmac.accepted.sort(), ['gap-sha2-hacl', 'std-div']);
    assert.deepEqual(hmac.unresolved, ['std-fmt']);
    assert.deepEqual(hmac.unnamed, ['Trusted.div_spec']);
    const incremental = result.statements.find((s) => s.name === 'new_spec');
    assert.deepEqual(incremental.accepted.sort(), ['a2-impl', 'gap-sha2-hacl', 'std-div']);
    const byId = Object.fromEntries(result.records.map((r) => [r.id, r]));
    assert.equal(byId['gap-sha2-hacl'].statements, 2);
    assert.equal(byId['gap-sha2-hacl'].axioms, 2);
    assert.equal(byId['std-fmt'].statements, 1);
    assert.deepEqual(result.checks.recordsInNoAxiomList, ['opaque-slices'], 'a patch is not an axiom, so it is never listed as unused');
  });

  it('gets a layer from the record kind and source crate, never from its id', () => {
    const result = api.trustSection({ projectRoot: project(), commit: COMMIT });
    const layer = Object.fromEntries(result.records.map((r) => [r.id, r.layer]));
    assert.deepEqual(layer, { 'gap-sha2-hacl': 'dependency-crate', 'a2-impl': 'dependency-crate', 'std-div': 'standard-library-gap',
      'std-fmt': 'standard-library-gap', 'opaque-slices': 'project-opaque', 'sp-01': 'translation-patch' });
    assert.match(result.markdown, /\| `sp-01` \| accepted translation patch \| accepted assumption \| .* \| no per-statement link \| not an axiom \|/);
  });

  it('counts records by status from the registry and shows an open record next to the pass it qualifies', () => {
    const result = api.trustSection({ projectRoot: project(), commit: COMMIT });
    assert.deepEqual(result.checks.records, { total: 6, accepted: 5, open: 1, blocked: 0 });
    assert.deepEqual(result.checks.openRecordsInAxiomLists, ['std-fmt']);
    assert.match(result.markdown, /externals\.json holds 6 records: 5 accepted assumptions, 1 open, 0 blocked\./);
    const row = result.markdown.split('\n').find((line) => line.startsWith('| Demo/Specs/Hmac.lean'));
    assert.match(row, /PASS, qualified/);
    assert.match(row, /open record `std-fmt`/);
    const other = result.markdown.split('\n').find((line) => line.startsWith('| Demo/Specs/Other.lean'));
    assert.doesNotMatch(other, /std-fmt/, 'an open record is attached only to the files whose statements reach it');
  });

  it('never shows a pass as clean when the caller stated nothing, and shows a stated none as plain', () => {
    const root = project();
    const sha = gitify(root);
    const unstated = api.trustSection({ projectRoot: root, commit: sha }).markdown.split('\n').find((line) => line.startsWith('| Demo/Specs/Other.lean'));
    assert.match(unstated, /PASS, qualifications NOT STATED/);
    const notes = writeNotes(root, { reviews: {
      'Demo/Specs/Other.lean': { ownerQuestions: [], briefChanges: [] },
      'Demo/Specs/Incremental.lean': { ownerQuestions: ['Should the cumulative limit overflow panic?'], briefChanges: ['Round 2 reviewer was told not to fail the file for the open question'] },
    } });
    const lines = api.trustSection({ projectRoot: root, commit: sha, notes }).markdown.split('\n');
    const plain = lines.find((line) => line.startsWith('| Demo/Specs/Other.lean'));
    assert.match(plain, /\| PASS \|/, 'a stated none, a spec file unchanged at the commit and no open record read as a plain PASS');
    assert.match(plain, /\| none \| none \|/);
    const qualified = lines.find((line) => line.startsWith('| Demo/Specs/Incremental.lean'));
    assert.match(qualified, /PASS, qualified/);
    assert.match(qualified, /Should the cumulative limit overflow panic\?/);
    assert.match(qualified, /Round 2 reviewer was told not to fail the file/);
    assert.match(lines.join('\n'), /A pass means that a fresh reviewer found the statement faithful[^\n]* It is not a proof and it is not acceptance\./);
  });

  it('flags a stale spec file, a recorded head that is not the checked commit and a statement that was not built', () => {
    const files = { ...FILES, 'Demo/Specs/Other.lean': [statement('other_spec', ['libcrux_sha2.impl_hacl.Sha384']), statement('failed_spec', ['core.num.U32.wrapping_div'], { status: 'failing', reason: 'sorry' })] };
    const root = project({ files, prs: [{ kind: 'proof', url: 'https://example.test/pr/3', branch: 'proofs', head: 'f'.repeat(40) }] });
    const sha = gitify(root, { change: 'Demo/Specs/Hmac.lean' });
    const result = api.trustSection({ projectRoot: root, commit: sha });
    assert.match(result.markdown, /Recorded proof pull request head: `f{40}` \(not the commit above/);
    assert.match(result.markdown.split('\n').find((line) => line.startsWith('| Demo/Specs/Hmac.lean')), /CHANGED SINCE REVIEW: the file at this commit differs from the reviewed file/);
    assert.doesNotMatch(result.markdown.split('\n').find((line) => line.startsWith('| Demo/Specs/Incremental.lean')), /CHANGED SINCE REVIEW/);
    assert.deepEqual(result.checks.statements.notBuilt, ['failed_spec']);
    assert.match(result.markdown, /\| failed_spec \| not built \| not built \| not built \|/);
    assert.equal(result.checks.axioms.distinct, 10, 'a statement that was not built adds nothing to the counts');
  });

  it('judges a spec file at the checked commit, not in the checkout, and says when it cannot', () => {
    const root = project();
    const sha = gitify(root);
    fs.appendFileSync(path.join(root, 'Demo/Specs/Hmac.lean'), '-- edited in the checkout after the commit\n');
    const row = api.trustSection({ projectRoot: root, commit: sha }).markdown.split('\n').find((line) => line.startsWith('| Demo/Specs/Hmac.lean'));
    assert.doesNotMatch(row, /CHANGED SINCE REVIEW/, 'a later edit in the checkout does not change what the commit holds');
    const elsewhere = api.trustSection({ projectRoot: project(), commit: COMMIT }).markdown.split('\n').find((line) => line.startsWith('| Demo/Specs/Hmac.lean'));
    assert.match(elsewhere, /not checked against the commit: this checkout does not hold it/);
  });

  it('keeps the recorded head and the merge apart, and flags only a head that differs', () => {
    const prs = [{ kind: 'proof', url: 'https://example.test/pr/3', branch: 'proofs', head: COMMIT },
      { kind: 'proof', merged: true, mergeCommit: '9'.repeat(40), url: 'https://example.test/pr/3', recordedAt: '2026-11-19T00:00:00.000Z' }];
    const md = api.trustSection({ projectRoot: project({ prs }), commit: COMMIT }).markdown;
    assert.match(md, new RegExp(`Recorded proof pull request head: \`${COMMIT}\`\\.\n`));
    assert.match(md, /Recorded merge of the proof pull request: `9{40}`\. A merge commit is not the checked head/);
  });

  it('shows what the owner changed in review next to the pass', () => {
    const prs = [{ kind: 'spec', url: 'https://example.test/pr/2', branch: 'specs', head: 'f'.repeat(40), recordedAt: '2026-11-17T01:00:00.000Z' },
      { kind: 'spec', merged: true, mergeCommit: '9'.repeat(40), recordedAt: '2026-11-18T00:00:00.000Z', ownerChanges: [{ specFile: 'Demo/Specs/Other.lean', change: 'owner-changed' }] }];
    const root = project({ prs });
    const sha = gitify(root);
    const notes = writeNotes(root, { reviews: { 'Demo/Specs/Other.lean': { ownerQuestions: [], briefChanges: [] } } });
    const row = api.trustSection({ projectRoot: root, commit: sha, notes }).markdown.split('\n').find((line) => line.startsWith('| Demo/Specs/Other.lean'));
    assert.match(row, /PASS, qualified; changed by owner in review/);
  });

  it('never lets a namespace glob name every axiom', () => {
    const files = { 'Demo/Specs/Hmac.lean': [statement('s_spec', ['Trusted.div_spec', 'Other.helper', 'libcrux_sha2.hacl.h256'])] };
    const externals = [record('models', 'handwritten-model', 'assumption-accepted', 'demo::models', 'Trusted.* and * (2 axioms)')];
    const result = api.trustSection({ projectRoot: project({ files, externals }), commit: COMMIT });
    assert.deepEqual(result.statements[0].accepted, ['models']);
    assert.deepEqual(result.unnamedAxioms, ['Other.helper', 'libcrux_sha2.hacl.h256'], 'only Trusted. names are covered; the stray star and the shortened form claim nothing');
    assert.equal(result.records[0].axioms, 1);
  });

  it('writes nothing', () => {
    const root = project();
    const before = snapshot(root);
    api.trustSection({ projectRoot: root, commit: COMMIT });
    assert.deepEqual(snapshot(root), before);
  });

  describe('refuses', () => {
    it('a commit that is not full, a missing receipt and a receipt of another commit', () => {
      const root = project();
      refuses(() => api.trustSection({ projectRoot: root, commit: 'abc123' }), 'trust-usage');
      refuses(() => api.trustSection({ projectRoot: root, commit: 'b'.repeat(40) }), 'trust-receipt-missing');
      const other = project({ receipt: { commit: 'b'.repeat(40) } });
      refuses(() => api.trustSection({ projectRoot: other, commit: COMMIT }), 'trust-record-invalid');
    });

    it('a malformed registry, a status it does not know and a registry that is absent while axioms need it', () => {
      refuses(() => api.trustSection({ projectRoot: project({ externals: [{ id: 'x' }] }), commit: COMMIT }), 'trust-record-invalid');
      const proved = [record('p', 'external', 'correspondence-proved', 'core::x', 'demo.x')];
      refuses(() => api.trustSection({ projectRoot: project({ externals: proved }), commit: COMMIT }), 'trust-record-invalid');
      refuses(() => api.trustSection({ projectRoot: project({ externals: null }), commit: COMMIT }), 'trust-externals-missing');
      const standardOnly = { 'Demo/Specs/Hmac.lean': [statement('tag_size_spec', [])] };
      const empty = api.trustSection({ projectRoot: project({ files: standardOnly, externals: null }), commit: COMMIT });
      assert.deepEqual(empty.checks.records, { total: 0, accepted: 0, open: 0, blocked: 0 }, 'no registry is fine when nothing rests on a recorded boundary');
    });

    it('notes that name an unknown spec file or record, or have the wrong shape', () => {
      const root = project();
      const bad = (notes) => refuses(() => api.trustSection({ projectRoot: root, commit: COMMIT, notes: writeNotes(root, notes) }), 'trust-notes-invalid');
      bad({ reviews: { 'Demo/Specs/Missing.lean': { ownerQuestions: [], briefChanges: [] } } });
      bad({ claims: { 'no-such-record': ['a claim'] } });
      refuses(() => api.trustSection({ projectRoot: root, commit: COMMIT, notes: writeNotes(root, { reviews: { 'Demo/Specs/Hmac.lean': { ownerQuestions: [] } } }) }), 'trust-record-invalid');
      refuses(() => api.trustSection({ projectRoot: root, commit: COMMIT, notes: path.join(root, 'absent.json') }), 'trust-notes-invalid');
    });
  });

  describe('ruling list for the spec pull request', () => {
    const OPEN = [
      record('std-fmt', 'external', 'open', 'core::num::error::{impl Debug for TryFromIntError}::fmt', 'demo.core.num.error.TryFromIntError.Insts.CoreFmtDebug.fmt (axiom)',
        { claimedBehaviour: 'Debug formatting only writes to the formatter', reason: 'no model at the pin' }),
      record('dep-sha2', 'external', 'open', 'libcrux_sha2::hacl::h256', 'demo.libcrux_sha2.hacl.h256 (axiom)', { claimedBehaviour: 'h256 computes SHA-256', reason: 'published crate, not extracted' }),
      record('std-div', 'external', 'assumption-accepted', 'core::num::{u32}::wrapping_div', 'demo.core.num.U32.wrapping_div (axiom)'),
      record('sp-01', 'semantic-patch', 'blocked', 'demo::hmac::compute', 'demo.hacl.hmac.compute'),
    ];

    it('lists each open record with what it assumes, why it has no model and the owner\'s choices', () => {
      const result = api.rulingList({ projectRoot: project({ externals: OPEN }) });
      assert.deepEqual(result.open.map((r) => r.id), ['std-fmt', 'dep-sha2']);
      assert.deepEqual(result.decided, { accepted: 1, blocked: 1 });
      const md = result.markdown;
      assert.match(md, /^## Claims that need a model or an accepted assumption\n/);
      assert.match(md, /### `std-fmt`: core::num::error::\{impl Debug for TryFromIntError\}::fmt/);
      assert.match(md, /What the claim assumes: Debug formatting only writes to the formatter/);
      assert.match(md, /Why there is no model: no model at the pin/);
      assert.match(md, /What it is: standard-library function without a model/);
      assert.match(md, /What it is: dependency crate assumed correct/);
      for (const choice of [/1\. Accept it as a named assumption/, /2\. Have it modelled/, /3\. Narrow the claim/, /4\. Block it/]) assert.match(md, choice);
      assert.doesNotMatch(md, /### `std-div`/, 'a record that already has a decision is not asked again');
      assert.match(md, /Nothing here is decided yet/);
    });

    it('shows the claims the caller names for a record and says NOT STATED for one with none', () => {
      const root = project({ externals: OPEN });
      const notes = writeNotes(root, { claims: { 'std-fmt': ['Error values print without side effects', 'Debug output of a failed conversion'] } });
      const md = api.rulingList({ projectRoot: root, notes }).markdown;
      const section = (id) => md.split('### ').find((part) => part.startsWith('`' + id + '`'));
      assert.match(section('std-fmt'), /Claims that rest on it: Error values print without side effects; Debug output of a failed conversion/);
      assert.match(section('dep-sha2'), /Claims that rest on it: NOT STATED/);
    });

    it('says when the notes hold claims for a record that already has a decision', () => {
      const root = project({ externals: OPEN });
      const notes = writeNotes(root, { claims: { 'std-div': ['wrapping division of a counter'] } });
      const result = api.rulingList({ projectRoot: root, notes });
      assert.deepEqual(result.unlistedClaims, ['std-div']);
      assert.match(result.markdown, /claims for records that already hold a decision, so they are not listed: `std-div`/);
    });

    it('says that nothing is open without claiming the list is complete', () => {
      const md = api.rulingList({ projectRoot: project() , notes: null }).markdown;
      assert.match(md, /### `std-fmt`/);
      const none = api.rulingList({ projectRoot: project({ externals: [EXTERNALS[2]] }) }).markdown;
      assert.match(none, /No record in externals\.json is open/);
      assert.match(none, /only as complete as the records/);
    });

    it('refuses an absent registry and notes that name a record it does not hold, and writes nothing', () => {
      refuses(() => api.rulingList({ projectRoot: project({ externals: null }) }), 'trust-externals-missing');
      const root = project({ externals: OPEN });
      refuses(() => api.rulingList({ projectRoot: root, notes: writeNotes(root, { claims: { missing: ['a claim'] } }) }), 'trust-notes-invalid');
      const before = snapshot(root);
      api.rulingList({ projectRoot: root });
      assert.deepEqual(snapshot(root), before);
    });

    it('is a command that takes no commit', () => {
      const root = project({ externals: OPEN });
      const run = (...args) => spawnSync(process.execPath, [SCRIPT, 'rulings', ...args], { encoding: 'utf8' });
      const ok = run('--project-root', root);
      assert.equal(ok.status, 0, ok.stderr);
      assert.match(ok.stdout, /^## Claims that need a model or an accepted assumption\n/);
      const extra = run('--project-root', root, '--commit', COMMIT);
      assert.equal(extra.status, 7);
      assert.equal(JSON.parse(extra.stdout).code, 'bundle-usage');
    });
  });

  describe('command line', () => {
    const run = (...args) => spawnSync(process.execPath, [SCRIPT, 'trust', ...args], { encoding: 'utf8' });

    it('prints markdown by default and the record as JSON on request', () => {
      const root = project();
      const markdown = run('--project-root', root, '--commit', COMMIT);
      assert.equal(markdown.status, 0, markdown.stderr);
      assert.match(markdown.stdout, /^## Trust base\n/);
      const json = run('--project-root', root, '--commit', COMMIT, '--format', 'json');
      assert.equal(json.status, 0, json.stderr);
      assert.equal(JSON.parse(json.stdout).schema, 'fvs/auto-pr-trust');
    });

    it('exits 7 with a coded JSON refusal and writes no section', () => {
      const root = project();
      const refused = run('--project-root', root, '--commit', 'b'.repeat(40));
      assert.equal(refused.status, 7);
      assert.equal(JSON.parse(refused.stdout).code, 'trust-receipt-missing');
      const usage = run('--project-root', root, '--commit', COMMIT, '--bogus', 'x');
      assert.equal(usage.status, 7);
      assert.equal(JSON.parse(usage.stdout).code, 'bundle-usage');
    });
  });
});
