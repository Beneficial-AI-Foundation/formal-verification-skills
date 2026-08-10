---
name: fvs:lean-specify
description: Generate Lean spec skeleton following @[step] theorem pattern
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
Generate a Lean specification file for a single function using two-phase subagent dispatch. Takes a
verification target (function name), loads the target repository's style guide, dispatches a
researcher to gather context (Funs.lean, Types.lean, Rust source, existing stubs, similar specs),
then dispatches an executor to write and mechanically style-check the spec file.

Output: Specs/{path}/{FunctionName}.lean with @[step] theorem, existential postconditions, and sorry placeholder.
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

## Step 4: Discover and Load the Target Style Guide

Run the installed, read-only discovery helper from the target repository root:

```bash
STYLE_INFO=$(node ~/.claude/scripts/fvs-lean-style-check.mjs discover \
  --root . --config .formalising/fvs-config.json)
```

Parse `STYLE_INFO` for `status`, `path`, `maxLineLength`, and `maxQualifiedDots`.

- `found`: read the complete file at `path` into `TARGET_STYLE_GUIDE_CONTENT`.
- `fallback`: set `TARGET_STYLE_GUIDE_CONTENT` to the FVS baseline: every generated line is at most
  100 columns, and ordinary Lean identifiers use at most two namespace dots.
- discovery error or multiple candidates: STOP. Show the candidate paths and ask the user to set
  `project.style_guide_path` in `.formalising/fvs-config.json`; never guess which guide wins.

The target guide is a HARD output constraint for names, namespaces, comments, layout, and
formatting. It overrides generic presentation in FVS examples/templates. It cannot weaken the
mathematical statement or source-derived bounds; escalate a semantic conflict instead.

Regardless of whether a guide exists, prefer `namespace`, `open`, local `abbrev`, or local names
over identifiers with three or more namespace dots. Imports and namespace/open declarations may
name the full path.

## Step 5: Read Reference Files for Inlining

Read the reference files that MUST be inlined into Task() prompts because @-references do not cross Task boundaries:

```bash
AENEAS_PATTERNS=$(cat ~/.claude/fv-skills/references/aeneas-patterns.md)
SPEC_CONVENTIONS=$(cat ~/.claude/fv-skills/references/lean-spec-conventions.md)
SPEC_FILE_TEMPLATE_CONTENT=$(cat ~/.claude/fv-skills/templates/spec-file.lean)
```

All three must be captured as content strings for inlining into subagent prompts. The complete
target style guide from Step 4 must be inlined separately into BOTH prompts.

## Step 6: Dispatch Research Subagent

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

<target_style_guide path="$STYLE_GUIDE_PATH"
    max_line_length="$STYLE_MAX_LINE_LENGTH"
    max_qualified_dots="$STYLE_MAX_QUALIFIED_DOTS">
$TARGET_STYLE_GUIDE_CONTENT
</target_style_guide>

Tasks:
1. Read target function body from Funs.lean
2. Read Types.lean for type dependencies used in the function
3. Find Rust source for bounds analysis and pre/post conditions
4. Check .formalising/stubs/ for existing NL explanation (if exists, use it!)
5. Find similar verified specs in Specs/ directory for patterns to follow
6. Determine the correct output path: Specs/{module_path}/{FunctionName}.lean
7. Report the exact target-guide rules and compliant local namespace/naming idioms the executor
   must follow

Return with ## RESEARCH COMPLETE"
)
```

Parse the returned research findings for use by the executor.

## Step 7: Dispatch Executor Subagent

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

<target_style_guide path="$STYLE_GUIDE_PATH"
    max_line_length="$STYLE_MAX_LINE_LENGTH"
    max_qualified_dots="$STYLE_MAX_QUALIFIED_DOTS">
$TARGET_STYLE_GUIDE_CONTENT
</target_style_guide>

<target_path>$SPEC_OUTPUT_PATH</target_path>

Generate the Lean spec file following these conventions:
- @[step] theorem pattern
- exists result for return type
- Array types use (Array U64 5#usize) notation
- Interpretation functions where applicable
- sorry as proof placeholder
- Correct import paths
- The target style guide is a hard constraint
- No line exceeds max_line_length (100 when the guide is silent)
- No theorem name, theorem-statement identifier, or ordinary code identifier has three or more
  namespace dots; use scoped namespace/open declarations or local names/abbreviations instead

Write the spec file using the Write tool (VS Code diff).
User will approve the diff inline.

Return with ## EXECUTION COMPLETE"
)
```

Wait for `## EXECUTION COMPLETE`. If `## ERROR`, display the error and stop.

## Step 8: Run the Mechanical Style Gate

Before structural validation or a build, check the actual generated file:

```bash
node ~/.claude/scripts/fvs-lean-style-check.mjs check "$SPEC_OUTPUT_PATH" \
  --root . --config .formalising/fvs-config.json
```

This gate enforces the target guide's explicit line limit (100 when absent) and rejects ordinary
identifiers containing three or more namespace dots. It ignores comments, strings, imports, and
namespace/open declarations for the qualification rule.

On failure, pass the exact diagnostics, current file, and complete target style guide back to
`fvs-executor` for a STYLE-ONLY repair. Preserve the theorem's mathematical proposition,
preconditions, postconditions, and `sorry`; only wrap/re-indent, introduce a scoped namespace/open,
or add a semantics-preserving local name/abbreviation. The user approves the diff inline.

Run at most two repair passes. Re-run the checker after each pass. If it still fails, STOP and
report the diagnostics; never label the spec ready and never rely on the user to find the remaining
violations manually.

## Step 9: Validate Spec Structure

After executor returns, verify the generated spec file:

```bash
# File exists
[ -f "$SPEC_OUTPUT_PATH" ] && echo "File exists" || echo "MISSING"

# Has @[step] attribute
grep -c "@\[step\]" "$SPEC_OUTPUT_PATH"

# Has existential form with sorry
grep -c "sorry" "$SPEC_OUTPUT_PATH"

# Has correct imports
grep "^import" "$SPEC_OUTPUT_PATH"
```

Check:
- File exists at expected path
- Has correct Lean imports (project Funs, Types/Defs)
- Has `@[step]` attribute
- Has existential form (`exists result`) with sorry
- Module path matches project namespace

## Step 10: Optional Build Check

```bash
nice -n 19 lake build 2>&1 | tail -20
```

- If build fails on import errors: note for user.
- If build fails on type errors: note for user.
- Sorry warnings are expected and correct at this stage.

NEVER run plain `lake build`. Always use `nice -n 19 lake build`.

## Step 11: Display Summary

```
FVS >> GENERATING SPEC

Function: {lean_qualified_name}
Spec file: Specs/{path}/{FunctionName}.lean
Postconditions: {summary of what spec asserts}
Dependencies: [N] specs found, [M] missing
Style:     [OK] {target guide path | FVS 100-column fallback}
Status: [??] Ready for verification (contains sorry)
```

## Step 12: Suggest Next Command

```
>> Next Up

/fvs:lean-verify Specs/{path}/{FunctionName}.lean
```

</process>

<success_criteria>
- [ ] Target function resolved to Lean name and Funs.lean location
- [ ] Config read and models resolved for fvs-researcher and fvs-executor
- [ ] Target style guide discovered unambiguously (or explicit FVS fallback recorded) and read fully
- [ ] Research subagent dispatched with inlined aeneas-patterns, spec-conventions, and target guide
- [ ] Executor subagent dispatched with research findings, spec template, target path, and target guide
- [ ] Spec file generated with correct imports, @[step], existential form, sorry
- [ ] Mechanical style gate passes: line limit respected and no 3+-dot ordinary identifiers
- [ ] Spec file written to Specs/ directory via VS Code diff
- [ ] Clear next step offered to user
</success_criteria>
