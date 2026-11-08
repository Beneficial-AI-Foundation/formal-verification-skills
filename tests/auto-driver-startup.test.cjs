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
test('legacy v1 launch retains its original immediate startup route without a v2 permission notice', async () => {
  const [auto, t] = await Promise.all([import('../scripts/fvs-auto.mjs'), import('../scripts/fvs-auto-transitions.mjs')]);
  const old = require('./helpers/resume-fixture.cjs'), x = old.fixture(auto); owned.push(x.owned);
  const project = { id: 'fixture-project', path: x.root, config: {} };
  x.writeControl({ project }); const controller = t.redactAOProfile(Buffer.from(JSON.stringify({ project })));
  const view = auto.readState({ projectRoot: x.root, requireAgreement: true }), initial = x.invoke(), q = x.request();
  const authorization = old.json(x.owned, 'legacy-held-grant', { scope: 'argv-only fixture; no effect authorization' });
  const profile = old.json(x.owned, 'legacy-profile', { stages: { spec_review: { harness: 'fixture', model: 'fixture', effort: 'fixture' } }, controller });
  const before = t.transitionSnapshot({ q, run: auto.readRuntimeState({ projectRoot: x.root }).state.run, canonical: { view, envelope: view.agreement.agreement },
    observation: initial.result.observation, action: { before: { registry: null }, target: {}, authorization, profile } }, { profileObservation: controller });
  const action = { schema: 'fvs/auto-transition-request', schemaVersion: 1, runId: x.runId, transitionId: old.uuid(), reservationId: old.uuid(), kind: 'launch', stage: 'review', nodes: [19], owner: 'worker-owner',
    expectedHeadSha256: q.expectedHeadSha256, before, authorization, profile, basis: null, target: { projectId: 'fixture-project', branchRef: 'refs/heads/legacy-review', assignmentId: old.uuid(), selectionStage: 'spec_review', invocation: null,
      startup: { challenge: old.uuid(), attemptId: old.uuid(), phase: 'resume', resumeId: old.uuid() } } };
  const ref = old.json(x.owned, 'legacy-launch', action), args = t.launchArguments(action, ref, 'a'.repeat(64)), prompt = args[args.indexOf('--prompt') + 1];
  assert.doesNotMatch(prompt, /permission-ready|permission installation receipt/);
  assert.match(prompt, /Retain your own fresh worker-readonly memory request/);
  assert.match(prompt, /WAIT for the exact bound work packet and durable start acknowledgement/);
});
