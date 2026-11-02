'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const mod = import(pathToFileURL(path.resolve(__dirname, '../scripts/fvs-execution.mjs')));
const env = { PATH: path.dirname(process.execPath) + ':/usr/bin:/bin', LANG: 'C' };
const options = { cwd: __dirname, env, maxBuffer: 1024 * 1024 };

test('closed execution controls distinguish no budget from sticky selected budget', async () => {
  const m = await mod, none = m.createExecution('run', { kind: 'none' });
  assert.deepEqual(m.parseExecution(none), none);
  assert.deepEqual(m.resolveBudget({ kind: 'none' }, 10), { kind: 'none' });
  assert.deepEqual(m.resolveBudget({ kind: 'wall-clock', hours: 2 }, 10), { kind: 'deadline', deadlineMs: 7200010 });
  assert.deepEqual(m.timeoutOptions(none, { now: () => 999999999999 }), {});
  assert.doesNotThrow(() => m.assertRunning(none, { now: () => 0 }));
  assert.doesNotThrow(() => m.assertRunning(none, { now: () => 10 + 5 * 3600000 }));
  const bounded = m.createExecution('run', { kind: 'deadline', deadlineMs: 100 });
  assert.deepEqual(m.timeoutOptions(bounded, { now: () => 25 }), { timeout: 75 });
  assert.throws(() => m.assertRunning(bounded, { now: () => 100 }), { code: 'timeout' });
  assert.equal(m.controlDeadline(bounded), 100);
  assert.deepEqual(m.timeoutOptions(none, { administrativeMs: 25 }), { timeout: 25 });
});

test('mixed versions, hidden hooks and fabricated policy identities refuse without invoking hooks', async () => {
  const m = await mod, none = m.createExecution('run', { kind: 'none' });
  for (const bad of [{ ...none, budget: { kind: 'none', deadlineMs: 1 } }, { ...none, policySha256: '0'.repeat(64) }, { ...none, extra: 1 }]) assert.throws(() => m.parseExecution(bad));
  for (const value of [Infinity, NaN, null, '100']) assert.throws(() => m.requestControl({ version: 1, deadlineMs: value }));
  assert.throws(() => m.requestControl({ version: 1, deadlineMs: 100, execution: none }));
  assert.throws(() => m.requestControl({ version: 2, deadlineMs: 100, execution: none }));
  assert.throws(() => m.requestControl({ version: 3, execution: none }));
  let calls = 0; const evil = { ...none };
  Object.defineProperty(evil, 'toJSON', { value() { calls++; return none; } });
  assert.throws(() => m.parseExecution(evil)); assert.equal(calls, 0);
  assert.deepEqual(m.executionFields({ version: 2, execution: none }), { version: 2, execution: none });
  assert.deepEqual(m.executionFields({ version: 1, deadlineMs: 100 }), { version: 1, deadlineMs: 100 });
});

test('owned no-budget command completes without elapsed proof timer or inherited environment', async () => {
  const m = await mod, none = m.createExecution('run', { kind: 'none' });
  const result = await m.runOwned([process.execPath, '-e', 'process.stdout.write("done:"+String(process.env.FVS_UNEXPECTED))'], options, none);
  assert.equal(result.status, 0); assert.equal(result.stdout.toString(), 'done:undefined');
  assert.equal(result.cancelled, false); assert.equal(result.timedOut, false); assert.equal(result.cleanupComplete, true);
  assert.throws(() => m.runOwned([process.execPath, '-e', ''], { ...options, timeout: 600000 }, none));
});

test('selected budget kills only live owned group and returns actual terminal evidence', async () => {
  const m = await mod, bounded = m.createExecution('run', { kind: 'deadline', deadlineMs: Date.now() + 150 });
  const result = await m.runOwned([process.execPath, '-e', 'setInterval(()=>{},1000)'], options, bounded);
  assert.equal(result.timedOut, true); assert.equal(result.status, null); assert.equal(result.signal, 'SIGKILL'); assert.equal(result.cleanupComplete, true);
});

test('cancellation reaches owned child and inheriting grandchild; no AO/PS claim', async () => {
  const m = await mod, none = m.createExecution('run', { kind: 'none' }), controller = new AbortController();
  const code = 'const{spawn}=require("node:child_process");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});process.stdout.write("ready");setInterval(()=>{},1000)';
  const spawnProcess = (...args) => { const child = spawn(...args); child.stdout.once('data', () => controller.abort()); return child; };
  const result = await m.runOwned([process.execPath, '-e', code], options, none, { signal: controller.signal, spawnProcess });
  assert.equal(result.cancelled, true); assert.equal(result.signal, 'SIGKILL'); assert.equal(result.status, null); assert.equal(result.cleanupComplete, true);
  assert.equal(result.cleanup.descendantAttestation, false);
});

test('already cancelled request starts nothing; uncertain group absence never becomes cleanup success', async () => {
  const m = await mod, none = m.createExecution('run', { kind: 'none' }), c = new AbortController(); c.abort();
  let called = false;
  assert.throws(() => m.runOwned([process.execPath], options, none, { signal: c.signal, spawnProcess() { called = true; } }), { code: 'cancelled' });
  assert.equal(called, false);
  const result = await m.runOwned([process.execPath, '-e', ''], options, none, { probeGroup: () => 'unknown' });
  assert.equal(result.status, 0); assert.equal(result.cleanupComplete, false); assert.equal(result.cleanup.result, 'unknown');
});
