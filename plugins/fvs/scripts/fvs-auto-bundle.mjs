// Read-only review artifacts. A bundle is neither proof nor dispatch authority.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readState } from './fvs-auto.mjs';
import { memoryDataSnapshot, memoryHash } from './fvs-project-memory.mjs';
import { transitionJson } from './fvs-auto-transitions.mjs';
import { validatePlan, readChain, registryStatus } from './fvs-contract-registry.mjs';
import { readRuntime } from './fvs-auto-resume.mjs';
import { readAcceptedStore, inspectAutoBaselineArtifacts, inspectAutoAcceptance } from './fvs-checker-auto.mjs';

export class BundleError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const BUNDLE_LIMITS = Object.freeze({ fileBytes: 32 * 1024 * 1024, copiedBytes: 512 * 1024 * 1024, entries: 100000, deadlineMs: 600000 });
const fail = (code, message) => { throw new BundleError(code, message); };
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const data = v => JSON.parse(JSON.stringify(memoryDataSnapshot(v)));
const same = (a, b) => memoryHash(a) === memoryHash(b);
const text = v => typeof v === 'string' && v.trim() !== '';
const sha = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const commit = v => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
const ids = v => Array.isArray(v) && v.every((n, i) => Number.isSafeInteger(n) && n >= 0 && (i === 0 || n > v[i - 1]));
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const sourceView = (original, digest) => 'sources/' + digest + (/^\.[A-Za-z0-9_-]{1,20}$/.test(path.extname(original)) ? path.extname(original) : '.txt');
const stringify = v => JSON.stringify(data(v), null, 2) + '\n';
const diagnostic = e => ({ code: e.code ?? 'unverified', message: e.message });
function closed(v, keys, label) {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) fail('bundle-invalid-input', 'closed ' + label + ' required');
}
function deadline(ms) {
  if (!Number.isSafeInteger(ms) || ms <= Date.now()) fail('bundle-deadline-exhausted', 'read-only inspection deadline exhausted');
}
function directory(root, missing = false) {
  if (!text(root) || !path.isAbsolute(root) || path.normalize(root) !== root) fail('bundle-path-invalid', 'canonical directory required');
  try {
    const actual = fs.existsSync(root) ? root : missing ? path.dirname(root) : root;
    if (!fs.lstatSync(actual).isDirectory() || fs.realpathSync(actual) !== actual) throw Error('aliased directory');
  } catch { fail('bundle-path-invalid', 'directory unavailable or aliased: ' + root); }
}
function bytes(file) {
  try {
    if (!text(file) || !path.isAbsolute(file) || fs.realpathSync(file) !== file || !fs.lstatSync(file).isFile()) throw Error('not a canonical file');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (fs.fstatSync(fd).size > BUNDLE_LIMITS.fileBytes) fail('bundle-size-limit', 'required metadata/source exceeds byte bound: ' + file);
      const b = fs.readFileSync(fd);
      if (b.length > BUNDLE_LIMITS.fileBytes) fail('bundle-size-limit', 'input grew past byte bound');
      return b;
    } finally { fs.closeSync(fd); }
  } catch (e) { if (e instanceof BundleError) throw e; fail('bundle-evidence-invalid', 'required regular input unavailable: ' + file); }
}
function reference(r) {
  closed(r, ['file', 'sha256'], 'file reference');
  if (!sha(r.sha256) || !text(r.file) || !path.isAbsolute(r.file)) fail('bundle-evidence-invalid', 'absolute file and exact SHA256 required');
}
function bound(r, json = true) {
  reference(r); const b = bytes(r.file);
  if (hash(b) !== r.sha256) fail('bundle-evidence-invalid', 'bound input changed: ' + r.file);
  return json ? transitionJson(b) : b;
}
function save(file, value) {
  const b = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : stringify(value));
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, b); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return { file, sha256: hash(b) };
}
function git(root, args) {
  const p = spawnSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10000, maxBuffer: BUNDLE_LIMITS.fileBytes,
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
  if (p.error || p.signal || p.status !== 0) fail('bundle-source-unavailable', 'bounded offline Git observation failed');
  return p.stdout.trim();
}
function sourceNow(source) {
  directory(source.root);
  return { kind: 'git', root: source.root, commit: git(source.root, ['rev-parse', 'HEAD']), expectedTree: git(source.root, ['rev-parse', 'HEAD^{tree}']),
    dirty: git(source.root, ['status', '--porcelain=v1', '--untracked-files=all']) !== '' };
}
function projectBinding(projectRoot, sourceRoot) {
  const canonical = (root, flag) => fs.realpathSync(path.resolve(root, git(root, ['rev-parse', flag])));
  const common = canonical(projectRoot, '--git-common-dir');
  if (canonical(projectRoot, '--git-dir') !== common || canonical(sourceRoot, '--git-common-dir') !== common) fail('bundle-project-mismatch', 'primary project and source must share the actual Git common directory');
}
function agreementNow(root) {
  const v = readState({ projectRoot: root, requireAgreement: true });
  return { contextSha256: v.agreement.contextSha256, choicesGeneration: v.state.choicesGeneration,
    approvedPayloadSha256: v.agreement.agreement.approvedPayloadSha256, scope: v.state.choices.scope, limits: v.state.choices.limits };
}
function markers(root, runtime = false) {
  const dir = runtime ? path.join(root, '.formalising/auto-fv/resume') : root;
  if (!fs.existsSync(dir)) return [];
  directory(dir);
  return fs.readdirSync(dir).filter(n => n === 'lock' || n.startsWith('.tmp-')).sort();
}
function recordFiles(root) {
  const dir = path.join(root, 'records');
  if (!fs.existsSync(dir)) return [];
  directory(dir);
  return fs.readdirSync(dir).sort().map(n => {
    const m = /^(\d{6})-([0-9a-f]{64})\.json$/.exec(n);
    if (!m) fail('bundle-evidence-invalid', 'malformed committed record name: ' + n);
    return { file: path.join(dir, n), sha256: m[2] };
  });
}
function protectOutput(out, q, extra = []) {
  directory(path.dirname(out));
  if (!path.isAbsolute(out) || path.normalize(out) !== out || fs.existsSync(out)) fail('bundle-output-collision', 'exclusive canonical output required');
  const protectedRoots = [q.projectRoot, q.source.root, q.registry.root, q.acceptedStore?.root, q.runtime?.root,
    q.baseline && path.dirname(q.baseline.file), path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), ...extra].filter(Boolean);
  if (protectedRoots.some(r => inside(r, out) || inside(out, r))) fail('bundle-output-protected', 'output overlaps protected source/state/evidence');
}
function request(raw) {
  const q = data(raw);
  closed(q, ['schema', 'schemaVersion', 'bundleId', 'projectRoot', 'source', 'agreement', 'extraction', 'graph', 'plan', 'scopeInventory', 'registry', 'baseline', 'acceptedStore', 'runtime', 'handoff', 'absenceReasons', 'deadlineMs'], 'bundle request');
  if (q.schema !== 'fvs/auto-bundle-request' || q.schemaVersion !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(q.bundleId)) fail('bundle-invalid-input', 'version1 bundle UUID required');
  directory(q.projectRoot); closed(q.source, ['kind', 'root', 'commit', 'expectedTree'], 'source');
  if (q.source.kind !== 'git' || !commit(q.source.commit) || !commit(q.source.expectedTree)) fail('bundle-invalid-input', 'immutable Git source required');
  directory(q.source.root);
  closed(q.agreement, ['state', 'roadmap', 'contextSha256', 'choicesGeneration', 'approvedPayloadSha256'], 'agreement');
  for (const r of [q.agreement.state, q.agreement.roadmap, q.extraction, q.graph, q.plan, q.scopeInventory]) reference(r);
  if (![q.agreement.contextSha256, q.agreement.approvedPayloadSha256].every(sha) || !Number.isSafeInteger(q.agreement.choicesGeneration) || q.agreement.choicesGeneration < 0) fail('bundle-invalid-input', 'agreement generation/hash identity required');
  if (q.agreement.state.file !== path.join(q.projectRoot, '.formalising/auto-fv/state.json') || q.agreement.roadmap.file !== path.join(q.projectRoot, '.formalising/auto-fv/ROADMAP.md')) fail('bundle-invalid-input', 'canonical agreement paths required');
  closed(q.registry, ['root', 'expectedHeadSha256'], 'registry'); directory(q.registry.root, true);
  if (!(q.registry.expectedHeadSha256 === null || sha(q.registry.expectedHeadSha256))) fail('bundle-invalid-input', 'explicit registry head required');
  if (q.baseline !== null) reference(q.baseline);
  if (q.handoff !== null) reference(q.handoff);
  if (q.acceptedStore !== null) { closed(q.acceptedStore, ['root', 'expectedHeadSha256'], 'accepted store'); directory(q.acceptedStore.root, true); if (!(q.acceptedStore.expectedHeadSha256 === null || sha(q.acceptedStore.expectedHeadSha256))) fail('bundle-invalid-input', 'explicit accepted head required'); }
  if (q.runtime !== null) {
    closed(q.runtime, ['root', 'state', 'absenceReason'], 'runtime');
    if (q.runtime.root !== q.projectRoot) fail('bundle-invalid-input', 'runtime belongs to canonical project');
    if (q.runtime.state !== null) { reference(q.runtime.state); if (q.runtime.state.file !== path.join(q.projectRoot, '.formalising/auto-fv/resume/state.json') || q.runtime.absenceReason !== null) fail('bundle-invalid-input', 'canonical runtime state required'); }
    else if (!text(q.runtime.absenceReason)) fail('bundle-invalid-input', 'uncreated runtime needs reason');
  }
  closed(q.absenceReasons, ['baseline', 'acceptedStore', 'runtime', 'handoff'], 'absence reasons');
  for (const k of Object.keys(q.absenceReasons)) if (q[k] === null ? !text(q.absenceReasons[k]) : q.absenceReasons[k] !== null) fail('bundle-invalid-input', 'explicit absence reason differs: ' + k);
  deadline(q.deadlineMs);
  if (q.deadlineMs > Date.now() + BUNDLE_LIMITS.deadlineMs) fail('bundle-invalid-input', 'inspection exceeds existing600s bound');
  return q;
}
export function bundleExpectedContext(raw) {
  const q = request(raw);
  return { projectRoot: q.projectRoot, source: q.source, agreement: q.agreement, extraction: q.extraction, graph: q.graph, plan: q.plan,
    scopeInventory: q.scopeInventory, registry: q.registry, baseline: q.baseline, acceptedStore: q.acceptedStore, runtime: q.runtime, handoff: q.handoff };
}
function scopeData(q, get) {
  const p = get(q.plan), g = get(q.graph), inv = get(q.scopeInventory);
  if (p.schema !== 'fvs-closure-plan/record' || p.version !== 1 || !ids(p.selection?.requestedRoots) || !ids(p.selection?.failed) || !Array.isArray(p.roots) || !p.nodes || typeof p.nodes !== 'object') fail('bundle-scope-invalid', 'supported diagnostic13 selection required');
  closed(inv, ['schema', 'schemaVersion', 'agreement', 'plan', 'requestedRoots', 'failed', 'applicability'], 'scope inventory');
  if (inv.schema !== 'fvs/auto-bundle-scope-inventory' || inv.schemaVersion !== 1 || !same(inv.agreement, q.agreement) || !same(inv.plan, q.plan)
    || !same(inv.requestedRoots, p.selection.requestedRoots) || !same(inv.failed, p.selection.failed) || !Array.isArray(inv.applicability) || !inv.applicability.length) fail('bundle-scope-invalid', 'scope inventory must bind agreement and exact requested/failed selection');
  const itemIds = new Set(), mapped = new Set();
  for (const a of inv.applicability) {
    closed(a, ['scopeItemId', 'roots', 'disposition', 'reason', 'evidence'], 'scope correspondence');
    if (!text(a.scopeItemId) || itemIds.has(a.scopeItemId) || !ids(a.roots) || a.roots.some(id => !inv.requestedRoots.includes(id)) || !['mapped', 'unmapped', 'omitted'].includes(a.disposition)
      || !Array.isArray(a.evidence) || !a.evidence.length || (a.disposition === 'mapped' ? !a.roots.length || a.reason !== null : a.roots.length || !text(a.reason))) fail('bundle-scope-invalid', 'explicit unique applicability/omission record required');
    itemIds.add(a.scopeItemId); a.roots.forEach(id => mapped.add(id)); a.evidence.forEach(reference);
  }
  if (inv.requestedRoots.some(id => !mapped.has(id))) fail('bundle-scope-invalid', 'a requested root is absent from scope correspondence');
  if (p.inputs?.identitySha256 !== q.extraction.sha256 || p.inputs?.graphSha256 !== q.graph.sha256) fail('bundle-scope-invalid', 'diagnostic plan input identities conflict');
  const view = validatePlan({ json: p, sha256: q.plan.sha256 }, { json: g, sha256: q.graph.sha256 });
  const valid = view.problems.length === 0 && !!view.union;
  return { inventory: inv, plan: p, graph: g, valid, problems: view.problems, union: valid ? [...view.union].sort((a, b) => a - b) : null,
    nodes: valid ? Object.fromEntries([...view.nodes].map(([id, n]) => [id, { owner: n.ownerRoot, dependencies: n.dependsOn, eligibility: n.eligibility }])) : null };
}

function refPolicy(file, key) {
  if (/\.(?:mjs|cjs|js|py)$/.test(file)) return { role: 'code', recurse: false };
  if (/\.(?:lean|md|toml|rs)$/.test(file)) return { role: 'source', recurse: false };
  if (key === 'parts' && /\.(?:olean(?:\..*)?|ilean|ir|so|dylib|a|o)$/.test(file)) return { role: 'index-only', recurse: false };
  if (['tool', 'lean', 'lake', 'bd', 'node', 'git', 'ao', 'olean', 'ilean', 'ir'].includes(key)) return { role: 'index-only', recurse: false };
  return { role: 'evidence', recurse: file.endsWith('.json') };
}
function protectedMetadataRoots(v) {
  const roots = [];
  if (v?.schema === 'fvs-checker/freeze-request') roots.push(v.baseline?.source?.root, v.baseline?.dependencies?.root);
  if (v?.schema === 'fvs-checker/build-request') roots.push(v.source?.root, v.dependencies?.root, v.out);
  if (v?.schema === 'fvs-checker/build-result') roots.push(v.projectRoot, v.source?.root);
  if (v?.schema === 'fvs-checker/auto-baseline') roots.push(v.build?.projectRoot, v.registry?.root, ...protectedMetadataRoots(v.build));
  return roots.filter(r => typeof r === 'string' && path.isAbsolute(r));
}
// Both collection and captured-only verification use this fixed copy policy.
function scanRefs(v, copy, index, key = '', digestMap = false) {
  if (!v || typeof v !== 'object') return;
  if (Array.isArray(v)) { if (digestMap) fail('bundle-evidence-invalid', 'frozen digest map is not an object'); v.forEach(x => scanRefs(x, copy, index, key)); return; }
  const original = v.file ?? (['tool', 'lean', 'lake'].includes(key) ? v.path : null);
  if (Object.hasOwn(v, 'sha256') && typeof original === 'string' && path.isAbsolute(original)) {
    const r = { file: original, sha256: v.sha256 }, policy = refPolicy(r.file, key); reference(r);
    if (policy.role === 'index-only') index(r.file, r.sha256, 'compiled-or-tool'); else copy(r, policy.role, policy.recurse);
    return;
  }
  if (digestMap) {
    for (const [file, digest] of Object.entries(v)) {
      if (!path.isAbsolute(file) || !sha(digest)) fail('bundle-evidence-invalid', 'malformed frozen file index');
      if (key === 'checker') {
        if (/\.(?:mjs|cjs|js|py|lean)$/.test(file)) copy({ file, sha256: digest }, 'code', false); else index(file, digest, key);
      } else if (key === 'compiled' && !/\.(?:olean(?:\..*)?|ilean|ir|so|dylib|a|o)$/.test(file)) copy({ file, sha256: digest }, 'source', false);
      else index(file, digest, key);
    }
    return;
  }
  for (const [k, x] of Object.entries(v)) if (k !== 'specDefinitions') {
    const digestMap = v.schema === 'fvs-checker/auto-baseline' && ['compiled', 'imports', 'runtimes', 'checker'].includes(k);
    scanRefs(x, copy, index, k, digestMap);
  }
}

function collector(out, q) {
  const entries = new Map(), buffers = new Map(), external = new Map(), protectedRoots = new Set(), sourceViews = [];
  let copied = 0;
  const identity = r => r.file + '\0' + r.sha256;
  function indexed(file, digest, role) {
    deadline(q.deadlineMs);
    if (!path.isAbsolute(file) || !sha(digest)) fail('bundle-evidence-invalid', 'malformed indexed identity');
    if (entries.size + external.size >= BUNDLE_LIMITS.entries && !external.has(file + '\0' + digest)) fail('bundle-size-limit', 'evidence entry bound exceeded');
    external.set(file + '\0' + digest, { original: file, sha256: digest, policy: 'index-only', role, availability: 'not-established-by-index' });
  }
  function capture(r, role = 'evidence', recurse = true) {
    deadline(q.deadlineMs); reference(r);
    const key = identity(r); if (entries.has(key)) return entries.get(key);
    if (entries.size + external.size >= BUNDLE_LIMITS.entries) fail('bundle-size-limit', 'evidence entry bound exceeded');
    const b = bound(r, false); if (!buffers.has(r.sha256)) copied += b.length;
    if (copied > BUNDLE_LIMITS.copiedBytes) fail('bundle-size-limit', 'required copy budget exceeded at ' + r.file + '; scope was not narrowed');
    const relative = 'evidence/' + r.sha256;
    buffers.set(r.sha256, b);
    const row = { original: r.file, sha256: r.sha256, size: b.length, mode: fs.statSync(r.file).mode & 0o777, policy: 'required-copy', role, stored: relative };
    entries.set(key, row);
    if (role === 'source') sourceViews.push({ original: r.file, sha256: r.sha256, stored: relative, view: sourceView(r.file, r.sha256) });
    if (role === 'evidence') protectedRoots.add(path.dirname(r.file));
    if (recurse && r.file.endsWith('.json')) { const value = transitionJson(b); protectedMetadataRoots(value).forEach(r => protectedRoots.add(r)); scanRefs(value, capture, indexed); }
    return row;
  }
  return { capture, protectedRoots, sourceViews,
    get: r => { const row = entries.get(identity(r)); if (!row) fail('bundle-evidence-invalid', 'required captured identity missing'); return transitionJson(buffers.get(row.sha256)); },
    materialize() { for (const [digest, b] of buffers) save(path.join(out, 'evidence', digest), b); },
    index: () => [...entries.values()].sort((a, b) => a.original.localeCompare(b.original)),
    external: () => [...external.values()].sort((a, b) => a.original.localeCompare(b.original)),
    fence() { for (const row of entries.values()) { deadline(q.deadlineMs); if (hash(bytes(row.original)) !== row.sha256) fail('bundle-snapshot-drift', 'captured byte version changed before publication'); } },
  };
}
function capturedRegistry(q, c, scope) {
  const pending = markers(q.registry.root), refs = recordFiles(q.registry.root);
  const sourceVersions = [];
  refs.forEach(r => {
    c.capture(r); const record = c.get(r);
    if (record.schema !== 'fvs-contract-registry/record' || record.version !== 1 || !Number.isSafeInteger(record.defId) || record.defId < 0
      || !Number.isSafeInteger(record.seq) || !record.contract) fail('bundle-evidence-invalid', 'malformed committed14 header');
    contractView(record.contract);
    for (const d of record.contract.specDefinitions) {
      if (!text(d.file) || path.isAbsolute(d.file) || d.file.split('/').some(p => !p || p === '.' || p === '..') || !sha(d.sha256)) fail('bundle-evidence-invalid', 'unsafe registered source descriptor');
      const file = path.join(q.source.root, d.file); let current = null;
      if (fs.existsSync(file)) { const b = bytes(file); current = { file, sha256: hash(b) }; c.capture(current, 'source', false); }
      sourceVersions.push({ node: record.defId, name: d.name, file: d.file, registeredSha256: d.sha256, current,
        status: current === null ? 'source-version-unavailable' : current.sha256 === d.sha256 ? 'matches-registration' : 'changed-since-registration' });
    }
  });
  let chain = null, status = null;
  try {
    status = registryStatus({ plan: q.plan.file, graph: q.graph.file, registry: q.registry.root, 'spec-root': q.source.root });
    chain = readChain(q.registry.root);
    if (chain.pending && pending.length && !pending.some(n => n.startsWith('.tmp-'))) chain = readChain(q.registry.root, { ignoreLock: true });
  } catch (e) { fail('bundle-evidence-invalid', 'committed registry invalid: ' + e.message); }
  if (chain?.records && (chain.records.at(-1)?.sha ?? null) !== q.registry.expectedHeadSha256) fail('bundle-context-stale', 'registry head differs from expected committed head');
  const validated = !!chain?.records;
  // Pending nodes:{} is not an empty registry. Committed raw files are retained
  // even when a temporary record prevents the public historical reader.
  return { pending, status: pending.length || status?.code === 'pending' ? 'pending' : 'observed', validation: validated ? 'committed-history-validated' : 'raw-captured-unvalidated',
    reason: chain?.pending ?? status?.message ?? null, headSha256: validated ? chain.records.at(-1)?.sha ?? null : null, records: refs,
    effectiveNodes: !pending.length && status?.code === 'ok' && scope.valid ? status.nodes : null, sourceVersions };
}
function capturedRuntime(q, c) {
  if (q.runtime === null) return { status: 'not-established', reason: q.absenceReasons.runtime, pending: [], validation: 'not-established', validatedSnapshot: null, raw: null };
  const pending = markers(q.runtime.root, true), file = path.join(q.runtime.root, '.formalising/auto-fv/resume/state.json');
  if (q.runtime.state === null) {
    if (fs.existsSync(file)) fail('bundle-context-stale', 'runtime was declared absent but exists');
    return { status: pending.length ? 'pending' : 'not-established', reason: q.runtime.absenceReason, pending, validation: 'not-established', validatedSnapshot: null, raw: null };
  }
  c.capture(q.runtime.state); // Malformed/hash-mismatched committed JSON is fatal.
  const raw = c.get(q.runtime.state);
  if (raw.schema !== 'fvs/auto-runtime' || raw.schemaVersion !== 1 || !raw.run || !Array.isArray(raw.history)) fail('bundle-evidence-invalid', 'unsupported committed16 header');
  let value;
  try { value = readRuntime(q.runtime.root); }
  catch (e) {
    if (e.code !== 'resume-pending') fail('bundle-evidence-invalid', 'committed runtime invalid: ' + e.message);
    if (!pending.some(n => n.startsWith('.tmp-'))) {
      try { value = readRuntime(q.runtime.root, { ignoreLock: true }); }
      catch (error) { fail('bundle-evidence-invalid', 'committed runtime invalid: ' + error.message); }
    }
  }
  if (value?.state && value.state.run.canonicalRoot !== q.projectRoot) fail('bundle-context-stale', 'committed runtime belongs to another project');
  return { status: pending.length ? 'pending' : value?.state ? 'observed' : 'not-established', pending,
    validation: value?.state ? 'committed-history-validated' : 'raw-captured-unvalidated', raw: q.runtime.state,
    validatedSnapshot: value?.state ? { run: value.state.run, headSha256: value.headSha256, lastObservedAtMs: value.lastObservedAtMs, reservations: [...value.reservations.values()] } : null,
    reason: pending.length ? 'runtime pending; committed history is not live AO state' : null };
}
function tupleFence(q) {
  const source = sourceNow(q.source), a = agreementNow(q.projectRoot);
  return { source, agreement: a, stateSha256: hash(bytes(q.agreement.state.file)), roadmapSha256: hash(bytes(q.agreement.roadmap.file)),
    registry: { pending: markers(q.registry.root), records: recordFiles(q.registry.root).map(r => { bound(r, false); return r; }) },
    runtime: q.runtime === null ? null : { pending: markers(q.runtime.root, true), stateSha256: fs.existsSync(path.join(q.runtime.root, '.formalising/auto-fv/resume/state.json')) ? hash(bytes(path.join(q.runtime.root, '.formalising/auto-fv/resume/state.json'))) : null },
    accepted: q.acceptedStore === null ? null : { pending: markers(q.acceptedStore.root), records: recordFiles(q.acceptedStore.root).map(r => { bound(r, false); return r; }) } };
}
function expectedShape(v) {
  closed(v, ['projectRoot', 'source', 'agreement', 'extraction', 'graph', 'plan', 'scopeInventory', 'registry', 'baseline', 'acceptedStore', 'runtime', 'handoff'], 'consumer expected context');
  closed(v.source, ['kind', 'root', 'commit', 'expectedTree'], 'expected source');
  for (const r of [v.extraction, v.graph, v.plan, v.scopeInventory, v.agreement?.state, v.agreement?.roadmap]) reference(r);
  if (v.source.kind !== 'git' || !commit(v.source.commit) || !commit(v.source.expectedTree)) fail('bundle-invalid-input', 'consumer immutable source required');
}
function freshCurrentness(context, ms, out, scopeValid = true) {
  deadline(ms); expectedShape(context);
  try {
    projectBinding(context.projectRoot, context.source.root);
    const before = tupleFence(context);
    const live = sourceNow(context.source), a = agreementNow(context.projectRoot);
    if (live.dirty || live.commit !== context.source.commit || live.expectedTree !== context.source.expectedTree
      || a.contextSha256 !== context.agreement.contextSha256 || a.choicesGeneration !== context.agreement.choicesGeneration || a.approvedPayloadSha256 !== context.agreement.approvedPayloadSha256
      || hash(bytes(context.agreement.state.file)) !== context.agreement.state.sha256 || hash(bytes(context.agreement.roadmap.file)) !== context.agreement.roadmap.sha256) return { status: 'stale', reason: 'source-or-canonical-context-changed', nodes: [] };
    for (const r of [context.extraction, context.graph, context.plan, context.scopeInventory]) bound(r);
    if (markers(context.registry.root).length || context.runtime && markers(context.runtime.root, true).length || context.acceptedStore && markers(context.acceptedStore.root).length) return { status: 'pending', reason: 'live-registry-runtime-or-store-pending', nodes: [] };
    const registry = readChain(context.registry.root);
    if (registry.pending) return { status: 'pending', reason: 'registry-pending', nodes: [] };
    if ((registry.records.at(-1)?.sha ?? null) !== context.registry.expectedHeadSha256) return { status: 'stale', reason: 'registry-head-changed', nodes: [] };
    if (context.runtime?.state && hash(bytes(context.runtime.state.file)) !== context.runtime.state.sha256) return { status: 'stale', reason: 'runtime-snapshot-changed', nodes: [] };
    if (!scopeValid) return { status: 'unverified', reason: 'plan-has-no-validated-union', nodes: [] };
    if (context.baseline === null || context.acceptedStore === null) return { status: 'unverified', reason: 'frozen-or-accepted-evidence-not-established', nodes: [] };
    const artifacts = inspectAutoBaselineArtifacts({ baseline: context.baseline, deadlineMs: ms });
    if (!same(artifacts.inputs, { extraction: context.extraction, graph: context.graph, plan: context.plan }) || !same(artifacts.registry, { root: context.registry.root, headSha256: context.registry.expectedHeadSha256 })) return { status: 'stale', reason: 'frozen-stage-context-differs', nodes: [] };
    const result = inspectAutoAcceptance({ baseline: context.baseline, store: context.acceptedStore, source: context.source, deadlineMs: ms, out });
    for (const r of [context.extraction, context.graph, context.plan, context.scopeInventory]) bound(r);
    if (!same(before, tupleFence(context))) return { status: 'stale', reason: 'consumer-tuple-changed-during-inspection', nodes: [], existing15Observation: result };
    return { status: result.status === 'current' ? 'current' : 'unverified', reason: result.status === 'current' ? null : 'accepted-history-not-established', nodes: result.nodes,
      validation: 'existing15-full-current-inspector', availability: 'required proof inputs checked by15; other indexed bodies not independently probed', inspection: result };
  } catch (e) {
    const missing = e.code === 'bundle-source-unavailable' || /unavailable|ENOENT|EACCES|not found|missing|cannot open/i.test(e.message);
    const changed = /bound input changed|bound bytes changed|changed since freeze/i.test(e.message);
    return { status: !missing && (e.code === 'stale-input' || e.code === 'bundle-project-mismatch' || changed) ? 'stale' : 'unverified', reason: missing ? 'original-only-material-unavailable' : changed ? 'bound-context-changed' : 'current-inspection-incomplete', diagnostic: diagnostic(e), nodes: [] };
  }
}
function contractView(value) {
  if (!value) return null;
  if (!text(value.statement) || !Array.isArray(value.assumptions) || !value.assumptions.every(x => typeof x === 'string') || !Array.isArray(value.specDefinitions)) fail('bundle-evidence-invalid', 'registered/frozen contract is malformed');
  return { statement: value.statement, assumptions: value.assumptions, grounding: value.grounding, implementationDependencies: value.implementationDependencies,
    specDefinitions: value.specDefinitions, externalReferences: value.externalReferences };
}
function facts(snapshot, get) {
  const q = snapshot.request, scope = scopeData(q, get), p = scope.plan;
  const frozen = q.baseline === null ? null : get(q.baseline), registered = new Map(), accepted = new Map(), provisional = new Map();
  const frozenInput = frozen ? get(frozen.input) : null;
  for (const r of snapshot.registry.records) { const v = get(r); registered.set(v.defId, { ref: r, record: v }); }
  for (const r of snapshot.accepted.records) {
    const v = get(r); accepted.set(v.node, { ref: r, record: v });
    const check = get(v.candidateCheck);
    for (const id of check.nodes ?? []) provisional.set(id, { ref: v.candidateCheck, source: check.source, authority: 'provisional-only' });
  }
  const declaredIds = Object.entries(p.nodes).flatMap(([key, n]) => [Number(key), n?.defId]).filter(id => Number.isSafeInteger(id) && id >= 0);
  const known = new Set([...p.selection.requestedRoots, ...p.selection.failed, ...declaredIds, ...(scope.union ?? [])]);
  const nodes = [...known].sort((a, b) => a - b).map(id => {
    const root = p.roots.find(r => r?.defId === id), n = scope.nodes?.[id], registeredRow = registered.get(id), historical = accepted.get(id), frozenRow = frozen?.records?.[id];
    const current = !!historical && q.baseline !== null && snapshot.accepted.validation === 'history-chain-and-bound-evidence-validated'
      && snapshot.frozenValidation === 'frozen-artifacts-validated' && historical.record.frozenSha256 === q.baseline.sha256
      && historical.record.integrated.commit === q.source.commit && historical.record.integrated.tree === q.source.expectedTree
      && snapshot.currentnessAtCapture.validation === 'existing15-full-current-inspector' && snapshot.currentnessAtCapture.status === 'current'
      && snapshot.currentnessAtCapture.nodes.some(r => r.node === id && same(r.receipt, historical.ref));
    const pendingProof = provisional.get(id), reasons = [];
    if (!scope.valid) reasons.push('plan-unverified', ...scope.problems);
    if (root?.closure === null) reasons.push('closure-unknown');
    if (snapshot.registry.pending.length) reasons.push('registry-pending');
    if (snapshot.runtime.status === 'pending') reasons.push('runtime-pending');
    if (!current) reasons.push(snapshot.registry.effectiveNodes?.[id]?.state ?? 'canonical-current-acceptance-not-established');
    return { node: id, role: p.selection.requestedRoots.includes(id) ? 'root' : scope.valid && scope.union.includes(id) ? 'helper' : 'declared-node-unvalidated',
      owner: n?.owner ?? null, dependencies: n?.dependencies ?? null, closure: scope.valid && root ? root.closure : null,
      declared: { node: p.nodes[id] ?? null, roots: p.roots.filter(r => r?.defId === id), failed: p.selection.failed.includes(id) },
      registered: registeredRow ? { receipt: registeredRow.ref, validation: snapshot.registry.validation, stateAtCommit: registeredRow.record.state, contract: contractView(registeredRow.record.contract), review: registeredRow.record.review,
        sourceVersions: snapshot.registry.sourceVersions.filter(s => s.node === id) } : null,
      frozen: frozenRow ? { recordSha256: frozenRow.sha256, validation: snapshot.frozenValidation, contract: contractView(frozenRow.contract), target: frozen.targets.find(t => t.node === id) ?? null } : null,
      proofAtCapture: current ? 'current-accepted-at-capture' : historical ? 'historical-accepted' : pendingProof ? 'provisional-only' : snapshot.accepted.validation === 'history-chain-and-bound-evidence-validated' ? 'not-accepted' : 'unknown',
      historicalAcceptance: historical ? { receipt: historical.ref, integrated: historical.record.integrated, dependencies: historical.record.dependencies, validation: snapshot.accepted.validation } : null,
      provisional: pendingProof ?? null, currentnessAtCapture: current ? 'current' : snapshot.currentnessAtCapture.status, reasons: [...new Set(reasons)] };
  });
  if (nodes.some(n => !Number.isSafeInteger(n.node) || n.node < 0)) fail('bundle-scope-invalid', 'diagnostic node identity malformed');
  return { authority: 'human-review-artifact-only', humanReview: 'pending', coverageAuthority: 'bound13 requests and declared workflow applicability; no language classifier',
    ownershipAuthority: 'validated13 bookkeeping only; not live actor ownership',
    requestedRoots: p.selection.requestedRoots, failed: p.selection.failed, union: scope.union, planProblems: scope.problems, declaredPlan: { roots: p.roots, nodes: p.nodes }, applicability: scope.inventory.applicability,
    proofCoverage: p.selection.requestedRoots.length && scope.valid && !scope.inventory.applicability.some(a => a.disposition !== 'mapped') && p.selection.requestedRoots.every(id => nodes.find(n => n.node === id)?.proofAtCapture === 'current-accepted-at-capture') ? 'complete-at-capture' : 'partial-at-capture',
    nodes, sourceViews: snapshot.sourceViews, agreedScope: snapshot.agreement.scope, agreedLimits: snapshot.agreement.limits, runtime: snapshot.runtime,
    evidenceIdentity: { baseline: q.baseline, frozenValidationAtCapture: snapshot.frozenValidation, historicalValidationAtCapture: snapshot.accepted.validation,
      originalExtractionCommit: frozen?.extractionSourceCommit ?? null, frozenFixtureSource: frozen?.fixtureSource ?? null,
      lean: frozenInput?.baseline?.lean ?? null, lake: frozenInput?.baseline?.lake ?? null, libraries: frozenInput?.baseline?.libraries ?? null,
      proofPolicies: [...new Map([...accepted.values()].map(r => [memoryHash(r.record.policy), r.record.policy])).values()] },
    source: q.source, extraction: q.extraction, registryHeadAtCapture: snapshot.registry.headSha256, checkerCurrentnessAtCapture: snapshot.currentnessAtCapture };
}
const lineJson = v => JSON.stringify(data(v)).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
function render(snapshot, get) {
  const f = facts(snapshot, get);
  const card = c => c === null ? null : { statement: c.statement, assumptions: c.assumptions, grounding: c.grounding, specDefinitions: c.specDefinitions };
  const contract = ['-- FVS review bundle: view only; no proof or human approval authority.', '-- Statements retain their separate frozen/registered contexts; full facts remain in manifest.json.',
    ...f.nodes.map(n => '-- ' + lineJson({ node: n.node, role: n.role, frozenTarget: n.frozen?.target ?? null,
      frozen: card(n.frozen?.contract ?? null), registered: card(n.registered?.contract ?? null), registeredRecord: n.registered?.receipt ?? null }))].join('\n') + '\n';
  const md = v => '`' + lineJson(v).replace(/&/g, '\\u0026').replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\|/g, '\\|').replace(/`/g, '\\u0060') + '`';
  const accounting = f.runtime.validatedSnapshot;
  const recall = '# Verification recall\n\nHuman review: pending. Proof/currentness below is AT CAPTURE, not fresh dispatch permission.\n\n'
    + '## Scope and evidence\n\n    ' + lineJson({ requestedRoots: f.requestedRoots, failed: f.failed, union: f.union, applicability: f.applicability, planProblems: f.planProblems, source: f.source, extraction: f.extraction, proofCoverage: f.proofCoverage, evidenceIdentity: f.evidenceIdentity })
    + '\n\n## Roots and helpers\n\n| Node | Role / plan owner | Proof at capture | Currentness | Unfinished reasons |\n|---|---|---|---|---|\n'
    + f.nodes.map(n => `| ${n.node} | ${md([n.role, n.owner])} | ${md(n.proofAtCapture)} | ${md(n.currentnessAtCapture)} | ${md(n.reasons)} |`).join('\n')
    + '\n\nExact frozen/registered statements, assumptions and grounding are in contract.lean; complete dependency, review, definition and receipt facts remain in manifest.json.\n\n## Retained source and context views\n\n'
    + f.sourceViews.map(s => `- [${s.sha256.slice(0, 12)}](${s.view}) ${md(path.basename(s.original))}`).join('\n')
    + '\n\n## Original accounting\n\n    ' + lineJson({ agreedLimits: f.agreedLimits, runtimeValidation: f.runtime.validation, pending: f.runtime.pending,
      reason: f.runtime.reason, originalRun: accounting?.run ?? null, lastObservedAtMs: accounting?.lastObservedAtMs ?? null,
      reservations: accounting ? accounting.reservations.map(r => ({ id: r.id, stage: r.intent.stage, nodes: r.intent.nodes, state: r.state, sessionId: r.sessionId })) : null }) + '\n';
  return { facts: f, contract, recall };
}

export function buildReviewBundle(raw, out) {
  const q = request(raw); protectOutput(out, q);
  projectBinding(q.projectRoot, q.source.root);
  const before = tupleFence(q), a = before.agreement;
  if (before.source.dirty || before.source.commit !== q.source.commit || before.source.expectedTree !== q.source.expectedTree
    || a.contextSha256 !== q.agreement.contextSha256 || a.choicesGeneration !== q.agreement.choicesGeneration || a.approvedPayloadSha256 !== q.agreement.approvedPayloadSha256) fail('bundle-context-stale', 'source or canonical agreement differs');
  const c = collector(out, q);
  c.capture({ file: fileURLToPath(import.meta.url), sha256: hash(bytes(fileURLToPath(import.meta.url))) }, 'code', false);
  for (const r of [q.agreement.state, q.agreement.roadmap, q.extraction, q.graph, q.plan, q.scopeInventory]) c.capture(r, r === q.agreement.roadmap ? 'source' : 'input', false);
  for (const b of c.get(q.agreement.state).memoryBindings ?? []) for (const root of [b.storeDir, b.databasePath]) if (typeof root === 'string' && path.isAbsolute(root)) c.protectedRoots.add(root);
  const scope = scopeData(q, c.get); scope.inventory.applicability.forEach(a => a.evidence.forEach(r => c.capture(r, 'source', false)));
  const registry = capturedRegistry(q, c, scope), runtime = capturedRuntime(q, c);
  let frozenValidation = 'not-established', frozenDiagnostic = null;
  if (q.baseline !== null) {
    c.capture(q.baseline);
    const frozen = c.get(q.baseline);
    if (frozen.schema !== 'fvs-checker/auto-baseline' || frozen.version !== 1 || frozen.purpose !== 'auto' || frozen.authority !== 'expectations-only') fail('bundle-evidence-invalid', 'not a supported15 expectation bundle');
    try { inspectAutoBaselineArtifacts({ baseline: q.baseline, deadlineMs: q.deadlineMs }); frozenValidation = 'frozen-artifacts-validated'; }
    catch (e) { if (e.code === 'invalid-input') fail('bundle-evidence-invalid', 'malformed frozen evidence: ' + e.message); frozenValidation = 'captured-unverified'; frozenDiagnostic = diagnostic(e); }
  }
  if (q.handoff !== null) c.capture(q.handoff);
  let accepted = { validation: 'not-established', headSha256: null, records: [], reason: q.absenceReasons.acceptedStore };
  if (q.acceptedStore !== null) {
    const pending = markers(q.acceptedStore.root), refs = recordFiles(q.acceptedStore.root); refs.forEach(r => c.capture(r));
    if (!pending.some(n => n.startsWith('.tmp-'))) {
      let h; try { h = readAcceptedStore(q.acceptedStore.root, { ignoreLock: pending.includes('lock') }); } catch (e) { fail('bundle-evidence-invalid', 'historical15 evidence invalid: ' + e.message); }
      if (h.headSha256 !== q.acceptedStore.expectedHeadSha256) fail('bundle-context-stale', 'accepted head differs');
      accepted = { validation: 'history-chain-and-bound-evidence-validated', headSha256: h.headSha256, records: refs, pending, reason: pending.length ? 'committed history only; accepted store pending' : null };
    } else accepted = { validation: 'raw-captured-unvalidated', headSha256: null, records: [], pending, reason: 'accepted store pending; no private replay', rawRecords: refs };
  }
  protectOutput(out, q, [...c.protectedRoots]);
  fs.mkdirSync(out, { mode: 0o700 }); fs.mkdirSync(path.join(out, 'evidence')); fs.mkdirSync(path.join(out, 'sources')); c.materialize();
  const context = bundleExpectedContext(q), currentnessAtCapture = freshCurrentness(context, q.deadlineMs, path.join(out, 'inspection-at-capture'), scope.valid);
  const snapshot = { request: q, capturedAtMs: Date.now(), context, agreement: a, registry, runtime, accepted, frozenValidation, frozenDiagnostic, currentnessAtCapture, sourceViews: c.sourceViews };
  const views = render(snapshot, c.get);
  for (const s of c.sourceViews) {
    const target = path.join(out, sourceView(s.original, s.sha256));
    if (!fs.existsSync(target)) save(target, bound({ file: s.original, sha256: s.sha256 }, false));
  }
  // Evidence roots discovered in bound producer records are also protected.
  for (const root of c.protectedRoots) if (inside(root, out)) fail('bundle-output-protected', 'output is inside bound checker evidence');
  c.fence(); const after = tupleFence(q);
  if (!same(before, after)) fail('bundle-snapshot-drift', 'source/context/committed/pending tuple changed during collection');
  const contract = save(path.join(out, 'contract.lean'), views.contract), recall = save(path.join(out, 'recall.md'), views.recall);
  const manifest = { schema: 'fvs/auto-review-bundle', schemaVersion: 1, bundleId: q.bundleId, authority: 'human-review-artifact-only', humanReview: 'pending',
    producer: { file: fileURLToPath(import.meta.url), sha256: hash(bytes(fileURLToPath(import.meta.url))) }, snapshot, facts: views.facts,
    copies: c.index(), indexOnly: c.external(), sources: c.sourceViews,
    views: { contract: { file: 'contract.lean', sha256: contract.sha256 }, recall: { file: 'recall.md', sha256: recall.sha256 } } };
  for (const row of manifest.copies) if (hash(bytes(path.join(out, row.stored))) !== row.sha256) fail('bundle-evidence-invalid', 'staged copy changed');
  const published = save(path.join(out, 'manifest.json'), manifest), fd = fs.openSync(out, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return { status: 'review-bundle-written', authority: 'no-proof-or-dispatch-authority', humanReview: 'pending', proofCoverage: views.facts.proofCoverage, manifest: published };
}

export function verifyReviewBundle(raw) {
  const options = data(raw); closed(options, ['manifest', 'expectedContext', 'deadlineMs', 'out'], 'bundle verification'); reference(options.manifest); deadline(options.deadlineMs); expectedShape(options.expectedContext);
  if (options.deadlineMs > Date.now() + BUNDLE_LIMITS.deadlineMs) fail('bundle-invalid-input', 'inspection exceeds existing600s bound');
  const manifest = bound(options.manifest), root = path.dirname(options.manifest.file);
  if (path.basename(options.manifest.file) !== 'manifest.json' || manifest.schema !== 'fvs/auto-review-bundle' || manifest.schemaVersion !== 1 || manifest.authority !== 'human-review-artifact-only' || manifest.humanReview !== 'pending') fail('bundle-integrity-invalid', 'unsupported review manifest');
  const capturedRequest = manifest.snapshot.request;
  protectOutput(options.out, { ...capturedRequest, ...options.expectedContext }, [root, capturedRequest.projectRoot, capturedRequest.source.root, capturedRequest.registry.root,
    capturedRequest.acceptedStore?.root, capturedRequest.runtime?.root, capturedRequest.baseline && path.dirname(capturedRequest.baseline.file),
    ...manifest.copies.filter(r => r.role === 'evidence').map(r => path.dirname(r.original))].filter(Boolean));
  const captured = new Map();
  if (!Array.isArray(manifest.copies) || !Array.isArray(manifest.indexOnly) || manifest.copies.length + manifest.indexOnly.length > BUNDLE_LIMITS.entries) fail('bundle-size-limit', 'captured index exceeds supported bound');
  for (const row of manifest.copies) {
    deadline(options.deadlineMs);
    if (row.policy !== 'required-copy' || row.stored !== 'evidence/' + row.sha256 || !sha(row.sha256) || !text(row.original) || !path.isAbsolute(row.original)) fail('bundle-integrity-invalid', 'invalid captured identity');
    const key = row.original + '\0' + row.sha256;
    if (captured.has(key)) fail('bundle-integrity-invalid', 'duplicate captured identity');
    const b = bytes(path.join(root, row.stored));
    if (b.length !== row.size || hash(b) !== row.sha256) fail('bundle-integrity-invalid', 'required captured bytes changed');
    captured.set(key, b);
  }
  const get = r => { reference(r); const b = captured.get(r.file + '\0' + r.sha256); if (!b) fail('bundle-integrity-invalid', 'required copied evidence missing'); return transitionJson(b); };
  const indexed = new Set();
  for (const row of manifest.indexOnly) {
    if (row.policy !== 'index-only' || !path.isAbsolute(row.original) || !sha(row.sha256)) fail('bundle-integrity-invalid', 'malformed index-only identity');
    const key = row.original + '\0' + row.sha256;
    if (indexed.has(key)) fail('bundle-integrity-invalid', 'duplicate index-only identity'); indexed.add(key);
  }
  const visited = new Set(), derivedEvidenceRoots = new Set();
  const requireIndex = (file, digest) => { if (!indexed.has(file + '\0' + digest)) fail('bundle-integrity-invalid', 'required external index entry missing'); };
  function requireCopy(r, role = 'evidence', recurse = true) {
    reference(r); const key = r.file + '\0' + r.sha256;
    if (visited.has(key)) return; visited.add(key);
    if (role === 'evidence') derivedEvidenceRoots.add(path.dirname(r.file));
    const b = captured.get(key); if (!b) fail('bundle-integrity-invalid', 'promised bounded evidence omitted from copy index');
    if (recurse && r.file.endsWith('.json')) { const value = transitionJson(b); protectedMetadataRoots(value).forEach(r => derivedEvidenceRoots.add(r)); scanRefs(value, requireCopy, requireIndex); }
  }
  const q = manifest.snapshot.request;
  requireCopy(manifest.producer, 'code', false);
  for (const r of [q.agreement.state, q.agreement.roadmap, q.extraction, q.graph, q.plan, q.scopeInventory]) requireCopy(r, 'input', false);
  for (const b of get(q.agreement.state).memoryBindings ?? []) for (const root of [b.storeDir, b.databasePath]) if (typeof root === 'string' && path.isAbsolute(root)) derivedEvidenceRoots.add(root);
  const scope = scopeData(q, get); scope.inventory.applicability.forEach(a => a.evidence.forEach(r => requireCopy(r, 'source', false)));
  manifest.snapshot.registry.records.forEach(r => requireCopy(r));
  for (const s of manifest.snapshot.registry.sourceVersions) if (s.current) requireCopy(s.current, 'source', false);
  if (q.runtime?.state) requireCopy(q.runtime.state);
  if (q.baseline) requireCopy(q.baseline);
  if (q.handoff) requireCopy(q.handoff);
  manifest.snapshot.accepted.records.forEach(r => requireCopy(r));
  (manifest.snapshot.accepted.rawRecords ?? []).forEach(r => requireCopy(r));
  protectOutput(options.out, { ...capturedRequest, ...options.expectedContext }, [root, ...derivedEvidenceRoots]);
  const regenerated = render(manifest.snapshot, get);
  if (!same(manifest.snapshot.sourceViews, manifest.sources)) fail('bundle-integrity-invalid', 'saved source-view index differs');
  if (!same(regenerated.facts, manifest.facts)) fail('bundle-integrity-invalid', 'saved facts differ from captured records');
  for (const [key, expected, file] of [['contract', regenerated.contract, 'contract.lean'], ['recall', regenerated.recall, 'recall.md']]) {
    if (manifest.views[key].file !== file || hash(Buffer.from(expected)) !== manifest.views[key].sha256 || !bytes(path.join(root, file)).equals(Buffer.from(expected))) fail('bundle-integrity-invalid', 'rendered view changed');
  }
  for (const row of manifest.sources) {
    if (row.view !== sourceView(row.original, row.sha256) || hash(bytes(path.join(root, row.view))) !== row.sha256 || !captured.has(row.original + '\0' + row.sha256)) fail('bundle-integrity-invalid', 'context/source view changed');
  }
  fs.mkdirSync(options.out, { mode: 0o700 });
  const contextMatches = same(options.expectedContext, manifest.snapshot.context);
  let fresh = contextMatches ? freshCurrentness(options.expectedContext, options.deadlineMs, path.join(options.out, 'current-inspection'), manifest.facts.union !== null)
    : { status: 'stale', reason: 'consumer-context-differs-from-captured-snapshot', nodes: [] };
  const unavailable = [];
  for (const row of manifest.indexOnly) {
    deadline(options.deadlineMs);
    try { if (fs.realpathSync(row.original) !== row.original || !fs.lstatSync(row.original).isFile()) throw Error('not a direct regular body'); }
    catch { unavailable.push({ original: row.original, sha256: row.sha256 }); }
  }
  if (unavailable.length && fresh.status === 'current') fresh = { status: 'unverified', reason: 'indexed-original-material-unavailable', nodes: [], existing15Observation: fresh };
  const result = { schema: 'fvs/auto-review-bundle-verification', schemaVersion: 1, authority: 'no-proof-or-dispatch-authority', manifest: options.manifest,
    integrity: { status: 'valid', level: 'captured-data-and-view-integrity-only' }, savedFacts: 'unchanged-at-capture', currentness: fresh,
    availability: { status: unavailable.length ? 'unavailable' : 'paths-present-unverified', level: 'existence is not content validation; current proof requires existing15 full inspection', indexedBodies: manifest.indexOnly.length, unavailable }, humanReview: 'pending' };
  save(path.join(options.out, 'result.json'), result); return result;
}

function cli(args) {
  const command = args.shift(), flags = {};
  while (args.length) { const k = args.shift(), v = args.shift(); if (!['--request', '--out'].includes(k) || !v || Object.hasOwn(flags, k)) fail('bundle-usage', 'build/verify --request FILE --out DIR'); flags[k] = v; }
  if (!['build', 'verify'].includes(command) || !flags['--request'] || !flags['--out']) fail('bundle-usage', 'build/verify --request FILE --out DIR');
  const input = path.resolve(flags['--request']);
  const q = transitionJson(bytes(input));
  return command === 'build' ? buildReviewBundle(q, path.resolve(flags['--out'])) : verifyReviewBundle({ ...q, out: path.resolve(flags['--out']) });
}
let direct = false; try { direct = fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch {}
if (direct) {
  try { console.log(JSON.stringify(cli(process.argv.slice(2)), null, 2)); }
  catch (e) { console.log(JSON.stringify({ status: 'unverified', code: e.code ?? 'bundle-unverified', message: e.message }, null, 2)); process.exitCode = 7; }
}
