#!/usr/bin/env node
'use strict';

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MODES = ['translation-patches', 'legacy-source-ledger'];
const DEFAULT_INPUTS = ['Cargo.toml', 'Cargo.lock', 'build.rs', 'src'];
const PATCH_DIR = 'translation-patches';
const SERIES = 'series';
// Generated artifacts allowed to appear in the extraction copy after prepare:
// cargo's build directory. Anything else new in the copy is a changed tree.
const GENERATED_IN_COPY = new Set(['target']);
const LEDGER_DIFF = 'src-modifications.diff';
const LEDGER_INDEX = 'src-modifications.json';
const LEDGER_FILES = [LEDGER_DIFF, LEDGER_INDEX, 'src-modifications.md'];
const INACTIVE_MARKER = 'src-modifications.inactive.json';
const FORBIDDEN_SEGMENTS = new Set(['.git', '.formalising', '.planning']);
const MANIFEST = 'manifest.json';
const EXIT = {
  ok: 0,
  stale: 1,
  usage: 2,
  internal: 2,
  'dirty-original': 3,
  'mixed-mode': 4,
  'legacy-mode': 4,
  'invalid-input': 5,
  partial: 6,
  'changed-tree': 7,
  'attempt-refused': 8,
  'publication-refused': 8,
  'tool-failed': 9,
};

class Refusal extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function refuse(code, message, details) {
  throw new Refusal(code, message, details);
}

function usage() {
  process.stdout.write([
    'Usage: node fvs-extract-patches.mjs check --project-root DIR [--format json|text]',
    '       node fvs-extract-patches.mjs prepare --project-root DIR --out DIR [--release DIR [--lock update]] [--format json|text]',
    '       node fvs-extract-patches.mjs verify-restore --out DIR [--format json|text]',
    '       node fvs-extract-patches.mjs verify-tree --out DIR [--format json|text]',
    '       node fvs-extract-patches.mjs status --out DIR [--format json|text]',
    '       node fvs-extract-patches.mjs migrate --project-root DIR [--format json|text]',
    '       node fvs-extract-patches.mjs attempt --out DIR --spec FILE [--format json|text]',
    '       node fvs-extract-patches.mjs run --out DIR --step charon|aeneas|publish [--crate NAME] [--format json|text]',
    '       node fvs-extract-patches.mjs attempt-status --out DIR [--crate NAME] [--format json|text]',
    '       node fvs-extract-patches.mjs crates (--out DIR | --project-root DIR) --release DIR [--format json|text]',
    '',
    'Applies the translation patches in DIR/translation-patches, in the order listed',
    'in DIR/translation-patches/series (one file name per line, every patch exactly',
    'once), to a disposable copy of the Rust extraction input set (extraction.inputs',
    'in .formalising/fvs-config.json, default Cargo.toml, Cargo.lock, build.rs, src).',
    'A symbolic link the build can read (a manifest, lock, build script, toolchain or cargo',
    'configuration file, a Rust source file, anything under src, or an input itself) is refused. Any',
    'other link under the inputs is not copied: check lists it (links) and the manifest records it',
    '(source.links) with its target.',
    'The original checkout is never written. check rehearses the list in a temporary',
    'copy; prepare builds OUT/tree and OUT/manifest.json (OUT must be a new directory',
    'outside the project); verify-restore compares the touched original sources with',
    'the recorded start; verify-tree compares every file under OUT/tree, except cargo\'s',
    'target/ directory, with the tree prepare recorded; status reads the manifest.',
    'The manifest records the Cargo.lock of the copy (origin read, or absent), apart from the',
    'source state: an uncommitted or ignored root Cargo.lock is not a dirty input, and',
    'verify-restore also checks that the project\'s own lock is the one recorded at the start. A project',
    'without one is refused by attempt, because cargo would write one into the copy; prepare',
    '--lock update --release DIR brings the lock of the copy in line with the patched',
    'manifests once: generated when there is none, otherwise updated keeping every pinned',
    'version (cargo update --workspace). It may need network access, records the origin and',
    'hashes, and never touches the checkout. With --release, prepare also records the',
    'workspace: the in-repo crates before and after the patches (cargo only reads). A',
    'multi-crate attempt needs it, and every in-repo library crate must then be a target,',
    'a nonTargets entry, or a dropped entry ({crate, reason}) when it is not in the copy;',
    'a path dependency a patch removed has to be listed as dropped too.',
    'migrate turns an active legacy src-modifications ledger into translation patches',
    '(one per hunk, entries from src-modifications.json kept verbatim) and marks the',
    'ledger inactive in place with src-modifications.inactive.json; it never edits',
    'the ledger or the source.',
    '',
    'attempt records one extraction attempt for a prepared copy: the spec (JSON: release,',
    'crate, publishDir, charonArgs, cargoArgs) is checked against the supported invocation',
    'before anything is written, and the controlled environment, tool hashes and cargo',
    'configuration files are recorded. run executes one stage of that attempt, in order',
    '(charon, aeneas, publish), under the controlled environment, and records its outputs',
    'when it exits; a failed or interrupted stage ends the attempt. attempt-status',
    're-validates the whole chain and the current output hashes.',
    '',
    'A spec with a crates list (and main) records one attempt per in-repo target crate',
    'inside the one prepared copy, under DIR/units/<crate>: every crate has its own',
    'Charon, Aeneas and publish chain, so a failing crate ends only its own chain. run',
    'then needs --crate NAME. attempt-status refuses unless every crate is complete and',
    'lists each crate\'s status; its run is the main crate\'s, plus run.units.',
    '',
    'crates lists the in-repo crates of a prepared copy (--out) or of a fresh checkout',
    '(--project-root): package, crate name, directory, the in-repo crates it depends on, and',
    'a dependency order, providers first, so a multi-crate spec can start from every crate as',
    'a target and drop the ones the owner decides not to verify. It runs cargo metadata',
    '--no-deps --offline under the toolchain of the release directory (relative to the project',
    'root) and changes nothing; it is advisory. On a copy it also names the path dependencies',
    'the patches removed and the packages the copy lacks; on a checkout it proposes the',
    'extraction.inputs a copy needs.',
    '',
    'Exit codes: 0 ok; 1 a patch does not fit (stale, already applied, not reversible,',
    'or not independent although it declares Independent: yes); 2 usage or internal',
    'error; 3 dirty original; 4 mixed or legacy mode; 5 invalid input; 6 partial manifest;',
    '7 the extraction copy changed after prepare; 8 the attempt or publication was refused;',
    '9 a tool failed or its outputs did not check out.',
  ].join('\n') + '\n');
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function sameState(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function lexists(file) {
  return fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;
}

function inside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// Mode and content of one path; null when it does not exist.
function fileState(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink()) return { link: fs.readlinkSync(file) };
  if (!stat.isFile()) return { type: stat.isDirectory() ? 'directory' : 'other' };
  return { sha256: sha256(fs.readFileSync(file)), mode: (stat.mode & 0o777).toString(8) };
}

// Every existing component of a project-relative directory must be a real
// directory, checked without following links: a link anywhere on the path
// would carry a read or a write outside the project.
function refuseLinkedDirectory(projectRoot, relative) {
  let current = projectRoot;
  for (const part of relative.split('/').filter((segment) => segment !== '' && segment !== '.')) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return;
    if (!stat.isDirectory()) {
      const shown = path.relative(projectRoot, current);
      refuse('invalid-input', `${shown} is ${stat.isSymbolicLink() ? 'a symbolic link' : 'not a directory'}; the engine reads and writes only through real directories inside the project`, { kind: stat.isSymbolicLink() ? 'symlink' : 'not-a-directory', path: shown });
    }
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return refuse('invalid-input', `cannot read ${file}: ${error.message}`);
  }
}

function readConfig(projectRoot) {
  const file = path.join(projectRoot, '.formalising', 'fvs-config.json');
  return fs.existsSync(file) ? readJson(file) ?? {} : {};
}

function inputPaths(projectRoot, config) {
  const configured = config.extraction?.inputs;
  if (configured === undefined) {
    const found = DEFAULT_INPUTS.filter((input) => lexists(path.join(projectRoot, input)));
    if (found.length === 0) refuse('invalid-input', `no extraction inputs found: expected some of ${DEFAULT_INPUTS.join(', ')}, or set extraction.inputs`);
    return found;
  }
  if (!Array.isArray(configured) || configured.length === 0) {
    refuse('invalid-input', 'extraction.inputs must be a non-empty array of project-relative paths');
  }
  for (const input of configured) {
    if (typeof input !== 'string' || path.isAbsolute(input)
      || input.split('/').some((part) => ['', '.', '..'].includes(part) || FORBIDDEN_SEGMENTS.has(part))) {
      refuse('invalid-input', `extraction.inputs entry ${JSON.stringify(input)} must be a plain project-relative path outside .git, .formalising and .planning`);
    }
    refuseLinkedDirectory(projectRoot, path.posix.dirname(input));
    if (!lexists(path.join(projectRoot, input))) refuse('invalid-input', `extraction input ${input} does not exist`);
  }
  return [...new Set(configured)].sort();
}

function parsePatch(name, bytes) {
  const text = bytes.toString('utf8');
  const start = text.search(/^diff --git /m);
  if (start < 0) refuse('invalid-input', `${name} has no "diff --git" section`);
  const header = text.slice(0, start);
  const title = header.match(/^(Translation|Supporting) patch:[ \t]*(\S.*)$/m);
  const missing = ['Change', 'Why', 'Behaviour'].filter((field) => !new RegExp(`^${field}:`, 'm').test(header));
  if (!title || missing.length > 0) {
    refuse('invalid-input', `${name}: the header needs a "Translation patch:" or "Supporting patch:" line and Change:, Why: and Behaviour: lines`, { patch: name, missing });
  }
  const sections = [...text.matchAll(/^diff --git (.*)$/gm)];
  const named = sections.map((section) => section[1].match(/^a\/(\S+) b\/(\S+)$/));
  if (named.some((match) => !match)) refuse('invalid-input', `${name}: cannot read the file names of every "diff --git" line`);
  return {
    file: name,
    bytes,
    sha256: sha256(bytes),
    kind: title[1].toLowerCase(),
    item: title[2].trim(),
    independent: /^Independent:[ \t]*yes[ \t]*$/mi.test(header),
    touches: [...new Set(named.flatMap((match) => [match[1], match[2]]))].sort(),
  };
}

// translation-patches/series is the one ordered list: one patch file name per
// line, applied top to bottom (blank lines and # comments are skipped). Every
// .patch file must be listed exactly once, so the order is always declared,
// never inferred from file names.
function readPatches(projectRoot) {
  const directory = path.join(projectRoot, PATCH_DIR);
  refuseLinkedDirectory(projectRoot, PATCH_DIR);
  if (!fs.existsSync(directory)) return [];
  const present = fs.readdirSync(directory).filter((name) => name.endsWith('.patch')).sort();
  const seriesFile = path.join(directory, SERIES);
  if (!fs.existsSync(seriesFile)) {
    if (present.length > 0) {
      refuse('invalid-input', `${PATCH_DIR}/ holds ${present.length} patch(es) but no ${SERIES} file; list them there, one per line, in application order`, { unlisted: present });
    }
    return [];
  }
  const listed = fs.readFileSync(seriesFile, 'utf8').split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const duplicated = listed.filter((name, index) => listed.indexOf(name) !== index);
  const missing = listed.filter((name) => !present.includes(name));
  const unlisted = present.filter((name) => !listed.includes(name));
  if (duplicated.length > 0 || missing.length > 0 || unlisted.length > 0) {
    refuse('invalid-input', `${PATCH_DIR}/${SERIES} must list every .patch file in ${PATCH_DIR}/ exactly once`, { duplicated, missing, unlisted });
  }
  return listed.map((name) => parsePatch(name, fs.readFileSync(path.join(directory, name))));
}

// The legacy ledger files at each crate root: the project root and the
// directory of every Cargo.toml in the walked input set, so workspace members
// under a directory input are covered. A ledger is inactive only while the
// marker a successful migration wrote next to it still records its exact
// files; a ledger edited after migration is active again.
function legacyLedger(projectRoot, files) {
  const crateRoots = new Set(['.', ...Object.keys(files).filter((file) => path.posix.basename(file) === 'Cargo.toml').map(path.posix.dirname)]);
  const ledger = { active: [], inactive: [], changed: [] };
  for (const crateRoot of crateRoots) {
    const present = LEDGER_FILES.filter((name) => lexists(path.join(projectRoot, crateRoot, name)));
    if (present.length === 0) continue;
    const files = present.map((name) => path.posix.join(crateRoot, name));
    const markerFile = path.join(projectRoot, crateRoot, INACTIVE_MARKER);
    const marker = lexists(markerFile) ? readJson(markerFile) : null;
    const current = Object.fromEntries(present.map((name) => [name, fileState(path.join(projectRoot, crateRoot, name))]));
    if (marker && sameState(marker.ledger, current)) {
      ledger.inactive.push(...files);
    } else {
      ledger.active.push(...files);
      if (marker) ledger.changed.push(...files);
    }
  }
  return ledger;
}

// extraction.mode decides when set. Unset, a project with an active legacy
// source ledger keeps the legacy interpretation and every other project uses
// translation patches. An active ledger and a patch list are never both in use:
// the ledger is never deleted or reinterpreted here; the migrate subcommand
// marks it inactive in place.
function resolveMode(projectRoot, config, files, patches) {
  const configured = config.extraction?.mode;
  if (configured !== undefined && !MODES.includes(configured)) {
    refuse('invalid-input', `extraction.mode must be one of ${MODES.join(', ')}`);
  }
  const { active, inactive, changed } = legacyLedger(projectRoot, files);
  const mode = configured ?? (active.length > 0 ? 'legacy-source-ledger' : 'translation-patches');
  const details = { mode, ledger: active, inactive, patches: patches.map((patch) => patch.file) };
  const reactivated = changed.length > 0 ? ` (${changed.join(', ')} changed after its migration, so the ledger is active again)` : '';
  if (mode === 'translation-patches' && active.length > 0) {
    refuse('mixed-mode', `mixed active records: translation patches are in use but the legacy source ledger is active (${active.join(', ')})${reactivated}; migrate it explicitly first`, details);
  }
  if (mode === 'legacy-source-ledger' && patches.length > 0) {
    refuse('mixed-mode', `mixed active records: this project uses the legacy source ledger${active.length > 0 ? ` (${active.join(', ')})` : ''}${reactivated} but ${PATCH_DIR}/ holds ${patches.length} patch(es)`, details);
  }
  if (mode === 'legacy-source-ledger') {
    const migrated = inactive.length > 0 ? ' The ledger is already marked inactive; set extraction.mode to translation-patches.' : ' Run migrate to move it to translation patches.';
    refuse('legacy-mode', `this project uses the legacy source ledger; translation patches apply only after an explicit migration.${migrated}`, details);
  }
  return mode;
}

// A symbolic link the Rust build can read: a manifest, lock, build script, toolchain or cargo
// configuration file, a Rust source file, anything named or placed under src or .cargo, or an
// input the owner declared. Other links (the C headers a crate also generates, say) are not
// copied and the build does not read them: a build that does need one fails on the missing file,
// so none of them can change an extraction unseen.
const RUST_LINK_NAMES = new Set(['Cargo.toml', 'Cargo.lock', 'build.rs', 'rust-toolchain', 'rust-toolchain.toml', 'src', '.cargo']);
function isRustInputLink(relative, declared) {
  const parts = relative.split('/');
  return declared || relative.endsWith('.rs') || RUST_LINK_NAMES.has(parts[parts.length - 1]) || parts.slice(0, -1).some((part) => part === 'src' || part === '.cargo');
}

// Every regular file in the input set with its content hash and mode. A link is never
// followed or copied: a followed link would extract content from outside the input set, and a
// copied one would write through to the original checkout or a shared planning directory. A link
// the build can read is rejected; with SKIPPED (an array) any other link is left out of the
// copy and listed there with its target, so a checkout that carries generated-output links can
// still be extracted. A copy is walked without SKIPPED: it must hold no link at all.
function walkInputs(root, inputs, skipped = null) {
  const files = {};
  function visit(relative, declared = false) {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat) return; // an input a patch deleted from the copy
    if (stat.isSymbolicLink()) {
      if (skipped !== null && !isRustInputLink(relative, declared)) {
        skipped.push({ path: relative, target: fs.readlinkSync(absolute) });
        return;
      }
      refuse('invalid-input', `${relative} is a symbolic link${skipped !== null ? ' the build can read (a manifest, lock, build script, toolchain or cargo configuration file, a Rust source file, anything under src, or a declared input)' : ''}; the extraction input set takes only regular files, so replace it with the intended content or leave it out of extraction.inputs`, { kind: 'symlink', path: relative });
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) visit(`${relative}/${name}`);
    } else if (stat.isFile()) {
      files[relative] = fileState(absolute);
    } else {
      refuse('invalid-input', `unsupported file type in the extraction input set: ${relative}`, { path: relative });
    }
  }
  for (const input of inputs) visit(input, true);
  return files;
}

// The commit the input set starts from and the input paths whose content is not
// that commit's (modified, staged, deleted or untracked). Read-only: optional
// index locks are off, so a dirty checkout is left exactly as it was.
function sourceIdentity(projectRoot, inputs) {
  const git = (...args) => spawnSync('git', ['--no-optional-locks', '-C', projectRoot, ...args], { encoding: 'utf8', env: gitEnv() });
  const head = git('rev-parse', '--verify', '--quiet', 'HEAD^{commit}');
  if (head.error || head.status !== 0) return { commit: null, dirty: null };
  const listed = [
    git('diff', '--name-only', '-z', '--relative', 'HEAD', '--', ...inputs),
    git('ls-files', '-z', '--others', '--', ...inputs),
  ];
  const failed = listed.find((result) => result.status !== 0);
  if (failed) throw new Error(`cannot read the git status of ${projectRoot}: ${failed.stderr.trim()}`);
  // The root Cargo.lock is not source: many projects ignore or never commit it. The manifest
  // records it with its own origin and hash instead, and restore checks it on its own. Every
  // other uncommitted input stays dirty.
  const dirty = listed.flatMap((result) => result.stdout.split('\0')).filter((file) => file !== '' && file !== LOCK_FILE);
  return { commit: head.stdout.trim(), dirty: [...new Set(dirty)].sort() };
}

function refuseOutsideInputs(patches, inputs) {
  for (const patch of patches) {
    const outside = patch.touches.filter((file) => !inputs.some((input) => file === input || file.startsWith(`${input}/`)));
    if (outside.length > 0) {
      refuse('invalid-input', `${patch.file} touches ${outside.join(', ')}, outside the extraction input set (${inputs.join(', ')})`, { patch: patch.file, outside });
    }
  }
}

function load(projectRootFlag) {
  if (!fs.existsSync(projectRootFlag)) refuse('usage', `--project-root ${projectRootFlag} does not exist`);
  const projectRoot = fs.realpathSync(projectRootFlag);
  const config = readConfig(projectRoot);
  const inputs = inputPaths(projectRoot, config);
  const patches = readPatches(projectRoot);
  const links = [];
  const files = walkInputs(projectRoot, inputs, links);
  const mode = resolveMode(projectRoot, config, files, patches);
  refuseOutsideInputs(patches, inputs);
  const touched = [...new Set(patches.flatMap((patch) => patch.touches))].sort();
  // A link left out of the copy is not an input, so a change to it is not a dirty input.
  const identity = sourceIdentity(projectRoot, inputs);
  const skipped = new Set(links.map((link) => link.path));
  return { projectRoot, inputs, patches, mode, files, links, touched, ...identity, dirty: identity.dirty === null ? null : identity.dirty.filter((file) => !skipped.has(file)) };
}

function gitEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']) delete env[name];
  return env;
}

// git apply on the copy only. The ceiling stops git from discovering an
// enclosing repository (which would make it skip every path silently), and no
// user or system configuration can loosen whitespace or context matching (the
// command-line pin also covers git versions that ignore GIT_CONFIG_GLOBAL).
function gitApply(tree, patch, ...flags) {
  const result = spawnSync('git', ['-c', 'apply.ignoreWhitespace=no', 'apply', '--whitespace=nowarn', ...flags], {
    cwd: tree,
    input: patch.bytes,
    encoding: 'utf8',
    env: gitEnv({ GIT_CEILING_DIRECTORIES: path.dirname(tree), GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' }),
  });
  if (result.error) throw new Error(`cannot run git apply: ${result.error.message}`);
  return result;
}

function touchedState(tree, touches) {
  return Object.fromEntries(touches.map((relative) => [relative, fileState(path.join(tree, relative))]));
}

function publicPatch(patch) {
  const { bytes, ...rest } = patch;
  return rest;
}

// A patch is checked against the state the patches before it leave (the
// source snapshot for the first one). A patch that does not apply there fails;
// it is never fuzzy-applied and no other order is tried.
function applyPatch(tree, patch, index) {
  const pre = touchedState(tree, patch.touches);
  const fits = gitApply(tree, patch, '--check');
  if (fits.status !== 0) {
    const where = index === 0 ? 'the source snapshot' : `the state left by the ${index} patch(es) before it`;
    const details = { patch: patch.file, index, git: fits.stderr.trim() };
    if (gitApply(tree, patch, '--check', '-R').status === 0) {
      refuse('stale', `${patch.file} is already applied to ${where}`, { kind: 'already-applied', ...details });
    }
    refuse('stale', `${patch.file} does not apply to ${where}; regenerate it against that state`, { kind: 'stale', ...details });
  }
  const applied = gitApply(tree, patch);
  if (applied.status !== 0) throw new Error(`git apply failed for ${patch.file}: ${applied.stderr.trim()}`);
  const post = touchedState(tree, patch.touches);
  if (sameState(pre, post)) throw new Error(`git apply reported success for ${patch.file} but changed nothing`);
  // A patch may not create a link either: it would point the copy at content
  // outside the recorded input set, and a write through it would reach the
  // original checkout or shared storage.
  const created = Object.keys(post).find((file) => post[file]?.link !== undefined);
  if (created) refuseCopyLink(created, patch.file);
  return { ...publicPatch(patch), pre, post };
}

function refuseCopyLink(file, patch) {
  refuse('invalid-input', `${patch ? `${patch} makes ${file}` : file} a symbolic link; the extraction copy takes only regular files, so write the intended content instead`, { kind: 'symlink', path: file, ...(patch ? { patch } : {}) });
}

function materialise(context, tree) {
  for (const [relative, state] of Object.entries(context.files)) {
    const target = path.join(tree, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(context.projectRoot, relative), target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, parseInt(state.mode, 8));
  }
  if (!sameState(walkInputs(tree, context.inputs), context.files)) {
    refuse('dirty-original', 'the original sources changed while they were being copied; run again on a quiet checkout');
  }
}

function applyAll(context, tree, records) {
  context.patches.forEach((patch, index) => records.push(applyPatch(tree, patch, index)));
}

// Apply first to last, undo last to first back to the exact starting state, then
// try each patch that declares independence on its own. Leaves the tree at the
// starting state and returns the per-patch records of the forward pass.
function rehearse(context, tree) {
  const records = [];
  applyAll(context, tree, records);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const patch = context.patches[index];
    const undone = gitApply(tree, patch, '-R');
    if (undone.status !== 0 || !sameState(touchedState(tree, patch.touches), records[index].pre)) {
      refuse('stale', `${patch.file} does not undo back to the state it was applied to`, { kind: 'irreversible', patch: patch.file, index, git: undone.stderr.trim() });
    }
  }
  if (!sameState(walkInputs(tree, context.inputs), context.files)) {
    refuse('stale', 'undoing the patches last to first did not restore the exact starting state', { kind: 'irreversible' });
  }
  context.patches.forEach((patch, index) => {
    if (patch.independent && gitApply(tree, patch, '--check').status !== 0) {
      refuse('stale', `${patch.file} declares Independent: yes but does not apply on its own to the source snapshot`, { kind: 'not-independent', patch: patch.file, index });
    }
  });
  return records;
}

function rehearseInScratch(context) {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fvs-extract-check-'));
  try {
    const tree = path.join(scratch, 'tree');
    materialise(context, tree);
    return rehearse(context, tree);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function check(flags) {
  const context = load(flags['project-root']);
  const records = rehearseInScratch(context);
  return {
    message: `${records.length} translation patch(es) apply in order and undo to the exact starting state`,
    mode: context.mode,
    inputs: context.inputs,
    // The commit the inputs start from and the input paths that differ from it (modified,
    // staged, deleted or untracked); both null outside a git checkout.
    source: { commit: context.commit, dirty: context.dirty },
    // Symbolic links under the inputs that are not Rust inputs: not copied, and not read by the build.
    links: context.links,
    patches: records,
  };
}

function resolveOut(out, projectRoot) {
  const absolute = path.resolve(out);
  if (!fs.existsSync(path.dirname(absolute))) refuse('usage', `the parent of --out ${absolute} must exist`);
  const resolved = path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
  if (lexists(resolved)) refuse('usage', `--out ${resolved} already exists; give a new directory`);
  if (inside(resolved, projectRoot) || inside(projectRoot, resolved)) {
    refuse('invalid-input', `--out must be outside the project checkout ${projectRoot}`);
  }
  return resolved;
}

function writeManifest(out, manifest) {
  fs.writeFileSync(path.join(out, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

const LOCK_FILE = 'Cargo.lock';

// The environment cargo runs in for the engine's own cargo calls: the caller's home
// directories, the cargo bin directory, and the release's pinned toolchain.
function cargoEnvironment(release) {
  const homes = homesOf(process.env);
  for (const name of ['HOME', 'RUSTUP_HOME', 'CARGO_HOME']) {
    if (typeof homes[name] !== 'string' || !path.isAbsolute(homes[name])) refuse('invalid-input', `${name} must be an absolute path`);
  }
  return { HOME: homes.HOME, RUSTUP_HOME: homes.RUSTUP_HOME, CARGO_HOME: homes.CARGO_HOME, PATH: `${path.join(homes.CARGO_HOME, 'bin')}:/usr/bin:/bin`, RUSTUP_TOOLCHAIN: release.tools.rustToolchain.channel };
}

// Brings the lock of the copy in line with its patched manifests, once, before the copy
// is recorded: cargo would otherwise rewrite it during the build, and the copy would then
// differ from the recorded tree. A project without a lock gets one generated; a lock the
// project has keeps every version it pins (cargo update --workspace only adds and prunes
// what the manifests changed). Resolution may need the registry index (network). The
// result is recorded by hash with its origin (generated, updated, or read when nothing
// had to change, with the hash it started from when it did) and the checkout is not touched.
function updateLock(context, tree, releaseFlag) {
  const release = releaseTools(path.resolve(context.projectRoot, releaseFlag));
  const before = fileState(path.join(tree, LOCK_FILE));
  const command = before === null ? ['generate-lockfile'] : ['update', '--workspace'];
  const run = spawnSync('cargo', command, { env: cargoEnvironment(release), cwd: tree, encoding: 'utf8' });
  const after = fileState(path.join(tree, LOCK_FILE));
  if (run.status !== 0 || after === null) {
    const lines = `${run.stderr ?? ''}`.split('\n').map((line) => line.trim()).filter((line) => line !== '').slice(0, 6);
    refuse('tool-failed', `cargo ${command.join(' ')} failed in the extraction copy${lines.length > 0 ? `: ${lines.join(' | ')}` : ''}`, { reasons: lines });
  }
  if (before === null) return { origin: 'generated' };
  return before.sha256 === after.sha256 ? { origin: 'read' } : { origin: 'updated', from: before.sha256 };
}

function prepare(flags) {
  if (flags.lock !== undefined && flags.lock !== 'update') refuse('usage', '--lock accepts only "update"');
  if (flags.lock === 'update' && flags.release === undefined) refuse('usage', '--lock update needs --release DIR: the release\'s toolchain runs cargo');
  const context = load(flags['project-root']);
  const out = resolveOut(flags.out, context.projectRoot);
  const tree = path.join(out, 'tree');
  fs.mkdirSync(out);
  const manifest = {
    schema: 'fvs-extract-patches/manifest',
    version: 1,
    status: 'partial',
    projectRoot: context.projectRoot,
    tree,
    mode: context.mode,
    source: { inputs: context.inputs, commit: context.commit, dirty: context.dirty, files: context.files, links: context.links },
    touched: context.touched,
    patches: [],
    failure: null,
  };
  writeManifest(out, manifest);
  try {
    materialise(context, tree);
    applyAll(context, tree, manifest.patches);
    if (!sameState(manifest.patches, rehearseInScratch(context))) {
      throw new Error('the rehearsal copy reached different states from the extraction copy');
    }
    refuseChangedOriginals(manifest);
    const updated = flags.lock === 'update' ? updateLock(context, tree, flags.release) : null;
    // The exact tree handed to the next stage: the touched set's hash and every file in the
    // copy. A completed tree holding any link is refused before it is recorded.
    const files = copyState(tree);
    // With the release, the workspace is read before and after the patches (cargo only reads),
    // and the copy must be the same afterwards.
    const workspace = flags.release === undefined ? null : workspaceInventory(context.projectRoot, tree, flags.release);
    if (workspace !== null && !sameState(files, copyState(tree))) refuse('internal', 'reading the workspace changed the extraction copy');
    if (workspace !== null) manifest.workspace = workspace;
    const link = Object.keys(files).find((file) => files[file].link !== undefined);
    if (link) refuseCopyLink(link);
    manifest.final = { touchedSha256: sha256(JSON.stringify(touchedState(tree, context.touched))), files };
    manifest.lock = { path: LOCK_FILE, origin: updated?.origin ?? (files[LOCK_FILE] ? 'read' : 'absent'), sha256: files[LOCK_FILE]?.sha256 ?? null, ...(updated?.from ? { from: updated.from } : {}) };
    manifest.status = 'prepared';
  } catch (error) {
    manifest.failure = error instanceof Refusal
      ? { code: error.code, message: error.message, ...error.details }
      : { code: 'internal', message: error.message };
    throw error;
  } finally {
    writeManifest(out, manifest);
  }
  return {
    message: `${manifest.patches.length} translation patch(es) applied in ${tree}`,
    manifest,
  };
}

function readManifest(out) {
  const file = path.join(path.resolve(out), MANIFEST);
  if (!fs.existsSync(file)) refuse('usage', `no manifest at ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// The touched source set of the original checkout, byte for byte and mode for
// mode, against the state recorded before any patch ran.
function refuseChangedOriginals(manifest) {
  const changed = manifest.touched.filter((relative) => !sameState(
    fileState(path.join(manifest.projectRoot, relative)),
    manifest.source.files[relative] ?? null,
  ));
  if (changed.length > 0) {
    refuse('dirty-original', `the original sources differ from the recorded start: ${changed.join(', ')}`, { changed });
  }
}

// The project's own Cargo.lock against the state recorded before prepare, whatever the
// copy's lock turned out to be (read, generated or updated): a copy built against a lock
// the project no longer has is not the extraction of this project.
function refuseChangedLock(manifest) {
  if (!manifest.lock || !manifest.source.files) return;
  const start = manifest.source.files[LOCK_FILE] ?? null;
  const now = fileState(path.join(manifest.projectRoot, LOCK_FILE));
  if (!sameState(now, start)) {
    refuse('dirty-original', `the project's ${LOCK_FILE} ${now === null ? 'is gone' : start === null ? 'appeared' : 'changed'} since prepare recorded its start (${start?.sha256?.slice(0, 12) ?? 'none'}), so the lock this extraction used (${manifest.lock.origin}, ${manifest.lock.sha256?.slice(0, 12) ?? 'none'}) no longer comes from this project`, { lock: { start: start?.sha256 ?? null, now: now?.sha256 ?? null, origin: manifest.lock.origin } });
  }
}

function verifyRestore(flags) {
  const manifest = readManifest(flags.out);
  refuseChangedOriginals(manifest);
  refuseChangedLock(manifest);
  return { message: `${manifest.touched.length} touched source file(s) match the recorded start${manifest.lock ? `, and so does the project's ${LOCK_FILE}` : ''}`, touched: manifest.touched };
}

function status(flags) {
  const manifest = readManifest(flags.out);
  if (manifest.status !== 'prepared') {
    refuse('partial', 'the manifest records a partial extraction copy, not a result', { manifest });
  }
  return { message: `prepared copy at ${manifest.tree}`, manifest };
}

// Every entry under the extraction copy, not only the recorded inputs, so a
// file added later (a build script, a .cargo/config.toml) shows up; only the
// generated artifacts in GENERATED_IN_COPY are left out, and only as real
// directories: a link with a generated artifact's name is recorded like any
// other link, never exempted.
function copyState(tree) {
  const files = {};
  (function visit(relative) {
    for (const name of fs.readdirSync(path.join(tree, relative)).sort()) {
      const child = relative ? `${relative}/${name}` : name;
      const absolute = path.join(tree, child);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) {
        if (!GENERATED_IN_COPY.has(child)) visit(child);
      } else {
        files[child] = fileState(absolute);
      }
    }
  })('');
  return files;
}

// The copy as it is now against the tree prepare recorded, so a later stage
// can show that what it consumed is what the manifest describes.
function verifyTree(flags) {
  const manifest = readManifest(flags.out);
  if (manifest.status !== 'prepared' || !manifest.final) {
    refuse('partial', 'the manifest records no prepared extraction copy; there is no recorded tree to verify', { status: manifest.status });
  }
  const actual = copyState(manifest.tree);
  const recorded = manifest.final.files;
  const changed = [...new Set([...Object.keys(actual), ...Object.keys(recorded)])].sort()
    .filter((relative) => !sameState(actual[relative] ?? null, recorded[relative] ?? null));
  if (changed.length > 0) {
    const lock = changed.includes(LOCK_FILE) ? ` (${LOCK_FILE} is the lock recorded as ${manifest.lock?.origin ?? 'unknown'}, ${manifest.lock?.sha256?.slice(0, 12) ?? 'none'}: cargo or a tool rewrote it in the copy)` : '';
    refuse('changed-tree', `the extraction copy differs from the recorded tree: ${changed.join(', ')}${lock}`, { changed });
  }
  return { message: `the extraction copy matches the recorded tree (${Object.keys(recorded).length} file(s))`, touchedSha256: manifest.final.touchedSha256 };
}

// One patch body per hunk of a legacy ledger diff. Each keeps its file
// section's header (without the index line, and with a mode change only on the
// section's first hunk); a section without hunks stays whole.
function splitLedger(text) {
  return text.split(/^(?=diff --git )/m)
    .filter((section) => section.startsWith('diff --git '))
    .flatMap((section) => {
      const file = section.match(/^diff --git a\/\S+ b\/(\S+)$/m)?.[1];
      if (!file) refuse('invalid-input', 'cannot read a file name in a "diff --git" line of src-modifications.diff');
      const lines = section.replace(/\n$/, '').split('\n').filter((line) => !line.startsWith('index '));
      const first = lines.findIndex((line) => line.startsWith('@@'));
      if (first < 0) return [{ file, body: `${lines.join('\n')}\n` }];
      const header = lines.slice(0, first);
      const hunks = [];
      for (const line of lines.slice(first)) {
        if (line.startsWith('@@')) hunks.push([]);
        hunks[hunks.length - 1].push(line);
      }
      return hunks.map((hunk, index) => {
        const kept = index === 0 ? header : header.filter((line) => !/^(old|new) mode /.test(line));
        return { file, body: `${[...kept, ...hunk].join('\n')}\n` };
      });
    });
}

const MIGRATED_FIELDS = [
  ['classification', 'Classification'],
  ['assumptions', 'Assumptions'],
  ['obligations', 'Obligations'],
  ['evidence', 'Evidence'],
  ['ratification', 'Ratification'],
];

function migratedPatch(entry, hunk, index) {
  const id = typeof entry?.id === 'string' && /^[A-Za-z0-9_.-]+$/.test(entry.id) ? entry.id : `hunk${index + 1}`;
  const lines = [
    `Translation patch: legacy ${id} in ${hunk.file}`,
    '',
    `Change: hunk ${index + 1} of src-modifications.diff, migrated verbatim.`,
    `Why: recorded in the legacy source ledger as ${id}; see src-modifications.md.`,
    'Behaviour: as recorded in the legacy source ledger; migration does not re-establish equivalence.',
  ];
  for (const [key, label] of MIGRATED_FIELDS) {
    const value = entry?.[key];
    if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) continue;
    lines.push(`${label}: ${typeof value === 'string' ? value.replace(/\s*\n\s*/g, ' ') : JSON.stringify(value)}`);
  }
  const stem = path.posix.basename(hunk.file).replace(/\.[^.]*$/, '');
  return parsePatch(`${stem}-legacy-${id}.patch`, Buffer.from(`${lines.join('\n')}\n\n${hunk.body}`));
}

// Explicit, one-off migration of the active legacy source ledger to translation
// patches: one patch per ledger hunk, paired in order with the entries of
// src-modifications.json. Each entry is kept verbatim in the inactive marker and
// its classification, assumptions, obligations, evidence and ratification also
// go into its patch header. Nothing is written until the patches, rehearsed
// against the pin rebuilt in a scratch copy, rebuild the working source exactly.
// The ledger and the source are left as they are.
function migrate(flags) {
  if (!fs.existsSync(flags['project-root'])) refuse('usage', `--project-root ${flags['project-root']} does not exist`);
  const projectRoot = fs.realpathSync(flags['project-root']);
  const inputs = inputPaths(projectRoot, readConfig(projectRoot));
  const directory = path.join(projectRoot, PATCH_DIR);
  refuseLinkedDirectory(projectRoot, PATCH_DIR);
  if (fs.existsSync(directory) && fs.readdirSync(directory).some((name) => name.endsWith('.patch') || name === SERIES)) {
    refuse('mixed-mode', `${PATCH_DIR}/ already holds a patch list; migration writes a new list and never merges into one`);
  }
  const files = walkInputs(projectRoot, inputs, []);
  const diffs = legacyLedger(projectRoot, files).active.filter((file) => path.posix.basename(file) === LEDGER_DIFF);
  if (diffs.length !== 1) {
    refuse('invalid-input', diffs.length === 0
      ? `there is no active legacy source ledger (${LEDGER_DIFF}) to migrate`
      : `more than one active legacy source ledger: ${diffs.join(', ')}`);
  }
  const crateRoot = path.posix.dirname(diffs[0]);
  refuseLinkedDirectory(projectRoot, crateRoot);
  const at = (name) => path.join(projectRoot, crateRoot, name);
  if (lexists(at(INACTIVE_MARKER))) refuse('invalid-input', `${path.posix.join(crateRoot, INACTIVE_MARKER)} is left from an earlier migration; remove it explicitly before migrating again`);
  if (!lexists(at(LEDGER_INDEX))) refuse('invalid-input', `${LEDGER_DIFF} has no ${LEDGER_INDEX} next to it`);
  const ledgerIndex = readJson(at(LEDGER_INDEX));
  const entries = Array.isArray(ledgerIndex) ? ledgerIndex : ledgerIndex?.entries;
  if (!Array.isArray(entries)) refuse('invalid-input', `${LEDGER_INDEX} must hold an array of entries or an object with an "entries" array`);
  const ledgerBytes = fs.readFileSync(at(LEDGER_DIFF));
  const hunks = splitLedger(ledgerBytes.toString('utf8'));
  if (hunks.length !== entries.length) {
    refuse('invalid-input', `${LEDGER_DIFF} has ${hunks.length} hunk(s) but ${LEDGER_INDEX} has ${entries.length} entr(ies); they must map one to one, in order`);
  }
  hunks.forEach((hunk, position) => {
    const named = entries[position]?.file;
    if (typeof named === 'string' && named !== hunk.file) {
      refuse('invalid-input', `entry ${position + 1} names ${named} but hunk ${position + 1} changes ${hunk.file}`);
    }
  });
  const patches = hunks.map((hunk, position) => migratedPatch(entries[position], hunk, position));
  const names = patches.map((patch) => patch.file);
  if (new Set(names).size !== names.length) refuse('invalid-input', `the ids in ${LEDGER_INDEX} must be unique`);
  refuseOutsideInputs(patches, inputs);

  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fvs-extract-migrate-'));
  try {
    const tree = path.join(scratch, 'tree');
    materialise({ projectRoot, inputs, files }, tree);
    const reverted = gitApply(tree, { bytes: ledgerBytes }, '-R');
    if (reverted.status !== 0) {
      refuse('stale', `the working source does not carry ${LEDGER_DIFF}: ${reverted.stderr.trim()}`, { kind: 'stale' });
    }
    const pinned = { inputs, patches, files: walkInputs(tree, inputs) };
    rehearse(pinned, tree);
    applyAll(pinned, tree, []);
    if (!sameState(walkInputs(tree, inputs), files)) {
      refuse('stale', 'the migrated patches do not rebuild the working source from the pin', { kind: 'irreversible' });
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  fs.mkdirSync(directory, { recursive: true });
  for (const patch of patches) fs.writeFileSync(path.join(directory, patch.file), patch.bytes, { flag: 'wx' });
  fs.writeFileSync(path.join(directory, SERIES), `${names.join('\n')}\n`, { flag: 'wx' });
  const ledger = LEDGER_FILES.filter((name) => lexists(at(name)));
  const marker = {
    schema: 'fvs-extract-patches/legacy-inactive',
    version: 1,
    ledger: Object.fromEntries(ledger.map((name) => [name, fileState(at(name))])),
    patches: patches.map((patch, position) => ({ file: patch.file, sha256: patch.sha256, hunk: position + 1, entry: entries[position] })),
  };
  fs.writeFileSync(at(INACTIVE_MARKER), `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx' });
  return {
    message: `migrated ${patches.length} ledger hunk(s) to ${PATCH_DIR}/ and marked the ledger inactive; restore the pristine source before extracting`,
    patches: names,
    marker: path.posix.join(crateRoot, INACTIVE_MARKER),
  };
}

// Recorded extraction attempt. One attempt per prepared copy: Charon, then
// Aeneas, then publication of the generated Lean files, each run by this
// engine under a controlled environment, with its invocation checked against a
// fixed supported contract and its outputs hashed when it exits. The records
// show that the artifacts came from this attempt on a trusted local host
// running these scripts; they do not authenticate against a malicious host or
// prove compiler correctness.

const ATTEMPT = 'attempt.json';
const ATTEMPT_STAGES = ['charon', 'aeneas', 'publish'];
const OWNERSHIP = '.fvs-publication.json';
const PUBLICATION_PENDING = '.fvs-publication.pending.json';
const ITEM = /^[A-Za-z_][A-Za-z0-9_]*(::(\*|[A-Za-z_][A-Za-z0-9_]*))*$/;
const CHARON_VALUED = { '--sysroot': /^default$/, '--opaque': ITEM, '--exclude': ITEM, '--include': ITEM, '--start-from': ITEM };
const CARGO_FLAGS = new Set(['--locked', '--no-default-features', '--all-features', '--lib']);
const FEATURE = '[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)?';
const CARGO_VALUED = { '--features': new RegExp(`^${FEATURE}(,${FEATURE})*$`), '--package': /^[A-Za-z0-9_-]+$/ };
const SET_BY_RECORDER = new Set(['HOME', 'RUSTUP_HOME', 'CARGO_HOME', 'PATH', 'RUSTUP_TOOLCHAIN']);
// __CF_USER_TEXT_ENCODING: macOS adds it to every process, children included.
const IGNORED_ENV = [/^(TERM|COLORTERM|LANG|TMPDIR|USER|LOGNAME|SHELL|PWD|OLDPWD|SHLVL|_|__CF_USER_TEXT_ENCODING)$/, /^LC_/, /^TERM_/, /^AO_/];
const INFLUENTIAL_ENV = [
  /^(RUSTFLAGS|RUSTDOCFLAGS|RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|CARGO_INCREMENTAL|CARGO_TARGET_DIR|SDKROOT|MACOSX_DEPLOYMENT_TARGET)$/,
  /^CARGO_ENCODED_/, /^CARGO_(BUILD|PROFILE|TARGET|UNSTABLE|REGISTRIES|REGISTRY|SOURCE|NET|HTTP)_/, /^CHARON_/, /^AENEAS_/,
];

// The class of an argument outside the contract. Refusals name the position and
// this class, never the value, so a credential in an override is never echoed.
function argClass(token) {
  if (token === undefined) return 'missing';
  if (token.startsWith('--config') || token.startsWith('-Z')) return 'override';
  if (token.includes('://')) return 'url';
  if (token.includes('=')) return 'key=value';
  if (token === '--manifest-path' || token === '--target-dir') return 'path-override';
  return 'unsupported';
}

function checkArgs(where, tokens, flags, valued) {
  if (!Array.isArray(tokens) || tokens.some((token) => typeof token !== 'string')) refuse('invalid-input', `${where} must be an array of strings`);
  const checked = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (flags.has(token)) {
      checked.push(token);
      continue;
    }
    if (!Object.hasOwn(valued, token)) {
      refuse('invalid-input', `${where}[${index}] is outside the supported invocation (${argClass(token)})`, { position: index, class: argClass(token) });
    }
    const value = tokens[index + 1];
    if (typeof value !== 'string' || !valued[token].test(value)) {
      refuse('invalid-input', `${where}[${index + 1}], the value of ${token}, is outside the supported invocation (${argClass(value)})`, { position: index + 1, class: argClass(value) });
    }
    checked.push(token, value);
    index += 1;
  }
  return checked;
}

// Names only: a value is read solely for RUSTUP_TOOLCHAIN, to compare it with the pin.
function callerResiduals(env, channel) {
  const residuals = [];
  for (const name of Object.keys(env).sort()) {
    if (SET_BY_RECORDER.has(name)) {
      if (name === 'RUSTUP_TOOLCHAIN' && env[name] !== channel) residuals.push({ name, class: 'influential' });
    } else if (INFLUENTIAL_ENV.some((pattern) => pattern.test(name))) {
      residuals.push({ name, class: 'influential' });
    } else if (!IGNORED_ENV.some((pattern) => pattern.test(name))) {
      residuals.push({ name, class: 'unknown' });
    }
  }
  return residuals;
}

function controlledEnv(env, channel) {
  const home = env.HOME;
  const rustupHome = env.RUSTUP_HOME ?? (home && path.join(home, '.rustup'));
  const cargoHome = env.CARGO_HOME ?? (home && path.join(home, '.cargo'));
  for (const [name, value] of [['HOME', home], ['RUSTUP_HOME', rustupHome], ['CARGO_HOME', cargoHome]]) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) refuse('invalid-input', `${name} must be an absolute path`);
  }
  return { HOME: home, RUSTUP_HOME: rustupHome, CARGO_HOME: cargoHome, PATH: `${path.join(cargoHome, 'bin')}:/usr/bin:/bin`, RUSTUP_TOOLCHAIN: channel };
}

// Every cargo configuration file cargo would read for a build in the copy: path
// and hash, or absent. Contents are never copied anywhere.
function cargoConfigFiles(tree, cargoHome) {
  const dirs = [];
  for (let dir = tree; ; dir = path.dirname(dir)) {
    dirs.push(path.join(dir, '.cargo'));
    if (path.dirname(dir) === dir) break;
  }
  dirs.push(cargoHome);
  return [...new Set(dirs)].flatMap((dir) => ['config', 'config.toml'].map((name) => {
    const state = fileState(path.join(dir, name));
    return { path: path.join(dir, name), present: state !== null, sha256: state?.sha256 ?? null };
  }));
}

function releaseTools(release) {
  let root;
  try {
    root = fs.realpathSync(release);
  } catch {
    refuse('invalid-input', `the release directory ${release} does not exist`);
  }
  const tools = {};
  for (const [key, name] of [['charon', 'charon'], ['charonDriver', 'charon-driver'], ['aeneas', 'aeneas']]) {
    const file = path.join(root, name);
    const real = lexists(file) ? fs.realpathSync(file) : null;
    if (!real || !inside(real, root) || !fs.statSync(real).isFile()) refuse('invalid-input', `${name} must be a regular file inside the release directory ${root}`);
    tools[key] = { path: real, sha256: sha256(fs.readFileSync(real)) };
  }
  const toolchain = path.join(root, 'rust-toolchain');
  if (!fs.existsSync(toolchain)) refuse('invalid-input', `the release has no rust-toolchain file at ${toolchain}`);
  const bytes = fs.readFileSync(toolchain);
  const channel = /channel\s*=\s*"([^"]+)"/.exec(bytes.toString('utf8'))?.[1];
  if (!channel) refuse('invalid-input', `${toolchain} names no channel`);
  tools.rustToolchain = { path: toolchain, sha256: sha256(bytes), channel };
  return { root, tools };
}

function firstOutput(file, args, env, cwd) {
  const run = spawnSync(file, args, { env, cwd, encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : null;
}

// Per-attempt paths are replaced so two attempts with one configuration hash alike.
function canonicalConfig(value, out, projectRoot) {
  return JSON.parse(JSON.stringify(value), (key, item) => (typeof item === 'string' ? item.split(out).join('$OUT').split(projectRoot).join('$PROJECT') : item));
}

const SPEC_FIELDS = ['release', 'crate', 'publishDir', 'charonArgs', 'cargoArgs', 'aeneasArgs', 'moduleRoot', 'substitutions', 'stitch', 'dropped'];
const INVOCATION_FIELDS = ['spec', 'crate', 'llbc', 'aeneasDest', 'publishDir', 'projectRoot', 'tree', 'release', 'tools', 'env', 'charon', 'aeneas', 'targets', 'nonTargets'];
const TRUST = 'local-host-and-reviewed-scripts';

// A multi-crate spec: the top-level fields are the base, every entry of crates
// is an overlay, and each crate gets its own attempt chain inside the one
// prepared copy, under OUT/units/<crate>.
const UNITS_DIR = 'units';
const MULTI_SCHEMA = 'fvs-extract-patches/multi-attempt';
const MULTI_SPEC_FIELDS = ['release', 'cargoArgs', 'charonArgs', 'aeneasArgs', 'crates', 'main', 'nonTargets', 'dropped'];
const UNIT_FIELDS = ['crate', 'package', 'dir', 'publishDir', 'charonArgs', 'cargoArgs', 'aeneasArgs', 'moduleRoot', 'substitutions', 'stitch'];
const CRATE_NAME = /^[A-Za-z0-9_]+$/;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Edits to the generated Lean are declared in the spec, never made by hand:
// exact text substitutions with the match count they must find, and stitching a
// crate to the crate whose real translation replaces its axioms.
const LEAN_MODULE = /^[A-Za-z_][A-Za-z0-9_']*(\.[A-Za-z_][A-Za-z0-9_']*)*$/;
const RUST_PATH = /^[A-Za-z0-9_]+(::[A-Za-z0-9_]+)*$/;
const SUBSTITUTION_FIELDS = ['file', 'find', 'replace', 'count', 'reason'];
// A substitution renames a name that Lean cannot read, and does nothing else. Aeneas writes
// a shadowed local as `len·`, which a Lean identifier cannot contain. The characters that
// qualify are listed, and the list grows only from output a real Aeneas wrote.
const UNREADABLE_NAME_CHARS = ['\u00b7'];
const NAME_FRAGMENT = /^[\p{L}\p{N}_'\u00b7]+$/u;
const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_']*$/;
const STITCH_FIELDS = ['crate', 'assume'];
const PUBLISH_DEST = 'publish-dest';

function checkSubstitutions(list) {
  if (!Array.isArray(list)) refuse('invalid-input', 'spec.substitutions must be an array');
  return list.map((entry, index) => {
    const where = `substitutions[${index}]`;
    if (!isObject(entry)) refuse('invalid-input', `${where} must be an object`);
    const extra = Object.keys(entry).filter((key) => !SUBSTITUTION_FIELDS.includes(key));
    if (extra.length > 0) refuse('invalid-input', `${where} has unsupported fields: ${extra.join(', ')}`);
    const relative = typeof entry.file === 'string' ? path.posix.normalize(entry.file) : '';
    if (!relative.endsWith('.lean') || path.posix.isAbsolute(relative) || relative.split('/').includes('..')) refuse('invalid-input', `${where}.file must name a generated Lean file, relative to the Aeneas output`);
    if (relative.split('/').some((part) => part.toLowerCase() === 'trusted')) refuse('invalid-input', `${where}.file is under a Trusted directory; a substitution edits generated Lean only, never a Trusted file`);
    if (typeof entry.find !== 'string' || entry.find === '') refuse('invalid-input', `${where}.find must be the exact non-empty text to replace`);
    if (typeof entry.replace !== 'string') refuse('invalid-input', `${where}.replace must be a string`);
    if (!NAME_FRAGMENT.test(entry.find) || !UNREADABLE_NAME_CHARS.some((char) => entry.find.includes(char))) {
      refuse('invalid-input', `${where}.find must be part of a name that Lean cannot read, which holds one of ${UNREADABLE_NAME_CHARS.map((char) => `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join(', ')} (such as "len·"); a substitution only renames such a name, and any other change to the translation is a translation patch of the Rust source`);
    }
    if (!PLAIN_IDENTIFIER.test(entry.replace)) refuse('invalid-input', `${where}.replace must be a plain identifier (ASCII letters, digits, _ and ')`);
    if (!Number.isInteger(entry.count) || entry.count < 1) refuse('invalid-input', `${where}.count must be the exact number of matches (at least 1)`);
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') refuse('invalid-input', `${where}.reason must say why the generated Lean needs this edit`);
    return { file: relative, find: entry.find, replace: entry.replace, count: entry.count, reason: entry.reason };
  }).map((entry, index, all) => {
    const clash = all.findIndex((other, at) => at !== index && other.replace === entry.replace);
    if (clash !== -1) refuse('invalid-input', `substitutions[${index}].replace ${JSON.stringify(entry.replace)} is also used by substitutions[${clash}]: two renames never share a new name`);
    return entry;
  });
}

function checkStitch(list, crate, targets) {
  if (!Array.isArray(list)) refuse('invalid-input', 'spec.stitch must be an array');
  if (list.length > 0 && targets.length === 0) refuse('invalid-input', 'stitch needs a multi-crate spec: the crate it imports must be another crate of the same attempt');
  const seen = new Set();
  return list.map((entry, index) => {
    const where = `stitch[${index}]`;
    if (!isObject(entry)) refuse('invalid-input', `${where} must be an object`);
    const extra = Object.keys(entry).filter((key) => !STITCH_FIELDS.includes(key));
    if (extra.length > 0) refuse('invalid-input', `${where} has unsupported fields: ${extra.join(', ')}`);
    checkCrateName(`${where}.crate`, entry.crate);
    if (entry.crate === crate) refuse('invalid-input', `${where}.crate names the crate itself`);
    if (!targets.some((target) => target.crate === entry.crate)) refuse('invalid-input', `${where}.crate ${entry.crate} is not a crate of this attempt (${targets.map((target) => target.crate).join(', ')})`);
    if (seen.has(entry.crate)) refuse('invalid-input', `stitch names crate ${entry.crate} more than once`);
    seen.add(entry.crate);
    const assume = entry.assume ?? [];
    if (!Array.isArray(assume) || assume.some((item) => typeof item !== 'string' || !RUST_PATH.test(item) || item.split('::')[0] !== entry.crate)) {
      refuse('invalid-input', `${where}.assume must list Rust paths of crate ${entry.crate} (a module or an item, such as ${entry.crate}::some_module)`);
    }
    if (assume.some((item) => !item.includes('::'))) refuse('invalid-input', `${where}.assume names the whole crate ${entry.crate}; list the modules or items it does not define (such as ${entry.crate}::some_module), because everything it defines is stitched`);
    return { crate: entry.crate, assume: [...assume].sort() };
  });
}

// The manifest, the tree and the verify checks belong to the copy OUT; a
// crate's own attempt lives in OUT/units/<crate>.
function copyRoot(out) {
  if (lexists(path.join(out, MANIFEST))) return out;
  const copy = path.dirname(path.dirname(out));
  return path.basename(path.dirname(out)) === UNITS_DIR && lexists(path.join(copy, MANIFEST)) ? copy : out;
}

// Charon labels a crate with its underscored name; the hyphenated one belongs to --package.
function checkCrateName(where, name) {
  if (typeof name === 'string' && name.includes('-') && CRATE_NAME.test(name.replace(/-/g, '_'))) {
    refuse('invalid-input', `${where} ${JSON.stringify(name)} has a hyphen; Charon labels a crate with its underscored name, so use ${JSON.stringify(name.replace(/-/g, '_'))} (the hyphenated name is the --package name)`, { field: where });
  }
  if (typeof name !== 'string' || !CRATE_NAME.test(name)) refuse('invalid-input', `${where} must be a crate name (letters, digits and underscores)`, { field: where });
}

// In-repo crates the owner decided not to verify. They are named, never hidden: Charon
// reaches their sources, the LLBC check accepts them under their own label and records
// their tree-pinned hashes, and only their items may become assumptions.
function checkNonTargets(list, units, manifest) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) refuse('invalid-input', 'nonTargets must be an array');
  const seen = new Set();
  return list.map((entry, index) => {
    const where = `nonTargets[${index}]`;
    if (!isObject(entry)) refuse('invalid-input', `${where} must be an object`);
    const extra = Object.keys(entry).filter((key) => !['crate', 'dir'].includes(key));
    if (extra.length > 0) refuse('invalid-input', `${where} has unsupported fields: ${extra.join(', ')}`);
    checkCrateName(`${where}.crate`, entry.crate);
    if (units.some((unit) => unit.crate === entry.crate)) refuse('invalid-input', `${where}.crate ${entry.crate} is also a target; a crate is either verified or not`);
    if (seen.has(entry.crate)) refuse('invalid-input', `nonTargets names crate ${entry.crate} more than once`);
    seen.add(entry.crate);
    const dir = typeof entry.dir === 'string' ? path.posix.normalize(entry.dir) : '';
    if (dir === '' || path.isAbsolute(dir) || dir.split('/').includes('..')) refuse('invalid-input', `${where}.dir must be the crate directory inside the extraction copy, relative to its root`);
    if (!Object.hasOwn(manifest.final.files, path.posix.join(dir, 'Cargo.toml'))) refuse('invalid-input', `${where}.dir ${dir} holds no Cargo.toml in the extraction copy; add it to extraction.inputs`, { field: `${where}.dir` });
    if (units.some((unit) => unit.dir === dir)) refuse('invalid-input', `${where}.dir ${dir} is the directory of target crate ${units.find((unit) => unit.dir === dir).crate}`);
    return { crate: entry.crate, dir };
  });
}

// The units of a multi-crate spec, each as an ordinary single-crate spec. An
// overlay field replaces the base field (lists are replaced, never joined), and
// the unit's package becomes its --package argument. Nothing is written here.
function multiUnits(spec, manifest) {
  const unknown = Object.keys(spec).filter((key) => !MULTI_SPEC_FIELDS.includes(key));
  if (unknown.length > 0) refuse('invalid-input', `a multi-crate spec has unsupported fields: ${unknown.join(', ')} (crate and publishDir belong to each entry of crates)`);
  if (!Array.isArray(spec.crates) || spec.crates.length === 0) refuse('invalid-input', 'crates must be a non-empty array');
  const units = spec.crates.map((entry, index) => {
    const where = `crates[${index}]`;
    if (!isObject(entry)) refuse('invalid-input', `${where} must be an object`);
    const extra = Object.keys(entry).filter((key) => !UNIT_FIELDS.includes(key));
    if (extra.length > 0) refuse('invalid-input', `${where} has unsupported fields: ${extra.join(', ')}`);
    checkCrateName(`${where}.crate`, entry.crate);
    if (typeof entry.package !== 'string' || !/^[A-Za-z0-9_-]+$/.test(entry.package)) refuse('invalid-input', `${where}.package must be the Cargo package name`);
    const dir = typeof entry.dir === 'string' ? path.posix.normalize(entry.dir) : '';
    if (dir === '' || path.isAbsolute(dir) || dir.split('/').includes('..')) refuse('invalid-input', `${where}.dir must be the crate directory inside the extraction copy, relative to its root`);
    if (!Object.hasOwn(manifest.final.files, path.posix.join(dir, 'Cargo.toml'))) refuse('invalid-input', `${where}.dir ${dir} holds no Cargo.toml in the extraction copy; add it to extraction.inputs`, { field: `${where}.dir` });
    const cargoArgs = entry.cargoArgs ?? spec.cargoArgs ?? [];
    if (!Array.isArray(cargoArgs)) refuse('invalid-input', `${where}.cargoArgs must be an array of strings`);
    if (cargoArgs.includes('--package')) refuse('invalid-input', `${where}.cargoArgs must not carry --package; set package instead`);
    return {
      crate: entry.crate,
      package: entry.package,
      dir,
      flat: {
        release: spec.release,
        crate: entry.crate,
        publishDir: entry.publishDir,
        charonArgs: entry.charonArgs ?? spec.charonArgs ?? [],
        cargoArgs: [...cargoArgs, '--package', entry.package],
        aeneasArgs: entry.aeneasArgs ?? spec.aeneasArgs ?? [],
        ...(entry.moduleRoot !== undefined ? { moduleRoot: entry.moduleRoot } : {}),
        ...(entry.substitutions !== undefined ? { substitutions: entry.substitutions } : {}),
        ...(entry.stitch !== undefined ? { stitch: entry.stitch } : {}),
      },
    };
  });
  for (const key of ['crate', 'package', 'dir']) {
    const repeated = units.map((unit) => unit[key]).filter((value, index, all) => all.indexOf(value) !== index);
    if (repeated.length > 0) refuse('invalid-input', `crates names ${key} ${repeated.join(', ')} more than once`);
  }
  if (typeof spec.main !== 'string' || !units.some((unit) => unit.crate === spec.main)) refuse('invalid-input', `main must name one of the crates (${units.map((unit) => unit.crate).join(', ')})`);
  const published = units.map((unit) => (typeof unit.flat.publishDir === 'string' ? path.posix.normalize(unit.flat.publishDir) : null));
  published.forEach((first, i) => published.forEach((second, j) => {
    if (i < j && first !== null && second !== null && (first === second || first.startsWith(`${second}/`) || second.startsWith(`${first}/`))) {
      refuse('invalid-input', `the publishDir of ${units[i].crate} (${first}) and of ${units[j].crate} (${second}) are the same or nested; every crate publishes into its own sibling directory`);
    }
  }));
  return { units, main: spec.main, order: stitchOrder(units), nonTargets: checkNonTargets(spec.nonTargets, units, manifest) };
}

// The crates in dependency order, providers before the crates stitched to them. A crate
// can only be stitched to a crate whose Lean module root is known, and a cycle is refused.
function stitchOrder(units) {
  const targets = units.map(({ crate, dir }) => ({ crate, dir }));
  const providers = new Map(units.map((unit) => [unit.crate, checkStitch(unit.flat.stitch ?? [], unit.crate, targets).map((entry) => entry.crate)]));
  for (const [crate, list] of providers) {
    for (const provider of list) {
      if (units.find((unit) => unit.crate === provider).flat.moduleRoot === undefined) refuse('invalid-input', `${crate} is stitched to ${provider}, which names no moduleRoot; the Lean module name of ${provider}'s published directory is needed to import it`);
    }
  }
  const order = [];
  const visiting = new Set();
  const visit = (crate) => {
    if (order.includes(crate)) return;
    if (visiting.has(crate)) refuse('invalid-input', `stitching is circular through ${crate}; a crate can only import crates that do not import it`);
    visiting.add(crate);
    for (const provider of providers.get(crate)) visit(provider);
    visiting.delete(crate);
    order.push(crate);
  };
  for (const unit of units) visit(unit.crate);
  return order;
}

// The roster of a multi-crate attempt: who is in it and how they are tied together, in one
// canonical form (fixed key order, units in the attempt's order, every list sorted). Every unit's
// attempt record carries it and so does the top-level record, and the hash of this form is what
// a reader binds to. One unit left out of the status therefore changes the roster it recomputes.
function rosterOf({ main, order, units, nonTargets, dropped }) {
  const byCrate = (a, b) => (a.crate < b.crate ? -1 : a.crate > b.crate ? 1 : 0);
  return {
    main,
    order: [...order],
    units: order.map((crate) => {
      const unit = units.find((entry) => entry.crate === crate);
      return { crate, package: unit.package, dir: unit.dir, stitch: [...unit.stitch].sort() };
    }),
    nonTargets: nonTargets.map(({ crate, dir }) => ({ crate, dir })).sort(byCrate),
    dropped: dropped.map(({ crate, reason }) => ({ crate, reason })).sort(byCrate),
  };
}
const rosterSha256 = (roster) => sha256(JSON.stringify(roster));

function homesOf(env) {
  const home = env.HOME;
  return {
    HOME: home,
    RUSTUP_HOME: env.RUSTUP_HOME ?? (typeof home === 'string' ? path.join(home, '.rustup') : undefined),
    CARGO_HOME: env.CARGO_HOME ?? (typeof home === 'string' ? path.join(home, '.cargo') : undefined),
  };
}

// The one execution representation of an attempt, derived from the validated
// spec, the prepared manifest, the release and the three home paths. Recording
// stores it; every stage derives it again, refuses any difference from the
// record, and executes only the derived form.
function deriveInvocation(out, manifest, spec, homes, targets = [], nonTargets = []) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) refuse('invalid-input', 'the spec must be a JSON object');
  const unknown = Object.keys(spec).filter((key) => !SPEC_FIELDS.includes(key));
  if (unknown.length > 0) refuse('invalid-input', `the spec has unsupported fields: ${unknown.join(', ')}${unknown.includes('nonTargets') ? ' (nonTargets belongs to a multi-crate spec: list this crate under crates)' : ''}`);
  checkCrateName('spec.crate', spec.crate);
  const { projectRoot } = manifest;
  const publishRelative = typeof spec.publishDir === 'string' ? path.posix.normalize(spec.publishDir) : '';
  if (publishRelative === '' || publishRelative === '.' || path.isAbsolute(publishRelative) || publishRelative.split('/').includes('..')) {
    refuse('invalid-input', 'spec.publishDir must be a directory inside the project, given relative to it');
  }
  refuseLinkedDirectory(projectRoot, publishRelative);
  if (typeof spec.release !== 'string') refuse('invalid-input', 'spec.release must name the Aeneas/Charon release directory');
  const charonArgs = checkArgs('charonArgs', spec.charonArgs ?? [], new Set(), CHARON_VALUED);
  const cargoArgs = checkArgs('cargoArgs', spec.cargoArgs ?? [], CARGO_FLAGS, CARGO_VALUED);
  checkArgs('aeneasArgs', spec.aeneasArgs ?? [], new Set(), {});
  if (spec.moduleRoot !== undefined && (typeof spec.moduleRoot !== 'string' || !LEAN_MODULE.test(spec.moduleRoot))) {
    refuse('invalid-input', 'spec.moduleRoot must be the Lean module name of the published directory, such as Project.Extraction.Crate');
  }
  const substitutions = checkSubstitutions(spec.substitutions ?? []);
  const stitch = checkStitch(spec.stitch ?? [], spec.crate, targets);
  const release = releaseTools(path.resolve(projectRoot, spec.release));
  for (const name of ['HOME', 'RUSTUP_HOME', 'CARGO_HOME']) {
    if (typeof homes[name] !== 'string' || !path.isAbsolute(homes[name])) refuse('invalid-input', `${name} must be an absolute path`);
  }
  const env = { HOME: homes.HOME, RUSTUP_HOME: homes.RUSTUP_HOME, CARGO_HOME: homes.CARGO_HOME, PATH: `${path.join(homes.CARGO_HOME, 'bin')}:/usr/bin:/bin`, RUSTUP_TOOLCHAIN: release.tools.rustToolchain.channel };
  const llbc = path.join(out, `${spec.crate}.llbc`);
  const aeneasDest = path.join(out, 'aeneas-dest');
  return {
    spec: {
      release: spec.release, crate: spec.crate, publishDir: publishRelative, charonArgs, cargoArgs, aeneasArgs: [],
      ...(spec.moduleRoot !== undefined ? { moduleRoot: spec.moduleRoot } : {}),
      ...(substitutions.length > 0 ? { substitutions } : {}),
      ...(stitch.length > 0 ? { stitch } : {}),
    },
    crate: spec.crate,
    llbc,
    aeneasDest,
    publishDir: path.join(projectRoot, publishRelative),
    projectRoot,
    tree: manifest.tree,
    release: release.root,
    tools: release.tools,
    env,
    charon: { argv: ['cargo', '--preset=aeneas', '--dest-file', llbc, ...charonArgs, ...(cargoArgs.length > 0 ? ['--', ...cargoArgs] : [])], cwd: manifest.tree },
    aeneas: { argv: ['-backend', 'lean', '-emit-json', '-dest', aeneasDest, llbc], cwd: projectRoot },
    // The declared crates of a multi-crate attempt (absent for a single crate), so the
    // Charon stage can tell another declared crate's sources from an undeclared one.
    ...(targets.length > 0 ? { targets } : {}),
    ...(nonTargets.length > 0 ? { nonTargets } : {}),
  };
}

function identityOf(invocation, out) {
  const { env, tools } = invocation;
  return {
    charonVersion: firstOutput(tools.charon.path, ['version'], env, out),
    aeneasVersion: firstOutput(tools.aeneas.path, ['-version'], env, out),
    rustc: firstOutput('rustc', ['-vV'], env, out),
    cargo: firstOutput('cargo', ['-V'], env, out),
  };
}

function configOf(invocation, identity, cargoConfig, out) {
  return canonicalConfig({
    tools: Object.fromEntries(Object.entries(invocation.tools).map(([key, tool]) => [key, { sha256: tool.sha256, ...(tool.channel ? { channel: tool.channel } : {}) }])),
    identity,
    env: invocation.env,
    charon: invocation.charon,
    aeneas: invocation.aeneas,
    cargoConfig: cargoConfig.filter((entry) => entry.present).map(({ path: file, sha256: hash }) => ({ path: file, sha256: hash })),
  }, out, invocation.projectRoot);
}

function preparedManifest(out) {
  const manifestFile = path.join(copyRoot(out), MANIFEST);
  if (!fs.existsSync(manifestFile)) refuse('usage', `no manifest at ${manifestFile}`);
  const bytes = fs.readFileSync(manifestFile);
  const manifest = JSON.parse(bytes);
  if (manifest.status !== 'prepared' || !manifest.final || manifest.mode !== 'translation-patches') {
    refuse('partial', 'an attempt needs a prepared translation-patch copy');
  }
  return { manifest, manifestSha256: sha256(bytes) };
}

function attempt(flags) {
  const out = path.resolve(flags.out);
  const { manifest, manifestSha256 } = preparedManifest(out);
  if (lexists(path.join(out, ATTEMPT))) refuse('attempt-refused', 'this copy already has an attempt; prepare a new copy to retry');
  if (manifest.lock?.origin === 'absent') {
    refuse('attempt-refused', `the prepared copy has no ${LOCK_FILE}, so cargo would write one into the copy during the build and the copy would no longer match the recorded tree; put a ${LOCK_FILE} in the project (it need not be committed: its hash and origin are recorded), or prepare a new copy with --lock update --release DIR (it may need network access; the lock is recorded by hash)`);
  }
  const spec = readJson(path.resolve(flags.spec));
  if (isObject(spec) && spec.crates !== undefined) return attemptUnits(out, manifest, manifestSha256, spec);
  const unaccounted = coverageProblems(manifest, { targets: [], nonTargets: [], dropped: checkDropped(isObject(spec) ? spec.dropped : undefined), multi: false });
  if (unaccounted.length > 0) refuse('attempt-refused', `the workspace is not accounted for: ${unaccounted.join('; ')}`, { reasons: unaccounted });
  return recordAttempt(out, manifest, manifestSha256, spec);
}

// The in-repo crates of a tree, as cargo sees them: package, crate name (the library
// target's, which is what Charon labels items with), directory, and the in-repo crates
// each one depends on (normal and build dependencies; dev-dependencies are not part of an
// extraction), with a dependency order, providers first. This only proposes targets: a
// crate that is neither declared a target nor a non-target is refused when Charon's output
// is read. It runs `cargo metadata --no-deps --offline` (nothing is written), so a
// workspace cargo cannot read (a missing member, inheritance without a workspace, a path
// dependency without a manifest) is reported with cargo's own first error lines.
//
// With --out it describes the PATCHED copy Charon will build, and compares it with the
// checkout: the path dependencies a patch removed and the packages the copy lacks. With
// --project-root it describes a fresh checkout, before any copy exists, and proposes the
// extraction.inputs that give a copy every in-repo crate cargo needs.
const LIBRARY_KINDS = ['lib', 'rlib', 'dylib', 'cdylib', 'staticlib'];
const first = (lines) => lines.map((line) => line.trim()).filter((line) => line !== '').slice(0, 6);

function cargoMetadata(tree, env, where, manifestPath = null) {
  const run = spawnSync('cargo', ['metadata', '--no-deps', '--offline', '--format-version', '1', ...(manifestPath ? ['--manifest-path', manifestPath] : [])], { env, cwd: tree, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) {
    const lines = first(`${run.stderr ?? ''}`.split('\n'));
    refuse('tool-failed', `cargo cannot read the workspace of ${where}${lines.length > 0 ? `: ${lines.join(' | ')}` : ''}`, { reasons: lines });
  }
  try {
    return JSON.parse(run.stdout);
  } catch {
    return refuse('tool-failed', 'cargo metadata did not return JSON');
  }
}

const relativeTo = (tree, dir) => path.relative(tree, dir).split(path.sep).join('/') || '.';
const realOrSelf = (file) => (fs.existsSync(file) ? fs.realpathSync(file) : file);
const pathDependencies = (item) => item.dependencies.filter((dependency) => dependency.kind !== 'dev' && dependency.path);

function describeWorkspace(tree, metadata) {
  const rows = metadata.packages.map((item) => {
    const dir = path.dirname(fs.realpathSync(item.manifest_path));
    const library = item.targets.find((target) => target.kind.some((kind) => LIBRARY_KINDS.includes(kind)));
    return { package: item.name, crate: library ? library.name.replace(/-/g, '_') : null, dir: inside(dir, tree) || dir === tree ? relativeTo(tree, dir) : null, abs: dir, library: library !== undefined, item };
  }).filter((row) => row.dir !== null).sort((a, b) => a.dir.localeCompare(b.dir));
  const byDir = new Map(rows.map((row) => [row.abs, row]));
  const crates = rows.map((row) => ({
    package: row.package,
    crate: row.crate,
    dir: row.dir,
    library: row.library,
    deps: [...new Set(pathDependencies(row.item).map((dependency) => byDir.get(realOrSelf(dependency.path)))
      .filter((provider) => provider !== undefined && provider.library).map((provider) => provider.crate))].sort(),
  }));
  // --no-deps lists the workspace members only: a path dependency inside the tree that is
  // not a member is not in the list above, so it is named here.
  const unlistedAbs = [...new Set(rows.flatMap((row) => pathDependencies(row.item).map((dependency) => realOrSelf(dependency.path))
    .filter((dir) => !byDir.has(dir) && inside(dir, tree) && dir !== tree)))].sort();
  const order = [];
  const visit = (row, seen = new Set()) => {
    if (order.includes(row.crate) || seen.has(row.crate)) return;
    seen.add(row.crate);
    for (const dependency of row.deps) visit(crates.find((candidate) => candidate.crate === dependency), seen);
    order.push(row.crate);
  };
  crates.filter((row) => row.library).forEach((row) => visit(row));
  return { rows, crates, order, unlistedAbs, unlisted: unlistedAbs.map((dir) => relativeTo(tree, dir)) };
}

const crateName = (name) => name.replace(/-/g, '_');

// The in-repo crates of a tree as cargo sees them, complete: the workspace members, the
// path dependencies inside the tree that are not members, followed to any depth (cargo
// metadata without dependencies lists members only, one manifest per call), and the members
// whose real directory is outside the tree (a symbolic link), which a copy cannot hold.
function workspaceView(tree, env, where) {
  const metadata = cargoMetadata(tree, env, where);
  const described = describeWorkspace(tree, metadata);
  const outside = metadata.packages.filter((item) => !inside(path.dirname(fs.realpathSync(item.manifest_path)), tree) && path.dirname(fs.realpathSync(item.manifest_path)) !== tree)
    .map((item) => ({ package: item.name, crate: crateName((item.targets.find((target) => target.kind.some((kind) => LIBRARY_KINDS.includes(kind))) ?? { name: item.name }).name), library: item.targets.some((target) => target.kind.some((kind) => LIBRARY_KINDS.includes(kind))), manifest: item.manifest_path }));
  const seen = new Set(described.rows.map((row) => row.abs));
  const rows = [...described.rows];
  const queue = [...described.unlistedAbs];
  const loose = [];
  while (queue.length > 0) {
    const dir = queue.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);
    const listed = cargoMetadata(tree, env, `${where}, ${relativeTo(tree, dir)}`, path.join(dir, 'Cargo.toml'));
    for (const item of listed.packages) {
      const home = path.dirname(fs.realpathSync(item.manifest_path));
      if (home !== dir) continue;
      const library = item.targets.find((target) => target.kind.some((kind) => LIBRARY_KINDS.includes(kind)));
      rows.push({ package: item.name, crate: library ? crateName(library.name) : null, dir: relativeTo(tree, dir), abs: dir, library: library !== undefined, item, member: false });
      loose.push(dir);
      for (const dependency of pathDependencies(item)) {
        const target = realOrSelf(dependency.path);
        if (!seen.has(target) && inside(target, tree) && target !== tree) queue.push(target);
      }
    }
  }
  const byDir = new Map(rows.map((row) => [row.abs, row]));
  return {
    metadata,
    described,
    rows,
    outside,
    unlisted: loose.map((dir) => relativeTo(tree, dir)).sort(),
    crates: [
      ...rows.map((row) => ({ package: row.package, crate: row.crate, dir: row.dir, library: row.library, member: row.member !== false })),
      ...outside.map((row) => ({ package: row.package, crate: row.crate, dir: null, library: row.library, member: true, outside: true })),
    ],
    pathDependencies: rows.flatMap((row) => pathDependencies(row.item).map((dependency) => ({ package: row.package, dependency: dependency.name, crate: byDir.get(realOrSelf(dependency.path))?.crate ?? crateName(dependency.name), dir: relativeTo(tree, realOrSelf(dependency.path)) }))),
  };
}

// The workspace before and after the patches, recorded in the manifest when prepare is given
// the release. Attempts check coverage against it: every in-repo library crate is a target, a
// declared non-target, or declared dropped, and a path dependency a patch removed is declared
// dropped too.
function workspaceInventory(projectRoot, tree, releaseFlag) {
  const env = cargoEnvironment(releaseTools(path.resolve(projectRoot, releaseFlag)));
  const original = workspaceView(projectRoot, env, 'the checkout');
  const copy = workspaceView(tree, env, 'the extraction copy');
  const keep = (view) => ({ crates: view.crates, unlisted: view.unlisted });
  const inCopy = new Set(copy.crates.map((row) => row.package));
  const kept = new Set(copy.pathDependencies.map((dependency) => `${dependency.package}|${dependency.dependency}|${dependency.dir}`));
  return {
    original: keep(original),
    copy: keep(copy),
    notInCopy: original.crates.filter((row) => !inCopy.has(row.package)).map(({ package: name, crate, dir, library }) => ({ package: name, crate, dir, library })),
    removedPathDependencies: original.pathDependencies.filter((dependency) => inCopy.has(dependency.package) && !kept.has(`${dependency.package}|${dependency.dependency}|${dependency.dir}`)).map(({ package: name, dependency, crate, dir }) => ({ package: name, dependency, crate, dir })),
  };
}

const DROPPED_FIELDS = ['crate', 'reason'];

// In-repo crates the owner decided to leave out of the extraction copy, or that a patch
// replaced by a registry release. They are named with a reason, never silently missing.
function checkDropped(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) refuse('invalid-input', 'dropped must be an array');
  const seen = new Set();
  return list.map((entry, index) => {
    const where = `dropped[${index}]`;
    if (!isObject(entry)) refuse('invalid-input', `${where} must be an object`);
    const extra = Object.keys(entry).filter((key) => !DROPPED_FIELDS.includes(key));
    if (extra.length > 0) refuse('invalid-input', `${where} has unsupported fields: ${extra.join(', ')}`);
    checkCrateName(`${where}.crate`, entry.crate);
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') refuse('invalid-input', `${where}.reason must say who decided to leave the crate out and why`);
    if (seen.has(entry.crate)) refuse('invalid-input', `dropped names crate ${entry.crate} more than once`);
    seen.add(entry.crate);
    return { crate: entry.crate, reason: entry.reason };
  });
}

// Every in-repo library crate of the original workspace is accounted for by the spec, and
// so is every path dependency a patch turned into a registry one.
function coverageProblems(manifest, { targets, nonTargets, dropped, multi }) {
  const inventory = manifest.workspace;
  if (!inventory) {
    return multi ? ['the copy was prepared without --release, so it records no workspace inventory; prepare a new copy with --release DIR so that every in-repo crate is accounted for'] : [];
  }
  const accounted = new Set([...targets.map((entry) => entry.crate), ...nonTargets.map((entry) => entry.crate), ...dropped.map((entry) => entry.crate)]);
  const problems = [];
  const inRepo = new Set(inventory.original.crates.filter((row) => row.library).map((row) => row.crate));
  const present = new Set(inventory.copy.crates.filter((row) => row.library).map((row) => row.crate));
  const removed = new Set(inventory.removedPathDependencies.map((row) => row.crate));
  if (multi) {
    const missing = [...inRepo].filter((crate) => !accounted.has(crate)).sort();
    if (missing.length > 0) problems.push(`${missing.length} in-repo crate(s) of the workspace are neither a target, a non-target nor dropped: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ', ...' : ''}; every in-repo crate is a target unless the owner decides otherwise, and each crate left out is named in nonTargets (its sources are in the copy) or dropped (they are not)`);
  }
  const loose = inventory.removedPathDependencies.filter((row) => !dropped.some((entry) => entry.crate === row.crate));
  if (loose.length > 0) problems.push(`a patch removed the path dependency on ${[...new Set(loose.map((row) => `${row.crate} (from ${row.package})`))].join(', ')}, so the build would use a registry release of an in-repo crate; name each crate in dropped with the owner's decision`);
  for (const entry of dropped) {
    if (!inRepo.has(entry.crate) && !removed.has(entry.crate)) problems.push(`dropped names crate ${entry.crate}, which is not an in-repo crate of the workspace or a path dependency a patch removed`);
    else if (targets.some((target) => target.crate === entry.crate) || nonTargets.some((other) => other.crate === entry.crate)) problems.push(`dropped names crate ${entry.crate}, which is also a target or a non-target`);
    else if (present.has(entry.crate)) problems.push(`dropped names crate ${entry.crate}, which is still in the extraction copy; a crate is either in the copy or dropped`);
  }
  return problems;
}

// What a copy of a fresh checkout must hold for cargo to read it: the workspace manifest
// and lock, every member and in-repo path dependency, and, for a root package, the
// directories its targets live in (cargo refuses a package whose targets are missing).
function suggestedInputs(tree, metadata, described) {
  const inputs = new Set(['Cargo.toml']);
  if (fs.existsSync(path.join(tree, 'Cargo.lock'))) inputs.add('Cargo.lock');
  for (const row of described.rows) {
    if (row.dir !== '.') {
      inputs.add(row.dir);
      continue;
    }
    if (fs.existsSync(path.join(tree, 'build.rs'))) inputs.add('build.rs');
    for (const target of row.item.targets) {
      const relative = relativeTo(tree, target.src_path);
      if (!relative.startsWith('..')) inputs.add(relative.split('/')[0]);
    }
  }
  for (const dir of described.unlisted) inputs.add(dir);
  const covered = [...inputs].filter((input) => ![...inputs].some((other) => other !== input && input.startsWith(`${other}/`)));
  return covered.sort();
}

// Symbolic links under the proposed inputs. A copy holds regular files only, so a link the build
// can read (blocking) is refused and the owner leaves its crate out or replaces the link by
// content; any other link is not copied and not read (ignored), and is only reported. The
// first few of each, with the full count of the ignored ones.
const LINK_REPORT_LIMIT = 10;
function linksUnder(tree, inputs) {
  const blocking = [];
  const ignored = [];
  const visit = (relative, declared = false) => {
    const stat = fs.lstatSync(path.join(tree, relative), { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink()) (isRustInputLink(relative, declared) ? blocking : ignored).push(relative);
    else if (stat.isDirectory()) for (const name of fs.readdirSync(path.join(tree, relative)).sort()) visit(`${relative}/${name}`);
  };
  inputs.forEach((input) => visit(input, true));
  return { blocking: blocking.slice(0, LINK_REPORT_LIMIT), ignored: ignored.slice(0, LINK_REPORT_LIMIT), ignoredCount: ignored.length };
}

function listCrates(flags) {
  if ((flags.out === undefined) === (flags['project-root'] === undefined)) refuse('usage', 'crates needs exactly one of --out (a prepared copy) and --project-root (a checkout)');
  const prepared = flags.out !== undefined ? preparedManifest(path.resolve(flags.out)).manifest : null;
  const projectRoot = prepared ? prepared.projectRoot : (fs.existsSync(flags['project-root']) ? fs.realpathSync(flags['project-root']) : refuse('usage', `--project-root ${flags['project-root']} does not exist`));
  const env = cargoEnvironment(releaseTools(path.resolve(projectRoot, flags.release)));
  const tree = fs.realpathSync(prepared ? prepared.tree : projectRoot);
  const view = workspaceView(tree, env, prepared ? 'the extraction copy' : 'the checkout');
  const { described, metadata } = view;
  const result = {
    message: `${described.crates.length} in-repo package(s), ${described.order.length} with a library`,
    tree,
    workspaceRoot: relativeTo(tree, metadata.workspace_root),
    crates: described.crates,
    order: described.order,
    unlisted: view.unlisted,
    ...(view.outside.length > 0 ? { outside: view.outside.map(({ package: name, manifest }) => ({ package: name, manifest })) } : {}),
  };
  if (!prepared) {
    const inputs = suggestedInputs(tree, metadata, { ...described, unlisted: view.unlisted });
    // A copy holds regular files only: a link the build can read is named in links and has to be
    // replaced or its crate left out; the other links are reported in ignoredLinks and left out of the copy.
    const links = linksUnder(tree, inputs);
    return { ...result, inputs, links: links.blocking, ignoredLinks: links.ignored, ignoredLinkCount: links.ignoredCount };
  }
  // The checkout's own view, for what the patches changed. A checkout cargo cannot read
  // leaves the comparison out, with the reason.
  let original;
  try {
    original = describeWorkspace(projectRoot, cargoMetadata(projectRoot, env, 'the checkout'));
  } catch (error) {
    return { ...result, compared: { available: false, reason: error.message } };
  }
  const key = (row) => row.package;
  const here = new Map(described.rows.map((row) => [key(row), row]));
  const dependencyKey = (row, dependency, base) => `${row.package}|${dependency.name}|${relativeTo(base, realOrSelf(dependency.path))}`;
  const kept = new Set(described.rows.flatMap((row) => pathDependencies(row.item).map((dependency) => dependencyKey(row, dependency, tree))));
  const pathDependenciesRemoved = original.rows.filter((row) => here.has(key(row)))
    .flatMap((row) => pathDependencies(row.item).filter((dependency) => !kept.has(dependencyKey(row, dependency, projectRoot)))
      .map((dependency) => ({ package: row.package, dependency: dependency.name, dir: relativeTo(projectRoot, realOrSelf(dependency.path)) })));
  return {
    ...result,
    compared: {
      available: true,
      packagesNotInCopy: original.rows.filter((row) => !here.has(key(row))).map((row) => ({ package: row.package, dir: row.dir })),
      // A path dependency the patched manifests no longer have: a patch that turns an in-repo
      // crate into a registry one hides it from extraction, so it is named, never silent.
      pathDependenciesRemoved,
    },
  };
}

// A multi-crate attempt: every crate gets an ordinary attempt of its own in
// OUT/units/<crate> (so a failing crate ends only its own chain), all bound to
// the same prepared manifest, and OUT/attempt.json lists them with their hashes.
// Everything is checked before anything is written.
function attemptUnits(out, manifest, manifestSha256, spec) {
  const { units, main, order, nonTargets } = multiUnits(spec, manifest);
  const targets = units.map(({ crate, dir }) => ({ crate, dir }));
  const dropped = checkDropped(spec.dropped);
  const unaccounted = coverageProblems(manifest, { targets, nonTargets, dropped, multi: true });
  if (unaccounted.length > 0) refuse('attempt-refused', `the workspace is not accounted for: ${unaccounted.join('; ')}`, { reasons: unaccounted });
  const homes = homesOf(process.env);
  const unitOut = (unit) => path.join(out, UNITS_DIR, unit.crate);
  for (const unit of units) deriveInvocation(unitOut(unit), manifest, unit.flat, homes, targets, nonTargets);
  const roster = rosterOf({ main, order, units: units.map((unit) => ({ crate: unit.crate, package: unit.package, dir: unit.dir, stitch: (unit.flat.stitch ?? []).map((entry) => entry.crate) })), nonTargets, dropped });
  const recorded = units.map((unit) => {
    fs.mkdirSync(unitOut(unit), { recursive: true });
    return { unit, record: recordAttempt(unitOut(unit), manifest, manifestSha256, unit.flat, targets, nonTargets, roster).attempt };
  });
  const record = {
    schema: MULTI_SCHEMA,
    version: 1,
    out,
    manifestSha256,
    main,
    order,
    roster,
    rosterSha256: rosterSha256(roster),
    ...(dropped.length > 0 ? { dropped } : {}),
    units: recorded.map(({ unit, record: attempt }) => ({
      crate: unit.crate,
      package: unit.package,
      dir: unit.dir,
      imports: (attempt.spec.stitch ?? []).map((entry) => entry.crate),
      out: unitOut(unit),
      attemptSha256: sha256(fs.readFileSync(path.join(unitOut(unit), ATTEMPT))),
      supported: attempt.supported,
    })),
  };
  fs.writeFileSync(path.join(out, ATTEMPT), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  const unsupported = record.units.filter((unit) => !unit.supported).map((unit) => unit.crate);
  return {
    message: `attempt recorded for ${units.length} crate(s) (${unsupported.length === 0 ? 'supported configuration' : `unsupported: ${unsupported.join(', ')}`})`,
    attempt: record,
  };
}

// The multi-crate record of a copy, re-read against the manifest and every
// crate's own attempt record; null when the copy holds a single-crate attempt.
function readMulti(out) {
  const file = path.join(out, ATTEMPT);
  if (!fs.existsSync(file)) return null;
  let record;
  try {
    record = JSON.parse(fs.readFileSync(file));
  } catch {
    refuse('attempt-refused', `${file} is not readable JSON`);
  }
  if (record?.schema !== MULTI_SCHEMA) return null;
  const bad = (message) => refuse('attempt-refused', `${file}: ${message}`);
  if (record.version !== 1 || record.out !== out || !Array.isArray(record.units) || record.units.length === 0) bad('not this copy\'s multi-crate attempt record');
  const { manifestSha256 } = preparedManifest(out);
  if (record.manifestSha256 !== manifestSha256) bad('the manifest changed after the attempt was recorded');
  for (const unit of record.units) {
    if (typeof unit?.crate !== 'string' || !CRATE_NAME.test(unit.crate) || unit.out !== path.join(out, UNITS_DIR, unit.crate)) bad('a unit record does not name a crate directory of this copy');
    const unitFile = path.join(unit.out, ATTEMPT);
    if (!lexists(unitFile) || sha256(fs.readFileSync(unitFile)) !== unit.attemptSha256) bad(`the attempt record of crate ${unit.crate} changed after it was recorded`);
  }
  if (!record.units.some((unit) => unit.crate === record.main)) bad('main is not one of the units');
  checkRoster(out, record, bad);
  return record;
}

// The roster is the attempt's own account of who belongs to it, and it is kept in every unit's
// attempt record, not only in the top-level file. A row deleted from the top-level record, a
// changed main, a different order or a unit directory that is not in the roster leaves the roster
// the units remember different from the one rebuilt here, and the attempt is refused.
function checkRoster(out, record, bad) {
  const same = (first, second) => JSON.stringify(first) === JSON.stringify(second);
  const { roster } = record;
  if (!isObject(roster) || record.rosterSha256 !== rosterSha256(roster) || !Array.isArray(roster.units)) bad('it carries no roster, or the roster does not match its hash; record the attempt again');
  if (!same(roster, rosterOf({ main: roster.main, order: roster.order, units: roster.units, nonTargets: roster.nonTargets, dropped: roster.dropped }))) bad('the roster is not in its canonical form');
  const crates = record.units.map((unit) => unit.crate);
  if (new Set(crates).size !== crates.length) bad('a crate has more than one unit');
  const unitRecords = new Map(record.units.map((unit) => [unit.crate, JSON.parse(fs.readFileSync(path.join(unit.out, ATTEMPT), 'utf8'))]));
  for (const [crate, unitRecord] of unitRecords) {
    if (!same(unitRecord.roster, roster) || unitRecord.rosterSha256 !== record.rosterSha256) bad(`the attempt record of crate ${crate} does not carry this attempt's roster`);
  }
  if (!same([...crates].sort(), roster.units.map((unit) => unit.crate).sort())) bad(`the units (${crates.join(', ')}) are not the crates of the roster (${roster.units.map((unit) => unit.crate).join(', ')})`);
  const directories = fs.readdirSync(path.join(out, UNITS_DIR)).sort();
  if (!same(directories, [...crates].sort())) bad(`the directories under ${UNITS_DIR} (${directories.join(', ')}) are not the crates of the roster`);
  const byCrate = (a, b) => (a.crate < b.crate ? -1 : a.crate > b.crate ? 1 : 0);
  const derived = record.units.map((unit) => {
    const spec = unitRecords.get(unit.crate).spec;
    const at = Array.isArray(spec?.cargoArgs) ? spec.cargoArgs.indexOf('--package') : -1;
    return { crate: unit.crate, rowPackage: unit.package, package: at >= 0 ? spec.cargoArgs[at + 1] : null, dir: unit.dir, stitch: (Array.isArray(spec?.stitch) ? spec.stitch : []).map((entry) => entry?.crate), imports: unit.imports };
  });
  for (const entry of derived) {
    const expected = roster.units.find((candidate) => candidate.crate === entry.crate);
    const unitRecord = unitRecords.get(entry.crate);
    if (unitRecord.spec?.crate !== entry.crate || entry.package !== expected.package || entry.rowPackage !== expected.package || entry.dir !== expected.dir || !same([...entry.stitch].sort(), expected.stitch) || !same([...(entry.imports ?? [])].sort(), expected.stitch)) {
      bad(`the row of crate ${entry.crate} (package ${entry.rowPackage}, directory ${entry.dir}, imports ${(entry.imports ?? []).join(', ') || 'none'}) is not what the roster says (package ${expected.package}, directory ${expected.dir}, stitched to ${expected.stitch.join(', ') || 'nothing'})`);
    }
    if (!same([...(unitRecord.targets ?? [])].sort(byCrate), roster.units.map(({ crate, dir }) => ({ crate, dir })).sort(byCrate)) || !same([...(unitRecord.nonTargets ?? [])].sort(byCrate), roster.nonTargets)) {
      bad(`the declared crates in the attempt record of crate ${entry.crate} are not the roster's`);
    }
  }
  if (record.main !== roster.main) bad(`main is ${record.main}, the roster says ${roster.main}`);
  if (!same((record.dropped ?? []).map(({ crate, reason }) => ({ crate, reason })).sort(byCrate), roster.dropped)) bad('the dropped crates are not the roster\'s');
  let order;
  try {
    order = stitchOrder(record.units.map((unit) => ({ crate: unit.crate, dir: unit.dir, flat: unitRecords.get(unit.crate).spec })));
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    bad(`the stitching order cannot be derived again: ${error.message}`);
  }
  if (!same(order, roster.order) || !same(record.order, roster.order)) bad(`the order ${(record.order ?? []).join(', ')} is not the order derived from the units' stitching (${order.join(', ')})`);
}

function recordAttempt(out, manifest, manifestSha256, spec, targets = [], nonTargets = [], roster = null) {
  const invocation = deriveInvocation(out, manifest, spec, homesOf(process.env), targets, nonTargets);
  const residuals = callerResiduals(process.env, invocation.env.RUSTUP_TOOLCHAIN);
  const cargoConfig = cargoConfigFiles(manifest.tree, invocation.env.CARGO_HOME);
  for (const file of cargoConfig.filter((entry) => entry.present)) residuals.push({ name: file.path, class: 'cargo-config' });
  const credentials = ['credentials', 'credentials.toml'].map((name) => ({ path: path.join(invocation.env.CARGO_HOME, name), present: lexists(path.join(invocation.env.CARGO_HOME, name)) }));
  const identity = identityOf(invocation, out);
  for (const [name, value] of Object.entries(identity)) if (value === null) residuals.push({ name, class: 'toolchain-unresolved' });
  const config = configOf(invocation, identity, cargoConfig, out);
  const record = {
    schema: 'fvs-extract-patches/attempt',
    version: 2,
    out,
    manifestSha256,
    ...(roster === null ? {} : { roster, rosterSha256: rosterSha256(roster) }),
    ...invocation,
    identity,
    cargoConfig,
    credentials,
    residuals,
    supported: residuals.length === 0,
    trust: TRUST,
    config,
    configSha256: sha256(JSON.stringify(config)),
  };
  fs.writeFileSync(path.join(out, ATTEMPT), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  return {
    message: `attempt recorded (${record.supported ? 'supported configuration' : `unsupported: ${residuals.map((r) => `${r.name} (${r.class})`).join(', ')}`})`,
    attempt: record,
  };
}

function stagePaths(out, stage) {
  const base = path.join(out, `stage-${ATTEMPT_STAGES.indexOf(stage) + 1}-${stage}`);
  return { pending: `${base}.pending.json`, completed: `${base}.completed.json`, failed: `${base}.failed.json` };
}

// The attempt as it would execute now must be the attempt as recorded: the
// invocation derived again from the spec, the tool hashes, the cargo
// configuration lookup set (present and absent files) and the toolchain
// identity. Then every stage before `through` must be completed and chained
// (each record names the previous record's hash and the manifest's), and the
// stages from `through` on must have no record at all.
function loadChain(out, through) {
  const attemptFile = path.join(out, ATTEMPT);
  if (!fs.existsSync(attemptFile)) refuse('attempt-refused', `no ${ATTEMPT} in ${out}; record the attempt first`);
  const attemptBytes = fs.readFileSync(attemptFile);
  const record = JSON.parse(attemptBytes);
  if (record?.schema !== 'fvs-extract-patches/attempt' || record.version !== 2 || record.out !== out || record.trust !== TRUST) {
    refuse('attempt-refused', `${attemptFile} is not this copy's version 2 attempt record`);
  }
  const { manifest, manifestSha256 } = preparedManifest(out);
  if (record.manifestSha256 !== manifestSha256) refuse('attempt-refused', 'the manifest changed after the attempt was recorded');
  if (record.roster !== undefined && (!isObject(record.roster) || rosterSha256(record.roster) !== record.rosterSha256)) refuse('attempt-refused', `${attemptFile}: its roster does not match its roster hash`);
  const invocation = deriveInvocation(out, manifest, record.spec, homesOf(record.env ?? {}), Array.isArray(record.targets) ? record.targets : [], Array.isArray(record.nonTargets) ? record.nonTargets : []);
  const differing = INVOCATION_FIELDS.filter((field) => !sameState(invocation[field], record[field]));
  if (differing.length > 0) refuse('attempt-refused', `the recorded ${differing.join(', ')} differ from what the attempt would execute (or a tool changed since it was recorded)`);
  const cargoConfig = cargoConfigFiles(manifest.tree, invocation.env.CARGO_HOME);
  if (!sameState(cargoConfig, record.cargoConfig)) refuse('attempt-refused', 'a cargo configuration file appeared, changed or disappeared since the attempt was recorded');
  const identity = identityOf(invocation, out);
  if (!sameState(identity, record.identity)) refuse('attempt-refused', 'the toolchain identity changed since the attempt was recorded');
  const config = configOf(invocation, identity, cargoConfig, out);
  if (!sameState(config, record.config) || sha256(JSON.stringify(config)) !== record.configSha256) refuse('attempt-refused', 'the attempt configuration does not match what it would execute');
  const owed = [
    ...cargoConfig.filter((entry) => entry.present).map((entry) => entry.path),
    ...Object.entries(identity).filter(([, value]) => value === null).map(([name]) => name),
  ];
  const listed = new Set((Array.isArray(record.residuals) ? record.residuals : []).map((entry) => entry?.name));
  if (owed.some((name) => !listed.has(name)) || record.supported !== (listed.size === 0)) refuse('attempt-refused', 'the attempt\'s supported flag does not follow from its residuals');
  let prevSha256 = sha256(attemptBytes);
  const stages = {};
  ATTEMPT_STAGES.forEach((stage, index) => {
    const files = stagePaths(out, stage);
    const present = Object.keys(files).filter((kind) => lexists(files[kind]));
    if (index < through) {
      if (present.length !== 1 || present[0] !== 'completed') refuse('attempt-refused', `stage ${stage} is ${present.join(' and ') || 'missing'}, not completed`);
      const bytes = fs.readFileSync(files.completed);
      const stageRecord = JSON.parse(bytes);
      if (stageRecord.stage !== stage || stageRecord.prevSha256 !== prevSha256 || stageRecord.manifestSha256 !== manifestSha256) {
        refuse('attempt-refused', `stage ${stage}'s record does not chain to the previous record and the manifest`);
      }
      prevSha256 = sha256(bytes);
      stages[stage] = { record: stageRecord, sha256: prevSha256 };
    } else if (present.length > 0) {
      refuse('attempt-refused', `stage ${stage} already has a ${present.join(' and ')} record; a retry needs a new prepared copy`);
    }
  });
  return { attempt: record, invocation, manifest, attemptSha256: sha256(attemptBytes), prevSha256, manifestSha256, stages };
}

// Every entry under a directory with its type: files with hash and mode, links
// as links, directories as directories, anything else as other.
function entriesUnder(root) {
  const entries = {};
  (function visit(relative) {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const child = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(path.join(root, child));
      if (stat.isDirectory()) {
        entries[child] = { type: 'directory' };
        visit(child);
      } else {
        entries[child] = fileState(path.join(root, child));
      }
    }
  })('');
  return entries;
}

const ancestors = (file) => file.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'));
const fileHashes = (entries) => Object.fromEntries(Object.entries(entries).filter(([, state]) => state?.sha256 !== undefined).map(([file, state]) => [file, state.sha256]));

// The entries are exactly the given files plus the directories that hold them.
function exactlyFiles(entries, files) {
  const dirs = new Set(Object.keys(files).flatMap(ancestors));
  const sorted = (map) => Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sameState(sorted(fileHashes(entries)), sorted(files))
    && Object.entries(entries).every(([entry, state]) => state?.sha256 !== undefined || (state?.type === 'directory' && dirs.has(entry)));
}

// The declared crate whose directory is the longest prefix of a file of the copy.
function ownerOf(crates, file) {
  let best = null;
  for (const candidate of crates) {
    const holds = candidate.dir === '.' || file === candidate.dir || file.startsWith(`${candidate.dir}/`);
    if (holds && (best === null || (candidate.dir !== '.' && (best.dir === '.' || candidate.dir.length > best.dir.length)))) best = candidate;
  }
  return best;
}

// The crates an LLBC reaches, from the first segment of every item's path.
function reachedCrates(translated) {
  const names = new Set();
  for (const kind of LLBC_ITEM_KINDS) {
    for (const decl of Array.isArray(translated?.[kind]) ? translated[kind] : []) {
      const first = Array.isArray(decl?.item_meta?.name) ? decl.item_meta.name[0]?.Ident?.[0] : undefined;
      if (typeof first === 'string') names.add(first);
    }
  }
  return names;
}

// The crates the toolchain provides. Charon labels a file with the crate it belongs to, and a source
// of the standard library need not lie in the directory named for that crate (core's vendored
// stdarch sits under library/stdarch).
const TOOLCHAIN_CRATES = new Set(['core', 'alloc', 'std', 'proc_macro', 'test']);

// The packages of a Cargo.lock by the `<name>-<version>` directory cargo unpacks a package into.
function lockPackages(text) {
  const byDirectory = new Map();
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"/m.exec(block)?.[1];
    const source = /^source = "([^"]+)"/m.exec(block)?.[1] ?? null;
    if (name && version) byDirectory.set(`${name}-${version}`, { name, version, source });
  }
  return byDirectory;
}

// What one file of the LLBC is, from the path Charon wrote (the forms of real Charon 0.1.315 output):
// a path relative to the copy (or absolute, under it) is a file of the copy; /rustc/library/... is
// the toolchain; <cargo home>/registry/src/<index>/<name>-<version>/... is a registry package. Any
// other form (a Virtual or NotReal name, a path elsewhere, a git checkout, a build-script output)
// has not been checked against real output and is named in a refusal.
function llbcPathClass(name, treeRoots) {
  const keys = isObject(name) ? Object.keys(name) : [];
  if (keys.length !== 1 || keys[0] !== 'Local' || typeof name.Local !== 'string' || name.Local === '') {
    return { form: 'unsurveyed', shown: keys.length === 1 ? `a ${keys[0]} name` : JSON.stringify(name) };
  }
  const normal = path.posix.normalize(name.Local);
  if (!path.posix.isAbsolute(normal)) {
    return normal === '..' || normal.startsWith('../') ? { form: 'outside', shown: name.Local } : { form: 'tree', relative: normal };
  }
  for (const root of treeRoots) if (normal.startsWith(`${root}/`)) return { form: 'tree', relative: normal.slice(root.length + 1) };
  if (/^\/rustc\/(?:[0-9a-f]{40}\/)?library\//.test(normal)) return { form: 'toolchain' };
  const registry = /\/registry\/src\/[^/]+\/([^/]+)\/.+$/.exec(normal);
  if (registry) return { form: 'registry', directory: registry[1] };
  return { form: 'outside', shown: name.Local };
}

const LLBC_ITEM_KINDS = ['fun_decls', 'type_decls', 'global_decls', 'trait_decls', 'trait_impls'];
const MAX_ERROR_ITEMS = 200;

// Charon can exit 0 and still flag items it could not translate: the LLBC's own
// has_errors flag, and has_errors on each item. The names are recorded, never dropped.
function llbcErrorItems(llbc, translated) {
  const items = [];
  for (const kind of LLBC_ITEM_KINDS) {
    for (const decl of Array.isArray(translated?.[kind]) ? translated[kind] : []) {
      if (decl?.item_meta?.has_errors !== true) continue;
      const name = Array.isArray(decl.item_meta.name) ? decl.item_meta.name.map((part) => (Array.isArray(part?.Ident) ? part.Ident[0] : '{impl}')).join('::') : '?';
      items.push(`${kind.replace(/_decls$|s$/, '')} ${name}`);
    }
  }
  return { hasErrors: llbc?.has_errors === true || items.length > 0, items: items.slice(0, MAX_ERROR_ITEMS), itemCount: items.length };
}

// Structural problems in Charon's LLBC that the identity record relies on, and
// what the record keeps about it. For one crate every source of the copy must be
// labelled with that crate and carry its exact contents. With declared crates
// (targets), Charon nulls the contents of every crate that is not the main one, so
// a source under another declared crate may carry no contents, but it must be
// labelled with its owner; its bytes are pinned by the recorded tree (verify-tree
// ran before and after Charon) and checked exactly by that crate's own attempt.
// A source under no declared crate, or labelled with another crate, is refused.
function inspectLlbc(file, invocation, sources) {
  let llbc;
  try {
    llbc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { problems: [`the LLBC is not readable JSON: ${error.message}`], info: null };
  }
  const translated = llbc?.translated;
  const problems = [];
  if (typeof llbc?.charon_version !== 'string') problems.push('the LLBC records no charon_version');
  if (translated?.options?.dest_file !== invocation.llbc) problems.push('the LLBC names another output path');
  if (translated?.crate_name !== invocation.crate) problems.push(`the LLBC is for crate ${JSON.stringify(translated?.crate_name)}, not ${JSON.stringify(invocation.crate)}`);
  const files = Array.isArray(translated?.files) ? translated.files : null;
  const decls = Array.isArray(translated?.fun_decls) ? translated.fun_decls.filter((decl) => decl !== null) : null;
  if (!files || !decls) return { problems: [...problems, 'the LLBC has no files or fun_decls list'], info: null };
  const ids = files.map((entry) => entry?.id);
  if (ids.some((id) => !Number.isInteger(id)) || new Set(ids).size !== ids.length) problems.push('the LLBC file ids are not unique integers');
  const defIds = decls.map((decl) => decl?.def_id);
  if (defIds.some((id) => !Number.isInteger(id)) || new Set(defIds).size !== defIds.length) problems.push('the LLBC fun_decls def_ids are not unique integers');
  const targets = invocation.targets ?? [];
  const nonTargets = invocation.nonTargets ?? [];
  const declared = [...targets.map((entry) => ({ ...entry, kind: 'target' })), ...nonTargets.map((entry) => ({ ...entry, kind: 'non-target' }))];
  const foreign = [];
  const nonTargetSources = [];
  if (targets.length === 0 && files.some((entry) => entry?.crate_name === invocation.crate && typeof entry?.name?.Local === 'string' && typeof entry.contents !== 'string')) {
    problems.push('a local source file in the LLBC has no contents');
  }
  const exact = (entry, name) => typeof entry.contents === 'string' && sha256(entry.contents) === sources[name]?.sha256;
  const treeRoots = [...new Set([invocation.tree, realOrSelf(invocation.tree)].filter((root) => typeof root === 'string'))];
  const lock = lockPackages(fs.existsSync(path.join(invocation.tree, LOCK_FILE)) ? fs.readFileSync(path.join(invocation.tree, LOCK_FILE), 'utf8') : '');
  const externals = new Map();
  // Every file of the LLBC lands in exactly one class or the stage fails: a file of the prepared copy,
  // the toolchain, or a package of the Cargo.lock. Nothing is skipped for lying outside the copy.
  for (const entry of files) {
    const label = JSON.stringify(entry?.crate_name);
    const kind = llbcPathClass(entry?.name, treeRoots);
    if (kind.form === 'toolchain') {
      if (!TOOLCHAIN_CRATES.has(entry.crate_name)) problems.push(`the LLBC reads a toolchain source file ${entry.name.Local} but labels it with crate ${label}, which is not a crate of the toolchain`);
      else externals.set(entry.crate_name, { origin: 'toolchain' });
      continue;
    }
    if (kind.form === 'registry') {
      const locked = lock.get(kind.directory);
      if (!locked || typeof locked.source !== 'string' || !locked.source.startsWith('registry+')) problems.push(`the LLBC reads ${entry.name.Local} (crate ${label}), but ${kind.directory} is not a registry package of the ${LOCK_FILE} in the copy`);
      else if (typeof entry.crate_name === 'string') externals.set(entry.crate_name, { origin: 'registry', package: locked.name, version: locked.version });
      continue;
    }
    if (kind.form === 'outside') {
      problems.push(`the LLBC reads ${kind.shown} (crate ${label}), which lies outside the extraction copy and is neither the toolchain nor a registry package: another tree, or a file Charon found by an absolute path`);
      continue;
    }
    if (kind.form === 'unsurveyed') {
      problems.push(`the LLBC names a source file as ${kind.shown} (crate ${label}); this form has not been checked against real Charon output, so the file cannot be pinned`);
      continue;
    }
    const name = kind.relative;
    if (!Object.hasOwn(sources, name)) {
      problems.push(`the LLBC reads ${name} (crate ${label}), which is not a file of the prepared copy: an input missing from extraction.inputs, or a file made by a build`);
      continue;
    }
    if (targets.length === 0) {
      if (entry.crate_name !== invocation.crate) problems.push(`the LLBC labels ${name} with crate ${JSON.stringify(entry.crate_name)}, not ${JSON.stringify(invocation.crate)}`);
      if (!exact(entry, name)) problems.push(`the LLBC's ${name} is not the prepared source`);
      continue;
    }
    const holder = ownerOf(declared, name);
    const owner = holder?.crate ?? null;
    if (entry.crate_name === invocation.crate) {
      if (owner !== invocation.crate) problems.push(`the LLBC labels ${name} with crate ${JSON.stringify(invocation.crate)}, but the file lies under ${owner === null ? 'no declared crate' : `crate ${JSON.stringify(owner)}`}`);
      else if (!exact(entry, name)) problems.push(`the LLBC's ${name} is not the prepared source`);
    } else if (owner !== null && entry.crate_name === owner) {
      if (entry.contents !== null && entry.contents !== undefined && !exact(entry, name)) problems.push(`the LLBC's ${name} is not the prepared source`);
      else (holder.kind === 'target' ? foreign : nonTargetSources).push({ crate: owner, file: name, sha256: sources[name].sha256 });
    } else {
      problems.push(`the LLBC labels ${name} with crate ${JSON.stringify(entry.crate_name)}, but the file lies under ${owner === null ? 'no declared crate, so it is an in-repo crate nobody declared as a target or as a non-target' : `declared crate ${JSON.stringify(owner)}`}`);
    }
  }
  const byFile = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  // A crate that is not declared is external only when the toolchain or a package of the Cargo.lock
  // stands behind it; a crate the LLBC reaches that none of them explains is refused, never filed
  // as external. The library name Charon writes can differ from the package name by more than hyphens,
  // so a registry crate is tied to the lock through its source path when it has one.
  const lockedNames = new Set([...lock.values()].map((locked) => locked.name.replace(/-/g, '_')));
  const foreignCrates = [...reachedCrates(translated)].filter((crate) => crate !== invocation.crate).sort().map((crate) => {
    if (targets.some((entry) => entry.crate === crate)) return { crate, kind: 'target' };
    if (nonTargets.some((entry) => entry.crate === crate)) return { crate, kind: 'non-target' };
    const known = externals.get(crate) ?? (TOOLCHAIN_CRATES.has(crate) ? { origin: 'toolchain' } : lockedNames.has(crate) ? { origin: 'registry' } : null);
    if (known === null) {
      problems.push(`the LLBC reaches crate ${crate}, which is not a declared crate, the toolchain or a package of the ${LOCK_FILE} in the copy`);
      return { crate, kind: 'external', origin: 'unknown' };
    }
    return { crate, kind: 'external', ...known };
  });
  return { problems, info: { crate: translated.crate_name, ...llbcErrorItems(llbc, translated), foreignSources: foreign.sort(byFile), nonTargetSources: nonTargetSources.sort(byFile), foreignCrates } };
}

function beginStage(chain, stage) {
  const files = stagePaths(chain.attempt.out, stage);
  fs.writeFileSync(files.pending, `${JSON.stringify({ stage, prevSha256: chain.prevSha256, manifestSha256: chain.manifestSha256 }, null, 2)}\n`, { flag: 'wx' });
  return files;
}

// A stage ends completed only with no reasons; otherwise it is recorded as failed
// and the attempt is over. A crash leaves the pending record, which blocks it too.
function settle(files, record, reasons) {
  const final = reasons.length === 0 ? record : { ...record, reasons };
  fs.writeFileSync(files.pending, `${JSON.stringify(final, null, 2)}\n`);
  fs.renameSync(files.pending, reasons.length === 0 ? files.completed : files.failed);
  if (reasons.length > 0) refuse('tool-failed', `stage ${record.stage} failed: ${reasons.join('; ')}`, { reasons });
  return { message: `stage ${record.stage} completed`, record: final };
}

function runTool(file, argv, cwd, env, log) {
  const fd = fs.openSync(log, 'wx');
  try {
    const run = spawnSync(file, argv, { cwd, env, stdio: ['ignore', fd, fd] });
    return { exitCode: run.status, signal: run.signal, error: run.error ? run.error.code ?? run.error.message : null };
  } finally {
    fs.closeSync(fd);
  }
}

function toolReasons(name, run) {
  return [
    run.error && `${name} could not run (${run.error})`,
    run.signal && `${name} was killed by ${run.signal}`,
    run.exitCode !== 0 && run.exitCode !== null && `${name} exited ${run.exitCode}`,
  ].filter(Boolean);
}

// The first few lines of a tool's log that state an error, each cut short: what a person
// needs to classify a failed build (a lock cargo cannot satisfy, a missing manifest, a
// compile error) without opening the log. The full log stays on disk and is hashed.
const LOG_ERROR_LINES = 5;
const LOG_LINE_LENGTH = 200;
function logErrors(log) {
  const lines = fs.readFileSync(log, 'utf8').split('\n').map((line) => line.trim()).filter((line) => /^error(\[[A-Za-z0-9]+\])?:/.test(line));
  const shown = lines.slice(0, LOG_ERROR_LINES).map((line) => (line.length > LOG_LINE_LENGTH ? `${line.slice(0, LOG_LINE_LENGTH)}...` : line));
  return lines.length > shown.length ? [...shown, `(${lines.length - shown.length} more error line(s) in the log)`] : shown;
}

function stageBase(chain, stage) {
  return { stage, prevSha256: chain.prevSha256, manifestSha256: chain.manifestSha256 };
}

function runCharon(chain) {
  const inv = chain.invocation;
  const { out } = chain.attempt;
  if (lexists(inv.llbc)) refuse('attempt-refused', `${inv.llbc} already exists; the LLBC must be produced by this attempt`);
  const copy = copyRoot(out);
  verifyTree({ out: copy });
  const files = beginStage(chain, 'charon');
  const log = path.join(out, 'charon.log');
  const run = runTool(inv.tools.charon.path, inv.charon.argv, inv.charon.cwd, inv.env, log);
  const reasons = toolReasons('Charon', run);
  if (reasons.length > 0) reasons.push(...logErrors(log).map((line) => `Charon's log: ${line}`));
  try {
    verifyTree({ out: copy });
  } catch (error) {
    reasons.push(`verify-tree after Charon: ${error.message}`);
  }
  const llbc = fileState(inv.llbc);
  let info = null;
  if (!llbc?.sha256) reasons.push(`Charon produced no LLBC file at ${inv.llbc}`);
  else if (reasons.length === 0) {
    const checked = inspectLlbc(inv.llbc, inv, chain.manifest.final.files);
    reasons.push(...checked.problems);
    info = checked.info;
  }
  return settle(files, { ...stageBase(chain, 'charon'), run, logSha256: fileState(log).sha256, llbcSha256: llbc?.sha256 ?? null, llbc: info }, reasons);
}

// The Lean files translation.json names. Every local function must name one, and
// every name must be a relative .lean path; otherwise the output set is unknown.
function translationLeanFiles(file) {
  const translation = JSON.parse(fs.readFileSync(file, 'utf8'));
  const isLeanPath = (value) => typeof value === 'string' && value.endsWith('.lean') && !path.posix.isAbsolute(value)
    && path.posix.normalize(value) === value && !value.split('/').includes('..');
  const names = new Set();
  for (const key of ['functions', 'types', 'globals', 'trait_decls', 'trait_impls']) {
    for (const entry of Array.isArray(translation[key]) ? translation[key] : []) {
      const local = key === 'functions' && entry?.is_local === true;
      if (entry?.lean_file === undefined && !local) continue;
      if (!isLeanPath(entry?.lean_file)) throw new Error(`a ${key} entry${local ? ' for a local function' : ''} names no relative .lean path as its lean_file`);
      names.add(entry.lean_file);
    }
  }
  if (names.size === 0) throw new Error('translation.json names no generated Lean file');
  return [...names].sort();
}

function runAeneas(chain) {
  const inv = chain.invocation;
  const { out } = chain.attempt;
  const charon = chain.stages.charon.record;
  if (fileState(inv.llbc)?.sha256 !== charon.llbcSha256) refuse('attempt-refused', 'the LLBC differs from the one the Charon stage recorded');
  try {
    fs.mkdirSync(inv.aeneasDest);
  } catch {
    refuse('attempt-refused', `${inv.aeneasDest} already exists; Aeneas writes only into a fresh empty directory`);
  }
  const files = beginStage(chain, 'aeneas');
  const log = path.join(out, 'aeneas.log');
  const run = runTool(inv.tools.aeneas.path, inv.aeneas.argv, inv.aeneas.cwd, inv.env, log);
  const reasons = toolReasons('Aeneas', run);
  if (fileState(inv.llbc)?.sha256 !== charon.llbcSha256) reasons.push('the LLBC changed while Aeneas ran');
  const entries = entriesUnder(inv.aeneasDest);
  const outputs = fileHashes(entries);
  let translationSha256 = null;
  if (!outputs['translation.json']) {
    reasons.push('Aeneas produced no translation.json');
  } else {
    translationSha256 = outputs['translation.json'];
    try {
      const named = translationLeanFiles(path.join(inv.aeneasDest, 'translation.json'));
      const missing = named.filter((file) => !outputs[file]);
      if (missing.length > 0) reasons.push(`files translation.json names are missing: ${missing.join(', ')}`);
      const expected = Object.fromEntries(['translation.json', ...named].filter((file) => outputs[file]).map((file) => [file, outputs[file]]));
      if (!exactlyFiles(entries, expected)) {
        const extra = Object.keys(entries).filter((entry) => !Object.hasOwn(expected, entry) && !Object.keys(expected).flatMap(ancestors).includes(entry));
        reasons.push(`entries outside the expected output set: ${extra.join(', ')}`);
      }
    } catch (error) {
      reasons.push(`translation.json is unreadable: ${error.message}`);
    }
  }
  return settle(files, { ...stageBase(chain, 'aeneas'), run, logSha256: fileState(log).sha256, llbcSha256: charon.llbcSha256, outputs, translationSha256 }, reasons);
}

// The whole publication, checked before any write: every entry in the
// destination, with its type, against the outputs and the control files. The
// destination may hold only files an earlier publication owns, unmodified, the
// directories that hold them, and the ownership record; this attempt must
// produce every owned file again. Publication never deletes or overwrites
// anything else.
function publicationPlan(inv, outputs, sources = {}) {
  const { publishDir, projectRoot } = inv;
  refuseLinkedDirectory(projectRoot, path.relative(projectRoot, publishDir));
  const stat = fs.lstatSync(publishDir, { throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) refuse('publication-refused', `${publishDir} is not a directory`, { reason: 'occupied' });
  const existing = stat ? entriesUnder(publishDir) : {};
  const produced = Object.keys(outputs).sort();
  const reserved = [OWNERSHIP, PUBLICATION_PENDING];
  const reject = (message, details) => refuse('publication-refused', message, details);
  if (Object.hasOwn(existing, PUBLICATION_PENDING)) reject(`a pending publication marker exists in ${publishDir}; an earlier publication did not finish and needs a human`, { reason: 'pending' });
  for (const file of produced) if (reserved.includes(file) || file.split('/').some((part) => reserved.includes(part))) reject(`${file} collides with a publication control file`, { path: file, reason: 'reserved' });
  let owned = {};
  if (Object.hasOwn(existing, OWNERSHIP)) {
    if (existing[OWNERSHIP]?.sha256 === undefined) reject(`${OWNERSHIP} in ${publishDir} is not a regular file`, { path: OWNERSHIP, reason: 'occupied' });
    try {
      owned = JSON.parse(fs.readFileSync(path.join(publishDir, OWNERSHIP), 'utf8')).files;
    } catch {
      reject(`${OWNERSHIP} in ${publishDir} is unreadable`, { path: OWNERSHIP, reason: 'unreadable' });
    }
    if (owned === null || typeof owned !== 'object' || Array.isArray(owned)) reject(`${OWNERSHIP} in ${publishDir} records no files`, { path: OWNERSHIP, reason: 'unreadable' });
  }
  const holders = new Set(produced.flatMap(ancestors));
  for (const [entry, state] of Object.entries(existing)) {
    if (entry === OWNERSHIP) continue;
    if (state?.type === 'directory') {
      if (!holders.has(entry)) reject(`${entry} in ${publishDir} is a directory no output needs; publication never touches it`, { path: entry, reason: produced.includes(entry) ? 'occupied' : 'unowned' });
      continue;
    }
    if (state?.sha256 === undefined) reject(`${entry} in ${publishDir} is not a regular file`, { path: entry, reason: 'occupied' });
    if (holders.has(entry)) reject(`${entry} in ${publishDir} is a file where an output needs a directory`, { path: entry, reason: 'occupied' });
    if (!Object.hasOwn(owned, entry)) reject(`${entry} in ${publishDir} is not owned by an earlier publication; publication never overwrites it`, { path: entry, reason: 'unowned' });
    if (state.sha256 !== owned[entry]) reject(`${entry} in ${publishDir} changed since it was published`, { path: entry, reason: 'modified' });
  }
  for (const file of Object.keys(owned)) {
    if (!existing[file]) reject(`${file} is recorded as published but is missing from ${publishDir}`, { path: file, reason: 'missing-owned' });
    if (!produced.includes(file)) reject(`${file} was published earlier but this attempt does not produce it; publication never deletes, remove it explicitly`, { path: file, reason: 'stale' });
  }
  const folded = new Map();
  for (const entry of [...new Set([...produced, ...holders, ...reserved, ...Object.keys(existing)])]) {
    const key = entry.toLowerCase();
    if (folded.has(key) && folded.get(key) !== entry) reject(`${entry} and ${folded.get(key)} differ only in case`, { reason: 'case-collision' });
    folded.set(key, entry);
  }
  return produced.map((file) => ({ attemptPath: sources[file] ?? path.join(inv.aeneasDest, file), projectPath: path.join(publishDir, file), sha256: outputs[file] }));
}

// ---- Edits to the generated Lean ------------------------------------------------------
//
// Two declared, recorded edits turn the Aeneas output into the published Lean: the exact
// text substitutions of the spec, then stitching to the crates whose real translation
// replaces this crate's axioms. Both are a pure function of the Aeneas outputs and the
// spec, so attempt-status computes them again and compares with what publication wrote.
//
// Stitching. When crate B calls crate A and A is a target, Aeneas still writes B's
// foreign items of A as axioms that carry only a type. Each such axiom becomes an alias
// of A's real definition, with the type B's code was translated against, and B's Lean
// imports A's module:
//
//   axiom A.f : T            ==>   @[reducible] def A.f : T := _root_.A.f
//
// The alias keeps every existing name valid, and Lean itself is the signature gate: a
// constant whose type is not T is rejected when the project builds. A foreign global is
// typed `Result T` where the crate's own global is `T`, so a constant is lifted with
// Result.ok, and is an ordinary (not reducible) definition so that proof automation
// keeps seeing the constant. Nothing falls back to an axiom silently: an item the provider does not
// define must be named in the spec's `assume` list, and is then recorded as assumed.

const OPENERS = '({[⦃';
const CLOSERS = ')}]⦄';
const squash = (text) => text.replace(/\s+/g, ' ').trim();
const countOf = (text, needle) => text.split(needle).length - 1;
const isRustItem = (rustPath, prefix) => rustPath === prefix || rustPath.startsWith(`${prefix}::`);

// A substitution renames a name Lean cannot read (see UNREADABLE_NAME_CHARS), which is not
// a change of meaning: the old name is not valid Lean, every match is replaced, the new name
// is plain and occurs nowhere in the crate's generated Lean (so it captures nothing and no
// existing name is confused with it), and no match is a field or a qualified-name component
// (a match after a `.`). A rename can still only be made inside a definition's body. Axiom
// declarations (name, type, attributes, the doc comment that carries the Rust path), the
// name and type of every definition and every other top-level line stay exactly as Aeneas
// wrote them, so a literal edit cannot add, retype or relabel an assumption, or reword what
// a definition claims. The generated file is cut into top-level blocks (a block starts at a
// doc comment, an attribute or a declaration keyword in column 0); a definition or theorem
// block is split at its first top-level `:=` into a head, which is fixed, and a body, which
// is free; every other block is fixed whole.
const BLOCK_START = /^(?:\/--|@\[|(?:noncomputable\s+)?(?:def|axiom|theorem|lemma|structure|inductive|abbrev|opaque|class|instance|namespace|end|open|set_option|section|attribute|import|public)\b)/;
const KEYWORD_LINE = /^(?:noncomputable\s+)?(def|axiom|theorem|lemma|structure|inductive|abbrev|opaque|class|instance)\b/;
const BODY_KEYWORDS = new Set(['def', 'theorem', 'lemma', 'abbrev', 'instance']);

function leanBlocks(text) {
  const blocks = [];
  let current = null;
  for (const line of text.split('\n')) {
    const keyword = KEYWORD_LINE.exec(line);
    const starts = BLOCK_START.test(line) && (current === null || (/^\/--/.test(line) ? current.text !== '' && (current.keyword !== null || !current.doc) : current.keyword !== null || /^(?:namespace|end|open|set_option|section|attribute|import|public)\b/.test(line)));
    if (current === null || starts) {
      current = { text: '', keyword: null, doc: false };
      blocks.push(current);
    }
    if (/^\/--/.test(line)) current.doc = true;
    if (keyword && current.keyword === null) current.keyword = { word: keyword[1], offset: current.text.length };
    current.text += `${current.text === '' ? '' : '\n'}${line}`;
  }
  return blocks.map((block) => {
    const name = DECLARATION.exec(block.text.slice(block.keyword?.offset ?? 0))?.[2] ?? null;
    const found = block.keyword && BODY_KEYWORDS.has(block.keyword.word)
      ? topLevel(block.text.slice(block.keyword.offset), [':='])[0]
      : undefined;
    const end = found === undefined ? null : block.keyword.offset + found.index + 2;
    return { text: block.text, name, axiom: block.keyword?.word === 'axiom', head: end === null ? null : block.text.slice(0, end), body: end === null ? null : block.text.slice(end) };
  });
}

function declarationProblems(before, after) {
  const was = leanBlocks(before);
  const now = leanBlocks(after);
  if (was.length !== now.length) return ['it changes the number of top-level declarations'];
  for (let index = 0; index < was.length; index += 1) {
    const [a, b] = [was[index], now[index]];
    const free = a.head !== null && b.head !== null;
    if (free ? a.head === b.head : a.text === b.text) continue;
    if (a.axiom || b.axiom) return [`it changes the axiom ${a.name ?? b.name}, and a substitution never edits an axiom`];
    return [free ? `it changes the name or type of ${a.name ?? b.name}, and a substitution edits only the body of a definition` : `it changes text outside a definition body (${JSON.stringify(a.text.split('\n')[0].slice(0, 60))})`];
  }
  return [];
}

function applySubstitutions(file, text, substitutions, world = {}) {
  const applied = [];
  const reasons = [];
  let current = text;
  substitutions.forEach((entry, index) => {
    if (entry.file !== file) return;
    const found = countOf(current, entry.find);
    if (found !== entry.count) {
      reasons.push(`substitution ${index} expects ${entry.count} match(es) of ${JSON.stringify(entry.find)} in ${file} and finds ${found}`);
      return;
    }
    const taken = [[file, current], ...Object.entries(world)].find(([, other]) => other.includes(entry.replace));
    if (taken) {
      reasons.push(`substitution ${index} is refused in ${file}: ${JSON.stringify(entry.replace)} already occurs in ${taken[0]}, so the renamed name could capture an existing one`);
      return;
    }
    if (current.split(entry.find).slice(0, -1).some((piece) => piece.endsWith('.'))) {
      reasons.push(`substitution ${index} is refused in ${file}: a match of ${JSON.stringify(entry.find)} follows a '.', and a substitution never renames a field or a part of a qualified name`);
      return;
    }
    const next = current.split(entry.find).join(entry.replace);
    const problems = declarationProblems(current, next);
    if (problems.length > 0) {
      reasons.push(`substitution ${index} is refused in ${file}: ${problems[0]}`);
      return;
    }
    applied.push({ index, file, find: entry.find, replace: entry.replace, count: entry.count, reason: entry.reason, beforeSha256: sha256(current), afterSha256: sha256(next) });
    current = next;
  });
  return { text: current, applied, reasons };
}

function topLevel(text, tokens) {
  const found = [];
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (OPENERS.includes(char)) depth += 1;
    else if (CLOSERS.includes(char)) depth -= 1;
    else if (depth === 0) {
      const token = tokens.find((candidate) => text.startsWith(candidate, index));
      if (token) {
        found.push({ index, token });
        index += token.length - 1;
      }
    }
  }
  return found;
}

// The binder groups and the type after a declaration's name, up to a top-level `:=`.
function readSignature(rest) {
  let at = 0;
  const skip = () => { while (at < rest.length && /\s/.test(rest[at])) at += 1; };
  const binders = [];
  skip();
  while (at < rest.length && OPENERS.includes(rest[at])) {
    const start = at;
    let depth = 0;
    for (; at < rest.length; at += 1) {
      if (OPENERS.includes(rest[at])) depth += 1;
      else if (CLOSERS.includes(rest[at])) {
        depth -= 1;
        if (depth === 0) { at += 1; break; }
      }
    }
    if (depth !== 0) return null;
    binders.push(rest.slice(start, at));
    skip();
  }
  if (rest[at] !== ':' || rest[at + 1] === '=') return null;
  const body = rest.slice(at + 1);
  const stop = topLevel(body, [':=']).at(0)?.index ?? body.length;
  return { binders, type: body.slice(0, stop).trim() };
}

// A declaration's signature as implicit binders, explicit domains and a result, with
// every identifier that names a declaration of the file spelled in full. Null when the
// shape is not one this check reads (a dependent type): Lean then decides at build time.
function normalSignature(rest, qualify) {
  const parsed = readSignature(rest);
  if (parsed === null) return null;
  const implicit = [];
  const domains = [];
  for (const group of parsed.binders) {
    if (group[0] !== '(') { implicit.push(qualify(squash(group))); continue; }
    const inner = /^\(\s*([^:]+?)\s*:\s*([\s\S]*)\)$/.exec(group);
    if (inner === null) return null;
    const others = `${parsed.type} ${parsed.binders.filter((other) => other !== group).join(' ')}`;
    const names = inner[1].split(/\s+/);
    if (names.some((name) => new RegExp(`(^|[^A-Za-z0-9_'.])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_'.])`).test(others))) return null;
    for (let count = 0; count < names.length; count += 1) domains.push(qualify(squash(inner[2])));
  }
  const cuts = topLevel(parsed.type, ['→', '->']);
  const parts = [];
  let from = 0;
  for (const cut of cuts) { parts.push(parsed.type.slice(from, cut.index)); from = cut.index + cut.token.length; }
  parts.push(parsed.type.slice(from));
  if (parts.some((part) => /^\(\s*[^()]*:/.test(part.trim()) || /[∀Π]/.test(part))) return null;
  return { implicit, domains: [...domains, ...parts.slice(0, -1).map((part) => qualify(squash(part)))], result: qualify(squash(parts.at(-1))) };
}

function balanced(text) {
  let depth = 0;
  for (const char of text) {
    if (OPENERS.includes(char)) depth += 1;
    else if (CLOSERS.includes(char)) depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

// Removes parentheses that wrap the whole text.
function unwrap(text) {
  let value = text.trim();
  while (value.startsWith('(') && value.endsWith(')') && balanced(value.slice(1, -1))) value = value.slice(1, -1).trim();
  return value;
}

// 'equal', 'differ' or 'undecided'. Only a decided difference refuses early; the Lean
// build is the check for everything else, and the record says which one ran.
function compareSignatures(consumer, provider, lift) {
  if (consumer === null || provider === null) return 'undecided';
  const result = lift ? unwrap(consumer.result.replace(/^Result\s+/, '')) : consumer.result;
  const expected = lift ? unwrap(provider.result) : provider.result;
  if (lift && !/^Result\s/.test(consumer.result)) return 'differ';
  const same = JSON.stringify([consumer.implicit, consumer.domains, result]) === JSON.stringify([provider.implicit, provider.domains, expected]);
  return same ? 'equal' : 'differ';
}

// A declaration name stops at a delimiter; explicit universe parameters (`name.{u}`) are not part of it.
const DECLARATION = /^(?:noncomputable\s+)?(def|axiom|structure|inductive|abbrev|opaque|class)\s+([^\s:({[⦃]+?)(?:\.\{[^}]*\})?(?=[\s:({[⦃]|$)([\s\S]*)$/m;
const DOC_PATH = /^\/-- (?:Trait declaration: |Trait implementation: )?\[(.*)\]/;
const RUST_ATTRIBUTE = /\b(rust_fun|rust_const|rust_type)\s+"([^"]+)"/;

// The declarations of a crate's Lean by their full name. A name declared twice is reported, never
// overwritten: the inventory would otherwise bind to whichever copy came last.
function leanDeclarations(texts, crate) {
  const declarations = new Map();
  const duplicates = new Set();
  for (const text of texts) {
    for (const block of text.split(/\n{2,}/)) {
      if (!block.startsWith('/--')) continue;
      const found = DECLARATION.exec(block);
      if (found === null) continue;
      const key = `${crate}.${found[2]}`;
      if (declarations.has(key)) {
        duplicates.add(found[2]);
        continue;
      }
      declarations.set(key, { keyword: found[1], rustPath: DOC_PATH.exec(block)?.[1] ?? null, rest: found[3], blockSha256: sha256(block) });
    }
  }
  return { declarations, duplicates: [...duplicates].sort() };
}

// The crate whose published Lean this crate imports. What counts is the provider's final
// publication, with its substitutions and its own stitching applied: that is the module Lean
// loads, so its inventory and hashes come from there and never from the raw Aeneas output. The
// provider's whole chain must be completed and consistent first (every stage recorded, the
// published files as recorded, the edits reproducing), which is why a crate is published after
// the crates it stitches to.
function loadProvider(chain, crate) {
  const dir = path.join(copyRoot(chain.attempt.out), UNITS_DIR, crate);
  const bad = (message) => refuse('attempt-refused', `stitching to crate ${crate}: ${message}`);
  if (!lexists(path.join(dir, ATTEMPT))) bad('it has no attempt record in this copy');
  for (const stage of ATTEMPT_STAGES) {
    if (!lexists(stagePaths(dir, stage).completed)) bad(`its ${stage} stage is not completed; run that crate through publish first, because this crate imports what it published`);
  }
  let provider;
  try {
    provider = loadChain(dir, ATTEMPT_STAGES.length);
    attemptStatusOfChain(provider, dir);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    bad(`its attempt is not consistent (${error.message}), so what it published is not a binding translation`);
  }
  const record = provider.attempt;
  const root = record.spec.moduleRoot;
  if (root === undefined) bad('it names no moduleRoot');
  const names = translationLeanFiles(path.join(record.aeneasDest, 'translation.json'));
  const mapping = provider.stages.publish.record.mapping;
  const texts = {};
  for (const name of names) {
    const entry = mapping.find((candidate) => candidate.projectPath === path.join(provider.invocation.publishDir, name));
    if (!entry) bad(`its publication does not map ${name}`);
    texts[name] = fs.readFileSync(entry.projectPath, 'utf8');
  }
  const inventory = leanDeclarations(Object.values(texts), crate);
  if (inventory.duplicates.length > 0) bad(`its published Lean declares ${inventory.duplicates.slice(0, 6).join(', ')}${inventory.duplicates.length > 6 ? ', ...' : ''} more than once, so no declaration of it is a unique target`);
  return {
    crate,
    stageSha256: provider.stages.publish.sha256,
    modules: names.map((name) => `${root}.${name.replace(/\.lean$/, '').split('/').join('.')}`),
    declarations: inventory.declarations,
    rustPaths: new Set([...inventory.declarations.values()].map((item) => item.rustPath).filter((item) => item !== null)),
  };
}

function stitchText(text, { crate, provider, assume, consumerNames }) {
  const providerOwned = (rustPath) => rustPath.split('::')[0] === provider.crate;
  const qualifierFor = (owner, names, skipPrefix) => (code) => code.replace(/[A-Za-z_][A-Za-z0-9_'.]*/g, (token) => (!(skipPrefix && token.startsWith(`${skipPrefix}.`)) && names.has(`${owner}.${token}`) ? `${owner}.${token}` : token));
  const replaced = [];
  const assumed = [];
  const copies = [];
  const problems = [];
  const usedAssume = new Set();
  const parts = text.split(/(\n{2,})/);
  for (let index = 0; index < parts.length; index += 2) {
    const block = parts[index];
    if (!block.startsWith('/--')) continue;
    const declaration = /^axiom\s+([^\s:({[⦃]+)([\s\S]*)$/m.exec(block);
    const attribute = declaration ? RUST_ATTRIBUTE.exec(block.slice(0, declaration.index)) : null;
    if (declaration === null || attribute === null) {
      const doc = DOC_PATH.exec(block)?.[1];
      const copy = DECLARATION.exec(block);
      if (doc !== undefined && copy !== null && providerOwned(doc)) {
        // This crate's Lean defines an item of the provider itself. Where the provider defines it
        // too, two declarations stand for one Rust item and the provider's theorems concern the
        // other one. Where it does not, the owner has to have said so: the item is under an assume
        // prefix, an item the provider leaves out.
        const defined = provider.declarations.get(copy[2]) ?? [...provider.declarations.values()].find((item) => item.rustPath === doc);
        const covering = assume.filter((prefix) => isRustItem(doc, prefix));
        covering.forEach((prefix) => usedAssume.add(prefix));
        if (defined) problems.push(`${doc} (${copy[2]}) is also defined as a ${copy[1]} in this crate's Lean, and ${provider.crate} defines it too (${defined.keyword}): two declarations stand for one Rust item, and ${provider.crate}'s theorems concern the other one; translate it opaquely here so that stitching can replace it by ${provider.crate}'s, or leave ${provider.crate} a non-target`);
        else if (covering.length === 0) problems.push(`${doc} (${copy[2]}) is an item of ${provider.crate} that this crate's Lean defines itself, and ${provider.crate} does not define it; name it in the stitch assume list (the owner's decision) or translate it in ${provider.crate}`);
        else copies.push({ rustPath: doc, name: copy[2], keyword: copy[1], assume: covering[0] });
      }
      continue;
    }
    const [, kindWord, rustPath] = attribute;
    if (!providerOwned(rustPath)) continue;
    const name = declaration[1];
    const kind = { rust_fun: 'fun', rust_const: 'const', rust_type: 'type' }[kindWord];
    const covering = assume.filter((prefix) => isRustItem(rustPath, prefix));
    const target = provider.declarations.get(name);
    if (covering.length > 0) {
      covering.forEach((prefix) => usedAssume.add(prefix));
      // The provider declares the item under this name or under any other that carries its Rust path.
      const declared = target ?? [...provider.declarations.values()].find((item) => item.rustPath === rustPath);
      if (declared) {
        problems.push(`${rustPath} (${name}) is named in the assume list, but ${provider.crate} declares it (${declared.keyword}); it is stitched, and the assume list only names items the provider does not declare`);
        continue;
      }
      assumed.push({ rustPath, name, qualifiedName: `${crate}.${name}`, reason: 'named in the stitch assume list' });
      continue;
    }
    if (!target || (target.rustPath !== null && target.rustPath !== rustPath)) {
      problems.push(target ? `${name} is ${rustPath} here and ${target.rustPath} in ${provider.crate}` : `${rustPath} (${name}) is not defined by ${provider.crate}; stitching never keeps an axiom silently, so name it in the stitch assume list or translate it in ${provider.crate}`);
      continue;
    }
    const lift = kind === 'const' && !/^Result\b/.test(squash(readSignature(target.rest)?.type ?? ''));
    const verdict = compareSignatures(
      normalSignature(declaration[2], qualifierFor(crate, consumerNames, provider.crate)),
      normalSignature(target.rest, qualifierFor(provider.crate, provider.declarations, null)),
      lift,
    );
    if (verdict === 'differ') {
      problems.push(`${rustPath}: the type of ${name} here (${squash(declaration[2])}) is not the type ${provider.crate} defines (${squash(target.rest.split(':=')[0])}), so it cannot stand for it`);
      continue;
    }
    const head = block.slice(0, declaration.index);
    // A constant stays an ordinary definition: a reducible `Result.ok c` would let proof
    // automation read the bound value away, and the proofs written against the axiom name
    // that value.
    const marked = kind === 'const' ? head : /^@\[/m.test(head) ? head.replace(/^@\[/m, '@[reducible, ') : `${head}@[reducible]\n`;
    parts[index] = `${marked}def ${name}${declaration[2].trimEnd()}\n  := ${lift ? 'Result.ok ' : ''}_root_.${name}`;
    replaced.push({
      rustPath, name, qualifiedName: `${crate}.${name}`, providerQualifiedName: name, kind, lift, providerKind: target.keyword, providerOpaque: target.keyword === 'axiom', textComparison: verdict, check: 'pending-lean-build',
      signatureSha256: sha256(squash(declaration[2])), providerDeclSha256: target.blockSha256,
    });
  }
  let result = parts.join('');
  if (replaced.length > 0) {
    const header = /^(public import Aeneas|import Aeneas)$/m.exec(result);
    if (header === null) problems.push('the file has no `import Aeneas` line to add the provider import after');
    else {
      const keyword = header[1].startsWith('public') ? 'public import' : 'import';
      result = result.replace(header[0], [header[0], ...provider.modules.filter((module) => !result.includes(`import ${module}\n`)).map((module) => `${keyword} ${module}`)].join('\n'));
    }
  }
  return { text: result, replaced, assumed, copies, problems, usedAssume: [...usedAssume] };
}

// The check that makes Lean itself compare each alias with the constant it stands for, appended to
// the consumer's published module so that the normal build runs it. An alias that elaborates is not
// enough: elaboration may insert implicit arguments, synthesise instances or instantiate universes,
// so the declared type of the alias could differ from the provider's. The check compares the
// universe parameters and the declared types themselves, with nothing inserted; a constant, which
// carries Result here, is compared with Result of the provider's type.
function leanCheckBlock(items) {
  const pairs = items.map((item) => `      (\`${item.qualifiedName}, \`${item.providerQualifiedName}, ${item.lift})`).join(',\n');
  return [
    '',
    "/-! The declared type of each alias above is the type of the constant it stands for: equal universe parameters and definitionally equal types, with no implicit argument inserted (a constant, which carries Result here, is compared with Result of the provider's type). This module does not build when one is not. -/",
    'open Lean Meta Elab Command in',
    'run_cmd liftTermElabM do',
    '  for (consumer, provider, lift) in [',
    `${pairs}] do`,
    '    let a ← getConstInfo consumer',
    '    let b ← getConstInfo provider',
    '    unless a.levelParams.length == b.levelParams.length do',
    '      throwError "{consumer}: {a.levelParams.length} universe parameter(s), but {provider} has {b.levelParams.length}"',
    '    let expected ← if lift then mkAppM ``Aeneas.Std.Result #[b.type] else pure b.type',
    '    unless (← isDefEq a.type expected) do',
    '      throwError "{consumer}: its type {a.type} is not the type {expected} of {provider}"',
    '',
  ].join('\n');
}

// The substitutions and then the stitching of every generated Lean file, recomputed from
// the Aeneas outputs on disk. Returns the record that publication stores, the final
// texts, and the reasons the edit cannot be made.
function computeTransform(chain, raw) {
  const spec = chain.attempt.spec;
  const substitutions = spec.substitutions ?? [];
  const reasons = [];
  for (const entry of substitutions) if (!Object.hasOwn(raw, entry.file)) reasons.push(`a substitution names ${entry.file}, which is not a generated Lean file (${Object.keys(raw).join(', ')})`);
  const providers = (spec.stitch ?? []).map((entry) => ({ ...entry, loaded: loadProvider(chain, entry.crate) }));
  const texts = {};
  const applied = [];
  const files = {};
  for (const [name, original] of Object.entries(raw)) {
    const substituted = applySubstitutions(name, original, substitutions, raw);
    reasons.push(...substituted.reasons);
    applied.push(...substituted.applied);
    texts[name] = substituted.text;
  }
  const consumerInventory = leanDeclarations(Object.values(texts), spec.crate);
  const consumerNames = consumerInventory.declarations;
  if (consumerInventory.duplicates.length > 0) reasons.push(`this crate's Lean declares ${consumerInventory.duplicates.slice(0, 6).join(', ')}${consumerInventory.duplicates.length > 6 ? ', ...' : ''} more than once, so a declaration of it is not a unique target`);
  const stitched = providers.map(({ loaded }) => ({ provider: loaded.crate, providerStage: 'publish', providerStageSha256: loaded.stageSha256, modules: loaded.modules, replaced: [], assumed: [], copies: [], files: [] }));
  const usedAssume = providers.map(() => new Set());
  const leanChecks = [];
  for (const name of Object.keys(texts)) {
    const replacedHere = [];
    providers.forEach(({ assume, loaded }, position) => {
      const result = stitchText(texts[name], { crate: spec.crate, provider: loaded, assume, consumerNames });
      result.usedAssume.forEach((prefix) => usedAssume[position].add(prefix));
      texts[name] = result.text;
      stitched[position].replaced.push(...result.replaced);
      replacedHere.push(...result.replaced);
      stitched[position].assumed.push(...result.assumed);
      stitched[position].copies.push(...result.copies);
      if (result.replaced.length > 0) stitched[position].files.push(name);
      reasons.push(...result.problems.map((problem) => `${name}: ${problem}`));
    });
    if (replacedHere.length > 0) {
      const block = leanCheckBlock(replacedHere);
      texts[name] = `${texts[name].endsWith('\n') ? texts[name] : `${texts[name]}\n`}${block}`;
      leanChecks.push({ file: name, module: spec.moduleRoot === undefined ? null : `${spec.moduleRoot}.${name.replace(/\.lean$/, '').split('/').join('.')}`, items: replacedHere.length, blockSha256: sha256(block), fileSha256: sha256(texts[name]) });
    }
    files[name] = { rawSha256: sha256(raw[name]), sha256: sha256(texts[name]) };
  }
  providers.forEach(({ assume, loaded }, position) => {
    for (const prefix of assume) if (!usedAssume[position].has(prefix)) reasons.push(`stitch to ${loaded.crate}: the assume entry ${prefix} matches no axiom of this crate, so it is stale`);
  });
  return { record: { substitutions: applied, stitch: stitched, leanChecks, files }, texts, reasons };
}

// A crate whose LLBC reaches another target crate must import that crate's real
// translation. Without a stitch entry every reached item stays an axiom in this crate's
// Lean, an assumption about a function the attempt itself extracts.
function reachProblems(chain) {
  if (!chain.invocation.targets) return [];
  const stitched = new Set((chain.attempt.spec.stitch ?? []).map((entry) => entry.crate));
  return (chain.stages.charon.record.llbc?.foreignCrates ?? [])
    .filter((entry) => entry.kind === 'target' && !stitched.has(entry.crate))
    .map((entry) => `the LLBC reaches target crate ${entry.crate}, and the spec has no stitch entry for it, so its items would stay axioms here; add a stitch entry, or declare ${entry.crate} a non-target (the owner's decision)`);
}

// Every axiom left in the final Lean has to be accounted for. One that stands for an item
// of another target crate must be a recorded assumption, and one with no Rust path cannot
// be classified at all; both are refused, so no assumption about a target survives
// unrecorded. Axioms for the crate's own items, a non-target or an external crate are the
// disclosed assumptions of the externals records.
function axiomProblems(chain, texts, stitch) {
  const targets = (chain.invocation.targets ?? []).map((entry) => entry.crate);
  if (targets.length === 0) return [];
  const assumed = new Set(stitch.flatMap((entry) => entry.assumed.map((item) => item.name)));
  const problems = [];
  for (const [file, text] of Object.entries(texts)) {
    for (const block of leanBlocks(text)) {
      if (!block.axiom) continue;
      const rustPath = RUST_ATTRIBUTE.exec(block.text)?.[2] ?? DOC_PATH.exec(block.text)?.[1] ?? null;
      if (rustPath === null) problems.push(`${file}: the axiom ${block.name} carries no readable Rust path, so it cannot be classified`);
      else if (rustPath.split('::')[0] !== chain.invocation.crate && targets.includes(rustPath.split('::')[0]) && !assumed.has(block.name)) {
        problems.push(`${file}: the axiom ${block.name} stands for ${rustPath}, an item of target crate ${rustPath.split('::')[0]}, which stitching neither replaces nor records as assumed`);
      }
    }
  }
  return problems;
}

// The Lean files as they will be published: the edited texts when edits are declared,
// the Aeneas output otherwise.
function finalTexts(chain, transform) {
  if (transform !== null) return transform.texts;
  const outputs = chain.stages.aeneas.record.outputs;
  return Object.fromEntries(Object.keys(outputs).filter((file) => file.endsWith('.lean')).sort().map((file) => [file, fs.readFileSync(path.join(chain.invocation.aeneasDest, file), 'utf8')]));
}

// Everything that stops this crate from being published, from its LLBC and final Lean.
function publishProblems(chain, transform) {
  return [...(transform?.reasons ?? []), ...reachProblems(chain), ...axiomProblems(chain, finalTexts(chain, transform), transform?.record.stitch ?? [])];
}

// The edit as the stages see it: nothing when the spec declares none.
function transformOf(chain) {
  const spec = chain.attempt.spec;
  if ((spec.substitutions ?? []).length === 0 && (spec.stitch ?? []).length === 0) return null;
  const outputs = chain.stages.aeneas.record.outputs;
  const raw = Object.fromEntries(Object.keys(outputs).filter((file) => file.endsWith('.lean')).sort().map((file) => [file, fs.readFileSync(path.join(chain.invocation.aeneasDest, file), 'utf8')]));
  return computeTransform(chain, raw);
}

function runPublish(chain) {
  const inv = chain.invocation;
  const { out } = chain.attempt;
  const aeneas = chain.stages.aeneas.record;
  if (!exactlyFiles(entriesUnder(inv.aeneasDest), aeneas.outputs)) refuse('attempt-refused', 'the Aeneas outputs changed after the Aeneas stage recorded them');
  const transform = transformOf(chain);
  const problems = publishProblems(chain, transform);
  if (problems.length > 0) {
    return settle(beginStage(chain, 'publish'), { ...stageBase(chain, 'publish'), mapping: [], ownershipSha256: null, ...(transform === null ? {} : { transform: transform.record }) }, problems);
  }
  const outputs = { ...aeneas.outputs };
  const sources = {};
  if (transform !== null) {
    const dest = path.join(out, PUBLISH_DEST);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest);
    for (const [file, text] of Object.entries(transform.texts)) {
      fs.mkdirSync(path.dirname(path.join(dest, file)), { recursive: true });
      fs.writeFileSync(path.join(dest, file), text);
      outputs[file] = sha256(text);
      sources[file] = path.join(dest, file);
    }
  }
  const plan = publicationPlan(inv, outputs, sources);
  const files = beginStage(chain, 'publish');
  const reasons = [];
  let ownershipSha256 = null;
  try {
    fs.mkdirSync(inv.publishDir, { recursive: true });
    fs.writeFileSync(path.join(inv.publishDir, PUBLICATION_PENDING), `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx' });
    for (const entry of plan) {
      fs.mkdirSync(path.dirname(entry.projectPath), { recursive: true });
      const temporary = `${entry.projectPath}.fvs-tmp-${process.pid}`;
      fs.copyFileSync(entry.attemptPath, temporary, fs.constants.COPYFILE_EXCL);
      fs.renameSync(temporary, entry.projectPath);
      if (fileState(entry.projectPath)?.sha256 !== entry.sha256) reasons.push(`${entry.projectPath} differs from the attempt output after copying`);
    }
    if (reasons.length === 0) {
      const ownership = { schema: 'fvs-extract-patches/publication', version: 1, attempt: out, files: Object.fromEntries(plan.map((entry) => [path.relative(inv.publishDir, entry.projectPath), entry.sha256])) };
      const target = path.join(inv.publishDir, OWNERSHIP);
      const temporary = `${target}.fvs-tmp-${process.pid}`;
      fs.writeFileSync(temporary, `${JSON.stringify(ownership, null, 2)}\n`, { flag: 'wx' });
      fs.renameSync(temporary, target);
      ownershipSha256 = fileState(target).sha256;
      fs.unlinkSync(path.join(inv.publishDir, PUBLICATION_PENDING));
    }
  } catch (error) {
    reasons.push(error.message);
  }
  return settle(files, { ...stageBase(chain, 'publish'), mapping: plan, ownershipSha256, ...(transform === null ? {} : { transform: transform.record }) }, reasons);
}

const STAGE_RUNNERS = { charon: runCharon, aeneas: runAeneas, publish: runPublish };

// The directory of the attempt a command acts on: the copy itself for one crate, the
// crate's own directory for a multi-crate attempt (named with --crate).
function attemptDirectory(flags, multi) {
  if (!multi) {
    if (flags.crate !== undefined) refuse('usage', '--crate is only for a multi-crate attempt');
    return path.resolve(flags.out);
  }
  const unit = multi.units.find((entry) => entry.crate === flags.crate);
  if (!unit) refuse('usage', `--crate is required and must be one of ${multi.units.map((entry) => entry.crate).join(', ')}`);
  return unit.out;
}

function run(flags) {
  if (!Object.hasOwn(STAGE_RUNNERS, flags.step)) refuse('usage', `--step must be ${ATTEMPT_STAGES.join(', ')}`);
  return STAGE_RUNNERS[flags.step](loadChain(attemptDirectory(flags, readMulti(path.resolve(flags.out))), ATTEMPT_STAGES.indexOf(flags.step)));
}

// Where a crate's chain stands, from its stage records alone: the first stage
// that is not completed, and how it ended.
function progressOf(out) {
  for (const stage of ATTEMPT_STAGES) {
    const files = stagePaths(out, stage);
    if (lexists(files.completed)) continue;
    if (lexists(files.failed)) return `failed at ${stage}`;
    if (lexists(files.pending)) return `interrupted at ${stage}`;
    return `not run: ${stage} is next`;
  }
  return null;
}

function unitRow(unit) {
  const base = { crate: unit.crate, package: unit.package, dir: unit.dir, imports: unit.imports ?? [] };
  try {
    return { ...base, status: 'complete', run: attemptStatusOf(unit.out).run };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return { ...base, status: progressOf(unit.out) ?? `refused: ${error.message}` };
  }
}

// The completed chain, re-validated with the current invocation, cargo
// configuration, toolchain identity, LLBC, Aeneas-output and published-file
// hashes; the summary record-extraction stores. For a multi-crate attempt every
// declared crate's chain must be complete: one failed or missing crate refuses
// the whole status, so such an extraction is never recorded as a success. The
// top-level run is the main crate's; run.units has one row per crate.
function attemptStatus(flags) {
  const multi = readMulti(path.resolve(flags.out));
  if (!multi) {
    const out = attemptDirectory(flags, null);
    const chain = loadChain(out, ATTEMPT_STAGES.length);
    // A unit of a multi-crate attempt is read through the copy, where the roster is checked; read
    // alone, it would report complete while another crate of the attempt has failed.
    if (chain.attempt.roster !== undefined) refuse('attempt-refused', `${out} is one crate of a multi-crate attempt; read it with attempt-status --out ${path.dirname(path.dirname(out))} --crate ${chain.attempt.spec?.crate ?? 'NAME'}`);
    return attemptStatusOfChain(chain, out);
  }
  const rows = multi.units.map(unitRow);
  // A complete crate's row carries its whole single-crate run, so a reader written for
  // one crate reads any crate of the attempt unchanged.
  const summary = (row) => {
    const base = { crate: row.crate, package: row.package, dir: row.dir, status: row.status, imports: row.imports };
    return row.status === 'complete' ? { ...base, stitch: [], ...row.run } : base;
  };
  if (flags.crate !== undefined) {
    const row = rows.find((entry) => entry.crate === flags.crate);
    if (!row) refuse('usage', `--crate must be one of ${rows.map((entry) => entry.crate).join(', ')}`);
    return { message: `crate ${row.crate}: ${row.status}`, unit: summary(row), ...(row.status === 'complete' ? { run: row.run } : {}) };
  }
  const incomplete = rows.filter((row) => row.status !== 'complete');
  if (incomplete.length > 0) {
    refuse('attempt-refused', `the multi-crate attempt is not complete: ${incomplete.map((row) => `${row.crate} ${row.status}`).join('; ')}`, { units: rows.map(summary) });
  }
  const main = rows.find((row) => row.crate === multi.main);
  const supported = rows.every((row) => row.run.supported);
  const residuals = [...new Map(rows.flatMap((row) => row.run.residuals).map((entry) => [JSON.stringify(entry), entry])).values()];
  return { message: `attempt complete for ${rows.length} crate(s) (${supported ? 'supported configuration' : 'unsupported configuration'})`, run: { ...main.run, supported, residuals, order: multi.order, rosterSha256: multi.rosterSha256, roster: multi.roster, units: rows.map(summary) } };
}

function crossCrate(foreignCrates, recorded) {
  const dependsOn = foreignCrates.filter((entry) => entry.kind === 'target').map((entry) => entry.crate).sort();
  const imports = recorded === null ? [] : recorded.stitch.map((entry) => entry.provider);
  return {
    dependsOn,
    unstitched: dependsOn.filter((crate) => !imports.includes(crate)),
    prerequisites: (recorded?.stitch ?? []).flatMap((entry) => entry.replaced.map((item) => ({ providerCrate: entry.provider, rustPath: item.rustPath }))),
  };
}

function attemptStatusOf(out) {
  return attemptStatusOfChain(loadChain(out, ATTEMPT_STAGES.length), out);
}

function attemptStatusOfChain(chain, out) {
  const { attempt: record, invocation: inv, stages } = chain;
  if (fileState(inv.llbc)?.sha256 !== stages.charon.record.llbcSha256) refuse('attempt-refused', 'the LLBC changed after the Charon stage');
  if (!exactlyFiles(entriesUnder(inv.aeneasDest), stages.aeneas.record.outputs)) refuse('attempt-refused', 'the Aeneas outputs changed after the Aeneas stage');
  const { mapping } = stages.publish.record;
  if (!Array.isArray(mapping) || mapping.length === 0) refuse('attempt-refused', 'the publication record maps no files');
  for (const entry of mapping) {
    if (fileState(entry.projectPath)?.sha256 !== entry.sha256) refuse('attempt-refused', `${entry.projectPath} changed after publication`);
  }
  if (fileState(path.join(inv.publishDir, OWNERSHIP))?.sha256 !== stages.publish.record.ownershipSha256) refuse('attempt-refused', 'the publication ownership record changed');
  const translationEntry = mapping.find((entry) => entry.attemptPath === path.join(inv.aeneasDest, 'translation.json'));
  if (!translationEntry) refuse('attempt-refused', 'the publication record does not map translation.json');
  // projectPath is absolute, as recorded; relativePath is the same file relative to the project
  // root, so another checkout of the project can find it without the recording machine's paths.
  const relativePath = (entry) => ({ ...entry, relativePath: path.relative(inv.projectRoot, entry.projectPath).split(path.sep).join('/') });
  const translation = relativePath(translationEntry);
  const recorded = stages.publish.record.transform ?? null;
  const again = transformOf(chain);
  const unaccounted = [...reachProblems(chain), ...axiomProblems(chain, finalTexts(chain, again), again?.record.stitch ?? [])];
  if (unaccounted.length > 0) refuse('attempt-refused', `the attempt is not complete: ${unaccounted.join('; ')}`);
  if ((again === null) !== (recorded === null)) refuse('attempt-refused', 'the spec declares substitutions or stitching that publication did not record, or the reverse');
  if (again !== null) {
    const staged = path.join(out, PUBLISH_DEST);
    if (again.reasons.length > 0 || !sameState(again.record, recorded)) refuse('attempt-refused', `the substitutions and stitching no longer reproduce the published Lean${again.reasons.length > 0 ? `: ${again.reasons.join('; ')}` : ''}`);
    if (!exactlyFiles(entriesUnder(staged), Object.fromEntries(Object.entries(again.record.files).map(([file, state]) => [file, state.sha256])))) refuse('attempt-refused', 'the edited Lean files changed after publication wrote them');
    for (const [file, state] of Object.entries(again.record.files)) {
      const entry = mapping.find((candidate) => candidate.projectPath === path.join(inv.publishDir, file));
      if (entry?.sha256 !== state.sha256 || entry.attemptPath !== path.join(staged, file)) refuse('attempt-refused', `${file} was not published from the edited Lean`);
    }
  }
  return {
    message: `attempt complete (${record.supported ? 'supported configuration' : 'unsupported configuration'})`,
    run: {
      attemptSha256: chain.attemptSha256,
      stages: Object.fromEntries(Object.entries(stages).map(([stage, { sha256: hash }]) => [stage, hash])),
      manifestSha256: chain.manifestSha256,
      ...(record.rosterSha256 === undefined ? {} : { rosterSha256: record.rosterSha256 }),
      supported: record.supported,
      residuals: record.residuals,
      trust: record.trust,
      config: record.config,
      configSha256: record.configSha256,
      llbc: { path: inv.llbc, sha256: stages.charon.record.llbcSha256 },
      translation,
      publication: mapping.map(relativePath),
      crate: inv.crate,
      publishDir: path.relative(inv.projectRoot, inv.publishDir),
      // The Cargo.lock the copy was built against: read from the project, or generated in the copy.
      lock: preparedManifest(copyRoot(out)).manifest.lock ?? null,
      // What Charon flagged although it exited 0: the items it could not translate, by name.
      hasErrors: stages.charon.record.llbc ? { value: stages.charon.record.llbc.hasErrors, items: stages.charon.record.llbc.items, itemCount: stages.charon.record.llbc.itemCount } : null,
      // The declared edits of the generated Lean: substitutions, and the crates whose real
      // translation this crate's Lean imports in place of axioms.
      ...(recorded === null ? {} : { imports: recorded.stitch.map((entry) => entry.provider), stitch: recorded.stitch, substitutions: recorded.substitutions, leanChecks: recorded.leanChecks }),
      // Cross-crate edges, present with or without stitching: the declared target crates this
      // crate's LLBC reaches, the ones among them its Lean does not import (their items are
      // still axioms here), and the provider items the stitched aliases stand for, each of
      // which must be settled in its own crate before this one is.
      ...(inv.targets && stages.charon.record.llbc?.foreignCrates ? crossCrate(stages.charon.record.llbc.foreignCrates, recorded) : {}),
      // The crates the LLBC reaches, and the in-repo crates the owner chose not to verify
      // with the sources of each that appeared (their items alone may become assumptions).
      ...(stages.charon.record.llbc?.foreignCrates ? { foreignCrates: stages.charon.record.llbc.foreignCrates } : {}),
      ...(inv.nonTargets ? { nonTargets: inv.nonTargets.map((entry) => ({ ...entry, sources: (stages.charon.record.llbc?.nonTargetSources ?? []).filter((source) => source.crate === entry.crate).map(({ file, sha256: hash }) => ({ file, sha256: hash })) })) } : {}),
    },
  };
}

const COMMANDS = {
  check: { required: ['project-root'], run: check },
  prepare: { required: ['project-root', 'out'], optional: ['lock', 'release'], run: prepare },
  'verify-restore': { required: ['out'], run: verifyRestore },
  'verify-tree': { required: ['out'], run: verifyTree },
  status: { required: ['out'], run: status },
  migrate: { required: ['project-root'], run: migrate },
  attempt: { required: ['out', 'spec'], run: attempt },
  run: { required: ['out', 'step'], optional: ['crate'], run },
  'attempt-status': { required: ['out'], optional: ['crate'], run: attemptStatus },
  crates: { required: ['release'], optional: ['out', 'project-root'], run: listCrates },
};

function parseFlags(argv, required, optional = []) {
  const flags = {};
  const rest = [...argv];
  while (rest.length > 0) {
    const flag = rest.shift();
    const key = flag.replace(/^--/, '');
    if (![...required, ...optional, 'format'].includes(key) || key === flag) refuse('usage', `unknown argument ${JSON.stringify(flag)}`);
    const value = rest.shift();
    if (!value || value.startsWith('--')) refuse('usage', `${flag} requires a value`);
    flags[key] = value;
  }
  for (const key of required) if (!flags[key]) refuse('usage', `--${key} is required`);
  if (flags.format && !['json', 'text'].includes(flags.format)) refuse('usage', '--format must be json or text');
  return flags;
}

function main(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }
  let format = 'json';
  let result;
  try {
    if (!Object.prototype.hasOwnProperty.call(COMMANDS, argv[0])) refuse('usage', `unknown command ${JSON.stringify(argv[0])}`);
    const command = COMMANDS[argv[0]];
    const flags = parseFlags(argv.slice(1), command.required, command.optional);
    format = flags.format ?? 'json';
    result = { ok: true, code: 'ok', command: argv[0], ...command.run(flags) };
  } catch (error) {
    result = error instanceof Refusal
      ? { ok: false, code: error.code, command: argv[0], message: error.message, ...error.details }
      : { ok: false, code: 'internal', command: argv[0], message: error.message };
  }
  process.stdout.write(format === 'text'
    ? `FVS >> ${result.ok ? 'ok' : result.code}: ${result.message}\n`
    : `${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok && format === 'json') process.stderr.write(`FVS >> ${result.code}: ${result.message}\n`);
  process.exitCode = EXIT[result.code];
}

function invokedDirectly() {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) main(process.argv.slice(2));
