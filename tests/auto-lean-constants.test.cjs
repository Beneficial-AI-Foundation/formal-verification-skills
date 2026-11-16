'use strict';

// Fixture tests only: nothing here runs Lean or Lake. A fake `lake` answers the
// build, the discovery program and the extractor, so these cases check the
// producer's own bookkeeping and refusals; the published record and receipt are
// checked with the graph step's own validators.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'fvs-lean-constants.mjs');
const QUALIFIED = path.join(__dirname, 'helpers', 'lean-witness-capture', 'qualified');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
// A .ilean the graph step reads: the module name, its decls and its references map.
const ilean = (module, fields = { decls: {}, references: {} }) => JSON.stringify({ module, ...fields });

const FAKE_LAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const env = process.env;
if (args.includes('build')) {
  if (env.FAKE_EXTRA_OLEAN) fs.writeFileSync(path.join(process.cwd(), '.lake/build/lib/lean/Other.olean'), 'stale');
  if (env.FAKE_BUILD_EDIT) fs.appendFileSync(path.join(process.cwd(), 'Demo.lean'), '-- edited by the build');
  if (env.FAKE_BUILD_MANIFEST) fs.writeFileSync(path.join(process.cwd(), 'lake-manifest.json'), '{"version": "1.1.0", "packages": []}');
  if (env.FAKE_ILEAN) fs.writeFileSync(path.join(process.cwd(), '.lake/build/lib/lean/Demo/Sub.ilean'), env.FAKE_ILEAN);
  // A module named with + is built by name, as Lake does for one the roots do not import.
  const named = args.filter((arg) => arg.startsWith('+'));
  if (named.length > 0) {
    if (env.FAKE_MODULE_BUILD_EXIT) process.exit(Number(env.FAKE_MODULE_BUILD_EXIT));
    for (const arg of named) {
      const base = path.join(process.cwd(), '.lake/build/lib/lean', arg.slice(1).replaceAll('.', '/'));
      fs.writeFileSync(base + '.olean', arg + ' olean');
      fs.writeFileSync(base + '.ilean', JSON.stringify({ module: arg.slice(1), decls: {}, references: {} }));
    }
  }
  process.exit(Number(env.FAKE_BUILD_EXIT || 0));
}
const file = args[args.length - 1];
const olean = (root, module) => path.join(root, module.replaceAll('.', '/') + '.olean');
const build = path.join(process.cwd(), '.lake/build/lib/lean');
const rows = [
  { module: 'Init', olean: olean(env.FAKE_TOOLCHAIN_LIB, 'Init'), parts: [''] },
  { module: 'Demo', olean: olean(build, 'Demo'), parts: [''] },
  { module: 'Demo.Sub', olean: olean(build, 'Demo.Sub'), parts: [''] },
];
// Demo imports Demo.Sub; any other module the file imports is loaded only if it was compiled.
for (const line of fs.readFileSync(file, 'utf8').split('\\n')) {
  const module = /^import (\\S+)$/.exec(line)?.[1];
  if (!module || rows.some((row) => row.module === module)) continue;
  if (!fs.existsSync(olean(build, module))) { console.error('unknown module ' + module); process.exit(1); }
  rows.push({ module, olean: olean(build, module), parts: [''] });
}
if (path.basename(file).startsWith('Discover')) {
  console.log('info: discovery');
  console.log(JSON.stringify(rows));
  process.exit(0);
}
const body = {
  nodes: [{ name: 'Demo.x', module: 'Demo', kind: 'def', hasDeclarationRange: true, isStructure: false, isProjection: false,
    isClass: false, isInstance: false, type: ['Nat'], value: ['Nat.succ'], axioms: [] }],
  referenced: [{ name: 'Nat', module: 'Init' }, { name: 'Nat.succ', module: 'Init' }],
  moduleNames: env.FAKE_MODULES ? env.FAKE_MODULES.split(',') : rows.map((row) => row.module),
};
console.log(JSON.stringify(body));
if (env.FAKE_TWO_LINES) console.log(JSON.stringify(body));
if (env.FAKE_INVENTORY_CHANGE) fs.appendFileSync(rows[0].olean, 'changed');
if (env.FAKE_INPUT_CHANGE) fs.appendFileSync(path.join(process.cwd(), 'Demo.lean'), '-- edited');
process.exit(Number(env.FAKE_ORACLE_EXIT || 0));
`;

let tmp;
let project;
let lake;
let toolchainLib;
let counter = 0;

function freshProject(env = {}) {
  project = fs.mkdtempSync(path.join(tmp, 'project-'));
  fs.writeFileSync(path.join(project, 'lean-toolchain'), 'leanprover/lean4:v4.35.0\n');
  fs.writeFileSync(path.join(project, 'Demo.lean'), 'def x := Nat.succ 0\n');
  fs.mkdirSync(path.join(project, '.lake/build/lib/lean'), { recursive: true });
  fs.writeFileSync(path.join(project, '.lake/build/lib/lean/Demo.olean'), 'demo olean');
  fs.writeFileSync(path.join(project, '.lake/build/lib/lean/Demo.ilean'), ilean('Demo'));
  // A nested module the root imports, as an extraction inside a library is.
  fs.mkdirSync(path.join(project, 'Demo'));
  fs.writeFileSync(path.join(project, 'Demo/Sub.lean'), 'def z := 2\n');
  fs.mkdirSync(path.join(project, '.lake/build/lib/lean/Demo'));
  fs.writeFileSync(path.join(project, '.lake/build/lib/lean/Demo/Sub.olean'), 'sub olean');
  fs.writeFileSync(path.join(project, '.lake/build/lib/lean/Demo/Sub.ilean'), ilean('Demo.Sub'));
  fs.writeFileSync(path.join(toolchainLib, 'Init.olean'), 'init olean');
  if (env.FAKE_UNIMPORTED) fs.writeFileSync(path.join(project, 'Demo/Extra.lean'), 'def y := 1\n');
  if (env.FAKE_MANIFEST_PRESENT) fs.writeFileSync(path.join(project, 'lake-manifest.json'), '{"version": "1.1.0"}');
  if (env.FAKE_ODD_NAME) fs.writeFileSync(path.join(project, 'Demo/odd-name.lean'), 'def w := 3\n');
  return project;
}

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, FAKE_TOOLCHAIN_LIB: toolchainLib, ...env },
  });
}

const freshOut = () => path.join(tmp, `out-${counter++}`);
const produce = (env, roots = 'Demo') => {
  const out = freshOut();
  return { out, result: run(['run', '--project', freshProject(env), '--roots', roots, '--out', out, '--lake', lake], env) };
};

describe('fvs-lean-constants producer', () => {
  before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-lean-constants-')));
    const bin = path.join(tmp, 'toolchain', 'bin');
    toolchainLib = path.join(tmp, 'toolchain', 'lib', 'lean');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(toolchainLib, { recursive: true });
    lake = path.join(bin, 'lake');
    fs.writeFileSync(lake, FAKE_LAKE, { mode: 0o755 });
    // Answers only --print-prefix, as the toolchain's lean does.
    fs.writeFileSync(path.join(bin, 'lean'), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(path.join(tmp, 'toolchain'))});\n`, { mode: 0o755 });
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('publishes a record and receipt that pass the graph step\'s record, receipt and import checks', async () => {
    const { out, result } = produce();
    assert.equal(result.status, 0, result.stderr);
    const graph = await import(pathToFileURL(path.join(ROOT, 'scripts', 'fvs-lean-graph.mjs')).href);
    const recordText = fs.readFileSync(path.join(out, 'constants.json'), 'utf8');
    const record = JSON.parse(recordText);
    const receipt = JSON.parse(fs.readFileSync(path.join(out, 'constants-run.json'), 'utf8'));
    const importsText = fs.readFileSync(path.join(out, 'imports.json'), 'utf8');
    assert.deepEqual(graph.oracleShapeProblems(record), []);
    assert.deepEqual(graph.constantsRunProblems(receipt, recordText, record, project), []);
    const analysed = ['Demo', 'Demo.Sub'];
    assert.deepEqual(graph.compiledProblems(record.inputs.compiled, analysed, project), []);
    assert.deepEqual(graph.importProblems(importsText, record.inputs.imports, record.inputs.compiled, analysed, record.referenced), []);
    assert.equal(record.version, 2);
    assert.equal(record.producer.toolchain, 'leanprover/lean4:v4.35.0');
    assert.equal(record.producer.lakeSha256, sha256(fs.readFileSync(lake)));
    assert.equal(record.producer.harnessSha256, sha256(fs.readFileSync(SCRIPT)));
    assert.equal(sha256(fs.readFileSync(path.join(out, 'imports.json'))), record.inputs.imports.digest);
    assert.deepEqual([record.inputs.imports.modules, record.inputs.imports.files], [3, 3]);
    assert.deepEqual(Object.keys(record.inputs.compiled).sort(), ['.lake/build/lib/lean/Demo.olean', '.lake/build/lib/lean/Demo/Sub.olean']);
    assert.ok(Object.hasOwn(record.inputs.files, 'Demo.lean'));
    assert.equal(receipt.argv[4], path.join(out, 'work', 'LeanConstants.lean'));
    for (const log of ['01-build', '02-discover-before', '03-constants', '04-discover-after']) assert.ok(fs.existsSync(path.join(out, `${log}.log`)));
  });

  it('embeds the qualified extractor and discovery programs, differing only in imports and roots', async () => {
    const { extractorSource, discoverySource } = await import(pathToFileURL(SCRIPT).href);
    const qualified = (file) => fs.readFileSync(path.join(QUALIFIED, file), 'utf8');
    assert.equal(extractorSource(['M1demo', 'Specs']), qualified('LeanConstantsV3.lean'));
    assert.equal(discoverySource(['M1demo', 'Specs']), qualified('Discover.lean'));
  });

  const refusals = [
    ['a root that is not a plain top-level name', {}, 'Demo.Sub', /--roots must be/],
    ['a failing build', { FAKE_BUILD_EXIT: '1' }, 'Demo', /01-build exited 1/],
    ['a failing extractor', { FAKE_ORACLE_EXIT: '3' }, 'Demo', /03-constants exited 3/],
    ['two extractor outputs', { FAKE_TWO_LINES: '1' }, 'Demo', /printed 2 JSON values/],
    ['an import inventory that changes during the run', { FAKE_INVENTORY_CHANGE: '1' }, 'Demo', /import inventory changed/],
    ['a project file that changes during the run', { FAKE_INPUT_CHANGE: '1' }, 'Demo', /project files or compiled modules changed/],
    ['a project file the build changes', { FAKE_BUILD_EDIT: '1' }, 'Demo', /project files changed during the build \(only build outputs under \.lake may change\): Demo\.lean$/m],
    ['extractor module names that differ from discovery', { FAKE_MODULES: 'Init,Demo,Other' }, 'Demo', /module names differ/],
    ['a compiled file of a module outside the roots', { FAKE_EXTRA_OLEAN: '1' }, 'Demo', /unexpected \.lake\/build\/lib\/lean\/Other\.olean/],
    ['a lake-manifest.json the build changes', { FAKE_MANIFEST_PRESENT: '1', FAKE_BUILD_MANIFEST: '1' }, 'Demo', /project files changed during the build \(only build outputs under \.lake may change\): lake-manifest\.json$/m],
    ['a module the root does not import that fails to build by name', { FAKE_UNIMPORTED: '1', FAKE_MODULE_BUILD_EXIT: '1' }, 'Demo', /01b-build-modules exited 1/],
    ['a .ilean for another module', { FAKE_ILEAN: ilean('Demo.Other') }, 'Demo', /graph step would reject the \.ilean files: module Demo\.Sub has no matching \.lake\/build\/lib\/lean\/Demo\/Sub\.ilean/],
    ['a .ilean without decls', { FAKE_ILEAN: ilean('Demo.Sub', { references: {} }) }, 'Demo', /graph step would reject the \.ilean files: module Demo\.Sub has no matching/],
    ['a .ilean without a references map', { FAKE_ILEAN: ilean('Demo.Sub', { decls: {} }) }, 'Demo', /graph step would reject the \.ilean files: \.lake\/build\/lib\/lean\/Demo\/Sub\.ilean has no references map/],
    ['a module the root does not import whose name is not a plain identifier', { FAKE_ODD_NAME: '1' }, 'Demo', /do not import Demo\.odd-name: .*`import Demo\.odd-name` to Demo\.lean/],
  ];
  for (const [label, env, roots, message] of refusals) {
    it(`refuses ${label} and publishes nothing`, () => {
      const { out, result } = produce(env, roots);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, message);
      for (const file of ['constants.json', 'constants-run.json', 'imports.json']) assert.ok(!fs.existsSync(path.join(out, file)));
      // The layout check runs before the extractor starts.
      if (env.FAKE_UNIMPORTED || env.FAKE_ODD_NAME || env.FAKE_ILEAN) assert.ok(!fs.existsSync(path.join(out, '03-constants.log')));
    });
  }

  it('builds a project module the root does not import by name, records it and warns', async () => {
    const { out, result } = produce({ FAKE_UNIMPORTED: '1' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /^warning: the library roots do not import Demo\.Extra, so Lake built them by name .*`import Demo\.Extra` to Demo\.lean/m);
    for (const log of ['01a-discover-roots', '01b-build-modules']) assert.ok(fs.existsSync(path.join(out, `${log}.log`)));
    const graph = await import(pathToFileURL(path.join(ROOT, 'scripts', 'fvs-lean-graph.mjs')).href);
    const recordText = fs.readFileSync(path.join(out, 'constants.json'), 'utf8');
    const record = JSON.parse(recordText);
    const receipt = JSON.parse(fs.readFileSync(path.join(out, 'constants-run.json'), 'utf8'));
    const importsText = fs.readFileSync(path.join(out, 'imports.json'), 'utf8');
    const analysed = ['Demo', 'Demo.Extra', 'Demo.Sub'];
    assert.deepEqual(graph.oracleShapeProblems(record), []);
    assert.deepEqual(graph.constantsRunProblems(receipt, recordText, record, project), []);
    assert.deepEqual(graph.compiledProblems(record.inputs.compiled, analysed, project), []);
    assert.deepEqual(graph.importProblems(importsText, record.inputs.imports, record.inputs.compiled, analysed, record.referenced), []);
    assert.ok(Object.hasOwn(JSON.parse(importsText).modules, 'Demo.Extra'));
    assert.ok(Object.hasOwn(record.inputs.files, '.lake/build/lib/lean/Demo/Extra.ilean'), 'the record binds the by-name build\'s .ilean');
    assert.equal(receipt.warnings.length, 1);
    assert.match(receipt.warnings[0], /do not import Demo\.Extra/);
    // The work files import the module after the root; the roots-only discovery does not.
    assert.match(fs.readFileSync(path.join(out, 'work', 'LeanConstants.lean'), 'utf8'), /^import Demo\nimport Demo\.Extra\nopen Lean\n/);
    assert.match(fs.readFileSync(path.join(out, 'work', 'DiscoverRoots.lean'), 'utf8'), /^import Demo\nopen Lean\n/);
    assert.equal(record.producer.extractorSha256, sha256(fs.readFileSync(path.join(out, 'work', 'LeanConstants.lean'))));
  });

  it('lets Lake create lake-manifest.json on the first build, records its hash and warns', () => {
    const { out, result } = produce({ FAKE_BUILD_MANIFEST: '1' });
    assert.equal(result.status, 0, result.stderr);
    const hash = sha256(fs.readFileSync(path.join(project, 'lake-manifest.json')));
    assert.match(result.stderr, new RegExp(`^warning: Lake created lake-manifest\\.json during the build \\(sha256 ${hash}\\)$`, 'm'));
    const record = JSON.parse(fs.readFileSync(path.join(out, 'constants.json'), 'utf8'));
    const receipt = JSON.parse(fs.readFileSync(path.join(out, 'constants-run.json'), 'utf8'));
    assert.equal(record.inputs.files['lake-manifest.json'], hash, 'the record binds the created manifest');
    assert.deepEqual(receipt.warnings, [`Lake created lake-manifest.json during the build (sha256 ${hash})`]);
  });

  it('warns about nothing when the roots import every project module', () => {
    const { out, result } = produce();
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /warning/);
    assert.ok(!fs.existsSync(path.join(out, '01b-build-modules.log')));
    assert.ok(!Object.hasOwn(JSON.parse(fs.readFileSync(path.join(out, 'constants-run.json'), 'utf8')), 'warnings'));
  });

  it('accepts build outputs the build rewrites under .lake', () => {
    const rebuilt = `${ilean('Demo.Sub')} `;
    const { out, result } = produce({ FAKE_ILEAN: rebuilt });
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(fs.readFileSync(path.join(out, 'constants.json'), 'utf8'));
    assert.equal(record.inputs.files['.lake/build/lib/lean/Demo/Sub.ilean'], sha256(rebuilt), 'the record binds the built .ilean');
  });

  it('refuses an output directory that exists or lies inside the project', () => {
    const existing = freshOut();
    fs.mkdirSync(existing);
    const outside = run(['run', '--project', freshProject(), '--roots', 'Demo', '--out', existing, '--lake', lake]);
    assert.equal(outside.status, 1);
    assert.match(outside.stderr, /must be a new directory/);
    const inside = run(['run', '--project', freshProject(), '--roots', 'Demo', '--out', path.join(project, 'evidence'), '--lake', lake]);
    assert.equal(inside.status, 1);
    assert.match(inside.stderr, /outside the project/);
    assert.ok(!fs.existsSync(path.join(project, 'evidence')));
  });

  it('finds the toolchain beside the project\'s lean when no lake is given', () => {
    const out = freshOut();
    const result = run(['run', '--project', freshProject(), '--roots', 'Demo', '--out', out],
      { PATH: `${path.dirname(lake)}${path.delimiter}${process.env.PATH}` });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(fs.readFileSync(path.join(out, 'constants-run.json'), 'utf8'));
    assert.equal(receipt.argv[0], lake);
  });

  it('prints usage with exit 2 for a malformed call', () => {
    for (const args of [[], ['run', '--project'], ['run', '--bogus', 'x']]) assert.equal(run(args).status, 2);
  });
});
