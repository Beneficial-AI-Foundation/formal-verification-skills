---
name: fvs:map-code
description: Build function dependency graph from extracted Lean code and Rust source
argument-hint: "[optional: path to project root]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
  - Task
---

<objective>
Analyze an Aeneas-generated Lean project to produce .formalising/CODEMAP.md.

Dispatches a two-phase subagent pipeline: fvs-researcher gathers context (read-only),
then fvs-executor writes the structured CODEMAP.md file.

Output: .formalising/CODEMAP.md with function inventory, dependency graph, and
recommended verification entry points.
</objective>

<execution_context>
@~/.claude/fv-skills/workflows/map-code.md
@~/.claude/fv-skills/references/ui-brand.md
</execution_context>

<context>
Project path: $ARGUMENTS (optional -- defaults to current working directory)

Check for existing .formalising/ directory:
- If found, ask user: "Existing .formalising/ found. Refresh CODEMAP.md? (y/n)"
- If not found, will be created in step 2

This command can run anytime to refresh the codebase map.
</context>

<process>

## Step 1: Detect project

Check for an Aeneas project. Look for config first, then auto-detect:

```bash
# Check for FVS config override
cat .formalising/fvs-config.json 2>/dev/null

# Auto-detect via marker files
[ -f lakefile.toml ] && [ -f lean-toolchain ] && echo "Lean project detected"
```

If neither fvs-config.json nor marker files found:
```
No fvs-config.json or lakefile.toml found.

Is this an Aeneas-generated Lean project?
- Point me to the project root, or
- Create fvs-config.json manually
```
Wait for user response.

Extract key paths (from config or by searching):

```bash
# Find Funs.lean (exclude .lake build cache)
FUNS_LEAN=$(find . -name "Funs.lean" -not -path "*/.lake/*" 2>/dev/null | head -1)
TYPES_LEAN=$(find . -name "Types.lean" -not -path "*/.lake/*" 2>/dev/null | head -1)
SPECS_DIR=$(find . -type d -name "Specs" -not -path "*/.lake/*" 2>/dev/null | head -1)
LEAN_TOOLCHAIN=$(cat lean-toolchain 2>/dev/null)
RUST_SRC=$(find . -name "Cargo.toml" -not -path "*/.lake/*" 2>/dev/null | head -1 | xargs dirname 2>/dev/null)
```

If fvs-config.json exists, use its paths as overrides.

Confirm all paths with user before proceeding:
```
Detected project paths:
  Funs.lean:  {FUNS_LEAN}
  Types.lean: {TYPES_LEAN}
  Specs/:     {SPECS_DIR}
  Toolchain:  {LEAN_TOOLCHAIN}
  Rust source: {RUST_SRC or "not found"}

Correct? (y/n)
```

## Step 2: Create .formalising/ directory

```bash
mkdir -p .formalising/fv-plans
```

If .formalising/ already exists, ask user whether to refresh CODEMAP.md or abort.

## Step 3: Read config and resolve models

Read the project config to determine which models to use for subagent dispatch:

```bash
CONFIG=$(cat .formalising/fvs-config.json 2>/dev/null)
```

If config exists, extract `model_profile` and `model_overrides`.
If config is missing, use defaults: `model_profile = "quality"`, no overrides.

**Resolve models from profile table** (see fv-skills/references/model-profiles.md):

For `fvs-researcher`:
- Check `model_overrides["fvs-researcher"]` first
- Otherwise use profile table: quality=inherit, balanced=sonnet, budget=haiku

For `fvs-executor`:
- Check `model_overrides["fvs-executor"]` first
- Otherwise use profile table: quality=inherit, balanced=sonnet, budget=sonnet

Store resolved models as `$RESEARCH_MODEL` and `$EXECUTOR_MODEL`.

## Step 4: Read reference files for inlining

Read ALL reference files that the subagents need. These MUST be inlined into Task()
prompts because @-references do NOT cross Task() boundaries.

```bash
AENEAS_PATTERNS=$(cat ~/.claude/fv-skills/references/aeneas-patterns.md)
SPEC_CONVENTIONS=$(cat ~/.claude/fv-skills/references/lean-spec-conventions.md)
```

## Step 5: Dispatch fvs-researcher (read-only scan)

Display dispatch indicator:
```
>> Dispatching fvs-researcher (map-code)...
```

Spawn the research subagent to scan the project and gather context:

```
Task(
  subagent_type="fvs-researcher",
  model="$RESEARCH_MODEL",
  description="Map codebase dependencies",
  prompt="Research mode: map-code

<project_root>$PROJECT_ROOT</project_root>
<funs_lean_path>$FUNS_LEAN</funs_lean_path>
<types_lean_path>$TYPES_LEAN</types_lean_path>
<rust_source_root>$RUST_SRC</rust_source_root>

<aeneas_patterns>
$AENEAS_PATTERNS
</aeneas_patterns>

<spec_conventions>
$SPEC_CONVENTIONS
</spec_conventions>

Tasks:
1. Read Funs.lean -- extract ALL function definitions (name, signature, body)
2. Build dependency graph (which functions call which)
3. Map Lean names back to Rust source files + line numbers
4. Identify leaf functions (no outgoing calls = verification entry points)
5. Read Types.lean for type inventory
6. Scan existing Specs/ for sorry status

Return with ## RESEARCH COMPLETE"
)
```

For large projects, the research subagent may fan out parallel sub-tasks using
`run_in_background=true` for scanning multiple source directories simultaneously.

Wait for agent to return. Parse the result:
- If `## RESEARCH COMPLETE`: extract findings for executor
- If `## ERROR`: display error, offer user to retry or abort

Display:
```
[OK] fvs-researcher complete: {N} functions found, {M} types catalogued
```

## Step 6: Dispatch fvs-executor (write CODEMAP.md)

Display dispatch indicator:
```
>> Dispatching fvs-executor (map-code)...
```

Spawn the executor subagent with research findings:

```
Task(
  subagent_type="fvs-executor",
  model="$EXECUTOR_MODEL",
  description="Write CODEMAP.md",
  prompt="Execute mode: map-code

<research_findings>
$RESEARCH_SUBAGENT_OUTPUT
</research_findings>

Write .formalising/CODEMAP.md with:
- Project info (toolchain, function count, leaf count)
- Function inventory table (Lean name, Rust name, source file, line, deps, leaf, status)
- Dependency graph (caller -> callee adjacency list)
- Verification entry points (leaf functions sorted by estimated complexity)
- Type inventory
- Existing specs with sorry counts

Status symbols:
- [OK] verified (spec exists, zero sorry)
- [??] in progress (spec exists, has sorry)
- [--] no spec exists

Use the Write tool (VS Code diff). User will approve the diff.
Return with ## EXECUTION COMPLETE"
)
```

Wait for executor to return. Parse the result:
- If `## EXECUTION COMPLETE`: confirm CODEMAP.md written
- If `## ERROR`: display error, offer user to retry or abort

Display:
```
[OK] fvs-executor complete: CODEMAP.md written
```

## Step 7: Display summary with FVS >> banner

```
FVS >> MAP COMPLETE

Project: [name from directory or config]
Functions: [N] total, [M] leaf functions
Existing specs: [K] files ([J] with sorry remaining)
Recommended starting points: [top 5 leaf functions]

Written: .formalising/CODEMAP.md
```

## Step 8: Suggest next command

```
>> Next Up

/fvs:plan to select verification targets
```

</process>

<success_criteria>
- [ ] Project detected via lakefile.toml + lean-toolchain (or fvs-config.json)
- [ ] .formalising/ directory created
- [ ] Model profile resolved from .formalising/fvs-config.json (or quality default)
- [ ] fvs-researcher dispatched with inlined references, returns function inventory
- [ ] fvs-executor dispatched with research findings, writes CODEMAP.md
- [ ] CODEMAP.md written to .formalising/ via VS Code diff
- [ ] Summary displayed with recommended next steps
</success_criteria>
