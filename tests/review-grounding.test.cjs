const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('grounding binds verbatim dependency signatures and negative search results to their sources', async () => {
  const { prepareGrounding, validateGrounding } = await import('../scripts/fvs-review-grounding.mjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-grounding-')));
  try {
    const source = '.lake/packages/mathlib/Mathlib/Example.lean';
    fs.mkdirSync(path.dirname(path.join(root, source)), { recursive: true });
    fs.writeFileSync(path.join(root, source), 'theorem existing_helper : True :=\n  by trivial\n');
    const directory = path.join(root, 'packet');
    fs.mkdirSync(directory);
    const declaration = { name: 'helper', signature: 'theorem helper : True',
      analogs: [{ path: source, start: 1, end: 1, handling: 'REUSE-AS-IS' }],
      search: { queries: ['rg existing_helper Mathlib'], roots: ['.lake/packages/mathlib'], conclusion: 'One candidate.' } };
    const request = { version: 1, declarations: [declaration, { ...declaration, name: 'other', analogs: [],
      search: { ...declaration.search, conclusion: 'No analog in this bounded search.' } }],
      cited_apis: [{ path: source, start: 1, end: 1 }] };
    const inventory = path.join(root, 'inventory.json');
    fs.writeFileSync(inventory, JSON.stringify(request));
    const { content, ...record } = prepareGrounding({ root, directory, requestPath: inventory, sourceFiles: [source] });
    const evidence = JSON.parse(content);
    assert.equal(evidence.declarations[0].analogs[0].signature, 'theorem existing_helper : True :=');
    assert.equal(evidence.declarations[1].result, 'no-analog-found-in-reported-search');
    assert.match(evidence.provenance, /untrusted/);
    validateGrounding(root, record, directory);
    fs.appendFileSync(path.join(root, source), '-- changed dependency\n');
    assert.throws(() => validateGrounding(root, record, directory), /Stale grounding/);
    assert.throws(() => validateGrounding(root, { ...record, path: '../escape' }, directory), /must belong/);
    fs.writeFileSync(inventory, JSON.stringify({ ...request, declarations: [declaration, declaration] }));
    assert.throws(() => prepareGrounding({ root, directory, requestPath: inventory }), /unique name/);
    fs.writeFileSync(inventory, JSON.stringify({ ...request, cited_apis: [{ path: source, start: 1, end: 100 }] }));
    assert.throws(() => prepareGrounding({ root, directory, requestPath: inventory }), /at most 40/);
    fs.writeFileSync(inventory, JSON.stringify({ version: 1, declarations: [], cited_apis: [] }));
    assert.throws(() => prepareGrounding({ root, directory, requestPath: inventory }), /EEXIST/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('review schema rejects malformed findings and format repair preserves substantive text', async () => {
  const { validateReviewResponse, normalizeReviewResponse } = await import('../scripts/fvs-spec-review.mjs');
  const options = { verdicts: ['PASS', 'APPROVE-WITH-EDITS', 'REVISE', 'BLOCKED'],
    headings: ['Findings', 'Content coverage statement', 'Coverage', 'Evidence'] };
  const finding = '### F-1 — MAJOR\nClass: CONTENT\nClaim: Duplicate helper.\n' +
    'Evidence: Mathlib/Example.lean:1\nSuggested change: Reuse existing_helper.\n';
  const review = '# FC Specification Review\n\n## Findings\n' + finding +
    '\n## Content coverage statement\nChecked implementation semantics and helper signature.\n' +
    '\n## Coverage\nReturn value and input bounds.\n\n## Evidence\nsource.rs:12\n\nVERDICT: APPROVE-WITH-EDITS';
  assert.equal(validateReviewResponse(review, options), review);
  for (const invalid of [
    review.replace('Class: CONTENT\n', ''), review.replace('Evidence: Mathlib/Example.lean:1', 'Evidence:'),
    review.replace(finding, finding + finding), review.replace('F-1', 'arbitrary'),
    review.replace('— MAJOR', '— MAJOR | MINOR'), review.replace('Class: CONTENT', 'Class: OTHER'),
    review.replace('Reuse existing_helper.', 'x'.repeat(4001)),
    review.replace('Checked implementation semantics and helper signature.', ''),
    review + '\nVERDICT: PASS', review.replace('VERDICT: APPROVE-WITH-EDITS', 'VERDICT: PASS'),
    review.replace('Class: CONTENT', 'Class: CONTENT\nClass: PROCESS'),
    review.replace('## Evidence', '## Findings'),
  ]) assert.throws(() => validateReviewResponse(invalid, options));
  const styled = '```markdown\n' + review.replace('VERDICT: APPROVE-WITH-EDITS', '**VERDICT:** APPROVE-WITH-EDITS') + '\n```';
  assert.equal(normalizeReviewResponse(styled, options.verdicts), review);
  const missing = review.replace('Evidence: Mathlib/Example.lean:1', 'Evidence:');
  assert.throws(() => validateReviewResponse(normalizeReviewResponse(missing, options.verdicts), options));
  const empty = review.replace(finding, '').replace('APPROVE-WITH-EDITS', 'PASS');
  validateReviewResponse(empty, options);
  const code = review.replace('Evidence: Mathlib/Example.lean:1',
    'Evidence: Mathlib/Example.lean:1\n```text\n## Trace\nClass: a literal in diagnostic output\nVERDICT: PASS\n```');
  assert.equal(validateReviewResponse(code, options), code);
});
