<purpose>
Orchestrate interactive proof development for a Lean specification using two-phase
subagent dispatch (research -> iterative execute).

Dispatches fvs-researcher to analyze sorry locations and recommend proof strategies,
then iteratively dispatches fvs-executor to replace each sorry ONE AT A TIME with
small tactic blocks. The user checks Lean compiles between each step.

This is the most interactive workflow -- it feels like pair programming. Small changes,
user approval, Lean compile check, repeat.

Output: Spec file with sorry replaced by complete proof, or clear report of stuck goals.
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
$(find Specs/ -name "*.lean" 2>/dev/null)

Or generate one first: /fvs:lean-specify function_name
```
Wait for user to provide valid path.

**Verify sorry exists:**
```bash
SORRY_COUNT=$(grep -c "sorry" "$SPEC_PATH")
```

If zero sorry: Spec already proved. Confirm with build check.
If sorry found: Extract theorem name and sorry count. Continue to model resolution.
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
Dispatch **fvs-researcher** subagent in proof-attempt mode to analyze all sorry locations.

Read and inline reference files before dispatch:
- fv-skills/references/tactic-usage.md (core tactics: step, simp, agrind, etc.)
- fv-skills/references/proof-strategies.md (patterns for common proof shapes)
- fv-skills/references/lean-spec-conventions.md (spec structure expectations)

Researcher tasks:
1. Read the spec file and identify all sorry locations
2. For each sorry, analyze the goal state (what needs to be proved)
3. Find related proofs in Specs/ for similar patterns
4. Check .formalising/stubs/ for NL explanation of the function
5. Identify which tactics are most likely to work for each sorry
6. Recommend an order to tackle sorry (easiest first, or dependency order)

Expected output: Structured findings with sorry analysis, tactic recommendations,
related proof examples, and recommended order. Ends with `## RESEARCH COMPLETE`.

**If researcher returns ## ERROR:** Display the error and stop.
</step>

<step name="iterative_execute">
Dispatch **fvs-executor** subagent iteratively, ONE SORRY AT A TIME.

This is the core proof loop. For each sorry (in order recommended by research):

1. **Display status:** `>> Attempting sorry {N}/{TOTAL}: {goal description}`

2. **Re-read spec file** each iteration (content changes after each successful step)

3. **Dispatch fvs-executor** in proof-attempt mode with:
   - Research findings (full context from researcher)
   - Current spec file content (re-read each iteration!)
   - Target sorry number and goal state
   - User feedback from previous attempt (if any)
   - Attempt counter

4. **Route on executor return:**

   **## EXECUTION COMPLETE:**
   - Remind user: "Check compilation: `nice -n 19 lake build`"
   - Wait for user feedback on whether Lean compiles
   - If compiles: mark sorry as resolved, move to next sorry
   - If does not compile: store error as feedback, retry (up to 3 attempts per sorry)

   **## NEEDS INPUT:**
   - Present executor's question to user (what it tried, what it needs)
   - Wait for user response: hint, invariant, lemma pointer, or "skip"
   - If hint provided: store as feedback, retry
   - If "skip": mark sorry as stuck, move to next sorry

   **## ERROR:**
   - Display error, increment attempt counter, retry or move on

5. **Per-sorry attempt limit:** 3 attempts. After 3 failed attempts, mark as stuck and continue to next sorry.

**LOCKED BEHAVIORAL CONSTRAINTS:**
- One sorry at a time (never batch multiple sorry in one executor dispatch)
- Small tactic blocks: have, calc, unfold + step, simp, agrind (1-3 lines max)
- User checks Lean compiles between each step
- Feels like pair programming: propose, check, adjust
- All writes via VS Code diffs (Write tool)
</step>

<step name="report_and_iterate">
After all sorry have been attempted, classify the result and report.

**VERIFIED (all sorry resolved, zero remaining):**
```
FVS >> VERIFIED

Function: {function_name}
Spec:     {spec_path}
Resolved: {N}/{TOTAL} sorry
Status:   [OK] No sorry remaining

Verify: nice -n 19 lake build
```

**PARTIAL (some sorry resolved, some remain):**
```
FVS >> PARTIAL

Function: {function_name}
Spec:     {spec_path}
Resolved: {N}/{TOTAL} sorry
Stuck:    {M} sorry remain
Status:   [??] Proof incomplete
```

**STUCK (no sorry resolved):**
```
FVS >> STUCK

Function: {function_name}
Spec:     {spec_path}
Resolved: 0/{TOTAL} sorry
Status:   [XX] No progress

Consider:
1. Simplify the postcondition (weaker but provable spec)
2. Add a helper lemma for the difficult sub-goal
3. Check if the property actually holds (counterexample search)
4. Move on and return later with more context
```

**Update CODEMAP.md** if it exists (via Write tool):
- VERIFIED: change status to `[OK]`
- PARTIAL/STUCK: change status to `[??]`

**Suggest next steps** based on outcome.
</step>

</process>

<success_criteria>
- Spec file located and sorry confirmed present
- Config read and models resolved for fvs-researcher and fvs-executor
- Research subagent gathered sorry analysis, tactic recommendations, related proofs
- Executor dispatched iteratively per sorry (one at a time, small tactic blocks)
- User checks Lean compiles between each step (pair programming feel)
- NEEDS INPUT handling for stuck proofs with user hint collection
- Build checks use nice -n 19 lake build (never plain lake build)
- Result correctly classified as VERIFIED, PARTIAL, or STUCK
- Interactive iteration loop handles hints, retries, and escalation
- CODEMAP.md updated with verification status if available
</success_criteria>
