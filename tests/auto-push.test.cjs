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
  fs.writeFileSync(FAKE_SSH, '#!/bin/sh\nfor last; do :; done\ncase "$last" in\n  git-receive-pack*) exec git receive-pack "$FVS_TEST_BARE" ;;\n  *) echo "fake ssh: unexpected command: $last" >&2; exit 1 ;;\nesac\n', { mode: 0o755 });
});
after(() => { fs.rmSync(BASE, { recursive: true, force: true }); });

const cleanEnv = () => {
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_INDEX_FILE']) delete env[name];
  return {
    ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0',
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
  const env = { ...cleanEnv(), GIT_SSH_COMMAND: FAKE_SSH };
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
  const w = { dir, env, right, wrong, work, root, commonDir, record: made };
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

  it('refuses when GIT_DIR or another variable moves git away from the working directory', () => {
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_NAMESPACE']) {
      const w = world();
      refused(w, ['--branch', 'fvs/t'], 'git-environment', { env: { ...w.env, [name]: w.commonDir } });
      nothingLanded(w);
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

  it('a rule for a shorter prefix, a rule with an empty value and a rule set by the environment are all refused', () => {
    for (const [key, value] of [['url.X.insteadOf', 'ssh://git@github.com/'], ['url.X.pushInsteadOf', 'ssh://'], ['url.X.insteadOf', ''], ['url.X.pushInsteadOf', URL_RECORDED]]) {
      const w = world();
      w.git('config', key.replace('X', w.wrong), value);
      refused(w, ['--branch', 'fvs/t'], 'destination-rewritten');
      nothingLanded(w);
    }
    const w = world();
    const env = { ...w.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${w.wrong}.insteadOf`, GIT_CONFIG_VALUE_0: URL_RECORDED };
    assert.equal(spawnSync('git', ['-C', w.work, 'push', '-q', URL_RECORDED, 'refs/heads/fvs/t:refs/heads/fvs/t'], { env, encoding: 'utf8' }).status, 0);
    assert.deepEqual(w.refs(w.wrong), ['refs/heads/fvs/t'], 'the row bites');
    w.clear(w.wrong);
    refused(w, ['--branch', 'fvs/t'], 'destination-rewritten', { env });
    nothingLanded(w);
  });

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

  it('runs the pre-push hook of the repository with GIT_DIR and GIT_WORK_TREE set to the checked repository', () => {
    const w = world();
    const seen = path.join(w.dir, 'hook-env.txt');
    const hook = path.join(w.commonDir, 'hooks', 'pre-push');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, `#!/bin/sh\n{ echo "GIT_DIR=$GIT_DIR"; echo "GIT_WORK_TREE=$GIT_WORK_TREE"; } > ${JSON.stringify(seen)}\n`, { mode: 0o755 });
    const plain = spawnSync('git', ['-C', w.work, 'push', '--porcelain', URL_RECORDED, 'refs/heads/fvs/t:refs/heads/fvs/t'], { encoding: 'utf8', env: w.env });
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(fs.readFileSync(seen, 'utf8'), 'GIT_DIR=\nGIT_WORK_TREE=\n', 'a plain push gives the hook neither variable');
    w.clear(w.right);
    const out = w.go(['--branch', 'fvs/t']);
    assert.equal(out.status, 0, JSON.stringify(out.json));
    assert.equal(fs.readFileSync(seen, 'utf8'), `GIT_DIR=${w.commonDir}\nGIT_WORK_TREE=${w.root}\n`, 'the command names both, and git exports them to the hook');
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
    ['two values in the global configuration', (w) => { const file = path.join(w.dir, 'global.gitconfig'); fs.writeFileSync(file, '[push]\n\tpushOption = ci.skip\n\tpushOption = deploy=now\n'); return { ...w.env, GIT_CONFIG_GLOBAL: file }; }, ['ci.skip', 'deploy=now']],
    ['two values set through the environment', (w) => ({ ...w.env, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'push.pushOption', GIT_CONFIG_VALUE_0: 'ci.skip', GIT_CONFIG_KEY_1: 'push.pushOption', GIT_CONFIG_VALUE_1: 'deploy=now' }), ['ci.skip', 'deploy=now']],
    ['values in the global and the repository configuration at once', (w) => {
      const file = path.join(w.dir, 'global.gitconfig');
      fs.writeFileSync(file, '[push]\n\tpushOption = from-global\n');
      w.git('config', '--add', 'push.pushOption', 'from-local');
      return { ...w.env, GIT_CONFIG_GLOBAL: file };
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
