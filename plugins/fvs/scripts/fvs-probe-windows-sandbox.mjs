// Native Windows lifecycle adapter. Only the distribution resolver can brand a
// runtime. Candidate bytes remain private until the native terminal receipt and
// independent checks both confirm cleanup. Graph validation/publication belongs
// to the shared inventory module.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  assertValidatedWindowsRuntime, assertValidatedWindowsLauncher,
  resolveWindowsRecoveryLauncher,
} from './fvs-probe-windows-runtime.mjs';

const HEX = /^[a-f0-9]{64}$/;
const SESSION = /^[a-f0-9]{32}$/;
const MAX_GRAPH = 256 * 1024 * 1024;
const MAX_OUTPUT = 32 * 1024 * 1024;
// Inventorying a prepared Lean tree can visit more than 100,000 files. Reuse
// this synchronous scratch buffer instead of allocating 1 MiB for every file.
const HASH_BUFFER = Buffer.allocUnsafe(1024 * 1024);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
const diagnosticsText = diagnostics => (diagnostics || []).map(item => typeof item === 'string' ? item : item.message || JSON.stringify(item)).join('; ');
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const inside = (root, file) => same(root, file) || file.toLowerCase().startsWith(`${root.replace(/\\$/, '').toLowerCase()}\\`);
const overlaps = (a, b) => inside(a, b) || inside(b, a);

function windowsHost() {
  if (process.platform !== 'win32' || process.arch !== 'x64') fail('Native Windows x64 confinement is required');
}

// Do not normalize an unsafe spelling into an apparently safe path. Reject
// aliases, reparse points and hardlinks before inventorying or copying bytes.
function ordinary(value, { missingLeaf = false, allowSystemFileHardlink = false } = {}) {
  if (typeof value !== 'string' || !/^[A-Za-z]:\\/.test(value) || /[\x00-\x1f/]/.test(value)) fail('A canonical local Windows path is required');
  const components = value.slice(3).split('\\');
  if (components.length === 1 && components[0] === '') components.pop();
  for (const component of components) {
    if (!component || component === '.' || component === '..' || /[<>:"|?*]/.test(component)
      || /[. ]$/.test(component) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(component)) fail(`Unsupported Windows path alias: ${value}`);
  }
  if (!same(path.win32.resolve(value), value)) fail(`Path is not canonical: ${value}`);
  let current = value.slice(0, 3);
  const checked = [current];
  for (const component of components) { current = path.win32.join(current, component); checked.push(current); }
  for (let index = 0; index < checked.length; index += 1) {
    const item = checked[index];
    const stat = fs.lstatSync(item, { throwIfNoEntry: false });
    if (!stat && missingLeaf && index === checked.length - 1) return value;
    if (!stat) fail(`Required path is absent: ${item}`);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())
      || (stat.isFile() && stat.nlink !== 1 && !(allowSystemFileHardlink && index === checked.length - 1))) fail(`Links and special files are unsupported: ${item}`);
    if (!same(fs.realpathSync.native(item).replace(/\\$/, ''), item.replace(/\\$/, ''))) fail(`Windows path alias is unsupported: ${item}`);
  }
  return value;
}

function directory(value) {
  ordinary(value);
  if (!fs.statSync(value).isDirectory()) fail(`Expected a directory: ${value}`);
  return value;
}

function fileHash(file) {
  const digest = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1) fail(`Unsafe file while hashing: ${file}`);
    let read;
    while ((read = fs.readSync(descriptor, HASH_BUFFER, 0, HASH_BUFFER.length, null)) !== 0) digest.update(HASH_BUFFER.subarray(0, read));
    const after = fs.fstatSync(descriptor);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || before.dev !== after.dev) fail(`File changed while hashing: ${file}`);
  } finally { fs.closeSync(descriptor); }
  return digest.digest('hex');
}

function checkedFile(file, expected) {
  ordinary(file);
  if (!fs.statSync(file).isFile() || !HEX.test(expected ?? '') || fileHash(file) !== expected) fail(`Executable identity mismatch: ${file}`);
}

function minimalRoots(values) {
  const unique = [...new Map(values.map(value => [value.toLowerCase(), ordinary(value)])).values()];
  return unique.filter(value => !unique.some(other => !same(value, other) && inside(other, value))).sort((a, b) => a.localeCompare(b));
}

function inventory(root, onGit = null, expectedResources = [], expectedFiles = []) {
  ordinary(root);
  const digest = crypto.createHash('sha256');
  // Match the resolver's approved content fingerprint while doing the same
  // reads used for the mutation inventory. Streaming the JSON array avoids
  // retaining a second complete manifest for a large toolchain.
  const expected = expectedResources.filter(resource => inside(root, resource.path)).map(resource => ({
    ...resource, digest: crypto.createHash('sha256').update('['), visited: 0,
  }));
  const expectedByPath = new Map(expectedFiles.map(file => [file.path.toLowerCase(), file]));
  const seenExpected = new Set();
  let entries = 0;
  function walk(file, relative) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) fail(`Unsafe protected entry: ${file}`);
    if (!same(fs.realpathSync.native(file), file)) fail(`Aliased protected entry: ${file}`);
    if (onGit && path.basename(file).toLowerCase() === '.git') onGit(file);
    const contentHash = stat.isFile() ? fileHash(file) : null;
    const expectedFile = expectedByPath.get(file.toLowerCase());
    if (expectedFile) {
      if (!stat.isFile() || contentHash !== expectedFile.sha256) fail(`Source provenance changed before staging: ${file}`);
      seenExpected.add(file.toLowerCase());
    }
    const record = stat.isDirectory() ? [relative, 'directory'] : [relative, 'file', stat.size, stat.mtimeMs, contentHash];
    digest.update(JSON.stringify(record)); digest.update('\n'); entries += 1;
    for (const resource of expected) if (inside(resource.path, file)) {
      const subpath = path.relative(resource.path, file).replace(/\\/g, '/');
      const contentRecord = stat.isDirectory() ? [subpath, 'directory'] : [subpath, 'file', stat.size, contentHash];
      if (resource.visited++) resource.digest.update(',');
      resource.digest.update(JSON.stringify(contentRecord));
    }
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) walk(path.join(file, name), relative ? `${relative}/${name}` : name);
  }
  walk(root, '');
  if (seenExpected.size !== expectedByPath.size) fail('A bound source provenance file disappeared before staging');
  for (const resource of expected) if (!resource.visited || !HEX.test(resource.sha256 ?? '') || resource.digest.update(']').digest('hex') !== resource.sha256) fail(`Approved runtime resource changed before execution: ${resource.path}`);
  return { entries, sha256: digest.digest('hex') };
}

function inventories(roots) { return Object.fromEntries(roots.map(root => [root, inventory(root)])); }

function gitMetadata(gitPath) {
  let gitDirectory = gitPath;
  if (fs.statSync(gitPath).isFile()) {
    const pointer = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(fs.readFileSync(gitPath, 'utf8'));
    if (!pointer) fail(`Unsupported .git indirection: ${gitPath}`);
    gitDirectory = path.resolve(path.dirname(gitPath), pointer[1]);
  }
  directory(gitDirectory);
  const roots = [gitDirectory];
  const common = path.join(gitDirectory, 'commondir');
  if (fs.existsSync(common)) {
    ordinary(common);
    const pointer = fs.readFileSync(common, 'utf8').trim();
    if (!pointer || /[\r\n\0]/.test(pointer)) fail(`Unsupported Git common directory: ${common}`);
    roots.push(directory(path.resolve(gitDirectory, pointer)));
  }
  return roots;
}

function copyIndependentTree(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) fail(`Unsafe staging source: ${source}`);
  if (path.basename(source).toLowerCase() === '.git') {
    const [gitDirectory] = gitMetadata(source);
    fs.writeFileSync(destination, `gitdir: ${gitDirectory.replace(/\\/g, '/')}\n`, { flag: 'wx' });
  } else if (stat.isDirectory()) {
    fs.mkdirSync(destination);
    for (const name of fs.readdirSync(source)) copyIndependentTree(path.join(source, name), path.join(destination, name));
    fs.utimesSync(destination, stat.atime, stat.mtime);
  } else {
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    const copied = fs.lstatSync(destination);
    if (!copied.isFile() || copied.nlink !== 1 || (stat.dev === copied.dev && stat.ino === copied.ino)) fail(`Copy is not independent: ${source}`);
    // Lake/probe cache freshness uses source modification times.
    fs.utimesSync(destination, stat.atime, stat.mtime);
  }
}

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { fail(`Invalid ${label} JSON`); }
}

function invoke(launcher, command, request, statePath = null) {
  checkedFile(launcher.path, launcher.sha256);
  const args = statePath ? [command, statePath, '-'] : [command, '-'];
  // Native run owns the child timeout and job drain. The outer process must not
  // kill prepare/dispose/recover midway through a security-state transition.
  const child = spawnSync(launcher.path, args, { input: JSON.stringify(request), encoding: 'utf8', windowsHide: true, maxBuffer: MAX_OUTPUT, timeout: 0 });
  if (child.error) fail(`Launcher ${command} outcome is uncertain: ${child.error.message}`);
  const result = parseJson(child.stdout ?? '', `launcher ${command}`);
  return { ...result, launcherExitCode: child.status, launcherStderr: child.stderr || '' };
}

function requireSuccess(result, statuses) {
  if (result.ok !== true || result.launcherExitCode !== 0 || !statuses.includes(result.status)) {
    fail(diagnosticsText(result.diagnostics) || `Confinement ${result.status || 'operation'} failed`);
  }
}

function readHashedJson(file, expected, label) {
  ordinary(file);
  if (!HEX.test(expected ?? '') || fs.statSync(file).size > 128 * 1024 * 1024) fail(`Invalid ${label} identity`);
  const bytes = fs.readFileSync(file);
  if (hash(bytes) !== expected) fail(`${label} changed`);
  return parseJson(bytes, label);
}

function preparedEvidence(prepared, reservation, launcher) {
  if (prepared.sessionId !== reservation.sessionId || !same(prepared.statePath, reservation.statePath)) fail('Prepared state is not the reserved session');
  const state = readHashedJson(prepared.statePath, prepared.stateSha256, 'prepared state');
  if (state.schema !== 'fvs/windows-prepared-state/v2' || state.sessionId !== reservation.sessionId || state.launcherSha256 !== launcher.sha256
    || !same(state.stageRoot, reservation.stageRoot) || !Array.isArray(state.resources)) fail('Prepared state identity mismatch');
  return state;
}

function verifyRestoredAcls(state, runtime) {
  const resources = state.resources.filter(resource => (!resource.writable || resource.metadataOnly) && !inside(state.stageRoot, resource.path));
  // Windows services its genuine System32 PowerShell through WinSxS hardlinks.
  // This one OS path comes from the branded runtime's loaded-kernel location;
  // resource, executable, state and candidate paths retain the no-hardlink rule.
  const powershell = ordinary(runtime.powershell, { allowSystemFileHardlink: true });
  const script = '$ErrorActionPreference="Stop"; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false,$true); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false,$true); $sections=[System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner; $paths=[Console]::In.ReadToEnd() | ConvertFrom-Json; $result=foreach($file in $paths){$acl=if([IO.Directory]::Exists($file)){[IO.Directory]::GetAccessControl($file,$sections)}else{[IO.File]::GetAccessControl($file,$sections)}; [pscustomobject]@{path=$file;acl=$acl.GetSecurityDescriptorSddlForm($sections)}}; ConvertTo-Json -InputObject @($result) -Depth 3 -Compress';
  const child = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: JSON.stringify(resources.map(resource => resource.path)), encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: MAX_OUTPUT,
  });
  if (child.error || child.status !== 0) fail(`Cannot independently verify restored ACLs: ${child.error?.message || child.stderr}`);
  const after = parseJson(child.stdout, 'ACL observation');
  if (!Array.isArray(after) || after.length !== resources.length || resources.some((resource, index) => !same(resource.path, after[index].path) || resource.beforeAcl !== after[index].acl)) fail('Exact resource ACL restoration mismatch');
}

function exactCleanup(receipt) {
  if (!Array.isArray(receipt.resourceAclResults) || receipt.resourceAclResults.some(resource => resource.exactRestored !== true || resource.beforeAcl !== resource.currentAcl)) fail('Terminal receipt records a resource ACL mismatch');
  const audit = receipt.descendantAclAudit;
  if (!audit || !Number.isInteger(audit.checked) || audit.checked < 0 || audit.exactRestored !== true || !Array.isArray(audit.changedPreserved) || audit.changedPreserved.length !== 0 || audit.ownSidRemaining !== 0) fail('Terminal receipt does not confirm exact descendant ACL restoration');
}

function terminalEvidence(disposal, reservation, launcher, prepared, lastRun, state) {
  requireSuccess(disposal, ['disposed', 'recovered']);
  if (!same(path.join(reservation.controlDirectory, 'terminal-receipt.json'), disposal.terminalReceiptPath)) fail('Terminal receipt is outside native session control');
  const receipt = readHashedJson(disposal.terminalReceiptPath, disposal.terminalReceiptSha256, 'terminal receipt');
  if (receipt.schema !== 'fvs/windows-terminal-receipt/v2' || receipt.sessionId !== reservation.sessionId || receipt.launcherSha256 !== launcher.sha256
    || !['disposed', 'recovered'].includes(receipt.status) || receipt.jobDrained !== true || receipt.profileAbsent !== true
    || receipt.stageRemoved !== true || receipt.aclCleanupConfirmed !== true || !Number.isInteger(receipt.journalRevision)
    || (prepared && receipt.stateSha256 !== prepared.stateSha256)) fail('Terminal cleanup receipt is incomplete or belongs to another session');
  if (lastRun && (receipt.lastRunId !== lastRun.runId || receipt.lastRunResultSha256 !== lastRun.resultSha256)) fail('Terminal receipt does not cover the final confined run');
  exactCleanup(receipt);
  if (state && (receipt.resourceAclResults.length !== state.resources.length || state.resources.some(resource => !receipt.resourceAclResults.some(restored => same(restored.path, resource.path) && restored.beforeAcl === resource.beforeAcl)))) fail('Terminal receipt does not cover every prepared resource');
  if (fs.lstatSync(reservation.stageRoot, { throwIfNoEntry: false })) fail('Private stage still exists after terminal cleanup');
  return receipt;
}

function timingReporter(onProgress) {
  const timings = [];
  return { timings, phase(name, action) {
    const started = Date.now();
    // A presentation callback must not interrupt cleanup or change its result.
    try { onProgress?.({ phase: name, state: 'started' }); } catch { /* informational */ }
    try { return action(); }
    finally { const elapsedMs = Date.now() - started; timings.push({ phase: name, elapsedMs }); try { onProgress?.({ phase: name, state: 'finished', elapsedMs }); } catch { /* informational */ } }
  } };
}

function runLifecycle({ runtime, projectRoot, cwd, commands, staged, rustProject, probePath, expectedProvenance, onProgress }) {
  const progress = timingReporter(onProgress);
  const result = { ok: false, results: [], stdout: '', stderr: '', status: null, timings: progress.timings };
  let reservation, prepared, state, roots, before, captured;
  let uncertain = false;
  let lastRun;
  try {
    assertValidatedWindowsRuntime(runtime); windowsHost();
    assertValidatedWindowsLauncher(runtime.launcher);
    const source = directory(projectRoot);
    let expectedFiles = [];
    const working = directory(cwd || source);
    if (!inside(source, working)) fail('cwd must be inside projectRoot');
    if (staged) {
      const crate = directory(rustProject);
      if (!inside(source, crate)) fail('rustProject must be inside projectRoot');
      if (!same(probePath, runtime.probePath)) fail('Extraction executable differs from validated runtime');
      if (expectedProvenance) {
        if (!same(directory(expectedProvenance.projectRoot), source) || !same(directory(expectedProvenance.rustProject), crate)) fail('Bound source provenance belongs to another project');
        if (!Array.isArray(expectedProvenance.files) || expectedProvenance.files.length === 0) fail('Bound source provenance files are required');
        expectedFiles = expectedProvenance.files.map(file => {
          const bound = ordinary(file.path);
          if (!inside(source, bound) || !HEX.test(file.sha256 ?? '') || !fs.statSync(bound).isFile()) fail('Invalid bound source provenance file');
          return { path: bound, sha256: file.sha256 };
        });
        if (new Set(expectedFiles.map(file => file.path.toLowerCase())).size !== expectedFiles.length) fail('Duplicate bound source provenance file');
      }
    }
    const selected = staged ? runtime.readOnlyPaths : runtime.versionReadOnlyPaths;
    if (!Array.isArray(runtime.resources) || selected.some(resource => !runtime.resources.some(expected => same(resource, expected.path) && HEX.test(expected.sha256 ?? '')))) fail('Validated runtime lacks approved resource fingerprints');
    for (const resource of selected) if (!runtime.readOnlyPaths.some(root => inside(root, resource))) fail('Version resource is outside validated runtime resources');
    let readOnly;
    if (inside(source, runtime.profileDirectory)) fail('projectRoot must not contain the Windows user profile');
    for (const resource of [...runtime.readOnlyPaths, runtime.launcher.path]) if (overlaps(source, resource)) fail(`Source and tool resources overlap: ${resource}`);
    if (!staged) {
      if (!Array.isArray(commands) || commands.length === 0) fail('At least one validated readonly command is required');
      commands = commands.map(command => {
        const known = runtime.versions.find(item => item.name === command.name && item.executable === command.executable
          && item.sha256 === command.sha256 && item.expected === command.expected && JSON.stringify(item.args) === JSON.stringify(command.args));
        if (!known) fail('Readonly command is not an exact validated version check');
        if (!selected.some(root => inside(root, known.executable))) fail('Readonly executable is outside validated version resources');
        checkedFile(known.executable, known.sha256); return known;
      });
    }
    before = progress.phase('inventory-before', () => {
      const gitRoots = [];
      const sourceInventory = inventory(source, staged ? file => gitRoots.push(...gitMetadata(file)) : null, [], expectedFiles);
      readOnly = minimalRoots([...selected, ...gitRoots]);
      roots = minimalRoots([source, ...readOnly, runtime.launcher.path, ...runtime.executablePaths]);
      return Object.fromEntries(roots.map(root => [root, same(root, source) ? sourceInventory : inventory(root, null, runtime.resources)]));
    });
    uncertain = true;
    reservation = progress.phase('reserve', () => invoke(runtime.launcher, 'reserve', { schema: 'fvs/windows-reserve/v2', mode: staged ? 'staged' : 'readonly' }));
    requireSuccess(reservation, ['reserved']);
    if (!SESSION.test(reservation.sessionId ?? '')) fail('Invalid reserved session identity');
    directory(reservation.stageRoot); directory(reservation.controlDirectory);
    if (!same(path.dirname(reservation.stageRoot), path.dirname(reservation.controlDirectory)) || overlaps(reservation.stageRoot, reservation.controlDirectory)) fail('Invalid native session layout');
    if (!inside(reservation.controlDirectory, reservation.statePath)) fail('Native state is outside session control');
    for (const protectedRoot of roots) if (overlaps(protectedRoot, path.dirname(reservation.stageRoot))) fail('Native session overlaps a protected resource');
    uncertain = false;
    result.sessionId = reservation.sessionId;
    result.policy = { backend: 'windows-lpac', distributionId: runtime.distributionId, policyId: runtime.policyId, policySha256: runtime.policySha256, staged };
    // Short leaves preserve headroom for Windows tools that still use MAX_PATH.
    const projectCopy = path.join(reservation.stageRoot, 'p');
    const outputDirectory = path.join(reservation.stageRoot, 'o');
    const versionCwd = path.join(reservation.stageRoot, 'w');
    const candidate = path.join(outputDirectory, 'extract.json');
    const writable = staged ? [projectCopy, outputDirectory] : [];
    if (staged) progress.phase('stage-copy', () => { copyIndependentTree(source, projectCopy); fs.mkdirSync(outputDirectory); });
    else {
      // Exact version checks have no project inputs; Rustup's toolchain is
      // explicit in the recipe. Keep cwd readable and empty without granting
      // access on every descendant of a prepared consumer source tree.
      fs.mkdirSync(versionCwd);
      readOnly = minimalRoots([...readOnly, versionCwd]);
      result.policy.cwd = 'reserved-empty-readonly-directory';
    }
    if (expectedFiles.length) progress.phase('verify-staged-provenance', () => {
      for (const file of expectedFiles) {
        const copied = ordinary(path.join(projectCopy, path.relative(source, file.path)));
        if (fileHash(copied) !== file.sha256) fail(`Staged provenance differs from the validated source: ${file.path}`);
      }
    });
    uncertain = true;
    prepared = progress.phase('prepare', () => invoke(runtime.launcher, 'prepare', {
      schema: 'fvs/windows-prepare/v2', sessionId: reservation.sessionId, controlDirectory: reservation.controlDirectory,
      readOnlyPaths: readOnly, writablePaths: writable, disposablePaths: writable,
      executablePaths: staged ? runtime.executablePaths : [...new Set(commands.map(command => command.executable))], profileTempWritable: true,
    }));
    requireSuccess(prepared, ['prepared']);
    state = preparedEvidence(prepared, reservation, runtime.launcher);
    uncertain = false;
    const environment = { ...runtime.environment, GIT_OPTIONAL_LOCKS: '0' };
    for (const key of Object.keys(environment)) if (/^(temp|tmp)$/i.test(key)) delete environment[key];
    const planned = staged ? [{ name: 'extract', executable: runtime.probePath, args: ['extract', projectCopy, '-o', candidate], cwd: projectCopy, timeoutMs: 1800000 }] : commands.map(command => ({ ...command, cwd: versionCwd, timeoutMs: 60000 }));
    for (const command of planned) {
      uncertain = true;
      lastRun = progress.phase(`run:${command.name}`, () => invoke(runtime.launcher, 'run', {
        schema: 'fvs/windows-run/v2', stateSha256: prepared.stateSha256, executable: command.executable, args: command.args,
        cwd: command.cwd, environment, timeoutMs: command.timeoutMs, maxOutputBytes: MAX_OUTPUT / 2,
      }, prepared.statePath));
      uncertain = false;
      if (!SESSION.test(lastRun.runId ?? '') || !same(lastRun.resultPath, path.join(reservation.controlDirectory, `run-${lastRun.runId}.json`))) fail('Confined run receipt is not in native session control');
      const persistedRun = readHashedJson(lastRun.resultPath, lastRun.resultSha256, 'confined run result');
      for (const [key, value] of Object.entries(persistedRun)) if (JSON.stringify(value) !== JSON.stringify(lastRun[key])) fail('Persisted confined result differs from launcher response');
      if (persistedRun.runId !== lastRun.runId) fail('Confined run result identity differs');
      const execution = { ...lastRun, name: command.name, ok: lastRun.ok === true && lastRun.launcherExitCode === 0 && lastRun.status === 'exited' && lastRun.exitCode === 0 && lastRun.activeProcessesAfter === 0 };
      if (!staged && execution.stdout?.trim() !== command.expected) { execution.ok = false; execution.error = 'Pinned version output did not match'; }
      result.results.push(execution);
      result.stdout = execution.stdout || ''; result.stderr = execution.stderr || ''; result.status = execution.status;
      if (!execution.ok) fail(execution.error || diagnosticsText(execution.diagnostics) || `Confined ${command.name} failed`);
    }
    if (staged) progress.phase('capture-output', () => {
      ordinary(candidate);
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_GRAPH) fail('Candidate graph is not a bounded independent file');
      captured = fs.readFileSync(candidate, 'utf8');
    });
  } catch (error) { result.error = error.message; }
  finally {
    if (reservation?.sessionId && !uncertain) {
      try {
        const disposal = progress.phase('dispose', () => prepared?.ok
          ? invoke(runtime.launcher, 'dispose', { schema: 'fvs/windows-dispose/v2', stateSha256: prepared.stateSha256, cleanPrivatePaths: state?.resources.filter(resource => resource.writable && !resource.metadataOnly && resource.directory).map(resource => resource.path) || [] }, prepared.statePath)
          : invoke(runtime.launcher, 'recover', { schema: 'fvs/windows-recover/v2', sessionId: reservation.sessionId }));
        const receipt = terminalEvidence(disposal, reservation, runtime.launcher, prepared?.ok ? prepared : null, lastRun, state);
        result.terminalReceipt = { path: disposal.terminalReceiptPath, sha256: disposal.terminalReceiptSha256, sessionId: receipt.sessionId };
        if (state) progress.phase('verify-acls', () => verifyRestoredAcls(state, runtime));
      } catch (error) { result.cleanupError = error.message; uncertain = true; }
    }
    if (before) {
      try { progress.phase('inventory-after', () => { if (JSON.stringify(before) !== JSON.stringify(inventories(roots))) fail('Protected source or tool inventory changed'); }); }
      catch (error) { result.confinementError = error.message; }
    }
    if (uncertain) {
      result.recovery = { required: true, sessionId: reservation?.sessionId || null, reason: result.cleanupError || result.error || 'Native operation outcome is uncertain' };
      if (reservation?.stageRoot && fs.existsSync(reservation.stageRoot)) result.retainedStage = reservation.stageRoot;
    }
    result.ok = !result.error && !result.cleanupError && !result.confinementError && !uncertain && !!result.terminalReceipt;
    if (result.ok && staged) result.outputText = captured;
  }
  return result;
}

export function runWindowsReadOnly({ runtime, commands, cwd, projectRoot, onProgress } = {}) {
  return runLifecycle({ runtime, commands, cwd, projectRoot, onProgress, staged: false });
}

export function runWindowsStagedExtract({ runtime, probePath, projectRoot, rustProject, withPublicApi = false, expectedProvenance, onProgress } = {}) {
  if (withPublicApi) return { ok: false, status: null, stdout: '', stderr: '', error: 'Windows public API extraction is unsupported by this distribution', timings: [] };
  return runLifecycle({ runtime, probePath, projectRoot, rustProject, expectedProvenance, onProgress, staged: true });
}

function recoveryLauncher({ runtime, launcher, sessionId, toolsRoot }) {
  if (runtime) { assertValidatedWindowsRuntime(runtime); launcher = runtime.launcher; }
  if (!launcher) {
    const resolution = resolveWindowsRecoveryLauncher({ sessionId, toolsRoot });
    if (!resolution.ok) fail(diagnosticsText(resolution.diagnostics) || 'Verified recovery launcher is unavailable');
    launcher = resolution.launcher;
  }
  assertValidatedWindowsLauncher(launcher); windowsHost();
  return launcher;
}

export function getWindowsConfinementStatus(options = {}) {
  try {
    const launcher = recoveryLauncher(options);
    return invoke(launcher, 'status', { schema: 'fvs/windows-status/v2', ...(options.sessionId ? { sessionId: options.sessionId } : {}) });
  } catch (error) { return { ok: false, status: 'unavailable', diagnostics: [error.message] }; }
}

export function recoverWindowsSession({ sessionId, launcher, toolsRoot, onProgress } = {}) {
  const progress = timingReporter(onProgress);
  try {
    if (!SESSION.test(sessionId || '')) fail('A valid sessionId is required for explicit recovery');
    launcher = recoveryLauncher({ launcher, sessionId, toolsRoot });
    const result = progress.phase('recover', () => invoke(launcher, 'recover', { schema: 'fvs/windows-recover/v2', sessionId }));
    requireSuccess(result, ['recovered', 'disposed']);
    const receipt = readHashedJson(result.terminalReceiptPath, result.terminalReceiptSha256, 'terminal recovery receipt');
    if (receipt.schema !== 'fvs/windows-terminal-receipt/v2' || receipt.sessionId !== sessionId || receipt.launcherSha256 !== launcher.sha256
      || !['disposed', 'recovered'].includes(receipt.status) || receipt.jobDrained !== true || receipt.profileAbsent !== true || receipt.stageRemoved !== true || receipt.aclCleanupConfirmed !== true) fail('Recovery terminal receipt is incomplete');
    exactCleanup(receipt);
    if (!same(receipt.controlDirectory, result.controlDirectory) || !same(receipt.stageRoot, result.stageRoot) || !same(result.terminalReceiptPath, path.join(receipt.controlDirectory, 'terminal-receipt.json'))) fail('Recovery receipt location differs from native session');
    if (typeof receipt.stageRoot !== 'string' || fs.lstatSync(ordinary(receipt.stageRoot, { missingLeaf: true }), { throwIfNoEntry: false })) fail('Recovery has not removed its private stage');
    return { ...result, timings: progress.timings };
  } catch (error) { return { ok: false, status: 'recovery-required', sessionId, diagnostics: [error.message], timings: progress.timings }; }
}
