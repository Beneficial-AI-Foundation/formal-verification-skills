'use strict';

// The migration reference may describe only what the scripts implement. The
// engine's usage text and constants are the authority: every subcommand, flag
// and slash command the shipped extraction documentation names must exist, and
// the preserved fields it lists must be the ones `migrate` writes.
//
// Pure node:test + node:assert/strict, zero npm dependencies.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'scripts', 'fvs-extract-patches.mjs');
const REFERENCE = path.join(ROOT, 'fv-skills', 'references', 'extraction-patch-migration.md');
const DOCS = [
  REFERENCE,
  path.join(ROOT, 'fv-skills', 'workflows', 'aeneas-extract.md'),
  path.join(ROOT, 'commands', 'fvs', 'aeneas-extract.md'),
];

const engineSource = fs.readFileSync(ENGINE, 'utf8');
const usage = spawnSync(process.execPath, [ENGINE, '--help'], { encoding: 'utf8' }).stdout;
const subcommands = [...usage.matchAll(/node fvs-extract-patches\.mjs (\S+)/g)].map((match) => match[1]);
const flags = new Set(usage.match(/--[a-z][a-z-]*/g));

describe('Migration reference: names only what the scripts provide', () => {
  const reference = fs.existsSync(REFERENCE) ? fs.readFileSync(REFERENCE, 'utf8') : '';

  it('exists', () => {
    assert.ok(reference.length > 0, 'fv-skills/references/extraction-patch-migration.md is missing');
  });

  it('describes the shipped migrate subcommand', () => {
    assert.ok(subcommands.includes('migrate'), 'the engine no longer ships migrate');
    assert.match(reference, /fvs-extract-patches\.mjs migrate/);
  });

  for (const file of DOCS) {
    const name = path.relative(ROOT, file);
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

    it(`${name} runs only engine subcommands the script provides`, () => {
      for (const [, command] of text.matchAll(/fvs-extract-patches\.mjs[" ]+([a-z][a-z-]*)/g)) {
        assert.ok(subcommands.includes(command), `${name} names engine subcommand ${command}, which the script lacks`);
      }
    });

    it(`${name} passes only flags the engine accepts`, () => {
      for (const line of text.split('\n').filter((entry) => /fvs-extract-patches\.mjs|PATCH_ENGINE"/.test(entry))) {
        for (const flag of line.match(/--[a-z][a-z-]*/g) ?? []) {
          assert.ok(flags.has(flag) || flag === '--help', `${name} passes ${flag}, which the engine does not accept: ${line.trim()}`);
        }
      }
    });
  }

  it('names only slash commands that ship', () => {
    for (const [, command] of reference.matchAll(/\/fvs:([a-z][a-z-]*)/g)) {
      assert.ok(fs.existsSync(path.join(ROOT, 'commands', 'fvs', `${command}.md`)), `/fvs:${command} does not exist`);
    }
  });

  it('lists exactly the fields migrate carries into each patch header', () => {
    const block = engineSource.match(/const MIGRATED_FIELDS = \[([\s\S]*?)\n\];/)[1];
    const migrated = [...block.matchAll(/\['[a-z]+', '([A-Za-z]+)'\]/g)].map((match) => match[1]);
    assert.deepEqual(migrated, ['Classification', 'Assumptions', 'Obligations', 'Evidence', 'Ratification']);
    for (const label of migrated) {
      assert.ok(reference.includes(`\`${label}:\``), `reference does not list the migrated ${label}: field`);
    }
  });

  it('names the inactive marker the engine writes and the mode key it reads', () => {
    const marker = engineSource.match(/const INACTIVE_MARKER = '([^']+)'/)[1];
    assert.ok(reference.includes(marker), `reference does not name ${marker}`);
    assert.ok(reference.includes('extraction.mode'));
  });

  it('says migration does not re-establish equivalence', () => {
    assert.match(reference, /does not (re-establish|prove)[^.]*equivalen/i);
  });

  it('claims no automation beyond migrate', () => {
    assert.match(reference, /no\s+other\s+migration\s+command/i);
  });
});

describe('CHANGELOG: the patch-mode default is recorded under Unreleased', () => {
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const unreleased = changelog.split(/^## \[/m).find((block) => block.startsWith('Unreleased]')) ?? '';

  it('names the breaking default, unchanged legacy projects, the procedure and the equivalence caveat', () => {
    assert.match(unreleased, /translation patch/i);
    assert.match(unreleased, /breaking/i);
    assert.match(unreleased, /legacy/i);
    assert.match(unreleased, /migrate/i);
    assert.match(unreleased, /extraction-patch-migration\.md/);
    assert.match(unreleased, /does not prove[^.]*equivalen|not (a )?proof[^.]*equivalen/i);
  });
});
