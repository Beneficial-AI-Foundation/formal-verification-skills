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
    '       node fvs-extract-patches.mjs run --out DIR --step charon|aeneas|publish [--format json|text]',
    '       node fvs-extract-patches.mjs attempt-status --out DIR [--format json|text]',
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

const SPEC_FIELDS = ['release', 'crate', 'publishDir', 'charonArgs', 'cargoArgs', 'aeneasArgs'];
const INVOCATION_FIELDS = ['spec', 'crate', 'llbc', 'aeneasDest', 'publishDir', 'projectRoot', 'tree', 'release', 'tools', 'env', 'charon', 'aeneas'];
const TRUST = 'local-host-and-reviewed-scripts';

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
function deriveInvocation(out, manifest, spec, homes) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) refuse('invalid-input', 'the spec must be a JSON object');
  const unknown = Object.keys(spec).filter((key) => !SPEC_FIELDS.includes(key));
  if (unknown.length > 0) refuse('invalid-input', `the spec has unsupported fields: ${unknown.join(', ')}`);
  if (typeof spec.crate !== 'string' || !/^[A-Za-z0-9_-]+$/.test(spec.crate)) refuse('invalid-input', 'spec.crate must be a crate name');
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
  const release = releaseTools(path.resolve(projectRoot, spec.release));
  for (const name of ['HOME', 'RUSTUP_HOME', 'CARGO_HOME']) {
    if (typeof homes[name] !== 'string' || !path.isAbsolute(homes[name])) refuse('invalid-input', `${name} must be an absolute path`);
  }
  const env = { HOME: homes.HOME, RUSTUP_HOME: homes.RUSTUP_HOME, CARGO_HOME: homes.CARGO_HOME, PATH: `${path.join(homes.CARGO_HOME, 'bin')}:/usr/bin:/bin`, RUSTUP_TOOLCHAIN: release.tools.rustToolchain.channel };
  const llbc = path.join(out, `${spec.crate}.llbc`);
  const aeneasDest = path.join(out, 'aeneas-dest');
  return {
    spec: { release: spec.release, crate: spec.crate, publishDir: publishRelative, charonArgs, cargoArgs, aeneasArgs: [] },
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
  const manifestFile = path.join(out, MANIFEST);
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
  const invocation = deriveInvocation(out, manifest, readJson(path.resolve(flags.spec)), homesOf(process.env));
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
  const invocation = deriveInvocation(out, manifest, record.spec, homesOf(record.env ?? {}));
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

// Structural problems in Charon's LLBC that the identity record relies on.
function llbcProblems(file, invocation, sources) {
  let llbc;
  try {
    llbc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return [`the LLBC is not readable JSON: ${error.message}`];
  }
  const translated = llbc?.translated;
  const problems = [];
  if (typeof llbc?.charon_version !== 'string') problems.push('the LLBC records no charon_version');
  if (translated?.options?.dest_file !== invocation.llbc) problems.push('the LLBC names another output path');
  const files = Array.isArray(translated?.files) ? translated.files : null;
  const decls = Array.isArray(translated?.fun_decls) ? translated.fun_decls.filter((decl) => decl !== null) : null;
  if (!files || !decls) return [...problems, 'the LLBC has no files or fun_decls list'];
  const ids = files.map((entry) => entry?.id);
  if (ids.some((id) => !Number.isInteger(id)) || new Set(ids).size !== ids.length) problems.push('the LLBC file ids are not unique integers');
  const defIds = decls.map((decl) => decl?.def_id);
  if (defIds.some((id) => !Number.isInteger(id)) || new Set(defIds).size !== defIds.length) problems.push('the LLBC fun_decls def_ids are not unique integers');
  if (files.some((entry) => entry?.crate_name === invocation.crate && typeof entry?.name?.Local === 'string' && typeof entry.contents !== 'string')) {
    problems.push('a local source file in the LLBC has no contents');
  }
  // Every entry naming a source of the prepared copy must carry its exact contents and the crate label.
  for (const entry of files) {
    const name = entry?.name?.Local;
    if (typeof name !== 'string' || !Object.hasOwn(sources, name)) continue;
    if (entry.crate_name !== invocation.crate) problems.push(`the LLBC labels ${name} with crate ${JSON.stringify(entry.crate_name)}, not ${JSON.stringify(invocation.crate)}`);
    if (typeof entry.contents !== 'string' || sha256(entry.contents) !== sources[name]?.sha256) problems.push(`the LLBC's ${name} is not the prepared source`);
  }
  return problems;
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
  verifyTree({ out });
  const files = beginStage(chain, 'charon');
  const log = path.join(out, 'charon.log');
  const run = runTool(inv.tools.charon.path, inv.charon.argv, inv.charon.cwd, inv.env, log);
  const reasons = toolReasons('Charon', run);
  try {
    verifyTree({ out });
  } catch (error) {
    reasons.push(`verify-tree after Charon: ${error.message}`);
  }
  const llbc = fileState(inv.llbc);
  if (!llbc?.sha256) reasons.push(`Charon produced no LLBC file at ${inv.llbc}`);
  else if (reasons.length === 0) reasons.push(...llbcProblems(inv.llbc, inv, chain.manifest.final.files));
  return settle(files, { ...stageBase(chain, 'charon'), run, logSha256: fileState(log).sha256, llbcSha256: llbc?.sha256 ?? null }, reasons);
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
function publicationPlan(inv, outputs) {
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
  return produced.map((file) => ({ attemptPath: path.join(inv.aeneasDest, file), projectPath: path.join(publishDir, file), sha256: outputs[file] }));
}

function runPublish(chain) {
  const inv = chain.invocation;
  const { out } = chain.attempt;
  const aeneas = chain.stages.aeneas.record;
  if (!exactlyFiles(entriesUnder(inv.aeneasDest), aeneas.outputs)) refuse('attempt-refused', 'the Aeneas outputs changed after the Aeneas stage recorded them');
  const plan = publicationPlan(inv, aeneas.outputs);
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
  return settle(files, { ...stageBase(chain, 'publish'), mapping: plan, ownershipSha256 }, reasons);
}

const STAGE_RUNNERS = { charon: runCharon, aeneas: runAeneas, publish: runPublish };

function run(flags) {
  if (!Object.hasOwn(STAGE_RUNNERS, flags.step)) refuse('usage', `--step must be ${ATTEMPT_STAGES.join(', ')}`);
  return STAGE_RUNNERS[flags.step](loadChain(path.resolve(flags.out), ATTEMPT_STAGES.indexOf(flags.step)));
}

// The completed chain, re-validated with the current invocation, cargo
// configuration, toolchain identity, LLBC, Aeneas-output and published-file
// hashes; the summary record-extraction stores.
function attemptStatus(flags) {
  const chain = loadChain(path.resolve(flags.out), ATTEMPT_STAGES.length);
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
  run: { required: ['out', 'step'], run },
  'attempt-status': { required: ['out'], run: attemptStatus },
};

function parseFlags(argv, required) {
  const flags = {};
  const rest = [...argv];
  while (rest.length > 0) {
    const flag = rest.shift();
    const key = flag.replace(/^--/, '');
    if (![...required, 'format'].includes(key) || key === flag) refuse('usage', `unknown argument ${JSON.stringify(flag)}`);
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
    const flags = parseFlags(argv.slice(1), command.required);
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
