#!/usr/bin/env node
// Build check: build one commit of a Lean project in a fresh clean copy and report
// what the build proves.
//
//   node fvs-build-check.mjs --project-root R --commit SHA
//        [--packages DIR] [--receipt-dir DIR] [--workdir DIR] [--keep] [--timeout SECONDS]
//
// The copy holds exactly the tracked files of the commit, never the author's working
// tree, and the project's own .lake/build is never copied, so every project module is
// rebuilt and every warning fires again. Only the prebuilt dependency packages are
// reused, cloned copy-on-write where the filesystem allows. They are checked first: a
// dependency that Lake would rebuild (a Mathlib built for another revision, a missing
// package) stops the check before any build starts.
//
// The build is `lake build --wfail`: every warning, so every `sorry`, fails it. Each
// spec file restates its statements with `recall` and pins what they rest on with
// `#guard_msgs ... in #print axioms NAME`; the build enforces those guards, and this
// script refuses a pass that rests on guards it cannot read or that say nothing.
//
// A verdict, accepted or not, is written as a receipt bound to the commit and its tree.
// Output: one JSON object. Exit status 0 accepted, 1 build check failed, 2 refused.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const LABEL_ACCEPTED = 'accepted (build check in a clean copy)';
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

// Comments are blanked and docstrings are replaced by a numbered marker, so the text that
// is left can be matched without a commented-out guard counting. Line numbers are kept.
export function stripLean(text) {
  const docstrings = [];
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
    } else if (text.startsWith("'\"'", i)) {
      code += "'?'";
      i += 3;
    } else if (text[i] === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      code += `""${newlines(text.slice(i, j + 1))}`;
      i = j + 1;
    } else {
      code += text[i];
      i += 1;
    }
  }
  return { code, docstrings };
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
    const run = spawnSync(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', out, out], timeout: timeoutSeconds * 1000 });
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

// ---- the check -----------------------------------------------------------------------------

export function buildCheck({ projectRoot, commit, packages, receiptDir, workdir, keep = false, timeoutSeconds = 7200 }) {
  if (!projectRoot) refuse('usage', '--project-root is required');
  if (!SHA_ARGUMENT.test(commit ?? '')) refuse('usage', '--commit must be a commit hash of 7 to 64 hexadecimal digits');
  const root = fs.existsSync(projectRoot) ? fs.realpathSync(projectRoot) : refuse('usage', `no such project root: ${projectRoot}`);
  const topLevel = git(root, ['rev-parse', '--show-toplevel']);
  if (topLevel === null) refuse('not-a-git-checkout', `${root} is not inside a git checkout`);
  const top = fs.realpathSync(topLevel);
  const full = git(top, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]);
  const tree = full === null ? null : git(top, ['rev-parse', `${full}^{tree}`]);
  if (full === null || tree === null) refuse('commit-not-found', `${commit} is not a commit of this repository`);

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
      leanRoot: path.join(sub, below) || '.', toolchain: (fs.existsSync(path.join(leanRoot, 'lean-toolchain')) ? fs.readFileSync(path.join(leanRoot, 'lean-toolchain'), 'utf8').trim() : null),
      lake: lakeVersion, packages: { source, copy, revisions },
      build: { argv: build.argv, exitCode: build.status, seconds, log: logFile, logSha256: sha256(logBytes) },
      specFiles, flags, warnings, checkedAt: new Date().toISOString(),
    };
    const receiptPath = path.join(receipts, `${full}.json`);
    fs.writeFileSync(`${receiptPath}.tmp`, `${JSON.stringify(receipt, null, 2)}\n`);
    fs.renameSync(`${receiptPath}.tmp`, receiptPath);
    return { ok: true, code: accepted ? 'accepted' : 'failed', ...receipt, receipt: receiptPath, report: reportLines(receipt) };
  } finally {
    release();
    if (!keep) fs.rmSync(work, { recursive: true, force: true });
  }
}

function reportLines(receipt) {
  const lines = [receipt.label, `commit ${receipt.commit}`, `tree ${receipt.tree}`, ...receipt.warnings.map((warning) => `warning: ${warning}`)];
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
  const valued = { '--project-root': 'projectRoot', '--commit': 'commit', '--packages': 'packages', '--receipt-dir': 'receiptDir', '--workdir': 'workdir', '--timeout': 'timeoutSeconds' };
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
    const result = buildCheck(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.accepted ? 0 : 1;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    process.stdout.write(`${JSON.stringify({ ok: false, code: error.code, message: error.message }, null, 2)}\n`);
    process.exitCode = 2;
  }
}
