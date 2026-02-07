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

Scans Funs.lean to extract all translated functions, builds a dependency graph,
maps Lean names back to Rust source, and identifies leaf functions as verification
entry points.

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
cat fvs-config.json 2>/dev/null

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
```

If fvs-config.json exists, use its paths as overrides.

Confirm all paths with user before proceeding:
```
Detected project paths:
  Funs.lean:  {FUNS_LEAN}
  Types.lean: {TYPES_LEAN}
  Specs/:     {SPECS_DIR}
  Toolchain:  {LEAN_TOOLCHAIN}
  Rust source: {RUST_SOURCE_DIR or "not found"}

Correct? (y/n)
```

## Step 2: Create .formalising/ directory

```bash
mkdir -p .formalising/fv-plans
```

If .formalising/ already exists, ask user whether to refresh CODEMAP.md or abort.

## Step 3: Read reference files for agent dispatch

Read reference content into variables. These will be inlined into Task() prompts
because @-references do NOT cross Task() boundaries.

```bash
AENEAS_PATTERNS=$(cat ~/.claude/fv-skills/references/aeneas-patterns.md)
SPEC_CONVENTIONS=$(cat ~/.claude/fv-skills/references/lean-spec-conventions.md)
```

## Step 4: Dispatch fvs-dependency-analyzer

Display dispatch indicator:
```
>> Dispatching fvs-dependency-analyzer...
```

Spawn the agent to parse Funs.lean and build the dependency graph:

```
Task(
  prompt="Parse Funs.lean and build dependency graph.

<funs_lean_path>{FUNS_LEAN}</funs_lean_path>
<types_lean_path>{TYPES_LEAN}</types_lean_path>

<aeneas_patterns>
$AENEAS_PATTERNS
</aeneas_patterns>

Return with ## MAPPING COMPLETE or ## ERROR.",
  subagent_type="fvs-dependency-analyzer",
  description="Parsing Funs.lean for dependency graph"
)
```

Wait for agent to return. Parse the result:
- If `## MAPPING COMPLETE`: extract function inventory, adjacency list, and leaf functions
- If `## ERROR`: display error, offer user to retry or abort

Display:
```
[OK] fvs-dependency-analyzer complete: {N} functions, {M} leaf
```

## Step 5: Dispatch fvs-code-reader for Rust enrichment

If Rust source directory was found or configured, dispatch fvs-code-reader in
enrichment mode to map Lean names back to Rust source:

```
>> Dispatching fvs-code-reader (enrichment mode)...
```

```
Task(
  prompt="Enrich function inventory with Rust source mappings.

<function_list>
$FUNCTION_LIST_FROM_STEP_4
</function_list>
<rust_source_dir>{RUST_SOURCE_DIR}</rust_source_dir>

<aeneas_patterns>
$AENEAS_PATTERNS
</aeneas_patterns>

Mode: enrichment
Return with ## ANALYSIS COMPLETE or ## ERROR.",
  subagent_type="fvs-code-reader",
  description="Mapping Lean names to Rust source"
)
```

If no Rust source directory available: skip this step, note in CODEMAP.md that
Rust mapping is unavailable.

Display:
```
[OK] fvs-code-reader complete: {N} functions mapped to Rust source
```

## Step 6: Auto-detect project definitions

Scan for hand-written .lean files that are NOT Aeneas-generated:

```bash
find {PROJECT_DIR} -name "*.lean" -not -path "*/.lake/*" \
  -not -name "Types.lean" -not -name "Funs.lean" \
  -not -name "TypesExternal.lean" -not -name "FunsExternal.lean" \
  -not -path "*/Specs/*" 2>/dev/null
```

For each candidate file, check for definition patterns:
```bash
grep -l "^def \|^noncomputable def \|^abbrev " {file} 2>/dev/null
```

Present findings to user:
```
Found project definitions:
  {file}: {list of definitions}

Are these the project's mathematical definitions? (y/n)
Where do project-specific definitions live? (e.g., Defs.lean, MathDefs.lean)
```

Record confirmed definitions path and any interpretation functions or constants
found for inclusion in CODEMAP.md.

## Step 7: Scan existing specs

Check for existing specification files and their sorry status:

```bash
find Specs/ -name "*.lean" 2>/dev/null | while read f; do
  SORRY_COUNT=$(grep -c "sorry" "$f" 2>/dev/null || echo 0)
  if [ "$SORRY_COUNT" -eq 0 ]; then
    echo "[OK] $f"
  else
    echo "[??] $f ($SORRY_COUNT sorry remaining)"
  fi
done
```

If no Specs/ directory found:
```
No Specs/ directory found. This project has no existing specifications yet.
```

## Step 8: Combine results into CODEMAP.md

Assemble all analysis results into a single CODEMAP.md document:

```markdown
# CODEMAP

## Project Info
- Lean toolchain: [from lean-toolchain]
- Aeneas backend: [revision from lakefile.toml if available]
- Function count: [N total]
- Leaf functions: [M identified]
- Defs file: [detected or user-confirmed path]
- Interpretation functions: [detected definitions, if any]
- Constants: [detected named constants, if any]

## Function Inventory
| # | Lean Name | Rust Name | Deps | Leaf | Status |
|---|-----------|-----------|------|------|--------|
| 1 | Project.mod.fn | mod::fn | 2 | no | [--] |
| 2 | Project.mod.fn2 | mod::fn2 | 0 | yes | [OK] |

## Dependency Graph
- Project.mod.fn_a -> Project.mod.fn_b, Project.mod.fn_c
- Project.mod.fn_b -> (leaf)

## Verification Entry Points
[Leaf functions sorted by estimated complexity (fewer args, simpler types first)]

## Existing Specs
[Specs/*.lean files with sorry counts and status symbols]
| File | Status | Sorry Count |
|------|--------|-------------|
| Specs/Mod/Fn.lean | [OK] | 0 |
| Specs/Mod/Fn2.lean | [??] | 3 |
```

Status symbols:
- `[OK]` verified (spec exists, zero sorry)
- `[??]` in progress (spec exists, has sorry)
- `[--]` no spec exists

## Step 9: Write CODEMAP.md via VS Code diff

Write the assembled CODEMAP.md to `.formalising/CODEMAP.md` using the Write tool.
The user will see a diff and approve or reject the write.

## Step 10: Display summary with FVS >> banner

```
FVS >> MAPPING CODE

Project: [name from directory or config]
Functions: [N] total, [M] leaf functions
Existing specs: [K] files ([J] with sorry remaining)
Recommended starting points: [top 5 leaf functions]

Written: .formalising/CODEMAP.md
```

## Step 11: Suggest next command

```
>> Next Up

/fvs:plan to select verification targets
```

</process>

<success_criteria>
- [ ] Project detected via lakefile.toml + lean-toolchain (or fvs-config.json)
- [ ] .formalising/ directory created
- [ ] Funs.lean parsed with all functions extracted
- [ ] Dependency graph built with edges and leaf identification
- [ ] Rust source enrichment attempted (if available)
- [ ] Project definitions auto-detected and confirmed by user
- [ ] CODEMAP.md written to .formalising/ via VS Code diff
- [ ] Existing specs scanned for sorry status
- [ ] Summary displayed with recommended next steps
</success_criteria>
