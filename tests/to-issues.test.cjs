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
  assert.match(s, /1\. A per-roadmap[\s\S]*2\. Only when[\s\S]*3\. Only when the override is absent/);
  for (const text of ['replaces the whole', 'never fill override gaps', 'provider: null',
    'malformed JSON/YAML', 'all five label roles', 'BEFORE drafting', 'For `other`, stop'])
    assert.ok(s.includes(text), text);
  assert.match(s, /Setup's explicit config write is a separate flow/);
});

test('null roadmap override stops for both project-default states without project-only repair', () => {
  const s = step(1);
  for (const project of ['Configured', 'Unconfigured']) {
    const row = s.split('\n').find(line => line.startsWith(`| Complete, provider null | ${project} |`));
    assert.ok(row, `null override with ${project} default`);
    assert.match(row, /Stop; separately approve replacing\/removing the override, then rerun Step 1/);
  }
  assert.match(s, /project-only `\/fvs:issues-setup` cannot repair it because setup never edits roadmaps/);
  assert.match(s, /Show the exact\nroadmap path and its `issues:` block/);
  assert.match(s, /replaces the entire override with a complete configured record or removes the entire `issues:`\nblock/);
  assert.match(s, /Do not perform that edit in this command, silently fall back\nto the project default, or loop through setup/);
  assert.match(s, /After that separate action, rerun Step 1 from disk/);
});

test('conversation selects roadmap before resolution and conflicting overrides determine destination', () => {
  const s = step(1);
  const selection = s.indexOf('For conversation input, select an existing roadmap');
  assert.ok(selection >= 0 && selection < s.indexOf('Resolve the tracker in this order:'));
  assert.match(s, /approval BEFORE resolving the tracker or drafting issues/);
  for (const row of [
    '| Local | GitHub | GitHub; announce its repo/visibility and run GitHub checks before drafting |',
    '| GitHub | Local | Local; announce its roadmap directory before drafting |',
    '| Local or GitHub | Other | Stop with manual-tracker guidance |',
    '| Local or GitHub | Invalid | Stop; never fill gaps from the default |',
    '| Local or GitHub | Provider null | Stop using the null-override guidance above |',
  ]) assert.ok(s.includes(row), row);
  assert.match(s, /selected roadmap changes at any later step[\s\S]*restart Step 1/);
  assert.match(s, /Read and validate the newly selected override as a whole block/);
  assert.match(s, /announce\nthe new effective destination[\s\S]*repeat all relevant GitHub checks/);
  assert.match(s, /Rebuild affected drafts, the quiz and the full sanitized preview[\s\S]*fresh affected batch\nand label consent/);
  assert.match(s, /already attempted batch[\s\S]*never authorizes duplicate creation/);
  assert.match(step(3), /roadmap already selected in Step 1[\s\S]*full Step 1 restart/);
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
  assert.equal(fs.readdirSync(path.join(root, 'fv-skills/workflows')).filter(n => n.endsWith('.md')).length, 25);
  const count = fs.readdirSync(path.join(root, 'commands/fvs')).filter(name => name.endsWith('.md')).length;
  assert.ok(require('../scripts/build-plugin.cjs').renderSetupSkill().includes(`${count} commands`));
  assert.doesNotMatch(read('scripts/build-plugin.cjs'), /\bthirty commands/);
});
