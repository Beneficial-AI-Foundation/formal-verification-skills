# Specification Conventions (REF-02)

<overview>
Specification conventions ensure that every proof file across a verification project follows
a uniform structure. Consistent naming, path mapping, theorem shape, and precondition style
make specs composable -- a spec for function `f` can be consumed by `progress` when proving
a caller of `f`. These conventions are derived from the curve25519-dalek-lean-verify project
(161 functions, 92 verified) and generalize to any Aeneas-based verification effort.
</overview>

<quick_reference>

### Path Mapping Rules (Rust to Lean)

| Rust Path Element | Lean Path Element | Example |
|---|---|---|
| Module path (`backend/serial/u64`) | Title case directories (`Backend/Serial/U64`) | `field.rs` -> `Field/` |
| Struct/type name (`FieldElement51`) | Title case directory | `FieldElement51/` |
| Function name (`mul_base`) | Title case file (`MulBase.lean`) | `sub` -> `Sub.lean` |
| Snake case (`add_assign`) | Title case (`AddAssign.lean`) | |
| Trait impl (`Add for Type`) | Mangled namespace in Lean | See Pattern 1 |

### Project-Specific Definitions and Constants

Projects typically have hand-written Lean files containing mathematical constants,
interpretation functions, and helper definitions. These are NOT produced by Aeneas —
they are authored by the verification team. The name and location vary by project
(e.g., `Defs.lean`, `MathDefs.lean`, or a `Defs/` directory).

During `/fvs:map-code`, the agent should ask the user where project-specific definitions
live, or scan for non-auto-generated `.lean` files outside `Types.lean` and `Funs.lean`.

**General rule:** Specs reference named constants, never inline numeric values.

**Example (curve25519-dalek uses `Defs.lean`):**

| Name | Value | Usage |
|---|---|---|
| `p` | `2^255 - 19` | Field prime |
| `L` | `2^252 + ...` | Group order |

</quick_reference>

<patterns>

## Pattern 1: Spec File Path Mapping

Every Rust function maps to exactly one Lean spec file. The path is derived mechanically
from the Rust module hierarchy.

**Worked example -- `FieldElement51::sub`:**

```
Rust source: curve25519-dalek/src/backend/serial/u64/field.rs
Rust path:   curve25519_dalek::backend::serial::u64::field::FieldElement51::sub

Step 1: Module path segments -> Title case directories
  backend/serial/u64/field -> Backend/Serial/U64/Field

Step 2: Struct name -> Title case directory
  FieldElement51 -> FieldElement51/

Step 3: Function name -> Title case file
  sub -> Sub.lean

Result: Specs/Backend/Serial/U64/Field/FieldElement51/Sub.lean
```

**Namespace convention:** The Lean namespace mirrors the Rust path with dots. For trait
implementations, Aeneas generates mangled names:

```lean
-- Simple method:
namespace curve25519_dalek.backend.serial.u64.field.FieldElement51

-- Trait impl (Add<FieldElement51> for FieldElement51):
namespace curve25519_dalek.backend.serial.u64.field.AddShared0FieldElement51SharedAFieldElement51FieldElement51
```

## Pattern 2: @[progress] Theorem Structure

Every specification theorem follows a canonical shape that enables automated proof
composition via the `progress` tactic.

```lean
@[progress]
theorem function_name_spec (param1 : Type1) (param2 : Type2)
    (h_precondition1 : precondition_expression)
    (h_precondition2 : precondition_expression) :
    ∃ result, function_name param1 param2 = ok result ∧
    postcondition_1 ∧
    postcondition_2 ∧
    postcondition_3 := by
  sorry
```

Key structural requirements:
- **`@[progress]` attribute**: Registers the theorem for use by the `progress` tactic.
  Without this, callers cannot automatically apply this spec.
- **Existential result**: `∃ result, ... = ok result ∧ ...` proves the function does not
  panic and binds the return value.
- **Conjunction of postconditions**: Each property is a separate conjunct for easy
  extraction by callers.
- **Hypothesis naming**: Prefix with `h_` (e.g., `h_bounds_a`, `h_qX_bounds`).

**Real example -- FieldElement51::add:**

```lean
@[progress]
theorem add_spec (a b : Array U64 5#usize)
    (ha : ∀ i < 5, a[i]!.val < 2 ^ 53)
    (hb : ∀ i < 5, b[i]!.val < 2 ^ 53) :
    ∃ result, add a b = ok result ∧
    (∀ i < 5, result[i]!.val = a[i]!.val + b[i]!.val) ∧
    (∀ i < 5, result[i]!.val < 2 ^ 54) := by
  unfold add
  progress*
```

## Pattern 3: Array Types and Interpretation Functions

Rust arrays and structs with array fields are represented as fixed-size `Array` types
in Lean. Projects that work with multi-limb representations typically define hand-written
interpretation functions that convert limb arrays to their mathematical values. These
functions live in the project's definitions file (see "Project-Specific Definitions"
above) and vary by project.

The `/fvs:map-code` command identifies which interpretation functions a project defines.

**General pattern:** An interpretation function is a weighted sum of limb values:

```lean
def MyType_as_Nat (limbs : Array U64 N#usize) : Nat :=
  ∑ i ∈ Finset.range N, 2^(LIMB_BITS * i) * (limbs[i]!).val
```

**Example (curve25519-dalek):**

| Rust Type | Lean Type | Interpretation Function | Limb Bits |
|---|---|---|---|
| `FieldElement51` (5 u64 limbs) | `Array U64 5#usize` | `Field51_as_Nat` | 51 |
| `Scalar52` (5 u64 limbs) | `Array U64 5#usize` | `Scalar52_as_Nat` | 52 |
| `[u8; 32]` (encoded bytes) | `Array U8 32#usize` | `U8x32_as_Nat` | 8 |

Not all projects use multi-limb representations. Projects verifying non-numeric Rust
code may not need interpretation functions at all.

**When to use interpretation functions:**
- In postconditions that assert mathematical correctness (modular arithmetic)
- When connecting implementation-level limbs to field-level values
- Prefer `MyType_as_Nat result % p = ...` over reasoning about individual limbs
  for mathematical properties

**When to use per-limb assertions:**
- For bounds on output limbs (needed by callers as preconditions)
- For element-wise operations where the per-limb relationship is the spec

## Pattern 4: Precondition Hypotheses

Preconditions serve two purposes: they prevent U64/U128 overflow in arithmetic operations,
and they establish mathematical validity. Bounds are stated as universal quantifiers over
limb indices.

**Limb bounds pattern:**

```lean
-- Input limbs bounded (prevents overflow in add/sub/mul)
(h_bounds_a : ∀ i < 5, a[i]!.val < 2 ^ 53)
(h_bounds_b : ∀ i < 5, b[i]!.val < 2 ^ 53)
```

**Struct field bounds pattern (for point types):**

```lean
-- Each coordinate of a CompletedPoint has bounded limbs
(h_qX_bounds : ∀ i, i < 5 → (q.X[i]!).val < 2 ^ 54)
(h_qY_bounds : ∀ i, i < 5 → (q.Y[i]!).val < 2 ^ 54)
(h_qZ_bounds : ∀ i, i < 5 → (q.Z[i]!).val < 2 ^ 54)
(h_qT_bounds : ∀ i, i < 5 → (q.T[i]!).val < 2 ^ 54)
```

**Choosing bound values:** Correct bounds are determined by careful analysis of the
original Rust source code during the `/fvs:plan` stage. The Rust code is the sole
source of truth — extracted Lean functions may obscure implicit conventions, naming
patterns, and inter-function dependencies that inform what bounds are safe.

**Analysis approach:**
- Trace the Rust arithmetic step by step to find worst-case intermediate values
- Identify implicit invariants maintained across function boundaries (e.g., a caller
  always passes reduced values, but this is never stated in the type system)
- Check for non-obvious dependencies: one function's output bounds become another's
  input preconditions

**General principle:** When exact bounds are complex, use slightly looser bounds that
are easier to state and prove, as long as they still prevent overflow.

**Example (curve25519-dalek, 51-bit limbs):**
- After `reduce`: limbs < 2^52 (canonical reduced form)
- Input to `add`: limbs < 2^53 (so sum < 2^54 < 2^64)
- Input to `sub`: `a` limbs < 2^63, `b` limbs < 2^54

## Pattern 5: Flexible Signature Approach

Not all Rust functions translate to clean specs on the first attempt. The flexible
signature approach handles this iteratively:

**Step 1:** Start with the literal Aeneas translation.

```lean
-- Try the direct signature first
@[progress]
theorem f_spec (x : T) : ∃ r, f x = ok r ∧ P r := by
  unfold f; progress
```

**Step 2:** If unprovable, analyze why. Common issues:
- Missing precondition (Rust implicitly assumes bounds)
- Postcondition too strong (need to weaken or add modular equivalence)
- Translation error in Aeneas output (rare but possible)

**Step 3:** Add hypotheses or adjust postconditions.

```lean
-- Refined: add bounds precondition, weaken to modular equivalence
@[progress]
theorem f_spec (x : T)
    (h_bounds : ∀ i < n, x[i]!.val < bound) :
    ∃ r, f x = ok r ∧
    Interpret r % p = expected % p := by
  ...
```

**Step 4:** Document the reasoning in a natural language block above the theorem.

</patterns>

<anti_patterns>

## Do not use raw Nat where interpretation functions exist

```lean
-- WRONG: manually summing limbs
postcondition: result[0]!.val + 2^51 * result[1]!.val + ... = expected

-- CORRECT: use the interpretation function
postcondition: Field51_as_Nat result % p = expected % p
```

Interpretation functions are defined once in `Defs.lean` and reused everywhere. They
enable `simp` and `unfold` to work uniformly across all specs.

## Do not hardcode mathematical constants

```lean
-- WRONG: magic number
postcondition: ... % 57896044618658097711785492504343953926634992332820282019728792003956564819949 = ...

-- CORRECT: use named constant from Defs.lean
postcondition: ... % p = ...
```

All mathematical constants (p, L, d, a, R, h) are defined in `Defs.lean`. Use the
symbolic names so that proofs remain readable and refactorable.

## Do not write specs without a natural language block

Every spec file must include a natural language description before the theorem:

```lean
/-
natural language description:
    [What the function does in plain mathematical terms]

natural language specs:
    [Preconditions and postconditions in words]
-/
```

This block serves as documentation for reviewers and as a specification sanity check.
If you cannot state the spec in natural language, you do not yet understand the function
well enough to formalize it.

## Do not skip precondition bounds

```lean
-- WRONG: no preconditions (will fail on overflow)
@[progress]
theorem add_spec (a b : Array U64 5#usize) :
    ∃ result, add a b = ok result ∧ ... := by sorry

-- CORRECT: state the bounds that prevent overflow
@[progress]
theorem add_spec (a b : Array U64 5#usize)
    (ha : ∀ i < 5, a[i]!.val < 2 ^ 53)
    (hb : ∀ i < 5, b[i]!.val < 2 ^ 53) :
    ∃ result, add a b = ok result ∧ ... := by sorry
```

Without preconditions, the theorem is either unprovable (because overflow can occur)
or vacuously true (because the function returns an error). Both are useless. State
the bounds that the Rust code implicitly relies on.

## Do not mix element-wise and mathematical postconditions without both

A complete spec typically needs both layers:

```lean
-- Element-wise (needed by callers for their overflow analysis):
(∀ i < 5, result[i]!.val < 2 ^ 52) ∧
-- Mathematical (the actual correctness property):
Field51_as_Nat result % p = (Field51_as_Nat a + Field51_as_Nat b) % p
```

Omitting the element-wise bounds makes the spec unusable as a precondition for downstream
functions. Omitting the mathematical property makes the spec meaningless for correctness.

</anti_patterns>

<summary>
Specification conventions enforce a uniform structure across all proof files:
deterministic path mapping from Rust modules to Lean spec files, the `@[progress]` theorem
shape with existential result and conjunctive postconditions, project-specific interpretation
functions for bridging implementation-level values to mathematical ones, and explicit
precondition bounds (derived from Rust source analysis) that prevent overflow. Following
these conventions makes specs composable -- each proven theorem becomes a building block
that `progress` can automatically apply when verifying callers higher in the dependency
graph. Examples throughout this document are drawn from curve25519-dalek; your project's
types, constants, and interpretation functions will differ.
</summary>
