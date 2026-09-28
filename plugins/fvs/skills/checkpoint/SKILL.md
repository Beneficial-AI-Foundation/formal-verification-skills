---
name: checkpoint
description: Create structured verification checkpoint commit
argument-hint: "<description> (what was verified)"
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
- This skill is invoked by mentioning `$fvs:checkpoint`.
- Treat all user text after `$fvs:checkpoint` as `{{FVS_ARGS}}`.
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
Stage verification-related files and create a structured git commit with a framework-adaptive prefix. Tracks verification progress by counting unfinished proof gaps across the project.

Output: Git commit with message `checkpoint({framework}): {description} - {progress}`
</objective>

<execution_context>
@${CLAUDE_PLUGIN_ROOT}/fv-skills/references/ui-brand.md
</execution_context>

<context>
Checkpoint description: $ARGUMENTS (optional -- will prompt if empty).

- Framework-agnostic command that adapts commit prefix by detected framework
- Stages all modified verification-related files automatically
</context>

<process>

## Step 1: Detect framework

Use project markers to determine the verification framework:

```bash
# Detect from project files — extend this list as new frameworks are supported
if [ -f "lakefile.toml" ] || [ -f "lakefile.lean" ] || [ -f "lean-toolchain" ]; then
  FRAMEWORK="lean"
  PROOF_EXTENSIONS="*.lean"
  GAP_PATTERN="sorry"
elif [ -f "dune-project" ] || [ -f "_CoqProject" ]; then
  FRAMEWORK="coq"
  PROOF_EXTENSIONS="*.v"
  GAP_PATTERN="Admitted\.\|admit\."
else
  FRAMEWORK="fv"
  PROOF_EXTENSIONS=""
  GAP_PATTERN=""
fi
echo "Framework: $FRAMEWORK"
```

## Step 2: Count verification progress

If a framework was detected, count proof gaps:

```bash
if [ -n "$GAP_PATTERN" ] && [ -n "$PROOF_EXTENSIONS" ]; then
  GAP_COUNT=$(grep -r "$GAP_PATTERN" --include="$PROOF_EXTENSIONS" . 2>/dev/null | wc -l | tr -d ' ')
  PROOF_FILES=$(find . -name "$PROOF_EXTENSIONS" 2>/dev/null | wc -l | tr -d ' ')
  COMPLETE_FILES=$(find . -name "$PROOF_EXTENSIONS" 2>/dev/null | while read f; do
    grep -q "$GAP_PATTERN" "$f" || echo "$f"
  done | wc -l | tr -d ' ')
  echo "Proof files: $PROOF_FILES total, $COMPLETE_FILES complete, $GAP_COUNT gaps remaining"
fi
```

Parse `$ARGUMENTS` as the checkpoint description. If `$ARGUMENTS` is empty:

```
What did you verify? (e.g., "mul bounds proof" or "switching to ring strategy")
```

Wait for user to provide description.

## Step 3: Stage relevant files

Stage modified verification files:

```bash
# Stage all modified proof and spec files
git add -A .formalising/ 2>/dev/null

# Stage proof files based on detected framework
if [ -n "$PROOF_EXTENSIONS" ]; then
  git add $(git diff --name-only --diff-filter=M | grep "$PROOF_EXTENSIONS" | head -50) 2>/dev/null
fi

# Show what will be committed
git diff --staged --stat
```

If nothing is staged:

```
FVS >> [XX] NO CHANGES TO CHECKPOINT

No modified verification files found. Make changes first, then run /fvs:checkpoint.
```

Exit -- do not proceed.

## Step 4: Propose commit message

Draft a commit message following these rules:
- Conventional commit format: `checkpoint({framework}): {description}`
- Subject line under 50 characters, imperative mood
- Add a body only if changes are complex (wrap at 72 chars)
- Focus on WHAT changed and WHY, not how
- Be as SHORT as possible while remaining descriptive
- NEVER add "Co-Authored-By" lines or reference AI tools/assistants

Present the proposed message and staged diff to the user for approval:

```
FVS >> PROPOSED CHECKPOINT

checkpoint({framework}): {description}

{body, only if needed}

Staged files:
{git diff --staged --stat output}

Approve this commit message, or provide an alternative:
```

Wait for user confirmation. If the user provides an alternative message, use that instead.

## Step 5: Commit and confirm

```bash
git commit -m "{approved message}"
COMMIT_HASH=$(git rev-parse --short HEAD)
```

```
FVS >> CHECKPOINT CREATED

{commit hash} {commit subject}
Progress: {complete}/{total} proof files complete, {gap_count} gaps remaining
```

</process>

<success_criteria>
- [ ] Framework detected from project markers
- [ ] Proof gap count tracked for progress reporting
- [ ] Verification-related files staged automatically
- [ ] Structured commit with framework-adaptive prefix created
- [ ] Progress summary displayed
</success_criteria>
