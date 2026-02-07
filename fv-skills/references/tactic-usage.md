<overview>

Tactics available for proving Aeneas-generated Lean 4 specifications. Ordered by
recommended try-order: start with `unfold` + `progress`, escalate to domain-specific
tactics, fall back to automation. Every tactic listed here exists in Lean 4 / Mathlib /
Aeneas and has been used in verified production proofs.

</overview>

<quick_reference>

## Tactic Quick Reference

| Tactic         | Purpose                                    | Phase         |
|----------------|--------------------------------------------|---------------|
| `unfold`       | Expand function definitions                | Setup         |
| `progress`     | Forward reasoning on Aeneas `Result` types | Core          |
| `progress*`    | Iterated progress until no more goals      | Core          |
| `simp`         | Simplification with lemma set              | Simplify      |
| `simp [*]`     | Simplify using all hypotheses              | Simplify      |
| `ring`         | Prove ring equalities                      | Arithmetic    |
| `omega`        | Linear arithmetic over Nat/Int             | Arithmetic    |
| `scalar_tac`   | Aeneas scalar bounds reasoning             | Bounds        |
| `field_simp`   | Clear denominators in field expressions    | Arithmetic    |
| `bvify`        | Lift Nat statements to bitvector form      | Bitwise       |
| `bv_decide`    | Decide bitvector propositions              | Bitwise       |
| `aesop`        | General-purpose automation                 | Automation    |
| `interval_cases` | Case-split on bounded naturals          | Case analysis |
| `subst_vars`   | Substitute all equality hypotheses         | Cleanup       |
| `grind`        | Heavy-duty rewriting and case analysis     | Automation    |
| `bound`        | Prove numeric bounds                       | Bounds        |
| `gcongr`       | Congruence for inequalities                | Arithmetic    |
| `decide`       | Decidable propositions (small instances)   | Automation    |

### Try-Order

1. `unfold` the function under verification
2. `progress` / `progress*` to step through Aeneas monadic code
3. `simp [*]` to simplify with local hypotheses
4. `scalar_tac` / `omega` for bounds and linear arithmetic
5. `ring` / `field_simp` for algebraic equalities
6. `bvify` + `bv_decide` for bitwise operations
7. `interval_cases` for bounded case splits
8. `grind` / `aesop` as last resort automation

</quick_reference>

<patterns>

## Pattern 1: Unfold Then Progress

The fundamental workflow for Aeneas-generated code. First `unfold` the Rust function
translation to expose monadic structure, then `progress` steps through each `Result`
bind, automatically applying `@[progress]` lemmas.

**When to use:** Every Aeneas spec proof starts this way.

**Real example** -- ClampInteger (scalar byte clamping):

```lean
-- From ClampInteger.lean: the core proof opens with unfold + progress*
@[progress]
theorem clamp_integer_spec (bytes : Array U8 32#usize) :
    exists result, clamp_integer bytes = ok (result) /\
    h | U8x32_as_Nat result /\
    U8x32_as_Nat result < 2^255 /\
    2^254 <= U8x32_as_Nat result := by
  unfold clamp_integer h
  progress*
  unfold U8x32_as_Nat
  refine <..., ..., ...>
```

**Key insight:** `progress*` iterates until all monadic steps resolve. After that,
remaining goals are pure math (bounds, divisibility, etc.).

**Real example** -- Reduce (limb carry propagation):

```lean
-- From Reduce.lean: unfold + progress* resolves all 5 carry steps at once
@[progress]
theorem reduce_spec (limbs : Array U64 5#usize) :
    exists result, reduce limbs = ok result /\
    (forall i < 5, result[i]!.val <= 2^51 + (2^13 - 1) * 19) /\
    Field51_as_Nat limbs === Field51_as_Nat result [MOD p] := by
  unfold reduce
  progress*
  -- After progress*, goals are pure arithmetic bounds
  . simp [*]; scalar_tac
```

---

## Pattern 2: Exploratory Tactics

Use `?`-suffixed tactics during development to discover which lemmas and rewrites
apply. Replace with concrete calls before finalizing.

**When to use:** Interactive proof development; never leave `?` tactics in final proofs.

**Exploratory variants:**

```lean
-- Discover what progress can apply
progress?

-- Find simplification lemmas
simp?

-- Search for automation paths
aesop?

-- Discover exact tactic calls
exact?
```

**Workflow:**
1. Write `simp?` in a goal
2. Lean reports: `Try this: simp only [Field51_as_Nat, Finset.sum_range_succ, p]`
3. Replace `simp?` with the concrete `simp only [...]` call

---

## Pattern 3: Bounds Proving with scalar_tac and omega

Aeneas proofs require showing that arithmetic operations do not overflow. `scalar_tac`
understands Aeneas scalar types (U8, U16, U32, U64, Usize) and their bounds.
`omega` handles pure linear arithmetic over Nat and Int.

**When to use:** Proving `x.val < 2^N`, overflow guards, array index validity.

**Real example** -- Sub.lean (limb bounds after bias addition):

```lean
-- From Sub.lean: proving addition does not overflow U64
have ha0_bound : a0.val + k.val <= U64.max := by
  have := h_bounds_a 0 (by simp); scalar_tac

-- Proving subtraction does not underflow
have ha0'_sub_bound : b0 <= a0'.val := by
  rw [ha0'_val, <- hb0]
  have := h_bounds_b 0 (by simp); scalar_tac
```

**Real example** -- Reduce.lean (post-carry bounds):

```lean
-- From Reduce.lean: each carry step leaves bounded residue
. simp [*]; scalar_tac
. simp [*]; scalar_tac
. simp [*]; scalar_tac
```

**Real example** -- ClampInteger.lean (lower bound via scalar_tac):

```lean
-- Proving 2^254 <= result after setting bit 254
. have : 64 <= ((bytes : List U8)[31] &&& 127 ||| 64) := Nat.right_le_or
  simp [Finset.sum_range_succ, *]
  scalar_tac
```

**Key insight:** Combine `have := h_bounds_X i (by simp)` to bring specific
bound hypotheses into scope, then `scalar_tac` closes the goal.

---

## Pattern 4: Bitwise Operations with bvify + bv_decide

Bitwise properties (AND, OR, shift, mask) are best handled by lifting to bitvectors
with `bvify`, then deciding with `bv_decide`. The `bvify` attribute
`Nat.dvd_iff_mod_eq_zero` enables automatic divisibility lifting.

**When to use:** Proving properties of `&&&`, `|||`, bit masks, divisibility by powers of 2.

**Real example** -- ClampInteger.lean (divisibility by cofactor h=8):

```lean
-- From ClampInteger.lean: proving byte AND 248 is divisible by 8
attribute [bvify_simps] Nat.dvd_iff_mod_eq_zero

. apply Finset.dvd_sum
  intro i hi
  by_cases hc : i = 0
  . subst_vars
    have (byte : U8) : 8 | (byte &&& 248#u8).val := by bvify 8; bv_decide
    simpa [*] using this _
  . have := List.mem_range.mp hi
    interval_cases i <;> omega
```

**Real example** -- ClampInteger.lean (upper bound via bv_decide):

```lean
-- Proving masked byte value is bounded
have : (bytes : List U8)[31].val &&& 127 ||| 64 <= 127 := by
  have h : ((bytes : List U8)[31].bv &&& 127 ||| 64) <= 127 := by bv_decide
  bound
```

**Key insight:** `bvify N` lifts to N-bit bitvectors. Use `bv_decide` for decidable
BV propositions. Combine with `bound` to bring results back to Nat.

---

## Pattern 5: Finset.sum Expansion and Reasoning

Multi-limb representations (Field51, U8x32) use `Finset.sum` over ranges. Proofs
require expanding sums into explicit limb terms, then reasoning per-limb.

**When to use:** Any proof involving `Field51_as_Nat`, `U8x32_as_Nat`, or similar
sum-of-limbs representations.

**Real example** -- Sub.lean (expanding 5-limb field element sum):

```lean
-- From Sub.lean: expand Finset.sum_range 5 into individual limbs
rw [Finset.sum_range_succ, Finset.sum_range_succ, Finset.sum_range_succ,
    Finset.sum_range_succ, Finset.sum_range_one,
    Finset.sum_range_succ, Finset.sum_range_succ, Finset.sum_range_succ,
    Finset.sum_range_succ, Finset.sum_range_one]
```

**Real example** -- Sub.lean (distributing addition over sum):

```lean
-- Distribute addition across limbs
simp only [<- Finset.sum_add_distrib, <- Nat.mul_add]
```

**Real example** -- Reduce.lean (modular congruence of sums):

```lean
-- From Reduce.lean: final modular equality of expanded sums
simp [Field51_as_Nat, Finset.sum_range_succ, p, Nat.ModEq, *]; omega
```

**Key insight:** After expanding, use `simp only` with distribution lemmas, then
reason about individual limb terms. For modular arithmetic, reduce to
`Nat.ModEq` and use `omega` on the expanded form.

</patterns>

<anti_patterns>

## Anti-Patterns

### 1. Never hallucinate lemma or tactic names

Lean 4 will fail silently or with cryptic errors if you reference nonexistent tactics.
Always verify a tactic exists before using it.

**Wrong:**
```lean
-- These do NOT exist
nat_decide  -- not a real tactic
scalar_simp  -- not a real tactic
progress_all  -- not a real tactic; use progress*
```

**Right:**
```lean
-- Verified existing tactics
scalar_tac   -- Aeneas bounds reasoning
simp [*]     -- simplification with hypotheses
progress*    -- iterated progress
```

### 2. Never use native_decide on large computations

`native_decide` compiles to native code and runs at elaboration time. On large
constants (2^255, field primes) it will time out or exhaust memory.

**Wrong:**
```lean
-- Will hang or OOM
theorem large_const : 2^255 - 19 > 0 := by native_decide
```

**Right:**
```lean
-- Use omega or norm_num for large numeric goals
theorem large_const : 2^255 - 19 > 0 := by omega
```

### 3. Never skip unfold before progress

`progress` operates on the monadic structure exposed by `unfold`. Without unfolding
the function definition first, `progress` has nothing to step through.

**Wrong:**
```lean
theorem spec : exists r, my_fn x = ok r := by
  progress  -- fails: my_fn is still opaque
```

**Right:**
```lean
theorem spec : exists r, my_fn x = ok r := by
  unfold my_fn
  progress
```

### 4. Never use simp alone when ring/omega would be more precise

`simp` can rewrite in unexpected ways and create hard-to-debug goal states. When the
goal is a pure algebraic equality or linear arithmetic, use the specialized tactic.

**Wrong:**
```lean
-- simp might rewrite too aggressively or fail
have : a * (b + c) = a * b + a * c := by simp
have : n + 1 > n := by simp
```

**Right:**
```lean
have : a * (b + c) = a * b + a * c := by ring
have : n + 1 > n := by omega
```

</anti_patterns>

<summary>

## Tactic Selection Flowchart

```
Goal type?
|
+-- Aeneas monadic code (Result, bind, ok)
|   --> unfold + progress / progress*
|
+-- Arithmetic bound (x < 2^N, x <= max)
|   +-- Involves Aeneas scalar types?
|   |   --> scalar_tac
|   +-- Pure Nat/Int linear arithmetic?
|       --> omega
|
+-- Algebraic equality (ring expression)
|   --> ring
|
+-- Bitwise property (AND, OR, shift, mask)
|   --> bvify + bv_decide
|
+-- Bounded natural case split (i < 5, i < 32)
|   --> interval_cases i <;> (simp [*]; scalar_tac)
|
+-- Modular arithmetic (x === y [MOD p])
|   --> unfold Nat.ModEq; simp [...]; omega
|
+-- Field expression with fractions
|   --> field_simp; ring
|
+-- Inequality congruence (a <= b --> f a <= f b)
|   --> gcongr
|
+-- Nothing else works
    --> grind / aesop (last resort)
```

</summary>
