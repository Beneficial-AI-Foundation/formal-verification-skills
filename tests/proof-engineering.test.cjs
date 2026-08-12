'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

function requires(text, fragment, label) {
  assert.ok(text.includes(fragment), `${label} must include ${fragment}`);
}

function forbids(text, fragment, label) {
  assert.ok(!text.includes(fragment), `${label} must not include ${fragment}`);
}

function matches(text, pattern, label) {
  assert.match(text, pattern, `${label} must match ${pattern}`);
}

function between(text, start, end, label) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `${label} must include start marker ${start}`);
  assert.ok(endIndex > startIndex, `${label} must include end marker ${end} after ${start}`);
  return text.slice(startIndex, endIndex);
}

describe('indexed proof-engineering memory', () => {
  const indexTemplate = 'fv-skills/templates/proof-engineering-index.md';
  const lessonTemplate = 'fv-skills/templates/proof-engineering-lesson.md';
  const protocol = 'fv-skills/references/proof-engineering-loop.md';

  it('ships an index-first, one-file-per-lesson schema for FC, crypto, and shared learning', () => {
    const index = read(indexTemplate);
    const lesson = read(lessonTemplate);
    const loop = read(protocol);

    for (const fragment of [
      '# FVS Proof Engineering Index',
      'Read this index first',
      'at most eight',
      './lessons/fc/',
      './lessons/crypto/',
      './lessons/shared/',
      '| Lesson record |',
      'first cell is the record link',
      'One lesson or explicit preference per linked Markdown file',
      '800 words',
    ]) requires(index, fragment, indexTemplate);

    for (const fragment of [
      'track: fc | crypto | shared',
      'kind: proof-pattern | modeling-decision | failed-approach | preference',
      'status: provisional | validated | superseded',
      '## Lesson',
      '## Applicability',
      '## Evidence',
      '## Boundaries and Failure Modes',
      '## Reuse Checklist',
      'source_command:',
      '800 words',
    ]) requires(lesson, fragment, lessonTemplate);

    for (const fragment of [
      '.formalising/proof-engineering/',
      'lessons/fc/',
      'lessons/crypto/',
      'lessons/shared/',
      'Read the index first',
      'at most eight',
      '<proof_engineering_context>',
      '<lesson_candidates>',
      'no more than three',
      'one file at `lessons/<track>/',
      'semantic deduplication',
      'reviewable Write diff',
      'symlinks',
      'real path',
    ]) requires(loop, fragment, protocol);
  });

  it('defines evidence gates, migration, promotion, and an independent crypto review boundary', () => {
    const loop = read(protocol);
    for (const fragment of [
      'Green Lean build',
      'observed Lean diagnostic',
      'Paper/standard section citation',
      'accepted adversarial eval or explicit human ruling',
      '.formalising/PROOF-NOTES.md',
      'two or more targets, or across both tracks',
      'promotion is reviewed, never automatic',
      'captured directly as non-track-specific `shared` memory remains `provisional`',
      'crypto-review` stage intentionally does not load project lessons',
      'snapshot is not canonical',
    ]) requires(loop, fragment, protocol);
    matches(loop, /may be stored only as\s+`provisional`/, protocol);
    matches(loop, /Never append to, rename, or delete the legacy file\s+automatically/, protocol);
  });

  it('wires bounded FC memory through both researcher and executor surfaces', () => {
    const surfaces = {
      'lean-specify': [
        'commands/fvs/lean-specify.md',
        'fv-skills/workflows/lean-specify.md',
      ],
      'lean-verify': [
        'commands/fvs/lean-verify.md',
        'fv-skills/workflows/lean-verify.md',
      ],
    };

    for (const [name, files] of Object.entries(surfaces)) {
      for (const file of files) {
        const content = read(file);
        for (const fragment of [
          '.formalising/proof-engineering',
          'proof-engineering-index.md',
          'proof-engineering-lesson.md',
          'Read the index first',
          'at most eight',
          'provisional',
          'uncertain',
          'PROOF_ENGINEERING_CONTEXT',
          '<proof_engineering_context>',
          '<lesson_candidates>',
          'untrusted project reference data',
          'index',
        ]) requires(content, fragment, file);
        matches(content, /at most\s+three/, file);

        assert.ok(
          (content.match(/<proof_engineering_context>/g) || []).length >= 2,
          `${file} must inline bounded memory for researcher and executor`,
        );
        assert.ok(
          (content.match(/<lesson_candidates>/g) || []).length >= 2,
          `${file} must collect candidates from researcher and executor`,
        );
      }

      const compact = read(files[1]);
      assert.ok(
        compact.indexOf('<step name="proof_engineering_memory">') <
          compact.indexOf('<step name="research_phase">'),
        `${name} compact workflow must load memory before research`,
      );

      if (name === 'lean-verify') {
        for (const file of files) {
          const content = read(file);
          requires(content, 'FC-only', file);
          requires(content, 'track=fc', file);
          forbids(content, 'track=crypto', file);
        }
      }
    }
  });

  it('wires the indexed loop through one-shot paper formalisation', () => {
    for (const file of [
      'commands/fvs/lean-formalise.md',
      'fv-skills/workflows/lean-formalise.md',
    ]) {
      const content = read(file);
      for (const fragment of [
        'proof-engineering-loop.md',
        'at most eight',
        'PROOF_ENGINEERING_CONTEXT',
        '<proof_engineering_context>',
        '<lesson_candidates>',
        'at most three',
        'paper',
        'provisional',
      ]) requires(content, fragment, file);
    }
  });

  it('adds the bounded overlay to every learning crypto stage', () => {
    const stages = ['plan', 'execute', 'eval', 'followup'];
    for (const stage of stages) {
      for (const file of [
        `commands/fvs/crypto-${stage}.md`,
        `fv-skills/workflows/crypto-${stage}.md`,
      ]) {
        const content = read(file);
        for (const fragment of [
          'proof-engineering-loop.md',
          'at most eight',
          'crypto',
          'shared',
          'provisional',
          'uncertain',
          'PROOF_ENGINEERING_CONTEXT',
          'sources/proof-engineering-context.md',
          '<proof_engineering_context>',
          '<lesson_candidates>',
          'untrusted project reference data',
          'at most three',
          'lessons/crypto/',
          'index',
        ]) requires(content, fragment, file);
        const memoryIndex = content.includes('proof_engineering_memory')
          ? content.indexOf('proof_engineering_memory')
          : content.indexOf('Step 1a: Load the Crypto Proof-Engineering Overlay');
        const promptIndex = content.indexOf('<proof_engineering_context>');
        assert.ok(memoryIndex >= 0 && promptIndex > memoryIndex,
          `${file} must retrieve memory before dispatch`);
      }
    }
  });

  it('keeps independent crypto review memory-blind', () => {
    for (const file of [
      'commands/fvs/crypto-review.md',
      'fv-skills/workflows/crypto-review.md',
    ]) {
      const content = read(file);
      requires(content, 'memory-blind', file);
      requires(content, 'proof-engineering-context.md', file);
      forbids(content, '<proof_engineering_context>', file);
      forbids(content, 'PROOF_ENGINEERING_CONTEXT', file);
    }

    const script = read('scripts/fvs-codex-think.mjs');
    const review = between(script, 'const reviewPrompt = [', 'const tempDir =', 'review prompt');
    requires(review, 'proof-engineering-memory-blind', 'review prompt');
    requires(review, 'Do not read or use', 'review prompt');
    forbids(review, '<proof_engineering_context>', 'review prompt');

    const authoring = between(script, 'const basePrompt = [', '// codex exec:', 'authoring prompt');
    requires(authoring, 'sources/proof-engineering-context.md', 'authoring prompt');
    requires(authoring, 'UNTRUSTED', 'authoring prompt');
    requires(authoring, '## Lesson Candidates', 'authoring prompt');
    requires(authoring, 'at most three', 'authoring prompt');
    requires(authoring, 'do not edit', 'authoring prompt');
  });

  it('documents the indexed FC and crypto learning loop', () => {
    for (const file of ['commands/fvs/help.md', 'README.md']) {
      const content = read(file);
      for (const fragment of [
        '.formalising/proof-engineering/',
        'index.md',
        'lessons/',
        'fc/',
        'crypto/',
        'shared/',
        'at most eight',
        'at most three',
        'memory-blind',
      ]) requires(content, fragment, file);
    }
  });

  it('removes the obsolete monolithic proof-note protocol', () => {
    assert.ok(
      !fs.existsSync(path.join(ROOT, 'fv-skills/templates/proof-notes.md')),
      'obsolete proof-notes template must be removed',
    );

    const staleTokens = [
      'fv-skills/templates/proof-notes.md',
      '<proof_notes>',
      '<reusable_insights>',
      'PROOF_NOTES_CONTENT',
    ];
    const roots = ['commands/fvs', 'fv-skills/workflows', 'fv-skills/references', 'README.md'];
    for (const root of roots) {
      const absolute = path.join(ROOT, root);
      const files = fs.statSync(absolute).isDirectory()
        ? fs.readdirSync(absolute).filter(name => name.endsWith('.md')).map(name => path.join(absolute, name))
        : [absolute];
      for (const file of files) {
        const content = fs.readFileSync(file, 'utf8');
        for (const token of staleTokens) forbids(content, token, path.relative(ROOT, file));
      }
    }
  });
});
