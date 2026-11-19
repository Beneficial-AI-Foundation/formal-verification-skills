'use strict';

// The check the engine appends to a stitched crate's published module, run by real Lean. Set
// FVS_STITCH_LEAN_PROJECT to a Lake project that requires Aeneas (and is built), for example the
// scratch project of a real extraction; the test is skipped without it. Every case goes through the
// engine (the fake tools write the Lean of both crates) and then through Lean: the provider's module
// is compiled, the stitched consumer is compiled with and without the generated check, and the
// outcomes are compared. An alias that elaborates is not enough: the cases below elaborate without
// the check and are rejected by it.

const { after, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { toySpec, cleanup, workspace, step, attempted } = require('./helpers/fake-multicrate-tools.cjs');

after(cleanup);

const PROJECT = process.env.FVS_STITCH_LEAN_PROJECT;
const HEADER = 'module\npublic import Aeneas\n@[expose] public section\nopen Aeneas Aeneas.Std Result\n';

const provider = (definition, rustPath) => `${HEADER}namespace toy_lib\n\n/-- [${rustPath}]:\n    Source: 'lib/src/lib.rs', lines 1:0-1:1\n    Visibility: public -/\n${definition}\n\nend toy_lib\n`;
const consumer = (kind, rustPath, name, type) => `${HEADER}namespace toy_app\n\n/-- [${rustPath}]:\n    Source: 'lib/src/lib.rs', lines 1:0-1:1\n    Name pattern: [${rustPath}]\n    Visibility: public -/\n@[${kind} "${rustPath}"]\naxiom toy_lib.${name}\n  : ${type}\n\nend toy_app\n`;

// Each case: the provider's declaration, the consumer's axiom, and whether the types agree. The
// cases that agree must build; the others are told apart by where they stop: the engine's own text
// comparison (engineRefuses), Lean elaborating the alias (elaborationFails), or only the generated
// check (the rest, which elaborate by instantiating what the provider keeps general).
const CASES = [
  { name: 'equal monomorphic types', item: 'mono', def: 'def mono : ∀ (x : Std.U32), Result Std.U32 := fun x => ok x', type: 'Std.U32 → Result Std.U32', agree: true },
  { name: 'a dependent binder that agrees', item: 'dep', def: 'def dep : ∀ (n : Nat), Fin (n + 1) → Nat := fun _ v => v.val', type: '(n : Nat) → Fin (n + 1) → Nat', agree: true },
  { name: 'a constant, lifted with Result', item: 'K', kind: 'rust_const', def: 'def K : Std.U32 := 7#u32', type: 'Result Std.U32', agree: true },
  // The engine's text comparison cannot read a type written with a binder against one written with an arrow, so Lean decides.
  { name: 'U32 where the provider has U64, in a form the text comparison cannot read', item: 'width', def: 'def width : ∀ (x : Std.U64), Result Std.U64 := fun x => ok x', type: 'Std.U32 → Result Std.U64', agree: false, elaborationFails: true },
  { name: 'U32 where the provider has U64, in a form the text comparison reads', item: 'narrow', def: 'def narrow (x : Std.U64) : Result Std.U64 := ok x', type: 'Std.U32 → Result Std.U64', agree: false, engineRefuses: true },
  { name: 'an implicit type parameter that the alias instantiates', item: 'poly', def: 'def poly : ∀ {α : Type}, α → Result α := fun x => ok x', type: 'Std.U32 → Result Std.U32', agree: false },
  { name: 'an instance argument that the alias synthesises', item: 'inst', def: 'def inst : ∀ {α : Type} [Inhabited α], Result α := ok default', type: 'Result Std.U32', agree: false },
  { name: 'a universe parameter that the alias instantiates', item: 'univ', def: 'def univ : ∀ (α : Type _), Type _ := fun α => α', type: 'Type → Type', agree: false },
];

function lean(args, options) {
  return spawnSync(args[0], args.slice(1), { encoding: 'utf8', ...options, env: { ...process.env, LEAN_NUM_THREADS: '2', ...options.env } });
}

describe('the generated check, run by real Lean', { skip: PROJECT ? false : 'set FVS_STITCH_LEAN_PROJECT to a built Lake project that requires Aeneas' }, () => {
  const leanPath = PROJECT ? lean(['lake', 'env', 'printenv', 'LEAN_PATH'], { cwd: PROJECT }).stdout.trim() : '';
  const leanBin = PROJECT ? lean(['lake', 'env', 'which', 'lean'], { cwd: PROJECT }).stdout.trim() : '';

  for (const entry of CASES) {
    it(entry.name, () => {
      const rustPath = `toy_lib::${entry.item}`;
      const ws = workspace({
        toy_lib: { lean: provider(entry.def, rustPath) },
        toy_app: { lean: consumer(entry.kind ?? 'rust_fun', rustPath, entry.item, entry.type) },
      });
      const spec = toySpec();
      spec.crates[0].moduleRoot = 'Toy.Lib';
      spec.crates[1].moduleRoot = 'Toy.App';
      spec.crates[1].stitch = [{ crate: 'toy_lib' }];
      const { out, recorded } = attempted(ws, spec);
      assert.equal(recorded.status, 0, recorded.stdout);
      for (const name of ['charon', 'aeneas']) for (const crate of ['toy_lib', 'toy_app']) assert.equal(step(ws, out, name, crate).status, 0);
      assert.equal(step(ws, out, 'publish', 'toy_lib').status, 0);
      const published = step(ws, out, 'publish', 'toy_app');
      if (entry.engineRefuses) {
        // The engine reads this signature and refuses it before Lean is involved.
        assert.equal(published.status, 9, published.stdout);
        return;
      }
      assert.equal(published.status, 0, published.stdout);

      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fvs-stitch-lean-'));
      try {
        fs.mkdirSync(path.join(root, 'Toy', 'Lib'), { recursive: true });
        fs.mkdirSync(path.join(root, 'Toy', 'App'), { recursive: true });
        fs.copyFileSync(path.join(ws.project, 'Lean/Lib/ToyLib.lean'), path.join(root, 'Toy/Lib/ToyLib.lean'));
        const env = { LEAN_PATH: `${leanPath}:${root}` };
        const built = lean([leanBin, '-o', path.join(root, 'Toy/Lib/ToyLib.olean'), path.join(root, 'Toy/Lib/ToyLib.lean')], { cwd: root, env });
        assert.equal(built.status, 0, `the provider's published module must build: ${built.stdout}${built.stderr}`);

        const text = fs.readFileSync(path.join(ws.project, 'Lean/App/ToyApp.lean'), 'utf8');
        assert.match(text, /run_cmd liftTermElabM do/);
        const withoutCheck = text.replace(/\n\/-! The declared type[\s\S]*$/, '\n');
        const compile = (source) => {
          fs.writeFileSync(path.join(root, 'Toy/App/ToyApp.lean'), source);
          return lean([leanBin, path.join(root, 'Toy/App/ToyApp.lean')], { cwd: root, env });
        };
        const bare = compile(withoutCheck);
        if (entry.elaborationFails) {
          // Lean's own elaboration of the alias already rejects this one; the generated check is the second layer.
          assert.notEqual(bare.status, 0, 'the alias does not elaborate');
          assert.match(`${bare.stdout}${bare.stderr}`, /Type mismatch/);
          return;
        }
        assert.equal(bare.status, 0, `the alias itself elaborates: ${bare.stdout}${bare.stderr}`);
        const checked = compile(text);
        if (entry.agree) assert.equal(checked.status, 0, `${checked.stdout}${checked.stderr}`);
        else {
          assert.notEqual(checked.status, 0, 'the generated check rejects what the alias accepted');
          assert.match(`${checked.stdout}${checked.stderr}`, /toy_app\.toy_lib\.\w+: (its type .* is not the type .* of toy_lib\.\w+|\d universe parameter\(s\), but toy_lib\.\w+ has \d)/);
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
