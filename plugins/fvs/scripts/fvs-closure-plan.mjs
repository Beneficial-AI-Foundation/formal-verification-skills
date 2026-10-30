#!/usr/bin/env node
'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Joins ticket 10's Rust identity record to ticket 21's Lean graph record of
// the same extraction and plans the union dependency closure of the requested
// roots. It only reads those records (and, optionally, the attempt's LLBC); it
// runs nothing. Three decisions stay separate: the raw upstream results are
// kept verbatim; cross-record admissibility (both bound, agreeing provenance and
// published files, a complete graph) gates any closure claim and is never
// salvaged by dropping nodes; scheduling eligibility is computed per node, and a
// requested root is ready only when its whole closure is. Recursive items are
// reported as recursion-unqualified: no recursion rule is qualified yet, and the
// LLBC recursion group is exposed for information only.

const EXIT = { ok: 0, usage: 2, internal: 2, 'invalid-input': 5, partial: 6, blocked: 7 };
const PROVENANCE = ['sourceCommit', 'leanProjectCommit', 'translationSha256', 'charonVersion', 'aeneasVersion', 'manifestSha256', 'llbcSha256', 'configSha256'];
const OWNERSHIP_RULE = 'each node is scheduled once; a node in several requested closures is owned by the lowest-numbered requested root (by def_id) that reaches it';

class Refusal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const refuse = (code, message) => { throw new Refusal(code, message); };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = (value) => Number.isInteger(value) && value >= 0;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const sortedNumbers = (values) => [...values].sort((a, b) => a - b);

function usage() {
  process.stdout.write([
    'Usage: node fvs-closure-plan.mjs plan --identity FILE --graph FILE --roots DEF_ID[,DEF_ID...]',
    '         [--failed DEF_ID[,DEF_ID...]] [--llbc FILE] [--out FILE] [--format json|text]',
    '',
    '--identity  the ticket 10 record (fvs-rust-identity record --out)',
    '--graph     the ticket 21 record (fvs-lean-graph output) of the same extraction',
    '--roots     the requested roots, by ticket 10 def_id',
    '--failed    nodes whose proof failed; every node depending on them is blocked',
    '--llbc      the attempt\'s LLBC (its sha256 must equal both records\' llbcSha256); its',
    '            recursion groups are exposed per node for information only',
    '',
    'Exit: 0 every requested root is ready; 6 some root is blocked (each is listed with its',
    'reasons); 7 the two records are not admissible together (no closure is claimed);',
    '5 invalid input; 2 usage.',
    '',
  ].join('\n'));
}

function validate({ identity, graph, roots, failed, llbc }) {
  const bad = (label, message) => refuse('invalid-input', `${label}: ${message}`);
  const i = identity.json;
  if (!isObject(i) || i.schema !== 'fvs-rust-identity/record' || i.version !== 1 || !isObject(i.provenance) || !isObject(i.binding)
    || !Array.isArray(i.items) || !Array.isArray(i.blockers) || typeof i.status !== 'string') {
    bad('identity', 'is not a fvs-rust-identity/record version 1');
  }
  for (const item of i.items) {
    if (!isObject(item) || !isId(item.defId) || typeof item.correspondence !== 'string' || !Array.isArray(item.reasons)
      || !Array.isArray(item.generated) || item.generated.some((g) => !isObject(g) || typeof g.leanName !== 'string')
      || !(item.target === null || typeof item.target === 'string')) {
      bad('identity', `item ${JSON.stringify(item?.defId)} is malformed`);
    }
  }
  if (new Set(i.items.map((item) => item.defId)).size !== i.items.length) bad('identity', 'def_ids are not unique');
  const g = graph.json;
  if (!isObject(g) || g.schema !== 'fvs/lean-graph' || g.schemaVersion !== 1 || typeof g.state !== 'string' || !isObject(g.provenance)
    || !isObject(g.binding) || !isObject(g.declarations) || !Array.isArray(g.edges) || !Array.isArray(g.blockers)) {
    bad('graph', 'is not a fvs/lean-graph schemaVersion 1 record');
  }
  for (const edge of g.edges) {
    if (!isObject(edge) || typeof edge.from !== 'string' || typeof edge.to !== 'string' || !['type', 'term'].includes(edge.kind)
      || !['local', 'external', 'unresolved'].includes(edge.resolution)) bad('graph', 'an edge is malformed');
  }
  if (roots.length === 0) bad('roots', 'name at least one def_id');
  if (llbc) {
    const decls = llbc.json?.translated?.ordered_decls;
    if (!Array.isArray(decls)) bad('llbc', 'has no translated.ordered_decls list');
  }
  return { i, g };
}

// Admissibility: the two records describe one bound extraction, and the graph is
// complete. Anything less blocks every closure claim.
function admissibility(i, g, llbc) {
  const blockers = [];
  const block = (code, message) => blockers.push({ code, message });
  if (i.binding.status !== 'bound') block('identity-unbound', 'the ticket 10 record is not bound to a recorded extraction attempt');
  if (g.binding.status !== 'bound') block('graph-unbound', 'the ticket 21 record is not bound to a recorded extraction attempt');
  if (!['complete', 'partial'].includes(i.status)) block('identity-blocked', `the ticket 10 record is ${i.status}`);
  if (g.state !== 'complete') block('graph-incomplete', `the ticket 21 record is ${g.state}; an incomplete graph cannot support a closure claim`);
  for (const field of PROVENANCE) {
    const [a, b] = [i.provenance[field], g.provenance[field]];
    if (a === null || a === undefined || b === null || b === undefined) block('provenance-missing', `${field} is missing from ${a == null && b == null ? 'both records' : a == null ? 'the ticket 10 record' : 'the ticket 21 record'}`);
    else if (a !== b) block('provenance-mismatch', `${field} differs: ticket 10 ${a}, ticket 21 ${b}`);
  }
  const published = (record) => (Array.isArray(record.binding.generatedLean)
    ? record.binding.generatedLean.map((entry) => `${entry?.projectPath}\u0000${entry?.sha256}`).sort() : null);
  const [pi, pg] = [published(i), published(g)];
  if (pi === null || pg === null || pi.length === 0) block('generated-lean-missing', 'a record carries no published Lean files');
  else if (JSON.stringify(pi) !== JSON.stringify(pg)) block('generated-lean-mismatch', 'the two records name different published Lean files or hashes');
  if (llbc && llbc.sha256 !== i.provenance.llbcSha256) block('llbc-mismatch', 'the given LLBC is not the attempt\'s LLBC');
  return blockers;
}

// LLBC recursion groups by def_id: { kind: 'NonRec' | 'Rec', members }.
function recursionGroups(llbc) {
  const groups = new Map();
  if (!llbc) return groups;
  for (const entry of llbc.json.translated.ordered_decls) {
    const fun = entry?.Fun;
    if (!isObject(fun)) continue;
    const members = Number.isInteger(fun.NonRec) ? [fun.NonRec] : Array.isArray(fun.Rec) ? fun.Rec : null;
    if (!members || members.some((id) => !isId(id))) refuse('invalid-input', 'llbc: an ordered_decls Fun entry is malformed');
    const group = { kind: Number.isInteger(fun.NonRec) ? 'NonRec' : 'Rec', members: sortedNumbers(members) };
    for (const id of members) {
      if (groups.has(id)) refuse('invalid-input', `llbc: def_id ${id} appears in two recursion groups`);
      groups.set(id, group);
    }
  }
  return groups;
}

export function buildPlan({ identity, graph, roots, failed = [], llbc = null }) {
  const { i, g } = validate({ identity, graph, roots, failed, llbc });
  const blockers = admissibility(i, g, llbc);
  const record = {
    schema: 'fvs-closure-plan/record',
    version: 1,
    status: 'blocked',
    inputs: { identitySha256: identity.sha256, graphSha256: graph.sha256, llbcSha256: llbc?.sha256 ?? null },
    provenance: Object.fromEntries(PROVENANCE.map((field) => [field, i.provenance[field] ?? null])),
    admissibility: { status: blockers.length === 0 ? 'admissible' : 'blocked', blockers },
    upstream: { identityStatus: i.status, identityBlockers: i.blockers, graphState: g.state, graphBlockers: g.blockers },
    ownership: { rule: OWNERSHIP_RULE },
    edgeOrientation: 'consumer -> dependency, as ticket 21 records it',
    nodes: {},
    roots: [],
  };
  if (blockers.length > 0) return record;

  // Nodes: one per ticket 10 item; its Lean family is every generated definition.
  const owner = new Map();
  const groups = recursionGroups(llbc);
  const nodes = new Map();
  for (const item of i.items) {
    const declarations = item.generated.map((member) => `probe:${member.leanName}`);
    const missing = declarations.filter((id) => !Object.hasOwn(g.declarations, id));
    const reasons = [];
    let eligibility = 'eligible';
    if (item.correspondence !== 'exact') {
      eligibility = item.reasons.includes('recursion') ? 'recursion-unqualified' : 'blocked-upstream';
    } else if (missing.length > 0) {
      eligibility = 'blocked-unmatched';
      reasons.push(...missing.map((id) => `${id} is not in the Lean graph`));
    }
    nodes.set(item.defId, {
      defId: item.defId,
      rustName: item.rustName ?? null,
      target: item.target,
      declarations,
      upstream: { correspondence: item.correspondence, reasons: item.reasons },
      recursionGroup: groups.get(item.defId) ?? null,
      eligibility,
      reasons,
      dependsOn: [],
      unmappedDependencies: [],
    });
    for (const id of declarations) owner.set(id, item.defId);
  }
  // Dependencies between nodes, from the graph's local edges; edges inside one
  // family are folded. A local dependency no node owns is kept visible.
  for (const edge of g.edges) {
    if (edge.resolution !== 'local' || !owner.has(edge.from)) continue;
    const from = nodes.get(owner.get(edge.from));
    if (!owner.has(edge.to)) {
      if (!from.unmappedDependencies.includes(edge.to)) from.unmappedDependencies.push(edge.to);
      continue;
    }
    const to = owner.get(edge.to);
    if (to !== from.defId && !from.dependsOn.includes(to)) from.dependsOn.push(to);
  }
  for (const node of nodes.values()) {
    node.dependsOn = sortedNumbers(node.dependsOn);
    node.unmappedDependencies.sort();
    if (node.unmappedDependencies.length > 0 && node.eligibility === 'eligible') {
      node.eligibility = 'blocked-unmapped-dependency';
      node.reasons.push(...node.unmappedDependencies.map((id) => `depends on ${id}, which no ticket 10 item owns`));
    }
  }
  // Cycles between nodes (strongly connected components of size > 1) are joint-plan blockers.
  const order = [];
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const visit = (id) => {
    index.set(id, order.length);
    low.set(id, order.length);
    order.push(id);
    stack.push(id);
    onStack.add(id);
    for (const next of nodes.get(id).dependsOn) {
      if (!index.has(next)) {
        visit(next);
        low.set(id, Math.min(low.get(id), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(id, Math.min(low.get(id), index.get(next)));
      }
    }
    if (low.get(id) === index.get(id)) {
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== id);
      if (component.length > 1) {
        for (const memberId of component) {
          const node = nodes.get(memberId);
          node.cycle = sortedNumbers(component);
          if (node.eligibility === 'eligible') node.eligibility = 'joint-plan-blocker';
          node.reasons.push(`in a dependency cycle with ${sortedNumbers(component).filter((other) => other !== memberId).join(', ')}`);
        }
      }
    }
  };
  for (const id of sortedNumbers(nodes.keys())) if (!index.has(id)) visit(id);

  const failedSet = new Set(failed);
  for (const id of failedSet) {
    if (!nodes.has(id)) refuse('invalid-input', `--failed names def_id ${id}, which is not a ticket 10 item`);
    nodes.get(id).eligibility = 'failed';
  }
  // Failure and non-eligibility propagate to every consumer.
  const closureOf = (root) => {
    const seen = new Set();
    const queue = [root];
    while (queue.length > 0) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(...nodes.get(id).dependsOn);
    }
    return sortedNumbers(seen);
  };
  for (const node of nodes.values()) {
    const below = closureOf(node.defId).filter((id) => id !== node.defId && nodes.get(id).eligibility !== 'eligible');
    if (below.length > 0 && node.eligibility === 'eligible') {
      node.eligibility = 'blocked-by-dependency';
      node.reasons.push(`depends on ${below.join(', ')}, which ${below.length === 1 ? 'is' : 'are'} not eligible`);
    }
  }

  const requested = sortedNumbers(new Set(roots));
  for (const root of requested) {
    if (!nodes.has(root)) {
      record.roots.push({ defId: root, status: 'blocked', closure: [], blockers: [{ code: 'unknown-root', message: `def_id ${root} is not a ticket 10 item` }] });
      continue;
    }
    const closure = closureOf(root);
    for (const id of closure) if (!owner.has(`root:${id}`)) owner.set(`root:${id}`, root);
    const blocking = closure.filter((id) => nodes.get(id).eligibility !== 'eligible');
    record.roots.push({
      defId: root,
      rustName: nodes.get(root).rustName,
      status: blocking.length === 0 ? 'ready' : 'blocked',
      closure,
      blockers: blocking.map((id) => ({ code: nodes.get(id).eligibility, node: id, reasons: [...nodes.get(id).upstream.reasons, ...nodes.get(id).reasons] })),
    });
  }
  for (const node of nodes.values()) {
    const sharedBy = record.roots.filter((root) => root.closure.includes(node.defId)).map((root) => root.defId);
    record.nodes[node.defId] = { ...node, sharedBy, ownerRoot: sharedBy.length > 0 ? owner.get(`root:${node.defId}`) : null };
  }
  record.status = record.roots.every((root) => root.status === 'ready') ? 'ready' : 'partial';
  return record;
}

function readInput(file, label) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    refuse('invalid-input', `${label} ${JSON.stringify(file)} is unreadable: ${error.code ?? error.message}`);
  }
  try {
    return { json: JSON.parse(bytes.toString('utf8')), sha256: sha256(bytes) };
  } catch (error) {
    return refuse('invalid-input', `${label} ${JSON.stringify(file)} is not valid JSON: ${error.message}`);
  }
}

function ids(value, flag) {
  const parts = value.split(',');
  if (parts.some((part) => !/^\d+$/.test(part))) refuse('usage', `${flag} takes def_ids separated by commas`);
  return parts.map(Number);
}

function parseFlags(argv) {
  const known = ['identity', 'graph', 'roots', 'failed', 'llbc', 'out', 'format'];
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
  for (const key of ['identity', 'graph', 'roots']) if (!flags[key]) refuse('usage', `--${key} is required`);
  if (flags.format && !['json', 'text'].includes(flags.format)) refuse('usage', '--format must be json or text');
  return flags;
}

function writeAtomic(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text, { flag: 'wx' });
  fs.renameSync(tmp, file);
}

function main(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }
  let format = 'json';
  let result;
  try {
    if (argv[0] !== 'plan') refuse('usage', `unknown command ${JSON.stringify(argv[0])}`);
    const flags = parseFlags(argv.slice(1));
    format = flags.format ?? 'json';
    const record = buildPlan({
      identity: readInput(flags.identity, 'identity'),
      graph: readInput(flags.graph, 'graph'),
      roots: ids(flags.roots, '--roots'),
      failed: flags.failed ? ids(flags.failed, '--failed') : [],
      llbc: flags.llbc ? readInput(flags.llbc, 'llbc') : null,
    });
    if (flags.out) writeAtomic(flags.out, `${JSON.stringify(record, null, 2)}\n`);
    const code = record.status === 'ready' ? 'ok' : record.status;
    const message = record.status === 'blocked'
      ? `not admissible: ${record.admissibility.blockers.map((b) => b.code).join(', ')}`
      : record.roots.map((root) => `${root.defId} ${root.status}`).join(', ');
    result = { ok: code === 'ok', command: 'plan', code, message, record };
  } catch (error) {
    result = error instanceof Refusal
      ? { ok: false, code: error.code, command: argv[0], message: error.message }
      : { ok: false, code: 'internal', command: argv[0], message: error.message };
  }
  if (format === 'text') {
    const lines = [`FVS >> ${result.code}: ${result.message}`];
    for (const root of result.record?.roots ?? []) {
      lines.push(`  root ${root.defId} ${root.status}: closure ${root.closure.join(', ') || '-'}${root.blockers.length ? `; blocked by ${root.blockers.map((b) => `${b.node ?? ''} ${b.code}`.trim()).join(', ')}` : ''}`);
    }
    process.stdout.write(`${lines.join('\n')}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  if (!['ok', 'partial', 'blocked'].includes(result.code)) process.stderr.write(`FVS >> ${result.code}: ${result.message}\n`);
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
