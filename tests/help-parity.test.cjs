'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Parse frontmatter name: field from a command file
// ---------------------------------------------------------------------------
function parseName(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n');
  for (const line of lines) {
    const m = line.match(/^name:\s*(.+)/);
    if (m) return m[1].trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Collect all /fvs:* names from text
// ---------------------------------------------------------------------------
function extractFvsNames(text) {
  const matches = text.match(/\/fvs:\S+/g) || [];
  // Clean trailing markdown/punctuation: backticks, bold **, commas, periods, parens
  const cleaned = matches.map(m => m.replace(/[`*,.)]+$/g, ''));
  // Extract just the /fvs:name part (stop at space, angle bracket, or end)
  const names = cleaned.map(m => {
    const core = m.match(/^\/fvs:[a-z-]+/);
    return core ? core[0] : m;
  });
  return [...new Set(names)];
}

// ---------------------------------------------------------------------------
// Build authoritative command name set from files
// ---------------------------------------------------------------------------
const cmdDir = path.join(ROOT, 'commands', 'fvs');
const cmdFiles = fs.readdirSync(cmdDir).filter(f => f.endsWith('.md'));
const authoritativeNames = new Set();
for (const file of cmdFiles) {
  const name = parseName(path.join(cmdDir, file));
  if (name) authoritativeNames.add(`/fvs:${name.replace(/^fvs:/, '')}`);
}

// Session commands that may only appear in help, not README
const SESSION_COMMANDS = new Set(['/fvs:checkpoint', '/fvs:pause-work', '/fvs:resume-work']);

const helpBody = fs.readFileSync(path.join(ROOT, 'commands', 'fvs', 'help.md'), 'utf8');
const readmeBody = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

const helpNames = new Set(extractFvsNames(helpBody));
const readmeNames = new Set(extractFvsNames(readmeBody));

describe('Help and README parity', () => {

  it('every non-session command appears in help.md', () => {
    const missing = [];
    for (const name of authoritativeNames) {
      // Session commands are internal and not documented in help.md
      if (SESSION_COMMANDS.has(name)) continue;
      if (!helpNames.has(name)) {
        missing.push(name);
      }
    }
    assert.deepStrictEqual(missing, [],
      `Commands missing from help.md: ${missing.join(', ')}`);
  });

  it('every non-session command appears in README.md', () => {
    const missing = [];
    for (const name of authoritativeNames) {
      if (SESSION_COMMANDS.has(name)) continue;
      if (!readmeNames.has(name)) {
        missing.push(name);
      }
    }
    assert.deepStrictEqual(missing, [],
      `Non-session commands missing from README.md: ${missing.join(', ')}`);
  });

  it('help.md does not list phantom /fvs:* commands', () => {
    const phantom = [];
    for (const name of helpNames) {
      if (!authoritativeNames.has(name)) {
        phantom.push(name);
      }
    }
    assert.deepStrictEqual(phantom, [],
      `Phantom commands in help.md (no matching file): ${phantom.join(', ')}`);
  });

  it('README.md does not list phantom /fvs:* commands', () => {
    const phantom = [];
    for (const name of readmeNames) {
      if (!authoritativeNames.has(name)) {
        phantom.push(name);
      }
    }
    assert.deepStrictEqual(phantom, [],
      `Phantom commands in README.md (no matching file): ${phantom.join(', ')}`);
  });
});
