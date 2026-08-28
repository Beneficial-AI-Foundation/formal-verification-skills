<purpose>
Orchestrate codebase analysis for Aeneas-generated Lean projects to produce CODEMAP.md.

Uses probe-aeneas >= 0.19.0 for the exact function inventory, graph endpoints, and progress, then a
two-phase subagent dispatch adds qualitative annotations without changing those facts.

Output: .formalising/CODEMAP.md with a generated graph/progress block, type inventory, and separate
complexity, risk, and recommendation notes.
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
INVENTORY_SCRIPT=${CLAUDE_PLUGIN_ROOT}/scripts/fvs-probe-inventory.mjs
PUBLIC_API_ARGS=()
command -v probe-aeneas >/dev/null 2>&1 || exit 1
if command -v cargo-public-api >/dev/null 2>&1; then
  PROBE_LOG="$PROBE_TMP/public-api.log"
  if probe-aeneas extract "$PROJECT_ROOT" --with-public-api \
      --output "$RAW_PROBE_JSON" >"$PROBE_LOG" 2>&1; then
    cat "$PROBE_LOG"
    if grep -Fq 'cargo-public-api found' "$PROBE_LOG"; then
      PUBLIC_API_ARGS=(--public-api-exact)
    else
      echo "Exact public API data unavailable; publicTopLevelFunctions will be null."
    fi
  else
    cat "$PROBE_LOG"
    echo "Public API extraction unavailable; retrying the core inventory without it."
    probe-aeneas extract "$PROJECT_ROOT" --output "$RAW_PROBE_JSON" || exit 1
  fi
else
  probe-aeneas extract "$PROJECT_ROOT" --output "$RAW_PROBE_JSON" || exit 1
fi
CANONICAL_INVENTORY=$(node "$INVENTORY_SCRIPT" "$RAW_PROBE_JSON" \
  --project-root "$PROJECT_ROOT" "${PUBLIC_API_ARGS[@]}" --format json) || exit 1
CANONICAL_COUNT=$(node "$INVENTORY_SCRIPT" "$RAW_PROBE_JSON" \
  --project-root "$PROJECT_ROOT" "${PUBLIC_API_ARGS[@]}" --format count) || exit 1
CANONICAL_BLOCK=$(node "$INVENTORY_SCRIPT" "$RAW_PROBE_JSON" \
  --project-root "$PROJECT_ROOT" "${PUBLIC_API_ARGS[@]}" --format markdown) || exit 1
```

The sole scope definition is `language=rust && kind=exec && is-relevant=true &&
untracked=false`. Missing, pre-0.19.0, malformed, failed, or empty probe output HALTS with
install/upgrade-and-retry guidance. Never fall back to grep or model enumeration. Models never
discover, add, remove, or recount functions.

The helper also supplies direct `dependents`, `topLevelFunctions`, `entryPointFunctions`, and exact
specification/verification progress. `publicTopLevelFunctions` is exact only when the extraction
log confirms the cargo-public-api override and every canonical atom has `is-public-api`; otherwise
it is null. Never infer it from `is-public`.
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
- Annotations keyed by every supplied canonical atom ID (signature, types, complexity, risk,
  recommendation)
- Generated endpoint and progress facts repeated unchanged when context requires them
- Type inventory from Types.lean
- Qualitative proof context, without changing canonical membership, graph, or progress

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
- Defs file: [detected or user-confirmed path]
- Interpretation functions: [detected definitions, if any]

<!-- the supplied fvs:probe-inventory managed block, byte-for-byte and exactly once -->

## Qualitative Recommendations
[Complexity, risk, and recommendations keyed by supplied canonical atom ID]

## Type Inventory
[Types from Types.lean]
```

Agent returns with `## EXECUTION COMPLETE` confirming files written.
All writes use the Write tool (VS Code diffs) for user approval.

The executor never discovers, adds, removes, or recounts functions, and never calculates or alters
generated edges, endpoint sets, statuses, totals, or percentages. It preserves user-marker notes
and writes qualitative annotations separately, keyed by canonical atom ID. After it returns, run
the deterministic post-write gate:

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
Functions: $CANONICAL_COUNT canonical
Endpoints and progress: generated in CODEMAP.md
Recommendations: qualitative, keyed by canonical atom ID

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
- The helper supplies direct dependents, endpoint sets, and exact progress partitions
- Public top-level functions are exact when available and null rather than guessed otherwise
- fvs-researcher annotates the supplied canonical inventory without changing generated facts
- fvs-executor preserves the supplied managed block and keys qualitative annotations by atom ID
- `--check-codemap` passes after the CODEMAP write
- Clear summary displayed with recommended next steps
</success_criteria>
