'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const helper = import(pathToFileURL(path.resolve(__dirname, '../scripts/fvs-checker-build.mjs')));
const roots = [];
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const tool = (file) => ({ path: file, sha256: sha256(fs.readFileSync(file)) });
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

after(() => {
  // These are exclusively allocated test roots, never environment-provided cleanup paths.
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(behavior = '', sources = null, searchEntries = []) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fvs-checker-build-test-'));
  roots.push(root);
  const source = path.join(root, 'original');
  fs.mkdirSync(source);
  const files = {
    'lean-toolchain': 'leanprover/lean4:v4.31.0\n',
    'lakefile.toml': 'name = "Sample"\n[[lean_lib]]\nname = "Sample"\n',
    'lake-manifest.json': JSON.stringify({ version: '1.1.0', packagesDir: '.lake/packages', packages: [], name: 'Sample', lakeDir: '.lake' }),
    ...(sources ?? { 'Sample.lean': 'module\npublic theorem checked : True := True.intro\n' }),
  };
  for (const [file, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.writeFileSync(path.join(source, file), bytes);
  }
  const bin = path.join(root, 'toolchain', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(root, 'toolchain', 'lib', 'lean'), { recursive: true });
  fs.writeFileSync(path.join(root, 'toolchain', 'lib', 'lean', 'external.olean'), 'fixed external input');
  const script = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) {
  console.log(path.basename(process.argv[1]) === 'lake' ? 'Lake version fixture (Lean version 4.31.0)' : 'Lean (version 4.31.0, fixture)');
} else if (process.argv.includes('env')) {
  console.log([path.join(process.cwd(),'.lake/build/lib/lean'),path.join(path.dirname(path.dirname(process.argv[1])),'lib/lean'),...${JSON.stringify(searchEntries)}.map(dir=>path.resolve(process.cwd(),dir))].join(':'));
} else {
  ${behavior}
  const lib = path.join(process.cwd(), '.lake/build/lib/lean');
  const ir = path.join(process.cwd(), '.lake/build/ir');
  fs.mkdirSync(lib, {recursive:true}); fs.mkdirSync(ir, {recursive:true});
  for (const suffix of ['olean','olean.server','olean.private','ir']) fs.writeFileSync(path.join(lib,'Sample.'+suffix),'fixture '+suffix);
  fs.writeFileSync(path.join(lib,'Sample.ilean'),JSON.stringify({module:'Sample',directImports:[]}));
  fs.writeFileSync(path.join(ir,'Sample.setup.json'),JSON.stringify({name:'Sample',isModule:true,plugins:[],dynlibs:[],importArts:{}}));
  fs.writeFileSync(path.join(ir,'env.json'),JSON.stringify(process.env));
}
`;
  for (const name of ['lean', 'lake']) fs.writeFileSync(path.join(bin, name), script, { mode: 0o700 });
  const request = { schema: 'fvs-checker/build-request', version: 1, runId: 'test', purpose: 'standalone',
    source: { kind: 'worktree', root: source, files: Object.keys(files) }, out: path.join(root, 'run'),
    lean: tool(path.join(bin, 'lean')), lake: tool(path.join(bin, 'lake')), libraries: ['Sample'], deadlineMs: Date.now() + 15000 };
  return { root, source, files, request };
}

async function build(request) { return (await helper).buildCheckerSnapshot(request); }
function git(root, ...args) {
  const result = spawnSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8', env: {
    PATH: '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
  } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function commitFixture(f) {
  git(f.source, 'init', '--initial-branch=fixture');
  git(f.source, 'add', '.');
  git(f.source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', 'commit', '--no-verify', '--no-gpg-sign', '-m', 'test(checker-build): pin frozen source');
  return git(f.source, 'rev-parse', 'HEAD');
}

function duplicateImportFixture(count, wrongOrigin = false) {
  const names = ['Sample', ...Array.from({ length: count - 1 }, (_, i) => `Sample.Part${i}`)];
  const entry = '.lake/packages/Dep/.lake/build/lib/lean';
  const sources = Object.fromEntries(names.map(name => [name.replaceAll('.', '/') + '.lean', 'module\npublic theorem checked : True := True.intro\n']));
  const behavior = `process.on('exit',()=>{for(const [index,name]of ${JSON.stringify(names)}.entries()){
    const rel=name.replaceAll('.','/');const dir=path.join(process.cwd(),'.lake/build');
    const stem=path.join(dir,'lib/lean',rel);const setup=path.join(dir,'ir',rel+'.setup.json');
    fs.mkdirSync(path.dirname(stem),{recursive:true});fs.mkdirSync(path.dirname(setup),{recursive:true});
    for(const suffix of ['olean','olean.server','olean.private','ir'])fs.writeFileSync(stem+'.'+suffix,'project '+suffix);
    const imported=${wrongOrigin}&&index===1?'Wrong.Module':'Shared.Module';
    const artifact=path.join(process.cwd(),${JSON.stringify(entry)},'Shared/Module.olean');
    fs.writeFileSync(stem+'.ilean',JSON.stringify({module:name,directImports:[[imported,false,false,false]]}));
    fs.writeFileSync(setup,JSON.stringify({name,isModule:true,plugins:[],dynlibs:[],importArts:{[imported]:[artifact]}}));
  }});`;
  const f = fixture(behavior, sources, [entry]);
  const deps = path.join(f.root, 'deps');
  const directory = path.join(deps, 'Dep/.lake/build/lib/lean/Shared');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'Module.olean'), Buffer.alloc(64 * 1024, 37));
  fs.writeFileSync(path.join(deps, 'Dep/empty.txt'), '');
  f.request.dependencies = { root: deps };
  return { ...f, artifact: path.join(f.request.out, 'source', entry, 'Shared/Module.olean'), originalArtifact: path.join(directory, 'Module.olean') };
}

test('closed requests reject caller verdicts, path aliases, duplicates and worktree auto inputs', async () => {
  for (const change of [
    (r) => { r.pass = true; },
    (r) => { r.source.files.push('sub/../Sample.lean'); },
    (r) => { r.source.files.push('Sample.lean'); },
    (r) => { r.source.files.push('.lake/build/old.olean'); },
    (r) => { r.purpose = 'auto'; },
    (r) => { r.deadlineMs = Infinity; },
    (r) => { r.libraries = ['Sample', '--help']; },
  ]) {
    const f = fixture(); change(f.request);
    const result = await build(f.request);
    assert.notEqual(result.status, 'built');
    assert.equal(result.proofChecked, false);
    assert.equal(fs.existsSync(f.request.out), false);
  }
});

test('refuses expired deadlines before allocating an output directory', async () => {
  const f = fixture(); f.request.deadlineMs = Date.now() - 1;
  const result = await build(f.request);
  assert.match(result.reason, /deadline/);
  assert.equal(fs.existsSync(f.request.out), false);
});

if (process.platform === 'darwin') {
  test('protocol fixture captures multipart outputs and immutable receipts in an exclusive run', async () => {
    const f = fixture();
    const oldTmp = process.env.TMPDIR;
    const oldSecret = process.env.FVS_TEST_CREDENTIAL;
    const oldLeanPath = process.env.LEAN_PATH;
    const sentinel = 'not-in-child-environment-312ce8';
    process.env.FVS_TEST_CREDENTIAL = sentinel;
    process.env.LEAN_PATH = f.source;
    process.env.TMPDIR = f.source;
    let result;
    try { result = await build(f.request); } finally {
      for (const [key, value] of [['TMPDIR', oldTmp], ['FVS_TEST_CREDENTIAL', oldSecret], ['LEAN_PATH', oldLeanPath]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    assert.equal(result.status, 'built', result.reason);
    assert.equal(result.authority, 'build-only'); assert.equal(result.proofChecked, false);
    assert.deepEqual(result.modules.map((mod) => [mod.name, mod.source, mod.parts.length]), [['Sample', 'Sample.lean', 3]]);
    const env = json(path.join(result.buildRoot, 'ir', 'env.json'));
    assert.equal(env.FVS_TEST_CREDENTIAL, undefined); assert.equal(env.LEAN_PATH, undefined);
    assert.equal(env.HOME, path.join(f.request.out, 'home')); assert.equal(env.TMPDIR, path.join(f.request.out, 'tmp'));
    assert.equal(fs.readFileSync(path.join(f.source, 'Sample.lean'), 'utf8'), f.files['Sample.lean']);
    assert.deepEqual(result.externalImports, []);
    assert.equal(result.externalSearchPaths.some((dir) => dir.startsWith(result.projectRoot)), false);
    for (const receipt of [...result.receipts, ...Object.values(result.inventories), result.lean.runtime]) {
      assert.equal(sha256(fs.readFileSync(receipt.file)), receipt.sha256);
      assert.equal(fs.readFileSync(receipt.file, 'utf8').includes(sentinel), false);
    }
    const last = result.receipts.find((receipt) => receipt.argv.includes('build'));
    assert.deepEqual(last.argv.slice(-5), ['--no-cache', '--rehash', '--verbose', 'build', 'Sample']);
    assert.equal(last.exit, 0); assert.equal(last.timedOut, false);
    const before = fs.readFileSync(path.join(f.request.out, 'receipts', 'result.json'));
    const repeated = await build(f.request);
    assert.notEqual(repeated.status, 'built');
    assert.deepEqual(fs.readFileSync(path.join(f.request.out, 'receipts', 'result.json')), before);
  });

  test('named git export ignores dirty files and binds exact commit and tree', async () => {
    const f = fixture(); const commit = commitFixture(f);
    const tree = git(f.source, 'rev-parse', `${commit}^{tree}`);
    fs.writeFileSync(path.join(f.source, 'Sample.lean'), 'dirty broken candidate');
    const result = await build({ ...f.request, purpose: 'auto', source: { kind: 'git', root: f.source, commit, expectedTree: tree } });
    assert.equal(result.status, 'built', result.reason);
    assert.equal(result.source.commit, commit); assert.equal(result.source.tree, tree);
    assert.equal(fs.readFileSync(path.join(result.projectRoot, 'Sample.lean'), 'utf8'), f.files['Sample.lean']);
    assert.equal(fs.readFileSync(path.join(f.source, 'Sample.lean'), 'utf8'), 'dirty broken candidate');
    const failed = await build({ ...f.request, out: path.join(f.root, 'wrong-tree'), source: { kind: 'git', root: f.source, commit, expectedTree: 'a'.repeat(40) } });
    assert.notEqual(failed.status, 'built'); assert.match(failed.reason, /tree identity/);
  });

  test('nonzero and missing or partial output builds cannot succeed', async () => {
    for (const behavior of [
      'process.exit(9);',
      'process.exit(0);',
      "process.on('exit',()=>fs.unlinkSync(path.join(process.cwd(),'.lake/build/lib/lean/Sample.olean.private')));",
    ]) {
      const f = fixture(behavior);
      const result = await build(f.request);
      assert.notEqual(result.status, 'built'); assert.equal(result.proofChecked, false);
      assert.equal(fs.existsSync(path.join(f.request.out, 'receipts/result.json')), false);
      assert.equal(fs.existsSync(path.join(f.request.out, 'receipts/failure.json')), true);
      if (behavior.includes('exit(9)')) assert.equal(result.receipts.at(-1).exit, 9);
    }
  });

  test('total invocation deadline kills a hung process and retains its timeout receipt', async () => {
    const f = fixture('setInterval(()=>{},1000);');
    f.request.deadlineMs = Date.now() + 700;
    const started = Date.now();
    const result = await build(f.request);
    assert.notEqual(result.status, 'built');
    assert.ok(Date.now() - started < 4000);
    assert.ok(result.receipts.some((receipt) => receipt.timedOut && receipt.signal === 'SIGKILL'));
  });

  test('source or pinned tool drift during build invalidates a successful exit', async () => {
    for (const kind of ['source', 'tool']) {
      const f = fixture("fs.mkdirSync('.lake',{recursive:true});fs.writeFileSync('.lake/build-started','ready');const end=Date.now()+650;while(Date.now()<end){}");
      const target = kind === 'source' ? path.join(f.source, 'Sample.lean') : f.request.lean.path;
      const timer = setInterval(() => {
        if (fs.existsSync(path.join(f.request.out, 'source/.lake/build-started'))) {
          fs.appendFileSync(target, '\n// parent changed bytes\n'); clearInterval(timer);
        }
      }, 10);
      let result;
      try { result = await build(f.request); } finally { clearInterval(timer); }
      assert.notEqual(result.status, 'built');
      assert.match(result.reason, /changed/);
    }
  });

  test('confinement prevents build writes to original sources and copied source slots', async () => {
    for (const original of [false, true]) {
      const f = fixture();
      const target = original ? path.join(f.source, 'Sample.lean') : null;
      const behavior = `fs.writeFileSync(${target ? JSON.stringify(target) : "path.join(process.cwd(),'Sample.lean')"},'changed');`;
      const script = fs.readFileSync(f.request.lake.path, 'utf8').replace('} else {', `} else { ${behavior}`);
      fs.writeFileSync(f.request.lake.path, script); f.request.lake = tool(f.request.lake.path);
      const result = await build(f.request);
      assert.notEqual(result.status, 'built');
      assert.equal(fs.readFileSync(path.join(f.source, 'Sample.lean'), 'utf8'), f.files['Sample.lean']);
    }
  });

  test('symlinks, hardlink aliases and output/source overlap refuse without destructive cleanup', async () => {
    for (const mode of ['symlink', 'hardlink', 'directory', 'overlap', 'protected-toolchain', 'existing']) {
      const f = fixture();
      if (mode === 'symlink') {
        fs.renameSync(path.join(f.source, 'Sample.lean'), path.join(f.root, 'saved'));
        fs.symlinkSync('../saved', path.join(f.source, 'Sample.lean'));
      } else if (mode === 'hardlink') fs.linkSync(path.join(f.source, 'Sample.lean'), path.join(f.root, 'alias'));
      else if (mode === 'directory') { fs.unlinkSync(path.join(f.source, 'Sample.lean')); fs.mkdirSync(path.join(f.source, 'Sample.lean')); }
      else if (mode === 'overlap') f.request.out = path.join(f.source, 'nested-output');
      else if (mode === 'protected-toolchain') f.request.out = path.join(f.root, 'toolchain', 'nested-output');
      else { fs.mkdirSync(f.request.out); fs.writeFileSync(path.join(f.request.out, 'keep'), 'untouched'); }
      const result = await build(f.request);
      assert.notEqual(result.status, 'built');
      if (mode === 'existing') assert.equal(fs.readFileSync(path.join(f.request.out, 'keep'), 'utf8'), 'untouched');
    }
  });

  test('mismatched configured toolchains refuse without invoking acquisition or build', async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.source, 'lean-toolchain'), 'leanprover/lean4:v4.35.0\n');
    const result = await build(f.request);
    assert.equal(result.status, 'unsupported'); assert.match(result.reason, /toolchain/);
    assert.equal(result.receipts.length, 0);
  });

  test('dependencies are independent copies and supplied identity is hashed', async () => {
    const f = fixture();
    const deps = path.join(f.root, 'deps'); fs.mkdirSync(path.join(deps, 'Dep'), { recursive: true });
    fs.writeFileSync(path.join(deps, 'Dep', 'source.lean'), 'frozen dependency');
    const identity = path.join(f.root, 'dependency-identity.json'); fs.writeFileSync(identity, '{}');
    f.request.dependencies = { root: deps, identity: { file: identity, sha256: sha256(fs.readFileSync(identity)) } };
    const result = await build(f.request);
    assert.equal(result.status, 'built', result.reason);
    assert.deepEqual(result.dependencies.changed, []);
    const copied = path.join(result.projectRoot, '.lake/packages/Dep/source.lean');
    assert.notEqual(fs.statSync(copied).ino, fs.statSync(path.join(deps, 'Dep/source.lean')).ino);
    assert.equal(fs.readFileSync(copied, 'utf8'), 'frozen dependency');
    const wrong = await build({ ...f.request, out: path.join(f.root, 'wrong-id'), dependencies: { root: deps, identity: { file: identity, sha256: 'a'.repeat(64) } } });
    assert.notEqual(wrong.status, 'built'); assert.match(wrong.reason, /identity mismatch/);
  });

  test('dependency and runtime byte drift invalidate successful builds', async () => {
    for (const kind of ['dependency', 'runtime']) {
      const f = fixture("fs.mkdirSync('.lake',{recursive:true});fs.writeFileSync('.lake/build-started','ready');const end=Date.now()+650;while(Date.now()<end){}");
      let target = path.join(f.root, 'toolchain/lib/lean/external.olean');
      if (kind === 'dependency') {
        const deps = path.join(f.root, 'deps'); fs.mkdirSync(deps);
        target = path.join(deps, 'source.lean'); fs.writeFileSync(target, 'fixed');
        f.request.dependencies = { root: deps };
      }
      const timer = setInterval(() => {
        if (fs.existsSync(path.join(f.request.out, 'source/.lake/build-started'))) {
          fs.appendFileSync(target, ' changed'); clearInterval(timer);
        }
      }, 10);
      let result;
      try { result = await build(f.request); } finally { clearInterval(timer); }
      assert.notEqual(result.status, 'built'); assert.match(result.reason, /changed/);
    }
  });

  test('dependency links remain inert and confined; escaping links are refused', async () => {
    for (const escape of [false, true]) {
      const f = fixture();
      const deps = path.join(f.root, 'deps'); fs.mkdirSync(deps);
      fs.writeFileSync(path.join(deps, 'README'), 'inert docs');
      fs.symlinkSync(escape ? '../original/Sample.lean' : 'README', path.join(deps, 'documentation-link'));
      f.request.dependencies = { root: deps };
      const result = await build(f.request);
      if (escape) { assert.notEqual(result.status, 'built'); assert.match(result.reason, /symlink escapes/); }
      else {
        assert.equal(result.status, 'built', result.reason);
        assert.equal(fs.readlinkSync(path.join(result.projectRoot, '.lake/packages/documentation-link')), 'README');
        assert.deepEqual(result.dependencies.changed, []);
      }
    }
  });

  test('undeclared external imports and project plugins cannot pass output validation', async () => {
    for (const plugin of [false, true]) {
      const change = plugin ?
        "s.plugins=[{path:path.join(process.cwd(),'Sample.lean')}];" :
        "i.directImports=[['Absent',false,false,false]];";
      const f = fixture(`process.on('exit',()=>{ const dir=path.join(process.cwd(),'.lake/build'); const sf=path.join(dir,'ir/Sample.setup.json'); const fi=path.join(dir,'lib/lean/Sample.ilean'); const s=JSON.parse(fs.readFileSync(sf)); const i=JSON.parse(fs.readFileSync(fi)); ${change} fs.writeFileSync(sf,JSON.stringify(s)); fs.writeFileSync(fi,JSON.stringify(i)); });`);
      const result = await build(f.request);
      assert.notEqual(result.status, 'built'); assert.match(result.reason, /external input|external import/);
    }
  });

  test('unused missing dependency search directories are receipted and omitted from resolved roots', async () => {
    const entry = '.lake/packages/Cli/.lake/build/lib/lean';
    const f = fixture('', null, [entry]);
    const deps = path.join(f.root, 'deps'); fs.mkdirSync(path.join(deps, 'Cli'), { recursive: true });
    fs.writeFileSync(path.join(deps, 'Cli', 'frozen.txt'), 'unused frozen dependency');
    f.request.dependencies = { root: deps };
    const result = await build(f.request);
    assert.equal(result.status, 'built', result.reason);
    const missing = path.join(result.projectRoot, entry);
    assert.equal(fs.existsSync(missing), false);
    assert.equal(result.externalSearchPaths.includes(missing), false);
    assert.ok(result.externalSearchPaths.every(dir => fs.statSync(dir).isDirectory()));
    const outputs = json(result.inventories.outputs.file);
    assert.ok(outputs.declaredSearchPaths.includes(missing));
    assert.deepEqual(outputs.missingSearchPaths, [missing]);
    const envReceipt = json(result.receipts.find(receipt => receipt.argv.includes('env')).file);
    assert.ok(fs.readFileSync(envReceipt.stdout.file, 'utf8').trim().split(':').includes(missing));
    assert.deepEqual(result.dependencies.changed, []);
  });

  test('returned search roots preserve declared precedence for same-name frozen dependency modules', async () => {
    const entries = ['Zeta', 'Alpha'].map(name => `.lake/packages/${name}/.lake/build/lib/lean`);
    const behavior = "process.on('exit',()=>{const file=path.join(process.cwd(),'.lake/build/lib/lean/Sample.ilean');const i=JSON.parse(fs.readFileSync(file));i.directImports=[['Shared.Module',false,false,false]];fs.writeFileSync(file,JSON.stringify(i));});";
    const f = fixture(behavior, null, entries);
    const deps = path.join(f.root, 'deps');
    for (const name of ['Zeta', 'Alpha']) {
      const dir = path.join(deps, name, '.lake/build/lib/lean/Shared');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'Module.olean'), `frozen ${name} module`);
    }
    f.request.dependencies = { root: deps };
    const result = await build(f.request);
    assert.equal(result.status, 'built', result.reason);
    const expected = [path.join(f.root, 'toolchain/lib/lean'), ...entries.map(entry => path.join(result.projectRoot, entry))];
    assert.deepEqual(result.externalSearchPaths, expected);
    const selected = result.externalSearchPaths.map(dir => path.join(dir, 'Shared/Module.olean')).find(file => fs.existsSync(file));
    assert.equal(selected, path.join(expected[1], 'Shared/Module.olean'));
    const outputs = json(result.inventories.outputs.file);
    assert.equal(outputs.externalFiles[selected].sha256, sha256('frozen Zeta module'));
    assert.equal(outputs.externalFiles[path.join(expected[2], 'Shared/Module.olean')], undefined);
  });

  test('duplicate imports across project modules do not multiply frozen artifact reads', async (t) => {
    const reads = [];
    const directories = [];
    for (const count of [1, 12]) {
      const f = duplicateImportFixture(count);
      const originalOpen = fs.openSync;
      const originalMkdir = fs.mkdirSync;
      let opened = 0;
      let created = 0;
      fs.openSync = (file, ...args) => {
        if (file === f.artifact) opened++;
        return originalOpen(file, ...args);
      };
      fs.mkdirSync = (directory, ...args) => {
        if (directory === path.join(f.request.out, 'source/Sample')) created++;
        return originalMkdir(directory, ...args);
      };
      let result;
      try { result = await build(f.request); } finally { fs.openSync = originalOpen; fs.mkdirSync = originalMkdir; }
      assert.equal(result.status, 'built', result.reason);
      assert.equal(result.modules.length, count);
      assert.ok(json(result.inventories.outputs.file).externalFiles[f.artifact]);
      assert.equal(json(result.dependencies.before.file)['Dep/empty.txt'].sha256, sha256(''));
      reads.push(opened);
      directories.push(created);
      t.diagnostic(JSON.stringify({ modules: count, artifactReads: opened, copyParentMkdirCalls: created }));
    }
    assert.ok(reads[0] >= 2, 'the artifact must remain subject to independent inventory passes');
    assert.equal(reads[1], reads[0], 'repeating an import must not add artifact reads');
    assert.equal(directories[1], 1, 'one owned copy parent must be created once');
  });

  test('deduplicated artifact validation still checks every module origin', async () => {
    const f = duplicateImportFixture(2, true);
    const result = await build(f.request);
    assert.equal(result.status, 'unverified');
    assert.match(result.reason, /resolved import layout/);
    assert.equal(result.proofChecked, false);
  });

  test('final inventories reject late byte, symlink and hardlink drift after a reused import', async () => {
    for (const change of ['bytes', 'symlink', 'hardlink']) {
      const f = duplicateImportFixture(2);
      const originalRead = fs.readFileSync;
      let changed = false;
      fs.readFileSync = (file, ...args) => {
        if (!changed && file === path.join(f.request.out, 'source/.lake/build/ir/Sample/Part0.setup.json')) {
          changed = true;
          if (change === 'bytes') fs.appendFileSync(f.artifact, 'changed');
          else if (change === 'hardlink') fs.linkSync(f.artifact, path.join(f.root, 'alias'));
          else { fs.unlinkSync(f.artifact); fs.symlinkSync(f.originalArtifact, f.artifact); }
        }
        return originalRead(file, ...args);
      };
      let result;
      try { result = await build(f.request); } finally { fs.readFileSync = originalRead; }
      assert.ok(changed);
      assert.equal(result.status, 'unverified');
      assert.match(result.reason, /changed|aliased|symlink/);
      assert.equal(fs.existsSync(path.join(f.request.out, 'receipts/result.json')), false);
    }
  });

  test('missing dependency search entries never supply unresolved direct or importArts modules', async () => {
    const entry = '.lake/packages/Cli/.lake/build/lib/lean';
    for (const explicit of [false, true]) {
      const behavior = `process.on('exit',()=>{const dir=path.join(process.cwd(),'.lake/build');const fi=path.join(dir,'lib/lean/Sample.ilean');const i=JSON.parse(fs.readFileSync(fi));i.directImports=[['Missing.Module',false,false,false]];fs.writeFileSync(fi,JSON.stringify(i));${explicit ? `const sf=path.join(dir,'ir/Sample.setup.json');const s=JSON.parse(fs.readFileSync(sf));s.importArts={'Missing.Module':[path.join(process.cwd(),${JSON.stringify(entry)},'Missing/Module.olean')]};fs.writeFileSync(sf,JSON.stringify(s));` : ''}});`;
      const f = fixture(behavior, null, [entry]);
      const deps = path.join(f.root, 'deps'); fs.mkdirSync(path.join(deps, 'Cli'), { recursive: true });
      fs.writeFileSync(path.join(deps, 'Cli', 'frozen.txt'), 'unused frozen dependency');
      f.request.dependencies = { root: deps };
      const result = await build(f.request);
      assert.equal(result.status, 'unverified');
      assert.match(result.reason, explicit ? /path does not exist/ : /missing or unresolved external import/);
      assert.equal(result.proofChecked, false);
      assert.ok(result.receipts.every(receipt => receipt.exit === 0));
      assert.equal(fs.existsSync(path.join(f.request.out, 'receipts/result.json')), false);
    }
  });

  test('missing search entries still reject symlink prefixes and roots outside the frozen snapshot', async () => {
    const entry = '.lake/packages/Cli/.lake/build/lib/lean';
    for (const symlink of [false, true]) {
      const f = fixture(symlink ? "fs.symlinkSync('../Other','.lake/packages/Cli/.lake');" : '', null, [symlink ? entry : '../outside/missing']);
      const deps = path.join(f.root, 'deps'); fs.mkdirSync(path.join(deps, 'Cli'), { recursive: true });
      fs.mkdirSync(path.join(deps, 'Other'));
      fs.writeFileSync(path.join(deps, 'Cli', 'frozen.txt'), 'unused frozen dependency');
      fs.writeFileSync(path.join(deps, 'Other', 'frozen.txt'), 'other frozen dependency');
      f.request.dependencies = { root: deps };
      const result = await build(f.request);
      assert.equal(result.status, 'unverified');
      assert.match(result.reason, symlink ? /symlink path/ : /search path escapes/);
    }
  });
} else {
  test('unqualified hosts return unsupported, with no build or allocated output', async () => {
    const f = fixture(); const result = await build(f.request);
    assert.equal(result.status, 'unsupported'); assert.equal(result.receipts.length, 0);
    assert.equal(fs.existsSync(f.request.out), false);
  });
}

// Explicit real lane: missing installed capability is a failure, never a skipped qualification.
if (process.env.FVS_CHECKER_BUILD_REAL === '1') {
  const bin = path.join(process.env.FVS_CHECKER_LEAN431_ROOT ?? path.join(os.homedir(), '.elan/toolchains/leanprover--lean4---v4.31.0'), 'bin');
  test('installed Lean4.31 builds fresh legacy and multipart project modules with actual external imports', async () => {
    const f = fixture('', {
      'Sample.lean': 'import Sample.Defs\ntheorem checked : answer = 1 := rfl\n',
      'Sample/Defs.lean': 'module\npublic import Std\npublic def answer : Nat := 1\n',
    });
    f.request.lean = tool(path.join(bin, 'lean')); f.request.lake = tool(path.join(bin, 'lake')); f.request.deadlineMs = Date.now() + 180000;
    const result = await build(f.request);
    assert.equal(result.status, 'built', result.reason);
    assert.deepEqual(result.modules.map((mod) => [mod.name, mod.parts.length]), [['Sample', 1], ['Sample.Defs', 3]]);
    assert.ok(result.externalImports.includes('Std'));
    const outputs = json(result.inventories.outputs.file);
    assert.ok(Object.keys(outputs.externalFiles).some((file) => file.endsWith('/Std.olean')));
    assert.equal(result.proofChecked, false);
  });
  test('installed compiler failure cannot reuse an old project build cache', async () => {
    const f = fixture('', { 'Sample.lean': 'theorem broken : True := missingProof\n' });
    const old = path.join(f.source, '.lake/build/lib/lean'); fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, 'Sample.olean'), 'stale artifact must stay untouched');
    f.request.lean = tool(path.join(bin, 'lean')); f.request.lake = tool(path.join(bin, 'lake')); f.request.deadlineMs = Date.now() + 180000;
    const result = await build(f.request);
    assert.notEqual(result.status, 'built');
    assert.equal(result.receipts.at(-1).exit, 1);
    assert.equal(fs.readFileSync(path.join(old, 'Sample.olean'), 'utf8'), 'stale artifact must stay untouched');
    assert.equal(fs.existsSync(path.join(f.request.out, 'receipts/result.json')), false);
  });
  test('installed Lean direct profile builds one standalone source without Lake or inherited paths', async () => {
    const f = fixture('', { 'Sample.lean': 'module\npublic theorem checked : True := True.intro\n' });
    f.request.source.files = ['Sample.lean']; delete f.request.lake; delete f.request.libraries;
    f.request.lean = tool(path.join(bin, 'lean')); f.request.deadlineMs = Date.now() + 180000;
    const result = await build(f.request);
    assert.equal(result.status, 'built', result.reason);
    assert.equal(result.modules.length, 1); assert.equal(result.modules[0].parts.length, 3);
    assert.equal(result.lake, undefined);
  });
}
