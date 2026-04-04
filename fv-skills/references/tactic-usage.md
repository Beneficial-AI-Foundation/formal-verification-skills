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

## Decision Tree: Which Tactic?

The default tactic is `agrind` -- always try it first. It is fast, handles
arithmetic, equalities, and most structural goals. If `agrind` fails, try
`grind` (slower but more powerful). Do NOT reach for `simp_all` -- it is very
slow in large contexts and silently drops hypotheses.

```
What does the goal look like?

├─ Monadic function call (let x ← f args; ...)
│  → step / step* / step with <thm>
│
├─ Loop fixed-point (loop body x)
│  → apply loop.spec_decr_nat (Nat measure) or loop.spec (general)
│
├─ Recursive _loop function
│  → unfold + by_cases + step (invariant = pre + post)
│  → termination_by + scalar_decr_tac
│  → NEVER partial_fixpoint_induct
│
├─ Arithmetic
│  ├─ General → agrind (preferred), then grind, then scalar_tac
│  ├─ Nonlinear → agrind, then grind, then simp_scalar, then scalar_tac +nonLin
│  └─ Scalar simplification (min, max, %) → simp_scalar
│
├─ Bit-vector / Bitwise (&&&, |||, ^^^, ~~~, >>>, <<<, %)
│  ├─ Pure BitVec goal → bv_tac N
│  ├─ Nat goal about bitwise result → bvify N; bv_tac N
│  ├─ bvify fails → have h : bv_prop := by bv_tac N; natify at h; simp_scalar
│  └─ bv_tac error (non-decomposed expr) → missing @[bvify_simps] lemma
│
├─ Modular arithmetic
│  ├─ Equivalence (a ≡ b [MOD n]) → zmodify; ring / simp
│  └─ Bounds (a < n) → stay Nat/Int; agrind / grind / scalar_tac
│
├─ List/Array/Slice structural (setSlice!, replicate, append, take, drop, length)
│  → simp_lists
│
├─ List/Array (get/set by index)
│  ├─ Automatic → agrind first; if fails, try grind (slower, more lemmas)
│  └─ Slow → cases idx <;> simp_lists
│
├─ Equality with shared terms (3*x + 2*y = x + 3*y)
│  → ring_eq_nf / ring_eq_nf at h
│
├─ If-then-else → simp_ifs / split
├─ Conjunction (∧) → split_conjs, then scaffold `· agrind` per sub-goal
├─ Boolean/Propositional → simp_bool_prop / tauto
├─ Concrete computation → decide / native_decide
├─ Congruence → fcongr (NEVER congr -- heartbeat timeout)
│
├─ Writing `simp [CONST]; solver` in a cdot block after step*?
│  → STOP. Register CONST with @[grind =, agrind =] first.
│    Re-run step* -- the goal may disappear entirely.
│
└─ General / stuck
   ├─ Try → agrind
   └─ If fails → simp [*]; agrind
```

## Scaffolding Workflow

After every `step*` (or `split_conjs`, `split`, `cases`), immediately scaffold
one `· agrind` per remaining sub-goal. This is the very first thing you do --
before inspecting goals, before trying tactics, before anything else.

```lean
-- After step*:
step*
· agrind -- goal 1
· agrind -- goal 2
· agrind -- goal 3

-- After split_conjs:
split_conjs
· agrind -- conjunct 1
· agrind -- conjunct 2
```

Benefits:
- `agrind` closes most sub-goals immediately (bounds, equalities)
- Each goal becomes independently inspectable with `lean_goal`
- Edits are incremental -- changing one block does not re-elaborate others
- No temptation to use banned `all_goals` or `<;>` patterns

After scaffolding, check which `· agrind` goals still have errors. For those,
inspect with `lean_goal`, pick the right tactic, and replace.

**Before writing cdot blocks:** Check for missing solver attributes. If 3+
goals need the same constant unfolded, register it with `@[grind =, agrind =]`
first, then re-run `step*` -- the goals may vanish.

## Inaccessible Hypotheses

Many tactics (`step*`, `cases`, `intro`, pattern matching) produce hypotheses
with inaccessible names (`_✝⁵⁵`, `h✝`) that cannot be referenced directly.

### Solution 1: Type matching with `‹_›` and `rename_i` (up to ~10 hypotheses)

`‹expr›` searches the context for a hypothesis whose type matches `expr`.
Wildcards (`_`) match any subexpression including inaccessible variables:

```lean
-- Context has: _✝⁴² : P x✝⁸ someKnownTerm
have h1 := ‹P _ someKnownTerm›     -- _ matches x✝⁸
```

`rename_i` renames inaccessible hypotheses starting from the most recent:

```lean
step*
rename_i h    -- grabs the last inaccessible hypothesis
exact h
```

### Solution 2: `step*?` to generate named `let*` script (many hypotheses)

When Solution 1 is impractical, use `step*?` to generate a full `let*`-based
proof script with named bindings:

```lean
let* ⟨ x2, x2_post ⟩ ← U32.add_spec
let* ⟨ x3, h_len, h_val ⟩ ← foo_spec
```

You can rename binders to match algorithm variables. The `let*` script is
~10x slower than `step*` for 50+ bindings, so prefer Solution 1 when feasible.

## Common Pitfalls

### Termination pitfall with `partial_fixpoint_induct`

`partial_fixpoint_induct` requires an explicit motive repeating the entire
postcondition, plus a sorry'd `admissible` proof. Instead use:
`unfold` + `by_cases` + `step` + `termination_by`

### Nat subtraction underflow

In Lean, `Nat` subtraction floors at 0: `3 - 5 = 0`. Solutions:
- Use `Int` when subtraction is involved
- Add preconditions: `(h : a >= b)` before using `a - b`
- Rewrite subtractions as additions: `z + y = x` instead of `z = x - y`

### `simp_all` caution

`simp_all` can simplify and remove hypotheses it considers redundant. Prefer:
- `simp [h1, h2]` with an explicit lemma list
- `simp [*]` to use all hypotheses without removing them
- `agrind` as the general-purpose default

### `agrind` + `simp` interaction

Due to a current grind issue, `simp [*]; agrind` can solve goals that `agrind`
alone cannot. When `agrind` fails, try prepending `simp [*]`.

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
| `partial_fixpoint_induct` | Needs explicit motive + sorry'd `admissible` proof   | `unfold` + `by_cases` + `step` + `termination_by` |

**The first three tactics are NEVER acceptable in Aeneas proofs** -- not in `step`
theorems, not in helper lemmas, not in `have` steps, not in `decreasing_by` (even
for pure Nat). They cannot reason about U8, U32, Usize, Slice.length, etc.
There are **no exceptions**.

**`step* <;>` and `all_goals` are NEVER acceptable either** -- they destroy
incrementality by forcing full re-elaboration on every edit. `all_goals` is
banned **everywhere**, not just after `step*`. Always use focused cdot blocks --
one per goal.

**`partial_fixpoint_induct`** requires an explicit motive repeating the entire
postcondition, an `admissible` proof (typically sorry'd), and manual IH
threading. The `unfold` + `by_cases` + `step` pattern avoids all of this.

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

---

## Pattern 6: Common Tactic Combinations

Frequently used tactic sequences for recurring goal shapes:

| Pattern | Use When |
|---|---|
| `split_conjs` then `· agrind` per goal | Goal is a conjunction -- scaffold then fix failures |
| `simp [*]; agrind` | `agrind` alone fails (grind issue workaround) |
| `bvify N; bv_tac N` | Nat goal about bitwise operation |
| `have h := ...; natify at h; simp_scalar at h` | Reverse BV lifting (goal -> bv -> back to Nat) |
| `zify at h; zify; simp [h, Int.mul_emod]` | Modular equivalence via Int |
| `unfold fn; split; step` | Recursive function (avoid termination issue) |
| chain of `have` + `simp_scalar` | Non-linear arithmetic (modulo, division) |
| `calc _ = _ := by simp_scalar` | Equational chains for arithmetic |

---

## Pattern 7: Detailed Tactic Usage Notes

### step / step* / step*?

- `step` -- apply matching `@[step]` theorem to the next monadic bind
- `step as ⟨x, h1, h2⟩` -- name the result and hypotheses
- `step with my_theorem` -- use a specific theorem
- `step*` -- repeatedly apply step (can take 60-120s on big functions)
- `step* n` -- run step for exactly n steps (surgical stepping)
- `step*?` -- generate expanded `let*` proof script via `lean_code_actions`

**Naming with `step as`:** Each name binds one component of the postcondition's
top-level structure. If you provide too many names, Lean warns "Too many ids
provided" -- remove the excess.

**Termination pitfall:** If `unfold foo; step` appears finished but Lean reports
a termination error, `step` applied the spec recursively. Fix: use `split`
before `step` to case-split on match/if first.

### scalar_tac

- `scalar_tac` -- basic integer arithmetic/bounds over Aeneas scalar types
- `scalar_tac +nonLin` -- enable nonlinear arithmetic reasoning
- Understands U8, U16, U32, U64, U128, Usize and their bounds
- Known limitation: struggles with Int <-> Nat conversions; try `zify`/`natify` first
- Register constants: `@[scalar_tac_simps]` attribute

### simp_scalar / simp_lists

- `simp_scalar [lemmas]` -- simplify scalar expressions (min, max, %)
- `simp_lists [lemmas]` -- simplify list/array/slice structural ops
  (setSlice!, replicate, append, take, drop, length, get/set)
- Both are simp-based: safe to locally activate many ad-hoc lemmas without
  complexity explosion
- Register: `@[simp_scalar_simps]` and `@[simp_lists_simps]`

### bvify / bv_tac

- `bvify N` -- lift goal to BitVec N by applying `@[bvify_simps]` lemmas
- `bv_tac N` -- decide the resulting BitVec goal via SAT solving
- Always specify bit width: `bv_tac 8` for U8, `bv_tac 32` for U32
- If `bv_tac` fails with non-decomposed expressions, a `@[bvify_simps]`
  lemma is missing
- Common identity lemmas: `U8.and_allOnes`, `U8.val_and_max`, `U8.bv_mod_size`

### natify / zmodify

- `natify` -- convert propositions to Nat (register: `@[natify_simps]`)
- `zmodify` -- convert to ZMod (register: `@[zmodify_simps]`)
- `zmodify [to N]` -- specify modulus explicitly
- Use `zmodify` for modular arithmetic; `ring` works directly in ZMod

### fcongr / split_conjs / ring_eq_nf

- `fcongr N` -- congruence at reducible transparency (avoids heartbeat timeout
  from `congr`'s default transparency). Use when goal is `f(impl) = f(spec)`.
- `split_conjs` -- fully recursively split nested conjunctions into atomic goals.
  Follow with `· agrind` per sub-goal.
- `ring_eq_nf` -- cancel common terms in equalities: useful for goals like
  `3*x + 2*y = x + 3*y`

### Attribute Management

```lean
-- Register constants for all solvers
@[simp, scalar_tac_simps, agrind =, grind =, bvify]
theorem MY_CONST_val : MY_CONST.val = 42 := by decide

-- Swap to simpler cast spec
attribute [-step] UScalar.cast.step_spec
attribute [local step] UScalar.cast_inBounds_spec

-- Setup for crypto/array proofs
#setup_aeneas_simps
```

Detecting missing attributes: If 3+ cdot sub-goals after `step*` need the same
constant unfolded (`simp [CONST]; solver`), register that constant with solver
attributes. The sub-goals will then be discharged automatically.

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
