#!/usr/bin/env node
// Push gate for the auto track: a PreToolUse hook for Claude Code's Bash tool that answers every `git push`.
//
//   allow  a plain push of one branch under the run's namespace to the project's own fork:
//            git push [-u] <remote> <prefix>/<name>          (also after one `git -C <plain path>`)
//            git push                                        (only when HEAD is <prefix>/<name> and the checks below hold)
//   ask    every other command that contains a push: force flags, --delete, --tags, --mirror, --all, refspecs, other
//          remotes, other branch names, several refspecs, chains, pipes, redirects, several lines, odd -C arguments.
//   (none) a command that is not a push: no output, exit 0.
//
// Before it allows anything it reads every URL git would push to (all push URLs of the remote, or all its URLs when
// it has no push URL, after git's own URL rewriting) and requires each to name the agreed host and OWNER/REPO. Any
// mismatch, URL it cannot read, or git error means "ask". A rule file cannot do this: a `*` in a rule also matches the
// rest of the command, so no rule can say "this branch and nothing else". A command is judged by its text, so only
// the exact forms above are allowed; a push written any other way is either asked or not recognised as a push, and
// then the session's normal permission flow decides, as it would without this hook.
//
// The agreed destination comes on the command line, because a worker's worktree has no run folder:
//   --repo OWNER/REPO  --host github.com  --remote origin  --prefix fvs [--prefix ...]
// It reads the hook JSON on standard input and never pushes, fetches or writes anything.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---- the agreed destination ---------------------------------------------------------------------------------

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

// ---- recognising a push -------------------------------------------------------------------------------------

// git options that sit between `git` and the subcommand. -C and -c (and the long options below) take the next word.
const OPTIONS_WITH_WORD = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix']);
const WORD = /"[^"]*"|'[^']*'|\S+/y;
const SPACE = /\s+/y;

// A `push` word anywhere in what follows, as the shell would split it. Used only after a -C (or similar) argument
// that this scan cannot read, such as `$(...)` or a backslash-escaped space, which hides where the subcommand starts.
// An ordinary argument is read exactly, so `git -C dir commit -m "push the thing"` is not a push.
const LATER_PUSH = /(^|[\s;&|("'])push(?=[\s;&|)<>"']|$)/;
const UNREADABLE_ARGUMENT = /[\\$`()"']/;

// True when the text holds `git [global options] push` anywhere, however the command is chained. It scans the words
// after each `git` once (no backtracking), so a long run of options cannot make it slow. It over-recognises on
// purpose: a commit message that contains `git push` is "a push" here and asks, and so does a `push` word after a
// -C argument it cannot read.
export function containsPush(text) {
  if (/(^|[^A-Za-z0-9_-])git-push(?![A-Za-z0-9_-])/m.test(text)) return true;
  const git = /(^|[^A-Za-z0-9_-])git['"]?(?=\s)/gm;
  for (let found = git.exec(text); found; found = git.exec(text)) {
    let at = found.index + found[0].length;
    let hiddenSubcommand = false;
    for (;;) {
      SPACE.lastIndex = at;
      if (!SPACE.test(text)) break;
      at = SPACE.lastIndex;
      WORD.lastIndex = at;
      const word = WORD.exec(text);
      if (!word) break;
      at = WORD.lastIndex;
      const token = word[0];
      if (/^push(?:[;&|<>()]|$)/.test(token)) return true;
      if (OPTIONS_WITH_WORD.has(token)) {
        SPACE.lastIndex = at;
        if (!SPACE.test(text)) break;
        at = SPACE.lastIndex;
        WORD.lastIndex = at;
        const argument = WORD.exec(text);
        if (!argument) break;
        at = WORD.lastIndex;
        if (UNREADABLE_ARGUMENT.test(argument[0])) hiddenSubcommand = true;
      } else if (!/^(?:--[A-Za-z][A-Za-z-]*(?:=.*)?|-[A-Za-z])$/.test(token)) {
        if (hiddenSubcommand && LATER_PUSH.test(text.slice(at))) return true;
        break;
      }
    }
  }
  return false;
}

// ---- the exact forms ----------------------------------------------------------------------------------------

// Nothing in an allowed command may be a character the shell treats specially: no quote, `$`, backtick, `;`, `&`, `|`,
// `<`, `>`, `(`, `)`, `*`, `?`, `[`, `{`, `!`, `#`, `~`, backslash, or newline. `:` and `+` are allowed here only so the
// words below can be told apart; a refspec fails the branch check.
const PLAIN_COMMAND = /^[A-Za-z0-9_./+@%:=, \t-]*$/;
const PLAIN_PATH = /^[A-Za-z0-9_./+@%:=,][A-Za-z0-9_./+@%:=,-]*$/;

// <prefix>/<name>, with every part a plain word: no "..", no part that starts with a dot or ends in ".lock" or ".".
function branchOk(ref, prefixes) {
  return prefixes.some((prefix) => {
    if (!ref.startsWith(`${prefix}/`)) return false;
    const parts = ref.slice(prefix.length + 1).split('/');
    return parts.every((part) => /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(part) && !part.endsWith('.lock') && !part.endsWith('.') && !part.includes('..'));
  });
}

function gitRun(dir, args) {
  return spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 10000 });
}
// A single-line answer, or null on any git error.
function gitOut(dir, args) {
  const run = gitRun(dir, args);
  return run.status === 0 ? run.stdout.trim() : null;
}
// Config values, '' when the key is unset (git exits 1), null on any other error.
function gitConfig(dir, ...args) {
  const run = gitRun(dir, ['config', ...args]);
  if (run.status === 0) return run.stdout.trim();
  return run.status === 1 ? '' : null;
}

// Settings that make a plain push send more than the one branch: tags, a mirror, or submodule commits.
function sendsMore(dir, remote) {
  const followTags = gitConfig(dir, '--bool', '--get', 'push.followTags');
  const mirror = gitConfig(dir, '--bool', '--get', `remote.${remote}.mirror`);
  const submodules = gitConfig(dir, '--get', 'push.recurseSubmodules');
  // With push.recurseSubmodules unset, git's push follows submodule.recurse as "on-demand".
  const recurse = gitConfig(dir, '--bool', '--get', 'submodule.recurse');
  if (followTags === null || mirror === null || submodules === null || recurse === null) return 'a push setting could not be read';
  if (followTags === 'true') return 'push.followTags is set, so tags would be pushed too';
  if (mirror === 'true') return `remote.${remote}.mirror is set`;
  if (!['', 'no', 'check'].includes(submodules)) return 'push.recurseSubmodules would push submodule commits too';
  if (recurse === 'true') return 'submodule.recurse is set, so submodule commits would be pushed too';
  return null;
}

// A bare `git push` goes where git's own settings say, so each of them must say: this branch, to the same name, on the remote.
function bareProblem(dir, remote, prefixes) {
  const branch = gitOut(dir, ['symbolic-ref', '-q', '--short', 'HEAD']);
  if (!branch || !branchOk(branch, prefixes)) return `HEAD is not a branch under ${prefixes.map((p) => `${p}/`).join(' or ')}`;
  const tracking = `refs/remotes/${remote}/${branch}`;
  if (gitOut(dir, ['rev-parse', '--symbolic-full-name', '@{upstream}']) !== tracking) return `the upstream of ${branch} is not ${remote}/${branch}`;
  if (gitOut(dir, ['rev-parse', '--symbolic-full-name', '@{push}']) !== tracking) return `a bare push of ${branch} would not go to ${remote}/${branch}`;
  const pushDefault = gitConfig(dir, '--get', 'push.default');
  if (pushDefault === null || !['', 'simple', 'current', 'upstream', 'tracking'].includes(pushDefault)) return 'push.default is not one of simple, current or upstream';
  const pushRefspecs = gitConfig(dir, '--get-all', `remote.${remote}.push`);
  if (pushRefspecs !== '') return `remote.${remote}.push is set${pushRefspecs === null ? ' (unreadable)' : ''}`;
  return null;
}

const ask = (reason) => ({ decision: 'ask', reason: `FVS push gate: ${reason}` });
const allow = (reason) => ({ decision: 'allow', reason: `FVS push gate: ${reason}` });

// The decision for one Bash command, or null when it is not a push. `config` is {repo, host, remote, prefixes}.
export function decide({ command, cwd }, config) {
  if (typeof command !== 'string' || !containsPush(command)) return null;
  if (config.problem) return ask(config.problem);
  const { repo, host, remote, prefixes } = config;
  if (/[\n\r]/.test(command)) return ask('a push in a command with several lines');
  if (!PLAIN_COMMAND.test(command)) return ask('a push with a quote, variable, chain, pipe, redirect or other shell syntax');
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !fs.existsSync(cwd)) return ask('the working directory is not known');
  const words = command.trim().split(/[ \t]+/);
  let at = 0;
  if (words[at++] !== 'git') return ask('not one of the exact forms the gate allows');
  let dir = cwd;
  const usedC = words[at] === '-C';
  if (usedC) {
    const given = words[at + 1];
    if (!given || !PLAIN_PATH.test(given)) return ask('the -C path is not a plain path');
    dir = path.resolve(cwd, given);
    at += 2;
    if (!fs.existsSync(dir)) return ask(`the -C path ${given} does not exist`);
  }
  if (words[at++] !== 'push') return ask('not one of the exact forms the gate allows');
  const bare = at === words.length;
  let what;
  if (bare) {
    if (usedC) return ask('a bare push after -C is not allowed');
    const problem = bareProblem(dir, remote, prefixes);
    if (problem) return ask(`a bare push is allowed only on a branch of your own that tracks the same name on ${remote}: ${problem}`);
    what = `a bare push of ${gitOut(dir, ['symbolic-ref', '--short', 'HEAD'])} to ${remote}`;
  } else {
    if (words[at] === '-u') at += 1;
    if (words[at++] !== remote) return ask(`only ${remote}, the project fork, is allowed`);
    const ref = words[at++];
    if (!ref || at !== words.length || !branchOk(ref, prefixes)) return ask(`only one branch under ${prefixes.map((p) => `${p}/`).join(' or ')}, named plainly, is allowed`);
    what = `a push of ${ref} to ${remote}`;
  }
  const extra = sendsMore(dir, remote);
  if (extra) return ask(extra);
  const problem = destinationProblem(dir, remote, repo, host);
  if (problem) return ask(`${problem.message}`);
  return allow(`${what} (${host}/${repo})`);
}

// ---- command line -------------------------------------------------------------------------------------------

export function parseConfig(argv) {
  const config = { repo: null, host: 'github.com', remote: 'origin', prefixes: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (value === undefined) return { ...config, problem: `${argv[i]} needs a value` };
    if (argv[i] === '--repo') config.repo = value;
    else if (argv[i] === '--host') config.host = value;
    else if (argv[i] === '--remote') config.remote = value;
    else if (argv[i] === '--prefix') config.prefixes.push(value);
    else return { ...config, problem: `unknown argument ${argv[i]}` };
  }
  const plain = (text) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/.test(config.repo ?? '') || !/^[A-Za-z0-9.-]+$/.test(config.host) || !plain(config.remote) || config.prefixes.length === 0 ||
    !config.prefixes.every((prefix) => prefix.split('/').every(plain))) {
    return { ...config, problem: 'the gate is not configured: it needs --repo OWNER/REPO and at least one --prefix; run /fvs:auto-init again' };
  }
  return config;
}

const output = (answer) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: answer.decision, permissionDecisionReason: answer.reason } });

// Any failure after a push is seen answers "ask": a hook that crashes or exits non-zero does not block the command.
export function main(argv, stdin) {
  let input;
  try { input = JSON.parse(stdin); } catch { return null; }
  if (input?.tool_name !== undefined && input.tool_name !== 'Bash') return null;
  const command = input?.tool_input?.command;
  try {
    const answer = decide({ command, cwd: input?.cwd }, parseConfig(argv));
    return answer ? output(answer) : null;
  } catch (error) {
    return typeof command === 'string' && /push/.test(command) ? output(ask(`the gate failed (${error.message}), so this push asks`)) : null;
  }
}

// Run only as a program, never when a test imports the functions above.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  let stdin = '';
  try { stdin = fs.readFileSync(0, 'utf8'); } catch { /* no input: nothing to gate */ }
  const answer = main(process.argv.slice(2), stdin);
  if (answer) process.stdout.write(answer + '\n');
}
