---
name: lean-spec-review
description: Adversarially review an FC Lean specification with a chosen runtime, model, and effort
argument-hint: "<spec.lean> [--reviewer codex|claude|pi|other] [--model ID] [--effort LEVEL]"
allowed-tools:
  - Read
  - Bash
  - Glob
  - Grep
  - Write
  - AskUserQuestion
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
- This skill is invoked by mentioning `$fvs:lean-spec-review`.
- Treat all user text after `$fvs:lean-spec-review` as `{{FVS_ARGS}}`.
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


Selection-capability gate (before manifest confirmation):
- Compare the requested model with the exact active/inherited Codex model. Because `spawn_agent` has no inline model field, any different requested model is unresolved. Rebuild the manifest around the actual active model and ask explicitly, choose a capable external runner, or fail before dispatch in noninteractive mode.
- When `reasoning_effort` is absent from the schema, compare the requested effort with the installed/runtime default. A mismatch is unresolved and follows the same rebuild/ask-or-fail rule.
- Never confirm a requested model or effort and then omit it with a warning. The marketplace plugin does not install Codex agent TOML. Use this mapping only when the exact FVS agent type is registered independently; otherwise use the bundled-agent workaround.

Typed mapping (agent_type-capable schema only):
- `Task(subagent_type="X", prompt="Y")` -> `spawn_agent(agent_type="X", message="Y")`
- `Task(model="...")` -> omit only after the selection-capability gate proves it equals the active/inherited model.
- `Task(reasoning_effort="...")` -> `spawn_agent(reasoning_effort="...")` when that field is present. If absent, dispatch only after the gate proves the installed/runtime default equals the confirmed effort.
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
Review one FC specification against Rust and extracted Lean sources before proof work. Offer a
runtime, model, and effort menu; preserve the spec and record the review and finding triage.
</objective>

<execution_context>
@${CLAUDE_PLUGIN_ROOT}/fv-skills/workflows/lean-spec-review.md
@${CLAUDE_PLUGIN_ROOT}/fv-skills/references/fc-spec-review.md
@${CLAUDE_PLUGIN_ROOT}/fv-skills/references/model-profiles.md
</execution_context>

<process>
Follow the review workflow with `$ARGUMENTS`. Explicit invocation always runs the selection flow,
even when `spec_review.automatic` is false. Automatic invocation from `lean-specify` enters the
same workflow after generation checks, with the resolved spec/source paths and author runtime.

Declare authority stage `spec_review` and apply `model-profiles.md`. Precedence is explicit one-run
flags, non-null `spec_review.reviewer` / `spec_review.model` / `spec_review.effort`, then the quality
opposite-runtime recommendation. Null saved values keep profile routing active.

Detect the specification authoring runtime. Recommend an authenticated opposite provider/runtime:
OpenAI/Codex-authored specs use Claude Code CLI; Claude-authored specs use a fresh
provider-qualified OpenAI Pi seat when running in Pi, then Codex CLI. Unknown authors receive an
explicit reviewer menu without an independence claim. Never route a Claude Code subscription
through Pi. The `pi` reviewer is available only inside Pi with a provider-qualified model from its
live authenticated catalog and a fresh-child facility that can honor and report the exact per-child
model/effort. It launches a fresh read-only child, never a manual Other packet. Persistence requires
the workflow's completed-child receipt with actual run ID/model/effort and packet/response hashes;
missing capability or evidence leaves the review pending.

Build one review selection manifest containing reviewer runner, provenance, exact catalog model,
and effort. Confirm it before launch with Continue once, Adjust once, Save override, or Cancel;
retain notes. Notes rebuild the manifest and require reconfirmation. Save writes only the
`spec_review` object. Offer every effort value the selected model/provider reports as supported.
Missing models or unsupported efforts ask for one-run/save/cancel; unresolved noninteractive
choices fail before launch with exact remediation.

If no opposite runner is authenticated, ask among setup/retry, fresh same-runtime review, Other
handoff, one-run skip, or cancel; never switch silently. A one-run skip records exactly
`Unreviewed (user skipped)`, stops at the review boundary, and does not auto-start proof work.

The reviewer is read-only; the `lean-specify` authoring seat keeps `review.md` unchanged and writes
separate `triage.md` with finding IDs, old/new hashes (pre-edit/post-edit), and rerun structure,
style, and optional build gates. PASS is terminal. APPROVE-WITH-EDITS becomes `approved after edits`
after accepted bounded edits pass those gates, with no second review. REVISE and BLOCKED
require a fresh revision or evidence packet and another review with prior review/triage history.
Run at most three reviewer rounds per invocation; stop at the cap with an exact resume command.
</process>
