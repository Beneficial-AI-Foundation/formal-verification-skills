#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const MINIMUM_VERSION = [0, 19, 0];
const VERIFICATION_STATUSES = [
  'unverified',
  'failed',
  'verified',
  'transitively-verified',
  'trusted',
];
const SCOPE_PREDICATE =
  'language=rust && kind=exec && is-relevant=true && untracked=false';
const START_MARKER = '<!-- fvs:probe-inventory:start -->';
const END_MARKER = '<!-- fvs:probe-inventory:end -->';

function fatal(message) {
  process.stderr.write(`FVS_PROBE_INVENTORY_ERROR: ${message}\n`);
  process.exit(2);
}

function usage() {
  process.stdout.write([
    'Usage: node fvs-probe-inventory.mjs EXTRACT.json',
    '  [--project-root DIR] [--target PATH_OR_NAME]',
    '  [--public-api-exact]',
    '  [--format json|markdown|count] [--update-codemap CODEMAP.md]',
    '  [--check-codemap CODEMAP.md]',
    '',
    'Projects probe-aeneas >= 0.19.0 Schema 3.0 output into the canonical',
    'in-scope Rust function inventory used by FVS.',
  ].join('\n') + '\n');
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }
  const args = {
    input: null,
    projectRoot: null,
    target: null,
    format: 'json',
    codemap: null,
    updateCodemap: null,
    publicApiExact: false,
  };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith('--')) args.input = rest.shift();
  while (rest.length > 0) {
    const flag = rest.shift();
    if (flag === '--public-api-exact') {
      args.publicApiExact = true;
      continue;
    }
    const value = rest.shift();
    if (!value || value.startsWith('--')) fatal(`${flag} requires a value`);
    if (flag === '--project-root') args.projectRoot = value;
    else if (flag === '--target') args.target = value;
    else if (flag === '--format') args.format = value;
    else if (flag === '--update-codemap') args.updateCodemap = value;
    else if (flag === '--check-codemap') args.codemap = value;
    else fatal(`unknown argument ${JSON.stringify(flag)}`);
  }
  if (!args.input) fatal('an extract JSON path is required');
  if (!['json', 'markdown', 'count'].includes(args.format)) {
    fatal('--format must be json, markdown, or count');
  }
  return args;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fatal(`cannot read ${file}: ${error.message}`);
  }
}

function semanticVersion(raw) {
  if (typeof raw !== 'string') fatal('tool.version must be a semantic version string');
  const match = raw.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
  if (!match) fatal(`tool.version is not numeric semantic versioning: ${raw}`);
  return match.slice(1).map(Number);
}

function versionAtLeast(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    fatal('extract envelope must be a JSON object');
  }
  if (envelope.schema !== 'probe-aeneas/extract') {
    fatal('schema must be probe-aeneas/extract');
  }
  if (envelope['schema-version'] !== '3.0') fatal('schema-version must be 3.0');
  if (envelope.tool?.name !== 'probe-aeneas' || envelope.tool?.command !== 'extract') {
    fatal('tool must identify the probe-aeneas extract command');
  }
  if (!versionAtLeast(semanticVersion(envelope.tool.version), MINIMUM_VERSION)) {
    fatal(`probe-aeneas >= ${MINIMUM_VERSION.join('.')} is required; got ${envelope.tool.version}`);
  }
  if (!envelope.data || typeof envelope.data !== 'object' || Array.isArray(envelope.data)) {
    fatal('data must be an object-valued atom map');
  }
  for (const [id, atom] of Object.entries(envelope.data)) {
    if (!atom || typeof atom !== 'object' || Array.isArray(atom)) fatal(`atom ${id} must be an object`);
    if (atom.language === 'rust' && atom.kind === 'exec') {
      for (const field of ['is-relevant', 'untracked']) {
        if (typeof atom[field] !== 'boolean') fatal(`Rust exec ${id} has missing/non-boolean ${field}`);
      }
      if (atom['is-public-api'] !== undefined && typeof atom['is-public-api'] !== 'boolean') {
        fatal(`Rust exec ${id} has non-boolean is-public-api`);
      }
      if (atom['verification-status'] !== undefined &&
          !VERIFICATION_STATUSES.includes(atom['verification-status'])) {
        fatal(`Rust exec ${id} has invalid verification-status`);
      }
    }
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function optionalString(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fatal(`${label} must be a string when present`);
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string') fatal(`${label} must be a string`);
  return value;
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fatal(`${label} must be an array of strings`);
  }
  return [...value].sort();
}

function span(value, label) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' ||
      !Number.isInteger(value['lines-start']) || !Number.isInteger(value['lines-end'])) {
    fatal(`${label} must contain integer lines-start and lines-end`);
  }
  return { linesStart: value['lines-start'], linesEnd: value['lines-end'] };
}

function fqn(id) {
  return typeof id === 'string' ? id.replace(/^probe:/, '') : null;
}

function progress(functions) {
  const verification = Object.fromEntries(VERIFICATION_STATUSES.map((status) => [status, 0]));
  let specified = 0;
  for (const item of functions) {
    if (item.primarySpecId !== null) specified += 1;
    verification[item.verificationStatus] += 1;
  }
  verification.proved = verification.verified + verification['transitively-verified'];
  return {
    total: functions.length,
    specification: { specified, unspecified: functions.length - specified },
    verification,
  };
}

function project(envelope, publicApiExact) {
  const entries = Object.entries(envelope.data)
    .filter(([, atom]) => atom.language === 'rust' && atom.kind === 'exec' &&
      atom['is-relevant'] === true && atom.untracked === false)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  if (entries.length === 0) fatal('canonical inventory is empty');
  const ids = new Set(entries.map(([id]) => id));
  const baseFunctions = entries.map(([id, atom]) => {
    const displayName = requiredString(atom['display-name'], `${id}.display-name`);
    const rustPath = requiredString(atom['code-path'], `${id}.code-path`);
    const dependencies = stringArray(atom.dependencies, `${id}.dependencies`);
    const leanId = optionalString(atom['translation-name'], `${id}.translation-name`);
    const lean = leanId ? envelope.data[leanId] : null;
    const primarySpecId = optionalString(lean?.['primary-spec'], `${leanId}.primary-spec`);
    const primarySpec = primarySpecId ? envelope.data[primarySpecId] : null;
    return {
      id,
      displayName,
      rustFqn: optionalString(atom['rust-qualified-name'], `${id}.rust-qualified-name`) ?? displayName,
      rustPath,
      rustSpan: span(atom['code-text'], `${id}.code-text`),
      leanId,
      leanFqn: fqn(leanId),
      leanPath: optionalString(atom['translation-path'] ?? lean?.['code-path'], `${id}.Lean path`),
      leanSpan: span(atom['translation-text'] ?? lean?.['code-text'], `${id}.Lean span`),
      primarySpecId,
      primarySpecFqn: fqn(primarySpecId),
      primarySpecPath: optionalString(primarySpec?.['code-path'], `${primarySpecId}.code-path`),
      primarySpecSpan: span(primarySpec?.['code-text'], `${primarySpecId}.code-text`),
      dependencies,
      inScopeDependencies: dependencies.filter((dependency) => ids.has(dependency)),
      verificationStatus: optionalString(atom['verification-status'], `${id}.verification-status`) ?? 'unverified',
    };
  });
  const dependentSets = new Map(baseFunctions.map((item) => [item.id, new Set()]));
  for (const item of baseFunctions) {
    for (const dependency of item.inScopeDependencies) dependentSets.get(dependency).add(item.id);
  }
  const functions = baseFunctions.map((item) => ({
    ...item,
    outsideTargetDependencies: [],
    dependents: [...dependentSets.get(item.id)].sort(),
  }));
  const topLevelFunctions = functions
    .filter((item) => item.dependents.length === 0)
    .map((item) => item.id);
  const entryPointFunctions = functions
    .filter((item) => item.inScopeDependencies.length === 0)
    .map((item) => item.id);
  const publicApiComplete = publicApiExact &&
    entries.every(([, atom]) => typeof atom['is-public-api'] === 'boolean');
  return {
    schema: 'fvs/probe-inventory',
    schemaVersion: 1,
    source: {
      schema: envelope.schema,
      schemaVersion: envelope['schema-version'],
      tool: envelope.tool.name,
      version: envelope.tool.version,
      command: envelope.tool.command,
      timestamp: optionalString(envelope.timestamp, 'timestamp'),
      inputs: stable(envelope.inputs ?? []),
    },
    scopePredicate: SCOPE_PREDICATE,
    count: functions.length,
    topLevelFunctions,
    entryPointFunctions,
    publicTopLevelFunctions: publicApiComplete
      ? topLevelFunctions.filter((id) => envelope.data[id]['is-public-api'])
      : null,
    progress: progress(functions),
    functions,
  };
}

function slash(value) {
  return value.split(path.sep).join('/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function targetSelector(rawTarget, rawRoot) {
  const looksLikePath = path.isAbsolute(rawTarget) || /[\\/]/.test(rawTarget) ||
    /\.(?:lean|rs|toml|json)$/i.test(rawTarget);
  if (!looksLikePath) return { kind: 'name', value: rawTarget.replace(/^probe:/, '') };
  if (!rawRoot) fatal('--project-root is required for a path target');
  const root = path.resolve(rawRoot);
  let stat;
  try {
    stat = fs.statSync(root);
  } catch {
    stat = null;
  }
  if (!stat?.isDirectory()) fatal(`project root is not a directory: ${root}`);
  const resolved = path.resolve(root, rawTarget);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fatal(`target resolves outside the project root: ${rawTarget}`);
  }
  return { kind: 'path', value: slash(relative) };
}

function boundaryMatch(candidate, target, separators) {
  if (typeof candidate !== 'string') return false;
  const normalized = candidate.replace(/^probe:/, '');
  return normalized === target || separators.some((separator) => normalized.startsWith(`${target}${separator}`));
}

function selectTarget(inventory, rawTarget, rawRoot) {
  if (!rawTarget) return inventory;
  const selector = targetSelector(rawTarget, rawRoot);
  const functions = inventory.functions.filter((item) => {
    if (selector.kind === 'path') {
      return [item.rustPath, item.leanPath, item.primarySpecPath]
        .some((candidate) => boundaryMatch(candidate, selector.value, ['/']));
    }
    return [item.id, item.rustFqn, item.displayName, item.leanId, item.leanFqn,
      item.primarySpecId, item.primarySpecFqn]
      .some((candidate) => boundaryMatch(candidate, selector.value, ['::', '.', '#', '/']));
  });
  if (functions.length === 0) fatal(`target matched no canonical functions: ${rawTarget}`);
  const selectedIds = new Set(functions.map((item) => item.id));
  const selectedFunctions = functions.map((item) => ({
    ...item,
    inScopeDependencies: item.inScopeDependencies.filter((id) => selectedIds.has(id)),
    outsideTargetDependencies: item.inScopeDependencies.filter((id) => !selectedIds.has(id)),
  }));
  return {
    ...inventory,
    count: selectedFunctions.length,
    target: rawTarget,
    topLevelFunctions: inventory.topLevelFunctions.filter((id) => selectedIds.has(id)),
    entryPointFunctions: inventory.entryPointFunctions.filter((id) => selectedIds.has(id)),
    publicTopLevelFunctions: inventory.publicTopLevelFunctions === null
      ? null
      : inventory.publicTopLevelFunctions.filter((id) => selectedIds.has(id)),
    progress: progress(selectedFunctions),
    functions: selectedFunctions,
  };
}

function escapeTable(value) {
  return String(value ?? '—').replace(/\\/g, '\\\\').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function formattedProgress(count, total) {
  return `${count}/${total} (${((count / total) * 100).toFixed(1)}%)`;
}

function appendEndpointRows(lines, label, ids) {
  if (ids.length === 0) {
    lines.push(`| ${label} | — |`);
    return;
  }
  for (const id of ids) lines.push(`| ${label} | ${escapeTable(id)} |`);
}

function renderMarkdown(inventory) {
  const lines = [
    START_MARKER,
    '## Canonical Function Inventory',
    '',
    `- Source: probe-aeneas ${escapeTable(inventory.source.version)}`,
    `- Schema: ${escapeTable(inventory.source.schema)} ${escapeTable(inventory.source.schemaVersion)}`,
    `- Scope predicate: \`${SCOPE_PREDICATE}\``,
    `- Function count: **${inventory.count}**`,
  ];
  if (inventory.target) lines.push(`- Target: ${escapeTable(inventory.target)}`);
  lines.push(
    '',
    '### Graph Endpoints',
    '',
    'Endpoint membership is computed against the full canonical project graph.',
    '',
    '| Endpoint set | Atom ID |',
    '|---|---|',
  );
  appendEndpointRows(lines, 'Top-level (no project-wide dependents)', inventory.topLevelFunctions);
  appendEndpointRows(
    lines,
    'Entry point (no project-wide in-scope dependencies)',
    inventory.entryPointFunctions,
  );
  if (inventory.publicTopLevelFunctions === null) {
    lines.push('', '- Public top-level functions: unavailable (extract with `--with-public-api`).');
  } else {
    appendEndpointRows(lines, 'Public top-level', inventory.publicTopLevelFunctions);
  }
  const { total, specification, verification } = inventory.progress;
  lines.push(
    '',
    '### Progress',
    '',
    '| Axis | State | Progress |',
    '|---|---|---|',
    `| Specification | Specified | ${formattedProgress(specification.specified, total)} |`,
    `| Specification | Unspecified | ${formattedProgress(specification.unspecified, total)} |`,
    `| Verification | Unverified | ${formattedProgress(verification.unverified, total)} |`,
    `| Verification | Failed | ${formattedProgress(verification.failed, total)} |`,
    `| Verification | Verified | ${formattedProgress(verification.verified, total)} |`,
    `| Verification | Transitively verified | ${formattedProgress(verification['transitively-verified'], total)} |`,
    `| Verification | Trusted | ${formattedProgress(verification.trusted, total)} |`,
    `| Verification | Proved (verified + transitively-verified) | ${formattedProgress(verification.proved, total)} |`,
    '',
    '| Atom ID | Rust function | Lean FQN | Primary spec | Source | Selected deps | Outside-target deps | Dependents | Status |',
    '|---|---|---|---|---|---|---|---|---|',
  );
  for (const item of inventory.functions) {
    const source = `${item.rustPath}:${item.rustSpan?.linesStart ?? '?'}`;
    lines.push('| ' + [
      item.id,
      item.displayName,
      item.leanFqn,
      item.primarySpecFqn,
      source,
      item.inScopeDependencies.join(', '),
      item.outsideTargetDependencies.join(', '),
      item.dependents.join(', '),
      item.verificationStatus,
    ].map(escapeTable).join(' | ') + ' |');
  }
  lines.push(END_MARKER);
  return lines.join('\n');
}

function occurrences(content, needle) {
  return content.split(needle).length - 1;
}

function readCodemap(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    fatal(`cannot read CODEMAP ${file}: ${error.message}`);
  }
}

function managedRegion(content) {
  if (occurrences(content, START_MARKER) !== 1 || occurrences(content, END_MARKER) !== 1) {
    fatal('CODEMAP must contain exactly one canonical inventory marker pair');
  }
  const start = content.indexOf(START_MARKER);
  const endMarker = content.indexOf(END_MARKER, start + START_MARKER.length);
  if (endMarker < 0) fatal('CODEMAP canonical inventory markers are out of order');
  return { start, end: endMarker + END_MARKER.length };
}

function checkCodemap(file, expected) {
  const content = readCodemap(file);
  const { start, end } = managedRegion(content);
  if (content.slice(start, end) !== expected) fatal('CODEMAP canonical inventory block differs from probe output');
}

function updateCodemap(file, expected) {
  const content = readCodemap(file);
  const { start, end } = managedRegion(content);
  const updated = `${content.slice(0, start)}${expected}${content.slice(end)}`;
  try {
    if (updated !== content) fs.writeFileSync(file, updated);
  } catch (error) {
    fatal(`cannot update CODEMAP ${file}: ${error.message}`);
  }
}

const args = parseArgs(process.argv.slice(2));
const envelope = readJson(args.input);
validateEnvelope(envelope);
const inventory = selectTarget(project(envelope, args.publicApiExact), args.target, args.projectRoot);
const markdown = renderMarkdown(inventory);
if (args.updateCodemap) updateCodemap(args.updateCodemap, markdown);
if (args.codemap) checkCodemap(args.codemap, markdown);
if (args.format === 'count') process.stdout.write(`${inventory.count}\n`);
else if (args.format === 'markdown') process.stdout.write(`${markdown}\n`);
else process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
