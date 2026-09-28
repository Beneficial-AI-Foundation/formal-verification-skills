---
name: lean-refactor
description: Refactor, simplify, and decompose verified Lean proofs while preserving compilation
argument-hint: "<spec_file_path> [--theorem name] [--mode safe|balanced|aggressive] [--max-passes N] [--report-only]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
  - Task
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
- This skill is invoked by mentioning `$fvs:lean-refactor`.
- Treat all user text after `$fvs:lean-refactor` as `{{FVS_ARGS}}`.
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

**Schema detection (required first step):** Inspect the visible `spawn_agent` schema. It may have `agent_type` or be generic (no `agent_type`); inspect `model` and `reasoning_effort` fields independently rather than assuming either exists. An available `agent_type` field does not establish that a particular FVS role is registered.

Before spawning, inspect the `spawn_agent` tool's visible parameter schema to determine which form is active.
**Requested specialist gate (at dispatch only):** When a workflow requests a named FVS specialist, check BOTH the visible `spawn_agent` schema and whether the exact requested `agent_type` is advertised there or in a confirmed runtime registry. An `agent_type` field alone is not evidence that this role is registered; bundled `agents/*.md` are instructions, not registered Codex specialists. If the exact role is registered and `agent_type` is available, use typed mapping below WITHOUT a missing-role warning. Otherwise, even if `agent_type` is present, warn the user in plain language: Requested FVS specialist <agent-name> is not registered in this Codex session; the bundled Markdown cannot supply typed identity. Do not warn merely for opening help, installing, or mentioning a skill without requesting specialist dispatch. Apply the settings gate below before considering the generic-agent workaround. Never run an installer on the user's behalf.


Selection-capability gate (before manifest confirmation, child dispatch, or artifact writes):
- Check required specialist identity and sandbox against the exact registered role and effective child settings. A generic role preamble cannot meet a mandatory typed identity or sandbox requirement; stop and explain the unavailable guarantee before dispatch or artifact writes.
- If `model` is exposed for this child, pass the requested model. Otherwise compare it with the exact active/inherited Codex model; a different or unconfirmed model is unresolved. Rebuild the manifest around confirmed settings and ask explicitly, choose a capable external runner, or fail before dispatch in noninteractive mode.
- If `reasoning_effort` is exposed for this child, pass the requested effort. Otherwise compare it with the confirmed effective installed/runtime default; a different or unconfirmed effort is unresolved and follows the same rebuild/ask-or-fail rule.
- Model and effort are separate values: pass an exact catalog model id and an effort that model lists. A registered role that pins `model` or `reasoning_effort` (its role description says the setting is locked, or its TOML sets it) overrides the per-call value, so the pinned value is the effective one; if it differs from the confirmed selection it is unresolved.
- Never confirm a requested specialist setting and then omit it with a warning. The marketplace plugin does not install Codex agent TOML; use typed mapping only for an independently registered exact role.

Typed mapping (only when the exact requested FVS role is registered AND agent_type is exposed):
- `Task(subagent_type="X", prompt="Y")` -> `spawn_agent(agent_type="X", message="Y")`
- `Task(model="...")` -> pass `model` if available for this child; otherwise omit only after the selection-capability gate proves it equals the active/inherited model.
- `Task(reasoning_effort="...")` -> pass `reasoning_effort` if available for this child and the role does not pin it; otherwise omit only after the gate proves the effective (pinned or default) effort equals the confirmed effort.
- `fork_context: false` by default -- FVS agents load their own context via `<files_to_read>` blocks.

Generic-agent workaround (missing exact registered role OR no agent_type field):
If the requested FVS type (`fvs-researcher`, `fvs-executor`, etc.) is not registered, typed dispatch is NOT possible even with an `agent_type` field. If the field is absent, typed dispatch is also unavailable. Fallback:
1. Read `${CLAUDE_PLUGIN_ROOT}/agents/<agent-name>.md` and extract its instructions. If the token is still literal, resolve the path from this SKILL.md as described above.
2. Only when the settings gate permits generic execution, spawn a generic/default child with those instructions as a role preamble before the task prompt. Do not pass an unregistered `agent_type`.
3. Label output "generic-agent workaround". This is NOT equivalent to a registered specialist: the preamble does not assure typed identity, sandbox, model, or reasoning effort.
4. If required guarantees cannot be honored, stop before dispatch or artifact writes; explain which guarantee is missing. Typed FVS roles currently require the direct Codex installation, a separate complete FVS install: point the user to "Codex specialist roles" in the FVS README and never suggest keeping both channels. Even after switching, confirm exact registration and settings in the runtime.

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
Orchestrate proof refactoring for a verified Lean spec using three-phase subagent dispatch (baseline -> research -> iterative refactor). Dispatches fvs-researcher for 3-lens analysis, then iteratively dispatches fvs-lean-refactorer to apply tiered heuristics ONE CHANGE AT A TIME, verifying compilation after each.

This command sits after `/fvs:lean-verify` in the verification lifecycle. The input spec must compile with zero sorry. The output is the same spec with shorter, cleaner, more maintainable proofs.

Output: Refactored spec file with before/after metrics, or NO_CHANGE report if proofs are already clean.
</objective>

<execution_context>
@${CLAUDE_PLUGIN_ROOT}/fv-skills/workflows/lean-refactor.md
@${CLAUDE_PLUGIN_ROOT}/fv-skills/references/ui-brand.md
</execution_context>

<context>
Spec file path: $ARGUMENTS (required -- path to spec .lean file).

Parse flags from $ARGUMENTS:
- `--theorem name` -- scope to a single theorem (default: all theorems)
- `--mode safe|balanced|aggressive` -- refactoring mode (default: balanced)
- `--max-passes N` -- max passes per theorem (default: 5, cap: 20)
- `--report-only` -- run research analysis but do not apply changes

- Check for .formalising/CODEMAP.md for dependency context
- Track iteration count in command scope (agents are stateless per Task() invocation)
</context>

<process>

## Step 1: Parse Arguments

Parse $ARGUMENTS for spec file path and optional flags:

```bash
SPEC_PATH="(parsed from $ARGUMENTS, excluding flags)"
THEOREM_FILTER="(parsed from --theorem flag, default: all)"
MODE="(parsed from --mode flag, default: balanced)"
MAX_PASSES="(parsed from --max-passes flag, default: 5)"
REPORT_ONLY="(parsed from --report-only flag, default: false)"

# Hard cap: never exceed 20
if [ "$MAX_PASSES" -gt 20 ]; then
  MAX_PASSES=20
fi

[ -f "$SPEC_PATH" ] && echo "Spec found" || echo "Spec not found"
```

If not found: list available specs and suggest `/fvs:lean-specify`.

```bash
find Specs/ -name "*.lean" 2>/dev/null
```

Wait for valid path.

## Step 1a: Warm the project cache

Run the mandatory cache preflight from the validated Lean project root before the baseline build.
A failure stops the workflow:

```bash
if { [ ! -f lakefile.lean ] && [ ! -f lakefile.toml ]; } || [ ! -f lean-toolchain ]; then
  echo "FVS >> ERROR: run from the Lean project root" >&2
  exit 1
fi
LEAN_NUM_THREADS="${LEAN_NUM_THREADS:-4}" nice -n 19 lake exe cache get
CACHE_STATUS=$?
if [ "$CACHE_STATUS" -ne 0 ]; then
  echo "FVS >> ERROR: Lake cache preflight failed; stopping workflow" >&2
  exit "$CACHE_STATUS"
fi
```

## Step 2: Baseline Build Check

Confirm file exists, run build, confirm zero sorry.

```bash
# Check for sorry
SORRY_COUNT=$(grep -c "sorry" "$SPEC_PATH")
echo "Sorry count: $SORRY_COUNT"
```

If sorry found: direct to `/fvs:lean-verify $SPEC_PATH`. STOP.

```bash
# Build check
LEAN_NUM_THREADS="${LEAN_NUM_THREADS:-4}" nice -n 19 lake build 2>&1 | tail -20
```

If build fails: report error and STOP.

**Gather baseline metrics:**

```bash
TOTAL_LINES=$(wc -l < "$SPEC_PATH")
THEOREM_COUNT=$(grep -c "@\[step\]\|theorem " "$SPEC_PATH")
TACTIC_LINES=$(grep -cE "^\s+(unfold|step|simp|agrind|scalar_tac|ring|field_simp|have|obtain|rw|by_cases|interval_cases|grind|bvify|bv_tac)" "$SPEC_PATH")
echo "Baseline: $TOTAL_LINES lines, $THEOREM_COUNT theorems, $TACTIC_LINES tactic lines"
```

## Step 3: Read Config and Resolve Models + Effort

Read the complete config and apply `model-profiles.md`. Declare `research` for
`fvs-researcher` and `lean_refactor` for `fvs-lean-refactorer`; resolve both stages independently
rather than deriving tiers from agent names.

Before dispatch, show one command-level selection manifest with both stages and obtain confirmation.
Offer one-run adjustment, exact-stage Save override, notes that rebuild and reconfirm the manifest,
and Cancel. Missing preferred models or unsupported efforts prompt interactively; noninteractive
unresolved choices fail before dispatch with exact remediation.

## Step 4: Read Reference Files for Inlining

Read the reference files that MUST be inlined into Task() prompts because @-references do not cross Task boundaries:

```bash
LEAN_REFACTORING=$(cat ${CLAUDE_PLUGIN_ROOT}/fv-skills/references/lean-refactoring.md)
TACTIC_USAGE=$(cat ${CLAUDE_PLUGIN_ROOT}/fv-skills/references/tactic-usage.md)
PROOF_STRATEGIES=$(cat ${CLAUDE_PLUGIN_ROOT}/fv-skills/references/proof-strategies.md)
```

All three must be captured as content strings for inlining into subagent prompts.

## Step 5: Dispatch Research Subagent

```
Task(
  subagent_type="fvs-researcher",
  model="$RESEARCH_MODEL",
  reasoning_effort="$RESEARCH_EFFORT", // when supported; otherwise apply the capability gate
  description="Research refactoring context for $SPEC_FILE",
  prompt="Research mode: lean-refactor

<spec_file_path>$SPEC_PATH</spec_file_path>
<spec_content>
$SPEC_FILE_CONTENT
</spec_content>

<lean_refactoring>
$LEAN_REFACTORING_CONTENT
</lean_refactoring>

<tactic_usage>
$TACTIC_USAGE_CONTENT
</tactic_usage>

<proof_strategies>
$PROOF_STRATEGIES_CONTENT
</proof_strategies>

Tasks:
1. Read the spec file and identify all theorem proofs (not sorry)
2. Read the corresponding function body from Funs.lean for structural context
3. Search for similar proved theorems in the project to identify reuse patterns
4. For each theorem proof, apply the 3-lens analysis (reuse, quality, efficiency)
5. Return structured findings with per-theorem refactoring recommendations
6. Classify each recommendation by tier (1-4)

Return with ## RESEARCH COMPLETE"
)
```

Parse the returned research findings to get:
- Per-theorem analysis with tier-classified recommendations
- Recommended refactoring order
- Shared patterns across theorems

**If --report-only:** Display research findings and exit. No refactoring passes.

## Step 6: Iterative Refactorer Dispatch

For each theorem (in order from research recommendations, filtered by --theorem if set):

```
PASS=0
WHILE PASS < MAX_PASSES:

  # Re-read spec each iteration (it changes!)
  CURRENT_SPEC=$(cat "$SPEC_PATH")

  Task(
    subagent_type="fvs-lean-refactorer",
    model="$REFACTORER_MODEL",
    reasoning_effort="$REFACTORER_EFFORT", // when supported; otherwise apply the capability gate
    description="Refactor {theorem_name} pass {PASS+1}",
    prompt="<refactoring_reference>$LEAN_REFACTORING_CONTENT</refactoring_reference>
    <research_findings>$RESEARCH_OUTPUT</research_findings>
    <current_spec>$CURRENT_SPEC</current_spec>
    <target_theorem>{theorem_name}</target_theorem>
    <mode>{MODE}</mode>
    <pass>{PASS+1} of {MAX_PASSES}</pass>
    <previous_feedback>{build errors from last pass, if any}</previous_feedback>

    Apply ONE refactoring from the highest applicable tier within the mode ceiling.
    Write via Write tool. User approves inline."
  )

  ROUTE ON RETURN:
    ## REFACTORED:
      Run: LEAN_NUM_THREADS="${LEAN_NUM_THREADS:-4}" nice -n 19 lake build
      If build passes: record change, PASS += 1, continue
      If build fails: REVERT the change (re-write previous content), store error as feedback, PASS += 1
    ## NO_CHANGE:
      Break -- no more refactorings possible for this theorem
    ## ERROR:
      Store error, PASS += 1

END WHILE
```

Move to next theorem after max passes or NO_CHANGE.

## Step 7: Display Summary

```
FVS >> REFACTORING {STATUS}

File:      {spec_file}
Mode:      {MODE}
Theorems:  {N} processed
Changes:   {total changes applied}
Lines:     {before} -> {after} ({delta})
Status:    REFACTORED | NO_CHANGE | ERROR
```

**Status classification:**
- **REFACTORED:** At least one change applied and build passes
- **NO_CHANGE:** No refactorings possible at current mode's tier ceiling
- **ERROR:** Build failures that could not be reverted

## Step 8: Update CODEMAP.md If Exists

If .formalising/CODEMAP.md exists, verification status remains [OK] (refactoring preserves verification -- zero sorry before and after).

```bash
[ -f ".formalising/CODEMAP.md" ] && echo "CODEMAP exists" || echo "No CODEMAP"
```

No status change needed -- spec remains verified.

## Step 9: Suggest Next Steps

**If REFACTORED:**

```
>> Proof refactored. Consider committing the changes.

git add {spec_path}
git commit -m "refactor: clean up {function_name} proof"

/fvs:fc-plan to select next verification target
```

**If NO_CHANGE:**

```
>> Proofs are already clean at the {mode} tier ceiling.

Try --mode aggressive for more aggressive refactoring.
/fvs:fc-plan to select next verification target
```

</process>

<success_criteria>
- [ ] Spec file located and zero sorry confirmed
- [ ] Baseline build check passes with LEAN_NUM_THREADS="${LEAN_NUM_THREADS:-4}" nice -n 19 lake build
- [ ] Config read and models resolved for fvs-researcher and fvs-lean-refactorer
- [ ] Research subagent dispatched with inlined lean-refactoring, tactic-usage, proof-strategies
- [ ] 3-lens analysis returned with per-theorem recommendations
- [ ] Report-only mode stops after research phase when flag is set
- [ ] Refactorer dispatched iteratively per theorem (one change at a time)
- [ ] Build check after every change with LEAN_NUM_THREADS="${LEAN_NUM_THREADS:-4}" nice -n 19 lake build (never plain lake build)
- [ ] Failed changes reverted and error stored as feedback
- [ ] Max-passes cap enforced (default 5, hard cap 20)
- [ ] Result correctly classified as REFACTORED, NO_CHANGE, or ERROR
- [ ] Before/after metrics displayed
- [ ] Clear next steps offered based on outcome
</success_criteria>
