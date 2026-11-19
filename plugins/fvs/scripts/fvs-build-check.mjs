#!/usr/bin/env node
// Build check: build one commit of a Lean project in a fresh clean copy and report
// what the build proves.
//
//   node fvs-build-check.mjs --project-root R --commit SHA [--spec-base SHA]
//        [--packages DIR] [--receipt-dir DIR] [--workdir DIR] [--keep] [--timeout SECONDS]
//
// The copy holds exactly the tracked files of the commit, never the author's working
// tree, and the project's own .lake/build is never copied, so every project module is
// rebuilt and every warning fires again. Only the prebuilt dependency packages are
// reused, cloned copy-on-write where the filesystem allows. They are checked first: a
// dependency that Lake would rebuild (a Mathlib built for another revision, a missing
// package) stops the check before any build starts.
//
// Before any build, two guards run on the commit's files. The spec guard compares the commit with the
// merged spec (the spec merge commit the run state records, or --spec-base; they must agree): every
// recalled statement must be the same text, the lakefile, the manifest, Specs/Defs, Trusted and
// every extraction folder (any folder named Extraction..., and each publish folder or published file
// the run state records for a multi-crate extraction) must be unchanged apart from comments,
// docstrings and axiom guards, nothing may add `sorry`, `admit`, `native_decide`, `bv_decide` or an
// axiom outside Trusted/, a lakefile may not appear below the project root, and a new Trusted file
// is allowed only for axioms tied to an externals record the owner accepted. Strings are compared
// exactly; only comments and the spacing between tokens are free. The glob guard refuses a spec,
// proof or extraction file that no lean_lib glob of a default target reaches, because Lake would
// never compile it. A commit that fails a guard gets a failed receipt and no build runs.
//
// The build is `lake build --wfail`: every warning, so every `sorry`, fails it. Each
// spec file restates its statements with `recall` and pins what they rest on with
// `#guard_msgs ... in #print axioms NAME`; the build enforces those guards, and this
// script refuses a pass that rests on guards it cannot read or that say nothing.
//
// A verdict, accepted or not, is written as a receipt bound to the commit and its tree.
// Output: stdout holds one JSON object and nothing else; the report for people goes to stderr.
// Exit status 0 accepted, 1 build check failed, 2 refused.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const LABEL_ACCEPTED = 'accepted (build check)';
export const labelFailed = (reason) => `build check failed: ${reason}`;
const STANDARD_AXIOMS = ['propext', 'Classical.choice', 'Quot.sound'];
// What native_decide and bv_decide add to #print axioms: a generated axiom named after the
// theorem on Lean 4.35, Lean.ofReduceBool on older toolchains.
const NATIVE_AXIOM = /\._native\.(native_decide|bv_decide)\.ax_|^Lean\.(ofReduceBool|trustCompiler)$/;
const SHA_ARGUMENT = /^[0-9a-f]{7,64}$/i;
const FAILED_TARGETS = /^Some required targets logged failures:\s*$/m;
const LOG_MESSAGE = /^(error|warning|info): (.+?):(\d+):(\d+): (.*)$/;

class Refusal extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const refuse = (code, message) => { throw new Refusal(code, message); };
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function gitEnvironment(extra = {}) {
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']) delete env[name];
  return { ...env, ...extra };
}

function git(cwd, args, extra = {}) {
  const run = spawnSync('git', ['--no-optional-locks', '-C', cwd, ...args], { encoding: 'utf8', env: gitEnvironment(extra), maxBuffer: 64 * 1024 * 1024 });
  return run.status === 0 ? run.stdout.trim() : null;
}

// ---- reading Lean source -------------------------------------------------------------------

const IDENTIFIER_CHARACTER = /[\p{L}\p{N}_'.!?]/u;
const RAW_STRING = /r(#*)"/y;
const CHARACTER = /'(?:\\(?:x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[^xu\n])|[^\\'\n])'/y;

// Comments are blanked and docstrings are replaced by a numbered marker, so the text that
// is left can be matched without a commented-out guard counting. Line numbers are kept. String
// and character literals are blanked too. With `keepStrings` each literal is replaced by a
// numbered placeholder instead and returned in `strings`, so a comparison sees an edited string
// exactly while code inside it never looks like code.
export function stripLean(text, { keepStrings = false } = {}) {
  const docstrings = [];
  const strings = [];
  let code = '';
  let i = 0;
  const blockEnd = (from) => {
    let depth = 1;
    let j = from + 2;
    while (j < text.length && depth > 0) {
      if (text.startsWith('/-', j)) { depth += 1; j += 2; } else if (text.startsWith('-/', j)) { depth -= 1; j += 2; } else j += 1;
    }
    return j;
  };
  const newlines = (slice) => slice.replace(/[^\n]/g, '');
  // Where the literal that starts at `at` ends, or -1 when none starts there. An `r` or a quote that
  // follows an identifier character belongs to that identifier (`h'`, `bar`), not to a literal.
  const literalEnd = (at) => {
    if (text[at] === '"') {
      let j = at + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      return Math.min(j + 1, text.length);
    }
    if (at > 0 && IDENTIFIER_CHARACTER.test(text[at - 1])) return -1;
    if (text[at] === 'r') {
      RAW_STRING.lastIndex = at;
      const open = RAW_STRING.exec(text);
      if (!open) return -1;
      const close = `"${open[1]}`;
      const stop = text.indexOf(close, at + open[0].length);
      return stop < 0 ? text.length : stop + close.length;
    }
    if (text[at] === "'") {
      CHARACTER.lastIndex = at;
      const literal = CHARACTER.exec(text);
      return literal ? at + literal[0].length : -1;
    }
    return -1;
  };
  while (i < text.length) {
    if (text.startsWith('/--', i)) {
      const end = blockEnd(i);
      docstrings.push(text.slice(i + 3, Math.max(i + 3, end - 2)));
      code += `/--#${docstrings.length - 1}-/${newlines(text.slice(i, end))}`;
      i = end;
    } else if (text.startsWith('/-', i)) {
      const end = blockEnd(i);
      code += newlines(text.slice(i, end));
      i = end;
    } else if (text.startsWith('--', i)) {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else {
      const end = literalEnd(i);
      if (end < 0) {
        code += text[i];
        i += 1;
      } else {
        const literal = text.slice(i, end);
        if (keepStrings) {
          strings.push(literal);
          code += `\u0000${strings.length - 1}\u0000`;
        } else code += literal[0] === "'" ? "'?'" : `""${newlines(literal)}`;
        i = end;
      }
    }
  }
  return { code, docstrings, strings };
}

const lineOf = (code, index) => code.slice(0, index).split('\n').length;

// What a guard docstring says the statement rests on, or why it says nothing.
function readGuard(docstring, options) {
  if (/\bdrop\b/.test(options ?? '')) return { problem: 'the guard drops messages' };
  const text = docstring.trim();
  if (text === '') return { problem: 'the guard expects nothing' };
  if (/does not depend on any axioms/.test(text)) return { axioms: [] };
  const list = text.match(/\[([^\]]*)\]/);
  if (!list) return { problem: 'the guard lists no axioms' };
  const axioms = list[1].split(',').map((name) => name.trim()).filter(Boolean);
  if (axioms.length === 0) return { problem: 'the guard lists no axioms' };
  if (axioms.includes('sorryAx')) return { problem: 'the statement rests on sorryAx' };
  return { axioms };
}

// The statements of one source file: each `recall NAME` and each guarded `#print axioms NAME`,
// paired by name. A spec file is one that has either. Nothing that cannot be paired is guessed.
export function readSpecSource(text) {
  const { code, docstrings } = stripLean(text);
  const statements = new Map();
  const entry = (name, line) => {
    if (!statements.has(name)) statements.set(name, { name, line, recallLine: null, guardLine: null, guardFrom: null, guardTo: null, axioms: null, problems: [] });
    return statements.get(name);
  };
  for (const match of code.matchAll(/^[ \t]*recall\s+([^\s(\[{:]+)/gm)) {
    const line = lineOf(code, match.index);
    const statement = entry(match[1], line);
    statement.recallLine = statement.recallLine ?? line;
  }
  const guard = /\/--#(\d+)-\/\s*#guard_msgs\s*(?:\(([^)]*)\))?\s*in\s+#print\s+axioms\s+(\S+)/g;
  for (const match of code.matchAll(guard)) {
    const line = lineOf(code, match.index + match[0].indexOf('#guard_msgs'));
    const statement = entry(match[3], line);
    const read = readGuard(docstrings[Number(match[1])], match[2]);
    statement.guardLine = line;
    statement.guardFrom = lineOf(code, match.index);
    statement.guardTo = lineOf(code, match.index + match[0].length - 1);
    if (read.problem) statement.problems.push(read.problem); else statement.axioms = read.axioms;
  }
  for (const statement of statements.values()) {
    if (statement.recallLine === null) statement.problems.push('not restated with recall');
    if (statement.guardLine === null) statement.problems.push('no #guard_msgs on #print axioms');
    statement.flags = (statement.axioms ?? []).filter((name) => NATIVE_AXIOM.test(name))
      .map((name) => (name.includes('bv_decide') ? 'bv_decide' : name.includes('native_decide') ? 'native_decide' : 'native_decide or bv_decide'));
    statement.beyondStandard = (statement.axioms ?? []).filter((name) => !STANDARD_AXIOMS.includes(name) && !NATIVE_AXIOM.test(name));
  }
  return { statements: [...statements.values()] };
}

// ---- reading a Lake log --------------------------------------------------------------------

export function readLog(text) {
  const messages = [];
  for (const line of text.split('\n')) {
    const match = LOG_MESSAGE.exec(line);
    if (match) messages.push({ severity: match[1], file: match[2], line: Number(match[3]), text: match[5].trim() });
  }
  const at = text.search(FAILED_TARGETS);
  const failedTargets = at < 0 ? [] : text.slice(at).split('\n').slice(1).map((line) => /^- (.+)$/.exec(line)?.[1]).filter(Boolean);
  return { messages, failedTargets };
}

const firstProblem = (messages) => messages.find((m) => m.severity === 'error') ?? messages.find((m) => m.severity === 'warning') ?? null;
const describe = (m) => `${m.file}:${m.line}: ${m.text}`.slice(0, 240);

// ---- the clean copy ------------------------------------------------------------------------

function leanFiles(root) {
  const files = [];
  const links = [];
  const walk = (directory) => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      if (item.name === '.lake' || item.name.startsWith('.git')) continue;
      const full = path.join(directory, item.name);
      if (item.isSymbolicLink()) links.push(path.relative(root, full));
      else if (item.isDirectory()) walk(full);
      else if (item.name.endsWith('.lean') || item.name === 'lakefile.toml') files.push(path.relative(root, full));
    }
  };
  walk(root);
  return { files: files.sort(), links: links.sort() };
}

const LEAN_FILE_NAME = /\.lean$|^lakefile\.|^lake-manifest\.json$|^lean-toolchain$/;

// A symbolic link whose final target stays inside the commit is covered by the commit's tree. One
// that leaves it lets the build read something the commit does not record: that fails the check
// when the target is a folder or a Lean file or lakefile, and is only a warning for other files.
// A link that cannot be resolved (dangling, looping) cannot be read by the build either.
function checkSymlinks(cleanRoot, leanRoot, links) {
  const root = fs.realpathSync(cleanRoot);
  const hard = [];
  const soft = [];
  for (const rel of links) {
    let real;
    try { real = fs.realpathSync(path.join(leanRoot, rel)); } catch { continue; }
    if (real === root || real.startsWith(`${root}${path.sep}`)) continue;
    (fs.statSync(real).isDirectory() || LEAN_FILE_NAME.test(path.basename(rel)) ? hard : soft).push(rel);
  }
  return { hard, soft };
}

const hasLakefile = (directory) => ['lakefile.toml', 'lakefile.lean'].some((name) => fs.existsSync(path.join(directory, name)));

// The Lean project of the copy: where the project root is, else the one folder below it.
function leanProjectIn(start) {
  if (hasLakefile(start)) return '';
  const nested = fs.readdirSync(start, { withFileTypes: true })
    .filter((item) => item.isDirectory() && !item.name.startsWith('.') && hasLakefile(path.join(start, item.name))).map((item) => item.name);
  return nested.length === 1 ? nested[0] : null;
}

function readManifest(leanRoot) {
  const file = path.join(leanRoot, 'lake-manifest.json');
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).packages ?? []; } catch { return refuse('manifest-unreadable', `lake-manifest.json at the commit is not valid JSON`); }
}

// Packages are reusable only if each one is the very revision the manifest at the commit asks for.
function checkPackages({ packages, source, cleanRoot, leanRoot }) {
  const revisions = {};
  for (const item of packages) {
    if (item.type === 'path') {
      const target = path.resolve(leanRoot, item.dir ?? '');
      if (target !== cleanRoot && !target.startsWith(`${cleanRoot}${path.sep}`)) {
        refuse('path-dependency-outside-tree', `the dependency ${item.name} is a path dependency at ${item.dir}, which is not part of the commit; no build ran`);
      }
      continue;
    }
    const directory = path.join(source, item.name);
    const found = fs.existsSync(directory) ? git(directory, ['rev-parse', 'HEAD']) : null;
    if (found === null) refuse('packages-missing', `the dependency ${item.name} is not prebuilt in ${source}; no build ran, to avoid rebuilding it`);
    if (found.toLowerCase() !== String(item.rev).toLowerCase()) {
      refuse('packages-differ', `the dependency ${item.name} is at ${found.slice(0, 12)} in ${source} but the commit's manifest needs ${String(item.rev).slice(0, 12)}; no build ran, to avoid rebuilding it`);
    }
    if (git(directory, ['status', '--porcelain', '--untracked-files=no']) !== '') {
      refuse('packages-modified', `the dependency ${item.name} in ${source} has modified tracked files, so it is not the revision the manifest names; no build ran`);
    }
    revisions[item.name] = found;
  }
  return revisions;
}

// A cloned copy shares disk blocks with the original and cannot change it; where the filesystem
// cannot clone, a full copy is as safe and only slower.
function copyPackages(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const real = fs.realpathSync(source);
  const attempts = process.platform === 'darwin' ? [['-cRp', 'clone'], ['-Rp', 'full']] : [['-a', 'full']];
  if (process.platform === 'linux') attempts.unshift(['-a', 'clone', '--reflink=always']);
  for (const [flags, mode, extra] of attempts) {
    fs.rmSync(destination, { recursive: true, force: true });
    const args = [flags, ...(extra ? [extra] : []), real, destination];
    if (spawnSync('cp', args, { stdio: 'ignore' }).status === 0) return mode;
  }
  return refuse('packages-not-copied', `the prebuilt packages in ${source} could not be copied`);
}

function extractCommit(top, commit, workdir, cleanRoot) {
  const index = path.join(workdir, 'index');
  if (git(top, ['read-tree', commit], { GIT_INDEX_FILE: index }) === null) refuse('commit-unreadable', `cannot read the files of ${commit}`);
  fs.mkdirSync(cleanRoot, { recursive: true });
  if (git(top, ['checkout-index', '-a', '-f', `--prefix=${cleanRoot}${path.sep}`], { GIT_INDEX_FILE: index }) === null) refuse('commit-unreadable', `cannot write the files of ${commit}`);
}

// The libraries and executables the project declares itself.
function declaredTargets(leanRoot) {
  const names = new Set();
  for (const file of ['lakefile.toml', 'lakefile.lean']) {
    const full = path.join(leanRoot, file);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const section of text.split(/^\[\[/m).slice(1)) {
      if (!/^(lean_lib|lean_exe)\]\]/.test(section)) continue;
      const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(section)?.[1];
      if (name) names.add(name);
      for (const root of /^\s*roots\s*=\s*\[([^\]]*)\]/m.exec(section)?.[1].matchAll(/"([^"]+)"/g) ?? []) names.add(root[1]);
    }
    for (const match of text.matchAll(/^\s*lean_(?:lib|exe)\s+(?:«([^»]+)»|([\w.]+))/gm)) names.add(match[1] ?? match[2]);
  }
  return names;
}

// A target is the project's own if it is one of its modules or declared targets. Anything else
// would come from a dependency, and a dependency is never rebuilt here.
function dependencyTargets(targets, files, declared) {
  return targets.filter((target) => {
    const base = target.replace(/^\+/, '').split(':')[0];
    const rel = `${base.replaceAll('.', '/')}.lean`;
    return !(declared.has(base) || files.some((file) => file === rel || file.endsWith(`/${rel}`)));
  });
}

function runLake(args, { cwd, env, log, timeoutSeconds }) {
  const wrapper = process.platform === 'darwin' && spawnSync('sh', ['-c', 'command -v caffeinate'], { stdio: 'ignore' }).status === 0 ? ['caffeinate', '-is'] : [];
  const argv = [...wrapper, 'nice', '-n', '19', 'lake', ...args];
  const out = fs.openSync(log, 'w');
  try {
    // The child leads its own process group. A timeout kills only that child, so the whole group is
    // killed once the run returns: no Lean worker may outlive the check and overlap the next build.
    const run = spawnSync(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', out, out], timeout: timeoutSeconds * 1000, detached: true });
    if (run.pid) { try { process.kill(-run.pid, 'SIGKILL'); } catch { /* the group is already gone */ } }
    return { argv, status: run.status ?? (run.error ? 124 : 1) };
  } finally { fs.closeSync(out); }
}

// One build at a time on this machine, whatever the project or the receipt folder.
function acquireLock() {
  const lock = path.join(os.tmpdir(), 'fvs-build-check.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
      return () => fs.rmSync(lock, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let pid = NaN;
      try { pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8').trim()); } catch { /* being taken or released */ }
      let alive = !Number.isInteger(pid) && fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs < 5000;
      if (Number.isInteger(pid) && pid > 0) { alive = true; try { process.kill(pid, 0); } catch (killed) { alive = killed.code === 'EPERM'; } }
      if (alive) refuse('build-check-running', `another build check is running${Number.isInteger(pid) ? ` (process ${pid})` : ''}; one build runs at a time`);
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }
  return refuse('build-check-running', 'the build check lock could not be taken');
}

// ---- what may change after the merged spec -------------------------------------------------
//
// The proofs are written after the owner merged the spec, so "accepted" must also mean that the
// statements and what they rest on are the merged ones. Both trees are read from git objects, never
// from a working tree. A change is judged on Lean text with comments, docstrings and axiom guards
// taken out and whitespace collapsed to one space, so those edits are free and nothing else is.

const lowerFolders = (rel) => rel.toLowerCase().split('/').slice(0, -1);
const LAKE_FILES = /^(?:lakefile\.(?:toml|lean)|lake-manifest\.json)$/;
const isTrusted = (rel) => lowerFolders(rel).includes('trusted');
const isProofPath = (rel) => lowerFolders(rel).includes('proofs');

// Extraction output: any folder whose name starts with "extraction" (Extraction, ExtractionCrates),
// plus the folders and files the run state says an extraction published into. `layout` is that
// second part: lowercase folders with a trailing slash, and lowercase file paths.
export function isExtraction(rel, layout = {}) {
  const lower = rel.toLowerCase();
  return lowerFolders(rel).some((name) => name.startsWith('extraction'))
    || (layout.folders ?? []).some((folder) => lower.startsWith(folder))
    || (layout.files ?? []).includes(lower);
}

// Frozen once the spec is merged. Folder names match in any case: the default layout is
// formal/trusted and a real project may say Formal/Trusted.
export function isFrozen(rel, layout = {}) {
  const folders = lowerFolders(rel);
  return LAKE_FILES.test(rel) || folders.includes('trusted') || isExtraction(rel, layout)
    || folders.some((name, i) => name === 'specs' && folders[i + 1] === 'defs');
}

const DECLARATION = /(?:^|\s)(?:theorem|lemma|def|abbrev|axiom|instance|opaque|structure|inductive|class|recall|notation|macro|syntax)\s+([^\s(\[{:]+)/g;
// The declaration a position falls in, so a message can name it. Null before the first one.
const declarationNear = (code, index) => [...code.slice(0, index + 1).matchAll(DECLARATION)].at(-1)?.[1] ?? null;

// Comments gone, docstring markers gone, axiom guards gone, whitespace runs collapsed to one space,
// then each string put back exactly as written.
const flatten = (code, strings) => code
  .replace(/\/--#\d+-\//g, ' ')
  .replace(/#guard_msgs\s*(?:\([^)]*\))?\s*in\s+#print\s+axioms\s+\S+/g, ' ')
  .replace(/#print\s+axioms\s+\S+/g, ' ')
  .replace(/\s+/g, ' ').trim()
  .replace(/\u0000(\d+)\u0000/g, (_, n) => strings[Number(n)]);

export const normalizeLean = (text) => { const { code, strings } = stripLean(text, { keepStrings: true }); return flatten(code, strings); };

// Each `recall` statement of a spec file as its text, comments gone and whitespace collapsed. A
// statement runs to the next line that starts in column 0.
export function recalledStatements(text) {
  const { code, strings } = stripLean(text, { keepStrings: true });
  const statements = new Map();
  for (const match of code.matchAll(/^[ \t]*recall\s+([^\s(\[{:]+)/gm)) {
    const ending = /\n(?=\S)/g;
    ending.lastIndex = match.index + match[0].length;
    const stop = ending.exec(code);
    statements.set(match[1], flatten(code.slice(match.index, stop ? stop.index : code.length), strings));
  }
  return statements;
}

// Where two texts first differ, as a short piece of each.
function firstDifference(was, now) {
  let at = 0;
  while (at < was.length && at < now.length && was[at] === now[at]) at += 1;
  const start = Math.max(0, at - 30);
  return { index: at, was: was.slice(start, at + 50), now: now.slice(start, at + 50) };
}

const fileEntry = (blob, read) => { let text; return { blob, text: () => (text ??= read().toString('utf8')) }; };
// A tree held in memory, for a caller that has no repository to read.
export const memoryTree = (files) => new Map(Object.entries(files).map(([rel, text]) => [rel, fileEntry(sha256(text), () => Buffer.from(text))]));

function gitBlob(top, blob) {
  const run = spawnSync('git', ['--no-optional-locks', '-C', top, 'cat-file', 'blob', blob], { env: gitEnvironment(), maxBuffer: 256 * 1024 * 1024 });
  if (run.status !== 0) refuse('commit-unreadable', `cannot read the file ${blob}`);
  return run.stdout;
}

const LAKEFILE_AT = /(?:^|\/)lakefile\.(?:toml|lean)$/;

// Files below a folder with a lakefile of its own belong to another Lake project, not to this one.
// The folders are read from the merged spec's tree when there is one: a lakefile that appears
// only afterwards must not take the files below it out of the comparison.
const nestedFolders = (tree) => [...tree.keys()].filter((rel) => rel.includes('/') && LAKEFILE_AT.test(rel)).map((rel) => rel.slice(0, rel.lastIndexOf('/') + 1));
const without = (tree, folders) => new Map([...tree].filter(([rel]) => !folders.some((folder) => rel.startsWith(folder))));

// The Lean sources, lakefiles and frozen files of the project at `prefix` in one commit.
export function gitTree(top, commit, prefix, layout) {
  const listing = git(top, ['ls-tree', '-r', '-z', '--full-tree', commit, ...(prefix ? ['--', `${prefix}/`] : [])]);
  if (listing === null) refuse('commit-unreadable', `cannot list the files of ${commit}`);
  const tree = new Map();
  for (const line of listing.split('\0').filter(Boolean)) {
    const tab = line.indexOf('\t');
    const [, type, blob] = line.slice(0, tab).split(' ');
    const name = line.slice(tab + 1);
    const rel = prefix ? name.slice(prefix.length + 1) : name;
    if (type === 'blob' && (rel.endsWith('.lean') || isFrozen(rel, layout) || LAKEFILE_AT.test(rel))) tree.set(rel, fileEntry(blob, () => gitBlob(top, blob)));
  }
  return tree;
}

const hasStatements = (text) => readSpecSource(text).statements.length > 0;

// What `sorry`, `admit`, a native check or an axiom outside Trusted/ would add. Counted on code
// alone, so a mention in a comment or a string does not count.
const FORBIDDEN = [['sorry', /\bsorry\b/g], ['admit', /\badmit\b/g], ['native_decide', /\bnative_decide\b/g], ['bv_decide', /\bbv_decide\b/g],
  ['decide +native', /\bdecide\s*\+\s*native\b/g], ['axiom', /\baxiom\b/g]];

// An axiom that starts a line, read from the raw text with no lexer in between. If the comment and
// string reader were ever thrown off by odd source, an axiom declared on its own line is still seen.
// It must read like a declaration (a name, then a colon or a binder), so prose that starts a line with
// "axiom" in a docstring is not one. A docstring line that does read like one, such as
// "axiom foo (see above)", is seen too, and counts.
const RAW_AXIOM = /^[ \t]*(?:@\[[^\]\n]*\][ \t]*)*(?:(?:private|protected|noncomputable|unsafe)[ \t]+)*axiom[ \t]+([\p{L}_«][\p{L}\p{N}_.'!?«»]*)(?=\s*[:({\[⦃])/gmu;
const rawAxioms = (text) => [...text.matchAll(RAW_AXIOM)].map((match) => match[1]);

function forbiddenAdded(rel, was, now, problems) {
  const before = was === null ? '' : stripLean(was).code;
  const after = stripLean(now).code;
  for (const [token, pattern] of FORBIDDEN) {
    if (token === 'axiom' && isTrusted(rel)) continue;
    const had = [...before.matchAll(pattern)].length;
    const found = [...after.matchAll(pattern)];
    if (found.length > had) {
      const named = token === 'axiom' ? /^axiom\s+([^\s(\[{:]+)/.exec(after.slice(found[had].index))?.[1] ?? null : declarationNear(after, found[had].index);
      problems.push({ kind: 'forbidden-added', file: rel, statement: named, token, detail: `${token} was added (${had} before, ${found.length} now)${token === 'axiom' ? '; an axiom belongs in Trusted/ and needs an accepted externals record' : ''}` });
    }
  }
  if (!isTrusted(rel) && !problems.some((problem) => problem.file === rel && problem.token === 'axiom')) {
    const [had, found] = [rawAxioms(was ?? ''), rawAxioms(now)];
    if (found.length > had.length) {
      problems.push({ kind: 'forbidden-added', file: rel, statement: found[had.length], token: 'axiom', detail: `axiom was added (${had.length} before, ${found.length} now); an axiom belongs in Trusted/ and needs an accepted externals record` });
    }
  }
}

const AXIOM = /(?:\/--#(\d+)-\/\s*)?(?:@\[[^\]]*\]\s*)*(?:(?:private|protected|noncomputable|unsafe)\s+)*\baxiom\s+([^\s(\[{:]+)/g;
const EXTRA_COMMAND = /(?:^|\s)(?:@\[[^\]]*\]\s*)*(?:(?:private|protected|noncomputable|unsafe|partial|local|scoped)\s+)*(def|theorem|lemma|instance|macro_rules|macro|syntax|elab|notation|infixl|infixr|infix|prefix|postfix|attribute|set_option|opaque|abbrev|structure|inductive|class|example|initialize|run_cmd|#[a-z_]+)(?=\s)/;

// A new Trusted file is allowed only for axioms the owner accepted: each axiom's docstring names, in
// backticks, the id of an externals record with status assumption-accepted, one axiom for each record.
function trustedAddition(rel, text, records, used, problems, ties) {
  const { code, docstrings } = stripLean(text);
  const extra = EXTRA_COMMAND.exec(normalizeLean(text));
  if (extra) problems.push({ kind: 'trusted-file-extra-code', file: rel, statement: null, detail: `a new Trusted file may hold only imports, namespaces and axioms, not \`${extra[1]}\`` });
  const accepted = new Map((records ?? []).filter((record) => record?.status === 'assumption-accepted' && record.decision && typeof record.id === 'string').map((record) => [record.id, record]));
  const seen = new Set([...code.matchAll(AXIOM)].map((match) => match[2]));
  // An axiom that starts a line but that the comment-aware scan did not see has no docstring to tie it.
  for (const name of rawAxioms(text)) {
    if (!seen.has(name)) problems.push({ kind: 'trusted-axiom-untied', file: rel, statement: name, detail: `the new axiom ${name} is not tied to an accepted assumption: it could not be read together with its docstring; put it in its own declaration with the record id in backticks in its docstring` });
  }
  for (const match of code.matchAll(AXIOM)) {
    const name = match[2];
    const doc = match[1] === undefined ? '' : docstrings[Number(match[1])];
    const cited = [...doc.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim()).filter((id) => accepted.has(id));
    const free = cited.find((id) => !used.has(id));
    if (free) {
      used.set(free, name);
      ties.push({ file: rel, axiom: name, record: free });
    } else {
      const why = cited.length > 0 ? `the record ${cited[0]} is already tied to axiom ${used.get(cited[0])}`
        : `its docstring names no externals record with status assumption-accepted${accepted.size === 0 ? ' (none is recorded)' : ''}`;
      problems.push({ kind: 'trusted-axiom-untied', file: rel, statement: name, detail: `the new axiom ${name} is not tied to an accepted assumption: ${why}; name the record id in backticks in the axiom's docstring` });
    }
  }
}

function specChange(rel, was, now, problems) {
  const before = recalledStatements(was);
  const after = recalledStatements(now);
  const found = problems.length;
  for (const [name, text] of before) {
    if (!after.has(name)) problems.push({ kind: 'statement-removed', file: rel, statement: name, detail: `the statement ${name} is no longer restated with recall` });
    else if (after.get(name) !== text) {
      const diff = firstDifference(text, after.get(name));
      problems.push({ kind: 'statement-changed', file: rel, statement: name, detail: `the statement ${name} changed since the merged spec: was "…${diff.was}", now "…${diff.now}"` });
    }
  }
  for (const name of after.keys()) {
    if (!before.has(name)) problems.push({ kind: 'statement-added', file: rel, statement: name, detail: `the statement ${name} is not in the merged spec` });
  }
  if (problems.length === found) {
    const [a, b] = [normalizeLean(was), normalizeLean(now)];
    if (a !== b) {
      const diff = firstDifference(a, b);
      problems.push({ kind: 'spec-code-changed', file: rel, statement: declarationNear(b, diff.index), detail: `code outside the comments and guards changed since the merged spec: was "…${diff.was}", now "…${diff.now}"` });
    }
  }
}

function frozenChange(rel, was, now, problems) {
  if (!rel.endsWith('.lean')) {
    problems.push({ kind: 'frozen-file-changed', file: rel, statement: null, detail: 'this frozen file differs from the merged spec' });
    return;
  }
  const [a, b] = [normalizeLean(was.text()), normalizeLean(now.text())];
  if (a === b) return;
  const diff = firstDifference(a, b);
  problems.push({ kind: 'frozen-file-changed', file: rel, statement: declarationNear(b, diff.index), detail: `this frozen file changed beyond comments and guards since the merged spec: was "…${diff.was}", now "…${diff.now}"` });
}

// ---- Lake globs ----------------------------------------------------------------------------

const noComment = (line) => {
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '\\' && quoted) i += 1;
    else if (line[i] === '"') quoted = !quoted;
    else if (line[i] === '#' && !quoted) return line.slice(0, i);
  }
  return line;
};
const quotedStrings = (value) => [...value.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);

// The few lakefile.toml settings that decide which modules a bare `lake build` compiles.
export function readLakefileToml(text) {
  const lake = { srcDir: '.', defaultTargets: [], libs: [] };
  let where = lake;
  let open = null;
  const set = (key, value) => {
    const strings = quotedStrings(value);
    const array = value.trim().startsWith('[');
    if (where === lake && key === 'srcDir' && strings[0] !== undefined) lake.srcDir = strings[0];
    else if (where === lake && key === 'defaultTargets') lake.defaultTargets = strings;
    else if (where && where !== lake && ['roots', 'globs'].includes(key)) where[key] = array ? strings : strings.slice(0, 1);
    else if (where && where !== lake && key === 'srcDir' && strings[0] !== undefined) where.srcDir = strings[0];
  };
  for (const raw of text.split('\n')) {
    const line = noComment(raw);
    if (open) {
      open.value += ` ${line}`;
      if ((open.value.match(/\[/g) ?? []).length <= (open.value.match(/\]/g) ?? []).length) { set(open.key, open.value); open = null; }
      continue;
    }
    const table = /^\s*\[\[\s*([\w.-]+)\s*\]\]\s*$/.exec(line);
    if (table) {
      if (table[1] === 'lean_lib') { where = { name: null, roots: null, globs: null, srcDir: null }; lake.libs.push(where); } else where = null;
      continue;
    }
    if (/^\s*\[[^[]/.test(line)) { where = null; continue; }
    const pair = /^\s*([A-Za-z_][\w-]*)\s*=\s*(.*)$/.exec(line);
    if (!pair) continue;
    if (pair[1] === 'name' && where && where !== lake) { where.name = quotedStrings(pair[2])[0] ?? null; continue; }
    if (pair[2].trim().startsWith('[') && (pair[2].match(/\[/g) ?? []).length > (pair[2].match(/\]/g) ?? []).length) open = { key: pair[1], value: pair[2] };
    else set(pair[1], pair[2]);
  }
  return lake;
}

const globOf = (source) => {
  const [, name, mark] = /^(.*?)(?:\.([+*]))?$/.exec(source);
  const names = name.replaceAll(/[«»]/g, '');
  return { source, matches: (module) => (mark === '+' ? module.startsWith(`${names}.`) : mark === '*' ? module === names || module.startsWith(`${names}.`) : module === names) };
};

const IMPORT = /^[ \t]*(?:(?:public|meta)[ \t]+)*import[ \t]+(?:all[ \t]+)?(\S+)/gm;

// The Lean files of `head` that a bare `lake build` compiles: those a lean_lib glob of a default target
// matches, and the modules a built module imports. Null when the lakefile is not a readable
// lakefile.toml: a project with a lakefile.lean is not read here, and the check for a missing .olean
// is the backstop.
function builtFiles(head) {
  const toml = head.get('lakefile.toml');
  if (!toml || head.has('lakefile.lean')) return null;
  const lake = readLakefileToml(toml.text());
  // The folder a library's modules live in, with a trailing slash; empty for the project root.
  const folderOf = (lib) => { const dir = path.posix.normalize(path.posix.join(lake.srcDir, lib.srcDir ?? '.')); return dir === '.' ? '' : `${dir}/`; };
  const direct = lake.libs.filter((lib) => lib.name && lake.defaultTargets.includes(lib.name))
    .map((lib) => ({ name: lib.name, folder: folderOf(lib), globs: (lib.globs ?? lib.roots ?? [lib.name]).map(globOf) }));
  const sources = [...new Set(lake.libs.map(folderOf))];
  const leanFilesHere = [...head.keys()].filter((rel) => rel.endsWith('.lean') && !LAKE_FILES.test(rel) && !rel.startsWith('.lake/'));
  const moduleOf = (rel, folder) => (rel.startsWith(folder) ? rel.slice(folder.length, -'.lean'.length).replaceAll('/', '.') : null);
  const covered = new Set(leanFilesHere.filter((rel) => direct.some((lib) => {
    const module = moduleOf(rel, lib.folder);
    return module !== null && lib.globs.some((glob) => glob.matches(module));
  })));
  const queue = [...covered];
  while (queue.length > 0) {
    const rel = queue.pop();
    for (const match of stripLean(head.get(rel).text()).code.matchAll(IMPORT)) {
      const wanted = `${match[1].replaceAll(/[«»]/g, '').replaceAll('.', '/')}.lean`;
      for (const dir of sources) {
        const found = `${dir}${wanted}`;
        if (head.has(found) && !covered.has(found)) { covered.add(found); queue.push(found); }
      }
    }
  }
  return { direct, sources, leanFilesHere, moduleOf, covered };
}

// A spec, proof or extraction file whose module no lean_lib glob of a default target reaches is never
// built by a bare `lake build`, though the build passes. Modules that a built module imports are built too.
function globProblems(head, changed, layout) {
  const built = builtFiles(head);
  if (built === null) return [];
  const { direct, sources, leanFilesHere, moduleOf, covered } = built;
  const problems = [];
  for (const rel of leanFilesHere.sort()) {
    if (covered.has(rel) || !(changed.has(rel) || isProofPath(rel) || isExtraction(rel, layout) || hasStatements(head.get(rel).text()))) continue;
    const module = sources.map((folder) => moduleOf(rel, folder)).find((name) => name !== null) ?? rel;
    const reach = direct.length === 0 ? 'no lean_lib is a default target (defaultTargets), so a bare lake build builds nothing'
      : `the globs of the default targets are ${direct.map((lib) => `${lib.name}: ${lib.globs.map((glob) => glob.source).join(', ')}`).join('; ')}`;
    problems.push({ kind: 'not-covered-by-lean-lib', file: rel, statement: null, detail: `the module ${module} is not covered by any lean_lib glob that a bare lake build runs, so Lake would not compile this file; ${reach}` });
  }
  return problems;
}

// What the head tree may differ in from the merged spec tree, and whether every spec and proof file is
// built. `base` is null when there is no merged spec to compare with; the glob check still runs.
// `externals` returns the records of the run state (or null), and is read only when a new Trusted
// file needs them.
export function checkIntegrity({ base: baseTree, head: headTree, externals = () => null, layout = {} }) {
  // A folder with a lakefile of its own is left out as another project, unless the build reaches into it:
  // Lake does not skip a folder for holding a lakefile, so a file there that a glob or an import of this
  // project reaches is compiled with it and is judged like any other. When the lakefile cannot be read
  // here nothing is left out.
  const built = builtFiles(headTree);
  const left = nestedFolders(baseTree ?? headTree).filter((folder) => built !== null && ![...built.covered].some((rel) => rel.startsWith(folder)));
  const [base, head] = [baseTree && without(baseTree, left), without(headTree, left)];
  const problems = [];
  const ties = [];
  const used = new Map();
  const changed = new Set();
  let records;
  const recordsOnce = () => (records === undefined ? (records = externals()) : records);
  if (base) {
    for (const rel of [...new Set([...base.keys(), ...head.keys()])].sort()) {
      const [was, now] = [base.get(rel), head.get(rel)];
      if (was && now && was.blob === now.blob) continue;
      if (!was && rel.includes('/') && LAKEFILE_AT.test(rel)) {
        problems.push({ kind: 'frozen-file-added', file: rel, statement: null, detail: 'a lakefile was added below the project root after the merged spec; it would make Lake treat this folder as another project' });
        continue;
      }
      const frozen = isFrozen(rel, layout);
      const lean = rel.endsWith('.lean');
      if (!now) {
        if (frozen) problems.push({ kind: 'frozen-file-removed', file: rel, statement: null, detail: 'this frozen file was removed since the merged spec' });
        else if (lean && hasStatements(was.text())) problems.push({ kind: 'spec-file-removed', file: rel, statement: null, detail: 'this spec file was removed since the merged spec' });
        continue;
      }
      if (lean) changed.add(rel);
      if (!was) {
        if (frozen && !(lean && isTrusted(rel))) problems.push({ kind: 'frozen-file-added', file: rel, statement: null, detail: 'a file was added under a frozen path (the lakefile, Defs, Trusted or Extraction) after the merged spec' });
        else if (lean && !frozen && hasStatements(now.text())) problems.push({ kind: 'spec-file-added', file: rel, statement: null, detail: 'this spec file is not in the merged spec' });
        else if (frozen) trustedAddition(rel, now.text(), recordsOnce(), used, problems, ties);
        if (lean) forbiddenAdded(rel, null, now.text(), problems);
        continue;
      }
      if (frozen) frozenChange(rel, was, now, problems);
      else if (lean && (hasStatements(was.text()) || hasStatements(now.text()))) specChange(rel, was.text(), now.text(), problems);
      if (lean) forbiddenAdded(rel, was.text(), now.text(), problems);
    }
  }
  problems.push(...globProblems(head, changed, layout));
  return { problems, ties };
}

const describeProblem = (problem) => `${problem.file}${problem.statement ? `: ${problem.statement}` : ''}: ${problem.detail}`;

// ---- the run state -------------------------------------------------------------------------

function readRunRecord(root, name) {
  const file = path.join(root, '.formalising', 'auto-fv', name);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return refuse('run-state-unreadable', `${file} is not valid JSON; fix it or move it aside, then run the build check again`); }
}

// Where the recorded extraction published its Lean, as the folders and files of the Lean project: a
// multi-crate run lists one publish folder and publication per crate, a single-crate run just the
// publication. `top` is the repository root and `prefix` the Lean project's folder in it. Paths in the
// run state are absolute or relative to the project root; one outside the Lean project is ignored, and
// so is one that is the project itself, which would freeze everything.
export function extractionLayout(state, { root, top, prefix }) {
  const run = state?.extraction?.run;
  // Symlinks resolved as far as the path exists (macOS keeps /tmp under /private/tmp), so it compares with `top`.
  const settled = (target) => {
    let [rest, here] = ['', target];
    while (!fs.existsSync(here) && here !== path.dirname(here)) { rest = path.join(path.basename(here), rest); here = path.dirname(here); }
    return path.join(fs.realpathSync(here), rest);
  };
  const inProject = (value) => {
    if (typeof value !== 'string' || value === '') return null;
    const rel = path.relative(top, settled(path.resolve(root, value))).split(path.sep).join('/');
    if (prefix) return rel.startsWith(`${prefix}/`) ? rel.slice(prefix.length + 1) : null;
    return rel === '' || rel === '..' || rel.startsWith('../') ? null : rel;
  };
  const layout = { folders: [], files: [] };
  // A run, or a crate's row of a multi-crate run (which carries a whole run): its publication lists
  // the published files, and it publishes into the folder that holds its translation.json, or into
  // `publishDir` when the row names one.
  const published = (entry) => {
    for (const file of Array.isArray(entry?.publication) ? entry.publication : []) {
      const rel = inProject(file?.projectPath);
      if (rel) layout.files.push(rel.toLowerCase());
    }
    const dir = typeof entry?.publishDir === 'string' ? entry.publishDir : typeof entry?.translation?.projectPath === 'string' ? path.dirname(entry.translation.projectPath) : null;
    const folder = inProject(dir)?.replace(/\/+$/, '');
    if (folder) layout.folders.push(`${folder.toLowerCase()}/`);
  };
  published(run);
  for (const unit of Array.isArray(run?.units) ? run.units : []) published(unit);
  return { folders: [...new Set(layout.folders)], files: [...new Set(layout.files)] };
}

// The merge commit of the last merged spec pull request the run state records, or null.
export const recordedSpecMerge = (specs) => (specs?.prs ?? []).filter((pr) => pr?.kind === 'spec' && pr.merged === true && typeof pr.mergeCommit === 'string').at(-1)?.mergeCommit ?? null;

// The commit whose spec the proofs must keep: the recorded spec merge, and `--spec-base` only when it
// is the same commit. A caller cannot pick a base that suits it, and the base must be in the history
// of the commit that is checked.
function resolveSpecBase({ top, root, full, specBase }) {
  const resolve = (value, label) => {
    const found = git(top, ['rev-parse', '--verify', '--quiet', `${value}^{commit}`]);
    if (found === null) refuse('spec-base-not-found', `${label} ${value} is not a commit of this repository: fetch the merged spec branch, then run the build check again`);
    return found;
  };
  const recorded = recordedSpecMerge(readRunRecord(root, 'specs.json'));
  const recordedFull = recorded === null ? null : resolve(recorded, 'the recorded spec merge commit');
  const given = specBase === undefined ? null : resolve(specBase, '--spec-base');
  if (given !== null && recordedFull !== null && given !== recordedFull) {
    refuse('spec-base-mismatch', `--spec-base ${given.slice(0, 12)} is not the spec merge commit the run state records (${recordedFull.slice(0, 12)}); the statements are held to the merged spec only`);
  }
  const chosen = recordedFull ?? given;
  if (chosen !== null && git(top, ['merge-base', '--is-ancestor', chosen, full]) === null) {
    refuse('spec-base-not-ancestor', `the spec merge commit ${chosen.slice(0, 12)} is not in the history of ${full.slice(0, 12)}; merge or rebase the proof branch onto the merged spec, then run the build check again`);
  }
  return chosen;
}

// ---- the check -----------------------------------------------------------------------------

export function buildCheck({ projectRoot, commit, specBase, packages, receiptDir, workdir, keep = false, timeoutSeconds = 7200 }) {
  if (!projectRoot) refuse('usage', '--project-root is required');
  if (!SHA_ARGUMENT.test(commit ?? '')) refuse('usage', '--commit must be a commit hash of 7 to 64 hexadecimal digits');
  const root = fs.existsSync(projectRoot) ? fs.realpathSync(projectRoot) : refuse('usage', `no such project root: ${projectRoot}`);
  const topLevel = git(root, ['rev-parse', '--show-toplevel']);
  if (topLevel === null) refuse('not-a-git-checkout', `${root} is not inside a git checkout`);
  const top = fs.realpathSync(topLevel);
  const full = git(top, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]);
  const tree = full === null ? null : git(top, ['rev-parse', `${full}^{tree}`]);
  if (full === null || tree === null) refuse('commit-not-found', `${commit} is not a commit of this repository`);
  if (specBase !== undefined && !SHA_ARGUMENT.test(specBase)) refuse('usage', '--spec-base must be a commit hash of 7 to 64 hexadecimal digits');
  const specBaseFull = resolveSpecBase({ top, root, full, specBase });

  const receipts = path.resolve(receiptDir ?? path.join(root, '.formalising', 'auto-fv', 'build-check'));
  const release = acquireLock();
  const work = fs.mkdtempSync(path.join(workdir ? path.resolve(workdir) : os.tmpdir(), `fvs-build-check-${full.slice(0, 12)}-`));
  try {
    const cleanRoot = path.join(work, 'tree');
    extractCommit(top, full, work, cleanRoot);
    const sub = path.relative(top, root);
    const start = path.join(cleanRoot, sub);
    const below = fs.existsSync(start) ? leanProjectIn(start) : null;
    if (below === null) refuse('no-lean-project', `the commit has no single Lean project (a lakefile) at ${sub || '.'} or one folder below it`);
    const leanRoot = path.join(start, below);

    // Before any build: the statements and what they rest on are the merged spec's, and every spec and
    // proof file is one Lake builds. A commit that fails this gets a failed receipt, so an earlier
    // receipt for the same commit never stands in for it.
    // The project's folder in the repository, with `/` separators; empty when it is the repository root.
    const prefix = path.join(sub, below).split(path.sep).filter((part) => part && part !== '.').join('/');
    const layout = extractionLayout(readRunRecord(root, 'state.json'), { root, top, prefix });
    const integrity = checkIntegrity({
      base: specBaseFull === null ? null : gitTree(top, specBaseFull, prefix, layout),
      head: gitTree(top, full, prefix, layout),
      layout,
      externals: () => { const records = readRunRecord(root, 'externals.json')?.records; return Array.isArray(records) ? records : null; },
    });
    const integrityRecord = { specBase: specBaseFull, compared: specBaseFull !== null, ok: integrity.problems.length === 0, problems: integrity.problems, ties: integrity.ties, extraction: layout };
    if (!integrityRecord.ok) {
      const reason = `${describeProblem(integrity.problems[0])}${integrity.problems.length > 1 ? ` (and ${integrity.problems.length - 1} more)` : ''}`;
      return finish(receipts, full, {
        schema: 1, kind: 'fvs-build-check', accepted: false, label: labelFailed(reason), commit: full, tree,
        leanRoot: path.join(sub, below) || '.', toolchain: toolchainOf(leanRoot), lake: null, packages: null, build: null,
        specFiles: [], flags: [], warnings: [], specBase: specBaseFull, integrity: integrityRecord, checkedAt: new Date().toISOString(),
      });
    }

    const manifest = readManifest(leanRoot);
    const source = packages ? path.resolve(packages) : path.join(root, below, '.lake', 'packages');
    const revisions = manifest.length === 0 ? {} : checkPackages({ packages: manifest, source, cleanRoot, leanRoot });
    const destination = path.join(leanRoot, '.lake', 'packages');
    const copy = manifest.length === 0 ? 'none' : copyPackages(source, destination);

    const env = { ...gitEnvironment(), LEAN_NUM_THREADS: '2' };
    const lakeVersion = (spawnSync('lake', ['--version'], { cwd: leanRoot, encoding: 'utf8', env }).stdout ?? '').split('\n')[0].trim();
    const files = leanFiles(leanRoot);
    // Dependencies must be up to date before the build; only the project's own modules may be missing.
    const preflightLog = path.join(work, 'preflight.log');
    runLake(['build', '--no-build', '--no-ansi'], { cwd: leanRoot, env, log: preflightLog, timeoutSeconds: 1800 });
    const stale = dependencyTargets(readLog(fs.readFileSync(preflightLog, 'utf8')).failedTargets, files.files, declaredTargets(leanRoot));
    if (stale.length > 0) refuse('dependencies-not-prebuilt', `Lake would have to build ${stale.slice(0, 5).join(', ')}${stale.length > 5 ? ` and ${stale.length - 5} more` : ''}, which are not prebuilt in ${source}; no build ran`);

    fs.mkdirSync(receipts, { recursive: true });
    const logFile = path.join(receipts, `${full}.log`);
    const started = Date.now();
    const build = runLake(['build', '--wfail', '--no-ansi'], { cwd: leanRoot, env, log: logFile, timeoutSeconds });
    const seconds = Math.round((Date.now() - started) / 1000);
    const logBytes = fs.readFileSync(logFile);
    const log = readLog(logBytes.toString('utf8'));
    const problem = firstProblem(log.messages);

    const specFiles = [];
    const tampered = [];
    for (const rel of files.files) {
      const bytes = fs.readFileSync(path.join(leanRoot, rel));
      const text = bytes.toString('utf8');
      // Raw text, so an option passed as a string in a lakefile is seen too.
      if (/warn\.sorry/.test(text)) tampered.push(`${rel} mentions warn.sorry, which switches off the sorry warning`);
      if (!rel.endsWith('.lean')) continue;
      const spec = readSpecSource(text);
      if (spec.statements.length === 0) continue;
      const olean = path.join(leanRoot, '.lake', 'build', 'lib', 'lean', `${rel.slice(0, -'.lean'.length)}.olean`);
      const own = log.messages.filter((m) => m.file === rel && m.severity !== 'info');
      const built = fs.existsSync(olean);
      const statements = spec.statements.map((statement) => {
        const hit = own.find((m) => m.line === statement.recallLine || (statement.guardFrom !== null && m.line >= statement.guardFrom && m.line <= statement.guardTo));
        const reason = statement.problems[0] ?? (hit ? describe(hit) : null)
          ?? (own.length > 0 ? `its spec file did not build (${describe(firstProblem(own))})` : built ? null : 'its spec file was not built');
        return { name: statement.name, line: statement.line, status: reason ? 'failing' : 'built', reason, axioms: statement.axioms, beyondStandard: statement.beyondStandard, flags: statement.flags };
      });
      const fileReason = own.length > 0 ? describe(firstProblem(own) ?? own[0]) : (built ? null : 'no .olean was produced, so the file is not part of the build');
      specFiles.push({ path: path.join(sub, below, rel), sha256: sha256(bytes), status: fileReason || statements.some((s) => s.status === 'failing') ? 'failing' : 'built', reason: fileReason, statements });
    }
    const statements = specFiles.flatMap((file) => file.statements);
    const symlinks = checkSymlinks(cleanRoot, leanRoot, files.links);
    let reason = null;
    if (build.status !== 0) reason = problem ? describe(problem) : `lake exited with status ${build.status}`;
    else if (symlinks.hard.length > 0) reason = `the commit has symbolic links that lead out of the commit to a folder or a Lean file: ${symlinks.hard.slice(0, 3).join(', ')}`;
    else if (tampered.length > 0) reason = tampered[0];
    else if (statements.length === 0) reason = 'no spec file restates a statement with recall and guards its axioms';
    else {
      const failing = specFiles.find((file) => file.status === 'failing');
      if (failing) reason = `${failing.path}: ${failing.reason ?? failing.statements.find((s) => s.status === 'failing').reason}`;
    }
    const flags = statements.filter((s) => s.flags.length > 0).map((s) => `${s.name} uses ${s.flags.join(', ')}`);
    const warnings = symlinks.soft.length === 0 ? [] : [`symbolic links lead out of the commit to files Lake does not read as Lean sources: ${symlinks.soft.slice(0, 3).join(', ')}${symlinks.soft.length > 3 ? ` and ${symlinks.soft.length - 3} more` : ''}`];
    const accepted = reason === null;
    const label = accepted ? LABEL_ACCEPTED : labelFailed(reason);
    const receipt = {
      schema: 1, kind: 'fvs-build-check', accepted, label, commit: full, tree,
      leanRoot: path.join(sub, below) || '.', toolchain: toolchainOf(leanRoot),
      lake: lakeVersion, packages: { source, copy, revisions },
      build: { argv: build.argv, exitCode: build.status, seconds, log: logFile, logSha256: sha256(logBytes) },
      specFiles, flags, warnings, specBase: specBaseFull, integrity: integrityRecord, checkedAt: new Date().toISOString(),
    };
    return finish(receipts, full, receipt);
  } finally {
    release();
    if (!keep) fs.rmSync(work, { recursive: true, force: true });
  }
}

const toolchainOf = (leanRoot) => (fs.existsSync(path.join(leanRoot, 'lean-toolchain')) ? fs.readFileSync(path.join(leanRoot, 'lean-toolchain'), 'utf8').trim() : null);

// Writes the receipt, bound to the commit, and returns the result. A receipt is written for every
// verdict, so a later verdict for the same commit replaces an earlier one.
function finish(receipts, full, receipt) {
  fs.mkdirSync(receipts, { recursive: true });
  const receiptPath = path.join(receipts, `${full}.json`);
  fs.writeFileSync(`${receiptPath}.tmp`, `${JSON.stringify(receipt, null, 2)}\n`);
  fs.renameSync(`${receiptPath}.tmp`, receiptPath);
  return { ok: true, code: receipt.accepted ? 'accepted' : 'failed', ...receipt, receipt: receiptPath, report: reportLines(receipt) };
}

function reportLines(receipt) {
  const { integrity } = receipt;
  const lines = [receipt.label, `commit ${receipt.commit}`, `tree ${receipt.tree}`, ...receipt.warnings.map((warning) => `warning: ${warning}`)];
  lines.push(integrity.compared ? `spec base ${integrity.specBase}: statements, frozen paths and added code compared with the merged spec`
    : 'spec base: none given or recorded, so the statements were not compared with a merged spec');
  const { folders, files } = integrity.extraction ?? { folders: [], files: [] };
  lines.push(`extraction output held fixed, besides the folders named Extraction...: ${folders.length + files.length === 0 ? 'none recorded in the run state' : [...folders, ...files].join(', ')}`);
  for (const problem of integrity.problems) lines.push(`not accepted: ${problem.kind}: ${describeProblem(problem)}`);
  for (const tie of integrity.ties) lines.push(`accepted assumption: axiom ${tie.axiom} (${tie.file}) is tied to externals record ${tie.record}`);
  for (const file of receipt.specFiles) {
    lines.push(`${file.path}: ${file.status}${file.reason ? ` (${file.reason})` : ''}`);
    for (const s of file.statements) {
      const list = s.axioms === null ? null : s.axioms.join(', ') || 'none';
      const rests = list === null ? 'axioms unknown' : s.status === 'built' ? `axioms: ${list}` : `claimed axioms, not confirmed: ${list}`;
      lines.push(`  ${s.name}: ${s.status === 'built' ? 'built' : `failing (${s.reason})`}; ${rests}${s.flags.length ? `; flagged: ${s.flags.join(', ')}` : ''}`);
    }
  }
  return lines;
}

function parseArguments(argv) {
  const options = {};
  const valued = { '--project-root': 'projectRoot', '--commit': 'commit', '--spec-base': 'specBase', '--packages': 'packages', '--receipt-dir': 'receiptDir', '--workdir': 'workdir', '--timeout': 'timeoutSeconds' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--keep') options.keep = true;
    else if (valued[argv[i]] && i + 1 < argv.length) { options[valued[argv[i]]] = argv[i + 1]; i += 1; } else refuse('usage', `unknown or incomplete argument ${argv[i]}`);
  }
  if (options.timeoutSeconds !== undefined) {
    options.timeoutSeconds = Number(options.timeoutSeconds);
    if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 1) refuse('usage', '--timeout must be a positive whole number of seconds');
  }
  return options;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { report, ...result } = buildCheck(parseArguments(process.argv.slice(2)));
    // stdout holds the JSON result and nothing else, so a caller can parse it; the report is for people.
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.stderr.write(`${report.join('\n')}\n`);
    process.exitCode = result.accepted ? 0 : 1;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    process.stdout.write(`${JSON.stringify({ ok: false, code: error.code, message: error.message }, null, 2)}\n`);
    process.stderr.write(`refused (${error.code}): ${error.message}\n`);
    process.exitCode = 2;
  }
}
