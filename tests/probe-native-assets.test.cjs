'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { nativeAssetFiles, copyNativeAssets, removeNativeAssets } = require('../scripts/fvs-probe-assets.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-native-assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  fs.mkdirSync(path.join(source, 'fvs-probe-native', 'windows'), { recursive: true });
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(source, 'fvs-probe-native', 'windows', 'source.cs'), 'source with exact bytes  \r\n');
  return { root, source, destination };
}

test('native assets preserve exact recipe bytes and unrelated installed files', t => {
  const { source, destination } = fixture(t);
  fs.writeFileSync(path.join(destination, 'unrelated.txt'), 'keep');
  const files = copyNativeAssets(source, destination);
  assert.equal(files.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(destination, files[0])), fs.readFileSync(path.join(source, files[0])));
  removeNativeAssets(destination);
  assert.deepEqual(fs.readdirSync(destination), ['unrelated.txt']);
  assert.equal(fs.readFileSync(path.join(destination, 'unrelated.txt'), 'utf8'), 'keep');
});

test('binaries in the source namespace fail before any destination copy', t => {
  const { source, destination } = fixture(t);
  fs.writeFileSync(path.join(source, 'fvs-probe-native', 'windows', 'unexpected.exe'), 'not a source artifact');
  assert.throws(() => nativeAssetFiles(source), /unexpected artifact/);
  assert.throws(() => copyNativeAssets(source, destination), /unexpected artifact/);
  assert.deepEqual(fs.readdirSync(destination), []);
});

test('a redirected native namespace preserves outside content on install and uninstall', t => {
  const { root, source, destination } = fixture(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'outside');
  fs.symlinkSync(outside, path.join(destination, 'fvs-probe-native'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => copyNativeAssets(source, destination), /Unsafe native asset destination/);
  assert.throws(() => removeNativeAssets(destination), /Unsupported native asset/);
  assert.deepEqual(fs.readdirSync(outside), ['sentinel.txt']);
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'outside');
});

test('a hardlinked destination is rejected before earlier assets are overwritten', t => {
  const { root, source, destination } = fixture(t);
  const sourceDir = path.join(source, 'fvs-probe-native', 'windows');
  const destinationDir = path.join(destination, 'fvs-probe-native', 'windows');
  fs.mkdirSync(destinationDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'a.cs'), 'new');
  fs.writeFileSync(path.join(destinationDir, 'a.cs'), 'existing');
  const sentinel = path.join(root, 'sentinel');
  fs.writeFileSync(sentinel, 'outside');
  fs.linkSync(sentinel, path.join(destinationDir, 'source.cs'));
  assert.throws(() => copyNativeAssets(source, destination), /Unsafe native asset destination/);
  assert.equal(fs.readFileSync(path.join(destinationDir, 'a.cs'), 'utf8'), 'existing');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside');
});
