<purpose>
Orchestrate codebase analysis for Aeneas-generated Lean projects to produce CODEMAP.md.

Uses a two-phase subagent dispatch: fvs-researcher gathers all project context (read-only),
then fvs-executor writes the structured CODEMAP.md file.

Output: .formalising/CODEMAP.md with function inventory, dependency graph, type inventory,
and recommended verification entry points.
</purpose>

<process>

<step name="detect_project">
Locate project configuration. Check in order:

1. **fvs-config.json** in .formalising/:
```bash
cat .formalising/fvs-config.json 2>/dev/null
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

<step name="resolve_models">
Read `.formalising/fvs-config.json` for model profile configuration.

If config exists: extract `model_profile` and `model_overrides`.
If config missing: default to `quality` profile with no overrides.

Resolve models for both subagents using the profile table
(see fv-skills/references/model-profiles.md):

- `fvs-researcher`: quality=inherit, balanced=sonnet, budget=haiku
- `fvs-executor`: quality=inherit, balanced=sonnet, budget=sonnet

Check `model_overrides` for per-agent overrides before using profile defaults.

Reference: @fv-skills/references/model-profiles.md (dispatch pattern, resolution sequence)
</step>

<step name="research_phase">
Dispatch **fvs-researcher** in map-code mode (read-only context gathering).

Read reference files for inlining into the Task() prompt:
- aeneas-patterns.md (naming conventions, project structure, dependency patterns)
- lean-spec-conventions.md (for understanding code structure and spec naming)

These are INLINED because @-references do NOT cross Task() boundaries.

Agent inputs (all inlined in prompt):
- Path to Funs.lean and Types.lean
- Rust source root (if available)
- aeneas-patterns.md content
- lean-spec-conventions.md content

Expected outputs:
- Function list with signatures (name, args, return type)
- Dependency edges (which functions call which)
- Leaf function identification (no outgoing calls to project functions)
- Recursive vs non-recursive classification
- Type inventory from Types.lean
- Rust-to-Lean name mappings (if Rust source available)
- Existing spec status (sorry counts)

Agent returns with `## RESEARCH COMPLETE` containing structured `<findings>`,
`<relevant_files>`, and `<recommendations>` sections.

For large projects, the researcher may fan out parallel sub-tasks using
`run_in_background=true` for scanning multiple source directories.

Reference: @fv-skills/references/aeneas-patterns.md (Pattern 2: naming conventions, Pattern 4: Result/Error types)
</step>

<step name="execution_phase">
Dispatch **fvs-executor** in map-code mode with research findings.

Agent inputs (all inlined in prompt):
- Complete research findings from fvs-researcher output
- No additional reference files needed (researcher already processed them)

The executor writes `.formalising/CODEMAP.md` with:

```markdown
# CODEMAP

## Project Info
- Lean toolchain: [from lean-toolchain]
- Aeneas backend: [revision from lakefile.toml if available]
- Function count: [N total]
- Leaf functions: [M identified]
- Defs file: [detected or user-confirmed path]
- Interpretation functions: [detected definitions, if any]

## Function Inventory
| # | Lean Name | Rust Name | Deps | Leaf | Status |
|---|-----------|-----------|------|------|--------|

## Dependency Graph
[Adjacency list: function -> [callees]]

## Verification Entry Points
[Leaf functions sorted by estimated complexity]

## Type Inventory
[Types from Types.lean]

## Existing Specs
| File | Status | Sorry Count |
|------|--------|-------------|
```

Status symbols: `[OK]` verified, `[??]` in progress, `[--]` no spec.

Agent returns with `## EXECUTION COMPLETE` confirming files written.
All writes use the Write tool (VS Code diffs) for user approval.
</step>

<step name="report_results">
Display summary to user.

```
FVS >> MAP COMPLETE

Project: [name from config or directory]
Functions: [N] total, [M] leaf functions
Existing specs: [K] files ([J] with sorry remaining)
Recommended starting points: [top 5 leaf functions]

Written: .formalising/CODEMAP.md
```

Suggest next command:
```
>> Next Up

/fvs:plan to select verification targets
```
</step>

</process>

<success_criteria>
- Project detected via fvs-config.json or auto-detection
- Model profile resolved from config or quality default
- fvs-researcher dispatched with inlined references, returns structured findings
- fvs-executor dispatched with research findings, writes CODEMAP.md
- CODEMAP.md written with all required sections via VS Code diff
- Clear summary displayed with recommended next steps
</success_criteria>
