#!/usr/bin/env node
// Build check: build one commit of a Lean project in a fresh clean copy and report
// what the build proves.
//
//   node fvs-build-check.mjs --project-root R --commit SHA [--spec-base SHA] [--allow-axioms FILE]
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
// docstrings and axiom guards, nothing may add `sorry`, `admit`, `native_decide`, `bv_decide` (judged
// by the declaration each sits in) or an axiom outside Trusted/ (judged by its name and type, so
// swapping one for another counts), a lakefile may not appear below the project root, and a new Trusted file
// is allowed only for axioms tied to an externals record the owner accepted. Strings and layout are
// compared exactly; only comments, docstrings, guards and the layout of a recalled statement are free. The glob guard refuses a spec,
// proof or extraction file that no lean_lib glob of a default target reaches, because Lake would
// never compile it; the lakefile, the manifest and lean-toolchain are frozen. A commit that fails a
// guard gets a failed receipt and no build runs.
//
// After the build, two more conditions must hold. Every spec, proof and extraction file must have
// produced a .olean in this build (for a lakefile.lean, where globs are not read, a module named by its
// path or by a suffix of it), whether or not the file holds a recall. And a small Lean program must find
// that what each recalled statement rests on is what it rested on in the merged spec: it serialises the
// elaborated type of the statement and of every project definition, instance and abbreviation it
// reaches (values included, proofs not), on the head and on a fresh build of the merged spec, and the
// two must agree constant by constant. Text alone cannot say that: a notation, a macro, an instance or a
// helper in a file that is not frozen can change what unchanged text elaborates to. The axioms a
// statement rests on come from Lean, not from the guard text: Lean's three standard axioms, a project
// axiom of the merged spec that has not changed, and a new axiom only in a Trusted module that asserts
// exactly the one frozen proposition of the merged spec whose docstring cites the axiom's accepted
// externals record (a record is cited by one axiom only); sorry, native_decide and bv_decide axioms
// are refused. If the program cannot run, or the merged spec does not build, the commit is not accepted.
// The receipt keeps the comparison under integrity.semantic.
//
// With --allow-axioms FILE (a list the engine writes from its own records, JSON with schema
// fvs/auto-allowed-axioms) a statement passes only if every axiom its guard lists is one of Lean's
// three standard axioms or is named in the list; a name in the list also covers that name with its
// leading namespace dropped, because `#print axioms` shows names relative to the file's namespace.
// The receipt records the file's sha256 as allowAxioms. Without the flag no statement is held to a list.
//
// The build is `lake build --wfail`: every warning, so every `sorry`, fails it. Each
// spec file restates its statements with `recall` and pins what they rest on with
// `#guard_msgs ... in #print axioms NAME`; the build enforces those guards, and this
// script refuses a pass that rests on guards it cannot read or that say nothing.
//
// A verdict, accepted or not, is written as a receipt bound to the commit and its tree. Accepted
// means the statements were compared with a merged spec; a build with no spec base is labelled
// "built, integrity not checked" and is not an acceptance. A check that holds the lock replaces any
// earlier receipt for the commit at once with a non-accepting one, and a refusal or a crash after that
// leaves a non-accepting receipt, so an old acceptance never stands in for a check that did not
// finish. A caller refused the lock changes nothing. The receipt lists the externals records the
// acceptance relied on, each with a digest, so a later change to one of them shows.
// Output: stdout holds one JSON object and nothing else; the report for people goes to stderr.
// Exit status 0 accepted, 1 not accepted (failed, or built without a spec base), 2 refused.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const LABEL_ACCEPTED = 'accepted (build check)';
// A commit that built but was not compared with a merged spec: nothing says its statements are the
// approved ones, so it is not an acceptance and the exit status is not 0.
export const LABEL_UNCHECKED = 'built, integrity not checked';
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
// is left can be matched without a commented-out guard counting. A block comment becomes blanks of
// its own width (newlines kept), so it still separates the tokens around it and the columns of
// what follows on its last line stay where they were; Lean reads layout from columns. String
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
      code += text.slice(i, end).replace(/[^\n]/g, ' ');
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

// ---- the axioms a statement may rest on ----------------------------------------------------
//
// With `--allow-axioms FILE` a statement may rest on Lean's three standard axioms and on the names
// the file lists, and on nothing else. The file is written by the engine from its own records (the
// extraction's opaque or external declarations, recorded assumptions, accepted ruling), never by a
// worker. Without the flag no statement is held to a list.

const ALLOWED_AXIOMS_SCHEMA = 'fvs/auto-allowed-axioms';

// The allowed names in a file's bytes. The caller hashes the same bytes, so the digest in the
// receipt is the digest of what was read. Anything that is not a well-formed list is refused: a
// mistyped file must never read as "no list".
export function readAllowedAxioms(bytes, file = 'the allowed-axioms file') {
  let data;
  try { data = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { refuse('allow-axioms-invalid', `${file} is not valid JSON`); }
  if (data?.schema !== ALLOWED_AXIOMS_SCHEMA || data.schemaVersion !== 1) refuse('allow-axioms-invalid', `${file} is not a ${ALLOWED_AXIOMS_SCHEMA} version 1 file`);
  if (!Array.isArray(data.axioms) || !data.axioms.every((name) => typeof name === 'string' && name !== '' && name === name.trim())) {
    refuse('allow-axioms-invalid', `${file}: "axioms" must be an array of axiom names, each a non-empty string without surrounding spaces`);
  }
  return new Set(data.axioms);
}

// `#print axioms` shows a name relative to the namespace of the file it runs in, so the guards of a spec
// file inside `namespace A` list `B.f` for the axiom whose full name is `A.B.f`. A listed name
// therefore covers itself and itself with leading components dropped.
const nameTails = (names) => {
  const tails = new Set();
  for (const name of names) {
    const parts = name.split('.');
    for (let i = 0; i < parts.length; i += 1) tails.add(parts.slice(i).join('.'));
  }
  return tails;
};

// The axioms in `axioms` that are neither standard nor covered by the allowed names. Every axiom a
// guard lists counts, including names that look like native_decide or bv_decide axioms.
export function axiomsNotAllowed(axioms, allowed) {
  const covered = nameTails(allowed);
  return (axioms ?? []).filter((name) => !STANDARD_AXIOMS.includes(name) && !covered.has(name));
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

// `stdoutFile`, when given, takes the standard output apart from the log.
function runLake(args, { cwd, env, log, timeoutSeconds, stdoutFile }) {
  const wrapper = process.platform === 'darwin' && spawnSync('sh', ['-c', 'command -v caffeinate'], { stdio: 'ignore' }).status === 0 ? ['caffeinate', '-is'] : [];
  const argv = [...wrapper, 'nice', '-n', '19', 'lake', ...args];
  const out = fs.openSync(log, 'w');
  const main = stdoutFile ? fs.openSync(stdoutFile, 'w') : out;
  try {
    // The child leads its own process group. A timeout kills only that child, so the whole group is
    // killed once the run returns: no Lean worker may outlive the check and overlap the next build.
    const run = spawnSync(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', main, out], timeout: timeoutSeconds * 1000, detached: true });
    if (run.pid) { try { process.kill(-run.pid, 'SIGKILL'); } catch { /* the group is already gone */ } }
    return { argv, status: run.status ?? (run.error ? 124 : 1) };
  } finally { fs.closeSync(out); if (main !== out) fs.closeSync(main); }
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
// taken out. Layout is kept exactly (spacing, indentation, and a block comment by its width), because
// Lean reads blocks from columns; only a recalled statement is compared with its whitespace collapsed,
// a comment counting as a space, since the meaning of a statement is compared at the Lean level.

const lowerFolders = (rel) => rel.toLowerCase().split('/').slice(0, -1);
const LAKE_FILES = /^(?:lakefile\.(?:toml|lean)|lake-manifest\.json|lean-toolchain)$/;
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

// The same text with layout kept: comments are blanks of their width, docstring markers and axiom
// guards are gone, a line's trailing blanks and the empty lines are dropped (Lean never reads them),
// and everything else is exactly as written, indentation and the spaces between tokens included. A
// `do` block or a tactic block reads its structure from columns, so a change of indentation can
// change a program and is a change here. Each string is put back as written. With `statements`, the
// text of each recalled statement is collapsed instead, because the elaborated statement is compared
// at the Lean level and a reflowed statement is not a change of meaning.
function exactText(code, strings, { statements = false } = {}) {
  let text = code;
  if (statements) {
    let out = '';
    let at = 0;
    for (const match of text.matchAll(/^[ \t]*recall\s+([^\s(\[{:]+)/gm)) {
      if (match.index < at) continue;
      const ending = /\n(?=\S)/g;
      ending.lastIndex = match.index + match[0].length;
      const stop = ending.exec(text);
      const end = stop ? stop.index : text.length;
      out += `${text.slice(at, match.index)}recall ${match[1]} ${flatten(text.slice(match.index + match[0].length, end), strings)}`;
      at = end;
    }
    text = out + text.slice(at);
  }
  return text
    .replace(/\/--#\d+-\/[ \t]*/g, '')
    .replace(/#guard_msgs\s*(?:\([^)]*\))?\s*in\s+#print\s+axioms\s+\S+/g, '')
    .replace(/#print\s+axioms\s+\S+/g, '')
    .split('\n').map((line) => line.replace(/\s+$/, '')).filter((line) => line !== '').join('\n')
    .replace(/\u0000(\d+)\u0000/g, (_, n) => strings[Number(n)]);
}
export const exactLean = (text, options) => { const { code, strings } = stripLean(text, { keepStrings: true }); return exactText(code, strings, options); };

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

// What `sorry`, `admit`, a native check or an axiom outside Trusted/ would add. Read from code alone,
// so a mention in a comment or a string does not count. A use is identified by the declaration it sits
// in and the word, and an axiom by its name and its type, never by a count: a file whose total stays
// the same can still have moved a `native_decide` to another declaration, or swapped one axiom for a
// stronger one.
const FORBIDDEN = [['sorry', /\bsorry\b/g], ['admit', /\badmit\b/g], ['native_decide', /\bnative_decide\b/g], ['bv_decide', /\bbv_decide\b/g],
  ['decide +native', /\bdecide\s*\+\s*native\b/g]];

// An axiom that starts a line, read from the raw text with no lexer in between. If the comment and
// string reader were ever thrown off by odd source, an axiom declared on its own line is still seen.
// It must read like a declaration (a name, then a colon or a binder), so prose that starts a line with
// "axiom" in a docstring is not one. A docstring line that does read like one, such as
// "axiom foo (see above)", is seen too, and counts.
const RAW_AXIOM = /^[ \t]*(?:@\[[^\]\n]*\][ \t]*)*(?:(?:private|protected|noncomputable|unsafe)[ \t]+)*axiom[ \t]+([\p{L}_«][\p{L}\p{N}_.'!?«»]*)(?=\s*[:({\[⦃])/gmu;
const rawAxioms = (text) => [...text.matchAll(RAW_AXIOM)].map((match) => match[1]);

// A multiset as a Map from a key to how many times it occurs.
const tally = (keys) => { const counts = new Map(); for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1); return counts; };

// Each axiom of a source text as "name : type", the type read to the next line that starts in column 0
// and flattened, with the declared name.
function axiomIdentities(text) {
  const { code, strings } = stripLean(text, { keepStrings: true });
  return [...code.matchAll(/\baxiom\s+([^\s(\[{:]+)/g)].map((match) => {
    const ending = /\n(?=\S)/g;
    ending.lastIndex = match.index + match[0].length;
    const stop = ending.exec(code);
    return { name: match[1], identity: flatten(code.slice(match.index, stop ? stop.index : code.length), strings) };
  });
}

function forbiddenAdded(rel, was, now, problems) {
  const before = was === null ? '' : stripLean(was).code;
  const after = stripLean(now).code;
  for (const [token, pattern] of FORBIDDEN) {
    const uses = (code) => [...code.matchAll(pattern)].map((use) => ({ at: use.index, declaration: declarationNear(code, use.index) ?? '' }));
    const had = tally(uses(before).map((use) => use.declaration));
    const seenNow = new Map();
    for (const use of uses(after)) {
      const count = (seenNow.get(use.declaration) ?? 0) + 1;
      seenNow.set(use.declaration, count);
      if (count > (had.get(use.declaration) ?? 0)) {
        problems.push({ kind: 'forbidden-added', file: rel, statement: use.declaration || null, token, detail: `${token} was added${use.declaration ? ` in ${use.declaration}` : ''} (${had.get(use.declaration) ?? 0} there before, ${count} now)` });
      }
    }
  }
  if (isTrusted(rel)) return;
  const hadAxioms = tally(axiomIdentities(was ?? '').map((entry) => entry.identity));
  const haveAxioms = new Map();
  const reported = new Set();
  for (const entry of axiomIdentities(now)) {
    const count = (haveAxioms.get(entry.identity) ?? 0) + 1;
    haveAxioms.set(entry.identity, count);
    if (count > (hadAxioms.get(entry.identity) ?? 0)) {
      reported.add(entry.name);
      problems.push({ kind: 'forbidden-added', file: rel, statement: entry.name, token: 'axiom', detail: `the axiom ${entry.name} is not in the merged spec with this type; an axiom belongs in Trusted/ and needs an accepted externals record` });
    }
  }
  // The same, from the raw lines, by name only.
  const hadRaw = tally(rawAxioms(was ?? ''));
  const haveRaw = new Map();
  for (const name of rawAxioms(now)) {
    const count = (haveRaw.get(name) ?? 0) + 1;
    haveRaw.set(name, count);
    if (count > (hadRaw.get(name) ?? 0) && !reported.has(name)) {
      reported.add(name);
      problems.push({ kind: 'forbidden-added', file: rel, statement: name, token: 'axiom', detail: `the axiom ${name} is not in the merged spec; an axiom belongs in Trusted/ and needs an accepted externals record` });
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
    const [a, b] = [exactLean(was, { statements: true }), exactLean(now, { statements: true })];
    if (a !== b) {
      const diff = firstDifference(a, b);
      problems.push({ kind: 'spec-code-changed', file: rel, statement: declarationNear(b, diff.index), detail: `code outside the recalled statements, comments and guards changed since the merged spec (spacing and indentation count): was "…${diff.was}", now "…${diff.now}"`.replace(/\n/g, '⏎') });
    }
  }
}

function frozenChange(rel, was, now, problems) {
  if (!rel.endsWith('.lean')) {
    problems.push({ kind: 'frozen-file-changed', file: rel, statement: null, detail: 'this frozen file differs from the merged spec' });
    return;
  }
  const [a, b] = [exactLean(was.text()), exactLean(now.text())];
  if (a === b) return;
  const diff = firstDifference(a, b);
  problems.push({ kind: 'frozen-file-changed', file: rel, statement: declarationNear(b, diff.index), detail: `this frozen file changed beyond comments, docstrings and guards since the merged spec (spacing and indentation count): was "…${diff.was}", now "…${diff.now}"`.replace(/\n/g, '⏎') });
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
  // Every spec, proof and extraction file is one Lake must have compiled, whatever the lakefile says and
  // whether or not it holds a recall. The module a file has is its path below a library's source folder;
  // for a lakefile.lean, which is not read here, its path or its path below any folder.
  const sourceFolders = built ? built.sources : [''];
  const moduleCandidates = (rel) => {
    const modules = sourceFolders.map((folder) => (rel.startsWith(folder) ? rel.slice(folder.length, -'.lean'.length).replaceAll('/', '.') : null)).filter(Boolean);
    if (!built) { const parts = rel.slice(0, -'.lean'.length).split('/'); for (let i = 1; i < parts.length; i += 1) modules.push(parts.slice(i).join('.')); }
    return [...new Set(modules)];
  };
  const required = [...head.keys()].filter((rel) => rel.endsWith('.lean') && !LAKE_FILES.test(rel)
    && (isProofPath(rel) || isExtraction(rel, layout) || hasStatements(head.get(rel).text()))).sort().map((rel) => ({ rel, modules: moduleCandidates(rel) }));
  return { problems, ties, required, moduleCandidates };
}

const describeProblem = (problem) => `${problem.file ?? 'Lean check'}${problem.statement ? `: ${problem.statement}` : ''}: ${problem.detail}`;

// ---- the Lean-level check ------------------------------------------------------------------
//
// Text cannot say that the statements still mean what the merged spec's statements mean: a helper
// definition in a proof file, a notation, a macro or an instance can change what unchanged text
// elaborates to. So after the build a small Lean program loads the built project and, for each recalled
// statement, serialises the elaborated type and everything it depends on: the types and values of the
// project's definitions, instances and abbreviations, and the types (not the proofs) of its theorems,
// axioms and constructors. Constants outside the project (Lean, Mathlib, the dependencies) are pinned
// by lean-toolchain and the manifest, which are frozen. The same program runs on the merged spec, and
// the two serialisations must agree, constant by constant, for everything a statement rests on.
// The program also reports, for each statement, the axioms its proof rests on, and which project
// axioms exist and what they assert, so that a new axiom can be held to its accepted record.

const DUMP_SOURCE = String.raw`import Lean
open Lean

/-! Canonical dump of the project's constants reachable from a set of roots, one JSON object per line. -/

structure Ser where
  ids : Std.HashMap Expr Nat := {}
  out : Array String := #[]

abbrev SerM := StateM Ser

def serLevel : Level → String
  | .zero => "0"
  | .succ l => "(s " ++ serLevel l ++ ")"
  | .max a b => "(m " ++ serLevel a ++ " " ++ serLevel b ++ ")"
  | .imax a b => "(i " ++ serLevel a ++ " " ++ serLevel b ++ ")"
  | .param n => "(p " ++ toString n ++ ")"
  | .mvar _ => "?"

partial def serExpr (e : Expr) : SerM Nat := do
  match e with
  | .mdata _ b => serExpr b
  | _ =>
    if let some i := (← get).ids[e]? then return i
    let line ← match e with
      | .bvar i => pure s!"b {i}"
      | .fvar _ => pure "f"
      | .mvar _ => pure "?"
      | .sort l => pure s!"S {serLevel l}"
      | .const n ls => pure s!"C {n} {" ".intercalate (ls.map serLevel)}"
      | .app f a => do let f ← serExpr f; let a ← serExpr a; pure s!"A {f} {a}"
      | .lam _ t b _ => do let t ← serExpr t; let b ← serExpr b; pure s!"L {t} {b}"
      | .forallE _ t b _ => do let t ← serExpr t; let b ← serExpr b; pure s!"P {t} {b}"
      | .letE _ t v b nd => do let t ← serExpr t; let v ← serExpr v; let b ← serExpr b; pure s!"T {t} {v} {b} {nd}"
      | .lit (.natVal n) => pure s!"N {n}"
      | .lit (.strVal s) => pure s!"R {s.quote}"
      | .proj s i b => do let b ← serExpr b; pure s!"J {s} {i} {b}"
      | .mdata _ _ => pure "?"
    let id := (← get).out.size
    modify fun st => { st with out := st.out.push line, ids := st.ids.insert e id }
    return id

def serialize (e : Expr) : String :=
  let (root, st) := (serExpr e).run {}
  s!"{root}|" ++ ";".intercalate st.out.toList

def kindOf : ConstantInfo → String
  | .axiomInfo _ => "axiom"
  | .defnInfo _ => "defn"
  | .thmInfo _ => "thm"
  | .opaqueInfo _ => "opaque"
  | .quotInfo _ => "quot"
  | .inductInfo _ => "induct"
  | .ctorInfo _ => "ctor"
  | .recInfo _ => "rec"

def describe (env : Environment) (isProj : Name → Bool) (ci : ConstantInfo) : Json × Array Name :=
  let valueOf : Option Expr := match ci with
    | .defnInfo d => some d.value
    | _ => none
  let extra : Array Name := match ci with
    | .inductInfo i => i.ctors.toArray ++ i.all.toArray
    | .ctorInfo c => #[c.induct]
    | _ => #[]
  let uses := ci.type.getUsedConstants ++ (valueOf.map (·.getUsedConstants)).getD #[] ++ extra
  let deps := (uses.filter isProj).toList.eraseDups.toArray
  let modName := env.getModuleIdxFor? ci.name |>.map (fun i => env.header.moduleNames[i.toNat]!) |>.getD .anonymous
  let shape : List (String × Json) := match ci with
    | .inductInfo i => [("params", Json.num i.numParams), ("indices", Json.num i.numIndices), ("rec", Json.bool i.isRec), ("ctors", toJson (i.ctors.map toString))]
    | .ctorInfo c => [("cidx", Json.num c.cidx), ("params", Json.num c.numParams), ("fields", Json.num c.numFields)]
    | .defnInfo d => [("safety", Json.str (toString (repr d.safety)))]
    | .axiomInfo _ => [("tc", match ci.type with | .const n [] => Json.str (toString n) | _ => Json.null)]
    | _ => []
  let base : List (String × Json) :=
    [("n", Json.str (toString ci.name)), ("k", Json.str (kindOf ci)), ("m", Json.str (toString modName)),
     ("lp", toJson (ci.levelParams.map toString)), ("t", Json.str (serialize ci.type)),
     ("d", toJson (deps.map toString))] ++ shape
  let withValue := match valueOf with
    | some v => base ++ [("v", Json.str (serialize v))]
    | none => base
  (Json.mkObj withValue, deps)

def main (args : List String) : IO UInt32 := do
  let [argFile] := args | IO.eprintln "usage: Dump <args.json>"; return 2
  let input ← IO.ofExcept (Json.parse (← IO.FS.readFile argFile))
  let mods : Array String ← IO.ofExcept (input.getObjValAs? (Array String) "modules")
  let recalls : Array String ← IO.ofExcept (input.getObjValAs? (Array String) "recalls")
  let ids : Array String ← IO.ofExcept (input.getObjValAs? (Array String) "ids")
  initSearchPath (← findSysroot)
  let names := mods.map String.toName
  let env ← importModules (names.map fun m => { module := m }) {} (trustLevel := 0)
  let projMods : Std.HashSet Name := names.foldl (·.insert ·) {}
  let isProj (c : Name) : Bool := match env.getModuleIdxFor? c with
    | some i => projMods.contains env.header.moduleNames[i.toNat]!
    | none => false
  let ctx : Core.Context := { fileName := "<dump>", fileMap := default }
  IO.println (Json.compress (Json.mkObj [("toolchain", Json.str versionString), ("githash", Json.str githash)]))
  let mut roots : Array Name := #[]
  let projNames : Array Name := env.constants.map₁.fold (fun acc n _ => if isProj n then acc.push n else acc) #[]
  for id in recalls do
    let found := projNames.filter fun n => let s := toString n; s == id || s.endsWith ("." ++ id)
    let mut axioms : Array Json := #[]
    for n in found do
      roots := roots.push n
      let (r, _) ← (Lean.collectAxioms n : CoreM (Array Name)).toIO ctx { env }
      axioms := axioms.push (Json.mkObj [("n", Json.str (toString n)), ("axioms", toJson (r.map toString))])
    IO.println (Json.compress (Json.mkObj [("recall", Json.str id), ("matches", toJson (found.map toString)), ("rests", Json.arr axioms)]))
  let tick := String.singleton (Char.ofNat 96)
  for n in projNames do
    let some ci := env.find? n | continue
    let isAxiom := ci matches .axiomInfo _
    let isProp := match ci.type with | .sort .zero => true | _ => false
    let doc? ← findDocString? env n
    let cites := match doc? with
      | some d => ids.filter fun i => (d.splitOn (tick ++ i ++ tick)).length > 1
      | none => #[]
    if isAxiom then roots := roots.push n
    else if isProp && cites.size > 0 then roots := roots.push n
    if cites.size > 0 && (isProp || isAxiom) then
      let modName := env.getModuleIdxFor? n |>.map (fun i => env.header.moduleNames[i.toNat]!) |>.getD .anonymous
      IO.println (Json.compress (Json.mkObj [("doc", Json.str (toString n)), ("m", Json.str (toString modName)), ("cites", toJson cites), ("prop", Json.bool isProp), ("axiom", Json.bool isAxiom)]))
  let mut seen : Std.HashSet Name := {}
  let mut work := roots.toList
  while true do
    match work with
    | [] => break
    | n :: rest =>
      work := rest
      if seen.contains n then continue
      seen := seen.insert n
      let some ci := env.find? n | continue
      let (json, deps) := describe env isProj ci
      IO.println (Json.compress json)
      work := deps.toList ++ work
  return 0
`;

const digestOf = (value) => sha256(typeof value === 'string' ? value : JSON.stringify(value));

// What the Lean program printed: the toolchain, for each recalled name the project declarations that
// end with it (with the axioms each rests on), the propositions and axioms that cite an externals record,
// and every project constant reachable from a root, each with the digest of its own content.
export function parseDump(text) {
  const dump = { toolchain: null, recalls: new Map(), docs: [], constants: new Map() };
  for (const line of text.split('\n')) {
    if (!line.startsWith('{"')) continue;
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    if (item.toolchain !== undefined) dump.toolchain = { lean: item.toolchain, githash: item.githash };
    else if (item.recall !== undefined) dump.recalls.set(item.recall, { matches: item.matches ?? [], rests: item.rests ?? [] });
    else if (item.doc !== undefined) dump.docs.push({ name: item.doc, module: item.m, cites: item.cites ?? [], prop: item.prop === true, axiom: item.axiom === true });
    else if (typeof item.n === 'string') {
      dump.constants.set(item.n, {
        name: item.n, kind: item.k, module: item.m, deps: item.d ?? [], typeConst: item.tc ?? null,
        own: digestOf([item.k, item.lp, item.t, item.v ?? null, item.params ?? null, item.indices ?? null, item.rec ?? null, item.ctors ?? null, item.cidx ?? null, item.fields ?? null, item.safety ?? null]),
      });
    }
  }
  if (dump.toolchain === null) throw new Error('the Lean program printed no toolchain line');
  return dump;
}

// The constants a root rests on (itself included), in the order they are met, with each one's digest.
function closureOf(constants, root) {
  const seen = new Map();
  const queue = [root];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name) || !constants.has(name)) continue;
    seen.set(name, constants.get(name).own);
    queue.push(...constants.get(name).deps);
  }
  return seen;
}
const closureDigest = (closure) => digestOf([...closure].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

// A module as the path of its file, so the folder rules that name files apply to it.
const moduleRel = (module) => `${module.replaceAll('.', '/')}.lean`;
const inTrustedModule = (module) => isTrusted(moduleRel(module));

// What the merged spec's statements, axioms and propositions are compared with at the head. `base` and
// `head` come from parseDump; `recalled` are the names the spec files recall; `acceptedIds` are the ids
// of the externals records the owner accepted.
export function semanticProblems({ base, head, recalled, acceptedIds = new Set() }) {
  const problems = [];
  const add = (kind, statement, detail) => problems.push({ kind, file: null, statement, detail });
  if (base.toolchain.lean !== head.toolchain.lean || base.toolchain.githash !== head.toolchain.githash) {
    add('toolchain-changed', null, `the Lean toolchain differs (${base.toolchain.lean} ${String(base.toolchain.githash).slice(0, 8)} at the merged spec, ${head.toolchain.lean} ${String(head.toolchain.githash).slice(0, 8)} now), so the two serialisations cannot be compared`);
    return { problems, statements: [], bindings: [] };
  }
  const statements = [];
  for (const id of recalled) {
    const [was, now] = [base.recalls.get(id), head.recalls.get(id)];
    if (!was || was.matches.length === 0) { add('statement-unresolved', id, `no declaration of the project at the merged spec has a name that ends with ${id}, so the statement cannot be compared`); continue; }
    if (!now || [...was.matches].sort().join('\n') !== [...now.matches].sort().join('\n')) {
      const [a, b] = [new Set(was.matches), new Set(now?.matches ?? [])];
      const changed = [...b].filter((name) => !a.has(name)).map((name) => `${name} (added)`).concat([...a].filter((name) => !b.has(name)).map((name) => `${name} (gone)`));
      add('statement-shadowed', id, `the declarations whose names end with ${id} are not the merged spec's: ${changed.join(', ')}; the recall could resolve to another declaration, so name new declarations differently`);
      continue;
    }
    for (const name of was.matches) {
      const [closedBase, closedHead] = [closureOf(base.constants, name), closureOf(head.constants, name)];
      const first = [...closedBase].find(([constant, digest]) => closedHead.get(constant) !== digest);
      if (first) {
        add('statement-meaning-changed', id, `the statement ${id} (${name}) no longer means what it meant in the merged spec: ${first[0] === name ? 'its type changed' : `${first[0]}, which it rests on, ${closedHead.has(first[0]) ? 'changed' : 'is gone'}`}`);
        continue;
      }
      statements.push({ name: id, declaration: name, constants: closedHead.size, sha256: closureDigest(closedHead) });
    }
  }

  // Axioms: Lean's three standard ones, the project's own that the merged spec already had (unchanged),
  // and new ones only in a Trusted module, each asserting exactly the proposition its accepted record is
  // tied to in the merged spec.
  const standard = new Set(STANDARD_AXIOMS);
  const projectAxioms = (dump) => [...dump.constants.values()].filter((constant) => constant.kind === 'axiom');
  const baseAxioms = new Set(projectAxioms(base).map((constant) => constant.name));
  const newAxioms = projectAxioms(head).filter((constant) => !base.constants.has(constant.name));
  for (const axiom of projectAxioms(head)) {
    if (!baseAxioms.has(axiom.name)) continue;
    if (closureDigest(closureOf(base.constants, axiom.name)) !== closureDigest(closureOf(head.constants, axiom.name))) add('axiom-changed', axiom.name, `the axiom ${axiom.name} of the merged spec asserts something else than it did`);
  }
  for (const [id, now] of head.recalls) {
    for (const rest of now.rests) {
      for (const name of rest.axioms) {
        if (standard.has(name)) continue;
        const constant = head.constants.get(name);
        if (!constant || constant.kind !== 'axiom') add('axiom-not-allowed', id, `the statement ${id} (${rest.n}) rests on the axiom ${name}, which is not one of Lean's three standard axioms or an axiom of the project (sorry, native_decide and bv_decide add such axioms)`);
      }
    }
  }
  const bindings = [];
  const cited = (dump, kind) => dump.docs.filter((doc) => doc[kind]);
  for (const axiom of newAxioms) {
    if (!inTrustedModule(axiom.module)) { add('axiom-not-allowed', axiom.name, `the axiom ${axiom.name} is new since the merged spec and is declared outside Trusted/ (in ${axiom.module})`); continue; }
    const doc = cited(head, 'axiom').find((entry) => entry.name === axiom.name);
    const ids = (doc?.cites ?? []).filter((id) => acceptedIds.has(id));
    if (ids.length !== 1) { add('trusted-axiom-unbound', axiom.name, `the new axiom ${axiom.name} must cite exactly one accepted externals record in its docstring (it cites ${ids.length})`); continue; }
    const record = ids[0];
    const props = cited(base, 'prop').filter((entry) => entry.cites.includes(record) && !inTrustedModule(entry.module) && isFrozen(moduleRel(entry.module)));
    if (props.length !== 1) { add('trusted-axiom-unbound', axiom.name, `the record ${record} is tied to ${props.length} propositions in the frozen spec of the merged spec; it must be tied to exactly one, so the axiom ${axiom.name} has nothing to assert`); continue; }
    const proposition = props[0].name;
    if (axiom.typeConst !== proposition) { add('trusted-axiom-unbound', axiom.name, `the axiom ${axiom.name} asserts ${axiom.typeConst ?? 'something that is not one proposition'}, but the record ${record} is tied to the proposition ${proposition} in the merged spec; an axiom must assert exactly that`); continue; }
    if (closureDigest(closureOf(base.constants, proposition)) !== closureDigest(closureOf(head.constants, proposition))) { add('trusted-axiom-unbound', axiom.name, `the proposition ${proposition} that the record ${record} is tied to changed since the merged spec`); continue; }
    const citing = cited(head, 'axiom').filter((entry) => inTrustedModule(entry.module) && entry.cites.includes(record));
    if (citing.length !== 1) { add('trusted-axiom-unbound', axiom.name, `the record ${record} is cited by ${citing.length} axioms (${citing.map((entry) => entry.name).join(', ')}); it ties one`); continue; }
    bindings.push({ axiom: axiom.name, record, proposition });
  }
  return { problems, statements, bindings };
}

// ---- the run state -------------------------------------------------------------------------

// A run-state file with the digest of the bytes it was read from, or null when there is none.
function readRunFile(root, name) {
  const file = path.join(root, '.formalising', 'auto-fv', name);
  if (!fs.existsSync(file)) return null;
  let bytes;
  try { bytes = fs.readFileSync(file); } catch { return refuse('run-state-unreadable', `${file} cannot be read; fix it, then run the build check again`); }
  try { return { file, sha256: sha256(bytes), data: JSON.parse(bytes.toString('utf8')) }; } catch { return refuse('run-state-unreadable', `${file} is not valid JSON; fix it or move it aside, then run the build check again`); }
}
const readRunRecord = (root, name) => readRunFile(root, name)?.data ?? null;

// JSON with every object's keys in order, as the engine writes its own digests (fvs-auto.mjs, canonicalJson),
// so a record has the same digest in a receipt and when the engine reads the record again.
const canonicalJson = (value) => JSON.stringify(value, (_key, item) => (item !== null && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item));
export const recordDigest = (record) => sha256(canonicalJson(record ?? null));

// The externals records a check relied on (the ones its accepted Trusted axioms are tied to), each with
// a digest of the record as it stood. A consumer that finds a record changed or gone knows the receipt
// was made on an authority that no longer holds.
function externalsBinding(ties, externalsFile) {
  const records = new Map((externalsFile?.data?.records ?? []).map((record) => [record?.id, record]));
  return {
    file: externalsFile?.file ?? null,
    sha256: externalsFile?.sha256 ?? null,
    records: [...new Set(ties.map((tie) => tie.record))].sort().map((id) => ({ id, sha256: recordDigest(records.get(id)) })),
  };
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

// The list given with --allow-axioms: its names and the digest of the bytes they were read from.
function loadAllowedAxioms(file) {
  const resolved = path.resolve(file);
  let bytes;
  try { bytes = fs.readFileSync(resolved); } catch { refuse('allow-axioms-unreadable', `cannot read the allowed-axioms file ${resolved}`); }
  return { file: resolved, sha256: sha256(bytes), names: readAllowedAxioms(bytes, resolved) };
}

export function buildCheck({ projectRoot, commit, specBase, allowAxioms, packages, receiptDir, workdir, keep = false, timeoutSeconds = 7200 }) {
  if (!projectRoot) refuse('usage', '--project-root is required');
  if (!SHA_ARGUMENT.test(commit ?? '')) refuse('usage', '--commit must be a commit hash of 7 to 64 hexadecimal digits');
  const root = fs.existsSync(projectRoot) ? fs.realpathSync(projectRoot) : refuse('usage', `no such project root: ${projectRoot}`);
  const topLevel = git(root, ['rev-parse', '--show-toplevel']);
  if (topLevel === null) refuse('not-a-git-checkout', `${root} is not inside a git checkout`);
  const top = fs.realpathSync(topLevel);
  const full = git(top, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]);
  const tree = full === null ? null : git(top, ['rev-parse', `${full}^{tree}`]);
  if (full === null || tree === null) refuse('commit-not-found', `${commit} is not a commit of this repository`);

  // From here on the commit is known. Once this check holds the lock, an earlier receipt for the commit
  // no longer stands in for it: a non-accepting receipt replaces it at once, and the verdict (or, if
  // the check is refused or dies, the refusal) replaces that. A caller that is refused the lock changes
  // nothing, so it cannot spoil the receipt of the check that is running.
  const receipts = path.resolve(receiptDir ?? path.join(root, '.formalising', 'auto-fv', 'build-check'));
  const release = acquireLock();
  let work = null;
  try {
    writeReceipt(receipts, full, { schema: 1, kind: 'fvs-build-check', accepted: false, label: labelFailed('the check started and did not finish'), commit: full, tree, startedAt: new Date().toISOString() });
    if (specBase !== undefined && !SHA_ARGUMENT.test(specBase)) refuse('usage', '--spec-base must be a commit hash of 7 to 64 hexadecimal digits');
    const specBaseFull = resolveSpecBase({ top, root, full, specBase });
    if (allowAxioms === '') refuse('usage', '--allow-axioms needs the path of the allowed-axioms file');
    const allowed = allowAxioms === undefined ? null : loadAllowedAxioms(allowAxioms);
    const allowedRecord = allowed && { file: allowed.file, sha256: allowed.sha256, names: allowed.names.size };
    work = fs.mkdtempSync(path.join(workdir ? path.resolve(workdir) : os.tmpdir(), `fvs-build-check-${full.slice(0, 12)}-`));
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
    let externalsFile = null;
    const integrity = checkIntegrity({
      base: specBaseFull === null ? null : gitTree(top, specBaseFull, prefix, layout),
      head: gitTree(top, full, prefix, layout),
      layout,
      externals: () => { externalsFile = readRunFile(root, 'externals.json'); const records = externalsFile?.data?.records; return Array.isArray(records) ? records : null; },
    });
    const externalsRecord = externalsBinding(integrity.ties, externalsFile);
    const integrityRecord = { specBase: specBaseFull, compared: specBaseFull !== null, ok: integrity.problems.length === 0, problems: integrity.problems, ties: integrity.ties, extraction: layout };
    if (!integrityRecord.ok) {
      const reason = `${describeProblem(integrity.problems[0])}${integrity.problems.length > 1 ? ` (and ${integrity.problems.length - 1} more)` : ''}`;
      return finish(receipts, full, {
        schema: 1, kind: 'fvs-build-check', accepted: false, label: labelFailed(reason), commit: full, tree,
        leanRoot: path.join(sub, below) || '.', toolchain: toolchainOf(leanRoot), lake: null, packages: null, build: null,
        specFiles: [], flags: [], warnings: [], specBase: specBaseFull, allowAxioms: allowedRecord, externals: externalsRecord, integrity: integrityRecord, checkedAt: new Date().toISOString(),
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
    // A module's .olean, wherever the file's module name puts it; none exists before this check's build.
    const builtModule = (at, rel) => integrity.moduleCandidates(rel).find((module) => fs.existsSync(oleanFile(at, module))) ?? null;
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
    const recalled = new Set();
    for (const rel of files.files) {
      const bytes = fs.readFileSync(path.join(leanRoot, rel));
      const text = bytes.toString('utf8');
      // Raw text, so an option passed as a string in a lakefile is seen too.
      if (/warn\.sorry/.test(text)) tampered.push(`${rel} mentions warn.sorry, which switches off the sorry warning`);
      if (!rel.endsWith('.lean')) continue;
      const spec = readSpecSource(text);
      if (spec.statements.length === 0) continue;
      for (const statement of spec.statements) recalled.add(statement.name);
      const own = log.messages.filter((m) => m.file === rel && m.severity !== 'info');
      const built = builtModule(leanRoot, rel) !== null;
      const statements = spec.statements.map((statement) => {
        const hit = own.find((m) => m.line === statement.recallLine || (statement.guardFrom !== null && m.line >= statement.guardFrom && m.line <= statement.guardTo));
        const unlisted = allowed && statement.axioms ? axiomsNotAllowed(statement.axioms, allowed.names) : [];
        const reason = statement.problems[0] ?? (hit ? describe(hit) : null)
          ?? (own.length > 0 ? `its spec file did not build (${describe(firstProblem(own))})` : built ? null : 'its spec file was not built')
          ?? (unlisted.length === 0 ? null : `the statement ${statement.name} rests on the ${unlisted.length === 1 ? 'axiom' : 'axioms'} ${unlisted.slice(0, 3).join(', ')}${unlisted.length > 3 ? ` and ${unlisted.length - 3} more` : ''}, which the allowed axioms do not name`);
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
    // Lake must have compiled every spec, proof and extraction file, whatever the lakefile says and
    // whether or not the file holds a recall: each needs the .olean this build produced.
    if (reason === null) {
      const unbuilt = integrity.required.filter(({ rel }) => builtModule(leanRoot, rel) === null);
      if (unbuilt.length > 0) reason = `no .olean was produced for ${unbuilt[0].rel}${unbuilt[0].modules[0] ? ` (module ${unbuilt[0].modules[0]})` : ''}, so Lake did not build it${unbuilt.length > 1 ? ` (and ${unbuilt.length - 1} more)` : ''}`;
    }
    // The Lean-level comparison with the merged spec. Without a merged spec there is nothing to compare.
    if (reason === null && specBaseFull !== null) {
      const accepted = (() => {
        try { const file = externalsFile ?? readRunFile(root, 'externals.json'); return new Set((file?.data?.records ?? []).filter((r) => r?.status === 'assumption-accepted' && r.decision && typeof r.id === 'string').map((r) => r.id)); } catch (error) { if (error instanceof Refusal) return new Set(); throw error; }
      })();
      const lean = leanCheck({ top, sub, below, specBaseFull, work, leanRoot, source, hasPackages: manifest.length > 0, env, timeoutSeconds, integrity, recalled, acceptedIds: accepted, builtModule });
      if (lean.error) reason = `the Lean check could not run: ${lean.error}`;
      else {
        integrityRecord.semantic = { toolchain: lean.toolchain, statements: lean.statements, bindings: lean.bindings, dumps: lean.dumps };
        if (lean.problems.length > 0) {
          integrityRecord.problems.push(...lean.problems);
          integrityRecord.ok = false;
          reason = `${describeProblem(lean.problems[0])}${lean.problems.length > 1 ? ` (and ${lean.problems.length - 1} more)` : ''}`;
        }
      }
    }
    const flags = statements.filter((s) => s.flags.length > 0).map((s) => `${s.name} uses ${s.flags.join(', ')}`);
    const warnings = symlinks.soft.length === 0 ? [] : [`symbolic links lead out of the commit to files Lake does not read as Lean sources: ${symlinks.soft.slice(0, 3).join(', ')}${symlinks.soft.length > 3 ? ` and ${symlinks.soft.length - 3} more` : ''}`];
    // Accepted means the statements were compared with the merged spec; a build alone is not that.
    const accepted = reason === null && specBaseFull !== null;
    const label = reason !== null ? labelFailed(reason) : accepted ? LABEL_ACCEPTED : LABEL_UNCHECKED;
    const receipt = {
      schema: 1, kind: 'fvs-build-check', accepted, label, commit: full, tree,
      leanRoot: path.join(sub, below) || '.', toolchain: toolchainOf(leanRoot),
      lake: lakeVersion, packages: { source, copy, revisions },
      build: { argv: build.argv, exitCode: build.status, seconds, log: logFile, logSha256: sha256(logBytes) },
      specFiles, flags, warnings, specBase: specBaseFull, allowAxioms: allowedRecord, externals: externalsRecord, integrity: integrityRecord, checkedAt: new Date().toISOString(),
    };
    return finish(receipts, full, receipt);
  } catch (error) {
    throw leaveRefusal(receipts, full, tree, error);
  } finally {
    release();
    if (work && !keep) fs.rmSync(work, { recursive: true, force: true });
  }
}

const oleanFile = (root, module) => path.join(root, '.lake', 'build', 'lib', 'lean', `${module.replaceAll('.', '/')}.olean`);

// Runs the Lean program on the built head and on a fresh build of the merged spec in a copy of its own,
// then compares them. An `error` means the comparison could not be made, which is not an acceptance.
function leanCheck({ top, sub, below, specBaseFull, work, leanRoot, source, hasPackages, env, timeoutSeconds, integrity, recalled, acceptedIds, builtModule }) {
  const dump = path.join(work, 'dump');
  fs.mkdirSync(dump, { recursive: true });
  fs.writeFileSync(path.join(dump, 'Dump.lean'), DUMP_SOURCE);
  const tail = (file) => { try { return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-3).join(' | ').slice(0, 300); } catch { return ''; } };
  const dumpOf = (side, root) => {
    const modules = [...new Set(leanFiles(root).files.filter((rel) => rel.endsWith('.lean') && !LAKE_FILES.test(rel)).map((rel) => builtModule(root, rel)).filter(Boolean))].sort();
    const args = path.join(dump, `${side}-args.json`);
    fs.writeFileSync(args, JSON.stringify({ modules, recalls: [...recalled].sort(), ids: [...acceptedIds].sort() }));
    const [out, log] = [path.join(dump, `${side}.jsonl`), path.join(dump, `${side}.log`)];
    const run = runLake(['env', 'lean', '--run', path.join(dump, 'Dump.lean'), args], { cwd: root, env, log, stdoutFile: out, timeoutSeconds });
    if (run.status !== 0) return { error: `the Lean program failed on the ${side} (exit ${run.status}): ${tail(log)}` };
    const text = fs.readFileSync(out, 'utf8');
    try { return { dump: parseDump(text), sha256: sha256(text) }; } catch (error) { return { error: `the Lean program's output for the ${side} cannot be read (${error.message}): ${tail(log)}` }; }
  };
  const head = dumpOf('head', leanRoot);
  if (head.error) return head;

  const baseClean = path.join(work, 'base');
  fs.mkdirSync(path.join(work, 'base-index'), { recursive: true });
  extractCommit(top, specBaseFull, path.join(work, 'base-index'), baseClean);
  const baseRoot = path.join(baseClean, sub, below);
  if (!hasLakefile(baseRoot)) return { error: `the merged spec ${specBaseFull.slice(0, 12)} has no Lean project at ${path.join(sub, below) || '.'}` };
  if (hasPackages) copyPackages(source, path.join(baseRoot, '.lake', 'packages'));
  const baseLog = path.join(work, 'base-build.log');
  const build = runLake(['build', '--no-ansi'], { cwd: baseRoot, env, log: baseLog, timeoutSeconds });
  if (build.status !== 0) {
    const problem = firstProblem(readLog(fs.readFileSync(baseLog, 'utf8')).messages);
    return { error: `the merged spec ${specBaseFull.slice(0, 12)} does not build (${problem ? describe(problem) : `lake exited with status ${build.status}`})` };
  }
  const base = dumpOf('base', baseRoot);
  if (base.error) return base;
  const { problems, statements, bindings } = semanticProblems({ base: base.dump, head: head.dump, recalled: [...recalled].sort(), acceptedIds });
  return { problems, statements, bindings, toolchain: head.dump.toolchain, dumps: { base: base.sha256, head: head.sha256 } };
}

const toolchainOf = (leanRoot) => (fs.existsSync(path.join(leanRoot, 'lean-toolchain')) ? fs.readFileSync(path.join(leanRoot, 'lean-toolchain'), 'utf8').trim() : null);

// Writes a receipt bound to the commit, replacing the one that was there. If the new one cannot be
// written, the old one is removed rather than left standing.
function writeReceipt(receipts, full, receipt) {
  const receiptPath = path.join(receipts, `${full}.json`);
  try {
    fs.mkdirSync(receipts, { recursive: true });
    fs.writeFileSync(`${receiptPath}.tmp`, `${JSON.stringify(receipt, null, 2)}\n`);
    fs.renameSync(`${receiptPath}.tmp`, receiptPath);
  } catch (error) {
    try { fs.rmSync(receiptPath, { force: true }); } catch { /* the folder cannot be written at all */ }
    throw new Refusal('receipt-not-written', `the receipt ${receiptPath} could not be written (${error.message})`);
  }
  return receiptPath;
}

// A refused or crashed check leaves a terminal, non-accepting receipt for the commit, so an earlier
// accepting receipt does not stand in for a check that did not complete.
function leaveRefusal(receipts, full, tree, error) {
  const code = error instanceof Refusal ? error.code : 'internal-error';
  const message = error instanceof Error ? error.message : String(error);
  try {
    const file = writeReceipt(receipts, full, { schema: 1, kind: 'fvs-build-check', accepted: false, label: `build check refused (${code}): ${message}`.slice(0, 400), commit: full, tree, refusal: { code, message }, checkedAt: new Date().toISOString() });
    if (error instanceof Refusal) error.receipt = file;
  } catch { /* the earlier receipt was already replaced or removed */ }
  return error;
}

// Writes the receipt for a verdict, bound to the commit, and returns the result. A receipt is written
// for every verdict, so a later verdict for the same commit replaces an earlier one.
function finish(receipts, full, receipt) {
  const receiptPath = writeReceipt(receipts, full, receipt);
  const code = receipt.accepted ? 'accepted' : receipt.label === LABEL_UNCHECKED ? 'unchecked' : 'failed';
  return { ok: true, code, ...receipt, receipt: receiptPath, report: reportLines(receipt) };
}

function reportLines(receipt) {
  const { integrity } = receipt;
  const lines = [receipt.label, `commit ${receipt.commit}`, `tree ${receipt.tree}`, ...receipt.warnings.map((warning) => `warning: ${warning}`)];
  lines.push(integrity.compared ? `spec base ${integrity.specBase}: statements, frozen paths and added code compared with the merged spec`
    : 'spec base: none given or recorded, so the statements were not compared with a merged spec and this is not an acceptance');
  lines.push(receipt.allowAxioms ? `allowed axioms: ${receipt.allowAxioms.names} names from ${receipt.allowAxioms.file} (sha256 ${receipt.allowAxioms.sha256}); a statement that rests on any other non-standard axiom does not pass`
    : 'allowed axioms: no list given, so no statement is held to a list of axioms');
  const { folders, files } = integrity.extraction ?? { folders: [], files: [] };
  lines.push(`extraction output held fixed, besides the folders named Extraction...: ${folders.length + files.length === 0 ? 'none recorded in the run state' : [...folders, ...files].join(', ')}`);
  if (integrity.semantic) {
    const { statements, bindings, toolchain } = integrity.semantic;
    lines.push(`Lean check (${toolchain.lean}): recalled declarations compared: ${statements.length} (${statements.reduce((sum, item) => sum + item.constants, 0)} project constants); new Trusted axioms bound to their records: ${bindings.length}`);
  }
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
  const valued = { '--project-root': 'projectRoot', '--commit': 'commit', '--spec-base': 'specBase', '--allow-axioms': 'allowAxioms', '--packages': 'packages', '--receipt-dir': 'receiptDir', '--workdir': 'workdir', '--timeout': 'timeoutSeconds' };
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

// Run only when this file is the program, not when it is imported or read from stdin (argv[1] is then
// missing or names no file).
let direct = false;
try { direct = fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { /* imported or piped */ }
if (direct) {
  try {
    const { report, ...result } = buildCheck(parseArguments(process.argv.slice(2)));
    // stdout holds the JSON result and nothing else, so a caller can parse it; the report is for people.
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.stderr.write(`${report.join('\n')}\n`);
    process.exitCode = result.accepted ? 0 : 1;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    process.stdout.write(`${JSON.stringify({ ok: false, code: error.code, message: error.message, ...(error.receipt ? { receipt: error.receipt } : {}) }, null, 2)}\n`);
    process.stderr.write(`refused (${error.code}): ${error.message}\n`);
    process.exitCode = 2;
  }
}
