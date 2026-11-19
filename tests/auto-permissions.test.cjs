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
function run(command, args, env) {
  const result = spawnSync(process.execPath, [SCRIPT, command, ...args], { encoding: 'utf8', ...(env ? { env } : {}) });
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

const otherHookSteps = (catalog) => catalog.steps.filter((s) => s.hook && s.id !== 'git-push').map((s) => s.id);

// How Claude Code reads a Bash rule: "*" stands for any text, and a trailing " *" also matches the bare command.
function bashMatches(rule, command) {
  const body = /^Bash\((.*)\)$/s.exec(rule)[1];
  const escape = (text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const trailing = body.endsWith(' *') && body.split('*').length === 2;
  const source = trailing ? `${escape(body.slice(0, -2))}( .*)?` : body.split('*').map(escape).join('.*');
  return new RegExp(`^${source}$`, 's').test(command);
}

describe('the catalog', () => {
  it('every probe is matched by a rule of its own step, except the push probe, which no rule matches', () => {
    const catalog = lib.buildCatalog({ repo: REPO, prefixes: ['fvs', 'team/runs'] });
    for (const step of catalog.steps.filter((s) => s.probes)) {
      for (const probe of step.probes) {
        if (probe.tool === 'Write') {
          assert.ok(step.claude.includes(`Edit(/${lib.SCRATCH_DIR}/**)`), 'scratch edit rule');
          assert.ok(probe.path.startsWith(`${lib.SCRATCH_DIR}/`), 'scratch file is inside the scratch folder');
          continue;
        }
        if (step.id === 'git-push') continue;
        assert.ok(step.claude.some((rule) => bashMatches(rule, probe.command)), `${step.id}: ${probe.command}`);
      }
    }
    const push = catalog.steps.find((s) => s.id === 'git-push');
    assert.equal(push.probes.length, 2, 'one dry-run push per prefix');
    assert.ok(push.probes.every((p) => p.command.endsWith(' --dry-run')));
    assert.deepEqual(push.claude, [], 'no allow rule for a push');
    assert.match(push.hook.command, /^node "[^"]+\/fvs-auto-push-gate\.mjs" --repo Acme\/proj --host github\.com --remote origin --prefix fvs --prefix team\/runs$/);
    assert.equal(lib.hookProblem(push.hook.command), null);
    assert.deepEqual(otherHookSteps(catalog), [], 'no other step installs a hook');
  });

  it('no rule the catalog writes matches any push, whatever its spelling', () => {
    const catalog = lib.buildCatalog({ repo: REPO, prefixes: ['fvs', 'ao'] });
    const rules = catalog.steps.flatMap((s) => s.claude).filter((rule) => rule.startsWith('Bash('));
    for (const command of [
      'git push origin fvs/x', 'git push -u origin fvs/x', 'git push origin fvs/x main', 'git push -u origin fvs/x -uf', 'git push --force origin fvs/x',
      'git push origin fvs/x --delete', 'git push origin fvs/x:main', 'git -C /a push origin fvs/x', 'git push', 'git push origin main',
      'git push -u origin fvs/permission-check --dry-run',
    ]) assert.ok(!rules.some((rule) => bashMatches(rule, command)), command);
    assert.equal(lib.GUARDS, undefined, 'FVS writes no deny rules either');
  });

  it('every rule the catalog writes passes the rule check, and forbidden rules never do', () => {
    const catalog = lib.buildCatalog({ repo: REPO });
    for (const step of catalog.steps) for (const rule of step.claude) assert.equal(lib.ruleProblem('allow', rule), null, rule);
    for (const rule of [
      'Bash(gh pr comment *)', 'Bash(gh pr review *)', 'Bash(gh pr merge *)', 'Bash(gh pr ready *)', 'Bash(gh api *)', 'Bash(gh issue comment *)',
      // A glob never allows a push, in any spelling: the push gate hook decides pushes, not a rule.
      'Bash(git push *)', 'Bash(git push --force origin fvs/*)', 'Bash(git push origin main)', 'Bash(git push origin main*)', 'Bash(git push upstream fvs/*)',
      'Bash(git push origin */*)', 'Bash(git push -u upstream fvs/*)', 'Bash(git push origin release/*)', 'Bash(git push origin fvs/*)', 'Bash(git push -u origin fvs/*)',
      'Bash(git -C * push origin fvs/*)', 'Bash(git * push *)', 'Bash(git *)', 'Bash(gh *)', 'Bash(*)', 'Bash(rm *)',
      'Bash(ao stop *)', 'Bash(ao pr merge *)', 'Edit(/.claude/**)', 'Edit(/.git/**)', 'Edit(/../**)', 'Edit(/**)', 'Read(/**)', 'WebFetch',
      // Not rules FVS writes: the spec and proof folders, and draft pull request create and edit, are left to the user.
      'Edit(/formal/**)', 'Bash(gh pr edit *)', `Bash(gh pr create --draft --repo ${REPO} *)`,
    ]) assert.ok(lib.ruleProblem('allow', rule), `should refuse ${rule}`);
    for (const text of ['Bash(gh pr comment *)', 'Bash(git push *--force*)', 'Bash(git push *:*)']) assert.ok(lib.ruleProblem('deny', text), 'FVS writes no deny rule');
    assert.ok(lib.ruleProblem('ask', 'Bash(ao send *)'));
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

describe('the push gate hook install', () => {
  const GATE = path.join(ROOT, 'scripts', 'fvs-auto-push-gate.mjs');
  const command = `node "${GATE}" --repo ${REPO} --host github.com --remote origin --prefix fvs`;
  const entry = { matcher: 'Bash', hooks: [{ type: 'command', command, timeout: 15 }] };

  it('shows the exact hook and what it allows and asks, and writes nothing before the yes', () => {
    const preview = allow('git-push');
    assert.equal(preview.status, 1);
    assert.equal(preview.json.code, 'confirmation-required');
    assert.deepEqual(preview.json.add, { allow: [], hook: command });
    assert.deepEqual(preview.json.hook.entry, entry);
    assert.equal(preview.json.hook.event, 'PreToolUse');
    assert.equal(preview.json.hook.script, GATE);
    assert.match(preview.json.hook.allows.join(' '), /git push \[-u\] origin fvs\/<name>.*bare `git push`/);
    assert.match(preview.json.hook.destination, /github\.com\/Acme\/proj/);
    assert.match(preview.json.hook.asks, /every other command it recognises as a push/);
    assert.match(preview.json.hook.note, /--target local/);
    // The hook gives no decision for a push it does not recognise and when it does not run: that is not an allow, and not an ask.
    assert.match(preview.json.hook.noDecision, /no decision: it neither allows nor asks, and your other rules and permission mode decide/);
    assert.match(preview.json.hook.noDecision, /does not recognise as one.*missing Node.*15-second timeout.*non-blocking/);
    assert.doesNotMatch(JSON.stringify(preview.json), /fails safe|asks as usual/);
    assert.equal(fs.existsSync(path.join(project, '.claude')), false);
    assert.equal(allow('git-push', '--confirm', 'anything').json.code, 'confirmation-required');
    assert.equal(fs.existsSync(path.join(project, '.claude')), false);
  });

  it('the digest covers the hook, so a confirmation for other rules does not install it', () => {
    const other = allow('git-read').json.digest;
    assert.equal(allow('git-push', '--confirm', other).json.code, 'confirmation-required');
    const both = allow('git-read,git-push').json;
    assert.notEqual(both.digest, other);
    assert.equal(allow('git-read', '--confirm', both.digest).json.code, 'confirmation-required');
  });

  it('writes the hook after the yes, with no push rule and no deny rule', () => {
    const done = confirmed('git-push');
    assert.equal(done.json.code, 'written');
    const written = readSettings();
    assert.deepEqual(written, { hooks: { PreToolUse: [entry] } });
    assert.match(done.json.notes.join(' '), /Branch protection on the project fork is still recommended/);
    assert.match(done.json.verification, /whether Claude Code skips its prompt on an allow answer was not observed/);
    const before = fs.readFileSync(settingsFile(), 'utf8');
    assert.equal(allow('git-push').json.code, 'unchanged');
    assert.equal(fs.readFileSync(settingsFile(), 'utf8'), before, 'a second write changes nothing');
  });

  it('next to other steps it adds those steps\' rules and the hook, and still no push rule', () => {
    const done = confirmed('git-push,worker-message');
    assert.equal(done.json.code, 'written');
    const written = readSettings();
    assert.deepEqual(written.permissions.allow, ['Bash(ao send *)']);
    assert.deepEqual(written.hooks.PreToolUse, [entry]);
    assert.ok(!JSON.stringify(written.permissions).includes('push'), 'no push rule of any kind');
  });

  it('appends one entry and keeps every other key, rule, hook and the key order', () => {
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
    assert.deepEqual(Object.keys(after.hooks), ['PreToolUse', 'PostToolUse']);
    assert.deepEqual(after.hooks.PreToolUse, [...original.hooks.PreToolUse, entry]);
    assert.deepEqual(after.hooks.PostToolUse, original.hooks.PostToolUse);
    assert.deepEqual(after.permissions, original.permissions, 'the owner\'s own deny rule is kept and no rule is added');
    assert.deepEqual(after.env, original.env);
  });

  it('works for the local file too', () => {
    const done = confirmed('git-push', '--target', 'local');
    assert.equal(done.json.code, 'written');
    assert.equal(done.json.file, '.claude/settings.local.json');
    assert.deepEqual(readSettings('settings.local.json'), { hooks: { PreToolUse: [entry] } });
    assert.equal(fs.existsSync(settingsFile()), false);
  });

  it('refuses to replace or edit a push gate entry that differs, and says how to resolve it', () => {
    const stale = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "/old/place/fvs-auto-push-gate.mjs" --repo Acme/proj --prefix fvs' }] };
    writeSettings({ hooks: { PreToolUse: [stale] } });
    const before = fs.readFileSync(settingsFile(), 'utf8');
    const refused = allow('git-push');
    assert.equal(refused.json.code, 'push-gate-conflict');
    assert.match(refused.json.message, /does not replace or edit it.*Remove that entry yourself/);
    assert.deepEqual(refused.json.existing, [stale.hooks[0].command]);
    assert.equal(refused.json.wouldAdd, command);
    assert.equal(allow('git-push', '--confirm', 'anything').json.code, 'push-gate-conflict');
    assert.equal(fs.readFileSync(settingsFile(), 'utf8'), before);
  });

  it('treats the same entry as already installed, and adds beside an entry that is not the gate', () => {
    writeSettings({ hooks: { PreToolUse: [entry] } });
    assert.equal(allow('git-push').json.code, 'unchanged');
    writeSettings({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node other-hook.mjs' }] }, 'not an entry', null] } });
    assert.equal(confirmed('git-push').json.code, 'written');
    assert.equal(readSettings().hooks.PreToolUse.length, 4);
  });

  it('refuses a hooks section of the wrong shape and leaves the file untouched', () => {
    for (const text of ['{ "hooks": [] }', '{ "hooks": "x" }', '{ "hooks": { "PreToolUse": {} } }', '{ "hooks": { "PreToolUse": "x" } }']) {
      writeSettings(text);
      assert.equal(allow('git-push').json.code, 'malformed-settings', text);
      assert.equal(fs.readFileSync(settingsFile(), 'utf8'), text);
    }
  });

  it('names every namespace and the host in the command', () => {
    spawnSync('git', ['-C', project, 'remote', 'set-url', 'origin', `https://git.example.com/${REPO}.git`]);
    const preview = allow('git-push', '--branch-prefix', 'fvs', '--branch-prefix', 'team/runs', '--host', 'git.example.com').json;
    assert.equal(preview.add.hook, `node "${GATE}" --repo ${REPO} --host git.example.com --remote origin --prefix fvs --prefix team/runs`);
  });

  it('only the exact command shape passes the second check', () => {
    assert.equal(lib.hookProblem(command), null);
    for (const bad of [
      `${command}; rm -rf /`, `${command} && true`, `${command} | cat`, `${command}\nid`, `${command} $(id)`, `${command} --prefix main*`, `${command} --prefix "x"`,
      `node "/x/other.mjs" --repo ${REPO}`, `sh "${GATE}" --repo ${REPO}`, `node ${GATE} --repo ${REPO}`, `node "${GATE}"`, `node "${GATE}" --bogus x`,
      `node "/a\\"b/fvs-auto-push-gate.mjs" --repo ${REPO}`, 'node "/a$HOME/fvs-auto-push-gate.mjs" --repo A/b', 'node "/a`id`/fvs-auto-push-gate.mjs" --repo A/b', '',
    ]) assert.ok(lib.hookProblem(bad), JSON.stringify(bad));
  });

  it('the installed command runs as written: it allows the exact push and asks for the rest', () => {
    const installed = confirmed('git-push').json;
    assert.equal(installed.code, 'written');
    const written = readSettings().hooks.PreToolUse[0].hooks[0].command;
    const hook = (cmd) => {
      const run = spawnSync('sh', ['-c', written], {
        cwd: project, encoding: 'utf8', input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd }, cwd: project }),
        env: { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` },
      });
      return { status: run.status, decision: run.stdout ? JSON.parse(run.stdout).hookSpecificOutput.permissionDecision : null };
    };
    assert.deepEqual(hook('git push -u origin fvs/work'), { status: 0, decision: 'allow' });
    assert.deepEqual(hook('git push origin fvs/work main'), { status: 0, decision: 'ask' });
    assert.deepEqual(hook('git push -u origin fvs/work -uf'), { status: 0, decision: 'ask' });
    assert.deepEqual(hook('git push origin main'), { status: 0, decision: 'ask' });
    assert.deepEqual(hook('git status'), { status: 0, decision: null });
    spawnSync('git', ['-C', project, 'remote', 'set-url', '--push', 'origin', 'git@github.com:Upstream/proj.git']);
    assert.deepEqual(hook('git push -u origin fvs/work'), { status: 0, decision: 'ask' }, 'a push URL that changed after init is caught at the push');
  });

  it('Codex gets no hook: a push selection there writes nothing and says why', () => {
    const refused = run('write-allowlist', base('--runtime', 'codex', '--steps', 'git-push'));
    assert.equal(refused.json.code, 'nothing-to-write');
    assert.match(refused.json.reasons['git-push'], /no push gate hook/);
    assert.equal(fs.existsSync(path.join(project, '.codex')), false);
  });

  it('the summary says the hook was installed', () => {
    const file = path.join(project, 'answer.json');
    fs.writeFileSync(file, JSON.stringify({ runtime: 'claude', kind: 'check', results: { 'git-push': 'prompted' } }));
    assert.equal(run('record', base('--input', file)).json.code, 'recorded');
    assert.equal(confirmed('git-push').json.code, 'written');
    const summary = run('plan', base()).json.record.summary;
    assert.match(summary, /allowlist written to \.claude\/settings\.json \(0 allow, push gate hook\)/);
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
    assert.equal(codexAllow('worker-message').json.code, 'rules-file-conflict', 'a different rule set is refused, not merged');
    assert.equal(fs.readFileSync(path.join(project, '.codex', 'rules', 'fvs-auto.rules'), 'utf8'), text, 'the written file is unchanged');
  });

  it('a step with no Codex rule writes nothing, says why, and leaves its prompt unresolved', () => {
    for (const step of ['git-push', 'lake-build', 'author-edit']) {
      const refused = codexAllow(step);
      assert.equal(refused.json.code, 'nothing-to-write', step);
      assert.match(refused.json.message, /prompts stay unresolved/);
      assert.ok(refused.json.reasons[step].length > 10, step);
    }
    assert.match(codexAllow('git-push').json.reasons['git-push'], /cannot exclude a force push/);
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
    return { PATH: bin, HOME: process.env.HOME };
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
    for (const steps of ['worker-message', 'git-push', 'worker-message,git-push,gh-read']) {
      const out = allow(steps);
      assert.equal(out.status, 1, steps);
      assert.equal(out.json.code, 'legacy-push-rules', steps);
      assert.deepEqual(out.json.legacyPushRules, [{ file: '.claude/settings.json', resolvedPath: path.join(fs.realpathSync(project), '.claude', 'settings.json'), rules: [LEGACY, 'Bash(git push:*)'], keeps: 2 }]);
      assert.match(out.json.cleanup[0], /delete these 2 entries from permissions\.allow and nothing else.*"Bash\(git push origin fvs\/\*\)".*The other 2 allow entries stay/);
      assert.match(out.json.message, /FVS writes no push rule and deletes none/);
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

  it('repeats the probes of the steps that last prompted, never the push step, and says how to record them', () => {
    answer({ runtime: 'claude', kind: 'check', results: { 'worker-message': 'prompted', 'gh-read': 'prompted', 'git-read': 'quiet', 'git-push': 'prompted', 'author-edit': 'unknown' } });
    const out = recheck();
    assert.equal(out.status, 0);
    assert.equal(out.json.mode, 'recheck');
    assert.deepEqual(ids(out), ['worker-message', 'gh-read', 'git-push']);
    const byId = Object.fromEntries(out.json.steps.map((s) => [s.id, s]));
    assert.equal(byId['worker-message'].probes.length, 1);
    assert.equal(byId['gh-read'].probes.length, 2);
    assert.equal(byId['git-push'].probes, null);
    assert.match(byId['git-push'].skipped, /not repeated.*first real worker push.*Keep its earlier answer/);
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

  it('prints exactly the allowlist the script writes for the documented steps', () => {
    const catalog = lib.buildCatalog({ repo: 'OWNER/REPO' });
    const probed = catalog.steps.filter((s) => s.probes);
    const documented = JSON.parse(block(page(), 'Claude Code allowlist', 'json'));
    assert.deepEqual(documented.permissions.allow, probed.flatMap((s) => s.claude));
    assert.equal(documented.permissions.deny, undefined, 'the page lists no deny rules, because FVS writes none');
    assert.ok(!JSON.stringify(documented).includes('push'), 'the page lists no push rule');
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

  it('prints exactly the hook entry the script installs, with the scripts folder as a placeholder', () => {
    const hook = lib.buildCatalog({ repo: 'OWNER/REPO' }).steps.find((s) => s.id === 'git-push').hook;
    const expected = structuredClone(hook.entry);
    expected.hooks[0].command = expected.hooks[0].command.replace(hook.script, '<FVS scripts folder>/fvs-auto-push-gate.mjs');
    assert.deepEqual(JSON.parse(block(page(), 'Push gate hook', 'json')), { hooks: { PreToolUse: [expected] } });
  });

  it('keeps the push gate honest: branch protection stays recommended, and no push rule is offered', () => {
    const text = page().replace(/\s+/g, ' ');
    assert.match(text, /Branch protection on the project fork is still recommended/);
    assert.match(text, /There is no hook for Codex, and a Codex rule cannot say "but not `--force`"\. Init writes no push rule for Codex, so a push there follows Codex's own rules and sandbox mode/);
    assert.match(text, /A hook that answers "allow" skips the prompt, but it does not override your own `deny` or `ask` rules/);
    // The page names a push allow rule only as something to delete, never inside a block that shows what FVS writes.
    const blocks = [...page().matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((match) => match[1]);
    assert.ok(blocks.length >= 3);
    for (const code of blocks) assert.ok(!/Bash\(git push/.test(code), 'no block of the page shows a push rule');
  });

  it('makes no unconditional promise that a push asks, and says that no decision is not an allow', () => {
    const docs = [PAGE, 'fv-skills/workflows/auto-init.md', 'fv-skills/references/auto-setup.md', 'commands/fvs/auto-init.md', 'README.md', 'scripts/fvs-auto-permissions.mjs']
      .map((file) => [file, fs.readFileSync(path.isAbsolute(file) ? file : path.join(ROOT, file), 'utf8').replace(/\s+/g, ' ')]);
    for (const [file, text] of docs) {
      assert.doesNotMatch(text, /fails? safe|asks as usual|asks for every other push|every other push (still )?asks|a push (still |keeps )asks|a push keeps asking|every push that is not an exact (plain )?form/i, file);
    }
    const text = page().replace(/\s+/g, ' ');
    assert.match(text, /## Push gate hook[\s\S]*### When the hook gives no decision/);
    assert.match(text, /It gives \*\*no decision\*\*, neither allow nor ask, in these cases:/);
    assert.match(text, /not recognised as a push[\s\S]*Node is not installed[\s\S]*script fails[\s\S]*15-second timeout/);
    assert.match(text, /"No decision" is not an allow\. It leaves your other `allow` and `ask` rules, your `deny` rules and your permission mode in charge/);
    assert.match(text, /Claude Code documents a hook that cannot start, a timeout and a failing hook as non-blocking/);
  });

  it('documents the push allow rule refusal, the confirmation binding and the recheck entry point', () => {
    const text = page().replace(/\s+/g, ' ');
    assert.match(text, /### Push allow rules already in your settings/);
    assert.match(text, /a Claude write stops with `legacy-push-rules`, before any preview and before anything is written\. Both files stay byte-identical/);
    assert.match(text, /does not see: broad rules such as `Bash\(git \*\)` or `Bash\(\*\)`, your user settings/);
    assert.match(text, /The digest covers the exact rules and hook, the canonical project root, the real path of the file .* and the hash of the file's current content/);
    assert.match(text, /a new digest that needs a new yes/);
    assert.match(text, /an edit made in the instant between that last check and the replacement is not detected/);
    assert.match(text, /ask init to recheck permissions: it runs `recheck`/);
    assert.match(text, /To start over, delete the record file yourself/);
    assert.doesNotMatch(text, /To run the check again, delete that file/);
    assert.doesNotMatch(text, /a mismatch makes the hook ask, not allow/);
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
    const catalog = lib.buildCatalog({ repo: 'OWNER/REPO' });
    const commands = catalog.steps.flatMap((s) => (s.probes ?? []).filter((p) => p.command).map((p) => p.command));
    for (const command of commands) assert.ok(page().includes(command), command);
  });
});
