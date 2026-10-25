'use strict';

const { before, after, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const TARGET = 'x86_64-pc-windows-msvc';

describe('Windows public integration with synthetic reviewed runtime', { skip: process.platform !== 'win32' || process.arch !== 'x64' }, () => {
  let directory, modules, api, control, source, crate, runtime, output;
  const tuple = { aeneasRev: '6e167c9b63a4dafd66d0e0edd9d94669f957ff7b', charonVersion: '0.1.225', leanToolchain: 'leanprover/lean4:v4.31.0' };
  const graph = JSON.stringify({ schema: 'probe-aeneas/extract', 'schema-version': '3.0',
    tool: { name: 'probe-aeneas', version: '0.20.0', command: 'extract' },
    inputs: [{ schema: 'probe-rust/extract', source: { package: 'crate' } }], timestamp: '2026-10-25T00:00:00Z',
    data: { 'probe:rust/f()': { 'display-name': 'crate::f', dependencies: [], 'code-module': 'crate', 'code-path': 'src/lib.rs',
      'code-text': { 'lines-start': 1, 'lines-end': 2 }, kind: 'exec', language: 'rust', 'rust-qualified-name': 'crate::f', 'is-relevant': true, untracked: false } } });
  const writeProject = () => {
    fs.writeFileSync(path.join(source, 'aeneas-config.yml'), `aeneas:\n  commit: ${tuple.aeneasRev}\ncrate:\n  dir: rust crate\naeneas_args:\n  dest: Crate\n`);
    fs.writeFileSync(path.join(source, 'lake-manifest.json'), JSON.stringify({ packages: [{ name: 'aeneas', rev: tuple.aeneasRev }] }));
    fs.writeFileSync(path.join(source, 'lean-toolchain'), tuple.leanToolchain + '\n');
    fs.writeFileSync(path.join(source, 'Crate', 'translation.json'), JSON.stringify({ aeneas_version: tuple.aeneasRev, charon_version: tuple.charonVersion }));
  };
  const resolve = () => api.resolveProbe({ projectRoot: source });
  const extract = (options = {}) => api.confinedExtract({ runtime, projectRoot: source, rustProject: crate, probePath: runtime.probePath, output, stdio: 'pipe', ...options });

  before(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs Windows integration '));
    modules = path.join(directory, 'modules'); fs.mkdirSync(modules);
    // Only the test copy receives synthetic siblings and qualified metadata.
    // The shipped module has no environment flag or caller policy bypass.
    for (const name of ['fvs-probe-inventory.mjs', 'fvs-probe-linux.mjs', 'fvs-probe-windows.mjs']) fs.copyFileSync(path.join(ROOT, 'scripts', name), path.join(modules, name));
    fs.writeFileSync(path.join(modules, 'fvs-probe-windows-qualification.mjs'), `export const WINDOWS_SOURCE_QUALIFICATION=Object.freeze({id:'windows-source-v1',target:'${TARGET}',qualified:true,policySha256:'${'b'.repeat(64)}',tuple:'aeneas-6e167c9b-charon-0.1.225-lean-v4.31.0'});`);
    fs.writeFileSync(path.join(modules, 'fvs-probe-windows-runtime.mjs'), [
      'export const control={};',
      'export function assertValidatedWindowsRuntime(value){if(value!==control.runtime)throw Error("unbranded runtime")}',
      'export function plainWindowsPath(value){if(typeof value!=="string")throw Error("invalid path");return value}',
      'export function resolveWindowsRuntime(){return control.resolution??{ok:true,runtime:control.runtime}}',
    ].join('\n'));
    fs.writeFileSync(path.join(modules, 'fvs-probe-windows-setup.mjs'), 'export function planWindowsSetup(){};export function setupWindowsRuntime(){};export function recoverWindowsSetup(){}');
    fs.writeFileSync(path.join(modules, 'fvs-probe-windows-sandbox.mjs'), [
      'import {control} from "./fvs-probe-windows-runtime.mjs";',
      'export function getWindowsConfinementStatus(){control.statusCalls++;return control.state??{ok:true,status:"idle"}}',
      'export function recoverWindowsSession(){}',
      'export function runWindowsReadOnly(options){control.checks.push(options);control.afterChecks?.();return control.checkResult??{ok:true,results:options.commands.map(v=>({name:v.name,ok:true,stdout:v.expected})),timings:{checksMs:1}}}',
      'export function runWindowsStagedExtract(options){control.extracts.push(options);if(control.beforeExtract)control.beforeExtract();return control.extraction}',
    ].join('\n'));
    control = (await import(pathToFileURL(path.join(modules, 'fvs-probe-windows-runtime.mjs')).href)).control;
    api = await import(pathToFileURL(path.join(modules, 'fvs-probe-inventory.mjs')).href);
    source = path.join(directory, 'project with spaces'); crate = path.join(source, 'rust crate');
    fs.mkdirSync(crate, { recursive: true }); fs.mkdirSync(path.join(source, 'Crate'));
    fs.writeFileSync(path.join(crate, 'Cargo.toml'), '[package]\nname="crate"\n');
    const bundle = path.join(directory, 'managed tools', 'installations', 'a'.repeat(32));
    const tools = path.join(bundle, 'probe-bin'); fs.mkdirSync(tools, { recursive: true });
    const profile = path.join(directory, 'profile'); fs.mkdirSync(profile);
    runtime = { projectRoot: source, profileDirectory: profile, sourceBuildReceipt: path.join(bundle, 'INSTALL.json'), policySha256: 'b'.repeat(64), probePath: path.join(tools, 'probe-aeneas.exe'), helpers: {}, readOnlyPaths: [tools], libraryPath: path.join(tools, 'lib'), rustupPath: path.join(tools, 'rustup.exe'), versions: [] };
    for (const name of ['probe-aeneas', 'probe-rust', 'scip', 'probe-lean', 'rust-analyzer', 'rustup-components']) {
      const file = path.join(tools, name + '.exe'); fs.writeFileSync(file, name);
      runtime.helpers[name] = { path: file, sha256: 'a'.repeat(64) };
      runtime.versions.push({ name, executable: file, args: ['--version'], expected: name + ' pinned', sha256: 'a'.repeat(64) });
    }
    output = path.join(directory, 'graph.json');
  });
  beforeEach(() => {
    writeProject(); fs.rmSync(output, { force: true });
    runtime = { ...runtime, policySha256: 'b'.repeat(64) }; // Each resolution receives a fresh branded identity.
    for (const key of Object.keys(control)) delete control[key];
    Object.assign(control, { runtime, statusCalls: 0, checks: [], extracts: [], extraction: { ok: true, status: 0, outputText: graph, timings: { runMs: 2 } } });
  });
  after(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); });

  it('selects source builds only for Windows and preserves explicit official selection', () => {
    assert.equal(api.selectProbeDistribution('auto', TARGET), 'windows-source-v1');
    assert.equal(api.selectProbeDistribution('official', TARGET), 'official');
    for (const target of ['x86_64-unknown-linux-gnu', 'aarch64-apple-darwin']) assert.equal(api.selectProbeDistribution('auto', target), 'official');
    assert.throws(() => api.selectProbeDistribution('caller-policy'), /unknown probe distribution/);
  });
  it('batches all checks once and exposes helper paths as strings', () => {
    const result = resolve(); assert.equal(result.status, 'verified', JSON.stringify(result));
    assert.equal(control.checks.length, 1); assert.equal(control.checks[0].commands.length, runtime.versions.length);
    assert.deepEqual(Object.keys(result.helpers), ['probe-rust', 'scip', 'probe-lean', 'rust-analyzer']);
    for (const [name, helper] of Object.entries(result.helpers)) { assert.equal(helper.path, runtime.helpers[name].path); assert.equal(helper.sha256, 'a'.repeat(64)); }
    assert.equal(result.distribution.official, false);
    assert.equal(JSON.stringify(result).includes('readOnlyPaths'), false, 'runtime authority is not serialized');
  });
  it('reports pending recovery without checking helpers or repairing it', () => {
    control.state = { ok: false, status: 'recovery-required', sessionId: 'b'.repeat(32), error: 'interrupted' };
    const result = resolve(); assert.equal(result.status, 'incompatible'); assert.equal(result.recovery.sessionId, 'b'.repeat(32));
    assert.equal(control.checks.length, 0); assert.equal(control.extracts.length, 0);
  });
  it('reports an unqualified actual Windows host before helper checks', () => {
    control.state = { ok: false, status: 'host-unsupported', host: { qualified: false, nativeMachine: 0xaa64 } };
    const result = resolve(); assert.equal(result.status, 'unsupported-platform'); assert.equal(result.platformSupported, false);
    assert.equal(result.host.nativeMachine, 0xaa64); assert.equal(control.checks.length, 0);
  });
  it('preserves authoritative setup recovery IDs before an installation is ready', () => {
    const sessionId = 'setup:' + 'd'.repeat(32);
    control.resolution = { ok: false, status: 'incompatible', diagnostics: [{ message: 'Interrupted setup', recovery: { sessionId } }] };
    const result = resolve(); assert.equal(result.status, 'incompatible'); assert.equal(result.recovery.sessionId, sessionId);
    assert.equal(result.setup.available, false); assert.equal(control.checks.length, 0);
  });
  it('rejects incomplete and mismatched exact version checks', () => {
    control.checkResult = { ok: true, results: [] }; assert.equal(resolve().status, 'incompatible');
    control.checkResult.results = runtime.versions.map(v => ({ name: v.name, ok: true, stdout: v.expected + ' altered' }));
    assert.equal(resolve().status, 'incompatible');
  });
  it('does not inherit qualification when the bundled source recipe changes', () => {
    runtime.policySha256 = 'c'.repeat(64);
    const result = resolve(); assert.equal(result.status, 'unsupported-platform'); assert.equal(result.distribution.qualified, false);
    assert.equal(control.checks.length, 0);
  });
  it('requires an exact project tuple before any native session', () => {
    fs.writeFileSync(path.join(source, 'lean-toolchain'), 'leanprover/lean4:v0.0.0');
    assert.equal(resolve().status, 'incompatible'); assert.equal(control.statusCalls, 0);
  });
  it('does not report verified if provenance changes during helper checks', () => {
    control.afterChecks = () => fs.appendFileSync(path.join(source, 'lean-toolchain'), '\n');
    const result = resolve(); assert.equal(result.status, 'incompatible'); assert.match(result.reasons.join(' '), /provenance changed/);
    assert.equal(control.extracts.length, 0);
  });
  it('rejects unbound callers and changed provenance before staging', () => {
    assert.match(extract().error, /requires a runtime verified by resolveProbe/);
    assert.equal(resolve().status, 'verified');
    fs.appendFileSync(path.join(source, 'lean-toolchain'), '\n');
    assert.match(extract().error, /provenance changed/); assert.equal(control.extracts.length, 0); assert.equal(fs.existsSync(output), false);
  });
  it('rejects a verified runtime used for a different root or executable', () => {
    assert.equal(resolve().status, 'verified');
    assert.match(extract({ projectRoot: directory }).error, /paths differ/);
    assert.match(extract({ probePath: runtime.helpers.scip.path }).error, /paths differ/);
    assert.equal(control.extracts.length, 0);
  });
  it('passes source file hashes into staging and publishes validated bytes after cleanup', () => {
    assert.equal(resolve().status, 'verified'); const result = extract(); assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(fs.readFileSync(output, 'utf8'), graph); assert.equal(fs.statSync(output).nlink, 1);
    assert.equal(control.extracts[0].expectedProvenance.files.length, 4); assert.equal(result.timings.runMs, 2);
    assert.deepEqual(fs.readdirSync(directory).filter(name => name.startsWith('.fvs-probe-output-')), []);
  });
  it('preserves an existing output and refuses unqualified public API extraction', () => {
    assert.equal(resolve().status, 'verified'); fs.writeFileSync(output, 'original');
    assert.match(extract().error, /already exists/); assert.match(extract({ withPublicApi: true }).error, /not qualified/);
    assert.equal(fs.readFileSync(output, 'utf8'), 'original'); assert.equal(control.extracts.length, 0);
  });
  it('refuses publication anywhere in managed installations, coordinator or actual-profile tool homes', () => {
    assert.equal(resolve().status, 'verified');
    const bundle = path.dirname(runtime.sourceBuildReceipt);
    for (const parent of [bundle, path.join(bundle, 'launcher'), path.resolve(bundle, '..', '..', 'receipts'),
      path.join(runtime.profileDirectory, '.fvs', 'windows-confinement'), path.join(runtime.profileDirectory, '.local', 'bin')]) {
      fs.mkdirSync(parent, { recursive: true });
      const destination = path.join(parent, 'setup-active.json');
      assert.match(extract({ output: destination }).error, /protected tool directory/);
      assert.equal(fs.existsSync(destination), false);
    }
    assert.equal(control.extracts.length, 0);
  });
  it('forwards uncertain cleanup recovery and never accepts its candidate bytes', () => {
    assert.equal(resolve().status, 'verified');
    control.extraction = { ok: false, outputText: graph, confinementError: 'uncertain execution', cleanupError: 'session retained', retainedStage: 'private-stage', recovery: { sessionId: 'c'.repeat(32) }, timings: { runMs: 3 } };
    const result = extract(); assert.equal(result.ok, false); assert.equal(result.recovery.sessionId, 'c'.repeat(32));
    assert.equal(result.confinementError, 'uncertain execution'); assert.equal(result.timings.runMs, 3); assert.equal(fs.existsSync(output), false);
  });
  it('rejects malformed or empty graph bytes before publication', () => {
    assert.equal(resolve().status, 'verified'); control.extraction.outputText = '{}'; assert.equal(extract().ok, false);
    const empty = JSON.parse(graph); empty.data = {}; control.extraction.outputText = JSON.stringify(empty);
    assert.equal(extract().ok, false); assert.equal(fs.existsSync(output), false);
  });
  it('preserves a destination created while the confined extraction runs', () => {
    assert.equal(resolve().status, 'verified'); control.beforeExtract = () => fs.writeFileSync(output, 'racing output');
    assert.equal(extract().ok, false); assert.equal(fs.readFileSync(output, 'utf8'), 'racing output');
    assert.deepEqual(fs.readdirSync(directory).filter(name => name.startsWith('.fvs-probe-output-')), []);
  });
  it('rolls publication back if private staging removal fails', () => {
    assert.equal(resolve().status, 'verified'); const original = fs.rmdirSync; let injected = false;
    fs.rmdirSync = function(file, ...args) { if (!injected && path.basename(file).startsWith('.fvs-probe-output-')) { injected = true; throw Error('injected publication cleanup failure'); } return original.call(this, file, ...args); };
    try { const result = extract(); assert.equal(result.ok, false); assert.match(result.error, /injected publication cleanup failure/); }
    finally { fs.rmdirSync = original; }
    assert.equal(fs.existsSync(output), false); assert.deepEqual(fs.readdirSync(directory).filter(name => name.startsWith('.fvs-probe-output-')), []);
  });
});
