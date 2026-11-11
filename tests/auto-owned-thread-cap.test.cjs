// Inert owned-command protocol tests: a tiny shell tool, no Lean/probe/provider or AO lease.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function fixture(t) {
  const e = await import('../scripts/fvs-execution.mjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-owned-thread-cap-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const save = (name, value) => { const file = path.join(root, name); fs.writeFileSync(file, JSON.stringify(value)); return { file, sha256: hash(file) }; };
  const packet = save('packet.json', { schema: 'inert-lease-only' });
  const actor = { sessionId: 'inert-thread-cap-worker', worktree: { path: root } };
  const marker = save('marker.json', { packet, actor }); e.initializeOwnedWork(packet, actor, marker);
  const file = path.join(root, 'inert-env-tool');
  fs.writeFileSync(file, '#!/bin/sh\nprintf "%s" "${LEAN_NUM_THREADS-absent}"\n', { mode: 0o755 });
  const tool = { file, sha256: hash(file) }, control = e.createExecution('inert-thread-cap-run', { kind: 'none' });
  const request = { schema: 'fvs/owned-command-request', schemaVersion: 1, packet, marker, invocationId: crypto.randomUUID(), tool,
    argv: [file], cwd: root, env: { PATH: '/usr/bin:/bin', LANG: 'C', DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' } };
  const observed = [];
  const services = { loadLease: () => ({ packet, actor, control, toolPins: [tool] }),
    spawnProcess(file, args, opts) { observed.push({ file, args, env: { ...opts.env } }); return spawn(file, args, opts); } };
  return { e, root, packet, actor, request, services, observed };
}
test('literal thread cap2 reaches the actual owned child and retained request unchanged', async t => {
  const x = await fixture(t); x.request.env.LEAN_NUM_THREADS = '2';
  const result = await x.e.runTaskCommand(x.request, x.services);
  assert.equal(result.status, 'command-completed'); assert.equal(x.observed.length, 1);
  assert.equal(x.observed[0].env.LEAN_NUM_THREADS, '2');
  assert.equal(fs.readFileSync(result.stdout.file, 'utf8'), '2');
  const terminal = JSON.parse(fs.readFileSync(result.terminal.file)), intent = JSON.parse(fs.readFileSync(terminal.intent.file));
  assert.equal(JSON.parse(fs.readFileSync(intent.request.file)).env.LEAN_NUM_THREADS, '2');
});
test('absent thread variable keeps legacy explicit-environment behavior', async t => {
  const x = await fixture(t), result = await x.e.runTaskCommand(x.request, x.services);
  assert.equal(result.status, 'command-completed'); assert.equal(x.observed.length, 1);
  assert.equal(Object.hasOwn(x.observed[0].env, 'LEAN_NUM_THREADS'), false);
  assert.equal(fs.readFileSync(result.stdout.file, 'utf8'), 'absent');
});
test('every other thread value refuses before spawn and leaves known work quiescent', async t => {
  for (const value of ['', '0', '1', '3', '4', 'auto', '2 ', ' 2', '2\n', 2, null, true]) await t.test(JSON.stringify(value), async tt => {
    const x = await fixture(tt); x.request.env.LEAN_NUM_THREADS = value;
    await assert.rejects(() => x.e.runTaskCommand(x.request, x.services), /LEAN_NUM_THREADS|credential-free command environment/);
    assert.equal(x.observed.length, 0); assert.equal(x.e.observeOwnedWork(x.packet, x.actor).status, 'quiescent');
  });
});
test('the cap extension does not allow other environment keys', async t => {
  const x = await fixture(t); Object.assign(x.request.env, { LEAN_NUM_THREADS: '2', UNAPPROVED_ENV: 'value' });
  await assert.rejects(() => x.e.runTaskCommand(x.request, x.services), /credential-free command environment/);
  assert.equal(x.observed.length, 0);
});
