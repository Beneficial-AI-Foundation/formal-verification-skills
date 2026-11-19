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
    '       node fvs-extract-patches.mjs prepare --project-root DIR --out DIR [--format json|text]',
    '       node fvs-extract-patches.mjs verify-restore --out DIR [--format json|text]',
    '       node fvs-extract-patches.mjs verify-tree --out DIR [--format json|text]',
    '       node fvs-extract-patches.mjs status --out DIR [--format json|text]',
    '       node fvs-extract-patches.mjs migrate --project-root DIR [--format json|text]',
    '       node fvs-extract-patches.mjs attempt --out DIR --spec FILE [--format json|text]',
    '       node fvs-extract-patches.mjs run --out DIR --step charon|aeneas|publish [--crate NAME] [--format json|text]',
    '       node fvs-extract-patches.mjs attempt-status --out DIR [--crate NAME] [--format json|text]',
    '       node fvs-extract-patches.mjs crates --out DIR --release DIR [--format json|text]',
    '',
    'Applies the translation patches in DIR/translation-patches, in the order listed',
    'in DIR/translation-patches/series (one file name per line, every patch exactly',
    'once), to a disposable copy of the Rust extraction input set (extraction.inputs',
    'in .formalising/fvs-config.json, default Cargo.toml, Cargo.lock, build.rs, src).',
    'The original checkout is never written. check rehearses the list in a temporary',
    'copy; prepare builds OUT/tree and OUT/manifest.json (OUT must be a new directory',
    'outside the project); verify-restore compares the touched original sources with',
    'the recorded start; verify-tree compares every file under OUT/tree, except cargo\'s',
    'target/ directory, with the tree prepare recorded; status reads the manifest.',
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
    'crates lists the in-repo crates of a prepared copy (package, crate name, directory,',
    'the in-repo crates it depends on) and a dependency order, providers first, so a',
    'multi-crate spec can start from every crate as a target and drop the ones the owner',
    'decides not to verify. It runs cargo metadata --no-deps --offline in the copy, under',
    'the toolchain of the release directory (relative to the project root); it changes',
    'nothing and is advisory.',
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

// Every regular file in the input set with its content hash and mode. Links
// are rejected, never followed or copied: a followed link would extract
// content from outside the input set, and a copied one would write through to
// the original checkout or a shared planning directory.
function walkInputs(root, inputs) {
  const files = {};
  function visit(relative) {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat) return; // an input a patch deleted from the copy
    if (stat.isSymbolicLink()) {
      refuse('invalid-input', `${relative} is a symbolic link; the extraction input set takes only regular files, so replace it with the intended content or leave it out of extraction.inputs`, { kind: 'symlink', path: relative });
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) visit(`${relative}/${name}`);
    } else if (stat.isFile()) {
      files[relative] = fileState(absolute);
    } else {
      refuse('invalid-input', `unsupported file type in the extraction input set: ${relative}`, { path: relative });
    }
  }
  for (const input of inputs) visit(input);
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
  const dirty = listed.flatMap((result) => result.stdout.split('\0')).filter(Boolean);
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
  const files = walkInputs(projectRoot, inputs);
  const mode = resolveMode(projectRoot, config, files, patches);
  refuseOutsideInputs(patches, inputs);
  const touched = [...new Set(patches.flatMap((patch) => patch.touches))].sort();
  return { projectRoot, inputs, patches, mode, files, touched, ...sourceIdentity(projectRoot, inputs) };
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

function prepare(flags) {
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
    source: { inputs: context.inputs, commit: context.commit, dirty: context.dirty, files: context.files },
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
    // The exact tree handed to the next stage: the touched set's hash and every file in the
    // copy. A completed tree holding any link is refused before it is recorded.
    const files = copyState(tree);
    const link = Object.keys(files).find((file) => files[file].link !== undefined);
    if (link) refuseCopyLink(link);
    manifest.final = { touchedSha256: sha256(JSON.stringify(touchedState(tree, context.touched))), files };
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

function verifyRestore(flags) {
  const manifest = readManifest(flags.out);
  refuseChangedOriginals(manifest);
  return { message: `${manifest.touched.length} touched source file(s) match the recorded start`, touched: manifest.touched };
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
    refuse('changed-tree', `the extraction copy differs from the recorded tree: ${changed.join(', ')}`, { changed });
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
  const files = walkInputs(projectRoot, inputs);
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

const SPEC_FIELDS = ['release', 'crate', 'publishDir', 'charonArgs', 'cargoArgs', 'aeneasArgs', 'moduleRoot', 'substitutions', 'stitch'];
const INVOCATION_FIELDS = ['spec', 'crate', 'llbc', 'aeneasDest', 'publishDir', 'projectRoot', 'tree', 'release', 'tools', 'env', 'charon', 'aeneas', 'targets', 'nonTargets'];
const TRUST = 'local-host-and-reviewed-scripts';

// A multi-crate spec: the top-level fields are the base, every entry of crates
// is an overlay, and each crate gets its own attempt chain inside the one
// prepared copy, under OUT/units/<crate>.
const UNITS_DIR = 'units';
const MULTI_SCHEMA = 'fvs-extract-patches/multi-attempt';
const MULTI_SPEC_FIELDS = ['release', 'cargoArgs', 'charonArgs', 'aeneasArgs', 'crates', 'main', 'nonTargets'];
const UNIT_FIELDS = ['crate', 'package', 'dir', 'publishDir', 'charonArgs', 'cargoArgs', 'aeneasArgs', 'moduleRoot', 'substitutions', 'stitch'];
const CRATE_NAME = /^[A-Za-z0-9_]+$/;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Edits to the generated Lean are declared in the spec, never made by hand:
// exact text substitutions with the match count they must find, and stitching a
// crate to the crate whose real translation replaces its axioms.
const LEAN_MODULE = /^[A-Za-z_][A-Za-z0-9_']*(\.[A-Za-z_][A-Za-z0-9_']*)*$/;
const RUST_PATH = /^[A-Za-z0-9_]+(::[A-Za-z0-9_]+)*$/;
const SUBSTITUTION_FIELDS = ['file', 'find', 'replace', 'count', 'reason'];
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
    if (typeof entry.find !== 'string' || entry.find === '') refuse('invalid-input', `${where}.find must be the exact non-empty text to replace`);
    if (typeof entry.replace !== 'string') refuse('invalid-input', `${where}.replace must be a string`);
    if (!Number.isInteger(entry.count) || entry.count < 1) refuse('invalid-input', `${where}.count must be the exact number of matches (at least 1)`);
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') refuse('invalid-input', `${where}.reason must say why the generated Lean needs this edit`);
    return { file: relative, find: entry.find, replace: entry.replace, count: entry.count, reason: entry.reason };
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
  const spec = readJson(path.resolve(flags.spec));
  return isObject(spec) && spec.crates !== undefined ? attemptUnits(out, manifest, manifestSha256, spec) : recordAttempt(out, manifest, manifestSha256, spec);
}

// The in-repo crates of the prepared copy, as cargo sees them: package, crate name (the
// library target's, which is what Charon labels items with), directory, and the in-repo
// crates each one depends on (normal and build dependencies; dev-dependencies are not
// part of an extraction), with a dependency order, providers first. This only proposes
// targets: a crate that is neither declared a target nor a non-target is refused when
// Charon's output is read. It runs `cargo metadata --no-deps --offline` in the copy, so
// the answer is for the patched workspace Charon will build, and a workspace cargo
// cannot read is reported with cargo's own first error lines.
function listCrates(flags) {
  const out = path.resolve(flags.out);
  const { manifest } = preparedManifest(out);
  const release = releaseTools(path.resolve(manifest.projectRoot, flags.release));
  const homes = homesOf(process.env);
  for (const name of ['HOME', 'RUSTUP_HOME', 'CARGO_HOME']) {
    if (typeof homes[name] !== 'string' || !path.isAbsolute(homes[name])) refuse('invalid-input', `${name} must be an absolute path`);
  }
  const env = { HOME: homes.HOME, RUSTUP_HOME: homes.RUSTUP_HOME, CARGO_HOME: homes.CARGO_HOME, PATH: `${path.join(homes.CARGO_HOME, 'bin')}:/usr/bin:/bin`, RUSTUP_TOOLCHAIN: release.tools.rustToolchain.channel };
  const tree = fs.realpathSync(manifest.tree);
  const run = spawnSync('cargo', ['metadata', '--no-deps', '--offline', '--format-version', '1'], { env, cwd: tree, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) {
    const lines = `${run.stderr ?? ''}`.split('\n').map((line) => line.trim()).filter((line) => line !== '').slice(0, 6);
    refuse('tool-failed', `cargo cannot read the workspace of the extraction copy${lines.length > 0 ? `: ${lines.join(' | ')}` : ''}`, { reasons: lines });
  }
  let metadata;
  try {
    metadata = JSON.parse(run.stdout);
  } catch {
    refuse('tool-failed', 'cargo metadata did not return JSON');
  }
  const rows = metadata.packages.map((item) => {
    const dir = path.dirname(fs.realpathSync(item.manifest_path));
    const library = item.targets.find((target) => target.kind.some((kind) => ['lib', 'rlib', 'dylib', 'cdylib', 'staticlib'].includes(kind)));
    return { package: item.name, crate: library ? library.name.replace(/-/g, '_') : null, dir: inside(dir, tree) ? (path.relative(tree, dir).split(path.sep).join('/') || '.') : null, abs: dir, library: library !== undefined, dependencies: item.dependencies };
  }).filter((row) => row.dir !== null).sort((a, b) => a.dir.localeCompare(b.dir));
  const byDir = new Map(rows.map((row) => [row.abs, row]));
  const crates = rows.map((row) => ({
    package: row.package,
    crate: row.crate,
    dir: row.dir,
    library: row.library,
    deps: [...new Set(row.dependencies.filter((dependency) => dependency.kind !== 'dev' && dependency.path)
      .map((dependency) => byDir.get(fs.existsSync(dependency.path) ? fs.realpathSync(dependency.path) : dependency.path))
      .filter((provider) => provider !== undefined && provider.library).map((provider) => provider.crate))].sort(),
  }));
  const order = [];
  const visit = (row, seen = new Set()) => {
    if (order.includes(row.crate) || seen.has(row.crate)) return;
    seen.add(row.crate);
    for (const dependency of row.deps) visit(crates.find((candidate) => candidate.crate === dependency), seen);
    order.push(row.crate);
  };
  crates.filter((row) => row.library).forEach((row) => visit(row));
  return { message: `${crates.length} in-repo package(s), ${order.length} with a library`, tree, workspaceRoot: path.relative(tree, metadata.workspace_root).split(path.sep).join('/') || '.', crates, order };
}

// A multi-crate attempt: every crate gets an ordinary attempt of its own in
// OUT/units/<crate> (so a failing crate ends only its own chain), all bound to
// the same prepared manifest, and OUT/attempt.json lists them with their hashes.
// Everything is checked before anything is written.
function attemptUnits(out, manifest, manifestSha256, spec) {
  const { units, main, order, nonTargets } = multiUnits(spec, manifest);
  const targets = units.map(({ crate, dir }) => ({ crate, dir }));
  const homes = homesOf(process.env);
  const unitOut = (unit) => path.join(out, UNITS_DIR, unit.crate);
  for (const unit of units) deriveInvocation(unitOut(unit), manifest, unit.flat, homes, targets, nonTargets);
  const recorded = units.map((unit) => {
    fs.mkdirSync(unitOut(unit), { recursive: true });
    return { unit, record: recordAttempt(unitOut(unit), manifest, manifestSha256, unit.flat, targets, nonTargets).attempt };
  });
  const record = {
    schema: MULTI_SCHEMA,
    version: 1,
    out,
    manifestSha256,
    main,
    order,
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
  return record;
}

function recordAttempt(out, manifest, manifestSha256, spec, targets = [], nonTargets = []) {
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
  for (const entry of files) {
    const name = entry?.name?.Local;
    if (typeof name !== 'string' || !Object.hasOwn(sources, name)) continue;
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
  const foreignCrates = [...reachedCrates(translated)].filter((crate) => crate !== invocation.crate).sort().map((crate) => ({
    crate,
    kind: targets.some((entry) => entry.crate === crate) ? 'target' : nonTargets.some((entry) => entry.crate === crate) ? 'non-target' : 'external',
  }));
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

function applySubstitutions(file, text, substitutions) {
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
    const next = current.split(entry.find).join(entry.replace);
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

const DECLARATION = /^(?:noncomputable\s+)?(def|axiom|structure|inductive|abbrev|opaque|class)\s+([^\s:({[⦃]+)([\s\S]*)$/m;
const DOC_PATH = /^\/-- (?:Trait declaration: |Trait implementation: )?\[(.*)\]/;
const RUST_ATTRIBUTE = /\b(rust_fun|rust_const|rust_type)\s+"([^"]+)"/;

function leanDeclarations(texts, crate) {
  const declarations = new Map();
  for (const text of texts) {
    for (const block of text.split(/\n{2,}/)) {
      if (!block.startsWith('/--')) continue;
      const found = DECLARATION.exec(block);
      if (found === null) continue;
      declarations.set(`${crate}.${found[2]}`, { keyword: found[1], rustPath: DOC_PATH.exec(block)?.[1] ?? null, rest: found[3], blockSha256: sha256(block) });
    }
  }
  return declarations;
}

// The crate whose Aeneas output this directory holds, ready to be imported: its attempt
// record, its Aeneas stage (completed, outputs intact) and the Lean it generated.
function loadProvider(chain, crate) {
  const dir = path.join(copyRoot(chain.attempt.out), UNITS_DIR, crate);
  const bad = (message) => refuse('attempt-refused', `stitching to crate ${crate}: ${message}`);
  if (!lexists(path.join(dir, ATTEMPT))) bad('it has no attempt record in this copy');
  const record = JSON.parse(fs.readFileSync(path.join(dir, ATTEMPT)));
  const stageFile = stagePaths(dir, 'aeneas').completed;
  if (!lexists(stageFile)) bad('its Aeneas stage is not completed; run the stages of that crate through aeneas first');
  const stageBytes = fs.readFileSync(stageFile);
  const stage = JSON.parse(stageBytes);
  if (!exactlyFiles(entriesUnder(record.aeneasDest), stage.outputs)) bad('its Aeneas outputs changed after the Aeneas stage recorded them');
  const names = translationLeanFiles(path.join(record.aeneasDest, 'translation.json'));
  const texts = Object.fromEntries(names.map((name) => [name, fs.readFileSync(path.join(record.aeneasDest, name), 'utf8')]));
  const root = record.spec.moduleRoot;
  if (root === undefined) bad('it names no moduleRoot');
  return {
    crate,
    stageSha256: sha256(stageBytes),
    modules: names.map((name) => `${root}.${name.replace(/\.lean$/, '').split('/').join('.')}`),
    declarations: leanDeclarations(Object.values(texts), crate),
  };
}

function stitchText(text, { crate, provider, assume, consumerNames }) {
  const providerOwned = (rustPath) => rustPath.split('::')[0] === provider.crate;
  const qualifierFor = (owner, names, skipPrefix) => (code) => code.replace(/[A-Za-z_][A-Za-z0-9_'.]*/g, (token) => (!(skipPrefix && token.startsWith(`${skipPrefix}.`)) && names.has(`${owner}.${token}`) ? `${owner}.${token}` : token));
  const replaced = [];
  const assumed = [];
  const copies = [];
  const problems = [];
  const parts = text.split(/(\n{2,})/);
  for (let index = 0; index < parts.length; index += 2) {
    const block = parts[index];
    if (!block.startsWith('/--')) continue;
    const declaration = /^axiom\s+([^\s:({[⦃]+)([\s\S]*)$/m.exec(block);
    const attribute = declaration ? RUST_ATTRIBUTE.exec(block.slice(0, declaration.index)) : null;
    if (declaration === null || attribute === null) {
      const doc = DOC_PATH.exec(block)?.[1];
      const copy = DECLARATION.exec(block);
      if (doc !== undefined && copy !== null && providerOwned(doc)) copies.push({ rustPath: doc, name: copy[2], keyword: copy[1] });
      continue;
    }
    const [, kindWord, rustPath] = attribute;
    if (!providerOwned(rustPath)) continue;
    const name = declaration[1];
    const kind = { rust_fun: 'fun', rust_const: 'const', rust_type: 'type' }[kindWord];
    const covered = assume.some((prefix) => isRustItem(rustPath, prefix));
    const target = provider.declarations.get(name);
    if (covered) {
      assumed.push({ rustPath, name, reason: 'named in the stitch assume list' });
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
      rustPath, name, kind, lift, providerKind: target.keyword, check: verdict === 'equal' ? 'text-and-lean-build' : 'lean-build',
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
  return { text: result, replaced, assumed, copies, problems };
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
    const substituted = applySubstitutions(name, original, substitutions);
    reasons.push(...substituted.reasons);
    applied.push(...substituted.applied);
    texts[name] = substituted.text;
  }
  const consumerNames = leanDeclarations(Object.values(texts), spec.crate);
  const stitched = providers.map(({ loaded }) => ({ provider: loaded.crate, providerStageSha256: loaded.stageSha256, modules: loaded.modules, replaced: [], assumed: [], copies: [], files: [] }));
  for (const name of Object.keys(texts)) {
    providers.forEach(({ assume, loaded }, position) => {
      const result = stitchText(texts[name], { crate: spec.crate, provider: loaded, assume, consumerNames });
      texts[name] = result.text;
      stitched[position].replaced.push(...result.replaced);
      stitched[position].assumed.push(...result.assumed);
      stitched[position].copies.push(...result.copies);
      if (result.replaced.length > 0) stitched[position].files.push(name);
      reasons.push(...result.problems.map((problem) => `${name}: ${problem}`));
    });
    files[name] = { rawSha256: sha256(raw[name]), sha256: sha256(texts[name]) };
  }
  return { record: { substitutions: applied, stitch: stitched, files }, texts, reasons };
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
  if (transform !== null && transform.reasons.length > 0) {
    return settle(beginStage(chain, 'publish'), { ...stageBase(chain, 'publish'), mapping: [], ownershipSha256: null, transform: transform.record }, transform.reasons);
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
  if (!multi) return attemptStatusOf(attemptDirectory(flags, null));
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
  return { message: `attempt complete for ${rows.length} crate(s) (${supported ? 'supported configuration' : 'unsupported configuration'})`, run: { ...main.run, supported, residuals, order: multi.order ?? multi.units.map((unit) => unit.crate), units: rows.map(summary) } };
}

function attemptStatusOf(out) {
  const chain = loadChain(out, ATTEMPT_STAGES.length);
  const { attempt: record, invocation: inv, stages } = chain;
  if (fileState(inv.llbc)?.sha256 !== stages.charon.record.llbcSha256) refuse('attempt-refused', 'the LLBC changed after the Charon stage');
  if (!exactlyFiles(entriesUnder(inv.aeneasDest), stages.aeneas.record.outputs)) refuse('attempt-refused', 'the Aeneas outputs changed after the Aeneas stage');
  const { mapping } = stages.publish.record;
  if (!Array.isArray(mapping) || mapping.length === 0) refuse('attempt-refused', 'the publication record maps no files');
  for (const entry of mapping) {
    if (fileState(entry.projectPath)?.sha256 !== entry.sha256) refuse('attempt-refused', `${entry.projectPath} changed after publication`);
  }
  if (fileState(path.join(inv.publishDir, OWNERSHIP))?.sha256 !== stages.publish.record.ownershipSha256) refuse('attempt-refused', 'the publication ownership record changed');
  const translation = mapping.find((entry) => entry.attemptPath === path.join(inv.aeneasDest, 'translation.json'));
  if (!translation) refuse('attempt-refused', 'the publication record does not map translation.json');
  const recorded = stages.publish.record.transform ?? null;
  const again = transformOf(chain);
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
      supported: record.supported,
      residuals: record.residuals,
      trust: record.trust,
      config: record.config,
      configSha256: record.configSha256,
      llbc: { path: inv.llbc, sha256: stages.charon.record.llbcSha256 },
      translation,
      publication: mapping,
      crate: inv.crate,
      publishDir: path.relative(inv.projectRoot, inv.publishDir),
      // What Charon flagged although it exited 0: the items it could not translate, by name.
      hasErrors: stages.charon.record.llbc ? { value: stages.charon.record.llbc.hasErrors, items: stages.charon.record.llbc.items, itemCount: stages.charon.record.llbc.itemCount } : null,
      // The declared edits of the generated Lean: substitutions, and the crates whose real
      // translation this crate's Lean imports in place of axioms.
      ...(recorded === null ? {} : { imports: recorded.stitch.map((entry) => entry.provider), stitch: recorded.stitch, substitutions: recorded.substitutions }),
      // The crates the LLBC reaches, and the in-repo crates the owner chose not to verify
      // with the sources of each that appeared (their items alone may become assumptions).
      ...(stages.charon.record.llbc?.foreignCrates ? { foreignCrates: stages.charon.record.llbc.foreignCrates } : {}),
      ...(inv.nonTargets ? { nonTargets: inv.nonTargets.map((entry) => ({ ...entry, sources: (stages.charon.record.llbc?.nonTargetSources ?? []).filter((source) => source.crate === entry.crate).map(({ file, sha256: hash }) => ({ file, sha256: hash })) })) } : {}),
    },
  };
}

const COMMANDS = {
  check: { required: ['project-root'], run: check },
  prepare: { required: ['project-root', 'out'], run: prepare },
  'verify-restore': { required: ['out'], run: verifyRestore },
  'verify-tree': { required: ['out'], run: verifyTree },
  status: { required: ['out'], run: status },
  migrate: { required: ['project-root'], run: migrate },
  attempt: { required: ['out', 'spec'], run: attempt },
  run: { required: ['out', 'step'], optional: ['crate'], run },
  'attempt-status': { required: ['out'], optional: ['crate'], run: attemptStatus },
  crates: { required: ['out', 'release'], run: listCrates },
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
