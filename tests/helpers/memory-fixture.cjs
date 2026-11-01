const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const stateFile = (root) => path.join(root, '.formalising/auto-fv/state.json');
const roadmapFile = (root) => path.join(root, '.formalising/auto-fv/ROADMAP.md');
function git(root, ...args) {
  const r = spawnSync('/usr/bin/git', ['-C', root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim();
}
function createProject(auto, base = fs.realpathSync(os.tmpdir())) {
  const root = fs.mkdtempSync(path.join(base, 'fvs-memory-project-'));
  fs.cpSync(path.join(ROOT, 'tests/fixtures/auto-profile/fresh'), root, { recursive: true });
  fs.cpSync(path.join(ROOT, 'tests/fixtures/extract-patches/crate'), root, { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), 'Memory fixture, not a verification claim.\n');
  git(root, 'init', '-q'); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'fixture');
  fs.mkdirSync(path.dirname(stateFile(root)), { recursive: true });
  fs.writeFileSync(stateFile(root), JSON.stringify({ schema: 'fvs/auto-state', schemaVersion: 1, profiledAt: 'fixture',
    profile: { schema: 'fvs/auto-profile', items: [] }, choices: { source: { revision: 'HEAD', configuration: 'fixture' }, scope: 'fixture scope',
      limits: { nodeHours: 2, workers: 3, wallClockHours: 40 } }, roadmap: null, extraction: null }));
  const s = JSON.parse(fs.readFileSync(stateFile(root)));
  const a = { schema: 'fvs/auto-agreement', schemaVersion: 1, mode: 'nonpublic-intent',
    payload: { choicesGeneration: 0, choices: s.choices, contextVersion: 1, boundaries: [], conventions: ['fixture convention'], layout: 'single-crate',
      claims: ['fixture goal'], trust: ['fixture assumptions'], acceptance: ['independent checks'], ownerReserved: ['human final PR decision'], execution: null, draftPr: null },
    ownerEvidence: { reference: 'fixture:response', response: 'Fixture initial agreement only; not a real owner response.' } };
  a.approvedPayloadSha256 = auto.agreementPayloadSha256(a);
  fs.writeFileSync(roadmapFile(root), '## Goal\nFixture goal\n\n## Decisions\n```fvs-auto-agreement\n' + JSON.stringify(a) + '\n```\n');
  auto.recordAgreement({ projectRoot: root, agreement: a });
  return root;
}
function fakeStore(root) {
  const store = path.join(root, '.beads'); fs.mkdirSync(store); fs.mkdirSync(path.join(store, 'embeddeddolt'));
  fs.mkdirSync(path.join(store, 'embeddeddolt/fixture_db/.dolt'), { recursive: true });
  fs.writeFileSync(path.join(store, 'metadata.json'), JSON.stringify({ backend: 'dolt', database: 'dolt', dolt_mode: 'embedded', dolt_database: 'fixture_db', project_id: crypto.randomUUID() }));
  const bd = path.join(root, 'fixture-bd.cjs');
  fs.writeFileSync(bd, '#!' + process.execPath + '\n' + fs.readFileSync(path.join(ROOT, 'tests/fixtures/project-memory/bd.cjs'), 'utf8')); fs.chmodSync(bd, 0o755);
  return { backend: 'beads', canonicalRoot: root, storeDir: store, bdPath: bd };
}
function control(root, value) { fs.writeFileSync(path.join(root, '.beads/fixture-control.json'), JSON.stringify(value)); }
function calls(root) { const f = path.join(root, '.fixture-bd-calls.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; }
function request(auto, root, operation = 'worker-readonly', extra = {}) {
  return auto.prepareMemoryRequest({ projectRoot: root, operation, attemptId: crypto.randomUUID(), phase: 'resume',
    target: { projectId: 'fixture-project', sessionId: 'fixture-worker', resumeId: crypto.randomUUID() }, ...extra });
}
function output(root, name = 'observation') { return path.join(root, name + '-' + crypto.randomUUID()); }
module.exports = { ROOT, git, stateFile, roadmapFile, createProject, fakeStore, control, calls, request, output };
