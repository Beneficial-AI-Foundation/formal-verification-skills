<purpose>
Orchestrate codebase analysis for Aeneas-generated Lean projects to produce CODEMAP.md.

Parses Funs.lean to extract all translated functions, builds a dependency graph,
maps Lean names back to Rust source, and identifies leaf functions suitable as
verification starting points.

Output: CODEMAP.md in the project root with function inventory, dependency edges,
and recommended verification entry points.
</purpose>

<process>

<step name="detect_project">
Locate project configuration. Check in order:

1. **fvs-config.json** in project root:
```bash
cat fvs-config.json 2>/dev/null
```

2. **Auto-detect** via marker files:
```bash
[ -f lakefile.toml ] && [ -f lean-toolchain ] && echo "Lean project detected"
```

3. **Prompt user** if neither found:
```
No fvs-config.json or lakefile.toml found.

Is this an Aeneas-generated Lean project?
- Point me to the project root, or
- Run /fvs:init to create fvs-config.json
```
Wait for user response.

**Extract key paths from config or defaults:**
- `funs_lean`: Path to Funs.lean (default: search for Funs.lean recursively)
- `types_lean`: Path to Types.lean
- `rust_source`: Path to original Rust source (optional)
- `specs_dir`: Path to Specs/ directory

If auto-detected, confirm paths with user before proceeding.
</step>

<step name="parse_functions">
Dispatch **fvs-dependency-analyzer** agent to parse Funs.lean.

Agent inputs:
- Path to Funs.lean
- Path to Types.lean (for type context)

Expected outputs:
- Function list with signatures (name, args, return type)
- Dependency edges (which functions call which)
- Identification of leaf functions (no outgoing calls to other project functions)
- Recursive vs non-recursive classification
- Functions using loops (translated as `loop` in Lean)

Reference: @fv-skills/references/aeneas-patterns.md (Pattern 2: naming conventions, Pattern 4: Result/Error types)
</step>

<step name="enrich_with_rust">
If Rust source path is available, dispatch **fvs-code-reader** agent to map Lean names back to Rust.

Agent inputs:
- Function list from previous step
- Rust source directory path

Expected outputs:
- Lean function name to Rust function name mapping
- Rust source file and line number for each function
- Original Rust doc comments (useful for spec intent)
- Rust type annotations (may be clearer than Lean translations)

If no Rust source available: Skip this step, note in CODEMAP.md that Rust mapping is unavailable.

Reference: @fv-skills/references/aeneas-patterns.md (Pattern 1: project structure)
</step>

<step name="generate_codemap">
Combine analysis results into CODEMAP.md.

**Required sections:**

```markdown
# CODEMAP

## Project Info
- Lean toolchain: [version from lean-toolchain]
- Aeneas backend: [revision from lakefile.toml if available]
- Function count: [N total]
- Leaf functions: [M identified]

## Function Inventory
| # | Lean Name | Rust Name | Args | Returns | Recursive | Leaf | Spec Exists |
|---|-----------|-----------|------|---------|-----------|------|-------------|

## Dependency Graph
[Adjacency list: function -> [callees]]

## Verification Entry Points
[Leaf functions sorted by estimated complexity (fewer args, simpler types first)]

## Existing Specs
[List of Specs/*.lean files found, with sorry count per file]
```

**Check for existing specs:**
```bash
find Specs/ -name "*.lean" 2>/dev/null | while read f; do
  SORRY_COUNT=$(grep -c "sorry" "$f" 2>/dev/null || echo 0)
  echo "$f: $SORRY_COUNT sorry remaining"
done
```

Write CODEMAP.md to project root.
</step>

<step name="report_results">
Display summary to user.

```
FVS -- CODEMAP GENERATED

Project: [name from config or directory]
Functions: [N] total, [M] leaf functions
Existing specs: [K] files ([J] with sorry remaining)
Recommended starting points: [top 5 leaf functions]

Written: CODEMAP.md

---

Next: /fvs:plan to select verification targets
```
</step>

</process>

<success_criteria>
- Project detected via fvs-config.json or auto-detection
- Funs.lean parsed with all functions extracted
- Dependency graph built with edges and leaf identification
- CODEMAP.md written with all required sections
- Existing specs scanned for sorry status
- Clear summary displayed with recommended next steps
</success_criteria>
