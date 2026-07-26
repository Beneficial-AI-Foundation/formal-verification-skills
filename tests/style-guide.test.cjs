'use strict';

const { after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CHECKER = path.join(ROOT, 'scripts', 'fvs-lean-style-check.mjs');
const tempDirs = [];

function fixture(prefix = 'fvs-style-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function write(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function run(root, args) {
  return spawnSync(process.execPath, [CHECKER, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Lean style guide discovery (#40)', () => {
  it('finds doc/STYLE_GUIDE and derives its line limit', () => {
    const root = fixture();
    write(root, 'doc/STYLE_GUIDE', [
      '# Lean style',
      '',
      'Lines must not exceed 88 characters.',
    ].join('\n'));

    const result = run(root, ['discover', '--root', root]);
    assert.equal(result.status, 0, result.stderr);
    const info = JSON.parse(result.stdout);
    assert.equal(info.status, 'found');
    assert.equal(info.path, 'doc/STYLE_GUIDE');
    assert.equal(info.maxLineLength, 88);
    assert.equal(info.maxQualifiedDots, 2);
  });

  it('uses configured project.style_guide_path ahead of auto-discovery', () => {
    const root = fixture();
    write(root, 'doc/STYLE_GUIDE', 'Line length: 100 characters.\n');
    write(root, 'conventions/LEAN_STYLE.md', 'Wrap every line at 72 columns.\n');
    write(root, '.formalising/fvs-config.json', JSON.stringify({
      project: { style_guide_path: 'conventions/LEAN_STYLE.md' },
    }));

    const result = run(root, ['discover', '--root', root]);
    assert.equal(result.status, 0, result.stderr);
    const info = JSON.parse(result.stdout);
    assert.equal(info.path, 'conventions/LEAN_STYLE.md');
    assert.equal(info.source, 'project.style_guide_path');
    assert.equal(info.maxLineLength, 72);
  });

  it('fails closed on ambiguous guides instead of guessing', () => {
    const root = fixture();
    write(root, 'doc/STYLE_GUIDE', 'Line length: 100 characters.\n');
    write(root, 'STYLE.md', 'Line length: 80 characters.\n');

    const result = run(root, ['discover', '--root', root]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /multiple style guides.*project\.style_guide_path/i);
    assert.match(result.stderr, /doc\/STYLE_GUIDE/);
    assert.match(result.stderr, /STYLE\.md/);
  });

  it('rejects a configured style guide outside the target repository', () => {
    const root = fixture();
    const outside = fixture('fvs-style-outside-');
    write(outside, 'STYLE_GUIDE', 'Line length: 90 characters.\n');
    write(root, '.formalising/fvs-config.json', JSON.stringify({
      project: { style_guide_path: path.join('..', path.basename(outside), 'STYLE_GUIDE') },
    }));

    const result = run(root, ['discover', '--root', root]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /outside the project root/i);
  });

  it('records deterministic FVS limits when no target guide exists', () => {
    const root = fixture();
    const result = run(root, ['discover', '--root', root]);
    assert.equal(result.status, 0, result.stderr);
    const info = JSON.parse(result.stdout);
    assert.equal(info.status, 'fallback');
    assert.equal(info.path, null);
    assert.equal(info.maxLineLength, 100);
    assert.equal(info.maxQualifiedDots, 2);
  });
});

describe('Lean style mechanical gate (#40)', () => {
  it('flags long lines and 3+-dot identifiers but exempts non-code contexts', () => {
    const root = fixture();
    write(root, 'doc/STYLE_GUIDE', 'Lines must not exceed 60 characters.\n');
    write(root, 'Specs/Bad.lean', [
      'import External.Very.Deep.Namespace.Module',
      'namespace External.Very.Deep.Namespace',
      '-- External.Very.Deep.Namespace.comment is ignored',
      'def text := "External.Very.Deep.Namespace.string"',
      'theorem bad : External.Very.Deep.Namespace.value = 0 := by',
      '  have an_intentionally_long_local_name_that_crosses_the_configured_limit : True := by',
      '    trivial',
      '  simp',
      'end External.Very.Deep.Namespace',
    ].join('\n'));

    const result = run(root, ['check', 'Specs/Bad.lean', '--root', root]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FVS-LINE-LENGTH/);
    assert.match(result.stderr, /FVS-DEEP-QUALIFICATION.*External\.Very\.Deep\.Namespace\.value/);
    assert.doesNotMatch(result.stderr, /Namespace\.Module/);
    assert.doesNotMatch(result.stderr, /Namespace\.comment/);
    assert.doesNotMatch(result.stderr, /Namespace\.string/);
  });

  it('accepts scoped local names within the configured limit', () => {
    const root = fixture();
    write(root, 'doc/STYLE_GUIDE', 'Maximum line length: 80 characters.\n');
    write(root, 'Specs/Good.lean', [
      'import External.Very.Deep.Namespace.Module',
      'open External.Very.Deep.Namespace',
      '',
      'theorem good : value = 0 := by',
      '  simp',
    ].join('\n'));

    const result = run(root, ['check', 'Specs/Good.lean', '--root', root]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /FVS_STYLE_OK/);
  });

  it('allows legacy baseline debt but rejects a newly introduced violation', () => {
    const root = fixture();
    write(root, 'doc/STYLE_GUIDE', 'Line length: 100 characters.\n');
    const legacy = [
      'theorem legacy : Existing.Deep.Namespace.value = 0 := by',
      '  sorry',
    ].join('\n');
    write(root, 'baseline.lean', legacy);
    write(root, 'Specs/Edited.lean', [
      'theorem legacy : Existing.Deep.Namespace.value = 0 := by',
      '  have h := Newly.Deep.Namespace.value',
      '  sorry',
    ].join('\n'));

    const failed = run(root, [
      'check', 'Specs/Edited.lean', '--root', root, '--baseline', 'baseline.lean',
    ]);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Newly\.Deep\.Namespace\.value/);
    assert.doesNotMatch(failed.stderr, /Existing\.Deep\.Namespace\.value/);

    write(root, 'Specs/Edited.lean', [
      'theorem legacy : Existing.Deep.Namespace.value = 0 := by',
      '  sorry',
    ].join('\n'));
    const passed = run(root, [
      'check', 'Specs/Edited.lean', '--root', root, '--baseline', 'baseline.lean',
    ]);
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(passed.stdout, /no new violations/);
  });
});

describe('Lean style workflow contracts (#40)', () => {
  const commandPaths = [
    'commands/fvs/lean-specify.md',
    'commands/fvs/lean-verify.md',
  ];
  const workflowPaths = [
    'fv-skills/workflows/lean-specify.md',
    'fv-skills/workflows/lean-verify.md',
  ];

  for (const relative of [...commandPaths, ...workflowPaths]) {
    it(`${relative} discovers, inlines, and checks target style`, () => {
      const content = fs.readFileSync(path.join(ROOT, relative), 'utf8');
      assert.match(content, /fvs-lean-style-check\.mjs discover/);
      assert.match(content, /target_style_guide|complete target (?:repository )?style guide/i);
      assert.match(content, /fvs-lean-style-check\.mjs check/);
      assert.match(content, /100 column|100-column|100 columns/i);
      assert.match(content, /three or more namespace dots|3\+-dot/i);
    });
  }

  it('lean-specify has a bounded, semantics-preserving repair loop', () => {
    const content = fs.readFileSync(path.join(ROOT, commandPaths[0]), 'utf8');
    assert.match(content, /at most two repair passes/i);
    assert.match(content, /preserve the theorem's mathematical proposition/i);
  });

  it('lean-verify protects statements and admits no new baseline debt', () => {
    const content = fs.readFileSync(path.join(ROOT, commandPaths[1]), 'utf8');
    assert.match(content, /--baseline "\$STYLE_BASELINE"/);
    assert.match(content, /MUST NOT edit theorem names or theorem statements/i);
    assert.match(content, /without `--baseline`/i);
  });

  it('executor and conventions carry the hard target-style rules', () => {
    const executor = fs.readFileSync(path.join(ROOT, 'agents/fvs-executor.md'), 'utf8');
    const conventions = fs.readFileSync(
      path.join(ROOT, 'fv-skills/references/lean-spec-conventions.md'),
      'utf8',
    );
    assert.match(
      executor,
      /target (?:repository )?style guide as a hard (?:constraint|output contract)/i,
    );
    assert.match(executor, /three or more namespace dots/i);
    assert.match(conventions, /project\.style_guide_path/);
    assert.match(conventions, /fvs-lean-style-check\.mjs check/);
  });

  it('config template exposes project.style_guide_path', () => {
    const config = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'fv-skills/templates/config.json'),
      'utf8',
    ));
    assert.equal(config.project.style_guide_path, null);
  });
});
