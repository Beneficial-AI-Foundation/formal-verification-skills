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
// A project-local install shared by several worktrees: the project's own .claude holds the FVS entries and its own
// settings.local.json. The snapshot records every entry and each regular file's digest so a test can prove nothing shared changed.
function sharedInstall(f) {
  const shared = path.join(f.root, 'project', '.claude');
  fs.mkdirSync(path.join(shared, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(shared, 'commands', 'run.md'), 'shared command\n');
  fs.writeFileSync(path.join(shared, 'settings.json'), '{"statusLine":{}}\n');
  fs.writeFileSync(path.join(shared, 'settings.local.json'), JSON.stringify({ hooks: {} }));
  return shared;
}
function snapshot(dir) {
  return fs.readdirSync(dir).sort().flatMap(name => {
    const entry = path.join(dir, name), st = fs.lstatSync(entry);
    if (st.isDirectory()) return [[name, 'dir'], ...snapshot(entry).map(([n, d]) => [path.join(name, n), d])];
    return [[name, st.isFile() ? sha(fs.readFileSync(entry)) : 'link']];
  });
}
test('nested-link layout: real per-worktree .claude with linked FVS entries takes the grant only in its own settings file', () => {
  const f = fixture(), shared = sharedInstall(f), actorClaude = path.join(f.actor, '.claude');
  for (const entry of ['commands', 'settings.json']) fs.symlinkSync(path.join(shared, entry), path.join(actorClaude, entry));
  const before = snapshot(shared), result = invoke(f); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).permissions.allow.length, 2);
  const st = fs.lstatSync(f.file); assert.equal(st.isFile() && st.nlink === 1, true);
  assert.equal(fs.lstatSync(actorClaude).isDirectory(), true);
  for (const entry of ['commands', 'settings.json']) assert.equal(fs.lstatSync(path.join(actorClaude, entry)).isSymbolicLink(), true);
  assert.deepEqual(snapshot(shared), before);
  assert.deepEqual(fs.readdirSync(actorClaude).sort(), ['commands', 'settings.json', 'settings.local.json']);
});
test('whole-folder link: a linked .claude is refused with the supported layout named; the shared folder stays unchanged', () => {
  const f = fixture(), shared = sharedInstall(f);
  fs.rmSync(path.join(f.actor, '.claude'), { recursive: true }); fs.symlinkSync(shared, path.join(f.actor, '.claude'));
  const before = snapshot(shared), result = invoke(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\.claude is a link/); assert.match(result.stderr, /real \.claude folder per worktree/);
  assert.match(result.stderr, /link only the FVS entries/);
  assert.deepEqual(snapshot(shared), before); assert.equal(fs.existsSync(f.request.out), false);
});
for (const [label, share] of [
  ['symlinked', (file, target) => fs.symlinkSync(target, file)],
  ['hard linked', (file, target) => fs.linkSync(target, file)],
]) test('shared settings file: a ' + label + ' settings.local.json pointing at the project file is refused and nothing changes', () => {
  const f = fixture(), shared = sharedInstall(f), target = path.join(shared, 'settings.local.json');
  fs.rmSync(f.file); share(f.file, target);
  const before = snapshot(shared), actorBefore = fs.readFileSync(f.file), result = invoke(f);
  assert.notEqual(result.status, 0);
  if (label === 'symlinked') assert.match(result.stderr, /settings\.local\.json is a link/);
  assert.deepEqual(snapshot(shared), before); assert.deepEqual(fs.readFileSync(f.file), actorBefore);
  assert.deepEqual(fs.readdirSync(path.join(f.actor, '.claude')).filter(n => n.startsWith('.settings.local.')), []);
});
test('compare-then-replace refuses detected drift and retains the before evidence', () => {
  const f = fixture(), code = `import importlib.util, json, pathlib\ns=importlib.util.spec_from_file_location('permissions',${JSON.stringify(SCRIPT)}); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)\nout=${JSON.stringify(path.join(f.root, 'drift-evidence'))}; pathlib.Path(out).mkdir()\nf=${JSON.stringify(f.file)}\ntry: m.merge(f,['Bash(node trusted *)'],out,before_commit=lambda:pathlib.Path(f).write_text('new writer bytes'))\nexcept m.Refused: pass\nelse: raise AssertionError('drift must refuse')\nassert pathlib.Path(f).read_text()=='new writer bytes'\nassert pathlib.Path(out,'before.json').is_file()\n`;
  const result = spawnSync(PYTHON, ['-c', code], { encoding: 'utf8', env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } }); assert.equal(result.status, 0, result.stderr);
});
// Races inside the write window. The driver imports merge, installs a wrapper that mutates the filesystem at one exact step,
// and always checks that another worktree's own .claude (real directory, its own settings.local.json) was never written
// and never received grant bytes. `body` runs the mutation and sets err to the refusal message, if any; `then` checks the
// outcome after that common check. Both sides share the wrappers, so the same body runs against any version of the script.
function race(f, body, then = '') {
  const other = path.join(f.root, 'other', '.claude'); fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, 'settings.local.json'), '{"hooks":{},"other":true}\n');
  const code = [
    'import importlib.util, json, os, pathlib',
    `s=importlib.util.spec_from_file_location('permissions',${JSON.stringify(SCRIPT)}); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)`,
    `file=${JSON.stringify(f.file)}; claude=os.path.dirname(file); other=${JSON.stringify(other)}; out=${JSON.stringify(f.request.out)}; os.mkdir(out)`,
    'other_file=os.path.join(other,"settings.local.json"); mark=(pathlib.Path(other_file).read_bytes(), os.stat(other_file).st_ino)',
    'rules=["Bash(node trusted *)"]; err=None',
    body,
    'assert (pathlib.Path(other_file).read_bytes(), os.stat(other_file).st_ino)==mark, "other worktree settings changed"',
    'for n in os.listdir(other): assert b"Bash(node" not in pathlib.Path(other,n).read_bytes(), "grant bytes reached the other worktree: "+n',
    then,
  ].join('\n');
  const result = spawnSync(PYTHON, ['-c', code], { encoding: 'utf8', env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 0, result.stderr);
}
test('parent swap after the final check cannot redirect the replace into another worktree', () => {
  // The actor .claude name is made to resolve to another worktree's real .claude, which holds a file under the staged name.
  // A pathname replace would install that file as the other worktree's settings; the pinned descriptor keeps the write local.
  race(fixture(), [
    'real=os.replace',
    'def swap(src,dst,*a,**k):',
    '    os.rename(claude,claude+".parked"); os.symlink(other,claude)',
    '    pathlib.Path(other,os.path.basename(src)).write_bytes(b"planted")',
    '    return real(src,dst,*a,**k)',
    'os.replace=swap',
    'try: m.merge(file,rules,out)',
    'except m.Refused as e: err=str(e)',
    'finally: os.replace=real',
  ].join('\n'), [
    'granted=json.loads(pathlib.Path(claude+".parked","settings.local.json").read_bytes())',
    'assert err is None and granted["permissions"]["allow"]==rules, (err, granted)',
  ].join('\n'));
});
test('a hard link made to the staged file is refused before any grant byte is written', () => {
  race(fixture(), [
    'real=os.open',
    'def spy(path,flags,*a,**k):',
    '    fd=real(path,flags,*a,**k)',
    '    if flags & os.O_EXCL and os.path.basename(path).startswith(".settings.local."): os.link(path,os.path.join(other,"staged-alias"),src_dir_fd=k.get("dir_fd"))',
    '    return fd',
    'os.open=spy',
    'try: m.merge(file,rules,out)',
    'except m.Refused as e: err=str(e)',
    'finally: os.open=real',
  ].join('\n'), [
    'assert err and "linked elsewhere" in err, err',
    'assert os.stat(os.path.join(other,"staged-alias")).st_size==0',
    'assert [n for n in os.listdir(claude) if n.startswith(".settings.local.")]==[]',
    'assert "permissions" not in json.loads(pathlib.Path(file).read_bytes())',
  ].join('\n'));
});
test('a directory swapped while it is being opened is refused before anything is staged', () => {
  race(fixture(), [
    'real=os.open',
    'def swap(path,flags,*a,**k):',
    '    fd=real(path,flags,*a,**k)',
    '    if flags & os.O_DIRECTORY: os.rename(claude,claude+".parked"); os.mkdir(claude)',
    '    return fd',
    'os.open=swap',
    'try: m.merge(file,rules,out)',
    'except m.Refused as e: err=str(e)',
    'finally: os.open=real',
  ].join('\n'), [
    'assert err and "changed while opening" in err, err',
    'assert os.listdir(claude)==[] and sorted(os.listdir(claude+".parked"))==["settings.local.json"]',
    'assert "permissions" not in json.loads(pathlib.Path(claude+".parked","settings.local.json").read_bytes())',
  ].join('\n'));
});
test('an aliased ancestor of the actor worktree is refused before output or settings writes', () => {
  const f = fixture(), alias = path.join(f.root, 'alias'); fs.symlinkSync(f.root, alias);
  f.request.association = json(path.join(f.root, 'association.json'), { ...f.a, worktree: { ...f.a.worktree, path: path.join(alias, path.basename(f.actor)) } });
  const before = fs.readFileSync(f.file), result = invoke(f);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /noncanonical or aliased path/);
  assert.deepEqual(fs.readFileSync(f.file), before); assert.equal(fs.existsSync(f.request.out), false);
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
