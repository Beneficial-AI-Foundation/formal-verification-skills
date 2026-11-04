'use strict';

// Contract tests for /fvs:loop-me-in (issue #96): registration, the crypto-eval
// offer, the ranked default, the HTML template and the IMPLEMENTATION_nN record.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const flat = text => text.replace(/\s+/g, ' ');

const command = read('commands/fvs/loop-me-in.md');
const workflow = read('fv-skills/workflows/loop-me-in.md');
const template = read('fv-skills/templates/loop-me-in.html');

test('loop-me-in is a manage member, documented, and runs inline without subagents', () => {
  assert.match(command, /^name: fvs:loop-me-in$/m);
  assert.match(command, /@~\/\.claude\/fv-skills\/workflows\/loop-me-in\.md/);
  assert.doesNotMatch(command, /\n  - (?:Task|Skill)\n|subagent_type=/);
  assert.match(flat(command), /no additional model call, no subagent, no review stage/);
  assert.match(read('commands/fvs/manage.md'), /^requires: \[[^\]]*loop-me-in\]/m);
  for (const file of ['commands/fvs/manage.md', 'commands/fvs/help.md', 'README.md']) {
    assert.ok(read(file).includes('loop-me-in'), file);
  }
});

test('the crypto-eval offer is ACCEPT-only, interactive-only, asked once, and declining writes nothing', () => {
  const evalCommand = read('commands/fvs/crypto-eval.md');
  const evalWorkflow = read('fv-skills/workflows/crypto-eval.md');
  assert.match(evalCommand, /^  - Skill$/m);
  const offer = evalCommand.split('## Step 3b: Offer a walkthrough')[1].split('## Step 4')[0];
  assert.ok(evalCommand.indexOf('## Step 3a') < evalCommand.indexOf('## Step 3b'));
  assert.match(flat(offer), /ONLY when the decision is `ACCEPT`/);
  assert.match(flat(offer), /`behavior\.mode`.*`interactive`/);
  assert.match(flat(offer), /ask once/);
  assert.match(flat(offer), /\/fvs:loop-me-in <topic> nN/);
  assert.match(flat(offer), /On no, do nothing: no artefact, no extra agent work, nothing recorded/);
  assert.match(evalWorkflow, /<step name="offer_walkthrough">/);
});

test('bare invocation uses the ranked default and confirms before any write', () => {
  const step = flat(workflow.split('## 1. Choose the chunk')[1].split('## 2.')[0]);
  assert.match(step, /newest ACCEPTed iteration whose EVAL file is newer than HEAD/);
  assert.match(step, /dirty working tree is treated as that iteration's content/);
  assert.match(step, /Otherwise a dirty working tree/);
  assert.match(step, /Otherwise HEAD/);
  assert.match(step, /nothing to walk through/);
  assert.match(workflow, /# fvs:loop-me-in-candidates/);
  assert.match(workflow, /\^\\\*\\\*Decision:\\\*\\\* \*ACCEPT \*\$/);
  const screen = flat(workflow.split('## 4. One correction screen')[1].split('## 5.')[0]);
  assert.match(screen, /Never write the HTML before this screen is answered/);
  assert.match(screen, /plain-text numbered list and WAIT/);
  assert.match(flat(command), /Never write the HTML before the confirmation screen is answered/);
});

test('roadmap, audience and docs are discovered or asked, never inferred from code', () => {
  const roadmap = flat(workflow.split('## 2. Find the roadmap')[1].split('## 3.')[0]);
  assert.match(roadmap, /fvs_roadmap: true/);
  assert.match(roadmap, /\*\*\/ROADMAP\.md/);
  assert.match(roadmap, /no roadmap was found.*never a reason to stop/);
  const audience = flat(workflow.split('## 3. Audience and documentation')[1].split('## 4.')[0]);
  assert.match(audience, /"loop_me_in": \{ "docs": \[\], "audience": null, "style_refs": \[\] \}/);
  assert.match(audience, /Never infer the reader's level from the code/);
  assert.match(audience, /two most recent walkthroughs/);
  assert.match(audience, /200 KB/);
  const config = JSON.parse(read('fv-skills/templates/config.json'));
  assert.deepEqual(config.loop_me_in, { docs: [], audience: null, style_refs: [] });
});

test('what changed is high-level, backed by declarations, prefers IMPLEMENTATION_nN.md, and never upgrades a decision', () => {
  const evidence = flat(workflow.split('## 5. Gather evidence')[1].split('## 6.')[0]);
  assert.match(evidence, /`IMPLEMENTATION_nN\.md` at the topic root, next to `build\.log`.*authoritative/);
  assert.match(evidence, /otherwise every file in `git diff --stat` and `git status --porcelain`/);
  assert.match(evidence, /at the level of the mathematics or the protocol, not the files/);
  assert.match(evidence, /what was proved, defined, shown to hold, or strengthened/);
  assert.match(evidence, /names the declaration\(s\) that realise it with a `path:line` link/);
  assert.match(evidence, /no realising declaration in the diff is not a change/);
  assert.match(evidence, /collapsed evidence under the statements, never as the main text/);
  assert.doesNotMatch(evidence, /planned-vs-observed|three lists/);
  assert.match(evidence, /never upgrade it/);
  assert.match(template, /\{\{WHAT_CHANGED_STATEMENTS\}\}/);
  assert.match(template, /<details>\s*<summary>Files and declarations touched<\/summary>[\s\S]*\{\{DELTA_BY_FILE\}\}\s*<\/details>/);
  assert.doesNotMatch(template, /PLANNED_ONLY_ITEMS|OBSERVED_ONLY_ITEMS/);
  const placement = flat(workflow.split('## 6. Place the step on the roadmap')[1].split('## 7.')[0]);
  assert.match(placement, /`Status:` quoted verbatim/);
  assert.match(placement, /never changes the roadmap and never flips a status/);
  assert.match(placement, /could not place this step on the roadmap/);
});

test('crypto-execute persists the executor run report under reviews/', () => {
  for (const file of ['commands/fvs/crypto-execute.md', 'fv-skills/workflows/crypto-execute.md']) {
    const text = flat(read(file));
    assert.match(text, /\$ROOT\/IMPLEMENTATION_\$ITER\.md`, at the topic root next to `build\.log`/, file);
    assert.doesNotMatch(text, /reviews\/IMPLEMENTATION_/, file);
    assert.match(text, /never overwrit(?:e|ing) an existing record/, file);
  }
});

test('the HTML template is self-contained with the five parts and a static quiz', () => {
  assert.match(template, /^<!doctype html>/i);
  for (const id of ['header', 'what-changed', 'where-we-are', 'how-it-was-made', 'quiz', 'unverified']) {
    assert.ok(template.includes(`id="${id}"`), id);
  }
  assert.match(template, /prefers-color-scheme: dark/);
  assert.doesNotMatch(template, /<(?:script|link)[^>]+(?:src|href)=["']https?:/);
  assert.match(template, /data-correct/);
  assert.match(template, /<details><summary>/);
  assert.match(template, /FVS >> LOOP ME IN/);
  const output = flat(workflow.split('## 7. Write the walkthrough')[1].split('## 8.')[0]);
  assert.match(output, /at most 15 lines/);
  assert.match(output, /4 to 6 multiple-choice questions/);
  assert.match(output, /never an absolute `file:\/\/` path or a remote permalink/);
  assert.match(output, /refusing to overwrite/);
  assert.match(output, /\.formalising\/loop-me-in\/\$LOOP_SLUG/);
});
