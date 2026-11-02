const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const runtime = import(pathToFileURL(path.resolve(__dirname, '../scripts/fvs-probe-windows-runtime.mjs')));
const native = process.platform === 'win32' && process.arch === 'x64';
function fixture(t) {
  const parent = path.resolve(__dirname, '../.native-work'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'runtime unit with spaces '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(file, text = 'fixture, never executed') { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }

test('runtime and launcher brands cannot be supplied or copied by callers', async () => {
  const m = await runtime;
  assert.throws(() => m.assertValidatedWindowsRuntime({ policyId: 'windows-source-v1' }), /resolved by the built-in/);
  assert.throws(() => m.assertValidatedWindowsLauncher({ path: 'C:\\arbitrary.exe', sha256: 'a'.repeat(64) }), /managed source-build/);
});

test('only the pinned component check accepts required sets with optional default-profile components', async () => {
  const { getWindowsSourcePolicy, matchesWindowsVersion } = await runtime;
  const policy = getWindowsSourcePolicy(), version = policy.versions.find(x => x.name === 'rustup-components');
  const required = version.requiredComponents;
  assert.deepEqual(version.args, ['component', 'list', '--installed', '--toolchain', policy.toolchain]);
  assert(matchesWindowsVersion(version, required.join('\n')));
  assert(matchesWindowsVersion(version, [...required, 'clippy-x86_64-pc-windows-msvc', 'rust-docs-x86_64-pc-windows-msvc'].reverse().join('\r\n')));
  for (const absent of required) assert.equal(matchesWindowsVersion(version, required.filter(x => x !== absent).join('\n')), false, absent);
  assert.equal(matchesWindowsVersion(version, required.join('\n').replaceAll('x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc')), false);
  for (const exact of policy.versions.filter(x => x.expected)) {
    assert(matchesWindowsVersion(exact, exact.expected));
    assert.equal(matchesWindowsVersion(exact, exact.expected + '\nextra'), false);
    assert.equal(matchesWindowsVersion(exact, exact.expected.replace(/\d/, '9')), false);
  }
});
test('source policy binds patches, setup host, recipes and native launcher sources', async () => {
  const m = await runtime, policy = m.getWindowsSourcePolicy();
  assert.equal(policy.qualified, false);
  assert.equal(m.WINDOWS_SOURCE_DISTRIBUTION.origin, 'source-build');
  for (const name of ['SetupHost.cs', 'build-source.mjs', '../../fvs-probe-windows-setup.mjs', '../windows/WindowsLifecycle.cs']) assert.ok(policy.sourceFiles.some(x => x.name === name && /^[a-f0-9]{64}$/.test(x.sha256)), name);
  assert.equal(policy.reviewedArtifacts['probe-lean'].files.length + policy.reviewedArtifacts['probe-lean'].runtimeSelection.excludedBuildTraces.length, 100);
  assert(policy.reviewedArtifacts['probe-lean'].files.every(x => !x.relativePath.endsWith('.trace')));
  assert.ok(Object.isFrozen(policy));
});
test('Windows aliases and non-local paths fail before reading files', async () => {
  const { plainWindowsPath } = await runtime;
  for (const p of ['C:relative', '\\rooted', '\\\\server\\share\\file', 'C:\\a\\..\\b', 'C:\\a\\NUL.txt', 'C:\\a\\COM¹.txt', 'C:\\a\\trailing.', 'C:\\a\\space ', 'C:\\a\\x:stream']) assert.throws(() => plainWindowsPath(p, { allowMissing: true }), /path|spelling|required/i, p);
});
test('native helper selection matches managed and exact Lean version precedence', { skip: !native }, async t => {
  const m = await runtime, root = fixture(t), profile = path.join(root, 'profile'), bin = path.join(root, 'path-bin');
  for (const name of ['probe-rust', 'scip', 'rust-analyzer', 'rustup', 'cargo', 'rustc', 'lean', 'lake', 'git']) write(path.join(bin, name + '.exe'));
  write(path.join(profile, '.cargo', 'bin', 'probe-rust.exe'));
  write(path.join(profile, '.probe-rust', 'tools', 'scip.exe'));
  write(path.join(profile, '.probe-rust', 'tools', 'rust-analyzer.exe'));
  const found = m.selectWindowsHelpers({ profileDirectory: profile, environment: { PATH: bin, PATHEXT: '.EXE' }, leanToolchain: 'leanprover/lean4:v4.31.0' });
  assert.equal(found['probe-rust'], path.join(bin, 'probe-rust.exe'));
  assert.equal(found.scip, path.join(profile, '.probe-rust', 'tools', 'scip.exe'));
  assert.equal(found['rust-analyzer'], path.join(profile, '.probe-rust', 'tools', 'rust-analyzer.exe'));
  assert.equal(found['probe-lean'], path.join(profile, '.local', 'bin', 'probe-lean-v4.31.0.exe'));
  assert.equal(fs.existsSync(found['probe-lean']), false, 'must not silently fall back to unversioned PATH binary');
  fs.mkdirSync(path.join(profile, '.local', 'lib', 'lean'), { recursive: true });
  assert.throws(() => m.selectWindowsHelpers({ profileDirectory: profile, environment: { PATH: bin }, leanToolchain: 'leanprover/lean4:v4.31.0' }), /additional upstream/);
});
test('resource fingerprints are path-independent and reject hardlinks/junctions', { skip: !native }, async t => {
  const m = await runtime, root = fixture(t), a = path.join(root, 'a'), b = path.join(root, 'b');
  write(path.join(a, 'nested', 'x.txt'), 'same bytes'); write(path.join(b, 'nested', 'x.txt'), 'same bytes');
  assert.deepEqual(m.fingerprintWindowsResource(a), m.fingerprintWindowsResource(b));
  fs.writeFileSync(path.join(b, 'nested', 'x.txt'), 'different bytes');
  assert.notEqual(m.fingerprintWindowsResource(a).sha256, m.fingerprintWindowsResource(b).sha256);
  fs.linkSync(path.join(a, 'nested', 'x.txt'), path.join(root, 'hardlink.txt'));
  assert.throws(() => m.fingerprintWindowsResource(a), /Link\/special/);
  fs.unlinkSync(path.join(root, 'hardlink.txt'));
  fs.symlinkSync(a, path.join(root, 'junction'), 'junction');
  assert.throws(() => m.fingerprintWindowsResource(path.join(root, 'junction')), /Link or special/);
});

test('registered receipts reject alteration, same-version executable bytes, and adjacent DLL changes', { skip: !native, timeout: 60000 }, async t => {
  const m = await runtime, root = fixture(t), facts = m.getWindowsHostFacts(), policy = m.getWindowsSourcePolicy();
  const cp = require('node:child_process'), { syncBuiltinESMExports } = require('node:module'), original = cp.spawnSync;
  const fake = { ...facts, profile: path.join(root, 'profile') }; fs.mkdirSync(fake.profile);
  cp.spawnSync = (exe, args, options) => args?.some(x => String(x).includes('FVS_HOST_FACTS_SOURCE')) ? { status: 0, stdout: JSON.stringify(fake), stderr: '' } : original(exe, args, options); syncBuiltinESMExports();
  try {
    const toolsRoot = path.join(root, 'tools'), base = m.windowsInstallRoot({ toolsRoot, facts: fake }), id = 'a'.repeat(32), bundle = path.join(base, 'installations', id);
    m.createWindowsManagedDirectory(base, fake); m.createWindowsManagedDirectory(bundle, fake);
    const probe = path.join(bundle, 'probe.exe'), launcher = path.join(bundle, 'launcher', 'fvs-windows-launcher.exe'), dll = path.join(bundle, 'lib', 'runtime.dll');
    write(probe, 'probe-aeneas 0.20.0\napproved fixture'); write(launcher); write(dll, 'approved adjacent bytes');
    const file = p => ({ relativePath: path.relative(bundle, p), sha256: m.windowsFileSha256(p), bytes: fs.statSync(p).size });
    const builds = Object.fromEntries(Object.entries(policy.reviewedArtifacts).map(([name, artifact]) => [name, { origin: 'reviewed-existing-artifact', source: artifact.source, historicalEvidenceSha256: artifact.evidenceSha256, approvedFiles: artifact.files, output: { sha256: 'a'.repeat(64) } }]));
    builds.launcher = { protocol: 'fvs/windows-native/v2', testHooks: false };
    const receipt = { schema: 'fvs/windows-source-install/v1', installationId: id, distributionId: policy.id, policySha256: policy.sha256, target: policy.target, state: 'complete', profileDirectory: fake.profile, userSid: fake.userSid, builds, artifacts: { 'probe-aeneas': file(probe), launcher: file(launcher) }, resources: [{ id: 'dll', relativePath: 'lib', ...m.fingerprintWindowsResource(path.dirname(dll)) }] };
    const receiptPath = path.join(bundle, 'INSTALL.json');
    const register = () => { receipt.policySha256 = m.getWindowsSourcePolicy().sha256; write(receiptPath, JSON.stringify(receipt)); write(path.join(base, 'receipts', id + '.json'), JSON.stringify({ installationId: id, receiptSha256: m.windowsFileSha256(receiptPath) })); };
    write(path.join(base, 'CURRENT.json'), JSON.stringify({ installationId: id })); register();
    fs.appendFileSync(receiptPath, ' ');
    assert.equal(m.resolveWindowsRuntime({ toolsRoot }).diagnostics[0].code, 'receipt-invalid');
    assert.throws(() => m.reusableWindowsGroups({ toolsRoot, facts: fake }), /registered digest/);
    register(); write(probe, 'probe-aeneas 0.20.0\nunrecognized fixture');
    assert.equal(m.resolveWindowsRuntime({ toolsRoot }).diagnostics[0].code, 'artifact-mismatch');
    assert.throws(() => m.reusableWindowsGroups({ toolsRoot, facts: fake }), /Registered runtime failed validation/);
    register(); write(probe, 'probe-aeneas 0.20.0\napproved fixture'); write(dll, 'different adjacent bytes');
    const events = []; assert.equal(m.resolveWindowsRuntime({ toolsRoot, onProgress: event => events.push(event) }).diagnostics[0].code, 'resource-mismatch');
    assert.ok(events.some(x => x.phase === 'hash-resource-start')); assert.ok(events.every(x => typeof x.elapsedMs === 'number'));
    // Historical recovery uses the immutable registered launcher even when helpers
    // are corrupt or the current source recipe has subsequently changed.
    receipt.policySha256 = 'f'.repeat(64); write(receiptPath, JSON.stringify(receipt)); write(path.join(base, 'receipts', id + '.json'), JSON.stringify({ installationId: id, receiptSha256: m.windowsFileSha256(receiptPath) }));
    const recovery = m.resolveWindowsRecoveryLauncher({ toolsRoot }); assert.equal(recovery.ok, true, JSON.stringify(recovery)); assert.equal(m.assertValidatedWindowsLauncher(recovery.launcher).path, launcher);
    const coordinator = path.join(fake.profile, '.fvs', 'windows-confinement'); m.createWindowsManagedDirectory(coordinator, fake);
    const sessionId = 'b'.repeat(32); write(path.join(coordinator, 'active.json'), JSON.stringify({ schema: 'fvs/windows-lifecycle-journal/v2', sessionId, launcherPath: launcher, launcherSha256: receipt.artifacts.launcher.sha256 }));
    const beforeTools = process.env.FVS_TOOLS_HOME; process.env.FVS_TOOLS_HOME = path.join(root, 'different-tools');
    try { for (const options of [{ sessionId }, {}]) { const retained = m.resolveWindowsRecoveryLauncher(options); assert.equal(retained.ok, true, JSON.stringify(retained)); assert.equal(retained.launcher.path, launcher); } } finally { if (beforeTools === undefined) delete process.env.FVS_TOOLS_HOME; else process.env.FVS_TOOLS_HOME = beforeTools; }
  } finally { cp.spawnSync = original; syncBuiltinESMExports(); }
});

test('first-install interrupted setup is authoritative before receipt lookup and across tools-home changes', { skip: !native, timeout: 30000 }, async t => {
  const m = await runtime, root = fixture(t), facts = m.getWindowsHostFacts(), cp = require('node:child_process'), { syncBuiltinESMExports } = require('node:module'), original = cp.spawnSync;
  const fake = { ...facts, profile: path.join(root, 'profile') }; fs.mkdirSync(fake.profile);
  cp.spawnSync = (exe, args, options) => args?.some(x => String(x).includes('FVS_HOST_FACTS_SOURCE')) ? { status: 0, stdout: JSON.stringify(fake), stderr: '' } : original(exe, args, options); syncBuiltinESMExports();
  try {
    const base = m.windowsInstallRoot({ toolsRoot: path.join(root, 'original-tools'), facts: fake }), coordinator = path.join(fake.profile, '.fvs', 'windows-confinement'); m.createWindowsManagedDirectory(base, fake); m.createWindowsManagedDirectory(coordinator, fake);
    const stat = fs.lstatSync(base, { bigint: true }), id = 'c'.repeat(32), marker = { schema: 'fvs/windows-source-setup-active/v1', installationId: id, sessionId: 'setup:' + id, userSid: fake.userSid, originSessionId: fake.host.originSessionId, originLogonId: fake.host.originLogonId, root: base, rootIdentity: { dev: String(stat.dev), ino: String(stat.ino) }, journalPath: path.join(base, 'SETUP.json') };
    const canonical = value => value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
    marker.integritySha256 = require('node:crypto').createHash('sha256').update(canonical(marker)).digest('hex'); const file = path.join(coordinator, 'setup-active.json'); write(file, JSON.stringify(marker));
    const result = m.resolveWindowsRuntime({ toolsRoot: path.join(root, 'changed-tools') }); assert.equal(result.status, 'incompatible'); assert.equal(result.recovery.sessionId, marker.sessionId); assert.equal(result.diagnostics[0].code, 'setup-recovery-required');
    assert.equal(fs.existsSync(path.join(base, 'CURRENT.json')), false); assert.equal(fs.existsSync(path.join(root, 'changed-tools')), false);
    marker.integritySha256 = '0'.repeat(64); write(file, JSON.stringify(marker)); const malformed = m.resolveWindowsRuntime(); assert.equal(malformed.status, 'incompatible'); assert.equal(malformed.diagnostics[0].code, 'setup-recovery-invalid');
  } finally { cp.spawnSync = original; syncBuiltinESMExports(); }
});
