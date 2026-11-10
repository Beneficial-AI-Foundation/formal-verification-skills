// Project memory is context, never task/receipt authority. No backend programs run on import.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { types } from 'node:util';

export const MEMORY_KEY = 'fvs-auto-project-context';
export const MEMORY_LIMITS = Object.freeze({ timeoutMs: 10000, maxBytes: 1024 * 1024 });
export const memoryJson = (v) => JSON.stringify(memoryDataSnapshot(v));
export const memoryHash = (v) => hash(memoryJson(v));
const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const text = (v) => typeof v === 'string' && v.trim() !== '';
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const SHA = /^[0-9a-f]{64}$/;
const shaString = (v) => typeof v === 'string' && SHA.test(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BINDING_KEYS = ['schema', 'schemaVersion', 'backend', 'bindingRevision', 'canonicalRoot', 'gitCommonDir', 'storeDir',
  'databasePath', 'databaseName', 'backendProjectId', 'contextKey', 'bdPath', 'bdVersion', 'bdSha256', 'recordedAt'];

export class MemoryError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
const stop = (code, message, details) => { throw new MemoryError(code, message, details); };
// Descriptor-only validation: no reads through user accessors, hooks, coercion or proxy traps.
export function memoryOwnData(v, label = 'JSON object') {
  if (types.isProxy(v) || !object(v)) stop('invalid-input', label + ' must be a plain own-data object');
  const descriptors = Object.getOwnPropertyDescriptors(v), result = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    const d = descriptors[key];
    if (typeof key !== 'string' || !d.enumerable || !Object.prototype.hasOwnProperty.call(d, 'value')) stop('invalid-input', label + ' contains hidden/symbol/accessor properties');
    result[key] = d.value;
  }
  return result;
}
export function memoryDataSnapshot(v, seen = new Set()) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'object' || types.isProxy(v) || seen.has(v)) stop('invalid-input', 'only acyclic finite plain JSON data is supported');
  seen.add(v);
  let result;
  if (Array.isArray(v)) {
    if (![Array.prototype, null].includes(Object.getPrototypeOf(v))) stop('invalid-input', 'custom array prototypes are not JSON data');
    const ds = Object.getOwnPropertyDescriptors(v), keys = Reflect.ownKeys(ds), length = ds.length.value;
    if (keys.length !== length + 1) stop('invalid-input', 'sparse or extended arrays are not supported JSON data');
    result = []; Object.setPrototypeOf(result, null);
    for (let i = 0; i < length; i++) {
      const d = ds[String(i)];
      if (!d || !d.enumerable || !Object.prototype.hasOwnProperty.call(d, 'value')) stop('invalid-input', 'array accessors/hidden entries are not JSON data');
      result[i] = memoryDataSnapshot(d.value, seen);
    }
  } else {
    const data = memoryOwnData(v);
    result = Object.create(null);
    for (const key of Object.keys(data).sort()) result[key] = memoryDataSnapshot(data[key], seen);
  }
  seen.delete(v); return result;
}
function closed(v, keys, label, code = 'invalid-input') {
  try {
    const data = memoryDataSnapshot(v);
    if (!object(data) || Object.keys(data).some((k) => !keys.includes(k)) || keys.some((k) => !Object.prototype.hasOwnProperty.call(data, k))) throw new Error('field set');
  } catch { stop(code, label + ' must contain only the explicit JSON data fields: ' + keys.join(', ')); }
}
function absolute(v) { return text(v) && path.isAbsolute(v) && path.normalize(v) === v; }
function inside(root, file) { const r = path.relative(root, file); return !r || (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r)); }
function realDirectory(file, code = 'memory-store-missing') {
  try {
    if (!fs.lstatSync(file).isDirectory() || fs.realpathSync(file) !== file) throw new Error('not a direct canonical directory');
    return file;
  } catch (e) { stop(code, 'required directory unavailable: ' + file + ': ' + e.message, { nextStep: 'Provide/register the existing canonical primary store/database, or perform separately authorized setup before rerunning; this adapter never initializes a missing store.' }); }
}
function readBytes(file, root = null) {
  if (root && !inside(root, path.resolve(file))) stop('memory-evidence-invalid', 'evidence path escapes its owned output');
  try {
    if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file) throw new Error('not a regular canonical file');
    return fs.readFileSync(file);
  } catch (e) { stop('memory-evidence-invalid', 'required regular file unavailable: ' + file + ': ' + e.message); }
}
function decode(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { stop('memory-output-invalid', 'backend output is not complete UTF-8'); }
}
function jsonBytes(bytes) {
  try { return JSON.parse(decode(bytes)); }
  catch (e) { if (e instanceof MemoryError) throw e; stop('memory-output-invalid', 'invalid backend JSON: ' + e.message); }
}
function writeJson(file, v) { fs.writeFileSync(file, JSON.stringify(v, null, 2) + '\n', { flag: 'wx' }); }

export function memoryBindingsErrors(records) {
  if (records === undefined) return [];
  try { records = memoryDataSnapshot(records); } catch (e) { return [e.message]; }
  if (!Array.isArray(records)) return ['memoryBindings must be an array'];
  const errors = []; let previous = -1;
  for (let index = 0; index < records.length; index++) {
    const b = records[index];
    try {
      closed(b, BINDING_KEYS, 'memory binding');
      if (b.schema !== 'fvs/auto-memory-binding' || b.schemaVersion !== 1 || b.backend !== 'beads'
        || b.contextKey !== MEMORY_KEY || !integer(b.bindingRevision) || b.bindingRevision <= previous
        || !['canonicalRoot', 'gitCommonDir', 'storeDir', 'databasePath', 'bdPath'].every((k) => absolute(b[k]))
        || !text(b.databaseName) || path.basename(b.databaseName) !== b.databaseName || ['.', '..'].includes(b.databaseName)
        || !text(b.backendProjectId) || !text(b.bdVersion) || !shaString(b.bdSha256) || !text(b.recordedAt)) stop('invalid-input', 'invalid closed/versioned memory binding');
      previous = b.bindingRevision;
    } catch (e) { errors.push(e.message); }
  }
  return errors;
}
export function bindingIdentity(b) { b = memoryDataSnapshot(b); return Object.fromEntries(BINDING_KEYS.filter((k) => !['bindingRevision', 'recordedAt'].includes(k)).map((k) => [k, b[k]])); }

function ownOutput(root, requested, registration = false, parent = os.tmpdir()) {
  let out;
  if (registration) out = fs.mkdtempSync(path.join(fs.realpathSync(parent), 'fvs-memory-' + (registration === true ? 'registration' : registration) + '-'));
  else {
    const parent = fs.realpathSync(path.dirname(path.resolve(requested)));
    out = path.join(parent, path.basename(requested));
    if (inside(path.join(root, '.beads'), out)) stop('invalid-input', 'bootstrap output must not be inside the memory store');
    try { fs.mkdirSync(out); } catch (e) { stop('memory-output-exists', 'exclusive bootstrap output unavailable: ' + e.message); }
  }
  for (const dir of ['home', 'tmp', 'xdg-cache', 'xdg-config', 'xdg-data', 'receipts', 'streams']) fs.mkdirSync(path.join(out, dir));
  return out;
}
function environment(out) {
  return { PATH: '/usr/bin:/bin', HOME: path.join(out, 'home'), TMPDIR: path.join(out, 'tmp'),
    XDG_CACHE_HOME: path.join(out, 'xdg-cache'), XDG_CONFIG_HOME: path.join(out, 'xdg-config'), XDG_DATA_HOME: path.join(out, 'xdg-data'),
    LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1',
    DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1' };
}
function runner(out, request = null, requestInputSha256 = null) {
  const receipts = []; const requestSha256 = request ? memoryHash(request) : null;
  function run(tool, args, cwd, expectedToolSha = null) {
    const toolBefore = hash(readBytes(tool));
    if (expectedToolSha && expectedToolSha !== toolBefore) stop('memory-tool-changed', 'registered backend tool bytes changed');
    const startedAt = Date.now();
    const p = spawnSync(tool, args, { cwd, env: environment(out), timeout: MEMORY_LIMITS.timeoutMs, maxBuffer: MEMORY_LIMITS.maxBytes, encoding: null });
    const processEndedAt = Date.now();
    const n = String(receipts.length + 1).padStart(4, '0');
    const stdout = p.stdout ?? Buffer.alloc(0), stderr = p.stderr ?? Buffer.alloc(0);
    fs.writeFileSync(path.join(out, 'streams', n + '.stdout'), stdout, { flag: 'wx' });
    fs.writeFileSync(path.join(out, 'streams', n + '.stderr'), stderr, { flag: 'wx' });
    const toolAfter = hash(readBytes(tool));
    const stream = (suffix, bytes) => ({ file: 'streams/' + n + '.' + suffix, sha256: hash(bytes), bytes: bytes.length });
    const receipt = { requestSha256, attemptId: request?.attemptId ?? null, requestInputSha256, argv: [tool, ...args], cwd,
      env: environment(out), toolBefore, toolAfter, startedAt, processEndedAt, exitCode: p.status, signal: p.signal,
      error: p.error ? { code: p.error.code, message: p.error.message } : null, stdout: stream('stdout', stdout), stderr: stream('stderr', stderr) };
    const file = 'receipts/' + n + '.json'; writeJson(path.join(out, file), receipt);
    receipts.push({ file, sha256: hash(readBytes(path.join(out, file))) });
    if (toolAfter !== toolBefore) stop('memory-tool-changed', 'backend/tool bytes changed during invocation');
    if (p.error || p.status !== 0 || stdout.length > MEMORY_LIMITS.maxBytes || stderr.length > MEMORY_LIMITS.maxBytes) {
      stop('memory-command-failed', 'bounded local memory command did not complete successfully', { command: receipt.argv, exitCode: p.status, error: receipt.error });
    }
    return stdout;
  }
  return { run, receipts, out };
}
function gitIdentity(root, r) {
  const git = (...args) => decode(r.run('/usr/bin/git', ['-C', root, 'rev-parse', ...args], root)).trim();
  if (git('--is-bare-repository') !== 'false') stop('memory-project-mismatch', 'a non-bare working checkout is required');
  return { gitDir: fs.realpathSync(path.resolve(root, git('--git-dir'))), gitCommonDir: fs.realpathSync(path.resolve(root, git('--git-common-dir'))) };
}
function checkGitBinding(b, r, callerRoot) {
  let primary, caller;
  try {
    primary = gitIdentity(b.canonicalRoot, r);
    caller = gitIdentity(fs.realpathSync(callerRoot), r);
  } catch (e) {
    stop('memory-project-mismatch', 'actual primary/caller Git identity unavailable: ' + e.message,
      { gitEvidence: { out: r.out, receipts: r.receipts } });
  }
  if (primary.gitDir !== primary.gitCommonDir) stop(b.gitCommonDir ? 'memory-project-mismatch' : 'memory-not-primary', 'the canonical root is no longer a primary Git checkout');
  if ((b.gitCommonDir && primary.gitCommonDir !== b.gitCommonDir) || caller.gitCommonDir !== primary.gitCommonDir) {
    stop('memory-project-mismatch', 'actual primary/common/caller Git relationship changed', { gitEvidence: { out: r.out, receipts: r.receipts } });
  }
  return { primary, caller, callerRoot: fs.realpathSync(callerRoot) };
}

function metadata(b) {
  realDirectory(b.canonicalRoot, 'memory-project-mismatch');
  if (b.storeDir !== path.join(b.canonicalRoot, '.beads')) stop('memory-store-mismatch', 'store must be the registered primary control root .beads');
  realDirectory(b.storeDir);
  const metadataFile = path.join(b.storeDir, 'metadata.json');
  if (!fs.existsSync(metadataFile)) stop('memory-store-missing', 'existing store metadata is missing: ' + metadataFile);
  const m = jsonBytes(readBytes(metadataFile));
  if (m.backend !== 'dolt' || m.database !== 'dolt' || m.dolt_mode !== 'embedded' || !text(m.project_id) || !text(m.dolt_database)
    || path.basename(m.dolt_database) !== m.dolt_database || ['.', '..'].includes(m.dolt_database)) stop('memory-backend-unsupported', 'only existing embedded/direct Beads metadata with project_id is supported');
  if (b.databaseName && b.databaseName !== m.dolt_database) stop('memory-store-mismatch', 'registered logical database selector changed');
  if (b.backendProjectId && b.backendProjectId !== m.project_id) stop('memory-store-mismatch', 'backend project identity changed');
  if (b.databasePath) {
    realDirectory(b.databasePath);
    if (!inside(b.storeDir, b.databasePath) || b.databasePath === b.storeDir) stop('memory-store-mismatch', 'database must be inside the registered store');
    const logicalName = b.databaseName ?? m.dolt_database;
    realDirectory(path.join(b.databasePath, logicalName));
    realDirectory(path.join(b.databasePath, logicalName, '.dolt'));
  }
  return m;
}
function prefix(b, readonly = true) { return ['-C', b.canonicalRoot, ...(b.databasePath ? ['--db', b.databasePath] : []), '--sandbox', ...(readonly ? ['--readonly'] : [])]; }
function inspect(b, r, callerRoot = b.canonicalRoot) {
  if (b.bdVersion && b.bdVersion !== '1.3.1') stop('memory-backend-unsupported', 'registered backend profile is unsupported');
  const m = metadata(b); const relationship = checkGitBinding(b, r, callerRoot);
  const primary = relationship.primary;
  const expected = b.bdSha256 ?? null;
  const versionText = decode(r.run(b.bdPath, [...prefix(b), '--version'], b.canonicalRoot, expected)).trim();
  if (!/^bd version 1\.3\.1(?:[ \t].*)?$/.test(versionText)) stop('memory-backend-unsupported', 'only inspected Beads1.3.1 is qualified by this adapter profile');
  const where = jsonBytes(r.run(b.bdPath, [...prefix(b), 'where', '--json'], b.canonicalRoot, expected));
  if (where.schema_version !== 1 || where.path !== b.storeDir || !absolute(where.database_path)) stop('memory-store-mismatch', 'actual backend store location differs from registration');
  realDirectory(where.database_path);
  if (!inside(b.storeDir, where.database_path) || where.database_path === b.storeDir || (b.databasePath && b.databasePath !== where.database_path)) stop('memory-store-mismatch', 'actual database differs from the registered in-store database');
  const actual = { ...b, databasePath: where.database_path, databaseName: m.dolt_database, backendProjectId: m.project_id };
  metadata(actual); // Pin both the container and its existing logical database before querying it.
  const info = jsonBytes(r.run(b.bdPath, [...prefix(actual), 'info', '--json'], b.canonicalRoot, expected));
  if (info.schema_version !== 1 || info.mode !== 'direct' || info.database_path !== actual.databasePath) stop('memory-backend-unsupported', 'backend is not the registered direct embedded profile');
  metadata(actual);
  checkGitBinding({ ...actual, gitCommonDir: primary.gitCommonDir }, r, callerRoot);
  return { ...actual, gitCommonDir: primary.gitCommonDir, backendProjectId: m.project_id, bdVersion: '1.3.1', bdSha256: hash(readBytes(b.bdPath)) };
}

export function inspectMemoryRegistration(options) {
  const { projectRoot, registration } = memoryDataSnapshot(options);
  closed(registration, ['backend', 'canonicalRoot', 'storeDir', 'databasePath', 'bdPath'], 'memory registration');
  if (registration.backend !== 'beads' || registration.canonicalRoot !== projectRoot || !['canonicalRoot', 'storeDir', 'databasePath', 'bdPath'].every((k) => absolute(registration[k]))) stop('invalid-input', 'registration requires explicit existing canonical project/store/database/tool paths and backend beads');
  try {
    if (!fs.lstatSync(registration.bdPath).isFile() || fs.realpathSync(registration.bdPath) !== registration.bdPath || !(fs.statSync(registration.bdPath).mode & 0o111)) throw new Error('not an existing canonical executable');
  } catch (e) { stop('memory-tool-unavailable', 'backend executable unavailable: ' + registration.bdPath + ': ' + e.message); }
  metadata(registration); // Missing/foreign store is refused before invoking bd or creating a store.
  const out = ownOutput(projectRoot, null, true), r = runner(out);
  try {
    const actual = inspect(registration, r);
    return { binding: { schema: 'fvs/auto-memory-binding', schemaVersion: 1, backend: 'beads', canonicalRoot: projectRoot,
      gitCommonDir: actual.gitCommonDir, storeDir: actual.storeDir, databasePath: actual.databasePath, databaseName: actual.databaseName, backendProjectId: actual.backendProjectId,
      contextKey: MEMORY_KEY, bdPath: actual.bdPath, bdVersion: actual.bdVersion, bdSha256: actual.bdSha256 }, out, receipts: r.receipts };
  } catch (e) { writeJson(path.join(out, 'failure.json'), { code: e.code ?? 'memory-unverified', message: e.message, receipts: r.receipts }); throw e; }
}

function current(loadCanonical) {
  const c = loadCanonical(); const b = c.view.state.memoryBindings?.at(-1);
  if (!b) stop('memory-registration-required', 'register the existing canonical project memory store; no automatic store initialization');
  const bindingSha256 = memoryHash(b);
  const context = { schema: 'fvs/project-memory-context', schemaVersion: 1, authority: 'context-only',
    project: { canonicalRoot: b.canonicalRoot, gitCommonDir: b.gitCommonDir, backendProjectId: b.backendProjectId },
    binding: { bindingRevision: b.bindingRevision, bindingSha256 }, agreement: c.envelope,
    agreementContextSha256: c.view.agreement.contextSha256,
    canonical: { state: path.join(b.canonicalRoot, '.formalising/auto-fv/state.json'), roadmap: path.join(b.canonicalRoot, '.formalising/auto-fv/ROADMAP.md'), goalSection: 'Goal' },
    continuation: { state: path.join(b.canonicalRoot, '.formalising/auto-fv/state.json'), nextAction: c.view.nextAction } };
  const expected = { bindingRevision: b.bindingRevision, bindingSha256, choicesGeneration: c.view.state.choicesGeneration,
    agreementContextSha256: c.view.agreement.contextSha256, memoryContextSha256: memoryHash(context) };
  return { binding: b, context, expected };
}
function validateRequest(q, operation) {
  closed(q, ['schema', 'schemaVersion', 'attemptId', 'operation', 'phase', 'target', 'expected'], 'bootstrap request');
  closed(q.target, ['projectId', 'sessionId', 'resumeId'], 'bootstrap target');
  closed(q.expected, ['bindingRevision', 'bindingSha256', 'choicesGeneration', 'agreementContextSha256', 'memoryContextSha256'], 'bootstrap expectations');
  if (q.schema !== 'fvs/auto-memory-bootstrap-request' || q.schemaVersion !== 1 || typeof q.attemptId !== 'string' || !UUID.test(q.attemptId)
    || !['worker-readonly', 'coordinator-refresh'].includes(q.operation) || !['start', 'resume'].includes(q.phase)
    || !text(q.target.projectId) || !text(q.target.sessionId) || (q.phase === 'start' ? q.target.resumeId !== null : !text(q.target.resumeId))
    || !integer(q.expected.bindingRevision) || !integer(q.expected.choicesGeneration)
    || !['bindingSha256', 'agreementContextSha256', 'memoryContextSha256'].every((k) => typeof q.expected[k] === 'string' && shaString(q.expected[k]))) stop('invalid-input', 'invalid closed bootstrap request/phase/target/expected identity');
  if (operation && q.operation !== operation) stop('memory-route-mismatch', 'worker and coordinator routes are distinct; role is trusted workflow metadata, not authentication');
}
export function prepareMemoryBootstrapRequest(options) {
  const { loadCanonical, attemptId, operation, phase, target } = memoryOwnData(options, 'request preparation');
  const values = memoryDataSnapshot({ attemptId, operation, phase, target });
  const c = current(loadCanonical);
  const request = { schema: 'fvs/auto-memory-bootstrap-request', schemaVersion: 1, ...values, expected: c.expected };
  validateRequest(request); return memoryDataSnapshot(request); // The caller supplies freshness; no nonce database or automatic identity.
}
function expectedCurrent(q, c) {
  if (memoryJson(q.expected) !== memoryJson(c.expected)) stop('memory-expectation-stale', 'caller expectations do not match current canonical binding/agreement/context');
}
function recognizedContext(value, c, validateEnvelope) {
  closed(value, ['schema', 'schemaVersion', 'authority', 'project', 'binding', 'agreement', 'agreementContextSha256', 'canonical', 'continuation'], 'stored memory context', 'memory-content-invalid');
  closed(value.project, ['canonicalRoot', 'gitCommonDir', 'backendProjectId'], 'stored memory project', 'memory-content-invalid');
  closed(value.binding, ['bindingRevision', 'bindingSha256'], 'stored memory binding', 'memory-content-invalid');
  closed(value.canonical, ['state', 'roadmap', 'goalSection'], 'stored canonical references', 'memory-content-invalid');
  closed(value.continuation, ['state', 'nextAction'], 'stored continuation', 'memory-content-invalid');
  if (value.schema !== 'fvs/project-memory-context' || value.schemaVersion !== 1 || value.authority !== 'context-only'
    || !integer(value.binding.bindingRevision) || !shaString(value.binding.bindingSha256 ?? '')
    || !object(value.agreement) || !shaString(value.agreementContextSha256 ?? '') || value.agreementContextSha256 !== memoryHash(value.agreement)
    || validateEnvelope(value.agreement).length || !Object.values(value.canonical).every(text) || !Object.values(value.continuation).every(text)) stop('memory-content-invalid', 'unknown or malformed memory context; it is not overwritten');
  if (memoryJson(value.project) !== memoryJson(c.context.project)) stop('memory-content-foreign', 'memory belongs to another project; it is not overwritten');
}
function readKey(b, r) {
  const entries = jsonBytes(r.run(b.bdPath, [...prefix(b), 'memories', MEMORY_KEY, '--json'], b.canonicalRoot, b.bdSha256));
  if (!object(entries) || entries.schema_version !== 1) stop('memory-output-invalid', 'unknown memories JSON profile');
  if (!(MEMORY_KEY in entries)) return null;
  if (typeof entries[MEMORY_KEY] !== 'string') stop('memory-content-invalid', 'the owned context key is not text');
  return entries[MEMORY_KEY];
}

export function runMemoryBootstrap(options) {
  let { projectRoot, callerRoot, request, requestBytes, out, operation, loadCanonical, validateEnvelope } = memoryOwnData(options, 'bootstrap inputs');
  request = memoryDataSnapshot(request); validateRequest(request, operation);
  callerRoot = fs.realpathSync(callerRoot);
  const raw = requestBytes ?? Buffer.from(memoryJson(request) + '\n');
  if (memoryJson(jsonBytes(raw)) !== memoryJson(request)) stop('invalid-input', 'retained request bytes differ from the caller request');
  const directory = ownOutput(projectRoot, out), requestSha256 = memoryHash(request), requestInputSha256 = hash(raw);
  fs.writeFileSync(path.join(directory, 'request.json'), raw, { flag: 'wx' });
  const r = runner(directory, request, requestInputSha256);
  const result = { schema: 'fvs/auto-memory-bootstrap-result', schemaVersion: 1, status: 'unverified', route: operation,
    request, requestSha256, requestInputSha256, callerRoot, observed: null, context: null, prime: null, receipts: r.receipts,
    trust: 'local host and declared workflow; context only, not authentication/proof authority', reason: null };
  let attemptedWrite = false;
  try {
    const c = current(loadCanonical); expectedCurrent(request, c);
    if (c.binding.canonicalRoot !== projectRoot) stop('memory-project-mismatch', 'binding is not for this canonical control root');
    const b = inspect(c.binding, r, callerRoot);
    let value = readKey(b, r), wanted = memoryJson(c.context);
    if (value !== null) {
      let parsed;
      try { parsed = JSON.parse(value); } catch { stop('memory-content-invalid', 'malformed owned memory; no automatic replacement'); }
      recognizedContext(parsed, c, validateEnvelope);
    }
    if (value !== wanted) {
      if (operation !== 'coordinator-refresh') stop(value === null ? 'memory-content-missing' : 'memory-content-stale', 'coordinator refresh is required; worker route cannot call remember');
      metadata(b); checkGitBinding(b, r, callerRoot); expectedCurrent(request, current(loadCanonical)); // Do not refresh after an intervening binding/context drift.
      attemptedWrite = true;
      r.run(b.bdPath, [...prefix(b, false), 'remember', '--key', MEMORY_KEY, wanted], b.canonicalRoot, b.bdSha256);
      value = readKey(b, r);
      if (value !== wanted) stop('memory-readback-failed', 'actual remembered key does not equal canonical context');
    }
    const prime = r.run(b.bdPath, [...prefix(b), 'prime', '--memories-only', '--max-memories', '0', '--max-memory-chars', '0'], b.canonicalRoot, b.bdSha256);
    const body = decode(prime).split('### ' + MEMORY_KEY + '\n')[1]?.split('\n### ')[0].trim();
    if (body !== wanted) stop('memory-prime-missing', 'actual complete memories-only prime does not contain the exact owned context');
    metadata(b); checkGitBinding(b, r, callerRoot); expectedCurrent(request, current(loadCanonical));
    fs.writeFileSync(path.join(directory, 'prime.txt'), prime, { flag: 'wx' });
    result.status = 'memory-primed'; result.observed = c.expected; result.context = c.context;
    result.prime = { file: 'prime.txt', sha256: hash(prime), bytes: prime.length };
    writeJson(path.join(directory, 'result.json'), result);
    return { code: 'memory-primed', out: directory, result, semanticCheckRequired: 'Canonical agreement applicability remains a mandatory workflow check; no worker dispatch or proof acceptance is implied.' };
  } catch (e) {
    result.status = attemptedWrite ? 'partial' : 'blocked'; result.reason = { code: e.code ?? 'memory-unverified', message: e.message };
    writeJson(path.join(directory, 'result.json'), result);
    stop(result.reason.code, result.reason.message, { out: directory, result });
  }
}

// Fake16/22 seam: the consumer supplies its OWN current request/output, never a result-chosen request.
export function consumeMemoryBootstrap(options) {
  let { request, out, callerRoot, loadCanonical } = memoryOwnData(options, 'consumer inputs');
  request = memoryDataSnapshot(request); validateRequest(request); const canonical = current(loadCanonical); expectedCurrent(request, canonical);
  metadata(canonical.binding);
  if (hash(readBytes(canonical.binding.bdPath)) !== canonical.binding.bdSha256) stop('memory-tool-changed', 'registered backend changed before bootstrap consumption');
  const root = fs.realpathSync(out), result = jsonBytes(readBytes(path.join(root, 'result.json'), root));
  closed(result, ['schema', 'schemaVersion', 'status', 'route', 'request', 'requestSha256', 'requestInputSha256', 'callerRoot', 'observed', 'context', 'prime', 'receipts', 'trust', 'reason'], 'bootstrap result', 'memory-result-invalid');
  if (result.schema !== 'fvs/auto-memory-bootstrap-result' || result.schemaVersion !== 1 || result.status !== 'memory-primed'
    || result.requestSha256 !== memoryHash(request) || memoryJson(result.request) !== memoryJson(request) || result.route !== request.operation
    || memoryJson(result.observed) !== memoryJson(request.expected) || memoryHash(result.context) !== request.expected.memoryContextSha256) stop('memory-result-mismatch', 'bootstrap result is not for the consumer current request/phase/target/context');
  if (result.callerRoot !== fs.realpathSync(callerRoot)) stop('memory-project-mismatch', 'bootstrap caller root differs from the consumer current caller');
  // The consumer's Git observation (returned as gitEvidence) stays beside the bootstrap output it verifies.
  const gitOut = ownOutput(canonical.binding.canonicalRoot, null, 'consume', root);
  const gitRunner = runner(gitOut, request, result.requestInputSha256);
  let gitObservation;
  try { gitObservation = checkGitBinding(canonical.binding, gitRunner, callerRoot); }
  catch (e) { writeJson(path.join(gitOut, 'failure.json'), { code: e.code, message: e.message, receipts: gitRunner.receipts }); throw e; }
  const raw = readBytes(path.join(root, 'request.json'), root);
  if (hash(raw) !== result.requestInputSha256 || memoryJson(jsonBytes(raw)) !== memoryJson(request)) stop('memory-result-mismatch', 'retained request bytes disagree with consumer request');
  if (!Array.isArray(result.receipts) || result.receipts.length === 0) stop('memory-evidence-invalid', 'actual invocation evidence is missing');
  let primeReceipt = null;
  const b = canonical.binding;
  const primeArgv = [b.bdPath, ...prefix(b), 'prime', '--memories-only', '--max-memories', '0', '--max-memory-chars', '0'];
  const allowedBackend = [
    [...prefix(b), '--version'], [...prefix(b), 'where', '--json'], [...prefix(b), 'info', '--json'],
    [...prefix(b), 'memories', MEMORY_KEY, '--json'], primeArgv.slice(1),
    ...(request.operation === 'coordinator-refresh' ? [[...prefix(b, false), 'remember', '--key', MEMORY_KEY, memoryJson(canonical.context)]] : []),
  ].map((args) => memoryJson([b.bdPath, ...args]));
  for (const ref of result.receipts) {
    closed(ref, ['file', 'sha256'], 'receipt reference', 'memory-evidence-invalid');
    const bytes = readBytes(path.resolve(root, ref.file), root);
    if (hash(bytes) !== ref.sha256) stop('memory-evidence-invalid', 'invocation receipt bytes changed');
    const r = jsonBytes(bytes);
    if (!object(r) || !Array.isArray(r.argv) || !r.argv.every(text) || !object(r.stdout) || !object(r.stderr)) stop('memory-evidence-invalid', 'malformed invocation receipt');
    if (r.argv[0] === b.bdPath && (!allowedBackend.includes(memoryJson(r.argv)) || r.toolBefore !== b.bdSha256)) stop('memory-evidence-invalid', 'backend invocation differs from the registered route/tool');
    if (memoryJson(r.argv) === memoryJson(primeArgv)) {
      if (primeReceipt) stop('memory-evidence-invalid', 'ambiguous duplicate prime invocation');
      primeReceipt = r;
    }
    if (r.requestSha256 !== result.requestSha256 || r.attemptId !== request.attemptId || r.requestInputSha256 !== result.requestInputSha256
      || r.exitCode !== 0 || r.error || r.signal || !shaString(r.toolBefore ?? '') || r.toolBefore !== r.toolAfter) stop('memory-evidence-invalid', 'invocation is not a successful observation for this request');
    if (request.operation === 'worker-readonly' && r.argv.includes('remember')) stop('memory-route-mismatch', 'worker observation reached a write command');
    for (const stream of [r.stdout, r.stderr]) {
      if (!integer(stream.bytes) || stream.bytes > MEMORY_LIMITS.maxBytes || !shaString(stream.sha256 ?? '')) stop('memory-evidence-invalid', 'invocation output is not within the capture bound');
      const data = readBytes(path.resolve(root, stream.file), root);
      if (hash(data) !== stream.sha256 || data.length !== stream.bytes) stop('memory-evidence-invalid', 'actual invocation output changed');
    }
  }
  closed(result.prime, ['file', 'sha256', 'bytes'], 'prime reference', 'memory-evidence-invalid');
  if (result.prime.file !== 'prime.txt') stop('memory-evidence-invalid', 'unexpected prime reference');
  const prime = readBytes(path.join(root, 'prime.txt'), root);
  if (!primeReceipt || primeReceipt.stdout.sha256 !== result.prime.sha256 || primeReceipt.stdout.bytes !== result.prime.bytes
    || hash(prime) !== result.prime.sha256 || prime.length !== result.prime.bytes
    || decode(prime).split('### ' + MEMORY_KEY + '\n')[1]?.split('\n### ')[0].trim() !== memoryJson(result.context)) stop('memory-evidence-invalid', 'complete prime bytes do not match current context');
  return { status: 'memory-primed', requestSha256: result.requestSha256, context: result.context, primeText: decode(prime), gitObservation, gitEvidence: { out: gitOut, receipts: gitRunner.receipts } };
}
