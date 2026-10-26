'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const COMMAND = 'commands/fvs/issues-setup.md';
const ROLES = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix'];

// Matches "## Step N: <title>" headings and returns the byte offset of the first one whose
// title matches `title`, so ordering assertions do not depend on step numbers.
function stepOffset(source, title) {
  const heading = new RegExp(`^## Step \\d+: ${title}`, 'm').exec(source);
  assert.ok(heading, `missing step heading: ${title}`);
  return heading.index;
}

describe('/fvs:issues-setup command', () => {
  const source = read(COMMAND);

  it('is a user-interactive command with the tools it needs', () => {
    const frontmatter = source.match(/^---\n([\s\S]*?)\n---\n/)[1];
    assert.match(frontmatter, /^name: fvs:issues-setup$/m);
    assert.match(frontmatter, /^description: .+/m);
    for (const tool of ['Read', 'Write', 'Bash', 'AskUserQuestion']) {
      assert.match(frontmatter, new RegExp(`^  - ${tool}$`, 'm'), `allowed-tools missing ${tool}`);
    }
  });

  it('offers exactly the three providers and records the choice in the issues section', () => {
    for (const provider of ['github', 'local', 'other']) {
      assert.ok(source.includes(`\`${provider}\``), `missing provider ${provider}`);
    }
    assert.match(source, /`provider`[\s\S]*`repo`[\s\S]*`labels`[\s\S]*`notes`/);
    assert.match(source, /freeform[\s\S]{0,80}prose/i, 'other is recorded as prose');
    assert.match(source, /AskUserQuestion/);
  });

  it('recommends GitHub only for a GitHub remote with an authenticated, write-capable gh', () => {
    assert.match(source, /recommend GitHub only when/i);
    for (const probe of ['git remote get-url origin', 'gh auth status', 'viewerPermission', 'hasIssuesEnabled']) {
      assert.ok(source.includes(probe), `exploration missing ${probe}`);
    }
    for (const permission of ['WRITE', 'MAINTAIN', 'ADMIN']) {
      assert.ok(source.includes(permission), `write-capable permission ${permission} not named`);
    }
    assert.match(source, /otherwise recommend local/i);
  });

  it('keeps the five default label roles or maps them to existing labels, one label per role', () => {
    for (const role of ROLES) assert.ok(source.includes(`\`${role}\``), `missing role ${role}`);
    assert.match(source, /map (each|a) role to an existing label/i);
    assert.match(source, /two roles .*same label/i, 'duplicate label mapping must be rejected');
  });

  it('explores read-only and only ever runs read-only gh subcommands', () => {
    const invoked = [...source.matchAll(/^\s*gh ([a-z-]+ [a-z-]+)/gm)].map(match => match[1]);
    assert.ok(invoked.length > 0, 'expected gh probes in the exploration step');
    const readOnly = new Set(['auth status', 'repo view', 'label list']);
    assert.deepEqual(invoked.filter(sub => !readOnly.has(sub)), [], 'a gh subcommand outside the read-only set');
    assert.doesNotMatch(source, /gh (issue|label) create|gh api\b[^\n]*(-X|--method)/i);
  });

  it('previews the exact issues section before it writes anything', () => {
    const preview = stepOffset(source, 'Preview');
    const write = stepOffset(source, 'Write');
    assert.ok(preview < write, 'preview must precede the write step');
    assert.match(source, /exact `issues` section/i);
    assert.match(source, /nothing is written until the user confirms/i);
  });

  it('merges into fvs-config.json, preserving every other key and refusing malformed JSON', () => {
    assert.ok(source.includes('.formalising/fvs-config.json'));
    assert.match(source, /~\/\.claude\/fv-skills\/templates\/config\.json/, 'creates the config from the template');
    assert.match(source, /malformed JSON[\s\S]{0,80}stop before writing/i);
    assert.match(source, /replace only the top-level `issues` key/i);
    assert.match(source, /preserve (every|all) other (top-level )?key/i);
    assert.match(source, /never (write|replace)[^\n]*partial/i);
  });

  it('treats provider null as unconfigured', () => {
    assert.match(source, /`provider: null`[^\n]*unconfigured/i);
    assert.ok(source.includes('/fvs:to-issues'), 'names the consumer that triggers this flow');
  });

  it('documents the per-roadmap override as a whole-block replacement', () => {
    assert.match(source, /ROADMAP\.md/);
    assert.match(source, /^issues:$/m, 'shows the frontmatter issues: block');
    assert.match(source, /replaces the project default as a whole block/i);
    assert.match(source, /no field-wise merge/i);
    assert.match(source, /incomplete[^\n]*invalid/i, 'an incomplete override is reported, not completed');
    assert.match(source, /project default applies when[^\n]*absent/i);
  });

  it('never creates GitHub labels or issues and never touches ignore files', () => {
    assert.match(source, /never creates (GitHub )?labels or issues/i);
    assert.match(source, /never (modif|edit)\w* [^\n]*\.gitignore[^\n]*\.git\/info\/exclude/i);
    assert.doesNotMatch(source, /(>>?|tee( -a)?)\s*\S*(\.gitignore|info\/exclude)/,
      'no command may write to an ignore or exclude file');
  });

  it('does not reference planning artifacts', () => {
    assert.doesNotMatch(source, /\.planning\/|\.scratch\//);
  });
});

describe('issues section in the shipped config template', () => {
  const template = JSON.parse(read('fv-skills/templates/config.json'));

  it('starts unconfigured', () => {
    assert.deepEqual(template.issues, { provider: null });
  });

  it('leaves the existing sections in place', () => {
    for (const key of ['project', 'model_profile', 'spec_review', 'behavior', 'knowledge_bases']) {
      assert.ok(key in template, `template lost ${key}`);
    }
  });
});

describe('issues-setup entry points', () => {
  it('the manage router lists and routes to it', () => {
    const manage = read('commands/fvs/manage.md');
    assert.match(manage, /^requires: \[[^\]]*\bissues-setup\b/m);
    assert.match(manage, /\|[^\n|]*\| fvs:issues-setup \|/);
  });
});
