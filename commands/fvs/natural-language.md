---
name: fvs:natural-language
description: Generate detailed NL explanation of module/function into .formalising/stubs/ MD files
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
Generate a detailed natural-language explanation of a Rust function. Resolves the target function, reads the full Rust module and Lean translation, dispatches fvs-explainer for analysis, and writes a structured stub file.

Stubs capture the human reasoning (pre/postconditions, bounds, mathematical meaning) that informs later spec writing.

Output: .formalising/stubs/{ModuleName}/{FunctionName}.md
</objective>

<execution_context>
@~/.claude/fv-skills/workflows/natural-language.md
@~/.claude/fv-skills/references/ui-brand.md
</execution_context>

<context>
Target function: $ARGUMENTS (required -- function name in Lean or Rust form).

- Check for .formalising/CODEMAP.md for function lookup
- Template: ~/.claude/fv-skills/templates/stub.md defines output format
- Single-function mode: one function per invocation
</context>

<process>

## Step 1: Resolve Target Function

Accept $ARGUMENTS as function name. Search in CODEMAP.md if available, then Funs.lean, then Rust source:

```bash
TARGET="$ARGUMENTS"

# Try CODEMAP first
grep -i "$TARGET" .formalising/CODEMAP.md 2>/dev/null

# Fall back to Funs.lean
FUNS_LEAN=$(find . -name "Funs.lean" -not -path "*/.lake/*" | head -1)
grep "def.*${TARGET}" "$FUNS_LEAN" 2>/dev/null

# Fall back to Rust source
grep -rn "fn ${TARGET}" src/ 2>/dev/null
```

Resolve to:
- Lean qualified name (e.g., `MyProject.my_module.my_function`)
- Rust source file + line range
- Module path (the containing Rust module)
- Output stub path: `.formalising/stubs/{ModuleName}/{FunctionName}.md`

If not found: show fuzzy matches and suggest `/fvs:map-code`.

```
Function "{target}" not found.

Did you mean one of these?
[fuzzy matches]

Or run /fvs:map-code to build the function index.
```

Wait for user clarification.

## Step 2: Read Reference Files for Agent Dispatch

Read the three reference files. These MUST be inlined into the Task() prompt because @-references do NOT cross Task boundaries.

```bash
AENEAS_PATTERNS=$(cat ~/.claude/fv-skills/references/aeneas-patterns.md)
SPEC_CONVENTIONS=$(cat ~/.claude/fv-skills/references/lean-spec-conventions.md)
STUB_TEMPLATE=$(cat ~/.claude/fv-skills/templates/stub.md)
```

## Step 3: Read Source Files

Read the ENTIRE Rust module file (not just the target function) for module context. Read the target function's Lean translation from Funs.lean. Read relevant type definitions from Types.lean.

```bash
FUNS_LEAN=$(find . -name "Funs.lean" -not -path "*/.lake/*" | head -1)
TYPES_LEAN=$(find . -name "Types.lean" -not -path "*/.lake/*" | head -1)
```

Read the full Rust module file at the resolved path. Extract the function body from Funs.lean (from `def` to the next top-level `def` or end of file). Extract referenced types from Types.lean by searching for struct/enum names used in the function signature.

## Step 4: Dispatch fvs-explainer Agent

Display dispatch indicator:
```
>> Dispatching fvs-explainer...
```

```
Task(
  prompt="Analyze function for natural-language explanation.

<rust_module>
$FULL_RUST_MODULE_SOURCE
</rust_module>

<target_function>
$RUST_FUNCTION_SOURCE
</target_function>

<lean_translation>
$LEAN_FUNCTION_BODY_FROM_FUNS_LEAN
</lean_translation>

<type_context>
$RELEVANT_TYPES_FROM_TYPES_LEAN
</type_context>

<module_path>$RUST_MODULE_PATH</module_path>

<aeneas_patterns>
$AENEAS_PATTERNS
</aeneas_patterns>

<spec_conventions>
$SPEC_CONVENTIONS
</spec_conventions>

Analyze this function in two phases:
1. Module analysis (purpose, data flow, placement, key types)
2. Function analysis (algorithm with annotated Rust source, pre/postconditions, bounds, math meaning)

Return with ## EXPLANATION COMPLETE or ## ERROR.",
  subagent_type="fvs-explainer",
  description="NL explanation of $TARGET"
)
```

Wait for agent to return. Parse the result:
- If `## EXPLANATION COMPLETE`: extract sections for stub file
- If `## ERROR`: display error, offer user to retry or abort

Display:
```
[OK] fvs-explainer complete: explanation generated
```

## Step 5: Write Stub File

Parse agent output sections. Merge with stub template format from Step 2.

```bash
mkdir -p .formalising/stubs/$(dirname "$STUB_PATH")
```

Assemble the stub file using the stub.md template structure with agent-provided content for each section:
- Module Context (from agent Phase A)
- Function header (signature, Lean extraction name, source location)
- What It Does (algorithmic description with annotated Rust source)
- Preconditions (type-level, value-level, semantic)
- Postconditions (structural, semantic)
- Bounds Reasoning (worst-case arithmetic walkthrough)
- Mathematical Meaning (interpretation functions, core theorem in English)

Write stub file to `.formalising/stubs/{ModuleName}/{FunctionName}.md` using the Write tool (VS Code diff).

## Step 6: Validate Stub

Check all required sections present in the written file:

```bash
STUB_FILE=".formalising/stubs/${MODULE_NAME}/${FUNCTION_NAME}.md"
for section in "Module Context" "What It Does" "Preconditions" "Postconditions" "Bounds Reasoning" "Mathematical Meaning"; do
  grep -q "## .*${section}\|### ${section}" "$STUB_FILE" && echo "[OK] ${section}" || echo "[XX] ${section} MISSING"
done
```

If any section missing: warn user, offer to regenerate.

## Step 7: Display Summary

```
FVS >> STUB GENERATED

Function: {function_name}
Module:   {rust_module_path}
Stub:     .formalising/stubs/{ModuleName}/{FunctionName}.md
Sections: [OK] all required sections present
```

```
>> Next Up

/fvs:lean-specify {function_name} to generate the Lean spec
```

</process>

<success_criteria>
- [ ] Target function resolved to Rust source and Lean extraction
- [ ] Full Rust module read for context (not just target function)
- [ ] fvs-explainer dispatched with inlined references
- [ ] Stub file written with all required sections via VS Code diff
- [ ] Stub includes annotated Rust source snippets (not abstract prose)
- [ ] Stub is standalone (no cross-references to spec files)
- [ ] Clear next step offered (/fvs:lean-specify)
</success_criteria>
