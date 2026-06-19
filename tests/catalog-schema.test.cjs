'use strict';

// Schema-discipline gate for the Aeneas extraction blocker catalog.
//
// The catalog is the classifier's lookup store and the applier's recipe source.
// Two anti-hallucination guarantees are structural, not advisory, and this test
// enforces them so a future edit that weakens them fails the suite:
//
//   1. Every seed entry carries a non-empty `evidence` field — a real doc path,
//      issue/PR number, commit, or test output. An entry with empty `evidence`
//      is malformed: it would let a classifier fabricate a match with no backing.
//   2. Every seed entry carries a `pin_context` — the revision the blocker or
//      fix was observed against, so "fixed in upstream main" is never silently
//      read as "fixed for us".
//   3. No entry carries a `tier` key — the tier field was removed; a change's
//      handling is carried by `category` + `coverage_impact` + `recipe`.
//   4. `outcome_kinds`, where present, is a list.
//
// Pure node:test + node:assert/strict, zero npm dependencies. The catalog seed
// is one flat YAML list of `- id:` blocks with flat `key: value` lines, so a
// minimal hand-rolled line parser is sufficient (no js-yaml on the box).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CATALOG = path.join(ROOT, 'fv-skills', 'references', 'blocker-catalog.md');

// ---------------------------------------------------------------------------
// Extract the YAML seed region and parse its `- id:` entries.
//
// The seed is the single fenced ```yaml block that lives inside the <seed>
// section and contains the list entries (each starting with `- id:`). The
// provenance section also has a ```yaml block (the pin snapshot), so we select
// the one whose body contains `- id:` lines.
// ---------------------------------------------------------------------------
function extractSeedEntries() {
  const raw = fs.readFileSync(CATALOG, 'utf8');
  const lines = raw.split('\n');

  // Collect the body of the yaml fence that holds the `- id:` list.
  let inFence = false;
  let fenceLang = '';
  let buffer = [];
  let seedBody = null;

  for (const line of lines) {
    const fenceMatch = line.match(/^```(\w*)\s*$/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceLang = fenceMatch[1];
        buffer = [];
      } else {
        // closing fence
        if (fenceLang === 'yaml' && buffer.some(l => /^-\s+id:/.test(l))) {
          seedBody = buffer.join('\n');
        }
        inFence = false;
        fenceLang = '';
      }
      continue;
    }
    if (inFence) buffer.push(line);
  }

  // The seed may live outside a fence (one plain YAML region, per the
  // catalog's "one YAML list" convention). Fall back to scanning the whole
  // file for `- id:` blocks if no yaml fence held them.
  const source = seedBody !== null ? seedBody.split('\n') : lines;

  const entries = [];
  let current = null;
  for (const line of source) {
    const idMatch = line.match(/^-\s+id:\s*(.+?)\s*$/);
    if (idMatch) {
      if (current) entries.push(current);
      current = { id: idMatch[1], _fields: {} };
      continue;
    }
    if (!current) continue;
    // A continuation line of the current entry: `  key: value`.
    const kv = line.match(/^\s+([A-Za-z_][\w]*):\s?(.*)$/);
    if (kv) {
      current._fields[kv[1]] = kv[2].trim();
    } else if (/^\S/.test(line) && line.trim() !== '') {
      // A non-indented, non-list line ends the seed region.
      entries.push(current);
      current = null;
      break;
    }
  }
  if (current) entries.push(current);

  return entries;
}

describe('blocker catalog schema discipline', () => {
  const entries = extractSeedEntries();

  it('parses at least one seed entry', () => {
    assert.ok(entries.length >= 1, 'expected >=1 catalog seed entry to parse');
  });

  it('every entry has a non-empty evidence field (anti-hallucination)', () => {
    for (const e of entries) {
      const evidence = e._fields.evidence;
      assert.ok(
        typeof evidence === 'string' && evidence.length > 0,
        `entry ${e.id} has a missing/empty evidence field`,
      );
    }
  });

  it('every entry has a pin_context field', () => {
    for (const e of entries) {
      const pin = e._fields.pin_context;
      assert.ok(
        typeof pin === 'string' && pin.length > 0,
        `entry ${e.id} has a missing/empty pin_context field`,
      );
    }
  });

  it('no entry carries a tier key (tier was removed)', () => {
    for (const e of entries) {
      assert.ok(
        !Object.prototype.hasOwnProperty.call(e._fields, 'tier'),
        `entry ${e.id} reintroduces the removed tier field`,
      );
    }
  });

  it('outcome_kinds, where present, is a list', () => {
    for (const e of entries) {
      if (!Object.prototype.hasOwnProperty.call(e._fields, 'outcome_kinds')) continue;
      const val = e._fields.outcome_kinds;
      assert.match(
        val,
        /^\[.*\]$/,
        `entry ${e.id} outcome_kinds is not a list: ${JSON.stringify(val)}`,
      );
    }
  });
});
