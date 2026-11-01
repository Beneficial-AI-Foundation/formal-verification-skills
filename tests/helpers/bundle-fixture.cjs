// Protocol fixtures only. No fake object here is a canonical proof receipt.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const memory = require('./memory-fixture.cjs');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const ref = file => ({ file, sha256: sha(fs.readFileSync(file)) });
const uuid = () => crypto.randomUUID();
const write = (root, name, value) => { const file = path.join(root, name + '-' + uuid() + '.json'); fs.writeFileSync(file, JSON.stringify(value)); return ref(file); };
function fixture(auto, parent = fs.realpathSync(os.tmpdir()), existing = null) {
  const owned = fs.mkdtempSync(path.join(parent, 'fvs-bundle-fixture-'));
  const root = existing ?? memory.createProject(auto, owned);
  const gitDir = fs.realpathSync(path.resolve(root, memory.git(root, 'rev-parse', '--git-common-dir')));
  fs.appendFileSync(path.join(gitDir, 'info/exclude'), '\n.formalising/\n');
  fs.writeFileSync(path.join(root, 'Defs.lean'), 'def Shared := Nat\n');
  memory.git(root, 'add', '--', 'Defs.lean'); memory.git(root, 'commit', '-qm', 'test(fixture): retain review definitions');
  const extraction = write(owned, 'identity', { authority: 'protocol-fixture-only; no extraction/proof claim' });
  const graph = ref(path.join(memory.ROOT, 'tests/fixtures/auto-contract-registry/graph.json'));
  const planData = JSON.parse(fs.readFileSync(path.join(memory.ROOT, 'tests/fixtures/auto-contract-registry/plan.json')));
  planData.inputs.identitySha256 = extraction.sha256;
  const x = { owned, root, graph, extraction, planData, registry: path.join(owned, 'registry'), auto };
  fs.mkdirSync(x.registry);
  x.request = (patch = {}) => {
    const view = auto.readState({ projectRoot: root, requireAgreement: true });
    const agreement = { state: ref(memory.stateFile(root)), roadmap: ref(memory.roadmapFile(root)), contextSha256: view.agreement.contextSha256,
      choicesGeneration: view.state.choicesGeneration, approvedPayloadSha256: view.agreement.agreement.approvedPayloadSha256 };
    const plan = write(owned, 'plan', x.planData), scopeInventory = write(owned, 'scope', {
      schema: 'fvs/auto-bundle-scope-inventory', schemaVersion: 1, agreement, plan,
      requestedRoots: x.planData.selection.requestedRoots, failed: x.planData.selection.failed,
      applicability: [{ scopeItemId: 'fixture-scope', roots: x.planData.selection.requestedRoots, disposition: 'mapped', reason: null, evidence: [agreement.roadmap] }],
    });
    return { schema: 'fvs/auto-bundle-request', schemaVersion: 1, bundleId: uuid(), projectRoot: root,
      source: { kind: 'git', root, commit: memory.git(root, 'rev-parse', 'HEAD'), expectedTree: memory.git(root, 'rev-parse', 'HEAD^{tree}') },
      agreement, extraction, graph, plan, scopeInventory, registry: { root: x.registry, expectedHeadSha256: null },
      baseline: null, acceptedStore: null, runtime: null, handoff: null,
      absenceReasons: { baseline: 'not-frozen', acceptedStore: 'no canonical proof in this protocol fixture', runtime: 'not-started', handoff: 'not-dispatched' }, deadlineMs: Date.now() + 120000, ...patch };
  };
  x.out = prefix => path.join(owned, prefix + '-' + uuid());
  x.register = async (q, node = 19, patch = {}) => {
    const api = await import('../../scripts/fvs-contract-registry.mjs');
    const wrapped = r => ({ json: JSON.parse(fs.readFileSync(r.file)), sha256: r.sha256 });
    const plan = wrapped(q.plan), graph = wrapped(q.graph), view = api.validatePlan(plan, graph);
    if (view.problems.length) throw Error(view.problems.join(';'));
    const contract = { node, role: node === 19 ? 'helper' : 'root', statement: 'm1demo.helper = m1demo.helper', assumptions: [],
      grounding: { kind: 'none', reason: 'protocol fixture; no correspondence asserted' }, implementationDependencies: ['probe:' + (node === 19 ? 'm1demo.helper' : node === 20 ? 'm1demo.root_sum' : 'm1demo.root_twice')],
      specDefinitions: [{ name: 'Shared', file: 'Defs.lean', sha256: ref(path.join(root, 'Defs.lean')).sha256 }],
      externalReferences: [{ name: 'Eq', provenance: { environment: { leanToolchain: 'leanprover/lean4:v4.31.0', lakeManifestSha256: 'a'.repeat(64) } } }],
      author: { session: 'fixture-author', harness: 'fixture', model: 'none', runId: uuid() }, ...patch };
    const candidate = api.candidateOf(contract, api.contextOf(plan, graph, view, node));
    const reviews = path.join(owned, 'review-inputs'); fs.mkdirSync(reviews, { recursive: true });
    const evidence = path.join(reviews, 'review-' + uuid() + (x.reviewEvidenceSuffix ?? '.md')); fs.writeFileSync(evidence, 'Declared protocol review; no provider/model execution.');
    const review = { candidateSha256: candidate, registryHeadSha256: api.readChain(x.registry).records.at(-1)?.sha ?? null, verdict: 'pass',
      reviewer: { session: 'fixture-reviewer', harness: 'fixture', model: 'none', runId: uuid() }, evidence: ref(evidence) };
    const c = write(owned, 'contract', contract), r = write(owned, 'review', review);
    const result = spawnSync(process.execPath, [path.join(memory.ROOT, 'scripts/fvs-contract-registry.mjs'), 'register', '--plan', q.plan.file, '--graph', q.graph.file, '--registry', x.registry, '--spec-root', root, '--contract', c.file, '--review', r.file], { encoding: 'utf8' });
    if (result.status !== 0) throw Error(result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  return x;
}
module.exports = { ...memory, fixture, sha, ref, write, uuid };
