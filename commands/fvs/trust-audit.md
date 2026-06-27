---
name: fvs:trust-audit
description: Build-backed trust audit of an Aeneas-extracted Lean target -- enumerate, #print axioms, classify, order, gate
argument-hint: "<target spec file | module subtree>"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
  - Task
  - AskUserQuestion
---

<objective>
Audit the trust surface of an Aeneas-extracted Lean target (a spec file or a module subtree): run a
build precondition, introspect every in-scope declaration via `#print axioms`, classify each as
verified / sorry / axiom, and write a re-runnable, strictly dependency-ordered table at
`.formalising/audits/<target>.md` behind a fail-if-unjustified gate.

This command is the ORCHESTRATOR. It resolves the target + the generated-Lean paths, runs
`nice -n 19 lake build` as a hard, green-build-guarded precondition, dispatches the read-only
`fvs-axiom-auditor` to enumerate-introspect-classify-order, then OWNS the persisted
justification store and the fail-if-unjustified gate. The auditor introspects and returns by
text; it never writes a file. This command persists the table and fires the gate.

Output: `.formalising/audits/<target>.md` (the re-runnable dependency-ordered table) and the
persisted axiom-justification store under `.formalising/audits/`.
</objective>

<execution_context>
@~/.claude/fv-skills/workflows/trust-audit.md
@~/.claude/fv-skills/references/model-profiles.md
@~/.claude/fv-skills/references/ui-brand.md
</execution_context>

<context>
Target: $ARGUMENTS (required -- a spec file or a module subtree of the extracted-Lean `fc` bundle).

The audit targets our Aeneas-extracted Lean -- the Charon -> Aeneas output (`Funs.lean` /
`Types.lean`) plus its `Specs/` and math-support files. The inventory is strictly the target's own
declarations; cone members the target transitively depends on are surfaced as prerequisites.

The audit is re-runnable: a later run on the same target re-introspects, re-merges the persisted
justifications under `.formalising/audits/`, and re-fires the gate.
</context>

<process>

## Step 1: Resolve the target + generated-Lean paths (config -> auto-detect -> prompt -> error)

Read the project config and resolve the target plus the `Funs.lean` / `Types.lean` / `Specs/` /
project-defs paths with the precedence config -> auto-detect -> prompt -> error, reusing the
`fc-plan` path-resolution pattern and the `fvs-config.json` keys:

```bash
CONFIG=$(cat .formalising/fvs-config.json 2>/dev/null)
# profile = config.model_profile || "balanced"
# model = model_overrides["fvs-axiom-auditor"] ?? PROFILE_TABLE["fvs-axiom-auditor"][profile]
```

The target is UNTRUSTED input flowing into path expansion and a `lake` / `lake env lean`
invocation. Quote EVERY path expansion, REJECT a target path that contains shell metacharacters,
and NEVER `eval` a path.

Record the target project's `lean-toolchain` in the output (never pin a Lean version here) and
note that a pre-fix toolchain may under-report an axiom-of-an-axiom (the `collectAxioms`
under-reporting risk); the reference post-fix toolchain is the safe posture.

## Step 2: PRECONDITION -- build-backed, green-build guarded

Introspection is only meaningful over a target layer that compiles. Run the build FIRST and read
the REAL exit status -- never the tail of a pipe:

```bash
set -o pipefail
nice -n 19 lake build 2>&1 | tee build.log
BUILD_STATUS=${PIPESTATUS[0]}
```

If `${BUILD_STATUS}` is non-zero, HALT loudly: "the target layer must compile for #print axioms
introspection to run" -- do NOT produce a meaningless audit. (A piped tail would otherwise mask a
non-compiling target and let the audit falsely report CLEAN.) Only on a green build do you proceed
to introspection. Never run a bare `lake build`.

## Step 3: Resolve the auditor model + dispatch the read-only auditor

Resolve `$AUDITOR_MODEL` for `fvs-axiom-auditor` from the profile table (auditor:
quality=inherit, balanced=sonnet, budget=haiku), then dispatch:

```
Task(subagent_type="fvs-axiom-auditor", model="$AUDITOR_MODEL",
     description="Introspect #print axioms over in-scope decls",
     prompt="...inlined: the resolved target + the strictly-scoped in-scope declaration list +
             the Rust-path FQN convention + the map-code dependency edges... Return with
             ## AUDIT COMPLETE")
```

The auditor enumerates STRICTLY the target's own decls (trait impls, free / inherent / submodule
functions, test functions, constants -- Rust path convention), introspects each via
`#print axioms` (recommended harness: a generated scratch module that imports the target and emits
`#print axioms` per in-scope decl, run via `lake env lean` -- no edit to generated Lean),
classifies, and returns a topologically-ordered table. Classification:

- **`sorryAx` present** => status `sorry` (an incomplete proof reaches this declaration; a `sorry`
  affecting the target layer, regardless of whether the file literally contains the keyword).
- **An axiom NOT in {`propext`, `Classical.choice`, `Quot.sound`}** => status `axiom` (a
  project-custom in-scope axiom the justification gate enforces).
- **Only the standard classical trio (`propext`, `Classical.choice`, `Quot.sound`) or no axioms**
  => status `verified` (the classical trio is auto-noted as Lean/Mathlib-standard).

Cone members OUTSIDE the strictly-scoped target are surfaced as PREREQUISITES (in the depends-on
column / a prerequisites section), NEVER added as inventory rows.

## Step 4: GATE -- owned by THIS command body (fail-if-unjustified)

Merge the auditor's returned table with the persisted axiom-justification store under
`.formalising/audits/` (surface-and-fill, keyed by axiom, persisted across re-runs). Fire the
fail-if-unjustified gate: report **NOT-CLEAN** while ANY project-custom in-scope axiom lacks a
written justification (a `sorry` is likewise an outstanding gap). The verdict is CLEAN only when
every project-custom in-scope axiom carries a justification and no `sorry` remains.

## Step 5: Write the re-runnable dependency-ordered table

Write the table to `.formalising/audits/<target>.md` in strict topological order (no function
before its prerequisites) with columns:

```
| FQN (Rust path convention) | status (verified/sorry/axiom) | justification | depends-on |
```

All writes are confined to `.formalising/audits/`. NEVER write generated Lean
(`Types.lean` / `Funs.lean`) -- the audit reads them.

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

</process>

<codex_skill_adapter>
On Codex, every interactive HALT in this command -- the build-precondition HALT (Step 2) and any
justification prompt at the gate (Step 4) -- degrades to a plain-text question and WAITS for the
user. It is fail-closed: it never auto-justifies an axiom, never self-clears the NOT-CLEAN gate,
and never produces a CLEAN verdict without a green build. The `Task(...)` dispatch survives intact
(the `model=` parameter is silently ignored on Codex, per model-profiles runtime handling).
</codex_skill_adapter>

<success_criteria>
- [ ] Target + generated-Lean paths resolved via config -> auto-detect -> prompt -> error; every expansion quoted; shell-metacharacter target rejected; no `eval`.
- [ ] Build precondition runs `nice -n 19 lake build` under `set -o pipefail` and reads `${PIPESTATUS[0]}`; HALT if the target layer does not compile.
- [ ] Dispatches the read-only `fvs-axiom-auditor`; the auditor introspects via `#print axioms` and returns the ordered table; the command body persists it.
- [ ] Strictly-scoped FQ inventory (Rust path convention); cone members surfaced as prerequisites, never inventory rows.
- [ ] `#print axioms` classification: `sorryAx` => sorry, classical-trio (propext / Classical.choice / Quot.sound) auto-noted, project-custom axioms require justification; fail-if-unjustified => NOT-CLEAN.
- [ ] Re-runnable, strict-topological-order table at `.formalising/audits/<target>.md`.
- [ ] Generated Lean never written; no pinned Lean version; no `gh` open/create call; Lean-via-Aeneas only.
</success_criteria>
