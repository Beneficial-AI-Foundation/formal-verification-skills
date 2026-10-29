#!/usr/bin/env node
'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { readProvenance } from './fvs-probe-inventory.mjs';

// The only interface qualified so far: probe-lean 0.14.0 `extract` (Lean 4.31.0
// build), Schema 3.0. Anything else is reported unsupported, never projected.
const QUALIFIED = { schema: 'probe-lean/extract', schemaVersion: '3.0', tool: 'probe-lean', version: '0.14.0' };

// Semantic-definition closure of a theorem: the declarations its statement
// means. Start from the theorem's type-dependencies; through a definition follow
// both its type and its term dependencies (its value is part of its meaning);
// through a theorem follow its type-dependencies only (proofs are irrelevant).
const CLOSURE_RULE = 'root: type-dependencies; theorem: type-dependencies; other kinds: type-dependencies + term-dependencies';

function usage() {
  process.stdout.write([
    'Usage: node fvs-lean-graph.mjs LEAN.json --library NAME[,NAME...]',
    '  --log PROBE_LEAN_LOG --project-root DIR [--manifest PATCH_MANIFEST.json]',
    '',
    'Builds the Lean declaration and dependency record from a probe-lean 0.14.0',
    '`extract` output. --library names the Lean module roots that must have been',
    'built and analysed (the Aeneas output library, and any specification library);',
    '--log is the captured probe-lean output; --project-root locates translation.json',
    'through aeneas-config.yml. Prints the record as JSON. Exit 0 only when the',
    'record is complete; 1 when it is incomplete or unsupported; 2 on usage errors.',
  ].join('\n') + '\n');
}

function fatal(message) {
  throw Object.assign(new Error(message), { usage: true });
}

function parseArgs(argv) {
  const args = { extract: null, libraries: [], log: null, projectRoot: null, manifest: null };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith('--')) args.extract = rest.shift();
  while (rest.length > 0) {
    const flag = rest.shift();
    const value = rest.shift();
    if (!value || value.startsWith('--')) fatal(`${flag} requires a value`);
    if (flag === '--library') args.libraries.push(...value.split(',').filter(Boolean));
    else if (flag === '--log') args.log = value;
    else if (flag === '--project-root') args.projectRoot = value;
    else if (flag === '--manifest') args.manifest = value;
    else fatal(`unknown argument ${JSON.stringify(flag)}`);
  }
  if (!args.extract) fatal('a probe-lean extract JSON path is required');
  if (args.libraries.length === 0) fatal('--library is required');
  return args;
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const sorted = (values) => [...new Set(values)].sort();
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = (atom, field) => (Array.isArray(atom[field]) ? atom[field] : []);

// What the probe-lean log says about the run. The extract JSON does not record
// which libraries were built, so this is the only completeness evidence for it.
export function readLog(text) {
  if (typeof text !== 'string') return null;
  const built = /^Building libraries: ?(.*)$/m.exec(text);
  const wrote = /^Wrote (\d+) unified atoms to /m.exec(text);
  return {
    builtLibraries: built ? built[1].split(/[,\s]+/).filter(Boolean) : null,
    buildSkipped: /^Build cache is up-to-date, skipping lake build/m.test(text),
    writtenAtoms: wrote ? Number(wrote[1]) : null,
  };
}

function translationNames(file) {
  const translation = JSON.parse(fs.readFileSync(file, 'utf8'));
  return sorted(['functions', 'types', 'globals', 'trait_decls', 'trait_impls']
    .flatMap((section) => (Array.isArray(translation[section]) ? translation[section] : []))
    .map((entry) => entry?.lean_name)
    .filter((name) => typeof name === 'string' && name)
    .map((name) => `probe:${name}`));
}

function closureOf(root, data, extracted) {
  const declarations = new Set();
  const external = new Set(list(data[root], 'type-dependencies-external'));
  const queue = [...list(data[root], 'type-dependencies')];
  while (queue.length > 0) {
    const id = queue.shift();
    if (declarations.has(id) || id === root) continue;
    declarations.add(id);
    const atom = data[id];
    if (!atom) continue;
    const fields = atom.kind === 'theorem' ? ['type-dependencies'] : ['type-dependencies', 'term-dependencies'];
    for (const field of fields) queue.push(...list(atom, field));
    for (const field of fields) list(atom, `${field}-external`).forEach((dep) => external.add(dep));
  }
  // Only the edges this closure follows can block it.
  const blockers = [...declarations].filter((id) => !data[id])
    .concat([...external].filter((id) => extracted.has(id)))
    .sort().map((id) => ({ code: 'unresolved-edge', dependency: id }));
  return { rule: CLOSURE_RULE, declarations: sorted(declarations), external: sorted(external), blockers };
}

export function buildLeanGraph({ extractText, logText = null, libraries, projectRoot = null, manifestPath = null }) {
  const blockers = [];
  const block = (code, reason, extra = {}) => blockers.push({ code, reason, ...extra });
  const record = {
    schema: 'fvs/lean-graph',
    schemaVersion: 1,
    state: null,
    blockers,
    qualifiedInterface: QUALIFIED,
    tool: null,
    source: null,
    timestamp: null,
    provenance: { sourceCommit: null, translationSha256: null, charonVersion: null, aeneasVersion: null, manifestSha256: null },
    completeness: { libraries: sorted(libraries), log: readLog(logText), atomCount: null, translationDeclarations: null, missingDeclarations: [] },
    declarations: {},
    edges: [],
    external: [],
    anomalies: [],
    closures: {},
  };
  const finish = () => {
    record.state = record.state ?? (blockers.length === 0 ? 'complete' : 'incomplete');
    for (const closure of Object.values(record.closures)) {
      if (blockers.length > 0) closure.blockers.unshift({ code: 'graph-incomplete' });
      closure.state = closure.blockers.length === 0 ? 'complete' : 'incomplete';
    }
    return record;
  };

  let envelope;
  try {
    envelope = JSON.parse(extractText);
  } catch (error) {
    block('unreadable-extract', `the extract is not valid JSON (empty or truncated output?): ${error.message}`);
    return finish();
  }
  if (!plainObject(envelope)) {
    block('unreadable-extract', 'the extract is not a JSON object');
    return finish();
  }
  record.tool = envelope.tool ?? null;
  record.source = envelope.source ?? null;
  record.timestamp = envelope.timestamp ?? null;
  const mismatch = [
    envelope.schema !== QUALIFIED.schema && `schema ${JSON.stringify(envelope.schema)}`,
    envelope['schema-version'] !== QUALIFIED.schemaVersion && `schema-version ${JSON.stringify(envelope['schema-version'])}`,
    (envelope.tool?.name !== QUALIFIED.tool || envelope.tool?.command !== 'extract') && `tool ${JSON.stringify(envelope.tool?.name)} ${JSON.stringify(envelope.tool?.command)}`,
    envelope.tool?.version !== QUALIFIED.version && `version ${JSON.stringify(envelope.tool?.version)}`,
  ].filter(Boolean);
  if (mismatch.length > 0) {
    record.state = 'unsupported';
    block('unqualified-interface', `only probe-lean ${QUALIFIED.version} extract Schema ${QUALIFIED.schemaVersion} is qualified; got ${mismatch.join(', ')}`);
    return finish();
  }
  const data = envelope.data;
  if (!plainObject(data) || Object.values(data).some((atom) => !plainObject(atom))) {
    block('unreadable-extract', 'data must be an object of atom objects');
    return finish();
  }
  record.declarations = data;
  const ids = Object.keys(data).sort();
  record.completeness.atomCount = ids.length;
  if (ids.length === 0) block('empty-extract', 'the extract holds no declarations');

  // Provenance, so a consumer can bind this graph to the same extraction as the
  // Rust identity record. Null fields are absent evidence, never defaults.
  const commit = envelope.source?.commit;
  record.provenance.sourceCommit = typeof commit === 'string' && commit ? commit : null;
  if (record.provenance.sourceCommit === null) block('no-source-commit', 'the extract records no source commit');
  if (manifestPath) record.provenance.manifestSha256 = sha256(fs.readFileSync(manifestPath));
  let expected = null;
  if (!projectRoot) {
    block('no-translation', 'no --project-root: translation.json provenance and declaration coverage are not established');
  } else {
    const found = readProvenance(projectRoot);
    record.provenance.translationSha256 = found.translationSha256;
    record.provenance.charonVersion = found.charonVersion;
    record.provenance.aeneasVersion = found.aeneasVersion;
    for (const problem of found.problems) block('provenance', problem);
    if (found.translationJson) {
      try {
        expected = translationNames(found.translationJson);
        record.completeness.translationDeclarations = expected.length;
      } catch (error) {
        block('provenance', `cannot read translation.json declarations: ${error.message}`);
      }
    }
  }

  // Which libraries were built and analysed.
  const log = record.completeness.log;
  if (log === null) {
    block('no-log', 'no probe-lean log: which libraries were built and analysed is not established');
  } else {
    if (log.writtenAtoms === null) block('log-incomplete', 'the log does not report the written atoms; the run may not have finished');
    else if (log.writtenAtoms !== ids.length) block('atom-count-mismatch', `the log reports ${log.writtenAtoms} atoms, the extract holds ${ids.length}`);
    if (log.builtLibraries !== null) {
      for (const library of record.completeness.libraries.filter((name) => !log.builtLibraries.includes(name))) {
        block('library-not-built', `library ${library} was not built by this run (built: ${log.builtLibraries.join(', ') || 'none'}); any of its declarations come from an earlier build`, { library });
      }
    } else if (!log.buildSkipped) {
      block('library-build-unknown', 'the log reports neither the libraries built nor an up-to-date build cache');
    }
  }
  for (const library of record.completeness.libraries) {
    const analysed = ids.some((id) => String(data[id]['code-module'] ?? '').split('.')[0] === library);
    if (!analysed) block('library-not-analysed', `no declaration of library ${library} is in the extract`, { library });
  }
  if (expected) {
    record.completeness.missingDeclarations = expected.filter((id) => !data[id]);
    if (record.completeness.missingDeclarations.length > 0) {
      block('missing-declarations', `${record.completeness.missingDeclarations.length} declaration(s) named by translation.json are not in the extract`);
    }
  }

  // Edges, oriented from the dependent declaration to its dependency. A local
  // dependency absent from the extract, or an extracted declaration reported as
  // external (its library was not analysed), is unresolved.
  const extracted = new Set(expected ?? []);
  const unresolvedFrom = new Set();
  const external = new Set();
  for (const from of ids) {
    const atom = data[from];
    for (const kind of ['type', 'term']) {
      for (const to of list(atom, `${kind}-dependencies`)) {
        const resolution = data[to] ? 'local' : 'unresolved';
        if (resolution === 'unresolved') unresolvedFrom.add(from);
        record.edges.push({ from, to, kind, resolution });
      }
      for (const to of list(atom, `${kind}-dependencies-external`)) {
        const resolution = extracted.has(to) ? 'unresolved' : 'external';
        if (resolution === 'unresolved') unresolvedFrom.add(from);
        else external.add(to);
        record.edges.push({ from, to, kind, resolution });
      }
    }
    const union = sorted([...list(atom, 'type-dependencies'), ...list(atom, 'term-dependencies')]);
    if (JSON.stringify(sorted(list(atom, 'dependencies'))) !== JSON.stringify(union)) {
      record.anomalies.push({ code: 'dependencies-not-type-term-union', declaration: from });
    }
    if (extracted.has(from) && atom['is-aeneas-generated'] === false) {
      record.anomalies.push({ code: 'aeneas-generated-false-for-translation-declaration', declaration: from });
    }
  }
  record.external = sorted(external);
  for (const from of sorted(unresolvedFrom)) {
    const targets = record.edges.filter((edge) => edge.from === from && edge.resolution === 'unresolved').map((edge) => edge.to);
    block('unresolved-edge', `${from} depends on ${sorted(targets).join(', ')}, which the extract does not resolve`, { declaration: from });
  }
  for (const id of ids.filter((name) => data[name].kind === 'theorem')) {
    record.closures[id] = closureOf(id, data, extracted);
  }
  return finish();
}

function main(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }
  try {
    const args = parseArgs(argv);
    const record = buildLeanGraph({
      extractText: fs.readFileSync(args.extract, 'utf8'),
      logText: args.log ? fs.readFileSync(args.log, 'utf8') : null,
      libraries: args.libraries,
      projectRoot: args.projectRoot,
      manifestPath: args.manifest,
    });
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    if (record.state !== 'complete') {
      process.stderr.write(`FVS >> lean graph ${record.state}: ${record.blockers.map((item) => item.code).join(', ')}\n`);
    }
    process.exitCode = record.state === 'complete' ? 0 : 1;
  } catch (error) {
    process.stderr.write(`FVS_LEAN_GRAPH_ERROR: ${error.message}\n`);
    process.exitCode = 2;
  }
}

function invokedDirectly() {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) main(process.argv.slice(2));
