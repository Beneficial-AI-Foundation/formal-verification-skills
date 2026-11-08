'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const SCRIPT = path.resolve(__dirname, '../scripts/fvs-auto-actor-permissions.py');
const PYTHON = process.env.FVS_TEST_PYTHON || 'python3';
const owned = [];
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const ref = file => ({ file, sha256: sha(fs.readFileSync(file)) });
const json = (file, body) => { fs.writeFileSync(file, JSON.stringify(body)); return ref(file); };
after(() => { for (const root of owned) fs.rmSync(root, { recursive: true, force: true }); });
function run(argv, cwd) {
  const p = spawnSync('/usr/bin/git', argv, { cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1' } });
  assert.equal(p.status, 0, p.stderr); return p.stdout.trim();
}
function fixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fvs-actor-permissions-')); owned.push(root);
  const project = path.join(root, 'project'), actor = path.join(root, 'actor with spaces'); fs.mkdirSync(project);
  run(['init', '-q'], project); fs.writeFileSync(path.join(project, 'Source.lean'), 'def value := 1\n');
  run(['add', 'Source.lean'], project); run(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'test(fixture): seed permission actor'], project);
  run(['worktree', 'add', '-q', '-b', 'actor', actor], project);
  fs.mkdirSync(path.join(actor, '.claude'));
  const file = path.join(actor, '.claude/settings.local.json'), initial = { hooks: { PostToolUse: [{ matcher: 'Read', hooks: [] }] }, existing: { keep: true } };
  fs.writeFileSync(file, JSON.stringify(initial)); fs.chmodSync(file, 0o640);
  const common = fs.realpathSync(path.join(project, '.git'));
  const a = { schema: 'fvs/auto-session-association', schemaVersion: 1, runId: crypto.randomUUID(), projectId: 'owned-project', controllerSessionId: 'owned-controller',
    sessionId: 'owned-actor', scopeRelation: 'run-assignment', provenance: { kind: 'controller-launch' },
    worktree: { path: actor, gitCommonDir: common, gitDir: fs.realpathSync(path.resolve(actor, run(['rev-parse', '--git-dir'], actor))), branchRef: run(['symbolic-ref', 'HEAD'], actor) } };
  const association = json(path.join(root, 'association.json'), a), node = ref(fs.realpathSync(process.execPath)), gate = ref(path.resolve(__dirname, '../scripts/fvs-auto.mjs'));
  const grant = json(path.join(root, 'grant.json'), { schema: 'fvs/auto-actor-permission-grant', schemaVersion: 1, runId: a.runId, projectId: a.projectId,
    controllerSessionId: a.controllerSessionId, node, gate, ownerReference: 'fixture-only explicit grant; not live authority' });
  const request = { schema: 'fvs/auto-actor-permissions', schemaVersion: 1, projectRoot: project, association, grant, node, gate, out: path.join(root, 'evidence') };
  return { root, actor, file, initial, a, request };
}
function invoke(f) {
  const input = path.join(f.root, 'request.json'); json(input, f.request);
  return spawnSync(PYTHON, [SCRIPT, '--input', input], { encoding: 'utf8', env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } });
}
test('merges only the recorded actor; preserves all hooks, unrelated keys and mode with actual receipts', () => {
  const f = fixture(), result = invoke(f); assert.equal(result.status, 0, result.stderr);
  const installed = JSON.parse(fs.readFileSync(f.file)); assert.deepEqual(installed.hooks, f.initial.hooks); assert.deepEqual(installed.existing, f.initial.existing);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o640); assert.equal(installed.permissions.allow.length, 2);
  const receipt = JSON.parse(result.stdout); assert.equal(receipt.verified, true); assert.equal(receipt.installedSha256, sha(fs.readFileSync(f.file)));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.request.out, 'before.json'))), f.initial);
  assert.equal(fs.existsSync(path.join(f.request.projectRoot, '.claude')), false);
});
for (const [label, change] of [
  ['existing permissions', f => fs.writeFileSync(f.file, JSON.stringify({ ...f.initial, permissions: { deny: ['Bash(*)'] } }))],
  ['settings symlink', f => { const old = f.file + '.old'; fs.renameSync(f.file, old); fs.symlinkSync(old, f.file); }],
  ['settings hardlink', f => fs.linkSync(f.file, f.file + '.link')],
  ['wrong actor branch', f => run(['switch', '-q', '-c', 'other'], f.actor)],
  ['changed grant', f => fs.appendFileSync(f.request.grant.file, ' ')],
  ['missing hooks', f => fs.writeFileSync(f.file, JSON.stringify({ existing: true }))],
  ['ambiguous duplicate hooks', f => fs.writeFileSync(f.file, '{"hooks":{"keep":true},"hooks":{}}')],
]) test('refuses ' + label + ' without replacing settings', () => {
  const f = fixture(); change(f); const before = fs.readFileSync(f.file), result = invoke(f);
  assert.notEqual(result.status, 0); assert.deepEqual(fs.readFileSync(f.file), before);
});
test('compare-then-replace refuses detected drift and retains the before evidence', () => {
  const f = fixture(), code = `import importlib.util, json, pathlib\ns=importlib.util.spec_from_file_location('permissions',${JSON.stringify(SCRIPT)}); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)\nout=${JSON.stringify(path.join(f.root, 'drift-evidence'))}; pathlib.Path(out).mkdir()\nf=${JSON.stringify(f.file)}\ntry: m.merge(f,['Bash(node trusted *)'],out,before_commit=lambda:pathlib.Path(f).write_text('new writer bytes'))\nexcept m.Refused: pass\nelse: raise AssertionError('drift must refuse')\nassert pathlib.Path(f).read_text()=='new writer bytes'\nassert pathlib.Path(out,'before.json').is_file()\n`;
  const result = spawnSync(PYTHON, ['-c', code], { encoding: 'utf8', env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } }); assert.equal(result.status, 0, result.stderr);
});
for (const tool of ['gate', 'node']) test('literal wildcard ' + tool + ' path refuses before output/settings writes', () => {
  const f = fixture(), directory = path.join(f.root, 'literal*tool'); fs.mkdirSync(directory);
  const file = path.join(directory, tool === 'gate' ? 'fvs-auto.mjs' : 'node');
  fs.writeFileSync(file, '#!/bin/sh\nexit 1\n', { mode: 0o755 }); f.request[tool] = ref(file);
  const grant = JSON.parse(fs.readFileSync(f.request.grant.file)); grant[tool] = f.request[tool];
  f.request.grant = json(f.request.grant.file, grant);
  const before = fs.readFileSync(f.file), result = invoke(f);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /wildcard|pattern/i);
  assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(fs.existsSync(f.request.out), false);
});
test('ordinary spaces and quotes retain exact shell-quoted tool prefixes', () => {
  const f = fixture(), directory = path.join(f.root, "tool path 'quoted'"); fs.mkdirSync(directory);
  for (const tool of ['node', 'gate']) {
    const file = path.join(directory, tool); fs.writeFileSync(file, '#!/bin/sh\nexit 1\n', { mode: 0o755 }); f.request[tool] = ref(file);
  }
  const grant = JSON.parse(fs.readFileSync(f.request.grant.file)); grant.node = f.request.node; grant.gate = f.request.gate; f.request.grant = json(f.request.grant.file, grant);
  const result = invoke(f); assert.equal(result.status, 0, result.stderr);
  const rules = JSON.parse(result.stdout).rules;
  const parsed = spawnSync(PYTHON, ['-c', 'import json,shlex,sys; r=json.loads(sys.argv[1]); print(json.dumps([shlex.split(s[5:-3]) for s in r]))', JSON.stringify(rules)], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.deepEqual(JSON.parse(parsed.stdout), [['node', f.request.gate.file], [f.request.node.file, f.request.gate.file]]);
  // Shell quoting only; actual native permission matching remains a separate qualification.
});
