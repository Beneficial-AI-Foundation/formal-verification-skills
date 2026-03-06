---
name: fvs:lean-specify
description: Generate Lean spec skeleton following @[progress] theorem pattern
argument-hint: "<function_name> (Lean or Rust name)"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
  - Task
---

<objective>
Generate a Lean specification file for a single function using two-phase subagent dispatch. Takes a verification target (function name), dispatches a researcher to gather context (Funs.lean, Types.lean, Rust source, existing stubs, similar specs), then dispatches an executor to write the spec file.

Output: Specs/{path}/{FunctionName}.lean with @[progress] theorem, existential postconditions, and sorry placeholder.
</objective>

<execution_context>
@~/.claude/fv-skills/workflows/lean-specify.md
@~/.claude/fv-skills/references/ui-brand.md
</execution_context>

<context>
Target function: $ARGUMENTS (required -- function name in Lean or Rust form).

- Check for .formalising/CODEMAP.md for function lookup and dependency info
- Check for existing spec file at expected Specs/ path
- Single-function mode: exactly one function per invocation
</context>

<process>

## Step 1: Resolve Target Function

Accept $ARGUMENTS as function name. Search in CODEMAP.md if available:

```bash
TARGET="$ARGUMENTS"
grep -i "$TARGET" .formalising/CODEMAP.md 2>/dev/null
```

If not found in CODEMAP, search directly in Funs.lean:

```bash
FUNS_LEAN=$(find . -name "Funs.lean" -not -path "./.lake/*" | head -1)
grep "def ${TARGET}" "$FUNS_LEAN" 2>/dev/null
```

Resolve to:
- Full Lean qualified name (e.g., `MyProject.my_module.my_function`)
- Path to containing Funs.lean
- Function signature (args and return type)
- Output spec path: `Specs/{module_path}/{FunctionName}.lean`

If function not found: show fuzzy matches and suggest `/fvs:map-code`. Wait for user clarification.

## Step 2: Check If Spec Already Exists

```bash
[ -f "$SPEC_PATH" ] && echo "Spec exists" || echo "No existing spec"
```

If exists: warn user. Ask whether to overwrite or open for editing.
- If has sorry: suggest `/fvs:lean-verify` instead.
- If fully proved: confirm verified status.

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
AENEAS_PATTERNS=$(cat ~/.claude/fv-skills/references/aeneas-patterns.md)
SPEC_CONVENTIONS=$(cat ~/.claude/fv-skills/references/lean-spec-conventions.md)
SPEC_TEMPLATE=$(cat ~/.claude/fv-skills/templates/spec-file.lean)
```

All three must be captured as content strings for inlining into subagent prompts.

## Step 5: Dispatch Research Subagent

```
Task(
  subagent_type="fvs-researcher",
  model="$RESEARCH_MODEL",
  description="Research context for spec generation of $FUNCTION_NAME",
  prompt="Research mode: spec-generation

<target_function>$FUNCTION_NAME</target_function>
<funs_lean_path>$FUNS_LEAN</funs_lean_path>

<aeneas_patterns>
$AENEAS_PATTERNS_CONTENT
</aeneas_patterns>

<spec_conventions>
$SPEC_CONVENTIONS_CONTENT
</spec_conventions>

Tasks:
1. Read target function body from Funs.lean
2. Read Types.lean for type dependencies used in the function
3. Find Rust source for bounds analysis and pre/post conditions
4. Check .formalising/stubs/ for existing NL explanation (if exists, use it!)
5. Find similar verified specs in Specs/ directory for patterns to follow
6. Determine the correct output path: Specs/{module_path}/{FunctionName}.lean

Return with ## RESEARCH COMPLETE"
)
```

Parse the returned research findings for use by the executor.

## Step 6: Dispatch Executor Subagent

```
Task(
  subagent_type="fvs-executor",
  model="$EXECUTOR_MODEL",
  description="Generate spec for $FUNCTION_NAME",
  prompt="Execute mode: spec-generation

<research_findings>
$RESEARCH_SUBAGENT_OUTPUT
</research_findings>

<spec_template>
$SPEC_FILE_TEMPLATE_CONTENT
</spec_template>

<target_path>$SPEC_OUTPUT_PATH</target_path>

Generate the Lean spec file following these conventions:
- @[progress] theorem pattern
- exists result for return type
- Array types use (Array U64 5#usize) notation
- Interpretation functions where applicable
- sorry as proof placeholder
- Correct import paths

Write the spec file using the Write tool (VS Code diff).
User will approve the diff inline.

Return with ## EXECUTION COMPLETE"
)
```

Wait for `## EXECUTION COMPLETE`. If `## ERROR`, display the error and stop.

## Step 7: Validate Spec Structure

After executor returns, verify the generated spec file:

```bash
# File exists
[ -f "$SPEC_OUTPUT_PATH" ] && echo "File exists" || echo "MISSING"

# Has @[progress] attribute
grep -c "@\[progress\]" "$SPEC_OUTPUT_PATH"

# Has existential form with sorry
grep -c "sorry" "$SPEC_OUTPUT_PATH"

# Has correct imports
grep "^import" "$SPEC_OUTPUT_PATH"
```

Check:
- File exists at expected path
- Has correct Lean imports (project Funs, Types/Defs)
- Has `@[progress]` attribute
- Has existential form (`exists result`) with sorry
- Module path matches project namespace

## Step 8: Optional Build Check

```bash
nice -n 19 lake build 2>&1 | tail -20
```

- If build fails on import errors: note for user.
- If build fails on type errors: note for user.
- Sorry warnings are expected and correct at this stage.

NEVER run plain `lake build`. Always use `nice -n 19 lake build`.

## Step 9: Display Summary

```
FVS >> GENERATING SPEC

Function: {lean_qualified_name}
Spec file: Specs/{path}/{FunctionName}.lean
Postconditions: {summary of what spec asserts}
Dependencies: [N] specs found, [M] missing
Status: [??] Ready for verification (contains sorry)
```

## Step 10: Suggest Next Command

```
>> Next Up

/fvs:lean-verify Specs/{path}/{FunctionName}.lean
```

</process>

<success_criteria>
- [ ] Target function resolved to Lean name and Funs.lean location
- [ ] Config read and models resolved for fvs-researcher and fvs-executor
- [ ] Research subagent dispatched with inlined aeneas-patterns and spec-conventions
- [ ] Executor subagent dispatched with research findings, spec template, and target path
- [ ] Spec file generated with correct imports, @[progress], existential form, sorry
- [ ] Spec file written to Specs/ directory via VS Code diff
- [ ] Clear next step offered to user
</success_criteria>
