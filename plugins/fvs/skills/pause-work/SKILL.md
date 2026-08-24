---
name: pause-work
description: Save verification context for session handoff
argument-hint: "[path] [note]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
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
- This skill is invoked by mentioning `$fvs:pause-work`.
- Treat all user text after `$fvs:pause-work` as `{{FVS_ARGS}}`.
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
Create a handoff document in `.formalising/fv-plans/` that preserves complete verification context across session boundaries (compaction, new conversation, etc.).

This is NOT about git commits — it's about capturing the mental model and proof state that would be lost when context resets.
</objective>

<execution_context>
@${CLAUDE_PLUGIN_ROOT}/fv-skills/references/ui-brand.md
</execution_context>

<context>
Arguments: $ARGUMENTS

**Default handoff file:** `.formalising/fv-plans/.continue-here.md`.

**Optional first positional token = a destination.** The first token in `$ARGUMENTS` is treated as a destination ONLY if it contains `/` or ends in `.md`. Otherwise the entire `$ARGUMENTS` string is the user note (so a one-word note like `stuck` is never misread as a directory).

Resolution rule:

- **No path-like first token:** write the legacy default `.formalising/fv-plans/.continue-here.md`. The whole argument string is the user note.
- **First token ends in `.md`:** that exact path is the handoff file.
- **First token is otherwise path-like (contains `/`):** treat it as a directory and write `<token>/.continue-here.md` inside it.

When a path-like first token is present, the remaining text after it is the user note. Overwrite ONLY the selected handoff file (parallel handoffs to distinct destinations do not clobber each other).

Examples:

```text
/fvs:pause-work
  -> .formalising/fv-plans/.continue-here.md

/fvs:pause-work .formalising/fv-plans/CKA-from-KEM
  -> .formalising/fv-plans/CKA-from-KEM/.continue-here.md

/fvs:pause-work .formalising/fv-plans/CKA-from-KEM/security-handoff.md
  -> .formalising/fv-plans/CKA-from-KEM/security-handoff.md
```

This command has access to the FULL current conversation context. Extract everything relevant from prior messages, tool results, and discoveries made during this session.
</context>

<process>

## Step 1: Gather State from Conversation

Extract from the current conversation context:

1. **Target file(s)**: Which spec/proof file(s) are being worked on
2. **Branch**: Current git branch
3. **Proof gaps**: Locations of unfinished proofs (line numbers and what each needs)
4. **Proof state**: Available hypotheses, goal structure
5. **Discoveries**: Insights found during this session (lemma identities, tactic behavior, gotchas)
6. **Blockers**: What's preventing progress and why
7. **Decisions made**: Approaches chosen/rejected with rationale
8. **Strategy**: The current plan of attack
9. **Next action**: Exactly what to do first when resuming

## Step 2: Check Modified Files

```bash
git diff --stat HEAD
git branch --show-current
```

## Step 3: Read Current State of Target Files

Read the proof gap locations and surrounding proof context from the target file(s) to capture the exact current state.

## Step 4: Write Handoff

Resolve `HANDOFF_FILE` from `$ARGUMENTS` per the rule in `<context>`:

- no path-like first token (no `/` and not ending in `.md`): `.formalising/fv-plans/.continue-here.md`;
- first token ends in `.md`: that exact path;
- first token is otherwise path-like (contains `/`): `<token>/.continue-here.md`.

```bash
mkdir -p "$(dirname "$HANDOFF_FILE")"
```

Write to `HANDOFF_FILE` (overwrite only that file) using the Write tool:

```markdown
---
fvs_handoff: true
target: <spec file path>
branch: <git branch>
last_updated: <UTC timestamp>
status: <in_progress|blocked|stuck>
proof_gaps: <number of unfinished proofs>
---

# Verification Handoff

## What We're Proving
[Function name, theorem name, what it means]

## Current State
[Exact position: which proof gap, what the goal looks like, what's been established]

## Discoveries
[Key insights, gotchas, things that would take time to rediscover]

## Blockers
[What's preventing progress, with full technical detail]

## Decisions
[Approaches chosen/rejected with rationale]

## Strategy
[The plan of attack going forward]

## Key Hypotheses & Definitions
[Important hypothesis names, file locations, definition references]

## Next Action
[Exactly what to do first when resuming — be specific enough for a fresh session]
```

## Step 5: Confirm

```
FVS >> PAUSED

Handoff: [HANDOFF_FILE]
Target:  [file]
Branch:  [branch]
Status:  [status]

To resume: /fvs:resume-work [same path or directory]
```

</process>

<success_criteria>
- [ ] Handoff captures enough context for a fresh session to continue immediately
- [ ] Technical details are precise (line numbers, hypothesis names, exact errors)
- [ ] Discoveries/gotchas that took time to find are preserved
- [ ] Next action is specific and actionable
- [ ] File written to the resolved handoff file (default `.formalising/fv-plans/.continue-here.md`, or the destination from `$ARGUMENTS`)
</success_criteria>
