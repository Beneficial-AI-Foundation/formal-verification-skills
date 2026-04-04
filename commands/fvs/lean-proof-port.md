---
name: fvs:lean-proof-port
description: Port formal verification proof from another language to Lean
argument-hint: "[--scan] [--max-attempts N] (interactive prompts for source language, path, function)"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
  - Task
---

<objective>
Port a formal verification proof from another language (Verus, F*, Coq, Dafny) to Lean, using the source proof as a strategy blueprint (not structural mirror). Follows the lean-verify iterative pattern (one sorry at a time) with an additional research phase that analyzes the source proof for strategy insights.

This is the most complex porting command -- it combines cross-project analysis (from lean-spec-port) with iterative proof development (from lean-verify). The source proof provides WHAT needs to be proven and KEY INSIGHTS (bounds, case splits, lemma selection), but the proof is built using Lean tactics, not translated syntactically.

LOCKED DECISION: One sorry at a time. Small tactic blocks. User checks Lean compiles between each step. Pair programming feel.
</objective>

<execution_context>
@~/.claude/fv-skills/workflows/lean-proof-port.md
@~/.claude/fv-skills/references/ui-brand.md
</execution_context>

<context>
Arguments: $ARGUMENTS (optional flags: --scan, --max-attempts N)

Parse --scan flag and --max-attempts from $ARGUMENTS:
- Default max-attempts: 10
- Hard cap: 25 (never exceed regardless of user request)
- If no --scan: set SCAN_MODE=false

- Check for .formalising/CODEMAP.md for dependency context
- Track iteration count in command scope (agents are stateless per Task() invocation)
</context>

<process>

## Step 1: Parse Arguments and Detect Flags

Parse $ARGUMENTS for optional flags:

```bash
SCAN_MODE=false
MAX_ATTEMPTS=10

# Parse flags from $ARGUMENTS
# --scan: enable comparison table mode
# --max-attempts N: set max proof attempts per sorry
```

Hard cap: never exceed 25 regardless of user request.

```bash
if [ "$MAX_ATTEMPTS" -gt 25 ]; then
  MAX_ATTEMPTS=25
fi
```

## Step 2: Collect Parameters via Interactive Prompts

Collect source language, project path, function name, and Lean spec file path interactively.

**Source language:**
```
FVS >> PROOF PORT

What source language are you porting from?
  1. Verus
  2. F*
  3. Coq
  4. Dafny
  5. Other (specify)
```

Use AskUserQuestion to collect the source language selection.

**Source project path:**

```
Path to source project?
```

Use AskUserQuestion to collect the source project path. Validate it exists:

```bash
[ -d "$SOURCE_PROJECT_PATH" ] && echo "Project found" || echo "Project not found"
```

**Function name:**

```
Function to port proof for? (Lean or Rust name)
```

Use AskUserQuestion to collect the function name.

**Lean spec file path:**

Auto-detect the Lean spec file path by searching the Specs/ directory:

```bash
find Specs/ -name "*.lean" 2>/dev/null | grep -i "$FUNCTION_NAME" || echo "No matching spec found"
```

- If found: confirm with user
- If not found: suggest running `/fvs:lean-spec-port` first to generate the spec, then exit

```
No Lean spec found for $FUNCTION_NAME.

Run /fvs:lean-spec-port first to generate the spec from the source language.
```

Use AskUserQuestion to confirm the spec file path if auto-detected.

## Step 3: Read Config and Resolve Models

Read the project config to determine which models to use for subagent dispatch:

```bash
CONFIG=$(cat .formalising/fvs-config.json 2>/dev/null || echo '{"model_profile":"quality","model_overrides":{}}')
```

Resolve models using the profile table from `fv-skills/references/model-profiles.md`:

1. Parse `model_profile` from config (default: `"quality"`)
2. Check `model_overrides` for `"fvs-researcher"` and `"fvs-executor"`
3. If no override, look up profile table:
   - quality: fvs-researcher=inherit, fvs-executor=inherit
   - balanced: fvs-researcher=sonnet, fvs-executor=sonnet
   - budget: fvs-researcher=haiku, fvs-executor=sonnet
4. Store resolved models as `RESEARCH_MODEL` and `EXECUTOR_MODEL`

## Step 4: Read Reference Files for Inlining

Read the reference files that MUST be inlined into Task() prompts because @-references do not cross Task boundaries:

```bash
TACTIC_USAGE=$(cat ~/.claude/fv-skills/references/tactic-usage.md)
PROOF_STRATEGIES=$(cat ~/.claude/fv-skills/references/proof-strategies.md)
SPEC_CONVENTIONS=$(cat ~/.claude/fv-skills/references/lean-spec-conventions.md)
```

Also read the spec file content for inlining:

```bash
SPEC_FILE_CONTENT=$(cat "$SPEC_PATH")
```

All must be captured as content strings for inlining into subagent prompts.

## Step 5: Count Sorry in Spec File

```bash
SORRY_COUNT=$(grep -c "sorry" "$SPEC_PATH")
echo "Found $SORRY_COUNT sorry to resolve"
```

If zero sorry: spec may already be proved. Run build check to confirm:

```bash
nice -n 19 lake build 2>&1 | tail -20
```

- If build clean: report VERIFIED status and exit.
- If build errors: report errors and exit.

If sorry found: extract theorem names and continue.

```bash
grep -E "@\[progress\]|theorem " "$SPEC_PATH"
```

## Step 6: Dispatch Research Subagent (proof-port mode)

```
Task(
  subagent_type="fvs-researcher",
  model="$RESEARCH_MODEL",
  description="Research proof porting context from $SOURCE_LANG for $FUNCTION_NAME",
  prompt="Research mode: proof-port

<source_language>$SOURCE_LANG</source_language>
<source_project_path>$SOURCE_PROJECT_PATH</source_project_path>
<target_function>$FUNCTION_NAME</target_function>
<spec_file_path>$SPEC_FILE_PATH</spec_file_path>
<spec_content>$SPEC_FILE_CONTENT</spec_content>
<scan_mode>$SCAN_MODE</scan_mode>

<tactic_usage>
$TACTIC_USAGE_CONTENT
</tactic_usage>

<proof_strategies>
$PROOF_STRATEGIES_CONTENT
</proof_strategies>

<spec_conventions>
$SPEC_CONVENTIONS_CONTENT
</spec_conventions>

Tasks:
1. If SCAN_MODE: scan both projects, build comparison table, return for user selection
2. Read the existing Lean spec file and identify all sorry locations with goal descriptions
3. Read the source proof:
   - Verus: look for proof fn / proof blocks matching the function
   - F*: look for val/let with proof terms
   - Coq: look for Proof...Qed blocks
   - Dafny: look for method/lemma bodies
4. Assess structural mirroring feasibility: is the source proof structure adaptable to Lean tactics, or must we extract strategy only?
5. For each sorry, map source proof strategy to Lean tactic equivalents:
   - Verus assert by (compute) -> grind (primary) or omega/norm_num
   - Verus assert(...) by (bit_vector) -> bvify N; bv_decide
   - Verus lemma_add_mod_noop -> grind or Nat.add_mod
   - Verus assert(a =~= b) -> ext; grind or grind [Subtype.ext]
   - Verus lemma_mul_le -> gcongr or grind
6. Identify key insights from source proof: which bounds matter, which case splits are needed, which lemmas are invoked, what mathematical properties are used
7. Check target project for available mathlib lemmas, project-specific bridges (Math/ directory), Aeneas-specific lemmas
8. Recommend order to tackle sorry (easiest first, or dependency order) with tactic suggestions per sorry

Return with ## RESEARCH COMPLETE"
)
```

Parse the returned research findings to get:
- List of sorry locations with goal descriptions
- Recommended order to tackle them
- Tactic suggestions per sorry based on source proof INSIGHT
- Key insights extracted from source proof
- Related proof examples from the target project

## Step 7: Handle --scan Mode Results

If SCAN_MODE is true, the researcher returns a comparison table instead of per-sorry analysis.

Display the comparison table:

```
FVS >> COMPARISON: {source_lang} ({source_project_path}) vs Lean project

| Function | Source | Lean | Action |
|----------|--------|------|--------|
| ... | [OK] Verified | [OK] Verified | Skip |
| ... | [OK] Verified | [??] Has sorry | Port proof |
| ... | [OK] Verified | [--] No spec | Port spec+proof |

Verified in source but not in Lean: N functions
Ready to port: Pick a function above.
```

Use AskUserQuestion to let the user select a function from the table.

After selection: re-run the research phase with SCAN_MODE=false for the selected function.

## Step 8: Iterative Executor Dispatch (One Sorry at a Time -- LOCKED DECISION)

```
SORRY_RESOLVED=0
SORRY_STUCK=0
SORRY_REMAINING=$SORRY_COUNT

FOR EACH SORRY (in recommended order from research):

  Display:
  >> Attempting sorry {N}/{TOTAL}: {goal description}
  >> Source proof insight: {relevant insight from research}

  ATTEMPT_FOR_THIS_SORRY=0
  MAX_PER_SORRY=3

  WHILE ATTEMPT_FOR_THIS_SORRY < MAX_PER_SORRY:

    # Re-read spec file each iteration (it changes!)
    CURRENT_SPEC=$(cat "$SPEC_PATH")

    Task(
      subagent_type="fvs-executor",
      model="$EXECUTOR_MODEL",
      description="Prove sorry {N} in $SPEC_FILE using source proof insights",
      prompt="Execute mode: proof-port

<research_findings>
$RESEARCH_SUBAGENT_OUTPUT
</research_findings>

<current_spec>
$CURRENT_SPEC_FILE_CONTENT (re-read each iteration!)
</current_spec>

<target_sorry>sorry #{N}</target_sorry>
<goal_state>{goal from research findings}</goal_state>
<source_proof_insight>{relevant insight from source proof for this sorry}</source_proof_insight>
<tactic_suggestion>{recommended tactic from research}</tactic_suggestion>

<user_feedback>
$PREVIOUS_FEEDBACK (empty on first attempt, Lean error or user hint after)
</user_feedback>

<attempt>{ATTEMPT_FOR_THIS_SORRY} of {MAX_PER_SORRY}</attempt>

Write a SMALL tactic block to replace this ONE sorry.
Use the source proof INSIGHT (not structure) to guide your tactic selection.

Primary tactic mapping:
- SMT/compute reasoning -> grind (Lean's SMT-like tactic, 282 uses in target project)
- Bitwise operations -> bvify N; bv_decide
- Linear arithmetic -> omega
- Algebraic simplification -> ring or field_simp
- Monotonicity -> gcongr
- Case analysis -> grind only [cases eager Prod]
- Rewriting -> simp with specific lemmas

Do NOT:
- Mirror source proof structure one-to-one
- Use omega/simp for bitwise proofs (use bvify + bv_decide)
- Copy vstd imports or concepts into Lean
- Underuse grind (it is the primary tactic in the target project)

Explain your reasoning before writing.
IMPORTANT: Write the change using Write tool (VS Code diff).

If stuck, return ## NEEDS INPUT with what you need.
If successful, return ## EXECUTION COMPLETE"
    )

    AFTER EACH EXECUTOR RETURN:

    If ## EXECUTION COMPLETE:
      - Remind user: "Check compilation: nice -n 19 lake build"
      - Wait for user feedback on whether Lean compiles
      - If compiles: SORRY_RESOLVED += 1, break inner loop, move to next sorry
      - If does not compile: store error as PREVIOUS_FEEDBACK, ATTEMPT_FOR_THIS_SORRY += 1

    If ## NEEDS INPUT:
      - Present to user: the executor's question, what it tried, what it needs
      - Wait for user response (hint, invariant, lemma pointer)
      - If user provides hint: store as PREVIOUS_FEEDBACK, ATTEMPT_FOR_THIS_SORRY += 1
      - If user says "skip": mark as STUCK, break inner loop, move to next sorry

    If ## ERROR:
      - Display error to user
      - ATTEMPT_FOR_THIS_SORRY += 1

  END WHILE

  If ATTEMPT_FOR_THIS_SORRY >= MAX_PER_SORRY:
    Mark this sorry as STUCK
    SORRY_STUCK += 1
    Display: ">> sorry {N} stuck after {MAX_PER_SORRY} attempts. Moving to next."

END FOR
```

**CRITICAL LOCKED DECISIONS:**
- One sorry at a time (not batch)
- Small tactic blocks (have, calc, unfold + progress, grind, omega)
- User checks Lean compiles between each step
- Feels like pair programming
- All writes via VS Code diffs

## Step 9: Display Summary

```
FVS >> PROOF PORT {STATUS}

Source:    {source_lang} ({source_project_path})
File:      {spec_file}
Resolved:  {SORRY_RESOLVED}/{SORRY_COUNT} sorry
Stuck:     {SORRY_STUCK}
Status:    {VERIFIED | PARTIAL | STUCK}
```

**Status classification:**
- **VERIFIED:** All sorry resolved, zero remaining
- **PARTIAL:** Some sorry resolved, some remain
- **STUCK:** No sorry resolved

## Step 10: Update CODEMAP.md Verification Status

If .formalising/CODEMAP.md exists, update the function's status:

```bash
[ -f ".formalising/CODEMAP.md" ] && echo "CODEMAP exists" || echo "No CODEMAP"
```

Update via Write tool (VS Code diff):
- Verified: change status to `[OK]`
- Still has sorry: change status to `[??]`
- Build error: change status to `[XX]`

## Step 11: Suggest Next Steps

**If VERIFIED:**

```
>> Next Up

/fvs:lean-refactor {spec_path} to optimize the proof
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

</process>

<success_criteria>
- [ ] Source language collected via interactive prompt (AskUserQuestion)
- [ ] Source project path collected and validated
- [ ] Function name collected via interactive prompt (AskUserQuestion)
- [ ] Lean spec file auto-detected or suggested lean-spec-port
- [ ] Config read and models resolved for fvs-researcher and fvs-executor
- [ ] Research subagent dispatched with inlined tactic-usage, proof-strategies, spec-conventions
- [ ] Research extracted source proof INSIGHT (not structure) and mapped to Lean tactics
- [ ] --scan flag enables comparison table with user function selection
- [ ] Executor dispatched iteratively per sorry (one at a time, not batch)
- [ ] Each executor writes small tactic blocks via VS Code diff
- [ ] User checks Lean compiles between each step (pair programming feel)
- [ ] NEEDS INPUT handling for stuck proofs with user hint collection
- [ ] Max-attempts guardrail enforced per sorry (MAX_PER_SORRY=3) and total (25 hard cap)
- [ ] Build checks use nice -n 19 lake build (never plain lake build)
- [ ] Source proof insight used to guide tactic selection (grind for SMT, bvify + bv_decide for bitwise)
- [ ] Anti-patterns enforced: no structural mirroring, no underusing grind, no omega for bitwise
- [ ] Result correctly classified as VERIFIED, PARTIAL, or STUCK
- [ ] CODEMAP.md updated with verification status if available
- [ ] Clear next steps offered based on outcome
</success_criteria>
