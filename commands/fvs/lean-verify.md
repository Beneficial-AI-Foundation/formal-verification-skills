---
name: fvs:lean-verify
description: Attempt proof of Lean spec using domain tactics with interactive feedback
argument-hint: "<spec_file_path> [--max-attempts N]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
  - Task
---

<objective>
Orchestrate interactive proof development for a Lean specification using two-phase subagent dispatch (research -> iterative execute). Dispatches fvs-researcher to analyze sorry locations and recommend proof strategies, then iteratively dispatches fvs-executor to replace each sorry ONE AT A TIME with small tactic blocks.

This is the most interactive command -- it feels like pair programming. The executor proposes a small tactic step, the user checks Lean compiles, and the cycle repeats. This is a locked user decision and must not be overridden.

Output: Spec file with sorry replaced by complete proof (VERIFIED) or clear report of where proof got stuck (STUCK).
</objective>

<execution_context>
@~/.claude/fv-skills/workflows/lean-verify.md
@~/.claude/fv-skills/references/ui-brand.md
</execution_context>

<context>
Spec file path: $ARGUMENTS (required -- path to spec .lean file).

Parse --max-attempts flag from $ARGUMENTS:
- Default: 10
- Hard cap: 25 (never exceed regardless of user request)

- Check for .formalising/CODEMAP.md for dependency context
- Track iteration count in command scope (agents are stateless per Task() invocation)
</context>

<process>

## Step 1: Parse Spec File Path and Options

Parse $ARGUMENTS for spec file path and optional --max-attempts flag:

```bash
SPEC_PATH="(parsed from $ARGUMENTS, excluding flags)"
MAX_ATTEMPTS="(parsed from --max-attempts flag, default 10)"

# Hard cap: never exceed 25
if [ "$MAX_ATTEMPTS" -gt 25 ]; then
  MAX_ATTEMPTS=25
fi

[ -f "$SPEC_PATH" ] && echo "Spec found" || echo "Spec not found"
```

If not found: list available specs and suggest `/fvs:lean-specify`.

```bash
find Specs/ -name "*.lean" 2>/dev/null
```

Wait for valid path.

## Step 2: Read Config and Resolve Models

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

## Step 3: Read Reference Files for Inlining

Read the reference files that MUST be inlined into Task() prompts because @-references do not cross Task boundaries:

```bash
TACTIC_USAGE=$(cat ~/.claude/fv-skills/references/tactic-usage.md)
PROOF_STRATEGIES=$(cat ~/.claude/fv-skills/references/proof-strategies.md)
SPEC_CONVENTIONS=$(cat ~/.claude/fv-skills/references/lean-spec-conventions.md)
```

All three must be captured as content strings for inlining into subagent prompts.

## Step 4: Count Sorry in Spec File

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

If sorry found: extract theorem name and current proof state. Continue to research phase.

```bash
grep -E "@\[progress\]|theorem " "$SPEC_PATH"
```

## Step 5: Dispatch Research Subagent

```
Task(
  subagent_type="fvs-researcher",
  model="$RESEARCH_MODEL",
  description="Research proof context for $SPEC_FILE",
  prompt="Research mode: proof-attempt

<spec_file_path>$SPEC_FILE</spec_file_path>
<spec_content>
$SPEC_FILE_CONTENT
</spec_content>

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
1. Read the spec file and identify all sorry locations
2. For each sorry, analyze the goal state (what needs to be proved)
3. Find related proofs in Specs/ for similar patterns
4. Check .formalising/stubs/ for NL explanation of the function
5. Identify which tactics are most likely to work for each sorry
6. Recommend an order to tackle sorry (easiest first, or dependency order)

Return with ## RESEARCH COMPLETE"
)
```

Parse the returned research findings to get:
- List of sorry locations with goal descriptions
- Recommended order to tackle them
- Tactic suggestions per sorry
- Related proof examples

## Step 6: Iterative Executor Dispatch (One Sorry at a Time -- LOCKED DECISION)

```
SORRY_RESOLVED=0
SORRY_STUCK=0
SORRY_REMAINING=$SORRY_COUNT

FOR EACH SORRY (in recommended order from research):

  Display:
  >> Attempting sorry {N}/{TOTAL}: {goal description}

  ATTEMPT_FOR_THIS_SORRY=0
  MAX_PER_SORRY=3

  WHILE ATTEMPT_FOR_THIS_SORRY < MAX_PER_SORRY:

    # Re-read spec file each iteration (it changes after each write!)
    CURRENT_SPEC=$(cat "$SPEC_PATH")

    Task(
      subagent_type="fvs-executor",
      model="$EXECUTOR_MODEL",
      description="Prove sorry {N} in $SPEC_FILE",
      prompt="Execute mode: proof-attempt

<research_findings>
$RESEARCH_SUBAGENT_OUTPUT
</research_findings>

<current_spec>
$CURRENT_SPEC_FILE_CONTENT (re-read each iteration -- it changes!)
</current_spec>

<target_sorry>sorry #{N}</target_sorry>
<goal_state>{goal from research findings}</goal_state>

<user_feedback>
$PREVIOUS_FEEDBACK (empty on first attempt, contains Lean error or user hint after)
</user_feedback>

<attempt>{ATTEMPT_FOR_THIS_SORRY} of {MAX_PER_SORRY}</attempt>

Write a SMALL tactic block to replace this ONE sorry.
Use tactics: have, calc, progress, unfold, simp, ring, field_simp, omega.
Explain your reasoning before writing.

IMPORTANT: Write the change using VS Code diff (Write tool). User will approve inline.
After the write, the user will check if Lean compiles. Wait for feedback.

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
- Small tactic blocks (have, calc, unfold + progress)
- User checks Lean compiles between each step
- Feels like pair programming
- All writes via VS Code diffs

## Step 7: Display Summary

```
FVS >> VERIFICATION {STATUS}

File:     {spec_file}
Resolved: {SORRY_RESOLVED}/{SORRY_COUNT} sorry
Stuck:    {SORRY_STUCK}
Status:   {VERIFIED if 0 sorry remain, PARTIAL if some remain, STUCK if none resolved}
```

**Status classification:**
- **VERIFIED:** All sorry resolved, zero remaining
- **PARTIAL:** Some sorry resolved, some remain
- **STUCK:** No sorry resolved

## Step 8: Update CODEMAP.md Verification Status

If .formalising/CODEMAP.md exists, update the function's status:

```bash
[ -f ".formalising/CODEMAP.md" ] && echo "CODEMAP exists" || echo "No CODEMAP"
```

Update via Write tool (VS Code diff):
- Verified: change status to `[OK]`
- Still has sorry: change status to `[??]`
- Build error: change status to `[XX]`

## Step 9: Suggest Next Steps

**If VERIFIED:**

```
>> Next Up

/fvs:plan to select next verification target
```

**If PARTIAL or STUCK:**

```
>> Options

- Provide a hint and run /fvs:lean-verify {spec_path} again
- /fvs:plan to try a different target
- /fvs:lean-specify {function_name} to regenerate the spec with different postconditions
```

</process>

<success_criteria>
- [ ] Spec file located and sorry confirmed present
- [ ] Config read and models resolved for fvs-researcher and fvs-executor
- [ ] Research subagent dispatched with inlined tactic-usage, proof-strategies, spec-conventions
- [ ] Research identified all sorry locations with goals and tactic recommendations
- [ ] Executor dispatched iteratively per sorry (one at a time, not batch)
- [ ] Each executor writes small tactic blocks via VS Code diff
- [ ] User checks Lean compiles between each step (pair programming feel)
- [ ] NEEDS INPUT handling for stuck proofs with user hint collection
- [ ] Max-attempts guardrail enforced per sorry (3) and total (25 hard cap)
- [ ] Build checks use nice -n 19 lake build (never plain lake build)
- [ ] Result correctly classified as VERIFIED, PARTIAL, or STUCK
- [ ] CODEMAP.md updated with verification status if available
- [ ] Clear next steps offered based on outcome
</success_criteria>
