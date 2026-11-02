// Explicit real-tool qualification, never part of the ordinary unit suite.
// The adapter route qualifies production security code before the public gate
// is enabled. The commands route then exercises the installed normal commands.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [scriptsArg, projectArg, evidenceArg, baselineArg, mode = 'adapter'] = process.argv.slice(2);
if (process.platform !== 'win32' || !scriptsArg || !projectArg || !evidenceArg || !baselineArg || !['adapter', 'commands'].includes(mode)) {
  throw Error('Usage: node qualify.mjs <packaged-scripts> <prepared-Dalek-project> <new-evidence-directory> <v10-canonical.json> [adapter|commands]');
}
const scripts = path.resolve(scriptsArg), source = path.resolve(projectArg), evidence = path.resolve(evidenceArg);
assert(source.includes(' '), 'Qualification requires a project directory containing spaces');
fs.mkdirSync(evidence); // Refuse to overwrite an earlier qualification attempt.
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const identity = file => ({ path: file, bytes: fs.statSync(file).size, sha256: digest(fs.readFileSync(file)) });
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const baselineFile = path.resolve(baselineArg), baselineBytes = fs.readFileSync(baselineFile);
const baselineIdentity = { path: baselineFile, bytes: baselineBytes.length, sha256: digest(baselineBytes) };
assert.equal(baselineIdentity.sha256, 'dd061d96a81bf398e9b147e94a794e8d5d5aeea9155ae0c8d0dc6273e5e28d2a', 'The retained v10 canonical baseline differs from the reviewed bytes');
const baseline = JSON.parse(baselineBytes.toString('utf8'));
assert.equal(baseline.count, 279); assert.equal(baseline.functions.length, 279);
const save = (name, data) => fs.writeFileSync(path.join(evidence, name), JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
const progress = data => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...data }) + '\n');
const inventoryScript = path.join(scripts, 'fvs-probe-inventory.mjs');
const { readProvenance } = await import(pathToFileURL(inventoryScript).href);
const provenance = readProvenance(source);
assert.deepEqual(provenance.problems, []);
assert.equal(provenance.translationSha256, '968a0725b105de2a38a94ee606bd7da85e775267da04dea6a8c9067061372fbd');
const report = { schema: 'fvs/windows-production-qualification/v1', mode, synthetic: false, startedAt: new Date().toISOString(), source, scripts, provenance, ok: false };
const { getWindowsSourcePolicy } = await import(pathToFileURL(path.join(scripts, 'fvs-probe-windows-runtime.mjs')).href);
const { WINDOWS_SOURCE_QUALIFICATION } = await import(pathToFileURL(path.join(scripts, 'fvs-probe-windows-qualification.mjs')).href);
report.policySha256 = getWindowsSourcePolicy().sha256;
report.packageModules = ['fvs-probe-inventory.mjs', 'fvs-probe-windows-runtime.mjs', 'fvs-probe-windows-setup.mjs',
  'fvs-probe-windows-sandbox.mjs', 'fvs-probe-windows-qualification.mjs'].map(name => identity(path.join(scripts, name)));
report.qualificationMetadata = WINDOWS_SOURCE_QUALIFICATION;
report.preparedLeanBuildLog = identity(path.join(source, '.lake', 'probe-lean', 'build_output.txt'));
assert.equal(report.preparedLeanBuildLog.sha256, '1e5f050f9620470a90aa7a8a0baac585ee1fa793aff3ee1543b3e6ed10fc3ae2');
const graphFile = path.join(evidence, 'extract.json');
let extractionLog = '';
function nativeRun(file, returned) {
  const bytes = fs.readFileSync(file), sha256 = digest(bytes), run = JSON.parse(bytes.toString('utf8'));
  assert.match(run.runId, /^[a-f0-9]{32}$/);
  assert.equal(path.basename(file), `run-${run.runId}.json`);
  assert.equal(run.ok, true); assert.equal(run.status, 'exited'); assert.equal(run.exitCode, 0);
  assert.equal(run.activeProcessesAfter, 0); assert.equal(run.lpacAccessCheckVerified, true);
  assert.equal(run.inheritedSentinelExcluded, true); assert.deepEqual(run.capabilities, ['registryRead']);
  if (returned) {
    assert.equal(returned.launcherExitCode, 0);
    assert.equal(returned.resultPath, file); assert.equal(returned.resultSha256, sha256);
    for (const [key, value] of Object.entries(run)) assert.deepEqual(returned[key], value, `Persisted run differs from response: ${key}`);
  }
  return { path: file, bytes: bytes.length, sha256, runId: run.runId, exitCode: run.exitCode,
    activeProcessesAfter: run.activeProcessesAfter, lpacAccessCheckVerified: run.lpacAccessCheckVerified,
    inheritedSentinelExcluded: run.inheritedSentinelExcluded, capabilities: run.capabilities };
}
function terminal(record, expectedRuns, returnedRuns = null, launcherSha256 = null) {
  const bytes = fs.readFileSync(record.path), receiptSha256 = digest(bytes);
  assert.equal(receiptSha256, record.sha256);
  const receipt = JSON.parse(bytes.toString('utf8'));
  assert.equal(receipt.schema, 'fvs/windows-terminal-receipt/v2');
  assert.equal(receipt.sessionId, record.sessionId);
  assert(['disposed', 'recovered'].includes(receipt.status));
  assert.equal(path.join(receipt.controlDirectory, 'terminal-receipt.json'), record.path);
  assert.match(receipt.stateSha256, /^[a-f0-9]{64}$/); assert.match(receipt.launcherSha256, /^[a-f0-9]{64}$/);
  if (launcherSha256) assert.equal(receipt.launcherSha256, launcherSha256);
  for (const key of ['jobDrained', 'profileAbsent', 'stageRemoved', 'aclCleanupConfirmed']) assert.equal(receipt[key], true, key);
  assert.equal(receipt.descendantAclAudit.exactRestored, true);
  assert.equal(receipt.descendantAclAudit.ownSidRemaining, 0);
  assert.deepEqual(receipt.descendantAclAudit.changedPreserved, []);
  assert(Number.isSafeInteger(receipt.descendantAclAudit.checked) && receipt.descendantAclAudit.checked > 0);
  assert(receipt.resourceAclResults.length > 0 && receipt.resourceAclResults.every(resource => resource.exactRestored && resource.beforeAcl === resource.currentAcl));
  assert.equal(fs.lstatSync(receipt.stageRoot, { throwIfNoEntry: false }), undefined);
  const files = fs.readdirSync(receipt.controlDirectory).filter(name => /^run-[a-f0-9]{32}\.json$/.test(name));
  assert.equal(files.length, expectedRuns, 'Unexpected number of persisted native executions');
  if (returnedRuns) assert.equal(returnedRuns.length, expectedRuns);
  const runs = files.map(name => {
    const file = path.join(receipt.controlDirectory, name), returned = returnedRuns?.find(run => run.resultPath === file);
    if (returnedRuns) assert(returned, 'Persisted native execution is absent from the adapter response');
    return nativeRun(file, returned);
  });
  assert.match(receipt.lastRunId, /^[a-f0-9]{32}$/); assert.match(receipt.lastRunResultSha256, /^[a-f0-9]{64}$/);
  const lastRun = runs.find(run => run.runId === receipt.lastRunId); assert(lastRun, 'Receipt does not name a persisted execution');
  assert.equal(lastRun.sha256, receipt.lastRunResultSha256, 'Terminal receipt does not cover the final persisted result bytes');
  if (returnedRuns) assert.equal(returnedRuns.at(-1).runId, receipt.lastRunId);
  return { path: record.path, bytes: bytes.length, sha256: receiptSha256, sessionId: receipt.sessionId,
    launcherSha256: receipt.launcherSha256, journalRevision: receipt.journalRevision, lastRunId: receipt.lastRunId,
    lastRunResultSha256: receipt.lastRunResultSha256, nativeRuns: runs,
    jobDrained: receipt.jobDrained, profileAbsent: receipt.profileAbsent, stageRemoved: receipt.stageRemoved,
    originalEntriesChecked: receipt.descendantAclAudit.checked, exactAclsRestored: true };
}
function command(name, args) {
  progress({ phase: name, event: 'start' }); const started = performance.now();
  const out = fs.openSync(path.join(evidence, name + '.stdout.log'), 'wx');
  const err = fs.openSync(path.join(evidence, name + '.stderr.log'), 'wx');
  let child;
  try { child = spawnSync(process.execPath, [inventoryScript, ...args], { windowsHide: true, stdio: ['ignore', out, err], timeout: 0 }); }
  finally { fs.closeSync(out); fs.closeSync(err); }
  const result = { command: [process.execPath, inventoryScript, ...args], exitCode: child.status, error: child.error?.message, elapsedMs: performance.now() - started };
  save(name + '.command.json', result); progress({ phase: name, event: 'complete', elapsedMs: result.elapsedMs, exitCode: child.status });
  assert.equal(child.status, 0, `${name} failed; inspect saved logs`); return result;
}
try {
  if (mode === 'adapter') {
    const { resolveWindowsRuntime } = await import(pathToFileURL(path.join(scripts, 'fvs-probe-windows-runtime.mjs')).href);
    const { runWindowsReadOnly, runWindowsStagedExtract } = await import(pathToFileURL(path.join(scripts, 'fvs-probe-windows-sandbox.mjs')).href);
    progress({ phase: 'resolve-managed-identities', event: 'start' });
    const resolved = resolveWindowsRuntime({ projectRoot: source }); assert(resolved.ok, JSON.stringify(resolved));
    const runtime = resolved.runtime;
    report.installation = identity(runtime.sourceBuildReceipt); report.launcher = identity(runtime.launcher.path); report.policySha256 = runtime.policySha256;
    const checks = runWindowsReadOnly({ runtime, commands: runtime.versions, cwd: provenance.rustProject, projectRoot: source, onProgress: progress });
    save('helper-checks.json', checks); assert(checks.ok, JSON.stringify(checks));
    assert.equal(checks.results.length, 11);
    report.helperCleanup = terminal(checks.terminalReceipt, 11, checks.results, report.launcher.sha256);
    const expectedProvenance = { projectRoot: source, rustProject: provenance.rustProject,
      files: ['aeneas-config.yml', 'lake-manifest.json', 'lean-toolchain'].map(file => path.join(source, file)).concat(provenance.translationJson)
        .map(file => ({ path: file, sha256: identity(file).sha256 })) };
    const extraction = runWindowsStagedExtract({ runtime, probePath: runtime.probePath, projectRoot: source, rustProject: provenance.rustProject, expectedProvenance, onProgress: progress });
    const { outputText, ...execution } = extraction; save('extraction.json', execution);
    extractionLog = `${extraction.stdout ?? ''}${extraction.stderr ?? ''}`;
    assert(extraction.ok && typeof outputText === 'string', JSON.stringify(execution));
    report.extractionCleanup = terminal(extraction.terminalReceipt, 1, extraction.results, report.launcher.sha256);
    fs.writeFileSync(graphFile, outputText, { flag: 'wx' });
    report.timings = { checks: checks.timings, extraction: extraction.timings };
  } else {
    report.resolveCommand = command('resolve', ['resolve', '--project-root', source, '--format', 'json']);
    const resolved = read(path.join(evidence, 'resolve.stdout.log')); assert.equal(resolved.status, 'verified');
    assert.equal(resolved.distribution.id, 'windows-source-v1'); assert.equal(resolved.distribution.official, false);
    assert.equal(WINDOWS_SOURCE_QUALIFICATION.policySha256, report.policySha256);
    report.probe = resolved.probe; report.helpers = resolved.helpers;
    report.helperCleanup = terminal(resolved.confinement.terminalReceipt, 11);
    report.runCommand = command('run', ['run', '--project-root', source, '--output', graphFile]);
    const log = fs.readFileSync(path.join(evidence, 'run.stderr.log'), 'utf8');
    extractionLog = fs.readFileSync(path.join(evidence, 'run.stdout.log'), 'utf8') + log;
    const receipt = log.split(/\r?\n/).find(line => line.startsWith('FVS >> cleanup receipt '));
    assert(receipt, 'Normal run must retain its durable cleanup receipt identity');
    report.extractionCleanup = terminal(JSON.parse(receipt.slice('FVS >> cleanup receipt '.length)), 1, null, report.helperCleanup.launcherSha256);
  }
  command('inventory', [graphFile, '--format', 'json']);
  const canonical = read(path.join(evidence, 'inventory.stdout.log')), graph = read(graphFile), translation = read(provenance.translationJson);
  assert.equal(graph.schema, 'probe-aeneas/extract'); assert.equal(graph['schema-version'], '3.0');
  assert.deepEqual(graph.tool, { name: 'probe-aeneas', version: '0.20.0', command: 'extract' });
  assert.equal(graph.inputs.length, 2);
  assert.deepEqual(graph.inputs.map(input => input.source.language).sort(), ['lean', 'rust']);
  for (const input of graph.inputs) {
    assert.equal(input.schema, `probe-${input.source.language}/extract`);
    assert.equal(input.source.repo, 'https://github.com/Beneficial-AI-Foundation/curve25519-dalek-lean-verify.git');
    assert.equal(input.source.commit, '0a22c281a9a14b6465a5473c200c7d3f1ac92df8');
    assert.equal(input.source.package, input.source.language === 'rust' ? 'curve25519-dalek' : 'Curve25519Dalek');
    assert.equal(input.source['package-version'], input.source.language === 'rust' ? '4.2.0' : '0.1.0');
  }
  assert.equal(Object.keys(graph.data).length, 3027);
  const atomCounts = Object.values(graph.data).reduce((counts, atom) => { counts[atom.language] = (counts[atom.language] ?? 0) + 1; return counts; }, {});
  assert.deepEqual(atomCounts, { rust: 675, lean: 2352 });
  assert.equal(canonical.count, 279); assert.equal(canonical.functions.length, 279);
  assert.deepEqual(canonical.functions, baseline.functions, 'Canonical functions differ from the retained v10 baseline');
  assert.deepEqual(canonical.progress, baseline.progress, 'Upstream proof classifications must remain unchanged');
  const ids = new Set(Object.keys(graph.data)), scope = new Set(canonical.functions.map(fn => fn.id));
  const definitions = new Map(translation.functions.map(fn => [fn.def_id, fn]));
  const joins = [], missing = [];
  for (const [id, atom] of Object.entries(graph.data)) {
    assert.equal(atom['code-path']?.includes('\\') ?? false, false);
    for (const dependency of atom.dependencies) if (!ids.has(dependency)) missing.push({ id, language: atom.language, dependency });
    if (!Object.hasOwn(atom, 'charon-def-id')) continue;
    const definition = definitions.get(atom['charon-def-id']); assert(definition, id);
    assert.equal(atom['charon-version'], translation.charon_version);
    assert.equal(atom['code-path'], definition.source.file);
    const start = atom['code-text']['lines-start'], end = atom['code-text']['lines-end'];
    assert([start, end, definition.source.begin_line, definition.source.end_line].every(n => Number.isSafeInteger(n) && n > 0));
    assert(Math.min(end, definition.source.end_line) >= Math.max(start, definition.source.begin_line));
    const leanId = 'probe:' + definition.lean_name;
    assert.equal(atom['translation-name'], leanId); assert.equal(graph.data[leanId]?.language, 'lean');
    assert.equal(atom['rust-qualified-name'].split('::').at(-1), definition.rust_name.split('::').at(-1));
    assert(scope.has(id)); joins.push({ id, defId: atom['charon-def-id'], leanId });
  }
  assert.equal(joins.length, 189); assert(missing.every(entry => entry.language === 'lean'));
  assert.match(extractionLog, /Found 8 sorry warnings/);
  assert.match(extractionLog, /Importing 231 modules/);
  assert.equal(missing.length, 47); assert.equal(new Set(missing.map(entry => entry.dependency)).size, 22);
  report.graph = identity(graphFile); report.canonicalFunctions = canonical.count; report.charonJoins = joins.length;
  assert.equal(getWindowsSourcePolicy().sha256, report.policySha256, 'Source recipe changed during qualification');
  for (const module of report.packageModules) assert.deepEqual(identity(module.path), module, 'Package module changed during qualification');
  report.baseline = baselineIdentity; report.baselineCanonicalFunctionsEqual = true; report.progress = canonical.progress; report.atomCounts = atomCounts;
  report.graphLimitations = { missingLeanReferences: missing.length, missingLeanKeys: new Set(missing.map(entry => entry.dependency)).size,
    upstreamSorryWarnings: 8, proofClassification: 'Unchanged upstream classifications; not independent proof certification.' };
  save('charon-joins.json', joins); save('missing-lean-references.json', missing);
  report.ok = true;
} catch (error) { report.error = error.stack; process.exitCode = 1; }
report.finishedAt = new Date().toISOString(); save('qualification.json', report);
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
