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

const EXIT = { ok: 0, usage: 2, internal: 2, 'invalid-input': 5, partial: 6, blocked: 7 };
const DEF_ID_METHOD = 'charon-def-id';
const CONFLICT = new Set(['span-mismatch', 'mapping-target-differs']);
const AMBIGUOUS = new Set(['duplicate-charon-def-id', 'lean-target-claimed-twice', 'span-missing']);
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
    '         --rust FILE --mappings FILE [--lean FILE] [--functions FILE] [--config FILE]',
    '         [--state FILE] [--out FILE] [--format json|text]',
    '',
    '--translation  Aeneas translation.json (-emit-json); its functions[] def_ids are the keys',
    '--manifest     fvs-extract-patches manifest.json of the same extraction',
    '--rust         probe-rust `extract --translation` output',
    '--mappings     probe-aeneas `translate` output (each mapping names its method)',
    '--lean, --functions  probe-lean extract output and probe-aeneas functions.json, kept verbatim',
    '--config       extraction configuration file whose sha256 is recorded',
    '--state        FVS auto state; its recorded manifest sha256 and source commit must agree',
    '',
    'Exit: 0 complete, 6 partial (some functions not exact), 7 blocked (provenance or',
    'correspondence conflict; no function is claimed), 5 invalid input, 2 usage.',
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

const spanOf = (atom) => (atom?.['code-path'] && atom['code-text']
  ? { file: atom['code-path'], beginLine: atom['code-text']['lines-start'], endLine: atom['code-text']['lines-end'] }
  : null);

function spanAgreement(atomSpan, source) {
  if (!atomSpan || !source?.file) return 'missing';
  const sameFile = atomSpan.file === source.file || atomSpan.file.endsWith(`/${source.file}`) || source.file.endsWith(`/${atomSpan.file}`);
  return sameFile && atomSpan.beginLine === source.begin_line && atomSpan.endLine === source.end_line ? 'match' : 'mismatch';
}

function correspondenceOf(reasons) {
  if (reasons.some((r) => CONFLICT.has(r))) return 'conflict';
  if (reasons.some((r) => AMBIGUOUS.has(r))) return 'ambiguous';
  if (reasons.includes('mapping-method-not-def-id')) return 'fallback-only';
  if (reasons.some((r) => UNSUPPORTED.has(r))) return 'unsupported';
  return 'exact';
}

export function buildRecord(input) {
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
    // The manifest binds the source and the patch series, not Aeneas's output, so
    // translation.json is tied to it only by agreeing commits, crate and Charon version.
    linkage: 'triangulated',
    // Facts no input records, so no item can be judged on them: the pinned tools
    // carry no type-parameter field, and neither the manifest nor the state names
    // the configuration that produced the LLBC (configSha256 is the caller's word).
    gaps: ['type-genericity-not-exposed', 'extraction-configuration-not-bound'],
  };

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
    blockers,
    items: [],
    unkeyedRustAtoms: [],
    orphanRustAtoms: [],
    externals: [],
    outOfScope: (Array.isArray(t.functions) ? t.functions : []).filter((f) => f.is_local !== true)
      .map((f) => ({ defId: f.def_id, rustName: f.rust_name ?? null, leanName: f.lean_name ?? null })),
  };
  if (blockers.length > 0) return record;

  const mappingFor = new Map((mappings.json.mappings ?? []).map((m) => [m.from, m]));
  const claims = new Map();
  for (const [name] of atoms) {
    const to = mappingFor.get(name)?.to;
    if (to) claims.set(to, (claims.get(to) ?? 0) + 1);
  }
  const leanAtom = (leanName) => lean?.json.data?.[`probe:${leanName}`] ?? null;
  const functionsRecord = (leanName) => (functions?.json.functions ?? []).find((f) => f.lean_name === leanName) ?? null;
  const byId = new Map();
  for (const f of localFunctions) byId.set(f.def_id, [...(byId.get(f.def_id) ?? []), f]);
  const keyed = new Map();
  for (const [name, atom] of atoms) {
    const id = atom['charon-def-id'];
    if (id === undefined) {
      const mapping = mappingFor.get(name) ?? null;
      record.unkeyedRustAtoms.push({ rustAtom: name, rustQualifiedName: atom['rust-qualified-name'] ?? null, mapping, correspondence: mapping ? 'fallback-only' : 'unmatched' });
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
    if (!entry.mapping) {
      reasons.push('no-mapping');
      continue;
    }
    if (primary) {
      if (span === 'mismatch') reasons.push('span-mismatch');
      if (span === 'missing') reasons.push('span-missing');
      if (entry.mapping.to !== `probe:${primary.lean_name}`) reasons.push('mapping-target-differs');
    }
    if (claims.get(entry.mapping.to) > 1) reasons.push('lean-target-claimed-twice');
    if (entry.mapping.method !== DEF_ID_METHOD) reasons.push('mapping-method-not-def-id');
    entry.correspondence = correspondenceOf(reasons);
  }

  if (record.items.some((entry) => entry.correspondence === 'conflict')) {
    block('correspondence-conflict', 'def_id, span or Lean target disagree: the inputs do not describe one extraction');
  }
  const complete = record.items.every((entry) => entry.correspondence === 'exact')
    && record.unkeyedRustAtoms.length === 0 && record.orphanRustAtoms.length === 0;
  record.status = blockers.length > 0 ? 'blocked' : complete ? 'complete' : 'partial';
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
  for (const key of ['source-commit', 'translation', 'manifest', 'rust', 'mappings']) if (!flags[key]) refuse('usage', `--${key} is required`);
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
  const optional = (key, label) => (flags[key] ? readInput(flags[key], label) : null);
  const rec = buildRecord({
    sourceCommit: flags['source-commit'],
    translation: readInput(flags.translation, 'translation.json'),
    manifest: fs.existsSync(flags.manifest) ? readInput(flags.manifest, 'manifest') : null,
    rust: readInput(flags.rust, 'probe-rust output'),
    mappings: readInput(flags.mappings, 'probe-aeneas translate output'),
    lean: optional('lean', 'probe-lean output'),
    functions: optional('functions', 'functions.json'),
    state: optional('state', 'state'),
    configSha256: flags.config ? sha256File(flags.config) : null,
  });
  if (flags.out) writeAtomic(flags.out, `${JSON.stringify(rec, null, 2)}\n`);
  const counts = {};
  for (const entry of rec.items) counts[entry.correspondence] = (counts[entry.correspondence] ?? 0) + 1;
  const tally = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'no functions';
  const message = rec.status === 'blocked'
    ? rec.blockers.map((b) => b.code).join(', ')
    : `${tally}; ${rec.unkeyedRustAtoms.length} unkeyed, ${rec.orphanRustAtoms.length} orphan Rust atom(s)`;
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
  if (!result.ok && !['partial', 'blocked'].includes(result.code)) process.stderr.write(`FVS >> ${result.code}: ${result.message}\n`);
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
