'use strict';
const { it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const SCRIPT = path.resolve(__dirname, '../scripts/fvs-checker.mjs');
const directories = [];
after(() => { for (const dir of directories) fs.rmSync(dir, { recursive: true, force: true }); });
function scratch() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-checker-')); directories.push(dir); return dir; }

it('a worker PASS is not a check request and creates no checker record', () => {
  const dir = scratch(), request = path.join(dir, 'worker.json'), out = path.join(dir, 'output');
  fs.writeFileSync(request, JSON.stringify({ schema: 'worker-report', status: 'PASS', axioms: [] }));
  const run = spawnSync(process.execPath, [SCRIPT, 'check', '--request', request, '--out', out], { encoding: 'utf8' });
  assert.equal(run.status, 5, run.stderr);
  assert.equal(JSON.parse(run.stdout).code, 'invalid-input');
  assert.equal(fs.existsSync(out), false);
});

it('auto dispatch cannot promote a standalone result or worker receipt', () => {
  for (const command of ['freeze', 'check', 'accept']) {
    const dir = scratch(), request = path.join(dir, 'forged.json'), out = path.join(dir, 'output');
    fs.writeFileSync(request, JSON.stringify({ schema: `fvs-checker/${command}-request`, version: 1, purpose: 'auto',
      runId: 'worker-pass', deadlineMs: Date.now() + 10000, status: 'PASS', authority: 'canonical-checker', axioms: [] }));
    const run = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/fvs-auto.mjs'), command, '--request', request, '--out', out], { encoding: 'utf8' });
    assert.equal(run.status, 5, run.stdout + run.stderr);
    assert.equal(JSON.parse(run.stdout).status, 'unverified');
    assert.equal(fs.existsSync(out), false);
  }
});

it('an interrupted accepted store is pending, never an empty accepted history', async () => {
  const { readAcceptedStore } = await import('../scripts/fvs-checker-auto.mjs');
  const dir = scratch();
  assert.equal(readAcceptedStore(path.join(dir, 'absent')).headSha256, null);
  fs.mkdirSync(path.join(dir, 'lock'));
  assert.throws(() => readAcceptedStore(dir), /pending/);
});

it('duplicate JSON authority fields and exhausted deadlines create no auto records', () => {
  const cases = [
    ['duplicate', '{"schema":"fvs-checker/check-request","version":1,"purpose":"auto","purpose":"auto","runId":"duplicate","deadlineMs":9999999999999}', 5],
    ['expired', JSON.stringify({ schema: 'fvs-checker/check-request', version: 1, purpose: 'auto', runId: 'expired', deadlineMs: 1 }), 8],
  ];
  for (const [name, body, exit] of cases) {
    const dir = scratch(), request = path.join(dir, `${name}.json`), out = path.join(dir, 'output'); fs.writeFileSync(request, body);
    const run = spawnSync(process.execPath, [SCRIPT, 'check', '--request', request, '--out', out], { encoding: 'utf8' });
    assert.equal(run.status, exit, run.stdout + run.stderr);
    assert.equal(JSON.parse(run.stdout).status, 'unverified');
    assert.equal(fs.existsSync(out), false);
  }
});
