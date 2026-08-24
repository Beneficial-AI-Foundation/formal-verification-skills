<overview>

Tiered proof refactoring for Aeneas-generated Lean 4 specifications. Purpose is cleanup
AFTER verification -- the input proof must compile with zero sorry. Three modes control
how aggressively refactorings are applied:

- **safe** -- Tier 1 only. Zero-risk cleanup. No behavioral change possible.
- **balanced** -- Tiers 1-3. Default mode. Conservative improvements with low-medium risk.
- **aggressive** -- All tiers (1-4). Includes smart automation replacement. Higher risk of
  introducing fragility.

Every refactoring is verified with `nice -n 19 lake build` before proceeding. If a
change breaks the build, it is reverted immediately.

</overview>

<quick_reference>

## Refactoring Tier Reference

| Tier | Name | Risk | Examples |
|------|------|------|----------|
| 1 | Zero-risk cleanup | None | Remove duplicate hypotheses, collapse `simp [*]; scalar_tac` into `scalar_tac` when sufficient, normalize whitespace/indentation |
| 2 | Sharper tactics | Low | Delete dead `have` bindings (with proof-fuel check), replace `simp [*]` with `simp only [...]` (use `simp?` to discover), replace `omega` with `norm_num` where applicable, inline single-use `have` bindings |
| 3 | Better simp strategy | Medium | Merge consecutive `simp` calls, replace `unfold X; simp [...]` with `simp [X, ...]`, factor repeated tactic blocks into named local lemmas |
| 4 | Smart automation | High | Replace multi-line tactic scripts with `grind` or `aesop` where they close the goal in one step, consolidate `step` chains with `step*` |

### Mode-to-Tier Mapping

| Mode | Tiers Applied | Use When |
|------|--------------|----------|
| safe | 1 | Cleaning up before a commit. Zero chance of breakage. |
| balanced | 1-3 | Default. Good balance of improvement vs risk. |
| aggressive | 1-4 | Maximizing proof conciseness. Willing to accept fragility. |

</quick_reference>

<patterns>

## Critical Rule: Proof Fuel

Not referenced by name != unused. Tactics like `omega`, `linarith`, `simp_all`, and `scalar_tac`
consume hypotheses from the local context semantically -- they use every available hypothesis
matching their domain WITHOUT explicit textual reference. A `have h : x < 10 := ...` followed
by `omega` is actively used as "proof fuel" even though `h` never appears in the omega call.

**Before removing ANY have/let binding, check:** Does the proof below it contain `omega`,
`linarith`, `simp_all`, `scalar_tac`, or `grind`? If yes, the binding may be proof fuel.
Test removal with a build check -- do NOT assume it is dead based on textual absence alone.

---

## Preferred Refactoring Order

When multiple refactorings are possible, prefer this order (most impactful first):

1. **Lemma reuse** -- Extract shared proof steps into a local lemma used by multiple goals
2. **Proof tail compression** -- Collapse redundant tactic chains at the end of proof branches
3. **Helper extraction** -- Factor repeated tactic blocks into named local lemmas
4. **Backend replacement** -- Replace multi-step manual proofs with single-tactic closers (simp, omega, etc.)
5. **Automation unification** -- Replace multiple automation calls with one stronger call (grind, aesop)

---

## High-Risk Operations

These operations look safe but frequently break proofs:

- **Removing locals near omega/linarith** -- These tactics consume all matching hypotheses
  from context. Removing a "dead-looking" have near omega can silently remove proof fuel.
- **Removing `set ... with hdef` bindings** -- The `hdef` equation is often used implicitly
  by `simp` and `omega` without textual reference. Never remove set bindings without a build test.
- **Reordering branch-local lemmas** -- Lean's elaborator is sensitive to declaration order.
  Moving a `have` above or below another `have` can change what is in scope for subsequent tactics.
- **Optimizing for proof length over elaboration cost** -- A shorter proof is not always faster.
  Replacing `simp only [a, b]` with `simp` may save characters but massively increase elaboration
  time. Proof length != elaboration cost.

---

## Pattern 1: Dead Have Elimination

Detect `have h : ... := by ...` where `h` is never referenced downstream in the proof.
Remove the binding entirely.

**Detection:** Search for `have h_name` declarations. Check if `h_name` appears anywhere
after the declaration in the same proof block. If not referenced textually, it is a candidate
for removal -- but see the proof-fuel rule. Tactics like `omega`, `linarith`, and `simp_all`
use hypotheses by name internally even when the hypothesis name does not appear literally in
the tactic invocation. A `have h_bound` followed by `omega` IS used even though `h_bound`
never appears textually after the have. Always build-test before removing.

**Example:**
```lean
-- Before: dead binding (h_unused never referenced)
theorem my_spec ... := by
  unfold my_fn
  step
  have h_unused : x.val < 2^64 := by scalar_tac
  have h_bound : a.val + b.val <= U64.max := by
    have := h_bounds 0 (by simp); scalar_tac
  simp [*]; scalar_tac

-- After: dead binding removed
theorem my_spec ... := by
  unfold my_fn
  step
  have h_bound : a.val + b.val <= U64.max := by
    have := h_bounds 0 (by simp); scalar_tac
  simp [*]; scalar_tac
```

**Verify:** `nice -n 19 lake build` must still pass after removal.

**Tier:** 2 (low risk -- tactics like omega, linarith, simp_all consume hypotheses semantically without textual reference; see proof-fuel rule)

---

## Pattern 2: Simp Sharpening

Replace `simp [*]` with `simp only [specific_lemmas]` using `simp?` discovery. This
produces faster elaboration, less fragility to upstream simp lemma changes, and clearer
intent about which lemmas the proof actually depends on.

**Workflow:**
1. Temporarily replace `simp [*]` with `simp?` in the proof
2. Run Lean -- the infoview reports: `Try this: simp only [lemma1, lemma2, ...]`
3. Replace `simp?` with the discovered `simp only [...]` call
4. Verify with `nice -n 19 lake build`

**Example:**
```lean
-- Before: broad simp
. simp [*]; scalar_tac

-- After: sharpened simp (discovered via simp?)
. simp only [ha0'_val, hk]; scalar_tac
```

**Benefits:**
- Faster elaboration (fewer lemmas to try)
- Less fragile (unaffected by new @[simp] lemmas added upstream)
- Clearer intent (documents exactly which facts are needed)

**Tier:** 2 (low risk -- same proof with explicit lemma set)

---

## Pattern 3: Tactic Golf

When a simpler tactic alone closes a goal, remove the preceding setup tactic.

**Sub-pattern A:** When `scalar_tac` alone closes a goal, remove preceding `simp [*]`.

```lean
-- Before
. simp [*]; scalar_tac

-- After (if scalar_tac alone closes the goal)
. scalar_tac
```

**Sub-pattern B:** When `omega` closes a goal, remove preceding `norm_num` setup.

```lean
-- Before
. norm_num; omega

-- After (if omega alone closes the goal)
. omega
```

**Verification:** Always test the simpler version with `nice -n 19 lake build` before
committing. The simpler tactic may not always suffice -- only apply when confirmed.

**Tier:** 1 (when removing redundant prefix) or 2 (when replacing with equivalent)

---

## Pattern 3b: Simpa Chain Compression

Replace `have` + `rw` + `exact` chains with `simpa only [...] using h` when the chain is a
straightforward rewrite-then-close sequence.

**Example:**
```lean
-- Before: have/rw/exact chain
have h_eq : a = b := by ring
rw [h_eq]
exact h_goal

-- After: simpa only compresses the chain
simpa only [show a = b from by ring] using h_goal
```

**Safety rule:** Use `simpa only [...]` (with explicit lemma list), NEVER bare `simpa`.
Bare `simpa` triggers the full simp set which is fragile and slow.

**Tier:** 2 (low risk -- explicit lemma list preserves intent)

---

## Pattern 4: Grind/Aesop Replacement (Aggressive Only)

If a multi-line tactic block (3+ lines) can be replaced by a single `grind` or `aesop`
call that closes the goal, do it.

**Constraints:**
- ONLY in aggressive mode (Tier 4)
- ONLY when the automation reliably closes the goal
- NEVER for goals involving Aeneas monadic code (`step` steps)
- Test with `grind?` or `aesop?` first to confirm

**Example:**
```lean
-- Before: 4-line tactic block
. have h1 : a + b = b + a := by ring
  rw [h1]
  simp only [Nat.add_comm]
  omega

-- After: grind closes it in one step (confirmed via grind?)
. grind
```

**Tier:** 4 (high risk -- automation may be fragile across Lean versions)

---

## Grind Guidance

**Good fit:**
- Pure arithmetic goals (linear and nonlinear)
- Propositional logic
- Simple rewriting chains

**Bad fit:**
- Aeneas monadic code (use `step` instead)
- Goals with `Finset.sum` expansion (too complex for grind)
- Bitwise operations (use `bvify`/`bv_decide` instead)

**Exploratory workflow:**
1. Use `grind?` to test if grind can close the goal
2. If it closes the goal instantly, replace the multi-line block
3. If it takes >5 seconds or produces `sorry`, do not use grind
4. If `grind?` suggests a specific configuration, use that exact call

**Local lemma control:**
`grind` uses all `@[simp]` and `@[grind]` lemmas in scope. Be aware of unintended
rewrites from ambient lemmas. If grind produces a different proof than expected, the
ambient lemma set may have changed.

**Syntax warnings:**
- `grind` does NOT accept lemma arguments like `grind [lemma]`
- Use `simp [lemma]; grind` if you need specific lemmas in scope before grind
- `grind` is not `simp` -- it uses E-matching and case splitting, not just rewriting

---

## Aeneas-Specific Policy

**NEVER refactor:**
- `unfold + step` sequences -- these are the structural backbone of Aeneas proofs
- `step` steps that correspond to distinct monadic bind points -- merging them loses
  the 1:1 correspondence between Rust operations and proof steps

**SAFE to refactor:**
- Bounds obligations (`simp [*]; scalar_tac` patterns)
- Case split tails (`interval_cases i <;> omega`)
- Modular arithmetic closers (`simp [Field51_as_Nat, ...]; omega`)

**step* policy:**
`step*` is acceptable as a replacement for consecutive `step` calls ONLY when
all steps are independent (no intermediate `have` bindings between them). If there are
`have` bindings or manual `simp` steps between `step` calls, do NOT merge them.

---

## Target Selection Heuristics

### Good Targets (refactor these first)
- Theorems with 3+ consecutive `simp`/`omega`/`scalar_tac` calls on the same goal
- Proofs where `simp?` reports a shorter lemma list than current `simp [*]`
- Proofs with obvious dead bindings confirmed by build test
- Stable, self-contained theorems with no cross-file dependents

### Bad Targets (leave these alone)
- Theorems that other files import (high blast radius on failure)
- Proofs near `omega`/`linarith` that use many local hypotheses
- Recently modified proofs that are not yet stable
- Proofs that are already minimal (2-3 tactic lines)

**Rule:** Refactor stable plateaus first, not cliff edges. A "plateau" is a theorem that has
compiled successfully through multiple project changes. A "cliff edge" is a theorem that was
recently proved or modified and may still be fragile.

---

## Refactoring Layering Strategy

When refactoring a multi-file project, work through these layers in order:

1. **Pure math layer** -- Theorems about mathematical properties (commutativity, associativity,
   bounds). These have the fewest dependencies and are safest to refactor.
2. **Representation layer** -- Theorems connecting Rust types to mathematical objects
   (Field51_as_Nat, Scalar52_as_Nat). More sensitive but still relatively contained.
3. **Bridge layer** -- Theorems that connect representation to specification (interpretation
   functions applied to computation results). Cross-cutting; changes may affect multiple files.
4. **Top-level specs** -- The main correctness theorems. Most dependencies, highest risk.
   Refactor last, after lower layers are stable.

This ordering ensures that refactorings in lower layers do not cascade into breakage
in higher layers.

---

## Repo-Specific Lessons (Aeneas/Ristretto)

Hard-won lessons from real proof cleanup work:

- **Parity/omega fragility** -- `omega` proofs involving parity (even/odd, % 2) are extremely
  fragile. Small changes to hypothesis ordering or available lemmas can break them. Avoid
  refactoring near parity-related omega calls.
- **`simpa only` is safer than broad `simpa`** -- Always use the `only` variant with an
  explicit lemma list. Bare `simpa` pulls in the full simp set which changes across Mathlib
  versions.
- **Declaration order matters** -- Lean elaborates top-to-bottom. Moving a `have` binding
  up or down changes what is available in the local context for subsequent tactics. Never
  reorder declarations without a build test.
- **Cross-file extraction cost model** -- Extracting a helper lemma into a separate file
  has overhead: import management, namespace changes, potential simp set pollution. Only
  extract when the lemma is used in 3+ files.
- **Proof length != elaboration cost** -- A 5-line proof using `simp only [a, b, c]` can
  elaborate faster than a 2-line proof using `simp`. The simp set size dominates elaboration
  time, not proof length. Prefer `simp only` even when `simp` alone works.

---

## Refactoring Principles

Principles extracted from real-world refactoring of large verified proofs. These
complement the tier-based heuristics above with strategic guidance on *what* to
extract and *how* to structure the result.

### Extract by semantic unit, not by local syntax

Good helper lemmas package one real unit of reasoning:
- an invariant package (e.g., `SomeStructure.IsValid`)
- a case split and its consequences
- a bridge from implementation state to pure definitions (e.g., `sub_preserves_bound`)
- a generic arithmetic fact reused in multiple places

Bad helper lemmas merely rename:
- one `toField` rewrite
- one cast
- one constant
- one one-off `have`

If the helper does not remove a genuine repeated block, it is probably noise. The test
is: does this helper correspond to a meaningful mathematical concept?

### Fix helper first, then use it

When extracting a helper lemma:
1. Make the helper compile on its own first
2. Fix binder types, casts, and return types before replacing any call site
3. Only then use the helper to shrink the main theorem

This avoids turning one local proof into two broken proofs. Never leave both the
helper and the main theorem sorry-d at the same time.

### Short theorem body + reusable helper layer

The ideal refactored proof has a 5-10 line main body that calls well-named helpers.
The real target is:
- **Short theorem body** -- reads like a proof plan, not a transcript of every step
- **Reusable helper layer** -- heavy reasoning lives in private lemmas
- **Same proof strength** -- theorem statement unchanged

Total file LOC may or may not drop. The meaningful metric is whether the theorem body
became clearer. If the main theorem body drops more than 50% of its LOC, that is
already a good refactoring.

### Prefer aggregated results over fragmented lemmas

If the proof repeatedly re-establishes related facts, prefer returning a structured
result once and projecting fields later. One lemma returning `SomeStructure.IsValid`
with 5 conjuncts beats 5 separate lemmas when the facts are always used together.
This usually gives the biggest theorem-body reduction.

### Do not hoist local proof state across sibling goals

In FV proofs with `step*`, `rename_i`, or generated postconditions, two visually
nearby proof blocks may live in different local contexts. Consequences:
- A `have` in one bullet often cannot be reused in another
- Literal hoisting above the bullet structure often fails
- Reuse must happen through private lemmas abstracted over the generated locals

This is a structural constraint of Lean's elaborator, not a style preference.

### Refactor in layers

A productive extraction order:
1. Arithmetic and lift boilerplate
2. Invariant package
3. Repeated case-analysis package
4. Pure semantic bridge
5. Theorem-body rewrite

Later extractions often become obvious only after the invariant layer is packaged.

---

## Reduction Types

Three different kinds of "proof reduction" exist. A refactoring agent should not
confuse these goals.

### 1. Theorem-body reduction (golf)

The main theorem becomes shorter and reads like orchestration. This is the
highest-value maintainability win. Focus on semantic duplication first, then
setup duplication.

### 2. File-level reduction (extract common)

The theorem file becomes smaller by moving stable support lemmas into a companion
helpers file. This is a readability and maintainability move -- it usually does not
reduce total repo LOC.

**When to split:** A theorem file is support-heavy when the actual top-level theorem
body is a minority of the file (under ~35% of file LOC), most remaining lines are
private structures or bridge lemmas, and helper extraction is no longer removing
duplicated semantic reasoning -- only setup noise.

### 3. Repo-wide reduction (shared lemma library)

Total proof mass drops. This only happens when repeated support logic disappears or
upstream specs expose stronger semantic facts. This is the biggest long-term
opportunity but requires changing the abstraction boundary.

### When in-file golf stops paying off

Further local golfing is low-yield when most remaining bulk is:
- Bundle or witness construction repeated across sibling `step*` goals
- `unfold toField` plus `lift_mod_eq` plus `push_cast` boilerplate
- Local bridge lemmas that only exist because upstream specs are too weak

At that point, another wave of micro-lemmas often moves lines instead of deleting
them, increases API surface, and makes the file less readable.

**Diminishing returns threshold:** If the next expected reduction is below ~20% of
current theorem-body LOC, escalate to a file-split or upstream-spec recommendation
rather than continuing local golf.

### Detecting support-heavy files

Heuristic thresholds:
- Theorem body under 35% of file LOC -- file is probably support-heavy
- Most duplication is in witness packaging rather than semantic reasoning -- local
  golf is nearing exhaustion
- A new helper shortens one block but grows the file overall and does not create
  reuse across files -- warning sign to stop

### Decision policy

The refactorer should classify each action into one of three modes:
1. **local_golf** -- Use when duplicated reasoning still exists inside the file
2. **file_split_recommendation** -- Use when the file is dominated by stable support
3. **upstream_spec_recommendation** -- Use when support lemmas mainly reconstruct
   facts that should be exported by dependencies

---

## Performance-Aware Decomposition

Lessons from decomposing monolithic proofs into extracted helpers while tracking
build performance. Decomposition improves readability but adds elaboration overhead.

### `abbrev` vs `def` for postcondition predicates

When extracting a bundled postcondition into a named predicate, use `abbrev` not `def`.

- **`def`**: Lean treats the predicate as opaque. At `exact` call sites, the elaborator
  must explicitly unfold it. Expensive.
- **`abbrev`**: The predicate is reducible -- unification is transparent. Measured saving:
  ~1.4s across 5 call sites in sqrt_ratio_i_spec'.

**Exception**: Never use `abbrev` for term-level constants with large numeric content
(e.g., `SQRT_M1_val := constants.SQRT_M1_raw` with 5 limbs of 64-bit values). Lean
eagerly unfolds `abbrev` during `whnf`, triggering expensive big-number computation.
Use `def` for numeric constants.

### `exact` at dispatch sites, never `simpa`

When the main theorem dispatches to a helper, use `exact helper args...` rather than
`simpa [pred, and_imp] using helper args...`.

`simpa` applies `simp` to **both** the goal **and** the helper's return type, then checks
if they match. This is O(simp-set-size). `exact` only needs definitional unification --
O(1) relative to the simp set.

Measured saving: ~1.3s across 5 call sites (from `simpa` to `exact`).

**Precondition**: The goal must already definitionally match the helper's return type.
Remove postcondition-shaping lemmas (`and_imp`, `Nat.mul_mod_mod`, etc.) from branch
simp sets.

### Measured overhead data

From curve25519-dalek sqrt_ratio_i_spec' decomposition:

| Component | Typical Cost | Notes |
|-----------|-------------|-------|
| `abbrev` postcondition predicate | 1.0-1.5s | One-time; shared across helpers |
| Each helper signature | 200-400ms | Proportional to parameter count |
| Each `exact` dispatch | 50-100ms | Cheap with `abbrev` predicate |
| Each `simpa` dispatch | 200-400ms | Avoid; use `exact` instead |
| Each `let*` (step) step | 50-100ms | Fixed cost per monadic step |

**Rule of thumb**: Extracting N helpers adds roughly `1.5 + N * 0.3` seconds of
elaboration overhead (with `abbrev` + `exact`). Without these optimizations, the
overhead is `1.5 + N * 0.6` seconds.

### Minimize `simp only` lemma sets

Every lemma in a `simp only` set causes `simp` to traverse the goal looking for
matches. For large goals (after 17+ `let*` steps with 30+ hypotheses), this is
expensive. Discovery method: remove lemmas one at a time, check if proof still compiles.

### `if_pos`/`if_neg` over `reduceIte`

When resolving `if` expressions after `by_cases`, use targeted `if_pos h` or
`if_neg h` in `simp only` instead of `reduceIte`. The latter scans the entire goal.

---

## Advanced Techniques

### `let*` WP transform technique

The Aeneas WP (weakest precondition) transformer provides `let*` syntax as an
alternative to `step as` for stepping through monadic binds. Both produce equivalent
proofs, but `let*` with explicit spec names eliminates the typeclass/simp search that
`step` performs.

**Before:**
```lean
unfold my_function
step as <<x, h_x_eq, x_bounds>>
step as <<y, h_y_eq, y_bounds>>
```

**After:**
```lean
unfold my_function
simp only [step_simps]
let* << x, x_post1, x_post2 >> <-
  Namespace.Of.The.Spec.add_spec
let* << y, y_post1, y_post2 >> <-
  Namespace.Of.The.Spec.mul_spec
```

**Key rules:**
1. `simp only [step_simps]` after `unfold` normalizes the goal to WP form (required
   once, before the first `let*`)
2. Explicit spec name (`<- SpecName`) tells the tactic exactly which spec to apply -- no
   typeclass search, no simp scan of the `@[step]` lemma set
3. Postcondition naming: `let*` names postconditions `_post1, _post2` positionally
4. Use `step*?` in the info view after `simp only [step_simps]` to discover `let*`
   statements

**Measured improvement (AffineNielsPoint/Add.lean):**

| Metric | `step as` | `let*` | Delta |
|--------|-----------|--------|-------|
| simp | 0.87s | 0.36s | **-58%** |
| typeclass | 0.47s | 0.31s | **-34%** |

### `obtain` for non-`@[step]` specs

When a spec is NOT tagged `@[step]`, `let*` rejects it. Use `obtain` + `simp only`:

```lean
obtain <<fe2, h_fe2_ok, fe2_post1, fe2_post2>> :=
  CompletedPoint.add_spec' Z2_post2 Txy2d_post2
simp only [h_fe2_ok, bind_tc_ok]
```

### `[local irreducible]` for opaque postcondition predicates

Heavy algebra in `ZMod p` (`field_simp`, `linear_combination`, `ring`) triggers
reduction of `p = 2^255 - 19`, a 78-digit prime. This is extremely expensive.

**Pattern:**
1. Extract `lift_mod_eq` steps into a helper lemma (needs `p` reducible)
2. Mark `p` irreducible for the main theorem:

```lean
attribute [local irreducible] p in
theorem my_spec ... := by
  ...
  obtain <<hX_F, hY_F, hZ_F, hT_F>> := my_lift_to_field_eqs ...
  -- All subsequent algebra runs with p opaque -- no big-number reduction
```

**Measured improvement:** maxHeartbeats 1000000 -> 200000 (default) -- 5x reduction.

**What works with p irreducible:** `linear_combination`, `field_simp`, `ring`,
`ring_nf`, `simp only [Ed25519]`, `pow_ne_zero`, `norm_num` on small numbers.

**What breaks:** `lift_mod_eq`, `push_cast` after `lift_mod_eq`, `unfold
FieldElement51.toField`, `decide` for `(2 : ZMod p) != 0`.

### Applicability checklist

Use `let*` refactoring when:
- The proof uses `step as` (not `step*` which is already fast)
- Profile shows >0.3s in simp or >0.3s in typeclass for the file
- The spec is `@[step]`-tagged (otherwise use `obtain`)

Use `[local irreducible] p` when:
- maxHeartbeats is elevated (>200000)
- The proof does heavy algebra in `ZMod p`
- `lift_mod_eq` calls can be isolated into a helper

</patterns>

<anti_patterns>

## Anti-Patterns

### 1. Never remove @[step] attributes

These attributes are consumed by other proofs via the `step` tactic. Removing them
silently breaks downstream theorems that depend on them.

### 2. Never change theorem signatures

Preconditions and postconditions are the specification contract. Changing them changes
what is being proved. Refactoring operates ONLY on the proof body (the `by ...` block).

### 3. Never replace scalar_tac with omega blindly

`scalar_tac` understands Aeneas scalar types (U8, U16, U32, U64, Usize) and their bounds.
`omega` only handles pure Nat/Int linear arithmetic. Replacing `scalar_tac` with `omega`
will fail when Aeneas type bounds are involved.

### 4. Never use decide or native_decide on large numeric goals

`decide` and `native_decide` compile to native code and run at elaboration time. On large
constants (2^255, field primes) they will time out or exhaust memory.

### 5. Never simplify away explicit intermediate have blocks that document proof strategy

Readability matters. If a `have` block exists to document a proof step (even if the binding
could be inlined), leave it alone unless you are certain the proof remains clear without it.

### 6. Never batch-refactor multiple theorems in one pass

One theorem at a time. Verify after each. If a refactoring breaks a build, you need to
know exactly which theorem was affected.

### 7. Never use broad simpa/simp mid-proof

Using `simpa` or `simp` without `only [...]` in the middle of a proof creates a hidden
dependency on the entire simp lemma set. This is fragile across Mathlib updates and makes
the proof non-reproducible. Always use `simpa only [...]` or `simp only [...]`.

### 8. Never mix refactoring with theorem changes

Refactoring changes the proof body only. Never combine refactoring with changes to
theorem statements, imports, or module structure in the same pass. Mixing refactoring with
proof changes makes it impossible to isolate what broke the build.

### 9. Never delete arithmetic locals because they "look unused"

If a `have h_bound : x < 2^64 := by scalar_tac` appears before `omega` or `linarith`,
it IS used -- these tactics consume all hypotheses matching their domain. See the
proof-fuel rule above.

### 10. Never batch proof-golf multiple theorems

Refactor one theorem at a time, verify the build, then move to the next. Batch changes
across theorems make it impossible to identify which refactoring broke the build.
This strengthens anti-pattern 6 (never batch-refactor) with the specific failure mode:
when a batch edit breaks, you must revert ALL changes and retry one at a time.

</anti_patterns>

<summary>

## Refactoring Selection Flowchart

```
What mode?
|
+-- safe (Tier 1 only)
|   +-- Duplicate hypotheses? --> Remove duplicates
|   +-- scalar_tac closes goal without simp? --> Remove simp prefix
|   +-- Whitespace/indentation inconsistent? --> Normalize
|   +-- Nothing else to do --> NO_CHANGE
|
+-- balanced (Tiers 1-3)
|   +-- All Tier 1 changes first
|   +-- Dead have bindings (proof-fuel check)? --> Remove after build-test
|   +-- simp [*] present? --> Try simp? to sharpen to simp only [...]
|   +-- omega where norm_num suffices? --> Replace
|   +-- Single-use have binding? --> Inline it
|   +-- Consecutive simp calls? --> Merge them
|   +-- unfold X; simp [...] pattern? --> Try simp [X, ...]
|   +-- Repeated tactic blocks? --> Factor into local lemma
|   +-- Nothing else to do --> NO_CHANGE
|
+-- aggressive (All tiers)
    +-- All Tier 1-3 changes first
    +-- Multi-line block closeable by grind? --> Replace (test with grind? first)
    +-- Multi-line block closeable by aesop? --> Replace (test with aesop? first)
    +-- Consecutive independent step calls? --> Try step*
    +-- Nothing else to do --> NO_CHANGE

ALWAYS: Verify with nice -n 19 lake build after every change.
NEVER: Touch @[step] attributes, theorem signatures, unfold+step backbone.
```

</summary>

<output_format>

The refactorer agent reports per-theorem results in this format:

```
FVS >> REFACTORING {STATUS}

File:      {spec_file}
Theorem:   {theorem_name}
Mode:      {safe|balanced|aggressive}
Passes:    {N} completed
Changes:   {list of changes made}
Lines:     {before} -> {after} ({delta})
Status:    REFACTORED | NO_CHANGE | ERROR

Verify: nice -n 19 lake build
```

Status values:
- **REFACTORED** -- at least one change was applied and the build passes
- **NO_CHANGE** -- no further refactorings possible at the current tier ceiling
- **ERROR** -- a refactoring attempt broke the build and was reverted

</output_format>
