<purpose>
Orchestrate codebase analysis for Aeneas-generated Lean projects to produce CODEMAP.md.

Uses probe-aeneas >= 0.19.0 for the exact function inventory, graph endpoints, and progress, then a
two-phase subagent dispatch adds qualitative annotations without changing those facts.

Output: .formalising/CODEMAP.md with a generated graph/progress block, type inventory, and separate
complexity, risk, and recommendation notes. Without a verified probe the user may continue without
a graph; that exploratory run writes only `.formalising/CODEMAP-exploratory.md`.
</purpose>

<process>

<step name="probe_mode">
Set `PROJECT_ROOT` to the requested project root, or leave it unset for the current directory.

This is the first operational decision. Run it before path prompts, model selection,
`.formalising/` writes, cache or build work, and any agent dispatch. The resolver is read-only:
it compares the project's generated `translation.json`, its Aeneas pin in `lake-manifest.json`
and `aeneas-config.yml`, and `lean-toolchain` with the tested tuples shipped in
`fvs-probe-inventory.mjs`, then checks the probe-aeneas executable and the preinstalled helpers
(probe-rust, probe-lean, scip, rust-analyzer). It reports `verified`, `missing`, `incompatible`,
`unknown` (missing or conflicting provenance) or `unsupported-platform`, and never installs
anything.

```bash
# fvs:probe-mode
PROJECT_ROOT=$(cd "${PROJECT_ROOT:-$PWD}" && pwd -P) || exit 1
INVENTORY_SCRIPT=~/.claude/scripts/fvs-probe-inventory.mjs
PROBE_STATUS=$(node "$INVENTORY_SCRIPT" resolve --project-root "$PROJECT_ROOT" --format status) || exit 1
node "$INVENTORY_SCRIPT" resolve --project-root "$PROJECT_ROOT" --format text
FVS_MODE=
if [ "$PROBE_STATUS" = verified ]; then FVS_MODE=verified; fi
```

`verified` continues without a prompt. For any other status in an interactive session, ask
(AskUserQuestion; on Codex or Pi a plain-text question, then wait) with exactly these choices
before doing anything else:

- **Set up the verified probe.** When `resolve --format json` reports `install.available`, show
  `node "$INVENTORY_SCRIPT" install --project-root "$PROJECT_ROOT" --manifest` (official URL,
  pinned SHA-256, FVS-owned versioned destination, no PATH or shell-profile change) and ask
  Install / Show manual instructions / Cancel. Install runs
  `node "$INVENTORY_SCRIPT" install --project-root "$PROJECT_ROOT" --consent interactive`; then
  rerun this step and continue verified only if it now reports `verified`. Missing or
  incompatible helpers get the printed manual steps only: FVS never installs a helper. After
  showing manual steps, stop so the user can rerun.
- **Continue without graph.** Set `FVS_MODE=exploratory`.
- **Cancel.** Stop now. Nothing has been written.

A noninteractive run never prompts and never infers consent. Installing needs
`FVS_PROBE_INSTALL_POLICY=install`; continuing without a graph needs the separate opt-in
`FVS_ALLOW_EXPLORATORY=1`:

```bash
# fvs:probe-mode-noninteractive
if [ -z "$FVS_MODE" ] && [ "${FVS_PROBE_INSTALL_POLICY:-}" = install ]; then
  if node "$INVENTORY_SCRIPT" install --project-root "$PROJECT_ROOT" --consent policy; then
    PROBE_STATUS=$(node "$INVENTORY_SCRIPT" resolve --project-root "$PROJECT_ROOT" --format status)
    if [ "$PROBE_STATUS" = verified ]; then FVS_MODE=verified; fi
  fi
fi
if [ -z "$FVS_MODE" ]; then
  if [ "${FVS_ALLOW_EXPLORATORY:-}" = 1 ]; then
    FVS_MODE=exploratory
  else
    echo "FVS >> probe-aeneas is $PROBE_STATUS for this project; set FVS_ALLOW_EXPLORATORY=1 to continue without a graph" >&2
    exit 1
  fi
fi
```

Exploratory mode never writes the managed CODEMAP block, canonical counts, graph, endpoint or
progress facts, or an audit verdict. Only verified mode runs the probe, and only through
`fvs-probe-inventory.mjs run`, which invokes the resolved probe-aeneas by absolute path under an
FVS-generated sandbox (no network; writes limited to the project's build directories, the
output directory and a private tmp; every tool home and bin directory denied).
</step>

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
Verified mode only. Run a fresh confined `probe-aeneas extract` before dispatching either model:

```bash
# Verified mode only.
PROBE_TMP=$(mktemp -d "${TMPDIR:-/tmp}/fvs-probe-inventory.XXXXXX") || exit 1
RAW_PROBE_JSON="$PROBE_TMP/extract.json"
PUBLIC_API_ARGS=()
PROBE_RUN=(node "$INVENTORY_SCRIPT" run --project-root "$PROJECT_ROOT" --output "$RAW_PROBE_JSON")
PROBE_FAILED='confined probe-aeneas extract failed; fix the reported error and retry.'
if command -v cargo-public-api >/dev/null 2>&1; then
  PROBE_LOG="$PROBE_TMP/public-api.log"
  if "${PROBE_RUN[@]}" --with-public-api >"$PROBE_LOG" 2>&1; then
    cat "$PROBE_LOG"
    if grep -Fq 'cargo-public-api found' "$PROBE_LOG"; then
      PUBLIC_API_ARGS=(--public-api-exact)
    else
      echo "Exact public API data unavailable; publicTopLevelFunctions will be null."
    fi
  else
    cat "$PROBE_LOG"
    echo "Public API extraction unavailable; retrying the core inventory without it."
    "${PROBE_RUN[@]}" || { echo "$PROBE_FAILED"; rm -rf -- "$PROBE_TMP"; exit 1; }
  fi
else
  "${PROBE_RUN[@]}" || { echo "$PROBE_FAILED"; rm -rf -- "$PROBE_TMP"; exit 1; }
fi
CANONICAL_INVENTORY=$(node "$INVENTORY_SCRIPT" "$RAW_PROBE_JSON" \
  --project-root "$PROJECT_ROOT" "${PUBLIC_API_ARGS[@]}" --format json) || exit 1
CANONICAL_COUNT=$(node "$INVENTORY_SCRIPT" "$RAW_PROBE_JSON" \
  --project-root "$PROJECT_ROOT" "${PUBLIC_API_ARGS[@]}" --format count) || exit 1
CANONICAL_BLOCK=$(node "$INVENTORY_SCRIPT" "$RAW_PROBE_JSON" \
  --project-root "$PROJECT_ROOT" "${PUBLIC_API_ARGS[@]}" --format markdown) || exit 1
```

The sole scope definition is `language=rust && kind=exec && is-relevant=true &&
untracked=false`. A refused or failed confined run, or malformed or empty probe output, HALTS
and points back to the probe_mode setup choice. Never fall back to grep or model enumeration. Models never
discover, add, remove, or recount functions.

The helper also supplies direct `dependents`, `topLevelFunctions`, `entryPointFunctions`, and exact
specification/verification progress. `publicTopLevelFunctions` is exact only when the extraction
log confirms the cargo-public-api override and every canonical atom has `is-public-api`; otherwise
it is null. Never infer it from `is-public`.
</step>

<step name="resolve_models">
Use stage `map_code` for both subagents and the confirmed command-level selection manifest from
`fv-skills/references/model-profiles.md`. Stage overrides precede compatibility agent overrides;
concrete models must be exact current runtime/provider catalog entries. If `map_code` is absent from
the manifest, rebuild and reconfirm it before dispatch.
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

<step name="exploratory_route">
Exploratory mode only. Skip canonical_inventory and the post-write gate. Dispatch the same agents
with the same models, but give the researcher `Research mode: map-code (exploratory)` with the
source paths and no canonical inventory. Both agents describe files, modules and types
qualitatively, keyed by file path, and state no function count, membership, edges, endpoint sets,
progress or public-API facts. The executor writes only `.formalising/CODEMAP-exploratory.md`,
headed `Exploratory map: no verified probe graph`. This route never creates or modifies
`.formalising/CODEMAP.md` or its managed block. Report `FVS >> MAP (EXPLORATORY)` with
`Functions: not counted (no verified probe graph)`.
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
- The read-only resolver classifies the probe before any prompt, write, or dispatch
- Non-verified status offers setup / continue without graph / cancel; noninteractive runs need explicit opt-ins
- Verified extraction runs only through the confined `run` path, never a PATH lookup
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
