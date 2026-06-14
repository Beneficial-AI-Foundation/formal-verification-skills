'use strict';

// Rename-sweep gate: asserts the plan -> fc-plan clean
// break is complete. No shipped file may reference the old command name or the
// old workflow path. The forbidden tokens are assembled at runtime via string
// concatenation so this test file does not itself trip the sweep.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Forbidden tokens, built at runtime to avoid self-matching.
const FORBIDDEN_NAME = '/fvs:' + 'plan';
const FORBIDDEN_NAME_RE = new RegExp(FORBIDDEN_NAME.replace(/[/]/g, '\\/') + '\\b');
const FORBIDDEN_WORKFLOW = 'workflows/' + 'plan.md';

// Shipped scope: named dirs + README.md, bounded (no fan-out to disk).
const SCAN_DIRS = ['commands', 'fv-skills', 'agents', 'tests'];
const SCAN_FILES = ['README.md'];
const SCAN_EXT = new Set(['.md', '.cjs', '.js']);
const EXCLUDE_DIRS = new Set(['node_modules', '.planning']);

function collectFiles(absDir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      collectFiles(path.join(absDir, entry.name), acc);
    } else if (entry.isFile() && SCAN_EXT.has(path.extname(entry.name))) {
      acc.push(path.join(absDir, entry.name));
    }
  }
  return acc;
}

const targets = [];
for (const dir of SCAN_DIRS) {
  collectFiles(path.join(ROOT, dir), targets);
}
for (const file of SCAN_FILES) {
  const abs = path.join(ROOT, file);
  if (fs.existsSync(abs)) targets.push(abs);
}

describe('Rename sweep (plan -> fc-plan)', () => {
  it('no shipped file references the old command name', () => {
    const offenders = [];
    for (const file of targets) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (FORBIDDEN_NAME_RE.test(line)) {
          offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
        }
      });
    }
    assert.deepStrictEqual(offenders, [],
      `Stale command-name references found: ${offenders.join(', ')}`);
  });

  it('no shipped file references the old workflow path', () => {
    const offenders = [];
    for (const file of targets) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (line.includes(FORBIDDEN_WORKFLOW)) {
          offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
        }
      });
    }
    assert.deepStrictEqual(offenders, [],
      `Stale workflow-path references found: ${offenders.join(', ')}`);
  });
});
