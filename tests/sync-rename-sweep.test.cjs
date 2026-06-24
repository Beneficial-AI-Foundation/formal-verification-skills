'use strict';

// Rename-sweep gate: asserts the sync-aeneas -> sync-aeneas-verif clean
// break is complete. No shipped file may reference the old command name --
// either the prefixed /fvs: form OR the bare token -- or the old workflow path.
// The trailing (?![-\w]) guard keeps the new name (...-verif) from being a false
// positive. This test file is self-exempt (it names the old token in its own
// machinery and comments); CHANGELOG.md is exempt too -- it documents the supersession.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Forbidden tokens, built at runtime to avoid self-matching. The word-boundary
// after the command name ensures the new name (...-verif) is NOT flagged: the
// regex requires the old name to be followed by a non-word, non-hyphen
// boundary, so "/fvs:sync-aeneas-verif" does not match the bare old name.
const OLD_NAME = 'sync-' + 'aeneas';
const FORBIDDEN_NAME = '/fvs:' + OLD_NAME;
const FORBIDDEN_NAME_RE = new RegExp(
  FORBIDDEN_NAME.replace(/[/]/g, '\\/') + '(?![-\\w])'
);
const FORBIDDEN_WORKFLOW = 'workflows/' + OLD_NAME + '.md';
// Bare old-name detection (no /fvs: prefix): catches stale mentions in
// requires:[] frontmatter, prose, or workflow text. The (?![-\\w]) guard keeps
// the new name (...-verif) from being a false positive.
const FORBIDDEN_BARE_RE = new RegExp('\\b' + OLD_NAME + '\\b(?![-\\w])');

// Shipped scope: named dirs + README.md, bounded (no fan-out to disk).
const SCAN_DIRS = ['commands', 'fv-skills', 'agents', 'tests', 'bin'];
const SCAN_FILES = ['README.md'];
const SCAN_EXT = new Set(['.md', '.cjs', '.js']);
const EXCLUDE_DIRS = new Set(['node_modules', '.planning']);
// This sweep necessarily names the old token in its comments + describe label;
// exempt its own file so the bare-token check does not self-trip.
const SELF = path.basename(__filename);

function isChangelog(name) {
  // CHANGELOG.md (any case) is sweep-exempt -- it documents the supersession.
  return /changelog/i.test(name);
}

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
      if (isChangelog(entry.name)) continue;
      if (entry.name === SELF) continue;
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
  if (fs.existsSync(abs) && !isChangelog(file)) targets.push(abs);
}

describe('Rename sweep (sync-aeneas -> sync-aeneas-verif)', () => {
  it('no shipped file references the old command name', () => {
    const offenders = [];
    for (const file of targets) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (FORBIDDEN_NAME_RE.test(line) || FORBIDDEN_BARE_RE.test(line)) {
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
