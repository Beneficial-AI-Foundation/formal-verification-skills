import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { extractionPolicy, protectedDirs } from './fvs-probe-inventory.mjs';

const SHA = /^[a-f0-9]{64}$/;
const OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)*$/;
const MAX_LOG = 32 * 1024 * 1024;
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = (message, status = 'unverified') => { throw Object.assign(new Error(message), { buildStatus: status }); };
const within = (root, file) => {
  const rel = path.relative(root, file);
  return rel === '' || rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
const gitHash = (kind, bytes, length) => crypto.createHash(length === 40 ? 'sha1' : 'sha256').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');

function keys(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    fail('invalid closed build request');
  }
}

function relative(value, dot = false) {
  if (typeof value !== 'string' || !value || /[\\\u0000-\u001f\u007f]/.test(value) ||
      path.posix.isAbsolute(value) || path.posix.normalize(value) !== value ||
      value.split('/').some((part) => part === '..' || (!dot && part === '.'))) fail('unsafe relative path');
  return value;
}

function absolute(value, exists = true, allowMissingTail = false) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('expected a canonical absolute path');
  }
  // Checking every component also rejects symlinks that resolve back inside the tree.
  let current = path.parse(value).root;
  for (const part of value.slice(current.length).split('/').filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) {
      if (allowMissingTail) return value;
      if (exists || current !== value) fail('path does not exist');
    } else if (stat.isSymbolicLink()) fail('symlink path is unsupported');
  }
  return value;
}

function validate(request) {
  keys(request, ['schema', 'version', 'runId', 'purpose', 'source', 'out', 'lean', 'lake', 'libraries', 'sourceRoot', 'dependencies', 'deadlineMs'],
    ['schema', 'version', 'runId', 'purpose', 'source', 'out', 'lean', 'deadlineMs']);
  if (request.schema !== 'fvs-checker/build-request' || request.version !== 1 ||
      typeof request.runId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(request.runId) ||
      !['auto', 'standalone'].includes(request.purpose) || !Number.isSafeInteger(request.deadlineMs)) fail('invalid build request identity/deadline');
  if (!request.source || typeof request.source !== 'object') fail('invalid source');
  if (request.source.kind === 'git') {
    keys(request.source, ['kind', 'root', 'commit', 'expectedTree'], ['kind', 'root', 'commit']);
    if (!OBJECT.test(request.source.commit) || (request.source.expectedTree !== undefined && !OBJECT.test(request.source.expectedTree))) fail('git source requires full object identities');
  } else if (request.source.kind === 'worktree') {
    keys(request.source, ['kind', 'root', 'files']);
    if (request.purpose !== 'standalone' || !Array.isArray(request.source.files) || !request.source.files.length) fail('worktree capture is standalone pre-edit only');
    request.source.files.forEach((file) => {
      relative(file);
      if (file.split('/').some((part) => part === '.git' || part === '.lake')) fail('source inventory cannot include git metadata or build caches');
    });
    if (new Set(request.source.files).size !== request.source.files.length) fail('duplicate source path');
  } else fail('unsupported source kind', 'unsupported');
  for (const tool of [request.lean, request.lake].filter(Boolean)) {
    keys(tool, ['path', 'sha256']);
    absolute(tool.path);
    if (!SHA.test(tool.sha256)) fail('tool SHA-256 is required');
  }
  if (path.basename(request.lean.path) !== 'lean' || (request.lake &&
      (path.basename(request.lake.path) !== 'lake' || path.dirname(request.lake.path) !== path.dirname(request.lean.path)))) fail('pinned Lean/Lake must share the toolchain bin directory');
  if (request.libraries !== undefined && (!Array.isArray(request.libraries) || !request.libraries.length ||
      request.libraries.some((name) => typeof name !== 'string' || !NAME.test(name)) || new Set(request.libraries).size !== request.libraries.length)) fail('invalid declared libraries');
  relative(request.sourceRoot ?? '.', true);
  if (request.dependencies) {
    keys(request.dependencies, ['root', 'identity'], ['root']);
    absolute(request.dependencies.root);
    if (request.dependencies.identity) {
      keys(request.dependencies.identity, ['file', 'sha256']);
      absolute(request.dependencies.identity.file);
      if (!SHA.test(request.dependencies.identity.sha256)) fail('invalid dependency identity');
    }
  }
  absolute(request.source.root);
  absolute(request.out, false);
}

// This helper deliberately leaves its exclusive run directory in place, including on failure.
// It never cleans a caller's tree or uses an inherited TMPDIR as a cleanup target.
export async function buildCheckerSnapshot(input) {
  let request;
  let root;
  let created = false;
  let sequence = 0;
  let sourceFiles = {};
  let sourceIdentity;
  let dependencyFiles = {};
  let dependenciesReady = false;
  let runtimeFiles = {};
  let runtimeRoot;
  let ownedDependencies;
  let policyIdentity;
  const readBuffer = Buffer.allocUnsafe(1024 * 1024);
  const receipts = [];
  const result = { schema: 'fvs-checker/build-result', version: 1, runId: input?.runId ?? null,
    status: 'unverified', authority: 'build-only', proofChecked: false, receipts };
  const tick = () => { if (Date.now() >= request.deadlineMs) fail('build deadline exceeded'); };
  const digest = (file, aliases = false, checked = false) => {
    tick();
    if (!checked) absolute(file);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || (!aliases && before.nlink !== 1)) fail('non-regular or aliased input/output file');
      const sha = crypto.createHash('sha256');
      let remaining = before.size;
      while (remaining > 0) {
        tick();
        const count = fs.readSync(fd, readBuffer, 0, Math.min(readBuffer.length, remaining), null);
        if (!count) fail('file changed while hashing');
        sha.update(readBuffer.subarray(0, count)); remaining -= count;
      }
      const after = fs.fstatSync(fd);
      tick();
      if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || (!aliases && after.nlink !== 1)) fail('file changed while hashing');
      return { sha256: sha.digest('hex'), size: after.size };
    } finally { fs.closeSync(fd); }
  };
  const tree = (directory, aliases = false, inertLinks = false) => {
    absolute(directory);
    if (!fs.statSync(directory).isDirectory()) fail('inventory root is not a directory');
    const files = {};
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir).sort()) {
        tick();
        const file = path.join(dir, entry);
        const stat = fs.lstatSync(file);
        if (stat.isDirectory()) walk(file);
        else if (stat.isSymbolicLink() && inertLinks) {
          const target = fs.readlinkSync(file);
          if (path.isAbsolute(target) || !within(directory, path.resolve(path.dirname(file), target))) fail('dependency symlink escapes snapshot');
          // Unused documentation links can be dangling. They are never followed or treated as files.
          files[path.relative(directory, file)] = { symlink: target, sha256: hash(target), size: Buffer.byteLength(target) };
        } else files[path.relative(directory, file)] = digest(file, aliases, true);
      }
    };
    walk(directory);
    return files;
  };
  const save = (name, value) => {
    const file = path.join(root, 'receipts', name);
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    fs.writeFileSync(file, bytes, { mode: 0o400, flag: 'wx' });
    return { file, sha256: hash(bytes) };
  };
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const checkInputs = () => {
    tick();
    for (const tool of [request.lean, request.lake].filter(Boolean)) if (digest(tool.path, true).sha256 !== tool.sha256) fail('pinned tool bytes changed');
    if (runtimeRoot && !equal(tree(runtimeRoot, true), runtimeFiles)) fail('toolchain runtime bytes changed');
    if (policyIdentity && digest(policyIdentity.file).sha256 !== policyIdentity.sha256) fail('confinement policy changed');
    for (const [file, identity] of Object.entries(sourceFiles)) {
      if (!equal(digest(path.join(root, 'source', file)), identity)) fail('snapshot source/config bytes changed');
      if (request.source.kind === 'worktree' && !equal(digest(path.join(request.source.root, file)), identity)) fail('pre-edit source/config bytes changed');
    }
    if (dependenciesReady && request.dependencies) {
      if (!equal(tree(request.dependencies.root, false, true), dependencyFiles)) fail('supplied dependency snapshot changed');
      if (request.dependencies.identity && digest(request.dependencies.identity.file).sha256 !== request.dependencies.identity.sha256) fail('dependency identity changed');
    }
    return hash(JSON.stringify({ sourceFiles, runtimeFiles, dependencyFiles }));
  };
  const env = () => ({
    PATH: `${path.dirname(request.lean.path)}:/usr/bin:/bin`, HOME: path.join(root, 'home'),
    TMPDIR: path.join(root, 'tmp'), LANG: 'C', LC_ALL: 'C',
    XDG_CACHE_HOME: path.join(root, 'tmp', 'cache'), XDG_CONFIG_HOME: path.join(root, 'home'),
    XDG_DATA_HOME: path.join(root, 'home'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0', LAKE_NO_CACHE: '1',
  });
  const run = async (argv, cwd, confined = false) => {
    const before = checkInputs();
    const id = String(++sequence).padStart(4, '0');
    const actual = confined ? ['/usr/bin/sandbox-exec', '-f', path.join(root, 'build.sb'), ...argv] : argv;
    const startedAt = Date.now();
    const execution = await new Promise((resolve) => {
      let timedOut = false;
      let overflow = false;
      let size = 0;
      const stdout = [];
      const stderr = [];
      const child = spawn(actual[0], actual.slice(1), { cwd, env: env(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
      const timer = setTimeout(() => { timedOut = true; kill(); }, Math.min(2147483647, Math.max(1, request.deadlineMs - Date.now())));
      let error;
      child.on('error', (value) => { error = value.code ?? 'spawn-error'; });
      const collect = (items) => (data) => {
        size += data.length;
        if (size > MAX_LOG) { overflow = true; kill(); } else items.push(data);
      };
      child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
      child.on('close', (exit, signal) => {
        clearTimeout(timer);
        kill();
        resolve({ exit, signal, timedOut, overflow, error, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      });
    });
    const stdout = save(`${id}.stdout`, execution.stdout);
    const stderr = save(`${id}.stderr`, execution.stderr);
    let after;
    let drift;
    try { after = checkInputs(); } catch (error) { drift = error.message; }
    const receipt = { argv: actual, cwd, exit: execution.exit, signal: execution.signal, timedOut: execution.timedOut,
      startedAt, endedAt: Date.now(), stdout, stderr, inputsBefore: before, inputsAfter: after ?? null,
      outputLimitExceeded: execution.overflow,
      ...(execution.error ? { error: execution.error } : {}), ...(drift ? { drift } : {}) };
    receipts.push({ ...save(`${id}.json`, receipt), argv: actual, cwd, exit: execution.exit, signal: execution.signal, timedOut: execution.timedOut });
    if (drift || execution.exit !== 0 || execution.signal || execution.timedOut || execution.overflow || execution.error) fail(drift ?? 'build subprocess failed');
    return execution.stdout;
  };
  try {
    validate(input);
    request = structuredClone(input);
    tick();
    if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) fail('native checker build confinement unavailable', 'unsupported');
    root = request.out;
    const protectedPaths = [...protectedDirs(), path.dirname(path.dirname(request.lean.path)), request.source.root, ...(request.dependencies ? [request.dependencies.root] : [])];
    for (const directory of protectedPaths) {
      if (within(directory, root) || within(root, directory)) fail('output overlaps source, dependency or protected directory');
    }
    fs.mkdirSync(root, { mode: 0o700 }); created = true;
    for (const dir of ['source', 'receipts', 'tmp', 'home', 'output']) fs.mkdirSync(path.join(root, dir), { mode: 0o700 });
    Object.assign(result, { root, projectRoot: path.join(root, 'source'), buildRoot: path.join(root, 'source', '.lake', 'build') });
    const project = result.projectRoot;
    const copyDirectories = new Set([project]);
    const copyDirectory = (directory) => {
      if (!copyDirectories.has(directory)) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        copyDirectories.add(directory);
      }
    };
    const copy = (from, to) => {
      tick();
      absolute(from);
      copyDirectory(path.dirname(to));
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
      fs.chmodSync(to, fs.statSync(from).mode & 0o777);
    };
    if (request.source.kind === 'worktree') {
      const original = {};
      for (const file of [...request.source.files].sort()) {
        original[file] = digest(path.join(request.source.root, file));
        copy(path.join(request.source.root, file), path.join(project, file));
        if (!equal(digest(path.join(project, file)), original[file]) || !equal(digest(path.join(request.source.root, file)), original[file])) fail('pre-edit capture changed during copy');
      }
      sourceFiles = original;
      sourceIdentity = { kind: 'worktree', originalRoot: request.source.root, commit: null, tree: null, files: sourceFiles };
    } else {
      const git = async (...args) => run(['/usr/bin/git', ...args], request.source.root);
      if ((await git('rev-parse', '--show-toplevel')).toString().trim() !== request.source.root) fail('git root is not the requested project');
      const commitBytes = await git('cat-file', 'commit', request.source.commit);
      if (gitHash('commit', commitBytes, request.source.commit.length) !== request.source.commit) fail('git commit object identity mismatch');
      const treeId = (await git('rev-parse', `${request.source.commit}^{tree}`)).toString().trim();
      if (!OBJECT.test(treeId) || !commitBytes.toString('utf8').startsWith(`tree ${treeId}\n`) ||
          (request.source.expectedTree && treeId !== request.source.expectedTree)) fail('git tree identity mismatch');
      const verifyTree = async (oid) => {
        const bytes = await git('cat-file', 'tree', oid);
        if (gitHash('tree', bytes, oid.length) !== oid) fail('git tree object identity mismatch');
      };
      await verifyTree(treeId);
      const listing = (await git('ls-tree', '-rzt', '--full-tree', request.source.commit)).toString('utf8');
      for (const entry of listing.split('\0').filter(Boolean)) {
        const directory = /^040000 tree ([a-f0-9]+)\t(.+)$/.exec(entry);
        if (directory) { relative(directory[2]); await verifyTree(directory[1]); continue; }
        const match = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/.exec(entry);
        if (!match) fail('git export contains unsupported symlink/submodule/layout', 'unsupported');
        const [, mode, oid, file] = match;
        relative(file);
        if (file.split('/').some((part) => part === '.git' || part === '.lake')) fail('git source contains metadata or build cache');
        const bytes = await git('cat-file', 'blob', oid);
        if (gitHash('blob', bytes, oid.length) !== oid) fail('git export blob identity mismatch');
        const dest = path.join(project, file);
        copyDirectory(path.dirname(dest));
        fs.writeFileSync(dest, bytes, { flag: 'wx', mode: mode === '100755' ? 0o700 : 0o600 });
        sourceFiles[file] = digest(dest);
      }
      sourceIdentity = { kind: 'git', originalRoot: request.source.root, commit: request.source.commit, tree: treeId, files: sourceFiles };
    }
    if (!Object.keys(sourceFiles).length) fail('empty source snapshot');
    result.source = sourceIdentity;
    const sourceInventory = save('source.json', sourceIdentity);
    result.inventories = { source: sourceInventory };
    const sourceRoot = path.join(project, request.sourceRoot ?? '.');
    absolute(sourceRoot);
    const configured = sourceFiles['lakefile.toml'] || sourceFiles['lakefile.lean'];
    if (configured && (!request.lake || !request.libraries?.length || !sourceFiles['lean-toolchain'] || !sourceFiles['lake-manifest.json'])) fail('configured builds require pinned Lake, libraries, toolchain and manifest', 'unsupported');
    if (configured && fs.readFileSync(path.join(project, 'lean-toolchain'), 'utf8').trim() !== 'leanprover/lean4:v4.31.0') fail('configured toolchain does not match pinned Lean 4.31.0', 'unsupported');
    if (sourceFiles['lakefile.toml'] && sourceFiles['lakefile.lean']) fail('ambiguous Lake configuration', 'unsupported');
    const moduleSources = Object.keys(sourceFiles).filter((file) => file.endsWith('.lean') && file !== 'lakefile.lean' && within(sourceRoot, path.join(project, file)))
      .map((source) => ({ source, name: path.relative(sourceRoot, path.join(project, source)).slice(0, -5).split(path.sep).join('.') }))
      .filter(({ name }) => !request.libraries || request.libraries.some((lib) => name === lib || name.startsWith(`${lib}.`)));
    if (!moduleSources.length || moduleSources.some(({ name }) => !NAME.test(name))) fail('unsupported or empty source/module layout', 'unsupported');
    if (request.libraries?.some((lib) => !moduleSources.some(({ name }) => name === lib || name.startsWith(`${lib}.`)))) fail('declared library has no source modules');
    if (!configured && (moduleSources.length !== 1 || request.dependencies)) fail('direct Lean profile requires one source and no project dependencies', 'unsupported');

    // The compiler's default imports and native runtime are authoritative inputs too.
    const toolRoot = path.dirname(path.dirname(request.lean.path));
    const runtimeDir = path.join(toolRoot, 'lib');
    if (fs.existsSync(runtimeDir)) {
      runtimeRoot = runtimeDir;
      runtimeFiles = tree(runtimeRoot, true);
    }
    const protect = [...protectedPaths, toolRoot, ...Object.keys(sourceFiles).map((file) => path.join(project, file))];
    fs.writeFileSync(path.join(root, 'build.sb'), extractionPolicy({ projectRoot: project, rustProject: project,
      outputDir: path.join(root, 'output'), privateTmp: path.join(root, 'tmp'), protect }), { mode: 0o400, flag: 'wx' });
    policyIdentity = { file: path.join(root, 'build.sb'), ...digest(path.join(root, 'build.sb')) };
    result.policy = policyIdentity;
    const leanVersion = (await run([request.lean.path, '--version'], project, true)).toString().trim();
    if (!/^Lean \(version 4\.31\.0(?:,|\))/.test(leanVersion)) fail('only Lean 4.31.0 is qualified', 'unsupported');
    result.lean = { ...request.lean, version: leanVersion, runtime: save('runtime.json', { root: runtimeRoot ?? null, files: runtimeFiles }) };
    if (request.lake) {
      const version = (await run([request.lake.path, '--version'], project, true)).toString().trim();
      if (!/Lean version 4\.31\.0(?:\)|,|$)/.test(version)) fail('only Lake for Lean 4.31.0 is qualified', 'unsupported');
      result.lake = { ...request.lake, version };
    }
    if (request.dependencies) {
      if (within(request.source.root, request.dependencies.root) && request.dependencies.root !== path.join(request.source.root, '.lake', 'packages')) fail('unsupported dependency root inside source');
      dependencyFiles = tree(request.dependencies.root, false, true);
      if (request.dependencies.identity && digest(request.dependencies.identity.file).sha256 !== request.dependencies.identity.sha256) fail('dependency identity mismatch');
      ownedDependencies = path.join(project, '.lake', 'packages');
      for (const [file, identity] of Object.entries(dependencyFiles)) {
        const destination = path.join(ownedDependencies, file);
        if (identity.symlink !== undefined) {
          copyDirectory(path.dirname(destination));
          fs.symlinkSync(identity.symlink, destination);
        } else copy(path.join(request.dependencies.root, file), destination);
      }
      if (!equal(tree(ownedDependencies, false, true), dependencyFiles)) fail('dependency copy mismatch');
    }
    const depsBefore = save('dependencies-before.json', dependencyFiles);
    dependenciesReady = true;
    if (configured) {
      const manifest = JSON.parse(fs.readFileSync(path.join(project, 'lake-manifest.json'), 'utf8'));
      if (!Array.isArray(manifest.packages) || (manifest.packagesDir ?? '.lake/packages') !== '.lake/packages' || (manifest.lakeDir ?? '.lake') !== '.lake' ||
          new Set(manifest.packages.map((pkg) => pkg.name)).size !== manifest.packages.length ||
          manifest.packages.some((pkg) => pkg.type !== 'git' || !request.dependencies || !NAME.test(pkg.name) || !OBJECT.test(pkg.rev))) fail('unsupported dependency manifest layout', 'unsupported');
      for (const pkg of manifest.packages) {
        if (!fs.existsSync(path.join(ownedDependencies, pkg.name))) fail('missing frozen dependency package');
        if (pkg.subDir) relative(pkg.subDir);
      }
      await run([request.lake.path, '--no-cache', '--rehash', '--verbose', 'build', ...request.libraries], project, true);
    } else {
      fs.mkdirSync(path.join(result.buildRoot, 'lib', 'lean'), { recursive: true });
      const stem = path.join(result.buildRoot, 'lib', 'lean', moduleSources[0].name.split('.').join('/'));
      fs.mkdirSync(path.dirname(stem), { recursive: true });
      await run([request.lean.path, '--root', sourceRoot, '-o', `${stem}.olean`, '-i', `${stem}.ilean`, path.join(project, moduleSources[0].source)], project, true);
    }
    const declaredSearchPaths = configured ? (await run([request.lake.path, 'env', '/usr/bin/printenv', 'LEAN_PATH'], project, true)).toString().trim().split(path.delimiter).filter(Boolean) : [];
    declaredSearchPaths.push(path.join(toolRoot, 'lib', 'lean'));
    const searchPaths = [];
    const missingSearchPaths = [];
    for (const directory of declaredSearchPaths) {
      const ownedDependency = ownedDependencies && within(ownedDependencies, directory);
      if (directory !== path.join(result.buildRoot, 'lib', 'lean') && directory !== path.join(toolRoot, 'lib', 'lean') &&
          !ownedDependency) fail('search path escapes frozen project/dependencies/toolchain');
      // Lake lists unused dependencies too; absent build directories are not import evidence.
      absolute(directory, true, Boolean(ownedDependency));
      const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
      if (!stat) { missingSearchPaths.push(directory); continue; }
      absolute(directory);
      if (!stat.isDirectory()) fail('search path is not a directory');
      searchPaths.push(directory);
    }
    checkInputs();
    const depsAfter = request.dependencies ? tree(request.dependencies.root, false, true) : {};
    const changed = Object.keys({ ...dependencyFiles, ...depsAfter }).filter((file) => !equal(dependencyFiles[file], depsAfter[file]));
    const depReceipt = { root: request.dependencies?.root ?? null, ...(request.dependencies?.identity ? { identity: request.dependencies.identity } : {}),
      before: depsBefore, after: save('dependencies-after.json', depsAfter), changed };
    let ownedAfter;
    if (ownedDependencies) {
      ownedAfter = tree(ownedDependencies, false, true);
      const ownedChanges = Object.keys({ ...dependencyFiles, ...ownedAfter }).filter((file) => !equal(dependencyFiles[file], ownedAfter[file]));
      depReceipt.owned = { root: ownedDependencies, after: save('dependencies-owned-after.json', ownedAfter), changed: ownedChanges };
      if (ownedChanges.some((file) => !file.split('/').includes('.lake') && !file.endsWith('/.git/index'))) fail('owned dependency source/config changed');
    }
    result.dependencies = depReceipt;
    if (changed.length) fail('dependency snapshot changed');
    const outputFiles = tree(result.buildRoot);
    const libRoot = path.join(result.buildRoot, 'lib', 'lean');
    const externalPaths = new Set(searchPaths.filter((directory) => directory !== libRoot));
    const externalImports = new Set();
    const externalFiles = {};
    const externalFile = (file) => {
      tick();
      if (Object.hasOwn(externalFiles, file)) return;
      absolute(file);
      const identity = digest(file, within(toolRoot, file), true);
      const expected = within(runtimeDir, file) ? runtimeFiles[path.relative(runtimeDir, file)] :
        ownedDependencies && within(ownedDependencies, file) ? dependencyFiles[path.relative(ownedDependencies, file)] : null;
      if (!expected || expected.symlink !== undefined || !equal(identity, expected)) fail('resolved external input is not in the frozen snapshot');
      externalFiles[file] = identity;
    };
    const defaultImport = (name) => {
      const stem = searchPaths.map((directory) => path.join(directory, name.split('.').join('/'))).find((file) => fs.existsSync(`${file}.olean`));
      if (!stem || within(libRoot, stem)) fail('missing or unresolved external import');
      externalFile(`${stem}.olean`);
      for (const suffix of ['.olean.server', '.olean.private', '.ir']) if (fs.existsSync(`${stem}${suffix}`)) externalFile(`${stem}${suffix}`);
    };
    const projectNames = new Set(moduleSources.map(({ name }) => name));
    const modules = [];
    for (const mod of moduleSources) {
      const stem = path.join(libRoot, mod.name.split('.').join('/'));
      const ilean = `${stem}.ilean`;
      const data = JSON.parse(fs.readFileSync(ilean, 'utf8'));
      if (data.module !== mod.name || !Array.isArray(data.directImports)) fail('module/source inventory mismatch');
      for (const item of data.directImports) {
        if (!Array.isArray(item) || item.length !== 4 || !NAME.test(item[0]) || item.slice(1).some((flag) => typeof flag !== 'boolean')) fail('malformed direct imports');
        if (!projectNames.has(item[0])) externalImports.add(item[0]);
      }
      const setupFile = path.join(result.buildRoot, 'ir', `${mod.name.split('.').join('/')}.setup.json`);
      const setup = configured ? JSON.parse(fs.readFileSync(setupFile, 'utf8')) : null;
      if (setup && (setup.name !== mod.name || typeof setup.isModule !== 'boolean' ||
          !Array.isArray(setup.plugins) || !Array.isArray(setup.dynlibs))) fail('unsupported module setup', 'unsupported');
      if (setup) {
        for (const plugin of setup.plugins) {
          if (!plugin || typeof plugin.path !== 'string') fail('malformed external plugin');
          externalFile(plugin.path);
        }
        for (const file of setup.dynlibs) externalFile(file);
      }
      const multipart = setup ? setup.isModule : fs.existsSync(`${stem}.olean.private`);
      const parts = multipart ? [`${stem}.olean`, `${stem}.olean.server`, `${stem}.olean.private`] : [`${stem}.olean`];
      for (const file of [...parts, ilean, ...(multipart ? [`${stem}.ir`] : [])]) {
        if (!outputFiles[path.relative(result.buildRoot, file)]?.size) fail('missing or empty compiled module part');
      }
      if (!multipart && (fs.existsSync(`${stem}.olean.server`) || fs.existsSync(`${stem}.olean.private`))) fail('partial/unsupported module parts');
      if (setup) {
        if (!setup.importArts || typeof setup.importArts !== 'object' || Array.isArray(setup.importArts)) fail('missing resolved import artifacts');
        for (const [name, arts] of Object.entries(setup.importArts)) {
          if (!NAME.test(name) || !Array.isArray(arts) || !arts.length || new Set(arts).size !== arts.length) fail('malformed resolved import artifacts');
          for (const file of arts) {
            if (within(libRoot, file)) {
              absolute(file);
              if (!projectNames.has(name) || file !== path.join(libRoot, `${name.split('.').join('/')}.olean`) &&
                  ![`.olean.server`, `.olean.private`, `.ir`].some((suffix) => file === path.join(libRoot, `${name.split('.').join('/')}${suffix}`))) fail('project import artifact mismatch');
              if (!outputFiles[path.relative(result.buildRoot, file)]?.size) fail('missing project import artifact');
              continue;
            }
            if (projectNames.has(name)) fail('project module resolved as external');
            if (!within(path.join(toolRoot, 'lib', 'lean'), file) && !(ownedDependencies && within(ownedDependencies, file))) fail('resolved import escapes frozen inputs');
            const suffix = name.split('.').join('/');
            const match = /^(.*)\.(olean(?:\.server|\.private)?|ir)$/.exec(file);
            if (!match || !match[1].endsWith(`/${suffix}`)) fail('unsupported resolved import layout');
            externalFile(file);
            externalPaths.add(match[1].slice(0, -suffix.length - 1));
          }
        }
        for (const [name] of data.directImports) {
          if (!Object.hasOwn(setup.importArts, name) && !projectNames.has(name)) defaultImport(name);
          else if (!setup.importArts[name]?.some((file) => file.endsWith(`/${name.split('.').join('/')}.olean`))) fail('missing direct import artifacts');
        }
      } else {
        for (const [name] of data.directImports) defaultImport(name);
      }
      modules.push({ ...mod, parts, ...(multipart ? { ir: `${stem}.ir` } : {}), ilean });
    }
    const actualModules = Object.keys(outputFiles).filter((file) => file.endsWith('.ilean'));
    if (actualModules.length !== modules.length) fail('unexpected/partial project module coverage');
    const exportedParts = new Set(modules.flatMap((mod) => mod.parts.map((file) => path.relative(result.buildRoot, file))));
    if (Object.keys(outputFiles).some((file) => /\.olean(?:\.server|\.private)?$/.test(file) && !exportedParts.has(file))) fail('unexpected compiled project module');
    checkInputs();
    if (!equal(tree(result.buildRoot), outputFiles)) fail('compiled outputs changed during validation');
    if (ownedDependencies && !equal(tree(ownedDependencies, false, true), ownedAfter)) fail('owned dependency files changed during validation');
    // Reuse checks only within this phase; full inventories above rehash every byte.
    for (const file of Object.keys(externalFiles)) { tick(); absolute(file); }
    const externalInventory = {};
    for (const directory of [...externalPaths].sort()) {
      absolute(directory);
      if (within(project, directory) && !(ownedDependencies && within(ownedDependencies, directory))) fail('project build cannot be an external search root');
      externalInventory[directory] = { kind: directory === path.join(toolRoot, 'lib', 'lean') ? 'toolchain' : 'dependency' };
    }
    result.inventories.outputs = save('outputs.json', { root: result.buildRoot, files: outputFiles, externalRoots: externalInventory, externalFiles, declaredSearchPaths, missingSearchPaths });
    Object.assign(result, { modules, externalSearchPaths: [...externalPaths], externalImports: [...externalImports].sort(), status: 'built' });
    save('result.json', result);
    return result;
  } catch (error) {
    result.status = error.buildStatus ?? 'unverified';
    result.reason = error.message;
    if (created) {
      try { save('failure.json', result); } catch {}
    }
    return result;
  }
}
