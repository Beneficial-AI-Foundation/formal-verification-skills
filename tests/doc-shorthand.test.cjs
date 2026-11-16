'use strict';

// Shipped docs must read on their own. A word glued to a small number ("the17",
// "concrete19", "Store12") is a private issue-tracker reference that a user cannot
// resolve, so the docs explain the component in words instead.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SOURCES = ['commands', 'fv-skills', 'agents', 'README.md', 'CHANGELOG.md'];

// Real tokens that happen to have this shape: a Node major version and a process niceness.
const ALLOWED = new Set(['node20', 'nice19']);

// A word glued to 10-22, such as "the17" or "serial15".
const WORD_NUMBER = /\b(?:[A-Za-z]{2,}|a)(?:1[0-9]|2[0-2])\b/g;
// A number glued after punctuation with no space, such as "head.16 phase" or "post-Git/14/15".
const PUNCTUATION_NUMBER = /[A-Za-z)`][.,;:/](?:1[0-9]|2[0-2])(?![0-9.%A-Za-z])/g;

function walk(entry) {
  const full = path.join(ROOT, entry);
  if (!fs.existsSync(full)) return [];
  if (!fs.statSync(full).isDirectory()) return [entry];
  return fs.readdirSync(full).flatMap((name) => {
    // Vendored upstream material is not ours to reword.
    if (name === 'upstream') return [];
    return walk(path.join(entry, name));
  });
}

test('shipped markdown carries no glued issue-number shorthand', () => {
  const files = SOURCES.flatMap(walk).filter((file) => file.endsWith('.md'));
  assert.ok(files.length > 50, 'the shipped markdown was found');
  const hits = [];
  for (const file of files) {
    fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').forEach((line, index) => {
      for (const match of line.matchAll(WORD_NUMBER)) if (!ALLOWED.has(match[0])) hits.push(`${file}:${index + 1}: ${match[0]}`);
      for (const match of line.matchAll(PUNCTUATION_NUMBER)) hits.push(`${file}:${index + 1}: ${match[0]}`);
    });
  }
  assert.deepEqual(hits, []);
});
