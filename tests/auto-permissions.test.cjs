'use strict';

// The permission check writes a project allowlist, so its refusals matter as much as its writes: nothing is
// written without the user's confirmation of the exact rules, no forbidden rule is ever written, and a rule
// file keeps every key and rule it already had. Each probe must also be matched by the rule written for its
// own step, or the check would prove nothing about the run.

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'fvs-auto-permissions.mjs');
const PUSH_SCRIPT = path.join(ROOT, 'scripts', 'fvs-auto-push.mjs');
const PAGE = path.join(ROOT, 'fv-skills', 'references', 'auto-permissions.md');
const REPO = 'Acme/proj';
const PROGRAM = `node ${PUSH_SCRIPT}`;
const RULE = `Bash(${PROGRAM} --branch fvs/*)`;
// A stand-in for the scripts folder, so the catalog and the permissions page can be compared on any machine.
const PLACEHOLDER_DIR = '/PATH/TO/FVS/scripts';
// A rule spells out the absolute path of the push command, so the tests that write one need a checkout path it can spell.
const PLAIN_SCRIPTS = /^\/[A-Za-z0-9._/-]+$/.test(path.dirname(PUSH_SCRIPT));
const pushSkip = PLAIN_SCRIPTS ? false : 'the checkout path has characters that a rule cannot spell';

// The checks read git's configuration, so the tests do not read the developer's own. The helper drops GIT_CONFIG_GLOBAL,
// GIT_CONFIG_SYSTEM and GIT_CONFIG_NOSYSTEM from every git call, so they cannot isolate it; git is pointed at an empty
// home instead. The system configuration cannot be isolated this way, and no test depends on it.
const GIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-perm-home-'));
const withGitHome = (env = process.env) => ({ ...env, HOME: GIT_HOME, XDG_CONFIG_HOME: path.join(GIT_HOME, '.config') });

let lib;
let pushLib;
before(async () => {
  lib = await import(pathToFileURL(SCRIPT).href);
  pushLib = await import(pathToFileURL(PUSH_SCRIPT).href);
});
after(() => { fs.rmSync(GIT_HOME, { recursive: true, force: true }); });

let project;
beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-perm-'));
  const git = (...args) => assert.equal(spawnSync('git', ['-C', project, ...args], { encoding: 'utf8', env: withGitHome() }).status, 0, args.join(' '));
  git('init', '-q');
  git('remote', 'add', 'origin', `git@github.com:${REPO}.git`);
});

const base = (...extra) => ['--project-root', project, '--repo', REPO, ...extra];
function run(command, args, env) {
  const result = spawnSync(process.execPath, [SCRIPT, command, ...args], { encoding: 'utf8', env: withGitHome(env) });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch { /* usage text */ }
  return { status: result.status, json, stderr: result.stderr };
}
const settingsFile = (name = 'settings.json') => path.join(project, '.claude', name);
const writeSettings = (value, name) => {
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(settingsFile(name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
};
const readSettings = (name) => JSON.parse(fs.readFileSync(settingsFile(name), 'utf8'));
const allow = (steps, ...extra) => run('write-allowlist', base('--runtime', 'claude', '--steps', steps, ...extra));
const confirmed = (steps, ...extra) => {
  const preview = allow(steps, ...extra);
  assert.equal(preview.json.code, 'confirmation-required');
  return allow(steps, ...extra, '--confirm', preview.json.digest);
};

const destination = (...extra) => run('write-destination', base(...extra));
const recordFile = () => path.join(fs.realpathSync(project), '.git', 'fvs-auto-push.json');
const recordDestination = (...extra) => {
  const preview = destination(...extra);
  assert.equal(preview.json.code, 'confirmation-required');
  const done = destination(...extra, '--confirm', preview.json.digest);
  assert.equal(done.json.code, 'written');
  return done.json;
};

// How Claude Code reads a Bash rule: "*" stands for any text, and a trailing " *" also matches the bare command.
function bashMatches(rule, command) {
  const body = /^Bash\((.*)\)$/s.exec(rule)[1];
  const escape = (text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const trailing = body.endsWith(' *') && body.split('*').length === 2;
  const source = trailing ? `${escape(body.slice(0, -2))}( .*)?` : body.split('*').map(escape).join('.*');
  return new RegExp(`^${source}$`, 's').test(command);
}

describe('the catalog', () => {
  it('every probe is matched by a rule of its own step', () => {
    const catalog = lib.buildCatalog({ repo: REPO, prefixes: ['fvs', 'team/runs'], scriptsDir: PLACEHOLDER_DIR });
    for (const step of catalog.steps.filter((s) => s.probes)) {
      for (const probe of step.probes) {
        if (probe.tool === 'Write') {
          assert.ok(step.claude.includes(`Edit(/${lib.SCRATCH_DIR}/**)`), 'scratch edit rule');
          assert.ok(probe.path.startsWith(`${lib.SCRATCH_DIR}/`), 'scratch file is inside the scratch folder');
          continue;
        }
        assert.ok(step.claude.some((rule) => bashMatches(rule, probe.command)), `${step.id}: ${probe.command}`);
      }
    }
  });

  it('the push step names the push command by its absolute path, once per namespace, and nothing else', () => {
    const catalog = lib.buildCatalog({ repo: REPO, prefixes: ['fvs', 'team/runs'], scriptsDir: PLACEHOLDER_DIR });
    const push = catalog.steps.find((s) => s.id === 'git-push');
    const program = `node ${PLACEHOLDER_DIR}/fvs-auto-push.mjs`;
    assert.deepEqual(push.claude, [`Bash(${program} --branch fvs/*)`, `Bash(${program} --branch team/runs/*)`]);
    assert.deepEqual(push.codex.map((r) => r.pattern), [['node', `${PLACEHOLDER_DIR}/fvs-auto-push.mjs`, '--branch']]);
    assert.equal(lib.pushProgram(PLACEHOLDER_DIR), program);
    assert.equal(catalog.pushCommand.example, `${program} --branch fvs/<name>`);
    assert.deepEqual(catalog.steps.filter((s) => s.hook).map((s) => s.id), [], 'no step installs a hook');
  });

  it('the push probe is a branch name that no branch can have, one per namespace, so the command refuses it first', () => {
    const catalog = lib.buildCatalog({ repo: REPO, prefixes: ['fvs', 'team/runs'], scriptsDir: PLACEHOLDER_DIR });
    const push = catalog.steps.find((s) => s.id === 'git-push');
    assert.equal(push.probes.length, 2);
    for (const probe of push.probes) {
      const branch = probe.command.split(' --branch ')[1];
      assert.match(branch, /^(fvs|team\/runs)\/\.permission-check$/);
      assert.notEqual(spawnSync('git', ['check-ref-format', `refs/heads/${branch}`]).status, 0, `git refuses ${branch} as a branch name`);
      assert.equal(pushLib.WORD.test(branch.split('/').at(-1)), false, 'the push command\'s own name rule refuses it too');
    }
  });

  it('no rule the catalog writes matches a git push, whatever its spelling, and the push rule matches only the push command', () => {
    const catalog = lib.buildCatalog({ repo: REPO, prefixes: ['fvs', 'ao'], scriptsDir: PLACEHOLDER_DIR });
    const rules = catalog.steps.flatMap((s) => s.claude).filter((rule) => rule.startsWith('Bash('));
    for (const command of [
      'git push origin fvs/x', 'git push -u origin fvs/x', 'git push origin fvs/x main', 'git push -u origin fvs/x -uf', 'git push --force origin fvs/x',
      'git push origin fvs/x --delete', 'git push origin fvs/x:main', 'git -C /a push origin fvs/x', 'git push', 'git push origin main',
      'git push -u origin fvs/permission-check --dry-run',
    ]) assert.ok(!rules.some((rule) => bashMatches(rule, command)), command);
    const pushRules = rules.filter((rule) => rule.includes('fvs-auto-push.mjs'));
    assert.equal(pushRules.length, 2);
    const matches = (command) => pushRules.some((rule) => bashMatches(rule, command));
    const program = `node ${PLACEHOLDER_DIR}/fvs-auto-push.mjs`;
    assert.ok(matches(`${program} --branch fvs/work`));
    assert.ok(matches(`${program} --branch ao/work`));
    for (const command of [
      `${program} --branch main`, `${program} --branch release/x`, `${program} --branch fvs`, program, `${program} --help`, `${program} --force --branch fvs/x`,
      'node /elsewhere/fvs-auto-push.mjs --branch fvs/x', 'node fvs-auto-push.mjs --branch fvs/x', `node ${PLACEHOLDER_DIR}/fvs-auto.mjs --branch fvs/x`,
    ]) assert.ok(!matches(command), command);
    // Said plainly: a rule is a text match, so words after the branch name still match it. The command refuses them.
    assert.ok(matches(`${program} --branch fvs/work --force`));
    assert.equal(lib.GUARDS, undefined, 'FVS writes no deny rules either');
  });

  it('every rule the catalog writes passes the rule check, and forbidden rules never do', () => {
    const catalog = lib.buildCatalog({ repo: REPO, scriptsDir: PLACEHOLDER_DIR });
    for (const step of catalog.steps) for (const rule of step.claude) assert.equal(lib.ruleProblem('allow', rule), null, rule);
    for (const rule of [
      'Bash(gh pr comment *)', 'Bash(gh pr review *)', 'Bash(gh pr merge *)', 'Bash(gh pr ready *)', 'Bash(gh api *)', 'Bash(gh issue comment *)',
      // A glob never allows a git push, in any spelling: the only push rule names the push command.
      'Bash(git push *)', 'Bash(git push --force origin fvs/*)', 'Bash(git push origin main)', 'Bash(git push origin main*)', 'Bash(git push upstream fvs/*)',
      'Bash(git push origin */*)', 'Bash(git push -u upstream fvs/*)', 'Bash(git push origin release/*)', 'Bash(git push origin fvs/*)', 'Bash(git push -u origin fvs/*)',
      'Bash(git -C * push origin fvs/*)', 'Bash(git * push *)', 'Bash(git *)', 'Bash(gh *)', 'Bash(*)', 'Bash(rm *)',
      'Bash(ao stop *)', 'Bash(ao pr merge *)', 'Edit(/.claude/**)', 'Edit(/.git/**)', 'Edit(/../**)', 'Edit(/**)', 'Read(/**)', 'WebFetch',
      // Not rules FVS writes: the spec and proof folders, and draft pull request create and edit, are left to the user.
      'Edit(/formal/**)', 'Bash(gh pr edit *)', `Bash(gh pr create --draft --repo ${REPO} *)`,
    ]) assert.ok(lib.ruleProblem('allow', rule), `should refuse ${rule}`);
    const program = `node ${PLACEHOLDER_DIR}/fvs-auto-push.mjs`;
    for (const rule of [
      `Bash(${program} --branch main/*)`, `Bash(${program} --branch release/*)`, `Bash(${program} --branch fvs/x)`, `Bash(${program} --branch *)`, `Bash(${program} *)`, `Bash(${program})`,
      `Bash(${program} --branch fvs/* --force)`, `Bash(${program} --branch fvs/**)`, `Bash(${program} --branch fvs/* && git push)`, 'Bash(node * fvs-auto-push.mjs --branch fvs/*)',
      'Bash(node /a b/fvs-auto-push.mjs --branch fvs/*)', 'Bash(node /a/../fvs-auto-push.mjs --branch fvs/*)', 'Bash(node fvs-auto-push.mjs --branch fvs/*)',
      `Bash(sh ${PLACEHOLDER_DIR}/fvs-auto-push.mjs --branch fvs/*)`, 'Bash(node "/a/fvs-auto-push.mjs" --branch fvs/*)', `Bash(node ${PLACEHOLDER_DIR}/fvs-auto-push.mjs --branch fvs/.*)`,
    ]) assert.ok(lib.ruleProblem('allow', rule), `should refuse ${rule}`);
    assert.equal(lib.ruleProblem('allow', `Bash(${program} --branch fvs/*)`), null);
    assert.equal(lib.ruleProblem('allow', `Bash(${program} --branch team/runs/*)`), null);
    for (const text of ['Bash(gh pr comment *)', 'Bash(git push *--force*)', 'Bash(git push *:*)', `Bash(${program} --branch fvs/*)`]) assert.ok(lib.ruleProblem('deny', text), 'FVS writes no deny rule');
    assert.ok(lib.ruleProblem('ask', 'Bash(ao send *)'));
  });

  it('refuses inputs that could widen a push rule', () => {
    for (const bad of ['main', 'master', '*', 'fvs/*', 'a:b', '..', 'a/../b', '-f', '+x', '', 'release/3.0.0-rc2', 'HEAD', 'a b']) {
      assert.throws(() => lib.buildCatalog({ repo: REPO, prefixes: [bad] }), (error) => error.code === 'invalid-input', bad);
    }
    assert.throws(() => lib.buildCatalog({ repo: REPO, remote: 'upstream' }), (error) => error.code === 'upstream-refused');
    assert.throws(() => lib.buildCatalog({ repo: 'not-a-repo' }), (error) => error.code === 'invalid-input');
  });

  it('names no rule when the scripts folder is not a plain path, and says why', () => {
    for (const dir of ['/a b', '/a"b', '/a$b', '/a*b', '/a`b', '/a\\b', 'relative/dir', '/a/../b', "/a'b", '/a;b', '/é', '/a(b)', '']) {
      const push = lib.buildCatalog({ repo: REPO, scriptsDir: dir }).steps.find((s) => s.id === 'git-push');
      assert.deepEqual([push.claude, push.codex], [[], []], JSON.stringify(dir));
      assert.match(push.blocked, /not a plain path.*the push command still works, and your other rules and permission mode decide whether it asks/, JSON.stringify(dir));
      assert.equal(push.claudeNote, push.blocked);
      const entry = lib.probeEntry(push, null);
      assert.equal(entry.probes, null);
      assert.match(entry.skipped, /^not probed: the FVS scripts folder .*not a plain path.*; record it as unknown$/);
    }
    const fine = lib.buildCatalog({ repo: REPO, scriptsDir: PLACEHOLDER_DIR }).steps.find((s) => s.id === 'git-push');
    assert.equal(fine.blocked, undefined);
    assert.equal(lib.probeEntry(fine, null).probes.length, 1);
  });
});

describe('plan', () => {
  it('lists the probes and refuses a remote that is not the project repository', () => {
    const ok = run('plan', base());
    assert.equal(ok.status, 0);
    assert.deepEqual(ok.json.steps.map((s) => s.id), ['worker-message', 'author-edit', 'lake-build', 'gh-read', 'git-read', 'git-push']);
    assert.equal(ok.json.record.present, false);
    assert.equal(ok.json.pushCommand, `${PROGRAM} --branch fvs/<name>`);
    assert.equal(ok.json.pushDestination.status, 'missing');
    assert.equal(ok.json.pushDestination.file, recordFile());
    assert.equal(ok.json.pushDestination.wouldRecord.url, `git@github.com:${REPO}.git`);
    const wrong = run('plan', ['--project-root', project, '--repo', 'Other/repo']);
    assert.equal(wrong.status, 1);
    assert.equal(wrong.json.code, 'remote-mismatch');
    const noRemote = run('plan', base('--remote', 'fork'));
    assert.equal(noRemote.json.code, 'remote-missing');
  });

  it('skips the Lake probe while Lake would download a dependency or create a manifest', () => {
    const lakeStep = () => run('plan', base()).json.steps.find((step) => step.id === 'lake-build');
    assert.match(lakeStep().skipped, /no lakefile/);
    fs.writeFileSync(path.join(project, 'lakefile.toml'), 'name = "p"\n');
    assert.match(lakeStep().skipped, /no lake-manifest\.json/);
    fs.writeFileSync(path.join(project, 'lake-manifest.json'), JSON.stringify({ version: '1.1.0', packagesDir: '.lake/packages', packages: [{ name: 'batteries', type: 'git' }, { name: 'local', type: 'path' }] }));
    assert.match(lakeStep().skipped, /would download batteries/);
    assert.equal(lakeStep().probes, null);
    fs.writeFileSync(path.join(project, 'lake-manifest.json'), '{ nope');
    assert.match(lakeStep().skipped, /not valid JSON/);
    fs.writeFileSync(path.join(project, 'lake-manifest.json'), JSON.stringify({ packagesDir: '.lake/packages', packages: [{ name: 'batteries', type: 'git' }] }));
    fs.mkdirSync(path.join(project, '.lake', 'packages', 'batteries'), { recursive: true });
    assert.equal(lakeStep().skipped, undefined);
    assert.match(lakeStep().probes[0].command, /^lake env lean /);
  });

  it('a skipped step can be recorded as unknown, and an all-unknown record reads as skipped by the owner', () => {
    const file = path.join(project, 'answer.json');
    fs.writeFileSync(file, JSON.stringify({ runtime: 'claude', kind: 'check', results: { 'lake-build': 'unknown', 'git-push': 'unknown' } }));
    const done = run('record', base('--input', file));
    assert.equal(done.json.code, 'recorded');
    assert.match(done.json.summary, /skipped by the owner, nothing was checked/);
    assert.doesNotMatch(done.json.summary, /waiting for your approval/);
  });

  it('refuses a push URL that differs from the fetch URL', () => {
    spawnSync('git', ['-C', project, 'remote', 'set-url', '--push', 'origin', 'git@github.com:Upstream/proj.git']);
    const refused = run('plan', base());
    assert.equal(refused.json.code, 'remote-mismatch');
  });

  it('accepts https and ssh forms of the repository URL', () => {
    for (const url of [`https://github.com/${REPO}.git`, `https://github.com/${REPO}`, `ssh://git@github.com/${REPO}.git`]) {
      spawnSync('git', ['-C', project, 'remote', 'set-url', 'origin', url]);
      assert.equal(run('plan', base()).json.code, 'ok', url);
    }
  });
});

describe('the remote check', () => {
  const config = (...args) => assert.equal(spawnSync('git', ['-C', project, 'config', ...args], { encoding: 'utf8' }).status, 0, args.join(' '));
  const mine = `git@github.com:${REPO}.git`;
  const plan = (...extra) => run('plan', base(...extra)).json;

  it('refuses when a later push URL names another repository, in every command', () => {
    config('--add', 'remote.origin.pushurl', mine);
    config('--add', 'remote.origin.pushurl', 'git@github.com:Upstream/proj.git');
    const refused = plan();
    assert.equal(refused.code, 'remote-mismatch');
    assert.match(refused.message, /push URL git@github\.com:Upstream\/proj\.git/);
    assert.equal(allow('worker-message').json.code, 'remote-mismatch');
    const file = path.join(project, 'answer.json');
    fs.writeFileSync(file, JSON.stringify({ runtime: 'claude', kind: 'check', results: { 'git-push': 'quiet' } }));
    assert.equal(run('record', base('--input', file)).json.code, 'remote-mismatch');
    assert.equal(fs.existsSync(path.join(project, '.formalising')), false, 'nothing is recorded');
  });

  it('refuses when a later fallback URL names another repository, and when the first one does', () => {
    config('--add', 'remote.origin.url', 'https://github.com/Upstream/proj.git');
    assert.match(plan().message, /fetch URL https:\/\/github\.com\/Upstream\/proj\.git/);
    config('--unset-all', 'remote.origin.url');
    config('--add', 'remote.origin.url', 'https://github.com/Upstream/proj.git');
    config('--add', 'remote.origin.url', mine);
    assert.equal(plan().code, 'remote-mismatch');
  });

  it('refuses several fallback URLs when only one of them is wrong, and accepts them when all name the repository', () => {
    config('--unset-all', 'remote.origin.url');
    for (const url of [mine, `https://github.com/${REPO}`, `ssh://git@github.com:22/${REPO}.git`]) config('--add', 'remote.origin.url', url);
    config('--add', 'remote.origin.pushurl', mine);
    config('--add', 'remote.origin.pushurl', `https://github.com/${REPO.toLowerCase()}.git`);
    assert.equal(plan().code, 'ok');
    config('--add', 'remote.origin.url', 'git@github.com:Elsewhere/proj.git');
    assert.equal(plan().code, 'remote-mismatch');
  });

  it('refuses the same path on a different host, and takes another host only from --host', () => {
    for (const url of ['git@gitlab.com:Acme/proj.git', 'https://github.example.com/Acme/proj', 'ssh://git@github.com.evil.test/Acme/proj.git']) {
      config('remote.origin.url', url);
      const refused = plan();
      assert.equal(refused.code, 'remote-mismatch', url);
      assert.match(refused.message, /not github\.com\/Acme\/proj/);
    }
    config('remote.origin.url', 'https://github.example.com/Acme/proj');
    assert.equal(plan('--host', 'github.example.com').code, 'ok');
    assert.equal(plan('--host', 'GitHub.Example.com').code, 'ok', 'host names compare without case');
    assert.equal(plan('--host', 'not a host').code, 'invalid-input');
  });

  it('refuses a URL that does not name exactly one repository', () => {
    for (const url of ['/srv/git/proj.git', 'file:///srv/git/Acme/proj', '../proj', 'git@github.com:Acme/sub/proj.git', 'git@github.com:proj.git', 'https://github.com/Acme/proj/extra', 'C:\\repos\\proj']) {
      config('remote.origin.url', url);
      assert.equal(plan().code, 'remote-ambiguous', url);
    }
    config('remote.origin.url', mine);
    config('--add', 'remote.origin.pushurl', '/srv/git/proj.git');
    assert.equal(plan().code, 'remote-ambiguous');
  });

  it('checks the URL git uses after its own rewriting', () => {
    config('url.git@github.com:Upstream/.insteadOf', 'git@github.com:Acme/');
    const refused = plan();
    assert.equal(refused.code, 'remote-mismatch');
    assert.match(refused.message, /Upstream\/proj/);
  });

  it('records the push URL after git has rewritten it, and refuses a rule that would rewrite that URL again', () => {
    config('remote.origin.url', `https://github.com/${REPO}.git`);
    config('url.ssh://git@github.com/.pushInsteadOf', 'https://github.com/');
    const planned = plan();
    assert.equal(planned.code, 'ok');
    assert.equal(planned.pushDestination.wouldRecord.url, `ssh://git@github.com/${REPO}.git`, 'the URL that git pushes to');
    config('--unset', 'url.ssh://git@github.com/.pushInsteadOf');
    // "gh:" stands for the project's SSH address; a second rule that names that address would rewrite it once more.
    config('remote.origin.url', 'gh:proj');
    config('url.git@github.com:Acme/.insteadOf', 'gh:');
    assert.equal(plan().code, 'ok');
    assert.equal(plan().pushDestination.wouldRecord.url, 'git@github.com:Acme/proj');
    for (const key of ['insteadOf', 'pushInsteadOf']) {
      config(`url.git@github.com:Other/.${key}`, 'git@github.com:Acme/');
      const refused = plan();
      assert.equal(refused.code, 'destination-rewritten', key);
      assert.match(refused.message, /would rewrite the recorded destination git@github\.com:Acme\/proj/);
      assert.equal(destination().json.code, 'destination-rewritten', 'the destination is not recorded either');
      config('--unset', `url.git@github.com:Other/.${key}`);
    }
    assert.equal(fs.existsSync(recordFile()), false);
  });

  it('reads host and repository from the URL forms git accepts', () => {
    const cases = {
      'git@github.com:Acme/proj.git': ['github.com', 'Acme/proj'], 'github.com:Acme/proj': ['github.com', 'Acme/proj'],
      'https://github.com/Acme/proj/': ['github.com', 'Acme/proj'], 'https://user:tok@GitHub.com:443/Acme/proj.git': ['github.com', 'Acme/proj'],
      'ssh://git@github.com:22/Acme/proj.git': ['github.com', 'Acme/proj'], 'git://github.com/Acme/proj.git': ['github.com', 'Acme/proj'],
    };
    for (const [url, [host, repo]] of Object.entries(cases)) assert.deepEqual(lib.parseRemoteUrl(url), { host, repo }, url);
    for (const url of ['', '/srv/proj.git', 'file:///a/b', 'git@github.com:a', 'https://github.com/a/b/c', 'https://github.com/']) assert.equal(lib.parseRemoteUrl(url), null, url);
  });
});

describe('write-allowlist for Claude Code', () => {
  it('refuses without confirmation and writes nothing', () => {
    const none = allow('gh-read');
    assert.equal(none.status, 1);
    assert.equal(none.json.code, 'confirmation-required');
    assert.deepEqual(none.json.add.allow, ['Bash(gh pr view *)', 'Bash(gh pr list *)']);
    assert.equal(none.json.add.deny, undefined, 'FVS writes no deny rules');
    assert.equal(fs.existsSync(settingsFile()), false);
    const wrong = allow('gh-read', '--confirm', 'yes');
    assert.equal(wrong.json.code, 'confirmation-required');
    assert.equal(fs.existsSync(settingsFile()), false);
  });

  it('a digest confirmed for one rule set is refused for another', () => {
    const preview = allow('gh-read');
    const other = allow('worker-message', '--confirm', preview.json.digest);
    assert.equal(other.json.code, 'confirmation-required');
    assert.equal(fs.existsSync(settingsFile()), false);
  });

  it('merges into an existing file and keeps every other key, rule and the key order', () => {
    const original = {
      $schema: 'https://json.schemastore.org/claude-code-settings.json',
      model: 'example-model',
      permissions: { allow: ['Bash(npm run lint)', 'Bash(ao session get *)'], ask: ['Bash(gh pr edit *)'], defaultMode: 'default' },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }] },
      env: { A: '1' },
    };
    writeSettings(original);
    const done = confirmed('worker-message,gh-read');
    assert.equal(done.json.code, 'written');
    const after = readSettings();
    assert.deepEqual(Object.keys(after), Object.keys(original));
    for (const key of ['$schema', 'model', 'hooks', 'env']) assert.deepEqual(after[key], original[key]);
    assert.deepEqual(after.permissions.ask, original.permissions.ask);
    assert.equal(after.permissions.defaultMode, 'default');
    assert.deepEqual(after.permissions.allow, [...original.permissions.allow, 'Bash(ao send *)', 'Bash(gh pr view *)', 'Bash(gh pr list *)']);
    assert.equal(after.permissions.deny, undefined, 'FVS writes no deny rules');
    assert.ok(fs.readFileSync(settingsFile(), 'utf8').endsWith('}\n'));
  });

  it('keeps a deny rule the user already had, and is a no-op the second time', () => {
    writeSettings({ permissions: { deny: ['Bash(git push *--force*)'] } });
    const done = confirmed('git-read');
    assert.equal(done.json.code, 'written');
    const written = readSettings();
    assert.deepEqual(written.permissions.allow, ['Bash(git fetch *)', 'Bash(git ls-remote *)']);
    assert.deepEqual(written.permissions.deny, ['Bash(git push *--force*)']);
    const before = fs.readFileSync(settingsFile(), 'utf8');
    const again = allow('git-read');
    assert.equal(again.json.code, 'unchanged');
    assert.equal(fs.readFileSync(settingsFile(), 'utf8'), before);
  });

});

// The helper's own git calls (where a settings file stands in git, and whether this is the main checkout) run with the
// same cleaned environment and the repository identity that the push command uses. An inherited GIT_DIR must not decide them.
describe('the helper\'s own git calls', () => {
  const identity = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const gitIn = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: withGitHome({ ...process.env, ...identity }) });
  const linked = () => {
    assert.equal(gitIn(project, 'commit', '--allow-empty', '-q', '-m', 'one').status, 0);
    const worktree = path.join(path.dirname(project), `${path.basename(project)}-linked`);
    assert.equal(gitIn(project, 'worktree', 'add', '-q', '-b', 'linked', worktree).status, 0);
    return fs.realpathSync(worktree);
  };
  const local = (root, env) => run('write-allowlist', ['--project-root', root, '--repo', REPO, '--runtime', 'claude', '--steps', 'worker-message', '--target', 'local'], env);
  const otherRepository = () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-perm-other-'));
    assert.equal(gitIn(other, 'init', '-q').status, 0);
    return other;
  };

  it('refuses the local settings file in a linked worktree, with or without an inherited GIT_DIR', () => {
    const worktree = linked();
    assert.equal(local(worktree).json.code, 'local-needs-main-checkout');
    const inherited = { ...process.env, GIT_DIR: path.join(fs.realpathSync(project), '.git') };
    // The row bites: with GIT_DIR set, plain git gives the same answer to both questions in the worktree, which is what
    // let the earlier check treat the worktree as the main checkout.
    const asked = (flag) => spawnSync('git', ['-C', worktree, 'rev-parse', '--path-format=absolute', flag], { encoding: 'utf8', env: withGitHome(inherited) }).stdout.trim();
    assert.equal(asked('--git-dir'), asked('--git-common-dir'), 'an inherited GIT_DIR makes the worktree look like the main checkout');
    const out = local(worktree, inherited);
    assert.equal(out.status, 1, JSON.stringify(out.json));
    assert.equal(out.json.code, 'local-needs-main-checkout');
    assert.equal(fs.existsSync(path.join(worktree, '.claude', 'settings.local.json')), false, 'nothing was written in the worktree');
  });

  it('still accepts the main checkout when an inherited GIT_DIR names another repository', () => {
    const other = otherRepository();
    const out = local(fs.realpathSync(project), { ...process.env, GIT_DIR: path.join(other, '.git') });
    assert.equal(out.json.code, 'confirmation-required', JSON.stringify(out.json));
    fs.rmSync(other, { recursive: true, force: true });
  });

  it('reports where the settings file stands in the project\'s own repository when GIT_DIR names another one', () => {
    const other = otherRepository();
    fs.appendFileSync(path.join(other, '.git', 'info', 'exclude'), '.claude/settings.json\n');
    const inherited = { ...process.env, GIT_DIR: path.join(other, '.git') };
    const plain = spawnSync('git', ['-C', project, 'check-ignore', '-q', '.claude/settings.json'], { env: withGitHome(inherited) });
    assert.equal(plain.status, 0, 'the row bites: with GIT_DIR set, plain git reads the other repository\'s exclude file');
    const preview = run('write-allowlist', base('--runtime', 'claude', '--steps', 'worker-message'), inherited);
    assert.equal(preview.json.code, 'confirmation-required', JSON.stringify(preview.json));
    assert.equal(preview.json.gitStatus, 'untracked-not-ignored');
    fs.rmSync(other, { recursive: true, force: true });
  });

  it('answers "unknown" and never throws when the repository was not identified, and refuses the local file then', () => {
    assert.equal(lib.gitStatusOf(null, project, '.claude/settings.json'), 'unknown');
    assert.throws(() => lib.checkMainCheckout(project, null), (error) => error.code === 'local-needs-main-checkout' && /could not be identified/.test(error.message));
  });
});

describe('the recorded destination', () => {
  it('shows what it records and writes nothing before the yes', () => {
    const preview = destination();
    assert.equal(preview.status, 1);
    assert.equal(preview.json.code, 'confirmation-required');
    const root = fs.realpathSync(project);
    assert.equal(preview.json.file, recordFile());
    assert.deepEqual(preview.json.record, {
      schema: 'fvs/auto-push-destination', schemaVersion: 1, projectRoot: root, commonDir: path.join(root, '.git'),
      url: `git@github.com:${REPO}.git`, host: 'github.com', repo: REPO, prefixes: ['fvs'],
    });
    assert.match(preview.json.note, /any session of your user account can change it, and so change where the command pushes/);
    assert.doesNotMatch(preview.json.note, /pushes only/);
    assert.deepEqual(preview.json.contract, pushLib.CONTRACT);
    assert.equal(fs.existsSync(recordFile()), false);
    assert.equal(destination('--confirm', 'anything').json.code, 'confirmation-required');
    assert.equal(fs.existsSync(recordFile()), false);
  });

  it('writes the record after the yes, and a second run changes nothing', () => {
    const done = recordDestination();
    assert.deepEqual(JSON.parse(fs.readFileSync(recordFile(), 'utf8')), done.record);
    const before = fs.readFileSync(recordFile(), 'utf8');
    const again = destination();
    assert.equal(again.status, 0);
    assert.equal(again.json.code, 'unchanged');
    assert.equal(fs.readFileSync(recordFile(), 'utf8'), before);
    assert.deepEqual(fs.readdirSync(path.join(project, '.git')).filter((name) => name.includes('.tmp-')), [], 'no temporary file is left');
    assert.equal(pushLib.recordProblem(JSON.parse(before)), null, 'the push command accepts what was written');
  });

  it('records every namespace, the host and the URL that were given', () => {
    spawnSync('git', ['-C', project, 'remote', 'set-url', 'origin', `https://git.example.com/${REPO}.git`]);
    const done = recordDestination('--branch-prefix', 'fvs', '--branch-prefix', 'team/runs', '--host', 'git.example.com');
    assert.equal(done.record.host, 'git.example.com');
    assert.deepEqual(done.record.prefixes, ['fvs', 'team/runs']);
    assert.equal(done.record.url, `https://git.example.com/${REPO}.git`);
  });

  it('does not replace a record for another destination, and says how to resolve it', () => {
    recordDestination();
    spawnSync('git', ['-C', project, 'remote', 'set-url', 'origin', `https://github.com/${REPO}.git`]);
    const before = fs.readFileSync(recordFile(), 'utf8');
    for (const extra of [[], ['--confirm', 'anything']]) {
      const refused = destination(...extra);
      assert.equal(refused.status, 1);
      assert.equal(refused.json.code, 'destination-conflict');
      assert.match(refused.json.message, /never replaces it.*delete it yourself/);
      assert.equal(refused.json.existing.url, `git@github.com:${REPO}.git`);
      assert.equal(refused.json.record.url, `https://github.com/${REPO}.git`);
    }
    assert.equal(fs.readFileSync(recordFile(), 'utf8'), before);
    fs.writeFileSync(recordFile(), '{ not json');
    const unreadable = destination();
    assert.equal(unreadable.json.code, 'destination-conflict');
    assert.ok(unreadable.json.problem);
    assert.equal(fs.readFileSync(recordFile(), 'utf8'), '{ not json');
  });

  // The git configuration variables that are set when the user confirms the destination are shown by name with the length of their values, and
  // the names are what the user trusts: the record keeps each name with a hash of its value then, and no value. A value that
  // rotates later changes nothing. Another set of names is a replace of the record, which needs its own yes.
  describe('git configuration variables that are set', () => {
    const NOTE = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'fvs.note', GIT_CONFIG_VALUE_0: 'note-value-1' };
    const ROTATED = { ...NOTE, GIT_CONFIG_VALUE_0: 'note-value-2' };
    const MORE = { ...NOTE, GIT_CONFIG_NOSYSTEM: '1' };
    const dest = (variables, ...extra) => run('write-destination', base(...extra), { ...process.env, ...variables });
    const record = (variables) => {
      const preview = dest(variables);
      assert.equal(preview.json.code, 'confirmation-required');
      assert.equal(dest(variables, '--confirm', preview.json.digest).json.code, 'written');
    };
    const onDisk = () => JSON.parse(fs.readFileSync(recordFile(), 'utf8'));
    const shows = (json, text) => JSON.stringify(json).includes(text);
    // The preview names each variable and gives the length of its value, never the value: a value can be a token.
    const LENGTHS = { GIT_CONFIG_COUNT: { length: 1 }, GIT_CONFIG_KEY_0: { length: 8 }, GIT_CONFIG_VALUE_0: { length: 12 } };

    it('shows each name with the length of its value and never the value, records a hash, and binds the names and hashes to the digest', () => {
      const preview = dest(NOTE);
      assert.equal(preview.json.code, 'confirmation-required');
      assert.deepEqual(preview.json.gitConfigVariables, LENGTHS, 'the user sees every name that is about to be trusted, and how long its value is');
      for (const value of ['note-value-1', 'fvs.note']) assert.ok(!shows(preview.json, value), `the preview does not hold the value ${value}`);
      assert.match(preview.json.gitConfigNote, /only the length of each value/);
      assert.deepEqual(Object.keys(preview.json.record.trustedGitVariables), ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']);
      assert.match(preview.json.gitConfigNote, /Your yes trusts these names/);
      assert.match(preview.json.gitConfigNote, /keeps each trusted name with whatever value it has when it runs/);
      assert.match(preview.json.gitConfigNote, /GIT_CONFIG_COUNT and the GIT_CONFIG_KEY_n and GIT_CONFIG_VALUE_n pairs that it addresses are one unit/);
      assert.match(preview.json.gitConfigNote, /A variable that is not set when you confirm stays untrusted/);
      assert.match(preview.json.gitConfigNote, /the way you trust your own git configuration files/);
      assert.match(preview.json.gitConfigNote, /a hash of each value, not the value/);
      // A yes is for these names and these values: another value, or no variable, is another digest.
      assert.notEqual(dest(ROTATED).json.digest, preview.json.digest);
      assert.notEqual(dest({}).json.digest, preview.json.digest);
      assert.equal(dest(ROTATED, '--confirm', preview.json.digest).json.code, 'confirmation-required');
      assert.equal(dest({}, '--confirm', preview.json.digest).json.code, 'confirmation-required');
      assert.equal(fs.existsSync(recordFile()), false);
      const written = dest(NOTE, '--confirm', preview.json.digest);
      assert.equal(written.json.code, 'written');
      assert.ok(!shows(written.json, 'note-value-1'), 'no value is printed, not in the preview and not in the result of the write');
      const text = fs.readFileSync(recordFile(), 'utf8');
      assert.ok(!text.includes('note-value-1'), 'the file holds no value either');
      assert.deepEqual(onDisk().trustedGitVariables, preview.json.record.trustedGitVariables);
      assert.equal(pushLib.recordProblem(onDisk()), null, 'the push command accepts what was written');
      const again = dest(NOTE);
      assert.equal(again.json.code, 'unchanged');
      assert.ok(!shows(again.json, 'note-value-1'), 'nor in the answer for a record that is already there');
      assert.equal(again.json.gitConfigVariables, undefined);
    });

    it('the numbered pairs are the count\'s: a pair that the count does not address is not offered, and a count that grew is no difference', () => {
      const stray = dest({ GIT_CONFIG_KEY_0: 'stray', GIT_CONFIG_VALUE_0: 'stray-value' });
      assert.deepEqual(stray.json.gitConfigVariables, {}, 'a pair without its count is not offered');
      assert.ok(!('trustedGitVariables' in stray.json.record));
      const beyond = dest({ ...NOTE, GIT_CONFIG_KEY_1: 'beyond', GIT_CONFIG_VALUE_1: 'beyond-value' });
      assert.deepEqual(Object.keys(beyond.json.gitConfigVariables), ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'], 'a pair beyond the count is not offered');
      record(NOTE);
      const before = fs.readFileSync(recordFile(), 'utf8');
      const grown = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'fvs.note', GIT_CONFIG_VALUE_0: 'note-value-1', GIT_CONFIG_KEY_1: 'fvs.more', GIT_CONFIG_VALUE_1: 'more-value' };
      assert.equal(dest(grown).json.code, 'unchanged', 'the same unit: the count is trusted, its pairs follow it');
      assert.equal(fs.readFileSync(recordFile(), 'utf8'), before);
      assert.equal(run('plan', base(), { ...process.env, ...grown }).json.pushDestination.status, 'matches');
    });

    it('says that none is set when none is, and the record keeps its usual shape', () => {
      const preview = dest({});
      assert.deepEqual(preview.json.gitConfigVariables, {});
      assert.match(preview.json.gitConfigNote, /No git configuration variable is set in this session/);
      assert.match(preview.json.gitConfigNote, /runs without all of them/);
      assert.ok(!('trustedGitVariables' in preview.json.record));
    });

    it('a value that rotated since init changes nothing: the record still matches, nothing is written, and the allowlist goes on', { skip: pushSkip }, () => {
      record(NOTE);
      const before = fs.readFileSync(recordFile(), 'utf8');
      const again = dest(ROTATED);
      assert.equal(again.json.code, 'unchanged');
      assert.ok(!shows(again.json, 'note-value'), 'no value is printed');
      assert.equal(fs.readFileSync(recordFile(), 'utf8'), before, 'nothing is written');
      assert.equal(run('plan', base(), { ...process.env, ...ROTATED }).json.pushDestination.status, 'matches');
      const preview = run('write-allowlist', base('--runtime', 'claude', '--steps', 'git-push'), { ...process.env, ...ROTATED });
      assert.equal(preview.json.code, 'confirmation-required', 'the push rule is not held back by a rotated value');
      assert.deepEqual(preview.json.push.destination.trustedGitVariables, onDisk().trustedGitVariables, 'it shows the record that is on disk');
      assert.ok(!shows(preview.json, 'note-value'));
    });

    it('other names are a replace: the preview shows the old and the new set, and only the yes rewrites the record', () => {
      record(NOTE);
      const before = fs.readFileSync(recordFile(), 'utf8');
      const preview = dest(MORE);
      assert.equal(preview.json.code, 'confirmation-required', 'not a conflict: the destination is the same');
      assert.deepEqual(preview.json.replaces, onDisk(), 'the record that would be replaced');
      assert.deepEqual(preview.json.record.trustedGitVariables && Object.keys(preview.json.record.trustedGitVariables), ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_VALUE_0'], 'the record it would write');
      assert.deepEqual(preview.json.variableChanges, { added: ['GIT_CONFIG_NOSYSTEM'], removed: [], kept: ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'] });
      assert.deepEqual(preview.json.gitConfigVariables, { ...LENGTHS, GIT_CONFIG_NOSYSTEM: { length: 1 } }, 'the names of the new set, with the length of each value');
      assert.ok(!shows(preview.json, 'note-value-1') && !shows(preview.json, 'fvs.note'), 'no value, in the old record, the new record or the notes');
      assert.match(preview.json.replaceNote, /holds another set of trusted git variables/);
      assert.match(preview.json.replaceNote, /the destination stays the same/);
      assert.equal(fs.readFileSync(recordFile(), 'utf8'), before, 'nothing is written before the yes');
      assert.equal(dest(MORE, '--confirm', 'anything').json.code, 'confirmation-required');
      assert.equal(fs.readFileSync(recordFile(), 'utf8'), before);
      const done = dest(MORE, '--confirm', preview.json.digest);
      assert.equal(done.json.code, 'replaced');
      assert.ok(!shows(done.json, 'note-value') && !shows(done.json, '"1"'), 'the result prints no value');
      assert.deepEqual(onDisk().trustedGitVariables && Object.keys(onDisk().trustedGitVariables), ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_VALUE_0']);
      assert.equal(pushLib.recordProblem(onDisk()), null);
      assert.deepEqual(fs.readdirSync(path.join(project, '.git')).filter((name) => name.includes('.tmp-')), [], 'no temporary file is left');
      assert.equal(dest(MORE).json.code, 'unchanged');
    });

    it('trusting fewer names is a replace too, down to none, which gives the record its usual shape', () => {
      record(MORE);
      const preview = dest(NOTE);
      assert.deepEqual(preview.json.variableChanges, { added: [], removed: ['GIT_CONFIG_NOSYSTEM'], kept: ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'] });
      assert.equal(dest(NOTE, '--confirm', preview.json.digest).json.code, 'replaced');
      const none = dest({});
      assert.deepEqual(none.json.variableChanges, { added: [], removed: ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'], kept: [] });
      assert.equal(dest({}, '--confirm', none.json.digest).json.code, 'replaced');
      assert.ok(!('trustedGitVariables' in onDisk()));
      assert.equal(dest({}).json.code, 'unchanged');
    });

    it('the digest of a replace binds the record that is replaced: a record that changed after the preview needs a new yes', () => {
      record(NOTE);
      const preview = dest(MORE);
      const other = { ...NOTE, GIT_CONFIG_PARAMETERS: "'fvs.other=1'" };
      const rewritten = pushLib.destinationRecord({ ...onDisk(), variables: other });
      fs.writeFileSync(recordFile(), JSON.stringify(rewritten, null, 2) + '\n');
      const refused = dest(MORE, '--confirm', preview.json.digest);
      assert.equal(refused.json.code, 'confirmation-required', 'the old digest no longer fits');
      assert.deepEqual(onDisk(), rewritten, 'and nothing was written over it');
      const fresh = dest(MORE);
      assert.notEqual(fresh.json.digest, preview.json.digest);
      assert.deepEqual(fresh.json.replaces, rewritten);
      assert.equal(dest(MORE, '--confirm', fresh.json.digest).json.code, 'replaced');
    });

    it('another destination is still a conflict that is never replaced, whatever the variables are', () => {
      record(NOTE);
      spawnSync('git', ['-C', project, 'remote', 'set-url', 'origin', `https://github.com/${REPO}.git`]);
      const before = fs.readFileSync(recordFile(), 'utf8');
      for (const [variables, extra] of [[NOTE, []], [MORE, []], [MORE, ['--confirm', 'anything']]]) {
        const refused = dest(variables, ...extra);
        assert.equal(refused.json.code, 'destination-conflict');
        assert.match(refused.json.message, /never replaces it.*delete it yourself/);
        assert.equal(refused.json.replaces, undefined, 'no replace is offered');
      }
      assert.match(dest(MORE).json.message, /The git variables to trust differ \(GIT_CONFIG_NOSYSTEM\)/);
      assert.equal(fs.readFileSync(recordFile(), 'utf8'), before);
    });

    it('a record that cannot be read or is not valid is a conflict, not a replace', () => {
      record(NOTE);
      const good = onDisk();
      // JSON that is not an object (null, a list, a string) must be a conflict too, not a crash of the helper.
      for (const text of ['{ not json', JSON.stringify({ schema: 'something-else' }), 'null', '[]', '"x"', '7']) {
        fs.writeFileSync(recordFile(), text);
        const refused = dest(MORE);
        assert.equal(refused.json.code, 'destination-conflict', text);
        assert.equal(fs.readFileSync(recordFile(), 'utf8'), text);
        assert.ok(['differs', 'unreadable'].includes(run('plan', base(), { ...process.env, ...MORE }).json.pushDestination.status), text);
        assert.equal(run('write-allowlist', base('--runtime', 'claude', '--steps', 'git-push'), { ...process.env, ...MORE }).json.code, 'destination-not-recorded', text);
      }
      // A record with the right destination and a broken variable map is not replaced either.
      const broken = { ...good, trustedGitVariables: { GIT_CONFIG_COUNT: 'not-a-hash' } };
      fs.writeFileSync(recordFile(), JSON.stringify(broken));
      assert.equal(dest(MORE).json.code, 'destination-conflict');
    });

    it('a push selection in write-allowlist says which names differ from the record, and goes on when only a value differs', { skip: pushSkip }, () => {
      record(NOTE);
      const stale = run('write-allowlist', base('--runtime', 'claude', '--steps', 'git-push'), { ...process.env, ...MORE });
      assert.equal(stale.json.code, 'destination-not-recorded');
      assert.equal(stale.json.destination.status, 'differs');
      assert.match(stale.json.message, /the git variables to trust differ: GIT_CONFIG_NOSYSTEM/);
      assert.ok(!shows(stale.json, 'note-value'), 'no value');
      assert.equal(run('write-allowlist', base('--runtime', 'claude', '--steps', 'git-push'), { ...process.env, ...ROTATED }).json.code, 'confirmation-required');
    });

    it('plan reports the names that differ from an existing record, and a rotated value is no difference', () => {
      record(NOTE);
      const planned = run('plan', base(), { ...process.env, ...MORE }).json;
      assert.equal(planned.pushDestination.status, 'differs');
      assert.deepEqual(planned.pushDestination.changedVariables, ['GIT_CONFIG_NOSYSTEM']);
      assert.equal(run('plan', base(), { ...process.env, ...ROTATED }).json.pushDestination.status, 'matches');
      assert.equal(run('plan', base(), { ...process.env, ...NOTE }).json.pushDestination.status, 'matches');
    });
  });

  it('is written from a linked worktree into the shared git directory the main checkout uses', () => {
    const git = (...args) => assert.equal(spawnSync('git', ['-C', project, '-c', 'user.email=a@b', '-c', 'user.name=n', ...args], { encoding: 'utf8' }).status, 0, args.join(' '));
    git('commit', '-q', '--allow-empty', '-m', 'init');
    const linked = path.join(os.tmpdir(), `fvs-perm-dest-linked-${process.pid}-${Date.now()}`);
    git('worktree', 'add', '-q', linked, '-b', 'linked');
    const args = ['--project-root', linked, '--repo', REPO];
    const preview = run('write-destination', args).json;
    assert.equal(preview.file, recordFile());
    assert.equal(preview.record.projectRoot, fs.realpathSync(linked));
    assert.equal(run('write-destination', [...args, '--confirm', preview.digest]).json.code, 'written');
    assert.equal(fs.existsSync(path.join(linked, '.git', 'fvs-auto-push.json')), false);
    assert.equal(fs.existsSync(recordFile()), true);
  });

  it('a push selection in write-allowlist needs the record, for both runtimes, and an unchanged one', { skip: pushSkip }, () => {
    for (const runtime of ['claude', 'codex']) {
      const refused = run('write-allowlist', base('--runtime', runtime, '--steps', 'git-push'));
      assert.equal(refused.status, 1);
      assert.equal(refused.json.code, 'destination-not-recorded', runtime);
      assert.match(refused.json.message, /Run write-destination first/);
      assert.equal(refused.json.destination.status, 'missing');
    }
    assert.equal(fs.existsSync(path.join(project, '.claude')), false);
    assert.equal(fs.existsSync(path.join(project, '.codex')), false);
    assert.equal(allow('worker-message').json.code, 'confirmation-required', 'other steps do not need it');
    recordDestination();
    assert.equal(allow('git-push').json.code, 'confirmation-required');
    spawnSync('git', ['-C', project, 'remote', 'set-url', 'origin', `https://github.com/${REPO}.git`]);
    const stale = allow('git-push');
    assert.equal(stale.json.code, 'destination-not-recorded');
    assert.equal(stale.json.destination.status, 'differs');
  });
});

describe('the push command rule for Claude Code', { skip: pushSkip }, () => {
  beforeEach(() => { recordDestination(); });

  it('shows the exact rule, the command and the destination, and writes nothing before the yes', () => {
    const preview = allow('git-push');
    assert.equal(preview.status, 1);
    assert.equal(preview.json.code, 'confirmation-required');
    assert.deepEqual(preview.json.add, { allow: [RULE] });
    assert.equal(preview.json.push.command, `${PROGRAM} --branch fvs/<name>`);
    assert.equal(preview.json.push.destination.url, `git@github.com:${REPO}.git`);
    assert.equal(preview.json.push.destination.file, recordFile());
    assert.deepEqual(preview.json.push.destination.prefixes, ['fvs']);
    assert.equal(preview.json.hook, undefined, 'there is no hook');
    assert.deepEqual(preview.json.push.contract, pushLib.CONTRACT, 'the preview shows what the command is, checks, hardens and trusts');
    assert.doesNotMatch(JSON.stringify(preview.json), /fails safe|asks as usual/);
    assert.equal(fs.existsSync(path.join(project, '.claude')), false);
    assert.equal(allow('git-push', '--confirm', 'anything').json.code, 'confirmation-required');
    assert.equal(fs.existsSync(path.join(project, '.claude')), false);
  });

  it('the digest covers the rule and the destination', () => {
    const readDigest = allow('git-read').json.digest;
    assert.equal(allow('git-push', '--confirm', readDigest).json.code, 'confirmation-required');
    const pushDigest = allow('git-push').json.digest;
    const both = allow('git-read,git-push').json;
    assert.notEqual(both.digest, pushDigest);
    assert.equal(allow('git-read', '--confirm', both.digest).json.code, 'confirmation-required');
    // The same rule with another recorded destination is another confirmation.
    fs.rmSync(recordFile());
    spawnSync('git', ['-C', project, 'remote', 'set-url', 'origin', `https://github.com/${REPO}.git`]);
    recordDestination();
    assert.notEqual(allow('git-push').json.digest, pushDigest);
    assert.equal(allow('git-push', '--confirm', pushDigest).json.code, 'confirmation-required');
  });

  it('writes the rule after the yes, with no rule that names a git push and no deny rule', () => {
    const done = confirmed('git-push');
    assert.equal(done.json.code, 'written');
    assert.deepEqual(readSettings(), { permissions: { allow: [RULE] } });
    const notes = done.json.notes.join(' ');
    assert.match(notes, /Branch protection on the project fork is still recommended/);
    assert.match(notes, /A plain git push is not covered by this rule: your other rules and permission mode decide it, as before/);
    // The note carries the same contract the page prints: what the command checks, what it hardens, and what it trusts.
    assert.ok(notes.includes(pushLib.contractText()), 'the write note carries the contract text');
    assert.match(notes, /not a security boundary/);
    assert.match(notes, /The push is made with --no-verify, which skips the pre-push hook/);
    assert.match(notes, /Credential helpers\./);
    assert.match(notes, /a rule that is added or changed after the command checks and before it connects is not caught/);
    assert.doesNotMatch(notes, /still apply|pushes only|runs only in the repository|refuses anything else(?! on its command line)/);
    assert.match(done.json.verification, /Claude Code has no offline rule evaluator/);
    const before = fs.readFileSync(settingsFile(), 'utf8');
    assert.equal(allow('git-push').json.code, 'unchanged');
    assert.equal(fs.readFileSync(settingsFile(), 'utf8'), before, 'a second write changes nothing');
  });

  it('is not itself a git push rule, so the legacy check neither lists nor refuses it', () => {
    assert.equal(lib.namesPush(RULE), false);
    assert.equal(confirmed('git-push').json.code, 'written');
    assert.deepEqual(lib.legacyPushRules(fs.realpathSync(project)), []);
    assert.equal(run('plan', base()).json.legacyPushRules, undefined);
    assert.equal(allow('git-push').json.code, 'unchanged', 'a second write is not refused by the rule it wrote');
    assert.equal(confirmed('worker-message').json.code, 'written');
  });

  it('is still refused while a git push allow rule is there', () => {
    writeSettings({ permissions: { allow: ['Bash(git push origin fvs/*)'] } });
    assert.equal(allow('git-push').json.code, 'legacy-push-rules');
  });

  it('next to other steps it adds those steps\' rules too', () => {
    const done = confirmed('git-push,worker-message');
    assert.equal(done.json.code, 'written');
    assert.deepEqual(readSettings().permissions.allow, [RULE, 'Bash(ao send *)']);
  });

  it('appends the rule and keeps every other key, rule, hook and the key order', () => {
    const original = {
      $schema: 'https://json.schemastore.org/claude-code-settings.json',
      permissions: { allow: ['Bash(npm run lint)'], deny: ['Bash(git push *--force*)'], ask: ['Bash(gh pr edit *)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/home/me/.claude/hooks/ao-branch-gate.sh' }] }, { matcher: 'Edit', hooks: [{ type: 'command', command: 'lint' }] }],
        PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'log' }] }],
      },
      env: { A: '1' },
    };
    writeSettings(original);
    assert.equal(confirmed('git-push').json.code, 'written');
    const after = readSettings();
    assert.deepEqual(Object.keys(after), Object.keys(original));
    assert.deepEqual(after.hooks, original.hooks, 'no hook is added or changed');
    assert.deepEqual(after.permissions.allow, ['Bash(npm run lint)', RULE]);
    assert.deepEqual(after.permissions.deny, original.permissions.deny, 'the owner\'s own deny rule is kept');
    assert.deepEqual(after.permissions.ask, original.permissions.ask);
    assert.deepEqual(after.env, original.env);
  });

  it('works for the local file too', () => {
    const done = confirmed('git-push', '--target', 'local');
    assert.equal(done.json.code, 'written');
    assert.equal(done.json.file, '.claude/settings.local.json');
    assert.deepEqual(readSettings('settings.local.json'), { permissions: { allow: [RULE] } });
    assert.equal(fs.existsSync(settingsFile()), false);
  });

  it('names every namespace in its own rule', () => {
    fs.rmSync(recordFile());
    const prefixes = ['--branch-prefix', 'fvs', '--branch-prefix', 'team/runs'];
    recordDestination(...prefixes);
    const preview = allow('git-push', ...prefixes).json;
    assert.deepEqual(preview.add.allow, [RULE, `Bash(${PROGRAM} --branch team/runs/*)`]);
    assert.deepEqual(preview.push.destination.prefixes, ['fvs', 'team/runs']);
  });

  it('the probe runs as written and the command refuses it before it contacts anything', () => {
    const [probe] = lib.buildCatalog({ repo: REPO }).steps.find((s) => s.id === 'git-push').probes;
    assert.equal(probe.command, `${PROGRAM} --branch fvs/.permission-check`);
    const out = spawnSync('sh', ['-c', probe.command], { cwd: project, encoding: 'utf8' });
    assert.equal(out.status, 1);
    const json = JSON.parse(out.stdout);
    assert.equal(json.code, 'branch-refused');
    assert.match(json.message, /is not a plain branch name/);
    assert.equal(fs.existsSync(path.join(project, '.formalising', 'auto-fv', 'pushes.jsonl')), false, 'nothing was pushed or logged');
  });

  it('the summary counts the rule', () => {
    const file = path.join(project, 'answer.json');
    fs.writeFileSync(file, JSON.stringify({ runtime: 'claude', kind: 'check', results: { 'git-push': 'prompted' } }));
    assert.equal(run('record', base('--input', file)).json.code, 'recorded');
    assert.equal(confirmed('git-push').json.code, 'written');
    const summary = run('plan', base()).json.record.summary;
    assert.match(summary, /allowlist written to \.claude\/settings\.json \(1 allow\)/);
    assert.match(summary, /waiting for your approval when the run reaches: git-push/);
  });
});

describe('write-allowlist for Claude Code: files and targets', () => {

  it('refuses a file that is not valid JSON, or has the wrong shape, and leaves it untouched', () => {
    for (const text of ['{ "permissions": { "allow": [ ', '[]', '{ "permissions": { "allow": "Bash(ls)" } }', '{ "permissions": [] }', '// comment\n{}']) {
      writeSettings(text);
      const preview = allow('worker-message');
      assert.equal(preview.json.code, 'malformed-settings', text);
      assert.equal(fs.readFileSync(settingsFile(), 'utf8'), text);
    }
  });

  it('refuses unknown steps and forbidden inputs', () => {
    assert.equal(allow('gh-comment').json.code, 'unknown-step');
    assert.equal(allow('worker-message', '--branch-prefix', 'main').json.code, 'invalid-input');
    for (const dropped of ['edit-folders', 'draft-pr-create', 'draft-pr-edit']) assert.equal(allow(dropped).json.code, 'unknown-step', dropped);
    assert.equal(run('plan', base('--edit-dir', 'formal')).json.code, 'usage');
    assert.equal(run('write-allowlist', base('--runtime', 'claude', '--steps', '')).json.code, 'invalid-input');
    assert.equal(run('write-allowlist', base('--runtime', 'cursor', '--steps', 'git-push')).json.code, 'invalid-input');
    assert.equal(fs.existsSync(settingsFile()), false);
  });

  it('shows the resolved target, its git status and where it applies before anything is confirmed', () => {
    const shared = allow('worker-message').json;
    assert.equal(shared.target, 'shared');
    assert.equal(shared.file, '.claude/settings.json');
    assert.equal(shared.resolvedPath, path.join(fs.realpathSync(project), '.claude', 'settings.json'));
    assert.equal(shared.viaLink, false);
    assert.equal(shared.gitStatus, 'untracked-not-ignored');
    assert.match(shared.appliesTo, /once the folder is trusted.*worker worktree sees it only if the file is committed or \.claude is linked/);
    const local = allow('worker-message', '--target', 'local').json;
    assert.equal(local.target, 'local');
    assert.equal(local.file, '.claude/settings.local.json');
    assert.match(local.appliesTo, /main checkout in every worktree.*without the trust step/);
    assert.equal(fs.existsSync(settingsFile()), false);
    assert.equal(fs.existsSync(settingsFile('settings.local.json')), false);
  });

  it('writes through a linked .claude folder and says where the file really is', () => {
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-perm-shared-'));
    fs.symlinkSync(shared, path.join(project, '.claude'));
    const linkedPreview = allow('worker-message').json;
    assert.equal(linkedPreview.viaLink, true);
    assert.equal(linkedPreview.resolvedPath, path.join(fs.realpathSync(shared), 'settings.json'), 'the real path is shown before the write');
    // Git refuses a path beyond a symbolic link ("pathspec is beyond a symbolic link"), so it cannot say where the file stands.
    assert.equal(linkedPreview.gitStatus, 'unknown');
    const done = confirmed('worker-message');
    assert.equal(done.json.code, 'written');
    assert.equal(done.json.gitStatus, 'unknown');
    assert.equal(done.json.realPath, path.join(fs.realpathSync(shared), 'settings.json'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(shared, 'settings.json'), 'utf8')).permissions.allow, ['Bash(ao send *)']);
  });

  it('refuses the local file from a linked worktree, where Claude Code would not read it', () => {
    const git = (...args) => assert.equal(spawnSync('git', ['-C', project, '-c', 'user.email=a@b', '-c', 'user.name=n', ...args], { encoding: 'utf8' }).status, 0, args.join(' '));
    git('commit', '-q', '--allow-empty', '-m', 'init');
    const linked = path.join(os.tmpdir(), `fvs-perm-linked-${process.pid}-${Date.now()}`);
    git('worktree', 'add', '-q', linked, '-b', 'linked');
    const args = ['--project-root', linked, '--repo', REPO, '--runtime', 'claude', '--steps', 'worker-message', '--target', 'local'];
    const refused = run('write-allowlist', args);
    assert.equal(refused.json.code, 'local-needs-main-checkout');
    assert.equal(fs.existsSync(path.join(linked, '.claude')), false);
    const shared = run('write-allowlist', args.slice(0, -2));
    assert.equal(shared.json.code, 'confirmation-required', 'the shared file still works from a worktree');
  });

  it('reports whether the file is tracked, ignored or loose, and supports the local file', () => {
    const loose = confirmed('worker-message');
    assert.equal(loose.json.gitStatus, 'untracked-not-ignored');
    fs.writeFileSync(path.join(project, '.gitignore'), '.claude/settings.local.json\n');
    const local = confirmed('worker-message', '--target', 'local');
    assert.equal(local.json.file, '.claude/settings.local.json');
    assert.equal(local.json.gitStatus, 'ignored');
    assert.equal(spawnSync('git', ['-C', project, 'add', '-f', '.claude/settings.json']).status, 0);
    assert.equal(allow('gh-read').json.code, 'confirmation-required');
    assert.equal(confirmed('gh-read').json.gitStatus, 'tracked');
  });
});

describe('record', () => {
  const answer = (value) => {
    const file = path.join(project, 'answer.json');
    fs.writeFileSync(file, JSON.stringify(value));
    return run('record', base('--input', file));
  };

  it('keeps the answers, shows the waiting steps and tells the next plan not to rerun the check', () => {
    const first = answer({ runtime: 'claude', kind: 'check', results: { 'worker-message': 'prompted', 'git-push': 'prompted', 'gh-read': 'quiet' } });
    assert.equal(first.json.code, 'recorded');
    assert.deepEqual(first.json.prompted, ['worker-message', 'git-push']);
    assert.match(first.json.summary, /waiting for your approval when the run reaches: worker-message, git-push/);
    const plan = run('plan', base());
    assert.equal(plan.json.record.present, true);
    assert.match(plan.json.message, /do not run the check again/);
    const written = JSON.parse(fs.readFileSync(path.join(project, '.formalising', 'auto-fv', 'permissions.json'), 'utf8'));
    assert.equal(written.rounds.length, 1);
  });

  it('keeps both rounds and the allowlist written in between', () => {
    answer({ runtime: 'claude', kind: 'check', results: { 'worker-message': 'prompted' } });
    confirmed('worker-message');
    const second = answer({ runtime: 'claude', kind: 'recheck', results: { 'worker-message': 'quiet' } });
    assert.match(second.json.summary, /^recheck .*no step prompted.*allowlist written to \.claude\/settings\.json \(1 allow\)/);
    const written = JSON.parse(fs.readFileSync(path.join(project, '.formalising', 'auto-fv', 'permissions.json'), 'utf8'));
    assert.deepEqual(written.rounds.map((r) => r.kind), ['check', 'recheck']);
    assert.deepEqual(written.allowlist.allow, ['Bash(ao send *)']);
  });

  it('takes the latest answer per step across rounds, so a partial recheck keeps an unresolved prompt visible', () => {
    answer({ runtime: 'codex', kind: 'check', results: { 'worker-message': 'prompted', 'git-push': 'prompted', 'gh-read': 'quiet' } });
    const recheck = answer({ runtime: 'codex', kind: 'recheck', results: { 'worker-message': 'quiet' } });
    assert.match(recheck.json.summary, /quiet: worker-message, gh-read/);
    assert.match(recheck.json.summary, /prompted: git-push/);
    assert.match(recheck.json.summary, /waiting for your approval when the run reaches: git-push/);
    assert.doesNotMatch(recheck.json.summary, /no step prompted/);
    const view = run('plan', base()).json.record;
    assert.deepEqual(view.latest, { 'worker-message': 'quiet', 'git-push': 'prompted', 'gh-read': 'quiet' });
    assert.deepEqual(view.notAsked, ['author-edit', 'lake-build', 'git-read']);
    assert.equal(view.rounds.length, 2, 'the raw history is kept');
    const later = answer({ runtime: 'codex', kind: 'recheck', results: { 'git-push': 'quiet' } });
    assert.match(later.json.summary, /no step prompted in the latest answers/);
  });

  it('keeps unknown and not-yet-asked steps visible next to quiet ones, and does not call that a skip', () => {
    const mixed = answer({ runtime: 'claude', kind: 'check', results: { 'lake-build': 'unknown', 'gh-read': 'quiet' } });
    assert.match(mixed.json.summary, /quiet: gh-read; unknown: lake-build; not asked: worker-message, author-edit, git-read, git-push/);
    assert.match(mixed.json.summary, /no step prompted in the latest answers/);
    assert.doesNotMatch(mixed.json.summary, /skipped by the owner/);
  });

  it('after a Codex write, says the rules load at startup until a later round is recorded', () => {
    answer({ runtime: 'codex', kind: 'check', results: { 'worker-message': 'prompted', 'git-push': 'prompted' } });
    const preview = run('write-allowlist', base('--runtime', 'codex', '--steps', 'worker-message'));
    const done = run('write-allowlist', base('--runtime', 'codex', '--steps', 'worker-message', '--confirm', preview.json.digest));
    assert.equal(done.json.code, 'written');
    const waiting = run('plan', base()).json.record.summary;
    assert.match(waiting, /allowlist written to \.codex\/rules\/fvs-auto\.rules \(1 allow\)/);
    assert.match(waiting, /Codex loads rules at startup: run the recheck command in a new session/);
    assert.match(waiting, /waiting for your approval when the run reaches: worker-message, git-push/);
    const after = answer({ runtime: 'codex', kind: 'recheck', results: { 'worker-message': 'quiet' } });
    assert.doesNotMatch(after.json.summary, /loads rules at startup/);
    assert.match(after.json.summary, /waiting for your approval when the run reaches: git-push/);
  });

  it('refuses unknown steps and bad values, and never overwrites a malformed record', () => {
    assert.equal(answer({ runtime: 'claude', kind: 'check', results: { 'draft-pr-create': 'prompted' } }).json.code, 'invalid-input');
    assert.equal(answer({ runtime: 'claude', kind: 'check', results: { 'git-push': 'maybe' } }).json.code, 'invalid-input');
    assert.equal(answer({ runtime: 'vim', kind: 'check', results: { 'git-push': 'quiet' } }).json.code, 'invalid-input');
    const file = path.join(project, '.formalising', 'auto-fv', 'permissions.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    assert.equal(answer({ runtime: 'claude', kind: 'check', results: { 'git-push': 'quiet' } }).json.code, 'malformed-record');
    assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
  });

  it('leaves the engine reading a project that has only this record as having no state', () => {
    answer({ runtime: 'claude', kind: 'check', results: { 'git-push': 'quiet' } });
    const engine = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'fvs-auto.mjs'), 'read-state', '--project-root', project], { encoding: 'utf8' });
    assert.equal(JSON.parse(engine.stdout).code, 'no-state');
  });
});

describe('write-allowlist for Codex', () => {
  const codexAllow = (steps, ...extra) => run('write-allowlist', base('--runtime', 'codex', '--steps', steps, ...extra));
  const codexConfirmed = (steps) => {
    const preview = codexAllow(steps);
    assert.equal(preview.json.code, 'confirmation-required');
    return codexAllow(steps, '--confirm', preview.json.digest);
  };
  const codexOnPath = spawnSync('codex', ['--version']).status === 0;

  it('refuses without confirmation, then writes only the rules Codex can express', { skip: pushSkip }, () => {
    recordDestination();
    const steps = 'worker-message,git-push,lake-build,gh-read,git-read';
    const preview = codexAllow(steps);
    assert.equal(preview.json.code, 'confirmation-required');
    assert.equal(fs.existsSync(path.join(project, '.codex')), false);
    assert.deepEqual(Object.keys(preview.json.notWritten), ['lake-build']);
    assert.equal(preview.json.push.command, `${PROGRAM} --branch fvs/<name>`);
    const done = codexConfirmed(steps);
    assert.equal(done.json.code, 'written');
    const text = fs.readFileSync(path.join(project, '.codex', 'rules', 'fvs-auto.rules'), 'utf8');
    for (const pattern of ['["ao", "send"]', '["gh", "pr", "view"]', '["gh", "pr", "list"]', '["git", "fetch", "origin"]', '["git", "ls-remote"]', `["node", "${PUSH_SCRIPT}", "--branch"]`]) assert.ok(text.includes(pattern), pattern);
    assert.ok(!text.includes('"git", "push"'), 'no rule names a git push');
    assert.equal(codexAllow('worker-message').json.code, 'rules-file-conflict', 'a different rule set is refused, not merged');
    assert.equal(fs.readFileSync(path.join(project, '.codex', 'rules', 'fvs-auto.rules'), 'utf8'), text, 'the written file is unchanged');
  });

  it('a step with no Codex rule writes nothing, says why, and leaves its prompt unresolved', () => {
    for (const step of ['lake-build', 'author-edit']) {
      const refused = codexAllow(step);
      assert.equal(refused.json.code, 'nothing-to-write', step);
      assert.match(refused.json.message, /prompts stay unresolved/);
      assert.ok(refused.json.reasons[step].length > 10, step);
    }
    assert.equal(fs.existsSync(path.join(project, '.codex')), false);
  });

  const rulesFile = () => path.join(project, '.codex', 'rules', 'fvs-auto.rules');

  it('never replaces or merges an existing rules file that differs, and says why', () => {
    fs.mkdirSync(path.dirname(rulesFile()), { recursive: true });
    fs.writeFileSync(rulesFile(), 'prefix_rule(pattern=["ls"], decision="allow")\n');
    const refused = codexAllow('worker-message');
    assert.equal(refused.json.code, 'rules-file-conflict');
    assert.match(refused.json.message, /does not replace or merge it/);
    assert.equal(refused.json.existing, 'prefix_rule(pattern=["ls"], decision="allow")\n');
    assert.match(refused.json.wouldWrite, /"ao", "send"/);
    assert.equal(fs.readFileSync(rulesFile(), 'utf8'), 'prefix_rule(pattern=["ls"], decision="allow")\n');
  });

  it('a second write with a disjoint selection keeps the first rules and the user\'s own restrictive rule', () => {
    assert.equal(codexConfirmed('worker-message,gh-read').json.code, 'written');
    const restrictive = '\nprefix_rule(\n    pattern = ["gh", "pr", "view", "--web"],\n    decision = "forbidden",\n)\n';
    fs.appendFileSync(rulesFile(), restrictive);
    const before = fs.readFileSync(rulesFile(), 'utf8');
    const second = codexAllow('git-read');
    assert.equal(second.json.code, 'rules-file-conflict');
    assert.equal(codexAllow('git-read', '--confirm', 'anything').json.code, 'rules-file-conflict', 'a confirmation does not override the conflict');
    const after = fs.readFileSync(rulesFile(), 'utf8');
    assert.equal(after, before);
    assert.ok(after.includes('"ao", "send"') && after.includes('"gh", "pr", "list"') && after.includes('decision = "forbidden"'));
    assert.match(second.json.message, /write every step you want in one command/);
  });

  it('repeating the same write changes nothing', () => {
    assert.equal(codexConfirmed('worker-message').json.code, 'written');
    const before = fs.readFileSync(rulesFile(), 'utf8');
    assert.equal(codexAllow('worker-message').json.code, 'unchanged');
    assert.equal(fs.readFileSync(rulesFile(), 'utf8'), before);
  });

  // A stand-in for the codex CLI, so a missing, rejecting or disagreeing evaluator can be exercised on any machine.
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  function withCodex(script) {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-perm-bin-'));
    fs.symlinkSync(realGit, path.join(bin, 'git'));
    if (script) fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return { PATH: bin };
  }
  const args = (...extra) => base('--runtime', 'codex', '--steps', 'worker-message,gh-read', ...extra);

  it('without the codex CLI it writes after confirmation but says plainly that nothing verified it', () => {
    const env = withCodex(null);
    const preview = run('write-allowlist', args(), env).json;
    assert.equal(preview.code, 'confirmation-required');
    assert.equal(preview.evaluation.verified, false);
    assert.equal(preview.evaluation.evaluator.available, false);
    const done = run('write-allowlist', args('--confirm', preview.digest), env).json;
    assert.equal(done.code, 'written');
    assert.equal(done.verified, false);
    assert.match(done.message, /Written but NOT verified: the codex CLI was not found on PATH/);
    assert.ok(fs.existsSync(rulesFile()));
  });

  it('a codex that rejects the rules stops the write before any live file exists', () => {
    const env = withCodex('if [ "$1" = "--version" ]; then echo codex-cli 9.9.9; exit 0; fi\necho "Error: failed to parse policy" >&2\nexit 1');
    const refused = run('write-allowlist', args(), env);
    assert.equal(refused.json.code, 'evaluator-rejected');
    assert.match(refused.json.evaluation.checks[0].stderr, /failed to parse policy/);
    assert.equal(run('write-allowlist', args('--confirm', 'x'), env).json.code, 'evaluator-rejected');
    assert.equal(fs.existsSync(path.join(project, '.codex')), false);
  });

  it('a codex that does not allow a probe command stops the write', () => {
    const env = withCodex('if [ "$1" = "--version" ]; then echo codex-cli 9.9.9; exit 0; fi\necho \'{"matchedRules":[]}\'');
    const refused = run('write-allowlist', args(), env);
    assert.equal(refused.json.code, 'evaluator-mismatch');
    assert.equal(fs.existsSync(path.join(project, '.codex')), false);
  });

  it('evaluates a temporary candidate before the live file exists, and reports the evaluator version', () => {
    const log = path.join(project, 'codex-calls.log');
    const env = withCodex(`if [ "$1" = "--version" ]; then echo codex-cli 9.9.9; exit 0; fi\nif [ -e "${rulesFile()}" ]; then echo "live $4" >> "${log}"; else echo "candidate $4" >> "${log}"; fi\necho '{"decision":"allow","matchedRules":[]}'`);
    const preview = run('write-allowlist', args(), env).json;
    const done = run('write-allowlist', args('--confirm', preview.digest), env).json;
    assert.equal(done.code, 'written');
    assert.equal(done.verified, true);
    assert.match(done.message, /codex-cli 9\.9\.9.*before it was written.*checks the rules, not a live session/);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.ok(calls.length >= 3);
    for (const call of calls) {
      assert.match(call, /^candidate /, 'only a candidate was ever evaluated, never the live file');
      assert.ok(!call.includes(project), 'the candidate lives outside the project');
    }
    assert.match(done.notes.join(' '), /new session/);
  });

  it('Codex itself accepts the written file and allows each probe', { skip: !codexOnPath && 'codex CLI not on PATH' }, () => {
    const done = codexConfirmed('worker-message,gh-read,git-read');
    assert.equal(done.json.code, 'written');
    assert.equal(done.json.verified, true);
    assert.ok(done.json.evaluation.checks.length >= 5);
    assert.match(done.json.evaluation.evaluator.version, /^codex-cli /);
    for (const check of done.json.evaluation.checks) assert.equal(check.decision, 'allow', check.command);
    const file = path.join(project, '.codex', 'rules', 'fvs-auto.rules');
    for (const command of ['gh pr merge 1', 'git push origin main', 'ao stop w']) {
      const out = spawnSync('codex', ['execpolicy', 'check', '--rules', file, ...command.split(' ')], { encoding: 'utf8' });
      assert.deepEqual(JSON.parse(out.stdout).matchedRules, [], command);
    }
  });

  it('the Codex preview shows the same push command contract as the Claude preview', { skip: pushSkip }, () => {
    recordDestination();
    const preview = codexAllow('git-push');
    assert.equal(preview.json.code, 'confirmation-required');
    assert.deepEqual(preview.json.push.contract, pushLib.CONTRACT);
    assert.equal(preview.json.push.command, `${PROGRAM} --branch fvs/<name>`);
    assert.deepEqual(preview.json.push.contract, allow('git-push').json.push.contract);
  });

  it('the plan carries the contract for the explanation before any write', { skip: pushSkip }, () => {
    const out = run('plan', base()).json;
    assert.deepEqual(out.pushContract, pushLib.CONTRACT);
    assert.equal(out.pushContract.kind, 'cooperative, with hardening, and not a security boundary');
  });

  it('Codex itself accepts the push command rule, matches only that program with --branch, and says what it cannot exclude', { skip: (!codexOnPath && 'codex CLI not on PATH') || pushSkip }, () => {
    recordDestination();
    const done = codexConfirmed('git-push');
    assert.equal(done.json.code, 'written');
    assert.equal(done.json.verified, true);
    assert.deepEqual(done.json.evaluation.checks.map((c) => [c.command, c.decision]), [[`${PROGRAM} --branch fvs/example`, 'allow']]);
    const check = (command) => JSON.parse(spawnSync('codex', ['execpolicy', 'check', '--rules', rulesFile(), '--', ...command], { encoding: 'utf8' }).stdout).matchedRules;
    assert.equal(check(['node', PUSH_SCRIPT, '--branch', 'fvs/work']).length, 1);
    // The rule is a prefix match: it cannot tell fvs/work from main. The command refuses a name outside the recorded namespaces.
    assert.equal(check(['node', PUSH_SCRIPT, '--branch', 'main']).length, 1);
    for (const command of [['node', PUSH_SCRIPT, '--help'], ['node', PUSH_SCRIPT], ['git', 'push', 'origin', 'fvs/work'], ['node', '/elsewhere/fvs-auto-push.mjs', '--branch', 'fvs/work']]) {
      assert.deepEqual(check(command), [], command.join(' '));
    }
  });
});

describe('push allow rules that are already in the settings', () => {
  const LEGACY = 'Bash(git push origin fvs/*)';
  const bytes = (name) => fs.readFileSync(settingsFile(name), 'utf8');

  it('names a push only where the rule is for git push, and not for a broad rule or another command', () => {
    const named = ['Bash(git push origin fvs/*)', 'Bash(git push:*)', 'Bash(git push -u origin fvs/*)', 'Bash(git -C * push *)', 'Bash(rtk git push *)',
      'Bash(git --no-pager push *)', 'Bash(git push)', 'Bash(/usr/bin/git push *)', 'Bash(git -c push.default=current push *)',
      'Bash(git push*)', 'Bash(git pu*)', 'Bash(git p*)', 'Bash(git fetch * && git push *)', 'Bash(git status && git -C x push:*)'];
    for (const rule of named) assert.equal(lib.namesPush(rule), true, rule);
    const other = ['Bash(git stash push *)', 'Bash(npm run push-docs *)', 'Bash(git pushd *)', 'Bash(git commit -m push)', 'Bash(git *)', 'Bash(git **)', 'Bash(git:*)', 'Bash(*)',
      'Bash(git stash push * && git status)', 'Bash(git fetch *)', 'Bash(git co*)', 'Bash(git pull *)',
      'Bash(ao send *)', 'Bash(gh pr view *)', 'Bash', 'Edit(/.formalising/auto-fv/permission-check/**)', 'WebFetch(domain:push.example.com)', '', null, 5, { rule: 'Bash(git push *)' }];
    for (const rule of other) assert.equal(lib.namesPush(rule), false, JSON.stringify(rule));
  });

  it('refuses every Claude write while one is there, lists the exact entries, and changes no file', () => {
    const shared = { model: 'x', permissions: { allow: [LEGACY, 'Bash(ls *)', 'Bash(git push:*)', 'Bash(git status)'], deny: ['Bash(rm *)'] } };
    writeSettings(shared);
    const before = bytes();
    for (const steps of ['worker-message', 'worker-message,gh-read']) {
      const out = allow(steps);
      assert.equal(out.status, 1, steps);
      assert.equal(out.json.code, 'legacy-push-rules', steps);
      assert.deepEqual(out.json.legacyPushRules, [{ file: '.claude/settings.json', resolvedPath: path.join(fs.realpathSync(project), '.claude', 'settings.json'), rules: [LEGACY, 'Bash(git push:*)'], keeps: 2 }]);
      assert.match(out.json.cleanup[0], /delete these 2 entries from permissions\.allow and nothing else.*"Bash\(git push origin fvs\/\*\)".*The other 2 allow entries stay/);
      assert.match(out.json.message, /skip the FVS push command.*FVS deletes none of your rules.*Nothing was written/);
      assert.match(out.json.notExamined, /broad rules such as Bash\(git \*\).*user settings.*permission mode/);
      assert.equal(out.json.digest, undefined, 'there is nothing to confirm yet');
      assert.equal(bytes(), before, 'the file is byte-identical');
    }
    const confirmedTry = allow('worker-message', '--confirm', 'whatever');
    assert.equal(confirmedTry.json.code, 'legacy-push-rules');
    assert.equal(bytes(), before);
  });

  it('reads both project files, whichever one the write targets, and lists each by file', () => {
    writeSettings({ permissions: { allow: ['Bash(ls *)'] } });
    writeSettings({ permissions: { allow: ['Bash(git push *)', 'Bash(git stash push *)'] } }, 'settings.local.json');
    const shared = bytes();
    const local = bytes('settings.local.json');
    for (const target of ['shared', 'local']) {
      const out = allow('worker-message', '--target', target);
      assert.equal(out.json.code, 'legacy-push-rules', target);
      assert.deepEqual(out.json.legacyPushRules.map((one) => [one.file, one.rules, one.keeps]), [['.claude/settings.local.json', ['Bash(git push *)'], 1]]);
    }
    assert.equal(bytes(), shared);
    assert.equal(bytes('settings.local.json'), local);
    assert.deepEqual(run('plan', base()).json.legacyPushRules.map((one) => one.file), ['.claude/settings.local.json'], 'plan reports them before any write is attempted');
  });

  it('works after the owner removes the entries, and then keeps every other entry', () => {
    writeSettings({ permissions: { allow: [LEGACY, 'Bash(ls *)'] } });
    assert.equal(allow('worker-message').json.code, 'legacy-push-rules');
    writeSettings({ permissions: { allow: ['Bash(ls *)'] } });
    const done = confirmed('worker-message');
    assert.equal(done.json.code, 'written');
    assert.deepEqual(readSettings().permissions.allow, ['Bash(ls *)', 'Bash(ao send *)']);
    assert.equal(run('plan', base()).json.legacyPushRules, undefined);
  });

  it('passes a file without such rules, a file that is not JSON (its own refusal comes later), and entries that are not strings', () => {
    writeSettings({ permissions: { allow: [null, 5, { rule: LEGACY }, 'Bash(ls *)'] } });
    assert.equal(allow('worker-message').json.code, 'confirmation-required');
    writeSettings('{ not json', 'settings.local.json');
    assert.equal(allow('worker-message').json.code, 'confirmation-required', 'the shared target does not stop on an unreadable local file');
    assert.equal(lib.legacyPushRules(fs.realpathSync(project)).length, 0);
  });

  it('does not stop a Codex write: Claude settings are not what Codex reads', () => {
    writeSettings({ permissions: { allow: [LEGACY] } });
    assert.equal(run('write-allowlist', base('--runtime', 'codex', '--steps', 'worker-message')).json.code, 'confirmation-required');
  });
});

describe('what a confirmation is bound to', () => {
  const sha = (name = 'settings.json') => require('node:crypto').createHash('sha256').update(fs.readFileSync(settingsFile(name))).digest('hex');
  const folder = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const SAME = { model: 'same-bytes-in-both-folders' };
  const put = (dir, value) => fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(value, null, 2) + '\n');
  const retarget = (link, dir) => { fs.rmSync(link, { force: true }); fs.symlinkSync(dir, link); };

  it('the preview names the project root and the exact bytes it is about', () => {
    writeSettings(SAME);
    const preview = allow('worker-message').json;
    assert.equal(preview.projectRoot, fs.realpathSync(project));
    assert.equal(preview.existingSha256, sha());
    assert.equal(allow('worker-message').json.digest, preview.digest, 'the same state gives the same digest');
  });

  it('refuses a digest after the link in front of the file leads somewhere else, even when both folders hold the same bytes', () => {
    const [a, b] = [folder('fvs-perm-a-'), folder('fvs-perm-b-')];
    put(a, SAME); put(b, SAME);
    const link = path.join(project, '.claude');
    fs.symlinkSync(a, link);
    const preview = allow('worker-message').json;
    assert.equal(preview.resolvedPath, path.join(fs.realpathSync(a), 'settings.json'));
    retarget(link, b);
    const out = allow('worker-message', '--confirm', preview.digest);
    assert.equal(out.status, 1);
    assert.equal(out.json.code, 'confirmation-required');
    assert.match(out.json.message, /the real path of the file.*Nothing was written.*new digest needs a new yes/s);
    assert.equal(out.json.resolvedPath, path.join(fs.realpathSync(b), 'settings.json'), 'the new preview shows where the file is now');
    assert.notEqual(out.json.digest, preview.digest);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a, 'settings.json'), 'utf8')), SAME);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(b, 'settings.json'), 'utf8')), SAME);
    const done = allow('worker-message', '--confirm', out.json.digest);
    assert.equal(done.json.code, 'written');
    assert.equal(done.json.realPath, path.join(fs.realpathSync(b), 'settings.json'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a, 'settings.json'), 'utf8')), SAME, 'the folder that was approved is untouched');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(b, 'settings.json'), 'utf8')).permissions.allow, ['Bash(ao send *)']);
  });

  it('sees a link that appears where no folder existed at the preview', () => {
    const a = folder('fvs-perm-a-');
    const preview = allow('worker-message').json;
    assert.equal(preview.viaLink, false);
    fs.symlinkSync(a, path.join(project, '.claude'));
    const out = allow('worker-message', '--confirm', preview.digest);
    assert.equal(out.json.code, 'confirmation-required');
    assert.equal(out.json.viaLink, true);
    assert.deepEqual(fs.readdirSync(a), [], 'nothing was written through the new link');
  });

  it('refuses a digest after the same file changed, and keeps the change made meanwhile', () => {
    writeSettings({ permissions: { allow: ['Bash(ls *)'] } });
    const preview = allow('worker-message').json;
    writeSettings({ permissions: { allow: ['Bash(ls *)', 'Bash(date)'] }, added: 'meanwhile' });
    const changed = fs.readFileSync(settingsFile(), 'utf8');
    const out = allow('worker-message', '--confirm', preview.digest);
    assert.equal(out.json.code, 'confirmation-required');
    assert.match(out.json.message, /content of the file/);
    assert.equal(out.json.existingSha256, sha());
    assert.equal(fs.readFileSync(settingsFile(), 'utf8'), changed, 'nothing was written');
    const done = allow('worker-message', '--confirm', out.json.digest);
    assert.equal(done.json.code, 'written');
    assert.equal(readSettings().added, 'meanwhile');
    assert.deepEqual(readSettings().permissions.allow, ['Bash(ls *)', 'Bash(date)', 'Bash(ao send *)']);
  });

  it('refuses a digest when the file was missing at the preview and exists now', () => {
    const preview = allow('worker-message').json;
    assert.equal(preview.existingSha256, null);
    writeSettings({});
    assert.equal(allow('worker-message', '--confirm', preview.digest).json.code, 'confirmation-required');
    assert.deepEqual(readSettings(), {});
  });

  it('refuses a digest from another project root whose .claude leads to the same folder', () => {
    const shared = folder('fvs-perm-shared-');
    put(shared, SAME);
    const other = folder('fvs-perm-other-');
    spawnSync('git', ['-C', other, 'init', '-q']);
    spawnSync('git', ['-C', other, 'remote', 'add', 'origin', `git@github.com:${REPO}.git`]);
    fs.symlinkSync(shared, path.join(project, '.claude'));
    fs.symlinkSync(shared, path.join(other, '.claude'));
    const args = (root, ...extra) => ['--project-root', root, '--repo', REPO, '--runtime', 'claude', '--steps', 'worker-message', ...extra];
    const preview = run('write-allowlist', args(project)).json;
    const otherPreview = run('write-allowlist', args(other)).json;
    assert.equal(otherPreview.resolvedPath, preview.resolvedPath, 'both roots lead to the same real file');
    assert.notEqual(otherPreview.digest, preview.digest, 'the project root is part of what is confirmed');
    const out = run('write-allowlist', args(other, '--confirm', preview.digest));
    assert.equal(out.json.code, 'confirmation-required');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(shared, 'settings.json'), 'utf8')), SAME);
  });

  it('checks again just before the write: a file or link that moved is refused', () => {
    writeSettings(SAME);
    const root = fs.realpathSync(project);
    const before = lib.snapshotOf(root, '.claude/settings.json');
    assert.doesNotThrow(() => lib.checkUnchanged(root, '.claude/settings.json', before));
    writeSettings({ ...SAME, changed: true });
    assert.throws(() => lib.checkUnchanged(root, '.claude/settings.json', before), (error) => error.code === 'changed-since-preview' && /nothing was written/.test(error.message));
  });

  it('binds the Codex rules file the same way: a retargeted .codex link is refused and nothing is written there', () => {
    const [a, b] = [folder('fvs-perm-a-'), folder('fvs-perm-b-')];
    const link = path.join(project, '.codex');
    fs.symlinkSync(a, link);
    const codex = (...extra) => run('write-allowlist', base('--runtime', 'codex', '--steps', 'worker-message', ...extra));
    const preview = codex().json;
    assert.equal(preview.code, 'confirmation-required');
    assert.equal(preview.projectRoot, fs.realpathSync(project));
    assert.equal(preview.resolvedPath, path.join(fs.realpathSync(a), 'rules', 'fvs-auto.rules'), 'the link is seen although .codex/rules does not exist yet');
    assert.equal(preview.viaLink, true);
    retarget(link, b);
    const out = codex('--confirm', preview.digest);
    assert.equal(out.json.code, 'confirmation-required');
    assert.equal(out.json.resolvedPath, path.join(fs.realpathSync(b), 'rules', 'fvs-auto.rules'));
    assert.deepEqual([fs.readdirSync(a), fs.readdirSync(b)], [[], []]);
    const done = codex('--confirm', out.json.digest);
    assert.equal(done.json.code, 'written');
    assert.equal(fs.existsSync(path.join(b, 'rules', 'fvs-auto.rules')), true);
    assert.deepEqual(fs.readdirSync(a), []);
  });
});

describe('recheck', () => {
  const answer = (value) => {
    const file = path.join(project, 'answer.json');
    fs.writeFileSync(file, JSON.stringify(value));
    return run('record', base('--input', file));
  };
  const recheck = (...extra) => run('recheck', base(...extra));
  const ids = (out) => out.json.steps.map((s) => s.id);

  it('needs an earlier check, and says so', () => {
    const out = recheck();
    assert.equal(out.status, 1);
    assert.equal(out.json.code, 'no-record');
    assert.match(out.json.message, /run plan and the check first/);
  });

  it('is what a plan with a record points to, so the resume path and the recheck guidance agree', () => {
    answer({ runtime: 'claude', kind: 'check', results: { 'worker-message': 'prompted' } });
    const plan = run('plan', base()).json;
    assert.match(plan.message, /do not run the check again/);
    assert.match(plan.message, /recheck command/);
  });

  it('repeats the probes of the steps that last prompted, the push step included, and says how to record them', { skip: pushSkip }, () => {
    answer({ runtime: 'claude', kind: 'check', results: { 'worker-message': 'prompted', 'gh-read': 'prompted', 'git-read': 'quiet', 'git-push': 'prompted', 'author-edit': 'unknown' } });
    const out = recheck();
    assert.equal(out.status, 0);
    assert.equal(out.json.mode, 'recheck');
    assert.deepEqual(ids(out), ['worker-message', 'gh-read', 'git-push']);
    const byId = Object.fromEntries(out.json.steps.map((s) => [s.id, s]));
    assert.equal(byId['worker-message'].probes.length, 1);
    assert.equal(byId['gh-read'].probes.length, 2);
    assert.deepEqual(byId['git-push'].probes, [{ tool: 'Bash', command: `${PROGRAM} --branch fvs/.permission-check` }]);
    assert.equal(byId['git-push'].skipped, undefined, 'the push probe is harmless, so it is repeated like the others');
    assert.match(out.json.message, /"kind":"recheck"/);
    assert.match(out.json.message, /Codex.*new session.*trusted.*read when a session starts/);
    assert.match(out.json.summary, /prompted: worker-message, gh-read, git-push/);
  });

  it('follows the latest answer per step, so a step answered quiet in a later round is not repeated', () => {
    answer({ runtime: 'claude', kind: 'check', results: { 'worker-message': 'prompted', 'gh-read': 'prompted' } });
    answer({ runtime: 'claude', kind: 'recheck', results: { 'worker-message': 'quiet' } });
    assert.deepEqual(ids(recheck()), ['gh-read']);
  });

  it('takes the steps from --steps instead, refuses an unknown one, and says when there is nothing to repeat', () => {
    answer({ runtime: 'codex', kind: 'check', results: { 'worker-message': 'quiet', 'gh-read': 'quiet' } });
    const none = recheck();
    assert.deepEqual(none.json.steps, []);
    assert.match(none.json.message, /nothing to repeat.*--steps/);
    assert.deepEqual(ids(recheck('--steps', 'worker-message,git-read')), ['worker-message', 'git-read']);
    assert.equal(recheck('--steps', 'nope').json.code, 'unknown-step');
  });

  it('skips the Lake probe with its reason, as plan does', () => {
    answer({ runtime: 'claude', kind: 'check', results: { 'lake-build': 'prompted' } });
    const [lake] = recheck().json.steps;
    assert.equal(lake.probes, null);
    assert.match(lake.skipped, /no lakefile at the project root; record it as unknown/);
  });
});

describe('the permissions page', () => {
  const page = () => fs.readFileSync(PAGE, 'utf8');
  const block = (text, heading, language) => {
    const start = text.indexOf(`\n## ${heading}`);
    assert.ok(start >= 0, heading);
    const end = text.indexOf('\n## ', start + 1);
    const match = new RegExp('```' + language + '\\n([\\s\\S]*?)```').exec(text.slice(start, end < 0 ? undefined : end));
    assert.ok(match, `${language} block under ${heading}`);
    return match[1];
  };

  const catalog = () => lib.buildCatalog({ repo: 'OWNER/REPO', scriptsDir: PLACEHOLDER_DIR });

  it('prints exactly the allowlist the script writes for the documented steps', () => {
    const probed = catalog().steps.filter((s) => s.probes);
    const documented = JSON.parse(block(page(), 'Claude Code allowlist', 'json'));
    assert.deepEqual(documented.permissions.allow, probed.flatMap((s) => s.claude));
    assert.equal(documented.permissions.deny, undefined, 'the page lists no deny rules, because FVS writes none');
    assert.deepEqual(documented.permissions.allow.filter((rule) => /push/.test(rule)), [`Bash(node ${PLACEHOLDER_DIR}/fvs-auto-push.mjs --branch fvs/*)`], 'the one push rule names the push command');
    assert.ok(!/git push/.test(JSON.stringify(documented)), 'the page lists no rule for git push');
    for (const dropped of ['draft-pr-create', 'draft-pr-edit', 'edit-folders', 'gh pr create', 'gh pr edit']) assert.ok(!page().includes(dropped), `${dropped} is no longer written, so the page does not offer it`);
  });

  it('prints exactly the Codex rules the script writes', () => {
    const text = block(page(), 'Codex rules', 'python');
    const rules = catalog().steps.flatMap((s) => s.codex);
    assert.equal((text.match(/prefix_rule\(/g) ?? []).length, rules.length);
    for (const rule of rules) assert.ok(text.includes(`pattern = [${rule.pattern.map((p) => JSON.stringify(p)).join(', ')}]`), rule.pattern.join(' '));
    assert.ok(!/decision = "(prompt|forbidden)"/.test(text));
    assert.ok(!text.includes('"git", "push"'), 'no Codex rule names a git push');
  });

  it('prints the destination record with the fields the script writes', () => {
    const shown = JSON.parse(block(page(), 'The push command', 'json'));
    const written = pushLib.destinationRecord({ projectRoot: '/p', commonDir: '/p/.git', url: 'u', host: 'h', repo: 'o/r', prefixes: ['fvs'] });
    assert.deepEqual(Object.keys(shown), Object.keys(written));
    assert.equal(shown.schema, written.schema);
    assert.equal(shown.schemaVersion, written.schemaVersion);
  });

  it('keeps the push command honest: the limits are stated and branch protection stays recommended', () => {
    const text = page().replace(/\s+/g, ' ');
    assert.match(text, /Branch protection on the project fork is still recommended/);
    assert.match(text, /A rule is matched against the command text, and a `\*` in it also matches the rest of that text, so the rule cannot check the arguments\. The command checks them itself/);
    assert.match(text, /A worker that runs a plain `git push` is not covered by this rule: your other rules and permission mode decide that push, as before/);
    assert.match(text, /On Codex, a rule matches the start of a command: `node`, the path and `--branch`\. It cannot tell `fvs\/work` from `main`, and the command refuses a name outside the recorded namespaces/);
    assert.match(text, /Codex splits a command run through a shell wrapper such as `bash -lc`.*That was not observed here/);
    assert.match(text, /leaves no `origin\/<name>` ref and sets no upstream: run `git fetch` to see the branch/);
    assert.match(text, /In the tests, none of these settings changed where the push went or what it sent: `remote\.<name>\.push`.*`submodule\.recurse`/);
    assert.match(text, /A worker that gets a refusal stops and reports its `code` and `message`\. It does not fall back to `git push`/);
    assert.match(text, /An FVS update or reinstall that moves the script leaves both stale: run init again to append the rule for the new path, and delete the old rule yourself/);
    assert.match(text, /whether Claude Code screens a command substitution \(`\$\(\.\.\.\)`\) after the branch name against an allow rule, which its documentation does not say, or applies its documented checks of redirect targets and of each part of a compound command to the push rule/);
    // What the runtimes' documentation says, with the versions it was read for, and the limit that none of it was observed.
    assert.match(text, /a compound command is split at `&&`, `\|\|`, `;`, `\|`, `\|&`, `&` and newlines and that every part must be allowed, and that a redirect target is checked against your file rules/);
    assert.match(text, /Codex splits a command run through a shell wrapper such as `bash -lc` into its simple commands only when the script is a plain chain joined by `&&`, `\|\|`, `;` or `\|`\. A script with a redirect, a substitution, a variable assignment or a wildcard is not split/);
    assert.match(text, /Claude Code 2\.1\.329 and codex-cli 0\.170\.0/);
    assert.match(text, /Do not make the first real push the test of the rule/);
    // The page names a git push allow rule only as something to delete, never inside a block that shows what FVS writes.
    const blocks = [...page().matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((match) => match[1]);
    assert.ok(blocks.length >= 4);
    for (const code of blocks) assert.ok(!/Bash\(git push/.test(code), 'no block of the page shows a git push rule');
  });

  it('states what the push command checks, sends and records, with the repository, option and receipt rules', () => {
    const text = page().replace(/\s+/g, ' ');
    assert.match(text, /A `core\.worktree` setting that points a repository at the files of another one is refused with `worktree-mismatch`/);
    assert.match(text, /a copy of the repository and another repository do not\. A link that leads into the same repository is that repository/);
    assert.match(text, /`-c core\.abbrev=no`, `-c push\.pushOption=`, `-c core\.hooksPath=\/dev\/null` and `--no-verify`, and no other option/);
    assert.match(text, /`push\.pushOption=` empties the list of push options from every git configuration/);
    assert.match(text, /`--no-verify` skips the pre-push hook, including one that is set in git configuration with `hook\.<name>\.event`, which `core\.hooksPath` does not turn off\. `core\.hooksPath=\/dev\/null` makes git find no hook in any hooks folder/);
    assert.doesNotMatch(text, /makes git find no hook, wherever the hooks folder is set/);
    assert.match(text, /Every git call that the command makes \(the look for the repository, the checks, the address checks and the push\) runs with the same environment, so the checks see what the push sees\. It is without the variables listed under "What it does for this push"/);
    assert.match(text, /The record names only object ids that the push itself reported/);
    assert.match(text, /so `newRemoteId` is null for them\. `localTipBeforePush` is the tip that the command read just before the push/);
    assert.match(text, /treat that as a later observation/);
    assert.match(text, /The command then reports `push-outcome-unknown` and does not say that nothing changed\. Read the destination before you retry/);
    // The two refusal codes that a worker may now see are named on the page.
    for (const code of ['worktree-mismatch', 'push-outcome-unknown']) assert.ok(text.includes(`\`${code}\``), code);
    // The claim is limited to the calls that act on the repository, and the hook environment is stated.
    assert.match(text, /the branch checks, the address checks, the read of the branch tip and the push itself each name the git directory and the work tree that were found/);
    assert.doesNotMatch(text, /every git call names the git directory/);
    // A variable that init did not record is dropped, not refused. A recorded one is refused when it changed, with its own code.
    assert.doesNotMatch(text, /are not set\./);
    assert.doesNotMatch(text, /git-environment/);
    const init = fs.readFileSync(path.join(ROOT, 'fv-skills', 'workflows', 'auto-init.md'), 'utf8').replace(/\s+/g, ' ');
    assert.match(init, /`not-a-repository` or `worktree-mismatch`: the project root is not a git work tree, or a `core\.worktree` setting/);
    assert.doesNotMatch(init, /git-environment/);
  });

  it('names no push gate hook anywhere in what ships: no release ever shipped one, so nothing is listed for cleanup', () => {
    const old = ['fvs-auto-push', 'gate'].join('-');
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return ['node_modules', '.git'].includes(entry.name) ? [] : walk(full);
      return /\.(md|mjs|cjs|js|json|toml)$/.test(entry.name) ? [full] : [];
    });
    const roots = ['fv-skills', 'commands', 'scripts', 'bin', 'agents', 'plugins', 'pi'].map((name) => path.join(ROOT, name)).filter((dir) => fs.existsSync(dir));
    for (const file of [path.join(ROOT, 'README.md'), ...roots.flatMap(walk)]) {
      assert.ok(!fs.readFileSync(file, 'utf8').includes(old), `${path.relative(ROOT, file)} names the old push gate script`);
    }
    assert.equal(fs.existsSync(path.join(ROOT, 'scripts', `${old}.mjs`)), false);
    // Legacy push allow rules are still detected and listed.
    assert.equal(typeof lib.legacyPushRules, 'function');
    assert.equal(lib.legacyPushGateHooks, undefined);
  });

  // The surfaces that tell a person what the push command is. Each must say it plainly, with its limits.
  const CONTRACT_SURFACES = ['fv-skills/references/auto-permissions.md', 'fv-skills/workflows/auto-init.md', 'commands/fvs/auto-init.md',
    'fv-skills/references/auto-setup.md', 'README.md', 'fv-skills/references/auto-execution.md', 'fv-skills/workflows/auto-top-specs.md'];
  const flat = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/`/g, '').replace(/\s+/g, ' ');

  it('prints the push command contract on the page exactly as the script defines it', () => {
    const text = flat(path.relative(ROOT, PAGE));
    assert.match(text, /### What the command is[\s\S]*### What the command refuses/);
    assert.ok(text.includes(`The push command is ${pushLib.CONTRACT.kind}.`), 'the page states what kind of guard it is');
    for (const list of ['checks', 'hardening', 'trusts']) {
      assert.ok(pushLib.CONTRACT[list].length > 0, list);
      for (const entry of pushLib.CONTRACT[list]) assert.ok(text.includes(entry), `${list}: ${entry}`);
    }
    assert.match(text, /It is not a defence against a program that runs as your user/);
  });

  it('has a short section on unattended runs in a sandbox, in plain words and without anyone\'s own tools', () => {
    const raw = fs.readFileSync(PAGE, 'utf8');
    const start = raw.indexOf('## Unattended runs in a sandbox');
    assert.ok(start > raw.indexOf('## What FVS never allows'), 'it follows the list of what FVS never allows');
    const end = raw.indexOf('\n## ', start + 1) + 1;
    assert.equal(raw.indexOf('## Where the file goes'), end, 'it ends where "Where the file goes" starts');
    const section = raw.slice(start, end).replace(/`/g, '').replace(/\s+/g, ' ');
    assert.ok(section.split(' ').length < 400, 'it stays short');
    assert.match(section, /skip-permissions/);
    assert.match(section, /only inside an isolated sandbox or on a cloud machine/);
    assert.match(section, /Never use it on a personal machine with broad access/);
    assert.match(section, /nothing prompts, so the rules in "What FVS never allows" \(no GitHub comments or reviews, no merges, no pushes to an upstream\) are no longer enforced by a prompt/);
    assert.match(section, /A token limited to the project's fork/);
    assert.match(section, /A posting guard in the sandbox/);
    assert.match(section, /gh wrapper ahead of the real gh on PATH that refuses the commands that comment on, review, mark ready or merge a pull request/);
    assert.match(section, /The wrapper only catches mistakes: a program in the sandbox can call the API directly\. The token limits where a comment can land, not whether one is posted/);
    assert.doesNotMatch(section, /the limit that holds is the scope of the token/i);
    assert.match(section, /Branch protection on the fork/);
    // The baseline protection, and the approving review only as an option that is not enforced on administrators.
    assert.match(section, /require a pull request and forbid force pushes and branch deletion, and apply the rule to administrators too: GitHub exempts them by default, and an agent that works through the owner's own account acts as one\. A direct push is then stopped\. A merge through a pull request is not: the posting guard refuses it, and only the owner merges/);
    assert.match(section, /A team with a second reviewer can also require an approving review, but the owner then needs that reviewer to merge their own pull requests/);
    assert.doesNotMatch(section, /approving review from someone else|not enforced on administrators|so that a direct push to them is stopped|binds the push/i);
    // The check and the allowlist can be skipped; the push command and init's destination step cannot.
    assert.match(section, /In a skip-permissions sandbox only the permission check and the allowlist are optional; the push command and init's destination step are not\. Workers push with the push command and never with git push, because it pushes to the destination recorded at init and records the result\. With no destination recorded, a worker's first push is refused and the worker stops; init records it in a separate step, also when you skip the check/);
    assert.doesNotMatch(section, /push command (is|are) optional/i);
    assert.match(section, /cooperative guard and not a security boundary/);
    assert.doesNotMatch(section, /orca|docker|\bAO\b|Orchestrator|\brtk\b/i, 'a stock user is the baseline: no one\'s own tools are named');
    assert.doesNotMatch(section, /pushes only|asks as usual|fails safe/i);
    assert.match(raw.split('</overview>')[0].replace(/\s+/g, ' '), /keeps the same safety rules and enforces them by other means: see "Unattended runs in a sandbox"/);
  });

  it('tells the owner what an unknown git status means', () => {
    assert.match(flat('fv-skills/workflows/auto-init.md'), /its gitStatus \(a loose or tracked file can end up in a pull request; unknown means git cannot say, as for a file reached through a link\)/);
  });

  it('lists the limit that is left for later, the untested timeout report, and no longer lists the helper\'s own git calls as uncleaned', () => {
    const text = flat(path.relative(ROOT, PAGE));
    assert.match(text, /### What it does not stop[\s\S]*The report push-outcome-unknown after a timeout of the push has no test\. The cases of a missing result line and of a signal are tested\. Read the destination before you retry in every case[\s\S]*### Where the destination is recorded/);
    assert.doesNotMatch(text, /Only the git calls of the push command run without the variables/);
    assert.doesNotMatch(text, /permissions helper makes itself \(the status of a settings file, the check of the main checkout\) are not cleaned/);
  });

  it('every surface that describes the push command says it is a guard with limits, and none promises more', () => {
    for (const file of CONTRACT_SURFACES) {
      const text = flat(file);
      assert.doesNotMatch(text, /refuses anything else(?! on its command line)|refuses every other|other than the recorded|pushes only|push only|runs only in the repository|cannot redirect|cannot widen/i, file);
      assert.doesNotMatch(text, /Git hooks of the repository still run|hooks .{0,40}still run/i, file);
    }
    // The three places a person is told what the command is name the guard, its hardening and its limits.
    for (const file of ['fv-skills/workflows/auto-init.md', 'commands/fvs/auto-init.md', 'fv-skills/references/auto-execution.md']) {
      const text = flat(file);
      assert.match(text, /cooperative guard/, file);
      assert.match(text, /not a security boundary/, file);
    }
    const init = flat('fv-skills/workflows/auto-init.md');
    for (const term of ['pushContract', 'does not run repository hooks', 'pre-push checks do not run', 'drops the listed git environment variables', 'ssh and transport wrappers', 'credential helpers', 'URL rewrite rules', 'the record file and FVS itself', 'anything that runs as the owner.s user']) {
      assert.match(init, new RegExp(term), term);
    }
    const brief = flat('fv-skills/references/auto-execution.md');
    for (const term of ['hooks', 'credential helpers', 'URL rewrite', 'ssh', 'record file', 'runs as your user']) assert.ok(brief.includes(term), `the worker brief names ${term}`);
    // The brief and the page's list of dropped variables agree: the brief names the kinds, the page lists every name.
    assert.match(brief, /does not run repository hooks for this push and drops the git variables that move a repository or select its configuration files, except the git configuration variables whose names the owner trusted at init: it keeps those with whatever value they have when it runs, and does not refuse a value that changed/);
    for (const name of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM']) assert.ok(flat('fv-skills/references/auto-permissions.md').includes(name), `the page lists ${name}`);
  });

  it('tells the owner that the destination step trusts git configuration variables by name, with a confirmed replace, on the page and in the init workflow', () => {
    const page = flat(path.relative(ROOT, PAGE));
    assert.match(page, /git finds the repository with the git variables that you trusted at init and no others\. .* the command refuses with not-a-repository and names the variables that it left out, never their values\. To trust them, run the destination step of \/fvs:auto-init again: it replaces the record after your yes\. A trusted name that is not set, or that has another value than at init, is not a refusal/);
    assert.match(page, /the preview lists each one by name with the length of its value, never the value, because a value can be a token and the preview goes into the model's context and the transcript\. Your yes trusts these names\. The record gains trustedGitVariables: each trusted name with a hash of its value at that moment, so the file never holds a value either/);
    assert.match(page, /The push command keeps each trusted name with whatever value it has when it runs and drops every other name\. A value that changes later, such as a token that a sandbox sets for each session, is not refused: the receipt marks it changed, and the hash is for that information only\. A trusted name that is not set is skipped\. You trust these names the way you trust ~\/\.gitconfig: whatever they hold is used\. A variable that is not set when you confirm stays untrusted, so unset one before init to keep it out/);
    assert.match(page, /Run the destination step where the workers run, so the names are the ones they have/);
    assert.match(page, /GIT_CONFIG_COUNT and the GIT_CONFIG_KEY_n and GIT_CONFIG_VALUE_n pairs that it addresses are one unit\. Trusting the count trusts the pairs it addresses when the command runs, whatever the record names, so a sandbox that adds a setting is not refused and git never meets a count without its pairs\. A pair is never trusted alone: a pair that the count does not address, or that has no count, is not offered at init and is dropped by the command/);
    assert.match(page, /When the record is the same except for its trusted names, the preview shows the old record, the new record and the names that are added and removed, with its own digest\. After your yes the record is rewritten \(replaced\) and the old one is not kept\. The digest covers the old record/);
    assert.match(page, /It replaces a record only to change the git variables that you trust \(below\), and only when the destination is the same\. A record for another destination, a record that is not valid and a file that is not JSON stop it with destination-conflict, which shows both\. To change the destination itself, delete the record on purpose: check the file, delete it yourself and run init again/);
    assert.match(page, /The permissions helper runs its destination checks with the variables that are set in its session, because it asks you to confirm them\. Its look at the git status of a settings file runs without any\. In the tests, a push option set in a trusted variable was not sent/);
    assert.match(page, /runs with the same environment, so the checks see what the push sees/);
    assert.match(page, /The receipt, in the output and in that file, also has gitVariables\. For each trusted name it says same .* changed .* or not-set, and added for a numbered pair that the trusted count addresses now and the record does not name\. It lists the names that were set and not trusted, which the push dropped\. It holds no value and no hash/);
    assert.doesNotMatch(page, /git-config-changed|gitConfigEnvironmentSha256|made again with the ones that are set/);
    const init = flat('fv-skills/workflows/auto-init.md');
    assert.match(init, /gitConfigVariables \(every git configuration variable that is set in this session and can be trusted, by name with the length of its value, never the value\) with its gitConfigNote/);
    assert.match(init, /The yes also trusts the names of those variables: the push command keeps each of them with whatever value it has when it runs, drops every other name, and does not refuse a value that changed \(the receipt marks it\)\. GIT_CONFIG_COUNT and the pairs it addresses are one unit\. The owner trusts them as they trust their own ~\/\.gitconfig\. Say that a value can be a credential, so the preview never shows it and the record keeps only a hash, for information\. A variable that is not set when the owner confirms stays untrusted/);
    assert.match(init, /Run this step in the environment the workers will have/);
    assert.match(init, /a value that rotated since the record was written is no difference/);
    assert.match(init, /With confirmation-required and a replaces field, the record exists with the same destination and another set of trusted names: show replaces \(the old record\), record \(the new one\), variableChanges \(added, removed, kept\), replaceNote and gitConfigVariables, and ask for a separate yes; on it, rerun with --confirm <digest> and the record is rewritten \(replaced\)/);
    assert.match(init, /name the variables in changedVariables when it is printed\. FVS replaces a record only to change its trusted names, never the destination: to change the destination itself, the owner checks the file, deletes the record on purpose and runs init again/);
    assert.match(init, /except the git configuration variables whose names the owner trusted in the destination step: it keeps those with whatever value they have when it runs, and does not refuse a value that changed/);
    assert.doesNotMatch(init, /git-config-changed|refuses to push when one is missing or has changed/);
  });

  it('makes no unconditional promise that a push asks, and no longer describes a hook as part of init', () => {
    const docs = [PAGE, 'fv-skills/workflows/auto-init.md', 'fv-skills/references/auto-setup.md', 'commands/fvs/auto-init.md', 'README.md', 'scripts/fvs-auto-permissions.mjs', 'scripts/fvs-auto-push.mjs']
      .map((file) => [file, fs.readFileSync(path.isAbsolute(file) ? file : path.join(ROOT, file), 'utf8').replace(/\s+/g, ' ')]);
    for (const [file, text] of docs) {
      assert.doesNotMatch(text, /fails? safe|asks as usual|asks for every other push|every other push (still )?asks|a push (still |keeps )asks|a push keeps asking|every push that is not an exact (plain )?form/i, file);
      assert.doesNotMatch(text, /push gate hook (allows|asks|answers|gives|installed|is installed)|offers the push gate hook|the hook gives no decision|install(s|ed)? (a|the) push gate hook/i, file);
    }
    const text = page().replace(/\s+/g, ' ');
    assert.match(text, /## The push command[\s\S]*### What the command refuses[\s\S]*### What it sends[\s\S]*### What it does not stop[\s\S]*### Where the destination is recorded/);
    assert.match(text, /Nothing in this page promises that a push asks/);
    assert.doesNotMatch(text, /## Push gate hook|### When the hook gives no decision/);
  });

  it('documents the git push rule refusal, the earlier hook, the confirmation binding and the recheck entry point', () => {
    const text = page().replace(/\s+/g, ' ');
    assert.match(text, /### Push allow rules already in your settings/);
    assert.match(text, /a Claude write stops with `legacy-push-rules`, before any preview and before anything is written\. Both files stay byte-identical/);
    assert.match(text, /does not see: broad rules such as `Bash\(git \*\)` or `Bash\(\*\)`, your user settings/);
    assert.match(text, /The digest covers the exact rules, the recorded destination when a push rule is written, the canonical project root, the real path of the file .* and the hash of the file's current content/);
    assert.match(text, /a new digest that needs a new yes/);
    assert.match(text, /an edit made in the instant between that last check and the replacement is not detected/);
    assert.match(text, /ask init to recheck permissions: it runs `recheck`/);
    assert.match(text, /To start over, delete the record file yourself/);
    assert.doesNotMatch(text, /To run the check again, delete that file/);
    assert.doesNotMatch(text, /never the push step/);
  });

  it('names the Codex source and the tested version, qualifies "harmless", and separates tested from not observed', () => {
    const text = page();
    assert.match(text, /\(https:\/\/developers\.openai\.com\/codex\/rules\)/);
    assert.match(text, /codex-cli 0\.166\.0/);
    assert.match(text, /\n## What was tested\n[\s\S]*Unit tests[\s\S]*codex execpolicy check[\s\S]*One live probe: the message step[\s\S]*Not observed:/);
    assert.match(text.replace(/\s+/g, ' '), /Lake evaluates your project's own lakefile and can write build caches, and git runs any hook you configured/);
    assert.doesNotMatch(text, /harmless instance/);
  });

  it('every probe command in the page is one the plan prints', () => {
    const commands = catalog().steps.flatMap((s) => (s.probes ?? []).filter((p) => p.command).map((p) => p.command));
    for (const command of commands) assert.ok(page().includes(command), command);
  });
});
