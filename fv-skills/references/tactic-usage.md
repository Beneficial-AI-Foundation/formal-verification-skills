<overview>

Tactics available for proving Aeneas-generated Lean 4 specifications. Ordered by
recommended try-order: start with `step` to make progress on monadic code, use `agrind`
as the default general-purpose tactic, then escalate to domain-specific tactics. Every
tactic listed here exists in Lean 4 / Mathlib / Aeneas and has been used in verified
production proofs.

</overview>

<quick_reference>

## Tactic Quick Reference

| Tactic         | Purpose                                    | Phase         |
|----------------|--------------------------------------------|---------------|
| `unfold`       | Expand function definitions                | Setup         |
| `step`         | Forward reasoning on Aeneas `Result` types | Core          |
| `step*`        | Iterated step until no more goals          | Core          |
| `agrind`       | Fast general automation (always try first) | Automation    |
| `grind`        | Slower but more powerful than agrind       | Automation    |
| `simp`         | Simplification with lemma set              | Simplify      |
| `simp [*]`     | Simplify using all hypotheses              | Simplify      |
| `simp_scalar`  | Simplify scalar expressions                | Simplify      |
| `simp_lists`   | Simplify list/array/slice structural ops   | Simplify      |
| `simp_ifs`     | Simplify if-then-else exclusively          | Simplify      |
| `simp_bool_prop` | Bool/prop simplification                 | Simplify      |
| `ring`         | Prove ring equalities                      | Arithmetic    |
| `ring_eq_nf`   | Cancel common terms in equalities          | Arithmetic    |
| `scalar_tac`   | Aeneas scalar bounds reasoning             | Bounds        |
| `field_simp`   | Clear denominators in field expressions    | Arithmetic    |
| `bvify`        | Lift Nat statements to bitvector form      | Bitwise       |
| `bv_tac`       | BitVec decision procedure                  | Bitwise       |
| `fcongr`       | Congruence at reducible transparency       | Arithmetic    |
| `split_conjs`  | Split nested conjunctions                  | Structure     |
| `natify`       | Convert to Nat propositions                | Conversion    |
| `zmodify`      | Convert to ZMod propositions               | Conversion    |
| `interval_cases` | Case-split on bounded naturals           | Case analysis |
| `subst_vars`   | Substitute all equality hypotheses         | Cleanup       |
| `gcongr`       | Congruence for inequalities                | Arithmetic    |
| `bound`        | Prove numeric bounds                       | Bounds        |
| `decide`       | Decidable propositions (small instances)   | Automation    |

### Try-Order

1. `unfold` the function under verification
2. `step` / `step*` to step through Aeneas monadic code
3. `agrind` as the default general-purpose tactic (always try first)
4. `simp [*]` to simplify with local hypotheses
5. `scalar_tac` for Aeneas scalar bounds and arithmetic
6. `ring` / `field_simp` for algebraic equalities
7. `bvify` + `bv_tac` for bitwise operations
8. `interval_cases` for bounded case splits
9. `grind` as heavier automation (when agrind is insufficient)

</quick_reference>

<banned>

## BANNED Tactics

These tactics must NEVER be used in Aeneas proofs. They are non-idiomatic and produce
proofs that are incorrect, fragile, or unmaintainable.

| Banned              | Why                                                         | Use Instead (preference order)                  |
|---------------------|-------------------------------------------------------------|-------------------------------------------------|
| `omega`             | No scalar/Slice/Vec knowledge                               | `agrind` > `grind` > `scalar_tac`              |
| `linarith`          | No scalar/Slice/Vec knowledge                               | `agrind` > `grind` > `scalar_tac`              |
| `nlinarith`         | No scalar knowledge, explosion risk                         | `agrind` > `grind` > `scalar_tac +nonLin` / `simp_scalar` |
| `congr N`           | Default transparency causes heartbeat timeout               | `fcongr N` (reducible transparency, same subgoals) |
| `step* <;> ...`     | Replays full `step*` on every edit                          | `step*` then cdot tactic per goal               |
| `all_goals tactic`  | Same re-elaboration problem                                 | cdot tactic per goal                            |

**The first three tactics are NEVER acceptable in Aeneas proofs** -- not in `step`
theorems, not in helper lemmas, not in `have` steps, not in `decreasing_by` (even
for pure Nat). They cannot reason about U8, U32, Usize, Slice.length, etc.

**`step* <;>` and `all_goals` are NEVER acceptable either** -- they destroy
incrementality by forcing full re-elaboration on every edit. Always use focused
cdot blocks -- one per goal.

</banned>

<patterns>

## Pattern 1: Unfold Then Step

The fundamental workflow for Aeneas-generated code. First `unfold` the Rust function
translation to expose monadic structure, then `step` steps through each `Result`
bind, automatically applying `@[step]` lemmas.

**When to use:** Every Aeneas spec proof starts this way.

**Real example** -- ClampInteger (scalar byte clamping):

```lean
-- From ClampInteger.lean: the core proof opens with unfold + step*
@[step]
theorem clamp_integer_spec (bytes : Array U8 32#usize) :
    exists result, clamp_integer bytes = ok (result) /\
    h | U8x32_as_Nat result /\
    U8x32_as_Nat result < 2^255 /\
    2^254 <= U8x32_as_Nat result := by
  unfold clamp_integer h
  step*
  unfold U8x32_as_Nat
  refine <..., ..., ...>
```

**Key insight:** `step*` iterates until all monadic steps resolve. After that,
remaining goals are pure math (bounds, divisibility, etc.).

**Real example** -- Reduce (limb carry propagation):

```lean
-- From Reduce.lean: unfold + step* resolves all 5 carry steps at once
@[step]
theorem reduce_spec (limbs : Array U64 5#usize) :
    exists result, reduce limbs = ok result /\
    (forall i < 5, result[i]!.val <= 2^51 + (2^13 - 1) * 19) /\
    Field51_as_Nat limbs === Field51_as_Nat result [MOD p] := by
  unfold reduce
  step*
  -- After step*, goals are pure arithmetic bounds
  . simp [*]; scalar_tac
```

---

## Pattern 2: Exploratory Tactics

Use `?`-suffixed tactics during development to discover which lemmas and rewrites
apply. Replace with concrete calls before finalizing.

**When to use:** Interactive proof development; never leave `?` tactics in final proofs.

**Exploratory variants:**

```lean
-- Discover what step can apply
step*?

-- Find simplification lemmas
simp?

-- Discover exact tactic calls
exact?
```

**Workflow:**
1. Write `simp?` in a goal
2. Lean reports: `Try this: simp only [Field51_as_Nat, Finset.sum_range_succ, p]`
3. Replace `simp?` with the concrete `simp only [...]` call

---

## Pattern 3: Bounds Proving with scalar_tac

Aeneas proofs require showing that arithmetic operations do not overflow. `scalar_tac`
understands Aeneas scalar types (U8, U16, U32, U64, Usize) and their bounds.
Use `agrind` or `grind` as alternatives for general arithmetic.

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

## Pattern 4: Bitwise Operations with bvify + bv_tac

Bitwise properties (AND, OR, shift, mask) are best handled by lifting to bitvectors
with `bvify`, then deciding with `bv_tac`. The `bvify` attribute
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
    have (byte : U8) : 8 | (byte &&& 248#u8).val := by bvify 8; bv_tac 8
    simpa [*] using this _
  . have := List.mem_range.mp hi
    interval_cases i <;> scalar_tac
```

**Real example** -- ClampInteger.lean (upper bound via bv_tac):

```lean
-- Proving masked byte value is bounded
have : (bytes : List U8)[31].val &&& 127 ||| 64 <= 127 := by
  have h : ((bytes : List U8)[31].bv &&& 127 ||| 64) <= 127 := by bv_tac 8
  bound
```

**Key insight:** `bvify N` lifts to N-bit bitvectors. Use `bv_tac N` for decidable
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
simp [Field51_as_Nat, Finset.sum_range_succ, p, Nat.ModEq, *]; agrind
```

**Key insight:** After expanding, use `simp only` with distribution lemmas, then
reason about individual limb terms. For modular arithmetic, reduce to
`Nat.ModEq` and use `agrind` on the expanded form.

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
step_all  -- not a real tactic; use step*
```

**Right:**
```lean
-- Verified existing tactics
scalar_tac   -- Aeneas bounds reasoning
simp [*]     -- simplification with hypotheses
step*        -- iterated step
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
-- Use agrind or norm_num for large numeric goals
theorem large_const : 2^255 - 19 > 0 := by agrind
```

### 3. Never skip unfold before step

`step` operates on the monadic structure exposed by `unfold`. Without unfolding
the function definition first, `step` has nothing to step through.

**Wrong:**
```lean
theorem spec : exists r, my_fn x = ok r := by
  step  -- fails: my_fn is still opaque
```

**Right:**
```lean
theorem spec : exists r, my_fn x = ok r := by
  unfold my_fn
  step
```

### 4. Never use simp alone when ring/agrind would be more precise

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
have : n + 1 > n := by agrind
```

</anti_patterns>

<summary>

## Tactic Selection Flowchart

```
Goal type?
|
+-- Aeneas monadic code (Result, bind, ok)
|   --> unfold + step / step*
|
+-- Arithmetic bound (x < 2^N, x <= max)
|   +-- Involves Aeneas scalar types?
|   |   --> scalar_tac
|   +-- General arithmetic?
|       --> agrind (first) > grind > scalar_tac
|
+-- Algebraic equality (ring expression)
|   --> ring
|
+-- Bitwise property (AND, OR, shift, mask)
|   --> bvify + bv_tac
|
+-- Bounded natural case split (i < 5, i < 32)
|   --> interval_cases i <;> (simp [*]; scalar_tac)
|
+-- Modular arithmetic (x === y [MOD p])
|   --> zmodify; ring / simp
|
+-- Field expression with fractions
|   --> field_simp; ring
|
+-- Inequality congruence (a <= b --> f a <= f b)
|   --> gcongr
|
+-- List/Array/Slice structural ops
|   --> simp_lists
|
+-- Scalar simplification (min, max, %)
|   --> simp_scalar
|
+-- If-then-else
|   --> simp_ifs
|
+-- Nested conjunctions
|   --> split_conjs <;> agrind
|
+-- Nothing else works
    --> agrind (first) > grind (last resort)
```

</summary>
