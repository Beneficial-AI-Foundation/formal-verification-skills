'use strict';

// Gates for the /fvs:roadmap command and workflow.
//
// Two kinds of assertion:
//   1. Text gates over the shipped command and workflow: the roadmap template,
//      the honest-scope sentences, the bounded interview, the git-exclusion
//      rules and the rerun semantics cannot be weakened without failing here.
//   2. Behavioural gates: the workflow's tagged bash blocks (path resolution,
//      git-exclusion check, info/exclude append, discovery) are extracted and
//      executed in throwaway git repositories, including hostile inputs, a
//      symlinked .formalising directory and a linked worktree.
//
// Pure node:test + node:assert/strict, zero npm dependencies.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const COMMAND_FILE = path.join(ROOT, 'commands', 'fvs', 'roadmap.md');
const WORKFLOW_FILE = path.join(ROOT, 'fv-skills', 'workflows', 'roadmap.md');

const command = fs.readFileSync(COMMAND_FILE, 'utf8');
const workflow = fs.readFileSync(WORKFLOW_FILE, 'utf8');
const both = `${command}\n${workflow}`;

// Collapse wrapping so sentence pins survive reflowed prose.
const flat = (text) => text.replace(/\s+/g, ' ');

function frontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  return match ? match[1] : '';
}

function bashBlock(text, marker) {
  const match = text.match(new RegExp('```bash\\n(# ' + marker + '\\n[\\s\\S]*?)```'));
  assert.ok(match, `workflow has a bash block tagged "# ${marker}"`);
  return match[1];
}

const TEMPLATE = (workflow.match(/```markdown\n(---\nfvs_roadmap: true\n[\s\S]*?)\n```\n/) || [])[1] || '';

// ---------------------------------------------------------------------------
// Command file shape
// ---------------------------------------------------------------------------
describe('roadmap command file', () => {
  const meta = frontmatter(command);

  it('is named fvs:roadmap with a description and a required allowed-tools list', () => {
    assert.match(meta, /^name: fvs:roadmap$/m);
    assert.match(meta, /^description: .+/m);
    assert.match(meta, /^allowed-tools:\n(  - .+\n?)+/m);
  });

  it('allows only the file, shell and question tools it needs', () => {
    const tools = [...meta.matchAll(/^  - (.+)$/gm)].map((m) => m[1]).sort();
    assert.deepEqual(tools, ['AskUserQuestion', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write']);
  });

  it('loads its workflow through the execution context', () => {
    assert.match(command, /<execution_context>[\s\S]*@~\/\.claude\/fv-skills\/workflows\/roadmap\.md[\s\S]*<\/execution_context>/);
    assert.match(workflow, /<(purpose|objective)>/);
    assert.match(workflow, /<process>/);
  });
});

// ---------------------------------------------------------------------------
// Vocabulary: the artefact is a roadmap, never a spec or a plan
// ---------------------------------------------------------------------------
describe('roadmap vocabulary', () => {
  const allowed = (text) => text
    .split('\n').filter((line) => !line.startsWith('Vocabulary:')).join('\n')
    .replace(/\/fvs:(?:fc|crypto)-plan\b/g, '')
    .replace(/\bfv-plans\b/g, '')
    .replace(/\bPLAN\.md\b/g, '')
    .replace(/\blean-spec(?:ify|-review)\b/g, '');

  it('states the vocabulary rule in one sanctioned line', () => {
    assert.match(workflow, /^Vocabulary: .*roadmap.*Lean theorem statement.*fc-plan.*crypto-plan/m);
  });

  it('never uses the bare words spec or plan outside that line and the existing command names', () => {
    assert.doesNotMatch(allowed(both), /\b(spec|plan)\b/i);
  });

  it('names the artefact ROADMAP.md and keeps the words out of the name and description', () => {
    assert.match(workflow, /ROADMAP\.md/);
    assert.match(command, /ROADMAP\.md/);
    assert.doesNotMatch(frontmatter(command), /\b(spec|plan)\b/i);
  });
});

// ---------------------------------------------------------------------------
// The roadmap template
// ---------------------------------------------------------------------------
describe('roadmap template', () => {
  it('is present and carries the discovery marker in its frontmatter', () => {
    assert.ok(TEMPLATE, 'workflow embeds the template in a markdown block that starts with the marker');
    assert.match(frontmatter(TEMPLATE), /^fvs_roadmap: true$/m);
  });

  it('has exactly the eight sections, in order', () => {
    const headings = [...TEMPLATE.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(headings, [
      'Goal',
      'Claims to establish',
      'Scope, exclusions and non-goals',
      'Assumptions and external boundaries',
      'Milestones',
      'Owner-reserved decisions',
      'Decisions log',
      'Status log',
    ]);
  });

  it('keeps scope, exclusions and non-goals in one section', () => {
    assert.doesNotMatch(TEMPLATE, /^## (Non-goals|Exclusions|Scope)$/m);
  });

  it('gives every milestone a done-when that an existing FVS command or checker decides', () => {
    assert.match(flat(TEMPLATE), /done when/i);
    assert.match(flat(workflow), /existing FVS command or checker/i);
    for (const checker of ['/fvs:lean-spec-review', '/fvs:lean-verify', '/fvs:trust-audit', '/fvs:aeneas-extract']) {
      assert.ok(workflow.includes(checker), `done-when guidance names ${checker}`);
    }
  });

  it('records the contents the template always carries inside its sections', () => {
    const text = flat(workflow);
    for (const content of [
      /exact (target )?revision/i,
      /configuration and features/i,
      /trust and axiom policy/i,
      /acceptance evidence and (who has )?authority/i,
      /security experiment or adversary model/i,
      /intended quantitative conclusion/i,
      /both endpoints/i,
      /correspondence relation/i,
    ]) {
      assert.match(text, content);
    }
  });

  it('carries a decisions log that can name what it replaces and a dated status log', () => {
    assert.match(TEMPLATE, /\| ID \| Date \| Decision \| Reason \| Supersedes \|/);
    assert.match(TEMPLATE, /\| Date \| Entry \|/);
  });
});

describe('honest-scope language', () => {
  const template = flat(TEMPLATE);
  const text = flat(workflow);

  it('writes the three scope sentences into every roadmap', () => {
    assert.match(template, /no whole-library correctness or security claim beyond the stated scope/i);
    assert.match(template, /extraction success is not proof/i);
    assert.match(template, /conditional results stay labelled conditional/i);
  });

  it('states that approval grants no execution, spending or publication authority', () => {
    assert.match(template, /roadmap approval grants no execution, spending or publication authority/i);
    assert.match(template, /concrete runs need their own approval/i);
  });

  it('keeps unknowns explicit, blocks their milestones and never invents an answer', () => {
    assert.match(text, /never invent an answer/i);
    assert.match(text, /UNKNOWN/);
    assert.match(text, /blocked/i);
  });

  it('does not require numbers for budgets and limits', () => {
    assert.match(text, /budgets and limits are recorded when relevant/i);
  });

  it('says git exclusion is a local-storage default and not permission to publish', () => {
    assert.match(text, /git exclusion is a local-storage default, not encryption or permission to publish/i);
  });
});

// ---------------------------------------------------------------------------
// Synthesis first, then one bounded interview
// ---------------------------------------------------------------------------
describe('roadmap interview', () => {
  const text = flat(workflow);

  it('synthesizes from the conversation before asking anything', () => {
    assert.match(text, /synthesi[sz]e .*before (asking|interviewing)/i);
    assert.match(text, /without interviewing/i);
  });

  it('bounds the initial interview at seven questions, as a ceiling and never a quota', () => {
    assert.match(text, /at most seven questions/i);
    assert.match(text, /ceiling/i);
    assert.match(text, /never a quota/i);
    assert.match(text, /initial interview only/i);
    assert.match(text, /later essential clarification|required consents/i);
  });

  it('groups related questions and names the seven topics', () => {
    for (const topic of [
      /target and exact revision/i,
      /scope and exclusions/i,
      /claims to establish/i,
      /external or model boundaries/i,
      /trust and axiom policy/i,
      /budget and limits/i,
      /review route/i,
    ]) {
      assert.match(text, topic);
    }
    assert.match(text, /configuration with (the )?revision/i);
    assert.match(text, /adversary model with (the )?security claims/i);
    assert.match(text, /both endpoints with (the )?bridging boundaries/i);
    assert.match(text, /acceptance authority with (the )?review route/i);
  });

  it('uses the runtime-neutral question wording', () => {
    assert.ok(workflow.includes('(AskUserQuestion; on Codex or Pi a plain-text question, then wait)'));
  });

  it('inlines the questioning and never depends on a user-installed skill', () => {
    // Assembled at runtime so this file does not match itself.
    const forbidden = new RegExp(['gri', 'll'].join(''), 'i');
    assert.doesNotMatch(both, forbidden);
    assert.doesNotMatch(frontmatter(command), /^  - Skill$/m);
  });
});

// ---------------------------------------------------------------------------
// Location, untrusted input and git exclusion
// ---------------------------------------------------------------------------
describe('roadmap location and safety rules', () => {
  const text = flat(workflow);

  it('writes under fv-plans by default, accepts an explicit path and names the auto-track location', () => {
    assert.match(text, /\.formalising\/fv-plans\/<topic>\/ROADMAP\.md/);
    assert.match(text, /\.formalising\/auto-fv\/ROADMAP\.md/);
    assert.match(text, /explicit path/i);
  });

  it('treats topic and path as untrusted: quoted expansions, no eval', () => {
    assert.match(text, /untrusted/i);
    assert.match(text, /never `?eval`?/i);
    const blocks = [...workflow.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
    assert.ok(blocks.length >= 4, 'workflow ships its shell blocks');
    for (const block of blocks) assert.doesNotMatch(block, /(?<![-\w])eval(?![-\w])/);
  });

  it('checks git exclusion before writing, offers info/exclude only, and never edits a tracked ignore file', () => {
    assert.match(text, /git check-ignore/);
    assert.match(text, /info\/exclude/);
    assert.match(text, /never edit a tracked ignore file/i);
    assert.match(text, /\.formalising\/`? and `?\/\.formalising/);
    assert.match(text, /noninteractive run never prompts and never infers consent/i);
  });

  it('references probe-derived facts from CODEMAP and never restates them', () => {
    assert.match(text, /\.formalising\/CODEMAP\.md/);
    assert.match(text, /never restate/i);
  });

  it('only writes the tracker override block when the user asks', () => {
    assert.match(text, /issues:.*only when the user asks/i);
  });

  it('states that provider null means unconfigured and that the override replaces the default whole', () => {
    assert.match(text, /provider: null.*unconfigured/i);
    assert.match(text, /replaces the project default as a whole/i);
    assert.match(text, /no field-wise merge/i);
  });
});

describe('roadmap rerun', () => {
  const text = flat(workflow);

  it('appends to the status and decisions logs and never silently rewrites a decision', () => {
    assert.match(text, /append/i);
    assert.match(text, /never silently rewrites? (a |any )?decision/i);
  });

  it('keeps superseded decisions and names any replacement explicitly', () => {
    assert.match(text, /supersed/i);
    assert.match(text, /names? (the|any) replacement explicitly/i);
  });

  it('appends one dated status-log row on every rerun, even when no decision changed', () => {
    assert.match(text, /every rerun appends exactly one dated status log row/i);
  });

  it('only treats an existing file as a roadmap when it is named ROADMAP.md or carries the marker', () => {
    assert.match(text, /named ROADMAP\.md or carrying the marker/i);
  });

  it('edits in place with Edit rather than rewriting the whole file', () => {
    assert.match(text, /Edit/);
    assert.match(text, /byte[- ]for[- ]byte|untouched text/i);
  });
});

describe('roadmap discovery and the manage router', () => {
  it('lists existing roadmaps for a bare invocation as a plain numbered list from a union scan', () => {
    const text = flat(workflow);
    assert.match(text, /union scan/i);
    assert.match(text, /fvs_roadmap: true/);
    assert.match(text, /numbered list/i);
  });

  it('is routed by /fvs:manage and resolved by its requires closure', () => {
    const manage = fs.readFileSync(path.join(ROOT, 'commands', 'fvs', 'manage.md'), 'utf8');
    assert.match(manage, /^requires: \[.*\broadmap\b.*\]$/m);
    assert.match(manage, /\| .+ \| fvs:roadmap \|/);
  });
});

// ---------------------------------------------------------------------------
// Behavioural gates: run the workflow's bash blocks in throwaway repositories
// ---------------------------------------------------------------------------
const SHELLS = ['sh', 'bash', 'zsh'].filter((shell) => spawnSync(shell, ['-c', 'exit 0']).status === 0);
const SCRATCH = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fvs-roadmap-'));
after(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

let counter = 0;
function scratchDir(label) {
  const dir = path.join(SCRATCH, `${label}-${counter += 1}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv() });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

function gitEnv(extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: SCRATCH,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: SCRATCH,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
    ...extra,
  };
}

function makeRepo(label) {
  const dir = scratchDir(label);
  git(dir, 'init', '-q');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

function run(shell, block, cwd, env = {}) {
  return spawnSync(shell, ['-c', block], { cwd, encoding: 'utf8', env: gitEnv(env) });
}

describe('roadmap path block', () => {
  const block = bashBlock(workflow, 'fvs:roadmap-path');
  const cwd = scratchDir('path');

  for (const shell of SHELLS) {
    describe(`under ${shell}`, () => {
      const resolve = (env) => run(shell, block, cwd, env);

      it('maps a topic to the per-topic location', () => {
        for (const topic of ['libcrux-ml-kem', 'CKA_from.KEM2', 'a']) {
          const result = resolve({ ROADMAP_TOPIC: topic });
          assert.equal(result.status, 0, result.stderr);
          assert.equal(result.stdout, `.formalising/fv-plans/${topic}/ROADMAP.md\n`);
        }
      });

      it('accepts an explicit file or directory path', () => {
        const cases = {
          '.formalising/auto-fv/ROADMAP.md': '.formalising/auto-fv/ROADMAP.md',
          'docs/road.md': 'docs/road.md',
          '.formalising/fv-plans/CKA-from-KEM/': '.formalising/fv-plans/CKA-from-KEM/ROADMAP.md',
        };
        for (const [given, expected] of Object.entries(cases)) {
          const result = resolve({ ROADMAP_PATH: given });
          assert.equal(result.status, 0, `${given}: ${result.stderr}`);
          assert.equal(result.stdout, `${expected}\n`);
        }
      });

      it('rejects shell metacharacters, traversal and malformed topics without executing anything', () => {
        const hostilePaths = [
          'a b.md', '$(touch pwned).md', '`touch pwned`.md', 'a;touch pwned.md', 'a|b.md', 'a&b.md',
          'a*.md', "a'b.md", 'a"b.md', 'a\nb.md', '../x.md', 'a/../../x.md', '/etc/x.md', '-rf.md',
          '~/x.md', 'a//b.md', 'notes.txt', 'dir',
        ];
        for (const given of hostilePaths) {
          const result = resolve({ ROADMAP_PATH: given });
          assert.equal(result.status, 2, `path ${JSON.stringify(given)} must be rejected`);
          assert.equal(result.stdout, '');
          assert.match(result.stderr, /^FVS >> /);
        }
        const hostileTopics = ['a/b', '-x', '.x', 'a b', 'a'.repeat(65), 'a$b', 'a;b', '..'];
        for (const topic of hostileTopics) {
          const result = resolve({ ROADMAP_TOPIC: topic });
          assert.equal(result.status, 2, `topic ${JSON.stringify(topic)} must be rejected`);
          assert.equal(result.stdout, '');
        }
        assert.deepEqual(fs.readdirSync(cwd), [], 'nothing was created or executed');
      });

      it('requires exactly one of topic and path', () => {
        assert.equal(resolve({}).status, 2);
        assert.equal(resolve({ ROADMAP_TOPIC: 'a', ROADMAP_PATH: 'b.md' }).status, 2);
      });

      it('refuses an existing file that is not a roadmap, but accepts ROADMAP.md or a marked file', () => {
        const dir = scratchDir('path-existing');
        fs.writeFileSync(path.join(dir, 'README.md'), '# not a roadmap\n');
        fs.writeFileSync(path.join(dir, 'ROADMAP.md'), '# hand-written, no marker\n');
        fs.writeFileSync(path.join(dir, 'custom.md'), '---\nfvs_roadmap: true\n---\n');
        const refused = run(shell, block, dir, { ROADMAP_PATH: 'README.md' });
        assert.equal(refused.status, 2);
        assert.equal(refused.stdout, '');
        assert.match(refused.stderr, /not a roadmap/);
        for (const name of ['ROADMAP.md', 'custom.md']) {
          const accepted = run(shell, block, dir, { ROADMAP_PATH: name });
          assert.equal(accepted.status, 0, `${name}: ${accepted.stderr}`);
          assert.equal(accepted.stdout, `${name}\n`);
        }
        assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), '# not a roadmap\n');
      });

      it('refuses to write through a symlinked roadmap file', () => {
        const dir = scratchDir('path-link');
        fs.writeFileSync(path.join(dir, 'real.md'), 'x');
        fs.symlinkSync('real.md', path.join(dir, 'link.md'));
        const result = run(shell, block, dir, { ROADMAP_PATH: 'link.md' });
        assert.equal(result.status, 2);
        assert.equal(result.stdout, '');
      });
    });
  }
});

describe('roadmap exclusion check and append blocks', () => {
  const check = bashBlock(workflow, 'fvs:roadmap-exclusion');
  const append = bashBlock(workflow, 'fvs:roadmap-exclude-append');
  const TARGET = '.formalising/fv-plans/topic/ROADMAP.md';

  for (const shell of SHELLS) {
    describe(`under ${shell}`, () => {
      const status = (cwd, file = TARGET) => {
        const result = run(shell, check, cwd, { ROADMAP_FILE: file });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
      };

      it('reports not-git outside a work tree', () => {
        assert.equal(status(scratchDir('no-git')), 'not-git');
      });

      it('reports visible until the append block has run, then excluded', () => {
        const repo = makeRepo('exclude');
        assert.equal(status(repo), 'visible');
        const added = run(shell, append, repo);
        assert.equal(added.status, 0, added.stderr);
        assert.equal(status(repo), 'excluded');
      });

      it('appends both patterns once, keeps existing lines and repairs a missing final newline', () => {
        const repo = makeRepo('append');
        const exclude = path.join(repo, '.git', 'info', 'exclude');
        fs.mkdirSync(path.dirname(exclude), { recursive: true });
        fs.writeFileSync(exclude, '*.swp');
        for (let pass = 0; pass < 2; pass += 1) {
          assert.equal(run(shell, append, repo).status, 0);
        }
        assert.equal(fs.readFileSync(exclude, 'utf8'), '*.swp\n.formalising/\n/.formalising\n');
      });

      it('never touches a tracked ignore file', () => {
        const repo = makeRepo('tracked');
        fs.writeFileSync(path.join(repo, '.gitignore'), 'build/\n');
        git(repo, 'add', '.gitignore');
        git(repo, 'commit', '-q', '-m', 'ignore');
        assert.equal(run(shell, append, repo).status, 0);
        assert.equal(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'), 'build/\n');
        assert.equal(git(repo, 'status', '--porcelain'), '');
      });

      it('checks the symlink itself when .formalising is a symlink, which needs the second pattern', () => {
        const repo = makeRepo('symlink');
        const shared = scratchDir('symlink-target');
        fs.symlinkSync(shared, path.join(repo, '.formalising'));
        const exclude = path.join(repo, '.git', 'info', 'exclude');
        fs.mkdirSync(path.dirname(exclude), { recursive: true });
        fs.writeFileSync(exclude, '.formalising/\n');
        assert.equal(status(repo), 'visible', 'a directory-only pattern does not match a symlink');
        assert.equal(run(shell, append, repo).status, 0);
        assert.equal(status(repo), 'excluded');
        assert.equal(git(repo, 'status', '--porcelain'), '');
      });

      it('leaves a target outside .formalising visible so the workflow can ask again', () => {
        const repo = makeRepo('outside');
        assert.equal(run(shell, append, repo).status, 0);
        assert.equal(status(repo, 'docs/ROADMAP.md'), 'visible');
      });

      it('writes the shared info/exclude of a linked worktree', () => {
        const repo = makeRepo('main');
        const linked = path.join(scratchDir('linked'), 'wt');
        git(repo, 'worktree', 'add', '-q', linked);
        assert.ok(fs.statSync(path.join(linked, '.git')).isFile(), '.git is a file in a linked worktree');
        const added = run(shell, append, linked);
        assert.equal(added.status, 0, added.stderr);
        const shared = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
        assert.match(shared, /^\.formalising\/$/m);
        assert.match(shared, /^\/\.formalising$/m);
        assert.equal(status(linked), 'excluded');
      });
    });
  }
});

describe('roadmap discovery block', () => {
  const block = bashBlock(workflow, 'fvs:roadmap-discover');
  const seed = (root) => {
    const files = {
      'fv-plans/a/ROADMAP.md': '---\nfvs_roadmap: true\n---\n',
      'fv-plans/b/custom-name.md': '---\nfvs_roadmap: true\n---\n',
      'fv-plans/c/notes.md': '# not a roadmap\n',
      'auto-fv/ROADMAP.md': '# roadmap without the marker\n',
      'other/elsewhere.md': '---\nfvs_roadmap: true\n---\n',
      '.kb-venv/lib/skip.md': '---\nfvs_roadmap: true\n---\n',
      'extract/skip.md': '---\nfvs_roadmap: true\n---\n',
    };
    for (const [name, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), body);
    }
  };
  const expected = [
    '.formalising/auto-fv/ROADMAP.md',
    '.formalising/fv-plans/a/ROADMAP.md',
    '.formalising/fv-plans/b/custom-name.md',
    '.formalising/other/elsewhere.md',
  ];

  for (const shell of SHELLS) {
    it(`unions the name scan and the marker scan without duplicates under ${shell}`, () => {
      const cwd = scratchDir('discover');
      seed(path.join(cwd, '.formalising'));
      const result = run(shell, block, cwd);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.stdout.trim().split('\n'), expected);
    });

    it(`follows a symlinked .formalising under ${shell}`, () => {
      const cwd = scratchDir('discover-link');
      const shared = scratchDir('discover-shared');
      seed(shared);
      fs.symlinkSync(shared, path.join(cwd, '.formalising'));
      const result = run(shell, block, cwd);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.stdout.trim().split('\n'), expected);
    });

    it(`prints nothing when there is no .formalising under ${shell}`, () => {
      const result = run(shell, block, scratchDir('discover-empty'));
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), '');
    });
  }
});
