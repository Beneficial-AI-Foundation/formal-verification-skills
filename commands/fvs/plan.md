---
name: fvs:plan
description: Pick next verification targets via dependency graph analysis
argument-hint: "[optional: function name to plan for specifically]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
  - Task
---

<objective>
Analyze the dependency graph from CODEMAP.md to determine optimal bottom-up
verification order. Evaluate function complexity, check existing spec coverage,
and present a prioritized selection interface for the user to choose their next
verification target.

Output: User-selected verification target ready for /fvs:lean-specify.
</objective>

<execution_context>
@~/.claude/fv-skills/workflows/plan.md
@~/.claude/fv-skills/references/ui-brand.md
</execution_context>

<context>
Target function: $ARGUMENTS (optional -- if provided, plan for that specific function instead of full ranking)

Check for .formalising/CODEMAP.md:
- If missing, suggest /fvs:map-code first
- If found, parse function inventory and dependency graph

Check for existing .formalising/fv-plans/ docs from prior sessions.
</context>

<process>

## Step 1: Check CODEMAP.md exists

```bash
[ -f .formalising/CODEMAP.md ] && echo "CODEMAP found" || echo "CODEMAP missing"
```

If missing:
```
CODEMAP.md not found. Run /fvs:map-code first to analyze the project.

Alternatively, specify a function directly:
  /fvs:lean-specify function_name
```
Warn but allow user to proceed manually if they choose.

If found: read and parse the function inventory and dependency graph sections.

If $ARGUMENTS is provided (specific function name): check whether that function
exists in CODEMAP.md. If not found, warn: "Function {name} not found in CODEMAP.
Available functions: ..." and let user correct.

## Step 2: Load verification state

Scan the Specs/ directory for existing specifications and their sorry status:

```bash
for f in $(find Specs/ -name "*.lean" 2>/dev/null); do
  SORRY=$(grep -c "sorry" "$f" 2>/dev/null || echo 0)
  VERIFIED=$( [ "$SORRY" -eq 0 ] && echo "yes" || echo "no" )
  echo "$f sorry=$SORRY verified=$VERIFIED"
done
```

Build verification state for each function in the inventory:
- **[OK] Verified**: spec file exists, zero sorry (fully proved)
- **[??] In progress**: spec file exists, has sorry (partially proved)
- **[--] Unspecified**: no spec file exists

Display current project status:
```
Verification: [V] [OK] / [P] [??] / [U] [--] of [T] total
```

## Step 3: Read reference files for agent dispatch

Read reference content into variables for inlining into Task() prompts:

```bash
AENEAS_PATTERNS=$(cat ~/.claude/fv-skills/references/aeneas-patterns.md)
SPEC_CONVENTIONS=$(cat ~/.claude/fv-skills/references/lean-spec-conventions.md)
```

## Step 4: Dispatch fvs-dependency-analyzer for ordering

Display dispatch indicator:
```
>> Dispatching fvs-dependency-analyzer...
```

Spawn with dependency graph and current verification state:

```
Task(
  prompt="Determine optimal verification order from dependency graph.

<codemap_dependencies>
$DEPENDENCY_GRAPH_FROM_CODEMAP
</codemap_dependencies>

<verification_state>
$VERIFICATION_STATE_FROM_STEP_2
</verification_state>

<aeneas_patterns>
$AENEAS_PATTERNS
</aeneas_patterns>

Bottom-up ordering: verify leaf functions first, then functions whose
dependencies are all verified. Identify 'ready now' set (deps all verified
or is leaf) and 'blocked' set (waiting on dependency verification).

Return with ## MAPPING COMPLETE or ## ERROR.",
  subagent_type="fvs-dependency-analyzer",
  description="Computing bottom-up verification order"
)
```

Parse the result:
- Topological sort of unverified functions
- "Ready now" set: functions whose dependencies are all verified or are leaves
- "Blocked" set: functions waiting on dependency verification, with blocker names

Display:
```
[OK] fvs-dependency-analyzer complete: {N} ready, {M} blocked
```

If $ARGUMENTS was provided (specific function): check whether the target is in
the "ready now" set. If blocked, show which dependencies need verification first.

## Step 5: Dispatch fvs-code-reader for target evaluation

Take the top 10 functions from the "ready now" set (or just the target function
if $ARGUMENTS was provided) and dispatch fvs-code-reader in evaluation mode:

```
>> Dispatching fvs-code-reader (evaluation mode)...
```

```
Task(
  prompt="Evaluate top verification target candidates for complexity and leverage.

<candidates>
$TOP_10_READY_NOW_FUNCTIONS
</candidates>

<funs_lean_path>{FUNS_LEAN_PATH}</funs_lean_path>
<rust_source_dir>{RUST_SOURCE_DIR}</rust_source_dir>

<aeneas_patterns>
$AENEAS_PATTERNS
</aeneas_patterns>

<spec_conventions>
$SPEC_CONVENTIONS
</spec_conventions>

Mode: evaluation
For each candidate evaluate:
- Complexity (1-5): arg count, branch count, loop presence
- Pattern match (1-5): how closely it matches known-provable patterns
- Leverage (1-5): how many other functions depend on this being verified
- Risk (1-5): opaque externals, trait dispatch, nonlinear arithmetic

Return with ## ANALYSIS COMPLETE or ## ERROR.",
  subagent_type="fvs-code-reader",
  description="Evaluating verification target candidates"
)
```

Display:
```
[OK] fvs-code-reader complete: {N} candidates evaluated
```

## Step 6: Combine ordering with evaluation

Merge the dependency ordering (step 4) with the complexity/leverage/risk
evaluation (step 5). Produce a ranked list sorted by:
1. Leverage (high first -- verify functions that unblock the most others)
2. Risk (low first -- start with high-confidence targets)
3. Complexity (low first -- quick wins build momentum)

## Step 7: Present prioritized plan to user

Display the ranked results with the FVS >> banner:

```
FVS >> PLANNING TARGETS

Status: [V] [OK] / [P] [??] / [U] [--] of [T] total

Ready to verify (dependencies satisfied):

  #  Function                  Complexity  Leverage  Risk
  1. scalar_mul_inner          Low         High      Low
  2. point_validate            Low         Medium    Low
  3. field_add                 Low         Low       Low
  4. batch_normalize           Medium      High      Medium
  ...

Blocked (need dependency specs first):
  [!!] multi_scalar_mul (needs: scalar_mul_inner, point_add)
  [!!] verify_signature (needs: hash_to_curve, scalar_mul)

---

Select a target number, or type a function name directly.
```

Wait for user selection.

If $ARGUMENTS was provided and the function is ready: skip interactive selection,
display the evaluation directly and confirm with user.

## Step 8: Write planning doc for selected target (optional)

After user selects a target, offer to write a planning document:

```
Write planning doc to .formalising/fv-plans/{function_name}.md? (y/n)
```

If yes, assemble a planning doc with:
- Function name, Lean qualified name, Rust source path
- Dependencies and their verification status
- Recommended approach (from code-reader evaluation)
- Complexity/leverage/risk assessment
- Known precondition/postcondition candidates (if available from evaluation)

Write via VS Code diff (Write tool).

## Step 9: Suggest next command

```
Target selected: {function_name}

>> Next Up

/fvs:lean-specify {function_name}
```

</process>

<success_criteria>
- [ ] CODEMAP.md loaded and parsed (or user warned if missing)
- [ ] Existing specs scanned with sorry/verified status
- [ ] Dependency analysis produces bottom-up ordering
- [ ] Top candidates analyzed for complexity, leverage, and risk
- [ ] Prioritized list presented with selection interface
- [ ] User selects target, next command suggested
</success_criteria>
