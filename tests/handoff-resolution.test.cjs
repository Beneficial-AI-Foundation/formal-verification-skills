'use strict';

// Pins the /fvs:pause-work handoff resolution rule, the parallel-handoff
// non-clobber behavior, and the /fvs:resume-work discovery union.
//
// The resolution logic lives in markdown (executed by the LLM at runtime),
// so we encode the documented rule as a small pure resolver here and assert
// its truth table, then simulate the filesystem behaviors on a temp dir.
// Zero external deps: node:test + node:assert/strict + node:fs only.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_HANDOFF = '.formalising/fv-plans/.continue-here.md';

// ---------------------------------------------------------------------------
// Pure resolver encoding the documented rule:
//   - first token is a destination ONLY if it contains "/" or ends in ".md"
//   - no path-like first token       -> default path, whole string is the note
//   - first token ends in ".md"      -> that exact path
//   - first token otherwise path-like -> <token>/.continue-here.md
//   - remaining text after a path token is the user note
// ---------------------------------------------------------------------------
function isPathLike(token) {
  return token.includes('/') || token.endsWith('.md');
}

function resolveHandoff(args) {
  const trimmed = (args || '').trim();
  if (trimmed === '') {
    return { handoffFile: DEFAULT_HANDOFF, note: '' };
  }
  const spaceIdx = trimmed.indexOf(' ');
  const firstToken = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  if (!isPathLike(firstToken)) {
    // Whole argument string is the note; a one-word note is never a directory.
    return { handoffFile: DEFAULT_HANDOFF, note: trimmed };
  }
  if (firstToken.endsWith('.md')) {
    return { handoffFile: firstToken, note: rest };
  }
  // Otherwise path-like (contains "/"): treat as a directory.
  return { handoffFile: `${firstToken}/.continue-here.md`, note: rest };
}

// ---------------------------------------------------------------------------
// Discovery union mirroring resume-work Step 1:
//   1. recursive glob of .continue-here.md files
//   2. recursive content scan for the ^fvs_handoff: true marker
//   union + dedupe (a .continue-here.md carrying the marker counts once).
// ---------------------------------------------------------------------------
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function discoverHandoffs(root) {
  const all = fs.existsSync(root) ? walk(root) : [];
  const found = new Set();
  for (const file of all) {
    if (path.basename(file) === '.continue-here.md') {
      found.add(file);
      continue;
    }
    const raw = fs.readFileSync(file, 'utf8');
    if (/^fvs_handoff: true$/m.test(raw)) found.add(file);
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// Temp-dir harness (copied from install.test.cjs — tests are independent).
// ---------------------------------------------------------------------------
const tempDirs = [];
function makeTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

const MARKER_FRONTMATTER = [
  '---',
  'fvs_handoff: true',
  'target: spec.lean',
  'last_updated: 2026-06-12T00:00:00Z',
  'status: in_progress',
  '---',
  '',
  '# Verification Handoff',
  '',
].join('\n');

// ---------------------------------------------------------------------------

describe('handoff resolution rule (truth table)', () => {
  it('bare invocation -> legacy default path, empty note', () => {
    assert.deepEqual(resolveHandoff(''), {
      handoffFile: DEFAULT_HANDOFF,
      note: '',
    });
  });

  it('one-word note (no / and no .md) -> default path, whole string is the note', () => {
    assert.deepEqual(resolveHandoff('stuck on mul'), {
      handoffFile: DEFAULT_HANDOFF,
      note: 'stuck on mul',
    });
  });

  it('directory token (contains /) -> <token>/.continue-here.md', () => {
    assert.deepEqual(resolveHandoff('.formalising/fv-plans/CKA-from-KEM'), {
      handoffFile: '.formalising/fv-plans/CKA-from-KEM/.continue-here.md',
      note: '',
    });
  });

  it('.md token -> that exact path', () => {
    assert.deepEqual(resolveHandoff('.formalising/fv-plans/CKA/security-handoff.md'), {
      handoffFile: '.formalising/fv-plans/CKA/security-handoff.md',
      note: '',
    });
  });

  it('directory token + note -> <token>/.continue-here.md with remaining text as note', () => {
    assert.deepEqual(resolveHandoff('.formalising/fv-plans/topicB extra note here'), {
      handoffFile: '.formalising/fv-plans/topicB/.continue-here.md',
      note: 'extra note here',
    });
  });
});

describe('parallel handoffs do not clobber', () => {
  it('two distinct topic destinations produce two coexisting files', () => {
    const tmp = makeTmpDir('fvs-handoff-noclobber-');

    const topicA = resolveHandoff('.formalising/fv-plans/topicA').handoffFile;
    const topicB = resolveHandoff('.formalising/fv-plans/topicB').handoffFile;
    assert.notEqual(topicA, topicB, 'distinct topics must resolve to distinct paths');

    for (const rel of [topicA, topicB]) {
      const abs = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, MARKER_FRONTMATTER);
    }

    // Writing the second did not overwrite the first — both exist.
    assert.ok(fs.existsSync(path.join(tmp, topicA)), 'topicA handoff missing');
    assert.ok(fs.existsSync(path.join(tmp, topicB)), 'topicB handoff missing');
  });
});

describe('discovery union (glob + marker scan, deduped)', () => {
  it('finds default, per-topic, and custom-named handoffs exactly once each', () => {
    const tmp = makeTmpDir('fvs-handoff-discover-');
    const root = path.join(tmp, '.formalising', 'fv-plans');

    // 1. legacy default .continue-here.md (also carries the marker -> must dedupe)
    const f1 = path.join(root, '.continue-here.md');
    // 2. per-topic default .continue-here.md
    const f2 = path.join(root, 'CKA-from-KEM', '.continue-here.md');
    // 3. custom-named handoff discoverable ONLY via the marker
    const f3 = path.join(root, 'security', 'security-handoff.md');

    for (const f of [f1, f2, f3]) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, MARKER_FRONTMATTER);
    }

    const found = discoverHandoffs(root);
    assert.equal(found.length, 3, `expected 3 deduped handoffs, got ${found.length}`);
    assert.ok(found.includes(f1), 'default handoff not discovered');
    assert.ok(found.includes(f2), 'per-topic handoff not discovered');
    assert.ok(found.includes(f3), 'custom-named handoff not discovered via marker');
  });
});
