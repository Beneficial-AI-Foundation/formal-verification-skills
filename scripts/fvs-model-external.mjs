#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sha256 = value => createHash('sha256').update(value).digest('hex');

function fail(message) {
  throw new Error(message);
}

function realFile(file, parent) {
  const resolved = fs.realpathSync(file);
  const prefix = `${fs.realpathSync(parent)}${path.sep}`;
  if (!resolved.startsWith(prefix) || !fs.statSync(resolved).isFile()) {
    fail(`source path escapes its authoritative root: ${file}`);
  }
  return resolved;
}

function parseTomlString(block, key) {
  return block.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm'))?.[1] ?? null;
}

export function parseCargoLock(text) {
  return text.split(/^\[\[package\]\]\s*$/m).slice(1).map(block => ({
    name: parseTomlString(block, 'name'),
    version: parseTomlString(block, 'version'),
    source: parseTomlString(block, 'source'),
    checksum: parseTomlString(block, 'checksum'),
  }));
}

function lockedPackage(request, root) {
  const lockfile = realFile(path.resolve(root, request.lockfile ?? 'Cargo.lock'), root);
  const matches = parseCargoLock(fs.readFileSync(lockfile, 'utf8')).filter(pkg =>
    pkg.name === request.package && pkg.version === request.version);
  if (matches.length !== 1) {
    fail(`Cargo.lock must contain exactly one ${request.package} ${request.version} package`);
  }
  return { lockfile, package: matches[0] };
}

function packageIdentity(crateRoot) {
  const manifest = fs.readFileSync(path.join(crateRoot, 'Cargo.toml'), 'utf8');
  const packageBlock = manifest.split(/\n(?=\[)/)
    .find(section => /^\[package\]\s*$/m.test(section)) ?? '';
  return {
    name: parseTomlString(packageBlock, 'name'),
    version: parseTomlString(packageBlock, 'version'),
  };
}

function registryRoots(request, cargoHome) {
  const sourceRoot = path.join(cargoHome, 'registry', 'src');
  if (!fs.existsSync(sourceRoot)) return [];
  const expected = `${request.package}-${request.version}`;
  const roots = [];
  const sourcePrefix = `${fs.realpathSync(sourceRoot)}${path.sep}`;
  for (const index of fs.readdirSync(sourceRoot).sort()) {
    const candidate = path.join(sourceRoot, index, expected);
    if (!fs.existsSync(path.join(candidate, 'Cargo.toml'))) continue;
    const resolved = fs.realpathSync(candidate);
    if (!resolved.startsWith(sourcePrefix)) fail('Cargo registry source candidate is redirected');
    const identity = packageIdentity(resolved);
    if (identity.name === request.package && identity.version === request.version) {
      roots.push(resolved);
    }
  }
  return roots;
}

function configuredVendorRoot(root) {
  const configFile = ['config.toml', 'config']
    .map(name => path.join(root, '.cargo', name))
    .find(file => fs.existsSync(file));
  if (!configFile) fail('vendor resolution requires .cargo/config.toml or .cargo/config');
  const config = fs.readFileSync(configFile, 'utf8');
  const sections = config.split(/\n(?=\[)/).filter(part => /^\[source\.[^\]]+\]/.test(part));
  const vendors = sections.filter(part => /^directory\s*=/m.test(part));
  if (vendors.length !== 1) fail('Cargo source replacement must configure exactly one vendor directory');
  const vendorName = vendors[0].match(/^\[source\.([^\]]+)\]/)?.[1];
  if (!sections.some(part => parseTomlString(part, 'replace-with') === vendorName)) {
    fail('Cargo vendor directory is not selected by a source replacement');
  }
  const directory = parseTomlString(vendors[0], 'directory');
  const vendorRoot = fs.realpathSync(path.resolve(path.dirname(configFile), '..', directory));
  const prefix = `${fs.realpathSync(root)}${path.sep}`;
  if (!vendorRoot.startsWith(prefix) || !fs.statSync(vendorRoot).isDirectory()) {
    fail('configured vendor directory escapes the project root');
  }
  return vendorRoot;
}

function vendorRoots(request, root) {
  const vendorRoot = configuredVendorRoot(root);
  return fs.readdirSync(vendorRoot).sort().flatMap(name => {
    const candidate = path.join(vendorRoot, name);
    if (!fs.existsSync(path.join(candidate, 'Cargo.toml'))) return [];
    if (fs.lstatSync(candidate).isSymbolicLink()) fail('vendored crate source is redirected');
    const identity = packageIdentity(candidate);
    return identity.name === request.package && identity.version === request.version
      ? [fs.realpathSync(candidate)] : [];
  });
}

function verifyVendorChecksum(crateRoot, relativeFile, expectedPackageChecksum) {
  const checksumFile = path.join(crateRoot, '.cargo-checksum.json');
  if (!fs.existsSync(checksumFile)) fail('vendored crate is missing .cargo-checksum.json');
  const checksums = JSON.parse(fs.readFileSync(checksumFile, 'utf8'));
  const file = realFile(path.resolve(crateRoot, relativeFile), crateRoot);
  if (checksums.package !== expectedPackageChecksum ||
      checksums.files?.[relativeFile] !== sha256(fs.readFileSync(file))) {
    fail('vendored source checksum does not match Cargo metadata');
  }
}

function gitRoots(request, cargoHome, revision, lockedUrl) {
  const checkouts = path.join(cargoHome, 'git', 'checkouts');
  if (!fs.existsSync(checkouts)) return [];
  const roots = [];
  function walk(directory, depth) {
    if (depth > 5) return;
    const manifest = path.join(directory, 'Cargo.toml');
    if (fs.existsSync(manifest)) {
      const identity = packageIdentity(directory);
      if (identity.name === request.package && identity.version === request.version) {
        const result = spawnSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
        const remote = spawnSync('git', ['-C', directory, 'remote', 'get-url', 'origin'], { encoding: 'utf8' });
        if (result.status === 0 && result.stdout.trim() === revision &&
            remote.status === 0 && remote.stdout.trim().replace(/\.git$/, '') === lockedUrl.replace(/\.git$/, '')) {
          roots.push(fs.realpathSync(directory));
        }
      }
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== '.git') walk(path.join(directory, entry.name), depth + 1);
    }
  }
  walk(checkouts, 0);
  return roots;
}

function rejectGeneratedSource(bytes) {
  const header = bytes.toString('utf8').split('\n').slice(0, 20).join('\n');
  if (/@generated|automatically generated|generated by .*do not edit|this file .*generated/i.test(header)) {
    fail('generated source is not an inspectable authoritative function body');
  }
}

function rangeBytes(bytes, startLine, endLine) {
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) ||
      startLine < 1 || endLine < startLine) {
    fail('source range must use positive inclusive safe-integer line numbers');
  }
  const lines = bytes.toString('utf8').match(/.*(?:\n|$)/g).filter(Boolean);
  if (endLine > lines.length) fail(`source range ends after line ${lines.length}`);
  return Buffer.from(lines.slice(startLine - 1, endLine).join(''));
}

function selectMatchingSource(roots, relativeFile) {
  const candidates = roots.map(root => {
    const file = realFile(path.resolve(root, relativeFile), root);
    return { root, file, bytes: fs.readFileSync(file) };
  });
  if (candidates.length === 0) fail('authoritative source is not available locally');
  const expected = sha256(candidates[0].bytes);
  if (candidates.some(candidate => sha256(candidate.bytes) !== expected)) {
    fail('authoritative local source copies disagree');
  }
  return candidates[0];
}

export function resolveSource(request, root = fs.realpathSync(process.cwd()), env = process.env) {
  if (!request || typeof request !== 'object') fail('resolve request must be a JSON object');
  if (request.strategy === 'sysroot') {
    if (!/^[A-Za-z0-9_-]+$/.test(request.package ?? '')) fail('invalid rustc library name');
    const rustc = env.RUSTC ?? 'rustc';
    const sysrootResult = spawnSync(rustc, ['--print', 'sysroot'], { encoding: 'utf8', env });
    const versionResult = spawnSync(rustc, ['-vV'], { encoding: 'utf8', env });
    if (sysrootResult.status !== 0 || versionResult.status !== 0) {
      fail('failed to query the pinned rustc sysroot');
    }
    const commit = versionResult.stdout.match(/^commit-hash:\s*([0-9a-f]{40})$/m)?.[1];
    if (!commit) fail('rustc sysroot has no inspectable exact commit hash');
    const sysroot = fs.realpathSync(sysrootResult.stdout.trim());
    const library = fs.realpathSync(path.join(sysroot, 'lib', 'rustlib', 'src', 'rust', 'library', request.package));
    if (!library.startsWith(`${sysroot}${path.sep}`)) fail('rustc sysroot source is redirected');
    const selected = selectMatchingSource([library], request.source_file);
    rejectGeneratedSource(selected.bytes);
    const selectedRange = rangeBytes(selected.bytes, request.start_line, request.end_line);
    if (request.function && !new RegExp(`\\bfn\\s+${request.function.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(selectedRange.toString('utf8'))) {
      fail(`selected range does not contain function ${request.function}`);
    }
    return {
      status: 'RESOLVED',
      strategy: 'sysroot',
      package: request.package,
      revision: commit,
      authority: versionResult.stdout.split('\n')[0],
      checksum: null,
      file: selected.file,
      relative_file: request.source_file,
      range: { start_line: request.start_line, end_line: request.end_line },
      sha256: sha256(selected.bytes),
      range_sha256: sha256(selectedRange),
      unsafe: /\bunsafe\s+fn\b/.test(selectedRange.toString('utf8')),
    };
  }
  if (!['registry', 'vendor', 'git'].includes(request.strategy)) {
    fail(`unsupported source strategy: ${request.strategy ?? '(missing)'}`);
  }
  const locked = lockedPackage(request, root);
  const cargoHomePath = env.CARGO_HOME ?? path.join(os.homedir(), '.cargo');
  const cargoHome = fs.existsSync(cargoHomePath) ? fs.realpathSync(cargoHomePath) : cargoHomePath;
  let roots;
  let revision;
  if (request.strategy === 'git') {
    const commit = locked.package.source?.match(/#([0-9a-f]{40})$/)?.[1];
    const lockedUrl = locked.package.source?.match(/^git\+([^?#]+)(?:\?|#)/)?.[1];
    if (!locked.package.source?.startsWith('git+') || !commit || !lockedUrl) {
      fail('git resolution requires an exact URL and commit in the Cargo.lock source');
    }
    revision = commit;
    roots = gitRoots(request, cargoHome, commit, lockedUrl);
  } else {
    if (!locked.package.source?.startsWith('registry+') || !locked.package.checksum) {
      fail(`${request.strategy} resolution requires a registry Cargo.lock source and checksum`);
    }
    revision = request.version;
    if (request.strategy === 'vendor') {
      const vendors = vendorRoots(request, root);
      if (vendors.length !== 1) fail('vendor directory must contain exactly one locked package match');
      verifyVendorChecksum(vendors[0], request.source_file, locked.package.checksum);
      roots = [...vendors, ...registryRoots(request, cargoHome)];
    } else {
      roots = registryRoots(request, cargoHome);
    }
  }
  const selected = selectMatchingSource(roots, request.source_file);
  const bytes = selected.bytes;
  rejectGeneratedSource(bytes);
  const selectedRange = rangeBytes(bytes, request.start_line, request.end_line);
  if (request.function && !new RegExp(`\\bfn\\s+${request.function.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(selectedRange.toString('utf8'))) {
    fail(`selected range does not contain function ${request.function}`);
  }
  return {
    status: 'RESOLVED',
    strategy: request.strategy,
    package: request.package,
    revision,
    authority: locked.package.source,
    checksum: locked.package.checksum ?? null,
    file: selected.file,
    relative_file: request.source_file,
    range: { start_line: request.start_line, end_line: request.end_line },
    sha256: sha256(bytes),
    range_sha256: sha256(selectedRange),
    unsafe: /\bunsafe\s+fn\b/.test(selectedRange.toString('utf8')),
  };
}

function projectTarget(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.length === 0) {
    fail('transaction targets must be non-empty project-relative paths');
  }
  const resolved = path.resolve(root, relative);
  const prefix = `${root}${path.sep}`;
  if (!resolved.startsWith(prefix)) fail(`transaction target escapes the project root: ${relative}`);
  let ancestor = resolved;
  while (!fs.lstatSync(ancestor, { throwIfNoEntry: false })) ancestor = path.dirname(ancestor);
  if (fs.lstatSync(ancestor).isSymbolicLink()) {
    fail(`transaction target crosses a symbolic link: ${relative}`);
  }
  const realAncestor = fs.realpathSync(ancestor);
  if (realAncestor !== root && !realAncestor.startsWith(prefix)) {
    fail(`transaction target resolves outside the project root: ${relative}`);
  }
  const basename = path.basename(relative);
  if (basename === 'Funs.lean' || basename === 'Types.lean' || /_Template\.lean$/.test(basename)) {
    fail(`generated Lean target is immutable: ${relative}`);
  }
  if (basename === 'FunsExternal.lean' && fs.existsSync(resolved) &&
      /auto-generated|generated file|do not edit/i.test(fs.readFileSync(resolved, 'utf8'))) {
    fail('legacy generated FunsExternal.lean requires migration before modeling');
  }
  return resolved;
}

function writeJsonExclusive(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

export function beginTransaction(request, root = fs.realpathSync(process.cwd())) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.run ?? '')) fail('invalid transaction run name');
  if (!request.root_stub || !Array.isArray(request.closure) || !request.closure.includes(request.root_stub)) {
    fail('transaction closure must include the requested root stub');
  }
  if (!Array.isArray(request.targets) || request.targets.length === 0 ||
      new Set(request.targets).size !== request.targets.length) {
    fail('transaction requires a non-empty unique target list');
  }
  if (!Array.isArray(request.source_records) || request.source_records.length === 0) {
    fail('transaction requires immutable source records');
  }
  const base = path.join(root, '.formalising', 'model-external');
  const runDirectory = path.join(base, request.run);
  const validatedTargets = request.targets.map(relative => ({
    relative,
    target: projectTarget(root, relative),
  }));
  if (validatedTargets.some(({ target }) => target.startsWith(`${runDirectory}${path.sep}`))) {
    fail('transaction evidence cannot be a target');
  }
  const validatedSources = request.source_records.map((record, index) => {
    if (record?.status !== 'RESOLVED' || !['registry', 'vendor', 'git', 'sysroot'].includes(record.strategy) ||
        record.unsafe !== false || typeof record.file !== 'string' ||
        !/^[0-9a-f]{64}$/.test(record.sha256 ?? '') ||
        !/^[0-9a-f]{64}$/.test(record.range_sha256 ?? '')) {
      fail(`invalid or unsafe source record ${index}`);
    }
    const file = fs.realpathSync(record.file);
    const bytes = fs.readFileSync(file);
    const selected = rangeBytes(bytes, record.range?.start_line, record.range?.end_line);
    if (sha256(bytes) !== record.sha256 || sha256(selected) !== record.range_sha256) {
      fail(`source record changed before transaction: ${record.file}`);
    }
    return { record, selected, name: `${String(index).padStart(3, '0')}-${path.basename(file)}` };
  });
  projectTarget(root, '.formalising/model-external/.evidence-root');
  fs.mkdirSync(base, { recursive: true });
  if (fs.realpathSync(base) !== base) fail('model-external evidence path is redirected');
  fs.mkdirSync(runDirectory);
  const baselineRoot = path.join(runDirectory, 'baseline');
  const sourceRoot = path.join(runDirectory, 'source');
  fs.mkdirSync(baselineRoot);
  fs.mkdirSync(sourceRoot);
  const targets = validatedTargets.map(({ relative, target }) => {
    const existed = fs.existsSync(target);
    const baseline = path.join(baselineRoot, relative);
    if (existed) {
      fs.mkdirSync(path.dirname(baseline), { recursive: true });
      fs.copyFileSync(target, baseline, fs.constants.COPYFILE_EXCL);
    }
    return {
      path: relative,
      existed,
      sha256: existed ? sha256(fs.readFileSync(target)) : null,
      baseline: existed ? path.relative(runDirectory, baseline) : null,
    };
  });
  const sourceRecords = validatedSources.map(({ record, selected, name }) => {
    const evidence = path.join(sourceRoot, name);
    fs.writeFileSync(evidence, selected, { flag: 'wx' });
    return { ...record, evidence: path.relative(runDirectory, evidence) };
  });
  writeJsonExclusive(path.join(runDirectory, 'journal.json'), {
    version: 1,
    project_root: root,
    root_stub: request.root_stub,
    closure: request.closure,
    source_records: sourceRecords,
    targets,
  });
  return { status: 'STARTED', run_directory: runDirectory, targets };
}

function loadJournal(runDirectory) {
  const directory = fs.realpathSync(runDirectory);
  const journal = JSON.parse(fs.readFileSync(path.join(directory, 'journal.json'), 'utf8'));
  const projectRoot = fs.realpathSync(journal.project_root);
  const evidenceRoot = path.join(projectRoot, '.formalising', 'model-external') + path.sep;
  if (journal.version !== 1 || projectRoot !== journal.project_root || !directory.startsWith(evidenceRoot)) {
    fail('invalid candidate transaction journal');
  }
  return { directory, journal };
}

function candidatePatch(directory, journal) {
  const output = path.join(directory, 'candidate.patch');
  if (fs.existsSync(output)) return;
  const scratch = fs.mkdtempSync(path.join(directory, 'patch-'));
  try {
    const empty = path.join(scratch, 'absent');
    fs.writeFileSync(empty, '');
    const chunks = [];
    for (const record of journal.targets) {
      const target = projectTarget(journal.project_root, record.path);
      const currentExists = fs.existsSync(target);
      if (!record.existed && !currentExists) continue;
      const before = record.existed ? path.join(directory, record.baseline) : empty;
      const after = currentExists ? target : empty;
      const diff = spawnSync('git', ['diff', '--no-index', '--binary', '--no-ext-diff', '--', before, after], {
        encoding: 'utf8',
      });
      if (![0, 1].includes(diff.status)) fail(`failed to preserve candidate diff for ${record.path}`);
      if (diff.stdout) chunks.push(diff.stdout);
    }
    const temporary = path.join(scratch, 'candidate.patch');
    fs.writeFileSync(temporary, chunks.join('') || '# no candidate changes\n');
    if (!fs.existsSync(output)) fs.renameSync(temporary, output);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export function restoreTransaction(runDirectory) {
  const { directory, journal } = loadJournal(runDirectory);
  const resultFile = path.join(directory, 'result.json');
  const prior = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null;
  if (prior && prior.status !== 'RESTORED') fail('a completed transaction cannot be restored');
  candidatePatch(directory, journal);
  for (const record of journal.targets) {
    const target = projectTarget(journal.project_root, record.path);
    if (record.existed) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (!fs.existsSync(target) || sha256(fs.readFileSync(target)) !== record.sha256) {
        const scratch = fs.mkdtempSync(path.join(path.dirname(target), '.fvs-restore-'));
        try {
          const temporary = path.join(scratch, path.basename(target));
          fs.copyFileSync(path.join(directory, record.baseline), temporary, fs.constants.COPYFILE_EXCL);
          fs.renameSync(temporary, target);
        } finally {
          fs.rmSync(scratch, { recursive: true, force: true });
        }
      }
      if (sha256(fs.readFileSync(target)) !== record.sha256) fail(`failed to restore ${record.path}`);
    } else if (fs.existsSync(target)) {
      fs.rmSync(target);
    }
    if (!record.existed && fs.existsSync(target)) fail(`failed to remove candidate ${record.path}`);
  }
  const result = { status: 'RESTORED', targets: journal.targets.map(record => record.path) };
  if (!prior) writeJsonExclusive(resultFile, result);
  return result;
}

function evidenceFile(directory, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) fail('evidence path must be run-relative');
  return realFile(path.resolve(directory, relative), directory);
}

function validateReview(review, label, directory) {
  if (review?.verdict !== 'PASS' || !Number.isSafeInteger(review.round) ||
      review.round < 1 || review.round > 3) {
    fail(`${label} review must PASS within three rounds`);
  }
  evidenceFile(directory, review.evidence);
}

export function finalizeTransaction(runDirectory, result) {
  const { directory, journal } = loadJournal(runDirectory);
  if (result?.status !== 'COMPLETE') fail('final result status must be COMPLETE');
  validateReview(result.model_review, 'model', directory);
  validateReview(result.specification_review, 'specification', directory);
  const targetNames = new Set(journal.targets.map(record => record.path));
  const modelHashes = result.model_review.approved_sha256;
  if (!modelHashes || typeof modelHashes !== 'object' || Array.isArray(modelHashes)) {
    fail('model review must bind approved target hashes');
  }
  const covered = new Set();
  for (const [relative, approved] of Object.entries(modelHashes)) {
    if (!targetNames.has(relative) || !/^[0-9a-f]{64}$/.test(approved)) {
      fail(`invalid model approval target: ${relative}`);
    }
    const target = projectTarget(journal.project_root, relative);
    if (!fs.existsSync(target) || sha256(fs.readFileSync(target)) !== approved) {
      fail(`model changed after approval: ${relative}`);
    }
    covered.add(relative);
  }
  const spec = result.specification_review;
  if (!Array.isArray(spec.tracked_files) || !/^[0-9a-f]{64}$/.test(spec.approved_surface_sha256 ?? '')) {
    fail('specification review must bind its approved surface and tracked files');
  }
  for (const relative of spec.tracked_files) {
    if (!targetNames.has(relative) || !fs.existsSync(projectTarget(journal.project_root, relative))) {
      fail(`invalid specification approval target: ${relative}`);
    }
    covered.add(relative);
  }
  if (covered.size !== targetNames.size) fail('review approvals do not cover every transaction target');
  for (const [label, expected] of [['proof', 'PASS'], ['build', 'PASS'], ['trust', 'CLEAN']]) {
    if (result[label]?.status !== expected) fail(`${label} gate must report ${expected}`);
    evidenceFile(directory, result[label].evidence);
  }
  for (const field of ['sorries', 'new_axioms', 'uninspectable']) {
    if (!Array.isArray(result.trust[field]) || result.trust[field].length !== 0) {
      fail(`trust gate rejects ${field}`);
    }
  }
  if (!Array.isArray(result.custom_axioms) || result.custom_axioms.some(item =>
    item?.ruling !== 'allow' || typeof item.justification !== 'string' || !item.justification.trim())) {
    fail('every pre-existing custom axiom requires an allow ruling and justification');
  }
  const targetSha256 = Object.fromEntries(journal.targets.map(record => {
    const target = projectTarget(journal.project_root, record.path);
    if (!fs.existsSync(target)) fail(`final target is missing: ${record.path}`);
    return [record.path, sha256(fs.readFileSync(target))];
  }));
  const sealed = { ...result, target_sha256: targetSha256 };
  writeJsonExclusive(path.join(directory, 'result.json'), sealed);
  return { status: 'COMPLETE', result: path.join(directory, 'result.json'), target_sha256: targetSha256 };
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

function cli() {
  const [command, first, second] = process.argv.slice(2);
  if (command === 'resolve' && first) {
    process.stdout.write(`${JSON.stringify(resolveSource(loadJson(first)), null, 2)}\n`);
    return;
  }
  if (command === 'begin' && first) {
    process.stdout.write(`${JSON.stringify(beginTransaction(loadJson(first)), null, 2)}\n`);
    return;
  }
  if (command === 'restore' && first) {
    process.stdout.write(`${JSON.stringify(restoreTransaction(first), null, 2)}\n`);
    return;
  }
  if (command === 'finalize' && first && second) {
    process.stdout.write(`${JSON.stringify(finalizeTransaction(first, loadJson(second)), null, 2)}\n`);
    return;
  }
  process.stderr.write('Usage: fvs-model-external.mjs resolve|begin <request.json> | restore <run-directory> | finalize <run-directory> <result.json>\n');
  process.exitCode = 2;
}

try {
  if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) cli();
} catch (error) {
  process.stderr.write(`FVS >> ${error.message}\n`);
  process.exitCode = 1;
}
