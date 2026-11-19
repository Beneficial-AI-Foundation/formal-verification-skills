---
name: auto-init
description: Single entry for the auto track: show every stage's readiness, then reuse or record the agreement
argument-hint: ""
allowed-tools:
  - Read
  - Write
  - Bash
  - AskUserQuestion
  - Skill
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
- This skill is invoked by mentioning `$fvs:auto-init`.
- Treat all user text after `$fvs:auto-init` as `{{FVS_ARGS}}`.
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

**Delegation authorization:** Invoking this skill is the user's explicit request for the sub-agent delegation this workflow specifies. Each `Task(...)` dispatch in the workflow body, including every pass of a loop, is a skill instruction to spawn a sub-agent with `spawn_agent` when the workflow reaches that step; do not wait for the user to ask for sub-agents again, and do not perform a delegated role inline in this session. If `spawn_agent` is not visible, discover it with `tool_search` first. If sub-agents remain unavailable or disabled, stop before that dispatch, tell the user why, and offer only the workflow's documented alternatives (such as a documented `--codex` runner).

**Schema detection (required first step):** Inspect the visible `spawn_agent` schema. It may have `agent_type` or be generic (no `agent_type`); inspect `model` and `reasoning_effort` fields independently rather than assuming either exists. An available `agent_type` field does not establish that a particular FVS role is registered.

Before spawning, inspect the `spawn_agent` tool's visible parameter schema to determine which form is active.
**Requested specialist gate (at dispatch only):** When a workflow requests a named FVS specialist, check BOTH the visible `spawn_agent` schema and whether the exact requested `agent_type` is advertised there or in a confirmed runtime registry. An `agent_type` field alone is not evidence that this role is registered; bundled `agents/*.md` are instructions, not registered Codex specialists. If the exact role is registered and `agent_type` is available, use typed mapping below WITHOUT a missing-role warning. Otherwise, even if `agent_type` is present, warn the user in plain language: Requested FVS specialist <agent-name> is not registered in this Codex session; the bundled Markdown cannot supply typed identity. Do not warn merely for opening help, installing, or mentioning a skill without requesting specialist dispatch. Apply the settings gate below before considering the generic-agent workaround. Never run an installer on the user's behalf.


Selection-capability gate (before manifest confirmation, child dispatch, or artifact writes):
- Check required specialist identity and sandbox against the exact registered role and effective child settings. A generic role preamble cannot meet a mandatory typed identity or sandbox requirement; stop and explain the unavailable guarantee before dispatch or artifact writes.
- On Codex a registered role does not set the child's sandbox: Codex applies a role's model, effort and instructions, never its `sandbox_mode`, so the child runs in the parent session's sandbox. Report that sandbox as the child's, never the role file's value, and never call a child read-only when the parent session can write.
- If `model` is exposed for this child, pass the requested model. Otherwise compare it with the exact active/inherited Codex model; a different or unconfirmed model is unresolved. Rebuild the manifest around confirmed settings and ask explicitly, choose a capable external runner, or fail before dispatch in noninteractive mode.
- If `reasoning_effort` is exposed for this child, pass the requested effort. Otherwise compare it with the confirmed effective installed/runtime default; a different or unconfirmed effort is unresolved and follows the same rebuild/ask-or-fail rule.
- Model and effort are separate values: pass an exact catalog model id and an effort that model lists. A registered role that pins `model` or `reasoning_effort` (its role description says the setting is locked, or its TOML sets it) overrides the per-call value, so the pinned value is the effective one; if it differs from the confirmed selection it is unresolved.
- Never confirm a requested specialist setting and then omit it with a warning. The marketplace plugin does not install Codex agent TOML; use typed mapping only for an independently registered exact role.

Typed mapping (only when the exact requested FVS role is registered AND agent_type is exposed):
- `Task(subagent_type="X", prompt="Y")` -> `spawn_agent(agent_type="X", message="Y")`
- `Task(model="...")` -> pass `model` if available for this child; otherwise omit only after the selection-capability gate proves it equals the active/inherited model.
- `Task(reasoning_effort="...")` -> pass `reasoning_effort` if available for this child and the role does not pin it; otherwise omit only after the gate proves the effective (pinned or default) effort equals the confirmed effort.

Generic-agent workaround (missing exact registered role OR no agent_type field):
If the requested FVS type (`fvs-researcher`, `fvs-executor`, etc.) is not registered, typed dispatch is NOT possible even with an `agent_type` field. If the field is absent, typed dispatch is also unavailable. Fallback:
1. Read `${CLAUDE_PLUGIN_ROOT}/agents/<agent-name>.md` and extract its instructions. If the token is still literal, resolve the path from this SKILL.md as described above.
2. Only when the settings gate permits generic execution, spawn a generic/default child with those instructions as a role preamble before the task prompt. Do not pass an unregistered `agent_type`.
3. Label output "generic-agent workaround". This is NOT equivalent to a registered specialist: the preamble does not assure typed identity, sandbox, model, or reasoning effort.
4. If required guarantees cannot be honored, stop before dispatch or artifact writes; explain which guarantee is missing. Typed FVS roles currently require the direct Codex installation, a separate complete FVS install: point the user to "Codex specialist roles" in the FVS README and never suggest keeping both channels. Even after switching, confirm exact registration and settings in the runtime.

**Fresh context (typed and generic dispatch):** FVS children start without the parent conversation; put every input the child needs in its message (FVS workflow prompts already inline them). If the schema exposes `fork_turns`, pass `fork_turns: "none"` (omitting it or passing `"all"` forks the full history, which also refuses `model` and `reasoning_effort` overrides); if it exposes only `fork_context`, pass `fork_context: false`. If neither is exposed, fresh context is unconfirmed: say so before dispatch, and stop where the workflow requires a fresh child.

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
Start or resume the auto track through the AO orchestrator, the single entry. Show the compatibility
profile with every stage's readiness up front, then reuse a current applicable agreement without
Keep/Change or repeated interviewing. Use a short `/fvs:roadmap` light/deep/reuse conversation only
for what is missing: the source revision, the agreed scope (crates, modules and features), boundaries,
conventions, single-crate/monorepo layout, execution choices and the repository the draft pull
requests go to. A helper drafts the agreement and the owner only confirms it.

Persist choices and the exact declared agreement through `scripts/fvs-auto.mjs`. A missing or outdated
agreement is a warning, never a stop, and the owner records it in their own terminal. A roadmap-offer
decision alone is not agreement or authorization. Material changes need explicit confirmation; routine
progress does not reopen setup. The stored-context gate, the memory routes and the strict graph lane
are an optional section of the workflow that this entry never calls.

Output: recorded setup and agreement, and the next stage or the exact refusal. Agreement storage alone
launches no workers or proofs. The pipeline after it is fixed and the agents choose how: extract, a
draft spec pull request the owner merges, proofs, FVS's build check in a fresh clean copy, a draft proof
pull request. Later provisional cycles stay autonomous within the agreement and final PR acceptance
stays human.

Before the hand-off, init checks which steps of the run stop for an approval prompt, by running one
low-risk instance of each while the owner is present (low-risk is not inert: Lake evaluates the project's
lakefile and git can run configured hooks), and asks the owner which prompted. Only after the owner's yes
does it write a minimal project allowlist for those steps through `scripts/fvs-auto-permissions.mjs`. It also
records, after a separate yes, where pushes go. Workers push with one FVS command, `scripts/fvs-auto-push.mjs`,
which pushes one branch under the run's namespace to that recorded destination and refuses anything else; the one
push rule names that command (`auto-permissions.md` says what it does not stop). It never writes a rule that
allows GitHub comments, reviews, merges or a `git push`, and it stops while a project settings file already has a
`git push` allow rule. The owner can ask it to recheck permissions later, which repeats the probes of the steps
that last prompted.
</objective>

<execution_context>
@${CLAUDE_PLUGIN_ROOT}/fv-skills/workflows/auto-init.md
@${CLAUDE_PLUGIN_ROOT}/fv-skills/references/auto-setup.md
@${CLAUDE_PLUGIN_ROOT}/fv-skills/references/auto-permissions.md
@${CLAUDE_PLUGIN_ROOT}/fv-skills/references/auto-memory.md
@${CLAUDE_PLUGIN_ROOT}/fv-skills/references/ui-brand.md
</execution_context>

<context>
Run from the project root (the Lean project that holds `lakefile.toml` and `lean-toolchain`).
State lives under `.formalising/auto-fv/`; `auto-setup.md` explains how to keep `.formalising/`
out of git. Fresh rc2 setup requires the declared Aeneas/Charon executables locally even for an
externally prepared, validated extraction. A retained witness does not bypass `profile-blocked`;
see the prerequisite and exact-source installation steps in `auto-setup.md`.
</context>

<process>

Follow the auto-init workflow end to end. Every state change goes through `fvs-auto.mjs`; never
write or edit `state.json` by hand, and never pass `--confirm-overwrite` without the owner's
explicit confirmation of the listed changes.

The permission check is the one place init writes a settings or rules file, and only through
`fvs-auto-permissions.mjs write-allowlist` after the owner has seen the exact rules and said yes. Run it
once: a project with a permission record is not checked again.

Agents may open draft pull requests and edit a pull request body. They never post comments or reviews
on GitHub, never mark a pull request ready and never merge: only the owner comments, marks ready and
merges.

Finish with the workflow's report block, which always carries the `State:`, `Next action:` and
`Pending decision:` lines.
</process>

<codex_skill_adapter>
On Codex, every owner question in this command (the choices, a confirmation of changed choices,
the initial roadmap agreement, the permission check's answers and the allowlist confirmation) degrades
to a plain-text question and WAITS for the answer. It is fail-closed:
it never picks a default for the owner, never runs `init-state` before the owner has answered,
and never passes `--confirm-overwrite`, or `--confirm` for an allowlist, or records owner agreement/authority on the owner's behalf.
Applicable existing explicit responses are reused without another question; computing a hash is not approval.
</codex_skill_adapter>

<success_criteria>
- [ ] Stops with an actionable message when `ao` is not on PATH.
- [ ] Malformed state stops with the script's message and next step; it is never overwritten.
- [ ] The profile is shown with its stage lines before any question; a `profile-blocked` result stops with every blocking item's next step.
- [ ] Owner choices are recorded only through `init-state`; an unchanged rerun writes nothing.
- [ ] A changed choice is shown to the owner and written only after explicit confirmation.
- [ ] A current applicable agreement bypasses Keep/Change and repeated interviews; actual evidence is read.
- [ ] A missing or outdated agreement is reported as a warning and does not stop the stages; legacy offer/extraction records keep their meaning.
- [ ] Actual retained payload and current roadmap fence bind approval; status-only logs do not re-grill.
- [ ] The agreement keeps its `nonpublic-intent` mode and records the public API scope in its boundaries and claims.
- [ ] The relaxed path reads state plainly and never calls the stored-context gate, the memory routes, owned work, the driver or the re-specification command.
- [ ] No implicit grant or per-round human approval is introduced.
- [ ] Agreement storage alone launches no workers; a recorded draft pull request destination is the project's own repository.
- [ ] The permission check runs once, after telling the owner that some steps may prompt, and asks the owner which prompted; it never infers a prompt.
- [ ] A rules or settings file is written only after the owner's explicit yes on the exact preview, keeps every other key, and never writes a rule that allows a GitHub comment, review or merge, or a `git push`; the one push rule names the FVS push command, which pushes one branch under the namespace to the recorded destination and refuses anything else, and the destination is recorded after a separate yes. A write stops while a `git push` allow rule is in a project settings file, and a confirmation is bound to the project root, the real file path and the file's content.
- [ ] A Codex write never replaces or merges an existing rules file, and its recheck waits for a new session.
- [ ] The report carries the State, Next action, Permissions and Pending decision lines.
</success_criteria>
