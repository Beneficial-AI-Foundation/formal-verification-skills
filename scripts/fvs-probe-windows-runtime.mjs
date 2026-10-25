// Windows source-build identities and selection. This module never installs or
// grants ACLs. Native confinement must validate/lease paths before execution.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WINDOWS_SOURCE_QUALIFICATION } from './fvs-probe-windows-qualification.mjs';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
export const windowsSourceAssets = path.join(scriptRoot, 'fvs-probe-native', 'windows-source');
const policyFile = path.join(windowsSourceAssets, 'policy.json');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const approved = readJson(policyFile);
const runtimeBrands = new WeakSet();
const launcherBrands = new WeakSet();
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const diagnostic = (code, message, extra = {}) => ({ code, message, ...extra });
export class WindowsRuntimeError extends Error {
  constructor(code, message, extra = {}) { super(message); this.name = 'WindowsRuntimeError'; this.diagnostic = diagnostic(code, message, extra); }
}
function fail(code, message, extra) { throw new WindowsRuntimeError(code, message, extra); }
export function freezeWindowsValue(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const item of Object.values(value)) freezeWindowsValue(item); Object.freeze(value); }
  return value;
}
export const WINDOWS_SOURCE_DISTRIBUTION = freezeWindowsValue({ id: approved.id, target: approved.target, version: approved.version, qualified: WINDOWS_SOURCE_QUALIFICATION.qualified, origin: 'source-build', recipe: 'fvs-probe-native/windows-source/policy.json' });
export function windowsFileSha256(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) fail('unsupported-layout', `Expected a regular file: ${file}`);
    const digest = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) !== 0) digest.update(buffer.subarray(0, count));
    const after = fs.fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) fail('resource-changed', `File changed while hashing: ${file}`);
    return digest.digest('hex');
  } finally { fs.closeSync(fd); }
}
export function getWindowsSourcePolicy() {
  const files = fs.readdirSync(windowsSourceAssets).filter(name => /\.(?:json|patch|mjs|ps1|cs)$/.test(name)).sort();
  const sourceFiles = files.map(name => ({ name, sha256: windowsFileSha256(path.join(windowsSourceAssets, name)) }));
  const nativeRoot = path.join(scriptRoot, 'fvs-probe-native', 'windows');
  for (const name of ['NativeMethods.cs', 'NativeExtra.cs', 'VerifiedPrivateLeafCleanup.cs', 'FvsWindowsLauncher.cs', 'WindowsLifecycle.cs', 'Build-Launcher.ps1']) {
    const file = path.join(nativeRoot, name);
    sourceFiles.push({ name: '../windows/' + name, sha256: fs.existsSync(file) ? windowsFileSha256(file) : null });
  }
  for (const name of ['fvs-probe-windows-runtime.mjs', 'fvs-probe-windows-setup.mjs', 'fvs-probe-windows-sandbox.mjs']) sourceFiles.push({ name: '../../' + name, sha256: windowsFileSha256(path.join(scriptRoot, name)) });
  for (const [name, expected] of Object.entries(approved.patches)) if (sourceFiles.find(x => x.name === name).sha256 !== expected) fail('policy-corrupt', `Bundled patch digest differs: ${name}`);
  return freezeWindowsValue({ ...approved, sourceFiles, sha256: sha(JSON.stringify(sourceFiles)), reviewedArtifacts: readJson(path.join(windowsSourceAssets, 'reviewed-artifacts.json')).groups });
}
export function assertWindowsHost() {
  if (process.platform !== 'win32' || process.arch !== 'x64' || !['x86_64', 'amd64'].includes(os.machine().toLowerCase())) fail('unsupported-host', 'The Windows source distribution requires native Windows x64 Node and operating system.');
}
export function getWindowsHostFacts() {
  assertWindowsHost();
  // Derive the OS directory from a loaded OS module, not PATH/SystemRoot/HOME.
  const kernel = process.report.getReport().sharedObjects.find(file => /[\\/]system32[\\/]kernel32\.dll$/i.test(file));
  if (!kernel) fail('known-folders-unavailable', 'Cannot identify the loaded native Windows system directory.');
  const systemDirectory = path.dirname(kernel);
  const powershell = path.join(systemDirectory, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Add-Type -Path $env:FVS_HOST_FACTS_SOURCE -ReferencedAssemblies System.Web.Extensions,System.Core;$hostFacts=[FvsSourceSetupHost]::HostFacts(); [pscustomobject]@{host=$hostFacts;profile=[Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile);localAppData=[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData);programFiles=[Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles);programFilesX86=[Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86);fixedDrives=@([IO.DriveInfo]::GetDrives() | Where-Object {$_.DriveType -eq 'Fixed'} | ForEach-Object {$_.Name});userSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value} | ConvertTo-Json -Compress";
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { env: { ...process.env, FVS_HOST_FACTS_SOURCE: path.join(windowsSourceAssets, 'SetupHost.cs') }, windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) fail(/requires Windows 11 client/.test(result.stderr ?? '') ? 'unsupported-host' : 'known-folders-unavailable', `Native known-folder lookup failed: ${result.error?.message ?? result.stderr}`);
  let facts;
  try { facts = JSON.parse(result.stdout.replace(/^\uFEFF/, '')); } catch { fail('known-folders-unavailable', 'Native known-folder lookup returned invalid JSON.'); }
  if (!facts.profile || !facts.localAppData || !facts.userSid || !Array.isArray(facts.fixedDrives)) fail('known-folders-unavailable', 'Native known-folder lookup was incomplete.');
  const host = facts.host;
  if (!host || host.major !== 10 || host.minor !== 0 || host.productType !== 1 || host.build < 22000 || host.build > 29999 || host.processorArchitecture !== 9 || host.nativeMachine !== 0x8664 || host.processMachine !== 0 || host.pointerBits !== 64) fail('unsupported-host', 'The source distribution requires Windows 11 client build 22000..29999 on native AMD64 without emulation.');
  return freezeWindowsValue({ ...facts, systemDirectory, windowsDirectory: path.dirname(systemDirectory), powershell });
}
export function plainWindowsPath(file, { allowMissing = false, fixedDrives = null } = {}) {
  if (typeof file !== 'string' || !/^[A-Za-z]:[\\/]/.test(file)) fail('unsupported-layout', `An absolute local drive path is required: ${file}`);
  const normalized = file.replaceAll('/', '\\');
  const parts = normalized.slice(3).split('\\');
  if (parts.some(part => !part || part === '.' || part === '..' || /[\x00-\x1f:<>"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) fail('unsupported-layout', `Unsupported Windows spelling: ${file}`);
  if (fixedDrives && !fixedDrives.some(d => d.toLowerCase() === normalized.slice(0, 3).toLowerCase())) fail('unsupported-layout', `A fixed local drive is required: ${file}`);
  let current = normalized.slice(0, 3), missing = false;
  for (const part of parts) {
    current = path.win32.join(current, part);
    if (missing) continue;
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat && allowMissing) { missing = true; continue; }
    if (!stat) fail('missing-resource', `Required path is missing: ${current}`, { path: current });
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) fail('unsupported-layout', `Link or special path is unsupported: ${current}`, { path: current });
    if (fs.realpathSync.native(current).toLowerCase() !== current.toLowerCase()) fail('unsupported-layout', `Path alias is unsupported: ${current}`, { path: current });
  }
  return normalized;
}
export function fingerprintWindowsResource(root) {
  plainWindowsPath(root);
  const entries = [];
  function visit(file, relative) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) fail('unsupported-layout', `Link/special resource is unsupported: ${file}`);
    if (fs.realpathSync.native(file).toLowerCase() !== file.toLowerCase()) fail('unsupported-layout', `Resource alias is unsupported: ${file}`);
    if (stat.isDirectory()) {
      entries.push([relative, 'directory']);
      for (const name of fs.readdirSync(file).sort()) {
        if (/[. ]$/.test(name) || /[\x00-\x1f:<>"|?*]/.test(name)) fail('unsupported-layout', `Unsupported resource name: ${name}`);
        visit(path.join(file, name), relative ? `${relative}/${name}` : name);
      }
    } else entries.push([relative, 'file', stat.size, windowsFileSha256(file)]);
  }
  visit(root, '');
  return { sha256: sha(JSON.stringify(entries)), entries: entries.length, files: entries.filter(x => x[1] === 'file').length, bytes: entries.reduce((sum, x) => sum + (x[1] === 'file' ? x[2] : 0), 0) };
}
function exists(file) { return fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined; }
function firstOnPath(name, environment) {
  const extensions = (environment.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const directory of (environment.PATH ?? '').split(';').filter(Boolean)) {
    if (!path.win32.isAbsolute(directory)) fail('unsupported-layout', 'Relative PATH entries cannot be used by a verified runtime.');
    for (const extension of extensions) {
      const candidate = path.win32.join(directory, name + extension.toLowerCase());
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}
export function selectWindowsHelpers({ profileDirectory, environment, leanToolchain }) {
  const version = leanToolchain?.match(/^leanprover\/lean4:(v[0-9]+\.[0-9]+\.[0-9]+)$/)?.[1];
  if (!version) fail('unsupported-toolchain', 'A supported exact Lean toolchain is required.');
  for (const alternate of [path.win32.join(profileDirectory, '.local', 'lib', 'lean'), path.win32.join(profileDirectory, '.local', 'lib', 'probe-lean')]) if (exists(alternate)) fail('unsupported-library-layout', `An additional upstream probe-lean library search root exists: ${alternate}`, { path: alternate });
  const managed = name => {
    const candidate = path.win32.join(profileDirectory, '.probe-rust', 'tools', name + '.exe');
    return exists(candidate) ? candidate : firstOnPath(name, environment);
  };
  const cargoFallback = path.win32.join(profileDirectory, '.cargo', 'bin', 'probe-rust.exe');
  return {
    'probe-rust': firstOnPath('probe-rust', environment) ?? (exists(cargoFallback) ? cargoFallback : null),
    scip: managed('scip'), 'rust-analyzer': managed('rust-analyzer'),
    'probe-lean': path.win32.join(profileDirectory, '.local', 'bin', `probe-lean-${version}.exe`),
    libraryPath: path.win32.join(profileDirectory, '.local', 'lib', `probe-lean-${version}`),
    rustup: firstOnPath('rustup', environment), cargo: firstOnPath('cargo', environment), rustc: firstOnPath('rustc', environment),
    lean: firstOnPath('lean', environment), lake: firstOnPath('lake', environment), git: firstOnPath('git', environment),
  };
}
export function windowsInstallRoot({ toolsRoot, facts = getWindowsHostFacts() } = {}) {
  const tools = toolsRoot ?? process.env.FVS_TOOLS_HOME ?? path.join(facts.profile, '.fvs', 'tools');
  return plainWindowsPath(path.join(tools, 'windows-source', approved.id), { allowMissing: true, fixedDrives: facts.fixedDrives });
}
export function checkWindowsManagedDirectory(directory, facts, { initialize = false } = {}) {
  plainWindowsPath(directory, { fixedDrives: facts.fixedDrives });
  const script = "$ErrorActionPreference='Stop'; $p=$env:FVS_MANAGED_DIRECTORY; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; if($env:FVS_INITIALIZE_ACL -eq '1'){$a=New-Object Security.AccessControl.DirectorySecurity;$a.SetOwner($sid);$a.SetAccessRuleProtection($true,$false);foreach($id in @($sid.Value,'S-1-5-18','S-1-5-32-544')){$r=New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.SecurityIdentifier]::new($id),'FullControl','ContainerInherit,ObjectInherit','None','Allow');$a.AddAccessRule($r)};[IO.Directory]::SetAccessControl($p,$a)};$a=[IO.Directory]::GetAccessControl($p);$ok=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $sid.Value;foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Value -notin @($sid.Value,'S-1-5-18','S-1-5-32-544')){$ok=$false}};if(!$ok){throw 'Managed directory owner or DACL permits an unexpected principal'};[pscustomobject]@{owner=$sid.Value;acl=$a.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner,Access')}|ConvertTo-Json -Compress";
  const result = spawnSync(facts.powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, FVS_MANAGED_DIRECTORY: directory, FVS_INITIALIZE_ACL: initialize ? '1' : '0' }, windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0 || result.error) fail('managed-directory-untrusted', `Managed directory security is unavailable or too broad: ${directory}: ${result.error?.message ?? result.stderr.trim()}`);
  return JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
}
export function createWindowsManagedDirectory(directory, facts) {
  plainWindowsPath(directory, { allowMissing: true, fixedDrives: facts.fixedDrives });
  if (!fs.existsSync(directory)) {
    const script = "$ErrorActionPreference='Stop';$p=$env:FVS_MANAGED_DIRECTORY;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$a=New-Object Security.AccessControl.DirectorySecurity;$a.SetOwner($sid);$a.SetAccessRuleProtection($true,$false);foreach($id in @($sid.Value,'S-1-5-18','S-1-5-32-544')){$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule([Security.Principal.SecurityIdentifier]::new($id),'FullControl','ContainerInherit,ObjectInherit','None','Allow')))};[IO.Directory]::CreateDirectory($p,$a)|Out-Null";
    const result = spawnSync(facts.powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, FVS_MANAGED_DIRECTORY: directory }, windowsHide: true, encoding: 'utf8', timeout: 30000 });
    if (result.status !== 0 || result.error) fail('managed-directory-untrusted', `Cannot create a private managed directory: ${result.error?.message ?? result.stderr}`);
  }
  return checkWindowsManagedDirectory(directory, facts);
}
function installedReceipt({ toolsRoot, facts, installationId, historical = false } = {}) {
  const base = windowsInstallRoot({ toolsRoot, facts });
  const pointer = path.join(base, 'CURRENT.json');
  if (!installationId) {
    if (!exists(pointer)) fail('runtime-missing', 'The reviewed Windows source runtime has not been set up.');
    plainWindowsPath(pointer);
    const current = readJson(pointer);
    installationId = current.installationId;
  }
  if (!/^[a-f0-9]{32}$/.test(installationId ?? '')) fail('receipt-invalid', 'Invalid managed installation identifier.');
  checkWindowsManagedDirectory(base, facts);
  const bundle = plainWindowsPath(path.join(base, 'installations', installationId));
  checkWindowsManagedDirectory(bundle, facts);
  const file = plainWindowsPath(path.join(bundle, 'INSTALL.json'));
  const receipt = readJson(file), policy = getWindowsSourcePolicy();
  const registration = plainWindowsPath(path.join(base, 'receipts', installationId + '.json'));
  const registered = readJson(registration);
  if (registered.installationId !== installationId || registered.receiptSha256 !== windowsFileSha256(file)) fail('receipt-invalid', 'The managed installation receipt differs from its registered digest.');
  if (receipt.schema !== 'fvs/windows-source-install/v1' || receipt.installationId !== installationId || receipt.distributionId !== policy.id || (!historical && receipt.policySha256 !== policy.sha256) || receipt.target !== policy.target || receipt.state !== 'complete' || receipt.profileDirectory.toLowerCase() !== facts.profile.toLowerCase() || receipt.userSid !== facts.userSid) fail('receipt-invalid', 'The managed receipt does not match the built-in distribution, account, or source recipe.');
  if (!receipt.builds || ['probe-aeneas', 'probe-rust', 'probe-lean', 'scip', 'rustup', 'launcher'].some(name => !receipt.builds[name])) fail('receipt-invalid', 'The managed receipt lacks required build provenance.');
  for (const name of historical ? [] : ['probe-aeneas', 'probe-rust', 'probe-lean', 'scip', 'rustup']) {
    const build = receipt.builds[name], source = policy.sources[name];
    if (!['fresh-source-build', 'reviewed-existing-artifact'].includes(build.origin) || build.source?.repository !== source.repository || build.source?.commit !== source.commit || !/^[a-f0-9]{64}$/.test(build.output?.sha256 ?? '')) fail('receipt-invalid', `Source-build provenance is invalid: ${name}`);
    if (build.origin === 'reviewed-existing-artifact') {
      const approvedArtifact = policy.reviewedArtifacts[name];
      if (build.historicalEvidenceSha256 !== approvedArtifact.evidenceSha256 || JSON.stringify(build.approvedFiles) !== JSON.stringify(approvedArtifact.files) || JSON.stringify(build.source) !== JSON.stringify(approvedArtifact.source)) fail('receipt-invalid', `Historical artifact identity is not approved: ${name}`);
    } else if (!Array.isArray(build.source.entries) || !build.source.entries.length || build.source.entries.some(entry => typeof entry.relativePath !== 'string' || path.isAbsolute(entry.relativePath) || entry.relativePath.split(/[\\/]/).some(x => !x || x === '..' || x === '.') || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? ''))) fail('receipt-invalid', `Fresh build source manifest is invalid: ${name}`);
  }
  return { base, bundle, receipt, policy };
}
function verifyArtifact(bundle, item) {
  if (!item || typeof item.relativePath !== 'string' || path.isAbsolute(item.relativePath) || item.relativePath.split(/[\\/]/).some(x => !x || x === '.' || x === '..')) fail('receipt-invalid', 'Invalid relative artifact path.');
  const file = plainWindowsPath(path.join(bundle, item.relativePath));
  if (!/^[a-f0-9]{64}$/.test(item.sha256 ?? '') || windowsFileSha256(file) !== item.sha256 || fs.statSync(file).size !== item.bytes) fail('artifact-mismatch', `Managed artifact changed: ${file}`);
  return file;
}
export function assertValidatedWindowsLauncher(launcher) {
  if (!launcherBrands.has(launcher)) fail('unvalidated-launcher', 'A launcher resolved from the managed source-build receipt is required.');
  return launcher;
}
export function assertValidatedWindowsRuntime(runtime) {
  if (!runtimeBrands.has(runtime)) fail('unvalidated-runtime', 'A runtime resolved by the built-in Windows source policy is required.');
  return runtime;
}
function launcherFromInstallation(install, { historical = false } = {}) {
  const { bundle, receipt, policy } = install;
  const artifact = receipt.artifacts.launcher;
  if (receipt.builds.launcher.testHooks !== false || receipt.builds.launcher.protocol !== 'fvs/windows-native/v2') fail('launcher-build-invalid', 'A distribution launcher without test hooks is required.');
  const sourceRecords = policy.sourceFiles.filter(item => item.name.startsWith('../windows/') && item.name.endsWith('.cs')).map(item => ({ name: path.basename(item.name), sha256: item.sha256 })).sort((a,b) => a.name < b.name ? -1 : 1);
  const sourceSet = sha(sourceRecords.map(item => item.name + '\0' + item.sha256 + '\n').join(''));
  if (!historical && receipt.builds.launcher.sourceSetSha256 !== sourceSet) fail('launcher-build-invalid', 'The installed launcher does not match current bundled native sources.');
  const launcher = { path: verifyArtifact(bundle, artifact), sha256: artifact.sha256, installationId: receipt.installationId, policyId: policy.id, policySha256: receipt.policySha256, protocol: 'fvs/windows-native/v2', historical };
  launcherBrands.add(launcher);
  return freezeWindowsValue(launcher);
}
function unavailable(error) {
  return { ok: false, status: ['runtime-missing', 'missing-resource'].includes(error.diagnostic?.code) ? 'missing' : 'incompatible', diagnostics: [error.diagnostic ?? diagnostic('runtime-invalid', error.message)] };
}
export function resolveWindowsRecoveryLauncher({ sessionId, toolsRoot } = {}) {
  try {
    const facts = getWindowsHostFacts();
    if (sessionId != null && !/^[a-zA-Z0-9-]{1,96}$/.test(sessionId)) fail('invalid-session', 'Invalid session ID.');
    const coordinator = path.join(facts.profile, '.fvs', 'windows-confinement');
    const active = path.join(coordinator, 'active.json');
    let activeJournal = null;
    if (fs.existsSync(active)) { checkWindowsManagedDirectory(coordinator, facts); plainWindowsPath(active); activeJournal = readJson(active); }
    if (activeJournal && (sessionId || !['disposed', 'recovered'].includes(activeJournal.phase))) {
      checkWindowsManagedDirectory(coordinator, facts); plainWindowsPath(active);
      const journal = activeJournal;
      if (journal.schema !== 'fvs/windows-lifecycle-journal/v2' || !/^[a-f0-9]{32}$/.test(journal.sessionId ?? '') || (sessionId && journal.sessionId !== sessionId) || !/^[a-f0-9]{64}$/.test(journal.launcherSha256 ?? '')) fail('invalid-session', 'The requested session does not match the authoritative native journal.');
      // The authoritative journal locates the retained installation, independently
      // of a subsequently changed tools-home setting. It never authorizes bytes:
      // the protected managed root and registered receipt do, and native recovery
      // authenticates the full journal before any mutation.
      const responsiblePath = plainWindowsPath(journal.launcherPath, { fixedDrives: facts.fixedDrives });
      const launcherDirectory = path.dirname(responsiblePath), bundle = path.dirname(launcherDirectory), installationId = path.basename(bundle);
      const installations = path.dirname(bundle), base = path.dirname(installations), historicalToolsRoot = path.dirname(path.dirname(base));
      if (path.basename(responsiblePath) !== 'fvs-windows-launcher.exe' || path.basename(launcherDirectory) !== 'launcher' || path.basename(installations) !== 'installations' || !/^[a-f0-9]{32}$/.test(installationId) || windowsInstallRoot({ toolsRoot: historicalToolsRoot, facts }).toLowerCase() !== base.toLowerCase()) fail('recovery-launcher-missing', 'The responsible launcher is outside the managed installation layout.');
      const install = installedReceipt({ toolsRoot: historicalToolsRoot, facts, installationId, historical: true });
      const artifact = install.receipt.artifacts.launcher;
      if (artifact.sha256 !== journal.launcherSha256 || path.join(install.bundle, artifact.relativePath).toLowerCase() !== responsiblePath.toLowerCase()) fail('recovery-launcher-missing', 'The exact registered launcher responsible for this session is unavailable.');
      return { ok: true, status: 'ready', diagnostics: [], launcher: launcherFromInstallation(install, { historical: true }) };
    }
    // Status and completed-session recovery can use the current managed launcher,
    // independently of helper integrity. Native code authenticates session state.
    const install = installedReceipt({ toolsRoot, facts, historical: true });
    return { ok: true, status: 'ready', diagnostics: [], launcher: launcherFromInstallation(install, { historical: true }) };
  } catch (error) { return unavailable(error); }
}
function pendingWindowsSetup(facts) {
  const coordinator = path.join(facts.profile, '.fvs', 'windows-confinement'), file = path.join(coordinator, 'setup-active.json');
  if (!fs.existsSync(file)) return null;
  try {
    checkWindowsManagedDirectory(coordinator, facts); plainWindowsPath(file);
    if (fs.statSync(file).size > 1024 * 1024) throw new Error('Setup marker exceeds its size limit.');
    const marker = readJson(file), { integritySha256, ...body } = marker;
    const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
    if (integritySha256 !== sha(canonical(body)) || marker.schema !== 'fvs/windows-source-setup-active/v1' || marker.userSid !== facts.userSid || !/^[a-f0-9]{32}$/.test(marker.installationId ?? '') || marker.sessionId !== 'setup:' + marker.installationId) throw new Error('Setup marker identity or integrity differs.');
    const root = plainWindowsPath(marker.root, { fixedDrives: facts.fixedDrives });
    if (path.basename(root) !== approved.id || path.basename(path.dirname(root)) !== 'windows-source' || marker.journalPath !== path.join(root, 'SETUP.json')) throw new Error('Setup marker is outside a managed source root.');
    checkWindowsManagedDirectory(root, facts); const stat = fs.lstatSync(root, { bigint: true });
    if (marker.rootIdentity?.dev !== String(stat.dev) || marker.rootIdentity?.ino !== String(stat.ino)) throw new Error('Setup root identity changed.');
    return { sessionId: marker.sessionId, sameLogon: marker.originSessionId === facts.host.originSessionId && marker.originLogonId === facts.host.originLogonId };
  } catch (error) { fail('setup-recovery-invalid', `Authoritative setup marker requires inspection: ${error.message}`); }
}
export function resolveWindowsRuntime({ projectRoot, distributionId = approved.id, toolsRoot, onProgress } = {}) {
  const started = Date.now();
  const progress = event => { try { onProgress?.({ ...event, elapsedMs: Date.now() - started }); } catch {} };
  try {
    progress({ phase: 'validate-runtime-start' });
    if (distributionId !== approved.id) fail('unsupported-distribution', `Unknown Windows source distribution: ${distributionId}`);
    const facts = getWindowsHostFacts(), pendingSetup = pendingWindowsSetup(facts);
    if (pendingSetup) return { ok: false, status: 'incompatible', diagnostics: [diagnostic(pendingSetup.sameLogon ? 'setup-recovery-required' : 'cross-logon-recovery-unqualified', 'An interrupted source setup requires recovery in its originating logon before new work.')], recovery: pendingSetup };
    const install = installedReceipt({ toolsRoot, facts });
    const { receipt, bundle, policy } = install;
    if (projectRoot) plainWindowsPath(path.resolve(projectRoot), { fixedDrives: facts.fixedDrives });
    if (projectRoot) {
      if (path.resolve(projectRoot).toLowerCase() !== receipt.project.projectRoot.toLowerCase()) fail('project-setup-required', 'Set up this project explicitly; the current dependency receipt belongs to a different project.');
      for (const [file, expected] of [[receipt.project.cargoLock, receipt.project.cargoLockSha256], [receipt.project.translationJson, receipt.project.translationSha256], [path.join(projectRoot, 'aeneas-config.yml'), receipt.project.configSha256], [path.join(projectRoot, 'lake-manifest.json'), receipt.project.lakeManifestSha256]]) if (windowsFileSha256(plainWindowsPath(file)) !== expected) fail('project-setup-required', 'Project dependency/provenance inputs changed; rerun explicit setup.');
    }
    const artifacts = Object.fromEntries(Object.entries(receipt.artifacts).map(([name, item]) => [name, { ...item, path: verifyArtifact(bundle, item) }]));
    const resources = receipt.resources.map(resource => {
      const resourcePath = resource.relativePath ? path.join(bundle, resource.relativePath) : resource.path;
      plainWindowsPath(resourcePath, { fixedDrives: facts.fixedDrives });
      const resourceStarted = Date.now(); progress({ phase: 'hash-resource-start', resource: resource.id, path: resourcePath });
      if (fingerprintWindowsResource(resourcePath).sha256 !== resource.sha256) fail('resource-mismatch', `Protected runtime resource changed: ${resourcePath}`);
      progress({ phase: 'hash-resource-complete', resource: resource.id, resourceElapsedMs: Date.now() - resourceStarted });
      return { ...resource, path: resourcePath };
    });
    if (new Set(resources.map(r => r.id)).size !== resources.length) fail('receipt-invalid', 'Duplicate runtime resource IDs.');
    const byResource = Object.fromEntries(resources.map(r => [r.id, r.path]));
    const required = ['rustup-home', 'cargo-home', 'vendor', 'lean-bin', 'lean-lib', 'probe-lean-lib', 'msvc-bin', 'msvc-lib', 'sdk-ucrt', 'sdk-um', 'git-bin', 'proxy-bin', 'probe-bin'];
    for (const id of required) if (!byResource[id]) fail('receipt-invalid', `Missing runtime resource: ${id}`);
    if (receipt.builds['probe-lean'].origin === 'reviewed-existing-artifact') {
      for (const file of policy.reviewedArtifacts['probe-lean'].files) {
        const actual = file.relativePath.startsWith('bin/') ? path.join(facts.profile, '.local', file.relativePath) : path.join(byResource['probe-lean-lib'], file.relativePath.slice(4));
        if (windowsFileSha256(plainWindowsPath(actual)) !== file.sha256 || fs.statSync(actual).size !== file.bytes) fail('artifact-mismatch', `Historical Lean runtime file differs from approved bytes: ${actual}`);
      }
    }
    const localBin = path.join(facts.profile, '.local', 'bin');
    const environment = {
      PATH: [byResource['proxy-bin'], byResource['probe-bin'], localBin, byResource['lean-bin'], byResource['git-bin'], byResource['msvc-bin'], facts.systemDirectory].join(';'),
      PATHEXT: '.EXE', RUSTUP_HOME: byResource['rustup-home'], RUSTUP_TOOLCHAIN: policy.toolchain, RUSTUP_AUTO_INSTALL: '0',
      CARGO_HOME: byResource['cargo-home'], CARGO_NET_OFFLINE: 'true', CARGO_BUILD_JOBS: '2', LEAN_NUM_THREADS: '4',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_OPTIONAL_LOCKS: '0',
      LIB: [byResource['msvc-lib'], byResource['sdk-ucrt'], byResource['sdk-um']].join(';'),
    };
    const selected = selectWindowsHelpers({ profileDirectory: facts.profile, environment, leanToolchain: policy.leanToolchain });
    const helpers = {};
    for (const name of ['probe-rust', 'scip', 'probe-lean', 'rust-analyzer', 'rustup', 'cargo', 'rustc', 'lean', 'lake', 'git']) {
      const expected = receipt.helpers[name];
      const expectedPath = expected.relativePath ? path.join(bundle, expected.relativePath) : expected.path;
      if (!selected[name] || selected[name].toLowerCase() !== expectedPath.toLowerCase()) fail('helper-shadowed', `Upstream would select a different ${name} helper.`, { helper: name, selected: selected[name], expected: expectedPath });
      plainWindowsPath(expectedPath, { fixedDrives: facts.fixedDrives });
      if (windowsFileSha256(expectedPath) !== expected.sha256) fail('helper-mismatch', `Selected helper changed: ${name}`, { helper: name, path: expectedPath });
      helpers[name] = { path: expectedPath, sha256: expected.sha256 };
    }
    for (const name of ['probe-aeneas', 'probe-rust', 'scip']) if (receipt.builds[name].origin === 'reviewed-existing-artifact') {
      const artifact = name === 'probe-aeneas' ? artifacts[name] : helpers[name];
      if (artifact.sha256 !== policy.reviewedArtifacts[name].files[0].sha256) fail('artifact-mismatch', `Historical executable differs from approved bytes: ${name}`);
    }
    if (receipt.builds.rustup.origin === 'reviewed-existing-artifact') for (const helper of ['rustup', 'rust-analyzer', 'cargo', 'rustc']) if (helpers[helper].sha256 !== policy.reviewedArtifacts.rustup.files[0].sha256) fail('artifact-mismatch', 'Historical Rustup proxy differs from approved bytes.');
    if (selected.libraryPath.toLowerCase() !== byResource['probe-lean-lib'].toLowerCase()) fail('helper-shadowed', 'The actual versioned probe-lean library directory differs from the receipt.');
    const launcher = launcherFromInstallation(install);
    if (receipt.versions.length !== policy.versions.length) fail('receipt-invalid', 'Version checks do not cover the approved runtime.');
    const versions = policy.versions.map(approvedVersion => {
      const matches = receipt.versions.filter(version => version.name === approvedVersion.name);
      const artifact = approvedVersion.name === 'probe-aeneas' ? artifacts['probe-aeneas'] : helpers[approvedVersion.helper];
      if (matches.length !== 1 || matches[0].expected !== approvedVersion.expected || JSON.stringify(matches[0].args) !== JSON.stringify(approvedVersion.args) || matches[0].sha256 !== artifact.sha256) fail('receipt-invalid', `Version identity differs from approved policy: ${approvedVersion.name}`);
      return { ...approvedVersion, sha256: artifact.sha256, executable: artifact.path };
    });
    const runtime = {
      target: policy.target, distributionId: policy.id, policyId: policy.id, policySha256: policy.sha256, installationId: receipt.installationId,
      launcher, probePath: artifacts['probe-aeneas'].path, rustupPath: helpers.rustup.path, helpers, artifacts, environment,
      readOnlyPaths: resources.map(r => r.path), versionReadOnlyPaths: resources.filter(r => r.versionCheck).map(r => r.path),
      resources,
      executablePaths: [...new Set([artifacts['probe-aeneas'].path, ...Object.values(helpers).map(x => x.path)])],
      libraryPath: byResource['probe-lean-lib'], libraries: [byResource['probe-lean-lib']], versions, profileDirectory: facts.profile,
      sourceBuildReceipt: path.join(bundle, 'INSTALL.json'), projectRoot: projectRoot ? path.resolve(projectRoot) : null,
      systemDirectory: facts.systemDirectory, powershell: facts.powershell,
      limitations: receipt.limitations,
    };
    runtimeBrands.add(runtime);
    progress({ phase: 'validate-runtime-complete' });
    return { ok: true, status: 'ready', diagnostics: [], runtime: freezeWindowsValue(runtime) };
  } catch (error) { progress({ phase: 'validate-runtime-failed', code: error.diagnostic?.code }); return unavailable(error); }
}
