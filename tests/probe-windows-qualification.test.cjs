'use strict';

// Validate the retained evidence and the shipped release decision without
// invoking a Windows helper, host probe, compiler, installer, or profile.
const { before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = 'tests/fixtures/windows-source-v1.json';
const TARGET = 'x86_64-pc-windows-msvc';
const DIGEST = /^[a-f0-9]{64}$/;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = relative => fs.readFileSync(path.join(ROOT, relative));
const json = relative => JSON.parse(read(relative).toString('utf8'));
let gate, policy, evidence, compatibility, release;

before(async () => {
  ({ WINDOWS_SOURCE_QUALIFICATION: gate } = await import(pathToFileURL(path.join(ROOT, 'scripts/fvs-probe-windows-qualification.mjs'))));
  const runtime = await import(pathToFileURL(path.join(ROOT, 'scripts/fvs-probe-windows-runtime.mjs')));
  ({ PROBE_RELEASE: release } = await import(pathToFileURL(path.join(ROOT, 'scripts/fvs-probe-inventory.mjs'))));
  policy = runtime.getWindowsSourcePolicy();
  evidence = json(FIXTURE);
  compatibility = json('tests/fixtures/probe-compatibility.json');
});

function regularRepositoryFile(relative) {
  assert.equal(typeof relative, 'string');
  assert(!path.isAbsolute(relative) && !relative.includes('\\'), relative);
  assert(relative.split('/').every(part => part && part !== '.' && part !== '..'), relative);
  const file = path.join(ROOT, relative), stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), relative);
  return file;
}

function recordedSources(records, prefix) {
  assert(Array.isArray(records) && records.length > 0);
  assert.equal(new Set(records.map(item => item.file)).size, records.length);
  for (const item of records) {
    assert(item.file.startsWith(prefix), item.file);
    assert.match(item.sha256, DIGEST);
    assert.equal(sha(fs.readFileSync(regularRepositoryFile(item.file))), item.sha256, item.file);
  }
}

function terminal(receipt, expectedRuns) {
  assert.match(receipt.sha256, DIGEST);
  assert.match(receipt.stateSha256, DIGEST);
  for (const key of ['jobDrained', 'profileAbsent', 'stageRemoved', 'exactAclsRestored', 'aclCleanupConfirmed']) assert.equal(receipt[key], true, key);
  assert.equal(receipt.launcherSha256, evidence.identity.launcherSha256);
  assert(receipt.originalEntriesChecked > 0);
  assert(receipt.resourcesChecked > 0);
  assert.equal(receipt.descendantAclAudit.exactRestored, true);
  assert.equal(receipt.descendantAclAudit.ownSidRemaining, 0);
  assert.deepEqual(receipt.descendantAclAudit.changedPreserved, []);
  assert.equal(receipt.nativeRuns.length, expectedRuns);
  const last = receipt.nativeRuns.find(run => run.runId === receipt.lastRunId);
  assert(last, 'Terminal receipt must bind an actual persisted execution');
  assert.equal(last.sha256, receipt.lastRunResultSha256);
  for (const run of receipt.nativeRuns) {
    assert.match(run.sha256, DIGEST);
    assert.equal(run.exitCode, 0);
    assert.equal(run.activeProcessesAfter, 0);
    assert.equal(run.lpacAccessCheckVerified, true);
    assert.equal(run.inheritedSentinelExcluded, true);
    assert.deepEqual(run.capabilities, ['registryRead']);
  }
}

test('shipped Windows qualification binds the exact recipe and retained source receipt', () => {
  assert.equal(gate.qualified, true);
  assert.equal(gate.id, 'windows-source-v1');
  assert.equal(gate.target, TARGET);
  assert.equal(gate.policySha256, policy.sha256);
  assert.deepEqual(gate.evidence, { path: FIXTURE, sha256: sha(read(FIXTURE)) });
  assert.equal(evidence.schema, 'fvs/windows-source-compatibility/v1');
  assert.equal(evidence.status, 'passed');
  assert.deepEqual(evidence.distribution, {
    id: gate.id, target: gate.target, official: false, policySha256: policy.sha256,
    tuple: gate.tuple, isolation: gate.isolation,
  });
  const receipt = compatibility.sourceReceipts[gate.id];
  assert.equal(receipt.policySha256, policy.sha256);
  assert.deepEqual(receipt.evidence, gate.evidence);
  assert.equal(policy.qualified, false, 'The immutable recipe must not acquire a release claim');
});

test('accepted source and generated module identities still equal the shipped bytes', () => {
  assert.equal(evidence.source.policySha256, policy.sha256);
  assert.deepEqual(evidence.source.policyFiles, policy.sourceFiles);
  assert.deepEqual(evidence.source.sources, policy.sources);
  recordedSources(evidence.source.modules, 'scripts/');
  recordedSources(evidence.source.packagedModules, 'plugins/fvs/scripts/');
  recordedSources(evidence.source.nativeSources, 'scripts/fvs-probe-native/windows/');
  const names = evidence.source.modules.map(item => path.posix.basename(item.file));
  for (const name of ['fvs-probe-inventory.mjs', 'fvs-probe-windows-runtime.mjs', 'fvs-probe-windows-setup.mjs', 'fvs-probe-windows-sandbox.mjs']) assert(names.includes(name), name);
  assert(!names.includes('fvs-probe-windows-qualification.mjs'), 'Prospective and final release metadata are recorded separately');
  for (const item of evidence.source.modules) {
    const packaged = evidence.source.packagedModules.find(entry => entry.file === 'plugins/fvs/' + item.file);
    assert(packaged, item.file);
    assert.equal(packaged.sha256, item.sha256, item.file);
  }
  assert.deepEqual(read('scripts/fvs-probe-windows-qualification.mjs'), read('plugins/fvs/scripts/fvs-probe-windows-qualification.mjs'));
  const native = evidence.source.nativeSources.filter(item => item.file.endsWith('.cs'));
  assert.equal(native.length, 5);
  const sourceSet = native.map(item => ({ name: path.posix.basename(item.file), sha256: item.sha256 }))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .map(item => `${item.name}\0${item.sha256}\n`).join('');
  assert.equal(sha(sourceSet), evidence.identity.launcherSourceSetSha256);
  const historicalNative = evidence.historicalEvidence.native.record;
  assert.equal(historicalNative.deterministicBuildRecipeCorrection.canonicalSourceSetSha256, evidence.identity.launcherSourceSetSha256);
  assert.equal(historicalNative.deterministicBuildRecipeCorrection.independentSourceEqualityVerified, true);
  assert.deepEqual(historicalNative.productionLauncher.sources, evidence.source.nativeSources);
});

test('reviewed helper origins and fresh launcher identity are tied to measured setup', () => {
  const setup = evidence.historicalEvidence.setup.record;
  assert.equal(setup.status, 'passed');
  assert.equal(setup.distribution.policySha256, policy.sha256);
  assert.equal(setup.identity.receiptSha256, evidence.identity.managedInstallationReceiptSha256);
  assert.equal(setup.identity.launcherSha256, evidence.identity.launcherSha256);
  assert.equal(setup.identity.launcherSourceSetSha256, evidence.identity.launcherSourceSetSha256);
  assert.equal(setup.identity.launcherBuildReceiptSha256, evidence.identity.launcherBuildReceiptSha256);
  assert.equal(setup.identity.launcherTestHooks, false);
  assert.equal(setup.origins.launcher.origin, 'fresh-source-build');
  assert.equal(setup.identity.launcherRecipeSha256, sha(read('scripts/fvs-probe-native/windows/Build-Launcher.ps1')));
  assert.equal(setup.measurements.count, 11);
  assert.equal(setup.measurements.versions.length, 11);
  for (const [name, reviewed] of Object.entries(policy.reviewedArtifacts)) {
    const origin = setup.origins[name];
    assert.equal(origin.origin, 'reviewed-existing-artifact', name);
    assert.deepEqual(origin.source, reviewed.source, name);
    assert.equal(origin.historicalEvidenceSha256, reviewed.evidenceSha256, name);
    assert.equal(origin.reviewedFileCount, reviewed.files.length, name);
    const version = setup.measurements.versions.find(item => item.tool === (name === 'rustup' ? 'rustup-components' : name));
    assert(version, name);
    assert(reviewed.files.some(file => file.sha256 === version.executableSha256), name);
  }
  for (const version of setup.measurements.versions) {
    assert.equal(version.exitCode, 0, version.tool);
    assert.equal(version.jobEmpty, true, version.tool);
    assert.match(version.executableSha256, DIGEST);
    assert.match(version.stdoutSha256, DIGEST);
    assert.equal(version.stderrSha256, sha(''));
  }
  assert.equal(evidence.identity.probeSha256, policy.reviewedArtifacts['probe-aeneas'].files[0].sha256);
  assert.equal(setup.knownFolderPreservation.existingByteIdenticalFilesPreserved, 100);
  assert.equal(setup.knownFolderPreservation.newlyPublishedFiles, 0);
  for (const key of ['observedAtSetupCompletion', 'setupMarkerAbsent', 'setupJournalAbsent', 'stageAbsent', 'sharedLeaseReleased']) assert.equal(setup.terminalSetupState[key], true, key);
  assert.equal(setup.terminalSetupState.exitCode, 0);
  assert.equal(setup.initialFailuresAndRecoveries.length, 3);
  for (const failure of setup.initialFailuresAndRecoveries) assert.equal(failure.recoveryStatus, 'rolled-back');
});

test('real helper installation denial and DLL checks retain complete cleanup evidence', () => {
  const adapter = evidence.historicalEvidence.adapter.record;
  assert.equal(adapter.ok, true);
  assert.equal(adapter.policySha256, policy.sha256);
  assert.equal(adapter.adapterSha256, sha(read('scripts/fvs-probe-windows-sandbox.mjs')));
  assert.equal(adapter.launcherSha256, evidence.identity.launcherSha256);
  assert.equal(adapter.launcherBuildReceiptSha256, evidence.identity.launcherBuildReceiptSha256);
  assert.equal(adapter.launcherSourceSetSha256, evidence.identity.launcherSourceSetSha256);
  assert.equal(adapter.launcherTestHooks, false);
  for (const key of ['ok', 'unicodeSourceAndToolPaths', 'protectedOriginalWriteDenied', 'independentPrivateCopyWriteAllowed', 'protectedTreesUnchanged']) assert.equal(adapter.smoke[key], true, key);
  assert.equal(adapter.smoke.graphPublished, false, 'A canary is not an accepted extraction graph');
  for (const key of ['injected', 'invalidDecoysNotLoaded', 'privateDecoysRemoved']) assert.equal(adapter.smoke.dllDecoys[key], true, key);
  const dlls = adapter.smoke.dllDecoys.verifiedRuntimeFiles;
  assert.equal(dlls.length, 9);
  for (const dll of dlls) assert(policy.reviewedArtifacts['probe-lean'].files.some(file => path.posix.basename(file.relativePath) === dll.name && file.sha256 === dll.sha256), dll.name);
  const denial = adapter.missingHelperDenial;
  for (const key of ['ok', 'autoInstallReached', 'denialObserved', 'noAcceptedGraph', 'protectedTreesUnchanged', 'cargoHomeRemainedEmpty']) assert.equal(denial[key], true, key);
  assert.equal(denial.osError, 5);
  assert.equal(denial.probeAeneasSha256, evidence.identity.probeSha256);
  assert.equal(denial.managedInstallationReceiptSha256, evidence.identity.managedInstallationReceiptSha256);
  for (const receipt of [...adapter.smoke.terminalReceipts, ...denial.terminalReceipts]) {
    assert.match(receipt.sha256, DIGEST);
    assert.equal(receipt.status, 'disposed');
    for (const key of ['jobDrained', 'profileAbsent', 'stageRemoved', 'aclCleanupConfirmed', 'resourcesExactlyRestored']) assert.equal(receipt[key], true, key);
    assert.equal(receipt.descendantAclAudit.exactRestored, true);
    assert.equal(receipt.descendantAclAudit.ownSidRemaining, 0);
    assert.deepEqual(receipt.descendantAclAudit.changedPreserved, []);
  }
  assert.equal(adapter.finalStatus, 'idle');
});

test('normal packaged commands produced a nonempty joined graph only after native cleanup', () => {
  const positive = evidence.positive;
  assert.equal(positive.mode, 'commands');
  assert.equal(positive.synthetic, false);
  assert.match(positive.reportSha256, DIGEST);
  assert.match(positive.graph.sha256, DIGEST);
  assert.equal(positive.graph.schema, 'probe-aeneas/extract');
  assert.equal(positive.graph.schemaVersion, '3.0');
  assert.equal(positive.graph.atoms, 3027);
  assert.deepEqual(positive.graph.atomCounts, { rust: 675, lean: 2352 });
  assert.equal(positive.graph.resolvedCrossLanguageEdges, 1962);
  assert.equal(positive.canonical.count, 279);
  assert.equal(positive.canonical.charonJoins, 189);
  assert.equal(positive.canonical.mismatches, 0);
  assert.equal(positive.canonical.withoutCharonId, 90);
  assert.equal(positive.canonical.publicApiClassified, false);
  assert.equal(positive.canonical.baselineFunctionsEqual, true);
  assert.equal(positive.canonical.baselineProgressEqual, true);
  assert.deepEqual(positive.commands.map(command => command.name), ['resolve', 'run', 'inventory']);
  for (const command of positive.commands) {
    assert.equal(command.exitCode, 0, command.name);
    for (const key of ['commandSha256', 'stdoutSha256', 'stderrSha256']) assert.match(command[key], DIGEST);
  }
  terminal(positive.helperCleanup, 11);
  terminal(positive.extractionCleanup, 1);
  assert.match(positive.versionExecutionScope, /normal run performs another internal resolve/i);
  assert.equal(positive.helperVersions.length, 11);
  for (const version of positive.helperVersions) {
    const expected = policy.versions.find(item => item.name === version.name);
    assert(expected, version.name);
    assert.equal(version.expected, expected.expected);
    assert.equal(version.observed, expected.expected.trim());
    assert.equal(version.executableSha256, evidence.historicalEvidence.setup.record.measurements.versions.find(item => item.tool === version.name)?.executableSha256);
    assert(positive.helperCleanup.nativeRuns.some(run => run.sha256 === version.nativeRunSha256));
  }
  assert.equal(positive.protectedInputs.equalityEnforcedBySuccessfulAdapter, true);
  assert.equal(positive.protectedInputs.completedBeforePublication, true);
  assert.equal(positive.warnings.missingLeanReferences, 47);
  assert.equal(positive.warnings.missingLeanKeys, 22);
  assert.equal(positive.warnings.upstreamSorryWarnings, 8);
  assert(evidence.limitations.some(item => /(?:proof|certification)/i.test(item)));
  assert(evidence.limitations.some(item => /(?:incomplete|missing|closure)/i.test(item)));
});

test('retained raw evidence identities and historical boundaries remain explicit', () => {
  assert(Array.isArray(evidence.rawEvidence) && evidence.rawEvidence.length > 0);
  for (const item of evidence.rawEvidence) {
    assert.match(item.sha256, DIGEST);
    assert(Number.isSafeInteger(item.bytes) && item.bytes >= 0, item.artifact);
    assert(!path.isAbsolute(item.artifact) && !/^[A-Za-z]:/.test(item.artifact), item.artifact);
  }
  for (const historical of Object.values(evidence.historicalEvidence)) {
    assert.match(historical.sha256, DIGEST);
    assert(evidence.rawEvidence.some(item => item.artifact === historical.artifact && item.sha256 === historical.sha256));
  }
  // These earlier records remain historical observations, not retroactively
  // rewritten claims that their primitive/canary tests covered normal resolve.
  assert.equal(evidence.historicalEvidence.native.record.windowsProductionRouteQualified, false);
  assert.match(evidence.historicalEvidence.adapter.record.authority, /synthetic sibling runtime branding/i);
  assert.equal(evidence.positive.candidateMetadata.metadata.qualified, true);
  assert.equal(evidence.positive.candidateMetadata.metadata.policySha256, policy.sha256);
  assert.match(evidence.positive.candidateMetadata.metadata.reason, /private release candidate/i);
  assert.match(evidence.positive.candidateMetadata.qualificationModuleSha256, DIGEST);
});

test('supplemental cleanup faults passed on the current native source bytes', () => {
  const supplemental = evidence.historicalEvidence.nativeSupplemental.record;
  assert.equal(supplemental.schema, 'fvs/windows-native-lifecycle-tests/v2');
  assert.equal(supplemental.ok, true);
  assert.equal(supplemental.mode, 'cleanup-faults');
  assert.equal(supplemental.passed, 67);
  assert.equal(supplemental.failed, 0);
  assert.equal(supplemental.checks.length, 67);
  assert(supplemental.checks.every(check => check.passed === true && !check.skipped));
  assert.equal(supplemental.launcherBuild.testHooks, true);
  assert.equal(supplemental.currentNativeSourceBytesMatch, true);
  assert.equal(supplemental.canonicalSourceSetSha256, evidence.identity.launcherSourceSetSha256);
  assert.equal(supplemental.launcherBuild.sources.length, 5);
  for (const item of supplemental.launcherBuild.sources) {
    assert.equal(item.file, path.posix.basename(item.file));
    assert.equal(item.sha256, evidence.source.nativeSources.find(source => path.posix.basename(source.file) === item.file)?.sha256);
  }
  for (const value of [supplemental.launcherSha256, supplemental.launcherBuild.receiptSha256, supplemental.launcherBuild.recordedSourceSetSha256, supplemental.canarySha256]) assert.match(value, DIGEST);
  assert.equal(supplemental.harnessSha256, sha(read('tests/helpers/fvs-windows-native/lifecycle.mjs')));
  assert.equal(evidence.identity.launcherTestHooks, false, 'Qualification must preserve the distinction between test and managed binaries');
});

test('source qualification does not relabel the official Windows release archive', () => {
  const official = release.assets[TARGET];
  assert.equal(official.supported, false);
  assert.equal(official.asset, 'probe-aeneas-x86_64-pc-windows-msvc.zip');
  assert.equal(official.assetId, 554534285);
  assert.equal(official.archiveSha256, '91ebd551073d0f705fdf905185e8d82224c53909f22ef774c231aa411000a2dc');
  assert.equal(official.archiveBytes, 1445872);
  assert.equal(official.executableSha256, '68a131d2c8bb02b23e17cd8d99f5d1de059a7adb2f4ff1ba52fd8b635f5c4c77');
  assert.deepEqual(official, compatibility.release.assets[TARGET]);
  assert.notEqual(evidence.identity.probeSha256, official.executableSha256);
});
