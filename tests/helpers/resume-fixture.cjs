// Protocol fixture only: AO and (unless explicitly selected) Beads are doubles.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const memory = require('./memory-fixture.cjs');
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const uuid = () => crypto.randomUUID();
function ref(file) { return { file, sha256: sha(fs.readFileSync(file)) }; }
function json(root, name, value) { const file = path.join(root, name + '-' + uuid() + '.json'); fs.writeFileSync(file, JSON.stringify(value)); return ref(file); }
function row(id, role = 'worker', extra = {}) { return { id, projectId: 'fixture-project', role, activity: 'idle', status: 'idle', isTerminated: false, branch: 'stale/branch-hint', ...extra }; }
function fixture(auto, parent = fs.realpathSync(os.tmpdir()), realBd = null, policy = {}) {
  // A supplied root (policy.root) is the caller's prepared real project: it lies outside the owned temp directory,
  // keeps its own excludes and real memory registration, and is never created, rewritten or cleaned up here.
  const owned = fs.mkdtempSync(path.join(parent, 'fvs-resume-fixture-')), supplied = policy.root ?? null;
  if (supplied !== null && (!path.isAbsolute(supplied) || fs.realpathSync(supplied) !== supplied || (supplied + path.sep).startsWith(owned + path.sep))) throw new Error('supplied fixture root must be an existing canonical path outside the owned directory');
  const root = supplied ?? memory.createProject(auto, owned, policy);
  if (supplied === null) {
    fs.appendFileSync(path.join(root, '.git/info/exclude'), '\n.formalising/\n.beads/\nfixture-bd.cjs\n.fixture-bd-calls.jsonl\n');
    if (!realBd && !(policy.schemaVersion === 2 && (policy.memory ?? 'disabled') === 'disabled')) auto.recordMemory({ projectRoot: root, registration: memory.fakeStore(root) });
  }
  const stateHome = path.join(owned, 'ao-home'); fs.mkdirSync(path.join(stateHome, '.ao'), { recursive: true });
  const control = path.join(owned, 'ao-control.json'), log = path.join(owned, 'ao-calls.jsonl'), tool = path.join(owned, 'ao.cjs');
  fs.writeFileSync(tool, '#!' + process.execPath + '\n' + `
const fs = require('node:fs');
if (process.env.HOME !== ${JSON.stringify(stateHome)}) process.exit(91);
const args = process.argv.slice(2), c = JSON.parse(fs.readFileSync(${JSON.stringify(control)}));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');
if (args[0] === 'project' && args[1] === 'get' && c.project) { console.log(JSON.stringify({status:'ok',project:c.project})); return; }
if (args[0] !== 'session' || !['ls','get'].includes(args[1])) process.exit(90);
if (c.fail) process.exit(8);
if (c.oversize) { process.stdout.write('x'.repeat(2*1024*1024)); return; }
if (args[1] === 'ls') console.log(JSON.stringify({data:c.rows,meta:c.meta ?? {hiddenTerminatedCount:0,hiddenOrchestratorCount:0}}));
else { const row = (c.details ?? c.rows).find(r=>r.id===args[2]); if (!row) process.exit(7);
const {role,activity,...rest}=row;console.log(JSON.stringify({session:{...rest,kind:role,activity:{state:activity}}})); }
`);
  fs.chmodSync(tool, 0o755);
  const x = { owned, root, control, log, tool, stateHome, toolRef: ref(tool), rows: [row('coordinator', 'orchestrator')], runId: uuid(), auto };
  x.writeControl = (extra = {}) => fs.writeFileSync(control, JSON.stringify({ rows: x.rows, ...extra })); x.writeControl();
  x.out = () => path.join(owned, 'observe-' + uuid());
  x.request = (extra = {}) => {
    const attemptId = uuid(), phase = extra.phase ?? 'resume', resumeId = phase === 'start' ? null : uuid();
    const selected = auto.readState({ projectRoot: root }).state;
    const request = { schema: 'fvs/auto-resume-request', schemaVersion: selected.schemaVersion, attemptId, runId: x.runId, phase, resumeId,
      ao: { tool: ref(tool), stateHome, projectId: 'fixture-project', coordinatorSessionId: 'coordinator' },
      expectedHeadSha256: auto.readRuntimeState({ projectRoot: root }).headSha256,
      source: { kind: 'git', root, commit: memory.git(root, 'rev-parse', 'HEAD'), expectedTree: memory.git(root, 'rev-parse', 'HEAD^{tree}') },
      inputs: { extraction: null, graph: null, plan: null, baseline: null, acceptedStore: null }, associations: [], priorAccounting: null,
      memoryRequest: selected.schemaVersion === 2 && selected.choices.memory.mode === 'disabled' ? null : auto.prepareMemoryRequest({ projectRoot: root, attemptId, operation: 'coordinator-refresh', phase,
        target: { projectId: 'fixture-project', sessionId: 'coordinator', resumeId } }), transition: null, ...extra };
    return request;
  };
  x.invoke = (q = x.request(), operation = 'state', out = x.out()) => ({ q, out, result: (operation === 'state' ? auto.reconcileState : auto.checkpointState)({ projectRoot: root, request: q, out }) });
  x.local = (nodes = [19], stage = 'proof') => ({ transitionId: uuid(), reservationId: uuid(), stage, nodes, owner: 'worker-owner', effect: { kind: 'local', operation: stage } });
  x.launch = (nodes = [19]) => ({ ...x.local(nodes), effect: { kind: 'ao-launch', projectId: 'fixture-project', intendedBranchRef: 'refs/heads/worker-' + uuid(), assignmentId: uuid(), sessionId: null } });
  x.before = (intent) => ({ position: 'before', intent, beforeEventSha256: null, outcome: null, effect: null });
  x.after = (before, effect = { sessionId: null, association: null, evidence: [], resolution: null }, outcome = 'succeeded') => ({ position: 'after', intent: before.q.transition.intent, beforeEventSha256: before.result.recordedEventSha256, outcome, effect });
  x.accounting = () => json(owned, 'accounting', { schema: 'fvs/auto-runtime-accounting', schemaVersion: auto.readState({ projectRoot: root }).state.schemaVersion, runId: x.runId,
    startedAtMs: Date.now() - 1000, lastObservedAtMs: Date.now(), limits: auto.readState({ projectRoot: root }).state.choices.limits, ...(policy.schemaVersion === 2 ? { budget: auto.readState({ projectRoot: root }).state.choices.budget } : {}) });
  x.associate = (sessionId, tree = root, intent = x.local(), beforeEventSha256 = null, extra = {}) => {
    const gitDir = fs.realpathSync(path.resolve(tree, memory.git(tree, 'rev-parse', '--git-dir'))), gitCommonDir = fs.realpathSync(path.resolve(tree, memory.git(tree, 'rev-parse', '--git-common-dir')));
    return json(owned, 'association', { schema: 'fvs/auto-session-association', schemaVersion: 1, runId: x.runId, assignmentId: intent.effect.assignmentId ?? uuid(), reservationId: intent.reservationId,
      projectId: 'fixture-project', sessionId, scopeRelation: 'run-assignment', nodes: intent.nodes, owner: intent.owner, controllerSessionId: 'coordinator',
      worktree: { path: tree, gitDir, gitCommonDir, branchRef: memory.git(tree, 'symbolic-ref', 'HEAD'), commit: memory.git(tree, 'rev-parse', 'HEAD'), tree: memory.git(tree, 'rev-parse', 'HEAD^{tree}') },
      provenance: { kind: beforeEventSha256 ? 'controller-launch' : 'controller-existing-assignment', beforeEventSha256,
        evidence: [json(owned, 'controller-observation', { observation: 'protocol fixture retained controller statement; not AO/OS attestation' })] }, rulesProfile: null, ...extra });
  };
  return x;
}
module.exports = { ...memory, fixture, row, uuid, ref, json, sha };
