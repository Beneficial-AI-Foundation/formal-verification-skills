'use strict';

// Structural gate: the reversible source-record contract (EXTR-04).
//
// When the extraction repair loop edits source to get past a blocker, the change
// must be RECORDED so it is reversible and auditable:
//   - src-modifications.diff -- the machine-reversible patch (regenerated vs pin)
//   - src-modifications.json -- the diff DERIVED 1:1 into per-hunk M-entries
//   - src-assumptions.md     -- the trust assumptions the change introduces
// plus the two policy invariants:
//   - annotations are preferred over source edits
//   - generated Lean (Types.lean / Funs.lean) is NEVER written
//
// This gate asserts the contract tokens are present in the extraction command +
// workflow bodies so a future edit that drops the reversible-record discipline
// fails the suite instead of silently regressing EXTR-04.
//
// Token-PRESENCE assertions do not self-match (a present-token check cannot be
// disabled by the token appearing in this file), so no runtime token assembly is
// needed here. tests/ is not walked.
//
// Pure node:test + node:assert/strict, zero npm dependencies.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const COMMAND = path.join(ROOT, 'commands', 'fvs', 'aeneas-extract.md');
const WORKFLOW = path.join(ROOT, 'fv-skills', 'workflows', 'aeneas-extract.md');

describe('Reversible records: src-modification artifacts present (EXTR-04)', () => {
  const commandText = fs.readFileSync(COMMAND, 'utf8');
  const workflowText = fs.readFileSync(WORKFLOW, 'utf8');

  function present(text, re) {
    return re.test(text);
  }

  it('the workflow records src-modifications.diff and src-modifications.json', () => {
    assert.ok(
      present(workflowText, /src-modifications\.diff/) &&
      present(workflowText, /src-modifications\.json/),
      'workflow missing the reversible-record artifact tokens ' +
      '(src-modifications.diff / src-modifications.json)'
    );
  });

  it('the workflow records src-assumptions.md', () => {
    assert.ok(
      present(workflowText, /src-assumptions\.md/),
      'workflow missing src-assumptions.md'
    );
  });

  it('the command references src-modifications and src-assumptions', () => {
    assert.ok(
      present(commandText, /src-modifications/) &&
      present(commandText, /src-assumptions/),
      'command missing the reversible-record artifact references'
    );
  });

  it('the workflow carries the annotations-over-edits contract', () => {
    assert.ok(
      present(workflowText, /annotations? (are )?preferred/i),
      'workflow missing the annotations-over-edits contract phrase'
    );
  });

  it('the workflow carries the generated-files-never-written contract', () => {
    assert.ok(
      present(workflowText, /generated .*never|never .*generated/i),
      'workflow missing the generated-files-never-written contract phrase'
    );
  });
});
