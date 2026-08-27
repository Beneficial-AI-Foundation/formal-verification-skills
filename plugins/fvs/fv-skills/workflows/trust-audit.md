<objective>
Produce a build-backed, authoritative-by-construction trust audit of an Aeneas-extracted Lean
target: derive its exact function set from probe-aeneas, introspect each via `#print axioms`,
classify every sorry / axiom / verified status, and emit a re-runnable, strictly dependency-ordered
table at `.formalising/audits/<target>.md` with a fail-if-unjustified gate.

This workflow is the procedure. The command body (`/fvs:trust-audit`) is the ORCHESTRATOR: it
resolves the target + Lean paths, runs the build precondition, dispatches the read-only
`fvs-axiom-auditor` to introspect-classify-order the canonical set, then OWNS the persisted
justification store and the fail-if-unjustified gate. The auditor never writes a file; the
command body persists the table and fires the gate.

Hard invariants this workflow preserves:
- The audit is BUILD-BACKED: introspection only runs against a target layer that compiles. The
  build precondition reads the tool's REAL exit status (`set -o pipefail` / `${PIPESTATUS[0]}`),
  never the tail of a piped log (the green-build trap). Builds always run under
  `nice -n 19 lake build` -- never a bare `lake build`.
- The audit is READ-ONLY over generated Lean: `Types.lean` / `Funs.lean` and any
  Charon/Aeneas-generated output are introspected, NEVER written. All writes are confined to
  `.formalising/audits/`.
- `#print axioms` is the authoritative oracle. A `sorryAx` dependence is reported as a sorry
  affecting that declaration; an axiom outside the standard classical trio is a project-custom
  in-scope axiom the justification gate enforces.
- The inventory is the target-filtered subset of probe-aeneas >= 0.19.0 Rust exec atoms where
  `is-relevant=true` and `untracked=false`. Models never determine membership or count.
- The table is emitted in strict topological order: no declaration appears before its
  prerequisites.
- Never pin a Lean version: use the target project's own `lean-toolchain`.
- Never open or create an upstream artifact.
- Lean-via-Aeneas pipeline only -- no other-framework verification paths.
</objective>

<process>

## Step 1: Resolve the target + Lean paths (config -> auto-detect -> prompt -> error)

Resolve the audit target (a spec file or a module subtree) and the generated-Lean paths
(`Funs.lean` / `Types.lean` / `Specs/` / project defs) using the precedence
config -> auto-detect -> prompt -> error, reusing the `fc-plan` path-resolution pattern and the
`fvs-config.json` keys. The target is untrusted input: quote every path expansion, reject a
target path that contains shell metacharacters, and never `eval` a path.

Record the target project's `lean-toolchain` in the output (never pin a Lean version here). Note
that a pre-fix toolchain may under-report an axiom-of-an-axiom (the `collectAxioms`
under-reporting risk); the reference target post-fix is the safe posture.

## Step 2: BUILD PRECONDITION -- build-backed, green-build guarded

Introspection is only meaningful against a target layer that compiles. Run the build first and
read the REAL exit status:

```bash
set -o pipefail
nice -n 19 lake build 2>&1 | tee build.log
BUILD_STATUS=${PIPESTATUS[0]}
```

If `${BUILD_STATUS}` is non-zero, HALT loudly: the target layer must compile for `#print axioms`
introspection to run -- do NOT produce a meaningless audit over a layer that did not build
(a piped tail would otherwise mask a non-compiling target and let the audit falsely report
CLEAN). Only once the build is green does introspection proceed.

## Step 3: Generate the exact target inventory

After the green build, run a fresh probe and target projection:

```bash
PROBE_TMP=$(mktemp -d "${TMPDIR:-/tmp}/fvs-trust-audit.XXXXXX") || exit 1
trap 'rm -rf -- "$PROBE_TMP"' EXIT
RAW_PROBE_JSON="$PROBE_TMP/extract.json"
INVENTORY_SCRIPT=${CLAUDE_PLUGIN_ROOT}/scripts/fvs-probe-inventory.mjs
command -v probe-aeneas >/dev/null 2>&1 || exit 1
probe-aeneas extract "$PROJECT_ROOT" --output "$RAW_PROBE_JSON" || exit 1
CANONICAL_INVENTORY=$(node "$INVENTORY_SCRIPT" "$RAW_PROBE_JSON" \
  --project-root "$PROJECT_ROOT" --target "$TARGET" --format json) || exit 1
CANONICAL_COUNT=$(node "$INVENTORY_SCRIPT" "$RAW_PROBE_JSON" \
  --project-root "$PROJECT_ROOT" --target "$TARGET" --format count) || exit 1
```

The helper rejects missing, pre-0.19.0, malformed, failed, or target-empty output. HALT with
install/upgrade-and-retry guidance; never use a grep/model fallback. Models never discover, add,
remove, or recount functions.

## Step 4: Introspect + classify (dispatched to the read-only auditor)

The command body dispatches `fvs-axiom-auditor` (read-only) with the canonical inventory JSON and
`$CANONICAL_COUNT`, delimited as untrusted data. The auditor:

1. Consumes exactly the supplied canonical atom IDs and never changes their membership/count.
2. Introspects each `primarySpecFqn`, falling back to `leanFqn`, via `#print axioms <FQN>` (the
   recommended low-risk harness is a
   generated scratch module that imports the target and emits `#print axioms` per in-scope decl,
   run via `lake env lean` -- NEVER an edit to generated Lean). `#print axioms` is the
   authoritative oracle; static grep never determines inventory membership or status.
3. Classifies from the `#print axioms` output:
   - **`sorryAx` present** => status `sorry` (an incomplete proof reaches this declaration).
   - **An axiom NOT in {`propext`, `Classical.choice`, `Quot.sound`}** => status `axiom`
     (a project-custom in-scope axiom the justification gate enforces).
   - **Only the standard classical trio (`propext`, `Classical.choice`, `Quot.sound`) or no
     axioms** => status `verified` (the classical trio is auto-noted as Lean/Mathlib-standard
     and needs no per-axiom justification).
   - Missing Lean FQN or failed introspection => status `uninspectable`, never an omitted row.
4. Orders topologically from supplied canonical dependency edges and RETURNS one row keyed by every
   canonical atom ID. Cone members outside the target are prerequisites, never inventory rows.

## Step 5: GATE -- owned by the command body (fail-if-unjustified)

The command body merges the auditor's returned table with the persisted axiom-justification
store under `.formalising/audits/` (surface-and-fill, keyed by axiom, persisted across re-runs).
The gate is fail-if-unjustified: merge by canonical atom ID, retain all `$CANONICAL_COUNT` rows,
and turn any missing auditor row into `uninspectable`. Report **NOT-CLEAN** while a custom axiom
lacks justification or any `sorry`/`uninspectable` remains.

## Step 6: Write the re-runnable dependency-ordered table

Write the table to `.formalising/audits/<target>.md` in strict topological order (no function
before its prerequisites) with columns:

```
| Canonical atom ID | FQN (Rust path convention) | status (verified/sorry/axiom/uninspectable) | justification | depends-on |
```

The output is re-runnable: a later run re-introspects, re-merges the persisted justifications,
and re-fires the gate.

## Step 7: Close with the FVS >> banner

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 FVS >> TRUST AUDIT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Target:        {target}
Toolchain:     {lean-toolchain}
In-scope:      $CANONICAL_COUNT canonical functions
Classified:    {verified} verified / {sorry} sorry / {axiom} axiom / {uninspectable} uninspectable
Verdict:       {CLEAN | NOT-CLEAN}
Unjustified:   {list of project-custom in-scope axioms lacking a justification}
Table:         .formalising/audits/<target>.md
```

On Codex, the build-precondition HALT and any justification prompt degrade to plain text and
WAIT for the user (fail-closed -- never auto-justify an axiom, never self-clear the gate). The
`Task(...)` dispatch survives intact (the `model=` parameter is silently ignored on Codex).

</process>

<success_criteria>
- [ ] Target + Lean paths resolved via config -> auto-detect -> prompt -> error; every expansion quoted; shell-metacharacter target rejected; no `eval`.
- [ ] Build precondition runs `nice -n 19 lake build` under `set -o pipefail` and reads `${PIPESTATUS[0]}`; HALT if the target layer does not compile.
- [ ] Probe-aeneas >= 0.19.0 supplies the sole exact target inventory/count before dispatch.
- [ ] Auditor classifications are keyed by canonical atom ID; missing/uninspectable entries remain and force NOT-CLEAN.
- [ ] `#print axioms` classification: `sorryAx` => sorry, classical-trio auto-noted, project-custom axioms require justification; fail-if-unjustified => NOT-CLEAN.
- [ ] Re-runnable, strict-topological-order table at `.formalising/audits/<target>.md`.
- [ ] Generated Lean never written; no pinned Lean version; no `gh` open/create; Lean-via-Aeneas only.
</success_criteria>
