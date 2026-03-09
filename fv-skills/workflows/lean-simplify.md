<purpose>
Orchestrate proof simplification for a Lean spec file using three-phase dispatch:
baseline check, research (3-lens analysis), iterative simplification passes.

Takes a verified spec file (zero sorry, compiles clean) and applies tiered heuristics
to reduce proof verbosity while preserving correctness. Every change is verified with
a build check. The simplifier agent makes ONE change per invocation, and the workflow
loops until no more changes are possible or max passes are reached.

Output: Simplified spec file with before/after metrics, or NO_CHANGE if already clean.
</purpose>

<process>

<step name="baseline_check">
Validate the spec file exists AND compiles with zero sorry.

```bash
[ -f "$SPEC_PATH" ] && echo "Spec found" || echo "Spec not found"
```

**If not found:**
```
Spec file not found: $SPEC_PATH

Available specs:
$(find Specs/ -name "*.lean" 2>/dev/null)

Generate one first: /fvs:lean-specify function_name
```

**Check for sorry:**
```bash
SORRY_COUNT=$(grep -c "sorry" "$SPEC_PATH")
```

If sorry found: STOP. Report "Proof contains sorry -- simplification requires fully verified proofs. Run `/fvs:lean-verify $SPEC_PATH` first."

**Build check:**
```bash
nice -n 19 lake build 2>&1 | tail -20
```

If build fails: STOP. Report build errors.

**Parse flags:**
- `--theorem name` -- scope to a single theorem (default: all theorems in file)
- `--mode safe|balanced|aggressive` -- simplification mode (default: balanced)
- `--max-passes N` -- maximum simplification passes per theorem (default: 5, cap: 20)
- `--report-only` -- run research analysis but do not apply changes

**Gather baseline metrics:**
```bash
TOTAL_LINES=$(wc -l < "$SPEC_PATH")
THEOREM_COUNT=$(grep -c "@\[progress\]\|theorem " "$SPEC_PATH")
TACTIC_LINES=$(grep -cE "^\s+(unfold|progress|simp|omega|scalar_tac|ring|field_simp|have|obtain|rw|by_cases|interval_cases|grind|aesop|bvify|bv_decide|gcongr|bound|subst_vars|refine|exact|apply|intro|calc)" "$SPEC_PATH")
```
</step>

<step name="resolve_models">
Read config and resolve models for subagent dispatch.

```bash
CONFIG=$(cat .formalising/fvs-config.json 2>/dev/null || echo '{"model_profile":"quality","model_overrides":{}}')
```

Resolution sequence:
1. Parse `model_profile` from config (default: `"quality"`)
2. Check `model_overrides` for `"fvs-researcher"` and `"fvs-lean-simplifier"`
3. If no override, look up profile table for the agent and profile
4. Store resolved models as `RESEARCH_MODEL` and `SIMPLIFIER_MODEL`

Reference: fv-skills/references/model-profiles.md (profile table and dispatch pattern)
</step>

<step name="research_phase">
Dispatch **fvs-researcher** subagent in lean-simplify mode for 3-lens analysis.

Read and inline reference files before dispatch:
- fv-skills/references/lean-simplification.md (tiered heuristics, grind guidance, Aeneas policy)
- fv-skills/references/tactic-usage.md (core tactics reference)
- fv-skills/references/proof-strategies.md (common proof patterns)

```
Task(
  subagent_type="fvs-researcher",
  model="$RESEARCH_MODEL",
  description="Research simplification context for $SPEC_FILE",
  prompt="Research mode: lean-simplify

<spec_file_path>$SPEC_PATH</spec_file_path>
<spec_content>
$SPEC_FILE_CONTENT
</spec_content>

<lean_simplification>
$LEAN_SIMPLIFICATION_CONTENT
</lean_simplification>

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
4b. Classify theorems into simplification layers: pure math -> representation -> bridge -> top-level specs. Recommend processing order from safest (pure math) to riskiest (top-level).
4c. Apply target selection heuristics: identify "plateau" theorems (stable, self-contained) as good first targets. Flag "cliff edge" theorems (recently modified, many dependents) as defer-to-later.
5. Return structured findings with per-theorem simplification recommendations
6. Classify each recommendation by tier (1-4)

Return with ## RESEARCH COMPLETE"
)
```

**If --report-only flag is set:** Display research findings and STOP. No simplification
passes are run.

**If researcher returns ## ERROR:** Display the error and stop.
</step>

<step name="iterative_simplify">
**Theorem ordering:** Process theorems in layer order (pure math first, top-level specs last)
and within each layer, process "plateau" theorems (stable, self-contained) before "cliff edge"
theorems (recently modified, many dependents). This ordering minimizes cascade risk from
simplification failures.

For each theorem (one at a time, in order from research recommendations):

```
PASS=0
WHILE PASS < MAX_PASSES:
  # Re-read spec each iteration (it changes!)
  CURRENT_SPEC=$(cat "$SPEC_PATH")

  Task(
    subagent_type="fvs-lean-simplifier",
    model="$SIMPLIFIER_MODEL",
    description="Simplify {theorem_name} pass {PASS+1}",
    prompt="<simplification_reference>$LEAN_SIMPLIFICATION_CONTENT</simplification_reference>
    <research_findings>$RESEARCH_OUTPUT</research_findings>
    <current_spec>$CURRENT_SPEC</current_spec>
    <target_theorem>{theorem_name}</target_theorem>
    <mode>{safe|balanced|aggressive}</mode>
    <pass>{PASS+1} of {MAX_PASSES}</pass>
    <previous_feedback>{build errors from last pass, if any}</previous_feedback>

    Apply ONE simplification from the highest applicable tier within the mode ceiling.
    Write via Write tool. User approves inline."
  )

  ROUTE ON RETURN:
    ## SIMPLIFIED:
      Run: nice -n 19 lake build
      If build passes: record change, PASS += 1, continue
      If build fails: REVERT the change (re-write previous content), store error as feedback, PASS += 1
    ## NO_CHANGE:
      Break -- no more simplifications possible for this theorem
    ## ERROR:
      Store error, PASS += 1
END WHILE
```

Move to next theorem after max passes or NO_CHANGE.
</step>

<step name="report">
After all theorems have been processed, display summary with before/after metrics.

**SIMPLIFIED (at least one change made):**
```
FVS >> SIMPLIFICATION COMPLETE

File:      {spec_file}
Mode:      {safe|balanced|aggressive}
Theorems:  {N} processed
Changes:   {total changes made}
Lines:     {before} -> {after} ({delta})
Status:    SIMPLIFIED

Per-theorem breakdown:
  {theorem_1}: {changes} changes, {lines_before} -> {lines_after}
  {theorem_2}: {changes} changes, {lines_before} -> {lines_after}
  ...

Verify: nice -n 19 lake build
```

**NO_CHANGE (nothing to simplify):**
```
FVS >> SIMPLIFICATION COMPLETE

File:      {spec_file}
Mode:      {safe|balanced|aggressive}
Status:    NO_CHANGE

Proofs are already clean at the {mode} tier ceiling.
```

**ERROR (something broke):**
```
FVS >> SIMPLIFICATION ERROR

File:      {spec_file}
Error:     {description}
```

Suggest next steps based on outcome.
</step>

</process>

<success_criteria>
- Spec file validated: exists, compiles, zero sorry
- Config read and models resolved for fvs-researcher and fvs-lean-simplifier
- Research subagent dispatched with inlined lean-simplification, tactic-usage, proof-strategies
- 3-lens analysis returned with per-theorem recommendations and tier classifications
- Simplifier dispatched iteratively per theorem (one change at a time)
- Build check after every simplification change with nice -n 19 lake build
- Failed changes reverted immediately
- Report-only mode stops after research phase
- Result correctly classified as SIMPLIFIED, NO_CHANGE, or ERROR
- Before/after metrics reported per theorem and overall
</success_criteria>
