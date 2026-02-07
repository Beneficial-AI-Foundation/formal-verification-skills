/- Spec File Template

Template for Specs/{ModulePath}/{FunctionName}.lean

<template>
/-
Copyright (c) {YEAR} {COPYRIGHT_HOLDER}. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Authors: {AUTHORS}
-/
import {PROJECT}.Funs
import {PROJECT}.Defs
{ADDITIONAL_IMPORTS}

/-! # Spec Theorem for `{RUST_TYPE}::{RUST_FUNCTION}`

Specification and proof for `{RUST_TYPE}::{RUST_FUNCTION}`.

{DESCRIPTION}

**Source**: {RUST_CRATE}/src/{RUST_MODULE_PATH}:{LINE_RANGE}

-/

open Aeneas.Std Result
namespace {LEAN_NAMESPACE}
{OPEN_STATEMENTS}

/-
natural language description:

    {NL_DESCRIPTION}

natural language specs:

    {NL_SPECS}
-/

/-- **Spec and proof concerning `{LEAN_FUNCTION_PATH}`**:
- {POSTCONDITION_SUMMARY_1}
- {POSTCONDITION_SUMMARY_2}
- Requires: {PRECONDITION_SUMMARY}
-/
@[progress]
theorem {FUNCTION_NAME}_spec ({PARAMS})
    ({PRECONDITIONS}) :
    {EXISTS_RESULT} {LEAN_FUNCTION_CALL} = ok {RESULT_BINDING} {AND}
    {POSTCONDITIONS} := by
  sorry

end {LEAN_NAMESPACE}
</template>

<guidelines>
## How to Fill Each Section

### Determining {PROJECT}
The Lean project name from lakefile.toml (e.g., `Curve25519Dalek`, `MyProject`).
Import paths are typically {PROJECT}.Funs and {PROJECT}.{DefsFile} where the
definitions file name is project-specific.

### {LEAN_NAMESPACE}
Convert the Rust module path to Lean namespace form:
  Rust: my_crate::my_module::MyType::my_function
  Lean namespace: my_crate.my_module.{AeneasGeneratedName}
The namespace for trait-impl functions uses the auto-generated Aeneas name
(check Funs.lean for the exact name).

### {OPEN_STATEMENTS}
Open any parent namespaces needed to bring helper definitions into scope.
Common pattern: `open {parent_namespace}` when the spec depends on
project-specific definitions from the parent module.

### Path Mapping (Rust to Lean directory)
Rules:
  - Module path segments become TitleCase directory names
  - Struct/type names become TitleCase directory names
  - Function name becomes TitleCase filename (mul_base -> MulBase.lean)
Example: `src/backend/field.rs::MyType::add` -> `Specs/Backend/Field/MyType/Add.lean`

### {PARAMS} (Parameters)
Map Rust types to Lean/Aeneas types. Common mappings:
  - Fixed-size arrays  -> (a : Array U64 N#usize)
  - &[u8; N]           -> (bytes : Array U8 N#usize)
  - u64 / u32 / u8     -> (x : U64) / (x : U32) / (x : U8)
  - bool               -> (b : Bool)
  - Self methods: self becomes the first parameter
Project-specific struct types are mapped by Aeneas in Types.lean.

### {PRECONDITIONS}
Hypotheses about input bounds, derived from careful Rust source analysis
(see lean-spec-conventions.md, "Choosing bound values"). Common patterns:
  - Array element bounds: (h_bounds : forall i < N, a[i]!.val < 2 ^ K)
  - Scalar bounds: (h_bound : x.val < LIMIT)
  - Non-zero: (h_nz : x.val != 0)
Name preconditions h_bounds_a, h_bounds_b, etc. for clarity.

### {POSTCONDITIONS}
Properties the result must satisfy. Common patterns:
  - Element-wise bounds: (forall i < N, result[i]!.val < 2 ^ K)
  - Mathematical via interpretation function: InterpFn result % C = expected % C
  - Boolean: result.val = 1#u8 <-> condition
Use project-specific interpretation functions and constants from the definitions file.

### Natural Language Block
The NL description and specs are critical for guiding proof development.
  - Description: what the function does in algorithmic terms
  - Specs: the mathematical property being verified, written in plain English
    with symbolic notation for precision
</guidelines>

<evolution>
## Spec File Lifecycle

1. **sorry phase**: Initial skeleton with `sorry` placeholder.
   The spec theorem statement is written, preconditions and postconditions
   are defined, but the proof body is just `sorry`.

2. **proof phase**: Replace `sorry` with actual tactic proof.
   Common tactics: progress, unfold, simp, ring, field_simp, omega,
   scalar_tac, grind. Use `progress` to step through Aeneas-generated
   function definitions.

3. **refined phase**: Tighten bounds, add helper lemmas, split into
   sub-theorems. The spec may need adjustment as proof development
   reveals tighter or different postconditions.

4. **re-extraction**: When Rust source changes and Aeneas re-extracts
   Types.lean/Funs.lean, the spec may break. Update the theorem
   statement to match new extraction. NEVER edit Types.lean or Funs.lean
   directly -- they are auto-generated.
</evolution>

<example>
## Worked Example: FieldElement51::sub

Rust function: curve25519-dalek/src/backend/serial/u64/field.rs
Lean spec file: Specs/Backend/Serial/U64/Field/FieldElement51/Sub.lean

/-
Copyright (c) 2025 Beneficial AI Foundation. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Authors: Markus Dablander, Hoang Le Truong
-/
import Curve25519Dalek.Funs
import Curve25519Dalek.Defs
import Curve25519Dalek.Specs.Backend.Serial.U64.Field.FieldElement51.Reduce
import Mathlib.Data.Nat.ModEq

/-! # Spec Theorem for `FieldElement51::sub`

Specification and proof for `FieldElement51::sub`.

This function performs field element subtraction. To avoid underflow, a multiple
of p is added.

Source: curve25519-dalek/src/backend/serial/u64/field.rs

-/

open Aeneas.Std Result
namespace curve25519_dalek.backend.serial.u64.field.SubShared0FieldElement51SharedAFieldElement51FieldElement51
open curve25519_dalek.backend.serial.u64.field.FieldElement51

/-
natural language description:

    Takes two input FieldElement51s a and b and returns another FieldElement51 d
    that is a representant of the difference a - b in the field (modulo p = 2^255 - 19).

    The implementation adds a multiple of p (namely 16p) as a bias value to a before
    subtraction is performed to avoid underflow: computes (a + 16*p) - b, then reduces

natural language specs:

    For appropriately bounded FieldElement51s a and b:
    Field51_as_Nat(sub(a, b)) = Field51_as_Nat(a) - Field51_as_Nat(b) (mod p), or equivalently
    Field51_as_Nat(sub(a, b)) + Field51_as_Nat(b) = Field51_as_Nat(a) (mod p)
-/

@[progress]
theorem sub_spec (a b : Array U64 5#usize)
    (h_bounds_a : forall i < 5, a[i]!.val < 2 ^ 63)
    (h_bounds_b : forall i < 5, b[i]!.val < 2 ^ 54) :
    exists d, sub a b = ok d /\
    (forall i < 5, d[i]!.val < 2 ^ 52) /\
    (Field51_as_Nat d + Field51_as_Nat b) % p = Field51_as_Nat a % p := by
  sorry -- proof omitted for template; see Sub.lean for full proof

end curve25519_dalek.backend.serial.u64.field.SubShared0FieldElement51SharedAFieldElement51FieldElement51

Key observations from this example:
  - Namespace matches the Aeneas-generated trait impl name
  - `open` brings parent namespace definitions (reduce_spec) into scope
  - Preconditions use simple power-of-2 bounds (2^63, 2^54)
  - Postconditions combine output bounds AND mathematical property
  - Mathematical property uses modular arithmetic via Field51_as_Nat and p
  - NL block describes both the algorithm AND the formal property
</example>
-/
