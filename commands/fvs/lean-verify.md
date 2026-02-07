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
Orchestrate interactive proof development for a Lean specification. Takes a spec file containing sorry, loads tactic knowledge and proof strategies, dispatches the prover agent to replace sorry with tactic proof steps, and handles the iterative cycle of propose-feedback-adjust that formal verification requires.

This is the most interactive command -- verification often requires multiple attempts, user hints, and strategy adjustments. The prover agent proposes ONE tactic step at a time and explains its reasoning. This is a locked user decision and must not be overridden.

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

## Step 1: Resolve Spec File

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

## Step 2: Verify Sorry Exists

```bash
grep -c "sorry" "$SPEC_PATH"
```

If zero sorry: spec may already be proved. Run build check to confirm:

```bash
nice -n 19 lake build 2>&1 | tail -20
```

- If build clean: report VERIFIED status and exit.
- If build errors: report errors and exit.

If sorry found: extract theorem name and current proof state. Continue to proof loop.

```bash
grep -E "@\[progress\]|theorem " "$SPEC_PATH"
```

## Step 3: Read Reference Files for Prover Dispatch

Read the three reference files. These MUST be inlined into Task() prompts because @-references do not cross Task boundaries.

```bash
TACTIC_REF=$(cat ~/.claude/fv-skills/references/tactic-usage.md)
PROOF_STRATEGIES=$(cat ~/.claude/fv-skills/references/proof-strategies.md)
SPEC_CONVENTIONS=$(cat ~/.claude/fv-skills/references/lean-spec-conventions.md)
```

## Step 4: Load Function Body from Funs.lean

Extract the function that the spec theorem is about. Find it by looking at the theorem statement (the function call in `= ok result`):

```bash
# Parse function name from spec theorem
FUNC_CALL=$(grep "= ok result" "$SPEC_PATH" | head -1)

# Locate Funs.lean
FUNS_LEAN=$(find . -name "Funs.lean" -not -path "./.lake/*" | head -1)
```

Read the target function body from Funs.lean.

## Step 5: Load Verified Dependency Specs

```bash
# Parse imports from spec file to find dependency specs
grep "^import" "$SPEC_PATH"

# Scan for sorry-free dependency specs (these are available for progress)
VERIFIED_DEP_SPECS=""
for dep_spec in $(find Specs/ -name "*.lean" -not -name "$(basename $SPEC_PATH)" 2>/dev/null); do
  SORRY=$(grep -c "sorry" "$dep_spec" 2>/dev/null || echo 0)
  if [ "$SORRY" -eq 0 ]; then
    VERIFIED_DEP_SPECS="$VERIFIED_DEP_SPECS\n--- $dep_spec ---\n$(cat $dep_spec)"
  fi
done
```

These verified theorems are available for `progress` to apply during proof.

## Step 6: Initialize Iteration State

```
ATTEMPT_COUNT=0
PREVIOUS_FEEDBACK=""
PROOF_STATUS="in_progress"
```

These variables live in the command scope. Agents are stateless -- each Task() invocation receives the full context fresh.

## Step 7: Enter Proof Loop

WHILE PROOF_STATUS == "in_progress" AND ATTEMPT_COUNT < MAX_ATTEMPTS:

### Step 7a: Read Current Spec File State

```bash
CURRENT_SPEC=$(cat "$SPEC_PATH")
```

### Step 7b: Dispatch fvs-lean-prover

```
Task(
  prompt="Attempt proof step for $SPEC_PATH.

<spec_file>
$CURRENT_SPEC
</spec_file>

<function_body>
$FUNCTION_BODY
</function_body>

<verified_dependency_specs>
$VERIFIED_DEP_SPECS
</verified_dependency_specs>

<tactic_reference>
$TACTIC_REF
</tactic_reference>

<proof_strategies>
$PROOF_STRATEGIES
</proof_strategies>

<spec_conventions>
$SPEC_CONVENTIONS
</spec_conventions>

<user_feedback>
$PREVIOUS_FEEDBACK
</user_feedback>

<attempt>$ATTEMPT_COUNT of $MAX_ATTEMPTS</attempt>

<constraints>
- Propose ONE tactic step at a time (1-3 lines max)
- Write the tactic to the spec file via Write tool
- Return ## TACTIC PROPOSED, ## VERIFIED, or ## STUCK
</constraints>",
  subagent_type="fvs-lean-prover",
  description="Proof attempt #$ATTEMPT_COUNT for $THEOREM_NAME"
)
```

### Step 7c: Route on Prover Return Header

**If ## TACTIC PROPOSED:**
- Display the proposed tactic and reasoning to user
- ATTEMPT_COUNT += 1
- Wait for user feedback. The user should:
  - Report the goal state from Lean infoview (paste the updated goals)
  - Report any errors from the Lean server
  - Provide a hint (e.g., "try simp with this lemma", "the key invariant is X")
  - Say "skip" to abandon this spec
- Store user's response as PREVIOUS_FEEDBACK
- If user says "skip": set PROOF_STATUS = "skipped", exit loop
- Otherwise: continue loop

**If ## VERIFIED:**
- Set PROOF_STATUS = "verified"
- Exit loop

**If ## STUCK:**
- Display stuck report to user (unsolved goal, what was tried, suggestion)
- Offer options:
  1. Provide a hint (mathematical insight, invariant, lemma pointer)
  2. "retry" with different strategy
  3. "simplify" postconditions and retry
  4. "skip" and move on
- If user provides hint or says "retry": store as PREVIOUS_FEEDBACK, continue loop
- If user says "simplify": store "USER REQUESTS: simplify postconditions" as PREVIOUS_FEEDBACK, continue loop
- If user says "skip": set PROOF_STATUS = "skipped", exit loop

**If ## ERROR:**
- Display error to user
- Attempt automatic fix if it is an import or type issue:
  - Missing import: add the import and rebuild
  - Type mismatch: note for user
- If fixable: store fix info as PREVIOUS_FEEDBACK, continue loop
- If not fixable: set PROOF_STATUS = "error", exit loop

END WHILE

## Step 8: Check Max-Attempts Guardrail

If ATTEMPT_COUNT >= MAX_ATTEMPTS and PROOF_STATUS == "in_progress":

```
FVS >> STUCK

Reached maximum attempts ($MAX_ATTEMPTS). Consider:
1. Simplify the postcondition (weaker but provable spec)
2. Add a helper lemma for the difficult sub-goal
3. Check if the property actually holds (counterexample search)
4. Move on and return later with more context
```

Set PROOF_STATUS = "stuck".

## Step 9: Report Final Result

**If PROOF_STATUS == "verified":**

```
FVS >> VERIFIED

Function: {function_name}
Spec:     {spec_path}
Proof:    Complete ({ATTEMPT_COUNT} tactic steps)
Status:   [OK] No sorry remaining

Verify: nice -n 19 lake build
```

**If PROOF_STATUS == "stuck" or "skipped":**

```
FVS >> STUCK

Function: {function_name}
Spec:     {spec_path}
Status:   [??] {remaining sorry count} goals unsolved
Attempts: {ATTEMPT_COUNT} of {MAX_ATTEMPTS}
```

**If PROOF_STATUS == "error":**

```
FVS >> BUILD ERROR

Function: {function_name}
Spec:     {spec_path}
Status:   [XX] Does not compile
```

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

**If verified:**

```
>> Next Up

/fvs:plan to select next verification target
```

**If stuck or skipped:**

```
>> Options

- Provide a hint and run /fvs:lean-verify {spec_path} again
- /fvs:plan to try a different target
- /fvs:lean-specify {function_name} to regenerate the spec with different postconditions
```

**If error:**

```
>> Options

- Fix the compilation error manually and run /fvs:lean-verify {spec_path} again
- /fvs:lean-specify {function_name} to regenerate the spec
```

</process>

<success_criteria>
- [ ] Spec file located and sorry confirmed present
- [ ] Tactic knowledge, proof strategies, and dependency specs loaded
- [ ] Prover agent dispatched with full inlined context
- [ ] Interactive proof loop handles: tactic proposals, user feedback, hints, stuck/verified/error
- [ ] Build checks use nice -n 19 lake build (never plain lake build)
- [ ] Max-attempts guardrail enforced (default 10, hard cap 25)
- [ ] Result correctly classified as VERIFIED, STUCK, or ERROR
- [ ] CODEMAP.md updated with verification status if available
- [ ] Clear next steps offered based on outcome
</success_criteria>
