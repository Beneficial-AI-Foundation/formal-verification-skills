// Offline state/route fixtures only: no provider, extraction or proof acceptance.
const { before, after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/fvs-auto.mjs');
const FIXTURES = path.join(__dirname, 'fixtures/auto-profile');
const temps = [];
let auto;
before(async () => { auto = await import(pathToFileURL(SCRIPT).href); });
after(() => { for (const root of temps) fs.rmSync(root, { recursive: true, force: true }); });
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
// Independent fixture encoding; also checks that array order/text are not normalized away.
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted(value[k])]));
  return value;
}
function seal(a) {
  a.approvedPayloadSha256 = digest(JSON.stringify(sorted({ schema: a.schema, schemaVersion: a.schemaVersion, mode: a.mode, payload: a.payload })));
  return a;
}
const choices = { source: { revision: 'HEAD', configuration: 'default features' }, scope: 'the portable module', limits: { wallClockHours: 40 } };
const statePath = (root) => path.join(root, '.formalising/auto-fv/state.json');
const roadmapPath = (root) => path.join(root, '.formalising/auto-fv/ROADMAP.md');
const bytes = (root) => fs.readFileSync(statePath(root));
const state = (root) => JSON.parse(bytes(root));
function stubs(fn) {
  const values = { HOME: path.join(FIXTURES, 'home'), PATH: path.join(FIXTURES, 'bin') + path.delimiter + '/usr/bin:/bin', FVS_TOOLS_HOME: path.join(FIXTURES, 'no-fvs-tools') };
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  Object.assign(process.env, values);
  try { return fn(); } finally { for (const k of Object.keys(values)) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
}
function init(root, selected = choices, confirmOverwrite = false) {
  return stubs(() => auto.initState({ projectRoot: root, choices: selected, platform: 'aarch64-apple-darwin', confirmOverwrite }));
}
function project(initialize = true) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fvs-agreement-'));
  temps.push(root);
  fs.cpSync(path.join(__dirname, 'fixtures/extract-patches/crate'), root, { recursive: true });
  fs.cpSync(path.join(FIXTURES, 'fresh'), root, { recursive: true });
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=fvs', '-c', 'user.email=fvs@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']]) {
    const result = spawnSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  if (initialize) init(root);
  return root;
}
function agreement(root, version = 1) {
  const s = state(root);
  return seal({ schema: 'fvs/auto-agreement', schemaVersion: 1, mode: 'nonpublic-intent',
    payload: { choicesGeneration: s.choicesGeneration ?? 0, choices: s.choices, contextVersion: version,
      boundaries: ['fixture boundary'], conventions: ['fixture convention'], layout: 'single-crate',
      claims: ['fixture functional correctness'], trust: ['fixture axiom policy'], acceptance: ['independent checker'],
      ownerReserved: ['human final PR decision'], execution: null, draftPr: null },
    ownerEvidence: { reference: 'fixture:owner-response:' + version, response: 'Fixture response approving the presented exact payload; no publication grant.' } });
}
function roadmap(root, a) {
  fs.writeFileSync(roadmapPath(root), '# Fixture\n\n## Goal\nFixture only\n\n## Decisions\n```fvs-auto-agreement\n' + JSON.stringify(a, null, 2) + '\n```\n\n## Status log\n');
}
function record(root, a, confirmOverwrite = false) { return auto.recordAgreement({ projectRoot: root, agreement: a, confirmOverwrite }); }
function approved(root = project()) {
  const a = agreement(root); roadmap(root, a); record(root, a); return { root, a };
}
function gate(root) { return auto.readState({ projectRoot: root, requireAgreement: true }); }
function refuses(code, fn) { assert.throws(fn, (e) => e instanceof auto.Refusal && e.code === code); }
function cli(root, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, '--project-root', root], { encoding: 'utf8' });
  return { ...r, json: JSON.parse(r.stdout) };
}

describe('nonpublic initial agreement state', () => {
  it('keeps legacy reads byte-identical and never treats a roadmap offer as approval', () => {
    const root = project(); const before = bytes(root);
    assert.equal(auto.readState({ projectRoot: root }).code, 'ok');
    assert.equal('choicesGeneration' in state(root), false);
    assert.deepEqual(bytes(root), before);
    for (const decision of ['accepted', 'declined']) {
      auto.recordRoadmap({ projectRoot: root, decision, confirmOverwrite: true });
      refuses('agreement-required', () => gate(root));
      assert.match(auto.readState({ projectRoot: root }).nextAction, /auto-extract/);
    }
    const absent = project(false);
    assert.equal(cli(absent, 'read-state', '--require-agreement').status, 1);
  });

  it('records actual content and reuses it through a new CLI process without writing or granting authority', () => {
    const { root, a } = approved(); const before = bytes(root); const mtime = fs.statSync(statePath(root)).mtimeMs;
    assert.equal(auto.agreementPayloadSha256(a), a.approvedPayloadSha256);
    assert.equal(state(root).choicesGeneration, 0);
    assert.equal(gate(root).agreement.status, 'stored-context-current');
    assert.deepEqual(gate(root).pendingDecisions, [], 'the M2 gate does not reopen the legacy roadmap offer');
    assert.deepEqual(auto.readState({ projectRoot: root }).pendingDecisions, ['roadmap'], 'the default M1 view retains its offer semantics');
    assert.match(gate(root).agreement.semanticCheckRequired, /does not authenticate/);
    assert.deepEqual(state(root).agreements[0].payload, a.payload);
    assert.equal(gate(root).agreement.agreement.payload.execution, null);
    assert.equal(gate(root).agreement.agreement.payload.draftPr, null);
    const input = path.join(root, 'input.json'); fs.writeFileSync(input, JSON.stringify(a));
    const replay = cli(root, 'record-agreement', '--input', input);
    assert.equal(replay.status, 0, replay.stderr); assert.equal(replay.json.code, 'unchanged');
    const restarted = cli(root, 'read-state', '--require-agreement');
    assert.equal(restarted.status, 0, restarted.stderr); assert.equal(restarted.json.agreement.status, 'stored-context-current');
    assert.deepEqual(bytes(root), before); assert.equal(fs.statSync(statePath(root)).mtimeMs, mtime);
    init(root); auto.readState({ projectRoot: root });
    assert.deepEqual(bytes(root), before, 'reads and unchanged init do not advance a generation');
  });

  it('records a fresh CLI agreement and refuses changed input without writes after restart', () => {
    const root = project(); const a = agreement(root); roadmap(root, a);
    const file = path.join(root, 'agreement-input.json'); fs.writeFileSync(file, JSON.stringify(a));
    const recorded = cli(root, 'record-agreement', '--input', file);
    assert.equal(recorded.status, 0, recorded.stderr); assert.equal(recorded.json.code, 'recorded');
    const before = bytes(root);
    assert.equal(cli(root, 'read-state', '--require-agreement').json.agreement.status, 'stored-context-current');
    const changed = structuredClone(a); changed.payload.choices.source.configuration = 'other config'; seal(changed); roadmap(root, changed);
    const stale = cli(root, 'read-state', '--require-agreement');
    assert.equal(stale.status, 1); assert.equal(stale.json.code, 'stale-agreement-context');
    fs.writeFileSync(file, JSON.stringify(changed));
    const refused = cli(root, 'record-agreement', '--input', file, '--confirm-overwrite');
    assert.equal(refused.status, 1); assert.equal(refused.json.code, 'stale-agreement');
    assert.deepEqual(bytes(root), before);
  });

  it('persists A0 -> B1 -> A2 invalidation and needs a freshly approved successor', () => {
    const { root } = approved(); const before = bytes(root);
    refuses('confirmation-required', () => init(root, { ...choices, scope: 'one function' }));
    assert.deepEqual(bytes(root), before);
    init(root, { ...choices, scope: 'one function' }, true);
    assert.equal(state(root).choicesGeneration, 1);
    init(root, choices, true);
    assert.equal(state(root).choicesGeneration, 2);
    refuses('stale-agreement', () => gate(root));
    assert.equal(cli(root, 'read-state', '--require-agreement').json.code, 'stale-agreement');
    const a = agreement(root, 2); roadmap(root, a); const stale = bytes(root);
    refuses('confirmation-required', () => record(root, a)); assert.deepEqual(bytes(root), stale);
    record(root, a, true);
    assert.deepEqual(state(root).agreements.map((r) => r.payload.choicesGeneration), [0, 2]);
    assert.equal(gate(root).agreement.status, 'stored-context-current');
  });

  for (const [label, change] of [
    ['revision', (c) => { c.source.revision = 'another-revision'; }],
    ['configuration', (c) => { c.source.configuration = 'feature simd'; }],
    ['scope', (c) => { c.scope = 'smaller scope'; }],
    ['workers', (c) => { c.limits.workers = 4; }],
    ['total cap', (c) => { c.limits.wallClockHours = 41; }],
    ['inactive nodeHours metadata', (c) => { c.limits.nodeHours = 3; }],
  ]) it('advances only a confirmed ' + label + ' change and retains the previous agreement', () => {
    const { root } = approved(); const previous = state(root).agreements;
    const c = structuredClone(state(root).choices); change(c);
    refuses('confirmation-required', () => init(root, c)); assert.equal(state(root).choicesGeneration, 0);
    init(root, c, true); assert.equal(state(root).choicesGeneration, 1);
    init(root, c); assert.equal(state(root).choicesGeneration, 1);
    assert.deepEqual(state(root).agreements, previous); refuses('stale-agreement', () => gate(root));
  });

  it('preserves extension, limits, offer and failed extraction history through writers', () => {
    const { root } = approved();
    const s = state(root);
    s.extraction = { status: 'failed', recordedAt: 'fixture', selected: s.choices.source, reasons: ['fixture failure'],
      declared: { buildExitCode: 1, oracle: 'unknown' }, checks: { status: { ok: false }, 'verify-tree': { ok: false }, 'verify-restore': { ok: false } }, inputs: null, note: 'fixture only' };
    fs.writeFileSync(statePath(root), JSON.stringify(s));
    auto.recordRoadmap({ projectRoot: root, decision: 'declined' });
    init(root, { ...choices, scope: 'another module' }, true);
    const now = state(root);
    assert.deepEqual(now.agreements, s.agreements); assert.deepEqual(now.extraction, s.extraction);
    assert.equal(now.roadmap.decision, 'declined'); assert.deepEqual(now.choices.limits, s.choices.limits);
    assert.equal(now.choicesGeneration, 1); assert.equal(now.choices.limits.nodeHours, 2);
  });

  it('refuses a generation overflow without resetting or writing', () => {
    const { root } = approved(); const s = state(root); s.choicesGeneration = Number.MAX_SAFE_INTEGER;
    fs.writeFileSync(statePath(root), JSON.stringify(s)); const before = bytes(root);
    refuses('generation-exhausted', () => init(root, { ...choices, scope: 'changed' }, true));
    assert.deepEqual(bytes(root), before);
  });

  it('rejects invalid closed records and modes before mutation, including public API and invented roots', () => {
    const root = project(); const original = agreement(root); const before = bytes(root);
    for (const [code, mutate] of [
      ['invalid-input', (a) => { a.schemaVersion = 2; }],
      ['invalid-input', (a) => { a.extra = true; }],
      ['invalid-input', (a) => { a.payload.roots = ['invented']; }],
      ['invalid-input', (a) => { delete a.payload.claims; }],
      ['invalid-input', (a) => { a.approvedPayloadSha256 = '0'.repeat(64); }],
      ['invalid-input', (a) => { a.ownerEvidence.response = ''; }],
      ['unsupported-agreement-mode', (a) => { a.mode = 'public-api'; }],
      ['unsupported-agreement-mode', (a) => { a.mode = 'future'; }],
    ]) {
      const a = structuredClone(original); mutate(a); roadmap(root, a);
      refuses(code, () => record(root, a, true)); assert.deepEqual(bytes(root), before);
    }
    roadmap(root, original);
    const supplied = structuredClone(original); supplied.ownerEvidence.response = 'different actual response';
    refuses('agreement-context-mismatch', () => record(root, supplied));
    assert.deepEqual(bytes(root), before);
    const input = path.join(root, 'input.json'); fs.writeFileSync(input, JSON.stringify({ ...original, mode: 'public-api' }));
    const r = cli(root, 'record-agreement', '--input', input); assert.equal(r.status, 1); assert.equal(r.json.code, 'unsupported-agreement-mode');
  });

  it('validates stored extension/history on default reads without repairing malformed files', () => {
    const { root } = approved(); const valid = state(root);
    for (const mutate of [
      (s) => { delete s.choicesGeneration; }, (s) => { s.choicesGeneration = -1; },
      (s) => { s.agreements[0].schemaVersion = 99; }, (s) => { s.agreements[0].mode = 'public-api'; },
      (s) => { s.agreements[0].ownerEvidence.response = 'tampered'; },
      (s) => { s.agreements.push(structuredClone(s.agreements[0])); },
    ]) {
      const s = structuredClone(valid); mutate(s); fs.writeFileSync(statePath(root), JSON.stringify(s)); const before = bytes(root);
      refuses('malformed-state', () => auto.readState({ projectRoot: root }));
      assert.equal(cli(root, 'read-state').status, 3); assert.deepEqual(bytes(root), before);
    }
  });
});

describe('actual current canonical agreement binding', () => {
  it('accepts monorepo intent and keeps explicit execution and draft grants distinct', () => {
    const root = project(); const a = agreement(root); a.payload.layout = 'monorepo';
    a.payload.execution = { actions: ['fixture branch work'], reference: 'fixture:execution-grant' };
    a.payload.draftPr = { destination: 'fixture:fork/branch', reference: 'fixture:draft-grant' }; seal(a);
    roadmap(root, a); record(root, a);
    assert.deepEqual(gate(root).agreement.agreement.payload, a.payload);
  });

  for (const field of ['claims', 'trust', 'boundaries', 'conventions', 'acceptance', 'ownerReserved']) {
    it('refuses changed canonical ' + field + ' even when state choices did not change', () => {
      const { root, a } = approved(); const before = bytes(root);
      a.payload[field].push('material changed context'); a.payload.contextVersion++; seal(a); roadmap(root, a);
      refuses('stale-agreement-context', () => gate(root)); assert.deepEqual(bytes(root), before);
      assert.equal(state(root).choicesGeneration, 0);
    });
  }

  it('detects changed retained response and supplied approval bytes, but not a status-only append', () => {
    const { root, a } = approved(); const before = bytes(root);
    fs.appendFileSync(roadmapPath(root), '| routine progress and proof/helper revision |\n');
    assert.equal(gate(root).agreement.status, 'stored-context-current');
    a.ownerEvidence.response = 'changed retained response'; roadmap(root, a);
    refuses('stale-agreement-context', () => gate(root));
    a.approvedPayloadSha256 = 'f'.repeat(64); roadmap(root, a);
    refuses('invalid-agreement-context', () => gate(root)); assert.deepEqual(bytes(root), before);
  });

  it('refuses a symlinked/outside canonical roadmap even when its bytes match', () => {
    const { root, a } = approved(); const other = project(); roadmap(other, a);
    const before = bytes(root); fs.unlinkSync(roadmapPath(root)); fs.symlinkSync(roadmapPath(other), roadmapPath(root));
    refuses('agreement-context-missing', () => gate(root)); assert.deepEqual(bytes(root), before);
  });

  it('refuses missing, duplicate, wrong-section, unknown or superseded context without writes', () => {
    const { root, a } = approved(); const before = bytes(root); const good = fs.readFileSync(roadmapPath(root), 'utf8');
    fs.unlinkSync(roadmapPath(root)); refuses('agreement-context-missing', () => gate(root));
    for (const text of ['# No context\n', good + good, good.replace('## Decisions', '## Status log')]) {
      fs.writeFileSync(roadmapPath(root), text); refuses('invalid-agreement-context', () => gate(root));
    }
    for (const mutate of [(x) => { x.schemaVersion = 9; }, (x) => { x.payload.contextVersion = 0; }]) {
      const x = structuredClone(a); mutate(x); seal(x); roadmap(root, x); refuses('invalid-agreement-context', () => gate(root));
    }
    const publicMode = seal({ ...a, mode: 'public-api' }); roadmap(root, publicMode);
    refuses('unsupported-agreement-mode', () => gate(root));
    roadmap(root, a);
    const next = structuredClone(a); next.payload.contextVersion = 2; seal(next); roadmap(root, next); record(root, next, true);
    const latest = bytes(root); roadmap(root, a);
    refuses('stale-agreement-context', () => gate(root)); refuses('stale-agreement-context', () => record(root, a, true));
    assert.deepEqual(bytes(root), latest); assert.notDeepEqual(latest, before);
  });
});
