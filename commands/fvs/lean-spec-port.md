---
name: fvs:lean-spec-port
description: Port formal verification spec from another language to Lean
argument-hint: "[--scan] (interactive prompts for source language, path, function)"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
  - Task
---

<objective>
Port a formal verification specification from another language (Verus, F*, Coq, Dafny) to a Lean specification following FVS conventions. Uses the source spec as a semantic blueprint -- understanding WHAT is proven -- and generates an idiomatic Lean spec.

Two-phase dispatch: fvs-researcher gathers cross-project context, then fvs-executor writes the Lean spec file.

Output: Specs/{path}/{FunctionName}.lean with @[step] theorem, existential postconditions, and sorry placeholder, ported from the source language spec.
</objective>

<execution_context>
@~/.claude/fv-skills/workflows/lean-spec-port.md
@~/.claude/fv-skills/references/ui-brand.md
</execution_context>

<context>
Arguments: $ARGUMENTS (optional --scan flag; parameters collected interactively).

- Source language, source project path, and function name are collected via interactive prompts
- Both the source FV project and target Lean project verify the same Rust code
- The source spec is a SEMANTIC BLUEPRINT -- extract mathematical meaning, not syntax
- Source spec might be inaccurate or wrong -- always cross-reference with Rust source
</context>

<process>

## Step 1: Parse Arguments and Detect --scan Flag

Parse $ARGUMENTS for the --scan flag:

```bash
SCAN_MODE=false
if echo "$ARGUMENTS" | grep -q "\-\-scan"; then
  SCAN_MODE=true
fi
```

If --scan: set SCAN_MODE=true, skip interactive function selection (scan shows all).
If no --scan: set SCAN_MODE=false, proceed to interactive parameter collection.

## Step 2: Collect Parameters via Interactive Prompts

Use AskUserQuestion to collect all parameters interactively. No flags to remember -- the command asks for everything it needs.

**Prompt 1: Source Language**

```
FVS >> SPEC PORT

What source language are you porting from?
  1. Verus
  2. F*
  3. Coq
  4. Dafny
  5. Other (specify)
```

Use AskUserQuestion with numbered options. Store result as SOURCE_LANG.

**Prompt 2: Source Project Path**

```
Path to source project?
(e.g., /path/to/dalek-lite)
```

Use AskUserQuestion for free text. Store as SOURCE_PROJECT_PATH.

Validate the path exists:

```bash
[ -d "$SOURCE_PROJECT_PATH" ] && echo "Source project found" || echo "ERROR: Path does not exist"
```

If path does not exist: ask again.

**Prompt 3: Function Name (skip if --scan mode)**

If SCAN_MODE is false:

```
Function to port? (Lean or Rust name)
(e.g., FieldElement51::add)
```

Use AskUserQuestion for free text. Store as FUNCTION_NAME.

**Detect Target Lean Project:**

Check current directory for Lean project markers:

```bash
[ -f "lakefile.toml" ] || [ -f "lakefile.lean" ] && echo "Lean project detected" || echo "Not a Lean project"
```

If not a Lean project: ask user for target project path via AskUserQuestion.
Store as TARGET_PROJECT_PATH (default: current directory).

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

## Step 5: Dispatch Research Subagent (spec-port mode)

```
Task(
  subagent_type="fvs-researcher",
  model="$RESEARCH_MODEL",
  description="Research cross-project context for spec porting from $SOURCE_LANG",
  prompt="Research mode: spec-port

<source_language>$SOURCE_LANG</source_language>
<source_project_path>$SOURCE_PROJECT_PATH</source_project_path>
<target_function>$FUNCTION_NAME</target_function>
<scan_mode>$SCAN_MODE</scan_mode>

<aeneas_patterns>
$AENEAS_PATTERNS_CONTENT
</aeneas_patterns>

<spec_conventions>
$SPEC_CONVENTIONS_CONTENT
</spec_conventions>

Tasks:
1. If SCAN_MODE: scan both projects, build comparison table of verified/unverified functions, return table and wait for user selection
2. Find the Rust source function in BOTH projects. Compare signatures and bodies. If differences found: report the diff and flag for user confirmation.
3. Read the source spec:
   - Verus: look in verus! blocks for spec fn with ensures/requires matching the function
   - F*: look for val/let with refinement types
   - Coq: look for Theorem/Lemma
   - Dafny: look for ensures/requires
   Extract the semantic content: what pre/postconditions are being verified, what bounds matter, what mathematical meaning.
4. Read 2-3 existing verified Lean specs in the target project's Specs/ directory (no sorry remaining). Identify style conventions: naming, import patterns, comment style, theorem structure.
5. Check for CONTRIBUTING.md or style guide in the target project.
6. Check for mathematical bridges in the target project (Defs.lean, Math/ directory, interpretation functions like Field51_as_Nat).
7. Determine the correct output path: Specs/{module_path}/{FunctionName}.lean

Return with ## RESEARCH COMPLETE"
)
```

Parse the returned research findings. Check for:

- **Rust source diff warning**: If researcher reports differences between projects, present to user via AskUserQuestion:

```
The Rust source function differs between the two projects:

[diff details from researcher]

Proceed anyway? (y/n)
```

If user declines: stop and report.

- **Missing source spec**: If researcher cannot find a spec for the function in the source project, report and suggest running the scan mode to see what is available.

## Step 6: Handle --scan Mode Results

If SCAN_MODE and researcher returns a comparison table:

Display the table to user using FVS status symbols:

```
FVS >> COMPARISON: {source_project} ({SOURCE_LANG}) vs {target_project} (Lean)

| Function           | Source   | Lean     | Action         |
|--------------------|----------|----------|----------------|
| FieldElement51::add | [OK] Verified | [OK] Verified | Skip           |
| FieldElement51::sub | [OK] Verified | [??] Has sorry | Port proof     |
| FieldElement51::mul | [OK] Verified | [--] No spec   | Port spec+proof |
| FieldElement51::neg | [OK] Verified | [--] No spec   | Port spec+proof |

Verified in source but not in Lean: {N} functions
```

Use AskUserQuestion to ask:

```
Select a function to port (enter name or number):
```

Store selection as FUNCTION_NAME. Re-dispatch researcher for the selected function in non-scan mode (repeat Step 5 with SCAN_MODE=false and the selected FUNCTION_NAME).

If not SCAN_MODE: proceed directly to Step 7.

## Step 7: Dispatch Executor Subagent (spec-port mode)

```
Task(
  subagent_type="fvs-executor",
  model="$EXECUTOR_MODEL",
  description="Generate Lean spec from $SOURCE_LANG source for $FUNCTION_NAME",
  prompt="Execute mode: spec-port

<research_findings>
$RESEARCH_SUBAGENT_OUTPUT
</research_findings>

<spec_template>
$SPEC_FILE_TEMPLATE_CONTENT
</spec_template>

<target_path>$SPEC_OUTPUT_PATH</target_path>

Generate an IDIOMATIC Lean spec using the source spec as a semantic blueprint:
- Use @[step] theorem pattern (NOT source language's theorem form)
- Use Aeneas types: (Array U64 5#usize) notation (NOT source language's type notation)
- Use target project's interpretation functions (e.g., Field51_as_Nat, NOT source's fe51_as_nat)
- Inline hypotheses where the target project's convention does so (NOT named predicates from source)
- Cross-reference mathematical content with Rust source -- source spec might be inaccurate
- Include sorry as proof placeholder
- Match the style of existing verified specs in the target project
- Include natural language description block before the theorem

CRITICAL: The source spec is a SEMANTIC BLUEPRINT. Extract the mathematical meaning and translate it to Lean conventions. Do NOT syntactically mirror the source.

Write the spec file using the Write tool (VS Code diff).
User will approve the diff inline.

Return with ## EXECUTION COMPLETE"
)
```

Wait for `## EXECUTION COMPLETE`. If `## ERROR`, display the error and stop.

## Step 8: Validate Spec Structure

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
- Has existential form with sorry
- Module path matches project namespace
- Has natural language description block

## Step 9: Display Summary

```
FVS >> SPEC PORT

Source:    {SOURCE_LANG} ({SOURCE_PROJECT_PATH})
Function:  {FUNCTION_NAME}
Spec file: Specs/{path}/{FunctionName}.lean
Ported:    {summary of postconditions from source spec}
Status:    [??] Ready for verification (contains sorry)
```

## Step 10: Suggest Next Command

```
>> Next Up

/fvs:lean-verify Specs/{path}/{FunctionName}.lean
or
/fvs:lean-proof-port (to port proof from source language too)
```

</process>

<success_criteria>
- [ ] Source language, project path, and function name collected via interactive prompts
- [ ] Config read and models resolved for fvs-researcher and fvs-executor
- [ ] Research subagent dispatched in spec-port mode with inlined aeneas-patterns and spec-conventions
- [ ] Researcher compares Rust source function from both projects, warns on diff
- [ ] Researcher reads source spec as semantic blueprint (extracts mathematical content)
- [ ] Researcher reads 2-3 existing verified Lean specs for style conventions
- [ ] Executor generates idiomatic Lean spec using @[step] pattern and target conventions
- [ ] Spec file written to Specs/ directory via VS Code diff
- [ ] --scan mode shows comparison table and allows function selection
- [ ] Build checks use nice -n 19 lake build (never plain lake build)
- [ ] Clear next step offered: /fvs:lean-verify or /fvs:lean-proof-port
</success_criteria>
