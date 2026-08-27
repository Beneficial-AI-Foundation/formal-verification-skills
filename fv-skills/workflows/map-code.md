<purpose>
Orchestrate codebase analysis for Aeneas-generated Lean projects to produce CODEMAP.md.

Uses probe-aeneas >= 0.19.0 for the exact function inventory/count, then a two-phase subagent
dispatch: fvs-researcher annotates that immutable list and fvs-executor writes CODEMAP.md.

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

<step name="canonical_inventory">
Run a fresh deterministic probe before dispatching either model:

```bash
PROJECT_ROOT=$(cd "$PROJECT_ROOT" && pwd -P)
PROBE_TMP=$(mktemp -d "${TMPDIR:-/tmp}/fvs-probe-inventory.XXXXXX") || exit 1
RAW_PROBE_JSON="$PROBE_TMP/extract.json"
INVENTORY_SCRIPT=~/.claude/scripts/fvs-probe-inventory.mjs
command -v probe-aeneas >/dev/null 2>&1 || exit 1
probe-aeneas extract "$PROJECT_ROOT" --output "$RAW_PROBE_JSON" || exit 1
CANONICAL_INVENTORY=$(node "$INVENTORY_SCRIPT" "$RAW_PROBE_JSON" \
  --project-root "$PROJECT_ROOT" --format json) || exit 1
CANONICAL_COUNT=$(node "$INVENTORY_SCRIPT" "$RAW_PROBE_JSON" \
  --project-root "$PROJECT_ROOT" --format count) || exit 1
CANONICAL_BLOCK=$(node "$INVENTORY_SCRIPT" "$RAW_PROBE_JSON" \
  --project-root "$PROJECT_ROOT" --format markdown) || exit 1
```

The sole scope definition is `language=rust && kind=exec && is-relevant=true &&
untracked=false`. Missing, pre-0.19.0, malformed, failed, or empty probe output HALTS with
install/upgrade-and-retry guidance. Never fall back to grep or model enumeration. Models never
discover, add, remove, or recount functions.
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
Dispatch **fvs-researcher** in map-code mode (read-only annotation).

Read reference files for inlining into the Task() prompt:
- aeneas-patterns.md (naming conventions, project structure, dependency patterns)
- lean-spec-conventions.md (for understanding code structure and spec naming)

These are INLINED because @-references do NOT cross Task() boundaries.

Agent inputs (all inlined in prompt):
- Canonical inventory JSON and count, delimited as untrusted data
- Path to Funs.lean and Types.lean
- Rust source root (if available)
- aeneas-patterns.md content
- lean-spec-conventions.md content

Expected outputs:
- Annotations keyed by every supplied canonical atom ID (signature, types, context, complexity)
- Leaf/recursive classification using only supplied `inScopeDependencies`
- Recursive vs non-recursive classification
- Type inventory from Types.lean
- Existing proof context, without changing canonical membership/count/status

Agent returns with `## RESEARCH COMPLETE` containing structured `<findings>`,
`<relevant_files>`, and `<recommendations>` sections.

For large projects, the researcher may fan out parallel sub-tasks using
`run_in_background=true` for scanning multiple source directories.

Reference: @fv-skills/references/aeneas-patterns.md (Pattern 2: naming conventions, Pattern 4: Result/Error types)
</step>

<step name="execution_phase">
Dispatch **fvs-executor** in map-code mode with research findings.

Agent inputs (all inlined in prompt):
- Canonical inventory JSON, count, and Markdown managed block, delimited as untrusted data
- Complete research findings from fvs-researcher output
- No additional reference files needed (researcher already processed them)

The executor writes `.formalising/CODEMAP.md` with:

```markdown
# CODEMAP

## Project Info
- Lean toolchain: [from lean-toolchain]
- Aeneas backend: [revision from lakefile.toml if available]
- Function count: [exact canonical count]
- Leaf functions: [M identified]
- Defs file: [detected or user-confirmed path]
- Interpretation functions: [detected definitions, if any]

<!-- the supplied fvs:probe-inventory managed block, byte-for-byte and exactly once -->

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

The executor never discovers, adds, removes, or recounts functions. It preserves user-marker notes
and writes model annotations/priorities separately, keyed by canonical atom ID. After it returns,
run the deterministic post-write gate:

```bash
node "$INVENTORY_SCRIPT" "$RAW_PROBE_JSON" --project-root "$PROJECT_ROOT" \
  --format count --check-codemap .formalising/CODEMAP.md || {
  rm -rf -- "$PROBE_TMP"
  exit 1
}
rm -rf -- "$PROBE_TMP"
```

HALT if the managed block is missing, duplicated, or changed.
</step>

<step name="report_results">
Display summary to user.

```
FVS >> MAP COMPLETE

Project: [name from config or directory]
Functions: $CANONICAL_COUNT canonical, [M] leaf functions
Existing specs: [K] files ([J] with sorry remaining)
Recommended starting points: [top 5 leaf functions]

Written: .formalising/CODEMAP.md
```

Suggest next command:
```
>> Next Up

/fvs:fc-plan to select verification targets
```
</step>

</process>

<success_criteria>
- Project detected via fvs-config.json or auto-detection
- Model profile resolved from config or quality default
- probe-aeneas >= 0.19.0 Schema 3.0 supplies the sole exact inventory/count
- fvs-researcher annotates the supplied canonical inventory without changing membership/count
- fvs-executor preserves the supplied managed block and keys annotations by atom ID
- `--check-codemap` passes after the CODEMAP write
- Clear summary displayed with recommended next steps
</success_criteria>
