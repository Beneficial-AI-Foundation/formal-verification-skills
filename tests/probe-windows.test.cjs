'use strict';

const { before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { deflateRawSync } = require('node:zlib');

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const executable = Buffer.from('MZ\0test Windows executable bytes');
const defaults = [
  { name: 'README.md', content: Buffer.from('read me') },
  { name: 'probe-aeneas.exe', content: executable },
];

function crc32(bytes) {
  let result = 0xffffffff;
  for (const byte of bytes) {
    result ^= byte;
    for (let bit = 0; bit < 8; bit += 1) result = (result >>> 1) ^ ((result & 1) ? 0xedb88320 : 0);
  }
  return (result ^ 0xffffffff) >>> 0;
}

function archive(entries = defaults) {
  const locals = [], centrals = [], offsets = [];
  let position = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const method = entry.method ?? 8;
    const compressed = Buffer.concat([
      method === 0 ? entry.content : deflateRawSync(entry.content), entry.trailing ?? Buffer.alloc(0),
    ]);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(entry.content), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4); // The official release uses the DOS creator ID.
    local.copy(central, 6, 4, 26);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.attributes ?? 0x81a40000, 38);
    central.writeUInt32LE(position, 42);
    offsets.push({ local: position, central: centrals.reduce((n, part) => n + part.length, 0) });
    centrals.push(central, name);
    position += local.length + name.length + compressed.length;
  }
  const centralData = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralData.length, 12);
  end.writeUInt32LE(position, 16);
  return {
    bytes: Buffer.concat([...locals, centralData, end]),
    offsets: offsets.map((item) => ({ ...item, central: item.central + position })),
    centralStart: position,
  };
}

function manifest(bytes, overrides = {}) {
  return {
    archiveSha256: sha(bytes), members: defaults.map((entry) => entry.name),
    executable: 'probe-aeneas.exe', executableSha256: sha(executable), ...overrides,
  };
}

describe('Windows release ZIP validation (no native execution)', () => {
  let decodeWindowsZip;
  before(async () => ({ decodeWindowsZip } = await import('../scripts/fvs-probe-windows.mjs')));

  it('returns only the pinned executable from deflated and stored archives', () => {
    for (const method of [0, 8]) {
      const { bytes } = archive(defaults.map((entry) => ({ ...entry, method })));
      assert.deepEqual(decodeWindowsZip(bytes, manifest(bytes)), executable);
    }
  });

  it('checks the compressed digest before interpreting ZIP headers', () => {
    const bytes = Buffer.from('not a ZIP');
    assert.throws(() => decodeWindowsZip(bytes, manifest(bytes, { archiveSha256: '0'.repeat(64) })), /archive SHA-256/);
    assert.throws(() => decodeWindowsZip(bytes, manifest(bytes)), /truncated/);
    assert.throws(() => decodeWindowsZip(bytes, { archiveSha256: '' }), /pinned archive SHA-256/);
  });

  it('rejects non-buffers, oversized archives and invalid pinned manifests', () => {
    assert.throws(() => decodeWindowsZip('zip', {}), /Buffer/);
    assert.throws(() => decodeWindowsZip(Buffer.alloc(32 * 1024 * 1024 + 1), {}), /size limit/);
    const { bytes } = archive();
    for (const members of [[], ['../file'], ['con.txt'], ['a', 'A'], ['README.md']]) {
      assert.throws(() => decodeWindowsZip(bytes, manifest(bytes, { members })), /manifest/);
    }
  });

  it('rejects an unexpected, missing or duplicate member', () => {
    for (const entries of [
      [...defaults, { name: 'extra.txt', content: Buffer.from('extra') }],
      defaults.slice(1),
      [defaults[0], defaults[0]],
      [{ ...defaults[0], name: 'readme.md' }, defaults[1]],
    ]) {
      const { bytes } = archive(entries);
      assert.throws(() => decodeWindowsZip(bytes, manifest(bytes)), /member count|duplicate|unexpected/);
    }
  });

  it('rejects traversal, alternate streams, absolute paths, aliases and non-ASCII names', () => {
    for (const name of ['../README.md', '/README.md', 'C:README.md', 'x\\README.md', 'x/README.md',
      'README.md:stream', 'README.md.', 'README.md ', 'NUL', 'COM1.txt', 'réadme.md', 'a\0b']) {
      const { bytes } = archive([{ ...defaults[0], name }, defaults[1]]);
      assert.throws(() => decodeWindowsZip(bytes, manifest(bytes)), /unsafe ZIP member name/);
    }
  });

  it('rejects links, directories, devices and DOS reparse attributes', () => {
    for (const attributes of [0xa1ff0000, 0x41ed0000, 0x21a40000, 0x81a40010, 0x81a40400]) {
      const { bytes } = archive([{ ...defaults[0], attributes }, defaults[1]]);
      assert.throws(() => decodeWindowsZip(bytes, manifest(bytes)), /regular files/);
    }
  });

  it('rejects encryption, descriptors, unknown methods and extra fields', () => {
    for (const [offset, value] of [[8, 1], [8, 8], [8, 0x800], [10, 99], [30, 1], [32, 1], [34, 1]]) {
      const { bytes, offsets } = archive();
      bytes.writeUInt16LE(value, offsets[0].central + offset);
      assert.throws(() => decodeWindowsZip(bytes, manifest(bytes)), /unsupported ZIP/);
    }
  });

  it('rejects ZIP64, multi-disk archives, comments and trailing bytes', () => {
    for (const mutate of [
      (bytes) => bytes.writeUInt16LE(1, bytes.length - 18),
      (bytes) => bytes.writeUInt16LE(1, bytes.length - 16),
      (bytes) => bytes.writeUInt32LE(0xffffffff, bytes.length - 6),
      (bytes) => bytes.writeUInt16LE(1, bytes.length - 2),
    ]) {
      const { bytes } = archive();
      mutate(bytes);
      assert.throws(() => decodeWindowsZip(bytes, manifest(bytes)), /multi-disk|ZIP64|end record/);
    }
    const { bytes, offsets } = archive();
    bytes.writeUInt32LE(0xffffffff, offsets[0].central + 24);
    assert.throws(() => decodeWindowsZip(bytes, manifest(bytes)), /ZIP64/);
    const trailing = Buffer.concat([archive().bytes, Buffer.from('junk')]);
    assert.throws(() => decodeWindowsZip(trailing, manifest(trailing)), /end record/);
  });

  it('rejects mismatched local names, fields and local extra data', () => {
    for (const [offset, value, width] of [[30, 88, 1], [8, 0, 2], [14, 7, 4], [22, 8, 4], [28, 1, 2]]) {
      const { bytes, offsets } = archive();
      bytes.writeUIntLE(value, offsets[0].local + offset, width);
      assert.throws(() => decodeWindowsZip(bytes, manifest(bytes)), /local and central/);
    }
  });

  it('rejects overlapping, reordered, padded and truncated file records', () => {
    for (const [entry, value] of [[0, 1], [1, 0]]) {
      const { bytes, offsets } = archive();
      bytes.writeUInt32LE(value, offsets[entry].central + 42);
      assert.throws(() => decodeWindowsZip(bytes, manifest(bytes)), /contiguous/);
    }
    const { bytes, offsets } = archive();
    bytes.writeUInt32LE(bytes.length, offsets[0].local + 18);
    bytes.writeUInt32LE(bytes.length, offsets[0].central + 20);
    assert.throws(() => decodeWindowsZip(bytes, manifest(bytes)), /truncated|invalid offsets/);
    const badBounds = archive().bytes;
    badBounds.writeUInt32LE(1, badBounds.length - 10);
    assert.throws(() => decodeWindowsZip(badBounds, manifest(badBounds)), /bounds/);
    const original = archive();
    const prefixed = Buffer.concat([Buffer.from('stub'), original.bytes]);
    prefixed.writeUInt32LE(original.centralStart + 4, prefixed.length - 6);
    for (const offset of original.offsets) prefixed.writeUInt32LE(offset.local + 4, offset.central + 4 + 42);
    assert.throws(() => decodeWindowsZip(prefixed, manifest(prefixed)), /contiguous/);
  });

  it('rejects trailing bytes inside a declared deflate stream', () => {
    const { bytes } = archive([{ ...defaults[0], trailing: Buffer.from('junk') }, defaults[1]]);
    assert.throws(() => decodeWindowsZip(bytes, manifest(bytes)), /compressed stream has trailing bytes/);
  });

  it('rejects CRC corruption even when the caller supplies the changed archive digest', () => {
    const { bytes, offsets } = archive(defaults.map((entry) => ({ ...entry, method: 0 })));
    bytes[offsets[0].local + 30 + defaults[0].name.length] ^= 1;
    assert.throws(() => decodeWindowsZip(bytes, manifest(bytes)), /CRC-32 mismatch/);
  });

  it('bounds declared and actual expansion before accepting data', () => {
    for (const size of [256 * 1024 * 1024 + 1, 1]) {
      const { bytes, offsets } = archive();
      bytes.writeUInt32LE(size, offsets[0].local + 22);
      bytes.writeUInt32LE(size, offsets[0].central + 24);
      assert.throws(() => decodeWindowsZip(bytes, manifest(bytes)), /size limit|cannot decompress/);
    }
  });

  it('verifies the extracted executable digest separately', () => {
    const { bytes } = archive();
    assert.throws(() => decodeWindowsZip(bytes, manifest(bytes, { executableSha256: '0'.repeat(64) })), /executable SHA-256/);
  });
});
