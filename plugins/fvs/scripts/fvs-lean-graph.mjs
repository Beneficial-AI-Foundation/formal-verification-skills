#!/usr/bin/env node
'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { readState } from './fvs-auto.mjs';
import { readProvenance } from './fvs-probe-inventory.mjs';

// The only interface qualified so far: probe-lean 0.14.0 `extract` (Lean 4.31.0
// build), Schema 3.0. Anything else is reported unsupported, never projected.
const QUALIFIED = { schema: 'probe-lean/extract', schemaVersion: '3.0', tool: 'probe-lean', version: '0.14.0' };
const RECEIPT_SCHEMA = 'fvs/lean-probe-run';
const MANIFEST_SCHEMA = 'fvs-extract-patches/manifest';
const CONSTANTS_SCHEMA = 'fvs/lean-constants';
const LOCAL_FIELDS = ['type-dependencies', 'term-dependencies', 'dependencies'];
// probe-lean 0.14.0 omits an external list when it would be empty and never
// emits it empty; local lists are always emitted. Qualified against Lean's own
// record of each declaration's type and value constants for every qualified
// kind (54 of 54 lists, two fixture states). So an absent external list means
// no external dependency; a present one must be a non-empty list.
const EXTERNAL_FIELDS = ['type-dependencies-external', 'term-dependencies-external'];
// The declaration kinds a recorded fixture has qualified; closure traversal is
// defined for these only. Instances are emitted as def. Inductive types are not
// qualified: their constructors are never emitted as declarations.
const QUALIFIED_KINDS = ['def', 'theorem', 'structure', 'projection'];
// Lake writes each module's .ilean, listing the declarations Lean elaborated in
// it, under this directory of the project's own build.
const ILEAN_DIR = '.lake/build/lib/lean';
// The auto-track state holding the recorded extraction attempt (extraction.run).
const STATE_FILE = '.formalising/auto-fv/state.json';

// Semantic-definition closure of a theorem: the declarations its statement
// means. Start from the theorem's type-dependencies; through a definition follow
// both its type and its term dependencies (its value is part of its meaning);
// through a theorem follow its type-dependencies only (proofs are irrelevant).
const CLOSURE_RULE = 'root: type-dependencies; theorem: type-dependencies; other kinds: type-dependencies + term-dependencies';

function usage() {
  process.stdout.write([
    'Usage: node fvs-lean-graph.mjs LEAN.json --library NAME[,NAME...]',
    '  --log PROBE_LEAN_LOG --receipt RUN_RECEIPT.json --project-root DIR',
    '  [--manifest PATCH_MANIFEST.json] [--constants LEAN_CONSTANTS.json]',
    '',
    'Builds the Lean declaration and dependency record from a probe-lean 0.14.0',
    '`extract` output. --library names the Lean module roots that must have been',
    'built and analysed (the Aeneas output library and any specification library;',
    'every project module must fall under one of them). --log is the captured',
    'probe-lean output and --receipt the fvs/lean-probe-run record written by the',
    'run that produced both; --project-root is the Lean project that run used.',
    '--manifest is the fvs-extract-patches manifest of the extraction. --constants',
    'is the fvs/lean-constants record of the same project, Lean\'s own list of the',
    'constants each declaration\'s type and value mention; without it the reported',
    'dependencies are not shown to be complete. Prints the',
    'record as JSON. Exit 0 only when the record is complete; 1 when it is',
    'incomplete or unsupported; 2 on usage errors.',
    '',
    'Exit 0 and state "complete" claim only that this Lean graph record of the',
    'bound run is complete. binding.status, reported separately, is "bound" only',
    'when the generated Lean the graph analysed is byte for byte what the recorded',
    'extraction attempt in the project state published. Neither claims that a join',
    'with the Rust identity record may proceed: a consumer needs a complete state',
    'AND bound bindings with agreeing provenance on both records.',
  ].join('\n') + '\n');
}

function fatal(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const args = { extract: null, libraries: [], log: null, receipt: null, projectRoot: null, manifest: null, constants: null };
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
    else if (flag === '--constants') args.constants = value;
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
// translation.json, the auto-track state and the project's own .ilean files.
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
  if (fs.existsSync(path.join(root, STATE_FILE))) files[STATE_FILE] = sha256(fs.readFileSync(path.join(root, STATE_FILE)));
  const ileans = path.join(root, ILEAN_DIR);
  if (fs.existsSync(ileans)) walk(ileans, ILEAN_DIR, true);
  return files;
}

function flagValues(argv, names) {
  return argv.flatMap((item, index) => (names.includes(item) ? [argv[index + 1]] : []));
}

// Keys repeated within one JSON object, compared after decoding escapes (so
// "probe:x" and "\u0070robe:x" are the same key). Runs only on text JSON.parse
// accepted, so tracking strings and nesting is enough.
export function duplicateKeys(text) {
  const duplicates = new Set();
  const objects = [];
  let previous = null;
  for (const [token] of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]:]/g)) {
    if (token === '{') objects.push(new Set());
    else if (token === '[') objects.push(null);
    else if (token === '}' || token === ']') objects.pop();
    else if (token === ':') {
      const key = JSON.parse(previous);
      if (objects.at(-1).has(key)) duplicates.add(key);
      objects.at(-1).add(key);
    }
    previous = token;
  }
  return sorted(duplicates);
}

function translationEntries(file) {
  const translation = JSON.parse(fs.readFileSync(file, 'utf8'));
  return ['functions', 'types', 'globals', 'trait_decls', 'trait_impls']
    .flatMap((section) => (Array.isArray(translation[section]) ? translation[section] : []));
}

const translationNames = (entries) => sorted(entries.map((entry) => entry?.lean_name).filter(isText).map((name) => `probe:${name}`));

// The path of a published file relative to the project the attempt published
// into, both as the patch engine recorded them; null outside it. Comparing the
// engine's own paths keeps the check independent of where the project is now.
function publishedRelative(root, file) {
  const relative = typeof root === 'string' && typeof file === 'string' ? path.posix.relative(root, file) : '';
  return !relative || relative.startsWith('..') || path.posix.isAbsolute(relative) ? null : relative;
}

// The same-extraction binding: the recorded extraction attempt in the project
// state (fvs-auto readState validates it) must have published exactly the
// translation.json and generated Lean files this run analysed, byte for byte,
// from the given patch manifest. Paths are matched relative to the project the
// attempt published into, so a copy of that project still binds by content. Absent or unsupported evidence leaves the
// binding unbound; evidence that disagrees blocks the record.
function bindAttempt({ projectRoot, files, runConsistent, manifest, translationRelative, entries, data, block }) {
  if (!files) return { status: 'unbound', reasons: ['run-not-bound'] };
  // Matching input files are not enough: the receipt must also vouch for this
  // extract, log, Lean commit, scope and a successful run.
  if (!runConsistent) return { status: 'unbound', reasons: ['run-receipt-disagrees'] };
  let loaded;
  try {
    loaded = readState({ projectRoot });
  } catch (error) {
    block('malformed-state', `the project state does not validate: ${error.message}`);
    return { status: 'unbound', reasons: ['inputs-disagree-with-attempt'] };
  }
  const extraction = loaded.state?.extraction ?? null;
  const run = extraction?.run;
  const reasons = [
    !loaded.state && 'no-state',
    loaded.state && !run && 'no-extraction-attempt',
    run && extraction.status !== 'succeeded' && 'extraction-not-succeeded',
    run && (!run.supported || run.residuals.length > 0) && 'unsupported-configuration',
    !manifest && 'no-manifest',
  ].filter(Boolean);
  if (!run) return { status: 'unbound', reasons };
  let disagreed = false;
  const disagree = (code, reason) => { disagreed = true; block(code, reason); };
  if (manifest && (manifest.sha256 !== run.manifestSha256 || manifest.sha256 !== extraction.inputs?.manifestSha256 ||
      manifest.json.source.commit !== extraction.inputs?.sourceCommit)) {
    disagree('attempt-manifest-mismatch', 'the recorded extraction attempt was not prepared from this patch manifest');
  }
  if (sha256(JSON.stringify(run.config)) !== run.configSha256) disagree('attempt-config-mismatch', 'the recorded attempt configuration does not match its hash');
  const root = extraction.inputs?.crateRoot;
  if (publishedRelative(root, run.translation.projectPath) !== translationRelative ||
      run.translation.sha256 !== files[translationRelative]) {
    disagree('attempt-translation-mismatch', 'the analysed translation.json is not the one the recorded attempt published');
  }
  const published = run.publication.map((entry) => ({ ...entry, relative: publishedRelative(root, entry.projectPath) }));
  // Distinct recorded strings naming one file (a/./b, a//b) are aliases, refused
  // rather than collapsed, so each published file appears once.
  const repeated = (values) => sorted(values.filter((value, index) => values.indexOf(value) !== index));
  const aliases = [...repeated(published.map((entry) => entry.relative).filter((value) => value !== null)),
    ...repeated(published.map((entry) => path.posix.normalize(entry.attemptPath)))];
  if (aliases.length > 0) disagree('attempt-publication-alias', `the recorded publication names the same file more than once: ${aliases.join(', ')}`);
  const differing = published.filter((entry) => entry.relative === null || files[entry.relative] !== entry.sha256)
    .map((entry) => entry.relative ?? entry.projectPath);
  if (differing.length > 0) disagree('generated-lean-differs-from-attempt', `the analysed project does not hold the published bytes of ${differing.join(', ')}`);
  // The publication is exactly translation.json and every Lean file it names.
  const translationDir = translationRelative ? path.posix.dirname(translationRelative) : '.';
  const named = entries.map((entry) => entry?.lean_file).filter(isText).map((file) => path.posix.join(translationDir, file));
  if (!sameSet(published.map((entry) => entry.relative), [translationRelative, ...named])) {
    disagree('attempt-publication-mismatch', 'the recorded publication is not exactly translation.json and the Lean files it names');
  }
  const publishedLean = new Set(published.map((entry) => entry.relative));
  const outside = translationNames(entries).filter((id) => has(data, id) && !publishedLean.has(data[id]['code-path']));
  if (outside.length > 0) disagree('generated-declaration-outside-publication', `generated declarations not read from a published file: ${outside.join(', ')}`);
  if (disagreed) return { status: 'unbound', reasons: ['inputs-disagree-with-attempt'] };
  if (reasons.length > 0) return { status: 'unbound', reasons };
  return {
    status: 'bound',
    reasons: [],
    trust: run.trust,
    configSha256: run.configSha256,
    llbcSha256: run.llbc.sha256,
    generatedLean: published.map(({ projectPath, sha256: hash }) => ({ projectPath, sha256: hash })),
  };
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

// A dependency list of a validated atom; an absent external list is empty.
const deps = (atom, field) => atom[field] ?? [];

function closureOf(root, data, inScope, projectionsOf, unreported) {
  const declarations = new Set();
  const external = new Set(deps(data[root], 'type-dependencies-external'));
  const queue = [...data[root]['type-dependencies']];
  while (queue.length > 0) {
    const id = queue.shift();
    if (declarations.has(id) || id === root) continue;
    declarations.add(id);
    if (!has(data, id)) continue;
    const fields = data[id].kind === 'theorem' ? ['type-dependencies'] : ['type-dependencies', 'term-dependencies'];
    for (const field of fields) queue.push(...data[id][field]);
    for (const field of fields) deps(data[id], `${field}-external`).forEach((dep) => external.add(dep));
    // A structure's own lists record only its type; its fields live on the
    // projections that take it. Following every projection that depends on it
    // can over-include another structure's projection: conservative.
    if (data[id].kind === 'structure') queue.push(...(projectionsOf.get(id) ?? []));
  }
  // Only the edges this closure follows can block it.
  const blockers = [...declarations].filter((id) => !has(data, id))
    .concat([...external].filter((id) => inScope.has(id)))
    .sort().map((id) => ({ code: 'unresolved-edge', dependency: id }))
    .concat([root, ...declarations].filter((id) => unreported.has(id)).sort()
      .map((id) => ({ code: 'dependency-not-reported', declaration: id })));
  return { rule: CLOSURE_RULE, declarations: sorted(declarations), external: sorted(external), blockers };
}

// Dependency fidelity: Lean's own record of the constants each declaration's
// type and value mention must be covered by what probe-lean reported for it.
// A type constant must be reported in the type lists (a theorem's closure reads
// only those); a value constant in any list. Constructors, recursors and other
// generated eliminators must be reported themselves. A generated project
// constant (no source definition) of a qualified kind is folded into its user,
// as probe-lean folds auxiliaries: a definition through its type and value, a
// theorem through its statement only. That theorem's proof is not audited here,
// so it stays an explicit obligation that blocks the record. A generated axiom
// is a trust boundary, never folded; any other kind is not covered.
function checkFidelity({ constants, data, ids, defined, block }) {
  const info = new Map();
  const project = new Set();
  for (const [part, entries] of [['project', constants.project], ['referenced', constants.referenced]]) {
    for (const entry of entries) {
      info.set(entry.name, entry);
      if (part === 'project') project.add(entry.name);
    }
  }
  const atoms = new Set(ids.map((id) => id.slice('probe:'.length)));
  const represented = [];
  const obligations = [];
  const unreported = new Set();
  for (const id of ids) {
    const name = id.slice('probe:'.length);
    const own = info.get(name);
    if (!own || !project.has(name)) {
      block('constants-missing-declaration', `the Lean constants record has no entry for ${id}`, { declaration: id });
      unreported.add(id);
      continue;
    }
    const names = (fields) => new Set(fields.flatMap((field) => deps(data[id], field)).map((dep) => dep.slice('probe:'.length)));
    const typeReported = names(['type-dependencies', 'type-dependencies-external']);
    const anyReported = names(['type-dependencies', 'type-dependencies-external', 'term-dependencies', 'term-dependencies-external']);
    const missing = [];
    for (const [list, reported] of [['type', typeReported], ['value', anyReported]]) {
      const covers = (constant, stack) => {
        if (constant === name || reported.has(constant)) return true;
        const entry = info.get(constant);
        if (!entry) return false;
        if (!project.has(constant) || defined.has(constant) || atoms.has(constant) || stack.includes(constant)) return false;
        if (entry.kind === 'axiom') obligations.push({ declaration: id, constant, obligation: 'axiom-boundary' });
        if (!FOLDABLE_KINDS.includes(entry.kind)) return false;
        const theorem = entry.kind === 'theorem';
        if (theorem) obligations.push({ declaration: id, constant, obligation: 'proof-dependencies-unaudited' });
        // every, not some: each use is checked so all missing constants are reported.
        const folded = (theorem ? entry.type : [...entry.type, ...entry.value]).map((used) => covers(used, [...stack, constant]));
        if (!folded.every(Boolean)) return false;
        represented.push({ declaration: id, list, constant, rule: theorem ? 'statement-fold' : 'auxiliary-fold' });
        return true;
      };
      for (const constant of own[list]) if (!covers(constant, [])) missing.push(`${constant} (${list}, ${info.get(constant)?.kind ?? 'not in the record'})`);
    }
    if (missing.length > 0) {
      unreported.add(id);
      block('dependency-not-reported', `${id}: Lean records ${sorted(missing).join(', ')}, which probe-lean does not report`, { declaration: id });
    }
  }
  const unique = (items) => {
    const seen = new Set();
    return items.filter((item) => {
      const key = JSON.stringify(item);
      return !seen.has(key) && seen.add(key);
    });
  };
  const open = unique(obligations);
  for (const [obligation, code, what] of [['proof-dependencies-unaudited', 'proof-dependencies-unaudited', 'generated proofs'],
    ['axiom-boundary', 'axiom-boundary', 'generated axioms']]) {
    const of = open.filter((item) => item.obligation === obligation);
    for (const id of sorted(of.map((item) => item.declaration))) {
      unreported.add(id);
      const constants = sorted(of.filter((item) => item.declaration === id).map((item) => item.constant));
      block(code, `${id} uses ${what} ${constants.join(', ')}, which are not audited here`, { declaration: id });
    }
  }
  return { represented: unique(represented), obligations: open, unreported };
}

// Kernel kinds a generated constant may be folded through (see checkFidelity).
const FOLDABLE_KINDS = ['def', 'theorem'];

// The compiled inventory must hold each analysed module's compiled body and
// its companions, and nothing else but their .hash sidecars: a module declared
// with `module` compiles to .olean, .olean.private and .olean.server, any
// other module to .olean. Returns the problems found.
function compiledProblems(compiled, modules, projectRoot) {
  const problems = [];
  const allowed = new Set();
  for (const name of modules) {
    const base = `${ILEAN_DIR}/${name.replaceAll('.', '/')}`;
    let source = '';
    try {
      source = fs.readFileSync(path.join(projectRoot, `${name.replaceAll('.', '/')}.lean`), 'utf8');
    } catch {
      problems.push(`no source for module ${name}`);
    }
    const required = /^module\s*$/m.test(source) ? ['.olean', '.olean.private', '.olean.server'] : ['.olean'];
    for (const suffix of ['.olean', '.olean.private', '.olean.server']) {
      allowed.add(`${base}${suffix}`);
      allowed.add(`${base}${suffix}.hash`);
    }
    for (const suffix of required) if (!has(compiled, `${base}${suffix}`)) problems.push(`missing ${base}${suffix}`);
  }
  for (const file of Object.keys(compiled)) {
    if (path.posix.normalize(file) !== file || !allowed.has(file)) problems.push(`unexpected ${file}`);
  }
  return problems;
}

const hashMap = (value) => plainObject(value) && Object.values(value).every((hash) => /^[0-9a-f]{64}$/.test(hash));

const constantsShapeValid = (constants) => plainObject(constants) && constants.schema === CONSTANTS_SCHEMA && constants.version === 1 &&
  plainObject(constants.inputs) && plainObject(constants.inputs.files) &&
  (constants.inputs.compiled === undefined || hashMap(constants.inputs.compiled)) &&
  ['project', 'referenced'].every((part) => Array.isArray(constants[part]) && constants[part].every((entry) => plainObject(entry) &&
    isText(entry.name) && isText(entry.kind) && Array.isArray(entry.owners) && entry.owners.every(isText) &&
    (part === 'referenced' || ['type', 'value'].every((list) => Array.isArray(entry[list]) && entry[list].every(isText))))) &&
  new Set([...constants.project, ...constants.referenced].map((entry) => entry.name)).size === constants.project.length + constants.referenced.length;

export function buildLeanGraph({ extractText, logText = null, receiptText = null, libraries, projectRoot = null, manifestText = null, constantsText = null }) {
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
    provenance: { sourceCommit: null, leanProjectCommit: null, translationSha256: null, charonVersion: null, aeneasVersion: null, manifestSha256: null, llbcSha256: null, configSha256: null },
    binding: { status: 'unbound', reasons: [] },
    fidelity: { status: 'unverified', represented: [], obligations: [] },
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
      ...LOCAL_FIELDS.filter((field) => !Array.isArray(atom[field]) ||
        atom[field].some((dep) => typeof dep !== 'string' || !/^probe:./.test(dep))),
      ...EXTERNAL_FIELDS.filter((field) => has(atom, field) && (!Array.isArray(atom[field]) || atom[field].length === 0 ||
        atom[field].some((dep) => typeof dep !== 'string' || !/^probe:./.test(dep)))),
    ].filter(Boolean);
    if (problems.length > 0) block('malformed-atom', `${id} has missing or ill-typed ${problems.join(', ')}`, { declaration: id });
    else if (!QUALIFIED_KINDS.includes(atom.kind)) {
      block('unqualified-kind', `${id} has kind ${JSON.stringify(atom.kind)}; only ${QUALIFIED_KINDS.join(', ')} are qualified for closure traversal`, { declaration: id });
    }
  }
  // JSON.parse keeps only the last of duplicate keys, so a repeated key anywhere
  // (a declaration or one of its fields) makes the parsed extract ambiguous.
  for (const key of duplicateKeys(extractText)) {
    if (has(data, key)) block('duplicate-declaration', `${key} appears more than once in data; JSON parsing keeps only the last`, { declaration: key });
    else block('duplicate-key', `key ${JSON.stringify(key)} appears more than once in one object of the extract`);
  }
  if (blockers.some((item) => item.code === 'malformed-atom')) return finish();

  // The run: the receipt must name this extract, this log and the inputs the
  // project root still holds, and a scope covering the requested libraries.
  let files = null;
  let receiptCompiled = null;
  const receipt = receiptText === null ? null : parseJson(receiptText);
  const runChecksFrom = blockers.length;
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
    // Optional: the compiled project modules the run used (sha256 by path).
    if (receipt.inputs.compiled !== undefined && !hashMap(receipt.inputs.compiled)) {
      block('invalid-receipt', 'the receipt\'s inputs.compiled must map paths to sha256 digests');
    } else {
      receiptCompiled = receipt.inputs.compiled ?? null;
    }
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
  const runConsistent = files !== null && blockers.length === runChecksFrom;

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
      // decls omits some declarations (a def or theorem whose type has no
      // constants, projections); every declaration made in the module is a
      // reference key {c: {m: module, n}} with a definition position.
      // Without that map the module's declarations are not established; a
      // present empty map (an import-only module) is fine.
      const references = plainObject(parsed.references) ? parsed.references : null;
      if (references === null) {
        block('ilean-references-missing', `${ilean} has no references map, so the declarations module ${name} defines are not established`);
      }
      const defined = Object.entries(references ?? {}).flatMap(([key, value]) => {
        const target = parseJson(key)?.c;
        return plainObject(target) && target.m === name && isText(target.n) && value?.definition != null ? [target.n] : [];
      });
      record.completeness.modules[name] = sorted([...Object.keys(parsed.decls), ...defined]);
      for (const decl of record.completeness.modules[name]) expected.add(`probe:${decl}`);
    }
    record.completeness.expectedDeclarations = expected.size;
    const extra = ids.filter((id) => !expected.has(id));
    if (extra.length > 0) block('atom-outside-scope', `declarations no requested module's .ilean lists: ${extra.join(', ')}`);
  }

  // Provenance. The translation hash is the one the run recorded; the current
  // file is read only when it still has that hash.
  let translation = new Set();
  let entries = [];
  let translationRelative = null;
  if (projectRoot) {
    const found = readProvenance(projectRoot);
    for (const problem of found.problems) block('provenance', problem);
    if (found.translationJson) {
      entries = translationEntries(found.translationJson);
      translation = new Set(translationNames(entries));
      const relative = path.relative(projectRoot, found.translationJson).split(path.sep).join('/');
      translationRelative = relative;
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

  let manifest = null;
  if (manifestText !== null) {
    const parsed = parseJson(manifestText);
    const problems = validManifest(parsed);
    if (problems.length > 0) block('invalid-manifest', `not a usable ${MANIFEST_SCHEMA}: ${problems.join('; ')}`);
    else {
      manifest = { json: parsed, sha256: sha256(manifestText) };
      record.provenance.manifestSha256 = manifest.sha256;
      record.provenance.sourceCommit = parsed.source.commit;
    }
  }
  // The same-extraction claim, kept apart from the graph's state. A complete
  // state never implies it; joining with the Rust record needs both.
  if (projectRoot) {
    const { llbcSha256, ...binding } = bindAttempt({ projectRoot, files, runConsistent, manifest, translationRelative, entries, data, block });
    record.binding = binding;
    if (binding.status === 'bound') {
      record.provenance.llbcSha256 = llbcSha256;
      record.provenance.configSha256 = binding.configSha256;
    }
  } else {
    record.binding.reasons = ['run-not-bound'];
  }

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
      for (const to of deps(atom, `${kind}-dependencies-external`)) {
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
  // Fidelity is checked only for a run the receipt binds; otherwise the record
  // is already incomplete.
  let unreported = new Set();
  if (files) {
    const constants = constantsText === null ? null : parseJson(constantsText);
    if (constantsText === null) {
      block('fidelity-unverified', 'no Lean constants record: the reported dependencies are not shown to cover the constants Lean records');
    } else if (!constantsShapeValid(constants)) {
      block('invalid-constants', `the constants record is not a ${CONSTANTS_SCHEMA} version 1 record`);
    } else if (!sameSet(Object.entries(constants.inputs.files).map(([file, hash]) => `${file} ${hash}`),
      Object.entries(files).map(([file, hash]) => `${file} ${hash}`))) {
      block('fidelity-unbound', 'the constants record was not taken from the project files this run recorded');
    } else if (!hashMap(receiptCompiled) || !hashMap(constants.inputs.compiled)) {
      // The constants come from compiled modules; sources and .ilean files do not
      // identify those, so both records must name the same compiled bytes.
      block('fidelity-unverified', 'compiled-environment-not-bound: the run receipt and the constants record must both record the project\'s compiled modules');
    } else if (Object.keys(receiptCompiled).length === 0 || !sameSet(Object.entries(constants.inputs.compiled).map(([file, hash]) => `${file} ${hash}`),
      Object.entries(receiptCompiled).map(([file, hash]) => `${file} ${hash}`))) {
      block('fidelity-unbound', 'the constants record was not taken from the compiled modules this run recorded');
    } else if (compiledProblems(receiptCompiled, Object.keys(record.completeness.modules ?? {}), projectRoot).length > 0) {
      block('compiled-inventory-incomplete', `the recorded compiled modules do not cover the analysed modules: ${compiledProblems(receiptCompiled, Object.keys(record.completeness.modules ?? {}), projectRoot).join(', ')}`);
    } else {
      const defined = new Set([...expected].map((id) => id.slice('probe:'.length)));
      const fidelity = checkFidelity({ constants, data, ids, defined, block });
      unreported = fidelity.unreported;
      record.fidelity = { status: unreported.size === 0 ? 'verified' : 'incomplete', represented: fidelity.represented, obligations: fidelity.obligations };
    }
  }
  const projectionsOf = new Map();
  for (const id of ids.filter((name) => data[name].kind === 'projection')) {
    for (const target of data[id]['type-dependencies']) projectionsOf.set(target, [...(projectionsOf.get(target) ?? []), id]);
  }
  for (const id of ids.filter((name) => data[name].kind === 'theorem')) {
    record.closures[id] = closureOf(id, data, inScope, projectionsOf, unreported);
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
      constantsText: text(args.constants),
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
