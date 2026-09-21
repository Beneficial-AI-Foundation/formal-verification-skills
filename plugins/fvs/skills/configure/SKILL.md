---
name: configure
description: Configure runtime-aware FVS stage models, effort levels, and review defaults
argument-hint: ""
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
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
- This skill is invoked by mentioning `$fvs:configure`.
- Treat all user text after `$fvs:configure` as `{{FVS_ARGS}}`.
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
Edit `.formalising/fvs-config.json` through bounded choice menus. Store exact runtime model IDs only
when the runtime reports them, keep quality role-aware by stage, configure the project
`native_decide` policy, preserve one-run user control, and preserve unrelated project configuration.
</objective>

<execution_context>
@${CLAUDE_PLUGIN_ROOT}/fv-skills/references/model-profiles.md
@${CLAUDE_PLUGIN_ROOT}/fv-skills/templates/config.json
</execution_context>

<process>

## 1. Load without clobbering

Read `.formalising/fvs-config.json` when it exists; otherwise start from the shipped template. Reject
malformed JSON and stop before writing. Preserve unknown keys and every unrelated nested value.
Never replace the whole file with a partial settings object.

Add missing current-schema containers without deleting old settings: `stage_overrides`,
`model_overrides`, `effort_overrides`, `spec_review`, and `crypto_review`. A missing top-level
`native_decide` value defaults to `ask`; reject values outside `avoid | ask | allow`.

## 2. Detect runtime, provider, and catalog

Prefer explicit host identity over directory guesses:

1. `PI_CODING_AGENT=true` or `AI_AGENT=pi` means Pi.
2. A host adapter or `AI_AGENT` value naming Claude, Codex, OpenCode, or Gemini wins next.
3. If identity is still unknown, ask which runtime is being configured.

Read the runtime's current model catalog or picker. On Pi, `pi --list-models` is the CLI fallback.
Keep Pi IDs provider-qualified and identify its active provider. Never invent or persist a guessed
slug. Read the canonical quality stage and runtime matrices from `model-profiles.md`; do not copy or
weaken them here.

For ordinary Pi stages, stay within the active provider. Review routing is configured separately and
may use an authenticated opposite-runtime CLI. Never treat a Claude Code subscription as a Pi
Anthropic credential.

## 3. Main settings menu

Use `AskUserQuestion` and repeat until the user saves or cancels. Retain the question UI's notes or
custom-answer path. Present at most these four choices:

- **Profile** — choose `quality`, `balanced`, or `budget`.
- **Stage overrides** — configure one exact canonical stage for the active runtime.
- **Advanced defaults** — open agent-compatibility or review-default settings.
- **Save/exit** — preview, save, discard, or continue.

If structured questions are unavailable, print the same numbered choices plus a notes/custom line,
then stop and wait. Never select on the user's behalf.

## 4. Configure a stage override

Read stage keys and tiers from the sole canonical table in `model-profiles.md`. First choose a tier,
then a stage in that tier. Do not infer a stage from an agent name.

Show the quality recommendation for the detected runtime/provider as an exact catalog match. The
model menu offers:

1. the exact detected quality model when available;
2. `inherit`;
3. up to one other detected runtime/provider model;
4. catalog/custom selection.

If the preferred model is absent, show the detected catalog and require a choice; do not silently
choose a lower family. Custom input must exactly match a catalog entry. On Pi it must include the
provider. For ordinary Pi stages, reject entries whose catalog provider differs from the active
provider; review stages use their separate opposite-provider policy.

For effort, offer every value the selected catalog model reports as supported, with the stage
tier's quality effort first. Never advertise a value the model cannot accept. Save either or both fields under:

```
stage_overrides[runtime][stage] = { model?, effort? }
```

Removing both fields removes the stage entry. A saved stage override affects only that runtime and
stage.

## 5. Configure advanced defaults

Use a submenu with at most four choices: **Agent compatibility**, **Review defaults**,
**Proof policy**, **Back**.

### Agent compatibility

Existing broad overrides remain available for projects that need one setting across several
stages. Choose one shipped agent and store exact values under
`model_overrides[runtime][agent]` / `effort_overrides[runtime][agent]`. Explain that a stage override
wins and is preferred when a shared agent performs different roles.

Shipped groups:

- FC: `fvs-researcher`, `fvs-executor`, `fvs-lean-refactorer`, `fvs-explainer`.
- Crypto: `fvs-crypto-thinker`, `fvs-crypto-executor`.
- Extraction: `fvs-extract-classifier`, `fvs-extract-applier`, `fvs-extract-bisector`,
  `fvs-equivalence-assessor`, `fvs-draft-investigator`, `fvs-doc-syncer`.
- Audit: `fvs-axiom-auditor`.

### Proof policy

Choose the project-scoped top-level `native_decide` value:

- `avoid` — fail before use;
- `ask` — require explicit approval when a run proposes use;
- `allow` — permit use while recording it in manifests and trust evidence.

Default to `ask`. Explain that a command may confirm a one-run override, but a one-run choice never
persists; only this configuration menu changes the stored policy.

### Review defaults

Choose `spec_review`, `crypto_review`, or both. Null reviewer/model/effort values keep role-aware
profile routing and the per-command confirmation active. For each explicit saved review setting:

1. choose reviewer runtime `codex`, `claude`, `pi`, or `other` (`pi` only when the active host is Pi and the selected provider is authenticated);
2. choose an exact model from that reviewer's catalog;
3. choose a supported effort;
4. keep `automatic` unchanged unless explicitly edited.

Quality recommends the authenticated opposite provider/runtime and its authority-tier model+effort.
On Pi, OpenAI review of Claude-authored work prefers a fresh provider-qualified Pi seat only when
the child facility can honor and report the exact per-child model/effort, then Codex CLI. Review of
OpenAI-authored work uses authenticated Claude Code CLI when available. If the opposite runner is
unavailable, do not silently save a same-runtime fallback.

## 6. Preview and save

Show all changed keys and a selection preview. Ask for confirmation with `Save`, `Continue editing`,
`Discard`, and `Cancel`. Notes rebuild the preview and require another confirmation.

Create `.formalising/` if needed, serialize with two-space indentation and a trailing newline,
validate the complete JSON in a temporary file, then atomically replace
`.formalising/fvs-config.json`. On validation or write failure, leave the old file untouched.

Report runtime/provider, profile, stored `native_decide` policy, changed stage/agent/review
settings, and precedence:

1. explicit one-run selection;
2. saved review value for review stages;
3. runtime+stage override;
4. runtime+agent compatibility override;
5. profile/catalog resolution.

Also report that missing preferred models, ordinary-Pi provider mismatches, unsupported efforts,
and unavailable per-child controls prompt interactively, while noninteractive unresolved choices
fail before dispatch with exact remediation.

</process>

<success_criteria>
- [ ] Runtime/provider identified explicitly; every concrete model came from its current catalog.
- [ ] Ordinary Pi stage overrides use the active provider; review overrides follow review routing.
- [ ] Quality recommendations use the canonical authority/work/scout matrices.
- [ ] Stage overrides are stored under the exact runtime+stage key and win over agent overrides.
- [ ] Choice menus expose notes and reconfirm after notes change the preview.
- [ ] Review defaults may remain null so opposite-runtime profile routing stays active.
- [ ] `native_decide` is one of `avoid | ask | allow`, defaults to `ask`, and one-run overrides never persist.
- [ ] Unknown config keys were preserved and malformed JSON was never overwritten.
</success_criteria>
