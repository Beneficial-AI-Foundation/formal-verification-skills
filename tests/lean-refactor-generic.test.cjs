'use strict';

// Instruction-contract checks: lean-refactor accepts ordinary Lean files, keeps Aeneas guidance
// conditional, and keeps its compiled-proof and statement-preservation safety rules.
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const flat = file => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\s+/g, ' ');
const SOURCES = ['commands/fvs/lean-refactor.md', 'fv-skills/workflows/lean-refactor.md'];

it('targets any compiling Lean file and routes broken or unfinished files to lean-verify', () => {
  for (const file of SOURCES) {
    const text = flat(file);
    assert.match(text, /The target is any Lean file whose proofs already compile: an FVS spec or an ordinary Lean project file/);
    assert.match(text, /If the file has `sorry` or does not build, stop and route it to `\/fvs:lean-verify`; never promise to refactor a broken file/);
  }
});

it('keeps statements, signatures, attributes, definitions and axiom policy unchanged', () => {
  for (const file of SOURCES) {
    assert.match(flat(file), /Keep every theorem, lemma and definition statement, signature and attribute, the meaning of definitions, and the axiom and `sorry` policy unchanged; a needed statement change is reported, not applied/);
  }
  const agent = flat('agents/fvs-lean-refactorer.md');
  assert.match(agent, /NEVER change theorem, lemma or definition statements, signatures or attributes/);
  assert.match(agent, /never add an axiom or `sorry`/);
});

it('makes Aeneas conventions conditional instead of mandatory', () => {
  for (const file of SOURCES) {
    const text = flat(file);
    assert.match(text, /Aeneas conventions \(`Funs\.lean`, `Specs\/`, `@\[step\]`, `unfold \+ step`\) apply only when the project uses Aeneas extraction/);
    assert.match(text, /2\. In an Aeneas project, read the corresponding function body from Funs\.lean for structural context; otherwise use the file's own definitions and imports/);
    assert.doesNotMatch(text, /2\. Read the corresponding function body from Funs\.lean/);
    assert.doesNotMatch(text, /find Specs\/ -name/);
  }
  assert.match(flat('agents/fvs-lean-refactorer.md'), /In Aeneas specs, NEVER touch the `unfold \+ step` structural backbone/);
  const reference = flat('fv-skills/references/lean-refactoring.md');
  assert.match(reference, /FVS specifications and ordinary Lean files alike/);
  assert.match(reference, /## Aeneas-Specific Policy Applies only when the project uses Aeneas extraction/);
});

it('keeps new helpers local by default', () => {
  for (const file of SOURCES) {
    assert.match(flat(file), /a `have` or local lemma for one proof, a `private` lemma for reuse inside the file, and a public declaration only with the user's approval/);
  }
});

it('keeps the existing positional argument and flags', () => {
  assert.match(flat('commands/fvs/lean-refactor.md'), /argument-hint: "<lean_file_path> \[--theorem name\] \[--mode safe\|balanced\|aggressive\] \[--max-passes N\] \[--report-only\]"/);
});
