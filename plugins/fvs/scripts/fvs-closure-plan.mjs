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
// kept verbatim; cross-record admissibility (valid, consistent, bound records
// with agreeing provenance and published files, and a complete graph with
// verified dependency fidelity and no open obligations) gates any closure claim and is never salvaged by dropping nodes; scheduling eligibility
// is computed per node, and a requested root is ready only when its whole
// closure is. Recursive items are reported as recursion-unqualified: no
// recursion rule is qualified yet, and the LLBC recursion group is exposed for
// information only. A ticket 21 record of schema version 2 (oracle lanes) is
// planned from its nodes lanes: generated nodes are passed through as
// dependency evidence and are never given a def_id, an owner or a task.

const EXIT = { ok: 0, usage: 2, internal: 2, 'invalid-input': 5, partial: 6, blocked: 7 };
const COMMIT_FIELDS = ['sourceCommit', 'leanProjectCommit'];
const DIGEST_FIELDS = ['translationSha256', 'manifestSha256', 'llbcSha256', 'configSha256'];
const VERSION_FIELDS = ['charonVersion', 'aeneasVersion'];
const PROVENANCE = [...COMMIT_FIELDS, 'translationSha256', ...VERSION_FIELDS, 'manifestSha256', 'llbcSha256', 'configSha256'];
// Ticket 21 schema version 2 (capability oracle-lanes): every project constant
// is a node with authoritative type and value lanes; generated nodes (no probe
// atom) are dependency evidence only. Kernel kinds as the producer names them.
const ORACLE_CAPABILITY = 'oracle-lanes';
const NODE_KINDS = ['def', 'theorem', 'opaque', 'axiom', 'inductive', 'ctor', 'recursor', 'quot'];
const THEOREM_KINDS = ['theorem'];
const DEFINITION_CLOSURE_RULE = 'from the root item\'s generated family over the nodes lanes: a theorem node follows its type lane only; any other node follows its type and value lanes';
const OWNERSHIP_RULE = 'each node is scheduled once; a node in several requested closures is owned by the lowest-numbered requested root (by def_id) that reaches it; ownership is bookkeeping, not readiness';

class Refusal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const refuse = (code, message) => { throw new Refusal(code, message); };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = (value) => Number.isInteger(value) && value >= 0;
const isSha = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const isCommit = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
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
    'reasons); 7 the two records are not admissible together (the requested roots are listed',
    'as blocked, no closure is claimed); 5 invalid input; 2 usage.',
    '',
  ].join('\n'));
}

const wrapperValid = (value) => isObject(value) && 'json' in value && isSha(value.sha256);

// The shape of every input the planner consumes, including the exported
// function's wrappers and selections. Anything else is refused.
function validate({ identity, graph, roots, failed, llbc }) {
  const bad = (label, message) => refuse('invalid-input', `${label}: ${message}`);
  for (const [label, value] of [['identity', identity], ['graph', graph]]) {
    if (!wrapperValid(value)) bad(label, 'is required as { json, sha256 } with the sha256 of its bytes');
  }
  if (llbc !== null && llbc !== undefined && !wrapperValid(llbc)) bad('llbc', 'must be { json, sha256 } or null');
  for (const [label, list, nonEmpty] of [['roots', roots, true], ['failed', failed, false]]) {
    if (!Array.isArray(list) || list.some((id) => !isId(id)) || new Set(list).size !== list.length || (nonEmpty && list.length === 0)) {
      bad(label, `must be ${nonEmpty ? 'a non-empty' : 'an'} array of distinct non-negative integer def_ids`);
    }
  }
  const i = identity.json;
  if (!isObject(i) || i.schema !== 'fvs-rust-identity/record' || i.version !== 1 || !isObject(i.provenance) || !isObject(i.binding)
    || !Array.isArray(i.items) || !Array.isArray(i.blockers) || !['complete', 'partial', 'blocked', 'unbound'].includes(i.status)
    || !['bound', 'unbound'].includes(i.binding.status) || !Array.isArray(i.binding.reasons ?? [])) {
    bad('identity', 'is not a fvs-rust-identity/record version 1');
  }
  for (const item of i.items) {
    if (!isObject(item) || !isId(item.defId) || !isText(item.correspondence) || !Array.isArray(item.reasons) || item.reasons.some((r) => !isText(r))
      || !Array.isArray(item.generated) || item.generated.some((g) => !isObject(g) || !isText(g.leanName))
      || !(item.target === null || isText(item.target))) {
      bad('identity', `item ${JSON.stringify(item?.defId)} is malformed`);
    }
  }
  if (new Set(i.items.map((item) => item.defId)).size !== i.items.length) bad('identity', 'def_ids are not unique');
  const g = graph.json;
  if (!isObject(g) || g.schema !== 'fvs/lean-graph'
    || !((g.schemaVersion === 1 && g.capability === undefined) || (g.schemaVersion === 2 && g.capability === ORACLE_CAPABILITY))
    || !['complete', 'incomplete', 'unsupported'].includes(g.state)
    || !isObject(g.provenance) || !isObject(g.binding) || !['bound', 'unbound'].includes(g.binding.status) || !Array.isArray(g.binding.reasons ?? [])
    || !isObject(g.declarations) || !Array.isArray(g.edges) || !Array.isArray(g.blockers)) {
    bad('graph', 'is not a fvs/lean-graph record of schemaVersion 1, or of schemaVersion 2 with capability oracle-lanes');
  }
  const oracle = g.schemaVersion === 2;
  if (oracle) {
    if (!isObject(g.nodes)) bad('graph', 'a schemaVersion 2 record needs a nodes object');
    for (const [id, node] of Object.entries(g.nodes)) {
      if (!isObject(node) || !NODE_KINDS.includes(node.kind) || typeof node.source !== 'boolean' || typeof node.probeAtom !== 'boolean'
        || ['type', 'value'].some((lane) => !Array.isArray(node[lane]) || node[lane].some((to) => !isText(to)) || new Set(node[lane]).size !== node[lane].length)) {
        bad('graph', `node ${JSON.stringify(id)} is malformed (kind, source, probeAtom, or a type or value lane)`);
      }
    }
    if (g.trust !== undefined && !isObject(g.trust)) bad('graph', 'trust is malformed');
  }
  const resolutions = oracle ? ['local', 'generated', 'external'] : ['local', 'external', 'unresolved'];
  for (const edge of g.edges) {
    if (!isObject(edge) || !isText(edge.from) || !isText(edge.to) || !['type', 'term'].includes(edge.kind)
      || !resolutions.includes(edge.resolution)) bad('graph', 'an edge is malformed');
  }
  if (g.fidelity !== undefined && !(isObject(g.fidelity) && isText(g.fidelity.status))) bad('graph', 'fidelity is malformed');
  if (llbc && !Array.isArray(llbc.json?.translated?.ordered_decls)) bad('llbc', 'has no translated.ordered_decls list');
  return { i, g };
}

// The graph's declared dependency lists, the single representation the planner
// uses. A missing external list counts as empty (the producer qualifies omitted
// external lists); a missing local list is malformed.
function declaredEdges(g) {
  const edges = [];
  for (const [from, atom] of Object.entries(g.declarations)) {
    if (!isObject(atom)) return null;
    for (const kind of ['type', 'term']) {
      const local = atom[`${kind}-dependencies`];
      const external = atom[`${kind}-dependencies-external`] ?? [];
      if (!Array.isArray(local) || !Array.isArray(external) || [...local, ...external].some((to) => !isText(to))) return null;
      for (const to of local) edges.push({ from, to, kind, resolution: Object.hasOwn(g.declarations, to) ? 'local' : 'unresolved' });
      for (const to of external) edges.push({ from, to, kind, resolution: 'external' });
    }
  }
  return edges;
}

// Schema version 2: the edges the nodes lanes imply, one per lane entry. A
// target is local when it is a probe-atom node, generated when it is a node
// without a probe atom, and external when it is not a node.
function laneEdges(g) {
  const edges = [];
  for (const [from, node] of Object.entries(g.nodes)) {
    for (const [lane, kind] of [['type', 'type'], ['value', 'term']]) {
      for (const to of node[lane]) {
        edges.push({ from, to, kind, resolution: !Object.hasOwn(g.nodes, to) ? 'external' : g.nodes[to].probeAtom ? 'local' : 'generated' });
      }
    }
  }
  return edges;
}

const edgeKey = (edge) => `${edge.from}\u0000${edge.to}\u0000${edge.kind}\u0000${edge.resolution}`;

// Admissibility: valid, internally consistent, bound records of one extraction,
// and a complete graph whose edge list matches its declarations. Anything less
// blocks every closure claim.
function admissibility(i, g, llbc) {
  const blockers = [];
  const block = (code, message) => blockers.push({ code, message });
  // Each record's claims must agree with themselves.
  const nonExact = i.items.some((item) => item.correspondence !== 'exact');
  if (i.binding.status !== 'bound') block('identity-unbound', 'the ticket 10 record is not bound to a recorded extraction attempt');
  else if ((i.binding.reasons ?? []).length > 0) block('identity-contradiction', 'the ticket 10 record is bound but lists binding reasons');
  if (!['complete', 'partial'].includes(i.status)) block('identity-blocked', `the ticket 10 record is ${i.status}`);
  else if (i.blockers.length > 0) block('identity-contradiction', `the ticket 10 record is ${i.status} but lists blockers`);
  else if (i.status === 'complete' && nonExact) block('identity-contradiction', 'the ticket 10 record is complete but holds non-exact items');
  if (g.binding.status !== 'bound') block('graph-unbound', 'the ticket 21 record is not bound to a recorded extraction attempt');
  else if ((g.binding.reasons ?? []).length > 0) block('graph-contradiction', 'the ticket 21 record is bound but lists binding reasons');
  if (g.state === 'unsupported') block('graph-unsupported', 'the ticket 21 producer reported this input unsupported; it gives no graph to plan from');
  else if (g.state !== 'complete') block('graph-incomplete', `the ticket 21 record is ${g.state}; an incomplete graph cannot support a closure claim`);
  else if (g.blockers.length > 0) block('graph-contradiction', 'the ticket 21 record is complete but lists blockers');
  // A graph record without a fidelity field predates ticket 21's fidelity check: its dependencies are not
  // shown to cover what Lean records, so it is treated as unverified.
  if (g.fidelity === undefined) block('graph-fidelity-not-verified', 'the ticket 21 record carries no fidelity result (a pre-fidelity graph record), so its dependencies are unverified');
  else if (g.fidelity.status !== 'verified') block('graph-fidelity-not-verified', `the ticket 21 record's dependency fidelity is ${g.fidelity.status}`);
  else if (!Array.isArray(g.fidelity.obligations) || g.fidelity.obligations.length > 0) block('graph-fidelity-contradiction', 'the ticket 21 record claims verified fidelity without an empty obligations list');
  // The graph's edge list must be its declarations' dependency lists (version 1)
  // or its nodes lanes (version 2), exactly.
  const oracle = g.schemaVersion === 2;
  const declared = oracle ? laneEdges(g) : declaredEdges(g);
  if (declared === null) block('graph-declarations-malformed', 'a declaration lacks well-formed dependency lists');
  else {
    const want = declared.map(edgeKey).sort();
    const have = g.edges.map(edgeKey).sort();
    if (JSON.stringify(want) !== JSON.stringify(have)) block('graph-edges-inconsistent', 'the edge list does not match the declarations\' dependency lists (endpoints, kinds or resolutions)');
    if (g.state === 'complete' && declared.some((edge) => edge.resolution === 'unresolved')) block('graph-contradiction', 'the ticket 21 record is complete but has unresolved dependencies');
    // A declaration of this graph is in scope: listing it as external would hide a local dependency.
    const hidden = declared.filter((edge) => edge.resolution === 'external' && Object.hasOwn(g.declarations, edge.to));
    if (hidden.length > 0) block('graph-contradiction', `declared in the graph but listed as external: ${[...new Set(hidden.map((edge) => edge.to))].sort().join(', ')}`);
  }
  if (oracle) {
    // The raw probe atoms are exactly the probe-atom nodes.
    const probeNodes = Object.keys(g.nodes).filter((id) => g.nodes[id].probeAtom).sort();
    if (JSON.stringify(probeNodes) !== JSON.stringify(Object.keys(g.declarations).sort())) {
      block('graph-contradiction', 'the probe declarations are not exactly the nodes marked probeAtom');
    }
    // Kernel constants are added in dependency order, so their lanes cannot form a
    // cycle; a cycle or self-reference is a producer contradiction.
    const adjacency = new Map(Object.keys(g.nodes).map((id) => [id, []]));
    for (const edge of declared) if (edge.resolution !== 'external') adjacency.get(edge.from).push(edge.to);
    const cyclic = components(adjacency).filter((c) => c.length > 1 || adjacency.get(c[0]).includes(c[0]));
    for (const component of cyclic) block('graph-contradiction', `the nodes lanes form a cycle: ${component.join(', ')}`);
  }
  // Provenance: well-formed on both sides, and equal.
  for (const field of PROVENANCE) {
    const [a, b] = [i.provenance[field], g.provenance[field]];
    const valid = COMMIT_FIELDS.includes(field) ? isCommit : DIGEST_FIELDS.includes(field) ? isSha : isText;
    if (a === null || a === undefined || b === null || b === undefined) block('provenance-missing', `${field} is missing from ${a == null && b == null ? 'both records' : a == null ? 'the ticket 10 record' : 'the ticket 21 record'}`);
    else if (!valid(a) || !valid(b)) block('provenance-malformed', `${field} is not a well-formed ${COMMIT_FIELDS.includes(field) ? 'commit' : DIGEST_FIELDS.includes(field) ? 'sha256' : 'version'}`);
    else if (a !== b) block('provenance-mismatch', `${field} differs: ticket 10 ${a}, ticket 21 ${b}`);
  }
  // Published Lean files: well-formed, unique, and the same set on both sides.
  const published = (record, label) => {
    const list = record.binding.generatedLean;
    if (!Array.isArray(list) || list.length === 0) {
      block('generated-lean-missing', `the ${label} record carries no published Lean files`);
      return null;
    }
    if (list.some((entry) => !isObject(entry) || !isText(entry.projectPath) || !isSha(entry.sha256))
      || new Set(list.map((entry) => entry.projectPath)).size !== list.length) {
      block('generated-lean-malformed', `the ${label} record's published Lean files are malformed or repeated`);
      return null;
    }
    return list.map((entry) => `${entry.projectPath}\u0000${entry.sha256}`).sort();
  };
  const [pi, pg] = [published(i, 'ticket 10'), published(g, 'ticket 21')];
  if (pi && pg && JSON.stringify(pi) !== JSON.stringify(pg)) block('generated-lean-mismatch', 'the two records name different published Lean files or hashes');
  if (llbc && llbc.sha256 !== i.provenance.llbcSha256) block('llbc-mismatch', 'the given LLBC is not the attempt\'s LLBC');
  return { blockers, declared };
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

// Strongly connected components of a directed graph given as Map<id, id[]>.
function components(adjacency) {
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const found = [];
  let counter = 0;
  const visit = (id) => {
    index.set(id, counter);
    low.set(id, counter);
    counter += 1;
    stack.push(id);
    onStack.add(id);
    for (const next of adjacency.get(id) ?? []) {
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
      found.push(component.sort());
    }
  };
  for (const id of [...adjacency.keys()].sort()) if (!index.has(id)) visit(id);
  return found;
}

// The semantic definition closure over the nodes lanes, in Lean ids (source and
// generated nodes): a theorem contributes its statement (type lane) only.
function definitionClosure(g, starts) {
  const seen = new Set();
  const queue = starts.filter((id) => Object.hasOwn(g.nodes, id));
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const node = g.nodes[id];
    const lanes = THEOREM_KINDS.includes(node.kind) ? node.type : [...node.type, ...node.value];
    queue.push(...lanes.filter((to) => Object.hasOwn(g.nodes, to)));
  }
  return [...seen].sort();
}

export function buildPlan({ identity, graph, roots, failed = [], llbc = null }) {
  const { i, g } = validate({ identity, graph, roots, failed, llbc });
  const requested = sortedNumbers(roots);
  const { blockers, declared } = admissibility(i, g, llbc);
  const record = {
    schema: 'fvs-closure-plan/record',
    version: 1,
    status: 'blocked',
    inputs: { identitySha256: identity.sha256, graphSha256: graph.sha256, llbcSha256: llbc?.sha256 ?? null },
    selection: { requestedRoots: requested, failed: sortedNumbers(failed) },
    provenance: Object.fromEntries(PROVENANCE.map((field) => [field, i.provenance[field] ?? null])),
    qualification: {
      graphFidelity: g.fidelity === undefined ? 'not-supplied (a pre-fidelity graph record)' : g.fidelity.status,
      ...(g.schemaVersion === 2 ? { graphSchemaVersion: 2, graphCapability: g.capability } : {}),
    },
    admissibility: { status: blockers.length === 0 ? 'admissible' : 'blocked', blockers },
    upstream: { identityStatus: i.status, identityBlockers: i.blockers, graphState: g.state, graphBlockers: g.blockers },
    ownership: { rule: OWNERSHIP_RULE },
    edgeOrientation: g.schemaVersion === 2
      ? 'consumer -> dependency, from the graph\'s nodes lanes (type and value); generated nodes are passed through, never scheduled'
      : 'consumer -> dependency, from the graph\'s declared dependency lists',
    nodes: {},
    observedCycles: [],
    roots: [],
  };
  if (blockers.length > 0) {
    record.roots = requested.map((defId) => ({ defId, status: 'blocked', closure: null, blockers: [{ code: 'not-admissible', message: 'the two records are not admissible together' }] }));
    return record;
  }

  // Nodes: one per ticket 10 item; its Lean family is every generated definition.
  const groups = recursionGroups(llbc);
  const nodes = new Map();
  const claims = new Map();
  for (const item of i.items) {
    const declarations = item.generated.map((member) => `probe:${member.leanName}`);
    const reasons = [];
    let eligibility = 'eligible';
    if (item.correspondence !== 'exact') {
      eligibility = item.reasons.includes('recursion') ? 'recursion-unqualified' : 'blocked-upstream';
    } else if (item.reasons.length > 0) {
      // Ticket 10 gives exact correspondence only to an item with no reasons.
      eligibility = 'blocked-upstream-contradiction';
      reasons.push('the item is labelled exact but carries ticket 10 reasons');
    } else if (declarations.length === 0 || new Set(declarations).size !== declarations.length || !item.target
      || !item.generated.some((member) => member.leanName === item.target)) {
      eligibility = 'blocked-family-invalid';
      reasons.push('the exact item\'s generated family is empty, repeated, or does not contain its target');
    } else {
      const missing = declarations.filter((id) => !Object.hasOwn(g.declarations, id));
      if (missing.length > 0) {
        eligibility = 'blocked-unmatched';
        reasons.push(...missing.map((id) => `${id} is not in the Lean graph`));
      }
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
    for (const id of new Set(declarations)) claims.set(id, [...(claims.get(id) ?? []), item.defId]);
  }
  // A declaration claimed by more than one item belongs to none of them alone.
  const owner = new Map();
  for (const [id, claimants] of claims) {
    if (claimants.length === 1) {
      owner.set(id, claimants[0]);
      continue;
    }
    for (const defId of claimants) {
      const node = nodes.get(defId);
      if (node.eligibility === 'eligible') node.eligibility = 'blocked-ambiguous-ownership';
      node.reasons.push(`${id} is also claimed by ${claimants.filter((other) => other !== defId).join(', ')}`);
    }
  }
  // Lean-level adjacency over the graph's own constants, both lanes. In version
  // 2 a node without a probe atom is generated (a matcher, proof, constructor
  // or recursor): it has no Rust def_id, owner or task and is only passed through.
  const oracle = g.schemaVersion === 2;
  const generated = (id) => oracle && !g.nodes[id].probeAtom;
  const adjacency = new Map(Object.keys(oracle ? g.nodes : g.declarations).map((id) => [id, []]));
  for (const edge of declared) if (edge.resolution === 'local' || edge.resolution === 'generated') adjacency.get(edge.from).push(edge.to);
  // Dependencies between nodes, folded within a family and followed through
  // generated nodes; a probe atom no single node owns is kept visible as
  // unmapped (never taken for a generated node).
  for (const node of nodes.values()) {
    const passed = new Set();
    const paths = {};
    for (const start of node.declarations) {
      if (owner.get(start) !== node.defId) continue;
      const previous = new Map([[start, null]]);
      const queue = [start];
      while (queue.length > 0) {
        const id = queue.shift();
        for (const to of adjacency.get(id) ?? []) {
          if (previous.has(to)) continue;
          previous.set(to, id);
          if (generated(to)) {
            passed.add(to);
            queue.push(to);
            continue;
          }
          const toId = owner.get(to);
          if (toId === undefined) {
            if (!node.unmappedDependencies.includes(to)) node.unmappedDependencies.push(to);
          } else if (toId !== node.defId && !node.dependsOn.includes(toId)) {
            node.dependsOn.push(toId);
            const path = [to];
            for (let at = id; at !== null; at = previous.get(at)) path.unshift(at);
            if (path.length > 2) paths[toId] = path;
          }
        }
      }
    }
    if (oracle) Object.assign(node, { generatedDependencies: [...passed].sort(), dependencyPaths: paths });
  }
  for (const node of nodes.values()) {
    node.dependsOn = sortedNumbers(node.dependsOn);
    node.unmappedDependencies.sort();
    if (node.unmappedDependencies.length > 0 && node.eligibility === 'eligible') {
      node.eligibility = 'blocked-unmapped-dependency';
      node.reasons.push(...node.unmappedDependencies.map((id) => `depends on ${id}, which no single ticket 10 item owns`));
    }
  }
  // Cycles over the full declaration graph, before any mapping or eligibility
  // filtering, projected onto scheduling nodes. A cycle entirely inside one
  // family is observed but is not a scheduling cycle. observedCycles is graph
  // topology, not a recursion classification.
  for (const component of components(adjacency).filter((c) => c.length > 1)) {
    const mapped = sortedNumbers(new Set(component.map((id) => owner.get(id)).filter((id) => id !== undefined)));
    const unmapped = component.filter((id) => !owner.has(id));
    const scheduling = mapped.length > 1 || unmapped.length > 0;
    record.observedCycles.push({ declarations: component, nodes: mapped, unmappedDeclarations: unmapped, schedulingCycle: scheduling });
    if (!scheduling) continue;
    for (const defId of mapped) {
      const node = nodes.get(defId);
      node.observedCycle = { nodes: mapped, unmappedDeclarations: unmapped };
      if (node.eligibility === 'eligible') node.eligibility = 'joint-plan-blocker';
      node.reasons.push(`in a dependency cycle with ${[...mapped.filter((other) => other !== defId), ...unmapped].join(', ')}`);
    }
  }

  for (const id of failed) {
    if (!nodes.has(id)) refuse('invalid-input', `failed names def_id ${id}, which is not a ticket 10 item`);
    nodes.get(id).eligibility = 'failed';
  }
  const closureOf = (start) => {
    const seen = new Set();
    const queue = [start];
    while (queue.length > 0) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(...nodes.get(id).dependsOn);
    }
    return sortedNumbers(seen);
  };
  // Failure and non-eligibility propagate to every consumer.
  for (const node of nodes.values()) {
    const below = closureOf(node.defId).filter((id) => id !== node.defId && nodes.get(id).eligibility !== 'eligible');
    if (below.length > 0 && node.eligibility === 'eligible') {
      node.eligibility = 'blocked-by-dependency';
      node.reasons.push(`depends on ${below.join(', ')}, which ${below.length === 1 ? 'is' : 'are'} not eligible`);
    }
  }

  const ownerRoot = new Map();
  for (const root of requested) {
    if (!nodes.has(root)) {
      record.roots.push({ defId: root, status: 'blocked', closure: null, blockers: [{ code: 'unknown-root', message: `def_id ${root} is not a ticket 10 item` }] });
      continue;
    }
    const closure = closureOf(root);
    for (const id of closure) if (!ownerRoot.has(id)) ownerRoot.set(id, root);
    const blocking = closure.filter((id) => nodes.get(id).eligibility !== 'eligible');
    record.roots.push({
      defId: root,
      rustName: nodes.get(root).rustName,
      status: blocking.length === 0 ? 'ready' : 'blocked',
      closure,
      blockers: blocking.map((id) => ({ code: nodes.get(id).eligibility, node: id, reasons: [...nodes.get(id).upstream.reasons, ...nodes.get(id).reasons] })),
      ...(oracle ? { definitionClosure: definitionClosure(g, nodes.get(root).declarations) } : {}),
    });
  }
  for (const node of nodes.values()) {
    const sharedBy = record.roots.filter((root) => root.closure?.includes(node.defId)).map((root) => root.defId);
    record.nodes[node.defId] = { ...node, sharedBy, ownerRoot: ownerRoot.get(node.defId) ?? null };
  }
  if (oracle) record.definitionClosureRule = DEFINITION_CLOSURE_RULE;
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
      lines.push(`  root ${root.defId} ${root.status}: closure ${root.closure ? root.closure.join(', ') || '-' : 'none claimed'}${root.blockers.length ? `; blocked by ${root.blockers.map((b) => `${b.node ?? ''} ${b.code}`.trim()).join(', ')}` : ''}`);
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
