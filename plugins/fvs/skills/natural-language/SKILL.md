---
name: natural-language
description: Generate detailed NL explanation of module/function into .formalising/stubs/ MD files
argument-hint: "<function_name> (Lean or Rust name)"
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
- This skill is invoked by mentioning `$fvs:natural-language`.
- Treat all user text after `$fvs:natural-language` as `{{FVS_ARGS}}`.
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
Generate a detailed natural-language explanation of a Rust function. Resolves the target function, reads the full Rust module and Lean translation, dispatches fvs-explainer for analysis, and writes a structured stub file.

Stubs capture the human reasoning (pre/postconditions, bounds, mathematical meaning) that informs later spec writing.

Output: .formalising/stubs/{ModuleName}/{FunctionName}.md
</objective>

<execution_context>
@${CLAUDE_PLUGIN_ROOT}/fv-skills/workflows/natural-language.md
@${CLAUDE_PLUGIN_ROOT}/fv-skills/references/ui-brand.md
</execution_context>

<context>
Target function: $ARGUMENTS (required -- function name in Lean or Rust form).

- Check for .formalising/CODEMAP.md for function lookup
- Template: ${CLAUDE_PLUGIN_ROOT}/fv-skills/templates/stub.md defines output format
- Single-function mode: one function per invocation
</context>

<process>

## Step 1: Resolve Target Function

Accept $ARGUMENTS as function name. Search in CODEMAP.md if available, then Funs.lean, then Rust source:

```bash
TARGET="$ARGUMENTS"

# Try CODEMAP first
grep -i "$TARGET" .formalising/CODEMAP.md 2>/dev/null

# Fall back to Funs.lean
FUNS_LEAN=$(find . -name "Funs.lean" -not -path "*/.lake/*" | head -1)
grep "def.*${TARGET}" "$FUNS_LEAN" 2>/dev/null

# Fall back to Rust source
grep -rn "fn ${TARGET}" src/ 2>/dev/null
```

Resolve to:
- Lean qualified name (e.g., `MyProject.my_module.my_function`)
- Rust source file + line range
- Module path (the containing Rust module)
- Output stub path: `.formalising/stubs/{ModuleName}/{FunctionName}.md`

If not found: show fuzzy matches and suggest `/fvs:map-code`.

```
Function "{target}" not found.

Did you mean one of these?
[fuzzy matches]

Or run /fvs:map-code to build the function index.
```

Wait for user clarification.

## Step 2: Resolve Runtime Settings and Read References

Read `fv-skills/references/model-profiles.md` and declare stage key `explain` for
`fvs-explainer`. Resolve the exact runtime/provider model and effort through the canonical
precedence. Before dispatch, show and confirm the command-level selection manifest. Offer one-run
adjustment, exact-stage Save override, notes that rebuild and reconfirm the manifest, and Cancel.
Missing preferred models or unsupported efforts prompt interactively; noninteractive unresolved
choices fail before dispatch with exact remediation.

Read the three domain reference files. These MUST be inlined into the Task() prompt because
@-references do NOT cross Task boundaries.

```bash
AENEAS_PATTERNS=$(cat ${CLAUDE_PLUGIN_ROOT}/fv-skills/references/aeneas-patterns.md)
SPEC_CONVENTIONS=$(cat ${CLAUDE_PLUGIN_ROOT}/fv-skills/references/lean-spec-conventions.md)
STUB_TEMPLATE=$(cat ${CLAUDE_PLUGIN_ROOT}/fv-skills/templates/stub.md)
```

## Step 3: Read Source Files

Read the ENTIRE Rust module file (not just the target function) for module context. Read the target function's Lean translation from Funs.lean. Read relevant type definitions from Types.lean.

```bash
FUNS_LEAN=$(find . -name "Funs.lean" -not -path "*/.lake/*" | head -1)
TYPES_LEAN=$(find . -name "Types.lean" -not -path "*/.lake/*" | head -1)
```

Read the full Rust module file at the resolved path. Extract the function body from Funs.lean (from `def` to the next top-level `def` or end of file). Extract referenced types from Types.lean by searching for struct/enum names used in the function signature.

## Step 4: Dispatch fvs-explainer Agent

Display dispatch indicator:
```
>> Dispatching fvs-explainer...
```

```
Task(
  model="$EXPLAINER_MODEL",
  reasoning_effort="$EXPLAINER_EFFORT", // when supported; otherwise apply the capability gate
  prompt="Analyze function for natural-language explanation.

<rust_module>
$FULL_RUST_MODULE_SOURCE
</rust_module>

<target_function>
$RUST_FUNCTION_SOURCE
</target_function>

<lean_translation>
$LEAN_FUNCTION_BODY_FROM_FUNS_LEAN
</lean_translation>

<type_context>
$RELEVANT_TYPES_FROM_TYPES_LEAN
</type_context>

<module_path>$RUST_MODULE_PATH</module_path>

<aeneas_patterns>
$AENEAS_PATTERNS
</aeneas_patterns>

<spec_conventions>
$SPEC_CONVENTIONS
</spec_conventions>

Analyze this function in two phases:
1. Module analysis (purpose, data flow, placement, key types)
2. Function analysis (algorithm with annotated Rust source, pre/postconditions, bounds, math meaning)

Return with ## EXPLANATION COMPLETE or ## ERROR.",
  subagent_type="fvs-explainer",
  description="NL explanation of $TARGET"
)
```

Wait for agent to return. Parse the result:
- If `## EXPLANATION COMPLETE`: extract sections for stub file
- If `## ERROR`: display error, offer user to retry or abort

Display:
```
[OK] fvs-explainer complete: explanation generated
```

## Step 5: Write Stub File

Parse agent output sections. Merge with stub template format from Step 2.

```bash
mkdir -p .formalising/stubs/$(dirname "$STUB_PATH")
```

Assemble the stub file using the stub.md template structure with agent-provided content for each section:
- Module Context (from agent Phase A)
- Function header (signature, Lean extraction name, source location)
- What It Does (algorithmic description with annotated Rust source)
- Preconditions (type-level, value-level, semantic)
- Postconditions (structural, semantic)
- Bounds Reasoning (worst-case arithmetic walkthrough)
- Mathematical Meaning (interpretation functions, core theorem in English)

Write stub file to `.formalising/stubs/{ModuleName}/{FunctionName}.md` using the Write tool (VS Code diff).

## Step 6: Validate Stub

Check all required sections present in the written file:

```bash
STUB_FILE=".formalising/stubs/${MODULE_NAME}/${FUNCTION_NAME}.md"
for section in "Module Context" "What It Does" "Preconditions" "Postconditions" "Bounds Reasoning" "Mathematical Meaning"; do
  grep -q "## .*${section}\|### ${section}" "$STUB_FILE" && echo "[OK] ${section}" || echo "[XX] ${section} MISSING"
done
```

If any section missing: warn user, offer to regenerate.

## Step 7: Display Summary

```
FVS >> STUB GENERATED

Function: {function_name}
Module:   {rust_module_path}
Stub:     .formalising/stubs/{ModuleName}/{FunctionName}.md
Sections: [OK] all required sections present
```

```
>> Next Up

/fvs:lean-specify {function_name} to generate the Lean spec
```

</process>

<success_criteria>
- [ ] Target function resolved to Rust source and Lean extraction
- [ ] Full Rust module read for context (not just target function)
- [ ] fvs-explainer dispatched with inlined references
- [ ] Stub file written with all required sections via VS Code diff
- [ ] Stub includes annotated Rust source snippets (not abstract prose)
- [ ] Stub is standalone (no cross-references to spec files)
- [ ] Clear next step offered (/fvs:lean-specify)
</success_criteria>
