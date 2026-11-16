'use strict';

// Native recipes and patches are hash-sensitive: never apply text/path rewriting
// when copying them into a direct install or a generated plugin.
const fs = require('node:fs');
const path = require('node:path');
const NATIVE_ASSET_DIRECTORY = 'fvs-probe-native';
const SOURCE_EXTENSIONS = new Set(['.cs', '.ps1', '.json', '.patch', '.md', '.txt', '.toml', '.lock', '.lean', '.c', '.h', '.rs', '.go', '.mjs', '.cjs']);

function nativeAssetFiles(scriptsRoot) {
  const root = path.join(path.resolve(scriptsRoot), NATIVE_ASSET_DIRECTORY);
  const files = [];
  function visit(file) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`Unsupported native asset: ${file}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
    } else {
      if (!SOURCE_EXTENSIONS.has(path.extname(file)) && !/^LICENSE(?:[.-]|$)/.test(path.basename(file))) {
        throw new Error(`Native source package contains an unexpected artifact: ${file}`);
      }
      files.push(path.relative(scriptsRoot, file));
    }
  }
  visit(root);
  return files;
}

function safeDestination(root, relative) {
  root = path.resolve(root);
  const destination = path.join(root, relative);
  if (!destination.startsWith(root + path.sep) || relative.split(path.sep)[0] !== NATIVE_ASSET_DIRECTORY) throw new Error('Unsafe native asset destination');
  let current = root;
  for (const part of ['', ...relative.split(path.sep)]) {
    if (part) current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) throw new Error(`Unsafe native asset destination: ${current}`);
    if (current !== destination && !stat.isDirectory()) throw new Error(`Native asset parent is not a directory: ${current}`);
  }
  return destination;
}

function copyNativeAssets(sourceScripts, destinationScripts) {
  const files = nativeAssetFiles(sourceScripts);
  // Validate every destination before replacing any file.
  const planned = files.map(relative => [path.join(sourceScripts, relative), safeDestination(destinationScripts, relative)]);
  for (const [source, destination] of planned) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  return files;
}

function removeNativeAssets(scriptsRoot) {
  const root = path.join(path.resolve(scriptsRoot), NATIVE_ASSET_DIRECTORY);
  if (!fs.lstatSync(root, { throwIfNoEntry: false })) return;
  const files = nativeAssetFiles(scriptsRoot);
  for (const relative of files) safeDestination(scriptsRoot, relative);
  // Only the fixed, checked FVS namespace is recursively removed.
  if (path.dirname(root) !== path.resolve(scriptsRoot) || path.basename(root) !== NATIVE_ASSET_DIRECTORY) throw new Error('Unsafe native asset removal');
  const resolvedScripts = fs.realpathSync(scriptsRoot);
  const resolvedRoot = fs.realpathSync(root);
  if (path.dirname(resolvedRoot) !== resolvedScripts || path.basename(resolvedRoot) !== NATIVE_ASSET_DIRECTORY) throw new Error('Redirected native asset removal');
  fs.rmSync(resolvedRoot, { recursive: true });
}

module.exports = { NATIVE_ASSET_DIRECTORY, nativeAssetFiles, copyNativeAssets, removeNativeAssets };
