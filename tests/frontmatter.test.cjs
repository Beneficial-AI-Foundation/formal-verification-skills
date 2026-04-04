'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Helper: parse YAML-ish frontmatter between --- delimiters
// Returns { meta: { key: value, ... }, body: string }
// ---------------------------------------------------------------------------
function parseFrontmatter(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');

  // Find opening and closing ---
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      if (start === -1) { start = i; }
      else { end = i; break; }
    }
  }

  const meta = {};
  if (start !== -1 && end !== -1) {
    for (let i = start + 1; i < end; i++) {
      const line = lines[i];
      const colonIdx = line.indexOf(':');
      if (colonIdx !== -1) {
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();
        meta[key] = value;
      }
    }
  }

  const body = end !== -1 ? lines.slice(end + 1).join('\n') : raw;
  return { meta, body };
}

// ---------------------------------------------------------------------------
// Helper: list .md files in a directory
// ---------------------------------------------------------------------------
function mdFiles(dir) {
  const abs = path.join(ROOT, dir);
  return fs.readdirSync(abs)
    .filter(f => f.endsWith('.md'))
    .sort();
}

// ============================= COMMANDS =====================================
describe('Commands (commands/fvs/)', () => {
  const dir = 'commands/fvs';
  const files = mdFiles(dir);

  const expected = [
    'checkpoint.md', 'help.md', 'lean-proof-port.md', 'lean-refactor.md',
    'lean-spec-port.md', 'lean-specify.md', 'lean-verify.md', 'map-code.md',
    'natural-language.md', 'pause-work.md', 'plan.md', 'reapply-patches.md',
    'resume-work.md', 'update.md',
  ];

  it('has exactly 14 command files', () => {
    assert.equal(files.length, 14, `Expected 14 commands, got ${files.length}: ${files.join(', ')}`);
  });

  it('has the expected set of command files', () => {
    assert.deepStrictEqual(files, expected);
  });

  for (const file of expected) {
    const filePath = path.join(ROOT, dir, file);

    it(`${file} has name: in frontmatter`, () => {
      const { meta } = parseFrontmatter(filePath);
      assert.ok(meta.name, `${file} missing name:`);
    });

    it(`${file} has name matching /^fvs:/`, () => {
      const { meta } = parseFrontmatter(filePath);
      assert.match(meta.name, /^fvs:/, `${file} name "${meta.name}" does not start with fvs:`);
    });

    it(`${file} has description: in frontmatter`, () => {
      const { meta } = parseFrontmatter(filePath);
      assert.ok(meta.description, `${file} missing description:`);
    });
  }

  // 9 of 11 must have allowed-tools (exceptions: help.md, update.md)
  const displayOnly = new Set(['help.md', 'update.md']);
  for (const file of expected) {
    if (displayOnly.has(file)) continue;
    it(`${file} has allowed-tools: in frontmatter`, () => {
      const filePath = path.join(ROOT, dir, file);
      const { meta } = parseFrontmatter(filePath);
      assert.ok('allowed-tools' in meta, `${file} missing allowed-tools:`);
    });
  }
});

// ============================= AGENTS =======================================
describe('Agents (agents/)', () => {
  const dir = 'agents';
  const files = mdFiles(dir);

  const expected = [
    'fvs-code-reader.md', 'fvs-dependency-analyzer.md', 'fvs-executor.md',
    'fvs-explainer.md', 'fvs-lean-prover.md', 'fvs-lean-refactorer.md',
    'fvs-lean-spec-generator.md', 'fvs-researcher.md',
  ];

  it('has exactly 8 agent files', () => {
    assert.equal(files.length, 8, `Expected 8 agents, got ${files.length}: ${files.join(', ')}`);
  });

  it('has the expected set of agent files', () => {
    assert.deepStrictEqual(files, expected);
  });

  const requiredFields = ['name', 'description', 'tools', 'color'];

  for (const file of expected) {
    const filePath = path.join(ROOT, dir, file);

    for (const field of requiredFields) {
      it(`${file} has ${field}: in frontmatter`, () => {
        const { meta } = parseFrontmatter(filePath);
        assert.ok(meta[field], `${file} missing ${field}:`);
      });
    }

    it(`${file} has name matching /^fvs-/`, () => {
      const { meta } = parseFrontmatter(filePath);
      assert.match(meta.name, /^fvs-/, `${file} name "${meta.name}" does not start with fvs-`);
    });
  }
});

// ============================= WORKFLOWS ====================================
describe('Workflows (fv-skills/workflows/)', () => {
  const dir = 'fv-skills/workflows';
  const files = mdFiles(dir);

  const expected = [
    'lean-proof-port.md', 'lean-refactor.md', 'lean-spec-port.md',
    'lean-specify.md', 'lean-verify.md', 'map-code.md',
    'natural-language.md', 'plan.md', 'update.md',
  ];

  it('has exactly 9 workflow files', () => {
    assert.equal(files.length, 9, `Expected 9 workflows, got ${files.length}: ${files.join(', ')}`);
  });

  it('has the expected set of workflow files', () => {
    assert.deepStrictEqual(files, expected);
  });

  for (const file of expected) {
    const filePath = path.join(ROOT, dir, file);

    it(`${file} contains <purpose> or <objective> tag`, () => {
      const { body } = parseFrontmatter(filePath);
      const hasPurpose = body.includes('<purpose>');
      const hasObjective = body.includes('<objective>');
      assert.ok(hasPurpose || hasObjective,
        `${file} missing both <purpose> and <objective> tags`);
    });

    it(`${file} contains <process> tag`, () => {
      const { body } = parseFrontmatter(filePath);
      assert.ok(body.includes('<process>'), `${file} missing <process> tag`);
    });
  }
});

// ============================= REFERENCES ===================================
describe('References (fv-skills/references/)', () => {
  const dir = 'fv-skills/references';
  const files = mdFiles(dir);

  const expected = [
    'aeneas-patterns.md', 'lean-refactoring.md', 'lean-spec-conventions.md',
    'model-profiles.md', 'proof-strategies.md', 'tactic-usage.md', 'ui-brand.md',
  ];

  it('has exactly 7 reference files', () => {
    assert.equal(files.length, 7, `Expected 7 references, got ${files.length}: ${files.join(', ')}`);
  });

  it('has the expected set of reference files', () => {
    assert.deepStrictEqual(files, expected);
  });

  for (const file of expected) {
    const filePath = path.join(ROOT, dir, file);

    it(`${file} contains <overview> or <purpose> or structural top-level tag`, () => {
      const raw = fs.readFileSync(filePath, 'utf8');
      const hasOverview = raw.includes('<overview>');
      const hasPurpose = raw.includes('<purpose>');
      // ui-brand.md uses <ui_patterns> as its structural tag
      const hasUiPatterns = raw.includes('<ui_patterns>');
      assert.ok(hasOverview || hasPurpose || hasUiPatterns,
        `${file} missing structural top-level tag (<overview>, <purpose>, or <ui_patterns>)`);
    });
  }
});

// ============================= CROSS-REFERENCES =============================
describe('Cross-references', () => {

  it('all workflow @-references in commands point to existing workflow files', () => {
    const cmdDir = path.join(ROOT, 'commands', 'fvs');
    const wfDir = path.join(ROOT, 'fv-skills', 'workflows');
    const wfFiles = new Set(fs.readdirSync(wfDir));
    const cmdFiles = fs.readdirSync(cmdDir).filter(f => f.endsWith('.md'));

    const missing = [];
    for (const file of cmdFiles) {
      const content = fs.readFileSync(path.join(cmdDir, file), 'utf8');
      const refs = content.match(/@~\/\.claude\/fv-skills\/workflows\/([^\s]+)/g) || [];
      for (const ref of refs) {
        const wfName = ref.replace('@~/.claude/fv-skills/workflows/', '');
        if (!wfFiles.has(wfName)) {
          missing.push(`${file} -> ${wfName}`);
        }
      }
    }
    assert.deepStrictEqual(missing, [], `Broken workflow refs: ${missing.join(', ')}`);
  });

  it('all reference @-references in commands and workflows point to existing reference files', () => {
    const refDir = path.join(ROOT, 'fv-skills', 'references');
    const refFiles = new Set(fs.readdirSync(refDir));

    const dirs = [
      path.join(ROOT, 'commands', 'fvs'),
      path.join(ROOT, 'fv-skills', 'workflows'),
    ];

    const missing = [];
    for (const dir of dirs) {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const content = fs.readFileSync(path.join(dir, file), 'utf8');
        const refs = content.match(/@~\/\.claude\/fv-skills\/references\/([^\s]+)/g) || [];
        for (const ref of refs) {
          const refName = ref.replace('@~/.claude/fv-skills/references/', '');
          if (!refFiles.has(refName)) {
            missing.push(`${file} -> ${refName}`);
          }
        }
      }
    }
    assert.deepStrictEqual(missing, [], `Broken reference refs: ${missing.join(', ')}`);
  });

  it('all subagent_type dispatches reference existing agent files', () => {
    const agentDir = path.join(ROOT, 'agents');
    const agentFiles = new Set(
      fs.readdirSync(agentDir)
        .filter(f => f.endsWith('.md'))
        .map(f => f.replace('.md', ''))
    );

    const dirs = [
      path.join(ROOT, 'commands', 'fvs'),
      path.join(ROOT, 'fv-skills', 'workflows'),
    ];

    const missing = [];
    for (const dir of dirs) {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const content = fs.readFileSync(path.join(dir, file), 'utf8');
        const dispatches = content.match(/subagent_type="(fvs-[^"]+)"/g) || [];
        for (const dispatch of dispatches) {
          const name = dispatch.match(/subagent_type="(fvs-[^"]+)"/)[1];
          if (!agentFiles.has(name)) {
            missing.push(`${file} -> ${name}`);
          }
        }
      }
    }
    assert.deepStrictEqual(missing, [], `Broken agent dispatches: ${missing.join(', ')}`);
  });
});

// ============================= FIXTURE ======================================
describe('Fixture (tests/fixtures/minimal-aeneas-project/)', () => {
  const fixtureDir = path.join(ROOT, 'tests', 'fixtures', 'minimal-aeneas-project');

  it('lean-toolchain exists and contains leanprover/lean4:', () => {
    const filePath = path.join(fixtureDir, 'lean-toolchain');
    assert.ok(fs.existsSync(filePath), 'lean-toolchain missing');
    const content = fs.readFileSync(filePath, 'utf8');
    assert.ok(content.includes('leanprover/lean4:'), 'lean-toolchain missing leanprover/lean4:');
  });

  it('lakefile.toml exists and contains aeneas', () => {
    const filePath = path.join(fixtureDir, 'lakefile.toml');
    assert.ok(fs.existsSync(filePath), 'lakefile.toml missing');
    const content = fs.readFileSync(filePath, 'utf8');
    assert.ok(content.includes('aeneas'), 'lakefile.toml missing aeneas reference');
  });

  it('src/Funs.lean exists', () => {
    const filePath = path.join(fixtureDir, 'src', 'Funs.lean');
    assert.ok(fs.existsSync(filePath), 'src/Funs.lean missing');
  });
});
