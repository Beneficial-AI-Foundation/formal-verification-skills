'use strict';

// The push command is the only way the auto track pushes, so a wrong "pushed" is the failure that matters: a branch
// that lands in another repository, a tag or a second branch that rides along, or a push from a repository the
// destination was not recorded for. Every row below that tries to redirect a push first proves that a plain
// push of the same URL really lands in the wrong place, and then checks that the command refuses and that the wrong
// repository stays empty. The tests push only to throwaway bare repositories. A stand-in for ssh serves the
// receiving side, so the recorded destination can be the real-looking ssh URL of a project without any network.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'fvs-auto-push.mjs');
const URL_RECORDED = 'ssh://git@github.com/Acme/proj.git';
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-push-'));
const FAKE_SSH = path.join(BASE, 'fake-ssh.sh');

let lib;
let counter = 0;

before(async () => {
  lib = await import(pathToFileURL(SCRIPT).href);
  // Stands in for ssh: ignores the host and serves the receiving side from the bare repository named in FVS_TEST_BARE.
  // The receiving side is not the repository under test, so a test that makes git take the local repository for another
  // user's (GIT_TEST_ASSUME_DIFFERENT_OWNER) does not apply that to it.
  fs.writeFileSync(FAKE_SSH, '#!/bin/sh\nfor last; do :; done\ncase "$last" in\n  git-receive-pack*) exec env -u GIT_TEST_ASSUME_DIFFERENT_OWNER git receive-pack "$FVS_TEST_BARE" ;;\n  *) echo "fake ssh: unexpected command: $last" >&2; exit 1 ;;\nesac\n', { mode: 0o755 });
});
after(() => { fs.rmSync(BASE, { recursive: true, force: true }); });

// The command drops GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM and GIT_CONFIG_NOSYSTEM, so a test that used one of them to keep
// git away from the developer's own configuration would not isolate the command. Git reads its configuration from HOME and
// XDG_CONFIG_HOME instead, so each project gets empty ones, and a test that needs a global setting writes it to
// $HOME/.gitconfig. The system configuration cannot be isolated this way; no test depends on it.
const cleanEnv = (home) => {
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_INDEX_FILE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM']) delete env[name];
  return {
    ...env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  };
};

function git(dir, env, ...args) {
  const run = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env });
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout.trim();
}

// One project: a work repository on branch fvs/t with a recorded destination, the bare repository that the stand-in
// ssh serves for it (`right`), and a second bare repository that no push may ever reach (`wrong`).
function world({ record = {}, skipRecord = false } = {}) {
  const dir = path.join(BASE, `w${counter += 1}`);
  fs.mkdirSync(dir);
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.config'), { recursive: true });
  const env = { ...cleanEnv(home), GIT_SSH_COMMAND: FAKE_SSH };
  const right = path.join(dir, 'right.git');
  const wrong = path.join(dir, 'wrong.git');
  for (const bare of [right, wrong]) git(dir, env, 'init', '-q', '--bare', bare);
  env.FVS_TEST_BARE = right;
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  git(work, env, 'init', '-q', '-b', 'main');
  git(work, env, 'commit', '-q', '--allow-empty', '-m', 'one');
  git(work, env, 'checkout', '-q', '-b', 'fvs/t');
  git(work, env, 'remote', 'add', 'origin', URL_RECORDED);
  // The run folder is kept out of git in a real project, so a record written there does not show as a change.
  fs.appendFileSync(path.join(work, '.git', 'info', 'exclude'), '.formalising/\n');
  const root = fs.realpathSync(work);
  const commonDir = fs.realpathSync(path.join(work, '.git'));
  const made = { projectRoot: root, commonDir, url: URL_RECORDED, host: 'github.com', repo: 'Acme/proj', prefixes: ['fvs'], ...record };
  if (!skipRecord) fs.writeFileSync(path.join(commonDir, lib.RECORD_NAME), JSON.stringify(lib.destinationRecord(made)));
  const w = { dir, env, home, right, wrong, work, root, commonDir, record: made };
  w.git = (...args) => git(work, env, ...args);
  w.refs = (bare) => git(dir, env, '-C', bare, 'for-each-ref', '--format=%(refname)').split('\n').filter(Boolean);
  w.go = (args, extra = {}) => lib.run(args, { cwd: extra.cwd ?? work, env: extra.env ?? env });
  // What a plain push of the recorded URL would do right now, to prove that a row really bites. The branch it created
  // is removed again, so the real command starts from the same state.
  w.plain = () => {
    const run = spawnSync('git', ['-C', work, 'push', '--porcelain', URL_RECORDED, 'refs/heads/fvs/t:refs/heads/fvs/t'], { encoding: 'utf8', env });
    return run;
  };
  w.clear = (bare) => { for (const ref of w.refs(bare)) git(dir, env, '-C', bare, 'update-ref', '-d', ref); };
  return w;
}

const nothingLanded = (w) => { assert.deepEqual(w.refs(w.right), [], 'nothing reached the recorded destination'); assert.deepEqual(w.refs(w.wrong), [], 'nothing reached the wrong repository'); };

function refused(w, args, code, extra) {
  const out = w.go(args, extra);
  assert.notEqual(out.status, 0, `${JSON.stringify(args)} must be refused: ${JSON.stringify(out.json)}`);
  assert.equal(out.json.code, code, `${JSON.stringify(args)}: ${out.json.message}`);
  return out;
}

describe('a push of one branch', () => {
  it('pushes the new branch to the recorded destination and records old and new ids and the raw line', () => {
    const w = world();
    const tip = w.git('rev-parse', 'refs/heads/fvs/t');
    const out = w.go(['--branch', 'fvs/t']);
    assert.equal(out.status, 0, JSON.stringify(out.json));
    assert.equal(out.json.code, 'pushed');
    assert.equal(out.json.result, 'created');
    assert.equal(out.json.porcelainFlag, '*');
    assert.equal(out.json.oldRemoteId, null, 'a new branch has no old id');
    assert.equal(out.json.newRemoteId, null, 'git\'s summary of a new branch carries no id, so none is claimed');
    assert.equal(out.json.localTipBeforePush, tip, 'the local read made before the push is kept under its own name');
    assert.equal(out.json.to, lib.anonymizeUrl(URL_RECORDED), 'git prints the destination without its user part');
    assert.match(out.json.porcelain, /^\*\trefs\/heads\/fvs\/t:refs\/heads\/fvs\/t\t\[new branch\]$/);
    assert.deepEqual(w.refs(w.right), ['refs/heads/fvs/t']);
    assert.equal(git(w.dir, w.env, '-C', w.right, 'rev-parse', 'refs/heads/fvs/t'), tip);
    assert.deepEqual(w.refs(w.wrong), []);
    assert.equal(out.json.recorded, true);
    const log = fs.readFileSync(path.join(w.root, lib.LOG_FILE), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(log.length, 1);
    assert.deepEqual([log[0].branch, log[0].result, log[0].newRemoteId, log[0].destination], ['fvs/t', 'created', null, URL_RECORDED]);
    assert.equal(log[0].localTipBeforePush, tip);
  });

  it('records full ids for a fast-forward, nothing new for an up-to-date push, and a failure for a rejected one', () => {
    const w = world();
    const first = w.git('rev-parse', 'HEAD');
    assert.equal(w.go(['--branch', 'fvs/t']).status, 0);
    w.git('commit', '-q', '--allow-empty', '-m', 'two');
    const second = w.git('rev-parse', 'HEAD');
    const forward = w.go(['--branch', 'fvs/t']);
    assert.equal(forward.json.result, 'fast-forward');
    assert.equal(forward.json.porcelainFlag, ' ');
    assert.equal(forward.json.oldRemoteId, first);
    assert.equal(forward.json.newRemoteId, second);
    assert.match(forward.json.oldRemoteId, /^[0-9a-f]{40,64}$/, 'a full id, not an abbreviation');
    const same = w.go(['--branch', 'fvs/t']);
    assert.equal(same.status, 0);
    assert.equal(same.json.result, 'up-to-date');
    assert.equal(same.json.porcelainFlag, '=');
    assert.equal(same.json.newRemoteId, null, 'an up-to-date summary carries no id either');
    assert.equal(same.json.localTipBeforePush, second);
    w.git('reset', '-q', '--hard', 'HEAD~1');
    w.git('commit', '-q', '--allow-empty', '-m', 'three');
    const rejected = w.go(['--branch', 'fvs/t']);
    assert.equal(rejected.status, 1);
    assert.equal(rejected.json.code, 'push-failed');
    assert.equal(rejected.json.porcelainFlag, '!');
    assert.match(rejected.json.porcelain, /\[rejected\] \(non-fast-forward\)/);
    assert.equal(rejected.json.newRemoteId, null);
    assert.equal(git(w.dir, w.env, '-C', w.right, 'rev-parse', 'refs/heads/fvs/t'), second, 'the destination was left as it was');
    const log = fs.readFileSync(path.join(w.root, lib.LOG_FILE), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(log.map((entry) => entry.result), ['created', 'fast-forward', 'up-to-date', 'failed']);
  });

  it('works from a linked worktree and from a subfolder of the project, the places a worker runs', () => {
    const w = world();
    fs.mkdirSync(path.join(w.work, 'sub'));
    assert.equal(w.go(['--branch', 'fvs/t'], { cwd: path.join(w.work, 'sub') }).json.result, 'created');
    const linked = path.join(w.dir, 'linked');
    w.git('worktree', 'add', '-q', '-b', 'fvs/w', linked);
    const out = w.go(['--branch', 'fvs/w'], { cwd: linked });
    assert.equal(out.status, 0, JSON.stringify(out.json));
    assert.equal(out.json.repositoryRoot, fs.realpathSync(linked));
    assert.deepEqual(w.refs(w.right).sort(), ['refs/heads/fvs/t', 'refs/heads/fvs/w']);
  });

  it('runs as a program: JSON on stdout and exit 0, a plain message on stderr and exit 1 or 2 when it refuses', () => {
    const w = world();
    const spawned = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: w.work, env: w.env, encoding: 'utf8' });
    const refusedRun = spawned(['--branch', 'main']);
    assert.equal(refusedRun.status, 1);
    assert.match(refusedRun.stderr, /^fvs-auto-push: "main" is not a plain branch name under fvs\/\n$/);
    assert.equal(JSON.parse(refusedRun.stdout).code, 'branch-refused');
    assert.equal(spawned([]).status, 2);
    const ok = spawned(['--branch', 'fvs/t']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).result, 'created');
    assert.deepEqual(w.refs(w.right), ['refs/heads/fvs/t']);
  });

  it('runs when started through a link to the script', () => {
    const w = world();
    const link = path.join(w.dir, 'linked-script.mjs');
    fs.symlinkSync(SCRIPT, link);
    const out = spawnSync(process.execPath, [link, '--branch', 'fvs/t'], { cwd: w.work, env: w.env, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
  });
});

describe('the record that init writes', () => {
  const HELPER = path.join(ROOT, 'scripts', 'fvs-auto-permissions.mjs');

  it('is what the push command uses: write-destination, then one real push, with no hand-made record', () => {
    const w = world({ skipRecord: true });
    const helper = (...extra) => {
      const out = spawnSync(process.execPath, [HELPER, 'write-destination', '--project-root', w.work, '--repo', 'Acme/proj', ...extra], { encoding: 'utf8', env: w.env });
      return { status: out.status, json: JSON.parse(out.stdout) };
    };
    const program = () => spawnSync(process.execPath, [SCRIPT, '--branch', 'fvs/t'], { cwd: w.work, encoding: 'utf8', env: w.env });
    // Before init has recorded anything, the command refuses and nothing lands anywhere.
    const before = program();
    assert.equal(before.status, 1);
    assert.equal(JSON.parse(before.stdout).code, 'no-destination-recorded');
    nothingLanded(w);
    const preview = helper();
    assert.equal(preview.json.code, 'confirmation-required');
    nothingLanded(w);
    const written = helper('--confirm', preview.json.digest);
    assert.equal(written.json.code, 'written');
    const expected = lib.destinationRecord({ projectRoot: w.root, commonDir: w.commonDir, url: URL_RECORDED, host: 'github.com', repo: 'Acme/proj', prefixes: ['fvs'] });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.commonDir, lib.RECORD_NAME), 'utf8')), expected);
    const tip = w.git('rev-parse', 'refs/heads/fvs/t');
    const pushed = program();
    assert.equal(pushed.status, 0, pushed.stdout + pushed.stderr);
    const json = JSON.parse(pushed.stdout);
    assert.equal(json.code, 'pushed');
    assert.equal(json.result, 'created');
    assert.equal(json.newRemoteId, null);
    assert.deepEqual(w.refs(w.right), ['refs/heads/fvs/t']);
    assert.equal(git(w.dir, w.env, '-C', w.right, 'rev-parse', 'refs/heads/fvs/t'), tip);
    assert.deepEqual(w.refs(w.wrong), [], 'nothing reached the wrong repository');
  });

  it('is written from the main checkout and found from a linked worktree, where a worker runs', () => {
    const w = world({ skipRecord: true });
    const helper = (...extra) => spawnSync(process.execPath, [HELPER, 'write-destination', '--project-root', w.work, '--repo', 'Acme/proj', ...extra], { encoding: 'utf8', env: w.env });
    const preview = JSON.parse(helper().stdout);
    assert.equal(JSON.parse(helper('--confirm', preview.digest).stdout).code, 'written');
    const linked = path.join(w.dir, 'linked');
    w.git('worktree', 'add', '-q', linked, '-b', 'fvs/linked');
    const out = spawnSync(process.execPath, [SCRIPT, '--branch', 'fvs/linked'], { cwd: linked, encoding: 'utf8', env: w.env });
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.equal(JSON.parse(out.stdout).result, 'created');
    assert.deepEqual(w.refs(w.right), ['refs/heads/fvs/linked']);
    assert.deepEqual(w.refs(w.wrong), []);
  });
});

describe('arguments: only --branch fvs/<name> is accepted', () => {
  const bad = [
    [[], 'no argument'], [['--branch'], 'no name'], [['--branch', ''], 'empty name'], [['--branch', 'fvs/t', '--force'], 'an extra option'],
    [['--branch', 'fvs/t', 'main'], 'an extra word'], [['--force', '--branch', 'fvs/t'], 'an option first'], [['--branch=fvs/t'], 'the = form'],
    [['--branch', '-f'], 'an option as the name'], [['--branch', 'fvs/t', '--branch', 'fvs/u'], 'two branches'], [['fvs/t'], 'a bare name'],
    [['--branch', 'fvs/t', '--no-verify'], 'an option that skips hooks'], [['--delete', 'fvs/t'], 'delete'],
  ];
  for (const [args, why] of bad) {
    it(`refuses ${why}: ${JSON.stringify(args)}`, () => {
      const w = world();
      refused(w, args, 'usage');
      nothingLanded(w);
    });
  }
});

describe('the branch must be a branch under the recorded namespace', () => {
  const names = [
    ['main', 'a shared branch'], ['release/x', 'a release name'], ['ao/foo', 'another namespace'], ['fvs', 'the namespace alone'], ['fvs/', 'no name'],
    ['fvs/../main', 'a parent step'], ['fvs/a b', 'a space'], ['fvs/x.lock', 'a lock name'], ['fvs/t:refs/heads/main', 'a refspec'], ['+fvs/t', 'a force prefix'],
    ['refs/heads/fvs/t', 'a full ref'], ['fvs/t/', 'a trailing slash'], ['fvs//t', 'an empty segment'], ['fvs/t*', 'a wildcard'], ['fvs/$(id)', 'a substitution'],
    ['fvs/nope', 'a branch that does not exist'], ['FVS/t', 'another case'],
  ];
  for (const [name, why] of names) {
    it(`refuses ${why}: ${name}`, () => {
      const w = world();
      refused(w, ['--branch', name], 'branch-refused');
      nothingLanded(w);
    });
  }

  it('refuses a name that is only a tag', () => {
    const w = world();
    w.git('tag', 'fvs/tagonly');
    refused(w, ['--branch', 'fvs/tagonly'], 'branch-refused');
    nothingLanded(w);
  });

  it('refuses a name that is both a branch and a tag', () => {
    const w = world();
    w.git('tag', 'fvs/t');
    const out = refused(w, ['--branch', 'fvs/t'], 'branch-refused');
    assert.match(out.json.message, /both a branch and a tag/);
    nothingLanded(w);
  });

  it('refuses a symbolic ref that points at another branch', () => {
    const w = world();
    w.git('symbolic-ref', 'refs/heads/fvs/link', 'refs/heads/main');
    refused(w, ['--branch', 'fvs/link'], 'branch-refused');
    nothingLanded(w);
  });

  it('accepts a nested name under the namespace and every namespace of the record', () => {
    const w = world({ record: { prefixes: ['fvs', 'team/fvs'] } });
    w.git('branch', 'fvs/a/b');
    w.git('branch', 'team/fvs/c');
    assert.equal(w.go(['--branch', 'fvs/a/b']).status, 0);
    assert.equal(w.go(['--branch', 'team/fvs/c']).status, 0);
    assert.deepEqual(w.refs(w.right).sort(), ['refs/heads/fvs/a/b', 'refs/heads/team/fvs/c']);
  });
});

describe('the repository must be the one the destination was recorded for', () => {
  it('refuses when no destination is recorded', () => {
    const w = world({ skipRecord: true });
    const out = refused(w, ['--branch', 'fvs/t'], 'no-destination-recorded');
    assert.match(out.json.message, /run \/fvs:auto-init/);
    nothingLanded(w);
  });

  it('refuses a record that is not exactly the recorded shape', () => {
    const rows = [
      [{ url: 'git@github.com:Other/proj.git' }, 'a URL that is not the recorded repository'], [{ host: 'evil.test' }, 'a host that does not match the URL'],
      [{ prefixes: ['main'] }, 'a shared namespace'], [{ prefixes: [] }, 'no namespace'], [{ prefixes: ['fvs/..'] }, 'a parent step in the namespace'],
      [{ url: '/srv/git/Acme/proj.git' }, 'a local path'], [{ url: '-oProxyCommand=x@github.com:Acme/proj' }, 'a URL that starts with a dash'],
      [{ projectRoot: 'relative/path' }, 'a relative project root'], [{ repo: 'Acme' }, 'no OWNER/REPO'],
    ];
    for (const [change, why] of rows) {
      const w = world({ record: change });
      const out = refused(w, ['--branch', 'fvs/t'], 'destination-record-invalid');
      assert.ok(out.json.message.length > 0, why);
      nothingLanded(w);
    }
    const w = world();
    fs.writeFileSync(path.join(w.commonDir, lib.RECORD_NAME), '{ not json');
    refused(w, ['--branch', 'fvs/t'], 'no-destination-recorded');
    fs.writeFileSync(path.join(w.commonDir, lib.RECORD_NAME), JSON.stringify({ ...w.record, schema: 'other' }));
    refused(w, ['--branch', 'fvs/t'], 'destination-record-invalid');
    nothingLanded(w);
  });

  it('refuses a copy of the repository: the record names the original', () => {
    const w = world();
    const copy = path.join(w.dir, 'copy');
    fs.cpSync(w.work, copy, { recursive: true });
    const out = refused(w, ['--branch', 'fvs/t'], 'wrong-repository', { cwd: copy });
    assert.match(out.json.message, /not the one the destination was recorded for/);
    nothingLanded(w);
  });

  it('refuses when the recorded project root is not a checkout of this repository', () => {
    const w = world();
    const other = path.join(w.dir, 'other');
    fs.mkdirSync(other);
    git(other, w.env, 'init', '-q');
    fs.writeFileSync(path.join(w.commonDir, lib.RECORD_NAME), JSON.stringify(lib.destinationRecord({ ...w.record, projectRoot: fs.realpathSync(other) })));
    const out = refused(w, ['--branch', 'fvs/t'], 'wrong-repository');
    assert.match(out.json.message, /not a checkout of this repository/);
    fs.writeFileSync(path.join(w.commonDir, lib.RECORD_NAME), JSON.stringify(lib.destinationRecord({ ...w.record, projectRoot: path.join(w.dir, 'gone') })));
    refused(w, ['--branch', 'fvs/t'], 'wrong-repository');
    nothingLanded(w);
  });

  it('uses the repository git really enters when the working directory is a link followed by a parent step', () => {
    // Two projects, each with its own record. `a/link` leads into project b, and `a/link/..` is project b, not project a.
    const a = world();
    const b = world();
    fs.mkdirSync(path.join(b.work, 'child'));
    fs.symlinkSync(path.join(b.work, 'child'), path.join(a.work, 'link'));
    const through = `${a.work}/link/..`;
    const out = spawnSync(process.execPath, [SCRIPT, '--branch', 'fvs/t'], { cwd: through, env: { ...a.env, FVS_TEST_BARE: b.right }, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(fs.realpathSync(JSON.parse(out.stdout).repositoryRoot), b.root, 'git used project b');
    assert.deepEqual(b.refs(b.right), ['refs/heads/fvs/t'], 'the branch landed in project b\'s destination');
    assert.deepEqual(a.refs(a.right), [], 'and nowhere in project a\'s');
    assert.deepEqual([a.refs(a.wrong), b.refs(b.wrong)], [[], []]);
  });

  it('refuses a project whose record belongs to the other project, entered through a link', () => {
    const a = world();
    const b = world({ skipRecord: true });
    fs.mkdirSync(path.join(b.work, 'child'));
    fs.symlinkSync(path.join(b.work, 'child'), path.join(a.work, 'link'));
    const out = spawnSync(process.execPath, [SCRIPT, '--branch', 'fvs/t'], { cwd: `${a.work}/link/..`, env: a.env, encoding: 'utf8' });
    assert.equal(out.status, 1);
    assert.equal(JSON.parse(out.stdout).code, 'no-destination-recorded', 'project b has no record, and project a\'s is not borrowed');
    assert.deepEqual([a.refs(a.right), b.refs(b.right)], [[], []]);
  });

  // `core.worktree` can name the work tree of another repository. Run from A, `git rev-parse --show-toplevel` then says B
  // while the git directory is still A's, so a command that changed into the top directory and let git discover the
  // repository again would act on B with A's recorded destination. Repository A has the record; B has the branch and no
  // record, and the stand-in ssh would serve A's destination for the push.
  describe('core.worktree names the work tree of another repository', () => {
    function twoRepositories() {
      const a = world();
      const b = world({ skipRecord: true });
      b.git('checkout', '-q', '-b', 'fvs/x');
      return { a, b };
    }
    const noRemoteUpdate = ({ a, b }) => { for (const w of [a, b]) { assert.deepEqual(w.refs(w.right), [], 'no destination was updated'); assert.deepEqual(w.refs(w.wrong), []); } };

    const toplevel = (w, env) => spawnSync('git', ['-C', w.work, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', env }).stdout.trim();

    it('refuses when the setting is in the repository configuration', () => {
      const pair = twoRepositories();
      pair.a.git('config', 'core.worktree', pair.b.root);
      // The precondition: run from A, git itself reports B's directory as the top of the work tree.
      assert.equal(fs.realpathSync(toplevel(pair.a, pair.a.env)), pair.b.root);
      const out = refused(pair.a, ['--branch', 'fvs/x'], 'worktree-mismatch');
      assert.match(out.json.message, /work tree/);
      noRemoteUpdate(pair);
    });

    // Observed with the git installed here (Apple Git 2.54): the same setting made through GIT_CONFIG_COUNT does not move
    // the top of the work tree, and git run from A still reports A. The row asserts that observation and then the exact
    // refusal that follows: A has no branch fvs/x. A git version that honoured the environment value would instead fail
    // the observation, and the round trip would refuse it as a mismatch.
    it('is not moved by the same setting made through the environment', () => {
      const pair = twoRepositories();
      const env = { ...pair.a.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: pair.b.root };
      assert.equal(fs.realpathSync(toplevel(pair.a, env)), pair.a.root, 'git run from A reports A as the top of the work tree');
      refused(pair.a, ['--branch', 'fvs/x'], 'branch-refused', { env });
      noRemoteUpdate(pair);
    });

    it('stops the init command from recording a destination for it', () => {
      const pair = twoRepositories();
      fs.rmSync(path.join(pair.a.commonDir, lib.RECORD_NAME));
      pair.a.git('config', 'core.worktree', pair.b.root);
      const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'fvs-auto-permissions.mjs'), 'write-destination', '--project-root', pair.a.work, '--repo', 'Acme/proj'], { encoding: 'utf8', env: pair.a.env });
      assert.notEqual(run.status, 0, run.stdout);
      assert.equal(JSON.parse(run.stdout).code, 'worktree-mismatch');
      assert.equal(fs.existsSync(path.join(pair.a.commonDir, lib.RECORD_NAME)), false, 'no record was written');
    });

    it('still works for a repository whose git directory is kept apart from its work tree', () => {
      const w = world({ skipRecord: true });
      const apart = path.join(w.dir, 'apart.git');
      git(w.work, w.env, 'init', '-q', '--separate-git-dir', apart);
      assert.match(fs.readFileSync(path.join(w.work, '.git'), 'utf8'), /^gitdir: /, 'the work tree now has a .git file');
      const commonDir = fs.realpathSync(apart);
      fs.writeFileSync(path.join(commonDir, lib.RECORD_NAME), JSON.stringify(lib.destinationRecord({ ...w.record, commonDir })));
      const out = w.go(['--branch', 'fvs/t']);
      assert.equal(out.status, 0, JSON.stringify(out.json));
      assert.equal(out.json.commonDir, commonDir);
      assert.deepEqual(w.refs(w.right), ['refs/heads/fvs/t']);
    });
  });

  // The variables that would move git to another repository are removed from every git call, so the command keeps acting
  // on the repository of its working directory. Each row first shows that the variable really moves a plain git call.
  it('is not moved by GIT_DIR, GIT_WORK_TREE or GIT_COMMON_DIR pointing at another repository', () => {
    const rows = [
      ['GIT_DIR', (other) => other.commonDir, ['rev-parse', '--abbrev-ref', 'HEAD'], (shown) => shown === 'fvs/x'],
      ['GIT_WORK_TREE', (other) => other.root, ['rev-parse', '--show-toplevel'], (shown, other) => fs.realpathSync(shown) === other.root],
      ['GIT_COMMON_DIR', (other) => other.commonDir, ['rev-parse', '--git-common-dir'], (shown, other) => fs.realpathSync(shown) === other.commonDir],
    ];
    for (const [name, value, probe, moved] of rows) {
      const a = world();
      const other = world({ skipRecord: true });
      other.git('checkout', '-q', '-b', 'fvs/x');
      const env = { ...a.env, [name]: value(other) };
      const shown = spawnSync('git', ['-C', a.work, ...probe], { encoding: 'utf8', env }).stdout.trim();
      assert.ok(moved(shown, other), `${name} moves a plain git call to the other repository (it printed ${shown})`);
      const out = a.go(['--branch', 'fvs/t'], { env });
      assert.equal(out.status, 0, `${name}: ${JSON.stringify(out.json)}`);
      assert.equal(out.json.repositoryRoot, a.root, `${name}: the command acted on its own repository`);
      assert.deepEqual(a.refs(a.right), ['refs/heads/fvs/t']);
      assert.deepEqual([other.refs(other.right), other.refs(other.wrong), a.refs(a.wrong)], [[], [], []]);
    }
  });

  it('refuses outside any git repository', () => {
    const w = world();
    const elsewhere = path.join(w.dir, 'plain');
    fs.mkdirSync(elsewhere);
    refused(w, ['--branch', 'fvs/t'], 'not-a-repository', { cwd: elsewhere });
  });
});

describe('the destination cannot be redirected', () => {
  it('insteadOf: a rule that rewrites the recorded URL sends a plain push elsewhere, and the command refuses', () => {
    const w = world();
    w.git('config', `url.${w.wrong}.insteadOf`, URL_RECORDED);
    assert.equal(w.plain().status, 0);
    assert.deepEqual(w.refs(w.wrong), ['refs/heads/fvs/t'], 'the row bites: a plain push lands in the wrong repository');
    w.clear(w.wrong);
    const out = refused(w, ['--branch', 'fvs/t'], 'destination-rewritten');
    assert.match(out.json.message, /url\..*\.insteadof.*would rewrite the recorded destination/);
    nothingLanded(w);
  });

  it('pushInsteadOf: the same, for the push-only rule that git ls-remote --get-url does not show', () => {
    const w = world();
    w.git('config', `url.${w.wrong}.pushInsteadOf`, URL_RECORDED);
    assert.equal(w.plain().status, 0);
    assert.deepEqual(w.refs(w.wrong), ['refs/heads/fvs/t'], 'the row bites');
    w.clear(w.wrong);
    assert.equal(w.git('ls-remote', '--get-url', URL_RECORDED), URL_RECORDED, 'the fetch-side view does not show this rule');
    const out = refused(w, ['--branch', 'fvs/t'], 'destination-rewritten');
    assert.match(out.json.message, /pushinsteadof/);
    nothingLanded(w);
  });

  it('a rule for a shorter prefix and a rule with an empty value are refused', () => {
    for (const [key, value] of [['url.X.insteadOf', 'ssh://git@github.com/'], ['url.X.pushInsteadOf', 'ssh://'], ['url.X.insteadOf', ''], ['url.X.pushInsteadOf', URL_RECORDED]]) {
      const w = world();
      w.git('config', key.replace('X', w.wrong), value);
      refused(w, ['--branch', 'fvs/t'], 'destination-rewritten');
      nothingLanded(w);
    }
  });

  // GIT_CONFIG_COUNT and its key and value pairs are removed from every git call, so a rewrite rule that only the
  // environment holds is neither checked nor used: the check and the push see the same configuration.
  it('a rewrite rule held only by the environment is not used: the push reaches the recorded destination', () => {
    const w = world();
    const env = { ...w.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${w.wrong}.insteadOf`, GIT_CONFIG_VALUE_0: URL_RECORDED };
    assert.equal(spawnSync('git', ['-C', w.work, 'push', '-q', URL_RECORDED, 'refs/heads/fvs/t:refs/heads/fvs/t'], { env, encoding: 'utf8' }).status, 0);
    assert.deepEqual(w.refs(w.wrong), ['refs/heads/fvs/t'], 'the row bites: a plain push follows the environment rule');
    w.clear(w.wrong);
    const out = w.go(['--branch', 'fvs/t'], { env });
    assert.equal(out.status, 0, JSON.stringify(out.json));
    assert.deepEqual(w.refs(w.right), ['refs/heads/fvs/t']);
    assert.deepEqual(w.refs(w.wrong), []);
  });

  // GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM name a configuration file that git then reads in place of its default one.
  // They are removed from every git call, so a rewrite rule that only such a file holds is neither checked nor used.
  for (const name of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
    it(`a rewrite rule in a file that only ${name} names is not used: the push reaches the recorded destination`, () => {
      const w = world();
      const file = path.join(w.dir, 'selected.gitconfig');
      fs.writeFileSync(file, `[url "${w.wrong}"]\n\tinsteadOf = ${URL_RECORDED}\n`);
      const env = { ...w.env, [name]: file };
      assert.equal(spawnSync('git', ['-C', w.work, 'push', '-q', URL_RECORDED, 'refs/heads/fvs/t:refs/heads/fvs/t'], { env, encoding: 'utf8' }).status, 0);
      assert.deepEqual(w.refs(w.wrong), ['refs/heads/fvs/t'], 'the row bites: a plain push follows the selected file');
      w.clear(w.wrong);
      const out = w.go(['--branch', 'fvs/t'], { env });
      assert.equal(out.status, 0, JSON.stringify(out.json));
      assert.deepEqual(w.refs(w.right), ['refs/heads/fvs/t']);
      assert.deepEqual(w.refs(w.wrong), []);
    });
  }

  it('a rule for some other address does not stop the push', () => {
    const w = world();
    w.git('config', `url.${w.wrong}.insteadOf`, 'https://example.org/');
    w.git('config', `url.${w.wrong}.pushInsteadOf`, 'ssh://git@gitlab.com/');
    const out = w.go(['--branch', 'fvs/t']);
    assert.equal(out.status, 0, JSON.stringify(out.json));
    assert.deepEqual(w.refs(w.right), ['refs/heads/fvs/t']);
    assert.deepEqual(w.refs(w.wrong), []);
  });

  it('a [remote "<url>"] section that names the recorded URL is refused, whatever it sets', () => {
    for (const key of ['pushurl', 'mirror', 'push', 'url']) {
      const w = world();
      w.git('config', `remote.${URL_RECORDED}.${key}`, key === 'mirror' ? 'true' : key === 'push' ? 'refs/heads/*:refs/heads/main' : w.wrong);
      refused(w, ['--branch', 'fvs/t'], 'destination-rewritten');
      nothingLanded(w);
    }
  });

  const unrelated = [
    ['remote.origin.push', 'refs/heads/fvs/t:refs/heads/main', 'maps the branch onto main'],
    ['remote.origin.pushurl', null, 'sends the remote to another repository'],
    ['remote.origin.mirror', 'true', 'makes the remote a mirror'],
    ['remote.pushDefault', 'origin', 'chooses a push remote'],
    ['branch.fvs/t.pushRemote', 'origin', 'chooses a push remote for the branch'],
    ['push.default', 'matching', 'pushes every matching branch'],
    ['push.followTags', 'true', 'sends tags that point into the pushed history'],
    ['push.recurseSubmodules', 'on-demand', 'pushes submodules'],
    ['submodule.recurse', 'true', 'makes git recurse into submodules'],
    ['push.autoSetupRemote', 'true', 'sets an upstream'],
  ];
  for (const [key, given, why] of unrelated) {
    it(`${key} ${why}, and the push still sends only the branch to the recorded destination`, () => {
      const w = world();
      const value = given ?? w.wrong;
      w.git('tag', '-a', '-m', 'release', 'fvs/v1', 'HEAD');
      w.git('config', key, value);
      if (key === 'remote.origin.push' || key === 'remote.origin.pushurl') {
        // remote.origin.push applies to a push that names no refspec; pushurl applies to every push to the remote.
        const probe = spawnSync('git', ['-C', w.work, 'push', '-q', 'origin', ...(key === 'remote.origin.push' ? [] : ['fvs/t'])], { env: w.env, encoding: 'utf8' });
        assert.equal(probe.status, 0, probe.stderr);
        assert.notDeepEqual(w.refs(w.right), ['refs/heads/fvs/t'], 'the row bites: a push to the remote name does not put the branch at the recorded destination');
        w.clear(w.right); w.clear(w.wrong);
      }
      const out = w.go(['--branch', 'fvs/t']);
      assert.equal(out.status, 0, JSON.stringify(out.json));
      assert.deepEqual(w.refs(w.right), ['refs/heads/fvs/t'], 'only the branch, and no tag, reached the destination');
      assert.deepEqual(w.refs(w.wrong), []);
      assert.equal(w.git('config', '--get', key), value, 'the setting itself was left alone');
    });
  }

  it('reads the destination git prints the way git prints it: without the user part', () => {
    assert.equal(lib.anonymizeUrl('ssh://git@github.com/Acme/proj.git'), 'ssh://github.com/Acme/proj.git');
    assert.equal(lib.anonymizeUrl('git@github.com:Acme/proj.git'), 'github.com:Acme/proj.git');
    assert.equal(lib.anonymizeUrl('https://user:tok@github.com/Acme/proj.git'), 'https://github.com/Acme/proj.git');
    assert.equal(lib.anonymizeUrl('/srv/git/proj.git'), '/srv/git/proj.git');
    assert.equal(lib.anonymizeUrl('https://github.com/Acme/proj@x'), 'https://github.com/Acme/proj@x', 'an @ after the first slash is not a user part');
    assert.equal(lib.anonymizeUrl('ssh://github.com/Acme/proj.git'), 'ssh://github.com/Acme/proj.git');
  });
});

describe('what the push sends', () => {
  it('sends the branch and no tag, however the tags are set', () => {
    const w = world();
    w.git('tag', '-a', '-m', 'release', 'fvs/v1', 'HEAD');
    w.git('tag', 'light', 'HEAD');
    assert.equal(w.go(['--branch', 'fvs/t']).status, 0);
    assert.deepEqual(w.refs(w.right), ['refs/heads/fvs/t']);
  });

  it('never forces: a branch that is behind the remote one is rejected and left alone', () => {
    const w = world();
    assert.equal(w.go(['--branch', 'fvs/t']).status, 0);
    const before = git(w.dir, w.env, '-C', w.right, 'rev-parse', 'refs/heads/fvs/t');
    w.git('commit', '-q', '--allow-empty', '-m', 'two');
    assert.equal(w.go(['--branch', 'fvs/t']).status, 0);
    w.git('reset', '-q', '--hard', before);
    w.git('commit', '-q', '--allow-empty', '-m', 'diverge');
    const out = w.go(['--branch', 'fvs/t']);
    assert.equal(out.status, 1);
    assert.equal(out.json.code, 'push-failed');
    assert.notEqual(git(w.dir, w.env, '-C', w.right, 'rev-parse', 'refs/heads/fvs/t'), w.git('rev-parse', 'HEAD'));
  });

  it('does not set an upstream and does not create origin/<branch>: a fetch is needed to see it locally', () => {
    const w = world();
    assert.equal(w.go(['--branch', 'fvs/t']).status, 0);
    assert.equal(spawnSync('git', ['-C', w.work, 'config', '--get', 'branch.fvs/t.remote'], { env: w.env }).status, 1);
    assert.equal(spawnSync('git', ['-C', w.work, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/fvs/t'], { env: w.env }).status, 1);
  });

  it('keeps the work tree, the index and every ref of the local repository as they were', () => {
    const w = world();
    fs.writeFileSync(path.join(w.work, 'loose.txt'), 'x');
    w.git('branch', 'fvs/other');
    const before = [w.git('status', '--porcelain'), w.git('for-each-ref', '--format=%(refname) %(objectname)')];
    assert.equal(w.go(['--branch', 'fvs/t']).status, 0);
    assert.deepEqual([w.git('status', '--porcelain'), w.git('for-each-ref', '--format=%(refname) %(objectname)')], before);
  });

  it('reports a failed record write without hiding a push that went through', () => {
    const w = world();
    fs.mkdirSync(path.join(w.root, '.formalising'));
    fs.writeFileSync(path.join(w.root, '.formalising', 'auto-fv'), 'a file where the folder should be');
    const out = w.go(['--branch', 'fvs/t']);
    assert.equal(out.status, 0, JSON.stringify(out.json));
    assert.equal(out.json.recorded, false);
    assert.match(out.json.recordError, /./);
    assert.deepEqual(w.refs(w.right), ['refs/heads/fvs/t']);
  });
});

// Repository hooks do not run for this push: a hook that blocks a plain push does not block the command. The row for each
// place a hook can live first shows that the hook runs and blocks a plain push. The push carries --no-verify as well as
// core.hooksPath=/dev/null, so these rows would pass with either one alone: the rows for configured hooks and for the
// exact argument list below pin each of them.
describe('repository hooks', () => {
  const marker = (w) => path.join(w.dir, 'hook-ran.txt');
  const writeHook = (w, dir) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pre-push'), `#!/bin/sh\necho ran >> ${JSON.stringify(marker(w))}\nexit 1\n`, { mode: 0o755 });
  };
  const rows = [
    ['in the default hooks folder of the repository', (w) => { writeHook(w, path.join(w.commonDir, 'hooks')); return w.env; }],
    ['in the folder that core.hooksPath names in the repository configuration', (w) => { const dir = path.join(w.dir, 'hooks-local'); writeHook(w, dir); w.git('config', 'core.hooksPath', dir); return w.env; }],
    ['in the folder that core.hooksPath names in the global configuration', (w) => {
      const dir = path.join(w.dir, 'hooks-global');
      writeHook(w, dir);
      fs.writeFileSync(path.join(w.home, '.gitconfig'), `[core]\n\thooksPath = ${dir}\n`);
      return w.env;
    }],
  ];
  for (const [why, setup] of rows) {
    it(`does not run a pre-push hook ${why}`, () => {
      const w = world();
      const env = setup(w);
      const plain = spawnSync('git', ['-C', w.work, 'push', '--porcelain', URL_RECORDED, 'refs/heads/fvs/t:refs/heads/fvs/t'], { encoding: 'utf8', env });
      assert.notEqual(plain.status, 0, 'the row bites: the hook blocks a plain push');
      assert.ok(fs.existsSync(marker(w)), 'the hook ran for the plain push');
      assert.deepEqual(w.refs(w.right), []);
      fs.rmSync(marker(w));
      const run = spawnSync(process.execPath, [SCRIPT, '--branch', 'fvs/t'], { cwd: w.work, env, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.equal(fs.existsSync(marker(w)), false, 'the hook did not run for the command');
      assert.equal(run.stderr, '', 'git printed no warning about the hooks folder it was given');
      assert.deepEqual(w.refs(w.right), ['refs/heads/fvs/t']);
    });
  }
});

// A hook can also be configured with hook.<name>.event and hook.<name>.command (Git 2.54 and later). core.hooksPath does
// not turn those off; --no-verify does. Each row probes the installed git first: a plain push that has only
// core.hooksPath=/dev/null set must run the configured hook, or the row says so and is skipped.
describe('configured hooks', () => {
  const marker = (w) => path.join(w.dir, 'configured-hook-ran.txt');
  const script = (w) => {
    const file = path.join(w.dir, 'audit.sh');
    fs.writeFileSync(file, `#!/bin/sh\necho ran >> ${JSON.stringify(marker(w))}\nexit 1\n`, { mode: 0o755 });
    return file;
  };
  const rows = [
    ['in the repository configuration', (w) => { w.git('config', 'hook.audit.event', 'pre-push'); w.git('config', 'hook.audit.command', script(w)); }],
    ['in the global configuration', (w) => { fs.writeFileSync(path.join(w.home, '.gitconfig'), `[hook "audit"]\n\tevent = pre-push\n\tcommand = ${script(w)}\n`); }],
  ];
  for (const [why, setup] of rows) {
    it(`does not run a pre-push hook that is configured ${why}`, (t) => {
      const w = world();
      setup(w);
      const plain = spawnSync('git', ['-C', w.work, '-c', 'core.hooksPath=/dev/null', 'push', '--porcelain', URL_RECORDED, 'refs/heads/fvs/t:refs/heads/fvs/t'], { encoding: 'utf8', env: w.env });
      if (!fs.existsSync(marker(w))) { t.skip(`${REAL_GIT_VERSION} does not run configured hooks, so there is nothing to suppress here`); return; }
      assert.notEqual(plain.status, 0, 'the row bites: the configured hook blocks a push that only has core.hooksPath=/dev/null');
      assert.deepEqual(w.refs(w.right), []);
      fs.rmSync(marker(w));
      const run = spawnSync(process.execPath, [SCRIPT, '--branch', 'fvs/t'], { cwd: w.work, env: w.env, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stdout + run.stderr);
      assert.equal(fs.existsSync(marker(w)), false, 'the configured hook did not run for the command');
      assert.deepEqual(w.refs(w.right), ['refs/heads/fvs/t']);
    });
  }

  // An observation, not a control: a plain push shows no difference either. A push to an address updates no local ref and no
  // index, so a configured hook for those events has nothing to run for. The row records that for the installed git.
  it('is not reached by a configured hook for another event that a push might trigger', () => {
    const w = world();
    const log = path.join(w.dir, 'other-events.txt');
    const file = path.join(w.dir, 'other-event.sh');
    fs.writeFileSync(file, `#!/bin/sh\necho "$0" >> ${JSON.stringify(log)}\nexit 0\n`, { mode: 0o755 });
    for (const event of ['reference-transaction', 'post-index-change']) {
      w.git('config', `hook.other-${event}.event`, event);
      w.git('config', `hook.other-${event}.command`, file);
    }
    const out = w.go(['--branch', 'fvs/t']);
    assert.equal(out.status, 0, JSON.stringify(out.json));
    assert.equal(fs.existsSync(log), false, 'no hook for another event ran');
    assert.deepEqual(w.refs(w.right), ['refs/heads/fvs/t']);
  });

  it('makes the push with --no-verify and -c core.hooksPath=/dev/null and with no other option', () => {
    const w = world();
    const log = path.join(w.dir, 'push-argv.log');
    const body = 'for a in "$@"; do\n  if [ "$a" = push ]; then printf \'%s\\n\' "$@" > "$FVS_TEST_ARGLOG"; break; fi\ndone';
    const env = { ...gitStandIn(w, body), FVS_TEST_ARGLOG: log };
    const out = w.go(['--branch', 'fvs/t'], { env });
    assert.equal(out.status, 0, JSON.stringify(out.json));
    const argv = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
    const url = argv.indexOf(URL_RECORDED);
    assert.deepEqual(argv.slice(argv.indexOf('-c'), url), ['-c', 'push.followTags=false', '-c', 'push.pushOption=', '-c', 'core.hooksPath=/dev/null', '-c', 'core.abbrev=no',
      'push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no', '--no-verify']);
    assert.deepEqual(argv.slice(url), [URL_RECORDED, 'refs/heads/fvs/t:refs/heads/fvs/t']);
  });

  it('is described as skipping the pre-push hook, not as hooksPath turning every hook off', () => {
    const text = lib.CONTRACT.hardening[0];
    assert.match(text, /--no-verify/);
    assert.match(text, /hook\.<name>\.event/);
    assert.match(text, /core\.hooksPath is set to \/dev\/null/);
    assert.doesNotMatch(text, /Repository hooks are ignored/);
    assert.doesNotMatch(lib.CONTRACT.hardening.join(' '), /hooksPath[^.]*(turns|switches) off every hook/i);
  });
});

// The environment git runs in: the variables that move git, select its configuration files or add configuration are
// removed from every git call. The configuration files that git reads by default stay, and so do the user's own ssh,
// credential and transport settings that do not reach git through those variables.
describe('the environment git runs in', () => {
  const DROPPED = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1', 'GIT_CONFIG_PARAMETERS', 'GIT_NAMESPACE', 'GIT_EXEC_PATH'];
  const KEPT = ['GIT_SSH_COMMAND', 'GIT_ASKPASS', 'SSH_AUTH_SOCK', 'GIT_TERMINAL_PROMPT', 'HOME', 'XDG_CONFIG_HOME', 'PATH'];

  it('cleanEnvironment removes the listed names and the key and value pairs by prefix, and leaves the rest as it was', () => {
    const input = Object.fromEntries([...DROPPED, 'GIT_CONFIG_KEY_17', 'GIT_CONFIG_VALUE_17'].map((name) => [name, 'x']));
    const kept = { GIT_SSH_COMMAND: 's', GIT_SSH: 'ssh', GIT_ASKPASS: 'a', SSH_AUTH_SOCK: 'k', GIT_TERMINAL_PROMPT: '0', HOME: '/h', PATH: '/p', XDG_CONFIG_HOME: '/x', GIT_PAGER: 'cat' };
    const all = { ...input, ...kept };
    const before = JSON.stringify(all);
    assert.deepEqual(lib.cleanEnvironment(all), kept);
    assert.equal(JSON.stringify(all), before, 'the environment it was given is not changed');
  });

  it('the contract names the variables that cleanEnvironment removes, and none that it keeps', () => {
    const hardening = lib.CONTRACT.hardening.join(' ');
    const named = hardening.match(/GIT_[A-Za-z_]+/g);
    assert.ok(named.length >= 12, 'the contract lists the variables');
    for (const name of named) {
      const probe = name.endsWith('_n') ? name.replace(/_n$/, '_0') : name;
      assert.deepEqual(lib.cleanEnvironment({ [probe]: 'x' }), {}, `${name} is named in the contract and is removed`);
    }
    for (const name of DROPPED) assert.ok(named.includes(name.replace(/_\d+$/, '_n')) || named.includes(name), `${name} is removed, so the contract names it`);
    for (const name of KEPT) {
      assert.ok(!named.includes(name), `${name} stays, so the hardening list does not name it`);
      assert.deepEqual(lib.cleanEnvironment({ [name]: 'x' }), { [name]: 'x' }, name);
    }
    // What stays is stated as trusted, not as protected.
    assert.match(lib.CONTRACT.trusts.join(' '), /GIT_SSH_COMMAND/);
  });

  it('removes every listed variable from every git call the command makes, and keeps the ssh, credential and transport settings', () => {
    const w = world();
    const other = world({ skipRecord: true });
    const log = path.join(w.dir, 'env.log');
    const objects = path.join(other.commonDir, 'objects');
    const env = {
      ...gitStandIn(w, 'env | sort >> "$FVS_TEST_ENVLOG"\necho --- >> "$FVS_TEST_ENVLOG"'), FVS_TEST_ENVLOG: log,
      GIT_DIR: other.commonDir, GIT_WORK_TREE: other.root, GIT_COMMON_DIR: other.commonDir, GIT_INDEX_FILE: path.join(other.dir, 'no-index'),
      GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects, GIT_CONFIG: '/dev/null',
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'x', GIT_CONFIG_KEY_1: 'push.pushOption', GIT_CONFIG_VALUE_1: 'y',
      GIT_CONFIG_PARAMETERS: "'user.name=x'", GIT_NAMESPACE: 'ns', GIT_EXEC_PATH: path.join(w.dir, 'no-exec-path'),
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_ASKPASS: '/bin/true', SSH_AUTH_SOCK: '/tmp/fvs-test-agent.sock',
    };
    const out = w.go(['--branch', 'fvs/t'], { env });
    assert.equal(out.status, 0, JSON.stringify(out.json));
    assert.equal(out.json.repositoryRoot, w.root);
    const calls = fs.readFileSync(log, 'utf8').split('---\n').filter(Boolean).map((block) => block.split('\n').filter(Boolean).map((line) => line.slice(0, line.indexOf('='))));
    assert.ok(calls.length >= 6, `every git call was seen (${calls.length})`);
    for (const names of calls) {
      for (const name of DROPPED) assert.ok(!names.includes(name), `${name} reached a git call`);
      for (const name of KEPT) assert.ok(names.includes(name), `${name} was kept`);
    }
    assert.deepEqual(w.refs(w.right), ['refs/heads/fvs/t']);
  });
});

// A user can trust some of the variables that are otherwise removed, by name. When the user confirms the destination, init
// records the names of those of GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM, GIT_CONFIG_NOSYSTEM, GIT_CONFIG_COUNT with its KEY and
// VALUE pairs and GIT_CONFIG_PARAMETERS that are set, each with a hash of its value at that moment. The push command keeps
// exactly those names, with whatever value they have when it runs, in every git call, and drops every other name. A trusted
// name that is not set is skipped, and a value that changed since init is only marked as changed in the receipt. A sandbox
// that sets safe.directory through GIT_CONFIG_COUNT needs this, because git does not answer in a repository that another
// user owns without it, and a token in such a sandbox can be different in every session.
describe('git configuration variables that the user trusted at init', () => {
  const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
  // Git then takes the repository for one that another user owns, as in a sandbox that runs git under another account.
  const OTHER_OWNER = { GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' };
  const SAFE = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' };
  // A setting that changes nothing, for the rows about what is kept, rotated, missing or dropped.
  const NOTE = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'fvs.note', GIT_CONFIG_VALUE_0: 'note-value-1' };
  const SAME = { GIT_CONFIG_COUNT: 'same', GIT_CONFIG_KEY_0: 'same', GIT_CONFIG_VALUE_0: 'same' };
  const trust = (w, variables) => {
    w.record = { ...w.record, variables };
    fs.writeFileSync(path.join(w.commonDir, lib.RECORD_NAME), JSON.stringify(lib.destinationRecord(w.record)));
  };
  const plainGit = (w, env, ...args) => spawnSync('git', ['-C', w.work, ...args], { encoding: 'utf8', env });
  const callsOf = (log) => fs.readFileSync(log, 'utf8').split('---\n').filter(Boolean).map((block) => block.split('\n').filter(Boolean));
  const config = (lines) => lines.filter((line) => /^GIT_CONFIG/.test(line)).sort();
  const line = (variables) => Object.entries(variables).map(([name, value]) => `${name}=${value}`).sort();
  // Logs the environment that each git call of the command is started with.
  const logged = (w, extra) => {
    const log = path.join(w.dir, 'env.log');
    return { log, env: { ...gitStandIn(w, 'env | sort >> "$FVS_TEST_ENVLOG"\necho --- >> "$FVS_TEST_ENVLOG"'), FVS_TEST_ENVLOG: log, ...extra } };
  };
  const logEntries = (w) => fs.readFileSync(path.join(w.root, lib.LOG_FILE), 'utf8').trim().split('\n').map((one) => JSON.parse(one));

  it('trustableVariables takes the five names and the numbered pairs from an environment, and nothing else', () => {
    const env = {
      GIT_CONFIG_GLOBAL: '/g', GIT_CONFIG_SYSTEM: '/s', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_PARAMETERS: "'a=b'",
      GIT_CONFIG_KEY_0: 'k', GIT_CONFIG_VALUE_0: 'v', GIT_CONFIG_KEY_12: 'k', GIT_CONFIG_VALUE_12: 'v',
      GIT_CONFIG: '/c', GIT_DIR: '/d', GIT_EXEC_PATH: '/e', GIT_CONFIG_KEY_x: 'k', GIT_CONFIG_VALUE_: 'v', GIT_SSH_COMMAND: 'ssh', HOME: '/h',
    };
    assert.deepEqual(Object.keys(lib.trustableVariables(env)).sort(), ['GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_KEY_12', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_VALUE_12']);
    assert.equal(lib.trustableVariables(env).GIT_CONFIG_VALUE_0, 'v', 'the values are carried as they are');
    assert.deepEqual(lib.trustableVariables({ GIT_CONFIG_NOSYSTEM: '' }), { GIT_CONFIG_NOSYSTEM: '' }, 'a variable that is set to the empty string is set');
  });

  it('withTrusted lets cleanEnvironment keep the named variables that are set, and no other name', () => {
    const env = { ...NOTE, GIT_CONFIG_PARAMETERS: "'a=b'", GIT_DIR: '/d', GIT_EXEC_PATH: '/e', GIT_CONFIG: '/c', HOME: '/h' };
    const kept = lib.cleanEnvironment(lib.withTrusted(env, ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']));
    assert.deepEqual(kept, { ...NOTE, HOME: '/h' }, 'the named variables stay, the rest of the list goes');
    assert.equal(Object.getOwnPropertySymbols(kept).length, 0, 'what git is given carries no trace of the mechanism');
    const asked = lib.cleanEnvironment(lib.withTrusted(env, ['GIT_DIR', 'GIT_EXEC_PATH', 'GIT_CONFIG', 'GIT_CONFIG_KEY_x']));
    assert.deepEqual(asked, { HOME: '/h' }, 'a name that cannot be trusted stays removed even when it is asked for');
    assert.deepEqual(lib.cleanEnvironment(lib.withTrusted({ HOME: '/h' }, ['GIT_CONFIG_COUNT'])), { HOME: '/h' }, 'a name that is not set is not invented');
    assert.deepEqual(lib.cleanEnvironment(env), { HOME: '/h' }, 'without it every one is removed, as before');
    assert.equal(env.GIT_DIR, '/d', 'the environment it was given is not changed');
  });

  it('the record names each trusted variable with a hash of its value at that time, in name order, and nothing when none is trusted', () => {
    const w = world();
    const made = { ...w.record };
    const none = lib.destinationRecord(made);
    assert.ok(!('trustedGitVariables' in none), 'a record without variables has the shape it always had');
    assert.deepEqual(lib.destinationRecord({ ...made, variables: {} }), none);
    const rec = lib.destinationRecord({ ...made, variables: { GIT_CONFIG_VALUE_0: '*', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory' } });
    assert.deepEqual(rec.trustedGitVariables, { GIT_CONFIG_COUNT: sha('1'), GIT_CONFIG_KEY_0: sha('safe.directory'), GIT_CONFIG_VALUE_0: sha('*') });
    assert.deepEqual(Object.keys(rec.trustedGitVariables), ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']);
    assert.ok(!JSON.stringify(rec).includes('safe.directory'), 'no value is written to the record: it can hold a credential');
    assert.equal(lib.recordProblem(rec), null);
    assert.deepEqual(lib.destinationRecord({ ...made, variables: { GIT_CONFIG_NOSYSTEM: '' } }).trustedGitVariables, { GIT_CONFIG_NOSYSTEM: sha('') });
    assert.throws(() => lib.destinationRecord({ ...made, variables: { GIT_DIR: '/elsewhere' } }), /cannot be trusted/);
  });

  it('a record that names a variable outside the list, or something that is not a hash, is not used', () => {
    const w = world();
    const rec = lib.destinationRecord({ ...w.record, variables: NOTE });
    for (const bad of [{ GIT_DIR: sha('x') }, { GIT_EXEC_PATH: sha('x') }, { GIT_CONFIG: sha('x') }, { GIT_CONFIG_KEY_x: sha('x') }, { GIT_CONFIG_COUNT: 'not-a-hash' }, { GIT_CONFIG_COUNT: 1 }, ['GIT_CONFIG_COUNT'], 'GIT_CONFIG_COUNT', null]) {
      const problem = lib.recordProblem({ ...rec, trustedGitVariables: bad });
      assert.match(String(problem), /trustedGitVariables/, JSON.stringify(bad));
    }
    fs.writeFileSync(path.join(w.commonDir, lib.RECORD_NAME), JSON.stringify({ ...rec, trustedGitVariables: { GIT_DIR: sha('x') } }));
    refused(w, ['--branch', 'fvs/t'], 'destination-record-invalid');
    nothingLanded(w);
  });

  it('differingVariables names the trusted names that one record has and the other does not; another value is no difference', () => {
    const w = world();
    const was = lib.destinationRecord({ ...w.record, variables: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a', GIT_CONFIG_VALUE_0: 'b' } });
    const rotated = lib.destinationRecord({ ...w.record, variables: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a', GIT_CONFIG_VALUE_0: 'c' } });
    const more = lib.destinationRecord({ ...w.record, variables: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a', GIT_CONFIG_VALUE_0: 'c', GIT_CONFIG_NOSYSTEM: '1' } });
    assert.notDeepEqual(was.trustedGitVariables, rotated.trustedGitVariables);
    assert.deepEqual(lib.differingVariables(was, rotated), []);
    assert.deepEqual(lib.differingVariables(was, more), ['GIT_CONFIG_NOSYSTEM']);
    assert.deepEqual(lib.differingVariables(more, was), ['GIT_CONFIG_NOSYSTEM']);
    assert.deepEqual(lib.differingVariables(lib.destinationRecord(w.record), was), ['GIT_CONFIG_COUNT'], 'a record with none against one with a count: its pairs belong to the count, they are not compared');
    const grown = lib.destinationRecord({ ...w.record, variables: { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a', GIT_CONFIG_VALUE_0: 'b', GIT_CONFIG_KEY_1: 'c', GIT_CONFIG_VALUE_1: 'd' } });
    assert.deepEqual(lib.differingVariables(was, grown), [], 'a count that grew is the same unit');
    assert.deepEqual(lib.differingVariables(null, 'not a record'), []);
  });

  it('groupNames, variablesToTrust and keptVariables treat GIT_CONFIG_COUNT and the pairs it addresses as one unit', () => {
    const w = world();
    const two = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a', GIT_CONFIG_VALUE_0: 'b', GIT_CONFIG_KEY_1: 'c', GIT_CONFIG_VALUE_1: 'd' };
    assert.deepEqual(lib.groupNames(two), ['GIT_CONFIG_KEY_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_VALUE_1']);
    assert.deepEqual(lib.groupNames({ ...two, GIT_CONFIG_COUNT: '1' }), ['GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'], 'only the pairs below the count');
    assert.deepEqual(lib.groupNames({ GIT_CONFIG_KEY_0: 'a', GIT_CONFIG_VALUE_0: 'b' }), [], 'no count, no group');
    for (const count of ['', 'x', '-1', '1.5', '01x', '9999999999']) assert.deepEqual(lib.groupNames({ ...two, GIT_CONFIG_COUNT: count }), [], `a count of ${JSON.stringify(count)} addresses nothing`);
    assert.deepEqual(lib.groupNames({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_00: 'a', GIT_CONFIG_KEY_01: 'b' }), [], 'git reads KEY_0 and KEY_1, not KEY_00');
    // What init asks the user to trust: the pairs that the count does not address carry nothing and are left out.
    assert.deepEqual(Object.keys(lib.variablesToTrust({ ...two, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_KEY_2: 'e', GIT_CONFIG_VALUE_7: 'f' })).sort(), ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_VALUE_1']);
    assert.deepEqual(lib.variablesToTrust({ GIT_CONFIG_KEY_0: 'a', GIT_CONFIG_VALUE_0: 'b' }), {}, 'a pair without its count is not offered');
    // What the command keeps: a trusted count brings the pairs it addresses now, whatever the record names.
    const countOnly = lib.destinationRecord({ ...w.record, variables: { GIT_CONFIG_COUNT: '0' } });
    assert.deepEqual(lib.keptVariables(countOnly, two), ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_VALUE_1']);
    assert.deepEqual(lib.keptVariables(countOnly, { GIT_CONFIG_COUNT: '1' }), ['GIT_CONFIG_COUNT'], 'a count without its pair: nothing to bring');
    assert.deepEqual(lib.keptVariables(countOnly, {}), [], 'a trusted count that is not set is fine');
    const noCount = lib.destinationRecord({ ...w.record, variables: { GIT_CONFIG_NOSYSTEM: '1' } });
    assert.deepEqual(lib.keptVariables(noCount, { ...two, GIT_CONFIG_NOSYSTEM: '1' }), ['GIT_CONFIG_NOSYSTEM'], 'pairs without a trusted count are dropped');
    // A pair is never trusted alone: the record cannot be made that way, and one that is made by hand is not used.
    assert.throws(() => lib.destinationRecord({ ...w.record, variables: { GIT_CONFIG_KEY_0: 'a' } }), /GIT_CONFIG_COUNT/);
    assert.throws(() => lib.destinationRecord({ ...w.record, variables: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a', GIT_CONFIG_VALUE_0: 'b', GIT_CONFIG_KEY_1: 'c' } }), /GIT_CONFIG_COUNT/);
    assert.match(String(lib.recordProblem({ ...lib.destinationRecord(w.record), trustedGitVariables: { GIT_CONFIG_KEY_0: sha('x') } })), /trustedGitVariables.*GIT_CONFIG_COUNT/);
  });

  it('variableReport says for each trusted name whether its value is the confirmed one, another one or not set, and lists what it drops', () => {
    const w = world();
    const rec = lib.destinationRecord({ ...w.record, variables: NOTE });
    assert.deepEqual(lib.variableReport(rec, { ...NOTE }), { trusted: SAME, dropped: [] });
    assert.deepEqual(lib.variableReport(rec, { ...NOTE, GIT_CONFIG_VALUE_0: 'note-value-2', GIT_CONFIG_PARAMETERS: "'a=b'", GIT_CONFIG_NOSYSTEM: '1' }),
      { trusted: { ...SAME, GIT_CONFIG_VALUE_0: 'changed' }, dropped: ['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_PARAMETERS'] });
    assert.deepEqual(lib.variableReport(rec, {}), { trusted: { GIT_CONFIG_COUNT: 'not-set', GIT_CONFIG_KEY_0: 'not-set', GIT_CONFIG_VALUE_0: 'not-set' }, dropped: [] });
    assert.deepEqual(lib.variableReport(lib.destinationRecord(w.record), { ...NOTE }), { trusted: {}, dropped: ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'] });
    const shown = JSON.stringify(lib.variableReport(rec, { ...NOTE, GIT_CONFIG_VALUE_0: 'note-value-2' }));
    assert.ok(!shown.includes('note-value') && !shown.includes(sha('note-value-1')) && !shown.includes(sha('note-value-2')), 'neither a value nor a hash is reported');
    // A count that grew brings the new pairs: they are kept, not trusted by name at init, and reported as added.
    const grown = { ...NOTE, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_1: 'fvs.second', GIT_CONFIG_VALUE_1: 'v', GIT_CONFIG_KEY_2: 'fvs.third' };
    assert.deepEqual(lib.variableReport(rec, grown), {
      trusted: { GIT_CONFIG_COUNT: 'changed', GIT_CONFIG_KEY_0: 'same', GIT_CONFIG_KEY_1: 'added', GIT_CONFIG_VALUE_0: 'same', GIT_CONFIG_VALUE_1: 'added' },
      dropped: ['GIT_CONFIG_KEY_2'],
    });
  });

  describe('finding the record before git runs', () => {
    it('goes up from a subfolder to the first .git, and follows a linked worktree to the shared git directory', () => {
      const w = world();
      fs.mkdirSync(path.join(w.work, 'sub', 'deeper'), { recursive: true });
      assert.equal(lib.recordHint(path.join(w.work, 'sub', 'deeper')), w.commonDir);
      const linked = path.join(w.dir, 'linked');
      w.git('worktree', 'add', '-q', '-b', 'fvs/l', linked);
      assert.ok(fs.statSync(path.join(linked, '.git')).isFile(), 'a linked worktree has a .git file');
      assert.equal(lib.recordHint(linked), w.commonDir);
    });

    it('resolves the relative paths that a worktree made with --relative-paths writes, from a subfolder', () => {
      const w = world();
      const linked = path.join(w.dir, 'relative-linked');
      const made = spawnSync('git', ['worktree', 'add', '-q', '--relative-paths', '-b', 'fvs/r', linked], { cwd: w.work, env: w.env, encoding: 'utf8' });
      if (made.status !== 0) return; // This git has no --relative-paths; the absolute-path rows above cover it.
      assert.ok(!path.isAbsolute(/^gitdir: (.+)$/m.exec(fs.readFileSync(path.join(linked, '.git'), 'utf8'))[1].trim()), 'the .git file holds a relative path');
      fs.mkdirSync(path.join(linked, 'sub', 'deeper'), { recursive: true });
      assert.equal(lib.recordHint(path.join(linked, 'sub', 'deeper')), w.commonDir);
    });

    it('follows a .git file to a git directory that is kept apart from the work tree, and the push works from there', () => {
      const w = world({ skipRecord: true });
      const apart = path.join(w.dir, 'apart.git');
      git(w.work, w.env, 'init', '-q', '--separate-git-dir', apart);
      assert.ok(fs.statSync(path.join(w.work, '.git')).isFile());
      const commonDir = fs.realpathSync(apart);
      assert.equal(lib.recordHint(w.work), commonDir);
      fs.writeFileSync(path.join(commonDir, lib.RECORD_NAME), JSON.stringify(lib.destinationRecord({ ...w.record, commonDir })));
      const out = w.go(['--branch', 'fvs/t']);
      assert.equal(out.status, 0, JSON.stringify(out.json));
      assert.deepEqual(w.refs(w.right), ['refs/heads/fvs/t']);
    });

    it('stops at the first repository, even when that one has no record', () => {
      const w = world();
      const inner = path.join(w.work, 'inner');
      fs.mkdirSync(inner);
      git(inner, w.env, 'init', '-q');
      assert.equal(lib.recordHint(inner), fs.realpathSync(path.join(inner, '.git')));
      refused(w, ['--branch', 'fvs/t'], 'no-destination-recorded', { cwd: inner });
      nothingLanded(w);
    });

    it('refuses outside any repository, with the usual code and message', () => {
      const w = world();
      const plain = fs.mkdtempSync(path.join(BASE, 'plain-'));
      const out = refused(w, ['--branch', 'fvs/t'], 'not-a-repository', { cwd: plain });
      assert.match(out.json.message, /is not inside a git work tree/);
      assert.throws(() => lib.recordHint(path.join(plain, 'missing')), /is not inside a git work tree/);
    });

    it('is only a hint: it refuses unless git, with the trusted variables, reports that same shared git directory', () => {
      const w = world();
      const other = world({ skipRecord: true });
      const env = {
        ...gitStandIn(w, 'case "$*" in\n  *--absolute-git-dir*--git-common-dir*--show-toplevel*) printf \'%s\\n%s\\n%s\\n\' "$FVS_TEST_OTHER_GIT" "$FVS_TEST_OTHER_GIT" "$FVS_TEST_OTHER_TOP"; exit 0;;\nesac'),
        FVS_TEST_OTHER_GIT: other.commonDir, FVS_TEST_OTHER_TOP: other.root,
      };
      const out = refused(w, ['--branch', 'fvs/t'], 'wrong-repository', { env });
      assert.match(out.json.message, /the record was read from .* but git finds the shared git directory/);
      nothingLanded(w);
      assert.deepEqual(other.refs(other.right), []);
    });
  });

  it('none trusted: every variable of the list is removed from every git call, as before', () => {
    const w = world();
    const { log, env } = logged(w, { ...NOTE, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_PARAMETERS: "'fvs.extra=1'" });
    const out = w.go(['--branch', 'fvs/t'], { env });
    assert.equal(out.status, 0, JSON.stringify(out.json));
    const calls = callsOf(log);
    assert.ok(calls.length >= 6, `every git call was seen (${calls.length})`);
    for (const [index, lines] of calls.entries()) assert.deepEqual(config(lines), [], `git call ${index} runs without them`);
    assert.deepEqual(out.json.gitVariables, { trusted: {}, dropped: ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_VALUE_0'] });
  });

  it('trusted names are kept for every git call, the first included, and every other name is dropped', () => {
    const w = world();
    trust(w, NOTE);
    const extras = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_PARAMETERS: "'fvs.extra=1'", GIT_CONFIG_GLOBAL: '/dev/null' };
    const { log, env } = logged(w, { ...NOTE, ...extras });
    const out = w.go(['--branch', 'fvs/t'], { env });
    assert.equal(out.status, 0, JSON.stringify(out.json));
    const calls = callsOf(log);
    assert.ok(calls.length >= 6, `every git call was seen (${calls.length})`);
    for (const [index, lines] of calls.entries()) assert.deepEqual(config(lines), line(NOTE), `git call ${index} sees exactly the trusted variables`);
    assert.deepEqual(out.json.gitVariables, { trusted: SAME, dropped: ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_PARAMETERS'] });
    assert.deepEqual(w.refs(w.right), ['refs/heads/fvs/t']);
  });

  it('a trusted name whose value rotated is kept with the value it has now, and the receipt marks it as changed', () => {
    const w = world();
    trust(w, NOTE);
    const rotated = { ...NOTE, GIT_CONFIG_VALUE_0: 'note-value-2' };
    const { log, env } = logged(w, rotated);
    const out = w.go(['--branch', 'fvs/t'], { env });
    assert.equal(out.status, 0, JSON.stringify(out.json));
    for (const [index, lines] of callsOf(log).entries()) assert.deepEqual(config(lines), line(rotated), `git call ${index} sees the value it has now`);
    assert.deepEqual(out.json.gitVariables.trusted, { ...SAME, GIT_CONFIG_VALUE_0: 'changed' });
    const entry = logEntries(w).at(-1);
    assert.deepEqual(entry.gitVariables.trusted, { ...SAME, GIT_CONFIG_VALUE_0: 'changed' }, 'the receipt in the log says the same');
    assert.ok(!JSON.stringify([out.json, entry]).includes('note-value'), 'no value is printed or logged');
    assert.ok(!JSON.stringify([out.json, entry]).includes(sha('note-value-1')), 'and no hash');
    // Rotating again changes nothing about the trust: the same names are still trusted.
    w.clear(w.right);
    const again = w.go(['--branch', 'fvs/t'], { env: { ...w.env, ...NOTE, GIT_CONFIG_VALUE_0: 'note-value-3' } });
    assert.equal(again.status, 0, JSON.stringify(again.json));
  });

  it('a trusted name that is not set is fine: there is nothing to keep', () => {
    const w = world();
    trust(w, NOTE);
    const { log, env } = logged(w, {});
    const out = w.go(['--branch', 'fvs/t'], { env });
    assert.equal(out.status, 0, JSON.stringify(out.json));
    for (const [index, lines] of callsOf(log).entries()) assert.deepEqual(config(lines), [], `git call ${index}`);
    assert.deepEqual(out.json.gitVariables, { trusted: { GIT_CONFIG_COUNT: 'not-set', GIT_CONFIG_KEY_0: 'not-set', GIT_CONFIG_VALUE_0: 'not-set' }, dropped: [] });
    assert.deepEqual(w.refs(w.right), ['refs/heads/fvs/t']);
  });

  it('a variable that is set but empty counts as set: same when it is empty again, changed when it is not, not set when it is gone', () => {
    const w = world();
    trust(w, { GIT_CONFIG_NOSYSTEM: '' });
    const states = [];
    for (const extra of [{ GIT_CONFIG_NOSYSTEM: '' }, { GIT_CONFIG_NOSYSTEM: '1' }, {}]) {
      w.clear(w.right);
      const out = w.go(['--branch', 'fvs/t'], { env: { ...w.env, ...extra } });
      assert.equal(out.status, 0, JSON.stringify(out.json));
      states.push(out.json.gitVariables.trusted.GIT_CONFIG_NOSYSTEM);
    }
    assert.deepEqual(states, ['same', 'changed', 'not-set']);
  });

  it('a trusted count brings the pairs it addresses now, whether or not the record names them: one unit', () => {
    const w = world();
    trust(w, { GIT_CONFIG_COUNT: '0' });
    assert.equal(plainGit(w, { ...w.env, GIT_CONFIG_COUNT: '1' }, 'rev-parse', '--git-dir').status, 128, 'the control: a count without its pair is an error for git itself');
    const { log, env } = logged(w, NOTE);
    const out = w.go(['--branch', 'fvs/t'], { env });
    assert.equal(out.status, 0, JSON.stringify(out.json));
    for (const [index, lines] of callsOf(log).entries()) assert.deepEqual(config(lines), line(NOTE), `git call ${index} sees the count and its pair`);
    assert.deepEqual(out.json.gitVariables, { trusted: { GIT_CONFIG_COUNT: 'changed', GIT_CONFIG_KEY_0: 'added', GIT_CONFIG_VALUE_0: 'added' }, dropped: [] });
    assert.deepEqual(w.refs(w.right), ['refs/heads/fvs/t']);
  });

  it('a count that grew since init keeps its new pairs: a sandbox that adds a setting is not refused', () => {
    const w = world();
    trust(w, NOTE);
    const grown = { ...NOTE, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_1: 'fvs.second', GIT_CONFIG_VALUE_1: 'second-value' };
    const { log, env } = logged(w, grown);
    const out = w.go(['--branch', 'fvs/t'], { env });
    assert.equal(out.status, 0, JSON.stringify(out.json));
    for (const [index, lines] of callsOf(log).entries()) assert.deepEqual(config(lines), line(grown), `git call ${index}`);
    assert.deepEqual(out.json.gitVariables, { trusted: { GIT_CONFIG_COUNT: 'changed', GIT_CONFIG_KEY_0: 'same', GIT_CONFIG_KEY_1: 'added', GIT_CONFIG_VALUE_0: 'same', GIT_CONFIG_VALUE_1: 'added' }, dropped: [] });
    assert.ok(!JSON.stringify(out.json).includes('second-value'));
  });

  it('pairs that the count does not address, and pairs without a trusted count, are dropped', () => {
    const w = world();
    trust(w, NOTE);
    const beyond = { ...NOTE, GIT_CONFIG_KEY_1: 'fvs.beyond', GIT_CONFIG_VALUE_1: 'beyond-value' };
    const first = logged(w, beyond);
    const out = w.go(['--branch', 'fvs/t'], { env: first.env });
    assert.equal(out.status, 0, JSON.stringify(out.json));
    for (const [index, lines] of callsOf(first.log).entries()) assert.deepEqual(config(lines), line(NOTE), `git call ${index} does not see the pair beyond the count`);
    assert.deepEqual(out.json.gitVariables, { trusted: SAME, dropped: ['GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1'] });
    w.clear(w.right);
    fs.rmSync(first.log);
    trust(w, { GIT_CONFIG_NOSYSTEM: '1' });
    const second = logged(w, { ...NOTE, GIT_CONFIG_NOSYSTEM: '1' });
    const again = w.go(['--branch', 'fvs/t'], { env: second.env });
    assert.equal(again.status, 0, JSON.stringify(again.json));
    for (const [index, lines] of callsOf(second.log).entries()) assert.deepEqual(config(lines), ['GIT_CONFIG_NOSYSTEM=1'], `git call ${index}: the count is not trusted, so neither is its pair`);
    assert.deepEqual(again.json.gitVariables.dropped, ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']);
  });

  describe('a sandbox that sets safe.directory through the environment', () => {
    it('the control: git does not answer for the repository without it, and does with it', () => {
      const w = world();
      const env = { ...w.env, ...OTHER_OWNER };
      assert.equal(plainGit(w, env, 'rev-parse', '--git-dir').status, 128, 'a repository that another user owns is refused');
      assert.equal(plainGit(w, { ...env, ...SAFE }, 'rev-parse', '--git-dir').status, 0, 'and answered once safe.directory is set through the environment');
    });

    it('trusted: the push works, although git cannot answer without the variables', () => {
      const w = world();
      trust(w, SAFE);
      const out = w.go(['--branch', 'fvs/t'], { env: { ...w.env, ...OTHER_OWNER, ...SAFE } });
      assert.equal(out.status, 0, JSON.stringify(out.json));
      assert.deepEqual(w.refs(w.right), ['refs/heads/fvs/t']);
    });

    it('trusted, and the value is another one that works: the push works and the receipt marks it as changed', () => {
      const w = world();
      trust(w, SAFE);
      const out = w.go(['--branch', 'fvs/t'], { env: { ...w.env, ...OTHER_OWNER, ...SAFE, GIT_CONFIG_VALUE_0: w.root } });
      assert.equal(out.status, 0, JSON.stringify(out.json));
      assert.deepEqual(out.json.gitVariables.trusted, { ...SAME, GIT_CONFIG_VALUE_0: 'changed' });
    });

    it('trusted, and the value is one that does not help: git refuses on its own', () => {
      const w = world();
      trust(w, SAFE);
      refused(w, ['--branch', 'fvs/t'], 'not-a-repository', { env: { ...w.env, ...OTHER_OWNER, ...SAFE, GIT_CONFIG_VALUE_0: '/somewhere/else' } });
      nothingLanded(w);
    });

    it('not trusted: refused, and the message names the variables and the destination step', () => {
      const w = world();
      const out = refused(w, ['--branch', 'fvs/t'], 'not-a-repository', { env: { ...w.env, ...OTHER_OWNER, ...SAFE } });
      assert.match(out.json.message, /These git variables are set and are not trusted, so this check ran without them: GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0\. If git needs one of them, run the destination step of \/fvs:auto-init again and trust it/);
      nothingLanded(w);
    });
  });

  it('a trusted name that now holds a rewrite rule is still refused: the check sees what the push sees', () => {
    const w = world();
    trust(w, NOTE);
    const rule = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${w.wrong}.insteadOf`, GIT_CONFIG_VALUE_0: URL_RECORDED };
    const env = { ...w.env, ...rule };
    assert.equal(spawnSync('git', ['-C', w.work, 'push', '-q', URL_RECORDED, 'refs/heads/fvs/t:refs/heads/fvs/t'], { env, encoding: 'utf8' }).status, 0);
    assert.deepEqual(w.refs(w.wrong), ['refs/heads/fvs/t'], 'the row bites: a plain push follows the rule');
    w.clear(w.wrong);
    refused(w, ['--branch', 'fvs/t'], 'destination-rewritten', { env });
    nothingLanded(w);
  });

  // A token can reach git through a rewrite rule that a sandbox injects, or sit in the address of the remote. The address is
  // recorded without user information, the destination is the host and OWNER/REPO, and no record, message or receipt shows it.
  describe('user information in an http address is stripped, never written down or shown', () => {
    const TOKEN = 'CANARYTOKEN';
    const PLAIN = 'https://github.com/Acme/proj.git';
    const nowhere = (value, what) => assert.ok(!JSON.stringify(value).includes(TOKEN), `${what} does not hold the token`);
    const init = (w, extra = {}) => lib.initDestination(w.root, 'origin', 'Acme/proj', 'github.com', ['fvs'], { ...w.env, ...extra });
    // A rule that only adds user information to an http address, as a sandbox does to inject a token.
    const addsToken = (base, kind = 'insteadOf') => ({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.http://user:${TOKEN}@${base}.${kind}`, GIT_CONFIG_VALUE_0: `http://${base}` });

    it('stripCredential removes the user part of an http or https address only', () => {
      assert.equal(lib.stripCredential(`https://user:${TOKEN}@github.com/Acme/proj.git`), PLAIN);
      assert.equal(lib.stripCredential(`http://${TOKEN}@127.0.0.1:8080/Acme/proj.git`), 'http://127.0.0.1:8080/Acme/proj.git');
      assert.equal(lib.stripCredential(`HTTPS://u:p%40x@github.com/Acme/proj.git`), 'HTTPS://github.com/Acme/proj.git');
      for (const same of [PLAIN, URL_RECORDED, 'git@github.com:Acme/proj.git', 'ssh://git@github.com/Acme/proj.git']) assert.equal(lib.stripCredential(same), same, 'the user name of an ssh address is not a secret');
      assert.equal(lib.scrub(`url.https://user:${TOKEN}@github.com/.insteadOf`), 'url.https://***@github.com/.insteadOf');
      // The record side reads the address the way the destination check does: everything up to the last "@" of the authority goes.
      assert.equal(lib.stripCredential('http://127.0.0.1:2#@127.0.0.1:1/Acme/proj.git'), 'http://127.0.0.1:1/Acme/proj.git');
    });

    it('init records the address without user information, whether a rule adds it or the remote holds it', () => {
      const w = world({ skipRecord: true });
      w.git('remote', 'set-url', 'origin', PLAIN);
      const control = init(w);
      assert.equal(control.problem, undefined);
      assert.equal(control.record.url, PLAIN);
      const ruled = init(w, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.https://user:${TOKEN}@github.com/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/' });
      assert.equal(ruled.problem, undefined, JSON.stringify(ruled.problem));
      assert.equal(ruled.record.url, PLAIN, 'a rule that only adds user information is no change of destination');
      nowhere(ruled.record, 'the record');
      w.git('remote', 'set-url', 'origin', `https://user:${TOKEN}@github.com/Acme/proj.git`);
      const held = init(w);
      assert.equal(held.problem, undefined, JSON.stringify(held.problem));
      assert.equal(held.record.url, PLAIN);
      nowhere(held.record, 'the record');
      assert.equal(lib.destinationProblem(w.work, 'origin', 'Acme/proj', 'github.com', w.env), null, 'the destination is host and OWNER/REPO');
    });

    it('a rule that rewrites an ssh remote to https with a token: init records the plain https address (the rule does not apply to it at the push)', () => {
      const w = world({ skipRecord: true });
      w.git('remote', 'set-url', 'origin', 'git@github.com:Acme/proj.git');
      const out = init(w, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.https://x:${TOKEN}@github.com/.insteadOf`, GIT_CONFIG_VALUE_0: 'git@github.com:' });
      assert.equal(out.problem, undefined, JSON.stringify(out.problem));
      assert.equal(out.record.url, PLAIN);
      nowhere(out.record, 'the record');
    });

    it('a real destination mismatch is still refused, and the message hides the token', () => {
      const w = world({ skipRecord: true });
      for (const [url, code] of [[`https://user:${TOKEN}@evil.test/Acme/proj.git`, 'remote-mismatch'], [`https://user:${TOKEN}@github.com/Other/proj.git`, 'remote-mismatch'], [`https://user:${TOKEN}@github.com/a/b/c.git`, 'remote-ambiguous']]) {
        w.git('remote', 'set-url', 'origin', url);
        const problem = lib.destinationProblem(w.work, 'origin', 'Acme/proj', 'github.com', w.env);
        assert.equal(problem.code, code, url);
        nowhere(problem, 'the message');
        assert.match(problem.message, /https:\/\/\*\*\*@/);
        nowhere(init(w), 'the answer of init');
      }
    });

    it('a rule that sends the recorded address anywhere but the same address is refused, and the message hides the token', () => {
      const w = world();
      trust(w, NOTE);
      const elsewhere = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.https://user:${TOKEN}@github.com/Other/.insteadOf`, GIT_CONFIG_VALUE_0: 'ssh://git@github.com/Acme/' };
      const out = refused(w, ['--branch', 'fvs/t'], 'destination-rewritten', { env: { ...w.env, ...elsewhere } });
      nowhere(out, 'the refusal');
      assert.match(out.json.message, /\*\*\*@github\.com/);
      nothingLanded(w);
    });

    it('a record whose address has user information is not used, and the problem does not repeat it', () => {
      const w = world();
      const problem = lib.recordProblem({ ...lib.destinationRecord(w.record), url: `https://user:${TOKEN}@github.com/Acme/proj.git` });
      assert.match(String(problem), /user information/);
      nowhere(problem, 'the problem');
      assert.equal(lib.destinationRecord({ ...w.record, url: `https://user:${TOKEN}@github.com/Acme/proj.git`, host: 'github.com' }).url, PLAIN, 'a record is made without it');
    });

    // Only plain user information may be added. Git and curl end the host at "/", "?", "#" and a backslash, so a base such
    // as http://host:1#@other:2/ looks like user information in front of other:2 and sends the request to host:1.
    for (const [name, base] of [['a fragment', 'http://127.0.0.1:2#@127.0.0.1:1/'], ['a query', 'http://127.0.0.1:2?@127.0.0.1:1/'], ['a backslash', 'http://127.0.0.1:2\\@127.0.0.1:1/'], ['a path', 'http://127.0.0.1:2/x@127.0.0.1:1/']]) {
      it(`a rule whose added part holds ${name} is not user information: refused`, () => {
        const w = world({ record: { url: 'http://127.0.0.1:1/Acme/proj.git', host: '127.0.0.1' } });
        const rule = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${base}.insteadOf`, GIT_CONFIG_VALUE_0: 'http://127.0.0.1:1/' };
        trust(w, rule);
        refused(w, ['--branch', 'fvs/t'], 'destination-rewritten', { env: { ...w.env, ...rule } });
      });
    }

    // The server answers 401 unless the token arrives, so a push that works proves the rule was applied at the transport.
    const SERVER = path.join(ROOT, 'tests', 'fixtures', 'authenticated-git-http-server.cjs');
    const haveBackend = fs.existsSync(path.join(spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim(), 'git-http-backend'));
    it('the fragment trick really reaches a server that a plain push of the recorded address would not, and the command refuses before connecting', { skip: !haveBackend && 'git http-backend is not installed' }, async () => {
      const served = path.join(BASE, `http-${counter++}`);
      fs.mkdirSync(path.join(served, 'Acme'), { recursive: true });
      git(served, process.env, 'init', '-q', '--bare', path.join(served, 'Acme', 'proj.git'));
      const authLog = path.join(served, 'auth.log');
      fs.writeFileSync(authLog, '');
      const child = require('node:child_process').spawn(process.execPath, [SERVER, served, TOKEN, authLog], { stdio: ['ignore', 'pipe', 'inherit'] });
      try {
        const port = await new Promise((resolve, reject) => { child.once('error', reject); child.stdout.once('data', (data) => resolve(Number.parseInt(String(data), 10))); });
        const w = world({ record: { url: 'http://127.0.0.1:1/Acme/proj.git', host: '127.0.0.1' } });
        fs.writeFileSync(path.join(w.home, '.gitconfig'), '[credential]\n\thelper =\n');
        const rule = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.http://127.0.0.1:${port}#@127.0.0.1:1/.insteadOf`, GIT_CONFIG_VALUE_0: 'http://127.0.0.1:1/' };
        trust(w, rule);
        const env = { ...w.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1', ...rule };
        spawnSync('git', ['-C', w.work, 'push', '-q', 'http://127.0.0.1:1/Acme/proj.git', 'refs/heads/fvs/t:refs/heads/fvs/t'], { encoding: 'utf8', env, timeout: 20000 });
        assert.notEqual(fs.readFileSync(authLog, 'utf8'), '', 'the control: a plain push with the rule reaches the server at the port in front of the fragment');
        fs.writeFileSync(authLog, '');
        refused(w, ['--branch', 'fvs/t'], 'destination-rewritten', { env });
        assert.equal(fs.readFileSync(authLog, 'utf8'), '', 'the command never connected');
      } finally {
        child.kill();
      }
    });

    for (const kind of ['insteadOf', 'pushInsteadOf']) {
      it(`${kind} with a token pushes: the token reaches the transport and appears in no record, message or receipt`, { skip: !haveBackend && 'git http-backend is not installed' }, async () => {
        const served = path.join(BASE, `http-${counter++}`);
        const bare = path.join(served, 'Acme', 'proj.git');
        fs.mkdirSync(path.dirname(bare), { recursive: true });
        git(served, process.env, 'init', '-q', '--bare', bare);
        const authLog = path.join(served, 'auth.log');
        fs.writeFileSync(authLog, '');
        const child = require('node:child_process').spawn(process.execPath, [SERVER, served, TOKEN, authLog], { stdio: ['ignore', 'pipe', 'inherit'] });
        try {
          const port = await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.stdout.once('data', (data) => resolve(Number.parseInt(String(data), 10)));
          });
          const address = `http://127.0.0.1:${port}/Acme/proj.git`;
          const w = world({ record: { url: address, host: '127.0.0.1' } });
          // The system configuration can name a credential helper that waits for a keychain; an empty value in the global file resets the list.
          fs.writeFileSync(path.join(w.home, '.gitconfig'), '[credential]\n\thelper =\n');
          const rule = addsToken(`127.0.0.1:${port}/`, kind);
          trust(w, rule);
          const noProxy = { NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
          const plain = spawnSync('git', ['-C', w.work, 'push', '-q', address, 'refs/heads/fvs/t:refs/heads/fvs/t'], { encoding: 'utf8', env: { ...w.env, ...noProxy } });
          assert.notEqual(plain.status, 0, 'the control: without the rule the server turns the push away');
          assert.deepEqual(git(served, process.env, '-C', bare, 'for-each-ref', '--format=%(refname)').split('\n').filter(Boolean), []);
          const out = w.go(['--branch', 'fvs/t'], { env: { ...w.env, ...noProxy, ...rule } });
          assert.equal(out.status, 0, JSON.stringify(out.json));
          assert.equal(out.json.result, 'created', JSON.stringify(out.json));
          assert.deepEqual(git(served, process.env, '-C', bare, 'for-each-ref', '--format=%(refname)').split('\n').filter(Boolean), ['refs/heads/fvs/t']);
          assert.ok(fs.readFileSync(authLog, 'utf8').includes('allowed'), 'the token reached the server');
          nowhere(out, 'the output');
          nowhere(fs.readFileSync(path.join(w.commonDir, lib.RECORD_NAME), 'utf8'), 'the record file');
          nowhere(fs.readFileSync(path.join(w.root, lib.LOG_FILE), 'utf8'), 'the receipt log');
          assert.equal(JSON.parse(fs.readFileSync(path.join(w.commonDir, lib.RECORD_NAME), 'utf8')).url, address);
          // A wrong token fails the push, and the failure shows it nowhere either.
          w.git('commit', '-q', '--allow-empty', '-m', 'two');
          const WRONG = 'WRONGCANARY';
          const wrong = addsToken(`127.0.0.1:${port}/`, kind);
          wrong.GIT_CONFIG_KEY_0 = wrong.GIT_CONFIG_KEY_0.replace(TOKEN, WRONG);
          const failed = w.go(['--branch', 'fvs/t'], { env: { ...w.env, ...noProxy, ...wrong } });
          assert.notEqual(failed.status, 0, JSON.stringify(failed.json));
          for (const [what, value] of [['the output', failed], ['the receipt log', fs.readFileSync(path.join(w.root, lib.LOG_FILE), 'utf8')], ['the record file', fs.readFileSync(path.join(w.commonDir, lib.RECORD_NAME), 'utf8')]]) {
            assert.ok(!JSON.stringify(value).includes(WRONG) && !JSON.stringify(value).includes(TOKEN), `${what} holds no token after a failed push`);
          }
        } finally {
          child.kill();
        }
      });
    }
  });

  it('a trusted name that now holds a push option sends none: the command\'s own settings come after the environment', () => {
    const w = world();
    trust(w, NOTE);
    const option = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'push.pushOption', GIT_CONFIG_VALUE_0: 'ci.skip' };
    const seen = recordPushOptions(w);
    const env = { ...w.env, ...option };
    assert.equal(plainGit(w, env, 'push', '--porcelain', URL_RECORDED, 'refs/heads/fvs/t:refs/heads/fvs/t').status, 0);
    assert.deepEqual(seen.read(), ['count=1', 'option=ci.skip'], 'the row bites: a plain push sends the option');
    w.clear(w.right);
    seen.reset();
    const out = w.go(['--branch', 'fvs/t'], { env });
    assert.equal(out.status, 0, JSON.stringify(out.json));
    assert.deepEqual(seen.read(), ['count=0'], 'the receiving side was sent no push option');
  });

  describe('what init records', () => {
    const init = (w, extra = {}) => lib.initDestination(w.root, 'origin', 'Acme/proj', 'github.com', ['fvs'], { ...w.env, ...extra });

    it('the names that are set, as hashes in the record and as values for the preview', () => {
      const w = world({ skipRecord: true });
      const out = init(w, { ...SAFE, ...OTHER_OWNER });
      assert.equal(out.problem, undefined, JSON.stringify(out.problem));
      assert.deepEqual(out.variables, SAFE);
      assert.deepEqual(out.record.trustedGitVariables, { GIT_CONFIG_COUNT: sha('1'), GIT_CONFIG_KEY_0: sha('safe.directory'), GIT_CONFIG_VALUE_0: sha('*') });
      assert.deepEqual(out.record, lib.destinationRecord({ ...w.record, variables: SAFE }));
    });

    it('the count with the pairs it addresses, and nothing else of the numbered names', () => {
      const w = world({ skipRecord: true });
      const out = init(w, { ...SAFE, GIT_CONFIG_KEY_1: 'beyond', GIT_CONFIG_VALUE_1: 'beyond-value' });
      assert.deepEqual(out.variables, SAFE, 'a pair beyond the count carries nothing: it is not offered');
      const stray = init(w, { GIT_CONFIG_KEY_0: 'stray', GIT_CONFIG_VALUE_0: 'stray-value' });
      assert.deepEqual(stray.variables, {}, 'a pair without its count is not offered either');
      assert.ok(!('trustedGitVariables' in stray.record));
    });

    it('nothing, when none is set, and the record then has its usual shape', () => {
      const w = world({ skipRecord: true });
      const out = init(w);
      assert.deepEqual(out.variables, {});
      assert.ok(!('trustedGitVariables' in out.record));
    });

    it('git has to answer with them, so init finds the repository only with the variables kept', () => {
      const w = world({ skipRecord: true });
      assert.equal(init(w, OTHER_OWNER).problem?.code, 'not-a-repository', 'the control: without safe.directory git does not answer');
      assert.equal(init(w, { ...OTHER_OWNER, ...SAFE }).problem, undefined);
    });

    it('checks the destination with the variables that it is about to record, as the push will: a rewrite rule in one is refused', () => {
      const w = world({ skipRecord: true });
      const rule = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${w.wrong}.insteadOf`, GIT_CONFIG_VALUE_0: URL_RECORDED };
      assert.equal(init(w).problem, undefined, 'the control: the same project without the rule has a destination');
      // Git rewrites the address of the remote itself, so the address no longer names the project and init refuses it.
      const out = init(w, rule);
      assert.match(out.problem?.code ?? '', /^(remote-ambiguous|destination-rewritten)$/, JSON.stringify(out));
      assert.equal(out.record, undefined);
    });
  });
});

// Push options travel to the receiving side, which can act on them (a server hook may skip checks or start a workflow).
// The receiving side below advertises them and writes down every option it receives.
function recordPushOptions(w) {
  git(w.dir, w.env, '-C', w.right, 'config', 'receive.advertisePushOptions', 'true');
  const hook = path.join(w.right, 'hooks', 'pre-receive');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, '#!/bin/sh\nn=${GIT_PUSH_OPTION_COUNT:-0}\n{ echo "count=$n"; i=0; while [ "$i" -lt "$n" ]; do eval "echo option=\\$GIT_PUSH_OPTION_$i"; i=$((i+1)); done; } > "$GIT_DIR/received-options.txt"\n', { mode: 0o755 });
  const file = path.join(w.right, 'received-options.txt');
  return { read: () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : null), reset: () => fs.rmSync(file, { force: true }) };
}

describe('push options', () => {
  const rows = [
    ['two values in the repository configuration', (w) => { w.git('config', '--add', 'push.pushOption', 'ci.skip'); w.git('config', '--add', 'push.pushOption', 'deploy=now'); return w.env; }, ['ci.skip', 'deploy=now']],
    ['two values in the global configuration', (w) => { fs.writeFileSync(path.join(w.home, '.gitconfig'), '[push]\n\tpushOption = ci.skip\n\tpushOption = deploy=now\n'); return w.env; }, ['ci.skip', 'deploy=now']],
    ['two values set through the environment', (w) => ({ ...w.env, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'push.pushOption', GIT_CONFIG_VALUE_0: 'ci.skip', GIT_CONFIG_KEY_1: 'push.pushOption', GIT_CONFIG_VALUE_1: 'deploy=now' }), ['ci.skip', 'deploy=now']],
    ['values in the global and the repository configuration at once', (w) => {
      fs.writeFileSync(path.join(w.home, '.gitconfig'), '[push]\n\tpushOption = from-global\n');
      w.git('config', '--add', 'push.pushOption', 'from-local');
      return w.env;
    }, ['from-global', 'from-local']],
  ];
  for (const [why, setup, options] of rows) {
    it(`sends none of ${why}`, () => {
      const w = world();
      const seen = recordPushOptions(w);
      const env = setup(w);
      // The row bites: a plain push of the same state delivers the options to the receiving side.
      const plain = spawnSync('git', ['-C', w.work, 'push', '--porcelain', URL_RECORDED, 'refs/heads/fvs/t:refs/heads/fvs/t'], { encoding: 'utf8', env });
      assert.equal(plain.status, 0, plain.stderr);
      assert.deepEqual(seen.read().slice(1).sort(), options.map((option) => `option=${option}`).sort(), 'a plain push carries the options');
      w.clear(w.right);
      seen.reset();
      const out = w.go(['--branch', 'fvs/t'], { env });
      assert.equal(out.status, 0, JSON.stringify(out.json));
      assert.deepEqual(seen.read(), ['count=0'], 'the receiving side was sent no push option');
      assert.deepEqual(w.refs(w.right), ['refs/heads/fvs/t']);
    });
  }
});

// A stand-in for `git` placed first on PATH, so a test can act between two of the command's git calls.
const REAL_GIT = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
const REAL_GIT_VERSION = spawnSync(REAL_GIT, ['--version'], { encoding: 'utf8' }).stdout.trim();
function gitStandIn(w, body) {
  const bin = path.join(w.dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nREAL=${JSON.stringify(REAL_GIT)}\n${body}\nexec "$REAL" "$@"\n`, { mode: 0o755 });
  return { ...w.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
}
// Moves a branch just before `git push` starts, which is after the command has read the branch tip.
const MOVE_BEFORE_PUSH = 'for a in "$@"; do\n  if [ "$a" = push ]; then "$REAL" --git-dir="$FVS_TEST_GITDIR" update-ref "$FVS_TEST_REF" "$FVS_TEST_ADVANCE"; break; fi\ndone';

describe('what a receipt names', () => {
  const moving = (w, advance) => ({ FVS_TEST_GITDIR: w.commonDir, FVS_TEST_REF: 'refs/heads/fvs/t', FVS_TEST_ADVANCE: advance });
  const remoteTip = (w) => git(w.dir, w.env, '-C', w.right, 'rev-parse', 'refs/heads/fvs/t');

  it('a new branch that moves after the read: the destination gets the later commit, and no id is claimed for it', () => {
    const w = world();
    const read = w.git('rev-parse', 'HEAD');
    w.git('commit', '-q', '--allow-empty', '-m', 'raced');
    const later = w.git('rev-parse', 'HEAD');
    w.git('reset', '-q', '--hard', read);
    const env = { ...gitStandIn(w, MOVE_BEFORE_PUSH), ...moving(w, later) };
    const out = w.go(['--branch', 'fvs/t'], { env });
    assert.equal(out.status, 0, JSON.stringify(out.json));
    assert.equal(remoteTip(w), later, 'the push sent the later commit');
    assert.equal(out.json.localTipBeforePush, read, 'what the command read before the push, named for what it is');
    assert.equal(out.json.newRemoteId, null, 'git reported no id for a new branch');
    const log = fs.readFileSync(path.join(w.root, lib.LOG_FILE), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual([log[0].newRemoteId, log[0].localTipBeforePush], [null, read]);
  });

  it('a fast-forward that moves after the read: the id is the one git reported, not the earlier read', () => {
    const w = world();
    const first = w.git('rev-parse', 'HEAD');
    assert.equal(w.go(['--branch', 'fvs/t']).status, 0);
    w.git('commit', '-q', '--allow-empty', '-m', 'read');
    const read = w.git('rev-parse', 'HEAD');
    w.git('commit', '-q', '--allow-empty', '-m', 'raced');
    const later = w.git('rev-parse', 'HEAD');
    w.git('reset', '-q', '--hard', read);
    const env = { ...gitStandIn(w, MOVE_BEFORE_PUSH), ...moving(w, later) };
    const out = w.go(['--branch', 'fvs/t'], { env });
    assert.equal(out.status, 0, JSON.stringify(out.json));
    assert.equal(out.json.result, 'fast-forward');
    assert.deepEqual([out.json.oldRemoteId, out.json.newRemoteId, out.json.localTipBeforePush], [first, later, read]);
    assert.equal(remoteTip(w), later);
  });

  it('refuses, and pushes nothing, when the branch tip cannot be read', () => {
    const w = world();
    const env = gitStandIn(w, 'case "$*" in *rev-parse*--verify*) echo "fatal: simulated failure" >&2; exit 128;; esac');
    const out = refused(w, ['--branch', 'fvs/t'], 'branch-refused', { env });
    assert.match(out.json.message, /tip/);
    nothingLanded(w);
  });
});

describe('a push whose outcome git did not report', () => {
  it('a connection lost after the destination took the update is an unknown outcome, never "nothing changed"', () => {
    const w = world();
    const hook = path.join(w.right, 'hooks', 'reference-transaction');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    // The receiving process dies once the ref update is committed, before it can report the result.
    fs.writeFileSync(hook, '#!/bin/sh\n[ "$1" = committed ] && kill -9 $PPID\nexit 0\n', { mode: 0o755 });
    const out = refused(w, ['--branch', 'fvs/t'], 'push-outcome-unknown');
    assert.deepEqual(w.refs(w.right), ['refs/heads/fvs/t'], 'the update did land');
    assert.match(out.json.message, /not know/i);
    assert.match(out.json.message, /read the destination before/i);
    assert.doesNotMatch(out.json.message, /nothing was changed/i);
    assert.equal(out.json.result, 'unknown');
    assert.equal(out.json.newRemoteId, null);
    assert.notEqual(out.json.exitStatus, 0);
    assert.equal(out.json.recorded, true);
  });

  it('a push stopped by a signal is an unknown outcome, and the signal is kept', () => {
    const w = world();
    const env = gitStandIn(w, 'for a in "$@"; do\n  if [ "$a" = push ]; then kill -9 $$; fi\ndone');
    const out = refused(w, ['--branch', 'fvs/t'], 'push-outcome-unknown', { env });
    assert.equal(out.json.signal, 'SIGKILL');
    assert.equal(out.json.result, 'unknown');
    assert.match(out.json.message, /was stopped by SIGKILL/);
  });

  it('a rejection git reports for the ref stays a plain failure', () => {
    const w = world();
    assert.equal(w.go(['--branch', 'fvs/t']).status, 0);
    const before = w.git('rev-parse', 'HEAD');
    w.git('commit', '-q', '--allow-empty', '-m', 'two');
    assert.equal(w.go(['--branch', 'fvs/t']).status, 0);
    w.git('reset', '-q', '--hard', before);
    w.git('commit', '-q', '--allow-empty', '-m', 'diverge');
    const out = refused(w, ['--branch', 'fvs/t'], 'push-failed');
    assert.equal(out.json.porcelainFlag, '!');
    assert.equal(out.json.result, 'failed');
  });
});

describe('reading the porcelain output', () => {
  const ref = 'refs/heads/fvs/t:refs/heads/fvs/t';
  const id = (n) => String(n).repeat(40);
  it('reads each flag and both ids of a fast-forward', () => {
    assert.deepEqual(lib.parsePorcelain(`To /x\n*\t${ref}\t[new branch]\nDone\n`, 'fvs/t'), { to: '/x', line: `*\t${ref}\t[new branch]`, flag: '*', summary: '[new branch]', old: null, new: null });
    const forward = lib.parsePorcelain(`To /x\n \t${ref}\t${id(1)}..${id(2)}\nDone\n`, 'fvs/t');
    assert.deepEqual([forward.flag, forward.old, forward.new], [' ', id(1), id(2)]);
    assert.equal(lib.parsePorcelain(`To /x\n=\t${ref}\t[up to date]\nDone\n`, 'fvs/t').flag, '=');
    assert.equal(lib.parsePorcelain(`To /x\n!\t${ref}\t[rejected] (non-fast-forward)\nDone\n`, 'fvs/t').flag, '!');
  });

  it('finds nothing when the line is for another ref or missing', () => {
    assert.equal(lib.parsePorcelain(`To /x\n*\trefs/heads/other:refs/heads/other\t[new branch]\n`, 'fvs/t').line, null);
    assert.equal(lib.parsePorcelain('', 'fvs/t').flag, null);
  });
});

describe('reading a remote URL', () => {
  it('reads host and repository the way git does, and refuses forms that programs read differently', () => {
    assert.deepEqual(lib.parseRemoteUrl('git@github.com:Acme/proj.git'), { host: 'github.com', repo: 'Acme/proj' });
    assert.deepEqual(lib.parseRemoteUrl('ssh://evil.test:x@github.com/Acme/proj'), { host: 'github.com', repo: 'Acme/proj' }, 'in a URL with a scheme, user:password@ is the user part');
    assert.deepEqual(lib.parseRemoteUrl('https://user:tok@github.com/Acme/proj.git'), { host: 'github.com', repo: 'Acme/proj' });
    for (const url of ['evil.test:x@github.com:Acme/proj', 'evil.test:x@github.com:Acme/proj.git', 'https://evil.test\\@github.com/Acme/proj', 'ssh://evil.test\\@github.com/Acme/proj',
      '-oProxyCommand=x@github.com:Acme/proj', '--upload-pack=x@github.com:Acme/proj', 'git@github.com:Acme/proj extra', 'git@github.com:Acme/proj\x00', 'git@github.com:Acme/pro\tj', 'https://a@evil.test@github.com/Acme/proj',
      '/srv/git/proj.git', 'file:///srv/git/Acme/proj', 'git@github.com:Acme/sub/proj.git', 'git@github.com:proj.git']) {
      assert.equal(lib.parseRemoteUrl(url), null, JSON.stringify(url));
    }
    assert.notEqual(lib.parseRemoteUrl('a@b@github.com:Acme/proj')?.host, 'github.com');
  });

  it('checks every fetch and push URL of a remote against the agreed host and repository', () => {
    const w = world();
    const check = () => lib.destinationProblem(w.work, 'origin', 'Acme/proj', 'github.com');
    assert.equal(check(), null);
    w.git('config', '--add', 'remote.origin.pushurl', 'git@github.com:Upstream/proj.git');
    assert.equal(check().code, 'remote-mismatch');
    w.git('config', '--unset-all', 'remote.origin.pushurl');
    w.git('config', '--add', 'remote.origin.url', 'git@gitlab.com:Acme/proj.git');
    assert.equal(check().code, 'remote-mismatch', 'a later fallback URL counts too');
    assert.equal(lib.destinationProblem(w.work, 'nope', 'Acme/proj', 'github.com').code, 'remote-missing');
  });
});
