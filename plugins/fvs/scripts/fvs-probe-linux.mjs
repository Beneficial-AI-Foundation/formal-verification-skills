// Linux confinement and independent project staging for probe execution.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BWRAP = '/usr/bin/bwrap';
export const XZ = '/usr/bin/xz';
const MAX_ARCHIVE = 32 * 1024 * 1024;
const MAX_TAR = 256 * 1024 * 1024;
const HIDDEN = ['/tmp', '/var/tmp', '/run'];
const RUNTIME = [...HIDDEN, '/proc', '/sys', '/dev'];
const SYSTEM_ROOTS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc'];
const windowsMount = (value) => /^\/mnt\/[a-z](?:\/|$)/i.test(value);

function fail(message) {
  throw new Error(message);
}

function text(value, label) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(`${label} must be nonempty text without control characters`);
  }
  return value;
}

function absolute(value, label) {
  text(value, label);
  if (!path.isAbsolute(value)) fail(`${label} must be an absolute Linux path`);
  return path.resolve(value);
}

// Resolve existing ancestors, including dangling symlinks (reject them).
export function realish(value) {
  let head = absolute(value, 'path');
  const tail = [];
  while (true) {
    let exists = false;
    try {
      fs.lstatSync(head);
      exists = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (exists) return path.join(fs.realpathSync(head), ...tail);
    const parent = path.dirname(head);
    if (parent === head) fail(`no existing ancestor for ${value}`);
    tail.unshift(path.basename(head));
    head = parent;
  }
}

function directory(value, label) {
  const resolved = fs.realpathSync(absolute(value, label));
  if (!fs.statSync(resolved).isDirectory()) fail(`${label} must be an existing directory`);
  return resolved;
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function overlaps(a, b) {
  return contains(a, b) || contains(b, a);
}

function executable(value) {
  const name = absolute(value, 'command');
  const resolved = fs.realpathSync(name);
  if (!fs.statSync(resolved).isFile()) fail('command must resolve to a regular file');
  if (/\.exe$/i.test(name) || /\.exe$/i.test(resolved) || windowsMount(name) || windowsMount(resolved)) {
    fail('use a Linux executable, not a Windows executable or mounted Windows tool');
  }
  fs.accessSync(name, fs.constants.X_OK);
  // Do not return realpath: rustup uses argv[0] to distinguish its proxies.
  return name;
}

// Match the upstream helper lookup order without running or installing tools.
// Direct staging callers may omit a selection, including the missing-SCIP case.
export function selectProbeToolPaths({ sourceEnv = process.env, projectRoot = null, leanToolchain = null } = {}) {
  const home = sourceEnv.HOME || os.homedir();
  const available = (file) => {
    try {
      if (!fs.statSync(file).isFile()) return null;
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      return null;
    }
  };
  const which = (name) => {
    for (const dir of (sourceEnv.PATH || '').split(path.delimiter)) {
      if (!path.isAbsolute(dir)) continue;
      const file = available(path.join(dir, name));
      if (file) return file;
    }
    return null;
  };
  if (leanToolchain === null && projectRoot) {
    try {
      leanToolchain = fs.readFileSync(path.join(projectRoot, 'lean-toolchain'), 'utf8').trim();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const leanVersion = (leanToolchain || '').split(':').pop();
  if (leanVersion && !/^[A-Za-z0-9._-]+$/.test(leanVersion)) {
    fail('unsupported Lean toolchain name for helper lookup');
  }
  const libraryPath = leanVersion ? path.join(home, '.local', 'lib', `probe-lean-${leanVersion}`) : null;
  const helpers = {
    'probe-rust': which('probe-rust') ?? available(path.join(home, '.cargo', 'bin', 'probe-rust')),
    scip: available(path.join(home, '.probe-rust', 'tools', 'scip')) ?? which('scip'),
    'probe-lean': leanVersion ? available(path.join(home, '.local', 'bin', `probe-lean-${leanVersion}`)) : null,
    'rust-analyzer': which('rust-analyzer'),
  };
  const rustupPath = which('rustup');
  return {
    helpers, rustupPath, libraryPath,
    executables: [...Object.values(helpers), rustupPath].filter(Boolean),
    libraries: libraryPath && fs.existsSync(libraryPath) ? [libraryPath] : [],
  };
}

// Only selected files and the known Lean library are exposed. Protection does
// not imply mounting an executable's parent directory and its unrelated files.
export function validateLinuxToolPaths(toolPaths, { projectRoot = null, sourceEnv = process.env } = {}) {
  if (!toolPaths || !Array.isArray(toolPaths.executables) || !Array.isArray(toolPaths.libraries)) {
    fail('toolPaths must contain executables and libraries arrays');
  }
  const root = projectRoot ? directory(projectRoot, 'projectRoot') : null;
  const home = directory(sourceEnv.HOME || os.homedir(), 'HOME');
  const view = (value, library) => {
    const logical = library ? absolute(value, 'tool library') : executable(value);
    const resolved = fs.realpathSync(logical);
    if (library && !fs.statSync(resolved).isDirectory()) fail(`tool library is not a directory: ${logical}`);
    if (library && contains(resolved, home)) fail(`unsupported tool layout: library would expose HOME: ${logical}`);
    if (forbiddenRoot(logical) || forbiddenRoot(resolved)) fail(`unsupported tool layout: hidden path ${logical}`);
    if (root && overlaps(root, resolved)) fail(`unsupported tool layout: ${logical} overlaps the project`);
    let target = resolved;
    if (fs.lstatSync(logical).isSymbolicLink()) {
      target = path.resolve(path.dirname(logical), fs.readlinkSync(logical));
      if (fs.lstatSync(target).isSymbolicLink()) {
        fail(`unsupported tool layout: intermediate executable or library symlink at ${target}`);
      }
      if (forbiddenRoot(target)) fail(`unsupported tool layout: hidden symlink target ${target}`);
    }
    return { logical, resolved, target };
  };
  const files = [...new Set(toolPaths.executables)].map((item) => view(item, false));
  const libraries = [...new Set(toolPaths.libraries)].map((item) => view(item, true));
  return { files, libraries, protectedPaths: [...files, ...libraries].map((item) => item.resolved) };
}

// The filesystem allowlist omits WSL interop, GUI mounts and runtime sockets.
// Seccomp also denies socket creation/connect (including AF_UNIX and AF_VSOCK)
// so a pathname socket in an allowed tool/project tree cannot reach the host.
// Only x86_64 syscalls are accepted; reject x32 and io_uring socket bypasses.
// Anonymous socketpair IPC remains available; inherited IPC is limited to stdio.
function networkFilter() {
  const instructions = [
    [0x20, 0, 0, 4], [0x15, 1, 0, 0xc000003e], [0x06, 0, 0, 0x80000000],
    [0x20, 0, 0, 0], [0x35, 0, 1, 0x40000000], [0x06, 0, 0, 0x80000000],
    [0x15, 3, 0, 41], [0x15, 2, 0, 42], [0x15, 1, 0, 425],
    [0x06, 0, 0, 0x7fff0000], [0x06, 0, 0, 0x00050001],
  ];
  const bytes = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, jt, jf, k], index) => {
    const offset = index * 8;
    bytes.writeUInt16LE(code, offset);
    bytes[offset + 2] = jt;
    bytes[offset + 3] = jf;
    bytes.writeUInt32LE(k, offset + 4);
  });
  return bytes;
}

function safeTree(root, { writable = false } = {}) {
  const pending = [root];
  const links = new Map();
  while (pending.length) {
    const item = pending.pop();
    const stat = fs.lstatSync(item);
    if (stat.isSymbolicLink()) continue; // Target mount permissions still apply.
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(item)) pending.push(path.join(item, entry));
    } else if (!stat.isFile()) {
      fail(`special file is not allowed in a mounted project: ${item}`);
    } else if (writable && stat.nlink > 1) {
      const key = `${stat.dev}:${stat.ino}`;
      const entry = links.get(key) || { count: 0, nlink: stat.nlink, item };
      entry.count += 1;
      links.set(key, entry);
    }
  }
  for (const entry of links.values()) {
    // Cargo legitimately hardlinks build artifacts within target/. Every alias
    // must be accounted for inside this same disposable writable tree.
    if (entry.count !== entry.nlink) fail(`writable file has an external hardlink alias: ${entry.item}`);
  }
}

function forbiddenRoot(value) {
  return value === '/' || RUNTIME.some((root) => contains(root, value)) ||
    contains('/mnt', value) || value === '/init';
}

// Decode bytes only after digest verification. The caller must still inspect
// the returned tar data; no archive members are unpacked here.
export function decodeLinuxTarXz(bytes, expectedSha256) {
  if (!Buffer.isBuffer(bytes)) fail('archive must be a Buffer');
  if (bytes.length > MAX_ARCHIVE) fail('archive is larger than the size limit');
  if (!/^[0-9a-f]{64}$/.test(expectedSha256 || '')) fail('a pinned SHA-256 is required');
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== expectedSha256) fail('archive SHA-256 does not match the pinned official digest');
  const child = spawnSync(XZ, ['--decompress', '--stdout', '--memlimit-decompress=256MiB'], {
    input: bytes, maxBuffer: MAX_TAR, timeout: 60000,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (child.error || child.status !== 0) {
    fail(`cannot decompress verified XZ archive: ${child.error?.message || String(child.stderr).trim() || `exit ${child.status}`}`);
  }
  return child.stdout;
}

// Plan without executing or modifying anything. Extraction mode allows writes
// throughout a disposable checkout; use runLinuxStagedExtract for a developer
// checkout. Only selected tools and inputs are exposed, and host sockets remain
// blocked even within visible directories.
export function planLinuxSandbox({
  mode = 'read-only', command, commandArgs = [], cwd,
  sourceEnv = process.env, projectRoot = null, outputDir = null,
  privateTmp = null, disposableProject = false, additionalProtected = [],
  readOnlyPaths = [], projectSource = null, toolPaths = null,
}) {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    fail('Linux confinement requires Linux x64; use the Linux toolchain inside WSL2');
  }
  if (!['read-only', 'extract'].includes(mode)) fail('mode must be read-only or extract');
  if (!Array.isArray(commandArgs) || commandArgs.some((x) => typeof x !== 'string' || x.includes('\0'))) {
    fail('commandArgs must be an array of strings without NUL');
  }
  if (!Array.isArray(additionalProtected)) fail('additionalProtected must be an array');
  if (!Array.isArray(readOnlyPaths)) fail('readOnlyPaths must be an array');
  const bin = executable(command);
  const working = directory(cwd, 'cwd');
  if (forbiddenRoot(working)) fail('cwd must not be a filesystem or runtime root or descendant');
  const home = directory(sourceEnv.HOME || os.homedir(), 'HOME');
  if (forbiddenRoot(home)) fail('use a persistent HOME outside runtime and Windows mount directories');
  const pathParts = text(sourceEnv.PATH || '/usr/bin:/bin', 'PATH').split(':');
  for (const item of pathParts) {
    absolute(item, 'every PATH entry');
    if (windowsMount(item) || windowsMount(realish(item))) fail('PATH must not contain Windows-mounted directories');
  }
  const env = {
    HOME: home, PATH: pathParts.join(':'), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    CARGO_HOME: realish(sourceEnv.CARGO_HOME || path.join(home, '.cargo')),
    RUSTUP_HOME: realish(sourceEnv.RUSTUP_HOME || path.join(home, '.rustup')),
    ELAN_HOME: realish(sourceEnv.ELAN_HOME || path.join(home, '.elan')),
    FVS_TOOLS_HOME: realish(sourceEnv.FVS_TOOLS_HOME || path.join(home, '.fvs', 'tools')),
    RUSTUP_AUTO_INSTALL: '0', CARGO_NET_OFFLINE: 'true',
  };
  if (sourceEnv.RUSTUP_TOOLCHAIN) env.RUSTUP_TOOLCHAIN = text(sourceEnv.RUSTUP_TOOLCHAIN, 'RUSTUP_TOOLCHAIN');
  const toolDirs = [
    '.cargo', '.rustup', '.elan', '.local', '.probe-rust',
  ].map((item) => path.join(home, item)).concat([
    env.CARGO_HOME, env.RUSTUP_HOME, env.ELAN_HOME, env.FVS_TOOLS_HOME,
    ...pathParts, ...additionalProtected,
  ]);
  const selected = toolPaths ?? (mode === 'extract'
    ? selectProbeToolPaths({ sourceEnv, projectRoot })
    : { executables: [], libraries: [] });
  validateLinuxToolPaths(selected, { sourceEnv });
  const tools = validateLinuxToolPaths({ ...selected, executables: [bin, ...selected.executables] }, { sourceEnv });
  const protect = [...new Set([...toolDirs.map(realish), ...tools.protectedPaths])].sort();
  if (toolDirs.some((item) => contains(realish(item), home))) fail('tool directory must not expose HOME or its ancestors');
  for (const item of protect) {
    if (forbiddenRoot(item)) {
      fail(`protected tool directory is hidden by the sandbox: ${item}; stage tools in a persistent home`);
    }
  }
  let writable = [];
  let writeSources = [];
  if (mode === 'extract') {
    if (disposableProject !== true) fail('extract requires explicit disposableProject: true');
    writable = [
      directory(projectRoot, 'projectRoot'), directory(outputDir, 'outputDir'),
      directory(privateTmp, 'privateTmp'),
    ];
    writeSources = [projectSource ? directory(projectSource, 'projectSource') : writable[0], ...writable.slice(1)];
    for (let index = 0; index < writable.length; index += 1) {
      const dir = writable[index];
      if (['/', '/proc', '/dev', '/sys', ...HIDDEN].some((root) => contains(dir, root) || (['/proc', '/dev', '/sys'].includes(root) && contains(root, dir)))) {
        fail(`unsafe writable root: ${dir}`);
      }
      if (writable.slice(index + 1).some((other) => overlaps(dir, other))) fail('writable directories must be disjoint');
      for (const item of protect) {
        if (overlaps(dir, item)) fail(`writable directory ${dir} overlaps protected directory ${item}`);
      }
      if (windowsMount(dir)) fail('writable projects must use the Linux filesystem');
    }
    for (const dir of writeSources) {
      if (protect.some((item) => overlaps(dir, item))) fail(`writable source ${dir} overlaps protected directory`);
      safeTree(dir, { writable: true });
    }
    if (!writable.some((root) => contains(root, working))) fail('extraction cwd must be inside a disposable writable directory');
    env.TMPDIR = `${writable[2]}/`;
  } else {
    if (projectRoot || outputDir || privateTmp || disposableProject || projectSource) fail('read-only mode accepts no writable directories');
    env.TMPDIR = '/tmp/';
  }
  const args = [
    '--die-with-parent', '--new-session', '--unshare-user', '--disable-userns',
    '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts',
    '--cap-drop', 'ALL', '--seccomp', '3', '--proc', '/proc', '--dev', '/dev',
    '--tmpfs', '/tmp', '--tmpfs', '/var/tmp', '--tmpfs', '/run',
  ];
  const readMounts = [];
  function addRead(source, destination = source) {
    if (!fs.existsSync(source)) return;
    const resolved = fs.realpathSync(source);
    if (readMounts.some((mount) => contains(mount.destination, destination) &&
      realish(path.join(mount.source, path.relative(mount.destination, destination))) === resolved)) return;
    readMounts.push({ source: resolved, destination });
  }
  for (const root of SYSTEM_ROOTS) {
    if (!fs.existsSync(root)) continue;
    if (fs.lstatSync(root).isSymbolicLink()) args.push('--symlink', fs.readlinkSync(root), root);
    else addRead(root);
  }
  // HOME itself is an empty, read-only directory; mount only tool directories.
  args.push('--dir', home);
  for (const item of toolDirs) {
    addRead(realish(item));
    addRead(item, absolute(item, 'tool directory'));
  }
  for (const item of tools.libraries) {
    addRead(item.resolved);
    addRead(item.resolved, item.target);
    addRead(item.resolved, item.logical);
  }
  for (const item of readOnlyPaths) {
    const resolved = realish(item);
    if (forbiddenRoot(resolved)) fail(`readOnlyPaths cannot expose a runtime or filesystem root: ${item}`);
    addRead(resolved);
  }
  if (mode === 'read-only') addRead(working);
  // Parent mounts must precede child mounts. The staged project below overrides
  // its original path, without revealing the original writable host checkout.
  readMounts.sort((a, b) => a.destination.length - b.destination.length);
  // Files follow directory mounts. Targets precede aliases so existing
  // rustup-style links resolve without exposing the target's siblings.
  for (const item of tools.files) {
    addRead(item.resolved);
    addRead(item.resolved, item.target);
    addRead(item.resolved, item.logical);
  }
  for (const mount of readMounts) args.push('--ro-bind', mount.source, mount.destination);
  if (fs.existsSync('/usr/lib/wsl')) args.push('--tmpfs', '/usr/lib/wsl');
  for (let index = 0; index < writable.length; index += 1) {
    args.push('--bind', writeSources[index], writable[index]);
  }
  args.push('--clearenv');
  for (const [key, value] of Object.entries(env)) args.push('--setenv', key, value);
  // Parent directories created by bubblewrap must not become writable HOME/bin
  // creation avenues. Submounts (private tmp/output/project) remain writable.
  args.push('--remount-ro', '/');
  args.push('--chdir', working, '--', bin, ...commandArgs);
  return { file: BWRAP, args, mode, command: bin, cwd: working, writable, writeSources, readMounts, protect, env };
}

// Run only through bubblewrap. A missing executable, unsupported option or
// namespace failure is a hard failure, with no unconfined fallback.
export function runLinuxSandbox(plan, { timeout = 60000, maxBuffer = 8 * 1024 * 1024 } = {}) {
  if (plan.file !== BWRAP || !Array.isArray(plan.args)) fail('not a bubblewrap plan');
  if (!plan.args.some((arg, index) => arg === '--seccomp' && plan.args[index + 1] === '3')) fail('network seccomp is required');
  const filterDir = fs.mkdtempSync('/tmp/fvs-seccomp-');
  let filterFd;
  let child;
  try {
    const filterPath = path.join(filterDir, 'filter.bpf');
    fs.writeFileSync(filterPath, networkFilter(), { mode: 0o600, flag: 'wx' });
    filterFd = fs.openSync(filterPath, fs.constants.O_RDONLY);
    fs.unlinkSync(filterPath);
    child = spawnSync(BWRAP, plan.args, {
      cwd: '/', timeout, maxBuffer, encoding: 'utf8', killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe', filterFd],
      // Do not let NODE_OPTIONS, LD_PRELOAD, proxies or WSL_INTEROP enter bwrap.
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
    });
  } finally {
    if (filterFd !== undefined) fs.closeSync(filterFd);
    fs.rmSync(filterDir, { recursive: true, force: true });
  }
  return {
    ok: !child.error && child.status === 0, status: child.status, signal: child.signal,
    spawnError: child.error?.code || null,
    stdout: child.stdout || '', stderr: child.stderr || '',
    error: child.error?.message || (child.status === 0 ? null : `bubblewrap/child exited with ${child.status}`),
  };
}

function gitMetadata(source) {
  const text = fs.readFileSync(source, 'utf8');
  const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(text);
  if (!match) fail(`unsupported .git file (expected a gitdir pointer): ${source}`);
  const gitDir = directory(path.resolve(path.dirname(source), match[1]), 'Git directory');
  if (!fs.lstatSync(path.join(gitDir, 'HEAD'), { throwIfNoEntry: false })?.isFile()) {
    fail(`unsupported Git metadata layout (expected a regular HEAD): ${gitDir}`);
  }
  const dirs = [gitDir];
  const common = path.join(gitDir, 'commondir');
  const commonStat = fs.lstatSync(common, { throwIfNoEntry: false });
  if (commonStat) {
    if (!commonStat.isFile()) fail(`unsupported Git metadata layout (expected a regular commondir): ${gitDir}`);
    const value = fs.readFileSync(common, 'utf8').trim();
    const commonDir = directory(path.resolve(gitDir, value), 'Git common directory');
    if (!fs.lstatSync(path.join(commonDir, 'HEAD'), { throwIfNoEntry: false })?.isFile()) {
      fail(`unsupported Git metadata layout (expected a regular HEAD): ${commonDir}`);
    }
    dirs.push(commonDir);
  }
  const repository = dirs[dirs.length - 1];
  if (!fs.lstatSync(path.join(repository, 'objects'), { throwIfNoEntry: false })?.isDirectory()) {
    fail(`unsupported Git metadata layout (expected an objects directory): ${repository}`);
  }
  return dirs;
}

function copyIndependentTree(source, destination, gitDirs) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    if (path.basename(source) === '.git') fail(`symlinked .git entries are unsupported for Linux staging: ${source}`);
    fs.symlinkSync(fs.readlinkSync(source), destination);
  } else if (stat.isDirectory()) {
    // The private copy needs owner access even when the source is read-only.
    const mode = (stat.mode & 0o777) | 0o700;
    fs.mkdirSync(destination, { mode });
    fs.chmodSync(destination, mode);
    for (const entry of fs.readdirSync(source)) {
      copyIndependentTree(path.join(source, entry), path.join(destination, entry), gitDirs);
    }
    fs.utimesSync(destination, stat.atime, stat.mtime);
  } else if (stat.isFile()) {
    if (path.basename(source) === '.git') gitDirs.push(...gitMetadata(source));
    // Reflinks are independent copies. Never preserve hardlinks to source/tools.
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(destination, stat.mode & 0o777);
    fs.utimesSync(destination, stat.atime, stat.mtime);
  } else fail(`cannot stage a special file: ${source}`);
}

function removeStage(stage, identity) {
  const current = fs.lstatSync(stage, { throwIfNoEntry: false });
  if (!current) return;
  if (!current.isDirectory() || !identity || current.dev !== identity.dev || current.ino !== identity.ino) {
    throw Object.assign(new Error('private staging directory was replaced'), { code: 'ESTALE', path: stage });
  }
  try {
    fs.rmSync(stage, { recursive: true, force: true });
    return;
  } catch (error) {
    if (!['EACCES', 'EPERM'].includes(error.code)) throw error;
  }
  // The child has exited. Repair only private directories, never symlink targets
  // or file permissions: a file may have another hardlink outside this tree.
  const pending = [stage];
  while (pending.length > 0) {
    const directory = pending.pop();
    const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) continue;
    fs.chmodSync(directory, (stat.mode & 0o777) | 0o700);
    for (const entry of fs.readdirSync(directory)) pending.push(path.join(directory, entry));
  }
  fs.rmSync(stage, { recursive: true, force: true });
}

// Mount an independent copy at the original project path, preserving probe paths
// and Cargo/Lake relative paths. Return candidate bytes only after cleanup;
// the caller validates the graph before publishing an output file.
export function runLinuxStagedExtract({
  probePath, projectRoot, rustProject, withPublicApi = false, sourceEnv = process.env, toolPaths = null,
  timeout = 30 * 60 * 1000, maxBuffer = 32 * 1024 * 1024,
}) {
  let stage;
  let stageIdentity;
  let execution;
  let policy;
  let result;
  try {
    const root = directory(projectRoot, 'projectRoot');
    const crate = directory(rustProject, 'rustProject');
    if (forbiddenRoot(root) || SYSTEM_ROOTS.some((item) => overlaps(root, item))) fail('unsafe project root for production staging');
    if (!contains(root, crate)) fail('rustProject must be inside projectRoot');
    const home = directory(sourceEnv.HOME || os.homedir(), 'HOME');
    if (contains(root, home)) fail('projectRoot must not contain HOME');
    // Use /tmp so an inherited TMPDIR cannot place staging inside the project
    // or a protected tool home.
    stage = fs.mkdtempSync('/tmp/fvs-probe-stage-');
    stageIdentity = fs.lstatSync(stage);
    fs.chmodSync(stage, 0o700);
    const projectCopy = path.join(stage, 'project');
    const outputDir = path.join(stage, 'output');
    const privateTmp = path.join(stage, 'tmp');
    fs.mkdirSync(outputDir, { mode: 0o700 });
    fs.mkdirSync(privateTmp, { mode: 0o700 });
    const candidate = path.join(outputDir, 'extract.json');
    const gitDirs = [];
    copyIndependentTree(root, projectCopy, gitDirs);
    const commandArgs = ['extract', root, '-o', candidate];
    if (withPublicApi) commandArgs.push('--with-public-api');
    const plan = planLinuxSandbox({
      mode: 'extract', command: probePath, commandArgs, cwd: root, sourceEnv,
      projectRoot: root, projectSource: projectCopy, outputDir, privateTmp,
      disposableProject: true, readOnlyPaths: gitDirs,
      toolPaths: toolPaths ?? selectProbeToolPaths({ sourceEnv, projectRoot: root }),
    });
    policy = {
      backend: 'bubblewrap', staged: true, sourceRoot: root,
      readMounts: plan.readMounts, writable: plan.writable, protected: plan.protect,
      network: 'new network namespace; seccomp denies socket/connect/io_uring_setup',
    };
    execution = runLinuxSandbox(plan, { timeout, maxBuffer });
    result = { ...execution, policy };
    if (result.ok) {
      const outputStat = fs.lstatSync(candidate);
      if (!outputStat.isFile() || outputStat.nlink !== 1) fail('probe output must be an independent regular file');
      if (outputStat.size > 256 * 1024 * 1024) fail('probe output exceeds size limit');
      result.outputText = fs.readFileSync(candidate, 'utf8');
    }
  } catch (error) {
    result = {
      status: null, signal: null, stdout: '', stderr: '',
      ...execution, policy, ok: false, error: error.message,
    };
  }
  if (stage) {
    try {
      removeStage(stage, stageIdentity);
    } catch (error) {
      delete result.outputText;
      result.ok = false;
      result.primaryError = result.error ?? null;
      result.cleanupError = { code: error.code ?? null, message: error.message, path: error.path ?? stage };
      result.retainedStage = stage;
      result.error = [result.primaryError, `cannot remove private staging directory ${stage}: ${error.message}`]
        .filter(Boolean).join('; ');
    }
  }
  return result;
}
