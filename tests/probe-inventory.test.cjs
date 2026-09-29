'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

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
    const planCommand = fs.readFileSync(path.join(ROOT, 'commands', 'fvs', 'fc-plan.md'), 'utf8');
    const planWorkflow = fs.readFileSync(path.join(ROOT, 'fv-skills', 'workflows', 'fc-plan.md'), 'utf8');

    for (const content of [command, workflow]) {
      assert.match(content, /probe-aeneas extract/);
      assert.match(content, /fvs-probe-inventory\.mjs/);
      assert.match(content, /--check-codemap/);
      assert.match(content, /canonical_inventory/i);
      assert.match(content, /never (?:discover|add|remove|recount)/i);
      assert.match(content, /cargo-public-api/);
      assert.match(content, /--with-public-api/);
      assert.match(content, /cargo-public-api found/);
      assert.match(content, /--public-api-exact/);
      assert.match(content, /topLevelFunctions/);
      assert.match(content, /entryPointFunctions/);
      assert.ok(!content.includes("trap 'rm -rf"), 'extract must survive until the post-write check');
      assert.ok(content.lastIndexOf('rm -rf -- "$PROBE_TMP"') > content.indexOf('--check-codemap'));
      assert.ok(!content.includes('leaf functions sorted'));
    }
    assert.match(researcher, /parent-supplied canonical inventory/i);
    assert.match(researcher, /never (?:discover|add|remove|recount)/i);
    assert.ok(!researcher.includes('Use only supplied `inScopeDependencies` to identify leaves'));
    assert.ok(!researcher.includes('No spec file = unspecified'));
    assert.match(executor, /parent-supplied canonical inventory/i);
    assert.match(executor, /never (?:discover|add|remove|recount)/i);
    assert.match(executor, /byte-for-byte and exactly once/i);
    assert.ok(!executor.includes('Adjacency and leaf lists derived'));
    assert.ok(!executor.includes('Verification state per function'));

    for (const content of [planCommand, planWorkflow]) {
      assert.match(content, /probe-aeneas extract/);
      assert.match(content, /fvs-probe-inventory\.mjs/);
      assert.match(content, /--update-codemap/);
      assert.match(content, /--public-api-exact/);
      assert.match(content, /outsideTargetDependencies/);
      assert.match(content, /canonical_inventory/i);
      assert.match(content, /complexity.*risk.*recommendation/is);
      assert.ok(content.lastIndexOf('rm -rf -- "$PROBE_TMP"') > content.lastIndexOf('--check-codemap'));
      assert.ok(!content.includes('"Ready now" set'));
      assert.ok(!content.includes('## Blocked Functions'));
      assert.ok(!content.includes('bottom-up by dependency depth'));
      assert.ok(!content.includes('Topological sort of unverified functions'));
    }
  });
});

// ---------------------------------------------------------------------------
// Verified probe-aeneas setup: resolver, confinement, installer and routing.
// ---------------------------------------------------------------------------

const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'probe-compatibility.json');
const TESTED_TARGET = 'aarch64-apple-darwin';
const ON_TESTED_HOST = process.platform === 'darwin' && process.arch === 'arm64' &&
  fs.existsSync('/usr/bin/sandbox-exec');
const HAS_BSDTAR = (spawnSync('/usr/bin/tar', ['--version'], { encoding: 'utf8' }).stdout || '')
  .includes('bsdtar');
const NODE_DIR = path.dirname(process.execPath);
const ENTRY_POINTS = [
  'commands/fvs/map-code.md',
  'commands/fvs/fc-plan.md',
  'commands/fvs/trust-audit.md',
  'fv-skills/workflows/map-code.md',
  'fv-skills/workflows/fc-plan.md',
  'fv-skills/workflows/trust-audit.md',
];

function fixture() {
  return JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
}

function testedTuple() {
  return fixture().tuples[0];
}

function sha256(bytes) {
  return require('node:crypto').createHash('sha256').update(bytes).digest('hex');
}

async function loadSetup(script = SCRIPT) {
  return import(pathToFileURL(script).href);
}

function writeExecutable(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

// A project whose provenance files mirror the tested consumer's layout.
function tupleProject(directory, overrides = {}) {
  const tuple = testedTuple();
  const root = path.join(directory, 'project');
  fs.mkdirSync(path.join(root, 'Crate'), { recursive: true });
  fs.mkdirSync(path.join(root, 'crate'), { recursive: true });
  fs.writeFileSync(path.join(root, 'crate', 'Cargo.toml'), '[package]\nname = "crate"\n');
  fs.writeFileSync(path.join(root, 'lakefile.toml'), 'name = "Crate"\n');
  fs.writeFileSync(path.join(root, 'aeneas-config.yml'), overrides.config ??
    `aeneas:\n  commit: "${tuple.aeneasRev.slice(0, 8)}"  # pinned\n\ncrate:\n  dir: "crate"\n\n` +
    'charon:\n  pinned_deps:\n    zeroize: "1.9.0"\n\naeneas_args:\n  options:\n    - split-files\n  dest: "Crate"\n');
  fs.writeFileSync(path.join(root, 'lake-manifest.json'), JSON.stringify({
    packages: [{ name: 'mathlib', rev: 'f'.repeat(40) }, { name: 'aeneas', rev: overrides.aeneasRev ?? tuple.aeneasRev }],
  }));
  fs.writeFileSync(path.join(root, 'lean-toolchain'), `${overrides.leanToolchain ?? tuple.leanToolchain}\n`);
  if (overrides.translation !== null) {
    fs.writeFileSync(path.join(root, 'Crate', 'translation.json'), JSON.stringify(overrides.translation ?? {
      aeneas_version: tuple.aeneasRev.slice(0, 8),
      charon_version: tuple.charonVersion,
      functions: [],
    }));
  }
  return root;
}

function toolEnvironment(directory) {
  const home = path.join(directory, 'home');
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(path.join(home, '.cargo', 'bin'), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  return {
    home,
    bin,
    toolsHome: path.join(directory, 'fvs-tools'),
    env: {
      HOME: home,
      PATH: [bin, NODE_DIR, '/usr/bin', '/bin'].join(':'),
      FVS_TOOLS_HOME: path.join(directory, 'fvs-tools'),
    },
  };
}

function installStubHelpers({ home, bin }) {
  const helpers = testedTuple().platforms[TESTED_TARGET].helpers;
  writeExecutable(path.join(bin, 'probe-rust'), `echo "${helpers['probe-rust'].version}"`);
  writeExecutable(path.join(bin, 'scip'), `echo "${helpers.scip.version}"`);
  writeExecutable(path.join(home, '.local', 'bin', 'probe-lean-v4.31.0'), `echo "${helpers['probe-lean'].version}"`);
  fs.mkdirSync(path.join(home, '.local', 'lib', 'probe-lean-v4.31.0'), { recursive: true });
  writeExecutable(path.join(bin, 'rust-analyzer'), `echo "${helpers['rust-analyzer'].version}"`);
  writeExecutable(path.join(bin, 'rustup'), 'printf "rust-analyzer-aarch64-apple-darwin\\nrust-src\\n"');
}

// A stand-in probe-aeneas that tries every forbidden write before emitting a
// valid envelope, so the sandbox rules are exercised without the real tools.
function stubProbe(directory) {
  const file = path.join(directory, 'probe', 'probe-aeneas');
  const extract = JSON.stringify(envelope(fixtureData(), {
    tool: { name: 'probe-aeneas', version: '0.20.0', command: 'extract' },
  }));
  writeExecutable(file, [
    'if [ "$1" = --version ]; then echo "probe-aeneas 0.20.0"; exit 0; fi',
    'root="$2"; out="$4"',
    'echo invoked > "$(dirname "$out")/invoked"',
    'mkdir "$HOME/.probe-rust" 2>/dev/null',
    'touch "$HOME/.cargo/bin/injected" "$root/forbidden.txt" "$(dirname "$0")/injected" 2>/dev/null',
    'mkdir -p "$root/.verilib" && echo ok > "$root/.verilib/allowed.txt"',
    'mkdir "$root/crate/target" "$root/targetAbC123" 2>/dev/null',
    'echo "$TMPDIR" > "$root/.verilib/tmpdir.txt"',
    `printf '%s' '${extract}' > "$out"`,
    '[ -z "$STUB_FAIL" ] || exit 1',
  ].join('\n'));
  return file;
}

function cli(args, env, cwd = ROOT, script = SCRIPT) {
  return spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8' });
}

function resolveJson(root, env, extra = []) {
  const result = cli(['resolve', '--project-root', root, '--format', 'json', ...extra], env);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function tarEntry(name, { type = '0', body = Buffer.alloc(0), linkname = '', mode = 0o755 } = {}) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write(type, 156);
  header.write(linkname, 157, 100);
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([header, padded]);
}

function paxPath(name) {
  const record = ` path=${name}\n`;
  let length = record.length;
  while (`${length}${record}`.length !== length) length = `${length}${record}`.length;
  return tarEntry('PaxHeader', { type: 'x', body: Buffer.from(`${length}${record}`), mode: 0o644 });
}

const STUB_EXECUTABLE = Buffer.from('#!/bin/sh\necho "probe-aeneas 9.9.9"\n');
const STUB_MEMBERS = ['probe-aeneas-stub/', 'probe-aeneas-stub/probe-aeneas', 'probe-aeneas-stub/README.md'];

function stubArchive(entries) {
  return Buffer.concat([...entries, Buffer.alloc(1024)]);
}

function goodEntries(executable = STUB_EXECUTABLE) {
  return [
    tarEntry('probe-aeneas-stub/', { type: '5' }),
    tarEntry('probe-aeneas-stub/probe-aeneas', { body: executable }),
    tarEntry('probe-aeneas-stub/README.md', { body: Buffer.from('readme\n'), mode: 0o644 }),
  ];
}

function stubRelease(archiveBytes, overrides = {}) {
  return {
    tool: 'probe-aeneas',
    tag: 'v9.9.9',
    version: '9.9.9',
    tagCommit: '0'.repeat(40),
    baseUrl: 'https://example.invalid/',
    assets: {
      'stub-target': {
        asset: 'probe-aeneas-stub.tar.xz',
        archiveSha256: sha256(archiveBytes),
        members: STUB_MEMBERS,
        executable: 'probe-aeneas-stub/probe-aeneas',
        executableSha256: sha256(STUB_EXECUTABLE),
        supported: true,
        ...overrides,
      },
    },
  };
}

// Writes a raw tar and, for the success path, a genuinely xz-compressed copy.
function writeArchive(directory, name, raw, { xz = false } = {}) {
  const rawFile = path.join(directory, `${name}.tar`);
  fs.writeFileSync(rawFile, raw);
  if (!xz) return rawFile;
  const xzFile = path.join(directory, `${name}.tar.xz`);
  const packed = spawnSync('/usr/bin/tar', ['-cJf', xzFile, `@${rawFile}`], { encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  return xzFile;
}

function auditLines(toolsRoot) {
  const file = path.join(toolsRoot, 'probe-aeneas', 'install-audit.jsonl');
  return fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    : [];
}

function stagingLeftovers(toolsRoot) {
  const parent = path.join(toolsRoot, 'probe-aeneas');
  return fs.existsSync(parent) ? fs.readdirSync(parent).filter((name) => name.startsWith('.staging-')) : [];
}

function bashBlock(content, marker) {
  const match = content.match(new RegExp('```bash\\n(# ' + marker + '\\n[\\s\\S]*?)```'));
  return match ? match[1] : null;
}

describe('verified probe-aeneas compatibility evidence', () => {
  it('embeds tables that equal the evidence fixture exactly, from an installed layout', async () => {
    const directory = temporaryDirectory();
    const layout = path.join(directory, 'installed');
    fs.mkdirSync(path.join(layout, 'scripts'), { recursive: true });
    const copied = path.join(layout, 'scripts', 'fvs-probe-inventory.mjs');
    fs.copyFileSync(SCRIPT, copied);
    assert.ok(!fs.existsSync(path.join(layout, 'tests')));

    const shipped = await loadSetup(copied);
    const evidence = fixture();
    assert.deepEqual(shipped.PROBE_RELEASE, evidence.release);
    assert.deepEqual(shipped.TESTED_TUPLES, evidence.tuples);
    assert.ok(shipped.TESTED_TUPLES.length > 0);

    const assets = Object.entries(evidence.release.assets);
    assert.deepEqual(assets.map(([target]) => target).sort(), [
      'aarch64-apple-darwin',
      'aarch64-unknown-linux-gnu',
      'x86_64-apple-darwin',
      'x86_64-pc-windows-msvc',
      'x86_64-unknown-linux-gnu',
    ]);
    for (const [target, asset] of assets) {
      assert.match(asset.archiveSha256, /^[0-9a-f]{64}$/, target);
      if (!asset.supported) assert.ok(asset.reason, `${target} needs an unsupported reason`);
    }
    assert.deepEqual(assets.filter(([, asset]) => asset.supported).map(([target]) => target),
      [TESTED_TARGET]);

    for (const tuple of evidence.tuples) {
      for (const [target, platform] of Object.entries(tuple.platforms)) {
        assert.equal(evidence.release.assets[target].supported, true, target);
        const receipt = evidence.receipts[target];
        assert.ok(receipt, `${target} has no receipt`);
        assert.equal(receipt.tuple, tuple.id);
        assert.equal(receipt.isolation.mechanism, platform.isolation);
        assert.equal(receipt.probeAeneas.executableSha256, evidence.release.assets[target].executableSha256);
        assert.equal(receipt.probeAeneas.archiveSha256, evidence.release.assets[target].archiveSha256);
        assert.equal(receipt.consumer.aeneasLakeRev, tuple.aeneasRev);
        assert.equal(receipt.consumer.charonVersion, tuple.charonVersion);
        assert.equal(receipt.consumer.leanToolchain, tuple.leanToolchain);
        assert.ok(tuple.testedWith.endsWith(`@${receipt.consumer.commit}`));
        for (const [name, helper] of Object.entries(platform.helpers)) {
          assert.equal(receipt.helpers[name].version, helper.version, name);
        }
        assert.ok(receipt.observed.positive.canonicalCount > 0);
        assert.ok(receipt.observed.positive.defIdJoins > 0);
        assert.equal(receipt.observed.denial.mergedOutputWritten, false);
      }
    }

    const env = toolEnvironment(directory);
    const project = tupleProject(directory);
    const resolved = cli(['resolve', '--project-root', project, '--platform', TESTED_TARGET,
      '--format', 'json'], env.env, directory, copied);
    assert.equal(resolved.status, 0, resolved.stderr);
    const result = JSON.parse(resolved.stdout);
    assert.equal(result.tuple, evidence.tuples[0].id);
    assert.equal(result.status, 'missing');
    assert.equal(result.install.available, true);
    assert.equal(result.install.destination,
      path.join(env.toolsHome, 'probe-aeneas', `0.20.0-${TESTED_TARGET}`, 'probe-aeneas'));
    assert.ok(!fs.existsSync(env.toolsHome), 'resolve must not write');
  });

  it('ships the resolver in the npm package and generated plugin payloads', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.ok(packageJson.files.includes('scripts'));
    const builder = fs.readFileSync(path.join(ROOT, 'scripts', 'build-plugin.cjs'), 'utf8');
    const list = builder.match(/const SCRIPT_FILES = \[([\s\S]*?)\];/);
    assert.ok(list);
    assert.match(list[1], /'fvs-probe-inventory\.mjs'/);
  });
});

describe('verified probe-aeneas resolution', () => {
  it('rejects unknown and conflicting provenance for verified operations only', () => {
    const tuple = testedTuple();
    const cases = [
      [{ translation: null }, /translation\.json is missing/],
      [{ translation: { aeneas_version: 'deadbeef', charon_version: tuple.charonVersion } },
        /conflict: translation\.json aeneas_version deadbeef/],
      [{ translation: { charon_version: tuple.charonVersion } }, /translation\.json has no aeneas_version/],
      [{ config: `aeneas:\n  commit: "abcdef12"\ncrate:\n  dir: "crate"\naeneas_args:\n  dest: "Crate"\n` },
        /conflict: aeneas-config\.yml aeneas\.commit abcdef12/],
      [{ config: 'crate:\n  dir: "../outside"\naeneas_args:\n  dest: "Crate"\n' }, /crate\.dir escapes/],
      [{ aeneasRev: '6e167c9b' }, /not a full commit/],
    ];
    for (const [overrides, reason] of cases) {
      const directory = temporaryDirectory();
      const env = toolEnvironment(directory);
      const result = resolveJson(tupleProject(directory, overrides), env.env, ['--platform', TESTED_TARGET]);
      assert.equal(result.status, 'unknown', JSON.stringify(overrides));
      assert.match(result.reasons.join('\n'), reason);
      assert.deepEqual(result.choices, ['setup', 'continue-without-graph', 'cancel']);
      assert.equal(result.install.available, false);
    }
  });

  it('never selects a probe for an untested tuple', () => {
    for (const overrides of [
      { translation: { aeneas_version: '6e167c9b', charon_version: '0.1.226' } },
      { leanToolchain: 'leanprover/lean4:v4.32.0' },
    ]) {
      const directory = temporaryDirectory();
      const env = toolEnvironment(directory);
      const result = resolveJson(tupleProject(directory, overrides), env.env, ['--platform', TESTED_TARGET]);
      assert.equal(result.status, 'incompatible');
      assert.equal(result.tuple, null);
      assert.equal(result.install.available, false);
      assert.match(result.reasons[0], /no tested probe-aeneas tuple/);
    }
  });

  it('classifies every other official asset as an unsupported platform', () => {
    const directory = temporaryDirectory();
    const env = toolEnvironment(directory);
    const project = tupleProject(directory);
    const assets = fixture().release.assets;
    for (const target of [...Object.keys(assets).filter((name) => name !== TESTED_TARGET), 'riscv64gc-unknown-linux-gnu']) {
      const result = resolveJson(project, env.env, ['--platform', target]);
      assert.equal(result.status, 'unsupported-platform', target);
      assert.equal(result.platformSupported, false);
      assert.equal(result.install.available, false);
      assert.deepEqual(result.choices, ['setup', 'continue-without-graph', 'cancel']);
      if (assets[target]) assert.ok(result.reasons[0].includes(assets[target].reason));
    }
    assert.match(resolveJson(project, env.env, ['--platform', 'aarch64-unknown-linux-gnu']).reasons[0], /#77/);
  });

  it('verifies the probe and every preinstalled helper by exact version', () => {
    const directory = temporaryDirectory();
    const env = toolEnvironment(directory);
    const project = tupleProject(directory);
    installStubHelpers(env);
    const probe = stubProbe(directory);
    const verified = resolveJson(project, env.env, ['--platform', TESTED_TARGET, '--probe', probe]);
    assert.equal(verified.status, 'verified', verified.reasons.join('\n'));
    assert.equal(verified.probe.source, 'explicit');
    assert.equal(verified.probe.official, false);
    assert.deepEqual(verified.choices, []);
    for (const helper of Object.values(verified.helpers)) assert.equal(helper.status, 'ok');
    if (ON_TESTED_HOST) {
      fs.copyFileSync(probe, path.join(env.bin, 'probe-aeneas'));
      fs.chmodSync(path.join(env.bin, 'probe-aeneas'), 0o755);
      const ready = cli(['install', '--project-root', project, '--consent', 'interactive'], env.env);
      assert.equal(ready.status, 0, ready.stderr);
      assert.match(ready.stderr, /already verified/);
    }

    fs.rmSync(path.join(env.bin, 'scip'));
    const missing = resolveJson(project, env.env, ['--platform', TESTED_TARGET, '--probe', probe]);
    assert.equal(missing.status, 'missing');
    assert.equal(missing.helpers.scip.status, 'missing');
    assert.equal(missing.install.available, false, 'helpers are never installed by FVS');
    assert.match(missing.manual.join('\n'), /scip-darwin-arm64\.tar\.gz/);
    if (ON_TESTED_HOST) {
      const helpersOnly = cli(['install', '--project-root', project, '--consent', 'interactive'], env.env);
      assert.equal(helpersOnly.status, 3);
      assert.match(helpersOnly.stderr, /FVS never installs helpers/);
      assert.ok(!fs.existsSync(env.toolsHome), 'no install when only helpers are missing');
    }

    writeExecutable(path.join(env.bin, 'scip'), 'echo "scip version v0.9.0"');
    fs.rmSync(path.join(env.home, '.local', 'lib'), { recursive: true });
    const drift = resolveJson(project, env.env, ['--platform', TESTED_TARGET, '--probe', probe]);
    assert.equal(drift.status, 'incompatible');
    assert.equal(drift.helpers.scip.status, 'incompatible');
    assert.equal(drift.helpers['probe-lean'].status, 'missing');
  });

  it('preserves an incompatible user probe and offers a side-by-side install', () => {
    const directory = temporaryDirectory();
    const env = toolEnvironment(directory);
    const project = tupleProject(directory);
    installStubHelpers(env);
    const userProbe = path.join(env.bin, 'probe-aeneas');
    writeExecutable(userProbe, 'echo "probe-aeneas 0.19.0"');
    const before = fs.readFileSync(userProbe);
    const result = resolveJson(project, env.env, ['--platform', TESTED_TARGET]);
    assert.equal(result.status, 'incompatible');
    assert.equal(result.probe.source, 'path');
    assert.match(result.probe.reason, /0\.19\.0/);
    assert.equal(result.install.available, true);
    assert.equal(result.install.pathChanges.startsWith('none'), true);
    assert.deepEqual(fs.readFileSync(userProbe), before);

    const managed = path.join(env.toolsHome, 'probe-aeneas', `0.20.0-${TESTED_TARGET}`, 'probe-aeneas');
    writeExecutable(managed, 'echo "probe-aeneas 0.20.0"');
    const tampered = resolveJson(project, env.env, ['--platform', TESTED_TARGET]);
    assert.equal(tampered.probe.source, 'fvs-managed');
    assert.equal(tampered.status, 'incompatible');
    assert.match(tampered.probe.reason, /pinned executable digest/);
  });
});

describe('confined probe-aeneas invocation', () => {
  it('generates a policy from real paths that denies network, tool homes and bin dirs', async () => {
    const { extractionPolicy, protectedDirs } = await loadSetup();
    const directory = fs.realpathSync(temporaryDirectory());
    const root = path.join(directory, 'proj.v1');
    const crate = path.join(root, 'crate');
    fs.mkdirSync(crate, { recursive: true });
    const saved = { HOME: process.env.HOME, PATH: process.env.PATH, FVS_TOOLS_HOME: process.env.FVS_TOOLS_HOME };
    let protect;
    try {
      process.env.HOME = path.join(directory, 'home');
      process.env.PATH = `${path.join(directory, 'bin')}:relative/bin:/usr/bin`;
      process.env.FVS_TOOLS_HOME = path.join(directory, 'tools');
      protect = protectedDirs(path.join(directory, 'probe', 'probe-aeneas'));
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    for (const dir of ['.cargo', '.rustup', '.elan', '.local', '.probe-rust']) {
      assert.ok(protect.includes(path.join(directory, 'home', dir)), dir);
    }
    for (const dir of ['bin', 'tools', 'probe']) assert.ok(protect.includes(path.join(directory, dir)), dir);
    assert.ok(protect.includes('/usr/bin'));
    assert.ok(!protect.some((dir) => dir.includes('relative')));

    const policy = extractionPolicy({
      projectRoot: root,
      rustProject: crate,
      outputDir: path.join(directory, 'out'),
      privateTmp: path.join(directory, 'tmp'),
      protect,
    });
    const allowAt = policy.indexOf('(allow file-write*');
    const denyAt = policy.lastIndexOf('(deny file-write*');
    assert.ok(policy.indexOf('(deny network*)') < allowAt);
    assert.ok(policy.indexOf('(deny file-write*)') < allowAt);
    assert.ok(allowAt < denyAt, 'tool-home denials must follow the allowances');
    for (const allowed of [
      `(subpath "${root}/.lake")`,
      `(subpath "${root}/.verilib")`,
      `(subpath "${root}/target")`,
      `(subpath "${crate}/target")`,
      `(subpath "${crate}/data")`,
      `(literal "${crate}/index.scip")`,
      `(subpath "${directory}/out")`,
      `(subpath "${directory}/tmp")`,
    ]) assert.ok(policy.slice(allowAt, denyAt).includes(allowed), allowed);
    assert.ok(policy.includes(`(regex #"^${root.replace(/\./g, '\\.')}/target${'[A-Za-z0-9]'.repeat(6)}(/.*)?$")`));
    for (const dir of protect) assert.ok(policy.slice(denyAt).includes(`(subpath "${dir}")`), dir);
    assert.throws(() => extractionPolicy({
      projectRoot: path.join(directory, 'bad"quote'), rustProject: crate, outputDir: directory, privateTmp: directory, protect,
    }), /cannot be used in a sandbox profile/);
  });

  it('runs only a verified probe, by absolute path, inside the generated sandbox', { skip: !ON_TESTED_HOST && 'requires macOS arm64 sandbox-exec' }, () => {
    const directory = fs.realpathSync(temporaryDirectory());
    const env = toolEnvironment(directory);
    const project = tupleProject(directory);
    installStubHelpers(env);
    const probe = stubProbe(directory);
    const out = path.join(directory, 'out');
    fs.mkdirSync(out);
    const output = path.join(out, 'extract.json');

    const ok = cli(['run', '--project-root', project, '--probe', probe, '--output', output], env.env);
    assert.equal(ok.status, 0, ok.stderr);
    const projected = cli([output, '--project-root', project, '--format', 'count'], env.env);
    assert.equal(projected.stdout.trim(), '2', projected.stderr);
    assert.equal(fs.readFileSync(path.join(project, '.verilib', 'allowed.txt'), 'utf8'), 'ok\n');
    assert.ok(fs.existsSync(path.join(project, 'crate', 'target')));
    assert.ok(fs.existsSync(path.join(project, 'targetAbC123')));
    for (const denied of [
      path.join(env.home, '.probe-rust'),
      path.join(env.home, '.cargo', 'bin', 'injected'),
      path.join(project, 'forbidden.txt'),
      path.join(directory, 'probe', 'injected'),
    ]) assert.ok(!fs.existsSync(denied), `${denied} must be denied`);
    const tmpdir = fs.readFileSync(path.join(project, '.verilib', 'tmpdir.txt'), 'utf8').trim();
    assert.match(tmpdir, /fvs-probe-run-/);
    assert.ok(!fs.existsSync(tmpdir), 'the private tmp is removed');

    const failed = cli(['run', '--project-root', project, '--probe', probe, '--output', output],
      { ...env.env, STUB_FAIL: '1' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /no output was accepted/);
    assert.ok(!fs.existsSync(output), 'partial output must be removed');

    fs.rmSync(path.join(out, 'invoked'));
    fs.rmSync(path.join(env.bin, 'scip'));
    const refused = cli(['run', '--project-root', project, '--probe', probe, '--output', output], env.env);
    assert.equal(refused.status, 3);
    assert.match(refused.stderr, /scip missing/);
    assert.ok(!fs.existsSync(path.join(out, 'invoked')), 'an unverified probe is never spawned');
    assert.ok(!fs.existsSync(output));
  });
});

describe('consented probe-aeneas installer', () => {
  const bsdtar = { skip: !HAS_BSDTAR && 'requires bsdtar (the installer runs on macOS only)' };

  it('stages, verifies and atomically selects the pinned executable with an audit', bsdtar, async () => {
    const { installProbe } = await loadSetup();
    const directory = temporaryDirectory();
    const archive = writeArchive(directory, 'good', stubArchive(goodEntries()), { xz: true });
    const release = stubRelease(fs.readFileSync(archive));
    const toolsRoot = path.join(directory, 'tools');
    const provenance = { tuple: 'stub' };

    const installed = await installProbe({ toolsRoot, target: 'stub-target', release, archive, decision: 'interactive', provenance });
    const destination = path.join(toolsRoot, 'probe-aeneas', '9.9.9-stub-target');
    assert.equal(installed.outcome, 'installed');
    assert.equal(installed.executable, path.join(destination, 'probe-aeneas'));
    assert.deepEqual(fs.readFileSync(installed.executable), STUB_EXECUTABLE);
    assert.deepEqual(fs.readdirSync(destination).sort(), ['INSTALL.json', 'probe-aeneas']);
    assert.deepEqual(stagingLeftovers(toolsRoot), []);
    const [audit] = auditLines(toolsRoot);
    for (const key of ['url', 'tagCommit', 'expectedArchiveSha256', 'actualArchiveSha256',
      'expectedExecutableSha256', 'actualExecutableSha256', 'provenance', 'platform', 'decision',
      'destination', 'outcome']) assert.ok(key in audit, key);
    assert.equal(audit.actualArchiveSha256, audit.expectedArchiveSha256);
    assert.equal(audit.versionOutput, 'probe-aeneas 9.9.9');
    assert.deepEqual(audit.provenance, provenance);
    assert.equal(JSON.parse(fs.readFileSync(path.join(destination, 'INSTALL.json'), 'utf8')).outcome, 'installed');

    const mtime = fs.statSync(installed.executable).mtimeMs;
    const again = await installProbe({ toolsRoot, target: 'stub-target', release, archive, decision: 'policy' });
    assert.equal(again.outcome, 'already-installed');
    assert.equal(fs.statSync(installed.executable).mtimeMs, mtime);

    fs.writeFileSync(installed.executable, '#!/bin/sh\necho tampered\n');
    await assert.rejects(installProbe({ toolsRoot, target: 'stub-target', release, archive, decision: 'interactive' }),
      /destination exists with unverified content/);
    assert.equal(fs.readFileSync(installed.executable, 'utf8'), '#!/bin/sh\necho tampered\n');
  });

  it('leaves nothing selected on every archive, digest or version fault', bsdtar, async () => {
    const { installProbe } = await loadSetup();
    const good = goodEntries();
    const wrongVersion = Buffer.from('#!/bin/sh\necho "probe-aeneas 9.9.8"\n');
    const failing = Buffer.from('#!/bin/sh\nexit 7\n');
    const cases = [
      ['wrong compressed digest', stubArchive(good), { archiveSha256: '0'.repeat(64) }, /archive SHA-256 does not match/],
      ['symlink member', stubArchive([...good, tarEntry('probe-aeneas-stub/link', { type: '2', linkname: 'probe-aeneas' })]), {}, /not a regular file/],
      ['hardlink member', stubArchive([...good, tarEntry('probe-aeneas-stub/hard', { type: '1', linkname: 'probe-aeneas-stub/probe-aeneas' })]), {}, /not a regular file/],
      ['fifo member', stubArchive([...good, tarEntry('probe-aeneas-stub/fifo', { type: '6' })]), {}, /not a regular file/],
      ['traversal member', stubArchive([...good, tarEntry('../evil', { body: Buffer.from('x') })]), {}, /escapes the archive root/],
      ['pax traversal member', stubArchive([...good, paxPath('probe-aeneas-stub/../../evil'), tarEntry('probe-aeneas-stub/ok', { body: Buffer.from('x') })]), {}, /escapes the archive root/],
      ['duplicate member', stubArchive([...good, tarEntry('probe-aeneas-stub/probe-aeneas', { body: Buffer.from('#!/bin/sh\n') })]), {}, /duplicated/],
      ['unexpected member', stubArchive([...good, tarEntry('probe-aeneas-stub/extra', { body: Buffer.from('x') })]), {}, /unexpected/],
      ['missing executable', stubArchive([good[0], good[2]]), {}, /has no probe-aeneas-stub\/probe-aeneas/],
      ['wrong executable digest', stubArchive(good), { executableSha256: '1'.repeat(64) }, /executable SHA-256 does not match/],
      ['wrong version', stubArchive(goodEntries(wrongVersion)), { executableSha256: sha256(wrongVersion) }, /reports "probe-aeneas 9\.9\.8"/],
      ['failing executable', stubArchive(goodEntries(failing)), { executableSha256: sha256(failing) }, /staged executable reports/],
    ];
    for (const [label, raw, overrides, error] of cases) {
      const directory = temporaryDirectory();
      const archive = writeArchive(directory, 'fault', raw);
      const bytes = fs.readFileSync(archive);
      const release = stubRelease(bytes, overrides);
      const toolsRoot = path.join(directory, 'tools');
      await assert.rejects(installProbe({ toolsRoot, target: 'stub-target', release, archive, decision: 'interactive' }), error, label);
      assert.ok(!fs.existsSync(path.join(toolsRoot, 'probe-aeneas', '9.9.9-stub-target')), label);
      assert.deepEqual(stagingLeftovers(toolsRoot), [], label);
      const audit = auditLines(toolsRoot);
      assert.equal(audit.length, 1, label);
      assert.match(audit[0].outcome, /^failed: /, label);
    }
  });

  it('bounds downloads and requires HTTPS without touching the network', async () => {
    const { installProbe } = await loadSetup();
    const release = stubRelease(Buffer.from('x'));
    const redirect = (location) => ({ status: 302, headers: new Map([['location', location]]) });
    const cases = [
      [async () => redirect('http://example.invalid/plain'), /non-HTTPS/],
      [async () => redirect('https://example.invalid/again'), /too many redirects/],
      [async () => ({ status: 200, headers: new Map([['content-length', String(64 * 1024 * 1024)]]), body: [] }), /size limit/],
      [async () => ({ status: 404, headers: new Map() }), /HTTP 404/],
    ];
    for (const [fetchImpl, error] of cases) {
      const toolsRoot = path.join(temporaryDirectory(), 'tools');
      await assert.rejects(installProbe({ toolsRoot, target: 'stub-target', release, decision: 'interactive', fetchImpl }), error);
      assert.deepEqual(stagingLeftovers(toolsRoot), []);
      assert.match(auditLines(toolsRoot)[0].outcome, /^failed: /);
    }
  });

  it('never installs without explicit consent or on an unsupported target', async () => {
    const { installProbe } = await loadSetup();
    const toolsRoot = path.join(temporaryDirectory(), 'tools');
    const release = stubRelease(Buffer.from('x'));
    await assert.rejects(installProbe({ toolsRoot, target: 'stub-target', release, decision: undefined }), /explicit consent/);
    await assert.rejects(installProbe({ toolsRoot, target: 'x86_64-pc-windows-msvc', decision: 'interactive' }), /not installable/);
    assert.ok(!fs.existsSync(toolsRoot));

    const directory = temporaryDirectory();
    const env = toolEnvironment(directory);
    const project = tupleProject(directory);
    const noConsent = cli(['install', '--project-root', project], env.env);
    assert.equal(noConsent.status, 3);
    const policyWithoutOptIn = cli(['install', '--project-root', project, '--consent', 'policy'], env.env);
    assert.notEqual(policyWithoutOptIn.status, 0);
    if (ON_TESTED_HOST) {
      assert.match(JSON.parse(noConsent.stdout).choices.join(' '), /install show-manual-instructions cancel/);
      assert.match(policyWithoutOptIn.stderr, /FVS_PROBE_INSTALL_POLICY=install/);
    }
    assert.ok(!fs.existsSync(env.toolsHome), 'declined or unapproved installs write nothing');
  });
});

describe('verified-or-exploratory routing at every probe entry point', () => {
  const files = Object.fromEntries(ENTRY_POINTS.map((file) => [file, fs.readFileSync(path.join(ROOT, file), 'utf8')]));
  const reference = files['commands/fvs/map-code.md'];

  for (const [file, content] of Object.entries(files)) {
    it(`${file} classifies the probe first and never uses PATH-only extraction`, () => {
      const mode = bashBlock(content, 'fvs:probe-mode');
      const noninteractive = bashBlock(content, 'fvs:probe-mode-noninteractive');
      assert.ok(mode && noninteractive, 'probe mode blocks missing');
      assert.equal(mode, bashBlock(reference, 'fvs:probe-mode'));
      assert.equal(noninteractive, bashBlock(reference, 'fvs:probe-mode-noninteractive'));
      const decision = content.indexOf('# fvs:probe-mode\n');
      for (const later of ['subagent_type=', 'Task(', 'run --project-root', 'mkdir -p .formalising', 'lake exe cache get',
        '--update-codemap', '--check-codemap']) {
        const at = content.indexOf(later);
        if (at >= 0) assert.ok(decision < at, `${later} precedes the probe decision`);
      }
      for (const status of ['verified', 'missing', 'incompatible', 'unknown', 'unsupported-platform']) {
        assert.ok(content.includes(`\`${status}\``), status);
      }
      assert.match(content, /\*\*Set up the verified probe\.\*\*/);
      assert.match(content, /\*\*Continue without graph\.\*\*/);
      assert.match(content, /\*\*Cancel\.\*\*/);
      assert.match(content, /--consent interactive/);
      assert.match(content, /install --project-root "\$PROJECT_ROOT" --manifest/);
      assert.match(content, /never installs a helper/);
      assert.match(content, /FVS_ALLOW_EXPLORATORY=1/);
      assert.match(content, /FVS_PROBE_INSTALL_POLICY=install/);
      assert.match(content, /never writes the managed CODEMAP block/);
      assert.ok(!/command -v probe-aeneas/.test(content));
      assert.ok(!/^\s*probe-aeneas extract\b/m.test(content));
      assert.ok(!/(?:^|[;&|(]\s*)probe-aeneas extract "\$PROJECT_ROOT"/m.test(content));
    });
  }

  it('keeps the exploratory branches free of generated facts', () => {
    for (const file of ['commands/fvs/map-code.md', 'fv-skills/workflows/map-code.md']) {
      assert.match(files[file], /CODEMAP-exploratory\.md/);
      assert.match(files[file], /never creates or modifies\s+`\.formalising\/CODEMAP\.md`/);
    }
    for (const file of ['commands/fvs/fc-plan.md', 'fv-skills/workflows/fc-plan.md']) {
      assert.match(files[file], /PLAN-exploratory\.md/);
      assert.ok(bashBlock(files[file], 'fvs:exploratory-codemap'), file);
      assert.match(files[file], /leaves\s+`\.formalising\/CODEMAP\.md`\s+and\s+`\.formalising\/PLAN\.md`\s+unchanged/);
    }
    for (const file of ['commands/fvs/trust-audit.md', 'fv-skills/workflows/trust-audit.md']) {
      const content = files[file];
      assert.match(content, /Verdict:\s+none \(exploratory/);
      assert.match(content, /skips Steps 1a\s+through\s+6/);
      const decision = content.indexOf('# fvs:probe-mode\n');
      const cache = content.indexOf('lake exe cache get');
      const build = content.indexOf('nice -n 19 lake build 2>&1');
      const extract = content.indexOf('run --project-root');
      const axioms = content.indexOf('#print axioms', extract);
      assert.ok(decision < cache && cache < build && build < extract && extract < axioms,
        `${file}: probe decision, cache, build, extraction, then #print axioms`);
    }
  });

  it('strips a stale managed block from exploratory fc-plan context without editing CODEMAP', () => {
    const directory = temporaryDirectory();
    fs.mkdirSync(path.join(directory, '.formalising'));
    const codemap = '# CODEMAP\n\n<!-- fvs:probe-inventory:start -->\nFunction count: **279**\n<!-- fvs:probe-inventory:end -->\n\n## Notes\nkeep\n';
    fs.writeFileSync(path.join(directory, '.formalising', 'CODEMAP.md'), codemap);
    for (const file of ['commands/fvs/fc-plan.md', 'fv-skills/workflows/fc-plan.md']) {
      const block = bashBlock(files[file], 'fvs:exploratory-codemap');
      const result = spawnSync('bash', ['-c', `${block}\nprintf '%s' "$CODEMAP_NOTES"`], { cwd: directory, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(!result.stdout.includes('279'));
      assert.ok(!result.stdout.includes('fvs:probe-inventory'));
      assert.match(result.stdout, /## Notes\nkeep/);
      assert.equal(fs.readFileSync(path.join(directory, '.formalising', 'CODEMAP.md'), 'utf8'), codemap);
    }
  });

  function routeIn(project, extraEnv, directory, home = path.join(directory, 'route-home')) {
    fs.mkdirSync(path.join(home, '.claude', 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(home, '.claude', 'scripts', 'fvs-probe-inventory.mjs'));
    const script = [
      bashBlock(reference, 'fvs:probe-mode'),
      bashBlock(reference, 'fvs:probe-mode-noninteractive'),
      'echo "FVS_MODE=$FVS_MODE"',
    ].join('\n');
    return spawnSync('bash', ['-c', script], {
      cwd: project,
      encoding: 'utf8',
      env: { HOME: home, PATH: [path.join(directory, 'bin'), NODE_DIR, '/usr/bin', '/bin'].join(':'), FVS_TOOLS_HOME: path.join(directory, 'fvs-tools'), ...extraEnv },
    });
  }

  it('offers the choice before cache or build can fail and needs explicit noninteractive opt-ins', () => {
    const directory = temporaryDirectory();
    const project = path.join(directory, 'not-built');
    fs.mkdirSync(project);

    const blocked = routeIn(project, {}, directory);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stdout, /Choices: setup \/ continue-without-graph \/ cancel/);
    assert.match(blocked.stderr, /set FVS_ALLOW_EXPLORATORY=1/);
    assert.ok(!/run from the Lean project root|cache preflight/.test(blocked.stdout + blocked.stderr));

    const installOnly = routeIn(project, { FVS_PROBE_INSTALL_POLICY: 'install' }, directory);
    assert.equal(installOnly.status, 1, 'an install policy is not an exploratory opt-in');
    assert.ok(!fs.existsSync(path.join(directory, 'fvs-tools')));

    const exploratory = routeIn(project, { FVS_ALLOW_EXPLORATORY: '1' }, directory);
    assert.equal(exploratory.status, 0, exploratory.stderr);
    assert.match(exploratory.stdout, /FVS_MODE=exploratory/);
    assert.ok(!fs.existsSync(path.join(directory, 'fvs-tools')), 'exploratory never installs');
  });

  it('continues verified without prompting when the resolver verifies the project', { skip: !ON_TESTED_HOST && 'requires the supported macOS arm64 host' }, () => {
    const directory = temporaryDirectory();
    const env = toolEnvironment(directory);
    const project = tupleProject(directory);
    installStubHelpers(env);
    fs.copyFileSync(stubProbe(directory), path.join(env.bin, 'probe-aeneas'));
    fs.chmodSync(path.join(env.bin, 'probe-aeneas'), 0o755);
    const verified = routeIn(project, {}, directory, env.home);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /FVS >> probe-aeneas: verified/);
    assert.match(verified.stdout, /FVS_MODE=verified/);
  });
});

// Real end-to-end check against a provisioned consumer. Registered only with
// FVS_REAL_PROBE=1; in that mode missing environment or evidence fails.
if (process.env.FVS_REAL_PROBE === '1') {
  describe('real confined probe-aeneas extraction (FVS_REAL_PROBE=1)', () => {
    const consumer = process.env.FVS_CONSUMER_ROOT;
    const probe = process.env.FVS_PROBE_BIN;
    const receiptFile = process.env.FVS_ISOLATION_RECEIPT;
    const created = [];
    let setup;
    let receipt;
    let provenance;
    let before;

    function evidence() {
      for (const [name, value] of Object.entries({
        FVS_CONSUMER_ROOT: consumer, FVS_PROBE_BIN: probe, FVS_ISOLATION_RECEIPT: receiptFile,
      })) {
        assert.ok(value && path.isAbsolute(value) && fs.existsSync(value), `${name} must name an existing absolute path`);
      }
      return JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    }

    // path/size/mtime/mode of every entry under HOME and each protected
    // tool or bin directory of the disposable environment: any helper
    // install or cache write shows up here.
    function toolHomeSnapshot() {
      const home = fs.realpathSync(os.homedir());
      const disposable = `${path.dirname(home)}/`;
      const roots = [home, ...setup.protectedDirs(probe)
        .filter((dir) => dir.startsWith(disposable) && !dir.startsWith(`${home}/`))];
      const lines = [];
      const walk = (entry) => {
        let stat;
        try {
          stat = fs.lstatSync(entry);
        } catch {
          return;
        }
        lines.push(`${entry} ${stat.size} ${stat.mtimeMs} ${stat.mode}`);
        if (!stat.isDirectory()) return;
        let children = [];
        try {
          children = fs.readdirSync(entry).sort();
        } catch (error) {
          lines.push(`${entry} unreadable ${error.code}`);
        }
        for (const child of children) walk(path.join(entry, child));
      };
      for (const root of roots) walk(root);
      return lines;
    }

    function consumerStatus() {
      return spawnSync('git', ['-C', consumer, 'status', '--porcelain=v1'], { encoding: 'utf8' }).stdout;
    }

    function realOut(name) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), `fvs-real-${name}-`));
      created.push(directory);
      return path.join(fs.realpathSync(directory), 'extract.json');
    }

    function buildOutputs() {
      const crate = provenance.rustProject;
      return [
        path.join(consumer, '.verilib'),
        path.join(consumer, 'target'),
        path.join(consumer, '.lake', 'probe-lean'),
        path.join(crate, 'target'),
        path.join(crate, 'data'),
        path.join(crate, 'index.scip'),
      ];
    }

    let preexisting = new Set();
    after(() => {
      if (provenance) {
        for (const file of buildOutputs()) if (!preexisting.has(file)) fs.rmSync(file, { recursive: true, force: true });
      }
      for (const directory of created) fs.rmSync(directory, { recursive: true, force: true });
    });

    it('has the provisioned consumer, the pinned probe and a passing receipt on this host', async () => {
      assert.ok(ON_TESTED_HOST, 'real mode requires macOS arm64 with sandbox-exec');
      receipt = evidence();
      setup = await loadSetup();
      assert.equal(setup.hostTarget(), TESTED_TARGET);
      assert.equal(receipt.verdict, 'PASS');
      assert.equal(receipt.platform.rust_target, TESTED_TARGET);
      const head = spawnSync('git', ['-C', consumer, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
      assert.equal(head, receipt.consumer.commit);
      assert.equal(head, fixture().receipts[TESTED_TARGET].consumer.commit);
      const digest = sha256(fs.readFileSync(probe));
      assert.equal(digest, fixture().release.assets[TESTED_TARGET].executableSha256);
      assert.equal(digest, receipt.probe_aeneas.executable_sha256);
      provenance = setup.readProvenance(fs.realpathSync(consumer));
      assert.deepEqual(provenance.problems, []);
      assert.equal(provenance.translationSha256, receipt.consumer.translation_json_sha256);
      preexisting = new Set(buildOutputs().filter((file) => fs.existsSync(file)));
      assert.equal(consumerStatus(), '', 'the consumer checkout must start clean');
    });

    it('enforces the generated policy on this host', () => {
      const out = path.dirname(realOut('policy'));
      const privateTmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-real-policy-tmp-')));
      created.push(privateTmp);
      const policy = setup.extractionPolicy({
        projectRoot: provenance.projectRoot,
        rustProject: provenance.rustProject,
        outputDir: out,
        privateTmp,
        protect: setup.protectedDirs(probe),
      });
      const sandboxed = (command) => spawnSync('/usr/bin/sandbox-exec', ['-p', policy, '/bin/sh', '-c', command], { encoding: 'utf8' });
      const home = os.homedir();
      const denied = [
        path.join(home, '.cargo', 'bin', 'fvs-policy-probe'),
        path.join(home, '.probe-rust'),
        path.join(process.env.RUSTUP_HOME || path.join(home, '.rustup'), 'fvs-policy-probe'),
        path.join(process.env.ELAN_HOME || path.join(home, '.elan'), 'bin', 'fvs-policy-probe'),
        path.join(home, '.local', 'bin', 'fvs-policy-probe'),
        path.join(home, '.local', 'lib', 'fvs-policy-probe'),
        path.join(path.dirname(probe), 'fvs-policy-probe'),
        path.join(consumer, 'fvs-policy-probe'),
        path.join(consumer, 'targetX'),
        path.join(consumer, 'targetAbC1234'),
        ...(process.env.PATH || '').split(':').filter((dir) => dir.startsWith(`${path.dirname(home)}/`))
          .map((dir) => path.join(dir, 'fvs-policy-probe')),
      ];
      for (const file of denied) {
        const result = sandboxed(`mkdir "${file}"`);
        const leaked = fs.existsSync(file);
        if (leaked && !preexisting.has(file)) fs.rmSync(file, { recursive: true, force: true });
        assert.ok(result.status !== 0 && !leaked, `write to ${file} must be denied`);
      }
      const network = sandboxed('/usr/bin/curl -sS --max-time 5 -o /dev/null https://1.1.1.1/');
      assert.notEqual(network.status, 0, 'network must be denied');
      for (const file of [path.join(out, 'allowed'), path.join(privateTmp, 'allowed'), path.join(consumer, 'targetAbC123')]) {
        const result = sandboxed(`mkdir "${file}"`);
        assert.equal(result.status, 0, `${file}: ${result.stderr}`);
        fs.rmSync(file, { recursive: true, force: true });
      }
      assert.equal(consumerStatus(), '');
    });

    it('extracts the pinned consumer through the FVS confined run with a real def_id join', () => {
      before = toolHomeSnapshot();
      const resolved = resolveJson(consumer, process.env, ['--probe', probe]);
      assert.equal(resolved.status, 'verified', resolved.reasons.join('\n'));
      assert.equal(resolved.tuple, testedTuple().id);

      const output = realOut('positive');
      const run = cli(['run', '--project-root', consumer, '--probe', probe, '--output', output], process.env);
      assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
      const extract = JSON.parse(fs.readFileSync(output, 'utf8'));
      assert.equal(extract.schema, 'probe-aeneas/extract');
      assert.equal(extract['schema-version'], '3.0');
      assert.equal(extract.tool.version, '0.20.0');

      const count = cli([output, '--project-root', consumer, '--format', 'count'], process.env);
      assert.equal(count.status, 0, count.stderr);
      const observed = fixture().receipts[TESTED_TARGET].observed.positive;
      assert.equal(Number(count.stdout.trim()), observed.canonicalCount);
      const inventory = JSON.parse(cli([output, '--project-root', consumer, '--format', 'json'], process.env).stdout);
      assert.equal(inventory.count, observed.canonicalCount);

      const translation = JSON.parse(fs.readFileSync(provenance.translationJson, 'utf8'));
      const byDefId = new Map(translation.functions.map((item) => [item.def_id, item]));
      let joins = 0;
      for (const item of inventory.functions) {
        const defId = extract.data[item.id]['charon-def-id'];
        if (defId === undefined) continue;
        const record = byDefId.get(defId);
        assert.ok(record, `${item.id} def_id ${defId} is absent from translation.json`);
        assert.equal(record.lean_name, item.leanFqn, item.id);
        joins += 1;
      }
      assert.ok(joins >= 1);
      assert.equal(joins, observed.defIdJoins);

      assert.deepEqual(toolHomeSnapshot(), before, 'tool homes must be unchanged');
      assert.ok(!fs.existsSync(path.join(os.homedir(), '.probe-rust')));
      assert.ok(!consumerStatus().split('\n').some((line) => line && !line.startsWith('??')),
        'no tracked consumer file may change');
    });

    it('denies a missing helper without installing it or accepting output', () => {
      const scip = spawnSync('/bin/sh', ['-c', 'command -v scip'], { encoding: 'utf8' }).stdout.trim();
      assert.ok(scip, 'scip must be provisioned on PATH for this check');
      const scipDir = path.dirname(fs.realpathSync(scip));
      assert.ok(scipDir.startsWith(path.dirname(fs.realpathSync(os.homedir()))),
        'scip is hidden by PATH only, so it must live in a disposable directory');
      assert.ok(!fs.existsSync(path.join(os.homedir(), '.probe-rust', 'tools', 'scip')));
      const hiddenPath = process.env.PATH.split(':').filter((dir) => {
        try {
          return fs.realpathSync(dir) !== scipDir;
        } catch {
          return true;
        }
      }).join(':');
      const hidden = { ...process.env, PATH: hiddenPath };

      const resolved = resolveJson(consumer, hidden, ['--probe', probe]);
      assert.equal(resolved.status, 'missing');
      assert.equal(resolved.helpers.scip.status, 'missing');
      assert.equal(resolved.install.available, false);
      const refusedOutput = realOut('refused');
      const refused = cli(['run', '--project-root', consumer, '--probe', probe, '--output', refusedOutput], hidden);
      assert.equal(refused.status, 3);
      assert.ok(!fs.existsSync(refusedOutput));

      // Bypass the preflight to show the sandbox itself stops upstream's
      // auto-install: clear the SCIP cache so probe-rust needs scip.
      for (const file of [path.join(provenance.rustProject, 'data'), path.join(provenance.rustProject, 'index.scip'),
        path.join(consumer, '.verilib')]) {
        if (!preexisting.has(file)) fs.rmSync(file, { recursive: true, force: true });
      }
      const deniedOutput = realOut('denied');
      const savedPath = process.env.PATH;
      let run;
      try {
        process.env.PATH = hiddenPath;
        run = setup.confinedExtract({
          probePath: probe,
          projectRoot: provenance.projectRoot,
          rustProject: provenance.rustProject,
          output: deniedOutput,
          stdio: 'pipe',
        });
      } finally {
        process.env.PATH = savedPath;
      }
      assert.equal(run.ok, false);
      assert.match(run.log, /scip not found/);
      assert.ok(!fs.existsSync(deniedOutput), 'no merged output may be accepted');
      assert.ok(!fs.existsSync(path.join(os.homedir(), '.probe-rust')), 'scip must not be installed');
      assert.deepEqual(toolHomeSnapshot(), before, 'tool homes must be unchanged');
    });

    it('installs the pinned official archive side by side and resolves it by absolute path', () => {
      const asset = fixture().release.assets[TESTED_TARGET];
      const archive = process.env.FVS_PROBE_ARCHIVE || path.join(receipt.disposable_root, 'dl', asset.asset);
      assert.ok(fs.existsSync(archive), `official archive not found at ${archive} (set FVS_PROBE_ARCHIVE)`);
      const toolsHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-real-tools-'));
      created.push(toolsHome);
      const env = { ...process.env, FVS_TOOLS_HOME: toolsHome };
      const installed = cli(['install', '--project-root', consumer, '--consent', 'interactive', '--archive', archive], env);
      assert.equal(installed.status, 0, installed.stderr);
      const record = JSON.parse(installed.stdout);
      assert.equal(record.outcome, 'installed');
      assert.equal(record.actualArchiveSha256, asset.archiveSha256);
      assert.equal(record.actualExecutableSha256, asset.executableSha256);
      const resolved = resolveJson(consumer, env);
      assert.equal(resolved.status, 'verified', resolved.reasons.join('\n'));
      assert.equal(resolved.probe.source, 'fvs-managed');
      assert.equal(resolved.probe.official, true);
      assert.equal(resolved.probe.path, fs.realpathSync(record.executable));
    });
  });
}
