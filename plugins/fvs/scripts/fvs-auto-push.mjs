#!/usr/bin/env node
// Push command for the auto track: the one way a worker or the orchestrator pushes a branch of the run.
//
//   node <fvs scripts dir>/fvs-auto-push.mjs --branch fvs/<name>
//
// It pushes `refs/heads/<branch>:refs/heads/<branch>` to the destination URL that /fvs:auto-init recorded. It is a
// cooperative guard with some hardening, not a security boundary: CONTRACT below says what it checks, what it hardens
// and what it trusts, and the permissions page and every confirmation print the same list.
//
// It never uses a remote name, so remote.<name>.push, remote.<name>.pushurl, remote.<name>.mirror, remote.pushDefault,
// branch.*.pushRemote and push.default do not apply to it. Before it pushes it refuses unless all of these hold:
//   - exactly `--branch <name>` was given (any other argument is refused);
//   - the shared git directory of the repository it runs in is the one recorded at init, and the recorded project
//     root is a checkout of that same repository (the main checkout and its linked worktrees pass; a link, a copy
//     or another repository does not), and git started in the top of this work tree uses the same repository (a
//     core.worktree setting that points at another repository's files is refused);
//   - `refs/heads/<name>` exists as a branch under a recorded namespace (fvs/...), is not a symbolic ref, and no tag
//     of the same name exists;
//   - every url.<base>.insteadOf or url.<base>.pushInsteadOf rule that applies to the recorded URL sends it to the same
//     destination (host and OWNER/REPO, over https or ssh, see `sameDestination`), no [remote "<url>"] section names
//     it, and git itself rewrites it to nothing else. A remote that holds the destination with user information in an
//     http or https address (a token) is the address the push uses (`configuredAddress`), and what git prints is cleaned of it.
// Every git call that acts on the repository (the branch checks, the URL checks, the tip read and the push) names the git
// directory and the work tree that were found and checked, so none of them finds a repository again from a directory.
// Three calls do look for one: the first, which finds it; its round trip from the top of the work tree, which checks
// it; and a read of the shared git directory of the recorded project root. The record itself is found before any of them,
// from the files alone (`recordHint`), because it says which git variables to keep and git may need one to answer at all.
// The push uses an explicit full refspec without `+`, --no-follow-tags and -c push.followTags=false,
// --recurse-submodules=no, -c push.pushOption= (no push option from any configuration), --no-verify (no pre-push hook,
// also one set with hook.<name>.event) and -c core.hooksPath=/dev/null (no hook in any hooks folder), --porcelain and
// -c core.abbrev=no (full object ids), and every git call runs without the GIT_* variables listed in cleanEnvironment,
// except the git configuration variables whose names the user trusted at init (see the record): they are kept with
// whatever value they have, and every call sees the same set. The result is appended to .formalising/auto-fv/pushes.jsonl of the recorded
// project root. It names only object ids that the push reported: a new or up-to-date branch has none in git's summary.
// When git does not report a result for the branch (a timeout, a lost connection), the outcome is `unknown`, and the
// destination may have changed.
import crypto from 'node:crypto';
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

// What the command is and what it is not, in the words that the permissions page and every confirmation print. It is
// cooperative: it guards against mistakes and misuse through its own command line, and trusts the user's git setup the way
// a push the user runs would. A test compares the page with these lists, so change both together.
export const CONTRACT = {
  kind: 'cooperative, with hardening, and not a security boundary',
  checks: [
    'It takes exactly --branch <name> and refuses anything else on its command line.',
    'It compares the shared git directory of the repository it runs in with the one recorded for the destination, and refuses when they differ or when a work tree points at another repository.',
    'It refuses a branch that is not a plain local branch under a recorded namespace. It pushes to the destination address recorded at init, and refuses that address when a URL rewrite rule would send it anywhere but to the same host and OWNER/REPO, or over any scheme but https or ssh (ssh:// or git@host:OWNER/REPO), or to another port. A rule that only adds user information to an http or https address, as a sandbox does to inject a token, is allowed, and so is a rule that changes the address between https, ssh:// and git@host:OWNER/REPO on the same host and OWNER/REPO: the record holds the address without user information, and no message, record or receipt shows it.',
  ],
  hardening: [
    'The push is made with --no-verify, which skips the pre-push hook whether it is a file in a hooks folder or is set in git configuration (hook.<name>.event), and core.hooksPath is set to /dev/null so that git finds no hook in any hooks folder. Your own pre-push checks do not run for it.',
    'git runs without GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_CONFIG, GIT_NAMESPACE and GIT_EXEC_PATH. It also runs without GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM, GIT_CONFIG_NOSYSTEM, GIT_CONFIG_COUNT, the GIT_CONFIG_KEY_n and GIT_CONFIG_VALUE_n pairs and GIT_CONFIG_PARAMETERS, except the ones whose names you trusted when you confirmed the destination at init. Init lists those names and never prints a value, because a value can be a token: it shows the length of each. GIT_CONFIG_COUNT and the GIT_CONFIG_KEY_n and GIT_CONFIG_VALUE_n pairs that it addresses are one unit: trusting the count trusts the pairs it addresses when the command runs. The command keeps each trusted name with whatever value it has when it runs, in every git call, and drops every other name. A trusted name that is not set is skipped, and a value that changed since init is not refused: the receipt marks it as changed. The configuration files that git reads by default stay, and so do your ssh, credential and transport settings that are not set through those variables.',
    'No push option is sent.',
  ],
  trusts: [
    'Your git setup, as for any push you run yourself.',
    'ssh and other transport wrappers (GIT_SSH_COMMAND, core.sshCommand, proxy and remote helpers): the command cannot tell where one of them sends the push.',
    'Credential helpers.',
    'The git configuration variables whose names you trusted at init, the way you trust your own git configuration files: whatever value they have when the command runs is used for the checks and for the push.',
    'The address that a remote of the repository holds with user information (a token) for the recorded host and OWNER/REPO, such as https://x-access-token:TOKEN@github.com/OWNER/REPO in origin: when there is exactly one, the push goes to it, after the same host, repository and rewrite checks, so the token in your own git configuration keeps working. The record, the messages and the receipt never show the token, and the command removes it from what git prints. As with any git push, the address and its token are visible in the process arguments of the local machine while git runs.',
    'URL rewrite rules: a rule that is added or changed after the command checks and before it connects is not caught.',
    'The record file and FVS itself: anything that runs as your user can edit the record, the script and the permission rule, and so change where the command pushes or what it checks.',
    'The git program found on PATH.',
  ],
};

// The same contract as one plain paragraph, for messages and notes.
export const contractText = () => `The push command is ${CONTRACT.kind}. ${CONTRACT.checks.join(' ')} ${CONTRACT.hardening.join(' ')} It trusts the following and does not protect against it. ${CONTRACT.trusts.join(' ')}`;

// ---- the destination URL ------------------------------------------------------------------------------------

// User information in an http or https address (https://user:token@host/...) is a credential: a token can sit in the
// address of the remote, or reach git through a rewrite rule that a sandbox injects. The destination is the host and
// OWNER/REPO, so the address is recorded without the user part, and a message that has to name an address shows it
// without that part too. The user name of an ssh address (git@host) is not a secret and stays.
const embedsCredential = (url) => /^https?:\/\/[^/]*@/i.test(String(url).trim());
export const stripCredential = (url) => String(url).trim().replace(/^(https?:\/\/)[^/]*@/i, '$1');
export const scrub = (text) => String(text).replace(/(https?:\/\/)[^/\s"']*@/gi, '$1***@');

// OWNER/REPO of the path of an address, or null when the path does not name exactly one repository.
const repoOf = (pathPart) => {
  const segments = pathPart.replace(/\/+$/, '').replace(/\.git$/, '').split('/');
  return segments.length === 2 && segments.every((part) => /^[A-Za-z0-9._-]+$/.test(part)) ? segments.join('/') : null;
};

// The scheme, host, port and OWNER/REPO of an address, read the strict way, or null when any part is unusual. It is how
// a rewrite rule is judged: whether two spellings are one destination. Git and curl end the host at "/", "?", "#" and a
// backslash, so in http://host:1#@other:2/ the request goes to host:1, and such an address is null here, not user
// information for other:2. The user part must be plain (no "/", "?", "#", "\" or "@"), is not part of the result, and
// has no ":" in an ssh address. The forms are https://, http://, ssh:// and the scp-like git@host:OWNER/REPO.
// A port is null when it is absent or the default of the scheme.
const HOST = String.raw`(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])`;
const DEFAULT_PORT = { http: '80', https: '443', ssh: '22' };
export function addressOf(url) {
  const text = String(url).trim();
  if (text.startsWith('-') || /[\\\s\x00-\x1f\x7f]/.test(text)) return null;
  const scheme = new RegExp(`^(https?|ssh)://(?:([^/?#@]+)@)?(${HOST})(?::(\\d{1,5}))?/([^?#]*)$`, 'i').exec(text);
  let found = null;
  if (scheme) {
    if (scheme[1].toLowerCase() === 'ssh' && scheme[2]?.includes(':')) return null;
    found = { scheme: scheme[1].toLowerCase(), host: scheme[3], port: scheme[4] ?? null, path: scheme[5] };
  } else {
    const scp = /^(?:[^@/\s:?#]+@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(text);
    if (scp) found = { scheme: 'ssh', host: scp[1], port: null, path: scp[2] };
  }
  const repo = found && repoOf(found.path);
  if (!repo) return null;
  return { scheme: found.scheme, host: found.host.toLowerCase(), port: found.port === DEFAULT_PORT[found.scheme] ? null : found.port, repo };
}

// Two spellings of one destination: the same host and OWNER/REPO, over the same scheme and port, or over https and ssh
// (ssh:// and git@host:OWNER/REPO are both ssh) on their default ports, since an insteadOf rule between those is how a
// project's clone URL is commonly turned into the one its sandbox can reach. http stays http, and any other scheme
// (file://, git://, ext::, fd::, a local path) is no spelling of a destination.
export function sameDestination(a, b) {
  const one = String(a).trim();
  const two = String(b).trim();
  if (one === two) return true;
  const x = addressOf(one);
  const y = addressOf(two);
  if (!x || !y || x.host !== y.host || x.repo !== y.repo) return false;
  if (x.scheme === y.scheme) return x.port === y.port;
  return x.scheme !== 'http' && y.scheme !== 'http' && x.port === null && y.port === null;
}

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
export function destinationProblem(where, remote, repo, host, env) {
  const dir = typeof where === 'string' ? where : where.top;
  for (const [label, args] of [['fetch', []], ['push', ['--push']]]) {
    const run = typeof where === 'string'
      ? git(['-C', where, 'remote', 'get-url', ...args, '--all', remote], { env })
      : git(['remote', 'get-url', ...args, '--all', remote], { where, env });
    if (run.status !== 0) return { code: 'remote-missing', message: `git remote ${remote} is not set in ${dir}` };
    const urls = run.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    if (urls.length === 0) return { code: 'remote-ambiguous', message: `git remote ${remote} has no ${label} URL` };
    for (const url of urls) {
      const named = parseRemoteUrl(url);
      if (!named) return { code: 'remote-ambiguous', message: `cannot tell which repository the ${label} URL ${scrub(url)} of remote ${remote} names; every URL of the remote must be a plain host and OWNER/REPO URL` };
      if (named.host !== host.toLowerCase() || named.repo.toLowerCase() !== repo.toLowerCase()) {
        return { code: 'remote-mismatch', message: `the ${label} URL ${scrub(url)} of remote ${remote} names ${named.host}/${named.repo}, not ${host}/${repo}; every URL of the remote must name the project's own repository` };
      }
    }
  }
  return null;
}

// Where git runs once `locate` has captured the repository: the git directory and the work tree, named on each call
// that is given them so that the call finds no repository by itself. Without them git discovers a repository from the
// working directory, and a setting such as core.worktree can make the work tree of one repository a directory that
// belongs to another.
const placed = (where) => (where ? ['--git-dir', where.gitDir, '--work-tree', where.top] : []);

// The variables that move git to another repository, change where it finds objects, name the configuration files it
// reads in place of the default ones, or add configuration that no file shows. They are removed from every git call, so
// the checks and the push see the same configuration and none of them can be redirected by what the calling session
// happened to export. The configuration files that git reads by default stay (the files under HOME and XDG_CONFIG_HOME,
// and the system file), and so do the user's own ssh, credential and transport settings that are not on this list:
// GIT_SSH_COMMAND, GIT_SSH, GIT_ASKPASS, SSH_AUTH_SOCK, HOME, XDG_CONFIG_HOME, PATH and the rest. Settings that reach git
// only through a removed variable are not used, unless the user trusted that variable by name at init: a user whose only
// global configuration is a file named by GIT_CONFIG_GLOBAL has that file ignored for these calls, unless init recorded the name.
const DROPPED = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_NAMESPACE', 'GIT_EXEC_PATH']);
const DROPPED_PREFIXES = ['GIT_CONFIG_KEY_', 'GIT_CONFIG_VALUE_'];

// The part of that list that a user can choose to trust: the variables that supply git configuration. The others move git
// to another repository or change where it looks for objects, and nobody can confirm those.
const TRUSTABLE = new Set(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS']);
const trustable = (name) => TRUSTABLE.has(name) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name);

// The trustable variables that an environment has set, with their values. A variable set to the empty string is set.
export function trustableVariables(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => trustable(name)));
}

const isPair = (name) => /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name);

// GIT_CONFIG_COUNT and the KEY_n/VALUE_n pairs it addresses are one unit: git reads the pairs with an index below the
// count and nothing else, and it fails on every call when a pair the count promises is missing. So the user trusts the
// unit, never one pair. These are the pairs that the count in `variables` addresses and that are set: none when the count
// is not set or is not a plain number, and none for a name such as GIT_CONFIG_KEY_00, which git never reads.
export function groupNames(variables) {
  if (!Object.hasOwn(variables, 'GIT_CONFIG_COUNT') || !/^\d{1,9}$/.test(variables.GIT_CONFIG_COUNT)) return [];
  const count = Number(variables.GIT_CONFIG_COUNT);
  return Object.keys(variables).filter((name) => {
    const match = /^GIT_CONFIG_(?:KEY|VALUE)_(0|[1-9]\d*)$/.exec(name);
    return match !== null && Number(match[1]) < count;
  }).sort();
}

// What init asks the user to trust: the trustable variables that are set, except the numbered pairs that the count does
// not address (or that have no count): git ignores those, so they carry nothing to trust.
export function variablesToTrust(env) {
  const group = new Set(groupNames(env));
  return Object.fromEntries(Object.entries(trustableVariables(env)).filter(([name]) => !isPair(name) || group.has(name)));
}

// The names the command keeps from `env`, for a record: every recorded name that is set, and, when the count is recorded,
// the pairs it addresses now, whether or not the record names them. A recorded pair that the count does not address
// is not kept, and neither is a pair when the count is not trusted.
export function keptVariables(record, env) {
  const recorded = Object.keys(hashesOf(record));
  const single = recorded.filter((name) => !isPair(name) && Object.hasOwn(env, name));
  const pairs = recorded.includes('GIT_CONFIG_COUNT') ? groupNames(env) : [];
  return [...new Set([...single, ...pairs])].sort();
}

// An environment that carries the names of the variables the user trusts, so that cleanEnvironment keeps those and
// every git call made with it sees them. The names travel under a symbol, which no process environment can hold, so an
// environment that merely comes from outside cannot claim a variable as trusted, and nothing of it reaches git.
const TRUSTED = Symbol('trusted git variables');
export const withTrusted = (env, names) => ({ ...env, [TRUSTED]: names.filter((name) => trustable(name) && Object.hasOwn(env, name)) });

export function cleanEnvironment(env) {
  const trusted = new Set(env[TRUSTED] ?? []);
  return Object.fromEntries(Object.entries(env).filter(([name]) => trusted.has(name) || (!DROPPED.has(name) && !DROPPED_PREFIXES.some((prefix) => name.startsWith(prefix)))));
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function git(args, { cwd, where, env, stdio } = {}) {
  const run = spawnSync('git', [...placed(where), ...args], { cwd: where ? where.top : cwd, env: cleanEnvironment(env ?? process.env), encoding: 'utf8', timeout: 30000, ...(stdio ? { stdio } : {}) });
  return { status: run.status, stdout: run.stdout ?? '', stderr: (run.stderr ?? '').trim(), error: run.error, signal: run.signal };
}

// Git rewrites a URL given to push by the longest matching url.<base>.insteadOf or url.<base>.pushInsteadOf prefix,
// and the push then goes to the rewritten address. Instead of predicting which rule wins, every rule that applies to the
// address must send it to the same destination (see `sameDestination`: a rule that only adds user information, or
// moves it between https and ssh, is allowed), and any other rule is a refusal. A [remote "<url>"] section is refused
// too: git does not read one for a URL with a slash, but a refusal costs nothing and keeps the check independent of that
// detail. Returns null or a plain message.
export function rewriteProblem(where, url, env) {
  const list = git(['config', '--list', '-z'], { where, env });
  if (list.status !== 0) return `git config could not be read (${list.stderr || list.error?.message || `exit ${list.status}`})`;
  for (const entry of list.stdout.split('\0').filter(Boolean)) {
    const at = entry.indexOf('\n');
    const key = at < 0 ? entry : entry.slice(0, at);
    const value = at < 0 ? '' : entry.slice(at + 1);
    const rewrite = /^url\.(.+)\.(insteadof|pushinsteadof)$/.exec(key);
    if (rewrite && url.startsWith(value)) {
      if (sameDestination(rewrite[1] + url.slice(value.length), url)) continue;
      return scrub(`the git setting ${key} = ${JSON.stringify(value)} would rewrite the recorded destination ${url}`);
    }
    const remote = /^remote\.(.+)\.[^.]+$/.exec(key);
    if (remote && remote[1] === url) return scrub(`the git setting ${key} names the recorded destination as a remote`);
  }
  const shown = git(['ls-remote', '--get-url', url], { where, env });
  if (shown.status !== 0 || !sameDestination(shown.stdout, url)) return scrub(`git reads the recorded destination ${url} as ${shown.stdout.trim() || '(unreadable)'}`);
  return null;
}

// A sandbox often clones with a token in the address of the remote (https://x-access-token:TOKEN@host/OWNER/REPO). The
// record holds that address without it, so the push uses the address the repository itself holds when it is an http or
// https address with user information for the recorded host and OWNER/REPO (`sameDestination`), and the token in the
// user's own configuration keeps working. A remote with push URLs is read through them only, as git does. Returns that
// address, or null when no remote holds one; two different ones leave no way to know which is meant, and are refused.
export function configuredAddress(where, record, env) {
  const list = git(['config', '--list', '-z'], { where, env });
  if (list.status !== 0) refuse('destination-rewritten', `git config could not be read (${list.stderr || list.error?.message || `exit ${list.status}`})`);
  const remotes = new Map();
  for (const entry of list.stdout.split('\0').filter(Boolean)) {
    const at = entry.indexOf('\n');
    const named = /^remote\.(.+)\.(url|pushurl)$/.exec(at < 0 ? entry : entry.slice(0, at));
    if (!named) continue;
    const slot = remotes.get(named[1]) ?? { url: [], pushurl: [] };
    slot[named[2]].push(at < 0 ? '' : entry.slice(at + 1));
    remotes.set(named[1], slot);
  }
  const held = new Map();
  for (const [name, slot] of remotes) {
    for (const value of slot.pushurl.length ? slot.pushurl : slot.url) {
      if (/^https?:\/\/[^/]*@/i.test(value) && sameDestination(value, record.url)) held.set(value, [...(held.get(value) ?? []), name]);
    }
  }
  if (held.size > 1) refuse('remote-ambiguous', `the remotes ${[...held.values()].flat().join(', ')} hold different addresses with user information for ${record.host}/${record.repo}; keep one of them, so that the command knows which address to push to`);
  return [...held.keys()][0] ?? null;
}

// What must not appear in an output of the command when a push used an address with user information: that part of the
// address, its user name and password and their percent-decoded forms, and the base64 of the pair that an
// Authorization header carries. Shorter than four characters is no token, and replacing it would only garble the text.
export function secretsOf(url) {
  const info = /^https?:\/\/([^/?#@]+)@/i.exec(String(url))?.[1];
  const decode = (text) => { try { return decodeURIComponent(text); } catch { return text; } };
  if (!info || decode(info).length < 4) return [];
  const [user, ...rest] = info.split(':');
  const found = new Set([info, decode(info), Buffer.from(decode(info)).toString('base64'), user, decode(user), rest.join(':'), decode(rest.join(':'))]);
  return [...found].filter((text) => text.length >= 4).sort((a, b) => b.length - a.length);
}

// A value of the answer, with the secrets and any user information in an http or https address taken out of every string.
export function hide(value, secrets) {
  if (typeof value === 'string') return secrets.reduce((text, secret) => text.split(secret).join('***'), scrub(value));
  if (Array.isArray(value)) return value.map((item) => hide(item, secrets));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hide(item, secrets)]));
  return value;
}

// ---- the record written at init -----------------------------------------------------------------------------

// The record is the destination the owner confirmed: the URL itself, its host and OWNER/REPO, the namespaces the run
// pushes under, the project root, and the shared git directory of that repository. It also holds the names of the git
// configuration variables the owner chose to trust (`variables`, name to value at that moment) as `trustedGitVariables`:
// each name with a hash of its value then, in name order, and nothing when none is trusted. The names are the trust:
// the push command keeps each trusted name with whatever value it has when it runs. The hash is information only, it lets
// the receipt say that a value changed since init, and it is never a reason to refuse. No value is written down, because
// a variable can carry a credential.
export function destinationRecord({ projectRoot, commonDir, url, host, repo, prefixes, variables = {} }) {
  const names = Object.keys(variables).sort();
  for (const name of names) if (!trustable(name)) throw new Error(`${name} cannot be trusted`);
  const group = new Set(groupNames(variables));
  for (const name of names) if (isPair(name) && !group.has(name)) throw new Error(`${name} cannot be trusted alone: only the pairs that a GIT_CONFIG_COUNT in the same set addresses are trusted, with the count`);
  return {
    schema: RECORD_SCHEMA, schemaVersion: 1, projectRoot, commonDir, url: stripCredential(url), host, repo, prefixes: [...prefixes],
    ...(names.length ? { trustedGitVariables: Object.fromEntries(names.map((name) => [name, sha256(variables[name])])) } : {}),
  };
}

const hashesOf = (record) => {
  const found = record?.trustedGitVariables;
  return found !== null && typeof found === 'object' && !Array.isArray(found) ? found : {};
};

// The names of the trusted git variables that one record has and the other does not. A value that changed is not a
// difference, and neither are the numbered pairs: they belong to the count, which is what the user trusts.
export function differingVariables(a, b) {
  const left = hashesOf(a);
  const right = hashesOf(b);
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].filter((name) => !isPair(name) && Object.hasOwn(left, name) !== Object.hasOwn(right, name)).sort();
}

// What a push reports about the git variables, without any value or hash: for each trusted name whether its value is the
// one that was confirmed (`same`), another value (`changed`), not set, or kept only because the trusted count addresses
// it now (`added`); and the names that are set and not kept, which the push dropped.
export function variableReport(record, env) {
  const hashes = hashesOf(record);
  const kept = keptVariables(record, env);
  const trusted = {};
  for (const name of [...new Set([...Object.keys(hashes), ...kept])].sort()) {
    if (!Object.hasOwn(env, name)) trusted[name] = 'not-set';
    else if (kept.includes(name)) trusted[name] = !Object.hasOwn(hashes, name) ? 'added' : sha256(env[name]) === hashes[name] ? 'same' : 'changed';
  }
  const dropped = Object.keys(trustableVariables(env)).filter((name) => !kept.includes(name)).sort();
  return { trusted, dropped };
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
  if (embedsCredential(record.url)) return 'has a URL with user information in an http or https address, which can be a token';
  if (!/^[A-Za-z0-9.-]+$/.test(String(record.host))) return 'has no usable host';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/.test(String(record.repo))) return 'has no usable OWNER/REPO';
  if (!Array.isArray(record.prefixes) || record.prefixes.length === 0) return 'names no branch namespace';
  if ('trustedGitVariables' in record) {
    const hashes = record.trustedGitVariables;
    if (hashes === null || typeof hashes !== 'object' || Array.isArray(hashes)) return 'has a trustedGitVariables that is not a map from variable names to hashes';
    for (const [name, hash] of Object.entries(hashes)) {
      if (!trustable(name)) return `has a trustedGitVariables entry for ${JSON.stringify(name)}, a variable that cannot be trusted`;
      if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return `has no SHA-256 hash for ${name} in trustedGitVariables`;
    }
    const pair = Object.keys(hashes).find(isPair);
    if (pair && !Object.hasOwn(hashes, 'GIT_CONFIG_COUNT')) return `has ${pair} in trustedGitVariables without GIT_CONFIG_COUNT, which addresses the numbered pairs`;
  }
  for (const prefix of record.prefixes) { const bad = checkPrefixShape(prefix); if (bad) return `has the branch namespace ${JSON.stringify(prefix)}, which ${bad}`; }
  // The URL must still be the repository the record names, spelled as git reads it.
  const named = parseRemoteUrl(record.url);
  if (!named || named.host !== record.host.toLowerCase() || named.repo.toLowerCase() !== record.repo.toLowerCase()) return 'names a URL that is not the recorded host and OWNER/REPO';
  return null;
}

// ---- checks before a push -----------------------------------------------------------------------------------

class Refuse extends Error {
  constructor(code, message, details = {}) { super(scrub(message)); this.code = code; this.details = details; }
}
const refuse = (code, message, details) => { throw new Refuse(code, message, details); };

// What init records for a project: the push URL of the project's remote once git has rewritten it, with the repository
// it names, and where the project lives. Returns {record, commonDir} or {problem: {code, message}}; it never throws, so
// the permission check can report a refusal in its own words. The URL must name the agreed host and repository
// (every fetch and push URL of the remote is checked) and no rewrite rule may send it anywhere but to itself, because the
// push command refuses a destination that a rule would redirect. User information in an http address is stripped first. The git configuration variables that are set in `env` are the ones
// the record will ask the user to trust (`variables`: the set that init offers, with the values for the hashes; the preview
// shows only names and lengths), so these checks run with them,
// as the push will.
export function initDestination(root, remote, repo, host, prefixes, env = process.env) {
  const variables = variablesToTrust(env);
  const gitEnv = withTrusted(env, Object.keys(variables));
  let found;
  try { found = locate(root, gitEnv); } catch (error) {
    if (error instanceof Refuse) return { problem: { code: error.code, message: error.message } };
    throw error;
  }
  const problem = destinationProblem(found, remote, repo, host, gitEnv);
  if (problem) return { problem };
  const urls = git(['remote', 'get-url', '--push', '--all', remote], { where: found, env: gitEnv }).stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  if (urls.length === 0) return { problem: { code: 'remote-ambiguous', message: `git remote ${remote} has no push URL` } };
  const address = stripCredential(urls[0]);
  const rewritten = rewriteProblem(found, address, gitEnv);
  if (rewritten) return { problem: { code: 'destination-rewritten', message: rewritten } };
  return { record: destinationRecord({ projectRoot: root, commonDir: found.commonDir, url: address, host: host.toLowerCase(), repo, prefixes, variables }), commonDir: found.commonDir, where: found, variables };
}

// Where the command runs, captured once: the git directory of this work tree (a linked worktree has its own), the shared
// git directory, and the top of the work tree, all with links resolved. One git process answers all three, so the answers
// describe one repository. Every later git call names the git directory and the work tree (see `placed`) instead of
// finding them again from a directory.
//
// The top of the work tree is whatever core.worktree says when it is set, and it can be a directory of another
// repository. So the answer is accepted only if it makes a round trip: git started in the top must use the same git
// directory and the same shared git directory. A repository whose git directory is kept apart from its work tree and
// a linked worktree pass; a repository pointed at another one's files does not.
export function locate(cwd, env) {
  const shown = git(['rev-parse', '--absolute-git-dir', '--git-common-dir', '--show-toplevel'], { cwd, env });
  const lines = shown.stdout.split('\n');
  if (shown.status !== 0) refuse('not-a-repository', `${cwd} is not inside a git work tree`);
  if (lines.length !== 4 || lines[3] !== '') refuse('not-a-repository', `git gave an answer about ${cwd} that cannot be read as a git directory, a shared git directory and a work tree`);
  const real = (base, text) => fs.realpathSync.native(path.resolve(base, text));
  let found;
  try { found = { gitDir: real(cwd, lines[0]), commonDir: real(fs.realpathSync.native(cwd), lines[1]), top: real(cwd, lines[2]) }; } catch (error) {
    refuse('not-a-repository', `a directory that git named for ${cwd} cannot be read (${error.message})`);
  }
  const back = git(['rev-parse', '--absolute-git-dir', '--git-common-dir'], { cwd: found.top, env });
  const [backDir, backCommon] = back.stdout.split('\n');
  let sameRepository = false;
  try { sameRepository = back.status === 0 && real(found.top, backDir) === found.gitDir && real(found.top, backCommon) === found.commonDir; } catch { /* a directory is missing: not the same */ }
  if (!sameRepository) {
    refuse('worktree-mismatch', `the work tree of the repository at ${found.gitDir} is ${found.top}, but git started in ${found.top} does not use that repository; a setting such as core.worktree points this repository at the files of another one. Nothing was pushed`);
  }
  return found;
}

// A read-only git call placed in an identified repository, with the cleaned environment, for the permissions helper,
// which asks about the repository that `initDestination` identified.
export const runGit = (where, args, env) => git(args, { where, env });

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

// Where the record of this repository is, found from the files alone, before any git call. The record names the git
// variables the user trusts, and git may need one of them to answer at all (safe.directory in a sandbox), so git cannot
// be the one to find it. From the working directory it goes up to the first `.git` entry, as git does: a folder is the git
// directory, a file names it (`gitdir:`), and a `commondir` file inside that names the shared git directory. It is a
// hint and only a hint: `run` refuses unless git, started with the trusted variables, reports this very shared directory.
export function recordHint(cwd) {
  const none = () => refuse('not-a-repository', `${cwd} is not inside a git work tree`);
  let dir;
  try { dir = fs.realpathSync.native(cwd); } catch { none(); }
  for (;;) {
    const entry = path.join(dir, '.git');
    if (fs.existsSync(entry)) {
      try {
        let gitDir = entry;
        if (!fs.statSync(entry).isDirectory()) {
          const named = /^gitdir: (.+)$/m.exec(fs.readFileSync(entry, 'utf8'));
          if (!named) none();
          gitDir = path.resolve(dir, named[1].trim());
        }
        const link = path.join(gitDir, 'commondir');
        return fs.realpathSync.native(fs.existsSync(link) ? path.resolve(gitDir, fs.readFileSync(link, 'utf8').trim()) : gitDir);
      } catch (error) {
        if (error instanceof Refuse) throw error;
        none();
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) none();
    dir = parent;
  }
}

// The repository the command runs in must be the one the destination was recorded for. The comparison is the shared git
// directory, because a worker works in a linked worktree whose top directory is not the project root. The recorded
// project root must also still be a checkout of this same repository. That second check lets git discover a repository
// from a directory, as `locate` does: the recorded root is another directory, so there is no captured git directory for
// it. Only its shared git directory is read and compared, and nothing is run or pushed there.
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
  const at = { where: found, env };
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
  // What a push that used an address with a token must keep out of every string it answers, logs or writes to stderr.
  let secrets = [];
  try {
    if (argv.length !== 2 || argv[0] !== '--branch' || !argv[1] || argv[1].startsWith('-')) refuse('usage', `${USAGE}; no other argument is accepted`);
    const branch = argv[1];
    // The record says which git variables the user trusts, so it is read before git is run (see `recordHint`). Every git call
    // after that, the first one included, runs with the same set: the trusted names that are set, with the values they
    // have now, and no other name of the list. A trusted name that is not set is simply not there.
    const hinted = recordHint(cwd);
    const record = readRecord(hinted);
    const report = variableReport(record, env);
    const gitEnv = withTrusted(env, keptVariables(record, env));
    let found;
    try { found = locate(cwd, gitEnv); } catch (error) {
      if (error instanceof Refuse && error.code === 'not-a-repository' && report.dropped.length) {
        refuse(error.code, `${error.message}. These git variables are set and are not trusted, so this check ran without them: ${report.dropped.join(', ')}. If git needs one of them, run the destination step of /fvs:auto-init again and trust it`);
      }
      throw error;
    }
    if (found.commonDir !== hinted) refuse('wrong-repository', `the record was read from ${hinted}, but git finds the shared git directory ${found.commonDir}; nothing was pushed`);
    const wrongPlace = repositoryProblem(record, found, gitEnv);
    if (wrongPlace) refuse('wrong-repository', wrongPlace);
    const wrongBranch = branchProblem(found, branch, record.prefixes, gitEnv);
    if (wrongBranch) refuse('branch-refused', wrongBranch);
    const rewritten = rewriteProblem(found, record.url, gitEnv);
    if (rewritten) refuse('destination-rewritten', `${rewritten}; the push was not made`);
    // The address the push is given: the recorded one, or the address with user information that a remote of this
    // repository holds for the same destination. That one is checked for rewriting as well, and from here on every
    // string that leaves the command is cleaned of what it holds.
    const held = configuredAddress(found, record, gitEnv);
    const address = held ?? record.url;
    if (held) {
      secrets = secretsOf(held);
      const heldRewritten = rewriteProblem(found, held, gitEnv);
      if (heldRewritten) refuse('destination-rewritten', `${heldRewritten}; the push was not made`);
    }
    const read = git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], { where: found, env: gitEnv });
    const tip = read.stdout.trim();
    if (read.status !== 0 || !/^[0-9a-f]{40,64}$/.test(tip)) refuse('branch-refused', `the tip of refs/heads/${branch} could not be read as a commit (${read.stderr || read.error?.message || `exit ${read.status}`}), so nothing was pushed`);
    const refspec = `refs/heads/${branch}:refs/heads/${branch}`;
    // -c push.pushOption= empties the list of push options from every configuration file and the environment: options
    // go to the receiving side, which can act on them, and this command sends none.
    // --no-verify skips the pre-push hook, including one that is set in git configuration with hook.<name>.event, which
    // core.hooksPath does not turn off. -c core.hooksPath=/dev/null makes git find no hook in any hooks folder, whether it
    // is the default one or named by core.hooksPath in any configuration file. Each is kept for what the other does not do.
    const pushed = git(['-c', 'push.followTags=false', '-c', 'push.pushOption=', '-c', 'core.hooksPath=/dev/null', '-c', 'core.abbrev=no', 'push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no', '--no-verify', address, refspec],
      { where: found, env: gitEnv, stdio: ['inherit', 'pipe', 'pipe'] });
    // What git says on its error output is passed on, cleaned: a rejected token can come back in it.
    if (pushed.stderr) process.stderr.write(`${hide(pushed.stderr, secrets)}\n`);
    const seen = parsePorcelain(pushed.stdout, branch);
    const status = STATUS[seen.flag] ?? null;
    const accepted = pushed.status === 0 && (status === 'created' || status === 'fast-forward' || status === 'up-to-date');
    // Git named this ref and said it was not updated: a known failure. Anything else without a success line (a timeout, a
    // lost connection, a signal, no line for the ref) leaves the outcome open: the destination may have taken the update.
    const result = accepted ? status : seen.flag === '!' ? 'failed' : 'unknown';
    const entry = {
      at: now().toISOString(), branch, destination: record.url, usedConfiguredAddress: held !== null, repositoryRoot: found.top, commonDir: found.commonDir, gitVariables: report,
      result, porcelainFlag: seen.flag, porcelain: seen.line, to: seen.to,
      // Only ids that the push itself reported. A new branch and an up-to-date branch carry none in git's summary, and the
      // tip read before the push is not an id of what was sent: the branch can move between the read and the push.
      oldRemoteId: seen.old, newRemoteId: accepted ? seen.new : null, localTipBeforePush: tip,
      exitStatus: pushed.status, signal: pushed.signal ?? null, error: pushed.error?.message ?? null,
    };
    const log = appendLog(record, hide(entry, secrets));
    const detail = { ...hide(entry, secrets), ...log };
    if (result === 'failed') refuse('push-failed', `git did not update ${branch} on the destination: ${seen.line.replace(/\t/g, ' ')}`, detail);
    if (result === 'unknown') {
      const how = pushed.error?.code === 'ETIMEDOUT' ? 'did not finish within 30 seconds' : pushed.signal ? `was stopped by ${pushed.signal}` : `ended with exit ${pushed.status}${seen.line ? ` and the line "${seen.line.replace(/\t/g, ' ')}"` : ' and no result line for the branch'}`;
      refuse('push-outcome-unknown', `git ${how}, so this command does not know whether ${branch} was updated on the destination. It may have been. Read the destination before you retry (for example with git ls-remote on the recorded address), and report this code and message`, detail);
    }
    // git prints the address it pushed to as it reads it after any rewrite rule, and without user information.
    if (seen.to !== null && seen.to !== anonymizeUrl(record.url) && !sameDestination(seen.to, record.url)) refuse('unexpected-destination', `the push ran, but git reported ${seen.to} instead of the recorded ${record.url}; tell the owner`, detail);
    return { status: 0, json: { code: 'pushed', ...detail } };
  } catch (error) {
    if (!(error instanceof Refuse)) throw error;
    return { status: error.code === 'usage' ? 2 : 1, json: hide({ code: error.code, message: error.message, ...error.details }, secrets) };
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
