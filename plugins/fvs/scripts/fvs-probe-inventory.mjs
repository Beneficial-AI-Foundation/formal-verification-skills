#!/usr/bin/env node
'use strict';

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

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
  throw new Error(message);
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
    '',
    '       node fvs-probe-inventory.mjs resolve --project-root DIR',
    '  [--probe ABS_PATH] [--platform TARGET] [--format json|status|text]',
    '       node fvs-probe-inventory.mjs run --project-root DIR --output FILE',
    '  [--probe ABS_PATH] [--with-public-api]',
    '       node fvs-probe-inventory.mjs install --project-root DIR',
    '  [--manifest | --manual | --consent interactive|policy] [--archive FILE]',
    '',
    'resolve classifies verified-probe readiness without writing anything.',
    'run executes the verified probe-aeneas by absolute path under an',
    'FVS-generated sandbox. install places the pinned official release in an',
    'FVS-owned versioned directory after explicit consent. The FVS tool',
    'directory is $FVS_TOOLS_HOME, default ~/.fvs/tools.',
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

function projectCli(argv) {
  const args = parseArgs(argv);
  const envelope = readJson(args.input);
  validateEnvelope(envelope);
  const inventory = selectTarget(project(envelope, args.publicApiExact), args.target, args.projectRoot);
  const markdown = renderMarkdown(inventory);
  if (args.updateCodemap) updateCodemap(args.updateCodemap, markdown);
  if (args.codemap) checkCodemap(args.codemap, markdown);
  if (args.format === 'count') process.stdout.write(`${inventory.count}\n`);
  else if (args.format === 'markdown') process.stdout.write(`${markdown}\n`);
  else process.stdout.write(`${JSON.stringify(inventory, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Verified probe-aeneas setup: read-only resolution, confined invocation and a
// consented installer.
//
// probe-aeneas v0.20.0 always passes --auto-install to probe-rust and runs
// `rustup component add rust-analyzer`, and probe-rust/probe-lean download
// helpers when they are absent. Checking PATH is therefore not a guarantee.
// Verified extraction only runs under an OS sandbox that denies all network
// and every write outside the project's build directories, the output
// directory and a private temporary directory.
// ---------------------------------------------------------------------------

// Official probe-aeneas release assets. Every archive digest is pinned so the
// asset is recognized, but a target is installable only after a confined
// end-to-end run on that platform has succeeded against a tested tuple and a
// missing-helper run has been denied.
export const PROBE_RELEASE = {
  tool: 'probe-aeneas',
  tag: 'v0.20.0',
  version: '0.20.0',
  tagCommit: '70cbb9b4675d1639721fa60d1e0f2cd2df80cb54',
  releaseId: 386091646,
  baseUrl: 'https://github.com/Beneficial-AI-Foundation/probe-aeneas/releases/download/v0.20.0/',
  assets: {
    'aarch64-apple-darwin': {
      asset: 'probe-aeneas-aarch64-apple-darwin.tar.xz',
      assetId: 554534252,
      archiveSha256: 'e5d3dc19335fe5739280c924b7cf10681a5d3a12d9381306dadd0d638f554f1a',
      archiveBytes: 819584,
      members: [
        'probe-aeneas-aarch64-apple-darwin/',
        'probe-aeneas-aarch64-apple-darwin/README.md',
        'probe-aeneas-aarch64-apple-darwin/probe-aeneas',
        'probe-aeneas-aarch64-apple-darwin/CHANGELOG.md',
      ],
      executable: 'probe-aeneas-aarch64-apple-darwin/probe-aeneas',
      executableSha256: '119873d191ea898274b664f2f45ea2e4b6f5e60bf6517f47fe689f38859968e9',
      supported: true,
    },
    'x86_64-apple-darwin': {
      asset: 'probe-aeneas-x86_64-apple-darwin.tar.xz',
      archiveSha256: '0dbb17060eb6fdde0c75c99fadd2aa41b09d5588362b850703e1ccfe84b9fa7e',
      supported: false,
      reason: 'probe-lean publishes no Lean v4.31.0 asset for macOS x64',
    },
    'aarch64-unknown-linux-gnu': {
      asset: 'probe-aeneas-aarch64-unknown-linux-gnu.tar.xz',
      archiveSha256: '9e6c67e567d740911f35fde6f406c481d80b618eb6e1f2303fe387e79ee2367a',
      supported: false,
      reason: 'Linux support is tracked in Beneficial-AI-Foundation/formal-verification-skills#77',
    },
    'x86_64-unknown-linux-gnu': {
      asset: 'probe-aeneas-x86_64-unknown-linux-gnu.tar.xz',
      archiveSha256: '988ce6e1d2596e31a2464c8e612dc03f9fff47c957e7c1975ab502212582bd0f',
      supported: false,
      reason: 'Linux support is tracked in Beneficial-AI-Foundation/formal-verification-skills#77',
    },
    'x86_64-pc-windows-msvc': {
      asset: 'probe-aeneas-x86_64-pc-windows-msvc.zip',
      archiveSha256: '91ebd551073d0f705fdf905185e8d82224c53909f22ef774c231aa411000a2dc',
      supported: false,
      reason: 'scip and probe-lean publish no Windows binaries, and there is no confinement equivalent',
    },
  },
};

// Consumer provenance tuples with a passing confined extraction. A project is
// verified only when its generated translation.json, its Aeneas lock pin and
// its Lean toolchain all match one tuple exactly.
export const TESTED_TUPLES = [
  {
    id: 'aeneas-6e167c9b-charon-0.1.225-lean-v4.31.0',
    aeneasRev: '6e167c9b63a4dafd66d0e0edd9d94669f957ff7b',
    charonVersion: '0.1.225',
    leanToolchain: 'leanprover/lean4:v4.31.0',
    probeAeneasVersion: '0.20.0',
    testedWith: 'Beneficial-AI-Foundation/curve25519-dalek-lean-verify@0a22c281a9a14b6465a5473c200c7d3f1ac92df8',
    platforms: {
      'aarch64-apple-darwin': {
        isolation: 'sandbox-exec',
        helpers: {
          'probe-rust': { version: 'probe-rust 0.11.0' },
          scip: { version: 'scip version v0.10.0' },
          'probe-lean': { version: '0.14.0' },
          'rust-analyzer': {
            version: 'rust-analyzer 1.98.1 (48a229ce 2026-09-01)',
            components: ['rust-analyzer', 'rust-src'],
          },
        },
      },
    },
  },
];

// Manual setup for each helper at the tested version. FVS never installs a
// helper; it only prints these steps.
const HELPER_SETUP = {
  'aarch64-apple-darwin': {
    'probe-rust': 'cargo install --locked --git https://github.com/Beneficial-AI-Foundation/probe-rust --rev 1d2a7c5d0e5a5dd95e55c8d6a51cddae0b3d7572',
    scip: 'download https://github.com/scip-code/scip/releases/download/v0.10.0/scip-darwin-arm64.tar.gz (sha256 7ea200390e0790b3da8999b7b1cd4e3597700dcb3d354911872523bfe0090779) and place its scip executable on PATH or at ~/.probe-rust/tools/scip',
    'probe-lean': 'download https://github.com/Beneficial-AI-Foundation/probe-lean/releases/download/v0.14.0/probe-lean-v4.31.0-darwin-arm64.tar.gz (sha256 54af80f3c13261e6a193a691cda9bf02af6801438e797a087986173b88af19e5); install bin/probe-lean as ~/.local/bin/probe-lean-v4.31.0 and lib/ as ~/.local/lib/probe-lean-v4.31.0',
    'rust-analyzer': 'rustup toolchain install 1.98.1 --profile minimal --component rust-analyzer --component rust-src, then make it the active toolchain for this project (rustup default 1.98.1 or rustup override set 1.98.1)',
  },
};

const PREREQUISITE_NOTE = 'The confined run has no network: build the Lean project (lake exe cache get, lake build) and fetch Cargo dependencies (cargo fetch) first.';
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const BSDTAR = '/usr/bin/tar';
const CHOICES = ['setup', 'continue-without-graph', 'cancel'];
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 120000;

export function hostTarget() {
  const arch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch];
  const system = { darwin: 'apple-darwin', linux: 'unknown-linux-gnu', win32: 'pc-windows-msvc' }[process.platform];
  return arch && system ? `${arch}-${system}` : `${process.arch}-${process.platform}`;
}

function toolsHome() {
  return path.resolve(process.env.FVS_TOOLS_HOME || path.join(os.homedir(), '.fvs', 'tools'));
}

export function managedProbePath(root = toolsHome(), target = hostTarget(), release = PROBE_RELEASE) {
  return path.join(root, release.tool, `${release.version}-${target}`, release.tool);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

function executableFile(file) {
  try {
    if (!fs.statSync(file).isFile()) return null;
    fs.accessSync(file, fs.constants.X_OK);
    return file;
  } catch {
    return null;
  }
}

function which(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const found = executableFile(path.join(dir, name));
    if (found) return found;
  }
  return null;
}

// Realpath of the longest existing ancestor plus the missing tail, so sandbox
// rules name the paths the kernel actually sees (/tmp is /private/tmp).
function realish(file) {
  let head = path.resolve(file);
  const tail = [];
  while (!fs.existsSync(head)) {
    const parent = path.dirname(head);
    if (parent === head) break;
    tail.unshift(path.basename(head));
    head = parent;
  }
  return path.join(fs.realpathSync(head), ...tail);
}

function insideRoot(root, relative) {
  if (typeof relative !== 'string' || relative === '' || path.isAbsolute(relative)) return null;
  const resolved = path.resolve(root, relative);
  const back = path.relative(root, resolved);
  if (back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) return null;
  return resolved;
}

// Reads the three scalar keys probe-aeneas uses from aeneas-config.yml. A key
// that is repeated or not a plain scalar is reported rather than guessed.
function readAeneasConfig(file) {
  const wanted = new Set(['aeneas.commit', 'crate.dir', 'aeneas_args.dest']);
  const values = {};
  const problems = [];
  let section = null;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (/^\s*(#|$)/.test(line)) continue;
    const top = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (top) {
      section = top[1];
      continue;
    }
    const child = line.match(/^\s+([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!child || !section) continue;
    const key = `${section}.${child[1]}`;
    if (!wanted.has(key)) continue;
    const value = child[2].trim().replace(/^(["'])(.*)\1$/, '$2');
    if (key in values) problems.push(`aeneas-config.yml repeats ${key}`);
    else if (!value || /^[[{|>&*!]/.test(value)) problems.push(`aeneas-config.yml ${key} is not a plain scalar`);
    else values[key] = value;
  }
  return { values, problems };
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Actual provenance of the project's current extraction: the generated
// translation.json, the Aeneas pin in lake-manifest.json and aeneas-config.yml,
// and lean-toolchain. The FVS-vendored Aeneas revision is never substituted.
export function readProvenance(projectRoot) {
  const problems = [];
  const provenance = {
    projectRoot,
    rustProject: projectRoot,
    translationJson: null,
    translationSha256: null,
    aeneasVersion: null,
    charonVersion: null,
    aeneasRev: null,
    aeneasConfigCommit: null,
    leanToolchain: null,
    problems,
  };
  let stat = null;
  try {
    stat = fs.statSync(projectRoot);
  } catch {
    stat = null;
  }
  if (!stat?.isDirectory()) {
    problems.push(`project root is not a directory: ${projectRoot}`);
    return provenance;
  }

  const configFile = path.join(projectRoot, 'aeneas-config.yml');
  let config = { values: {}, problems: [] };
  if (fs.existsSync(configFile)) {
    config = readAeneasConfig(configFile);
    problems.push(...config.problems);
  } else {
    problems.push('aeneas-config.yml is missing (the probe-aeneas project route requires it)');
  }
  provenance.aeneasConfigCommit = config.values['aeneas.commit'] ?? null;
  const crateDir = config.values['crate.dir'];
  if (crateDir && crateDir !== '.') {
    const crateRoot = insideRoot(projectRoot, crateDir);
    if (!crateRoot) problems.push(`crate.dir escapes the project root: ${crateDir}`);
    else if (fs.existsSync(path.join(crateRoot, 'Cargo.toml'))) provenance.rustProject = crateRoot;
  }
  const dest = config.values['aeneas_args.dest'];
  const translationDir = dest ? insideRoot(projectRoot, dest) : projectRoot;
  if (!translationDir) problems.push(`aeneas_args.dest escapes the project root: ${dest}`);

  const translationFile = translationDir ? path.join(translationDir, 'translation.json') : null;
  if (translationFile && fs.existsSync(translationFile)) {
    provenance.translationJson = translationFile;
    try {
      const bytes = fs.readFileSync(translationFile);
      provenance.translationSha256 = sha256(bytes);
      const manifest = JSON.parse(bytes.toString('utf8'));
      for (const [field, key] of [['aeneas_version', 'aeneasVersion'], ['charon_version', 'charonVersion']]) {
        if (typeof manifest?.[field] === 'string' && manifest[field]) provenance[key] = manifest[field];
        else problems.push(`translation.json has no ${field}`);
      }
    } catch (error) {
      problems.push(`cannot read translation.json: ${error.message}`);
    }
  } else if (translationDir) {
    problems.push('generated translation.json is missing (regenerate the extraction with Aeneas emitting translation.json)');
  }

  const manifestFile = path.join(projectRoot, 'lake-manifest.json');
  try {
    const packages = readJsonFile(manifestFile).packages;
    const aeneas = Array.isArray(packages)
      ? packages.filter((item) => item?.name === 'aeneas')
      : [];
    if (aeneas.length !== 1) problems.push('lake-manifest.json must pin exactly one aeneas package');
    else if (!/^[0-9a-f]{40}$/.test(aeneas[0].rev ?? '')) problems.push('lake-manifest.json aeneas rev is not a full commit');
    else provenance.aeneasRev = aeneas[0].rev;
  } catch (error) {
    problems.push(`cannot read lake-manifest.json: ${error.message}`);
  }

  try {
    const toolchain = fs.readFileSync(path.join(projectRoot, 'lean-toolchain'), 'utf8').trim();
    if (toolchain) provenance.leanToolchain = toolchain;
    else problems.push('lean-toolchain is empty');
  } catch {
    problems.push('lean-toolchain is missing');
  }

  const pinMatches = (short) => /^[0-9a-f]{7,40}$/.test(short) && provenance.aeneasRev.startsWith(short);
  if (provenance.aeneasRev && provenance.aeneasVersion && !pinMatches(provenance.aeneasVersion)) {
    problems.push(`conflict: translation.json aeneas_version ${provenance.aeneasVersion} does not match lake-manifest.json aeneas ${provenance.aeneasRev}`);
  }
  if (provenance.aeneasRev && provenance.aeneasConfigCommit && !pinMatches(provenance.aeneasConfigCommit)) {
    problems.push(`conflict: aeneas-config.yml aeneas.commit ${provenance.aeneasConfigCommit} does not match lake-manifest.json aeneas ${provenance.aeneasRev}`);
  }
  return provenance;
}

// Deny-everything profile for version checks, so resolution cannot trigger a
// rustup auto-install or any other write even through a proxy binary.
const READ_ONLY_DEVICES = [
  '(literal "/dev/null")',
  '(literal "/dev/zero")',
  '(literal "/dev/dtracehelper")',
  '(regex #"^/dev/tty")',
  '(regex #"^/dev/fd/")',
];
const READ_ONLY_POLICY = [
  '(version 1)',
  '(allow default)',
  '(deny network*)',
  '(deny file-write*)',
  `(allow file-write* ${READ_ONLY_DEVICES.join(' ')})`,
].join('\n');

function readOnlyRun(bin, args, cwd) {
  const argv = fs.existsSync(SANDBOX_EXEC) ? [SANDBOX_EXEC, '-p', READ_ONLY_POLICY, bin, ...args] : [bin, ...args];
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, RUSTUP_AUTO_INSTALL: '0' },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { ok: result.status === 0, stdout: (result.stdout ?? '').trim(), output: output || result.error?.message || '' };
}

function firstLine(text) {
  return text.split(/\r?\n/)[0].trim();
}

// Helper verification is by exact `--version` output, resolved the same way
// upstream resolves each helper. Digests are not compared: probe-rust is a
// source build whose binary differs per host, and the official scip,
// probe-lean and rustup builds are identified by their release version; their
// observed digests are recorded as evidence in the test fixture instead.
// Version 0.11.0 of probe-rust cannot distinguish the tested source commit
// from the v0.11.0 tag, so the manual step pins the commit.
function checkHelpers(spec, provenance) {
  const home = os.homedir();
  const leanVersion = (provenance.leanToolchain ?? '').split(':').pop();
  const cwd = provenance.rustProject;
  const located = {
    'probe-rust': which('probe-rust') ?? executableFile(path.join(home, '.cargo', 'bin', 'probe-rust')),
    scip: executableFile(path.join(home, '.probe-rust', 'tools', 'scip')) ?? which('scip'),
    'probe-lean': executableFile(path.join(home, '.local', 'bin', `probe-lean-${leanVersion}`)),
    'rust-analyzer': which('rust-analyzer'),
  };
  const results = {};
  for (const [name, expected] of Object.entries(spec)) {
    const bin = located[name];
    const entry = { status: 'missing', path: bin, expected: expected.version, found: null };
    results[name] = entry;
    if (!bin) continue;
    const version = readOnlyRun(bin, ['--version'], cwd);
    if (!version.ok) {
      entry.found = firstLine(version.output);
      if (name !== 'rust-analyzer') entry.status = 'incompatible';
      continue;
    }
    entry.found = firstLine(version.stdout);
    entry.status = entry.found === expected.version ? 'ok' : 'incompatible';
    if (entry.status === 'ok' && name === 'probe-lean' &&
        !fs.existsSync(path.join(home, '.local', 'lib', `probe-lean-${leanVersion}`))) {
      entry.status = 'missing';
      entry.found += ` (library directory ~/.local/lib/probe-lean-${leanVersion} is missing)`;
    }
    if (entry.status === 'ok' && expected.components) {
      const rustup = which('rustup');
      const listed = rustup ? readOnlyRun(rustup, ['component', 'list', '--installed'], cwd) : null;
      const installed = listed?.ok ? listed.stdout.split(/\r?\n/).map((line) => line.trim()) : [];
      const absent = expected.components.filter((component) =>
        !installed.some((line) => line === component || line.startsWith(`${component}-`)));
      if (absent.length > 0) {
        entry.status = 'missing';
        entry.found += ` (missing rustup components: ${absent.join(', ')})`;
      }
    }
  }
  return results;
}

function candidateProbe(explicit, target) {
  if (explicit) {
    if (!path.isAbsolute(explicit)) return { source: 'explicit', path: explicit, error: '--probe must be an absolute path' };
    return { source: 'explicit', path: explicit };
  }
  const managed = managedProbePath(toolsHome(), target);
  if (fs.existsSync(managed)) return { source: 'fvs-managed', path: managed };
  const onPath = which('probe-aeneas');
  return onPath ? { source: 'path', path: onPath } : null;
}

function checkProbe(candidate, asset, cwd) {
  if (!candidate) return { status: 'missing', reason: 'probe-aeneas is not installed' };
  const probe = { ...candidate, status: 'incompatible' };
  if (candidate.error) return { ...probe, reason: candidate.error };
  const bin = executableFile(candidate.path);
  if (!bin) return { ...probe, status: 'missing', reason: `${candidate.path} is not an executable file` };
  probe.path = fs.realpathSync(bin);
  probe.sha256 = sha256File(probe.path);
  probe.official = Boolean(asset?.executableSha256) && probe.sha256 === asset.executableSha256;
  if (candidate.source === 'fvs-managed' && !probe.official) {
    return { ...probe, reason: 'the FVS-managed probe-aeneas does not match the pinned executable digest' };
  }
  const version = readOnlyRun(probe.path, ['--version'], cwd);
  probe.version = firstLine(version.ok ? version.stdout : version.output);
  const expected = `probe-aeneas ${PROBE_RELEASE.version}`;
  if (probe.version !== expected) return { ...probe, reason: `found "${probe.version}", the tested release is "${expected}"` };
  return { ...probe, status: 'ok' };
}

function tupleMismatch(provenance) {
  return TESTED_TUPLES.map((tuple) => {
    const differences = [];
    if (provenance.aeneasRev !== tuple.aeneasRev) differences.push(`aeneas ${provenance.aeneasRev} != ${tuple.aeneasRev}`);
    if (provenance.charonVersion !== tuple.charonVersion) differences.push(`charon ${provenance.charonVersion} != ${tuple.charonVersion}`);
    if (provenance.leanToolchain !== tuple.leanToolchain) differences.push(`lean ${provenance.leanToolchain} != ${tuple.leanToolchain}`);
    return `${tuple.id}: ${differences.join('; ')}`;
  });
}

// Read-only classification of verified-probe readiness. It never installs,
// downloads or writes; version checks run under a deny-all-writes sandbox.
export function resolveProbe({ projectRoot, probe = null, platform = hostTarget() }) {
  const root = path.resolve(projectRoot);
  const provenance = readProvenance(root);
  const asset = PROBE_RELEASE.assets[platform];
  const result = {
    schema: 'fvs/probe-resolve',
    schemaVersion: 1,
    status: null,
    reasons: [],
    platform,
    platformSupported: Boolean(asset?.supported),
    provenance,
    tuple: null,
    probe: null,
    helpers: {},
    install: { available: false },
    choices: CHOICES,
    manual: [],
  };
  const finish = (status) => {
    result.status = status;
    if (status === 'verified') result.choices = [];
    return result;
  };

  if (!asset?.supported) {
    result.reasons.push(asset
      ? `${platform} is not a supported verified-probe platform: ${asset.reason}`
      : `no official probe-aeneas ${PROBE_RELEASE.tag} asset exists for ${platform}`);
    result.manual.push('Verified probe operations are unavailable on this platform. Continue without a graph for exploratory work.');
    return finish('unsupported-platform');
  }
  if (provenance.problems.length > 0) {
    result.reasons.push(...provenance.problems.map((problem) => `unknown provenance: ${problem}`));
    result.manual.push('Regenerate the Aeneas extraction so translation.json, lake-manifest.json and aeneas-config.yml agree, or continue without a graph.');
    return finish('unknown');
  }
  const tuple = TESTED_TUPLES.find((item) =>
    item.aeneasRev === provenance.aeneasRev &&
    item.charonVersion === provenance.charonVersion &&
    item.leanToolchain === provenance.leanToolchain);
  if (!tuple) {
    result.reasons.push(`no tested probe-aeneas tuple matches this project (${tupleMismatch(provenance).join(' | ')})`);
    result.manual.push('No probe-aeneas release is known to be compatible with this Aeneas/Charon/Lean combination; FVS will not select one by date. Continue without a graph, or ask the probe-aeneas maintainers for a compatible release.');
    return finish('incompatible');
  }
  const tested = tuple.platforms[platform];
  if (!tested) {
    result.reasons.push(`tuple ${tuple.id} has no confined-run evidence on ${platform}`);
    return finish('unsupported-platform');
  }
  result.tuple = tuple.id;

  result.probe = checkProbe(candidateProbe(probe, platform), asset, provenance.rustProject);
  if (result.probe.status !== 'ok') {
    result.reasons.push(`probe-aeneas ${result.probe.status}: ${result.probe.reason}`);
    const destination = managedProbePath(toolsHome(), platform);
    result.install = {
      available: true,
      version: PROBE_RELEASE.version,
      tagCommit: PROBE_RELEASE.tagCommit,
      url: `${PROBE_RELEASE.baseUrl}${asset.asset}`,
      archiveSha256: asset.archiveSha256,
      executableSha256: asset.executableSha256,
      destination,
      pathChanges: 'none; FVS invokes the installed executable by absolute path',
    };
    result.manual.push(`FVS can install the official probe-aeneas ${PROBE_RELEASE.tag} side by side at ${destination} after consent (install --consent interactive). Manually: download ${result.install.url}, check sha256 ${asset.archiveSha256}, unpack it and pass the absolute executable path with --probe.`);
  }
  result.helpers = checkHelpers(tested.helpers, provenance);
  for (const [name, helper] of Object.entries(result.helpers)) {
    if (helper.status === 'ok') continue;
    result.reasons.push(`${name} ${helper.status}: expected "${helper.expected}", found ${helper.found ? `"${helper.found}"` : 'nothing'}`);
    result.manual.push(`${name}: ${HELPER_SETUP[platform]?.[name] ?? 'install the tested version manually'}`);
  }
  if (result.reasons.length > 0) result.manual.push(PREREQUISITE_NOTE);
  const states = [result.probe.status, ...Object.values(result.helpers).map((helper) => helper.status)];
  if (states.includes('incompatible')) return finish('incompatible');
  if (states.includes('missing')) return finish('missing');
  return finish('verified');
}

function renderResolveText(result) {
  const lines = [
    `FVS >> probe-aeneas: ${result.status}`,
    `Platform: ${result.platform}${result.platformSupported ? '' : ' (not supported for verified probe operations)'}`,
    `Project: ${result.provenance.projectRoot}`,
    `Provenance: aeneas ${result.provenance.aeneasRev ?? 'unknown'}, charon ${result.provenance.charonVersion ?? 'unknown'}, lean ${result.provenance.leanToolchain ?? 'unknown'}`,
  ];
  if (result.tuple) lines.push(`Tested tuple: ${result.tuple}`);
  if (result.probe?.path) lines.push(`Probe: ${result.probe.path} (${result.probe.source}, ${result.probe.version ?? 'version unknown'})`);
  for (const reason of result.reasons) lines.push(`- ${reason}`);
  if (result.choices.length > 0) {
    lines.push(`Choices: ${result.choices.join(' / ')}`);
    for (const step of result.manual) lines.push(`  setup: ${step}`);
  }
  return `${lines.join('\n')}\n`;
}

function sbplString(value) {
  if (/["\\\u0000-\u001f\u007f]/.test(value)) fatal(`path cannot be used in a sandbox profile: ${JSON.stringify(value)}`);
  return `"${value}"`;
}

function sbplRegexPath(value) {
  sbplString(value);
  return value.replace(/[.^$*+?()[\]{}|]/g, '\\$&');
}

// Tool homes and bin directories the confined run must never modify. They
// are denied after the allowances so no project, output or tmp allowance can
// reopen one of them.
export function protectedDirs(probePath = null) {
  const home = os.homedir();
  const dirs = [
    path.join(home, '.cargo'),
    path.join(home, '.rustup'),
    path.join(home, '.elan'),
    path.join(home, '.local'),
    path.join(home, '.probe-rust'),
    process.env.CARGO_HOME,
    process.env.RUSTUP_HOME,
    process.env.ELAN_HOME,
    toolsHome(),
    probePath && path.dirname(probePath),
    ...(process.env.PATH || '').split(path.delimiter).filter((dir) => path.isAbsolute(dir)),
  ].filter(Boolean).map(realish);
  return [...new Set(dirs)].sort();
}

// Generates the confinement profile for one extraction: deny all network,
// deny writes everywhere except the project build directories probe-aeneas,
// probe-rust, cargo and Lake write, the explicit output directory and a
// private tmp, then deny every tool home and bin directory again.
export function extractionPolicy({ projectRoot, rustProject, outputDir, privateTmp, protect }) {
  const root = realish(projectRoot);
  const crate = realish(rustProject);
  const allow = [
    `(subpath ${sbplString(path.join(root, '.lake'))})`,
    `(subpath ${sbplString(path.join(root, '.verilib'))})`,
  ];
  for (const base of [...new Set([root, crate])]) {
    allow.push(`(subpath ${sbplString(path.join(base, 'target'))})`);
    allow.push(`(regex #"^${sbplRegexPath(base)}/target${'[A-Za-z0-9]'.repeat(6)}(/.*)?$")`);
  }
  allow.push(
    `(subpath ${sbplString(path.join(crate, 'data'))})`,
    `(literal ${sbplString(path.join(crate, 'index.scip'))})`,
    `(subpath ${sbplString(realish(outputDir))})`,
    `(subpath ${sbplString(realish(privateTmp))})`,
    ...READ_ONLY_DEVICES,
  );
  return [
    '(version 1)',
    ';; FVS confined probe-aeneas extraction. Later rules take precedence.',
    '(allow default)',
    '(deny network*)',
    '(deny file-write*)',
    ';; cargo creates target/ through a temporary sibling target<6 chars>',
    `(allow file-write*\n  ${allow.join('\n  ')})`,
    `(deny file-write*\n  ${protect.map((dir) => `(subpath ${sbplString(dir)})`).join('\n  ')})`,
  ].join('\n') + '\n';
}

// Runs probe-aeneas by absolute path under the generated profile. On any
// failure the output file is removed so no partial graph is accepted.
export function confinedExtract({ probePath, projectRoot, rustProject, output, withPublicApi = false, stdio = 'inherit' }) {
  if (!fs.existsSync(SANDBOX_EXEC)) return { ok: false, error: `${SANDBOX_EXEC} is unavailable` };
  const outputDir = fs.realpathSync(path.dirname(path.resolve(output)));
  const outputFile = path.join(outputDir, path.basename(output));
  fs.rmSync(outputFile, { force: true });
  const privateTmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-probe-run-')));
  try {
    const policy = extractionPolicy({
      projectRoot, rustProject, outputDir, privateTmp, protect: protectedDirs(probePath),
    });
    const args = ['-p', policy, probePath, 'extract', projectRoot, '-o', outputFile];
    if (withPublicApi) args.push('--with-public-api');
    const child = spawnSync(SANDBOX_EXEC, args, {
      cwd: outputDir,
      stdio: stdio === 'inherit' ? ['ignore', 'inherit', 'inherit'] : 'pipe',
      encoding: 'utf8',
      timeout: 30 * 60 * 1000,
      env: { ...process.env, TMPDIR: `${privateTmp}/` },
    });
    const log = stdio === 'inherit' ? '' : `${child.stdout ?? ''}${child.stderr ?? ''}`;
    if (child.status !== 0 || !fs.existsSync(outputFile)) {
      fs.rmSync(outputFile, { force: true });
      return { ok: false, status: child.status, log, error: child.error?.message ?? `probe-aeneas exited with ${child.status}` };
    }
    try {
      const envelope = readJson(outputFile);
      validateEnvelope(envelope);
      if (envelope.tool.version !== PROBE_RELEASE.version) fatal(`extract came from probe-aeneas ${envelope.tool.version}`);
    } catch (error) {
      fs.rmSync(outputFile, { force: true });
      return { ok: false, status: child.status, log, error: error.message };
    }
    return { ok: true, output: outputFile, policy, log };
  } finally {
    fs.rmSync(privateTmp, { recursive: true, force: true });
  }
}

function tarString(block, start, length) {
  const end = block.indexOf(0, start);
  return block.toString('utf8', start, end >= 0 && end < start + length ? end : start + length);
}

function tarSize(block) {
  if (block[124] & 0x80) fatal('archive member size uses an unsupported encoding');
  const text = tarString(block, 124, 12).trim();
  if (!/^[0-7]+$/.test(text)) fatal('archive member size is malformed');
  return parseInt(text, 8);
}

function paxRecords(buffer) {
  const records = {};
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    const length = parseInt(buffer.toString('utf8', offset, space), 10);
    if (space < 0 || !Number.isInteger(length) || length <= 0) fatal('archive pax header is malformed');
    const record = buffer.toString('utf8', space + 1, offset + length - 1);
    const equals = record.indexOf('=');
    if (equals < 0) fatal('archive pax header is malformed');
    records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

// Strict reader for an uncompressed tar stream. Only regular files and
// directory entries named in `members` are accepted; links, devices, FIFOs,
// duplicates, absolute or traversal names and unexpected names are rejected.
export function inspectTar(buffer, { members, executable }) {
  const seen = new Set();
  let executableBytes = null;
  let pending = {};
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const block = buffer.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const stored = parseInt(tarString(block, 148, 8).trim(), 8);
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) checksum += index >= 148 && index < 156 ? 32 : block[index];
    if (stored !== checksum) fatal('archive header checksum mismatch');
    const type = String.fromCharCode(block[156] || 48);
    const size = tarSize(block);
    const body = buffer.subarray(offset + 512, offset + 512 + size);
    if (body.length !== size) fatal('archive is truncated');
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      pending = paxRecords(body);
      continue;
    }
    const prefix = tarString(block, 345, 155);
    const headerName = prefix ? `${prefix}/${tarString(block, 0, 100)}` : tarString(block, 0, 100);
    const name = pending.path ?? headerName;
    const linkName = pending.linkpath ?? tarString(block, 157, 100);
    pending = {};
    if (!['0', '5'].includes(type)) fatal(`archive member ${JSON.stringify(name)} is not a regular file or directory (type ${type})`);
    if (linkName) fatal(`archive member ${JSON.stringify(name)} is a link`);
    if (name.startsWith('/') || name.split('/').some((part) => part === '..' || part === '.')) {
      fatal(`archive member ${JSON.stringify(name)} escapes the archive root`);
    }
    if (seen.has(name)) fatal(`archive member ${JSON.stringify(name)} is duplicated`);
    seen.add(name);
    if (!members.includes(name)) fatal(`archive member ${JSON.stringify(name)} is unexpected`);
    if ((type === '5') !== name.endsWith('/')) fatal(`archive member ${JSON.stringify(name)} has the wrong type`);
    if (name === executable) executableBytes = Buffer.from(body);
  }
  if (seen.size === 0) fatal('archive is empty');
  if (!executableBytes) fatal(`archive has no ${executable}`);
  return executableBytes;
}

async function download(url, fetchImpl) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!current.startsWith('https://')) fatal(`refusing a non-HTTPS download URL: ${current}`);
    const response = await fetchImpl(current, { redirect: 'manual', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) fatal('redirect without a Location header');
      current = new URL(location, current).href;
      continue;
    }
    if (response.status !== 200) fatal(`download failed with HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_ARCHIVE_BYTES) fatal('download is larger than the archive size limit');
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > MAX_ARCHIVE_BYTES) fatal('download is larger than the archive size limit');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  return fatal('too many redirects');
}

function appendAudit(parent, record) {
  fs.appendFileSync(path.join(parent, 'install-audit.jsonl'), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

// Installs one pinned official release into <toolsRoot>/probe-aeneas/<version>-<target>/.
// The compressed digest is checked before the archive is read, the single
// executable is staged in a private sibling directory and checked by digest
// and `--version`, and only then renamed into place. A preexisting
// destination is never replaced. Every attempt is appended to the audit log.
export async function installProbe({
  toolsRoot = toolsHome(),
  target = hostTarget(),
  release = PROBE_RELEASE,
  archive = null,
  decision,
  provenance = null,
  fetchImpl = globalThis.fetch,
}) {
  const asset = release.assets[target];
  if (!asset?.supported) fatal(`${target} is not installable: ${asset?.reason ?? 'no official asset'}`);
  if (!['interactive', 'policy'].includes(decision)) fatal('install requires an explicit consent decision');
  const parent = path.join(toolsRoot, release.tool);
  const destination = path.join(parent, `${release.version}-${target}`);
  const record = {
    timestamp: new Date().toISOString(),
    tool: release.tool,
    version: release.version,
    tag: release.tag,
    tagCommit: release.tagCommit,
    releaseId: release.releaseId ?? null,
    assetId: asset.assetId ?? null,
    url: `${release.baseUrl}${asset.asset}`,
    source: archive ? `local archive ${path.resolve(archive)}` : 'download',
    platform: target,
    decision,
    provenance,
    expectedArchiveSha256: asset.archiveSha256,
    actualArchiveSha256: null,
    expectedExecutableSha256: asset.executableSha256,
    actualExecutableSha256: null,
    versionOutput: null,
    destination,
    outcome: null,
  };
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const executablePath = path.join(destination, release.tool);
  if (fs.existsSync(destination)) {
    const current = executableFile(executablePath) ? sha256File(executablePath) : null;
    record.actualExecutableSha256 = current;
    record.outcome = current === asset.executableSha256 ? 'already-installed' : 'failed: destination exists with unverified content; left unchanged';
    appendAudit(parent, record);
    if (record.outcome !== 'already-installed') fatal(record.outcome);
    return { ...record, executable: executablePath };
  }
  const staging = fs.mkdtempSync(path.join(parent, '.staging-'));
  try {
    const bytes = archive ? fs.readFileSync(archive) : await download(record.url, fetchImpl);
    if (bytes.length > MAX_ARCHIVE_BYTES) fatal('archive is larger than the size limit');
    record.actualArchiveSha256 = sha256(bytes);
    if (record.actualArchiveSha256 !== asset.archiveSha256) fatal('archive SHA-256 does not match the pinned official digest');
    const archiveFile = path.join(staging, asset.asset);
    fs.writeFileSync(archiveFile, bytes, { mode: 0o600 });
    const tar = spawnSync(BSDTAR, ['-cf', '-', `@${archiveFile}`], { maxBuffer: 256 * 1024 * 1024 });
    if (tar.status !== 0) fatal(`cannot decompress archive: ${String(tar.stderr ?? tar.error?.message).trim()}`);
    const executableBytes = inspectTar(tar.stdout, asset);
    fs.rmSync(archiveFile);
    record.actualExecutableSha256 = sha256(executableBytes);
    if (record.actualExecutableSha256 !== asset.executableSha256) fatal('executable SHA-256 does not match the pinned digest');
    const staged = path.join(staging, release.tool);
    fs.writeFileSync(staged, executableBytes, { mode: 0o755 });
    const version = readOnlyRun(staged, ['--version'], staging);
    record.versionOutput = firstLine(version.ok ? version.stdout : version.output);
    if (record.versionOutput !== `${release.tool} ${release.version}`) fatal(`staged executable reports "${record.versionOutput}"`);
    record.outcome = 'installed';
    fs.writeFileSync(path.join(staging, 'INSTALL.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(staging, destination);
    appendAudit(parent, record);
    return { ...record, executable: executablePath };
  } catch (error) {
    record.outcome = `failed: ${error.message}`;
    appendAudit(parent, record);
    throw error;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function parseFlags(argv, booleans, values) {
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }
  const flags = {};
  const rest = [...argv];
  while (rest.length > 0) {
    const flag = rest.shift();
    const key = flag.replace(/^--/, '');
    if (booleans.includes(key)) {
      flags[key] = true;
      continue;
    }
    if (!values.includes(key)) fatal(`unknown argument ${JSON.stringify(flag)}`);
    const value = rest.shift();
    if (!value || value.startsWith('--')) fatal(`${flag} requires a value`);
    flags[key] = value;
  }
  if (!flags['project-root']) fatal('--project-root is required');
  return flags;
}

function resolveCli(argv) {
  const flags = parseFlags(argv, [], ['project-root', 'probe', 'platform', 'format']);
  const format = flags.format ?? 'json';
  if (!['json', 'status', 'text'].includes(format)) fatal('--format must be json, status, or text');
  const result = resolveProbe({ projectRoot: flags['project-root'], probe: flags.probe, platform: flags.platform });
  if (format === 'status') process.stdout.write(`${result.status}\n`);
  else if (format === 'text') process.stdout.write(renderResolveText(result));
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

function runCli(argv) {
  const flags = parseFlags(argv, ['with-public-api'], ['project-root', 'probe', 'output']);
  if (!flags.output) fatal('--output is required');
  if (!fs.existsSync(path.dirname(path.resolve(flags.output)))) fatal('the --output directory must exist');
  const result = resolveProbe({ projectRoot: flags['project-root'], probe: flags.probe });
  if (result.status !== 'verified') {
    process.stderr.write(renderResolveText(result));
    process.stderr.write('FVS >> refusing verified extraction: the probe is not verified for this project\n');
    return 3;
  }
  const run = confinedExtract({
    probePath: result.probe.path,
    projectRoot: result.provenance.projectRoot,
    rustProject: result.provenance.rustProject,
    output: flags.output,
    withPublicApi: Boolean(flags['with-public-api']),
  });
  if (!run.ok) {
    process.stderr.write(`FVS >> confined probe-aeneas extraction failed; no output was accepted: ${run.error}\n`);
    return 1;
  }
  process.stderr.write(`FVS >> confined extraction written to ${run.output}\n`);
  return 0;
}

async function installCli(argv) {
  const flags = parseFlags(argv, ['manifest', 'manual'], ['project-root', 'consent', 'archive']);
  const result = resolveProbe({ projectRoot: flags['project-root'] });
  if (!result.install.available) {
    process.stderr.write(renderResolveText(result));
    if (result.status === 'verified') {
      process.stderr.write('FVS >> nothing to install: probe-aeneas is already verified for this project\n');
      return 0;
    }
    process.stderr.write(result.probe?.status === 'ok'
      ? 'FVS >> nothing to install: probe-aeneas is ready; set up the missing helpers manually (FVS never installs helpers)\n'
      : 'FVS >> nothing to install: FVS installs probe-aeneas only for a tested tuple on a supported platform\n');
    return 3;
  }
  const manifest = {
    ...result.install,
    platform: result.platform,
    tuple: result.tuple,
    provenance: result.provenance,
    helpersPreinstalled: Object.fromEntries(Object.entries(result.helpers).map(([name, helper]) => [name, helper.status])),
    choices: ['install', 'show-manual-instructions', 'cancel'],
  };
  if (flags.manual) {
    process.stdout.write(`${result.manual.map((step) => `- ${step}`).join('\n')}\n`);
    return 0;
  }
  if (flags.manifest || !flags.consent) {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    if (flags.manifest) return 0;
    process.stderr.write('FVS >> install requires --consent interactive (after the user chose Install) or --consent policy\n');
    return 3;
  }
  if (flags.consent === 'policy' && process.env.FVS_PROBE_INSTALL_POLICY !== 'install') {
    fatal('--consent policy requires FVS_PROBE_INSTALL_POLICY=install');
  }
  const installed = await installProbe({
    target: result.platform,
    archive: flags.archive ?? null,
    decision: flags.consent,
    provenance: { ...result.provenance, tuple: result.tuple },
  });
  process.stdout.write(`${JSON.stringify(installed, null, 2)}\n`);
  return 0;
}

const SUBCOMMANDS = { resolve: resolveCli, run: runCli, install: installCli };

async function main(argv) {
  try {
    if (Object.prototype.hasOwnProperty.call(SUBCOMMANDS, argv[0])) {
      process.exitCode = await SUBCOMMANDS[argv[0]](argv.slice(1));
    } else {
      projectCli(argv);
    }
  } catch (error) {
    process.stderr.write(`FVS_PROBE_INVENTORY_ERROR: ${error.message}\n`);
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

if (invokedDirectly()) await main(process.argv.slice(2));
