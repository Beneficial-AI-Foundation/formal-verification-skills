// Real-root world for the two-revision re-specification scenario (ticket18 D). Real Git and Beads on the reused C0
// fixture; Lean-heavy freeze/check/accept run only in the opt-in real test. The AO lifecycle is the labelled protocol
// double of the shared driver fixture: it carries no model, provider or proof authority.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { world } = require('./auto-driver-fixture.cjs');

const GIT_ENV = { PATH: '/usr/bin:/bin', LANG: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function git(cwd, ...args) {
  const p = spawnSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV });
  if (p.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + p.stderr);
  return p.stdout.trim();
}

// Mirrors the reviewed Phase C preparation p1-p3: exact C0 primary on fixture/ticket15, clean linked source worktree
// at C0 with the dependency packages cloned (APFS clone, made writable for lake), v2 state with a real Beads store and
// an agreement with an execution grant, and an owned copy of the registry G0 chain.
function prepareRealRoot({ base, materials, bd, scope, grantReference }) {
  for (const p of [base, materials.c0.root, materials.registry.root, bd]) if (!path.isAbsolute(p)) throw new Error('absolute paths required');
  const root = path.join(base, 'fixture'), source = path.join(base, 'source'), registry = path.join(base, 'registry'), bdHome = path.join(base, 'bd-home');
  git(base, 'clone', '-q', '--no-hardlinks', materials.c0.root, root);
  if (git(root, 'rev-parse', 'HEAD') !== materials.c0.commit || git(root, 'rev-parse', 'HEAD^{tree}') !== materials.c0.tree) throw new Error('C0 identity mismatch');
  git(root, 'remote', 'remove', 'origin');
  if (spawnSync('/usr/bin/git', ['-C', root, 'symbolic-ref', '-q', 'HEAD'], { env: GIT_ENV }).status !== 0) git(root, 'checkout', '-q', '-b', 'fixture/ticket15', materials.c0.commit);
  fs.appendFileSync(path.join(root, '.git/info/exclude'), '\n.beads/\n');
  git(root, 'worktree', 'add', '-q', '-b', 'fvs-d-source', source, materials.c0.commit);
  fs.mkdirSync(path.join(source, '.lake'));
  for (const [cmd, args] of [['/bin/cp', ['-c', '-R', '-p', path.join(materials.c0.root, '.lake/packages'), path.join(source, '.lake/packages')]], ['/bin/chmod', ['-R', 'u+w', path.join(source, '.lake/packages')]]]) {
    if (spawnSync(cmd, args).status !== 0) throw new Error(cmd + ' failed for source packages');
  }
  if (git(source, 'status', '--porcelain=v1', '--untracked-files=all') !== '' || git(source, 'rev-parse', 'HEAD^{tree}') !== materials.c0.tree) throw new Error('source not exact clean C0');
  fs.mkdirSync(bdHome);
  const bdRun = args => { const p = spawnSync(bd, args, { cwd: root, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: bdHome, LANG: 'C' } }); if (p.status !== 0) throw new Error('bd ' + args.join(' ') + ': ' + p.stderr); return p.stdout; };
  bdRun(['--sandbox', 'init', '--backend', 'dolt', '--skip-agents', '--skip-hooks', '--non-interactive', '--prefix', 'fvs-d']);
  const where = JSON.parse(bdRun(['-C', root, '--sandbox', '--readonly', 'where', '--json']));
  fs.cpSync(path.join(materials.registry.root, 'records'), path.join(registry, 'records'), { recursive: true, preserveTimestamps: true });
  return { root, source, registry, bdHome, where, scope, grantReference, c0: materials.c0 };
}

// v2 state, agreement and real Beads registration through the engine's own validating writers (after the engine is
// imported by the caller's world). Primary only: the source worktree keeps C0's tracked version1 bytes.
function recordSetup(auto, r, bd) {
  const v1 = JSON.parse(git(r.root, 'show', r.c0.commit + ':.formalising/auto-fv/state.json'));
  const choices = { source: { revision: 'HEAD', configuration: 'ticket18 D fixture C0' }, scope: r.scope, limits: { workers: 3 }, budget: { kind: 'none' }, memory: { mode: 'beads' } };
  fs.writeFileSync(path.join(r.root, '.formalising/auto-fv/state.json'), JSON.stringify({ schema: 'fvs/auto-state', schemaVersion: 2, profiledAt: v1.profiledAt, profile: v1.profile, choices, roadmap: null, extraction: null }, null, 2) + '\n');
  const s = auto.readState({ projectRoot: r.root }).state;
  const a = { schema: 'fvs/auto-agreement', schemaVersion: 2, mode: 'nonpublic-intent',
    payload: { choicesGeneration: s.choicesGeneration ?? 0, choices: s.choices, contextVersion: 1, boundaries: [], conventions: ['ticket18 D qualification fixture'], layout: 'single-crate',
      claims: ['two-revision re-specification mechanics; no acceptance beyond independent checks'], trust: ['reused C0 fixture'], acceptance: ['independent checks'], ownerReserved: ['human final PR decision'],
      execution: { actions: ['ticket18 D delegated qualification work'], reference: r.grantReference }, draftPr: null },
    ownerEvidence: { reference: r.grantReference, response: 'Owner-authorized ticket18 D qualification fixture.' } };
  a.approvedPayloadSha256 = auto.agreementPayloadSha256(a);
  fs.writeFileSync(path.join(r.root, '.formalising/auto-fv/ROADMAP.md'), '## Goal\nTicket18 D qualification fixture.\n\n## Decisions\n```fvs-auto-agreement\n' + JSON.stringify(a) + '\n```\n');
  auto.recordAgreement({ projectRoot: r.root, agreement: a });
  auto.recordMemory({ projectRoot: r.root, registration: { backend: 'beads', canonicalRoot: r.root, storeDir: path.join(r.root, '.beads'), databasePath: r.where.database_path, bdPath: bd } });
}

// The shared driver world over the prepared real root, with the real plan/graph inputs and the clean source worktree.
async function dWorld({ engineRoot, base, materials, bd, scope = 'ticket18 D two-revision scenario', grantReference = 'ticket18 D owner authorization' }) {
  const r = prepareRealRoot({ base, materials, bd, scope, grantReference });
  const auto = await import(require('node:url').pathToFileURL(path.join(engineRoot, 'scripts/fvs-auto.mjs')).href);
  recordSetup(auto, r, bd);
  // The controller's owned evidence (AO double, actions, completions, producer outputs) stays beside the real root.
  const w = await world(engineRoot, { schemaVersion: 2, memory: 'beads', root: r.root, parent: base });
  // A paired freeze binds the job's extraction identity to these exact inputs, so the real identity record replaces
  // the protocol world's metadata-only extraction placeholder.
  const pinned = m => { if (sha(fs.readFileSync(m.file)) !== m.sha256) throw new Error('pinned material changed: ' + m.file); return { file: m.file, sha256: m.sha256 }; };
  w.inputs.extraction = pinned(materials.extraction); w.inputs.plan = pinned(materials.plan); w.inputs.graph = pinned(materials.graph);
  w.useSource(r.source);
  // The exported Other packet records the reviewer selection; the stage profile must name the same effort.
  const profile = w.t.transitionBound(w.x.profile); profile.stages.spec_review.effort = 'xhigh'; w.x.profile = json(w.x.owned, 'profile-review', profile);
  const e = await import(require('node:url').pathToFileURL(path.join(engineRoot, 'scripts/fvs-execution.mjs')).href);
  const ca = await import(require('node:url').pathToFileURL(path.join(engineRoot, 'scripts/fvs-checker-auto.mjs')).href);
  return { ...w, real: r, git, engineRoot, e, ca };
}

// Name the scenario step in any refusal so retained evidence points at the exact transition.
async function step(label, run) { try { return await run(); } catch (error) { error.message = label + ': ' + error.message; throw error; } }
const json = (dir, name, value) => { const file = path.join(dir, name + '-' + crypto.randomUUID() + '.json'); fs.writeFileSync(file, JSON.stringify(value)); return { file, sha256: sha(fs.readFileSync(file)) }; };
const REVIEW_DOUBLE = '# FC Specification Review\n\n## Findings\nNone.\n\n## Content coverage statement\nScripted protocol reviewer double: no semantic review authority.\n\n'
  + '## Coverage\nDraft statement and its cited context only.\n\n## Evidence\nSpecs/Roots.lean:1.\n\nVERDICT: PASS\n';

// One contract revision through the shared driver: actual exported Other packet over git-ignored drafts in the clean
// source, pre-dispatch binding, labelled reviewer double, import, then the paired registry-revise on the run registry.
async function reviseContract(w, { contract, draft, cited }) {
  const { x, driver, real } = w, src = w.source().root, dir = path.join(src, '.formalising', 'd-review', contract.node + '-' + crypto.randomUUID().slice(0, 8));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Spec.lean'), draft);
  fs.writeFileSync(path.join(dir, 'inventory.json'), JSON.stringify({ version: 1, declarations: [], cited_apis: cited }));
  const rel = name => path.relative(src, path.join(dir, name));
  const request = json(x.owned, 'other-request', { spec: rel('Spec.lean'), context: [...new Set(cited.map(c => c.path))], runtime: 'other', model: 'fixture', effort: 'xhigh',
    author_runtime: 'unknown', grounding: rel('inventory.json') });
  const run = spawnSync(process.execPath, [path.join(w.engineRoot, 'scripts/fvs-spec-review.mjs'), 'run', request.file], { cwd: src, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  if (run.status !== 0) throw new Error('spec review export: ' + run.stderr);
  const reviewDir = path.join(src, run.stdout.match(/Review packet: (.+)/)[1]);
  const contractRef = json(x.owned, 'contract-' + contract.node, contract);
  const args = { projectRoot: x.root, source: w.source(), plan: w.inputs.plan, graph: w.inputs.graph, registry: real.registry, contract: contractRef,
    packet: { file: path.join(reviewDir, 'packet.json'), sha256: sha(fs.readFileSync(path.join(reviewDir, 'packet.json'))) },
    prompt: { file: path.join(reviewDir, 'prompt.md'), sha256: sha(fs.readFileSync(path.join(reviewDir, 'prompt.md'))) }, out: x.out() };
  const binding = driver.prepareReviewBinding(args), s = await w.releaseReview(binding), response = path.join(x.owned, 'response-' + crypto.randomUUID() + '.md');
  fs.writeFileSync(response, REVIEW_DOUBLE);
  const imported = await driver.importReviewedContract({ projectRoot: x.root, binding: binding.binding, workPacket: s.packet, marker: s.marker,
    response: json(x.owned, 'returned', { workPacket: s.packet, marker: s.marker, binding: binding.binding, response: { file: response, sha256: sha(fs.readFileSync(response)) }, reviewerInvocation: s.launch.action.transitionId }),
    session: json(x.owned, 'session', { session: { id: s.actor.sessionId, projectId: 'fixture-project', harness: 'fixture', isTerminated: false } }),
    settings: json(x.owned, 'settings', { options: [{ id: 'model', currentValue: 'fixture' }, { id: 'effort', currentValue: 'xhigh' }] }), out: x.out() });
  if (imported.status !== 'review-pass-candidate') throw new Error('review import: ' + imported.status);
  const completion = w.t.recordReviewWorkCompletion({ importEvidence: imported.evidence, contract: contractRef, review: imported.review, controllerSessionId: w.context().ao.coordinatorSessionId, out: x.out() }).completion;
  const closed = await closeAssignment(w, s.actor, completion);
  const input = w.t.transitionBound(binding.input), previous = registryStatus(w).nodes[String(contract.node)]?.head ?? null;
  const invocation = json(x.owned, 'registry-request', { schema: 'fvs/auto-registry-invocation', schemaVersion: 1, plan: w.inputs.plan, graph: w.inputs.graph,
    registry: real.registry, specRoot: src, contract: contractRef, review: imported.review, previous });
  const published = await step('registry-revise ' + contract.node, () => w.paired({ kind: 'registry-revise', stage: 'review', registryRoot: real.registry, target: { candidateSha256: input.candidateSha256, review: imported.review, request: invocation } }));
  return { contract: contractRef, binding, imported, published, previous, closed };
}
// Stop a finished assignment and close its reservation, as the reviewed Phase C steps did against actual AO: a paired
// terminate (stock `ao session kill`, here the labelled double) sealing the known work named by the handoff, then the
// recorded reservation resolution with the same handoff.
async function closeAssignment(w, actor, progress) {
  const { x, t } = w, association = w.context().associations.find(a => t.transitionBound(a).sessionId === actor.sessionId);
  if (!association) throw new Error('no retained association for ' + actor.sessionId);
  const target = operation => ({ sessionId: actor.sessionId, association, progress, operation });
  const stopped = await step('terminate ' + actor.sessionId, () => w.paired({ kind: 'terminate', stage: 'reconcile', sessionId: actor.sessionId, effect: { kind: 'local', operation: 'reconcile' }, target: target('terminate-session') }));
  if (stopped.raw?.session?.isTerminated !== true) throw new Error('AO does not report the actor terminated');
  const evidence = json(x.owned, 'owned-session-termination', { schema: 'fvs/auto-owned-session-termination', schemaVersion: 1, session: stopped.raw.session, progress, terminationCompletion: stopped.completion });
  const resolved = await step('resolve ' + actor.sessionId, () => w.paired({ kind: 'terminate', stage: 'reconcile', sessionId: actor.sessionId, execute: false, effect: { kind: 'reservation-resolution', targetReservationId: actor.reservationId },
    target: target('resolve-terminated-reservation'), after: () => ({ sessionId: null, association: null, evidence: [evidence], resolution: { reason: 'session-terminated', evidence } }) }));
  return { stopped, resolved };
}
// A run-bound auto freeze request from the pinned persistent template: the run's own execution control, the current
// registry head, the real extraction inputs and the clean source worktree with its owned dependency copy.
function freezeRequest(w, materials, { overlayFiles = [], targets = {}, libraries = null } = {}) {
  const t = materials.freezeTemplate, tpl = JSON.parse(fs.readFileSync(t.file));
  if (sha(fs.readFileSync(t.file)) !== t.sha256 || sha(fs.readFileSync(materials.rustLeanReceipt.file)) !== materials.rustLeanReceipt.sha256) throw new Error('pinned freeze material changed');
  const { deadlineMs, ...rest } = tpl, src = w.source();
  const job = { ...rest, version: 2, runId: 'd-freeze-' + crypto.randomUUID(), execution: w.e.runControl(w.x.run()),
    extraction: { ...tpl.extraction, rust: { ...tpl.extraction.rust, leanReceipt: { file: materials.rustLeanReceipt.file, sha256: materials.rustLeanReceipt.sha256 } } },
    registry: { root: w.real.registry, headSha256: registryStatus(w).registryHeadSha256 },
    baseline: { ...tpl.baseline, source: src, dependencies: { ...tpl.baseline.dependencies, root: path.join(src.root, '.lake/packages') }, ...(libraries ? { libraries } : {}) },
    targets: tpl.targets.map(target => targets[target.node] ?? target), overlayFiles };
  return json(w.x.owned, 'freeze-request', job);
}
// Engine admission of a paired freeze before, with no producer run: recording the before performs the transition's
// own target validation (source, registry head, extraction identity, run execution control). The world is then left
// with a pending before, so callers use a throwaway world.
class BeforeAdmitted extends Error {}
async function admitFreeze(w, request) {
  try { await w.paired({ kind: 'freeze', stage: 'check', registryRoot: w.real.registry, execute: false, target: { request }, after: () => { throw new BeforeAdmitted('before admitted'); } }); }
  catch (error) { if (error instanceof BeforeAdmitted) return true; throw error; }
  throw new Error('freeze before unexpectedly completed');
}
// E0 (real Lean, opt-in only): F0 freeze at pristine C0, one provisional check of H/A/B, then accept H before its
// consumers A and B. Every step is one paired transition through the shared driver; afters bind the produced baseline
// and the advanced accepted-store head, which the engine re-validates.
async function runE0(w, materials) {
  const storeRoot = path.join(path.dirname(w.real.root), 'store'), ca = w.ca;
  const storeHead = () => ({ root: storeRoot, expectedHeadSha256: ca.readAcceptedStore(storeRoot).headSha256 });
  w.inputs.acceptedStore = storeHead();
  const control = () => w.e.runControl(w.x.run()), receipts = {};
  receipts.freeze = await step('F0 freeze', () => w.paired({ kind: 'freeze', stage: 'check', registryRoot: w.real.registry, target: { request: freezeRequest(w, materials) },
    after: raw => { if (raw?.authority !== 'expectations-only' || !raw.baseline) throw new Error('freeze produced no expectations-only baseline'); w.inputs.baseline = raw.baseline; return { sessionId: null, association: null }; } }));
  const nodes = [19, 20, 21];
  const check = json(w.x.owned, 'check-request', { schema: 'fvs-checker/check-request', version: 2, purpose: 'auto', runId: 'd-check-' + crypto.randomUUID(), execution: control(), baseline: w.inputs.baseline, source: w.source(), nodes });
  receipts.check = await step('E0 check', () => w.paired({ kind: 'check', stage: 'check', nodes, registryRoot: w.real.registry, target: { request: check, nodes } }));
  if (receipts.check.raw?.status !== 'provisional' || !receipts.check.raw.evidence) throw new Error('E0 check is not provisional');
  receipts.accept = [];
  for (const node of nodes) {
    const accept = json(w.x.owned, 'accept-request-' + node, { schema: 'fvs-checker/accept-request', version: 2, purpose: 'auto', runId: 'd-accept-' + node + '-' + crypto.randomUUID(), execution: control(),
      baseline: w.inputs.baseline, candidateCheck: receipts.check.raw.evidence, source: w.source(), node, store: storeHead() });
    receipts.accept.push(await step('E0 accept ' + node, () => w.paired({ kind: 'accept', stage: 'acceptance', nodes: [node], registryRoot: w.real.registry, target: { request: accept, node },
      after: raw => { if (raw?.status !== 'accepted') throw new Error('accept ' + node + ' did not publish'); w.inputs.acceptedStore = storeHead(); return { sessionId: null, association: null }; } })));
  }
  return { storeRoot, receipts };
}
function registryStatus(w) {
  const p = spawnSync(process.execPath, [path.join(w.engineRoot, 'scripts/fvs-contract-registry.mjs'), 'status', '--plan', w.inputs.plan.file, '--graph', w.inputs.graph.file,
    '--registry', w.real.registry, '--spec-root', w.source().root], { encoding: 'utf8' });
  return JSON.parse(p.stdout);
}

module.exports = { prepareRealRoot, recordSetup, dWorld, reviseContract, closeAssignment, freezeRequest, admitFreeze, runE0, registryStatus, git, sha };
