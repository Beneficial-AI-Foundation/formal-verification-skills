'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const source = read('commands/fvs/ask-baif.md');
const flat = text => text.replace(/\s+/g, ' ');
const section = n => flat(source.split(`## ${n}.`)[1].split(/## \d+\./)[0]);
const all = flat(source);

test('ask-baif is discoverable to users/agents and reuses the native invocation tool', () => {
  assert.match(source, /^name: fvs:ask-baif$/m);
  assert.doesNotMatch(source, /disable-model-invocation: true|^  - Task$/m);
  for (const tool of ['Read', 'Edit', 'Bash', 'Glob', 'Grep', 'AskUserQuestion', 'Skill'])
    assert.ok(source.includes(`  - ${tool}`), tool);
  assert.match(all, /not an executor, scheduler or proof checker/);
  assert.match(all, /not BAIF staff or a remote service/);
});

test('bare orientation is read-only; explicit or existing maintenance grants are narrower than execution', () => {
  assert.match(section(1), /Bare invocation.*advisory: no writes, claims, builds, tests, model dispatch, installations, network mutations or command execution/);
  assert.match(section(1), /existing autonomous grant can cover these actions/);
  assert.match(section(1), /proof-execution permission alone cannot/);
  assert.match(section(1), /Do not ask for another confirmation of an unchanged action already authorized/);
  assert.match(section(4), /Bare briefing recommends corrections\/claims only/);
  assert.match(section(4), /Reconcile alone does not imply take-next/);
});

test('scope/intent comes from actual assignment and approval rather than guessed preferences', () => {
  assert.match(section(1), /explicit current assignment and user decisions first/);
  assert.match(section(1), /actual owner approval\/content\/source references/);
  assert.match(section(1), /Reuse settled intent and depth preferences/);
  assert.match(section(1), /targeted clarification, not simulated owner approval or a full interview reset/);
  assert.match(section(1), /never supply owner preferences, approve claims or extend authority/);
  assert.match(section(1), /available question tool.*no such tool.*numbered choices.*accept free text and WAIT/);
});

test('missing/stale/conflicting evidence never becomes a verdict or a guessed active iteration', () => {
  const s = section(2);
  assert.match(s, /latest filename\/mtime alone does not establish the active iteration/);
  assert.match(s, /Missing bindings are unknown/);
  assert.match(s, /changed sources\/statements can make earlier VERIFIED\/ACCEPT evidence stale/);
  assert.match(s, /report conflicting records with both references/);
  assert.match(s, /closed issue or ready scheduling edge is not proof acceptance/);
  assert.match(s, /semantic proof obligations separately from scheduling dependencies/);
  assert.match(s, /at most one bounded read-only investigation.*at most five additional relevant sources/);
});

test('routes are real member commands with explicit source contracts and no shortened proof loop', () => {
  const table = source.split('| Evidence / need |')[1].split('Within a batch,')[0];
  const names = [...table.matchAll(/`\/fvs:([a-z-]+)/g)].map(m => m[1]);
  for (const name of names) {
    if (name === 'bridge') continue; // Explicitly named as nonexistent, never a route.
    assert.ok(fs.existsSync(path.join(root, 'commands/fvs', `${name}.md`)), name);
  }
  for (const name of ['roadmap', 'issues-setup', 'to-issues', 'map-code', 'fc-plan', 'lean-specify',
    'lean-spec-review', 'lean-verify', 'trust-audit', 'aeneas-extract', 'model-external',
    'crypto-plan', 'crypto-review', 'crypto-execute', 'crypto-eval', 'crypto-followup'])
    assert.ok(names.includes(name), name);
  assert.match(section(3), /installed member command\/skill and its required workflow BEFORE recommending or invoking it/);
  assert.match(section(3), /cannot create missing CODEMAP/);
  assert.match(section(3), /topLevelFunctions have no dependents; entryPointFunctions have no dependencies \(leaves\); neither implies public API/);
  assert.match(section(3), /Skip is unreviewed, not approval/);
  assert.match(section(3), /explicit allowed unreviewed-proof grant/);
  assert.match(section(3), /zero-sorry inputs/);
  assert.match(section(3), /HUMAN_RULING waits for owner/);
  assert.match(section(3), /future capabilities absent from the 2\.3\.9 inventory/);
});

test('optional checkpoints distinguish next obligation from whole-goal reassessment', () => {
  const s = section(3);
  assert.match(s, /Direct entry to any known member remains valid/);
  assert.match(s, /Within a batch, select the next evidence-supported obligation/);
  assert.match(s, /Between batches, compare the whole roadmap goal.*finish.*remaining ready work.*roadmap refinement\/to-issues/);
  assert.match(s, /Batch completion never implies whole-goal completion or automatic issue creation/);
  assert.match(s, /Tickets carry bounded outcomes\/evidence and precise roadmap references/);
  assert.match(s, /full preview\/exact new-batch consent/);
});

test('tracker resolution preserves authoritative overrides and unknown blockers', () => {
  assert.match(section(3), /whole-block roadmap override before project default/);
  assert.match(section(3), /Null\/invalid authoritative override stops.*never fallback/);
  assert.match(section(4), /explicitly named legacy local tracker with its existing conventions/);
  assert.match(section(4), /unknown blockers\/cycles\/disputed completion stay blocked/);
  assert.match(section(4), /without changing scope\/dependency edges/);
});

test('confirmed implementation completion can be corrected while release or ambiguous closure cannot', () => {
  assert.match(section(4), /at most three confirmed status corrections.*at most one existing ticket/);
  assert.match(section(4), /approved landing can support resolved for an implementation ticket/);
  assert.match(section(4), /cannot close a release ticket whose publication criterion is unmet/);
  assert.match(section(4), /Ambiguous closure stays unchanged/);
});

test('booking checks ownership twice and does not treat an idle/exited worker as abandoned', () => {
  assert.match(section(4), /Before claiming, re-read status, owner, blockers and coordinator assignments/);
  assert.match(section(4), /Reuse your own valid reservation idempotently/);
  assert.match(section(4), /another active OR uncertain owner blocks booking/);
  assert.match(section(2), /idle, paused, exited or old activity never means abandoned/);
  assert.match(section(4), /No stealing, releasing, reopening or reassignment without an actual owner handoff\/release grant/);
  assert.match(section(4), /re-read after mutation before implementation/);
});

test('local paths/preimages and provider assignment limits are honest, not an atomic claim promise', () => {
  assert.match(section(4), /all prior content\/amendments/);
  assert.match(section(4), /exact current preimages with Edit/);
  assert.match(section(4), /resolved-path escapes outside that root/);
  assert.match(section(4), /stop on changed\/ambiguous content/);
  assert.match(section(4), /Re-read\/edit\/readback is NOT atomic/);
  assert.match(section(4), /single-writer coordinator\/claim mechanism/);
  assert.match(section(4), /never replace whole label\/assignee sets/);
  assert.match(section(4), /shared GitHub account is not an AO-session reservation/);
  assert.match(section(4), /NOT an atomic\/exclusive claim/);
  assert.match(section(4), /Other\/missing capability.*no guessed API/);
});

test('audit outcomes and uncertain retry reconcile without duplicate notes/claims or external messages', () => {
  assert.match(section(4), /old -> new state\/owner, reason, exact evidence and confirmed or uncertain outcome/);
  assert.match(section(4), /No allowed audit location means no mutation/);
  assert.match(section(4), /no duplicate note\/claim/);
  assert.match(section(4), /timeout\/partial\/uncertain change.*current state\/history\/audit before retrying/);
  assert.match(section(4), /not an unsolicited issue comment\/external message/);
  assert.match(section(4), /does not permit new issues, scope\/dependency edits, external messages, pushes, PRs or publication/);
});

test('one authorized continuation uses the existing runner; unavailable tools produce an honest handoff', () => {
  assert.match(section(5), /explicit continue or an applicable existing execution grant/);
  assert.match(section(5), /ONE action through the available native Skill\/member invocation or the existing executor\/orchestrator/);
  assert.match(section(5), /no native invocation mechanism.*execution was not started/);
  assert.match(section(5), /Downstream manifests, budget, model\/provider restrictions, human rulings and publication consent still apply/);
  assert.match(section(5), /No redundant router confirmation/);
  assert.match(section(5), /keeping the review unreviewed/);
});

test('the caller owns repetition; the router cannot recurse or retry unchanged failure forever', () => {
  assert.match(section(5), /Never route to ask-baif itself, directly or via another router/);
  assert.match(section(5), /No self-recursive execution or retry loop/);
  assert.match(section(5), /orchestrator may invoke ask-baif again after real new progress/);
  assert.match(section(5), /Repeated unchanged blocker\/target\/ evidence stops/);
  assert.match(section(5), /cannot reliably undo disclosure or restore invalidated evidence/);
});

test('manage/help/readme and generated entries expose the bounded command', () => {
  assert.match(read('commands/fvs/manage.md'), /^requires: \[[^\]]*ask-baif/m);
  for (const file of ['commands/fvs/help.md', 'commands/fvs/manage.md', 'README.md'])
    assert.ok(read(file).includes('fvs:ask-baif'), file);
  for (const file of ['pi/skills/fvs-ask-baif/SKILL.md', 'plugins/fvs/skills/ask-baif/SKILL.md']) {
    const generated = flat(read(file));
    assert.match(generated, /Bare invocation.*advisory/);
    assert.match(generated, /NOT atomic|NOT an atomic/);
    assert.match(generated, /native Skill\/member invocation/);
  }
});
