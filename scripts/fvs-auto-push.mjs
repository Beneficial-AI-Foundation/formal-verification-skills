#!/usr/bin/env node
// Push command for the auto track: the one way a worker or the orchestrator pushes a branch of the run.
//
//   node <fvs scripts dir>/fvs-auto-push.mjs --branch fvs/<name>
//
// It pushes `refs/heads/<branch>:refs/heads/<branch>` to the destination URL that /fvs:auto-init recorded, and
// nothing else. It never uses a remote name, so remote.<name>.push, remote.<name>.pushurl, remote.<name>.mirror,
// remote.pushDefault, branch.*.pushRemote and push.default cannot redirect or widen it. Before it pushes it refuses
// unless all of these hold:
//   - exactly `--branch <name>` was given (any other argument is refused);
//   - the shared git directory of the repository it runs in is the one recorded at init, and the recorded project
//     root is a checkout of that same repository (the main checkout and its linked worktrees pass; a link, a copy
//     or another repository does not);
//   - `refs/heads/<name>` exists as a branch under a recorded namespace (fvs/...), is not a symbolic ref, and no tag
//     of the same name exists;
//   - no url.<base>.insteadOf or url.<base>.pushInsteadOf rule applies to the recorded URL, and no
//     [remote "<url>"] section names it, and git itself does not rewrite it.
// The push uses an explicit full refspec without `+`, --no-follow-tags and -c push.followTags=false,
// --recurse-submodules=no, --porcelain and -c core.abbrev=no (full object ids). The result is appended to
// .formalising/auto-fv/pushes.jsonl of the recorded project root.
//
// What it does not do: git hooks in the repository still run, as for any push; credential helpers, ssh and proxy
// settings come from the user's git configuration and environment; the recorded destination is a plain file that
// any session of the same user can change; and a rewrite rule added after the check but before the connection is a
// race it cannot close. It trusts the `git` found on PATH.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const RECORD_NAME = 'fvs-auto-push.json';
export const LOG_FILE = '.formalising/auto-fv/pushes.jsonl';
export const RECORD_SCHEMA = 'fvs/auto-push-destination';
export const WORD = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Branch namespaces a run must never be allowed to push to without asking.
export const RESERVED = new Set(['main', 'master', 'HEAD', 'head', 'release', 'releases', 'develop', 'dev', 'trunk']);

// ---- the destination URL ------------------------------------------------------------------------------------

// Host and OWNER/REPO of a git URL, or null when the URL does not name exactly one repository on one host
// (a local path, a file URL, a path with more or fewer than two segments).
export function parseRemoteUrl(url) {
  const text = String(url).trim();
  // Different programs read a backslash, a space or a control character in a URL differently, and a leading "-" can
  // pass for an option, so none of them is a plain URL.
  if (text.startsWith('-') || /[\\\s\x00-\x1f\x7f]/.test(text)) return null;
  // In the scp-like form git splits at the first colon, so the optional user part cannot hold one:
  // "evil.test:x@github.com:Acme/proj" is host evil.test, not github.com.
  const found = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^/:@]+)(?::\d*)?\/(.+)$/i.exec(text)
    ?? /^(?:[^@/\s:]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(text);
  if (!found) return null;
  const segments = found[2].replace(/\/+$/, '').replace(/\.git$/, '').split('/');
  if (segments.length !== 2 || segments.some((part) => !/^[A-Za-z0-9._-]+$/.test(part))) return null;
  return { host: found[1].toLowerCase(), repo: segments.join('/') };
}

// The push target must be the project's own repository, and a remote can name several: git fetches from the first
// URL but pushes to every push URL (or, with none, every URL). So all URLs git would use, after its own URL
// rewriting, must name the agreed host and repository. Returns null when they do, else {code, message}.
export function destinationProblem(dir, remote, repo, host) {
  for (const [label, args] of [['fetch', []], ['push', ['--push']]]) {
    const run = spawnSync('git', ['-C', dir, 'remote', 'get-url', ...args, '--all', remote], { encoding: 'utf8', timeout: 10000 });
    if (run.status !== 0) return { code: 'remote-missing', message: `git remote ${remote} is not set in ${dir}` };
    const urls = run.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    if (urls.length === 0) return { code: 'remote-ambiguous', message: `git remote ${remote} has no ${label} URL` };
    for (const url of urls) {
      const named = parseRemoteUrl(url);
      if (!named) return { code: 'remote-ambiguous', message: `cannot tell which repository the ${label} URL ${url} of remote ${remote} names; every URL of the remote must be a plain host and OWNER/REPO URL` };
      if (named.host !== host.toLowerCase() || named.repo.toLowerCase() !== repo.toLowerCase()) {
        return { code: 'remote-mismatch', message: `the ${label} URL ${url} of remote ${remote} names ${named.host}/${named.repo}, not ${host}/${repo}; every URL of the remote must name the project's own repository` };
      }
    }
  }
  return null;
}

function git(args, { cwd, env, stdio } = {}) {
  const run = spawnSync('git', args, { cwd, env, encoding: 'utf8', timeout: 30000, ...(stdio ? { stdio } : {}) });
  return { status: run.status, stdout: run.stdout ?? '', stderr: (run.stderr ?? '').trim(), error: run.error };
}

// Git rewrites a URL given to push by the longest matching url.<base>.insteadOf or url.<base>.pushInsteadOf prefix,
// and the push then goes to the rewritten address. Instead of predicting which rule wins, any rule that applies to the
// recorded URL is a refusal. A [remote "<url>"] section is refused too: git does not read one for a URL with a slash,
// but a refusal costs nothing and keeps the check independent of that detail. Returns null or a plain message.
export function rewriteProblem(cwd, url, env) {
  const list = git(['config', '--list', '-z'], { cwd, env });
  if (list.status !== 0) return `git config could not be read (${list.stderr || list.error?.message || `exit ${list.status}`})`;
  for (const entry of list.stdout.split('\0').filter(Boolean)) {
    const at = entry.indexOf('\n');
    const key = at < 0 ? entry : entry.slice(0, at);
    const value = at < 0 ? '' : entry.slice(at + 1);
    const rewrite = /^url\.(.+)\.(insteadof|pushinsteadof)$/.exec(key);
    if (rewrite && url.startsWith(value)) return `the git setting ${key} = ${JSON.stringify(value)} would rewrite the recorded destination ${url}`;
    const remote = /^remote\.(.+)\.[^.]+$/.exec(key);
    if (remote && remote[1] === url) return `the git setting ${key} names the recorded destination as a remote`;
  }
  const shown = git(['ls-remote', '--get-url', url], { cwd, env });
  if (shown.status !== 0 || shown.stdout.trim() !== url) return `git reads the recorded destination ${url} as ${shown.stdout.trim() || '(unreadable)'}`;
  return null;
}

// ---- the record written at init -----------------------------------------------------------------------------

// The record is the destination the owner confirmed: the URL itself, its host and OWNER/REPO, the namespaces the run
// pushes under, the project root, and the shared git directory of that repository.
export function destinationRecord({ projectRoot, commonDir, url, host, repo, prefixes }) {
  return { schema: RECORD_SCHEMA, schemaVersion: 1, projectRoot, commonDir, url, host, repo, prefixes: [...prefixes] };
}

export function checkPrefixShape(prefix) {
  const parts = String(prefix).split('/');
  if (!parts.every((part) => WORD.test(part)) || String(prefix).includes('..') || String(prefix).endsWith('.lock')) return 'must be plain words joined by "/" (no wildcard, colon, dots at the start, or "..")';
  if (RESERVED.has(parts[0])) return 'is a shared branch name';
  return null;
}

// A problem with the content of a record, or null. A record that is not exactly this shape is not used.
export function recordProblem(record) {
  const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!plain(record) || record.schema !== RECORD_SCHEMA || record.schemaVersion !== 1) return 'is not an fvs/auto-push-destination record';
  const text = (value) => typeof value === 'string' && value.length > 0 && !/[\s\x00-\x1f\x7f]/.test(value) && !value.startsWith('-');
  for (const field of ['projectRoot', 'commonDir', 'url']) if (!text(record[field])) return `has no usable ${field}`;
  if (!path.isAbsolute(record.projectRoot) || !path.isAbsolute(record.commonDir)) return 'names a project root or git directory that is not an absolute path';
  if (!/^[A-Za-z0-9.-]+$/.test(String(record.host))) return 'has no usable host';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/.test(String(record.repo))) return 'has no usable OWNER/REPO';
  if (!Array.isArray(record.prefixes) || record.prefixes.length === 0) return 'names no branch namespace';
  for (const prefix of record.prefixes) { const bad = checkPrefixShape(prefix); if (bad) return `has the branch namespace ${JSON.stringify(prefix)}, which ${bad}`; }
  // The URL must still be the repository the record names, spelled as git reads it.
  const named = parseRemoteUrl(record.url);
  if (!named || named.host !== record.host.toLowerCase() || named.repo.toLowerCase() !== record.repo.toLowerCase()) return 'names a URL that is not the recorded host and OWNER/REPO';
  return null;
}

// ---- checks before a push -----------------------------------------------------------------------------------

class Refuse extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
const refuse = (code, message, details) => { throw new Refuse(code, message, details); };

// Environment variables that move git to another repository or work tree than the working directory shows.
const MOVING = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE'];

// Where the command runs: the physical top of the work tree and the shared git directory, links resolved.
export function locate(cwd, env) {
  for (const name of MOVING) if (env[name]) refuse('git-environment', `${name} is set in the environment, so git would not use the repository of the working directory; unset it`);
  const top = git(['rev-parse', '--show-toplevel'], { cwd, env });
  const common = git(['rev-parse', '--git-common-dir'], { cwd, env });
  if (top.status !== 0 || common.status !== 0) refuse('not-a-repository', `${cwd} is not inside a git work tree`);
  return { top: fs.realpathSync.native(top.stdout.trim()), commonDir: fs.realpathSync.native(path.resolve(cwd, common.stdout.trim())) };
}

export function readRecord(commonDir) {
  const file = path.join(commonDir, RECORD_NAME);
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    refuse('no-destination-recorded', error.code === 'ENOENT'
      ? `no push destination is recorded for this repository (${file} is missing); run /fvs:auto-init and confirm the push rule first`
      : `${file} cannot be read as JSON (${error.message})`);
  }
  const bad = recordProblem(record);
  if (bad) refuse('destination-record-invalid', `${file} ${bad}; run /fvs:auto-init again`);
  return record;
}

// The repository the command runs in must be the one the destination was recorded for. The comparison is the shared git
// directory, because a worker works in a linked worktree whose top directory is not the project root. The recorded
// project root must also still be a checkout of this same repository.
export function repositoryProblem(record, found, env) {
  if (record.commonDir !== found.commonDir) return `this repository (${found.commonDir}) is not the one the destination was recorded for (${record.commonDir})`;
  const rootCommon = git(['rev-parse', '--git-common-dir'], { cwd: record.projectRoot, env });
  let rootDir = null;
  try { if (rootCommon.status === 0) rootDir = fs.realpathSync.native(path.resolve(record.projectRoot, rootCommon.stdout.trim())); } catch { /* the recorded root is gone */ }
  if (rootDir !== found.commonDir) return `the recorded project root ${record.projectRoot} is not a checkout of this repository`;
  return null;
}

export function branchProblem(found, branch, prefixes, env) {
  const parts = branch.split('/');
  const inside = prefixes.some((prefix) => branch.startsWith(`${prefix}/`) && branch.length > prefix.length + 1);
  if (!inside || !parts.every((part) => WORD.test(part)) || branch.includes('..') || branch.endsWith('.lock')) {
    return `${JSON.stringify(branch)} is not a plain branch name under ${prefixes.map((prefix) => `${prefix}/`).join(' or ')}`;
  }
  const at = { cwd: found.top, env };
  if (git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], at).status !== 0) return `refs/heads/${branch} does not exist as a local branch`;
  if (git(['symbolic-ref', '-q', `refs/heads/${branch}`], at).status === 0) return `refs/heads/${branch} is a symbolic ref, not a branch`;
  if (git(['show-ref', '--verify', '--quiet', `refs/tags/${branch}`], at).status === 0) return `${branch} names both a branch and a tag, so it is ambiguous`;
  return null;
}

// What `git push --porcelain` printed for the one ref: the flag, git's summary and, for a fast-forward, both ids.
export function parsePorcelain(stdout, branch) {
  const lines = stdout.split('\n');
  const to = lines.find((line) => line.startsWith('To '))?.slice(3) ?? null;
  const ref = `refs/heads/${branch}:refs/heads/${branch}`;
  const line = lines.find((one) => one.split('\t')[1] === ref) ?? null;
  if (!line) return { to, line: null, flag: null, summary: null, old: null, new: null };
  const [flag, , summary = ''] = line.split('\t');
  const ids = /^([0-9a-f]{40,64})\.\.\.?([0-9a-f]{40,64})$/.exec(summary);
  return { to, line, flag, summary, old: ids ? ids[1] : null, new: ids ? ids[2] : null };
}

// `git push --porcelain` prints the destination with the user part removed ("ssh://git@host/x" becomes "ssh://host/x"),
// as git's own transport_anonymize_url does. This is that rule, so the printed line can be compared with the record.
export function anonymizeUrl(url) {
  const at = url.indexOf('@');
  if (at < 0 || url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) return url;
  const rest = url.slice(at + 1);
  const scheme = url.indexOf('://');
  if (scheme < 0) return rest.includes(':') ? rest : url;
  if (![...url.slice(0, scheme)].every((c) => /[A-Za-z0-9+.-]/.test(c))) return url;
  const slash = url.indexOf('/', scheme + 3);
  if (slash >= 0 && slash < at + 1) return url;
  return url.slice(0, scheme + 3) + rest;
}

const STATUS = { '*': 'created', ' ': 'fast-forward', '=': 'up-to-date', '!': 'rejected', '+': 'forced', '-': 'deleted' };

function appendLog(record, entry) {
  const file = path.join(record.projectRoot, LOG_FILE);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    return { recorded: true, file };
  } catch (error) {
    return { recorded: false, recordError: error.message };
  }
}

const USAGE = 'the only accepted form is: node <fvs scripts dir>/fvs-auto-push.mjs --branch fvs/<name>';

// Runs the whole command and returns {status, json}; main() only prints it.
export function run(argv, { cwd = process.cwd(), env = process.env, now = () => new Date() } = {}) {
  try {
    if (argv.length !== 2 || argv[0] !== '--branch' || !argv[1] || argv[1].startsWith('-')) refuse('usage', `${USAGE}; no other argument is accepted`);
    const branch = argv[1];
    const found = locate(cwd, env);
    const record = readRecord(found.commonDir);
    const wrongPlace = repositoryProblem(record, found, env);
    if (wrongPlace) refuse('wrong-repository', wrongPlace);
    const wrongBranch = branchProblem(found, branch, record.prefixes, env);
    if (wrongBranch) refuse('branch-refused', wrongBranch);
    const rewritten = rewriteProblem(found.top, record.url, env);
    if (rewritten) refuse('destination-rewritten', `${rewritten}; the push was not made`);
    const tip = git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], { cwd: found.top, env }).stdout.trim();
    const refspec = `refs/heads/${branch}:refs/heads/${branch}`;
    const pushed = git(['-c', 'push.followTags=false', '-c', 'core.abbrev=no', 'push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no', record.url, refspec],
      { cwd: found.top, env, stdio: ['inherit', 'pipe', 'inherit'] });
    const seen = parsePorcelain(pushed.stdout, branch);
    const status = STATUS[seen.flag] ?? null;
    const sent = pushed.status === 0 && (status === 'created' || status === 'fast-forward' || status === 'up-to-date');
    const entry = {
      at: now().toISOString(), branch, destination: record.url, repositoryRoot: found.top, commonDir: found.commonDir,
      result: sent ? status : 'failed', porcelainFlag: seen.flag, porcelain: seen.line, to: seen.to,
      oldRemoteId: seen.old, newRemoteId: sent ? (seen.new ?? tip) : null, localBranchId: tip, exitStatus: pushed.status,
    };
    const log = appendLog(record, entry);
    const detail = { ...entry, ...log };
    if (!sent) refuse('push-failed', `git did not push ${branch}: ${seen.line ? seen.line.replace(/\t/g, ' ') : `exit ${pushed.status}${pushed.error ? ` (${pushed.error.message})` : ''}`}. Nothing was changed on the destination unless git says so above.`, detail);
    if (seen.to !== null && seen.to !== record.url && seen.to !== anonymizeUrl(record.url)) refuse('unexpected-destination', `the push ran, but git reported ${seen.to} instead of the recorded ${record.url}; tell the owner`, detail);
    return { status: 0, json: { code: 'pushed', ...detail } };
  } catch (error) {
    if (!(error instanceof Refuse)) throw error;
    return { status: error.code === 'usage' ? 2 : 1, json: { code: error.code, message: error.message, ...error.details } };
  }
}

export function main(argv) {
  const out = run(argv);
  process.stdout.write(JSON.stringify(out.json, null, 2) + '\n');
  if (out.status !== 0) process.stderr.write(`fvs-auto-push: ${out.json.message}\n`);
  process.exitCode = out.status;
}

// Run only as a program, never when a test or the permission check imports the functions above.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
