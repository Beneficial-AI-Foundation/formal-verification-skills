---
name: trust-audit
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

<plugin_runtime>
- FVS is installed at `${CLAUDE_PLUGIN_ROOT}`; hosts expand this placeholder in plugin skill content.
- Resolve every bundled workflow, reference, template, script, and agent beneath that root.
- When executing a shell snippet, quote the resolved plugin-root path even if an inherited example omits quotes.
- Never write state into the plugin cache. Project state belongs under the user's current project (normally `.formalising/`).
</plugin_runtime>

<codex_skill_adapter>
This block applies only when this shared skill runs in Codex. Claude Code must ignore it and use the
shared workflow body with its native slash-command, question, and subagent semantics.

## A. Skill Invocation
- This skill is invoked by mentioning `$fvs:trust-audit`.
- Treat all user text after `$fvs:trust-audit` as `{{FVS_ARGS}}`.
- If no arguments are present, treat `{{FVS_ARGS}}` as empty.

## B. AskUserQuestion -> request_user_input Mapping
FVS workflows use `AskUserQuestion` (Claude Code syntax). Translate to Codex `request_user_input`:

Parameter mapping:
- `header` -> `header`
- `question` -> `question`
- Options formatted as `"Label" -- description` -> `{label: "Label", description: "description"}`
- Generate `id` from header: lowercase, replace spaces with underscores

Batched calls:
- `AskUserQuestion([q1, q2])` -> single `request_user_input` with multiple entries in `questions[]`

Multi-select workaround:
- Codex has no `multiSelect`. When a question allows multiple selections, do NOT collapse it to a single choice. Use sequential single-selects, or present a numbered freeform list asking the user to enter comma-separated numbers, then collect every selection before proceeding.

Execute mode fallback:
- When `request_user_input` is rejected or unavailable (Execute mode), present every `AskUserQuestion` call as a plain-text numbered list, then stop and wait for the user's reply. Do NOT pick a default and continue.
- You may proceed without a user answer only when one of these is true:
  (a) the invocation included an explicit non-interactive flag (`--auto` or `--all`),
  (b) the user has explicitly approved a specific default for this question, or
  (c) the workflow's documented contract says defaults are safe (e.g. autonomous lifecycle paths).
- Do NOT write workflow artifacts (handoff files, spec files, plan files, checkpoint files) until the user has answered the plain-text questions or one of (a)-(c) above applies. Surfacing the questions and waiting is the correct response — silently defaulting and writing artifacts is the failure mode this header exists to prevent.

## C. Task() -> spawn_agent Mapping
FVS workflows use `Task(...)` (Claude Code syntax). Translate to Codex collaboration tools:

**Schema detection (required first step):** Codex exposes two `spawn_agent` schemas:
- **agent_type-capable schema:** `spawn_agent` accepts `agent_type`, `message`, `reasoning_effort`, `fork_context`, etc. — typed FVS agent dispatch is available.
- **Generic schema:** `spawn_agent` accepts only `message`, `items`, `fork_context` — there is **no `agent_type` field**. Typed FVS agent dispatch is unavailable in this session.

Before spawning, inspect the `spawn_agent` tool's visible parameter schema to determine which form is active.
Even when `agent_type` is present, typed dispatch is available only if the exact requested FVS type is advertised by the tool schema or a confirmed runtime registry. Codex marketplace plugins do not register the bundled Claude agent Markdown as typed Codex agents, so otherwise use the bundled-agent workaround below.


Typed mapping (agent_type-capable schema only):
- `Task(subagent_type="X", prompt="Y")` -> `spawn_agent(agent_type="X", message="Y")`
- `Task(model="...")` -> omit. `spawn_agent` has no inline `model` parameter. The marketplace plugin does not install Codex agent TOML. Use this mapping only when the exact FVS agent type is registered independently; otherwise use the bundled-agent workaround.
- `fork_context: false` by default -- FVS agents load their own context via `<files_to_read>` blocks.

Generic-agent workaround (schema with NO agent_type field):
When only the generic schema is available, typed FVS agent dispatch (`fvs-researcher`, `fvs-executor`, etc.) is NOT possible. This workaround is NOT equivalent to typed execution — FVS agents carry verification-aware prompts and sandbox settings a generic subagent lacks. Fallback:
1. Read `${CLAUDE_PLUGIN_ROOT}/agents/<agent-name>.md` and extract its instructions. If the token is still literal, resolve the path from this SKILL.md as described above.
2. Spawn a generic/default agent and inject those instructions as a role preamble before the task prompt.
3. Label results clearly as "generic-agent workaround" so the user knows typed guarantees are not in effect.
4. Where typed dispatch is mandatory for correctness, fail closed and report the schema limitation rather than silently degrading.

Parallel fan-out:
- Spawn multiple agents -> collect agent IDs -> call `wait_agent(timeout_ms=...)` (or the runtime's visible wait equivalent) until each completes

Result parsing:
- Look for structured markers in agent output: `CHECKPOINT`, `PLAN COMPLETE`, `SUMMARY`, etc.
- If the runtime exposes an agent cleanup or close tool, use it after collecting each result

## D. Shared Plugin Syntax
- This file is shared with Claude Code. On Codex, interpret `/fvs:<name>` references as `$fvs:<name>`.
- Treat `$ARGUMENTS` in the shared body as `{{FVS_ARGS}}`.
- `${CLAUDE_PLUGIN_ROOT}` is the installed plugin root. If a host leaves that token unexpanded, resolve the plugin root as two directories above this SKILL.md.

</codex_skill_adapter>

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
@${CLAUDE_PLUGIN_ROOT}/fv-skills/workflows/trust-audit.md
@${CLAUDE_PLUGIN_ROOT}/fv-skills/references/model-profiles.md
@${CLAUDE_PLUGIN_ROOT}/fv-skills/references/ui-brand.md
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
