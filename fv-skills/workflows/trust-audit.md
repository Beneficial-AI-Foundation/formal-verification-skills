<objective>
Produce a build-backed, authoritative-by-construction trust audit of an Aeneas-extracted Lean
target: enumerate the target's strictly-scoped declarations, introspect each via `#print axioms`,
classify every sorry / axiom / verified status, and emit a re-runnable, strictly dependency-ordered
table at `.formalising/audits/<target>.md` with a fail-if-unjustified gate.

This workflow is the procedure. The command body (`/fvs:trust-audit`) is the ORCHESTRATOR: it
resolves the target + Lean paths, runs the build precondition, dispatches the read-only
`fvs-axiom-auditor` to enumerate-introspect-classify-order, then OWNS the persisted
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
- The inventory is STRICTLY scoped to the target's own declarations. Cone members outside the
  target are surfaced as prerequisites in the depends-on column / a prerequisites section, NEVER
  folded into the inventory.
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

## Step 3: Enumerate + introspect (dispatched to the read-only auditor)

The command body dispatches `fvs-axiom-auditor` (read-only) with the resolved target, the
strictly-scoped in-scope declaration list, the Rust-path FQN convention, and the `map-code`
dependency edges inlined. The auditor:

1. Enumerates STRICTLY the target's own declarations -- trait impls, free / inherent / submodule
   functions, test functions, constants -- under the Rust path convention (the functions
   originate from Rust via Aeneas). It never widens the inventory.
2. Introspects each in-scope FQN via `#print axioms <FQN>` (the recommended low-risk harness is a
   generated scratch module that imports the target and emits `#print axioms` per in-scope decl,
   run via `lake env lean` -- NEVER an edit to generated Lean). `#print axioms` is the
   authoritative oracle; static grep is at most a pre-pass to enumerate decls, never the
   classifier.
3. Classifies from the `#print axioms` output:
   - **`sorryAx` present** => status `sorry` (an incomplete proof reaches this declaration).
   - **An axiom NOT in {`propext`, `Classical.choice`, `Quot.sound`}** => status `axiom`
     (a project-custom in-scope axiom the justification gate enforces).
   - **Only the standard classical trio (`propext`, `Classical.choice`, `Quot.sound`) or no
     axioms** => status `verified` (the classical trio is auto-noted as Lean/Mathlib-standard
     and needs no per-axiom justification).
4. Orders topologically by REUSING the inlined `map-code` dependency edges (no new walker), and
   RETURNS the table -- it writes nothing. Cone members outside the strictly-scoped target are
   surfaced as PREREQUISITES (in the depends-on column / a prerequisites section), never added as
   inventory rows.

## Step 4: GATE -- owned by the command body (fail-if-unjustified)

The command body merges the auditor's returned table with the persisted axiom-justification
store under `.formalising/audits/` (surface-and-fill, keyed by axiom, persisted across re-runs).
The gate is fail-if-unjustified: the audit reports **NOT-CLEAN** while ANY project-custom
in-scope axiom lacks a written justification. A `sorry` (a `sorryAx` dependence) is likewise an
outstanding trust gap. Only when every project-custom in-scope axiom carries a justification and
no `sorry` remains is the verdict CLEAN.

## Step 5: Write the re-runnable dependency-ordered table

Write the table to `.formalising/audits/<target>.md` in strict topological order (no function
before its prerequisites) with columns:

```
| FQN (Rust path convention) | status (verified/sorry/axiom) | justification | depends-on |
```

The output is re-runnable: a later run re-introspects, re-merges the persisted justifications,
and re-fires the gate.

## Step 6: Close with the FVS >> banner

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 FVS >> TRUST AUDIT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Target:        {target}
Toolchain:     {lean-toolchain}
In-scope:      {N} declarations
Classified:    {verified} verified / {sorry} sorry / {axiom} project-custom axiom
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
- [ ] Strictly-scoped FQ inventory (Rust path convention); cone members surfaced as prerequisites, never inventory rows.
- [ ] `#print axioms` classification: `sorryAx` => sorry, classical-trio auto-noted, project-custom axioms require justification; fail-if-unjustified => NOT-CLEAN.
- [ ] Re-runnable, strict-topological-order table at `.formalising/audits/<target>.md`.
- [ ] Generated Lean never written; no pinned Lean version; no `gh` open/create; Lean-via-Aeneas only.
</success_criteria>
