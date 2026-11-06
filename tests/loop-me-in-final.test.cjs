'use strict';

// Contract tests for /fvs:loop-me-in --final: the whole-work tutorial (definition + evidence,
// detected base branch, top-level theorems only, mathematical presentation, verified trust).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const flat = text => text.replace(/\s+/g, ' ');

const command = read('commands/fvs/loop-me-in.md');
const workflow = read('fv-skills/workflows/loop-me-in-final.md');
const template = read('fv-skills/templates/loop-me-in-final.html');

test('--final is a mode of loop-me-in that routes to its own workflow and template', () => {
  assert.match(command, /^@~\/\.claude\/fv-skills\/workflows\/loop-me-in-final\.md$/m);
  assert.match(command, /argument-hint: .*--final \[<topic> \| <description>\] \[--base <branch>\] \[--commit <range>\]/);
  assert.match(flat(command), /With `--final`, follow the loop-me-in-final workflow instead/);
  assert.match(flat(command), /There is no screen shortcut for `--final`/);
  assert.match(workflow, /<purpose>[\s\S]*<\/purpose>/);
  assert.match(workflow, /<process>[\s\S]*<\/process>/);
  assert.match(workflow, /~\/\.claude\/fv-skills\/templates\/loop-me-in-final\.html/);
  assert.match(flat(workflow), /Steps 0 \(parse\), 2 \(roadmap\), 3 \(audience, documentation, style, editor\) and the output and report conventions of `~\/\.claude\/fv-skills\/workflows\/loop-me-in\.md` apply unchanged/);
});

test('the work is a definition plus evidence, with the base branch detected and correctable', () => {
  const scope = workflow.split('## 1. Resolve the work')[1].split('## 2.')[0];
  assert.match(flat(scope), /The definition is what the formalisation set out to establish; the evidence is the code that did it/);
  assert.match(scope, /# fvs:loop-me-in-base/);
  assert.match(scope, /gh pr view --json baseRefName/);
  assert.match(scope, /branch: Created from/);
  assert.match(scope, /for b in main master develop; do/);
  assert.match(scope, /git merge-base "\$cur" "\$b"/);
  assert.match(flat(scope), /The pull request's base \(when `gh` knows one\) wins, then the branch the reflog says this branch was created from, then `main`\/`master`\/`develop` as the stated default/);
  assert.match(flat(scope), /the nearest candidate is a hint, not the choice/);
  assert.match(flat(scope), /it is answered by the user, not inferred silently/);
  assert.doesNotMatch(scope, /\beval\b/);
  const screen = workflow.split('## 2. One correction screen')[1].split('## 3.')[0];
  for (const line of ['Definition:', 'Evidence:', 'Top-level:', 'Editor:', 'Output:']) {
    assert.match(screen, new RegExp(`^${line}`, 'm'), line);
  }
  assert.match(flat(screen), /change the base branch \(the candidate list from step 1, nearest first\)/);
  assert.match(flat(screen), /describe the scope differently \(a commit range, another topic, or a description in words/);
  assert.match(flat(screen), /change the top-level theorems/);
  assert.match(flat(screen), /Never write the tutorial before this screen is answered; there is no shortcut/);
});

test('the tutorial is high-level: top-level theorems only, mathematics and prose, no Lean excerpts', () => {
  const write = flat(workflow.split('## 4. Write the tutorial')[1].split('## 5.')[0]);
  assert.match(write, /\*\*Only top-level theorems are named as results\.\*\*/);
  assert.match(write, /described by their role .* and linked, never listed as results/);
  assert.match(write, /\*\*Every idea is presented mathematically\*\*/);
  assert.match(write, /\*\*No Lean excerpts anywhere\*\* except the names in the reading table and in editor links/);
  assert.match(write, /\*\*Every hop or step of the argument states its justification\*\*/);
  assert.match(write, /No tactic-level narrative/);
  assert.match(write, /about a twenty-minute read/);
  assert.match(write, /5 to 8 multiple-choice questions about why the argument works and what is assumed/);
  assert.match(write, /final-<topic\|branch-slug>/);
});

test('trust is found, not assumed: axiom check, sorry grep, exclusions, audit record', () => {
  const evidence = workflow.split('## 3. Gather evidence')[1].split('## 4.')[0];
  assert.match(evidence, /# fvs:loop-me-in-axioms/);
  assert.match(evidence, /#print axioms/);
  assert.match(evidence, /LEAN_NUM_THREADS="\$\{LEAN_NUM_THREADS:-4\}" nice -n 19 lake env lean/);
  assert.doesNotMatch(evidence, /(?<!env )lake build/);
  assert.match(flat(evidence), /"axiom audit not run" for that theorem rather than claiming standard axioms only/);
  assert.match(flat(evidence), /appears only when every top-level theorem's check printed nothing beyond `propext`, `Classical\.choice` and `Quot\.sound`/);
  assert.match(evidence, /`sorry`, `axiom`, `native_decide` and `opaque`/);
  assert.match(evidence, /\.formalising\/audits\/<target>\.md/);
  assert.match(flat(evidence), /read off the evidence, never off the roadmap's `Status:` alone/);
  assert.match(flat(evidence), /\*established\*, \*partially established\*[^.]*\*not established\*/);
});

test('the final template has the chapter sections, a reading table, a conceptual quiz and provenance', () => {
  assert.match(template, /^<!doctype html>/i);
  for (const id of ['header', 'story', 'theorem', 'proof', 'limits', 'reading-the-lean', 'quiz', 'unverified', 'provenance']) {
    assert.ok(template.includes(`id="${id}"`), id);
  }
  assert.match(template, /FVS >> LOOP ME IN \(FINAL\)/);
  assert.match(template, /prefers-color-scheme: dark/);
  assert.doesNotMatch(template, /<(?:script|link)[^>]+(?:src|href)=["']https?:/);
  const hrefs = [...template.matchAll(/href="([^"]*)"/g)].map(m => m[1]);
  for (const href of hrefs) assert.ok(href === '{{HREF}}' || href.startsWith('#'), href);
  for (const ph of ['{{ABSTRACT}}', '{{STANDING_SENTENCE}}', '{{SETTING}}', '{{THEOREMS}}', '{{PROOF}}', '{{BOUNDARIES}}', '{{TRUST_ITEMS}}', '{{TAKE_HOME}}', '{{READING_TABLE}}', '{{QUIZ_QUESTIONS}}', '{{AXIOM_AUDIT_OUTCOME}}', '{{EVIDENCE}}', '{{TOP_LEVEL_THEOREMS}}']) {
    assert.ok(template.includes(ph), ph);
  }
  assert.match(template, /data-correct/);
  assert.match(template, /<details><summary>/);
  assert.doesNotMatch(template, /\{\{EXCERPT\}\}/);
});

test('registration: help and README mention --final; the workflow count is pinned at 23', () => {
  assert.match(read('commands/fvs/help.md'), /--final/);
  assert.match(read('README.md'), /--final/);
  assert.equal(fs.readdirSync(path.join(root, 'fv-skills/workflows')).filter(n => n.endsWith('.md')).length, 23);
});
