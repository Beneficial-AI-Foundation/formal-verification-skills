<overview>

Common proof strategies for verifying Aeneas-generated Lean 4 code from Rust. Each
strategy addresses a recurring proof pattern. While examples are drawn from cryptographic
code (curve25519-dalek), the strategies apply to any Rust code verified through Aeneas.
Strategies are ordered from simplest to most complex; start with the easiest applicable
strategy.

</overview>

<quick_reference>

## Strategy Quick Reference

| Strategy                         | When to Use                                      | Difficulty |
|----------------------------------|--------------------------------------------------|------------|
| Case splitting                   | Bounded index, enum, boolean conditions          | Low        |
| Bounds propagation               | Overflow/underflow guards, limb bounds           | Low-Medium |
| The step*? workflow              | Generating and refining expanded proof scripts   | Low-Medium |
| Modular arithmetic               | Field element equivalence mod p                  | Medium     |
| Carry chain reasoning            | Multi-limb reduce/propagate operations           | Medium     |
| WP.spec_mono                     | Strengthening postconditions from spec_gen       | Medium     |
| Canonical loop proof             | Any loop: spec_gen/spec/top-level pattern        | Medium     |
| Multi-coordinate specs           | Point operations with 4-5 field element outputs  | Medium     |
| Sum decomposition                | Proving properties of sum-of-limbs encodings     | Medium     |
| Termination pitfall workaround   | Recursive functions, loop induction              | Medium     |
| Bias-then-subtract               | Subtraction that adds multiples of p             | High       |
| Function fold decomposition      | Functions with 10+ monadic steps                 | High       |
| Algebraic bridging               | Connecting implementation to mathematical spec   | High       |

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
    interval_cases i <;> scalar_tac
```

**Key insight:** `interval_cases i` generates one goal per value. Combine with
`<;>` to apply the same closing tactic to all cases. For i=0 (special case),
handle separately with `by_cases` before `interval_cases` on the rest.

**Real example** -- Reduce.lean (per-limb bounds after carry propagation):

```lean
-- From Reduce.lean: show all 5 result limbs satisfy the bound
. intro i _
  interval_cases i
  · simp [*]; scalar_tac
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
simp [Field51_as_Nat, Finset.sum_range_succ, p, Nat.ModEq, *]; agrind
```

When the carry structure is simple enough, expanding definitions and using `agrind`
on the resulting arithmetic suffices.

---

## Pattern 4: Carry Chain Reasoning

Multi-limb arithmetic produces carries that propagate from limb to limb. The
`reduce` function is the canonical example: extract carry from each limb, add it
to the next, and wrap the final carry back with a multiplier (19 for Curve25519).

**When to use:** Any function that normalizes limb representations (reduce, carry
propagation, schoolbook multiply output normalization).

**Real example** -- Reduce.lean (5-limb carry chain):

```lean
-- From Reduce.lean: unfold + step* resolves the entire carry chain
@[step]
theorem reduce_spec (limbs : Array U64 5#usize) :
    exists result, reduce limbs = ok result /\
    (forall i < 5, result[i]!.val <= 2^51 + (2^13 - 1) * 19) /\
    Field51_as_Nat limbs === Field51_as_Nat result [MOD p] := by
  unfold reduce
  step*
  -- step* steps through: extract carry0, mask limb0,
  -- add carry0 to limb1, extract carry1, mask limb1, ...
  -- Each remaining goal is a bounds obligation:
  . simp [*]; scalar_tac   -- carry0 bound
  . simp [*]; scalar_tac   -- carry1 bound
  . simp [*]; scalar_tac   -- carry2 bound
  . simp [*]; scalar_tac   -- carry3 bound
  . simp [*]; scalar_tac   -- carry4 bound (wraps with *19)
```

**Structure of carry chain proofs:**
1. `unfold` + `step*` resolves all monadic steps
2. Each carry step produces a bounds obligation: `simp [*]; scalar_tac`
3. Final goal: universal bound on all output limbs uses `interval_cases`
4. Modular congruence: `simp [Field51_as_Nat, ...]; agrind`

**Why this works:** The `@[step]` attribute on helper specs (like mask and
shift operations) lets `step*` automatically chain through the carry pipeline.
The attribute `[scalar_tac_simps] LOW_51_BIT_MASK_val_eq` teaches `scalar_tac`
about the mask constant.

**Alternative with `loop.spec_decr_nat`:** For loops using the fixed-point
combinator (instead of recursive functions), apply `loop.spec_decr_nat` with:
- A `Nat` termination measure (e.g., remaining iterations)
- A loop invariant threading carried values through each iteration
- The postcondition established when the loop terminates

```lean
@[step]
theorem carry_loop.spec (x : MyState) (h : x.inv) :
  carry_loop_body.loop x ⦃ r => r.post ⦄ := by
  apply loop.spec_decr_nat (measure := fun s => s.remaining) (inv := fun s => s.inv)
  · intro s hs
    unfold carry_loop_body
    step*
    · agrind -- carry bound
    · agrind -- invariant preservation
    split_conjs
    · agrind -- conjunct 1
    · agrind -- conjunct 2
  · exact h
```

---

## Pattern 5: Multi-Coordinate Specs

Point operations (addition, doubling, conversion) produce multiple field element
outputs. The spec states properties of each coordinate separately.

**When to use:** Any function returning a struct with multiple field element
coordinates (EdwardsPoint, CompletedPoint, ProjectivePoint).

**Real example** -- AsExtended.lean (completed to extended point conversion):

```lean
-- From AsExtended.lean: 4-coordinate output, each with modular spec
@[step]
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
  step*
  rw [<- Nat.ModEq, <- Nat.ModEq, <- Nat.ModEq, <- Nat.ModEq]
  simp_all
```

**Key structure:**
1. **Preconditions:** Bounds on every coordinate of every input point
2. **Postconditions:** Conjunction of per-coordinate modular equalities
3. **Proof:** `unfold` + `step*` resolves all field multiplications (using
   `@[step]` attributed `mul_spec`), then `simp_all` closes modular goals

**Pattern for bounds preconditions:**
```lean
-- Each coordinate needs its own universal bound hypothesis
(h_X_bounds : forall i, i < 5 -> (pt.X[i]!).val < 2 ^ 54)
```
The bound `2^54` is typical for reduced field elements (each limb < 2^51 plus
small carry margin).

---

## Pattern 6: Canonical Loop Proof Strategy

The strategy for proving loop correctness follows a three-theorem structure:
`spec_gen` (generalized loop body), `spec` (entry-point wrapper), and
top-level function spec.

### How to prove loops

**Step 1: Identify the loop invariant.**
What holds at the start of each iteration? Typically two parts:
- "entries before the current index are processed" (done region)
- "entries at or after the current index are untouched" (rest region)

**Step 2: Write `spec_gen` with the invariant as both precondition and postcondition.**

```lean
private theorem my_loop.spec_gen
  (iter : core.ops.range.Range Std.Usize)
  (state : State)
  (hlo : iter.start.val ≤ iter.«end».val)
  (hdone : ∀ j, j < iter.start.val → processed j state)
  (hrest : ∀ j, iter.start.val ≤ j → j < N → untouched j state) :
  my_loop iter state ⦃ fun result =>
    ∀ j, j < N → processed j result ⦄ := by
  unfold my_loop
  step*
  · -- Invariant rebuild for done region
    intro j hj
    by_cases hji : j = iter.start.val
    · subst hji; simp [*]   -- current iteration
    · apply hdone; agrind    -- previously done
  · -- Invariant rebuild for rest region
    intro j hlo hhi; apply hrest <;> agrind
  · -- Base case: loop complete
    split_conjs <;> agrind
termination_by iter.«end».val - iter.start.val
decreasing_by agrind
```

**Step 3: Write `spec` that instantiates `spec_gen` at start=0.**

```lean
@[step]
theorem my_loop.spec (state : State) :
  my_loop { start := 0#usize, «end» := N } state ⦃ fun result =>
    ∀ j, j < N → processed j result ⦄ := by
  apply WP.spec_mono
  · apply my_loop.spec_gen <;> agrind
  · intro res h; split_conjs <;> agrind
```

**Step 4: Write top-level function spec that delegates to `spec`.**

```lean
@[step]
theorem my_function.spec (input : InputType) :
  my_function input ⦃ fun result => ... ⦄ := by
  unfold my_function
  step*   -- step* will use my_loop.spec via @[step]
```

### Key rules

- Every function spec requires loop specs -- a function spec without its
  loop specs (`_loop`, `_loop0`, `_loop1`) is unprovable
- Never use `partial_fixpoint_induct`
- `step*` on the recursive call automatically uses the `@[step]`-tagged
  theorem being proved (self-reference works in Lean)
- For nested loops: outer `spec_gen` calls inner loop's `@[step]` spec

---

## Pattern 7: The step*? Workflow

One of the most effective proof strategies for complex functions:

**1. Generate a complete proof script** using `step*?`. This applies `step`
repeatedly with case splits and outputs the full expanded proof script.

**2. Review the generated script.** It will be verbose but complete. Use
`lean_code_actions` to retrieve the generated script.

**3. Immediately scaffold `· agrind` for every remaining sub-goal.**
This is mandatory before doing anything else. Most goals will close
automatically.

**4. Automate proof obligations.** Register lemmas locally for `agrind`:
```lean
attribute [local agrind] my_lemma1 my_lemma2
```
Re-run `step*` -- it now handles more goals automatically.

**5. Refold the proof.** Progressively replace the expanded script with
`step*`, which now handles more goals. The final proof might be a single
`step*` call followed by a small finishing script.

**Example from upstream (list mutation spec):**
```lean
theorem list_nth_mut1_spec {T: Type} [Inhabited T] (l : CList T) (i : U32)
  (h : i.val < l.toList.length) :
  list_nth_mut1 l i ⦃ x back =>
    x = l.toList[i.val]! ∧
    ∀ x', (back x').toList = l.toList.set i.val x' ⦄ := by
  unfold list_nth_mut1 list_nth_mut1_loop
  step*
  simp_all
```

### The `step*?` to `let*` migration

When you need named access to intermediate variables (e.g., for a complex
functional correctness goal), `step*?` generates a `let*`-based script:

```lean
let* ⟨ x2, x2_post ⟩ ← U32.add_spec
let* ⟨ x3, h_len, h_val ⟩ ← foo_spec
```

You can rename binders to match algorithm variables (e.g., `seedA`, `ct_11`).
Precondition subgoals appear as `· sorry` blocks inline -- move proofs from
cdot blocks into these positions.

---

## Pattern 8: Recursive Function Termination Pitfall

**The pitfall:** If you write `unfold my_recursive_fn; step` and the proof
appears finished but Lean reports a termination error, `step` found your own
theorem and applied it recursively. This typically happens when the function
starts with a `match` or `if-then-else`.

**The fix:** Case-split first before calling `step`:

```lean
-- BAD: termination error
theorem my_recursive_fn_spec ... := by
  unfold my_recursive_fn
  step    -- applies my_recursive_fn_spec recursively!

-- GOOD: split first
theorem my_recursive_fn_spec ... := by
  unfold my_recursive_fn
  split           -- or: cases ..., or: simp_ifs
  · step          -- first branch (non-recursive shape)
  · step          -- second branch
```

By splitting first, `step` sees a non-recursive goal shape and applies the
correct inner specs rather than the theorem being proved.

### Proper recursive loop proof pattern

For recursive `_loop` functions generated by Aeneas, use the full recursive
pattern with explicit termination:

```lean
@[step]
theorem my_loop.spec (x : State) (h : invariant x) :
  my_loop x ⦃ r => postcondition r ⦄ := by
  unfold my_loop
  split
  · step ...        -- recursive case
    split_conjs <;> (try scalar_tac) <;> agrind
  · ...             -- base case
termination_by decreasing_measure x
decreasing_by scalar_decr_tac
```

---

## Pattern 9: Function Fold Decomposition Strategy

When a function proof exceeds ~200 lines or ~10 `step` calls, decompose using
fold theorems. This breaks a monolithic proof into manageable pieces.

### When to decompose

- `step*` produces more than 15 remaining goals
- The function has natural phases (setup, processing, finalize)
- Heartbeats are tight (aim for < 8M even for large proofs)
- "Too many monadic steps" is NEVER a reason to axiomatize -- it IS a reason
  to decompose

### The decomposition workflow

**1. Identify logical phases** in the function body (e.g., initialization,
hash computation, finalization).

**2. Define helper functions** that capture each phase:
```lean
private def setup_phase (params : Params) : Result IntermediateState := do
  let a ← compute_a params
  let b ← compute_b a
  ok (a, b)
```

**3. Prove fold theorems** showing inline code equals helper calls:
```lean
private theorem fold_setup (params : Params) (f : A → B → Result α) :
  (do let a ← compute_a params; let b ← compute_b a; f a b) =
  (do let r ← setup_phase params; f r.1 r.2) := by
  simp only [setup_phase, bind_assoc_eq, bind_tc_ok, pure]
```

**4. Write `@[local step]` specs** for each helper (even if sorry'd initially).

**5. Use in the main proof:**
```lean
theorem main_fn.spec ... := by
  unfold main_fn
  simp only [fold_setup, fold_process, fold_finalize]  -- fold phases
  step*   -- now steps through phase calls instead of 50+ operations
```

### Critical invariants

- Fold theorem LHS must differ from RHS (not provable by `rfl`)
- Continuations use curried arguments, not tuples
- Every helper needs a `@[local step]` spec
- Always test: `simp only [fold_setup]` must make progress in the parent

---

## Pattern 10: WP.spec_mono Pattern

When `spec_gen` gives a low-level postcondition and you want something cleaner
for the public `@[step]` theorem, use `WP.spec_mono` to strengthen the
postcondition:

```lean
@[step]
theorem my_loop.spec (out a : Slice U16) (hlen : out.length = a.length) :
  my_loop { start := 0#usize, «end» := out.len } out a ⦃ fun res =>
    res.length = out.length ∧
    ∀ j, j < res.length → res[j] = f (a[j]) (out[j]) ⦄ := by
  apply WP.spec_mono
  · apply my_loop.spec_gen <;> agrind   -- gives raw postcondition
  · intro res ⟨h1, h2, ...⟩            -- derive nice postcondition
    split_conjs <;> agrind
```

**How it works:** `WP.spec_mono` takes a proof of a weaker postcondition
(from `spec_gen`) and a proof that the weaker postcondition implies the
stronger one. This separates the inductive proof (in `spec_gen`) from the
postcondition simplification (in `spec`).

**Common use:** In the canonical loop pattern, `spec_gen` has raw invariant
components as postconditions. The public `spec` uses `WP.spec_mono` to derive
cleaner, caller-friendly postconditions.

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
explicit intermediate results, `scalar_tac` and `agrind` cannot see the needed
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
-- Let step* thread carries through, then prove bounds per-goal
unfold reduce
step*
-- Each goal now correctly accounts for carry from previous limb
. simp [*]; scalar_tac
```

### 4. Don't use overpowered tactics when simpler ones suffice

Using `grind` when `ring` or `agrind` would close the goal produces
slower, less maintainable proofs that may break on Lean version upgrades.

**Wrong:**
```lean
have : a + b = b + a := by grind  -- overkill
```

**Right:**
```lean
have : a + b = b + a := by ring
have : n < n + 1 := by agrind
```

</anti_patterns>

<summary>

## Strategy Selection Guide

```
What does the function do?
|
+-- Single scalar/byte operation (clamp, mask, shift)
|   --> Case splitting (Pattern 1) + Bitwise (bvify/bv_tac)
|
+-- Limb-by-limb arithmetic (add bias, subtract)
|   --> Bounds propagation (Pattern 2)
|   --> Per-limb reasoning with explicit obtain chains
|
+-- Carry/reduce normalization
|   --> Carry chain (Pattern 4) / loop.spec_decr_nat
|   --> unfold + step* for monadic chain
|   --> simp [*]; scalar_tac for each carry bound
|
+-- Field operation with modular spec (sub mod p, mul mod p)
|   --> Modular arithmetic (Pattern 3)
|   --> Nat.ModEq lemmas + bias cancellation
|
+-- Multi-output point operation (add, double, convert)
|   --> Multi-coordinate (Pattern 5)
|   --> Per-coordinate modular equality
|   --> Relies on @[step] attributed sub-specs
|
+-- Loop (iterator-based or recursive)
|   --> Canonical loop template (Pattern 6): spec_gen / spec / top-level
|   --> WP.spec_mono to strengthen postconditions (Pattern 10)
|
+-- Large function (10+ monadic steps)
|   --> Fold decomposition (Pattern 9)
|   --> Define helpers, fold theorems, @[local step] specs
|   --> Never axiomatize transparent functions
|
+-- Recursive function with termination error
|   --> Termination pitfall workaround (Pattern 8): split before step

Proof development workflow:
  1. Start with unfold foo
  2. If function starts with match/if: split first
  3. Try step* -- if it works, scaffold · agrind per sub-goal
  4. If not, use step*? to generate full script (Pattern 7)
  5. For loops: canonical template (Pattern 6)
  6. For large functions: fold decomposition (Pattern 9)
  7. Refold the proof to be as short as possible

Proof complexity hierarchy:
  Simple:  unfold + step* + simp [*]; scalar_tac
  Medium:  + explicit obtain chains + interval_cases
  Complex: + Nat.ModEq chains + Finset.sum expansion + have blocks
  Large:   + fold decomposition + auxiliary specs
```

</summary>
