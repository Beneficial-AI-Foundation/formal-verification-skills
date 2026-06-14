'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// The forbidden token is built at runtime from fragments so this test file's
// own source does not contain the literal word — otherwise the sweep over
// tests/ would flag this file and fail itself.
const FORBIDDEN = new RegExp('ver' + 'us', 'i');

// Shipped content boundary. Directories are walked
// recursively; README.md is the only loose top-level file in scope.
const SCAN_DIRS = [
  'commands', 'fv-skills', 'agents', 'hooks', 'tests', 'bin', 'scripts',
];
const SCAN_FILES = ['README.md'];

// Path segments excluded from the sweep entirely (CHANGELOG is exempt;
// node_modules/.planning are out-of-scope and must not widen the walk).
const EXCLUDED_SEGMENTS = new Set(['node_modules', '.planning']);
const SCAN_EXTENSIONS = new Set(['.md', '.cjs', '.js']);

function isChangelog(name) {
  // CHANGELOG.md (any case) is sweep-exempt — it documents the removal.
  return /changelog/i.test(name);
}

function walk(absDir, relDir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return; // dir absent (e.g. no hooks/ in a partial checkout) — skip silently
  }
  for (const entry of entries) {
    const name = entry.name;
    if (EXCLUDED_SEGMENTS.has(name)) continue;
    const abs = path.join(absDir, name);
    const rel = relDir ? `${relDir}/${name}` : name;
    if (entry.isDirectory()) {
      walk(abs, rel, acc);
    } else if (entry.isFile()) {
      if (isChangelog(name)) continue;
      if (!SCAN_EXTENSIONS.has(path.extname(name))) continue;
      acc.push({ abs, rel });
    }
  }
}

function collectFiles() {
  const acc = [];
  for (const dir of SCAN_DIRS) {
    walk(path.join(ROOT, dir), dir, acc);
  }
  for (const f of SCAN_FILES) {
    const abs = path.join(ROOT, f);
    if (fs.existsSync(abs) && !isChangelog(f)) acc.push({ abs, rel: f });
  }
  return acc;
}

describe('Forbidden-framework sweep (zero removed-framework hits in shipped content)', () => {
  it('has no forbidden-framework reference across shipped dirs (CHANGELOG-exempt)', () => {
    const offenders = [];
    for (const { abs, rel } of collectFiles()) {
      const lines = fs.readFileSync(abs, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        if (FORBIDDEN.test(line)) {
          offenders.push(`${rel}:${idx + 1}`);
        }
      });
    }
    assert.equal(
      offenders.length,
      0,
      `Forbidden-framework references found (should be zero):\n  ${offenders.join('\n  ')}`
    );
  });
});
