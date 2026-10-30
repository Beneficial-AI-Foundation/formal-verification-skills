#!/usr/bin/env node
'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Builds the Rust identity record of one extraction: every local Rust function
// keyed by its Charon def_id from Aeneas's translation.json, mapped to its Lean
// definitions, and bound to that extraction's provenance. It only reads the
// outputs of the pinned tools (probe-rust `extract --translation`, probe-aeneas
// `translate`, optionally probe-lean `extract` and probe-aeneas's functions.json);
// it never runs them. A mapping counts as exact only when probe-aeneas made it by
// its charon-def-id join and the def_id, span and Lean target all agree. The
// record is bound to one extraction only when the state carries an attempt the
// patch engine recorded and re-validated, and the given LLBC and translation.json
// are that attempt's outputs and agree with each other and the manifest.

const EXIT = { ok: 0, usage: 2, internal: 2, 'invalid-input': 5, partial: 6, blocked: 7, unbound: 8 };
const DEF_ID_METHOD = 'charon-def-id';
const CONFLICT = new Set(['span-mismatch', 'mapping-target-differs']);
const AMBIGUOUS = new Set(['duplicate-charon-def-id', 'lean-target-claimed-twice', 'span-missing', 'span-path-unsupported', 'conflicting-mappings']);
const UNSUPPORTED = new Set(['recursion', 'non-loop-split', 'no-primary', 'type-generic']);
const UNBOUND_WITHOUT_ATTEMPT = ['translation-linkage-triangulated', 'extraction-configuration-not-bound'];

class Refusal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function refuse(code, message) {
  throw new Refusal(code, message);
}

function usage() {
  process.stdout.write([
    'Usage: node fvs-rust-identity.mjs record --source-commit SHA --translation FILE --manifest FILE',
    '         --rust FILE --mappings FILE --lean FILE --functions FILE [--config FILE]',
    '         [--state FILE] [--llbc FILE] [--lean-receipt FILE] [--out FILE] [--format json|text]',
    '',
    '--translation  Aeneas translation.json (-emit-json); its functions[] def_ids are the keys',
    '--manifest     fvs-extract-patches manifest.json of the same extraction',
    '--rust         probe-rust `extract --translation` output',
    '--mappings     probe-aeneas `translate` output (each mapping names its method)',
    '--lean, --functions  probe-lean extract output and probe-aeneas functions.json: kept verbatim',
    '               and used to check that each Lean family is complete',
    '--config       a configuration file whose sha256 is recorded as the caller\'s; it binds nothing',
    '--state        FVS auto state; its recorded manifest sha256 and source commit must agree, and',
    '               its recorded extraction attempt (extraction.run) is what can bind the record',
    '--lean-receipt the ticket 21 probe-lean run receipt (fvs/lean-probe-run v1). Only with it may',
    '               probe-lean\'s commit differ from the Rust source commit, and only when the record is',
    '               bound and the receipt analysed every published Lean file at its recorded hash',
    '--llbc         Charon\'s LLBC from that attempt: its hash, options, embedded sources and',
    '               fun_decls are checked against the attempt, the manifest and translation.json',
    '',
    'Exit: 0 complete (bound to the recorded attempt and every function exact), 8 unbound',
    '(every function exact, but no validated recorded attempt binds the inputs), 6 partial',
    '(some functions not exact), 7 blocked (provenance or correspondence conflict; no function',
    'is claimed), 5 invalid input, 2 usage.',
    '',
  ].join('\n'));
}

function readInput(file, label) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    refuse('invalid-input', `${label} ${JSON.stringify(file)} is unreadable: ${error.code ?? error.message}`);
  }
  let json;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    refuse('invalid-input', `${label} ${JSON.stringify(file)} is not valid JSON (truncated?): ${error.message}`);
  }
  if (json === null || typeof json !== 'object') refuse('invalid-input', `${label} ${JSON.stringify(file)} is not a JSON object`);
  return { json, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

function sha256File(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch (error) {
    refuse('invalid-input', `${JSON.stringify(file)} is unreadable: ${error.code ?? error.message}`);
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isLine = (value) => Number.isInteger(value) && value >= 1;
const isId = (value) => Number.isInteger(value) && value >= 0;
const isSha = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
// A generated Lean file named by translation.json: a non-empty relative .lean path inside -dest.
const isLeanPath = (value) => typeof value === 'string' && value.endsWith('.lean') && !path.posix.isAbsolute(value)
  && path.posix.normalize(value) === value && !value.split('/').includes('..');
const TRANSLATION_SECTIONS = ['functions', 'types', 'globals', 'trait_decls', 'trait_impls'];
const sha256Text = (text) => crypto.createHash('sha256').update(text).digest('hex');

// Refuses an input whose envelope or identity fields are not the qualified shape,
// so a missing or mistyped field can never take part in a match.
function validate({ translation, manifest, rust, mappings, lean, functions, state, llbc, leanReceipt, sourceCommit }) {
  const bad = (label, message) => refuse('invalid-input', `${label}: ${message}`);
  for (const [label, value] of Object.entries({ translation, rust, mappings, lean, functions })) {
    if (!isObject(value) || !('json' in value)) bad(label, 'is required as { json, sha256 }');
  }
  if (manifest !== null && manifest !== undefined && !isObject(manifest)) bad('manifest', 'must be { json, sha256 } or null');
  if (state !== null && state !== undefined && !isObject(state?.json)) bad('state', 'must be { json, sha256 } or null');
  if (typeof sourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(sourceCommit)) bad('sourceCommit', 'must be a full 40-character commit');
  const t = translation.json;
  if (!isObject(t) || !Array.isArray(t.functions) || typeof t.crate !== 'string') bad('translation.json', 'needs a crate string and a functions array');
  if (t.charon_version !== undefined && typeof t.charon_version !== 'string') bad('translation.json', 'charon_version must be a string');
  for (const f of t.functions) {
    const where = `function ${JSON.stringify(f?.lean_name)}`;
    if (!isObject(f) || !isId(f.def_id) || typeof f.lean_name !== 'string' || f.lean_name === '' || typeof f.is_local !== 'boolean') {
      bad('translation.json', `${where} needs an integer def_id, a lean_name and a boolean is_local`);
    }
    if (f.lean_file !== undefined && !isLeanPath(f.lean_file)) bad('translation.json', `${where} has a lean_file that is not a relative .lean path`);
    if (!f.is_local) continue;
    if (f.lean_file === undefined) bad('translation.json', `${where} names no lean_file, so its generated Lean output is unknown`);
    const s = f.source;
    if (typeof f.is_rec !== 'boolean' || !isObject(s) || typeof s.file !== 'string' || !isLine(s.begin_line) || !isLine(s.end_line) || s.end_line < s.begin_line) {
      bad('translation.json', `${where} needs a boolean is_rec and a source with file and ordered line bounds`);
    }
    if (f.loop !== undefined && (!isObject(f.loop) || !isId(f.loop.id) || typeof f.loop.is_body !== 'boolean' || typeof f.parent_lean_name !== 'string')) {
      bad('translation.json', `${where} has a malformed loop entry`);
    }
  }
  for (const key of TRANSLATION_SECTIONS.filter((section) => section !== 'functions')) {
    for (const entry of Array.isArray(t[key]) ? t[key] : []) {
      if (entry?.lean_file !== undefined && !isLeanPath(entry.lean_file)) bad('translation.json', `a ${key} entry has a lean_file that is not a relative .lean path`);
    }
  }
  if (manifest) {
    const m = manifest.json;
    if (!isObject(m) || m.schema !== 'fvs-extract-patches/manifest' || m.version !== 1 || m.status !== 'prepared'
      || !isObject(m.source) || typeof m.source.commit !== 'string' || !Array.isArray(m.source.dirty)) {
      bad('manifest', 'is not a prepared fvs-extract-patches manifest (schema, version 1, status prepared, source commit and dirty list)');
    }
  }
  const r = rust.json;
  if (!isObject(r) || r.schema !== 'probe-rust/extract' || r['schema-version'] !== '3.0' || !isObject(r.data) || !isObject(r.source)) {
    bad('probe-rust output', 'needs schema probe-rust/extract 3.0 with source and data objects');
  }
  for (const [name, atom] of Object.entries(r.data)) {
    if (atom['charon-def-id'] !== undefined && !isId(atom['charon-def-id'])) bad('probe-rust output', `${name} has a non-integer charon-def-id`);
    if (atom['charon-version'] !== undefined && typeof atom['charon-version'] !== 'string') bad('probe-rust output', `${name} has a non-string charon-version`);
  }
  const mp = mappings.json;
  if (!isObject(mp) || mp.schema !== 'probe/mappings' || mp['schema-version'] !== '3.0' || mp.tool?.command !== 'translate' || !Array.isArray(mp.mappings)
    || mp.mappings.some((m) => !isObject(m) || typeof m.from !== 'string' || typeof m.to !== 'string')) {
    bad('probe-aeneas translate output', 'needs schema probe/mappings 3.0 from translate with from/to strings');
  }
  if (!isObject(lean.json) || lean.json.schema !== 'probe-lean/extract' || !isObject(lean.json.data)) bad('probe-lean output', 'needs schema probe-lean/extract with a data object');
  if (!isObject(functions.json) || !Array.isArray(functions.json.functions) || functions.json.functions.some((f) => !isObject(f) || typeof f.lean_name !== 'string')) {
    bad('functions.json', 'needs a functions array of records with lean_name');
  }
  const run = state ? (state.json.extraction ?? state.json.state?.extraction)?.run : undefined;
  if (run !== undefined && !runShapeValid(run)) bad('state', 'extraction.run is not a complete recorded extraction attempt (stages, trust, attempt hash, translation and a non-empty unique publication)');
  if (leanReceipt !== null && leanReceipt !== undefined) {
    const r = leanReceipt.json;
    if (!isObject(leanReceipt) || !isObject(r) || r.schema !== 'fvs/lean-probe-run' || r.version !== 1 || typeof r.projectRoot !== 'string'
      || !isObject(r.probe) || !Number.isInteger(r.probe.exitCode) || !isObject(r.lakeBuild) || !Number.isInteger(r.lakeBuild.exitCode)
      || !isObject(r.inputs) || typeof r.inputs.leanProjectCommit !== 'string' || !isObject(r.inputs.files)
      || Object.values(r.inputs.files).some((hash) => !isSha(hash)) || !isObject(r.outputs) || !isSha(r.outputs.extractSha256)) {
      bad('lean receipt', 'is not a fvs/lean-probe-run version 1 record (project root, exit codes, Lean project commit, file hashes, extract hash)');
    }
  }
  if (llbc !== null && llbc !== undefined) {
    const l = llbc.json;
    if (!isObject(llbc) || !isObject(l) || typeof l.charon_version !== 'string' || !isObject(l.translated) || !isObject(l.translated.options)
      || !Array.isArray(l.translated.files) || !Array.isArray(l.translated.fun_decls)) {
      bad('llbc', 'needs charon_version and translated.options, files and fun_decls');
    }
    const ids = l.translated.files.map((file) => file?.id);
    if (ids.some((id) => !isId(id)) || new Set(ids).size !== ids.length) bad('llbc', 'file ids must be unique integers');
    const decls = l.translated.fun_decls.filter((decl) => decl !== null);
    const defIds = decls.map((decl) => decl?.def_id);
    if (defIds.some((id) => !isId(id)) || new Set(defIds).size !== defIds.length) bad('llbc', 'fun_decls def_ids must be unique integers');
    const local = new Set(t.functions.filter((f) => f.is_local).map((f) => f.def_id));
    for (const decl of decls) {
      const g = decl.generics;
      if (local.has(decl.def_id) && !(isObject(g) && Array.isArray(g.types) && Array.isArray(g.const_generics))) {
        bad('llbc', `fun_decl ${decl.def_id} has no well-formed generics (types and const_generics lists)`);
      }
    }
  }
}

const RUN_STAGES = ['charon', 'aeneas', 'publish'];

function runShapeValid(run) {
  if (!(isObject(run) && isSha(run.attemptSha256) && isSha(run.manifestSha256) && isSha(run.configSha256) && isObject(run.config)
    && typeof run.supported === 'boolean' && Array.isArray(run.residuals) && run.trust === 'local-host-and-reviewed-scripts'
    && isObject(run.stages) && Object.keys(run.stages).join() === RUN_STAGES.join() && RUN_STAGES.every((stage) => isSha(run.stages[stage]))
    && isObject(run.llbc) && typeof run.llbc.path === 'string' && isSha(run.llbc.sha256)
    && isObject(run.translation) && typeof run.translation.attemptPath === 'string' && typeof run.translation.projectPath === 'string' && isSha(run.translation.sha256)
    && Array.isArray(run.publication) && run.publication.length > 0)) return false;
  const entryValid = (entry) => isObject(entry) && typeof entry.attemptPath === 'string' && typeof entry.projectPath === 'string' && isSha(entry.sha256);
  if (!run.publication.every(entryValid)) return false;
  for (const key of ['attemptPath', 'projectPath']) if (new Set(run.publication.map((entry) => entry[key])).size !== run.publication.length) return false;
  return run.publication.some((entry) => entry.attemptPath === run.translation.attemptPath && entry.projectPath === run.translation.projectPath && entry.sha256 === run.translation.sha256);
}

const spanOf = (atom) => {
  const text = atom['code-text'];
  return typeof atom['code-path'] === 'string' && isObject(text) && isLine(text['lines-start']) && isLine(text['lines-end']) && text['lines-end'] >= text['lines-start']
    ? { file: atom['code-path'], beginLine: text['lines-start'], endLine: text['lines-end'] }
    : null;
};

// Both tools report paths relative to the crate root. Anything else (absolute,
// `..`, or a differently rooted relative path) is not taken as the same file.
const relativePath = (file) => {
  const normal = path.posix.normalize(file).replace(/^\.\//, '');
  return path.posix.isAbsolute(normal) || normal.split('/').includes('..') ? null : normal;
};

function spanAgreement(atomSpan, source) {
  if (!atomSpan) return 'missing';
  const [a, b] = [relativePath(atomSpan.file), relativePath(source.file)];
  if (a === null || b === null) return 'unsupported-path';
  return a === b && atomSpan.beginLine === source.begin_line && atomSpan.endLine === source.end_line ? 'match' : 'mismatch';
}

// Loop helpers must pair up (one body and one wrapper per loop id) under the
// primary, and every declaration the other evidence ties to this Rust item or
// to its loop helpers must be in the family, so a dropped helper cannot hide.
function missingFamilyMembers(family, primary, functions, leanAtom) {
  const names = new Set(family.map((f) => f.lean_name));
  const missing = new Set();
  // Each member needs its own corroboration: a probe-lean atom with a dependency
  // list and a functions.json record. Absent evidence is reported, never read as
  // "no dependencies".
  for (const f of family) {
    const atom = leanAtom(f.lean_name);
    if (!atom) missing.add(`lean-atom:${f.lean_name}`);
    else if (!Array.isArray(atom.dependencies) || atom.dependencies.some((d) => typeof d !== 'string')) missing.add(`lean-dependencies:${f.lean_name}`);
    if (!functions.json.functions.some((r) => r.lean_name === f.lean_name)) missing.add(`functions-record:${f.lean_name}`);
  }
  const loops = new Map();
  for (const f of family.filter((g) => g.loop !== undefined)) {
    if (f.parent_lean_name !== primary.lean_name) missing.add(`parent-of:${f.lean_name}`);
    loops.set(f.loop.id, [...(loops.get(f.loop.id) ?? []), f.loop.is_body]);
  }
  for (const [id, kinds] of loops) {
    if (kinds.length !== 2 || !kinds.includes(true) || !kinds.includes(false)) missing.add(`loop-${id}-pair`);
  }
  for (const f of functions.json.functions) {
    if (f.rust_name === primary.rust_name && !names.has(f.lean_name)) missing.add(f.lean_name);
  }
  const helperPrefix = `probe:${primary.lean_name}_loop`;
  for (const f of family) {
    const deps = leanAtom(f.lean_name)?.dependencies;
    for (const dep of Array.isArray(deps) ? deps : []) {
      // A non-string entry is already reported as lean-dependencies above.
      if (typeof dep === 'string' && dep.startsWith(helperPrefix) && !names.has(dep.slice('probe:'.length))) missing.add(dep.slice('probe:'.length));
    }
  }
  return [...missing].sort();
}

function correspondenceOf(reasons) {
  if (reasons.some((r) => CONFLICT.has(r))) return 'conflict';
  if (reasons.some((r) => AMBIGUOUS.has(r))) return 'ambiguous';
  if (reasons.includes('mapping-method-not-def-id')) return 'fallback-only';
  if (reasons.includes('family-incomplete')) return 'incomplete';
  if (reasons.some((r) => UNSUPPORTED.has(r))) return 'unsupported';
  return 'exact';
}

const spanData = (span) => {
  const data = span?.Untagged?.data ?? span?.data ?? span;
  return isObject(data) && isId(data.file_id) && isObject(data.beg) && isObject(data.end) ? data : null;
};

const isGeneric = (decl) => ['types', 'const_generics'].some((key) => Array.isArray(decl?.generics?.[key]) && decl.generics[key].length > 0);

// Same-extraction binding. The state's extraction.run is the attempt the patch
// engine recorded (controlled environment, supported configuration, ordered
// stages, fresh outputs) and re-validated before record-extraction stored it.
// The given files must be that attempt's outputs, and the LLBC must agree with
// the manifest's source and with translation.json by content. A disagreement
// blocks; a missing or unsupported attempt leaves the record unbound.
function bindRun({ state, manifest, translation, llbc, t }) {
  const decls = new Map();
  for (const decl of llbc?.json.translated.fun_decls ?? []) if (isObject(decl) && isId(decl.def_id)) decls.set(decl.def_id, decl);
  const extraction = state ? state.json.extraction ?? state.json.state?.extraction : null;
  const run = extraction?.run;
  if (!run) return { binding: { status: 'unbound', reasons: UNBOUND_WITHOUT_ATTEMPT }, blocks: [], decls };
  const reasons = [];
  const blocks = [];
  const block = (code, message) => blocks.push({ code, message });
  // The published set must be exactly translation.json and every Lean file it names.
  // validate() has required a relative .lean path for every local function and for any lean_file given elsewhere.
  const leanFiles = [...new Set(TRANSLATION_SECTIONS
    .flatMap((key) => (Array.isArray(t[key]) ? t[key] : []).map((entry) => entry?.lean_file)).filter((file) => file !== undefined))];
  const publishedDir = path.dirname(run.translation.projectPath);
  const expected = [run.translation.projectPath, ...leanFiles.map((file) => path.join(publishedDir, file))].sort();
  if (JSON.stringify(run.publication.map((entry) => entry.projectPath).sort()) !== JSON.stringify(expected)) {
    block('run-publication-mismatch', 'the recorded publication is not exactly translation.json and the Lean files it names');
  }
  if (extraction.status !== 'succeeded') reasons.push('extraction-not-succeeded');
  if (!run.supported || run.residuals.length > 0) reasons.push('unsupported-configuration');
  if (!llbc) reasons.push('no-llbc');
  if (run.manifestSha256 !== manifest?.sha256) block('run-manifest-mismatch', 'the recorded attempt was prepared from a different manifest');
  if (run.translation.sha256 !== translation.sha256) block('run-translation-mismatch', 'translation.json is not the one the recorded attempt published');
  if (sha256Text(JSON.stringify(run.config)) !== run.configSha256) block('run-config-mismatch', 'the recorded attempt configuration does not match its hash');
  if (llbc) {
    const { translated } = llbc.json;
    if (run.llbc.sha256 !== llbc.sha256) block('run-llbc-mismatch', 'the LLBC is not the one the recorded attempt produced');
    if (llbc.json.charon_version !== t.charon_version) block('llbc-charon-version-mismatch', `LLBC charon_version ${llbc.json.charon_version} differs from translation.json ${t.charon_version}`);
    if (translated.options.dest_file !== run.llbc.path) block('llbc-dest-mismatch', 'the LLBC names another output path than the recorded attempt');
    const files = new Map(translated.files.filter(isObject).map((file) => [file.id, file]));
    const finalFiles = manifest?.json.final?.files ?? {};
    // Every source a local function is declared in, whatever its crate label, plus every file labelled
    // with the crate, must carry the manifest's prepared contents.
    const referenced = new Set(t.functions.filter((fn) => fn.is_local).map((fn) => spanData(decls.get(fn.def_id)?.item_meta?.span)?.file_id).filter((id) => id !== undefined));
    for (const [id, file] of files) {
      if (!referenced.has(id) && file.crate_name !== t.crate) continue;
      if (referenced.has(id) && file.crate_name !== t.crate) block('llbc-source-label-mismatch', `the LLBC labels the source of a local function (file ${id}) with crate ${JSON.stringify(file.crate_name)}, not ${JSON.stringify(t.crate)}`);
      if (typeof file.contents !== 'string' || typeof file.name?.Local !== 'string') {
        if (referenced.has(id)) block('llbc-source-missing', `the LLBC holds no contents or name for file ${id}`);
        continue;
      }
      if (finalFiles[file.name.Local]?.sha256 !== sha256Text(file.contents)) block('llbc-source-mismatch', `the LLBC's ${file.name.Local} is not the manifest's prepared source`);
    }
    for (const f of t.functions.filter((fn) => fn.is_local)) {
      const decl = decls.get(f.def_id);
      const span = spanData(decl?.item_meta?.span);
      if (span && typeof files.get(span.file_id)?.contents !== 'string') block('llbc-source-missing', `the LLBC holds no contents for the source of def_id ${f.def_id}`);
      const file = span ? files.get(span.file_id)?.name?.Local : undefined;
      const linesDiffer = f.loop === undefined && (span?.beg.line !== f.source.begin_line || span?.end.line !== f.source.end_line);
      if (!decl || file !== f.source.file || linesDiffer) block('llbc-function-mismatch', `def_id ${f.def_id} (${f.lean_name}) does not match the LLBC's fun_decls by file and span`);
    }
  }
  const bound = reasons.length === 0 && blocks.length === 0;
  return {
    binding: bound
      // Lean bodies are bound only through these published-file hashes: the probe
      // outputs carry identity facts, not file hashes, so a consumer reading the
      // generated Lean must check it against generatedLean.
      ? { status: 'bound', reasons: [], trust: run.trust, configSha256: run.configSha256, generatedLean: run.publication.map(({ projectPath, sha256 }) => ({ projectPath, sha256 })) }
      : { status: 'unbound', reasons: reasons.length > 0 ? reasons : ['inputs-disagree-with-attempt'], residuals: run.residuals },
    blocks,
    decls,
  };
}

// A Lean project may move on from the Rust source commit (for example a committed
// specification module). That is accepted only when the record is bound to the
// recorded attempt and the ticket 21 run receipt shows probe-lean analysed this
// lean.json at that commit, with every published generated file byte-identical to
// what the attempt published (paths relative to the crate root the engine recorded).
// Returns what is missing; empty means covered.
function leanCommitGaps({ binding, state, lean, leanReceipt }) {
  if (binding.status !== 'bound') return ['the record is bound to a recorded extraction attempt'];
  if (!leanReceipt) return ['a ticket 21 run receipt (--lean-receipt) covers the published Lean files'];
  const r = leanReceipt.json;
  const extraction = state.json.extraction ?? state.json.state?.extraction;
  const gaps = [];
  if (r.inputs.leanProjectCommit !== lean.json.source?.commit) gaps.push(`the receipt records the same Lean project commit (it records ${r.inputs.leanProjectCommit})`);
  if (r.outputs.extractSha256 !== lean.sha256) gaps.push('the receipt records this probe-lean output');
  if (r.probe.exitCode !== 0 || r.lakeBuild.exitCode !== 0) gaps.push('the receipted lake build and probe-lean run succeeded');
  const root = extraction?.inputs?.crateRoot;
  for (const entry of extraction?.run?.publication ?? []) {
    const relative = typeof root === 'string' ? path.relative(root, entry.projectPath) : '..';
    if (relative.startsWith('..') || path.isAbsolute(relative)) gaps.push(`${entry.projectPath} lies under the recorded crate root`);
    else if (r.inputs.files[relative] !== entry.sha256) gaps.push(`the receipt analysed ${relative} at its published hash`);
  }
  return gaps;
}

// The public entry point: validates its input, then builds the record. Throws a
// Refusal with code `invalid-input` for any input the qualified tools would not emit.
export function buildRecord(input) {
  validate(input);
  const { translation, manifest, rust, mappings, lean, functions, state, llbc, leanReceipt, sourceCommit } = input;
  const t = translation.json;
  const blockers = [];
  const block = (code, message) => blockers.push({ code, message });
  const pkg = rust.json.source?.package;
  const prefix = `probe:${pkg}/${rust.json.source?.['package-version']}/`;
  const atoms = Object.entries(rust.json.data ?? {}).filter(([name]) => name.startsWith(prefix));
  const localFunctions = (Array.isArray(t.functions) ? t.functions : []).filter((f) => f.is_local === true);

  const provenance = {
    sourceCommit,
    manifestSha256: manifest?.sha256 ?? null,
    translationSha256: translation.sha256,
    charonVersion: t.charon_version || null,
    aeneasVersion: t.aeneas_version || null,
    crate: t.crate ?? null,
    rustSha256: rust.sha256,
    mappingsSha256: mappings.sha256,
    leanSha256: lean?.sha256 ?? null,
    functionsSha256: functions?.sha256 ?? null,
    leanProjectCommit: typeof lean.json.source?.commit === 'string' ? lean.json.source.commit : null,
    llbcSha256: llbc?.sha256 ?? null,
    configSha256: null,
    callerConfigSha256: input.configSha256 ?? null,
    probeRustVersion: rust.json.tool?.version ?? null,
    probeAeneasVersion: mappings.json.tool?.version ?? null,
    linkage: 'triangulated',
    // A capability limit, not a gate: without the LLBC no input carries type parameters.
    gaps: llbc ? [] : ['type-genericity-not-exposed'],
  };
  const { binding, blocks: bindingBlocks, decls } = bindRun({ state, manifest, translation, llbc, t });
  if (binding.status === 'bound') {
    provenance.configSha256 = binding.configSha256;
    provenance.generatedLean = binding.generatedLean;
    provenance.linkage = 'recorded-attempt';
  }

  if (!manifest) block('missing-manifest', 'no patch-engine manifest: the extraction inputs are unbound');
  if (!t.charon_version) block('missing-charon-version', 'translation.json records no charon_version, so def_ids have no provenance');
  if (manifest) {
    const m = manifest.json.source ?? {};
    if (m.commit !== sourceCommit) block('source-commit-mismatch', `manifest source commit ${m.commit} differs from ${sourceCommit}`);
    if (Array.isArray(m.dirty) && m.dirty.length > 0) block('dirty-source', `manifest records uncommitted source changes: ${m.dirty.join(', ')}`);
  }
  if (rust.json.source?.commit !== sourceCommit) block('source-commit-mismatch', `probe-rust source commit ${rust.json.source?.commit} differs from ${sourceCommit}`);
  if (lean.json.source?.commit !== sourceCommit) {
    const gaps = leanCommitGaps({ binding, state, lean, leanReceipt });
    if (gaps.length > 0) block('source-commit-mismatch', `probe-lean source commit ${lean.json.source?.commit} differs from ${sourceCommit}, and that is accepted only when ${gaps.join('; ')}`);
    else provenance.leanReceiptSha256 = leanReceipt.sha256;
  }
  if (t.crate !== pkg) block('crate-mismatch', `translation.json crate ${JSON.stringify(t.crate)} is not the probed package ${JSON.stringify(pkg)}`);
  if (state) {
    const recorded = state.json.extraction ?? state.json.state?.extraction;
    if (!recorded?.inputs) block('state-without-extraction', 'the state records no extraction to bind to');
    else {
      if (recorded.inputs.manifestSha256 !== provenance.manifestSha256) block('manifest-mismatch', 'the state records a different manifest sha256');
      if (recorded.inputs.sourceCommit !== sourceCommit) block('source-commit-mismatch', `state source commit ${recorded.inputs.sourceCommit} differs from ${sourceCommit}`);
    }
  }
  for (const [name, atom] of atoms) {
    const hasId = atom['charon-def-id'] !== undefined;
    if ((hasId || atom['charon-version'] !== undefined) && atom['charon-version'] !== t.charon_version) {
      block('charon-version-mismatch', `${name} carries charon-version ${JSON.stringify(atom['charon-version'])}, translation.json ${JSON.stringify(t.charon_version)}`);
    }
  }
  for (const { code, message } of bindingBlocks) block(code, message);
  if (localFunctions.length === 0) block('empty-discovery', 'translation.json lists no local functions');
  if (atoms.length === 0) block('empty-discovery', `probe-rust lists no atoms of package ${JSON.stringify(pkg)}`);

  const record = {
    schema: 'fvs-rust-identity/record',
    version: 1,
    status: 'blocked',
    provenance,
    binding,
    blockers,
    items: [],
    unkeyedRustAtoms: [],
    orphanRustAtoms: [],
    externals: [],
    outOfScope: (Array.isArray(t.functions) ? t.functions : []).filter((f) => f.is_local !== true)
      .map((f) => ({ defId: f.def_id, rustName: f.rust_name ?? null, leanName: f.lean_name ?? null })),
  };
  if (blockers.length > 0) return record;

  // Every distinct mapping row per Rust atom: identical duplicate rows collapse,
  // competing rows make the atom ambiguous whatever their order.
  const rowsFor = new Map();
  for (const m of mappings.json.mappings) {
    const rows = rowsFor.get(m.from) ?? [];
    if (!rows.some((row) => row.to === m.to && row.method === m.method && row.confidence === m.confidence)) rows.push(m);
    rowsFor.set(m.from, rows);
  }
  const mappingFor = new Map([...rowsFor].filter(([, rows]) => rows.length === 1).map(([from, [row]]) => [from, row]));
  const claims = new Map();
  for (const [name] of atoms) {
    for (const to of new Set((rowsFor.get(name) ?? []).map((row) => row.to))) claims.set(to, (claims.get(to) ?? 0) + 1);
  }
  const leanAtom = (leanName) => lean.json.data[`probe:${leanName}`] ?? null;
  const functionsRecord = (leanName) => functions.json.functions.find((f) => f.lean_name === leanName) ?? null;
  const byId = new Map();
  for (const f of localFunctions) byId.set(f.def_id, [...(byId.get(f.def_id) ?? []), f]);
  const keyed = new Map();
  for (const [name, atom] of atoms) {
    const id = atom['charon-def-id'];
    if (id === undefined) {
      const rows = rowsFor.get(name) ?? [];
      record.unkeyedRustAtoms.push({
        rustAtom: name,
        rustQualifiedName: atom['rust-qualified-name'] ?? null,
        mapping: rows.length === 1 ? rows[0] : null,
        mappingCandidates: rows,
        correspondence: rows.length === 0 ? 'unmatched' : rows.length === 1 ? 'fallback-only' : 'ambiguous',
      });
    } else keyed.set(id, [...(keyed.get(id) ?? []), name]);
  }
  for (const [id, names] of keyed) {
    if (!byId.has(id)) record.orphanRustAtoms.push({ defId: id, rustAtoms: names });
  }

  for (const [defId, family] of [...byId].sort(([a], [b]) => a - b)) {
    const primaries = family.filter((f) => f.loop === undefined);
    const primary = primaries.length === 1 ? primaries[0] : null;
    const reasons = [];
    if (primaries.length > 1) reasons.push('non-loop-split');
    if (primaries.length === 0) reasons.push('no-primary');
    if (family.some((f) => f.is_rec === true)) reasons.push('recursion');
    if (isGeneric(decls.get(defId))) reasons.push('type-generic');
    const missingGenerated = primary ? missingFamilyMembers(family, primary, functions, leanAtom) : [];
    if (missingGenerated.length > 0) reasons.push('family-incomplete');
    const candidates = keyed.get(defId) ?? [];
    const entry = {
      defId,
      rustName: (primary ?? family[0]).rust_name ?? null,
      source: (primary ?? family[0]).source ?? null,
      target: primary?.lean_name ?? null,
      opaque: family.some((f) => f.is_opaque === true),
      generated: family.map((f) => ({
        leanName: f.lean_name,
        loop: f.loop ?? null,
        parentLeanName: f.parent_lean_name ?? null,
        isRec: f.is_rec ?? null,
        isOpaque: f.is_opaque ?? null,
        dependencies: leanAtom(f.lean_name)?.dependencies ?? null,
        lean: leanAtom(f.lean_name),
        functionsRecord: functionsRecord(f.lean_name),
      })),
      missingGenerated,
      rustAtom: null,
      rustQualifiedName: null,
      candidates,
      mapping: null,
      corroboration: null,
      correspondence: 'unmatched',
      reasons,
    };
    if (entry.opaque) record.externals.push({ defId, rustName: entry.rustName, leanNames: family.map((f) => f.lean_name) });
    record.items.push(entry);
    if (candidates.length === 0) {
      reasons.push('no-rust-atom');
      continue;
    }
    if (candidates.length > 1) {
      reasons.push('duplicate-charon-def-id');
      entry.correspondence = 'ambiguous';
      continue;
    }
    const [name] = candidates;
    const atom = rust.json.data[name];
    entry.rustAtom = name;
    entry.rustQualifiedName = atom['rust-qualified-name'] ?? null;
    entry.mapping = mappingFor.get(name) ?? null;
    const span = primary ? spanAgreement(spanOf(atom), primary.source) : 'missing';
    entry.corroboration = {
      span,
      name: entry.rustQualifiedName === null ? 'missing' : entry.rustQualifiedName === entry.rustName ? 'equal' : 'differs',
    };
    const rows = rowsFor.get(name) ?? [];
    if (rows.length > 1) {
      entry.mappingCandidates = rows;
      reasons.push('conflicting-mappings');
      entry.correspondence = 'ambiguous';
      continue;
    }
    if (!entry.mapping) {
      reasons.push('no-mapping');
      continue;
    }
    if (primary) {
      if (span === 'mismatch') reasons.push('span-mismatch');
      if (span === 'missing') reasons.push('span-missing');
      if (span === 'unsupported-path') reasons.push('span-path-unsupported');
      if (entry.mapping.to !== `probe:${primary.lean_name}`) reasons.push('mapping-target-differs');
    }
    if (claims.get(entry.mapping.to) > 1) reasons.push('lean-target-claimed-twice');
    if (entry.mapping.method !== DEF_ID_METHOD) reasons.push('mapping-method-not-def-id');
    entry.correspondence = correspondenceOf(reasons);
  }

  if (record.items.some((entry) => entry.correspondence === 'conflict')) {
    block('correspondence-conflict', 'def_id, span or Lean target disagree: the inputs do not describe one extraction');
  }
  const allExact = record.items.every((entry) => entry.correspondence === 'exact')
    && record.unkeyedRustAtoms.length === 0 && record.orphanRustAtoms.length === 0;
  record.status = blockers.length > 0 ? 'blocked' : !allExact ? 'partial' : binding.status === 'bound' ? 'complete' : 'unbound';
  return record;
}

function parseFlags(argv) {
  const known = ['source-commit', 'translation', 'manifest', 'rust', 'mappings', 'lean', 'functions', 'config', 'state', 'llbc', 'lean-receipt', 'out', 'format'];
  const flags = {};
  const rest = [...argv];
  while (rest.length > 0) {
    const flag = rest.shift();
    const key = flag.replace(/^--/, '');
    if (!known.includes(key) || key === flag) refuse('usage', `unknown argument ${JSON.stringify(flag)}`);
    const value = rest.shift();
    if (!value || value.startsWith('--')) refuse('usage', `${flag} requires a value`);
    flags[key] = value;
  }
  // --manifest is required on the command line, but a missing file is a blocked
  // record rather than a usage error, so the gap is reported, not hidden.
  for (const key of ['source-commit', 'translation', 'manifest', 'rust', 'mappings', 'lean', 'functions']) if (!flags[key]) refuse('usage', `--${key} is required`);
  if (!/^[0-9a-f]{40}$/.test(flags['source-commit'])) refuse('usage', '--source-commit must be a full 40-character commit');
  if (flags.format && !['json', 'text'].includes(flags.format)) refuse('usage', '--format must be json or text');
  return flags;
}

function writeAtomic(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text, { flag: 'wx' });
  fs.renameSync(tmp, file);
}

function record(flags) {
  const inputs = {
    sourceCommit: flags['source-commit'],
    translation: readInput(flags.translation, 'translation.json'),
    manifest: fs.existsSync(flags.manifest) ? readInput(flags.manifest, 'manifest') : null,
    rust: readInput(flags.rust, 'probe-rust output'),
    mappings: readInput(flags.mappings, 'probe-aeneas translate output'),
    lean: readInput(flags.lean, 'probe-lean output'),
    functions: readInput(flags.functions, 'functions.json'),
    state: flags.state ? readInput(flags.state, 'state') : null,
    llbc: flags.llbc ? readInput(flags.llbc, 'llbc') : null,
    leanReceipt: flags['lean-receipt'] ? readInput(flags['lean-receipt'], 'lean receipt') : null,
    configSha256: flags.config ? sha256File(flags.config) : null,
  };
  const rec = buildRecord(inputs);
  if (flags.out) writeAtomic(flags.out, `${JSON.stringify(rec, null, 2)}\n`);
  const counts = {};
  for (const entry of rec.items) counts[entry.correspondence] = (counts[entry.correspondence] ?? 0) + 1;
  const tally = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'no functions';
  const message = rec.status === 'blocked'
    ? rec.blockers.map((b) => b.code).join(', ')
    : `${tally}; ${rec.unkeyedRustAtoms.length} unkeyed, ${rec.orphanRustAtoms.length} orphan Rust atom(s); same-extraction binding: ${rec.binding.status}`;
  return { code: rec.status === 'complete' ? 'ok' : rec.status, message, record: rec };
}

function main(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }
  let format = 'json';
  let result;
  try {
    if (argv[0] !== 'record') refuse('usage', `unknown command ${JSON.stringify(argv[0])}`);
    const flags = parseFlags(argv.slice(1));
    format = flags.format ?? 'json';
    const outcome = record(flags);
    result = { ok: outcome.code === 'ok', command: 'record', ...outcome };
  } catch (error) {
    result = error instanceof Refusal
      ? { ok: false, code: error.code, command: argv[0], message: error.message }
      : { ok: false, code: 'internal', command: argv[0], message: error.message };
  }
  if (format === 'text') {
    const lines = [`FVS >> ${result.code}: ${result.message}`];
    for (const entry of result.record?.items ?? []) {
      lines.push(`  ${entry.correspondence.padEnd(13)} ${entry.defId} ${entry.rustName} -> ${entry.target ?? '-'}${entry.reasons.length ? ` (${entry.reasons.join(', ')})` : ''}`);
    }
    process.stdout.write(`${lines.join('\n')}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  if (!['ok', 'partial', 'blocked', 'unbound'].includes(result.code)) process.stderr.write(`FVS >> ${result.code}: ${result.message}\n`);
  process.exitCode = EXIT[result.code];
}

function invokedDirectly() {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) main(process.argv.slice(2));
