// Execution control is scheduling metadata, never proof authority.
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
export function runOwned(argv, options, control, { signal, spawnProcess = spawn, now = Date.now, probeGroup = pid => {
  try { process.kill(-pid, 0); return 'present'; } catch (error) { return error.code === 'ESRCH' ? 'absent' : 'unknown'; }
} } = {}) {
  assertRunning(control, { signal, now });
  if (!Array.isArray(argv) || !argv.length || !path.isAbsolute(argv[0])) reject('absolute owned executable required');
  if (!options || !path.isAbsolute(options.cwd ?? '') || !options.env || Object.keys(options).some(key => !['cwd', 'env', 'maxBuffer', 'encoding'].includes(key))) reject('explicit owned cwd/environment and no hidden process timeout required');
  if (Object.values(options.env).some(value => typeof value !== 'string')) reject('string-only explicit child environment required');
  if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean')) reject('AbortSignal service required');
  const deadline = controlDeadline(control);
  const maxBuffer = options.maxBuffer ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 1) reject('bounded child output required');
  return new Promise((resolve, rejectPromise) => {
    let child, timer, size = 0, cancelled = false, timedOut = false, overflow = false, error;
    const stdout = [], stderr = [];
    const stop = () => {
      if (!child || child.exitCode !== null || child.signalCode !== null || !(child.pid > 1)) return;
      try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); }
      catch (failure) { if (failure.code !== 'ESRCH') error ??= failure; }
    };
    const cancel = () => { cancelled = true; stop(); };
    try {
      child = spawnProcess(argv[0], argv.slice(1), { ...options, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      child.on('error', failure => { error = failure; });
      child.on('close', async (status, childSignal) => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        let ownership = child.pid > 1 && process.platform !== 'win32' ? probeGroup(child.pid) : 'unsupported';
        // Bounded absence confirmation after exit is administrative cleanup, not a proof timer.
        const cleanupUntil = performance.now() + 1000;
        while (ownership === 'present' && performance.now() < cleanupUntil) {
          await new Promise(done => setTimeout(done, 10)); ownership = probeGroup(child.pid);
        }
        resolve({ pid: child.pid ?? null, status, signal: childSignal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr),
          error, cancelled, timedOut, outputLimitExceeded: overflow, cleanupComplete: ownership === 'absent',
          cleanup: { kind: 'recorded-owned-group-absence', result: ownership, descendantAttestation: false } });
      });

      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      if (deadline !== null) timer = setTimeout(() => { timedOut = true; stop(); }, Math.min(2147483647, Math.max(1, deadline - now())));
      const collect = list => bytes => {
        size += bytes.length;
        if (size > maxBuffer) { overflow = true; stop(); } else list.push(Buffer.from(bytes));
      };
      child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    } catch (failure) {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (child) { error = failure; stop(); } else rejectPromise(failure);
    }
  });
}
