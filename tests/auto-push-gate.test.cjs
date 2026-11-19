'use strict';

// The push gate allows only the exact forms of a plain push of one branch under the run's namespace to the project's
// own fork, and asks for every other command that contains a push. A wrong "allow" skips a prompt the owner wants, so
// the table is mostly "ask" rows: every force flag, delete, tag push, mirror, refspec, other remote and branch,
// chain, pipe, redirect, odd -C argument and unsafe bare-push setup. Nothing here pushes: the gate only reads git
// configuration, and the repositories below are throwaway directories whose remote URLs are never contacted.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const GATE = path.join(ROOT, 'scripts', 'fvs-auto-push-gate.mjs');

// Keep the owner's own git configuration (URL rewriting, push settings) out of every result.
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-gate-'));
process.env.HOME = BASE;
process.env.XDG_CONFIG_HOME = path.join(BASE, 'xdg');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_SYSTEM = '/dev/null';

const REPO = 'Acme/proj';
const MINE = 'git@github.com:Acme/proj.git';
const UPSTREAM = 'git@github.com:Upstream/proj.git';
const CONFIG = { repo: REPO, host: 'github.com', remote: 'origin', prefixes: ['fvs'] };

let lib;
const repos = {};

function git(dir, ...args) {
  const run = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout;
}

// A repository on branch `branch` whose remote-tracking branch is faked with update-ref, so no network is involved.
function makeRepo(name, { branch = 'fvs/foo', track = branch, url = MINE, detach = false, setup } = {}) {
  const dir = path.join(BASE, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q');
  git(dir, 'remote', 'add', 'origin', url);
  git(dir, '-c', 'user.email=a@b', '-c', 'user.name=n', 'commit', '-q', '--allow-empty', '-m', 'x');
  git(dir, 'checkout', '-q', '-B', branch);
  if (track) {
    git(dir, 'update-ref', `refs/remotes/origin/${track}`, 'HEAD');
    git(dir, 'config', `branch.${branch}.remote`, 'origin');
    git(dir, 'config', `branch.${branch}.merge`, `refs/heads/${track}`);
  }
  if (detach) git(dir, 'checkout', '-q', '--detach');
  if (setup) setup(dir);
  repos[name] = dir;
  return dir;
}
const config = (dir, ...args) => git(dir, 'config', ...args);
const addUpstreamRemote = (dir) => {
  git(dir, 'remote', 'add', 'upstream', UPSTREAM);
  git(dir, 'update-ref', 'refs/remotes/upstream/fvs/foo', 'HEAD');
};

before(async () => {
  lib = await import(pathToFileURL(GATE).href);
  makeRepo('ok');
  fs.mkdirSync(path.join(repos.ok, 'sub'));
  repos.sub = path.join(repos.ok, 'sub');
  // Settings that make a bare push go somewhere other than the same name on origin, or send more than one branch.
  makeRepo('current', { setup: (d) => config(d, 'push.default', 'current') });
  makeRepo('upstreamdefault', { setup: (d) => config(d, 'push.default', 'upstream') });
  makeRepo('simple', { setup: (d) => config(d, 'push.default', 'simple') });
  makeRepo('othername', { track: 'fvs/other' });
  makeRepo('main', { branch: 'main', track: 'main' });
  makeRepo('aobranch', { branch: 'ao/foo', track: 'ao/foo' });
  makeRepo('noupstream', { track: null });
  makeRepo('detached', { detach: true });
  makeRepo('matching', { setup: (d) => config(d, 'push.default', 'matching') });
  makeRepo('nothing', { setup: (d) => config(d, 'push.default', 'nothing') });
  makeRepo('upstreamremote', { setup: (d) => { addUpstreamRemote(d); config(d, 'branch.fvs/foo.remote', 'upstream'); } });
  makeRepo('pushremote', { setup: (d) => { addUpstreamRemote(d); config(d, 'branch.fvs/foo.pushRemote', 'upstream'); } });
  makeRepo('pushdefault', { setup: (d) => { addUpstreamRemote(d); config(d, 'remote.pushDefault', 'upstream'); } });
  makeRepo('followtags', { setup: (d) => config(d, 'push.followTags', 'true') });
  makeRepo('originpush', { setup: (d) => config(d, 'remote.origin.push', 'refs/heads/*:refs/heads/*') });
  makeRepo('mirror', { setup: (d) => config(d, 'remote.origin.mirror', 'true') });
  makeRepo('recurse', { setup: (d) => config(d, 'push.recurseSubmodules', 'on-demand') });
  makeRepo('recursecheck', { setup: (d) => config(d, 'push.recurseSubmodules', 'check') });
  fs.mkdirSync(path.join(BASE, 'notarepo'));
  repos.notarepo = path.join(BASE, 'notarepo');
  // The destination: every URL git would push to must name Acme/proj on github.com.
  makeRepo('twopush', { setup: (d) => { config(d, '--add', 'remote.origin.pushurl', MINE); config(d, '--add', 'remote.origin.pushurl', UPSTREAM); } });
  makeRepo('twopushgood', { setup: (d) => { config(d, '--add', 'remote.origin.pushurl', MINE); config(d, '--add', 'remote.origin.pushurl', 'https://github.com/acme/PROJ.git'); } });
  makeRepo('fallbackbad', { setup: (d) => config(d, '--add', 'remote.origin.url', UPSTREAM) });
  makeRepo('fallbackfirstbad', { url: UPSTREAM, setup: (d) => config(d, '--add', 'remote.origin.url', MINE) });
  makeRepo('fallbackgood', { setup: (d) => { config(d, '--add', 'remote.origin.url', 'https://github.com/Acme/proj'); config(d, '--add', 'remote.origin.url', 'ssh://git@github.com:22/Acme/proj.git'); } });
  makeRepo('fetchbad', { url: UPSTREAM, setup: (d) => config(d, '--add', 'remote.origin.pushurl', MINE) });
  makeRepo('otherhost', { url: 'git@gitlab.com:Acme/proj.git' });
  makeRepo('lookalikehost', { url: 'ssh://git@github.com.evil.test/Acme/proj.git' });
  makeRepo('localpath', { url: '/srv/git/proj.git' });
  makeRepo('fileurl', { url: 'file:///srv/git/Acme/proj' });
  makeRepo('deeppath', { url: 'git@github.com:Acme/sub/proj.git' });
  makeRepo('insteadof', { setup: (d) => config(d, 'url.git@github.com:Upstream/.insteadOf', 'git@github.com:Acme/') });
  makeRepo('pushinsteadof', { setup: (d) => config(d, 'url.git@github.com:Upstream/.pushInsteadOf', 'git@github.com:Acme/') });
  makeRepo('https', { url: 'https://github.com/Acme/proj' });
  makeRepo('othercase', { url: 'https://github.com/ACME/Proj.git' });
  makeRepo('noremote', { setup: (d) => git(d, 'remote', 'remove', 'origin') });
  // URLs that a naive reading takes for Acme/proj on github.com while git contacts another host.
  makeRepo('scpuser', { url: 'evil.test:x@github.com:Acme/proj' });
  makeRepo('backslashurl', { url: 'https://evil.test\\@github.com/Acme/proj' });
  // git remote add refuses a URL that starts with a dash, but a config file can still hold one.
  makeRepo('optionlike', { setup: (d) => config(d, 'remote.origin.url', '-oProxyCommand=x@github.com:Acme/proj') });
  makeRepo('submodulerecurse', { setup: (d) => config(d, 'submodule.recurse', 'true') });
});
after(() => { fs.rmSync(BASE, { recursive: true, force: true }); });

const argvOf = (cfg) => ['--repo', cfg.repo, '--host', cfg.host, '--remote', cfg.remote, ...cfg.prefixes.flatMap((prefix) => ['--prefix', prefix])];

// 'allow', 'ask', or null for a command that is not a push. Each row goes through the program's own entry point with
// the hook input Claude Code sends, so parsing and the printed answer are covered. Only the process boundary is
// skipped here: "the hook as a program" below crosses it.
function answer(command, cwd, cfg = CONFIG) {
  const input = { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: command.replaceAll('{ok}', repos.ok) }, cwd };
  const printed = lib.main(argvOf(cfg), JSON.stringify(input));
  return printed ? JSON.parse(printed).hookSpecificOutput.permissionDecision : null;
}

// Each row: [command, expected, working repo (default ok), why]. Mismatches are collected so one run shows all of them.
function table(rows, cfg) {
  const wrong = [];
  for (const [command, expected, repo = 'ok', why = ''] of rows) {
    const got = answer(command, repos[repo], cfg);
    if (got !== expected) wrong.push(`${JSON.stringify(command)} in ${repo}: expected ${expected}, got ${got} ${why}`);
  }
  assert.deepEqual(wrong, [], `${rows.length} rows`);
}

describe('exact forms that are allowed', () => {
  it('allows a plain push of one branch under the namespace, with or without -u and one plain -C', () => {
    table([
      ['git push origin fvs/foo', 'allow'],
      ['git push -u origin fvs/foo', 'allow'],
      ['git push origin fvs/rc2-hmac-proofs', 'allow'],
      ['git push origin fvs/a/b.c-d_e', 'allow', 'ok', 'nested name'],
      ['  git push origin fvs/foo', 'allow', 'ok', 'outer spaces'],
      ['git push origin fvs/foo   ', 'allow', 'ok', 'trailing spaces'],
      ['git   push   -u   origin   fvs/foo', 'allow', 'ok', 'repeated spaces'],
      ['git push\t-u origin fvs/foo', 'allow', 'ok', 'a tab between words'],
      ['git -C {ok} push origin fvs/foo', 'allow'],
      ['git -C {ok} push -u origin fvs/foo', 'allow'],
      ['git -C . push origin fvs/foo', 'allow', 'ok', 'the working directory itself'],
      ['git -C sub push origin fvs/foo', 'allow', 'ok', 'a relative path under the working directory'],
      ['git -C .. push origin fvs/foo', 'allow', 'sub', 'a relative path is resolved from the working directory: here the repository root'],
      ['git push origin fvs/foo', 'allow', 'sub', 'from a subdirectory of the repository'],
    ]);
  });

  it('allows a bare push only when HEAD, its upstream and its push target are one branch under the namespace', () => {
    table([
      ['git push', 'allow', 'ok'],
      ['git push', 'allow', 'current', 'push.default=current'],
      ['git push', 'allow', 'upstreamdefault', 'push.default=upstream'],
      ['git push', 'allow', 'simple', 'push.default=simple'],
      ['git push', 'allow', 'recursecheck', 'push.recurseSubmodules=check only verifies'],
      ['  git push  ', 'allow', 'ok'],
    ]);
    const sub = path.join(repos.ok, 'sub');
    assert.equal(answer('git push', sub), 'allow', 'from a subdirectory of the repository');
  });

  it('allows a branch under any of several namespaces', () => {
    const cfg = { ...CONFIG, prefixes: ['fvs', 'team/runs'] };
    table([
      ['git push origin team/runs/x', 'allow'],
      ['git push origin fvs/x', 'allow'],
      ['git push origin team/x', 'ask'],
      ['git push origin team/runs', 'ask'],
      ['git push origin other/x', 'ask'],
    ], cfg);
  });

  it('says what it allowed and where', () => {
    const decision = lib.decide({ command: 'git push -u origin fvs/foo', cwd: repos.ok }, CONFIG);
    assert.equal(decision.decision, 'allow');
    assert.match(decision.reason, /^FVS push gate: a push of fvs\/foo to origin \(github\.com\/Acme\/proj\)$/);
    const bare = lib.decide({ command: 'git push', cwd: repos.ok }, CONFIG);
    assert.match(bare.reason, /a bare push of fvs\/foo to origin/);
  });
});

describe('every other push asks', () => {
  it('asks for other remotes and other branches', () => {
    table([
      ['git push upstream fvs/foo', 'ask'], ['git push -u upstream fvs/foo', 'ask'], ['git push fork fvs/foo', 'ask'],
      ['git push origin main', 'ask'], ['git push origin master', 'ask'], ['git push origin baseline/x', 'ask'], ['git push origin release/2.3.8', 'ask'],
      ['git push origin ao/foo', 'ask', 'ok', 'ao/* is not this run\'s namespace'], ['git push -u origin ao/foo', 'ask'],
      ['git push origin fvs', 'ask'], ['git push origin fvs/', 'ask', 'ok', 'empty name'], ['git push origin fvs/../main', 'ask'],
      ['git push origin fvs//x', 'ask'], ['git push origin fvs/.hidden', 'ask'], ['git push origin fvs/x.lock', 'ask'], ['git push origin fvs/x.', 'ask'],
      ['git push origin fvs/a..b', 'ask'], ['git push origin fvsx/foo', 'ask'], ['git push origin FVS/foo', 'ask'], ['git push origin xfvs/foo', 'ask'],
      ['git push origin HEAD', 'ask'], ['git push origin HEAD:fvs/foo', 'ask'], ['git push origin refs/heads/fvs/foo', 'ask'],
      ['git push -u origin HEAD:refs/heads/fvs/foo', 'ask'], ['git push origin refs/tags/fvs/foo', 'ask'],
    ]);
  });

  it('asks for refspecs, force flags, deletes, tags, mirrors, and every other flag', () => {
    table([
      ['git push origin fvs/foo:main', 'ask'], ['git push origin fvs/foo:fvs/foo', 'ask'], ['git push origin +fvs/foo', 'ask'],
      ['git push origin :fvs/foo', 'ask'], ['git push origin HEAD:main', 'ask'], ['git push origin HEAD:fvs/x:main', 'ask'], ['git push origin fvs/foo:refs/heads/main', 'ask'],
      ['git push origin fvs/foo --force', 'ask'], ['git push --force origin fvs/foo', 'ask'], ['git push -f origin fvs/foo', 'ask'],
      ['git push -u origin fvs/foo -f', 'ask'], ['git push --force-with-lease origin fvs/foo', 'ask'], ['git push origin fvs/foo --force-with-lease=fvs/foo', 'ask'],
      ['git push --force-if-includes origin fvs/foo', 'ask'],
      ['git push origin --delete fvs/foo', 'ask'], ['git push origin fvs/foo --delete', 'ask'], ['git push -d origin fvs/foo', 'ask'],
      ['git push --tags origin fvs/foo', 'ask'], ['git push origin fvs/foo --tags', 'ask'], ['git push --follow-tags origin fvs/foo', 'ask'],
      ['git push --mirror origin', 'ask'], ['git push origin --mirror', 'ask'], ['git push --all origin', 'ask'], ['git push origin --all', 'ask'],
      ['git push origin fvs/foo --prune', 'ask'], ['git push --prune origin fvs/foo', 'ask'],
      ['git push -u origin fvs/foo -uf', 'ask', 'ok', 'combined short flags'], ['git push -uf origin fvs/foo', 'ask'], ['git push -fu origin fvs/foo', 'ask'],
      ['git push --set-upstream origin fvs/foo', 'ask', 'ok', 'long form of -u'], ['git push -u -u origin fvs/foo', 'ask'],
      ['git push --dry-run origin fvs/foo', 'ask'], ['git push -n origin fvs/foo', 'ask'], ['git push -u origin fvs/permission-check --dry-run', 'ask', 'ok', 'the init probe is not an allowed form'],
      ['git push --no-verify origin fvs/foo', 'ask'], ['git push -o ci.skip origin fvs/foo', 'ask'], ['git push --receive-pack=x origin fvs/foo', 'ask'],
      ['git push --repo=git@github.com:Upstream/proj.git origin fvs/foo', 'ask'], ['git push --signed origin fvs/foo', 'ask'], ['git push -q origin fvs/foo', 'ask'],
    ]);
  });

  it('asks for several refspecs, a missing refspec, and a bare push with any argument', () => {
    table([
      ['git push origin fvs/foo fvs/bar', 'ask'], ['git push origin fvs/foo ao/bar', 'ask'], ['git push origin fvs/foo bar', 'ask'], ['git push origin fvs/foo main', 'ask'],
      ['git push origin', 'ask'], ['git push -u origin', 'ask'], ['git push -u', 'ask'], ['git push --force', 'ask'], ['git push -f', 'ask'],
      ['git push origin origin fvs/foo', 'ask'], ['git push fvs/foo', 'ask'], ['git push fvs/foo origin', 'ask'],
    ]);
  });

  it('asks for chains, pipes, redirects, comments, substitutions, quotes and several lines', () => {
    table([
      ['git push origin fvs/foo; git push origin main', 'ask'], ['git push origin fvs/foo && git push origin main', 'ask'], ['git push origin fvs/foo || true', 'ask'],
      ['git push origin fvs/foo | tail -2', 'ask'], ['git push origin fvs/foo & ', 'ask'], ['git push origin fvs/foo;', 'ask'],
      ['git commit -qm x && git push -u origin fvs/foo', 'ask', 'ok', 'a worker\'s usual commit-and-push'], ['cd {ok} && git push origin fvs/foo', 'ask'],
      ['echo hi; git push origin fvs/foo', 'ask'], ['true && git push origin fvs/foo', 'ask'],
      ['git push origin fvs/foo 2>&1', 'ask', 'ok', 'a redirect'], ['git push -u origin fvs/foo 2>&1 | tail -4', 'ask'],
      ['git push origin fvs/foo > /dev/null', 'ask'], ['git push origin fvs/foo >/dev/null 2>&1', 'ask'], ['git push origin fvs/foo &>/dev/null', 'ask'],
      ['git push origin fvs/foo 2>/dev/null', 'ask'], ['git push origin fvs/foo # note', 'ask'], ['git push origin fvs/foo #', 'ask'],
      ['git push origin fvs/foo$(touch /tmp/x)', 'ask'], ['git push origin fvs/foo`id`', 'ask'], ['git push origin fvs/$B', 'ask'], ['git push origin fvs/${B}', 'ask'],
      ['git push origin "fvs/foo"', 'ask'], ["git push origin 'fvs/foo'", 'ask'], ['git push origin fvs/foo\\', 'ask'], ['git push origin fvs/f*', 'ask'], ['git push origin fvs/f?o', 'ask'],
      ['git push origin fvs/{a,b}', 'ask'], ['git push origin fvs/foo!', 'ask'], ['git push ~ origin fvs/foo', 'ask'],
      ['git push origin fvs/foo\ngit push origin release/2.3.8', 'ask'], ['git push origin fvs/foo\necho done', 'ask'], ['git push origin fvs/foo\n', 'ask'],
      ['git push\n', 'ask', 'ok', 'a bare push with a newline'], ['git push\ngit push origin main', 'ask'], ['git push\r', 'ask'], ['git push origin fvs/foo\r', 'ask'],
      ['git push && git push origin main', 'ask'], ['git push | tail -2', 'ask'], ['git push 2>&1', 'ask'],
      ['git\npush origin fvs/foo', 'ask', 'ok', 'a newline between git and push'], ['git push origin fvs/foo', 'ask', 'ok', 'a no-break space is not a word separator'],
    ]);
  });

  it('asks for any -C argument that is not a plain path, for a second -C, and for other global options', () => {
    table([
      ['git -C "$P" push -u origin fvs/foo', 'ask'], ['git -C $(id) push origin fvs/foo', 'ask'], ['git -C `id` push origin fvs/foo', 'ask'],
      ['git -C "a b" push origin fvs/foo', 'ask'], ['git -C "a b" push origin fvs/foo --delete', 'ask'], ['git -C /a\\ b push origin fvs/foo --tags', 'ask'],
      ['git -C /a\\ b push origin fvs/foo', 'ask'], ['git -C $(git rev-parse --show-toplevel) push origin fvs/foo --delete', 'ask'],
      ['git -C x>/tmp/f push origin fvs/foo', 'ask'], ['git -C x</dev/null push origin fvs/foo', 'ask'], ['git -C x;git push origin main', 'ask'],
      ['git -C ~ push origin fvs/foo', 'ask'], ['git -C ~/x push origin fvs/foo', 'ask'], ['git -C -x push origin fvs/foo', 'ask'], ['git -C {ok}/* push origin fvs/foo', 'ask'],
      ['git -C /nonexistent/dir push origin fvs/foo', 'ask', 'ok', 'the directory does not exist'],
      ['git -C /x -C /y push origin fvs/foo', 'ask'], ['git -C {ok} -C {ok} push origin fvs/foo', 'ask'], ['git -C {ok} --no-pager push origin fvs/foo', 'ask'],
      ['git --no-pager push origin fvs/foo', 'ask'], ['git --no-pager push origin release/2.3.8', 'ask'], ['git -c push.default=matching push origin fvs/foo', 'ask'],
      ['git -c push.followTags=true push origin fvs/foo', 'ask'], ['git --git-dir /x push origin fvs/foo', 'ask'], ['git --git-dir={ok}/.git push origin fvs/foo', 'ask'],
      ['git --work-tree {ok} push origin fvs/foo', 'ask'], ['git -p push origin fvs/foo', 'ask'], ['git -c user.name=x -C {ok} push origin fvs/foo', 'ask'],
      ['git -C {ok} push', 'ask', 'ok', 'a bare push after -C'], ['git -C . push', 'ask'],
    ]);
  });

  it('asks for a push behind a prefix, another spelling of git, or a wrapper', () => {
    table([
      ['rtk git push origin fvs/foo', 'ask'], ['rtk git push -u origin fvs/foo', 'ask'], ['rtk git push', 'ask'], ['rtk proxy git push origin fvs/foo', 'ask'],
      ['xrtk git push origin fvs/foo', 'ask'], ['GIT_DIR=/x git push origin fvs/foo', 'ask'], ['GIT_SSH_COMMAND=true git push origin fvs/foo', 'ask'],
      ['env git push origin fvs/foo', 'ask'], ['sudo git push origin fvs/foo', 'ask'], ['command git push origin fvs/foo', 'ask'], ['time git push origin fvs/foo', 'ask'],
      ['/usr/bin/git push origin fvs/foo', 'ask'], ['./git push origin fvs/foo', 'ask'], ['\\git push origin fvs/foo', 'ask'], ["'git' push origin fvs/foo", 'ask'], ['"git" push origin fvs/foo', 'ask'],
      ['git-push origin fvs/foo', 'ask'], ['git-push', 'ask'], ['xargs git push origin fvs/foo', 'ask'], ['nohup git push origin fvs/foo', 'ask'],
      ['bash -c "git push origin main"', 'ask'], ["sh -c 'git push -f origin fvs/foo'", 'ask'], ["git submodule foreach 'git push origin main'", 'ask'],
      ['echo done && git -C {ok} push origin fvs/foo', 'ask'], ['git commit -qm "docs: git push origin main"', 'ask', 'ok', 'push text in a message is treated as a push'],
      ['gh pr create --title "git push origin fvs/foo"', 'ask'], ['ao send --session s --message "run git push origin main"', 'ask', 'ok', 'a message that contains a push'],
    ]);
  });

  it('is silent for commands that are not a push', () => {
    table([
      ['git status', null], ['git log --oneline -3', null], ['git diff --stat HEAD~1', null], ['git -C {ok} status', null], ['git -c user.name=x commit -m "ok"', null],
      ['git commit -m "fix the gate"', null], ['git -C {ok} commit -qm "tidy up"', null], ['git branch --show-current', null], ['git -c core.pager=cat log', null],
      ['git config --get push.default', null], ['git --no-pager log -S pushed', null], ['git pull', null], ['git fetch origin', null], ['git remote -v', null],
      ['git stash push -m x', null, 'ok', 'a stash is not a remote push'], ['git ls-remote --heads origin', null], ['git checkout -b fvs/new', null],
      ['git add . && git commit -m "x"', null], ['ls -la', null], ['echo pushing', null], ['npm run push', null], ['gh pr list', null], ['gh pr view 1', null],
      ['ao send --session s --message "all done"', null], ['lake build', null], ['grep -rn gitpush .', null], ['echo digit push', null], ['mygit push', null],
      ['git -C {ok} --no-pager log', null], ['git -C {ok} commit -qm "push the thing"', null, 'ok', 'a readable -C argument: an ordinary commit stays quiet'],
      ['git -C {ok} commit -m push', null], ['', null], ['   ', null],
    ]);
    assert.equal(lib.decide({ command: undefined, cwd: repos.ok }, CONFIG), null);
    assert.equal(lib.decide({ command: 42, cwd: repos.ok }, CONFIG), null);
    assert.equal(lib.decide({}, CONFIG), null);
  });
});

describe('the bare push checks', () => {
  it('asks unless HEAD, @{upstream} and @{push} are one branch under the namespace on origin', () => {
    table([
      ['git push', 'ask', 'othername', 'the upstream is origin/fvs/other'],
      ['git push', 'ask', 'main', 'HEAD is main'],
      ['git push', 'ask', 'aobranch', 'HEAD is ao/foo, not the run\'s namespace'],
      ['git push', 'ask', 'noupstream', 'no upstream'],
      ['git push', 'ask', 'detached', 'detached HEAD'],
      ['git push', 'ask', 'upstreamremote', 'the upstream is on another remote'],
      ['git push', 'ask', 'pushremote', 'branch.<name>.pushRemote sends it to another remote'],
      ['git push', 'ask', 'pushdefault', 'remote.pushDefault sends it to another remote'],
      ['git push', 'ask', 'matching', 'push.default=matching pushes every matching branch'],
      ['git push', 'ask', 'nothing', 'push.default=nothing'],
      ['git push', 'ask', 'followtags', 'push.followTags=true'],
      ['git push', 'ask', 'originpush', 'remote.origin.push names refspecs'],
      ['git push', 'ask', 'mirror', 'remote.origin.mirror=true'],
      ['git push', 'ask', 'recurse', 'push.recurseSubmodules=on-demand pushes submodule commits'],
      ['git push', 'ask', 'notarepo', 'not a repository'],
    ]);
  });

  it('asks when the working directory is missing, relative or not a directory that exists', () => {
    assert.equal(lib.decide({ command: 'git push', cwd: undefined }, CONFIG).decision, 'ask');
    assert.equal(lib.decide({ command: 'git push', cwd: '' }, CONFIG).decision, 'ask');
    assert.equal(lib.decide({ command: 'git push origin fvs/foo', cwd: 'relative/dir' }, CONFIG).decision, 'ask');
    assert.equal(lib.decide({ command: 'git push origin fvs/foo', cwd: path.join(BASE, 'gone') }, CONFIG).decision, 'ask');
    assert.equal(lib.decide({ command: 'git -C {ok} push origin fvs/foo', cwd: undefined }, CONFIG).decision, 'ask');
  });
});

describe('the settings that make a push send more than one branch', () => {
  it('asks for the explicit forms too when tags, a mirror or submodule commits would go along', () => {
    table([
      ['git push origin fvs/foo', 'ask', 'followtags'], ['git push -u origin fvs/foo', 'ask', 'followtags'],
      ['git push origin fvs/foo', 'ask', 'mirror'], ['git push origin fvs/foo', 'ask', 'recurse'],
      ['git push origin fvs/foo', 'ask', 'submodulerecurse', 'submodule.recurse makes push follow submodules'], ['git push', 'ask', 'submodulerecurse'],
      ['git push origin fvs/foo', 'allow', 'recursecheck'], ['git push origin fvs/foo', 'allow', 'originpush', 'an explicit refspec overrides remote.origin.push'],
    ]);
  });
});

describe('the destination check: every URL git would push to must name the agreed host and repository', () => {
  const both = (repo, expected, why) => table([['git push origin fvs/foo', expected, repo, why], ['git push', expected, repo, why]]);

  it('asks when a later push URL names the upstream, and allows when all name the repository', () => {
    both('twopush', 'ask', 'the second push URL is Upstream/proj');
    both('twopushgood', 'allow', 'two push URLs, both Acme/proj, in different spellings and case');
    const decision = lib.decide({ command: 'git push origin fvs/foo', cwd: repos.twopush }, CONFIG);
    assert.match(decision.reason, /push URL git@github\.com:Upstream\/proj\.git.*not github\.com\/Acme\/proj/);
  });

  it('checks the fallback URLs: every one of them, and the first one', () => {
    both('fallbackbad', 'ask', 'a later fallback URL is Upstream/proj');
    both('fallbackfirstbad', 'ask', 'the first URL is Upstream/proj');
    both('fallbackgood', 'allow', 'three fallback URLs that all name Acme/proj');
    both('fetchbad', 'ask', 'the push URL is right but the fetch URL names the upstream');
  });

  it('asks for the same path on another host, a look-alike host, and a URL that is not a plain host and OWNER/REPO', () => {
    both('otherhost', 'ask', 'gitlab.com');
    both('lookalikehost', 'ask', 'github.com.evil.test');
    both('localpath', 'ask', 'a local path');
    both('fileurl', 'ask', 'a file URL');
    both('deeppath', 'ask', 'more than two path segments');
  });

  it('asks for a URL that reads as the agreed repository but that git sends somewhere else', () => {
    both('scpuser', 'ask', 'git splits an scp-like URL at the first colon: this is host evil.test');
    both('backslashurl', 'ask', 'a backslash is read differently by different programs');
    both('optionlike', 'ask', 'a URL that starts with a dash can pass for an option');
  });

  it('reads a URL the way git does and refuses forms that programs read differently', () => {
    assert.deepEqual(lib.parseRemoteUrl('git@github.com:Acme/proj.git'), { host: 'github.com', repo: 'Acme/proj' });
    assert.deepEqual(lib.parseRemoteUrl('ssh://evil.test:x@github.com/Acme/proj'), { host: 'github.com', repo: 'Acme/proj' }, 'in a URL with a scheme, user:password@ is the user part');
    assert.deepEqual(lib.parseRemoteUrl('https://user:tok@github.com/Acme/proj.git'), { host: 'github.com', repo: 'Acme/proj' });
    for (const url of ['evil.test:x@github.com:Acme/proj', 'evil.test:x@github.com:Acme/proj.git', 'https://evil.test\\@github.com/Acme/proj', 'ssh://evil.test\\@github.com/Acme/proj',
      '-oProxyCommand=x@github.com:Acme/proj', '--upload-pack=x@github.com:Acme/proj', 'git@github.com:Acme/proj extra', 'git@github.com:Acme/proj\x00', 'git@github.com:Acme/pro\tj', 'https://a@evil.test@github.com/Acme/proj']) {
      assert.equal(lib.parseRemoteUrl(url), null, JSON.stringify(url));
    }
    assert.notEqual(lib.parseRemoteUrl('a@b@github.com:Acme/proj')?.host, 'github.com');
  });

  it('judges the URL git uses after its own rewriting', () => {
    both('insteadof', 'ask', 'url.<base>.insteadOf points the fork URL at the upstream');
    both('pushinsteadof', 'ask', 'url.<base>.pushInsteadOf points pushes at the upstream');
  });

  it('allows https and ssh forms and compares names without case', () => {
    both('https', 'allow'); both('othercase', 'allow');
  });

  it('asks when git cannot say: no such remote, no repository, git itself missing', () => {
    both('noremote', 'ask', 'the remote is not set');
    both('notarepo', 'ask', 'not a repository');
    const bin = path.join(BASE, 'bin-without-git');
    fs.mkdirSync(bin);
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    const noGit = spawnSync(process.execPath, [GATE, '--repo', REPO, '--prefix', 'fvs'], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin fvs/foo' }, cwd: repos.ok }),
      encoding: 'utf8', env: { ...process.env, PATH: bin },
    });
    assert.equal(JSON.parse(noGit.stdout).hookSpecificOutput.permissionDecision, 'ask');
  });

  it('takes another host only from the configuration, and compares host names without case', () => {
    const cfg = (host) => ({ ...CONFIG, host });
    assert.equal(answer('git push origin fvs/foo', repos.otherhost, cfg('gitlab.com')), 'allow');
    assert.equal(answer('git push origin fvs/foo', repos.otherhost, cfg('GitLab.com')), 'allow');
    assert.equal(answer('git push origin fvs/foo', repos.ok, cfg('gitlab.com')), 'ask');
    assert.equal(answer('git push origin fvs/foo', repos.ok, { ...CONFIG, repo: 'Other/repo' }), 'ask');
  });

  it('runs the check in the repository git will push from: the working directory, or the -C path', () => {
    assert.equal(answer(`git -C ${repos.twopush} push origin fvs/foo`, repos.ok), 'ask', '-C leads to a repository with an upstream URL');
    assert.equal(answer(`git -C ${repos.ok} push origin fvs/foo`, repos.twopush), 'allow', '-C leads away from the bad repository');
    assert.equal(answer('git push origin fvs/foo', repos.twopush), 'ask');
    assert.equal(answer(`git -C ${repos.notarepo} push origin fvs/foo`, repos.ok), 'ask');
    assert.equal(answer('git -C .. push origin fvs/foo', repos.notarepo), 'ask', 'a relative -C is resolved from the working directory');
  });
});

describe('recognising a push', () => {
  it('finds a push after any run of git options and stays quiet for everything else', () => {
    for (const text of ['git push', 'x; git push', 'git -C a push', 'git -C "a b" push', "git -C 'a b' push", 'git -c k=v push', 'git --no-pager push', 'git --git-dir=x push', 'git --git-dir x push',
      'git -p -P push', 'git -C a -c b=c --no-pager push', 'sudo git push', 'git push;', 'git push|tail', 'git push>f', 'git push&&x', '"git" push', 'git-push', 'a\ngit push',
      // A -C argument the scan cannot read hides where the subcommand starts, so a later "push" word counts.
      'git -C /a\\ b push origin x', 'git -C $(git rev-parse --show-toplevel) push origin x', 'rtk git -C $(id) push', 'git -C $(id) commit -m push', 'git -C a$(x) push']) {
      assert.equal(lib.containsPush(text), true, text);
    }
    for (const text of ['git status', 'git commit -m push', 'git stash push', 'git -C a status', 'git log -S push', 'echo push', 'git pushx', 'git-pusher', 'digit push', 'git', 'git -C', 'git -C a',
      'git -C $(id) status', 'git -C /a\\ b log -S pushed', 'git -C a commit -m "no pushing here"',
      // A readable -C argument leaves no doubt where the subcommand starts, so these are not pushes.
      'git -C /x commit -qm "push the thing"', 'git -C a commit -m push', 'git -C /a/b -c user.name=x commit -m "push"', '']) {
      assert.equal(lib.containsPush(text), false, text);
    }
  });

  it('is not slowed down by a long run of options', () => {
    const started = Date.now();
    for (const text of [`git ${'-C '.repeat(20000)}x`, `git ${'-C -C '.repeat(10000)}status`, `git ${'-c a=b '.repeat(10000)}x`, `${'git '.repeat(20000)}x`, `git ${'--no-pager '.repeat(20000)}`]) {
      assert.equal(lib.containsPush(text), false);
    }
    assert.ok(Date.now() - started < 2000, 'linear time');
  });
});

describe('the configuration on the command line', () => {
  it('reads repo, host, remote and every prefix', () => {
    assert.deepEqual(lib.parseConfig(['--repo', 'Acme/proj', '--prefix', 'fvs', '--prefix', 'team/runs', '--host', 'git.example.com', '--remote', 'fork']),
      { repo: 'Acme/proj', host: 'git.example.com', remote: 'fork', prefixes: ['fvs', 'team/runs'] });
    assert.equal(lib.parseConfig(['--repo', 'Acme/proj', '--prefix', 'fvs']).remote, 'origin');
    assert.equal(lib.parseConfig(['--repo', 'Acme/proj', '--prefix', 'fvs']).host, 'github.com');
  });

  it('is unconfigured, and then asks for every push, when anything is missing or odd', () => {
    for (const argv of [[], ['--repo', 'Acme/proj'], ['--prefix', 'fvs'], ['--repo', 'nope', '--prefix', 'fvs'], ['--repo', 'Acme/proj', '--prefix', 'a b'], ['--repo', 'Acme/proj', '--prefix', 'fvs*'],
      ['--repo', 'Acme/proj', '--prefix', 'fvs', '--host', 'a b'], ['--repo', 'Acme/proj', '--prefix', 'fvs', '--remote', 'a;b'], ['--repo', 'Acme/proj', '--prefix', 'fvs', '--bogus', 'x'], ['--repo']]) {
      const cfg = lib.parseConfig(argv);
      assert.ok(cfg.problem, JSON.stringify(argv));
      assert.equal(lib.decide({ command: 'git push origin fvs/foo', cwd: repos.ok }, cfg).decision, 'ask', JSON.stringify(argv));
      assert.equal(lib.decide({ command: 'git status', cwd: repos.ok }, cfg), null, 'a command that is not a push is still left alone');
    }
  });
});

describe('the hook as a program', () => {
  const hook = (stdin, args = ['--repo', REPO, '--prefix', 'fvs']) => {
    const run = spawnSync(process.execPath, [GATE, ...args], { input: stdin, encoding: 'utf8' });
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  };
  const bash = (command, cwd = repos.ok) => JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });

  it('prints the allow decision Claude Code reads, and exits 0', () => {
    const run = hook(bash('git push -u origin fvs/foo'));
    assert.equal(run.status, 0);
    const parsed = JSON.parse(run.stdout);
    assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput']);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'allow');
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /^FVS push gate: /);
    assert.equal(run.stderr, '');
  });

  it('prints the ask decision for every other push, and exits 0', () => {
    for (const command of ['git push --force origin fvs/foo', 'git push origin main', 'git push origin fvs/foo && echo done', 'git push origin fvs/foo\ngit push origin main']) {
      const run = hook(bash(command));
      assert.equal(run.status, 0, command);
      assert.equal(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision, 'ask', command);
    }
  });

  it('prints nothing and exits 0 for a command that is not a push, another tool, or input it cannot read', () => {
    for (const stdin of [bash('git status'), bash('ls'), JSON.stringify({ tool_name: 'Edit', tool_input: { command: 'git push origin main' }, cwd: repos.ok }),
      JSON.stringify({ tool_name: 'Bash', tool_input: {} }), JSON.stringify({ tool_name: 'Bash' }), JSON.stringify({}), '{ not json', '', '[]', 'null']) {
      const run = hook(stdin);
      assert.equal(run.status, 0, stdin);
      assert.equal(run.stdout, '', stdin);
    }
  });

  it('asks for a push when it is not configured', () => {
    const run = hook(bash('git push origin fvs/foo'), []);
    assert.equal(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision, 'ask');
    assert.match(JSON.parse(run.stdout).hookSpecificOutput.permissionDecisionReason, /not configured/);
  });

  it('accepts a tool name that is missing, because older hook input had none', () => {
    const run = hook(JSON.stringify({ tool_input: { command: 'git push origin main' }, cwd: repos.ok }));
    assert.equal(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision, 'ask');
  });

  it('runs the same way when started through a link to the script', () => {
    const link = path.join(BASE, 'gate-link.mjs');
    fs.symlinkSync(GATE, link);
    const run = spawnSync(process.execPath, [link, '--repo', REPO, '--prefix', 'fvs'], { input: bash('git push origin fvs/foo'), encoding: 'utf8' });
    assert.equal(JSON.parse(run.stdout).hookSpecificOutput.permissionDecision, 'allow');
  });
});
