#!/usr/bin/env node
'use strict';

/**
 * Discover a target repository's style guide and mechanically check the two
 * recurring Lean output failures tracked by FVS:
 *
 *   1. lines longer than the repository limit (100 columns by default);
 *   2. identifiers with three or more namespace dots in ordinary Lean code.
 *
 * This checker deliberately does not pretend to interpret every prose rule in a
 * style guide. The parent workflow reads and inlines the complete guide as a hard
 * agent constraint; this script supplies the deterministic post-write gate.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_MAX_LINE_LENGTH = 100;
const DEFAULT_MAX_QUALIFIED_DOTS = 2;
const SEARCH_DEPTH = 3;
const SKIP_DIRS = new Set(['.git', '.lake', 'node_modules']);
const EXACT_CANDIDATES = [
  'doc/STYLE_GUIDE',
  'doc/STYLE_GUIDE.md',
  'doc/STYLE_GUIDE.txt',
  'docs/STYLE_GUIDE',
  'docs/STYLE_GUIDE.md',
  'docs/STYLE_GUIDE.txt',
  'STYLE_GUIDE',
  'STYLE_GUIDE.md',
  'STYLE_GUIDE.txt',
  'doc/STYLE',
  'doc/STYLE.md',
  'docs/STYLE',
  'docs/STYLE.md',
  'STYLE.md',
];

function usage() {
  process.stdout.write(
    [
      'FVS Lean style checker',
      '',
      'Usage:',
      '  node fvs-lean-style-check.mjs discover [--root DIR] [--config FILE]',
      '  node fvs-lean-style-check.mjs check FILE [--root DIR] [--config FILE]',
      '       [--style-guide FILE] [--baseline FILE]',
      '       [--max-line-length N] [--max-qualified-dots N]',
      '',
      'discover prints one JSON object. check exits 0 when the file introduces no',
      'violations and exits 1 with file:line:column diagnostics otherwise.',
    ].join('\n') + '\n',
  );
}

function fatal(message, code = 2) {
  process.stderr.write(`FVS_STYLE_ERROR: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = {
    command: null,
    file: null,
    root: '.',
    config: '.formalising/fvs-config.json',
    styleGuide: null,
    baseline: null,
    maxLineLength: null,
    maxQualifiedDots: null,
    help: false,
  };
  const rest = [...argv];
  args.command = rest.shift() ?? null;
  if (args.command === '--help' || args.command === '-h') {
    args.help = true;
    return args;
  }
  if (args.command === 'check' && rest[0] && !rest[0].startsWith('--')) {
    args.file = rest.shift();
  }
  while (rest.length > 0) {
    const flag = rest.shift();
    if (flag === '--help' || flag === '-h') {
      args.help = true;
    } else if (flag === '--root') {
      args.root = rest.shift() ?? fatal('--root requires a value');
    } else if (flag === '--config') {
      args.config = rest.shift() ?? fatal('--config requires a value');
    } else if (flag === '--style-guide') {
      args.styleGuide = rest.shift() ?? fatal('--style-guide requires a value');
    } else if (flag === '--baseline') {
      args.baseline = rest.shift() ?? fatal('--baseline requires a value');
    } else if (flag === '--max-line-length') {
      args.maxLineLength = rest.shift() ?? fatal('--max-line-length requires a value');
    } else if (flag === '--max-qualified-dots') {
      args.maxQualifiedDots = rest.shift() ?? fatal('--max-qualified-dots requires a value');
    } else {
      fatal(`unknown argument "${flag}"`);
    }
  }
  return args;
}

function rootInfo(rawRoot) {
  const resolved = path.resolve(rawRoot);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    stat = null;
  }
  if (!stat?.isDirectory()) fatal(`root is not a directory: ${resolved}`);
  return { lexical: resolved, real: fs.realpathSync(resolved) };
}

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function resolveRootFile(root, rawPath, label, { required = true } = {}) {
  const lexical = path.resolve(root.lexical, rawPath);
  if (!isWithin(root.lexical, lexical)) {
    fatal(`${label} resolves outside the project root: ${rawPath}`);
  }
  if (!fs.existsSync(lexical)) {
    if (required) fatal(`${label} does not exist: ${rawPath}`);
    return null;
  }
  const stat = fs.statSync(lexical);
  if (!stat.isFile()) fatal(`${label} is not a file: ${rawPath}`);
  const real = fs.realpathSync(lexical);
  if (!isWithin(root.real, real)) {
    fatal(`${label} escapes the project root through a symlink: ${rawPath}`);
  }
  return { lexical, real };
}

function relativeToRoot(root, file) {
  return path.relative(root.lexical, file).split(path.sep).join('/');
}

function readConfigStylePath(root, configPath) {
  const resolved = resolveRootFile(root, configPath, 'config', { required: false });
  if (!resolved) return null;
  let config;
  try {
    config = JSON.parse(fs.readFileSync(resolved.lexical, 'utf8'));
  } catch (error) {
    fatal(`cannot parse ${relativeToRoot(root, resolved.lexical)}: ${error.message}`);
  }
  const configured = config?.project?.style_guide_path;
  if (configured === null || configured === undefined || configured === '') return null;
  if (typeof configured !== 'string') {
    fatal('project.style_guide_path must be a string or null');
  }
  return configured;
}

function looksLikeStyleGuide(name) {
  return /^(?:lean[-_ ]?)?style(?:[-_ ]?guide)?(?:\.(?:md|txt|rst))?$/i.test(name);
}

function walkForStyleGuides(root, dir, depth, results) {
  if (depth > SEARCH_DEPTH) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        walkForStyleGuides(root, path.join(dir, entry.name), depth + 1, results);
      }
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (!looksLikeStyleGuide(entry.name)) continue;
    const candidate = path.join(dir, entry.name);
    try {
      const resolved = resolveRootFile(
        root,
        relativeToRoot(root, candidate),
        'style guide',
      );
      results.add(resolved.lexical);
    } catch {
      // resolveRootFile already reports hard safety failures. This catch is only
      // defensive for a file that disappears during discovery.
    }
  }
}

function parseLineLimit(content) {
  for (const line of content.split(/\r?\n/)) {
    if (!/\b(?:line|lines|wrap|wrapped|column|columns|characters?|chars?)\b/i.test(line)) {
      continue;
    }
    const patterns = [
      /\bline(?:s)?(?:\s+of\s+code)?\s*(?:length|width|limit)?\s*(?:is|of|:|=|<=|≤|under|max(?:imum)?(?:\s+of)?)?\s*(\d{2,3})\b/i,
      /\b(\d{2,3})[-\s]*(?:columns?|characters?|chars?)\b/i,
    ];
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (!match) continue;
      const value = Number(match[1]);
      if (Number.isInteger(value) && value >= 40 && value <= 240) return value;
    }
  }
  return DEFAULT_MAX_LINE_LENGTH;
}

function discoverStyle(root, args) {
  if (args.styleGuide) {
    const file = resolveRootFile(root, args.styleGuide, 'style guide');
    const content = fs.readFileSync(file.lexical, 'utf8');
    return {
      status: 'found',
      path: relativeToRoot(root, file.lexical),
      source: '--style-guide',
      maxLineLength: parseLineLimit(content),
      maxQualifiedDots: DEFAULT_MAX_QUALIFIED_DOTS,
    };
  }

  const configured = readConfigStylePath(root, args.config);
  if (configured) {
    const file = resolveRootFile(root, configured, 'configured style guide');
    const content = fs.readFileSync(file.lexical, 'utf8');
    return {
      status: 'found',
      path: relativeToRoot(root, file.lexical),
      source: 'project.style_guide_path',
      maxLineLength: parseLineLimit(content),
      maxQualifiedDots: DEFAULT_MAX_QUALIFIED_DOTS,
    };
  }

  const candidates = new Set();
  for (const candidate of EXACT_CANDIDATES) {
    const file = resolveRootFile(root, candidate, 'style guide', { required: false });
    if (file) candidates.add(file.lexical);
  }
  walkForStyleGuides(root, root.lexical, 0, candidates);
  const sorted = [...candidates].sort((a, b) =>
    relativeToRoot(root, a).localeCompare(relativeToRoot(root, b))
  );
  if (sorted.length > 1) {
    fatal(
      'multiple style guides found; set project.style_guide_path explicitly: ' +
        sorted.map(file => relativeToRoot(root, file)).join(', '),
    );
  }
  if (sorted.length === 1) {
    const content = fs.readFileSync(sorted[0], 'utf8');
    return {
      status: 'found',
      path: relativeToRoot(root, sorted[0]),
      source: 'auto-discovery',
      maxLineLength: parseLineLimit(content),
      maxQualifiedDots: DEFAULT_MAX_QUALIFIED_DOTS,
    };
  }
  return {
    status: 'fallback',
    path: null,
    source: 'FVS defaults (no target style guide found)',
    maxLineLength: DEFAULT_MAX_LINE_LENGTH,
    maxQualifiedDots: DEFAULT_MAX_QUALIFIED_DOTS,
  };
}

function positiveInteger(raw, label, fallback) {
  if (raw === null || raw === undefined) return fallback;
  if (!/^[0-9]+$/.test(String(raw))) fatal(`${label} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) fatal(`${label} must be a positive integer`);
  return value;
}

function maskCommentsAndStrings(source) {
  let output = '';
  let blockDepth = 0;
  let inString = false;
  let escaped = false;
  let lineComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1] ?? '';
    if (char === '\n') {
      output += '\n';
      lineComment = false;
      if (inString && !escaped) inString = false;
      escaped = false;
      continue;
    }
    if (lineComment) {
      output += ' ';
      continue;
    }
    if (blockDepth > 0) {
      if (char === '/' && next === '-') {
        output += '  ';
        blockDepth += 1;
        index += 1;
      } else if (char === '-' && next === '/') {
        output += '  ';
        blockDepth -= 1;
        index += 1;
      } else {
        output += ' ';
      }
      continue;
    }
    if (inString) {
      output += ' ';
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '-' && next === '-') {
      output += '  ';
      lineComment = true;
      index += 1;
    } else if (char === '/' && next === '-') {
      output += '  ';
      blockDepth = 1;
      index += 1;
    } else if (char === '"') {
      output += ' ';
      inString = true;
    } else {
      output += char;
    }
  }
  return output;
}

function lintSource(source, limits) {
  const originalLines = source.split(/\r?\n/);
  const codeLines = maskCommentsAndStrings(source).split(/\r?\n/);
  const violations = [];
  const identifierStart = String.raw`[\p{L}_]`;
  const identifierRest = String.raw`[\p{L}\p{N}_']*`;
  const boundary = String.raw`[^\p{L}\p{N}_']`;
  const qualified = new RegExp(
    `(^|${boundary})((?:${identifierStart}${identifierRest}\\.){` +
      `${limits.maxQualifiedDots + 1},}${identifierStart}${identifierRest})`,
    'gu',
  );

  for (let index = 0; index < originalLines.length; index += 1) {
    const original = originalLines[index].replace(/\r$/, '');
    const code = codeLines[index] ?? '';
    const length = [...original].length;
    if (length > limits.maxLineLength) {
      violations.push({
        rule: 'FVS-LINE-LENGTH',
        line: index + 1,
        column: limits.maxLineLength + 1,
        message: `line has ${length} columns; maximum is ${limits.maxLineLength}`,
        fingerprint: `FVS-LINE-LENGTH\0${original.trim()}`,
      });
    }

    if (/^\s*(?:import|prelude|namespace|open|export|end)\b/.test(code)) continue;
    qualified.lastIndex = 0;
    let match;
    while ((match = qualified.exec(code)) !== null) {
      const identifier = match[2];
      const identifierAt = match.index + match[1].length;
      const dots = (identifier.match(/\./g) ?? []).length;
      const column = [...code.slice(0, identifierAt)].length + 1;
      violations.push({
        rule: 'FVS-DEEP-QUALIFICATION',
        line: index + 1,
        column,
        message:
          `"${identifier}" uses ${dots} namespace dots; maximum is ` +
          `${limits.maxQualifiedDots} (prefer open/namespace/local names)`,
        fingerprint: `FVS-DEEP-QUALIFICATION\0${identifier}`,
      });
    }
  }
  return violations;
}

function subtractBaseline(current, baseline) {
  const allowance = new Map();
  for (const violation of baseline) {
    allowance.set(violation.fingerprint, (allowance.get(violation.fingerprint) ?? 0) + 1);
  }
  return current.filter(violation => {
    const remaining = allowance.get(violation.fingerprint) ?? 0;
    if (remaining === 0) return true;
    allowance.set(violation.fingerprint, remaining - 1);
    return false;
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (!['discover', 'check'].includes(args.command)) {
    usage();
    fatal('expected discover or check');
  }

  const root = rootInfo(args.root);
  const style = discoverStyle(root, args);
  const limits = {
    maxLineLength: positiveInteger(
      args.maxLineLength,
      '--max-line-length',
      style.maxLineLength,
    ),
    maxQualifiedDots: positiveInteger(
      args.maxQualifiedDots,
      '--max-qualified-dots',
      style.maxQualifiedDots,
    ),
  };

  if (args.command === 'discover') {
    process.stdout.write(`${JSON.stringify({ ...style, ...limits })}\n`);
    return;
  }
  if (!args.file) fatal('check requires a Lean file');
  const target = resolveRootFile(root, args.file, 'Lean target');
  if (path.extname(target.lexical).toLowerCase() !== '.lean') {
    fatal(`Lean target must end in .lean: ${args.file}`);
  }

  const current = lintSource(fs.readFileSync(target.lexical, 'utf8'), limits);
  let report = current;
  let baselineCount = 0;
  if (args.baseline) {
    const baseline = path.resolve(args.baseline);
    if (!fs.existsSync(baseline) || !fs.statSync(baseline).isFile()) {
      fatal(`baseline does not exist or is not a file: ${args.baseline}`);
    }
    const baselineViolations = lintSource(fs.readFileSync(baseline, 'utf8'), limits);
    baselineCount = baselineViolations.length;
    report = subtractBaseline(current, baselineViolations);
  }

  const relative = relativeToRoot(root, target.lexical);
  if (report.length === 0) {
    const guide = style.path ?? style.source;
    const baselineNote = args.baseline
      ? `; no new violations (${baselineCount} baseline violation(s) preserved)`
      : '';
    process.stdout.write(
      `FVS_STYLE_OK: ${relative} (guide: ${guide}; line <= ` +
        `${limits.maxLineLength}; qualified dots <= ${limits.maxQualifiedDots}${baselineNote})\n`,
    );
    return;
  }

  for (const violation of report) {
    process.stderr.write(
      `${relative}:${violation.line}:${violation.column}: ${violation.rule}: ` +
        `${violation.message}\n`,
    );
  }
  process.stderr.write(
    `FVS_STYLE_FAIL: ${report.length} new violation(s); style source: ` +
      `${style.path ?? style.source}\n`,
  );
  process.exitCode = 1;
}

main();
