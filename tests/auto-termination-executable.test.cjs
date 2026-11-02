// File identity only: no executable, Beads/backend, capture, after or Lean invocation.
const { before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
let api;
before(async () => { api = await import('../scripts/fvs-auto-respec.mjs'); });
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const root = fs.mkdtempSync(path.join(process.env.FVS_RESPEC_QUAL_OUT ?? fs.realpathSync(os.tmpdir()), 'fvs-executable-identity-'));
const file = (name, bytes = 'owned executable identity only') => { const p = path.join(root, name); fs.writeFileSync(p, bytes, { flag: 'wx', mode: 0o700 }); return { file: p, sha256: sha(bytes) }; };
const deadline = () => Date.now() + 60000;
async function independentHash(p) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(p, { highWaterMark: 65536 })) hash.update(chunk);
  return hash.digest('hex');
}
function noWholeReadOrExecution(fn) {
  const readFile = fs.readFileSync, spawn = cp.spawn, spawnSync = cp.spawnSync, alloc = Buffer.allocUnsafe;
  let reads = 0, maximumAllocation = 0;
  fs.readFileSync = () => { reads++; throw Error('whole-file read forbidden'); };
  cp.spawn = cp.spawnSync = () => { throw Error('execution forbidden'); }; syncBuiltinESMExports();
  Buffer.allocUnsafe = function(n) { maximumAllocation = Math.max(maximumAllocation, n); assert.ok(n <= 1048576, 'bounded allocation'); return alloc.call(Buffer, n); };
  try { const value = fn(); assert.equal(reads, 0); assert.ok(maximumAllocation <= 1048576); return value; }
  finally { fs.readFileSync = readFile; cp.spawn = spawn; cp.spawnSync = spawnSync; Buffer.allocUnsafe = alloc; syncBuiltinESMExports(); }
}
const refuse = (fn, reason) => assert.throws(fn, e => /^respec-/.test(e.code) && reason.test(e.message));
describe('streamed executable identity with finite supported-profile bound', () => {
  it('separates the real pinned Beads-sized boundary from the unchanged32MiB document limit', async () => {
    assert.equal(api.TERMINATION_EXECUTABLE_BYTES, 142769104);
    const p = path.join(root, 'maximum-tool'), fd = fs.openSync(p, 'wx', 0o700);
    fs.ftruncateSync(fd, api.TERMINATION_EXECUTABLE_BYTES); fs.writeSync(fd, Buffer.from('boundary'), 0, 8, api.TERMINATION_EXECUTABLE_BYTES - 8); fs.closeSync(fd);
    const r = { file: p, sha256: await independentHash(p) };
    const result = noWholeReadOrExecution(() => api.terminationExecutableIdentity(r, deadline()));
    assert.equal(result.sizeBytes, api.TERMINATION_EXECUTABLE_BYTES); assert.equal(result.sha256, r.sha256);
    const { BUNDLE_LIMITS } = await import('../scripts/fvs-auto-bundle.mjs'); assert.equal(BUNDLE_LIMITS.fileBytes, 33554432);
  });
  const beads = '/opt/homebrew/Cellar/beads/1.3.1/bin/beads';
  it('validates the actual pinned installed Beads metadata/hash without executing or buffering it', { skip: !fs.existsSync(beads) }, () => {
    const before = fs.statSync(beads); assert.equal(before.size, 142769104);
    const r = { file: beads, sha256: '842879338715dc25b5a9f48864ae55846e9792195876e2803d6b51d3ec524a92' };
    const value = noWholeReadOrExecution(() => api.terminationExecutableIdentity(r, deadline()));
    const after = fs.statSync(beads); assert.equal(after.ino, before.ino); assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs); assert.equal(after.ctimeMs, before.ctimeMs); assert.equal(after.mode, before.mode);
    fs.writeFileSync(path.join(root, 'real-beads-hash-only.json'), JSON.stringify({ authority: 'file identity only; no execution/backend or applicability', result: value, before: { ino: before.ino, size: before.size, mode: before.mode, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs }, after: { ino: after.ino, size: after.size, mode: after.mode, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs }, wholeExecutableRead: false, execution: false }, null, 2) + '\n');
  });
  const git = '/usr/bin/git';
  it('preserves only the pinned root-owned system Git dispatcher hardlinks', { skip: process.platform !== 'darwin' }, () => {
    const r = { file: git, sha256: 'b8763cf250e607a778bb4603cecb5b90338814d0a3dfcba0d57b1de242f610e9' };
    const s = fs.statSync(git); assert.ok(s.nlink > 1 && s.nlink <= 78); assert.equal(s.size, 118640);
    assert.equal(noWholeReadOrExecution(() => api.terminationExecutableIdentity(r, deadline())).sha256, r.sha256);
    refuse(() => api.terminationExecutableIdentity({ ...r, sha256: 'f'.repeat(64) }, deadline()), /non-aliased/);
  });
  it('refuses one byte beyond the finite executable bound before reading bytes', () => {
    const p = path.join(root, 'oversize'), fd = fs.openSync(p, 'wx', 0o700); fs.ftruncateSync(fd, api.TERMINATION_EXECUTABLE_BYTES + 1); fs.closeSync(fd);
    const original = fs.readSync; let reads = 0; fs.readSync = function(...args) { reads++; return original.apply(fs, args); };
    try { refuse(() => api.terminationExecutableIdentity({ file: p, sha256: 'a'.repeat(64) }, deadline()), /size bound/); assert.equal(reads, 0); } finally { fs.readSync = original; }
  });
  it('rejects mismatched hash and non-executable/empty/non-regular paths', () => {
    const r = file('wrong-hash'); refuse(() => api.terminationExecutableIdentity({ ...r, sha256: 'f'.repeat(64) }, deadline()), /hash changed/);
    fs.chmodSync(r.file, 0o600); refuse(() => api.terminationExecutableIdentity(r, deadline()), /executable required/);
    const empty = file('empty', ''); refuse(() => api.terminationExecutableIdentity(empty, deadline()), /size bound/);
    refuse(() => api.terminationExecutableIdentity({ file: root, sha256: r.sha256 }, deadline()), /executable required/);
  });
  for (const kind of ['leaf-symlink', 'parent-symlink', 'hardlink']) it('rejects ' + kind + ' aliases', () => {
    const r = file('alias-base-' + kind), alias = path.join(root, 'alias-' + kind);
    if (kind === 'leaf-symlink') fs.symlinkSync(r.file, alias);
    if (kind === 'hardlink') fs.linkSync(r.file, alias);
    if (kind === 'parent-symlink') { fs.symlinkSync(root, alias); r.file = path.join(alias, path.basename(r.file)); }
    else r.file = alias;
    refuse(() => api.terminationExecutableIdentity(r, deadline()), /alias|non-aliased/);
  });
  for (const kind of ['bytes', 'grow', 'shrink', 'replace-same-bytes', 'hardlink', 'mode']) it('refuses in-flight ' + kind + ' drift', () => {
    const r = file('drift-' + kind, Buffer.alloc(2 * 1024 * 1024, 65)), original = fs.readSync; let changed = false;
    fs.readSync = function(...args) {
      const count = original.apply(fs, args);
      if (!changed) {
        changed = true;
        if (kind === 'bytes') { const fd = fs.openSync(r.file, 'r+'); fs.writeSync(fd, Buffer.from('B'), 0, 1, 1500000); fs.closeSync(fd); }
        if (kind === 'grow') fs.appendFileSync(r.file, 'B');
        if (kind === 'shrink') fs.truncateSync(r.file, 1);
        if (kind === 'replace-same-bytes') { fs.renameSync(r.file, r.file + '.retained'); fs.writeFileSync(r.file, Buffer.alloc(2 * 1024 * 1024, 65), { mode: 0o700 }); }
        if (kind === 'hardlink') fs.linkSync(r.file, r.file + '.alias');
        if (kind === 'mode') fs.chmodSync(r.file, 0o500);
      }
      return count;
    };
    try { refuse(() => api.terminationExecutableIdentity(r, deadline()), /drift|grew|shrank|non-aliased/); } finally { fs.readSync = original; }
  });
  it('detects byte-identical path replacement between stat and open', () => {
    const r = file('open-race'), original = fs.openSync; let changed = false;
    fs.openSync = function(p, ...args) { if (p === r.file && !changed) { changed = true; fs.renameSync(p, p + '.retained'); fs.writeFileSync(p, 'owned executable identity only', { mode: 0o700 }); } return original.call(fs, p, ...args); };
    try { refuse(() => api.terminationExecutableIdentity(r, deadline()), /path changed before hashing/); } finally { fs.openSync = original; }
  });
  for (const kind of ['expired', 'during-read', 'rollback']) it('keeps deadline/clock checks: ' + kind, () => {
    const r = file('clock-' + kind, Buffer.alloc(2 * 1024 * 1024, 65)), now = Date.now, read = fs.readSync; let time = now(); const end = time + 1000;
    Date.now = () => time; fs.readSync = function(...args) { const n = read.apply(fs, args); time = kind === 'rollback' ? time - 5000 : end + 1; return n; };
    try { refuse(() => api.terminationExecutableIdentity(r, kind === 'expired' ? time - 1 : end), /deadline|backwards|future bounded600s/); } finally { Date.now = now; fs.readSync = read; }
  });
  it('rejects hidden hooks without invoking them or reading a tool', () => {
    const r = file('hook'), bad = { ...r }; let hooks = 0;
    Object.defineProperty(bad, 'toJSON', { value: () => { hooks++; return r; } });
    assert.throws(() => api.terminationExecutableIdentity(bad, deadline())); assert.equal(hooks, 0);
  });
});
