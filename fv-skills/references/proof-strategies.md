<overview>

Common proof strategies for verifying Aeneas-generated Lean 4 code from Rust. Each
strategy addresses a recurring proof pattern. While examples are drawn from cryptographic
code (curve25519-dalek), the strategies apply to any Rust code verified through Aeneas.
Strategies are ordered from simplest to most complex; start with the easiest applicable
strategy.

</overview>

<quick_reference>

## Strategy Quick Reference

| Strategy                | When to Use                                      | Difficulty |
|-------------------------|--------------------------------------------------|------------|
| Case splitting          | Bounded index, enum, boolean conditions          | Low        |
| Bounds propagation      | Overflow/underflow guards, limb bounds           | Low-Medium |
| Modular arithmetic      | Field element equivalence mod p                  | Medium     |
| Carry chain reasoning   | Multi-limb reduce/propagate operations           | Medium     |
| Multi-coordinate specs  | Point operations with 4-5 field element outputs  | Medium     |
| Sum decomposition       | Proving properties of sum-of-limbs encodings     | Medium     |
| Bias-then-subtract      | Subtraction that adds multiples of p to avoid underflow | High  |
| Algebraic bridging      | Connecting implementation to mathematical spec   | High       |

</quick_reference>

<patterns>

## Pattern 1: Case Splitting with interval_cases

When a proof goal depends on a bounded index or small finite domain, split into
concrete cases and discharge each independently.

**When to use:** Goals with `i < N` for small N, boolean conditions, enum variants.

**Real example** -- ClampInteger.lean (proving divisibility for each byte index):

```lean
-- From ClampInteger.lean: divisibility of each term in Finset.sum
-- The sum over 32 bytes needs per-index reasoning
. apply Finset.dvd_sum
  intro i hi
  by_cases hc : i = 0
  . subst_vars
    have (byte : U8) : 8 | (byte &&& 248#u8).val := by bvify 8; bv_decide
    simpa [*] using this _
  . have := List.mem_range.mp hi
    interval_cases i <;> omega
```

**Key insight:** `interval_cases i` generates one goal per value. Combine with
`<;>` to apply the same closing tactic to all cases. For i=0 (special case),
handle separately with `by_cases` before `interval_cases` on the rest.

**Real example** -- Reduce.lean (per-limb bounds after carry propagation):

```lean
-- From Reduce.lean: show all 5 result limbs satisfy the bound
. intro i _
  interval_cases i
  all_goals simp [*]; scalar_tac
```

**Pattern:** `intro i hi; interval_cases i; all_goals tactic` handles finite
quantifiers like `forall i < 5, P i`.

---

## Pattern 2: Bounds Propagation

Thread bounds hypotheses through a chain of operations, showing each intermediate
result stays within type limits. Essential for proving no-panic (overflow safety).

**When to use:** Any proof where `Result` operations can fail on overflow.

**Real example** -- Sub.lean (5-limb subtraction with bias):

```lean
-- From Sub.lean: propagate bounds through add-then-subtract per limb
-- Step 1: Bring specific bound into scope
have ha0_bound : a0.val + k.val <= U64.max := by
  have := h_bounds_a 0 (by simp); scalar_tac

-- Step 2: Use Aeneas spec to get success + value equation
obtain <a0', ha0'_ok, ha0'_val> := U64.add_spec ha0_bound
simp only [ha0'_ok, bind_tc_ok]

-- Step 3: Prove next operation's precondition from previous result
have ha0'_sub_bound : b0 <= a0'.val := by
  rw [ha0'_val, <- hb0]
  have := h_bounds_b 0 (by simp); scalar_tac

-- Step 4: Use subtraction spec
obtain <i3, hi3_ok, hi3_val, hi3_val'> := U64.sub_spec ha0'_sub_bound
simp only [hi3_ok, bind_tc_ok]
```

**Key pattern:**
1. `have := h_bounds_X i (by simp)` -- instantiate universal bound at specific index
2. `scalar_tac` -- close the arithmetic bound goal
3. `obtain` with Aeneas spec -- get result + equations
4. Repeat for next operation

This pattern repeats for each limb (0 through 4 in Sub.lean, producing variables
i3, i7, i11, i15, i19 for the 5 result limbs).

---

## Pattern 3: Modular Arithmetic via Nat.ModEq

Field element operations preserve equivalence modulo prime p. Prove the implementation
result is congruent to the mathematical specification mod p.

**When to use:** Any field operation (add, sub, mul, reduce) where the spec states
`result % p = expected % p`.

**Real example** -- Sub.lean (field subtraction mod p):

```lean
-- From Sub.lean: prove (result + b) === a [MOD p]
-- Strategy: show bias constants sum to 0 mod p

-- Step 1: Reduce through intermediate representation
have htmp : Field51_as_Nat d + Field51_as_Nat b ===
  Field51_as_Nat (Array.make 5#usize [i3, i7, i11, i15, i19]) +
  Field51_as_Nat b [MOD p] := by
  apply Nat.ModEq.add_right; apply Nat.ModEq.symm; exact hreduce_eq
apply Nat.ModEq.trans htmp

-- Step 2: Show bias constants are divisible by p
set kjsum := 2^(51*0) * k.val + 2^(51*1) * j.val + ... with hkjsum
have kmod0 : kjsum === 0 [MOD p] := by
  rw [Nat.modEq_zero_iff_dvd]
  rw [hkjsum, hk, hj, p]
  simp

-- Step 3: Adding zero mod p preserves residue
have final := Nat.ModEq.add_left asum kmod0
simp only [add_zero] at final
exact final
```

**Key techniques:**
- `Nat.ModEq.add_right` / `Nat.ModEq.add_left` -- congruence of addition
- `Nat.ModEq.trans` -- chain congruences
- `Nat.modEq_zero_iff_dvd` -- convert `x === 0 [MOD p]` to `p | x`
- `Nat.ModEq.symm` -- reverse direction

**Real example** -- Reduce.lean (carry preserves value mod p):

```lean
-- From Reduce.lean: the entire modular congruence in one line
simp [Field51_as_Nat, Finset.sum_range_succ, p, Nat.ModEq, *]; omega
```

When the carry structure is simple enough, expanding definitions and using `omega`
on the resulting linear arithmetic suffices.

---

## Pattern 4: Carry Chain Reasoning

Multi-limb arithmetic produces carries that propagate from limb to limb. The
`reduce` function is the canonical example: extract carry from each limb, add it
to the next, and wrap the final carry back with a multiplier (19 for Curve25519).

**When to use:** Any function that normalizes limb representations (reduce, carry
propagation, schoolbook multiply output normalization).

**Real example** -- Reduce.lean (5-limb carry chain):

```lean
-- From Reduce.lean: unfold + progress* resolves the entire carry chain
@[progress]
theorem reduce_spec (limbs : Array U64 5#usize) :
    exists result, reduce limbs = ok result /\
    (forall i < 5, result[i]!.val <= 2^51 + (2^13 - 1) * 19) /\
    Field51_as_Nat limbs === Field51_as_Nat result [MOD p] := by
  unfold reduce
  progress*
  -- progress* steps through: extract carry0, mask limb0,
  -- add carry0 to limb1, extract carry1, mask limb1, ...
  -- Each remaining goal is a bounds obligation:
  . simp [*]; scalar_tac   -- carry0 bound
  . simp [*]; scalar_tac   -- carry1 bound
  . simp [*]; scalar_tac   -- carry2 bound
  . simp [*]; scalar_tac   -- carry3 bound
  . simp [*]; scalar_tac   -- carry4 bound (wraps with *19)
```

**Structure of carry chain proofs:**
1. `unfold` + `progress*` resolves all monadic steps
2. Each carry step produces a bounds obligation: `simp [*]; scalar_tac`
3. Final goal: universal bound on all output limbs uses `interval_cases`
4. Modular congruence: `simp [Field51_as_Nat, ...]; omega`

**Why this works:** The `@[progress]` attribute on helper specs (like mask and
shift operations) lets `progress*` automatically chain through the carry pipeline.
The attribute `[scalar_tac_simps] LOW_51_BIT_MASK_val_eq` teaches `scalar_tac`
about the mask constant.

---

## Pattern 5: Multi-Coordinate Specs

Point operations (addition, doubling, conversion) produce multiple field element
outputs. The spec states properties of each coordinate separately.

**When to use:** Any function returning a struct with multiple field element
coordinates (EdwardsPoint, CompletedPoint, ProjectivePoint).

**Real example** -- AsExtended.lean (completed to extended point conversion):

```lean
-- From AsExtended.lean: 4-coordinate output, each with modular spec
@[progress]
theorem as_extended_spec (q : CompletedPoint)
  (h_qX_bounds : forall i, i < 5 -> (q.X[i]!).val < 2 ^ 54)
  (h_qY_bounds : forall i, i < 5 -> (q.Y[i]!).val < 2 ^ 54)
  (h_qZ_bounds : forall i, i < 5 -> (q.Z[i]!).val < 2 ^ 54)
  (h_qT_bounds : forall i, i < 5 -> (q.T[i]!).val < 2 ^ 54) :
exists e,
as_extended q = ok e /\
let X := Field51_as_Nat q.X
let Y := Field51_as_Nat q.Y
let Z := Field51_as_Nat q.Z
let T := Field51_as_Nat q.T
let X' := Field51_as_Nat e.X
let Y' := Field51_as_Nat e.Y
let Z' := Field51_as_Nat e.Z
let T' := Field51_as_Nat e.T
X' % p = (X * T) % p /\
Y' % p = (Y * Z) % p /\
Z' % p = (Z * T) % p /\
T' % p = (X * Y) % p
:= by
  unfold as_extended
  progress*
  rw [<- Nat.ModEq, <- Nat.ModEq, <- Nat.ModEq, <- Nat.ModEq]
  simp_all
```

**Key structure:**
1. **Preconditions:** Bounds on every coordinate of every input point
2. **Postconditions:** Conjunction of per-coordinate modular equalities
3. **Proof:** `unfold` + `progress*` resolves all field multiplications (using
   `@[progress]` attributed `mul_spec`), then `simp_all` closes modular goals

**Pattern for bounds preconditions:**
```lean
-- Each coordinate needs its own universal bound hypothesis
(h_X_bounds : forall i, i < 5 -> (pt.X[i]!).val < 2 ^ 54)
```
The bound `2^54` is typical for reduced field elements (each limb < 2^51 plus
small carry margin).

</patterns>

<anti_patterns>

## Anti-Patterns

### 1. Don't attempt to prove everything in one step

Complex proofs need decomposition. A single `simp_all` or `aesop` call on a
multi-limb arithmetic proof will time out or produce an unreadable proof state.

**Wrong:**
```lean
theorem sub_spec ... := by
  unfold sub; simp_all  -- times out on 5-limb arithmetic
```

**Right:**
```lean
theorem sub_spec ... := by
  unfold sub
  -- Handle each limb sequentially
  -- Limb 0
  obtain <a0, ha0_ok> := Array.index_usize_spec a 0#usize hlen_a0
  ...
```

### 2. Don't forget intermediate lemmas (have blocks)

Bring bounds and equalities into scope with `have` before using them. Without
explicit intermediate results, `scalar_tac` and `omega` cannot see the needed
hypotheses.

**Wrong:**
```lean
-- scalar_tac cannot find the bound hypothesis
obtain <r, hr_ok, hr_val> := U64.add_spec (by scalar_tac)  -- fails
```

**Right:**
```lean
-- Explicit have makes the bound available
have h_bound : a.val + b.val <= U64.max := by
  have := h_bounds 0 (by simp); scalar_tac
obtain <r, hr_ok, hr_val> := U64.add_spec h_bound
```

### 3. Don't ignore carry propagation

When verifying functions that produce multi-limb results, the carry from each
limb affects the next. Skipping carry reasoning produces incorrect bounds on
later limbs.

**Wrong:**
```lean
-- Assuming each output limb independently bounded
have : result[3]!.val < 2^51 := by scalar_tac  -- wrong: ignores carry from limb 2
```

**Right:**
```lean
-- Let progress* thread carries through, then prove bounds per-goal
unfold reduce
progress*
-- Each goal now correctly accounts for carry from previous limb
. simp [*]; scalar_tac
```

### 4. Don't use overpowered tactics when simpler ones suffice

Using `grind` or `aesop` when `omega` or `ring` would close the goal produces
slower, less maintainable proofs that may break on Lean version upgrades.

**Wrong:**
```lean
have : a + b = b + a := by grind  -- overkill
have : n < n + 1 := by aesop      -- overkill
```

**Right:**
```lean
have : a + b = b + a := by ring
have : n < n + 1 := by omega
```

</anti_patterns>

<summary>

## Strategy Selection Guide

```
What does the function do?
|
+-- Single scalar/byte operation (clamp, mask, shift)
|   --> Case splitting (Pattern 1) + Bitwise (bvify/bv_decide)
|
+-- Limb-by-limb arithmetic (add bias, subtract)
|   --> Bounds propagation (Pattern 2)
|   --> Per-limb reasoning with explicit obtain chains
|
+-- Carry/reduce normalization
|   --> Carry chain (Pattern 4)
|   --> unfold + progress* for monadic chain
|   --> simp [*]; scalar_tac for each carry bound
|
+-- Field operation with modular spec (sub mod p, mul mod p)
|   --> Modular arithmetic (Pattern 3)
|   --> Nat.ModEq lemmas + bias cancellation
|
+-- Multi-output point operation (add, double, convert)
|   --> Multi-coordinate (Pattern 5)
|   --> Per-coordinate modular equality
|   --> Relies on @[progress] attributed sub-specs

Proof complexity hierarchy:
  Simple:  unfold + progress* + simp [*]; scalar_tac
  Medium:  + explicit obtain chains + interval_cases
  Complex: + Nat.ModEq chains + Finset.sum expansion + have blocks
```

</summary>
