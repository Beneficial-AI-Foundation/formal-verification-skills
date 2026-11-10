const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const runtime = import(pathToFileURL(path.resolve(__dirname, '../scripts/fvs-probe-windows-runtime.mjs')));
const setup = import(pathToFileURL(path.resolve(__dirname, '../scripts/fvs-probe-windows-setup.mjs')));
const native = process.platform === 'win32' && process.arch === 'x64';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t) { const p = path.resolve(__dirname, '../.native-work'); fs.mkdirSync(p, { recursive: true }); const root = fs.mkdtempSync(path.join(p, 'setup unit with spaces ')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function project(root) {
  write(path.join(root, 'aeneas-config.yml'), 'aeneas:\n  commit: "6e167c9b"\ncrate:\n  dir: "."\naeneas_args:\n  dest: "Proof"\n');
  write(path.join(root, 'Proof', 'translation.json'), JSON.stringify({ aeneas_version: '6e167c9b', charon_version: '0.1.225' }));
  write(path.join(root, 'lake-manifest.json'), JSON.stringify({ packages: [{ name: 'aeneas', rev: '6e167c9b63a4dafd66d0e0edd9d94669f957ff7b' }] }));
  write(path.join(root, 'lean-toolchain'), 'leanprover/lean4:v4.31.0\n'); write(path.join(root, 'Cargo.lock'), 'version = 4\n'); write(path.join(root, 'Cargo.toml'), '[package]\nname="fixture"\nversion="0.1.0"\n');
}
test('setup requires explicit consent before host inspection or filesystem mutation', async () => {
  const m = await setup;
  await assert.rejects(m.setupWindowsRuntime({ projectRoot: 'does-not-exist' }), /explicit consent/);
  const old = process.env.FVS_PROBE_SETUP_POLICY; delete process.env.FVS_PROBE_SETUP_POLICY;
  try { await assert.rejects(m.setupWindowsRuntime({ projectRoot: 'does-not-exist', decision: 'policy' }), /FVS_PROBE_SETUP_POLICY=build/); } finally { if (old !== undefined) process.env.FVS_PROBE_SETUP_POLICY = old; }
  await assert.rejects(m.recoverWindowsSetup({ sessionId: '../arbitrary' }), /exact setup/);
});

test('installed prerequisite hardlinks become independent copies without changing source links', { skip: !native }, async t => {
  const { copyPrerequisiteIndependent, copyIndependent } = await import(pathToFileURL(path.resolve(__dirname, '../scripts/fvs-probe-native/windows-source/build-source.mjs')));
  const root = fixture(t), source = path.join(root, 'git'), output = path.join(root, 'copy'); write(path.join(source, 'cmd', 'git.exe'), 'native prerequisite bytes'); fs.mkdirSync(path.join(source, 'ucrt64', 'bin'), { recursive: true }); fs.linkSync(path.join(source, 'cmd', 'git.exe'), path.join(source, 'ucrt64', 'bin', 'git.exe'));
  const records = copyPrerequisiteIndependent(source, output); assert.equal(records.length, 2); assert.ok(records.every(x => x.sourceLinkCount === 2));
  for (const relative of ['cmd/git.exe', 'ucrt64/bin/git.exe']) { assert.equal(fs.statSync(path.join(source, relative)).nlink, 2); assert.equal(fs.statSync(path.join(output, relative)).nlink, 1); assert.equal(fs.readFileSync(path.join(output, relative), 'utf8'), 'native prerequisite bytes'); }
  assert.throws(() => copyIndependent(source, path.join(root, 'strict-copy')), /Link or special/);
  fs.mkdirSync(path.join(root, 'outside')); write(path.join(root, 'outside', 'value'), 'outside source'); fs.symlinkSync(path.join(root, 'outside'), path.join(source, 'nested-junction'), 'junction');
  assert.throws(() => copyPrerequisiteIndependent(source, path.join(root, 'alias-copy')), /Link or special/);
  fs.symlinkSync(source, path.join(root, 'source-alias'), 'junction'); assert.throws(() => copyPrerequisiteIndependent(path.join(root, 'source-alias'), path.join(root, 'root-alias-copy')), /Link or special/);
});

test('registered helper reuse needs no external cache or compiler and rejects changed bytes during reuse', { skip: !native }, async t => {
  const { buildWindowsGroups } = await import(pathToFileURL(path.resolve(__dirname, '../scripts/fvs-probe-native/windows-source/build-source.mjs')));
  const { fingerprintWindowsResource } = await runtime;
  const root = fixture(t), reusableGroups = {};
  for (const name of ['probe-aeneas', 'probe-rust', 'probe-lean', 'scip', 'rustup']) {
    const source = path.join(root, 'registered', name);
    write(path.join(source, name + '.exe'), 'previously authenticated bytes: ' + name);
    reusableGroups[name] = { source, installationId: 'a'.repeat(32), receiptSha256: 'b'.repeat(64),
      build: { origin: 'fresh-source-build', source: { commit: 'c'.repeat(40) }, output: fingerprintWindowsResource(source) } };
  }
  const ctx = { stage: path.join(root, 'new-stage'), reusableGroups,
    run: () => { throw Error('Reuse must not launch a compiler or download'); } };
  const { builds, groups } = await buildWindowsGroups(ctx);
  for (const [name, previous] of Object.entries(reusableGroups)) {
    assert.deepEqual(builds[name].output, previous.build.output);
    assert.deepEqual(builds[name].reusedFrom, { installationId: previous.installationId, receiptSha256: previous.receiptSha256 });
    assert.notEqual(fs.statSync(path.join(groups[name], name + '.exe')).ino, fs.statSync(path.join(previous.source, name + '.exe')).ino);
  }
  write(path.join(reusableGroups['probe-aeneas'].source, 'probe-aeneas.exe'), 'same version, substituted binary');
  await assert.rejects(buildWindowsGroups({ ...ctx, stage: path.join(root, 'changed-stage') }), /Registered helper changed while copying/);
});
test('setup checks actual pinned project provenance without writing a tools root', { skip: !native }, async t => {
  const m = await setup, root = fixture(t), input = path.join(root, 'project'), tools = path.join(root, 'tools'); project(input);
  const plan = m.planWindowsSetup({ projectRoot: input, toolsRoot: tools });
  assert.equal(plan.project.charonVersion, '0.1.225'); assert.equal(plan.verified, false); assert.equal(plan.host.nativeMachine, 0x8664); assert.equal(fs.existsSync(tools), false);
  assert.throws(() => m.planWindowsSetup({ projectRoot: input, toolsRoot: path.join(input, 'tools') }), /must be disjoint/); assert.equal(fs.existsSync(path.join(input, 'tools')), false);
  write(path.join(input, 'lean-toolchain'), 'leanprover/lean4:v4.30.0\n');
  assert.throws(() => m.readWindowsSourceProject(input), /supports only/); assert.equal(fs.existsSync(tools), false);
});
async function host(root, facts) {
  const child = spawn(facts.powershell, ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop';Add-Type -Path $env:FVS_SETUP_HOST_SOURCE -ReferencedAssemblies System.Web.Extensions,System.Core;exit [FvsSourceSetupHost]::Run($env:FVS_SETUP_LOCK,$env:FVS_COORDINATOR_LOCK,$env:FVS_ACTIVE_JOURNAL)"], { env: { ...process.env, FVS_SETUP_HOST_SOURCE: path.resolve(__dirname, '../scripts/fvs-probe-native/windows-source/SetupHost.cs'), FVS_SETUP_LOCK: path.join(root, 'setup.lock'), FVS_COORDINATOR_LOCK: path.join(root, 'lifecycle.lock'), FVS_ACTIVE_JOURNAL: path.join(root, 'active.json') }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = [], waiters = []; let buffer = '', stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  child.stdout.on('data', data => { buffer += data; for (;;) { const i = buffer.indexOf('\n'); if (i < 0) break; const value = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); const waiter = waiters.shift(); if (waiter) waiter(value); else messages.push(value); } });
  const closed = new Promise(resolve => child.on('close', code => resolve({ code, stderr })));
  const next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => waiters.push(resolve));
  return { child, closed, next, ready: await Promise.race([next(), closed.then(value => { throw new Error(JSON.stringify(value)); }), delay(15000).then(() => { throw new Error('host readiness timeout'); })]) };
}
test('setup host quotes arguments and drains its job before releasing the shared lease', { skip: !native, timeout: 30000 }, async t => {
  const facts = (await runtime).getWindowsHostFacts(), root = fixture(t), first = await host(root, facts);
  t.after(() => first.child.stdin.end()); assert.equal(first.ready.ready, true);
  const contender = await host(root, facts); assert.equal(contender.ready.ready, false); await contender.closed;
  const unicode = path.join(root, 'Zażółć_日本'); fs.mkdirSync(unicode);
  first.child.stdin.write(JSON.stringify({ operation: 'execute', id: 'quotes', executable: process.execPath, args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', unicode, 'quote"and\\slash', 'ends\\'], cwd: unicode, environment: { ...process.env }, log: path.join(unicode, 'quote-command') }) + '\n');
  const result = await first.next(); assert.equal(result.ok, true, result.error); assert.equal(result.activeProcessesAfter, 0); assert.deepEqual(JSON.parse(result.stdout), [unicode, 'quote"and\\slash', 'ends\\']);
  const batch = path.join(root, 'batch with spaces.cmd'); write(batch, '@echo off\r\nset FVS_SETUP_QUOTE_TEST=correct-value\r\n');
  first.child.stdin.write(JSON.stringify({ operation: 'execute', id: 'cmd', executable: path.join(facts.systemDirectory, 'cmd.exe'), args: ['/d', '/s', '/c', `"${batch}" >nul && set FVS_SETUP_QUOTE_TEST`], cwd: root, environment: { ...process.env }, log: path.join(root, 'cmd-command') }) + '\n');
  const cmd = await first.next(); assert.equal(cmd.ok, true, cmd.error ?? cmd.stderr); assert.equal(cmd.stdout.trim(), 'FVS_SETUP_QUOTE_TEST=correct-value');
  first.child.stdin.end(JSON.stringify({ operation: 'release' }) + '\n'); assert.equal((await first.closed).code, 0);
});
test('parent EOF kills the whole setup process tree before a new lease is available', { skip: !native, timeout: 30000 }, async t => {
  const facts = (await runtime).getWindowsHostFacts(), root = fixture(t), h = await host(root, facts); t.after(() => h.child.stdin.end());
  const pidFile = path.join(root, 'pids.json'), heartbeat = path.join(root, 'heartbeat.txt');
  const grandchild = `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),30)`;
  const program = `const cp=require('child_process'),fs=require('fs');const c=cp.spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000)`;
  h.child.stdin.write(JSON.stringify({ operation: 'execute', id: 'tree', executable: process.execPath, args: ['-e', program], cwd: root, environment: { ...process.env }, log: path.join(root, 'tree-command') }) + '\n');
  for (let i = 0; i < 200 && !fs.existsSync(pidFile); i++) await delay(25);
  assert.ok(fs.existsSync(pidFile), 'real build parent and descendant must start'); const pids = JSON.parse(fs.readFileSync(pidFile));
  h.child.stdin.end(); await h.closed;
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  const size = fs.existsSync(heartbeat) ? fs.statSync(heartbeat).size : 0; await delay(120); assert.equal(fs.existsSync(heartbeat) ? fs.statSync(heartbeat).size : 0, size);
  const next = await host(root, facts); assert.equal(next.ready.ready, true); next.child.stdin.end(JSON.stringify({ operation: 'release' }) + '\n'); await next.closed;
});
test('active native session blocks setup under the shared coordinator lease', { skip: !native, timeout: 15000 }, async t => {
  const facts = (await runtime).getWindowsHostFacts(), root = fixture(t); write(path.join(root, 'active.json'), JSON.stringify({ phase: 'prepared' }));
  const h = await host(root, facts); assert.equal(h.ready.ready, false); assert.match(h.ready.error, /native confinement session/); await h.closed;
});

test('terminal native journal needs matching durable cleanup evidence before setup', { skip: !native, timeout: 30000 }, async t => {
  const facts = (await runtime).getWindowsHostFacts(), root = fixture(t), id = require('node:crypto').randomBytes(16).toString('hex');
  const hash = bytes => require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
  const sessionDirectory = path.join(root, 's', id), controlDirectory = path.join(sessionDirectory, 'c'), stageRoot = path.join(sessionDirectory, 's');
  const receiptFile = path.join(controlDirectory, 'terminal-receipt.json'); write(receiptFile, JSON.stringify({ sessionId: id, profileAbsent: true, stageRemoved: true, aclCleanupConfirmed: true }));
  const journal = { schema: 'fvs/windows-lifecycle-journal/v2', phase: 'disposed', storageLayout: 'compact-v1', sessionId: id, sessionDirectory, controlDirectory, stageRoot, profileRoot: path.join(facts.localAppData, 'Packages', 'FVS.Windows.' + id), terminalReceiptSha256: hash(fs.readFileSync(receiptFile)) };
  journal.integritySha256 = hash(canonical(journal)); write(path.join(root, 'active.json'), JSON.stringify(journal));
  const h = await host(root, facts); assert.equal(h.ready.ready, true, h.ready.error); h.child.stdin.end(JSON.stringify({ operation: 'release' }) + '\n'); await h.closed;
  fs.appendFileSync(receiptFile, ' ');
  const altered = await host(root, facts); assert.equal(altered.ready.ready, false); assert.match(altered.ready.error, /receipt checksum/); await altered.closed;
});

test('hard-killed setup host cannot leave descendants writing after lease reacquisition', { skip: !native, timeout: 30000 }, async t => {
  const facts = (await runtime).getWindowsHostFacts(), root = fixture(t), h = await host(root, facts); t.after(() => h.child.kill());
  const pidFile = path.join(root, 'hardkill-pids.json');
  const program = `const fs=require('fs'),cp=require('child_process');const c=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000)`;
  h.child.stdin.write(JSON.stringify({ operation: 'execute', id: 'hardkill', executable: process.execPath, args: ['-e', program], cwd: root, environment: { ...process.env }, log: path.join(root, 'hardkill-command') }) + '\n');
  for (let i = 0; i < 200 && !fs.existsSync(pidFile); i++) await delay(25);
  assert.ok(fs.existsSync(pidFile)); const pids = JSON.parse(fs.readFileSync(pidFile));
  h.child.kill(); await h.closed;
  const next = await host(root, facts); assert.equal(next.ready.ready, true, next.ready.error);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  next.child.stdin.end(JSON.stringify({ operation: 'release' }) + '\n'); await next.closed;
});

test('interrupted publication recovery preserves adopted files and rejects substituted stage identities', { skip: !native, timeout: 60000 }, async t => {
  const m = await runtime, s = await setup, root = fixture(t), facts = m.getWindowsHostFacts();
  const cp = require('node:child_process'), { syncBuiltinESMExports } = require('node:module'), original = cp.spawnSync;
  const fake = { ...facts, profile: path.join(root, 'profile') }; fs.mkdirSync(fake.profile);
  cp.spawnSync = (exe, args, options) => args?.some(x => String(x).includes('FVS_HOST_FACTS_SOURCE')) ? { status: 0, stdout: JSON.stringify(fake), stderr: '' } : original(exe, args, options); syncBuiltinESMExports();
  const identity = file => { const st = fs.lstatSync(file, { bigint: true }); return { dev: String(st.dev), ino: String(st.ino) }; };
  try {
    const toolsRoot = path.join(root, 'tools'), base = m.windowsInstallRoot({ toolsRoot, facts: fake }), id = 'b'.repeat(32), stage = path.join(base, 'staging', id), bundle = path.join(base, 'installations', id);
    m.createWindowsManagedDirectory(base, fake); fs.mkdirSync(stage, { recursive: true });
    const owned = path.join(fake.profile, '.local', 'bin', 'zlib1.dll'), adopted = path.join(fake.profile, '.local', 'bin', 'probe-lean-v4.31.0.exe'); write(owned, 'owned publication'); write(adopted, 'adopted existing bytes');
    const journal = { schema: 'fvs/windows-source-setup-journal/v1', userSid: fake.userSid, originSessionId: fake.host.originSessionId, originLogonId: fake.host.originLogonId, installationId: id, stage, stageIdentity: identity(stage), bundle, publications: [{ path: owned, sha256: m.windowsFileSha256(owned), bytes: fs.statSync(owned).size, identity: identity(owned), adopted: false, completed: true }, { path: adopted, adopted: true }], createdDirectories: [] };
    const journalFile = path.join(base, 'SETUP.json'); write(journalFile, JSON.stringify(journal));
    const coordinator = path.join(fake.profile, '.fvs', 'windows-confinement'); m.createWindowsManagedDirectory(coordinator, fake);
    const markerPath = path.join(coordinator, 'setup-active.json');
    const marker = { schema: 'fvs/windows-source-setup-active/v1', sessionId: 'setup:' + id, installationId: id, userSid: fake.userSid, originSessionId: fake.host.originSessionId, originLogonId: fake.host.originLogonId, root: base, rootIdentity: identity(base), journalPath: journalFile, policySha256: m.getWindowsSourcePolicy().sha256, createdAt: new Date().toISOString() };
    const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
    marker.integritySha256 = require('node:crypto').createHash('sha256').update(canonical(marker)).digest('hex'); write(markerPath, JSON.stringify(marker));
    const wrongOrigin = { ...marker, originLogonId: '0'.repeat(16) }; delete wrongOrigin.integritySha256; wrongOrigin.integritySha256 = require('node:crypto').createHash('sha256').update(canonical(wrongOrigin)).digest('hex'); write(markerPath, JSON.stringify(wrongOrigin));
    await assert.rejects(s.recoverWindowsSetup({ sessionId: 'setup:' + id }), /Alternate-logon/); assert.ok(fs.existsSync(owned)); write(markerPath, JSON.stringify(marker));
    const saved = stage + '-substituted'; fs.renameSync(stage, saved); fs.mkdirSync(stage);
    await assert.rejects(s.recoverWindowsSetup({ toolsRoot, sessionId: 'setup:' + id }), /substituted/); assert.ok(fs.existsSync(owned)); assert.ok(fs.existsSync(saved)); assert.ok(fs.existsSync(markerPath));
    fs.rmdirSync(stage); fs.renameSync(saved, stage);
    await assert.rejects(s.recoverWindowsSetup({ toolsRoot, sessionId: 'setup:' + 'c'.repeat(32) }), /does not match/);
    const oldTools = process.env.FVS_TOOLS_HOME; process.env.FVS_TOOLS_HOME = path.join(root, 'changed-tools-root');
    let result; try { result = await s.recoverWindowsSetup({ sessionId: 'setup:' + id }); } finally { if (oldTools === undefined) delete process.env.FVS_TOOLS_HOME; else process.env.FVS_TOOLS_HOME = oldTools; }
    assert.equal(result.status, 'rolled-back'); assert.equal(fs.existsSync(markerPath), false); assert.equal(fs.existsSync(path.join(root, 'changed-tools-root')), false);
    assert.equal(fs.existsSync(owned), false); assert.equal(fs.readFileSync(adopted, 'utf8'), 'adopted existing bytes'); assert.equal(fs.existsSync(stage), false); assert.equal(fs.existsSync(journalFile), false);
    assert.equal((await s.recoverWindowsSetup({ toolsRoot, sessionId: 'setup:' + id })).status, 'already-recovered');
  } finally { cp.spawnSync = original; syncBuiltinESMExports(); }
});

test('journal recovery handles hard exit after tagged creation but before inode persistence', { skip: !native, timeout: 120000 }, async t => {
  const m = await runtime, s = await setup, root = fixture(t), facts = m.getWindowsHostFacts();
  const cp = require('node:child_process'), { syncBuiltinESMExports } = require('node:module'), original = cp.spawnSync, crypto = require('node:crypto');
  const fake = { ...facts, profile: path.join(root, 'profile') }; fs.mkdirSync(fake.profile);
  cp.spawnSync = (exe, args, options) => args?.some(x => String(x).includes('FVS_HOST_FACTS_SOURCE')) ? { status: 0, stdout: JSON.stringify(fake), stderr: '' } : original(exe, args, options); syncBuiltinESMExports();
  const identity = file => { const st = fs.lstatSync(file, { bigint: true }); return { dev: String(st.dev), ino: String(st.ino) }; };
  const canonical = value => value && typeof value === 'object' ? Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const tag = () => 'S-1-5-21-' + [0, 1, 2, 3].map(() => crypto.randomBytes(4).readUInt32LE()).join('-');
  try {
    const toolsRoot = path.join(root, 'tools'), base = m.windowsInstallRoot({ toolsRoot, facts: fake }), coordinator = path.join(fake.profile, '.fvs', 'windows-confinement');
    m.createWindowsManagedDirectory(base, fake); m.createWindowsManagedDirectory(coordinator, fake); fs.mkdirSync(path.join(base, 'staging')); fs.mkdirSync(path.join(base, 'installations'));
    const markerFile = path.join(coordinator, 'setup-active.json'), journalFile = path.join(base, 'SETUP.json');
    const makeJournal = () => { const id = crypto.randomBytes(16).toString('hex'); return { schema: 'fvs/windows-source-setup-journal/v1', installationId: id, userSid: fake.userSid, originSessionId: fake.host.originSessionId, originLogonId: fake.host.originLogonId, stage: path.join(base, 'staging', id), stageCreationTag: tag(), stageParentIdentity: identity(path.join(base, 'staging')), bundle: path.join(base, 'installations', id), publications: [], createdDirectories: [] }; };
    const save = journal => { write(journalFile, JSON.stringify(journal)); const marker = { schema: 'fvs/windows-source-setup-active/v1', installationId: journal.installationId, sessionId: 'setup:' + journal.installationId, userSid: fake.userSid, originSessionId: fake.host.originSessionId, originLogonId: fake.host.originLogonId, root: base, rootIdentity: identity(base), journalPath: journalFile }; marker.integritySha256 = hash(canonical(marker)); write(markerFile, JSON.stringify(marker)); };
    const killAfter = (code, env) => { const result = original(facts.powershell, ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop';Add-Type -Path $env:FVS_TEST_CREATION_SOURCE;" + code + ';Stop-Process -Id $PID -Force'], { env: { ...process.env, ...env, FVS_TEST_CREATION_SOURCE: path.resolve(__dirname, '../scripts/fvs-probe-native/windows-source/SetupCreation.cs') }, encoding: 'utf8', windowsHide: true, timeout: 30000 }); assert.notEqual(result.status, 0); assert.equal(result.stderr, '', result.stderr); };
    const first = makeJournal(); save(first);
    killAfter('[FvsSetupCreation]::CreateDirectory($env:FVS_TEST_PATH,$env:FVS_TEST_TAG)', { FVS_TEST_PATH: first.stage, FVS_TEST_TAG: first.stageCreationTag });
    assert.ok(fs.existsSync(first.stage)); assert.equal((await s.recoverWindowsSetup({ sessionId: 'setup:' + first.installationId })).status, 'rolled-back'); assert.equal(fs.existsSync(first.stage), false);
    const second = makeJournal(); fs.mkdirSync(second.stage); second.stageIdentity = identity(second.stage);
    const bin = path.join(fake.profile, '.local', 'bin'), lib = path.join(fake.profile, '.local', 'lib'); fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(lib);
    const input = path.join(root, 'payload.bin'); write(input, 'source bytes copied before the deliberately missing inode save');
    const temporary = path.join(bin, '.fvs-source-' + crypto.randomBytes(16).toString('hex') + '.tmp'), directory = path.join(lib, 'probe-lean-v4.31.0');
    const fileTag = tag(), directoryTag = tag(), bundleTag = tag();
    second.publications = [{ path: path.join(bin, 'zlib1.dll'), temporary, creationTag: fileTag, parentIdentity: identity(bin), adopted: false, bytes: fs.statSync(input).size, sha256: hash(fs.readFileSync(input)) }];
    second.createdDirectories = [{ path: directory, creationTag: directoryTag, parentIdentity: identity(lib), identity: null }]; save(second);
    killAfter('[FvsSetupCreation]::CreateDirectory($env:FVS_TEST_BUNDLE,$env:FVS_TEST_BUNDLE_TAG);[FvsSetupCreation]::CreateDirectory($env:FVS_TEST_DIRECTORY,$env:FVS_TEST_DIRECTORY_TAG);[FvsSetupCreation]::CopyFile($env:FVS_TEST_INPUT,$env:FVS_TEST_TEMP,$env:FVS_TEST_FILE_TAG)', { FVS_TEST_BUNDLE: path.join(second.stage, 'bundle'), FVS_TEST_BUNDLE_TAG: bundleTag, FVS_TEST_DIRECTORY: directory, FVS_TEST_DIRECTORY_TAG: directoryTag, FVS_TEST_INPUT: input, FVS_TEST_TEMP: temporary, FVS_TEST_FILE_TAG: fileTag });
    assert.ok(fs.existsSync(temporary)); assert.equal((await s.recoverWindowsSetup({ sessionId: 'setup:' + second.installationId })).status, 'rolled-back');
    for (const file of [temporary, directory, second.stage, markerFile]) assert.equal(fs.existsSync(file), false, file);
  } finally { cp.spawnSync = original; syncBuiltinESMExports(); }
});
