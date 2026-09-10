const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const child = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');

test('shared provider confines diagnostic writes and preserves failed attempts', async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-probes-')));
  const original = child.spawnSync;
  let version = '2.1.267', failed = false;
  const calls = [];
  child.spawnSync = (runtime, args, options) => {
    calls.push({ runtime, args, options });
    return { status: failed && args.includes('--print') ? 1 : 0,
      stdout: args[0] === '--version' ? version : JSON.stringify({ result: 'raw response', modelUsage: { requested: {} } }),
      stderr: failed ? 'sandbox unavailable' : '' };
  };
  syncBuiltinESMExports();
  try {
    const { runReviewer, lakeWriteDirectories } = await import('../scripts/fvs-spec-review.mjs');
    const artifactDirectory = path.join(project, 'records');
    fs.mkdirSync(artifactDirectory);
    fs.mkdirSync(path.join(project, '.lake/packages/pkg/.lake/build'), { recursive: true });
    fs.writeFileSync(path.join(project, 'lakefile.toml'), 'name = "fixture"');
    const request = { runtime: 'claude', model: 'exact-model', effort: 'max', prompt: 'review',
      workingRoot: project, artifactDirectory };
    assert.equal(runReviewer(request).response, 'raw response');
    const call = calls.find(c => c.args.includes('--print'));
    const value = flag => call.args[call.args.indexOf(flag) + 1];
    const settings = JSON.parse(value('--settings'));
    assert.equal(value('--model'), 'exact-model');
    assert.equal(value('--effort'), 'max');
    assert.equal(value('--tools'), 'Read,Glob,Grep,Bash');
    assert.equal(value('--setting-sources'), '');
    assert.equal(value('--permission-mode'), 'dontAsk');
    assert.ok(!call.args.includes('--add-dir'));
    assert.notEqual(call.options.cwd, project);
    assert.equal(settings.sandbox.failIfUnavailable, true);
    assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
    assert.equal(settings.sandbox.filesystem.disabled, false);
    assert.deepEqual(settings.sandbox.excludedCommands, []);
    assert.deepEqual(settings.sandbox.network.allowedDomains, []);
    assert.equal(settings.sandbox.network.strictAllowlist, true);
    assert.equal(settings.sandbox.filesystem.allowWrite.length, 4);
    assert.ok(settings.sandbox.filesystem.allowWrite.every(p => /\.lake\/(build|config)$/.test(p)));
    const record = path.join(artifactDirectory, fs.readdirSync(artifactDirectory)[0]);
    assert.equal(fs.readFileSync(path.join(record, 'prompt.md'), 'utf8'), call.options.input);
    assert.equal(JSON.parse(fs.readFileSync(path.join(record, 'process.json'))).status, 0);
    failed = true;
    assert.throws(() => runReviewer(request), /sandbox unavailable.*\nReview attempt preserved/);
    assert.equal(fs.readdirSync(artifactDirectory).length, 2);
    version = '2.1.266';
    assert.throws(() => runReviewer(request), /require Claude Code >= 2.1.267/);
    fs.symlinkSync(project, path.join(project, '.lake/build'));
    assert.throws(() => lakeWriteDirectories(project), /redirected/);
    fs.unlinkSync(path.join(project, '.lake/build'));
    fs.symlinkSync(path.join(project, 'absent'), path.join(project, '.lake/build'));
    assert.throws(() => lakeWriteDirectories(project), /redirected/);
  } finally {
    child.spawnSync = original;
    syncBuiltinESMExports();
    fs.rmSync(project, { recursive: true, force: true });
  }
});
