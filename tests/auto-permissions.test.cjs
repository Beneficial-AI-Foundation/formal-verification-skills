'use strict';

// The permission check writes a project allowlist, so its refusals matter as much as its writes: nothing is
// written without the user's confirmation of the exact rules, no forbidden rule is ever written, and a rule
// file keeps every key and rule it already had. Each probe must also be matched by the rule written for its
// own step, or the check would prove nothing about the run.

const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'fvs-auto-permissions.mjs');
const PAGE = path.join(ROOT, 'fv-skills', 'references', 'auto-permissions.md');
const REPO = 'Acme/proj';

let lib;
before(async () => { lib = await import(pathToFileURL(SCRIPT).href); });

let project;
beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-perm-'));
  const git = (...args) => assert.equal(spawnSync('git', ['-C', project, ...args], { encoding: 'utf8' }).status, 0, args.join(' '));
  git('init', '-q');
  git('remote', 'add', 'origin', `git@github.com:${REPO}.git`);
});

const base = (...extra) => ['--project-root', project, '--repo', REPO, ...extra];
function run(command, args) {
  const result = spawnSync(process.execPath, [SCRIPT, command, ...args], { encoding: 'utf8' });
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

// How Claude Code reads a Bash rule: "*" stands for any text, and a trailing " *" also matches the bare command.
function bashMatches(rule, command) {
  const body = /^Bash\((.*)\)$/s.exec(rule)[1];
  const escape = (text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const trailing = body.endsWith(' *') && body.split('*').length === 2;
  const source = trailing ? `${escape(body.slice(0, -2))}( .*)?` : body.split('*').map(escape).join('.*');
  return new RegExp(`^${source}$`, 's').test(command);
}

describe('the catalog', () => {
  it('every probe is matched by a rule of its own step and by no guard', () => {
    const catalog = lib.buildCatalog({ repo: REPO, prefixes: ['fvs', 'team/runs'] });
    for (const step of catalog.steps.filter((s) => s.probes)) {
      for (const probe of step.probes) {
        if (probe.tool === 'Write') {
          assert.ok(step.claude.includes(`Edit(/${lib.SCRATCH_DIR}/**)`), 'scratch edit rule');
          assert.ok(probe.path.startsWith(`${lib.SCRATCH_DIR}/`), 'scratch file is inside the scratch folder');
          continue;
        }
        assert.ok(step.claude.some((rule) => bashMatches(rule, probe.command)), `${step.id}: ${probe.command}`);
        for (const guard of catalog.guards) assert.ok(!bashMatches(guard, probe.command), `${guard} would block the probe ${probe.command}`);
      }
    }
    assert.equal(catalog.steps.find((s) => s.id === 'git-push').probes.length, 2, 'one dry-run push per prefix');
    assert.ok(catalog.steps.find((s) => s.id === 'git-push').probes.every((p) => p.command.endsWith(' --dry-run')));
  });

  it('the guards stop every push shape the run must never use and spare ordinary pushes', () => {
    const blocked = [
      'git push --force origin fvs/x', 'git push -u origin fvs/x --force', 'git push origin fvs/x --force-with-lease',
      'git push -f origin fvs/x', 'git push -u origin fvs/x -f', 'git push origin fvs/x --delete', 'git push --delete origin fvs/x',
      'git push -d origin fvs/x', 'git push origin fvs/x --mirror', 'git push origin --all', 'git push origin fvs/x --tags',
      'git push origin +fvs/x', 'git push origin fvs/x:main', 'git push origin fvs/x --prune',
    ];
    for (const command of blocked) assert.ok(lib.GUARDS.some((guard) => bashMatches(guard, command)), command);
    for (const command of ['git push -u origin fvs/fix-foo', 'git push origin fvs/delete-me', 'git push -u origin fvs/permission-check --dry-run']) {
      assert.ok(!lib.GUARDS.some((guard) => bashMatches(guard, command)), command);
    }
  });

  it('states the push shapes no glob can close: they match an allow rule and no guard', () => {
    // A trailing "*" spans spaces and a glob cannot say "no second argument", so these stay allowed by text.
    // The permissions page names them and points at remote branch protection; if a guard ever closes one,
    // move it to the blocked list above and update the page.
    const allowRules = lib.buildCatalog({ repo: REPO }).steps.find((s) => s.id === 'git-push').claude;
    for (const command of ['git push origin fvs/x main', 'git push -u origin fvs/x -uf']) {
      assert.ok(allowRules.some((rule) => bashMatches(rule, command)), command);
      assert.ok(!lib.GUARDS.some((guard) => bashMatches(guard, command)), command);
    }
    assert.match(fs.readFileSync(PAGE, 'utf8').replace(/\s+/g, ' '), /second branch name.*combined short flags.*branch protection/);
  });

  it('every rule the catalog writes passes the rule check, and forbidden rules never do', () => {
    const catalog = lib.buildCatalog({ repo: REPO });
    for (const step of catalog.steps) for (const rule of step.claude) assert.equal(lib.ruleProblem('allow', rule), null, rule);
    for (const guard of catalog.guards) assert.equal(lib.ruleProblem('deny', guard), null, guard);
    for (const rule of [
      'Bash(gh pr comment *)', 'Bash(gh pr review *)', 'Bash(gh pr merge *)', 'Bash(gh pr ready *)', 'Bash(gh api *)', 'Bash(gh issue comment *)',
      'Bash(git push *)', 'Bash(git push --force origin fvs/*)', 'Bash(git push origin main)', 'Bash(git push origin main*)', 'Bash(git push upstream fvs/*)',
      'Bash(git push origin */*)', 'Bash(git push -u upstream fvs/*)', 'Bash(git push origin release/*)', 'Bash(git *)', 'Bash(gh *)', 'Bash(*)', 'Bash(rm *)',
      'Bash(ao stop *)', 'Bash(ao pr merge *)', 'Edit(/.claude/**)', 'Edit(/.git/**)', 'Edit(/../**)', 'Edit(/**)', 'Read(/**)', 'WebFetch',
      // Not rules FVS writes: the spec and proof folders, and draft pull request create and edit, are left to the user.
      'Edit(/formal/**)', 'Bash(gh pr edit *)', `Bash(gh pr create --draft --repo ${REPO} *)`,
    ]) assert.ok(lib.ruleProblem('allow', rule), `should refuse ${rule}`);
    assert.ok(lib.ruleProblem('deny', 'Bash(gh pr comment *)'));
  });

  it('refuses inputs that could widen a push rule', () => {
    for (const bad of ['main', 'master', '*', 'fvs/*', 'a:b', '..', 'a/../b', '-f', '+x', '', 'release/3.0.0-rc2', 'HEAD', 'a b']) {
      assert.throws(() => lib.buildCatalog({ repo: REPO, prefixes: [bad] }), (error) => error.code === 'invalid-input', bad);
    }
    assert.throws(() => lib.buildCatalog({ repo: REPO, remote: 'upstream' }), (error) => error.code === 'upstream-refused');
    assert.throws(() => lib.buildCatalog({ repo: 'not-a-repo' }), (error) => error.code === 'invalid-input');
  });
});

describe('plan', () => {
  it('lists the probes and refuses a remote that is not the project repository', () => {
    const ok = run('plan', base());
    assert.equal(ok.status, 0);
    assert.deepEqual(ok.json.steps.map((s) => s.id), ['worker-message', 'author-edit', 'lake-build', 'gh-read', 'git-read', 'git-push']);
    assert.equal(ok.json.record.present, false);
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
    const none = allow('git-push');
    assert.equal(none.status, 1);
    assert.equal(none.json.code, 'confirmation-required');
    assert.ok(none.json.add.allow.includes('Bash(git push -u origin fvs/*)'));
    assert.ok(none.json.add.deny.length > 0);
    assert.equal(fs.existsSync(settingsFile()), false);
    const wrong = allow('git-push', '--confirm', 'yes');
    assert.equal(wrong.json.code, 'confirmation-required');
    assert.equal(fs.existsSync(settingsFile()), false);
  });

  it('a digest confirmed for one rule set is refused for another', () => {
    const preview = allow('git-push');
    const other = allow('worker-message', '--confirm', preview.json.digest);
    assert.equal(other.json.code, 'confirmation-required');
    assert.equal(fs.existsSync(settingsFile()), false);
  });

  it('merges into an existing file and keeps every other key, rule and the key order', () => {
    const original = {
      $schema: 'https://json.schemastore.org/claude-code-settings.json',
      model: 'opus',
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
    assert.equal(after.permissions.deny, undefined, 'no guard rules without a push step');
    assert.ok(fs.readFileSync(settingsFile(), 'utf8').endsWith('}\n'));
  });

  it('creates the file, adds the guards with the push rules, and is a no-op the second time', () => {
    const done = confirmed('git-push', '--branch-prefix', 'fvs', '--branch-prefix', 'ao');
    assert.equal(done.json.code, 'written');
    const written = readSettings();
    assert.deepEqual(written.permissions.allow, ['Bash(git push -u origin fvs/*)', 'Bash(git push origin fvs/*)', 'Bash(git push -u origin ao/*)', 'Bash(git push origin ao/*)']);
    assert.deepEqual(written.permissions.deny, lib.GUARDS);
    const before = fs.readFileSync(settingsFile(), 'utf8');
    const again = allow('git-push', '--branch-prefix', 'fvs', '--branch-prefix', 'ao');
    assert.equal(again.json.code, 'unchanged');
    assert.equal(fs.readFileSync(settingsFile(), 'utf8'), before);
  });

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

  it('writes through a linked .claude folder and says where the file really is', () => {
    const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-perm-shared-'));
    fs.symlinkSync(shared, path.join(project, '.claude'));
    const done = confirmed('worker-message');
    assert.equal(done.json.code, 'written');
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
    assert.match(second.json.summary, /^recheck .*no step prompted.*allowlist written to \.claude\/settings\.json \(1 allow, 0 deny\)/);
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
    assert.match(waiting, /allowlist written to \.codex\/rules\/fvs-auto\.rules \(1 allow, 0 deny\)/);
    assert.match(waiting, /Codex loads rules at startup: check again in a new session/);
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

  it('refuses without confirmation, then writes only the rules Codex can express', () => {
    const preview = codexAllow('worker-message,git-push,lake-build,gh-read,git-read');
    assert.equal(preview.json.code, 'confirmation-required');
    assert.equal(fs.existsSync(path.join(project, '.codex')), false);
    assert.ok(Object.keys(preview.json.notWritten).includes('git-push'));
    const done = codexConfirmed('worker-message,git-push,lake-build,gh-read,git-read');
    assert.equal(done.json.code, 'written');
    const text = fs.readFileSync(path.join(project, '.codex', 'rules', 'fvs-auto.rules'), 'utf8');
    for (const pattern of ['["ao", "send"]', '["gh", "pr", "view"]', '["gh", "pr", "list"]', '["git", "fetch", "origin"]', '["git", "ls-remote"]']) assert.ok(text.includes(pattern), pattern);
    assert.ok(!/"push"/.test(text.replace(/not_match = \[[^\]]*\]/g, '')), 'no push allow rule');
    assert.equal(codexAllow('worker-message').json.code, 'confirmation-required', 'a different rule set needs its own confirmation');
  });

  it('a step with no Codex rule writes nothing and says why', () => {
    const refused = codexAllow('git-push');
    assert.equal(refused.json.code, 'nothing-to-write');
    assert.match(refused.json.reasons['git-push'], /cannot exclude a force push/);
    assert.equal(fs.existsSync(path.join(project, '.codex')), false);
  });

  it('never overwrites a rules file it did not write', () => {
    const file = path.join(project, '.codex', 'rules', 'fvs-auto.rules');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'prefix_rule(pattern=["ls"], decision="allow")\n');
    assert.equal(codexAllow('worker-message').json.code, 'foreign-file');
    assert.equal(fs.readFileSync(file, 'utf8'), 'prefix_rule(pattern=["ls"], decision="allow")\n');
  });

  it('Codex itself accepts the written file and allows each probe', { skip: !codexOnPath && 'codex CLI not on PATH' }, () => {
    const done = codexConfirmed('worker-message,gh-read,git-read');
    assert.equal(done.json.code, 'written');
    assert.ok(done.json.codexCheck.length >= 5);
    for (const check of done.json.codexCheck) assert.equal(check.decision, 'allow', check.command);
    const file = path.join(project, '.codex', 'rules', 'fvs-auto.rules');
    for (const command of ['gh pr merge 1', 'git push origin main', 'ao stop w']) {
      const out = spawnSync('codex', ['execpolicy', 'check', '--rules', file, ...command.split(' ')], { encoding: 'utf8' });
      assert.deepEqual(JSON.parse(out.stdout).matchedRules, [], command);
    }
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

  it('prints exactly the allowlist the script writes for the documented steps', () => {
    const catalog = lib.buildCatalog({ repo: 'OWNER/REPO' });
    const probed = catalog.steps.filter((s) => s.probes);
    const documented = JSON.parse(block(page(), 'Claude Code allowlist', 'json'));
    assert.deepEqual(documented.permissions.allow, probed.flatMap((s) => s.claude));
    assert.deepEqual(documented.permissions.deny, lib.GUARDS);
    for (const dropped of ['draft-pr-create', 'draft-pr-edit', 'edit-folders', 'gh pr create', 'gh pr edit']) assert.ok(!page().includes(dropped), `${dropped} is no longer written, so the page does not offer it`);
  });

  it('prints exactly the Codex rules the script writes', () => {
    const catalog = lib.buildCatalog({ repo: 'OWNER/REPO' });
    const text = block(page(), 'Codex rules', 'python');
    const rules = catalog.steps.flatMap((s) => s.codex);
    assert.equal((text.match(/prefix_rule\(/g) ?? []).length, rules.length);
    for (const rule of rules) assert.ok(text.includes(`pattern = [${rule.pattern.map((p) => JSON.stringify(p)).join(', ')}]`), rule.pattern.join(' '));
    assert.ok(!/decision = "(prompt|forbidden)"/.test(text));
  });

  it('every probe command in the page is one the plan prints', () => {
    const catalog = lib.buildCatalog({ repo: 'OWNER/REPO' });
    const commands = catalog.steps.flatMap((s) => (s.probes ?? []).filter((p) => p.command).map((p) => p.command));
    for (const command of commands) assert.ok(page().includes(command), command);
  });
});
