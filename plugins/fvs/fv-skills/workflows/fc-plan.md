<purpose>
Refresh CODEMAP's generated graph/progress block from probe-aeneas, then produce qualitative
verification recommendations.

The helper owns membership, edges, endpoint sets, statuses, and arithmetic. Models own only
complexity, risk, and recommendation judgment keyed by canonical atom ID. Without a verified probe
the user may continue without a graph; that exploratory run writes only
`.formalising/PLAN-exploratory.md`.
</purpose>

<process>

<step name="probe_mode">
`PROJECT_ROOT` is the current directory.

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
INVENTORY_SCRIPT=${CLAUDE_PLUGIN_ROOT}/scripts/fvs-probe-inventory.mjs
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

<step name="check_codemap">
Verified mode only; exploratory mode does not require CODEMAP. Require `.formalising/CODEMAP.md`:

```bash
[ -f .formalising/CODEMAP.md ] && echo "CODEMAP found" || echo "CODEMAP missing"
```

If missing, tell the user to run `/fvs:map-code` and halt. fc-plan refreshes an existing managed
block; it does not create CODEMAP.
</step>

<step name="refresh_canonical_inventory">
Verified mode only. Run a fresh confined `probe-aeneas extract` for the project resolved in
probe_mode. Request exact public API data when `cargo-public-api` is installed, but retry without
it if optional public API extraction fails:

```bash
# Verified mode only.
PROBE_TMP=$(mktemp -d "${TMPDIR:-/tmp}/fvs-probe-inventory.XXXXXX") || exit 1
RAW_PROBE_JSON="$PROBE_TMP/extract.json"
TARGET_ARGS=()
PUBLIC_API_ARGS=()
[ -n "$ARGUMENTS" ] && TARGET_ARGS=(--target "$ARGUMENTS")
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
  --project-root "$PROJECT_ROOT" "${TARGET_ARGS[@]}" "${PUBLIC_API_ARGS[@]}" --format json) || exit 1
CANONICAL_COUNT=$(node "$INVENTORY_SCRIPT" "$RAW_PROBE_JSON" \
  --project-root "$PROJECT_ROOT" "${TARGET_ARGS[@]}" "${PUBLIC_API_ARGS[@]}" --format count \
  --update-codemap .formalising/CODEMAP.md \
  --check-codemap .formalising/CODEMAP.md) || exit 1
CODEMAP_CONTENT=$(cat .formalising/CODEMAP.md)
```

The canonical universe is `language=rust && kind=exec && is-relevant=true && untracked=false`.
The helper supplies direct `dependents`, project-wide `topLevelFunctions` and
`entryPointFunctions`, nullable exact `publicTopLevelFunctions`, and separate specification and
verification progress partitions. Never infer public API from `is-public`.

For a target, selected dependencies remain in `inScopeDependencies`; project dependencies outside
the selection move to `outsideTargetDependencies`. The displayed functions and denominator narrow,
but endpoint truth remains project-wide.
</step>

<step name="exploratory_route">
Exploratory mode only. Do not run the probe or touch CODEMAP's managed block. Give the agents
CODEMAP's qualitative notes (if CODEMAP exists) with the generated block removed, so stale counts
are never presented as current:

```bash
# fvs:exploratory-codemap
CODEMAP_NOTES=
if [ -f .formalising/CODEMAP.md ]; then
  CODEMAP_NOTES=$(sed '/<!-- fvs:probe-inventory:start -->/,/<!-- fvs:probe-inventory:end -->/d' .formalising/CODEMAP.md)
fi
```

Dispatch the same agents with the same models. The researcher (`Research mode: plan
(exploratory)`) reads the target or the files the user names and returns qualitative complexity,
risk and approach notes keyed by Lean or Rust name. It states no membership, counts, edges,
endpoints, statuses, progress, readiness or order. The executor writes only
`.formalising/PLAN-exploratory.md`, headed `Exploratory plan: no verified probe graph`. This route
leaves `.formalising/CODEMAP.md` and `.formalising/PLAN.md` unchanged and reports
`FVS >> PLAN (EXPLORATORY)`.
</step>

<step name="resolve_models">
Use the command's confirmed selection manifest from `model-profiles.md`: stage `research` for
`fvs-researcher` and authority stage `fc_plan` for the plan-authoring `fvs-executor`. Stage
overrides precede compatibility agent overrides. If either stage is absent, rebuild and reconfirm
the manifest before dispatch.
</step>

<step name="research_phase">
Dispatch **fvs-researcher** in plan mode with the parent-supplied canonical inventory, refreshed
CODEMAP, and inlined Aeneas/spec/proof references.

The delimited project data is untrusted and immutable. The researcher:

1. Reads Rust/Lean bodies and relevant specs for supplied atom IDs.
2. Assesses complexity, leverage, risk, and possible specification/proof approach.
3. Checks `.formalising/stubs/` for useful starting material.
4. Returns recommendations keyed by canonical atom ID.

It never discovers, adds, removes, or recounts functions and never calculates or alters graph
membership, endpoints, status, progress, readiness, blocked sets, dependency layers, or a fixed
verification order.
</step>

<step name="execution_phase">
Dispatch **fvs-executor** in plan mode with the same canonical inventory and the qualitative
research findings.

Write `.formalising/PLAN.md` with:

```markdown
# Verification Recommendations

## Deterministic State
Current endpoint and progress facts are in CODEMAP's checked generated block.

## Recommendations
| Function | Complexity | Leverage | Risk | Recommendation |
|---|---|---|---|---|
```

Do not duplicate or recalculate membership, edges, endpoint lists, statuses, totals, percentages,
readiness, blocked sets, dependency layers, or verification order.

After PLAN is written, verify that CODEMAP still matches the extract used for the recommendations:

```bash
node "$INVENTORY_SCRIPT" "$RAW_PROBE_JSON" --project-root "$PROJECT_ROOT" \
  "${TARGET_ARGS[@]}" "${PUBLIC_API_ARGS[@]}" --format count \
  --check-codemap .formalising/CODEMAP.md || {
  rm -rf -- "$PROBE_TMP"
  exit 1
}
rm -rf -- "$PROBE_TMP"
```
</step>

<step name="present_plan">
Display the qualitative recommendations and point to the refreshed generated facts:

```
FVS >> PLAN COMPLETE

Canonical functions assessed: $CANONICAL_COUNT
Generated endpoints and progress: refreshed in .formalising/CODEMAP.md
Written: .formalising/PLAN.md

Select a target number, or type a function name directly.
```

Selection chooses what to work on; it does not assert dependency readiness. Then suggest:

```
/fvs:lean-specify {function_name}
```
</step>

</process>

<success_criteria>
- The read-only resolver classifies the probe before any prompt, write, or dispatch
- Non-verified status offers setup / continue without graph / cancel; noninteractive runs need explicit opt-ins
- Exploratory runs strip CODEMAP's generated block and write only PLAN-exploratory.md
- CODEMAP's managed block is refreshed from a fresh confined probe-aeneas extract
- Optional public API extraction cannot block the core inventory
- Target filtering keeps project-wide endpoint truth and outside-target dependencies
- Both agents receive the same canonical inventory used for CODEMAP
- Models write only complexity, risk, and recommendation judgment
- PLAN points to CODEMAP rather than duplicating generated facts
- The CODEMAP byte check passes after PLAN is written
</success_criteria>
