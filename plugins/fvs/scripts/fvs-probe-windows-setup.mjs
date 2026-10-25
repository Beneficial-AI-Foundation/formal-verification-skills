// Explicit source setup. Receipts are local installer records, not signatures
// against the account owner. No caller policy, binary hash, or receipt import.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  WINDOWS_SOURCE_DISTRIBUTION, WindowsRuntimeError, getWindowsHostFacts,
  getWindowsSourcePolicy, windowsInstallRoot, plainWindowsPath,
  fingerprintWindowsResource, windowsFileSha256, windowsSourceAssets,
  checkWindowsManagedDirectory,
  createWindowsManagedDirectory,
} from './fvs-probe-windows-runtime.mjs';
import { buildWindowsGroups, copyIndependent, copyPrerequisiteIndependent, unpackArchive } from './fvs-probe-native/windows-source/build-source.mjs';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const fail = (code, message) => { throw new WindowsRuntimeError(code, message); };
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
function observedIdentity(file, directory = false) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) fail('setup-recovery-conflict', `Unexpected filesystem object: ${file}`);
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}
function requireIdentity(file, expected, directory = false) {
  if (!expected || JSON.stringify(observedIdentity(file, directory)) !== JSON.stringify(expected)) fail('setup-recovery-conflict', `Owned path was substituted or its identity is unavailable: ${file}`);
}
function flushFile(file) { const fd = fs.openSync(file, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function flushFiles(directory) { for (const name of fs.readdirSync(directory)) { const file = path.join(directory, name); const stat = fs.lstatSync(file); if (stat.isDirectory()) flushFiles(file); else { plainWindowsPath(file); flushFile(file); } } }
function atomicJson(file, value) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(temp, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function setupMarkerPath(facts) { return path.join(facts.profile, '.fvs', 'windows-confinement', 'setup-active.json'); }
function readSetupMarker(facts) {
  const file = setupMarkerPath(facts);
  if (!fs.existsSync(file)) return null;
  checkWindowsManagedDirectory(path.dirname(file), facts); plainWindowsPath(file);
  if (fs.statSync(file).size > 1024 * 1024) fail('setup-recovery-invalid', 'Authoritative setup marker exceeds its size limit.');
  const marker = readJson(file), { integritySha256, ...body } = marker;
  if (integritySha256 !== sha(canonicalJson(body)) || marker.schema !== 'fvs/windows-source-setup-active/v1' || marker.userSid !== facts.userSid || !/^[a-f0-9]{32}$/.test(marker.installationId ?? '') || marker.sessionId !== 'setup:' + marker.installationId) fail('setup-recovery-invalid', 'Authoritative setup marker identity or integrity differs.');
  if (marker.originSessionId !== facts.host.originSessionId || marker.originLogonId !== facts.host.originLogonId) fail('cross-logon-recovery-unqualified', 'Alternate-logon setup recovery is unqualified; return to the originating Windows logon and session.');
  const root = plainWindowsPath(marker.root, { fixedDrives: facts.fixedDrives });
  if (path.basename(root) !== WINDOWS_SOURCE_DISTRIBUTION.id || path.basename(path.dirname(root)) !== 'windows-source' || marker.journalPath !== path.join(root, 'SETUP.json')) fail('setup-recovery-invalid', 'Authoritative setup marker does not identify a managed source root.');
  checkWindowsManagedDirectory(root, facts); requireIdentity(root, marker.rootIdentity, true);
  return marker;
}
function writeSetupMarker(root, installationId, facts, policySha256) {
  if (fs.existsSync(setupMarkerPath(facts))) fail('setup-recovery-required', 'An authoritative source setup marker already requires recovery.');
  const body = { schema: 'fvs/windows-source-setup-active/v1', sessionId: 'setup:' + installationId, installationId, userSid: facts.userSid, originSessionId: facts.host.originSessionId, originLogonId: facts.host.originLogonId, root, rootIdentity: observedIdentity(root, true), journalPath: path.join(root, 'SETUP.json'), policySha256, createdAt: new Date().toISOString() };
  atomicJson(setupMarkerPath(facts), { ...body, integritySha256: sha(canonicalJson(body)) });
}
function clearSetupMarker(root, installationId, facts) {
  const marker = readSetupMarker(facts);
  if (!marker || marker.root !== root || marker.installationId !== installationId) fail('setup-recovery-conflict', 'Authoritative setup marker changed before completion.');
  fs.unlinkSync(setupMarkerPath(facts));
}
function creationTag() { const bytes = crypto.randomBytes(16); return 'S-1-5-21-' + [0, 4, 8, 12].map(offset => bytes.readUInt32LE(offset)).join('-'); }
function creationOperations(lease, root, facts, journal, save, commands = []) {
  async function invoke(operation, destination, tag, source = '', directory = false) {
    const log = path.join(root, `setup-operation-${journal.installationId}-${crypto.randomBytes(8).toString('hex')}`);
    journal.auditLogs ??= []; journal.auditLogs.push(log); save();
    const command = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Add-Type -Path $env:FVS_CREATION_SOURCE;switch($env:FVS_CREATION_OPERATION){'directory'{[FvsSetupCreation]::CreateDirectory($env:FVS_CREATION_DESTINATION,$env:FVS_CREATION_TAG)}'copy'{[FvsSetupCreation]::CopyFile($env:FVS_CREATION_INPUT,$env:FVS_CREATION_DESTINATION,$env:FVS_CREATION_TAG)}'remove'{[FvsSetupCreation]::RemoveIncomplete($env:FVS_CREATION_DESTINATION,$env:FVS_CREATION_TAG,($env:FVS_CREATION_DIRECTORY -eq '1'))}default{throw 'Unknown creation operation'}}";
    const args = ['-NoProfile', '-NonInteractive', '-Command', command], environment = { SYSTEMROOT: facts.windowsDirectory, WINDIR: facts.windowsDirectory, PATH: facts.systemDirectory, TEMP: root, TMP: root, FVS_CREATION_SOURCE: path.join(windowsSourceAssets, 'SetupCreation.cs'), FVS_CREATION_OPERATION: operation, FVS_CREATION_DESTINATION: destination, FVS_CREATION_TAG: tag, FVS_CREATION_INPUT: source, FVS_CREATION_DIRECTORY: directory ? '1' : '0' };
    const started = Date.now(), result = await lease.execute({ executable: facts.powershell, args, cwd: root, environment, log });
    commands.push({ label: 'creation-' + operation, executable: facts.powershell, executableSha256: windowsFileSha256(facts.powershell), args, environment, cwd: root, elapsedMs: Date.now() - started, exitCode: result.exitCode, activeProcessesAfter: result.activeProcessesAfter, log });
    if (!result.ok || result.activeProcessesAfter !== 0) fail('setup-creation-failed', `Tagged ${operation} failed: ${result.error ?? result.stderr}`);
  }
  return { directory: (file, tag) => invoke('directory', file, tag), copy: (source, destination, tag) => invoke('copy', destination, tag, source), remove: (file, tag, directory) => invoke('remove', file, tag, '', directory) };
}
function projectPath(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) fail('unknown-provenance', 'Project configuration needs a relative path.');
  const resolved = path.resolve(root, relative), part = path.relative(root, resolved);
  if (part === '..' || part.startsWith('..' + path.sep) || path.isAbsolute(part)) fail('unknown-provenance', 'Project configuration escapes its root.');
  return plainWindowsPath(resolved);
}
export function readWindowsSourceProject(projectRoot) {
  const root = plainWindowsPath(path.resolve(projectRoot));
  const configFile = path.join(root, 'aeneas-config.yml');
  const text = fs.readFileSync(configFile, 'utf8');
  const values = {}, wanted = new Set(['aeneas.commit', 'crate.dir', 'aeneas_args.dest']);
  let section = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const top = line.match(/^([a-zA-Z_][\w-]*):\s*(?:#.*)?$/);
    if (top) { section = top[1]; continue; }
    if (/^\S/.test(line)) { section = null; continue; }
    const item = line.match(/^  ([a-zA-Z_][\w-]*):\s*(.*?)\s*$/);
    if (!item || !wanted.has(`${section}.${item[1]}`)) continue;
    const key = `${section}.${item[1]}`;
    if (key in values || !item[2] || /^[[{|>&*!]/.test(item[2])) fail('unknown-provenance', `Unsupported or duplicate configuration key: ${key}`);
    values[key] = item[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  const rustProject = projectPath(root, values['crate.dir'] ?? '.');
  const translationJson = path.join(projectPath(root, values['aeneas_args.dest'] ?? '.'), 'translation.json');
  const translation = readJson(translationJson);
  const manifestFile = path.join(root, 'lake-manifest.json'), manifest = readJson(manifestFile);
  const aeneas = manifest.packages?.filter(x => x.name === 'aeneas') ?? [];
  const leanToolchain = fs.readFileSync(path.join(root, 'lean-toolchain'), 'utf8').trim();
  const pin = '6e167c9b63a4dafd66d0e0edd9d94669f957ff7b';
  if (aeneas.length !== 1 || aeneas[0].rev !== pin || !/^[a-f0-9]{8,40}$/.test(values['aeneas.commit'] ?? '') || !pin.startsWith(values['aeneas.commit']) || !/^[a-f0-9]{8,40}$/.test(translation.aeneas_version ?? '') || !pin.startsWith(translation.aeneas_version) || translation.charon_version !== '0.1.225' || leanToolchain !== 'leanprover/lean4:v4.31.0') fail('unsupported-provenance', 'This source recipe supports only Aeneas 6e167c9b, Charon 0.1.225, and Lean v4.31.0.');
  const cargoLock = fs.existsSync(path.join(root, 'Cargo.lock')) ? path.join(root, 'Cargo.lock') : path.join(rustProject, 'Cargo.lock');
  if (!fs.existsSync(cargoLock)) fail('dependencies-unprepared', 'Prepare the Cargo.lock with cargo fetch before explicit Windows setup.');
  return { projectRoot: root, rustProject, translationJson, translationSha256: windowsFileSha256(translationJson), aeneasRev: pin, charonVersion: '0.1.225', leanToolchain, cargoLock, cargoLockSha256: windowsFileSha256(cargoLock), configSha256: windowsFileSha256(configFile), lakeManifestSha256: windowsFileSha256(manifestFile) };
}
function discoverPrerequisites(facts, policy) {
  const command = "$ErrorActionPreference='Stop'; $v=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)) 'Microsoft Visual Studio\\Installer\\vswhere.exe'; $vs=$null;if(Test-Path -LiteralPath $v){$vs=(& $v -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)}; $sdk=(Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots' -ErrorAction SilentlyContinue).KitsRoot10; $git=(Get-Command git.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source; [pscustomobject]@{vs=$vs;sdk=$sdk;git=$git} | ConvertTo-Json -Compress";
  const result = spawnSync(facts.powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0 || result.error) fail('prerequisite-unavailable', 'Cannot inspect native build prerequisites.');
  const discovered = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
  const toolchainRoot = path.join(facts.profile, '.rustup', 'toolchains', policy.toolchain);
  const vcRoot = discovered.vs && path.join(discovered.vs, 'VC', 'Tools', 'MSVC', policy.msvcVersion);
  const prerequisites = { git: discovered.git, vsDevCmd: discovered.vs && path.join(discovered.vs, 'Common7', 'Tools', 'VsDevCmd.bat'), toolchainRoot, cargo: path.join(toolchainRoot, 'bin', 'cargo.exe'), rustc: path.join(toolchainRoot, 'bin', 'rustc.exe'), vcRoot, sdkRoot: discovered.sdk, compiler: path.join(facts.windowsDirectory, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe') };
  if (prerequisites.git) {
    const gitDirectory = path.dirname(prerequisites.git);
    const gitRoot = path.basename(gitDirectory).toLowerCase() === 'cmd' ? path.dirname(gitDirectory) : path.basename(gitDirectory).toLowerCase() === 'bin' && ['ucrt64', 'mingw64'].includes(path.basename(path.dirname(gitDirectory)).toLowerCase()) ? path.dirname(path.dirname(gitDirectory)) : null;
    const layout = gitRoot && ['ucrt64', 'mingw64'].find(name => fs.existsSync(path.join(gitRoot, name, 'bin', 'git.exe')));
    if (!layout) fail('unsupported-prerequisite-layout', 'The source recipe requires a canonical Git for Windows ucrt64 or mingw64 installation.');
    prerequisites.gitRoot = gitRoot; prerequisites.gitRuntimeBin = path.join(gitRoot, layout, 'bin');
  }
  const missing = Object.entries(prerequisites).filter(([, file]) => !file || !fs.existsSync(file)).map(([name]) => name);
  return { ...prerequisites, missing };
}
export function planWindowsSetup({ projectRoot, distributionId = WINDOWS_SOURCE_DISTRIBUTION.id, toolsRoot, cacheDirectory } = {}) {
  if (distributionId !== WINDOWS_SOURCE_DISTRIBUTION.id) fail('unsupported-distribution', 'Unknown Windows source distribution.');
  const facts = getWindowsHostFacts(), policy = getWindowsSourcePolicy(), project = readWindowsSourceProject(projectRoot);
  const root = windowsInstallRoot({ toolsRoot, facts });
  const contains = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); };
  if (contains(project.projectRoot, root) || contains(root, project.projectRoot)) fail('unsupported-layout', 'The managed source installation and project must be disjoint to avoid copying an active setup into its own project staging.');
  if (cacheDirectory) plainWindowsPath(path.resolve(cacheDirectory));
  const prerequisites = discoverPrerequisites(facts, policy);
  const authoritative = readSetupMarker(facts);
  const pending = authoritative ?? (fs.existsSync(path.join(root, 'SETUP.json')) ? readJson(path.join(root, 'SETUP.json')) : null);
  const recovery = pending && /^[a-f0-9]{32}$/.test(pending.installationId ?? '') ? { sessionId: 'setup:' + pending.installationId } : null;
  return { schema: 'fvs/windows-source-setup-plan/v1', distributionId, target: policy.target, policySha256: policy.sha256, verified: false, root, profileDirectory: facts.profile, host: facts.host, project, prerequisites, recovery, cacheDirectory: cacheDirectory ? path.resolve(cacheDirectory) : null, installationScope: 'Separate FVS source bundle; absent or byte-identical actual-profile Lean helper/library/DLL copies only', consentRequired: true, changes: ['Create isolated source/build/cache directories', 'Compile approved source recipes or reuse exact built-in historical artifacts', 'Create independent linker, Rustup proxy and runtime library copies', 'Publish an immutable managed receipt and required known-folder copies with a recovery journal'], exclusions: ['No replacement of official Rustup, existing helpers, or the official FVS release', 'No profile/ACL grant during setup; native execution checks belong to resolver acceptance'], trustBoundary: 'Receipts are local installer records, not signatures against the account owner.' };
}
function removePrivateTree(root, expectedParent) {
  const absolute = path.resolve(root), parent = path.resolve(expectedParent);
  if (path.dirname(absolute).toLowerCase() !== parent.toLowerCase()) fail('setup-recovery-invalid', 'Refusing cleanup outside the exact setup parent.');
  function unlink(file) {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false }); if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) fs.unlinkSync(file);
    else { for (const name of fs.readdirSync(file)) unlink(path.join(file, name)); fs.rmdirSync(file); }
  }
  unlink(absolute);
}
async function lockSetup(root, facts) {
  createWindowsManagedDirectory(root, facts);
  const coordinator = path.join(facts.profile, '.fvs', 'windows-confinement');
  createWindowsManagedDirectory(coordinator, facts);
  createWindowsManagedDirectory(path.join(coordinator, 's'), facts);
  const coordinatorLock = path.join(coordinator, 'lifecycle.lock'), activeJournal = path.join(coordinator, 'active.json');
  plainWindowsPath(coordinatorLock, { allowMissing: true }); plainWindowsPath(activeJournal, { allowMissing: true });
  const lock = path.join(root, 'setup.lock');
  plainWindowsPath(lock, { allowMissing: true });
  const hostCommand = "$ErrorActionPreference='Stop'; Add-Type -Path $env:FVS_SETUP_HOST_SOURCE -ReferencedAssemblies System.Web.Extensions,System.Core; exit [FvsSourceSetupHost]::Run($env:FVS_SETUP_LOCK,$env:FVS_COORDINATOR_LOCK,$env:FVS_ACTIVE_JOURNAL)";
  const guard = spawn(facts.powershell, ['-NoProfile', '-NonInteractive', '-Command', hostCommand], { env: { ...process.env, FVS_SETUP_HOST_SOURCE: path.join(windowsSourceAssets, 'SetupHost.cs'), FVS_SETUP_LOCK: lock, FVS_COORDINATOR_LOCK: coordinatorLock, FVS_ACTIVE_JOURNAL: activeJournal }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => guard.once('close', resolve));
  const pending = new Map();
  let buffer = '', readyResolve, readyReject, ready = false, errors = '';
  guard.stderr.on('data', data => { errors = (errors + data.toString()).slice(-8192); });
  guard.stdout.on('data', data => {
    buffer += data.toString();
    for (;;) {
      const newline = buffer.indexOf('\n'); if (newline < 0) break;
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message; try { message = JSON.parse(line); } catch { readyReject?.(new Error('Invalid native setup host response')); continue; }
      if (!ready) { if (message.ready) { ready = true; readyResolve?.(); } else readyReject?.(new WindowsRuntimeError('setup-busy', message.error ?? 'Another setup holds the lease.')); }
      else if (pending.has(message.id)) { const item = pending.get(message.id); pending.delete(message.id); item.resolve(message); }
    }
  });
  guard.on('close', () => { const error = new WindowsRuntimeError('setup-host-exited', `Native setup host exited: ${errors}`); readyReject?.(error); for (const item of pending.values()) item.reject(error); pending.clear(); });
  await new Promise((resolve, reject) => {
    let settled = false;
    const done = (error) => { if (settled) return; settled = true; clearTimeout(timer); if (error) { guard.stdin.end(); reject(error); } else resolve(); };
    const timer = setTimeout(() => { guard.stdin.end(); done(new WindowsRuntimeError('setup-lock-unavailable', 'Native setup host initialization timed out.')); }, 30000);
    readyResolve = () => done(); readyReject = done; guard.once('error', done);
  });
  return {
    execute(command) { return new Promise((resolve, reject) => { const id = crypto.randomUUID(); pending.set(id, { resolve, reject }); guard.stdin.write(JSON.stringify({ ...command, id, operation: 'execute' }) + '\n', error => { if (error) { pending.delete(id); reject(error); } }); }); },
    async release() { guard.stdin.end(JSON.stringify({ operation: 'release' }) + '\n'); await closed; },
  };
}
async function journalPaths(root, journal, facts, creation) {
  if (journal.schema !== 'fvs/windows-source-setup-journal/v1' || journal.userSid !== facts.userSid || !/^[a-f0-9]{32}$/.test(journal.installationId)) fail('setup-recovery-invalid', 'Invalid setup journal identity.');
  if (journal.originSessionId !== facts.host.originSessionId || journal.originLogonId !== facts.host.originLogonId) fail('cross-logon-recovery-unqualified', 'The setup journal belongs to another Windows logon or session.');
  const stage = path.join(root, 'staging', journal.installationId), bundle = path.join(root, 'installations', journal.installationId);
  if (journal.stage !== stage || journal.bundle !== bundle) fail('setup-recovery-invalid', 'Setup journal paths differ from managed paths.');
  for (const item of journal.publications) {
    const local = path.join(facts.profile, '.local');
    const relative = path.relative(local, item.path);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !['bin', 'lib'].includes(relative.split(path.sep)[0])) fail('setup-recovery-invalid', 'Unrecognized setup publication path.');
    const allowed = new Set(getWindowsSourcePolicy().reviewedArtifacts['probe-lean'].files.map(file => file.relativePath.startsWith('bin/') ? file.relativePath : 'lib/probe-lean-v4.31.0/' + file.relativePath.slice(4)));
    if (!allowed.has(relative.replaceAll('\\', '/'))) fail('setup-recovery-invalid', 'Publication path is outside the fixed helper/library file set.');
    plainWindowsPath(path.dirname(item.path), { allowMissing: true });
    if (item.temporary && (path.dirname(item.temporary) !== path.dirname(item.path) || !/^\.fvs-source-[a-f0-9]{32}\.tmp$/.test(path.basename(item.temporary)))) fail('setup-recovery-invalid', 'Invalid private publication temporary path.');
  }
  for (const item of journal.createdDirectories) {
    const directory = item.path;
    const relative = path.relative(path.join(facts.profile, '.local'), directory);
    if (relative.startsWith('..') || path.isAbsolute(relative)) fail('setup-recovery-invalid', 'Invalid created-directory cleanup path.');
  }
  if (fs.existsSync(stage)) { plainWindowsPath(stage); if (journal.stageIdentity) requireIdentity(stage, journal.stageIdentity, true); else if (journal.stageCreationTag) { requireIdentity(path.dirname(stage), journal.stageParentIdentity, true); await creation.remove(stage, journal.stageCreationTag, true); } else fail('setup-recovery-conflict', 'Private stage has neither a saved identity nor an atomic creation tag.'); }
  if (fs.existsSync(bundle)) { plainWindowsPath(bundle); requireIdentity(bundle, journal.bundleIdentity, true); }
  return { stage, bundle };
}
async function recoverSetupJournal(root, facts, lease) {
  const file = path.join(root, 'SETUP.json');
  if (!fs.existsSync(file)) return { ok: true, status: 'nothing-to-recover' };
  plainWindowsPath(file);
  const journal = readJson(file), save = () => atomicJson(file, journal), creation = creationOperations(lease, root, facts, journal, save);
  const { stage, bundle } = await journalPaths(root, journal, facts, creation);
  const pointer = path.join(root, 'CURRENT.json');
  const committed = fs.existsSync(pointer) && readJson(pointer).installationId === journal.installationId && fs.existsSync(path.join(bundle, 'INSTALL.json'));
  if (committed) requireRegisteredCompletion(root, journal.installationId, facts);
  if (!committed) {
    // Intent precedes exclusive publication. Adopted files are never removed.
    for (const item of [...journal.publications].reverse()) {
      if (item.adopted) continue;
      if (fs.existsSync(item.path)) {
        const stat = fs.lstatSync(item.path);
        requireIdentity(item.path, item.identity);
        if (stat.isSymbolicLink() || windowsFileSha256(item.path) !== item.sha256 || stat.size !== item.bytes) fail('setup-recovery-conflict', `A publication does not match the owned identity; retain it: ${item.path}`);
        fs.unlinkSync(item.path);
      }
      if (item.temporary && fs.existsSync(item.temporary)) {
        const stat = fs.lstatSync(item.temporary);
        if (stat.isSymbolicLink() || !stat.isFile()) fail('setup-recovery-conflict', `Private publication temporary changed: ${item.temporary}`);
        if (item.identity) { requireIdentity(item.temporary, item.identity); fs.unlinkSync(item.temporary); }
        else if (item.creationTag) { requireIdentity(path.dirname(item.temporary), item.parentIdentity, true); await creation.remove(item.temporary, item.creationTag, false); }
        else fail('setup-recovery-conflict', 'Private publication temporary lacks its identity and atomic creation tag.');
      }
    }
    for (const item of [...journal.createdDirectories].reverse()) {
      const directory = item.path;
      if (!fs.existsSync(directory)) continue;
      plainWindowsPath(directory);
      if (item.identity) { requireIdentity(directory, item.identity, true); if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory); }
      else if (item.creationTag) { requireIdentity(path.dirname(directory), item.parentIdentity, true); await creation.remove(directory, item.creationTag, true); }
      else fail('setup-recovery-conflict', 'Created directory lacks its identity and atomic creation tag.');
    }
    if (fs.existsSync(bundle)) removePrivateTree(bundle, path.join(root, 'installations'));
    if (fs.existsSync(pointer) && readJson(pointer).installationId === journal.installationId) {
      if (journal.previousCurrent) atomicJson(pointer, journal.previousCurrent); else fs.unlinkSync(pointer);
    }
  }
  if (fs.existsSync(stage)) removePrivateTree(stage, path.join(root, 'staging'));
  const completed = { schema: 'fvs/windows-source-setup-recovery/v1', installationId: journal.installationId, status: committed ? 'committed-cleaned' : 'rolled-back', auditLogs: journal.auditLogs ?? [], recoveredAt: new Date().toISOString() };
  fs.mkdirSync(path.join(root, 'recovered'), { recursive: true });
  atomicJson(path.join(root, 'recovered', journal.installationId + '.json'), completed);
  fs.unlinkSync(file);
  return { ok: true, status: committed ? 'committed-cleaned' : 'rolled-back', installationId: journal.installationId };
}
function requireRegisteredCompletion(root, installationId, facts) {
  const receiptPath = plainWindowsPath(path.join(root, 'installations', installationId, 'INSTALL.json'));
  const registration = readJson(plainWindowsPath(path.join(root, 'receipts', installationId + '.json'))), receipt = readJson(receiptPath);
  if (registration.installationId !== installationId || registration.receiptSha256 !== windowsFileSha256(receiptPath) || receipt.installationId !== installationId || receipt.state !== 'complete' || receipt.userSid !== facts.userSid || receipt.profileDirectory !== facts.profile) fail('setup-recovery-conflict', 'Completed setup receipt differs from its registered identity.');
}
export async function recoverWindowsSetup({ sessionId, toolsRoot } = {}) {
  if (!/^setup:[a-f0-9]{32}$/.test(sessionId ?? '')) fail('invalid-session', 'Setup recovery requires its exact setup:SESSION_ID.');
  const installationId = sessionId.slice(6);
  const facts = getWindowsHostFacts(), initialMarker = readSetupMarker(facts);
  if (initialMarker && initialMarker.sessionId !== sessionId) fail('invalid-session', 'The requested session does not match the authoritative setup marker.');
  const root = initialMarker?.root ?? windowsInstallRoot({ toolsRoot, facts });
  if (initialMarker && toolsRoot && windowsInstallRoot({ toolsRoot, facts }) !== root) fail('invalid-session', 'The explicit tools root differs from the authoritative setup recovery root.');
  if (!fs.existsSync(root)) return { ok: false, status: 'not-found', sessionId };
  const unlock = await lockSetup(root, facts);
  try {
    const marker = readSetupMarker(facts);
    if (marker && (marker.sessionId !== sessionId || marker.root !== root)) fail('invalid-session', 'The authoritative setup marker changed before recovery acquired its lease.');
    const journal = path.join(root, 'SETUP.json');
    if (fs.existsSync(journal)) {
      if (readJson(journal).installationId !== installationId) fail('invalid-session', 'The requested session does not match the pending setup journal.');
      const result = await recoverSetupJournal(root, facts, unlock); if (marker) clearSetupMarker(root, installationId, facts); return { ...result, sessionId };
    }
    const recovered = path.join(root, 'recovered', installationId + '.json');
    if (marker && fs.existsSync(path.join(root, 'staging', installationId))) fail('setup-recovery-conflict', 'Private setup stage remains without its durable journal.');
    if (fs.existsSync(recovered)) { if (marker) clearSetupMarker(root, installationId, facts); return { ok: true, status: 'already-recovered', previous: readJson(recovered).status, sessionId }; }
    const receipt = path.join(root, 'installations', installationId, 'INSTALL.json');
    if (fs.existsSync(receipt)) { requireRegisteredCompletion(root, installationId, facts); if (marker) clearSetupMarker(root, installationId, facts); return { ok: true, status: 'already-complete', sessionId }; }
    if (marker) {
      if (fs.existsSync(path.join(root, 'staging', installationId)) || fs.existsSync(path.join(root, 'installations', installationId))) fail('setup-recovery-conflict', 'Setup paths exist without the corresponding durable journal.');
      // Crash immediately after the marker but before the setup journal: no
      // stage or publication could have been created by that operation.
      fs.mkdirSync(path.join(root, 'recovered'), { recursive: true });
      atomicJson(path.join(root, 'recovered', installationId + '.json'), { schema: 'fvs/windows-source-setup-recovery/v1', installationId, status: 'empty-intent-cleared', recoveredAt: new Date().toISOString() });
      clearSetupMarker(root, installationId, facts); return { ok: true, status: 'empty-intent-cleared', sessionId };
    }
    return { ok: false, status: 'not-found', sessionId };
  } finally { await unlock.release(); }
}
async function ensureDirectory(directory, journal, save, creation) {
  if (fs.existsSync(directory)) { plainWindowsPath(directory); return; }
  await ensureDirectory(path.dirname(directory), journal, save, creation);
  const created = { path: directory, identity: null, creationTag: creationTag(), parentIdentity: observedIdentity(path.dirname(directory), true) };
  journal.createdDirectories.push(created); save();
  await creation.directory(directory, created.creationTag); plainWindowsPath(directory);
  created.identity = observedIdentity(directory, true); save();
}
async function publishKnownFile(source, destination, journal, save, creation) {
  const digest = windowsFileSha256(source), bytes = fs.statSync(source).size;
  if (fs.existsSync(destination)) {
    plainWindowsPath(destination);
    if (windowsFileSha256(destination) !== digest || fs.statSync(destination).size !== bytes) fail('helper-conflict', `Existing helper content differs and was preserved: ${destination}`);
    journal.publications.push({ path: destination, sha256: digest, bytes, adopted: true }); save(); return;
  }
  await ensureDirectory(path.dirname(destination), journal, save, creation);
  const temporary = path.join(path.dirname(destination), `.fvs-source-${crypto.randomBytes(16).toString('hex')}.tmp`);
  const record = { path: destination, temporary, sha256: digest, bytes, adopted: false, completed: false, creationTag: creationTag(), parentIdentity: observedIdentity(path.dirname(destination), true) };
  journal.publications.push(record); save();
  await creation.copy(source, temporary, record.creationTag);
  const privateStat = fs.statSync(temporary);
  if (privateStat.nlink !== 1 || windowsFileSha256(temporary) !== digest) fail('publication-mismatch', 'Private publication copy differs.');
  flushFile(temporary);
  record.identity = observedIdentity(temporary); save();
  fs.linkSync(temporary, destination); // Exclusive publication bound to persisted identity.
  record.completed = true; save();
  fs.unlinkSync(temporary);
  plainWindowsPath(destination);
  if (windowsFileSha256(destination) !== digest) fail('publication-mismatch', `Published bytes differ: ${destination}`);
  record.temporaryRemoved = true; save();
}
function filesBelow(directory, prefix = '') {
  if (!fs.existsSync(directory)) return [];
  plainWindowsPath(directory);
  const result = [];
  for (const name of fs.readdirSync(directory).sort()) {
    const file = path.join(directory, name), relative = prefix ? `${prefix}/${name}` : name;
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) result.push(...filesBelow(file, relative));
    else { plainWindowsPath(file); result.push(relative); }
  }
  return result;
}
function copyProjectInputs(source, destination) {
  fs.mkdirSync(destination);
  for (const name of fs.readdirSync(source)) {
    if (['.git', '.lake', 'target', '.verilib', 'data', 'node_modules'].includes(name)) continue;
    const from = path.join(source, name), to = path.join(destination, name);
    const stat = fs.lstatSync(from);
    if (stat.isDirectory()) copyProjectInputs(from, to); else copyIndependent(from, to);
  }
}
function executeFactory(ctx) {
  return async (executable, args, { cwd = ctx.stage, env = {}, label = 'command' } = {}) => {
    const trustedOs = [ctx.facts.powershell, path.join(ctx.facts.systemDirectory, 'tar.exe')].some(file => file.toLowerCase() === executable.toLowerCase());
    if (trustedOs) { if (!fs.statSync(executable).isFile() || fs.realpathSync.native(executable).toLowerCase() !== executable.toLowerCase()) throw new Error('Native OS executable alias'); }
    else plainWindowsPath(executable);
    const log = path.join(ctx.stage, 'logs', label); fs.mkdirSync(path.dirname(log), { recursive: true });
    ctx.onProgress?.({ phase: 'command', label, executable });
    const environment = Object.fromEntries(Object.entries({ ...ctx.environment, ...env }).map(([key,value]) => [key.toUpperCase(), String(value)]));
    const started = Date.now();
    const result = await ctx.lease.execute({ executable, args, cwd, environment, log });
    ctx.commands.push({ label, executable, executableSha256: windowsFileSha256(executable), args, cwd, environment, elapsedMs: Date.now() - started, exitCode: result.exitCode, activeProcessesAfter: result.activeProcessesAfter, log: path.basename(log) });
    if (!result.ok || result.activeProcessesAfter !== 0) throw new Error(`${label} failed (${result.exitCode}): ${result.error ?? result.stderr?.slice(-4000)}; logs ${log}`);
    return { stdout: result.stdout, stderr: result.stderr, log };
  };
}
async function buildEnvironment(facts, prerequisites, stage, lease, commands) {
  fs.mkdirSync(path.join(stage, 'logs'), { recursive: true });
  const base = { SYSTEMROOT: facts.windowsDirectory, WINDIR: facts.windowsDirectory, SYSTEMDRIVE: path.parse(facts.windowsDirectory).root.slice(0,2), COMSPEC: path.join(facts.systemDirectory, 'cmd.exe'), PATH: facts.systemDirectory, PATHEXT: '.COM;.EXE;.BAT;.CMD', OS: 'Windows_NT', PROCESSOR_ARCHITECTURE: 'AMD64', NUMBER_OF_PROCESSORS: '2', USERPROFILE: facts.profile, LOCALAPPDATA: facts.localAppData, PROGRAMFILES: facts.programFiles, 'PROGRAMFILES(X86)': facts.programFilesX86, PROGRAMW6432: facts.programFiles, TEMP: path.join(stage, 'temp'), TMP: path.join(stage, 'temp'), VSCMD_SKIP_SENDTELEMETRY: '1' };
  const executable = path.join(facts.systemDirectory, 'cmd.exe'), args = ['/d', '/s', '/c', `"${prerequisites.vsDevCmd}" -no_logo -arch=x64 -host_arch=x64 >nul && set`], started = Date.now();
  const setup = await lease.execute({ executable, args, cwd: stage, environment: base, log: path.join(stage, 'logs', 'msvc-environment') });
  commands.push({ label: 'msvc-environment', executable, executableSha256: windowsFileSha256(executable), args, cwd: stage, environment: base, elapsedMs: Date.now() - started, exitCode: setup.exitCode, activeProcessesAfter: setup.activeProcessesAfter, log: 'msvc-environment' });
  if (!setup.ok || setup.activeProcessesAfter !== 0) fail('prerequisite-unavailable', `Cannot initialize the pinned MSVC environment: ${setup.error ?? setup.stderr}`);
  const env = {};
  for (const line of setup.stdout.split(/\r?\n/)) { const index = line.indexOf('='); if (index > 0) env[line.slice(0, index)] = line.slice(index + 1); }
  const permitted = /^(INCLUDE|LIB|LIBPATH|VCTOOLSINSTALLDIR|VCTOOLSVERSION|VCTOOLSREDISTDIR|VCINSTALLDIR|VSINSTALLDIR|VISUALSTUDIOVERSION|WINDOWSSDKDIR|WINDOWSSDKVERSION|WINDOWSSDKLIBVERSION|WINDOWSSDKBINPATH|WINDOWSSDKVERBINPATH|UNIVERSALCRTSDKDIR|UCRTVERSION|WINDOWSLIBPATH|DEVENVDIR|VSCMD_VER|VSCMD_ARG_TGT_ARCH|VSCMD_ARG_HOST_ARCH)$/i;
  const vc = Object.fromEntries(Object.entries(env).filter(([key]) => permitted.test(key)).map(([key,value]) => [key.toUpperCase(),value]));
  return { ...base, ...vc, PATH: [path.dirname(prerequisites.cargo), path.dirname(prerequisites.git), path.join(prerequisites.vcRoot, 'bin', 'Hostx64', 'x64'), path.join(prerequisites.sdkRoot, 'bin', '10.0.26100.0', 'x64'), facts.systemDirectory].join(';'), CARGO_HOME: path.join(stage, 'cargo-home'), CARGO_BUILD_JOBS: '2', RUSTC: prerequisites.rustc, RUSTDOC: path.join(prerequisites.toolchainRoot, 'bin', 'rustdoc.exe'), RUSTUP_TOOLCHAIN: '1.98.1-x86_64-pc-windows-msvc', RUSTUP_AUTO_INSTALL: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_OPTIONAL_LOCKS: '0', LEAN_NUM_THREADS: '4' };
}
function fileRecord(bundle, file) { return { relativePath: path.relative(bundle, file).replaceAll('\\', '/'), sha256: windowsFileSha256(file), bytes: fs.statSync(file).size }; }
function externalFile(file) { return { path: file, sha256: windowsFileSha256(file), bytes: fs.statSync(file).size }; }

export async function setupWindowsRuntime({ projectRoot, distributionId, toolsRoot, cacheDirectory, decision, onProgress } = {}) {
  if (!['interactive', 'policy'].includes(decision)) fail('consent-required', 'Source setup requires an explicit consent decision.');
  if (decision === 'policy' && process.env.FVS_PROBE_SETUP_POLICY !== 'build') fail('consent-required', '--consent policy requires FVS_PROBE_SETUP_POLICY=build.');
  const started = Date.now(), phaseTimings = [];
  const progress = event => {
    const now = Date.now();
    const previous = phaseTimings.at(-1); if (previous && previous.elapsedMs === null) previous.elapsedMs = now - previous.started;
    phaseTimings.push({ phase: event.phase, label: event.label ?? event.name ?? null, started: now, elapsedMs: null });
    onProgress?.({ ...event, elapsedMs: now - started });
  };
  progress({ phase: 'plan' });
  const plan = planWindowsSetup({ projectRoot, distributionId, toolsRoot, cacheDirectory });
  if (plan.prerequisites.missing.length) fail('prerequisite-unavailable', `Missing native prerequisites: ${plan.prerequisites.missing.join(', ')}`);
  const facts = getWindowsHostFacts(), policy = getWindowsSourcePolicy(), root = plan.root;
  const unlock = await lockSetup(root, facts);
  const installationId = crypto.randomBytes(16).toString('hex');
  const stage = path.join(root, 'staging', installationId), final = path.join(root, 'installations', installationId), bundle = path.join(stage, 'bundle');
  const journalFile = path.join(root, 'SETUP.json');
  const journal = { schema: 'fvs/windows-source-setup-journal/v1', installationId, userSid: facts.userSid, originSessionId: facts.host.originSessionId, originLogonId: facts.host.originLogonId, stage, bundle: final, stageCreationTag: creationTag(), bundleCreationTag: creationTag(), policySha256: policy.sha256, publications: [], createdDirectories: [], phase: 'intent', startedAt: new Date().toISOString(), previousCurrent: fs.existsSync(path.join(root, 'CURRENT.json')) ? readJson(path.join(root, 'CURRENT.json')) : null };
  const commands = [], save = () => atomicJson(journalFile, journal), creation = creationOperations(unlock, root, facts, journal, save, commands);
  let published = false, ownsJournal = false, ownsMarker = false;
  try {
    const marker = readSetupMarker(facts);
    if (marker) { const error = new WindowsRuntimeError('setup-recovery-required', 'An authoritative source setup requires recovery before new work.'); error.recovery = { sessionId: marker.sessionId }; throw error; }
    if (fs.existsSync(journalFile)) { const pending = readJson(journalFile); const error = new WindowsRuntimeError('setup-recovery-required', 'An interrupted setup journal requires recovery first.'); error.recovery = { sessionId: 'setup:' + pending.installationId }; throw error; }
    writeSetupMarker(root, installationId, facts, policy.sha256);
    ownsMarker = true;
    fs.mkdirSync(path.join(root, 'staging'), { recursive: true }); fs.mkdirSync(path.join(root, 'installations'), { recursive: true });
    journal.stageParentIdentity = observedIdentity(path.dirname(stage), true); journal.bundleFinalParentIdentity = observedIdentity(path.dirname(final), true);
    atomicJson(journalFile, journal);
    ownsJournal = true;
    await creation.directory(stage, journal.stageCreationTag); journal.stageIdentity = observedIdentity(stage, true); journal.bundleParentIdentity = journal.stageIdentity; atomicJson(journalFile, journal);
    await creation.directory(bundle, journal.bundleCreationTag); journal.bundleIdentity = observedIdentity(bundle, true); atomicJson(journalFile, journal);
    fs.mkdirSync(path.join(stage, 'temp'));
    progress({ phase: 'initialize-build-environment' });
    progress({ phase: 'materialize-git-prerequisite' });
    const gitPrivate = path.join(stage, 'git-prerequisite'), gitSourceFiles = copyPrerequisiteIndependent(plan.prerequisites.gitRoot, gitPrivate);
    const privatePrerequisites = { ...plan.prerequisites, git: path.join(gitPrivate, path.relative(plan.prerequisites.gitRoot, plan.prerequisites.git)), gitRuntimeBin: path.join(gitPrivate, path.relative(plan.prerequisites.gitRoot, plan.prerequisites.gitRuntimeBin)) };
    const ctx = { stage, bundle, cacheDirectory: plan.cacheDirectory, policy, facts, prerequisites: privatePrerequisites, onProgress: progress, commands, lease: unlock };
    ctx.environment = await buildEnvironment(facts, privatePrerequisites, stage, unlock, ctx.commands); ctx.run = executeFactory(ctx);
    const rustVersion = (await ctx.run(plan.prerequisites.rustc, ['--version'], { label: 'rust-version' })).stdout.trim();
    if (rustVersion !== 'rustc 1.98.1 (48a229cea 2026-09-01)') fail('unsupported-toolchain', 'The source recipe requires Rust 1.98.1 exactly.');
    const gitVersion = (await ctx.run(privatePrerequisites.git, ['--version'], { label: 'git-version' })).stdout.trim();
    if (gitVersion !== policy.versions.find(version => version.name === 'git').expected) fail('unsupported-toolchain', 'The source recipe requires the reviewed native Git version.');
    const { groups, builds } = await buildWindowsGroups(ctx);
    const probeBin = path.join(bundle, 'probe-bin'), proxyBin = path.join(bundle, 'proxy-bin');
    fs.mkdirSync(probeBin); fs.mkdirSync(proxyBin);
    for (const name of ['probe-aeneas', 'probe-rust', 'scip']) copyIndependent(path.join(groups[name], name + '.exe'), path.join(probeBin, name + '.exe'));
    for (const name of ['rustup', 'cargo', 'rustc', 'rustdoc', 'rust-analyzer', 'rustfmt', 'cargo-fmt', 'cargo-clippy', 'clippy-driver']) copyIndependent(path.join(groups.rustup, 'rustup-init.exe'), path.join(proxyBin, name + '.exe'));
    const leanRoot = await unpackArchive(ctx, 'lean');
    const leanRuntime = path.join(bundle, 'lean'); fs.mkdirSync(leanRuntime);
    copyIndependent(path.join(leanRoot, 'bin'), path.join(leanRuntime, 'bin')); copyIndependent(path.join(leanRoot, 'lib'), path.join(leanRuntime, 'lib'));
    const gitSourceBin = privatePrerequisites.gitRuntimeBin;
    const gitBin = path.join(bundle, 'git-bin'); fs.mkdirSync(gitBin);
    for (const name of fs.readdirSync(gitSourceBin)) if (name.toLowerCase() === 'git.exe' || name.toLowerCase().endsWith('.dll')) copyIndependent(path.join(gitSourceBin, name), path.join(gitBin, name));
    const nativeRoots = {
      'msvc-bin': path.join(plan.prerequisites.vcRoot, 'bin', 'Hostx64', 'x64'), 'msvc-lib': path.join(plan.prerequisites.vcRoot, 'lib', 'x64'),
      'sdk-ucrt': path.join(plan.prerequisites.sdkRoot, 'Lib', policy.sdkVersion, 'ucrt', 'x64'), 'sdk-um': path.join(plan.prerequisites.sdkRoot, 'Lib', policy.sdkVersion, 'um', 'x64'),
    };
    for (const [name, source] of Object.entries(nativeRoots)) { progress({ phase: 'runtime-copy', name }); copyIndependent(source, path.join(bundle, name)); }
    const launcherSources = path.join(scriptRoot, 'fvs-probe-native', 'windows');
    const launcherDirectory = path.join(bundle, 'launcher');
    const launcherRecipe = fs.readFileSync(path.join(launcherSources, 'Build-Launcher.ps1'), 'utf8');
    await ctx.run(facts.powershell, ['-NoProfile', '-NonInteractive', '-Command', `& { ${launcherRecipe}\n} -OutputDirectory $env:FVS_LAUNCHER_OUTPUT -SourceDirectory $env:FVS_LAUNCHER_SOURCES`], { label: 'build-launcher', env: { FVS_LAUNCHER_OUTPUT: launcherDirectory, FVS_LAUNCHER_SOURCES: launcherSources } });
    const launcherFile = path.join(launcherDirectory, 'fvs-windows-launcher.exe');
    const launcherBuild = readJson(path.join(launcherDirectory, 'fvs-windows-launcher.build.json'));
    const nativeSourceNames = ['NativeMethods.cs', 'NativeExtra.cs', 'VerifiedPrivateLeafCleanup.cs', 'FvsWindowsLauncher.cs', 'WindowsLifecycle.cs'].sort();
    const nativeSourceSet = sha(nativeSourceNames.map(name => name + '\0' + windowsFileSha256(path.join(launcherSources, name)) + '\n').join(''));
    if (launcherBuild.schema !== 'fvs/windows-launcher-build/v2' || launcherBuild.testHooks !== false || launcherBuild.protocol !== 'fvs/windows-native/v2' || launcherBuild.sourceSetSha256 !== nativeSourceSet || launcherBuild.launcherSha256 !== windowsFileSha256(launcherFile)) fail('launcher-build-invalid', 'Native launcher build receipt differs from approved sources or produced bytes.');
    builds.launcher = { origin: 'fresh-source-build', ...launcherBuild };

    progress({ phase: 'prepare-locked-dependencies' });
    const projectCopy = path.join(stage, 'project-inputs'); copyProjectInputs(plan.project.projectRoot, projectCopy);
    const copyManifest = path.join(projectCopy, path.relative(plan.project.projectRoot, plan.project.rustProject), 'Cargo.toml');
    const vendor = path.join(bundle, 'vendor');
    const vendored = await ctx.run(plan.prerequisites.cargo, ['vendor', '--locked', '--versioned-dirs', '--manifest-path', copyManifest, vendor], { cwd: projectCopy, label: 'vendor-project' });
    const cargoHome = path.join(bundle, 'cargo-home'); fs.mkdirSync(cargoHome);
    const finalVendor = path.join(final, 'vendor').replaceAll('\\', '/');
    const vendorConfig = vendored.stdout.replaceAll(vendor.replaceAll('\\', '/'), finalVendor).replaceAll(vendor.replaceAll('\\', '\\\\'), finalVendor);
    if (!vendorConfig.includes(finalVendor)) fail('vendor-config-invalid', 'Cargo vendor did not produce the expected source replacement.');
    fs.writeFileSync(path.join(cargoHome, 'config.toml'), vendorConfig + '\n[net]\noffline = true\n');
    fs.writeFileSync(path.join(cargoHome, '.package-cache'), ''); fs.writeFileSync(path.join(cargoHome, '.package-cache-mutate'), '');
    if (windowsFileSha256(plan.project.cargoLock) !== plan.project.cargoLockSha256 || windowsFileSha256(path.join(plan.project.projectRoot, 'aeneas-config.yml')) !== plan.project.configSha256) fail('project-changed', 'Project dependency/provenance inputs changed during setup.');

    if (getWindowsSourcePolicy().sha256 !== policy.sha256) fail('policy-changed', 'Bundled source or recipe files changed during setup; retry after they are stable.');
    journal.phase = 'publishing-known-folder'; save();
    const leanGroup = groups['probe-lean'];
    const expectedLeanFiles = policy.reviewedArtifacts['probe-lean'].files.map(x => x.relativePath).sort();
    if (JSON.stringify(filesBelow(leanGroup).sort()) !== JSON.stringify(expectedLeanFiles)) fail('helper-layout-unsupported', 'Built Lean helper library layout differs from the reviewed source recipe.');
    const existingLeanLib = path.join(facts.profile, '.local', 'lib', 'probe-lean-v4.31.0');
    const allowedLibraryFiles = new Set(expectedLeanFiles.filter(x => x.startsWith('lib/')).map(x => x.slice(4)));
    if (filesBelow(existingLeanLib).some(name => !allowedLibraryFiles.has(name))) fail('helper-conflict', 'Existing versioned Lean library contains unreviewed extra files; it was preserved.');
    async function publishTree(from, to) { const stat = fs.lstatSync(from); if (stat.isDirectory()) { for (const name of fs.readdirSync(from).sort()) await publishTree(path.join(from, name), path.join(to, name)); } else await publishKnownFile(from, to, journal, save, creation); }
    await publishTree(path.join(leanGroup, 'bin'), path.join(facts.profile, '.local', 'bin'));
    await publishTree(path.join(leanGroup, 'lib'), path.join(facts.profile, '.local', 'lib', 'probe-lean-v4.31.0'));
    const localBin = path.join(facts.profile, '.local', 'bin'), probeLeanLib = path.join(facts.profile, '.local', 'lib', 'probe-lean-v4.31.0');
    const resourcePaths = {
      'probe-bin': probeBin, 'proxy-bin': proxyBin, 'rustup-home': path.join(facts.profile, '.rustup'), 'cargo-home': cargoHome, vendor,
      'lean-bin': path.join(leanRuntime, 'bin'), 'lean-lib': path.join(leanRuntime, 'lib'), 'probe-lean-lib': probeLeanLib, 'git-bin': gitBin,
      ...Object.fromEntries(Object.keys(nativeRoots).map(name => [name, path.join(bundle, name)])),
      ...Object.fromEntries(fs.readdirSync(path.join(leanGroup, 'bin')).map(name => ['local-' + name, path.join(localBin, name)])),
    };
    const fullOnly = new Set(['vendor', 'lean-lib', 'probe-lean-lib', ...Object.keys(nativeRoots)]);
    const resources = Object.entries(resourcePaths).map(([id, file]) => ({ id, ...(file.startsWith(bundle + path.sep) ? { relativePath: path.relative(bundle, file).replaceAll('\\', '/') } : { path: file }), ...fingerprintWindowsResource(file), versionCheck: !fullOnly.has(id) }));
    const artifacts = { 'probe-aeneas': fileRecord(bundle, path.join(probeBin, 'probe-aeneas.exe')), launcher: fileRecord(bundle, launcherFile) };
    const helpers = {
      'probe-rust': fileRecord(bundle, path.join(probeBin, 'probe-rust.exe')), scip: fileRecord(bundle, path.join(probeBin, 'scip.exe')),
      'probe-lean': externalFile(path.join(localBin, 'probe-lean-v4.31.0.exe')),
      ...Object.fromEntries(['rustup', 'cargo', 'rustc', 'rust-analyzer'].map(name => [name, fileRecord(bundle, path.join(proxyBin, name + '.exe'))])),
      lean: fileRecord(bundle, path.join(leanRuntime, 'bin', 'lean.exe')), lake: fileRecord(bundle, path.join(leanRuntime, 'bin', 'lake.exe')), git: fileRecord(bundle, path.join(gitBin, 'git.exe')),
    };
    const versions = [];
    for (const name of ['probe-aeneas', 'probe-rust', 'probe-lean', 'scip', 'lean', 'lake', 'rust-analyzer', 'cargo', 'rustc', 'git', 'rustup-components']) {
      const helper = name === 'rustup-components' ? 'rustup' : name;
      const item = helper === 'probe-aeneas' ? artifacts[helper] : helpers[helper];
      const executable = item.relativePath ? path.join(bundle, item.relativePath) : item.path;
      const args = name === 'rustup-components' ? ['component', 'list', '--installed', '--toolchain', policy.toolchain] : ['--version'];
      const result = await ctx.run(executable, args, { label: 'setup-version-' + name, env: { PATH: [proxyBin, probeBin, localBin, path.join(leanRuntime, 'bin'), gitBin, facts.systemDirectory].join(';'), RUSTUP_HOME: path.join(facts.profile, '.rustup') } });
      const approvedVersion = policy.versions.find(version => version.name === name);
      if (!approvedVersion || result.stdout.trim() !== approvedVersion.expected) fail('version-mismatch', `The approved source recipe version differs: ${name}`);
      versions.push({ name, helper, args, expected: result.stdout.trim(), sha256: item.sha256, measurement: 'Explicit setup smoke; confined equality checks are required separately' });
    }
    copyIndependent(path.join(stage, 'logs'), path.join(bundle, 'build-evidence'));
    progress({ phase: 'flush-runtime-files' }); flushFiles(bundle);
    progress({ phase: 'publish-installation' });
    if (getWindowsSourcePolicy().sha256 !== policy.sha256) fail('source-policy-changed', 'Bundled source policy changed during setup; recover this installation before retrying.');
    const receipt = { schema: 'fvs/windows-source-install/v1', state: 'complete', installationId, distributionId: policy.id, policySha256: policy.sha256, target: policy.target, official: false, verified: false, userSid: facts.userSid, profileDirectory: facts.profile, host: facts.host, gitSourceFiles, project: plan.project, builds, commands: ctx.commands, phaseTimings: phaseTimings.map(({ started: at, ...item }) => ({ ...item, elapsedMs: item.elapsedMs ?? Date.now() - at, startedAt: new Date(at).toISOString() })), elapsedMsBeforePublication: Date.now() - started, prerequisites: Object.fromEntries(['git', 'cargo', 'rustc', 'compiler'].map(name => [name, externalFile(plan.prerequisites[name])])), artifacts, helpers, resources, versions, createdAt: new Date().toISOString(), limitations: ['Source-build distribution, distinct from official release binaries', 'Local receipt trust ends at the account owner', 'Public API extraction is not qualified', 'Pinned Rust-only dependency closure uses MSVC/SDK libraries without C headers', 'Upstream Lean graph completeness and trusted/sorry classifications remain visible'] };
    fs.writeFileSync(path.join(bundle, 'INSTALL.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    flushFile(path.join(bundle, 'INSTALL.json'));
    journal.phase = 'publishing-bundle'; save();
    fs.renameSync(bundle, final);
    requireIdentity(final, journal.bundleIdentity, true);
    fs.mkdirSync(path.join(root, 'receipts'), { recursive: true });
    const receiptSha256 = windowsFileSha256(path.join(final, 'INSTALL.json'));
    atomicJson(path.join(root, 'receipts', installationId + '.json'), { installationId, receiptSha256, policySha256: policy.sha256 });
    atomicJson(path.join(root, 'CURRENT.json'), { schema: 'fvs/windows-source-current/v1', installationId, policySha256: policy.sha256, receiptSha256 });
    published = true; journal.phase = 'committed'; save();
    progress({ phase: 'remove-private-build-stage' });
    removePrivateTree(stage, path.join(root, 'staging')); fs.unlinkSync(journalFile); clearSetupMarker(root, installationId, facts);
    const last = phaseTimings.at(-1); if (last) last.elapsedMs = Date.now() - last.started;
    return { ok: true, status: 'installed', installationId, sessionId: 'setup:' + installationId, distributionId: policy.id, receipt: path.join(final, 'INSTALL.json'), official: false, verified: false, elapsedMs: Date.now() - started, phaseTimings: phaseTimings.map(({ started: at, ...item }) => ({ ...item, elapsedMs: item.elapsedMs ?? Date.now() - at, startedAt: new Date(at).toISOString() })), builds: Object.fromEntries(Object.entries(builds).map(([name, value]) => [name, value.origin])) };
  } catch (error) {
    // Retain durable evidence and all private state for explicit recovery. Never
    // guess whether an interrupted exclusive publication belonged to somebody else.
    if (ownsJournal && fs.existsSync(journalFile)) { journal.error = error.message; journal.phase = published ? 'committed-cleanup-required' : 'recovery-required'; atomicJson(journalFile, journal); error.recovery = { sessionId: 'setup:' + installationId }; }
    else if (!error.recovery && ownsMarker) error.recovery = { sessionId: 'setup:' + installationId };
    if (error.recovery && error.diagnostic) error.diagnostic.recovery = error.recovery;
    throw error;
  } finally { await unlock.release(); }
}
