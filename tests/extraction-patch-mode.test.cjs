'use strict';

// Structural gates for translation-patch mode in the shared aeneas-extract
// command and workflow.
//
// The engine (scripts/fvs-extract-patches.mjs) enforces the lifecycle; these
// assertions pin that the workflow actually drives it: mode selection from the
// engine's own verdict, extraction inside the engine's disposable copy, the
// tree and restoration checks, and a success oracle that no longer consults the
// legacy ledger. They are text gates over the shipped prose, like the other
// extraction-loop gates, and read the engine's subcommands from its usage text
// so a renamed subcommand fails here instead of in a user's run.
//
// Pure node:test + node:assert/strict, zero npm dependencies.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const COMMAND = path.join(ROOT, 'commands', 'fvs', 'aeneas-extract.md');
const WORKFLOW = path.join(ROOT, 'fv-skills', 'workflows', 'aeneas-extract.md');
const APPLIER = path.join(ROOT, 'agents', 'fvs-extract-applier.md');
const ENGINE = path.join(ROOT, 'scripts', 'fvs-extract-patches.mjs');

const commandText = fs.readFileSync(COMMAND, 'utf8');
const workflowText = fs.readFileSync(WORKFLOW, 'utf8');

function step(name) {
  const match = workflowText.match(new RegExp(`<step name="${name}">([\\s\\S]*?)</step>`));
  assert.ok(match, `workflow has no <step name="${name}">`);
  return match[1];
}

// The part of a step under a "### <heading>" line, up to the next heading.
function section(text, heading) {
  const start = text.indexOf(`### ${heading}`);
  assert.ok(start >= 0, `missing "### ${heading}"`);
  const rest = text.slice(start + 1);
  const next = rest.search(/^### /m);
  return next < 0 ? rest : rest.slice(0, next);
}

function engineSubcommands() {
  const usage = spawnSync(process.execPath, [ENGINE, '--help'], { encoding: 'utf8' }).stdout;
  return [...usage.matchAll(/node fvs-extract-patches\.mjs (\S+)/g)].map((match) => match[1]);
}

describe('Patch mode: the workflow drives the engine', () => {
  it('only calls engine subcommands the script provides', () => {
    const provided = engineSubcommands();
    for (const name of ['check', 'prepare', 'verify-tree', 'verify-restore']) {
      assert.ok(provided.includes(name), `the engine no longer provides ${name}`);
      assert.match(workflowText, new RegExp(`"\\$PATCH_ENGINE" ${name}\\b`), `workflow never runs ${name}`);
    }
    for (const [, name] of workflowText.matchAll(/"\$PATCH_ENGINE" (\S+)/g)) {
      assert.ok(provided.includes(name), `workflow runs engine subcommand ${name}, which the script lacks`);
    }
  });

  it('the command names the same engine steps', () => {
    assert.match(commandText, /fvs-extract-patches\.mjs/);
    for (const name of ['check', 'prepare', 'verify-tree', 'verify-restore']) {
      assert.match(commandText, new RegExp(`\\b${name}\\b`), `command never mentions ${name}`);
    }
  });

  it('selects the mode from the engine verdict and reads the code field, not the exit status', () => {
    const select = step('select_mode');
    for (const token of ['extraction.mode', 'translation-patches', 'legacy-source-ledger', 'legacy-mode', 'mixed-mode']) {
      assert.ok(select.includes(token), `mode selection never mentions ${token}`);
    }
    assert.match(select, /exit code 4/);
    assert.match(select, /`code` field/);
    assert.match(select, /mixed-mode[^\n]*\n?[^\n]*(stop|halt)/i, 'a mixed state must stop the run');
    assert.match(select, /never migrates|does not migrate/i, 'the workflow must not migrate on its own');
  });

  it('extracts inside the prepared copy: prepare, tree check, Charon, tree check, Aeneas, restore check', () => {
    const extract = step('extract');
    const at = (needle, from = 0) => {
      const index = extract.indexOf(needle, from);
      assert.ok(index >= 0, `extract step has no ${needle} after offset ${from}`);
      return index;
    };
    const prepared = at('"$PATCH_ENGINE" prepare');
    const treeBefore = at('"$PATCH_ENGINE" verify-tree', prepared);
    const charon = at('--dest-file', treeBefore);
    const treeAfter = at('"$PATCH_ENGINE" verify-tree', charon);
    const aeneas = at('Aeneas', treeAfter);
    const restore = at('"$PATCH_ENGINE" verify-restore', aeneas);
    assert.ok(prepared < treeBefore && treeBefore < charon && charon < treeAfter && treeAfter < aeneas && aeneas < restore);
    assert.match(extract, /"\$OUT\/tree"/, 'Charon must run with the copy as its working directory');
  });

  it('treats an engine refusal as a stop, never as a classifier input or an in-place repair', () => {
    const extract = step('extract');
    assert.match(extract, /refus/i);
    assert.match(extract, /never (classif|repair)|not (classified|repaired)/i);
  });
});

describe('Patch mode: records and the success oracle', () => {
  it('documents changes as patches and never writes the legacy ledger in patch mode', () => {
    const document = step('document');
    for (const token of ['translation-patches/', 'series', 'Classification:', 'Obligations:', 'src-assumptions.md']) {
      assert.ok(document.includes(token), `patch-mode records never mention ${token}`);
    }
    assert.match(document, /[Pp]atch mode never writes `src-modifications\.diff`/);
  });

  it('replaces the legacy oracle clause with the tree check, the restore check, tokens and patch identities', () => {
    const oracle = step('success_oracle');
    const patchMode = section(oracle, 'Patch mode');
    for (const token of ['verify-tree', 'verify-restore', 'equivalence-ratified:', 'sha256', 'PIPESTATUS']) {
      assert.ok(patchMode.includes(token), `patch-mode oracle never requires ${token}`);
    }
    assert.match(patchMode, /diff-to-record check holds over patch identities/);
    assert.match(patchMode, /manifest's recorded post-patch state/);
    assert.match(patchMode, /unrecorded/i, 'an unrecorded repair in the copy must fail the run');
    assert.doesNotMatch(patchMode, /src-modifications\.diff/, 'the patch-mode oracle must not consult the legacy diff');
  });

  it('keeps the legacy oracle for legacy projects', () => {
    const legacy = section(step('success_oracle'), 'Legacy mode');
    assert.match(legacy, /equivalence-ratified:/);
    assert.match(legacy, /src-modifications\.diff/);
    assert.match(legacy, /src-modifications\.json/);
  });

  it('names the inactive state and never reads legacy evidence as patch evidence', () => {
    for (const text of [step('success_oracle'), step('select_mode')]) {
      assert.match(text, /inactive/);
    }
    const oracle = step('success_oracle');
    assert.match(oracle, /src-modifications\.inactive\.json/);
    assert.match(oracle, /never (read|reinterpret|treat)[^.]*patch evidence/i);
  });

  it('reports extraction, restored source, evidence and remaining obligations separately', () => {
    const summary = step('run_end_summary');
    for (const label of ['Extraction:', 'Restored source:', 'Evidence:', 'Obligations remaining:']) {
      assert.ok(summary.includes(label), `run-end summary has no ${label} line`);
    }
    assert.doesNotMatch(summary, /carried over/, 'a legacy approval is history, not evidence');
  });

  it('binds every Category-B ratification to the patch hash, migrated patches included', () => {
    const patchMode = section(step('success_oracle'), 'Patch mode');
    for (const token of ['patch-file:', 'patch-sha256:', 'historical', 'migrated', 'ratification-check']) {
      assert.ok(patchMode.includes(token), `patch-mode oracle never mentions ${token}`);
    }
    assert.match(patchMode, /new gate/i, 'a migrated B patch must go through the gate again');
    assert.doesNotMatch(patchMode, /carried over/);
    assert.match(step('gate'), /patch-file:/);
    assert.match(step('gate'), /migrated/i);
  });

  it('states that a translation adaptation does not prove equivalence with the original source', () => {
    assert.match(workflowText, /does not prove (equivalence|the original)/i);
  });
});

describe('Patch mode: the applier agent', () => {
  const applier = fs.readFileSync(APPLIER, 'utf8');
  const legacy = section(applier, 'Legacy mode');
  const rest = applier.replace(legacy, '');

  it('appends to the ledger in legacy mode only', () => {
    assert.match(legacy, /src-modifications\.md/);
    for (const line of rest.split('\n').filter((entry) => /src-modifications/.test(entry))) {
      assert.match(line, /never|no `?src-modifications|writes no/i, `a ledger write outside legacy mode: ${line.trim()}`);
    }
  });

  it('forbids every ledger write in patch mode, including non-Rust repairs', () => {
    const patchMode = section(applier, 'Patch mode');
    assert.match(patchMode, /never writes? any `src-modifications\.\*` file/i);
    for (const recipe of ['namespace-cascade', 'refresh-manifest']) {
      assert.ok(patchMode.includes(recipe), `patch mode never covers ${recipe}`);
    }
    assert.match(patchMode, /src-assumptions\.md/);
  });

  it('keeps the success criterion consistent with both modes', () => {
    assert.match(applier, /- \[ \] Records written for the dispatch mode[^\n]*never[^\n]*src-modifications/i);
  });
});
