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

test('grounding budget charges every span occurrence and names the first overflow', async () => {
  const { analyzeGrounding, prepareGrounding } = await import('../scripts/fvs-review-grounding.mjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-grounding-budget-')));
  try {
    fs.writeFileSync(path.join(root, 'Api.lean'),
      Array.from({ length: 41 }, (_, i) => `-- line ${i + 1}`).join('\n') + '\n');
    const span = (start = 1, end = 10) => ({ path: './Api.lean', start, end });
    const decls = count => Array.from({ length: count }, (_, i) => ({
      name: `D${i}`, signature: 'True', analogs: [{ ...span(), handling: 'REUSE-AS-IS' }],
      search: { queries: ['Api.lean'], roots: ['.'], conclusion: 'fixture' } }));
    const inventory = path.join(root, 'inventory.json');
    const write = (declarations, cited_apis = []) => fs.writeFileSync(inventory,
      JSON.stringify({ version: 1, declarations, cited_apis, limitations: 'fixture' }));
    const tree = () => fs.readdirSync(root, { recursive: true }).sort();
    const before = tree();

    write(decls(21));
    let analysis = analyzeGrounding({ root, requestPath: 'inventory.json' });
    assert.deepEqual({ ...analysis.budget, overflow: undefined }, { limit: 200, charged: 210,
      analogs: 210, citedApis: 0, distinctSpans: 1, distinctLines: 10, overflow: undefined });
    assert.deepEqual(analysis.budget.overflow, { location: 'declarations[20] "D20" analogs[0]',
      span: 'Api.lean:1-10', cumulative: 210 });
    assert.equal(analysis.content, null);
    assert.match(analysis.error, /charged 210\/200.*analogs 210, cited_apis 0.*declarations\[20\] "D20" analogs\[0\] Api\.lean:1-10 \(cumulative 210\)/);
    assert.match(analysis.error, /1 distinct span \(10 lines\)/);
    const directory = path.join(root, 'packet');
    fs.mkdirSync(directory);
    assert.throws(() => prepareGrounding({ root, directory, requestPath: 'inventory.json' }),
      error => error.message === analysis.error);
    assert.ok(!fs.existsSync(path.join(directory, 'grounding.json')));
    fs.rmdirSync(directory);

    write(decls(20), [span(), span(), span(1, 1)]);
    analysis = analyzeGrounding({ root, requestPath: 'inventory.json' });
    assert.equal(analysis.budget.charged, 221);
    assert.equal(analysis.budget.analogs, 200);
    assert.equal(analysis.budget.citedApis, 21);
    assert.equal(analysis.budget.distinctSpans, 2);
    assert.deepEqual(analysis.budget.overflow, { location: 'cited_apis[0]', span: 'Api.lean:1-10', cumulative: 210 });

    write(decls(20));
    analysis = analyzeGrounding({ root, requestPath: 'inventory.json' });
    assert.equal(analysis.error, null);
    assert.match(analysis.report, /^charged 200\/200 signature lines \(analogs 200, cited_apis 0\)/);
    assert.equal(JSON.parse(analysis.content).declarations[19].analogs[0].path, 'Api.lean');
    write(decls(20), [span(1, 1)]);
    assert.deepEqual(analyzeGrounding({ root, requestPath: 'inventory.json' }).budget.overflow,
      { location: 'cited_apis[0]', span: 'Api.lean:1-1', cumulative: 201 });

    write([], [span(1, 40)]);
    assert.equal(analyzeGrounding({ root, requestPath: 'inventory.json' }).budget.charged, 40);
    write([], [span(1, 41)]);
    assert.throws(() => analyzeGrounding({ root, requestPath: 'inventory.json' }), /at most 40/);
    write(decls(21), [span(1, 41)]);
    assert.throws(() => analyzeGrounding({ root, requestPath: 'inventory.json' }), /at most 40/,
      'spans after the first overflow are still validated');

    const missing = analyzeGrounding({ root });
    assert.equal(missing.error, null);
    assert.equal(JSON.parse(missing.content).status, 'missing-scout-inventory');
    assert.match(missing.report, /missing-scout-inventory/);
    assert.deepEqual(tree(), [...before, 'inventory.json'].sort(), 'analysis never writes');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('grounding artifact keeps the 64000 code-unit ceiling and reports the budget', async () => {
  const { analyzeGrounding, prepareGrounding } = await import('../scripts/fvs-review-grounding.mjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-grounding-size-')));
  try {
    const inventory = path.join(root, 'inventory.json');
    fs.writeFileSync(inventory, JSON.stringify({ version: 1, declarations: [],
      cited_apis: [{ path: 'Wide.lean', start: 1, end: 1 }] }));
    const check = line => {
      fs.writeFileSync(path.join(root, 'Wide.lean'), line + '\n');
      return analyzeGrounding({ root, requestPath: 'inventory.json' });
    };
    assert.equal(check('a'.repeat(40000)).error, null);
    assert.equal(check('∀'.repeat(40000)).error, null, 'Lean Unicode is measured in code units, not bytes');
    const oversized = check('a'.repeat(64001));
    assert.match(oversized.error, /exceeds 64 KiB \(\d+ JavaScript code units > 64000\); charged 1\/200/);
    assert.ok(oversized.content === null);
    const directory = path.join(root, 'packet');
    fs.mkdirSync(directory);
    assert.throws(() => prepareGrounding({ root, directory, requestPath: 'inventory.json' }),
      /JavaScript code units > 64000/);
    assert.deepEqual(fs.readdirSync(directory), []);
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
  validateReviewResponse(empty.replace('VERDICT: PASS', 'VERDICT: BLOCKED'), options);
  for (const verdict of ['REVISE', 'APPROVE-WITH-EDITS']) {
    assert.throws(() => validateReviewResponse(
      empty.replace('VERDICT: PASS', `VERDICT: ${verdict}`), options), /requires at least one finding/);
  }
  const observation = review.replace('— MAJOR', '— OBSERVATION');
  assert.throws(() => validateReviewResponse(observation, options), /OBSERVATION/);
  const code = review.replace('Evidence: Mathlib/Example.lean:1',
    'Evidence: Mathlib/Example.lean:1\n```text\n## Trace\nClass: a literal in diagnostic output\nVERDICT: PASS\n```');
  assert.equal(validateReviewResponse(code, options), code);
});

test('review recovery records lossless originals and rejects ambiguous wrappers', async () => {
  const { recordValidatedResponse } = await import('../scripts/fvs-spec-review.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-recovery-'));
  const options = { verdicts: ['PASS', 'REVISE'], headings: ['Findings', 'Content coverage statement', 'Coverage', 'Evidence'] };
  const review = '# FC Specification Review\n\n## Findings\nNone.\n\n## Content coverage statement\nChecked.\n\n## Coverage\nChecked.\n\n## Evidence\nsource:1\n\nVERDICT: PASS';
  try {
    const direct = review + '\n';
    assert.equal(recordValidatedResponse(root, direct, options), direct);
    const identity = path.join(root, fs.readdirSync(root)[0]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(identity, 'transformation.json'))).operations, []);
    assert.equal(JSON.parse(fs.readFileSync(path.join(identity, 'transformation.json'))).replay_matches, true);
    const wrapped = 'Review complete.\n' + review;
    assert.equal(recordValidatedResponse(root, wrapped, options), review);
    const record = path.join(root, fs.readdirSync(root).find(name => name !== path.basename(identity)));
    assert.equal(fs.readFileSync(path.join(record, 'raw-response.md'), 'utf8'), wrapped);
    assert.equal(fs.readFileSync(path.join(record, 'normalized-response.md'), 'utf8'), review);
    const receipt = JSON.parse(fs.readFileSync(path.join(record, 'transformation.json')));
    assert.equal(receipt.operations[0].removed, 'Review complete.\n');
    for (const [file, text] of [['raw-response.md', wrapped], ['normalized-response.md', review]]) {
      assert.equal(receipt.hashes[file], require('node:crypto').createHash('sha256').update(text).digest('hex'));
    }
    for (const allowed of ['Review complete.\n\n' + review,
      'All evidence is gathered; writing the review.\n\n' + review,
      "I have all the evidence I need; I'm now writing up the review with the hand traces, probe log, and verdict.\n\n" + review,
      '```markdown\n' + review + '\n```\n']) {
      const prior = new Set(fs.readdirSync(root));
      assert.equal(recordValidatedResponse(root, allowed, options), review);
      const item = path.join(root, fs.readdirSync(root).find(name => !prior.has(name)));
      assert.equal(JSON.parse(fs.readFileSync(path.join(item, 'transformation.json'))).replay_matches, true);
    }
    for (const input of [review + '\n' + review, 'Review complete.\n' + review + '\nVERDICT: REVISE',
      '## Findings\nNone.\n' + review, 'First.\nSecond.\n' + review,
      'Review complete.\n```markdown\n' + review + '\n```',
      'Done. Writing the review now.\n' + review, 'This passes.\n' + review,
      'Revising is needed.\n' + review, 'A major gap remains.\n' + review,
      'See F-1 first.\n' + review, 'Checked source line one:\n' + review.replace('# FC', '#FC'),
      'Checked src/spec.lean carefully.\n' + review, 'Checked all lines.\n# Other Review\n' + review,
      'Checked `spec` carefully.\n' + review]) {
      const prior = new Set(fs.readdirSync(root));
      assert.throws(() => recordValidatedResponse(root, input, options));
      const last = path.join(root, fs.readdirSync(root).find(name => !prior.has(name)));
      assert.ok(fs.existsSync(path.join(last, 'error.txt')));
      assert.equal(fs.readFileSync(path.join(last, 'raw-response.md'), 'utf8'), input);
      assert.ok(!fs.existsSync(path.join(last, 'normalized-response.md')), 'rejected review has no validated copy');
      assert.equal(JSON.parse(fs.readFileSync(path.join(last, 'transformation.json'))).validated, false);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('crypto review allows observations but rejects adverse empty verdicts', async () => {
  const { validateReviewResponse } = await import('../scripts/fvs-spec-review.mjs');
  const options = { verdicts: ['APPROVE', 'APPROVE-WITH-EDITS', 'REJECT'],
    headings: ['Authority hierarchy', 'Findings', 'Content coverage statement',
      'Cleared surfaces', 'Probe log', 'Resolution map'] };
  const base = '# FVS Crypto Plan Review\n\n## Authority hierarchy\nPaper first.\n\n' +
    '## Findings\nNone.\n\n## Content coverage statement\nChecked semantics.\n\n' +
    '## Cleared surfaces\nChecked reuse.\n\n## Probe log\nNo probes.\n\n' +
    '## Resolution map\nNo findings.\n\nVERDICT: APPROVE';
  validateReviewResponse(base, options);
  for (const verdict of ['REJECT', 'APPROVE-WITH-EDITS']) {
    assert.throws(() => validateReviewResponse(
      base.replace('VERDICT: APPROVE', `VERDICT: ${verdict}`), options), /requires at least one finding/);
  }
  const observed = base.replace('None.', '### F-1 — OBSERVATION\nClass: PROCESS\n' +
    'Claim: A useful note.\nEvidence: plan.md:1\nMinimal suggested edit: Record the note.');
  validateReviewResponse(observed, options);
});

test('review selections stay explicit and thread values follow policy', async () => {
  const { validateReviewerOptions, reviewThreadCount } = await import('../scripts/fvs-spec-review.mjs');
  assert.throws(() => validateReviewerOptions({ runtime: 'codex', effort: 'max' }),
    /explicit model/);
  assert.throws(() => validateReviewerOptions({ runtime: 'codex', model: 'catalog-model' }),
    /explicit effort/);
  assert.throws(() => validateReviewerOptions({ runtime: 'codex', model: 'catalog-model',
    effort: 'runtime-default' }), /explicit effort/);
  for (const effort of ['low', 'max', 'provider-native-effort']) {
    assert.equal(validateReviewerOptions({ runtime: 'codex', model: 'catalog/model', effort }).effort,
      effort);
  }
  assert.equal(validateReviewerOptions({ runtime: 'pi', model: 'openai/catalog-model',
    effort: 'max' }).runtime, 'pi');
  for (const model of ['catalog-model', '/catalog-model', 'openai/']) {
    assert.throws(() => validateReviewerOptions({ runtime: 'pi', model, effort: 'max' }),
      /provider-qualified|explicit model/);
  }
  assert.throws(() => validateReviewerOptions({ runtime: 'codex', model: 'catalog/model',
    effort: 'bad"value' }), /explicit effort/);
  assert.equal(reviewThreadCount(undefined), 4);
  assert.equal(reviewThreadCount('1'), 1);
  assert.equal(reviewThreadCount('4096'), 4096);
  for (const value of ['0', '-1', '1.5', 'eight']) {
    assert.throws(() => reviewThreadCount(value), /positive safe integer/);
  }
  for (const value of ['9007199254740992', '9'.repeat(400)]) {
    assert.throws(() => reviewThreadCount(value), /positive safe integer/);
  }
});
