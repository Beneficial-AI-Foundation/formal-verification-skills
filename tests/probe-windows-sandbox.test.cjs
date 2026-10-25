'use strict';

const { before, after, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

describe('Windows production adapter lifecycle with synthetic native transport', {
  skip: process.platform !== 'win32' || process.arch !== 'x64',
}, () => {
  let fixtureRoot, adapter, brand, runtime, project, crate, session, control, stage;
  let originalSpawn, originalCopy, calls, mode, prepared, finalRun, runCounter, observations;
  const sessionId = 'a'.repeat(32);
  const save = (file, value) => { const bytes = Buffer.from(JSON.stringify(value)); fs.writeFileSync(file, bytes); return digest(bytes); };

  function safeRemove(directory) {
    const resolved = path.resolve(directory);
    assert.ok(fixtureRoot && resolved.toLowerCase().startsWith(`${path.resolve(fixtureRoot).toLowerCase()}${path.sep}`));
    fs.rmSync(resolved, { force: true, recursive: true });
  }
  function response(value) { return { status: 0, stdout: JSON.stringify(value), stderr: '' }; }
  function makeTerminal(status) {
    if (mode !== 'retained-stage') safeRemove(stage);
    const receipt = {
      schema: 'fvs/windows-terminal-receipt/v2', sessionId, stageRoot: stage, controlDirectory: control,
      stateSha256: prepared?.stateSha256 ?? null, launcherSha256: runtime.launcher.sha256,
      lastRunId: finalRun?.runId ?? null, lastRunResultSha256: finalRun?.resultSha256 ?? null,
      status, jobDrained: true, profileAbsent: true, stageRemoved: true, aclCleanupConfirmed: true, journalRevision: 9,
      resourceAclResults: (prepared?.resources ?? []).map(resource => ({ path: resource.path, beforeAcl: resource.beforeAcl, currentAcl: resource.beforeAcl, exactRestored: true })),
      descendantAclAudit: { checked: 4, exactRestored: true, changedPreserved: [], ownSidRemaining: 0 },
    };
    if (mode === 'incomplete-receipt') receipt.profileAbsent = false;
    if (mode === 'stale-run-receipt') receipt.lastRunId = 'f'.repeat(32);
    if (mode === 'missing-resource-receipt') receipt.resourceAclResults.pop();
    if (mode === 'descendant-acl-change') { receipt.descendantAclAudit.exactRestored = false; receipt.descendantAclAudit.changedPreserved = ['changed descendant']; }
    const terminalReceiptPath = path.join(control, 'terminal-receipt.json');
    const terminalReceiptSha256 = save(terminalReceiptPath, receipt);
    return { ok: true, status, terminalReceiptPath, terminalReceiptSha256, stageRoot: stage, controlDirectory: control, sessionId };
  }

  before(async () => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs sandbox adapter '));
    const modules = path.join(fixtureRoot, 'modules'); fs.mkdirSync(modules);
    // The copied adapter is byte-identical to production. Only its sibling
    // runtime module is synthetic, so production exports have no test bypass.
    fs.copyFileSync(path.join(ROOT, 'scripts', 'fvs-probe-windows-sandbox.mjs'), path.join(modules, 'fvs-probe-windows-sandbox.mjs'));
    fs.writeFileSync(path.join(modules, 'fvs-probe-windows-runtime.mjs'), [
      'const runtimes=new WeakSet(), launchers=new WeakSet();',
      'export function brand(runtime){runtimes.add(runtime);launchers.add(runtime.launcher);return runtime}',
      'export function assertValidatedWindowsRuntime(runtime){if(!runtimes.has(runtime))throw new Error("unbranded runtime")}',
      'export function assertValidatedWindowsLauncher(launcher){if(!launchers.has(launcher))throw new Error("unbranded launcher")}',
      'export function resolveWindowsRecoveryLauncher(){return {ok:false,diagnostics:["missing managed launcher"]}}',
    ].join('\n'));
    brand = (await import(pathToFileURL(path.join(modules, 'fvs-probe-windows-runtime.mjs')).href)).brand;
    originalSpawn = childProcess.spawnSync;
    originalCopy = fs.copyFileSync;
    childProcess.spawnSync = (executable, args, options) => {
      assert.equal(options.windowsHide, true);
      if (executable === runtime.powershell) {
        calls.push('verify-acls');
        const paths = JSON.parse(options.input);
        if (mode === 'unicode-acl') {
          // This is a real read-only OS ACL query; the profile lifecycle stays
          // synthetic. It catches Windows PowerShell's legacy pipe encoding.
          const actual = originalSpawn(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args, options);
          assert.equal(actual.status, 0, actual.stderr);
          const observed = JSON.parse(actual.stdout);
          assert.deepEqual(observed.map(item => item.path), paths);
          assert.ok(observed.every(item => typeof item.acl === 'string' && item.acl.includes('D:')));
          observations.unicodeAcl = true;
        }
        return response(paths.map(file => ({ path: file, acl: mode === 'root-acl-change' ? 'changed' : 'original-acl' })));
      }
      assert.equal(executable, runtime.launcher.path);
      assert.equal(options.timeout, 0, 'outer lifecycle is never killed by a timeout');
      assert.equal(args.at(-1), '-', 'requests use stdin without bootstrap files');
      const command = args[0], request = JSON.parse(options.input);
      calls.push(command);
      if (command === 'reserve') {
        fs.mkdirSync(stage, { recursive: true }); fs.mkdirSync(control);
        if (mode === 'uncertain-reserve') return { error: new Error('interrupted'), status: null, stdout: '' };
        return response({ ok: true, status: 'reserved', sessionId, stageRoot: stage, controlDirectory: control, statePath: path.join(control, 'state.json') });
      }
      if (command === 'prepare') {
        if (mode === 'uncertain-prepare') return { error: new Error('interrupted'), status: null, stdout: '' };
        observations.prepare = request;
        const statePath = path.join(control, 'state.json');
        prepared = {
          schema: 'fvs/windows-prepared-state/v2', sessionId, stageRoot: stage, controlDirectory: control,
          launcherSha256: runtime.launcher.sha256,
          resources: [...request.readOnlyPaths.map(file => ({ path: file, beforeAcl: 'original-acl', writable: false, directory: fs.statSync(file).isDirectory() })),
            ...request.writablePaths.map(file => ({ path: file, beforeAcl: 'original-acl', writable: true, directory: true }))],
        };
        const stateSha256 = save(statePath, prepared); prepared.stateSha256 = stateSha256;
        return response({ ok: true, status: 'prepared', sessionId, statePath, stateSha256 });
      }
      if (command === 'run') {
        if (mode === 'uncertain-run') return { status: null, error: new Error('interrupted'), stdout: '' };
        assert.ok(request.environment.GIT_OPTIONAL_LOCKS === '0');
        assert.equal(Object.keys(request.environment).filter(key => /^(temp|tmp)$/i.test(key)).length, 0);
        const staged = request.args[0] === 'extract';
        if (!staged) { observations.versionCwd = request.cwd; assert.deepEqual(fs.readdirSync(request.cwd), []); }
        if (staged) {
          const copy = request.args[1];
          assert.ok(copy.startsWith(stage + path.sep));
          assert.notEqual(fs.statSync(path.join(copy, 'source.txt')).ino, fs.statSync(path.join(project, 'source.txt')).ino);
          assert.equal(fs.statSync(path.join(copy, 'source.txt')).mtimeMs, fs.statSync(path.join(project, 'source.txt')).mtimeMs);
          fs.writeFileSync(path.join(copy, 'source.txt'), 'child may change its independent copy');
          fs.writeFileSync(request.args[3], '{"data":{"candidate":true}}');
          observations.copy = copy;
        }
        if (mode === 'source-change') fs.writeFileSync(path.join(project, 'source.txt'), 'unexpected source edit');
        const runId = (++runCounter).toString(16).padStart(32, '0');
        const resultPath = path.join(control, `run-${runId}.json`);
        const base = { ok: mode !== 'run-failed', status: 'exited', exitCode: mode === 'run-failed' ? 1 : 0, activeProcessesAfter: 0,
          stdout: staged ? 'extracted' : 'pinned version', stderr: '', runId };
        const resultSha256 = save(resultPath, base);
        finalRun = { ...base, resultPath, resultSha256 };
        if (mode === 'changed-run-result') fs.appendFileSync(resultPath, ' ');
        return response(finalRun);
      }
      if (command === 'dispose' || command === 'recover') return response(makeTerminal(command === 'dispose' ? 'disposed' : 'recovered'));
      if (command === 'status') return response({ ok: true, status: 'recovery-required', sessions: [{ sessionId }] });
      throw new Error(`Unexpected synthetic command ${command}`);
    };
    syncBuiltinESMExports();
    adapter = await import(pathToFileURL(path.join(modules, 'fvs-probe-windows-sandbox.mjs')).href);
  });

  beforeEach(() => {
    calls = []; mode = ''; prepared = null; finalRun = null; runCounter = 0; observations = {};
    fs.copyFileSync = originalCopy;
    const example = fs.mkdtempSync(path.join(fixtureRoot, 'case '));
    project = path.join(example, 'project with spaces'); crate = path.join(project, 'rust crate');
    fs.mkdirSync(crate, { recursive: true }); fs.writeFileSync(path.join(project, 'source.txt'), 'original bytes');
    const stamp = new Date('2026-01-01T00:00:00.000Z'); fs.utimesSync(path.join(project, 'source.txt'), stamp, stamp);
    const tools = path.join(example, 'tools'); fs.mkdirSync(tools);
    const system = path.join(example, 'system'); fs.mkdirSync(system);
    const launcher = path.join(tools, 'launcher.exe'), probe = path.join(tools, 'probe.exe'), powershell = path.join(system, 'powershell.exe');
    for (const file of [launcher, probe, powershell]) fs.writeFileSync(file, path.basename(file));
    session = path.join(example, 'sessions', sessionId); stage = path.join(session, 'stage'); control = path.join(session, 'control');
    runtime = brand({ distributionId: 'test', policyId: 'test', policySha256: 'b'.repeat(64),
      launcher: { path: launcher, sha256: digest(fs.readFileSync(launcher)) }, probePath: probe,
      readOnlyPaths: [tools], versionReadOnlyPaths: [tools], executablePaths: [probe],
      environment: { PATH: tools, TEMP: 'hostile temp', tMp: 'hostile tmp' }, powershell,
      versions: ['first', 'second'].map(name => ({ name, executable: probe, args: ['--version'], expected: 'pinned version', sha256: digest(fs.readFileSync(probe)) })),
      profileDirectory: path.dirname(fixtureRoot),
    });
    runtime.resources = [{ path: tools, sha256: digest(JSON.stringify([
      ['', 'directory'], ...fs.readdirSync(tools).sort().map(name => [name, 'file', fs.statSync(path.join(tools, name)).size, digest(fs.readFileSync(path.join(tools, name)))]),
    ])) }];
  });

  after(() => {
    fs.copyFileSync = originalCopy;
    childProcess.spawnSync = originalSpawn; syncBuiltinESMExports();
    if (fixtureRoot) {
      assert.ok(path.basename(fixtureRoot).startsWith('fvs sandbox adapter '));
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  const extract = extra => adapter.runWindowsStagedExtract({ runtime, probePath: runtime.probePath, projectRoot: project, rustProject: crate, ...extra });

  it('rejects forged runtime objects and unsupported public API before native effects', () => {
    assert.match(extract({ runtime: { ...runtime } }).error, /unbranded/);
    assert.match(extract({ withPublicApi: true }).error, /unsupported/);
    assert.deepEqual(calls, []);
  });

  it('batches exact validated readonly checks in one prepared session', () => {
    const result = adapter.runWindowsReadOnly({ runtime, commands: runtime.versions, projectRoot: project, cwd: crate });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.results.length, 2);
    assert.deepEqual(calls, ['reserve', 'prepare', 'run', 'run', 'dispose', 'verify-acls']);
    assert.deepEqual(observations.prepare.writablePaths, []);
    assert.equal(observations.prepare.readOnlyPaths.includes(project), false);
    assert.equal(observations.versionCwd, path.join(stage, 'w'));
    assert.ok(observations.prepare.readOnlyPaths.includes(observations.versionCwd));
    assert.equal(fs.existsSync(stage), false);
    assert.equal(result.outputText, undefined);
  });

  it('observes actual Unicode resource ACLs through strict UTF-8 pipes', () => {
    mode = 'unicode-acl';
    const resource = path.join(path.dirname(runtime.powershell), 'Żółć-漢字.txt');
    fs.writeFileSync(resource, 'unicode path');
    runtime.readOnlyPaths.push(resource); runtime.versionReadOnlyPaths.push(resource);
    runtime.resources.push({ path: resource, sha256: digest(JSON.stringify([
      ['', 'file', fs.statSync(resource).size, digest(fs.readFileSync(resource))],
    ])) });
    const result = adapter.runWindowsReadOnly({ runtime, commands: runtime.versions, projectRoot: project, cwd: crate });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(observations.unicodeAcl, true);
  });

  it('rejects unvalidated commands before reserving a session', () => {
    const result = adapter.runWindowsReadOnly({ runtime, commands: [{ ...runtime.versions[0], args: ['arbitrary'] }], projectRoot: project });
    assert.match(result.error, /exact validated/); assert.deepEqual(calls, []);
  });

  it('rejects approved resources altered after runtime resolution', () => {
    fs.appendFileSync(runtime.probePath, 'changed after branding');
    const result = extract(); assert.equal(result.ok, false); assert.match(result.error, /Approved runtime resource changed/);
    assert.deepEqual(calls, []);
  });

  it('returns candidate bytes after cleanup, keeps source intact, and records phases', () => {
    const events = [];
    const result = extract({ onProgress: event => events.push(event) });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.outputText, '{"data":{"candidate":true}}');
    assert.equal(fs.readFileSync(path.join(project, 'source.txt'), 'utf8'), 'original bytes');
    assert.equal(fs.existsSync(stage), false);
    assert.deepEqual(calls, ['reserve', 'prepare', 'run', 'dispose', 'verify-acls']);
    assert.ok(result.timings.some(item => item.phase === 'inventory-after'));
    assert.equal(events.at(-1).phase, 'inventory-after');
  });

  it('binds approved provenance files to the source snapshot without another read pass', () => {
    const binding = { projectRoot: project, rustProject: crate, files: [{ path: path.join(project, 'source.txt'), sha256: digest(Buffer.from('original bytes')) }] };
    const result = extract({ expectedProvenance: binding });
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(fs.existsSync(stage), false);
  });

  it('rejects provenance changed after high-level validation before native effects', () => {
    const binding = { projectRoot: project, rustProject: crate, files: [{ path: path.join(project, 'source.txt'), sha256: digest(Buffer.from('original bytes')) }] };
    fs.writeFileSync(binding.files[0].path, 'changed after resolve');
    const result = extract({ expectedProvenance: binding });
    assert.equal(result.ok, false); assert.match(result.error, /Source provenance changed/); assert.deepEqual(calls, []);
  });

  it('rejects bindings for another project or duplicate source file paths', () => {
    const file = { path: path.join(project, 'source.txt'), sha256: digest(Buffer.from('original bytes')) };
    const wrongRoot = extract({ expectedProvenance: { projectRoot: crate, rustProject: crate, files: [file] } });
    assert.match(wrongRoot.error, /another project/);
    const duplicate = extract({ expectedProvenance: { projectRoot: project, rustProject: crate, files: [file, file] } });
    assert.match(duplicate.error, /Duplicate bound/); assert.deepEqual(calls, []);
  });

  it('checks the staged provenance bytes before granting or executing', () => {
    const binding = { projectRoot: project, rustProject: crate, files: [{ path: path.join(project, 'source.txt'), sha256: digest(Buffer.from('original bytes')) }] };
    fs.copyFileSync = (from, to, flags) => { originalCopy(from, to, flags); if (path.basename(from) === 'source.txt') fs.writeFileSync(to, 'changed copy'); };
    const result = extract({ expectedProvenance: binding });
    assert.equal(result.ok, false); assert.match(result.error, /Staged provenance differs/);
    assert.deepEqual(calls, ['reserve', 'recover']); assert.equal(fs.existsSync(stage), false);
  });

  for (const failure of ['incomplete-receipt', 'stale-run-receipt', 'missing-resource-receipt', 'descendant-acl-change', 'root-acl-change', 'retained-stage']) {
    it(`withholds graph on ${failure}`, () => {
      mode = failure; const result = extract();
      assert.equal(result.ok, false); assert.equal(result.outputText, undefined);
      assert.ok(result.cleanupError); assert.equal(result.recovery.required, true);
    });
  }

  it('withholds graph on source mutation even when native cleanup succeeds', () => {
    mode = 'source-change'; const result = extract();
    assert.equal(result.ok, false); assert.match(result.confinementError, /inventory changed/);
    assert.equal(result.outputText, undefined); assert.equal(fs.existsSync(stage), false);
  });

  it('cleans up a known failed run but never exposes its graph', () => {
    mode = 'run-failed'; const result = extract();
    assert.equal(result.ok, false); assert.equal(result.outputText, undefined);
    assert.ok(calls.includes('dispose')); assert.equal(fs.existsSync(stage), false);
    assert.equal(result.recovery, undefined);
  });

  it('refuses a changed persisted run result even when cleanup succeeds', () => {
    mode = 'changed-run-result'; const result = extract();
    assert.equal(result.ok, false); assert.match(result.error, /confined run result changed/);
    assert.equal(result.outputText, undefined); assert.equal(fs.existsSync(stage), false);
  });

  for (const failure of ['uncertain-reserve', 'uncertain-prepare', 'uncertain-run']) {
    it(`retains durable ownership and requests explicit recovery after ${failure}`, () => {
      mode = failure; const result = extract();
      assert.equal(result.ok, false); assert.equal(result.outputText, undefined);
      assert.equal(result.recovery.required, true); assert.equal(fs.existsSync(stage), true);
      assert.equal(calls.includes('dispose'), false); assert.equal(calls.includes('recover'), false);
    });
  }

  it('recovers its already reserved stage after copy fails before prepare', () => {
    fs.copyFileSync = () => { throw new Error('synthetic interrupted copy'); };
    const result = extract();
    assert.equal(result.ok, false); assert.match(result.error, /interrupted copy/);
    assert.deepEqual(calls, ['reserve', 'recover']); assert.equal(fs.existsSync(stage), false);
    assert.equal(result.recovery, undefined);
  });

  it('does not let progress callbacks interrupt cleanup', () => {
    const result = extract({ onProgress: () => { throw new Error('UI failure'); } });
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(fs.existsSync(stage), false);
  });

  it('accepts the branded System32 PowerShell servicing hardlink for ACL observation', () => {
    fs.linkSync(runtime.powershell, path.join(path.dirname(runtime.powershell), 'winsxs-alias.exe'));
    const result = extract(); assert.equal(result.ok, true, JSON.stringify(result));
  });

  it('rejects hardlinked source entries before native effects', () => {
    fs.linkSync(path.join(project, 'source.txt'), path.join(project, 'alias.txt'));
    const result = extract(); assert.equal(result.ok, false); assert.match(result.error, /Unsafe/); assert.deepEqual(calls, []);
  });

  it('keeps Git metadata readonly while staging an independent gitdir pointer', () => {
    const metadata = path.join(project, '.git'); fs.mkdirSync(metadata); fs.writeFileSync(path.join(metadata, 'HEAD'), 'ref: refs/heads/test\n');
    const result = extract(); assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(observations.prepare.readOnlyPaths.includes(metadata));
    assert.equal(fs.statSync(metadata).isDirectory(), true);
  });

  it('status is read-only and explicit recovery requires a trusted launcher', () => {
    const status = adapter.getWindowsConfinementStatus({ runtime }); assert.equal(status.status, 'recovery-required');
    assert.deepEqual(calls, ['status']);
    const forged = adapter.recoverWindowsSession({ sessionId, launcher: { ...runtime.launcher } });
    assert.equal(forged.ok, false); assert.match(forged.diagnostics[0], /unbranded/);
    assert.deepEqual(calls, ['status']);
  });

  it('explicit recovery verifies the terminal receipt and private stage absence', () => {
    mode = 'uncertain-run'; const interrupted = extract();
    assert.equal(interrupted.recovery.required, true); assert.equal(fs.existsSync(stage), true);
    mode = '';
    const recovered = adapter.recoverWindowsSession({ sessionId, launcher: runtime.launcher });
    assert.equal(recovered.ok, true, JSON.stringify(recovered)); assert.equal(fs.existsSync(stage), false);
    assert.equal(calls.at(-1), 'recover'); assert.equal(recovered.outputText, undefined);
  });
});
