'use strict';

// Structural gates for the patch workflow of the aeneas-extract command: look for a
// known fix first, then a writer and a reviewer on different models, at most two
// rounds, line-preserving patches, and one observer set that every gate cites.
//
// These are text gates over the shipped prose, like the other extraction-loop gates.
// The one executable gate runs the workflow's own line-count command against scratch
// repositories, so a change to that command that stops catching a moved line fails here.
//
// Pure node:test + node:assert/strict, zero npm dependencies.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const command = read('commands', 'fvs', 'aeneas-extract.md');
const workflow = read('fv-skills', 'workflows', 'aeneas-extract.md');
const assessor = read('agents', 'fvs-equivalence-assessor.md');
const applier = read('agents', 'fvs-extract-applier.md');
const bisector = read('agents', 'fvs-extract-bisector.md');
const packet = read('fv-skills', 'templates', 'equivalence-gate-packet.md');
const autoInit = read('fv-skills', 'workflows', 'auto-init.md');
const autoExtract = read('fv-skills', 'workflows', 'auto-extract.md');

function step(name) {
  const match = workflow.match(new RegExp(`<step name="${name}">([\\s\\S]*?)</step>`));
  assert.ok(match, `workflow has no <step name="${name}">`);
  return match[1];
}

describe('Known issues come before any new patch', () => {
  const text = step('known_issues');

  it('sits between classify and dispatch, and the patch review sits between dispatch and gate', () => {
    const order = [...workflow.matchAll(/<step name="([a-z_]+)">/g)].map((match) => match[1]);
    const at = (name) => order.indexOf(name);
    assert.ok(at('classify') >= 0 && at('classify') < at('known_issues'));
    assert.ok(at('known_issues') < at('dispatch'));
    assert.ok(at('dispatch') < at('patch_review'));
    assert.ok(at('patch_review') < at('gate'));
  });

  it('searches both tools\' trackers at the pinned and the newest version, with the stripped signature only', () => {
    assert.match(text, /Aeneas and Charon upstream repositories/);
    assert.match(text, /open and closed issues and pull requests/);
    assert.match(text, /release\s+notes and changelog/);
    assert.match(text, /pinned revisions and at the newest release/);
    assert.match(text, /stripped signature only/);
    assert.match(text, /never put a project name, a path, source text/i);
  });

  it('is read only: it never posts, comments, labels, reacts or opens anything', () => {
    assert.match(text, /never\s+posts, comments, labels, reacts or opens anything/);
  });

  it('records one outcome per signature and keeps "not checked" apart from "none found"', () => {
    for (const outcome of ['fix, no source change', 'workaround that edits source', 'fix only in a newer version', 'none found', 'not checked: <why>']) {
      assert.ok(text.includes(`\`${outcome}\``), `missing outcome ${outcome}`);
    }
    assert.match(text, /The record says `not checked`, never `none found`/);
    assert.match(text, /A `not checked` entry is not an\s+answer: it is never reused/);
  });

  it('treats a fix that needs no source change as no patch, and a source-level workaround as a patch', () => {
    assert.match(text, /Use it and write no patch/);
    assert.match(text, /A known workaround is still a patch: it is written, reviewed and gated like any other/);
  });

  it('reports a newer-version fix as a pin-change option and never changes a pin alone', () => {
    assert.match(text, /pin-change option/);
    assert.match(text, /Never change a pin on your own/);
  });

  it('keeps one cached record per pin pair', () => {
    assert.match(text, /known-issues\/<aeneas-rev>-<charon-rev>\.md/);
    assert.match(text, /first twelve\s+characters of each revision/);
    assert.match(text, /a new pin pair starts\s+a new record file/);
  });

  it('on a pin change, tries the series with each patch removed in turn and only proposes', () => {
    assert.match(text, /remove one patch at a time/);
    assert.match(text, /Report the patches that no longer seem needed/);
    assert.match(text, /This only proposes\. The loop never retires\s+a patch on its own/);
  });

  it('the command carries the same known-issues rules', () => {
    assert.match(command, /KNOWN ISSUES FIRST/);
    assert.match(command, /`none found` and `not checked` kept apart/);
    assert.match(command, /pin-change option/);
  });
});

describe('A new patch is written and reviewed by two different models', () => {
  const text = step('patch_review');

  it('names the writer and reviewer seats and requires different models', () => {
    const models = step('resolve_models');
    assert.match(models, /`WRITER` and `REVIEWER`/);
    assert.match(models, /the user chooses them at\s+confirmation/);
    assert.match(models, /default writer is the user's saved spec-writing selection/);
    assert.match(models, /default reviewer is the user's saved spec-review selection/);
    assert.match(models, /must resolve to different models/);
    assert.match(models, /Never pick\s+one silently/);
    assert.match(models, /No model name is built into this workflow/);
  });

  it('dispatches the writer and a fresh reviewer under the seat variables, reusing the existing agents', () => {
    assert.match(text, /model=\$WRITER_MODEL, reasoning_effort=\$WRITER_EFFORT/);
    assert.match(text, /subagent_type="fvs-equivalence-assessor", model=\$REVIEWER_MODEL, reasoning_effort=\$REVIEWER_EFFORT/);
    assert.match(text, /It adds no agent and no stage/);
  });

  it('stages the patch outside the gate directory and installs it only after the review', () => {
    assert.match(text, /patch-review\/<change-id>\.patch/);
    assert.match(text, /It does not touch `translation-patches\/` or `series`/);
    assert.match(text, /patch-review\/<change-id>\.round-<n>\.md/);
    assert.match(text, /outside\s+`equivalence-gate\/`/);
  });

  it('stops after two rounds and sends a second objection to the owner', () => {
    assert.match(text, /A second objection stops work on this patch: ESCALATE/);
    assert.match(text, /There is no third round/);
    assert.match(workflow, /\| Patch review rounds \| `2` \|/);
    assert.match(step('escalate'), /A patch the reviewer still objects to after the second\s+round/);
  });

  it('ends the review with one verdict line that is not a ratification', () => {
    assert.match(text, /`Reviewer verdict: no objection` or `Reviewer verdict: objection: <observer or line>`/);
    assert.match(text, /"No objection" is not a ratification: it stamps nothing/);
    assert.match(assessor, /Reviewer verdict: no objection/);
    assert.match(assessor, /it is not a ratification and stamps nothing/);
  });

  it('records a gap no patch can fix as a boundary and leaves the coverage decision to the owner', () => {
    assert.match(text, /A gap no patch can fix/);
    assert.match(text, /Record the\s+function as a boundary/);
    const escalate = step('escalate');
    assert.match(escalate, /the reason no\s+line-preserving patch clears it, the roots that reach it, and the tool issue it waits for/);
    assert.match(escalate, /a boundary is never skipped without that decision on record/);
    assert.match(autoExtract, /recorded as an `opaque` boundary/);
    assert.match(autoExtract, /`assumption-accepted`/);
    assert.match(autoExtract, /`affectedRoots` is `\[\]` for now/);
  });

  it('the command carries the same pair, rounds and boundary rules', () => {
    assert.match(command, /WRITE AND REVIEW A NEW PATCH/);
    assert.match(command, /\$REVIEWER_MODEL/);
    assert.match(command, /Reviewer verdict: no objection/);
  });
});

describe('Patches are line-preserving and checked against one observer set', () => {
  it('states the rule in the workflow, the command, the writer agents, the reviewer and the packet', () => {
    assert.match(workflow, /Line-preserving patches\./);
    assert.match(command, /Every patch is line-preserving/);
    for (const [name, text] of [['applier', applier], ['bisector', bisector]]) {
      assert.match(text, /line-preserving/, `${name} does not state the line rule`);
      assert.match(text, /goes\s+to the owner as a boundary|goes to the owner as a boundary/, `${name} does not route a gap to the owner`);
    }
    assert.match(assessor, /Line preservation, per hunk/);
    assert.match(packet, /\*\*Line-preserving:\*\*/);
  });

  it('checks panic occurrence and the file and line it reports, not a bare "location"', () => {
    for (const [name, text] of [['workflow', workflow], ['assessor', assessor], ['packet', packet]]) {
      assert.match(text, /file and line/, `${name} never says "file and line"`);
    }
    assert.match(packet, /Panic occurrence and the file and line it reports/);
    assert.match(assessor, /Panic occurrence, and the file and line it reports/);
  });

  it('names the observer set once in the agreement, as a conventions entry with a fixed prefix', () => {
    assert.match(autoInit, /the observer set, named once/);
    assert.match(autoInit, /The observer set has no payload key of its own, and none may be added/);
    assert.match(autoInit, /`conventions`\s+entry that starts with the fixed prefix `Observer set:`/);
    assert.match(workflow, /Observer set -- named once, cited by every gate/);
    assert.match(workflow, /`Observer set:`/);
  });

  it('makes the gates cite the observer set instead of defining "observable" again', () => {
    assert.match(packet, /observer set/i);
    assert.doesNotMatch(packet, /"Observable" = return values/);
    assert.match(assessor, /observer set/);
    assert.doesNotMatch(assessor, /\*\*Observable\*\*/);
  });

  it('the line-count command in the workflow separates a moved line from a kept line count', () => {
    const block = workflow.match(/```bash\n(git -C "\$SCRATCH" diff --cached -U0 \| awk [^\n]+)\n```/);
    assert.ok(block, 'the workflow lost its line-count command');
    const root = fs.realpathSync(os.tmpdir());
    const scratch = fs.mkdtempSync(path.join(root, 'fvs-line-check-'));
    try {
      lineCountVerdicts(scratch, block[1]);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

// Runs the workflow's own line-count command on edits of a five-line file.
function lineCountVerdicts(scratch, lineCountCommand) {
  const git = (...args) => {
    const result = spawnSync('git', ['-C', scratch, '-c', 'user.name=fvs', '-c', 'user.email=fvs@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  const verdict = (content) => {
    fs.writeFileSync(path.join(scratch, 'f.rs'), content);
    git('add', '-A');
    return spawnSync('/bin/sh', ['-c', lineCountCommand], { env: { ...process.env, SCRATCH: scratch }, encoding: 'utf8' }).status;
  };
  fs.writeFileSync(path.join(scratch, 'f.rs'), 'a\nb\nc\nd\ne\n');
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'base');

  assert.equal(verdict('a\nB\nc\nd\ne\n'), 0, 'one line rewritten in place keeps its line count');
  assert.equal(verdict('x\nb\nc\ny\ne\n'), 0, 'two separate hunks that each keep their line count pass');
  assert.notEqual(verdict('a\nB\nB2\nc\nd\ne\n'), 0, 'an added line moves the lines after it');
  assert.notEqual(verdict('a\nb\nc\nd\n'), 0, 'a removed line moves the lines after it');
}

describe('Owner token and wording', () => {
  it('reserves the token for the owner or an explicitly delegated person, recorded', () => {
    for (const [name, text] of [['workflow', workflow], ['command', command], ['assessor', assessor], ['packet', packet]]) {
      assert.match(text, /explicitly\s+delegated/, `${name} lost the explicit-delegation wording`);
    }
    assert.match(packet, /Delegation: \{owner \| recorded in <where the owner wrote the delegation>\}/);
    assert.match(packet, /equivalence-ratified: \{YYYY-MM-DD\}/);
    assert.match(packet, /a reviewer's "no objection"\s+is not a stamp/);
  });

  it('summarises the known-issues outcome in the run end block of both the workflow and the command', () => {
    assert.match(workflow, /^Known issues:/m);
    assert.match(command, /Known issues:/);
  });

  it('keeps the fresh-child paragraph once in the command and once in the workflow', () => {
    for (const [name, text] of [['command', command], ['workflow', workflow]]) {
      assert.equal(text.split('**Fresh child per pass:**').length - 1, 1, `${name} must hold the paragraph exactly once`);
    }
  });

  it('never opens or creates an upstream artifact', () => {
    const forbidden = /gh (?:issue|pr) (?:create|open)|gh release create/;
    for (const [name, text] of [['workflow', workflow], ['command', command], ['assessor', assessor], ['applier', applier], ['bisector', bisector]]) {
      assert.doesNotMatch(text, forbidden, `${name} names a forbidden upstream-creating command`);
    }
  });
});
