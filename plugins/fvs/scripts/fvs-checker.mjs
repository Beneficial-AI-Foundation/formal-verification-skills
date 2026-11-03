#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { requestControl, assertRunning, timeoutOptions, executionFields, runOwned, withProcessCancellation, sameExecutionPolicy, conclusiveOwnedSupervision, executionScopeTool } from './fvs-execution.mjs';

class Refusal extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const refuse = (code, message) => { throw new Refusal(code, message); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const EXIT = { ok: 0, usage: 2, internal: 2, 'audit-failed': 4, 'invalid-input': 5, unsupported: 6, 'baseline-unavailable': 6, 'stale-input': 7, timeout: 8, cancelled: 130, 'execution-invalid': 5, 'execution-uncertain': 6 };
const HELPER = fileURLToPath(new URL('./FvsKernelAudit.lean', import.meta.url));
const SCRIPT = fileURLToPath(import.meta.url);
const EXECUTION = fileURLToPath(new URL('./fvs-execution.mjs', import.meta.url));
const EXECUTION_DATA = fileURLToPath(new URL('./fvs-project-memory.mjs', import.meta.url));
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const textList = (a) => Array.isArray(a) && a.every((s) => typeof s === 'string' && s.length > 0);

function nativeRuntimeFiles(lean) {
  const toolchain = path.dirname(path.dirname(fs.realpathSync(lean))), files = [];
  for (const dir of [path.join(toolchain, 'lib'), path.join(toolchain, 'lib/lean')]) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (!entry.isDirectory() && /\.(dylib|dll|so(?:\.\d+)*)$/.test(entry.name)) files.push(fs.realpathSync(path.join(dir, entry.name)));
  }
  return [...new Set(files)].sort();
}

function importedParts(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.some((m) => !object(m) || typeof m.name !== 'string' || typeof m.project !== 'boolean'
    || !textList(m.parts) || !m.parts.length || !m.parts.every((p) => path.isAbsolute(p))) || new Set(rows.map((m) => m.name)).size !== rows.length) refuse('audit-failed', 'malformed resolved import inventory');
  return rows.map((m) => ({ name: m.name, project: m.project, parts: m.parts.map((file) => ({ file, sha256: sha(fs.readFileSync(file)) })) })).sort((a, b) => a.name.localeCompare(b.name));
}

function verifyParts(imports) {
  for (const m of imports) for (const p of m.parts) if (sha(fs.readFileSync(p.file)) !== p.sha256) refuse('stale-input', `resolved import changed: ${m.name} ${p.file}`);
}

function retainResult(out, result) {
  const file = path.resolve(out, 'result.json');
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  return { ...result, evidence: { file, sha256: sha(fs.readFileSync(file)) } };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }
  catch (error) { return refuse('invalid-input', `unreadable JSON input: ${error.message}`); }
}

function helperFailure(run, label) {
  let error;
  try { error = JSON.parse(run.stdout); } catch {}
  if (error?.schema === 'fvs-checker/helper-error' && error.status === 'unverified' && error.code === 'unsupported') refuse('unsupported', error.error);
  refuse('audit-failed', `${label}: ${run.stdout ?? ''}${run.stderr ?? ''}`);
}

const moduleName = (s) => typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9_']*(\.[A-Za-z_][A-Za-z0-9_']*)*$/.test(s);
const relativeFile = (s) => typeof s === 'string' && s.length > 0 && !path.isAbsolute(s) && !s.includes('\\') && !s.split('/').some((p) => !p || p === '.' || p === '..');

function projectFiles(root) {
  const files = {};
  const walk = (dir, prefix = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['.git', '.lake', '.formalising', '.planning', '.scratch', 'node_modules', 'target'].includes(e.name)) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name, full = path.join(dir, e.name);
      if (e.isSymbolicLink()) refuse('unsupported', `unsealed project symlink ${rel}`);
      if (e.isDirectory()) walk(full, rel);
      else if (e.isFile() && (rel.endsWith('.lean') || ['lakefile.toml', 'lean-toolchain', 'lake-manifest.json'].includes(rel))) files[rel] = sha(fs.readFileSync(full));
    }
  };
  walk(root); return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

// Source tokens are used only for the explicitly supported declaration-header
// profile; Lean and fresh .ilean data supply types, identities and source spans.
export function tokens(source, keepComments = false) {
  const out = []; let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) { i++; continue; }
    if (source.startsWith('--', i)) { const start = i, end = source.indexOf('\n', i); i = end < 0 ? source.length : end; if (keepComments) out.push({ text: source.slice(start, i), start, end: i }); continue; }
    if (source.startsWith('/-', i)) {
      const start = i; let depth = 1; i += 2;
      while (i < source.length && depth) {
        if (source.startsWith('/-', i)) { depth++; i += 2; }
        else if (source.startsWith('-/', i)) { depth--; i += 2; } else i++;
      }
      if (depth) refuse('unsupported', 'unfinished source comment'); if (keepComments) out.push({ text: source.slice(start, i), start, end: i }); continue;
    }
    const start = i;
    if (source[i] === '"') {
      i++;
      while (i < source.length && source[i] !== '"') { if (source[i] === '\\') i++; i++; }
      if (i >= source.length) refuse('unsupported', 'unfinished source string'); i++;
    } else if (source.startsWith(':=', i)) i += 2;
    else if (/[A-Za-z_]/.test(source[i])) { i++; while (i < source.length && /[A-Za-z0-9_']/.test(source[i])) i++; }
    else i++;
    out.push({ text: source.slice(start, i), start, end: i });
  }
  return out;
}

function offset(source, line, column) {
  if (!Number.isSafeInteger(line) || line < 0 || !Number.isSafeInteger(column) || column < 0) refuse('unsupported', 'malformed source range');
  const lines = source.split('\n');
  if (line >= lines.length || column > lines[line].length) refuse('unsupported', 'source range is outside the captured file');
  return lines.slice(0, line).reduce((n, s) => n + s.length + 1, 0) + column;
}

function declaration(source, range, name) {
  if (!Array.isArray(range) || range.length !== 8) refuse('unsupported', `unsupported declaration range ${name}`);
  const start = offset(source, range[0], range[1]), end = offset(source, range[2], range[3]);
  if (end <= start) refuse('unsupported', 'empty or reversed declaration range');
  const ts = tokens(source.slice(start, end)); let depth = 0, kind = null, bodyStart = null;
  const kinds = ['theorem', 'lemma', 'def', 'abbrev', 'opaque', 'axiom', 'structure', 'inductive', 'class', 'instance'];
  for (const t of ts) {
    if (['(', '[', '{', '⟨', '⦃'].includes(t.text)) depth++;
    else if ([')', ']', '}', '⟩', '⦄'].includes(t.text)) depth--;
    if (depth < 0) refuse('unsupported', 'ambiguous declaration scope');
    if (depth === 0 && !kind && kinds.includes(t.text)) kind = t.text;
    if (kind && depth === 0 && ['let', 'do', 'by', 'where'].includes(t.text) && ['theorem', 'lemma'].includes(kind)) refuse('unsupported', 'unsupported unparenthesized theorem header');
    if (kind && depth === 0 && t.text === ':=') { bodyStart = start + t.end; break; }
  }
  if (!kind || (['theorem', 'lemma'].includes(kind) && bodyStart === null)) refuse('unsupported', `unsupported source declaration ${name}`);
  return { name, kind, start, end, bodyStart, header: bodyStart === null ? null : source.slice(start, bodyStart) };
}

async function standaloneBuild({ job, root, sourceRoot, files, profile = null, baseline = false, services = {} }) {
  const programs = Object.keys(files).filter((f) => f.endsWith('.lean') && f !== 'lakefile.lean');
  if (!profile && (programs.length !== 1 || files['lakefile.lean'] || files['lakefile.toml'])) refuse('unsupported', 'a configured pre-edit build needs its pinned Lake/dependency profile');
  if (profile && (!object(profile) || Object.keys(profile).some((k) => !['lake', 'libraries', 'sourceRoot', 'dependencies'].includes(k)))) refuse('invalid-input', 'unknown standalone build profile field');
  const { buildCheckerSnapshot } = await import('./fvs-checker-build.mjs');
  const result = await buildCheckerSnapshot({ schema: 'fvs-checker/build-request', ...executionFields(job), runId: `${job.runId}-build`, purpose: 'standalone',
    source: { kind: 'worktree', root: sourceRoot, files: Object.keys(files) }, out: path.join(root, 'project-build'), lean: job.lean,
    ...(profile ?? {}) }, services);
  if (result.status === 'cancelled') refuse('cancelled', result.reason);
  if (result.status !== 'built') refuse(result.status === 'unsupported' ? 'unsupported' : result.receipts?.some((r) => r.timedOut) || /deadline/i.test(result.reason ?? '') ? 'timeout' : baseline ? 'baseline-unavailable' : 'audit-failed', result.reason ?? 'fresh standalone build did not complete');
  if (result.schema !== 'fvs-checker/build-result' || result.version !== job.version || result.runId !== `${job.runId}-build` || result.authority !== 'build-only'
    || result.proofChecked !== false) refuse('audit-failed', 'incomplete standalone build evidence');
  if(job.version===2&&!sameExecutionPolicy(result.execution,job.execution))refuse('audit-failed','standalone build execution policy changed');
  const selected = result.modules.filter((m) => m.source === job.specFile);
  if (selected.length !== 1) refuse('unsupported', 'the spec does not map to one freshly built module');
  const file = path.join(root, 'snapshot-build.json'); fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  return { ...result, selected: selected[0] };
}

const externalIdentity = (imports) => imports.filter((m) => !m.project).map((m) => [m.name, m.parts.map((p) => p.sha256)]).sort(([a], [b]) => a.localeCompare(b));

// Bind observations to the compiler's actual imports, not merely to a set of
// directories containing plausible modules with the same names.
export function verifyBuildImports(build, imports, deadlineMs = Infinity) {
  const sealed = (ref) => {
    if (!object(ref) || !path.isAbsolute(ref.file ?? '') || !/^[0-9a-f]{64}$/.test(ref.sha256 ?? '')) refuse('invalid-input', 'missing bound build inventory');
    const bytes = fs.readFileSync(ref.file);
    if (sha(bytes) !== ref.sha256) refuse('stale-input', 'build inventory changed');
    try { return JSON.parse(bytes); } catch { return refuse('invalid-input', 'malformed build inventory'); }
  };
  const outputs = sealed(build.inventories.outputs), runtime = sealed(build.lean.runtime), deps = sealed(build.dependencies.before), source = sealed(build.inventories.source);
  if (!object(outputs.externalFiles) || !object(outputs.externalRoots) || !object(runtime.files) || !object(deps)) refuse('invalid-input', 'incomplete compiler dependency inventories');
  if (!object(outputs.files) || outputs.root !== build.buildRoot || JSON.stringify(source) !== JSON.stringify(build.source)) refuse('invalid-input', 'inconsistent source/output build inventory');
  for (const [root, files] of [[build.projectRoot, source.files], [build.buildRoot, outputs.files]]) {
    if (!path.isAbsolute(root ?? '') || !object(files)) refuse('invalid-input', 'incomplete build snapshot');
    for (const [rel, expected] of Object.entries(files)) {
      if (typeof deadlineMs === 'number') { if (Date.now() >= deadlineMs) refuse('timeout', 'build snapshot validation deadline is exhausted'); } else assertRunning(deadlineMs);
      if (!relativeFile(rel) || !object(expected)) refuse('invalid-input', 'malformed build snapshot entry');
      const file = path.join(root, rel), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(file) !== file || stat.size !== expected.size || sha(fs.readFileSync(file)) !== expected.sha256) refuse('stale-input', `source/compiler output changed: ${rel}`);
    }
  }
  const owned = build.dependencies.owned?.root;
  const inside = (root, file) => typeof root === 'string' && file.startsWith(`${root}${path.sep}`);
  for (const module of imports.filter((m) => !m.project)) {
    if (typeof deadlineMs === 'number') { if (Date.now() >= deadlineMs) refuse('timeout', 'dependency validation deadline is exhausted'); } else assertRunning(deadlineMs);
    const headers = [...new Set(Object.keys(outputs.externalRoots).map((root) => path.join(root, `${module.name.replaceAll('.', '/')}.olean`))
      .filter((file) => Object.hasOwn(outputs.externalFiles, file)))];
    if (headers.length > 1 || (headers.length === 1 && headers[0] !== module.parts[0]?.file)) refuse('stale-input', `witness/compiler import origin mismatch: ${module.name}`);
    for (const part of module.parts) {
      const expected = outputs.externalFiles[part.file] ?? (inside(runtime.root, part.file) ? runtime.files[path.relative(runtime.root, part.file)]
        : inside(owned, part.file) ? deps[path.relative(owned, part.file)] : null);
      if (!expected || expected.symlink !== undefined || expected.sha256 !== part.sha256 || sha(fs.readFileSync(part.file)) !== part.sha256) refuse('stale-input', `unbound compiler dependency part: ${module.name} ${part.file}`);
    }
  }
}

export async function freeze({ request, out }, services = {}) {
  const job = readJson(request);
  const keys = ['schema', 'version', 'purpose', 'runId', 'projectRoot', 'specFile', 'lean', job?.version === 2 ? 'execution' : 'deadlineMs', 'externalSearchPaths', 'externalImports', 'build'];
  if (!object(job) || Object.keys(job).some((k) => !keys.includes(k)) || job.schema !== 'fvs-checker/freeze-request' || ![1, 2].includes(job.version) || job.purpose !== 'standalone'
    || typeof job.runId !== 'string' || !job.runId || typeof job.projectRoot !== 'string' || !path.isAbsolute(job.projectRoot)
    || !relativeFile(job.specFile) || !job.specFile.endsWith('.lean') || !moduleName(job.specFile.slice(0, -5).replaceAll('/', '.'))
    || !object(job.lean) || typeof job.lean.path !== 'string' || !path.isAbsolute(job.lean.path) || !/^[0-9a-f]{64}$/.test(job.lean.sha256 ?? '')
    || !Array.isArray(job.externalSearchPaths) || !job.externalSearchPaths.every((p) => typeof p === 'string' && path.isAbsolute(p))
    || !textList(job.externalImports)) refuse('invalid-input', 'expected a complete standalone freeze request');
  const control = requestControl(job); assertRunning(control, services);
  if (job.externalSearchPaths.length) refuse('unsupported', 'standalone external libraries require the frozen build profile; ad hoc import caches are unsupported');
  if (sha(fs.readFileSync(job.lean.path)) !== job.lean.sha256) refuse('stale-input', 'the Lean executable differs from the controller binding');
  const files = projectFiles(job.projectRoot);
  if (!files[job.specFile]) refuse('invalid-input', 'selected spec is not a captured project source');
  try { fs.mkdirSync(out); } catch (e) { refuse('invalid-input', `exclusive baseline output unavailable: ${e.code}`); }
  const root = fs.realpathSync(out), sourceRoot = path.join(root, 'source');
  fs.mkdirSync(sourceRoot);
  for (const [rel, digest] of Object.entries(files)) {
    const file = path.join(sourceRoot, rel); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.join(job.projectRoot, rel), file, fs.constants.COPYFILE_EXCL);
    if (sha(fs.readFileSync(file)) !== digest) refuse('stale-input', 'project changed while taking the pre-edit snapshot');
  }
  const built = await standaloneBuild({ job, root, sourceRoot, files, profile: job.build, baseline: true, services });
  const mod = built.selected.name;
  const source = fs.readFileSync(path.join(sourceRoot, job.specFile), 'utf8'), ilean = readJson(built.selected.ilean);
  if (ilean.version !== 5 || ilean.module !== mod || !object(ilean.decls)) refuse('baseline-unavailable', 'unsupported pre-edit declaration inventory');
  const declarations = Object.entries(ilean.decls).map(([name, range]) => declaration(source, range, name));
  const targets = declarations.filter((d) => ['theorem', 'lemma'].includes(d.kind)).map((d) => ({ name: d.name, expectedName: d.name }));
  if (!targets.length) refuse('baseline-unavailable', 'the pre-edit file has no supported declared theorem inventory');
  const kernelJob = { schema: 'fvs-checker/kernel-request', ...executionFields(job), runId: `${job.runId}-meaning`, lean: job.lean,
    externalSearchPaths: built.externalSearchPaths, externalImports: built.externalImports,
    modules: built.modules.map(({ name, parts }) => ({ name, parts })), referenceModules: built.modules.map(({ name, parts }) => ({ name, parts })), targets,
    meaningRoots: declarations.filter((d) => !['theorem', 'lemma', 'axiom'].includes(d.kind)).map((d) => d.name),
    theoremInventory: { module: mod, names: targets.map((t) => t.name) } };
  const kernelRequest = path.join(root, 'meaning-request.json'); fs.writeFileSync(kernelRequest, `${JSON.stringify(kernelJob)}\n`, { flag: 'wx' });
  let meaning;
  try { meaning = await (job.version === 2 ? runKernelAuditV2 : runKernelAudit)({ request: kernelRequest, out: path.join(root, 'meaning-check') }, { ...services, baseline: true }); }
  catch (e) { if (job.version === 2 && ['cancelled', 'timeout'].includes(e.code)) throw e; refuse('baseline-unavailable', `pre-edit meaning/type baseline is unavailable: ${e.message}`); }
  verifyBuildImports(built, meaning.attempt.imports, control);
  const actualKinds = new Map(meaning.witness.declarations.map((d) => [d.name, d.kind]));
  for (const d of declarations) if (['theorem', 'lemma'].includes(d.kind) !== (actualKinds.get(d.name) === 'theorem')) {
    refuse('baseline-unavailable', `ambiguous source-to-theorem inventory ${d.name}`);
  }
  if (JSON.stringify(projectFiles(job.projectRoot)) !== JSON.stringify(files)) refuse('stale-input', 'the project changed during pre-edit baseline capture');
  const compiled = Object.fromEntries(built.modules.flatMap((m) => [...m.parts, m.parts[0].replace(/\.olean$/, '.ir'), m.ilean]).filter((p) => fs.existsSync(p)).map((p) => [path.relative(root, p).split(path.sep).join('/'), sha(fs.readFileSync(p))]));
  const checker = { scriptSha256: sha(fs.readFileSync(SCRIPT)), helperSha256: sha(fs.readFileSync(HELPER)), nodeSha256: sha(fs.readFileSync(process.execPath)),
    buildSha256: sha(fs.readFileSync(fileURLToPath(new URL('./fvs-checker-build.mjs', import.meta.url)))),
    policy: Object.fromEntries(['fvs-probe-inventory.mjs', 'fvs-probe-linux.mjs', 'fvs-execution.mjs', 'fvs-project-memory.mjs'].map((name) => {
      const file = fileURLToPath(new URL(name, import.meta.url)); return [file, sha(fs.readFileSync(file))];
    })) };
  const externalBindings = Object.fromEntries(meaning.attempt.imports.filter((m) => !m.project).flatMap((m) => m.parts.map((p) => [p.file, p.sha256])).sort(([a], [b]) => a.localeCompare(b)));
  const record = { schema: 'fvs-checker/standalone-baseline', version: job.version, purpose: 'standalone', authority: 'audit-only', bindingLevel: 'resolved-inputs',
    runId: job.runId, projectRoot: fs.realpathSync(job.projectRoot), specFile: job.specFile, files, declarations, targets, module: mod, compiled, checker,
    modules: kernelJob.modules.map((m) => ({ name: m.name, parts: m.parts.map((p) => path.relative(root, p).split(path.sep).join('/')) })), meaningRoots: kernelJob.meaningRoots,
    lean: job.lean, buildProfile: job.build ?? null, externalSearchPaths: built.externalSearchPaths, externalImports: built.externalImports,
    externalBindings, externalIdentity: externalIdentity(meaning.attempt.imports), runtimeBindings: meaning.attempt.runtimes, meaning: meaning.audit };
  if(job.version===2){record.execution=job.execution;record.meaningCheck=meaning.evidence;assertRunning(control,services);}
  const file = path.join(root, 'frozen.json'); fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  return { code: 'ok', authority: 'audit-only', baseline: { file, sha256: sha(fs.readFileSync(file)) }, targetProofsChecked: false };
}

export async function check({ request, out }, services = {}) {
  const job = readJson(request);
  if (!object(job) || job.schema !== 'fvs-checker/check-request' || ![1, 2].includes(job.version)) {
    refuse('invalid-input', 'expected a controller-owned fvs-checker/check-request version 1');
  }
  const keys = ['schema', 'version', 'purpose', 'runId', 'baseline', 'projectRoot', job.version === 2 ? 'execution' : 'deadlineMs'];
  if (Object.keys(job).some((k) => !keys.includes(k)) || job.purpose !== 'standalone' || typeof job.runId !== 'string' || !job.runId
    || !object(job.baseline) || typeof job.baseline.file !== 'string' || !path.isAbsolute(job.baseline.file) || !/^[0-9a-f]{64}$/.test(job.baseline.sha256 ?? '')
    || typeof job.projectRoot !== 'string' || !path.isAbsolute(job.projectRoot)) refuse('invalid-input', 'expected a complete standalone check request and pre-edit baseline');
  const control = requestControl(job); assertRunning(control, services);
  let bytes;
  try { bytes = fs.readFileSync(job.baseline.file); }
  catch { refuse('baseline-unavailable', 'the pre-edit baseline is unavailable; a candidate cannot replace it'); }
  if (sha(bytes) !== job.baseline.sha256) refuse('stale-input', 'the pre-edit baseline differs from its controller binding');
  let frozen;
  try { frozen = JSON.parse(bytes); } catch { refuse('invalid-input', 'malformed pre-edit baseline'); }
  if (frozen.schema !== 'fvs-checker/standalone-baseline' || frozen.version !== job.version || frozen.purpose !== 'standalone' || frozen.authority !== 'audit-only'
    || !object(frozen.compiled) || !Object.keys(frozen.compiled).length || !object(frozen.checker) || !object(frozen.externalBindings) || !Object.keys(frozen.externalBindings).length
    || !object(frozen.runtimeBindings) || !Array.isArray(frozen.targets) || !frozen.targets.length
    || frozen.meaning?.status !== 'meaning-checked' || frozen.meaning?.targetProofsChecked !== false) refuse('invalid-input', 'no valid pre-edit type/meaning baseline; a candidate cannot replace it');
  if(job.version===2&&!sameExecutionPolicy(job.execution,frozen.execution))refuse('stale-input','standalone continuation execution policy differs from its frozen run');
  if(job.version===2){if(!object(frozen.meaningCheck)||!path.isAbsolute(frozen.meaningCheck.file??'')||! /^[0-9a-f]{64}$/.test(frozen.meaningCheck.sha256??''))refuse('invalid-input','missing v2 frozen meaning wrapper');const meaning=readJson(frozen.meaningCheck.file);if(sha(fs.readFileSync(frozen.meaningCheck.file))!==frozen.meaningCheck.sha256||meaning.authority!=='audit-only'||JSON.stringify(meaning.audit)!==JSON.stringify(frozen.meaning))refuse('stale-input','standalone frozen meaning evidence changed');validateKernelExecution(meaning,2,frozen.execution);}
  if (fs.realpathSync(job.projectRoot) !== frozen.projectRoot) refuse('stale-input', 'standalone baseline belongs to another project root');
  if (sha(fs.readFileSync(SCRIPT)) !== frozen.checker.scriptSha256 || sha(fs.readFileSync(HELPER)) !== frozen.checker.helperSha256
    || sha(fs.readFileSync(process.execPath)) !== frozen.checker.nodeSha256) refuse('stale-input', 'checker identity changed since pre-edit capture');
  if (sha(fs.readFileSync(fileURLToPath(new URL('./fvs-checker-build.mjs', import.meta.url)))) !== frozen.checker.buildSha256) refuse('stale-input', 'builder changed since pre-edit capture');
  if (!object(frozen.checker.policy)) refuse('invalid-input', 'missing frozen standalone build policy');
  for (const [file, digest] of Object.entries(frozen.checker.policy)) if (sha(fs.readFileSync(file)) !== digest) refuse('stale-input', 'build policy changed since pre-edit capture');
  const verifyExternal = () => {
    for (const [file, digest] of Object.entries({ ...frozen.externalBindings, ...frozen.runtimeBindings })) if (sha(fs.readFileSync(file)) !== digest) refuse('stale-input', `frozen library/runtime changed: ${file}`);
  };
  verifyExternal();
  const baseRoot = fs.realpathSync(path.dirname(job.baseline.file));
  const bundleFile = (rel) => {
    if (!relativeFile(rel)) refuse('invalid-input', 'invalid relative baseline input');
    const full = fs.realpathSync(path.join(baseRoot, rel));
    if (!full.startsWith(`${baseRoot}${path.sep}`)) refuse('invalid-input', 'baseline input escapes its bundle');
    return full;
  };
  for (const [rel, digest] of Object.entries(frozen.compiled)) if (sha(fs.readFileSync(bundleFile(rel))) !== digest) refuse('stale-input', `frozen compiled input changed: ${rel}`);
  for (const [rel, digest] of Object.entries(frozen.files)) if (sha(fs.readFileSync(bundleFile(`source/${rel}`))) !== digest) refuse('stale-input', `frozen source changed: ${rel}`);
  const files = projectFiles(job.projectRoot);
  if (JSON.stringify(Object.keys(files)) !== JSON.stringify(Object.keys(frozen.files))) refuse('stale-input', 'project source inventory changed outside the proof overlay');
  for (const [rel, digest] of Object.entries(files)) if (rel !== frozen.specFile && digest !== frozen.files[rel]) refuse('stale-input', `protected project input changed: ${rel}`);
  try { fs.mkdirSync(out); } catch (e) { refuse('invalid-input', `exclusive candidate output unavailable: ${e.code}`); }
  const root = fs.realpathSync(out), sourceRoot = path.join(root, 'source'); fs.mkdirSync(sourceRoot);
  for (const [rel, digest] of Object.entries(files)) {
    const file = path.join(sourceRoot, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.copyFileSync(path.join(job.projectRoot, rel), file, fs.constants.COPYFILE_EXCL);
    if (sha(fs.readFileSync(file)) !== digest) refuse('stale-input', 'candidate changed while taking its immutable snapshot');
  }
  const built = await standaloneBuild({ job: { ...job, specFile: frozen.specFile, lean: frozen.lean, externalSearchPaths: frozen.externalSearchPaths, externalImports: frozen.externalImports },
    root, sourceRoot, files, profile: frozen.buildProfile, services });
  const source = fs.readFileSync(path.join(sourceRoot, frozen.specFile), 'utf8'), original = fs.readFileSync(bundleFile(`source/${frozen.specFile}`), 'utf8'), ilean = readJson(built.selected.ilean);
  if (ilean.version !== 5 || ilean.module !== frozen.module || !object(ilean.decls)) refuse('unsupported', 'unsupported candidate declaration inventory');
  const declarations = Object.entries(ilean.decls).map(([name, range]) => declaration(source, range, name));
  const byName = new Map(declarations.map((d) => [d.name, d]));
  for (const old of frozen.declarations) {
    const current = byName.get(old.name);
    if (!current) refuse('stale-input', `missing original declaration ${old.name}`);
    if (['theorem', 'lemma'].includes(old.kind)) {
      if (old.kind !== current.kind || old.header !== current.header) refuse('stale-input', `protected theorem header changed: ${old.name}`);
    } else if (original.slice(old.start, old.end) !== source.slice(current.start, current.end)) refuse('stale-input', `protected meaning/context changed: ${old.name}`);
  }
  const added = declarations.filter((d) => !frozen.declarations.some((old) => old.name === d.name));
  if (added.some((d) => !['theorem', 'lemma'].includes(d.kind))) refuse('stale-input', 'new meaning declarations require an explicit refreeze');
  const context = (text, ds) => {
    const spans = ds.map((d) => [d.start, d.end]).sort((a, b) => a[0] - b[0]); let at = 0, remaining = '';
    for (const [start, end] of spans) { if (start > at) remaining += text.slice(at, start); at = Math.max(at, end); }
    remaining += text.slice(at);
    return tokens(remaining, true).map((t) => t.text).join('\u0000');
  };
  if (context(original, frozen.declarations) !== context(source, declarations)) refuse('stale-input', 'the lexical context changed outside proof bodies');
  const kernelJob = { schema: 'fvs-checker/kernel-request', ...executionFields(job), runId: job.runId, lean: frozen.lean,
    externalSearchPaths: built.externalSearchPaths, externalImports: built.externalImports, modules: built.modules.map(({ name, parts }) => ({ name, parts })),
    referenceModules: frozen.modules.map((m) => ({ name: m.name, parts: m.parts.map(bundleFile) })), targets: frozen.targets, meaningRoots: frozen.meaningRoots,
    auxiliaryRoots: added.map((d) => d.name),
    theoremInventory: { module: frozen.module, names: declarations.filter((d) => ['theorem', 'lemma'].includes(d.kind)).map((d) => d.name) } };
  const kernelRequest = path.join(root, 'kernel-request.json'); fs.writeFileSync(kernelRequest, `${JSON.stringify(kernelJob)}\n`, { flag: 'wx' });
  const result = await (job.version === 2 ? runKernelAuditV2 : runKernelAudit)({ request: kernelRequest, out: path.join(root, 'kernel-check') }, services);
  verifyBuildImports(built, result.attempt.imports, control);
  verifyExternal();
  if (JSON.stringify(externalIdentity(result.attempt.imports)) !== JSON.stringify(frozen.externalIdentity) || JSON.stringify(result.attempt.runtimes) !== JSON.stringify(frozen.runtimeBindings)) refuse('stale-input', 'resolved library/runtime inventory changed since pre-edit capture');
  if (JSON.stringify(projectFiles(job.projectRoot)) !== JSON.stringify(files)) refuse('stale-input', 'project changed during candidate audit');
  if (job.version === 2) assertRunning(control, services);
  return retainResult(root, { ...result, kernelEvidence: result.evidence, schema: 'fvs-checker/standalone-result', purpose: 'standalone', sourceIdentity: 'matched', baselineSha256: job.baseline.sha256 });
}

function ownedFacts(run, version, control) {
  return version === 2 ? { supervision: { cancelled: run.cancelled, timedOut: run.timedOut, cleanupComplete: run.cleanupComplete, cleanup: run.cleanup }, execution:control } : {};
}
function assertOwnedOutcome(run, version) {
  if (version !== 2) return;
  if (run.cancelled) refuse('cancelled', 'operation cancelled; no proof result');
  if (run.timedOut) refuse('timeout', 'selected execution budget exhausted');
  if (!conclusiveOwnedSupervision(ownedFacts(run,2).supervision)) refuse('unsupported', 'owned checking scope cleanup is unverified');
}
function* kernelAuditSteps({ request, out }, { baseline = false } = {}, expectedVersion = 1, services = {}) {
  const job = readJson(request);
  const keys = ['schema', 'version', 'runId', 'lean', expectedVersion === 2 ? 'execution' : 'deadlineMs', 'externalSearchPaths', 'externalImports', 'modules', 'referenceModules', 'targets', 'meaningRoots', 'auxiliaryRoots', 'proofIdentityRoots', 'meaningOnly', 'theoremInventory'];
  const modulesValid = (list) => Array.isArray(list) && list.length > 0 && new Set(list.map((m) => m?.name)).size === list.length
    && list.every((m) => object(m) && typeof m.name === 'string' && /^[A-Za-z_][A-Za-z0-9_']*(\.[A-Za-z_][A-Za-z0-9_']*)*$/.test(m.name)
      && textList(m.parts) && [1, 3].includes(m.parts.length) && m.parts.every(path.isAbsolute)
      && m.parts[0].endsWith('.olean') && (m.parts.length === 1 || (m.parts[1] === `${m.parts[0]}.server` && m.parts[2] === `${m.parts[0]}.private`)));
  if (!object(job) || Object.keys(job).some((k) => !keys.includes(k)) || job.schema !== 'fvs-checker/kernel-request' || job.version !== expectedVersion
    || typeof job.runId !== 'string' || !job.runId || !object(job.lean) || !path.isAbsolute(job.lean.path ?? '')
    || !/^[0-9a-f]{64}$/.test(job.lean.sha256 ?? '')
    || !textList(job.externalImports) || !Array.isArray(job.externalSearchPaths) || !job.externalSearchPaths.every((p) => typeof p === 'string' && path.isAbsolute(p))
    || !modulesValid(job.modules) || !modulesValid(job.referenceModules) || !Array.isArray(job.targets)
    || (!job.targets.length && !(baseline && job.meaningOnly === true && job.meaningRoots?.length))
    || (job.meaningOnly !== undefined && !(baseline && job.meaningOnly === true && job.targets.length === 0))
    || job.targets.some((t) => !object(t) || typeof t.name !== 'string' || typeof t.expectedName !== 'string' || (t.module !== undefined && !moduleName(t.module)))
    || new Set(job.targets.map((t) => t.name)).size !== job.targets.length || !Array.isArray(job.meaningRoots) || !job.meaningRoots.every((s) => typeof s === 'string')
    || (job.auxiliaryRoots !== undefined && (!textList(job.auxiliaryRoots) || new Set(job.auxiliaryRoots).size !== job.auxiliaryRoots.length))
    || (job.theoremInventory !== undefined && (!object(job.theoremInventory) || !moduleName(job.theoremInventory.module)
      || !job.modules.some((m) => m.name === job.theoremInventory.module) || !textList(job.theoremInventory.names)
      || new Set(job.theoremInventory.names).size !== job.theoremInventory.names.length))
    || (job.proofIdentityRoots !== undefined && (!textList(job.proofIdentityRoots) || !job.proofIdentityRoots.length || job.proofIdentityRoots.some((n) => !job.targets.some((t) => t.name === n))))) {
    refuse('invalid-input', 'expected a complete controller-owned fvs-checker/kernel-request version 1');
  }
  const control = requestControl(job);
  assertRunning(control, services);
  const standardRoot = path.join(path.dirname(path.dirname(fs.realpathSync(job.lean.path))), 'lib/lean');
  for (const module of [...job.modules, ...job.referenceModules]) if (fs.existsSync(path.join(standardRoot, `${module.name.replaceAll('.', '/')}.olean`))) refuse('unsupported', `project module shadows the pinned toolchain: ${module.name}`);
  const trustedPaths = [...new Set([standardRoot, ...job.externalSearchPaths])];
  const irFiles = [...job.modules, ...job.referenceModules].map((m) => m.parts[0].replace(/\.olean$/, '.ir')).filter((p) => fs.existsSync(p));
  const runtimes = nativeRuntimeFiles(job.lean.path);
  const scopeTools=expectedVersion===2&&services.inheritGroup?[executionScopeTool().file]:[];
  const paths = [...new Set([path.resolve(request), job.lean.path, process.execPath, SCRIPT, HELPER, EXECUTION, EXECUTION_DATA, ...scopeTools, ...job.modules.flatMap((m) => m.parts), ...job.referenceModules.flatMap((m) => m.parts), ...irFiles, ...runtimes])];
  const inputs = Object.fromEntries(paths.map((p) => [p, sha(fs.readFileSync(p))]));
  if (inputs[job.lean.path] !== job.lean.sha256) refuse('stale-input', 'the Lean executable differs from its controller binding');
  try { fs.mkdirSync(out); } catch (e) { refuse('invalid-input', `exclusive audit output unavailable: ${e.code}`); }
  const engine = path.resolve(out, 'engine'); fs.mkdirSync(engine);
  const snapshots = { helper: path.join(engine, 'FvsKernelAudit.lean'), runner: path.join(engine, 'fvs-checker.mjs'), modules: [] };
  fs.copyFileSync(HELPER, snapshots.helper, fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(SCRIPT, snapshots.runner, fs.constants.COPYFILE_EXCL);
  const copyModules = (list, role) => list.map((m) => {
    const dir = path.resolve(out, role);
    const base = path.join(dir, ...m.name.split('.')) + '.olean'; fs.mkdirSync(path.dirname(base), { recursive: true });
    const sourceIR = m.parts[0].replace(/\.olean$/, '.ir');
    if (inputs[sourceIR]) {
      const file = base.replace(/\.olean$/, '.ir'); fs.copyFileSync(sourceIR, file, fs.constants.COPYFILE_EXCL);
      if (sha(fs.readFileSync(file)) !== inputs[sourceIR]) refuse('stale-input', 'baseline witness IR changed while being captured');
      snapshots.modules.push({ source: sourceIR, file, sha256: inputs[sourceIR] });
    }
    return { ...m, searchRoot: dir, parts: m.parts.map((source, part) => {
      const file = base + ['', '.server', '.private'][part];
      fs.copyFileSync(source, file, fs.constants.COPYFILE_EXCL);
      if (sha(fs.readFileSync(file)) !== inputs[source]) refuse('stale-input', `an input changed while being captured: ${source}`);
      snapshots.modules.push({ source, file, sha256: inputs[source] });
      return file;
    }) };
  });
  const sealedJob = { ...job, modules: copyModules(job.modules, 'candidate'), referenceModules: copyModules(job.referenceModules, 'reference') };
  if (sha(fs.readFileSync(snapshots.helper)) !== inputs[HELPER] || sha(fs.readFileSync(snapshots.runner)) !== inputs[SCRIPT]) refuse('stale-input', 'checker source changed while being captured');
  const sealed = path.join(out, 'request.json');
  fs.writeFileSync(sealed, `${JSON.stringify(sealedJob)}\n`, { flag: 'wx' });
  const baseEnv = { PATH: `${path.dirname(job.lean.path)}:/usr/bin:/bin`, LANG: 'C', TMPDIR: path.resolve(out) };
  const witnessArgv = ['--run', snapshots.helper, 'witness', path.resolve(sealed)];
  const witness = (yield { argv: [job.lean.path, ...witnessArgv], control, options: { cwd: path.resolve(out), encoding: 'utf8', ...(expectedVersion === 2 ? timeoutOptions(control) : { timeout: Math.max(1, job.deadlineMs - Date.now()) }), maxBuffer: 16 * 1024 * 1024,
    env: { ...baseEnv, LEAN_PATH: [...new Set([standardRoot, ...sealedJob.referenceModules.map((m) => m.searchRoot), ...trustedPaths])].join(path.delimiter) }} });
  fs.writeFileSync(path.join(out, 'witness.stdout.log'), witness.stdout ?? '', { flag: 'wx' });
  fs.writeFileSync(path.join(out, 'witness.stderr.log'), witness.stderr ?? '', { flag: 'wx' });
  const witnessReceipt = { argv: [job.lean.path, ...witnessArgv], exit: witness.status, signal: witness.signal, error: witness.error?.code ?? null,
    stdoutSha256: sha(witness.stdout ?? ''), stderrSha256: sha(witness.stderr ?? ''), ...ownedFacts(witness, expectedVersion, control) };
  fs.writeFileSync(path.join(out, 'witness-attempt.json'), `${JSON.stringify(witnessReceipt, null, 2)}\n`, { flag: 'wx' });
  assertOwnedOutcome(witness, expectedVersion);
  if (witness.error?.code === 'ETIMEDOUT') refuse('timeout', 'the baseline witness timed out');
  if (witness.status !== 0 || witness.signal || witness.error) helperFailure(witness, 'baseline type witness failed');
  let facts;
  try { facts = JSON.parse(witness.stdout); } catch { refuse('audit-failed', 'malformed baseline structure witness'); }
  if (facts.schema !== 'fvs-type-witness/structures' || facts.version !== 1 || facts.runId !== job.runId || !Array.isArray(facts.facts)) refuse('audit-failed', 'foreign or incomplete baseline witness');
  const imports = importedParts(facts.imports);
  // Discovery is not authoritative metadata: repeat after binding every resolved
  // part, then use only that second process's type/context observations.
  const verifiedWitness = (yield { argv: [job.lean.path, ...witnessArgv], control, options: { cwd: path.resolve(out), encoding: 'utf8', ...(expectedVersion === 2 ? timeoutOptions(control) : { timeout: Math.max(1, job.deadlineMs - Date.now()) }), maxBuffer: 16 * 1024 * 1024,
    env: { ...baseEnv, LEAN_PATH: [...new Set([standardRoot, ...sealedJob.referenceModules.map((m) => m.searchRoot), ...trustedPaths])].join(path.delimiter) }} });
  fs.writeFileSync(path.join(out, 'verified-witness.stdout.log'), verifiedWitness.stdout ?? '', { flag: 'wx' });
  fs.writeFileSync(path.join(out, 'verified-witness.stderr.log'), verifiedWitness.stderr ?? '', { flag: 'wx' });
  const verifiedWitnessReceipt = { argv: [job.lean.path, ...witnessArgv], exit: verifiedWitness.status, signal: verifiedWitness.signal, error: verifiedWitness.error?.code ?? null,
    stdoutSha256: sha(verifiedWitness.stdout ?? ''), stderrSha256: sha(verifiedWitness.stderr ?? ''), ...ownedFacts(verifiedWitness, expectedVersion, control) };
  fs.writeFileSync(path.join(out, 'verified-witness-attempt.json'), `${JSON.stringify(verifiedWitnessReceipt, null, 2)}\n`, { flag: 'wx' });
  assertOwnedOutcome(verifiedWitness, expectedVersion);
  if (verifiedWitness.error?.code === 'ETIMEDOUT') refuse('timeout', 'the bound baseline witness timed out');
  if (verifiedWitness.status !== 0 || verifiedWitness.signal || verifiedWitness.error) helperFailure(verifiedWitness, 'bound baseline witness failed');
  let boundFacts;
  try { boundFacts = JSON.parse(verifiedWitness.stdout); } catch { refuse('audit-failed', 'malformed bound baseline witness'); }
  if (boundFacts.schema !== facts.schema || boundFacts.version !== 1 || boundFacts.runId !== job.runId || !Array.isArray(boundFacts.facts)
    || !Array.isArray(boundFacts.declarations) || JSON.stringify(boundFacts.imports) !== JSON.stringify(facts.imports)) refuse('stale-input', 'import resolution changed during baseline witnessing');
  verifyParts(imports);
  facts = boundFacts;
  const auditRequest = path.join(out, 'audit-request.json');
  fs.writeFileSync(auditRequest, `${JSON.stringify({ ...sealedJob, structureFacts: facts.facts })}\n`, { flag: 'wx' });
  const argv = ['--run', snapshots.helper, baseline ? 'baseline' : 'audit', path.resolve(auditRequest)];
  const run = (yield { argv: [job.lean.path, ...argv], control, options: { cwd: path.resolve(out), encoding: 'utf8', ...(expectedVersion === 2 ? timeoutOptions(control) : { timeout: Math.max(1, job.deadlineMs - Date.now()) }), maxBuffer: 16 * 1024 * 1024,
    env: { ...baseEnv, LEAN_PATH: trustedPaths.join(path.delimiter) }} });
  fs.writeFileSync(path.join(out, 'stdout.log'), run.stdout ?? '', { flag: 'wx' });
  fs.writeFileSync(path.join(out, 'stderr.log'), run.stderr ?? '', { flag: 'wx' });
  const attempt = { schema: 'fvs-checker/kernel-attempt', version: expectedVersion, authority: 'audit-only', bindingLevel: 'resolved-inputs', runId: job.runId,
    inputs, snapshots, imports, runtimes: Object.fromEntries(runtimes.map((p) => [p, inputs[p]])), discovery: witnessReceipt, witness: verifiedWitnessReceipt,
    requestSha256: sha(fs.readFileSync(auditRequest)), argv: [job.lean.path, ...argv], exit: run.status, signal: run.signal, error: run.error?.code ?? null,
    stdoutSha256: sha(run.stdout ?? ''), stderrSha256: sha(run.stderr ?? ''), ...ownedFacts(run, expectedVersion, control), ...(expectedVersion === 2 ? { execution: job.execution } : {}) };
  fs.writeFileSync(path.join(out, 'attempt.json'), `${JSON.stringify(attempt, null, 2)}\n`, { flag: 'wx' });
  assertOwnedOutcome(run, expectedVersion);
  for (const [p, digest] of Object.entries(inputs)) if (sha(fs.readFileSync(p)) !== digest) refuse('stale-input', `an input changed during the audit: ${p}`);
  for (const { file, sha256 } of snapshots.modules) if (sha(fs.readFileSync(file)) !== sha256) refuse('stale-input', 'captured module data changed during the audit');
  if (sha(fs.readFileSync(snapshots.helper)) !== inputs[HELPER] || sha(fs.readFileSync(snapshots.runner)) !== inputs[SCRIPT]) refuse('stale-input', 'captured checker source changed during the audit');
  verifyParts(imports);
  if (run.error?.code === 'ETIMEDOUT') refuse('timeout', 'the bounded Lean audit timed out');
  if (run.status !== 0 || run.signal || run.error) helperFailure(run, 'Lean audit failed');
  let audit;
  try { audit = JSON.parse(run.stdout); } catch { refuse('audit-failed', 'Lean returned malformed or extra audit output'); }
  if (audit.schema !== (baseline ? 'fvs-kernel-baseline/result' : 'fvs-kernel-audit/result') || audit.version !== 1 || audit.runId !== job.runId || audit.status !== (baseline ? 'meaning-checked' : 'kernel-checked')
    || !textList(audit.targets) || JSON.stringify([...audit.targets].sort()) !== JSON.stringify(job.targets.map((t) => t.name).sort())
    || audit.targetProofsChecked !== !baseline || !textList(audit.replayed) || new Set(audit.replayed).size !== audit.replayed.length
    || (!baseline && job.targets.some((t) => !audit.replayed.includes(t.name))) || !textList(audit.meaning)
    || !textList(audit.axioms) || new Set(audit.axioms).size !== audit.axioms.length
    || audit.axioms.some((a) => !['propext', 'Classical.choice', 'Quot.sound'].includes(a))) refuse('audit-failed', 'Lean returned incomplete or foreign audit evidence');
  const checkedImports = importedParts(audit.imports);
  const expected = new Map(imports.filter((m) => !m.project).map((m) => [m.name, m]));
  for (const m of checkedImports) if (m.project || JSON.stringify(m) !== JSON.stringify(expected.get(m.name))) refuse('stale-input', `checking environment imported an unbound module: ${m.name}`);
  if (expectedVersion === 1) { if (Date.now() > job.deadlineMs) refuse('timeout', 'the validation deadline elapsed before completion'); }
  else assertRunning(control, services);
  return retainResult(out, { code: 'ok', authority: 'audit-only', bindingLevel: attempt.bindingLevel, audit, witness: facts, attempt });
}

// Static artifact integrity is distinct from a caller's permission to start more work.
export function validateKernelExecution(kernel, expectedVersion, execution) {
  const a=kernel?.attempt;
  if(![1,2].includes(expectedVersion)||a?.schema!=='fvs-checker/kernel-attempt'||a.version!==expectedVersion||a.authority!=='audit-only'||a.runId!==kernel.audit?.runId)refuse('stale-input','kernel attempt version differs from its enclosing evidence');
  for(const phase of [a.discovery,a.witness,a]){
    if(!phase||phase.exit!==0||phase.signal!==null||phase.error!==null)refuse('stale-input','uncompleted kernel phase receipt');
    if(expectedVersion===2){
      if(!sameExecutionPolicy(phase.execution,execution))refuse('stale-input','kernel execution policy differs from its enclosing evidence');
      if(!conclusiveOwnedSupervision(phase.supervision))refuse('stale-input','uncompleted v2 checking-scope supervision');
      const join=phase.supervision.cleanup.join;
      if(join)for(const o of [join.before,join.after])if(a.inputs?.[o.tool.file]!==o.tool.sha256)refuse('stale-input','checking-scope observer lost its kernel input binding');
    }else if(Object.hasOwn(phase,'execution')||Object.hasOwn(phase,'supervision'))refuse('stale-input','legacy kernel phase contains mixed execution fields');
  }
  if(!a.inputs||!a.snapshots||!Array.isArray(a.imports)||!Array.isArray(a.snapshots.modules)||!Array.isArray(a.argv))refuse('stale-input','incomplete kernel artifact inventory');
  const original=Object.entries(a.inputs)[0],sealed=a.argv.at(-1);
  if(!original||!path.isAbsolute(original[0])||!path.isAbsolute(sealed??''))refuse('stale-input','missing original/sealed kernel request');
  for(const[file,digest]of [original,[sealed,a.requestSha256]]){
    const bytes=fs.readFileSync(file);if(sha(bytes)!==digest)refuse('stale-input','kernel request input changed');
    const request=readJson(file);
    if(request.schema!=='fvs-checker/kernel-request'||request.version!==expectedVersion||request.runId!==a.runId)refuse('stale-input','kernel request version/run differs from its attempt');
    const control=requestControl(request);if(expectedVersion===2&&!sameExecutionPolicy(control,execution))refuse('stale-input','retained kernel request execution policy changed');
  }
}
export function checkKernelArtifacts(kernel,expectedVersion,execution){
  validateKernelExecution(kernel,expectedVersion,execution);const a=kernel.attempt;
  for(const[file,digest]of Object.entries(a.inputs))if(sha(fs.readFileSync(file))!==digest)refuse('stale-input','accepted kernel input changed');
  for(const m of a.imports)for(const part of m.parts)if(sha(fs.readFileSync(part.file))!==part.sha256)refuse('stale-input','accepted kernel import changed');
  for(const row of a.snapshots.modules)if(sha(fs.readFileSync(row.file))!==row.sha256)refuse('stale-input','accepted kernel input snapshot changed');
  for(const[name,source]of [['helper',HELPER],['runner',SCRIPT]])if(sha(fs.readFileSync(a.snapshots[name]))!==sha(fs.readFileSync(source)))refuse('stale-input','captured checker evidence changed');
}

export function runKernelAudit(options, flags = {}) {
  const steps = kernelAuditSteps(options, flags, 1);
  let step = steps.next();
  while (!step.done) {
    const operation = step.value;
    step = steps.next(spawnSync(operation.argv[0], operation.argv.slice(1), operation.options));
  }
  return step.value;
}
export async function runKernelAuditV2(options, flags = {}) {
  const steps = kernelAuditSteps(options, flags, 2, flags);
  let step = steps.next();
  while (!step.done) {
    const operation = step.value, { timeout: _selectedBudget, ...ownedOptions } = operation.options;
    const result = await runOwned(operation.argv, ownedOptions, operation.control, flags);
    step = steps.next(result);
  }
  return step.value;
}

export async function runCommand(argv, services = {}) {
  if (argv.length === 0 || argv.includes('--help')) return { code: 'usage', message: 'Usage: fvs-checker.mjs check --request FILE --out DIR' };
  const [command, ...rest] = argv;
  if (!['check', 'audit', 'freeze', 'accept'].includes(command)) refuse('usage', `unknown command ${JSON.stringify(command)}`);
  const flags = {};
  while (rest.length) {
    const flag = rest.shift();
    if (!['--request', '--out'].includes(flag) || Object.hasOwn(flags, flag.slice(2))) refuse('usage', `unknown or repeated argument ${JSON.stringify(flag)}`);
    const value = rest.shift();
    if (!value || value.startsWith('--')) refuse('usage', `${flag} requires a value`);
    flags[flag.slice(2)] = value;
  }
  if (!flags.request || !flags.out) refuse('usage', '--request and --out are required');
  const job = readJson(flags.request);
  const dispatch = async executionServices => {
    const audit = job.version === 2 ? (options, mode = {}) => runKernelAuditV2(options, { ...executionServices, ...mode }) : runKernelAudit;
    if (job?.purpose === 'auto' || command === 'accept') {
      const { runAuto } = await import('./fvs-checker-auto.mjs');
      return await runAuto(command, flags, { runKernelAudit: audit, verifyBuildImports, HELPER, SCRIPT, executionServices });
    }
    return command === 'audit' ? await audit(flags) : command === 'freeze' ? await freeze(flags, executionServices) : await check(flags, executionServices);
  };
  return job.version === 2 && services.cli ? withProcessCancellation(extra => dispatch({ ...services, ...extra, inheritGroup: ['transition-v2','owned-work-v2'].includes(process.env.FVS_OWNED_EXECUTION_SCOPE) })) : dispatch(services);
}

export async function checkerCli(argv) {
  let result;
  try { result = { ok: true, ...await runCommand(argv, { cli: true }) }; }
  catch (error) { result = { ok: false, status: 'unverified', code: Object.hasOwn(EXIT, error.code) ? error.code : 'internal', message: error.message }; }
  const displayed = result.evidence ? { ok: result.ok, code: result.code, status: result.status, schema: result.schema, purpose: result.purpose,
    authority: result.authority, bindingLevel: result.bindingLevel, sourceIdentity: result.sourceIdentity, baselineSha256: result.baselineSha256,
    audit: { schema: result.audit?.schema, status: result.audit?.status, runId: result.audit?.runId, targets: result.audit?.targets,
      replayed: result.audit?.replayed, meaning: result.audit?.meaning, axioms: result.audit?.axioms }, evidence: result.evidence } : result;
  process.stdout.write(`${JSON.stringify(displayed)}\n`);
  if (!result.ok) process.stderr.write(`FVS >> ${result.code}: ${result.message}\n`);
  process.exitCode = EXIT[result.code] ?? 2;
}
let direct = false;
try { direct = fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch {}
// Finish module loading before the auto adapter imports the shared lexer.
if (direct) checkerCli(process.argv.slice(2));
