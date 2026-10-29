#!/usr/bin/env node
'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { readProvenance } from './fvs-probe-inventory.mjs';

// The only interface qualified so far: probe-lean 0.14.0 `extract` (Lean 4.31.0
// build), Schema 3.0. Anything else is reported unsupported, never projected.
const QUALIFIED = { schema: 'probe-lean/extract', schemaVersion: '3.0', tool: 'probe-lean', version: '0.14.0' };
const RECEIPT_SCHEMA = 'fvs/lean-probe-run';
const MANIFEST_SCHEMA = 'fvs-extract-patches/manifest';
const DEPENDENCY_FIELDS = ['type-dependencies', 'term-dependencies', 'type-dependencies-external',
  'term-dependencies-external', 'dependencies'];
// The declaration kinds a recorded fixture has qualified; closure traversal is
// defined for these only.
const QUALIFIED_KINDS = ['def', 'theorem'];
// Lake writes each module's .ilean, listing the declarations Lean elaborated in
// it, under this directory of the project's own build.
const ILEAN_DIR = '.lake/build/lib/lean';

// Semantic-definition closure of a theorem: the declarations its statement
// means. Start from the theorem's type-dependencies; through a definition follow
// both its type and its term dependencies (its value is part of its meaning);
// through a theorem follow its type-dependencies only (proofs are irrelevant).
const CLOSURE_RULE = 'root: type-dependencies; theorem: type-dependencies; other kinds: type-dependencies + term-dependencies';

function usage() {
  process.stdout.write([
    'Usage: node fvs-lean-graph.mjs LEAN.json --library NAME[,NAME...]',
    '  --log PROBE_LEAN_LOG --receipt RUN_RECEIPT.json --project-root DIR',
    '  [--manifest PATCH_MANIFEST.json]',
    '',
    'Builds the Lean declaration and dependency record from a probe-lean 0.14.0',
    '`extract` output. --library names the Lean module roots that must have been',
    'built and analysed (the Aeneas output library and any specification library;',
    'every project module must fall under one of them). --log is the captured',
    'probe-lean output and --receipt the fvs/lean-probe-run record written by the',
    'run that produced both; --project-root is the Lean project that run used.',
    '--manifest is the fvs-extract-patches manifest of the extraction. Prints the',
    'record as JSON. Exit 0 only when the record is complete; 1 when it is',
    'incomplete or unsupported; 2 on usage errors.',
  ].join('\n') + '\n');
}

function fatal(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const args = { extract: null, libraries: [], log: null, receipt: null, projectRoot: null, manifest: null };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith('--')) args.extract = rest.shift();
  while (rest.length > 0) {
    const flag = rest.shift();
    const value = rest.shift();
    if (!value || value.startsWith('--')) fatal(`${flag} requires a value`);
    if (flag === '--library') args.libraries.push(...value.split(',').filter(Boolean));
    else if (flag === '--log') args.log = value;
    else if (flag === '--receipt') args.receipt = value;
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
const has = (object, key) => Object.hasOwn(object, key);
const isText = (value) => typeof value === 'string' && value.length > 0;
const isCommit = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const sameSet = (left, right) => JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
const parseJson = (text) => { try { return JSON.parse(text); } catch { return undefined; } };

// What the probe-lean log says about the run.
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

// The project files a run receipt binds: Lean sources, Lake configuration,
// translation.json and the project's own .ilean files.
export function projectInputs(root) {
  const files = {};
  const walk = (directory, relative, ileanOnly) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ileanOnly && ['.lake', '.aeneas', '.git', 'target'].includes(entry.name)) continue;
        walk(absolute, rel, ileanOnly);
      } else if (ileanOnly ? entry.name.endsWith('.ilean')
        : entry.name.endsWith('.lean') || ['translation.json', 'lakefile.toml', 'lake-manifest.json', 'lean-toolchain'].includes(entry.name)) {
        files[rel] = sha256(fs.readFileSync(absolute));
      }
    }
  };
  walk(root, '', false);
  const ileans = path.join(root, ILEAN_DIR);
  if (fs.existsSync(ileans)) walk(ileans, ILEAN_DIR, true);
  return files;
}

function flagValues(argv, names) {
  return argv.flatMap((item, index) => (names.includes(item) ? [argv[index + 1]] : []));
}

function translationNames(file) {
  const translation = JSON.parse(fs.readFileSync(file, 'utf8'));
  return sorted(['functions', 'types', 'globals', 'trait_decls', 'trait_impls']
    .flatMap((section) => (Array.isArray(translation[section]) ? translation[section] : []))
    .map((entry) => entry?.lean_name)
    .filter(isText)
    .map((name) => `probe:${name}`));
}

export function validManifest(manifest) {
  const problems = [];
  if (!plainObject(manifest)) return ['the manifest is not a JSON object'];
  if (manifest.schema !== MANIFEST_SCHEMA || manifest.version !== 1) problems.push(`schema must be ${MANIFEST_SCHEMA} version 1`);
  if (manifest.status !== 'prepared') problems.push(`status must be prepared, got ${JSON.stringify(manifest.status)}`);
  if (manifest.mode !== 'translation-patches') problems.push(`mode must be translation-patches, got ${JSON.stringify(manifest.mode)}`);
  if (!isCommit(manifest.source?.commit)) problems.push('source.commit must be a full commit');
  if (!Array.isArray(manifest.source?.dirty) || manifest.source.dirty.length > 0) problems.push('source.dirty must be an empty list');
  if (!Array.isArray(manifest.patches)) problems.push('patches must be a list');
  return problems;
}

function closureOf(root, data, inScope) {
  const declarations = new Set();
  const external = new Set(data[root]['type-dependencies-external']);
  const queue = [...data[root]['type-dependencies']];
  while (queue.length > 0) {
    const id = queue.shift();
    if (declarations.has(id) || id === root) continue;
    declarations.add(id);
    if (!has(data, id)) continue;
    const fields = data[id].kind === 'theorem' ? ['type-dependencies'] : ['type-dependencies', 'term-dependencies'];
    for (const field of fields) queue.push(...data[id][field]);
    for (const field of fields) data[id][`${field}-external`].forEach((dep) => external.add(dep));
  }
  // Only the edges this closure follows can block it.
  const blockers = [...declarations].filter((id) => !has(data, id))
    .concat([...external].filter((id) => inScope.has(id)))
    .sort().map((id) => ({ code: 'unresolved-edge', dependency: id }));
  return { rule: CLOSURE_RULE, declarations: sorted(declarations), external: sorted(external), blockers };
}

export function buildLeanGraph({ extractText, logText = null, receiptText = null, libraries, projectRoot = null, manifestText = null }) {
  const blockers = [];
  const block = (code, reason, extra = {}) => blockers.push({ code, reason, ...extra });
  const requested = sorted(libraries);
  const record = {
    schema: 'fvs/lean-graph',
    schemaVersion: 1,
    state: null,
    blockers,
    qualifiedInterface: QUALIFIED,
    tool: null,
    source: null,
    timestamp: null,
    run: null,
    provenance: { sourceCommit: null, leanProjectCommit: null, translationSha256: null, charonVersion: null, aeneasVersion: null, manifestSha256: null },
    binding: { status: 'unbound', reasons: [] },
    completeness: { libraries: requested, log: readLog(logText), atomCount: null, modules: null, expectedDeclarations: null, missingDeclarations: [] },
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

  const envelope = parseJson(extractText);
  if (!plainObject(envelope)) {
    block('unreadable-extract', 'the extract is not a JSON object (empty or truncated output?)');
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

  // Every field the graph is built from must be present and well typed: a
  // missing dependency list is absent evidence, never zero dependencies.
  for (const id of ids) {
    const atom = data[id];
    const problems = [
      !/^probe:./.test(id) && 'the declaration id is not a probe: name',
      !isText(atom.kind) && 'kind',
      !isText(atom['code-module']) && 'code-module',
      ...DEPENDENCY_FIELDS.filter((field) => !Array.isArray(atom[field]) ||
        atom[field].some((dep) => typeof dep !== 'string' || !/^probe:./.test(dep))),
    ].filter(Boolean);
    if (problems.length > 0) block('malformed-atom', `${id} has missing or ill-typed ${problems.join(', ')}`, { declaration: id });
    else if (!QUALIFIED_KINDS.includes(atom.kind)) {
      block('unqualified-kind', `${id} has kind ${JSON.stringify(atom.kind)}; only ${QUALIFIED_KINDS.join(' and ')} are qualified for closure traversal`, { declaration: id });
    }
    // JSON.parse keeps only the last of duplicate keys; a key is a string followed by a colon.
    const keys = extractText.match(new RegExp(`${JSON.stringify(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`, 'g'));
    if ((keys ?? []).length > 1) block('duplicate-declaration', `${id} appears ${keys?.length} times in the extract; JSON parsing keeps only one`, { declaration: id });
  }
  if (blockers.some((item) => item.code === 'malformed-atom')) return finish();

  // The run: the receipt must name this extract, this log and the inputs the
  // project root still holds, and a scope covering the requested libraries.
  let files = null;
  const receipt = receiptText === null ? null : parseJson(receiptText);
  const leanCommit = envelope.source?.commit;
  record.provenance.leanProjectCommit = isCommit(leanCommit) ? leanCommit : null;
  if (!isCommit(leanCommit)) block('invalid-lean-commit', `the extract's source.commit ${JSON.stringify(leanCommit)} is not a full commit`);
  if (receiptText === null) {
    block('unbound-run', 'no run receipt: the extract, log and project inputs are not bound to one recorded run');
  } else if (!plainObject(receipt) || receipt.schema !== RECEIPT_SCHEMA || receipt.version !== 1 ||
      !plainObject(receipt.probe) || !plainObject(receipt.lakeBuild) || !plainObject(receipt.inputs) ||
      !plainObject(receipt.inputs.files) || !plainObject(receipt.outputs) ||
      !Array.isArray(receipt.probe.argv) || !Array.isArray(receipt.lakeBuild.argv) || !Array.isArray(receipt.libraries)) {
    block('invalid-receipt', `the receipt is not a ${RECEIPT_SCHEMA} version 1 record`);
  } else {
    record.run = { libraries: receipt.libraries, probe: receipt.probe, lakeBuild: receipt.lakeBuild, outputs: receipt.outputs };
    if (receipt.probe.exitCode !== 0 || receipt.lakeBuild.exitCode !== 0) {
      block('run-failed', `the recorded run exited with lake build ${receipt.lakeBuild.exitCode}, probe-lean ${receipt.probe.exitCode}`);
    }
    if (receipt.probe.version !== QUALIFIED.version) block('run-mismatch', `the receipt names probe-lean ${JSON.stringify(receipt.probe.version)}`);
    const probeArgv = receipt.probe.argv;
    const scoped = flagValues(probeArgv, ['--library', '-l']).flatMap((value) => String(value).split(',')).filter(Boolean);
    if (probeArgv[1] !== 'extract' || flagValues(probeArgv, ['--module', '-m']).length > 0 || !sameSet(scoped, requested) ||
        !sameSet(receipt.libraries, requested)) {
      block('scope-not-requested', `the recorded probe-lean run was not scoped to exactly --library ${requested.join(',')} without --module`);
    }
    const lakeArgv = receipt.lakeBuild.argv;
    if (lakeArgv[0] !== 'lake' || lakeArgv[1] !== 'build' || requested.some((library) => !lakeArgv.slice(2).includes(library))) {
      block('scope-not-requested', `the recorded lake build did not build ${requested.join(', ')}`);
    }
    if (receipt.outputs.extractSha256 !== sha256(extractText)) block('run-mismatch', 'the extract is not the output the receipt records');
    if (logText === null || receipt.outputs.logSha256 !== sha256(logText)) block('run-mismatch', 'the log is not the log the receipt records');
    if (receipt.inputs.leanProjectCommit !== leanCommit) block('run-mismatch', `the receipt records Lean project commit ${receipt.inputs.leanProjectCommit}, the extract ${leanCommit}`);
    if (!projectRoot) {
      block('inputs-changed', 'no --project-root: the recorded inputs cannot be checked');
    } else {
      const current = projectInputs(projectRoot);
      const changed = sorted([...Object.keys(receipt.inputs.files), ...Object.keys(current)])
        .filter((file) => receipt.inputs.files[file] !== current[file]);
      if (changed.length > 0) block('inputs-changed', `the project differs from the recorded run: ${changed.join(', ')}`, { files: changed });
      else files = receipt.inputs.files;
    }
  }

  // Scope: the run's modules and the declarations Lean recorded in their .ilean
  // files. Every project module must lie under a requested library, so any
  // project declaration is expected and an omitted one cannot pass as external.
  const expected = new Set();
  if (files) {
    const modules = Object.keys(files)
      .filter((file) => file.endsWith('.lean') && !file.startsWith('.lake/') && path.posix.basename(file) !== 'lakefile.lean')
      .map((file) => file.slice(0, -'.lean'.length));
    const outside = modules.filter((module) => !requested.includes(module.split('/')[0]));
    if (outside.length > 0) block('modules-outside-scope', `project modules outside the requested libraries: ${outside.map((m) => m.replaceAll('/', '.')).join(', ')}`);
    record.completeness.modules = {};
    for (const module of modules.filter((name) => !outside.includes(name))) {
      const name = module.replaceAll('/', '.');
      const ilean = `${ILEAN_DIR}/${module}.ilean`;
      const parsed = has(files, ilean) ? parseJson(fs.readFileSync(path.join(projectRoot, ilean), 'utf8')) : undefined;
      if (!plainObject(parsed) || parsed.module !== name || !plainObject(parsed.decls)) {
        block('missing-ilean', `module ${name} has no matching ${ilean} in the recorded run`);
        continue;
      }
      record.completeness.modules[name] = sorted(Object.keys(parsed.decls));
      for (const decl of Object.keys(parsed.decls)) expected.add(`probe:${decl}`);
    }
    record.completeness.expectedDeclarations = expected.size;
    const extra = ids.filter((id) => !expected.has(id));
    if (extra.length > 0) block('atom-outside-scope', `declarations no requested module's .ilean lists: ${extra.join(', ')}`);
  }

  // Provenance. The translation hash is the one the run recorded; the current
  // file is read only when it still has that hash.
  let translation = new Set();
  if (projectRoot) {
    const found = readProvenance(projectRoot);
    for (const problem of found.problems) block('provenance', problem);
    if (found.translationJson) {
      translation = new Set(translationNames(found.translationJson));
      const relative = path.relative(projectRoot, found.translationJson).split(path.sep).join('/');
      if (files && has(files, relative)) {
        record.provenance.translationSha256 = files[relative];
        record.provenance.charonVersion = found.charonVersion;
        record.provenance.aeneasVersion = found.aeneasVersion;
      } else if (files) {
        block('inputs-changed', `the recorded run does not bind ${relative}`);
      }
    }
  } else {
    block('no-translation', 'no --project-root: translation.json provenance and declaration coverage are not established');
  }
  for (const id of translation) expected.add(id);
  record.completeness.missingDeclarations = [...expected].filter((id) => !has(data, id)).sort();
  if (record.completeness.missingDeclarations.length > 0) {
    block('missing-declarations', `declarations listed by translation.json or a requested module's .ilean are not in the extract: ${record.completeness.missingDeclarations.join(', ')}`);
  }

  if (manifestText !== null) {
    const manifest = parseJson(manifestText);
    const problems = validManifest(manifest);
    if (problems.length > 0) block('invalid-manifest', `not a usable ${MANIFEST_SCHEMA}: ${problems.join('; ')}`);
    else {
      record.provenance.manifestSha256 = sha256(manifestText);
      record.provenance.sourceCommit = manifest.source.commit;
    }
  }
  // The same-extraction claim, kept apart from the graph's state: nothing yet
  // records translation.json against the patch manifest.
  record.binding.reasons = [
    'translation-not-bound-to-manifest',
    record.provenance.manifestSha256 === null && 'no-manifest',
    record.provenance.sourceCommit !== null && record.provenance.leanProjectCommit !== record.provenance.sourceCommit &&
      'lean-project-commit-differs-from-source-commit',
  ].filter(Boolean);

  const log = record.completeness.log;
  if (log === null) {
    block('no-log', 'no probe-lean log');
  } else {
    if (log.writtenAtoms === null) block('log-incomplete', 'the log does not report the written atoms; the run may not have finished');
    else if (log.writtenAtoms !== ids.length) block('atom-count-mismatch', `the log reports ${log.writtenAtoms} atoms, the extract holds ${ids.length}`);
    for (const library of requested.filter((name) => log.builtLibraries && !log.builtLibraries.includes(name))) {
      block('library-not-built', `library ${library} was not built by this run (built: ${log.builtLibraries.join(', ') || 'none'})`, { library });
    }
  }
  for (const library of requested) {
    if (!ids.some((id) => data[id]['code-module'].split('.')[0] === library)) {
      block('library-not-analysed', `no declaration of library ${library} is in the extract`, { library });
    }
  }

  // Edges, oriented from the dependent declaration to its dependency. A local
  // dependency absent from the extract, or an in-scope declaration (extracted,
  // listed by a requested module's .ilean or by translation.json) labelled
  // external, is unresolved.
  const inScope = new Set([...ids, ...expected]);
  const unresolvedFrom = new Set();
  const external = new Set();
  for (const from of ids) {
    const atom = data[from];
    for (const kind of ['type', 'term']) {
      for (const to of atom[`${kind}-dependencies`]) {
        const resolution = has(data, to) ? 'local' : 'unresolved';
        if (resolution === 'unresolved') unresolvedFrom.add(from);
        record.edges.push({ from, to, kind, resolution });
      }
      for (const to of atom[`${kind}-dependencies-external`]) {
        const resolution = inScope.has(to) ? 'unresolved' : 'external';
        if (resolution === 'unresolved') unresolvedFrom.add(from);
        else external.add(to);
        record.edges.push({ from, to, kind, resolution });
      }
    }
    if (!sameSet(atom.dependencies, [...atom['type-dependencies'], ...atom['term-dependencies']])) {
      block('dependency-fields-disagree', `${from}: dependencies is not the union of type-dependencies and term-dependencies`, { declaration: from });
    }
    if (translation.has(from) && atom['is-aeneas-generated'] === false) {
      record.anomalies.push({ code: 'aeneas-generated-false-for-translation-declaration', declaration: from });
    }
  }
  record.external = sorted(external);
  for (const from of sorted(unresolvedFrom)) {
    const targets = record.edges.filter((edge) => edge.from === from && edge.resolution === 'unresolved').map((edge) => edge.to);
    block('unresolved-edge', `${from} depends on ${sorted(targets).join(', ')}, which the extract does not resolve as a local declaration`, { declaration: from });
  }
  for (const id of ids.filter((name) => data[name].kind === 'theorem')) {
    record.closures[id] = closureOf(id, data, inScope);
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
    const text = (file) => (file ? fs.readFileSync(file, 'utf8') : null);
    const record = buildLeanGraph({
      extractText: fs.readFileSync(args.extract, 'utf8'),
      logText: text(args.log),
      receiptText: text(args.receipt),
      libraries: args.libraries,
      projectRoot: args.projectRoot,
      manifestText: text(args.manifest),
    });
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    if (record.state !== 'complete') {
      process.stderr.write(`FVS >> lean graph ${record.state}: ${sorted(record.blockers.map((item) => item.code)).join(', ')}\n`);
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
