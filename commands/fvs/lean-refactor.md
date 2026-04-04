---
name: fvs:lean-refactor
description: Refactor, simplify, and decompose verified Lean proofs while preserving compilation
argument-hint: "<spec_file_path> [--theorem name] [--mode safe|balanced|aggressive] [--max-passes N] [--report-only]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
  - Task
---

<objective>
Orchestrate proof refactoring for a verified Lean spec using three-phase subagent dispatch (baseline -> research -> iterative refactor). Dispatches fvs-researcher for 3-lens analysis, then iteratively dispatches fvs-lean-refactorer to apply tiered heuristics ONE CHANGE AT A TIME, verifying compilation after each.

This command sits after `/fvs:lean-verify` in the verification lifecycle. The input spec must compile with zero sorry. The output is the same spec with shorter, cleaner, more maintainable proofs.

Output: Refactored spec file with before/after metrics, or NO_CHANGE report if proofs are already clean.
</objective>

<execution_context>
@~/.claude/fv-skills/workflows/lean-refactor.md
@~/.claude/fv-skills/references/ui-brand.md
</execution_context>

<context>
Spec file path: $ARGUMENTS (required -- path to spec .lean file).

Parse flags from $ARGUMENTS:
- `--theorem name` -- scope to a single theorem (default: all theorems)
- `--mode safe|balanced|aggressive` -- refactoring mode (default: balanced)
- `--max-passes N` -- max passes per theorem (default: 5, cap: 20)
- `--report-only` -- run research analysis but do not apply changes

- Check for .formalising/CODEMAP.md for dependency context
- Track iteration count in command scope (agents are stateless per Task() invocation)
</context>

<process>

## Step 1: Parse Arguments

Parse $ARGUMENTS for spec file path and optional flags:

```bash
SPEC_PATH="(parsed from $ARGUMENTS, excluding flags)"
THEOREM_FILTER="(parsed from --theorem flag, default: all)"
MODE="(parsed from --mode flag, default: balanced)"
MAX_PASSES="(parsed from --max-passes flag, default: 5)"
REPORT_ONLY="(parsed from --report-only flag, default: false)"

# Hard cap: never exceed 20
if [ "$MAX_PASSES" -gt 20 ]; then
  MAX_PASSES=20
fi

[ -f "$SPEC_PATH" ] && echo "Spec found" || echo "Spec not found"
```

If not found: list available specs and suggest `/fvs:lean-specify`.

```bash
find Specs/ -name "*.lean" 2>/dev/null
```

Wait for valid path.

## Step 2: Baseline Build Check

Confirm file exists, run build, confirm zero sorry.

```bash
# Check for sorry
SORRY_COUNT=$(grep -c "sorry" "$SPEC_PATH")
echo "Sorry count: $SORRY_COUNT"
```

If sorry found: direct to `/fvs:lean-verify $SPEC_PATH`. STOP.

```bash
# Build check
nice -n 19 lake build 2>&1 | tail -20
```

If build fails: report error and STOP.

**Gather baseline metrics:**

```bash
TOTAL_LINES=$(wc -l < "$SPEC_PATH")
THEOREM_COUNT=$(grep -c "@\[progress\]\|theorem " "$SPEC_PATH")
TACTIC_LINES=$(grep -cE "^\s+(unfold|progress|simp|omega|scalar_tac|ring|field_simp|have|obtain|rw|by_cases|interval_cases|grind|aesop|bvify|bv_decide)" "$SPEC_PATH")
echo "Baseline: $TOTAL_LINES lines, $THEOREM_COUNT theorems, $TACTIC_LINES tactic lines"
```

## Step 3: Read Config and Resolve Models

Read the project config to determine which models to use for subagent dispatch:

```bash
CONFIG=$(cat .formalising/fvs-config.json 2>/dev/null || echo '{"model_profile":"quality","model_overrides":{}}')
```

Resolve models using the profile table from `fv-skills/references/model-profiles.md`:

1. Parse `model_profile` from config (default: `"quality"`)
2. Check `model_overrides` for `"fvs-researcher"` and `"fvs-lean-refactorer"`
3. If no override, look up profile table:
   - quality: fvs-researcher=inherit, fvs-lean-refactorer=inherit
   - balanced: fvs-researcher=sonnet, fvs-lean-refactorer=sonnet
   - budget: fvs-researcher=haiku, fvs-lean-refactorer=sonnet
4. Store resolved models as `RESEARCH_MODEL` and `REFACTORER_MODEL`

## Step 4: Read Reference Files for Inlining

Read the reference files that MUST be inlined into Task() prompts because @-references do not cross Task boundaries:

```bash
LEAN_REFACTORING=$(cat ~/.claude/fv-skills/references/lean-refactoring.md)
TACTIC_USAGE=$(cat ~/.claude/fv-skills/references/tactic-usage.md)
PROOF_STRATEGIES=$(cat ~/.claude/fv-skills/references/proof-strategies.md)
```

All three must be captured as content strings for inlining into subagent prompts.

## Step 5: Dispatch Research Subagent

```
Task(
  subagent_type="fvs-researcher",
  model="$RESEARCH_MODEL",
  description="Research refactoring context for $SPEC_FILE",
  prompt="Research mode: lean-refactor

<spec_file_path>$SPEC_PATH</spec_file_path>
<spec_content>
$SPEC_FILE_CONTENT
</spec_content>

<lean_refactoring>
$LEAN_REFACTORING_CONTENT
</lean_refactoring>

<tactic_usage>
$TACTIC_USAGE_CONTENT
</tactic_usage>

<proof_strategies>
$PROOF_STRATEGIES_CONTENT
</proof_strategies>

Tasks:
1. Read the spec file and identify all theorem proofs (not sorry)
2. Read the corresponding function body from Funs.lean for structural context
3. Search for similar proved theorems in the project to identify reuse patterns
4. For each theorem proof, apply the 3-lens analysis (reuse, quality, efficiency)
5. Return structured findings with per-theorem refactoring recommendations
6. Classify each recommendation by tier (1-4)

Return with ## RESEARCH COMPLETE"
)
```

Parse the returned research findings to get:
- Per-theorem analysis with tier-classified recommendations
- Recommended refactoring order
- Shared patterns across theorems

**If --report-only:** Display research findings and exit. No refactoring passes.

## Step 6: Iterative Refactorer Dispatch

For each theorem (in order from research recommendations, filtered by --theorem if set):

```
PASS=0
WHILE PASS < MAX_PASSES:

  # Re-read spec each iteration (it changes!)
  CURRENT_SPEC=$(cat "$SPEC_PATH")

  Task(
    subagent_type="fvs-lean-refactorer",
    model="$REFACTORER_MODEL",
    description="Refactor {theorem_name} pass {PASS+1}",
    prompt="<refactoring_reference>$LEAN_REFACTORING_CONTENT</refactoring_reference>
    <research_findings>$RESEARCH_OUTPUT</research_findings>
    <current_spec>$CURRENT_SPEC</current_spec>
    <target_theorem>{theorem_name}</target_theorem>
    <mode>{MODE}</mode>
    <pass>{PASS+1} of {MAX_PASSES}</pass>
    <previous_feedback>{build errors from last pass, if any}</previous_feedback>

    Apply ONE refactoring from the highest applicable tier within the mode ceiling.
    Write via Write tool. User approves inline."
  )

  ROUTE ON RETURN:
    ## REFACTORED:
      Run: nice -n 19 lake build
      If build passes: record change, PASS += 1, continue
      If build fails: REVERT the change (re-write previous content), store error as feedback, PASS += 1
    ## NO_CHANGE:
      Break -- no more refactorings possible for this theorem
    ## ERROR:
      Store error, PASS += 1

END WHILE
```

Move to next theorem after max passes or NO_CHANGE.

## Step 7: Display Summary

```
FVS >> REFACTORING {STATUS}

File:      {spec_file}
Mode:      {MODE}
Theorems:  {N} processed
Changes:   {total changes applied}
Lines:     {before} -> {after} ({delta})
Status:    REFACTORED | NO_CHANGE | ERROR
```

**Status classification:**
- **REFACTORED:** At least one change applied and build passes
- **NO_CHANGE:** No refactorings possible at current mode's tier ceiling
- **ERROR:** Build failures that could not be reverted

## Step 8: Update CODEMAP.md If Exists

If .formalising/CODEMAP.md exists, verification status remains [OK] (refactoring preserves verification -- zero sorry before and after).

```bash
[ -f ".formalising/CODEMAP.md" ] && echo "CODEMAP exists" || echo "No CODEMAP"
```

No status change needed -- spec remains verified.

## Step 9: Suggest Next Steps

**If REFACTORED:**

```
>> Proof refactored. Consider committing the changes.

git add {spec_path}
git commit -m "refactor: clean up {function_name} proof"

/fvs:plan to select next verification target
```

**If NO_CHANGE:**

```
>> Proofs are already clean at the {mode} tier ceiling.

Try --mode aggressive for more aggressive refactoring.
/fvs:plan to select next verification target
```

</process>

<success_criteria>
- [ ] Spec file located and zero sorry confirmed
- [ ] Baseline build check passes with nice -n 19 lake build
- [ ] Config read and models resolved for fvs-researcher and fvs-lean-refactorer
- [ ] Research subagent dispatched with inlined lean-refactoring, tactic-usage, proof-strategies
- [ ] 3-lens analysis returned with per-theorem recommendations
- [ ] Report-only mode stops after research phase when flag is set
- [ ] Refactorer dispatched iteratively per theorem (one change at a time)
- [ ] Build check after every change with nice -n 19 lake build (never plain lake build)
- [ ] Failed changes reverted and error stored as feedback
- [ ] Max-passes cap enforced (default 5, hard cap 20)
- [ ] Result correctly classified as REFACTORED, NO_CHANGE, or ERROR
- [ ] Before/after metrics displayed
- [ ] Clear next steps offered based on outcome
</success_criteria>
