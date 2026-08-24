---
name: resume-work
description: Resume verification from saved handoff context
argument-hint: "[path]"
allowed-tools:
  - Read
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
- This skill is invoked by mentioning `$fvs:resume-work`.
- Treat all user text after `$fvs:resume-work` as `{{FVS_ARGS}}`.
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
Restore verification context from `.formalising/fv-plans/.continue-here.md` and prepare to continue work. Loads the handoff, reads the target files, and presents the state so work can resume immediately.
</objective>

<process>

## Step 1: Discover Handoff

**If an explicit path argument is given** (`$ARGUMENTS`), resolve it with the same rule as `/fvs:pause-work`: a token ending in `.md` is the exact handoff file; an otherwise path-like token (contains `/`) means `<token>/.continue-here.md`. Load that file directly.

**If bare** (no argument), run the union discovery scan:

```bash
# 1. Glob the legacy + per-topic default handoff locations
find .formalising/fv-plans -name '.continue-here.md' 2>/dev/null

# 2. Grep for the discovery marker to catch custom-named handoffs (e.g. security-handoff.md)
grep -rl '^fvs_handoff: true' .formalising/fv-plans 2>/dev/null
```

Union the two result sets and dedupe (a `.continue-here.md` that also carries the marker is one handoff, not two). Then:

- **No handoffs found:** inform the user and suggest `/fvs:fc-plan` to pick a new target.
- **Exactly one handoff:** load it directly.
- **Multiple handoffs:** sort by `last_updated` frontmatter (most recent first; fall back to file mtime when absent) and present a recency-sorted plain-text NUMBERED list for the user to pick from. Do NOT use AskUserQuestion — a plain numbered list keeps the picker runtime-neutral.

Read the selected handoff file fully.

## Step 2: Verify Branch

```bash
git branch --show-current
git diff --stat HEAD
```

Check if we're on the expected branch. Warn if not.

## Step 3: Load Target Files

Read the target spec/proof file(s) mentioned in the handoff, focusing on:
- The proof gap locations
- Surrounding proof context (50 lines before/after each gap)
- Any helper lemmas or definitions referenced

## Step 4: Load Key References

Read any definition files mentioned in the handoff (e.g., spec definitions, math libraries, constant specs).

## Step 5: Present Resumption Context

```
FVS >> RESUMING

Target:  [file]
Branch:  [branch]
Status:  [status]
Proof gaps: [count] remaining

## State
[Current state summary from handoff]

## Blockers
[Any blockers from handoff]

## Next Action
[The next action from handoff]

Ready to continue. What would you like to do?
```

## Step 6: Cleanup

The handoff file stays for reference. It will be overwritten on the next `/fvs:pause-work`.

</process>

<success_criteria>
- [ ] Handoff file found and loaded
- [ ] Branch verified
- [ ] Target file(s) read and proof gap locations confirmed
- [ ] Context presented clearly
- [ ] Ready for immediate continuation of work
</success_criteria>
