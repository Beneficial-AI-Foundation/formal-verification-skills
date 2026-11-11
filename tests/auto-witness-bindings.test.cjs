// No Lean, Lake, probes or provider execution. These are derived inert adapter cases.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fixture, sha } = require('./helpers/witness-binding-fixture.cjs');
const SCRIPT = path.resolve(__dirname, '../scripts/fvs-lean-graph.mjs');
const read = r => JSON.parse(fs.readFileSync(r.file));
const codes = r => r.blockers.map(b => b.code);

test('state-free external binding agrees across public API, CLI and actual checker reconstruction', async t => {
  const x = await fixture(t); const extraction = x.assemble(), record = read(extraction.graph);
  assert.equal(record.state, 'complete', JSON.stringify(record.blockers));
  assert.equal(record.binding.status, 'bound');
  assert.deepEqual(record.binding.input, { mode: 'external-recorded-attempt', sha256: sha(x.stateText) });
  assert.equal(fs.existsSync(x.statePath), false);
  const a = extraction.lean;
  const argv = [a.extract.file, '--library', a.libraries.join(','), '--project-root', x.root,
    '--log', a.log.file, '--receipt', a.receipt.file, '--manifest', a.manifest.file,
    '--constants', a.constants.file, '--constants-receipt', a.constantsRun.file,
    '--imports', a.imports.file, '--extraction-state', extraction.rust.state.file];
  const p = spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(p.status, 0, p.stderr); assert.deepEqual(JSON.parse(p.stdout), record);
  const { extractionContext } = await import('../scripts/fvs-checker-auto.mjs');
  const result = extractionContext(extraction);
  assert.equal(result.graph.json.binding.status, 'bound'); assert.equal(result.plan.json.status, 'ready');
});

test('legacy live-state mode remains unmarked and reproduces through the checker', async t => {
  const x = await fixture(t, { live: true }), extraction = x.assemble();
  assert.equal(read(extraction.graph).state, 'complete');
  assert.equal(Object.hasOwn(read(extraction.graph).binding, 'input'), false);
  const { extractionContext } = await import('../scripts/fvs-checker-auto.mjs');
  assert.equal(extractionContext(extraction).plan.json.status, 'ready');
});

test('external state validates rather than replacing or overriding live extraction facts', async t => {
  const cases = [
    ['malformed', '{'], ['duplicate key', '{"schema":"x","schema":"y"}'],
    ['bad schema', JSON.stringify({ schema: 'not-state' })],
    ['non-text API input', false],
  ];
  for (const [name, external] of cases) await t.test(name, async tt => {
    const x = await fixture(tt); x.data.extractionStateText = external;
    const record = x.graphAPI.buildLeanGraph(x.data);
    assert.notEqual(record.state, 'complete'); assert.equal(record.binding.status, 'unbound');
    assert.ok(codes(record).includes('malformed-state'), JSON.stringify(record.blockers));
    assert.equal(fs.existsSync(x.statePath), false);
  });
  await t.test('publication bytes disagree', async tt => {
    const x = await fixture(tt), s = JSON.parse(x.stateText);
    s.extraction.run.publication[0].sha256 = '0'.repeat(64); x.data.extractionStateText = JSON.stringify(s);
    assert.ok(codes(x.graphAPI.buildLeanGraph(x.data)).includes('generated-lean-differs-from-attempt'));
  });
  await t.test('live/external disagreement refuses even if new receipts pin live bytes', async tt => {
    const x = await fixture(tt, { live: true }); x.data.extractionStateText = x.stateText;
    const s = JSON.parse(x.stateText); s.extraction.run.attemptSha256 = '0'.repeat(64);
    fs.writeFileSync(x.statePath, JSON.stringify(s));
    x.receipt.inputs.files = x.graphAPI.projectInputs(x.root); x.constants.inputs.files = x.receipt.inputs.files;
    x.data.constantsText = JSON.stringify(x.constants); x.sign();
    assert.ok(codes(x.graphAPI.buildLeanGraph(x.data)).includes('extraction-state-conflict'));
  });
});

test('external extraction facts do not adopt unrelated live runtime choices', async t => {
  const x = await fixture(t, { live: true }); x.data.extractionStateText = x.stateText;
  const state = JSON.parse(x.stateText); state.choices.limits.workers = 1;
  fs.writeFileSync(x.statePath, JSON.stringify(state));
  x.receipt.inputs.files = x.graphAPI.projectInputs(x.root); x.constants.inputs.files = x.receipt.inputs.files;
  x.data.constantsText = JSON.stringify(x.constants); x.sign();
  const record = x.graphAPI.buildLeanGraph(x.data);
  assert.equal(record.state, 'complete', JSON.stringify(record.blockers)); assert.equal(record.binding.status, 'bound');
  assert.equal(JSON.parse(fs.readFileSync(x.statePath)).choices.limits.workers, 1);
});

test('CLI refuses ambiguous, missing or lossy external bytes before graph work', async t => {
  for (const kind of ['duplicate flag', 'missing file', 'invalid UTF-8']) await t.test(kind, async tt => {
    const x = await fixture(tt), file = path.join(x.evidence, 'external-state.json');
    fs.writeFileSync(file, kind === 'invalid UTF-8' ? Buffer.from([0xff]) : x.stateText);
    const argv = [SCRIPT, path.join(x.evidence, 'unused.json'), '--library', 'M1demo', '--extraction-state', kind === 'missing file' ? file + '-absent' : file];
    // parseArgs precedes input reads; supply a valid extract for the other two byte checks.
    fs.writeFileSync(path.join(x.evidence, 'unused.json'), x.data.extractText);
    if (kind === 'duplicate flag') argv.push('--extraction-state', file);
    const p = spawnSync(process.execPath, argv, { encoding: 'utf8' });
    assert.equal(p.status, 2); assert.match(p.stderr, kind === 'duplicate flag' ? /only once/ : kind === 'invalid UTF-8' ? /exact UTF-8/ : /ENOENT/);
    assert.equal(fs.existsSync(x.statePath), false);
  });
});

test('checker refuses missing, changed, unknown or coordinated tampered external binding', async t => {
  const { extractionContext } = await import('../scripts/fvs-checker-auto.mjs');
  for (const name of ['missing', 'changed bytes', 'coordinated state ref', 'missing marker', 'wrong marker digest', 'unknown mode', 'extra marker field', 'coordinated graph']) await t.test(name, async tt => {
    const x = await fixture(tt), extraction = x.assemble(r => {
      if (name === 'missing marker') delete r.binding.input;
      if (name === 'wrong marker digest') r.binding.input.sha256 = '0'.repeat(64);
      if (name === 'unknown mode') r.binding.input.mode = 'trust-user';
      if (name === 'extra marker field') r.binding.input.override = true;
      if (name === 'coordinated graph') r.timestamp = 'coordinated inert tamper';
    });
    if (name === 'missing') delete extraction.rust.state;
    if (name === 'changed bytes' || name === 'coordinated state ref') fs.appendFileSync(extraction.rust.state.file, ' ');
    if (name === 'coordinated state ref') extraction.rust.state.sha256 = sha(fs.readFileSync(extraction.rust.state.file));
    assert.throws(() => extractionContext(extraction), e => ['stale-input', 'invalid-input'].includes(e.code));
  });
});

test('truthful capped oracle and cache-controlled build receipts reproduce through actual checker', async t => {
  const x = await fixture(t, { capped: true });
  const graph = x.graphAPI.buildLeanGraph(x.data); assert.equal(graph.state, 'complete', JSON.stringify(graph.blockers));
  const extraction = x.assemble();
  const { extractionContext } = await import('../scripts/fvs-checker-auto.mjs');
  assert.equal(extractionContext(extraction).plan.json.status, 'ready');
});

test('finite capped receipt validation refuses wrong program/tool/cwd/flags/scope and changed outputs', async t => {
  const edits = {
    'wrong extractor': x => fs.writeFileSync(x.run.argv[4], '-- changed inert extractor'),
    'missing extractor': x => fs.unlinkSync(x.run.argv[4]),
    'wrong Lake': x => fs.writeFileSync(x.run.argv[0], 'changed inert Lake'),
    'wrong cwd': x => { x.run.cwd = x.evidence; },
    'malformed oracle argv': x => { x.run.argv = [{ toString: null }, 'env', 'lean', '--threads=2', 'x.lean']; },
    'extractor is a directory': x => { x.run.argv[4] = x.evidence + '/Other.lean'; fs.mkdirSync(x.run.argv[4]); },
    'unknown oracle flag': x => { x.run.argv[3] = '--unknown'; },
    'zero threads': x => { x.run.argv[3] = '--threads=0'; },
    'three threads': x => { x.run.argv[3] = '--threads=3'; },
    'duplicate thread flag': x => { x.run.argv.splice(4, 0, '--threads=2'); },
    'missing file argument': x => { x.run.argv.pop(); },
    'extra oracle argument': x => { x.run.argv.push('Other.lean'); },
    'wrong build tool': x => { x.receipt.lakeBuild.argv[0] = process.execPath; },
    'extra root': x => { x.receipt.lakeBuild.argv.push('Other'); },
    'missing root': x => { x.receipt.lakeBuild.argv.pop(); },
    'cache flag conflict': x => { x.receipt.lakeBuild.argv[1] = '--try-cache'; },
    'reordered cache flags': x => { [x.receipt.lakeBuild.argv[1], x.receipt.lakeBuild.argv[2]] = [x.receipt.lakeBuild.argv[2], x.receipt.lakeBuild.argv[1]]; },
    'duplicated cache flag': x => { x.receipt.lakeBuild.argv.splice(1, 0, '--no-cache'); },
    'malformed build argv': x => { x.receipt.lakeBuild.argv = null; },
    'wrong output hash': x => { x.run.outputSha256 = '0'.repeat(64); },
    'changed import identity': x => { x.run.inventoryAfter = '0'.repeat(64); },
  };
  for (const [name, edit] of Object.entries(edits)) await t.test(name, async tt => {
    const x = await fixture(tt, { capped: true }); edit(x); // Keep the actual edited argv in the receipt.
    x.data.constantsRunText = JSON.stringify(x.run); x.data.receiptText = JSON.stringify(x.receipt);
    const r = x.graphAPI.buildLeanGraph(x.data);
    assert.notEqual(r.state, 'complete', name);
    assert.ok(codes(r).some(c => ['constants-run-invalid', 'scope-not-requested', 'invalid-receipt'].includes(c)), JSON.stringify(r.blockers));
  });
});
