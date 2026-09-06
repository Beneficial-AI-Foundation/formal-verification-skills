'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const THREAD_PREFIX = 'LEAN_NUM_THREADS="${LEAN_NUM_THREADS:-4}" nice -n 19 ';
const CACHE_COMMAND = `${THREAD_PREFIX}lake exe cache get`;
const FAMILIES = [
  'aeneas-extract',
  'crypto-execute',
  'crypto-plan',
  'crypto-followup',
  'lean-formalise',
  'lean-refactor',
  'lean-specify',
  'lean-verify',
  'trust-audit',
];

const ENTRYPOINTS = FAMILIES.flatMap(name => [
  path.join(ROOT, 'commands', 'fvs', `${name}.md`),
  path.join(ROOT, 'fv-skills', 'workflows', `${name}.md`),
]);

function relative(file) {
  return path.relative(ROOT, file);
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

describe('Lean build entrypoints are cache-first and fail closed', () => {
  it('keeps an explicit inventory of all nine build-owning workflow families', () => {
    assert.equal(FAMILIES.length, 9);
    assert.equal(new Set(FAMILIES).size, 9);
  });

  for (const file of ENTRYPOINTS) {
    it(`${relative(file)} warms the cache before its first build-capable action`, () => {
      const source = fs.readFileSync(file, 'utf8');
      const lines = source.split('\n');
      const cacheLine = lines.findIndex(line => line.includes(CACHE_COMMAND));
      assert.ok(cacheLine >= 0, `${relative(file)} missing ${CACHE_COMMAND}`);

      const cacheAt = source.indexOf(CACHE_COMMAND);
      const actions = [
        source.search(/^\s*LEAN_NUM_THREADS="\$\{LEAN_NUM_THREADS:-4\}" nice -n 19 lake build\b/m),
        source.search(/subagent_type="[^"\n]+"/),
      ].filter(at => at >= 0);
      assert.ok(actions.length > 0, `${relative(file)} has no build or delegate action to order`);
      assert.ok(cacheAt < Math.min(...actions),
        `${relative(file)} cache preflight occurs after its first build-capable action`);

      const guard = lines.slice(cacheLine, cacheLine + 9).join('\n');
      assert.match(guard, /CACHE_STATUS=\$\?/,
        `${relative(file)} does not capture the cache command status`);
      assert.match(guard, /\[ "\$CACHE_STATUS" -ne 0 \]/,
        `${relative(file)} does not branch on cache failure`);
      assert.match(guard, /exit "\$CACHE_STATUS"/,
        `${relative(file)} does not halt after cache failure`);
    });
  }
});

const canonicalFiles = [
  ...walk(path.join(ROOT, 'agents')),
  ...walk(path.join(ROOT, 'commands', 'fvs')),
  ...walk(path.join(ROOT, 'fv-skills', 'workflows')),
  ...walk(path.join(ROOT, 'fv-skills', 'references')),
  path.join(ROOT, 'scripts', 'fvs-codex-think.mjs'),
].filter(file => /\.(?:md|mjs)$/.test(file));

describe('Canonical FVS build instructions use native bounded concurrency', () => {
  it('excludes generated, synchronized upstream, test, and result-only presentation sources', () => {
    for (const file of canonicalFiles) {
      const rel = relative(file);
      assert.ok(!rel.startsWith('plugins/fvs/'), `generated plugin leaked into scan: ${rel}`);
      assert.ok(!rel.startsWith('fv-skills/upstream/aeneas/'), `upstream snapshot leaked into scan: ${rel}`);
      assert.ok(!rel.startsWith('tests/'), `test fixture leaked into scan: ${rel}`);
    }
    assert.ok(!'lake build: clean'.includes('nice -n 19 lake build'));
  });

  it('prefixes every positive lake build instruction with the configurable four-thread default', () => {
    const offenders = [];
    for (const file of canonicalFiles) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        if (line.includes('nice -n 19 lake build') &&
            !line.includes(`${THREAD_PREFIX}lake build`)) {
          offenders.push(`${relative(file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(offenders, [], `unbounded positive build instructions:\n${offenders.join('\n')}`);
  });

  it('does not prescribe unsupported Lake jobs flags', () => {
    const offenders = [];
    for (const file of canonicalFiles) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        if (/\blake\b[^\n]*(?:--jobs\b|-j(?:\s|$))/.test(line)) {
          offenders.push(`${relative(file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(offenders, [], `unsupported Lake jobs flags:\n${offenders.join('\n')}`);
  });
});
