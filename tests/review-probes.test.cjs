const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Real native process groups, not mocked process objects or skipped cross-platform claims.
test('native reviewer deadline covers probes and inherited pipes', async t => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-probes-')));
  const bin = path.join(project, 'bin');
  const records = path.join(project, 'records');
  fs.mkdirSync(bin); fs.mkdirSync(records);
  const fake = `#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const mode = process.env.FVS_FAKE_MODE;
if (args[0] === '--version' || args[0] === 'auth') {
  if ((mode === 'auth' && args[0] === 'auth') ||
      (mode === 'version' && args[0] === '--version')) setInterval(() => {}, 1000);
  else console.log(process.env.FVS_FAKE_VERSION || '2.1.267');
} else if (mode === 'failed') { process.stderr.write('sandbox unavailable'); process.exitCode = 9; }
else {
  fs.writeFileSync(process.env.FVS_FAKE_STDIN_FILE, fs.readFileSync(0));
  console.log(JSON.stringify({result:'valid-looking review', modelUsage:{requested:{}}}));
  if (mode === 'root-exited' || mode === 'root-alive') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:['ignore','inherit','inherit']});
    fs.writeFileSync(process.env.FVS_FAKE_PID_FILE, String(child.pid));
    if (mode === 'root-alive') setInterval(() => {}, 1000);
  }
}
`;
  for (const name of ['codex', 'claude']) {
    fs.writeFileSync(path.join(bin, name), fake, { mode: 0o755 });
  }
  const previous = { PATH: process.env.PATH, FVS_FAKE_MODE: process.env.FVS_FAKE_MODE,
    FVS_FAKE_PID_FILE: process.env.FVS_FAKE_PID_FILE,
    FVS_FAKE_STDIN_FILE: process.env.FVS_FAKE_STDIN_FILE, FVS_FAKE_VERSION: process.env.FVS_FAKE_VERSION,
    FVS_REVIEW_TIMEOUT_MS: process.env.FVS_REVIEW_TIMEOUT_MS,
    FVS_REVIEW_AUTH_TIMEOUT_MS: process.env.FVS_REVIEW_AUTH_TIMEOUT_MS };
  Object.assign(process.env, { PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    FVS_REVIEW_TIMEOUT_MS: '3500', FVS_REVIEW_AUTH_TIMEOUT_MS: '2500',
    FVS_FAKE_PID_FILE: path.join(project, 'pid'), FVS_FAKE_STDIN_FILE: path.join(project, 'stdin') });
  try {
    const { runReviewer, lakeWriteDirectories } = await import('../scripts/fvs-spec-review.mjs');
    const request = { runtime: 'claude', model: 'exact-model', effort: 'max', prompt: 'review',
      workingRoot: project, artifactDirectory: records };
    fs.mkdirSync(path.join(project, '.lake/packages/pkg/.lake/build'), { recursive: true });
    fs.writeFileSync(path.join(project, 'lakefile.toml'), 'name = "fixture"');
    if (!['darwin', 'linux'].includes(process.platform)) {
      await assert.rejects(runReviewer(request), /Unsupported reviewer process cleanup/);
      t.diagnostic(`UNSUPPORTED ${process.platform}: failed closed before native provider launch; no cleanup claim`);
      return;
    }
    const ok = await runReviewer(request);
    assert.equal(ok.response, 'valid-looking review');
    const attempt = () => path.join(records, fs.readdirSync(records).at(-1));
    const launch = JSON.parse(fs.readFileSync(path.join(attempt(), 'launch.json')));
    const value = flag => launch.args[launch.args.indexOf(flag) + 1];
    const settings = JSON.parse(value('--settings'));
    assert.equal(value('--model'), 'exact-model');
    assert.equal(value('--effort'), 'max');
    assert.equal(value('--tools'), 'Read,Glob,Grep,Bash');
    assert.equal(value('--setting-sources'), '');
    assert.equal(value('--permission-mode'), 'dontAsk');
    assert.ok(!launch.args.includes('--add-dir'));
    assert.notEqual(launch.cwd, project);
    assert.equal(settings.sandbox.failIfUnavailable, true);
    assert.equal(settings.sandbox.allowUnsandboxedCommands, false);
    assert.equal(settings.sandbox.filesystem.disabled, false);
    assert.deepEqual(settings.sandbox.excludedCommands, []);
    assert.deepEqual(settings.sandbox.network.allowedDomains, []);
    assert.equal(settings.sandbox.network.strictAllowlist, true);
    assert.equal(settings.sandbox.filesystem.allowWrite.length, 4);
    assert.ok(settings.sandbox.filesystem.allowWrite.every(p => /\.lake\/(build|config)$/.test(p)));
    assert.equal(fs.readFileSync(path.join(attempt(), 'prompt.md'), 'utf8'),
      fs.readFileSync(path.join(project, 'stdin'), 'utf8'), 'provider receives the saved prompt');
    assert.equal(fs.readFileSync(path.join(attempt(), 'provider-stdout.bin')).toString('utf8').includes('valid-looking'), true);
    const success = JSON.parse(fs.readFileSync(path.join(attempt(), 'process.json')));
    assert.equal(success.status, 0);
    assert.equal(success.phase, 'review');
    const crypto = require('node:crypto');
    for (const stream of ['stdout', 'stderr']) {
      assert.equal(success[`${stream}Sha256`], crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(attempt(), `provider-${stream}.bin`))).digest('hex'));
    }
    assert.equal(JSON.parse(fs.readFileSync(path.join(attempt(), 'request.json'))).reviewTimeoutMs, 3500);
    assert.equal(JSON.parse(fs.readFileSync(path.join(attempt(), 'request.json'))).authTimeoutMs, 2500);
    for (const mode of ['failed', 'version', 'auth', 'root-alive', 'root-exited']) {
      process.env.FVS_FAKE_MODE = mode;
      const before = new Set(fs.readdirSync(records));
      const started = Date.now();
      await assert.rejects(runReviewer(request), /Review attempt preserved/);
      assert.ok(Date.now() - started < 6500, `${mode} bounded`);
      const record = path.join(records, fs.readdirSync(records).find(name => !before.has(name)));
      const receipt = JSON.parse(fs.readFileSync(path.join(record, mode === 'auth' || mode === 'version' ? `${mode}-process.json` : 'process.json')));
      assert.equal(receipt.timedOut, ['version', 'auth', 'root-alive', 'root-exited'].includes(mode));
      if (mode.startsWith('root-')) {
        assert.equal(receipt.closed, true);
        assert.equal(receipt.reason, 'deadline');
        const pid = Number(fs.readFileSync(path.join(project, 'pid'), 'utf8'));
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.throws(() => process.kill(pid, 0), /ESRCH/);
        assert.equal(receipt.cleanup, 'group-terminated');
        assert.ok(fs.readFileSync(path.join(record, 'provider-stdout.bin')).includes(Buffer.from('valid-looking')));
      }
      assert.ok(fs.existsSync(path.join(record, 'error.txt')));
      assert.equal(receipt.stdoutSha256, crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(record, `${mode === 'auth' || mode === 'version' ? `${mode}-` : ''}provider-stdout.bin`))).digest('hex'));
    }
    delete process.env.FVS_FAKE_MODE;
    process.env.FVS_FAKE_VERSION = '2.1.266';
    await assert.rejects(runReviewer(request), /require Claude Code >= 2.1.267/);
    fs.symlinkSync(project, path.join(project, '.lake/build'));
    assert.throws(() => lakeWriteDirectories(project), /redirected/);
    fs.unlinkSync(path.join(project, '.lake/build'));
    fs.symlinkSync(path.join(project, 'absent'), path.join(project, '.lake/build'));
    assert.throws(() => lakeWriteDirectories(project), /redirected/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(project, { recursive: true, force: true });
  }
});
