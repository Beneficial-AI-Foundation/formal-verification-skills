// Extraction-bound adapters. The kernel engine is shared with standalone audit;
// only these adapters can publish an auto acceptance event.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildRecord } from './fvs-rust-identity.mjs';
import { buildLeanGraph, duplicateKeys } from './fvs-lean-graph.mjs';
import { buildPlan, definitionClosure } from './fvs-closure-plan.mjs';
import { canonical, validatePlan, readChain, registryStatus } from './fvs-contract-registry.mjs';
import { tokens, verifyBuildImports } from './fvs-checker.mjs';

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const hash = (file) => sha(fs.readFileSync(file));
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isSha = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const isCommit = (v) => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
const relative = (v) => typeof v === 'string' && v.length > 0 && !path.isAbsolute(v) && !v.includes('\\') && !v.split('/').some((p) => !p || p === '.' || p === '..');
const moduleName = (v) => typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_']*(\.[A-Za-z_][A-Za-z0-9_']*)*$/.test(v);
function refuse(code, message) { const error = new Error(message); error.code = code; throw error; }
function closed(value, keys, label) {
  if (!object(value) || Object.keys(value).some((k) => !keys.includes(k))) refuse('invalid-input', `invalid ${label}`);
}
function json(bytes) {
  const text = bytes.toString('utf8');
  if (duplicateKeys(text).length) refuse('invalid-input', 'duplicate JSON keys');
  try { return JSON.parse(text); } catch { return refuse('invalid-input', 'incomplete JSON input'); }
}
function bound(ref, parse = true) {
  closed(ref, ['file', 'sha256'], 'bound input');
  if (!path.isAbsolute(ref.file ?? '') || !isSha(ref.sha256)) refuse('invalid-input', 'expected an absolute bound input');
  const bytes = fs.readFileSync(ref.file);
  if (sha(bytes) !== ref.sha256) refuse('stale-input', `bound input changed: ${ref.file}`);
  return { bytes, ...(parse ? { json: json(bytes) } : {}), sha256: ref.sha256 };
}
function save(dir, name, value) {
  const file = path.resolve(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  return { file, sha256: hash(file) };
}
function beforeDeadline(job) {
  if (!Number.isSafeInteger(job.deadlineMs)) refuse('invalid-input', 'a finite checker deadline is required');
  if (Date.now() >= job.deadlineMs) refuse('timeout', 'the checker deadline is exhausted');
}
function exclusive(out) {
  if (!path.isAbsolute(out ?? '')) refuse('invalid-input', 'output must be absolute');
  try { fs.mkdirSync(out); } catch (e) { refuse('invalid-input', `exclusive output unavailable: ${e.code}`); }
}
function captureInput(job, out, engine) {
  const file = path.join(out, 'controller-input.json'), bytes = engine.controllerInput.bytes;
  if (sha(bytes) !== engine.controllerInput.sha256) refuse('stale-input', 'controller request changed while being captured');
  fs.writeFileSync(file, bytes, { flag: 'wx' });
  return { controllerInput: { file, sha256: hash(file) }, adapterInput: save(out, 'adapter-input.json', job) };
}

// Re-run the existing producers; a self-consistent supplied plan is insufficient.
export function extractionContext(extraction) {
  closed(extraction, ['identity', 'graph', 'plan', 'rust', 'lean'], 'extraction inputs');
  const identity = bound(extraction.identity), graph = bound(extraction.graph), plan = bound(extraction.plan);
  closed(extraction.rust, ['sourceCommit', 'translation', 'manifest', 'rust', 'mappings', 'lean', 'functions', 'state', 'llbc', 'leanReceipt'], 'Rust identity inputs');
  const rust = Object.fromEntries(Object.entries(extraction.rust).map(([key, ref]) => [key, key === 'sourceCommit' ? ref : bound(ref)]));
  if (!isCommit(rust.sourceCommit) || canonical(buildRecord(rust)) !== canonical(identity.json)) refuse('stale-input', 'Rust identity does not reproduce from the original extraction');
  closed(extraction.lean, ['projectRoot', 'libraries', 'extract', 'log', 'receipt', 'manifest', 'constants', 'constantsRun', 'imports'], 'Lean graph inputs');
  const raw = extraction.lean;
  if (!path.isAbsolute(raw.projectRoot ?? '') || !Array.isArray(raw.libraries) || !raw.libraries.length || !raw.libraries.every(moduleName)) refuse('invalid-input', 'missing original Lean project/library context');
  const text = (key) => bound(raw[key], key !== 'log').bytes.toString('utf8');
  const rebuilt = buildLeanGraph({ projectRoot: raw.projectRoot, libraries: raw.libraries, extractText: text('extract'), logText: text('log'),
    receiptText: text('receipt'), manifestText: text('manifest'), constantsText: text('constants'), constantsRunText: text('constantsRun'), importsText: text('imports') });
  if (canonical(rebuilt) !== canonical(graph.json)) refuse('stale-input', 'Lean graph does not reproduce from the original bound run');
  const actual = buildPlan({ identity, graph, roots: plan.json.selection?.requestedRoots, failed: plan.json.selection?.failed, llbc: rust.llbc });
  if (canonical(actual) !== canonical(plan.json)) refuse('stale-input', 'closure plan does not reproduce from bound extraction inputs');
  const view = validatePlan(plan, graph);
  if (view.problems.length || plan.json.status !== 'ready') refuse('unsupported', `selected plan is not ready: ${view.problems.join('; ')}`);
  return { identity, graph, plan, view, constants: bound(raw.constants).json };
}

function registryContext(job, context, specRoot, { ignoreLock = false } = {}) {
  closed(job.registry, ['root', 'headSha256'], 'registry binding');
  if (!path.isAbsolute(job.registry.root ?? '') || !isSha(job.registry.headSha256)) refuse('invalid-input', 'missing exact registry head');
  const state = registryStatus({ plan: job.extraction.plan.file, graph: job.extraction.graph.file, registry: job.registry.root, 'spec-root': specRoot }, { ignoreLock });
  if (state.code !== 'ok' || !state.consistent || state.registryHeadSha256 !== job.registry.headSha256) refuse('stale-input', 'registry is pending or its global head changed');
  const chain = readChain(job.registry.root, { ignoreLock });
  if (chain.pending) refuse('stale-input', 'registry is pending');
  const records = {};
  for (const node of context.view.union) {
    const head = chain.heads.get(node), current = state.nodes[node];
    if (!head || !['machine-reviewed-provisional', 'recheck-required'].includes(current?.state)) refuse('stale-input', `node ${node} lacks current semantic readiness`);
    // A proof-only revision may preserve the previous matching semantic PASS.
    const pass = [...chain.records].reverse().find(({ record }) => record.defId === node && record.candidateSha256 === head.record.candidateSha256 && record.review?.verdict === 'pass');
    if (!pass) refuse('stale-input', `node ${node} has no real matching semantic PASS`);
    bound(pass.record.review.evidence, false);
    records[node] = { sha256: head.sha, candidateSha256: head.record.candidateSha256, contract: head.record.contract, semanticReview: pass.sha };
  }
  return records;
}

const engineFiles = ['fvs-auto.mjs', 'fvs-checker.mjs', 'FvsKernelAudit.lean', 'fvs-checker-auto.mjs', 'fvs-checker-build.mjs', 'fvs-rust-identity.mjs', 'fvs-lean-graph.mjs', 'fvs-closure-plan.mjs', 'fvs-contract-registry.mjs', 'fvs-probe-inventory.mjs', 'fvs-probe-linux.mjs', 'fvs-extract-patches.mjs'];
function engineIdentity() {
  return Object.fromEntries([process.execPath, '/usr/bin/git', ...engineFiles.map((f) => fileURLToPath(new URL(f, import.meta.url)))].map((file) => [file, hash(file)]));
}
function verifyFiles(files) {
  for (const [file, digest] of Object.entries(files)) if (hash(file) !== digest) refuse('stale-input', `frozen input changed: ${file}`);
}
const sourceHashes = (build) => Object.fromEntries(Object.entries(build.source.files).map(([rel, row]) => [rel, row.sha256]));
function buildFiles(build) {
  return Object.fromEntries([...build.modules.flatMap((m) => [...m.parts, ...[m.parts[0].replace(/\.olean$/, '.ir')].filter((f) => fs.existsSync(f)), m.ilean]),
    ...Object.keys(build.source.files).map((rel) => path.join(build.projectRoot, rel))].map((file) => [file, hash(file)]));
}
async function buildSnapshot(job, source, out, runId) {
  const { buildCheckerSnapshot } = await import('./fvs-checker-build.mjs');
  const result = await buildCheckerSnapshot({ ...job, schema: 'fvs-checker/build-request', version: 1, purpose: 'auto', source, out, runId });
  if (result.status !== 'built') refuse(result.status === 'unsupported' ? 'unsupported' : result.receipts?.some((r) => r.timedOut) || /deadline/i.test(result.reason ?? '') ? 'timeout' : 'audit-failed', result.reason ?? 'fresh build did not complete');
  if (result.schema !== 'fvs-checker/build-result' || result.version !== 1 || result.status !== 'built' || result.authority !== 'build-only'
    || result.runId !== runId || !result.modules?.length || result.proofChecked !== false) refuse('audit-failed', 'builder returned incomplete or foreign evidence');
  return result;
}
function checkedProcess(lean, args, cwd, deadlineMs, searchPaths, label) {
  const run = spawnSync(lean.path, args, { cwd, encoding: 'utf8', timeout: Math.max(1, deadlineMs - Date.now()), maxBuffer: 16 * 1024 * 1024,
    env: { PATH: `${path.dirname(lean.path)}:/usr/bin:/bin`, LANG: 'C', LEAN_PATH: searchPaths.join(path.delimiter), TMPDIR: cwd } });
  fs.writeFileSync(path.join(cwd, `${label}.stdout`), run.stdout ?? '', { flag: 'wx' });
  fs.writeFileSync(path.join(cwd, `${label}.stderr`), run.stderr ?? '', { flag: 'wx' });
  const receipt = save(cwd, `${label}.json`, { argv: [lean.path, ...args], cwd, exit: run.status, signal: run.signal, error: run.error?.code ?? null,
    stdoutSha256: sha(run.stdout ?? ''), stderrSha256: sha(run.stderr ?? '') });
  if (run.error?.code === 'ETIMEDOUT') refuse('timeout', `${label} timed out`);
  if (run.status !== 0 || run.signal || run.error) refuse('audit-failed', `${label} failed: ${run.stdout ?? ''}${run.stderr ?? ''}`);
  return { run, receipt };
}

export function sourceInventory(source, deadlineMs, out, label) {
  closed(source, ['kind', 'root', 'commit', 'expectedTree'], 'immutable source');
  if (source.kind !== 'git' || !path.isAbsolute(source.root ?? '') || !isCommit(source.commit) || !isCommit(source.expectedTree)) refuse('invalid-input', 'immutable context/candidate source is required');
  beforeDeadline({ deadlineMs });
  const git = '/usr/bin/git', toolSha256 = hash(git);
  const argv = [git, '--no-optional-locks', '--no-replace-objects', '-C', source.root, 'ls-tree', '-rz', '--full-tree', source.expectedTree];
  const env = { PATH: '/usr/bin:/bin', LANG: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' };
  const run = spawnSync(git, argv.slice(1), { cwd: out, timeout: Math.max(1, deadlineMs - Date.now()), maxBuffer: 16 * 1024 * 1024,
    env });
  fs.writeFileSync(path.join(out, `${label}.stdout`), run.stdout ?? '', { flag: 'wx' });
  fs.writeFileSync(path.join(out, `${label}.stderr`), run.stderr ?? '', { flag: 'wx' });
  const attempt = save(out, `${label}-attempt.json`, { argv, cwd: out, env, toolSha256, exit: run.status, signal: run.signal, error: run.error?.code ?? null,
    stdoutSha256: sha(run.stdout ?? ''), stderrSha256: sha(run.stderr ?? '') });
  if (hash(git) !== toolSha256) refuse('stale-input', 'Git changed during immutable source inventory');
  if (run.error?.code === 'ETIMEDOUT') refuse('timeout', 'immutable source inventory timed out');
  if (run.status !== 0 || run.signal || run.error) refuse('invalid-input', 'immutable source inventory failed');
  const files = [];
  for (const row of run.stdout.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(row);
    if (!match || !relative(match[3]) || files.includes(match[3])) refuse('unsupported', 'unsupported immutable source entry');
    files.push(match[3]);
  }
  return { files, evidence: save(out, `${label}.json`, { source, files, attempt }) };
}

export function overlayModule(file, sourceRoot = '') {
  if (!relative(file) || (sourceRoot !== '' && sourceRoot !== '.' && !relative(sourceRoot))) return null;
  const prefix = sourceRoot && sourceRoot !== '.' ? `${sourceRoot}/` : '';
  if (!file.startsWith(prefix) || !file.endsWith('.lean') || file === 'lakefile.lean') return null;
  const name = file.slice(prefix.length, -5).replaceAll('/', '.');
  return moduleName(name) ? name : null;
}

function targetsOf(job, context, records, build) {
  if (!Array.isArray(job.targets) || !job.targets.length || new Set(job.targets.map((t) => t?.node)).size !== job.targets.length
    || canonical(job.targets.map((t) => t.node).sort((a, b) => a - b)) !== canonical([...context.view.union].sort((a, b) => a - b))) refuse('invalid-input', 'exact selected proof-node coverage is required');
  return job.targets.map((target) => {
    closed(target, ['node', 'module', 'name', 'contextFile'], 'proof mapping');
    if (!Number.isSafeInteger(target.node) || !moduleName(target.module) || typeof target.name !== 'string' || !relative(target.contextFile)
      || !target.name || (!build.modules.some((m) => m.name === target.module)
        && !job.overlayFiles.some((file) => overlayModule(file, job.baseline.sourceRoot) === target.module))) refuse('invalid-input', 'future proof mapping requires an exact declared overlay module');
    const record = records[target.node], definitions = record.contract.specDefinitions;
    if (!definitions.some((d) => d.file === target.contextFile && d.sha256 === hash(path.join(build.projectRoot, target.contextFile)))) refuse('stale-input', 'expected context is not sealed by the reviewed contract');
    return { ...target, expectedName: `FvsCheckerExpected.expected_${target.node}`, statement: record.contract.statement };
  });
}

export function verifyContextBindings(expected, targets, originalFiles, records, projectRoot) {
  for (const target of targets) {
    const imports = expected.contexts.find((c) => c.contextFile === target.contextFile)?.projectImports;
    if (!Array.isArray(imports)) refuse('invalid-input', 'missing reviewed context import closure');
    for (const module of imports) {
      if (!relative(module.source)) refuse('unsupported', 'unsealed context source');
      const digest = originalFiles[module.source] ?? records[target.node].contract.specDefinitions.find((d) => d.file === module.source)?.sha256;
      if (!isSha(digest)) refuse('unsupported', 'context import source is absent from this reviewed contract');
      if (hash(path.join(projectRoot, module.source)) !== digest) refuse('stale-input', 'reviewed context import source changed');
    }
  }
}

export function expectedWitness(job, build, targets, out, engine) {
  fs.mkdirSync(out);
  const projectRoots = build.modules.map((m) => {
    const suffix = `${m.name.split('.').join('/')}.olean`;
    if (!m.parts[0].endsWith(`/${suffix}`)) refuse('unsupported', 'unsupported project module search layout');
    return m.parts[0].slice(0, -suffix.length - 1);
  });
  const paths = [...new Set([...projectRoots, ...build.externalSearchPaths])];
  const modules = [], sources = [], receipts = [], contexts = [], targetModules = {};
  const byName = new Map(build.modules.map((m) => [m.name, m]));
  const overlays = new Set((job.overlayFiles ?? []).map((f) => overlayModule(f, job.baseline?.sourceRoot)).filter(Boolean));
  const groups = [...new Set(targets.map((t) => t.contextFile))].sort();
  for (const [index, contextFile] of groups.entries()) {
    const selected = targets.filter((t) => t.contextFile === contextFile);
    const owners = build.modules.filter((m) => m.source === contextFile);
    if (owners.length !== 1) refuse('unsupported', 'reviewed context must map to one pristine compiled module');
    const context = owners[0], closure = new Set(), pending = [context.name], bindings = [];
    while (pending.length) {
      const name = pending.pop();
      if (overlays.has(name)) refuse('unsupported', 'reviewed context imports a mutable proof overlay');
      if (closure.has(name)) continue;
      closure.add(name);
      const module = byName.get(name);
      if (!module) continue;
      if (!path.isAbsolute(module.ilean ?? '')) refuse('unsupported', 'reviewed context lacks compiler import metadata');
      if (!fs.existsSync(module.ilean)) refuse('stale-input', 'reviewed compiler import metadata is unavailable');
      const metadata = json(fs.readFileSync(module.ilean));
      if (metadata.version !== 5 || metadata.module !== name || !Array.isArray(metadata.directImports)
        || metadata.directImports.some((row) => !Array.isArray(row) || !moduleName(row[0]))) refuse('unsupported', 'unsupported reviewed context import inventory');
      pending.push(...metadata.directImports.map((row) => row[0]));
      const ir = module.parts[0].replace(/\.olean$/, '.ir');
      bindings.push({ name, source: module.source, inputs: Object.fromEntries([...module.parts, module.ilean,
        ...(fs.existsSync(ir) ? [ir] : [])].map((file) => [file, hash(file)])) });
    }
    const opens = new Set();
    const text = fs.readFileSync(path.join(build.projectRoot, contextFile), 'utf8');
    let scoped = false;
    for (const token of tokens(text)) {
      if (['namespace', 'section', 'end', 'variable', 'universe'].includes(token.text)) scoped = true;
      if (token.text !== 'open') continue;
      const start = text.lastIndexOf('\n', token.start) + 1;
      const end = text.indexOf('\n', token.end);
      const names = text.slice(token.end, end < 0 ? text.length : end).trim().split(/\s+/);
      if (scoped || text.slice(start, token.start).trim() || names.some((n) => !moduleName(n) || ['scoped', 'in', 'hiding', 'renaming'].includes(n))) refuse('unsupported', 'unsupported lexical or scoped reviewed open context');
      for (const name of names) opens.add(name);
    }
    const name = groups.length === 1 ? 'FvsCheckerExpected' : `FvsCheckerExpected${index}`;
    const termsRequest = save(out, `terms-request-${index}.json`, { runId: `${job.runId}-terms-${index}`, referenceModules: [context], terms: selected.map((t) => t.statement) });
    const parsed = checkedProcess(build.lean, ['--run', engine.HELPER, 'validate-terms', termsRequest.file], out, job.deadlineMs, paths, `parse-terms-${index}`);
    const result = json(Buffer.from(parsed.run.stdout));
    if (result.schema !== 'fvs-checker/parsed-terms' || result.runId !== `${job.runId}-terms-${index}`) refuse('audit-failed', 'foreign term parser result');
    const source = [`import ${context.name}`, 'set_option autoImplicit false', ...(opens.size ? [`open ${[...opens].join(' ')}`] : []), 'namespace FvsCheckerExpected',
      ...selected.map((t) => `theorem expected_${t.node} : (${t.statement}) := by sorry`), 'end FvsCheckerExpected', ''].join('\n');
    const file = path.join(out, `${name}.lean`); fs.writeFileSync(file, source, { flag: 'wx' });
    const base = path.join(out, name);
    const compiled = checkedProcess(build.lean, ['-o', `${base}.olean`, '-i', `${base}.ilean`, file], out, job.deadlineMs, paths, `compile-expectations-${index}`);
    modules.push({ name, parts: [`${base}.olean`] }); sources.push({ file, sha256: hash(file) }); receipts.push(parsed.receipt, compiled.receipt);
    contexts.push({ contextFile, module: context.name, projectImports: bindings });
    for (const target of selected) targetModules[target.node] = name;
    for (const binding of bindings) verifyFiles(binding.inputs);
  }
  return { modules, sources, receipts, contexts, targetModules };
}

function kernelRequest(job, build, references, targets, context, nodes = targets.map((t) => t.node)) {
  const selected = targets.filter((t) => nodes.includes(t.node));
  return { schema: 'fvs-checker/kernel-request', version: 1, runId: job.runId, deadlineMs: job.deadlineMs, lean: build.lean,
    externalSearchPaths: build.externalSearchPaths, externalImports: build.externalImports,
    modules: build.modules.map(({ name, parts }) => ({ name, parts })), referenceModules: references.map(({ name, parts }) => ({ name, parts })),
    targets: selected.map(({ name, expectedName, module }) => ({ name, expectedName, module })),
    meaningRoots: [...new Set(selected.flatMap((t) => definitionClosure(context.graph.json, context.view.nodes.get(t.node).declarations)
      .filter((name) => context.graph.json.nodes[name]).map((name) => name.replace(/^probe:/, ''))))] };
}

function originalProjectModules(job, context) {
  const root = job.extraction.lean.projectRoot, compiled = context.constants.inputs.compiled;
  return Object.keys(context.graph.json.completeness.modules).map((name) => {
    if (!moduleName(name)) refuse('unsupported', 'unsupported original module layout');
    const base = `.lake/build/lib/lean/${name.replaceAll('.', '/')}.olean`;
    const parts = Object.hasOwn(compiled, `${base}.private`) || Object.hasOwn(compiled, `${base}.server`) ? [base, `${base}.server`, `${base}.private`] : [base];
    for (const rel of parts) if (!isSha(compiled[rel]) || hash(path.join(root, rel)) !== compiled[rel]) refuse('stale-input', `original compiled reference is unavailable: ${rel}`);
    return { name, parts: parts.map((rel) => path.join(root, rel)) };
  });
}

function originalExternalParts(job, context, build) {
  const original = bound(job.extraction.lean.imports).json.modules, project = new Set(Object.keys(context.graph.json.completeness.modules));
  for (const [name, module] of Object.entries(original)) {
    if (project.has(name)) continue;
    beforeDeadline(job);
    if (!moduleName(name) || !object(module.parts)) refuse('unsupported', 'unsupported original dependency inventory');
    const base = build.externalSearchPaths.map((dir) => path.join(dir, `${name.replaceAll('.', '/')}.olean`)).find((file) => fs.existsSync(file));
    if (!base) refuse('stale-input', `missing original external module ${name}`);
    for (const [suffix, digest] of Object.entries(module.parts)) {
      if (!['.olean', '.server', '.private'].includes(suffix) || !isSha(digest)) refuse('unsupported', 'unsupported original import part');
      const file = suffix === '.olean' ? base : base + suffix;
      if (!fs.existsSync(file) || hash(file) !== digest) refuse('stale-input', `external module changed since extraction: ${name}${suffix}`);
    }
  }
}

async function freezeAuto(job, out, engine) {
  closed(job, ['schema', 'version', 'purpose', 'runId', 'deadlineMs', 'extraction', 'registry', 'baseline', 'targets', 'overlayFiles'], 'auto freeze request');
  if (!Array.isArray(job.overlayFiles) || !job.overlayFiles.every(relative) || new Set(job.overlayFiles).size !== job.overlayFiles.length) refuse('invalid-input', 'explicit proof overlay file list is required');
  const context = extractionContext(job.extraction);
  if (job.baseline?.source?.kind !== 'git' || !isCommit(job.baseline.source.commit) || !isCommit(job.baseline.source.expectedTree)) refuse('invalid-input', 'auto baseline must name an immutable fixture commit and tree');
  if (job.baseline.lean?.sha256 !== context.constants.producer.leanSha256 || job.baseline.lake?.sha256 !== context.constants.producer.lakeSha256) refuse('stale-input', 'checker toolchain differs from the bound extraction toolchain');
  const records = registryContext(job, context, job.baseline.source.root);
  exclusive(out);
  const requestInput = captureInput(job, out, engine);
  const checker = engineIdentity();
  const pristine = sourceInventory(job.baseline.source, job.deadlineMs, out, 'pristine-source');
  if (pristine.files.some((file) => job.overlayFiles.includes(file))) refuse('unsupported', 'freeze requires a pristine context commit with mutable proof overlays absent');
  const reviewed = new Set(Object.values(records).flatMap((r) => r.contract.specDefinitions.map((d) => d.file)));
  if (pristine.files.some((file) => file.endsWith('.lean') && !Object.hasOwn(context.constants.inputs.files, file) && !reviewed.has(file))) refuse('unsupported', 'pristine context contains unreviewed Lean source');
  const build = await buildSnapshot({ ...job.baseline, deadlineMs: job.deadlineMs }, job.baseline.source, path.join(out, 'baseline-build'), `${job.runId}-build`);
  const files = sourceHashes(build);
  for (const [rel, digest] of Object.entries(context.constants.inputs.files)) if (!rel.startsWith('.lake/') && files[rel] !== digest) refuse('stale-input', `baseline differs from original extraction context: ${rel}`);
  const frozenRecords = registryContext(job, context, build.projectRoot);
  if (canonical(records) !== canonical(frozenRecords)) refuse('stale-input', 'registry changed while materializing the baseline');
  for (const file of job.overlayFiles) if (Object.values(records).some((r) => r.contract.specDefinitions.some((d) => d.file === file))) refuse('invalid-input', 'a reviewed meaning file cannot also be a mutable proof overlay');
  const targets = targetsOf(job, context, records, build);
  originalExternalParts(job, context, build);
  const original = { ...kernelRequest({ ...job, runId: `${job.runId}-extraction-meaning` }, build, originalProjectModules(job, context), targets, context),
    targets: [], meaningOnly: true };
  const originalRequest = save(out, 'extraction-meaning-request.json', original);
  const extractionMeaning = engine.runKernelAudit({ request: originalRequest.file, out: path.join(out, 'extraction-meaning-check') }, { baseline: true });
  engine.verifyBuildImports(build, extractionMeaning.attempt.imports, job.deadlineMs);
  const expected = expectedWitness(job, build, targets, path.join(out, 'expectations'), engine);
  verifyContextBindings(expected, targets, context.constants.inputs.files, records, build.projectRoot);
  const references = [...build.modules, ...expected.modules];
  const anchors = targets.map((t) => ({ ...t, name: t.expectedName, module: expected.targetModules[t.node] }));
  const kernel = kernelRequest(job, { ...build, modules: references }, references, anchors, context);
  const request = save(out, 'meaning-request.json', kernel);
  const meaning = engine.runKernelAudit({ request: request.file, out: path.join(out, 'meaning-check') }, { baseline: true });
  engine.verifyBuildImports(build, meaning.attempt.imports, job.deadlineMs);
  const compiled = { ...buildFiles(build), ...Object.fromEntries([...expected.sources.map((s) => s.file), ...expected.modules.flatMap((m) => [...m.parts,
    ...['.ilean', '.ir'].map((suffix) => m.parts[0].replace(/\.olean$/, suffix)).filter((f) => fs.existsSync(f))])].map((f) => [f, hash(f)])) };
  const imports = Object.fromEntries(meaning.attempt.imports.filter((m) => !m.project).flatMap((m) => m.parts.map((p) => [p.file, p.sha256])));
  const input = save(out, 'freeze-request.json', job);
  verifyFiles(checker); verifyFiles(compiled); verifyFiles(imports);
  extractionContext(job.extraction); registryContext(job, context, build.projectRoot); beforeDeadline(job);
  const frozen = { schema: 'fvs-checker/auto-baseline', version: 1, purpose: 'auto', authority: 'expectations-only', runId: job.runId,
    input, ...requestInput, contextInventory: pristine.evidence, checker, extractionSourceCommit: context.identity.json.provenance.sourceCommit, fixtureSource: build.source,
    registry: job.registry, records, targets, overlayFiles: job.overlayFiles, build, references, compiled, imports, runtimes: meaning.attempt.runtimes,
    expected, extractionMeaningCheck: extractionMeaning.evidence, extractionMeaning: extractionMeaning.audit,
    meaningCheck: meaning.evidence, meaning: meaning.audit };
  const baseline = save(out, 'frozen.json', frozen);
  return { code: 'ok', schema: 'fvs-checker/freeze-result', purpose: 'auto', authority: 'expectations-only', baseline, targetProofsChecked: false };
}

function frozenContext(ref, { ignoreRegistryLock = false } = {}) {
  const frozen = bound(ref).json;
  if (frozen.schema !== 'fvs-checker/auto-baseline' || frozen.version !== 1 || frozen.purpose !== 'auto' || frozen.authority !== 'expectations-only'
    || frozen.meaning?.status !== 'meaning-checked' || frozen.meaning?.targetProofsChecked !== false
    || frozen.extractionMeaning?.status !== 'meaning-checked' || frozen.extractionMeaning?.targetProofsChecked !== false) refuse('invalid-input', 'auto check requires an extraction-bound expectation bundle');
  for (const [ref, declared] of [[frozen.extractionMeaningCheck, frozen.extractionMeaning], [frozen.meaningCheck, frozen.meaning]]) {
    const evidence = bound(ref).json;
    if (evidence.authority !== 'audit-only' || canonical(evidence.audit) !== canonical(declared) || evidence.audit?.schema !== 'fvs-kernel-baseline/result'
      || evidence.audit.targetProofsChecked !== false) refuse('stale-input', 'frozen meaning evidence does not match its retained checker result');
  }
  const job = bound(frozen.input).json, context = extractionContext(job.extraction);
  if (canonical(bound(frozen.contextInventory).json.source) !== canonical(job.baseline.source)) refuse('stale-input', 'frozen pristine context inventory changed');
  if (canonical(frozen.registry) !== canonical(job.registry) || canonical(frozen.fixtureSource) !== canonical(frozen.build.source)
    || frozen.extractionSourceCommit !== context.identity.json.provenance.sourceCommit || frozen.runId !== job.runId
    || frozen.build.source.commit !== job.baseline.source.commit || frozen.build.source.tree !== job.baseline.source.expectedTree) refuse('stale-input', 'frozen source/registry tuple is inconsistent');
  bound(frozen.controllerInput); bound(frozen.adapterInput);
  if (canonical(engineIdentity()) !== canonical(frozen.checker)) refuse('stale-input', 'checker/policy identity changed since freeze');
  verifyFiles(frozen.compiled); verifyFiles(frozen.imports); verifyFiles(frozen.runtimes);
  const records = registryContext(job, context, frozen.build.projectRoot, { ignoreLock: ignoreRegistryLock });
  if (canonical(records) !== canonical(frozen.records)) refuse('stale-input', 'contract records changed since freeze');
  return { frozen, job, context };
}

function checkEvidence(ref, frozenSha256) {
  const result = bound(ref).json;
  if (result.schema !== 'fvs-checker/auto-check' || result.version !== 1 || result.purpose !== 'auto' || result.authority !== 'provisional-only'
    || result.status !== 'provisional' || result.frozenSha256 !== frozenSha256 || !Array.isArray(result.nodes) || !result.nodes.length
    || new Set(result.nodes).size !== result.nodes.length || !result.nodes.every((n) => Number.isSafeInteger(n) && n >= 0)
    || !isCommit(result.source?.commit) || !isCommit(result.source?.tree)) refuse('invalid-input', 'candidate evidence is not a bound auto provisional check');
  const frozen = bound(result.baseline).json;
  if (result.baseline.sha256 !== frozenSha256 || frozen.schema !== 'fvs-checker/auto-baseline' || frozen.purpose !== 'auto'
    || result.registryHeadSha256 !== frozen.registry.headSha256 || canonical(result.records) !== canonical(frozen.records)) refuse('stale-input', 'candidate evidence has foreign frozen/registry bindings');
  const kernel = bound(result.kernelCheck).json;
  const adapter = bound(result.adapterInput).json;
  bound(result.controllerInput);
  if (adapter.runId !== result.runId || adapter.baseline?.sha256 !== result.frozenSha256 || adapter.source?.commit !== result.source.commit
    || adapter.source?.expectedTree !== result.source.tree || canonical(adapter.nodes) !== canonical(result.nodes)) refuse('stale-input', 'checker evidence lost its exact adapter request');
  if (kernel.audit?.schema !== 'fvs-kernel-audit/result' || kernel.audit.status !== 'kernel-checked' || kernel.audit.runId !== result.runId
    || kernel.audit.targetProofsChecked !== true || kernel.authority !== 'audit-only') refuse('stale-input', 'candidate kernel evidence is foreign or incomplete');
  const wanted = result.nodes.map((node) => frozen.targets.find((t) => t.node === node)?.name);
  if (wanted.some((name) => !name) || canonical([...kernel.audit.targets].sort()) !== canonical(wanted.sort())
    || canonical(result.audit) !== canonical(kernel.audit) || result.build.source.commit !== result.source.commit
    || result.build.source.tree !== result.source.tree) refuse('stale-input', 'candidate evidence lost exact source/target coverage');
  checkKernelArtifacts(kernel);
  return result;
}

// The same artifact checks serve ordinary evidence and retained helper identity audits.
function checkKernelArtifacts(kernel) {
  verifyFiles(kernel.attempt.inputs);
  verifyFiles(Object.fromEntries(kernel.attempt.imports.flatMap((m) => m.parts.map((p) => [p.file, p.sha256]))));
  for (const row of kernel.attempt.snapshots.modules) if (hash(row.file) !== row.sha256) refuse('stale-input', 'accepted kernel input snapshot changed');
  for (const name of ['helper', 'runner']) {
    const file = kernel.attempt.snapshots[name], source = name === 'helper' ? 'FvsKernelAudit.lean' : 'fvs-checker.mjs';
    if (hash(file) !== hash(fileURLToPath(new URL(source, import.meta.url)))) refuse('stale-input', 'captured checker evidence changed');
  }
}

function dependenciesOf(context, node) {
  const found = new Set(), visit = (id) => {
    for (const dep of context.view.nodes.get(id).dependsOn) if (!found.has(dep)) { found.add(dep); visit(dep); }
  };
  visit(node); return [...found].sort((a, b) => a - b);
}

function checkBuildEvidence(result, engine, deadlineMs) {
  engine.verifyBuildImports(result.build, bound(result.kernelCheck).json.attempt.imports, deadlineMs);
}

function integrationHead(source, out, label, deadlineMs, tree = false) {
  closed(source, ['kind', 'root', 'commit', 'expectedTree'], 'integrated source');
  if (source.kind !== 'git' || !path.isAbsolute(source.root ?? '') || !isCommit(source.commit) || !isCommit(source.expectedTree)) refuse('invalid-input', 'exact integrated git source is required');
  const git = '/usr/bin/git', toolSha256 = hash(git), argv = ['rev-parse', '--verify', tree ? 'HEAD^{tree}' : 'HEAD'];
  const env = { PATH: '/usr/bin:/bin', LANG: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' };
  const run = spawnSync(git, argv, { cwd: source.root, env, encoding: 'utf8', timeout: Math.max(1, deadlineMs - Date.now()), maxBuffer: 1024 * 1024 });
  const receipt = save(out, `${label}.json`, { argv: [git, ...argv], cwd: source.root, env, toolSha256, exit: run.status, signal: run.signal,
    error: run.error?.code ?? null, stdout: run.stdout ?? '', stderr: run.stderr ?? '' });
  if (hash(git) !== toolSha256) refuse('stale-input', 'git tool changed during integrated-head validation');
  if (run.error?.code === 'ETIMEDOUT') refuse('timeout', 'integrated-head validation timed out');
  if (run.status !== 0 || run.signal || run.error || run.stdout.trim() !== (tree ? source.expectedTree : source.commit)) refuse('stale-input', 'the intended integrated commit is not the current target HEAD');
  return receipt;
}

async function acceptAuto(job, out, engine) {
  closed(job, ['schema', 'version', 'purpose', 'runId', 'deadlineMs', 'baseline', 'candidateCheck', 'source', 'node', 'store'], 'auto accept request');
  const { frozen, context } = frozenContext(job.baseline);
  if (!Number.isSafeInteger(job.node) || !context.view.union.has(job.node)) refuse('invalid-input', 'accept one known selected proof node');
  closed(job.store, ['root', 'expectedHeadSha256'], 'accepted store');
  if (!path.isAbsolute(job.store.root ?? '') || !(job.store.expectedHeadSha256 === null || isSha(job.store.expectedHeadSha256))) refuse('invalid-input', 'explicit accepted-store head is required');
  const candidate = checkEvidence(job.candidateCheck, job.baseline.sha256);
  checkBuildEvidence(candidate, engine, job.deadlineMs);
  if (!candidate.nodes.includes(job.node)) refuse('invalid-input', 'candidate check omits the selected node');
  const previous = readAcceptedStore(job.store.root);
  if (previous.headSha256 !== job.store.expectedHeadSha256) refuse('stale-input', 'accepted-store expected head is stale');
  if (previous.records.some(({ record }) => record.runId === job.runId)) refuse('stale-input', 'publication run identity has already been used');
  const dependencies = dependenciesOf(context, job.node).map((node) => {
    const accepted = previous.heads.get(node);
    if (!accepted || accepted.record.frozenSha256 !== job.baseline.sha256 || accepted.record.registryHeadSha256 !== frozen.registry.headSha256) refuse('stale-input', `helper ${node} lacks a current accepted receipt`);
    checkBuildEvidence(checkEvidence(accepted.record.integratedCheck, job.baseline.sha256), engine, job.deadlineMs);
    return { node, sha256: accepted.sha256 };
  });
  exclusive(out);
  const requestInput = captureInput(job, out, engine);
  const headBefore = integrationHead(job.source, out, 'integration-head-before', job.deadlineMs);
  const integrated = await checkAuto({ schema: 'fvs-checker/check-request', version: 1, purpose: 'auto', runId: `${job.runId}-integrated`, deadlineMs: job.deadlineMs,
    baseline: job.baseline, source: job.source, nodes: [job.node, ...dependencies.map((d) => d.node)] }, path.join(out, 'integrated'), engine);
  const reuseChecks = [];
  for (const dependency of dependencies) {
    const old = checkEvidence(previous.heads.get(dependency.node).record.integratedCheck, job.baseline.sha256);
    const target = frozen.targets.find((t) => t.node === dependency.node);
    const request = kernelRequest({ runId: `${job.runId}-reuse-${dependency.node}`, deadlineMs: job.deadlineMs }, integrated.build, old.build.modules,
      [{ ...target, expectedName: target.name }], context, [dependency.node]);
    request.proofIdentityRoots = [target.name];
    const ref = save(out, `helper-${dependency.node}-request.json`, request);
    const checked = engine.runKernelAudit({ request: ref.file, out: path.join(out, `helper-${dependency.node}-identity`) });
    reuseChecks.push(checked.evidence);
  }
  const recordsDir = path.join(job.store.root, 'records'); fs.mkdirSync(recordsDir, { recursive: true });
  const locks = [], lock = (root) => {
    const file = path.join(root, 'lock');
    try { fs.mkdirSync(file); } catch (e) { if (e.code === 'EEXIST') refuse('stale-input', 'another publication holds an expected-head lock'); throw e; }
    locks.push(file);
  };
  let writing = false, completed = false;
  try {
    lock(job.store.root); lock(frozen.registry.root);
    frozenContext(job.baseline, { ignoreRegistryLock: true });
    const current = readAcceptedStore(job.store.root, { ignoreLock: true });
    if (current.headSha256 !== job.store.expectedHeadSha256) refuse('stale-input', 'accepted-store head changed during integrated checking');
    if (current.records.some(({ record }) => record.runId === job.runId)) refuse('stale-input', 'publication run identity has already been used');
    for (const dep of dependencies) if (current.heads.get(dep.node)?.sha256 !== dep.sha256) refuse('stale-input', 'accepted helper changed during integrated checking');
    checkBuildEvidence(checkEvidence(job.candidateCheck, job.baseline.sha256), engine, job.deadlineMs);
    checkBuildEvidence(checkEvidence(integrated.evidence, job.baseline.sha256), engine, job.deadlineMs);
    for (const dep of dependencies) checkBuildEvidence(checkEvidence(current.heads.get(dep.node).record.integratedCheck, job.baseline.sha256), engine, job.deadlineMs);
    const headAtPublication = integrationHead(job.source, out, 'integration-head-publication', job.deadlineMs);
    beforeDeadline(job);
    const record = { schema: 'fvs-checker/accepted-event', version: 1, authority: 'canonical-checker', seq: current.records.length, prev: current.headSha256,
      runId: job.runId, node: job.node, frozenSha256: job.baseline.sha256, baseline: job.baseline, registryHeadSha256: frozen.registry.headSha256,
      contract: frozen.records[job.node].sha256, candidate: candidate.source, integrated: integrated.source,
      extractionSourceCommit: frozen.extractionSourceCommit, dependencies, candidateCheck: job.candidateCheck, integratedCheck: integrated.evidence,
      helperIdentityChecks: reuseChecks, integratedHeadChecks: [headBefore, headAtPublication], ...requestInput, assumptions: frozen.records[job.node].contract.assumptions,
      policy: { axioms: ['propext', 'Classical.choice', 'Quot.sound'], projectReplay: 'all-required', expectedIdentity: 'Expr.equal' }, durability: 'process-crash-consistent' };
    const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`), digest = sha(bytes), temporary = path.join(job.store.root, `.tmp-${process.pid}-${digest}`);
    const fd = fs.openSync(temporary, 'wx'); writing = true;
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const file = path.join(recordsDir, `${String(record.seq).padStart(6, '0')}-${digest}.json`);
    fs.renameSync(temporary, file);
    const dir = fs.openSync(recordsDir, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    completed = true;
    return { code: 'ok', schema: 'fvs-checker/accept-result', version: 1, purpose: 'auto', authority: 'canonical-checker', status: 'accepted',
      acceptedReceipt: { file, sha256: digest }, integratedCheck: integrated.evidence, node: job.node };
  } finally {
    if (!writing || completed) for (const file of locks.reverse()) fs.rmdirSync(file);
  }
}

async function checkAuto(job, out, engine) {
  closed(job, ['schema', 'version', 'purpose', 'runId', 'deadlineMs', 'baseline', 'source', 'nodes'], 'auto check request');
  const { frozen, job: original, context } = frozenContext(job.baseline);
  if (!Array.isArray(job.nodes) || !job.nodes.length || new Set(job.nodes).size !== job.nodes.length || job.nodes.some((id) => !context.view.union.has(id))) refuse('invalid-input', 'select known distinct proof nodes');
  closed(job.source, ['kind', 'root', 'commit', 'expectedTree'], 'candidate source');
  if (job.source.kind !== 'git' || !isCommit(job.source.commit) || !isCommit(job.source.expectedTree)) refuse('invalid-input', 'candidate commit and exact tree are required');
  exclusive(out);
  const requestInput = captureInput(job, out, engine);
  const candidateInventory = sourceInventory(job.source, job.deadlineMs, out, 'candidate-source');
  const proofModules = frozen.overlayFiles.filter((file) => candidateInventory.files.includes(file)).map((file) => overlayModule(file, original.baseline.sourceRoot)).filter(Boolean);
  const libraries = [...new Set([...(original.baseline.libraries ?? []), ...proofModules])];
  const build = await buildSnapshot({ ...original.baseline, ...(libraries.length ? { libraries } : {}), deadlineMs: job.deadlineMs }, job.source, path.join(out, 'candidate-build'), `${job.runId}-build`);
  const files = sourceHashes(build), baseline = sourceHashes(frozen.build);
  for (const [rel, digest] of Object.entries(baseline)) if (!frozen.overlayFiles.includes(rel) && files[rel] !== digest) refuse('stale-input', `protected baseline input changed: ${rel}`);
  for (const rel of Object.keys(files)) if (!Object.hasOwn(baseline, rel) && !frozen.overlayFiles.includes(rel)) refuse('stale-input', `unrecorded candidate source: ${rel}`);
  const kernel = kernelRequest(job, build, frozen.references, frozen.targets, context, job.nodes);
  const request = save(out, 'kernel-request.json', kernel);
  const checked = engine.runKernelAudit({ request: request.file, out: path.join(out, 'kernel-check') });
  engine.verifyBuildImports(build, checked.attempt.imports, job.deadlineMs);
  const observed = Object.fromEntries(checked.attempt.imports.filter((m) => !m.project).flatMap((m) => m.parts.map((p) => [p.file, p.sha256])));
  // A builder may use an owned dependency copy at a different path. Bind names,
  // ordered parts and bytes, rather than accepting a caller's dependency label.
  const external = (audit) => audit.filter((m) => !m.project).map((m) => [m.name, m.parts.map((p) => p.sha256)]).sort(([a], [b]) => a.localeCompare(b));
  const baselineAudit = bound(frozen.meaningCheck).json;
  if (canonical(external(checked.attempt.imports)) !== canonical(external(baselineAudit.attempt.imports)) || canonical(checked.attempt.runtimes) !== canonical(frozen.runtimes)) refuse('stale-input', 'resolved dependency/runtime identity changed since freeze');
  frozenContext(job.baseline); verifyFiles(buildFiles(build)); verifyFiles(observed); beforeDeadline(job);
  const result = { schema: 'fvs-checker/auto-check', version: 1, purpose: 'auto', authority: 'provisional-only', status: 'provisional', code: 'ok', runId: job.runId,
    nodes: job.nodes, baseline: job.baseline, frozenSha256: job.baseline.sha256, registryHeadSha256: frozen.registry.headSha256,
    source: { commit: build.source.commit, tree: build.source.tree }, extractionSourceCommit: frozen.extractionSourceCommit,
    records: frozen.records, ...requestInput, build, kernelCheck: checked.evidence, audit: checked.audit };
  return { ...result, evidence: save(out, 'result.json', result) };
}

// This reads immutable history. accept additionally validates the current
// freeze/registry context and the source/compiler snapshots before publication.
export function readAcceptedStore(root, { ignoreLock = false } = {}) {
  if (!fs.existsSync(root)) return { records: [], heads: new Map(), headSha256: null };
  if ((!ignoreLock && fs.existsSync(path.join(root, 'lock'))) || fs.readdirSync(root).some((n) => n.startsWith('.tmp-'))) refuse('stale-input', 'accepted store is pending');
  const dir = path.join(root, 'records'), names = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  const records = [], heads = new Map(); let previous = null;
  for (const [index, name] of names.entries()) {
    const match = /^(\d{6})-([0-9a-f]{64})\.json$/.exec(name), file = path.join(dir, name), bytes = fs.readFileSync(file), record = json(bytes);
    if (!match || Number(match[1]) !== index || sha(bytes) !== match[2] || record.schema !== 'fvs-checker/accepted-event' || record.version !== 1
      || record.seq !== index || record.prev !== previous || record.authority !== 'canonical-checker' || !Number.isSafeInteger(record.node)
      || !isSha(record.frozenSha256) || !isSha(record.registryHeadSha256) || !isCommit(record.integrated?.commit) || !isCommit(record.integrated?.tree)
      || !isCommit(record.candidate?.commit) || !isCommit(record.candidate?.tree) || !Array.isArray(record.dependencies)
      || record.dependencies.some((d) => !object(d) || !Number.isSafeInteger(d.node) || d.node < 0 || d.node === record.node || !isSha(d.sha256))
      || new Set(record.dependencies.map((d) => d.node)).size !== record.dependencies.length) refuse('stale-input', 'accepted store chain is corrupt or foreign');
    const frozen = bound(record.baseline).json;
    if (record.baseline.sha256 !== record.frozenSha256 || frozen.schema !== 'fvs-checker/auto-baseline' || frozen.purpose !== 'auto'
      || frozen.registry.headSha256 !== record.registryHeadSha256 || frozen.records[record.node]?.sha256 !== record.contract
      || canonical(record.policy) !== canonical({ axioms: ['propext', 'Classical.choice', 'Quot.sound'], projectReplay: 'all-required', expectedIdentity: 'Expr.equal' })) refuse('stale-input', 'accepted record has foreign contract/policy bindings');
    if (!Array.isArray(record.integratedHeadChecks) || record.integratedHeadChecks.length !== 2) refuse('stale-input', 'accepted record lacks integrated-head checks');
    for (const ref of record.integratedHeadChecks) {
      const head = bound(ref).json;
      if (head.exit !== 0 || head.signal || head.error || head.stdout?.trim() !== record.integrated.commit || !isSha(head.toolSha256)) refuse('stale-input', 'accepted record has foreign integrated-head evidence');
    }
    for (const ref of [record.candidateCheck, record.integratedCheck]) {
      const checked = checkEvidence(ref, record.frozenSha256);
      if (checked.schema !== 'fvs-checker/auto-check' || checked.status !== 'provisional' || checked.frozenSha256 !== record.frozenSha256
        || checked.source?.commit !== (ref === record.integratedCheck ? record.integrated.commit : record.candidate.commit)
        || checked.source?.tree !== (ref === record.integratedCheck ? record.integrated.tree : record.candidate.tree)
        || !checked.nodes.includes(record.node)) refuse('stale-input', 'accepted event lacks its exact checker evidence');
    }
    for (const dep of record.dependencies) if (heads.get(dep.node)?.sha256 !== dep.sha256) refuse('stale-input', 'accepted dependency is not the current predecessor');
    const row = { record, sha256: match[2], file }; records.push(row); heads.set(record.node, row); previous = row.sha256;
  }
  if (!ignoreLock && fs.existsSync(path.join(root, 'lock'))) refuse('stale-input', 'accepted store lock appeared');
  return { records, heads, headSha256: previous };
}

// Relational currentness AFTER immutable-history validation, not a receipt
// producer. Kept narrow so C1/C2 and superseded-helper cases need no compiler.
export function currentAcceptedRows(history, { selection, source, frozenSha256, registryHeadSha256 }) {
  const latest = history.records.at(-1);
  if (!latest || !selection.has(latest.record.node)) refuse('stale-input', 'latest accepted baseline is outside the requested selected context');
  const rows = [...history.heads].filter(([node]) => selection.has(node)).map(([, row]) => row);
  if (!rows.length || !rows.some((row) => row.sha256 === latest.sha256)) refuse('stale-input', 'accepted history has no selected baseline');
  for (const row of rows) {
    const record = row.record;
    if (record.integrated.commit !== source.commit || record.integrated.tree !== source.expectedTree) refuse('stale-input', `node ${record.node} integrated source is older/different; fresh checker recheck required`);
    if (record.frozenSha256 !== frozenSha256 || record.registryHeadSha256 !== registryHeadSha256) refuse('stale-input', `node ${record.node} has a foreign current context`);
    for (const dep of record.dependencies) {
      if (!selection.has(dep.node) || history.heads.get(dep.node)?.sha256 !== dep.sha256) refuse('stale-input', `node ${record.node} depends on a superseded helper receipt; fresh checker recheck required`);
    }
  }
  return rows;
}

// Resume inspects currentness, never builds or publishes a proof. Historical
// chain validity alone cannot clear a current freeze/registry/import mismatch.
export function inspectAutoAcceptance({ baseline, store, source, deadlineMs, out }) {
  closed(store, ['root', 'expectedHeadSha256'], 'accepted store inspection');
  if (!path.isAbsolute(store.root ?? '') || !(store.expectedHeadSha256 === null || isSha(store.expectedHeadSha256))) refuse('invalid-input', 'explicit accepted-store head is required');
  beforeDeadline({ deadlineMs });
  const history = readAcceptedStore(store.root);
  if (history.headSha256 !== store.expectedHeadSha256) refuse('stale-input', 'accepted-store head changed');
  if (!history.records.length) {
    const current = baseline === null ? null : frozenContext(baseline);
    return { status: 'not-established', acceptedBaseline: null, storeHeadSha256: null, nodes: [], registry: current?.frozen.registry ?? null,
      inputs: current ? { extraction: current.job.extraction.identity, graph: current.job.extraction.graph, plan: current.job.extraction.plan } : null };
  }
  if (baseline === null) refuse('stale-input', 'accepted history requires its exact current frozen context');
  const { frozen, context, job } = frozenContext(baseline);
  const currentRows = currentAcceptedRows(history, { selection: context.view.union, source, frozenSha256: baseline.sha256, registryHeadSha256: frozen.registry.headSha256 });
  exclusive(out);
  integrationHead(source, out, 'inspection-head-before', deadlineMs);
  integrationHead(source, out, 'inspection-tree-before', deadlineMs, true);
  const latest = history.records.at(-1).record;
  if (latest.integrated.commit !== source.commit || latest.integrated.tree !== source.expectedTree) refuse('stale-input', 'accepted integrated source differs; a fresh checker recheck is required');
  const nodes = [];
  for (const row of currentRows) {
    const record = row.record, node = record.node;
    if (record.frozenSha256 !== baseline.sha256 || record.registryHeadSha256 !== frozen.registry.headSha256 || record.contract !== frozen.records[node]?.sha256) refuse('stale-input', 'accepted node is stale under the current freeze/registry');
    checkBuildEvidence(checkEvidence(record.integratedCheck, baseline.sha256), { verifyBuildImports }, deadlineMs);
    if (!Array.isArray(record.helperIdentityChecks) || record.helperIdentityChecks.length !== record.dependencies.length) refuse('stale-input', 'accepted helper identity evidence is missing');
    for (const [index, dependency] of record.dependencies.entries()) {
      const kernel = bound(record.helperIdentityChecks[index]).json, target = frozen.targets.find((t) => t.node === dependency.node);
      if (!target || kernel.authority !== 'audit-only' || kernel.audit?.status !== 'kernel-checked' || kernel.audit.targetProofsChecked !== true
        || kernel.audit.runId !== `${record.runId}-reuse-${dependency.node}` || kernel.attempt?.runId !== kernel.audit.runId
        || canonical(kernel.audit.targets) !== canonical([target.name])) refuse('stale-input', 'accepted helper identity evidence is foreign');
      checkKernelArtifacts(kernel);
      verifyBuildImports(checkEvidence(record.integratedCheck, baseline.sha256).build, kernel.attempt.imports, deadlineMs);
    }
    nodes.push({ node, receipt: { file: row.file, sha256: row.sha256 }, integrated: record.integrated });
  }
  frozenContext(baseline);
  if (readAcceptedStore(store.root).headSha256 !== history.headSha256) refuse('stale-input', 'accepted store changed during inspection');
  integrationHead(source, out, 'inspection-head-after', deadlineMs);
  integrationHead(source, out, 'inspection-tree-after', deadlineMs, true);
  beforeDeadline({ deadlineMs });
  return { status: 'current', acceptedBaseline: latest.integrated, storeHeadSha256: history.headSha256, nodes: nodes.sort((a, b) => a.node - b.node), registry: frozen.registry,
    inputs: { extraction: job.extraction.identity, graph: job.extraction.graph, plan: job.extraction.plan } };
}

export async function runAuto(command, { request, out }, engine) {
  const bytes = fs.readFileSync(request), job = json(bytes);
  engine = { ...engine, controllerInput: { file: path.resolve(request), sha256: sha(bytes), bytes } };
  if (!object(job) || job.schema !== `fvs-checker/${command === 'accept' ? 'accept' : command}-request` || job.version !== 1 || job.purpose !== 'auto') refuse('invalid-input', 'expected a complete extraction-bound auto request');
  beforeDeadline(job);
  if (typeof job.runId !== 'string' || !job.runId) refuse('invalid-input', 'unique controller run identity is required');
  if (command === 'freeze') return freezeAuto(job, out, engine);
  if (command === 'check') return checkAuto(job, out, engine);
  if (command === 'accept') return acceptAuto(job, out, engine);
  refuse('invalid-input', 'unsupported auto command');
}
