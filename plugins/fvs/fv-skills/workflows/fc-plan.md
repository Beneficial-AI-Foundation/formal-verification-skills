<purpose>
Refresh CODEMAP's generated graph/progress block from probe-aeneas, then produce qualitative
verification recommendations.

The helper owns membership, edges, endpoint sets, statuses, and arithmetic. Models own only
complexity, risk, and recommendation judgment keyed by canonical atom ID.
</purpose>

<process>

<step name="check_codemap">
Require `.formalising/CODEMAP.md`:

```bash
[ -f .formalising/CODEMAP.md ] && echo "CODEMAP found" || echo "CODEMAP missing"
```

If missing, tell the user to run `/fvs:map-code` and halt. fc-plan refreshes an existing managed
block; it does not create CODEMAP.
</step>

<step name="refresh_canonical_inventory">
Run a fresh extract from the current project root. Request exact public API data when
`cargo-public-api` is installed, but retry without it if optional public API extraction fails:

```bash
PROJECT_ROOT=$(pwd -P)
PROBE_TMP=$(mktemp -d "${TMPDIR:-/tmp}/fvs-probe-inventory.XXXXXX") || exit 1
RAW_PROBE_JSON="$PROBE_TMP/extract.json"
INVENTORY_SCRIPT=${CLAUDE_PLUGIN_ROOT}/scripts/fvs-probe-inventory.mjs
TARGET_ARGS=()
PUBLIC_API_ARGS=()
[ -n "$ARGUMENTS" ] && TARGET_ARGS=(--target "$ARGUMENTS")

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

<step name="resolve_models">
Read `.formalising/fvs-config.json`, defaulting to the `quality` profile. Honor per-agent overrides
before the profile defaults:

- `fvs-researcher`: quality=inherit, balanced=sonnet, budget=haiku
- `fvs-executor`: quality=inherit, balanced=sonnet, budget=sonnet
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
- CODEMAP's managed block is refreshed from a fresh probe-aeneas extract
- Optional public API extraction cannot block the core inventory
- Target filtering keeps project-wide endpoint truth and outside-target dependencies
- Both agents receive the same canonical inventory used for CODEMAP
- Models write only complexity, risk, and recommendation judgment
- PLAN points to CODEMAP rather than duplicating generated facts
- The CODEMAP byte check passes after PLAN is written
</success_criteria>
