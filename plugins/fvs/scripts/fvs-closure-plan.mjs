#!/usr/bin/env node
'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Joins the Rust identity record to the Lean graph record of
// the same extraction and plans the union dependency closure of the requested
// roots. It only reads those records (and, optionally, the attempt's LLBC); it
// runs nothing. Three decisions stay separate: the raw upstream results are
// kept verbatim; cross-record admissibility (valid, consistent, bound records
// with agreeing provenance and published files, and a complete graph with
// verified dependency fidelity and no open obligations) gates any closure claim and is never salvaged by dropping nodes; scheduling eligibility
// is computed per node, and a requested root is ready only when its whole
// closure is. Recursive items are reported as recursion-unqualified: no
// recursion rule is qualified yet, and the LLBC recursion group is exposed for
// information only. A Lean graph record of schema version 2 (oracle lanes) is
// planned from its nodes lanes: generated nodes are passed through as
// dependency evidence and are never given a def_id, an owner or a task.
//
// Without a graph, or with an identity record built from translation.json
// alone, the plan is degraded: no closure is computed, the roots are listed in
// source order without dependency order, and admissibility is blocked, so no
// consumer that needs an admissible plan accepts it.

const EXIT = { ok: 0, usage: 2, internal: 2, 'invalid-input': 5, partial: 6, blocked: 7, degraded: 9 };
const DEGRADED_ORDER = 'source order (file, begin line); no dependency order';
const DEGRADED_LOST = {
  'graph-missing': 'no Lean graph: dependencies between items are unknown, so no closure, no helper and no dependency order is computed',
  'identity-translation-only': 'the identity is declared by Aeneas in translation.json, never exact: no item is confirmed independently, so none is eligible for proof acceptance',
};
const COMMIT_FIELDS = ['sourceCommit', 'leanProjectCommit'];
const DIGEST_FIELDS = ['translationSha256', 'manifestSha256', 'llbcSha256', 'configSha256'];
const VERSION_FIELDS = ['charonVersion', 'aeneasVersion'];
const PROVENANCE = [...COMMIT_FIELDS, 'translationSha256', ...VERSION_FIELDS, 'manifestSha256', 'llbcSha256', 'configSha256'];
// Lean graph schema version 2 (capability oracle-lanes): every project constant
// is a node with authoritative type and value lanes; generated nodes (no probe
// atom) are dependency evidence only. Kernel kinds as the producer names them.
const ORACLE_CAPABILITY = 'oracle-lanes';
// The kinds the producer qualifies: definitions, theorems, axioms, inductives
// (a structure has structure: true), and the constructors and recursors of an
// inductive. Projections are definitions with projection: true.
const NODE_KINDS = ['def', 'theorem', 'axiom', 'inductive', 'ctor', 'recursor'];
const THEOREM_KINDS = ['theorem'];
const DEFINITION_CLOSURE_RULE = 'from the root item\'s generated family over the nodes lanes: a theorem node follows its type lane only; any other node follows its type and value lanes; a structure adds its fields\' projections and its constructors';
const OTHER_INDUCTIVE_RULE = '; any other inductive adds its constructors';
const leanId = (name) => `probe:${name}`;
// Axiom evidence: the producer records the axiom set of every definition and
// theorem node (and trust repeats it). The standard axioms are always allowed;
// a project axiom is allowed only when the caller names it (allowedAxioms). An
// item resting on any other axiom is blocked, and so is every item depending on it.
const AXIOM_KINDS = ['def', 'theorem'];
const AXIOM_POLICY = ['propext', 'Classical.choice', 'Quot.sound'];
// How each probe declaration label must look as a node (the producer's rule).
const PROBE_LABELS = {
  def: (node) => node.kind === 'def' && node.projection !== true,
  projection: (node) => node.kind === 'def' && node.projection === true,
  theorem: (node) => node.kind === 'theorem',
  structure: (node) => node.kind === 'inductive' && node.structure === true,
  inductive: (node) => node.kind === 'inductive' && node.structure !== true,
  axiom: (node) => node.kind === 'axiom',
  class: (node) => node.kind === 'inductive' && node.structure === true,
  instance: (node) => node.kind === 'def' && node.projection !== true,
};
const fieldsOf = (node) => node.fields ?? [];
const textList = (value) => Array.isArray(value) && value.every(isText) && new Set(value).size === value.length;
// Kernel type-level constants: a structure, its projections, constructors and recursors.
const typeLevel = (node) => ['inductive', 'ctor', 'recursor'].includes(node.kind) || node.projection === true;
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
    'Usage: node fvs-closure-plan.mjs plan --identity FILE [--graph FILE] --roots DEF_ID[,DEF_ID...]',
    '         [--failed DEF_ID[,DEF_ID...]] [--llbc FILE] [--allow-axioms NAME[,NAME...]]',
    '         [--out FILE] [--format json|text]',
    '',
    '--identity  the Rust identity record (fvs-rust-identity record --out)',
    '--graph     the Lean graph record (fvs-lean-graph output) of the same extraction. Optional:',
    '            without it, or with a translation.json-only identity record, the plan is',
    '            degraded (roots in source order, no closure, not admissible)',
    '--roots     the requested roots, by Rust identity def_id',
    '--failed    nodes whose proof failed; every node depending on them is blocked',
    '--llbc      the attempt\'s LLBC (its sha256 must equal both records\' llbcSha256); its',
    '            recursion groups are exposed per node for information only',
    '--allow-axioms  project axioms (exact Lean names, for example those the agreement\'s',
    '            boundaries or the recorded externals name) a claim may rest on; propext,',
    '            Classical.choice and Quot.sound are always allowed. An item resting on any',
    '            other axiom is blocked, and so is every item that depends on it',
    '',
    'Exit: 0 every requested root is ready; 6 some root is blocked (each is listed with its',
    'reasons); 7 the two records are not admissible together (the requested roots are listed',
    'as blocked, no closure is claimed); 9 degraded (no graph or a translation.json-only',
    'identity: source order only, not admissible); 5 invalid input; 2 usage.',
    '',
  ].join('\n'));
}

const wrapperValid = (value) => isObject(value) && 'json' in value && isSha(value.sha256);

// The shape of every input the planner consumes, including the exported
// function's wrappers and selections. Anything else is refused.
function validate({ identity, graph, roots, failed, llbc, allowedAxioms }) {
  const bad = (label, message) => refuse('invalid-input', `${label}: ${message}`);
  if (allowedAxioms !== undefined && !textList(allowedAxioms)) bad('allowedAxioms', 'must be an array of distinct axiom names');
  for (const [label, value] of [['identity', identity], ['graph', graph]]) {
    if ((label === 'identity' || (graph !== null && graph !== undefined)) && !wrapperValid(value)) bad(label, 'is required as { json, sha256 } with the sha256 of its bytes');
  }
  if (llbc !== null && llbc !== undefined && !wrapperValid(llbc)) bad('llbc', 'must be { json, sha256 } or null');
  for (const [label, list, nonEmpty] of [['roots', roots, true], ['failed', failed, false]]) {
    if (!Array.isArray(list) || list.some((id) => !isId(id)) || new Set(list).size !== list.length || (nonEmpty && list.length === 0)) {
      bad(label, `must be ${nonEmpty ? 'a non-empty' : 'an'} array of distinct non-negative integer def_ids`);
    }
  }
  const i = identity.json;
  if (!isObject(i) || i.schema !== 'fvs-rust-identity/record' || i.version !== 1 || !isObject(i.provenance) || !isObject(i.binding)
    || !Array.isArray(i.items) || !Array.isArray(i.blockers) || !['complete', 'partial', 'blocked', 'unbound', 'degraded'].includes(i.status)
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
  // A translation.json-only record is degraded or blocked, and only ever declares items; nothing else is degraded.
  const declaredOnly = i.provenance.discovery === 'translation-only';
  if (declaredOnly !== (i.status === 'degraded' || (declaredOnly && i.status === 'blocked'))
    || (declaredOnly && i.items.some((item) => item.correspondence !== 'declared-by-aeneas'))
    || (!declaredOnly && i.items.some((item) => item.correspondence === 'declared-by-aeneas'))) {
    bad('identity', 'a degraded record must be translation.json-only with only declared-by-aeneas items, and only such a record may hold them');
  }
  if (llbc && !Array.isArray(llbc.json?.translated?.ordered_decls)) bad('llbc', 'has no translated.ordered_decls list');
  if (graph === null || graph === undefined) return { i, g: null };
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
        || ['type', 'value'].some((lane) => !Array.isArray(node[lane]) || node[lane].some((to) => !isText(to)) || new Set(node[lane]).size !== node[lane].length)
        || ![undefined, true].includes(node.structure) || ![undefined, true].includes(node.projection) || (node.structure === true && node.kind !== 'inductive')
        || (node.projection === true && node.kind !== 'def')
        || (node.kind === 'inductive' && !(isObject(node.family) && textList(node.family.ctors) && textList(node.family.recursors)))
        || (node.structure === true && !(Array.isArray(node.fields) && node.fields.every((f) => isObject(f) && isText(f.field) && (f.projection === null || isText(f.projection)))))
        || (node.structure !== true && node.fields !== undefined)
        || (node.kind === 'ctor' && !(isObject(node.family) && isText(node.family.inductive)))
        || (node.kind === 'recursor' && !(isObject(node.family) && textList(node.family.inductives)))
        || (!['inductive', 'ctor', 'recursor'].includes(node.kind) && (node.family !== undefined || node.fields !== undefined))
        || (node.axioms !== undefined && !textList(node.axioms))) {
        bad('graph', `node ${JSON.stringify(id)} is malformed (kind, source, probeAtom, structure, projection, family, fields, axioms, or a type or value lane)`);
      }
    }
    if (!isObject(g.trust) || Object.values(g.trust).some((axioms) => !textList(axioms))) bad('graph', 'a schemaVersion 2 record needs trust: per-node axiom lists');
  }
  const resolutions = oracle ? ['local', 'generated', 'external'] : ['local', 'external', 'unresolved'];
  for (const edge of g.edges) {
    if (!isObject(edge) || !isText(edge.from) || !isText(edge.to) || !['type', 'term'].includes(edge.kind)
      || !resolutions.includes(edge.resolution)) bad('graph', 'an edge is malformed');
  }
  if (g.fidelity !== undefined && !(isObject(g.fidelity) && isText(g.fidelity.status))) bad('graph', 'fidelity is malformed');
  // An allowed axiom is a project axiom of this graph, named exactly.
  const unknown = (allowedAxioms ?? []).filter((name) => !(oracle && g.nodes[leanId(name)]?.kind === 'axiom'));
  if (unknown.length > 0) bad('allowedAxioms', `not an axiom of this Lean graph: ${unknown.join(', ')}`);
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
  if (i.binding.status !== 'bound') block('identity-unbound', 'the Rust identity record is not bound to a recorded extraction attempt');
  else if ((i.binding.reasons ?? []).length > 0) block('identity-contradiction', 'the Rust identity record is bound but lists binding reasons');
  if (!['complete', 'partial'].includes(i.status)) block('identity-blocked', `the Rust identity record is ${i.status}`);
  else if (i.blockers.length > 0) block('identity-contradiction', `the Rust identity record is ${i.status} but lists blockers`);
  else if (i.status === 'complete' && nonExact) block('identity-contradiction', 'the Rust identity record is complete but holds non-exact items');
  if (g.binding.status !== 'bound') block('graph-unbound', 'the Lean graph record is not bound to a recorded extraction attempt');
  else if ((g.binding.reasons ?? []).length > 0) block('graph-contradiction', 'the Lean graph record is bound but lists binding reasons');
  if (g.state === 'unsupported') block('graph-unsupported', 'the Lean graph producer reported this input unsupported; it gives no graph to plan from');
  else if (g.state !== 'complete') block('graph-incomplete', `the Lean graph record is ${g.state}; an incomplete graph cannot support a closure claim`);
  else if (g.blockers.length > 0) block('graph-contradiction', 'the Lean graph record is complete but lists blockers');
  // A graph record without a fidelity field predates the graph fidelity check: its dependencies are not
  // shown to cover what Lean records, so it is treated as unverified.
  if (g.fidelity === undefined) block('graph-fidelity-not-verified', 'the Lean graph record carries no fidelity result (a pre-fidelity graph record), so its dependencies are unverified');
  else if (g.fidelity.status !== 'verified') block('graph-fidelity-not-verified', `the Lean graph record's dependency fidelity is ${g.fidelity.status}`);
  else if (!Array.isArray(g.fidelity.obligations) || g.fidelity.obligations.length > 0) block('graph-fidelity-contradiction', 'the Lean graph record claims verified fidelity without an empty obligations list');
  // The graph's edge list must be its declarations' dependency lists (version 1)
  // or its nodes lanes (version 2), exactly.
  const oracle = g.schemaVersion === 2;
  const declared = oracle ? laneEdges(g) : declaredEdges(g);
  if (declared === null) block('graph-declarations-malformed', 'a declaration lacks well-formed dependency lists');
  else {
    const want = declared.map(edgeKey).sort();
    const have = g.edges.map(edgeKey).sort();
    if (JSON.stringify(want) !== JSON.stringify(have)) block('graph-edges-inconsistent', 'the edge list does not match the declarations\' dependency lists (endpoints, kinds or resolutions)');
    if (g.state === 'complete' && declared.some((edge) => edge.resolution === 'unresolved')) block('graph-contradiction', 'the Lean graph record is complete but has unresolved dependencies');
    // A declaration of this graph is in scope: listing it as external would hide a local dependency.
    const hidden = declared.filter((edge) => edge.resolution === 'external' && Object.hasOwn(g.declarations, edge.to));
    if (hidden.length > 0) block('graph-contradiction', `declared in the graph but listed as external: ${[...new Set(hidden.map((edge) => edge.to))].sort().join(', ')}`);
  }
  if (oracle) {
    // The raw probe atoms are exactly the probe-atom nodes, and a node is a probe
    // atom exactly when it is defined in source.
    const probeNodes = Object.keys(g.nodes).filter((id) => g.nodes[id].probeAtom).sort();
    if (JSON.stringify(probeNodes) !== JSON.stringify(Object.keys(g.declarations).sort())) {
      block('graph-contradiction', 'the probe declarations are not exactly the nodes marked probeAtom');
    }
    // probe-lean emits no declaration for the constructors and recursor of an
    // inductive it emits; those source constants are covered by the inductive.
    const node = (name) => (isText(name) ? g.nodes[leanId(name)] : undefined);
    const covered = (n) => (n.kind === 'ctor' ? [n.family?.inductive] : n.kind === 'recursor' ? (n.family?.inductives ?? []) : [])
      .some((owner) => node(owner)?.kind === 'inductive' && node(owner).probeAtom);
    const split = Object.keys(g.nodes).filter((id) => g.nodes[id].source !== g.nodes[id].probeAtom && !(g.nodes[id].source && covered(g.nodes[id]))).sort();
    if (split.length > 0) block('graph-contradiction', `source and probeAtom disagree for ${split.join(', ')}`);
    // An inductive's family and a structure's fields name existing constructors,
    // recursors and projections; a constructor or recursor belongs to an inductive.
    const malformed = [];
    for (const [id, n] of Object.entries(g.nodes)) {
      const name = id.slice('probe:'.length);
      if (n.kind === 'inductive') {
        const { ctors, recursors } = n.family ?? {};
        if (!Array.isArray(ctors) || (n.structure === true && ctors.length === 0) || ctors.some((c) => node(c)?.kind !== 'ctor' || node(c).family?.inductive !== name)
          || !Array.isArray(recursors) || recursors.some((r) => node(r)?.kind !== 'recursor' || !(node(r).family?.inductives ?? []).includes(name))
          || fieldsOf(n).some((f) => node(f.projection)?.projection !== true)) malformed.push(id);
      } else if (n.kind === 'ctor' && node(n.family?.inductive)?.kind !== 'inductive') malformed.push(id);
      else if (n.kind === 'recursor' && !(Array.isArray(n.family?.inductives) && n.family.inductives.length > 0 && n.family.inductives.every((s) => node(s)?.kind === 'inductive'))) malformed.push(id);
    }
    if (malformed.length > 0) block('graph-contradiction', `inductive family or structure fields do not resolve for ${malformed.join(', ')}`);
    // Each probe atom's label agrees with its node, and a projection is a field of a structure.
    const mislabelled = Object.keys(g.declarations).filter((id) => Object.hasOwn(g.nodes, id) && !PROBE_LABELS[g.declarations[id]?.kind]?.(g.nodes[id])).sort();
    if (mislabelled.length > 0) block('graph-contradiction', `probe declaration labels disagree with their nodes for ${mislabelled.join(', ')}`);
    const fieldOf = new Set(Object.values(g.nodes).flatMap((n) => fieldsOf(n).map((f) => f.projection)).filter(isText).map(leanId));
    const orphans = Object.keys(g.nodes).filter((id) => g.nodes[id].projection === true && !fieldOf.has(id)).sort();
    if (orphans.length > 0) block('graph-contradiction', `projections that are no structure's field: ${orphans.join(', ')}`);
    // Axiom evidence: present exactly on definitions and theorems, repeated in trust.
    const evidence = Object.keys(g.nodes).filter((id) => (g.nodes[id].axioms !== undefined) !== AXIOM_KINDS.includes(g.nodes[id].kind)
      || JSON.stringify(g.trust[id]) !== JSON.stringify(g.nodes[id].axioms));
    const strayTrust = Object.keys(g.trust).filter((id) => !Object.hasOwn(g.nodes, id));
    if (evidence.length + strayTrust.length > 0) block('graph-trust-contradiction', `axiom evidence is missing, misplaced or disagrees with trust for ${[...evidence, ...strayTrust].sort().join(', ')}`);
    // Which axioms a claim may rest on is decided per item (allowedAxioms), not here.
  }
  // Across the records: an identity generated family member is a source
  // definition of this extraction, so the graph may not hold it as a generated,
  // type-level or external constant, which would hide the Rust item from its consumers.
  const claimed = new Set(i.items.flatMap((item) => item.generated.map((member) => leanId(member.leanName))));
  const hiddenItems = [...claimed].filter((id) => (oracle && Object.hasOwn(g.nodes, id) && (!g.nodes[id].probeAtom || typeLevel(g.nodes[id])))
    || (!Object.hasOwn(g.declarations, id) && (declared ?? []).some((edge) => edge.resolution === 'external' && edge.to === id))).sort();
  if (hiddenItems.length > 0) block('identity-graph-contradiction', `Rust identity family members held by the graph as generated, type-level or external constants: ${hiddenItems.join(', ')}`);
  // Provenance: well-formed on both sides, and equal.
  for (const field of PROVENANCE) {
    const [a, b] = [i.provenance[field], g.provenance[field]];
    const valid = COMMIT_FIELDS.includes(field) ? isCommit : DIGEST_FIELDS.includes(field) ? isSha : isText;
    if (a === null || a === undefined || b === null || b === undefined) block('provenance-missing', `${field} is missing from ${a == null && b == null ? 'both records' : a == null ? 'the Rust identity record' : 'the Lean graph record'}`);
    else if (!valid(a) || !valid(b)) block('provenance-malformed', `${field} is not a well-formed ${COMMIT_FIELDS.includes(field) ? 'commit' : DIGEST_FIELDS.includes(field) ? 'sha256' : 'version'}`);
    else if (a !== b) block('provenance-mismatch', `${field} differs: Rust identity record ${a}, Lean graph record ${b}`);
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
  const [pi, pg] = [published(i, 'Rust identity'), published(g, 'Lean graph')];
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
export function definitionClosure(g, starts) {
  const seen = new Set();
  const queue = starts.filter((id) => Object.hasOwn(g.nodes, id));
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const node = g.nodes[id];
    const lanes = THEOREM_KINDS.includes(node.kind) ? node.type : [...node.type, ...node.value];
    // An inductive's lanes record only its type; its constructors (and a structure's fields) carry its meaning.
    const members = node.kind === 'inductive' ? [...fieldsOf(node).map((f) => f.projection), ...node.family.ctors].filter(isText).map(leanId) : [];
    queue.push(...[...lanes, ...members].filter((to) => Object.hasOwn(g.nodes, to)));
  }
  return [...seen].sort();
}

// Expand scheduling through both graph lanes and structure members. Callers supply
// validated families; this also propagates cycles, unmapped dependencies and failures.
export function expandSchedulingDependencies(g, nodes, failed = []) {
  const claims = new Map();
  for (const node of nodes.values()) {
    node.dependsOn = [];
    node.unmappedDependencies = [];
    for (const id of new Set(node.declarations)) claims.set(id, [...(claims.get(id) ?? []), node.defId]);
  }
  const declared = g.schemaVersion === 2 ? laneEdges(g) : declaredEdges(g);
  const observedCycles = [];
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
  // A type-level probe atom no item owns (a structure or its projection: ticket
  // 10 records functions only) is passed through like a generated node.
  const passThrough = (id) => generated(id) || (oracle && typeLevel(g.nodes[id]) && !owner.has(id));
  const adjacency = new Map(Object.keys(oracle ? g.nodes : g.declarations).map((id) => [id, []]));
  for (const edge of declared) if (edge.resolution === 'local' || edge.resolution === 'generated') adjacency.get(edge.from).push(edge.to);
  // Version 2 cycles over every node, both lanes, before any filtering: a
  // passed-through node in a cycle blocks every node whose traversal reaches it.
  const cyclicPassed = new Set();
  const cycles = oracle ? components(adjacency).filter((c) => c.length > 1 || adjacency.get(c[0]).includes(c[0])) : [];
  for (const component of cycles) for (const id of component) if (passThrough(id)) cyclicPassed.add(id);
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
        // A structure's fields and constructors carry its meaning, so they are
        // requirements of whoever reaches it (not lane edges: no cycle analysis).
        const members = oracle && g.nodes[id]?.kind === 'inductive'
          ? [...fieldsOf(g.nodes[id]).map((f) => f.projection), ...g.nodes[id].family.ctors].filter(isText).map(leanId).filter((m) => Object.hasOwn(g.nodes, m)) : [];
        for (const to of [...(adjacency.get(id) ?? []), ...members]) {
          if (previous.has(to)) continue;
          previous.set(to, id);
          if (passThrough(to)) {
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
    if (oracle) {
      Object.assign(node, {
        generatedDependencies: [...passed].filter(generated).sort(),
        typeDependencies: [...passed].filter((id) => !generated(id)).sort(),
        dependencyPaths: paths,
      });
      const inCycle = [...passed].filter((id) => cyclicPassed.has(id)).sort();
      if (inCycle.length > 0 && node.eligibility === 'eligible') {
        node.eligibility = 'blocked-generated-cycle';
        node.reasons.push(`reaches ${inCycle.join(', ')}, which ${inCycle.length === 1 ? 'is' : 'are'} in a dependency cycle no item owns`);
      }
    }
  }
  for (const node of nodes.values()) {
    node.dependsOn = sortedNumbers(node.dependsOn);
    node.unmappedDependencies.sort();
    if (node.unmappedDependencies.length > 0 && node.eligibility === 'eligible') {
      node.eligibility = 'blocked-unmapped-dependency';
      node.reasons.push(...node.unmappedDependencies.map((id) => `depends on ${id}, which no single Rust identity item owns`));
    }
  }
  // Cycles over the full declaration graph, before any mapping or eligibility
  // filtering, projected onto scheduling nodes. A cycle entirely inside one
  // family is observed but is not a scheduling cycle. observedCycles is graph
  // topology, not a recursion classification.
  for (const component of oracle ? cycles : components(adjacency).filter((c) => c.length > 1)) {
    const mapped = sortedNumbers(new Set(component.map((id) => owner.get(id)).filter((id) => id !== undefined)));
    const unmapped = component.filter((id) => !owner.has(id));
    // A single owned node's self-reference is not a scheduling cycle (recursion
    // stays the identity record's classification); an unowned self-reference is.
    const scheduling = mapped.length > 1 || unmapped.length > 0;
    observedCycles.push({
      declarations: component, nodes: mapped, unmappedDeclarations: unmapped, schedulingCycle: scheduling,
      ...(oracle ? { passedThrough: component.filter((id) => cyclicPassed.has(id)) } : {}),
    });
    if (!scheduling) continue;
    for (const defId of mapped) {
      const node = nodes.get(defId);
      node.observedCycle = { nodes: mapped, unmappedDeclarations: unmapped };
      if (node.eligibility === 'eligible') node.eligibility = 'joint-plan-blocker';
      node.reasons.push(`in a dependency cycle with ${[...mapped.filter((other) => other !== defId), ...unmapped].join(', ')}`);
    }
  }

  for (const id of failed) {
    if (!nodes.has(id)) refuse('invalid-input', `failed names def_id ${id}, which is not a Rust identity item`);
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

  return { observedCycles, closureOf };
}

// The degraded plan: the requested roots and every item in source order, no
// closure and no scheduling. A blocked identity still claims nothing.
function degradedPlan({ identity, graph, llbc, i, g, requested, failed, selection }) {
  const codes = [...(g ? [] : ['graph-missing']), ...(i.provenance.discovery === 'translation-only' ? ['identity-translation-only'] : [])];
  const blockers = codes.map((code) => ({ code, message: DEGRADED_LOST[code] }));
  if (i.status === 'blocked') blockers.push({ code: 'identity-blocked', message: 'the Rust identity record is blocked' });
  const items = new Map(i.items.map((item) => [item.defId, item]));
  const sourceOrder = [...i.items]
    .sort((a, b) => String(a.source?.file ?? '').localeCompare(String(b.source?.file ?? '')) || (a.source?.begin_line ?? 0) - (b.source?.begin_line ?? 0) || a.defId - b.defId)
    .map((item) => ({ defId: item.defId, rustName: item.rustName ?? null, target: item.target, file: item.source?.file ?? null, beginLine: item.source?.begin_line ?? null, reasons: item.reasons }));
  const blocked = i.status === 'blocked';
  return {
    schema: 'fvs-closure-plan/record',
    version: 1,
    status: blocked ? 'blocked' : 'degraded',
    inputs: { identitySha256: identity.sha256, graphSha256: graph?.sha256 ?? null, llbcSha256: llbc?.sha256 ?? null },
    selection,
    provenance: Object.fromEntries(PROVENANCE.map((field) => [field, i.provenance[field] ?? null])),
    qualification: { graphFidelity: g ? (g.fidelity?.status ?? 'not-supplied (a pre-fidelity graph record)') : 'not-supplied (no graph)' },
    admissibility: { status: 'blocked', blockers },
    upstream: { identityStatus: i.status, identityBlockers: i.blockers, graphState: g?.state ?? null, graphBlockers: g?.blockers ?? null },
    nodes: {},
    observedCycles: [],
    roots: requested.map((defId) => (blocked || !items.has(defId)
      ? { defId, status: 'blocked', closure: null, blockers: [blocked ? { code: 'not-admissible', message: 'the Rust identity record is blocked' } : { code: 'unknown-root', message: `def_id ${defId} is not a Rust identity item` }] }
      : { defId, rustName: items.get(defId).rustName ?? null, status: 'degraded', closure: null, scope: 'every item in degraded.sourceOrder; the closure is not computed',
        blockers: [{ code: 'closure-not-computed', message: `the dependency closure needs ${codes.map((code) => (code === 'graph-missing' ? 'a Lean graph' : 'an exact identity')).join(' and ')}` }] })),
    degraded: {
      reasons: codes,
      lost: codes.map((code) => DEGRADED_LOST[code]),
      order: DEGRADED_ORDER,
      sourceOrder: blocked ? [] : sourceOrder,
    },
  };
}

// allowedAxioms: project axioms (exact Lean names) a claim may rest on besides
// the standard ones, for example those the agreement's boundaries or the
// recorded externals name. Recorded in the plan's selection only when given.
export function buildPlan({ identity, graph = null, roots, failed = [], llbc = null, allowedAxioms }) {
  const { i, g } = validate({ identity, graph, roots, failed, llbc, allowedAxioms });
  const requested = sortedNumbers(roots);
  const selection = { requestedRoots: requested, failed: sortedNumbers(failed), ...(allowedAxioms === undefined ? {} : { allowedAxioms: [...allowedAxioms].sort() }) };
  if (!g || i.provenance.discovery === 'translation-only') return degradedPlan({ identity, graph, llbc, i, g, requested, failed, selection });
  const { blockers } = admissibility(i, g, llbc);
  const record = {
    schema: 'fvs-closure-plan/record',
    version: 1,
    status: 'blocked',
    inputs: { identitySha256: identity.sha256, graphSha256: graph.sha256, llbcSha256: llbc?.sha256 ?? null },
    selection,
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

  // Nodes: one per Rust identity item; its Lean family is every generated definition.
  const groups = recursionGroups(llbc);
  const nodes = new Map();
  for (const item of i.items) {
    const declarations = item.generated.map((member) => `probe:${member.leanName}`);
    const reasons = [];
    let eligibility = 'eligible';
    if (item.correspondence !== 'exact') {
      eligibility = item.reasons.includes('recursion') ? 'recursion-unqualified' : 'blocked-upstream';
    } else if (item.reasons.length > 0) {
      // The identity record gives exact correspondence only to an item with no reasons.
      eligibility = 'blocked-upstream-contradiction';
      reasons.push('the item is labelled exact but carries Rust identity reasons');
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
    // The axioms the item rests on: its declarations' axiom sets, and the item itself when it is an axiom.
    const restsOn = g.schemaVersion === 2 ? declarations.flatMap((id) => [...(g.nodes[id]?.axioms ?? []), ...(g.nodes[id]?.kind === 'axiom' ? [id.slice('probe:'.length)] : [])]) : [];
    const unallowed = [...new Set(restsOn)].filter((name) => !AXIOM_POLICY.includes(name) && !(allowedAxioms ?? []).includes(name)).sort();
    if (unallowed.length > 0 && eligibility === 'eligible') {
      eligibility = 'blocked-unallowed-axiom';
      reasons.push(`rests on ${unallowed.join(', ')}, which ${unallowed.length === 1 ? 'is' : 'are'} not an allowed axiom`);
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
  }
  const { observedCycles, closureOf } = expandSchedulingDependencies(g, nodes, failed);
  record.observedCycles = observedCycles;
  const oracle = g.schemaVersion === 2;

  const ownerRoot = new Map();
  for (const root of requested) {
    if (!nodes.has(root)) {
      record.roots.push({ defId: root, status: 'blocked', closure: null, blockers: [{ code: 'unknown-root', message: `def_id ${root} is not a Rust identity item` }] });
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
  if (oracle) {
    const otherInductive = Object.values(g.nodes).some((n) => n.kind === 'inductive' && n.structure !== true);
    record.definitionClosureRule = DEFINITION_CLOSURE_RULE + (otherInductive ? OTHER_INDUCTIVE_RULE : '');
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
  const known = ['identity', 'graph', 'roots', 'failed', 'llbc', 'allow-axioms', 'out', 'format'];
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
  for (const key of ['identity', 'roots']) if (!flags[key]) refuse('usage', `--${key} is required`);
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
      graph: flags.graph ? readInput(flags.graph, 'graph') : null,
      roots: ids(flags.roots, '--roots'),
      failed: flags.failed ? ids(flags.failed, '--failed') : [],
      llbc: flags.llbc ? readInput(flags.llbc, 'llbc') : null,
      ...(flags['allow-axioms'] ? { allowedAxioms: flags['allow-axioms'].split(',') } : {}),
    });
    if (flags.out) writeAtomic(flags.out, `${JSON.stringify(record, null, 2)}\n`);
    const code = record.status === 'ready' ? 'ok' : record.status;
    const message = record.status === 'blocked'
      ? `not admissible: ${record.admissibility.blockers.map((b) => b.code).join(', ')}`
      : record.status === 'degraded'
        ? `degraded (${record.degraded.reasons.join(', ')}): ${record.degraded.sourceOrder.length} item(s) in ${record.degraded.order}; no closure is claimed and proof acceptance refuses this plan`
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
  if (!['ok', 'partial', 'blocked', 'degraded'].includes(result.code)) process.stderr.write(`FVS >> ${result.code}: ${result.message}\n`);
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
