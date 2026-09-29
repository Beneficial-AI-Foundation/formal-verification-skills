// Resolve a bounded scout inventory into verbatim, hash-bound source evidence.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const hash = text => createHash('sha256').update(text).digest('hex');
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

function projectFile(root, file) {
  if (!nonempty(file) || /[\r\n\0]/.test(file)) throw new Error('Invalid grounding file path');
  const absolute = fs.realpathSync(path.resolve(root, file));
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  if (relative.startsWith('../') || path.isAbsolute(relative) ||
      /(^|\/)proof-engineering(\/|$)|(^|\/)proof-engineering-context\.md$/.test(relative)) {
    throw new Error(`Grounding source outside allowed project evidence: ${file}`);
  }
  if (!fs.statSync(absolute).isFile() || fs.statSync(absolute).size > 2 * 1024 * 1024) {
    throw new Error(`Grounding source must be a file of at most 2 MiB: ${file}`);
  }
  return { absolute, relative };
}

const LINE_LIMIT = 200;

// Resolve and account for an inventory without writing anything. Every analog and
// cited API occurrence is charged, even when it repeats a span selected elsewhere,
// because the reviewer receives each occurrence verbatim.
export function analyzeGrounding({ root, requestPath, sourceFiles = [] }) {
  root = fs.realpathSync(root);
  const inputs = new Map();
  const read = file => {
    const { absolute, relative } = projectFile(root, file);
    const content = fs.readFileSync(absolute, 'utf8');
    inputs.set(relative, { path: relative, sha256: hash(content) });
    return { path: relative, content };
  };
  const request = requestPath ? JSON.parse(read(requestPath).content) : null;
  if (requestPath && (!request || request.version !== 1 || !Array.isArray(request.declarations) ||
      !Array.isArray(request.cited_apis) || request.declarations.length > 30 || request.cited_apis.length > 60)) {
    throw new Error('Grounding requires version 1, at most 30 declarations and 60 cited_apis');
  }
  const budget = { limit: LINE_LIMIT, charged: 0, analogs: 0, citedApis: 0,
    distinctSpans: 0, distinctLines: 0, overflow: null };
  const distinct = new Set();
  // After the first overflow later spans are still validated and charged so the
  // totals are complete, but their text is not retained.
  const snippet = (ref, location, category) => {
    if (!ref || !Number.isInteger(ref.start) || !Number.isInteger(ref.end) ||
        ref.start < 1 || ref.end < ref.start || ref.end - ref.start >= 40) {
      throw new Error('Grounding citations need start/end lines (at most 40 per signature)');
    }
    const { path: file, content } = read(ref.path);
    const lines = content.split(/\r?\n/);
    if (ref.end > lines.length) throw new Error(`Grounding citation exceeds file: ${ref.path}`);
    const size = ref.end - ref.start + 1;
    const span = `${file}:${ref.start}-${ref.end}`;
    budget.charged += size;
    budget[category] += size;
    if (!distinct.has(span)) {
      distinct.add(span);
      budget.distinctLines += size;
    }
    if (!budget.overflow && budget.charged > LINE_LIMIT) {
      budget.overflow = { location, span, cumulative: budget.charged };
    }
    return budget.overflow ? null : { path: file, start: ref.start, end: ref.end,
      signature: lines.slice(ref.start - 1, ref.end).join('\n') };
  };
  const names = new Set();
  const declarations = (request?.declarations ?? []).map((decl, index) => {
    if (!nonempty(decl.name) || names.has(decl.name) || !nonempty(decl.signature) ||
        decl.signature.length > 4000 || !Array.isArray(decl.analogs) || decl.analogs.length > 5 ||
        !Array.isArray(decl.search?.queries) || !decl.search.queries.length ||
        !decl.search.queries.every(nonempty) || !Array.isArray(decl.search?.roots) ||
        !decl.search.roots.length || !decl.search.roots.every(nonempty) ||
        !nonempty(decl.search.conclusion)) {
      throw new Error('Each grounding declaration needs a unique name, signature, up to five analogs and explicit search evidence');
    }
    names.add(decl.name);
    const analogs = decl.analogs.map((ref, analog) => {
      if (!['REUSE-AS-IS', 'EXTEND', 'ADAPTER', 'JUSTIFY-FORK'].includes(ref.handling)) {
        throw new Error('Grounding analog has an invalid handling suggestion');
      }
      const evidence = snippet(ref,
        `declarations[${index}] ${JSON.stringify(decl.name)} analogs[${analog}]`, 'analogs');
      return evidence && { ...evidence, handling: ref.handling };
    });
    return { name: decl.name, signature: decl.signature, analogs,
      search: decl.search, result: analogs.length ? 'analogs-found' : 'no-analog-found-in-reported-search' };
  });
  const citedApis = (request?.cited_apis ?? []).map((ref, index) =>
    snippet(ref, `cited_apis[${index}]`, 'citedApis'));
  const sourceIndex = sourceFiles.map(file => {
    const evidence = read(file);
    return inputs.get(evidence.path);
  });
  budget.distinctSpans = distinct.size;
  const report = request
    ? `charged ${budget.charged}/${LINE_LIMIT} signature lines (analogs ${budget.analogs}, ` +
      `cited_apis ${budget.citedApis}); ${budget.distinctSpans} distinct ` +
      `span${budget.distinctSpans === 1 ? '' : 's'} (${budget.distinctLines} lines) ` +
      'informational only: every occurrence is charged, including repeats'
    : `no scout inventory supplied (status missing-scout-inventory; charged 0/${LINE_LIMIT})`;
  const result = { error: null, report, budget, content: null, inputs: [...inputs.values()] };
  if (budget.overflow) {
    const { location, span, cumulative } = budget.overflow;
    result.error = `Grounding exceeds ${LINE_LIMIT} signature lines: ${report}; first overflow at ` +
      `${location} ${span} (cumulative ${cumulative}); narrow the review scope`;
    return result;
  }
  const content = JSON.stringify({ version: 1,
    provenance: 'Scout selections and search claims are untrusted; source snippets and hashes are verified by the wrapper.',
    status: request ? 'supplied' : 'missing-scout-inventory',
    limitations: request?.limitations ?? 'Inventory completeness requires reviewer judgment; no semantic absence is certified.',
    declarations, cited_apis: citedApis, source_index: sourceIndex }, null, 2) + '\n';
  if (content.length > 64000) {
    result.error = `Grounding artifact exceeds 64 KiB (${content.length} JavaScript code units > 64000); ${report}; narrow the review scope`;
  } else {
    result.content = content;
  }
  return result;
}

export function prepareGrounding({ root, directory, requestPath, sourceFiles = [] }) {
  root = fs.realpathSync(root);
  directory = fs.realpathSync(directory);
  if (!directory.startsWith(root + path.sep)) throw new Error('Grounding output must remain inside the project');
  const { error, content, inputs } = analyzeGrounding({ root, requestPath, sourceFiles });
  if (error) throw new Error(error);
  const file = path.join(directory, 'grounding.json');
  fs.writeFileSync(file, content, { flag: 'wx' });
  return { path: path.relative(root, file).split(path.sep).join('/'), sha256: hash(content),
    inputs, content };
}

export function validateGrounding(root, record, directory) {
  if (!record || !Array.isArray(record.inputs)) throw new Error('Missing hash-bound grounding record; prepare a new packet');
  if (path.resolve(root, record.path ?? '') !== path.join(directory, 'grounding.json')) {
    throw new Error('Grounding artifact must belong to this packet directory');
  }
  for (const input of [record, ...record.inputs]) {
    const { absolute, relative } = projectFile(root, input.path);
    if (relative !== input.path || hash(fs.readFileSync(absolute, 'utf8')) !== input.sha256) {
      throw new Error(`Stale grounding evidence: ${input.path}; prepare a new review`);
    }
  }
}
