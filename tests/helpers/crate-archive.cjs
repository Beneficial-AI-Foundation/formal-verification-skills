'use strict';

// A minimal ustar writer, enough to build the .crate archives (gzip-compressed tar) that the
// registry-source tests need, and to damage them in the ways the engine's reader has to refuse.

const zlib = require('node:zlib');

const BLOCK = 512;

function header({ name, prefix = '', size = 0, type = '0', link = '' }) {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644\0', 100, 'latin1');
  block.write('0000000\0', 108, 'latin1');
  block.write('0000000\0', 116, 'latin1');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  block.write('00000000000\0', 136, 'latin1');
  block.write('        ', 148, 'latin1');
  block.write(type, 156, 'latin1');
  block.write(link, 157, 100, 'utf8');
  block.write('ustar\0', 257, 'latin1');
  block.write('00', 263, 'latin1');
  block.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return block;
}

// A path longer than the 100-byte name field is split at a slash into ustar prefix and name.
function split(name) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: '' };
  for (let at = name.indexOf('/'); at !== -1; at = name.indexOf('/', at + 1)) {
    const prefix = name.slice(0, at);
    const rest = name.slice(at + 1);
    if (Buffer.byteLength(rest) <= 100 && Buffer.byteLength(prefix) <= 155) return { name: rest, prefix };
  }
  throw new Error(`the path ${name} does not fit a ustar header`);
}

// entries: { name, data?, type?, link? } with type '0' (file), '5' (directory), '2' (symbolic link)
// or any other flag. end: false leaves out the end marker.
function tar(entries, { end = true } = {}) {
  const parts = [];
  for (const entry of entries) {
    const data = entry.data === undefined ? Buffer.alloc(0) : Buffer.from(entry.data);
    parts.push(header({ ...split(entry.name), size: data.length, type: entry.type ?? '0', link: entry.link ?? '' }));
    parts.push(data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK));
  }
  if (end) parts.push(Buffer.alloc(2 * BLOCK));
  return Buffer.concat(parts);
}

const crateArchive = (entries, options) => zlib.gzipSync(tar(entries, options));

module.exports = { tar, crateArchive, BLOCK };
