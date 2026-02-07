<purpose>
Orchestrate interactive proof development for a Lean specification.

Takes a spec file containing sorry, loads tactic knowledge and proof strategies,
dispatches the prover agent to replace sorry with a complete proof, and handles
the iterative cycle of build-check-fix that formal verification requires.

This is the most interactive workflow -- verification often requires multiple
attempts, user hints, and strategy adjustments.

Output: Spec file with sorry replaced by a complete, building proof.
</purpose>

<process>

<step name="resolve_spec">
Accept spec file path and validate it.

```bash
[ -f "$SPEC_PATH" ] && echo "Spec found" || echo "Spec not found"
```

**If not found:**
```
Spec file not found: $SPEC_PATH

Available specs:
$(find Specs/ -name "*_spec.lean" 2>/dev/null)

Or generate one first: /fvs:lean-specify function_name
```
Wait for user to provide valid path.

**Verify sorry exists:**
```bash
grep -c "sorry" "$SPEC_PATH"
```

If zero sorry: Spec already proved. Confirm with build check.
If sorry found: Extract theorem name and current proof state.
</step>

<step name="load_context">
Gather all context the prover agent needs.

**Load reference knowledge:**
- @fv-skills/references/tactic-usage.md (core tactics: progress, simp, omega, etc.)
- @fv-skills/references/proof-strategies.md (patterns for common proof shapes)
- @fv-skills/references/lean-spec-conventions.md (spec structure expectations)

**Load dependency specs:**
```bash
# Parse imports from spec file to find dependency specs
grep "^import" "$SPEC_PATH" | while read line; do
  echo "Import: $line"
done

# Load verified dependency theorems (for rewriting)
for dep_spec in $(find Specs/ -name "*_spec.lean" -not -name "$(basename $SPEC_PATH)" 2>/dev/null); do
  SORRY=$(grep -c "sorry" "$dep_spec" 2>/dev/null || echo 0)
  [ "$SORRY" -eq 0 ] && echo "Verified dep: $dep_spec"
done
```

**Load function body:**
Read the target function from Funs.lean for the prover to reference during proof.

Assemble all context into a structured prompt for the prover agent.
</step>

<step name="attempt_proof">
Dispatch **fvs-prover** agent to attempt replacing sorry with a proof.

Agent inputs:
- Spec file content (with sorry)
- Function body from Funs.lean
- Tactic reference (from tactic-usage.md)
- Proof strategies (from proof-strategies.md)
- Verified dependency specs (available lemmas)
- Any user hints from previous iterations

**Agent approach:**
1. Analyze the goal structure (what needs to be proved)
2. Select strategy based on function pattern (arithmetic, branching, recursive)
3. Write proof using progress/simp/omega/scalar_tac as appropriate
4. Handle each branch case systematically

**Write updated spec** with proof replacing sorry.

**Build check (CRITICAL: always use nice):**
```bash
nice -n 19 lake build 2>&1
```

NEVER run plain `lake build` -- always `nice -n 19 lake build` to avoid
starving the system of resources during long Lean compilation.

**Capture build output** for result classification.
</step>

<step name="report_result">
Classify the build outcome into one of three categories.

**VERIFIED (build succeeds, no sorry, no errors):**
```
FVS -- VERIFIED

Function: {function_name}
Spec: {spec_path}
Proof: Complete ({N} tactic lines)
Status: Fully verified -- no sorry remaining

lake build: clean (no warnings, no errors)
```

**STUCK (proof incomplete, unsolved goals remain):**
```
FVS -- STUCK

Function: {function_name}
Spec: {spec_path}
Status: Proof incomplete

Unsolved goals:
  {goal_1}
  {goal_2}

Current proof state:
  [relevant Lean infoview output]

Attempted tactics:
  - [what was tried and why it failed]

---

Suggestions:
- Provide a hint about the mathematical property
- Try a different proof strategy
- Simplify postconditions and try again
```

**ERROR (compilation failure):**
```
FVS -- BUILD ERROR

Function: {function_name}
Spec: {spec_path}
Status: Does not compile

Error:
  {lake build error output}

Likely cause: [import issue | type mismatch | tactic error]
```
</step>

<step name="iterate">
Handle interactive iteration based on result.

**If VERIFIED:** Workflow complete. Offer next steps:
```
Fully verified. Next options:
- /fvs:plan to select next verification target
- /fvs:lean-verify another_spec.lean to verify another function
```

**If STUCK:**
Wait for user input. Accept:
- **Hints**: Mathematical insights, invariant suggestions, lemma pointers
- **"retry"**: Re-attempt with different strategy
- **"simplify"**: Weaken postconditions and retry
- **"skip"**: Leave sorry, move on

On hint or retry: Return to `attempt_proof` step with new context.
Track iteration count. After 3 failed attempts, suggest:
```
3 attempts without success. Consider:
1. Simplify the postcondition (weaker but provable spec)
2. Add a helper lemma for the difficult sub-goal
3. Check if the property actually holds (counterexample search)
4. Move on and return later with more context
```

**If ERROR:**
Attempt automatic fix (import correction, type annotation).
If fix succeeds, rebuild. If not, present error to user.

On each iteration, always rebuild with:
```bash
nice -n 19 lake build 2>&1
```
</step>

</process>

<success_criteria>
- Spec file located and sorry confirmed present
- Tactic knowledge, proof strategies, and dependency specs loaded
- Prover agent dispatched with full context
- Build check uses nice -n 19 lake build (never plain lake build)
- Result correctly classified as VERIFIED, STUCK, or ERROR
- Interactive iteration loop handles hints, retries, and escalation
- Verified specs have zero sorry and clean build
</success_criteria>
