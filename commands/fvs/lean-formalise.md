---
name: fvs:lean-formalise
description: Formalise mathematical paper content into Lean 4 specs (paper track)
argument-hint: "(interactive prompts for task, resources, KB, module path)"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
  - Task
---

<objective>
Formalise mathematical content from papers and resources into Lean 4 specification files. This is the "paper track" parallel to the existing code track (lean-specify). Both tracks share lean-verify for proof attempts.

Two-phase dispatch: fvs-researcher gathers mathematical structure from resources and KB, then fvs-executor writes Lean definition and spec files.

Key difference from code track: paper track creates BOTH definition files (structures, types) AND spec files (theorems with sorry), since there is no Aeneas extraction providing types.

Output: Lean definition and spec files at user-specified module path, with sorry placeholders ready for /fvs:lean-verify.
</objective>

<execution_context>
@~/.claude/fv-skills/workflows/lean-formalise.md
@~/.claude/fv-skills/references/ui-brand.md
</execution_context>

<context>
Arguments: $ARGUMENTS (none expected -- all parameters collected interactively).

- Resources come from .formalising/resources/ (PDFs, images, text, LaTeX) or user-specified paths
- Knowledge base is OPTIONAL enrichment -- command works perfectly without any KB configured
- One KB per invocation (no multi-KB synthesis)
- lean-verify is shared between paper track and code track
</context>

<process>

## Step 1: Collect Parameters via Interactive Prompts

Use AskUserQuestion for all four prompts. This command is fully interactive -- no flags.

**Prompt 1: Task Description**

```
FVS >> FORMALISE

What are you formalising?
(e.g., "CKA key agreement construction from Section 3 of the paper")
```

Store as TASK_DESCRIPTION.

**Prompt 2: Resources Path**

List available resource subfolders if they exist:

```bash
if [ -d ".formalising/resources" ]; then
  echo "Available resource folders:"
  ls -d .formalising/resources/*/  2>/dev/null || echo "  (no subfolders)"
  ls .formalising/resources/*.* 2>/dev/null | head -10
fi
```

```
Where are the resources?
  1. .formalising/resources/{listed subfolders}
  2. Specific file paths (provide paths)
  3. No external resources (working from KB only or general knowledge)
```

Store as RESOURCES_PATH. If "none" or empty: set RESOURCES_PATH="" (this is valid -- KB or general knowledge may suffice).

**Prompt 3: Knowledge Base Selection**

Read knowledge_bases from config:

```bash
KB_CONFIG=$(cat .formalising/fvs-config.json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('knowledge_bases',[])))" 2>/dev/null || echo "[]")
```

If knowledge_bases is empty or not configured: skip this prompt entirely (not an error). Set KB_CONFIG="none".

If knowledge_bases exist, display options:

```
Which knowledge base?
  1. {name} ({domain}) -- {description}
  2. {name} ({domain}) -- {description}
  N. None -- no KB for this task
```

Store selected KB as KB_CONFIG (the full KB entry JSON, or "none").

**Prompt 4: Lean Module Path**

```
What Lean module path for the output?
(e.g., MyProject.CKA.KeyAgreement)
```

Store as MODULE_PATH. Derive output directory: split on dots, map to path components under Specs/ or user-specified root.

## Step 2: Validate Resources

If RESOURCES_PATH is specified:

```bash
# Check paths exist
[ -d "$RESOURCES_PATH" ] || [ -f "$RESOURCES_PATH" ] && echo "Resources found" || echo "WARNING: Path not found"
```

For PDFs in the resources:

```bash
command -v pdftotext >/dev/null 2>&1 && echo "pdftotext available" || echo "WARNING: pdftotext not found. PDF text extraction will be skipped. Install poppler-utils for PDF support."
```

For images (PNG/JPG): note they will be read via Claude's vision capability (Read tool on image files).

If no resources and no KB: warn that the researcher will have limited context, but continue -- the user may be working from general mathematical knowledge.

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
SPEC_CONVENTIONS=$(cat ~/.claude/fv-skills/references/lean-spec-conventions.md)
SPEC_TEMPLATE=$(cat ~/.claude/fv-skills/templates/spec-file.lean)
```

Check for Aeneas project markers:

```bash
FUNS_LEAN=$(find . -name "Funs.lean" -not -path "./.lake/*" 2>/dev/null | head -1)
if [ -n "$FUNS_LEAN" ]; then
  AENEAS_PATTERNS=$(cat ~/.claude/fv-skills/references/aeneas-patterns.md)
  AENEAS_PROJECT=true
else
  AENEAS_PROJECT=false
fi
```

If Aeneas markers found: also read aeneas-patterns.md for inlining.
If no Aeneas markers: skip aeneas-patterns (paper track may be pure math, not Aeneas-extracted).

## Step 5: Dispatch Research Subagent (formalise mode)

```
Task(
  subagent_type="fvs-researcher",
  model="$RESEARCH_MODEL",
  description="Research context for formalisation: $TASK_DESCRIPTION",
  prompt="Research mode: formalise

<task_description>$TASK_DESCRIPTION</task_description>
<resources_path>$RESOURCES_PATH</resources_path>
<kb_config>$KB_CONFIG_JSON</kb_config>
<module_path>$MODULE_PATH</module_path>

<spec_conventions>
$SPEC_CONVENTIONS_CONTENT
</spec_conventions>

[If Aeneas project:]
<aeneas_patterns>
$AENEAS_PATTERNS_CONTENT
</aeneas_patterns>

Tasks:
1. Read all resources (PDFs via pdftotext, images via Read, text directly)
2. If KB configured and domain-relevant: query KB for definitions, structures, key concepts
3. Extract mathematical structure: definitions, properties/invariants, lemmas, main theorem(s)
4. Map to Lean types: propose structure definitions, function signatures, theorem statements
5. Determine dependency order (leaf definitions first, main theorem last)
6. Check existing project definitions (Defs.lean or similar) for reusable types
7. Propose output file structure: which files to create, what each contains

Return with ## RESEARCH COMPLETE"
)
```

Parse the returned research findings.

## Step 6: Review Research Output

Present the researcher's proposed structure to the user for confirmation before creating files:

```
FVS >> FORMALISE -- Proposed Structure

The researcher proposes the following Lean file layout:

Definitions:
  {list of definition files with what each contains}

Specifications:
  {list of spec files with theorem statements}

Dependency Order:
  {ordered list showing which files depend on which}

Proceed with this structure? (y/adjust/abort)
```

Use AskUserQuestion. If user adjusts: incorporate feedback before dispatching executor.

## Step 7: Dispatch Executor Subagent

```
Task(
  subagent_type="fvs-executor",
  model="$EXECUTOR_MODEL",
  description="Create Lean files for formalisation: $TASK_DESCRIPTION",
  prompt="Execute mode: formalise

<research_findings>
$RESEARCH_SUBAGENT_OUTPUT
</research_findings>

<spec_template>
$SPEC_FILE_TEMPLATE_CONTENT
</spec_template>

<module_path>$MODULE_PATH</module_path>

Create Lean files following the researcher's proposed structure:
1. Definition files (structures, basic types, interpretation functions)
2. Spec files with theorem statements and sorry placeholders
3. Correct import paths between files
4. Natural language description blocks before each theorem
5. If in Aeneas project: use @[step] attribute; otherwise: plain theorem

Write files using the Write tool (VS Code diff).
User will approve each diff inline.

Return with ## EXECUTION COMPLETE"
)
```

Wait for `## EXECUTION COMPLETE`. If `## ERROR`, display the error and stop.

## Step 8: Validate Output

After executor returns, verify the generated files:

```bash
# Check each proposed file was created
for FILE in $CREATED_FILES; do
  [ -f "$FILE" ] && echo "FOUND: $FILE" || echo "MISSING: $FILE"
done

# Check theorem statements have sorry
grep -r "sorry" $SPEC_FILES

# Check imports are consistent between definition and spec files
grep "^import" $CREATED_FILES
```

Check:
- All proposed files were created
- Theorem statements have sorry (expected at this stage)
- Imports are consistent between definition and spec files
- If in Aeneas project: check for `@[step]` attribute
- If pure math project: check for plain `theorem` statements

## Step 9: Optional Build Check

```bash
nice -n 19 lake build 2>&1 | tail -20
```

- sorry warnings are expected and correct at this stage
- Import errors or type errors noted for user
- NEVER run plain `lake build`. Always use `nice -n 19 lake build`.

## Step 10: Display Summary and Next Steps

```
FVS >> FORMALISE

Task:      {TASK_DESCRIPTION}
Resources: {resource_count} files from {RESOURCES_PATH}
KB:        {kb_name} or "none"
Files:     {N} created
  - {list of created files with brief description}
Status:    [??] Ready for verification (contains sorry)

>> Next Up

/fvs:lean-verify {first_spec_path}
```

</process>

<success_criteria>
- [ ] Task description, resources, KB, and module path collected via interactive prompts
- [ ] Resources validated (paths exist, pdftotext available for PDFs)
- [ ] Config read and models resolved for fvs-researcher and fvs-executor
- [ ] Reference files inlined into subagent prompts
- [ ] Research subagent dispatched in formalise mode with KB integration
- [ ] Researcher's proposed structure reviewed by user before execution
- [ ] Executor subagent created both definition files AND spec files
- [ ] Generated files validated (sorry present, imports consistent)
- [ ] Build check uses nice -n 19 lake build (never plain lake build)
- [ ] Summary uses FVS >> FORMALISE banner with file list
- [ ] Clear next step offered: /fvs:lean-verify
</success_criteria>
