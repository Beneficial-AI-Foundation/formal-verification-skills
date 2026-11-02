// Validation of the pinned Windows release archive. This does not provide
// Windows confinement or enable a verified Windows platform.
import crypto from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const MAX_ARCHIVE = 32 * 1024 * 1024;
const MAX_CONTENT = 256 * 1024 * 1024;
const HEX_SHA256 = /^[0-9a-f]{64}$/;

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// The official Windows asset contains only ASCII-named files at its root.
// Reject every other layout, including Windows path aliases and device names.
function safeName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name)
    && !name.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
}

// A deliberately narrow ZIP reader: single disk, flat regular files, no extra
// fields, comments, encryption, descriptors or ZIP64. It validates both copies
// of each header, every member and every byte range; nothing is unpacked to disk.
export function decodeWindowsZip(bytes, asset) {
  if (!Buffer.isBuffer(bytes)) fail('archive must be a Buffer');
  if (bytes.length > MAX_ARCHIVE) fail('archive is larger than the size limit');
  if (!HEX_SHA256.test(asset?.archiveSha256 ?? '')) fail('a pinned archive SHA-256 is required');
  if (sha256(bytes) !== asset.archiveSha256) fail('archive SHA-256 does not match the pinned official digest');
  if (!Array.isArray(asset.members) || asset.members.length === 0 || !asset.members.every(safeName)
    || new Set(asset.members.map((name) => name.toLowerCase())).size !== asset.members.length
    || !asset.members.includes(asset.executable) || !HEX_SHA256.test(asset.executableSha256 ?? '')) {
    fail('invalid pinned Windows archive manifest');
  }
  const within = (offset, length, limit = bytes.length) => {
    if (offset < 0 || length < 0 || offset + length > limit) fail('ZIP archive is truncated or has invalid offsets');
  };
  const end = bytes.length - 22;
  within(end, 22);
  if (bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 20) !== 0) {
    fail('ZIP archive must have an uncommented end record with no trailing bytes');
  }
  const entries = bytes.readUInt16LE(end + 10);
  const centralSize = bytes.readUInt32LE(end + 12);
  const centralStart = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0
    || bytes.readUInt16LE(end + 8) !== entries) fail('multi-disk ZIP archives are unsupported');
  if (entries === 0xffff || centralSize === 0xffffffff || centralStart === 0xffffffff) {
    fail('ZIP64 archives are unsupported');
  }
  if (entries !== asset.members.length) fail('ZIP member count does not match the pinned manifest');
  if (centralStart + centralSize !== end) fail('ZIP central directory has invalid bounds');

  let central = centralStart;
  let nextLocal = 0;
  let totalContent = 0;
  let executableBytes = null;
  const seen = new Set();
  for (let index = 0; index < entries; index += 1) {
    within(central, 46, end);
    if (bytes.readUInt32LE(central) !== 0x02014b50) fail('invalid ZIP central header');
    const creator = bytes.readUInt16LE(central + 4) >>> 8;
    const version = bytes.readUInt16LE(central + 6);
    const flags = bytes.readUInt16LE(central + 8);
    const method = bytes.readUInt16LE(central + 10);
    const crc = bytes.readUInt32LE(central + 16);
    const compressedSize = bytes.readUInt32LE(central + 20);
    const size = bytes.readUInt32LE(central + 24);
    const nameLength = bytes.readUInt16LE(central + 28);
    const extraLength = bytes.readUInt16LE(central + 30);
    const commentLength = bytes.readUInt16LE(central + 32);
    const attributes = bytes.readUInt32LE(central + 38);
    const local = bytes.readUInt32LE(central + 42);
    if (size === 0xffffffff || compressedSize === 0xffffffff || local === 0xffffffff) {
      fail('ZIP64 archives are unsupported');
    }
    if (![0, 3].includes(creator) || ![10, 20].includes(version) || flags !== 0
      || ![0, 8].includes(method) || extraLength !== 0 || commentLength !== 0
      || bytes.readUInt16LE(central + 34) !== 0) {
      fail('unsupported ZIP header, compression, flags or extra fields');
    }
    const mode = attributes >>> 16;
    if ((mode !== 0 && (mode & 0o170000) !== 0o100000) || (attributes & 0xffff & ~0x21) !== 0) {
      fail('ZIP members must be regular files, not links, directories or devices');
    }
    within(central + 46, nameLength, end);
    const nameBytes = bytes.subarray(central + 46, central + 46 + nameLength);
    const name = nameBytes.toString('utf8');
    if (!safeName(name)) fail(`unsafe ZIP member name: ${JSON.stringify(name)}`);
    if (seen.has(name.toLowerCase())) fail(`duplicate ZIP member: ${name}`);
    if (!asset.members.includes(name)) fail(`unexpected ZIP member: ${name}`);
    seen.add(name.toLowerCase());
    totalContent += size;
    if (totalContent > MAX_CONTENT) fail('ZIP content exceeds the size limit');

    // Requiring the same order and contiguous local records excludes leading
    // payloads, hidden members, overlapping files and unaccounted-for padding.
    if (local !== nextLocal) fail('ZIP local records are not contiguous and ordered');
    within(local, 30, centralStart);
    if (bytes.readUInt32LE(local) !== 0x04034b50
      || !bytes.subarray(local + 4, local + 26).equals(bytes.subarray(central + 6, central + 28))
      || bytes.readUInt16LE(local + 26) !== nameLength || bytes.readUInt16LE(local + 28) !== 0) {
      fail('ZIP local and central headers disagree');
    }
    within(local + 30, nameLength, centralStart);
    if (!bytes.subarray(local + 30, local + 30 + nameLength).equals(nameBytes)) {
      fail('ZIP local and central names disagree');
    }
    const start = local + 30 + nameLength;
    within(start, compressedSize, centralStart);
    const compressed = bytes.subarray(start, start + compressedSize);
    let content;
    if (method === 0) {
      content = compressed;
    } else {
      try {
        const inflated = inflateRawSync(compressed, { maxOutputLength: Math.max(size, 1), info: true });
        if (inflated.engine.bytesWritten !== compressedSize) fail('ZIP compressed stream has trailing bytes');
        content = inflated.buffer;
      } catch (error) {
        fail(`cannot decompress ZIP member ${name}: ${error.message}`);
      }
    }
    if (content.length !== size || crc32(content) !== crc) fail(`ZIP member size or CRC-32 mismatch: ${name}`);
    if (name === asset.executable) executableBytes = Buffer.from(content);
    nextLocal = start + compressedSize;
    central += 46 + nameLength;
  }
  if (central !== end || nextLocal !== centralStart) fail('ZIP archive has unaccounted-for bytes');
  if (!executableBytes || sha256(executableBytes) !== asset.executableSha256) {
    fail('executable SHA-256 does not match the pinned digest');
  }
  return executableBytes;
}
