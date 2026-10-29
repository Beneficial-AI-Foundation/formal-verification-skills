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
// its charon-def-id join and the def_id, span and Lean target all agree.

const EXIT = { usage: 2, internal: 2, 'invalid-input': 5, partial: 6, blocked: 7, unbound: 8 };
const DEF_ID_METHOD = 'charon-def-id';
const CONFLICT = new Set(['span-mismatch', 'mapping-target-differs']);
const AMBIGUOUS = new Set(['duplicate-charon-def-id', 'lean-target-claimed-twice', 'span-missing', 'span-path-unsupported', 'conflicting-mappings']);
const UNSUPPORTED = new Set(['recursion', 'non-loop-split', 'no-primary']);

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
    '         [--state FILE] [--out FILE] [--format json|text]',
    '',
    '--translation  Aeneas translation.json (-emit-json); its functions[] def_ids are the keys',
    '--manifest     fvs-extract-patches manifest.json of the same extraction',
    '--rust         probe-rust `extract --translation` output',
    '--mappings     probe-aeneas `translate` output (each mapping names its method)',
    '--lean, --functions  probe-lean extract output and probe-aeneas functions.json: kept verbatim',
    '               and used to check that each Lean family is complete',
    '--config       extraction configuration file whose sha256 is recorded',
    '--state        FVS auto state; its recorded manifest sha256 and source commit must agree',
    '',
    'Exit: 8 unbound (every function maps exactly, but no input binds translation.json and the',
    'extraction configuration to the manifest, so same-extraction identity is not claimed),',
    '6 partial (some functions not exact), 7 blocked (provenance or correspondence conflict;',
    'no function is claimed), 5 invalid input, 2 usage. No outcome exits 0 yet.',
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

// Refuses an input whose envelope or identity fields are not the qualified shape,
// so a missing or mistyped field can never take part in a match.
function validate({ translation, manifest, rust, mappings, lean, functions, state, sourceCommit }) {
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
    if (!f.is_local) continue;
    const s = f.source;
    if (typeof f.is_rec !== 'boolean' || !isObject(s) || typeof s.file !== 'string' || !isLine(s.begin_line) || !isLine(s.end_line) || s.end_line < s.begin_line) {
      bad('translation.json', `${where} needs a boolean is_rec and a source with file and ordered line bounds`);
    }
    if (f.loop !== undefined && (!isObject(f.loop) || !isId(f.loop.id) || typeof f.loop.is_body !== 'boolean' || typeof f.parent_lean_name !== 'string')) {
      bad('translation.json', `${where} has a malformed loop entry`);
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
      if (dep.startsWith(helperPrefix) && !names.has(dep.slice('probe:'.length))) missing.add(dep.slice('probe:'.length));
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

// The public entry point: validates its input, then builds the record. Throws a
// Refusal with code `invalid-input` for any input the qualified tools would not emit.
export function buildRecord(input) {
  validate(input);
  const { translation, manifest, rust, mappings, lean, functions, state, sourceCommit } = input;
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
    configSha256: input.configSha256 ?? null,
    probeRustVersion: rust.json.tool?.version ?? null,
    probeAeneasVersion: mappings.json.tool?.version ?? null,
    linkage: 'triangulated',
    // A capability limit, not a gate: no pinned tool carries a type-parameter field.
    gaps: ['type-genericity-not-exposed'],
  };
  // Same-extraction identity needs translation.json and the configuration that
  // produced the LLBC bound to the manifest. No input records either: the manifest
  // binds only the source, translation.json is tied to it by agreeing commits,
  // crate, Charon version and spans, and configSha256 is the caller's word. Until an
  // interface binds them, a fully matched record is `unbound`, never complete.
  const binding = { status: 'unbound', reasons: ['translation-linkage-triangulated', 'extraction-configuration-not-bound'] };

  if (!manifest) block('missing-manifest', 'no patch-engine manifest: the extraction inputs are unbound');
  if (!t.charon_version) block('missing-charon-version', 'translation.json records no charon_version, so def_ids have no provenance');
  if (manifest) {
    const m = manifest.json.source ?? {};
    if (m.commit !== sourceCommit) block('source-commit-mismatch', `manifest source commit ${m.commit} differs from ${sourceCommit}`);
    if (Array.isArray(m.dirty) && m.dirty.length > 0) block('dirty-source', `manifest records uncommitted source changes: ${m.dirty.join(', ')}`);
  }
  if (rust.json.source?.commit !== sourceCommit) block('source-commit-mismatch', `probe-rust source commit ${rust.json.source?.commit} differs from ${sourceCommit}`);
  if (lean && lean.json.source?.commit !== sourceCommit) block('source-commit-mismatch', `probe-lean source commit ${lean.json.source?.commit} differs from ${sourceCommit}`);
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
  record.status = blockers.length > 0 ? 'blocked' : allExact ? binding.status : 'partial';
  return record;
}

function parseFlags(argv) {
  const known = ['source-commit', 'translation', 'manifest', 'rust', 'mappings', 'lean', 'functions', 'config', 'state', 'out', 'format'];
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
  return { code: rec.status, message, record: rec };
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
    result = { ok: false, command: 'record', ...outcome };
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
  if (!['partial', 'blocked', 'unbound'].includes(result.code)) process.stderr.write(`FVS >> ${result.code}: ${result.message}\n`);
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
