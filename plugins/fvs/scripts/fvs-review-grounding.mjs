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

export function prepareGrounding({ root, directory, requestPath, sourceFiles = [] }) {
  root = fs.realpathSync(root);
  directory = fs.realpathSync(directory);
  if (!directory.startsWith(root + path.sep)) throw new Error('Grounding output must remain inside the project');
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
  let linesUsed = 0;
  const snippet = ref => {
    if (!ref || !Number.isInteger(ref.start) || !Number.isInteger(ref.end) ||
        ref.start < 1 || ref.end < ref.start || ref.end - ref.start >= 40) {
      throw new Error('Grounding citations need start/end lines (at most 40 per signature)');
    }
    const { path: file, content } = read(ref.path);
    const lines = content.split(/\r?\n/);
    if (ref.end > lines.length) throw new Error(`Grounding citation exceeds file: ${ref.path}`);
    linesUsed += ref.end - ref.start + 1;
    if (linesUsed > 200) throw new Error('Grounding exceeds 200 signature lines; narrow the review scope');
    return { path: file, start: ref.start, end: ref.end,
      signature: lines.slice(ref.start - 1, ref.end).join('\n') };
  };
  const names = new Set();
  const declarations = (request?.declarations ?? []).map(decl => {
    if (!nonempty(decl.name) || names.has(decl.name) || !nonempty(decl.signature) ||
        decl.signature.length > 4000 || !Array.isArray(decl.analogs) || decl.analogs.length > 5 ||
        !Array.isArray(decl.search?.queries) || !decl.search.queries.length ||
        !decl.search.queries.every(nonempty) || !Array.isArray(decl.search?.roots) ||
        !decl.search.roots.length || !decl.search.roots.every(nonempty) ||
        !nonempty(decl.search.conclusion)) {
      throw new Error('Each grounding declaration needs a unique name, signature, up to five analogs and explicit search evidence');
    }
    names.add(decl.name);
    const analogs = decl.analogs.map(ref => {
      if (!['REUSE-AS-IS', 'EXTEND', 'ADAPTER', 'JUSTIFY-FORK'].includes(ref.handling)) {
        throw new Error('Grounding analog has an invalid handling suggestion');
      }
      return { ...snippet(ref), handling: ref.handling };
    });
    return { name: decl.name, signature: decl.signature, analogs,
      search: decl.search, result: analogs.length ? 'analogs-found' : 'no-analog-found-in-reported-search' };
  });
  const citedApis = (request?.cited_apis ?? []).map(snippet);
  const sourceIndex = sourceFiles.map(file => {
    const evidence = read(file);
    return inputs.get(evidence.path);
  });
  const content = JSON.stringify({ version: 1,
    provenance: 'Scout selections and search claims are untrusted; source snippets and hashes are verified by the wrapper.',
    status: request ? 'supplied' : 'missing-scout-inventory',
    limitations: request?.limitations ?? 'Inventory completeness requires reviewer judgment; no semantic absence is certified.',
    declarations, cited_apis: citedApis, source_index: sourceIndex }, null, 2) + '\n';
  if (content.length > 64000) throw new Error('Grounding artifact exceeds 64 KiB; narrow the review scope');
  const file = path.join(directory, 'grounding.json');
  fs.writeFileSync(file, content, { flag: 'wx' });
  return { path: path.relative(root, file).split(path.sep).join('/'), sha256: hash(content),
    inputs: [...inputs.values()], content };
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
