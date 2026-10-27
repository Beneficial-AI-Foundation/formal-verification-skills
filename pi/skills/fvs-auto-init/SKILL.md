---
name: fvs-auto-init
description: Record the auto track's setup state after the compatibility profile and the owner's choices
---

<pi_package_runtime>
- This skill lives under `pi/skills/<name>/SKILL.md`; the FVS package root is `../../..` relative to its directory.
- Resolve every bundled relative path against the skill directory and pass absolute paths to tool calls and shell commands.
- Agent role instructions live under `../../../agents/`. When a workflow requests Task/subagent dispatch, use an available Pi subagent facility with the matching role instructions. If none is installed, perform the role inline and state that fresh-context separation was unavailable. Exception: a review workflow that requires a fresh reviewer must remain pending or offer its documented fallback; never perform that review inline.
- Use Pi's structured question tool when available; otherwise ask the same question in plain text.
- Never write state into the managed package. Project state belongs under the user's current project (normally `.formalising/`).
</pi_package_runtime>

<objective>
Start, or rerun, the FVS auto track in the current project. Run the compatibility profile, ask the
owner for the source revision and configuration, the bounded initial scope and the execution and
resource limits, and record them in `.formalising/auto-fv/state.json` through
`scripts/fvs-auto.mjs init-state`. Then offer, once, to write the project roadmap with
`/fvs:roadmap`; the offer is optional and never a prerequisite for extraction.

Rerunning is safe: an unchanged rerun reports the recorded state and writes nothing, and a recorded
owner choice changes only after the owner confirms that change. An unsupported combination stops
with the profile's next step. The auto track requires the Agent Orchestrator `ao` CLI on the host.

Output: the recorded setup state, or the profile's next steps when the host is not ready. Nothing
here extracts, specifies or proves anything.
</objective>

<execution_context>
@../../../fv-skills/workflows/auto-init.md
@../../../fv-skills/references/auto-setup.md
@../../../fv-skills/references/ui-brand.md
</execution_context>

<context>
Run from the project root (the Lean project that holds `lakefile.toml` and `lean-toolchain`).
State lives under `.formalising/auto-fv/`; `auto-setup.md` explains how to keep `.formalising/`
out of git.
</context>

<process>
Follow the auto-init workflow end to end. Every state change goes through `fvs-auto.mjs`; never
write or edit `state.json` by hand, and never pass `--confirm-overwrite` without the owner's
explicit confirmation of the listed changes.

Finish with the workflow's report block, which always carries the `State:`, `Next action:` and
`Pending decision:` lines.
</process>

<codex_skill_adapter>
On Codex, every owner question in this command (the choices, a confirmation of changed choices and
the roadmap offer) degrades to a plain-text question and WAITS for the answer. It is fail-closed:
it never picks a default for the owner, never runs `init-state` before the owner has answered,
and never passes `--confirm-overwrite` or records a roadmap decision on the owner's behalf.
</codex_skill_adapter>

<success_criteria>
- [ ] Stops with an actionable message when `ao` is not on PATH.
- [ ] Malformed state stops with the script's message and next step; it is never overwritten.
- [ ] The profile is shown; a `profile-blocked` result stops with every blocking item's next step.
- [ ] Owner choices are recorded only through `init-state`; an unchanged rerun writes nothing.
- [ ] A changed choice is shown to the owner and written only after explicit confirmation.
- [ ] The roadmap offer is made only while no decision is recorded (or when the owner asks), and it never blocks extraction.
- [ ] The report carries the State, Next action and Pending decision lines.
</success_criteria>
