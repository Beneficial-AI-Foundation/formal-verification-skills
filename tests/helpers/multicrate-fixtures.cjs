'use strict';

// Fixtures for the auto track's multi-crate state tests: a committed Lean
// project the stub profile accepts, and a hand-built record of a succeeded
// extraction over several crates. No Charon, Aeneas or Lean runs.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'fvs-auto.mjs');
const PROFILE_FIXTURES = path.join(__dirname, '..', 'fixtures', 'auto-profile');
const CRATE = path.join(__dirname, '..', 'fixtures', 'extract-patches', 'crate');
const TMP = fs.realpathSync(os.tmpdir());
const ZEROS = '0'.repeat(64);
const temporaryDirectories = [];
let auto = null;

// The engine module, imported by the test file's `before` hook.
const use = (module) => { auto = module; };

const cleanup = () => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
};

function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(TMP, prefix));
  temporaryDirectories.push(directory);
  return directory;
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, '-c', 'user.name=fvs', '-c', 'user.email=fvs@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

// A committed single-crate Lean project that the stub profile accepts. With `below` the
// project is the folder `lean` of the repository, not its top.
function project(below = false) {
  const top = temporaryDirectory('fvs-multicrate-');
  const root = below ? path.join(top, 'lean') : top;
  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(CRATE, root, { recursive: true });
  fs.cpSync(path.join(PROFILE_FIXTURES, 'fresh'), root, { recursive: true });
  git(top, 'init', '-q');
  git(top, 'add', '-A');
  git(top, 'commit', '-q', '-m', 'fixture');
  return root;
}

// Setup state recorded with the profile tests' stub tools as the only tools.
function init(root) {
  const environment = {
    HOME: path.join(PROFILE_FIXTURES, 'home'),
    PATH: [path.join(PROFILE_FIXTURES, 'bin'), '/usr/bin', '/bin'].join(path.delimiter),
    FVS_TOOLS_HOME: path.join(PROFILE_FIXTURES, 'no-fvs-tools'),
  };
  const saved = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try {
    return auto.initState({ projectRoot: root, platform: 'aarch64-apple-darwin',
      choices: { source: { revision: 'HEAD', configuration: 'default features' }, scope: 'every crate of the repository', limits: { wallClockHours: 40 } } });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// A key-sorted JSON the engine hashes for approval, so a digest in a test is computed, not copied.
const canonical = (value) => JSON.stringify(value, (_key, item) => (item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item));

// An agreement for the recorded choices; `extra` adds payload fields such as targets.
function agreementFor(root, extra = {}, layout = 'monorepo') {
  const agreement = {
    schema: 'fvs/auto-agreement', schemaVersion: 1, mode: 'nonpublic-intent',
    payload: { choicesGeneration: 0, choices: auto.readState({ projectRoot: root }).state.choices,
      contextVersion: 1, boundaries: [], conventions: [], layout, claims: ['fixture'],
      trust: ['fixture policy'], acceptance: ['fixture evidence'], ownerReserved: ['human final decision'],
      execution: null, draftPr: null, ...extra },
    ownerEvidence: { reference: 'fixture:response', response: 'Fixture agreement only' },
  };
  agreement.approvedPayloadSha256 = auto.agreementPayloadSha256(agreement);
  return agreement;
}

// Records an agreement the way the owner's record step does: the roadmap holds its fence.
function recordAgreement(root, agreement) {
  fs.writeFileSync(path.join(root, '.formalising/auto-fv/ROADMAP.md'), '## Decisions\n```fvs-auto-agreement\n' + JSON.stringify(agreement) + '\n```\n');
  return auto.recordAgreement({ projectRoot: root, agreement });
}

function cli(...args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    // left null: the assertion on json shows the raw output
  }
  return { status: result.status, stdout: result.stdout, json };
}

const stateFile = (root) => path.join(root, '.formalising', 'auto-fv', 'state.json');
const readState = (root) => JSON.parse(fs.readFileSync(stateFile(root), 'utf8'));
const writeState = (root, state) => fs.writeFileSync(stateFile(root), JSON.stringify(state));

const fn = (rust, file, line) => ({ def_id: line, lean_name: rust.replace(/::/g, '.'), lean_file: 'X.lean', rust_name: rust, is_local: true,
  source: { file, begin_line: line, end_line: line + 2 }, is_opaque: false, can_fail: true });

// A stitch as the extraction engine records it: the provider, the digest of the provider's publish
// stage it was made from (the fixture rows all publish ZEROS), and the Lean modules it imports. An entry
// given as a crate name, or with fields missing, is filled in.
const stitchOf = (list) => [].concat(list ?? []).map((entry) => {
  const given = typeof entry === 'string' ? { provider: entry } : entry;
  return { providerStage: 'publish', providerStageSha256: ZEROS, modules: [given.provider], replaced: [], assumed: [], copies: 0, files: [], ...given };
});

// One crate's whole single-crate run: its own folder and its own translation.json. A crate's Lean
// imports are its stitch providers: `imports` alone stitches to those crates, `stitch` alone imports them.
function unit(root, crate, functions, extra = {}) {
  const stitch = stitchOf(extra.stitch ?? extra.imports);
  const imports = extra.imports ?? [...new Set(stitch.map((entry) => entry.provider))];
  const directory = path.join(root, crate);
  fs.mkdirSync(directory, { recursive: true });
  const published = path.join(directory, 'translation.json');
  fs.writeFileSync(published, JSON.stringify({ aeneas_version: 'x', charon_version: 'y', crate, functions, types: [], globals: [], trait_decls: [], trait_impls: [] }));
  const entry = { attemptPath: `/attempt/${crate}/translation.json`, projectPath: published, sha256: sha256(fs.readFileSync(published)) };
  return {
    attemptSha256: ZEROS, manifestSha256: ZEROS, configSha256: ZEROS, config: {}, supported: true, residuals: [], trust: 'local-host-and-reviewed-scripts',
    stages: { charon: ZEROS, aeneas: ZEROS, publish: ZEROS }, llbc: { path: `${crate}.llbc`, sha256: ZEROS },
    translation: entry, publication: [entry],
    crate, package: crate.replace(/_/g, '-'), dir: `crates/${crate}`, status: 'complete',
    hasErrors: { value: false, items: [], itemCount: 0 }, ...extra, stitch, imports,
  };
}

// A project whose recorded extraction succeeded over the crates `units(root)` builds;
// the first is the main crate. `run` adds fields to the top-level run. `dropped` lists the
// crates a patch removed from the copy, each `{ crate, reason }`.
function extracted(units, { run = {}, below = false, dropped = [] } = {}) {
  const root = project(below);
  init(root);
  const state = readState(root);
  const rows = units(root);
  // The roster the extraction engine hashes: the main crate, the crates in order with their stitch
  // providers, the non-targets and the crates a patch removed. Every row carries the same hash.
  const order = run.order ?? rows.map((row) => row.crate);
  // The extraction names every non-target on each crate's row and in the roster.
  const nonTargets = [...new Map(rows.flatMap((row) => row.nonTargets ?? []).map((entry) => [`${entry.crate}\u0000${entry.dir}`, entry])).values()];
  const roster = { main: rows[0].crate, order,
    units: order.map((crate) => {
      const row = rows.find((entry) => entry.crate === crate);
      return { crate, package: row?.package, dir: row?.dir, stitch: [...new Set([].concat(row?.stitch ?? []).map((entry) => entry.provider))].sort() };
    }), nonTargets: nonTargets.map(({ crate, dir }) => ({ crate, dir })), dropped };
  const rosterSha256 = sha256(JSON.stringify(roster));
  for (const row of rows) {
    row.rosterSha256 = rosterSha256;
    if (nonTargets.length > 0) row.nonTargets = nonTargets;
  }
  state.extraction = {
    status: 'succeeded', recordedAt: '2026-11-19T00:00:00.000Z', reasons: [], note: 'not a proof',
    selected: { ...state.choices.source },
    declared: { buildExitCode: 0, oracle: 'complete' },
    checks: { status: { ok: true }, 'verify-tree': { ok: true }, 'verify-restore': { ok: true } },
    inputs: { out: path.join(root, 'copy'), manifestSha256: ZEROS, crateRoot: root, mode: 'translation-patches', sourceCommit: 'a'.repeat(40), patches: [] },
    run: { ...rows[0], units: rows, order, roster, rosterSha256, ...run },
  };
  writeState(root, state);
  return root;
}

// The recorded run of one crate as the patch engine reports it: none of the fields of an aggregate
// (its crate rows, their order, the roster and its hash). `run` is the run of the state, changed in place.
const AGGREGATE_FIELDS = ['units', 'order', 'roster', 'rosterSha256'];
const asSingleCrate = (run) => { for (const key of AGGREGATE_FIELDS) delete run[key]; return run; };

// libcrux_hmac calls into libcrux_sha2, which is the provider.
const hmacAndSha2 = (root) => [
  unit(root, 'libcrux_hmac', [fn('libcrux_hmac::hmac::hmac', 'src/hmac.rs', 10)], { imports: ['libcrux_sha2'] }),
  unit(root, 'libcrux_sha2', [fn('libcrux_sha2::hacl::hash_256', 'src/hacl.rs', 5)]),
];

module.exports = { canonical, agreementFor, recordAgreement, ROOT, ZEROS, use, cleanup, temporaryDirectory, sha256, git, project, init, cli, stateFile, readState, writeState, fn, stitchOf, unit, extracted, hmacAndSha2, AGGREGATE_FIELDS, asSingleCrate };
