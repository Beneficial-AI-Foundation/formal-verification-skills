// Execution control is scheduling metadata, never proof authority.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { memoryDataSnapshot } from './fvs-project-memory.mjs';

const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
export class ExecutionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const reject = message => { throw new ExecutionError('execution-invalid', message); };
function closed(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) reject('invalid closed ' + label);
}
export const executionData = value => JSON.parse(JSON.stringify(memoryDataSnapshot(value)));
export function parseBudget(raw, resolved = false) {
  const value = JSON.parse(JSON.stringify(memoryDataSnapshot(raw)));
  if (value?.kind === 'none') closed(value, ['kind'], 'no-budget policy');
  else if (resolved && value?.kind === 'deadline') {
    closed(value, ['kind', 'deadlineMs'], 'selected deadline');
    if (!Number.isSafeInteger(value.deadlineMs) || value.deadlineMs < 0) reject('invalid selected deadline');
  } else if (!resolved && value?.kind === 'wall-clock') {
    closed(value, ['kind', 'hours'], 'selected wall budget');
    if (typeof value.hours !== 'number' || !Number.isFinite(value.hours) || value.hours <= 0) reject('invalid selected wall budget');
  } else reject('unsupported budget policy');
  return value;
}
export function createExecution(runId, budget) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(runId)) reject('execution run identity required');
  const value = { schema: 'fvs/execution-control', schemaVersion: 1, runId, budget: parseBudget(budget, true) };
  return { ...value, policySha256: hash(value) };
}
export function parseExecution(raw) {
  const value = JSON.parse(JSON.stringify(memoryDataSnapshot(raw)));
  closed(value, ['schema', 'schemaVersion', 'runId', 'budget', 'policySha256'], 'execution control');
  if (value.schema !== 'fvs/execution-control' || value.schemaVersion !== 1) reject('unsupported execution control');
  const expected = createExecution(value.runId, value.budget);
  if (value.policySha256 !== expected.policySha256) reject('execution policy identity differs');
  return expected;
}
export const sameExecutionPolicy=(left,right)=>canonical(parseExecution(left))===canonical(parseExecution(right));

export function resolveBudget(budget, startedAtMs) {
  const selected = parseBudget(budget);
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0) reject('invalid original start');
  if (selected.kind === 'none') return selected;
  const deadlineMs = Math.floor(startedAtMs + selected.hours * 3600000);
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= startedAtMs) reject('selected budget exceeds representable clock');
  return { kind: 'deadline', deadlineMs };
}
export function requestControl(job) {
  if (job?.version === 2) {
    if (Object.hasOwn(job, 'deadlineMs')) reject('v2 cannot mix legacy deadlineMs');
    return parseExecution(job.execution);
  }
  if (job?.version !== 1 || Object.hasOwn(job, 'execution') || !Number.isSafeInteger(job.deadlineMs)) reject('v1 finite deadline or v2 execution control required');
  return job.deadlineMs;
}
export function controlDeadline(control) {
  if (typeof control === 'number') {
    if (!Number.isSafeInteger(control)) reject('finite legacy deadline required');
    return control;
  }
  const value = parseExecution(control);
  return value.budget.kind === 'none' ? null : value.budget.deadlineMs;
}
export function assertRunning(control, { signal, now = Date.now } = {}) {
  if (signal?.aborted) throw new ExecutionError('cancelled', 'operation cancelled; no proof result');
  const deadline = controlDeadline(control);
  if (deadline !== null && !Number.isSafeInteger(now())) reject('valid selected-budget clock required');
  if (deadline !== null && now() >= deadline) throw new ExecutionError('timeout', 'selected execution budget exhausted');
}
export function timeoutOptions(control, { now = Date.now, administrativeMs } = {}) {
  assertRunning(control, { now });
  const deadline = controlDeadline(control);
  const remaining = deadline === null ? null : Math.max(1, deadline - now());
  if (administrativeMs !== undefined && (!Number.isSafeInteger(administrativeMs) || administrativeMs <= 0)) reject('invalid administrative operation timeout');
  const timeout = administrativeMs === undefined ? remaining : remaining === null ? administrativeMs : Math.min(remaining, administrativeMs);
  return timeout === null ? {} : { timeout };
}
export function executionFields(job) {
  const control = requestControl(job);
  return job.version === 2 ? { version: 2, execution: control } : { version: 1, deadlineMs: control };
}
export function trustedRunner(tools = {}) {
  return { schema: 'fvs/trusted-runner-profile', schemaVersion: 1, platform: process.platform, architecture: process.arch,
    network: 'enabled', boundary: 'trusted host; no per-command OS isolation or descendant attestation claimed', tools };
}

// Signals apply only to a retained live child, never to a replayed PID.
export function runOwned(argv, options, control, { signal, spawnProcess = spawn, now = Date.now, inheritGroup = false, onSpawn, scheduleTimeout = setTimeout, cancelTimeout = clearTimeout, probeGroup = pid => {
  try { process.kill(-pid, 0); return 'present'; } catch (error) { return error.code === 'ESRCH' ? 'absent' : 'unknown'; }
} } = {}) {
  assertRunning(control, { signal, now });
  if (!Array.isArray(argv) || !argv.length || !path.isAbsolute(argv[0])) reject('absolute owned executable required');
  if (!options || !path.isAbsolute(options.cwd ?? '') || !options.env || Object.keys(options).some(key => !['cwd', 'env', 'maxBuffer', 'encoding'].includes(key))) reject('explicit owned cwd/environment and no hidden process timeout required');
  if (Object.values(options.env).some(value => typeof value !== 'string')) reject('string-only explicit child environment required');
  if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean')) reject('AbortSignal service required');
  const inheritedBefore=inheritGroup?observeCheckingGroup():null;
  if(inheritGroup&&inheritedBefore.status!=='quiescent')throw new ExecutionError('execution-uncertain','current checker does not own a quiescent supported checking group');
  const deadline = controlDeadline(control);
  const maxBuffer = options.maxBuffer ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 1) reject('bounded child output required');
  return new Promise((resolve, rejectPromise) => {
    let child, timer, drainTimer, forcedDrain = false, size = 0, cancelled = false, timedOut = false, overflow = false, error;
    const stdout = [], stderr = [];
    const stop = () => {
      if (!child || child.exitCode !== null || child.signalCode !== null || !(child.pid > 1)) return;
      try { if (process.platform === 'win32' || inheritGroup) child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); }
      catch (failure) { if (failure.code !== 'ESRCH') error ??= failure; }
    };
    const cancel = () => { cancelled = true; stop(); };
    try {
      assertRunning(control, { signal, now });
      child = spawnProcess(argv[0], argv.slice(1), { ...options, detached: process.platform !== 'win32' && !inheritGroup, stdio: ['ignore', 'pipe', 'pipe'] });
      child.on('error', failure => { error = failure; });
      child.once('exit',()=>{
        // A terminal parent must not leave the API waiting forever on an unsupported child pipe.
        drainTimer=setTimeout(()=>{forcedDrain=true;child.stdout.destroy();child.stderr.destroy();},1000);
      });
      child.on('close', async (status, childSignal) => {
        if (timer !== undefined) cancelTimeout(timer);if(drainTimer!==undefined)clearTimeout(drainTimer);
        signal?.removeEventListener('abort', cancel);
        const observeGroup = () => { try { const result = probeGroup(child.pid); return ['absent','present','unknown'].includes(result) ? result : 'unknown'; } catch { return 'unknown'; } };
        let inheritedAfter=inheritGroup?observeCheckingGroup():null;
        let ownership = inheritGroup ? inheritedAfter.status : child.pid > 1 && process.platform !== 'win32' ? observeGroup() : 'unsupported';
        // Bounded absence confirmation after exit is administrative cleanup, not a proof timer.
        const cleanupUntil = performance.now() + 1000;
        let joinAttempts=1;
        while ((ownership === 'present'||(inheritGroup&&ownership==='busy')) && performance.now() < cleanupUntil) {
          await new Promise(done => setTimeout(done, 25));
          if(inheritGroup){inheritedAfter=observeCheckingGroup();ownership=inheritedAfter.status;joinAttempts++;}else ownership=observeGroup();
        }
        resolve({ pid: child.pid ?? null, status, signal: childSignal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr),
          error, cancelled, timedOut, outputLimitExceeded: overflow, cleanupComplete: !forcedDrain && (ownership === 'absent' || ownership === 'quiescent'),
          cleanup: { kind: inheritGroup ? 'recorded-checking-group-join' : 'recorded-owned-group-absence', result: ownership, descendantAttestation: false, streamsDrained: !forcedDrain, ...(inheritGroup?{join:{before:inheritedBefore,after:inheritedAfter,attempts:joinAttempts}}:{}) } });
      });

      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      if (deadline !== null) {
        const monotonicEnd = performance.now() + Math.max(0, deadline - now());
        const arm = () => {
          const remaining = Math.min(deadline - now(), monotonicEnd - performance.now());
          if (remaining <= 0) { timedOut = true; stop(); return; }
          timer = scheduleTimeout(arm, Math.min(2147483647, Math.max(1, Math.ceil(remaining))));
        };
        arm();
      }
      const collect = list => bytes => {
        size += bytes.length;
        if (size > maxBuffer) { overflow = true; stop(); } else list.push(Buffer.from(bytes));
      };
      child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
      onSpawn?.(child);
    } catch (failure) {
      if (timer !== undefined) cancelTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (child) { error = failure; stop(); } else rejectPromise(failure);
    }
  });
}

export function runControl(run) {
  if (run?.schemaVersion === 2) return createExecution(run.runId, parseBudget(run.budget, true));
  if (!run || Object.hasOwn(run, 'budget') || !Number.isSafeInteger(run.deadlineMs)) reject('invalid legacy run control');
  return run.deadlineMs;
}
export function runExpired(run, now = Date.now()) {
  const deadline = controlDeadline(runControl(run));
  return deadline !== null && now >= deadline;
}
export function unbudgetedRun(run) {
  return run?.schemaVersion === 2 && controlDeadline(runControl(run)) === null;
}
export function runExecutionFields(run) {
  return run?.schemaVersion === 2 ? { version: 2, execution: runControl(run) } : { deadlineMs: runControl(run) };
}

// CLI signals are lifecycle intent; owned-process receipts establish the outcome.
export async function withProcessCancellation(operation, { stdinCancelId } = {}) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  let input = '';
  const cancelInput = bytes => {
    input += bytes.toString('utf8');
    if (input.length > 4096) { input = ''; return; }
    for (;;) { const end = input.indexOf('\n'); if (end < 0) break; const line = input.slice(0,end); input = input.slice(end+1); try { const value = JSON.parse(line); if (Object.keys(value).length === 2 && value.kind === 'cancel' && value.invocationId === stdinCancelId) stop(); } catch {} }
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  if (stdinCancelId) process.stdin.on('data', cancelInput);
  try { return await operation({ signal: controller.signal }); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); if (stdinCancelId) { process.stdin.removeListener('data', cancelInput); process.stdin.pause(); } }
}

const EXECUTION_SCRIPT = fileURLToPath(import.meta.url);
const DOCUMENT_BYTES = 32 * 1024 * 1024;
// Supported installed Node/Git/Lean tools fit this finite executable bound.
const TOOL_BYTES = 256 * 1024 * 1024;
// Same qualified Apple dispatcher identity as the existing respec executable reader.
const SYSTEM_GIT = { file:'/usr/bin/git',sha256:'b8763cf250e607a778bb4603cecb5b90338814d0a3dfcba0d57b1de242f610e9',size:118640,links:78,mode:0o100755 };
function fileHash(file, limit = TOOL_BYTES, links = 1) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || fs.realpathSync(file) !== file) reject('canonical owned file required');
  const before = fs.lstatSync(file);
  const systemGit=file===SYSTEM_GIT.file&&before.uid===0&&before.gid===0&&before.mode===SYSTEM_GIT.mode&&before.size===SYSTEM_GIT.size&&before.nlink>=1&&before.nlink<=SYSTEM_GIT.links;
  if (!before.isFile() || (before.nlink !== links&&!systemGit) || before.size > limit) reject('regular non-aliased bounded owned file required');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), h = crypto.createHash('sha256'), chunk = Buffer.alloc(1024 * 1024);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev) reject('owned file changed before read');
    let total = 0, n;
    while ((n = fs.readSync(fd, chunk, 0, chunk.length, null))) { total += n; if (total > limit) reject('owned file grew beyond bound'); h.update(chunk.subarray(0, n)); }
    const after = fs.fstatSync(fd), current = fs.lstatSync(file);
    for (const key of ['dev','ino','size','mtimeMs','ctimeMs','nlink']) if (after[key] !== before[key] || current[key] !== before[key]) reject('owned file changed during read');
    if (total !== before.size) reject('incomplete owned file read');
    const digest=h.digest('hex');if(systemGit&&digest!==SYSTEM_GIT.sha256)reject('system Git dispatcher identity differs');return digest;
  } finally { fs.closeSync(fd); }
}
export const executionToolIdentity = file => ({file,sha256:fileHash(file)});
// System observation of the known checking PGID, never a source of destructive signals.
export function executionScopeTool() {
  const file=fs.realpathSync('/bin/ps'),s=fs.lstatSync(file);
  if(!['darwin','linux'].includes(process.platform)||s.uid!==0||!(s.mode&0o111)||(s.mode&0o022))throw new ExecutionError('execution-uncertain','unsupported checking-group observer');
  return executionToolIdentity(file);
}
function numericGroups(stdout) {
  if(typeof stdout!=='string'||Buffer.byteLength(stdout)>1024*1024)reject('bounded numeric group inventory required');
  const rows=[],seen=new Set();
  for(const line of stdout.split('\n')){
    if(!line.trim())continue;const match=/^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if(!match)reject('incomplete numeric group inventory');const pid=Number(match[1]),pgid=Number(match[2]);
    if(!Number.isSafeInteger(pid)||!Number.isSafeInteger(pgid)||seen.has(pid)||rows.length>=65536)reject('ambiguous numeric group inventory');
    seen.add(pid);rows.push({pid,pgid});
  }
  return rows;
}
function checkingObservationValid(o) {
  closed(o,['schema','schemaVersion','rootPid','observerPid','tool','toolAfterSha256','argv','env','cwd','exitCode','signal','error','stdout','stderr','observedAtMs','status','members'],'checking-group observation');
  closed(o.tool,['file','sha256'],'scope observer tool');
  if(o.schema!=='fvs/checking-group-observation'||o.schemaVersion!==1||!Number.isSafeInteger(o.rootPid)||o.rootPid<=1||!Number.isSafeInteger(o.observerPid)||o.observerPid<=1
    ||!path.isAbsolute(o.tool.file)||!/^[0-9a-f]{64}$/.test(o.tool.sha256)||o.toolAfterSha256!==o.tool.sha256||canonical(o.argv)!==canonical([o.tool.file,'-axo','pid=,pgid='])
    ||canonical(o.env)!==canonical({PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'})||o.cwd!=='/'||o.exitCode!==0||o.signal!==null||o.error!==null||o.stderr!==''||!Number.isSafeInteger(o.observedAtMs))return false;
  const rows=numericGroups(o.stdout),self=rows.find(r=>r.pid===o.rootPid),members=rows.filter(r=>r.pgid===o.rootPid).map(r=>r.pid).sort((a,b)=>a-b);
  return self?.pgid===o.rootPid&&canonical(o.members)===canonical(members)&&canonical(members)===canonical([o.rootPid])&&o.status==='quiescent';
}
function observeCheckingGroup() {
  let tool,p,after;const env={PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'};
  try{
    tool=executionScopeTool();const argv=[tool.file,'-axo','pid=,pgid='];
    p=spawnSync(argv[0],argv.slice(1),{cwd:'/',env,encoding:'utf8',detached:true,timeout:1000,maxBuffer:1024*1024});after=executionScopeTool();
    const value={schema:'fvs/checking-group-observation',schemaVersion:1,rootPid:process.pid,observerPid:p.pid??null,tool,toolAfterSha256:after.sha256,argv,env,cwd:'/',exitCode:p.status,signal:p.signal,error:p.error?.code??null,stdout:p.stdout??'',stderr:p.stderr??'',observedAtMs:Date.now(),status:'unknown',members:[]};
    if(p.status!==0||p.signal||p.error||value.stderr||after.sha256!==tool.sha256)return value;
    const rows=numericGroups(value.stdout),self=rows.find(r=>r.pid===process.pid);value.members=rows.filter(r=>r.pgid===process.pid).map(r=>r.pid).sort((a,b)=>a-b);
    value.status=self?.pgid!==process.pid?'unsupported':value.members.length===1&&value.members[0]===process.pid?'quiescent':'busy';return value;
  }catch(error){return{status:'unknown',reason:error.message};}
}
export function conclusiveOwnedSupervision(raw) {
  try{
    const s=executionData(raw);closed(s,['cancelled','timedOut','cleanupComplete','cleanup'],'owned supervision');
    if(s.cancelled!==false||s.timedOut!==false||s.cleanupComplete!==true)return false;
    const c=s.cleanup;closed(c,c?.kind==='recorded-checking-group-join'?['kind','result','descendantAttestation','streamsDrained','join']:['kind','result','descendantAttestation','streamsDrained'],'owned cleanup');
    if(c.descendantAttestation!==false||c.streamsDrained!==true)return false;
    if(c.kind==='recorded-owned-group-absence')return c.result==='absent';
    if(c.kind!=='recorded-checking-group-join'||c.result!=='quiescent')return false;
    closed(c.join,['before','after','attempts'],'owned checking join');
    return Number.isSafeInteger(c.join.attempts)&&c.join.attempts>0&&checkingObservationValid(c.join.before)&&checkingObservationValid(c.join.after)
      &&c.join.before.rootPid===c.join.after.rootPid&&canonical(c.join.before.tool)===canonical(c.join.after.tool);
  }catch{return false;}
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function regularData(file, links = 1) {
  const expected = fileHash(file, DOCUMENT_BYTES, links), bytes = fs.readFileSync(file);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== expected || fileHash(file, DOCUMENT_BYTES, links) !== expected) reject('owned document changed during parse');
  return executionData(JSON.parse(bytes.toString('utf8')));
}
const ownRef = file => ({ file, sha256: fileHash(file, DOCUMENT_BYTES) });
function boundOwn(ref) { closed(ref,['file','sha256'],'owned evidence reference'); if (!/^[0-9a-f]{64}$/.test(ref.sha256) || fileHash(ref.file,DOCUMENT_BYTES) !== ref.sha256) reject('owned evidence identity changed'); return regularData(ref.file); }
function boundMarker(ref) {
  closed(ref,['file','sha256'],'owned activation marker');
  const stat=fs.lstatSync(ref.file),links=stat.nlink;
  if(links===2){
    const dir=path.dirname(ref.file),prefix='.'+path.basename(ref.file)+'.start-',names=fs.readdirSync(dir).filter(name=>name.startsWith(prefix));
    if(names.length!==1||!uuidPattern.test(names[0].slice(prefix.length)))reject('unexpected activation marker alias');
    const pair=path.join(dir,names[0]),other=fs.lstatSync(pair);
    if(fs.realpathSync(pair)!==pair||!other.isFile()||other.dev!==stat.dev||other.ino!==stat.ino||other.nlink!==2)reject('activation pair identity differs');
  }else if(links!==1)reject('unexpected activation marker links');
  if(!/^[0-9a-f]{64}$/.test(ref.sha256)||fileHash(ref.file,DOCUMENT_BYTES,links)!==ref.sha256)reject('activation marker changed');
  return regularData(ref.file,links);
}
function ownedDirectory(dir) { if(fs.realpathSync(dir)!==dir || !fs.lstatSync(dir).isDirectory()) reject('canonical owned directory required'); }
function ownWrite(file, value) {
  const fd = fs.openSync(file, 'wx', 0o400);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return ownRef(file);
}
function scopeIdentity(packet, actor) {
  return { schema: 'fvs/owned-work-scope', schemaVersion: 1, packet, actor,
    producer: { file: EXECUTION_SCRIPT, sha256: fileHash(EXECUTION_SCRIPT) }, authority: 'known FVS work only; not arbitrary AO descendants or proof authority' };
}
export function ownedWorkRoot(packet) {
  closed(packet, ['file','sha256'], 'owned packet reference');
  boundOwn(packet);
  return path.join(path.dirname(packet.file), 'owned-work-' + packet.sha256);
}
export function initializeOwnedWork(packet, actor, marker) {
  boundMarker(marker);
  const root = ownedWorkRoot(packet), identity = scopeIdentity(packet, actor);
  if (!fs.existsSync(root)) fs.mkdirSync(root, { mode: 0o700 });
  if (fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()) reject('aliased owned scope');
  if (fs.existsSync(path.join(root,'closed.json'))) throw new ExecutionError('owned-work-closed','task scope is closed to new work');
  const file = path.join(root,'scope.json');
  if (fs.existsSync(file)) { if (canonical(regularData(file)) !== canonical(identity)) reject('different producer/actor owns scope'); }
  else ownWrite(file, identity);
  const active = path.join(root,'active.json'), value = { schema:'fvs/owned-work-activation',schemaVersion:1,packet,marker,scope:ownRef(file) };
  if (fs.existsSync(active)) { if (canonical(regularData(active)) !== canonical(value)) reject('different activation owns scope'); }
  else ownWrite(active,value);
  if (!fs.existsSync(path.join(root,'jobs'))) fs.mkdirSync(path.join(root,'jobs'), { mode:0o700 });
  return { root, activation:ownRef(active) };
}
function scopeLock(root) {
  const lock=path.join(root,'issuance-lock');
  try { fs.mkdirSync(lock,{mode:0o700}); } catch { throw new ExecutionError('owned-work-busy','known scope issuance is pending; do not infer empty work'); }
  return () => fs.rmdirSync(lock);
}
export function closeOwnedWork(packet, actor) {
  const root=ownedWorkRoot(packet);
  ownedDirectory(root);
  if(canonical(regularData(path.join(root,'scope.json')))!==canonical(scopeIdentity(packet,actor))) reject('cannot close a missing/different owned task');
  const unlock=scopeLock(root);
  try {
    const file=path.join(root,'closed.json'),value={schema:'fvs/owned-work-closed',schemaVersion:1,packet,actor};
    if(fs.existsSync(file)){if(canonical(regularData(file))!==canonical(value))reject('different actor closed scope');}
    else ownWrite(file,value);
    return ownRef(file);
  } finally { unlock(); }
}
function processAbsent(pid, group=false) {
  if (!Number.isSafeInteger(pid)||pid<=1) return 'unknown';
  try { process.kill(group?-pid:pid,0);return 'present-or-reused'; } catch(error){return error.code==='ESRCH'?'absent':'unknown';}
}
export const observeOwnedWork=(packet,actor)=>inspectOwnedWork(packet,actor,false);
function inspectOwnedWork(packet, actor, ownIssuanceLock) {
  const root=ownedWorkRoot(packet), details=[];
  const output={scope:'known FVS-owned operations only; no hostwide/arbitrary descendant claim',root,status:'uncertain',closed:false,jobs:details,proofAuthority:'none'};
  try {
    ownedDirectory(root);
    const init=regularData(path.join(root,'scope.json'));output.scopeEvidence=ownRef(path.join(root,'scope.json'));
    if(canonical(init)!==canonical(scopeIdentity(packet,actor)))reject('owned scope producer/actor changed');
    const active=regularData(path.join(root,'active.json'));
    closed(active,['schema','schemaVersion','packet','marker','scope'],'owned activation');
    if(active.schema!=='fvs/owned-work-activation'||active.schemaVersion!==1||canonical(active.packet)!==canonical(packet)||canonical(active.scope)!==canonical(ownRef(path.join(root,'scope.json'))))reject('owned activation changed');
    boundMarker(active.marker);output.activation=ownRef(path.join(root,'active.json'));
    if(fs.existsSync(path.join(root,'closed.json'))){const c=regularData(path.join(root,'closed.json'));closed(c,['schema','schemaVersion','packet','actor'],'owned closure');if(c.schema!=='fvs/owned-work-closed'||c.schemaVersion!==1||canonical(c.packet)!==canonical(packet)||canonical(c.actor)!==canonical(actor))reject('scope closure actor changed');output.closed=true;output.closure=ownRef(path.join(root,'closed.json'));}
    if(!ownIssuanceLock&&fs.existsSync(path.join(root,'issuance-lock')))throw new ExecutionError('owned-work-busy','unresolved issuance, not empty scope');
    const jobs=path.join(root,'jobs');ownedDirectory(jobs);const names=fs.readdirSync(jobs).sort();
    if(names.length>10000)reject('owned job inventory exceeds bound');
    for(const name of names){
      if(!uuidPattern.test(name))reject('unknown owned-work entry');const dir=path.join(jobs,name);ownedDirectory(dir);
      const intentRef=ownRef(path.join(dir,'intent.json')),intent=boundOwn(intentRef);
      closed(intent,['schema','schemaVersion','invocationId','packet','actor','request','execution','parentPid','producer'],'owned intent');
      if(intent.schema!=='fvs/owned-command-intent'||intent.schemaVersion!==1||intent.invocationId!==name||canonical(intent.actor)!==canonical(actor)||canonical(intent.packet)!==canonical(packet)||canonical(intent.producer)!==canonical(init.producer)||!Number.isSafeInteger(intent.parentPid)||intent.parentPid<=1)reject('job lost issued context');
      parseExecution(intent.execution);
      const request=boundOwn(intent.request);
      closed(request,['schema','schemaVersion','packet','marker','invocationId','tool','argv','cwd','env'],'issued owned request');
      if(request.schema!=='fvs/owned-command-request'||request.schemaVersion!==1||request.invocationId!==name||canonical(request.packet)!==canonical(packet)||canonical(request.marker)!==canonical(active.marker))reject('job request lost activation');
      const entries=fs.readdirSync(dir).sort(),allowed=['intent.json','request.json','start.json','stdout','stderr','terminal.json'];
      if(entries.some(n=>!allowed.includes(n)))reject('unclassified owned job artifact');
      const startFile=path.join(dir,'start.json'),terminalFile=path.join(dir,'terminal.json');let quiescent=false,reason;
      if(fs.existsSync(startFile)){
        const start=regularData(startFile);closed(start,['schema','schemaVersion','intent','pid','observedAtMs'],'owned start');
        if(start.schema!=='fvs/owned-command-start'||start.schemaVersion!==1||canonical(start.intent)!==canonical(intentRef)||!Number.isSafeInteger(start.pid)||start.pid<=1||!Number.isSafeInteger(start.observedAtMs)||start.observedAtMs<0)reject('foreign/missing actual start identity');
        if(fs.existsSync(terminalFile)){
          const terminal=regularData(terminalFile);closed(terminal,['schema','schemaVersion','intent','result','stdout','stderr'],'owned terminal');
          if(terminal.schema!=='fvs/owned-command-terminal'||terminal.schemaVersion!==1||canonical(terminal.intent)!==canonical(intentRef))reject('job terminal is not this intent');
          const result=terminal.result;closed(result,['toolUnchanged','pid','status','signal','error','cancelled','timedOut','outputLimitExceeded','cleanupComplete','cleanup'],'native owned result');
          closed(result.cleanup,['kind','result','descendantAttestation','streamsDrained'],'owned cleanup');
          if(result.pid!==start.pid||!(result.status===null||Number.isInteger(result.status))||!(result.signal===null||typeof result.signal==='string')||!(result.error===null||typeof result.error==='string')||['toolUnchanged','cancelled','timedOut','outputLimitExceeded','cleanupComplete'].some(k=>typeof result[k]!=='boolean')||result.cleanup.kind!=='recorded-owned-group-absence'||result.cleanup.descendantAttestation!==false||!['absent','present','unknown','unsupported'].includes(result.cleanup.result)||typeof result.cleanup.streamsDrained!=='boolean'||result.cleanupComplete!==(result.cleanup.result==='absent'&&result.cleanup.streamsDrained))reject('unsupported/incomplete native cleanup');
          for(const key of ['stdout','stderr']){const ref=terminal[key];closed(ref,['file','sha256'],'owned output');if(ref.file!==path.join(dir,key)||fileHash(ref.file,DOCUMENT_BYTES)!==ref.sha256)reject('owned output missing/changed');}
          quiescent=result.cleanupComplete&&processAbsent(start.pid,true)==='absent';reason=quiescent?'actual terminal wait and fresh known group absence; no proof verdict':'terminal or current group absence unverified';
        } else {
          const parent=processAbsent(intent.parentPid),group=processAbsent(start.pid,true);
          quiescent=parent==='absent'&&group==='absent';reason=quiescent?'known producer and group absent; inner outcome remains unknown':'known work alive, reused or unsupported';
        }
      } else reason='no actual start identity; cannot infer no execution';
      details.push({invocationId:name,intent:intentRef,...(fs.existsSync(startFile)?{start:ownRef(startFile)}:{}),...(fs.existsSync(terminalFile)?{terminal:ownRef(terminalFile)}:{}),quiescent,reason});
    }
    if(canonical(names)!==canonical(fs.readdirSync(jobs).sort())||(!ownIssuanceLock&&fs.existsSync(path.join(root,'issuance-lock'))))reject('job inventory changed during observation');
    output.status=details.every(r=>r.quiescent)?'quiescent':'uncertain';return output;
  } catch(error){return{...output,reason:error.message};}
}

// One invocation under the existing task. This is not a daemon, scheduler or job queue.
export async function runTaskCommand(raw, services={}) {
  const request=executionData(raw);
  closed(request,['schema','schemaVersion','packet','marker','invocationId','tool','argv','cwd','env'],'owned command request');
  if(request.schema!=='fvs/owned-command-request'||request.schemaVersion!==1||!uuidPattern.test(request.invocationId))reject('invalid owned command identity');
  const existing=path.join(ownedWorkRoot(request.packet),'jobs',request.invocationId);
  if(fs.existsSync(existing))throw new ExecutionError('owned-work-replayed','single-use owned invocation already exists');
  const lease=await (services.loadLease??(async input=>{const{verifyActiveTask}=await import('./fvs-auto.mjs');return verifyActiveTask(input);}))(request);
  const { packet, actor, control, toolPins }=lease;
  if(canonical(packet)!==canonical(request.packet)||!Array.isArray(request.argv)||!request.argv.length||!request.argv.every(v=>typeof v==='string')||request.argv[0]!==request.tool.file)reject('owned argv/context differs');
  closed(request.tool,['file','sha256'],'pinned command tool');
  if(!/^[0-9a-f]{64}$/.test(request.tool.sha256))reject('pinned tool digest required');
  if(fs.realpathSync(request.tool.file)!==request.tool.file||fileHash(request.tool.file)!==request.tool.sha256||!toolPins.some(t=>t.file===request.tool.file&&t.sha256===request.tool.sha256))reject('command is not a pinned task tool');
  const relative=path.relative(actor.worktree.path,request.cwd);
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||fs.realpathSync(request.cwd)!==request.cwd)reject('owned cwd escapes assigned worktree');
  const allowed=['PATH','LANG','LC_ALL','HOME','TMPDIR','CARGO_HOME','RUSTUP_HOME','ELAN_HOME','LEAN_PATH','LEAN_NUM_THREADS','GIT_CONFIG_GLOBAL','GIT_CONFIG_NOSYSTEM','GIT_TERMINAL_PROMPT','GIT_NO_LAZY_FETCH','GIT_NO_REPLACE_OBJECTS','GIT_OPTIONAL_LOCKS','DISABLE_TELEMETRY','DO_NOT_TRACK'];
  if(!request.env||Object.keys(request.env).some(k=>!allowed.includes(k))||Object.values(request.env).some(v=>typeof v!=='string'))reject('credential-free command environment required');
  if(Object.hasOwn(request.env,'LEAN_NUM_THREADS')&&request.env.LEAN_NUM_THREADS!=='2')reject("LEAN_NUM_THREADS must be the literal '2'");
  assertRunning(control,services);const root=ownedWorkRoot(packet),unlock=scopeLock(root);let released=false,dir,intent;
  const release=()=>{if(!released){unlock();released=true;}};
  try {
    if(fs.existsSync(path.join(root,'closed.json')))throw new ExecutionError('owned-work-closed','task closed before command issuance');
    const active=regularData(path.join(root,'active.json'));if(canonical(active.marker)!==canonical(request.marker))reject('owned request marker differs');boundMarker(request.marker);
    const initialized=regularData(path.join(root,'scope.json'));if(canonical(initialized)!==canonical(scopeIdentity(packet,actor)))reject('owned scope changed');
    const previous=inspectOwnedWork(packet,actor,true);if(previous.status!=='quiescent')throw new ExecutionError('owned-work-uncertain','earlier known work is active/uncertain; no overlapping command');
    lease.fence?.();assertRunning(control,services);
    dir=path.join(root,'jobs',request.invocationId);fs.mkdirSync(dir,{mode:0o700});
    const input=ownWrite(path.join(dir,'request.json'),request);intent=ownWrite(path.join(dir,'intent.json'),{schema:'fvs/owned-command-intent',schemaVersion:1,invocationId:request.invocationId,packet,actor,request:input,execution:control,parentPid:process.pid,producer:initialized.producer});
    const result=await runOwned(request.argv,{cwd:request.cwd,env:{...request.env,FVS_OWNED_EXECUTION_SCOPE:'owned-work-v2'},maxBuffer:32*1024*1024},control,{...services,inheritGroup:false,onSpawn(child){ownWrite(path.join(dir,'start.json'),{schema:'fvs/owned-command-start',schemaVersion:1,intent,pid:child.pid,observedAtMs:Date.now()});release();services.onSpawn?.(child);}});
    if(result.cancelled||result.timedOut)closeOwnedWork(packet,actor);
    const stdout=path.join(dir,'stdout'),stderr=path.join(dir,'stderr');fs.writeFileSync(stdout,result.stdout,{flag:'wx'});fs.writeFileSync(stderr,result.stderr,{flag:'wx'});
    const toolUnchanged=fileHash(request.tool.file)===request.tool.sha256;
    const native={toolUnchanged,pid:result.pid,status:result.status,signal:result.signal,error:result.error?.code??null,cancelled:result.cancelled,timedOut:result.timedOut,outputLimitExceeded:result.outputLimitExceeded,cleanupComplete:result.cleanupComplete,cleanup:result.cleanup};
    const terminal=ownWrite(path.join(dir,'terminal.json'),{schema:'fvs/owned-command-terminal',schemaVersion:1,intent,result:native,stdout:ownRef(stdout),stderr:ownRef(stderr)});
    const ok=toolUnchanged&&result.status===0&&!result.signal&&!result.error&&!result.cancelled&&!result.timedOut&&!result.outputLimitExceeded&&result.cleanupComplete;
    return{status:ok?'command-completed':'execution-unverified',...(ok?{}:{code:result.cancelled?'cancelled':result.timedOut?'timeout':!toolUnchanged?'tool-drift':'owned-work-unverified'}),terminal,stdout:ownRef(stdout),stderr:ownRef(stderr),authority:'execution facts only; no proof/dispatch authority'};
  } finally { release(); }
}
