<purpose>
Orchestrate proof porting from another formal verification language to Lean using
two-phase subagent dispatch (research -> iterative execute).

Takes a source language, source project path, and function name (with existing Lean
spec file). Dispatches fvs-researcher to analyze the source proof and map strategies
to Lean tactics, then iteratively dispatches fvs-executor to replace each sorry ONE
AT A TIME using source proof insights.

This workflow combines cross-project analysis (from lean-spec-port workflow) with
iterative proof development (from lean-verify workflow). The source proof provides
WHAT needs to be proven and KEY INSIGHTS, but the actual proof uses Lean tactics.

Output: Lean spec file with sorry replaced by proofs guided by source proof strategy
(VERIFIED, PARTIAL, or STUCK).
</purpose>

<process>

<step name="collect_parameters">
Interactive parameter collection and spec file detection.

**Source language prompt:**
```
FVS >> PROOF PORT

What source language are you porting from?
  1. Verus
  2. F*
  3. Coq
  4. Dafny
  5. Other (specify)
```

**Source project path prompt:**
```
Path to source project?
```

Validate the path exists:
```bash
[ -d "$SOURCE_PROJECT_PATH" ] && echo "Project found" || echo "Project not found"
```

**Function name prompt:**
```
Function to port proof for? (Lean or Rust name)
```

**Lean spec file detection:**

Auto-detect the Lean spec file path by searching the Specs/ directory:
```bash
find Specs/ -name "*.lean" 2>/dev/null | grep -i "$FUNCTION_NAME"
```

- If found: confirm with user
- If not found: suggest running `/fvs:lean-spec-port` first to generate the spec, then exit

**Parse flags:**
- `--scan` flag: enable comparison table mode
- `--max-attempts N`: set max proof attempts (default 10, hard cap 25)

```bash
MAX_ATTEMPTS="${MAX_ATTEMPTS:-10}"
if [ "$MAX_ATTEMPTS" -gt 25 ]; then
  MAX_ATTEMPTS=25
fi
```

**Count sorry in spec file:**
```bash
SORRY_COUNT=$(grep -c "sorry" "$SPEC_PATH")
```

If zero sorry: run `nice -n 19 lake build` to confirm VERIFIED, then exit.
If sorry found: extract theorem names and continue.
</step>

<step name="resolve_models">
Read config and resolve models for subagent dispatch.

```bash
CONFIG=$(cat .formalising/fvs-config.json 2>/dev/null || echo '{"model_profile":"quality","model_overrides":{}}')
```

Resolution sequence:
1. Parse `model_profile` from config (default: `"quality"`)
2. Check `model_overrides` for `"fvs-researcher"` and `"fvs-executor"`
3. If no override, look up profile table for the agent and profile
4. Store resolved models as `RESEARCH_MODEL` and `EXECUTOR_MODEL`

Reference: fv-skills/references/model-profiles.md (profile table and dispatch pattern)
</step>

<step name="research_phase">
Dispatch **fvs-researcher** subagent in proof-port mode to analyze the source proof
and map strategies to Lean tactics.

**Read and inline reference files before dispatch:**
- fv-skills/references/tactic-usage.md (core tactics: progress, simp, omega, grind, bvify)
- fv-skills/references/proof-strategies.md (patterns for common proof shapes)
- fv-skills/references/lean-spec-conventions.md (spec structure expectations)

**Researcher tasks:**
1. If SCAN_MODE: scan both projects, build comparison table, return for user selection
2. Read the existing Lean spec file and identify all sorry locations with goal descriptions
3. Read the source proof and extract strategy (NOT structure):
   - Verus: look for `proof fn` / `proof { }` blocks matching the function
   - F*: look for `val`/`let` with proof terms
   - Coq: look for `Proof...Qed` blocks
   - Dafny: look for `method`/`lemma` bodies
4. Assess structural mirroring feasibility: is the source proof structure adaptable
   to Lean tactics, or must we extract strategy only?
5. For each sorry, map source proof strategy to Lean tactic equivalents using the
   tactic mapping reference block below
6. Identify key insights from source proof: which bounds matter, which case splits
   are needed, which lemmas are invoked, what mathematical properties are used
7. Check target project for available mathlib lemmas, project-specific bridges
   (Math/ directory), Aeneas-specific lemmas
8. Recommend order to tackle sorry (easiest first, or dependency order) with tactic
   suggestions per sorry

**Expected output:** Structured findings with sorry analysis, source proof insights,
tactic recommendations, and recommended order. Ends with `## RESEARCH COMPLETE`.

**If --scan mode:** Researcher returns comparison table instead:
```
| Function | Source | Lean | Action |
|----------|--------|------|--------|
| ... | [OK] Verified | [??] Has sorry | Port proof |
| ... | [OK] Verified | [--] No spec | Port spec+proof |
```

After user selects a function: re-dispatch research in normal mode for that function.

**If researcher returns ## ERROR:** Display the error and stop.
</step>

<step name="iterative_execute_phase">
Dispatch **fvs-executor** subagent iteratively, ONE SORRY AT A TIME.

This is the core proof-porting loop. LOCKED DECISION: one sorry at a time, small
tactic blocks, user checks Lean compiles between each step. Pair programming feel.

For each sorry (in order recommended by research):

1. **Display status:**
   ```
   >> Attempting sorry {N}/{TOTAL}: {goal description}
   >> Source proof insight: {relevant insight from research}
   ```

2. **Re-read spec file** each iteration (content changes after each successful step)

3. **Dispatch fvs-executor** in proof-port mode with:
   - Research findings (full context from researcher)
   - Current spec file content (re-read each iteration!)
   - Target sorry number and goal state
   - `<source_proof_insight>` tag with relevant insight for this sorry
   - `<tactic_suggestion>` tag with recommended tactic from research
   - User feedback from previous attempt (if any)
   - Attempt counter
   - Anti-patterns block (see below)

4. **Route on executor return:**

   **## EXECUTION COMPLETE:**
   - Remind user: "Check compilation: `nice -n 19 lake build`"
   - Wait for user feedback on whether Lean compiles
   - If compiles: mark sorry as resolved, move to next sorry
   - If does not compile: store error as feedback, retry

   **## NEEDS INPUT:**
   - Present executor's question to user (what it tried, what it needs)
   - Wait for user response: hint, invariant, lemma pointer, or "skip"
   - If hint provided: store as feedback, retry
   - If "skip": mark sorry as stuck, move to next sorry

   **## ERROR:**
   - Display error, increment attempt counter, retry or move on

5. **Per-sorry attempt limit:** 3 attempts (MAX_PER_SORRY=3). After 3 failed attempts,
   mark as stuck and continue to next sorry.

6. **Total hard cap:** 25 total executor dispatches across all sorry. Never exceed.

**LOCKED BEHAVIORAL CONSTRAINTS:**
- One sorry at a time (never batch multiple sorry in one executor dispatch)
- Small tactic blocks: have, calc, unfold + progress, grind, omega (1-3 lines max)
- User checks Lean compiles between each step
- Feels like pair programming: propose, check, adjust
- All writes via VS Code diffs (Write tool)
</step>

<step name="validate_and_report">
After all sorry have been attempted, classify the result and report.

**Status classification:**
- **VERIFIED:** All sorry resolved, zero remaining
- **PARTIAL:** Some sorry resolved, some remain
- **STUCK:** No sorry resolved

**Display summary:**
```
FVS >> PROOF PORT {STATUS}

Source:    {source_lang} ({source_path})
File:      {spec_file}
Resolved:  {N}/{TOTAL} sorry
Stuck:     {M}
Status:    {VERIFIED | PARTIAL | STUCK}
```

**Update CODEMAP.md** if it exists (via Write tool):
- VERIFIED: change status to `[OK]`
- PARTIAL/STUCK: change status to `[??]`
</step>

<step name="suggest_next">
Port-aware next steps based on outcome.

**If VERIFIED:**
```
>> Next Up

/fvs:lean-simplify {spec_path} to optimize the proof
/fvs:plan to select next verification target
```

**If PARTIAL or STUCK:**
```
>> Options

- Provide a hint and run /fvs:lean-proof-port again
- /fvs:lean-verify {spec_path} to try tactics without source proof context
- /fvs:plan to try a different target
- /fvs:lean-specify {function_name} to regenerate the spec with different postconditions
```
</step>

</process>

<tactic_mapping>

## Source-to-Lean Tactic Mapping Reference

This mapping is inlined into executor prompts to guide tactic selection when porting
proofs from other formal verification languages.

### Verus-to-Lean Mapping

| Verus Pattern | Lean Tactic | When to Use |
|---------------|-------------|-------------|
| `assert(x < y) by (compute)` | `grind` or `omega` | Numeric bounds, simple arithmetic |
| `assert(a == b) by { lemma_foo(a, b); }` | `grind` after `have := lemma_foo a b` | Equality after lemma application |
| `lemma_add_mod_noop(a, b, p)` | `grind` or `Nat.add_mod a b p` | Modular arithmetic identities |
| `assert(((1u64 << 54) - 1) <= u64::MAX - c) by (compute)` | `grind` or `omega` or `norm_num` | Concrete numeric computation |
| `assert(self.limbs =~= spec_add.limbs)` | `ext; grind` or `grind [Subtype.ext]` | Array/struct extensional equality |
| `assert(...) by (bit_vector)` | `bvify N; bv_decide` | Bitwise operations (AND, OR, shift) |
| `lemma_mul_le(a, max_a, b, max_b)` | `gcongr` or `grind` | Monotonicity of multiplication |

### General Mapping (All Source Languages)

| Source Concept | Lean Tactic | Notes |
|----------------|-------------|-------|
| SMT/automated reasoning | `grind` | Primary SMT-like tactic in Lean (282 uses in target project) |
| Linear arithmetic | `omega` | Pure Nat/Int linear arithmetic |
| Ring/field equalities | `ring` or `field_simp` | Algebraic identities |
| Bitwise operations | `bvify N; bv_decide` | Lifts to N-bit bitvectors, then decides |
| Case analysis | `interval_cases` or `grind only [cases eager Prod]` | Bounded finite domains |
| Monotonicity | `gcongr` | Congruence for inequalities |
| Rewriting | `simp` with specific lemmas | Targeted simplification |
| Decidable propositions | `decide` or `native_decide` | Only for small instances |
| Aeneas monadic code | `unfold` + `progress` / `progress*` | Always start here for Aeneas proofs |
| Scalar bounds | `scalar_tac` | Aeneas scalar type bounds |

### Key Insight

Do NOT map source SMT reasoning to `omega`/`simp`/`decide` alone. The primary analog
is `grind`, which handles the same class of reasoning (arithmetic, equality, case
analysis) that SMT solvers handle. Use `omega` for pure linear arithmetic, `simp` for
rewriting, and `decide`/`native_decide` for decidable propositions. Use `bvify` +
`bv_decide` for bitwise operations.

</tactic_mapping>

<anti_patterns>

## Anti-Patterns for Proof Porting

These anti-patterns are inlined into executor prompts to prevent common mistakes.

### 1. Do NOT structurally mirror source proofs
Source proofs (especially Verus) rely on SMT solvers (Z3) for automated reasoning.
Translating `assert` chains one-to-one produces Lean proofs that do not work because
the proof assistants have fundamentally different automation. Extract the STRATEGY
(what bounds to prove, what case splits to make, what lemmas to invoke) but NOT the
structure.

### 2. Do NOT underuse grind
`grind` is Lean's SMT-like tactic and is the primary workhorse in verified Lean projects
(282 occurrences in the target project). Agents that default to `omega`/`simp` chains
when `grind` would close the goal in one step are wasting iterations. When in doubt,
try `grind` first.

### 3. Do NOT use omega/simp for bitwise proofs
Bitwise operations (AND, OR, shift, masking) require `bvify N; bv_decide`, NOT `omega`
or `simp`. `bvify` lifts Nat statements to bitvector form, and `bv_decide` decides the
bitvector proposition.

### 4. Do NOT copy vstd imports into Lean
Verus uses `vstd::arithmetic::div_mod::lemma_add_mod_noop` etc. Lean has `Nat.add_mod`
in Mathlib or `grind`/`omega` can close many such goals. Never reference vstd in Lean.

### 5. Do NOT generate named spec predicates in Lean
In Verus, `u64_5_bounded(limbs, 54)` is a named predicate used across many files. In
Lean, the convention is inline hypotheses: `(ha : forall i < 5, a[i]!.val < 2 ^ 54)`.
Follow the target Lean project's convention, not the source's.

### 6. Do NOT ignore Math/ bridges in target project
The Lean project may have sophisticated mathematical bridges (e.g., `Math/Basic.lean`
with `Field51_as_Nat`, `Scalar52_as_Nat`, `p`, `L`). These MUST be used instead of
reinventing them from the source side.

### 7. Do NOT run plain lake build
Always use `nice -n 19 lake build` (FVS convention).

</anti_patterns>

<success_criteria>
- Spec file located and sorry confirmed present
- Source language, project path, and function name collected via interactive prompts
- Config read and models resolved for fvs-researcher and fvs-executor
- Research subagent gathered source proof analysis, tactic mapping, sorry recommendations
- Source proof used as strategy blueprint (not structural mirror)
- Executor dispatched iteratively per sorry (one at a time, small tactic blocks)
- User checks Lean compiles between each step (pair programming feel)
- NEEDS INPUT handling for stuck proofs with user hint collection
- Per-sorry attempt limit (3) and total hard cap (25) enforced
- Build checks use nice -n 19 lake build (never plain lake build)
- Source proof insights inlined per sorry (grind for SMT, bvify + bv_decide for bitwise)
- Anti-patterns enforced: no structural mirroring, no underusing grind, no omega for bitwise
- Result correctly classified as VERIFIED, PARTIAL, or STUCK
- Interactive iteration loop handles hints, retries, and escalation
- CODEMAP.md updated with verification status if available
</success_criteria>
