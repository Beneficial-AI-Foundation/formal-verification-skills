'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const REPOSITORY = 'https://github.com/Beneficial-AI-Foundation/formal-verification-skills';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function regular(file) {
  assert.ok(path.isAbsolute(file), 'absolute input required');
  const s = fs.lstatSync(file);
  assert.ok(s.isFile() && !s.isSymbolicLink(), `regular file required: ${file}`);
  assert.equal(fs.realpathSync(file), file, 'canonical input required');
  return fs.readFileSync(file);
}
function bound(row) {
  const data = regular(row.path);
  assert.equal(data.length, row.bytes, row.path);
  assert.equal(hash(data), row.sha256, row.path);
}
function packageQualification(packetFile, acceptanceFile) {
  const bytes = regular(packetFile);
  assert.ok(bytes.length <= 1048576);
  const q = JSON.parse(bytes);
  const acceptance = JSON.parse(regular(acceptanceFile));
  assert.equal(acceptance.status, 'parent-exact-docstool/kernelpacket-reviewed-accepted-only-before-controlledpackagefixtures');
  assert.equal(acceptance.packet, packetFile);
  assert.equal(acceptance.packetBytes, bytes.length);
  assert.equal(acceptance.packetSha256, hash(bytes));
  assert.equal(q.npmVersion, '11.19.0');
  assert.equal(process.execPath, q.nodeAndLibrariesReverified[0].path);
  for (const row of [...q.nodeAndLibrariesReverified, ...q.rawBindings]) bound(row);
  for (const row of JSON.parse(regular(q.npmTreeIndex))) {
    assert.equal(row.type, 'regular');
    bound(row);
  }
  assert.equal(fs.realpathSync(q.root), q.root);
  assert.ok(fs.lstatSync(q.root).isDirectory());
  assert.equal(fs.statSync(q.root).uid, process.getuid());
  for (let p = q.root; ; p = path.dirname(p)) {
    assert.ok(!fs.lstatSync(p).isSymbolicLink());
    if (path.dirname(p) === p) break;
  }
  assert.equal(q.environment.DISABLE_TELEMETRY, '1');
  assert.equal(q.environment.DO_NOT_TRACK, '1');
  assert.equal(q.environment.npm_config_offline, 'true');
  for (const key of ['HOME', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'npm_config_cache', 'npm_config_userconfig', 'npm_config_globalconfig', 'npm_config_prefix']) {
    assert.ok(q.environment[key].startsWith(q.root + path.sep), key);
  }
  const profile = regular(q.profile).toString();
  assert.ok(profile.includes('(deny file-write*)') && profile.includes('(deny network*)'));
  assert.ok(profile.includes(`(subpath "${q.root}")`));
  return q;
}
function packageFixture(packetFile, acceptanceFile) {
  // All qualification checks precede copying or any npm invocation.
  const q = packageQualification(packetFile, acceptanceFile);
  const area = fs.mkdtempSync(path.join(q.root, 'source', 'package-'));
  const copy = path.join(area, 'copy');
  fs.mkdirSync(copy);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json')));
  const inputs = [...pkg.files, 'README.md', 'LICENSE', 'package.json'];
  for (const relative of inputs) {
    assert.ok(!path.isAbsolute(relative) && !relative.split(/[\\/]/).includes('..'));
    const source = path.join(ROOT, relative);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(copy, relative), { recursive: true, dereference: false });
  }
  const records = [];
  const run = (label, args) => {
    const argv = ['/usr/bin/sandbox-exec', '-f', q.profile, process.execPath, path.join(path.dirname(q.npmPackage), 'bin/npm-cli.js'), ...args, '--ignore-scripts', '--offline', '--cache', q.environment.npm_config_cache, '--no-audit', '--no-fund'];
    const result = spawnSync(argv[0], argv.slice(1), {cwd:copy, env:q.environment, encoding:'utf8', timeout:60000, maxBuffer:16*1024*1024});
    fs.writeFileSync(path.join(area, label + '.stdout'), result.stdout ?? '');
    fs.writeFileSync(path.join(area, label + '.stderr'), result.stderr ?? '');
    const record = {label, argv, cwd:copy, env:q.environment, exit:result.status, signal:result.signal, error:result.error?.message ?? null};
    fs.writeFileSync(path.join(area, label + '.json'), JSON.stringify(record, null, 2) + '\n');
    records.push(record);
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const dry = run('pack-dry-run', ['pack', '--dry-run', '--json']);
  const packed = run('pack', ['pack', '--json']);
  const publish = run('publish-dry-run', ['publish', '--dry-run', '--json']);
  for (const metadata of [dry[0], packed[0], publish]) {
    assert.equal(metadata.name, pkg.name);
    assert.equal(metadata.version, pkg.version);
    for (const file of ['README.md', 'package.json', 'assets/terminal.svg']) {
      assert.ok(metadata.files.some(row => row.path === file), `${file} missing`);
    }
    assert.ok(metadata.files.every(row => !row.path.includes('..') && !path.isAbsolute(row.path) && !row.path.includes('.planning')));
  }
  const tarball = path.join(copy, packed[0].filename);
  assert.equal(hash(fs.readFileSync(tarball)), hash(fs.readFileSync(tarball)));
  // Use npm's already byte-qualified tar dependency as a data reader, never a lifecycle runner.
  const tar = require(path.join(path.dirname(q.npmPackage), 'node_modules/tar'));
  const members = new Map();
  return tar.t({file:tarball, sync:true, onReadEntry:entry => {
    assert.ok(entry.path.startsWith('package/') && !entry.path.split('/').includes('..'));
    assert.ok(['File', 'Directory'].includes(entry.type), 'no archive links or special files');
    const chunks = [];
    entry.on('data', chunk => chunks.push(chunk));
    entry.on('end', () => members.set(entry.path, Buffer.concat(chunks)));
  }}), Promise.resolve().then(() => {
    for (const relative of ['README.md', 'package.json', 'assets/terminal.svg']) {
      const actual = members.get('package/' + relative);
      assert.ok(actual, `${relative} absent from archive`);
      assert.deepEqual(actual, fs.readFileSync(path.join(copy, relative)));
      fs.writeFileSync(path.join(area, relative.replaceAll('/', '-') + '.archive-bytes'), actual);
    }
    const manifest = JSON.parse(members.get('package/package.json'));
    assert.deepEqual(manifest.repository, pkg.repository);
    assert.equal(manifest.homepage, pkg.homepage);
    assert.deepEqual(manifest.bugs, pkg.bugs);
    const outcome = {status:'pass', sourceRoot:ROOT, area, tarball, tarballSha256:hash(fs.readFileSync(tarball)), svgSha256:hash(fs.readFileSync(path.join(ROOT,'assets/terminal.svg'))), records};
    fs.writeFileSync(path.join(area,'outcome.json'),JSON.stringify(outcome,null,2)+'\n');
    console.log(JSON.stringify(outcome));
    return outcome;
  });
}
if (process.argv.includes('--package-fixture')) {
  const at = process.argv.indexOf('--package-fixture');
  Promise.resolve().then(() => packageFixture(process.argv[at+1],process.argv[at+2])).catch(e => { console.error(e.stack); process.exitCode=1; });
} else {
  const {it} = require('node:test');
  const pkg = require('../package.json');
  it('ships canonical metadata and the exact README image', () => {
    assert.deepEqual(pkg.repository, {type:'git',url:`git+${REPOSITORY}.git`});
    assert.equal(pkg.homepage, REPOSITORY+'#readme');
    assert.deepEqual(pkg.bugs,{url:REPOSITORY+'/issues'});
    assert.ok(pkg.files.includes('assets/terminal.svg'));
    assert.match(fs.readFileSync(path.join(ROOT,'README.md'),'utf8'), /!\[FVS Install\]\(assets\/terminal\.svg\)/);
    assert.match(fs.readFileSync(path.join(ROOT,'assets/terminal.svg'),'utf8'), /2\.3\.6/);
  });
  it('real help follows the package version and explains registry availability', () => {
    const installer = require('../bin/install.js');
    const help = spawnSync(process.execPath,[path.join(ROOT,'bin/install.js'),'--help'],{encoding:'utf8',timeout:10000});
    assert.equal(help.status,0,help.stderr);
    assert.ok(help.stdout.includes(`--pi-version ${pkg.version}`));
    assert.match(help.stdout,/exact versions must be available in the registry/i);
    assert.deepEqual(installer.buildPiCommand('install',pkg.version,false), ['install',installer.buildPiPackageSource(pkg.version),'--local']);
  });
  it('future-version copied help neither installs nor claims publication', () => {
    const area = fs.mkdtempSync(path.join(os.tmpdir(),'fvs-help-version-'));
    fs.mkdirSync(path.join(area,'bin'));
    fs.copyFileSync(path.join(ROOT,'bin/install.js'),path.join(area,'bin/install.js'));
    fs.writeFileSync(path.join(area,'package.json'),JSON.stringify({...pkg,version:'9.8.7'}));
    const result = spawnSync(process.execPath,[path.join(area,'bin/install.js'),'--help'],{cwd:area,encoding:'utf8',timeout:10000});
    fs.writeFileSync(path.join(area,'help.stdout'),result.stdout);
    fs.writeFileSync(path.join(area,'help.stderr'),result.stderr);
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,/--pi-version 9\.8\.7/);
    assert.match(result.stdout,/exact versions must be available in the registry/i);
    assert.deepEqual(fs.readdirSync(area).sort(),['bin','help.stderr','help.stdout','package.json']);
  });
  it('physical fixtures refuse missing qualification before package side effects', () => {
    assert.throws(() => packageQualification(undefined,undefined), /path|absolute/i);
    assert.throws(() => packageQualification(path.join(ROOT,'package.json'),path.join(ROOT,'package.json')), /parent-exact/);
  });
}
module.exports = {packageQualification, packageFixture};
