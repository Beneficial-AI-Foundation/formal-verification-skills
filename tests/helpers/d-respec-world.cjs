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
  const reg = await import(require('node:url').pathToFileURL(path.join(engineRoot, 'scripts/fvs-contract-registry.mjs')).href);
  return { ...w, real: r, git, engineRoot, e, ca, reg };
}

// Name the scenario step in any refusal so retained evidence points at the exact transition.
async function step(label, run) { try { return await run(); } catch (error) { error.message = label + ': ' + error.message; throw error; } }
const json = (dir, name, value) => { const file = path.join(dir, name + '-' + crypto.randomUUID() + '.json'); fs.writeFileSync(file, JSON.stringify(value)); return { file, sha256: sha(fs.readFileSync(file)) }; };
const REVIEW_DOUBLE = '# FC Specification Review\n\n## Findings\nNone.\n\n## Content coverage statement\nScripted protocol reviewer double: no semantic review authority.\n\n'
  + '## Coverage\nDraft statement and its cited context only.\n\n## Evidence\nSpecs/Roots.lean:1.\n\nVERDICT: PASS\n';

// One contract revision through the shared driver: actual exported Other packet over git-ignored drafts in the clean
// source, pre-dispatch binding, labelled reviewer double, import, the paired registry-revise publication consuming the
// reviewer's completed work, then the reviewer's stop and reservation closure. With `chain`, every step carries the
// engine's v2 basis (required once accepted proofs are stale); the returned basis explains the next successor.
async function reviseContract(w, { contract, draft, cited, basis = null, chain = basis !== null }) {
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
  const binding = driver.prepareReviewBinding(args), s = await step('review assignment ' + contract.node, () => w.releaseReview(binding, { basis, chain, registryRoot: real.registry })), response = path.join(x.owned, 'response-' + crypto.randomUUID() + '.md');
  fs.writeFileSync(response, REVIEW_DOUBLE);
  const imported = await driver.importReviewedContract({ projectRoot: x.root, binding: binding.binding, workPacket: s.packet, marker: s.marker,
    response: json(x.owned, 'returned', { workPacket: s.packet, marker: s.marker, binding: binding.binding, response: { file: response, sha256: sha(fs.readFileSync(response)) }, reviewerInvocation: s.launch.action.transitionId }),
    session: json(x.owned, 'session', { session: { id: s.actor.sessionId, projectId: 'fixture-project', harness: 'fixture', isTerminated: false } }),
    settings: json(x.owned, 'settings', { options: [{ id: 'model', currentValue: 'fixture' }, { id: 'effort', currentValue: 'xhigh' }] }), out: x.out() });
  if (imported.status !== 'review-pass-candidate') throw new Error('review import: ' + imported.status);
  const completion = w.t.recordReviewWorkCompletion({ importEvidence: imported.evidence, contract: contractRef, review: imported.review, controllerSessionId: w.context().ao.coordinatorSessionId, out: x.out() }).completion;
  const input = w.t.transitionBound(binding.input), previous = registryStatus(w).nodes[String(contract.node)]?.head ?? null;
  const invocation = json(x.owned, 'registry-request', { schema: 'fvs/auto-registry-invocation', schemaVersion: 1, plan: w.inputs.plan, graph: w.inputs.graph,
    registry: real.registry, specRoot: src, contract: contractRef, review: imported.review, previous });
  const published = await step('registry-revise ' + contract.node, () => w.paired({ kind: 'registry-revise', stage: 'review', registryRoot: real.registry,
    target: { candidateSha256: input.candidateSha256, review: imported.review, request: invocation }, basis: chain ? { ...s.released.recorded.basis, workCompletion: completion } : null }));
  const closed = await closeAssignment(w, s.actor, completion, { basis: chain ? published.recorded.basis : null, registryRoot: real.registry });
  // The successor is explained by the completed publication: v2 stop rows record registry metadata only (nodes null),
  // so a basis on the resolve row can never equal a full current snapshot. The stops still close the reservation.
  return { contract: contractRef, binding, imported, published, previous, closed, basis: published.recorded.basis };
}
// Stop a finished assignment and close its reservation, as the reviewed Phase C steps did against actual AO: a paired
// terminate (stock `ao session kill`, here the labelled double) sealing the known work named by the handoff, then the
// recorded reservation resolution with the same handoff.
async function closeAssignment(w, actor, progress, { basis = null, registryRoot = null } = {}) {
  const { x, t } = w, association = w.context().associations.find(a => t.transitionBound(a).sessionId === actor.sessionId);
  if (!association) throw new Error('no retained association for ' + actor.sessionId);
  const target = operation => ({ sessionId: actor.sessionId, association, progress, operation });
  const stopped = await step('terminate ' + actor.sessionId, () => w.paired({ kind: 'terminate', stage: 'reconcile', sessionId: actor.sessionId, registryRoot, effect: { kind: 'local', operation: 'reconcile' }, target: target('terminate-session'), basis }));
  if (stopped.raw?.session?.isTerminated !== true) throw new Error('AO does not report the actor terminated');
  const evidence = json(x.owned, 'owned-session-termination', { schema: 'fvs/auto-owned-session-termination', schemaVersion: 1, session: stopped.raw.session, progress, terminationCompletion: stopped.completion });
  const resolved = await step('resolve ' + actor.sessionId, () => w.paired({ kind: 'terminate', stage: 'reconcile', sessionId: actor.sessionId, registryRoot, execute: false, effect: { kind: 'reservation-resolution', targetReservationId: actor.reservationId },
    target: target('resolve-terminated-reservation'), basis: basis && stopped.recorded.basis, after: () => ({ sessionId: null, association: null, evidence: [evidence], resolution: { reason: 'session-terminated', evidence } }) }));
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
  const storeRoot = path.join(path.dirname(w.real.root), 'store');
  w.inputs.acceptedStore = storeHead(w, storeRoot);
  const receipts = {};
  receipts.freeze = await freezeStep(w, materials, 'F0 freeze', {}, null);
  const checked = await checkAccept(w, 'E0', storeRoot, null);
  return { storeRoot, receipts: { ...receipts, ...checked.receipts }, basis: checked.basis };
}
const storeHead = (w, storeRoot) => ({ root: storeRoot, expectedHeadSha256: w.ca.readAcceptedStore(storeRoot).headSha256 });
async function freezeStep(w, materials, label, options, basis) {
  return step(label, () => w.paired({ kind: 'freeze', stage: 'check', registryRoot: w.real.registry, target: { request: freezeRequest(w, materials, options) }, basis,
    after: raw => { if (raw?.authority !== 'expectations-only' || !raw.baseline) throw new Error('freeze produced no expectations-only baseline'); w.inputs.baseline = raw.baseline; return { sessionId: null, association: null }; } }));
}
// One provisional check of the nodes (default H/A/B) at the current source and baseline, then accept them in order (H
// before its consumers A and B).
async function checkAccept(w, label, storeRoot, basis, nodes = [19, 20, 21]) {
  const control = () => w.e.runControl(w.x.run()), receipts = {};
  const check = json(w.x.owned, 'check-request', { schema: 'fvs-checker/check-request', version: 2, purpose: 'auto', runId: 'd-check-' + crypto.randomUUID(), execution: control(), baseline: w.inputs.baseline, source: w.source(), nodes });
  // The checker CLI prints a compact envelope when its result is large and names the full result document as
  // `evidence`; the completion must carry that producer result (run, controller and adapter input), not the summary.
  // Plain JSON parsing keeps the producer's key order: the inspector compares serialized inventories byte for byte.
  const producerResult = raw => { if (!raw?.evidence) return raw; const bytes = fs.readFileSync(raw.evidence.file); if (sha(bytes) !== raw.evidence.sha256) throw new Error('check result changed'); return JSON.parse(bytes); };
  receipts.check = await step(label + ' check', () => w.paired({ kind: 'check', stage: 'check', nodes, registryRoot: w.real.registry, target: { request: check, nodes }, result: producerResult, basis }));
  if (receipts.check.raw?.status !== 'provisional' || !receipts.check.raw.evidence) throw new Error(label + ' check is not provisional');
  receipts.accept = [];
  let next = basis && receipts.check.recorded.basis;
  for (const node of nodes) {
    const accept = json(w.x.owned, 'accept-request-' + node, { schema: 'fvs-checker/accept-request', version: 2, purpose: 'auto', runId: 'd-accept-' + node + '-' + crypto.randomUUID(), execution: control(),
      baseline: w.inputs.baseline, candidateCheck: receipts.check.raw.evidence, source: w.source(), node, store: storeHead(w, storeRoot) });
    const accepted = await step(label + ' accept ' + node, () => w.paired({ kind: 'accept', stage: 'acceptance', nodes: [node], registryRoot: w.real.registry, target: { request: accept, node }, basis: next,
      after: raw => { if (raw?.status !== 'accepted') throw new Error('accept ' + node + ' did not publish'); w.inputs.acceptedStore = storeHead(w, storeRoot); return { sessionId: null, association: null }; } }));
    receipts.accept.push(accepted); next = accepted.recorded.basis;
  }
  return { receipts, basis: next };
}

// The deliberate first attempt counts only as the intended failed proof: an actually started, normally terminated,
// nonzero Lean run with the tool unchanged and cleanup complete, whose hash-bound diagnostics are exactly the expected
// unknown identifier in this file. Any other failure (lifecycle, import, search path) stops with its own facts.
const WRONG_LEMMA = 'm1demo.helper_add_comm';
function intendedFailure(attempt, file, identifier) {
  const read = ref => { const b = fs.readFileSync(ref.file); if (sha(b) !== ref.sha256) throw new Error('attempt evidence changed: ' + ref.file); return b; };
  const terminal = JSON.parse(read(attempt.terminal)), r = terminal.result;
  if (attempt.status !== 'execution-unverified' || !r || r.toolUnchanged !== true || !Number.isInteger(r.status) || r.status === 0 || r.signal !== null || r.error !== null
    || r.cancelled !== false || r.timedOut !== false || r.outputLimitExceeded !== false || r.cleanupComplete !== true)
    throw new Error('first attempt is not a clean nonzero Lean exit: ' + JSON.stringify({ status: attempt.status, code: attempt.code ?? null, result: r }));
  for (const key of ['stdout', 'stderr']) if (terminal[key].file !== attempt[key].file || terminal[key].sha256 !== attempt[key].sha256) throw new Error('attempt streams are not the terminal streams');
  const text = read(attempt.stdout).toString('utf8') + read(attempt.stderr).toString('utf8');
  // Lean 4.31 reports the absent lemma as "error(lean.unknownIdentifier): Unknown identifier `name`"; that must be the only error.
  const errors = text.split('\n').filter(line => /(^|: )error\b/.test(line)), expected = file + ':', unknown = 'Unknown identifier `' + identifier + '`';
  if (!errors.length || errors.some(line => !line.startsWith(expected) || !line.includes(unknown))) throw new Error('first attempt failed for another reason: ' + (errors.join(' | ') || text.slice(0, 400)));
  return errors[0].slice(expected.length);
}

// Scripted proof writer (no model): one issued proof task for `node` under the current freeze. It records a genuine
// failed attempt (the wrong-lemma overlay compiled through the run-owned route with the frozen Lean and fails), records
// that progress, commits the correct overlay as its candidate, and the controller materializes it into the source by
// fast-forward (the existing manual procedure) before stopping the writer with its task progress as handoff.
async function proofWriter(w, { node, file, wrong, correct, basis }) {
  const { x, t, e, auto } = w, frozen = t.transitionBound(w.inputs.baseline);
  const invocation = json(x.owned, 'invocation', { schema: 'fvs/auto-proof-invocation', schemaVersion: 2, runId: x.runId, invocationId: crypto.randomUUID(), execution: e.runControl(x.run()) });
  const s = await step('writer assignment ' + node, () => w.releaseReview(null, { basis, chain: true, stage: 'proof', nodes: [node], selectionStage: 'fc_proof_execution', invocation,
    procedure: 'lean-verify/controller-direct', inputs: [invocation], registryRoot: w.real.registry }));
  const wt = s.actor.worktree.path, packet = t.readWorkPacket(s.packet), target = path.join(wt, file);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, fs.readFileSync(wrong));
  // The frozen Lean sees the frozen project build and its external search paths; the attempt must fail honestly.
  const build = frozen.build, leanPath = [build.buildRoot ? path.join(build.buildRoot, 'lib', 'lean') : null, ...(build.externalSearchPaths ?? [])].filter(Boolean).join(':');
  const attempt = await e.runTaskCommand({ schema: 'fvs/owned-command-request', schemaVersion: 1, packet: s.packet, marker: s.marker, invocationId: crypto.randomUUID(),
    tool: { file: build.lean.path, sha256: build.lean.sha256 }, argv: [build.lean.path, '--root=' + wt, target], cwd: wt, env: { PATH: '/usr/bin:/bin', LANG: 'C', LEAN_PATH: leanPath, LEAN_NUM_THREADS: '2' } });
  const diagnostic = intendedFailure(attempt, target, WRONG_LEMMA);
  const progress = auto.recordProgress({ packet: s.packet, marker: s.marker, previous: null, currentGoal: 'prove ' + file + ' for node ' + node,
    failedApproaches: [{ hypothesis: 'close the sum by a commutativity lemma', evidence: [attempt.terminal, attempt.stderr] }],
    lastMeaningfulProgress: { observedAtMs: Date.now(), description: 'compiled the first attempt: ' + diagnostic, evidence: [attempt.terminal] },
    blocker: null, nextStep: 'state the target exactly and prove it by rfl', blockerResolution: null, out: x.out() }).progress;
  fs.writeFileSync(target, fs.readFileSync(correct));
  git(wt, 'add', '--', file); git(wt, '-c', 'user.name=FVS scripted writer', '-c', 'user.email=writer@fvs.invalid', 'commit', '-qm', 'proof(' + node + '): revised overlay');
  const candidateCommit = git(wt, 'rev-parse', 'HEAD'), candidateTree = git(wt, 'rev-parse', 'HEAD^{tree}');
  const launch = s.launch.produced.before.value, assignment = x.associate(s.actor.sessionId, wt, launch.request.transition.intent, launch.recordedEventSha256);
  w.useAssociations([assignment]);
  const files = { [file]: sha(fs.readFileSync(target)) }, candidate = { commit: candidateCommit, tree: candidateTree, files, assignment };
  const result = json(x.owned, 'writer-result', { schema: 'fvs/auto-work-result', schemaVersion: 2, runId: x.runId, packet: s.packet, marker: s.marker, actionSha256: packet.actionSha256, actor: packet.actor,
    kind: 'candidate', prepared: { commit: packet.actor.worktree.commit, tree: packet.actor.worktree.tree }, result: candidate, controllerObservedAtMs: Date.now(), controllerSessionId: w.context().ao.coordinatorSessionId });
  const completion = json(x.owned, 'writer-completion', { schema: 'fvs/auto-work-completion', schemaVersion: 2, runId: x.runId, packet: s.packet, marker: s.marker,
    sourceAfter: { commit: candidateCommit, tree: candidateTree }, outcome: 'completed', artifacts: [result, progress], controllerSessionId: w.context().ao.coordinatorSessionId });
  const src = w.source(), materialized = await step('materialize ' + node, () => w.paired({ kind: 'materialize-proof', stage: 'integration', execute: false, registryRoot: w.real.registry,
    target: { parent: src.commit, candidates: [candidate], files }, basis: { ...s.released.recorded.basis, workCompletion: completion },
    after: (raw, beforeEventSha256, intent) => integrate(w, intent, beforeEventSha256, candidateCommit) }));
  const closed = await closeAssignment(w, s.actor, progress, { basis: materialized.recorded.basis, registryRoot: w.real.registry });
  return { candidate, progress, attempt, materialized, closed, basis: materialized.recorded.basis };
}
// The existing manual integration procedure: fast-forward the clean source worktree to the candidate, retained as an
// exact command receipt and completion for the paired after.
function integrate(w, intent, beforeEventSha256, commit) {
  const { x, t, m } = w, root = w.source().root, action = t.transitionBound(intent.request);
  const argv = ['/usr/bin/git', '-C', root, 'merge', '--ff-only', commit], env = { ...GIT_ENV, GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' };
  const startedAtMs = Date.now(), p = spawnSync(argv[0], argv.slice(1), { cwd: root, env }), endedAtMs = Date.now();
  if (p.status !== 0) throw new Error('integration fast-forward failed: ' + p.stderr);
  const stream = (name, bytes) => { const file = path.join(x.owned, name + '-' + crypto.randomUUID()); fs.writeFileSync(file, bytes); return { file, sha256: sha(fs.readFileSync(file)) }; };
  const command = json(x.owned, 'integrate-command', { schema: 'fvs/auto-command-receipt', schemaVersion: 2, runId: x.runId, transitionId: action.transitionId, actionSha256: m.memoryHash(action),
    argv, cwd: root, env, tool: { file: '/usr/bin/git', sha256: sha(fs.readFileSync('/usr/bin/git')) }, startedAtMs, endedAtMs, exitCode: p.status, signal: p.signal, error: null,
    stdout: stream('integrate-stdout', p.stdout), stderr: stream('integrate-stderr', p.stderr), execution: w.e.runControl(x.run()),
    supervision: { cancelled: false, timedOut: false, cleanupComplete: true, operationKind: 'work', workScope: 'controller-integration' } });
  const completion = json(x.owned, 'integrate-completion', { schema: 'fvs/auto-transition-completion', schemaVersion: 2, runId: x.runId, transitionId: action.transitionId, reservationId: action.reservationId,
    actionSha256: m.memoryHash(action), beforeEventSha256, command, result: json(x.owned, 'integrated', { source: commit }) });
  return { sessionId: null, association: null, evidence: [completion] };
}

// One revision episode (real Lean, opt-in only): fresh reviews of the revised contracts, a freeze at the current source
// with only the absent overlay mutable, the scripted writer for that node, then check and accept H/A/B at the
// integrated source. The first review is a fresh decision (see `episodeReviews`); every later step carries the v2 basis
// chain from it (the previous acceptances are stale from the first revision on).
// A proof launch requires every helper of its node accepted at the current source, freeze and registry, so protected
// helpers (`protect`) are first checked and accepted under the new freeze at the unchanged source.
async function runEpisode(w, materials, label, { storeRoot, basis, reviews, overlay, libraries = null, protect = [] }) {
  const next = await episodeReviews(w, reviews, basis);
  const frozen = await freezeStep(w, materials, label.freeze + ' freeze', { overlayFiles: [overlay.file], targets: overlay.targets, libraries }, next);
  const protectedHelpers = protect.length ? await checkAccept(w, label.episode + ' protected', storeRoot, frozen.recorded.basis, protect) : null;
  const writer = await proofWriter(w, { node: overlay.node, file: overlay.file, wrong: overlay.wrong, correct: overlay.correct, basis: protectedHelpers?.basis ?? frozen.recorded.basis });
  const checked = await checkAccept(w, label.episode, storeRoot, writer.basis);
  return { frozen, protectedHelpers, writer, checked, basis: checked.basis };
}
// E1: revise H, review A/B, F1 at C0 with the V1 overlay mutable, writer for H, integrate I1.
async function runE1(w, materials, { storeRoot, basis, reviews, overlay }) {
  const r = await runEpisode(w, materials, { episode: 'E1', freeze: 'F1' }, { storeRoot, basis, reviews, overlay: { ...overlay, node: 19, targets: { 19: overlay.target } } });
  return { f1: r.frozen, writer: r.writer, checked: r.checked, basis: r.basis };
}
// E2: promote the protected V1 proof into H's reviewed definitions, revise A, review B, F2 at I1 with only the absent V2
// overlay mutable (V1 is built as a protected library module), check and accept the protected H at I1 under F2, writer
// for A, integrate I2, then check and accept H, A, B at I2.
async function runE2(w, materials, { storeRoot, basis, reviews, overlay, libraries }) {
  const r = await runEpisode(w, materials, { episode: 'E2', freeze: 'F2' }, { storeRoot, basis, reviews, overlay, libraries, protect: [19] });
  return { f2: r.frozen, protectedH: r.protectedHelpers, writer: r.writer, checked: r.checked, basis: r.basis };
}
// An episode opens on the owner's revision, which no completed transition explains: the engine admits a chained review
// launch only for missing or pending contracts, and the revised contracts are already reviewed (and accepted). So the
// first review is the coordinator's fresh decision, admitted only while every retained acceptance is verified current,
// and every later step chains on that review's publication. `basis` (the previous episode's end) is used only when the
// episode has no reviews.
async function episodeReviews(w, reviews, basis) {
  let next = reviews.length ? null : basis;
  for (const review of reviews) next = (await reviseContract(w, { ...review, basis: next, chain: true })).basis;
  return next;
}
// A fresh current reconcile (the independent resume/memory consumer inputs of a bundle or revision request).
function currentResume(w) {
  const { x } = w, ctx = w.context();
  return x.invoke(x.request({ inputs: w.inputs, associations: ctx.associations, source: w.source() }));
}
// The v2 review-bundle request over the real root at the current registry/baseline/store/runtime head.
function bundleRequest(w) {
  const { x, real } = w, view = w.auto.readState({ projectRoot: real.root, requireAgreement: true }), file = name => path.join(real.root, '.formalising/auto-fv', name);
  const fileRef = f => ({ file: f, sha256: sha(fs.readFileSync(f)) });
  const agreement = { state: fileRef(file('state.json')), roadmap: fileRef(file('ROADMAP.md')), contextSha256: view.agreement.contextSha256,
    choicesGeneration: view.state.choicesGeneration, approvedPayloadSha256: view.agreement.agreement.approvedPayloadSha256 };
  const plan = w.t.transitionBound(w.inputs.plan);
  const scopeInventory = json(x.owned, 'scope', { schema: 'fvs/auto-bundle-scope-inventory', schemaVersion: 1, agreement, plan: w.inputs.plan,
    requestedRoots: plan.selection.requestedRoots, failed: plan.selection.failed,
    applicability: [{ scopeItemId: 'ticket18-d-roots', roots: plan.selection.requestedRoots, disposition: 'mapped', reason: null, evidence: [agreement.roadmap] }] });
  const { baseline, acceptedStore } = w.inputs, run = w.auto.readRuntimeState({ projectRoot: real.root }).state.run;
  return { schema: 'fvs/auto-bundle-request', schemaVersion: 2, bundleId: crypto.randomUUID(), projectRoot: real.root, source: w.source(), agreement,
    extraction: w.inputs.extraction, graph: w.inputs.graph, plan: w.inputs.plan, scopeInventory, registry: { root: real.registry, expectedHeadSha256: registryStatus(w).registryHeadSha256 },
    baseline, acceptedStore, runtime: { root: real.root, state: fileRef(file('resume/state.json')), absenceReason: null }, handoff: null,
    absenceReasons: { baseline: baseline ? null : 'not frozen in this episode', acceptedStore: acceptedStore ? null : 'no canonical acceptance yet', runtime: null, handoff: 'scripted scenario; no handoff' },
    execution: w.e.runControl(run) };
}
// A v2 revision request (inspect or finish) bound to a fresh current reconcile, the prior bundle and the owner feedback.
function respecRequest(w, { revisionId, prior, feedback, items, operation = 'inspect', inspectEvidence = null }) {
  const current = currentResume(w), b = bundleRequest(w), memoryOut = current.result.observation.memory.out, ref = f => ({ file: f, sha256: sha(fs.readFileSync(f)) });
  return { schema: 'fvs/auto-respec-request', schemaVersion: 2, revisionId, attemptId: current.q.attemptId, operation,
    ownerFeedback: { ownerReference: 'ticket18 D scripted owner feedback (no human authentication)', evidence: feedback }, priorBundle: prior,
    current: { bundle: b, resume: { request: ref(path.join(current.out, 'request.json')), result: ref(path.join(current.out, 'result.json')), committedHeadSha256: current.result.committedHeadSha256 },
      memory: { mode: 'beads', request: ref(path.join(memoryOut, 'request.json')), result: ref(path.join(memoryOut, 'result.json')) }, authorization: w.x.auth, profile: w.x.profile },
    requestedItems: items, inspectEvidence, execution: b.execution };
}
// The node versions an item names: the current registered record and candidate for each node.
function versionsOf(w, nodes) {
  const heads = w.reg.readChain(w.real.registry).heads;
  return nodes.map(node => { const row = heads.get(node); if (!row) throw new Error('no registered version for node ' + node); return { node, recordSha256: row.sha, candidateSha256: row.record.candidateSha256 }; });
}
// The canonical identities a refused negative must leave unchanged (runtime bytes, registry, store, source).
function canonicalIdentity(w, storeRoot) {
  return { runtime: sha(fs.readFileSync(path.join(w.real.root, '.formalising/auto-fv/resume/state.json'))), registry: registryStatus(w).registryHeadSha256,
    store: storeRoot ? w.ca.readAcceptedStore(storeRoot).headSha256 : null, source: w.source() };
}
// One bound negative: the checker CLI on an owned request copy, refused before any build, with retained streams.
function negative(w, { name, command, request, expectedCode, storeRoot = null, dir }) {
  fs.mkdirSync(dir, { recursive: true });
  const before = canonicalIdentity(w, storeRoot), records = storeRoot ? w.ca.readAcceptedStore(storeRoot).records.length : 0;
  const argv = [path.join(w.engineRoot, 'scripts/fvs-checker.mjs'), command, '--request', request.file, '--out', path.join(dir, name + '-out')];
  const p = spawnSync(process.execPath, argv, { cwd: dir, timeout: 600000, maxBuffer: 64 * 1024 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C', LEAN_NUM_THREADS: '2' } });
  const stream = (key, bytes) => { const file = path.join(dir, name + '.' + key); fs.writeFileSync(file, bytes ?? Buffer.alloc(0), { flag: 'wx' }); return { file, sha256: sha(fs.readFileSync(file)) }; };
  return json(dir, 'negative-' + name, { schema: 'fvs45/d-bound-negative', schemaVersion: 1, name, argv: [process.execPath, ...argv], request, expectedCode,
    exitCode: p.status, signal: p.signal, timedOut: p.error?.code === 'ETIMEDOUT', refused: Number.isInteger(p.status) && p.status !== 0,
    stdout: stream('stdout', p.stdout), stderr: stream('stderr', p.stderr),
    acceptedOutputCreated: (storeRoot ? w.ca.readAcceptedStore(storeRoot).records.length : 0) !== records, canonicalBefore: before, canonicalAfter: canonicalIdentity(w, storeRoot) });
}
// An owned variant of a request document (the original stays bound and unchanged).
function variant(w, request, patch) { const v = structuredClone(w.t.transitionBound(request)); patch(v); return json(w.x.owned, 'negative-request', v); }
function registryStatus(w) {
  const p = spawnSync(process.execPath, [path.join(w.engineRoot, 'scripts/fvs-contract-registry.mjs'), 'status', '--plan', w.inputs.plan.file, '--graph', w.inputs.graph.file,
    '--registry', w.real.registry, '--spec-root', w.source().root], { encoding: 'utf8' });
  return JSON.parse(p.stdout);
}

module.exports = { prepareRealRoot, recordSetup, dWorld, reviseContract, closeAssignment, freezeRequest, admitFreeze, runE0, runE1, runE2, episodeReviews, proofWriter, intendedFailure, currentResume, bundleRequest, respecRequest, versionsOf, canonicalIdentity, negative, variant, step, registryStatus, git, sha };
