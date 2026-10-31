#!/usr/bin/env node
'use strict';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { definitionClosure, expandSchedulingDependencies } from './fvs-closure-plan.mjs';

// Contract registry for the nodes of a qualified closure plan (schema 2,
// oracle lanes). It records machine-reviewed contracts and the invalidation
// each revision causes. Every record is provisional: independence between
// author and reviewer is declared (distinct session and run), never verified,
// and no record accepts a proof. Contracts are keyed by the node's identity in
// the plan; a contract's semantic candidate (statement, assumptions, grounding,
// role, plan context and the content of every dependency) is fingerprinted, and
// a review counts only for that exact fingerprint. A changed fingerprint needs
// a fresh review; an unchanged one only a recheck. Invalidation reaches the
// changed node's transitive consumers and every contract sharing a changed
// semantic input. Records form one global chain, committed one at a time under
// an exclusive lock with a single rename (consistent after a process crash; no
// power-loss durability is claimed).

const RECORD_SCHEMA = 'fvs-contract-registry/record';
const PLAN_SCHEMA = 'fvs-closure-plan/record';
const EXIT = { ok: 0, usage: 2, internal: 2, 'invalid-input': 5, recorded: 6, refused: 7, pending: 8, corrupt: 8, busy: 8 };
const RANK = { 'machine-reviewed-provisional': 0, 'recheck-required': 1, 'needs-review': 2, 'needs-semantic-review': 2, 'changes-requested': 2, stale: 3 };
const RECORD_NAME = /^(\d{6})-([0-9a-f]{64})\.json$/;

class Refusal extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const refuse = (code, message, details) => { throw new Refusal(code, message, details); };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const isSha = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const sorted = (values) => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const textList = (value) => Array.isArray(value) && value.every(isText) && new Set(value).size === value.length;
const idList = (value) => Array.isArray(value) && value.every((id) => Number.isSafeInteger(id) && id >= 0) && new Set(value).size === value.length;
// A stable serialisation: object keys sorted at every level.
export const canonical = (value) => (Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : isObject(value) ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value));
const moreSevere = (a, b) => ((RANK[b] ?? -1) > (RANK[a] ?? -1) ? b : a);

function usage() {
  process.stdout.write([
    'Usage: node fvs-contract-registry.mjs register --plan FILE --graph FILE --registry DIR --spec-root DIR --contract FILE [--review FILE]',
    '       node fvs-contract-registry.mjs revise   --plan FILE --graph FILE --registry DIR --spec-root DIR --contract FILE [--review FILE] --previous RECORD_SHA256',
    '       node fvs-contract-registry.mjs status   --plan FILE --graph FILE --registry DIR --spec-root DIR',
    '',
    'register and revise append one record for a node of an admissible closure plan (schema 2,',
    'verified fidelity) whose graph is --graph; status reports every node\'s current state.',
    'Reviews carry registryHeadSha256 from status; any intervening append makes that packet stale.',
    'Exit: 0 recorded as machine-reviewed-provisional (or status read); 6 recorded but not provisional;',
    '7 refused (inconsistent plan, unsupported node, contract or review); 8 registry pending, busy or',
    'corrupt; 5 invalid input; 2 usage.',
    '',
  ].join('\n'));
}

function readJson(file, label) {
  let bytes;
  try {
    bytes = fs.readFileSync(path.resolve(file));
  } catch (error) {
    refuse('invalid-input', `${label} ${file} is unreadable (${error.code ?? error.message})`);
  }
  try {
    return { json: JSON.parse(bytes.toString('utf8')), sha256: sha256(bytes) };
  } catch {
    return refuse('invalid-input', `${label} ${file} is not JSON`);
  }
}

// ---- the plan ----------------------------------------------------------------

// Recheck the graph claims used by the closure provider, without executing Lean.
function graphProblems(g) {
  const problems = [];
  if (g.capability !== 'oracle-lanes' || g.state !== 'complete' || !Array.isArray(g.blockers) || g.blockers.length
    || g.binding.status !== 'bound' || !Array.isArray(g.binding.reasons) || g.binding.reasons.length
    || g.fidelity?.status !== 'verified' || !Array.isArray(g.fidelity.obligations) || g.fidelity.obligations.length) {
    problems.push('the graph is not complete, bound and verified without blockers or obligations');
  }
  const files = g.binding.generatedLean;
  if (!Array.isArray(files) || !files.length || files.some((f) => !isObject(f) || !isText(f.projectPath) || !isSha(f.sha256))
    || new Set(files.map((f) => f.projectPath)).size !== files.length) problems.push('the graph has no valid unique published Lean set');
  if (!isObject(g.declarations) || !isObject(g.trust) || !Array.isArray(g.edges)) return [...problems, 'the graph lacks declarations, trust or edges'];
  const kinds = ['def', 'theorem', 'inductive', 'ctor', 'recursor'];
  const implied = [];
  const leanId = (name) => `probe:${name}`;
  for (const [id, n] of Object.entries(g.nodes)) {
    if (!isObject(n) || !kinds.includes(n.kind) || typeof n.probeAtom !== 'boolean' || n.source !== n.probeAtom
      || !textList(n.type) || !textList(n.value)) { problems.push(`malformed graph node ${id}`); continue; }
    if ((n.kind === 'inductive') !== (n.structure === true)
      || (n.kind === 'inductive' && (!isObject(n.family) || !textList(n.family.ctors) || !n.family.ctors.length || !textList(n.family.recursors)
        || !Array.isArray(n.fields) || n.fields.some((f) => !isObject(f) || !isText(f.field) || !(f.projection === null || isText(f.projection)))
        || n.family.ctors.some((name) => g.nodes[leanId(name)]?.kind !== 'ctor' || g.nodes[leanId(name)].family?.inductive !== id.slice(6))
        || n.family.recursors.some((name) => g.nodes[leanId(name)]?.kind !== 'recursor')
        || n.fields.some((f) => f.projection !== null && g.nodes[leanId(f.projection)]?.projection !== true)))
      || (n.kind === 'ctor' && g.nodes[leanId(n.family?.inductive)]?.kind !== 'inductive')
      || (n.kind === 'recursor' && (!textList(n.family?.inductives) || !n.family.inductives.length || n.family.inductives.some((name) => g.nodes[leanId(name)]?.kind !== 'inductive')))) {
      problems.push(`malformed structure family ${id}`);
    }
    const axiomKind = ['def', 'theorem'].includes(n.kind);
    if ((n.axioms !== undefined) !== axiomKind || (axiomKind && (!textList(n.axioms)
      || n.axioms.some((a) => !['propext', 'Classical.choice', 'Quot.sound'].includes(a))
      || canonical(g.trust[id]) !== canonical(n.axioms)))) problems.push(`inconsistent graph trust ${id}`);
    for (const [lane, kind] of [['type', 'type'], ['value', 'term']]) for (const to of n[lane]) {
      implied.push({ from: id, to, kind, resolution: !Object.hasOwn(g.nodes, to) ? 'external' : g.nodes[to]?.probeAtom ? 'local' : 'generated' });
    }
  }
  if (canonical(sorted(Object.keys(g.nodes).filter((id) => g.nodes[id]?.probeAtom))) !== canonical(sorted(Object.keys(g.declarations)))) problems.push('probe atoms and declarations disagree');
  if (Object.keys(g.trust).some((id) => !Object.hasOwn(g.nodes, id))) problems.push('trust names an unknown graph node');
  const labels = { def: (n) => n.kind === 'def' && n.projection !== true, theorem: (n) => n.kind === 'theorem',
    projection: (n) => n.kind === 'def' && n.projection === true, structure: (n) => n.kind === 'inductive' };
  if (Object.entries(g.declarations).some(([id, d]) => !g.nodes[id] || !labels[d?.kind]?.(g.nodes[id]))) problems.push('probe labels disagree with graph nodes');
  if (canonical(sorted(implied.map(canonical))) !== canonical(sorted(g.edges.map(canonical)))) problems.push('graph edges disagree with its lanes');
  return problems;
}

// The plan's relations, recomputed from dependsOn, and every field the
// registry relies on. Returns { problems, roots, union, consumers }.
export function validatePlan(plan, graph) {
  const p = plan.json;
  const g = graph.json;
  const problems = [];
  const bad = (message) => problems.push(message);
  if (!isObject(p) || p.schema !== PLAN_SCHEMA || p.version !== 1) return { problems: ['not a fvs-closure-plan/record version 1'] };
  if (!isObject(g) || g.schema !== 'fvs/lean-graph' || g.schemaVersion !== 2 || !isObject(g.nodes) || !isObject(g.binding)) return { problems: ['the graph is not a schema 2 fvs/lean-graph record'] };
  problems.push(...graphProblems(g));
  if (p.qualification?.graphSchemaVersion !== 2 || p.qualification?.graphCapability !== 'oracle-lanes') bad('the plan was not made from a schema 2 oracle-lanes graph');
  if (p.qualification?.graphFidelity !== 'verified') bad('the plan\'s graph fidelity is not verified');
  if (!['ready', 'partial'].includes(p.status)) bad(`the plan is ${p.status}`);
  if (p.admissibility?.status !== 'admissible' || !Array.isArray(p.admissibility?.blockers) || p.admissibility.blockers.length > 0) bad('the plan is not admissible without blockers');
  if (!isSha(p.inputs?.identitySha256) || !isSha(p.inputs?.graphSha256)) bad('the plan\'s input hashes are malformed');
  if (graph.sha256 !== p.inputs?.graphSha256) bad('the graph is not the plan\'s graph');
  if (!isObject(p.nodes)) return { problems: [...problems, 'the plan has no nodes'] };
  const nodes = new Map();
  for (const [key, node] of Object.entries(p.nodes)) {
    if (!isObject(node) || !Number.isSafeInteger(node.defId) || node.defId < 0 || String(node.defId) !== key || !idList(node.dependsOn) || !textList(node.declarations) || !node.declarations.length
      || !isText(node.rustName) || !isText(node.eligibility) || !idList(node.sharedBy)) bad(`node ${key} is malformed`);
    else nodes.set(node.defId, node);
  }
  for (const node of nodes.values()) if (node.dependsOn.some((id) => !nodes.has(id))) bad(`node ${node.defId} depends on an unknown node`);
  const requested = p.selection?.requestedRoots;
  if (!idList(requested) || requested.length === 0 || requested.some((id) => !nodes.has(id))) bad('the plan selects no known roots');
  if (!Array.isArray(p.roots) || JSON.stringify(sorted(p.roots.map((r) => r?.defId))) !== JSON.stringify(sorted(requested ?? []))) bad('the plan\'s roots are not its selection');
  if (!idList(p.selection?.failed) || p.selection.failed.some((id) => !nodes.has(id))) bad('the plan has malformed failed-node seeds');
  const claimed = new Map();
  for (const node of nodes.values()) for (const member of node.declarations) {
    if (g.nodes[member]?.probeAtom !== true) bad(`node ${node.defId}'s family member ${member} is not a probe atom of the graph`);
    if (claimed.has(member)) bad(`${member} is claimed by nodes ${claimed.get(member)} and ${node.defId}`);
    claimed.set(member, node.defId);
  }
  if (problems.length > 0) return { problems };
  const expanded = new Map([...nodes].map(([id, node]) => [id, { ...node, reasons: [] }]));
  const scheduling = expandSchedulingDependencies(g, expanded, p.selection.failed);
  for (const [id, node] of nodes) {
    const actual = expanded.get(id);
    if (canonical(sorted(node.dependsOn)) !== canonical(sorted(actual.dependsOn))) bad(`node ${id}'s dependsOn disagrees with the bound graph's scheduling expansion`);
    if (node.eligibility === 'eligible' && actual.eligibility !== 'eligible') bad(`node ${id} is eligible despite graph/failure expansion: ${actual.eligibility}`);
    if ((node.eligibility === 'failed') !== p.selection.failed.includes(id)) bad(`node ${id}'s failed state disagrees with the failed-node seeds`);
  }
  const closureOf = (start) => new Set(scheduling.closureOf(start));
  const roots = new Map(requested.map((id) => [id, closureOf(id)]));
  for (const root of p.roots) {
    if (!['ready', 'blocked'].includes(root.status) || !idList(root.closure)) { bad(`root ${root.defId} is malformed`); continue; }
    if (JSON.stringify(sorted(root.closure ?? [])) !== JSON.stringify(sorted(roots.get(root.defId)))) bad(`root ${root.defId}'s closure is not its dependsOn closure`);
    const eligible = [...roots.get(root.defId)].every((id) => nodes.get(id).eligibility === 'eligible');
    if (root.status === 'ready' && !eligible) bad(`root ${root.defId} is ready with a non-eligible node in its closure`);
    if (root.status === 'blocked' && eligible) bad(`root ${root.defId} is blocked with only eligible nodes`);
  }
  if (p.status === 'ready' && p.roots.some((r) => r.status !== 'ready')) bad('ready plan has a blocked root');
  if (p.status === 'partial' && p.roots.every((r) => r.status === 'ready')) bad('partial plan has only ready roots');
  for (const node of nodes.values()) {
    const sharedBy = sorted(requested.filter((root) => roots.get(root).has(node.defId)));
    if (JSON.stringify(sorted(node.sharedBy ?? [])) !== JSON.stringify(sharedBy)) bad(`node ${node.defId}'s sharedBy is not the roots that reach it`);
    if ((node.ownerRoot ?? null) !== (sharedBy.length > 0 ? Math.min(...sharedBy) : null)) bad(`node ${node.defId}'s ownerRoot is not the lowest root that reaches it`);
  }
  const union = new Set([...roots.values()].flatMap((closure) => [...closure]));
  const consumers = new Map([...nodes.keys()].map((id) => [id, []]));
  for (const node of nodes.values()) for (const dep of node.dependsOn) consumers.get(dep).push(node.defId);
  return { problems, roots, union, nodes, consumers };
}

const roleOf = (view, defId) => (view.roots.has(defId) ? 'root' : view.union.has(defId) ? 'helper' : 'out-of-scope');

function transitiveConsumers(view, defId) {
  const seen = new Set();
  const queue = [...(view.consumers.get(defId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(view.consumers.get(id) ?? []));
  }
  seen.delete(defId);
  return seen;
}

// A node's context: family, own implementation closure and the content
// fingerprint of the published Lean, with the plan it belongs to.
export function contextOf(plan, graph, view, defId) {
  const node = view.nodes.get(defId);
  return {
    defId,
    rustName: node.rustName,
    family: sorted(node.declarations),
    role: roleOf(view, defId),
    plan: { sha256: plan.sha256, identitySha256: plan.json.inputs.identitySha256, graphSha256: plan.json.inputs.graphSha256 },
    generatedLean: sorted((graph.json.binding.generatedLean ?? []).map((entry) => `${entry?.projectPath}\u0000${entry?.sha256}`)),
    implementationClosure: definitionClosure(graph.json, node.declarations),
  };
}

// ---- contracts and reviews ------------------------------------------------------

// The sha256 of a spec-definition file's bytes, read inside the spec root, or null.
export function specFileHash(specRoot, file) {
  if (!isText(file) || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) return null;
  let root;
  let real;
  try {
    root = fs.realpathSync(specRoot);
    real = fs.realpathSync(path.join(root, file));
  } catch {
    return null;
  }
  try {
    if (!real.startsWith(`${root}${path.sep}`) || !fs.statSync(real).isFile()) return null;
    return sha256(fs.readFileSync(real));
  } catch { return null; }
}

const personValid = (person) => isObject(person) && ['session', 'harness', 'model', 'runId'].every((key) => isText(person[key]));
const groundingValid = (g) => isObject(g) && ((g.kind === 'source' && ['source', 'version', 'locator'].every((key) => isText(g[key])))
  || (g.kind === 'none' && isText(g.reason)));
const provenanceValid = (p) => isObject(p) && ((isObject(p.environment) && isText(p.environment.leanToolchain) && isSha(p.environment.lakeManifestSha256))
  || ['source', 'version', 'locator'].every((key) => isText(p[key])));

// The contract checked against its node's context. Returns problems.
export function contractProblems(contract, context, specRoot) {
  const c = contract;
  const problems = [];
  if (!isObject(c) || c.node !== context.defId) return [`the contract is not for node ${context.defId}`];
  if (c.role !== context.role) problems.push(`the contract declares role ${c.role}; the plan gives ${context.role}`);
  if (!isText(c.statement)) problems.push('the contract has no statement');
  if (!Array.isArray(c.assumptions) || c.assumptions.some((a) => !isText(a))) problems.push('the contract has no assumptions list');
  if (!groundingValid(c.grounding)) problems.push('the grounding is neither a source with version and locator nor none with a reason');
  if (!personValid(c.author)) problems.push('the author is not { session, harness, model, runId }');
  if (!textList(c.implementationDependencies)) problems.push('implementationDependencies is not a list of distinct ids');
  else {
    const outside = c.implementationDependencies.filter((id) => !context.implementationClosure.includes(id));
    if (outside.length > 0) problems.push(`implementation dependencies outside the node's closure: ${sorted(outside).join(', ')}`);
  }
  if (!Array.isArray(c.specDefinitions) || c.specDefinitions.some((d) => !isObject(d) || !isText(d.name) || !isText(d.file) || !isSha(d.sha256))
    || new Set(c.specDefinitions.map((d) => d?.name)).size !== (c.specDefinitions?.length ?? 0)) problems.push('specDefinitions is not a list of distinct { name, file, sha256 }');
  else {
    for (const d of c.specDefinitions) {
      const actual = specFileHash(specRoot, d.file);
      if (actual === null) problems.push(`spec definition ${d.name}: ${d.file} is not a file inside the spec root`);
      else if (actual !== d.sha256) problems.push(`spec definition ${d.name}: ${d.file} does not hash to the declared sha256`);
    }
  }
  if (!Array.isArray(c.externalReferences) || c.externalReferences.some((r) => !isObject(r) || !isText(r.name) || !provenanceValid(r.provenance))
    || new Set(c.externalReferences.map((r) => r?.name)).size !== (c.externalReferences?.length ?? 0)) problems.push('externalReferences is not a list of distinct { name, provenance }');
  return problems;
}

// The semantic candidate a review is for: everything that gives the contract its meaning.
export function candidateOf(contract, context) {
  return sha256(canonical({
    binding: { defId: context.defId, rustName: context.rustName, family: context.family, role: context.role, plan: { identitySha256: context.plan.identitySha256, graphSha256: context.plan.graphSha256 }, generatedLean: context.generatedLean },
    statement: contract.statement,
    assumptions: contract.assumptions,
    grounding: contract.grounding,
    implementationDependencies: sorted(contract.implementationDependencies),
    specDefinitions: sorted(contract.specDefinitions.map((d) => `${d.name}\u0000${d.file}\u0000${d.sha256}`)),
    externalReferences: contract.externalReferences.map((r) => ({ name: r.name, provenance: r.provenance })).sort((a, b) => (a.name < b.name ? -1 : 1)),
  }));
}

function reviewProblems(review, reviewFile, contract, candidate, chain) {
  const r = review;
  if (!isObject(r) || !isSha(r.candidateSha256) || !Object.hasOwn(r, 'registryHeadSha256') || !(r.registryHeadSha256 === null || isSha(r.registryHeadSha256))
    || !['pass', 'changes-requested'].includes(r.verdict) || !personValid(r.reviewer) || !isObject(r.evidence) || !isText(r.evidence.file) || !isSha(r.evidence.sha256)) {
    return ['the review is not { candidateSha256, registryHeadSha256, verdict, reviewer, evidence: { file, sha256 } }'];
  }
  const problems = [];
  if (r.candidateSha256 !== candidate) problems.push('the review is for another candidate');
  // A conservative review basis: any intervening append, even an unrelated one,
  // requires a new review packet. This is context binding, not attestation.
  if (r.registryHeadSha256 !== (chain.records.at(-1)?.sha ?? null)) problems.push('the review registry head is stale; prepare a review against the current registry context');
  if (r.reviewer.session === contract.author?.session || r.reviewer.runId === contract.author?.runId) problems.push('the reviewer\'s session or run is the author\'s (independence is declared by distinct session and run)');
  const evidence = path.resolve(path.dirname(path.resolve(reviewFile)), r.evidence.file);
  let actual = null;
  try {
    actual = sha256(fs.readFileSync(evidence));
  } catch {
    actual = null;
  }
  if (actual !== r.evidence.sha256) problems.push('the review evidence does not hash to its declared sha256');
  for (const { record } of chain.records) {
    if (record.review && (record.review.reviewer.runId === r.reviewer.runId || record.review.evidence.sha256 === r.evidence.sha256) && record.candidateSha256 !== candidate) {
      problems.push(`the review's run or evidence was already used for another candidate (record ${record.seq})`);
      break;
    }
  }
  return problems;
}

// ---- the record chain ------------------------------------------------------------

// The registry's records, verified as one chain. A leftover lock or temporary
// file means a commit may be in progress or was interrupted: pending.
export function readChain(registry, { ignoreLock = false } = {}) {
  const records = path.join(registry, 'records');
  if (!fs.existsSync(registry)) return { records: [], heads: new Map(), pending: false };
  if (!ignoreLock && fs.existsSync(path.join(registry, 'lock'))) return { pending: 'a commit lock is present' };
  if (fs.readdirSync(registry).some((name) => name.startsWith('.tmp-'))) return { pending: 'an unpublished temporary record is present' };
  const names = fs.existsSync(records) ? fs.readdirSync(records).sort() : [];
  const chain = { records: [], heads: new Map(), pending: false };
  let prev = null;
  for (const [index, name] of names.entries()) {
    const match = RECORD_NAME.exec(name);
    if (!match) refuse('corrupt', `records/${name} is not a record file`);
    const bytes = fs.readFileSync(path.join(records, name));
    let record;
    try {
      record = JSON.parse(bytes.toString('utf8'));
    } catch {
      refuse('corrupt', `records/${name} is not complete JSON`);
    }
    if (sha256(bytes) !== match[2] || Number(match[1]) !== index || record?.schema !== RECORD_SCHEMA || record.version !== 1 || record.seq !== index || record.prev !== prev
      || !Number.isSafeInteger(record.defId) || !isObject(record.contract) || !isObject(record.binding) || !isSha(record.candidateSha256)
      || !Object.hasOwn(RANK, record.state) || !Array.isArray(record.invalidates)
      || record.invalidates.some((e) => !isObject(e) || !Number.isSafeInteger(e.defId) || !Object.hasOwn(RANK, e.effect))
      || !(record.review === null || (personValid(record.review?.reviewer) && isSha(record.review?.evidence?.sha256)
        && Object.hasOwn(record.review, 'registryHeadSha256') && record.review.registryHeadSha256 === record.prev))) {
      refuse('corrupt', `records/${name} breaks the chain (hash, sequence or previous record)`);
    }
    const head = chain.heads.get(record.defId);
    if (record.previousForNode !== (head?.sha ?? null)) refuse('corrupt', `records/${name} does not follow node ${record.defId}'s previous record`);
    chain.records.push({ record, sha: match[2] });
    chain.heads.set(record.defId, { record, sha: match[2] });
    prev = match[2];
  }
  if (!ignoreLock && fs.existsSync(path.join(registry, 'lock'))) return { pending: 'a commit lock appeared during the read' };
  return chain;
}

function effectiveState(chain, head) {
  let state = head.record.state;
  for (const { record } of chain.records) if (record.seq > head.record.seq) {
    const effect = record.invalidates.find((entry) => entry.defId === head.record.defId)?.effect;
    if (effect) state = moreSevere(state, effect);
  }
  return state;
}

// Publishes one record: under an exclusive lock, check the expected head, write
// the complete record to a temporary file, fsync it, rename it into records/
// (the single commit point) and fsync the directory.
function commit(registry, build) {
  fs.mkdirSync(path.join(registry, 'records'), { recursive: true });
  const lock = path.join(registry, 'lock');
  let writing = false;
  let completed = false;
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (error.code === 'EEXIST') refuse('busy', 'another commit holds the registry lock (or a commit was interrupted)');
    throw error;
  }
  try {
    const chain = readChain(registry, { ignoreLock: true });
    if (chain.pending) refuse('pending', `the registry is pending: ${chain.pending}`);
    const record = build(chain);
    const last = chain.records.at(-1);
    Object.assign(record, { seq: chain.records.length, prev: last?.sha ?? null });
    const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
    const recordSha = sha256(bytes);
    const temporary = path.join(registry, `.tmp-${process.pid}-${recordSha.slice(0, 12)}`);
    const fd = fs.openSync(temporary, 'wx');
    writing = true;
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, path.join(registry, 'records', `${String(record.seq).padStart(6, '0')}-${recordSha}.json`));
    const dir = fs.openSync(path.join(registry, 'records'), 'r');
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
    completed = true;
    return { record, sha256: recordSha };
  } finally {
    if (!writing || completed) fs.rmdirSync(lock);
  }
}

// ---- register, revise, status ------------------------------------------------------

function inputs(flags) {
  const plan = readJson(flags.plan, 'plan');
  const graph = readJson(flags.graph, 'graph');
  const view = validatePlan(plan, graph);
  return { plan, graph, view };
}

function record(flags, event) {
  const { plan, graph, view } = inputs(flags);
  if (view.problems.length > 0) refuse('refused', `the plan is not consistent: ${view.problems.join('; ')}`, { problems: view.problems });
  const contract = readJson(flags.contract, 'contract').json;
  const review = flags.review ? readJson(flags.review, 'review').json : null;
  const defId = contract?.node;
  if (!view.nodes.has(defId)) refuse('refused', `node ${defId} is not in the plan`);
  if (view.nodes.get(defId).eligibility !== 'eligible') refuse('refused', `node ${defId} is ${view.nodes.get(defId).eligibility}: unsupported`);
  const context = contextOf(plan, graph, view, defId);
  if (context.role === 'out-of-scope') refuse('refused', `node ${defId} is outside the selected roots' closures`);
  const problems = contractProblems(contract, context, flags['spec-root']);
  if (problems.length > 0) refuse('refused', `the contract is refused: ${problems.join('; ')}`, { problems });
  const candidate = candidateOf(contract, context);
  const committed = commit(flags.registry, (chain) => {
    const head = chain.heads.get(defId);
    if (event === 'register' && head) refuse('refused', `node ${defId} already has a contract; revise its head ${head.sha}`);
    if (event === 'revise' && (!head || head.sha !== flags.previous)) refuse('refused', `the previous record is not node ${defId}'s current head`);
    const reviewed = review === null ? [] : reviewProblems(review, flags.review, contract, candidate, chain);
    if (reviewed.length > 0) refuse('refused', `the review is refused: ${reviewed.join('; ')}`, { problems: reviewed });
    const changeClass = event === 'register' ? 'first' : head.record.candidateSha256 === candidate ? 'unchanged-semantic-inputs' : 'semantic';
    const priorState = head ? effectiveState(chain, head) : null;
    const reviewPending = ['needs-review', 'needs-semantic-review', 'changes-requested'].includes(priorState);
    if (reviewPending && review && chain.records.some(({ record: r }) => r.review
      && (r.review.reviewer.runId === review.reviewer.runId || r.review.evidence.sha256 === review.evidence.sha256))) {
      refuse('refused', 'unresolved semantic review requires a fresh reviewer run and evidence');
    }
    const state = review?.verdict === 'changes-requested' ? 'changes-requested' : changeClass === 'unchanged-semantic-inputs'
      ? (review === null && reviewPending ? priorState : 'recheck-required')
      : review === null ? (event === 'register' ? 'needs-review' : 'needs-semantic-review') : 'machine-reviewed-provisional';
    // Invalidation, kept at its most severe per node.
    const effects = new Map();
    const raise = (id, effect) => effects.set(id, moreSevere(effects.get(id), effect));
    raise(defId, 'recheck-required');
    for (const id of transitiveConsumers(view, defId)) raise(id, 'recheck-required');
    if (changeClass !== 'unchanged-semantic-inputs') {
      const changedSpecs = new Map(contract.specDefinitions.map((d) => [d.name, d.sha256]));
      for (const [other, otherHead] of chain.heads) {
        if (other === defId) continue;
        const c = otherHead.record.contract;
        const sharesImplementation = c.implementationDependencies.some((id) => context.family.includes(id));
        const sharesChangedSpec = c.specDefinitions.some((d) => (changedSpecs.has(d.name) && changedSpecs.get(d.name) !== d.sha256)
          || contract.specDefinitions.some((next) => next.file === d.file && next.sha256 !== d.sha256));
        if (sharesImplementation || sharesChangedSpec) {
          raise(other, 'needs-semantic-review');
          if (view.nodes.has(other)) for (const id of transitiveConsumers(view, other)) raise(id, 'recheck-required');
        }
      }
    }
    return {
      schema: RECORD_SCHEMA,
      version: 1,
      seq: null,
      prev: null,
      previousForNode: head?.sha ?? null,
      event,
      defId,
      binding: context,
      contract,
      candidateSha256: candidate,
      review: review === null ? null : { ...review, evidence: { ...review.evidence, file: path.resolve(path.dirname(path.resolve(flags.review)), review.evidence.file) } },
      independence: review === null ? null : { basis: 'declared-distinct-session-and-run', verified: false },
      changeClass,
      state,
      blocked: context.role === 'root' && state === 'changes-requested',
      invalidates: sorted([...effects.keys()]).map((id) => ({ defId: id, effect: effects.get(id) })),
      durability: 'process-crash-consistent',
    };
  });
  const r = committed.record;
  return { code: r.state === 'machine-reviewed-provisional' ? 'ok' : 'recorded', message: `node ${defId}: ${r.state} (record ${r.seq}, ${r.changeClass})`, record: r, recordSha256: committed.sha256 };
}

function status(flags) {
  const { plan, graph, view } = inputs(flags);
  const chain = readChain(flags.registry);
  if (chain.pending) return { code: 'pending', message: `the registry is pending: ${chain.pending}; no state is current`, nodes: {} };
  const consistent = view.problems.length === 0;
  const nodes = {};
  for (const [defId, head] of chain.heads) {
    let state = effectiveState(chain, head);
    const reasons = [];
    if (!consistent) {
      state = 'stale';
      reasons.push('the current plan is not consistent');
    } else if (!view.nodes.has(defId)) {
      state = 'stale';
      reasons.push('the node is not in the current plan');
    } else {
      const now = contextOf(plan, graph, view, defId);
      const was = head.record.binding;
      if (view.nodes.get(defId).eligibility !== 'eligible' || now.role === 'out-of-scope' || now.rustName !== was.rustName
        || now.plan.identitySha256 !== was.plan.identitySha256 || now.plan.graphSha256 !== was.plan.graphSha256 || JSON.stringify(now.family) !== JSON.stringify(was.family)
        || JSON.stringify(now.generatedLean) !== JSON.stringify(was.generatedLean) || JSON.stringify(now.implementationClosure) !== JSON.stringify(was.implementationClosure) || now.role !== was.role) {
        state = 'stale';
        reasons.push('the node\'s plan context changed');
      } else if (now.plan.sha256 !== was.plan.sha256 && candidateOf(head.record.contract, now) === head.record.candidateSha256) {
        state = moreSevere(state, 'recheck-required');
        reasons.push('unchanged semantic inputs under a new plan; recheck required');
      }
    }
    const changedSpecs = head.record.contract.specDefinitions.filter((d) => specFileHash(flags['spec-root'], d.file) !== d.sha256).map((d) => d.name);
    if (changedSpecs.length > 0) {
      state = moreSevere(state, 'needs-semantic-review');
      reasons.push(`spec definitions changed on disk: ${sorted(changedSpecs).join(', ')}`);
    }
    nodes[defId] = { state, blocked: head.record.blocked && state === 'changes-requested', head: head.sha, seq: head.record.seq, reasons, changedSpecs };
  }
  // A changed spec file also sends the consumers of every affected node to a recheck.
  if (consistent) {
    for (const [defId, entry] of Object.entries(nodes)) {
      if (entry.changedSpecs.length === 0) continue;
      for (const id of transitiveConsumers(view, Number(defId))) if (nodes[id]) nodes[id].state = moreSevere(nodes[id].state, 'recheck-required');
    }
  }
  for (const entry of Object.values(nodes)) delete entry.changedSpecs;
  return { code: 'ok', message: consistent ? 'registry status' : `registry status against an inconsistent plan: ${view.problems.join('; ')}`,
    registryHeadSha256: chain.records.at(-1)?.sha ?? null, consistent, nodes };
}

const COMMANDS = {
  register: { required: ['plan', 'graph', 'registry', 'spec-root', 'contract'], run: (flags) => record(flags, 'register') },
  revise: { required: ['plan', 'graph', 'registry', 'spec-root', 'contract', 'previous'], run: (flags) => record(flags, 'revise') },
  status: { required: ['plan', 'graph', 'registry', 'spec-root'], run: status },
};

function parseFlags(argv, required) {
  const flags = {};
  const rest = [...argv];
  while (rest.length > 0) {
    const flag = rest.shift();
    const key = flag.replace(/^--/, '');
    if (![...required, 'review'].includes(key) || key === flag || Object.hasOwn(flags, key)) refuse('usage', `unknown or repeated argument ${JSON.stringify(flag)}`);
    const value = rest.shift();
    if (!value || value.startsWith('--')) refuse('usage', `${flag} requires a value`);
    flags[key] = value;
  }
  for (const key of required) if (!flags[key]) refuse('usage', `--${key} is required`);
  return flags;
}

function main(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    usage();
    return;
  }
  let result;
  try {
    if (!Object.hasOwn(COMMANDS, argv[0])) refuse('usage', `unknown command ${JSON.stringify(argv[0])}`);
    const command = COMMANDS[argv[0]];
    result = { ok: true, command: argv[0], ...command.run(parseFlags(argv.slice(1), command.required)) };
  } catch (error) {
    result = error instanceof Refusal ? { ok: false, code: error.code, command: argv[0], message: error.message, ...error.details } : { ok: false, code: 'internal', command: argv[0], message: error.message };
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.stderr.write(`FVS >> ${result.code}: ${result.message}\n`);
  process.exitCode = EXIT[result.code] ?? 2;
}

function invokedDirectly() {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) main(process.argv.slice(2));
