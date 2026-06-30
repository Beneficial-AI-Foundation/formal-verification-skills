'use strict';

// Static gate: no @-ref inside any Task( ... ) prompt block.
//
// @-references (e.g. @~/.claude/..., @fv-skills/...) auto-load only when they
// sit at the top of a command body (an <execution_context> block). They do NOT
// cross a Task() dispatch boundary: a subagent prompt must inline reference
// content (cat the file into a $VAR, embed it in an XML tag), never leave a bare
// @-ref inside the prompt="..." string -- such a ref silently fails to load in
// the subagent.
//
// The legitimacy distinction is POSITIONAL (inside a Task() block vs. in the
// top-of-body execution_context), not lexical -- so this sweep flags the same
// @-ref shapes FVS uses, but only when they appear inside a Task() block.
//
// The forbidden token is assembled at runtime from fragments and tests/ is kept
// out of SCAN_DIRS, so this test file's own source never trips its own gate
// (the established forbidden-framework / rename sweep self-match-avoidance pattern).
//
// Pure node:test + node:assert/strict, zero npm dependencies.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Task() dispatches live only in these three dirs. tests/ is deliberately
// excluded (this file contains Task( and @-like strings in comments/regex; a
// scan of tests/ would flag itself).
const SCAN_DIRS = ['commands/fvs', 'agents', 'fv-skills/workflows'];
const SCAN_EXTENSIONS = new Set(['.md']);

// Out-of-scope path segments must never widen the walk.
const EXCLUDED_SEGMENTS = new Set(['node_modules', '.planning']);

// The forbidden @-ref shapes, built at runtime so the literal token never
// appears in this file's own source. Matches the FVS ref forms:
//   @~/.claude/..., @$HOME/.claude/..., @.claude/..., @fv-skills/...,
//   and a bare @~/ or @/ path-ref.
const AT = '@';
const FORBIDDEN = new RegExp(
  AT + '(?:~\\/\\.claude|\\$HOME\\/\\.claude|\\.claude|fv-skills|~\\/|\\/)[A-Za-z0-9._\\/-]*'
);

function walk(absDir, relDir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return; // dir absent in a partial checkout -- skip silently
  }
  for (const entry of entries) {
    const name = entry.name;
    if (EXCLUDED_SEGMENTS.has(name)) continue;
    const abs = path.join(absDir, name);
    const rel = relDir ? `${relDir}/${name}` : name;
    if (entry.isDirectory()) {
      walk(abs, rel, acc);
    } else if (entry.isFile()) {
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
  return acc;
}

// Locate every Task( in `text`; for each, scan forward tracking paren depth
// (increment on '(', decrement on ')') until depth returns to 0. That span is
// one Task() block. Return an array of { start, end } character offsets. If a
// Task( never closes before EOF, throw loudly rather than scan to EOF (a
// truncated/malformed file must fail the gate, not be silently skipped).
function taskBlocks(text, rel) {
  const blocks = [];
  const OPEN = 'Task(';
  let searchFrom = 0;
  while (true) {
    const taskAt = text.indexOf(OPEN, searchFrom);
    if (taskAt === -1) break;
    // Start depth-tracking at the '(' that follows 'Task'.
    let i = taskAt + OPEN.length - 1; // index of the '(' in 'Task('
    let depth = 0;
    let closed = false;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          blocks.push({ start: taskAt, end: i });
          closed = true;
          break;
        }
      }
    }
    if (!closed) {
      assert.fail(
        `${rel}: a Task( block at offset ${taskAt} never closes before EOF ` +
        '(truncated or malformed file)'
      );
    }
    searchFrom = i + 1;
  }
  return blocks;
}

// Map a character offset to a 1-based line number for offender reporting.
function lineOf(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') line++;
  }
  return line;
}

describe('Task-prompt @-ref sweep (zero @-refs inside any Task() block)', () => {
  it('has no @-ref inside any Task() prompt across commands/agents/workflows', () => {
    const offenders = [];
    for (const { abs, rel } of collectFiles()) {
      const text = fs.readFileSync(abs, 'utf8');
      for (const { start, end } of taskBlocks(text, rel)) {
        const span = text.slice(start, end + 1);
        const m = FORBIDDEN.exec(span);
        if (m) {
          const lineNo = lineOf(text, start + m.index);
          offenders.push(`${rel}:${lineNo}`);
        }
      }
    }
    assert.equal(
      offenders.length,
      0,
      `@-refs found inside Task() prompts (should be zero):\n  ${offenders.join('\n  ')}`
    );
  });
});
