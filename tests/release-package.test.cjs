'use strict';
// Release gate for the npm package. Ordinary runs check the source and generated release surfaces
// and exercise the archive validators on synthetic data, without starting any process.
// FVS_RELEASE_PACKAGE_ARCHIVE=1 also packs the committed tree with npm and inspects the real
// tarball; it requires an absolute FVS_RELEASE_PACKAGE_QUALIFICATION record and fails before any
// process or write when that record does not verify.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RELEASE = '2.3.8';
const HOOKS = ['fvs-check-update.js', 'fvs-statusline.js'];
const ALLOWLIST = ['bin', 'commands', 'pi', 'fv-skills', 'agents', 'hooks/dist', 'scripts', 'CHANGELOG.md', 'assets/terminal.svg'];
const ALWAYS_SHIPPED = ['package.json', 'README.md', 'LICENSE'];
const PRIVATE_SEGMENTS = ['.planning', '.formalising', '.git', '.claude', '.agents', '.worktrees', 'node_modules', 'tests', '.npmrc'];

const digest = (algorithm, bytes, encoding = 'hex') => crypto.createHash(algorithm).update(bytes).digest(encoding);
const gitBlobId = bytes => digest('sha1', Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]));
const read = relative => fs.readFileSync(path.join(ROOT, relative));
const json = relative => JSON.parse(read(relative));
const dirs = relative => fs.readdirSync(path.join(ROOT, relative), { withFileTypes: true })
  .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();

function regular(file, limit = 64 << 20) {
  assert.ok(typeof file === 'string' && path.isAbsolute(file), `absolute path required: ${file}`);
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), `regular file required: ${file}`);
  assert.equal(fs.realpathSync(file), file, `canonical path required: ${file}`);
  assert.ok(stat.size <= limit, `file too large: ${file}`);
  return fs.readFileSync(file);
}

function ownedDirectory(directory, root, { empty = false } = {}) {
  assert.ok(typeof directory === 'string' && path.isAbsolute(directory), `absolute directory required: ${directory}`);
  assert.equal(fs.realpathSync(directory), directory, `canonical directory required: ${directory}`);
  const stat = fs.lstatSync(directory);
  assert.ok(stat.isDirectory() && stat.uid === process.getuid(), `owned directory required: ${directory}`);
  if (root) assert.ok(directory.startsWith(root + path.sep), `${directory} must be inside ${root}`);
  if (empty) assert.deepEqual(fs.readdirSync(directory), [], `${directory} must be empty`);
}

// Tar members as reported by Python's tarfile after header overrides: {name, type, mode, size}.
function checkMembers(members, limits) {
  assert.ok(Array.isArray(members) && members.length > 0 && members.length <= limits.maxMembers, 'member count');
  const seen = new Map();
  const files = [];
  let total = 0;
  for (const member of members) {
    const name = member.name;
    assert.ok(typeof name === 'string' && name.startsWith('package/'), `member outside package/: ${name}`);
    const relative = name.slice('package/'.length);
    const parts = relative.split('/');
    assert.ok(relative && !/[\\\0:]/.test(relative) && parts.every(part => part && part !== '.' && part !== '..'),
      `unsafe member path: ${JSON.stringify(name)}`);
    const key = relative.normalize('NFC').toLowerCase(); // APFS folds case and Unicode form
    assert.ok(!seen.has(key), `duplicate or aliased member: ${name}`);
    seen.set(key, member.type);
    assert.ok(Number.isInteger(member.mode) && (member.mode & ~0o777) === 0, `special mode bits: ${name}`);
    if (member.type === 'dir') continue;
    assert.equal(member.type, 'file', `non-regular member: ${name}`);
    assert.ok(Number.isSafeInteger(member.size) && member.size >= 0 && member.size <= limits.maxFileBytes, `member size: ${name}`);
    total += member.size;
    files.push(relative);
  }
  assert.ok(total <= limits.maxTotalBytes, 'unpacked size');
  for (const key of seen.keys()) {
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) {
      assert.notEqual(seen.get(parts.slice(0, i).join('/')), 'file', `file-directory collision: ${key}`);
    }
  }
  return files.sort();
}

function checkPackOutput(report, destination, pkg, limits) {
  assert.ok(Array.isArray(report) && report.length === 1, 'npm must report exactly one package');
  const [result] = report;
  const filename = `${pkg.name}-${pkg.version}.tgz`;
  assert.equal(result.name, pkg.name);
  assert.equal(result.version, pkg.version);
  assert.equal(result.filename, filename, 'reported filename');
  assert.deepEqual(fs.readdirSync(destination), [filename], 'destination must hold only the reported tarball');
  const file = path.join(destination, filename);
  const bytes = regular(file, limits.maxTarballBytes);
  assert.equal(fs.lstatSync(file).nlink, 1, 'tarball must not be hardlinked');
  assert.ok(bytes.length > 0 && result.size === bytes.length, 'reported size');
  assert.equal(result.shasum, digest('sha1', bytes), 'reported shasum');
  assert.equal(result.integrity, `sha512-${digest('sha512', bytes, 'base64')}`, 'reported integrity');
  assert.ok(Array.isArray(result.files) && result.entryCount === result.files.length, 'reported entries');
  return { file, bytes, sha256: digest('sha256', bytes) };
}

function parseLsTree(output) {
  return output.split('\0').filter(Boolean).map(line => {
    const [meta, file] = line.split('\t');
    const [mode, type, blob] = meta.split(' ');
    return { mode, type, blob, path: file };
  });
}

// The expected archive comes from the committed tree and the reviewed allowlist, never from npm.
function expectedPackage(tree, pkg) {
  assert.deepEqual(pkg.files, ALLOWLIST, 'package.json#files changed; review the allowlist');
  const covered = file => ALWAYS_SHIPPED.includes(file) || pkg.files.some(entry => file === entry || file.startsWith(`${entry}/`));
  const rows = tree.filter(row => row.type === 'blob' && covered(row.path));
  for (const row of rows) assert.ok(['100644', '100755'].includes(row.mode), `unexpected committed mode: ${row.path}`);
  for (const hook of HOOKS) {
    const source = tree.find(row => row.path === `hooks/${hook}`);
    assert.ok(source, `committed hook source missing: ${hook}`);
    rows.push({ ...source, path: `hooks/dist/${hook}` });
  }
  return rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function checkBuiltHooks(root, tree) {
  for (const hook of HOOKS) {
    const built = regular(path.join(root, 'hooks', 'dist', hook));
    assert.equal(gitBlobId(built), tree.find(row => row.path === `hooks/${hook}`)?.blob, `hooks/dist/${hook} must equal its committed source`);
  }
}

const PYTHON_TARFILE = String.raw`
import hashlib, json, os, stat, sys, tarfile
mode, archive, expected = sys.argv[1:4]
TYPES = {tarfile.REGTYPE: 'file', tarfile.AREGTYPE: 'file', tarfile.DIRTYPE: 'dir', tarfile.SYMTYPE: 'symlink',
         tarfile.LNKTYPE: 'hardlink', tarfile.CHRTYPE: 'char', tarfile.BLKTYPE: 'block', tarfile.FIFOTYPE: 'fifo'}
with open(archive, 'rb') as handle:
    def verify():
        handle.seek(0)
        h = hashlib.sha256()
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            h.update(chunk)
        if h.hexdigest() != expected:
            sys.exit('archive digest changed')
        handle.seek(0)
    verify()
    with tarfile.open(fileobj=handle, mode='r:gz') as tar:
        members = tar.getmembers()
        if mode == 'list':
            result = [{'name': m.name, 'type': TYPES.get(m.type, 'other'), 'mode': m.mode, 'size': m.size} for m in members]
        else:
            scratch = sys.argv[4]
            with open(sys.argv[5]) as names:
                approved = json.load(names)
            chosen = {}
            for m in members:
                if m.name in approved:
                    if m.name in chosen or not m.isreg():
                        sys.exit('unexpected member: ' + m.name)
                    chosen[m.name] = m
            if sorted(chosen) != sorted(approved):
                sys.exit('approved members missing')
            result = {}
            for name in approved:
                m, parent = chosen[name], scratch
                for part in name.split('/')[:-1]:
                    parent = os.path.join(parent, part)
                    try:
                        os.mkdir(parent, 0o700)
                    except FileExistsError:
                        pass
                    if not stat.S_ISDIR(os.lstat(parent).st_mode):
                        sys.exit('unsafe parent: ' + parent)
                data = tar.extractfile(m).read(m.size + 1)
                if len(data) != m.size:
                    sys.exit('member size changed: ' + name)
                fd = os.open(os.path.join(parent, name.split('/')[-1]), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, 'wb') as out:
                    out.write(data)
                result[name] = {'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    verify()
print(json.dumps(result))
`;

function loadQualification(file) {
  assert.ok(typeof file === 'string' && path.isAbsolute(file), 'FVS_RELEASE_PACKAGE_QUALIFICATION must name an absolute file');
  const q = JSON.parse(regular(file, 1 << 20));
  assert.equal(q.schema, 'fvs-release-package-qualification/1');
  assert.equal(q.sourceRoot, fs.realpathSync(ROOT), 'qualification is for another checkout');
  assert.match(q.commit, /^[0-9a-f]{40}$/);
  assert.match(q.tree, /^[0-9a-f]{40}$/);
  assert.equal(process.execPath, q.tools.node.path, 'the gate must run under the qualified Node');
  for (const name of ['node', 'npmCli', 'git', 'python']) {
    assert.equal(digest('sha256', regular(q.tools[name].path, 256 << 20)), q.tools[name].sha256, `${name} digest`);
  }
  ownedDirectory(q.root);
  for (const name of ['home', 'tmp', 'cache']) ownedDirectory(q.paths[name], q.root);
  for (const name of ['packDestination', 'extract', 'output']) ownedDirectory(q.paths[name], q.root, { empty: true });
  const env = q.environment;
  assert.equal(env.HOME, q.paths.home);
  assert.equal(env.TMPDIR, q.paths.tmp);
  assert.equal(env.npm_config_cache, q.paths.cache);
  for (const key of ['npm_config_userconfig', 'npm_config_globalconfig']) {
    assert.equal(regular(env[key]).length, 0, `${key} must be an empty owned file`);
    assert.ok(env[key].startsWith(q.root + path.sep), key);
  }
  assert.deepEqual([env.DISABLE_TELEMETRY, env.DO_NOT_TRACK, env.NODE_DISABLE_COMPILE_CACHE], ['1', '1', '1']);
  assert.deepEqual([env.npm_config_offline, env.npm_config_audit, env.npm_config_fund, env.npm_config_update_notifier],
    ['true', 'false', 'false', 'false']);
  assert.ok(!Object.keys(env).some(key => /token|auth|password|secret|_key$/i.test(key)), 'no credentials in the environment');
  for (const name of ['maxMembers', 'maxFileBytes', 'maxTotalBytes', 'maxTarballBytes', 'timeoutMs']) {
    assert.ok(Number.isSafeInteger(q.limits[name]) && q.limits[name] > 0, `limit ${name}`);
  }
  return q;
}

// Every check above runs before the first process or write.
function archiveGate(qualificationFile, run = spawnSync) {
  const q = loadQualification(qualificationFile);
  const out = q.paths.output;
  const record = (label, argv, options) => {
    const result = run(argv[0], argv.slice(1), { encoding: 'utf8', maxBuffer: 64 << 20, timeout: q.limits.timeoutMs, ...options });
    fs.writeFileSync(path.join(out, `${label}.stdout`), result.stdout ?? '');
    fs.writeFileSync(path.join(out, `${label}.stderr`), result.stderr ?? '');
    fs.writeFileSync(path.join(out, `${label}.json`), `${JSON.stringify({ argv, cwd: options.cwd, env: options.env,
      status: result.status, signal: result.signal, error: result.error?.message ?? null }, null, 2)}\n`);
    assert.equal(result.error, undefined, `${label}: ${result.error?.message}`);
    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    return result.stdout;
  };
  const gitEnv = { PATH: '/usr/bin:/bin', HOME: q.paths.home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (label, args) => record(label, [q.tools.git.path, '-C', ROOT, ...args], { cwd: ROOT, env: gitEnv });
  const state = label => ({
    head: git(`git-${label}-head`, ['rev-parse', 'HEAD^{commit}', 'HEAD^{tree}']).trim().split('\n'),
    status: git(`git-${label}-status`, ['status', '--porcelain=v1', '--untracked-files=all']),
    hooks: HOOKS.map(hook => digest('sha256', regular(path.join(ROOT, 'hooks', 'dist', hook)))),
  });

  const before = state('before');
  assert.deepEqual(before.head, [q.commit, q.tree], 'checkout is not the qualified commit');
  assert.equal(before.status, '', 'checkout must be clean');
  const tree = parseLsTree(git('git-ls-tree', ['ls-tree', '-r', '-z', '--full-tree', q.commit]));
  checkBuiltHooks(ROOT, tree);
  const pkg = JSON.parse(regular(path.join(ROOT, 'package.json')));
  assert.equal(pkg.version, RELEASE);
  const expected = expectedPackage(tree, pkg);

  const report = JSON.parse(record('npm-pack', [q.tools.node.path, q.tools.npmCli.path, 'pack', '--json',
    '--pack-destination', q.paths.packDestination], { cwd: ROOT, env: q.environment }));
  assert.deepEqual(state('after'), before, 'packing changed the checkout or built hooks');
  const tarball = checkPackOutput(report, q.paths.packDestination, pkg, q.limits);

  const pyEnv = { PATH: '/usr/bin:/bin', HOME: q.paths.home, TMPDIR: q.paths.tmp };
  const python = (label, args) => record(label, [q.tools.python.path, '-I', '-B', '-c', PYTHON_TARFILE, ...args],
    { cwd: q.paths.tmp, env: pyEnv });
  const members = JSON.parse(python('python-list', ['list', tarball.file, tarball.sha256]));
  fs.writeFileSync(path.join(out, 'members.json'), `${JSON.stringify(members, null, 2)}\n`);
  const files = checkMembers(members, q.limits);
  assert.deepEqual(files, expected.map(row => row.path), 'archive inventory must equal the committed allowlist');
  assert.deepEqual(report[0].files.map(row => row.path).sort(), files, 'npm report must equal the archive');
  for (const file of files) {
    assert.ok(!file.split('/').some(part => PRIVATE_SEGMENTS.includes(part)), `private path shipped: ${file}`);
    assert.ok(!file.startsWith('skills/') && !file.startsWith('plugins/'), `Git-only distribution shipped: ${file}`);
  }

  const approved = path.join(out, 'approved.json');
  fs.writeFileSync(approved, `${JSON.stringify(files.map(file => `package/${file}`))}\n`);
  const extracted = JSON.parse(python('python-extract', ['extract', tarball.file, tarball.sha256, q.paths.extract, approved]));
  const modes = new Map(members.map(member => [member.name, member.mode]));
  const comparisons = expected.map(row => {
    const bytes = regular(path.join(q.paths.extract, 'package', row.path));
    const result = { path: row.path, committed: row.blob, archived: gitBlobId(bytes), sha256: digest('sha256', bytes),
      bytes: bytes.length, mode: modes.get(`package/${row.path}`).toString(8), committedMode: row.mode };
    assert.equal(result.archived, row.blob, `${row.path} differs from the committed bytes`);
    assert.equal(extracted[`package/${row.path}`].sha256, result.sha256, `${row.path} extraction digest`);
    assert.equal((modes.get(`package/${row.path}`) & 0o111) !== 0, row.mode === '100755', `${row.path} mode`);
    return result;
  });
  assert.equal(digest('sha256', regular(tarball.file)), tarball.sha256, 'tarball changed during inspection');

  const shipped = JSON.parse(regular(path.join(q.paths.extract, 'package', 'package.json')));
  assert.equal(shipped.version, RELEASE);
  for (const field of ['repository', 'homepage', 'bugs', 'files', 'pi', 'scripts']) assert.deepEqual(shipped[field], pkg[field], field);
  const svg = regular(path.join(q.paths.extract, 'package', 'assets', 'terminal.svg')).toString();
  assert.ok(svg.includes(`>v${RELEASE}</tspan>`), 'shipped image shows the release version');
  assert.match(regular(path.join(q.paths.extract, 'package', 'README.md')).toString(), /!\[FVS Install\]\(assets\/terminal\.svg\)/);

  const result = { status: 'pass', release: RELEASE, sourceRoot: ROOT, commit: q.commit, tree: q.tree,
    qualification: { path: qualificationFile, sha256: digest('sha256', regular(qualificationFile)) },
    tarball: { path: tarball.file, bytes: tarball.bytes.length, sha256: tarball.sha256, shasum: report[0].shasum,
      integrity: report[0].integrity }, members: members.length, files: comparisons.length,
    hooks: Object.fromEntries(HOOKS.map((hook, i) => [`hooks/dist/${hook}`, before.hooks[i]])), comparisons };
  fs.writeFileSync(path.join(out, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

describe('2.3.8 release surfaces', () => {
  it('agrees on one version across all six surfaces and the copied payload', () => {
    assert.equal(json('package.json').version, RELEASE);
    assert.deepEqual(read('fv-skills/VERSION'), Buffer.from(RELEASE), 'VERSION is exactly the version bytes');
    assert.equal(read('plugins/fvs/fv-skills/VERSION').toString(), `${RELEASE}\n`, 'the generator ends copied text with a newline');
    assert.equal(json('plugins/fvs/.claude-plugin/plugin.json').version, RELEASE);
    assert.equal(json('plugins/fvs/.codex-plugin/plugin.json').version, RELEASE);
    const changelog = read('CHANGELOG.md').toString();
    const releases = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/gm)];
    assert.equal(releases[0][1], RELEASE, 'newest dated changelog entry');
    assert.ok(!Number.isNaN(Date.parse(releases[0][2])) && releases[0][2] >= releases[1][2], 'release date');
    assert.ok(changelog.indexOf('## [Unreleased]') < releases[0].index, 'Unreleased stays on top');
    const svg = read('assets/terminal.svg').toString().replace(/<!--[\s\S]*?-->/g, '');
    assert.deepEqual([...svg.matchAll(/>v(\d+\.\d+\.\d+)</g)].map(match => match[1]), [RELEASE], 'visible SVG label');
  });

  it('generates one native skill per command and one separate setup bootstrap', () => {
    const commands = fs.readdirSync(path.join(ROOT, 'commands', 'fvs')).filter(name => name.endsWith('.md'))
      .map(name => name.slice(0, -3)).sort();
    const roles = fs.readdirSync(path.join(ROOT, 'agents')).filter(name => name.endsWith('.md')).sort();
    assert.equal(commands.length, 35);
    assert.equal(roles.length, 14);
    assert.deepEqual(dirs('plugins/fvs/skills'), commands);
    assert.deepEqual(dirs('pi/skills'), commands.map(name => `fvs-${name}`).sort());
    assert.deepEqual(fs.readdirSync(path.join(ROOT, 'plugins', 'fvs', 'agents')).sort(), roles);
    assert.ok(!commands.includes('setup'), 'the setup bootstrap is not a native workflow');
    assert.deepEqual(dirs('skills'), ['fvs-setup']);
    assert.deepEqual(fs.readdirSync(path.join(ROOT, 'skills', 'fvs-setup')), ['SKILL.md']);
    for (const manifest of ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.codex-plugin/plugin.json',
      '.agents/plugins/marketplace.json']) assert.ok(!fs.existsSync(path.join(ROOT, manifest)), `no root ${manifest}`);
  });

  it('ships a reviewed allowlist without the Git-only bootstrap, plugin payload or private state', () => {
    const pkg = json('package.json');
    assert.deepEqual(pkg.files, ALLOWLIST);
    assert.deepEqual(pkg.pi, { skills: ['./pi/skills'] });
    assert.deepEqual(pkg.dependencies, {});
    assert.equal(pkg.scripts.prepublishOnly, 'npm run build:hooks && npm run check:plugin');
    assert.ok(!['prepare', 'prepack', 'postpack', 'install', 'postinstall', 'preinstall'].some(name => pkg.scripts[name]),
      'packing and installing run no package scripts');
    assert.ok(!fs.existsSync(path.join(ROOT, '.npmignore')));
    for (const entry of pkg.files) {
      assert.ok(!entry.split('/').some(part => PRIVATE_SEGMENTS.includes(part)) && !/^(skills|plugins)(\/|$)/.test(entry), entry);
    }
  });
});

describe('archive validators (synthetic data, no archive or process)', () => {
  const limits = { maxMembers: 8, maxFileBytes: 100, maxTotalBytes: 150, maxTarballBytes: 1000 };
  const file = (name, extra = {}) => ({ name, type: 'file', mode: 0o644, size: 1, ...extra });
  const plain = [file('package/package.json'), { name: 'package/bin', type: 'dir', mode: 0o755, size: 0 }, file('package/bin/install.js')];

  it('accepts a plain package and lists its regular files', () => {
    assert.deepEqual(checkMembers(plain, limits), ['bin/install.js', 'package.json']);
  });
  for (const [label, members] of [
    ['absolute path', [file('/etc/passwd')]],
    ['member outside package/', [file('other/x')]],
    ['traversal', [file('package/../x')]],
    ['dot segment', [file('package/./x')]],
    ['empty segment', [file('package//x')]],
    ['backslash', [file('package/a\\b')]],
    ['drive letter', [file('package/C:/x')]],
    ['duplicate', [file('package/x'), file('package/x')]],
    ['case-fold alias', [file('package/README.md'), file('package/readme.md')]],
    ['Unicode alias', [file('package/caf\u00e9'), file('package/cafe\u0301')]],
    ['symlink', [{ ...file('package/x'), type: 'symlink' }]],
    ['hardlink', [{ ...file('package/x'), type: 'hardlink' }]],
    ['character device', [{ ...file('package/x'), type: 'char' }]],
    ['fifo', [{ ...file('package/x'), type: 'fifo' }]],
    ['file-directory collision', [file('package/bin'), file('package/bin/install.js')]],
    ['setuid mode', [file('package/x', { mode: 0o4755 })]],
    ['oversized member', [file('package/x', { size: 101 })]],
    ['oversized total', [file('package/x', { size: 100 }), file('package/y', { size: 100 })]],
    ['too many members', Array.from({ length: 9 }, (_, i) => file(`package/f${i}`))],
  ]) {
    it(`rejects ${label}`, () => assert.throws(() => checkMembers(members, limits)));
  }

  it('accepts only the single reported tarball with matching size and digests', () => {
    const destination = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fvs-release-pack-'));
    const pkg = { name: 'fv-skills-baif', version: RELEASE };
    const bytes = Buffer.from('synthetic bytes, not an archive');
    fs.writeFileSync(path.join(destination, `fv-skills-baif-${RELEASE}.tgz`), bytes);
    const good = { name: pkg.name, version: RELEASE, filename: `fv-skills-baif-${RELEASE}.tgz`, size: bytes.length,
      shasum: digest('sha1', bytes), integrity: `sha512-${digest('sha512', bytes, 'base64')}`, files: [], entryCount: 0 };
    assert.equal(checkPackOutput([good], destination, pkg, limits).sha256, digest('sha256', bytes));
    for (const change of [{ filename: '../x.tgz' }, { filename: `/tmp/fv-skills-baif-${RELEASE}.tgz` }, { version: '2.3.6' },
      { size: bytes.length + 1 }, { shasum: '0'.repeat(40) }, { integrity: 'sha512-AAAA' }, { entryCount: 1 }]) {
      assert.throws(() => checkPackOutput([{ ...good, ...change }], destination, pkg, limits), JSON.stringify(change));
    }
    assert.throws(() => checkPackOutput([good, good], destination, pkg, limits));
    fs.writeFileSync(path.join(destination, 'substituted.tgz'), bytes);
    assert.throws(() => checkPackOutput([good], destination, pkg, limits), /only the reported tarball/);
  });

  it('derives the expected archive from committed blobs, not from npm', () => {
    const blob = 'a'.repeat(40);
    const tree = ['package.json', 'README.md', 'LICENSE', 'bin/install.js', 'tests/x.test.cjs', 'skills/fvs-setup/SKILL.md',
      'plugins/fvs/LICENSE', 'hooks/fvs-check-update.js', 'hooks/fvs-statusline.js', 'CHANGELOG.md']
      .map(file => ({ mode: '100644', type: 'blob', blob, path: file }));
    assert.deepEqual(expectedPackage(tree, { files: ALLOWLIST }).map(row => row.path),
      ['bin/install.js', 'CHANGELOG.md', 'hooks/dist/fvs-check-update.js', 'hooks/dist/fvs-statusline.js', 'LICENSE',
        'package.json', 'README.md'].sort());
    assert.throws(() => expectedPackage(tree, { files: [...ALLOWLIST, 'tests'] }), /allowlist/);
    assert.throws(() => expectedPackage([{ mode: '120000', type: 'blob', blob, path: 'bin/link' }, ...tree], { files: ALLOWLIST }), /mode/);
  });

  it('detects built hooks that drifted from their committed source', () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fvs-release-hooks-'));
    fs.mkdirSync(path.join(root, 'hooks', 'dist'), { recursive: true });
    const tree = HOOKS.map(hook => {
      fs.writeFileSync(path.join(root, 'hooks', 'dist', hook), `${hook}\n`);
      return { mode: '100644', type: 'blob', blob: gitBlobId(Buffer.from(`${hook}\n`)), path: `hooks/${hook}` };
    });
    checkBuiltHooks(root, tree);
    fs.appendFileSync(path.join(root, 'hooks', 'dist', HOOKS[1]), 'drift');
    assert.throws(() => checkBuiltHooks(root, tree), /committed source/);
  });

  it('refuses an absent, relative or unverifiable qualification before any process', () => {
    const calls = [];
    const run = (...args) => { calls.push(args); throw new Error('no process may start'); };
    const bogus = path.join(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fvs-release-q-')), 'q.json');
    fs.writeFileSync(bogus, JSON.stringify({ schema: 'fvs-release-package-qualification/1', sourceRoot: fs.realpathSync(ROOT) }));
    for (const value of [undefined, '', 'relative.json', '/nonexistent/q.json', path.join(ROOT, 'package.json'), bogus]) {
      assert.throws(() => archiveGate(value, run), String(value));
    }
    assert.equal(calls.length, 0);
  });
});

if (process.env.FVS_RELEASE_PACKAGE_ARCHIVE === '1') {
  it('packs the committed candidate and inspects the real archive', () => {
    const result = archiveGate(process.env.FVS_RELEASE_PACKAGE_QUALIFICATION);
    console.log(JSON.stringify({ ...result, comparisons: undefined }));
  });
}
