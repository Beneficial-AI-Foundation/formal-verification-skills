'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'fvs-probe-inventory.mjs');
const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-probe-inventory-'));
  temporaryDirectories.push(directory);
  return directory;
}

function rustAtom(overrides = {}) {
  return {
    'display-name': 'crate::module::function',
    dependencies: [],
    'code-module': 'module',
    'code-path': 'crate/src/lib.rs',
    'code-text': { 'lines-start': 10, 'lines-end': 12 },
    kind: 'exec',
    language: 'rust',
    'rust-qualified-name': 'crate::module::function',
    'is-relevant': true,
    untracked: false,
    ...overrides,
  };
}

function leanAtom(overrides = {}) {
  return {
    'display-name': 'function',
    dependencies: [],
    'code-module': 'Crate.Funs',
    'code-path': 'Crate/Funs.lean',
    'code-text': { 'lines-start': 20, 'lines-end': 22 },
    kind: 'def',
    language: 'lean',
    ...overrides,
  };
}

function envelope(data, overrides = {}) {
  return {
    schema: 'probe-aeneas/extract',
    'schema-version': '3.0',
    tool: { name: 'probe-aeneas', version: '0.19.0', command: 'extract' },
    inputs: [{ schema: 'probe-rust/extract', source: { package: 'crate' } }],
    timestamp: '2026-08-26T00:00:00Z',
    data,
    ...overrides,
  };
}

function writeEnvelope(directory, value, name = 'extract.json') {
  const file = path.join(directory, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function run(file, args = []) {
  return spawnSync(process.execPath, [SCRIPT, file, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

function fixtureData() {
  return {
    'probe:rust/z()': rustAtom({
      'display-name': 'crate::z|line\nbreak',
      'rust-qualified-name': 'crate::z',
      'code-path': 'crate/src/z.rs',
      'code-text': { 'lines-start': 30, 'lines-end': 35 },
      dependencies: ['probe:rust/a()', 'probe:external/helper'],
      'translation-name': 'probe:Crate.z',
      'translation-path': 'Crate/Funs.lean',
      'translation-text': { 'lines-start': 50, 'lines-end': 55 },
      'verification-status': 'verified',
    }),
    'probe:rust/a()': rustAtom({
      'display-name': 'crate::a',
      'rust-qualified-name': 'crate::a',
      'code-path': 'crate/src/a.rs',
      'translation-name': 'probe:Crate.a',
    }),
    'probe:rust/out()': rustAtom({ untracked: true }),
    'probe:rust/external()': rustAtom({ 'is-relevant': false, 'code-path': '' }),
    'probe:rust/type': rustAtom({ kind: 'type' }),
    'probe:Crate.z': leanAtom({
      'primary-spec': 'probe:Crate.z_spec',
    }),
    'probe:Crate.z_spec': leanAtom({
      kind: 'theorem',
      'code-path': 'Crate/Specs/Z.lean',
      'code-text': { 'lines-start': 7, 'lines-end': 14 },
    }),
  };
}

function graphData({ withPublicApi = false } = {}) {
  const publicApi = (value) => withPublicApi ? { 'is-public-api': value } : {};
  return {
    'probe:rust/top()': rustAtom({
      'display-name': 'crate::top',
      'rust-qualified-name': 'crate::top',
      'code-path': 'crate/src/top.rs',
      dependencies: ['probe:rust/middle()'],
      'translation-name': 'probe:Crate.top',
      'verification-status': 'verified',
      ...publicApi(true),
    }),
    'probe:rust/middle()': rustAtom({
      'display-name': 'crate::middle',
      'rust-qualified-name': 'crate::middle',
      'code-path': 'crate/src/middle.rs',
      dependencies: ['probe:rust/entry()'],
      'translation-name': 'probe:Crate.middle',
      'verification-status': 'failed',
      ...publicApi(true),
    }),
    'probe:rust/entry()': rustAtom({
      'display-name': 'crate::entry',
      'rust-qualified-name': 'crate::entry',
      'code-path': 'crate/src/entry.rs',
      ...publicApi(true),
    }),
    'probe:rust/isolated()': rustAtom({
      'display-name': 'crate::isolated',
      'rust-qualified-name': 'crate::isolated',
      'code-path': 'crate/src/isolated.rs',
      'translation-name': 'probe:Crate.isolated',
      'verification-status': 'trusted',
      ...publicApi(false),
    }),
    'probe:rust/transitive()': rustAtom({
      'display-name': 'crate::transitive',
      'rust-qualified-name': 'crate::transitive',
      'code-path': 'crate/src/transitive.rs',
      dependencies: ['probe:rust/entry()'],
      'translation-name': 'probe:Crate.transitive',
      'verification-status': 'transitively-verified',
      ...publicApi(true),
    }),
    'probe:Crate.top': leanAtom({ 'primary-spec': 'probe:Crate.top_spec' }),
    'probe:Crate.middle': leanAtom({ 'primary-spec': 'probe:Crate.middle_spec' }),
    'probe:Crate.isolated': leanAtom({ 'primary-spec': 'probe:Crate.isolated_spec' }),
    'probe:Crate.transitive': leanAtom({ 'primary-spec': 'probe:Crate.transitive_spec' }),
    'probe:Crate.top_spec': leanAtom({ kind: 'theorem' }),
    'probe:Crate.middle_spec': leanAtom({ kind: 'theorem' }),
    'probe:Crate.isolated_spec': leanAtom({ kind: 'theorem' }),
    'probe:Crate.transitive_spec': leanAtom({ kind: 'theorem' }),
  };
}

describe('probe-aeneas canonical function inventory', () => {
  it('filters by the v0.19 scope predicate and emits stable, sorted metadata', () => {
    const directory = temporaryDirectory();
    const data = fixtureData();
    const first = writeEnvelope(directory, envelope(data), 'first.json');
    const second = writeEnvelope(directory, envelope(Object.fromEntries(
      Object.entries(data).reverse(),
    )), 'second.json');

    const firstRun = run(first);
    const secondRun = run(second);
    assert.equal(firstRun.status, 0, firstRun.stderr);
    assert.equal(secondRun.status, 0, secondRun.stderr);
    assert.equal(firstRun.stdout, secondRun.stdout, 'object insertion order must not affect output');

    const result = JSON.parse(firstRun.stdout);
    assert.equal(result.count, 2);
    assert.deepEqual(result.functions.map((item) => item.id), ['probe:rust/a()', 'probe:rust/z()']);
    assert.equal(result.scopePredicate,
      'language=rust && kind=exec && is-relevant=true && untracked=false');
    assert.deepEqual(result.topLevelFunctions, ['probe:rust/z()']);
    assert.deepEqual(result.entryPointFunctions, ['probe:rust/a()']);
    assert.equal(result.publicTopLevelFunctions, null);
    assert.deepEqual(result.progress, {
      total: 2,
      specification: { specified: 1, unspecified: 1 },
      verification: {
        unverified: 1,
        failed: 0,
        verified: 1,
        'transitively-verified': 0,
        trusted: 0,
        proved: 1,
      },
    });
    assert.deepEqual(result.functions[1], {
      id: 'probe:rust/z()',
      displayName: 'crate::z|line\nbreak',
      rustFqn: 'crate::z',
      rustPath: 'crate/src/z.rs',
      rustSpan: { linesStart: 30, linesEnd: 35 },
      leanId: 'probe:Crate.z',
      leanFqn: 'Crate.z',
      leanPath: 'Crate/Funs.lean',
      leanSpan: { linesStart: 50, linesEnd: 55 },
      primarySpecId: 'probe:Crate.z_spec',
      primarySpecFqn: 'Crate.z_spec',
      primarySpecPath: 'Crate/Specs/Z.lean',
      primarySpecSpan: { linesStart: 7, linesEnd: 14 },
      dependencies: ['probe:external/helper', 'probe:rust/a()'],
      inScopeDependencies: ['probe:rust/a()'],
      outsideTargetDependencies: [],
      dependents: [],
      verificationStatus: 'verified',
    });
  });

  it('derives project-wide endpoints and exact progress partitions', () => {
    const directory = temporaryDirectory();
    const unavailable = run(writeEnvelope(directory, envelope(graphData()), 'unavailable.json'));
    assert.equal(unavailable.status, 0, unavailable.stderr);

    const result = JSON.parse(unavailable.stdout);
    assert.deepEqual(result.topLevelFunctions, [
      'probe:rust/isolated()',
      'probe:rust/top()',
      'probe:rust/transitive()',
    ]);
    assert.deepEqual(result.entryPointFunctions, [
      'probe:rust/entry()',
      'probe:rust/isolated()',
    ]);
    assert.equal(result.publicTopLevelFunctions, null);
    assert.deepEqual(result.progress, {
      total: 5,
      specification: { specified: 4, unspecified: 1 },
      verification: {
        unverified: 1,
        failed: 1,
        verified: 1,
        'transitively-verified': 1,
        trusted: 1,
        proved: 2,
      },
    });

    const byId = Object.fromEntries(result.functions.map((item) => [item.id, item]));
    assert.deepEqual(byId['probe:rust/entry()'].dependents, [
      'probe:rust/middle()',
      'probe:rust/transitive()',
    ]);
    assert.deepEqual(byId['probe:rust/middle()'].dependents, ['probe:rust/top()']);
    assert.deepEqual(byId['probe:rust/isolated()'].dependents, []);

    const availableFile = writeEnvelope(
      directory, envelope(graphData({ withPublicApi: true })), 'available.json',
    );
    const unconfirmed = run(availableFile);
    assert.equal(unconfirmed.status, 0, unconfirmed.stderr);
    assert.equal(JSON.parse(unconfirmed.stdout).publicTopLevelFunctions, null);

    const available = run(availableFile, ['--public-api-exact']);
    assert.equal(available.status, 0, available.stderr);
    assert.deepEqual(JSON.parse(available.stdout).publicTopLevelFunctions, [
      'probe:rust/top()',
      'probe:rust/transitive()',
    ]);

    const markdown = run(
      writeEnvelope(directory, envelope(graphData()), 'progress.json'),
      ['--format', 'markdown'],
    );
    assert.equal(markdown.status, 0, markdown.stderr);
    assert.match(markdown.stdout, /Specified \| 4\/5 \(80\.0%\)/);
    assert.match(markdown.stdout, /Unspecified \| 1\/5 \(20\.0%\)/);
    assert.match(markdown.stdout, /Proved \(verified \+ transitively-verified\) \| 2\/5 \(40\.0%\)/);
    assert.match(markdown.stdout, /Public top-level functions: unavailable/);
  });

  it('renders and byte-checks one managed CODEMAP block', () => {
    const directory = temporaryDirectory();
    const file = writeEnvelope(directory, envelope(fixtureData()));
    const markdown = run(file, ['--format', 'markdown']);
    assert.equal(markdown.status, 0, markdown.stderr);
    assert.match(markdown.stdout, /<!-- fvs:probe-inventory:start -->/);
    assert.match(markdown.stdout, /Function count: \*\*2\*\*/);
    assert.match(markdown.stdout, /crate::z\\\|line break/);

    const codemap = path.join(directory, 'CODEMAP.md');
    const suffix = '\n## Notes\n\n<!-- user -->keep this exactly\n';
    fs.writeFileSync(codemap, `# CODEMAP\n\n${markdown.stdout.trimEnd()}${suffix}`);
    const checked = run(file, ['--format', 'count', '--check-codemap', codemap]);
    assert.equal(checked.status, 0, checked.stderr);
    assert.equal(checked.stdout.trim(), '2');

    fs.writeFileSync(codemap, fs.readFileSync(codemap, 'utf8').replace(
      'Function count: **2**', 'Function count: **3**',
    ));
    const changed = run(file, ['--check-codemap', codemap]);
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /canonical inventory block differs/);

    const refreshedFile = writeEnvelope(directory, envelope(graphData()), 'refresh.json');
    const refreshed = run(refreshedFile, [
      '--format', 'count', '--update-codemap', codemap, '--check-codemap', codemap,
    ]);
    assert.equal(refreshed.status, 0, refreshed.stderr);
    assert.equal(refreshed.stdout.trim(), '5');
    const refreshedContent = fs.readFileSync(codemap, 'utf8');
    assert.ok(refreshedContent.startsWith('# CODEMAP\n\n'));
    assert.ok(refreshedContent.endsWith(suffix));
    assert.match(refreshedContent, /Function count: \*\*5\*\*/);
    assert.equal(refreshedContent.split('<!-- fvs:probe-inventory:start -->').length - 1, 1);
  });

  it('selects targets by project-relative paths and qualified-name boundaries', () => {
    const directory = temporaryDirectory();
    const project = path.join(directory, 'project');
    fs.mkdirSync(project);
    const file = writeEnvelope(directory, envelope(fixtureData()));

    for (const target of [
      path.join(project, 'Crate', 'Specs', 'Z.lean'),
      'crate/src/z.rs',
      'crate::z',
      'Crate.z_spec',
    ]) {
      const selected = run(file, ['--project-root', project, '--target', target]);
      assert.equal(selected.status, 0, `${target}: ${selected.stderr}`);
      assert.deepEqual(JSON.parse(selected.stdout).functions.map((item) => item.id), ['probe:rust/z()']);
    }

    const missing = run(file, ['--project-root', project, '--target', 'crate::missing']);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /matched no canonical functions/);

    const escape = run(file, ['--project-root', project, '--target', '../outside/Z.lean']);
    assert.notEqual(escape.status, 0);
    assert.match(escape.stderr, /outside the project root/);

    const graphFile = writeEnvelope(directory, envelope(graphData()), 'target.json');
    const selected = run(graphFile, ['--project-root', project, '--target', 'crate::top']);
    assert.equal(selected.status, 0, selected.stderr);
    const target = JSON.parse(selected.stdout);
    assert.deepEqual(target.topLevelFunctions, ['probe:rust/top()']);
    assert.deepEqual(target.entryPointFunctions, []);
    assert.deepEqual(target.functions[0].inScopeDependencies, []);
    assert.deepEqual(target.functions[0].outsideTargetDependencies, ['probe:rust/middle()']);
    assert.deepEqual(target.progress, {
      total: 1,
      specification: { specified: 1, unspecified: 0 },
      verification: {
        unverified: 0,
        failed: 0,
        verified: 1,
        'transitively-verified': 0,
        trusted: 0,
        proved: 1,
      },
    });
  });

  it('fails closed on stale or malformed probe envelopes', () => {
    const directory = temporaryDirectory();
    const valid = envelope(fixtureData());
    const cases = [
      [{ ...valid, schema: 'probe-rust/extract' }, /schema/],
      [{ ...valid, tool: { ...valid.tool, version: '0.18.9' } }, /0\.19\.0/],
      [{ ...valid, data: [] }, /data/],
      [envelope({ bad: rustAtom({ 'is-relevant': undefined }) }), /is-relevant/],
      [envelope({ bad: rustAtom({ untracked: 'false' }) }), /untracked/],
      [envelope({ bad: rustAtom({ 'verification-status': 'unknown' }) }), /verification-status/],
      [envelope({ bad: rustAtom({ 'is-public-api': 'true' }) }), /is-public-api/],
    ];

    for (const [payload, diagnostic] of cases) {
      const result = run(writeEnvelope(directory, payload, `${Math.random()}.json`));
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, diagnostic);
      assert.equal(result.stdout, '');
    }
  });

  it('wires map-code around the canonical projection rather than model counting', () => {
    const command = fs.readFileSync(path.join(ROOT, 'commands', 'fvs', 'map-code.md'), 'utf8');
    const workflow = fs.readFileSync(path.join(ROOT, 'fv-skills', 'workflows', 'map-code.md'), 'utf8');
    const researcher = fs.readFileSync(path.join(ROOT, 'agents', 'fvs-researcher.md'), 'utf8');
    const executor = fs.readFileSync(path.join(ROOT, 'agents', 'fvs-executor.md'), 'utf8');

    for (const content of [command, workflow]) {
      assert.match(content, /probe-aeneas extract/);
      assert.match(content, /fvs-probe-inventory\.mjs/);
      assert.match(content, /--check-codemap/);
      assert.match(content, /canonical_inventory/i);
      assert.match(content, /never (?:discover|add|remove|recount)/i);
      assert.ok(!content.includes("trap 'rm -rf"), 'extract must survive until the post-write check');
      assert.ok(content.lastIndexOf('rm -rf -- "$PROBE_TMP"') > content.indexOf('--check-codemap'));
    }
    assert.match(researcher, /parent-supplied canonical inventory/i);
    assert.match(researcher, /never (?:discover|add|remove|recount)/i);
    assert.match(executor, /parent-supplied canonical inventory/i);
    assert.match(executor, /never (?:discover|add|remove|recount)/i);
    assert.match(executor, /byte-for-byte and exactly once/i);
  });
});
