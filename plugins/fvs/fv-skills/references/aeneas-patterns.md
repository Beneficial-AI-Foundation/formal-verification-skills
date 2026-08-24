# Aeneas Pipeline Patterns (REF-01)

<overview>
The Aeneas pipeline translates Rust code into Lean 4 for formal verification. It produces
auto-generated type definitions (Types.lean) and function bodies (Funs.lean) that serve as
the ground truth for verification. Understanding the pipeline output, project layout, and
working modes is essential before writing any specification or proof.
</overview>

<quick_reference>

| File / Directory | Description | Editable? |
|---|---|---|
| `Types.lean` | Auto-generated Rust type translations (structs, enums) | NEVER |
| `Funs.lean` | Auto-generated Rust function translations | NEVER |
| `TypesExternal.lean` | Opaque external type stubs | Rarely (project-specific) |
| `FunsExternal.lean` | Opaque external function stubs | Rarely (project-specific) |
| `Defs.lean` | Hand-written mathematical definitions and constants | Yes |
| `Specs/` | Hand-written specification theorems and proofs | Yes |
| `Defs/` | Hand-written extended definitions (e.g., curve representations) | Yes |
| `lakefile.toml` | Build configuration; pins Aeneas backend revision | Carefully |
| `lean-toolchain` | Lean version pinning (e.g., `leanprover/lean4:v4.24.0`) | Carefully |
| `functions.json` | Metadata index of all extracted functions | Generated |
| `Axioms.lean` or `Axioms/` | All intentional axioms (FFI, SIMD, external) grouped for audit | Yes (carefully) |
| `FunsExternal_Template.lean` | Aeneas-generated template with `sorry` bodies for external functions | Reference only |
| `TypesExternal_Template.lean` | Aeneas-generated template with `sorry` bodies for external types | Reference only |

## Backward Continuation Pattern

When a Rust function returns a mutable borrow (`&mut T`), Aeneas translates it to
return a tuple `(value, backward_fn)`. The backward function propagates updates back
to the original variables:

```lean
-- Rust: fn choose<T>(b: bool, x: &mut T, y: &mut T) -> &mut T
-- Lean translation:
def choose {T : Type} (b : Bool) (x : T) (y : T) :
  Result (T × (T → T × T)) :=
  if b then ok (x, fun z => (z, y))
  else ok (y, fun z => (x, z))
```

Key Aeneas translation patterns:

| Rust | Lean |
|---|---|
| `&mut T` param | `T` param (by value) |
| Return `&'a mut T` | Returns `Result (T × (T → ...))` — backward continuation |
| `&T` (shared) | `T` param (may be copied) |
| `panic!()` / integer overflow | `fail` |
| `Box<T>` | `T` |
| `Vec<T>` | `Vec T` (Aeneas Vec, backed by `List`) |
| `[T; N]` | `Array T N` |
| Traits | Type classes |

All extracted functions use `do` notation with the `Result` error monad. Each
`let x <- expr` is a monadic bind that can fail (e.g., on overflow or out-of-bounds).

</quick_reference>

<patterns>

## Pattern 1: Project Directory Structure

A verified Lean project produced by Aeneas follows a consistent top-level layout
(Types.lean, Funs.lean, lakefile.toml, lean-toolchain). The Specs/ and Defs/ directories
are hand-created by the verification team and their internal structure varies by project.

**Example layout (curve25519-dalek-lean-verify):**

```
ProjectRoot/
  lakefile.toml              # Build config; requires aeneas backend
  lean-toolchain             # Lean version pin
  functions.json             # Function metadata index
  extraction_notes.md        # Documents Aeneas limitations encountered

  ProjectName/               # Main Lean library (e.g., Curve25519Dalek/)
    Types.lean               # AUTO-GENERATED: all Rust types
    Funs.lean                # AUTO-GENERATED: all Rust function bodies
    TypesExternal.lean       # Stubs for opaque external types
    FunsExternal.lean        # Stubs for opaque external functions
    TypesAux.lean            # Auxiliary type definitions
    Aux.lean                 # Auxiliary lemmas
    Tactics.lean             # Project-specific tactics

    Defs.lean                # Mathematical constants and interpretation functions
    Defs/                    # Extended definitions
      Edwards/
        Representation.lean
        Curve.lean

    Specs/                   # Specification theorems and proofs
      Backend/
        Serial/
          U64/
            Field/
              FieldElement51/
                Add.lean
                Sub.lean
                Mul.lean
                Reduce.lean
                ...
            Scalar/
              Scalar52/
                Add.lean
                MontgomeryMul.lean
                ...
          CurveModels/
            CompletedPoint/
              AsExtended.lean
              ...
      Edwards/
        EdwardsPoint/
          Add.lean
          Double.lean
          ...
      Montgomery/
        MontgomeryPoint/
          Mul.lean
          ...
      Scalar/
        Scalar/
          Reduce.lean
          ...

  Utils/                     # Utility executables (e.g., ListFuns, SyncStatus)
```

The `Specs/` directory mirrors the Rust module hierarchy. Each Lean spec file corresponds
to one Rust function.

## Pattern 2: Aeneas Extraction Pipeline

The translation from Rust to Lean follows this pipeline:

```
Rust source code
    |
    v
  Charon (Rust compiler frontend plugin)
    |  - Compiles Rust to MIR
    |  - Produces LLBC (Low-Level Borrow Calculus) representation
    v
  LLBC (.llbc file)
    |
    v
  Aeneas (Lean backend)
    |  - Translates LLBC to functional Lean 4
    |  - Resolves borrows, lifetimes, mutability
    |  - Produces Types.lean + Funs.lean
    v
  Lean 4 project
    |  - Types.lean: struct/enum definitions
    |  - Funs.lean: function bodies as pure Lean functions
    |  - Result type wraps all functions (ok/error for panics)
    v
  Human writes Specs/ and Defs/
```

Key details:
- All extracted functions return `Result T` to model Rust panics
- Array indexing becomes bounds-checked operations returning `Result`
- Mutable borrows are translated to functional updates
- The `cfg(not(verify))` flag in Rust excludes functions from extraction
- The Aeneas backend is pinned by git revision in `lakefile.toml`

### Aeneas Limitations

Not all Rust patterns can be extracted. Known limitations include:

- **Dynamic array indexing**: `output[i] = val` where `i` is computed at runtime
- **Iterator trait machinery**: `.map()`, `.collect()`, complex iterator chains
- **Dynamic dispatch**: `dyn Trait` objects
- **Async/await**: Not supported

When extraction fails, the standard workaround is `#[cfg(not(verify))]` to exclude the
function and all its transitive callers. Document these exclusions in `extraction_notes.md`.

## Pattern 3: Working Modes

Verification work falls into three modes, each with different tactics and approaches:

### Mode 1: Rust Code Verification
Start from the Aeneas-generated function signature. Focus on proving the implementation
matches a mathematical specification.

```lean
-- Primary tactics for verification:
unfold rust_function_name    -- Expand the auto-generated definition
step                         -- Step through Aeneas monadic code
simp [relevant_lemmas]       -- Simplify
scalar_tac                   -- Resolve scalar arithmetic goals
```

### Mode 2: Mathematical Bridge Building
Connect high-level mathlib abstractions with low-level crypto implementations.
Create new definitions and bridge theorems.

```lean
-- Primary tactics for mathematical work:
ring                         -- Ring arithmetic
field_simp                   -- Field simplification
simp [group_laws]            -- Abstract algebraic simplification
```

### Mode 3: Technical Debt and Refactoring
Identify repeated proof patterns, extract common lemmas, improve organization.
Focus on maintainability and proof reuse.

## Pattern 4: functions.json Metadata Format

The `functions.json` file indexes every extracted function with verification status:

```json
{
  "functions": [
    {
      "rust_name": "curve25519_dalek::backend::serial::u64::field::FieldElement51::add",
      "lean_name": "curve25519_dalek.backend.serial.u64.field.FieldElement51.add",
      "source": "curve25519-dalek/src/backend/serial/u64/field.rs",
      "lines": "L120-L135",
      "verified": true,
      "specified": true,
      "fully_verified": true,
      "spec_file": "Curve25519Dalek/Specs/Backend/Serial/U64/Field/FieldElement51/Add.lean",
      "spec_statement": "theorem add_spec ...",
      "spec_docstring": "...",
      "is_relevant": true,
      "is_hidden": false,
      "is_extraction_artifact": false,
      "dependencies": ["...other_lean_function_names..."],
      "nested_children": []
    }
  ]
}
```

Key fields for workflow:
- `verified` / `specified` / `fully_verified`: Track progress
- `spec_file`: Path to the spec theorem
- `dependencies`: Which other extracted functions this calls (for dependency analysis)
- `is_hidden`: Trait wrapper functions that delegate to inner implementations
- `is_extraction_artifact`: Functions generated by Aeneas without Rust counterpart

## Pattern 5: Canonical Loop Proof Template

Every loop proof follows a three-theorem structure. The only things that change
between loops are: (a) what the loop body does, (b) what the invariant says.

**Three theorems per loop:**
1. `spec_gen` -- generalized loop spec with arbitrary start position + invariant
2. `spec` -- public `@[step]` wrapper that instantiates `spec_gen` at `start = 0`
3. Top-level function spec -- unfolds the wrapper function, delegates to `spec`

### spec_gen (inner loop body)

The `spec_gen` theorem proves the loop body with a decreasing measure. Use
`step*` when the body is simple enough (Variant A, preferred), or manual
`step as` when fine control is needed (Variant B).

```lean
private theorem my_loop.spec_gen
  (out out0 a : Slice Std.U16)
  (hlen : out.length = a.length)
  (hlen0 : out.length = out0.length)
  (iter : core.ops.range.Range Std.Usize)
  (hlo : iter.start.val <= iter.end.val)
  (hend : iter.end.val = out.length)
  -- Invariant: entries before start are processed
  (hdone : forall j, j < iter.start.val -> out[j] = f a[j] out0[j])
  -- Invariant: entries at or after start are untouched
  (hrest : forall j, iter.start.val <= j -> j < out.length -> out[j] = out0[j]) :
  my_loop iter out a ⦃ fun res =>
    res.length = out0.length ∧
    ∀ j, j < res.length → res[j] = f a[j] out0[j] ⦄ := by
  unfold my_loop
  step*
  -- Remaining obligations (invariant rebuild + base case):
  · -- Invariant rebuild: entries before start+1 are done
    intro j hj
    by_cases hji : j = iter.start.val
    · subst hji; simp [*]   -- freshly written entry
    · apply hdone; agrind    -- previously done entry
  · -- Invariant rebuild: entries after start+1 are untouched
    intro j hlo hhi; apply hrest <;> agrind
  · -- BASE CASE: loop done
    split_conjs <;> agrind
termination_by iter.end.val - iter.start.val
decreasing_by agrind
```

### spec (entry-point wrapper, starts at 0)

```lean
@[step]
theorem my_loop.spec (out a : Slice Std.U16) (hlen : out.length = a.length) :
  my_loop { start := 0#usize, «end» := out.len } out a ⦃ fun res =>
    res.length = out.length ∧
    ∀ j, j < res.length → res[j] = f (a[j]) (out[j]) ⦄ := by
  apply WP.spec_mono
  · apply my_loop.spec_gen <;> agrind   -- instantiate spec_gen at start=0
  · intro res ⟨h1, h2⟩; split_conjs <;> agrind   -- derive final postcondition
```

### Key points

- Never use `partial_fixpoint_induct` -- it requires an explicit motive, a
  sorry'd `admissible` proof, and manual IH threading
- `step*` on the recursive call automatically applies the `@[step]`-tagged
  theorem being proved (self-reference works)
- `termination_by` + `decreasing_by agrind` is the universal termination pattern
- For nested loops: the outer `spec_gen` calls the inner loop's `@[step]` spec
  via `step with inner_loop.spec`, then rebuilds the outer invariant
- Every function spec requires loop specs too -- a function spec without its
  loop specs is unprovable

---

## Pattern 6: The Specification Pattern (Enriched)

Specification theorems follow strict conventions for naming, indentation, and
postcondition structure.

### Template

```lean
/-- **Spec theorem for `crate_name::module::function_name`**
Concise natural-language description of the spec. -/
@[step]
theorem function_name.spec (params : Types) (preconditions : hypotheses) :
    function_name params ⦃ (result : ResultType) =>
      postcondition result ⦄ := by
  unfold function_name
  step  -- or step* for automation
  -- finish remaining goals
```

### Indentation rules

- `@[step]` and `theorem name`: base indentation (0 additional)
- Arguments, preconditions, and the function application line: +4 spaces
- Postconditions inside `⦃ ⦄`: +6 spaces
- Proof body (after `:= by`): +2 spaces
- Always annotate the result with its type: `(result : ResultType) =>`

### Key guidelines

- **Docstring**: add a docstring with a concise natural-language description
- **Naming**: theorem name is the function's full Lean name with suffix `.spec`.
  Open namespaces so the identifier prefix does not clutter the code
- **Result type annotation**: always annotate the result binder, e.g.,
  `⦃ (result : U32) =>` -- this aids readability and type inference
- **`@[step]` attribute**: always add it so the Aeneas `step` tactic can find
  the theorem. Start a new line after the attribute
- **With backward function**: decompose the tuple in the binder, never use
  projectors (`.1`, `.2`, `.fst`, `.snd`):
  ```lean
  fun_name a b ⦃ (x : U32) (s : Slice U16) =>
    x.val < 100 ∧ s.length = a.length ⦄
  ```

---

## Pattern 7: Postcondition Quality Rules

Postconditions are the contract between a function's spec and its callers.
Getting them right is critical -- a weak postcondition cascades failures through
the entire dependency graph.

### Full functional correctness via direct equality

Postconditions must be a direct equality linking the Rust output to a high-level
specification function, using representation/conversion functions on both inputs
and outputs:

```
repr(output) = Spec.algorithmName(repr(input1), repr(input2), ...)
```

Relational specs (simulation relations, abstract state) are not acceptable as
final specs. Structural properties (`wfArray`, lengths, metadata) are necessary
but never sufficient -- they are supplementary conjuncts, not the main
postcondition.

### Write final postconditions from the start

Always write the full functional-correctness postcondition in the theorem
statement, even if the proof is `sorry`. Do NOT write a weaker version first
with intent to strengthen later. Upgrading a postcondition after the fact is
extremely costly: it often requires strengthening the `step` theorems the
function depends on, cascading across many files.

**Correct workflow:** Write the final statement (with full spec equality +
structural conjuncts), leave `sorry` as the proof, then prove conjuncts one by
one -- each conjunct can be tackled independently and in parallel.

### Vacuity test

When reviewing a postcondition, ask: "Would this postcondition still hold if
the implementation returned arbitrary/zero data?" If yes, the spec is too weak.
This catches specs that only track metadata while ignoring the actual computed
output.

```lean
-- BAD: length preservation only -- says nothing about computed values
theorem poly_element_ntt_layer.spec
    (src : Array U16 256#usize) ... :
    poly_element_ntt_layer src k len
    ⦃ src' => src'.length = src.length ⦄ := by ...

-- GOOD: direct equality with repr on both inputs and outputs
theorem poly_element_ntt_layer.spec
    (src : Array U16 256#usize) ... :
    poly_element_ntt_layer src k len
    ⦃ src' => toPoly src' = Spec.ntt (toPoly src) ⦄ := by ...
```

### Thread invariants

When a function preserves a well-formedness property, include it both as a
precondition and in the postcondition. Callers need the invariant to flow
through `step`:

```lean
-- GOOD: well-formedness threaded through
theorem poly_element_ntt_layer.spec
    (src : Array U16 256#usize) ...
    (hWf : wfArray src) :  -- input well-formed
    poly_element_ntt_layer src k len
    ⦃ src' => toPoly src' = Spec.ntt (toPoly src) ∧ wfArray src' ⦄ := ...
```

### No existentials over non-Prop types

Step theorems must avoid existentially quantifying variables that are not
propositions. An existential hides where the value comes from, making the
postcondition unusable by callers. Using `∃ (_ : a), b` to thread a proof
(proposition) is fine; `∃ a, P a` where `a` is a non-Prop type is suspicious.

```lean
-- BAD: who is `a`? The caller gets an opaque witness
⦃ src' => ∃ a, toPoly src' = Spec.ntt a ⦄

-- GOOD: the input is explicit -- the relationship is concrete
⦃ src' => toPoly src' = Spec.ntt (toPoly src) ⦄
```

---

## Pattern 8: Fold Decomposition for Large Functions

When a function is too large to verify monolithically (10+ monadic steps,
proof exceeds ~200 lines), decompose it into fold theorems.

### The technique

1. **Define a helper** that captures a subsequence of operations:
```lean
private def helper (a : U32) : Result (U32 × U32) := do
  let b ← a + 1#u32; let c ← b * 2#u32; ok (b, c)
```

2. **Prove a fold theorem** showing the inline version equals the helper.
The continuation must use curried arguments (not tuple):
```lean
private theorem fold_helper (a : U32) (f : U32 → U32 → Result α) :
  (do let b ← a + 1#u32; let c ← b * 2#u32; f b c) =
  (do let r ← helper a; f r.1 r.2) := by
  simp only [helper, bind_assoc_eq, bind_tc_ok, pure]
```

3. **Write a `@[local step]` spec** for the helper:
```lean
@[local step]
theorem helper.spec (a : U32) (h : a.val < 1000) :
  helper a ⦃ (b : U32) (c : U32) =>
    b.val = a.val + 1 ∧ c.val = (a.val + 1) * 2 ⦄ := by ...
```

4. **Use in the main proof**: `simp only [fold_helper]` to replace inline
steps with the helper call, then `step` through the helper.

### Key lemmas for fold theorems

- `bind_assoc_eq` -- monadic bind is associative: re-associates nested binds
  so the helper definition can be matched
- `bind_tc_ok` -- eliminates trivial `ok` binds that appear when unfolding
  the helper definition
- `pure` -- unfolds `pure` in the `Result` monad

### Fold theorem invariants

- LHS and RHS MUST differ (if provable by `rfl`, the theorem is vacuous)
- Continuation must use curried arguments (`f a b c`), not a tuple
  (`f (a, b, c)`) -- `simp` cannot match tuple continuations
- Every fold helper MUST have a `@[local step]` spec (even if sorry'd)
- Always test fold theorems: `simp only [fold_helper]` must make progress
  inside the parent function

---

## Pattern 9: Axiom Organization

All intentional axioms (for FFI/external functions, SIMD intrinsics, etc.)
must be grouped in a single `Axioms.lean` file or an `Axioms/` directory.
The purpose is to make axioms easy to find for auditing -- axioms are unproved
assumptions, and reviewers need to inspect every one.

### When axioms are allowed

- External/opaque functions (FFI, SIMD, OS calls, FunsExternal.lean) -- no body
  to unfold
- Raw pointer operations -- features strictly outside Aeneas' model of Rust.
  Functions containing raw pointers may axiomatize ONLY the raw pointer
  operations, then prove the rest around the axioms.

### When axioms are NEVER allowed

- Transparent functions -- if the function body is in the generated Lean code,
  it MUST be proved, not axiomatized. "Too many monadic steps" is never a valid
  reason -- decompose using fold theorems (Pattern 8) instead.

### Rules

- Every axiom must have a docstring explaining what it assumes and why it cannot
  be proved
- Group related axioms together (e.g., all SIMD intrinsics in one section)
- Always fix problematic axioms even if the fix causes a major proof refactor --
  the entire verification effort rests on axioms being obviously true

---

## Pattern 10: Sorry'd Definitions vs Sorry'd Theorems

A sorry'd **definition** (`def foo := sorry`) needs a **value** -- a Lean term
of the correct type. A sorry'd **theorem** (`theorem foo := by sorry`) needs a
**proof** -- a tactic sequence.

Confusing these is a common mistake:
- A sorry'd def produces a valid term of the right type (potentially unsound
  if the term is used in other computations)
- A sorry'd theorem is a hole in the proof (always unsound but localized)

**For `def` (sorry'd definition):** provide a concrete Lean expression.
Common patterns:
- Byte assembly: `arrayToSpecBytes field1 ++ arrayToSpecBytes field2`
- Extraction: `(arrayToSpecBytes field).extract start len`
- Casting: `expr.cast (by scalar_tac)` or `expr.cast (by simp [...])`

**For `theorem` (sorry'd theorem):** provide a tactic proof
(`by unfold ...; step*; ...`)

**Key question for sorry'd definitions:** "What concrete data should this be?"
Read the docstring and expected type carefully. The answer is almost always a
composition of conversion functions applied to relevant fields.

---

## Tooling: Lean LSP MCP Integration

When available, the lean-lsp-mcp MCP server provides interactive proof
development tools directly in the editor:

- `lean_goal` -- inspect proof state at any position
- `lean_diagnostic_messages` -- errors and warnings without rebuilding
- `lean_hover_info` -- type information via hover
- `lean_multi_attempt` -- try multiple tactics without modifying the file
- `lean_code_actions` -- retrieve `step*?` suggestions
- External search: LeanSearch, Loogle, Lean Finder for discovering lemmas

This enables incremental proof checking without running `lake build` (which
should only be used as a final verification step). See the lean-lsp-mcp skill
file for setup instructions and full tool reference.

</patterns>

<anti_patterns>

## NEVER edit Types.lean or Funs.lean

These files are auto-generated by Aeneas. Any manual edits will be overwritten on
re-extraction. If a type or function definition looks wrong, the fix must happen in the
Rust source or in the Aeneas pipeline configuration, not in the generated Lean files.

## NEVER hallucinate lemma or tactic names

Always verify that a lemma, theorem, or tactic exists before using it in a proof.
Lean 4 will reject undefined names at compile time, but hallucinated names waste
significant build cycles (full builds can take 30+ minutes). Use exploratory tactics
like `exact?`, `apply?`, or `simp?` to discover available lemmas.

## NEVER skip dependency analysis

Before writing a spec for function `f`, check `functions.json` to identify all functions
that `f` calls. Each dependency must have a proven spec (with `@[step]` attribute)
before `step` can make headway on `f`. Working bottom-up through the dependency
graph is essential.

## NEVER assume extraction is complete

Aeneas cannot extract all Rust patterns. Always check `extraction_notes.md` for known
exclusions and verify that the target function actually appears in `Funs.lean` before
attempting to write a specification. Functions behind `#[cfg(not(verify))]` will be
silently absent.

## NEVER run `lake build` without resource limits

Full project compilation is computationally expensive (30+ minutes). Always use
`nice -n 19 lake build` to avoid monopolizing system resources. For iterative
development, build individual files when possible.

## NEVER use `partial` or `private` for hand-written models

When writing hand-written models of Rust functions (e.g., in `FunsExternal.lean`):
- **Do NOT use `partial`** -- `partial` definitions are opaque and cannot be
  unfolded or reasoned about. If the function lives in `Result`, use
  `partial_fixpoint` instead.
- **Do NOT use `private`** -- all definitions must be accessible for unfolding
  and reasoning in proofs.

## NEVER unfold standard library definitions

The Aeneas standard library (`Aeneas.Std`) provides lemmas for reasoning about
its types (Slice, Array, UScalar, etc.). If you find yourself unfolding standard
library definitions in the middle of a proof, STOP:

1. Unfolding is a sign that a lemma is missing
2. Search the Aeneas library for the lemma (`grep` for related names, check
   simp/step attributes)
3. If it does not exist, figure out what it should be, state it, and prove it

This applies to `Slice.*`, `Array.*`, `UScalar.*`, `IScalar.*`, iterator types,
`core.*`, etc. The same principle extends to project-local auxiliary definitions
-- introduce bridge lemmas rather than deeply unfolding.

## Prefer `-loops-to-rec` extraction flag for loop-heavy code

Aeneas supports two loop translation modes:
- **`-loops-to-rec`** (recommended): Translates loops to recursive Lean functions.
  Proofs use `unfold` + `step` with `termination_by` / `decreasing_by`.
- **Fixed-point combinator** (default): Translates using a `loop` operator.
  Proofs use `loop.spec_decr_nat`. The proof infrastructure is less mature.

Until the fixed-point combinator infrastructure matures, use `-loops-to-rec` for
any project where you need to write proofs.

</anti_patterns>

<summary>
The Aeneas pipeline produces a structured Lean 4 project from Rust source code.
Types.lean and Funs.lean are auto-generated and must never be edited. Human verification
work lives in Specs/ (theorems) and Defs/ (mathematical definitions). Functions.json
provides the metadata index for tracking progress and analyzing dependencies.

Key patterns for productive verification work:
- **Backward continuations**: Mutable borrows become `(value, backward_fn)` tuples
- **Loop proofs**: Three-theorem pattern (spec_gen / spec / top-level)
- **Specification quality**: Direct equality postconditions, vacuity test, thread invariants
- **Large functions**: Fold decomposition with `bind_assoc_eq` and `bind_tc_ok`
- **Axiom discipline**: Group in Axioms.lean, never axiomatize transparent functions
- **Sorry management**: Know the difference between sorry'd defs and sorry'd theorems
- **Tooling**: Use lean-lsp-mcp for incremental proof checking, `lake build` only at end

Understanding Aeneas limitations and working bottom-up through the dependency graph
are prerequisites for productive verification work.
</summary>
