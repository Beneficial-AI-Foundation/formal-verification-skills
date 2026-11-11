const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');

for (const relative of ['scripts/fvs-auto-respec.mjs', 'plugins/fvs/scripts/fvs-auto-respec.mjs']) {
  for (const operation of ['inspect', 'finish']) test(`${relative}: public human ${operation} refuses before request reads or effects`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-respec-withheld-'));
    try {
      const project = path.join(root, 'project with spaces'), nested = path.join(project, 'nested');
      fs.mkdirSync(nested, { recursive: true });
      const state = path.join(project, 'retained-state.json');
      fs.writeFileSync(state, '{"history":"keep","accepted":"historical only"}\n');
      const request = path.join(root, 'request.json'), read = path.join(root, 'request-read'), dispatched = path.join(root, 'dispatched');
      fs.writeFileSync(request, JSON.stringify({ schema: 'fvs/auto-respec-request', schemaVersion: 2, operation }));
      const preload = path.join(root, 'no-effects.cjs');
      fs.writeFileSync(preload, `
const fs = require('node:fs'), cp = require('node:child_process');
const read = fs.readFileSync, open = fs.openSync;
fs.openSync = function(file, ...rest) {
  if (String(file) === process.env.FVS_TEST_REQUEST) fs.writeFileSync(process.env.FVS_TEST_READ, 'request opened');
  return open.call(this, file, ...rest);
};
fs.readFileSync = function(file, ...rest) {
  if (String(file) === process.env.FVS_TEST_REQUEST) fs.writeFileSync(process.env.FVS_TEST_READ, 'request read');
  return read.call(this, file, ...rest);
};
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) cp[name] = () => {
  fs.writeFileSync(process.env.FVS_TEST_DISPATCH, name); throw Error('unexpected dispatch');
};
require('node:module').syncBuiltinESMExports();
`);
      for (const cwd of [project, nested]) {
        const out = path.join(root, cwd === project ? 'root-out' : 'nested-out');
        const p = spawnSync(process.execPath, ['--require', preload, path.join(ROOT, relative), operation, '--request', request, '--out', out], {
          cwd, encoding: 'utf8', timeout: 5000,
          env: { PATH: '/usr/bin:/bin', LEAN_NUM_THREADS: '2', FVS_TEST_REQUEST: request, FVS_TEST_READ: read, FVS_TEST_DISPATCH: dispatched },
        });
        assert.equal(p.error, undefined, p.stderr);
        const body = JSON.parse(p.stdout);
        assert.deepEqual({ exit: p.status, status: body.status, code: body.code, read: fs.existsSync(read), dispatched: fs.existsSync(dispatched), output: fs.existsSync(out) },
          { exit: 7, status: 'unsupported', code: 'respec-unsupported', read: false, dispatched: false, output: false });
        assert.match(body.message, /3\.0\.0-rc1/);
        assert.equal(fs.readFileSync(state, 'utf8'), '{"history":"keep","accepted":"historical only"}\n');
      }
      const missing = spawnSync(process.execPath, [path.join(ROOT, relative), operation, '--request', path.join(root, 'absent'), '--out', path.join(root, 'absent-out')], { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin', LEAN_NUM_THREADS: '2' } });
      assert.equal(JSON.parse(missing.stdout).code, 'respec-unsupported');
      assert.equal(fs.existsSync(path.join(root, 'absent-out')), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test('public AUTO feedback routes stop before continuation and retain initial/safe-resume guards', () => {
  for (const rel of ['commands/fvs/auto.md', 'commands/fvs/auto-init.md', 'commands/fvs/auto-execute.md', 'commands/fvs/resume-work.md', 'fv-skills/workflows/auto-init.md', 'fv-skills/workflows/auto-execute.md', 'fv-skills/references/auto-resume.md']) {
    const body = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(body, /Rc1 human-feedback boundary/, rel);
    assert.match(body, /unsupported: human re-specification is not available in 3\.0\.0-rc1/, rel);
    assert.match(body, /stop before[\s\S]*revision effects or provider dispatch/, rel);
    assert.match(body, /Initial autonomous specify\/review\/revise\/prove and ordinary safe resume remain available/, rel);
  }
});
