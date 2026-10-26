'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const command = read('commands/fvs/to-issues.md');
const workflow = read('fv-skills/workflows/to-issues.md');
const step = n => workflow.split(`## Step ${n}:`)[1].split(/## Step \d+:/)[0];

test('to-issues exposes its workflow and interactive tools', () => {
  assert.match(command, /^name: fvs:to-issues$/m);
  assert.match(command, /@~\/\.claude\/fv-skills\/workflows\/to-issues\.md/);
  for (const tool of ['Read', 'Write', 'Edit', 'Bash', 'Skill', 'AskUserQuestion'])
    assert.ok(command.includes(`  - ${tool}`));
});

test('tracker resolution is override, project default, then setup; invalid overrides stop', () => {
  const s = step(1);
  assert.match(s, /1\. A per-roadmap[\s\S]*2\. Only when[\s\S]*3\. If neither/);
  for (const text of ['replaces the whole', 'never fill override gaps', 'provider: null',
    'malformed JSON/YAML', 'all five label roles', 'BEFORE drafting', 'For `other`, stop'])
    assert.ok(s.includes(text), text);
  assert.match(s, /Setup's explicit config write is a separate flow/);
});

test('vertical outcomes distinguish scheduling, semantic dependencies and proof acceptance', () => {
  const s = step(2);
  for (const text of ['independently reviewable outcome', 'named\nevidence plus an acceptance procedure',
    "successful exit does not establish specification adequacy", 'Research, qualification',
    'never described as proof acceptance', 'Mutual\ninduction', 'game hop', 'bridge lemma',
    'Keep scheduling edges separate', 'Reject accidental scheduling\ncycles', 'one joint obligation',
    'never circular acceptance', 'numbered list showing title, blocked-by', 'iterate until approved'])
    assert.ok(s.includes(text), text);
});

test('local writes and dry-run export are confined and never overwrite', () => {
  const s = step(3);
  for (const text of ['dry-run alternative', 'never invokes\nGitHub mutations', 'physical canonical path',
    'lstat/readlink', 'symlinked `issues`', 'dangling symlinks', 'non-regular targets', '`..`',
    'absolute issue paths', 'outside that canonical', 'Recheck containment immediately',
    'Do not overwrite', 'reserve all existing numbers', '<roadmap dir>/issues/NN-<slug>.md',
    'Status:', 'Blocked by:', 'Do not change ignore files', 'anything outside the roadmap directory'])
    assert.ok(s.includes(text), text);
  assert.match(step(5), /Local mode:[\s\S]*rechecking paths[\s\S]*Read back each file/);
});

test('GitHub guards probe credentials, repository access, visibility, labels and runtime flags', () => {
  const s = step(1);
  for (const text of ['gh auth status', 'gh repo view', 'visibility,viewerPermission,hasIssuesEnabled',
    'gh issue create --help', '`WRITE`, `MAINTAIN` or `ADMIN`', 'On any failed\nprobe stop',
    '`--blocked-by`', '`--parent`', '`--blocking`', 'never silently omit edges',
    'Authentication and write access never authorize public disclosure']) assert.ok(s.includes(text), text);
});

test('whole batch is sanitized and exact consent is retained before mutations', () => {
  const preview = step(3), consent = step(4);
  for (const text of ['private or\nembargoed findings, secrets and sensitive local paths',
    'Present sanitized content', 'Private repositories still', 'WHOLE batch preview',
    'verified visibility', 'full body, exact labels, parent and dependency relationships',
    'existing issue metadata', 'Never close, edit or relabel existing issues',
    'SEPARATE explicit consent', 'names, descriptions and colors']) assert.ok(preview.includes(text), text);
  for (const text of ['ONE batch consent', 'Substantive changes', 'renewed approval',
    'An unchanged retry does not', 'Recheck visibility and permissions', 'BEFORE any remote mutation',
    'append-only', 'full approved sanitized preview', 'If retention\nfails, stop'])
    assert.ok(consent.includes(text), text);
  // Only help is executable publication syntax before the consent gate.
  const before = workflow.slice(0, workflow.indexOf('## Step 4:'));
  assert.doesNotMatch(before, /gh issue create(?! --help)|gh label create|gh (?:issue|label) (?:edit|close|delete)/);
  assert.match(step(5), /only AFTER Step 4's batch consent and retained preview/);
  assert.match(step(5), /Use `gh label create` only for separately approved labels/);
  assert.doesNotMatch(workflow, /gh (?:issue|label) (?:edit|close|delete)/);
});

test('publication recovery maps stable IDs and stops uncertain or incomplete creations', () => {
  const s = step(5);
  for (const text of ['topological order', '--body-file', '--blocked-by', '--parent',
    'Before each request', 'planned-ID-to-URL mapping', 'failed relationship\nattachment is partial',
    'Stop further\ncreation if logging fails', 'Reconcile uncertain creations before retrying',
    'including closed ones', 'compare author, batch attempt time, exact title/body and relationships',
    'multiple matches', 'Never blindly recreate', 'skip confirmed successes',
    'retry only confirmed non-creations', 'No issue deletion']) assert.ok(s.includes(text), text);
});

test('proof machine state stays out of issues and entry points advertise the command', () => {
  assert.match(step(1), /proof graph and `state\.json` are machine state\nand never become issues/);
  for (const p of ['commands/fvs/manage.md', 'commands/fvs/help.md', 'README.md'])
    assert.ok(read(p).includes('fvs:to-issues'), p);
  assert.match(read('commands/fvs/manage.md'), /^requires: \[[^\]]*to-issues/m);
  assert.equal(fs.readdirSync(path.join(root, 'commands/fvs')).filter(n => n.endsWith('.md')).length, 33);
  assert.equal(fs.readdirSync(path.join(root, 'fv-skills/workflows')).filter(n => n.endsWith('.md')).length, 20);
  assert.match(read('scripts/build-plugin.cjs'), /thirty-three commands/);
  assert.doesNotMatch(read('scripts/build-plugin.cjs'), /\bthirty commands/);
});
