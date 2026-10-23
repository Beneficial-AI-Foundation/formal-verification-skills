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
    '',
    'Applies the translation patches in DIR/translation-patches, in the order listed',
    'in DIR/translation-patches/series (one file name per line, every patch exactly',
    'once), to a disposable copy of the Rust extraction input set (extraction.inputs',
    'in .formalising/fvs-config.json, default Cargo.toml, Cargo.lock, build.rs, src).',
    'The original checkout is never written. check rehearses the list in a temporary',
    'copy; prepare builds OUT/tree and OUT/manifest.json (OUT must be a new directory',
    'outside the project); verify-restore compares the touched original sources with',
    'the recorded start; verify-tree compares OUT/tree with the tree prepare recorded;',
    'status reads the manifest. migrate turns an active legacy src-modifications ledger',
    'into translation patches (one per hunk, entries from src-modifications.json kept',
    'verbatim) and marks the ledger inactive in place with',
    'src-modifications.inactive.json; it never edits the ledger or the source.',
    '',
    'Exit codes: 0 ok; 1 a patch does not fit (stale, already applied, not reversible,',
    'or not independent although it declares Independent: yes); 2 usage or internal',
    'error; 3 dirty original; 4 mixed or legacy mode; 5 invalid input; 6 partial manifest;',
    '7 the extraction copy changed after prepare.',
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
  return { ...publicPatch(patch), pre, post };
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
    // The exact tree handed to the next stage: the touched set's hash and every input file.
    manifest.final = {
      touchedSha256: sha256(JSON.stringify(touchedState(tree, context.touched))),
      files: walkInputs(tree, context.inputs),
    };
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

// The copy as it is now against the tree prepare recorded, so a later stage
// can show that what it consumed is what the manifest describes.
function verifyTree(flags) {
  const manifest = readManifest(flags.out);
  if (manifest.status !== 'prepared' || !manifest.final) {
    refuse('partial', 'the manifest records no prepared extraction copy; there is no recorded tree to verify', { status: manifest.status });
  }
  const actual = walkInputs(manifest.tree, manifest.source.inputs);
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

const COMMANDS = {
  check: { required: ['project-root'], run: check },
  prepare: { required: ['project-root', 'out'], run: prepare },
  'verify-restore': { required: ['out'], run: verifyRestore },
  'verify-tree': { required: ['out'], run: verifyTree },
  status: { required: ['out'], run: status },
  migrate: { required: ['project-root'], run: migrate },
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
