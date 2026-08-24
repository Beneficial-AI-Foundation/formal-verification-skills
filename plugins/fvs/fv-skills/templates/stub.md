# Natural Language Stub Template

Template for `stubs/{module_path}/{function_name}.md`

<template>
# {Module Path} -- {Function Name}

## Module Context
**Module:** `{rust_module_path}`
**Purpose:** {what the module does in the larger crate}
**Data flow:** {how data enters and exits this module}
**Placement:** {where this module sits in the call hierarchy}

---

## Function: `{function_name}`
**Signature:** `{rust_signature}`
**Lean extraction:** `{lean_function_name}`
**Source:** `{rust_file_path}:{line_range}`

### What It Does
{Algorithmic description of the function in plain English. Describe the
computation step by step, not just "it subtracts two field elements" but
HOW it performs the subtraction at the limb level.}

### Preconditions
{What must be true of inputs for the function to execute correctly.
Include type-level constraints (array lengths), value-level constraints
(limb bounds), and semantic constraints (valid field element).}

### Postconditions
{What is guaranteed about the output. Include both computational
properties (output bounds) and mathematical properties (modular
equivalence). State both the informal and formal versions.}

### Bounds Reasoning
{Why overflow and underflow cannot occur given the preconditions. Walk
through the worst-case arithmetic for each operation. This is the most
critical section for proof development -- it tells you what bounds to
carry through the proof.}

### Mathematical Meaning
{Bridge between the code and the mathematical object it implements.
Map the array representation to the mathematical value via interpretation
functions. State the core theorem in both English and symbolic notation.}
</template>

<guidelines>
## How to Fill Each Section

### Module Context
Read the Rust module (the .rs file containing the function) and summarize:
  - **Module**: Full Rust path, e.g. `curve25519_dalek::backend::serial::u64::field`
  - **Purpose**: What this module provides to the crate (e.g. "FieldElement51
    arithmetic for the u64 backend")
  - **Data flow**: Where inputs come from and where outputs go. For field
    arithmetic, inputs are field elements from point operations; outputs
    feed back into point operations.
  - **Placement**: Leaf module (no further delegation) vs orchestrator
    (calls into sub-modules). This helps scope the verification effort.

### Function: header fields
  - **Signature**: Copy the Rust signature verbatim including generics and
    trait bounds. Include `&self` or `self` if it is a method.
  - **Lean extraction**: The function name in Funs.lean after Aeneas extraction.
    Check Funs.lean directly -- Aeneas may rename or flatten trait impls.
  - **Source**: Exact file path and line range for quick reference.

### What It Does
Describe the algorithm, not just the purpose. For FieldElement51::sub:
  - BAD: "Subtracts two field elements"
  - GOOD: "Adds a bias of 16p (split across 5 limbs as [k, j, j, j, j])
    to the first operand, then subtracts the second operand limb-by-limb,
    then calls reduce to bring limbs back under 2^52"

### Preconditions
Map to Lean hypothesis names and types:
  - "Limbs of a must be < 2^63" -> `h_bounds_a : forall i < 5, a[i]!.val < 2 ^ 63`
  - "Limbs of b must be < 2^54" -> `h_bounds_b : forall i < 5, b[i]!.val < 2 ^ 54`
Include both the informal description and the formal hypothesis.

### Postconditions
State two kinds of postconditions:
  1. **Structural**: output bounds, array lengths, type constraints
  2. **Semantic**: the mathematical property (modular equivalence, etc.)
Map each to the Lean conjunct in the spec theorem.

### Bounds Reasoning
This section is the "proof sketch" for the bounds portion. Walk through:
  - What is the maximum value of each intermediate computation?
  - Why does each U64 addition not overflow?
  - Why does each U64 subtraction not underflow?
  - What are the output bounds after reduction?
This directly informs the `have` statements and `scalar_tac` calls in the proof.

### Mathematical Meaning
Connect code to math using interpretation functions from Defs.lean:
  - Field51_as_Nat: sum_{i=0}^{4} 2^{51*i} * limbs[i]
  - Explain why the code computation equals the mathematical operation
  - State the core modular identity that the spec theorem proves
</guidelines>

<evolution>
## Stub File Lifecycle

1. **Initial creation**: Generated when a function is selected for
   verification. Contains best-effort analysis from reading the Rust
   source. The Bounds Reasoning section may have gaps marked with TODO.

2. **Refined during spec writing**: As the spec theorem is drafted, the
   stub is updated to reflect the actual preconditions and postconditions
   chosen. Bounds that were estimated get precise values.

3. **Updated during proof**: Proof development often reveals tighter
   bounds or additional preconditions. The stub is updated to match
   the proven theorem statement.

4. **Maintained on re-extraction**: When Aeneas re-extracts after Rust
   changes, the stub is reviewed. The Lean extraction name may change,
   intermediate computations may differ, and bounds may need rechecking.

Stubs are living documents. They are not throwaway scaffolding -- they
serve as the bridge between Rust understanding and Lean verification
throughout the project lifetime.
</evolution>

<example>
## Worked Example: FieldElement51::sub

# backend.serial.u64.field -- sub

## Module Context
**Module:** `curve25519_dalek::backend::serial::u64::field`
**Purpose:** Implements FieldElement51 arithmetic (add, sub, mul, square, pow,
invert, reduce) for the u64 backend of curve25519-dalek. Each field element is
represented as 5 u64 limbs, each holding up to 51 bits of the 255-bit value.
**Data flow:** Field elements are created from byte arrays during point
decoding, used in point arithmetic (add, double, mul), and serialized back
to bytes for output. All intermediate computations stay in limb form.
**Placement:** Leaf arithmetic module. Called by point operation modules
(edwards, montgomery). Does not delegate to sub-modules except for `reduce`
which is an internal helper.

---

## Function: `sub`
**Signature:** `fn sub(self, rhs: FieldElement51) -> FieldElement51`
**Lean extraction:** `curve25519_dalek.backend.serial.u64.field.SubShared0FieldElement51SharedAFieldElement51FieldElement51.sub`
**Source:** `curve25519-dalek/src/backend/serial/u64/field.rs:120-138`

### What It Does
Computes the field subtraction a - b (mod p) where p = 2^255 - 19.

To avoid underflow when subtracting unsigned limbs, the function first adds a
bias value of 16p to the first operand, split across the 5 limbs:
  - Limb 0: add k = 36028797018963664  (16p contribution to limb 0)
  - Limbs 1-4: add j = 36028797018963952  (16p contribution to limbs 1-4)

Then it subtracts the second operand limb-by-limb:
  - result[i] = (a[i] + bias[i]) - b[i]

Finally it calls `reduce` to bring all limbs back under 2^52 by carrying
overflow bits from each limb to the next (with wraparound from limb 4 to
limb 0 scaled by 19, since 2^255 = 19 mod p).

### Preconditions
- Both inputs are arrays of 5 u64 values: `a b : Array U64 5#usize`
- Limbs of a must allow addition with bias without u64 overflow:
  `h_bounds_a : forall i < 5, a[i]!.val < 2 ^ 63`
- Limbs of b must be small enough that subtraction after bias does not underflow:
  `h_bounds_b : forall i < 5, b[i]!.val < 2 ^ 54`

The precise bounds are: a[0] <= 2^64 - 1 - k, a[1..4] <= 2^64 - 1 - j,
b[0] <= k, b[1..4] <= j. The simpler 2^63 and 2^54 bounds are strictly
tighter but much easier to work with in proofs.

### Postconditions
1. **Output bounds**: All limbs of the result are < 2^52
   `forall i < 5, d[i]!.val < 2 ^ 52`
2. **Modular correctness**: The result represents a - b mod p
   `(Field51_as_Nat d + Field51_as_Nat b) % p = Field51_as_Nat a % p`
   (equivalently: Field51_as_Nat d = Field51_as_Nat a - Field51_as_Nat b mod p)

### Bounds Reasoning
**Addition phase (a[i] + bias[i]):**
  - Worst case limb 0: a[0] < 2^63, k ~ 2^55, sum < 2^63 + 2^55 < 2^64. No overflow.
  - Worst case limbs 1-4: a[i] < 2^63, j ~ 2^55, sum < 2^63 + 2^55 < 2^64. No overflow.

**Subtraction phase ((a[i] + bias[i]) - b[i]):**
  - Worst case limb 0: bias k ~ 2^55, b[0] < 2^54 < k. No underflow.
  - Worst case limbs 1-4: bias j ~ 2^55, b[i] < 2^54 < j. No underflow.

**After reduce:**
  - reduce guarantees all output limbs < 2^52.
  - reduce preserves the value modulo p (proven in Reduce.lean).

**Why 16p?**
  - p = 2^255 - 19, in limb form p ~ [2^51 - 19, 2^51 - 1, 2^51 - 1, 2^51 - 1, 2^51 - 1]
  - 16p in limbs: k = 16 * (2^51 - 19) = 36028797018963664, j = 16 * (2^51 - 1) = 36028797018963952
  - Both k and j are ~ 2^55, comfortably above 2^54 (the b bound) and below 2^56

### Mathematical Meaning
A FieldElement51 `a = [a0, a1, a2, a3, a4]` represents the natural number:

  Field51_as_Nat(a) = sum_{i=0}^{4} 2^{51*i} * a[i]

The field element value is Field51_as_Nat(a) mod p where p = 2^255 - 19.

The sub function computes:
  Field51_as_Nat(result) = Field51_as_Nat(a) + 16p - Field51_as_Nat(b)  (before reduce)

Since 16p = 0 mod p, this gives:
  Field51_as_Nat(result) mod p = (Field51_as_Nat(a) - Field51_as_Nat(b)) mod p

The spec theorem states this as:
  (Field51_as_Nat(d) + Field51_as_Nat(b)) % p = Field51_as_Nat(a) % p

which avoids natural number subtraction (always non-negative in Lean's Nat).
</example>
