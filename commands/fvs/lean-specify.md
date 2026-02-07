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
Generate a Lean specification file for a single function. Takes a verification target (function name), analyzes it deeply via Rust source and Lean translation, checks dependency spec status, and generates a .lean spec file with @[progress] theorem, existential postconditions, and sorry placeholder.

Output: Specs/{path}/{FunctionName}.lean with theorem statement and sorry.
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

## Step 3: Read Reference Files for Agent Dispatch

Read the three reference files. These MUST be inlined into Task() prompts because @-references do not cross Task boundaries.

```bash
AENEAS_PATTERNS=$(cat ~/.claude/fv-skills/references/aeneas-patterns.md)
SPEC_CONVENTIONS=$(cat ~/.claude/fv-skills/references/lean-spec-conventions.md)
SPEC_TEMPLATE=$(cat ~/.claude/fv-skills/templates/spec-file.lean)
```

## Step 4: Extract Function Body from Funs.lean

Read the target function's complete definition from Funs.lean. Also extract relevant type definitions from Types.lean that the function references.

```bash
FUNS_LEAN=$(find . -name "Funs.lean" -not -path "./.lake/*" | head -1)
TYPES_LEAN=$(find . -name "Types.lean" -not -path "./.lake/*" | head -1)
```

Extract the function body (from `def` to the next top-level `def` or end of file). Extract referenced types from Types.lean by searching for struct/enum names used in the function signature.

## Step 5: Dispatch fvs-code-reader for Deep Analysis

```
Task(
  prompt="Deep analysis of function for spec generation.

<function_body>
$FUNCTION_BODY_FROM_FUNS_LEAN
</function_body>

<rust_source>
$RUST_FUNCTION_SOURCE (if available from Rust source directory)
</rust_source>

<type_context>
$RELEVANT_TYPES_FROM_TYPES_LEAN
</type_context>

<aeneas_patterns>
$AENEAS_PATTERNS
</aeneas_patterns>

<spec_conventions>
$SPEC_CONVENTIONS
</spec_conventions>

Mode: deep-analysis
Analyze: control flow, type deps, arithmetic ops, error paths, postcondition candidates.
Return with ## ANALYSIS COMPLETE or ## ERROR.",
  subagent_type="fvs-code-reader",
  description="Deep analysis of $TARGET for spec generation"
)
```

Parse the returned analysis:
- Postcondition candidates
- Precondition bounds (from Rust source analysis)
- Complexity assessment
- Proof strategy notes

## Step 6: Check Dependency Spec Status

From CODEMAP.md dependency graph (or from the code reader analysis), identify callees of the target function:

```bash
for dep in $DEPENDENCIES; do
  SPEC=$(find Specs/ -name "${dep}*_spec.lean" -o -name "${dep}*.lean" 2>/dev/null | head -1)
  if [ -n "$SPEC" ]; then
    SORRY=$(grep -c "sorry" "$SPEC" 2>/dev/null || echo 0)
    echo "FOUND: $dep (sorry=$SORRY)"
  else
    echo "MISSING: $dep"
  fi
done
```

If dependencies lack specs: warn user with options.
- Continue anyway (proof will need these specs later)
- Specify a dependency first (`/fvs:lean-specify dep_function_name`)

Warn but allow continuation.

## Step 7: Dispatch fvs-lean-spec-generator

```
Task(
  prompt="Generate Lean spec file for $TARGET.

<function_analysis>
$CODE_READER_ANALYSIS_FROM_STEP_5
</function_analysis>

<dependency_spec_status>
$DEPENDENCY_STATUS_FROM_STEP_6
</dependency_spec_status>

<spec_template>
$SPEC_TEMPLATE
</spec_template>

<spec_conventions>
$SPEC_CONVENTIONS
</spec_conventions>

<target_path>$SPEC_OUTPUT_PATH</target_path>
<lean_namespace>$LEAN_NAMESPACE_FROM_FUNS_LEAN</lean_namespace>
<project_name>$PROJECT_NAME</project_name>

Write the spec file to $SPEC_OUTPUT_PATH via Write tool.
Return with ## SPEC GENERATED or ## ERROR.",
  subagent_type="fvs-lean-spec-generator",
  description="Generating spec for $TARGET"
)
```

Wait for `## SPEC GENERATED`. If `## ERROR`, display the error and stop.

## Step 8: Validate Spec Structure

After agent returns, verify the generated spec file:

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

## Step 9: Optional Build Check

```bash
nice -n 19 lake build 2>&1 | tail -20
```

- If build fails on import errors: note for user.
- If build fails on type errors: note for user.
- Sorry warnings are expected and correct at this stage.

NEVER run plain `lake build`. Always use `nice -n 19 lake build`.

## Step 10: Display Summary

```
FVS >> GENERATING SPEC

Function: {lean_qualified_name}
Spec file: Specs/{path}/{FunctionName}.lean
Postconditions: {summary of what spec asserts}
Dependencies: [N] specs found, [M] missing
Status: [??] Ready for verification (contains sorry)
```

## Step 11: Suggest Next Command

```
>> Next Up

/fvs:lean-verify Specs/{path}/{FunctionName}.lean
```

</process>

<success_criteria>
- [ ] Target function resolved to Lean name and Funs.lean location
- [ ] Deep analysis of function body, types, and control flow completed
- [ ] Dependency specs checked with clear status report
- [ ] Spec file generated with correct imports, @[progress], existential form, sorry
- [ ] Spec file written to Specs/ directory via VS Code diff
- [ ] Clear next step offered to user
</success_criteria>
