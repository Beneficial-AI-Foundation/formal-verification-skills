'use strict';

// The `recall` example in the top-specs workflow is the one authors copy. It is
// read the way the build check reads a spec file, and compiled with a real Lean
// when one of version 4.35 or later is found (FVS_LEAN names one, else `lean` on
// PATH, else the newest such toolchain under ~/.elan): `recall` is part of Lean
// from 4.35, so this form needs no import. The older form needs Mathlib and is
// only checked as text.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(ROOT, 'fv-skills', 'workflows', 'auto-top-specs.md');
const HEADING = '## A statement restated with `recall`';

let readSpecSource;
const temporaryDirectories = [];

before(async () => {
  ({ readSpecSource } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'fvs-build-check.mjs')).href));
});

after(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

// The fenced lean blocks of the example section, each with the file its first comment names.
function exampleFiles() {
  const text = fs.readFileSync(WORKFLOW, 'utf8');
  const start = text.indexOf(`\n${HEADING}\n`);
  assert.notEqual(start, -1, `the workflow has the section "${HEADING}"`);
  const end = text.indexOf('\n## ', start + 1);
  const section = text.slice(start, end === -1 ? undefined : end);
  return [...section.matchAll(/```lean\n([\s\S]*?)```/g)].map((match) => {
    const [first, ...rest] = match[1].split('\n');
    const file = /^-- (\S+\.lean)$/.exec(first);
    assert.ok(file, `a block starts with a comment naming its file: ${first}`);
    return { file: file[1], source: rest.join('\n') };
  });
}

function leanOf(directory) {
  const version = (bin) => {
    const run = spawnSync(bin, ['--version'], { cwd: os.tmpdir(), encoding: 'utf8', timeout: 20000 });
    const found = /version (\d+)\.(\d+)\./.exec(run.stdout ?? '');
    return found && Number(found[1]) === 4 && Number(found[2]) >= 35 ? bin : null;
  };
  if (process.env.FVS_LEAN) return version(process.env.FVS_LEAN);
  const toolchains = path.join(os.homedir(), '.elan', 'toolchains');
  const installed = fs.existsSync(toolchains) ? fs.readdirSync(toolchains).filter((name) => /lean4---v4\.(3[5-9]|[4-9]\d)\.\d+$/.test(name)).sort().reverse() : [];
  for (const bin of ['lean', ...installed.map((name) => path.join(toolchains, name, 'bin', 'lean'))]) {
    const ok = version(bin);
    if (ok) return ok;
  }
  return null;
}

describe('recall example in the top-specs workflow', () => {
  it('is a proof file and a spec file that the build check reads as one restated, guarded statement', () => {
    const [proof, spec] = exampleFiles();
    assert.deepEqual(exampleFiles().map((entry) => entry.file), ['formal/proofs/Hmac.lean', 'formal/specs/Specs/Hmac.lean']);
    assert.match(proof.source, /^theorem hmac_len /m);
    const statement = readSpecSource(spec.source).statements.find((entry) => entry.name === 'hmac_len');
    assert.ok(statement, 'the spec file restates hmac_len');
    assert.notEqual(statement.recallLine, null);
    assert.notEqual(statement.guardLine, null);
    assert.deepEqual(statement.problems, []);
    assert.deepEqual(statement.axioms, []);
  });

  it('says where recall comes from on each Lean version', () => {
    const text = fs.readFileSync(WORKFLOW, 'utf8');
    assert.match(text, /From Lean 4\.35,\s+`recall` is part of Lean and needs no import/);
    assert.match(text, /On Lean 4\.34 and\s+earlier, add `import Mathlib\.Tactic\.Recall`/);
  });

  const lean = leanOf();
  it('compiles with Lean 4.35 or later, and a different statement fails', { skip: lean === null && 'no Lean 4.35 or later found (set FVS_LEAN)' }, () => {
    const [proof, spec] = exampleFiles();
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fvs-recall-'));
    temporaryDirectories.push(directory);
    // The workflow's layout names the proof file's module Proofs.Hmac, as the spec file imports it.
    const build = (source, name, ...more) => {
      fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
      fs.writeFileSync(path.join(directory, name), source);
      return spawnSync(lean, ['--root=.', ...more, name], { cwd: directory, encoding: 'utf8', env: { ...process.env, LEAN_PATH: path.join(directory, 'out') } });
    };
    fs.mkdirSync(path.join(directory, 'out', 'Proofs'), { recursive: true });
    const proved = build(proof.source, 'Proofs/Hmac.lean', '-o', path.join(directory, 'out', 'Proofs', 'Hmac.olean'));
    assert.equal(proved.status, 0, proved.stdout + proved.stderr);
    const restated = build(spec.source, 'Specs/Hmac.lean');
    assert.equal(restated.status, 0, restated.stdout + restated.stderr);

    const different = build(spec.source.replace('n + 0 = n', 'n = n + 1'), 'Specs/Other.lean');
    assert.notEqual(different.status, 0, 'a restatement that is not the declared statement fails the build');
    assert.match(different.stdout + different.stderr, /Type mismatch/);
  });
});
