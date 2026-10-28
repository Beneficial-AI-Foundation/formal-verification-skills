// Controlled recipes invoked only by explicit Windows setup. Cache bytes are
// accepted solely against the complete built-in historical artifact records.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { windowsFileSha256, plainWindowsPath, fingerprintWindowsResource, windowsSourceAssets } from '../../fvs-probe-windows-runtime.mjs';

function copyTree(source, destination, records, relative, allowSourceHardlinks) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && !allowSourceHardlinks && stat.nlink !== 1)) throw new Error(`Link or special copy source is unsupported: ${source}`);
  // Root ancestors were checked once. Each entry's full canonical spelling
  // still detects a junction or alias introduced in any intervening ancestor.
  if (fs.realpathSync.native(source).toLowerCase() !== path.resolve(source).toLowerCase()) throw new Error(`Copy source alias: ${source}`);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const name of fs.readdirSync(source).sort()) {
      if (!name || /[. ]$/.test(name) || /[\x00-\x1f:<>"|?*]/.test(name) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) throw new Error(`Unsupported copy entry spelling: ${name}`);
      copyTree(path.join(source, name), path.join(destination, name), records, relative ? relative + '/' + name : name, allowSourceHardlinks);
    }
  } else {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const sha256 = windowsFileSha256(source); fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    const copy = fs.lstatSync(destination), after = fs.lstatSync(source);
    if (copy.nlink !== 1 || !copy.isFile() || (copy.dev === stat.dev && copy.ino === stat.ino) || windowsFileSha256(destination) !== sha256 || windowsFileSha256(source) !== sha256 || after.dev !== stat.dev || after.ino !== stat.ino) throw new Error(`Independent copy identity changed: ${source}`);
    records?.push({ relativePath: relative, source, sha256, bytes: stat.size, sourceLinkCount: stat.nlink });
  }
}
export function copyIndependent(source, destination) {
  plainWindowsPath(source); copyTree(source, destination, null, '', false);
}
// Trusted build products and prerequisites may contain intentional hardlinks
// (Cargo and Git for Windows do). Only source leaves may be linked; every
// copied output is independent and its source identity and bytes are rechecked.
export function copyPrerequisiteIndependent(source, destination, records = [], relative = '') {
  plainWindowsPath(fs.lstatSync(source).isDirectory() ? source : path.dirname(source));
  copyTree(source, destination, records, relative, true);
  return records;
}
function checked(file, expected) {
  plainWindowsPath(file);
  if (windowsFileSha256(file) !== expected) throw new Error(`Pinned input checksum differs: ${file}`);
  return file;
}
export async function obtainArchive(ctx, name) {
  ctx.archives ??= {};
  if (ctx.archives[name]) return ctx.archives[name];
  const spec = ctx.policy.archives[name];
  const directory = path.join(ctx.stage, 'archives'); fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, spec.filename);
  const cached = ctx.cacheDirectory && path.join(ctx.cacheDirectory, 'archives', spec.filename);
  if (cached && fs.existsSync(cached)) copyIndependent(checked(cached, spec.sha256), output);
  else {
    ctx.onProgress?.({ phase: 'download', name, url: spec.url });
    const response = await fetch(spec.url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
    if (!response.ok || !response.body || !response.url.startsWith('https://')) throw new Error(`Pinned download failed: ${spec.url}`);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(output, { flags: 'wx' }));
  }
  checked(output, spec.sha256);
  ctx.archives[name] = output;
  return output;
}
export async function unpackArchive(ctx, name) {
  ctx.unpacked ??= {};
  if (ctx.unpacked[name]) return ctx.unpacked[name];
  const archive = await obtainArchive(ctx, name), destination = path.join(ctx.stage, 'prerequisites', name);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (name === 'fsAt') {
    fs.mkdirSync(destination);
    await ctx.run(path.join(ctx.facts.systemDirectory, 'tar.exe'), ['-xzf', archive, '-C', destination], { label: `unpack-${name}` });
  } else {
    const recipe = fs.readFileSync(path.join(windowsSourceAssets, 'Extract-Archive.ps1'), 'utf8');
    await ctx.run(ctx.facts.powershell, ['-NoProfile', '-NonInteractive', '-Command', `& { ${recipe}\n} -Archive $env:FVS_SOURCE_ARCHIVE -Destination $env:FVS_SOURCE_DESTINATION`], { label: `unpack-${name}`, env: { FVS_SOURCE_ARCHIVE: archive, FVS_SOURCE_DESTINATION: destination } });
  }
  const result = path.join(destination, ctx.policy.archives[name].root);
  plainWindowsPath(result);
  ctx.unpacked[name] = result;
  return result;
}
function cachedGroup(ctx, name) {
  const group = ctx.policy.reviewedArtifacts[name];
  const source = ctx.cacheDirectory && path.join(ctx.cacheDirectory, 'artifacts', name);
  if (!source || !fs.existsSync(source)) return null;
  for (const item of group.files) {
    const file = path.join(source, item.relativePath);
    checked(file, item.sha256);
    if (fs.statSync(file).size !== item.bytes) throw new Error(`Cached artifact length differs: ${file}`);
  }
  return { source, group };
}
async function checkout(ctx, name) {
  const recipe = ctx.policy.sources[name], source = path.join(ctx.stage, 'sources', name);
  fs.mkdirSync(path.dirname(source), { recursive: true });
  await ctx.run(ctx.prerequisites.git, ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=NUL', 'clone', '--no-checkout', '--', recipe.repository, source], { label: `clone-${name}` });
  await ctx.run(ctx.prerequisites.git, ['-C', source, '-c', 'core.autocrlf=false', 'checkout', '--detach', recipe.commit], { label: `checkout-${name}` });
  const head = (await ctx.run(ctx.prerequisites.git, ['-C', source, 'rev-parse', 'HEAD'], { label: `pin-${name}` })).stdout.trim();
  if (head !== recipe.commit) throw new Error(`Source commit mismatch: ${name}`);
  if (recipe.patch) await ctx.run(ctx.prerequisites.git, ['-C', source, 'apply', '--whitespace=error', path.join(windowsSourceAssets, recipe.patch)], { label: `patch-${name}` });
  if (recipe.lockSha256 && name !== 'rustup') checked(path.join(source, 'Cargo.lock'), recipe.lockSha256);
  return source;
}
async function sourceManifest(ctx, source, name) {
  const names = (await ctx.run(ctx.prerequisites.git, ['-C', source, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { label: `manifest-${name}` })).stdout.split('\0').filter(Boolean).sort();
  const entries = names.map(relativePath => ({ relativePath, sha256: windowsFileSha256(path.join(source, relativePath)) }));
  return { repository: ctx.policy.sources[name].repository, commit: ctx.policy.sources[name].commit, patchSha256: ctx.policy.sources[name].patch ? ctx.policy.patches[ctx.policy.sources[name].patch] : null, entries };
}
async function build(ctx, name, output) {
  const source = await checkout(ctx, name), extra = { cwd: source };
  if (name === 'probe-aeneas' || name === 'probe-rust') {
    await ctx.run(ctx.prerequisites.cargo, ['fetch', '--locked'], { ...extra, label: `fetch-${name}` });
    await ctx.run(ctx.prerequisites.cargo, ['test', '--locked', '--offline'], { ...extra, label: `test-${name}` });
    await ctx.run(ctx.prerequisites.cargo, ['build', '--locked', '--release', '--offline'], { ...extra, label: `build-${name}` });
    copyPrerequisiteIndependent(path.join(source, 'target', 'release', name + '.exe'), path.join(output, name + '.exe'));
  } else if (name === 'scip') {
    const goRoot = await unpackArchive(ctx, 'go'), go = path.join(goRoot, 'bin', 'go.exe');
    const env = { GOROOT: goRoot, GOPATH: path.join(ctx.stage, 'go-home'), GOCACHE: path.join(ctx.stage, 'go-cache'), CGO_ENABLED: '0', GOOS: 'windows', GOARCH: 'amd64', GOWORK: 'off', GOTOOLCHAIN: 'local' };
    await ctx.run(go, ['mod', 'download'], { ...extra, env, label: 'fetch-scip' });
    await ctx.run(go, ['test', '-mod=readonly', './cmd/scip', '-run', 'TestJSONPrinting', '-count=1'], { ...extra, env, label: 'test-scip' });
    await ctx.run(go, ['build', '-mod=readonly', '-ldflags', '-X main.Reproducible=true', '-o', path.join(output, 'scip.exe'), './cmd/scip'], { ...extra, env, label: 'build-scip' });
  } else if (name === 'probe-lean') {
    const leanRoot = await unpackArchive(ctx, 'lean'), lake = path.join(leanRoot, 'bin', 'lake.exe');
    const env = { PATH: path.join(leanRoot, 'bin') + ';' + ctx.environment.PATH, ELAN_HOME: path.join(ctx.stage, 'elan-home') };
    await ctx.run(lake, ['--keep-toolchain', 'update', 'Cli'], { ...extra, env, label: 'fetch-probe-lean' });
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'lake-manifest.json'), 'utf8'));
    if (manifest.packages.length !== 1 || manifest.packages[0].rev !== ctx.policy.sources['probe-lean'].cliCommit) throw new Error('Unexpected Lean helper dependency closure');
    await ctx.run(lake, ['build', 'probe-lean', 'tests'], { ...extra, env, label: 'build-probe-lean' });
    await ctx.run(path.join(source, '.lake', 'build', 'bin', 'tests.exe'), [], { ...extra, env, label: 'test-probe-lean' });
    copyIndependent(path.join(source, '.lake', 'build', 'bin', 'probe-lean.exe'), path.join(output, 'bin', 'probe-lean-v4.31.0.exe'));
    // Install only runtime library products, not object files or test libraries.
    const library = path.join(source, '.lake', 'build', 'lib', 'lean');
    for (const file of ctx.policy.reviewedArtifacts['probe-lean'].files.filter(x => x.relativePath.startsWith('lib/'))) copyIndependent(path.join(library, file.relativePath.slice(4)), path.join(output, file.relativePath));
    for (const file of ctx.policy.reviewedArtifacts['probe-lean'].files.filter(x => x.relativePath.endsWith('.dll'))) copyIndependent(path.join(leanRoot, 'bin', path.basename(file.relativePath)), path.join(output, file.relativePath));
  } else if (name === 'rustup') {
    const recipe = ctx.policy.sources.rustup, lock = path.join(source, 'Cargo.lock');
    checked(lock, recipe.lockOriginalSha256);
    const original = fs.readFileSync(lock, 'utf8');
    const patched = original.replace(/(\[\[package\]\]\r?\nname = "fs_at"\r?\nversion = "0\.2\.1"\r?\n)source = [^\n]+\nchecksum = [^\n]+\n/, '$1');
    fs.writeFileSync(lock, patched); checked(lock, recipe.lockSha256);
    const fsAt = await unpackArchive(ctx, 'fsAt');
    await ctx.run(ctx.prerequisites.git, ['apply', '--unsafe-paths', '--directory=' + fsAt.replaceAll('\\', '/'), path.join(windowsSourceAssets, recipe.fsAtPatch)], { cwd: ctx.stage, label: 'patch-fs-at' });
    checked(path.join(fsAt, 'src', 'win.rs'), recipe.fsAtWinSha256);
    const patchConfig = path.join(ctx.stage, 'rustup-patch.toml');
    fs.writeFileSync(patchConfig, `[patch.crates-io]\nfs_at = { path = ${JSON.stringify(fsAt.replaceAll('\\', '/'))} }\n`);
    const cmake = await unpackArchive(ctx, 'cmake'), nasm = await unpackArchive(ctx, 'nasm');
    const env = { PATH: path.join(cmake, 'bin') + ';' + nasm + ';' + ctx.environment.PATH };
    await ctx.run(ctx.prerequisites.cargo, ['fetch', '--locked', '--config', patchConfig], { ...extra, env, label: 'fetch-rustup' });
    await ctx.run(ctx.prerequisites.cargo, ['build', '--locked', '--release', '--offline', '--config', patchConfig, '--bin', 'rustup-init'], { ...extra, env, label: 'build-rustup' });
    copyPrerequisiteIndependent(path.join(source, 'target', 'release', 'rustup-init.exe'), path.join(output, 'rustup-init.exe'));
  }
  return { origin: 'fresh-source-build', source: await sourceManifest(ctx, source, name), output: fingerprintWindowsResource(output) };
}
export async function buildWindowsGroups(ctx) {
  const groups = {}, builds = {};
  for (const name of ['probe-aeneas', 'probe-rust', 'probe-lean', 'scip', 'rustup']) {
    ctx.onProgress?.({ phase: 'source-artifact', name });
    const output = path.join(ctx.stage, 'outputs', name); fs.mkdirSync(output, { recursive: true });
    const reused = ctx.reusableGroups?.[name];
    const cached = reused ? null : cachedGroup(ctx, name);
    if (reused) {
      ctx.onProgress?.({ phase: 'reuse-registered-helper', name, installationId: reused.installationId });
      copyIndependent(reused.source, output);
      const fingerprint = fingerprintWindowsResource(output);
      if (JSON.stringify(fingerprint) !== JSON.stringify(reused.build.output)) throw new Error('Registered helper changed while copying: ' + name);
      builds[name] = { ...reused.build, output: fingerprint, reusedFrom: { installationId: reused.installationId, receiptSha256: reused.receiptSha256 } };
    } else if (cached) {
      for (const item of cached.group.files) copyIndependent(path.join(cached.source, item.relativePath), path.join(output, item.relativePath));
      builds[name] = { origin: 'reviewed-existing-artifact', source: cached.group.source, build: cached.group.build, historicalEvidenceSha256: cached.group.evidenceSha256, approvedFiles: cached.group.files, output: fingerprintWindowsResource(output) };
    } else builds[name] = await build(ctx, name, output);
    groups[name] = output;
  }
  return { groups, builds };
}
