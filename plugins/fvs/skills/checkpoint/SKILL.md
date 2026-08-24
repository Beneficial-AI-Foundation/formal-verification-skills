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
