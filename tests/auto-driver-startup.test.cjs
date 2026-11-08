'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const f = require('./helpers/transition-v2-fixture.cjs');
const owned = [];
after(() => { for (const p of owned) fs.rmSync(p, { recursive: true, force: true }); });
test('actual launch argv holds startup before gate calls and preserves the existing work-start guard', async () => {
  const [auto, t] = await Promise.all([import('../scripts/fvs-auto.mjs'), import('../scripts/fvs-auto-transitions.mjs')]);
  const x = await f.fixture(auto, t); owned.push(x.owned); const s = x.startup();
  const args = t.launchArguments(s.action.a, s.action.ref, 'a'.repeat(64));
  const prompt = args[args.indexOf('--prompt') + 1];
  assert.ok(prompt.indexOf('WAIT for the controller permission-ready notice') < prompt.indexOf('Use installed gate'));
  assert.match(prompt, /actual AO session\/worktree and verified permission installation receipt/);
  assert.match(prompt, /trusted instruction, not OS suspension or permission bypass/);
  assert.match(prompt, /WAIT for the exact bound work packet and durable start acknowledgement before any task\/source edits/);
  assert.equal(args[args.indexOf('--model') + 1], 'fixture');
  assert.equal('permission' in s.action.a.target, false);
});
