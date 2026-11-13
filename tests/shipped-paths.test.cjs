'use strict';
// No shipped file may carry a development machine's absolute paths or a private qualification run id. The shipped
// set is every package.json `files` entry plus the marketplace plugin payload.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FORBIDDEN = [/\/Users\/[A-Za-z0-9._-]+\//, /\/private\/tmp\//, /\/home\/[A-Za-z0-9._-]+\//, /386aca9c-66af-4a02-be70-6afff41a60d5/];

function walk(entry) {
  const full = path.join(ROOT, entry);
  if (!fs.existsSync(full)) return [];
  if (!fs.statSync(full).isDirectory()) return [entry];
  return fs.readdirSync(full).flatMap((name) => walk(path.join(entry, name)));
}

test('no shipped file contains a development machine path or a private run id', () => {
  const shipped = [...new Set([...require('../package.json').files, 'plugins/fvs', 'package.json'].flatMap(walk))];
  assert.ok(shipped.length > 100, 'the shipped set was found');
  const hits = [];
  for (const file of shipped) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const pattern of FORBIDDEN) if (pattern.test(text)) hits.push(`${file}: ${pattern}`);
  }
  assert.deepEqual(hits, []);
});
